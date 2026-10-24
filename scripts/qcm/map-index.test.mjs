// Tests for the USGS 7.5-minute quad index adapter. No network: every fetch is a fake
// serving (or breaking) the committed Standing Indian fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  OUT_FIELDS, buildBboxQueryUrl, buildNameQueryUrl, normalizeCell, neighborsOf,
  fetchCellsForBbox, searchByName, MAX_PAGES,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-map-index.js';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'map-indices-standing-indian.json'), 'utf8'));
const cloneFixture = () => JSON.parse(JSON.stringify(FIXTURE));
const jsonResponse = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
const statusResponse = (status) => ({ ok: false, status, json: async () => ({}) });
// Strictly interior to the four fixture cells' shared boundaries (-83.625/-83.5/-83.375,
// 34.875/35.0/35.125) so cellsForBbox's closed-interval matching yields exactly these 4.
const BBOX = { minLon: -83.6, minLat: 34.9, maxLon: -83.4, maxLat: 35.1 };
const [hightowerBald, dillard, prentiss, rainbowSprings] = FIXTURE.features;

test('buildBboxQueryUrl: exact Standing Indian string, host, and rejections', () => {
  const url = buildBboxQueryUrl({ bboxLonLat: { minLon: -83.55, minLat: 35.0, maxLon: -83.4, maxLat: 35.1 } });
  assert.equal(
    url,
    'https://carto.nationalmap.gov/arcgis/rest/services/map_indices/MapServer/10/query'
    + '?geometry=-83.55%2C35%2C-83.4%2C35.1&geometryType=esriGeometryEnvelope&inSR=4326'
    + '&spatialRel=esriSpatialRelIntersects'
    + '&outFields=CELL_ID%2CCELL_NAME%2CPRIMARY_STATE%2CSTATE_ALPHA%2CCELL_MAPCODE'
    + '&returnGeometry=true&outSR=4326&resultOffset=0&resultRecordCount=200&f=json',
  );
  assert.equal(new URL(url).origin, SOURCES.usgsQuadIndex.origin);
  assert.throws(() => buildBboxQueryUrl({ bboxLonLat: { minLon: -85, minLat: 34, maxLon: -82, maxLat: 36 } }), RangeError);
  assert.throws(() => buildBboxQueryUrl({ bboxLonLat: { minLon: -82, minLat: 34, maxLon: -83, maxLat: 36 } }), RangeError);
  assert.throws(() => buildBboxQueryUrl({ bboxLonLat: { minLon: NaN, minLat: 34, maxLon: -83, maxLat: 36 } }), RangeError);
});

test('buildNameQueryUrl: LIKE clause, apostrophe doubling, state filter, min-length', () => {
  assert.match(
    new URL(buildNameQueryUrl({ name: 'rainbow springs' })).searchParams.get('where'),
    /UPPER\(CELL_NAME\) LIKE '%RAINBOW SPRINGS%'/,
  );
  assert.match(new URL(buildNameQueryUrl({ name: "O'Neal" })).searchParams.get('where'), /'%O''NEAL%'/);
  assert.match(
    new URL(buildNameQueryUrl({ name: 'dillard', state: 'GA' })).searchParams.get('where'),
    /AND STATE_ALPHA LIKE '%GA%'/,
  );
  assert.throws(() => buildNameQueryUrl({ name: 'a' }), RangeError);
});

test('normalizeCell: names, states, matchesArithmetic, and the Hightower Bald cell', () => {
  assert.deepEqual(FIXTURE.features.map((f) => normalizeCell(f).name), ['Hightower Bald', 'Dillard', 'Prentiss', 'Rainbow Springs']);
  assert.deepEqual(normalizeCell(hightowerBald).states, ['GA', 'NC']);
  for (const feature of FIXTURE.features) assert.equal(normalizeCell(feature).matchesArithmetic, true, normalizeCell(feature).name);
  assert.deepEqual(normalizeCell(hightowerBald).cell, { minLon: -83.625, minLat: 34.875, maxLon: -83.5, maxLat: 35.0 });
});

