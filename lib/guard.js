// Who may call an endpoint. One place, so every route answers the same question the same way.
//   claude  : X-Home-Key header, or a process on this machine talking to 127.0.0.1 directly
//   sherry  : a logged-in browser session
//   device  : a phone shortcut / Mac daemon / ESP32 that can only carry a shared secret in the URL
const crypto = require('crypto');
const core = require('./core');

// the value that used to be hardcoded in the repo and the public mac_snap_daemon.py: never valid again
const LEAKED = new Set(['peek2024']);

const same = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };

function deviceSecret() {
  const s = String(core.conf('device_secret', '') || core.fileConf('secret') || '');
  return LEAKED.has(s) ? '' : s;
}
const secretIsLeaked = () => LEAKED.has(String(core.conf('device_secret', '') || core.fileConf('secret') || ''));

function secretOk(req, url) {
  const want = deviceSecret();
  if (!want) return false;
  const got = (url && url.searchParams.get('secret')) || req.headers['x-device-secret'] || '';
  return same(got, want);
}

const who = req => core.who(req);
const localDirect = req => core.localDirect(req);

const clientIp = req => req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

// login throttle: 8 wrong passwords per 10 minutes per address
const fails = new Map();
function loginBlocked(req) { const f = fails.get(clientIp(req)); return !!f && f.n >= 8 && Date.now() - f.t < 600000; }
function loginFailed(req) { const ip = clientIp(req); const f = fails.get(ip); if (!f || Date.now() - f.t > 600000) fails.set(ip, { n: 1, t: Date.now() }); else { f.n++; f.t = Date.now(); } }
function loginOk(req) { fails.delete(clientIp(req)); }

module.exports = { who, localDirect, secretOk, deviceSecret, secretIsLeaked, same, clientIp, loginBlocked, loginFailed, loginOk, LEAKED };
