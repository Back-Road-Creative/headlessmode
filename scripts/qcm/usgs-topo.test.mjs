// USGS Topo tile adapter contract. No network: fetch is always a fake. Run: node --test "scripts/qcm/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectBbox } from '../../themes/headlessmode/static/js/quiet-corners-maps/geometry.js';
import { planSheets } from '../../themes/headlessmode/static/js/quiet-corners-maps/sheet-plan.js';
import { SOURCES, FAILURE } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import * as t from '../../themes/headlessmode/static/js/quiet-corners-maps/source-usgs-topo.js';

const meta = JSON.parse(readFileSync(new URL('fixtures/usgs-topo-mapserver.min.json', import.meta.url), 'utf8'));
const utm = { zone: 17, hemisphere: 'N' };
const plan = planSheets({
  paper: 'letter', orientation: 'portrait', scale: 24000, overlapIn: 0.5, dpi: 300, title: 'Standing Indian',
  extent: projectBbox({ minLon: -83.55, minLat: 35.0, maxLon: -83.4, maxLat: 35.1 }, 17, 'N'), ...utm,
});
const A1 = plan.sheets[0];
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const intersects = (a, b) => a.minLon < b.maxLon && a.maxLon > b.minLon && a.minLat < b.maxLat && a.maxLat > b.minLat;
const response = (status) => ({ ok: status === 200, status, arrayBuffer: async () => new ArrayBuffer(4) });

test('mercatorResolution matches the service lods and the registry; cos(lat) scaling', () => {
  assert.equal(meta.tileInfo.rows, t.TILE_SIZE);
  for (const lod of meta.tileInfo.lods) near(t.mercatorResolution(lod.level), lod.resolution, 1e-6, `lod ${lod.level}`);
  near(t.mercatorResolution(16), SOURCES.usgsTopo.tile.resolutionAtLevel16MetersPerPixelEquator, 0.001, 'registry L16');
  near(t.mercatorResolution(16, 35), 1.957, 0.002, 'L16 @35N');
  near(t.mercatorResolution(15, 35), 3.914, 0.002, 'L15 @35N');
  assert.equal(meta.maxExportTilesCount, SOURCES.usgsTopo.limits.maxExportTilesCount);
});

test('chooseLevel: finest level at or below the page resolution, capped with shortfall', () => {
  const at = (metersPerPixel) => t.chooseLevel({ metersPerPixel, latDeg: 35.05 });
  assert.deepEqual([at(2.032).level, at(2.032).shortfall, at(4.064).level, at(3.048).level], [16, false, 15, 16]);
  const capped = at(1.0);
  assert.equal(capped.level, 16); assert.equal(capped.shortfall, true);
  near(capped.ratio, 1.957, 0.002, 'ratio');
});

test('lonLatToTile finds the tile measured to exist (16/y=25952/x=17562) and tileBounds contains the point', () => {
  const [lon, lat] = [-83.5263, 35.0277];
  const { x, y } = t.lonLatToTile(lon, lat, 16);
  assert.deepEqual({ x, y }, { x: 17562, y: 25952 });
  const b = t.tileBounds(x, y, 16);
  assert.ok(b.minLon <= lon && lon < b.maxLon && b.minLat <= lat && lat < b.maxLat, JSON.stringify(b));
  near(b.maxLon - b.minLon, 360 / 2 ** 16, 1e-12, 'tile width');
});

test('tilesForSheet A1 @16: tiles intersect the sheet bbox, unique keys, registry urls', () => {
  assert.equal(plan.count, 9); // 3×3: convergence −1.42° rotates the bbox, so its UTM extent is 13.96 × 11.43 km
  const { tiles, bboxLonLat, level } = t.tilesForSheet(A1, { ...utm, level: 16, bufferPx: 0 });
  assert.equal(level, 16);
  assert.ok(tiles.length > 50 && tiles.length < 200, `${tiles.length} tiles`);
  assert.equal(new Set(tiles.map((x) => x.key)).size, tiles.length);
  for (const tile of tiles) {
    assert.ok(intersects(t.tileBounds(tile.x, tile.y, 16), bboxLonLat), tile.key);
    assert.ok(tile.url.startsWith(`${SOURCES.usgsTopo.serviceUrl}/tile/16/`) && tile.url.endsWith(`/${tile.y}/${tile.x}`), tile.url);
  }
  assert.ok(t.tilesForSheet(A1, { ...utm, level: 16 }).tiles.length >= tiles.length, 'default buffer adds, never removes');
});

