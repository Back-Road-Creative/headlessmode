// QUX-09b browser proof (.data/plans/2026-09-27-qux-specs/QUX-09.md §4.4):
// "Before you go" on a selected place's card and on a saved-places row, with
// api.weather.gov answered in-page from the committed fixtures -- zero real
// network ever reaches the National Weather Service. One shared browser, one
// navigation, so `picked` (quiet-corners.js) carries state from step to step
// the way a reader's own session would. Harness copied from
// saved-places-browser.test.mjs: patchSource/sharedBrowser/readyNamesLayer, and
// the seeded-saved-place idiom 5c6a9451 used. The click is helpers/trusted-click.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findChromium, launch } from './helpers/browser.mjs';
import { trustedClick as pressWhenStill } from './helpers/trusted-click.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { waitInPage, readyDashboard, chooseExampleArea } from './helpers/waits.mjs';
import { PLACE_FEATURES } from './fixtures/gnis-names-declutter.mjs';
import { NO_ZONE_NOTE, NO_FORECAST_NOTE } from '../../themes/headlessmode/static/js/quiet-corners-sky/sky-cards.js';
import { QUIET_TEXT, FAILED_TEXT } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-nws-alerts.js';
import { d05Stub, pageSnapshotAnswer } from './helpers/camera-snapshot-stub.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const CEILING = 20000;
const SAVED_KEY = 'qc-saved-places';
const SAVED_KEY_JSON = JSON.stringify(SAVED_KEY);
const SEEDED_NAME = 'Test Saved Place';

// fetchBounded pages layers 3/5/6/7 unconditionally; only layer 3 (Populated
// Places) carries fixtures here, matching saved-places-browser.test.mjs.
const COUNTS = { 3: PLACE_FEATURES.length, 5: 0, 6: 0, 7: 0 };
const PAGES = { 3: PLACE_FEATURES, 5: [], 6: [], 7: [] };

const NWS_API = JSON.parse(readFileSync(new URL('fixtures/nws-api-2026-09-10.min.json', import.meta.url), 'utf8'));
const NWS_GRID = JSON.parse(readFileSync(new URL('fixtures/nws-grid-2026-09-11.min.json', import.meta.url), 'utf8'));
const NWS_ALERTS = JSON.parse(readFileSync(new URL('fixtures/nws-alerts-2026-09-14.min.json', import.meta.url), 'utf8'));
// QUX-09c: the committed Caltrans D05 catalogue, answered in-page like the NWS fixtures.
const VIEW_SALINAS = 'window.qcMap.setView([36.65, -121.7], 9, { animate: false }); ';
const STUB = d05Stub(JSON.parse(readFileSync(new URL('fixtures/caltrans-cctv-d05-2026-09-27.min.json', import.meta.url), 'utf8')));

/** Patches fetch (geonames stub, same as saved-places-browser.test.mjs) and
 *  answers every api.weather.gov URL from the three committed fixtures by
 *  its URL shape -- points, then hourly, then gridpoints, then alerts.
 *  `window.__qcStubMode` toggles a uniform 1500 ms-then-503 outage on every
 *  api.weather.gov URL, the same way a real NWS outage would fail all three
 *  asks together. Also seeds one saved place, so test 5 needs no Save UI. */
