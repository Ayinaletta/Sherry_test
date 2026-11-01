// 递钥匙: a place for 莹 to hand 昀 a secret without it ever passing through chat, push previews or logs.
//   GET  /vault                       the page
//   GET  /api/vault/status            which keys are in place (never their values)
//   POST /api/vault/cf-access         {id, secret}  -> <vault_dir>/cf-access (two lines: id, secret), mode 0600, dir 0700
//   POST /api/vault/cf-access/clear   remove it
// Only 莹's login may put keys in (not 昀, not a device). 昀 gets one line: "the key is in place at <path>", never the value;
// his tools (tools/check_phone_door.sh, the MCP config) read the file themselves.
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('./core');
const security = require('./security');

const dir = () => core.conf('vault_dir', path.join(os.homedir(), '.config', 'phone'));
const file = () => path.join(dir(), 'cf-access');

// one line, no spaces: stops anyone from smuggling a second line (and with it a second "secret") into the file
const clean = (v, max) => { v = String(v ?? '').trim(); return v && v.length >= 8 && v.length <= max && !/[\s\u0000-\u001f\u007f]/.test(v) ? v : null; };

async function handle(req, res, url) {
  const p = url.pathname;
  if (p === '/vault') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' });
    res.end(core.versionHtml(fs.readFileSync(path.join(core.ROOT, 'vault.html'), 'utf8')));
    return true;
  }
  if (!p.startsWith('/api/vault/')) return false;
  const me = core.who(req);
  if (!me) { core.json(res, 401, { error: 'login required' }); return true; }

  try {
    if (p === '/api/vault/status' && req.method === 'GET') {
      let st = null; try { st = fs.statSync(file()); } catch {}
      core.json(res, 200, { cf_access: { present: !!st, updated: st ? st.mtimeMs : null, path: file() } });
      return true;
    }
    if (req.method !== 'POST') { core.json(res, 405, { error: 'POST' }); return true; }
    if (me !== 'sherry') { core.json(res, 403, { error: 'only 莹 can hand over keys' }); return true; }

    if (p === '/api/vault/cf-access') {
      const b = await core.readJson(req, 4096);
      const id = clean(b.id, 200), secret = clean(b.secret, 400);
      if (!id || !secret) { core.json(res, 400, { error: 'both fields are needed, without spaces or line breaks' }); return true; }
      fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
      try { fs.chmodSync(dir(), 0o700); } catch {}
      const tmp = file() + '.tmp';
      fs.writeFileSync(tmp, `${id}\n${secret}\n`, { mode: 0o600 });
      fs.renameSync(tmp, file());
      security.audit('vault_set', req, { path: 'cf-access' });                        // that a key was handed over, never which
      core.notify({ type: '安全', actor: 'sherry', title: '莹把手机门的令牌放好了', body: `文件 ${file()}，现在可以运行 tools/check_phone_door.sh`, link: '/vault', chat: false });
      core.json(res, 200, { ok: true });
      return true;
    }
    if (p === '/api/vault/cf-access/clear') {
      try { fs.unlinkSync(file()); } catch {}
      security.audit('vault_clear', req, { path: 'cf-access' });
      core.json(res, 200, { ok: true });
      return true;
    }
    core.json(res, 404, { error: 'not found' });
  } catch (e) { core.json(res, 500, { error: e.message }); }
  return true;
}

module.exports = { handle };
