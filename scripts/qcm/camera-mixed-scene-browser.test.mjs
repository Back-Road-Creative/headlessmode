// QQA-10b: a mixed-provider camera scene in one view, with one layer failing. Until now only road and
// park cameras had ever been on together in a browser (camera-discovery-browser.test.mjs J03), and the
// Cameras list test used road cameras alone. Here all five camera layers are on at one public point
// (Salinas, California): road (a Caltrans district file, picture read with fetch into a blob), park (an
// NPS file, picture painted straight into an <img>), camera links (an HPWREN file, no picture at all),
// PhenoCam research cameras and AviationWX airport cameras (both plain <img>).
//
// The browser is offline (helpers/browser.mjs launch). The five snapshot files come from the page-side
// stand-in below, built from the committed files' own headers and fixed fixture rows
// (helpers/camera-snapshot-stub.mjs mixedSceneStub), so a test owns the rows it asserts against. Every
// press is a trusted CDP press; the page is read only for assertions.
//
// What it proves: each layer draws its own pin class and the count line says five layers are on; the
// Cameras entry and each layer row report their own cameras; the Cameras list names each row's own
// source; opening one pin per provider applies that provider's own picture plan (a blob <img> for the
// fetch plan, a plain <img> pointed at the owner for the img plan, no <img> and no request to the owner
// for the link-only layer) and each card names its own operator. Then one layer's file fails while the
// others load: that layer's row reads unavailable, the others keep their pins and pictures, the list says
// it is partial, a surviving row still opens its card, and cycling the layer recovers it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { trustedClick } from './helpers/trusted-click.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage } from './helpers/waits.mjs';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { INDEX_PATH, MIXED_POINT, mixedSceneStub } from './helpers/camera-snapshot-stub.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const STUB = mixedSceneStub();
const SCENE = STUB.scene;
const BY_LAYER = Object.fromEntries(SCENE.map((s) => [s.layer, s]));
const LAYER_IDS = SCENE.map((s) => s.layer);
const fileTail = (layer) => BY_LAYER[layer].file.split('/').slice(-2).join('/');
const PIN_CLASS = { roadCameras: 'road', parkCameras: 'park', linkCameras: 'link', phenoCameras: 'research', airportCameras: 'airport' };
const TINY_JPEG_B64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';
const CCTV_ORIGIN = SOURCES.caltransCctv.origin;
// Every host a camera picture or owner page could come from; the stand-in logs a request to any of them.
const OWNER_HOSTS = [...new Set(SCENE.flatMap((s) => s.cameras.flatMap((c) => [c.still, c.officialUrl]))
  .filter(Boolean).map((u) => new URL(u).origin))];

/** window.fetch and Image.src replaced before any page script runs. fetch: the five stub files are
 *  answered here (a path listed in __ctl.failPaths answers 500), the road picture is a tiny JPEG, any
 *  other cross-origin request is refused and logged. Image.src: a picture an owner host would serve is
 *  logged ({ requested, alt }) and shown as a tiny JPEG, so the offline browser still paints it and
 *  the log records the address the page actually asked for. */
const standIn = `(() => {
  const real = window.fetch.bind(window);
  const files = ${JSON.stringify(STUB.files)};
  const jpegB64 = ${JSON.stringify(TINY_JPEG_B64)};
  const jpeg = Uint8Array.from(atob(jpegB64), (c) => c.charCodeAt(0));
  const owners = ${JSON.stringify(OWNER_HOSTS)};
  window.__camera = { pictures: 0 };
  window.__ctl = { failPaths: [] };
  window.__refused = [];
  window.__imgs = [];
  window.__fileFetches = [];
  const json = (text) => new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    let parsed = null;
    try { parsed = new URL(url, location.href); } catch { /* not a url */ }
    const path = parsed ? parsed.pathname : '';
    if (path in files) {
      window.__fileFetches.push(path);
      if (window.__ctl.failPaths.some((p) => path.endsWith(p))) return Promise.resolve(new Response('nope', { status: 500 }));
      return Promise.resolve(json(files[path]));
    }
    if (url.startsWith(${JSON.stringify(CCTV_ORIGIN)})) {
      window.__camera.pictures++;
      return Promise.resolve(new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg', 'last-modified': new Date(Date.now() - 180000).toUTCString() } }));
    }
    // The place, road and water name sources the default-on Names and Roads layers ask for: nothing to
    // label in this scene, answered as an empty page and a zero count.
    if (/\\/(geonames|transportation|nhd)\\/MapServer\\/\\d+\\/query/.test(url)) return Promise.resolve(json('{"features":[],"count":0}'));
    if (parsed && parsed.origin !== location.origin) { window.__refused.push(url.slice(0, 120)); return Promise.reject(new TypeError('refused: not stubbed')); }
    return real(input, init);
  };
  const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true, enumerable: desc.enumerable,
    get() { return desc.get.call(this); },
    set(value) {
      const requested = String(value);
      if (owners.some((o) => requested.startsWith(o + '/'))) {
        window.__imgs.push({ requested, alt: this.alt });
        desc.set.call(this, 'data:image/jpeg;base64,' + jpegB64);
      } else desc.set.call(this, value);
    },
  });
  window.__ownerRequests = () => performance.getEntriesByType('resource').filter((e) => owners.some((o) => e.name.startsWith(o + '/'))).length;
})()`;

