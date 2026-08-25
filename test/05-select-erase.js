/*
 * Selection + eraser.
 *
 * Every interaction here is driven with page.mouse — REAL pointer events.
 * The previous suite asserted stroke selection by dispatching a click straight
 * at the hit path, which bypasses hit-testing and pointer capture entirely and
 * therefore passed against code that did not work. Anything that claims a
 * click works must click.
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

async function penStroke(page, y, x0, x1) {
  await page.mouse.move(x0, y);
  await page.mouse.down();
  const n = 8;
  for (let i = 1; i <= n; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / n, y, { steps: 2 });
  await page.mouse.up();
  await page.waitForTimeout(220);
}

(async () => {
  fs.writeFileSync(path.join(CV, 'boards/default.json'), JSON.stringify({
    v: 2, savedAt: Date.now(), camera: { x: 0, y: 0, z: 1 },
    nodes: [
      { id: 'n1', type: 'note', x: 480, y: 90, w: 200, h: 120, text: 'A' },
      { id: 'n2', type: 'note', x: 1050, y: 330, w: 200, h: 120, text: 'B' },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'n2' }], strokes: [],
    roots: [{ id: R.id, label: R.label, path: R.path }], open: {},
  }));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(1300);

  // ---------------------------------------------------------------- setup
  await page.click('[data-act="pen"]');
  await page.waitForTimeout(200);
  await penStroke(page, 640, 460, 860);
  await penStroke(page, 720, 460, 860);
  await penStroke(page, 800, 460, 860);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('three strokes drawn', await page.$$eval('#ink g.stroke', n => n.length) === 3);

  // ---------------------------------------------------------------- selection
  console.log('\n[selecting with a REAL click]');
  const mid = await page.evaluate(() => {
    const r = document.querySelectorAll('#ink path.body')[0].getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  await page.mouse.click(mid.x, mid.y);
  await page.waitForTimeout(300);
  check('clicking a stroke selects it',
        await page.$$eval('#ink g.stroke.sel', n => n.length) === 1);

  // Selecting must not also pan the canvas
  const camA = await page.evaluate(() => document.querySelector('#world').style.transform);
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move(mid.x + 70, mid.y + 40, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const camB = await page.evaluate(() => document.querySelector('#world').style.transform);
  check('dragging from a stroke does not pan the canvas', camA === camB, camA + ' / ' + camB);

  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);
  check('Delete removes the selected stroke',
        await page.$$eval('#ink g.stroke', n => n.length) === 2);

  // The same bug affected arrows; it was pre-existing
  console.log('\n[arrows too]');
  const eat = await page.evaluate(() => {
    const r = document.querySelector('#edges g path:not(.hit)').getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  await page.mouse.click(eat.x, eat.y);
  await page.waitForTimeout(300);
  check('clicking an arrow selects it',
        await page.$$eval('#edges g.sel', n => n.length) === 1);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);
  check('Delete removes the arrow',
        await page.$$eval('#edges g', n => n.length) === 0);

  // Clicking empty canvas clears
  await page.mouse.click(1400, 850);
  await page.waitForTimeout(250);
  check('clicking empty canvas deselects',
        await page.$$eval('#ink g.stroke.sel', n => n.length) === 0);

  // ---------------------------------------------------------------- eraser
  console.log('\n[eraser]');
  await page.click('[data-act="erase"]');
  await page.waitForTimeout(250);
  const on = await page.evaluate(() => ({
    surface: !document.querySelector('#drawSurface').hidden,
    ring: !document.querySelector('#eraseRing').hidden,
    btn: document.querySelector('#eraseBtn').classList.contains('on'),
  }));
  check('eraser mode engages with its ring', on.surface && on.ring && on.btn, JSON.stringify(on));

  const penOff = await page.evaluate(() => !document.querySelector('#penBtn').classList.contains('on'));
  check('turning on the eraser turns off the pen', penOff);

  const beforeErase = await page.$$eval('#ink g.stroke', n => n.length);
  const target = await page.evaluate(() => {
    const r = document.querySelectorAll('#ink path.body')[0].getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  await page.mouse.move(target.x - 90, target.y);
  await page.mouse.down();
  await page.mouse.move(target.x + 90, target.y, { steps: 10 });   // sweep through it
  await page.mouse.up();
  await page.waitForTimeout(350);
  check('dragging the eraser across a stroke removes it',
        await page.$$eval('#ink g.stroke', n => n.length) === beforeErase - 1,
        beforeErase + ' -> ' + (await page.$$eval('#ink g.stroke', n => n.length)));

  // Erasing empty space must not remove anything
  const n1 = await page.$$eval('#ink g.stroke', n => n.length);
  await page.mouse.move(1400, 200);
  await page.mouse.down();
  await page.mouse.move(1500, 260, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  check('erasing empty space removes nothing',
        await page.$$eval('#ink g.stroke', n => n.length) === n1);

  // The ring should follow the pointer
  const ringMoved = await (async () => {
    await page.mouse.move(900, 400); await page.waitForTimeout(120);
    const a = await page.evaluate(() => document.querySelector('#eraseRing').style.left);
    await page.mouse.move(1000, 500); await page.waitForTimeout(120);
    const b = await page.evaluate(() => document.querySelector('#eraseRing').style.left);
    return a !== b;
  })();
  check('the ring follows the pointer', ringMoved);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  const off = await page.evaluate(() => ({
    surface: document.querySelector('#drawSurface').hidden,
    ring: document.querySelector('#eraseRing').hidden,
  }));
  check('Escape leaves eraser mode and removes its surface', off.surface && off.ring, JSON.stringify(off));

  // ---------------------------------------------------------------- erase over a document
  console.log('\n[eraser reaches over a document]');
  await page.evaluate(() => {
    const n = document.querySelector('.node');
    if (n) { n.style.left = '380px'; n.style.top = '520px'; n.style.width = '700px'; n.style.height = '340px'; }
  });
  await page.waitForTimeout(200);
  await page.click('[data-act="pen"]');
  await page.waitForTimeout(200);
  await penStroke(page, 690, 460, 900);           // straight across the window
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const withInk = await page.$$eval('#ink g.stroke', n => n.length);

  await page.click('[data-act="erase"]');
  await page.waitForTimeout(200);
  await page.mouse.move(470, 690);
  await page.mouse.down();
  await page.mouse.move(890, 690, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  check('a stroke drawn over a window can be erased there',
        await page.$$eval('#ink g.stroke', n => n.length) === withInk - 1,
        withInk + ' -> ' + (await page.$$eval('#ink g.stroke', n => n.length)));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // ---------------------------------------------------------------- persistence
  console.log('\n[persistence]');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(800);
  const saved = JSON.parse(fs.readFileSync(path.join(CV, 'boards/default.json'), 'utf8'));
  const live = await page.$$eval('#ink g.stroke', n => n.length);
  check('erasures are saved, not just hidden', saved.strokes.length === live,
        'file ' + saved.strokes.length + ' vs dom ' + live);

  console.log('\n[console]');
  check('zero console errors / pageerrors', errors.length === 0, errors.join('; '));

  await page.screenshot({ path: 'phase6.png' });
  await browser.close();
  console.log('\n' + (failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('\nHARNESS ERROR: ' + e.message + '\n' + e.stack); process.exit(2); });