function patchSource() {
  return `(() => {
    performance.setResourceTimingBufferSize(10000);
    localStorage.setItem(${SAVED_KEY_JSON}, JSON.stringify({
      schemaVersion: 1,
      places: [{ ref: 'gnis:999999', name: ${JSON.stringify(SEEDED_NAME)}, kind: 'place', lat: 35.05, lon: -83.47, state: 'NC', county: 'Test County' }],
    }));
    const counts = ${JSON.stringify(COUNTS)};
    const pages = ${JSON.stringify(PAGES)};
    const NWS_API = ${JSON.stringify(NWS_API)};
    const NWS_GRID = ${JSON.stringify(NWS_GRID)};
    const NWS_ALERTS = ${JSON.stringify(NWS_ALERTS)};
    window.__qcFetchLog = [];
    window.__qcStubMode = 'ok';
    const realFetch = window.fetch.bind(window);
    const jsonResponse = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), {
      status, headers: { 'content-type': status === 200 ? 'application/geo+json' : 'application/problem+json' },
    }));
    const nwsAnswer = (url) => {
      if (url.indexOf('/points/') !== -1) return jsonResponse(NWS_API.point);
      if (url.indexOf('/forecast/hourly') !== -1) return jsonResponse(NWS_API.hourly);
      if (url.indexOf('/gridpoints/') !== -1) return jsonResponse(NWS_GRID);
      if (url.indexOf('/alerts/active') !== -1) return jsonResponse(NWS_ALERTS.active);
      return jsonResponse({}, 404);
    };
    ${pageSnapshotAnswer(STUB)}
    window.fetch = function(input, init) {
      const url = String(input && input.url ? input.url : input);
      // The NHD river tier is answered empty: these proofs are hermetic and about the GNIS names.
      if (/nhd\\/MapServer\\/\\d+\\/query/.test(url)) return Promise.resolve(new Response(JSON.stringify({ features: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
      const snapshot = window.__qcSnapshotAnswer(url);
      if (snapshot) return Promise.resolve(snapshot);
      const m = url.match(/geonames\\/MapServer\\/(\\d+)\\/query/);
      if (m) {
        const isCount = /returnCountOnly=true/.test(url);
        const body = isCount ? { count: counts[m[1]] ?? 0 } : { features: pages[m[1]] ?? [] };
        return Promise.resolve(new Response(JSON.stringify(body), {
          status: 200, headers: { 'content-type': 'application/json' },
        }));
      }
      if (url.indexOf('https://api.weather.gov/') === 0) {
        window.__qcFetchLog.push(url);
        if (window.__qcStubMode === 'fail') {
          const signal = init && init.signal;
          return new Promise((resolve, reject) => {
            const t = setTimeout(() => resolve(new Response(JSON.stringify({ title: 'Service unavailable', detail: 'stubbed outage' }),
              { status: 503, headers: { 'content-type': 'application/problem+json' } })), 1500);
            if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('The operation was aborted.', 'AbortError')); });
          });
        }
        return nwsAnswer(url);
      }
      return realFetch(input, init);
    };
  })()`;
}

const openEveryPanel = "(() => { for (const d of document.querySelectorAll('details:not(#qcm-app)')) d.open = true; })()";

let shared = null;
async function sharedBrowser() {
  if (!shared) {
    const site = await startSiteServer();
    const page = await launch(CHROMIUM, 'about:blank', {
      viewport: { width: 1280, height: 900 }, args: ['--hide-scrollbars'],
    });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: patchSource() });
    shared = { site, page };
  }
  return shared;
}

after(async () => {
  if (!shared) return;
  shared.page.close();
  await shared.site.close();
});