const press = (page, selector, opts = {}) => trustedClick(page, selector, { settleMs: 0, ...opts });
const text = (page, selector) => page.evaluate(`(document.querySelector(${JSON.stringify(selector)}) || {}).textContent || ''`);
const attr = (page, selector, name) => page.evaluate(`(document.querySelector(${JSON.stringify(selector)}) || document.body).getAttribute(${JSON.stringify(name)})`);
const regionSel = (layer) => `#qcm-camera-entry [data-camera-region="${layer}"] .qcm-camera-region-status`;
const pinCount = (page, layer) => page.evaluate(`document.querySelectorAll('.qcm-camera-pin--${PIN_CLASS[layer]}').length`);
const listRows = (page) => page.evaluate(`[...document.querySelectorAll('#qcm-camera-list-rows button.qcm-camera-list-row')].map((b) => ({
  name: b.querySelector('.qcm-camera-row-name').textContent, meta: b.querySelector('.qcm-camera-row-meta').textContent }))`);
const waitListStatus = (page, re, what) => waitInPage(page, what, `${re}.test(document.getElementById('qcm-camera-list-status').textContent)`, 20000, null);
const waitRegion = (page, layer, key, what) => waitInPage(page, what, `document.querySelector(${JSON.stringify(regionSel(layer))}).getAttribute('data-status') === ${JSON.stringify(key)}`, 20000, null);

async function atScene(page) {
  // Wait until the map is idle, then set the view and keep setting it until it holds for two frames.
  await page.evaluate(`new Promise((resolve, reject) => {
    const m = window.qcMap, raf2 = (f) => requestAnimationFrame(() => requestAnimationFrame(f));
    const t0 = Date.now(), idle = () => !m._animatingZoom && !m._panAnim;
    const step = () => {
      if (Date.now() - t0 > 10000) return reject(new Error('the map never settled at the scene, zoom 13'));
      if (!idle()) return raf2(step);
      m.setView(${JSON.stringify([MIXED_POINT.lat, MIXED_POINT.lon])}, 13, { animate: false });
      raf2(() => (idle() && m.getZoom() === 13 ? resolve(0) : step()));
    };
    raf2(step);
  })`);
}

async function withScene(fn, { failPaths = [] } = {}) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', { args: ['--hide-scrollbars'], viewport: { width: 1280, height: 900 } });
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: standIn });
    await page.navigate(`${site.origin}/quiet-corners/`);
    await readyDashboard(page, { data: false });
    await page.evaluate(`window.__ctl.failPaths = ${JSON.stringify(failPaths)}; void 0;`);
    await press(page, '#qcm-layer-panel > summary', { until: "document.getElementById('qcm-layer-panel').open" });
    await press(page, '.qcm-layer-group[aria-label="Cameras"] > summary', { until: "document.querySelector('.qcm-layer-group[aria-label=\"Cameras\"]').open" });
    await atScene(page);
    return await fn(page);
  } finally { page.close(); await site.close(); }
}

async function allFiveOn(page) {
  for (const layer of LAYER_IDS) await press(page, `#qcm-layer-${layer}`);
}

