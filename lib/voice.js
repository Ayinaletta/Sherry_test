// 语音消息, both directions.
//   莹 -> 昀: browser records audio -> POST /api/voice/upload -> Whisper -> text in chat
//   昀 -> 莹: POST /api/voice/say {text} (Claude only) -> ElevenLabs TTS -> audio bubble in chat
// Config (peek_config.json or env): openai_key, whisper_url, whisper_model,
//   elevenlabs_key, elevenlabs_voice, elevenlabs_model
const fs = require('fs');
const path = require('path');
const core = require('./core');

const UPLOADS = path.join(core.ROOT, 'uploads');
const EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };
const CT = { webm: 'audio/webm', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg', wav: 'audio/wav' };

let appendChat = () => {};

async function transcribe(buf, ext, lang) {
  const url = core.conf('whisper_url', 'https://api.openai.com/v1/audio/transcriptions');
  const key = core.conf('openai_key', '');
  if (!key && url.startsWith('https://api.openai.com')) return { text: '', error: 'whisper not configured' };
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: CT[ext] || 'application/octet-stream' }), `voice.${ext}`);
  fd.append('model', core.conf('whisper_model', 'whisper-1'));
  if (lang) fd.append('language', lang);
  const r = await fetch(url, { method: 'POST', headers: key ? { Authorization: `Bearer ${key}` } : {}, body: fd,
    signal: AbortSignal.timeout(60000) });
  if (!r.ok) return { text: '', error: `whisper ${r.status}` };
  const j = await r.json();
  return { text: String(j.text || '').trim() };
}

async function synthesize(text, voice) {
  const key = core.conf('elevenlabs_key', '');
  const voiceId = voice || core.conf('elevenlabs_voice', '');
  if (!key || !voiceId) throw new Error('elevenlabs_key / elevenlabs_voice not configured');
  const r = await fetch(`${core.conf('elevenlabs_url', 'https://api.elevenlabs.io')}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: core.conf('elevenlabs_model', 'eleven_multilingual_v2') }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`elevenlabs ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// Audio needs Range support (iOS Safari refuses to play without it), which the
// generic static handler does not do.
function serveAudio(req, res, file, ext) {
  let st; try { st = fs.statSync(file); } catch { res.writeHead(404); res.end(); return; }
  const headers = { 'Content-Type': CT[ext], 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let start = m[1] ? parseInt(m[1], 10) : st.size - parseInt(m[2], 10);
    let end = m[1] && m[2] ? parseInt(m[2], 10) : st.size - 1;
    end = Math.min(end, st.size - 1);
    if (start < 0 || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return; }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  }
}

async function handle(req, res, url) {
  const p = url.pathname;

  const am = p.match(/^\/uploads\/([\w.-]+\.(webm|ogg|m4a|aac|mp3|wav))$/);
  if (am && req.method === 'GET') {
    if (!core.who(req)) { res.writeHead(401); res.end(); return true; }
    serveAudio(req, res, path.join(UPLOADS, am[1]), am[2]);
    return true;
  }
  if (!p.startsWith('/api/voice')) return false;

  const me = core.who(req);
  if (!me) { core.json(res, 401, { error: 'login required' }); return true; }

  try {
    if (p === '/api/voice/upload' && req.method === 'POST') {
      if (me !== 'sherry') { core.json(res, 403, { error: 'sherry only' }); return true; }
      const type = String(req.headers['content-type'] || '').split(';')[0].trim();
      const ext = EXT[type];
      if (!ext) { core.json(res, 415, { error: `unsupported audio type ${type}` }); return true; }
      const buf = await core.readBody(req, 12 * 1024 * 1024);
      if (buf.length < 200) { core.json(res, 400, { error: 'empty recording' }); return true; }
      const filename = `voice_${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(UPLOADS, filename), buf);
      let t = { text: '' };
      try { t = await transcribe(buf, ext, url.searchParams.get('lang') || ''); }
      catch (e) { t = { text: '', error: e.message }; }
      const entry = {
        id: Date.now(), from: 'sherry', voice: true, audio_url: `/uploads/${filename}`,
        text: t.text, ts: new Date().toISOString(),
        ...(t.error ? { stt_error: t.error } : {}),
      };
      appendChat(entry);
      // the transcript is what Claude reads; chat itself already reaches Claude by the
      // existing path unless bridge_chat is on (see core.toClaude)
      if (String(core.conf('bridge_chat', '')) === 'true' || core.conf('bridge_chat', false) === true) {
        core.toClaude({ id: entry.id, ts: entry.ts, type: '语音', title: '莹说', body: t.text || '（语音没转成文字）', link: '/' });
      }
      core.json(res, 200, { ok: true, id: entry.id, text: t.text, error: t.error });
      return true;
    }

    if (p === '/api/voice/say' && req.method === 'POST') {
      if (me !== 'claude') { core.json(res, 403, { error: 'claude only' }); return true; }
      const b = await core.readJson(req);
      const text = String(b.text || '').trim();
      if (!text || text.length > 2500) { core.json(res, 400, { error: 'text required (<=2500 chars)' }); return true; }
      const mp3 = await synthesize(text, b.voice);
      const filename = `claude_voice_${Date.now()}.mp3`;
      fs.writeFileSync(path.join(UPLOADS, filename), mp3);
      const entry = { id: Date.now(), from: 'claude', voice: true, audio_url: `/uploads/${filename}`, text, ts: new Date().toISOString() };
      appendChat(entry);
      core.json(res, 200, { ok: true, id: entry.id, audio_url: entry.audio_url });
      return true;
    }

    core.json(res, 404, { error: 'not found' });
  } catch (e) {
    core.json(res, e.message === 'too large' ? 413 : 502, { error: e.message });
  }
  return true;
}

module.exports = { handle, setChat(fn) { appendChat = fn; }, serveAudio };
