'use strict';
/*
 * Sync Stream — one file, zero dependencies.
 * Everyone in a room hears/sees the same media at the same position, from any device.
 * State is server-authoritative: the server publishes {posMs, anchor, playing} where
 * `anchor` is the server clock (epoch ms) at which `posMs` was true, so every client
 * derives the same target position regardless of its own clock or network latency.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8080', 10);
const MEDIA_DIR = process.env.MEDIA_DIR || '/media';
const DATA_DIR = process.env.DATA_DIR || '/data';
const DUR_FILE = path.join(MEDIA_DIR, '.syncstream-durations.json');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const MAX_UPLOAD = parseInt(process.env.MAX_UPLOAD_BYTES || String(4 * 1024 * 1024 * 1024), 10);

// ----------------------------------------------------------------------------- access gate
// Site-wide shared words, not per room: any one of them opens everything (page and api). Two
// sources, in order: SYNC_PASSWORDS (env) and SYNC_PASSWORDS_FILE (a mounted file, one word per
// line or comma separated). Set neither and the site is open.
const PASS_FILE = process.env.SYNC_PASSWORDS_FILE || '';
let PASSWORDS = (process.env.SYNC_PASSWORDS || '')
  .split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
if (!PASSWORDS.length && PASS_FILE) {
  try {
    PASSWORDS = fs.readFileSync(PASS_FILE, 'utf8').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    if (!PASSWORDS.length) throw new Error('file is empty');
  } catch (e) {
    // Configured but unusable: fail CLOSED with a word nobody knows, rather than silently
    // turning a private stream into a public one.
    console.error('[sync-stream] cannot use ' + PASS_FILE + ' (' + ((e && e.message) || e) +
                  ') — locking the site until this is fixed');
    PASSWORDS = ['locked-' + crypto.randomBytes(12).toString('hex')];
  }
}
const GATE = PASSWORDS.length > 0;
const AUTH_COOKIE = 'ss_auth';
// Derived, so it survives a redeploy (nobody is logged out) but changes the moment the words do.
const AUTH_TOKEN = crypto.createHash('sha256')
  .update('syncstream-v1|' + PASSWORDS.join('\u0000')).digest('hex').slice(0, 32);
const loginFails = new Map();   // ip -> [timestamps]

function cookieValue(req, name) {
  const h = req.headers.cookie;
  if (!h) return '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return ''; }
    }
  }
  return '';
}
function sameText(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function isAuthed(req) {
  if (!GATE) return true;
  const v = cookieValue(req, AUTH_COOKIE);
  return sameText(v, AUTH_TOKEN);
}

const AUDIO_EXT = ['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.flac'];
const VIDEO_EXT = ['.mp4', '.m4v', '.mov', '.mkv', '.ogv', '.webm'];
const AUDIO_MIME = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac',
};
const VIDEO_MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.ogv': 'video/ogg', '.webm': 'video/webm',
};
const MIME = Object.assign({}, AUDIO_MIME, VIDEO_MIME);

// ----------------------------------------------------------------------------- durations
let durations = {};
try { durations = JSON.parse(fs.readFileSync(DUR_FILE, 'utf8')) || {}; } catch (e) { durations = {}; }
let durSaveTimer = null;
function saveDurations() {
  if (durSaveTimer) return;
  durSaveTimer = setTimeout(() => {
    durSaveTimer = null;
    const tmp = DUR_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(durations), (e) => {
      if (!e) fs.rename(tmp, DUR_FILE, () => {});
    });
  }, 1500);
}

// ----------------------------------------------------------------------------- rooms
// A room is a station with a name, and the registry is persisted: rooms (and what each is playing)
// survive a redeploy, with the playhead fast-forwarded by however long the server was down. It is
// a few hundred bytes of JSON — deliberately not a database.
const rooms = new Map();
let roomsSaveTimer = null;

function slugRoom(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}

function getRoom(id) {
  let r = rooms.get(id);
  if (!r) {
    const now = Date.now();
    r = { id, mediaId: null, playing: false, posMs: 0, anchor: now, gen: 0, actor: '', action: '',
          volume: 1, clients: new Set(), updatedAt: now, lastActive: now };
    rooms.set(id, r);
    saveRooms();
  }
  return r;
}
function posOf(r, now) {
  return r.playing ? Math.max(0, r.posMs + (now - r.anchor)) : r.posMs;
}
function payload(r) {
  return {
    room: r.id, mediaId: r.mediaId, playing: r.playing, posMs: r.posMs, anchor: r.anchor,
    gen: r.gen, actor: r.actor, action: r.action, listeners: r.clients.size,
    volume: typeof r.volume === 'number' ? r.volume : 1,
    talking: talking(r),
    talker: r.talker || '',
    serverNow: Date.now(),
  };
}
function broadcast(r) {
  const frame = 'data: ' + JSON.stringify(payload(r)) + '\n\n';
  for (const c of r.clients) { try { c.write(frame); } catch (e) { /* dropped below */ } }
  saveRooms();
}

