// A camera's card, in a real browser: siteCard's media slot (preview-overlay.js) wired to
// the fetch-to-blob/abort flow main.js owns for a Caltrans pin (QUX-08D §2.4/§2.5).
//
// Same harness shape as site-card.test.mjs -- previewSites/siteCard/identify wired the way
// renderOverlay wires them -- with one addition: a stubbed window.fetch, so the popupopen/
// popupclose network dance can be proven without a real request to Caltrans.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startModuleServer } from './helpers/module-server.mjs';
import { waitInPage, readyDashboard } from './helpers/waits.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readFileSync } from 'node:fs';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { d05Stub, pageSnapshotAnswer } from './helpers/camera-snapshot-stub.mjs';
import * as PANEL from '../../themes/headlessmode/static/js/quiet-corners-maps/saved-places-panel.js';

// A namespace import, so a missing export is a red assertion here rather than a load failure
// that takes every older test in the file down with it.
const CAMERA_NO_LOCATION = 'The operator publishes no location for this camera.';

const CHROMIUM = findChromium();
const skip = CHROMIUM ? false : 'no Chromium on this box (set CHROME_PATH to run this proof)';

// A 1x1 white JPEG, base64, small enough to inline in the harness.
const TINY_JPEG_B64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkI'
  + 'CQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
  + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8AVN//2Q==';

// Wired exactly as main.js's popupopen/popupclose handlers would wire a Caltrans camera pin:
// siteCard's media slot (an empty <figure>, a status <p>, a links <p>) filled on open, cleared
// on close. This harness owns that wiring itself (main.js has no browser to run it in), the
// same way site-card.test.mjs's __pin owns previewSites' own wiring -- proving the CONTRACT
// (siteCard's media placement, fetch/abort/revoke discipline) rather than importing main.js,
// which needs a full Leaflet map and every other layer wired to load at all.
const harness = (origin) => `<!doctype html><meta charset="utf-8"><title>camera card</title>
<link rel="stylesheet" href="${origin}/vendor/leaflet.css">
<div id="map" style="width:420px;height:320px"></div>
<script src="${origin}/vendor/leaflet.js"></script>
<script type="module">
import { siteCard, identify } from '${origin}/js/preview-overlay.js';

const map = L.map('map', { center: [35, -83.5], zoom: 12 });
const overlay = L.layerGroup().addTo(map);

window.__fetchCalls = [];
window.__fetchImpl = null; // set per-test

function buildMedia(camera) {
  const media = document.createElement('div');
  media.className = 'qcm-camera-media';
  const figure = document.createElement('figure');
  const status = document.createElement('p');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const links = document.createElement('p');
  const stillLink = document.createElement('a');
  stillLink.href = camera.media.still || '#';
  stillLink.rel = 'noopener noreferrer';
  stillLink.textContent = "Open this picture on Caltrans's site";
  const aboutLink = document.createElement('a');
  aboutLink.href = camera.officialUrl;
  aboutLink.rel = 'noopener noreferrer';
  aboutLink.textContent = 'About Caltrans cameras';
  links.append(stillLink, document.createTextNode(' '), aboutLink);
  media.append(figure, status, links);
  return { media, figure, status };
}

function ageText(lastModified) {
  if (!lastModified) return "Caltrans's server did not say when this picture changed.";
  return 'Picture file changed 3 min ago, per Caltrans\\'s server. That is when the file changed, not a guaranteed capture time.';
}

// The exact fetch-to-blob/abort contract main.js's popupopen/popupclose wire for a
// 'fetch'-plan camera (Caltrans): one fetch per open, cache:'no-cache', an AbortController
// whose signal is passed through, Last-Modified read off the response, the body turned into
// a blob: object URL, and on close the <img> removed, the URL revoked, the controller aborted.
window.__pinCamera = (camera) => {
  overlay.clearLayers();
  const { media, figure, status } = buildMedia(camera);
  const pin = L.marker([35, -83.5], { keyboard: true, alt: camera.name, title: camera.name }).addTo(overlay);
  const card = siteCard([camera.name, camera.operator], { media });
  identify(pin, camera.name, card);
  let ctrl = null, objectUrl = null;
  pin.on('popupopen', async () => {
    if (camera.health === 'inactive' || !camera.media || !camera.media.still) return;
    ctrl = new AbortController();
    const mine = ctrl;
    try {
      const res = await window.__fetchImpl(camera.media.still, { cache: 'no-cache', signal: mine.signal });
      window.__fetchCalls.push({ url: camera.media.still, cache: 'no-cache' });
      if (mine.signal.aborted) return;
      if (!res.ok) throw new Error('bad response');
      const lastModified = res.headers.get('Last-Modified');
      const blob = await res.blob();
      if (mine.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      const img = document.createElement('img');
      img.src = objectUrl;
      img.alt = \`Picture from \${camera.name} (Caltrans)\`;
      figure.append(img);
      status.textContent = ageText(lastModified);
    } catch (err) {
      if (mine.signal.aborted) return;
      status.textContent = 'The picture did not load. Use the link below to open it on Caltrans\\'s site.';
    }
  });
  pin.on('popupclose', () => {
    if (ctrl) { ctrl.abort(); ctrl = null; }
    if (objectUrl) { URL.revokeObjectURL(objectUrl); window.__revoked = (window.__revoked || 0) + 1; objectUrl = null; }
    const img = figure.querySelector('img');
    if (img) img.remove();
    status.textContent = '';
  });
  window.__pinLayer = pin;
  pin.getElement().focus();
  return { label: pin.getElement().getAttribute('aria-label') };
};

window.__open = () => { window.__pinLayer.openPopup(); return new Promise((r) => setTimeout(r, 50)); };
window.__close = () => { window.__pinLayer.closePopup(); return new Promise((r) => setTimeout(r, 250)); };
window.__seen = () => {
  const card = window.__pinLayer.getPopup().getContent();
  const img = card.querySelector('.qcm-camera-media img');
  const status = card.querySelector('.qcm-camera-media p');
  const links = [...card.querySelectorAll('.qcm-camera-media a')].map((a) => a.textContent);
  return {
    imgSrc: img ? img.src : null,
    imgAlt: img ? img.alt : null,
    statusText: status ? status.textContent : null,
    links,
    fetchCalls: window.__fetchCalls.length,
    revoked: window.__revoked || 0,
  };
};
window.__ready = true;
</script>`;

