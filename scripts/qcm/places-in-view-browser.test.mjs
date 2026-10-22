// QUX-11a browser proof for "Places in this view" (places-in-view.js +
// main.js's renderNameList) on the real built Field Maps app: headless
// Chromium over the DevTools protocol, every cross-origin request stubbed
// in-page before the page's own script runs (names-keyboard.test.mjs's
// technique). QUX-11.md §4.2 lists the setup and the seven numbered items.
//
// Leaflet reflects `alt` only onto <img> icons; .qcm-name-marker is a divIcon,
// so this file reads `.title` where §4.2 step 1 says "alt".
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findChromium, launch } from './helpers/browser.mjs';
import { trustedClick as pressWhenStill } from './helpers/trusted-click.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { waitInPage, readyDashboard, chooseExampleArea } from './helpers/waits.mjs';
import { PLACE_FEATURES } from './fixtures/gnis-names-declutter.mjs';
import { STATUS_MESSAGE } from '../../themes/headlessmode/static/js/quiet-corners-maps/name-labels.js';
import { VIEWPORT_FETCH } from '../../themes/headlessmode/static/js/quiet-corners-maps/app-state.js';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const CEILING = 20000;

// Two Summit rows (layer 5) and one Falls row (layer 7) in the same raw Esri
// shape as PLACE_FEATURES, inside the example-area bbox but off its 9x5 grid
// (QUX-11.md §4.2 setup). Step 5 unchecks "Towns and places" and expects
// exactly these three rows, the only non-`place`-kind fixtures.
const SUMMIT_FEATURES = [
  {
    attributes: { gaz_id: 930001, gaz_name: 'Test Summit A', gaz_featureclass: 'Summit', state_alpha: 'NC', county_name: 'Test County' },
    geometry: { points: [[-83.5425, 35.095]] },
  },
  {
    attributes: { gaz_id: 930002, gaz_name: 'Test Summit B', gaz_featureclass: 'Summit', state_alpha: 'NC', county_name: 'Test County' },
    geometry: { points: [[-83.4075, 35.095]] },
  },
];
const FALLS_FEATURES = [
  {
    attributes: { gaz_id: 940001, gaz_name: 'Test Falls', gaz_featureclass: 'Falls', state_alpha: 'NC', county_name: 'Test County' },
    geometry: { points: [[-83.4755, 35.003]] },
  },
];

const ALL_NAMES = [
  ...PLACE_FEATURES.map((f) => f.attributes.gaz_name),
  ...SUMMIT_FEATURES.map((f) => f.attributes.gaz_name),
  ...FALLS_FEATURES.map((f) => f.attributes.gaz_name),
];
// terrain-names.js's normalizeFeature: id = `gnis:${gaz_id}`, anchor = [lat, lon].
const ALL_POINTS = [
  ...PLACE_FEATURES.map((f) => ({ id: `gnis:${f.attributes.gaz_id}`, lon: f.geometry.points[0][0], lat: f.geometry.points[0][1] })),
  ...SUMMIT_FEATURES.map((f) => ({ id: `gnis:${f.attributes.gaz_id}`, lon: f.geometry.points[0][0], lat: f.geometry.points[0][1] })),
  ...FALLS_FEATURES.map((f) => ({ id: `gnis:${f.attributes.gaz_id}`, lon: f.geometry.points[0][0], lat: f.geometry.points[0][1] })),
];

const ELEVATION_URL = 'elevation.nationalmap.gov';

// QUX-11.md §4.4: three Forest Service sites, in the raw {attributes, geometry:
// {x, y}} shape source-rec-sites.js's normalizeSite reads, positioned inside
// BBOX (distinct from PLACE_FEATURES' 9x5 grid and SUMMIT/FALLS_FEATURES above,
// same convention). One TRAILHEAD (fee stated, status stated -- exercises the
// "states the fee line and 'not a live check'" assertion), one with a blank fee
// (and blank status, so its own card would read "the record does not say" --
// not asserted on directly, but proves a blank field is not silently coerced),
// one unnamed (blank site_name -> shortSiteName returns null -> "Unnamed Forest
// Service recreation site").
const FS_SITES = [
  {
    attributes: {
      site_name: 'Test Trailhead', site_type: 'TRAILHEAD', fee_charged: 'N',
      seasonal_operational_status: 'OPEN', open_season: 'Year-round', total_capacity: 10,
    },
    geometry: { x: -83.49, y: 35.02 },
  },
  {
    attributes: {
      site_name: 'Test Campground', site_type: 'CAMPGROUND', fee_charged: '',
      seasonal_operational_status: '', open_season: '', total_capacity: null,
    },
    geometry: { x: -83.48, y: 35.03 },
  },
  {
    attributes: {
      site_name: '', site_type: 'CAMPGROUND', fee_charged: 'Y',
      seasonal_operational_status: '', open_season: '', total_capacity: null,
    },
    geometry: { x: -83.47, y: 35.04 },
  },
];

// QUX-11.md §4.4: "Stub BLM from scripts/qcm/fixtures/blm-rec-sites-2026-09-11.min.json"
// -- the same 3-record capture blm-rec-sites.test.mjs reads, verbatim (its own
// real-world coordinates: Minnesota and California, both outside BBOX). Served
// as-is rather than repositioned: the instruction is to stub FROM the fixture,
// not to invent in-bounds coordinates the fixture never measured. The BLM layer
// still fetches, normalizes and renders (0 in-bounds rows/pins is a legitimate
// answer for this viewport, not an error) -- neither scenario below depends on
// a BLM row being in view.
const BLM_CAPTURE = JSON.parse(readFileSync(new URL('./fixtures/blm-rec-sites-2026-09-11.min.json', import.meta.url), 'utf8'));

