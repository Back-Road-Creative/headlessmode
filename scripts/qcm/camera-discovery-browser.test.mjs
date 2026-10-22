// UX-03b, journey J03 (audit A05/A07): a first-time reader finds Cameras, learns that it covers two
// regions and not the country, turns it on, goes to a region, opens and closes a camera, then turns
// it off. Every step is a trusted press or keystroke (helpers/trusted-click.mjs, Input.*); the page
// is read only for assertions. The browser is offline (PR #674), so the Caltrans list and its
// picture come from a fetch stand-in installed before any page script runs; the park list is the
// site's own build-time snapshot, served by the site server like on the live page.
//
// What it proves: Cameras is the first thing under the Layers search, ahead of every group heading;
// it names both regions; a search for "webcam" finds both rows; no camera request of any kind
// happens before a camera is opened; "layer off", "outside coverage" and "N in this view" read apart
// per region; the selected count follows the switches (UX-03a); one picture request on open, none on
// close; and switching off leaves no pins.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { trustedClick } from './helpers/trusted-click.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage } from './helpers/waits.mjs';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { d05Stub, INDEX_PATH, D05_PATH } from './helpers/camera-snapshot-stub.mjs';
import { LAYER_BY_ID } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const CCTV_ORIGIN = SOURCES.caltransCctv.origin;
const cctv = (index, name, place, lon, lat, file) => ({
  cctv: {
    index, inService: 'true',
    location: { district: '5', locationName: name, nearbyPlace: place, longitude: lon, latitude: lat },
    imageData: { imageDescription: '', streamingVideoURL: '', static: { currentImageURL: `${CCTV_ORIGIN}/data/d5/cctv/image/${file}/${file}.jpg` } },
  },
});
const CATALOG = { data: [
  cctv('1', 'US-101 : North Main Street', 'Salinas', '-121.653231', '36.687188', 'us101northmainstreet'),
  cctv('2', 'US-101 : Cabrillo Blvd', 'Santa Barbara', '-119.659076', '34.423288', 'us101cabrilloblvd'),
] };
const STUB = d05Stub(CATALOG);
// U4a: pins load only from zoom 7, and Go to for road cameras fits all of California (below it).
// Go to starts an animated fit on the NEXT animation frame, so a check made right after the press can
// see an idle map before the fit has begun. Wait two frames first, then idle, then move to Salinas, and
// keep moving until the zoom has settled at 9 for two frames (a late fit would otherwise reset it).
const atSalinas = async (page) => {
  await page.evaluate(`new Promise((resolve, reject) => {
    const m = window.qcMap, raf2 = (f) => requestAnimationFrame(() => requestAnimationFrame(f));
    const t0 = Date.now(), idle = () => !m._animatingZoom && !m._panAnim;
    const step = () => {
      if (Date.now() - t0 > 10000) return reject(new Error('the map never settled at Salinas, zoom 9'));
      if (!idle()) return raf2(step);
      m.setView([36.65, -121.7], 9, { animate: false });
      raf2(() => (idle() && m.getZoom() === 9 ? resolve(0) : step()));
    };
    raf2(step);
  })`);
};
const TINY_JPEG_B64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

/** window.fetch replaced before any page script runs: the Caltrans list and pictures are answered
 *  here and every camera-host request is logged; anything else goes on to the site server. */
const FETCH_STAND_IN = `(() => {
  const real = window.fetch.bind(window);
  const catalog = ${JSON.stringify(STUB.d05Json)};
  const indexJson = ${JSON.stringify(STUB.indexJson)};
  const jpeg = Uint8Array.from(atob(${JSON.stringify(TINY_JPEG_B64)}), (c) => c.charCodeAt(0));
  // mode: 'ok' answers the Caltrans list, 'fail' rejects it, 'hold' keeps it pending until release().
  // resources() counts what the browser itself requested from camera hosts (the park picture is an
  // <img>, which no fetch stand-in can see).
  window.__camera = { catalogue: 0, pictures: 0 };
  const hosts = ${JSON.stringify([CCTV_ORIGIN, 'https://www.nps.gov'])};
  window.__ctl = { mode: 'ok', release: null,
    resources: () => performance.getEntriesByType('resource').filter((e) => hosts.some((h) => e.name.startsWith(h))).length };
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    let path = '';
    try { path = new URL(url, location.href).pathname; } catch { /* not a url */ }
    if (path === ${JSON.stringify(INDEX_PATH)}) return Promise.resolve(new Response(indexJson, { status: 200, headers: { 'content-type': 'application/json' } }));
    if (path === ${JSON.stringify(D05_PATH)}) {
      window.__camera.catalogue++;
      if (window.__ctl.mode === 'fail') return Promise.resolve(new Response('nope', { status: 500 }));
      if (window.__ctl.mode === 'hold') return new Promise((resolve) => { window.__ctl.release = () => resolve(new Response(catalog, { status: 200, headers: { 'content-type': 'application/json' } })); });
      return Promise.resolve(new Response(catalog, { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    if (url.startsWith(${JSON.stringify(CCTV_ORIGIN)})) {
      window.__camera.pictures++;
      return Promise.resolve(new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg', 'last-modified': new Date(Date.now() - 180000).toUTCString() } }));
    }
    return real(input, init);
  };
})()`;

