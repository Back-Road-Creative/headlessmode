// B2: qualified GNIS name search adapter (source-terrain-names.js searchByName)
// -- pure logic only, no network, no DOM. Fixtures are the sanitised bodies
// N0 copied from the 2026-09-25 probes; a fake `fetch` answers from them so
// nothing here reaches the real geonames service.
//
// QUX-05a below is the exception: the merged search box's explicit-trigger
// gate and its typed kind badges live in quiet-corners.js's finder, inside an
// un-exported IIFE that only runs in a browser (Leaflet, document), so those
// two proofs drive real headless Chromium the same way
// dashboard-load-failure.test.mjs's name-search proof does, patching
// window.fetch over the DevTools protocol rather than reaching
// carto.nationalmap.gov.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  searchByName, escapeLiteral, buildNameSearchUrl, createSearchGuard, zoomForKind,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-terrain-names.js';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage } from './helpers/waits.mjs';
import { trustedClick } from './helpers/trusted-click.mjs';

const fixturePath = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const loadFixture = (name) => JSON.parse(readFileSync(fixturePath(name), 'utf8'));

function fakeFetch(body, { ok = true, status = 200 } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    return { ok, status, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

test('escapes an apostrophe into the ArcGIS where clause a single-quoted literal way', () => {
  const url = buildNameSearchUrl("O'Neal", {});
  const where = new URL(url).searchParams.get('where');
  assert.equal(where, "UPPER(gaz_name) LIKE 'O''NEAL%'");
  assert.equal(escapeLiteral("O'Neal"), "O''Neal");
  // The service answered `' OR 1=1` with a whole-layer count (2026-09-25 probe) --
  // this module must never let reader text close the literal it sits inside.
  const injected = buildNameSearchUrl("x' OR 1=1", {});
  const injectedWhere = new URL(injected).searchParams.get('where');
  assert.equal(injectedWhere, "UPPER(gaz_name) LIKE 'X'' OR 1=1%'");
});

test('resolves normalized records from a search response', async () => {
  const fixture = loadFixture('geonames-search-coldmountain.min.json');
  const fetchImpl = fakeFetch(fixture);
  const result = await searchByName('Cold Mountain', { fetch: fetchImpl, limit: 20 });
  assert.equal(result.status, 'ready');
  assert.ok(result.features.length > 0, 'no normalized features came back');
  assert.ok(result.features.every((f) => f.id.startsWith('gnis:')));
  assert.equal(fetchImpl.calls.length, 1);
});

test('an HTTP failure maps to a distinct error status', async () => {
  const fetchImpl = fakeFetch(null, { ok: false, status: 500 });
  const result = await searchByName('Cold Mountain', { fetch: fetchImpl });
  assert.equal(result.status, 'error');
  assert.match(result.error, /HTTP 500/);
});

test('a service error body maps to error, not a silent empty result', async () => {
  const fixture = loadFixture('geonames-error.min.json');
  const fetchImpl = fakeFetch(fixture);
  const result = await searchByName('Cold Mountain', { fetch: fetchImpl });
  assert.equal(result.status, 'error');
  assert.match(result.error, /Invalid where clause/);
});

test('a network rejection maps to error', async () => {
  const fetchImpl = async () => { throw new Error('network down'); };
  const result = await searchByName('Cold Mountain', { fetch: fetchImpl });
  assert.equal(result.status, 'error');
  assert.match(result.error, /network down/);
});

test('an AbortError from the module\'s own deadline maps to timeout', async () => {
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const result = await searchByName('Cold Mountain', { fetch: fetchImpl, timeoutMs: 5 });
  assert.equal(result.status, 'timeout');
});

test('an externally aborted request (a newer submission cancelling this one) is reported as aborted, not an error', async () => {
  const controller = new AbortController();
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const pending = searchByName('Cold Mountain', { fetch: fetchImpl, signal: controller.signal, timeoutMs: 5000 });
  controller.abort();
  const result = await pending;
  assert.equal(result.status, 'aborted');
});

test('reports capped: true when the response returns as many rows as the limit asked for', async () => {
  const fixture = loadFixture('geonames-search-apostrophe.min.json'); // 3 features, exceededTransferLimit
  const fetchImpl = fakeFetch(fixture);
  const result = await searchByName("O'Neal", { fetch: fetchImpl, limit: 3 });
  assert.equal(result.status, 'ready');
  assert.equal(result.capped, true);
});

test('a limit larger than the response is not reported as capped', async () => {
  const fixture = loadFixture('geonames-search-apostrophe.min.json'); // 3 features
  const fetchImpl = fakeFetch(fixture);
  const result = await searchByName("O'Neal", { fetch: fetchImpl, limit: 20 });
  assert.equal(result.capped, false);
});

test('a blank query never reaches the network', async () => {
  const fetchImpl = fakeFetch({ features: [] });
  const result = await searchByName('   ', { fetch: fetchImpl });
  assert.equal(result.status, 'empty');
  assert.equal(fetchImpl.calls.length, 0);
});

test('a query longer than the documented cap never reaches the network', async () => {
  const fetchImpl = fakeFetch({ features: [] });
  const result = await searchByName('x'.repeat(200), { fetch: fetchImpl });
  assert.equal(result.status, 'too-long');
  assert.equal(fetchImpl.calls.length, 0);
});

test('createSearchGuard drops a late response: an older token is never current once a newer one has been issued', () => {
  const guard = createSearchGuard();
  const first = guard.bump();
  const second = guard.bump();
  assert.equal(guard.isCurrent(first), false, 'the superseded submission\'s token still reads as current');
  assert.equal(guard.isCurrent(second), true, 'the latest submission\'s token does not read as current');
});

test('zoomForKind gives summits/gaps a closer view than ridges/places, and z12 is the fallback', () => {
  const summitZoom = zoomForKind('summit');
  const gapZoom = zoomForKind('gap');
  const ridgeZoom = zoomForKind('ridge');
  const placeZoom = zoomForKind('place');
  assert.ok(summitZoom > ridgeZoom, 'a summit should get a closer (higher) zoom than a ridge');
  assert.ok(gapZoom > placeZoom, 'a gap should get a closer (higher) zoom than a populated place');
  assert.equal(zoomForKind('unknown-kind-not-in-the-table'), 12, 'an unlisted kind must fall back to z12, not throw or guess');
});

// QUX-05a: the merged search box on the real built Field Maps app
// (/quiet-corners/). Same DevTools-protocol drive as
// names-keyboard.test.mjs/dashboard-load-failure.test.mjs; the geonames
// layer-5 query endpoint is patched, every other request reaches the real
// fetch untouched.
const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const CEILING = 20000;
const GEONAMES_URL = 'carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer/5/query';

/** Answers a request to the geonames layer-5 endpoint with `body`, 200 OK, and
 *  counts how many times that happened on `window.__nameSearchCalls` -- what
 *  "no remote fetch on keystroke" and "exactly one on the explicit trigger"
 *  are measured against. Every other request goes to the real fetch. */
const patchGeonamesCounted = (body) => `(() => {
  window.__nameSearchCalls = 0;
  const real = window.fetch.bind(window);
  const body = ${JSON.stringify(body)};
  window.fetch = function(input, init) {
    const url = String(input && input.url ? input.url : input);
    if (url.indexOf(${JSON.stringify(GEONAMES_URL)}) !== -1) {
      window.__nameSearchCalls++;
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    }
    return real(input, init);
  };
})()`;

/** The point-elevation request a name card makes when it opens, answered with
 *  one height, so a proof that only needs the card never waits on the network. */
const PATCH_ELEVATION = `(() => {
  const real = window.fetch.bind(window);
  window.fetch = function(input, init) {
    const url = String(input && input.url ? input.url : input);
    if (url.indexOf('elevation.nationalmap.gov') !== -1) {
      return Promise.resolve(new Response(JSON.stringify({ samples: [{ locationId: 0, value: '1628.2416' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    }
    return real(input, init);
  };
})()`;

async function withCountedGeonames(body, fn, {
  viewport = { width: 1280, height: 900 }, reducedMotion = false, stubElevation = false,
} = {}) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', { viewport, args: ['--hide-scrollbars'] });
  try {
    if (reducedMotion) {
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    }
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: patchGeonamesCounted(body) });
    if (stubElevation) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PATCH_ELEVATION });
    await page.navigate(`${site.origin}/quiet-corners/`);
    return await fn(page);
  } finally { page.close(); await site.close(); }
}

