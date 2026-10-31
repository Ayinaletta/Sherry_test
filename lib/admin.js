// 隐私与安全: what Sherry (and 昀) can see and do about who has access.
//   GET  /security                    the page
//   GET  /api/security/overview       logged-in devices, recent refusals/logins, checklist
//   POST /api/security/session/revoke {id}
//   POST /api/security/logout-all     {keepCurrent}
//   POST /api/security/lock           {on}   (turning it off: 昀 only, from the server)
//   GET  /api/help                    every endpoint, one line each (for 昀's scripts)
//   GET  /api/status                  server health details
const fs = require('fs');
const path = require('path');
const core = require('./core');
const guard = require('./guard');
const security = require('./security');

const BACKUP_DIR = () => core.conf('backup_dir', '/root/backups');

function newestBackup() {
  try {
    const f = fs.readdirSync(BACKUP_DIR()).filter(n => /^data-.*\.tar\.gz(\.enc)?$/.test(n))
      .map(n => ({ n, t: fs.statSync(path.join(BACKUP_DIR(), n)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
    return f || null;
  } catch { return null; }
}

function checklist(req) {
  let pw = ''; try { pw = fs.readFileSync(path.join(core.ROOT, '.auth_password'), 'utf8').trim(); } catch {}
  const bk = newestBackup(); const days = bk ? (Date.now() - bk.t) / 86400000 : null;
  const bind = core.conf('bind', '0.0.0.0');
  return [
    { ok: !!pw, text: pw ? '站点有密码，没有密码的话谁都进不来' : '还没有设置密码，现在谁也登录不了：运行 tools/set_password.sh' },
    { ok: pw.startsWith('scrypt$'), text: pw.startsWith('scrypt$') ? '密码只以哈希形式保存' : '密码还是明文保存：运行 tools/set_password.sh 改成哈希' },
    { ok: security.isHttps(req) || core.localDirect(req), text: (security.isHttps(req) || core.localDirect(req)) ? '你现在是通过加密连接（HTTPS）在访问' : '当前连接不是 HTTPS，别在这里输入密码' },
    { ok: bind !== '0.0.0.0', text: bind !== '0.0.0.0' ? `只监听 ${bind}，不能绕过隧道直连` : '服务器监听所有网卡，确认防火墙封了 3000 端口，或在 peek_config.json 设 "bind": "127.0.0.1"' },
    { ok: !!guard.deviceSecret(), text: guard.deviceSecret() ? '设备口令已设置（Mac 摄像头 / 快捷指令 / 小小昀）' : '设备口令未设置，设备推送被拒绝：运行 tools/rotate_secret.sh' },
    { ok: core.conf('open_device_ingest', false) !== true, text: core.conf('open_device_ingest', false) !== true ? '设备推送必须带口令' : 'open_device_ingest 开着：打卡 / 心率 / 触摸不带口令也能写入' },
    { ok: !!core.conf('ob_mcp_token', ''), text: core.conf('ob_mcp_token', '') ? 'OB token 已从配置读取' : 'OB token 还是 git 历史里的旧值：去 OB 重新生成并写进 peek_config.json' },
    { ok: bk && days < 2, text: bk ? `最近一次备份：${days < 1 ? '今天' : Math.floor(days) + ' 天前'}${/\.enc$/.test(bk.n) ? '（已加密）' : '（未加密，只放在本机就还好；传到别处前请加密）'}` : '还没有备份：运行 tools/backup.sh，并启用 deploy/claude-backup.timer' },
    { ok: !security.isLocked(), text: security.isLocked() ? '现在处于「锁门」状态' : '门是开着的（正常状态）' },
  ];
}

const HELP = [
  ['GET  /api/chat/history?limit=N&before=ID', '聊天记录（最新 N 条；before 往前翻页）'],
  ['POST /api/chat/say {text}', '昀在聊天里说话（文字）'],
  ['POST /api/voice/say {text}', '昀在聊天里说话（语音，ElevenLabs）'],
  ['POST /api/chat/claude-image {file_path,caption}', '昀发一张服务器上的图片'],
  ['GET  /api/posts · POST /api/posts {text} · POST /api/posts/comment {post_id,text}', '朋友圈（作者自动是昀）'],
  ['GET  /api/photos · GET /api/thoughts', '照片池 / 念头池'],
  ['GET  /api/reading · GET /api/reading/<id>/unit/<n> · POST /api/reading/<id>/annotations', '共读：列表 / 读第 n 段 / 批注'],
  ['GET  /api/checkin?date=YYYY-MM-DD · GET /api/ring · GET /api/touch-log', '莹的打卡 / 戒指 / 小小昀触摸记录'],
  ['POST /api/qr/push?label=…', '推送二维码给莹'],
  ['POST /api/snap · GET /api/snap/status', '触发 Mac 摄像头 / 看有没有设备在线'],
  ['GET  /api/inbox?since=ID', '昀错过的新家事件'],
  ['GET  /api/security/overview · POST /api/security/lock {on} · POST /api/security/logout-all', '谁登录着 / 锁门 / 退出所有设备'],
  ['GET  /api/status', '服务器健康（tmux、sidecar、备份）'],
];

async function handle(req, res, url) {
  const p = url.pathname;
  if (p === '/security') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store' });
    res.end(core.versionHtml(fs.readFileSync(path.join(core.ROOT, 'security.html'), 'utf8')));
    return true;
  }
  if (!p.startsWith('/api/security') && p !== '/api/help' && p !== '/api/status') return false;
  const me = core.who(req);
  if (!me) { core.json(res, 401, { error: 'login required' }); return true; }

  try {
    if (p === '/api/help') { core.json(res, 200, { base: 'http://127.0.0.1:3000 (direct local calls need no key)', endpoints: HELP.map(([call, what]) => ({ call, what })) }); return true; }
    if (p === '/api/status') {
      core.tmuxAlive(tmux => core.sidecar('/snapshot', err => {
        const bk = newestBackup();
        core.json(res, 200, { ok: true, uptime_s: Math.round(process.uptime()), claude_session: tmux, sidecar: !err, locked: security.isLocked(), last_backup: bk ? new Date(bk.t).toISOString() : null, bind: core.conf('bind', '0.0.0.0') });
      }));
      return true;
    }
    if (p === '/api/security/overview' && req.method === 'GET') {
      core.json(res, 200, { me, locked: security.isLocked(), sessions: security.listSessions(req), recent: security.recentAudit(60), checks: checklist(req) });
      return true;
    }
    if (req.method !== 'POST') { core.json(res, 404, { error: 'not found' }); return true; }
    const b = await core.readJson(req, 4096);
    if (p === '/api/security/session/revoke') { core.json(res, 200, { ok: security.revokeById(String(b.id || ''), req) }); return true; }
    if (p === '/api/security/logout-all') { core.json(res, 200, { ok: true, ended: security.revokeAll(req, !!b.keepCurrent) }); return true; }
    if (p === '/api/security/lock') {
      if (!b.on && me !== 'claude') { core.json(res, 403, { error: 'only the server side (昀) can unlock' }); return true; }
      security.setLocked(!!b.on, req);
      core.notify({ type: '安全', actor: 'system', title: b.on ? '门锁上了，所有登录已结束' : '门打开了', link: '/security', chat: false });
      core.json(res, 200, { ok: true, locked: security.isLocked() });
      return true;
    }
    core.json(res, 404, { error: 'not found' });
  } catch (e) { core.json(res, 500, { error: e.message }); }
  return true;
}

module.exports = { handle };
