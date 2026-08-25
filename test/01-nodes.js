/*
 * Phase 1 smoke test — text + shape node types.
 *
 * CONTEXT.md: every bug found during the build was an interaction bug invisible
 * to reading the source, so this drives a real browser. Two traps it documents:
 * boards/*.json must be cleared first (a board from the last run gets loaded by
 * the next and the layout drifts), and nodes can land on top of each other,
 * which reads as a Playwright "intercepts pointer events" timeout.
 */
const { chromium } = require('playwright');

const URL = 'http://127.0.0.1:8765/';   // 127.0.0.1, not localhost
const TYPED = 'Hello canvasf';  // 'f' is the typing-guard probe; it belongs in the text
const errors = [];
let failures = 0;

/* Drag each node by its chrome bar into its own column. Real pointer events, so
   the model moves with the DOM and the layout survives a save/reload. */
async function spreadOut(page) {
  const ids = await page.$$eval('.node', ns => ns.map(n => n.dataset.id));
  for (let i = 0; i < ids.length; i++) {
    // A shape is grabbed by its stroke, not a title bar, so find a point that
    // is actually on the ink. Everything else grabs its chrome.
    const from = await page.evaluate(id => {
      const n = document.querySelector('.node[data-id="' + id + '"]');
      if (!n) return null;
      if (n.classList.contains('type-shape')) {
        const g = n.querySelector('ellipse, line, rect');
        if (!g) return null;
        const r = g.getBoundingClientRect();
        return n.querySelector('line')
          ? { x: r.left + r.width / 2, y: r.top + r.height / 2 }   // diagonal midpoint
          : { x: r.left + 1, y: r.top + r.height / 2 };            // left edge stroke
      }
      const r = n.querySelector('.chrome').getBoundingClientRect();
      return { x: r.x + 60, y: r.y + r.height / 2 };
    }, ids[i]);
    if (!from) continue;

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    // clear of the 286px rail, or nodes land underneath it and are unclickable
    await page.mouse.move(430 + (i % 3) * 380, 220 + Math.floor(i / 3) * 320, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(90);
  }
}

function check(name, cond, detail) {
  if (cond) { console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(600);

  // ---------------------------------------------------------------- add
  console.log('\n[add]');
  await page.click('[data-act="add-text"]');
  await page.waitForTimeout(150);
  await page.click('[data-act="add-shape"][data-shape="ellipse"]');
  await page.waitForTimeout(150);
  await page.click('[data-act="add-shape"][data-shape="arrow"]');
  await page.waitForTimeout(250);

  // Everything is added at screen centre, so it all stacks. CONTEXT.md warns
  // this reads as a Playwright "intercepts pointer events" timeout rather than
  // an app bug. Spread them out by really dragging each chrome bar, which also
  // keeps the model in step (writing .style.left would not) and exercises drag.
  await spreadOut(page);
  await page.waitForTimeout(200);

  const kinds = await page.$$eval('.node', ns => ns.map(n => n.className));
  check('text node built', kinds.some(c => c.includes('type-text')), kinds.join(' | '));
  check('shape nodes built', kinds.filter(c => c.includes('type-shape')).length === 2, kinds.join(' | '));

  // syncTabs throws on an unknown type -> would surface as a pageerror
  check('no errors after add', errors.length === 0, errors.join('; '));

  // ---------------------------------------------------------------- shape geometry
  console.log('\n[shape geometry]');
  const geo = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.node.type-shape').forEach(n => {
      const svg = n.querySelector('svg.shape-svg');
      out.push({
        vb: svg && svg.getAttribute('viewBox'),
        shapes: svg ? [...svg.children].map(c => c.tagName) : [],
      });
    });
    return out;
  });
  check('ellipse drew an <ellipse>', geo.some(g => g.shapes.includes('ellipse')), JSON.stringify(geo));
  check('arrow drew line + head', geo.some(g => g.shapes.includes('line') && g.shapes.includes('g')), JSON.stringify(geo));
  check('viewBox matches node size', geo.every(g => /^0 0 \d+ \d+$/.test(g.vb || '')), JSON.stringify(geo));

  // ---------------------------------------------------------------- click-through
  // An unfilled shape must only catch clicks on its ink. Otherwise a rectangle
  // drawn around a window makes that window unusable.
  console.log('\n[shape click-through]');
  const through = await page.evaluate(() => {
    const n = [...document.querySelectorAll('.node.type-shape')]
      .find(x => x.querySelector('ellipse'));
    const r = n.getBoundingClientRect();
    // dead centre of an unfilled ellipse's bounding box is empty space
    const hitCentre = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    // a point on the ellipse's own left vertex is ink (its rect, not the node's)
    const er = n.querySelector('ellipse').getBoundingClientRect();
    const hitEdge = document.elementFromPoint(er.left + 1, er.top + er.height / 2);
    return {
      centre: hitCentre ? hitCentre.tagName + '.' + (hitCentre.className.baseVal ?? hitCentre.className) : null,
      edge: hitEdge ? hitEdge.tagName : null,
      centreInsideNode: hitCentre ? n.contains(hitCentre) : false,
      edgeInsideNode: hitEdge ? n.contains(hitEdge) : false,
    };
  });
  check('empty centre of an unfilled shape is click-through',
        through.centreInsideNode === false, JSON.stringify(through));
  check('the shape ink itself is clickable',
        through.edgeInsideNode === true, JSON.stringify(through));

  // ---------------------------------------------------------------- text editing
  console.log('\n[text editing]');
  const ed = await page.$('.node.type-text .note-text');
  await ed.click();
  await page.keyboard.type('Hello canvas');
  await page.waitForTimeout(150);
  const typed = await ed.textContent();
  check('text typed into the box', typed === 'Hello canvas', JSON.stringify(typed));

  // "f" must NOT fit-all while typing; the typing guard should swallow it
  const camBefore = await page.evaluate(() => document.querySelector('#zoomVal').textContent);
  await page.keyboard.type('f');
  await page.waitForTimeout(200);
  const camAfter = await page.evaluate(() => document.querySelector('#zoomVal').textContent);
  check('shortcuts do not fire while typing', camBefore === camAfter, camBefore + ' -> ' + camAfter);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // ---------------------------------------------------------------- resize below the old floor
  console.log('\n[resize]');
  const before = await page.evaluate(() => {
    const n = document.querySelector('.node.type-shape');
    return { w: n.offsetWidth, h: n.offsetHeight, id: n.dataset.id };
  });
  const grip = await page.$('.node.type-shape .grip.se');
  const gb = await grip.boundingBox();
  await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
  await page.mouse.down();
  await page.mouse.move(gb.x - 140, gb.y - 90, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const after = await page.evaluate(id => {
    const n = document.querySelector('.node[data-id="' + id + '"]');
    const svg = n.querySelector('svg.shape-svg');
    return { w: n.offsetWidth, h: n.offsetHeight, vb: svg.getAttribute('viewBox') };
  }, before.id);
  check('shape resized smaller than the 260x160 window floor',
        after.w < 260 && after.w >= 40, before.w + ' -> ' + after.w);
  check('shape viewBox followed the resize',
        after.vb === '0 0 ' + after.w + ' ' + after.h, after.vb + ' vs node ' + after.w + 'x' + after.h);

  // ---------------------------------------------------------------- duplicate + delete
  console.log('\n[duplicate / delete]');
  const n0 = await page.$$eval('.node', n => n.length);
  await page.click('.node.type-text .chrome');
  await page.keyboard.press('Control+d');
  await page.waitForTimeout(250);
  const n1 = await page.$$eval('.node', n => n.length);
  check('Ctrl+D duplicated', n1 === n0 + 1, n0 + ' -> ' + n1);

  const dupText = await page.$$eval('.node.type-text .note-text', els => els.map(e => e.textContent));
  check('duplicate carried its text', dupText.filter(t => t === TYPED).length === 2, JSON.stringify(dupText));

  await page.keyboard.press('Delete');
  await page.waitForTimeout(200);
  const n2 = await page.$$eval('.node', n => n.length);
  check('Delete removed one', n2 === n1 - 1, n1 + ' -> ' + n2);

  // ---------------------------------------------------------------- persistence
  console.log('\n[save / reload]');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(700);

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(900);

  const survived = await page.evaluate(() => {
    const out = { text: 0, shape: 0, kinds: [], texts: [] };
    document.querySelectorAll('.node').forEach(n => {
      if (n.classList.contains('type-text')) { out.text++; out.texts.push(n.querySelector('.note-text').textContent); }
      if (n.classList.contains('type-shape')) { out.shape++; }
    });
    document.querySelectorAll('.node.type-shape svg.shape-svg').forEach(s => {
      out.kinds.push([...s.children].map(c => c.tagName).join('+'));
    });
    return out;
  });
  check('text nodes survived reload', survived.text === 1, JSON.stringify(survived));
  check('shape nodes survived reload', survived.shape === 2, JSON.stringify(survived));
  check('text content survived reload', survived.texts.every(t => t === TYPED), JSON.stringify(survived.texts));
  check('shape kinds survived reload',
        survived.kinds.some(k => k.includes('ellipse')) && survived.kinds.some(k => k.includes('line')),
        JSON.stringify(survived.kinds));

  // ---------------------------------------------------------------- regressions
  console.log('\n[existing behaviour still works]');
  await page.click('[data-act="add-note"]');
  await page.waitForTimeout(200);
  const noteOk = await page.$$eval('.node.type-note', n => n.length);
  check('notes still build', noteOk === 1, String(noteOk));
  const noteShield = await page.evaluate(() =>
    document.querySelector('.node.type-note .shield').hidden);
  check('note shield still suppressed', noteShield === true, String(noteShield));

  await page.click('[data-act="fit"]');
  await page.waitForTimeout(500);
  check('fit did not throw', true);

  console.log('\n[console]');
  check('zero console errors / pageerrors', errors.length === 0, errors.join('; '));

  await page.screenshot({ path: 'phase1.png', fullPage: false });
  await browser.close();

  console.log('\n' + (failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('\nHARNESS ERROR: ' + e.message); process.exit(2); });