// What a card holds once open, read from the page.
const cardState = (page) => page.evaluate(`(() => {
  const card = document.querySelector('.qcm-site-card');
  if (!card) return null;
  const imgs = [...card.querySelectorAll('img')].map((i) => ({ src: i.src.slice(0, 40), alt: i.alt }));
  return { text: card.textContent, imgs, links: [...card.querySelectorAll('a')].map((a) => ({ text: a.textContent, href: a.href })) };
})()`);

/** Opens the first pin of a layer with a trusted press and returns the card once it holds `name`. */
async function openPin(page, layer, camera) {
  await press(page, `.qcm-camera-pin--${PIN_CLASS[layer]}[aria-label=${JSON.stringify(camera.name)}]`);
  await waitInPage(page, `the card of ${camera.name}`, `(() => { const c = document.querySelector('.qcm-site-card'); return Boolean(c) && c.textContent.includes(${JSON.stringify(camera.name)}); })()`, 15000, null);
}
const closeCard = async (page) => {
  await page.evaluate('window.qcMap.closePopup(); void 0;');
  await waitInPage(page, 'the card to close', "!document.querySelector('.qcm-site-card')", 10000, null);
};

/** The proof of one provider's own picture plan, run on an open card. `before` is the page's counters
 *  just before the pin was pressed. */
async function assertPlan(page, layer, camera, before) {
  const s = BY_LAYER[layer];
  const after = await page.evaluate('({ pictures: window.__camera.pictures, imgs: window.__imgs.length, owner: window.__ownerRequests() })');
  const card = await cardState(page);
  assert.ok(card.text.includes(camera.name), `${layer}: the card does not name its camera`);
  if (s.plan === 'fetch') {
    assert.equal(after.pictures, before.pictures + 1, `${layer}: opening the pin should read its picture once`);
    assert.equal(after.imgs, before.imgs, `${layer}: the fetch plan must not paint an owner <img>`);
    await waitInPage(page, `${layer}'s blob picture`, "(() => { const i = document.querySelector('.qcm-site-card img'); return Boolean(i) && i.src.startsWith('blob:'); })()", 15000, null);
    const shown = (await cardState(page)).imgs;
    assert.equal(shown.length, 1);
    assert.match(shown[0].alt, new RegExp(`^Picture from ${camera.name} \\(${s.altCredit}\\)$`));
  } else if (s.plan === 'img') {
    assert.equal(after.pictures, before.pictures, `${layer}: the img plan must not fetch the picture`);
    assert.equal(after.imgs, before.imgs + 1, `${layer}: opening the pin should point one <img> at the owner`);
    const logged = await page.evaluate('window.__imgs[window.__imgs.length - 1]');
    assert.equal(logged.requested, camera.still, `${layer}: the <img> was not pointed straight at the owner's picture`);
    assert.doesNotMatch(logged.requested, /^blob:/);
    assert.equal(logged.alt, `View from ${camera.name} (${s.altCredit})`);
    await waitInPage(page, `${layer}'s picture`, "Boolean(document.querySelector('.qcm-site-card img'))", 15000, null);
  } else {
    assert.equal(after.pictures, before.pictures, `${layer}: a link-only pin read a picture`);
    assert.equal(after.imgs, before.imgs, `${layer}: a link-only pin pointed an <img> at the owner`);
    assert.equal(after.owner, before.owner, `${layer}: the browser made a request to the owner`);
    assert.equal(card.imgs.length, 0, `${layer}: a link-only card holds a picture`);
    assert.ok(card.links.some((l) => l.text === `View on ${s.operator}`), `${layer}: the owner link reads ${JSON.stringify(card.links)}`);
  }
  assert.ok(card.text.includes(s.cardOperator), `${layer}: the card does not name ${s.cardOperator}: ${JSON.stringify(card.text)}`);
  for (const other of SCENE) {
    if (other.layer !== layer) assert.ok(!card.text.includes(other.cardOperator) || other.cardOperator === s.cardOperator, `${layer}: the card names another provider (${other.cardOperator})`);
  }
}

const counters = (page) => page.evaluate('({ pictures: window.__camera.pictures, imgs: window.__imgs.length, owner: window.__ownerRequests() })');

