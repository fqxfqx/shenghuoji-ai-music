const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 3000);

fs.mkdirSync(DATA_DIR, { recursive: true });

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SONGS_FILE = path.join(DATA_DIR, 'songs.json');
const POSTS_FILE = path.join(DATA_DIR, 'posts.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const VERIFY_CODES_FILE = path.join(DATA_DIR, 'verify-codes.json');
for (const file of [USERS_FILE, SONGS_FILE, POSTS_FILE, SESSIONS_FILE, VERIFY_CODES_FILE]) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, '[]', 'utf8');
}

loadDotEnv(path.join(ROOT, '.env'));
const SESSION_AGE_MS = 30 * 24 * 3600 * 1000;
const sessions = new Map(readJson(SESSIONS_FILE)
  .filter(session => session.token && session.userId && (!session.expiresAt || new Date(session.expiresAt).getTime() > Date.now()))
  .map(session => [session.token, session]));
const tasks = new Map();
let pgPool = null;
let dbReady = false;
let dbInitPromise = null;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
    });
  } catch (error) {
    console.warn('PostgreSQL driver unavailable; falling back to JSON storage.');
  }
}

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (!process.env[key.trim()]) process.env[key.trim()] = rest.join('=').trim().replace(/^"|"$/g, '');
  }
}

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw.trim() ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

async function initDb() {
  if (!pgPool) return false;
  if (dbReady) return true;
  if (dbInitPromise) return dbInitPromise;
  dbInitPromise = (async () => {
    await pgPool.query(`
      create table if not exists users (
        id text primary key,
        email text unique not null,
        name text not null,
        salt text not null,
        password_hash text not null,
        credits integer not null default 0,
        email_verified boolean not null default false,
        created_at timestamptz not null default now(),
        updated_at timestamptz
      );
      create table if not exists sessions (
        token text primary key,
        user_id text not null references users(id) on delete cascade,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null
      );
      create table if not exists verify_codes (
        id bigserial primary key,
        email text not null,
        purpose text not null,
        code_hash text not null,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null
      );
      create table if not exists songs (
        id text primary key,
        user_id text not null references users(id) on delete cascade,
        task_id text,
        title text not null,
        provider text not null,
        audio_urls jsonb not null default '[]'::jsonb,
        payload jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      );
    `);
    await migrateJsonToDb();
    dbReady = true;
    return true;
  })().catch(error => {
    console.warn('PostgreSQL init failed; falling back to JSON storage.', error.message);
    pgPool = null;
    dbReady = false;
    return false;
  });
  return dbInitPromise;
}

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    salt: row.salt,
    passwordHash: row.password_hash,
    credits: row.credits,
    emailVerified: row.email_verified,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

function rowToSong(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    taskId: row.task_id,
    title: row.title,
    provider: row.provider,
    audioUrls: row.audio_urls || [],
    payload: row.payload || {},
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null
  };
}

async function migrateJsonToDb() {
  if (!pgPool) return;
  const userCount = await pgPool.query('select count(*)::int as count from users');
  if (Number(userCount.rows[0]?.count || 0) === 0) {
    const users = readJson(USERS_FILE);
    for (const user of users) {
      if (!user.id || !user.email || !user.passwordHash || !user.salt) continue;
      await pgPool.query(
        `insert into users (id, email, name, salt, password_hash, credits, email_verified, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()), $9::timestamptz)
         on conflict (id) do nothing`,
        [
          user.id,
          user.email,
          user.name || user.email.split('@')[0],
          user.salt,
          user.passwordHash,
          Number(user.credits || 0),
          !!user.emailVerified,
          user.createdAt || null,
          user.updatedAt || null
        ]
      );
    }
  }

  const songCount = await pgPool.query('select count(*)::int as count from songs');
  if (Number(songCount.rows[0]?.count || 0) === 0) {
    const songs = readJson(SONGS_FILE);
    for (const song of songs) {
      if (!song.id || !song.userId) continue;
      await pgPool.query(
        `insert into songs (id, user_id, task_id, title, provider, audio_urls, payload, created_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, coalesce($8::timestamptz, now()))
         on conflict (id) do nothing`,
        [
          song.id,
          song.userId,
          song.taskId || null,
          song.title || 'AI Song',
          song.provider || 'unknown',
          JSON.stringify(song.audioUrls || []),
          JSON.stringify(song.payload || {}),
          song.createdAt || null
        ]
      ).catch(() => null);
    }
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

function readRawBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!boundaryMatch) throw new Error('Missing multipart boundary.');
  const boundary = `--${boundaryMatch[1] || boundaryMatch[2]}`;
  const fields = {};
  const files = {};
  const parts = buffer.toString('binary').split(boundary);
  for (let part of parts) {
    if (!part || part === '--\r\n' || part === '--') continue;
    if (part.startsWith('\r\n')) part = part.slice(2);
    if (part.endsWith('\r\n')) part = part.slice(0, -2);
    if (part.endsWith('--')) part = part.slice(0, -2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headerText = part.slice(0, headerEnd);
    const bodyText = part.slice(headerEnd + 4);
    const disposition = /content-disposition:\s*form-data;([^\r\n]+)/i.exec(headerText)?.[1] || '';
    const name = /name="([^"]+)"/i.exec(disposition)?.[1];
    if (!name) continue;
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1];
    const contentTypeHeader = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim() || 'application/octet-stream';
    const data = Buffer.from(bodyText, 'binary');
    if (filename) {
      files[name] = { filename, contentType: contentTypeHeader, data, size: data.length };
    } else {
      fields[name] = data.toString('utf8');
    }
  }
  return { fields, files };
}