function saveRooms() {
  if (roomsSaveTimer) return;
  roomsSaveTimer = setTimeout(() => {
    roomsSaveTimer = null;
    const now = Date.now();
    const out = [];
    for (const r of rooms.values()) {
      const lastActive = r.lastActive || r.updatedAt || now;
      // A station nobody has touched for a week, with nothing queued, is not worth remembering.
      if (!r.mediaId && !r.clients.size && now - lastActive > 7 * 24 * 3600 * 1000) {
        rooms.delete(r.id);
        continue;
      }
      out.push({ id: r.id, mediaId: r.mediaId, playing: r.playing, posMs: posOf(r, now),
                 volume: typeof r.volume === 'number' ? r.volume : 1,
                 savedAt: now, lastActive: lastActive });
    }
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = ROOMS_FILE + '.tmp';
      fs.writeFile(tmp, JSON.stringify(out), () => fs.rename(tmp, ROOMS_FILE, () => {}));
    } catch (e) { /* room state is a nicety, never a guarantee */ }
  }, 1200);
}

function loadRooms() {
  let saved = [];
  try { saved = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8')) || []; } catch (e) { return; }
  const now = Date.now();
  let n = 0;
  for (const s of saved) {
    if (!s || !s.id || rooms.has(s.id)) continue;
    const down = Math.max(0, now - (s.savedAt || now));
    rooms.set(s.id, {
      id: s.id, mediaId: s.mediaId || null, playing: !!s.playing,
      // a station keeps playing while the server is down: fast-forward by the downtime. If that
      // lands past the end of the track the 1 s tick simply rolls it on to the next one.
      posMs: (s.posMs || 0) + (s.playing ? down : 0), anchor: now, gen: 0, actor: '', action: '',
      volume: typeof s.volume === 'number' ? s.volume : 1,
      clients: new Set(), updatedAt: s.lastActive || now, lastActive: s.lastActive || now,
    });
    n++;
  }
  if (n) console.log('[sync-stream] restored ' + n + ' room(s) from ' + ROOMS_FILE);
}

async function roomsList() {
  const list = await mediaList(1500);
  const now = Date.now();
  return [...rooms.values()]
    // A leading underscore marks a room as disposable (the test suites use them), so they never
    // clutter the list a listener sees.
    .filter((r) => !r.id.startsWith('_'))
    .filter((r) => r.mediaId || r.clients.size || (now - (r.lastActive || 0)) < 24 * 3600 * 1000)
    .map((r) => {
      const m = list.find((x) => x.id === r.mediaId);
      return {
        id: r.id, mediaId: r.mediaId, track: m ? m.name : null, type: m ? m.type : null,
        playing: r.playing, listeners: r.clients.size, posMs: posOf(r, now),
        durationMs: m ? m.durationMs : null, lastActive: r.lastActive || r.updatedAt || 0,
      };
    })
    .sort((a, b) => (b.listeners - a.listeners) || (b.lastActive - a.lastActive));
}

// ----------------------------------------------------------------------------- media
let mediaCache = { at: 0, list: [] };
let durMtime = -1;

// Durations can be written by a client (first play), by the host-side probe script, or both.
// Re-reading on mtime change means a scan on the host shows up without restarting the server.
function reloadDurations() {
  try {
    const st = fs.statSync(DUR_FILE);
    if (st.mtimeMs !== durMtime) {
      durations = JSON.parse(fs.readFileSync(DUR_FILE, 'utf8')) || {};
      durMtime = st.mtimeMs;
    }
  } catch (e) { /* not written yet */ }
}

async function mediaListFresh() {
  let files;
  try { files = await fs.promises.readdir(MEDIA_DIR); }
  catch (e) { return []; }
  const out = [];
  for (const f of files) {
    if (f.startsWith('.')) continue;
    const ext = path.extname(f).toLowerCase();
    const type = AUDIO_EXT.includes(ext) ? 'audio' : (VIDEO_EXT.includes(ext) ? 'video' : null);
    if (!type) continue;
    let st;
    try { st = await fs.promises.stat(path.join(MEDIA_DIR, f)); } catch (e) { continue; }
    if (!st.isFile()) continue;
    out.push({
      id: f, name: path.basename(f, ext), file: f, type, ext,
      mime: MIME[ext] || 'application/octet-stream', size: st.size, mtimeMs: st.mtimeMs,
      // Media files are deliberately NOT behind the gate (Wan's call): the page and the API are
      // what is protected, so a copied media URL is harmless. This also lets the edge cache them,
      // which spares the origin the bandwidth on every replay.
      url: '/media/' + encodeURIComponent(f),
      durationMs: durations[f] || null,
    });
  }
  out.sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true, sensitivity: 'base' }));
  return out;
}

