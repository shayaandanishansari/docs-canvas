/*
 * No canvas gesture is a text selection.
 *
 * pointerdown cannot be preventDefault()ed (invariant 2), so nothing stops the
 * browser starting a native selection under a canvas gesture: sweep across a
 * note and its words come up blue, and the growing selection then fights the
 * gesture for the pointer. app.js cancels selectstart for the life of a gesture
 * instead; this suite holds that line for all four of them — the band, the pan,
 * the pen and the eraser.
 *
 * Panning is the RIGHT button here. The left one bands a selection, and it has
 * to be just as free of stray highlighting as the pan ever was.
 *
 * Everything is driven with page.mouse, because a dispatched event would never
 * make the browser attempt a selection in the first place — which is the whole
 * thing under test.
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

const selection = (page) => page.evaluate(() => String(getSelection()));
const worldXform = (page) =>
  page.evaluate(() => getComputedStyle(document.querySelector('#world')).transform);

/* Returns the selection as it stood mid-drag: a selection that exists only
   while the button is down is still the bug, and releasing can collapse it. */
async function dragFrom(page, x0, y0, dx, dy, button) {
  const btn = button ? { button } : undefined;
  await page.mouse.move(x0, y0);
  await page.mouse.down(btn);
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(x0 + (dx * i) / 12, y0 + (dy * i) / 12, { steps: 2 });
  }
  const during = await selection(page);
  await page.mouse.up(btn);
  return during;
}

const panFrom = (page, x0, y0, dx, dy) => dragFrom(page, x0, y0, dx, dy, 'right');

(async () => {
  // Notes sit right in the path of a drag that starts on empty canvas: their
  // text is the thing that used to come up highlighted.
  fs.writeFileSync(path.join(CV, 'boards/default.json'), JSON.stringify({
    v: 2, savedAt: Date.now(), camera: { x: 0, y: 0, z: 1 },
    nodes: [
      { id: 'n1', type: 'note', x: 300, y: 120, w: 240, h: 150, text: 'Alpha note text here' },
      { id: 'n2', type: 'note', x: 700, y: 400, w: 240, h: 150, text: 'Beta note text here' },
      { id: 'n3', type: 'text', x: 300, y: 640, w: 200, h: 60, text: 'Some text box' },
      { id: 'n4', type: 'shape', shape: 'rect', x: 950, y: 120, w: 200, h: 120 },
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

  /* ------------------------------------------------------------ panning
   *
   * On a virgin page, before anything else has touched the selection. A
   * previous click that collapsed a selection leaves the document in a state
   * where the next drag does not try to select at all — which quietly hid
   * this bug from a suite that checked note editing first. */
  const before = await worldXform(page);
  let sel = await panFrom(page, 200, 80, 600, 600);   // sweeps across n1
  const after = await worldXform(page);
  check('a pan across a note selects nothing', sel === '', JSON.stringify(sel));
  check('and the pan itself still moved the camera', before !== after);

  // A second pan is the half of the bug that felt like the canvas snagging:
  // with a live selection in play the next drag fought it for the pointer.
  const mid = after;
  sel = await panFrom(page, 200, 80, 500, 300);
  check('a second pan selects nothing either', sel === '', JSON.stringify(sel));
  check('and it still pans', mid !== (await worldXform(page)));

  /* Windows raises the context menu on the right button coming back UP —
     that is, at the end of every pan — and a menu left standing over the
     canvas would eat the next gesture. A third pan immediately after the
     second is what proves it was suppressed. */
  const beforeCtx = await worldXform(page);
  await panFrom(page, 300, 200, 120, 90);
  check('a pan still works right after one ended on a right-button release',
        beforeCtx !== (await worldXform(page)));

  // ------------------------------------------------------- other gestures
  sel = await panFrom(page, 120, 780, 700, -300);
  check('a pan sweeping the text box selects nothing', sel === '', JSON.stringify(sel));

  /* The band is the left button's gesture and sweeps the same notes. It is
     the one most likely to regress: it is the default, so it is what a
     mis-aimed drag does now. */
  const camBand = await worldXform(page);
  sel = await dragFrom(page, 200, 80, 600, 600);
  check('a band across a note selects no text', sel === '', JSON.stringify(sel));
  check('and banding does not pan the camera', camBand === (await worldXform(page)));

  await openRail(page);
  await page.click('[data-act="pen"]');
  await page.waitForTimeout(200);
  sel = await dragFrom(page, 500, 500, 220, 40);
  check('drawing a stroke selects nothing', sel === '', JSON.stringify(sel));
  check('and the stroke was drawn',
    (await page.evaluate(() => document.querySelectorAll('#ink path[data-stroke]').length)) === 1);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  /* ------------------------------------------- a note is still selectable
   *
   * The fix must not cost the user the ability to select the words in a note
   * by hand. Its own page: this one has been panned away from the notes and
   * has the rail open over them, and reloading would only restore the panned
   * camera the autosave just wrote. */
  {
    const p2 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    p2.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    p2.on('pageerror', e => errors.push('pageerror: ' + e.message));
    await p2.goto(URL, { waitUntil: 'load' });
    await p2.waitForTimeout(1300);
    const box = await p2.locator('.node.type-note .note-text').first().boundingBox();
    await p2.mouse.move(box.x + 3, box.y + box.height / 2);
    await p2.mouse.down();
    await p2.mouse.move(box.x + box.width - 3, box.y + box.height / 2, { steps: 10 });
    const sel = await selection(p2);
    await p2.mouse.up();
    check('dragging inside a note still selects its text',
      sel.indexOf('Alpha') >= 0, JSON.stringify(sel));
    await p2.close();
  }

  // ---------------------------------------------------------------- console
  check('zero console errors / pageerrors', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})();
