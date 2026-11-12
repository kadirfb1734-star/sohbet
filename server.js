'use strict';
/*
 * Sohbet sunucusu — bağımlılık yok, sadece Node.js (18+).
 *  - Kayıt / giriş (scrypt ile şifre özeti)
 *  - Mesajlaşma, iletildi / görüldü bilgisi
 *  - Çevrimiçi durumu ve "yazıyor..." bilgisi
 *  - Çoklu cihaz (aynı hesap birden çok yerde açık olabilir)
 *  - Sesli / görüntülü arama için WebRTC sinyalleşmesi
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_TTL = 60 * 24 * 3600 * 1000; // 60 gün

/* ------------------------------------------------------------ veri */
const db = { users: {}, sessions: {}, messages: [] };
try {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  db.users = raw.users || {};
  db.sessions = raw.sessions || {};
  db.messages = raw.messages || [];
} catch (e) { /* ilk çalıştırma */ }

let saveTimer = null;
function saveNow() {
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('Kayıt hatası:', e.message);
  }
}
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 400);
}
process.on('SIGTERM', () => { saveNow(); process.exit(0); });
process.on('SIGINT', () => { saveNow(); process.exit(0); });

// kullanıcı -> sohbet ettiği kişiler
const contactIdx = new Map();
function link(a, b) {
  if (!contactIdx.has(a)) contactIdx.set(a, new Set());
  if (!contactIdx.has(b)) contactIdx.set(b, new Set());
  contactIdx.get(a).add(b);
  contactIdx.get(b).add(a);
}
db.messages.forEach((m) => link(m.from, m.to));

// süresi dolan oturumları temizle
function purgeSessions() {
  const now = Date.now();
  for (const t of Object.keys(db.sessions)) {
    if (now - db.sessions[t].created > SESSION_TTL) delete db.sessions[t];
  }
}
purgeSessions();
setInterval(() => { purgeSessions(); save(); }, 3600 * 1000).unref();

/* ------------------------------------------------- hız sınırlama */
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  let h = hits.get(key);
  if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
  h.n++;
  return h.n > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
}, 60000).unref();

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

/* ---------------------------------------------------- yardımcılar */
const USER_RE = /^[a-z0-9_]{3,20}$/;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function verifyPassword(password, user) {
  const a = Buffer.from(hashPassword(password, user.salt), 'hex');
  const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function newSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { user: username, created: Date.now() };
  save();
  return token;
}
function cleanText(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}
function fail(res, code, message) { json(res, code, { error: message }); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 100 * 1024) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) || {}); }
      catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function auth(req, url) {
  let token = '';
  const h = req.headers['authorization'];
  if (h && h.startsWith('Bearer ')) token = h.slice(7).trim();
  if (!token) token = url.searchParams.get('token') || '';
  const s = db.sessions[token];
  if (!s) return null;
  if (Date.now() - s.created > SESSION_TTL) { delete db.sessions[token]; return null; }
  if (!db.users[s.user]) return null;
  return { user: s.user, token };
}

/* ------------------------------------------- bağlantılar / aktiflik */
const conns = new Map();          // kullanıcı -> Set<{res, device}>
const announced = new Set();      // çevrimiçi ilan edilmiş kullanıcılar
const offlineTimers = new Map();

function isOnline(u) { const s = conns.get(u); return !!s && s.size > 0; }
function presence(u) {
  const usr = db.users[u];
  return { online: announced.has(u), lastSeen: usr ? usr.lastSeen || 0 : 0 };
}
function pushTo(u, event, data) {
  const set = conns.get(u);
  if (!set) return;
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const c of set) { try { c.res.write(payload); } catch (e) { /* kapanmış */ } }
}
function broadcastPresence(u) {
  const p = presence(u);
  const set = contactIdx.get(u);
  if (!set) return;
  for (const other of set) pushTo(other, 'presence', { user: u, online: p.online, lastSeen: p.lastSeen });
}

function pub(m) {
  return { id: m.id, cid: m.cid, from: m.from, to: m.to, text: m.text, kind: m.kind, ts: m.ts, status: m.status };
}

function chatsFor(u) {
  const map = new Map();
  for (const m of db.messages) {
    if (m.from !== u && m.to !== u) continue;
    const o = m.from === u ? m.to : m.from;
    let c = map.get(o);
    if (!c) { c = { user: o, last: null, unread: 0 }; map.set(o, c); }
    c.last = m;
    if (m.to === u && m.status !== 'read') c.unread++;
  }
  return [...map.values()].map((c) => {
    const usr = db.users[c.user];
    const p = presence(c.user);
    return {
      user: c.user,
      name: usr ? usr.name : c.user,
      online: p.online,
      lastSeen: p.lastSeen,
      last: c.last ? pub(c.last) : null,
      unread: c.unread,
    };
  });
}

