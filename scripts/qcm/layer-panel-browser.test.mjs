// U0 Layers-panel proof, on the real built Field Maps app (/quiet-corners/ --
// the same page and the same map the county dashboard uses; see
// names-keyboard.test.mjs's header for why). Drives headless Chromium over the
// DevTools protocol the same way the other proofs in this directory do.
//
// Every fetch() this page could make while only the federalLand layer is
// ticked is intercepted before the page's own script runs: the govunits
// family query (carto.nationalmap.gov/.../govunits/MapServer/{29,31,32,35}
// /query), the quad-index area-states lookup (.../map_indices/MapServer/10
// /query), and the USGS Topo reachability GET. Nothing here falls through to
// a real fetch() call -- an unmatched one fails the test loudly instead of
// reaching the network; anything else the dashboard's own five load-time
// fetches ask for gets a harmless empty JSON body, since this proof does not
// exercise them.
//
// Proves brief-u0.md's two browser claims: (1) the search box narrows the
// rows shown without moving any switch's checked state, and active-only
// hides an unchecked row; (2) a row's badge goes loading -> unavailable ->
// ready across a first failed check and a Retry, the map's center and zoom
// never move across any of it, and unticking the layer (Clear) removes its
// symbol from the map key without moving the map either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { waitInPage, readyDashboard, chooseExampleArea } from './helpers/waits.mjs';
import { VIEWPORT_FETCH } from '../../themes/headlessmode/static/js/quiet-corners-maps/app-state.js';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const CEILING = 20000;

/** Installed on the page before its own script runs. `govFailCount` failed
 *  govunits answers, then every one after that succeeds with one polygon --
 *  the first pass (Check sources) gets the failures, Retry gets the answer,
 *  without this file needing to know which call is which. */
const patchSource = (govFailCount, { govDelayMs = 0 } = {}) => `(() => {
  let govCalls = 0;
  window.fetch = function(input, init) {
    const url = String(input && input.url ? input.url : input);
    if (url.indexOf('/map_indices/') !== -1 && url.indexOf('/query') !== -1) {
      return Promise.resolve(new Response(JSON.stringify({ features: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    }
    const gov = url.match(/\\/govunits\\/MapServer\\/(29|31|32|35)\\/query/);
    if (gov) {
      govCalls += 1;
      if (govCalls <= ${govFailCount}) {
        return Promise.resolve(new Response('service unavailable', { status: 500 }));
      }
      const body = {
        features: [{
          attributes: { name: 'Test National Forest', areasqkm: 12.3 },
          geometry: { rings: [[[-84, 35], [-84, 35.05], [-83.95, 35.05], [-83.95, 35], [-84, 35]]] },
        }],
        exceededTransferLimit: false,
      };
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    }
    if (url.indexOf('nationalmap.gov') !== -1) {
      return Promise.resolve(new Response('', { status: 200 }));
    }
    // The dashboard's own load-time fetches (counties.json and friends) --
    // this proof does not exercise them, so a harmless empty body keeps them
    // from throwing without this file needing to know every request shape.
    return Promise.resolve(new Response('{}', {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
  };
  // Optional: hold every govunits answer for govDelayMs and record how many
  // were out at once, so a proof can tell one pass from two passes overlapping.
  if (${govDelayMs} > 0) {
    const answer = window.fetch;
    let out = 0;
    window.qcGovOut = 0; window.qcGovPeak = 0;
    window.fetch = function(input, init) {
      const url = String(input && input.url ? input.url : input);
      if (!/\\/govunits\\/MapServer\\/(29|31|32|35)\\/query/.test(url)) return answer(input, init);
      out += 1; window.qcGovOut = out; window.qcGovPeak = Math.max(window.qcGovPeak, out);
      return new Promise((ok) => setTimeout(ok, ${govDelayMs}))
        .then(() => answer(input, init))
        .finally(() => { out -= 1; window.qcGovOut = out; });
    };
  }
})()`;

