// QQA-16a, journey J10: a reader opens the Cameras group and finds one list. It reads "In this view",
// then "Near selected place" (with the radius said), narrows by purpose, and opens a camera from a row.
// The list is built from the loaded camera records, so a view holding more than the map's 300-pin cap
// still counts every camera and says how many it lists and why; the rows open the existing camera card,
// and no picture is requested until one is opened.
//
// The browser is offline (helpers/browser.mjs launch). The Caltrans District 5 file and its pictures are
// answered by a fetch stand-in installed before any page script runs (the same one
// camera-discovery-browser.test.mjs uses); every other camera file is the site's own snapshot, served
// by the local site server. Every press is a trusted CDP press; the page is read only for assertions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { trustedClick } from './helpers/trusted-click.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage, chooseExampleArea } from './helpers/waits.mjs';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { d05Stub, INDEX_PATH, D05_PATH } from './helpers/camera-snapshot-stub.mjs';
import { PLACE_FEATURES } from './fixtures/gnis-names-declutter.mjs';
import { kmBetween, MAX_PINS, LIST_LIMIT } from '../../themes/headlessmode/static/js/quiet-corners-maps/camera-layer.js';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const CCTV_ORIGIN = SOURCES.caltransCctv.origin;
const cctv = (index, name, place, lon, lat, file, picture = true) => ({
  cctv: {
    index: String(index), inService: 'true',
    location: { district: '5', locationName: name, nearbyPlace: place, longitude: String(lon), latitude: String(lat) },
    imageData: { imageDescription: '', streamingVideoURL: '', static: { currentImageURL: picture ? `${CCTV_ORIGIN}/data/d5/cctv/image/${file}/${file}.jpg` : '' } },
  },
});
// A grid of cameras around Salinas, all inside a zoom-9 view centred there: more than the pin cap.
const SALINAS = [36.65, -121.7];
const GRID = [];
for (let i = 0; i < 350; i++) GRID.push({ i, lat: +(36.45 + (i % 25) * 0.0166).toFixed(5), lon: +(-121.9 + Math.floor(i / 25) * 0.0286).toFixed(5) });
const catalogOf = (grid, picture = true) => ({ data: grid.map((g) => cctv(g.i + 1, `US-101 : Spot ${g.i}`, 'Salinas', g.lon, g.lat, `spot${g.i}`, picture)) });
const TINY_JPEG_B64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

/** window.fetch replaced before any page script runs: the District 5 list and the pictures are answered
 *  here and counted; anything else goes on to the site server. mode: 'ok', 'fail' or 'hold'. */
const standIn = (stub) => `(() => {
  const real = window.fetch.bind(window);
  const catalog = ${JSON.stringify(stub.d05Json)};
  const indexJson = ${JSON.stringify(stub.indexJson)};
  const jpeg = Uint8Array.from(atob(${JSON.stringify(TINY_JPEG_B64)}), (c) => c.charCodeAt(0));
  window.__camera = { catalogue: 0, pictures: 0 };
  window.__ctl = { mode: 'ok', release: null, failPaths: [],
    resources: () => performance.getEntriesByType('resource').filter((e) => e.name.startsWith(${JSON.stringify(CCTV_ORIGIN)})).length };
  const json = (text) => new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    let path = '';
    try { path = new URL(url, location.href).pathname; } catch { /* not a url */ }
    if (path === ${JSON.stringify(INDEX_PATH)}) return Promise.resolve(json(indexJson));
    if (window.__ctl.failPaths.some((p) => path.endsWith(p))) return Promise.resolve(new Response('nope', { status: 500 }));
    if (path === ${JSON.stringify(D05_PATH)}) {
      window.__camera.catalogue++;
      if (window.__ctl.mode === 'fail') return Promise.resolve(new Response('nope', { status: 500 }));
      if (window.__ctl.mode === 'hold') return new Promise((resolve) => { window.__ctl.release = () => resolve(json(catalog)); });
      return Promise.resolve(json(catalog));
    }
    if (url.startsWith(${JSON.stringify(CCTV_ORIGIN)})) {
      window.__camera.pictures++;
      return Promise.resolve(new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg', 'last-modified': new Date(Date.now() - 180000).toUTCString() } }));
    }
    return real(input, init);
  };
})()`;

