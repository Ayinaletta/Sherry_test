#!/usr/bin/env node
// Screenshot a login QR with Playwright and push it to the house.
//   node tools/qr_capture.js --url https://login.taobao.com --selector 'canvas' --label 淘宝
// Needs `playwright` (or playwright-core + a chromium) resolvable from here; it is
// deliberately not a hard dependency of the server.
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const url = arg('url'); if (!url) { console.error('--url required'); process.exit(1); }
const selector = arg('selector', 'canvas, img[src*="qr" i], .qrcode, [class*="qrcode" i]');
const label = arg('label', '二维码');
const ttl = arg('ttl', '180');
const base = process.env.HOME_URL || 'http://127.0.0.1:3000';
const key = fs.readFileSync(path.join(__dirname, '..', '.claude_key'), 'utf8').trim();

(async () => {
  let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
  const exe = process.env.CHROMIUM_PATH || undefined;
  const browser = await pw.chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1000, height: 800 } })).newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const el = await page.waitForSelector(selector, { state: 'visible', timeout: 20000 });
    await page.waitForTimeout(800);                    // let the code finish drawing
    const png = await el.screenshot({ type: 'png' });
    const r = await fetch(`${base}/api/qr/push?label=${encodeURIComponent(label)}&ttl=${ttl}`, {
      method: 'POST', headers: { 'X-Home-Key': key, 'Content-Type': 'image/png' }, body: png });
    console.log(r.status, await r.text());
  } finally { await browser.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
