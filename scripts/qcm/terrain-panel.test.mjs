// E1's browser proof. terrain-view.test.mjs (unit tests, a fake renderer, no DOM
// beyond Node's test runner) already covers the pure logic and the lifecycle
// counters in isolation. What it CANNOT prove is the thing plan §5 actually asks
// for: that in a real browser, against the real vendored MapLibre bundle and the
// production CSP (the page's own <meta>), nothing loads until the reader presses
// "3D", both real origins (the terrarium DEM and the vendored MapLibre files) are
// reached only after that press, Escape and ten open/close cycles leave no
// leaked resource behind, a browser with WebGL turned off gets the plain-language fallback and
// still makes no DEM request, and none of this trips a single CSP violation
// under the policy the built page will actually serve.
//
// helpers/browser.mjs's launch() cannot drive this: its event model answers each
// CDP event ONCE (see its `once()`), and proving "no eager request" needs a
// PERSISTENT subscription to every Fetch.requestPaused the page fires over the
// whole test, so this file opens its own minimal CDP session instead — reusing
// only findChromium() and OFFLINE_ARGS from that helper. No live network is
// reached anywhere below: the browser resolves no host but 127.0.0.1 (OFFLINE_ARGS),
// and every DEM or topo request is answered by CDP interception with a tiny
// synthetic PNG built the same way pdf.test.mjs hand-rolls its minimal JPEG,
// rather than fetching a real DEM tile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { findChromium, navigatePage, OFFLINE_ARGS, removeProfile } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage, chooseExampleArea } from './helpers/waits.mjs';
import { settlePaused } from './helpers/paused-request.mjs';
import { trustedClick } from './helpers/trusted-click.mjs';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { exaggerationLabelText } from '../../themes/headlessmode/static/js/quiet-corners-maps/terrain-view.js';
import { PLACE_FEATURES } from './fixtures/gnis-names-declutter.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built — run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const DEM_ORIGIN = SOURCES.terrainDem.origin; // https://s3.amazonaws.com
const TOPO_ORIGIN = SOURCES.usgsTopo.origin; // https://basemap.nationalmap.gov
const isDemUrl = (url) => url.startsWith(DEM_ORIGIN);
const isVendorMaplibre = (url) => {
  try { return new URL(url).pathname.startsWith('/vendor/maplibre'); } catch { return false; }
};

// --- a tiny 1x1 synthetic PNG, so a fulfilled DEM/topo request never touches the
// real network and MapLibre never chokes trying to decode garbage bytes. Built
// by hand with Node's own zlib — same "no binary fixture file, no new dependency"
// shape pdf.test.mjs already uses for its minimal JPEG.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
function tinyPng() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); // 1x1
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit depth, colour type 2 (RGB, no alpha)
  const raw = Buffer.from([0, 128, 128, 128]); // one scanline: filter byte 0 + one grey pixel
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}
const TINY_PNG_B64 = tinyPng().toString('base64');

// --- a minimal, self-contained CDP session with a PERSISTENT event subscription
// (`on`), which is exactly what helpers/browser.mjs's launch() does not expose.
// Spawn/profile/cleanup logic mirrors launch() deliberately (same flags, same
// PROFILE_ROOT-under-$HOME rationale, same process-group kill) — only the event
// plumbing and the deferred navigate are new.
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
    const listeners = new Map(); // method -> Set(handler)
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
      const timer = setTimeout(() => { pending.delete(mine); reject(new Error(`${method} timed out`)); }, 30000);
      pending.set(mine, (m) => { clearTimeout(timer); m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result); });
      ws.send(JSON.stringify({ id: mine, method, params }));
    });
    /** Persistent subscription — every matching event, not just the first.
     *  Returns an unsubscribe function. */
    const on = (method, fn) => {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(fn);
      return () => listeners.get(method)?.delete(fn);
    };
    const once = (method, ms = 30000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`${method} never fired within ${ms} ms`)); }, ms);
      const off = on(method, (p) => { clearTimeout(timer); off(); resolve(p); });
    });
    // navigatePage waits launch()'s 120 s for the load, not this once()'s 30 s default.
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

/** Intercepts every request. A DEM or topo-origin request is FULFILLED with the
 *  synthetic PNG (no live network, and MapLibre gets bytes it can decode); every
 *  other request (the site's own origin, including the vendored MapLibre module
 *  and CSS) is passed through to the local site server. The exact document URL
 *  is ALSO paused at the response stage so any CSP header is dropped and only the
 *  page's own <meta> policy applies, as shipped. Every verdict goes through settlePaused: the page may cancel a
 *  paused request first, and that reply must not fail whichever test is running.
 *  Returns the running list of every request seen, in order. */