async function readApiPayload(req) {
  const contentType = req.headers['content-type'] || '';
  if (/multipart\/form-data/i.test(contentType)) {
    const raw = await readRawBody(req);
    const parsed = parseMultipart(raw, contentType);
    const payloadText = parsed.fields.payload || parsed.fields.config || '{}';
    let body;
    try {
      body = JSON.parse(payloadText);
    } catch {
      throw new Error('Invalid payload JSON.');
    }
    return { body, sampleFile: parsed.files.sample || null };
  }
  return { body: await readBody(req), sampleFile: null };
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (!key) continue;
    out[key] = decodeURIComponent(rest.join('='));
  }
  return out;
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `shenghuoji_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'shenghuoji_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    credits: user.credits || 0,
    emailVerified: !!user.emailVerified,
    createdAt: user.createdAt || null
  };
}

function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(`${salt}:${password}`).digest('base64');
}

async function findUserByEmail(email) {
  if (await initDb()) {
    const result = await pgPool.query('select * from users where email = $1 limit 1', [email]);
    return rowToUser(result.rows[0]);
  }
  return readJson(USERS_FILE).find(user => user.email === email) || null;
}

async function findUserById(id) {
  if (await initDb()) {
    const result = await pgPool.query('select * from users where id = $1 limit 1', [id]);
    return rowToUser(result.rows[0]);
  }
  return readJson(USERS_FILE).find(user => user.id === id) || null;
}

async function createUser(user) {
  if (await initDb()) {
    await pgPool.query(
      `insert into users (id, email, name, salt, password_hash, credits, email_verified, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)`,
      [user.id, user.email, user.name, user.salt, user.passwordHash, user.credits || 0, !!user.emailVerified, user.createdAt]
    );
    return user;
  }
  const users = readJson(USERS_FILE);
  users.push(user);
  writeJson(USERS_FILE, users);
  return user;
}

async function updateUserPassword(userId, salt, passwordHash) {
  const updatedAt = new Date().toISOString();
  if (await initDb()) {
    await pgPool.query(
      'update users set salt = $1, password_hash = $2, updated_at = $3::timestamptz where id = $4',
      [salt, passwordHash, updatedAt, userId]
    );
    return;
  }
  const users = readJson(USERS_FILE);
  const user = users.find(item => item.id === userId);
  if (!user) return;
  user.salt = salt;
  user.passwordHash = passwordHash;
  user.updatedAt = updatedAt;
  writeJson(USERS_FILE, users);
}

async function currentUser(req) {
  const token = parseCookies(req).shenghuoji_session;
  if (!token) return null;
  if (await initDb()) {
    const result = await pgPool.query(
      `select u.* from sessions s
       join users u on u.id = s.user_id
       where s.token = $1 and s.expires_at > now()
       limit 1`,
      [token]
    );
    return rowToUser(result.rows[0]);
  }
  if (!sessions.has(token)) return null;
  const session = sessions.get(token);
  if (session.expiresAt && new Date(session.expiresAt).getTime() <= Date.now()) {
    sessions.delete(token);
    saveSessions();
    return null;
  }
  return findUserById(session.userId);
}

function saveSessions() {
  writeJson(SESSIONS_FILE, [...sessions.values()]);
}

async function createSession(res, userId) {
  const token = crypto.randomBytes(24).toString('hex');
  const session = {
    token,
    userId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_AGE_MS).toISOString()
  };
  if (await initDb()) {
    await pgPool.query(
      `insert into sessions (token, user_id, created_at, expires_at)
       values ($1, $2, $3::timestamptz, $4::timestamptz)`,
      [session.token, session.userId, session.createdAt, session.expiresAt]
    );
  } else {
    sessions.set(token, session);
  }
  saveSessions();
  setSessionCookie(res, token);
}

async function deleteSession(token) {
  if (!token) return;
  if (await initDb()) {
    await pgPool.query('delete from sessions where token = $1', [token]);
  }
  sessions.delete(token);
  saveSessions();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function assertEmail(email) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('请输入有效邮箱。');
}

async function readCodes() {
  const now = Date.now();
  if (await initDb()) {
    await pgPool.query('delete from verify_codes where expires_at <= now()');
    const result = await pgPool.query('select * from verify_codes');
    return result.rows.map(row => ({
      id: row.id,
      email: row.email,
      purpose: row.purpose,
      codeHash: row.code_hash,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null
    }));
  }
  const codes = readJson(VERIFY_CODES_FILE).filter(item => item.expiresAt && new Date(item.expiresAt).getTime() > now);
  writeJson(VERIFY_CODES_FILE, codes);
  return codes;
}

async function createVerifyCode(email, purpose) {
  const code = String(crypto.randomInt(100000, 999999));
  const item = {
    email,
    purpose,
    codeHash: hashPassword(code, 'verify-code'),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
  };
  if (await initDb()) {
    await pgPool.query('delete from verify_codes where email = $1 and purpose = $2', [email, purpose]);
    await pgPool.query(
      `insert into verify_codes (email, purpose, code_hash, created_at, expires_at)
       values ($1, $2, $3, $4::timestamptz, $5::timestamptz)`,
      [item.email, item.purpose, item.codeHash, item.createdAt, item.expiresAt]
    );
    return code;
  }
  const codes = (await readCodes()).filter(existing => !(existing.email === email && existing.purpose === purpose));
  codes.push(item);
  writeJson(VERIFY_CODES_FILE, codes);
  return code;
}

async function consumeVerifyCode(email, purpose, code) {
  const cleanCode = String(code || '').trim();
  if (await initDb()) {
    const result = await pgPool.query(
      `delete from verify_codes
       where id in (
         select id from verify_codes
         where email = $1 and purpose = $2 and code_hash = $3 and expires_at > now()
         order by created_at desc
         limit 1
       )
       returning id`,
      [email, purpose, hashPassword(cleanCode, 'verify-code')]
    );
    if (!result.rowCount) throw new Error('Invalid or expired verification code.');
    return;
  }
  const codes = await readCodes();
  const index = codes.findIndex(item =>
    item.email === email
    && item.purpose === purpose
    && item.codeHash === hashPassword(cleanCode, 'verify-code'));
  if (index < 0) throw new Error('验证码不正确或已过期。');
  codes.splice(index, 1);
  writeJson(VERIFY_CODES_FILE, codes);
}

async function requireUser(req) {
  const user = await currentUser(req);
  if (!user) {
    const error = new Error('Please login first.');
    error.status = 401;
    throw error;
  }
  return user;
}

function musicProvider() {
  if (process.env.MINIMAX_API_KEY) return 'minimax';
  if (process.env.MUREKA_API_KEY) return 'mureka';
  return 'demo';
}

function cleanSecret(value) {
  let secret = String(value || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/^MUREKA_API_KEY\s*=\s*/i, '')
    .replace(/^Authorization\s*:\s*/i, '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  const bearerMatch = secret.match(/Bearer\s+([A-Za-z0-9._~+/=-]+)/i);
  if (bearerMatch) secret = bearerMatch[1];
  return secret.replace(/^["']|["']$/g, '').trim();
}

function murekaAuthHeader() {
  const key = cleanSecret(process.env.MUREKA_API_KEY);
  if (!key) throw new Error('MUREKA_API_KEY is missing.');
  return `Bearer ${key}`;
}

function findAudioUrls(value) {
  const candidates = [];
  collectAudioUrlCandidates(value, candidates);
  return candidates
    .sort((a, b) => b.score - a.score)
    .filter(candidate => candidate.score > 0)
    .map(candidate => candidate.url)
    .filter((url, index, all) => all.indexOf(url) === index);
}

function collectAudioUrlCandidates(value, candidates, keyPath = '') {
  if (!value) return;
  if (typeof value === 'string') {
    const looksLikeAudioUrl = /^https?:\/\/.*\.(mp3|wav|m4a|aac|ogg|flac)(\?.*)?$/i.test(value);
    const keyLooksAudio = /(audio|song|music|track|vocal|mp3|wav|m4a|aac|flac)/i.test(keyPath);
    const keyLooksImage = /(cover|image|artwork|poster|thumbnail|avatar)/i.test(keyPath);
    const valueLooksImage = /\.(png|jpe?g|webp|gif)(\?.*)?$/i.test(value);
    if ((looksLikeAudioUrl || (keyLooksAudio && /^https?:\/\//i.test(value))) && !keyLooksImage && !valueLooksImage) {
      const negative = /(instrumental|accompaniment|backing|stem|drum|bass|other|separate|伴奏|分轨)/i.test(`${keyPath} ${value}`);
      let score = looksLikeAudioUrl ? 20 : 8;
      if (/(song|full|complete|mix|master|audio|url|歌曲|成品|完整)/i.test(keyPath)) score += 16;
      if (/(vocal|voice|sing|人声|演唱)/i.test(keyPath)) score += 8;
      if (negative) score -= 50;
      candidates.push({ url: value, score });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAudioUrlCandidates(item, candidates, keyPath);
    return;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) collectAudioUrlCandidates(item, candidates, keyPath ? `${keyPath}.${key}` : key);
  }
}

function pickProviderTaskId(raw, fallback) {
  return raw?.id
    || raw?.task_id
    || raw?.taskId
    || raw?.data?.id
    || raw?.data?.task_id
    || raw?.data?.taskId
    || raw?.result?.id
    || raw?.result?.task_id
    || raw?.result?.taskId
    || fallback;
}

function pickStatus(raw, fallback = 'processing') {
  return raw?.status
    || raw?.data?.status
    || raw?.result?.status
    || raw?.task?.status
    || fallback;
}

function normalizeLyrics(payload) {
  const prompt = String(payload.prompt || '写一首给普通人的中文歌曲').trim();
  const provided = String(payload.lyrics || '').trim();
  if (provided.length >= 24 && /\n/.test(provided)) {
    if (/^\s*\[(verse|chorus|pre-chorus|bridge|intro|outro)\]/im.test(provided)) return provided;
    const lines = provided.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const splitAt = Math.max(2, Math.ceil(lines.length / 2));
    return [
      '[Verse]',
      ...lines.slice(0, splitAt),
      '',
      '[Chorus]',
      ...lines.slice(splitAt)
    ].join('\n');
  }
  const baseLine = provided || prompt;
  return [
    '[Verse]',
    baseLine,
    '把心里的话慢慢唱出来',
    '每一句都像身边人的告白',
    '',
    '[Pre-Chorus]',
    '平凡日子也有自己的光',
    '走过的路都变成旋律回响',
    '',
    '[Chorus]',
    '我要把这首歌唱给你听',
    '用最真实的声音靠近你的心',
    '不管世界多吵多远多不停',
    '这一刻我们一起相信'
  ].join('\n');
}

function murekaVoicePrompt(voiceType) {
  if (/男女|对唱|duet/i.test(voiceType)) return 'male and female duet vocals, two distinct singers';
  if (/男|male/i.test(voiceType)) return /低沉|磁性/.test(voiceType) ? 'deep male lead vocal only, no female lead vocal' : 'male lead vocal only, no female lead vocal';
  if (/儿童|child/i.test(voiceType)) return 'childlike vocal';
  if (/多人|合唱|choir/i.test(voiceType)) return 'group choir vocals';
  return /温柔/.test(voiceType) ? 'soft female lead vocal only, no male lead vocal' : 'female lead vocal only, no male lead vocal';
}

function murekaStylePrompt(style) {
  const text = String(style || '');
  if (/节奏布鲁斯|R&B|r&b/i.test(text)) return 'Chinese R&B, soulful groove, smooth drums, warm bass';
  if (/说唱|rap|hip.?hop/i.test(text)) return 'Mandarin rap hip-hop, clear rhythmic vocal delivery';
  if (/电子|舞曲|EDM/i.test(text)) return 'electronic dance pop, modern synths, energetic beat';
  if (/未来|贝斯|future/i.test(text)) return 'future bass, wide synth chords, punchy electronic drums';
  if (/低保真|lo.?fi/i.test(text)) return 'lo-fi pop, relaxed beat, warm tape texture';
  if (/国风/i.test(text)) return 'Chinese traditional fusion pop, guzheng and modern pop rhythm';
  if (/摇滚|rock/i.test(text)) return 'indie rock, live drums, electric guitars, strong chorus';
  if (/金属|metal/i.test(text)) return 'metal rock, heavy guitars, powerful drums';
  if (/民谣|folk/i.test(text)) return 'Chinese folk ballad, acoustic guitar, intimate vocal';
  if (/爵士|jazz/i.test(text)) return 'jazz pop, soft piano, upright bass, brushed drums';
  if (/儿童/i.test(text)) return 'children song, bright melody, simple chorus';
  if (/古典/i.test(text)) return 'classical crossover pop, strings and piano';
  if (/流行|pop/i.test(text)) return 'Mandarin Chinese pop, memorable melody, radio-ready arrangement';
  return `${text}, Mandarin Chinese pop`;
}

function murekaMoodPrompt(mood) {
  const text = String(mood || '');
  if (/高级/.test(text)) return 'polished, elegant, premium mood';
  if (/热血/.test(text)) return 'passionate, energetic, anthemic mood';
  if (/松弛/.test(text)) return 'relaxed, easygoing mood';
  if (/神秘/.test(text)) return 'mysterious, cinematic mood';
  if (/温暖/.test(text)) return 'warm, sincere, emotional mood';
  if (/伤感/.test(text)) return 'sad, emotional, heartfelt mood';
  if (/甜蜜/.test(text)) return 'sweet, romantic mood';
  return 'bright, memorable mood';
}

function sampleControlPrompt(payload) {
  const styleInfluence = Math.max(10, Math.min(100, Number(payload.styleInfluence || 70)));
  if (styleInfluence >= 85) {
    return `Use the uploaded audio as a strong reference: keep a very similar tempo, energy curve, song section structure, groove, and overall vibe. Reference influence ${styleInfluence} percent. Do not copy the exact melody or imitate the original singer.`;
  }
  if (styleInfluence >= 55) {
    return `Use the uploaded audio as a medium reference: keep a similar vibe, tempo range, rhythm feel, and chorus energy. Reference influence ${styleInfluence} percent. Do not copy the exact melody or imitate the original singer.`;
  }
  return `Use the uploaded audio as a light inspiration only. Reference influence ${styleInfluence} percent. Do not copy the exact melody or imitate the original singer.`;
}

function buildMurekaPrompt(payload) {
  const style = String(payload.style || '中文流行').trim();
  const mood = String(payload.mood || '真诚温暖').trim();
  const usecase = String(payload.usecase || '生活写歌').trim();
  const voiceType = String(payload.voiceType || '自然中文人声').trim();
  const language = String(payload.language || '中文').trim();
  const styleInfluence = Number(payload.styleInfluence || 70);
  const userPrompt = String(payload.prompt || '为普通人的生活故事写一首中文歌曲').trim();
  const voicePrompt = murekaVoicePrompt(voiceType);
  const stylePrompt = murekaStylePrompt(style);
  const moodPrompt = murekaMoodPrompt(mood);
  const targetDuration = Math.max(30, Math.min(240, Number(payload.duration || 90)));
  const durationSource = payload.durationMode === 'sample'
    ? `match the uploaded reference audio length, about ${targetDuration} seconds`
    : `arrange the full song around the lyric length, about ${targetDuration} seconds`;
  if (payload.vocals === false) {
    return [
      `Primary genre and arrangement: ${stylePrompt}`,
      `Mood: ${moodPrompt}`,
      'instrumental music only, no vocals, no singing, no spoken voice',
      'full instrumental track with clear intro, verse-like development, hook section, and ending',
      durationSource,
      `style influence ${styleInfluence} percent`,
      `language: ${language}`,
      `use case: ${usecase}`,
      `user direction: ${userPrompt}`,
      'strictly follow the selected genre',
      'must be instrumental only'
    ].join(', ');
  }
  return [
    `Primary genre and arrangement: ${stylePrompt}`,
    `Mood: ${moodPrompt}`,
    `Vocal requirement: ${voicePrompt}`,
    'Mandarin Chinese pop song with clear lead sung vocals',
    'full song, verse and chorus, radio-ready mix',
    durationSource,
    `style influence ${styleInfluence} percent`,
    `language: ${language}`,
    `use case: ${usecase}`,
    `user direction: ${userPrompt}`,
    'strictly follow the selected genre and selected vocal gender',
    'must be vocal song, not instrumental, not soundtrack, not background music'
  ].join(', ');
}

async function saveGeneratedSong(task) {
  if (!task.audioUrls?.length || task.saved) return;
  const song = {
    id: crypto.randomUUID(),
    userId: task.userId,
    taskId: task.id,
    title: task.title,
    provider: task.provider,
    audioUrls: task.audioUrls,
    payload: task.payload,
    createdAt: new Date().toISOString()
  };
  if (await initDb()) {
    await pgPool.query(
      `insert into songs (id, user_id, task_id, title, provider, audio_urls, payload, created_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::timestamptz)
       on conflict (id) do nothing`,
      [
        song.id,
        song.userId,
        song.taskId,
        song.title,
        song.provider,
        JSON.stringify(song.audioUrls || []),
        JSON.stringify(song.payload || {}),
        song.createdAt
      ]
    );
    task.saved = true;
    return;
  }
  const songs = readJson(SONGS_FILE);
  songs.push(song);
  writeJson(SONGS_FILE, songs);
  task.saved = true;
}

async function listUserSongs(userId) {
  if (await initDb()) {
    const result = await pgPool.query(
      'select * from songs where user_id = $1 order by created_at desc',
      [userId]
    );
    return result.rows.map(rowToSong);
  }
  return readJson(SONGS_FILE)
    .filter(song => song.userId === userId)
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
}

async function callOpenRouter(payload) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is missing.');
  const model = process.env.OPENROUTER_TEXT_MODEL || 'openrouter/free';
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.PUBLIC_SITE_URL || 'https://example.com',
      'X-Title': 'Shenghuoji AI'
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      temperature: 0.8,
      messages: [
        {
          role: 'system',
          content: 'You are a Chinese songwriting assistant for ordinary people. Return only valid JSON with fields: title, prompt, lyrics, style, mood, voiceType, duration, shareText. Use warm plain Chinese. Do not imitate real singers or existing songs.'
        },
        {
          role: 'user',
          content: `Story: ${payload.story}\nTheme: ${payload.theme}\nTone: ${payload.tone}\nTurn this into a song prompt and lyric draft.`
        }
      ]
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'OpenRouter request failed');
  const content = data.choices?.[0]?.message?.content || '{}';
  return JSON.parse(content.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, ''));
}

async function callMiniMax(payload) {
  if (!process.env.MINIMAX_API_KEY) throw new Error('MINIMAX_API_KEY is missing.');
  const model = process.env.MINIMAX_MUSIC_MODEL || 'music-2.6';
  const lyrics = payload.lyrics || `[Verse]\n${payload.prompt}\n\n[Chorus]\n把生活唱成一首歌`;
  const response = await fetch('https://api.minimax.io/v1/music_generation', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.MINIMAX_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      prompt: `${payload.style}, ${payload.mood}, ${payload.usecase}, ${payload.voiceType} singing vocal. User direction: ${payload.prompt}`,
      lyrics,
      audio_setting: { sample_rate: 44100, bitrate: 256000, format: 'mp3' },
      output_format: 'url'
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || data.message || 'MiniMax request failed');
  return data;
}

async function callMureka(payload, options = {}) {
  const model = process.env.MUREKA_MODEL || 'auto';
  const lyrics = normalizeLyrics(payload);
  const body = {
    model,
    lyrics,
    prompt: murekaPrompt(payload),
    n: 1
  };
  if (options.referenceId) body.reference_id = options.referenceId;
  const response = await fetch('https://api.mureka.ai/v1/song/generate', {
    method: 'POST',
    headers: {
      Authorization: murekaAuthHeader(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(murekaError(data, 'Mureka request failed'));
  return data;
}

async function callMurekaInstrumental(payload) {
  const model = process.env.MUREKA_MODEL || 'auto';
  const response = await fetch('https://api.mureka.ai/v1/instrumental/generate', {
    method: 'POST',
    headers: {
      Authorization: murekaAuthHeader(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      prompt: murekaPrompt({ ...payload, vocals: false }),
      n: 1
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(murekaError(data, 'Mureka instrumental request failed'));
  data._generation_type = 'instrumental';
  return data;
}

function pickLyrics(raw) {
  return raw?.lyrics
    || raw?.data?.lyrics
    || raw?.result?.lyrics
    || raw?.text
    || raw?.data?.text
    || raw?.result?.text
    || raw?.choices?.[0]?.message?.content
    || '';
}

async function callMurekaLyrics(payload) {
  const response = await fetch('https://api.mureka.ai/v1/lyrics/generate', {
    method: 'POST',
    headers: {
      Authorization: murekaAuthHeader(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      prompt: `${String(payload.prompt || payload.story || '').trim()} Language: ${String(payload.language || '中文').trim()}.`,
      style: String(payload.style || '中文流行').trim(),
      mood: String(payload.mood || '真诚温暖').trim()
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(murekaError(data, 'Mureka lyrics request failed'));
  return {
    lyrics: pickLyrics(data),
    raw: data
  };
}

function murekaPrompt(payload) {
  return buildMurekaPrompt(payload).slice(0, 1024);
}

function pickMurekaFileId(raw) {
  return raw?.id
    || raw?.file_id
    || raw?.data?.id
    || raw?.data?.file_id
    || raw?.result?.id
    || raw?.result?.file_id;
}

function murekaError(data, fallback) {
  if (typeof data?.error === 'string') return data.error;
  if (data?.error?.message) return data.error.message;
  if (data?.message) return data.message;
  if (data?.detail) return typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
  try {
    const text = JSON.stringify(data);
    return text && text !== '{}' ? text.slice(0, 500) : fallback;
  } catch {
    return fallback;
  }
}

async function uploadMurekaFile(file, purpose) {
  const filename = String(file?.filename || '').trim();
  if (!/\.(mp3|m4a)$/i.test(filename)) {
    throw new Error('Mureka 参考采样目前只支持 MP3 / M4A，请先把音频转成 MP3 或 M4A 后再上传。');
  }
  const form = new FormData();
  const blob = new Blob([file.data], { type: file.contentType || 'audio/mpeg' });
  form.append('file', blob, filename);
  form.append('purpose', purpose);
  const response = await fetch('https://api.mureka.ai/v1/files/upload', {
    method: 'POST',
    headers: {
      Authorization: murekaAuthHeader()
    },
    body: form
  });
  const data = await response.json();
  if (!response.ok) throw new Error(murekaError(data, 'Mureka file upload failed'));
  const id = pickMurekaFileId(data);
  if (!id) throw new Error('Mureka file upload succeeded but no file id was returned.');
  return { id, raw: data };
}

async function callMurekaWithReference(payload, sampleFile) {
  if (payload.vocals === false) return callMurekaInstrumental(payload);
  if (!sampleFile) return callMureka(payload);
  const uploaded = await uploadMurekaFile(sampleFile, 'remix');
  const lyrics = normalizeLyrics(payload);
  const prompt = [
    sampleControlPrompt(payload),
    buildMurekaPrompt(payload)
  ].join(' ').slice(0, 1024);
  const response = await fetch('https://api.mureka.ai/v1/song/remix', {
    method: 'POST',
    headers: {
      Authorization: murekaAuthHeader(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      upload_audio_id: uploaded.id,
      lyrics,
      prompt,
      n: 1
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(murekaError(data, 'Mureka remix request failed'));
  data._uploaded_sample = { id: uploaded.id, filename: sampleFile.filename, purpose: 'remix' };
  return data;
}

async function queryMurekaTask(providerTaskId, queryKind = 'song') {
  const path = queryKind === 'instrumental' ? 'instrumental' : 'song';
  const response = await fetch(`https://api.mureka.ai/v1/${path}/query/${encodeURIComponent(providerTaskId)}`, {
    method: 'GET',
    headers: {
      Authorization: murekaAuthHeader(),
      'Content-Type': 'application/json'
    }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(murekaError(data, 'Mureka query failed'));
  return data;
}

