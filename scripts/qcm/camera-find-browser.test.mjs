// QQA-16b, journey J10 continued: a reader finds cameras. They save one from its row and it is still
// saved after a reload (kept in this browser only, never in the address, the title or a share link); a
// browser that blocks storage says saving is unavailable; a saved camera the operator's list no longer
// holds says so instead of vanishing; "Search this area" reads the camera files for the view only when
// pressed, states its radius and file bound, and the latest search wins; and below the pin zoom the list
// states counts per purpose from the loaded records instead of going empty.
//
// The browser is offline (helpers/browser.mjs launch). Every camera request is answered by a fetch
// stand-in installed before any page script runs: the stub index lists three small files around Salinas
// (the Caltrans District 5 file, a park file and a link-only file) and nothing else, so no other file can
// be asked for. Every press is a trusted CDP press; the page is read only for assertions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { trustedClick } from './helpers/trusted-click.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage } from './helpers/waits.mjs';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { findLeak } from './helpers/leak-check.mjs';
import { d05Stub, INDEX_PATH, D05_PATH, CAMERA_DIR } from './helpers/camera-snapshot-stub.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const CCTV_ORIGIN = SOURCES.caltransCctv.origin;
const SALINAS = [36.65, -121.7];
const SAVED_KEY = 'qc-saved-places';
const cctv = (index, name, lon, lat) => ({
  cctv: {
    index: String(index), inService: 'true',
    location: { district: '5', locationName: name, nearbyPlace: 'Salinas', longitude: String(lon), latitude: String(lat) },
    imageData: { imageDescription: '', streamingVideoURL: '', static: { currentImageURL: `${CCTV_ORIGIN}/data/d5/cctv/image/c${index}/c${index}.jpg` } },
  },
});
const ROADS = Array.from({ length: 40 }, (_, i) => ({ i, lat: +(36.5 + (i % 8) * 0.03).toFixed(5), lon: +(-121.85 + Math.floor(i / 8) * 0.06).toFixed(5) }));
const catalog = { data: ROADS.map((g) => cctv(g.i + 1, `US-101 : Spot ${g.i}`, g.lon, g.lat)) };

const NPS_PATH = `${CAMERA_DIR}/nps-webcams/nps-test.json`;
const LINK_PATH = `${CAMERA_DIR}/hpwren/hpwren-test.json`;
const FIELDS = ['providerId', 'name', 'lat', 'lon', 'still', 'health', 'subject', 'officialUrl'];
const NPS_ROWS = [['T-1', 'Test Ridge Webcam', 36.6, -121.75], ['T-2', 'Test Creek Webcam', 36.7, -121.65], ['T-3', 'Test Gap Webcam', 36.62, -121.6]]
  .map(([id, name, lat, lon]) => [id, name, lat, lon, 'https://www.nps.gov/featurecontent/ard/webcams/images/t.jpg', 'active', 'Visit webcam page.', 'https://www.nps.gov/media/webcam/view.htm?id=' + id]);
const LINK_ROWS = [['L-1', 'Test Lookout North', 36.72, -121.8], ['L-2', 'Test Lookout South', 36.55, -121.55]]
  .map(([id, name, lat, lon]) => [id, name, lat, lon, null, 'active', 'Cameras: ' + name, 'https://www.hpwren.ucsd.edu/cameras/']);
const header = (provider, layer, region, operator, officialUrl, category) => ({
  schema: 1, provider, layer, region, regionName: region, generatedAt: '2026-10-04T16:00:00.000Z', source: null, operator, officialUrl,
  attribution: operator, rights: 'unverified', category, fields: FIELDS });
const rowsBox = (rows) => ({ minLon: Math.min(...rows.map((r) => r[3])), minLat: Math.min(...rows.map((r) => r[2])), maxLon: Math.max(...rows.map((r) => r[3])), maxLat: Math.max(...rows.map((r) => r[2])) });

function fixture() {
  const stub = d05Stub(catalog);
  const real = JSON.parse(stub.indexJson);
  const d05 = real.files.find((f) => f.region === 'ca-d05');
  const files = [d05,
    { file: 'nps-webcams/nps-test.json', provider: 'nps-webcams', layer: 'parkCameras', region: 'nps-test', regionName: 'nps-test', bbox: rowsBox(NPS_ROWS), count: NPS_ROWS.length, generatedAt: d05.generatedAt },
    { file: 'hpwren/hpwren-test.json', provider: 'hpwren', layer: 'linkCameras', region: 'hpwren-test', regionName: 'hpwren-test', bbox: rowsBox(LINK_ROWS), count: LINK_ROWS.length, generatedAt: d05.generatedAt }];
  return {
    indexJson: JSON.stringify({ schema: 1, files }), d05Json: stub.d05Json,
    npsJson: JSON.stringify({ ...header('nps-webcams', 'parkCameras', 'nps-test', 'National Park Service', 'https://www.nps.gov/', 'scenic'), rows: NPS_ROWS }),
    linkJson: JSON.stringify({ ...header('hpwren', 'linkCameras', 'hpwren-test', 'HPWREN', 'https://www.hpwren.ucsd.edu/cameras/', 'fire'), rows: LINK_ROWS }),
  };
}

/** window.fetch replaced before any page script runs. Camera paths are answered here and logged in
 *  window.__paths; anything else goes on to the site server. mode 'hold' keeps the District 5 file open
 *  until window.__ctl.release() is called. */
