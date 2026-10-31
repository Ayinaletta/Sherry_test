// Routes for the event stream, Claude's inbox and health. Everything here works
// without Telegram: events are pushed over SSE, and anything Claude missed while
// his session was down waits in the inbox until he asks for it.
const core = require('./core');

async function handle(req, res, url) {
  const p = url.pathname;

  if (p === '/api/health') {
    // answers anyone with a bare "up"; the details (what is running, how long) are for logged-in callers only
    if (!core.who(req)) { core.json(res, 200, { ok: true }); return true; }
    core.tmuxAlive(tmux => {
      core.sidecar('/snapshot', err => core.json(res, 200, {
        ok: true, uptime: Math.round(process.uptime()), claude_session: tmux, sidecar: !err,
      }));
    });
    return true;
  }

  if (!['/api/events', '/api/events/recent', '/api/inbox'].includes(p)) return false;
  if (!core.who(req)) { core.json(res, 401, { error: 'login required' }); return true; }

  if (p === '/api/events') {
    const last = parseInt(req.headers['last-event-id'] || url.searchParams.get('since') || '0', 10) || 0;
    core.addEventClient(req, res, last);
    return true;
  }
  if (p === '/api/events/recent') {
    const limit = Math.min(100, parseInt(url.searchParams.get('limit') || '20', 10) || 20);
    core.json(res, 200, { events: core.readJsonl(core.EVENTS_LOG).slice(-limit).reverse() });
    return true;
  }
  // Claude only: lines that were typed (or should have been) into his session since <id>
  if (p === '/api/inbox') {
    if (core.who(req) !== 'claude') { core.json(res, 403, { error: 'claude only' }); return true; }
    const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
    core.json(res, 200, { items: core.readJsonl(core.INBOX_LOG, e => e.id > since).slice(-200) });
    return true;
  }
  return false;
}

module.exports = { handle };
