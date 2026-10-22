// Executes the print-renderer worker under Node, with the browser globals it
// expects stubbed out. It exists because the worker was previously covered only
// by source-text assertions ("does the file contain the string 'PATTERNS'"),
// which pass just as happily on a file whose PATTERNS identifier is unbound —
// and that is exactly what shipped: `PATTERNS` was used at the vector-stroke
// line but never imported, so every build with an MVUM route in it threw
// `ReferenceError: PATTERNS is not defined` and failed the whole sheet set.
// A string check cannot catch an unbound identifier. Running the code can.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const WORKER = '../../themes/headlessmode/static/js/quiet-corners-maps/print-renderer.worker.js';

/** Minimal OffscreenCanvas/2d-context stub: records nothing, refuses nothing. */
function stubCanvas() {
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', lineJoin: '',
    fillRect() {}, setTransform() {}, drawImage() {}, beginPath() {},
    moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {},
  };
  return class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return ctx; }
    async convertToBlob() { return { arrayBuffer: async () => new ArrayBuffer(16) }; }
  };
}

/** Loads the worker with browser globals stubbed, returning a post/collect pair. */
async function loadWorker() {
  const posted = [];
  globalThis.self = globalThis;
  globalThis.postMessage = (msg) => posted.push(msg);
  globalThis.OffscreenCanvas = stubCanvas();
  await import(WORKER);
  return { posted, send: (msg) => globalThis.self.onmessage({ data: msg }) };
}

const request = (vectors) => ({
  type: 'render', sheetId: 'A1', width: 240, height: 285, background: '#ffffff', dpi: 300,
  tiles: [{ key: 't1', bitmap: {} }],
  ops: [{ key: 't1', sx: 0, sy: 0, sw: 256, sh: 256, transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } }],
  vectors,
});

test('the worker draws a dashed vector without throwing', async () => {
  const { posted, send } = await loadWorker();
  assert.deepEqual(posted[0], { type: 'ready' }, 'the worker announces itself on load');

  send(request([{
    key: 'mvum-road-seasonal', pattern: 'dash', widthPx: 5, color: '#b3261e',
    path: [[0, 0], [100, 100]],
  }]));
  // The worker serialises renders through a promise chain; let it drain.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  const error = posted.find((m) => m.type === 'error');
  assert.equal(error, undefined, `the worker reported: ${error && error.message}`);
  const done = posted.find((m) => m.type === 'done');
  assert.ok(done, 'the worker should finish the sheet');
  assert.equal(done.stats.drewVectors, 1, 'the vector should have been stroked once');
  assert.equal(done.stats.drewOps, 1, 'the tile should have been drawn once');
});
