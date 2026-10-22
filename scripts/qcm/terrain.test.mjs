// The shaded-relief companion sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { terrainRequestFor, fetchTerrain, RASTER_FUNCTION, TERRAIN_SCALE, TERRAIN_SOURCE }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/source-terrain.js';
import { aerialRequestFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-aerial.js';
import { LAYER_BY_ID } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';

const PDF = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/pdf.js', import.meta.url), 'utf8');
const SHEET = { id: 'A1', pixel: { width: 2400, height: 2850 } };
const BBOX = { minLon: -83.55, minLat: 35.0, maxLon: -83.4, maxLat: 35.1 };

test('the request names the raster function as a string, not a chain', () => {
  const req = terrainRequestFor(SHEET, BBOX);
  assert.deepEqual(JSON.parse(req.params.renderingRule), { rasterFunction: RASTER_FUNCTION });
  assert.equal(RASTER_FUNCTION, 'Hillshade Gray');
  // The old failure was a hand-built Remap/Colormap chain, never the service.
  assert.ok(!req.params.renderingRule.includes('rasterFunctionArguments'),
    'a named function needs no arguments, and building one is what failed before');
});

test('a relief sheet covers exactly the sheet extent, at half linear resolution', () => {
  const req = terrainRequestFor(SHEET, BBOX);
  assert.equal(req.params.bbox, '-83.55,35,-83.4,35.1');
  assert.equal(req.params.bboxSR, '4326');
  assert.equal(req.width, SHEET.pixel.width * TERRAIN_SCALE);
  assert.equal(req.height, SHEET.pixel.height * TERRAIN_SCALE);
  // Same geometry as the aerial companion, because the pair is laid side by side.
  const aer = aerialRequestFor(SHEET, BBOX);
  assert.equal(req.params.bbox, aer.params.bbox);
  assert.equal(req.width, aer.width);
});

// A hillshade is a smooth grey ramp. JPEG ringing on a ridge reads as a terrace
// that is not there, and embedJpg on PNG bytes throws.
test('relief is PNG and says so, and the pdf embeds by the declared format', () => {
  assert.equal(terrainRequestFor(SHEET, BBOX).params.format, 'png');
  assert.match(PDF, /a\.format === 'png' \? await doc\.embedPng/,
    'the companion loop must embed by declared format, not assume JPEG');
});

test('a failing service costs the companion page, never the map', async () => {
  await assert.rejects(
    fetchTerrain({ sheet: SHEET, bboxLonLat: BBOX, fetchImpl: async () => ({ ok: false, status: 502 }) }),
    /Shaded relief: the service answered 502/);
  // An empty body is a failure too: a zero-byte image embeds as a blank page.
  await assert.rejects(
    fetchTerrain({ sheet: SHEET, bboxLonLat: BBOX, fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }) }),
    /returned an empty image/);
});

test('a good answer carries the sheet id, the bytes and the format', async () => {
  const r = await fetchTerrain({
    sheet: SHEET, bboxLonLat: BBOX,
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer }),
  });
  assert.equal(r.id, 'A1');
  assert.equal(r.format, 'png');
  assert.equal(r.bytes.length, 4);
});

test('the layer is an extra page, off by default, and says what relief is not', () => {
  const l = LAYER_BY_ID.terrain;
  assert.ok(l, 'no terrain entry in the registry');
  assert.equal(l.extraPage, true);
  assert.equal(l.defaultOn, false);
  assert.equal(l.group, 'extras');
  assert.match(TERRAIN_SOURCE.coverageSemantics, /not what is on it/);
});
