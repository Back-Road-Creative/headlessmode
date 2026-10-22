// QUX-08D-i, test 7: road cameras end to end, against the real built site and a real
// Chromium, proving the whole request-count contract camera-card.test.mjs's harness only
// modeled in isolation. Reuses terrain-panel.test.mjs's own minimal CDP session
// (connectSession/interceptNetwork -- helpers/browser.mjs's launch() only exposes a
// ONCE-per-event model via `once()`, and proving "no eager request" needs a PERSISTENT
// Fetch.requestPaused subscription for the whole test) and its skip-when-unbuilt gate.
//
// C19 note (spec departure, see the report): the spec's "Build stays enabled with the
// row on" sub-assertion depends on PR #604's fetchedBySourcePass/canBuild fix, which this
// unit is explicitly forbidden from implementing (D14/C19 is superseded, fixed once for
// every screenOnly row by #604). That sub-assertion is dropped from this test; 08D-i must
// merge after #604.
//
// QUX-08D-ii (test 12, #604 landed by the time this file moved here per the plan's "if
// 08D-i measures over 850" rule -- see the report): extends interceptNetwork with a
// second cross-origin fulfillment (www.nps.gov, no ACAO needed since it is only ever
// loaded into an <img>, never fetch()ed), and adds a park-cameras test alongside the
// road-cameras one above. The two tests never share a session or a site server, so a
// change to one provider's flow can never leak state into the other's assertions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DEFAULT_PROTOCOL_TIMEOUT_MS, findChromium, navigatePage, OFFLINE_ARGS, removeProfile } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage } from './helpers/waits.mjs';
import { settlePaused } from './helpers/paused-request.mjs';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { INDEX_PATH, D05_PATH, CAMERA_DIR, d05Stub, fixedFilesStub, FIXED_ROWS } from './helpers/camera-snapshot-stub.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built — run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const CCTV_ORIGIN = SOURCES.caltransCctv.origin; // https://cwwp2.dot.ca.gov
// U4a: the road list is the site's own snapshot (index.json plus one file per district), so no
// request to cwwp2 is ever the LIST; every cwwp2 request is a picture.
const isCctvUrl = (url) => url.startsWith(CCTV_ORIGIN);
const isListUrl = (url) => isCctvUrl(url) && /cctvStatus/i.test(url);
const isImageUrl = (url) => isCctvUrl(url) && !isListUrl(url);
const pathOf = (url) => new URL(url).pathname;
const isIndexUrl = (url) => !isCctvUrl(url) && pathOf(url) === INDEX_PATH;
const isRoadFileUrl = (url) => !isCctvUrl(url) && pathOf(url).startsWith(`${CAMERA_DIR}/caltrans-cwwp2/`);

// QUX-08D-ii: the NPS still host (never fetch()ed, only ever an <img src>, so no ACAO is
// needed) and the same-origin build-time snapshot the page reads instead of ever asking
// NPS for the camera list itself.
const NPS_ORIGIN = SOURCES.npsWebcams.origin; // https://www.nps.gov
const SNAPSHOT_PATH = `${CAMERA_DIR}/nps-webcams/nps-nc.json`;
const isNpsImageUrl = (url) => url.startsWith(NPS_ORIGIN);
// PhenoCam and AviationWX stills are painted straight into an <img src>, like NPS's (QUX-08D-ii).
const DIRECT_STILL_ORIGINS = [SOURCES.phenocam.origin, SOURCES.aviationwx.origin];
const isDirectStillUrl = (url) => DIRECT_STILL_ORIGINS.some((o) => url.startsWith(`${o}/`));
const isSnapshotUrl = (url, docUrl) => url === `${new URL(docUrl).origin}${SNAPSHOT_PATH}`;