// maxAgeMs > 0 reuses the previous listing (the 1 s tick does not need to stat the directory).
async function mediaList(maxAgeMs) {
  reloadDurations();
  const now = Date.now();
  if (maxAgeMs && mediaCache.list.length && now - mediaCache.at < maxAgeMs) {
    return mediaCache.list.map((m) => ((durations[m.id] || null) === m.durationMs
      ? m : Object.assign({}, m, { durationMs: durations[m.id] || null })));
  }
  const list = await mediaListFresh();
  mediaCache = { at: Date.now(), list };
  return list;
}

// ----------------------------------------------------------------------------- helpers
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function text(res, code, s) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function roomIdOf(u) {
  let raw = u.searchParams.get('room') || '';
  if (!raw && u.pathname.startsWith('/r/')) {
    try { raw = decodeURIComponent(u.pathname.slice(3).split('/')[0]); } catch (e) { raw = ''; }
  }
  return slugRoom(raw) || 'main';
}

// ----------------------------------------------------------------------------- control
async function handleControl(r, body) {
  const a = String(body.action || '');
  const now = Date.now();
  const actor = String(body.actor || 'someone').slice(0, 24);

  if (a === 'meta') {
    const id = String(body.mediaId || '');
    const d = Number(body.durationMs);
    if (id && durations[id] !== undefined && isFinite(d) && d > 1000 && Math.abs(durations[id] - d) < 2000) {
      return { ok: true, silent: true };
    }
    if (id && isFinite(d) && d > 1000 && durations[id] === undefined) {
      durations[id] = Math.round(d);
      saveDurations();
      broadcast(r);
    }
    return { ok: true, silent: true };
  }

  if (a === 'volume') {
    // A room-wide volume, so "turn it down" means the same thing on every device. Deliberately
    // does NOT bump gen: a volume step must never make anyone seek.
    const v = Number(body.volume);
    if (!isFinite(v)) return { ok: false, error: 'bad volume' };
    r.volume = Math.min(1, Math.max(0, v));
    r.actor = actor; r.action = 'volume'; r.updatedAt = now; r.lastActive = now;
    broadcast(r);
    return { ok: true, silent: true };
  }

  if (a === 'ended') {
    if (body.mediaId && body.mediaId !== r.mediaId) return { ok: true, silent: true };
    const list = await mediaList();
    const i = list.findIndex((m) => m.id === r.mediaId);
    if (i >= 0 && list.length > 1) {
      const n = list[(i + 1) % list.length];
      r.mediaId = n.id; r.posMs = 0; r.anchor = now; r.playing = true; r.action = 'next';
    } else {
      r.posMs = posOf(r, now); r.playing = false; r.anchor = now; r.action = 'end';
    }
    r.actor = actor;
  } else if (a === 'play') {
    if (!r.playing) { r.posMs = posOf(r, now); r.playing = true; r.anchor = now; }
    else return { ok: true, silent: true };
    r.actor = actor; r.action = 'play';
  } else if (a === 'pause') {
    if (r.playing) { r.posMs = posOf(r, now); r.playing = false; r.anchor = now; }
    else return { ok: true, silent: true };
    r.actor = actor; r.action = 'pause';
  } else if (a === 'seek') {
    const p = Math.max(0, Math.round(Number(body.posMs) || 0));
    if (!r.mediaId) return { ok: false, error: 'no media' };
    r.posMs = p; r.anchor = now; r.actor = actor; r.action = 'seek';
  } else if (a === 'select') {
    const list = await mediaList();
    const item = list.find((m) => m.id === body.mediaId);
    if (!item) return { ok: false, error: 'media not found' };
    r.mediaId = item.id; r.posMs = 0; r.anchor = now; r.playing = true;
    r.actor = actor; r.action = 'select';
  } else if (a === 'next' || a === 'prev') {
    const list = await mediaList();
    if (!list.length) return { ok: false, error: 'no media' };
    let i = list.findIndex((m) => m.id === r.mediaId);
    if (i < 0) i = 0;
    const step = a === 'next' ? 1 : -1;
    const n = list[(i + step + list.length) % list.length];
    r.mediaId = n.id; r.posMs = 0; r.anchor = now; r.playing = true;
    r.actor = actor; r.action = a;
  } else {
    return { ok: false, error: 'unknown action' };
  }

  r.gen++; r.updatedAt = now; r.lastActive = now;
  broadcast(r);
  return { ok: true };
}