async function withPage(grid, fn, { picture = true } = {}) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', { args: ['--hide-scrollbars'], viewport: { width: 1280, height: 900 } });
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: standIn(d05Stub(catalogOf(grid, picture))) });
    await page.navigate(`${site.origin}/quiet-corners/`);
    await readyDashboard(page, { data: false });
    await press(page, '#qcm-layer-panel > summary', { until: "document.getElementById('qcm-layer-panel').open" });
    await press(page, '.qcm-layer-group[aria-label="Cameras"] > summary', { until: "document.querySelector('.qcm-layer-group[aria-label=\"Cameras\"]').open" });
    return await fn(page);
  } finally { page.close(); await site.close(); }
}

const press = (page, selector, opts = {}) => trustedClick(page, selector, { settleMs: 0, ...opts });
const text = (page, selector) => page.evaluate(`(document.querySelector(${JSON.stringify(selector)}) || {}).textContent || ''`);
const listStatus = (page) => text(page, '#qcm-camera-list-status');
const waitStatus = (page, re, what) => waitInPage(page, what, `${re}.test(document.getElementById('qcm-camera-list-status').textContent)`, 15000, null);
const rowCount = (page) => page.evaluate("document.querySelectorAll('#qcm-camera-list-rows button.qcm-camera-list-row').length");
const atSalinas = async (page) => {
  await page.evaluate(`new Promise((resolve, reject) => {
    const m = window.qcMap, raf2 = (f) => requestAnimationFrame(() => requestAnimationFrame(f));
    const t0 = Date.now(), idle = () => !m._animatingZoom && !m._panAnim;
    const step = () => {
      if (Date.now() - t0 > 10000) return reject(new Error('the map never settled at Salinas, zoom 9'));
      if (!idle()) return raf2(step);
      m.setView(${JSON.stringify(SALINAS)}, 9, { animate: false });
      raf2(() => (idle() && m.getZoom() === 9 ? resolve(0) : step()));
    };
    raf2(step);
  })`);
};
const goToRoad = async (page) => {
  await press(page, '#qcm-camera-entry [data-camera-region="roadCameras"] button.qcm-camera-goto');
  await waitInPage(page, 'the map to reach California', "window.qcMap.getBounds().getWest() <= -124 && window.qcMap.getBounds().getEast() >= -114", 20000, null);
  await atSalinas(page);
};

