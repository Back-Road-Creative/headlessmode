// Raster placement contract (page px ↔ Web Mercator world px). Run: node --test "scripts/qcm/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectBbox } from '../../themes/headlessmode/static/js/quiet-corners-maps/geometry.js';
import { planSheets } from '../../themes/headlessmode/static/js/quiet-corners-maps/sheet-plan.js';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import * as rp from '../../themes/headlessmode/static/js/quiet-corners-maps/raster-placement.js';

const meta = JSON.parse(readFileSync(new URL('fixtures/usgs-topo-mapserver.min.json', import.meta.url), 'utf8'));
const utm = { zone: 17, hemisphere: 'N' };
const plan = planSheets({
  paper: 'letter', orientation: 'portrait', scale: 24000, overlapIn: 0.5, dpi: 300, title: 'Standing Indian',
  extent: projectBbox({ minLon: -83.55, minLat: 35.0, maxLon: -83.4, maxLat: 35.1 }, 17, 'N'), ...utm,
});
const A1 = plan.sheets[0];
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
// Tiles whose world-pixel squares cover the lattice's Mercator bbox (the adapter unit does this from lon/lat).
const tilesCovering = (pts, z) => {
  const xs = pts.map((p) => Math.floor(p.mercPx.x / 256)), ys = pts.map((p) => Math.floor(p.mercPx.y / 256)), tiles = [];
  for (let y = Math.min(...ys); y <= Math.max(...ys); y++) for (let x = Math.min(...xs); x <= Math.max(...xs); x++) tiles.push({ key: `${z}/${x}/${y}`, z, x, y });
  return tiles;
};

test('tile scheme matches the service metadata fixture: 256 px, world origin −πR, lod resolutions', () => {
  assert.equal(plan.count, 9); // 3×3: convergence −1.42° rotates the bbox, so its UTM extent is 13.96 × 11.43 km
  assert.deepEqual([meta.tileInfo.rows, meta.tileInfo.cols], [rp.TILE_SIZE, rp.TILE_SIZE]);
  assert.equal(meta.tileInfo.spatialReference.latestWkid, SOURCES.usgsTopo.spatialReference.latestWkid);
  near(meta.tileInfo.origin.x, -Math.PI * rp.EARTH_RADIUS, 1e-3, 'origin x');
  for (const lod of meta.tileInfo.lods) near((2 * Math.PI * rp.EARTH_RADIUS) / (rp.TILE_SIZE * 2 ** lod.level), lod.resolution, 1e-6, `lod ${lod.level}`);
});

test('mercatorPixel: world origin top-left, y down; lon 0 / lat 0 is the world centre', () => {
  const n = 256 * 2 ** 16;
  assert.deepEqual(rp.mercatorPixel(0, 0, 16), { x: n / 2, y: n / 2 });
  assert.ok(rp.mercatorPixel(-83.5, 35, 16).y < n / 2, 'north of the equator is up (smaller y)');
});

test('controlPoints: 25 lattice points, corners at the frame corners, y down', () => {
  const pts = rp.controlPoints(A1, { ...utm, level: 16 });
  assert.equal(pts.length, 25);
  const { width: w, height: h } = A1.pixel;
  assert.deepEqual([pts[0].pagePx, pts[4].pagePx, pts[20].pagePx, pts[24].pagePx],
    [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: 0, y: h }, { x: w, y: h }]);
  assert.ok(pts[0].mercPx.y < pts[20].mercPx.y && pts[0].mercPx.x < pts[4].mercPx.x, 'same handedness as the page');
});

test('fitAffine recovers an exact affine map with zero residual', () => {
  const truth = { a: 0.8, b: 0.1, c: -0.05, d: 0.9, e: -3.5e6, f: 1.2e6 };
  const pts = [[4.4e6, 6.6e6], [4.4e6 + 2500, 6.6e6], [4.4e6, 6.6e6 + 3000], [4.4e6 + 2500, 6.6e6 + 3000], [4.4e6 + 900, 6.6e6 + 1100]]
    .map(([x, y]) => ({ mercPx: { x, y }, pagePx: { x: truth.a * x + truth.c * y + truth.e, y: truth.b * x + truth.d * y + truth.f } }));
  const fit = rp.fitAffine(pts);
  for (const k of 'abcd') near(fit[k], truth[k], 1e-9, k);
  near(fit.e, truth.e, 1e-6, 'e'); near(fit.f, truth.f, 1e-6, 'f');
  assert.ok(fit.residualMaxPx < 1e-9 && fit.residualRmsPx < 1e-9, `residual ${fit.residualMaxPx}`);
  assert.throws(() => rp.fitAffine(pts.slice(0, 2)), RangeError);
});

test('placementMesh: grid 4 is within 0.5 px and never worse than a single affine', () => {
  const mesh = rp.placementMesh(A1, { ...utm, level: 16, grid: 4 });
  const single = rp.placementMesh(A1, { ...utm, level: 16, grid: 1 });
  console.log(`  worst residual px — grid 4: ${mesh.worstResidualPx.toFixed(4)}, grid 1: ${single.worstResidualPx.toFixed(4)}`);
  assert.equal(mesh.cells.length, 16);
  assert.ok(mesh.ok && mesh.worstResidualPx <= 0.5, `worst ${mesh.worstResidualPx}`);
  assert.ok(single.worstResidualPx >= mesh.worstResidualPx, 'mesh cannot be worse than one affine');
  assert.deepEqual(mesh.cells[15].pageRect, { x: 1800, y: 2137.5, w: 600, h: 712.5 });
  assert.ok(mesh.cells.every((c) => c.residualMaxPx === c.affine.residualMaxPx));
});

test('tileDrawOps: only intersecting tiles, every op carries its cell affine', () => {
  const mesh = rp.placementMesh(A1, { ...utm, level: 16 });
  const tiles = tilesCovering(rp.controlPoints(A1, { ...utm, level: 16 }), 16);
  const ops = rp.tileDrawOps(mesh, tiles);
  assert.ok(ops.length >= tiles.length, `${ops.length} ops for ${tiles.length} tiles`);
  assert.ok(ops.length < 16 * tiles.length, 'not every tile touches every cell');
  const keys = new Set(tiles.map((t) => t.key));
  for (const op of ops) {
    assert.ok(keys.has(op.key) && op.sw > 0 && op.sh > 0 && op.sx >= 0 && op.sy >= 0 && op.sx + op.sw <= 256 && op.sy + op.sh <= 256);
    assert.equal(op.dx, op.sx + 256 * Number(op.key.split('/')[1]));
    assert.equal(op.transform, mesh.cells[op.cellIndex].affine);
  }
  // The sheet is a rotated rectangle in Mercator; up to the 4 corner tiles of its bbox touch no cell.
  assert.ok(new Set(ops.map((o) => o.key)).size >= tiles.length - 4, 'every tile inside the sheet is drawn');
});