test('neighborsOf: derived, not hardcoded, against the fixture', () => {
  const rs = normalizeCell(rainbowSprings);
  const neighbors = neighborsOf(rs.cell);
  assert.equal(Object.keys(neighbors).length, 4);
  // Prentiss's CELL_MAPCODE (35083-A4) sits one column east of Rainbow Springs's (35083-A5),
  // Hightower Bald (34083-H5) one row south — cellNeighbors confirms both. Rainbow Springs's
  // actual west neighbor lies outside the fixture and equals neither Prentiss nor Dillard.
  assert.deepEqual(neighbors.e, normalizeCell(prentiss).cell);
  assert.deepEqual(neighbors.s, normalizeCell(hightowerBald).cell);
  assert.notDeepEqual(neighbors.w, normalizeCell(prentiss).cell);
  assert.notDeepEqual(neighbors.w, normalizeCell(dillard).cell);
});

test('fetchCellsForBbox: one page, complete, 4 cells, no warnings', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return jsonResponse(cloneFixture()); };
  const result = await fetchCellsForBbox({ bboxLonLat: BBOX, fetchImpl });
  assert.equal(result.coverage, 'complete');
  assert.equal(result.cells.length, 4);
  assert.equal(result.pages, 1);
  assert.deepEqual(result.warnings, []);
  assert.equal(calls.length, 1);
});

test('fetchCellsForBbox: pages while exceededTransferLimit is true', async () => {
  const full = cloneFixture();
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) return jsonResponse({ features: full.features.slice(0, 2), exceededTransferLimit: true });
    return jsonResponse({ features: full.features.slice(2, 4) });
  };
  const result = await fetchCellsForBbox({ bboxLonLat: BBOX, fetchImpl });
  assert.equal(result.coverage, 'complete');
  assert.equal(result.pages, 2);
  assert.equal(result.cells.length, 4);
});

test('fetchCellsForBbox: second page 500 x3 (1 + retries) -> partial, 2 cells', async () => {
  const full = cloneFixture();
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) return jsonResponse({ features: full.features.slice(0, 2), exceededTransferLimit: true });
    return statusResponse(500);
  };
  const result = await fetchCellsForBbox({ bboxLonLat: BBOX, fetchImpl, retries: 2 });
  assert.equal(result.coverage, 'partial');
  assert.equal(result.cells.length, 2);
  assert.ok(result.error);
  assert.equal(call, 1 + 3);
});

test('fetchCellsForBbox: first page 404 -> unavailable', async () => {
  const result = await fetchCellsForBbox({ bboxLonLat: BBOX, fetchImpl: async () => statusResponse(404) });
  assert.equal(result.coverage, 'unavailable');
  assert.equal(result.cells.length, 0);
  assert.ok(result.error);
});

test('fetchCellsForBbox: a missing fixture feature -> complete, one bounds warning', async () => {
  const partial = cloneFixture();
  const removed = partial.features.pop(); // Rainbow Springs
  const result = await fetchCellsForBbox({ bboxLonLat: BBOX, fetchImpl: async () => jsonResponse(partial) });
  assert.equal(result.coverage, 'complete');
  assert.equal(result.cells.length, 3);
  assert.equal(result.warnings.length, 1);
  const missing = normalizeCell(removed).cell;
  assert.match(result.warnings[0], new RegExp(`minLon:${missing.minLon}.*minLat:${missing.minLat}`));
});

