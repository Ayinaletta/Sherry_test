const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const ROOT = __dirname;
const FREE_LOG = '/root/free_time_log.jsonl';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

function serveFile(filePath, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}

function safePath(root, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const normalized = path.normalize(decoded);
  const full = path.join(root, normalized);
  if (!full.startsWith(root + path.sep) && full !== root) return null;
  return full;
}

const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // API: free time log (read-only)
  if (pathname === '/api/free-log') {
    try {
      if (!fs.existsSync(FREE_LOG)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return;
      }
      const raw = fs.readFileSync(FREE_LOG, 'utf8').trim();
      const entries = raw
        .split('\n')
        .filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean)
        .reverse();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(entries));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: voice slot (reserved, not yet implemented)
  if (pathname === '/api/voice') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'reserved', note: '声音的门——还没装，等我们一起捏' }));
    return;
  }

  // Static files
  let filePath;
  if (pathname === '/') {
    filePath = path.join(ROOT, 'index.html');
  } else {
    filePath = safePath(ROOT, pathname);
    if (!filePath) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
  }

  serveFile(filePath, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`哥哥的家 · http://localhost:${PORT}`);
});
