// 手机通道的服务器一侧: where the Android phone's screenshots land.
//   POST /api/phone/screen   (device secret, or 昀)  raw image body -> /root/claude-home/phone/latest.jpg
//   GET  /api/phone/screen   (莹 or 昀)              the newest screenshot
// Deliberately NOT a chat message: a phone screen can show codes, notifications, other people's messages.
// Files are 0600 in a 0700 folder and are deleted after `phone_keep_hours` (default 24).
const fs = require('fs');
const path = require('path');
const core = require('./core');
const guard = require('./guard');
const security = require('./security');
let sharp; try { sharp = require('sharp'); } catch {}

const DIR = path.join(core.ROOT, 'phone');
const keepMs = () => Math.max(1, Number(core.conf('phone_keep_hours', 24)) || 24) * 3600 * 1000;

function prune() {
  try {
    for (const f of fs.readdirSync(DIR)) {
      if (!/^screen_\d+\.jpg$/.test(f)) continue;
      const p = path.join(DIR, f);
      if (Date.now() - fs.statSync(p).mtimeMs > keepMs()) fs.unlinkSync(p);
    }
  } catch {}
}
setInterval(prune, 3600 * 1000).unref();

async function handle(req, res, url) {
  const p = url.pathname;
  if (p !== '/api/phone/screen') return false;

  if (req.method === 'GET') {
    if (!core.who(req)) { core.json(res, 401, { error: 'login required' }); return true; }
    const f = path.join(DIR, 'latest.jpg');
    if (!fs.existsSync(f)) { core.json(res, 404, { error: 'no screenshot yet' }); return true; }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store' });
    fs.createReadStream(f).pipe(res);
    return true;
  }
  if (req.method !== 'POST') { core.json(res, 405, { error: 'POST or GET' }); return true; }
  if (!core.who(req) && !guard.secretOk(req, url)) { core.json(res, 401, { error: 'login required' }); return true; }

  try {
    const raw = await core.readBody(req, 15 * 1024 * 1024);
    const isPng = raw.slice(0, 4).toString('hex') === '89504e47', isJpg = raw.slice(0, 2).toString('hex') === 'ffd8';
    if (!isPng && !isJpg) { core.json(res, 400, { error: 'send a png or jpeg body' }); return true; }
    // phone screens are tall and sharp; ~900px wide is plenty for reading them and keeps the image cheap to look at
    const jpg = sharp ? await sharp(raw).rotate().resize({ width: 900, withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer() : raw;
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const stamp = Date.now();
    fs.writeFileSync(path.join(DIR, `screen_${stamp}.jpg`), jpg, { mode: 0o600 });
    fs.writeFileSync(path.join(DIR, 'latest.jpg'), jpg, { mode: 0o600 });
    prune();
    security.audit('phone_screen', req, { bytes: jpg.length });       // that it happened, never what it showed
    core.json(res, 200, { ok: true, path: path.join(DIR, 'latest.jpg'), bytes: jpg.length, keep_hours: keepMs() / 3600000 });
  } catch (e) {
    core.json(res, e.message === 'too large' ? 413 : 500, { error: e.message });
  }
  return true;
}

module.exports = { handle };
