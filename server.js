'use strict';
// right now. — tiny zero-dependency backend: JSON file for data, photos on disk.
const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');
const KEEP_DAYS = 35;
const MAX_PHOTO = 5 * 1024 * 1024;
const MAX_JSON = 16 * 1024;
const EMOJI = new Set(['😂', '😍', '😮', '🔥', '👍']);
const COOKIE = 'rn_token';
const DAY = 86400000;

/* ---------- storage ---------- */
fs.mkdirSync(PHOTO_DIR, { recursive: true });
let db = { users: {}, tokens: {}, photos: {}, days: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; }
catch (e) { if (e.code !== 'ENOENT') throw e; }

let saving = null, dirty = false;
function save() { dirty = true; if (!saving) saving = flush(); }
async function flush() {
  try {
    while (dirty) {
      dirty = false;
      const tmp = DB_FILE + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(db));
      await fsp.rename(tmp, DB_FILE);
    }
  } catch (e) { console.error('save failed', e); }
  saving = null;
}

const photoPath = id => path.join(PHOTO_DIR, id + '.jpg');
function deletePhoto(id) {
  if (!id || !db.photos[id]) return;
  delete db.photos[id];
  fsp.unlink(photoPath(id)).catch(() => {});
}
function getDay(key, create) {
  if (!db.days[key] && create) db.days[key] = { momentAt: null, posts: {}, comments: [] };
  return db.days[key] || null;
}

