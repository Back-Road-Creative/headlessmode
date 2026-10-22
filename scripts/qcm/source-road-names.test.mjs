// Road-name fetcher: query shape, status mapping, latest-wins, cache, zero requests below zoom 10.
// Run: node --test scripts/qcm/source-road-names.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildRoadQuery, fetchRoadNames, createRoadNamesFetcher, ROAD_QUERY_PUBLISHER_FILTER, ROAD_CACHE_LIMIT,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-road-names.js';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/road-names-sylva.json', import.meta.url), 'utf8'));
const [W, S, E, N] = FIX.bbox;
const BBOX = { minLon: W, minLat: S, maxLon: E, maxLat: N };
const layerOf = (url) => Number(new URL(url).pathname.match(/MapServer\/(\d+)\/query/)[1]);
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** A fetch that answers each layer from the Sylva capture (as a COMPLETE page: the capture was
 *  taken with a 20-row limit, so its own exceededTransferLimit flag is dropped) and records
 *  every URL. */
function fixtureFetch(overrides = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const L = layerOf(url);
    if (overrides[L]) return overrides[L](url, init);
    return json({ features: FIX.layers[L].features });
  };
  impl.calls = calls;
  return impl;
}

test('buildRoadQuery asks for the publisher filter, longest first, 200 rows, 4326 both ways', () => {
  const url = new URL(buildRoadQuery({ layer: 32, bbox: BBOX, zoom: 13 }));
  assert.equal(url.origin, 'https://carto.nationalmap.gov');
  assert.equal(url.pathname, '/arcgis/rest/services/transportation/MapServer/32/query');
  const p = url.searchParams;
  assert.equal(p.get('where'), "name IS NOT NULL AND name NOT LIKE '%Squaw%' AND name NOT LIKE '%SQUAW%'");
  assert.equal(p.get('where'), `name IS NOT NULL AND ${ROAD_QUERY_PUBLISHER_FILTER}`);
  assert.equal(p.get('orderByFields'), 'Shape_Length DESC');
  assert.equal(p.get('resultRecordCount'), '200');
  assert.equal(p.get('geometry'), `${W},${S},${E},${N}`);
  assert.equal(p.get('geometryType'), 'esriGeometryEnvelope');
  assert.equal(p.get('inSR'), '4326');
  assert.equal(p.get('outSR'), '4326');
  assert.equal(p.get('returnGeometry'), 'true');
  assert.equal(p.get('geometryPrecision'), '5');
  assert.equal(p.get('f'), 'json');
  for (const f of ['name', 'interstate', 'us_route', 'state_route', 'county_route', 'federal_lands_route', 'stco_fipscode', 'permanent_identifier']) {
    assert.ok(p.get('outFields').split(',').includes(f), `outFields lacks ${f}`);
  }
});

test('buildRoadQuery refuses a layer the zoom has not reached', () => {
  assert.throws(() => buildRoadQuery({ layer: 32, bbox: BBOX, zoom: 12 }), RangeError);
  assert.throws(() => buildRoadQuery({ layer: 29, bbox: BBOX, zoom: 9 }), RangeError);
  assert.throws(() => buildRoadQuery({ layer: 7, bbox: BBOX, zoom: 13 }), RangeError);
  assert.throws(() => buildRoadQuery({ layer: 29, bbox: { minLon: 1 }, zoom: 10 }), RangeError);
});

test('zoom 9 makes zero requests', async () => {
  const f = fixtureFetch();
  const r = await createRoadNamesFetcher().fetchRoadNames({ bbox: BBOX, zoom: 9, fetchImpl: f });
  assert.equal(f.calls.length, 0);
  assert.equal(r.status, 'empty');
  assert.deepEqual(r.entries, []);
});

test('only the layers the zoom has reached are asked', async () => {
  for (const [zoom, want] of [[10, [29]], [11, [29, 30]], [12, [29, 30, 31, 35]], [13, [29, 30, 31, 32, 35]]]) {
    const f = fixtureFetch();
    await createRoadNamesFetcher().fetchRoadNames({ bbox: BBOX, zoom, fetchImpl: f });
    assert.deepEqual(f.calls.map((c) => layerOf(c.url)).sort((a, b) => a - b), want, `zoom ${zoom}`);
  }
});

test('a clean answer is ok, grouped, attributed verbatim, and routes through the registry entry', async () => {
  const f = fixtureFetch();
  const r = await createRoadNamesFetcher().fetchRoadNames({ bbox: BBOX, zoom: 13, fetchImpl: f });
  assert.equal(r.status, 'ok');
  assert.ok(r.entries.length > 10);
  assert.ok(r.entries.every((e) => e.label && e.anchor && e.parts.length));
  assert.equal(r.attribution, SOURCES.usgsRoadNames.attribution);
  assert.match(r.attribution, /^USGS The National Map: National Transportation Dataset; U\.S\. Census Bureau – TIGER\/Line; U\.S\. Forest Service\. Data Refreshed October, 2026\.$/);
  assert.ok(f.calls.every((c) => c.url.startsWith(SOURCES.usgsRoadNames.serviceUrl)));
});

test('exceededTransferLimit on any layer is partial', async () => {
  const f = fixtureFetch({
    31: async () => json({ features: FIX.layers[31].features, exceededTransferLimit: true }),
    29: async () => json({ features: FIX.layers[29].features }),
    30: async () => json({ features: FIX.layers[30].features }),
    35: async () => json({ features: [] }),
  });
  const r = await createRoadNamesFetcher().fetchRoadNames({ bbox: BBOX, zoom: 12, fetchImpl: f });
  assert.equal(r.status, 'partial');
  assert.ok(r.entries.length > 0, 'what did arrive is still handed back');
});