function iceServers() {
  const list = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  if (process.env.TURN_URL) {
    list.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()).filter(Boolean),
      username: process.env.TURN_USER || '',
      credential: process.env.TURN_PASS || '',
    });
  }
  return list;
}

/* ------------------------------------------------------- akış (SSE) */
function openStream(req, res, url, session) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const me = session.user;
  const conn = { res, device: String(url.searchParams.get('device') || '').slice(0, 20) };
  let set = conns.get(me);
  if (!set) { set = new Set(); conns.set(me, set); }
  set.add(conn);

  clearTimeout(offlineTimers.get(me));
  offlineTimers.delete(me);
  if (!announced.has(me)) {
    announced.add(me);
    broadcastPresence(me);
  }

  res.write('event: hello\ndata: {}\n\n');

  // bekleyen mesajları "iletildi" yap
  const byFrom = new Map();
  for (const m of db.messages) {
    if (m.to === me && m.status === 'sent') {
      m.status = 'delivered';
      if (!byFrom.has(m.from)) byFrom.set(m.from, []);
      byFrom.get(m.from).push(m.id);
    }
  }
  if (byFrom.size) {
    save();
    for (const [from, ids] of byFrom) pushTo(from, 'status', { ids, status: 'delivered', with: me });
  }

  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* */ } }, 20000);
  req.on('close', () => {
    clearInterval(ping);
    set.delete(conn);
    if (set.size === 0) {
      clearTimeout(offlineTimers.get(me));
      offlineTimers.set(me, setTimeout(() => {
        offlineTimers.delete(me);
        if (!isOnline(me)) {
          announced.delete(me);
          if (db.users[me]) db.users[me].lastSeen = Date.now();
          save();
          broadcastPresence(me);
        }
      }, 5000));
    }
  });
}

