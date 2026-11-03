// 戒指: store what the ring measured and turn it into the numbers the /ring page draws.
//   POST /api/ring/data     (device secret, 昀 or 莹)  any mix of:
//        samples: [{ts, hr, spo2, stress, hrv, temp}]          time series (ts = epoch ms / s, or ISO)
//        daily:   {date, steps, calories, distance_m, active_min, goal_steps}   (or an array of these)
//        sleep:   {start, end, stages:[{stage,start,end}] | minutes:{deep,light,rem,awake}, score}   (or an array)
//        device:  {model, battery, firmware}      synced_at: ts
//   GET  /api/ring/summary?days=7&date=YYYY-MM-DD   today + trend + one night's sleep (莹 / 昀)
//   GET  /api/ring/sleep?date=YYYY-MM-DD            one night
//   GET  /ring                                      the page
// Legacy POST /api/ring bodies (the iPhone shortcut) are folded in by ingestLegacy().
// Everything is optional: the page draws what exists. Files live in ring/ (0700), kept 120 days.
const fs = require('fs');
const path = require('path');
const core = require('./core');
const guard = require('./guard');

const DIR = path.join(core.ROOT, 'ring');
const F = { samples: path.join(DIR, 'samples.jsonl'), daily: path.join(DIR, 'daily.json'), sleep: path.join(DIR, 'sleep.json'), meta: path.join(DIR, 'meta.json') };
const KEEP_MS = 120 * 86400000;
const DAY = 86400000;

// ---- time (days are the viewer's days, not UTC's) ---------------------------------------
const zone = () => String(core.conf('timezone', 'Europe/Vilnius'));
const keyFmt = {};
function dayKey(ts, z = zone()) {
  keyFmt[z] = keyFmt[z] || new Intl.DateTimeFormat('en-CA', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit' });
  return keyFmt[z].format(ts);
}
function tzOffsetMs(ts, z) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: z, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(ts);
  const o = {}; parts.forEach(p => { o[p.type] = p.value; });
  return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second) - Math.floor(ts / 1000) * 1000;
}
function dayStart(key, z = zone()) {
  const guess = Date.parse(key + 'T00:00:00Z');
  return guess - tzOffsetMs(guess - tzOffsetMs(guess, z), z);
}
const addDays = (key, n) => dayKey(Date.parse(key + 'T12:00:00Z') + n * DAY, 'UTC');

function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  const n = Number(v); if (Number.isFinite(n) && String(v).trim() !== '') return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  const t = Date.parse(v); return Number.isFinite(t) ? t : null;
}
const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : undefined; };

// ---- store ------------------------------------------------------------------------------
let samples = [], daily = {}, sleepBy = {}, meta = {}, dirty = false;
const bySec = new Map();
function ensureDir() { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); }
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, o) => { ensureDir(); fs.writeFileSync(f + '.tmp', JSON.stringify(o), { mode: 0o600 }); fs.renameSync(f + '.tmp', f); };

function addSample(s) {
  const key = Math.round(s.ts / 1000), old = bySec.get(key);
  if (old) { Object.assign(old, s); return false; }
  samples.push(s); bySec.set(key, s); dirty = true; return true;
}
function load() {
  daily = readJson(F.daily, {}); sleepBy = readJson(F.sleep, {}); meta = readJson(F.meta, {});
  samples = []; bySec.clear();
  const cutoff = Date.now() - KEEP_MS;
  core.readJsonl(F.samples).forEach(r => { if (r && r.ts >= cutoff) addSample({ ...r }); });
  samples.sort((a, b) => a.ts - b.ts); dirty = false;
}
load();

// ---- ingest -----------------------------------------------------------------------------
const STAGE = { deep: 'deep', light: 'light', rem: 'rem', awake: 'awake', wake: 'awake', 深睡: 'deep', 浅睡: 'light', 清醒: 'awake', 眼动: 'rem', REM: 'rem' };

