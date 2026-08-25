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

/* ------------------------------------------------------------------ roots
 *
 * The registry maps a root id to an absolute path, and nothing else. Which
 * folders a board *shows* is board state; this file decides only what is
 * *resolvable*. Keeping those separate is what makes removing a folder from a
 * board incapable of breaking a window that still points into it — so entries
 * are appended and never pruned.
 */
const ROOTS_FILE = path.join(CANVAS_DIR, 'roots.json');
let roots = [];

function loadRoots() {
  try { roots = JSON.parse(fs.readFileSync(ROOTS_FILE, 'utf8')).roots || []; }
  catch { roots = []; }
}
function saveRoots() {
  try { fs.writeFileSync(ROOTS_FILE, JSON.stringify({ roots }, null, 2)); }
  catch (e) { console.error('roots.json write failed:', e.message); }
}
function rootById(id) {
  return roots.find((r) => r.id === id) || null;
}

/* Two folders can share a basename ("docs", "reports"), which would make the
   tree ambiguous, so a colliding label gets its parent folder prepended. */
function labelFor(p) {
  const base = path.basename(p) || p;
  if (!roots.some((r) => r.label === base && r.path !== p)) return base;
  const parent = path.basename(path.dirname(p));
  return parent ? parent + '/' + base : base;
}

function registerRoot(absPath) {
  const abs = path.resolve(absPath);
  const existing = roots.find((r) => path.resolve(r.path) === abs);
  if (existing) return existing;             // stable ids across boards
  const rec = {
    id: 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    label: labelFor(abs),
    path: abs.split(path.sep).join('/'),
    addedAt: Date.now(),
  };
  roots.push(rec);
  saveRoots();
  return rec;
}

/* One level of a directory. `all` includes files the canvas cannot render, so
   the tree can look like the real folder; they come back renderable:false and
   the rail refuses to drag them. */
function listDir(rootPath, rel, all) {
  const dir = path.resolve(rootPath, '.' + '/' + (rel || ''));
  if (!under(rootPath, dir)) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }

  const dirs = [], files = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      dirs.push({ name: e.name });
    } else {
      const ext = path.extname(e.name).toLowerCase();
      const kind = KINDS[ext];
      if (!kind && !all) continue;
      let size = 0, mtime = 0;
      try { const st = fs.statSync(path.join(dir, e.name)); size = st.size; mtime = st.mtimeMs; } catch {}
      files.push({
        name: e.name, kind: kind || 'other', ext, size, mtime,
        renderable: !!kind,
      });
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { dirs, files };
}

/* Recursive, for search and recent. Returns root-relative paths. */
function walkRoot(rootPath, all, depth, rel, out, cap) {
  if (out.length >= cap || depth > 8) return out;
  const dir = rel ? path.join(rootPath, rel) : rootPath;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= cap) return out;
    const childRel = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walkRoot(rootPath, all, depth + 1, childRel, out, cap);
    } else {
      const ext = path.extname(e.name).toLowerCase();
      const kind = KINDS[ext];
      if (!kind && !all) continue;
      let size = 0, mtime = 0;
      try { const st = fs.statSync(path.join(dir, e.name)); size = st.size; mtime = st.mtimeMs; } catch {}
      out.push({
        name: e.name, path: childRel,
        dir: childRel.indexOf('/') === -1 ? '' : childRel.slice(0, childRel.lastIndexOf('/')),
        kind: kind || 'other', ext, size, mtime, renderable: !!kind,
      });
    }
  }
  return out;
}

const BOARDS = path.join(CANVAS_DIR, 'boards');
const ASSETS = path.join(CANVAS_DIR, 'assets');

