// QQA-05e: the map's own chrome on a phone. At 390x844 the map region is about 470px tall,
// and the credit line (five wrapped lines), the key and the view buttons took more than
// half of it. Below 1024px the credit and the key now fold to a 44px chip each until
// tapped; the full text stays in the page so the licence obligation is still met. On a
// desktop both stay open exactly as before. Measured in the built page, as a reader sees it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

async function onScreen(w, h, body) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', { viewport: { width: w, height: h }, args: ['--hide-scrollbars'] });
  try {
    await page.navigate(`${site.origin}/quiet-corners/`);
    await readyDashboard(page, { data: false });
    await page.evaluate('new Promise(r => setTimeout(r, 400))');
    return await body(page);
  } finally { page.close(); await site.close(); }
}

/** Visible = laid out and not display:none. */
const SHOWN = "(el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'";
const BOX = '(el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }';

test('on a phone the credit folds to one 44px chip and the key to one short chip', { skip }, async () => {
  const m = await onScreen(390, 844, (page) => page.evaluate(`(() => {
    const shown = ${SHOWN}, box = ${BOX};
    const credit = document.querySelector('#qc-map .leaflet-control-attribution');
    const toggle = document.querySelector('#qc-map .qc-credit-toggle');
    const legend = document.querySelector('#qc-map .qc-legend');
    const style = toggle && getComputedStyle(toggle);
    return {
      creditShown: shown(credit),
      toggle: toggle && box(toggle), toggleFont: style && parseFloat(style.fontSize),
      toggleText: toggle && toggle.textContent.trim(), toggleExpanded: toggle && toggle.getAttribute('aria-expanded'),
      legend: legend && box(legend),
    };
  })()`));
  assert.ok(m.toggle, 'a Credits toggle exists inside the map');
  assert.equal(m.toggleText, 'Credits');
  assert.equal(m.toggleExpanded, 'false');
  assert.equal(m.creditShown, false, 'the credit starts folded on a phone');
  assert.ok(m.toggle.w >= 44 && m.toggle.h >= 44, `Credits is ${m.toggle.w}x${m.toggle.h}, needs 44x44`);
  assert.ok(m.toggle.h <= 44.5, `the folded credit control is ${m.toggle.h}px tall, was five lines`);
  assert.ok(m.toggleFont >= 12, `Credits text is ${m.toggleFont}px`);
  assert.ok(m.legend.h <= 48, `the folded key is ${m.legend.h}px tall`);
});

test('on a phone the map chrome covers at most 35% of the map', { skip }, async () => {
  const m = await onScreen(390, 844, (page) => page.evaluate(`(() => {
    const map = document.getElementById('qc-map').getBoundingClientRect();
    const rs = [...document.querySelectorAll('#qc-map .leaflet-control, #qc-view-controls')]
      .filter((el) => el.getClientRects().length)
      .map((el) => el.getBoundingClientRect())
      .map((r) => ({ l: Math.max(r.left, map.left), t: Math.max(r.top, map.top),
        r: Math.min(r.right, map.right), b: Math.min(r.bottom, map.bottom) }))
      .filter((r) => r.r > r.l && r.b > r.t);
    // Union area on a 4px grid so overlapping controls are not counted twice.
    const g = 4; let cells = 0;
    for (let y = map.top; y < map.bottom; y += g) for (let x = map.left; x < map.right; x += g) {
      if (rs.some((r) => x >= r.l && x < r.r && y >= r.t && y < r.b)) cells++;
    }
    return { share: cells * g * g / (map.width * map.height), mapH: map.height };
  })()`));
  assert.ok(m.share <= 0.35, `chrome covers ${(m.share * 100).toFixed(1)}% of a ${m.mapH}px-tall map, needs <= 35%`);
});

test('tapping Credits and Key opens them, tapping again folds them', { skip }, async () => {
  const m = await onScreen(390, 844, (page) => page.evaluate(`(async () => {
    const shown = ${SHOWN};
    const wait = () => new Promise((r) => setTimeout(r, 100));
    const credit = document.querySelector('#qc-map .leaflet-control-attribution');
    const toggle = document.querySelector('#qc-map .qc-credit-toggle');
    const legend = document.querySelector('#qc-map .qc-legend');
    const key = legend.querySelector('.qc-legend-toggle');
    const out = { keyName: key.textContent.trim(), keyBefore: key.getAttribute('aria-expanded') };
    toggle.click(); await wait();
    out.creditOpen = shown(credit) && credit.textContent.includes('USGS'); out.creditExp = toggle.getAttribute('aria-expanded');
    toggle.click(); await wait();
    out.creditShut = !shown(credit);
    key.click(); await wait();
    const body = legend.querySelector('.qc-legend-body');
    out.keyOpen = shown(body) && body.textContent.includes('Candidate town'); out.keyExp = key.getAttribute('aria-expanded');
    key.click(); await wait();
    out.keyShut = !shown(body);
    return out;
  })()`));
  assert.equal(m.keyName, 'Key');
  assert.equal(m.keyBefore, 'false');
  assert.ok(m.creditOpen, 'the full credit, naming USGS, is readable once Credits is tapped');
  assert.equal(m.creditExp, 'true');
  assert.ok(m.creditShut, 'a second tap folds the credit');
  assert.ok(m.keyOpen, 'the key lists "Candidate town" once Key is tapped');
  assert.equal(m.keyExp, 'true');
  assert.ok(m.keyShut, 'a second tap folds the key');
});

test('on a desktop the credit and the key are open on load, with no toggles', { skip }, async () => {
  const m = await onScreen(1440, 1000, (page) => page.evaluate(`(() => {
    const shown = ${SHOWN};
    const credit = document.querySelector('#qc-map .leaflet-control-attribution');
    const toggle = document.querySelector('#qc-map .qc-credit-toggle');
    const legend = document.querySelector('#qc-map .qc-legend');
    const key = legend.querySelector('.qc-legend-toggle');
    const body = legend.querySelector('.qc-legend-body');
    return { credit: shown(credit) && credit.textContent.includes('USGS'), toggle: shown(toggle), key: shown(key),
      body: shown(body) && body.textContent.includes('Candidate town') };
  })()`));
  assert.ok(m.credit, 'the credit is open');
  assert.equal(m.toggle, false, 'no Credits toggle on a desktop');
  assert.equal(m.key, false, 'no Key toggle on a desktop');
  assert.ok(m.body, 'the key is open');
});