const standIn = (f) => `(() => {
  const real = window.fetch.bind(window);
  window.__paths = [];
  // QQA-16c: every fetch, XHR and beacon the page makes (url and body), so a test can prove what was never sent.
  window.__reqs = [];
  let idx = 'ok'; try { idx = sessionStorage.getItem('qcm-test-index-mode') || 'ok'; } catch { /* storage blocked */ }
  let fmode = 'ok'; try { fmode = sessionStorage.getItem('qcm-test-file-mode') || 'ok'; } catch { /* storage blocked */ }
  window.__ctl = { mode: 'ok', indexMode: idx, fileMode: fmode, release: null };
  // A body is read in whatever form it was sent: text, form fields, bytes, a Blob, a Request's own body.
  // Async reads fill the entry in a moment; a test waits before it reads window.__reqs.
  const bodyText = (b) => {
    if (b == null) return '';
    if (typeof b === 'string') return b;
    if (b instanceof FormData) return Promise.all([...b.entries()].map(async ([k, v]) => k + '=' + (typeof v === 'string' ? v : v.name + ':' + await v.text()))).then((p) => p.join('&'));
    if (b instanceof Blob) return b.text();
    if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return new TextDecoder().decode(b);
    if (b instanceof ReadableStream) return '[stream body: not readable here]';
    return String(b);
  };
  const note = (u, b) => {
    const entry = { url: String(u), body: '' };
    window.__reqs.push(entry);
    Promise.resolve(b).then(bodyText).then((t) => { entry.body = t; }, () => { entry.body = '[body not readable]'; });
  };
  const xOpen = XMLHttpRequest.prototype.open, xSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__u = u; return xOpen.call(this, m, u, ...r); };
  XMLHttpRequest.prototype.send = function (b) { note(this.__u, b); return xSend.call(this, b); };
  if (navigator.sendBeacon) { const beacon = navigator.sendBeacon.bind(navigator); navigator.sendBeacon = (u, d) => { note(u, d); return beacon(u, d); }; }
  const json = (text) => new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
  const answers = { ${JSON.stringify(INDEX_PATH)}: ${JSON.stringify(f.indexJson)}, ${JSON.stringify(NPS_PATH)}: ${JSON.stringify(f.npsJson)}, ${JSON.stringify(LINK_PATH)}: ${JSON.stringify(f.linkJson)} };
  window.fetch = (input, init) => {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const url = isRequest ? input.url : String(input);
    note(url, init && init.body != null ? init.body : isRequest && !input.bodyUsed ? input.clone().blob() : null);
    let path = '';
    try { path = new URL(url, location.href).pathname; } catch { /* not a url */ }
    if (path.startsWith(${JSON.stringify(CAMERA_DIR)})) window.__paths.push(path);
    if (path.startsWith('/__leak-probe')) return Promise.resolve(new Response('', { status: 204 }));   // J10x's controls
    if (path === ${JSON.stringify(INDEX_PATH)} && window.__ctl.indexMode === 'fail') return Promise.resolve(new Response('nope', { status: 500 }));
    if (answers[path]) return Promise.resolve(json(answers[path]));
    if (path === ${JSON.stringify(D05_PATH)}) {
      if (window.__ctl.fileMode === 'fail') return Promise.resolve(new Response('nope', { status: 500 }));
      if (window.__ctl.mode === 'hold') return new Promise((resolve) => { window.__ctl.release = () => resolve(json(${JSON.stringify(f.d05Json)})); });
      return Promise.resolve(json(${JSON.stringify(f.d05Json)}));
    }
    if (url.startsWith(${JSON.stringify(CCTV_ORIGIN)})) return Promise.resolve(new Response(new Uint8Array(0), { status: 404 }));
    return real(input, init);
  };
})()`;

const press = (page, selector, opts = {}) => trustedClick(page, selector, { settleMs: 0, ...opts });
const text = (page, selector) => page.evaluate(`(document.querySelector(${JSON.stringify(selector)}) || {}).textContent || ''`);
const waitText = (page, selector, re, what) => waitInPage(page, what, `${re}.test((document.querySelector(${JSON.stringify(selector)}) || {}).textContent || '')`, 20000, null);
const waitStatus = (page, re, what) => waitText(page, '#qcm-camera-list-status', re, what);
const rowCount = (page) => page.evaluate("document.querySelectorAll('#qcm-camera-list-rows li').length");
const atView = (page, center, zoom) => page.evaluate(`(() => { window.qcMap.setView(${JSON.stringify(center)}, ${zoom}, { animate: false }); })(); void 0;`);
// The centre the map holds is only as exact as its pixels, so a search names the centre it read.
const centreText = (page) => page.evaluate("(() => { const c = window.qcMap.getCenter(); return `${c.lat.toFixed(2)}, ${c.lng.toFixed(2)}`; })()");
const escaped = (t) => t.replace(/[.]/g, '\\.');
const openCameras = async (page) => {
  await press(page, '#qcm-layer-panel > summary', { until: "document.getElementById('qcm-layer-panel').open" });
  await press(page, '.qcm-layer-group[aria-label="Cameras"] > summary', { until: "document.querySelector('.qcm-layer-group[aria-label=\"Cameras\"]').open" });
};

async function withPage(fn, { before = '' } = {}) {
  const f = fixture();
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', { args: ['--hide-scrollbars'], viewport: { width: 1280, height: 900 } });
  try {
    if (before) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: before });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: standIn(f) });
    await page.navigate(`${site.origin}/quiet-corners/`);
    await readyDashboard(page, { data: false });
    await openCameras(page);
    return await fn(page, { site, f });
  } finally { page.close(); await site.close(); }
}