test('J10: one Cameras list, scoped to the view and to a chosen place, filtered by purpose, honest past the 300-pin cap', { skip }, async () => {
  await withPage(GRID, async (page) => {
    // The list is a real list under a heading, inside the Cameras group, and says what to do with no layer on.
    const shape = await page.evaluate(`(() => {
      const group = document.querySelector('.qcm-layer-group[aria-label="Cameras"]');
      const host = document.getElementById('qcm-camera-list');
      const title = document.getElementById('qcm-camera-list-title');
      const rows = document.getElementById('qcm-camera-list-rows');
      const status = document.getElementById('qcm-camera-list-status');
      const announce = document.getElementById('qcm-camera-list-announce');
      return { inGroup: !!host && group.contains(host), heading: title && title.tagName, titleText: title && title.textContent,
        list: rows && rows.tagName, labelled: rows && rows.getAttribute('aria-labelledby'), rowsRole: rows && rows.getAttribute('role'),
        statusLive: status && status.getAttribute('aria-live'), statusRole: status && status.getAttribute('role'),
        live: announce && announce.getAttribute('aria-live'), role: announce && announce.getAttribute('role'), scopes: [...host.querySelectorAll('input[name="qcm-camera-scope"]')].map((r) => r.value),
        purposes: [...host.querySelectorAll('input[data-camera-purpose]')].map((r) => r.getAttribute('data-camera-purpose')),
        radius: host.textContent };
    })()`);
    assert.equal(shape.inGroup, true, 'the list is not inside the Cameras group');
    assert.equal(shape.heading, 'H4');
    assert.equal(shape.titleText, 'Cameras in this view');
    assert.equal(shape.list, 'UL');
    assert.equal(shape.labelled, 'qcm-camera-list-title');
    // QQA-16c: the live region is the list's own announcer, which speaks a count only when it changes; the
    // status line it mirrors is plain text (2026-10-08: these two assertions moved from the status line to the announcer).
    assert.equal(shape.rowsRole, 'list', 'the rows are not exposed as a list');
    assert.equal(shape.live, 'polite');
    assert.equal(shape.role, 'status');
    assert.equal(shape.statusLive, null, 'the status line is still a live region, so every repaint of it is read out');
    assert.equal(shape.statusRole, null);
    assert.deepEqual(shape.scopes, ['view', 'near', 'saved']); // 2026-10-08 QQA-16b adds the Saved scope; the two it had are unchanged
    assert.deepEqual(shape.purposes, ['roads', 'scenery', 'weather', 'wildlife']);
    assert.match(shape.radius, /within 25 km/, 'the radius is not stated in the UI');
    assert.match(await listStatus(page), /no camera layer is on/i);

    // Road cameras on at Salinas: every camera is counted, 50 rows are listed, the map holds 300 pins.
    await goToRoad(page);
    await press(page, '#qcm-layer-roadCameras');
    await waitInPage(page, 'road pins', "Boolean(document.querySelector('.qcm-camera-pin--road'))", 30000, null);
    await waitStatus(page, /^350 cameras in this view\./, 'the list to count all 350 cameras');
    assert.equal(await text(page, '#qcm-camera-list-title'), 'Cameras in this view (350)');
    assert.equal(await rowCount(page), LIST_LIMIT);
    const pins = await page.evaluate("document.querySelectorAll('.qcm-camera-pin--road').length");
    assert.equal(pins, MAX_PINS, 'the map should draw exactly the pin cap for this fixture');
    const notes = await text(page, '#qcm-camera-list-notes');
    assert.match(notes, new RegExp(`Listing the nearest ${LIST_LIMIT} of 350`), 'the list does not say it lists only some');
    assert.match(notes, /map draws at most 300 pins/, 'the list does not say why the map shows fewer');
    // Rows are buttons that name the camera; none of this requested a picture.
    const first = await page.evaluate(`(() => { const b = document.querySelector('#qcm-camera-list-rows button.qcm-camera-list-row');
      return { tag: b.tagName, type: b.type, tabindex: b.getAttribute('tabindex'), name: b.textContent, inLi: b.parentElement.tagName }; })()`);
    assert.equal(first.tag, 'BUTTON');
    assert.equal(first.type, 'button');
    assert.notEqual(first.tabindex, '-1');
    assert.equal(first.inLi, 'LI');
    assert.match(first.name, /US-101 : Spot \d+/);
    assert.match(first.name, /Caltrans/, 'the row does not name its source');
    assert.deepEqual(await page.evaluate('window.__camera'), { catalogue: 1, pictures: 0 });
    assert.equal(await page.evaluate('window.__ctl.resources()'), 0);

    // Purpose filter: Roads off hides all of them and says it is the filter, not the map; back on restores.
    await press(page, 'input[data-camera-purpose="roads"]');
    await waitStatus(page, /350 cameras in this view are hidden by the purpose filter/, 'the filtered-out state');
    assert.equal(await rowCount(page), 0);
    assert.equal(await text(page, '#qcm-camera-list-title'), 'Cameras in this view');
    await press(page, 'input[data-camera-purpose="roads"]');
    await waitStatus(page, /^350 cameras in this view\./, 'the list to return');
    assert.equal(await rowCount(page), LIST_LIMIT);

    // Near selected place: no place yet, then the finder's place. The radius is said; rows run nearest first.
    await press(page, '#qcm-camera-scope-near');
    await waitStatus(page, /choose a place/i, 'the no-place state');
    assert.equal(await rowCount(page), 0);
    await page.evaluate(`window.qcSelectName(${JSON.stringify({ id: 'test:spot', name: 'Test Spot', kind: 'summit', county: 'Monterey', state: 'CA', anchor: SALINAS })}); void 0;`);
    const within = GRID.map((g) => ({ ...g, km: kmBetween(SALINAS[0], SALINAS[1], g.lat, g.lon) })).filter((g) => g.km <= 25).sort((a, b) => a.km - b.km);
    assert.ok(within.length > 0 && within.length < GRID.length, 'the fixture should put some cameras outside 25 km');
    await waitStatus(page, new RegExp(`^${within.length} cameras near Test Spot, within 25 km, nearest first\\.`), 'the near list to count the cameras within 25 km');
    assert.equal(await text(page, '#qcm-camera-list-title'), `Cameras near Test Spot (${within.length})`);
    const near = await page.evaluate(`[...document.querySelectorAll('#qcm-camera-list-rows button.qcm-camera-list-row')].map((b) => b.textContent)`);
    assert.equal(near.length, Math.min(LIST_LIMIT, within.length));
    assert.match(near[0], new RegExp(`Spot ${within[0].i}\\b`), 'the nearest camera is not first');
    const kms = near.map((t) => Number((t.match(/([\d.]+) km/) || [])[1]));
    assert.ok(kms.every((k, i) => Number.isFinite(k) && (i === 0 || kms[i - 1] <= k + 0.05)), `distances do not run nearest first: ${kms.join(', ')}`);
    assert.ok(kms[kms.length - 1] <= 25);

    // Open a camera from its row: the existing card opens, and the picture is requested then, once.
    await press(page, '#qcm-camera-list-rows button.qcm-camera-list-row');
    await waitInPage(page, 'the camera card', `(() => { const c = document.querySelector('.qcm-camera-media'); return Boolean(c) && document.querySelector('.qcm-site-card').textContent.includes('Spot ${within[0].i}'); })()`, 15000, null);
    await waitInPage(page, 'the picture request', 'window.__camera.pictures >= 1', 15000, null);
    assert.equal(await page.evaluate('window.__camera.pictures'), 1);

    // Back to the view scope: the same cameras, counted again.
    await press(page, '#qcm-camera-scope-view');
    await waitStatus(page, /^350 cameras in this view\./, 'the view scope to count again');
  });
});