// A two-camera fixture: one active (has a still, fetch plan), one inactive (no fetch --
// already proven at the unit level by camera-layer.test.mjs's stillPlan tests and
// camera-card.test.mjs's "an inactive camera never fetches at all"; this file's job is the
// REQUEST COUNT, not the plan logic). Same shape the real cctvStatusD05.json answers.
const CATALOG_FIXTURE = {
  data: [
    {
      cctv: {
        index: '1',
        location: {
          district: '5', locationName: 'US-101 : North Main Street', nearbyPlace: 'Salinas',
          longitude: '-121.653231', latitude: '36.687188',
        },
        inService: 'true',
        imageData: {
          imageDescription: '', streamingVideoURL: '',
          static: { currentImageURL: `${CCTV_ORIGIN}/data/d5/cctv/image/us101northmainstreet/us101northmainstreet.jpg` },
        },
      },
    },
    {
      cctv: {
        index: '2',
        location: {
          district: '5', locationName: 'US-101 : Cabrillo Blvd', nearbyPlace: 'Santa Barbara',
          longitude: '-119.659076', latitude: '34.423288',
        },
        inService: 'false',
        imageData: {
          imageDescription: '', streamingVideoURL: '',
          static: { currentImageURL: `${CCTV_ORIGIN}/data/d5/cctv/image/us101cabrilloblvd/us101cabrilloblvd.jpg` },
        },
      },
    },
  ],
};
const STUB = d05Stub(CATALOG_FIXTURE);
const INDEX_B64 = Buffer.from(STUB.indexJson).toString('base64');
const D05_B64 = Buffer.from(STUB.d05Json).toString('base64');
// A real, tiny, decodable JPEG (same "hand-rolled, no fixture file" approach as
// pdf.test.mjs's minimal JPEG and camera-card.test.mjs's TINY_JPEG_B64) -- this test never
// decodes it (no <img> paint is asserted here, only the fetch happened), so any valid JPEG
// byte sequence proving the response round-trip is enough.
const TINY_JPEG_B64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

// --- the same minimal, persistent-subscription CDP session terrain-panel.test.mjs builds
// (helpers/browser.mjs's launch() only exposes once()) -- spawn/profile/cleanup mirrors
// that file's connectSession exactly; only the interception rules differ below.
const PROFILE_ROOT = path.join(homedir(), '.cache', 'qcm-chrome');
const deadline = (ms) => { const end = Date.now() + ms; return () => Date.now() < end; };