const openFinderAndType = (query) => `(() => {
  const toggle = document.querySelector('.qc-finder-toggle');
  if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
  const box = document.getElementById('qc-place-search');
  box.focus();
  box.value = ${JSON.stringify(query)};
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;

// Guard, not red: there is no debounce and no `input` listener that reaches
// the network today (quiet-corners.js's `input` handler only ever calls
// clearNameSearchState/renderFinderResults, both local) -- this passes
// against the unmodified finder and pins that gate against ever growing one.
test('QUX-05a guard: typing in the merged search box fires no remote GNIS request', { skip }, async () => {
  const fixture = JSON.parse(readFileSync(fixturePath('geonames-search-coldmountain.min.json'), 'utf8'));
  await withCountedGeonames(fixture, async (page) => {
    await readyDashboard(page, { ms: 60000 });
    await page.evaluate(openFinderAndType('Cold Mountain'));
    // One extra spin of the event loop for any hypothetical debounce/microtask
    // to have fired before the assertion below reads a still-zero count.
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    const afterTyping = await page.evaluate('window.__nameSearchCalls');
    assert.equal(afterTyping, 0, 'typing alone must never fire the remote GNIS request');

    await page.evaluate(`document.getElementById('qc-name-search-btn').click(); void 0;`);
    await waitInPage(page, 'the explicit trigger to fire the remote GNIS request',
      'window.__nameSearchCalls === 1', CEILING, null);
    const afterTrigger = await page.evaluate('window.__nameSearchCalls');
    assert.equal(afterTrigger, 1, 'the explicit trigger (button or Enter) should fire exactly one remote request');
  });
});

// Red before QUX-05a's nameFinderOption change: the fixture dedupes (by
// gaz_id) to a Gap and two Summits, one of them (gaz_id 1010378, Haywood) is
// unique in the set -- an unambiguous row to assert a kind badge and the
// existing state/county line both survive on.
test('QUX-05a: a Geographic-names result carries a typed kind badge alongside its state/county', { skip }, async () => {
  const fixture = JSON.parse(readFileSync(fixturePath('geonames-search-coldmountain.min.json'), 'utf8'));
  await withCountedGeonames(fixture, async (page) => {
    await readyDashboard(page, { ms: 60000 });
    await page.evaluate(openFinderAndType('Cold Mountain'));
    await page.evaluate(`document.getElementById('qc-name-search-btn').click(); void 0;`);
    await waitInPage(page, 'the "Geographic names" group to render',
      `Array.from(document.querySelectorAll('#qc-place-results [role="group"]'))
        .some((g) => g.getAttribute('aria-label') === 'Geographic names')`, CEILING, null);

    const rows = await page.evaluate(`(() => {
      const group = Array.from(document.querySelectorAll('#qc-place-results [role="group"]'))
        .find((g) => g.getAttribute('aria-label') === 'Geographic names');
      return [...group.querySelectorAll('[role="option"]')].map((row) => ({
        text: row.textContent.trim(),
        badge: row.querySelector('.qc-finder-kind-badge')
          ? row.querySelector('.qc-finder-kind-badge').textContent
          : null,
      }));
    })()`);

    const summit = rows.find((r) => /Haywood/.test(r.text));
    assert.ok(summit, `expected a Haywood, NC row among the Geographic-names rows: ${JSON.stringify(rows)}`);
    assert.equal(summit.badge, 'Summit', `expected the Haywood row's kind badge to read "Summit": ${JSON.stringify(summit)}`);
    assert.match(summit.text, /Haywood, NC/, `expected the row to keep its existing state/county line: ${summit.text}`);

    const gap = rows.find((r) => r.badge === 'Gap');
    assert.ok(gap, `expected a Gap-badged row among the Geographic-names rows: ${JSON.stringify(rows)}`);
  });
});