// ----------------------------------------------------------------------------- autonomous timeline
// A room's clock must never depend on anyone being connected. If the only listener closes their
// browser — or Android kills a backgrounded tab — nothing reports "track ended" and the stream
// would sit frozen at the end of the song until someone reopened it. So the server advances the
// playlist by itself, for every room, listeners or not.
async function advanceRoom(r, now, actor) {
  const list = await mediaList(1500);
  if (!list.length) {
    r.posMs = posOf(r, now); r.playing = false; r.anchor = now;
    r.action = 'end'; r.actor = actor; r.gen++; r.updatedAt = now;
    broadcast(r);
    return false;
  }
  let i = list.findIndex((m) => m.id === r.mediaId);
  const n = list[(i + 1 + list.length) % list.length];   // wraps; one file loops forever
  r.mediaId = n.id; r.posMs = 0; r.anchor = now; r.playing = true;
  r.action = 'next'; r.actor = actor; r.gen++; r.updatedAt = now; r.lastActive = now;
  broadcast(r);
  return true;
}

let ticking = false;
async function tickRooms() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    const list = await mediaList(1000);
    const byId = new Map(list.map((m) => [m.id, m]));
    // A talk session that stopped sending (phone lost signal, browser killed) must not leave every
    // listener ducked forever.
    for (const r of rooms.values()) {
      if (r.talkUntil && now > r.talkUntil) endTalk(r, now);
    }
    for (const r of rooms.values()) {
      if (!r.playing || !r.mediaId) continue;
      const m = byId.get(r.mediaId);
      const dur = (m && m.durationMs) || durations[r.mediaId] || 0;
      if (!dur) continue;                       // duration unknown: nothing to schedule against
      // With someone listening, the client's own 'ended' event is the exact end of the track and
      // fires first — so the server only steps in 2 s later, as a rescue for a frozen/backgrounded
      // tab. With nobody listening there is nothing to be exact for, so it rolls straight on.
      const grace = r.clients.size ? 2000 : 0;
      if (posOf(r, now) >= dur + grace) await advanceRoom(r, now, 'auto');
    }
  } catch (e) {
    console.error('[sync-stream] tick:', (e && e.message) || e);
  } finally {
    ticking = false;
  }
}
setInterval(tickRooms, 1000);

