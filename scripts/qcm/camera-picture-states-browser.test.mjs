// QQA-10a: what a reader sees when a camera's PICTURE misbehaves, through the real main.js in a
// real Chromium. camera-card.test.mjs's popup tests drive a copied harness (not main.js), and
// camera-requests.test.mjs answers every picture with a 200, so neither could show the failure
// and stale states a live provider produces. Here the stills are answered with 403, 429 and 500,
// failed outright, or given an old Last-Modified, and the open card is read back.
//
// Two picture plans exist (camera-layer.js providerRow):
//   img    park cameras: an <img src> pointed at the provider; no header to read, so only a
//          load / error state;
//   fetch  road cameras (Caltrans): fetch() into a blob, so the status and Last-Modified are read.
// Nothing here reaches a camera provider: every request to one is answered in the page's network
// layer, from public data (the Caltrans-shaped fixture below and the fixed park rows).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium } from './helpers/browser.mjs';
import { connectSession } from './helpers/cdp-session.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage } from './helpers/waits.mjs';
import { settlePaused } from './helpers/paused-request.mjs';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { INDEX_PATH, D05_PATH, CAMERA_DIR, d05Stub, fixedFilesStub } from './helpers/camera-snapshot-stub.mjs';
import { PICTURE_TIMEOUT_MS } from '../../themes/headlessmode/static/js/quiet-corners-maps/camera-layer.js';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built — run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const CCTV_ORIGIN = SOURCES.caltransCctv.origin;
const NPS_ORIGIN = SOURCES.npsWebcams.origin;
const isCctvUrl = (url) => url.startsWith(CCTV_ORIGIN);
const isNpsImageUrl = (url) => url.startsWith(NPS_ORIGIN);
const pathOf = (url) => new URL(url).pathname;

// One active Caltrans camera (one pin, so the first pin is the one with a picture plan).
const CATALOG = {
  data: [{
    cctv: {
      index: '1',
      location: { district: '5', locationName: 'US-101 : North Main Street', nearbyPlace: 'Salinas', longitude: '-121.653231', latitude: '36.687188' },
      inService: 'true',
      imageData: {
        imageDescription: '', streamingVideoURL: '',
        static: { currentImageURL: `${CCTV_ORIGIN}/data/d5/cctv/image/us101northmainstreet/us101northmainstreet.jpg` },
      },
    },
  }],
};
// The same tiny decodable JPEG camera-requests.test.mjs uses.
const TINY_JPEG_B64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

/** The snapshot files the page reads: the fixed park rows plus one Caltrans district-5 file, joined
 *  under one index. `roadAt` / `parkAt` set each file's generatedAt (what the card's "Camera list
 *  checked" line reads); the other fields stay as the stubs build them. */
function sceneFiles({ roadAt, parkAt } = {}) {
  const road = d05Stub(CATALOG, roadAt ? { generatedAt: roadAt } : {});
  const fixed = fixedFilesStub();
  const index = JSON.parse(fixed[INDEX_PATH]);
  const roadIndex = JSON.parse(road.indexJson).files.filter((f) => f.provider === 'caltrans-cwwp2');
  const files = { ...fixed, [D05_PATH]: road.d05Json };
  if (parkAt) {
    const parkPath = `${CAMERA_DIR}/nps-webcams/nps-nc.json`;
    files[parkPath] = JSON.stringify({ ...JSON.parse(files[parkPath]), generatedAt: parkAt });
    for (const f of index.files) if (f.provider === 'nps-webcams') f.generatedAt = parkAt;
  }
  files[INDEX_PATH] = JSON.stringify({ ...index, files: [...index.files, ...roadIndex] });
  return files;
}

// How each provider's still is answered right now; a test sets these before it opens a card.
//   { status, lastModified, fail, hang }  lastModified: Date | null; fail: refuse the request
//   outright; hang: never answer it (the request stays paused, as a server that accepts the
//   connection and then says nothing).
const reply = {
  cctv: { status: 200, lastModified: null, fail: false, hang: false },
  nps: { status: 200, fail: false, hang: false },
};
let files = sceneFiles();

