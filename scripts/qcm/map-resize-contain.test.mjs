// A resize the map keeps as its own containing block (defect found by an
// independent verifier, spot-checked against quiet-corners.css:829 and
// quiet-corners-dashboard.html:58).
//
// #qc-map carries Tailwind `absolute inset-0` in markup. The `max-width:1023px`
// rule below turns it `position: static` so the print panel that shares its
// container flows below it instead of under it (layout.test.mjs's A11 history).
// Leaflet decides ONCE, at map creation, whether its own container needs an
// inline `position: relative` -- it adds one only when the container computes
// `static` at that moment (L.Map._initContainer). Load the page directly at a
// narrow width and Leaflet sees `static` and fixes it itself: clean. Load it
// wide -- where #qc-map is already `absolute`, so Leaflet adds nothing -- then
// resize (or rotate a tablet) below 1024px with no reload, and the CSS flips to
// `static` while no inline override exists to stop it. #qc-map is then an
// unpositioned box, so Leaflet's own panes and controls (`.leaflet-bottom`,
// carrying the legend and attribution) fall through to the next positioned
// ancestor -- #qc-map-container, which is taller than the map alone once the
// Layers and Print <details> stack below it in normal flow -- and paint across
// the panels instead of stopping at the map's own box.
//
// Geometry alone would not catch this the way layout.test.mjs's own hit-test
// idiom does: a synthetic .click() fires directly on the node under test and
// never asks what is actually painted there. This uses a genuine
// Input.dispatchMouseEvent at the summary's on-screen centre instead, the same
// as a reader's thumb would land, so a click the map silently swallows shows up
// as a click, not as a box that merely LOOKS reachable.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt() ? 'public/quiet-corners/ not built — run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const LAYER_SUMMARY = '#qcm-layer-panel .qcm-panel-summary';

/** Scrolls the Layers panel summary into view and reports its on-screen centre,
 *  or null if it is not in the page. */
const summaryCentre = `(() => {
  const s = document.querySelector('${LAYER_SUMMARY}');
  if (!s) return null;
  s.scrollIntoView({ block: 'center' });
  const r = s.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`;

/** What is actually painted at a point, named the way the other hit-test
 *  proofs in this directory name it. */
const nameAt = (x, y) => `(() => {
  const hit = document.elementFromPoint(${x}, ${y});
  if (!hit) return '(nothing painted there)';
  const cls = String(hit.className || '').trim().split(/\\s+/)[0];
  return hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : (cls ? '.' + cls : ''));
})()`;

const insideSummary = (x, y) => `(() => {
  const s = document.querySelector('${LAYER_SUMMARY}');
  const hit = document.elementFromPoint(${x}, ${y});
  return !!(s && hit && (s === hit || s.contains(hit)));
})()`;

const layerPanelOpen = "document.getElementById('qcm-layer-panel').open";

// One Chromium process and one page for the whole file -- see layout.test.mjs's
// header for why (launch overhead multiplies on the shared CI runner).
let shared = null;

async function sharedBrowser() {
  if (!shared) {
    const site = await startSiteServer();
    const page = await launch(CHROMIUM, `${site.origin}/quiet-corners/`, { args: ['--hide-scrollbars'] });
    shared = { site, page };
  }
  return shared;
}

after(async () => {
  if (!shared) return;
  shared.page.close();
  await shared.site.close();
});

/** Loads the dashboard fresh at `loadVp`, waits for the real Leaflet map (not
 *  its data), then -- if `resizeVp` is given -- resizes the SAME page to it
 *  without a reload, the way a browser window resize or a device rotation
 *  actually happens. A short settle lets the CSS media query and Leaflet's
 *  reflow catch up before anything is measured. */
async function loadThenResize(loadVp, resizeVp) {
  const { site, page } = await sharedBrowser();
  await page.setViewport(loadVp);
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: false });
  if (resizeVp) {
    await page.setViewport(resizeVp);
    await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  }
  return page;
}

/** Presses and releases a REAL mouse click at (x, y) over the DevTools
 *  protocol -- hit-tested and dispatched by Chromium itself, the same as a
 *  trusted user click, unlike `el.click()` which fires on the node directly
 *  and never asks what is painted at that point. */
async function trustedClick(page, x, y) {
  const base = { x, y, button: 'left', clickCount: 1 };
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
}

async function assertPanelOpensAt(page, label) {
  const centre = await page.evaluate(summaryCentre);
  assert.ok(centre, `${label}: ${LAYER_SUMMARY} is not in the page`);

  const before = await page.evaluate(layerPanelOpen);
  assert.equal(before, false, `${label}: the Layers panel is already open before the click`);

  const inside = await page.evaluate(insideSummary(centre.x, centre.y));
  if (!inside) {
    const hit = await page.evaluate(nameAt(centre.x, centre.y));
    assert.fail(`${label}: a tap at the Layers summary's centre (${centre.x},${centre.y}) `
      + `lands on ${hit} instead of the summary -- something is painted over the panel`);
  }

  await trustedClick(page, centre.x, centre.y);
  // One click must open it -- but under runner load the toggle can land after
  // the dispatch acknowledges, so poll briefly instead of reading `open` once
  // (04b's copy of this read went red that way, run 36469072943).
  let after = await page.evaluate(layerPanelOpen);
  for (let i = 0; i < 10 && !after; i++) {
    await page.evaluate('new Promise(r => setTimeout(r, 100))');
    after = await page.evaluate(layerPanelOpen);
  }
  assert.equal(after, true,
    `${label}: a trusted click at the Layers summary's centre did not open the panel`);
}

test('the Layers panel stays reachable after a desktop-to-mobile resize (1440 -> 390)', { skip }, async () => {
  const page = await loadThenResize({ width: 1440, height: 1000 }, { width: 390, height: 844 });
  await assertPanelOpensAt(page, '1440->390 resize');
});

test('the Layers panel stays reachable after a tablet rotation (1024x768 -> 768x1024)', { skip }, async () => {
  const page = await loadThenResize({ width: 1024, height: 768 }, { width: 768, height: 1024 });
  await assertPanelOpensAt(page, '1024x768->768x1024 rotation');
});

test('control: the Layers panel is reachable when loaded directly at phone width', { skip }, async () => {
  const page = await loadThenResize({ width: 390, height: 844 }, null);
  await assertPanelOpensAt(page, 'direct 390px load');
});