/** Turns Named places on, waits for a placed marker (names-keyboard.test.mjs's setup). */
async function readyNamesLayer(page) {
  await page.evaluate(openEveryPanel);
  await chooseExampleArea(page);
  await page.evaluate(`(() => {
    const cb = document.getElementById('qcm-layer-names');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await page.evaluate("document.getElementById('qcm-check').click()");
  await waitInPage(page, 'name markers to render', "document.querySelectorAll('.qcm-name-marker').length > 0", CEILING, null);
}

/** Opens the first placed marker's card, waits for its five actions (05c/09a's
 *  three, QUX-09b's "Before you go" fourth, then QUX-11b's Nearby last). */
async function openFirstNameCard(page) {
  await trustedClick(page, '.qcm-name-marker');
  await waitInPage(page, 'the name card to open with its five actions',
    "document.querySelectorAll('.qcm-site-card-action').length === 5", CEILING, null);
}

/** Test 1's county pick (flyToCounty, quiet-corners.js) flies the SAME shared
 *  Leaflet map (window.qcMap, main.js:194) that the names layer draws on, off
 *  the example area readyNamesLayer populated markers for. main.js's own
 *  `map.on('moveend', () => renderNameList(namesOn()))` redraws them once the
 *  view is back -- re-centring is enough, no re-check of the layer needed. */
async function regroundNamesLayer(page) {
  await chooseExampleArea(page);
  await waitInPage(page, 'name markers to render again after re-centring on the example area',
    "document.querySelectorAll('.qcm-name-marker').length > 0", CEILING, null);
}

let page, site, countyName, cardName, preOrigins;

before(async () => {
  if (skip) return;
  ({ site, page } = await sharedBrowser());
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { ms: CEILING });
  await readyNamesLayer(page);
  await waitInPage(page, 'the county table to have at least one row', "document.querySelectorAll('.qc-row[data-fips]').length > 0", CEILING, null);
  // Recorded once initial page scaffolding (site assets, base tiles, the
  // geonames stub already exercised by readyNamesLayer) is done and before
  // any scenario step -- so origins check 4 below measures only what steps
  // 1-3 themselves reach, never the page's own one-time setup cost.
  preOrigins = await page.evaluate(`Array.from(new Set([
    ...performance.getEntriesByType('resource').map((e) => new URL(e.name).origin),
    ...window.__qcFetchLog.map((u) => new URL(u).origin),
  ]))`);
});

/** helpers/trusted-click.mjs's press, then proof it landed. Where the press, release
 *  and click actually go is recorded, and a click that never reaches its target fails
 *  here naming where it went instead of as a later 'never came true'. This file's
 *  copy never waited after the press; keep it that way.
 *
 *  A still target can still move after the last read: under 2x parallel load the site
 *  card's unstubbed elevation caveat landed between the read and the press, pushed
 *  Before you go 134px down, and the click hit the caveat paragraph. A click that fell
 *  on nothing interactive changed nothing, so it is pressed again from a fresh read
 *  (up to 3 presses); one that fell on another control fails at once, naming it. */
// tabindex="-1" only makes an element a focus target (the page's own <main> is one), not a control.
const INTERACTIVE = 'a, button, input, select, textarea, summary, label, [role="button"], [tabindex]:not([tabindex="-1"]), .leaflet-interactive';
/** In the page: the control a press on `el` works, or null when it fell on nothing interactive.
 *  A control that contains the target is the target's own container, not a neighbour, and is
 *  passed over: Leaflet makes #qc-map focusable and the site card is a popup inside it. */
const CONTROL_AT = `((el, target) => {
  let c = el && el.closest ? el.closest(${JSON.stringify(INTERACTIVE)}) : null;
  while (c && target && c.contains(target)) c = c.parentElement && c.parentElement.closest(${JSON.stringify(INTERACTIVE)});
  return c; })`;
async function trustedClick(page, selector) {
  let pressed = null, seen = null;
  for (let press = 0; press < 3; press++) {
    await page.evaluate(`(() => { const log = window.__qcClickLog = [];
      const name = (el) => el && el.nodeType === 1 ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '') : String(el);
      for (const t of ['mousedown', 'mouseup', 'click']) document.addEventListener(t, (e) => {
        log.push({ t, target: name(e.target), hit: Boolean(e.target.closest && e.target.closest(${JSON.stringify(selector)})),
          inert: !${CONTROL_AT}(e.target, document.querySelector(${JSON.stringify(selector)})), x: e.clientX, y: e.clientY, scrollY });
      }, { capture: true, once: true }); })()`);
    // A press on the bare map is also read as inert, and it closes the card: the next press
    // then finds no target, so its error carries where the press before it went.
    try { pressed = await pressWhenStill(page, selector, { settleMs: 0 }); }
    catch (err) { if (seen) err.message += `; the press before it: ${seen}`; throw err; }
    const landed = "(window.__qcClickLog || []).some((e) => e.t === 'click' && e.hit)";
    try { await waitInPage(page, `the click on ${selector} to reach it`, landed, CEILING, null); return pressed; }
    catch (err) {
      seen = await page.evaluate(`JSON.stringify({ press: ${press + 1}, events: window.__qcClickLog, scrollY,
        nowAt: (() => { const el = document.querySelector(${JSON.stringify(selector)}); const r = el && el.getBoundingClientRect(); return r && [r.left + r.width / 2, r.top + r.height / 2]; })(),
        active: document.activeElement && (document.activeElement.id || document.activeElement.className || document.activeElement.tagName) })`);
      const strayInert = await page.evaluate("(() => { const c = (window.__qcClickLog || []).find((e) => e.t === 'click'); return Boolean(c && !c.hit && c.inert); })()");
      if (!strayInert) throw new Error(`${err.message}: ${seen}`);
    }
  }
  throw new Error(`three presses on ${selector} each landed on something inert beside it: ${seen}`);
}

test('the press helper reads plain text under the focusable <main> as inert, and a button as a control', { skip }, async () => {
  // baseof.html's <main id="main-content" tabindex="-1"> is the skip link's focus target
  // and wraps the whole dashboard, so a bare [tabindex] in INTERACTIVE matched it from
  // every press: no stray press could read as inert and trustedClick() never pressed again.
  const read = await page.evaluate(`(() => {
    const main = document.getElementById('main-content');
    const target = document.querySelector('.qc-row[data-fips]');
    const p = main.appendChild(document.createElement('p'));
    const text = Boolean(${CONTROL_AT}(p, target));
    p.remove();
    const button = main.querySelector('button');
    return { tabindex: main.getAttribute('tabindex'), text, button: Boolean(button && ${CONTROL_AT}(button, target)) };
  })()`);
  assert.equal(read.tabindex, '-1', 'setup: the dashboard sits inside <main tabindex="-1">');
  assert.equal(read.text, false, 'a press on plain text under <main tabindex="-1"> must read as inert, or a stray press is never retried');
  assert.equal(read.button, true, 'a press on a button must still read as a control');
});

test('1. picking a county (success stubs) names the county in all three cards and the header', { skip }, async () => {
  // The county table lives inside the Explore panel since QUX-03b-i (#619), closed
  // by default and exclusive with Layers/Print (wirePanels(), quiet-corners.js), so
  // before()'s openEveryPanel pass does not leave it open. Open it on its own.
  await page.evaluate("document.getElementById('qc-explore-panel').open = true");
  countyName = await page.evaluate("document.querySelector('.qc-row[data-fips] .qc-name').textContent");
  await trustedClick(page, '.qc-row[data-fips]');
  await waitInPage(page, `#qc-tonight, #qc-hourly, #qc-alerts and #qc-conditions-for to each name ${countyName}`,
    `['qc-tonight', 'qc-hourly', 'qc-alerts', 'qc-conditions-for'].every((id) =>
      document.getElementById(id).textContent.includes(${JSON.stringify(countyName)}))`, CEILING, null);
  // Explore is an overlay on the map at this width; closed again so the name
  // markers tests 2-3 click are not under it.
  await page.evaluate("document.getElementById('qc-explore-panel').open = false");
});