const openPage = async (t) => {
  const server = await startModuleServer(harness);
  t.after(() => server.close());
  const browser = await launch(CHROMIUM, server.origin);
  t.after(() => browser.close());
  await waitInPage(browser, 'the harness loaded its modules', 'Boolean(window.__ready)');
  return { browser, origin: server.origin };
};

const ACTIVE = {
  name: 'Hwy 1 at Big Sur', operator: 'Caltrans',
  officialUrl: 'https://cwwp2.dot.ca.gov/documentation/cctv/cctv.htm',
  media: { still: 'https://cwwp2.dot.ca.gov/data/d5/cctv/image/1/1.jpg' },
  health: 'active',
};
const INACTIVE = { ...ACTIVE, health: 'inactive' };

test('siteCard with no media is byte-identical to before (QUX-08D adds an optional slot, never a required one)', { skip }, async (t) => {
  const { browser, origin } = await openPage(t);
  // A card built with no media option must carry no media node at all -- the box this
  // function returns for ['A', 'B'] with no options is identical to before QUX-08D.
  const noMedia = await browser.evaluate(`import(${JSON.stringify(`${origin}/js/preview-overlay.js`)})
    .then((m) => { const box = m.siteCard(['A', 'B']); return { html: box.outerHTML, hasMedia: !!box.querySelector('.qcm-camera-media') }; })`);
  assert.equal(noMedia.hasMedia, false, 'siteCard must not invent a media node when none is given');
  assert.equal(noMedia.html, '<div class="qcm-site-card" tabindex="-1" role="group" aria-label="A"><p class="qcm-site-card-name">A</p><p>B</p></div>',
    'siteCard\'s no-media, no-actions output changed shape');
});

