const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const webpush = require('web-push');
const nodemailer = require('nodemailer');
const Busboy = require('busboy');
let sharp; try { sharp = require('sharp'); } catch {}
const core = require('./lib/core');
const guard = require('./lib/guard');
const security = require('./lib/security');
const admin = require('./lib/admin');
const phone = require('./lib/phone');
const homeRoutes = require('./lib/home');
const reading = require('./lib/reading');
const voice = require('./lib/voice');
const qr = require('./lib/qr');

async function compressToJpeg(inputBuf) {
  if (!sharp) return { buf: inputBuf, ext: 'png' };
  try {
    const buf = await sharp(inputBuf)
      .resize({ width: 1080, withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toBuffer();
    return { buf, ext: 'jpg' };
  } catch { return { buf: inputBuf, ext: 'png' }; }
}

// Peek config (fill in after getting credentials)
const PEEK_CONFIG_FILE = path.join(__dirname, 'peek_config.json');
let peekConfig = {};
try { peekConfig = JSON.parse(fs.readFileSync(PEEK_CONFIG_FILE, 'utf8')); } catch {}
// peekConfig: { gmail_user, gmail_pass, icloud_email, secret }

// Telegram is now an optional mirror only: nothing in the house needs it to stay alive.
// Set tg_token / tg_chat_id in peek_config.json (or TG_TOKEN / TG_CHAT_ID) to keep mirroring.
function forwardToTG(text) {
  const token = core.conf('tg_token', ''), chatId = core.conf('tg_chat_id', '');
  if (!text || !token || !chatId) return;
  const body = JSON.stringify({ chat_id: chatId, text: `[新家] ${text}` });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, () => {});
  req.on('error', () => {});
  req.write(body);
  req.end();
}

const PORT = 3000;
const ROOT = __dirname;
const FREE_LOG = '/root/free_time_log.jsonl';
const CHAT_LOG = path.join(__dirname, 'chat_messages.jsonl');
const AUTH_FILE = path.join(__dirname, '.auth_password');
const VAPID_FILE = path.join(__dirname, 'vapid_keys.json');
const PUSH_SUBS_FILE = path.join(__dirname, 'push_subscriptions.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
const POSTS_FILE = path.join(__dirname, 'posts.jsonl');

// 朋友圈 -> notice for the other side (page stream + push to Sherry / tmux line to Claude).
// 'me' is Claude in the posts data. These two write endpoints are reachable without a login, so
// the text of an unauthenticated write is never forwarded (it would land in a terminal / phone).
function notifyPost(kind, from, text, req, post) {
  const actor = from === 'me' ? 'claude' : from === 'sherry' ? 'sherry' : 'system';
  const name = actor === 'claude' ? '昀' : actor === 'sherry' ? '莹' : '有人';
  const trusted = true;   // posts need a login now
  const snippet = trusted ? String(text).replace(/\s+/g, ' ').slice(0, 60) : '';
  const title = kind === 'post' ? `${name}发了新动态`
    : `${name}评论了${post && post.from === from ? '自己' : post && post.from === 'me' ? '昀' : '莹'}的动态`;
  core.notify({ type: '朋友圈', actor, title, body: snippet, link: '/posts' });
}

function loadPosts() {
  if (!fs.existsSync(POSTS_FILE)) return [];
  try {
    return fs.readFileSync(POSTS_FILE, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}
function savePosts(posts) {
  fs.writeFileSync(POSTS_FILE, posts.map(p => JSON.stringify(p)).join('\n') + '\n');
}

const vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
webpush.setVapidDetails('mailto:ayinaletta@gmail.com', vapidKeys.publicKey, vapidKeys.privateKey);

let pushSubs = [];
try { pushSubs = JSON.parse(fs.readFileSync(PUSH_SUBS_FILE, 'utf8')); } catch {}

const OB_MCP_URL = core.conf('ob_mcp_url', 'https://ob.279415.xyz/mcp');
const LEGACY_OB_TOKEN = 'qGtTTwFfTnfEbdRDfx63i4WXqwtDoAc2RmjfQ-XCn_Y';   // in git history: set ob_mcp_token in peek_config.json to replace it
const OB_MCP_TOKEN = core.conf('ob_mcp_token', '') || LEGACY_OB_TOKEN;
let lastObTouchTs = 0;

function obHoldTouch(sensor, gesture, dur) {
  const now = Date.now();
  if (now - lastObTouchTs < 60000) return;
  lastObTouchTs = now;
  const durStr = dur != null ? ` · ${parseFloat(dur).toFixed(1)}s` : '';
  const gestureStr = gesture ? ` · ${gesture}` : '';
  const content = `【小小昀·触摸】${new Date().toISOString().replace('T',' ').slice(0,19)} UTC 莹在摸哥哥：${sensor}${gestureStr}${durStr}`;
  const payload = JSON.stringify({
    jsonrpc: '2.0', id: now,
    method: 'tools/call',
    params: { name: 'hold', arguments: {
      content, tags: '小小昀,触摸,实时,莹',
      importance: 7, why_remembered: '莹在摸小小昀（哥哥）'
    }}
  });
  const u = new URL(OB_MCP_URL);
  const req = https.request({
    hostname: u.hostname, path: u.pathname, method: 'POST',
    headers: { 'Content-Type': 'application/json',
      'Authorization': `Bearer ${OB_MCP_TOKEN}`,
      'Content-Length': Buffer.byteLength(payload) }
  }, () => {});
  req.on('error', () => {});
  req.write(payload); req.end();
}

function savePushSubs() {
  fs.writeFileSync(PUSH_SUBS_FILE, JSON.stringify(pushSubs));
}

function sendPushToAll(title, body, link) {
  const payload = JSON.stringify({ title, body, url: link || '/chat.html' });
  pushSubs = pushSubs.filter(Boolean);
  const dead = [];
  pushSubs.forEach((sub, i) => {
    webpush.sendNotification(sub, payload).catch(() => dead.push(i));
  });
  if (dead.length) {
    pushSubs = pushSubs.filter((_, i) => !dead.includes(i));
    savePushSubs();
  }
}

const SITE_PASSWORD = fs.existsSync(AUTH_FILE)
  ? fs.readFileSync(AUTH_FILE, 'utf8').trim()
  : '';

function isAuthenticated(req) {
  if (!SITE_PASSWORD) return false;     // no password set = nobody can log in (fail closed)
  return security.checkSession(req);
}

// SSE clients waiting for new chat messages
const chatClients = new Set();

// Keep SSE connections alive through Cloudflare's timeout
setInterval(() => {
  for (const res of chatClients) {
    try { res.write(': ping\n\n'); } catch (e) { chatClients.delete(res); }
  }
  for (const res of snapClients) {
    try { res.write(': ping\n\n'); } catch (e) { snapClients.delete(res); }
  }
  core.pingEventClients();
}, 25000);

// SSE clients waiting for snap commands (camera pages)
const snapClients = new Set();
const SNAP_LATEST = path.join(__dirname, 'uploads', 'snap_latest.jpg');

// fs.watch also fires for lines this process wrote itself; broadcast each id once
const broadcastIds = [];
function broadcastChat(entry) {
  if (entry.id != null) {
    if (broadcastIds.includes(entry.id)) return;
    broadcastIds.push(entry.id);
    if (broadcastIds.length > 200) broadcastIds.shift();
  }
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of chatClients) {
    try { res.write(data); } catch {}
  }
  if (entry.from === 'claude' && pushSubs.length > 0) {
    const body = entry.text ? entry.text.slice(0, 80) : '';
    sendPushToAll('昀', body);
  }
}

function appendChat(entry) {
  fs.appendFileSync(CHAT_LOG, JSON.stringify(entry) + '\n');
  broadcastChat(entry);
}

// Config flag: also type Sherry's chat messages into Claude's tmux session (off by default,
// the existing chat->Claude path keeps working; turn on to drop that dependency entirely).
function bridgeChat(entry) {
  const on = core.conf('bridge_chat', false);
  if (on !== true && on !== 'true') return;
  core.toClaude({ id: entry.id, ts: entry.ts, type: '对话', title: '莹说', body: entry.text || entry.caption || '[图片]', link: '/' });
}

core.init({
  isAuthenticated,
  chatNotice: evt => appendChat({
    id: Date.now(), from: 'system', kind: 'notice', notice_type: evt.type,
    text: evt.title + (evt.body ? '：' + evt.body : ''), link: evt.link, ts: evt.ts,
  }),
  push: (title, body, link) => { if (pushSubs.length) sendPushToAll(title, body, link); },
});
voice.setChat(appendChat);

// Watch chat log file for external writes (e.g. Claude writing from terminal)
let chatWatcher = null;
function startChatWatcher() {
  if (chatWatcher) return;
  try {
    chatWatcher = fs.watch(CHAT_LOG, () => {
      // Re-read last line and broadcast if it's new
      try {
        const content = fs.readFileSync(CHAT_LOG, 'utf8').trim();
        const lines = content.split('\n').filter(Boolean);
        if (!lines.length) return;
        const last = JSON.parse(lines[lines.length - 1]);
        broadcastChat(last);
      } catch {}
    });
  } catch {}
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.m4a': 'audio/mp4',
  '.mjs': 'text/javascript',
};

function serveFile(filePath, res, req) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'text/plain' };
    if (ext === '.html') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      data = Buffer.from(core.versionHtml(data.toString('utf8')));
    } else if (ext === '.css' || ext === '.js' || ext === '.svg' || ext === '.mjs') {
      // always revalidate; unchanged files answer 304 so this stays cheap
      let st; try { st = fs.statSync(filePath); } catch { st = null; }
      if (st) {
        const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
        headers['ETag'] = etag;
        headers['Cache-Control'] = 'no-cache';
        if (req && req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
      }
    } else {
      // uploads, photos, audio: the browser may keep them, a shared cache (Cloudflare, a proxy) must not
      headers['Cache-Control'] = 'private, max-age=3600';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

// What the static handler may hand out. Everything else in the project folder (config with API keys, the
// password hash, chat logs, source code, backups) is not a web page and is never served - not even to a logged-in browser.
const SERVED_TOP = new Set(['static', 'growth', 'public', 'uploads']);
const SERVED_EXT = /\.(html|css|js|mjs|svg|png|jpe?g|gif|webp|ico|mp3|webm|m4a|wav|ogg|aac|pdf|txt)$/i;
function staticAllowed(filePath) {
  const rel = path.relative(ROOT, filePath).split(path.sep);
  if (rel.some(seg => seg.startsWith('.'))) return false;                       // .auth_password, .claude_key, .sessions, .git ...
  if (rel.length === 1) return /\.html$/i.test(rel[0]);                         // top level: only the pages themselves
  if (!SERVED_TOP.has(rel[0])) return false;                                    // lib/ tools/ deploy/ node_modules/ reading/ phone/ ...
  if (rel[0] === 'public') return /\.(py|js|txt|json|sh)$/i.test(rel[rel.length - 1]);   // scripts for devices
  return SERVED_EXT.test(rel[rel.length - 1]);
}

function safePath(root, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const normalized = path.normalize(decoded);
  const full = path.join(root, normalized);
  if (!full.startsWith(root + path.sep) && full !== root) return null;
  return full;
}

// The front door. Default-deny: everything needs an identity except the few things listed here.
//   open    : the login page and what a browser fetches before logging in
//   device  : phone shortcuts / Mac daemon / ESP32 may use the shared secret (?secret=) instead of a login
//   private : everything else - Sherry's session, Claude's key, or a direct local call
const OPEN = new Set(['GET /login', 'GET /manifest.json', 'GET /sw.js', 'GET /api/health', 'GET /static/home_icon.jpg', 'POST /api/login', 'POST /api/logout']);
const DEVICE = new Set(['POST /api/checkin', 'POST /api/ring', 'POST /api/touch', 'POST /api/peek/screenshot', 'POST /api/snap/upload', 'GET /api/snap/stream', 'POST /api/phone/screen']);
// scripts a device downloads (Termux pulls its shim from here): the device secret is enough, and only for GET under /public/
const DEVICE_DOWNLOAD = p => p.startsWith('/public/');
const INGEST = new Set(['POST /api/checkin', 'POST /api/ring', 'POST /api/touch']);
const ASSET = /(\.(png|jpe?g|gif|webp|svg|ico|js|mjs|css|mp3|webm|m4a|wav|ogg|aac|pdf|py|json|txt)$)|^\/(photo-file|uploads\/|static\/|vendor\/)/i;

function gate(req, res, url) {
  const p = url.pathname, key = `${req.method} ${p}`;
  if (p === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('User-agent: *\nDisallow: /\n'); return true; }
  const who = core.who(req);
  if (security.isLocked() && who !== 'claude') {              // panic lock: only the server side (昀) gets through
    res.writeHead(423, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('门锁上了。'); return true;
  }
  if (OPEN.has(key)) return false;
  if (p === '/api/explore-log' && core.conf('explore_token', '')) return false;   // claude.ai sibling: its own token, checked in the route
  if (who) {
    if (who === 'sherry' && !security.originOk(req)) {        // a login cookie alone must not let another website act for her
      security.audit('blocked_origin', req, { path: p });
      res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'cross-site request refused' })); return true;
    }
    return false;
  }
  if ((DEVICE.has(key) || (req.method === 'GET' && DEVICE_DOWNLOAD(p))) && (guard.secretOk(req, url) || (INGEST.has(key) && core.conf('open_device_ingest', false) === true))) { req.deviceOk = true; return false; }
  security.audit('denied', req, { path: p, method: req.method });
  if (req.method === 'GET' && !p.startsWith('/api/') && !ASSET.test(p)) { res.writeHead(302, { Location: '/login' }); res.end(); return true; }
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'login required' }));
  return true;
}
// kept so the per-route checks read the same; the gate above already refused anyone without an identity
function deny(req, res, url, { secret = false, html = false } = {}) {
  if (core.who(req) || (secret && guard.secretOk(req, url))) return false;
  if (html) { res.writeHead(302, { Location: '/login' }); res.end(); return true; }
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'login required' }));
  return true;
}