// QUX-05c: ONE renderer for a selected GNIS place name. Picking a
// Geographic-names search result must open the SAME Leaflet popup card the
// map pins use (Q/preview-overlay.js's siteCard), never the old bespoke
// #qc-name-details DOM the finder used to build for itself.
test('QUX-05c: selecting a Geographic-names result opens the one map-pin card, never #qc-name-details', { skip }, async () => {
  const fixture = JSON.parse(readFileSync(fixturePath('geonames-search-coldmountain.min.json'), 'utf8'));
  await withCountedGeonames(fixture, async (page) => {
    await readyDashboard(page, { ms: 60000 });
    await page.evaluate(openFinderAndType('Cold Mountain'));
    await page.evaluate(`document.getElementById('qc-name-search-btn').click(); void 0;`);
    await waitInPage(page, 'the "Geographic names" group to render',
      `Array.from(document.querySelectorAll('#qc-place-results [role="group"]'))
        .some((g) => g.getAttribute('aria-label') === 'Geographic names')`, CEILING, null);

    await page.evaluate(`(() => {
      const group = Array.from(document.querySelectorAll('#qc-place-results [role="group"]'))
        .find((g) => g.getAttribute('aria-label') === 'Geographic names');
      const row = [...group.querySelectorAll('[role="option"]')].find((r) => /Haywood/.test(r.textContent));
      row.click();
    })()`);

    await waitInPage(page, 'the one shared site card to open in the Leaflet popup pane',
      `document.querySelector('.leaflet-popup-pane .qcm-site-card') !== null`, CEILING, null);

    const seen = await page.evaluate(`(() => {
      const card = document.querySelector('.leaflet-popup-pane .qcm-site-card');
      return {
        text: card.textContent,
        legacyMount: document.getElementById('qc-name-details'),
      };
    })()`);
    assert.match(seen.text, /Cold Mountain/, 'the shared card must carry the selected name');
    assert.match(seen.text, /Source: USGS GNIS/, 'the shared card must carry the USGS GNIS source line');
    assert.equal(seen.legacyMount, null, 'the old #qc-name-details mount div must not exist in the DOM at all');
  });
});