test('a non-2xx, a thrown fetch and an ArcGIS error body are error, never empty', async () => {
  const cases = {
    'HTTP 500': async () => json({}, 500),
    'network throw': async () => { throw new TypeError('Failed to fetch'); },
    'error envelope in a 200': async () => json({ error: { code: 400, message: 'Unable to complete operation.' } }),
  };
  for (const [name, answer] of Object.entries(cases)) {
    const f = fixtureFetch({ 29: answer });
    const r = await createRoadNamesFetcher().fetchRoadNames({ bbox: BBOX, zoom: 10, fetchImpl: f });
    assert.equal(r.status, 'error', name);
    assert.notEqual(r.status, 'empty', name);
    assert.deepEqual(r.entries, [], name);
  }
});

test('one layer failing while another answers is partial, with the answer kept', async () => {
  const f = fixtureFetch({ 30: async () => json({}, 503) });
  const r = await createRoadNamesFetcher().fetchRoadNames({ bbox: BBOX, zoom: 11, fetchImpl: f });
  assert.equal(r.status, 'partial');
  assert.ok(r.entries.length > 0);
});

test('every layer answering with nothing is empty', async () => {
  const f = fixtureFetch({ 29: async () => json({ features: [] }) });
  const r = await createRoadNamesFetcher().fetchRoadNames({ bbox: BBOX, zoom: 10, fetchImpl: f });
  assert.equal(r.status, 'empty');
});

test('an identical view is answered from the cache; a different one is not; errors are not cached', async () => {
  const fetcher = createRoadNamesFetcher();
  const f = fixtureFetch();
  await fetcher.fetchRoadNames({ bbox: BBOX, zoom: 11, fetchImpl: f });
  const after = f.calls.length;
  const again = await fetcher.fetchRoadNames({ bbox: BBOX, zoom: 11, fetchImpl: f });
  assert.equal(f.calls.length, after, 'cache hit must not refetch');
  assert.ok(again.entries.length > 0);
  // A pixel of drift rounds to the same key; a real pan does not.
  await fetcher.fetchRoadNames({ bbox: { ...BBOX, minLon: BBOX.minLon + 0.00001 }, zoom: 11, fetchImpl: f });
  assert.equal(f.calls.length, after, 'sub-key drift is the same view');
  await fetcher.fetchRoadNames({ bbox: { ...BBOX, minLon: BBOX.minLon - 0.5, maxLon: BBOX.maxLon - 0.5 }, zoom: 11, fetchImpl: f });
  assert.ok(f.calls.length > after);
  const n = f.calls.length;
  await fetcher.fetchRoadNames({ bbox: BBOX, zoom: 12, fetchImpl: f });
  assert.ok(f.calls.length > n, 'zoom is part of the key');

  const bad = createRoadNamesFetcher();
  let fail = true;
  const g = fixtureFetch({ 29: async () => (fail ? json({}, 500) : json({ features: FIX.layers[29].features })) });
  assert.equal((await bad.fetchRoadNames({ bbox: BBOX, zoom: 10, fetchImpl: g })).status, 'error');
  fail = false;
  assert.equal((await bad.fetchRoadNames({ bbox: BBOX, zoom: 10, fetchImpl: g })).status, 'ok', 'the retry went to the network');
});

test('the cache holds at most 32 results, dropping the oldest', async () => {
  assert.equal(ROAD_CACHE_LIMIT, 32);
  const fetcher = createRoadNamesFetcher();
  const f = fixtureFetch();
  const at = (i) => ({ minLon: -100 + i, minLat: 35, maxLon: -99.9 + i, maxLat: 35.1 });
  for (let i = 0; i < 33; i += 1) await fetcher.fetchRoadNames({ bbox: at(i), zoom: 10, fetchImpl: f });
  assert.equal(f.calls.length, 33);
  await fetcher.fetchRoadNames({ bbox: at(32), zoom: 10, fetchImpl: f });
  assert.equal(f.calls.length, 33, 'newest is cached');
  await fetcher.fetchRoadNames({ bbox: at(0), zoom: 10, fetchImpl: f });
  assert.equal(f.calls.length, 34, 'the oldest was evicted');
});

test('a new call aborts the one in flight: latest wins', async () => {
  const fetcher = createRoadNamesFetcher();
  const signals = [];
  const hang = (url, init) => new Promise((_, reject) => {
    signals.push(init.signal);
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const first = fetcher.fetchRoadNames({ bbox: BBOX, zoom: 10, fetchImpl: hang });
  const second = fetcher.fetchRoadNames({ bbox: { ...BBOX, minLat: 36, maxLat: 36.1 }, zoom: 10, fetchImpl: fixtureFetch() });
  const r1 = await first;
  assert.equal(signals[0].aborted, true, 'the earlier request was cancelled');
  assert.equal(r1.status, 'stale', 'a superseded call reports stale, not error');
  assert.deepEqual(r1.entries, []);
  assert.equal((await second).status, 'ok', 'the later call is unaffected');
});

test('a caller signal aborts the call and is reported as stale, not error', async () => {
  const ac = new AbortController();
  const hang = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const p = createRoadNamesFetcher().fetchRoadNames({ bbox: BBOX, zoom: 10, fetchImpl: hang, signal: ac.signal });
  ac.abort();
  assert.equal((await p).status, 'stale');
});

test('the default export is a working fetcher', async () => {
  const f = fixtureFetch();
  const r = await fetchRoadNames({ bbox: { ...BBOX, minLon: -90, maxLon: -89.9 }, zoom: 10, fetchImpl: f });
  assert.equal(r.status, 'ok');
});