test('opening a Caltrans pin fetches the still once, shows the picture, and closing tears it down', { skip }, async (t) => {
  const { browser, origin } = await openPage(t);
  await browser.evaluate(`window.__fetchImpl = async (url, opts) => ({
    ok: true,
    headers: { get: (h) => h === 'Last-Modified' ? new Date(Date.now() - 3 * 60 * 1000).toUTCString() : null },
    blob: async () => new Blob([Uint8Array.from(atob(${JSON.stringify(TINY_JPEG_B64)}), c => c.charCodeAt(0))], { type: 'image/jpeg' }),
  })`);
  await browser.evaluate(`window.__pinCamera(${JSON.stringify(ACTIVE)})`);
  await browser.evaluate('window.__open()');
  const seen = await browser.evaluate('window.__seen()');
  assert.equal(seen.fetchCalls, 1, 'opening the pin must fetch the still exactly once');
  assert.ok(seen.imgSrc && seen.imgSrc.startsWith('blob:'), `expected a blob: src, got ${seen.imgSrc}`);
  assert.equal(seen.imgAlt, 'Picture from Hwy 1 at Big Sur (Caltrans)', 'the alt text must name the camera and Caltrans');
  assert.match(seen.statusText, /3 min ago/, 'the status text must report the picture\'s age');
  assert.deepEqual(seen.links, ["Open this picture on Caltrans's site", 'About Caltrans cameras'], 'both links must be present');

  await browser.evaluate('window.__close()');
  const afterClose = await browser.evaluate('window.__seen()');
  assert.equal(afterClose.imgSrc, null, 'closing the card must remove the <img>');
  assert.equal(afterClose.revoked, 1, 'closing must revoke the object URL exactly once');
  assert.equal(afterClose.statusText, '', 'closing must clear the status text so reopening looks fresh');
});

test('opening pin B while pin A\'s fetch is still pending aborts A, never lets a stale answer land', { skip }, async (t) => {
  const { browser, origin } = await openPage(t);
  await browser.evaluate(`(() => {
    let calls = 0;
    window.__fetchImpl = (url, opts) => new Promise((resolve, reject) => {
      calls += 1;
      const mine = calls;
      const timer = setTimeout(() => {
        resolve({
          ok: true,
          headers: { get: () => new Date().toUTCString() },
          blob: async () => new Blob([Uint8Array.from(atob(${JSON.stringify(TINY_JPEG_B64)}), c => c.charCodeAt(0))], { type: 'image/jpeg' }),
        });
      }, 200);
      opts.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); });
    });
  })()`);
  await browser.evaluate(`window.__pinCamera(${JSON.stringify(ACTIVE)})`);
  await browser.evaluate('window.__pinLayer.openPopup(); void 0');
  await new Promise((r) => setTimeout(r, 30));
  const b = { ...ACTIVE, name: 'Hwy 1 at Carmel' };
  await browser.evaluate(`window.__pinCamera(${JSON.stringify(b)})`);
  await browser.evaluate('window.__pinLayer.openPopup(); void 0');
  // B's simulated fetch resolves at 200ms; give it room past that.
  await new Promise((r) => setTimeout(r, 350));
  const seen = await browser.evaluate('window.__seen()');
  assert.ok(seen.imgSrc && seen.imgSrc.startsWith('blob:'), 'B\'s own picture must still load');
  assert.equal(seen.imgAlt, 'Picture from Hwy 1 at Carmel (Caltrans)', 'A\'s stale answer must never land on B\'s card');
});

