// QQA-13c: nothing grows across repeated use, measured in a real browser.
//
// terrain-panel.test.mjs counts the 3D module's OWN counters after ten cycles; this file asks
// the browser. After one open/close cycle (everything lazily built is built) and again after
// twenty more, a forced garbage collection (HeapProfiler.collectGarbage) is followed by
// Performance.getMetrics, and three numbers must be EQUAL: JSEventListeners, Nodes, and the
// terrain panel's map count. Equal, not "within a margin": a cycle that leaves one listener or
// one node behind is a leak, and twenty cycles make it twenty.
//
// No heap-size assertion. No noise floor for JSHeapUsedSize has been measured on this box, so
// any limit would be a guess; the heap numbers are printed as diagnostics for whoever records
// that floor (scripts/qcm/README.md, "Leak cycles").
//
// The other leak shapes are exact too: the document holds no more `keydown` listeners after a
// close than before the first open (DOMDebugger.getEventListeners), a second press while the
// MapLibre import is still in flight builds no second map, a close during that import builds
// none at all, a second calibration or key-sheet download revokes the first blob URL, and a
// hillshade picture that lands after its layer was switched off makes no blob URL and no layer.
//
// Same network as terrain-panel.test.mjs: a DEM or topo request is answered with a synthetic
// tile and anything outside the local site is refused, so nothing leaves this box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium } from './helpers/browser.mjs';
import { connectSession } from './helpers/cdp-session.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage } from './helpers/waits.mjs';
import { settlePaused } from './helpers/paused-request.mjs';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { terrariumTilePng, greyBasePng } from './fixtures/relief-3d.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built — run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

// Software WebGL on a busy box renders slowly; page-side waits get this long.
const SLOW = 170000;
const MORE_CYCLES = 20;
const CORS = { name: 'access-control-allow-origin', value: '*' };
const png = (buf) => ({ headers: [{ name: 'content-type', value: 'image/png' }, CORS], body: buf.toString('base64') });