test('J10f: a camera saved from its row is still saved after a reload, kept only in this browser, and a gone one says so', { skip }, async () => {
  await withPage(async (page, { site }) => {
    await atView(page, SALINAS, 9);
    await press(page, '#qcm-layer-roadCameras');
    await waitStatus(page, /^40 cameras in this view\./, 'the 40 road cameras');
    const title = await page.evaluate('document.title');
    // Save from the first row: the button names the camera, flips to Saved, and writes one ref.
    const label = await page.evaluate("document.querySelector('#qcm-camera-list-rows button.qcm-camera-save').getAttribute('aria-label')");
    assert.match(label, /^Save US-101 : Spot \d+$/);
    await press(page, '#qcm-camera-list-rows button.qcm-camera-save');
    await waitInPage(page, 'the row to read Saved', "/Saved/.test(document.querySelector('#qcm-camera-list-rows button.qcm-camera-save').textContent)", 10000, null);
    const stored = JSON.parse(await page.evaluate(`localStorage.getItem(${JSON.stringify(SAVED_KEY)})`));
    assert.equal(stored.places.length, 1);
    const ref = stored.places[0].ref;
    assert.match(ref, /^camera:caltrans-cwwp2:d05:\d+$/, 'saved by source and stable id');
    // Never in the address, the title, or a share link.
    const where = await page.evaluate('({ href: location.href, title: document.title })');
    assert.ok(!where.href.includes('camera') && !where.href.includes(encodeURIComponent(ref)), `the address carries the saved camera: ${where.href}`);
    assert.equal(where.title, title);
    // A saved camera the operator's list no longer holds, added to the store the way an older visit left it.
    await page.evaluate(`(() => { const e = JSON.parse(localStorage.getItem(${JSON.stringify(SAVED_KEY)}));
      e.places.push({ ref: 'camera:caltrans-cwwp2:d05:99999', name: 'Gone Cam', kind: 'camera', lat: 36.6, lon: -121.7, state: null, county: null, savedAt: '2026-10-01T00:00:00.000Z' });
      localStorage.setItem(${JSON.stringify(SAVED_KEY)}, JSON.stringify(e)); })(); void 0;`);
    // Reload: nothing is loaded, yet the Saved scope lists both, one found and one said to be gone.
    await page.navigate(`${site.origin}/quiet-corners/`);
    await readyDashboard(page, { data: false });
    await openCameras(page);
    assert.deepEqual(await page.evaluate('window.__paths'), [], 'a reload with the list closed asked for no camera file');
    await press(page, '#qcm-camera-scope-saved');
    await waitStatus(page, /^2 saved cameras, stored only in this browser\./, 'the saved count');
    assert.match(await text(page, '#qcm-camera-list-notes'), /1 is no longer in the camera list/);
    const rows = await page.evaluate("[...document.querySelectorAll('#qcm-camera-list-rows li')].map((li) => li.textContent)");
    assert.equal(rows.length, 2);
    assert.ok(rows.some((r) => /US-101 : Spot \d+/.test(r) && /Caltrans/.test(r)), `no found row: ${rows.join(' | ')}`);
    assert.ok(rows.some((r) => /Gone Cam/.test(r) && /no longer in the camera list/.test(r)), `no gone row: ${rows.join(' | ')}`);
    assert.equal(await page.evaluate("document.querySelectorAll('#qcm-camera-list-rows button.qcm-camera-list-row').length"), 1, 'a gone camera has nothing to open');
    // Opening the found one shows the same card, whose Save button agrees.
    await press(page, '#qcm-camera-list-rows button.qcm-camera-list-row');
    await waitInPage(page, 'the card to say Saved', "Array.from(document.querySelectorAll('.qcm-site-card-action')).some((b) => /Saved/.test(b.textContent))", 20000, null);
    // Remove the gone one from the list: it leaves the store and the list.
    await press(page, '#qcm-camera-list-rows li:last-child button.qcm-camera-save');
    await waitStatus(page, /^1 saved camera, stored only in this browser\./, 'one saved camera');
    assert.equal(JSON.parse(await page.evaluate(`localStorage.getItem(${JSON.stringify(SAVED_KEY)})`)).places.length, 1);
    // Saved ones are nothing the map's own state carries.
    assert.ok(!(await page.evaluate('location.href')).includes('camera'));
  });
});

const BLOCK_METHODS = `(() => { const boom = () => { throw new DOMException('blocked', 'SecurityError'); };
  Storage.prototype.getItem = boom; Storage.prototype.setItem = boom; Storage.prototype.removeItem = boom; })()`;
const BLOCK_ACCESSOR = `Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } })`;

for (const [name, before] of [['storage methods that throw', BLOCK_METHODS], ['a storage accessor that throws', BLOCK_ACCESSOR]]) {
  test(`J10g: with ${name} the list says saving is unavailable and saves nothing`, { skip }, async () => {
    await withPage(async (page) => {
      await atView(page, SALINAS, 9);
      await press(page, '#qcm-layer-roadCameras');
      await waitStatus(page, /^40 cameras in this view\./, 'the 40 road cameras');
      // In every scope the list says saving is off, and the row buttons cannot pretend to save.
      await waitText(page, '#qcm-camera-list-saving', /Saving unavailable: this browser is blocking site storage/, 'the saving-unavailable note');
      assert.equal(await page.evaluate("document.getElementById('qcm-camera-list-saving').hidden"), false);
      const first = await page.evaluate("(() => { const b = document.querySelector('#qcm-camera-list-rows button.qcm-camera-save'); return { disabled: b.disabled, title: b.title, text: b.textContent }; })()");
      assert.equal(first.disabled, true);
      assert.match(first.title, /Saving unavailable/);
      assert.doesNotMatch(first.text, /Saved/);
      await press(page, '#qcm-camera-scope-saved');
      await waitStatus(page, /^Saving unavailable: this browser is blocking site storage/, 'the Saved scope to say so');
      assert.equal(await page.evaluate('document.getElementById("qcm-camera-list-status").getAttribute("data-status")'), 'saving-unavailable');
      assert.equal(await rowCount(page), 0);
    }, { before });
  });
}