test('QQA-10b: five providers on in one view draw their own pins, rows and cards', { skip }, async () => {
  await withScene(async (page) => {
    // Nothing on yet: no file, no picture, no owner request.
    assert.deepEqual(await page.evaluate('window.__fileFetches'), []);
    await allFiveOn(page);
    for (const layer of LAYER_IDS) {
      await waitInPage(page, `${layer} pins`, `document.querySelectorAll('.qcm-camera-pin--${PIN_CLASS[layer]}').length === ${BY_LAYER[layer].cameras.length}`, 30000, null);
    }
    assert.equal(await text(page, '#qcm-layer-count'), '5 layers on');

    // Each layer drew exactly its own cameras, under its own class, and no pin wears two.
    for (const layer of LAYER_IDS) assert.equal(await pinCount(page, layer), BY_LAYER[layer].cameras.length, `${layer} pins`);
    const total = SCENE.reduce((n, s) => n + s.cameras.length, 0);
    const shape = await page.evaluate(`(() => {
      const classes = ${JSON.stringify(Object.values(PIN_CLASS))};
      const pins = [...document.querySelectorAll('.qcm-camera-pin')];
      return { pins: pins.length, multi: pins.filter((p) => classes.filter((c) => p.classList.contains('qcm-camera-pin--' + c)).length !== 1).length };
    })()`);
    assert.deepEqual(shape, { pins: total, multi: 0 });
    // Every pin carries its own camera's name, and the name belongs to the layer whose class it wears.
    for (const layer of LAYER_IDS) {
      const titles = await page.evaluate(`[...document.querySelectorAll('.qcm-camera-pin--${PIN_CLASS[layer]}')].map((p) => p.getAttribute('aria-label')).sort()`);
      assert.deepEqual(titles, BY_LAYER[layer].cameras.map((c) => c.name).sort(), `${layer} pin names`);
    }

    // The Cameras entry and each layer row report their own cameras.
    for (const layer of LAYER_IDS) {
      await waitRegion(page, layer, 'in-view', `${layer}'s region status`);
      assert.equal(await text(page, regionSel(layer)), `${BY_LAYER[layer].cameras.length} cameras in this view.`);
      assert.match(await text(page, `#qcm-layer-${layer}-report`), new RegExp(`^${BY_LAYER[layer].cameras.length} ${BY_LAYER[layer].reportNoun}s? in this view\\.`), `${layer} row report`);
    }

    // The Cameras list: one list, every row naming its own source.
    await waitListStatus(page, new RegExp(`^${total} cameras in this view\\.`), 'the list to count every camera');
    assert.equal(await text(page, '#qcm-camera-list-title'), `Cameras in this view (${total})`);
    assert.equal(await attr(page, '#qcm-camera-list-status', 'data-status'), 'in-scope');
    const rows = await listRows(page);
    assert.equal(rows.length, total);
    for (const s of SCENE) {
      for (const c of s.cameras) {
        const row = rows.find((r) => r.name === c.name);
        assert.ok(row, `no list row for ${c.name}`);
        assert.ok(row.meta.startsWith(s.cardOperator), `${c.name}: the row names ${JSON.stringify(row.meta)}, not ${s.cardOperator}`);
        assert.equal(row.meta.includes('link only'), s.plan === 'link', `${c.name}: "link only" belongs to the link-only layer alone`);
      }
    }
    // The purpose counts follow the layers: road and camera links are roads, the rest one each.
    const purpose = await page.evaluate(`Object.fromEntries([...document.querySelectorAll('[data-camera-purpose-count]')].map((e) => [e.getAttribute('data-camera-purpose-count'), e.textContent]))`);
    assert.deepEqual(purpose, { roads: `(${BY_LAYER.roadCameras.cameras.length + BY_LAYER.linkCameras.cameras.length})`,
      scenery: `(${BY_LAYER.parkCameras.cameras.length})`, weather: `(${BY_LAYER.airportCameras.cameras.length})`, wildlife: `(${BY_LAYER.phenoCameras.cameras.length})` });
    // The two link-only cameras are the ones the list says have no picture.
    assert.match(await text(page, '#qcm-camera-list-notes'), new RegExp(`${BY_LAYER.linkCameras.cameras.length} of the ${total} have no picture here`));

    // No picture and no owner request happened for listing alone.
    assert.deepEqual(await counters(page), { pictures: 0, imgs: 0, owner: 0 });

    // One pin per provider, one after another: each applies its own plan and names its own operator.
    for (const layer of LAYER_IDS) {
      const camera = BY_LAYER[layer].cameras[0];
      const before = await counters(page);
      await openPin(page, layer, camera);
      await assertPlan(page, layer, camera, before);
      await closeCard(page);
      assert.equal(await page.evaluate("document.querySelectorAll('.qcm-site-card img').length"), 0, `${layer}: a picture outlived its card`);
    }
    // Five opens: the road picture by fetch, three by <img>, and nothing at all for the link-only layer.
    const end = await counters(page);
    assert.equal(end.pictures, 1, 'only the road camera is read with fetch');
    assert.equal(end.imgs, 3, 'park, research and airport each pointed one <img> at their owner');
    assert.equal(end.owner, 0, 'the stand-in served every owner picture, so the browser asked no owner host');
    assert.deepEqual(await page.evaluate('window.__refused'), [], 'a request reached past the stand-in');
    const fetched = await page.evaluate('window.__fileFetches');
    assert.deepEqual(fetched.filter((p) => p !== INDEX_PATH).sort(), LAYER_IDS.map((l) => BY_LAYER[l].file).sort(), 'each snapshot file is read once');
    assert.equal(fetched.filter((p) => p === INDEX_PATH).length, 1, 'the index is read once');
  });
});