// ----------------------------------------------------------------------------- DJ talk
// Push-to-talk: the DJ's browser captures PCM and posts a ~340 ms batch; the server relays each
// batch to every listener in the room as an SSE `talk` event and marks the room as "talking", which
// is what makes every device duck the music. Raw PCM (no codec) is the one format every browser can
// decode — Web Audio plays it back on iOS, Android and desktop alike.
const TALK_RATE = 12000;
const TALK_MAX = 256 * 1024;

function talking(r, now) {
  return !!(r.talkUntil && r.talkUntil > (now || Date.now()));
}
function broadcastTalk(r, seq, pcmB64, fromCid) {
  const frame = 'event: talk\ndata: ' + JSON.stringify({ seq: seq, rate: TALK_RATE, pcm: pcmB64 }) + '\n\n';
  for (const c of r.clients) {
    // Never relay audio back to the device it came from: the talker must not hear their own voice
    // (the mic is already routed nowhere locally; this is the other half of that).
    if (fromCid && c.cid === fromCid) continue;
    try { c.write(frame); } catch (e) { /* dropped */ }
  }
}
function endTalk(r, now) {
  if (!r.talkUntil) return false;
  r.talkUntil = 0;
  r.talker = '';
  r.updatedAt = now;
  broadcast(r);
  return true;
}

async function handleTalk(req, res, roomId) {
  const now = Date.now();
  const r = getRoom(roomId);
  const who = String((new URL(req.url, 'http://x')).searchParams.get('actor') || 'dj').slice(0, 24);
  const body = await readBody(req, TALK_MAX);
  if (req.headers['x-talking'] === '0') {
    endTalk(r, now);
    return json(res, 200, { ok: true, talking: false });
  }
  if (!body.length) return json(res, 400, { ok: false, error: 'empty' });
  const wasTalking = talking(r, now);
  r.talkUntil = now + 3500;      // a session expires on its own if the DJ's phone drops off
  r.talker = who;
  r.lastActive = now;
  if (!wasTalking) broadcast(r);  // ducks everyone's music the moment the DJ starts
  broadcastTalk(r, Number(req.headers['x-seq'] || 0), body.toString('base64'),
                String(req.headers['x-cid'] || ''));
  return json(res, 200, { ok: true, talking: true, bytes: body.length });
}

// ----------------------------------------------------------------------------- the gate
function authCookie(req, value, maxAge) {
  // Secure only when the request actually arrived over TLS — otherwise login silently fails for
  // anyone self-hosting on http://localhost or a LAN address (the browser refuses to store it).
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = proto === 'https' || !!(req.socket && req.socket.encrypted);
  return AUTH_COOKIE + '=' + value + '; Path=/; Max-Age=' + maxAge + '; HttpOnly; SameSite=Lax' +
         (secure ? '; Secure' : '');
}

function redirect(res, to) {
  res.writeHead(302, { location: to, 'cache-control': 'no-store' });
  res.end();
}

