// N2 end-to-end proof, on the real built Field Maps app (/quiet-corners/):
// a GNIS "Named places & landmarks" feature that shares a name and state with
// one of the dashboard's own town/nav orientation labels (quiet-corners.js
// renderPlaceLabels) is not lettered a second time. Same DevTools-protocol
// harness as names-keyboard.test.mjs -- window.fetch is patched before the
// page's own script runs, so no real network request ever leaves the box.
//
// Unlike names-keyboard.test.mjs, this file also patches candidates.json and
// navigation-places.json (real ones would carry unrelated real towns inside
// EXAMPLE_AREA's bbox, which would not break the assertions below but would
// make the fixture depend on live pipeline data instead of a fixed one).
//
// Exercises the REAL wiring end to end -- window.qcTownLabels is read only
// because quiet-corners.js's renderPlaceLabels published it, and the GNIS
// layer redraws only because it reacted to the real 'qc:town-labels-changed'
// event (Q/main.js). Nothing here sets window.qcTownLabels by hand.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { waitInPage, readyDashboard, chooseExampleArea } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const CEILING = 20000;

// app-state.js EXAMPLE_AREA: { minLon: -83.55, minLat: 35.0, maxLon: -83.4, maxLat: 35.1 }.
// Positions below are chosen as fractions of that bbox so they stay correct if
// the bbox is ever retuned, rather than as bare coordinates that would need
// updating in lockstep.
const BBOX = { minLon: -83.55, minLat: 35.0, maxLon: -83.4, maxLat: 35.1 };
const lerpLon = (f) => BBOX.minLon + (BBOX.maxLon - BBOX.minLon) * f;
const lerpLat = (f) => BBOX.minLat + (BBOX.maxLat - BBOX.minLat) * f;

// The dashboard's own town label (candidates.json) and its GNIS twin do NOT
// need to sit at the same point -- the dedupe key is name+state, never
// distance -- so the candidate is placed near the bbox's west edge
// (deliberately close, to fall out of view first on an eastward pan below)
// while the matching GNIS feature sits at the bbox's centre.
const CANDIDATE_LON = lerpLon(0.02);
const CANDIDATE_LAT = lerpLat(0.5);
const GNIS_ASHLAND_LON = lerpLon(0.5);
const GNIS_ASHLAND_LAT = lerpLat(0.5);
const GNIS_CONTROL_LON = lerpLon(0.85);
const GNIS_CONTROL_LAT = lerpLat(0.2);

// candidates.json's raw Census name ("Ashland town") is what N2's normalizer
// (stripCensusSuffix, Q/name-labels.js) has to strip before it matches GNIS's
// bare "Ashland" -- carrying every field the real export carries (schema
// confirmed against static/data/quiet-corners/candidates.json) so nothing
// else that reads candidatesData (the table, the finder) trips on a missing
// field.
const CANDIDATES_FIXTURE = [{
  fips: '9999001', name: 'Ashland town', state: 'NC', county_fips: '37999',
  population: 500, lat: CANDIDATE_LAT, lon: CANDIDATE_LON, county_name: 'Test County',
  stability_score: 80, distance_to_metro_mi: 40, nearest_metro: 'Test City',
  sprawl_risk: 10, affordability_score: 85, quietness_score: 90, overall_score: 88,
}];

const GNIS_FEATURES = [
  {
    attributes: {
      gaz_id: 920001, gaz_name: 'Ashland', gaz_featureclass: 'Populated Place',
      state_alpha: 'NC', county_name: 'Test County',
    },
    geometry: { points: [[GNIS_ASHLAND_LON, GNIS_ASHLAND_LAT]] },
  },
  {
    attributes: {
      gaz_id: 920002, gaz_name: 'Test Place Control', gaz_featureclass: 'Populated Place',
      state_alpha: 'NC', county_name: 'Test County',
    },
    geometry: { points: [[GNIS_CONTROL_LON, GNIS_CONTROL_LAT]] },
  },
];

// fetchBounded (source-terrain-names.js) counts layers 3/5/6/7 first, then
// pages each one unconditionally -- same contract names-keyboard.test.mjs's
// fixture documents.
const COUNTS = { 3: GNIS_FEATURES.length, 5: 0, 6: 0, 7: 0 };
const PAGES = { 3: GNIS_FEATURES, 5: [], 6: [], 7: [] };