async function checkMurekaAccount() {
  const response = await fetch('https://api.mureka.ai/v1/account/billing', {
    method: 'GET',
    headers: {
      Authorization: murekaAuthHeader(),
      'Content-Type': 'application/json'
    }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(murekaError(data, 'Mureka authentication check failed'));
  return data;
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/config') {
    const provider = musicProvider();
    const databaseConnected = await initDb();
    return sendJson(res, 200, {
      provider,
      ready: provider !== 'demo',
      databaseReady: databaseConnected,
      databaseProvider: databaseConnected ? 'postgresql' : 'json-file',
      textModelReady: !!process.env.OPENROUTER_API_KEY,
      textModelProvider: process.env.OPENROUTER_API_KEY ? 'openrouter' : 'local',
      coverReady: !!process.env.COVER_API_KEY,
      coverProvider: process.env.COVER_API_PROVIDER || 'local-plan',
      videoReady: !!process.env.VIDEO_API_KEY,
      videoProvider: process.env.VIDEO_API_PROVIDER || 'local-plan',
      message: provider === 'demo' ? 'No music API key configured; using browser demo engine' : `${provider} connected`
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/music-health') {
    const provider = musicProvider();
    if (provider !== 'mureka') {
      return sendJson(res, 200, { provider, ok: provider !== 'demo', message: provider === 'demo' ? 'No music API configured.' : `${provider} configured.` });
    }
    const account = await checkMurekaAccount();
    return sendJson(res, 200, {
      provider,
      ok: true,
      accountId: account.account_id || account.data?.account_id || null,
      balance: account.balance ?? account.data?.balance ?? null,
      concurrentRequestLimit: account.concurrent_request_limit ?? account.data?.concurrent_request_limit ?? null
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/ai/song-helper') {
    const body = await readBody(req);
    const helper = await callOpenRouter(body);
    return sendJson(res, 200, { helper });
  }

  if (req.method === 'POST' && url.pathname === '/api/lyrics') {
    const body = await readBody(req);
    const provider = musicProvider();
    if (provider === 'mureka') {
      const result = await callMurekaLyrics(body);
      return sendJson(res, 200, { provider: 'mureka', lyrics: result.lyrics, raw: result.raw });
    }
    if (process.env.OPENROUTER_API_KEY) {
      const helper = await callOpenRouter({
        story: body.prompt || body.story || '',
        theme: body.style || '中文歌曲',
        tone: body.mood || '真诚自然'
      });
      return sendJson(res, 200, { provider: 'openrouter', lyrics: helper.lyrics || '', helper });
    }
    throw new Error('No lyrics API configured.');
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    return sendJson(res, 200, { user: publicUser(await currentUser(req)) });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/send-code') {
    const body = await readBody(req);
    const email = normalizeEmail(body.email);
    const purpose = String(body.purpose || 'register').trim();
    assertEmail(email);
    if (!['register', 'reset'].includes(purpose)) throw new Error('验证码用途无效。');
    const exists = !!(await findUserByEmail(email));
    if (purpose === 'register' && exists) throw new Error('该邮箱已注册，请直接登录。');
    if (purpose === 'reset' && !exists) throw new Error('该邮箱还没有注册。');
    const code = await createVerifyCode(email, purpose);
    return sendJson(res, 200, {
      ok: true,
      // 当前未配置真实邮件服务，先返回测试验证码；接入邮件服务后删除 devCode。
      devCode: code,
      message: '验证码已生成，10 分钟内有效。'
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    const body = await readBody(req);
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    const name = String(body.name || '').trim() || email.split('@')[0];
    assertEmail(email);
    if (password.length < 6) throw new Error('密码至少 6 位。');
    await consumeVerifyCode(email, 'register', body.code);
    if (await findUserByEmail(email)) throw new Error('该邮箱已注册。');
    const salt = crypto.randomBytes(16).toString('base64');
    const user = {
      id: crypto.randomUUID(),
      email,
      name,
      salt,
      passwordHash: hashPassword(password, salt),
      credits: 40,
      emailVerified: true,
      createdAt: new Date().toISOString()
    };
    await createUser(user);
    await createSession(res, user.id);
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readBody(req);
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    const user = await findUserByEmail(email);
    if (!user || hashPassword(password, user.salt) !== user.passwordHash) throw new Error('邮箱或密码错误。');
    await createSession(res, user.id);
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/reset-password') {
    const body = await readBody(req);
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    assertEmail(email);
    if (password.length < 6) throw new Error('新密码至少 6 位。');
    await consumeVerifyCode(email, 'reset', body.code);
    const user = await findUserByEmail(email);
    if (!user) throw new Error('该邮箱还没有注册。');
    const salt = crypto.randomBytes(16).toString('base64');
    await updateUserPassword(user.id, salt, hashPassword(password, salt));
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/change-password') {
    const user = await requireUser(req);
    const body = await readBody(req);
    const oldPassword = String(body.oldPassword || '');
    const newPassword = String(body.newPassword || '');
    if (newPassword.length < 6) throw new Error('新密码至少 6 位。');
    const stored = await findUserById(user.id);
    if (!stored || hashPassword(oldPassword, stored.salt) !== stored.passwordHash) throw new Error('旧密码不正确。');
    const salt = crypto.randomBytes(16).toString('base64');
    await updateUserPassword(stored.id, salt, hashPassword(newPassword, salt));
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const token = parseCookies(req).shenghuoji_session;
    await deleteSession(token);
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/library') {
    const user = await requireUser(req);
    const songs = await listUserSongs(user.id);
    return sendJson(res, 200, { songs });
  }

  if (req.method === 'POST' && url.pathname === '/api/generate') {
    const user = await requireUser(req);
    const { body, sampleFile } = await readApiPayload(req);
    const provider = musicProvider();
    if (provider === 'demo') throw new Error('No music API key configured.');
    const raw = provider === 'minimax' ? await callMiniMax(body) : await callMurekaWithReference(body, sampleFile);
    const audioUrls = findAudioUrls(raw);
    const id = crypto.randomUUID();
    const queryKind = provider === 'mureka' && body.vocals === false ? 'instrumental' : 'song';
    const task = {
      id,
      userId: user.id,
      provider,
      queryKind,
      providerTaskId: pickProviderTaskId(raw, id),
      status: audioUrls.length ? 'completed' : pickStatus(raw, 'processing'),
      title: String(body.prompt || 'AI Song').slice(0, 28),
      payload: body,
      audioUrls,
      raw,
      saved: false
    };
    tasks.set(id, task);
    await saveGeneratedSong(task);
    return sendJson(res, 200, task);
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/tasks/')) {
    const user = await requireUser(req);
    const id = decodeURIComponent(url.pathname.replace('/api/tasks/', ''));
    const task = tasks.get(id);
    if (!task) return sendJson(res, 404, { error: 'Task not found' });
    if (task.userId !== user.id) return sendJson(res, 403, { error: 'Forbidden' });
    if (task.provider === 'mureka' && task.providerTaskId && (!task.audioUrls.length || !/complete|success|done|finished/i.test(String(task.status)))) {
      const providerRaw = await queryMurekaTask(task.providerTaskId, task.queryKind);
      task.raw = providerRaw;
      task.status = pickStatus(providerRaw, task.status);
      task.audioUrls = findAudioUrls(providerRaw);
      await saveGeneratedSong(task);
      tasks.set(id, task);
    }
    return sendJson(res, 200, {
      id,
      provider: task.provider,
      providerTaskId: task.providerTaskId,
      status: task.status,
      done: task.audioUrls.length > 0,
      audioUrls: task.audioUrls,
      raw: task.raw
    });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'Forbidden' });
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return sendJson(res, 404, { error: 'Not found' });
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.json': 'application/json; charset=utf-8'
  };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.message || 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Shenghuoji AI listening on http://0.0.0.0:${PORT}`);
});