test('a rejected fetch shows the error text and no <img>, both links stay', { skip }, async (t) => {
  const { browser, origin } = await openPage(t);
  await browser.evaluate(`window.__fetchImpl = async () => { throw new Error('network down'); }`);
  await browser.evaluate(`window.__pinCamera(${JSON.stringify(ACTIVE)})`);
  await browser.evaluate('window.__open()');
  const seen = await browser.evaluate('window.__seen()');
  assert.equal(seen.imgSrc, null, 'a failed fetch must not produce an <img>');
  assert.match(seen.statusText, /did not load/, 'a failed fetch must say the picture did not load');
  assert.deepEqual(seen.links, ["Open this picture on Caltrans's site", 'About Caltrans cameras'], 'both links must stay even on failure');
});

test('an inactive camera never fetches at all', { skip }, async (t) => {
  const { browser, origin } = await openPage(t);
  await browser.evaluate(`window.__fetchImpl = async () => { throw new Error('must not be called'); }`);
  await browser.evaluate(`window.__pinCamera(${JSON.stringify(INACTIVE)})`);
  await browser.evaluate('window.__open()');
  const seen = await browser.evaluate('window.__seen()');
  assert.equal(seen.fetchCalls, 0, 'an inactive camera must never be fetched');
});

// --- QUX-09c: camera bookmarks, against the real built site ---------------------------------
// One shared browser and profile, so a bookmark saved in test 1 is still there for test 2 (the
// reload keeps localStorage). The Caltrans catalogue is answered in-page from the committed
// D05 fixture, and its stills with a tiny JPEG: nothing here reaches cwwp2.dot.ca.gov.
const siteSkip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;
const CEILING = 30000;
const SAVED_KEY = 'qc-saved-places';
const STUB = d05Stub(JSON.parse(readFileSync(new URL('fixtures/caltrans-cctv-d05-2026-09-27.min.json', import.meta.url), 'utf8')));
const VIEW_SALINAS = 'window.qcMap.setView([36.65, -121.7], 9, { animate: false }); ';
const CAMERA_NAME = 'US-101 : North Main Street';
const CAMERA_REF = 'camera:caltrans-cwwp2:d05:1';

const stubSource = `(() => {
  window.__qcFetches = [];
  ${pageSnapshotAnswer(STUB)}
  const realFetch = window.fetch.bind(window);
  const jpeg = Uint8Array.from(atob(${JSON.stringify(TINY_JPEG_B64)}), (c) => c.charCodeAt(0));
  window.fetch = function (input, init) {
    const url = String(input && input.url ? input.url : input);
    window.__qcFetches.push(url);
    const snapshot = window.__qcSnapshotAnswer(url);
    if (snapshot) return Promise.resolve(snapshot);
    if (url.startsWith(${JSON.stringify(SOURCES.caltransCctv.origin)})) {
      return Promise.resolve(new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    }
    return realFetch(input, init);
  };
})()`;

let shared = null;
async function sharedSite() {
  if (!shared) {
    const site = await startSiteServer();
    const page = await launch(CHROMIUM, 'about:blank', { viewport: { width: 1280, height: 900 }, args: ['--hide-scrollbars'] });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: stubSource });
    shared = { site, page };
  }
  return shared;
}
after(async () => {
  if (!shared) return;
  shared.page.close();
  await shared.site.close();
});

async function freshDashboard() {
  const { site, page } = await sharedSite();
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: false, ms: CEILING });
  return page;
}
const rowByName = (name) => `(() => [...document.querySelectorAll('#qc-saved-list .qc-saved-row')]
  .find((r) => r.querySelector('.qc-saved-row-name').textContent.startsWith(${JSON.stringify(name)})))()`;
const catalogFetches = 'window.__qcCatalogFetches';

