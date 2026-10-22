// node --test "scripts/qcm/*.test.mjs" — USFS MVUM adapter: bounded paged queries, honest coverage states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCES, FAILURE } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import * as m from '../../themes/headlessmode/static/js/quiet-corners-maps/source-mvum.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (n) => JSON.parse(readFileSync(join(here, `fixtures/${n}`), 'utf8'));
const p1 = load('mvum-roads-p1.min.json'); // 4 features, exceededTransferLimit true
const p2done = { ...load('mvum-roads-p2.min.json'), exceededTransferLimit: false }; // 2 features, patched to be the last page
const layer1 = load('mvum-roads-layer1.min.json');
const bbox = { minLon: -83.55, minLat: 35.0, maxLon: -83.4, maxLat: 35.1 }; // Standing Indian: 24 roads, 0 trails measured
const BASE = `${SOURCES.usfsMvum.serviceUrl}/1/query?where=1%3D1&geometry=-83.55,35,-83.4,35.1`
  + '&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects';
const norm = (f) => m.normalizeFeature(f, 'roads');

// Fake fetch keyed by 'count' / 'pageN' (pageSize 4); a route is a 200 body, a status, an Error, a fn(init), or an in-order array.
const res = (status, body) => ({ ok: status < 400, status, json: async () => { if (typeof body === 'string') throw new SyntaxError(body); return body; } });
async function run(routes, extra = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const kind = u.searchParams.has('returnCountOnly') ? 'count' : `page${u.searchParams.get('resultOffset') / 4}`;
    calls.push(kind);
    let r = routes[kind];
    if (Array.isArray(r)) r = r.length > 1 ? r.shift() : r[0];
    if (typeof r === 'function') r = r(init);
    if (r instanceof Error) throw r;
    return typeof r === 'number' ? res(r, {}) : res(200, r);
  };
  const r = await m.fetchLayer({ layer: 'roads', bboxLonLat: bbox, pageSize: 4, fetchImpl, sleep: async () => {}, now: () => 'T', ...extra });
  return { ...r, calls, page1Calls: calls.filter((c) => c === 'page1').length };
}

test('buildQueryUrl: exact page URL, count-only form, registry origin and fields', () => {
  assert.equal(m.buildQueryUrl({ layer: 1, bboxLonLat: bbox }),
    `${BASE}&outFields=${m.OUT_FIELDS.join(',')}&returnGeometry=true&outSR=4326&resultOffset=0&resultRecordCount=1000&f=json`);
  const c = m.buildQueryUrl({ layer: m.LAYERS.trails, bboxLonLat: bbox, countOnly: true });
  assert.equal(c, `${BASE.replace('/1/query', '/2/query')}&returnCountOnly=true&f=json`);
  assert.equal(new URL(c).origin, SOURCES.usfsMvum.origin);
  assert.match(m.buildQueryUrl({ layer: 1, bboxLonLat: bbox, offset: 1000, pageSize: 500 }), /resultOffset=1000&resultRecordCount=500&/);
  assert.deepEqual([...m.OUT_FIELDS], [...SOURCES.usfsMvum.layers[0].fields]);
  assert.ok(m.OUT_FIELDS.every((f) => layer1.fields.includes(f)));
  assert.deepEqual([layer1.maxRecordCount, layer1.advancedQueryCapabilities.supportsPagination], [2000, true]);
});

test('buildQueryUrl refuses inverted, NaN, over-1° and unknown-layer requests', () => {
  const bad = [{ minLon: -84.5, maxLon: -82.5 }, { maxLat: 36.1 }, { minLon: -83.4, maxLon: -83.55 }, { minLat: NaN }];
  for (const b of bad) assert.throws(() => m.buildQueryUrl({ layer: 1, bboxLonLat: { ...bbox, ...b } }), RangeError, JSON.stringify(b));
  assert.throws(() => m.buildQueryUrl({ layer: 3, bboxLonLat: bbox }), RangeError);
});

test('parseDatesOpen', () => {
  assert.deepEqual(m.parseDatesOpen('04/01-12/15'), { open: '04-01', close: '12-15' });
  assert.deepEqual(m.parseDatesOpen('01/01-12/31'), { open: '01-01', close: '12-31' });
  for (const bad of ['', null, undefined, 'garbage', '13/01-12/31']) assert.equal(m.parseDatesOpen(bad), null, String(bad));
});

test('normalizeFeature: measured Standing Indian attributes, blank-field policy', () => {
  const f = norm(p1.features[0]);
  assert.deepEqual([f.id, f.name, f.layer, f.seasonal, f.forest], ['424D', 'STANDING INDIAN LOOP D', 'road', 'seasonal', 'National Forests in North Carolina']);
  assert.deepEqual(f.vehicles.passenger, { allowed: 'open', datesOpen: { open: '04-01', close: '12-15' } });
  assert.equal(f.symbolName, 'Roads open to highway legal vehicles only, Seasonal');
  assert.ok(f.paths.length >= 1 && f.paths[0].length === 4 && f.paths[0][0].length === 2);
  assert.deepEqual(f.warnings, []);
  const ball = norm(p1.features[3]);
  assert.deepEqual([ball.id, ball.name, ball.seasonal, ball.vehicles.passenger.datesOpen], ['83', 'BALL CREEK', 'yearlong', { open: '01-01', close: '12-31' }]);
  const blank = m.normalizeFeature({ ...p1.features[0], attributes: { ...p1.features[0].attributes, seasonal: '', passengervehicle_datesopen: null } }, 2);
  assert.deepEqual([blank.layer, blank.seasonal, blank.vehicles.passenger.datesOpen, blank.warnings.length], ['trail', null, null, 2]);
  assert.match(blank.warnings[0], /seasonal/);
  assert.match(blank.warnings[1], /passengervehicle_datesopen/);
  const bad = m.normalizeFeature({ attributes: { ...p1.features[0].attributes, passengervehicle_datesopen: 'garbage' }, geometry: { paths: [] } }, 1);
  assert.ok(bad.warnings.some((w) => /passengervehicle_datesopen.*malformed/.test(w)));
});