async function withPatchedFetch(govFailCount, fn, patch = {}) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', {
    viewport: { width: 1280, height: 900 }, args: ['--hide-scrollbars'],
  });
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: patchSource(govFailCount, patch) });
    await page.navigate(`${site.origin}/quiet-corners/`);
    await readyDashboard(page, { data: false, ms: CEILING });
    return await fn(page);
  } finally { page.close(); await site.close(); }
}

test('layer search narrows rows without moving a switch; active-only hides an off row', { skip }, async () => {
  await withPatchedFetch(4, async (page) => {
    // A switch's checked state must survive being hidden by the filter, so
    // this ticks one (mvum) before ever touching the search box.
    await page.evaluate("document.getElementById('qcm-layer-mvum').checked = true");

    await page.evaluate(`(() => {
      const box = document.getElementById('qcm-layer-search');
      box.value = 'refuge';
      box.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);

    const afterSearch = await page.evaluate(`(() => {
      const mvumRow = document.getElementById('qcm-layer-mvum').closest('.qcm-layer-row');
      const federalRow = document.getElementById('qcm-layer-federalLand').closest('.qcm-layer-row');
      return {
        mvumChecked: document.getElementById('qcm-layer-mvum').checked,
        mvumHidden: mvumRow.hidden,
        federalHidden: federalRow.hidden,
      };
    })()`);
    assert.equal(afterSearch.mvumChecked, true, "searching must never change a switch's checked state");
    assert.equal(afterSearch.mvumHidden, true, '"refuge" should not match the MVUM row (label/group/note)');
    assert.equal(afterSearch.federalHidden, false, '"refuge" should match the federal-land row (label says "refuges")');

    // Clearing the query restores every row -- the mvum switch is still on.
    await page.evaluate(`(() => {
      const box = document.getElementById('qcm-layer-search');
      box.value = '';
      box.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const cleared = await page.evaluate(`(() => {
      const mvumRow = document.getElementById('qcm-layer-mvum').closest('.qcm-layer-row');
      return { mvumHidden: mvumRow.hidden, mvumChecked: document.getElementById('qcm-layer-mvum').checked };
    })()`);
    assert.equal(cleared.mvumHidden, false, 'clearing the search should show the MVUM row again');
    assert.equal(cleared.mvumChecked, true, 'the MVUM switch should still read on after the search cleared');

    // Active-only: mvum (on) stays, an off overlay row (federalLand -- names opens
    // ON since N3, so it is no longer the off example) is hidden, and the base
    // group's current choice (always shown) stays visible.
    await page.evaluate(`(() => {
      const cb = document.getElementById('qcm-layers-active-only');
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const activeOnly = await page.evaluate(`(() => {
      const mvumRow = document.getElementById('qcm-layer-mvum').closest('.qcm-layer-row');
      const offRow = document.getElementById('qcm-layer-federalLand').closest('.qcm-layer-row');
      const topoRow = document.getElementById('qcm-base-usgsTopo').closest('.qcm-layer-row');
      return { mvumHidden: mvumRow.hidden, offChecked: offRow.querySelector('input').checked, offHidden: offRow.hidden, topoHidden: topoRow.hidden };
    })()`);
    assert.equal(activeOnly.mvumHidden, false, 'active-only should keep a checked row visible');
    assert.equal(activeOnly.offChecked, false, 'the example off row must really be off');
    assert.equal(activeOnly.offHidden, true, 'active-only should hide an unchecked overlay row');
    assert.equal(activeOnly.topoHidden, false, "active-only should always show the base map's current choice");
  });
});

test("a layer's badge goes loading -> unavailable -> ready via Retry; Clear removes its legend symbol; the map never moves", { skip }, async () => {
  await withPatchedFetch(4, async (page) => {
    await chooseExampleArea(page);
    await page.evaluate(`(() => {
      const cb = document.getElementById('qcm-layer-federalLand');
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await page.evaluate("document.getElementById('qcm-check').click()");
    await waitInPage(page, 'the federal-land badge to read unavailable',
      "document.getElementById('qcm-layer-federalLand-badge').textContent === 'unavailable'", CEILING, null);

    const view0 = await page.evaluate(`(() => {
      const c = window.qcMap.getCenter();
      return { lat: c.lat, lng: c.lng, zoom: window.qcMap.getZoom() };
    })()`);

    const retryVisible = await page.evaluate("document.getElementById('qcm-layer-federalLand-retry').hidden === false");
    assert.ok(retryVisible, 'an unavailable row should show its Retry button');

    await page.evaluate("document.getElementById('qcm-layer-federalLand-retry').click()");
    await waitInPage(page, 'the federal-land badge to read ready',
      "document.getElementById('qcm-layer-federalLand-badge').textContent === 'ready'", CEILING, null);

    const view1 = await page.evaluate(`(() => {
      const c = window.qcMap.getCenter();
      return { lat: c.lat, lng: c.lng, zoom: window.qcMap.getZoom() };
    })()`);
    assert.deepEqual(view1, view0, 'Retry must re-fetch only its own layer, never move the map');

    const legendAfterRetry = await page.evaluate("document.getElementById('qcm-legend').textContent");
    assert.match(legendAfterRetry, /National Forest \(boundary\)/,
      `expected the retried federal-land symbol on the map key, got: ${legendAfterRetry}`);

    // Clear: unticking removes the drawn features and the legend symbol,
    // without moving the map.
    await page.evaluate(`(() => {
      const cb = document.getElementById('qcm-layer-federalLand');
      cb.checked = false;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitInPage(page, 'the federal-land symbol to leave the map key',
      "!document.getElementById('qcm-legend').textContent.includes('National Forest (boundary)')", CEILING, null);

    const view2 = await page.evaluate(`(() => {
      const c = window.qcMap.getCenter();
      return { lat: c.lat, lng: c.lng, zoom: window.qcMap.getZoom() };
    })()`);
    assert.deepEqual(view2, view0, 'clearing a layer must not move the map');
  });
});

// 2026-09-26: choosing the example area moves the map, and the debounced
// viewport browse fired while the Check button's pass was still out. Both
// passes wrote the same source state side by side, so a badge read whichever
// finished last (#567, #571). Each govunits answer is held here long enough that
// the browse comes due mid-pass on any box; one pass asks the four federal
// families at once, so more than four out together means two passes overlapped.
test('the Check pass and the viewport browse never fetch side by side', { skip }, async () => {
  const GOV_DELAY_MS = 2000;
  await withPatchedFetch(0, async (page) => {
    await page.evaluate(`(() => {
      const cb = document.getElementById('qcm-layer-federalLand');
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('qcm-use-example').click();
      document.getElementById('qcm-check').click();
      return true;
    })()`);
    await waitInPage(page, 'the federal-land badge to read ready',
      "document.getElementById('qcm-layer-federalLand-badge').textContent === 'ready'", CEILING, null);
    // Let any browse that was due come and go before reading the peak.
    await page.evaluate(`(async () => {
      await new Promise((r) => setTimeout(r, ${VIEWPORT_FETCH.settleMs + GOV_DELAY_MS + 500}));
      return true;
    })()`);
    await waitInPage(page, 'every govunits request to be answered', 'window.qcGovOut === 0', CEILING, null);
    const peak = await page.evaluate('window.qcGovPeak');
    assert.ok(peak >= 1, 'the Check pass never asked the federal-land service');
    assert.ok(peak <= 4, `two source passes fetched side by side (${peak} govunits requests out at once)`);
    const badge = await page.evaluate("document.getElementById('qcm-layer-federalLand-badge').textContent");
    assert.equal(badge, 'ready', 'the badge must end on the answer, not on a pass that finished later');
  }, { govDelayMs: GOV_DELAY_MS });
});
