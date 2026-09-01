/*
 * The selection band, and the right-button pan that made room for it.
 *
 * The band is the canvas's resting tool: no mode to enter, nothing to switch
 * off, and a left drag from empty canvas is always a band. That means every
 * assertion in here is about the DEFAULT state of the app, so a regression
 * shows up on the very first gesture a user makes.
 *
 * Driven with page.mouse throughout, per the rule in CONTEXT.md: a dispatched
 * event skips hit-testing and pointer capture, and pointer capture is exactly
 * what the band relies on to keep receiving moves once it leaves the element
 * it started on.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = 'http://127.0.0.1:8765/';
const CV = path.resolve(__dirname, '..');
const errors = [];
let failures = 0;

function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

const R = JSON.parse(fs.readFileSync(path.join(CV, 'roots.json'), 'utf8')).roots[0];

async function openRail(page) {
  await page.waitForSelector('#railToggle');
  if (await page.evaluate(() => document.querySelector('#rail').classList.contains('hidden'))) {
    await page.click('#railToggle');
    await page.waitForTimeout(250);
  }
}

const selCount = (page) => page.$$eval('.node.selected', n => n.length);
const selIds = (page) =>
  page.$$eval('.node.selected', ns => ns.map(n => n.dataset.id).sort());
const xform = (page) =>
  page.evaluate(() => getComputedStyle(document.querySelector('#world')).transform);
const nodeBox = (page, id) =>
  page.evaluate((i) => {
    const n = document.querySelector('.node[data-id="' + i + '"]');
    return { x: parseFloat(n.style.left), y: parseFloat(n.style.top) };
  }, id);

/* A band, in screen coordinates. Held down across several moves so the live
   hit-testing gets a chance to run more than once — the band updates the
   selection on every move, not on release, and a suite that only ever moved
   once would not notice if that broke. */
async function bandFrom(page, x0, y0, x1, y1, mods) {
  await page.mouse.move(x0, y0);
  if (mods) await page.keyboard.down(mods);
  await page.mouse.down();
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 6 });
  await page.mouse.move(x1, y1, { steps: 6 });
  await page.mouse.up();
  if (mods) await page.keyboard.up(mods);
  await page.waitForTimeout(200);
}