test('Save camera on a Caltrans card stores the name and position only, and the row survives a reload', { skip: siteSkip }, async () => {
  const page = await freshDashboard();
  await page.evaluate(VIEW_SALINAS + "document.getElementById('qcm-layer-roadCameras').click(); void 0;");
  await waitInPage(page, 'a road camera pin', "Boolean(document.querySelector('.qcm-camera-pin--road'))", CEILING, null);
  await page.evaluate("document.querySelector('.qcm-camera-pin--road').click(); void 0;");
  await waitInPage(page, 'the camera card with its two actions', "document.querySelectorAll('.qcm-site-card-action').length === 2", CEILING, null);
  const labels = await page.evaluate("[...document.querySelectorAll('.qcm-site-card-action')].map((b) => b.textContent)");
  assert.deepEqual(labels, ['Save camera', 'Before you go'], 'a camera card carries Save and Before you go, no Copy or Share');

  await page.evaluate("document.querySelector('.qcm-site-card-action').click(); void 0;");
  await waitInPage(page, 'Save camera to flip to Saved -- remove', "document.querySelector('.qcm-site-card-action').textContent === 'Saved \u2014 remove'", CEILING, null);
  const text = await page.evaluate(`localStorage.getItem(${JSON.stringify(SAVED_KEY)})`);
  const [place] = JSON.parse(text).places;
  assert.equal(place.ref, CAMERA_REF);
  assert.equal(place.name, CAMERA_NAME);
  assert.equal(place.kind, 'camera');
  assert.equal(place.lat, 36.687188);
  assert.equal(place.lon, -121.653231);
  assert.doesNotMatch(text, /still|stream|media|https?:/i, 'a saved camera must hold no picture or stream address');
  await waitInPage(page, 'the saved row', `Boolean(${rowByName(CAMERA_NAME)})`, CEILING, null);

  const reloaded = await freshDashboard();
  await waitInPage(reloaded, 'the camera row to survive the reload', `Boolean(${rowByName(CAMERA_NAME)})`, CEILING, null);
  const row = await reloaded.evaluate(`(() => { const r = ${rowByName(CAMERA_NAME)};
    return { name: r.querySelector('.qc-saved-row-name').textContent,
      actions: [...r.querySelectorAll('.qc-saved-row-action')].map((b) => b.textContent) }; })()`);
  assert.equal(row.name, `${CAMERA_NAME} \u2014 Camera`);
  assert.deepEqual(row.actions, ['Show', 'Before you go', 'Remove'], 'a camera row has no Share');
});

test('Show on a saved camera switches the layer on, fetches the catalogue once, and opens that pin\'s card', { skip: siteSkip }, async () => {
  const page = await freshDashboard(); // the row from the previous test, layers all off again
  await waitInPage(page, 'the camera row', `Boolean(${rowByName(CAMERA_NAME)})`, CEILING, null);
  assert.equal(await page.evaluate("document.getElementById('qcm-layer-roadCameras').checked"), false, 'setup: the layer starts off');
  assert.equal(await page.evaluate(catalogFetches), 0, 'setup: nothing loaded the catalogue yet');

  await page.evaluate(`${rowByName(CAMERA_NAME)}.querySelector('.qc-saved-row-action').click(); void 0;`);
  await waitInPage(page, 'the road cameras layer to come on', "document.getElementById('qcm-layer-roadCameras').checked", CEILING, null);
  await waitInPage(page, "the camera's card to open", `(() => { const el = document.querySelector('.leaflet-popup .qcm-site-card-name');
    return Boolean(el) && el.textContent === ${JSON.stringify(CAMERA_NAME)}; })()`, CEILING, null);
  assert.equal(await page.evaluate(catalogFetches), 1, 'Show must start exactly one catalogue fetch, not one per code path');
  const saveLabel = await page.evaluate("document.querySelector('.leaflet-popup .qcm-site-card-action').textContent");
  assert.equal(saveLabel, 'Saved \u2014 remove', 'the reopened card reads the store: this camera is already saved');
});