let shared = null;
async function sharedSession() {
  if (shared) return shared;
  const site = await startSiteServer();
  const session = await connectSession();
  const docUrl = `${site.origin}/quiet-corners/`;
  await session.send('Page.enable');
  await session.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_PROBES });
  const seen = [];
  session.on('Fetch.requestPaused', async (p) => {
    const { requestId, request, responseStatusCode, responseHeaders } = p;
    if (responseStatusCode !== undefined) {
      // Drop any CSP header: the shipped page carries its policy as a <meta> alone, so serve it as-is.
      const headers = (responseHeaders || []).filter((h) => h.name.toLowerCase() !== 'content-security-policy');
      await settlePaused(session.send, 'Fetch.continueResponse', { requestId, responseCode: responseStatusCode, responseHeaders: headers });
      return;
    }
    seen.push(request.url);
    const answer = (answerFor) => settlePaused(session.send, 'Fetch.fulfillRequest', { requestId, ...answerFor });
    const refuse = () => settlePaused(session.send, 'Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' });
    if (!isCctvUrl(request.url) && !isNpsImageUrl(request.url) && files[pathOf(request.url)] !== undefined) {
      await answer({ responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body: Buffer.from(files[pathOf(request.url)]).toString('base64') });
    } else if (isCctvUrl(request.url)) {
      const r = reply.cctv;
      if (r.hang) return;
      if (r.fail) { await refuse(); return; }
      const headers = [{ name: 'content-type', value: r.status === 200 ? 'image/jpeg' : 'text/plain' }, { name: 'access-control-allow-origin', value: '*' }];
      if (r.lastModified) headers.push({ name: 'last-modified', value: r.lastModified.toUTCString() });
      await answer({ responseCode: r.status, responseHeaders: headers, body: r.status === 200 ? TINY_JPEG_B64 : '' });
    } else if (isNpsImageUrl(request.url)) {
      const r = reply.nps;
      if (r.hang) return;
      if (r.fail) { await refuse(); return; }
      await answer({ responseCode: r.status, responseHeaders: [{ name: 'content-type', value: r.status === 200 ? 'image/jpeg' : 'text/plain' }],
        body: r.status === 200 ? TINY_JPEG_B64 : '' });
    } else {
      await settlePaused(session.send, 'Fetch.continueRequest', { requestId });
    }
  });
  await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }, { urlPattern: docUrl, requestStage: 'Response' }] });
  shared = { site, session, docUrl, seen };
  return shared;
}
after(async () => {
  if (!shared) return;
  shared.session.close();
  await shared.site.close();
});

// Page-side probes, installed before the page's own scripts: CSP violations, and every object URL
// the page makes or revokes (a blob a closed card never revoked is a leak).
const PAGE_PROBES = `window.__cspViolations = [];
document.addEventListener('securitypolicyviolation', (e) => { window.__cspViolations.push(e.violatedDirective + ': ' + e.blockedURI); });
window.__blobs = { created: [], revoked: [] };
(() => {
  const make = URL.createObjectURL.bind(URL), drop = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (b) => { const u = make(b); window.__blobs.created.push(u); return u; };
  URL.revokeObjectURL = (u) => { window.__blobs.revoked.push(u); return drop(u); };
})();`;

const viewAt = (lat, lon, zoom) => `(() => { window.qcMap.setView([${lat}, ${lon}], ${zoom}, { animate: false }); void 0; })()`;
const LAYERS = {
  road: { id: 'roadCameras', view: viewAt(36.6, -121.7, 9), pin: '.qcm-camera-pin--road' },
  park: { id: 'parkCameras', view: viewAt(35.6, -83.5, 10), pin: '.qcm-camera-pin--park' },
};
// Above PICTURE_TIMEOUT_MS, so a card waiting out a still that never answers can be read back.
const CEILING = PICTURE_TIMEOUT_MS + 15000;
const cardGone = '!document.querySelector(".qcm-site-card")';
// The open card as a reader sees it: the picture line, pictures, links and the whole text.
const READ_CARD = `(() => {
  const card = document.querySelector('.qcm-site-card');
  if (!card) return null;
  const media = card.querySelector('.qcm-camera-media');
  const status = media.querySelector('[role="status"]');
  const blobSrc = [...document.querySelectorAll('[src^="blob:"],[href^="blob:"]')].length;
  return {
    status: status ? status.textContent : null,
    imgs: media.querySelectorAll('img').length,
    blobSrc,
    links: [...card.querySelectorAll('a')].map((a) => a.textContent),
    text: card.textContent,
  };
})()`;