async function connectSession({ args = [] } = {}) {
  mkdirSync(PROFILE_ROOT, { recursive: true });
  const profile = mkdtempSync(path.join(PROFILE_ROOT, 'profile-'));
  const child = spawn(CHROMIUM, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
    ...OFFLINE_ARGS, ...args, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b; });
  const cleanup = () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    removeProfile(profile);
  };
  try {
    const file = path.join(profile, 'DevToolsActivePort');
    const portWait = deadline(30000);
    let port = null;
    while (portWait() && child.exitCode === null) {
      try {
        const text = readFileSync(file, 'utf8'), nl = text.indexOf('\n');
        if (nl > 0) { port = Number(text.slice(0, nl)); break; }
      } catch { /* not written yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!port) throw new Error(`Chromium reported no DevTools port: ${stderr.slice(0, 400)}`);
    const jsonWait = deadline(30000);
    let targets = null;
    while (jsonWait()) {
      try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    const target = targets?.find((t) => t.type === 'page');
    if (!target) throw new Error(`no page target: ${stderr.slice(0, 400)}`);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`devtools socket failed: ${stderr.slice(0, 400)}`)), { once: true });
    });
    let id = 0;
    const pending = new Map();
    const listeners = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method && listeners.has(m.method)) { for (const fn of listeners.get(m.method)) fn(m.params); }
    });
    ws.addEventListener('close', () => {
      const why = `devtools socket closed: ${stderr.slice(0, 400)}`;
      for (const [, settle] of pending) settle({ error: { message: why } });
      pending.clear();
    });
    const send = (method, params) => new Promise((resolve, reject) => {
      const mine = ++id;
      const timer = setTimeout(() => { pending.delete(mine); reject(new Error(`${method} timed out after ${DEFAULT_PROTOCOL_TIMEOUT_MS} ms`)); }, DEFAULT_PROTOCOL_TIMEOUT_MS);
      pending.set(mine, (m) => { clearTimeout(timer); m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result); });
      ws.send(JSON.stringify({ id: mine, method, params }));
    });
    const on = (method, fn) => {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(fn);
      return () => listeners.get(method)?.delete(fn);
    };
    const once = (method, ms = 30000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`${method} never fired within ${ms} ms`)); }, ms);
      const off = on(method, (p) => { clearTimeout(timer); off(); resolve(p); });
    });
    const navigate = (target) => navigatePage(send, once, target);
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 30000 });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error(`page threw: ${d.exception?.description ?? d.text}`);
      }
      return r.result.value;
    };
    return { send, on, once, evaluate, navigate, close: () => { try { ws.close(); } finally { cleanup(); } } };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** Intercepts every request. The catalogue URL is fulfilled with the two-camera fixture;
 *  any other cwwp2 URL (an image) is fulfilled with a tiny JPEG plus Last-Modified and an
 *  ACAO * header (the shape fetchCaltransCctv's caller reads for the age line); any
 *  www.nps.gov URL (QUX-08D-ii) is fulfilled with the same tiny JPEG, no ACAO needed since
 *  it is only ever painted as an <img src>, never fetch()ed; everything else -- including
 *  the same-origin NPS snapshot JSON -- passes through to the local site server, which
 *  serves the real built public/ output. The document itself is also paused at the
 *  response stage so any CSP header is dropped and only the page's own meta policy applies.
 *  Every verdict goes through settlePaused: the page may cancel a paused request first, or
 *  the test's teardown may have closed the session, and neither may fail another test. */
async function interceptNetwork(session, { docUrl, stub = false, files = null }) {
  const seen = [];
  const unsubscribe = session.on('Fetch.requestPaused', async (p) => {
    const { requestId, request, responseStatusCode, responseHeaders } = p;
    if (responseStatusCode !== undefined) {
      // Drop any CSP header: the shipped page carries its policy as a <meta> alone, so serve it as-is.
      const headers = (responseHeaders || []).filter((h) => h.name.toLowerCase() !== 'content-security-policy');
      await settlePaused(session.send, 'Fetch.continueResponse', { requestId, responseCode: responseStatusCode, responseHeaders: headers });
      return;
    }
    seen.push({ url: request.url, resourceType: p.resourceType });
    if (files && files[pathOf(request.url)] !== undefined && !isCctvUrl(request.url)) {
      await settlePaused(session.send, 'Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body: Buffer.from(files[pathOf(request.url)]).toString('base64'),
      });
    } else if (stub && (isIndexUrl(request.url) || pathOf(request.url) === D05_PATH)) {
      await settlePaused(session.send, 'Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body: isIndexUrl(request.url) ? INDEX_B64 : D05_B64,
      });
    } else if (isImageUrl(request.url)) {
      await settlePaused(session.send, 'Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [
          { name: 'content-type', value: 'image/jpeg' },
          { name: 'access-control-allow-origin', value: '*' },
          { name: 'last-modified', value: new Date(Date.now() - 3 * 60 * 1000).toUTCString() },
        ],
        body: TINY_JPEG_B64,
      });
    } else if (isNpsImageUrl(request.url) || isDirectStillUrl(request.url)) {
      await settlePaused(session.send, 'Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'image/jpeg' }],
        body: TINY_JPEG_B64,
      });
    } else {
      await settlePaused(session.send, 'Fetch.continueRequest', { requestId });
    }
  });
  await session.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*', requestStage: 'Request' },
      { urlPattern: docUrl, requestStage: 'Response' },
    ],
  });
  return { seen, unsubscribe };
}

const CSP_LISTENER_SOURCE = `window.__cspViolations = [];
document.addEventListener('securitypolicyviolation', (e) => {
  window.__cspViolations.push(e.violatedDirective + ': ' + e.blockedURI);
});`;