function normSample(r) {
  const ts = toMs(r.ts ?? r.time ?? r.t); if (!ts || ts > Date.now() + DAY) return null;
  const s = { ts };
  const hr = num(r.hr ?? r.heart_rate ?? r.heartRate ?? r.bpm, 30, 220); if (hr !== undefined) s.hr = Math.round(hr);
  const o2 = num(r.spo2 ?? r.SpO2 ?? r.blood_oxygen, 70, 100); if (o2 !== undefined) s.spo2 = Math.round(o2 * 10) / 10;
  const st = num(r.stress, 0, 100); if (st !== undefined) s.stress = Math.round(st);
  const hv = num(r.hrv, 1, 300); if (hv !== undefined) s.hrv = Math.round(hv);
  const tp = num(r.temp ?? r.temperature, 30, 43); if (tp !== undefined) s.temp = Math.round(tp * 100) / 100;
  return Object.keys(s).length > 1 ? s : null;
}
function normSleep(r) {
  const out = {};
  const stages = Array.isArray(r.stages) ? r.stages.map(x => ({ stage: STAGE[x.stage ?? x.type], start: toMs(x.start), end: toMs(x.end) })).filter(x => x.stage && x.start && x.end && x.end > x.start).sort((a, b) => a.start - b.start) : [];
  let min = { deep: 0, light: 0, rem: 0, awake: 0 };
  if (stages.length) { stages.forEach(x => { min[x.stage] += (x.end - x.start) / 60000; }); out.stages = stages; }
  else if (r.minutes && typeof r.minutes === 'object') for (const k of Object.keys(min)) min[k] = num(r.minutes[k], 0, 1440) || 0;
  else if (num(r.total_min ?? r.total, 1, 1440)) { min = null; out.total_min = Math.round(num(r.total_min ?? r.total, 1, 1440)); }
  if (min) { for (const k of Object.keys(min)) min[k] = Math.round(min[k]); out.minutes = min; }
  const start = toMs(r.start) || (stages[0] && stages[0].start), end = toMs(r.end) || (stages.length && stages[stages.length - 1].end);
  if (start) out.start = start; if (end) out.end = end;
  const sc = num(r.score, 0, 100); if (sc !== undefined) out.score = Math.round(sc);
  const date = r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : (end ? dayKey(end) : null);
  return date && (out.minutes || out.total_min) ? { date, v: out } : null;
}
function normDaily(r) {
  const date = r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : dayKey(Date.now());
  const d = {};
  const st = num(r.steps, 0, 200000); if (st !== undefined) d.steps = Math.round(st);
  const cal = num(r.calories ?? r.kcal, 0, 30000); if (cal !== undefined) d.calories = Math.round(cal);
  const di = num(r.distance_m ?? r.distance, 0, 500000); if (di !== undefined) d.distance_m = Math.round(di);
  const am = num(r.active_min, 0, 1440); if (am !== undefined) d.active_min = Math.round(am);
  const g = num(r.goal_steps ?? r.goal, 100, 100000); if (g !== undefined) d.goal_steps = Math.round(g);
  return Object.keys(d).length ? { date, v: d } : null;
}
const arr = x => (Array.isArray(x) ? x : x && typeof x === 'object' ? [x] : []);

function ingest(body) {
  ensureDir();
  const got = { samples: 0, daily: 0, sleep: 0 };
  let appended = [];
  for (const r of arr(body.samples).slice(0, 20000)) { const s = normSample(r || {}); if (s && addSample(s)) { got.samples++; appended.push(s); } else if (s) got.samples++; }
  for (const r of arr(body.daily)) { const d = normDaily(r || {}); if (d) { daily[d.date] = { ...(daily[d.date] || {}), ...d.v }; got.daily++; } }
  for (const r of arr(body.sleep)) { const s = normSleep(r || {}); if (s) { sleepBy[s.date] = s.v; got.sleep++; } }
  if (body.device && typeof body.device === 'object') meta.device = { model: String(body.device.model || '').slice(0, 40), battery: num(body.device.battery, 0, 100), firmware: String(body.device.firmware || '').slice(0, 30) };
  meta.synced_at = toMs(body.synced_at) || Date.now();
  if (appended.length) fs.appendFileSync(F.samples, appended.map(s => JSON.stringify(s)).join('\n') + '\n', { mode: 0o600 });
  if (got.daily) writeJson(F.daily, daily);
  if (got.sleep) writeJson(F.sleep, sleepBy);
  writeJson(F.meta, meta);
  return got;
}