const patchSource = `(() => {
  const counts = ${JSON.stringify(COUNTS)};
  const pages = ${JSON.stringify(PAGES)};
  const candidates = ${JSON.stringify(CANDIDATES_FIXTURE)};
  const real = window.fetch.bind(window);
  window.fetch = function(input, init) {
    const url = String(input && input.url ? input.url : input);
    // The NHD river tier is answered empty: these proofs are hermetic and about the GNIS names.
    if (/nhd\\/MapServer\\/\\d+\\/query/.test(url)) return Promise.resolve(new Response(JSON.stringify({ features: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const gnis = url.match(/geonames\\/MapServer\\/(\\d+)\\/query/);
    if (gnis) {
      const isCount = /returnCountOnly=true/.test(url);
      const body = isCount ? { count: counts[gnis[1]] ?? 0 } : { features: pages[gnis[1]] ?? [] };
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    }
    if (url.endsWith('/data/quiet-corners/candidates.json')) {
      return Promise.resolve(new Response(JSON.stringify(candidates), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    }
    if (url.endsWith('/data/quiet-corners/navigation-places.json')) {
      // Empty on purpose: a real major/regional place landing inside this tiny
      // fixture bbox would be an incidental collision this proof does not need.
      return Promise.resolve(new Response('[]', {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    }
    return real(input, init);
  };
})()`;

let shared = null;

async function sharedBrowser() {
  if (!shared) {
    const site = await startSiteServer();
    const page = await launch(CHROMIUM, 'about:blank', { viewport: { width: 1280, height: 900 } });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: patchSource });
    shared = { site, page };
  }
  return shared;
}

after(async () => {
  if (!shared) return;
  shared.page.close();
  await shared.site.close();
});