// fetchBounded (source-terrain-names.js) counts layers 3/5/6/7 first, then
// pages each one, so all four need an answer. window.__qcFetchOrigins records
// the origin of every request the page's fetch makes, so "the request delta"
// (QUX-11.md §4) is a plain array slice. Elevation answers immediately: this
// file only checks that a card opened from a row makes the SAME request as
// one opened from a placed marker (QUX-11a §2.4 item 2), not the flow itself.
// `extra.fsFeatures`/`extra.blmFeatures` (QUX-11b, §4.4) default to null: the
// READY/PARTIAL calls below pass neither, and recSites/blmRecSites are only
// turned on by the third test, so nothing else ever asks for those layers.
// Every cross-origin request must be answered here -- assertHermetic fails
// the test on any that reaches real(input, init).
function patchSource(counts, pages, extra = {}) {
  const { fsFeatures = null, blmFeatures = null } = extra;
  return `(() => {
    const counts = ${JSON.stringify(counts)};
    const pages = ${JSON.stringify(pages)};
    const fsFeatures = ${JSON.stringify(fsFeatures)};
    const blmFeatures = ${JSON.stringify(blmFeatures)};
    window.__qcFetchOrigins = window.__qcFetchOrigins || [];
    window.__qcUnstubbed = window.__qcUnstubbed || [];
    const real = window.fetch.bind(window);
    window.__qcPending = window.__qcPending || 0;
    window.__qcFetchUrls = window.__qcFetchUrls || [];
    const wrapped = function(input, init) {
      const url = String(input && input.url ? input.url : input);
      let origin = null;
      try { origin = new URL(url, location.href).origin; window.__qcFetchOrigins.push(origin); window.__qcFetchUrls.push(url); } catch { /* opaque request */ }
      // The NHD river tier is answered empty: these proofs are hermetic and about the GNIS names.
      if (/nhd\\/MapServer\\/\\d+\\/query/.test(url)) return Promise.resolve(new Response(JSON.stringify({ features: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
      const m = url.match(/geonames\\/MapServer\\/(\\d+)\\/query/);
      if (m) {
        const isCount = /returnCountOnly=true/.test(url);
        const body = isCount ? { count: counts[m[1]] ?? 0 } : { features: pages[m[1]] ?? [] };
        return Promise.resolve(new Response(JSON.stringify(body), {
          status: 200, headers: { 'content-type': 'application/json' },
        }));
      }
      // Q/source-rec-sites.js's SERVICE, one query layer, no returnCountOnly
      // request (pageThrough pages unconditionally -- arcgis-pager.js:23-62).
      if (fsFeatures && /EDW_RecInfraRecreationSites_02\\/MapServer\\/0\\/query/.test(url)) {
        return Promise.resolve(new Response(JSON.stringify({ features: fsFeatures }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }));
      }
      // Q/source-registry.js's BLM_REC_SERVICE, MapServer layer 1.
      if (blmFeatures && /BLM_Natl_Recreation_Sites_Facilities\\/MapServer\\/1\\/query/.test(url)) {
        return Promise.resolve(new Response(JSON.stringify({ features: blmFeatures }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }));
      }
      if (url.indexOf(${JSON.stringify(ELEVATION_URL)}) !== -1) {
        return Promise.resolve(new Response(JSON.stringify({ samples: [{ locationId: 0, value: 500 }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }));
      }
      // The other two calls a source pass makes (main.js sourcePass): one
      // USGSTopo tile probe and the quad-index query. Neither feeds the names
      // path. Same stubs as layer-panel-browser.
      if (url.indexOf('/map_indices/') !== -1 && url.indexOf('/query') !== -1) {
        return Promise.resolve(new Response(JSON.stringify({ features: [] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }));
      }
      // Road names (QQA-05r-2) are on by default and ask for the view at zoom 10+; an empty
      // answer draws nothing, which is all these proofs need from them.
      if (url.indexOf('/transportation/MapServer/') !== -1 && url.indexOf('/query') !== -1) {
        return Promise.resolve(new Response(JSON.stringify({ features: [] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }));
      }
      if (url.indexOf('basemap.nationalmap.gov') !== -1) {
        return Promise.resolve(new Response('', { status: 200 }));
      }
      // Anything cross-origin reaching here is a real network call (assertHermetic).
      if (origin && origin !== location.origin) window.__qcUnstubbed.push(url.slice(0, 120));
      return real(input, init);
    };
    window.fetch = function(input, init) {
      window.__qcPending++;
      return wrapped(input, init).finally(() => { window.__qcPending--; });
    };
  })()`;
}

/** Every cross-origin request must be answered by this file's stub. A real
 *  fetch answers whenever the network says so; on a loaded CI runner that put
 *  it (and fetchJsonPage's retries) inside a later measurement window, and
 *  step 6's held-pan count drifted (36 !== 19, 20 !== 18, five CI runs). This
 *  turns the timing flake into a deterministic failure that names the URL. */