function loginPage(next, err) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Sync Stream</title>
<style>
  :root{--bg:#0b0d12;--panel:#141822;--line:#242c3d;--fg:#e8ecf4;--dim:#8b96ad;--acc:#5ee0a0}
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;background:radial-gradient(1200px 600px at 50% -10%,#1a2740 0%,transparent 60%),var(--bg);
    color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    display:flex;align-items:center;justify-content:center;padding:24px;-webkit-font-smoothing:antialiased}
  form{width:100%;max-width:340px;background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:26px 22px}
  .brand{font-weight:700;font-size:17px;margin-bottom:4px}
  .brand span{color:var(--acc)}
  .sub{color:var(--dim);font-size:13px;margin-bottom:20px}
  input{width:100%;background:#1b2130;border:1px solid var(--line);color:var(--fg);border-radius:12px;
    padding:14px;font-size:16px;margin-bottom:12px}
  input:focus{outline:none;border-color:var(--acc)}
  button{width:100%;min-height:48px;background:var(--acc);color:#04241a;border:0;border-radius:12px;
    font-size:16px;font-weight:700;cursor:pointer}
  .err{color:#ff8f8f;font-size:13px;margin:-4px 0 12px}
  .hint{color:var(--dim);font-size:12px;margin-top:14px;text-align:center}
</style></head>
<body>
<form method="post" action="/login">
  <div class="brand">◉ Sync <span>Stream</span></div>
  <div class="sub">This stream is private. Enter the password to listen.</div>
  ${err ? '<div class="err">' + err + '</div>' : ''}
  <input type="password" name="password" placeholder="password" autofocus required
         autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false">
  <input type="hidden" name="next" value="${next.replace(/"/g, '&quot;')}">
  <button type="submit">Enter</button>
  <div class="hint">everyone in the room hears the same thing</div>