(async () => {
  /* Four windows in a row across the top and one well below, so a band can take
     a chosen subset rather than everything on the board. Coordinates are world
     units and the camera starts at the origin, so they are also screen pixels.
     All of them clear of the 286px rail, which starts shut but is opened later. */
  fs.writeFileSync(path.join(CV, 'boards/default.json'), JSON.stringify({
    v: 2, savedAt: Date.now(), camera: { x: 0, y: 0, z: 1 },
    nodes: [
      { id: 'a', type: 'note', x: 340, y: 120, w: 200, h: 120, text: 'Alpha' },
      { id: 'b', type: 'note', x: 600, y: 120, w: 200, h: 120, text: 'Bravo' },
      { id: 'c', type: 'note', x: 860, y: 120, w: 200, h: 120, text: 'Charlie' },
      { id: 'd', type: 'note', x: 340, y: 560, w: 200, h: 120, text: 'Delta' },
    ],
    edges: [], strokes: [],
    roots: [{ id: R.id, label: R.label, path: R.path }], open: {},
  }));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(1300);

  check('the board loaded', (await page.$$eval('.node', n => n.length)) === 4);
  check('nothing is selected to begin with', (await selCount(page)) === 0);

  // ------------------------------------------------------------------ banding
  console.log('\n[banding]');

  // Down the gap between the top row and Delta, over a and b only.
  await bandFrom(page, 300, 90, 820, 270);
  check('a band takes every window it touches',
        JSON.stringify(await selIds(page)) === '["a","b"]', JSON.stringify(await selIds(page)));

  /* Intersection, not containment: this box is far too small to hold a 200px
     window, and clipping only its bottom-left corner still has to count. */
  await bandFrom(page, 300, 200, 380, 300);
  check('a band that only clips a corner still selects it',
        JSON.stringify(await selIds(page)) === '["a"]', JSON.stringify(await selIds(page)));

  // Shift keeps what is there and adds to it.
  await bandFrom(page, 830, 90, 1090, 270, 'Shift');
  check('shift-banding adds to the selection',
        JSON.stringify(await selIds(page)) === '["a","c"]', JSON.stringify(await selIds(page)));

  // A band that touches nothing is how you clear.
  await bandFrom(page, 1150, 500, 1300, 700);
  check('a band over empty canvas clears the selection', (await selCount(page)) === 0);

  await page.mouse.click(200, 800);
  await page.waitForTimeout(150);
  check('a plain click on empty canvas also clears', (await selCount(page)) === 0);

  // ------------------------------------------------------------ moving a band
  console.log('\n[moving what is banded]');
  await bandFrom(page, 300, 90, 820, 270);            // a + b again
  const aBefore = await nodeBox(page, 'a');
  const bBefore = await nodeBox(page, 'b');
  const cBefore = await nodeBox(page, 'c');

  // Grab window a by its chrome bar, which sits above the node's own top edge.
  await page.mouse.move(400, 128);
  await page.mouse.down();
  await page.mouse.move(460, 208, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);

  const aAfter = await nodeBox(page, 'a');
  const bAfter = await nodeBox(page, 'b');
  const cAfter = await nodeBox(page, 'c');
  check('dragging one banded window moves it',
        Math.abs(aAfter.x - aBefore.x - 60) < 3 && Math.abs(aAfter.y - aBefore.y - 80) < 3,
        JSON.stringify(aAfter));
  check('and the rest of the band travels with it, by the same amount',
        Math.abs(bAfter.x - bBefore.x - 60) < 3 && Math.abs(bAfter.y - bBefore.y - 80) < 3,
        JSON.stringify(bAfter));
  check('while an unselected window stays put',
        cAfter.x === cBefore.x && cAfter.y === cBefore.y, JSON.stringify(cAfter));

  /* A press on a banded window keeps the band — that is what makes the drag
     above work from any member — but a press that never travels means "just
     this one", and collapses on release. Without it, clicking a banded window
     to read it and then pressing Delete would take the lot. */
  await page.mouse.click(460, 208);
  await page.waitForTimeout(200);
  check('clicking one window of a band collapses to it',
        JSON.stringify(await selIds(page)) === '["a"]', JSON.stringify(await selIds(page)));

  // ----------------------------------------------------------------- deleting
  console.log('\n[deleting a band]');
  await bandFrom(page, 250, 60, 1100, 400);           // the whole top row
  check('the top row is banded', (await selCount(page)) === 3);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);
  check('Delete removes every window in the band',
        (await page.$$eval('.node', n => n.length)) === 1);

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(700);
  check('and one undo brings all three back — a banded delete is one entry',
        (await page.$$eval('.node', n => n.length)) === 4);

  // ------------------------------------------------------------------- tools
  console.log('\n[the select tool is the resting state]');
  await openRail(page);
  check('Select is lit on a fresh board',
        await page.evaluate(() => document.querySelector('#selectBtn').classList.contains('on')));

  await page.click('[data-act="pen"]');
  await page.waitForTimeout(200);
  check('arming the pen unlights Select',
        await page.evaluate(() => !document.querySelector('#selectBtn').classList.contains('on')));

  await page.keyboard.press('v');
  await page.waitForTimeout(200);
  check('V puts the pen down again',
        await page.evaluate(() => !document.querySelector('#penBtn').classList.contains('on')));
  check('and lights Select back up',
        await page.evaluate(() => document.querySelector('#selectBtn').classList.contains('on')));

  /* The pen keeps the left button while it is armed, but the right one still
     pans — otherwise marking up anything larger than the screen means putting
     the tool down between every stroke. */
  await page.click('[data-act="pen"]');
  await page.waitForTimeout(200);
  const cam2 = await xform(page);
  await page.mouse.move(900, 700);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(980, 760, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(250);
  check('the right button pans even with the pen armed', cam2 !== (await xform(page)));
  check('and no stroke was drawn by it',
        (await page.$$eval('#ink path[data-stroke]', n => n.length)) === 0);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // -------------------------------------------------------------------- ink
  console.log('\n[a band takes ink too]');
  await page.click('[data-act="pen"]');
  await page.waitForTimeout(200);
  await page.mouse.move(700, 300);
  await page.mouse.down();
  await page.mouse.move(700, 500, { steps: 10 });
  await page.mouse.move(700, 700, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('a stroke exists to band',
        (await page.$$eval('#ink path[data-stroke]', n => n.length)) === 1);

  /* Crossed at its middle by a band that contains none of its endpoints. A
     simplified stroke can be two points hundreds of pixels apart, so this is
     the case that fails if the hit test only ever looks at points. */
  await bandFrom(page, 650, 480, 760, 540);
  check('a band crossing a stroke between its points still catches it',
        (await page.$$eval('#ink g.stroke.sel', n => n.length)) === 1);

  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);
  check('Delete takes banded ink',
        (await page.$$eval('#ink path[data-stroke]', n => n.length)) === 0);

  // ------------------------------------------------------------------ panning
  console.log('\n[panning is the right button now]');
  const cam0 = await xform(page);
  await page.mouse.move(1150, 700);
  await page.mouse.down();
  await page.mouse.move(1250, 780, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  check('a left drag on empty canvas does not pan', cam0 === (await xform(page)));

  await page.mouse.move(1150, 700);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(1250, 780, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(250);
  const cam1 = await xform(page);
  check('a right drag does', cam0 !== cam1);

  /* The reason the pan moved to the right button rather than onto a modifier:
     it has to work where there is no empty canvas left, which on a real board
     is most of it. Windows are shielded, so the press lands on the shield and
     has to be routed past it. Taken from the element's live box, because by now
     the pans above have moved everything. */
  const aBox = await page.locator('.node[data-id="a"]').boundingBox();
  await page.mouse.move(aBox.x + aBox.width / 2, aBox.y + aBox.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(aBox.x + aBox.width / 2 - 60, aBox.y + aBox.height / 2 + 60, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(250);
  check('and it pans from on top of a window too', cam1 !== (await xform(page)));
  check('panning over a window did not select it', (await selCount(page)) === 0);

  // ---------------------------------------------------------------- console
  check('zero console errors / pageerrors', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})();