test('J10b: the status line does not chatter, and the states read apart', { skip }, async () => {
  await withPage(GRID.slice(0, 40), async (page) => {
    await goToRoad(page);
    await press(page, '#qcm-layer-roadCameras');
    await waitStatus(page, /^40 cameras in this view\./, 'the list to count 40 cameras');
    // A nudge that changes nothing in the list, and a filter flipped off and on in one tick, write nothing.
    await page.evaluate(`window.__writes = 0; new MutationObserver((m) => { window.__writes += m.length; })
      .observe(document.getElementById('qcm-camera-list-status'), { childList: true, characterData: true, subtree: true }); void 0;`);
    await page.evaluate(`(() => { const c = window.qcMap.getCenter(); window.qcMap.setView([c.lat + 0.0005, c.lng], 9, { animate: false }); })(); void 0;`);
    await page.evaluate(`(() => { const b = document.querySelector('input[data-camera-purpose="roads"]'); b.click(); b.click(); })(); void 0;`);
    await page.evaluate('new Promise((r) => setTimeout(r, 1200))');
    assert.equal(await page.evaluate('window.__writes'), 0, 'the live status was rewritten for a list that did not change');
    assert.equal(await rowCount(page), 40);

    // Zoom out: nothing is read below zoom 7, and the list says so rather than "none".
    await page.evaluate('window.qcMap.setView([36.65, -121.7], 5, { animate: false }); void 0;');
    await waitStatus(page, /zoom in to list cameras/i, 'the zoom-in state');
    assert.equal(await rowCount(page), 0);
    // Open sea far outside any camera layer's coverage: outside coverage, not none.
    await page.evaluate('window.qcMap.setView([0, -30], 8, { animate: false }); void 0;');
    await waitStatus(page, /outside coverage/i, 'the outside-coverage state');
    // In coverage but away from every camera in the list: none, said plainly.
    await page.evaluate('window.qcMap.setView([35.0, -121.9], 9, { animate: false }); void 0;');
    await waitStatus(page, /^No cameras in this view\./, 'the none state');
  });
});