async function assertHermetic(page, where) {
  const unstubbed = await page.evaluate('window.__qcUnstubbed');
  assert.deepEqual(unstubbed, [], `${where}: cross-origin requests reached the real network (stub them):\n  ${unstubbed.join('\n  ')}`);
}

const READY_COUNTS = { 3: PLACE_FEATURES.length, 5: SUMMIT_FEATURES.length, 6: 0, 7: FALLS_FEATURES.length };
const READY_PAGES = { 3: PLACE_FEATURES, 5: SUMMIT_FEATURES, 6: [], 7: FALLS_FEATURES };
// Step 7: layer 3's count answers one higher than its page ever delivers, so
// fetchBounded's rawFetched (48) never equals totalCount (49) -- status
// 'partial' (source-terrain-names.js: `status = rawFetched === totalCount ?
// 'ready' : 'partial'`), across all four layers summed.
const PARTIAL_COUNTS = { ...READY_COUNTS, 3: PLACE_FEATURES.length + 1 };
const PARTIAL_PAGES = READY_PAGES;

// Opens every layers-panel/print-builder <details> except #qcm-app (QUX-09/N2
// convention, names-keyboard.test.mjs:58-72) AND #qcm-names-suppressed itself:
// this file's own step 1 (setup, per QUX-11.md §4.2) is the trustedClick that
// opens the names list for the first time, and a <details>'s `open` IDL
// property setter toggles the SAME way a real click does (both fire 'toggle',
// main.js:2296's renderNameList(namesOn()) listener) -- pre-opening it here
// and then clicking its summary would flip it straight back closed.
// Map panels open one at a time, so opening Explore or Conditions here would close
// Layers again: on master Layers came first in the page and won, and the dock put
// Explore above it. Skipping the other two panels keeps the same end state.
const openEveryPanel = "(() => { for (const d of document.querySelectorAll('details:not(#qcm-app):not(#qcm-names-suppressed):not(#qc-explore-panel):not(#qc-conditions-panel)')) d.open = true; })()";

let shared = null;
let baseScriptId = null;

async function sharedBrowser() {
  if (!shared) {
    const site = await startSiteServer();
    const page = await launch(CHROMIUM, 'about:blank', {
      viewport: { width: 1280, height: 900 }, args: ['--hide-scrollbars'],
    });
    const { identifier } = await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: patchSource(READY_COUNTS, READY_PAGES),
    });
    baseScriptId = identifier;
    shared = { site, page };
  }
  return shared;
}

after(async () => {
  if (!shared) return;
  shared.page.close();
  await shared.site.close();
});

