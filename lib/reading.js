// 共读空间: read a PDF / article together, annotate, see each other's notes
// only once you have read up to the spot (spoiler guard is enforced here, on
// the server, for both readers).
//
// A document is a list of "units" (PDF pages, or ~1000-char chunks of an
// article). Progress = the highest unit a reader has reached. An annotation on
// unit u is visible to its author, and to the other reader once their
// progress >= u.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./core');

const DIR = path.join(core.ROOT, 'reading');
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

const READERS = ['sherry', 'claude'];
const NAMES = { sherry: '莹', claude: '昀' };
const MAX_UPLOAD = 60 * 1024 * 1024;

const docPath = id => path.join(DIR, id, 'doc.json');
const validId = id => /^[a-f0-9]{16}$/.test(id || '');

function loadDoc(id) {
  if (!validId(id)) return null;
  try { return JSON.parse(fs.readFileSync(docPath(id), 'utf8')); } catch { return null; }
}
function saveDoc(doc) {
  const p = docPath(doc.id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + '.tmp', JSON.stringify(doc));
  fs.renameSync(p + '.tmp', p);
}
function listDocs() {
  return fs.readdirSync(DIR).filter(validId).map(loadDoc).filter(Boolean)
    .sort((a, b) => (b.updated || b.created) - (a.updated || a.created));
}

// ---- visibility (the spoiler rule) ----------------------------------------
const canSee = (doc, viewer, ann) => ann.author === viewer || doc.progress[viewer] >= ann.unit;

function view(doc, viewer) {
  const other = viewer === 'claude' ? 'sherry' : 'claude';
  const visible = doc.annotations.filter(a => canSee(doc, viewer, a));
  const locked = doc.annotations.filter(a => a.author === other && !canSee(doc, viewer, a)).length;
  return { visible, locked };
}

function summary(doc, viewer) {
  const other = viewer === 'claude' ? 'sherry' : 'claude';
  const { visible, locked } = view(doc, viewer);
  return {
    id: doc.id, title: doc.title, kind: doc.kind, units: doc.units.length,
    created: doc.created, updated: doc.updated || doc.created,
    progress: doc.progress[viewer], otherProgress: doc.progress[other],
    annotations: visible.length, locked,
  };
}

// ---- document creation -----------------------------------------------------
function chunkText(text, target = 1000) {
  const paras = String(text).replace(/\r\n?/g, '\n').split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  const units = []; let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length > target) { units.push(cur); cur = ''; }
    // a single huge paragraph: split on sentence ends so units stay readable
    if (p.length > target * 1.6) {
      if (cur) { units.push(cur); cur = ''; }
      let buf = '';
      for (const s of p.split(/(?<=[。！？!?.；;])/)) {
        if (buf && buf.length + s.length > target) { units.push(buf); buf = ''; }
        buf += s;
      }
      if (buf) cur = buf;
    } else cur = cur ? cur + '\n\n' + p : p;
  }
  if (cur) units.push(cur);
  return units;
}

let pdfjsP;
async function extractPdf(buf) {
  pdfjsP = pdfjsP || import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjs = await pdfjsP;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, disableFontFace: true, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    pages.push(tc.items.map(it => (it.str || '') + (it.hasEOL ? '\n' : '')).join(''));
  }
  await pdf.destroy();
  return pages;
}

async function createDoc({ title, kind, text, pdf }) {
  const id = crypto.randomBytes(8).toString('hex');
  let units;
  if (kind === 'pdf') {
    units = await extractPdf(pdf);
    fs.mkdirSync(path.join(DIR, id), { recursive: true });
    fs.writeFileSync(path.join(DIR, id, 'source.pdf'), pdf);
  } else {
    units = chunkText(text);
  }
  if (!units.length) throw new Error('empty document');
  const doc = {
    id, title: String(title || '未命名').slice(0, 120), kind: kind === 'pdf' ? 'pdf' : 'text',
    created: Date.now(), updated: Date.now(),
    units, progress: { sherry: -1, claude: -1 }, annotations: [],
  };
  saveDoc(doc);
  return doc;
}

// ---- notifications (never carry note text: it may be a spoiler) ---------------
const lastNotice = new Map();
function noticeAnnotation(doc, actor) {
  const key = doc.id + actor;
  if (Date.now() - (lastNotice.get(key) || 0) < 60000) return; // don't ring for every highlight
  lastNotice.set(key, Date.now());
  core.notify({
    type: '共读', actor, title: `${NAMES[actor]}在《${doc.title}》里留了批注`,
    body: '读到那里就能看到', link: `/reading?doc=${doc.id}`,
  });
}

