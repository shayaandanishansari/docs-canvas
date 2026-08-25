/*
 * The pen colour control.
 *
 * The four swatch buttons this replaced were invisible: `#topbar button` sets a
 * background at higher specificity than `.pens button` could, so it painted
 * over them. Hence the visibility assertion here — existence was never the
 * problem, and a test that only checked existence would still pass today.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const CV = path.resolve(__dirname, '..');   // the _canvas folder
const R = JSON.parse(fs.readFileSync(path.join(CV,'roots.json'),'utf8')).roots[0];
fs.writeFileSync(path.join(CV,'boards/default.json'), JSON.stringify({
  v:2, savedAt:Date.now(), camera:{x:0,y:0,z:1}, nodes:[], edges:[], strokes:[],
  roots:[{id:R.id,label:R.label,path:R.path}], open:{},
}));
let fail = 0;
const ck = (n,c,d) => { console.log((c?'  ok   ':'  FAIL ')+n+(c?'':'  -> '+d)); if(!c) fail++; };
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1500, height: 800 } });
  p.on('pageerror', e => { console.log('PAGEERROR', e.message); fail++; });
  await p.goto('http://127.0.0.1:8765/', { waitUntil: 'load' });
  await p.waitForTimeout(1400);

  const sw = await p.evaluate(() => {
    const el = document.querySelector('#penColor');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { value: el.value, w: Math.round(r.width), h: Math.round(r.height),
             visible: r.width > 8 && r.height > 8 && cs.visibility === 'visible' };
  });
  ck('a single colour picker exists', !!sw, 'missing');
  ck('it is actually visible (the old swatches were not)', sw && sw.visible, JSON.stringify(sw));
  ck('it shows the current pen colour', sw && sw.value === '#ffd166', JSON.stringify(sw));
  ck('the old swatch row is gone', await p.$$eval('.pens', n => n.length) === 0);

  // change colour -> arms the pen, and the next stroke uses it
  await p.evaluate(() => {
    const el = document.querySelector('#penColor');
    el.value = '#ff3b30';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.waitForTimeout(300);
  ck('picking a colour arms the pen',
     await p.evaluate(() => document.querySelector('#penBtn').classList.contains('on')));

  await p.mouse.move(600, 500); await p.mouse.down();
  for (let i=1;i<=6;i++) await p.mouse.move(600+i*40, 500, { steps: 2 });
  await p.mouse.up(); await p.waitForTimeout(400);
  const fill = await p.evaluate(() => {
    const el = document.querySelector('#ink path.body');
    return el ? el.getAttribute('fill') : null;
  });
  ck('the stroke uses the chosen colour', fill === '#ff3b30', String(fill));

  await p.keyboard.press('Escape');
  await p.waitForTimeout(200);
  await p.screenshot({ path: 'pen.png', clip: { x: 380, y: 0, width: 800, height: 70 } });
  await b.close();
  console.log(fail ? '\n'+fail+' FAILURE(S)' : '\nALL PASSED');
  process.exit(fail?1:0);
})();
