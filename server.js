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
for (const file of [USERS_FILE, SONGS_FILE, POSTS_FILE]) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, '[]', 'utf8');
}

loadDotEnv(path.join(ROOT, '.env'));
const sessions = new Map();
const tasks = new Map();

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
  res.setHeader('Set-Cookie', `shenghuoji_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${14 * 24 * 3600}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'shenghuoji_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
}

function publicUser(user) {
  if (!user) return null;
  return { id: user.id, email: user.email, name: user.name, credits: user.credits || 0 };
}

function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(`${salt}:${password}`).digest('base64');
}

function currentUser(req) {
  const token = parseCookies(req).shenghuoji_session;
  if (!token || !sessions.has(token)) return null;
  const session = sessions.get(token);
  const users = readJson(USERS_FILE);
  return users.find(user => user.id === session.userId) || null;
}

function requireUser(req) {
  const user = currentUser(req);
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
  const styleInfluence = Number(payload.styleInfluence || 70);
  const userPrompt = String(payload.prompt || '为普通人的生活故事写一首中文歌曲').trim();
  const voicePrompt = murekaVoicePrompt(voiceType);
  const stylePrompt = murekaStylePrompt(style);
  const moodPrompt = murekaMoodPrompt(mood);
  const targetDuration = Math.max(30, Math.min(240, Number(payload.duration || 90)));
  const durationSource = payload.durationMode === 'sample'
    ? `match the uploaded reference audio length, about ${targetDuration} seconds`
    : `arrange the full song around the lyric length, about ${targetDuration} seconds`;
  return [
    `Primary genre and arrangement: ${stylePrompt}`,
    `Mood: ${moodPrompt}`,
    `Vocal requirement: ${voicePrompt}`,
    'Mandarin Chinese pop song with clear lead sung vocals',
    'full song, verse and chorus, radio-ready mix',
    durationSource,
    `style influence ${styleInfluence} percent`,
    `use case: ${usecase}`,
    `user direction: ${userPrompt}`,
    'strictly follow the selected genre and selected vocal gender',
    'must be vocal song, not instrumental, not soundtrack, not background music'
  ].join(', ');
}

function saveGeneratedSong(task) {
  if (!task.audioUrls?.length || task.saved) return;
  const songs = readJson(SONGS_FILE);
  songs.push({
    id: crypto.randomUUID(),
    userId: task.userId,
    taskId: task.id,
    title: task.title,
    provider: task.provider,
    audioUrls: task.audioUrls,
    payload: task.payload,
    createdAt: new Date().toISOString()
  });
  writeJson(SONGS_FILE, songs);
  task.saved = true;
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

async function queryMurekaTask(providerTaskId) {
  const response = await fetch(`https://api.mureka.ai/v1/song/query/${encodeURIComponent(providerTaskId)}`, {
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
    return sendJson(res, 200, {
      provider,
      ready: provider !== 'demo',
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

  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    return sendJson(res, 200, { user: publicUser(currentUser(req)) });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const name = String(body.name || '').trim() || email.split('@')[0];
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Please enter a valid email.');
    if (password.length < 6) throw new Error('Password must be at least 6 characters.');
    const users = readJson(USERS_FILE);
    if (users.some(user => user.email === email)) throw new Error('Email already registered.');
    const salt = crypto.randomBytes(16).toString('base64');
    const user = {
      id: crypto.randomUUID(),
      email,
      name,
      salt,
      passwordHash: hashPassword(password, salt),
      credits: 40,
      createdAt: new Date().toISOString()
    };
    users.push(user);
    writeJson(USERS_FILE, users);
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { userId: user.id, createdAt: new Date().toISOString() });
    setSessionCookie(res, token);
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const user = readJson(USERS_FILE).find(item => item.email === email);
    if (!user || hashPassword(password, user.salt) !== user.passwordHash) throw new Error('Invalid email or password.');
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { userId: user.id, createdAt: new Date().toISOString() });
    setSessionCookie(res, token);
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const token = parseCookies(req).shenghuoji_session;
    if (token) sessions.delete(token);
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/library') {
    const user = requireUser(req);
    const songs = readJson(SONGS_FILE).filter(song => song.userId === user.id);
    return sendJson(res, 200, { songs });
  }

  if (req.method === 'POST' && url.pathname === '/api/generate') {
    const user = requireUser(req);
    const { body, sampleFile } = await readApiPayload(req);
    const provider = musicProvider();
    if (provider === 'demo') throw new Error('No music API key configured.');
    const raw = provider === 'minimax' ? await callMiniMax(body) : await callMurekaWithReference(body, sampleFile);
    const audioUrls = findAudioUrls(raw);
    const id = crypto.randomUUID();
    const task = {
      id,
      userId: user.id,
      provider,
      providerTaskId: pickProviderTaskId(raw, id),
      status: audioUrls.length ? 'completed' : pickStatus(raw, 'processing'),
      title: String(body.prompt || 'AI Song').slice(0, 28),
      payload: body,
      audioUrls,
      raw,
      saved: false
    };
    tasks.set(id, task);
    saveGeneratedSong(task);
    return sendJson(res, 200, task);
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/tasks/')) {
    const user = requireUser(req);
    const id = decodeURIComponent(url.pathname.replace('/api/tasks/', ''));
    const task = tasks.get(id);
    if (!task) return sendJson(res, 404, { error: 'Task not found' });
    if (task.userId !== user.id) return sendJson(res, 403, { error: 'Forbidden' });
    if (task.provider === 'mureka' && task.providerTaskId && (!task.audioUrls.length || !/complete|success|done|finished/i.test(String(task.status)))) {
      const providerRaw = await queryMurekaTask(task.providerTaskId);
      task.raw = providerRaw;
      task.status = pickStatus(providerRaw, task.status);
      task.audioUrls = findAudioUrls(providerRaw);
      saveGeneratedSong(task);
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