test('fetchCellsForBbox: abort resolves cleanly (unavailable pre-fetch, partial mid-fetch)', async () => {
  const preAborted = new AbortController();
  preAborted.abort();
  const r1 = await fetchCellsForBbox({ bboxLonLat: BBOX, fetchImpl: async () => jsonResponse(cloneFixture()), signal: preAborted.signal });
  assert.equal(r1.coverage, 'unavailable');
  const midAbort = new AbortController();
  const full = cloneFixture();
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) { midAbort.abort(); return jsonResponse({ features: full.features.slice(0, 2), exceededTransferLimit: true }); }
    return jsonResponse({ features: full.features.slice(2, 4) });
  };
  const r2 = await fetchCellsForBbox({ bboxLonLat: BBOX, fetchImpl, signal: midAbort.signal });
  assert.equal(r2.coverage, 'partial');
  assert.equal(r2.cells.length, 2);
});

test('searchByName: ok with cells on success, ok:false with error text on throw', async () => {
  const ok = await searchByName({ name: 'rainbow springs', fetchImpl: async () => jsonResponse(cloneFixture()) });
  assert.equal(ok.ok, true);
  assert.equal(ok.cells.length, 4);
  const fail = await searchByName({ name: 'rainbow springs', fetchImpl: async () => { throw new Error('network down'); } });
  assert.equal(fail.ok, false);
  assert.match(fail.error, /network down/);
  assert.deepEqual(OUT_FIELDS, ['CELL_ID', 'CELL_NAME', 'PRIMARY_STATE', 'STATE_ALPHA', 'CELL_MAPCODE']);
});

test('fetchCellsForBbox: a service flagging more forever with no features stops inside MAX_PAGES as partial', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonResponse({ features: [], exceededTransferLimit: true }); };
  const result = await fetchCellsForBbox({ bboxLonLat: BBOX, fetchImpl });
  assert.equal(result.coverage, 'partial');
  assert.ok(calls <= MAX_PAGES, `${calls} fetches`);
  assert.equal(calls, 1, 'a page that adds nothing ends the loop at once');
  assert.deepEqual(result.cells, []);
});

test('fetchCellsForBbox: a service repeating the same page is cut as partial, and MAX_PAGES caps a service that keeps adding', async () => {
  let calls = 0;
  const same = async () => { calls += 1; return jsonResponse({ features: cloneFixture().features.slice(0, 2), exceededTransferLimit: true }); };
  const repeat = await fetchCellsForBbox({ bboxLonLat: BBOX, fetchImpl: same });
  assert.equal(repeat.coverage, 'partial');
  assert.equal(calls, 2, 'one real page, then one that added nothing new');
  assert.equal(repeat.cells.length, 2);

  calls = 0;
  const forever = async () => {
    calls += 1;
    const f = cloneFixture().features[0];
    f.attributes = { ...f.attributes, CELL_ID: `cell-${calls}` };
    return jsonResponse({ features: [f], exceededTransferLimit: true });
  };
  const capped = await fetchCellsForBbox({ bboxLonLat: BBOX, fetchImpl: forever });
  assert.equal(capped.coverage, 'partial');
  assert.equal(calls, MAX_PAGES);
  assert.equal(capped.pages, MAX_PAGES);
});

test('fetchCellsForBbox and searchByName end by their own timeoutMs on a fetch that never answers', async () => {
  const never = () => new Promise(() => {});
  const t0 = Date.now();
  const cells = await fetchCellsForBbox({ bboxLonLat: BBOX, fetchImpl: never, timeoutMs: 50, retries: 2 });
  assert.equal(cells.coverage, 'unavailable');
  assert.equal(cells.timedOut, true);
  assert.ok(Date.now() - t0 < 50 + 250, `took ${Date.now() - t0} ms: a timeout is not retried`);

  const t1 = Date.now();
  const named = await searchByName({ name: 'rainbow springs', fetchImpl: never, timeoutMs: 50 });
  assert.equal(named.ok, false);
  assert.equal(named.timedOut, true);
  assert.ok(Date.now() - t1 < 50 + 250);
});

test('the quad index asks the registry for its timeout', () => {
  assert.equal(typeof SOURCES.usgsQuadIndex.timeoutMs, 'number');
});
