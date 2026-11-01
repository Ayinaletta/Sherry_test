// 手机 (the Redmi that 昀 lives in): where its screenshots land, and whether it is alive.
//   POST /api/phone/screen      raw image -> phone/latest.jpg (never a chat message; deleted after phone_keep_hours)
//   GET  /api/phone/screen      the newest screenshot (莹 / 昀)
//   POST /api/phone/heartbeat   {battery, charging, screen, locked, adb, shizuku, net, started_at, version}  every minute
//   POST /api/phone/activity    {action, detail}  "昀 opened 小红书" - the action, never what was on the screen
//   GET  /api/phone/status      state + recent activity (莹 / 昀)
// Heartbeats let the house notice by itself when the phone's stack died (Android kills Termux in the background),
// tell 莹 once ("红米掉线了"), tell 昀 the reason his tools fail, and say when it is back. Low battery nudges 莹 once.
// POST routes: device secret, or 昀 / 莹.
const fs = require('fs');
const path = require('path');
const core = require('./core');
const guard = require('./guard');
const security = require('./security');
let sharp; try { sharp = require('sharp'); } catch {}

const DIR = path.join(core.ROOT, 'phone');
const STATE = path.join(DIR, 'state.json');
const ACTIVITY = path.join(DIR, 'activity.jsonl');
const num = (k, d) => { const v = Number(core.conf(k, d)); return Number.isFinite(v) && v > 0 ? v : d; };
const keepMs = () => num('phone_keep_hours', 24) * 3600 * 1000;
const offlineAfterMs = () => num('phone_offline_after_min', 15) * 60 * 1000;   // the watchdog on the phone retries every ~15 min
const lowBattery = () => num('phone_low_battery', 25);

fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
let state = { last_beat: 0, outage: false, outage_since: 0, low_notified: false, restarts: [] };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE, 'utf8')) }; } catch {}
const save = () => { try { fs.writeFileSync(STATE, JSON.stringify(state), { mode: 0o600 }); } catch {} };

function log(type, text) {
  try {
    fs.appendFileSync(ACTIVITY, JSON.stringify({ ts: Date.now(), type, text }) + '\n', { mode: 0o600 });
    if (fs.statSync(ACTIVITY).size > 512 * 1024) fs.renameSync(ACTIVITY, ACTIVITY + '.1');
  } catch {}
}
const recent = n => core.readJsonl(ACTIVITY).slice(-n).reverse();
const mins = ms => Math.max(1, Math.round(ms / 60000));

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

// ---- is it still alive? -------------------------------------------------------------
function check() {
  if (!state.last_beat || state.outage) return;
  const gone = Date.now() - state.last_beat;
  if (gone < offlineAfterMs()) return;
  state.outage = true; state.outage_since = state.last_beat; save();
  log('offline', `没有心跳 ${mins(gone)} 分钟`);
  const evt = core.notify({ type: '手机', actor: 'system', title: '红米掉线了', body: `已经 ${mins(gone)} 分钟没有动静，可能是 Termux 被系统杀掉了`, link: '/phone', chat: false });
  core.toClaude(evt);                      // 昀 learns why his phone tools fail
}
const checker = setInterval(check, num('phone_check_seconds', 60) * 1000);
checker.unref();

function beat(b) {
  const now = Date.now();
  const clean = {
    battery: Number.isFinite(+b.battery) ? Math.max(0, Math.min(100, Math.round(+b.battery))) : undefined,
    charging: typeof b.charging === 'boolean' ? b.charging : undefined,
    screen: ['on', 'off'].includes(b.screen) ? b.screen : undefined,
    locked: typeof b.locked === 'boolean' ? b.locked : undefined,
    adb: typeof b.adb === 'boolean' ? b.adb : undefined,
    shizuku: typeof b.shizuku === 'boolean' ? b.shizuku : undefined,
    net: ['wifi', 'mobile', 'none'].includes(b.net) ? b.net : undefined,
    version: typeof b.version === 'string' ? b.version.slice(0, 30) : undefined,
  };
  const started = Number.isFinite(+b.started_at) && +b.started_at > 0 ? Math.round(+b.started_at) : undefined;

  if (state.outage) {                                            // it came back
    const out = now - state.outage_since;
    state.outage = false; log('online', `回来了（离线约 ${mins(out)} 分钟）`);
    const evt = core.notify({ type: '手机', actor: 'system', title: '红米回来了', body: `离线约 ${mins(out)} 分钟`, link: '/phone', chat: false });
    core.toClaude(evt);
  }
  if (started && state.started_at && started !== state.started_at) {   // a fresh process: the old one was killed (or the phone rebooted)
    state.restarts.push(now); state.restarts = state.restarts.filter(t => now - t < 30 * 86400000);
    log('restarted', 'Termux / shim 重新启动过');
  }
  if (started) state.started_at = started;
  Object.assign(state, Object.fromEntries(Object.entries(clean).filter(([, v]) => v !== undefined)), { last_beat: now });

  // battery: one nudge when it gets low and it isn't charging; re-arm once it has been charged
  if (state.battery !== undefined) {
    if (!state.charging && state.battery <= lowBattery() && !state.low_notified) {
      state.low_notified = true; log('low_battery', `电量 ${state.battery}%`);
      core.notify({ type: '手机', actor: 'system', title: `红米电量 ${state.battery}%`, body: '该充电了', link: '/phone', chat: false });
    } else if ((state.charging || state.battery >= lowBattery() + 15) && state.low_notified) state.low_notified = false;
  }
  save();
}