test('summarize groups repeated road ids across pages', () => {
  const s = m.summarize([...p1.features, ...p2done.features].map(norm));
  assert.deepEqual([...s.byId.keys()].sort(), ['424D', '424F', '67', '751', '83']);
  assert.deepEqual([s.byId.get('424D').segments, s.byId.get('67').segments, [...s.byId.get('67').datesOpen]], [2, 1, ['03-15..12-31']]);
  assert.ok(s.symbolsUsed.size >= 1 && s.forests.has('National Forests in North Carolina'));
});

test('fetchLayer: two pages with a matching count → complete', async () => {
  const progress = [];
  const r = await run({ count: { count: 6 }, page0: p1, page1: p2done }, { onProgress: (...a) => progress.push(a) });
  assert.deepEqual([r.coverage, r.receivedCount, r.expectedCount, r.pages, r.retrievedAt, r.error, r.layer], ['complete', 6, 6, 2, 'T', null, 'road']);
  assert.equal(r.features[0].id, '424D');
  assert.deepEqual(progress[0], [1, 0, 6, FAILURE.paging(1, 2)]);
  assert.deepEqual(r.calls, ['count', 'page0', 'page1']);
  assert.equal(m.coverageMessage(r), 'MVUM: 6 road segments, complete.');
});

test('fetchLayer: count failure falls back to the last-page flag', async () => {
  const r = await run({ count: 500, page0: p1, page1: p2done });
  assert.deepEqual([r.coverage, r.expectedCount, r.receivedCount], ['complete', null, 6]);
  assert.ok(r.warnings.some((w) => /count/.test(w)));
});

test('fetchLayer: later page fails after retries → partial; first page fails → unavailable', async () => {
  const r = await run({ count: { count: 6 }, page0: p1, page1: 503 });
  assert.deepEqual([r.coverage, r.receivedCount, r.pages, r.retrievedAt, r.page1Calls], ['partial', 4, 1, 'T', 3]);
  assert.match(r.error, /page 2.*503/);
  assert.match(m.coverageMessage(r), /4 of 6/);
  const u = await run({ count: { count: 6 }, page0: 404 });
  assert.deepEqual([u.coverage, u.retrievedAt, u.features.length, u.calls], ['unavailable', null, 0, ['count', 'page0']]);
  assert.equal(m.coverageMessage(u), FAILURE.coverageUnknown);
});

test('fetchLayer: count mismatch, ArcGIS error body, malformed JSON, abort, 429 retry, empty trails, unknown', async () => {
  const mismatch = await run({ count: { count: 24 }, page0: p1, page1: p2done });
  assert.deepEqual([mismatch.coverage, mismatch.expectedCount, mismatch.receivedCount], ['partial', 24, 6]);
  assert.equal((await run({ count: { count: 6 }, page0: { error: { code: 400 } } })).coverage, 'unavailable');
  assert.equal((await run({ count: { count: 6 }, page0: 'not json' })).coverage, 'unavailable');
  const ctl = new AbortController();
  const aborted = await run({ count: { count: 6 }, page0: p1, page1: () => { ctl.abort(); return Object.assign(new Error('aborted'), { name: 'AbortError' }); } }, { signal: ctl.signal });
  assert.deepEqual([aborted.coverage, aborted.receivedCount, aborted.page1Calls], ['partial', 4, 1]);
  const retried = await run({ count: { count: 6 }, page0: p1, page1: [429, p2done] });
  assert.deepEqual([retried.coverage, retried.pages, retried.page1Calls], ['complete', 2, 2]);
  const trails = await run({ count: { count: 0 }, page0: { features: [] } }, { layer: 'trails' });
  assert.deepEqual([trails.coverage, trails.features.length, m.coverageMessage(trails)], ['complete', 0, 'MVUM: 0 trail segments, complete.']);
  const unknown = await run({ count: new Error('ECONNRESET'), page0: new Error('ECONNRESET') });
  assert.deepEqual([unknown.coverage, unknown.expectedCount, unknown.retrievedAt, m.coverageMessage(unknown)], ['unknown', null, null, FAILURE.coverageUnknown]);
});

test('buildQueryUrl: the trails layer omits the two road-only fields (layer 2 has no routestatus/surfacetype; measured 2026-09-05, HTTP 400 otherwise)', () => {
  const bbox = { minLon: -83.55, minLat: 35.0, maxLon: -83.4, maxLat: 35.1 };
  const trails = m.buildQueryUrl({ layer: m.LAYERS.trails, bboxLonLat: bbox });
  const roads = m.buildQueryUrl({ layer: m.LAYERS.roads, bboxLonLat: bbox });
  for (const f of ['routestatus', 'surfacetype']) { assert.doesNotMatch(trails, new RegExp(f)); assert.match(roads, new RegExp(f)); }
  assert.deepEqual([...m.fieldsForLayer(m.LAYERS.trails)], m.OUT_FIELDS.filter((f) => !m.ROAD_ONLY_FIELDS.includes(f)));
  assert.deepEqual([...m.fieldsForLayer(m.LAYERS.roads)], [...m.OUT_FIELDS]);
});