test('2. opening a GNIS card asks nothing new and shows a mismatch against the picked county', { skip }, async () => {
  await regroundNamesLayer(page);
  const before2 = await page.evaluate('window.__qcFetchLog.length');
  await openFirstNameCard(page);
  cardName = await page.evaluate("document.querySelector('.qcm-site-card-name').textContent");
  assert.ok(cardName && cardName.length > 0, 'the opened card should have a name');

  const after2 = await page.evaluate('window.__qcFetchLog.length');
  assert.equal(after2, before2, 'opening a card should reach no new api.weather.gov request');

  const header = await page.evaluate("document.getElementById('qc-conditions-for').textContent");
  assert.ok(header.includes(`not ${cardName}`), `header should say "not ${cardName}": "${header}"`);
});

test('the press helper reads plain text on the open site card as inert, though Leaflet makes the map around it focusable', { skip }, async () => {
  // The site card is a Leaflet popup inside #qc-map, and Leaflet's Keyboard handler gives the
  // map container tabindex="0" (quiet-corners.js's L.map() leaves keyboard on). So a press on
  // the card's own text, like the elevation caveat #652's PR CI run 36653058133 hit, found
  // the whole map as its control and trustedClick() never pressed again.
  const read = await page.evaluate(`(() => {
    const target = document.querySelector('.qcm-site-card-action:nth-child(4)');
    const card = target && target.closest('.leaflet-popup .qcm-site-card');
    const p = card && card.appendChild(document.createElement('p'));
    const text = p && ${CONTROL_AT}(p, target);
    if (p) p.remove();
    const other = card && card.querySelector('.qcm-site-card-action:nth-child(1)');
    return { map: document.getElementById('qc-map').getAttribute('tabindex'), card: Boolean(card),
      text: text ? text.id || text.tagName : null, other: Boolean(other && ${CONTROL_AT}(other, target)) };
  })()`);
  assert.equal(read.map, '0', 'setup: Leaflet makes #qc-map focusable');
  assert.equal(read.card, true, 'setup: Before you go sits on a site card in a Leaflet popup');
  assert.equal(read.text, null, 'a press on the card\'s plain text must read as inert, not as the map around the card');
  assert.equal(read.other, true, 'another action on the same card must still read as a control');
});