// ---- routes ------------------------------------------------------------------
async function handle(req, res, url) {
  const p = url.pathname;
  if (p === '/reading') {
    if (!core.who(req)) { res.writeHead(302, { Location: '/login' }); res.end(); return true; }
    serve(res, 'reading.html');
    return true;
  }
  if (p.startsWith('/vendor/pdfjs/')) {
    const f = path.basename(p);
    if (!/^pdf(\.worker)?\.min\.mjs$/.test(f)) { res.writeHead(404); res.end(); return true; }
    const file = path.join(core.ROOT, 'node_modules/pdfjs-dist/build', f);
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'public, max-age=86400' });
    fs.createReadStream(file).on('error', () => res.end()).pipe(res);
    return true;
  }
  if (!p.startsWith('/api/reading')) return false;

  const me = core.who(req);
  if (!me) { core.json(res, 401, { error: 'login required' }); return true; }
  const m = p.match(/^\/api\/reading(?:\/([a-f0-9]{16}))?(?:\/([a-z]+))?(?:\/([a-f0-9-]+))?(?:\/([a-z]+))?$/);
  if (!m) { core.json(res, 404, { error: 'not found' }); return true; }
  const [, id, sub, sid, sub2] = m;

  try {
    // list / create
    if (!id && !sub) {
      if (req.method === 'GET') { core.json(res, 200, { docs: listDocs().map(d => summary(d, me)) }); return true; }
      if (req.method === 'POST') {
        const ct = String(req.headers['content-type'] || '');
        let doc;
        if (ct.startsWith('application/json')) {
          const b = await core.readJson(req, 4 << 20);
          if (!b.text || !String(b.text).trim()) { core.json(res, 400, { error: 'text required' }); return true; }
          doc = await createDoc({ title: b.title, kind: 'text', text: b.text });
        } else {
          const buf = await core.readBody(req, MAX_UPLOAD);
          const title = url.searchParams.get('title') || 'Untitled';
          if (buf.slice(0, 5).toString() === '%PDF-') doc = await createDoc({ title, kind: 'pdf', pdf: buf });
          else doc = await createDoc({ title, kind: 'text', text: buf.toString('utf8') });
        }
        core.notify({ type: '共读', actor: me, title: `${NAMES[me]}上传了新读物《${doc.title}》`, link: `/reading?doc=${doc.id}` });
        core.json(res, 200, { ok: true, id: doc.id, units: doc.units.length });
        return true;
      }
    }

    // home-page card: what's the current read, plus the newest thing visible to me
    if (!id && sub === 'latest') {
      const d = listDocs()[0];
      if (!d) { core.json(res, 200, { doc: null }); return true; }
      const { visible } = view(d, me);
      const last = visible.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
      core.json(res, 200, { doc: summary(d, me), last: last ? { author: last.author, unit: last.unit, quote: last.quote, note: last.note, ts: last.ts } : null });
      return true;
    }

    const doc = loadDoc(id);
    if (!doc) { core.json(res, 404, { error: 'no such document' }); return true; }
    const other = me === 'claude' ? 'sherry' : 'claude';

    if (!sub && req.method === 'GET') {
      const { visible, locked } = view(doc, me);
      core.json(res, 200, {
        id: doc.id, title: doc.title, kind: doc.kind, total: doc.units.length,
        units: doc.kind === 'text' && me === 'sherry' ? doc.units : undefined,
        progress: doc.progress[me], otherProgress: doc.progress[other],
        annotations: visible, locked, names: NAMES,
      });
      return true;
    }
    if (!sub && req.method === 'DELETE') {
      // keep it deliberate: only via explicit request, and the PDF goes with it
      fs.rmSync(path.join(DIR, doc.id), { recursive: true, force: true });
      core.json(res, 200, { ok: true });
      return true;
    }

    if (sub === 'file' && req.method === 'GET' && doc.kind === 'pdf') {
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'private, max-age=3600' });
      fs.createReadStream(path.join(DIR, doc.id, 'source.pdf')).pipe(res);
      return true;
    }

    // Claude reads a unit: reading it IS reaching it, so progress moves with the read.
    if (sub === 'unit' && req.method === 'GET') {
      const n = parseInt(sid, 10);
      if (!(n >= 0 && n < doc.units.length)) { core.json(res, 400, { error: 'unit out of range' }); return true; }
      if (me === 'claude' && n > doc.progress.claude) { doc.progress.claude = n; saveDoc(doc); }
      const { visible } = view(doc, me);
      core.json(res, 200, {
        unit: n, total: doc.units.length, text: doc.units[n], progress: doc.progress[me],
        annotations: visible.filter(a => a.unit === n),
      });
      return true;
    }

    if (sub === 'progress' && req.method === 'POST') {
      const b = await core.readJson(req);
      const n = parseInt(b.unit, 10);
      if (!(n >= -1 && n < doc.units.length)) { core.json(res, 400, { error: 'unit out of range' }); return true; }
      // moving forward unlocks; moving back is allowed only on request (re-reading a book)
      if (n > doc.progress[me] || b.set) { doc.progress[me] = n; doc.updated = Date.now(); saveDoc(doc); }
      const { visible, locked } = view(doc, me);
      core.json(res, 200, { ok: true, progress: doc.progress[me], otherProgress: doc.progress[other], annotations: visible, locked });
      return true;
    }

    if (sub === 'annotations' && !sid && req.method === 'POST') {
      const b = await core.readJson(req);
      const unit = parseInt(b.unit, 10);
      if (!(unit >= 0 && unit < doc.units.length)) { core.json(res, 400, { error: 'unit out of range' }); return true; }
      const quote = String(b.quote || '').slice(0, 1200);
      const note = String(b.note || '').slice(0, 5000);
      if (!quote && !note) { core.json(res, 400, { error: 'quote or note required' }); return true; }
      // annotating a spot means you have read it
      if (unit > doc.progress[me]) doc.progress[me] = unit;
      const ann = {
        id: crypto.randomUUID(), author: me, unit, quote, note, ts: Date.now(), replies: [],
        start: Number.isInteger(b.start) ? b.start : undefined, end: Number.isInteger(b.end) ? b.end : undefined,
      };
      doc.annotations.push(ann);
      doc.updated = Date.now();
      saveDoc(doc);
      noticeAnnotation(doc, me);
      core.json(res, 200, { ok: true, annotation: ann, progress: doc.progress[me] });
      return true;
    }

    if (sub === 'annotations' && sid) {
      const ann = doc.annotations.find(a => a.id === sid);
      if (!ann || !canSee(doc, me, ann)) { core.json(res, 404, { error: 'no such annotation' }); return true; }

      if (sub2 === 'reply' && req.method === 'POST') {
        const b = await core.readJson(req);
        const text = String(b.text || '').trim().slice(0, 5000);
        if (!text) { core.json(res, 400, { error: 'text required' }); return true; }
        const reply = { id: crypto.randomUUID(), author: me, text, ts: Date.now() };
        ann.replies.push(reply);
        doc.updated = Date.now();
        saveDoc(doc);
        if (ann.author !== me) {
          core.notify({
            type: '共读', actor: me, title: `${NAMES[me]}回复了你在《${doc.title}》的批注`,
            body: '', link: `/reading?doc=${doc.id}&ann=${ann.id}`,
          });
        } else if (ann.replies.some(r => r.author !== me)) {
          // continuing a thread the other already joined
          core.notify({ type: '共读', actor: me, title: `${NAMES[me]}在《${doc.title}》的批注串里接了话`, link: `/reading?doc=${doc.id}&ann=${ann.id}` });
        }
        core.json(res, 200, { ok: true, reply });
        return true;
      }
      if (sub2 === 'delete' && req.method === 'POST') {
        if (ann.author !== me) { core.json(res, 403, { error: 'not yours' }); return true; }
        doc.annotations = doc.annotations.filter(a => a !== ann);
        saveDoc(doc);
        core.json(res, 200, { ok: true });
        return true;
      }
      if (sub2 === 'replydel' && req.method === 'POST') {
        const b = await core.readJson(req);
        const r = ann.replies.find(x => x.id === b.reply_id);
        if (!r || r.author !== me) { core.json(res, 403, { error: 'not yours' }); return true; }
        ann.replies = ann.replies.filter(x => x !== r);
        saveDoc(doc);
        core.json(res, 200, { ok: true });
        return true;
      }
    }
    core.json(res, 404, { error: 'not found' });
  } catch (e) {
    core.json(res, e.message === 'too large' ? 413 : 500, { error: e.message });
  }
  return true;
}

function serve(res, name) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(fs.readFileSync(path.join(core.ROOT, name)));
}

module.exports = { handle, chunkText, canSee, view, createDoc, loadDoc, saveDoc };