</form>
</body></html>`;
}

function serveLogin(res, next, err, code) {
  const html = loginPage(next || '', err || '');
  res.writeHead(code || 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

async function handleLogin(req, res, u) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  const now = Date.now();
  const recent = (loginFails.get(ip) || []).filter((t) => now - t < 5 * 60 * 1000);
  if (recent.length >= 10) {
    loginFails.set(ip, recent);
    return serveLogin(res, '', 'too many attempts — wait a few minutes and try again', 429);
  }
  let body = '';
  try { body = (await readBody(req, 8192)).toString('utf8'); } catch (e) { /* empty */ }
  let word = '', next = '';
  if ((req.headers['content-type'] || '').includes('application/json')) {
    try { const j = JSON.parse(body || '{}'); word = String(j.password || ''); next = String(j.next || ''); }
    catch (e) { return json(res, 400, { ok: false, error: 'bad json' }); }
  } else {
    const q = new URLSearchParams(body);
    word = q.get('password') || '';
    next = q.get('next') || '';
  }
  if (!PASSWORDS.some((pw) => sameText(word, pw))) {
    recent.push(now);
    loginFails.set(ip, recent);
    if ((req.headers['content-type'] || '').includes('application/json')) {
      return json(res, 401, { ok: false, error: 'wrong password' });
    }
    return serveLogin(res, next, 'wrong password', 401);
  }
  loginFails.delete(ip);
  const safe = (next && next.startsWith('/') && !next.startsWith('//')) ? next : '/';
  res.writeHead(303, {
    location: safe,
    'cache-control': 'no-store',
    'set-cookie': authCookie(req, AUTH_TOKEN, 31536000),
  });
  res.end();
}

// ----------------------------------------------------------------------------- http
const INDEX_FILE = (() => {
  const pub = path.join(__dirname, 'public', 'index.html');
  try { if (fs.statSync(pub).isFile()) return pub; } catch (e) { /* fall through */ }
  return path.join(__dirname, 'index.html');
})();

function serveIndex(res) {
  const p = INDEX_FILE;
  fs.readFile(p, (e, buf) => {
    if (e) return text(res, 500, 'index.html missing');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': buf.length });
    res.end(buf);
  });
}

function serveMedia(req, res, rest) {
  let id;
  try { id = decodeURIComponent(rest); } catch (e) { return text(res, 400, 'bad id'); }
  const base = path.basename(id).replace(/^\.+/, '');
  if (!base) return text(res, 404, 'not found');
  const file = path.join(MEDIA_DIR, base);
  if (!file.startsWith(MEDIA_DIR)) return text(res, 403, 'no');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return text(res, 404, 'not found');
    const mime = MIME[path.extname(base).toLowerCase()] || 'application/octet-stream';
    const head = { 'content-type': mime, 'accept-ranges': 'bytes',
                   'cache-control': 'public, max-age=3600', 'last-modified': st.mtime.toUTCString() };
    const range = req.headers.range;
    const m = range && /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (m && (m[1] || m[2])) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= st.size) end = st.size - 1;
      if (start > end) { res.writeHead(416, { 'content-range': 'bytes */' + st.size }); return res.end(); }
      res.writeHead(206, Object.assign({}, head, { 'content-range': 'bytes ' + start + '-' + end + '/' + st.size, 'content-length': end - start + 1 }));
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).on('error', () => res.end()).pipe(res);
    }
    res.writeHead(200, Object.assign({}, head, { 'content-length': st.size }));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.end()).pipe(res);
  });
}

async function handleUpload(req, res) {
  const raw = req.headers['x-filename'];
  if (!raw) return json(res, 400, { ok: false, error: 'missing X-Filename header' });
  let name;
  try { name = decodeURIComponent(String(raw)); } catch (e) { name = String(raw); }
  name = path.basename(name).replace(/[\\/]+/g, '_').trim().replace(/^\.+/, '');
  if (!name) return json(res, 400, { ok: false, error: 'bad filename' });
  const ext = path.extname(name).toLowerCase();
  if (!AUDIO_EXT.includes(ext) && !VIDEO_EXT.includes(ext)) {
    return json(res, 400, { ok: false, error: 'unsupported type ' + ext });
  }
  let base = name, i = 1;
  while (fs.existsSync(path.join(MEDIA_DIR, base))) {
    base = name.replace(/(\.[^.]+)$/, '-' + i + '$1');
    if (++i > 500) break;
  }
  const dest = path.join(MEDIA_DIR, base);
  const ws = fs.createWriteStream(dest);
  let bytes = 0, failed = null;
  req.on('data', (c) => {
    bytes += c.length;
    if (bytes > MAX_UPLOAD) { failed = 'file too large'; req.unpipe(ws); ws.destroy(); req.destroy(); }
  });
  req.pipe(ws);
  // Wait for the WRITE STREAM to finish, never for the request stream to close: on a plain
  // socket 'close' can fire before the fs flush, which made a fully written file look missing.
  await new Promise((resolve) => {
    ws.on('finish', resolve);
    ws.on('error', (e) => { failed = String((e && e.message) || e); resolve(); });
    ws.on('close', resolve);
    req.on('aborted', () => { failed = 'upload aborted'; resolve(); });
    req.on('error', (e) => { failed = String((e && e.message) || e); resolve(); });
  });
  if (failed) { try { fs.unlinkSync(dest); } catch (e) {} return json(res, 413, { ok: false, error: failed }); }
  let size = 0;
  try { size = fs.statSync(dest).size; } catch (e) { return json(res, 500, { ok: false, error: 'upload failed' }); }
  if (size !== bytes && bytes > 0) return json(res, 500, { ok: false, error: 'short write: ' + size + '/' + bytes });
  broadcast(getRoom('main'));
  return json(res, 200, { ok: true, id: base, bytes: size });
}

const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch (e) { return text(res, 400, 'bad url'); }
  const p = u.pathname;
  try {
    // ---- what stays open: the healthcheck, and the gate itself
    if (p === '/healthz') return text(res, 200, 'ok');
    if (p === '/login') {
      if (req.method === 'POST') return await handleLogin(req, res, u);
      if (isAuthed(req)) return redirect(res, '/');
      return serveLogin(res, u.searchParams.get('next') || '', '');
    }
    if (p === '/logout') {
      res.writeHead(303, { location: '/login', 'cache-control': 'no-store',
                           'set-cookie': authCookie(req, '', 0) });
      return res.end();
    }
    if (!isAuthed(req)) {
      // Wan's call: the PAGE and the API are what is protected. Media files are not — a copied
      // media URL is harmless, and leaving them open keeps the edge cache working for playback.
      if (p.startsWith('/media/')) return serveMedia(req, res, p.slice(7));
      if (p.startsWith('/api/')) return json(res, 401, { ok: false, error: 'auth required' });
      if (p === '/upload') return text(res, 401, 'auth required');
      return redirect(res, '/login?next=' + encodeURIComponent(p + (u.search || '')));
    }

    if (p === '/api/time') {
      const body = JSON.stringify({ now: Date.now() });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
      return res.end(body);
    }
    if (p === '/api/media') return json(res, 200, { media: await mediaList() });
    if (p === '/api/rooms') {
      if (req.method === 'POST') {
        let body;
        try { body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}'); }
        catch (e) { return json(res, 400, { ok: false, error: 'bad json' }); }
        const id = slugRoom(body.name);
        if (!id) return json(res, 400, { ok: false, error: 'name needed (letters, numbers, - _)' });
        const existed = rooms.has(id);
        getRoom(id);
        return json(res, 200, { ok: true, id, created: !existed });
      }
      return json(res, 200, { rooms: await roomsList(), current: roomIdOf(u) });
    }
    if (p === '/api/state') return json(res, 200, payload(getRoom(roomIdOf(u))));

    if (p === '/api/events') {
      const r = getRoom(roomIdOf(u));
      res.cid = String(u.searchParams.get('cid') || u.searchParams.get('client') || '');
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      r.clients.add(res);
      res.write('data: ' + JSON.stringify(payload(r)) + '\n\n');
      if (talking(r)) {
        res.write('event: talk\ndata: ' + JSON.stringify({ start: true, who: r.talker, rate: TALK_RATE }) + '\n\n');
      }
      broadcast(r);
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) {} }, 15000);
      const bye = () => { clearInterval(hb); r.clients.delete(res); broadcast(r); };
      req.on('close', bye);
      req.on('error', bye);
      return;
    }

    if (p === '/api/control') {
      if (req.method !== 'POST') return text(res, 405, 'POST only');
      let body;
      try { body = JSON.parse((await readBody(req, 65536)).toString('utf8') || '{}'); }
      catch (e) { return json(res, 400, { ok: false, error: 'bad json' }); }
      const out = await handleControl(getRoom(roomIdOf(u)), body);
      return json(res, out.ok ? 200 : 400, out);
    }

    if (p === '/upload') {
      if (req.method !== 'POST') return text(res, 405, 'POST only');
      return await handleUpload(req, res);
    }

    if (p === '/api/talk') {
      if (req.method !== 'POST') return text(res, 405, 'POST only');
      return await handleTalk(req, res, roomIdOf(u));
    }

    if (p.startsWith('/api/media/')) return serveMedia(req, res, p.slice('/api/media/'.length));
    if (p.startsWith('/media/')) return serveMedia(req, res, p.slice(7));
    if (p === '/' || p === '/index.html' || p.startsWith('/r/')) return serveIndex(res);
    return text(res, 404, 'not found');
  } catch (e) {
    return text(res, 500, 'error: ' + String((e && e.message) || e));
  }
});

loadRooms();
server.listen(PORT, '0.0.0.0', () => {
  console.log('[sync-stream] listening on :' + PORT + ' media=' + MEDIA_DIR +
              ' rooms=' + rooms.size + ' gate=' + (GATE ? PASSWORDS.length + ' password(s)' : 'OPEN'));
});