test('tilesForPlan de-duplicates the overlap strips; budgetCheck names the numbers', () => {
  const r = t.tilesForPlan(plan, { ...utm, level: 16 });
  const perSheet = Object.values(r.perSheet).map((k) => k.length);
  console.log(`  tiles per sheet ${JSON.stringify(r.perSheet && Object.fromEntries(Object.entries(r.perSheet).map(([k, v]) => [k, v.length])))}, unique ${r.count}, shared ${r.shared}`);
  assert.equal(perSheet.length, 9);
  assert.ok(r.shared > 0 && r.unique.length < perSheet.reduce((a, b) => a + b, 0) && r.count === r.unique.length);
  assert.equal(t.budgetCheck(r.count).ok, true);
  const over = t.budgetCheck(r.count, { maxTiles: 10 });
  assert.equal(over.ok, false);
  assert.ok(over.message.includes(String(r.count)) && over.message.includes('10'), over.message);
});

test('accountTiles reports missing keys with the registry failure message', () => {
  assert.deepEqual(t.accountTiles(['16/1/1', '16/1/2'], ['16/1/1']),
    { missing: ['16/1/2'], complete: false, message: FAILURE.tilesMissing(1, 2) });
  assert.deepEqual(t.accountTiles(['16/1/1'], ['16/1/1']), { missing: [], complete: true, message: null });
});

test('fetchTiles: bounded concurrency, 404 not retried, 503 retried, timeout, abort, progress', async () => {
  const tiles = [1, 2, 3, 4, 5].map((i) => ({ key: `16/${i}/0`, url: `u/${i}` }));
  let inFlight = 0, maxInFlight = 0, hits = {};
  const fake = (url, { signal }) => new Promise((resolve, reject) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); hits[url] = (hits[url] || 0) + 1;
    signal.addEventListener('abort', () => { inFlight--; reject(signal.reason); }, { once: true });
    if (url === 'u/5') return; // hangs until aborted
    setTimeout(() => { inFlight--; resolve(response(url === 'u/2' ? 404 : url === 'u/3' && hits[url] === 1 ? 503 : 200)); }, 5);
  });
  const progress = [];
  // timeoutMs has to sit far above the 5 ms the healthy tiles resolve on, because a
  // timeout is retryable and so a healthy tile that merely runs LATE is retried like a
  // failed one. At 30 ms the margin was 6x, and on 2026-09-11 a runner sharing the box
  // with two others delayed a 5 ms timer past it: u/5 was meant to be the only timeout,
  // retriedCount came back 3 instead of 2, and master went red on a green PR. 500 ms is
  // a 100x margin on the same assertions -- u/5 never resolves, so it still times out
  // and still costs the test only that one wait.
  const r = await t.fetchTiles([...tiles, tiles[0]], { fetchImpl: fake, concurrency: 2, timeoutMs: 500, retries: 1, backoffMs: [0], onProgress: (n) => progress.push(n) });
  assert.equal(maxInFlight, 2); assert.equal(r.requested, 5); assert.equal(hits['u/1'], 1);
  assert.deepEqual([r.results.get('16/2/0').ok, r.results.get('16/2/0').status, hits['u/2']], [false, 404, 1]);
  assert.deepEqual([r.results.get('16/3/0').ok, hits['u/3'], r.retriedCount], [true, 2, 2]);
  assert.equal(r.results.get('16/5/0').ok, false); assert.match(r.results.get('16/5/0').error, /time/i);
  assert.equal(r.received, 3); assert.equal(r.results.get('16/1/0').bytes.byteLength, 4);
  assert.deepEqual(progress, progress.slice().sort((a, b) => a - b)); assert.equal(progress.length, 5);
  const ctrl = new AbortController();
  const slow = (url, { signal }) => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(signal.reason)); ctrl.abort(); });
  const a = await t.fetchTiles(tiles, { fetchImpl: slow, concurrency: 1, signal: ctrl.signal, retries: 2 });
  assert.equal(a.received, 0); assert.equal(a.results.size, 5); assert.equal(a.retriedCount, 0);
  assert.ok([...a.results.values()].every((x) => !x.ok && /abort/i.test(x.error)));
});
