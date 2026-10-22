// State land boundaries. Nothing here touches the network: the fetch seam is
// injected, so what is tested is the query this module BUILDS and the shape it
// returns — which is where every defect in this layer has come from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAMILY_SYMBOL, FAMILY_LABEL, queryUrl, isUsable, usableFamilies, nameOf,
  normalizeBoundary, fetchLandBoundaries, LAND_COVERAGE_SEMANTICS,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-land-boundaries.js';
import { layerFor, whereFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/state-sources.js';
import { canBuild } from '../../themes/headlessmode/static/js/quiet-corners-maps/app-state.js';
import { SYMBOL_BY_KEY } from '../../themes/headlessmode/static/js/quiet-corners-maps/legend.js';

const bbox = { minLon: -83.6, minLat: 35.0, maxLon: -83.4, maxLat: 35.125 };

/** A fetch that records the request and answers with the given ArcGIS payload. */
function stubFetch(payload, { ok = true, status = 200 } = {}) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, body: new URLSearchParams(opts.body) });
    return { ok, status, json: async () => payload };
  };
  return { impl, calls };
}
const ring = (n = 4) => Array.from({ length: n }, (_, i) => [-83.5 + i * 0.001, 35.05 + i * 0.001]);

test('every family draws with a symbol the legend actually defines', () => {
  for (const [family, key] of Object.entries(FAMILY_SYMBOL)) {
    assert.ok(SYMBOL_BY_KEY[key], `${family} draws with ${key}, which is not in the legend`);
    assert.ok(FAMILY_LABEL[family], `${family} has no label`);
  }
});

// The catalogue is not uniform and cannot be: NC's url already ends in
// /FeatureServer/21 while AZ's ends in /FeatureServer with layerId 0. Appending
// the id unconditionally asks NC for layer 21 of layer 21.
test('the query url appends the layer id only when the url does not already carry it', () => {
  assert.equal(queryUrl({ url: 'https://x/FeatureServer/21', layerId: 21 }), 'https://x/FeatureServer/21/query');
  assert.equal(queryUrl({ url: 'https://x/FeatureServer', layerId: 0 }), 'https://x/FeatureServer/0/query');
  assert.equal(queryUrl({ url: 'https://x/FeatureServer/', layerId: 4 }), 'https://x/FeatureServer/4/query');
  assert.equal(queryUrl({ url: 'https://x/MapServer', layerId: undefined }), 'https://x/MapServer/0/query');
  assert.equal(queryUrl(null), null);
});

test('the real catalogue entries produce a query url ending in exactly one layer id', () => {
  for (const state of ['NC', 'AZ', 'SC', 'CO']) {
    const url = queryUrl(layerFor(state, 'gameLands'));
    assert.match(url, /\/\d+\/query$/, `${state}: ${url}`);
    assert.ok(!/\/\d+\/\d+\/query$/.test(url), `${state} doubled its layer id: ${url}`);
  }
});

// Arizona's game lands are hunt units — administrative boundaries covering the
// whole state. Drawn as a land boundary that line means nothing on the ground.
test('a semantically divergent state is not usable even though it is fetchable', () => {
  assert.equal(isUsable(layerFor('AZ', 'gameLands')), false, 'Arizona publishes hunt units');
  assert.equal(isUsable(layerFor('NC', 'gameLands')), true);
  assert.ok(!usableFamilies('AZ').includes('gameLands'));
  assert.ok(usableFamilies('NC').includes('gameLands'));
});

test('rings become paths, because a ring is a closed polyline and a boundary is a stroke', () => {
  const f = normalizeBoundary({ attributes: { OBJECTID: 7 }, geometry: { rings: [ring(), ring(3)] } }, 'gameLands');
  assert.equal(f.symbolKey, 'land-game');
  assert.equal(f.paths.length, 2);
  assert.deepEqual(f.paths[0][0], [-83.5, 35.05], 'still [lon, lat]; the swap belongs to the preview');
});