function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({ 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}

/*
 * Read a request body as a Buffer.
 *
 * This exists because `body += chunk` does not work. It calls toString() on
 * each Buffer with utf8, so a multi-byte character split across a chunk
 * boundary decodes as two invalid halves and becomes U+FFFD — the bytes are
 * corrupted before anything is written. That silently mangles an em-dash in a
 * sticky note, and it destroys a PNG outright. Chunks must be concatenated as
 * bytes, and the size cap must count bytes rather than UTF-16 code units.
 *
 * cb(err, buffer). On overflow the request is answered 413 rather than being
 * destroyed mid-flight, which previously left the client hanging with no reply.
 */
function readBody(req, res, limit, cb) {
  const chunks = [];
  let size = 0;
  let done = false;

  req.on('data', (c) => {
    if (done) return;
    size += c.length;
    if (size > limit) {
      done = true;
      send(res, 413, JSON.stringify({ ok: false, error: 'body too large' }),
           { 'Content-Type': MIME['.json'] });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('error', (err) => { if (!done) { done = true; cb(err); } });
  req.on('end', () => { if (!done) { done = true; cb(null, Buffer.concat(chunks)); } });
}

/*
 * Is `abs` inside `base`? The separator matters: a bare
 * `abs.startsWith(base)` also accepts C:\docs-secret when base is C:\docs,
 * which `..` segments in a request can reach.
 */
function under(base, abs) {
  const b = path.resolve(base);
  return abs === b || abs.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // A malformed percent-escape (/%zz) makes decodeURIComponent throw, and an
  // uncaught throw in this handler takes the whole server down.
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain; charset=utf-8' }); }

  // --- API -----------------------------------------------------------

  // Lets a second launch recognise an already-running canvas rather than
  // starting a rival server on the next port.
  if (pathname === '/__api/ping') {
    return send(res, 200, JSON.stringify({ ok: true, app: 'docs-canvas', root: ROOT, pid: process.pid }),
                { 'Content-Type': MIME['.json'] });
  }

  /* Open the native folder dialog. This deliberately blocks the request until
     the user dismisses it — there is no sane timeout for "a human is choosing
     a folder", so the rail shows a pending state instead. */
  if (pathname === '/__api/pick-folder' && req.method === 'POST') {
    const ps1 = path.join(CANVAS_DIR, 'pick-folder.ps1');
    execFile('powershell.exe',
      ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      { windowsHide: false, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        if (err) {
          return send(res, 500, JSON.stringify({ ok: false, error: String(stderr || err).trim() }),
                      { 'Content-Type': MIME['.json'] });
        }
        const picked = String(stdout).trim();   // the script emits CRLF
        if (!picked) {
          return send(res, 200, JSON.stringify({ ok: true, cancelled: true }),
                      { 'Content-Type': MIME['.json'] });
        }
        let st;
        try { st = fs.statSync(picked); } catch { st = null; }
        if (!st || !st.isDirectory()) {
          return send(res, 400, JSON.stringify({ ok: false, error: 'not a folder: ' + picked }),
                      { 'Content-Type': MIME['.json'] });
        }
        const rec = registerRoot(picked);
        send(res, 200, JSON.stringify({ ok: true, root: rec }), { 'Content-Type': MIME['.json'] });
      });
    return;
  }

  // One level of one root. The whole point is that it does not recurse.
  if (pathname === '/__api/tree' && req.method === 'GET') {
    const r = rootById(url.searchParams.get('root') || '');
    if (!r) return send(res, 404, JSON.stringify({ ok: false, error: 'unknown root' }),
                        { 'Content-Type': MIME['.json'] });
    const listing = listDir(r.path, url.searchParams.get('dir') || '', url.searchParams.get('all') === '1');
    if (!listing) return send(res, 404, JSON.stringify({ ok: false, error: 'unreadable folder' }),
                              { 'Content-Type': MIME['.json'] });
    return send(res, 200, JSON.stringify(Object.assign({ ok: true, root: r.id }, listing)),
                { 'Content-Type': MIME['.json'] });
  }

  /* Search has to happen here rather than in the rail: once folders load one
     level at a time, the client simply does not have the files to filter. */
  if (pathname === '/__api/search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const all = url.searchParams.get('all') === '1';
    if (!q) return send(res, 200, JSON.stringify({ ok: true, hits: [] }), { 'Content-Type': MIME['.json'] });
    const ids = (url.searchParams.get('roots') || '').split(',').filter(Boolean);
    const hits = [];
    for (const id of ids) {
      const r = rootById(id);
      if (!r) continue;
      const found = walkRoot(r.path, all, 0, '', [], 400);
      for (const f of found) {
        if ((f.name + ' ' + f.dir).toLowerCase().indexOf(q) !== -1) {
          hits.push(Object.assign({ root: id, rootLabel: r.label }, f));
          if (hits.length >= 300) break;
        }
      }
      if (hits.length >= 300) break;
    }
    return send(res, 200, JSON.stringify({ ok: true, hits }), { 'Content-Type': MIME['.json'] });
  }

  // Newest-first across the board's roots — what /__api/files did, re-scoped.
  if (pathname === '/__api/recent' && req.method === 'GET') {
    const all = url.searchParams.get('all') === '1';
    const ids = (url.searchParams.get('roots') || '').split(',').filter(Boolean);
    let hits = [];
    for (const id of ids) {
      const r = rootById(id);
      if (!r) continue;
      for (const f of walkRoot(r.path, all, 0, '', [], 600)) {
        hits.push(Object.assign({ root: id, rootLabel: r.label }, f));
      }
    }
    hits.sort((a, b) => b.mtime - a.mtime);
    return send(res, 200, JSON.stringify({ ok: true, hits: hits.slice(0, 200) }),
                { 'Content-Type': MIME['.json'] });
  }

  // The default root, so a brand-new board still works with nothing picked.
  if (pathname === '/__api/default-root' && req.method === 'GET') {
    return send(res, 200, JSON.stringify({ ok: true, root: registerRoot(ROOT) }),
                { 'Content-Type': MIME['.json'] });
  }

  if (pathname === '/__api/board') {
    const name = (url.searchParams.get('name') || 'default').replace(/[^a-z0-9_-]/gi, '') || 'default';
    const file = path.join(BOARDS, name + '.json');
    if (req.method === 'GET') {
      try { return send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME['.json'] }); }
      catch { return send(res, 200, '{}', { 'Content-Type': MIME['.json'] }); }
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      readBody(req, res, 8e6, (err, body) => {
        if (err) return;
        try {
          fs.mkdirSync(BOARDS, { recursive: true });
          fs.writeFileSync(file, body);   // a Buffer, so the bytes land verbatim
          send(res, 200, JSON.stringify({ ok: true, file }), { 'Content-Type': MIME['.json'] });
        } catch (e) {
          send(res, 500, JSON.stringify({ ok: false, error: String(e) }), { 'Content-Type': MIME['.json'] });
        }
      });
      return;
    }
  }

  /*
   * Pasted screenshots. They are written to disk and referenced by path rather
   * than inlined into the board, because the board POST caps at 8MB and the
   * localStorage draft lane caps around 5MB — a couple of inline screenshots
   * and autosave would start failing silently. On disk they are just another
   * image file, so the canvas renders them through the path it already has.
   */
  if (pathname === '/__api/asset' && req.method === 'POST') {
    const board = (url.searchParams.get('board') || 'default').replace(/[^a-z0-9_-]/gi, '') || 'default';
    const ext = ('.' + (url.searchParams.get('ext') || 'png')).toLowerCase().replace(/[^a-z0-9.]/g, '');
    if (KINDS[ext] !== 'image') {
      return send(res, 400, JSON.stringify({ ok: false, error: 'unsupported asset type: ' + ext }),
                  { 'Content-Type': MIME['.json'] });
    }
    // 25MB: a 4K screenshot is 2-5MB, and this is loopback traffic.
    readBody(req, res, 25e6, (err, buf) => {
      if (err) return;
      try {
        const dir = path.join(ASSETS, board);
        fs.mkdirSync(dir, { recursive: true });

        // The filename becomes the window's tab label, so keep it readable —
        // a board narrated from tabs reading "mt90y271e56jy0" is useless. The
        // suffix keeps it unique without hiding what the file is.
        const hint = (url.searchParams.get('name') || 'screenshot')
          .replace(/\.[a-z0-9]+$/i, '')
          .replace(/[^a-z0-9 _-]/gi, ' ')
          .trim().replace(/\s+/g, '-').slice(0, 48) || 'screenshot';
        const name = hint + '-' + Date.now().toString(36).slice(-5) + ext;
        fs.writeFileSync(path.join(dir, name), buf);
        send(res, 200, JSON.stringify({
          ok: true,
          path: '_canvas/assets/' + board + '/' + name,
          kind: 'image',
          bytes: buf.length,
        }), { 'Content-Type': MIME['.json'] });
      } catch (e) {
        send(res, 500, JSON.stringify({ ok: false, error: String(e) }), { 'Content-Type': MIME['.json'] });
      }
    });
    return;
  }

  /* Enough about each board to choose between them without opening it. Boards
     are small JSON and there are a handful, so reading them all is cheaper
     than maintaining an index that could drift. */
  if (pathname === '/__api/boards' && req.method === 'GET') {
    const boards = [];
    let names = [];
    try { names = fs.readdirSync(BOARDS).filter((f) => f.endsWith('.json')); } catch {}
    for (const file of names) {
      const name = file.slice(0, -5);
      let b = null, savedAt = 0;
      try {
        const full = path.join(BOARDS, file);
        savedAt = fs.statSync(full).mtimeMs;
        b = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch { /* unreadable or half-written — still list it, just bare */ }
      boards.push({
        name,
        savedAt: (b && b.savedAt) || savedAt,
        nodes: b && b.nodes ? b.nodes.length : 0,
        folders: b && b.roots ? b.roots.map((r) => r.label) : [],
        v: (b && b.v) || 1,
      });
    }
    boards.sort((a, b) => b.savedAt - a.savedAt);
    return send(res, 200, JSON.stringify({ ok: true, boards }), { 'Content-Type': MIME['.json'] });
  }

  if (pathname === '/__api/board' && req.method === 'DELETE') {
    const name = (url.searchParams.get('name') || '').replace(/[^a-z0-9_-]/gi, '');
    if (!name) return send(res, 400, JSON.stringify({ ok: false, error: 'no name' }),
                           { 'Content-Type': MIME['.json'] });
    try { fs.unlinkSync(path.join(BOARDS, name + '.json')); }
    catch (e) { return send(res, 500, JSON.stringify({ ok: false, error: String(e) }),
                            { 'Content-Type': MIME['.json'] }); }
    return send(res, 200, JSON.stringify({ ok: true }), { 'Content-Type': MIME['.json'] });
  }

  /* --- Files inside a picked root ------------------------------------
     /__root/<id>/<relpath>. Documents keep working as ordinary URLs, so an
     HTML report's relative links to its own images and siblings resolve the
     way they do on disk — the whole reason the picker is server-side. */
  if (pathname.startsWith('/__root/')) {
    const rest = pathname.slice('/__root/'.length);
    const slash = rest.indexOf('/');
    const id = slash === -1 ? rest : rest.slice(0, slash);
    const rel = slash === -1 ? '' : rest.slice(slash + 1);
    const r = rootById(id);
    if (!r) return send(res, 404, 'Unknown root', { 'Content-Type': 'text/plain; charset=utf-8' });

    const fileAbs = path.resolve(r.path, '.' + '/' + rel);
    if (!under(r.path, fileAbs)) return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });

    return fs.readFile(fileAbs, (err, data) => {
      if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      const ext = path.extname(fileAbs).toLowerCase();
      send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    });
  }

  // --- Static --------------------------------------------------------
  let target = pathname === '/' ? '/_canvas/index.html' : pathname;

  /* The canvas's own files (and the assets it writes) live in CANVAS_DIR, which
     is only inside ROOT by coincidence — set DOCS_ROOT elsewhere and it is not.
     Resolving them explicitly means saved screenshots serve wherever the docs
     root points. */
  const inCanvas = target === '/_canvas' || target.startsWith('/_canvas/');
  const base = inCanvas ? CANVAS_DIR : ROOT;
  const rel = inCanvas ? target.slice('/_canvas'.length) : target;
  const abs = path.resolve(base, '.' + rel);

  if (!under(base, abs)) return send(res, 403, 'Forbidden');

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

function openBrowser(addr) {
  if (process.env.NO_OPEN) return;
  execFile('cmd', ['/c', 'start', '', addr], () => {});
}

/*
 * If the port is busy, find out WHO has it before doing anything.
 *
 * This used to walk straight to the next port, which is why running start.cmd
 * twice left you with tabs on 8765, 8766, 8767 — each a separate server, all
 * writing the same boards/ and quietly clobbering each other's saves. An
 * already-running canvas is not a conflict to route around; it is the thing
 * you were trying to open.
 */
function whoHasPort(port) {
  return fetch('http://127.0.0.1:' + port + '/__api/ping', { signal: AbortSignal.timeout(1500) })
    .then((r) => r.json())
    .then((j) => (j && j.app === 'docs-canvas' ? j : null))
    .catch(() => null);
}

function listen(port, attempt) {
  server.once('error', async (err) => {
    if (err.code !== 'EADDRINUSE') { console.error(err); process.exit(1); }

    const mine = await whoHasPort(port);
    if (mine) {
      const addr = 'http://localhost:' + port + '/';
      console.log('\n  Docs canvas is already running on ' + addr);
      console.log('  Serving ' + mine.root);
      console.log('  Opening that one instead of starting a second server.\n');
      openBrowser(addr);
      process.exit(0);
    }

    if (attempt < 12) {
      console.log('  Port ' + port + ' is taken by something else, trying ' + (port + 1) + '…');
      return listen(port + 1, attempt + 1);
    }
    console.error('Could not find a free port.');
    process.exit(1);
  });

  server.listen(port, '127.0.0.1', () => {
    const addr = 'http://localhost:' + port + '/';
    console.log('\n  Docs canvas serving  ' + ROOT);
    console.log('  ->  ' + addr + '\n  (ctrl+c to stop)\n');
    openBrowser(addr);
  });
}

loadRoots();
registerRoot(ROOT);   // the default root always resolves, picked or not
listen(START_PORT, 0);
