/*
 * Phase 3 smoke test — folder tree, per-board roots, schema v2.
 *
 * The folder dialog itself cannot be automated, so this exercises everything
 * downstream of it by seeding a board with roots directly, plus the v1
 * migration path, which is the part most likely to break silently.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { makePng } = require('./make-png');

const URL = 'http://127.0.0.1:8765/';
const CV = path.resolve(__dirname, '..');   // the _canvas folder
const errors = [];
let failures = 0;

function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

const roots = JSON.parse(fs.readFileSync(path.join(CV, 'roots.json'), 'utf8')).roots;
const R = roots[0];

function seed(name, board) {
  fs.writeFileSync(path.join(CV, 'boards', name + '.json'), JSON.stringify(board));
}

(async () => {
  // A v2 board showing one folder, with the root branch expanded.
  seed('default', {
    v: 2, savedAt: Date.now(), camera: { x: 0, y: 0, z: 1 },
    nodes: [], edges: [], strokes: [],
    roots: [{ id: R.id, label: R.label, path: R.path }],
    open: { [R.id]: [''] },
  });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  // ---------------------------------------------------------------- tree
  console.log('\n[tree]');
  const branches = await page.$$eval('.fold.root > summary .n', n => n.map(e => e.textContent));
  check('the board\'s folder is a top-level branch', branches.length === 1 && branches[0] === R.label,
        JSON.stringify(branches));

  const top = await page.evaluate(() => ({
    folders: [...document.querySelectorAll('.fold.root > .kids > .fold > summary > .n')].map(e => e.textContent),
    files: [...document.querySelectorAll('.fold.root > .kids > .f > .n')].map(e => e.textContent),
  }));
  check('root branch lazy-loaded one level', top.folders.length > 3, JSON.stringify(top.folders.slice(0, 4)));
  check('_canvas is skipped', !top.folders.includes('_canvas'), JSON.stringify(top.folders));

  // Expand a nested folder -> proves lazy loading goes deeper on demand
  const target = '2026-05-15 (Startup Start)';
  const opened = await page.evaluate(async (name) => {
    const sums = [...document.querySelectorAll('.fold.root > .kids > .fold')];
    const f = sums.find(d => d.querySelector('summary > .n').textContent === name);
    if (!f) return null;
    f.open = true;
    await new Promise(r => setTimeout(r, 700));
    return [...f.querySelectorAll(':scope > .kids > .f > .n')].map(e => e.textContent);
  }, target);
  check('expanding a folder loads its children', opened && opened.length >= 2, JSON.stringify(opened));

  // ---------------------------------------------------------------- guides
  console.log('\n[guide lines]');
  const guides = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.fold.root > .kids > .f')];
    const last = rows[rows.length - 1];
    return {
      anyElbow: !!document.querySelector('.gd.elbow'),
      lastIsLast: last ? !!last.querySelector('.gd.elbow.last') : false,
      depth2HasSpacer: !!document.querySelector('.kids .kids .f .gd:not(.elbow)'),
    };
  });
  check('elbow connectors rendered', guides.anyElbow, JSON.stringify(guides));
  check('last child draws the L, not the T', guides.lastIsLast, JSON.stringify(guides));
  check('depth 2 rows carry an ancestor spacer', guides.depth2HasSpacer, JSON.stringify(guides));

  // ---------------------------------------------------------------- drag to canvas
  console.log('\n[drag onto canvas]');
  const before = await page.$$eval('.node', n => n.length);
  await page.evaluate(async () => {
    const row = [...document.querySelectorAll('.f')].find(r => /\.html$/.test(r.title));
    row.click();
    await new Promise(r => setTimeout(r, 400));
  });
  await page.waitForTimeout(900);
  const node = await page.evaluate(() => {
    const f = document.querySelector('.node iframe');
    return f ? { src: f.getAttribute('src') } : null;
  });
  check('clicking a file opened a window', !!node, JSON.stringify(node));
  check('it loads through /__root/<id>/', !!node && node.src.indexOf('/__root/') === 0, node && node.src);

  const loaded = await page.evaluate(async () => {
    const f = document.querySelector('.node iframe');
    // same-origin, so a real load means a reachable document
    for (let i = 0; i < 30; i++) {
      try { if (f.contentDocument && f.contentDocument.body && f.contentDocument.body.childElementCount) return true; }
      catch (e) { return true; }
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  });
  check('THE DOCUMENT ACTUALLY LOADED (root URL resolves)', loaded);

  // ---------------------------------------------------------------- search
  console.log('\n[search]');
  await page.fill('#search', 'timeline');
  await page.waitForTimeout(900);
  const hits = await page.$$eval('#fileList .f .n', n => n.map(e => e.textContent));
  check('server-side search returns hits', hits.length >= 2, JSON.stringify(hits));
  check('results show where each file lives',
        await page.$$eval('#fileList .f .where', n => n.length) === hits.length);
  await page.fill('#search', '');
  await page.waitForTimeout(600);

  // ---------------------------------------------------------------- all files
  console.log('\n[show all files]');
  await page.click('[data-act="rail-all"]');
  await page.waitForTimeout(900);
  // The folders open so far happen to hold only renderable files, so expand
  // one that has .docx/.heic/.exe in it.
  const dim = await page.evaluate(async () => {
    const f = [...document.querySelectorAll('.fold.root > .kids > .fold')]
      .find(d => d.querySelector('summary > .n').textContent === '2026-02-01');
    if (!f) return { count: 0, draggable: false, note: 'folder not found' };
    f.open = true;
    await new Promise(r => setTimeout(r, 900));
    const rows = [...f.querySelectorAll(':scope > .kids > .f.dim')];
    return {
      count: rows.length,
      draggable: rows.some(r => r.draggable),
      sample: rows.slice(0, 3).map(r => r.querySelector('.n').textContent),
    };
  });
  check('non-renderable files appear when All is on', dim.count > 0, JSON.stringify(dim));
  check('and they refuse to be dragged', dim.draggable === false, JSON.stringify(dim));
  await page.click('[data-act="rail-all"]');
  await page.waitForTimeout(700);

  // ---------------------------------------------------------------- recent
  console.log('\n[recent]');
  await page.click('[data-act="rail-recent"]');
  await page.waitForTimeout(900);
  const recent = await page.$$eval('#fileList .f .n', n => n.map(e => e.textContent));
  check('recent mode lists files', recent.length > 5, String(recent.length));
  await page.click('[data-act="rail-tree"]');
  await page.waitForTimeout(700);

  // ---------------------------------------------------------------- persistence
  console.log('\n[save / reload]');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(800);
  const saved = JSON.parse(fs.readFileSync(path.join(CV, 'boards/default.json'), 'utf8'));
  check('board saved at v2', saved.v === 2, String(saved.v));
  check('board records its folder', saved.roots.length === 1 && saved.roots[0].id === R.id,
        JSON.stringify(saved.roots));
  check('board records expanded folders',
        !!saved.open[R.id] && saved.open[R.id].includes(target),
        JSON.stringify(saved.open));
  check('tab carries its root id', saved.nodes[0].tabs[0].root === R.id,
        JSON.stringify(saved.nodes[0].tabs[0]));

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);
  const restored = await page.evaluate((name) => {
    const f = [...document.querySelectorAll('.fold')].find(
      d => d.querySelector('summary > .n') && d.querySelector('summary > .n').textContent === name);
    return { open: f ? f.open : null, nodes: document.querySelectorAll('.node').length };
  }, target);
  check('expanded folder came back after reload', restored.open === true, JSON.stringify(restored));
  check('window came back', restored.nodes === 1, JSON.stringify(restored));

  // ---------------------------------------------------------------- removing a folder
  console.log('\n[remove folder — must not break windows]');
  await page.evaluate(() => document.querySelector('.fold.root > summary .x').click());
  await page.waitForTimeout(600);
  const afterRemove = await page.evaluate(() => {
    const f = document.querySelector('.node iframe');
    let alive = false;
    try { alive = !!(f && (f.contentDocument === null || f.contentDocument.body)); } catch (e) { alive = true; }
    return {
      branches: document.querySelectorAll('.fold.root').length,
      nodes: document.querySelectorAll('.node').length,
      src: f ? f.getAttribute('src') : null,
      alive,
    };
  });
  check('the branch is gone from the rail', afterRemove.branches === 0, JSON.stringify(afterRemove));
  check('THE WINDOW IS UNTOUCHED', afterRemove.nodes === 1 && afterRemove.alive,
        JSON.stringify(afterRemove));

  const stillServes = await page.evaluate(async (src) => {
    const r = await fetch(src);
    return r.status;
  }, afterRemove.src);
  check('and its file still serves (registry outlives the board)', stillServes === 200, String(stillServes));

  // ---------------------------------------------------------------- v1 migration
  console.log('\n[v1 board migration]');
  seed('legacy', {
    v: 1, savedAt: Date.now(), camera: { x: 0, y: 0, z: 1 },
    nodes: [
      { id: 'n1', type: 'doc', x: 60, y: 60, w: 700, h: 500,
        tabs: [{ id: 't1', kind: 'html', path: '2026-05-15 (Startup Start)/stu-timeline.html', title: 'stu-timeline' }],
        active: 't1' },
      { id: 'n2', type: 'doc', x: 800, y: 60, w: 500, h: 400,
        tabs: [{ id: 't2', kind: 'image', path: '_canvas/assets/legacy/keep.png', title: 'keep' }],
        active: 't2' },
    ],
    edges: [],
  });
  fs.mkdirSync(path.join(CV, 'assets/legacy'), { recursive: true });
  fs.writeFileSync(path.join(CV, 'assets/legacy/keep.png'), makePng());

  // The name field renames rather than switching boards now (phase 4), so open
  // the legacy board through the Open panel the way a user would.
  await page.evaluate(() => { localStorage.clear(); });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(900);
  await page.click('[data-act="open"]');
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    [...document.querySelectorAll('.brd')]
      .find(r => r.querySelector('.brd-n').textContent === 'legacy')
      .querySelector('.brd-main').click();
  });
  await page.waitForTimeout(2200);

  const migrated = await page.evaluate(() => {
    const frames = [...document.querySelectorAll('.node iframe')].map(f => f.getAttribute('src'));
    const imgs = [...document.querySelectorAll('.node img')].map(i => ({ src: i.getAttribute('src'), w: i.naturalWidth }));
    return { frames, imgs, branches: document.querySelectorAll('.fold.root').length };
  });
  check('v1 doc migrated onto the default root',
        migrated.frames.length === 1 && migrated.frames[0].indexOf('/__root/') === 0,
        JSON.stringify(migrated.frames));
  check('v1 asset kept its bare path',
        migrated.imgs.length === 1 && migrated.imgs[0].src.indexOf('/_canvas/assets/') === 0,
        JSON.stringify(migrated.imgs));
  check('and the asset still decodes', migrated.imgs.length === 1 && migrated.imgs[0].w > 0,
        JSON.stringify(migrated.imgs));
  check('migrated board got a folder in the rail', migrated.branches === 1, String(migrated.branches));

  console.log('\n[console]');
  check('zero console errors / pageerrors', errors.length === 0, errors.join('; '));

  await page.screenshot({ path: 'phase3.png' });
  await browser.close();
  console.log('\n' + (failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('\nHARNESS ERROR: ' + e.message + '\n' + e.stack); process.exit(2); });