test('J10c: a failed list reads unavailable and a list of link-only cameras reads images unavailable', { skip }, async () => {
  await withPage(GRID.slice(0, 5), async (page) => {
    await goToRoad(page);
    await page.evaluate("window.__ctl.mode = 'fail'");
    await press(page, '#qcm-layer-roadCameras');
    await waitStatus(page, /camera list unavailable/i, 'the unavailable state');
    assert.equal(await rowCount(page), 0);
    // Off and on again, held open: loading; then released: the cameras, none with a picture.
    await press(page, '#qcm-layer-roadCameras');
    await page.evaluate("window.__ctl.mode = 'hold'");
    await press(page, '#qcm-layer-roadCameras');
    await waitStatus(page, /loading the camera list/i, 'the loading state');
    await waitInPage(page, 'the held list request', 'typeof window.__ctl.release === "function"', 5000, null);
    await page.evaluate('window.__ctl.release(), 0');
    await waitStatus(page, /^5 cameras in this view\. None has a picture here\./, 'the images-unavailable state');
    assert.match(await text(page, '#qcm-camera-list-rows'), /no picture/);
  }, { picture: false });
});

const selectName = (page, name, anchor) => page.evaluate(`window.qcSelectName(${JSON.stringify({ id: `test:${name}`, name, kind: 'summit', county: 'Monterey', state: 'CA', anchor })}); void 0;`);
const atView = (page, center, zoom) => page.evaluate(`(() => { window.qcMap.setView(${JSON.stringify(center)}, ${zoom}, { animate: false }); })(); void 0;`);

// Five cameras a few km from Salinas, so every one is inside the 25 km reach.
const CLOSE = Array.from({ length: 5 }, (_, i) => ({ i, lat: +(36.64 + i * 0.004).toFixed(5), lon: +(-121.7 + i * 0.004).toFixed(5) }));

test('J10d: every file around the chosen place failing reads unavailable, even with the map elsewhere', { skip }, async () => {
  // Every file around the place fails; the map sits at a zoom that reads nothing itself. The list is
  // unavailable (and says how to retry), not "no camera list has been read yet".
  await withPage(CLOSE, async (page) => {
    await atView(page, SALINAS, 5);
    await press(page, '#qcm-layer-roadCameras');
    await page.evaluate("window.__ctl.mode = 'fail'");
    await press(page, '#qcm-camera-scope-near');
    await selectName(page, 'Test Spot', SALINAS);
    await waitStatus(page, /camera list unavailable/i, 'the unavailable state for the near scope');
    assert.equal(await page.evaluate('document.getElementById("qcm-camera-list-status").getAttribute("data-status")'), 'unavailable');
    assert.equal(await rowCount(page), 0);
    assert.equal(await page.evaluate('window.__camera.catalogue'), 1, 'the failed file is not asked for again until the layer is cycled');
  });
});