/** Opens a fresh dashboard on the layer's cameras with the layer on and the first pin's card open. */
async function openCard(which) {
  const { session, docUrl } = await sharedSession();
  const layer = LAYERS[which];
  await session.navigate(docUrl);
  await readyDashboard(session, { ms: 60000 });
  await session.evaluate(layer.view);
  await session.evaluate(`document.getElementById('qcm-layer-${layer.id}').click(); void 0;`);
  await waitInPage(session, `a ${which} camera pin`, `Boolean(document.querySelector('${layer.pin}'))`, CEILING, null);
  await clickPin(which);
  return session;
}
async function clickPin(which) {
  const { session } = await sharedSession();
  await session.evaluate(`document.querySelector('${LAYERS[which].pin}').click(); void 0;`);
  await waitInPage(session, 'the camera card to open', 'Boolean(document.querySelector(".qcm-site-card"))', 15000, null);
}
async function closeCard() {
  const { session } = await sharedSession();
  await session.evaluate('window.qcMap.closePopup(); void 0;');
  await waitInPage(session, 'the camera card to close', cardGone, 5000, null);
}
/** Waits for the card's picture line to say something, then returns the whole card. */
async function cardWithStatus(what, pattern) {
  const { session } = await sharedSession();
  try {
    await waitInPage(session, what, `(() => { const c = ${READ_CARD}; return c && ${pattern}.test(c.status); })()`, CEILING, null);
  } catch (err) {
    throw new Error(`${err.message}. The card read: ${JSON.stringify(await session.evaluate(READ_CARD))}`);
  }
  return session.evaluate(READ_CARD);
}
const blobBalance = async () => (await sharedSession()).session.evaluate('({ ...window.__blobs })');
const cspViolations = async () => (await sharedSession()).session.evaluate('window.__cspViolations');

// --- 1. img plan (park): the provider answers 403, or the request fails outright --------------
for (const [label, set] of [
  ['answers 403', { status: 403, fail: false }],
  ['fails outright', { status: 200, fail: true }],
]) {
  test(`park camera: the still ${label} -> the did-not-load status with the link guidance, no picture left, the park webcam page link kept, no CSP violation`, { skip }, async () => {
    Object.assign(reply.nps, set);
    files = sceneFiles();
    try {
      await openCard('park');
      const card = await cardWithStatus('the did-not-load status', '/did not load/');
      // QQA-10a (2026-10-09): the img path used to say only "The picture did not load."; it now
      // points the reader at the owner's page like the fetch path does.
      assert.equal(card.status, "The picture did not load. Use the link below to open it on the park's site.");
      assert.equal(card.imgs, 0, 'a picture that failed must not leave an <img> in the card');
      assert.ok(card.links.includes('Park webcam page'), `the park webcam page link is gone: ${JSON.stringify(card.links)}`);
      assert.deepEqual(await cspViolations(), [], 'the failed picture tripped the page policy');
      await closeCard();
    } finally {
      Object.assign(reply.nps, { status: 200, fail: false });
    }
  });
}

// --- 2. fetch plan (Caltrans road): 403, 429, 500 or a refused request --------------------------
test('road camera: the still answers 403, 429 and 500 or is refused -> the did-not-load status with the link guidance, both links kept, no blob made; the working still\'s blob is revoked on close', { skip }, async () => {
  files = sceneFiles();
  try {
    // Close and reopen the same pin for each answer; the page is not reloaded between them.
    const answers = [
      { status: 403, fail: false }, { status: 429, fail: false }, { status: 500, fail: false }, { status: 200, fail: true },
    ];
    Object.assign(reply.cctv, answers[0]);
    await openCard('road');
    for (const [i, set] of answers.entries()) {
      if (i > 0) { Object.assign(reply.cctv, set); await clickPin('road'); }
      const card = await cardWithStatus(`the did-not-load status (${JSON.stringify(set)})`, '/did not load/');
      const why = JSON.stringify(set);
      assert.equal(card.status, "The picture did not load. Use the link below to open it on Caltrans's site.", why);
      assert.equal(card.imgs, 0, `${why}: a failed picture left an <img>`);
      assert.equal(card.blobSrc, 0, `${why}: a blob: URL is on the page`);
      assert.deepEqual(card.links, ["Open this picture on Caltrans's site", 'About Caltrans cameras'], `${why}: both links must stay`);
      assert.deepEqual((await blobBalance()).created, [], `${why}: a blob was made for a picture that never came`);
      await closeCard();
    }
    // The control: the same card with a working still makes one blob, and closing revokes it.
    Object.assign(reply.cctv, { status: 200, fail: false });
    await clickPin('road');
    const ok = await cardWithStatus('the working picture', '/Caltrans|Picture file/');
    assert.equal(ok.imgs, 1, 'the working still shows no picture');
    const during = await blobBalance();
    assert.equal(during.created.length, 1, 'the working still made no single blob');
    assert.deepEqual(during.revoked, [], 'the blob was revoked while the card was open');
    await closeCard();
    const after = await blobBalance();
    assert.deepEqual(after.revoked, after.created, 'closing the card did not revoke the blob it made');
    assert.deepEqual(await cspViolations(), [], 'the failed pictures tripped the page policy');
  } finally {
    Object.assign(reply.cctv, { status: 200, lastModified: null, fail: false });
  }
});