// A name picked from "Search" lands where its card can be read. The
// finder used to fly the name's anchor to the map's centre, and the card above
// the anchor landed wherever that left it: on 2026-10-02 a probe of the built
// page read the card for Cold Mountain (Haywood, NC) under the Explore and
// Conditions panels at 1280x900, and at 390x844 running above the top of the
// map. The finder now flies to the spot clearSpot() picks (card-clearance.js;
// card-clearance.test.mjs holds the geometry). Each landing below is a real
// press on the row and the map's real flight, then a read of what is on top at
// points across the card once it stops moving.
const HAYWOOD_ID = 'gnis:1010378';

const LANDINGS = [
  { name: 'at 1280x900', viewport: { width: 1280, height: 900 }, reducedMotion: false, whole: true },
  { name: 'at 1280x900 with reduced motion', viewport: { width: 1280, height: 900 }, reducedMotion: true, whole: true },
  // A phone's map has no spot where the card misses every panel: the name line
  // must show and the card must stay on the map; how little of the rest is
  // covered is card-clearance.test.mjs's to prove.
  { name: 'at 390x844', viewport: { width: 390, height: 844 }, reducedMotion: false, whole: false },
  // A reader who has scrolled down to the sheet under the phone map has the top
  // of the map above the screen: the card must land in the part still on it.
  { name: 'at 390x844 with the page scrolled 450px down', viewport: { width: 390, height: 844 }, reducedMotion: false, whole: false, scroll: 450 },
];

/** The wrappers of the cards a reader can see. Leaflet keeps a closed popup in
 *  the pane for 200 ms at opacity 0 while it fades out (DivOverlay.onRemove:
 *  setOpacity(container, 0), then _removeTimeout), and a redraw reopens the
 *  landed card, so for a moment two `.leaflet-popup`s share the pane -- longer
 *  on a loaded box (PR CI run 37576250172, both attempts: the first wrapper
 *  found was the fading one, and the live card's own name line read as
 *  "covering" it). A card on its way out is never the card. */
const LIVE_WRAPS = `[...document.querySelectorAll('.leaflet-popup-pane .leaflet-popup')]
    .filter((p) => p.style.opacity !== '0')
    .map((p) => p.querySelector('.leaflet-popup-content-wrapper')).filter(Boolean)`;

/** True once the map has moved and the one live card's box has held still for
 *  300 ms (each read is one waitInPage poll). */
const CARD_STILL = `(() => {
  const live = ${LIVE_WRAPS};
  const w = live.length === 1 ? live[0] : null;
  if (!w || !(window.__moves >= 1)) { window.__cardAt = null; return false; }
  const r = w.getBoundingClientRect();
  const key = [r.left, r.top, r.width, r.height].map(Math.round).join(',');
  const now = performance.now();
  if (!window.__cardAt || window.__cardAt.key !== key) { window.__cardAt = { key, since: now }; return false; }
  return now - window.__cardAt.since >= 300;
})()`;