test('J10d2: a district failing under the map does not make the near list unavailable or partial', { skip }, async () => {
  // The place is Salinas and its file reads fine; then the map is parked on Indiana, where both files
  // its padded view meets (Indiana's and Kentucky's) fail. The near list still counts the Salinas cameras
  // and calls nothing unavailable or partial; the view scope, which describes the parked view, says unavailable.
  await withPage(CLOSE, async (page) => {
    await page.evaluate("window.__ctl.failPaths = ['in-511/in-511-in.json', 'ky-kytc/ky-kytc-ky.json']");
    await atView(page, SALINAS, 9);
    await press(page, '#qcm-layer-roadCameras');
    await waitStatus(page, /^5 cameras in this view\./, 'the five cameras in the Salinas view');
    await press(page, '#qcm-camera-scope-near');
    await selectName(page, 'Test Spot', SALINAS);
    await waitStatus(page, /^5 cameras near Test Spot, within 25 km, nearest first\./, 'the near list to count the Salinas cameras');
    await atView(page, [39.77, -86.16], 9);
    await press(page, '#qcm-camera-scope-view');
    await waitStatus(page, /camera list unavailable/i, 'the view scope to read the parked Indiana file as unavailable');
    await press(page, '#qcm-camera-scope-near');
    await waitStatus(page, /^5 cameras near Test Spot, within 25 km, nearest first\./, 'the near list to keep its five cameras');
    assert.doesNotMatch(await listStatus(page), /unavailable|partial/i);
    assert.doesNotMatch(await text(page, '#qcm-camera-list-notes'), /did not load/);
    assert.equal(await rowCount(page), 5);
  });
});

// A names stand-in for the one test that picks places from pins: the GNIS count and page answers for
// the Populated Place grid, the elevation sample, empty road and water name answers, and the two probes a source pass makes. Every other
// cross-origin request is refused and listed, so nothing can reach a real server.
const namesStandIn = `(() => {
  const counts = ${JSON.stringify({ 3: PLACE_FEATURES.length, 5: 0, 6: 0, 7: 0 })};
  const pages = ${JSON.stringify({ 3: PLACE_FEATURES })};
  window.__refused = [];
  const real = window.fetch.bind(window);
  const json = (body) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  window.fetch = (input, init) => {
    const url = String(input && input.url ? input.url : input);
    const m = url.match(/geonames\\/MapServer\\/(\\d+)\\/query/);
    if (m) return json(/returnCountOnly=true/.test(url) ? { count: counts[m[1]] ?? 0 } : { features: pages[m[1]] ?? [] });
    if (url.includes('elevation.nationalmap.gov')) return json({ samples: [{ locationId: 0, value: 500 }] });
    if (url.includes('/map_indices/') && url.includes('/query')) return json({ features: [] });
    // The road and water name sources the default-on Roads layer asks for: nothing to label here.
    if (/\\/(transportation|nhd)\\/MapServer\\/\\d+\\/query/.test(url)) return json({ features: [] });
    if (url.includes('basemap.nationalmap.gov')) return Promise.resolve(new Response('', { status: 200 }));
    let origin = location.origin;
    try { origin = new URL(url, location.href).origin; } catch { /* relative */ }
    if (origin !== location.origin) { window.__refused.push(url.slice(0, 120)); return Promise.reject(new TypeError('refused: not stubbed')); }
    return real(input, init);
  };
})()`;

