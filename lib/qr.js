// 扫码: Claude screenshots a login QR (tools/qr_capture.js or any script that can
// POST an image) -> it lands on /qr and rings Sherry at once (SSE + push).
const fs = require('fs');
const path = require('path');
const core = require('./core');

const QR_FILE = path.join(core.ROOT, 'qr.png');   // same file the old /qr.png route serves
const META_FILE = path.join(core.ROOT, 'qr_meta.json');

const meta = () => { try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch { return null; } };

async function handle(req, res, url) {
  const p = url.pathname;
  if (p === '/qr') {
    if (!core.who(req)) { res.writeHead(302, { Location: '/login' }); res.end(); return true; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(fs.readFileSync(path.join(core.ROOT, 'qr.html')));
    return true;
  }
  if (!p.startsWith('/api/qr')) return false;
  const me = core.who(req);
  if (!me) { core.json(res, 401, { error: 'login required' }); return true; }

  if (p === '/api/qr/current' && req.method === 'GET') { core.json(res, 200, { qr: meta() }); return true; }
  if (p === '/api/qr/image' && req.method === 'GET') {
    if (!fs.existsSync(QR_FILE)) { res.writeHead(404); res.end(); return true; }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    fs.createReadStream(QR_FILE).pipe(res);
    return true;
  }
  if (p === '/api/qr/push' && req.method === 'POST') {
    if (me !== 'claude') { core.json(res, 403, { error: 'claude only' }); return true; }
    try {
      const buf = await core.readBody(req, 5 * 1024 * 1024);
      const isPng = buf.slice(0, 4).toString('hex') === '89504e47';
      const isJpg = buf.slice(0, 2).toString('hex') === 'ffd8';
      if (!isPng && !isJpg) { core.json(res, 400, { error: 'send a png/jpg body' }); return true; }
      fs.writeFileSync(QR_FILE, buf);
      const label = (url.searchParams.get('label') || '二维码').slice(0, 40);
      const ttl = Math.max(30, Math.min(900, parseInt(url.searchParams.get('ttl') || '180', 10) || 180));
      const m = { label, ts: Date.now(), ttl };
      fs.writeFileSync(META_FILE, JSON.stringify(m));
      core.notify({ type: '扫码', actor: 'claude', title: `昀推来一个二维码：${label}`, body: `${Math.round(ttl / 60 * 10) / 10} 分钟内有效，点开直接扫`, link: '/qr' });
      core.json(res, 200, { ok: true, ...m });
    } catch (e) {
      core.json(res, e.message === 'too large' ? 413 : 500, { error: e.message });
    }
    return true;
  }
  core.json(res, 404, { error: 'not found' });
  return true;
}

module.exports = { handle };