/* ------------------------------------------------------ API işleyici */
async function handleApi(req, res, url) {
  const route = url.pathname;
  const method = req.method;

  // ---- kayıt
  if (route === '/api/register' && method === 'POST') {
    if (limited('reg|' + clientIp(req), 10, 3600 * 1000)) return fail(res, 429, 'Çok fazla deneme. Biraz sonra tekrar dene.');
    const b = await readBody(req);
    const username = String(b.username || '').trim().toLowerCase();
    const password = String(b.password || '');
    if (!USER_RE.test(username)) return fail(res, 400, 'Kullanıcı adı 3-20 karakter olmalı; sadece küçük harf (a-z), rakam ve _ kullan.');
    if (password.length < 6 || password.length > 100) return fail(res, 400, 'Şifre en az 6 karakter olmalı.');
    if (db.users[username]) return fail(res, 409, 'Bu kullanıcı adı alınmış, başka bir tane dene.');
    const salt = crypto.randomBytes(16).toString('hex');
    db.users[username] = {
      username,
      name: cleanText(b.name, 30) || username,
      salt,
      hash: hashPassword(password, salt),
      created: Date.now(),
      lastSeen: 0,
    };
    save();
    return json(res, 200, { token: newSession(username) });
  }

  // ---- giriş
  if (route === '/api/login' && method === 'POST') {
    const b = await readBody(req);
    const username = String(b.username || '').trim().toLowerCase();
    if (limited('login|' + clientIp(req) + '|' + username, 15, 600 * 1000)) return fail(res, 429, 'Çok fazla deneme. 10 dakika sonra tekrar dene.');
    const user = db.users[username];
    if (!user || !verifyPassword(String(b.password || ''), user)) return fail(res, 401, 'Kullanıcı adı veya şifre hatalı.');
    return json(res, 200, { token: newSession(username) });
  }

  // ---- genel ayar (kimlik gerekmez)
  if (route === '/api/config' && method === 'GET') {
    return json(res, 200, { iceServers: iceServers() });
  }

  // ---- bundan sonrası giriş ister
  const s = auth(req, url);
  if (!s) return fail(res, 401, 'Oturum geçersiz.');
  const me = s.user;

  if (route === '/api/stream' && method === 'GET') return openStream(req, res, url, s);

  if (route === '/api/logout' && method === 'POST') {
    delete db.sessions[s.token];
    save();
    return json(res, 200, { ok: true });
  }

  if (route === '/api/me' && method === 'GET') {
    const u = db.users[me];
    return json(res, 200, { user: { username: me, name: u.name }, chats: chatsFor(me) });
  }

  if (route === '/api/user' && method === 'GET') {
    const name = String(url.searchParams.get('u') || '').toLowerCase();
    const u = db.users[name];
    if (!u) return fail(res, 404, 'Kullanıcı bulunamadı.');
    const p = presence(name);
    return json(res, 200, { username: name, name: u.name, online: p.online, lastSeen: p.lastSeen });
  }

  if (route === '/api/search' && method === 'GET') {
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    if (q.length < 3) return json(res, 200, { users: [] });
    const out = [];
    for (const name of Object.keys(db.users)) {
      if (name === me || !name.startsWith(q)) continue;
      const p = presence(name);
      out.push({ username: name, name: db.users[name].name, online: p.online, lastSeen: p.lastSeen });
      if (out.length >= 10) break;
    }
    return json(res, 200, { users: out });
  }

  if (route === '/api/history' && method === 'GET') {
    const w = String(url.searchParams.get('with') || '').toLowerCase();
    const list = [];
    for (const m of db.messages) {
      if ((m.from === me && m.to === w) || (m.from === w && m.to === me)) list.push(pub(m));
    }
    return json(res, 200, { messages: list.slice(-400) });
  }

  if (route === '/api/send' && method === 'POST') {
    if (limited('send|' + me, 120, 60 * 1000)) return fail(res, 429, 'Çok hızlı mesaj gönderiyorsun.');
    const b = await readBody(req);
    const to = String(b.to || '').toLowerCase();
    if (!db.users[to] || to === me) return fail(res, 400, 'Alıcı bulunamadı.');
    const text = String(b.text == null ? '' : b.text).replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
    if (!text || text.length > 4000) return fail(res, 400, 'Mesaj boş ya da çok uzun.');
    const m = {
      id: crypto.randomBytes(8).toString('hex'),
      cid: String(b.cid || '').slice(0, 40),
      from: me,
      to,
      text,
      kind: b.kind === 'call' ? 'call' : 'text',
      ts: Date.now(),
      status: isOnline(to) ? 'delivered' : 'sent',
    };
    db.messages.push(m);
    link(me, to);
    save();
    const payload = { msg: pub(m), name: db.users[me].name };
    pushTo(to, 'msg', payload);
    pushTo(me, 'msg', payload);
    return json(res, 200, { msg: pub(m) });
  }

  if (route === '/api/read' && method === 'POST') {
    const b = await readBody(req);
    const w = String(b.with || '').toLowerCase();
    const ids = [];
    for (let i = db.messages.length - 1; i >= 0; i--) {
      const m = db.messages[i];
      if (m.from === w && m.to === me && m.status !== 'read') { m.status = 'read'; ids.push(m.id); }
    }
    if (ids.length) { save(); pushTo(w, 'status', { ids, status: 'read', with: me }); }
    pushTo(me, 'readsync', { with: w });
    return json(res, 200, { ok: true });
  }

  if (route === '/api/typing' && method === 'POST') {
    const b = await readBody(req);
    const to = String(b.to || '').toLowerCase();
    if (db.users[to] && to !== me) pushTo(to, 'typing', { from: me });
    return json(res, 200, { ok: true });
  }

  if (route === '/api/signal' && method === 'POST') {
    if (limited('sig|' + me, 400, 60 * 1000)) return fail(res, 429, 'Çok fazla istek.');
    const b = await readBody(req);
    const to = String(b.to || '').toLowerCase();
    const d = b.data;
    const okTypes = ['offer', 'answer', 'ice', 'hangup', 'reject', 'busy', 'taken'];
    if (!db.users[to] || !d || okTypes.indexOf(d.type) < 0) return fail(res, 400, 'Geçersiz sinyal.');
    if (JSON.stringify(d).length > 20000) return fail(res, 400, 'Sinyal çok büyük.');
    pushTo(to, 'signal', { from: me, data: d });
    return json(res, 200, { ok: true });
  }

  return fail(res, 404, 'Bulunamadı.');
}

/* ------------------------------------------------------ statik dosya */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Bulunamadı'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'microphone=(self), camera=(self)',
    });
    res.end(buf);
  });
}

/* ------------------------------------------------------------ sunucu */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    if (!res.headersSent) fail(res, e && e.message === 'too large' ? 413 : 400, 'Geçersiz istek.');
    else try { res.end(); } catch (x) { /* */ }
  }
});
server.keepAliveTimeout = 65000;

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('Sohbet çalışıyor: http://localhost:' + PORT);
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const n of nets[name] || []) {
        if (n.family === 'IPv4' && !n.internal) console.log('Aynı Wi-Fi\'daki telefon/bilgisayar: http://' + n.address + ':' + PORT);
      }
    }
  });
}
module.exports = { server, db };