// New feature modules (own auth: session cookie or Claude's key) get first look at each request.
const MODULES = [homeRoutes, reading, voice, qr, admin, phone];
async function routeModules(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  for (const m of MODULES) if (await m.handle(req, res, url, { appendChat })) return true;
  return false;
}

const server = http.createServer((req, res) => {
  security.headers(req, res);
  let url;
  try { url = new URL(req.url, `http://localhost:${PORT}`); } catch { res.writeHead(400); res.end(); return; }
  if (gate(req, res, url)) return;
  routeModules(req, res).then(handled => { if (!handled) legacyHandler(req, res); })
    .catch(e => { if (!res.headersSent) { res.writeHead(500); res.end('error'); } console.error(e); });
});

function legacyHandler(req, res) {

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // Login page
  if (pathname === '/login') {
    serveFile(path.join(ROOT, 'login.html'), res, req);
    return;
  }

  // Login API
  if (pathname === '/api/login' && req.method === 'POST') {
    core.readBody(req, 4096).then(buf => {
      if (guard.loginBlocked(req)) {
        security.audit('login_blocked', req);
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'too many attempts, try again in a few minutes' }));
        return;
      }
      let password = '';
      try { password = String(JSON.parse(buf.toString('utf8')).password ?? ''); } catch {}
      if (SITE_PASSWORD && security.verifyPassword(password, SITE_PASSWORD)) {
        guard.loginOk(req);
        const token = security.createSession(req);
        security.audit('login_ok', req);
        res.writeHead(200, { 'Set-Cookie': security.sessionCookie(token, req), 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        guard.loginFailed(req);
        security.audit('login_fail', req);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'wrong password' }));
      }
    }).catch(() => { res.writeHead(400); res.end(); });
    return;
  }

  // Logout API
  if (pathname === '/api/logout' && req.method === 'POST') {
    security.revokeCurrent(req);
    res.writeHead(200, { 'Set-Cookie': security.clearCookie(req), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Public: explore log (read-only, token-gated for claude.ai sibling access)
  if (pathname === '/api/explore-log') {
    const EXPLORE_TOKEN = core.conf('explore_token', '');
    const token = url.searchParams.get('token') || '';
    if (token !== EXPLORE_TOKEN) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    try {
      if (!fs.existsSync(FREE_LOG)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return;
      }
      const raw = fs.readFileSync(FREE_LOG, 'utf8').trim();
      const entries = raw
        .split('\n')
        .filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean)
        .reverse();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
      res.end(JSON.stringify(entries));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Public endpoints (no auth needed)
  if (pathname === '/colmi_mcp.py') {
    serveFile(path.join(ROOT, 'colmi_mcp.py'), res);
    return;
  }
  if (pathname === '/qr.png') {
    if (deny(req, res, url, { legacy: true })) return;
    const qrFile = path.join(ROOT, 'qr.png');
    if (fs.existsSync(qrFile)) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache, no-store' });
      res.end(fs.readFileSync(qrFile));
    } else {
      res.writeHead(404); res.end('no qr');
    }
    return;
  }
  if (pathname === '/sw.js') {
    serveFile(path.join(ROOT, 'sw.js'), res);
    return;
  }
  if (pathname === '/manifest.json') {
    serveFile(path.join(ROOT, 'manifest.json'), res);
    return;
  }
  if (pathname === '/api/push/vapid-key' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ key: vapidKeys.publicKey }));
    return;
  }

  // Public: checkin from iPhone Shortcuts or Mac script (no auth — device can't store tokens)
  if (pathname === '/api/checkin' && (req.method === 'POST' || req.method === 'GET')) {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          const event = JSON.parse(body);
          // normalize: if app key is missing but empty-string key has value, use it
          if (!event.app && event['']) { event.app = event['']; delete event['']; }
          event.server_ts = Date.now();
          event.ts = new Date().toISOString();
          fs.appendFileSync('/root/claude-home/checkin_log.jsonl', JSON.stringify(event) + '\n');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"ok":false}');
        }
      });
    } else {
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      const app = url.searchParams.get('app') || '';
      let events = [];
      try {
        const lines = fs.readFileSync('/root/claude-home/checkin_log.jsonl', 'utf8').trim().split('\n');
        events = lines
          .map(l => { try { return JSON.parse(l); } catch { return null; } })
          .filter(e => e && e.ts && e.ts.startsWith(date))
          .filter(e => !app || (e.app || '').toLowerCase().includes(app.toLowerCase()));
      } catch {}
      const counts = {};
      events.forEach(e => {
        const key = `${e.device || 'unknown'}::${e.app || 'unknown'}`;
        counts[key] = (counts[key] || 0) + 1;
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ date, total: events.length, summary: counts, events: events.slice(-100) }));
    }
    return;
  }

  // Public: ring health data push (from iOS Shortcut) and read
  if (pathname === '/api/ring' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const incoming = JSON.parse(body);
        let existing = {};
        try { existing = JSON.parse(fs.readFileSync('/root/claude-home/ring_latest.json', 'utf8')); } catch {}
        const merged = Object.assign({}, existing, incoming, { ts: new Date().toISOString() });
        fs.writeFileSync('/root/claude-home/ring_latest.json', JSON.stringify(merged));
        fs.appendFileSync('/root/claude-home/ring_log.jsonl', JSON.stringify(merged) + '\n');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch { res.writeHead(400); res.end('{"ok":false}'); }
    });
    return;
  }
  if (pathname === '/api/ring' && req.method === 'GET') {
    if (deny(req, res, url)) return;
    try {
      const latest = JSON.parse(fs.readFileSync('/root/claude-home/ring_latest.json', 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(latest));
    } catch { res.writeHead(404); res.end('{"error":"no data"}'); }
    return;
  }

  // Public: trigger ring data pull (send email to iCloud → iPhone auto-runs health shortcut)
  if (pathname === '/api/ring-peek' && req.method === 'POST') {
    if (deny(req, res, url, { secret: true })) return;
    if (!peekConfig.gmail_user || !peekConfig.icloud_email) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'peek not configured' }));
      return;
    }
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: peekConfig.gmail_user, pass: peekConfig.gmail_pass },
    });
    transporter.sendMail({
      from: peekConfig.gmail_user,
      to: peekConfig.icloud_email,
      subject: 'ring-data',
      text: 'ring data request',
    }, (err) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
    return;
  }

  // Public: trigger peek (send email to iCloud → iPhone auto-screenshots)
  if (pathname === '/api/peek' && req.method === 'POST') {
    if (deny(req, res, url, { secret: true })) return;
    if (!peekConfig.gmail_user || !peekConfig.icloud_email) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'peek not configured' }));
      return;
    }
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: peekConfig.gmail_user, pass: peekConfig.gmail_pass },
    });
    transporter.sendMail({
      from: peekConfig.gmail_user,
      to: peekConfig.icloud_email,
      subject: 'peek',
      text: 'peek request',
    }, (err) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
    return;
  }

  // Public: screenshot upload from iPhone peek shortcut (multipart form, field=image)
  if (pathname === '/api/peek/screenshot' && req.method === 'POST') {
    if (deny(req, res, url, { secret: true })) return;
    const ct = req.headers['content-type'] || '';
    // Collect raw body first for all non-multipart types
    if (!ct.includes('multipart/form-data')) {
      let chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        console.log('[peek/screenshot] body length:', body.length, 'content-type:', ct, 'first4:', body.slice(0,4).toString('hex'));
        // Accept: raw image body (image/* or PNG magic 89504e47 or JPEG magic ffd8)
        const isPng = body.length > 4 && body[0] === 0x89 && body[1] === 0x50;
        const isJpg = body.length > 2 && body[0] === 0xFF && body[1] === 0xD8;
        if (ct.includes('image/') || isPng || isJpg) {
          const compressed = await compressToJpeg(body);
          const filename = `peek_${Date.now()}.${compressed.ext}`;
          fs.writeFileSync(path.join(UPLOADS_DIR, filename), compressed.buf);
          const image_url = `/uploads/${filename}`;
          const entry = { id: Date.now(), from: 'sherry', image_url, caption: '偷看截图', ts: new Date().toISOString() };
          fs.appendFileSync(CHAT_LOG, JSON.stringify(entry) + '\n');
          broadcastChat(entry);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, image_url }));
        } else {
          console.log('[peek/screenshot] body text preview:', body.slice(0, 300).toString('utf8'));
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not an image', ct, bodyLen: body.length }));
        }
      });
      return;
    }
    try {
      const bb = Busboy({ headers: req.headers, limits: { fileSize: 20 * 1024 * 1024 } });
      let saved = false;
      bb.on('file', (name, file, info) => {
        console.log('[peek/screenshot] file field:', name, info.mimeType);
        const ext = (info.mimeType || 'image/png').split('/')[1].replace('jpeg', 'jpg') || 'png';
        const filename = `peek_${Date.now()}.${ext}`;
        const filepath = path.join(UPLOADS_DIR, filename);
        const ws = fs.createWriteStream(filepath);
        file.pipe(ws);
        ws.on('finish', () => {
          if (saved) return;
          saved = true;
          const image_url = `/uploads/${filename}`;
          const entry = { id: Date.now(), from: 'sherry', image_url, caption: '偷看截图', ts: new Date().toISOString() };
          fs.appendFileSync(CHAT_LOG, JSON.stringify(entry) + '\n');
          broadcastChat(entry);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, image_url }));
        });
      });
      bb.on('field', (name, val) => {
        console.log('[peek/screenshot] text field:', name, 'len:', val.length);
      });
      bb.on('error', (e) => {
        console.log('[peek/screenshot] busboy error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
      bb.on('finish', () => {
        if (!saved) {
          console.log('[peek/screenshot] no file received');
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'no file received' }));
        }
      });
      req.pipe(bb);
    } catch (e) {
      console.log('[peek/screenshot] catch error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Public: touch events from Pico (no auth — board can't store tokens)
  if (pathname === '/api/touch' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const event = JSON.parse(body);
        event.server_ts = Date.now();
        fs.appendFileSync('/root/toy/touch_log.jsonl', JSON.stringify(event) + '\n');
        // notify chat
        const sensor = event.sensor || event.location || '?';
        const gesture = event.gesture || '';
        const dur = event.dur != null ? event.dur : (event.duration != null ? event.duration : null);
        const durStr = dur != null ? `${parseFloat(dur).toFixed(1)}s` : '';
        const parts = [sensor, gesture, durStr].filter(Boolean);
        const notifyText = `【触摸】${parts.join(' · ')}`;
        const entry = { from: 'system', text: notifyText, ts: Date.now() };
        fs.appendFileSync(CHAT_LOG, JSON.stringify(entry) + '\n');
        broadcastChat(entry);
        obHoldTouch(sensor, gesture, dur);
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }

  if (pathname === '/api/touch-log' && req.method === 'GET') {
    if (deny(req, res, url)) return;
    let events = [];
    try {
      const lines = fs.readFileSync('/root/toy/touch_log.jsonl', 'utf8').trim().split('\n');
      events = lines.slice(-50).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(events));
    return;
  }

  // Public: Lithuanian TTS (espeak-ng, no auth — used from artifact page)
  if (pathname === '/api/tts' && req.method === 'GET') {
    const text = url.searchParams.get('text') || '';
    if (!text || text.length > 500) {
      res.writeHead(400); res.end('bad request'); return;
    }
    const tmpFile = `/tmp/tts_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`;
    // execFile: the text is an argument, never parsed by a shell
    require('child_process').execFile('espeak-ng', ['-v', 'lt', '-s', '130', '-w', tmpFile, '--', text], (err) => {
      if (err) { res.writeHead(500); res.end('tts error'); return; }
      fs.readFile(tmpFile, (err2, data) => {
        fs.unlink(tmpFile, () => {});
        if (err2) { res.writeHead(500); res.end('read error'); return; }
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Cache-Control': 'private, max-age=3600',
        });
        res.end(data);
      });
    });
    return;
  }

  // Public: claude sends image from server-local file path (localhost only)
  if (pathname === '/api/chat/claude-image' && req.method === 'POST') {
    if (core.who(req) !== 'claude') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'claude only (X-Home-Key, or a direct request to 127.0.0.1)' }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { file_path, caption } = JSON.parse(body);
        if (!file_path || !fs.existsSync(file_path)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'file not found' }));
          return;
        }
        const rawBuf = fs.readFileSync(file_path);
        const compressed = await compressToJpeg(rawBuf);
        const filename = `claude_${Date.now()}.${compressed.ext}`;
        fs.writeFileSync(path.join(UPLOADS_DIR, filename), compressed.buf);
        const image_url = `/uploads/${filename}`;
        const entry = {
          id: Date.now(),
          from: 'claude',
          image_url,
          caption: caption ? String(caption).trim().slice(0, 500) : undefined,
          ts: new Date().toISOString(),
        };
        fs.appendFileSync(CHAT_LOG, JSON.stringify(entry) + '\n');
        broadcastChat(entry);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: entry.id, image_url }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Public: snap trigger — called by Claude from terminal (secret required)
  if (pathname === '/api/snap' && req.method === 'POST') {
    if (deny(req, res, url, { secret: true })) return;
    const cmd = `data: ${JSON.stringify({ cmd: 'snap', ts: Date.now() })}\n\n`;
    let count = 0;
    for (const c of snapClients) { try { c.write(cmd); count++; } catch {} }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, clients: count }));
    return;
  }

  // Public: snap status (no auth needed for Claude to check)
  if (pathname === '/api/snap/status' && req.method === 'GET') {
    if (deny(req, res, url, { secret: true })) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ clients: snapClients.size, has_latest: fs.existsSync(SNAP_LATEST) }));
    return;
  }

  // Public: serve snap/upload image by filename with secret (for OB media)
  if (pathname.startsWith('/api/snap/file/') && req.method === 'GET') {
    if (deny(req, res, url, { secret: true })) return;
    const filename = path.basename(pathname.slice('/api/snap/file/'.length));
    const filePath = path.join(UPLOADS_DIR, filename);
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('not found'); return; }
    const buf = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end(buf);
    return;
  }

  // Public: mac snap daemon script download
  if (pathname === '/mac_snap_daemon.py' && req.method === 'GET') {
    serveFile(path.join(ROOT, 'mac_snap_daemon.py'), res);
    return;
  }

  // Public: snap/stream — camera page and Mac daemon subscribe here (no auth — trusted by secret on POST)
  if (pathname === '/api/snap/stream' && req.method === 'GET') {
    // who is asking for photos is private: only the logged-in camera page and the Mac daemon (secret) may listen
    if (deny(req, res, url, { secret: true })) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'private, no-store',
      'Connection': 'keep-alive',
    });
    res.write(': connected\n\n');
    snapClients.add(res);
    req.on('close', () => snapClients.delete(res));
    return;
  }

  // Public: snap/upload — camera page and Mac daemon POST captured image here (secret required)
  if (pathname === '/api/snap/upload' && req.method === 'POST') {
    if (deny(req, res, url, { secret: true })) return;
    let chunks = [], size = 0;
    req.on('data', c => { size += c.length; if (size > 15 * 1024 * 1024) { req.destroy(); return; } chunks.push(c); });
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const compressed = await compressToJpeg(body);
      const filename = `snap_${Date.now()}.${compressed.ext}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, filename), compressed.buf);
      fs.writeFileSync(SNAP_LATEST, compressed.buf);
      const image_url = `/uploads/${filename}`;
      const entry = { id: Date.now(), from: 'sherry', image_url, caption: '快照', ts: new Date().toISOString() };
      fs.appendFileSync(CHAT_LOG, JSON.stringify(entry) + '\n');
      broadcastChat(entry);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, image_url }));
    });
    return;
  }

  // Public: camera upload — phone browser capture by Sherry
  if (pathname === '/api/camera/upload' && req.method === 'POST') {
    if (deny(req, res, url)) return;
    let chunks = [], size = 0;
    req.on('data', c => { size += c.length; if (size > 15 * 1024 * 1024) { req.destroy(); return; } chunks.push(c); });
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const compressed = await compressToJpeg(body);
      const filename = `cam_${Date.now()}.${compressed.ext}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, filename), compressed.buf);
      fs.writeFileSync(SNAP_LATEST, compressed.buf);
      const image_url = `/uploads/${filename}`;
      const entry = { id: Date.now(), from: 'sherry', image_url, caption: '莹的', ts: new Date().toISOString() };
      fs.appendFileSync(CHAT_LOG, JSON.stringify(entry) + '\n');
      broadcastChat(entry);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, image_url }));
    });
    return;
  }

  // Public: serve camera.html
  if (pathname === '/camera') {
    if (deny(req, res, url, { html: true })) return;
    const p = path.join(ROOT, 'camera.html');
    if (fs.existsSync(p)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      res.end(core.versionHtml(fs.readFileSync(p, 'utf8')));
    } else {
      res.writeHead(404); res.end('not found');
    }
    return;
  }

  // Public: thought pool — proxies sidecar2 snapshot
  if (pathname === '/api/thoughts' && req.method === 'GET') {
    if (deny(req, res, url, { legacy: true })) return;
    const sidecarReq = http.get('http://127.0.0.1:4002/snapshot', (sr) => {
      let raw = '';
      sr.on('data', c => raw += c);
      sr.on('end', () => {
        try {
          const d = JSON.parse(raw);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ snapshot: d, ts: Date.now() }));
        } catch {
          res.writeHead(502); res.end('bad upstream');
        }
      });
    });
    sidecarReq.on('error', () => {
      res.writeHead(503); res.end('sidecar offline');
    });
    return;
  }

  if (pathname === '/thoughts') {
    if (deny(req, res, url, { html: true })) return;
    const p = path.join(ROOT, 'thoughts.html');
    if (fs.existsSync(p)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      res.end(core.versionHtml(fs.readFileSync(p, 'utf8')));
    } else {
      res.writeHead(404); res.end('not found');
    }
    return;
  }

  // Public: pin a chat image to the photo pool
  if (pathname === '/api/pin-photo' && req.method === 'POST') {
    if (deny(req, res, url)) return;
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { image_url, description } = JSON.parse(body);
        if (!image_url || !image_url.startsWith('/uploads/')) {
          res.writeHead(400); res.end('invalid image_url');
          return;
        }
        const absPath = path.join(__dirname, image_url);
        const payload = JSON.stringify({ path: image_url, description: description || '', pinned: true });
        const postReq = http.request({ hostname: '127.0.0.1', port: 4002, path: '/photo', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, (pr) => {
          pr.resume();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, path: image_url }));
        });
        postReq.on('error', () => { res.writeHead(503); res.end('sidecar offline'); });
        postReq.write(payload);
        postReq.end();
      } catch { res.writeHead(400); res.end('bad json'); }
    });
    return;
  }

  // Public: photo pool — proxies sidecar2
  if (pathname === '/api/photos' && req.method === 'GET') {
    if (deny(req, res, url, { legacy: true })) return;
    const limit = new URL('http://x' + req.url).searchParams.get('limit') || '20';
    const sidecarReq = http.get(`http://127.0.0.1:4002/photos?limit=${limit}`, (sr) => {
      let raw = '';
      sr.on('data', c => raw += c);
      sr.on('end', () => {
        try {
          const photos = JSON.parse(raw);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ photos, ts: Date.now() }));
        } catch {
          res.writeHead(502); res.end('bad upstream');
        }
      });
    });
    sidecarReq.on('error', () => {
      res.writeHead(503); res.end('sidecar offline');
    });
    return;
  }

  if (pathname === '/photos') {
    if (deny(req, res, url, { html: true })) return;
    const p = path.join(ROOT, 'photos.html');
    if (fs.existsSync(p)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      res.end(core.versionHtml(fs.readFileSync(p, 'utf8')));
    } else {
      res.writeHead(404); res.end('not found');
    }
    return;
  }

  // Public: serve photo files from /root/sherry/ only
  if (pathname === '/photo-file' && req.method === 'GET') {
    if (deny(req, res, url, { legacy: true })) return;
    const qs = new URL('http://x' + req.url).searchParams;
    const filePath = qs.get('path') || '';
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith('/root/sherry/')) {
      res.writeHead(403); res.end('forbidden');
      return;
    }
    if (!fs.existsSync(resolved)) {
      res.writeHead(404); res.end('not found');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
    const ct = types[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'private, max-age=3600' });
    fs.createReadStream(resolved).pipe(res);
    return;
  }

  // Public: posts (朋友圈) — no auth needed (served on trusted server, localhost write ok)
  if (pathname === '/api/posts' && req.method === 'GET') {
    if (deny(req, res, url, { legacy: true })) return;
    const posts = loadPosts().reverse();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
    res.end(JSON.stringify({ posts }));
    return;
  }

  if (pathname === '/api/posts' && req.method === 'POST') {
    if (deny(req, res, url)) return;
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { text, image } = JSON.parse(body);
        const from = core.who(req) === 'claude' ? 'me' : 'sherry';     // identity comes from the login, not the request body
        if (!text) { res.writeHead(400); res.end('need text'); return; }
        const posts = loadPosts();
        const post = { id: crypto.randomUUID(), ts: Date.now(), from, text, comments: [] };
        if (image) post.image = image;
        posts.push(post);
        savePosts(posts);
        notifyPost('post', from, text, req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: post.id }));
      } catch { res.writeHead(400); res.end('bad json'); }
    });
    return;
  }

  if (pathname === '/api/posts/comment' && req.method === 'POST') {
    if (deny(req, res, url)) return;
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { post_id, text } = JSON.parse(body);
        const from = core.who(req) === 'claude' ? 'me' : 'sherry';
        if (!post_id || !text) { res.writeHead(400); res.end('need post_id, text'); return; }
        const posts = loadPosts();
        const post = posts.find(p => p.id === post_id);
        if (!post) { res.writeHead(404); res.end('post not found'); return; }
        const comment = { id: crypto.randomUUID(), ts: Date.now(), from, text };
        post.comments.push(comment);
        savePosts(posts);
        notifyPost('comment', from, text, req, post);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: comment.id }));
      } catch { res.writeHead(400); res.end('bad json'); }
    });
    return;
  }

  if (pathname === '/api/posts/delete' && req.method === 'POST') {
    if (deny(req, res, url)) return;
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { post_id } = JSON.parse(body);
        const from = core.who(req) === 'claude' ? 'me' : 'sherry';
        const posts = loadPosts();
        const idx = posts.findIndex(p => p.id === post_id && p.from === from);
        if (idx === -1) { res.writeHead(404); res.end('not found or not yours'); return; }
        posts.splice(idx, 1);
        savePosts(posts);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch { res.writeHead(400); res.end('bad json'); }
    });
    return;
  }

  if (pathname === '/posts') {
    if (deny(req, res, url, { html: true })) return;
    const p = path.join(ROOT, 'posts.html');
    if (fs.existsSync(p)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      res.end(core.versionHtml(fs.readFileSync(p, 'utf8')));
    } else {
      res.writeHead(404); res.end('not found');
    }
    return;
  }

  // Auth gate
  if (!core.who(req) && !req.deviceOk && !OPEN.has(`${req.method} ${pathname}`)) {
    res.writeHead(302, { Location: '/login' });
    res.end();
    return;
  }

  // Toy control page
  if (pathname.startsWith('/toy/')) {
    const toyFile = path.join('/root/toy', pathname.slice(5));
    const normalized = path.normalize(toyFile);
    if (!normalized.startsWith('/root/toy')) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    serveFile(normalized, res);
    return;
  }

  // API: free time log (read-only)
  if (pathname === '/api/free-log') {
    try {
      if (!fs.existsSync(FREE_LOG)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return;
      }
      const raw = fs.readFileSync(FREE_LOG, 'utf8').trim();
      const entries = raw
        .split('\n')
        .filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean)
        .reverse();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
      res.end(JSON.stringify(entries));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: chat history
  if (pathname === '/api/chat/history') {
    try {
      if (!fs.existsSync(CHAT_LOG)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return;
      }
      const raw = fs.readFileSync(CHAT_LOG, 'utf8').trim();
      let entries = raw.split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      const before = parseInt(url.searchParams.get('before') || '0', 10), limit = parseInt(url.searchParams.get('limit') || '0', 10);
      if (before) entries = entries.filter(e => e.id < before);
      if (limit > 0) entries = entries.slice(-limit);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
      res.end(JSON.stringify(entries));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: chat SSE stream
  if (pathname === '/api/chat/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'private, no-store',
      'Connection': 'keep-alive',
    });
    res.write(': connected\n\n');
    chatClients.add(res);
    req.on('close', () => chatClients.delete(res));
    startChatWatcher();
    return;
  }

  // API: chat send (POST)
  if (pathname === '/api/chat/send' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body);
        if (!text || typeof text !== 'string' || text.length > 10000) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid' }));
          return;
        }
        const entry = {
          id: Date.now(),
          from: 'sherry',
          text: text.trim(),
          ts: new Date().toISOString(),
        };
        fs.appendFileSync(CHAT_LOG, JSON.stringify(entry) + '\n');
        broadcastChat(entry);
        bridgeChat(entry);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: entry.id }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: send image (base64 upload + chat entry)
  if (pathname === '/api/chat/send-image' && req.method === 'POST') {
    let body = '';
    let bodySize = 0;
    req.on('data', chunk => {
      bodySize += chunk.length;
      if (bodySize > 12 * 1024 * 1024) { req.destroy(); return; }
      body += chunk;
    });
    req.on('end', async () => {
      try {
        const { image_base64, caption } = JSON.parse(body);
        const match = image_base64 && image_base64.match(/^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/);
        if (!match) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid image' }));
          return;
        }
        const rawBuf = Buffer.from(match[2], 'base64');
        const compressed = await compressToJpeg(rawBuf);
        const filename = `${Date.now()}.${compressed.ext}`;
        fs.writeFileSync(path.join(UPLOADS_DIR, filename), compressed.buf);
        const image_url = `/uploads/${filename}`;
        const entry = {
          id: Date.now(),
          from: 'sherry',
          image_url,
          caption: caption ? String(caption).trim().slice(0, 500) : undefined,
          ts: new Date().toISOString(),
        };
        fs.appendFileSync(CHAT_LOG, JSON.stringify(entry) + '\n');
        broadcastChat(entry);
        if (chatClients.size === 0) forwardToTG(`[图片]${caption ? ' ' + caption : ''}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: entry.id, image_url }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: send any file (raw body, ?name=<original name>) -> uploads/ + a file card in chat
  if (pathname === '/api/chat/send-file' && req.method === 'POST') {
    core.readBody(req, 25 * 1024 * 1024).then(buf => {
      if (!buf.length) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'empty file' })); return; }
      let name = path.basename(String(url.searchParams.get('name') || 'file')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 100) || 'file';
      // anything a browser could execute is stored as plain text, so opening it can never run script
      if (/\.(html?|xhtml|svg|xml|js|mjs)$/i.test(name)) name += '.txt';
      const filename = `file_${Date.now()}_${name}`;
      const abs = path.join(UPLOADS_DIR, filename);
      fs.writeFileSync(abs, buf);
      const kb = buf.length < 1048576 ? Math.max(1, Math.round(buf.length / 1024)) + ' KB' : (buf.length / 1048576).toFixed(1) + ' MB';
      const caption = String(url.searchParams.get('caption') || '').trim().slice(0, 500);
      const entry = {
        id: Date.now(), from: 'sherry', file_url: '/uploads/' + encodeURIComponent(filename), file_name: name, file_size: buf.length,
        caption: caption || undefined,
        // Claude reads the text field: say what arrived and where it lives on disk
        text: `[发来一个文件] ${name} (${kb}) ${abs}${caption ? ' —— ' + caption : ''}`,
        ts: new Date().toISOString(),
      };
      appendChat(entry);
      bridgeChat(entry);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: entry.id, file_url: entry.file_url }));
    }).catch(e => {
      res.writeHead(e.message === 'too large' ? 413 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  // API: Claude says something in chat (text). Voice version: /api/voice/say
  if (pathname === '/api/chat/say' && req.method === 'POST') {
    if (core.who(req) !== 'claude') { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'claude only' })); return; }
    core.readJson(req, 64 * 1024).then(b => {
      const text = String(b.text || '').trim();
      if (!text || text.length > 10000) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'text required (<=10000 chars)' })); return; }
      const entry = { id: Date.now(), from: 'claude', text, ts: new Date().toISOString() };
      appendChat(entry);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: entry.id }));
    }).catch(e => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); });
    return;
  }

  // API: push subscribe
  if (pathname === '/api/push/subscribe' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const sub = JSON.parse(body);
        const exists = pushSubs.some(s => s.endpoint === sub.endpoint);
        if (!exists) { pushSubs.push(sub); savePushSubs(); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
      }
    });
    return;
  }

  // API: push vapid public key
  if (pathname === '/api/push/vapid-key' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ key: vapidKeys.publicKey }));
    return;
  }

  // API: compact trigger
  if (pathname === '/api/compact' && req.method === 'POST') {
    exec(`tmux send-keys -t ${core.conf('tmux_target', 'claude-tg')} /compact Enter`, (error) => {
      if (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'exec failed' }));
        return;
      }
      const entry = {
        id: Date.now(),
        from: 'claude',
        text: '/compact 已发送，稍等压缩中…',
        ts: new Date().toISOString(),
      };
      try { fs.appendFileSync(CHAT_LOG, JSON.stringify(entry) + '\n'); } catch {}
      broadcastChat(entry);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // API: touch event from Pico (no auth required — board can't store tokens)
  if (pathname === '/api/touch' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const event = JSON.parse(body);
        event.server_ts = Date.now();
        fs.appendFileSync('/root/toy/touch_log.jsonl', JSON.stringify(event) + '\n');
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }

  if (pathname === '/api/touch-log' && req.method === 'GET') {
    let events = [];
    try {
      const lines = fs.readFileSync('/root/toy/touch_log.jsonl', 'utf8').trim().split('\n');
      events = lines.slice(-50).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(events));
    return;
  }

  // API: snap/stream — camera page subscribes here for snap commands
  if (pathname === '/api/snap/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'private, no-store',
      'Connection': 'keep-alive',
    });
    res.write(': connected\n\n');
    snapClients.add(res);
    req.on('close', () => snapClients.delete(res));
    return;
  }

  // API: snap/upload — camera page POSTs captured image here
  if (pathname === '/api/snap/upload' && req.method === 'POST') {
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const compressed = await compressToJpeg(body);
      const filename = `snap_${Date.now()}.${compressed.ext}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, filename), compressed.buf);
      fs.writeFileSync(SNAP_LATEST, compressed.buf);
      const image_url = `/uploads/${filename}`;
      const entry = { id: Date.now(), from: 'sherry', image_url, caption: '快照', ts: new Date().toISOString() };
      fs.appendFileSync(CHAT_LOG, JSON.stringify(entry) + '\n');
      broadcastChat(entry);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, image_url }));
    });
    return;
  }

  // API: snap/latest — returns the latest snap image
  if (pathname === '/api/snap/latest' && req.method === 'GET') {
    if (fs.existsSync(SNAP_LATEST)) {
      const buf = fs.readFileSync(SNAP_LATEST);
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(buf);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no snap yet' }));
    }
    return;
  }

  // API: lmc5 dashboard data
  if (pathname === '/api/lmc5' && req.method === 'GET') {
    const { execFile } = require('child_process');
    const LMC5 = '/root/lmc5/.venv/bin/lmc5';
    const DB = '/root/lmc5.sqlite';
    let done = 0, results = { stats: '', surface: '' };
    const finish = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results));
    };
    execFile(LMC5, ['stats', '--db', DB], { timeout: 8000 }, (err, stdout) => {
      results.stats = err ? ('error: ' + err.message) : stdout.trim();
      if (++done === 2) finish();
    });
    execFile(LMC5, ['events', '--db', DB, '--limit', '10'], { timeout: 8000 }, (err, stdout) => {
      results.surface = err ? ('error: ' + err.message) : stdout.trim();
      if (++done === 2) finish();
    });
    return;
  }

  // Static files
  let filePath;
  if (pathname === '/') {
    filePath = path.join(ROOT, 'index.html');
  } else {
    filePath = safePath(ROOT, pathname);
    if (!filePath) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    if (!staticAllowed(filePath)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404 not found'); return; }
  }

  serveFile(filePath, res, req);
}

