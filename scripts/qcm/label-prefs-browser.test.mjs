// QUX-05b: named-terrain label density/size control -- proves the one thing a
// pure test cannot. The control's own DOM (quiet-corners-dashboard.html) is
// wired through quiet-corners.js's applyLabelsFromView/currentView/
// wireViewControls to Q/main.js's state.labelPrefs via the real
// window.qcSetLabelPrefs bridge, saved to the real viewPrefsStore
// (view-wiring.js's createPrefsStore, backed by real localStorage -- neither
// a jsdom nor a pure-function test has either), and restored on a real page
// reload with no #map= fragment in the URL (the "saved prefs" precedence
// tier of resolveInitialView, view-state.js). Same fetch-stub/readyDashboard
// convention as presets-browser.test.mjs; see its header for why a browser
// proof rather than a DOM-less one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const CEILING = 20000;
// view-wiring.js's PREFS_KEY -- not importable into the page's own module
// graph from here, so named the same way presets-browser.test.mjs names ids
// it does not import.
const PREFS_KEY = 'qc-field-maps-display-prefs';

/** Installed on the page before its own script runs. Every request this
 *  proof could trigger gets a harmless empty body -- it never needs real
 *  county/terrain data, only the map and the two controls under test. */
const PATCH_SOURCE = `(() => {
  window.fetch = function() {
    return Promise.resolve(new Response('{}', {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
  };
})()`;

async function withPatchedFetch(fn) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', {
    viewport: { width: 1280, height: 900 }, args: ['--hide-scrollbars'],
  });
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PATCH_SOURCE });
    await page.navigate(`${site.origin}/quiet-corners/`);
    await readyDashboard(page, { data: false, ms: CEILING });
    return await fn(page, site);
  } finally { page.close(); await site.close(); }
}

async function setPrefs(page, density, size) {
  await page.evaluate(`(() => {
    const densitySel = document.getElementById('qc-label-density');
    densitySel.value = ${JSON.stringify(density)};
    densitySel.dispatchEvent(new Event('change', { bubbles: true }));
    const sizeSel = document.getElementById('qc-label-size');
    sizeSel.value = ${JSON.stringify(size)};
    sizeSel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}

test('choosing a density/size pushes it live to the map state and saves it', { skip }, async () => {
  await withPatchedFetch(async (page) => {
    const before = await page.evaluate('(() => window.qcGetLabelPrefs())()');
    assert.deepEqual(before, { density: 'standard', size: 'normal' }, 'labelPrefs starts at the documented default');

    await setPrefs(page, 'sparse', 'large');

    const live = await page.evaluate('(() => window.qcGetLabelPrefs())()');
    assert.deepEqual(live, { density: 'sparse', size: 'large' }, 'qcSetLabelPrefs reached Q/main.js state through the change listener');

    const saved = await page.evaluate(`(() => {
      const raw = localStorage.getItem(${JSON.stringify(PREFS_KEY)});
      return raw ? JSON.parse(raw) : null;
    })()`);
    assert.ok(saved, "wireViewControls' change listener saved to viewPrefsStore");
    assert.deepEqual(saved.labels, { density: 'sparse', size: 'large' }, 'the saved prefs carry the new labels field');
  });
});

test('a saved density/size survives a real reload with no #map= fragment', { skip }, async () => {
  await withPatchedFetch(async (page, site) => {
    await setPrefs(page, 'more', 'large');

    // A fresh navigation to the bare page URL: same origin (localStorage
    // survives), no #map= fragment (so this exercises resolveInitialView's
    // saved-prefs tier, not the fragment tier, which would win first).
    await page.navigate(`${site.origin}/quiet-corners/`);
    await readyDashboard(page, { data: false, ms: CEILING });

    const controls = await page.evaluate(`(() => ({
      density: document.getElementById('qc-label-density').value,
      size: document.getElementById('qc-label-size').value,
    }))()`);
    assert.deepEqual(controls, { density: 'more', size: 'large' }, 'the controls themselves reopen on the saved choice');

    const live = await page.evaluate('(() => window.qcGetLabelPrefs())()');
    assert.deepEqual(live, { density: 'more', size: 'large' }, 'Q/main.js state reopens on the saved choice too, not just the DOM controls');
  });
});
