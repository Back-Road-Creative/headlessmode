// source-stream-names.js: named rivers and creeks from the NHD flowline layers, against the
// bytes measured live 2026-10-06 (scripts/qcm/fixtures/nhd-flowlines-2026-10-06.min.json).
// No network. The reaches are the Bitterroot and its tributaries around Stevensville, Montana
// (public stream names and a town-centre extent only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { KINDS, labelPriorityOrder } from '../../themes/headlessmode/static/js/quiet-corners-maps/terrain-names.js';
import {
  fetchStreamNames, buildStatsUrl, buildGeometryUrl, nhdLayerForZoom, streamKindOf, STREAM_MIN_ZOOM,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-stream-names.js';

const FIX = JSON.parse(readFileSync(new URL('fixtures/nhd-flowlines-2026-10-06.min.json', import.meta.url), 'utf8'));
const Z9 = { minLon: -114.9, minLat: 46.0, maxLon: -113.3, maxLat: 47.0 };
const Z11 = { minLon: -114.25, minLat: 46.4, maxLon: -113.85, maxLat: 46.62 };
const MOUTH_LAT = 46.86; // the GNIS stream-mouth point, 25 miles north of the town

const json = (body) => ({ ok: true, status: 200, json: async () => body });

/** A fake service: statistics requests answer `stats`, geometry requests answer the fixture
 *  reaches whose GNIS_ID the request names. Records every URL it was asked. */
function service({ stats, reaches = FIX.geometryZ11.features }) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const p = new URL(url).searchParams;
    if (p.get('outStatistics')) return json(stats);
    const ids = [...p.get('where').matchAll(/'(\d+)'/g)].map((m) => m[1]);
    return json({ features: reaches.filter((r) => ids.includes(r.attributes.GNIS_ID)) });
  };
  return { fetchImpl, urls };
}
const inside = (b, [lat, lon]) => lon >= b.minLon && lon <= b.maxLon && lat >= b.minLat && lat <= b.maxLat;
const named = (res, name) => res.features.filter((f) => f.name === name);

for (const [zoom, bounds, stats] of [[9, Z9, FIX.statsZ9], [11, Z11, FIX.statsZ11]]) {
  test(`z${zoom}: exactly one Bitterroot River record, on the reach in view, not at the mouth`, async () => {
    const { fetchImpl } = service({ stats });
    const res = await fetchStreamNames(bounds, { zoom, fetch: fetchImpl });
    assert.ok(['ready', 'capped'].includes(res.status), res.status);
    const hits = named(res, 'Bitterroot River');
    assert.equal(hits.length, 1);
    assert.ok(inside(bounds, hits[0].anchor), `anchor ${hits[0].anchor} outside the view`);
    assert.ok(hits[0].anchor[0] < MOUTH_LAT - 0.1, 'anchored near the mouth point, not the reach in view');
    assert.equal(hits[0].kind, 'river');
    assert.equal(hits[0].layer, 'nhd');
    assert.equal(hits[0].id, 'nhd:779961');
  });
}

test('a creek appears at its floor zoom and not below it', async () => {
  assert.equal(STREAM_MIN_ZOOM.creek, 11);
  const at = async (zoom) => fetchStreamNames(Z11, { zoom, fetch: service({ stats: FIX.statsZ11 }).fetchImpl });
  assert.equal(named(await at(11), 'Willoughby Creek').length, 1);
  const below = await at(10);
  assert.equal(named(below, 'Willoughby Creek').length, 0);
  assert.equal(named(below, 'Bitterroot River').length, 1, 'rivers still draw below the creek floor');
  assert.ok(below.features.every((f) => f.kind === 'river'));
});

test('z9 never reports a creek even when the service answers one', async () => {
  const res = await fetchStreamNames(Z9, { zoom: 9, fetch: service({ stats: FIX.statsZ9 }).fetchImpl });
  assert.equal(res.features.filter((f) => f.kind === 'creek').length, 0);
});

