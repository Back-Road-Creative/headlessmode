// Tests for the pure render protocol behind the print-renderer worker, plus
// source-text assertions on the worker itself (it is never executed in Node).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planSheets } from '../../themes/headlessmode/static/js/quiet-corners-maps/sheet-plan.js';
import { DASH_IN } from '../../themes/headlessmode/static/js/quiet-corners-maps/legend.js';
import { TYPES, PHASES, PATTERNS, progressText, estimate, validateRenderRequest, validateMessage,
  makeProgress, makeDone, makeError, transferablesOf } from '../../themes/headlessmode/static/js/quiet-corners-maps/render-protocol.js';

const recipe = (w, h) => ({ paper: 'letter', orientation: 'portrait', scale: 24000, overlapIn: 0.5, dpi: 300,
  extent: { minX: 0, minY: 0, maxX: w, maxY: h }, zone: 16, hemisphere: 'N', title: 'T' });
const op = (key = 't1') => ({ key, sx: 0, sy: 0, sw: 256, sh: 256, transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } });
const good = () => ({ type: 'render', sheetId: 'A1', width: 2400, height: 2850, background: '#ffffff',
  tiles: [{ key: 't1', bitmap: {} }], ops: [op()], jpegQuality: 0.85 });

test('progressText is deterministic per phase and rejects unknown phases', () => {
  assert.equal(progressText(PHASES.FETCH, 18, 42), 'Fetching 18/42');
  assert.equal(progressText(PHASES.RENDER, 'C2'), 'Rendering C2');
  assert.equal(progressText(PHASES.ASSEMBLE, 8, 12), 'Assembling 8/12');
  assert.throws(() => progressText('encode', 1, 2), RangeError);
  assert.deepEqual(makeProgress(PHASES.FETCH, 1, 2), { type: TYPES.PROGRESS, phase: 'fetch', text: 'Fetching 1/2', a: 1, b: 2 });
});

test('estimate: 6-sheet Letter/300 dpi plan is safe and ok', () => {
  const plan = planSheets(recipe(13700, 11100));
  const e = estimate({ plan, dpi: 300, uniqueTiles: 1000 });
  assert.deepEqual([plan.count, e.pageMegapixels], [6, 2400 * 2850 / 1e6]);
  assert.equal(e.peakBytes, 2400 * 2850 * 4 + e.pageMegapixels * 180000 + 1000 * 20000);
  assert.equal(e.pdfBytesEstimate, 6 * e.pageMegapixels * 180000 + 200000);
  assert.equal(e.downloadBytesEstimate, 20000000);
  assert.deepEqual([e.safe, e.recommendation], [true, 'ok']);
});

test('estimate: 24 sheets at 300 dpi with 5,000 tiles stays safe; a 6000 px page does not', () => {
  const plan = planSheets(recipe(5 * 4572 + 4876.8, 3 * 5486.4 + 5791.2));
  assert.equal(plan.count, 24);
  const e = estimate({ plan, dpi: 300, uniqueTiles: 5000 });
  assert.deepEqual([e.safe, e.recommendation], [true, 'ok']);
  assert.ok(e.peakBytes < 1.2e9, `peak ${e.peakBytes}`);
  const huge = (inches) => ({ frame: { widthIn: inches, heightIn: inches }, sheets: [{}] });
  assert.equal(estimate({ plan: huge(20), dpi: 300, uniqueTiles: 100 }).recommendation, 'use-200-dpi');
  assert.equal(estimate({ plan: huge(30), dpi: 200, uniqueTiles: 100 }).recommendation, 'reduce-area');
  assert.equal(estimate({ plan, dpi: 300, uniqueTiles: 70000 }).safe, false);
});