test('J10h: Search this area reads the files for the view only when pressed, says its radius and bound, and the latest search wins', { skip }, async () => {
  await withPage(async (page) => {
    await atView(page, SALINAS, 5);
    await press(page, '#qcm-layer-roadCameras');
    await waitStatus(page, /zoom in to list cameras/i, 'the zoom-in state');
    // The bound and the radius are on the page before anything is pressed.
    const hint = await text(page, '#qcm-camera-search-hint');
    assert.match(hint, /within 100 km of its centre/);
    assert.match(hint, /at most 20 files/);
    assert.equal(await page.evaluate("document.getElementById('qcm-camera-search').tagName"), 'BUTTON');
    // Panning is not a search.
    await atView(page, [36.0, -120.5], 5);
    await atView(page, SALINAS, 5);
    await page.evaluate('new Promise((r) => setTimeout(r, 500))');
    assert.deepEqual(await page.evaluate('window.__paths.filter((p) => !p.endsWith("index.json"))'), [], 'a pan asked for a camera file');
    // Held open, a first search then a second from another centre: one request, and the later one speaks.
    await page.evaluate("window.__ctl.mode = 'hold'");
    const first = await centreText(page);
    await press(page, '#qcm-camera-search');
    await waitText(page, '#qcm-camera-search-status', new RegExp(`^Searching within 100 km of ${escaped(first)}\\.`), 'the first search to be pending');
    await atView(page, [36.0, -120.5], 5);
    const second = await centreText(page);
    assert.notEqual(second, first);
    await press(page, '#qcm-camera-search');
    await waitText(page, '#qcm-camera-search-status', new RegExp(`^Searching within 100 km of ${escaped(second)}\\.`), 'the second search to take over');
    await waitInPage(page, 'the held request', 'typeof window.__ctl.release === "function"', 10000, null);
    await page.evaluate('window.__ctl.release(), 0');
    await waitText(page, '#qcm-camera-search-status', new RegExp(`^Searched within 100 km of ${escaped(second)}: 1 of 1 camera files read\\.$`), 'the latest search to finish');
    assert.deepEqual(await page.evaluate('window.__paths.filter((p) => !p.endsWith("index.json"))'), [D05_PATH], 'one request set, shared by both searches');
    // The files read are the ones near the centre; nothing else was asked for.
    assert.equal(await page.evaluate('window.__paths.filter((p) => p.endsWith("index.json")).length'), 1);
  });
});

test('J10i: below the pin zoom the list counts the loaded records per purpose, and zooming in lists them', { skip }, async () => {
  await withPage(async (page, { f }) => {
    await atView(page, SALINAS, 5);
    for (const id of ['roadCameras', 'parkCameras', 'linkCameras']) await press(page, `#qcm-layer-${id}`);
    await waitStatus(page, /zoom in to list cameras/i, 'the zoom-in state before any search');
    assert.equal(await rowCount(page), 0);
    await press(page, '#qcm-camera-search');
    const where = await centreText(page);
    await waitText(page, '#qcm-camera-search-status', new RegExp(`^Searched within 100 km of ${escaped(where)}: 3 of 3 camera files read\\.$`), 'the search to read three files');
    assert.deepEqual((await page.evaluate('window.__paths.filter((p) => !p.endsWith("index.json")).sort()')),
      [LINK_PATH, NPS_PATH, D05_PATH].sort(), 'one request set: each file once');
    // Expected counts come from the records the stand-in served, not from anything the page drew.
    const view = await page.evaluate('(() => { const b = window.qcMap.getBounds(); return { minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth() }; })()');
    const inView = (lat, lon) => lat >= view.minLat && lat <= view.maxLat && lon >= view.minLon && lon <= view.maxLon;
    const roads = ROADS.filter((g) => inView(g.lat, g.lon)).length + LINK_ROWS.filter((r) => inView(r[2], r[3])).length;
    const scenery = NPS_ROWS.filter((r) => inView(r[2], r[3])).length;
    assert.equal(roads + scenery, ROADS.length + LINK_ROWS.length + NPS_ROWS.length, 'the fixture should sit wholly inside the zoom-5 view');
    await waitStatus(page, new RegExp(`^${roads + scenery} cameras loaded in this view at this zoom: ${roads} Roads, ${scenery} Scenery & parks\\.`), 'the cluster summary');
    assert.equal(await page.evaluate('document.getElementById("qcm-camera-list-status").getAttribute("data-status")'), 'cluster');
    assert.equal(await rowCount(page), 0, 'a cluster summary lists no rows');
    assert.equal(await text(page, '[data-camera-purpose-count="roads"]'), `(${roads})`);
    assert.equal(await text(page, '[data-camera-purpose-count="scenery"]'), `(${scenery})`);
    assert.equal(await page.evaluate("document.querySelectorAll('.qcm-camera-pin').length"), 0, 'no pin is drawn below the pin zoom');
    // Zoom in: the same records are now listed one by one, and the counts agree.
    await atView(page, SALINAS, 9);
    await waitStatus(page, /^\d+ cameras in this view\./, 'the list at zoom 9');
    const listed = await page.evaluate("document.querySelectorAll('#qcm-camera-list-rows li').length");
    const inNine = await page.evaluate('(() => { const b = window.qcMap.getBounds(); return { minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth() }; })()');
    const all = [...ROADS.map((g) => [g.lat, g.lon]), ...LINK_ROWS.map((r) => [r[2], r[3]]), ...NPS_ROWS.map((r) => [r[2], r[3]])];
    const expected = all.filter(([lat, lon]) => lat >= inNine.minLat && lat <= inNine.maxLat && lon >= inNine.minLon && lon <= inNine.maxLon).length;
    assert.equal(listed, expected);
    assert.ok(f.indexJson.length > 0);
  });
});

const FIRST_ROW_SAVE = '#qcm-camera-list-rows li:first-child button.qcm-camera-save';
const cardLabel = (page) => page.evaluate("(document.querySelector('.qcm-site-card-action') || {}).textContent || ''");
const cardStatus = (page) => page.evaluate("(document.querySelector('.qcm-site-card-status') || {}).textContent || ''");
const storedRefs = async (page) => (JSON.parse(await page.evaluate(`localStorage.getItem(${JSON.stringify(SAVED_KEY)}) || '{"places":[]}'`)).places || []).map((p) => p.ref);
const waitCardLabel = (page, re, what) => waitInPage(page, what, `${re}.test((document.querySelector('.qcm-site-card-action') || {}).textContent || '')`, 10000, null);