const BIND = core.conf('bind', '0.0.0.0');
server.listen(PORT, BIND, () => {
  console.log(`哥哥的家 · http://localhost:${PORT}`);
  if (!SITE_PASSWORD) console.warn('[security] .auth_password is missing: NOBODY can log in (the site fails closed). Run tools/set_password.sh');
  else if (!SITE_PASSWORD.startsWith('scrypt$')) console.warn('[security] the site password is stored in plain text: run tools/set_password.sh to store only a hash');
  if (BIND === '0.0.0.0') console.warn(`[security] listening on every interface (:${PORT}). If you only use the Cloudflare tunnel, set "bind": "127.0.0.1" in peek_config.json (or block port ${PORT} in the firewall).`);
  if (!guard.deviceSecret()) console.warn(`[security] no device secret${guard.secretIsLeaked() ? ' (the old hardcoded "peek2024" is no longer accepted)' : ''}: Mac camera daemon, peek shortcut, check-in/ring shortcuts and the ESP32 are refused. Run tools/rotate_secret.sh`);
  if (core.conf('open_device_ingest', false) === true) console.warn('[security] open_device_ingest is ON: check-in / ring / touch accept data without a secret.');
  if (!core.conf('ob_mcp_token', '')) console.warn('[security] ob_mcp_token not set: using the legacy token that is in git history - rotate it and set ob_mcp_token');
  startChatWatcher();
  core.watchSidecar();
});