test('3. Before you go synchronously shows the new place, then resolves through the existing failure notes on an outage', { skip }, async () => {
  await page.evaluate('window.__qcStubMode = "fail"; void 0;');

  // "Synchronously" is read inside the click's own task: a window-level click listener runs
  // after the card button's handler in the same dispatch, before any fetch can answer. A
  // wall-clock budget measured the CDP round trips instead and went red under CI load (#629).
  // Only the click on Before you go takes it: a stray press trustedClick() retries bubbles here too.
  await page.evaluate(`window.__qcSyncSnap = null;
    window.addEventListener('click', function snap(e) {
      if (!(e.target.closest && e.target.closest('.qcm-site-card-action:nth-child(4)'))) return;
      window.removeEventListener('click', snap);
      window.__qcSyncSnap = {
      header: document.getElementById('qc-conditions-for').textContent,
      tonight: document.getElementById('qc-tonight').textContent,
      hourly: document.getElementById('qc-hourly').textContent,
      alerts: document.getElementById('qc-alerts').textContent,
    }; }); void 0;`);
  // A press trustedClick() retries fell on the card's own text, and its click bubbles to
  // window too; one is sent here so the snapshot is proven to wait for Before you go.
  await page.evaluate(`(() => { const card = document.querySelector('.leaflet-popup .qcm-site-card');
    const p = card.appendChild(document.createElement('p'));
    p.dispatchEvent(new MouseEvent('click', { bubbles: true })); p.remove(); })()`);
  await trustedClick(page, '.qcm-site-card-action:nth-child(4)');
  const soon = await page.evaluate('window.__qcSyncSnap');
  assert.ok(soon, 'the Before you go click never reached window, so the same-task snapshot was not taken');
  for (const [label, text] of Object.entries({ header: soon.header, tonight: soon.tonight, hourly: soon.hourly, alerts: soon.alerts })) {
    assert.ok(text.includes(cardName), `${label} should synchronously name ${cardName}: "${text}"`);
    assert.ok(!text.includes(countyName), `${label} should no longer name the county ${countyName}: "${text}"`);
  }

  await waitInPage(page, 'the hourly card to show the outage note',
    `document.getElementById('qc-hourly').textContent.includes(${JSON.stringify(NO_FORECAST_NOTE)})`, CEILING, null);
  const settled = await page.evaluate(`({
    tonight: document.getElementById('qc-tonight').textContent,
    hourly: document.getElementById('qc-hourly').textContent,
    alerts: document.getElementById('qc-alerts').textContent,
  })`);
  assert.ok(settled.tonight.includes(NO_ZONE_NOTE), `#qc-tonight should show NO_ZONE_NOTE after the outage: "${settled.tonight}"`);
  assert.ok(settled.hourly.includes(NO_FORECAST_NOTE), `#qc-hourly should show NO_FORECAST_NOTE after the outage: "${settled.hourly}"`);
  assert.ok(settled.alerts.includes(FAILED_TEXT), `#qc-alerts should show FAILED_TEXT after the outage: "${settled.alerts}"`);
  for (const [label, text] of Object.entries(settled)) {
    assert.ok(!text.includes(QUIET_TEXT), `${label} should never show QUIET_TEXT during a stubbed outage: "${text}"`);
  }
});

