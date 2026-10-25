// A06 (UX-03a), on the real built Field Maps app: checking Road cameras (or Park cameras)
// has to move the Layers panel's shared count line off "No layers on".
//
// The failed fetch is the case worth proving. Selected is not loaded is not rendered: a camera
// layer whose list did not load is still a layer the reader switched on, and the count has to say
// so beside the failure report that explains why no pins appear. This browser is offline (#674),
// but the camera index is a same-origin snapshot since the map-area loader, so being offline no
// longer fails it: the road test blocks the camera directory in the browser itself
// (Network.setBlockedURLs), and the page's real fetch rejects the way a dropped connection does.
//
// Real input over the DevTools protocol (trustedClick): the Layers summary, the Cameras group's
// summary and the checkbox itself are each pressed the way a reader presses them.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { trustedClick } from './helpers/trusted-click.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, chooseExampleArea } from './helpers/waits.mjs';
import { CONTEXT_SURFACE_IDS } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built — run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

let shared = null;
after(async () => {
  if (!shared) return;
  shared.page.close();
  await shared.site.close();
});

/** `area`: draw the example area BEFORE the panel is opened, so state.recipe is set.
 *  `rebuilt`: and press Check sources, whose pass calls renderLayerControls() and replaces every
 *  row with a new element. The generic `.qcm-controls` change listener was attached to the rows
 *  that existed at load, so a row built later has only layerRow's own listener: pressing a camera
 *  box there is the one path where the count depends on layerRow refreshing it. */
async function freshPage({ area = false, rebuilt = false, group = 'Cameras' } = {}) {
  if (!shared) {
    const site = await startSiteServer();
    const page = await launch(CHROMIUM, `${site.origin}/quiet-corners/`, {
      viewport: { width: 1280, height: 900 }, args: ['--hide-scrollbars'],
    });
    shared = { site, page };
  }
  const { site, page } = shared;
  await page.setViewport({ width: 1280, height: 900 });
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: false });
  if (area || rebuilt) await chooseExampleArea(page);
  if (rebuilt) {
    // Setup, not the proof: a page-side click starts the pass, then the wait is on the rows
    // being replaced (the node tagged here is gone from the document).
    await page.evaluate(`(async () => {
      window.__oldRoadRow = document.getElementById('qcm-layer-roadCameras');
      document.getElementById('qcm-check').click();
      await qcWait('Check sources rebuilt the layer rows', () => {
        const now = document.getElementById('qcm-layer-roadCameras');
        return now && now !== window.__oldRoadRow;
      });
      return true;
    })()`);
  }
  const isOpen = () => page.evaluate("document.getElementById('qcm-layer-panel').open");
  for (let attempt = 0; attempt < 8 && !(await isOpen()); attempt++) {
    await trustedClick(page, '#qcm-layer-panel summary');
    for (let i = 0; i < 5 && !(await isOpen()); i++) await page.evaluate('new Promise(r => setTimeout(r, 100))');
  }
  assert.equal(await isOpen(), true, 'the Layers panel summary did not open the panel');
  const groupSel = `.qcm-layer-group[aria-label="${group}"]`;
  await trustedClick(page, `${groupSel} summary`, { until: `document.querySelector('${groupSel}').open` });
  return page;
}

const countText = (page) => page.evaluate("document.getElementById('qcm-layer-count').textContent");

test('Road cameras checked, failure reported: the count names 1 layer on', { skip }, async () => {
  const page = await freshPage();
  assert.equal(await countText(page), 'No layers on', 'the panel should open with nothing on');
  await page.send('Network.enable');
  await page.send('Network.setBlockedURLs', { urls: ['*/data/quiet-corners-maps/cameras/*'] });
  let seen;
  try {
    await trustedClick(page, '#qcm-layer-roadCameras');
    seen = await page.evaluate(`(async () => {
      const report = await qcWait('the road-camera report appeared', () => {
        const el = document.getElementById('qcm-layer-roadCameras-report');
        return el && !el.hidden && el.textContent.trim() ? el : null;
      });
      return { checked: document.getElementById('qcm-layer-roadCameras').checked, report: report.textContent,
        count: document.getElementById('qcm-layer-count').textContent };
    })()`);
  } finally {
    // The page is shared: the next test reads the camera index for real.
    await page.send('Network.setBlockedURLs', { urls: [] });
  }
  assert.equal(seen.checked, true, 'the trusted click did not check Road cameras');
  assert.match(seen.report, /did not load/, `expected the blocked camera index to fail visibly, the report reads: ${seen.report}`);
  assert.equal(seen.count, '1 layer on', `Road cameras is checked and its failure is reported, but the count reads "${seen.count}"`);
});

test('Park cameras checked: the count names 1 layer on, and 0 again once it is unchecked', { skip }, async () => {
  const page = await freshPage();
  await trustedClick(page, '#qcm-layer-parkCameras');
  const on = await page.evaluate(`(async () => {
    await qcWait('the park camera row settled', () => {
      const el = document.getElementById('qcm-layer-parkCameras-report');
      return el && !el.hidden && el.textContent.trim();
    });
    return { checked: document.getElementById('qcm-layer-parkCameras').checked,
      count: document.getElementById('qcm-layer-count').textContent };
  })()`);
  assert.equal(on.checked, true);
  assert.equal(on.count, '1 layer on', `Park cameras is checked but the count reads "${on.count}"`);
  await trustedClick(page, '#qcm-layer-parkCameras');
  assert.equal(await countText(page), 'No layers on', 'unchecking the only layer should return the count to "No layers on"');
});

test('an area drawn and sources checked (recipe set, rows rebuilt): checking Road cameras still names 1 layer on', { skip }, async () => {
  const page = await freshPage({ area: true, rebuilt: true });
  assert.equal(await page.evaluate('Boolean(document.querySelector("#qcm-estimate dd[data-field=pages]").textContent.trim().replace("—", ""))'), true,
    'the example area should have produced a plan, so the recipe is set');
  assert.equal(await countText(page), 'No layers on');
  await trustedClick(page, '#qcm-layer-roadCameras');
  assert.equal(await countText(page), '1 layer on', 'with an area drawn, the checked camera row is still not counted');
  await trustedClick(page, '#qcm-layer-roadCameras');
  assert.equal(await countText(page), 'No layers on');
});

test('a context radio is counted, and "No context surface" takes the count back to none', { skip }, async () => {
  // QQA-18: the surface radios sit under their task heading (night lights: Night sky), while
  // "No context surface" sits under Map style -- one `qcm-context` choice across two groups.
  const page = await freshPage({ group: 'Night sky' });
  const id = CONTEXT_SURFACE_IDS[0];   // a radio; overlays are qcm-layer-<id> checkboxes
  const styleSel = '.qcm-layer-group[aria-label="Map style"]';
  await trustedClick(page, `${styleSel} summary`, { until: `document.querySelector('${styleSel}').open` });
  await trustedClick(page, `#qcm-context-${id}`);
  assert.equal(await page.evaluate(`document.getElementById('qcm-context-${id}').checked`), true, 'the trusted click did not select the context radio');
  assert.equal(await countText(page), '1 layer on', `context surface "${id}" is selected but the count does not say so`);
  await trustedClick(page, '#qcm-context-none');
  assert.equal(await countText(page), 'No layers on');
});