/** What a reader sees of the open card: whatever is on top, wherever that is
 *  not the card itself (nothing at all means the point is off screen), at
 *  points no more than 16 px apart across it and along its name line, and at
 *  one on its tip; the card's, its name line's and the visible map's boxes;
 *  where on screen the place itself is; how far the map's box and the page are
 *  scrolled; the zoom; and whether the page asks for reduced motion. */
const LANDED = (anchor) => `(() => {
  const wrap = ${LIVE_WRAPS}[0];
  const popup = wrap.closest('.leaflet-popup');
  const onTop = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (el && popup.contains(el)) return null;
    return { x: Math.round(x), y: Math.round(y), by: !el ? 'nothing'
      : el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.classList[0] ? '.' + el.classList[0] : '') };
  };
  // From lo to hi, both ends included, no more than 16 px apart.
  const across = (lo, hi) => {
    const k = Math.max(1, Math.ceil((hi - lo) / 16));
    return Array.from({ length: k + 1 }, (_, i) => lo + (hi - lo) * i / k);
  };
  const b = wrap.getBoundingClientRect();
  const grid = [];
  for (const y of across(b.top + 3, b.bottom - 3)) for (const x of across(b.left + 3, b.right - 3)) grid.push(onTop(x, y));
  // The tip is a rotated square clipped to the top of its 40x20 box: 6 px down its middle is on it.
  const t = popup.querySelector('.leaflet-popup-tip-container').getBoundingClientRect();
  grid.push(onTop(t.left + t.width / 2, t.top + 6));
  const n = wrap.querySelector('.qcm-site-card-name').getBoundingClientRect();
  const line = across(n.left + 1, n.right - 1).map((x) => onTop(x, n.top + n.height / 2));
  // The map shows only inside its container's box (overflow hidden) and the viewport.
  const mapEl = qcMap.getContainer();
  const m = mapEl.getBoundingClientRect();
  const holder = document.getElementById('qc-map-container');
  const c = holder.getBoundingClientRect();
  const de = document.documentElement;
  const p = qcMap.latLngToContainerPoint(${JSON.stringify(anchor)});
  const box = (r) => ({ left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) });
  return {
    covered: grid.filter(Boolean), nameCovered: line.filter(Boolean), card: box(b), nameLine: box(n),
    view: box({ left: Math.max(m.left, c.left, 0), top: Math.max(m.top, c.top, 0),
      right: Math.min(m.right, c.right, de.clientWidth), bottom: Math.min(m.bottom, c.bottom, de.clientHeight) }),
    place: { x: Math.round(m.left + mapEl.clientLeft + p.x), y: Math.round(m.top + mapEl.clientTop + p.y) },
    holderScroll: [holder.scrollLeft, holder.scrollTop], pageScroll: Math.round(window.scrollY),
    zoom: qcMap.getZoom(), reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
  };
})()`;