// A place saved before U4a holds the bare index ref, already in readers' localStorage; it must still open.
test('Show on a camera saved under the pre-U4a bare ref (camera:caltrans-cwwp2:1) still opens that pin\'s card', { skip: siteSkip }, async () => {
  const page = await freshDashboard();
  assert.equal(await page.evaluate("document.getElementById('qcm-layer-roadCameras').checked"), false, 'setup: the layer starts off');
  const text = await page.evaluate("window.qcShowCamera('camera:caltrans-cwwp2:1')");
  assert.equal(text, '', 'Show resolves to no complaint');
  await waitInPage(page, "the camera's card to open", `(() => { const el = document.querySelector('.leaflet-popup .qcm-site-card-name');
    return Boolean(el) && el.textContent === ${JSON.stringify(CAMERA_NAME)}; })()`, CEILING, null);
});

test('a saved camera missing from the operator\'s list says so and opens no picture; an unlocated one is disabled with its reason', { skip: siteSkip }, async () => {
  const { page } = await sharedSite();
  await page.evaluate(`localStorage.setItem(${JSON.stringify(SAVED_KEY)}, JSON.stringify({ schemaVersion: 1, places: [
    { ref: 'camera:caltrans-cwwp2:does-not-exist', name: 'Gone Camera', kind: 'camera', lat: 36.5, lon: -121.5, state: null, county: null },
    { ref: 'camera:nps-grsm:kuwohi', name: 'Kuwohi', kind: 'camera', lat: null, lon: null, state: null, county: null },
  ] })); void 0;`);
  await freshDashboard();
  await waitInPage(page, 'both seeded rows', "document.querySelectorAll('#qc-saved-list .qc-saved-row').length === 2", CEILING, null);

  await page.evaluate(`${rowByName('Gone Camera')}.querySelector('.qc-saved-row-action').click(); void 0;`);
  await waitInPage(page, 'the not-in-list status', "document.getElementById('qc-saved-status').textContent === \"Not in Caltrans's current camera list.\"", CEILING, null);
  assert.equal(await page.evaluate("document.querySelectorAll('.qcm-site-card img, .leaflet-popup img').length"), 0, 'no picture opens for a camera the operator no longer lists');
  assert.equal(await page.evaluate("document.querySelectorAll('.leaflet-popup').length"), 0, 'no card opens either');

  const unlocated = await page.evaluate(`(() => { const r = ${rowByName('Kuwohi')};
    return { actions: [...r.querySelectorAll('.qc-saved-row-action')].map((b) => ({ text: b.textContent, aria: b.getAttribute('aria-disabled'), title: b.title })) }; })()`);
  assert.deepEqual(unlocated.actions.map((a) => a.text), ['Show', 'Before you go', 'Remove']);
  for (const a of unlocated.actions.slice(0, 2)) {
    assert.equal(a.aria, 'true', `${a.text} must be aria-disabled on an unlocated camera`);
    assert.equal(a.title, CAMERA_NO_LOCATION);
    assert.equal(PANEL.CAMERA_NO_LOCATION, CAMERA_NO_LOCATION, 'the panel exports the one reason string');
  }
  assert.equal(unlocated.actions[2].aria, null, 'Remove stays live');
  await page.evaluate(`${rowByName('Kuwohi')}.querySelector('.qc-saved-row-action').click(); void 0;`);
  await waitInPage(page, 'the no-location reason in the status line', `document.getElementById('qc-saved-status').textContent === ${JSON.stringify(CAMERA_NO_LOCATION)}`, CEILING, null);
});

/** Trusted key dispatch: CDP routes it to whatever has focus, and a Tab moves focus the way a
 *  person's does (places-in-view-browser.test.mjs's helper). */