// the iPhone shortcut's POST /api/ring: whatever it sent, fold known keys in as a sample for "now" + today's totals
function ingestLegacy(b) {
  if (!b || typeof b !== 'object') return;
  const now = toMs(b.ts) || Date.now();
  const body = { samples: [{ ts: now, ...b }], synced_at: now };
  if (b.steps != null || b.calories != null) body.daily = [{ steps: b.steps, calories: b.calories, distance: b.distance }];
  ingest(body);
}

// ---- numbers -----------------------------------------------------------------------------
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r1 = v => (v == null ? null : Math.round(v * 10) / 10);
const stressLevel = v => (v == null ? null : v < 34 ? '低' : v < 67 ? '中' : '高');
const spo2Status = (latest, min) => (latest == null ? null : (min != null && min < 90) || latest < 90 ? 'alert' : latest < 95 ? 'low' : 'normal');

function bucketSeries(rows, key, dayStartMs, stepMin = 5) {
  const step = stepMin * 60000, b = new Map();
  for (const r of rows) if (r[key] != null) { const i = Math.floor((r.ts - dayStartMs) / step); (b.get(i) || b.set(i, []).get(i)).push(r[key]); }
  return [...b.entries()].sort((x, y) => x[0] - y[0]).map(([i, v]) => ({ t: dayStartMs + i * step, v: r1(avg(v)) }));
}
function rowsOfDay(key) { const s = dayStart(key), e = s + DAY; return samples.filter(r => r.ts >= s && r.ts < e); }
const dayAvg = (rows, k) => r1(avg(rows.filter(r => r[k] != null).map(r => r[k])));

function sleepView(date) {
  const s = sleepBy[date]; if (!s) return null;
  const m = s.minutes || null;
  const total = m ? m.deep + m.light + m.rem : s.total_min;
  let score = s.score ?? null, est = false;
  if (score == null && m && total > 0) {          // an estimate, and labelled as one
    const inbed = total + m.awake;
    score = Math.round(100 * (0.45 * Math.min(total / 480, 1) + 0.25 * Math.min((m.deep / total) / 0.18, 1) + 0.15 * Math.min((m.rem / total) / 0.22, 1) + 0.15 * (1 - Math.min((m.awake / inbed) / 0.15, 1))));
    est = true;
  }
  return { date, start: s.start || null, end: s.end || null, total_min: total, minutes: m, score, score_estimated: est, segments: s.stages || null };
}

