#!/usr/bin/env node
// 昀's one command for the house:  tools/home.sh <command>   (or: node tools/home.js <command>)
// Talks to http://127.0.0.1:3000 as a direct local caller; also sends X-Home-Key when .claude_key exists.
const fs = require('fs');
const path = require('path');
const BASE = process.env.HOME_URL || 'http://127.0.0.1:3000';
let KEY = ''; try { KEY = fs.readFileSync(path.join(__dirname, '..', '.claude_key'), 'utf8').trim(); } catch {}

async function api(method, p, body, raw) {
  const headers = KEY ? { 'X-Home-Key': KEY } : {};
  let data;
  if (body !== undefined && !raw) { headers['Content-Type'] = 'application/json'; data = JSON.stringify(body); }
  if (raw) { headers['Content-Type'] = raw; data = body; }
  const r = await fetch(BASE + p, { method, headers, body: data });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) { console.error(`${r.status} ${typeof j === 'string' ? j : j.error || JSON.stringify(j)}`); process.exit(1); }
  return j;
}
const out = o => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));
const when = ts => new Date(ts).toLocaleString('zh-CN', { hour12: false });
const rest = (a, n) => a.slice(n).join(' ');
const say = { sherry: '莹', claude: '昀', system: '·', me: '昀' };

