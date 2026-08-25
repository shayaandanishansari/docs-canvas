#!/usr/bin/env node
/*
 * Tiny zero-dependency static server for the docs canvas.
 *
 * Why this exists: Chromium refuses to load file:// iframes from a file://
 * parent, so the canvas can't embed your docs unless they're served over
 * http. Everything is same-origin under one port, which also means the
 * canvas can scroll/inspect the frames it owns.
 *
 * Run:  node _canvas/server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CANVAS_DIR = __dirname;

// Defaults to the folder this one sits in. Point it anywhere with DOCS_ROOT,
// which is what you want if you cloned this next to your documents rather
// than inside them:  DOCS_ROOT=/path/to/docs node server.js
const ROOT = process.env.DOCS_ROOT
  ? path.resolve(process.env.DOCS_ROOT)
  : path.resolve(CANVAS_DIR, '..');
const START_PORT = Number(process.env.PORT) || 8765;

const SKIP_DIRS = new Set(['node_modules', '.git', '.idea', '_canvas', 'dist', '.venv', '__pycache__']);

// Extensions we surface in the file rail, grouped by how a node renders them.
const KINDS = {
  '.html': 'html', '.htm': 'html',
  '.pdf': 'pdf',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.svg': 'image',
  '.md': 'text', '.txt': 'text',
  '.mp4': 'video', '.webm': 'video',
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

function walk(dir, out, depth) {
  if (depth > 8) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, out, depth + 1);
    } else {
      const ext = path.extname(e.name).toLowerCase();
      const kind = KINDS[ext];
      if (!kind) continue;
      let size = 0, mtime = 0;
      try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch {}
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      out.push({
        path: rel,
        name: e.name,
        dir: path.dirname(rel) === '.' ? '' : path.dirname(rel),
        kind, ext, size, mtime,
      });
    }
  }
  return out;
}

const BOARDS = path.join(CANVAS_DIR, 'boards');

function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({ 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  // --- API -----------------------------------------------------------
  if (pathname === '/__api/files') {
    const files = walk(ROOT, [], 0).sort((a, b) => b.mtime - a.mtime);
    return send(res, 200, JSON.stringify({ root: ROOT, files }), { 'Content-Type': MIME['.json'] });
  }

  if (pathname === '/__api/board') {
    const name = (url.searchParams.get('name') || 'default').replace(/[^a-z0-9_-]/gi, '') || 'default';
    const file = path.join(BOARDS, name + '.json');
    if (req.method === 'GET') {
      try { return send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME['.json'] }); }
      catch { return send(res, 200, '{}', { 'Content-Type': MIME['.json'] }); }
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 8e6) req.destroy(); });
      req.on('end', () => {
        try {
          fs.mkdirSync(BOARDS, { recursive: true });
          fs.writeFileSync(file, body);
          send(res, 200, JSON.stringify({ ok: true, file }), { 'Content-Type': MIME['.json'] });
        } catch (err) {
          send(res, 500, JSON.stringify({ ok: false, error: String(err) }), { 'Content-Type': MIME['.json'] });
        }
      });
      return;
    }
  }

  if (pathname === '/__api/boards') {
    let names = [];
    try { names = fs.readdirSync(BOARDS).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)); } catch {}
    return send(res, 200, JSON.stringify({ boards: names }), { 'Content-Type': MIME['.json'] });
  }

  // --- Static --------------------------------------------------------
  let target = pathname === '/' ? '/_canvas/index.html' : pathname;
  const abs = path.resolve(ROOT, '.' + target);
  if (!abs.startsWith(ROOT)) return send(res, 403, 'Forbidden');

  fs.stat(abs, (err, st) => {
    if (err) return send(res, 404, 'Not found: ' + target);
    const file = st.isDirectory() ? path.join(abs, 'index.html') : abs;
    fs.readFile(file, (err2, data) => {
      if (err2) return send(res, 404, 'Not found: ' + target);
      const ext = path.extname(file).toLowerCase();
      send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    });
  });
});

function listen(port, attempt) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 12) return listen(port + 1, attempt + 1);
    console.error(err);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const addr = 'http://localhost:' + port + '/';
    console.log('\n  Docs canvas serving  ' + ROOT);
    console.log('  ->  ' + addr + '\n  (ctrl+c to stop)\n');
    if (process.env.NO_OPEN) return;
    execFile('cmd', ['/c', 'start', '', addr], () => {});
  });
}

listen(START_PORT, 0);