// --- 3. stale: Last-Modified 31 minutes and 2 hours old, or absent -------------------------------
test('road camera: a still last changed 31 minutes or 2 hours ago says the camera may be stuck; with no Last-Modified the card says the server did not say', { skip }, async () => {
  files = sceneFiles();
  try {
    reply.cctv.lastModified = new Date(Date.now() - 31 * 60 * 1000);
    await openCard('road');
    let card = await cardWithStatus('the 31 minute age', '/last changed/');
    assert.match(card.status, /^Picture file last changed 31 min ago\. The camera may be stuck\.$/);
    assert.equal(card.imgs, 1, 'a stale picture is still shown');
    await closeCard();

    reply.cctv.lastModified = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await clickPin('road');
    card = await cardWithStatus('the 2 hour age', '/last changed/');
    assert.match(card.status, /^Picture file last changed 2 h ago\. The camera may be stuck\.$/);
    await closeCard();

    reply.cctv.lastModified = null;
    await clickPin('road');
    card = await cardWithStatus('the no-age wording', '/did not say/');
    assert.equal(card.status, "Caltrans's server did not say when this picture changed.");
    assert.doesNotMatch(card.status, /stuck/, 'a picture with no age must not be called stuck');
    assert.equal(card.imgs, 1);
    assert.deepEqual(await cspViolations(), []);
  } finally {
    reply.cctv.lastModified = null;
  }
});

// --- 4. an old snapshot generatedAt reaches the card's "Camera list checked" line ----------------
test('an old snapshot generatedAt shows as the date on the park and the road card', { skip }, async () => {
  files = sceneFiles({ parkAt: '2026-03-03T09:00:00.000Z', roadAt: '2026-02-14T09:00:00.000Z' });
  try {
    await openCard('park');
    let card = await cardWithStatus('the park card', '/^/');
    assert.match(card.text, /Camera list checked 3 Mar 2026\./);
    assert.doesNotMatch(card.text, /Camera list checked 4 Oct 2026/);
    await closeCard();

    await openCard('road');
    card = await cardWithStatus('the road card picture line', '/changed|did not/');
    assert.match(card.text, /Camera list checked 14 Feb 2026\./);
  } finally {
    files = sceneFiles();
  }
});

// --- 5. a still that never answers: the card gives up after PICTURE_TIMEOUT_MS ------------------
// QQA-10g (2026-10-09): before this, neither plan had a time limit. A park still that never
// answered left "Loading picture (about 2 MB)…" on the card for as long as it stayed open, and a
// road still left the picture line empty; the reader was never pointed at the owner's link.
for (const which of ['park', 'road']) {
  test(`${which} camera: a still that never answers -> after the picture time limit (not before) the did-not-load status with the link guidance, no picture, no blob; the next open with a working still shows it`, { skip }, async () => {
    const r = which === 'park' ? reply.nps : reply.cctv;
    const operator = which === 'park' ? 'the park' : 'Caltrans';
    files = sceneFiles();
    try {
      r.hang = true;
      const session = await openCard(which);
      const opened = Date.now();
      const early = await session.evaluate(READ_CARD);
      assert.doesNotMatch(String(early.status), /did not load/, 'the card gave up before the time limit');
      const card = await cardWithStatus('the did-not-load status after the time limit', '/did not load/');
      const waited = Date.now() - opened;
      assert.ok(waited >= PICTURE_TIMEOUT_MS - 2000, `the card gave up after ${waited} ms, before the ${PICTURE_TIMEOUT_MS} ms limit`);
      assert.equal(card.status, `The picture did not load. Use the link below to open it on ${operator}'s site.`);
      assert.equal(card.imgs, 0, 'a picture that never came left an <img> in the card');
      assert.equal(card.blobSrc, 0, 'a blob: URL is on the page');
      assert.deepEqual((await blobBalance()).created, [], 'a blob was made for a picture that never came');
      await closeCard();

      // The control: the same pin, now answered, shows its picture -- the timed-out open did not
      // leave anything behind that stops the next one.
      r.hang = false;
      await clickPin(which);
      const ok = await cardWithStatus('the working picture', which === 'park' ? '/^$/' : '/Caltrans|Picture file/');
      assert.equal(ok.imgs, 1, 'the working still shows no picture after a timed-out open');
      assert.deepEqual(await cspViolations(), []);
      await closeCard();
    } finally {
      r.hang = false;
    }
  });
}