test('J10j: a camera card open while its row is saved or unsaved reads what the store says, and its button never lies', { skip }, async () => {
  await withPage(async (page) => {
    await atView(page, SALINAS, 9);
    await press(page, '#qcm-layer-roadCameras');
    await waitStatus(page, /^40 cameras in this view\./, 'the 40 road cameras');
    await press(page, '#qcm-camera-list-rows li:first-child button.qcm-camera-list-row');
    await waitCardLabel(page, /^Save camera$/, 'the card to read Save camera');
    // Saved from the row while the card is open: the card follows without being reopened.
    await press(page, FIRST_ROW_SAVE);
    await waitCardLabel(page, /^Saved — remove$/, 'the open card to read Saved');
    assert.equal((await storedRefs(page)).length, 1);
    // Pressing the card now removes the camera and says so (it used to claim a save that was already there).
    await press(page, '.qcm-site-card-action');
    await waitInPage(page, 'the removal to be said', "/Removed from saved places/.test((document.querySelector('.qcm-site-card-status') || {}).textContent || '')", 10000, null);
    assert.equal((await storedRefs(page)).length, 0);
    assert.equal(await cardLabel(page), 'Save camera');
    // Saved from the card, then removed from the row: the card follows the other way.
    await press(page, '.qcm-site-card-action');
    await waitCardLabel(page, /^Saved — remove$/, 'the card to read Saved after its own press');
    await press(page, FIRST_ROW_SAVE);
    await waitCardLabel(page, /^Save camera$/, 'the open card to read Save camera after the row removed it');
    assert.equal((await storedRefs(page)).length, 0);
    // Pressing it saves (it used to remove nothing and say it had).
    await press(page, '.qcm-site-card-action');
    await waitInPage(page, 'the save to be said', "/^Saved\\.$/.test((document.querySelector('.qcm-site-card-status') || {}).textContent || '')", 10000, null);
    assert.equal((await storedRefs(page)).length, 1);
    assert.equal(await cardLabel(page), 'Saved — remove');
    assert.notEqual(await cardStatus(page), 'Already saved.');
  });
});

test('J10k: a camera saved under an old id reads Saved on its row and card, is not saved twice, and is removed whole', { skip }, async () => {
  await withPage(async (page, { site }) => {
    await atView(page, SALINAS, 9);
    await press(page, '#qcm-layer-roadCameras');
    await waitStatus(page, /^40 cameras in this view\./, 'the 40 road cameras');
    const current = await page.evaluate("document.querySelector('#qcm-camera-list-rows li:first-child button.qcm-camera-save').dataset.ref");
    assert.match(current, /^camera:caltrans-cwwp2:d05:\d+$/);
    // The ref an older visit stored: a bare District 5 index, no `d05:`. Saved through the page, then
    // rewritten in place, so the envelope is the store's own.
    const old = current.replace(':d05:', ':');
    await press(page, FIRST_ROW_SAVE);
    await waitInPage(page, 'the save to land', `localStorage.getItem(${JSON.stringify(SAVED_KEY)}) !== null`, 10000, null);
    await page.evaluate(`(() => { const e = JSON.parse(localStorage.getItem(${JSON.stringify(SAVED_KEY)}));
      e.places[0].ref = ${JSON.stringify(old)}; localStorage.setItem(${JSON.stringify(SAVED_KEY)}, JSON.stringify(e)); })(); void 0;`);
    assert.deepEqual(await storedRefs(page), [old]);
    await page.navigate(`${site.origin}/quiet-corners/`);
    await readyDashboard(page, { data: false });
    await openCameras(page);
    await atView(page, SALINAS, 9);
    await press(page, '#qcm-layer-roadCameras');
    await waitStatus(page, /^40 cameras in this view\./, 'the 40 road cameras after the reload');
    const row = `#qcm-camera-list-rows button.qcm-camera-save[data-ref="${current}"]`;
    await waitInPage(page, 'the old-id camera to read Saved', `/^Saved$/.test((document.querySelector(${JSON.stringify(row)}) || {}).textContent || '')`, 10000, null);
    assert.match(await page.evaluate(`document.querySelector(${JSON.stringify(row)}).getAttribute('aria-label')`), /^Remove /);
    // Its card agrees.
    await press(page, `#qcm-camera-list-rows li:has(button.qcm-camera-save[data-ref="${current}"]) button.qcm-camera-list-row`);
    await waitCardLabel(page, /^Saved — remove$/, 'the card to read Saved for the old id');
    // The Saved scope lists it once.
    await press(page, '#qcm-camera-scope-saved');
    await waitStatus(page, /^1 saved camera, stored only in this browser\./, 'one saved camera');
    assert.equal(await rowCount(page), 1);
    await press(page, '#qcm-camera-scope-view');
    await waitStatus(page, /^40 cameras in this view\./, 'the view list again');
    // Removing it from the row removes the stored old ref, and a second press saves it once, under the current ref.
    await press(page, row);
    await waitInPage(page, 'the row to read Save', `/^Save$/.test((document.querySelector(${JSON.stringify(row)}) || {}).textContent || '')`, 10000, null);
    assert.deepEqual(await storedRefs(page), []);
    await press(page, row);
    await waitInPage(page, 'the row to read Saved', `/^Saved$/.test((document.querySelector(${JSON.stringify(row)}) || {}).textContent || '')`, 10000, null);
    assert.deepEqual(await storedRefs(page), [current]);
  });
});

// QQA-16c: what a reader hears, how a search ends when something throws, how the Saved scope retries,
// and what is never sent.
const indexReads = (page) => page.evaluate('window.__paths.filter((p) => p.endsWith("index.json")).length');
const d05Reads = (page) => page.evaluate(`window.__paths.filter((p) => p === ${JSON.stringify(D05_PATH)}).length`);