test('4. every origin reached during steps 1-3 is the pre-test set, api.weather.gov, or the existing (unstubbed) elevation lookup', { skip }, async () => {
  const seen = await page.evaluate(`Array.from(new Set([
    ...performance.getEntriesByType('resource').map((e) => new URL(e.name).origin),
    ...window.__qcFetchLog.map((u) => new URL(u).origin),
  ]))`);
  // elevation.nationalmap.gov (source-elevation.js) is a real, pre-existing,
  // ungated fetch on every card popupopen -- saved-places-browser.test.mjs
  // opens cards the same way and never stubs it either. It first fires here
  // in step 2's card open, so it is never in preOrigins (captured in before()
  // before any card has opened) without being new work of this PR to gate.
  const allowed = new Set([...preOrigins, 'https://api.weather.gov', 'https://elevation.nationalmap.gov']);
  const unexpected = seen.filter((o) => !allowed.has(o));
  assert.deepEqual(unexpected, [], `no origin outside the pre-test set, api.weather.gov, or elevation.nationalmap.gov should be reached: ${unexpected.join(', ')}`);
});

test('5. Before you go on a saved-places row also updates the header', { skip }, async () => {
  await waitInPage(page, 'the seeded saved-places row to render', "document.querySelectorAll('#qc-saved-list .qc-saved-row').length > 0", CEILING, null);
  // Row order is Show, Share, Before you go, Remove -- 09b sits after 09a's two.
  await trustedClick(page, '.qc-saved-row .qc-saved-row-action:nth-child(3)');
  await waitInPage(page, `the header to name ${SEEDED_NAME}`,
    `document.getElementById('qc-conditions-for').textContent.includes(${JSON.stringify(SEEDED_NAME)})`, CEILING, null);
});

// --- QUX-09c: "Cameras nearby" under the conditions cards --------------------------------
// The place asked about is a point beside the two D05 fixture cameras (Salinas), driven through
// window.qcConditionsFor the way a card's or a row's Before you go button does.
const SALINAS = { name: 'Salinas Test Point', lat: 36.687, lon: -121.653, kind: 'place' };
const NEARBY = "document.getElementById('qc-conditions-cameras')";
const askSalinas = (page) => page.evaluate(`window.__qcStubMode = 'ok'; window.qcConditionsFor(${JSON.stringify(SALINAS)}, { ask: true }); void 0;`);