/** Trusted key dispatch (QUX-11.md §4): CDP routes it to whatever has focus. */
async function trustedKey(page, key, windowsVirtualKeyCode) {
  const base = { key, code: key, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** The two request signals QUX-11.md §4 asks for: this file's in-page
 *  fetch-origin log and the browser's (widened) resource-timing buffer. */
async function requestSnapshot(page) {
  return page.evaluate(`(() => ({
    fetches: window.__qcFetchOrigins ? window.__qcFetchOrigins.length : 0,
    resources: performance.getEntriesByType('resource').length,
  }))()`);
}

function originsSince(all, fromIndex) {
  return [...new Set(all.slice(fromIndex))].sort();
}

/** Resolves once no fetch is in flight and the count has been still for a full
 *  debounce window (settleMs + 500ms); rejects past CEILING. See step 6. */
async function fetchesQuiet(page, what) {
  return page.evaluate(`new Promise((resolve, reject) => {
    const t0 = performance.now(); let last = -1, since = t0;
    (function tick() {
      const n = window.__qcFetchOrigins.length, now = performance.now();
      if (n !== last || window.__qcPending > 0) { last = n; since = now; }
      if (now - since >= ${VIEWPORT_FETCH.settleMs + 500}) return resolve(n);
      if (now - t0 >= ${CEILING}) return reject(new Error(${JSON.stringify(what)} + ': fetches never went quiet'));
      setTimeout(tick, 50);
    })();
  })`);
}

/** Navigates fresh, opens every panel, chooses the example area, turns the
 *  names layer on and presses Check sources, then waits for a placed marker.
 *  `data: true` settles the dashboard's own initial fetches before the first
 *  request snapshot, so a slow background fetch is not read as a change. */
/** The names row opens ON since N3 (layer-presets.js opensOn), so a click on its switch
 *  would turn the lettering OFF. Arm it the way a reader who found it off would. */
async function armNames(page) {
  await page.evaluate(`(() => {
    const cb = document.getElementById('qcm-layer-names');
    if (cb.checked) return;
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}

async function readyNamesLayer(page, site) {
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: true, ms: CEILING });
  await page.evaluate("performance.setResourceTimingBufferSize(10000)");
  await page.evaluate(openEveryPanel);
  await chooseExampleArea(page);
  await armNames(page);
  // #qcm-check sits inside #qcm-app, which openEveryPanel leaves closed (open
  // at >=1024px it floats over the markers), and a closed <details> gives its
  // children no box, so a hit-tested trustedClick reads "covered". Every qcm
  // test drives this button with .click() (Leaflet delegates by target, not
  // coordinates); this file follows that rather than §4.2's literal wording.
  await page.evaluate("document.getElementById('qcm-check').click()");
  await waitInPage(page, 'name markers to render', "document.querySelectorAll('.qcm-name-marker').length > 0", CEILING, null);
}

// This file's copy never waited after the press; keep it that way.
const trustedClick = (page, selector) => pressWhenStill(page, selector, { settleMs: 0 });

test('Places in this view: nothing lost, a row opens the card in place, focus returns, and filters stay separate from the pin/card path', { skip }, async () => {
  const { site, page } = await sharedBrowser();
  await readyNamesLayer(page, site);
  await assertHermetic(page, 'setup');

  // --- Step 1: nothing is lost. ---
  const before1 = await requestSnapshot(page);
  await trustedClick(page, '#qcm-names-suppressed summary');
  // A real (not synthetic) click's native <details> "toggle" event fires on a
  // queued task, not synchronously within the click -- main.js:2296's
  // renderNameList(namesOn()) listener (which builds the <li> rows) can still
  // be pending when the very next evaluate runs. Wait for the rows themselves.
  await waitInPage(page, 'the places list to render after opening it', "document.querySelectorAll('#qcm-names-list li').length === 48", CEILING, null);
  const rowInfo = await page.evaluate("(() => Array.from(document.querySelectorAll('#qcm-names-list li')).map((li) => {"
    + "const spans = li.querySelectorAll('button > span');"
    + "return { name: spans[0] ? spans[0].textContent : '', notLabelled: /not labelled on the map/.test(spans[1] ? spans[1].textContent : '') };"
    + '}))()');
  assert.equal(rowInfo.length, 48, `expected 48 rows (45 places + 2 summits + 1 falls), got ${rowInfo.length}`);
  const placedTitles = await page.evaluate("Array.from(document.querySelectorAll('.qcm-name-marker')).map((el) => el.title)");
  const expectedNotLabelled = ALL_NAMES.filter((n) => !placedTitles.includes(n)).sort();
  const actualNotLabelled = rowInfo.filter((r) => r.notLabelled).map((r) => r.name).sort();
  assert.deepEqual(actualNotLabelled, expectedNotLabelled, 'rows marked "not labelled on the map" should be exactly the fixture names minus every placed marker\'s title');
  const after1 = await requestSnapshot(page);
  assert.deepEqual(after1, before1, 'opening the Places-in-this-view panel should make no request');

  // --- Step 2: a not-labelled row opens the card, in place. ---
  const notLabelledId = await page.evaluate("(() => { const li = Array.from(document.querySelectorAll('#qcm-names-list li'))"
    + ".find((el) => /not labelled on the map/.test(el.querySelector('.qcm-place-row-meta')?.textContent || ''));"
    + "return li ? li.querySelector('button').dataset.placeId : null; })()");
  assert.ok(notLabelledId, 'expected at least one not-labelled row (48 fixtures over the 40-name density cap)');
  const rowName = await page.evaluate(`document.querySelector('.qcm-place-row[data-place-id="${notLabelledId}"] span')?.textContent`);
  const before2 = await page.evaluate("(() => ({ center: [qcMap.getCenter().lat, qcMap.getCenter().lng], zoom: qcMap.getZoom() }))()");
  // qcMap.on(...) returns the Leaflet Map itself (chainable) -- evaluating it
  // as the expression's completion value makes CDP try to structurally clone
  // the whole map object graph ("Object reference chain is too long"). An
  // explicit `return true` keeps the completion value a plain boolean.
  await page.evaluate("(() => { window.__qcMoveCount = 0; qcMap.on('moveend', () => { window.__qcMoveCount++; }); return true; })()");
  const fetchIdxBeforeCard = (await requestSnapshot(page)).fetches;
  await trustedClick(page, `.qcm-place-row[data-place-id="${notLabelledId}"]`);
  await waitInPage(page, 'the name card to open', "Boolean(document.querySelector('.qcm-site-card'))", CEILING, null);
  const cardText = await page.evaluate("document.querySelector('.qcm-site-card')?.textContent ?? ''");
  assert.ok(cardText.includes(rowName), `expected the opened card's first line to name the row (${rowName}), got: ${cardText.slice(0, 80)}`);
  const after2 = await page.evaluate("(() => ({ center: [qcMap.getCenter().lat, qcMap.getCenter().lng], zoom: qcMap.getZoom(), moves: window.__qcMoveCount }))()");
  assert.deepEqual(after2.center, before2.center, 'opening a row\'s card should not move the map');
  assert.equal(after2.zoom, before2.zoom, 'opening a row\'s card should not change zoom');
  assert.equal(after2.moves, 0, 'opening a row\'s card should fire no moveend');
  const origins = (await page.evaluate('window.__qcFetchOrigins')) || [];
  const deltaA = originsSince(origins, fetchIdxBeforeCard);

  // --- Step 3: focus returns. ---
  // identify()'s popupopen handler focuses the card synchronously (confirmed
  // by instrumenting Element.prototype.focus in a probe). But a CDP-synthesized
  // click applies its deferred "focus the mousedown target" AFTER our handler,
  // by which time renderSources() has replaced the row's button node, so focus
  // falls to <body>. A hardware click focuses on mousedown, before click's JS,
  // so this is a dispatch artifact, not an app bug: re-assert focus on the
  // card before Escape, the precondition a real user already has.
  await page.evaluate("document.querySelector('.qcm-site-card')?.focus()");
  await trustedKey(page, 'Escape', 27);
  await waitInPage(page, 'the card to close', "!document.querySelector('.qcm-site-card')", CEILING, null);
  const focusedId = await page.evaluate("document.activeElement && document.activeElement.classList.contains('qcm-place-row') ? document.activeElement.dataset.placeId : null");
  assert.equal(focusedId, notLabelledId, 'Escape should close the popup and return focus to the same row button (data-place-id)');

  // --- Step 4: same requests as a pin. ---
  const fetchIdxBeforePin = (await requestSnapshot(page)).fetches;
  await page.evaluate("document.querySelector('.qcm-name-marker:not(.is-unlabelled)').focus()");
  await trustedKey(page, 'Enter', 13);
  await waitInPage(page, 'the card to open from a placed marker', "Boolean(document.querySelector('.qcm-site-card'))", CEILING, null);
  const originsAfterPin = (await page.evaluate('window.__qcFetchOrigins')) || [];
  const deltaB = originsSince(originsAfterPin, fetchIdxBeforePin);
  assert.ok(deltaA.every((o) => deltaB.includes(o)), `expected the not-labelled row's request origins (${JSON.stringify(deltaA)}) to be a subset of the placed marker's (${JSON.stringify(deltaB)})`);
  await trustedKey(page, 'Escape', 27);
  await waitInPage(page, 'the card to close again', "!document.querySelector('.qcm-site-card')", CEILING, null);

  // --- Step 5: filters are visible and separate. ---
  const before5 = await requestSnapshot(page);
  const qcOverallBefore = await page.evaluate("document.getElementById('qc-overall')?.value ?? null");
  const qcStateBefore = await page.evaluate("document.getElementById('qc-state')?.value ?? null");

  await trustedClick(page, '#qcm-places-only-unlabelled');
  const onlyUnlabelled = await page.evaluate("({ rows: document.querySelectorAll('#qcm-names-list li').length, count: document.getElementById('qcm-places-count')?.textContent ?? '' })");
  const notLabelledCount = expectedNotLabelled.length;
  assert.equal(onlyUnlabelled.rows, notLabelledCount, `"Only places not labelled" should show exactly the ${notLabelledCount} not-labelled rows`);
  assert.match(onlyUnlabelled.count, new RegExp(String(48 - notLabelledCount)), '#qcm-places-count should name the number hidden by the filter');
  // Back to the default group set before narrowing by group -- "three rows
  // remain" (peaks + waterfalls) only holds with onlyNotLabelled off, since
  // the kind-floor rule (name-labels.js) guarantees the three scarce-kind
  // fixtures (2 Summit + 1 Falls) a placement slot ahead of the 45 Populated
  // Place rows, so none of the three is ever itself not-labelled.
  await trustedClick(page, '#qcm-places-only-unlabelled');

  await trustedClick(page, '#qcm-places-filter-groups label:nth-child(5) input');
  const threeRows = await page.evaluate("document.querySelectorAll('#qcm-names-list li').length");
  assert.equal(threeRows, 3, 'unchecking "Towns and places" should leave exactly the 2 Summit + 1 Falls rows');

  const qcOverallMid = await page.evaluate("document.getElementById('qc-overall')?.value ?? null");
  const qcStateMid = await page.evaluate("document.getElementById('qc-state')?.value ?? null");
  assert.equal(qcOverallMid, qcOverallBefore, '#qc-overall should be untouched by the Field Maps filter controls');
  assert.equal(qcStateMid, qcStateBefore, '#qc-state should be untouched by the Field Maps filter controls');

  await trustedClick(page, '#qcm-places-show-all');
  const allRows = await page.evaluate("document.querySelectorAll('#qcm-names-list li').length");
  assert.equal(allRows, 48, 'Show all should restore all 48 rows');

  // Every Layers filter above is done: none of them may have made a request.
  assert.deepEqual(await requestSnapshot(page), before5, 'no Places-in-this-view filter in step 5 should make a request');

  // --- Step 6: held pan. ---
  // A pass fetches for exactly the view it planned against, so any real pan
  // from that view leaves the fetched box. Zoom OUT one level so the pass
  // fetches a larger box, zoom back in (held: no fetch), then pan by half the
  // measured room between the view and that box (its envelope is in the
  // geonames request URLs). All of it runs one level above the setup view:
  // one level out is four times the ground, and at the full map width
  // (QUX-03b-ii gave the old right-hand drawer's 420px back to the map) the
  // view one level out from setup passes VIEWPORT_FETCH.maxAreaKm2, so that
  // pass skips on area and there is no larger box to measure against. A place still selected from step 4 reopens its
  // card, and focusing it makes Leaflet pan the view back (_panOnFocus), so
  // clear the selection first.
  await page.evaluate('qcSelectName(null)');
  const zoomBefore = await page.evaluate('qcMap.getZoom()');
  const zoomTo = (z) => page.evaluate(`(async () => {
    const settled = qcMoves();
    qcMap.setZoom(${z});
    await settled('zoom to settle');
  })()`);
  await zoomTo(zoomBefore + 1);
  await fetchesQuiet(page, 'step-6 base fetch');
  const beforeOut = await requestSnapshot(page);
  await zoomTo(zoomBefore);
  await fetchesQuiet(page, 'zoom-out fetch');
  const afterOut = await requestSnapshot(page);
  assert.ok(afterOut.fetches > beforeOut.fetches, `zooming out should fetch the larger box step 6 measures against (a pass that skips on area has none), fetches ${beforeOut.fetches} -> ${afterOut.fetches}`);
  await zoomTo(zoomBefore + 1);
  await fetchesQuiet(page, 'zoom-in window');
  const before6 = await requestSnapshot(page);
  const room = await page.evaluate(`(() => {
    const urls = window.__qcFetchUrls.filter((u) => /geometry=/.test(u));
    const [w, s, e, n] = decodeURIComponent(urls[urls.length - 1].match(/geometry=([^&]+)/)[1]).split(',').map(Number);
    const sw = qcMap.latLngToContainerPoint([s, w]), ne = qcMap.latLngToContainerPoint([n, e]), size = qcMap.getSize();
    return Math.floor(Math.min(-sw.x, ne.x - size.x, sw.y - size.y, -ne.y));
  })()`);
  assert.ok(room >= 80, `the fetched box should leave at least 80px of room around the view, got ${room}px`);
  const pan = Math.floor(room / 2);
  const moved = await page.evaluate(`(async () => {
    document.activeElement?.blur();
    const x0 = qcMap.getPixelBounds().min.x;
    qcMap.panBy([${pan}, 0]);
    await qcWait('the pan to reach ${pan}px', () => Math.abs(qcMap.getPixelBounds().min.x - x0 - ${pan}) < 1);
    return qcMap.getPixelBounds().min.x - x0;
  })()`);
  assert.ok(Math.abs(moved - pan) < 1, `the map should have panned ${pan}px, moved ${moved}px`);
  await fetchesQuiet(page, 'pan window');
  const after6 = await requestSnapshot(page);
  await assertHermetic(page, 'step 6');
  // Only `fetches` is asserted: Leaflet's <img> tile loads also land in the
  // resource-timing buffer and grow when a pan crosses a tile boundary.
  assert.equal(after6.fetches, before6.fetches, 'a held pan (still inside the fetched viewport) should make no new source-data fetch');

  const inBoundsIds = await page.evaluate(`(() => {
    const b = qcMap.getBounds();
    const pts = ${JSON.stringify(ALL_POINTS)};
    return pts.filter((p) => p.lon >= b.getWest() && p.lon <= b.getEast() && p.lat >= b.getSouth() && p.lat <= b.getNorth()).map((p) => p.id).sort();
  })()`);
  const rowIds = await page.evaluate("Array.from(document.querySelectorAll('#qcm-names-list li button')).map((b) => b.dataset.placeId).sort()");
  assert.deepEqual(rowIds, inBoundsIds, 'after a held pan, the row ids should equal the fixture ids whose points are inside the current bounds');

  // --- Step 5, last part (run after step 6): the unrelated #qc-overall slider. ---
  // #qc-overall lives in the Explore panel (QUX-03b-i), and the map shows one panel
  // at a time, so a reader reaches the slider by opening Explore, which closes Layers
  // in turn. The row and summary reads below are DOM reads and do not need Layers on
  // screen. This runs last because on the desktop dock Explore is wider than Layers:
  // opening it narrows the map, the map re-fits (createMap's ResizeObserver) and the
  // names layer loads the new view, which would leave step 6 no larger box to zoom
  // out to. Let that re-fit settle, then hold the slider to the no-request rule.
  await trustedClick(page, '#qc-explore-panel summary');
  await waitInPage(page, 'the Explore panel to open', "document.getElementById('qc-explore-panel').open", CEILING, null);
  await new Promise((r) => setTimeout(r, VIEWPORT_FETCH.settleMs + 600));
  const beforeSlider = await requestSnapshot(page);
  const rowsBeforeSlider = await page.evaluate("document.querySelectorAll('#qcm-names-list li').length");
  await trustedClick(page, '#qc-overall');
  for (let i = 0; i < 5; i++) await trustedKey(page, 'ArrowRight', 39);
  const qcOverallAfter = await page.evaluate("document.getElementById('qc-overall')?.value ?? null");
  assert.notEqual(qcOverallAfter, qcOverallBefore, '#qc-overall should have changed after 5 ArrowRight presses');
  const rowsAfterArrow = await page.evaluate("document.querySelectorAll('#qcm-names-list li').length");
  const summaryAfterArrow = await page.evaluate("document.querySelector('#qcm-names-suppressed summary')?.textContent ?? ''");
  assert.equal(rowsAfterArrow, rowsBeforeSlider, 'stepping the unrelated #qc-overall slider should not change the Places-in-this-view row count');
  assert.match(summaryAfterArrow, /Places in this view/, 'the Places-in-this-view summary should be unaffected by #qc-overall');

  const after5 = await requestSnapshot(page);
  assert.deepEqual(after5, beforeSlider, 'stepping #qc-overall in step 5 should make no request');
});

test('Places in this view: a partial names answer lists every fixture as not labelled and still lets one be selected', { skip }, async () => {
  const { site, page } = await sharedBrowser();
  // Swap the base 'ready' stub for the 'partial' one (layer 3's count one
  // higher than its page ever delivers), per QUX-11.md §4's identifier/
  // removeScriptToEvaluateOnNewDocument swap pattern, then repeat setup.
  // Capture the swap's own identifier back into baseScriptId (previously
  // discarded here) so a later test in this file can swap again cleanly
  // instead of trying to remove a script CDP has already forgotten.
  await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: baseScriptId });
  const partialScript = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: patchSource(PARTIAL_COUNTS, PARTIAL_PAGES) });
  baseScriptId = partialScript.identifier;

  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: true, ms: CEILING });
  await page.evaluate(openEveryPanel);
  await chooseExampleArea(page);
  await armNames(page);
  await page.evaluate("document.getElementById('qcm-check').click()"); // see readyNamesLayer's comment above
  // "not hidden" alone is satisfied by the pre-fetch NOT_LOADED_MESSAGE too
  // (placesInView's own noRows() report before namesStatus is set), so
  // waiting on that reads the stale notice as settled. Wait for the actual
  // partial text instead.
  await waitInPage(page, 'the names report to carry the partial notice',
    `document.getElementById('qcm-names-report')?.textContent === ${JSON.stringify(STATUS_MESSAGE.partial)}`, CEILING, null);

  const markerCount = await page.evaluate("document.querySelectorAll('.qcm-name-marker').length");
  assert.equal(markerCount, 0, 'a partial answer should draw no .qcm-name-marker at all');

  const reportText = await page.evaluate("document.getElementById('qcm-names-report')?.textContent ?? ''");
  assert.equal(reportText, STATUS_MESSAGE.partial, 'the report should carry the current partial-answer text');
  assert.ok(!reportText.toLowerCase().includes('showing nothing'), 'the partial-answer text should not repeat the old "showing nothing" wording');

  await trustedClick(page, '#qcm-names-suppressed summary');
  // Same queued-task race as step 1 above: wait for the rebuilt rows before
  // reading either the summary or the list.
  await waitInPage(page, 'the places list to render after opening it (partial answer)', "document.querySelectorAll('#qcm-names-list li').length === 48", CEILING, null);
  const summaryText = await page.evaluate("document.querySelector('#qcm-names-suppressed summary')?.textContent ?? ''");
  assert.match(summaryText, /none labelled/, 'the summary should say none are labelled');
  const rowCount = await page.evaluate("document.querySelectorAll('#qcm-names-list li').length");
  assert.equal(rowCount, 48, 'all 48 fixtures should still be listed under a partial answer');

  const firstRowId = await page.evaluate("document.querySelector('#qcm-names-list li button')?.dataset.placeId ?? null");
  assert.ok(firstRowId, 'expected at least one row to select');
  await trustedClick(page, `.qcm-place-row[data-place-id="${firstRowId}"]`);
  await waitInPage(page, 'an unlabelled fallback marker to be drawn', "Boolean(document.querySelector('.qcm-name-marker.is-unlabelled'))", CEILING, null);
  await waitInPage(page, 'its card to open', "Boolean(document.querySelector('.qcm-site-card'))", CEILING, null);
});