test('J10e: a name pin picked after a finder pick moves the near list to the pin', { skip }, async () => {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', { args: ['--hide-scrollbars'], viewport: { width: 1280, height: 900 } });
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: namesStandIn });
    await page.navigate(`${site.origin}/quiet-corners/`);
    await readyDashboard(page, { data: false });
    await chooseExampleArea(page);
    await page.evaluate("const n = document.getElementById('qcm-layer-names'); if (!n.checked) n.click(); document.getElementById('qcm-check').click(); void 0;");
    await waitInPage(page, 'name markers to render', "document.querySelectorAll('.qcm-name-marker').length > 0", 20000, null);
    await page.evaluate("document.getElementById('qcm-layer-panel').open = true; void 0;");
    await page.evaluate("document.querySelector('.qcm-layer-group[aria-label=\"Cameras\"]').open = true; void 0;");
    const title = () => text(page, '#qcm-camera-list-title');
    // The drawn area first; then the finder's pick.
    await press(page, '#qcm-camera-scope-near');
    await waitInPage(page, 'the drawn-area title', "document.getElementById('qcm-camera-list-title').textContent === 'Cameras near the drawn area'", 10000, null);
    await selectName(page, 'Finder Pick', [35.05, -83.47]);
    await waitInPage(page, 'the finder title', "document.getElementById('qcm-camera-list-title').textContent === 'Cameras near Finder Pick'", 10000, null);
    // A name pin is the reader's newer pick: the list follows it, and does not fall back to the drawn area.
    const pinName = await page.evaluate("(() => { const m = [...document.querySelectorAll('.qcm-name-marker')].find((el) => el.title !== 'Finder Pick'); return m ? m.title : null; })()");
    assert.ok(pinName, 'expected a placed name pin');
    await press(page, `.qcm-name-marker[title=${JSON.stringify(pinName)}]`);
    await waitInPage(page, 'the pin title', `document.getElementById('qcm-camera-list-title').textContent === ${JSON.stringify(`Cameras near ${pinName}`)}`, 10000, null);
    assert.equal(await title(), `Cameras near ${pinName}`);
    assert.deepEqual(await page.evaluate('window.__refused'), [], 'a request reached past the stand-in');
  } finally { page.close(); await site.close(); }
});

// QQA-16c: a keyboard user's place in the list survives a repaint.
const rowRefs = (page) => page.evaluate("[...document.querySelectorAll('#qcm-camera-list-rows button.qcm-camera-save')].map((b) => b.dataset.ref)");
const focusIn = (page) => page.evaluate(`(() => { const a = document.activeElement; const li = a && a.closest && a.closest('#qcm-camera-list-rows li');
  const save = li && li.querySelector('button.qcm-camera-save');
  return { ref: save ? save.dataset.ref : null, cls: a && a.className, id: a && a.id, tag: a && a.tagName }; })()`);

test('J10m: after a repaint the focus stays on the same camera row, and falls to the list when the row is gone, never to the page', { skip }, async () => {
  await withPage(GRID.slice(0, 40), async (page) => {
    await goToRoad(page);
    await press(page, '#qcm-layer-roadCameras');
    await waitStatus(page, /^40 cameras in this view\./, 'the list to count 40 cameras');
    // Focus the third row's button; a pan re-sorts the rows (nearest the new centre first).
    const before = await rowRefs(page);
    const target = await page.evaluate("(() => { const b = document.querySelectorAll('#qcm-camera-list-rows button.qcm-camera-list-row')[2]; b.focus(); return b.closest('li').querySelector('button.qcm-camera-save').dataset.ref; })()");
    await page.evaluate("(() => { const c = window.qcMap.getCenter(); window.qcMap.setView([c.lat + 0.06, c.lng], 9, { animate: false }); })(); void 0;");
    await waitInPage(page, 'the rows to re-sort', `(() => { const r = [...document.querySelectorAll('#qcm-camera-list-rows button.qcm-camera-save')].map((b) => b.dataset.ref); return r.length === ${before.length} && r.join() !== ${JSON.stringify(before.join())}; })()`, 10000, null);
    const sorted = await rowRefs(page);
    assert.ok(sorted.includes(target), 'the fixture should keep the focused camera in view');
    const kept = await focusIn(page);
    assert.equal(kept.ref, target, `focus left its row (now on ${JSON.stringify(kept)})`);
    assert.match(kept.cls, /qcm-camera-list-row/, 'focus should stay on the row button, not move to another control');
    // The same holds on a row's Save button.
    await page.evaluate(`document.querySelector('#qcm-camera-list-rows button.qcm-camera-save[data-ref=${JSON.stringify(target)}]').focus(); void 0;`);
    await page.evaluate("(() => { const c = window.qcMap.getCenter(); window.qcMap.setView([c.lat - 0.12, c.lng], 9, { animate: false }); })(); void 0;");
    await waitInPage(page, 'the rows to re-sort again', `[...document.querySelectorAll('#qcm-camera-list-rows button.qcm-camera-save')].map((b) => b.dataset.ref).join() !== ${JSON.stringify(sorted.join())}`, 10000, null);
    const saveKept = await focusIn(page);
    assert.equal(saveKept.ref, target, `focus left its Save button (now on ${JSON.stringify(saveKept)})`);
    assert.match(saveKept.cls, /qcm-camera-save/);
    // The row goes (the map moves to a place with no cameras): focus goes to the list, not to the page.
    await page.evaluate('window.qcMap.setView([35.0, -121.9], 9, { animate: false }); void 0;');
    await waitStatus(page, /^No cameras in this view\./, 'the none state');
    const gone = await focusIn(page);
    assert.equal(gone.id, 'qcm-camera-list-rows', `focus fell to ${JSON.stringify(gone)}`);
    assert.equal(await rowCount(page), 0);
  });
});