test('ditches, canals and artificial paths are excluded in the request and again in the answer', async () => {
  const stats = JSON.parse(JSON.stringify(FIX.statsZ11));
  stats.features.push({ attributes: { GNIS_ID: '111', GNIS_NAME: 'Hamilton Ditch', total_km: 99 } });
  const ditch = { attributes: { GNIS_ID: '111', GNIS_NAME: 'Hamilton Ditch', LENGTHKM: 3, FTYPE: 'CanalDitch', FCODE: 33600 },
    geometry: { paths: [[[-114.05, 46.5], [-114.04, 46.51]]] } };
  const { fetchImpl, urls } = service({ stats, reaches: [...FIX.geometryZ11.features, ditch] });
  const res = await fetchStreamNames(Z11, { zoom: 11, fetch: fetchImpl });
  assert.equal(named(res, 'Hamilton Ditch').length, 0);
  for (const u of urls) assert.match(new URL(u).searchParams.get('where'), /FTYPE='StreamRiver'/);
});

test('zoom picks the layer: small-scale below 13, large-scale (lower-case fields, integer ftype) from 13', () => {
  assert.equal(nhdLayerForZoom(8), null);
  assert.equal(nhdLayerForZoom(9).id, 4);
  assert.equal(nhdLayerForZoom(12).id, 4);
  assert.equal(nhdLayerForZoom(13).id, 6);
  const small = new URL(buildStatsUrl(Z11, 11));
  assert.match(small.pathname, /\/nhd\/MapServer\/4\/query$/);
  assert.match(small.searchParams.get('where'), /FTYPE='StreamRiver'/);
  assert.equal(small.searchParams.get('groupByFieldsForStatistics'), 'GNIS_ID,GNIS_NAME');
  const large = new URL(buildStatsUrl(Z11, 13));
  assert.match(large.pathname, /\/nhd\/MapServer\/6\/query$/);
  assert.match(large.searchParams.get('where'), /ftype=460/);
  assert.equal(large.searchParams.get('groupByFieldsForStatistics'), 'gnis_id,gnis_name');
});

test('the request ranks by summed length, never orders by the statistic alias the service rejects', () => {
  const p = new URL(buildStatsUrl(Z11, 11)).searchParams;
  assert.match(p.get('outStatistics'), /"sum"/);
  assert.match(p.get('outStatistics'), /LENGTHKM/);
  assert.equal(p.get('orderByFields'), null);
  assert.equal(p.get('f'), 'json');
  assert.equal(p.get('inSR'), '4326');
});

test('geometry is fetched for the chosen ids only, in lon/lat', () => {
  const p = new URL(buildGeometryUrl(Z11, 11, ['779961', '793338'])).searchParams;
  assert.match(p.get('where'), /GNIS_ID IN \('779961','793338'\)/);
  assert.equal(p.get('returnGeometry'), 'true');
  assert.equal(p.get('outSR'), '4326');
  assert.throws(() => buildGeometryUrl(Z11, 11, ["1' OR 1=1"]), RangeError);
});

test('zoom below the river floor asks nothing and answers empty', async () => {
  let calls = 0;
  const res = await fetchStreamNames(Z9, { zoom: 8, fetch: async () => { calls++; return json({}); } });
  assert.deepEqual(res, { status: 'empty', features: [], omittedKinds: [] });
  assert.equal(calls, 0);
});

test('more names than the per-view top-N: capped, listing the kind that lost names', async () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ attributes: { GNIS_ID: String(900 + i), GNIS_NAME: `Test ${i} River`, total_km: 100 - i } }));
  const { fetchImpl, urls } = service({ stats: { features: rows }, reaches: [] });
  const res = await fetchStreamNames(Z9, { zoom: 9, fetch: fetchImpl });
  assert.equal(res.status, 'capped');
  assert.deepEqual(res.omittedKinds, ['river']);
  const ids = [...new URL(urls[1]).searchParams.get('where').matchAll(/'(\d+)'/g)].map((m) => m[1]);
  assert.equal(ids.length, 6);
  assert.deepEqual(ids, ['900', '901', '902', '903', '904', '905'], 'the longest names are the ones kept');
});

test('a statistics answer cut at the service page limit is capped', async () => {
  const stats = { ...FIX.statsZ11, exceededTransferLimit: true };
  const res = await fetchStreamNames(Z11, { zoom: 11, fetch: service({ stats }).fetchImpl });
  assert.equal(res.status, 'capped');
});