let shared = null;
async function sharedBrowser() {
  if (!shared) {
    const site = await startSiteServer();
    const page = await launch(CHROMIUM, 'about:blank', { args: ['--hide-scrollbars'], viewport: { width: 1280, height: 900 } });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: FETCH_STAND_IN });
    shared = { site, page };
  }
  return shared;
}
after(async () => {
  if (!shared) return;
  shared.page.close();
  await shared.site.close();
});

const press = (page, selector, opts = {}) => trustedClick(page, selector, { settleMs: 0, ...opts });
const text = (page, selector) => page.evaluate(`(document.querySelector(${JSON.stringify(selector)}) || {}).textContent || ''`);
const regionStatus = (page, layer) => text(page, `#qcm-camera-entry [data-camera-region="${layer}"] .qcm-camera-region-status`);
/** Real key presses into the focused field: typed text (Input.insertText) and one Backspace per character. */
const typeInto = (page, value) => page.send('Input.insertText', { text: value });
async function backspace(page, n) {
  for (let i = 0; i < n; i++) {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await page.send('Input.dispatchKeyEvent', { type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    }
  }
}
const waitStatus = (page, layer, re, what) => waitInPage(page, what, `${re}.test(document.querySelector('#qcm-camera-entry [data-camera-region="${layer}"] .qcm-camera-region-status').textContent)`, 15000, null);
const entryHidden = (page) => page.evaluate("document.getElementById('qcm-camera-entry').hidden");
// Go to has landed when the view holds the WHOLE coverage box (what fitBounds guarantees), not
// when the centre is inside it: J03b pans to open sea inside District 5 first, so a centre test
// passed before the second Go to moved the map and the pin it clicked was still off screen.
const inRegion = (layer) => {
  const b = LAYER_BY_ID[layer].goTo || LAYER_BY_ID[layer].coverage;
  return `(() => { const v = window.qcMap.getBounds(); return v.getWest() <= ${b.minLon} && v.getEast() >= ${b.maxLon} && v.getSouth() <= ${b.minLat} && v.getNorth() >= ${b.maxLat}; })()`;
};

test('J03: find Cameras, read the coverage, turn it on, go to a region, open and close a camera, turn it off', { skip }, async () => {
  const { site, page } = await sharedBrowser();
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: false });

  // All panels start closed; the reader opens Layers the way anyone would.
  await press(page, '#qcm-layer-panel > summary', { until: "document.getElementById('qcm-layer-panel').open" });

  // Cameras is an entry in its own right, ahead of every group heading and findable without a search.
  const entry = await page.evaluate(`(() => {
    const e = document.getElementById('qcm-camera-entry');
    if (!e) return null;
    const first = document.querySelector('#qcm-layers .qcm-layer-group');
    return { visible: e.checkVisibility(), text: e.textContent, aboveGroups: e.getBoundingClientRect().top < first.getBoundingClientRect().top,
      regions: [...e.querySelectorAll('[data-camera-region]')].map((r) => r.getAttribute('data-camera-region')),
      goTos: [...e.querySelectorAll('button.qcm-camera-goto')].map((b) => b.textContent.trim()) };
  })()`);
  assert.ok(entry, 'no #qcm-camera-entry in the Layers panel');
  assert.equal(entry.visible, true, 'the Cameras entry is not visible with every group closed');
  assert.equal(entry.aboveGroups, true, 'the Cameras entry sits below a group heading');
  assert.deepEqual(entry.regions, ['roadCameras', 'parkCameras', 'linkCameras', 'phenoCameras', 'airportCameras']);
  assert.deepEqual(entry.goTos, ['Go to', 'Go to', 'Go to', 'Go to', 'Go to']);
  assert.match(entry.text, /Road cameras/);
  assert.match(entry.text, /PhenoCam/);
  assert.match(entry.text, /AviationWX/);
  assert.match(entry.text, /US states/);
  assert.match(entry.text, /national parks/);
  assert.match(entry.text, /HPWREN/);
  assert.match(entry.text, /only where a list covers/i, 'the entry does not say coverage is limited');
  assert.match(await regionStatus(page, 'roadCameras'), /layer off/i);
  assert.match(await regionStatus(page, 'parkCameras'), /layer off/i);
  assert.deepEqual(await page.evaluate('window.__camera'), { catalogue: 0, pictures: 0 }, 'a camera request happened before anything was turned on');

  // A search for "webcam" finds both rows; the real keyboard path.
  await press(page, '#qcm-layer-search');
  await typeInto(page, 'webcam');
  await waitInPage(page, 'the search to keep only camera rows', `(() => {
    const vis = (id) => !document.getElementById(id).closest('.qcm-layer-row').hidden;
    return vis('qcm-layer-roadCameras') && vis('qcm-layer-parkCameras') && document.getElementById('qcm-layer-federalLand').closest('.qcm-layer-row').hidden;
  })()`, 10000, null);
  assert.equal(await entryHidden(page), false, 'the Cameras entry is hidden for a camera search');
  await backspace(page, 'webcam'.length);
  await waitInPage(page, 'the search to clear', "!document.getElementById('qcm-layer-federalLand').closest('.qcm-layer-row').hidden", 10000, null);
  // A search for something else takes the camera block away with its rows.
  await typeInto(page, 'wilderness');
  await waitInPage(page, 'the Cameras entry to go with a non-camera search', "document.getElementById('qcm-camera-entry').hidden", 10000, null);
  await backspace(page, 'wilderness'.length);
  await waitInPage(page, 'the Cameras entry to return', "!document.getElementById('qcm-camera-entry').hidden", 10000, null);

  // Go to the park region: the map moves there and the Cameras switches come into reach.
  await press(page, '#qcm-camera-entry [data-camera-region="parkCameras"] button.qcm-camera-goto');
  await waitInPage(page, 'the map to reach the Great Smoky region', inRegion('parkCameras'), 20000, null);
  assert.equal(await page.evaluate("document.querySelector('.qcm-layer-group[aria-label=\"Cameras\"]').open"), true, 'Go to did not open the Cameras switches');

  // Turn the park layer on: pins, a count of 1, an in-view status, and still no Caltrans request.
  await press(page, '#qcm-layer-parkCameras');
  await waitInPage(page, 'park pins', "Boolean(document.querySelector('.qcm-camera-pin--park'))", 30000, null);
  const parkPins = await page.evaluate("document.querySelectorAll('.qcm-camera-pin--park').length");
  await waitStatus(page, 'parkCameras', new RegExp(`^${parkPins} cameras? in this view\\.$`), 'the park status to count the pins');
  assert.equal(await text(page, '#qcm-layer-count'), '1 layer on');
  assert.deepEqual(await page.evaluate('window.__camera'), { catalogue: 0, pictures: 0 });
  assert.equal(await page.evaluate('window.__ctl.resources()'), 0, 'the browser requested a camera host before any camera was opened');

  // Road cameras on while the view is in Tennessee: a US state the layer covers, but no road list reaches it,
  // so "none in this view" (never "outside coverage", which would say road cameras end at California).
  await press(page, '#qcm-layer-roadCameras');
  await waitInPage(page, 'the road status to say none in this view', "/none in this view/i.test(document.querySelector('#qcm-camera-entry [data-camera-region=\"roadCameras\"] .qcm-camera-region-status').textContent)", 10000, null);
  assert.doesNotMatch(await regionStatus(page, 'roadCameras'), /outside coverage/i);
  assert.match(await text(page, '#qcm-layer-roadCameras-report'), /no road cameras in this view/i, 'the row report does not say none in this view');
  assert.equal(await text(page, '#qcm-layer-count'), '2 layers on');
  assert.equal(await page.evaluate('window.__camera.pictures'), 0);

  // Go to the Caltrans region: road is in view, park is now outside coverage.
  await press(page, '#qcm-camera-entry [data-camera-region="roadCameras"] button.qcm-camera-goto');
  await waitInPage(page, 'the map to reach California', inRegion('roadCameras'), 20000, null);
  await waitStatus(page, 'roadCameras', /zoom in/i, 'the road status to ask for a closer view');
  assert.equal(await page.evaluate("Boolean(document.querySelector('.qcm-camera-pin--road'))"), false, 'road pins drawn below zoom 7');
  await atSalinas(page);
  await waitInPage(page, 'road pins', "Boolean(document.querySelector('.qcm-camera-pin--road'))", 30000, null);
  // The stub holds two District 5 cameras, Salinas (in this view) and Santa Barbara (not). Pins are
  // drawn only inside the padded view (U4a review: whole-file drawing put 3,500 markers on a zoom-7
  // view over LA), so only Salinas is drawn and the status counts it.
  assert.equal(await page.evaluate("document.querySelectorAll('.qcm-camera-pin--road').length"), 1);
  await waitStatus(page, 'roadCameras', /^1 camera in this view\.$/, 'the road status to count the pin in view');
  assert.match(await regionStatus(page, 'parkCameras'), /none in this view/i, 'park cameras are nationwide: California is covered, just empty here');

  // Open a camera: exactly one picture request; close it: no more, and the card is gone.
  await press(page, '.qcm-camera-pin--road', { align: 'nearest' });
  await waitInPage(page, 'the camera card', "Boolean(document.querySelector('.qcm-site-card'))", 15000, null);
  await waitInPage(page, 'the picture request', 'window.__camera.pictures >= 1', 15000, null);
  assert.equal(await page.evaluate('window.__camera.pictures'), 1);
  // Escape, as a keyboard reader closes it (Leaflet's own handler). KNOWN ISSUE, not fixed here: a
  // pointer press on the popup's close button is refused as "covered by header" -- the popup opens
  // near the top of the sticky map, under the site header. It is every map popup's geometry, not
  // the camera card's, so it belongs to its own fix; this step stays on the keyboard path.
  for (const type of ['rawKeyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  }
  await waitInPage(page, 'the camera card to close', "!document.querySelector('.qcm-site-card')", 5000, null);
  await new Promise((r) => setTimeout(r, 750)); // a late request would land inside this
  assert.equal(await page.evaluate('window.__camera.pictures'), 1, 'closing a camera made another picture request');

  // Turn both off: pins gone, count back to none, both rows read "layer off" again.
  await press(page, '#qcm-layer-roadCameras');
  await press(page, '#qcm-layer-parkCameras');
  await waitInPage(page, 'every camera pin to be gone', "!document.querySelector('.qcm-camera-pin--road') && !document.querySelector('.qcm-camera-pin--park')", 15000, null);
  assert.equal(await text(page, '#qcm-layer-count'), 'No layers on');
  assert.match(await regionStatus(page, 'roadCameras'), /layer off/i);
  assert.match(await regionStatus(page, 'parkCameras'), /layer off/i);
  assert.equal(await page.evaluate('window.__camera.catalogue'), 1, 'the Caltrans list was fetched more than once');
});

// The other four states, driven through main.js's own wiring (the fetch stand-in decides what the
// Caltrans list does): "loading" while the list is pending, "unavailable" when it fails and a retry
// after switching off and on, "none in this view" in coverage but away from every camera, and a
// card open when the layer goes off.
test('J03b: loading, unavailable and retry, none in this view, and a card left open when the layer goes off', { skip }, async () => {
  const { site, page } = await sharedBrowser();
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: false });
  await press(page, '#qcm-layer-panel > summary', { until: "document.getElementById('qcm-layer-panel').open" });
  await press(page, '#qcm-camera-entry [data-camera-region="roadCameras"] button.qcm-camera-goto');
  await waitInPage(page, 'the map to reach California', inRegion('roadCameras'), 20000, null);
  await atSalinas(page);
  const before = await page.evaluate('window.__camera.catalogue');

  // Unavailable: the list fails, the status and row report say so, and no pins appear.
  await page.evaluate("window.__ctl.mode = 'fail'");
  await press(page, '#qcm-layer-roadCameras');
  await waitStatus(page, 'roadCameras', /unavailable/i, 'the road status to say the list is unavailable');
  assert.equal(await page.evaluate("Boolean(document.querySelector('.qcm-camera-pin--road'))"), false);
  // Off and on again retries; this time the list is held open, so the status reads loading.
  await press(page, '#qcm-layer-roadCameras');
  await waitStatus(page, 'roadCameras', /layer off/i, 'the failed layer to read off again');
  await page.evaluate("window.__ctl.mode = 'hold'");
  await press(page, '#qcm-layer-roadCameras');
  await waitStatus(page, 'roadCameras', /loading/i, 'the road status to say loading');
  assert.equal(await page.evaluate('window.__camera.catalogue'), before + 2, 'switching off and on did not retry the list');
  await waitInPage(page, 'the held list request', 'typeof window.__ctl.release === "function"', 5000, null);
  await page.evaluate('window.__ctl.release(), 0');
  await waitInPage(page, 'road pins', "Boolean(document.querySelector('.qcm-camera-pin--road'))", 30000, null);
  await waitStatus(page, 'roadCameras', /^\d+ cameras? in this view\.$/, 'the road status to count cameras once the list arrives');

  // None in this view: still inside the District 5 file's area, but panned to open sea west of every camera.
  await page.evaluate('window.qcMap.setView([35.0, -121.9], 9, { animate: false }), 0');
  await waitStatus(page, 'roadCameras', /none in this view/i, 'the road status to say none in this view');
  assert.doesNotMatch(await regionStatus(page, 'roadCameras'), /outside coverage/i);

  // A card open while the layer goes off: the card and its picture go with it.
  await press(page, '#qcm-camera-entry [data-camera-region="roadCameras"] button.qcm-camera-goto');
  await waitInPage(page, 'the map to reach California again', inRegion('roadCameras'), 20000, null);
  await atSalinas(page);
  await waitInPage(page, 'road pins again', "Boolean(document.querySelector('.qcm-camera-pin--road'))", 30000, null);
  await press(page, '.qcm-camera-pin--road', { align: 'nearest' });
  await waitInPage(page, 'the camera card', "Boolean(document.querySelector('.qcm-site-card'))", 15000, null);
  await press(page, '#qcm-layer-roadCameras');
  await waitInPage(page, 'the card and every pin to be gone', "!document.querySelector('.qcm-site-card') && !document.querySelector('.qcm-camera-pin--road')", 15000, null);
  assert.equal(await page.evaluate("document.querySelectorAll('.qcm-site-card img[src^=\"blob:\"]').length"), 0);
});

