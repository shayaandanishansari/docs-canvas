/*
 * Phase 4 + 5 smoke test — board browser, and the ink layer.
 *
 * The load-bearing ink assertion is the zoom one: a stroke drawn at 25% and a
 * stroke drawn at 250% must come out the same width ON SCREEN, which is what
 * dividing the pen size by the camera zoom buys. Measuring it needs the
 * rendered geometry, not the stored numbers.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = 'http://127.0.0.1:8765/';
const CV = path.resolve(__dirname, '..');   // the _canvas folder
const errors = [];
let failures = 0;

function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

const R = JSON.parse(fs.readFileSync(path.join(CV, 'roots.json'), 'utf8')).roots[0];
const blank = (extra) => Object.assign({
  v: 2, savedAt: Date.now(), camera: { x: 0, y: 0, z: 1 },
  nodes: [], edges: [], strokes: [],
  // expanded on a folder that contains .html, so file rows exist to click
  roots: [{ id: R.id, label: R.label, path: R.path }],
  open: { [R.id]: ['', '2026-05-15 (Startup Start)'] },
}, extra || {});

// Draw a stroke by dragging across the empty canvas, well clear of the rail.
async function draw(page, x, y, len) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x + (len * i) / 10, y + Math.sin(i) * 6, { steps: 2 });
  await page.mouse.up();
  await page.waitForTimeout(200);
}

/* The sidebar is shut at rest now — every control moved into it, so a suite has
   to open it before it can click Save, the pen or the Add buttons. Idempotent,
   and needed again after every reload. */
async function openRail(page) {
  await page.waitForSelector('#railToggle');
  if (await page.evaluate(() => document.querySelector('#rail').classList.contains('hidden'))) {
    await page.click('#railToggle');
    await page.waitForTimeout(250);
  }
}