const tickRoadCameras = `document.getElementById('qcm-layer-roadCameras').click(); void 0;`;
const roadCamerasChecked = `document.getElementById('qcm-layer-roadCameras').checked`;
const firstPinPresent = `Boolean(document.querySelector('.qcm-camera-pin--road'))`;
const noPinsLeft = `!document.querySelector('.qcm-camera-pin--road')`;
const clickFirstPin = `document.querySelector('.qcm-camera-pin--road').click(); void 0;`;
const popupOpen = `Boolean(document.querySelector('.qcm-site-card'))`;
const popupGone = `!document.querySelector('.qcm-site-card')`;
const panMap = `(() => { window.qcMap.panBy([50, 0], { animate: false }); void 0; })()`;
// The pins load only from MIN_PIN_ZOOM (7), so a test puts the map where its cameras are first.
const viewAt = (lat, lon, zoom) => `(() => { window.qcMap.setView([${lat}, ${lon}], ${zoom}, { animate: false }); void 0; })()`;

// QUX-08D-ii: park cameras' own DOM hooks, same conventions as the road-camera ones above.
const tickParkCameras = `document.getElementById('qcm-layer-parkCameras').click(); void 0;`;
const firstParkPinPresent = `Boolean(document.querySelector('.qcm-camera-pin--park'))`;
const clickFirstParkPin = `document.querySelector('.qcm-camera-pin--park').click(); void 0;`;
const parkReportText = `(document.getElementById('qcm-layer-parkCameras-report') || {}).textContent || ''`;