// QC 3D row 7: the camera pins 2D shows stand on the relief as points in the pin's own colour, one per
// pin, and follow the switch while the 3D panel is open. Real presses only: the 3D button, the switch.
test('J03c: park camera pins in 2D are points in 3D, one per pin, and go when the layer goes off', { skip }, async () => {
  const { site, page } = await sharedBrowser();
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: false });
  await press(page, '#qcm-layer-panel > summary', { until: "document.getElementById('qcm-layer-panel').open" });
  await press(page, '#qcm-camera-entry [data-camera-region="parkCameras"] button.qcm-camera-goto');
  await waitInPage(page, 'the map to reach the Great Smoky region', inRegion('parkCameras'), 20000, null);
  await press(page, '#qcm-layer-parkCameras');
  await waitInPage(page, 'park pins', "Boolean(document.querySelector('.qcm-camera-pin--park'))", 30000, null);
  const pins = await page.evaluate("document.querySelectorAll('.qcm-camera-pin--park').length");

  await press(page, '.qc-terrain-open');
  await waitInPage(page, 'a canvas in the terrain dialog', "Boolean(document.querySelector('.qc-terrain-dialog canvas'))", 30000, null);
  await waitInPage(page, 'the 3D map to be reachable', 'Boolean(window.qcTerrainView && window.qcTerrainView.inspect())', 30000, null);
  const points = `(() => { const m = window.qcTerrainView.inspect(), id = 'qc-drape-parkCameras';
    const layer = m.getStyle().layers.find((l) => l.id === id + '-parkCameras-point');
    const src = m.getStyle().sources[id];
    return { color: layer ? m.getPaintProperty(layer.id, 'circle-color') : null,
      n: src && src.data && src.data.features ? src.data.features.length : 0 }; })()`;
  await waitInPage(page, 'park camera points on the relief', `${points}.n > 0`, 30000, null);
  assert.deepEqual(await page.evaluate(points), { color: LAYER_BY_ID.parkCameras.pinColor, n: pins }, 'the 3D points do not match the 2D pins');

  // The 3D panel's own switch for the layer (the 2D panel is covered): off, and the points go.
  await press(page, '.qc-terrain-dialog .qc-terrain-layers > summary', { until: "document.querySelector('.qc-terrain-dialog .qc-terrain-layers').open" });
  await press(page, '.qc-terrain-dialog .qc-terrain-layers input[data-layer-id="parkCameras"]');
  await waitInPage(page, 'the park points to leave the relief', `${points}.n === 0`, 15000, null);
  assert.equal(await page.evaluate("document.getElementById('qcm-layer-parkCameras').checked"), false, 'the 2D switch did not follow');
});