for (const landing of LANDINGS) {
  const promise = landing.whole ? 'its whole card clear of the panels and controls over the map'
    : 'its card on the map and its name line clear';
  test(`a name picked from "Search" ${landing.name} lands with ${promise}`, { skip }, async () => {
    const fixture = loadFixture('geonames-search-coldmountain.min.json');
    const found = await searchByName('Cold Mountain', { fetch: fakeFetch(fixture), limit: 20 });
    const haywood = found.features.find((f) => f.id === HAYWOOD_ID);
    assert.ok(haywood, `the fixture must still carry ${HAYWOOD_ID} (Cold Mountain, Haywood, NC)`);
    await withCountedGeonames(fixture, async (page) => {
      await readyDashboard(page, { ms: 60000 });
      if (landing.scroll) await page.evaluate(`window.scrollTo(0, ${landing.scroll}); void 0;`);
      await page.evaluate(openFinderAndType('Cold Mountain'));
      await page.evaluate(`document.getElementById('qc-name-search-btn').click(); void 0;`);
      await waitInPage(page, 'the "Geographic names" group to render',
        `Array.from(document.querySelectorAll('#qc-place-results [role="group"]'))
          .some((g) => g.getAttribute('aria-label') === 'Geographic names')`, CEILING, null);
      await page.evaluate(`(() => {
        const group = Array.from(document.querySelectorAll('#qc-place-results [role="group"]'))
          .find((g) => g.getAttribute('aria-label') === 'Geographic names');
        const row = [...group.querySelectorAll('[role="option"]')].find((r) => /Haywood/.test(r.textContent));
        row.dataset.qcTestRow = 'haywood';
        window.__moves = 0;
        qcMap.on('moveend', () => { window.__moves++; });
      })()`);

      // 'nearest': the row is already in view, so the press leaves the page as a person has it.
      await trustedClick(page, '[data-qc-test-row="haywood"]', { align: 'nearest' });
      await waitInPage(page, 'the map to stop with the card open and still', CARD_STILL, CEILING, null);

      const seen = await page.evaluate(LANDED(haywood.anchor));
      const at = JSON.stringify(seen);
      // Without this a dropped emulation would run the animated flight and still pass.
      assert.equal(seen.reduce, landing.reducedMotion, `the page must ${landing.reducedMotion ? '' : 'not '}ask for reduced motion: ${at}`);
      assert.deepEqual(seen.holderScroll, [0, 0], `nothing may scroll the map inside its own box: ${at}`);
      if (landing.scroll) assert.equal(seen.pageScroll, landing.scroll, `the page must stay where the reader scrolled it: ${at}`);
      assert.equal(seen.zoom, zoomForKind(haywood.kind), `the map must still zoom for a ${haywood.kind}: ${at}`);
      assert.ok(seen.place.x >= seen.view.left && seen.place.x <= seen.view.right
        && seen.place.y >= seen.view.top && seen.place.y <= seen.view.bottom,
      `the place itself must be on the part of the map on screen: ${at}`);
      assert.ok(seen.card.left >= seen.view.left && seen.card.right <= seen.view.right
        && seen.card.top >= seen.view.top && seen.card.bottom <= seen.view.bottom,
      `the card must land inside the part of the map on screen: ${at}`);
      assert.deepEqual(seen.nameCovered, [], `the card's name line must show: ${at}`);
      if (landing.whole) assert.deepEqual(seen.covered, [], `nothing may sit over the card: ${at}`);
    }, { viewport: landing.viewport, reducedMotion: landing.reducedMotion, stubElevation: true });
  });
}

/** Plants a copy of the open card FIRST in the popup pane at opacity 0 and the
 *  same spot: what Leaflet leaves behind for 200 ms when a redraw reopens the
 *  landed card (DivOverlay.onRemove keeps the closed container until its
 *  _removeTimeout fires). */
test('a redraw keeps the open card: the same popup element, never closed and reopened', { skip }, async () => {
  // Every names redraw used to tear every pin down and open the selected card
  // again on the fresh pin. Leaflet keeps the closed one in the pane for 200 ms
  // while it fades, so each redraw put a second (then a third) `.leaflet-popup`
  // beside the live card -- the race every landing proof had to step around
  // (deploy runs 37609688474, 37611010992, 37615520488: three different tests,
  // one cause). The card the reader opened now survives the redraw as the same
  // element: no popupclose, nothing fading, one card in the pane.
  const fixture = loadFixture('geonames-search-coldmountain.min.json');
  await withCountedGeonames(fixture, async (page) => {
    await readyDashboard(page, { ms: 60000 });
    await page.evaluate(openFinderAndType('Cold Mountain'));
    await page.evaluate(`document.getElementById('qc-name-search-btn').click(); void 0;`);
    await waitInPage(page, 'the "Geographic names" group to render',
      `Array.from(document.querySelectorAll('#qc-place-results [role="group"]'))
        .some((g) => g.getAttribute('aria-label') === 'Geographic names')`, CEILING, null);
    await page.evaluate(`(() => {
      const group = Array.from(document.querySelectorAll('#qc-place-results [role="group"]'))
        .find((g) => g.getAttribute('aria-label') === 'Geographic names');
      const row = [...group.querySelectorAll('[role="option"]')].find((r) => /Haywood/.test(r.textContent));
      row.dataset.qcTestRow = 'haywood';
      window.__moves = 0;
      qcMap.on('moveend', () => { window.__moves++; });
    })()`);
    await trustedClick(page, '[data-qc-test-row="haywood"]', { align: 'nearest' });
    await waitInPage(page, 'the map to stop with the card open and still', CARD_STILL, CEILING, null);
    // Tag the live card, count closes from here on, then force a names redraw
    // the way a pan does: a fresh names answer through renderSources.
    await page.evaluate(`(() => {
      const live = ${LIVE_WRAPS}[0].closest('.leaflet-popup');
      live.dataset.qcTestLive = '1';
      window.__closes = 0;
      qcMap.on('popupclose', () => { window.__closes++; });
      qcMap.fire('moveend');
    })()`);
    await waitInPage(page, 'the forced redraw to run its names pass',
      `window.__nameSearchCalls >= 2 || document.querySelectorAll('.leaflet-popup-pane .leaflet-popup').length !== 1`, CEILING, null)
      .catch(() => {});
    // Settle past Leaflet's 200 ms fade so a reopened card would have shown up.
    await new Promise((r) => setTimeout(r, 400));
    const after = await page.evaluate(`(() => {
      const popups = [...document.querySelectorAll('.leaflet-popup-pane .leaflet-popup')];
      return { popups: popups.length, sameElement: popups.length === 1 && popups[0].dataset.qcTestLive === '1', closes: window.__closes };
    })()`);
    assert.deepEqual(after, { popups: 1, sameElement: true, closes: 0 }, `the card must ride the redraw untouched: ${JSON.stringify(after)}`);
  }, { viewport: { width: 390, height: 844 }, stubElevation: true });
});

