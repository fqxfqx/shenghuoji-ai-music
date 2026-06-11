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
  if (/男女|对唱|duet/i.test(voiceType)) return 'male and female duet vocals';
  if (/男|male/i.test(voiceType)) return /低沉|磁性/.test(voiceType) ? 'deep male vocal' : 'male vocal';
  if (/儿童|child/i.test(voiceType)) return 'childlike vocal';
  if (/多人|合唱|choir/i.test(voiceType)) return 'group choir vocals';
  return /温柔/.test(voiceType) ? 'soft female vocal' : 'female vocal';
}

function buildMurekaPrompt(payload) {
  const style = String(payload.style || '中文流行').trim();
  const mood = String(payload.mood || '真诚温暖').trim();
  const usecase = String(payload.usecase || '生活写歌').trim();
  const voiceType = String(payload.voiceType || '自然中文人声').trim();
  const styleInfluence = Number(payload.styleInfluence || 70);
  const userPrompt = String(payload.prompt || '为普通人的生活故事写一首中文歌曲').trim();
  const voicePrompt = murekaVoicePrompt(voiceType);
  return [
    `${style}, ${mood}, ${voicePrompt}`,
    'Mandarin Chinese pop song with clear lead sung vocals',
    'full song, verse and chorus, radio-ready mix',
    `style influence ${styleInfluence} percent`,
    `use case: ${usecase}`,
    `user direction: ${userPrompt}`,
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

async function callMureka(payload) {
  if (!process.env.MUREKA_API_KEY) throw new Error('MUREKA_API_KEY is missing.');
  const model = process.env.MUREKA_MODEL || 'auto';
  const lyrics = normalizeLyrics(payload);
  const response = await fetch('https://api.mureka.ai/v1/song/generate', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.MUREKA_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      lyrics,
      prompt: buildMurekaPrompt(payload)
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || data.message || 'Mureka request failed');
  return data;
}

async function queryMurekaTask(providerTaskId) {
  if (!process.env.MUREKA_API_KEY) throw new Error('MUREKA_API_KEY is missing.');
  const response = await fetch(`https://api.mureka.ai/v1/song/query/${encodeURIComponent(providerTaskId)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${process.env.MUREKA_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || data.message || 'Mureka query failed');
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
    const body = await readBody(req);
    const provider = musicProvider();
    if (provider === 'demo') throw new Error('No music API key configured.');
    const raw = provider === 'minimax' ? await callMiniMax(body) : await callMureka(body);
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