function summary(days, date) {
  const today = dayKey(Date.now());
  const keys = []; for (let i = days - 1; i >= 0; i--) keys.push(addDays(today, -i));
  // baseline = the median of the 14 days before `from`, once there are at least 5 of them
  const baseline = (from, fn) => { const v = []; for (let i = 1; i <= 14; i++) { const x = fn(addDays(from, -i)); if (x != null) v.push(x); } return v.length >= 5 ? median(v) : null; };
  const dayRows = {}; const rowsFor = k => dayRows[k] || (dayRows[k] = rowsOfDay(k));

  const rows = rowsFor(today), ds = dayStart(today);
  const lastOf = k => { for (let i = rows.length - 1; i >= 0; i--) if (rows[i][k] != null) return { v: rows[i][k], ts: rows[i].ts }; return null; };
  const vals = k => rows.filter(r => r[k] != null).map(r => r[k]);
  const d0 = daily[today] || {};
  const hr = vals('hr'), spo = vals('spo2'), st = vals('stress'), hv = vals('hrv'), tp = vals('temp');
  const hrvBase = baseline(today, k => dayAvg(rowsFor(k), 'hrv'));
  const tempBase = baseline(today, k => dayAvg(rowsFor(k), 'temp'));
  const tempToday = r1(avg(tp));

  const out = {
    now: Date.now(), tz: zone(), today, day_start: ds, last_sync: meta.synced_at || (samples.length ? samples[samples.length - 1].ts : null), device: meta.device || null,
    today_data: {
      steps: { value: d0.steps ?? null, goal: d0.goal_steps || Number(core.conf('ring_step_goal', 8000)) || 8000, distance_m: d0.distance_m ?? null, active_min: d0.active_min ?? null },
      calories: d0.calories ?? null,
      hr: hr.length ? { latest: lastOf('hr'), avg: r1(avg(hr)), min: Math.min(...hr), max: Math.max(...hr), series: bucketSeries(rows, 'hr', ds) } : null,
      spo2: spo.length ? { latest: lastOf('spo2'), avg: r1(avg(spo)), min: Math.min(...spo), status: spo2Status(lastOf('spo2').v, Math.min(...spo)), series: bucketSeries(rows, 'spo2', ds, 10) } : null,
      stress: st.length ? { latest: lastOf('stress'), avg: r1(avg(st)), level: stressLevel(lastOf('stress').v), series: bucketSeries(rows, 'stress', ds, 10) } : null,
      hrv: hv.length ? { latest: lastOf('hrv'), avg: r1(avg(hv)), baseline: r1(hrvBase), series: bucketSeries(rows, 'hrv', ds, 10) } : null,
      temp: tp.length ? { latest: lastOf('temp'), avg: tempToday, baseline: r1(tempBase), delta: tempBase == null ? null : Math.round((tempToday - tempBase) * 100) / 100, series: bucketSeries(rows, 'temp', ds, 10) } : null,
    },
    days: keys.map(k => {
      const r = rowsFor(k), dd = daily[k] || {}, sl = sleepView(k);
      const hrs = r.filter(x => x.hr != null).map(x => x.hr), tavg = dayAvg(r, 'temp'), tb = baseline(k, kk => dayAvg(rowsFor(kk), 'temp'));
      return { date: k, steps: dd.steps ?? null, calories: dd.calories ?? null, hr_avg: r1(avg(hrs)), hr_min: hrs.length ? Math.min(...hrs) : null, hr_max: hrs.length ? Math.max(...hrs) : null,
        spo2_avg: dayAvg(r, 'spo2'), stress_avg: dayAvg(r, 'stress'), hrv_avg: dayAvg(r, 'hrv'), temp_avg: tavg, temp_dev: tavg != null && tb != null ? Math.round((tavg - tb) * 100) / 100 : null,
        sleep_total: sl ? sl.total_min : null, sleep_score: sl ? sl.score : null, sleep_minutes: sl ? sl.minutes : null };
    }),
    sleep_dates: Object.keys(sleepBy).sort().reverse().slice(0, 30),
  };
  const want = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : out.sleep_dates[0];
  out.sleep = want ? sleepView(want) : null;
  const any = k => out.days.some(d => d[k] != null);
  out.availability = { steps: any('steps') || d0.steps != null, hr: any('hr_avg'), spo2: any('spo2_avg'), stress: any('stress_avg'), hrv: any('hrv_avg'), temp: any('temp_avg'), sleep: out.sleep_dates.length > 0, calories: any('calories') };
  out.availability.any = Object.values(out.availability).some(Boolean);
  return out;
}

// ---- routes ------------------------------------------------------------------------------
async function handle(req, res, url) {
  const p = url.pathname;
  if (p === '/ring') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' });
    res.end(core.versionHtml(fs.readFileSync(path.join(core.ROOT, 'ring.html'), 'utf8')));
    return true;
  }
  if (!p.startsWith('/api/ring/')) return false;
  const me = core.who(req);
  try {
    if (p === '/api/ring/data' && req.method === 'POST') {
      if (!me && !guard.secretOk(req, url)) { core.json(res, 401, { error: 'login required' }); return true; }
      const b = await core.readJson(req, 4 * 1024 * 1024);
      core.json(res, 200, { ok: true, received: ingest(b && typeof b === 'object' ? b : {}) });
      return true;
    }
    if (!me) { core.json(res, 401, { error: 'login required' }); return true; }
    if (p === '/api/ring/summary' && req.method === 'GET') {
      const days = Math.max(1, Math.min(30, parseInt(url.searchParams.get('days') || '7', 10) || 7));
      core.json(res, 200, summary(days, url.searchParams.get('date')));
      return true;
    }
    if (p === '/api/ring/sleep' && req.method === 'GET') {
      const v = sleepView(url.searchParams.get('date') || '');
      if (!v) { core.json(res, 404, { error: 'no sleep recorded for that date' }); return true; }
      core.json(res, 200, v);
      return true;
    }
    core.json(res, 404, { error: 'not found' });
  } catch (e) { core.json(res, e.message === 'too large' ? 413 : 400, { error: e.message }); }
  return true;
}

module.exports = { handle, ingest, ingestLegacy, summary, dayKey, dayStart };