test('J10p: one Search press makes two announcements, the search\'s own, and the list stays quiet until it has an answer', { skip }, async () => {
  await withPage(async (page) => {
    await atView(page, SALINAS, 5);
    for (const id of ['roadCameras', 'parkCameras', 'linkCameras']) await press(page, `#qcm-layer-${id}`);
    await waitStatus(page, /zoom in to list cameras/i, 'the zoom-in state before any search');
    // Every write into a live region of the list, by region (the text added, not read later).
    await page.evaluate(`window.__spoken = []; new MutationObserver((m) => { for (const r of m) {
      const node = r.target.nodeType === 3 ? r.target.parentElement : r.target;
      const region = node && node.closest && node.closest('[aria-live]');
      if (!region || r.type === 'attributes') continue;
      const said = r.type === 'characterData' ? r.target.data : (r.addedNodes[0] || {}).textContent;
      if (said) window.__spoken.push({ region: region.id === 'qcm-camera-search-status' ? 'search' : 'list', said });
    } }).observe(document.getElementById('qcm-camera-list'), { childList: true, characterData: true, subtree: true }); void 0;`);
    await page.evaluate("window.__ctl.mode = 'hold'");
    await press(page, '#qcm-camera-search');
    await waitText(page, '#qcm-camera-search-status', /^Searching within 100 km/, 'the search to be pending');
    await page.evaluate('new Promise((r) => setTimeout(r, 400))');
    assert.deepEqual(await page.evaluate("window.__spoken.filter((s) => s.region === 'list')"), [], 'the list spoke while a search was pending');
    await waitInPage(page, 'the held request', 'typeof window.__ctl.release === "function"', 10000, null);
    await page.evaluate('window.__ctl.release(), 0');
    await waitText(page, '#qcm-camera-search-status', /^Searched within 100 km .*: 3 of 3 camera files read\.$/, 'the search to finish');
    await waitStatus(page, /^\d+ cameras loaded in this view at this zoom:/, 'the cluster summary');
    await page.evaluate('new Promise((r) => setTimeout(r, 400))');
    const spoken = await page.evaluate('window.__spoken');
    assert.equal(spoken.filter((s) => s.region === 'search').length, 2, `the search spoke ${JSON.stringify(spoken)}`);
    const list = spoken.filter((s) => s.region === 'list');
    assert.equal(list.length, 1, `the list spoke ${JSON.stringify(list)}`);
    assert.match(list[0].said, /^\d+ cameras loaded in this view at this zoom:/);
    assert.ok(!spoken.some((s) => /Loading the camera list/.test(s.said)), 'a Loading line was read out for a search');
  });
});

test('J10q: a failure after the index read ends the search honestly, clears the pending state, and a new press works', { skip }, async () => {
  await withPage(async (page) => {
    await atView(page, SALINAS, 5);
    await press(page, '#qcm-layer-roadCameras');
    await waitStatus(page, /zoom in to list cameras/i, 'the zoom-in state');
    // The first Promise.allSettled the page makes after this (the search's file reads) throws once.
    await page.evaluate(`(() => { const real = Promise.allSettled; Promise.allSettled = function (...a) { Promise.allSettled = real; throw new Error('forced failure'); }; })(); void 0;`);
    await press(page, '#qcm-camera-search');
    const where = await centreText(page);
    await waitText(page, '#qcm-camera-search-status', new RegExp(`^Searched within 100 km of ${escaped(where)}: the search did not finish\\. Press the button to try again\\.$`), 'the search to say it failed');
    assert.doesNotMatch(await text(page, '#qcm-camera-search-status'), /^Searching/);
    await waitStatus(page, /zoom in to list cameras/i, 'the list to leave Loading');
    assert.doesNotMatch(await text(page, '#qcm-camera-list-status'), /Loading the camera list/);
    assert.equal(await page.evaluate("document.getElementById('qcm-camera-search').disabled"), false);
    // Pressing again searches properly.
    await press(page, '#qcm-camera-search');
    await waitText(page, '#qcm-camera-search-status', new RegExp(`^Searched within 100 km of ${escaped(where)}: 1 of 1 camera files read\\.$`), 'the second search to finish');
  });
});

/** One saved camera from the list, plus a second the operator's list does not hold, then a reload with the
 *  camera index failing, or (fail 'file') the index fine and the District 5 file failing (sessionStorage
 *  carries the mode across the reload to the fetch stand-in). */
async function reloadWithIndexFailing(page, site, { second, fail = 'index' }) {
  await atView(page, SALINAS, 9);
  await press(page, '#qcm-layer-roadCameras');
  await waitStatus(page, /^40 cameras in this view\./, 'the 40 road cameras');
  await press(page, FIRST_ROW_SAVE);
  await waitInPage(page, 'the save to land', `localStorage.getItem(${JSON.stringify(SAVED_KEY)}) !== null`, 10000, null);
  if (second) {
    await page.evaluate(`(() => { const e = JSON.parse(localStorage.getItem(${JSON.stringify(SAVED_KEY)}));
      e.places.push({ ref: 'camera:caltrans-cwwp2:d05:99999', name: 'Gone Cam', kind: 'camera', lat: 36.6, lon: -121.7, state: null, county: null, savedAt: '2026-10-01T00:00:00.000Z' });
      localStorage.setItem(${JSON.stringify(SAVED_KEY)}, JSON.stringify(e)); })(); void 0;`);
  }
  await page.evaluate(`sessionStorage.setItem(${JSON.stringify(fail === 'file' ? 'qcm-test-file-mode' : 'qcm-test-index-mode')}, 'fail'); void 0;`);
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: false });
  await openCameras(page);
  await press(page, '#qcm-camera-scope-saved');
  await waitText(page, '#qcm-camera-list-notes', /could not be checked because the camera list did not load/, 'the failed check to be said');
  assert.equal(await indexReads(page), 1, 'the failed index is not asked for again by itself');
  if (fail === 'file') assert.equal(await d05Reads(page), 1, 'the failed file is not asked for again by itself');
}

