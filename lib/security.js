// The one place that decides what the outside world may see, and keeps the receipts.
//   - sessions: stored hashed, with device info, so Sherry can see and end them
//   - audit log: who logged in / failed / was turned away (never any content)
//   - panic lock: end every login and refuse new ones until unlocked from the server
//   - response headers: nothing private may be cached by Cloudflare or a browser's shared cache,
//     nothing may be framed, indexed, or send a Referer
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./core');

const SESSIONS_FILE = path.join(core.ROOT, '.sessions');
const LOCK_FILE = path.join(core.ROOT, '.lock');
const AUDIT_FILE = path.join(core.ROOT, 'audit.jsonl');
const MAX_AGE = 30 * 24 * 3600 * 1000;

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const clientIp = req => req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
const isHttps = req => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || /"scheme":"https"/.test(String(req.headers['cf-visitor'] || ''));

function device(req) {
  const ua = String(req.headers['user-agent'] || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '未知设备';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /Version\/.*Mobile/.test(ua) ? 'Safari' : '';
  return br ? `${os} · ${br}` : os;
}

// ---- sessions -------------------------------------------------------------------
let sessions = {};            // sha256(token) -> { created, last, device, ip }
try {
  const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  if (Array.isArray(raw)) raw.forEach(t => { sessions[sha(t)] = { created: Date.now(), last: Date.now(), device: '之前登录的设备', ip: '' }; });   // old plaintext format
  else sessions = raw;
} catch {}
let saveTimer = null;
function saveSessions(now) {
  const write = () => { saveTimer = null; try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions), { mode: 0o600 }); } catch {} };
  if (now) { clearTimeout(saveTimer); return write(); }
  if (!saveTimer) { saveTimer = setTimeout(write, 5000); saveTimer.unref(); }       // lastSeen updates don't need a write each time
}
const cookieToken = req => { const m = /(?:^|;\s*)session=([0-9a-f]{64})/.exec(req.headers.cookie || ''); return m && m[1]; };

function createSession(req) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions[sha(token)] = { created: now, last: now, device: device(req), ip: clientIp(req) };
  saveSessions(true);
  return token;
}
function currentHash(req) { const t = cookieToken(req); return t ? sha(t) : null; }
function checkSession(req) {
  const h = currentHash(req);
  const s = h && sessions[h];
  if (!s) return false;
  if (Date.now() - s.created > MAX_AGE) { delete sessions[h]; saveSessions(); return false; }
  s.last = Date.now(); saveSessions();
  return true;
}
function revokeCurrent(req) { const h = currentHash(req); if (h && sessions[h]) { delete sessions[h]; saveSessions(true); } }
function revokeById(id, req) {
  const h = Object.keys(sessions).find(k => k.startsWith(String(id)) && String(id).length >= 8);
  if (!h) return false;
  delete sessions[h]; saveSessions(true); audit('session_revoked', req, { device: id.slice(0, 8) }); return true;
}
function revokeAll(req, keepCurrent) {
  const keep = keepCurrent ? currentHash(req) : null;
  const n = Object.keys(sessions).filter(h => h !== keep).length;
  for (const h of Object.keys(sessions)) if (h !== keep) delete sessions[h];
  saveSessions(true); audit('logout_all', req, { count: n }); return n;
}
function listSessions(req) {
  const me = currentHash(req);
  return Object.entries(sessions).map(([h, s]) => ({ id: h.slice(0, 12), device: s.device, ip: s.ip, created: s.created, last: s.last, current: h === me }))
    .sort((a, b) => b.last - a.last);
}
function sessionCookie(token, req) {
  return `session=${token}; HttpOnly; Path=/; Max-Age=${MAX_AGE / 1000}; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`;
}
const clearCookie = req => `session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`;

// ---- panic lock -----------------------------------------------------------------
let locked = fs.existsSync(LOCK_FILE);
const isLocked = () => locked;
function setLocked(on, req) {
  locked = !!on;
  try { if (on) fs.writeFileSync(LOCK_FILE, new Date().toISOString(), { mode: 0o600 }); else fs.unlinkSync(LOCK_FILE); } catch {}
  if (on) { sessions = {}; saveSessions(true); }
  audit(on ? 'locked' : 'unlocked', req);
}

// ---- audit log ------------------------------------------------------------------
const seen = new Map();
function audit(type, req, extra = {}) {
  const ip = req ? clientIp(req) : '';
  if (type === 'denied') {                                       // a scanner hammering one path is one line a minute, not thousands
    const k = ip + (extra.path || ''); const t = seen.get(k) || 0;
    if (Date.now() - t < 60000) return; seen.set(k, Date.now());
    if (seen.size > 2000) seen.clear();
  }
  const row = { ts: new Date().toISOString(), type, ip, via: req && (req.headers['cf-connecting-ip'] ? 'tunnel' : 'direct'), device: req ? device(req) : undefined, ...extra };
  try {
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(row) + '\n', { mode: 0o600 });
    if (fs.statSync(AUDIT_FILE).size > 2 * 1024 * 1024) fs.renameSync(AUDIT_FILE, AUDIT_FILE + '.1');
  } catch {}
}
const recentAudit = n => core.readJsonl(AUDIT_FILE).slice(-n).reverse();

// ---- request hygiene ---------------------------------------------------------------
// Cookie-authenticated writes must come from our own pages (blocks "some other website makes your browser post").
function originOk(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && !['same-origin', 'none'].includes(sfs)) return false;
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

const CSP = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "media-src 'self' blob:", "connect-src 'self'", "font-src 'self'",
  "worker-src 'self' blob:", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'",
].join('; ');

function headers(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  // private by default: a shared cache (Cloudflare, a proxy) must never keep or replay any of this
  res.setHeader('Cache-Control', 'private, no-store');
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

// ---- password: stored as a scrypt hash (plaintext in .auth_password still works until you run tools/set_password.sh)
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function verifyPassword(input, stored) {
  if (!stored) return false;
  if (stored.startsWith('scrypt$')) {
    const [, saltHex, hashHex] = stored.split('$');
    try {
      const h = crypto.scryptSync(String(input), Buffer.from(saltHex, 'hex'), 32, { N: 16384, r: 8, p: 1 });
      return crypto.timingSafeEqual(h, Buffer.from(hashHex, 'hex'));
    } catch { return false; }
  }
  const a = Buffer.from(String(input)), b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  createSession, checkSession, revokeCurrent, revokeById, revokeAll, listSessions, sessionCookie, clearCookie,
  isLocked, setLocked, audit, recentAudit, originOk, headers, hashPassword, verifyPassword, clientIp, isHttps, device,
};