test('6. with no camera layer on, Before you go says so, starts no catalogue fetch, and lists nothing', { skip }, async () => {
  assert.equal(await page.evaluate('window.__qcCatalogFetches'), 0, 'setup: nothing has loaded the catalogue');
  await askSalinas(page);
  const shown = await page.evaluate(`(() => { const el = ${NEARBY}; return el && { text: el.textContent, buttons: el.querySelectorAll('button').length,
    after: document.getElementById('qc-alerts').nextElementSibling === el }; })()`);
  assert.ok(shown, 'a #qc-conditions-cameras section must exist after Before you go');
  assert.ok(shown.text.includes('Cameras nearby'), shown.text);
  assert.ok(shown.text.includes('No camera layer is on, or none within 25 km.'), shown.text);
  assert.equal(shown.buttons, 0);
  assert.equal(shown.after, true, 'the section sits directly under the alerts card');
  assert.equal(await page.evaluate('window.__qcCatalogFetches'), 0, 'Before you go must never start the catalogue fetch itself');
});

test('6b. road cameras on but the map zoomed out: Before you go says the cameras are not loaded, never "none within 25 km"', { skip }, async () => {
  // Runs before step 7 so no district file is cached yet. Zoom 5 is below the pin floor, so no district file is read: the cameras near Salinas exist and are not loaded.
  await page.evaluate("window.qcMap.setView([39.5, -120.5], 5, { animate: false }); document.getElementById('qcm-layer-roadCameras').click(); void 0;");
  await waitInPage(page, 'the zoomed-out road report to count the areas', "/^Zoom in to see cameras\\. \\d+ cameras? in areas this view touches/.test(document.getElementById('qcm-layer-roadCameras-report').textContent)", CEILING, null);
  await askSalinas(page);
  const text = await page.evaluate(`${NEARBY}.textContent`);
  assert.ok(text.includes('Cameras near here are not loaded yet'), text);
  assert.ok(!text.includes('none within 25 km'), text);
  assert.equal(await page.evaluate(`${NEARBY}.querySelectorAll('button').length`), 0);
  await page.evaluate("document.getElementById('qcm-layer-roadCameras').click(); void 0;");
});

test('7. with the road-camera layer on, cameras within 25 km are listed and one opens its card; layer off empties it again', { skip }, async () => {
  await page.evaluate(VIEW_SALINAS + "document.getElementById('qcm-layer-roadCameras').click(); void 0;");
  await waitInPage(page, 'a road camera pin', "Boolean(document.querySelector('.qcm-camera-pin--road'))", CEILING, null);
  await askSalinas(page);
  const names = await page.evaluate(`[...${NEARBY}.querySelectorAll('button')].map((b) => b.textContent)`);
  assert.equal(names[0], 'US-101 : North Main Street', 'the camera 0.1 km away is first');
  assert.deepEqual(names, ['US-101 : North Main Street'], 'the Santa Barbara fixture camera (Cabrillo Blvd, ~300 km away) is outside 25 km and not listed');
  const text = await page.evaluate(`${NEARBY}.textContent`);
  assert.match(text, / km away/);
  assert.ok(text.includes('does not establish the same conditions across a ridge'), 'the ridge caveat travels with the list');
  assert.ok(!text.includes('No camera layer is on'), text);

  await trustedClick(page, '#qc-conditions-cameras button');
  await waitInPage(page, "the camera's card to open", `(() => { const el = document.querySelector('.leaflet-popup .qcm-site-card-name');
    return Boolean(el) && el.textContent === 'US-101 : North Main Street'; })()`, CEILING, null);
  assert.equal(await page.evaluate('window.__qcCatalogFetches'), 1, 'one catalogue fetch for the whole sequence');

  await page.evaluate(VIEW_SALINAS + "document.getElementById('qcm-layer-roadCameras').click(); void 0;");
  await askSalinas(page);
  const off = await page.evaluate(`({ buttons: ${NEARBY}.querySelectorAll('button').length, text: ${NEARBY}.textContent })`);
  assert.equal(off.buttons, 0, 'a layer switched off lists nothing, though its catalogue is still cached');
  assert.ok(off.text.includes('No camera layer is on, or none within 25 km.'), off.text);
});
