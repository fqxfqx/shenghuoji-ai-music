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
        phone text unique,
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
    await pgPool.query('alter table users add column if not exists phone text unique');
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
    phone: row.phone || null,
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
        `insert into users (id, email, phone, name, salt, password_hash, credits, email_verified, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9::timestamptz, now()), $10::timestamptz)
         on conflict (id) do nothing`,
        [
          user.id,
          user.email,
          user.phone || null,
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

function readRawBody(req, limit = 120 * 1024 * 1024) {
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
    return { body, sampleFile: parsed.files.sample || null, files: parsed.files };
  }
  return { body: await readBody(req), sampleFile: null, files: {} };
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

function isSecureRequest(req) {
  return req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted;
}

function setSessionCookie(req, res, token) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `shenghuoji_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 24 * 3600}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'shenghuoji_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    phone: user.phone || null,
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

async function findUserByPhone(phone) {
  if (await initDb()) {
    const result = await pgPool.query('select * from users where phone = $1 limit 1', [phone]);
    return rowToUser(result.rows[0]);
  }
  return readJson(USERS_FILE).find(user => user.phone === phone) || null;
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
      `insert into users (id, email, phone, name, salt, password_hash, credits, email_verified, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
      [user.id, user.email, user.phone || null, user.name, user.salt, user.passwordHash, user.credits || 0, !!user.emailVerified, user.createdAt]
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

async function createSession(req, res, userId) {
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
  setSessionCookie(req, res, token);
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

function normalizePhone(value) {
  return String(value || '').replace(/[^\d]/g, '').trim();
}

function assertPhone(phone) {
  if (!/^1[3-9]\d{9}$/.test(phone)) throw new Error('请输入有效的中国大陆手机号。');
}

function aliyunMailConfig() {
  const accessKeyId = process.env.ALIYUN_MAIL_ACCESS_KEY_ID || process.env.ALIYUN_ACCESS_KEY_ID || '';
  const accessKeySecret = process.env.ALIYUN_MAIL_ACCESS_KEY_SECRET || process.env.ALIYUN_ACCESS_KEY_SECRET || '';
  const accountName = process.env.ALIYUN_MAIL_ACCOUNT_NAME || process.env.EMAIL_FROM || '';
  return {
    accessKeyId: cleanSecret(accessKeyId),
    accessKeySecret: cleanSecret(accessKeySecret),
    accountName: String(accountName || '').trim(),
    fromAlias: String(process.env.ALIYUN_MAIL_FROM_ALIAS || '生活集爱音乐').trim(),
    regionId: String(process.env.ALIYUN_MAIL_REGION || 'cn-hangzhou').trim()
  };
}

function emailProvider() {
  const provider = String(process.env.EMAIL_PROVIDER || '').trim().toLowerCase();
  const aliyun = aliyunMailConfig();
  if (provider === 'aliyun' || (aliyun.accessKeyId && aliyun.accessKeySecret && aliyun.accountName)) return 'aliyun';
  return null;
}

function smsConfig() {
  return {
    accessKeyId: cleanSecret(process.env.ALIYUN_SMS_ACCESS_KEY_ID || process.env.ALIYUN_ACCESS_KEY_ID || ''),
    accessKeySecret: cleanSecret(process.env.ALIYUN_SMS_ACCESS_KEY_SECRET || process.env.ALIYUN_ACCESS_KEY_SECRET || ''),
    signName: String(process.env.ALIYUN_SMS_SIGN_NAME || '').trim(),
    templateCode: String(process.env.ALIYUN_SMS_TEMPLATE_CODE || '').trim(),
    regionId: String(process.env.ALIYUN_SMS_REGION || 'cn-hangzhou').trim()
  };
}

function smsProvider() {
  const provider = String(process.env.SMS_PROVIDER || '').trim().toLowerCase();
  const config = smsConfig();
  if (provider === 'aliyun' || (config.accessKeyId && config.accessKeySecret && config.signName && config.templateCode)) return 'aliyun';
  return null;
}

function devLoginReady() {
  return process.env.DEV_LOGIN_ENABLED === 'true' && !!process.env.DEV_LOGIN_CODE;
}

function canUseDevVerifyCode(req) {
  const host = String(req.headers.host || '').toLowerCase();
  return process.env.ALLOW_DEV_VERIFY_CODE === 'true'
    || host.startsWith('localhost')
    || host.startsWith('127.0.0.1');
}

function aliyunEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

async function sendAliyunMail({ to, subject, htmlBody, textBody }) {
  const config = aliyunMailConfig();
  if (!config.accessKeyId || !config.accessKeySecret || !config.accountName) {
    throw new Error('Aliyun mail is missing AccessKey or sender account.');
  }
  const params = {
    AccessKeyId: config.accessKeyId,
    AccountName: config.accountName,
    Action: 'SingleSendMail',
    AddressType: '1',
    Format: 'JSON',
    FromAlias: config.fromAlias,
    HtmlBody: htmlBody,
    RegionId: config.regionId,
    ReplyToAddress: 'true',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    Subject: subject,
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ToAddress: to,
    Version: '2015-11-23'
  };
  if (textBody) params.TextBody = textBody;
  const canonicalized = Object.keys(params)
    .sort()
    .map(key => `${aliyunEncode(key)}=${aliyunEncode(params[key])}`)
    .join('&');
  const stringToSign = `POST&%2F&${aliyunEncode(canonicalized)}`;
  params.Signature = crypto
    .createHmac('sha1', `${config.accessKeySecret}&`)
    .update(stringToSign)
    .digest('base64');
  const response = await fetch('https://dm.aliyuncs.com/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text };
  }
  if (!response.ok || data.Code) {
    throw new Error(data.Message || data.message || data.Code || 'Aliyun DirectMail request failed');
  }
  return data;
}

async function sendVerificationEmail(email, code, purpose) {
  const provider = emailProvider();
  if (!provider) return { sent: false, provider: 'local' };
  const actionText = purpose === 'reset' ? '重置密码' : '注册账号';
  const subject = `生活集爱音乐${actionText}验证码`;
  const htmlBody = [
    '<div style="font-family:Arial,Helvetica,sans-serif;line-height:1.7;color:#111827">',
    '<h2 style="margin:0 0 12px">生活集爱音乐验证码</h2>',
    `<p>你正在${actionText}，验证码为：</p>`,
    `<p style="font-size:28px;font-weight:800;letter-spacing:4px;margin:18px 0">${code}</p>`,
    '<p>验证码 10 分钟内有效。如果不是你本人操作，请忽略这封邮件。</p>',
    '</div>'
  ].join('');
  if (provider === 'aliyun') {
    await sendAliyunMail({
      to: email,
      subject,
      htmlBody,
      textBody: `生活集爱音乐验证码：${code}。10 分钟内有效。`
    });
    return { sent: true, provider };
  }
  return { sent: false, provider: 'local' };
}

async function sendAliyunSms(phone, code) {
  const config = smsConfig();
  if (!config.accessKeyId || !config.accessKeySecret || !config.signName || !config.templateCode) {
    throw new Error('Aliyun SMS is missing AccessKey, sign name, or template code.');
  }
  const params = {
    AccessKeyId: config.accessKeyId,
    Action: 'SendSms',
    Format: 'JSON',
    PhoneNumbers: phone,
    RegionId: config.regionId,
    SignName: config.signName,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    TemplateCode: config.templateCode,
    TemplateParam: JSON.stringify({ code }),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: '2017-05-25'
  };
  const canonicalized = Object.keys(params)
    .sort()
    .map(key => `${aliyunEncode(key)}=${aliyunEncode(params[key])}`)
    .join('&');
  const stringToSign = `POST&%2F&${aliyunEncode(canonicalized)}`;
  params.Signature = crypto
    .createHmac('sha1', `${config.accessKeySecret}&`)
    .update(stringToSign)
    .digest('base64');
  const response = await fetch('https://dysmsapi.aliyuncs.com/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { Message: text };
  }
  if (!response.ok || (data.Code && data.Code !== 'OK')) {
    throw new Error(data.Message || data.Code || 'Aliyun SMS request failed');
  }
  return data;
}

async function sendVerificationSms(phone, code) {
  const provider = smsProvider();
  if (!provider) return { sent: false, provider: 'local' };
  if (provider === 'aliyun') {
    await sendAliyunSms(phone, code);
    return { sent: true, provider };
  }
  return { sent: false, provider: 'local' };
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
  if (process.env.MUREKA_API_KEY) return 'mureka';
  if (process.env.MINIMAX_API_KEY) return 'minimax';
  return 'demo';
}

function musicProviderStatus() {
  return {
    mureka: !!process.env.MUREKA_API_KEY,
    minimax: !!process.env.MINIMAX_API_KEY
  };
}

function selectMusicProvider(body, sampleFile) {
  const status = musicProviderStatus();
  const mode = String(body.musicMode || 'auto').trim().toLowerCase();
  const hasReference = !!sampleFile || !!body.sampleName || body.sampleAsTextReference;
  if (mode === 'standard' && status.minimax && !hasReference && body.vocals !== false) return 'minimax';
  if ((mode === 'premium' || mode === 'reference') && status.mureka) return 'mureka';
  if (hasReference && status.mureka) return 'mureka';
  if (body.vocals === false && status.mureka) return 'mureka';
  if (mode === 'auto' && status.minimax && body.vocals !== false) return 'minimax';
  if (status.mureka) return 'mureka';
  if (status.minimax) return 'minimax';
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
    const keyLooksAudio = /(audio|song|music|track|vocal|mp3|wav|m4a|aac|flac|url|download|stream|cdn|oss|file|source)/i.test(keyPath);
    const keyLooksImage = /(cover|image|artwork|poster|thumbnail|avatar)/i.test(keyPath);
    const valueLooksImage = /\.(png|jpe?g|webp|gif)(\?.*)?$/i.test(value);
    const valueLooksNonAudio = /\.(json|txt|html|xml|srt|lrc|png|jpe?g|webp|gif|mp4|mov)(\?.*)?$/i.test(value);
    const hostedAsset = /^https?:\/\/.+/i.test(value) && /(audio|song|music|mureka|minimax|aliyun|oss|cdn|cos|s3|r2|cloudfront|download|file|media)/i.test(`${keyPath} ${value}`);
    if ((looksLikeAudioUrl || (keyLooksAudio && /^https?:\/\//i.test(value)) || hostedAsset) && !keyLooksImage && !valueLooksImage && !valueLooksNonAudio) {
      const negative = /(instrumental|accompaniment|backing|stem|drum|bass|other|separate|伴奏|分轨)/i.test(`${keyPath} ${value}`);
      let score = looksLikeAudioUrl ? 24 : 10;
      if (/(song|full|complete|mix|master|audio|url|download|stream|cdn|歌曲|成品|完整)/i.test(keyPath)) score += 18;
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
  const language = languageProfile(payload.language);
  if (/english/i.test(language.code)) {
    return [
      '[Verse]',
      `I turn this story into a simple song: ${baseLine}`,
      'Every honest word can find a melody',
      'Every ordinary day can shine a little brighter',
      '',
      '[Pre-Chorus]',
      'Let the feeling rise, let the rhythm carry on',
      'Keep it clear, heartfelt, and easy to remember',
      '',
      '[Chorus]',
      'I want to sing this song to you',
      'With a real voice and a heart that is true',
      'Hold this moment, let it stay',
      'Let the music light the way'
    ].join('\n');
  }
  if (/japanese/i.test(language.code)) {
    return [
      '[Verse]',
      `この物語を歌にして: ${baseLine}`,
      '小さな日々にも光がある',
      '心の言葉をそっと届ける',
      '',
      '[Chorus]',
      'この歌をあなたへ',
      'まっすぐな声で届けたい',
      '今この瞬間が',
      '明日へ続いていく'
    ].join('\n');
  }
  if (/korean/i.test(language.code)) {
    return [
      '[Verse]',
      `이 이야기를 노래로 불러요: ${baseLine}`,
      '평범한 하루에도 빛이 있어',
      '마음속 말을 천천히 전해요',
      '',
      '[Chorus]',
      '이 노래를 너에게 부를게',
      '진심 어린 목소리로 가까이 갈게',
      '오늘의 순간을 기억해',
      '우리의 마음이 노래가 돼'
    ].join('\n');
  }
  if (/cantonese/i.test(language.code)) {
    return [
      '[Verse]',
      `將呢個故事唱出嚟：${baseLine}`,
      '平凡日子都有光',
      '心入面嘅說話慢慢講',
      '',
      '[Chorus]',
      '我想將呢首歌唱畀你聽',
      '用最真嘅聲靠近你心情',
      '呢一刻唔需要太多證明',
      '生活入面都有回應'
    ].join('\n');
  }
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

function languageProfile(language) {
  const text = String(language || '中文').trim();
  if (/英|english/i.test(text)) {
    return {
      code: 'english',
      label: text,
      songLine: 'English vocal pop song, all sung lyrics must be in English',
      lyricRule: 'Use English lyrics only. Do not insert Chinese lines unless the user explicitly asks for bilingual lyrics.'
    };
  }
  if (/中英|双语|bilingual/i.test(text)) {
    return {
      code: 'bilingual',
      label: text,
      songLine: 'Chinese-English bilingual vocal song, mix Mandarin Chinese and English naturally',
      lyricRule: 'Use a natural Chinese-English mix. Keep each section singable and do not switch randomly.'
    };
  }
  if (/粤|廣東|广东|cantonese/i.test(text)) {
    return {
      code: 'cantonese',
      label: text,
      songLine: 'Cantonese vocal pop song, all sung lyrics should be Cantonese',
      lyricRule: 'Use Cantonese lyrics. Do not convert the song into Mandarin unless the user asks for Mandarin.'
    };
  }
  if (/日|japanese/i.test(text)) {
    return {
      code: 'japanese',
      label: text,
      songLine: 'Japanese vocal pop song, all sung lyrics must be in Japanese',
      lyricRule: 'Use Japanese lyrics only. Do not insert Chinese lines unless the user asks for bilingual lyrics.'
    };
  }
  if (/韩|韓|korean/i.test(text)) {
    return {
      code: 'korean',
      label: text,
      songLine: 'Korean vocal pop song, all sung lyrics must be in Korean',
      lyricRule: 'Use Korean lyrics only. Do not insert Chinese lines unless the user asks for bilingual lyrics.'
    };
  }
  if (/四川|东北|閩南|闽南|方言|dialect/i.test(text)) {
    return {
      code: 'mandarin-dialect',
      label: text,
      songLine: `Mandarin Chinese vocal song with ${text} accent or dialect flavor`,
      lyricRule: `Use Chinese lyrics with ${text}口吻. Keep the wording natural and singable.`
    };
  }
  return {
    code: 'mandarin',
    label: text || '中文',
    songLine: 'Mandarin Chinese vocal pop song, all sung lyrics must be in Chinese',
    lyricRule: 'Use Chinese lyrics only unless the user explicitly asks for another language.'
  };
}

function murekaVoicePrompt(voiceType) {
  const text = String(voiceType || '');
  if (/男女|对唱|合唱|duet/i.test(text)) return 'male and female duet vocals, two distinct singers';
  if (/男|male/i.test(text)) return /低沉|磁性|沧桑|深沉/i.test(text) ? 'deep male lead vocal only, no female lead vocal' : 'male lead vocal only, no female lead vocal';
  if (/儿童|童声|少年|child/i.test(text)) return 'childlike vocal, bright and clean';
  if (/多人|合唱团|choir/i.test(text)) return 'group choir vocals';
  return /温柔|甜美|清亮|女|female/i.test(text) ? 'female lead vocal only, no male lead vocal' : `${text || 'natural Chinese lead vocal'}, clear lead sung vocals`;
}

function murekaStylePrompt(style) {
  const text = String(style || '');
  if (/节奏布鲁斯|R&B|r&b/i.test(text)) return 'R&B, soulful groove, smooth drums, warm bass';
  if (/说唱|rap|hip.?hop/i.test(text)) return 'rap hip-hop, clear rhythmic vocal delivery';
  if (/电子|舞曲|EDM/i.test(text)) return 'electronic dance pop, modern synths, energetic beat';
  if (/未来|贝斯|future/i.test(text)) return 'future bass, wide synth chords, punchy electronic drums';
  if (/低保真|lo.?fi/i.test(text)) return 'lo-fi pop, relaxed beat, warm tape texture';
  if (/国风/i.test(text)) return 'Chinese traditional fusion pop, guzheng and modern pop rhythm';
  if (/摇滚|rock/i.test(text)) return 'indie rock, live drums, electric guitars, strong chorus';
  if (/金属|metal/i.test(text)) return 'metal rock, heavy guitars, powerful drums';
  if (/民谣|folk/i.test(text)) return 'folk ballad, acoustic guitar, intimate vocal';
  if (/爵士|jazz/i.test(text)) return 'jazz pop, soft piano, upright bass, brushed drums';
  if (/儿童/i.test(text)) return 'children song, bright melody, simple chorus';
  if (/古典/i.test(text)) return 'classical crossover pop, strings and piano';
  if (/流行|pop/i.test(text)) return 'pop, memorable melody, radio-ready arrangement';
  return `${text || 'pop'}, memorable melody, radio-ready arrangement`;
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
  const priority = 'The user prompt, lyrics, selected language, vocal gender, and selected style are higher priority than the reference audio.';
  if (styleInfluence >= 85) {
    return `${priority} Use the uploaded audio as a strong reference for tempo, energy curve, section structure, groove, and overall vibe. Reference influence ${styleInfluence} percent. Do not copy the exact melody or imitate the original singer.`;
  }
  if (styleInfluence >= 55) {
    return `${priority} Use the uploaded audio as a medium reference for vibe, tempo range, rhythm feel, and chorus energy. Reference influence ${styleInfluence} percent. Do not copy the exact melody or imitate the original singer.`;
  }
  return `${priority} Use the uploaded audio as a light inspiration only. Reference influence ${styleInfluence} percent. Do not copy the exact melody or imitate the original singer.`;
}

function buildMurekaPrompt(payload) {
  const style = String(payload.style || '中文流行').trim();
  const mood = String(payload.mood || '真诚温暖').trim();
  const usecase = String(payload.usecase || '生活写歌').trim();
  const voiceType = String(payload.voiceType || '自然中文人声').trim();
  const language = languageProfile(payload.language);
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
      `language: ${language.label}`,
      language.lyricRule,
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
    language.songLine,
    'full song, verse and chorus, radio-ready mix',
    durationSource,
    `style influence ${styleInfluence} percent`,
    `language: ${language.label}`,
    language.lyricRule,
    `use case: ${usecase}`,
    `user direction: ${userPrompt}`,
    'create exactly one final song version, do not create multiple alternate takes',
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

function cleanJsonContent(content) {
  return String(content || '{}')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function textModelProvider() {
  if (process.env.DEEPSEEK_API_KEY) return 'deepseek';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  return null;
}

function songHelperMessages(payload) {
  const story = String(payload.story || payload.prompt || '').trim();
  const theme = String(payload.theme || payload.style || '中文歌曲').trim();
  const tone = String(payload.tone || payload.mood || '真诚自然').trim();
  const language = languageProfile(payload.language);
  const strict = payload.strict === true;
  return [
    {
      role: 'system',
      content: [
        '你是一个面向普通人的写歌助手。只返回 JSON，不要 Markdown。字段必须包含：title, prompt, lyrics, style, mood, voiceType, duration, shareText。',
        '必须紧扣用户给出的故事、对象、用途和情绪，不允许写成泛泛的生活感悟，不允许擅自改成失恋、离别、遗忘、铺路等无关主题。',
        '歌词要像真实的人在说心里话，适合直接交给音乐生成模型演唱。不要模仿真实歌手，不要改写已有歌曲。',
        `语言硬性要求：${language.lyricRule}`,
        strict ? '这是一次纠偏重试：上一次结果跑题了。你必须在 title、prompt、lyrics、shareText 中明确体现用户故事里的核心对象和用途。' : ''
      ].filter(Boolean).join(' ')
    },
    {
      role: 'user',
      content: [
        `故事/需求：${story}`,
        `主题/用途：${theme}`,
        `情绪/口吻：${tone}`,
        `歌曲语言：${language.label}`,
        '请严格围绕上面的故事/需求创作，歌名、prompt、歌词、分享文案都要能看出这个具体主题。',
        '歌词至少包含 [Verse] 和 [Chorus]，如果是送给某个人，要直接表达给这个人的话。',
        'prompt 字段也要明确写出歌曲语言、风格、用途、人声性别和主题关键词。'
      ].join('\n')
    }
  ];
}

function extractChineseKeywords(text) {
  const value = String(text || '');
  const fixed = ['妈妈', '母亲', '爸爸', '父亲', '生日', '婚礼', '孩子', '女儿', '儿子', '爱人', '家乡', '开业', '品牌'];
  return fixed.filter(word => value.includes(word));
}

function helperMatchesRequest(helper, payload) {
  const keywords = extractChineseKeywords(`${payload.story || payload.prompt || ''} ${payload.theme || payload.style || ''}`);
  if (!keywords.length) return true;
  const output = `${helper?.title || ''} ${helper?.prompt || ''} ${helper?.lyrics || ''} ${helper?.shareText || ''}`;
  return keywords.some(word => output.includes(word));
}

async function callDeepSeek(payload) {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is missing.');
  const model = process.env.DEEPSEEK_TEXT_MODEL || 'deepseek-chat';
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      temperature: 0.8,
      messages: songHelperMessages(payload)
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'DeepSeek request failed');
  const content = data.choices?.[0]?.message?.content || '{}';
  return JSON.parse(cleanJsonContent(content));
}

async function callDeepSeekChecked(payload) {
  const helper = await callDeepSeek(payload);
  if (helperMatchesRequest(helper, payload)) return helper;
  const retry = await callDeepSeek({ ...payload, strict: true });
  return retry;
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
      messages: songHelperMessages(payload)
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'OpenRouter request failed');
  const content = data.choices?.[0]?.message?.content || '{}';
  return JSON.parse(cleanJsonContent(content));
}

async function callTextModel(payload) {
  const provider = textModelProvider();
  if (provider === 'deepseek') {
    const helper = await callDeepSeekChecked(payload);
    return { provider, helper };
  }
  if (provider === 'openrouter') {
    const helper = await callOpenRouter(payload);
    return { provider, helper };
  }
  throw new Error('No text model API configured.');
}

async function callTextJson(system, user) {
  const provider = textModelProvider();
  if (provider === 'deepseek') {
    const model = process.env.DEEPSEEK_TEXT_MODEL || 'deepseek-chat';
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        temperature: 0.75,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'DeepSeek request failed');
    return { provider, result: JSON.parse(cleanJsonContent(data.choices?.[0]?.message?.content || '{}')) };
  }
  if (provider === 'openrouter') {
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
        temperature: 0.75,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'OpenRouter request failed');
    return { provider, result: JSON.parse(cleanJsonContent(data.choices?.[0]?.message?.content || '{}')) };
  }
  throw new Error('No text model API configured.');
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
  const userPrompt = String(payload.prompt || payload.story || '').trim();
  const language = languageProfile(payload.language);
  const style = String(payload.style || '中文流行').trim();
  const mood = String(payload.mood || '真诚温暖').trim();
  const prompt = [
    `Write original song lyrics in this language: ${language.label}.`,
    language.lyricRule,
    `Topic: ${userPrompt}.`,
    `Style: ${style}.`,
    `Mood: ${mood}.`,
    'Use clear song sections like [Verse], [Chorus], [Bridge].',
    'Strictly follow the topic and language. Do not write about unrelated scenery, fantasy, or forests unless the topic asks for it.'
  ].join(' ');
  const response = await fetch('https://api.mureka.ai/v1/lyrics/generate', {
    method: 'POST',
    headers: {
      Authorization: murekaAuthHeader(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      prompt
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
  if (!/\.(mp3|m4a|wav|mp4|mov|png|jpe?g|webp)$/i.test(filename)) {
    throw new Error('Mureka upload supports MP3, M4A, WAV, MP4, MOV, PNG, JPG, or WEBP files.');
  }
  const form = new FormData();
  const blob = new Blob([file.data], { type: file.contentType || 'application/octet-stream' });
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
function firstUploadedFile(files) {
  if (!files) return null;
  return files.sample || files.audio || files.media || files.voice || Object.values(files)[0] || null;
}

function murekaUploadPurpose(action) {
  if (action === 'soundtrack') return 'soundtrack';
  if (action === 'lyrics-video') return 'lyrics-video';
  if (action === 'vocal-cloning') return 'voice';
  if (action === 'remix') return 'remix';
  return 'audio';
}

function validateMurekaToolFile(action, file) {
  if (!file) return;
  const filename = String(file.filename || '');
  const sizeMb = file.data.length / 1024 / 1024;
  const isAudioTool = ['song-extend', 'recognize', 'describe', 'lyrics-video', 'stem', 'region-editing'].includes(action);
  if (isAudioTool && !/\.(mp3|m4a)$/i.test(filename)) {
    throw new Error(`${toolActionName(action)} 需要上传 MP3 或 M4A 音频。你当前上传的是 ${path.extname(filename).replace('.', '').toUpperCase() || '未知格式'}，请先把 WAV 转成 MP3/M4A 后再用。`);
  }
  if (isAudioTool && file.data.length > 30 * 1024 * 1024) {
    throw new Error(`${toolActionName(action)} 上传音频建议小于 30MB。当前约 ${sizeMb.toFixed(1)}MB，请先压缩或截取较短片段。`);
  }
  if (action === 'soundtrack' && !/\.(mp3|m4a|mp4|mov|png|jpe?g|webp)$/i.test(filename)) {
    throw new Error('视频/图片配乐支持 MP3、M4A、MP4、MOV、PNG、JPG、WEBP。请先转换素材格式。');
  }
  if (action === 'soundtrack' && file.data.length > 80 * 1024 * 1024) {
    throw new Error(`视频/图片配乐素材过大，当前约 ${sizeMb.toFixed(1)}MB。请先压缩到 80MB 以内。`);
  }
}

function toolActionName(action) {
  return ({
    'lyrics-extend': '续写歌词',
    'song-extend': '歌曲延长',
    'vocal-cloning': '人声克隆',
    recognize: '歌曲识别',
    describe: '歌曲描述',
    'lyrics-video': '歌词视频',
    stem: 'Stem 分轨',
    'region-editing': '局部重做',
    soundtrack: '视频/图片配乐'
  })[action] || '增强工具';
}

async function callTextTool(action, body, file) {
  const common = [
    `功能：${toolActionName(action)}`,
    `歌曲名：${body.title || ''}`,
    `用户要求：${body.instruction || body.prompt || ''}`,
    `歌词：${body.lyrics || ''}`,
    `风格：${body.style || ''}`,
    `情绪：${body.mood || ''}`,
    `语言：${body.language || ''}`,
    `声音：${body.voiceType || ''}`,
    file ? `上传素材：${file.filename}，大小约 ${(file.data.length / 1024 / 1024).toFixed(1)}MB` : '未上传素材'
  ].join('\n');
  const prompts = {
    'lyrics-extend': '你是中文歌词创作助手。请根据已有歌词和用户要求续写歌词，只返回 JSON：{"summary":"","lyrics":"","tips":[]}。歌词要包含 [Verse] / [Chorus] 等结构。',
    describe: '你是音乐制作顾问。请根据用户填写的信息和上传文件名，分析歌曲风格方向。只返回 JSON：{"summary":"","style":"","mood":"","tempo":"","instruments":[],"suggestions":[]}。',
    recognize: '你是音乐识别结果整理助手。无法直接听音频时，请根据文件名、用户要求和已填风格生成一份“待确认识别报告”。只返回 JSON：{"summary":"","detected":{"title":"","style":"","mood":"","language":"","vocal":""},"nextSteps":[]}。',
    'lyrics-video': '你是歌词视频导演。请根据歌词和风格生成歌词视频方案。只返回 JSON：{"summary":"","scenes":[],"subtitleStyle":"","visualStyle":"","prompt":""}。'
  };
  const system = prompts[action];
  if (!system) return null;
  const { provider, result } = await callTextJson(system, common);
  return { provider, action, mode: 'text-assist', result };
}

async function callMurekaTool(action, body, file) {
  const textResult = await callTextTool(action, body, file);
  if (textResult) return textResult;
  validateMurekaToolFile(action, file);
  if (action === 'vocal-cloning') {
    if (!file) throw new Error('人声克隆需要上传已授权的人声样本。');
    const filename = String(file.filename || '');
    if (!/\.(mp3|m4a)$/i.test(filename)) {
      throw new Error('Mureka 人声克隆只支持 MP3 或 M4A，且文件需小于 10MB。请先把音频转成 MP3/M4A 后再上传。');
    }
    if (file.data.length > 10 * 1024 * 1024) {
      throw new Error('Mureka 人声克隆文件需小于 10MB，请压缩或截取更短的人声音频。');
    }
    const form = new FormData();
    const blob = new Blob([file.data], { type: file.contentType || 'audio/mpeg' });
    form.append('file', blob, filename);
    form.append('description', String(body.description || body.requirement || 'authorized vocal sample').slice(0, 1024));
    const response = await fetch('https://api.mureka.ai/v1/song/vocal-clone', {
      method: 'POST',
      headers: {
        Authorization: murekaAuthHeader()
      },
      body: form
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
    if (!response.ok) throw new Error(murekaError(data, 'Mureka vocal clone request failed'));
    return data;
  }

  const endpointMap = {
    'lyrics-extend': '/v1/lyrics/extend',
    'song-extend': '/v1/song/extend',
    recognize: '/v1/song/recognize',
    describe: '/v1/song/describe',
    'lyrics-video': '/v1/lyrics-video/generate',
    stem: '/v1/song/stem',
    'region-editing': '/v1/song/region-edit',
    soundtrack: '/v1/soundtrack/generate'
  };
  const endpoint = endpointMap[action];
  if (!endpoint) throw new Error('Unsupported Mureka tool action.');
  const payload = { ...body };
  delete payload.action;

  if (file) {
    const purpose = murekaUploadPurpose(action);
    const uploaded = await uploadMurekaFile(file, purpose);
    payload.upload_id = payload.upload_id || uploaded.id;
    payload.upload_audio_id = payload.upload_audio_id || uploaded.id;
    payload.audio_id = payload.audio_id || uploaded.id;
    payload.file_id = payload.file_id || uploaded.id;
    payload.uploaded_file = { id: uploaded.id, filename: file.filename };
  }

  const response = await fetch(`https://api.mureka.ai${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: murekaAuthHeader(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(murekaError(data, `Mureka ${action} request failed`));
  return data;
}

async function callMurekaWithReference(payload, sampleFile) {
  if (payload.vocals === false) return callMurekaInstrumental(payload);
  if (!sampleFile) return callMureka(payload);
  const sampleName = String(sampleFile.filename || payload.sampleName || 'uploaded reference');
  if (!/\.(mp3|m4a)$/i.test(sampleName)) {
    return callMureka({
      ...payload,
      prompt: [
        String(payload.prompt || ''),
        `The user uploaded a reference audio file named "${sampleName}". Use it only as a text-level creative reference from the filename and user direction. The selected language, lyrics, vocal gender, genre, and user topic are higher priority than this reference. Do not upload or copy the original audio. Create a new song that follows the requested style, lyrics, language, and vocal type.`
      ].filter(Boolean).join(' ')
    });
  }
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

async function prepareGenerationPayload(body) {
  const next = { ...body };
  const hasUsableLyrics = String(next.lyrics || '').trim().replace(/\s+/g, '').length >= 20;
  if (next.vocals !== false && !hasUsableLyrics && textModelProvider()) {
    try {
      const result = await callTextModel({
        ...next,
        story: next.prompt,
        theme: next.usecase || next.style,
        tone: next.mood
      });
      const lyrics = String(result.helper?.lyrics || '').trim();
      if (lyrics) {
        next.lyrics = lyrics;
        next.prompt = [
          String(next.prompt || '').trim(),
          String(result.helper?.prompt || '').trim()
        ].filter(Boolean).join('。');
        next._lyricsGeneratedBy = result.provider;
      }
    } catch (error) {
      next._lyricsGeneratedBy = 'fallback';
      next._lyricsError = error.message || 'lyrics helper failed';
    }
  }
  return next;
}

async function submitGenerationTask(task, body, sampleFile) {
  try {
    const preparedBody = await prepareGenerationPayload(body);
    task.payload = preparedBody;
    let provider = task.provider;
    let raw;
    try {
      raw = provider === 'minimax' ? await callMiniMax(preparedBody) : await callMurekaWithReference(preparedBody, sampleFile);
    } catch (primaryError) {
      const canFallbackToMiniMax = provider === 'mureka'
        && process.env.MINIMAX_API_KEY
        && !sampleFile
        && !preparedBody.sampleName
        && preparedBody.vocals !== false;
      if (!canFallbackToMiniMax) throw primaryError;
      provider = 'minimax';
      task.provider = provider;
      preparedBody._fallbackFrom = 'mureka';
      preparedBody._fallbackReason = primaryError.message || 'Mureka failed';
      raw = await callMiniMax(preparedBody);
    }
    const audioUrls = findAudioUrls(raw).slice(0, 1);
    task.raw = raw;
    task.providerTaskId = pickProviderTaskId(raw, task.id);
    task.queryKind = provider === 'mureka' && preparedBody.vocals === false ? 'instrumental' : 'song';
    task.status = audioUrls.length ? 'completed' : pickStatus(raw, 'processing');
    task.audioUrls = audioUrls;
    task.error = null;
    await saveGeneratedSong(task);
  } catch (error) {
    task.status = 'failed';
    task.error = error.message || 'Music generation failed';
    task.raw = { error: task.error };
  } finally {
    tasks.set(task.id, task);
  }
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/config') {
    const provider = musicProvider();
    const musicProviders = musicProviderStatus();
    const databaseConnected = await initDb();
    const textProvider = textModelProvider();
    const mailProvider = emailProvider();
    return sendJson(res, 200, {
      provider,
      ready: provider !== 'demo',
      musicProviders,
      databaseReady: databaseConnected,
      databaseProvider: databaseConnected ? 'postgresql' : 'json-file',
      textModelReady: !!textProvider,
      textModelProvider: textProvider || 'local',
      emailReady: !!mailProvider,
      emailProvider: mailProvider || 'local',
      smsReady: !!smsProvider(),
      smsProvider: smsProvider() || 'local',
      devLoginReady: devLoginReady(),
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
    const result = await callTextModel(body);
    return sendJson(res, 200, { provider: result.provider, helper: result.helper });
  }

  if (req.method === 'POST' && url.pathname === '/api/lyrics') {
    const body = await readBody(req);
    const textProvider = textModelProvider();
    if (textProvider) {
      const result = await callTextModel({
        story: body.prompt || body.story || '',
        theme: body.style || '中文歌曲',
        tone: body.mood || '真诚自然'
      });
      return sendJson(res, 200, { provider: result.provider, lyrics: result.helper.lyrics || '', helper: result.helper });
    }
    const provider = musicProvider();
    if (provider === 'mureka') {
      const result = await callMurekaLyrics(body);
      return sendJson(res, 200, { provider: 'mureka', lyrics: result.lyrics, raw: result.raw });
    }
    throw new Error('No lyrics API configured.');
  }

  if (req.method === 'POST' && url.pathname === '/api/mureka/tool') {
    await requireUser(req);
    if (musicProvider() !== 'mureka') throw new Error('Mureka API is not configured.');
    const parsed = await readApiPayload(req);
    const action = String(parsed.body.action || '').trim();
    const file = firstUploadedFile(parsed.files) || parsed.sampleFile;
    const result = await callMurekaTool(action, parsed.body, file);
    return sendJson(res, 200, { ok: true, action, result });
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    return sendJson(res, 200, { user: publicUser(await currentUser(req)) });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/dev-login') {
    if (!devLoginReady()) throw new Error('开发者测试登录未开启。');
    const body = await readBody(req);
    if (String(body.code || '') !== String(process.env.DEV_LOGIN_CODE)) throw new Error('开发者测试码不正确。');
    const email = 'developer@shenghuojiai.local';
    let user = await findUserByEmail(email);
    if (!user) {
      const salt = crypto.randomBytes(16).toString('base64');
      user = {
        id: crypto.randomUUID(),
        email,
        phone: null,
        name: '开发者',
        salt,
        passwordHash: hashPassword(crypto.randomUUID(), salt),
        credits: 9999,
        emailVerified: true,
        createdAt: new Date().toISOString()
      };
      await createUser(user);
    }
    await createSession(req, res, user.id);
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/send-code') {
    const body = await readBody(req);
    const email = normalizeEmail(body.email);
    const purpose = String(body.purpose || 'register').trim();
    assertEmail(email);
    if (!['register', 'reset', 'login'].includes(purpose)) throw new Error('验证码用途无效。');
    const exists = !!(await findUserByEmail(email));
    if (purpose === 'register' && exists) throw new Error('该邮箱已注册，请直接登录。');
    if (purpose === 'reset' && !exists) throw new Error('该邮箱还没有注册。');
    if (purpose === 'login' && !exists) throw new Error('该邮箱还没有注册。');
    if (!emailProvider() && !canUseDevVerifyCode(req)) {
      throw new Error('邮箱验证码服务还没配置好。请先在 Railway 变量里配置阿里云邮件推送，配置完成后用户才能正常注册。');
    }
    const code = await createVerifyCode(email, purpose);
    let mail;
    try {
      mail = await sendVerificationEmail(email, code, purpose);
    } catch (error) {
      throw new Error(`邮箱验证码发送失败：${error.message || '请检查阿里云邮件推送配置。'}`);
    }
    const exposeDevCode = !mail.sent && canUseDevVerifyCode(req);
    return sendJson(res, 200, {
      ok: true,
      provider: mail.provider,
      ...(exposeDevCode ? { devCode: code } : {}),
      message: mail.sent ? '验证码已发送，请查看邮箱。' : '本地测试验证码已生成，10 分钟内有效。'
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/send-sms-code') {
    const body = await readBody(req);
    const phone = normalizePhone(body.phone);
    const purpose = String(body.purpose || 'register').trim();
    assertPhone(phone);
    if (!['register', 'login'].includes(purpose)) throw new Error('验证码用途无效。');
    const exists = !!(await findUserByPhone(phone));
    if (purpose === 'register' && exists) throw new Error('该手机号已注册，请直接登录。');
    if (purpose === 'login' && !exists) throw new Error('该手机号还没有注册。');
    if (!smsProvider() && !canUseDevVerifyCode(req)) {
      throw new Error('短信验证码服务还没配置好。请先配置阿里云短信签名和验证码模板。');
    }
    const code = await createVerifyCode(phone, `sms-${purpose}`);
    let sms;
    try {
      sms = await sendVerificationSms(phone, code);
    } catch (error) {
      throw new Error(`短信验证码发送失败：${error.message || '请检查阿里云短信配置。'}`);
    }
    const exposeDevCode = !sms.sent && canUseDevVerifyCode(req);
    return sendJson(res, 200, {
      ok: true,
      provider: sms.provider,
      ...(exposeDevCode ? { devCode: code } : {}),
      message: sms.sent ? '短信验证码已发送，请查看手机。' : '本地测试短信验证码已生成，10 分钟内有效。'
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
    await createSession(req, res, user.id);
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/register-phone') {
    const body = await readBody(req);
    const phone = normalizePhone(body.phone);
    const password = String(body.password || '');
    const name = String(body.name || '').trim() || `手机用户${phone.slice(-4)}`;
    assertPhone(phone);
    if (password.length < 6) throw new Error('密码至少 6 位。');
    await consumeVerifyCode(phone, 'sms-register', body.code);
    if (await findUserByPhone(phone)) throw new Error('该手机号已注册。');
    const salt = crypto.randomBytes(16).toString('base64');
    const user = {
      id: crypto.randomUUID(),
      email: `${phone}@phone.shenghuojiai.local`,
      phone,
      name,
      salt,
      passwordHash: hashPassword(password, salt),
      credits: 40,
      emailVerified: false,
      createdAt: new Date().toISOString()
    };
    await createUser(user);
    await createSession(req, res, user.id);
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readBody(req);
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    const code = String(body.code || '').trim();
    const user = await findUserByEmail(email);
    if (!user) throw new Error('该邮箱还没有注册。');
    if (code) {
      await consumeVerifyCode(email, 'login', code);
    } else if (!password || hashPassword(password, user.salt) !== user.passwordHash) {
      throw new Error('邮箱验证码或密码错误。');
    }
    await createSession(req, res, user.id);
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login-phone') {
    const body = await readBody(req);
    const phone = normalizePhone(body.phone);
    const password = String(body.password || '');
    const code = String(body.code || '').trim();
    assertPhone(phone);
    const user = await findUserByPhone(phone);
    if (!user) throw new Error('该手机号还没有注册。');
    if (code) {
      await consumeVerifyCode(phone, 'sms-login', code);
    } else if (!password || hashPassword(password, user.salt) !== user.passwordHash) {
      throw new Error('手机号验证码或密码错误。');
    }
    await createSession(req, res, user.id);
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
    const provider = selectMusicProvider(body, sampleFile);
    if (provider === 'demo') throw new Error('No music API key configured.');
    const id = crypto.randomUUID();
    const queryKind = provider === 'mureka' && body.vocals === false ? 'instrumental' : 'song';
    const task = {
      id,
      userId: user.id,
      provider,
      queryKind,
      providerTaskId: null,
      status: 'queued',
      title: String(body.prompt || 'AI Song').slice(0, 28),
      payload: body,
      audioUrls: [],
      raw: null,
      saved: false
    };
    tasks.set(id, task);
    setTimeout(() => submitGenerationTask(task, body, sampleFile), 0);
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
      task.audioUrls = findAudioUrls(providerRaw).slice(0, 1);
      if (!task.audioUrls.length && /complete|success|done|finished/i.test(String(task.status))) {
        task.status = 'failed';
        task.error = '音乐任务已完成，但接口没有返回可播放音频链接，请稍后重试或切换标准模式。';
      }
      await saveGeneratedSong(task);
      tasks.set(id, task);
    }
    return sendJson(res, 200, {
      id,
      provider: task.provider,
      providerTaskId: task.providerTaskId,
      status: task.status,
      error: task.error || null,
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