test('J10n: rows read as a list while each row stays a plain button, and a repaint of the same count says nothing', { skip }, async () => {
  await withPage(GRID.slice(0, 40), async (page) => {
    await goToRoad(page);
    await press(page, '#qcm-layer-roadCameras');
    await waitStatus(page, /^40 cameras in this view\./, 'the list to count 40 cameras');
    const shape = await page.evaluate(`(() => { const ul = document.getElementById('qcm-camera-list-rows');
      const li = ul.querySelector('li'); const b = li.querySelector('button.qcm-camera-list-row');
      return { role: ul.getAttribute('role'), items: ul.querySelectorAll(':scope > li').length, liRole: li.getAttribute('role'),
        buttonRole: b.getAttribute('role'), buttonTag: b.tagName, saveRole: li.querySelector('button.qcm-camera-save').getAttribute('role') }; })()`);
    assert.deepEqual(shape, { role: 'list', items: 40, liRole: null, buttonRole: null, buttonTag: 'BUTTON', saveRole: null });
    // The announcer holds the count; a filter flipped off and on in one tick, and a nudge, speak nothing.
    assert.equal(await text(page, '#qcm-camera-list-announce'), '40 cameras in this view.');
    await page.evaluate(`window.__spoken = []; new MutationObserver((m) => { for (const r of m) { if (r.type === 'characterData') window.__spoken.push(r.target.data); else if (r.addedNodes.length) window.__spoken.push(r.addedNodes[0].textContent); } })
      .observe(document.getElementById('qcm-camera-list-announce'), { childList: true, characterData: true, subtree: true }); void 0;`);
    await page.evaluate(`(() => { const c = window.qcMap.getCenter(); window.qcMap.setView([c.lat + 0.0005, c.lng], 9, { animate: false }); })(); void 0;`);
    await page.evaluate(`(() => { const b = document.querySelector('input[data-camera-purpose="roads"]'); b.click(); b.click(); })(); void 0;`);
    await page.evaluate('new Promise((r) => setTimeout(r, 1200))');
    assert.deepEqual(await page.evaluate('window.__spoken'), [], 'the count was announced again though it did not change');
    // A count that does change is announced, once.
    await press(page, 'input[data-camera-purpose="roads"]');
    await waitStatus(page, /40 cameras in this view are hidden by the purpose filter/, 'the filtered-out state');
    await press(page, 'input[data-camera-purpose="roads"]');
    await waitStatus(page, /^40 cameras in this view\./, 'the list to return');
    await page.evaluate('new Promise((r) => setTimeout(r, 300))');
    assert.deepEqual(await page.evaluate('window.__spoken'),
      ['40 cameras in this view are hidden by the purpose filter. Turn a purpose back on to list them.', '40 cameras in this view.']);
  });
});
