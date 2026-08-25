#!/usr/bin/env node
/*
 * Runs every suite against a freshly started server.
 *
 *   node test/run.js              all suites
 *   node test/run.js 03 06        only the suites whose filename starts 03 / 06
 *
 * Needs Playwright, which is a DEV dependency only:  cd test && npm install
 * The canvas itself still has none, and still needs no build step.
 *
 * Two rules this enforces, both learned the hard way:
 *
 *  - boards/ is wiped between suites. A board saved by one run gets loaded by
 *    the next and the layout drifts, so results depend on run order.
 *  - default.json is SEEDED EMPTY rather than deleted. With no board on disk
 *    the app creates a welcome note, which silently offsets every node count
 *    in every assertion.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CANVAS = path.resolve(__dirname, '..');
const BOARDS = path.join(CANVAS, 'boards');
const ASSETS = path.join(CANVAS, 'assets');
const PORT = 8765;

// Suites that predate the folder tree still expect a v1 board on disk.
const WANTS_V1_SEED = new Set(['01-nodes.js', '02-screenshots.js']);

const EMPTY_V1 = JSON.stringify({
  v: 1, savedAt: 1, camera: { x: 0, y: 0, z: 1 }, nodes: [], edges: [],
});

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }

function resetBoards(seedV1) {
  fs.mkdirSync(BOARDS, { recursive: true });
  for (const f of fs.readdirSync(BOARDS)) {
    if (f.endsWith('.json')) fs.unlinkSync(path.join(BOARDS, f));
  }
  rmrf(ASSETS);
  if (seedV1) fs.writeFileSync(path.join(BOARDS, 'default.json'), EMPTY_V1);
}

function waitForServer(ms) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    (function poll() {
      fetch('http://127.0.0.1:' + PORT + '/')
        .then(() => resolve())
        .catch(() => {
          if (Date.now() > deadline) return reject(new Error('server did not start'));
          setTimeout(poll, 200);
        });
    })();
  });
}

function run(file) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, file)], {
      cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    p.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
    p.on('close', (code) => resolve({ file, code, out }));
  });
}

(async () => {
  // Back up whatever board the user actually has, so running tests is not
  // destructive to real work.
  const backup = new Map();
  try {
    for (const f of fs.readdirSync(BOARDS)) {
      if (f.endsWith('.json')) backup.set(f, fs.readFileSync(path.join(BOARDS, f)));
    }
  } catch {}

  const only = process.argv.slice(2);
  const suites = fs.readdirSync(__dirname)
    .filter((f) => /^\d\d-.*\.js$/.test(f))
    .filter((f) => !only.length || only.some((o) => f.startsWith(o)))
    .sort();

  if (!suites.length) { console.error('no suites matched'); process.exit(2); }

  console.log('starting server on ' + PORT + '…');
  const server = spawn(process.execPath, [path.join(CANVAS, 'server.js')], {
    env: Object.assign({}, process.env, { NO_OPEN: '1' }),
    stdio: 'ignore',
  });

  let failed = 0;
  try {
    await waitForServer(10000);
    for (const file of suites) {
      resetBoards(WANTS_V1_SEED.has(file));
      console.log('\n' + '='.repeat(58) + '\n  ' + file + '\n' + '='.repeat(58));
      const r = await run(file);
      if (r.code !== 0) failed++;
    }
  } catch (e) {
    console.error(e.message);
    failed++;
  } finally {
    server.kill();
    resetBoards(false);
    for (const [f, buf] of backup) fs.writeFileSync(path.join(BOARDS, f), buf);
    if (backup.size) console.log('\nrestored ' + backup.size + ' board file(s)');
  }

  console.log('\n' + (failed ? failed + ' SUITE(S) FAILED' : 'ALL SUITES PASSED'));
  process.exit(failed ? 1 : 0);
})();