async function interceptNetwork(session, { docUrl }) {
  const seen = [];
  const unsubscribe = session.on('Fetch.requestPaused', async (p) => {
    const { requestId, request, responseStatusCode, responseHeaders } = p;
    if (responseStatusCode !== undefined) {
      // Response stage: only the document itself is paused here (see the pattern
      // below) — strip any CSP header, changing nothing else: the shipped page
      // carries its policy as a <meta> alone.
      const headers = (responseHeaders || []).filter((h) => h.name.toLowerCase() !== 'content-security-policy');
      await settlePaused(session.send, 'Fetch.continueResponse', { requestId, responseCode: responseStatusCode, responseHeaders: headers });
      return;
    }
    seen.push({ url: request.url, resourceType: p.resourceType });
    if (isDemUrl(request.url) || request.url.startsWith(TOPO_ORIGIN)) {
      await settlePaused(session.send, 'Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [
          { name: 'content-type', value: 'image/png' },
          { name: 'access-control-allow-origin', value: '*' },
        ],
        body: TINY_PNG_B64,
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

/** Installed BEFORE navigation so it is present for the page's very first
 *  script — a violation during the initial paint would otherwise be missed. */
const CSP_LISTENER_SOURCE = `window.__cspViolations = [];
document.addEventListener('securitypolicyviolation', (e) => {
  window.__cspViolations.push(e.violatedDirective + ': ' + e.blockedURI);
});`;

const clickTerrainButton = `document.querySelector('.qc-terrain-open').click(); void 0;`;
const escapeKey = `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); void 0;`;
const canvasPresent = `Boolean(document.querySelector('.qc-terrain-dialog canvas'))`;
const canvasGone = `!document.querySelector('.qc-terrain-dialog canvas')`;
const dialogHidden = `(() => { const d = document.querySelector('.qc-terrain-dialog'); return !d || d.hidden; })()`;
const readView = `(() => { const c = window.qcMap.getCenter();
  return { zoom: window.qcMap.getZoom(), lat: Math.round(c.lat * 1e6) / 1e6, lng: Math.round(c.lng * 1e6) / 1e6 }; })()`;
const focusIsButton = `document.activeElement === document.querySelector('.qc-terrain-open')`;
const debugCounters = `window.qcTerrainView.debug()`;
// E2: the draped-overlay/name-label proof and the state-retention check both read
// the 2D trails checkbox and the terrain module's own read-only style snapshot
// (added alongside debug() for exactly this — see terrain-view.js's styleSnapshot).
const tickTrails = `document.getElementById('qcm-layer-trails').click(); void 0;`;
const trailsChecked = `document.getElementById('qcm-layer-trails').checked`;
const styleSnapshot = `window.qcTerrainView.styleSnapshot()`;
const namesPresent = `Boolean(document.querySelector('.qc-terrain-names'))`;

/** Node-side twin of waitInPage, for a condition that lives in `seen` rather than
 *  in the page — a DEM/vendor tile request can land a beat after the canvas
 *  element itself exists, since MapLibre creates the canvas before it schedules
 *  the tile fetch. */
async function waitForNode(what, ok, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    if (ok()) return true;
    if (Date.now() >= end) throw new Error(`waited ${ms} ms and ${what} never came true`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const nodeCounts = `({ canvases: document.querySelectorAll('.qc-terrain-dialog canvas').length,
  dialogs: document.querySelectorAll('.qc-terrain-dialog').length })`;

test('the 3D terrain panel: no eager requests, real origins reached only after the press, Escape and ten cycles leak nothing, all under the real production CSP', { skip }, async () => {
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

    const demSeen = () => seen.filter((r) => isDemUrl(r.url));
    const vendorSeen = () => seen.filter((r) => isVendorMaplibre(r.url));

    // Case 1: nothing eager.
    assert.equal(demSeen().length, 0, `a DEM request happened before the 3D button was pressed: ${JSON.stringify(demSeen())}`);
    assert.equal(vendorSeen().length, 0, `a vendored MapLibre file was fetched before the 3D button was pressed: ${JSON.stringify(vendorSeen())}`);

    const view0 = await session.evaluate(readView);

    // Case 2: press it, a canvas appears, both origins are reached.
    await session.evaluate(clickTerrainButton);
    await waitInPage(session, 'a canvas in the terrain dialog', canvasPresent, 30000, null);
    await waitForNode('a request to the DEM origin', () => demSeen().length >= 1);
    await waitForNode('a request for a vendored MapLibre file', () => vendorSeen().length >= 1);

    // Case 2b (QQA-11): the exaggeration label says what the view is doing. Unticked it names the
    // choice; ticked it states the exaggeration and its factor; unticked again it goes back.
    const exagText = `document.querySelector('.qc-terrain-controls label').textContent`;
    const exagClick = `document.querySelector('.qc-terrain-controls label input').click(); void 0;`;
    const exagOff = exaggerationLabelText(false);
    const exagOn = exaggerationLabelText(true);
    assert.equal(await session.evaluate(exagText), exagOff, 'the exaggeration label is not its unticked text on open');
    await session.evaluate(exagClick);
    assert.equal(await session.evaluate(exagText), exagOn, 'ticking the exaggeration box did not make the label state the exaggeration');
    await session.evaluate(exagClick);
    assert.equal(await session.evaluate(exagText), exagOff, 'clearing the exaggeration box did not put the label back');

    // Case 3: Escape closes it and returns focus to the button.
    await session.evaluate(escapeKey);
    await waitInPage(session, 'the terrain dialog to hide', dialogHidden, 15000, null);
    assert.equal(await session.evaluate(focusIsButton), true, 'focus did not return to the 3D button after Escape');

    // Case 4: Leaflet's own view is untouched by the whole open/close.
    const view1 = await session.evaluate(readView);
    assert.deepEqual(view1, view0, 'the Leaflet center/zoom changed across an open/close of the 3D panel');

    // Case 5: ten more open/close cycles via CDP leave no accumulating canvas/dialog
    // nodes and zero live resources in the module's own counters.
    for (let i = 0; i < 10; i++) {
      await session.evaluate(clickTerrainButton);
      await waitInPage(session, `cycle ${i}: a canvas in the terrain dialog`, canvasPresent, 30000, null);
      await session.evaluate(escapeKey);
      await waitInPage(session, `cycle ${i}: the terrain dialog to hide`, dialogHidden, 15000, null);
      await waitInPage(session, `cycle ${i}: the terrain canvas to be gone`, canvasGone, 15000, null);
    }
    const counts = await session.evaluate(nodeCounts);
    assert.equal(counts.canvases, 0, `ten cycles left ${counts.canvases} canvas nodes behind`);
    assert.ok(counts.dialogs <= 1, `ten cycles left ${counts.dialogs} dialog nodes behind (the dialog element is built once and reused)`);
    const debug = await session.evaluate(debugCounters);
    assert.deepEqual(debug, { maps: 0, listeners: 0, objectUrls: 0, inflight: 0 },
      `ten open/close cycles left live resources behind: ${JSON.stringify(debug)}`);

    // Case 6: closing the panel restores the 2D layer state exactly (brief item 4)
    // -- tick trails on, run one more open/close, and the checkbox must read the
    // same as it did before the cycle. The 3D snapshot hand-off (main.js's
    // terrainOverlaySnapshot) only ever READS state.recipe/state.states; nothing
    // in the drape/notice path writes back to it, so this should hold trivially,
    // but the brief asks for an explicit assertion rather than trusting that by
    // construction.
    await session.evaluate(tickTrails);
    const trailsBefore = await session.evaluate(trailsChecked);
    await session.evaluate(clickTerrainButton);
    await waitInPage(session, 'a canvas in the terrain dialog', canvasPresent, 30000, null);
    await session.evaluate(escapeKey);
    await waitInPage(session, 'the terrain dialog to hide', dialogHidden, 15000, null);
    const trailsAfter = await session.evaluate(trailsChecked);
    assert.equal(trailsAfter, trailsBefore, 'closing the 3D panel changed the 2D trails checkbox state');
    assert.equal(trailsAfter, true, 'the trails layer was not actually on going into the close');

    // Case 7: zero CSP violations under the page's real, generated production policy.
    const violations = await session.evaluate('window.__cspViolations');
    assert.deepEqual(violations, [], `the built page's own CSP was violated: ${JSON.stringify(violations)}`);
  } finally {
    session.close();
    await site.close();
  }
});

test('with WebGL turned off (--disable-3d-apis), the panel shows its plain-language fallback and makes no DEM request', { skip }, async () => {
  const site = await startSiteServer();
  const docUrl = `${site.origin}/quiet-corners/`;
  const session = await connectSession({ args: ['--disable-3d-apis'] });
  try {
    await session.send('Page.enable');
    await session.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const { seen } = await interceptNetwork(session, { docUrl });

    await session.navigate(docUrl);
    await readyDashboard(session, { ms: 60000 });

    const webgl = await session.evaluate(`(() => { const c = document.createElement('canvas'); return Boolean(c.getContext('webgl2') || c.getContext('webgl')); })()`);
    assert.equal(webgl, false, '--disable-3d-apis did not actually disable WebGL — the fallback branch is untested');

    await session.evaluate(clickTerrainButton);
    await waitInPage(session, 'the no-WebGL fallback paragraph', `Boolean(document.querySelector('.qc-terrain-fallback'))`, 15000, null);
    const fallbackText = await session.evaluate(`document.querySelector('.qc-terrain-fallback').textContent`);
    assert.match(fallbackText, /WebGL/, `the fallback did not name WebGL as the reason: "${fallbackText}"`);
    assert.equal(seen.filter((r) => isDemUrl(r.url)).length, 0,
      'a DEM request happened with WebGL unavailable, where the panel must never even try to load');
  } finally {
    session.close();
    await site.close();
  }
});

// E2 proof: names on relief, end to end against the built page, using the same
// synthetic GNIS fixture names-keyboard.test.mjs already established rather than
// a new network mock -- no other vector layer in this repo has a browser-level
// fetch fixture yet. (That gap is closed: terrain-relief-browser.test.mjs serves a
// steep hill-and-gorge terrain-RGB DEM plus trail and MVUM road fixtures through
// request stubbing, and proves the drape, casing and trail names from canvas pixels
// and queryRenderedFeatures. This file keeps the 1x1 flat tile for lifecycle tests.)
const namesGnisPatch = `(() => {
  const real = window.fetch.bind(window);
  window.fetch = function(input, init) {
    const url = String(input && input.url ? input.url : input);
    // The NHD river tier is answered empty: these proofs are hermetic and about the GNIS names.
    if (/nhd\\/MapServer\\/\\d+\\/query/.test(url)) return Promise.resolve(new Response(JSON.stringify({ features: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const m = url.match(/geonames\\/MapServer\\/(\\d+)\\/query/);
    if (m) {
      const layer = m[1];
      const isCount = /returnCountOnly=true/.test(url);
      const features = layer === '3' ? ${JSON.stringify(PLACE_FEATURES)} : [];
      const body = isCount ? { count: features.length } : { features };
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    }
    return real(input, init);
  };
})()`;

test('the 3D terrain panel: names on relief are drawn, occlusion-aware, and disclosed in the capability notices', { skip }, async () => {
  const site = await startSiteServer();
  const docUrl = `${site.origin}/quiet-corners/`;
  const session = await connectSession();
  try {
    await session.send('Page.enable');
    await session.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: namesGnisPatch });
    await interceptNetwork(session, { docUrl });

    await session.navigate(docUrl);
    await readyDashboard(session, { ms: 60000 });
    await chooseExampleArea(session);
    await session.evaluate(`(() => {
      const cb = document.getElementById('qcm-layer-names');
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await session.evaluate("document.getElementById('qcm-check').click()");
    await waitInPage(session, 'the names layer to read ready', `document.getElementById('qcm-layer-names-report')?.dataset?.state === 'ready'`, 30000, null);

    // Open the 3D panel: the snapshot hand-off (main.js's terrainOverlaySnapshot)
    // must carry the now-ready names features into the panel's own DOM layer.
    await session.evaluate(clickTerrainButton);
    await waitInPage(session, 'a canvas in the terrain dialog', canvasPresent, 30000, null);
    await waitInPage(session, 'the names DOM layer over the terrain canvas', namesPresent, 15000, null);
    await waitInPage(session, 'at least one placed name label over the relief',
      `(window.qcTerrainView.styleSnapshot()?.names?.length ?? 0) > 0`, 15000, null);

    const snap = await session.evaluate(styleSnapshot);
    assert.ok(Array.isArray(snap.names) && snap.names.length > 0, 'no name label was placed over the relief');

    // The capability-notice list discloses the names layer as shown (brief item 4).
    const noticeText = await session.evaluate(`Array.from(document.querySelectorAll('.qc-terrain-notice')).map((li) => li.textContent).join(' | ')`);
    assert.match(noticeText, /shown/i, `no capability notice reported the names layer as shown: "${noticeText}"`);

    await session.evaluate(escapeKey);
    await waitInPage(session, 'the terrain dialog to hide', dialogHidden, 15000, null);
  } finally {
    session.close();
    await site.close();
  }
});

test('an open 3D panel follows the 2D layers: a layer switched on or off while it is open is listed or dropped at once', { skip }, async () => {
  const site = await startSiteServer();
  const docUrl = `${site.origin}/quiet-corners/`;
  const session = await connectSession();
  const notices = `Array.from(document.querySelectorAll('.qc-terrain-notice')).map((li) => li.textContent).join(' | ')`;
  try {
    await session.send('Page.enable');
    await session.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await interceptNetwork(session, { docUrl });
    await session.navigate(docUrl);
    await readyDashboard(session, { ms: 60000 });
    await chooseExampleArea(session);
    if (await session.evaluate(trailsChecked)) await session.evaluate(tickTrails);

    await session.evaluate(clickTerrainButton);
    await waitInPage(session, 'a canvas in the terrain dialog', canvasPresent, 30000, null);
    assert.doesNotMatch(await session.evaluate(notices), /trails/i, 'trails listed in 3D while off in 2D');

    // The dialog covers the layer panel, so the switch is flipped the way a script would; the
    // panel must hear it through the same redraw a fetch triggers, not only at the next open.
    await session.evaluate(tickTrails);
    await waitInPage(session, 'the 3D list to name the trails layer just switched on', `/trails/i.test(${notices})`, 15000, null);
    await session.evaluate(tickTrails);
    await waitInPage(session, 'the 3D list to drop the trails layer just switched off', `!/trails/i.test(${notices})`, 15000, null);

    await session.evaluate(escapeKey);
    await waitInPage(session, 'the terrain dialog to hide', dialogHidden, 15000, null);
  } finally {
    session.close();
    await site.close();
  }
});

test('the 3D panel own layer switches drive the 2D layers: switching trails in 3D switches it in 2D and the 3D list follows', { skip }, async () => {
  const site = await startSiteServer();
  const docUrl = `${site.origin}/quiet-corners/`;
  const session = await connectSession();
  const notices = `Array.from(document.querySelectorAll('.qc-terrain-notice')).map((li) => li.textContent).join(' | ')`;
  const trails3d = `document.querySelector('.qc-terrain-dialog .qc-terrain-layers input[data-layer-id="trails"]')`;
  try {
    await session.send('Page.enable');
    await session.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await interceptNetwork(session, { docUrl });
    await session.navigate(docUrl);
    await readyDashboard(session, { ms: 60000 });
    await chooseExampleArea(session);
    if (await session.evaluate(trailsChecked)) await session.evaluate(tickTrails);

    await session.evaluate(clickTerrainButton);
    await waitInPage(session, 'a canvas in the terrain dialog', canvasPresent, 30000, null);
    // Closed, the switches cost the relief no height: the controls bar stays one row.
    const barHeight = `document.querySelector('.qc-terrain-dialog .qc-terrain-controls').getBoundingClientRect().height`;
    assert.ok(await session.evaluate(barHeight) < 100, `the controls bar grew to ${await session.evaluate(barHeight)}px with Layers closed`);
    const layersOpen = `document.querySelector('.qc-terrain-dialog .qc-terrain-layers').open`;
    await trustedClick(session, '.qc-terrain-dialog .qc-terrain-layers > summary', { until: layersOpen });
    await waitInPage(session, 'a trails switch inside the 3D dialog, unticked as 2D has it', `Boolean(${trails3d}) && ${trails3d}.checked === false && ${trails3d}.getBoundingClientRect().width > 0`, 15000, null);

    // A real mouse press on the switch the dialog itself offers -- the 2D panel stays covered.
    await trustedClick(session, '.qc-terrain-dialog .qc-terrain-layers input[data-layer-id="trails"]');
    await waitInPage(session, 'the 2D trails checkbox to follow the 3D switch on', trailsChecked, 15000, null);
    await waitInPage(session, 'the 3D list to name trails', `/trails/i.test(${notices})`, 15000, null);
    assert.equal(await session.evaluate(`document.activeElement === ${trails3d}`), true, 'the switch lost focus when the list redrew');
    // And the keyboard: Space on the focused switch turns it back off.
    for (const type of ['keyDown', 'keyUp']) {
      await session.send('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: type === 'keyDown' ? ' ' : undefined });
    }
    await waitInPage(session, 'the 2D trails checkbox to follow the 3D switch off', `!${trailsChecked}`, 15000, null);
    await waitInPage(session, 'the 3D list to drop trails', `!/trails/i.test(${notices})`, 15000, null);

    await session.evaluate(escapeKey);
    await waitInPage(session, 'the terrain dialog to hide', dialogHidden, 15000, null);
  } finally {
    session.close();
    await site.close();
  }
});
