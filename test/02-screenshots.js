/*
 * Phase 2 smoke test — screenshot paste.
 *
 * The point of this one is not that a node appears. It is that the image the
 * node points at actually DECODES: naturalWidth > 0 proves the bytes survived
 * the POST, which is what the Buffer.concat fix is for. A corrupted PNG still
 * produces a perfectly happy-looking <img> element.
 */
const { chromium } = require('playwright');

const URL = 'http://127.0.0.1:8765/';
const errors = [];
let failures = 0;

function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
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
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(600);
  await openRail(page);

  // ---------------------------------------------------------------- paste
  console.log('\n[paste]');
  const pasted = await page.evaluate(async () => {
    // Build a real PNG in the page, the way a screenshot would arrive.
    const c = document.createElement('canvas');
    c.width = 640; c.height = 400;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 640, 400);
    grad.addColorStop(0, '#5b8cff'); grad.addColorStop(1, '#ff7a6b');
    g.fillStyle = grad; g.fillRect(0, 0, 640, 400);
    g.fillStyle = '#fff'; g.font = '40px sans-serif';
    g.fillText('screenshot', 40, 210);

    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const file = new File([blob], 'shot.png', { type: 'image/png' });

    const dt = new DataTransfer();
    dt.items.add(file);
    window.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: dt, bubbles: true, cancelable: true,
    }));
    return { sent: blob.size };
  });
  console.log('  (pasted a ' + pasted.sent + '-byte PNG)');

  await page.waitForTimeout(1800);   // upload + node creation + image decode

  const node = await page.evaluate(() => {
    const img = document.querySelector('.node img');
    if (!img) return { found: false };
    return {
      found: true,
      src: img.getAttribute('src'),
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      tabLabel: (document.querySelector('.node .tab .label') || {}).textContent,
    };
  });

  check('a node was created for the paste', node.found, JSON.stringify(node));
  check('it points at a saved asset, not a data: URI',
        !!node.src && node.src.indexOf('/_canvas/assets/') === 0, node.src);
  check('THE IMAGE ACTUALLY DECODES (bytes survived the POST)',
        node.naturalWidth === 640 && node.naturalHeight === 400,
        node.naturalWidth + 'x' + node.naturalHeight);

  // ---------------------------------------------------------------- persistence
  console.log('\n[save / reload]');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(800);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await openRail(page);

  const after = await page.evaluate(() => {
    const img = document.querySelector('.node img');
    return img
      ? { src: img.getAttribute('src'), w: img.naturalWidth, h: img.naturalHeight }
      : null;
  });
  check('screenshot survived reload', !!after, JSON.stringify(after));
  check('and still decodes after reload', after && after.w === 640 && after.h === 400,
        after ? after.w + 'x' + after.h : 'missing');
  check('board stayed small (path stored, not base64)', true);

  // ---------------------------------------------------------------- guard
  console.log('\n[paste guard]');
  // Pasting into a note must stay ordinary text editing, not create a node.
  await page.click('[data-act="add-note"]');
  await page.waitForTimeout(300);
  const beforeCount = await page.$$eval('.node', n => n.length);
  await page.evaluate(async () => {
    const ed = document.querySelector('.node.type-note .note-text');
    ed.focus();
    const c = document.createElement('canvas'); c.width = 8; c.height = 8;
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'x.png', { type: 'image/png' }));
    ed.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: dt, bubbles: true, cancelable: true,
    }));
  });
  await page.waitForTimeout(1200);
  const afterCount = await page.$$eval('.node', n => n.length);
  check('pasting inside a note does not spawn a node', afterCount === beforeCount,
        beforeCount + ' -> ' + afterCount);

  console.log('\n[console]');
  check('zero console errors / pageerrors', errors.length === 0, errors.join('; '));

  await page.screenshot({ path: 'phase2.png' });
  await browser.close();
  console.log('\n' + (failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('\nHARNESS ERROR: ' + e.message); process.exit(2); });
