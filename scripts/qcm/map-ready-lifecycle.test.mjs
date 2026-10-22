// The map is created before any of the five dashboard requests settles.
//
// Before this file, quiet-corners.js's loadData() ran all five fetches
// through one Promise.all and only built the map once every one of them had
// settled, then bailed out of the whole load — map included — the moment
// counties.json alone had failed (dashboard-load-failure.test.mjs covers
// that old give-up path with a synthetic DOM state, not a real fetch).
// A slow or failing counties.json, geo.json, counties-10m.json or
// navigation-places.json now degrades only the feature it feeds — the
// county table, the county wash, the place labels — and never blocks, or is
// blocked by, the map, its base tiles, its search box or its print builder.
//
// Each proof here patches window.fetch for ONE named file before the page's
// own script runs (via the DevTools protocol's addScriptToEvaluateOnNewDocument,
// so the patch is in place for the very first request quiet-corners.js makes)
// and leaves the other four requests untouched, hitting the real built site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { waitInPage } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built — run `hugo --configDir site-config --minify` first'
    : false;

/** A bounded ceiling: the point of every proof here is that the map does
 *  not wait on the patched request(s), so a regression that makes it wait
 *  is a failed proof either way, not a slow one. */
const CEILING = 15000;

/** Installed on the page before its own script runs. Counts qc:map-ready
 *  firings, counts requests left hanging in __qcPendingCount, and, for each `{ match, mode }` in `patches`, replaces window.fetch
 *  for any request whose URL contains `match`: 'notfound' answers 404,
 *  'pending' never resolves, 'malformed' answers 200 with invalid JSON.
 *  Every other request goes to the real fetch untouched. */
const patchSource = (patches) => `(() => {
  window.__qcReadyCount = 0;
  window.__qcPendingCount = 0;
  document.addEventListener('qc:map-ready', () => { window.__qcReadyCount++; });
  const real = window.fetch.bind(window);
  const patches = ${JSON.stringify(patches)};
  window.fetch = function(input, init) {
    const url = String(input && input.url ? input.url : input);
    const hit = patches.find((p) => url.indexOf(p.match) !== -1);
    if (hit) {
      if (hit.mode === 'pending') { window.__qcPendingCount++; return new Promise(() => {}); }
      if (hit.mode === 'notfound') return Promise.resolve(new Response('not found', { status: 404 }));
      if (hit.mode === 'malformed') {
        return Promise.resolve(new Response('{ not valid json', {
          status: 200, headers: { 'content-type': 'application/json' },
        }));
      }
    }
    return real(input, init);
  };
})()`;

/** Starts the site, launches on about:blank, arms the fetch patch for every
 *  subsequent navigation, then navigates to the real dashboard. Doing the
 *  patch before the first navigate() (rather than passing the dashboard URL
 *  straight to launch()) is what makes it apply to the page's own script,
 *  which runs on load — a patch installed after navigation is already too
 *  late for a load-time fetch. */
async function withPatchedFetch(patches, fn) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', {
    viewport: { width: 1280, height: 900 }, args: ['--hide-scrollbars'],
  });
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: patchSource(patches) });
    await page.navigate(`${site.origin}/quiet-corners/`);
    return await fn(page);
  } finally { page.close(); await site.close(); }
}

test('counties.json 404s: the map is created and qc:map-ready fires once', { skip }, async () => {
  await withPatchedFetch([{ match: 'counties.json', mode: 'notfound' }], async (page) => {
    await waitInPage(page, 'window.qcMap to exist', 'Boolean(window.qcMap)', CEILING, null);
    const ready = await page.evaluate('window.__qcReadyCount');
    assert.equal(ready, 1, `qc:map-ready should fire exactly once, fired ${ready} times`);
    const loaded = await page.evaluate('Boolean(window.qcMap && window.qcMap._loaded)');
    assert.ok(loaded, 'the map should finish loading even though counties.json 404d');
    const banner = await page.evaluate(`(() => {
      const b = document.getElementById('qc-error');
      return b ? getComputedStyle(b).display : 'no banner element';
    })()`);
    assert.notEqual(banner, 'none', 'a 404 on counties.json should surface its own visible status');
  });
});

test('counties.json never resolves: the map still appears within a bounded time', { skip }, async () => {
  await withPatchedFetch([{ match: 'counties.json', mode: 'pending' }], async (page) => {
    // The patched fetch never settles, so the map can only appear if creation
    // did not wait on it; waitInPage's CEILING (counted from navigation, not
    // from server start or browser launch) is the bound.
    await waitInPage(page, 'window.qcMap to exist', 'Boolean(window.qcMap)', CEILING, null);
    const stillPending = await page.evaluate('window.__qcPendingCount');
    assert.equal(stillPending, 1, `counties.json should still be pending when the map appears, pending=${stillPending}`);
    const ready = await page.evaluate('window.__qcReadyCount');
    assert.equal(ready, 1, `qc:map-ready should fire exactly once, fired ${ready} times`);
  });
});

test('geo.json and counties-10m.json both 404: the map still builds from tile layers', { skip }, async () => {
  await withPatchedFetch([
    { match: 'geo.json', mode: 'notfound' },
    { match: 'counties-10m.json', mode: 'notfound' },
  ], async (page) => {
    await waitInPage(page, 'window.qcMap to exist', 'Boolean(window.qcMap)', CEILING, null);
    const loaded = await page.evaluate('Boolean(window.qcMap && window.qcMap._loaded)');
    assert.ok(loaded, 'the map should finish loading with no county geometry at all');
    const ready = await page.evaluate('window.__qcReadyCount');
    assert.equal(ready, 1, `qc:map-ready should fire exactly once, fired ${ready} times`);
  });
});

test('all five datasets succeed: qc:map-ready fires once and county features attach', { skip }, async () => {
  await withPatchedFetch([], async (page) => {
    await waitInPage(page, 'window.qcMap to exist', 'Boolean(window.qcMap)', CEILING, null);
    await waitInPage(page, 'a row in the county table', "Boolean(document.querySelector('#qc-table-body .qc-row'))", CEILING, null);
    const ready = await page.evaluate('window.__qcReadyCount');
    assert.equal(ready, 1, `qc:map-ready should fire exactly once, fired ${ready} times`);
  });
});

test('malformed navigation-places.json: labels are skipped with a visible status, map intact', { skip }, async () => {
  await withPatchedFetch([{ match: 'navigation-places.json', mode: 'malformed' }], async (page) => {
    await waitInPage(page, 'window.qcMap to exist', 'Boolean(window.qcMap)', CEILING, null);
    const loaded = await page.evaluate('Boolean(window.qcMap && window.qcMap._loaded)');
    assert.ok(loaded, 'the map should be intact when only navigation-places.json is malformed');
    const noticeText = await page.evaluate(`(() => {
      const n = document.querySelector('.qc-map-notice');
      return n ? n.textContent : null;
    })()`);
    assert.match(noticeText ?? '', /Place names unavailable/,
      `expected a visible status about missing place names, got: ${noticeText}`);
  });
});
