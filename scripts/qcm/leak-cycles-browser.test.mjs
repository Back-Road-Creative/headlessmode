// QQA-13c: nothing grows across repeated use, measured in a real browser.
//
// terrain-panel.test.mjs counts the 3D module's OWN counters after ten cycles; this file asks
// the browser. After one open/close cycle (everything lazily built is built) and again after
// twenty more, a forced garbage collection (HeapProfiler.collectGarbage) is followed by
// Performance.getMetrics, and three numbers must be EQUAL: JSEventListeners, Nodes, and the
// terrain panel's map count. Equal, not "within a margin": a cycle that leaves one listener or
// one node behind is a leak, and twenty cycles make it twenty.
//
// Heap size is bounded, not equal, and that bound lives in leak-heap-browser.test.mjs: it needs
// its own 21 + 20 cycles, and CI caps each FILE at 600 s (pr-ci.yml), so it has a file of its own.
// scripts/qcm/README.md, "Leak cycles", has the measured numbers.
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
import { settlePaused } from './helpers/paused-request.mjs';
import { waitInPage } from './helpers/waits.mjs';
import { greyBasePng } from './fixtures/relief-3d.mjs';
import {
  skip, SLOW, png, freshPage, cycle, readOnce,
  pressTwice, escapeKey, canvasPresent, canvasGone, dialogHidden, containers, mapCount,
} from './helpers/leak-page.mjs';

const MORE_CYCLES = 20;

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