const PLANT_FADING_COPY = `(() => {
  const pane = document.querySelector('.leaflet-popup-pane');
  const live = pane.querySelector('.leaflet-popup');
  const stale = live.cloneNode(true);
  stale.style.opacity = '0';
  stale.dataset.qcTestStale = '1';
  pane.insertBefore(stale, live);
  return pane.querySelectorAll('.leaflet-popup').length;
})()`;

test('a landing is measured on the live card, never on one Leaflet is still fading out', { skip }, async () => {
  // PR CI run 37576250172 (both attempts, 390x844, box loaded by three other
  // suites): the first wrapper in the pane was the card being faded out, and
  // the live card's own name line read as "covering" it. Load stretches that
  // 200 ms past the 300 ms stillness wait, so the race is planted here instead.
  const fixture = loadFixture('geonames-search-coldmountain.min.json');
  const found = await searchByName('Cold Mountain', { fetch: fakeFetch(fixture), limit: 20 });
  const haywood = found.features.find((f) => f.id === HAYWOOD_ID);
  await withCountedGeonames(fixture, async (page) => {
    await readyDashboard(page, { ms: 60000 });
    await page.evaluate(openFinderAndType('Cold Mountain'));
    await page.evaluate(`document.getElementById('qc-name-search-btn').click(); void 0;`);
    await waitInPage(page, 'the "Geographic names" group to render',
      `Array.from(document.querySelectorAll('#qc-place-results [role="group"]'))
        .some((g) => g.getAttribute('aria-label') === 'Geographic names')`, CEILING, null);
    await page.evaluate(`(() => {
      const group = Array.from(document.querySelectorAll('#qc-place-results [role="group"]'))
        .find((g) => g.getAttribute('aria-label') === 'Geographic names');
      const row = [...group.querySelectorAll('[role="option"]')].find((r) => /Haywood/.test(r.textContent));
      row.dataset.qcTestRow = 'haywood';
      window.__moves = 0;
      qcMap.on('moveend', () => { window.__moves++; });
    })()`);
    await trustedClick(page, '[data-qc-test-row="haywood"]', { align: 'nearest' });
    await waitInPage(page, 'the map to stop with the card open and still', CARD_STILL, CEILING, null);
    const planted = await page.evaluate(PLANT_FADING_COPY);
    assert.equal(planted, 2, 'the pane must now hold the fading copy and the live card');
    const liveBox = await page.evaluate(`(() => {
      const r = document.querySelector('.leaflet-popup:not([data-qc-test-stale]) .leaflet-popup-content-wrapper').getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) };
    })()`);
    await waitInPage(page, 'the live card to read as still', CARD_STILL, CEILING, null);
    const seen = await page.evaluate(LANDED(haywood.anchor));
    const at = JSON.stringify(seen);
    assert.deepEqual(seen.card, liveBox, `the card measured must be the live one: ${at}`);
    assert.deepEqual(seen.nameCovered, [], `the live card's name line must show: ${at}`);
  }, { viewport: { width: 390, height: 844 }, stubElevation: true });
});
