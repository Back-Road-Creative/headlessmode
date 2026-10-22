// Aerial companion sheets: an extra page, never an overlay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aerialRequestFor, fetchAerial, AERIAL_SCALE, AERIAL_SOURCE }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/source-aerial.js';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';

const sheet = { id: 'A1', pixel: { width: 2400, height: 2850 } };
const bbox = { minLon: -83.55, minLat: 35.02, maxLon: -83.45, maxLat: 35.10 };

test('the aerial sheet covers exactly the extent of the map sheet it pairs with', () => {
  const r = aerialRequestFor(sheet, bbox);
  // Same bbox, or the two pages cannot be laid side by side and read as one.
  assert.equal(r.params.bbox, '-83.55,35.02,-83.45,35.1');
  assert.equal(r.params.bboxSR, '4326');
  assert.equal(r.params.imageSR, '4326');
});

test('it is fetched at half linear resolution, and never above the service ceiling', () => {
  const r = aerialRequestFor(sheet, bbox);
  assert.equal(r.width, Math.round(2400 * AERIAL_SCALE));
  assert.equal(r.height, Math.round(2850 * AERIAL_SCALE));
  // Aerial detail is worth less per pixel than contour detail; a quarter of the
  // pixels is a visibly softer image for a fraction of the download.
  assert.ok(AERIAL_SCALE < 1);
  const huge = aerialRequestFor({ id: 'X', pixel: { width: 20000, height: 20000 } }, bbox);
  assert.ok(huge.width <= 4000 && huge.height <= 4000, 'the service refuses a side over 4000');
  assert.equal(r.params.size, `${r.width},${r.height}`);
});

test('an empty image is an error, not a blank page', async () => {
  await assert.rejects(fetchAerial({ sheet, bboxLonLat: bbox,
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }) }), /empty image/);
  await assert.rejects(fetchAerial({ sheet, bboxLonLat: bbox,
    fetchImpl: async () => ({ ok: false, status: 504 }) }), /answered 504/);
});

test('a successful fetch carries the sheet id, so a page can be paired to its map', async () => {
  const a = await fetchAerial({ sheet, bboxLonLat: bbox,
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([255, 216, 255]).buffer }) });
  assert.equal(a.id, 'A1');
  assert.equal(a.bytes.length, 3);
  assert.equal(a.width, 1200);
});

test('the source says what the imagery does and does not tell you', () => {
  assert.equal(AERIAL_SOURCE.origin, 'https://imagery.nationalmap.gov');
  assert.match(AERIAL_SOURCE.coverageSemantics, /ground cover, not legal access/);
  // The registry records WHY this source was trusted where 3DEP's exportImage was
  // not: it returned distinct imagery per extent, and 3DEP returned one constant
  // image for two different states.
  assert.match(SOURCES.usdaNaip.coverageSemantics, /distinct imagery per extent/);
  assert.equal(SOURCES.usdaNaip.origin, AERIAL_SOURCE.origin, 'the module and the registry must name one host');
});