test('failure shapes match fetchJson: HTTP status, ArcGIS error body, timeout, caller abort', async () => {
  const http = await fetchStreamNames(Z11, { zoom: 11, fetch: async () => ({ ok: false, status: 500 }) });
  assert.deepEqual([http.status, http.error], ['error', 'HTTP 500']);
  const body = await fetchStreamNames(Z11, { zoom: 11, fetch: async () => json({ error: { code: 400, message: 'Unable to complete operation.' } }) });
  assert.deepEqual([body.status, body.error], ['error', 'Unable to complete operation.']);
  const hang = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  assert.equal((await fetchStreamNames(Z11, { zoom: 11, fetch: hang, timeoutMs: 10 })).status, 'timeout');
  const ctl = new AbortController();
  const pending = fetchStreamNames(Z11, { zoom: 11, fetch: hang, signal: ctl.signal });
  ctl.abort();
  assert.equal((await pending).status, 'aborted');
});

test('streamKindOf: River and Fork names are rivers, everything else a creek', () => {
  assert.equal(streamKindOf('Bitterroot River'), 'river');
  assert.equal(streamKindOf('Clark Fork'), 'river');
  assert.equal(streamKindOf('East Fork Moose Creek'), 'creek');
  assert.equal(streamKindOf('Willoughby Creek'), 'creek');
});

test('river and creek sit on the priority ladder where the design puts them', () => {
  const t = KINDS.nhd;
  assert.ok(KINDS[5].Ridge.priority < t.River.priority && t.River.priority < KINDS[7].Falls.priority);
  assert.ok(t.Creek.priority < KINDS[6].Stream.priority && t.Creek.priority > KINDS[5].Valley.priority - 1);
  assert.equal(t.River.minZoom, 9);
  assert.equal(t.Creek.minZoom, STREAM_MIN_ZOOM.creek);
  const recs = [{ name: 'a', id: 'x', kind: 'creek', cls: 'Creek', layer: 'nhd' }, { name: 'b', id: 'y', kind: 'river', cls: 'River', layer: 'nhd' },
    { name: 'c', id: 'z', kind: 'ridge', cls: 'Ridge', layer: 5 }];
  assert.deepEqual(labelPriorityOrder(recs, { zoom: 11 }).map((r) => r.kind), ['ridge', 'river', 'creek']);
});

test('the registry entry records the measurement the module relies on', () => {
  const s = SOURCES.nhdFlowlines;
  assert.equal(s.origin, 'https://hydro.nationalmap.gov');
  assert.equal(s.measuredOn, FIX.measuredOn);
  assert.equal(s.limits.maxRecordCount, FIX.measured.maxRecordCount);
  assert.equal(s.cors, 'star');
  assert.deepEqual(s.layers.map((l) => l.id), [4, 6]);
  assert.ok(s.layers.every((l) => l.geometryType === 'esriGeometryPolyline'));
});

// C2: the NHD record and the GNIS stream-mouth record for one stream draw once.
import { mergeStreamNames, STATUS_MESSAGE } from '../../themes/headlessmode/static/js/quiet-corners-maps/name-labels.js';

test('mergeStreamNames drops a GNIS stream mouth an NHD record already names, and nothing else', () => {
  const gnis = [
    { id: 'gnis:1', name: 'Bitterroot River', kind: 'stream-mouth', state: 'MT' },
    { id: 'gnis:2', name: 'Lost Horse Creek', kind: 'stream-mouth', state: 'MT' },
    { id: 'gnis:3', name: 'Bitterroot River', kind: 'place', state: 'MT' },
  ];
  const nhd = [{ id: 'nhd:1', name: 'Bitterroot River', kind: 'river', state: null }];
  const out = mergeStreamNames(gnis, nhd).map((f) => f.id);
  assert.deepEqual(out, ['gnis:2', 'gnis:3', 'nhd:1']);
  assert.deepEqual(mergeStreamNames(gnis, []).map((f) => f.id), ['gnis:1', 'gnis:2', 'gnis:3']);
});

test('the river tier has its own status copy', () => {
  assert.equal(STATUS_MESSAGE.rivers, 'Rivers did not load');
});