test('QQA-10b: one layer\'s file failing leaves the others\' pins, pictures and rows, and the list says it is partial', { skip }, async () => {
  const failing = 'phenoCameras';
  await withScene(async (page) => {
    await allFiveOn(page);
    const survivors = LAYER_IDS.filter((l) => l !== failing);
    for (const layer of survivors) {
      await waitInPage(page, `${layer} pins`, `document.querySelectorAll('.qcm-camera-pin--${PIN_CLASS[layer]}').length === ${BY_LAYER[layer].cameras.length}`, 30000, null);
    }
    await waitRegion(page, failing, 'unavailable', 'the failed layer to read unavailable');
    const alive = survivors.reduce((n, l) => n + BY_LAYER[l].cameras.length, 0);

    // The failed layer: unavailable in the Cameras entry, its own words on its row, no pins. It stays on.
    assert.equal(await text(page, '#qcm-layer-count'), '5 layers on');
    assert.match(await text(page, regionSel(failing)), /^Camera list unavailable\. Turn the layer off and on to retry\./);
    assert.match(await text(page, `#qcm-layer-${failing}-report`), /PhenoCam camera list did not load/);
    assert.equal(await pinCount(page, failing), 0);
    // The others keep their pins, their own status and their own row report.
    for (const layer of survivors) {
      assert.equal(await pinCount(page, layer), BY_LAYER[layer].cameras.length, `${layer} lost pins to another layer's failure`);
      assert.equal(await attr(page, regionSel(layer), 'data-status'), 'in-view', `${layer} status`);
      assert.equal(await text(page, regionSel(layer)), `${BY_LAYER[layer].cameras.length} cameras in this view.`);
      assert.doesNotMatch(await text(page, `#qcm-layer-${layer}-report`), /did not load/, `${layer} row report took on the failure`);
    }

    // The list: partial, not unavailable, counting only what loaded, and saying what did not.
    await waitListStatus(page, new RegExp(`^${alive} cameras in this view\\. This list is partial\\.`), 'the list to say it is partial');
    assert.equal(await attr(page, '#qcm-camera-list-status', 'data-status'), 'partial');
    assert.equal(await text(page, '#qcm-camera-list-title'), `Cameras in this view (${alive})`);
    assert.match(await text(page, '#qcm-camera-list-notes'), /1 area did not load, so cameras may be missing\./);
    const rows = await listRows(page);
    assert.equal(rows.length, alive);
    assert.ok(rows.every((r) => !r.meta.startsWith(BY_LAYER[failing].cardOperator)), 'a row of the failed layer was listed');
    assert.equal(await page.evaluate(`window.__fileFetches.filter((p) => p.endsWith(${JSON.stringify(fileTail(failing))})).length`), 1, 'the failed file is asked for once, not retried behind the reader');

    // A surviving row still opens its card, with its picture: the road camera, from the list.
    const road = BY_LAYER.roadCameras.cameras[0];
    const before = await counters(page);
    await press(page, `#qcm-camera-list-rows li[data-ref=${JSON.stringify(road.ref)}] button.qcm-camera-list-row`);
    await waitInPage(page, 'the road card', `(document.querySelector('.qcm-site-card') || { textContent: '' }).textContent.includes(${JSON.stringify(road.name)})`, 15000, null);
    await assertPlan(page, 'roadCameras', road, before);
    await closeCard(page);
    // And a pin of another provider still opens too: the airport camera, a plain <img>.
    const airport = BY_LAYER.airportCameras.cameras[0];
    const beforeAirport = await counters(page);
    await openPin(page, 'airportCameras', airport);
    await assertPlan(page, 'airportCameras', airport, beforeAirport);
    await closeCard(page);

    // The retry the status promises: the file answers again, the layer is cycled off and on, all of it returns.
    await page.evaluate('window.__ctl.failPaths = []; void 0;');
    await press(page, `#qcm-layer-${failing}`);
    await waitInPage(page, 'the failed layer to switch off', `!document.getElementById('qcm-layer-${failing}').checked`, 10000, null);
    await press(page, `#qcm-layer-${failing}`);
    await waitInPage(page, 'the research pins to return', `document.querySelectorAll('.qcm-camera-pin--research').length === ${BY_LAYER[failing].cameras.length}`, 30000, null);
    await waitRegion(page, failing, 'in-view', 'the retried layer to read in view');
    const total = alive + BY_LAYER[failing].cameras.length;
    await waitListStatus(page, new RegExp(`^${total} cameras in this view\\.(?! This list is partial)`), 'the list to be whole again');
    assert.equal(await attr(page, '#qcm-camera-list-status', 'data-status'), 'in-scope');
    assert.equal(await text(page, '#qcm-layer-count'), '5 layers on');
    assert.deepEqual(await page.evaluate('window.__refused'), []);
  }, { failPaths: [fileTail('phenoCameras')] });
});

