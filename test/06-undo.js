/*
 * Undo / redo.
 *
 * The assertion that matters is the iframe one. Restoring a snapshot through
 * adopt() would drop every element and reload every document — invariant 1,
 * and the exact thing this tool exists to prevent. Undoing a sticky-note edit
 * must leave your open documents, and their scroll positions, alone.
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
const nodes = n => n.$$eval('.node', a => a.length);
const strokes = n => n.$$eval('#ink g.stroke', a => a.length);

(async () => {
  fs.writeFileSync(path.join(CV, 'boards/default.json'), JSON.stringify({
    v: 2, savedAt: Date.now(), camera: { x: 0, y: 0, z: 1 },
    nodes: [], edges: [], strokes: [],
    roots: [{ id: R.id, label: R.label, path: R.path }],
    open: { [R.id]: ['', '2026-05-15 (Startup Start)'] },
  }));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(1400);

  // ---------------------------------------------------------------- basics
  console.log('\n[undo / redo basics]');
  check('undo starts disabled', await page.evaluate(() => document.querySelector('#undoBtn').disabled));

  await page.click('[data-act="add-note"]');
  await page.waitForTimeout(700);
  check('a note was added', await nodes(page) === 1);
  check('undo became available',
        await page.evaluate(() => !document.querySelector('#undoBtn').disabled));

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(500);
  check('Ctrl+Z removes it', await nodes(page) === 0, String(await nodes(page)));
  check('redo became available',
        await page.evaluate(() => !document.querySelector('#redoBtn').disabled));

  await page.keyboard.press('Control+y');
  await page.waitForTimeout(500);
  check('Ctrl+Y brings it back', await nodes(page) === 1, String(await nodes(page)));

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(400);
  check('Ctrl+Shift+Z also redoes', await nodes(page) === 1, String(await nodes(page)));

  // ---------------------------------------------------------------- the iframe test
  console.log('\n[undo must not reload documents]');
  await page.evaluate(() => {
    const r = [...document.querySelectorAll('.f')].find(x => /\.html$/.test(x.title));
    if (r) r.click();
  });
  await page.waitForTimeout(1800);
  check('a document window is open', await page.$$eval('.node iframe', n => n.length) === 1);

  // Stamp the live document and scroll it. Both die on a reload.
  const stamped = await page.evaluate(() => {
    const f = document.querySelector('.node iframe');
    try {
      f.contentWindow.__marker = 'alive-' + Date.now();
      f.contentDocument.documentElement.scrollTop = 220;
      return { marker: f.contentWindow.__marker,
               scroll: f.contentDocument.documentElement.scrollTop };
    } catch (e) { return { err: String(e) }; }
  });
  check('the frame could be stamped and scrolled', !!stamped.marker, JSON.stringify(stamped));

  // Now edit something unrelated, then undo it
  await page.click('[data-act="add-note"]');
  await page.waitForTimeout(700);
  const before = await nodes(page);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(700);

  const after = await page.evaluate(() => {
    const f = document.querySelector('.node iframe');
    if (!f) return { gone: true };
    try {
      return {
        marker: f.contentWindow.__marker || null,
        scroll: f.contentDocument.documentElement.scrollTop,
      };
    } catch (e) { return { err: String(e) }; }
  });
  check('the undo removed the note', await nodes(page) === before - 1);
  check('THE DOCUMENT WAS NOT RELOADED', after.marker === stamped.marker,
        JSON.stringify({ was: stamped.marker, now: after.marker }));
  check('and it kept its scroll position', after.scroll === 220, JSON.stringify(after));

  // ---------------------------------------------------------------- text coalescing
  console.log('\n[typing is one undo entry, not one per character]');
  await page.click('[data-act="add-text"]');
  await page.waitForTimeout(500);
  await page.keyboard.type('hello there', { delay: 25 });
  await page.waitForTimeout(900);   // let the burst settle
  const typed = await page.evaluate(() =>
    document.querySelector('.node.type-text .note-text').textContent);
  check('text was typed', typed === 'hello there', JSON.stringify(typed));

  // click out so the editor does not swallow Ctrl+Z as native text undo
  await page.mouse.click(1450, 880);
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(600);
  const afterUndo = await page.evaluate(() => {
    const el = document.querySelector('.node.type-text .note-text');
    return el ? el.textContent : '(node gone)';
  });
  check('one undo clears the whole typing burst, not one letter',
        afterUndo === '' || afterUndo === '(node gone)', JSON.stringify(afterUndo));
  check('the DOM followed the model (one-way binding fixed)',
        afterUndo !== 'hello there', JSON.stringify(afterUndo));

  // ---------------------------------------------------------------- ink
  console.log('\n[ink]');
  await page.keyboard.press('Escape');
  await page.click('[data-act="pen"]');
  await page.waitForTimeout(200);
  for (const y of [600, 660]) {
    await page.mouse.move(500, y); await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(500 + i * 40, y, { steps: 2 });
    await page.mouse.up(); await page.waitForTimeout(500);   // settle between strokes
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const twoStrokes = await strokes(page);
  check('two strokes drawn', twoStrokes === 2, String(twoStrokes));

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(600);
  check('undo removes one stroke', await strokes(page) === 1, String(await strokes(page)));
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(600);
  check('undo removes the other', await strokes(page) === 0, String(await strokes(page)));
  await page.keyboard.press('Control+y');
  await page.waitForTimeout(600);
  check('redo restores one', await strokes(page) === 1, String(await strokes(page)));

  // ---------------------------------------------------------------- forking
  console.log('\n[a new edit forks the future]');
  await page.click('[data-act="add-note"]');
  await page.waitForTimeout(700);
  check('redo is cleared by a fresh edit',
        await page.evaluate(() => document.querySelector('#redoBtn').disabled));

  // ---------------------------------------------------------------- camera
  console.log('\n[camera is not undoable]');
  const depth = await page.evaluate(() => document.querySelector('#undoBtn').disabled);
  const camBefore = await page.evaluate(() => document.querySelector('#world').style.transform);
  await page.mouse.move(1300, 300); await page.mouse.down();
  await page.mouse.move(1380, 380, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(700);
  const n0 = await nodes(page);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(600);
  const n1 = await nodes(page);
  check('panning did not create an undo entry (it undid content instead)',
        n1 === n0 - 1, 'nodes ' + n0 + ' -> ' + n1);

  // ---------------------------------------------------------------- board switch
  console.log('\n[history does not leak across boards]');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(700);
  fs.writeFileSync(path.join(CV, 'boards/second.json'), JSON.stringify({
    v: 2, savedAt: Date.now(), camera: { x: 0, y: 0, z: 1 },
    nodes: [], edges: [], strokes: [],
    roots: [{ id: R.id, label: R.label, path: R.path }], open: {},
  }));
  await page.click('[data-act="open"]');
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    [...document.querySelectorAll('.brd')]
      .find(r => r.querySelector('.brd-n').textContent === 'second')
      .querySelector('.brd-main').click();
  });
  await page.waitForTimeout(1400);
  check('switching boards clears history',
        await page.evaluate(() => document.querySelector('#undoBtn').disabled));
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(500);
  check('and undo on a fresh board does nothing harmful', await nodes(page) === 0,
        String(await nodes(page)));

  console.log('\n[console]');
  check('zero console errors / pageerrors', errors.length === 0, errors.join('; '));

  await page.screenshot({ path: 'phase7.png' });
  await browser.close();
  console.log('\n' + (failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('\nHARNESS ERROR: ' + e.message + '\n' + e.stack); process.exit(2); });