async function stubNetwork(session, { docUrl, siteOrigin, held = null }) {
  session.on('Fetch.requestPaused', async (p) => {
    const { requestId, request, responseStatusCode, responseHeaders } = p;
    if (responseStatusCode !== undefined) {
      const headers = (responseHeaders || []).filter((h) => h.name.toLowerCase() !== 'content-security-policy');
      await settlePaused(session.send, 'Fetch.continueResponse', { requestId, responseCode: responseStatusCode, responseHeaders: headers });
      return;
    }
    const url = request.url;
    let answer = null;
    if (url.startsWith(SOURCES.terrainDem.origin)) {
      const m = /\/(\d+)\/(\d+)\/(\d+)\.png/.exec(url);
      if (m) answer = png(terrariumTilePng(Number(m[1]), Number(m[2]), Number(m[3])));
    } else if (url.startsWith(SOURCES.usgsTopo.origin)) answer = png(greyBasePng());
    else if (held && url.startsWith(SOURCES.usgs3depHillshade.origin)) { held.push(requestId); return; }
    if (answer) {
      await settlePaused(session.send, 'Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: answer.headers, body: answer.body });
    } else if (url.startsWith(siteOrigin) || url.startsWith('data:') || url.startsWith('blob:')) {
      await settlePaused(session.send, 'Fetch.continueRequest', { requestId });
    } else {
      await settlePaused(session.send, 'Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    }
  });
  await session.send('Fetch.enable', {
    patterns: [{ urlPattern: '*', requestStage: 'Request' }, { urlPattern: docUrl, requestStage: 'Response' }],
  });
}

const press3d = `document.querySelector('.qc-terrain-open').click(); void 0;`;
const pressTwice = `(() => { const b = document.querySelector('.qc-terrain-open'); b.click(); b.click(); })()`;
const escapeKey = `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); void 0;`;
const pressClose = `document.querySelector('.qc-terrain-controls .qc-terrain-close').click(); void 0;`;
const canvasPresent = `Boolean(document.querySelector('.qc-terrain-dialog canvas'))`;
const canvasGone = `!document.querySelector('.qc-terrain-dialog canvas')`;
const dialogHidden = `(() => { const d = document.querySelector('.qc-terrain-dialog'); return !d || d.hidden; })()`;
const containers = `document.querySelectorAll('.qc-terrain-canvas').length`;
const mapCount = `window.qcTerrainView.debug().maps`;

async function freshPage(t, { held = null } = {}) {
  const site = await startSiteServer();
  const docUrl = `${site.origin}/quiet-corners/`;
  const session = await connectSession();
  t.after(async () => { session.close(); await site.close(); });
  await session.send('Page.enable');
  await session.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await stubNetwork(session, { docUrl, siteOrigin: site.origin, held });
  await session.navigate(docUrl);
  await readyDashboard(session, { ms: 60000 });
  return session;
}

/** One 3D open and close, by Escape or by the panel's own Close button. */
async function cycle(session, i) {
  await session.evaluate(press3d);
  await waitInPage(session, `cycle ${i}: a canvas in the terrain dialog`, canvasPresent, SLOW, null);
  await session.evaluate(i % 2 ? pressClose : escapeKey);
  await waitInPage(session, `cycle ${i}: the terrain dialog to hide`, dialogHidden, 15000, null);
  await waitInPage(session, `cycle ${i}: the terrain canvas to be gone`, canvasGone, 15000, null);
}

/** One forced collection, then the browser's own counters. */
async function readOnce(session) {
  await session.send('HeapProfiler.collectGarbage');
  const { metrics } = await session.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

/** Collect garbage until the counters stop moving, then read the three numbers that must not
 *  differ (and the heap, for the record). One collection is not always enough: a listener on an
 *  object the first pass only just freed shows up as +-1 on the next read, so a read counts once
 *  two collections in a row agree. A real leak never settles back down, so this hides none. */
async function measure(session) {
  let now = await readOnce(session);
  for (let tries = 0; tries < 10; tries++) {
    const next = await readOnce(session);
    const settled = next.JSEventListeners === now.JSEventListeners && next.Nodes === now.Nodes;
    now = next;
    if (settled) break;
  }
  return {
    JSEventListeners: now.JSEventListeners,
    Nodes: now.Nodes,
    maps: await session.evaluate(mapCount),
    JSHeapUsedSize: now.JSHeapUsedSize,
  };
}

/** How many `keydown` listeners the document itself holds, read by the browser, not the page. */
async function documentKeydownListeners(session) {
  const { result } = await session.send('Runtime.evaluate', { expression: 'document' });
  const { listeners } = await session.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
  return listeners.filter((l) => l.type === 'keydown').length;
}

test(`${MORE_CYCLES} more 3D open/close cycles leave listeners, nodes and terrain maps exactly where one cycle left them`, { skip }, async (t) => {
  const session = await freshPage(t);
  await session.send('Performance.enable');
  const keydownBefore = await documentKeydownListeners(session);

  await cycle(session, 0);
  assert.equal(await documentKeydownListeners(session), keydownBefore,
    'closing the panel left its Escape listener on the document');
  const afterOne = await measure(session);
  assert.equal(afterOne.maps, 0, 'a closed panel still counts a terrain map');

  for (let i = 1; i <= MORE_CYCLES; i++) await cycle(session, i);
  const afterMany = await measure(session);

  t.diagnostic(`after 1 cycle: ${JSON.stringify(afterOne)}`);
  t.diagnostic(`after ${MORE_CYCLES + 1} cycles: ${JSON.stringify(afterMany)}`);
  for (const name of ['JSEventListeners', 'Nodes', 'maps']) {
    assert.equal(afterMany[name], afterOne[name], `${name} grew across ${MORE_CYCLES} cycles: ${afterOne[name]} -> ${afterMany[name]}`);
  }
  assert.equal(await documentKeydownListeners(session), keydownBefore, 'the cycles left keydown listeners on the document');
});

test('a second press while the MapLibre import is in flight builds no second map', { skip }, async (t) => {
  const session = await freshPage(t);
  await session.evaluate(pressTwice);
  await waitInPage(session, 'a canvas in the terrain dialog', canvasPresent, SLOW, null);
  assert.equal(await session.evaluate(containers), 1, 'two presses built two map containers');
  assert.equal(await session.evaluate(mapCount), 1, 'two presses built two maps');
  await session.evaluate(escapeKey);
  await waitInPage(session, 'the terrain dialog to hide', dialogHidden, 15000, null);
  assert.equal(await session.evaluate(mapCount), 0, 'closing left a map behind');
  await waitInPage(session, 'the terrain canvas to be gone', canvasGone, 15000, null);
});

test('closing during the import builds nothing for the closed press', { skip }, async (t) => {
  const session = await freshPage(t);
  // Press, close before the import settles, press again. The imports settle in order, so by
  // the time the second press has its canvas the first press's continuation has already run.
  await session.evaluate(`document.querySelector('.qc-terrain-open').click(); window.qcTerrainView.closePanel(); document.querySelector('.qc-terrain-open').click(); void 0;`);
  await waitInPage(session, 'a canvas in the terrain dialog', canvasPresent, SLOW, null);
  assert.equal(await session.evaluate(containers), 1, 'the closed press still built its map');
  assert.equal(await session.evaluate(mapCount), 1);
});

test('a second calibration or key-sheet download revokes the first blob URL', { skip }, async (t) => {
  const session = await freshPage(t);
  await session.evaluate(`(() => { window.__revoked = []; const real = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (u) => { window.__revoked.push(u); real(u); }; })()`);
  for (const [button, anchor] of [['qcm-calibrate', 'qcm-calibration-download'], ['qcm-key-sheet', 'qcm-key-sheet-download']]) {
    const href = `document.getElementById('${anchor}').href`;
    await session.evaluate(`document.getElementById('${button}').click(); void 0;`);
    await waitInPage(session, `${anchor} to carry a blob url`, `${href}.startsWith('blob:')`, 30000, null);
    const first = await session.evaluate(href);
    assert.equal(await session.evaluate(`window.__revoked.includes(${JSON.stringify(first)})`), false, `${anchor}: the first url was revoked before a second exists`);
    await session.evaluate(`document.getElementById('${button}').click(); void 0;`);
    await waitInPage(session, `${anchor} to carry a second url`, `${href} !== ${JSON.stringify(first)}`, 30000, null);
    assert.equal(await session.evaluate(`window.__revoked.filter((u) => u === ${JSON.stringify(first)}).length`), 1,
      `${anchor}: the first url was not revoked exactly once`);
  }
});

test('a hillshade picture that lands after the layer was switched off makes no blob url and no layer', { skip }, async (t) => {
  const held = [];
  const session = await freshPage(t, { held });
  await session.evaluate(`(() => { window.__made = 0; window.__blobRead = false;
    const make = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b) => { window.__made++; return make(b); };
    const read = Response.prototype.blob;
    Response.prototype.blob = function blob() { return read.call(this).then((b) => { window.__blobRead = true; return b; }); }; })()`);
  const pick = (id) => `(() => { const r = document.getElementById('qcm-context-${id}'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); })()`;
  await session.evaluate(pick('hillshadeLight'));
  const start = Date.now();
  while (held.length === 0 && Date.now() - start < 30000) await new Promise((r) => setTimeout(r, 100));
  assert.ok(held.length >= 1, 'the hillshade request never left the page');
  await session.evaluate(pick('none'));
  // Answer every held request now that the layer is off.
  for (const requestId of held.splice(0)) {
    await settlePaused(session.send, 'Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: png(greyBasePng()).headers, body: png(greyBasePng()).body });
  }
  await waitInPage(session, 'the late hillshade answer to be read', 'window.__blobRead', 30000, null);
  // A round trip after the read lets the continuation of the awaiting refresh run.
  await session.evaluate('new Promise((r) => setTimeout(r, 300))');
  assert.equal(await session.evaluate('window.__made'), 0, 'a blob url was made for a layer that is off');
  assert.equal(await session.evaluate(`document.querySelectorAll('img.leaflet-image-layer').length`), 0, 'the off layer was put back on the map');
  assert.equal(await session.evaluate(`document.getElementById('qcm-layer-hillshadeLight-report').hidden`), true, 'the off layer wrote its report row again');
});