async function waitForNode(what, ok, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    if (ok()) return true;
    if (Date.now() >= end) throw new Error(`waited ${ms} ms and ${what} never came true`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// PR CI run 39412223351 (#855, box load ~60): this file's own DevTools client gave every command
// 30 s, so Page.navigate gave up while helpers/browser.mjs launch() would have waited 120 s for the
// same call. A command here waits the shared protocol deadline; only `once` callers pass less.
test('every DevTools command in this file waits the shared protocol deadline, not its own 30 s', () => {
  const src = readFileSync(new URL(import.meta.url), 'utf8');
  const timer = src.match(/reject\(new Error\(`\$\{method\} timed out[^;]*;\s*\}, ([A-Z_0-9]+|\d+)\);/);
  assert.ok(timer, 'send() arms a per-command timer');
  assert.equal(timer[1], 'DEFAULT_PROTOCOL_TIMEOUT_MS', `send() waits ${timer[1]}, not DEFAULT_PROTOCOL_TIMEOUT_MS (${DEFAULT_PROTOCOL_TIMEOUT_MS} ms)`);
});

test('road cameras: no eager requests, one index fetch and one district-file fetch on toggle-on, pan never re-fetches them, opening a pin fetches its own image once, toggle-off clears the pins, no CSP violation', { skip }, async () => {
  const site = await startSiteServer();
  const docUrl = `${site.origin}/quiet-corners/`;
  const session = await connectSession();
  try {
    await session.send('Page.enable');
    await session.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: CSP_LISTENER_SOURCE });
    const { seen } = await interceptNetwork(session, { docUrl, stub: true });

    await session.navigate(docUrl);
    await readyDashboard(session, { ms: 60000 });

    const indexSeen = () => seen.filter((r) => isIndexUrl(r.url));
    const fileSeen = () => seen.filter((r) => isRoadFileUrl(r.url));
    const listSeen = () => seen.filter((r) => isListUrl(r.url));
    const catalogSeen = () => [...indexSeen(), ...fileSeen()];
    const imageSeen = () => seen.filter((r) => isImageUrl(r.url));

    // Case 1: nothing eager -- the row is off by default.
    assert.equal(catalogSeen().length, 0, `an index or district file request happened before Road cameras was toggled on: ${JSON.stringify(catalogSeen())}`);
    assert.equal(imageSeen().length, 0, `an image request happened before any pin was opened: ${JSON.stringify(imageSeen())}`);

    // Case 2: toggle on at Salinas, zoom 9 -- exactly one index request and one District 5 file
    // request, no request for cwwp2's own list, still zero image requests, pins drawn.
    await session.evaluate(viewAt(36.6, -121.7, 9));
    await session.evaluate(tickRoadCameras);
    await waitForNode('the index and district file requests', () => catalogSeen().length >= 2);
    await waitInPage(session, 'a road camera pin', firstPinPresent, 30000, null);
    assert.equal(indexSeen().length, 1, `expected one index request, got ${JSON.stringify(indexSeen())}`);
    assert.equal(fileSeen().length, 1, `expected one district file request, got ${JSON.stringify(fileSeen())}`);
    assert.equal(listSeen().length, 0, `the browser asked cwwp2 for a list: ${JSON.stringify(listSeen())}`);
    assert.equal(imageSeen().length, 0, 'an image request happened before any pin was opened');

    // Case 3: pan -- pins are drawn once, not on moveend, so no second catalogue request.
    await session.evaluate(panMap);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(catalogSeen().length, 2, `panning re-fetched the index or the district file: ${JSON.stringify(catalogSeen())}`);

    // Case 4: opening a pin fetches its own still once.
    await session.evaluate(clickFirstPin);
    await waitInPage(session, 'the camera card to open', popupOpen, 15000, null);
    await waitForNode('the image request', () => imageSeen().length >= 1);
    assert.equal(imageSeen().length, 1, `expected exactly one image request after opening a pin, got ${imageSeen().length}: ${JSON.stringify(imageSeen())}`);

    // Case 5: panning with the card open re-fetches neither the catalogue nor the image, and
    // the card stays open (pins/cards don't redraw on moveend).
    await session.evaluate(panMap);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(catalogSeen().length, 2, 'panning with a card open re-fetched the index or the district file');
    assert.equal(imageSeen().length, 1, 'panning with a card open re-fetched the open image');
    assert.equal(await session.evaluate(popupOpen), true, 'the camera card closed on pan');

    // Case 6: toggling off removes the pins and closes any open card. Leaflet's own popup
    // close runs a 200ms fade-out (DivOverlay.onRemove defers the DOM detach via setTimeout
    // when the map is fade-animated) -- so this polls rather than asserting immediately.
    await session.evaluate(tickRoadCameras);
    await waitInPage(session, 'the road camera pins to be gone', noPinsLeft, 15000, null);
    assert.equal(await session.evaluate(roadCamerasChecked), false, 'the checkbox did not read unchecked after toggling off');
    await waitInPage(session, 'the camera card to close', popupGone, 2000, null);

    // Case 7: none of the above tripped the real production CSP.
    const violations = await session.evaluate('window.__cspViolations');
    assert.deepEqual(violations, [], `CSP violation(s) during the road-cameras flow: ${JSON.stringify(violations)}`);
  } finally {
    session.close();
    await site.close();
  }
});

// QUX-08D-ii, test 12: park cameras end to end. Unlike road cameras, the camera LIST comes
// from this site's own build-time snapshot (a same-origin request, never nps.gov itself --
// D6), while the PICTURE for an open camera comes straight from www.nps.gov as a plain
// <img src>, painted rather than fetched, since NPS grants this page no CORS header to read.
test('park cameras: no eager requests, one same-origin snapshot fetch on toggle-on, opening Purchase Knob fetches its own nps.gov image once, the report counts the park cameras with no request of its own, no CSP violation', { skip }, async () => {
  const site = await startSiteServer();
  const docUrl = `${site.origin}/quiet-corners/`;
  const session = await connectSession();
  try {
    await session.send('Page.enable');
    await session.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: CSP_LISTENER_SOURCE });
    const { seen } = await interceptNetwork(session, { docUrl, files: fixedFilesStub() });

    await session.navigate(docUrl);
    await readyDashboard(session, { ms: 60000 });

    const snapshotSeen = () => seen.filter((r) => isSnapshotUrl(r.url, docUrl));
    const npsImageSeen = () => seen.filter((r) => isNpsImageUrl(r.url));

    // Case 1: nothing eager -- the row is off by default.
    assert.equal(snapshotSeen().length, 0, `a snapshot request happened before Park cameras was toggled on: ${JSON.stringify(snapshotSeen())}`);
    assert.equal(npsImageSeen().length, 0, `an nps.gov image request happened before any pin was opened: ${JSON.stringify(npsImageSeen())}`);

    // Case 2: put the map on the Smokies (zoom 10), toggle on -- exactly one same-origin snapshot request, still zero nps.gov
    // requests, and pins drawn for the located cameras only (Purchase Knob, Look Rock,
    // Newfound Gap).
    await session.evaluate(viewAt(35.6, -83.5, 10));
    await session.evaluate(tickParkCameras);
    await waitForNode('the snapshot request', () => snapshotSeen().length >= 1);
    await waitInPage(session, 'a park camera pin', firstParkPinPresent, 30000, null);
    assert.equal(snapshotSeen().length, 1, `expected exactly one snapshot request after toggling on, got ${snapshotSeen().length}: ${JSON.stringify(snapshotSeen())}`);
    assert.equal(npsImageSeen().length, 0, 'an nps.gov image request happened before any pin was opened');

    // Case 3: the report paragraph counts the three located cameras the nationwide snapshot holds
    // for this area (nps-nc.json lists no unlocated one; naming unlocated cameras is proven at the
    // unit level by camera-layer.test.mjs), and reading it triggers no request beyond the snapshot.
    const reportText = await session.evaluate(parkReportText);
    assert.match(reportText, /^3 park cameras in this view\./, `the park report did not count the three cameras: ${JSON.stringify(reportText)}`);
    assert.equal(snapshotSeen().length, 1, 'reading the park report triggered a snapshot request of its own');
    assert.equal(npsImageSeen().length, 0, 'reading the park report triggered an nps.gov request of its own');

    // Case 4: opening Purchase Knob (the first pin drawn -- the located cameras keep the
    // snapshot's own order) fetches its own nps.gov still once, painted directly as an
    // <img src> rather than read into a blob.
    await session.evaluate(clickFirstParkPin);
    await waitInPage(session, 'the camera card to open', popupOpen, 15000, null);
    await waitForNode('the nps.gov image request', () => npsImageSeen().length >= 1);
    assert.equal(npsImageSeen().length, 1, `expected exactly one nps.gov image request after opening a pin, got ${npsImageSeen().length}: ${JSON.stringify(npsImageSeen())}`);
    assert.equal(snapshotSeen().length, 1, 'opening a pin re-fetched the same-origin snapshot');

    // Case 5: none of the above tripped the real production CSP -- img-src must allow
    // www.nps.gov even though connect-src (D6) deliberately excludes it.
    const violations = await session.evaluate('window.__cspViolations');
    assert.deepEqual(violations, [], `CSP violation(s) during the park-cameras flow: ${JSON.stringify(violations)}`);
  } finally {
    session.close();
    await site.close();
  }
});

// U4a: all 12 Caltrans districts, read by map area from the real committed snapshot (no stub).
test('road cameras: the browser reads snapshot files by map area, never the cwwp2 list; below zoom 7 nothing loads', { skip }, async () => {
  const site = await startSiteServer();
  const docUrl = `${site.origin}/quiet-corners/`;
  const session = await connectSession();
  try {
    await session.send('Page.enable');
    await session.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: CSP_LISTENER_SOURCE });
    const { seen } = await interceptNetwork(session, { docUrl });
    await session.navigate(docUrl);
    await readyDashboard(session, { ms: 60000 });

    const files = () => seen.filter((r) => isRoadFileUrl(r.url)).map((r) => pathOf(r.url).split('/').pop());
    const lists = () => seen.filter((r) => isListUrl(r.url));
    const reportText = `(document.getElementById('qcm-layer-roadCameras-report') || {}).textContent || ''`;

    // Zoomed out over California: the layer is on, no district file is read, the report says to zoom in.
    await session.evaluate(viewAt(37.0, -120.5, 5));
    await session.evaluate(tickRoadCameras);
    await waitInPage(session, 'the zoom-in hint', `/zoom in/i.test(${reportText})`, 30000, null);
    assert.deepEqual(files(), [], 'a district file was read below zoom 7');
    assert.equal(await session.evaluate(firstPinPresent), false, 'pins drawn below zoom 7');

    // District 4 (Bay Area), zoom 9: its file loads once and a pin shows.
    await session.evaluate(viewAt(37.77, -122.42, 9));
    await waitInPage(session, 'a District 4 pin', firstPinPresent, 30000, null);
    assert.equal(files().filter((f) => f === 'ca-d04.json').length, 1, `District 4 file reads: ${JSON.stringify(files())}`);
    assert.equal(files().includes('ca-d11.json'), false, 'a district outside the view was read');

    // District 7 (Los Angeles): loads once; coming back to District 4 reads nothing again.
    await session.evaluate(viewAt(34.05, -118.25, 9));
    await waitForNode('the District 7 file', () => files().includes('ca-d07.json'));
    await session.evaluate(viewAt(37.77, -122.42, 9));
    await new Promise((r) => setTimeout(r, 500));
    const counts = {};
    for (const f of files()) counts[f] = (counts[f] || 0) + 1;
    assert.ok(Object.values(counts).every((n) => n === 1), `a district file was read twice: ${JSON.stringify(counts)}`);
    assert.equal(lists().length, 0, `the browser asked cwwp2 for a list: ${JSON.stringify(lists())}`);
    assert.deepEqual(await session.evaluate('window.__cspViolations'), []);
  } finally {
    session.close();
    await site.close();
  }
});

// Link-only cameras (HPWREN, AlertWest): the page reads their snapshot files by map area like the
// others, but a pin's card holds the name, the credit and a "View on" link -- no <img> -- and the
// browser never makes a request to either owner's host.
const isLinkOwnerUrl = (url) => /hpwren|ucsd\.edu|alertwest|weathernode/i.test(new URL(url).hostname);
const tickLinkCameras = `document.getElementById('qcm-layer-linkCameras').click(); void 0;`;
const openPinNamed = (name) => `document.querySelector('.qcm-camera-pin--link[title=${JSON.stringify(name)}]').click(); void 0;`;
const closePopup = `window.qcMap.closePopup(); void 0;`;
const cardState = `(() => {
  const card = document.querySelector('.qcm-site-card');
  const a = card && [...card.querySelectorAll('a')].find((x) => /^View on /.test(x.textContent));
  return card && { text: card.textContent, imgs: card.querySelectorAll('img').length, link: a && { text: a.textContent, href: a.href } };
})()`;

test('link-only cameras: HPWREN and AlertWest pins show a name, a credit and a View-on link, no <img>, and no request to either owner', { skip }, async () => {
  const [hp] = FIXED_ROWS.hpwren;
  const [aw] = FIXED_ROWS.alertwest;
  const site = await startSiteServer();
  const docUrl = `${site.origin}/quiet-corners/`;
  const session = await connectSession();
  try {
    await session.send('Page.enable');
    await session.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: CSP_LISTENER_SOURCE });
    const { seen } = await interceptNetwork(session, { docUrl, files: fixedFilesStub() });
    await session.navigate(docUrl);
    await readyDashboard(session, { ms: 60000 });
    const ownerSeen = () => seen.filter((r) => isLinkOwnerUrl(r.url));
    const linkFiles = () => seen.filter((r) => /\/(hpwren|alertwest)\//.test(pathOf(r.url))).map((r) => pathOf(r.url).split('/').pop());

    assert.deepEqual(linkFiles(), [], 'a link-camera file was read before the layer was switched on');
    await session.evaluate(viewAt(hp[2], hp[3], 12));
    await session.evaluate(tickLinkCameras);
    await waitInPage(session, 'an HPWREN pin', `Boolean(document.querySelector('.qcm-camera-pin--link[title=${JSON.stringify(hp[1])}]'))`, 30000, null);
    assert.deepEqual(linkFiles(), ['hpwren-ca.json'], 'only the HPWREN file touches this view');

    await session.evaluate(openPinNamed(hp[1]));
    await waitInPage(session, 'the HPWREN card', popupOpen, 15000, null);
    const hpCard = await session.evaluate(cardState);
    assert.equal(hpCard.imgs, 0, 'an HPWREN card holds an <img>');
    assert.ok(hpCard.text.includes(hp[1]), `the card does not name the camera: ${hpCard.text}`);
    assert.ok(hpCard.text.includes('HPWREN, UC San Diego'), `the card carries no credit: ${hpCard.text}`);
    assert.equal(hpCard.link.text, 'View on HPWREN');
    assert.equal(hpCard.link.href, hp[7]);

    await session.evaluate(closePopup);
    await session.evaluate(viewAt(aw[2], aw[3], 12));
    await waitInPage(session, 'an AlertWest pin', `Boolean(document.querySelector('.qcm-camera-pin--link[title=${JSON.stringify(aw[1])}]'))`, 30000, null);
    await session.evaluate(openPinNamed(aw[1]));
    await waitInPage(session, 'the AlertWest card', `document.querySelector('.qcm-site-card')?.textContent.includes(${JSON.stringify(aw[1])})`, 15000, null);
    const awCard = await session.evaluate(cardState);
    assert.equal(awCard.imgs, 0, 'an AlertWest card holds an <img>');
    assert.ok(awCard.text.includes('AlertWest'), `the card carries no credit: ${awCard.text}`);
    assert.equal(awCard.link.text, 'View on AlertWest');
    assert.equal(awCard.link.href, 'https://alertwest.live/');

    assert.deepEqual(ownerSeen().map((r) => r.url), [], 'the browser requested something from a link-only camera owner');
    assert.deepEqual(await session.evaluate('window.__cspViolations'), [], 'CSP violation(s) during the link-camera flow');
  } finally {
    session.close();
    await site.close();
  }
});

// The two direct-<img> picture sources added after NPS: each card, opened from the real committed
// snapshot, paints its own still once from its own operator, under the production CSP.
const SNAPSHOT_ROOT = new URL(`../../static${CAMERA_DIR}/`, import.meta.url).pathname;
const DIRECT_STILL_CASES = [
  { layer: 'phenoCameras', pin: 'qcm-camera-pin--research', file: 'phenocam/us.json', origin: SOURCES.phenocam.origin },
  { layer: 'airportCameras', pin: 'qcm-camera-pin--airport', file: 'aviationwx/us.json', origin: SOURCES.aviationwx.origin },
];
const cardPicture = `(() => {
  const img = document.querySelector('.qcm-site-card img');
  return img && { src: img.src, painted: img.complete && img.naturalWidth > 0 };
})()`;

test('PhenoCam and AviationWX cards: opening a pin paints its own still once, straight from its operator, with no CSP violation', { skip }, async () => {
  const site = await startSiteServer();
  const docUrl = `${site.origin}/quiet-corners/`;
  const session = await connectSession();
  try {
    await session.send('Page.enable');
    await session.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: CSP_LISTENER_SOURCE });
    const { seen } = await interceptNetwork(session, { docUrl });
    await session.navigate(docUrl);
    await readyDashboard(session, { ms: 60000 });

    for (const c of DIRECT_STILL_CASES) {
      const snapshot = JSON.parse(readFileSync(path.join(SNAPSHOT_ROOT, c.file), 'utf8'));
      const [, name, lat, lon, still] = snapshot.rows[0];
      const stillSeen = () => seen.filter((r) => r.url.startsWith(`${c.origin}/`));
      const pinSel = `.${c.pin}[title=${JSON.stringify(name)}]`;
      assert.equal(stillSeen().length, 0, `${c.layer}: a still was requested before any pin was opened`);

      await session.evaluate(viewAt(lat, lon, 12));
      await session.evaluate(`document.getElementById('qcm-layer-${c.layer}').click(); void 0;`);
      await waitInPage(session, `the ${c.layer} pin for ${name}`, `Boolean(document.querySelector(${JSON.stringify(pinSel)}))`, 30000, null);
      assert.equal(stillSeen().length, 0, `${c.layer}: switching the layer on requested a still`);

      await session.evaluate(`document.querySelector(${JSON.stringify(pinSel)}).click(); void 0;`);
      await waitInPage(session, `the ${c.layer} card picture`, `(${cardPicture})?.painted === true`, 15000, null);
      const pic = await session.evaluate(cardPicture);
      assert.equal(pic.src, still, `${c.layer}: the card painted something other than the camera's own still`);
      assert.equal(stillSeen().length, 1, `${c.layer}: expected one still request, got ${JSON.stringify(stillSeen())}`);
      await session.evaluate(closePopup);
    }
    assert.deepEqual(await session.evaluate('window.__cspViolations'), [], 'CSP violation(s) while opening the PhenoCam and AviationWX cards');
  } finally {
    session.close();
    await site.close();
  }
});