test('J10r: after the Saved scope\'s index load fails, pressing Saved again retries once', { skip }, async () => {
  await withPage(async (page, { site }) => {
    await reloadWithIndexFailing(page, site, { second: true });
    assert.match(await text(page, '#qcm-camera-list-notes'), /Press Saved again to try again\.$/);
    await page.evaluate("window.__ctl.indexMode = 'ok'; void 0;");
    await press(page, '#qcm-camera-scope-saved');   // already the chosen scope: no change event, a press
    await waitStatus(page, /^2 saved cameras, stored only in this browser\./, 'the saved count after the retry');
    await waitText(page, '#qcm-camera-list-notes', /^1 is no longer in the camera list/, 'the checked result');
    assert.equal(await indexReads(page), 2, 'one retry, not a loop');
  });
});

test('J10s: after the Saved scope\'s index load fails, a change in the saved count retries once', { skip }, async () => {
  await withPage(async (page, { site }) => {
    await reloadWithIndexFailing(page, site, { second: true });
    await page.evaluate("window.__ctl.indexMode = 'ok'; sessionStorage.removeItem('qcm-test-index-mode'); void 0;");
    // Removing the second saved camera changes the count from 2 to 1.
    await press(page, '#qcm-camera-list-rows li:last-child button.qcm-camera-save');
    await waitStatus(page, /^1 saved camera, stored only in this browser\./, 'one saved camera');
    await waitInPage(page, 'the remaining camera to be found', "document.querySelectorAll('#qcm-camera-list-rows button.qcm-camera-list-row').length === 1", 15000, null);
    assert.equal(await indexReads(page), 2, 'one retry, not a loop');
  });
});

test('J10u: after a camera FILE fails with the index read fine, pressing Saved again reads the file once more', { skip }, async () => {
  await withPage(async (page, { site }) => {
    await reloadWithIndexFailing(page, site, { second: true, fail: 'file' });
    assert.match(await text(page, '#qcm-camera-list-notes'), /Press Saved again to try again\.$/);
    await page.evaluate("window.__ctl.fileMode = 'ok'; sessionStorage.removeItem('qcm-test-file-mode'); void 0;");
    await press(page, '#qcm-camera-scope-saved');   // already the chosen scope: no change event, a press
    await waitStatus(page, /^2 saved cameras, stored only in this browser\./, 'the saved count after the retry');
    await waitText(page, '#qcm-camera-list-notes', /^1 is no longer in the camera list/, 'the checked result');
    assert.equal(await d05Reads(page), 2, 'one retry of the file, not a loop');
    assert.equal(await indexReads(page), 1, 'the index was fine and is not read again');
    assert.equal(await page.evaluate("document.querySelectorAll('#qcm-camera-list-rows button.qcm-camera-list-row').length"), 1);
  });
});

test('J10v: after a camera FILE fails with the index read fine, a change in the saved count reads the file once more', { skip }, async () => {
  await withPage(async (page, { site }) => {
    await reloadWithIndexFailing(page, site, { second: true, fail: 'file' });
    await page.evaluate("window.__ctl.fileMode = 'ok'; sessionStorage.removeItem('qcm-test-file-mode'); void 0;");
    await press(page, '#qcm-camera-list-rows li:last-child button.qcm-camera-save');   // 2 saved becomes 1
    await waitStatus(page, /^1 saved camera, stored only in this browser\./, 'one saved camera');
    await waitInPage(page, 'the remaining camera to be found', "document.querySelectorAll('#qcm-camera-list-rows button.qcm-camera-list-row').length === 1", 15000, null);
    assert.equal(await d05Reads(page), 2, 'one retry of the file, not a loop');
  });
});

test('J10w: a camera FILE that fails again on the retry is not read in a loop, and a later press tries once more', { skip }, async () => {
  await withPage(async (page, { site }) => {
    await reloadWithIndexFailing(page, site, { second: true, fail: 'file' });
    await press(page, '#qcm-camera-scope-saved');   // the file still fails
    await page.evaluate('new Promise((r) => setTimeout(r, 600))');
    assert.equal(await d05Reads(page), 2, 'a press retries once');
    assert.match(await text(page, '#qcm-camera-list-notes'), /Press Saved again to try again\.$/);
    await press(page, '#qcm-camera-scope-saved');
    await page.evaluate('new Promise((r) => setTimeout(r, 600))');
    assert.equal(await d05Reads(page), 3, 'a later press retries once more');
  });
});