test('a degenerate ring is dropped rather than drawn as a spike', () => {
  const f = normalizeBoundary({ attributes: {}, geometry: { rings: [[[1, 2]], ring()] } }, 'stateParks');
  assert.equal(f.paths.length, 1);
  assert.equal(normalizeBoundary({ attributes: {} }, 'stateParks').paths.length, 0, 'no geometry at all');
});

test('the display name is read through the catalogue field map, not a guessed key', () => {
  const layer = { fields: { propertyName: 'PropName' } };
  assert.equal(nameOf({ PropName: ' Cheoah  ' }, layer), 'Cheoah');
  assert.equal(nameOf({ PropName: '' }, layer), null, 'blank is not a name');
  assert.equal(nameOf({ SomethingElse: 'x' }, layer), null);
  assert.equal(nameOf({}, null), null);
});

// Several states publish wildlife areas inside a general public-lands layer.
// Vermont answers 93 features where one is a WMA; the clause is what makes the
// difference, so it must reach the wire.
test('the WHERE clause from the catalogue is sent, not dropped', async () => {
  const { impl, calls } = stubFetch({ features: [] });
  await fetchLandBoundaries({ state: 'VT', family: 'gameLands', bboxLonLat: bbox, fetchImpl: impl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.get('where'), whereFor(layerFor('VT', 'gameLands')));
  assert.notEqual(calls[0].body.get('where'), '1=1', 'Vermont needs its filter');
});

test("a state needing no filter sends '1=1' rather than an empty where", async () => {
  const { impl, calls } = stubFetch({ features: [] });
  await fetchLandBoundaries({ state: 'NC', family: 'gameLands', bboxLonLat: bbox, fetchImpl: impl });
  assert.equal(calls[0].body.get('where'), '1=1');
  assert.equal(calls[0].body.get('outSR'), '4326', 'lon/lat out, so no reprojection here');
  assert.equal(calls[0].body.get('returnGeometry'), 'true');
});

test('a personal field is never requested, whatever the catalogue lists', async () => {
  const { impl, calls } = stubFetch({ features: [] });
  await fetchLandBoundaries({ state: 'NC', family: 'parcels', bboxLonLat: bbox, fetchImpl: impl });
  const asked = (calls[0]?.body.get('outFields') || '').split(',');
  for (const refused of layerFor('NC', 'parcels').ownerFields || []) {
    assert.ok(!asked.includes(refused), `asked for the personal field ${refused}`);
  }
});

test('an unreadable or divergent state is skipped with a reason, not thrown at', async () => {
  const { impl, calls } = stubFetch({ features: [] });
  const az = await fetchLandBoundaries({ state: 'AZ', family: 'gameLands', bboxLonLat: bbox, fetchImpl: impl });
  assert.deepEqual(az.features, []);
  assert.match(az.skipped, /different kind of area/);
  const none = await fetchLandBoundaries({ state: 'ZZ', family: 'gameLands', bboxLonLat: bbox, fetchImpl: impl });
  assert.match(none.skipped, /no gameLands record/);
  assert.equal(calls.length, 0, 'a skipped state costs no request');
});

test('a refusing service is an error naming the state and the family', async () => {
  const { impl } = stubFetch({}, { ok: false, status: 503 });
  await assert.rejects(
    () => fetchLandBoundaries({ state: 'NC', family: 'gameLands', bboxLonLat: bbox, fetchImpl: impl }),
    (e) => e.message.includes('503') && e.message.includes('NC'),
  );
  const { impl: errImpl } = stubFetch({ error: { message: 'Invalid field: nope' } });
  await assert.rejects(
    () => fetchLandBoundaries({ state: 'NC', family: 'gameLands', bboxLonLat: bbox, fetchImpl: errImpl }),
    (e) => e.message.includes('Invalid field'),
  );
});

test('features with geometry come back normalized and dated', async () => {
  const { impl } = stubFetch({ features: [
    { attributes: { OBJECTID: 1 }, geometry: { rings: [ring()] } },
    { attributes: { OBJECTID: 2 }, geometry: {} },
  ] });
  const out = await fetchLandBoundaries({ state: 'NC', family: 'gameLands', bboxLonLat: bbox, fetchImpl: impl });
  assert.equal(out.features.length, 1, 'the geometryless one is dropped');
  assert.equal(out.features[0].symbolKey, 'land-game');
  assert.equal(out.skipped, null);
  assert.ok(Date.parse(out.retrievedAt) > 0);
});

test('the coverage wording refuses to turn a boundary into a claim about access', () => {
  assert.match(LAND_COVERAGE_SEMANTICS, /not a statement that the ground/i);
  assert.match(LAND_COVERAGE_SEMANTICS, /not the same as/i);
});

// --- paging ---------------------------------------------------------------
// One query returns ONE page and says so in exceededTransferLimit. Reading only
// the first page is how a boundary goes missing from paper with nothing said.

/** A fetch answering a sequence of payloads, one per page. */
function stubPages(pages) {
  const calls = [];
  const impl = async (url, opts) => {
    const body = new URLSearchParams(opts.body);
    calls.push({ url, body, offset: Number(body.get('resultOffset')) });
    return { ok: true, status: 200, json: async () => pages[Math.min(calls.length - 1, pages.length - 1)] };
  };
  return { impl, calls };
}
const feat = (id) => ({ attributes: { OBJECTID: id }, geometry: { rings: [ring()] } });
const page = (ids, more) => ({ features: ids.map(feat), exceededTransferLimit: more });

test('a flagged partial page is followed, and the offset advances by what was received', async () => {
  const { impl, calls } = stubPages([page([1, 2], true), page([3, 4], true), page([5], false)]);
  const r = await fetchLandBoundaries({ state: 'NC', family: 'gameLands', bboxLonLat: bbox, fetchImpl: impl, pageSize: 2 });
  assert.equal(calls.length, 3, 'it kept asking while the service said there was more');
  assert.deepEqual(calls.map((c) => c.offset), [0, 2, 4], 'offset follows the count received, not the page number');
  assert.equal(calls[0].body.get('resultRecordCount'), '2');
  assert.equal(r.features.length, 5);
  assert.equal(r.coverage, 'complete', 'the service stopped flagging more, so the set is whole');
  assert.equal(r.pages, 3);
});

test('one unflagged page is complete and asks once — the common case is not made slower', async () => {
  const { impl, calls } = stubPages([page([1, 2], false)]);
  const r = await fetchLandBoundaries({ state: 'NC', family: 'gameLands', bboxLonLat: bbox, fetchImpl: impl });
  assert.equal(calls.length, 1);
  assert.equal(r.coverage, 'complete');
});

test('a service that ignores resultOffset is called partial, not looped on', async () => {
  // Same page, forever, still flagged as having more: the shape of a service
  // that does not honour paging. Repeats are dropped by id.
  const { impl, calls } = stubPages([page([1, 2], true)]);
  const r = await fetchLandBoundaries({ state: 'NC', family: 'gameLands', bboxLonLat: bbox, fetchImpl: impl });
  assert.equal(calls.length, 2, 'it stops as soon as a page adds nothing new');
  assert.equal(r.features.length, 2, 'and never counts the same boundary twice');
  assert.equal(r.coverage, 'partial');
});

test('a set the loop could not finish is partial, and canBuild refuses to print it', async () => {
  const { impl } = stubPages([page([1], true)]);   // always more, always new ids? no: same id -> partial
  const r = await fetchLandBoundaries({ state: 'NC', family: 'gameLands', bboxLonLat: bbox, fetchImpl: impl });
  assert.equal(r.coverage, 'partial');
  const gate = canBuild({ states: { usgsTopo: 'ready', gameLands: 'partial' }, layers: { usgsTopo: true, gameLands: true }, areaStates: ['NC'] });
  assert.equal(gate.ok, false, 'a truncated boundary set must never reach paper');
});

test('a skipped state reports coverage too, so a caller never reads undefined', async () => {
  const { impl } = stubPages([page([], false)]);
  const az = await fetchLandBoundaries({ state: 'AZ', family: 'gameLands', bboxLonLat: bbox, fetchImpl: impl });
  assert.equal(az.coverage, 'unavailable');
  assert.equal(az.pages, 0);
});