// QUX-11.md §4.4. Swaps in a combined stub (geonames READY + FS + BLM) the
// same way the 'partial' test above swaps its own -- capturing the returned
// identifier into baseScriptId so this is a clean remove-then-add, not a
// second script layered on top of one CDP already forgot.
test("Places in this view: a Forest Service trailhead's card states its fee and status, and a GNIS card's Nearby sorts the list by distance", { skip }, async () => {
  const { site, page } = await sharedBrowser();
  await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: baseScriptId });
  const recScript = await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: patchSource(READY_COUNTS, READY_PAGES, { fsFeatures: FS_SITES, blmFeatures: BLM_CAPTURE.features }),
  });
  baseScriptId = recScript.identifier;

  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: true, ms: CEILING });
  await page.evaluate(openEveryPanel);
  await chooseExampleArea(page);
  await armNames(page);
  await trustedClick(page, '#qcm-layer-recSites');
  await trustedClick(page, '#qcm-layer-blmRecSites');
  // See readyNamesLayer's comment above: #qcm-check lives inside the closed
  // #qcm-app <details>, so every existing qcm test drives it with a direct
  // .click() rather than a hit-tested trustedClick.
  await page.evaluate("document.getElementById('qcm-check').click()");
  // Both FS sites and BLM sites draw a `.qcm-site-marker` regardless of
  // whether their point falls in the current bounds (Q/main.js's rec-pin loop
  // is not bounds-filtered, only "Places in this view"'s row list is) -- 3 FS
  // + 3 BLM fixture sites, so this is the one DOM signal that both provider
  // fetches (chained after names in sourcePass, awaited in series) finished.
  await waitInPage(page, 'recreation-site markers to render', "document.querySelectorAll('.qcm-site-marker').length >= 6", CEILING, null);
  await waitInPage(page, 'name markers to render', "document.querySelectorAll('.qcm-name-marker').length > 0", CEILING, null);

  await trustedClick(page, '#qcm-names-suppressed summary');
  // 48 GNIS (same READY_COUNTS/PAGES as the first test above) + 3 in-bounds FS
  // sites (all three FS_SITES sit inside BBOX) + 0 in-bounds BLM sites (the
  // fixture's own real-world coordinates are outside BBOX) = 51.
  await waitInPage(page, 'the places list to render', "document.querySelectorAll('#qcm-names-list li').length === 51", CEILING, null);
  await assertHermetic(page, 'rec-sites setup');

  // --- Scenario 1 (§4.4 item 1): the Trailheads count is 1; its card states
  // the fee line and "not a live check". ---
  const groupLabels = await page.evaluate("Array.from(document.querySelectorAll('#qcm-places-filter-groups label')).map((l) => l.textContent)");
  assert.ok(groupLabels.some((t) => /Trailheads \(1\)/.test(t)), `expected a "Trailheads (1)" group label, got: ${JSON.stringify(groupLabels)}`);

  const trailheadId = await page.evaluate("(() => { const b = Array.from(document.querySelectorAll('#qcm-names-list li button')).find((el) => (el.querySelector('span')?.textContent ?? '') === 'Test Trailhead'); return b ? b.dataset.placeId : null; })()");
  assert.ok(trailheadId, 'expected a "Test Trailhead" row in the places list');
  await trustedClick(page, `.qcm-place-row[data-place-id="${trailheadId}"]`);
  await waitInPage(page, "the trailhead's card to open", "Boolean(document.querySelector('.qcm-site-card'))", CEILING, null);
  const trailheadCardText = await page.evaluate("document.querySelector('.qcm-site-card')?.textContent ?? ''");
  assert.match(trailheadCardText, /Fee: the inventory says no fee is charged\./, `expected the fee line, got: ${trailheadCardText}`);
  assert.match(trailheadCardText, /not a live check/, `expected the "not a live check" status caveat, got: ${trailheadCardText}`);
  // A row click's CDP-synthesized focus restoration races identify()'s own
  // card.focus() (see the "Step 3" comment above, ~line 330): the row button
  // is gone by the time the click's deferred focus default runs, so it falls
  // back to <body>. Re-assert focus on the open card before Escape, same as
  // that precedent.
  await page.evaluate("document.querySelector('.qcm-site-card')?.focus()");
  await trustedKey(page, 'Escape', 27);
  await waitInPage(page, "the trailhead's card to close", "!document.querySelector('.qcm-site-card')", CEILING, null);

  // --- Scenario 2 (§4.4 item 2): a GNIS row's card Nearby action sets
  // nearbyFrom (§2.6 -- it does not itself flip the sort select, only enables
  // and labels the "Nearest to <name>" option: main.js's nameCardActions,
  // above, lists exactly three effects and switching placeFilters.sort is not
  // one of them). Explicitly selecting that option is what "the sort
  // switches" describes -- the same <select>.value + dispatchEvent('change')
  // pattern label-prefs-browser.test.mjs uses, since a native CDP mouse click
  // cannot reliably drive a native <select>'s options in headless Chromium. ---
  const gnisId = await page.evaluate("(() => { const b = Array.from(document.querySelectorAll('#qcm-names-list li button')); const hit = b.find((el) => /^gnis:/.test(el.dataset.placeId || '')); return hit ? hit.dataset.placeId : null; })()");
  assert.ok(gnisId, 'expected at least one GNIS row in the places list');
  const gnisName = await page.evaluate(`document.querySelector('.qcm-place-row[data-place-id="${gnisId}"] span')?.textContent`);
  await trustedClick(page, `.qcm-place-row[data-place-id="${gnisId}"]`);
  await waitInPage(page, "the GNIS row's card to open", "Boolean(document.querySelector('.qcm-site-card'))", CEILING, null);
  // Nearby is always the last action nameCardActions returns (Copy
  // coordinates, Share place, Save place, Nearby -- main.js).
  await trustedClick(page, '.qcm-site-card-actions button:last-child');
  await waitInPage(page, 'the "Nearest to" sort option to become enabled',
    "!document.getElementById('qcm-places-sort-nearby')?.disabled", CEILING, null);
  const nearbyOptionText = await page.evaluate("document.getElementById('qcm-places-sort-nearby')?.textContent ?? ''");
  assert.equal(nearbyOptionText, `Nearest to ${gnisName}`, `expected the "Nearest to <name>" option label, got: ${nearbyOptionText}`);

  const sortSelect = await page.evaluate("(() => { const sel = document.getElementById('qcm-places-sort'); sel.value = 'nearby'; sel.dispatchEvent(new Event('change', { bubbles: true })); return sel.value; })()");
  assert.equal(sortSelect, 'nearby', 'expected the sort <select> to accept the "nearby" value');
  await waitInPage(page, 'the caption to carry the Straight-line distance text',
    "(document.getElementById('qcm-places-nearby-caption')?.textContent ?? '').indexOf('Straight-line') !== -1", CEILING, null);
  const caption = await page.evaluate("document.getElementById('qcm-places-nearby-caption')?.textContent ?? ''");
  assert.match(caption, /^Straight-line distance from /, `expected the caption to lead with "Straight-line", got: ${caption}`);
  assert.ok(caption.includes(gnisName), `expected the caption to name ${JSON.stringify(gnisName)}, got: ${caption}`);

  const rowDistances = await page.evaluate("Array.from(document.querySelectorAll('#qcm-names-list li button .qcm-place-row-meta')).map((el) => el.textContent)");
  const distanceValues = rowDistances.map((t) => {
    const m = t.match(/— (?:less than 0\.1|(\d+(?:\.\d+)?)) mi$/);
    return m ? (m[1] ? Number(m[1]) : 0) : null;
  });
  assert.ok(distanceValues.every((d) => d !== null), `expected every row to carry a distance, got: ${JSON.stringify(rowDistances)}`);
  const sorted = distanceValues.every((d, i) => i === 0 || distanceValues[i - 1] <= d);
  assert.ok(sorted, `expected rows ordered by computed distance, got: ${JSON.stringify(distanceValues)}`);
});