test('validateRenderRequest accepts a good message and names the bad field', () => {
  assert.equal(validateRenderRequest(good()).sheetId, 'A1');
  const bad = (patch, Err, field) => assert.throws(() => validateRenderRequest({ ...good(), ...patch }),
    (err) => err instanceof Err && err.message.includes(field));
  bad({ sheetId: undefined }, TypeError, 'sheetId');
  bad({ width: 0 }, RangeError, 'width'); bad({ width: 7000 }, RangeError, 'width');
  bad({ jpegQuality: 0 }, RangeError, 'jpegQuality'); bad({ jpegQuality: 1.5 }, RangeError, 'jpegQuality');
  bad({ ops: [op('nope')] }, RangeError, 'ops[0].key'); bad({ ops: 'x' }, TypeError, 'ops');
  assert.equal(validateMessage({ type: 'cancel' }).type, TYPES.CANCEL);
  assert.throws(() => validateMessage({ type: 'reboot' }), TypeError);
});

test('makeDone/makeError/transferablesOf', () => {
  const bytes = new ArrayBuffer(8);
  const done = makeDone('A1', bytes, { width: 1, height: 1, drewOps: 0, ms: 2 });
  assert.deepEqual([done.type, transferablesOf(done), transferablesOf({ type: 'progress' })], [TYPES.DONE, [bytes], []]);
  assert.deepEqual(makeError('A1', new Error('boom')), { type: TYPES.ERROR, sheetId: 'A1', message: 'boom' });
  assert.equal(makeError('A1', 'plain').message, 'plain');
});

test('worker source: module import, offscreen rendering, no network, no DOM', () => {
  const src = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/print-renderer.worker.js', import.meta.url), 'utf8');
  for (const s of ["from './render-protocol.js'", 'OffscreenCanvas', 'convertToBlob', 'setTransform', 'self.close()',
    'TYPES.RENDER', 'TYPES.CANCEL', 'TYPES.READY']) assert.ok(src.includes(s), `missing ${s}`);
  for (const s of ['fetch(', 'importScripts(', 'document.', 'https://', 'XMLHttpRequest']) assert.ok(!src.includes(s), `contains ${s}`);
});

test('validateRenderRequest: vectors and dpi', () => {
  const vec = (patch = {}) => ({ key: 'mvum-road-seasonal', path: [[0, 0], [100, 50]], pattern: 'dash', widthPx: 5, color: '#b3261e', ...patch });
  assert.equal(validateRenderRequest({ ...good(), vectors: [vec(), vec({ key: 'mvum-trail-yearlong', pattern: 'solid' })] }).vectors.length, 2);
  // Derived from legend.js's table, so assert the DERIVATION rather than a copy of
  // it: a literal set here fails every time a symbol legitimately adds a pattern,
  // which is exactly backwards for a table whose whole point is to be extended.
  assert.deepEqual(Object.keys(PATTERNS).sort(), Object.keys(DASH_IN).sort());
  assert.deepEqual(PATTERNS.dash, [12, 6]);
  const bad = (patch, Err, field) => assert.throws(() => validateRenderRequest({ ...good(), vectors: [vec(patch)] }),
    (err) => err instanceof Err && err.message.includes(field));
  bad({ pattern: 'wavy' }, RangeError, 'pattern'); bad({ path: [[1, 2]] }, RangeError, 'path');
  bad({ widthPx: 25 }, RangeError, 'widthPx'); bad({ color: 'red' }, RangeError, 'color'); bad({ key: 'bogus' }, RangeError, 'key');
  assert.throws(() => validateRenderRequest({ ...good(), dpi: 0 }), (e) => e instanceof RangeError && e.message.includes('dpi'));
  assert.throws(() => validateRenderRequest({ ...good(), vectors: 'x' }), (e) => e instanceof TypeError && e.message.includes('vectors'));
  const src = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/print-renderer.worker.js', import.meta.url), 'utf8');
  // 'PATTERNS' is deliberately NOT in this list: a string-presence check on it passed
  // while the identifier was unbound. print-renderer.worker.test.mjs executes that path.
  for (const s of ['setLineDash', 'strokeStyle', 'drewVectors']) assert.ok(src.includes(s), `missing ${s}`);
  for (const s of ['fetch(', 'importScripts(', 'document.', 'https://', 'XMLHttpRequest']) assert.ok(!src.includes(s), `contains ${s}`);
});