const C = {
  help: ['help', '这份说明', async () => console.log(Object.entries(C).map(([k, v]) => `  ${k.padEnd(10)} ${v[0].padEnd(34)} ${v[1]}`).join('\n'))],
  chat: ['chat [N=20]', '最近 N 条聊天', async a => { (await api('GET', `/api/chat/history?limit=${a[1] || 20}`)).forEach(e => console.log(`${when(e.ts)}  ${say[e.from] || e.from}: ${e.text || (e.audio_url ? '[语音]' : e.image_url ? '[图片]' : e.file_name ? '[文件 ' + e.file_name + ']' : '')}`)); }],
  say: ['say <文字>', '昀在聊天里说话', async a => out(await api('POST', '/api/chat/say', { text: rest(a, 1) }))],
  voice: ['voice <文字>', '昀发语音', async a => out(await api('POST', '/api/voice/say', { text: rest(a, 1) }))],
  image: ['image <路径> [说明]', '昀发一张服务器上的图片', async a => out(await api('POST', '/api/chat/claude-image', { file_path: path.resolve(a[1]), caption: rest(a, 2) || undefined }))],
  posts: ['posts [N=5]', '朋友圈最新 N 条', async a => (await api('GET', '/api/posts')).posts.slice(0, +a[1] || 5).forEach(p => { console.log(`[${p.id.slice(0, 8)}] ${when(p.ts)} ${say[p.from] || p.from}: ${p.text}`); p.comments.forEach(c => console.log(`      ${say[c.from] || c.from}: ${c.text}`)); })],
  post: ['post <文字>', '发朋友圈（作者是昀）', async a => out(await api('POST', '/api/posts', { text: rest(a, 1) }))],
  comment: ['comment <帖子id前缀> <文字>', '评论', async a => { const ps = (await api('GET', '/api/posts')).posts; const p = ps.find(x => x.id.startsWith(a[1])); if (!p) { console.error('找不到这条动态'); process.exit(1); } out(await api('POST', '/api/posts/comment', { post_id: p.id, text: rest(a, 2) })); }],
  photos: ['photos', '照片池', async () => out(await api('GET', '/api/photos?limit=20'))],
  thoughts: ['thoughts', '念头池', async () => out(await api('GET', '/api/thoughts'))],
  checkin: ['checkin [YYYY-MM-DD]', '莹的 App 打卡', async a => out(await api('GET', '/api/checkin' + (a[1] ? `?date=${a[1]}` : '')))],
  ring: ['ring', '戒指最新数据', async () => out(await api('GET', '/api/ring'))],
  reading: ['reading [list|read <id> <n>|note <id> <n> <原文> <批注>|reply <id> <批注id> <文字>]', '共读', async a => {
    const s = a[1] || 'list';
    if (s === 'list') return out((await api('GET', '/api/reading')).docs.map(d => `${d.id}  《${d.title}》 ${d.units}${d.kind === 'pdf' ? '页' : '段'}  我读到 ${d.progress + 1}  她读到 ${d.otherProgress + 1}  批注 ${d.annotations}${d.locked ? '（还有 ' + d.locked + ' 条锁着）' : ''}`).join('\n'));
    if (s === 'read') { const r = await api('GET', `/api/reading/${a[2]}/unit/${a[3]}`); console.log(r.text); r.annotations.forEach(x => console.log(`\n  ── ${say[x.author]}: 「${x.quote}」 ${x.note}  [${x.id.slice(0, 8)}]` + x.replies.map(y => `\n       ${say[y.author]}: ${y.text}`).join(''))); return; }
    if (s === 'note') return out(await api('POST', `/api/reading/${a[2]}/annotations`, { unit: +a[3], quote: a[4], note: rest(a, 5) }));
    if (s === 'reply') return out(await api('POST', `/api/reading/${a[2]}/annotations/${a[3]}/reply`, { text: rest(a, 4) }));
    console.error('reading list | read <id> <n> | note <id> <n> <原文> <批注> | reply <id> <批注id> <文字>'); process.exit(1);
  }],
  qr: ['qr <png> [标签] [秒]', '把二维码推给莹', async a => out(await api('POST', `/api/qr/push?label=${encodeURIComponent(a[2] || '二维码')}&ttl=${a[3] || 180}`, fs.readFileSync(a[1]), 'image/png'))],
  snap: ['snap', '触发 Mac 摄像头', async () => out(await api('POST', '/api/snap'))],
  inbox: ['inbox [since_id]', '我错过的新家事件', async a => (await api('GET', `/api/inbox?since=${a[1] || 0}`)).items.forEach(i => console.log(`${i.id}  ${i.line}`))],
  status: ['status', '服务器状态', async () => out(await api('GET', '/api/status'))],
  security: ['security', '安全总览（谁登录着、检查清单）', async () => { const d = await api('GET', '/api/security/overview'); console.log(d.locked ? '【门锁着】' : '门开着'); d.checks.forEach(c => console.log(`  ${c.ok ? '✓' : '✗'} ${c.text}`)); console.log('登录着：'); d.sessions.forEach(s => console.log(`  ${s.id}  ${s.device}  ${s.ip}  最后活动 ${when(s.last)}${s.current ? '  (当前)' : ''}`)); }],
  audit: ['audit [N=30]', '最近的登录 / 拒绝记录', async a => (await api('GET', '/api/security/overview')).recent.slice(0, +a[1] || 30).forEach(e => console.log(`${e.ts}  ${e.type.padEnd(14)} ${e.ip || ''} ${e.device || ''} ${e.path || ''}`))],
  lock: ['lock', '锁门：结束所有登录并拒绝新登录', async () => out(await api('POST', '/api/security/lock', { on: true }))],
  unlock: ['unlock', '开门', async () => out(await api('POST', '/api/security/lock', { on: false }))],
  'logout-all': ['logout-all', '让所有设备退出登录', async () => out(await api('POST', '/api/security/logout-all', {}))],
  call: ['call GET|POST|DELETE <路径> [json]', '直接调任意接口', async a => out(await api(a[1].toUpperCase(), a[2], a[3] ? JSON.parse(a[3]) : undefined))],
};

(async () => {
  const a = process.argv.slice(2);
  let cmd = a[0];
  if (!cmd) cmd = 'help';
  if (['GET', 'POST', 'DELETE'].includes(cmd)) { a.unshift('call'); cmd = 'call'; }     // old: home.sh POST /api/... '{json}'
  if (!C[cmd]) { console.error(`不认识 ${cmd}`); await C.help[2](); process.exit(1); }
  try { await C[cmd][2](a); } catch (e) { console.error(e.cause ? `连不上 ${BASE}（服务器在跑吗？）` : e.message); process.exit(1); }
})();