test('town label dedupe: a GNIS place matching a drawn town label is skipped; a non-matching one still draws', { skip }, async () => {
  const { site, page } = await sharedBrowser();
  await page.navigate(`${site.origin}/quiet-corners/`);
  // data: true -- candidatesData has to be in memory (loadCandidates, quiet-
  // corners.js:317-343) before chooseExampleArea's moveend runs
  // renderPlaceLabels, or "Ashland town" would not exist yet to be drawn.
  await readyDashboard(page, { data: true, ms: CEILING });
  await chooseExampleArea(page);

  // The writer (quiet-corners.js publishTownLabels, :1942-1945): the town
  // label the dashboard actually drew this pass reached window.qcTownLabels
  // on its own, through the real renderPlaceLabels -> publishTownLabels path
  // triggered by chooseExampleArea's moveend/zoomend -- nothing here sets it.
  const townLabels = await page.evaluate('window.qcTownLabels');
  assert.ok(Array.isArray(townLabels) && townLabels.some((t) => t.name === 'Ashland town' && t.state === 'NC'),
    `expected window.qcTownLabels to carry the drawn "Ashland town"/NC label, got: ${JSON.stringify(townLabels)}`);

  // Turn the GNIS layer on and fetch (readyNamesLayer's own sequence, names-
  // keyboard.test.mjs).
  await page.evaluate(`(() => {
    const cb = document.getElementById('qcm-layer-names');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await page.evaluate("document.getElementById('qcm-check').click()");
  await waitInPage(page, 'name markers to render', "document.querySelectorAll('.qcm-name-marker').length > 0", CEILING, null);

  const namesNow = await page.evaluate(
    "Array.from(document.querySelectorAll('.qcm-name-marker')).map((el) => el.getAttribute('aria-label'))",
  );
  assert.ok(!namesNow.includes('Ashland'),
    `the GNIS "Ashland"/NC feature shares name+state with the drawn "Ashland town"/NC label and should be deduped out, got markers: ${JSON.stringify(namesNow)}`);
  assert.ok(namesNow.includes('Test Place Control'),
    `the non-matching control feature should still draw, got markers: ${JSON.stringify(namesNow)}`);

  // The suppressed-names list (renderNameList) is built from the SAME deduped
  // set (main.js :1624-1626) -- the deduped-out feature should not resurface
  // there either.
  const suppressedText = await page.evaluate("document.getElementById('qcm-names-list').textContent");
  assert.ok(!/\bAshland\b/.test(suppressedText),
    `a deduped-out GNIS feature should not appear in the crowded-out list either, got: ${suppressedText}`);

  // --- Ordering (item 4): pan so the town label falls out of view, with no
  // zoom change at all, and confirm the GNIS layer re-syncs synchronously ---
  //
  // main.js binds renderOverlay/renderNames only to 'zoomend' (:268), never
  // plain 'moveend' -- so without the 'qc:town-labels-changed' listener
  // (:278-280, fired from quiet-corners.js's own moveend/zoomend handler,
  // Q/quiet-corners.js:672) this redraw would not happen from a pan alone,
  // and the just-freed "Ashland" GNIS feature would stay hidden on a stale
  // town-label list until the next zoom. The whole pan + read happens inside
  // one evaluate() so nothing here waits on VIEWPORT_FETCH's 600ms viewport-
  // refetch debounce (app-state.js VIEWPORT_FETCH.settleMs) -- what is read
  // back is the effect of the synchronous moveend -> publishTownLabels ->
  // dispatch -> listener -> renderNames chain, and nothing else.
  const afterPan = await page.evaluate(`(() => {
    const map = window.qcMap;
    const before = map.getBounds();
    const stillHasCandidate = before.contains([${CANDIDATE_LAT}, ${CANDIDATE_LON}]);
    const stillHasGnisAshland = before.contains([${GNIS_ASHLAND_LAT}, ${GNIS_ASHLAND_LON}]);
    const shiftLon = (before.getEast() - before.getWest()) * 0.4;
    map.setView([${GNIS_ASHLAND_LAT}, before.getCenter().lng + shiftLon], map.getZoom(), { animate: false });
    const after = map.getBounds();
    return {
      preconditionsHeld: stillHasCandidate && stillHasGnisAshland,
      candidateNowOutOfView: !after.contains([${CANDIDATE_LAT}, ${CANDIDATE_LON}]),
      gnisAshlandStillInView: after.contains([${GNIS_ASHLAND_LAT}, ${GNIS_ASHLAND_LON}]),
      gnisControlStillInView: after.contains([${GNIS_CONTROL_LAT}, ${GNIS_CONTROL_LON}]),
      townLabels: window.qcTownLabels,
      names: Array.from(document.querySelectorAll('.qcm-name-marker')).map((el) => el.getAttribute('aria-label')),
    };
  })()`);

  assert.ok(afterPan.preconditionsHeld, 'the candidate and the GNIS "Ashland" feature should both start inside the initial view');
  assert.ok(afterPan.candidateNowOutOfView, 'the pan should move the "Ashland town" candidate out of map.getBounds()');
  assert.ok(afterPan.gnisAshlandStillInView, 'the pan should leave the GNIS "Ashland" feature (bbox centre) on screen');
  assert.ok(afterPan.gnisControlStillInView, 'the pan should leave the control feature on screen throughout');
  assert.ok(!afterPan.townLabels.some((t) => t.name === 'Ashland town'),
    `panning "Ashland town" out of view should drop it from window.qcTownLabels, got: ${JSON.stringify(afterPan.townLabels)}`);
  assert.ok(afterPan.names.includes('Ashland'),
    `with the town label gone, the GNIS "Ashland" feature should now draw (proves the redraw reacted to the fresh list, not a stale one), got markers: ${JSON.stringify(afterPan.names)}`);
});

// A searched-for name (window.qcSelectName, the "Search names" finder's bridge) that the
// GNIS layer did not place, so drawSelectedSearchFeature draws its own marker for it.
const SEARCH_HIT = { id: 'gnis:930001', name: 'Test Search Summit', kind: 'summit', county: 'Test County', state: 'NC', anchor: [lerpLat(0.6), lerpLon(0.6)] };
// The layer's own "Ashland", searched for while the town label dedupes it off the layer: the
// declutter loop does not place it, so renderNames draws the selected name's fallback marker.
const ASHLAND_HIT = { id: 'gnis:920001', name: 'Ashland', kind: 'place', county: 'Test County', state: 'NC', anchor: [GNIS_ASHLAND_LAT, GNIS_ASHLAND_LON] };

test('a searched-for name has one marker, unplaced or not, and a pan redraws the names without adding a second marker for any of them', { skip }, async () => {
  const { site, page } = await sharedBrowser();
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: true, ms: CEILING });
  await chooseExampleArea(page);
  await page.evaluate(`(() => {
    const cb = document.getElementById('qcm-layer-names');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await page.evaluate("document.getElementById('qcm-check').click()");
  await waitInPage(page, 'name markers to render', "document.querySelectorAll('.qcm-name-marker').length > 0", CEILING, null);
  await page.evaluate(`window.qcSelectName(${JSON.stringify(SEARCH_HIT)}); void 0;`);
  await waitInPage(page, "the searched-for name's card to open",
    `document.querySelector('.leaflet-popup-pane .qcm-site-card') && document.querySelector('.leaflet-popup-pane .qcm-site-card').textContent.indexOf(${JSON.stringify(SEARCH_HIT.name)}) !== -1`, CEILING, null);

  // Each pan's moveend republishes the town labels, and 'qc:town-labels-changed' redraws the
  // names (the test above). Three pans and the read happen inside one evaluate(), so what is
  // read back is that synchronous redraw alone, before VIEWPORT_FETCH's debounced refetch
  // (app-state.js) redraws the whole overlay and would hide a leftover marker.
  const read = (title) => `(() => {
    const count = (labels) => labels.reduce((m, l) => { m[l] = (m[l] || 0) + 1; return m; }, {});
    return {
      names: count(Array.from(document.querySelectorAll('.qcm-name-marker')).map((el) => el.getAttribute('aria-label'))),
      searched: document.querySelectorAll(${JSON.stringify(`.leaflet-marker-pane [title="${title}"]`)}).length,
      // A closed popup fades out for 200 ms (Leaflet's fadeAnimation) at opacity 0 before it leaves the page.
      popups: Array.from(document.querySelectorAll('.leaflet-popup')).filter((el) => el.style.opacity !== '0').length,
    };
  })()`;
  // Westward, so the "Ashland town" label near the area's west edge stays in view for the
  // second half below.
  const pan3 = (title) => `(() => {
    for (let i = 0; i < 3; i += 1) window.qcMap.panBy([-40, 0], { animate: false });
    return ${read(title)};
  })()`;
  const before = await page.evaluate(read(SEARCH_HIT.name));
  const afterPans = await page.evaluate(pan3(SEARCH_HIT.name));

  assert.equal(before.searched, 1, `the searched-for name starts with one marker: ${JSON.stringify(before)}`);
  assert.ok(Object.keys(before.names).length > 0 && Object.values(before.names).every((n) => n === 1),
    `each placed name starts with one marker: ${JSON.stringify(before.names)}`);
  assert.equal(afterPans.searched, 1, `three pans left ${afterPans.searched} markers for the searched-for name`);
  assert.ok(Object.keys(afterPans.names).length > 0 && Object.values(afterPans.names).every((n) => n === 1),
    `three pans should leave each placed name with one marker: ${JSON.stringify(afterPans.names)}`);
  assert.equal(afterPans.popups, 1, 'one card stays open');

  await page.evaluate(`window.qcSelectName(${JSON.stringify(ASHLAND_HIT)}); void 0;`);
  await waitInPage(page, "Ashland's card to open",
    `document.querySelector('.leaflet-popup-pane .qcm-site-card') && /Ashland/.test(document.querySelector('.leaflet-popup-pane .qcm-site-card').textContent)`, CEILING, null);
  const ashland = await page.evaluate(read(ASHLAND_HIT.name));
  const ashlandAfterPans = await page.evaluate(pan3(ASHLAND_HIT.name));
  assert.ok(await page.evaluate("window.qcTownLabels.some((t) => t.name === 'Ashland town')"),
    'the "Ashland town" label stays in view, so the layer still leaves its own "Ashland" unplaced');
  assert.equal(ashland.searched, 1, `a searched-for name the layer left unplaced has one marker: ${JSON.stringify(ashland)}`);
  assert.equal(ashlandAfterPans.searched, 1, `three pans left ${ashlandAfterPans.searched} markers for Ashland`);
  assert.equal(ashlandAfterPans.popups, 1, "one card stays open, Ashland's");
});

// A redraw draws the searched-for name's marker again, and used to open its card again
// every time: a reader who closed it got it back on the next pan or zoom, along with a
// fresh elevation request. Closed stays closed until the reader opens it again.
test("a searched-for name's card the reader closes stays closed through pans and a zoom; its marker stays and opens it again", { skip }, async () => {
  const { site, page } = await sharedBrowser();
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: true, ms: CEILING });
  await chooseExampleArea(page);
  await page.evaluate(`window.qcSelectName(${JSON.stringify(SEARCH_HIT)}); void 0;`);
  await waitInPage(page, "the searched-for name's card to open",
    `document.querySelector('.leaflet-popup-pane .qcm-site-card') && document.querySelector('.leaflet-popup-pane .qcm-site-card').textContent.indexOf(${JSON.stringify(SEARCH_HIT.name)}) !== -1`, CEILING, null);

  const marker = `.leaflet-marker-pane [title="${SEARCH_HIT.name}"]`;
  // Open cards only: a closed popup fades out for 200 ms at opacity 0 before it leaves the page.
  const read = `({
    popups: Array.from(document.querySelectorAll('.leaflet-popup')).filter((el) => el.style.opacity !== '0').length,
    markers: document.querySelectorAll(${JSON.stringify(marker)}).length,
  })`;
  // Three pans redraw the names through 'qc:town-labels-changed'; the zoom redraws the whole
  // overlay (zoomend). Both run inside one evaluate(), so each redraw is read back on its own,
  // before VIEWPORT_FETCH's debounced refetch.
  const moveAndRead = `(() => {
    for (let i = 0; i < 3; i += 1) window.qcMap.panBy([-40, 0], { animate: false });
    const panned = ${read};
    window.qcMap.setZoom(window.qcMap.getZoom() - 1, { animate: false });
    return { panned, zoomed: ${read} };
  })()`;

  await page.evaluate("document.querySelector('.leaflet-popup-close-button').click()");
  const closed = await page.evaluate(read);
  assert.deepEqual(closed, { popups: 0, markers: 1 }, 'the close button closes the card and leaves its marker');
  const moved = await page.evaluate(moveAndRead);
  assert.deepEqual(moved.panned, { popups: 0, markers: 1 }, `three pans reopened the closed card: ${JSON.stringify(moved)}`);
  assert.deepEqual(moved.zoomed, { popups: 0, markers: 1 }, `a zoom reopened the closed card: ${JSON.stringify(moved)}`);

  // The marker still opens it, and once open again it stays open through the same moves.
  await page.evaluate(`document.querySelector(${JSON.stringify(marker)}).click()`);
  await waitInPage(page, 'the marker to open the card again',
    `document.querySelector('.leaflet-popup-pane .qcm-site-card') && document.querySelector('.leaflet-popup-pane .qcm-site-card').textContent.indexOf(${JSON.stringify(SEARCH_HIT.name)}) !== -1`, CEILING, null);
  const reopened = await page.evaluate(moveAndRead);
  assert.deepEqual(reopened.panned, { popups: 1, markers: 1 }, `an open card stays open through three pans: ${JSON.stringify(reopened)}`);
  assert.deepEqual(reopened.zoomed, { popups: 1, markers: 1 }, `an open card stays open through a zoom: ${JSON.stringify(reopened)}`);
});

// The same for a name the layer itself placed: clicking its marker selects it, and the
// redraws that follow reopened its card the same way.
test("a placed name's card the reader closes stays closed through pans and a zoom", { skip }, async () => {
  const { site, page } = await sharedBrowser();
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: true, ms: CEILING });
  await chooseExampleArea(page);
  await page.evaluate(`(() => {
    const cb = document.getElementById('qcm-layer-names');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await page.evaluate("document.getElementById('qcm-check').click()");
  const marker = '.leaflet-marker-pane [title="Test Place Control"]';
  await waitInPage(page, 'the control name to render', `!!document.querySelector(${JSON.stringify(marker)})`, CEILING, null);
  await page.evaluate(`document.querySelector(${JSON.stringify(marker)}).click()`);
  await waitInPage(page, "the control name's card to open",
    "document.querySelector('.leaflet-popup-pane .qcm-site-card') && /Test Place Control/.test(document.querySelector('.leaflet-popup-pane .qcm-site-card').textContent)", CEILING, null);

  const read = `({
    popups: Array.from(document.querySelectorAll('.leaflet-popup')).filter((el) => el.style.opacity !== '0').length,
    markers: document.querySelectorAll(${JSON.stringify(marker)}).length,
  })`;
  const moveAndRead = `(() => {
    for (let i = 0; i < 3; i += 1) window.qcMap.panBy([-40, 0], { animate: false });
    const panned = ${read};
    window.qcMap.setZoom(window.qcMap.getZoom() - 1, { animate: false });
    return { panned, zoomed: ${read} };
  })()`;
  const open = await page.evaluate(moveAndRead);
  assert.deepEqual(open.panned, { popups: 1, markers: 1 }, `an open card stays open through three pans: ${JSON.stringify(open)}`);
  assert.deepEqual(open.zoomed, { popups: 1, markers: 1 }, `an open card stays open through a zoom: ${JSON.stringify(open)}`);

  // The moves just redrew the card, so the cards they replaced may still be fading out in the
  // page: close the one that is showing.
  await page.evaluate(`Array.from(document.querySelectorAll('.leaflet-popup'))
    .find((el) => el.style.opacity !== '0').querySelector('.leaflet-popup-close-button').click()`);
  assert.deepEqual(await page.evaluate(read), { popups: 0, markers: 1 }, 'the close button closes the card and leaves its marker');
  const moved = await page.evaluate(moveAndRead);
  assert.deepEqual(moved.panned, { popups: 0, markers: 1 }, `three pans reopened the closed card: ${JSON.stringify(moved)}`);
  assert.deepEqual(moved.zoomed, { popups: 0, markers: 1 }, `a zoom reopened the closed card: ${JSON.stringify(moved)}`);
});