function status() {
  const age = state.last_beat ? Date.now() - state.last_beat : null;
  let shot = null; try { shot = Date.now() - fs.statSync(path.join(DIR, 'latest.jpg')).mtimeMs; } catch {}
  return {
    seen: !!state.last_beat, online: !!state.last_beat && !state.outage && age < offlineAfterMs(), age_s: age === null ? null : Math.round(age / 1000),
    battery: state.battery, charging: state.charging, screen: state.screen, locked: state.locked, adb: state.adb, shizuku: state.shizuku, net: state.net, version: state.version,
    outage_since: state.outage ? state.outage_since : null,
    restarts_7d: state.restarts.filter(t => Date.now() - t < 7 * 86400000).length, restarts_30d: state.restarts.length,
    screenshot_age_s: shot === null ? null : Math.round(shot / 1000),
    thresholds: { offline_after_min: offlineAfterMs() / 60000, low_battery: lowBattery() },
    activity: recent(25),
  };
}

let actions = [];       // simple rate limit for activity posts
async function handle(req, res, url) {
  const p = url.pathname;
  if (p === '/phone') {                                              // the page (the front door already checked who is asking)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' });
    res.end(core.versionHtml(fs.readFileSync(path.join(core.ROOT, 'phone.html'), 'utf8')));
    return true;
  }
  if (!p.startsWith('/api/phone/')) return false;
  const me = core.who(req);
  const device = !me && guard.secretOk(req, url);
  if (!me && !device) { core.json(res, 401, { error: 'login required' }); return true; }

  try {
    if (p === '/api/phone/status' && req.method === 'GET') { core.json(res, 200, status()); return true; }

    if (p === '/api/phone/screen' && req.method === 'GET') {
      if (!me) { core.json(res, 401, { error: 'login required' }); return true; }
      const f = path.join(DIR, 'latest.jpg');
      if (!fs.existsSync(f)) { core.json(res, 404, { error: 'no screenshot yet' }); return true; }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store' });
      fs.createReadStream(f).pipe(res);
      return true;
    }
    if (req.method !== 'POST') { core.json(res, 405, { error: 'wrong method' }); return true; }

    if (p === '/api/phone/heartbeat') {
      const b = await core.readJson(req, 4096);
      beat(b && typeof b === 'object' ? b : {});
      core.json(res, 200, { ok: true });
      return true;
    }
    if (p === '/api/phone/activity') {
      const b = await core.readJson(req, 4096);
      const action = String((b && b.action) || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const detail = String((b && b.detail) || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!action) { core.json(res, 400, { error: 'action required' }); return true; }
      actions = actions.filter(t => Date.now() - t < 60000);
      if (actions.length >= 30) { core.json(res, 429, { error: 'slow down' }); return true; }
      actions.push(Date.now());
      const text = detail ? `${action}：${detail}` : action;
      log('action', text);
      security.audit('phone_action', req, { path: text });          // that it happened - never what was on the screen
      core.json(res, 200, { ok: true });
      return true;
    }
    if (p === '/api/phone/screen') {
      const raw = await core.readBody(req, 15 * 1024 * 1024);
      const isPng = raw.slice(0, 4).toString('hex') === '89504e47', isJpg = raw.slice(0, 2).toString('hex') === 'ffd8';
      if (!isPng && !isJpg) { core.json(res, 400, { error: 'send a png or jpeg body' }); return true; }
      // phone screens are tall and sharp; ~900px wide is plenty for reading them and keeps the image cheap to look at
      const jpg = sharp ? await sharp(raw).rotate().resize({ width: 900, withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer() : raw;
      fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(DIR, `screen_${Date.now()}.jpg`), jpg, { mode: 0o600 });
      fs.writeFileSync(path.join(DIR, 'latest.jpg'), jpg, { mode: 0o600 });
      prune();
      security.audit('phone_screen', req, { bytes: jpg.length });
      core.json(res, 200, { ok: true, path: path.join(DIR, 'latest.jpg'), bytes: jpg.length, keep_hours: keepMs() / 3600000 });
      return true;
    }
    core.json(res, 404, { error: 'not found' });
  } catch (e) {
    core.json(res, e.message === 'too large' ? 413 : 400, { error: e.message });
  }
  return true;
}

module.exports = { handle, check, status };