test('QQA-10b: the road layer failing instead reads unavailable on its own, and the other four stay whole', { skip }, async () => {
  const failing = 'roadCameras';
  await withScene(async (page) => {
    await allFiveOn(page);
    const survivors = LAYER_IDS.filter((l) => l !== failing);
    for (const layer of survivors) {
      await waitInPage(page, `${layer} pins`, `document.querySelectorAll('.qcm-camera-pin--${PIN_CLASS[layer]}').length === ${BY_LAYER[layer].cameras.length}`, 30000, null);
    }
    await waitRegion(page, failing, 'unavailable', 'the road layer to read unavailable');
    assert.match(await text(page, `#qcm-layer-${failing}-report`), /Caltrans's camera list did not load/);
    assert.equal(await pinCount(page, failing), 0);
    for (const layer of survivors) assert.equal(await attr(page, regionSel(layer), 'data-status'), 'in-view', `${layer} status`);
    const alive = survivors.reduce((n, l) => n + BY_LAYER[l].cameras.length, 0);
    await waitListStatus(page, new RegExp(`^${alive} cameras in this view\\. This list is partial\\.`), 'the list to say it is partial');
    // The link-only layer is the other roads layer: it still lists, and the picture-less note still counts it.
    assert.equal(await page.evaluate("document.querySelector('[data-camera-purpose-count=\"roads\"]').textContent"), `(${BY_LAYER.linkCameras.cameras.length})`);
    // A surviving provider still opens: the park camera, a plain <img>.
    const park = BY_LAYER.parkCameras.cameras[0];
    const before = await counters(page);
    await openPin(page, 'parkCameras', park);
    await assertPlan(page, 'parkCameras', park, before);
  }, { failPaths: [fileTail('roadCameras')] });
});

test('QQA-10b: every layer failing reads unavailable in the list too, never partial', { skip }, async () => {
  await withScene(async (page) => {
    await allFiveOn(page);
    for (const layer of LAYER_IDS) await waitRegion(page, layer, 'unavailable', `${layer} to read unavailable`);
    await waitListStatus(page, /camera list unavailable/i, 'the list to read unavailable');
    assert.equal(await attr(page, '#qcm-camera-list-status', 'data-status'), 'unavailable');
    assert.equal((await listRows(page)).length, 0);
    assert.equal(await text(page, '#qcm-layer-count'), '5 layers on');
    assert.equal(await page.evaluate("document.querySelectorAll('.qcm-camera-pin').length"), 0);
  }, { failPaths: LAYER_IDS.map(fileTail) });
});