test('J10x: the privacy guard sees a camera leave in any form: query, path, older ref, tail, name, id, and every kind of body', { skip }, async () => {
  await withPage(async (page) => {
    await atView(page, SALINAS, 9);
    await press(page, '#qcm-layer-roadCameras');
    await waitStatus(page, /^40 cameras in this view\./, 'the 40 road cameras');
    await press(page, FIRST_ROW_SAVE);
    await waitInPage(page, 'the save to land', `localStorage.getItem(${JSON.stringify(SAVED_KEY)}) !== null`, 10000, null);
    const place = JSON.parse(await page.evaluate(`localStorage.getItem(${JSON.stringify(SAVED_KEY)})`)).places[0];
    const camera = { ref: place.ref, name: place.name };
    await page.evaluate('new Promise((r) => setTimeout(r, 400))');
    assert.equal(findLeak(await page.evaluate('window.__reqs'), camera), null, 'the page leaked the camera before any control ran');
    const id = place.ref.split(':').pop();
    const legacy = place.ref.replace(':d05:', ':');
    const tail = place.ref.split(':').slice(2).join(':');
    // Each control sends one request the page itself never would, in one form; the guard must flag it.
    const forms = {
      'the ref in a query': `fetch('/__leak-probe?c=' + ${JSON.stringify(place.ref)})`,
      'the encoded ref in a query': `fetch('/__leak-probe?c=' + encodeURIComponent(${JSON.stringify(place.ref)}))`,
      'the older ref': `fetch('/__leak-probe?c=' + ${JSON.stringify(legacy)})`,
      'the d05 tail in a path': `fetch('/__leak-probe/' + ${JSON.stringify(tail)})`,
      'the bare id as a query value': `fetch('/__leak-probe?id=' + ${JSON.stringify(id)})`,
      'the name in a query': `fetch('/__leak-probe?n=' + encodeURIComponent(${JSON.stringify(place.name)}))`,
      'a URL object': `fetch(new URL('/__leak-probe?c=' + ${JSON.stringify(place.ref)}, location.href))`,
      'a string body': `fetch('/__leak-probe', { method: 'POST', body: ${JSON.stringify(place.ref)} })`,
      'a Request object with a body': `fetch(new Request('/__leak-probe', { method: 'POST', body: ${JSON.stringify(place.ref)} }))`,
      'a FormData body': `fetch('/__leak-probe', { method: 'POST', body: (() => { const f = new FormData(); f.append('camera', ${JSON.stringify(place.ref)}); return f; })() })`,
      'a URLSearchParams body': `fetch('/__leak-probe', { method: 'POST', body: new URLSearchParams({ camera: ${JSON.stringify(place.ref)} }) })`,
      'a Blob body': `fetch('/__leak-probe', { method: 'POST', body: new Blob([${JSON.stringify(place.ref)}]) })`,
      'a typed-array body': `fetch('/__leak-probe', { method: 'POST', body: new TextEncoder().encode(${JSON.stringify(place.ref)}) })`,
      'an XHR body': `(() => { const x = new XMLHttpRequest(); x.open('POST', '/__leak-probe'); x.send(${JSON.stringify(place.ref)}); })()`,
      'a beacon': `navigator.sendBeacon('/__leak-probe', ${JSON.stringify(place.ref)})`,
    };
    const missed = [];
    for (const [what, code] of Object.entries(forms)) {
      const from = await page.evaluate('window.__reqs.length');
      await page.evaluate(`(async () => { try { await (${code}); } catch { /* the probe path may 404 */ } await new Promise((r) => setTimeout(r, 120)); })()`);
      const mine = (await page.evaluate('window.__reqs')).slice(from);
      if (!mine.length || !findLeak(mine, camera)) missed.push(`${what} (${mine.length} recorded)`);
    }
    assert.deepEqual(missed, [], 'the guard missed a leak');
  });
});

test('J10t: saving and searching send nothing that carries the camera, and leave the address, history, title and share link alone', { skip }, async () => {
  await withPage(async (page) => {
    await page.evaluate(`window.__shared = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__shared.push(t); return Promise.resolve(); } } }); void 0;`);
    const shareLink = async () => {
      const n = await page.evaluate('window.__shared.length');
      await page.evaluate("document.getElementById('qc-view-share').click(); void 0;");
      await waitInPage(page, 'the share link', `window.__shared.length > ${n}`, 10000, null);
      return page.evaluate('window.__shared[window.__shared.length - 1]');
    };
    const state = () => page.evaluate('({ hash: location.hash, historyState: JSON.stringify(history.state), title: document.title, href: location.href })');
    await atView(page, SALINAS, 9);
    await press(page, '#qcm-layer-roadCameras');
    await waitStatus(page, /^40 cameras in this view\./, 'the 40 road cameras');
    await page.evaluate('new Promise((r) => setTimeout(r, 400))');   // the map writes its own view into the address, then settles
    let before = await state();
    let linkBefore = await shareLink();
    assert.ok(!before.hash.includes('camera') && !linkBefore.includes('camera'));
    // Save a camera.
    await press(page, FIRST_ROW_SAVE);
    await waitInPage(page, 'the row to read Saved', "/Saved/.test(document.querySelector('#qcm-camera-list-rows button.qcm-camera-save').textContent)", 10000, null);
    const [ref] = await storedRefs(page);
    assert.match(ref, /^camera:caltrans-cwwp2:d05:\d+$/);
    const name = JSON.parse(await page.evaluate(`localStorage.getItem(${JSON.stringify(SAVED_KEY)})`)).places[0].name;
    const sent = async () => {
      const reqs = await page.evaluate('window.__reqs');
      const resources = await page.evaluate("performance.getEntriesByType('resource').map((e) => ({ url: e.name, body: '' }))");
      return [...reqs, ...resources];
    };
    const assertNoCamera = async (when) => {
      const all = await sent();
      assert.ok(all.length > 0, `${when}: nothing was recorded, so the check proves nothing`);
      const leak = findLeak(all, { ref, name });
      assert.equal(leak, null, `${when}: a request carries the camera (${leak && leak.carrier}): ${leak && leak.req.url.slice(0, 160)} ${leak && leak.req.body.slice(0, 80)}`);
    };
    const assertUnchanged = async (when) => {
      assert.deepEqual(await state(), before, `${when}: the address, history state or title changed`);
      assert.equal(await shareLink(), linkBefore, `${when}: the share link changed`);
    };
    await page.evaluate('new Promise((r) => setTimeout(r, 400))');
    await assertNoCamera('after the save');
    await assertUnchanged('after the save');
    // Search the area from a broad view, so it reads the other layers' files. The view and layers are set
    // first and measured, so only the search itself can move any of it.
    await atView(page, SALINAS, 5);
    for (const id of ['parkCameras', 'linkCameras']) await press(page, `#qcm-layer-${id}`);
    await waitStatus(page, /zoom in to list cameras/i, 'the zoom-in state');
    await page.evaluate('new Promise((r) => setTimeout(r, 400))');
    before = await state();
    linkBefore = await shareLink();
    await press(page, '#qcm-camera-search');
    await waitText(page, '#qcm-camera-search-status', /: 3 of 3 camera files read\.$/, 'the search to read three files');
    await waitStatus(page, /^\d+ cameras loaded in this view at this zoom:/, 'the cluster summary');
    await page.evaluate('new Promise((r) => setTimeout(r, 400))');
    assert.ok((await sent()).some((r) => r.url.includes('nps-test.json')), 'the search should have asked for the park file');
    await assertNoCamera('after the search');
    await assertUnchanged('after the search');
  });
});