/* ---------- helpers ---------- */
const randomId = (n = 16) => crypto.randomBytes(n).toString('hex');
const hashToken = t => crypto.createHash('sha256').update(t).digest('hex');
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const PHOTO_ID = /^[a-f0-9]{32}$/;
const dayMs = k => Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10));
const utcKey = ms => new Date(ms).toISOString().slice(0, 10);
// Day keys come from the viewer's local calendar, so allow a day either side of UTC.
const isCurrentDay = k => Math.abs(dayMs(k) - dayMs(utcKey(Date.now()))) <= DAY;
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function send(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
class HttpError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const fail = (status, code) => { throw new HttpError(status, code); };

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  try { return JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}'); }
  catch (e) { if (e instanceof HttpError) throw e; fail(400, 'bad_json'); }
}
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function currentUser(req) {
  const t = cookies(req)[COOKIE];
  const uid = t && db.tokens[hashToken(t)];
  return uid && db.users[uid] ? { id: uid, ...db.users[uid] } : null;
}
function cookieHeader(req, value, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
const publicUser = u => ({ id: u.id, name: u.name, editor: !!u.editor });

/* ---------- routes ---------- */
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  const m = req.method;

  if (m === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = await fsp.readFile(INDEX_FILE);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(html);
  }
  if (m === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });

  if (url.pathname === '/api/me' && m === 'GET') {
    const u = currentUser(req);
    if (!u) return send(res, 401, { error: 'signed_out', passwordRequired: !!APP_PASSWORD, adminEnabled: !!ADMIN_PASSWORD });
    return send(res, 200, { user: publicUser(u) });
  }
  if (url.pathname === '/api/join' && m === 'POST') {
    const { name, password = '' } = await readJson(req);
    const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    if (!clean) fail(400, 'name_required');
    const editor = !!ADMIN_PASSWORD && safeEqual(password, ADMIN_PASSWORD);
    if (APP_PASSWORD && !editor && !safeEqual(password, APP_PASSWORD)) fail(403, 'wrong_password');
    if (!APP_PASSWORD && password && !editor) fail(403, 'wrong_password');
    const id = randomId(), token = randomId(32);
    db.users[id] = { name: clean, editor, createdAt: Date.now() };
    db.tokens[hashToken(token)] = id;
    save();
    return send(res, 200, { user: publicUser({ id, ...db.users[id] }) }, { 'Set-Cookie': cookieHeader(req, token, 400 * 86400) });
  }
  if (url.pathname === '/api/logout' && m === 'POST') {
    const t = cookies(req)[COOKIE];
    if (t && db.tokens[hashToken(t)]) { delete db.tokens[hashToken(t)]; save(); }
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, '', 0) });
  }

  // Everything below needs a signed-in user.
  const isApi = parts[0] === 'api', isPhoto = parts[0] === 'photos' && parts.length === 2;
  if (!isApi && !isPhoto) return send(res, 404, { error: 'not_found' });
  const me = currentUser(req);
  if (!me) fail(401, 'signed_out');

  if (isPhoto && m === 'GET') {
    const id = parts[1].replace(/\.jpg$/, '');
    if (!PHOTO_ID.test(id) || !db.photos[id]) fail(404, 'not_found');
    const data = await fsp.readFile(photoPath(id)).catch(() => fail(404, 'not_found'));
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable' });
    return res.end(data);
  }

  if (url.pathname === '/api/photos' && m === 'POST') {
    const buf = await readBody(req, MAX_PHOTO);
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) fail(400, 'not_jpeg');
    const id = randomId();
    await fsp.writeFile(photoPath(id), buf);
    db.photos[id] = { owner: me.id, at: Date.now(), used: false };
    save();
    return send(res, 200, { id });
  }

  if (parts[1] === 'day' && parts[2]) {
    const key = parts[2], action = parts[3] || '';
    if (!DAY_KEY.test(key)) fail(400, 'bad_day');

    if (!action && m === 'GET') {
      const d = getDay(key, false) || { momentAt: null, posts: {}, comments: [] };
      const ids = new Set([...Object.keys(d.posts), ...d.comments.map(c => c.uid)]);
      const users = {};
      ids.forEach(id => { if (db.users[id]) users[id] = { name: db.users[id].name }; });
      return send(res, 200, { day: d.momentAt ? { momentAt: d.momentAt } : null, posts: d.posts, comments: d.comments, users });
    }
    if (action === 'drop' && m === 'POST') {
      if (!me.editor) fail(403, 'not_editor');
      if (!isCurrentDay(key)) fail(400, 'bad_day');
      getDay(key, true).momentAt = Date.now();
      save();
      return send(res, 200, { ok: true });
    }
    if (action === 'post' && m === 'POST') {
      if (!isCurrentDay(key)) fail(400, 'bad_day');
      const b = await readJson(req);
      const d = getDay(key, true);
      if (d.posts[me.id]) fail(409, 'already_posted');
      const own = id => typeof id === 'string' && db.photos[id] && db.photos[id].owner === me.id && !db.photos[id].used;
      if (!own(b.back)) fail(400, 'bad_photo');
      if (b.front != null && (!own(b.front) || b.front === b.back)) fail(400, 'bad_photo');
      const momentAt = Number(b.momentAt);
      d.posts[me.id] = {
        uid: me.id, back: b.back, front: b.front || null,
        caption: String(b.caption || '').trim().slice(0, 120),
        postedAt: Date.now(),
        momentAt: Number.isFinite(momentAt) ? momentAt : Date.now(),
        retakes: Math.max(0, Math.min(99, parseInt(b.retakes, 10) || 0)),
        reactions: {}
      };
      db.photos[b.back].used = true;
      if (b.front) db.photos[b.front].used = true;
      save();
      return send(res, 200, { ok: true });
    }
    if (action === 'post' && m === 'DELETE') {
      const d = getDay(key, false), p = d && d.posts[me.id];
      if (!p) fail(404, 'not_found');
      delete d.posts[me.id];
      d.comments = d.comments.filter(c => c.postUid !== me.id);
      deletePhoto(p.back); deletePhoto(p.front);
      save();
      return send(res, 200, { ok: true });
    }
    if (action === 'react' && m === 'POST') {
      const { postUid, emoji } = await readJson(req);
      const d = getDay(key, false), p = d && d.posts[postUid];
      if (!p) fail(404, 'not_found');
      if (emoji == null) delete p.reactions[me.id];
      else if (EMOJI.has(emoji)) p.reactions[me.id] = emoji;
      else fail(400, 'bad_emoji');
      save();
      return send(res, 200, { ok: true });
    }
    if (action === 'comment' && m === 'POST') {
      const { postUid, text } = await readJson(req);
      const d = getDay(key, false);
      if (!d || !d.posts[postUid]) fail(404, 'not_found');
      const clean = String(text || '').trim().slice(0, 300);
      if (!clean) fail(400, 'empty');
      if (d.comments.length >= 500) fail(429, 'quota_exceeded');
      d.comments.push({ id: randomId(8), postUid, uid: me.id, text: clean, at: Date.now() });
      save();
      return send(res, 200, { ok: true });
    }
  }
  fail(404, 'not_found');
}

/* ---------- cleanup: old days and photos that were never posted ---------- */
function prune() {
  const cutoff = utcKey(Date.now() - KEEP_DAYS * DAY);
  let changed = false;
  for (const key of Object.keys(db.days)) {
    if (key >= cutoff) continue;
    for (const p of Object.values(db.days[key].posts)) { deletePhoto(p.back); deletePhoto(p.front); }
    delete db.days[key]; changed = true;
  }
  for (const [id, ph] of Object.entries(db.photos)) {
    if (!ph.used && Date.now() - ph.at > DAY) { deletePhoto(id); changed = true; }
  }
  if (changed) save();
}
prune();
setInterval(prune, 6 * 3600 * 1000).unref();

http.createServer((req, res) => {
  handle(req, res).catch(e => {
    if (!(e instanceof HttpError)) console.error(e);
    if (res.headersSent) return res.end();
    send(res, e.status || 500, { error: e.code || 'server_error' });
  });
}).listen(PORT, () => console.log(`right now. listening on :${PORT}, data in ${DATA_DIR}`));

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { if (saving) await saving; process.exit(0); });
