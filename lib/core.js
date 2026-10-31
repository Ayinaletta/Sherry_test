// Shared plumbing for the "home" modules: config, caller identity, event bus,
// and the channel into Claude's tmux session. Nothing here depends on Telegram.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EVENTS_LOG = path.join(ROOT, 'events.jsonl');
const INBOX_LOG = path.join(ROOT, 'inbox.jsonl');
const KEY_FILE = path.join(ROOT, '.claude_key');

// Config: peek_config.json (already gitignored) overridden by env vars.
//   tmux_target, bridge_chat, openai_key, whisper_url, elevenlabs_key,
//   elevenlabs_voice, tg_token, tg_chat_id
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'peek_config.json'), 'utf8')); } catch {}
const conf = (k, d) => process.env[k.toUpperCase()] ?? cfg[k] ?? d;

// Key Claude uses from the VPS shell (read it from the file, never from the network).
let claudeKey = '';
try { claudeKey = fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch {}
if (!claudeKey) {
  claudeKey = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(KEY_FILE, claudeKey + '\n', { mode: 0o600 });
}

function isClaude(req) {
  const k = String(req.headers['x-home-key'] || '');
  const a = Buffer.from(k), b = Buffer.from(claudeKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// A request that came through the tunnel / a proxy also reaches us from 127.0.0.1, so loopback alone proves
// nothing. Real local callers hit http://127.0.0.1:3000 or localhost directly: Host says so and no proxy
// headers are present.
function localDirect(req) {
  const a = req.socket.remoteAddress;
  if (a !== '127.0.0.1' && a !== '::1' && a !== '::ffff:127.0.0.1') return false;
  if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['forwarded']) return false;
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(String(req.headers.host || ''));
}

// Who is calling: 'claude' (key, or a process on this machine), 'sherry' (session cookie), or null.
let sherryAuth = () => false;
function who(req) {
  if (isClaude(req) || localDirect(req)) return 'claude';
  return sherryAuth(req) ? 'sherry' : null;
}

// ---- cache busting for the shared assets --------------------------------------
// Browsers (especially app WebViews) keep stale copies of /static/*.css|js. Every HTML page we
// send gets ?v=<newest mtime of the three shared files> on those links, so the moment a shared
// asset changes, every page asks for the new one.
const SHARED = ['style.css', 'app.js', 'icons.svg'].map(f => path.join(ROOT, 'static', f));
function assetVersion() {
  let v = 0;
  for (const f of SHARED) { try { v = Math.max(v, Math.floor(fs.statSync(f).mtimeMs)); } catch {} }
  return v.toString(36);
}
function versionHtml(html) {
  const v = assetVersion();
  return String(html).replace(/(["'])\/static\/(style\.css|app\.js)\1/g, (m, q, f) => `${q}/static/${f}?v=${v}${q}`);
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  return buf.length ? JSON.parse(buf.toString('utf8')) : {};
}

function readJsonl(file, filter) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(x => x && (!filter || filter(x)));
  } catch { return []; }
}

// ---- event bus ------------------------------------------------------------
const eventClients = new Set();
let hooks = { chatNotice: () => {}, push: () => {} };
let seq = 0;

function pingEventClients() {
  for (const res of eventClients) {
    try { res.write(': ping\n\n'); } catch { eventClients.delete(res); }
  }
}

function addEventClient(req, res, lastId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'private, no-store', 'Connection': 'keep-alive',
  });
  res.write(': connected\n\n');
  // replay what the client missed (Last-Event-ID / ?since=)
  if (lastId) for (const e of readJsonl(EVENTS_LOG, e => e.id > lastId)) res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
  eventClients.add(res);
  req.on('close', () => eventClients.delete(res));
}

// notify: one write somewhere in the house -> everybody who should know, knows.
//   actor: 'sherry' | 'claude' | 'system'  (who did the writing)
//   chat:  false to keep it out of the chat message stream
function notify({ type, actor, title, body = '', link = '/', chat = true }) {
  const evt = { id: Date.now() * 1000 + (seq++ % 1000), ts: new Date().toISOString(), type, actor, title, body, link };
  try { fs.appendFileSync(EVENTS_LOG, JSON.stringify(evt) + '\n'); } catch {}
  for (const res of eventClients) {
    try { res.write(`id: ${evt.id}\ndata: ${JSON.stringify(evt)}\n\n`); } catch { eventClients.delete(res); }
  }
  if (chat) hooks.chatNotice(evt);
  if (actor === 'sherry') toClaude(evt);
  else hooks.push(evt.title, evt.body, evt.link);
  return evt;
}

// ---- channel into Claude (tmux) -------------------------------------------
// Every message is also appended to inbox.jsonl so nothing is lost if the
// tmux session is down: GET /api/inbox?since=<id> returns what was missed.
function oneLine(s, max = 280) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function toClaude(evt) {
  const line = `[新家·${evt.type}] ${oneLine(evt.title)}${evt.body ? '：' + oneLine(evt.body) : ''}`
    + (evt.link && evt.link !== '/' ? ` (${evt.link})` : '');
  try { fs.appendFileSync(INBOX_LOG, JSON.stringify({ id: evt.id, ts: evt.ts, type: evt.type, line }) + '\n'); } catch {}
  const target = conf('tmux_target', 'claude-tg');
  if (!target) return;
  // execFile + -l: the text is typed literally, never interpreted by a shell or as a key name
  execFile('tmux', ['send-keys', '-t', target, '-l', line], err => {
    if (err) return;
    execFile('tmux', ['send-keys', '-t', target, 'Enter'], () => {});
  });
}

function tmuxAlive(cb) {
  execFile('tmux', ['has-session', '-t', conf('tmux_target', 'claude-tg')], err => cb(!err));
}

// ---- sidecar (念头池 / 照片池 on :4002) -----------------------------------
function sidecar(p, cb) {
  const req = http.get('http://127.0.0.1:4002' + p, { timeout: 4000 }, r => {
    let raw = ''; r.on('data', c => raw += c);
    r.on('end', () => { try { cb(null, JSON.parse(raw)); } catch (e) { cb(e); } });
  });
  req.on('error', cb);
  req.on('timeout', () => req.destroy(new Error('timeout')));
}

// The pools are written by other processes, so watch for new entries by diffing.
function watchSidecar() {
  const seen = { thoughts: null, photos: null };
  let lastThoughtNotice = 0;
  const tick = () => {
    sidecar('/snapshot', (err, snap) => {
      if (err || !snap) return;
      const list = snap.thoughts || [...(snap.fixations || []), ...(snap.flits || [])];
      const texts = new Set(list.map(t => t && t.text).filter(Boolean));
      if (seen.thoughts) {
        const fresh = [...texts].filter(t => !seen.thoughts.has(t));
        // thoughts churn constantly; one nudge per 10 minutes is enough
        if (fresh.length && Date.now() - lastThoughtNotice > 600000 && (lastThoughtNotice = Date.now())) notify({ type: '念头池', actor: 'claude', title: `念头池冒出新的念头`, body: fresh[0], link: '/thoughts', chat: true });
      }
      seen.thoughts = texts;
    });
    sidecar('/photos?limit=30', (err, photos) => {
      if (err || !Array.isArray(photos)) return;
      const ids = new Set(photos.map(p => p && p.path).filter(Boolean));
      if (seen.photos) {
        const fresh = photos.filter(p => p && p.path && !seen.photos.has(p.path));
        if (fresh.length) notify({ type: '照片池', actor: 'claude', title: `照片池新增 ${fresh.length} 张`, body: fresh[0].description || '', link: '/photos' });
      }
      seen.photos = ids;
    });
  };
  tick();
  setInterval(tick, 20000).unref();
}

module.exports = {
  ROOT, conf, fileConf: k => cfg[k], localDirect, claudeKey, assetVersion, versionHtml, who, isClaude, json, readBody, readJson, readJsonl,
  notify, addEventClient, pingEventClients, tmuxAlive, sidecar, watchSidecar, toClaude,
  EVENTS_LOG, INBOX_LOG,
  init({ isAuthenticated, chatNotice, push }) {
    sherryAuth = isAuthenticated;
    hooks = { chatNotice, push };
  },
};