(async () => {
  fs.writeFileSync(path.join(CV, 'boards/default.json'), JSON.stringify(blank()));
  fs.writeFileSync(path.join(CV, 'boards/other.json'), JSON.stringify(blank({
    nodes: [{ id: 'n1', type: 'note', x: 10, y: 10, w: 200, h: 120, text: 'hi' }],
  })));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  await openRail(page);

  // ================================================================ PHASE 4
  console.log('\n[board browser]');
  await page.click('[data-act="open"]');
  await page.waitForTimeout(700);

  const rows = await page.$$eval('.brd', rs => rs.map(r => ({
    name: r.querySelector('.brd-n').textContent,
    sub: r.querySelector('.brd-sub').textContent,
    current: r.classList.contains('current'),
  })));
  check('the panel lists boards', rows.length >= 2, JSON.stringify(rows.map(r => r.name)));
  check('it is a rail view, not a floating layer',
        await page.$$eval('#rail.boards', n => n.length) === 1);
  check('the current board is marked', rows.some(r => r.current && r.name === 'default'),
        JSON.stringify(rows));
  check('rows show window count and age',
        rows.every(r => /window/.test(r.sub) && /(ago|now|never|\d{4}-)/.test(r.sub)),
        JSON.stringify(rows.map(r => r.sub)));
  check('rows show which folders the board uses',
        rows.some(r => r.sub.indexOf(R.label) !== -1), JSON.stringify(rows.map(r => r.sub)));

  // Opening from the panel must switch board and return to the file view
  await page.evaluate(() => {
    [...document.querySelectorAll('.brd')]
      .find(r => r.querySelector('.brd-n').textContent === 'other')
      .querySelector('.brd-main').click();
  });
  await page.waitForTimeout(1500);
  const switched = await page.evaluate(() => ({
    name: document.querySelector('#boardName').value,
    notes: document.querySelectorAll('.node.type-note').length,
    view: document.querySelector('#rail').className,
  }));
  check('clicking a board opens it', switched.name === 'other' && switched.notes === 1,
        JSON.stringify(switched));
  check('and the rail returns to the files view', switched.view.indexOf('boards') === -1,
        switched.view);

  // Escape closes the panel
  await page.click('[data-act="open"]');
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Escape closes the panel',
        await page.$$eval('#rail.boards', n => n.length) === 0);

  // The name field renames rather than silently switching boards
  console.log('\n[name field no longer switches boards]');
  await page.fill('#boardName', 'renamed');
  await page.press('#boardName', 'Enter');
  await page.waitForTimeout(900);
  const renamed = await page.evaluate(() => ({
    name: document.querySelector('#boardName').value,
    notes: document.querySelectorAll('.node.type-note').length,
  }));
  check('typing a name keeps the board you were on',
        renamed.name === 'renamed' && renamed.notes === 1, JSON.stringify(renamed));
  check('and it saved under the new name', fs.existsSync(path.join(CV, 'boards/renamed.json')));
  check('the old file is left alone', fs.existsSync(path.join(CV, 'boards/other.json')));

  // ================================================================ PHASE 5
  console.log('\n[ink]');
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(500);
  await openRail(page);
  await page.fill('#boardName', 'default');
  await page.waitForTimeout(200);
  await page.evaluate(() => { localStorage.clear(); });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  await openRail(page);

  check('perfect-freehand loaded as a plain script',
        await page.evaluate(() => typeof window.PerfectFreehand === 'object'
                                 && typeof window.PerfectFreehand.getStroke === 'function'));

  await page.click('[data-act="pen"]');
  await page.waitForTimeout(200);
  check('pen mode engages', await page.evaluate(() => document.querySelector('#viewport').classList.contains('drawing')));

  await draw(page, 600, 300, 260);
  const one = await page.evaluate(() => ({
    paths: document.querySelectorAll('#ink g.stroke').length,
    live: document.querySelectorAll('#ink path.live').length,
    d: (document.querySelector('#ink path.body') || {}).getAttribute
       ? document.querySelector('#ink path.body').getAttribute('d').slice(0, 12) : null,
  }));
  check('a stroke was committed', one.paths === 1, JSON.stringify(one));
  check('the live preview element is cleaned up', one.live === 0, JSON.stringify(one));
  check('it is a filled outline path', !!one.d && one.d[0] === 'M', JSON.stringify(one));

  // Panning must still work with the pen off
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Escape leaves pen mode',
        await page.evaluate(() => !document.querySelector('#viewport').classList.contains('drawing')));

  const camBefore = await page.evaluate(() => document.querySelector('#world').style.transform);
  await page.mouse.move(700, 700); await page.mouse.down();
  await page.mouse.move(760, 740, { steps: 5 }); await page.mouse.up();
  await page.waitForTimeout(300);
  const camAfter = await page.evaluate(() => document.querySelector('#world').style.transform);
  check('dragging empty canvas pans again once the pen is off', camBefore !== camAfter);

  // ---- annotating a document, which is the whole point of the pen
  console.log('\n[drawing over a document]');
  await page.evaluate(() => {
    // put a window under the pen's path
    const r = [...document.querySelectorAll('.f')].find(x => /\.html$/.test(x.title));
    if (r) r.click();
  });
  await page.waitForTimeout(1600);
  const box = await page.evaluate(() => {
    const n = document.querySelector('.node');
    if (!n) return null;
    n.style.left = '600px'; n.style.top = '260px';
    n.style.width = '620px'; n.style.height = '380px';
    const b = n.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
  check('a document window is open to draw on', !!box, JSON.stringify(box));

  const inkBefore = await page.$$eval('#ink g.stroke', n => n.length);
  await page.click('[data-act="pen"]');
  await page.waitForTimeout(200);
  // drag straight across the middle of the document
  const cy = box.y + box.h / 2;
  await page.mouse.move(box.x + 60, cy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + 60 + i * 55, cy, { steps: 2 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const inkAfter = await page.$$eval('#ink g.stroke', n => n.length);
  check('THE PEN DRAWS OVER A DOCUMENT', inkAfter === inkBefore + 1,
        inkBefore + ' -> ' + inkAfter);

  const above = await page.evaluate(() => {
    const s = document.querySelector('#ink');
    const n = document.querySelector('#nodes');
    return { ink: getComputedStyle(s).zIndex, nodes: getComputedStyle(n).zIndex };
  });
  check('and the ink sits above the window, not behind it',
        Number(above.ink) > Number(above.nodes), JSON.stringify(above));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const catcherGone = await page.evaluate(() => document.querySelector('#drawSurface').hidden);
  check('the pen surface is removed when the mode ends', catcherGone === true);

  // Invariant 4's lesson: a leftover overlay must not eat clicks on the canvas
  const clickable = await page.evaluate(() => {
    const el = document.elementFromPoint(window.innerWidth - 120, window.innerHeight - 200);
    return el ? el.id || el.className : null;
  });
  check('the canvas is clickable again', String(clickable).indexOf('drawSurface') === -1,
        String(clickable));

  // clear the window so later measurements are on empty canvas
  await page.evaluate(() => {
    const n = document.querySelector('.node');
    if (n) n.querySelector('.chrome-actions button:last-child').click();
  });
  await page.waitForTimeout(400);

  // ---- the one that matters: same on-screen width at any zoom
  console.log('\n[stroke width is zoom-independent]');

  // Zoom the way a user does — ctrl+wheel through the app's own camera maths.
  // Playwright's mouse.wheel cannot set ctrlKey, so dispatch the same event
  // the browser would; onWheel is a plain listener and does not care.
  async function zoomTo(target) {
    for (let i = 0; i < 60; i++) {
      const z = await page.evaluate(() => parseInt(document.querySelector('#zoomVal').textContent) / 100);
      if (Math.abs(z - target) / target < 0.06) return z;
      await page.evaluate((dy) => {
        document.querySelector('#viewport').dispatchEvent(new WheelEvent('wheel', {
          clientX: 900, clientY: 500, deltaY: dy, ctrlKey: true, bubbles: true, cancelable: true,
        }));
      }, z > target ? 90 : -90);
      await page.waitForTimeout(30);
    }
    return page.evaluate(() => parseInt(document.querySelector('#zoomVal').textContent) / 100);
  }

  const widths = [];
  for (const target of [0.25, 1, 2.5]) {
    const z = await zoomTo(target);
    await page.click('[data-act="pen"]');           // pen back on
    await page.waitForTimeout(150);
    const before = await page.$$eval('#ink g.stroke', n => n.length);
    // A dead-flat horizontal drag, so the rendered height IS the stroke width.
    await page.mouse.move(700, 520);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(700 + i * 18, 520, { steps: 2 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const m = await page.evaluate((n) => {
      const gs = document.querySelectorAll('#ink g.stroke');
      if (gs.length === n) return null;
      const r = gs[gs.length - 1].querySelector('path.body').getBoundingClientRect();
      return +r.height.toFixed(2);
    }, before);
    widths.push({ zoom: Math.round(z * 100) + '%', screenH: m });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
  }
  console.log('   measured:', JSON.stringify(widths));
  const hs = widths.map(w => w.screenH).filter(h => h != null);
  check('a stroke was drawable at all three zoom levels', hs.length === 3, JSON.stringify(widths));
  check('ON-SCREEN width is the same at 25%, 100% and 250%',
        hs.length === 3 && (Math.max(...hs) - Math.min(...hs)) < 2.5,
        JSON.stringify(widths));

  // ---- world registration
  console.log('\n[world registration]');
  await page.keyboard.press('0');                     // reset zoom to 100%
  await page.waitForTimeout(500);
  const reg = await (async () => {
    const a = await page.evaluate(() =>
      document.querySelector('#ink path.body').getBoundingClientRect().x);
    await page.mouse.move(1000, 800);
    await page.mouse.down();
    await page.mouse.move(1120, 880, { steps: 8 });    // real pan drag
    await page.mouse.up();
    await page.waitForTimeout(300);
    const b = await page.evaluate(() =>
      document.querySelector('#ink path.body').getBoundingClientRect().x);
    return +(b - a).toFixed(1);
  })();
  check('strokes move with the camera when panning', Math.abs(reg - 120) < 3, 'moved ' + reg + 'px, expected ~120');

  // ---- simplification + persistence
  console.log('\n[simplify / persist]');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(900);
  const saved = JSON.parse(fs.readFileSync(path.join(CV, 'boards/default.json'), 'utf8'));
  check('strokes are serialised', (saved.strokes || []).length >= 4, String((saved.strokes || []).length));
  const maxPts = Math.max(...saved.strokes.map(s => s.pts.length));
  check('points are simplified, not a raw trail', maxPts <= 20, 'max pts per stroke: ' + maxPts);
  check('stored in world coordinates (no screen-sized numbers)',
        saved.strokes.every(s => s.pts.every(p => Math.abs(p[0]) < 1e5)), 'ok');

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1400);
  check('strokes survive reload',
        await page.$$eval('#ink g.stroke', n => n.length) === saved.strokes.length);

  // ---- fit
  // Selecting and deleting strokes is owned by phase6.js, which drives it with
  // real mouse input. Duplicating it here was fragile: by this point the zoom
  // and pan tests have pushed every stroke off-screen, so the click landed on
  // nothing and the assertion was measuring the test, not the app.
  console.log('\n[fit includes ink]');
  const offscreen = await page.evaluate(() =>
    [...document.querySelectorAll('#ink path.body')].every(el => {
      const r = el.getBoundingClientRect();
      return r.right < 0 || r.bottom < 0 || r.x > innerWidth || r.y > innerHeight;
    }));
  check('precondition: the pan/zoom tests left the ink off-screen', offscreen);

  await page.keyboard.press('f');
  await page.waitForTimeout(800);
  const visible = await page.evaluate(() =>
    [...document.querySelectorAll('#ink path.body')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.x > 290 && r.y > 60 && r.right < innerWidth && r.bottom < innerHeight;
    }).length);
  check('Fit brings ink back on screen (strokes count as content)',
        visible > 0, 'visible: ' + visible);

  console.log('\n[console]');
  check('zero console errors / pageerrors', errors.length === 0, errors.join('; '));

  await page.screenshot({ path: 'phase45.png' });
  await browser.close();
  console.log('\n' + (failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('\nHARNESS ERROR: ' + e.message + '\n' + e.stack); process.exit(2); });