async function trustedKey(page, key, windowsVirtualKeyCode) {
  const base = { key, code: key, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

// A still the size Caltrans serves, so the card is as tall as a real one; the shared stub's JPEG is 1x1.
const STILL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#777"/></svg>';
const svgStills = `(() => { const prior = window.fetch;
  window.fetch = function (input, init) {
    const url = String(input && input.url ? input.url : input);
    if (!window.__qcSnapshotAnswer(url) && url.startsWith(${JSON.stringify(SOURCES.caltransCctv.origin)})) {
      return Promise.resolve(new Response(${JSON.stringify(STILL_SVG)}, { status: 200, headers: { 'content-type': 'image/svg+xml' } }));
    }
    return prior(input, init);
  }; })(); void 0;`;
const linkAndDock = `(() => {
  const box = document.querySelector('.leaflet-popup .leaflet-popup-content');
  const b = box.getBoundingClientRect();
  const link = box.querySelector('.qcm-camera-media a').getBoundingClientRect();
  const dock = box.querySelector('.qcm-site-card-actions').getBoundingClientRect();
  return {
    scrollable: box.scrollHeight > box.clientHeight + 1, scrollHeight: box.scrollHeight, clientHeight: box.clientHeight,
    scrollTop: box.scrollTop, link: [link.top - b.top, link.bottom - b.top], dock: [dock.top - b.top, dock.bottom - b.top],
    under: link.bottom > dock.top + 0.5 && link.top < dock.bottom - 0.5,
    inside: link.top >= b.top - 0.5 && link.bottom <= b.top + box.clientHeight + 0.5,
    active: document.activeElement ? document.activeElement.textContent : null,
  };
})()`;

// The actions dock is sticky, and a browser moving focus into a scroller scrolls only when the
// element is outside the scrollport: it cannot know the dock covers the scrollport's bottom. A link
// a person has scrolled under the dock stays there when Tab reaches it, its focus ring hidden behind
// the buttons (WCAG 2.4.11), unless the link's own scroll margin keeps it clear. A camera card and
// its still outgrow the 230 px popup at any text size (the next test); this one runs at 24 px,
// Chrome's "Very large" text setting.
test('at a larger text size, a Tab onto a camera card link the dock covers brings the link out from under the dock', { skip: siteSkip }, async () => {
  const page = await freshDashboard();
  await page.evaluate(svgStills);
  await page.evaluate("document.documentElement.style.fontSize = '24px'; void 0;");
  await page.evaluate(VIEW_SALINAS + "document.getElementById('qcm-layer-roadCameras').click(); void 0;");
  await waitInPage(page, 'a road camera pin', "Boolean(document.querySelector('.qcm-camera-pin--road'))", CEILING, null);
  await page.evaluate("document.querySelector('.qcm-camera-pin--road').click(); void 0;");
  await waitInPage(page, 'the still to load', `(() => { const img = document.querySelector('.leaflet-popup .qcm-camera-media img');
    return Boolean(img) && img.complete && img.naturalWidth === 320; })()`, CEILING, null);
  // Park the still's link inside the scrollport, its bottom 4 px above the scrollport's own.
  const parked = await page.evaluate(`(() => {
    const box = document.querySelector('.leaflet-popup .leaflet-popup-content');
    const link = box.querySelector('.qcm-camera-media a');
    box.scrollTop += link.getBoundingClientRect().bottom - (box.getBoundingClientRect().top + box.clientHeight - 4);
    return ${linkAndDock};
  })()`);
  assert.equal(parked.scrollable, true, `the card fits its popup, so nothing can sit under the dock: ${JSON.stringify(parked)}`);
  assert.equal(parked.inside && parked.under, true, `setup: the link is not inside the scrollport and under the dock: ${JSON.stringify(parked)}`);

  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.evaluate("document.querySelector('.leaflet-popup .qcm-site-card').focus({ preventScroll: true }); void 0;");
  await trustedKey(page, 'Tab', 9);
  const focused = await page.evaluate(linkAndDock);
  assert.equal(focused.active, "Open this picture on Caltrans's site", `Tab from the card did not reach the still's link: ${JSON.stringify(focused)}`);
  assert.equal(focused.under, false, `the focused link is still under the dock: ${JSON.stringify(focused)}`);
  assert.equal(focused.inside, true, `the focused link left the popup's visible area: ${JSON.stringify(focused)}`);
});

// The popup's 230 px caps whatever the card holds, not only what it held as it opened. Leaflet's
// own maxHeight measures the card once, inside the popup's open, and wireCameraPin adds the still
// in the pin's popupopen handler after that: the card then grew with the picture to about 384 px
// at the default text size, with nothing to scroll.
test('a camera card stays within its 230 px popup once the still loads, and scrolls instead', { skip: siteSkip }, async () => {
  const page = await freshDashboard();
  await page.evaluate(svgStills);
  await page.evaluate(VIEW_SALINAS + "document.getElementById('qcm-layer-roadCameras').click(); void 0;");
  await waitInPage(page, 'a road camera pin', "Boolean(document.querySelector('.qcm-camera-pin--road'))", CEILING, null);
  await page.evaluate("document.querySelector('.qcm-camera-pin--road').click(); void 0;");
  await waitInPage(page, 'the still to load', `(() => { const img = document.querySelector('.leaflet-popup .qcm-camera-media img');
    return Boolean(img) && img.complete && img.naturalWidth === 320; })()`, CEILING, null);
  const box = await page.evaluate(`(() => {
    const el = document.querySelector('.leaflet-popup .leaflet-popup-content');
    return { height: el.getBoundingClientRect().height, scrollHeight: el.scrollHeight, overflowY: getComputedStyle(el).overflowY };
  })()`);
  assert.ok(box.height <= 230.5, `the card grew past its 230 px popup once the still loaded: ${JSON.stringify(box)}`);
  assert.ok(box.scrollHeight > box.height + 1, `setup: the card and its still fit the popup, so no cap is shown: ${JSON.stringify(box)}`);
  assert.match(box.overflowY, /^(auto|scroll)$/, `the capped card cannot be scrolled to its hidden part: ${JSON.stringify(box)}`);
});

// spec-a11y-2 (WCAG 4.1.3, status messages), against main.js's own wiring: the picture's
// line ("Loading picture…", its age, "did not load") changes after the card has focus, so
// it reaches a screen reader only as a polite live region in Chromium's accessibility tree
// (read over the DevTools protocol, as finder-loading.test.mjs does). The stubbed still has
// no Last-Modified, so the line settles on ageText(null)'s fixed sentence. Like
// finder-announcement.test.mjs, this proves the tree, not that a screen reader spoke.
test('a camera card\'s picture line reaches the accessibility tree as a polite live region', { skip: siteSkip }, async () => {
  const page = await freshDashboard();
  await page.evaluate(VIEW_SALINAS + "document.getElementById('qcm-layer-roadCameras').click(); void 0;");
  await waitInPage(page, 'a road camera pin', "Boolean(document.querySelector('.qcm-camera-pin--road'))", CEILING, null);
  await page.evaluate("document.querySelector('.qcm-camera-pin--road').click(); void 0;");
  const SAID = "Caltrans's server did not say when this picture changed.";
  await waitInPage(page, "the picture's line to settle", `(() => { const p = document.querySelector('.leaflet-popup .qcm-camera-media p');
    return Boolean(p) && p.textContent === ${JSON.stringify(SAID)}; })()`, CEILING, null);
  await page.send('Accessibility.enable');
  const { nodes } = await page.send('Accessibility.getFullAXTree');
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  // Leaf text only: Chromium also names a status region from its contents (site-card.test.mjs).
  const textOf = (n) => (n.childIds?.length
    ? n.childIds.map((id) => (byId.has(id) ? textOf(byId.get(id)) : '')).join(' ')
    : n.name?.value ?? '').trim();
  const regions = nodes.filter((n) => !n.ignored && n.role?.value === 'status')
    .map((n) => ({ live: (n.properties ?? []).find((p) => p.name === 'live')?.value?.value ?? null, text: textOf(n) }));
  const carrying = regions.filter((r) => r.text === SAID);
  assert.equal(carrying.length, 1,
    `the picture's line "${SAID}" is in ${carrying.length} status regions (all: ${JSON.stringify(regions)}); `
    + 'a screen reader is told about the picture only if exactly one region carries it');
  assert.equal(carrying[0].live, 'polite', `the picture's line is aria-live "${carrying[0].live}", not polite`);
});
