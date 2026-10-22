// terrain-names.js: KINDS vocabulary, normalizeFeature, labelPriorityOrder. Pure
// module, fixtures only, no network. Run: node --test scripts/qcm/terrain-names.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KINDS, normalizeFeature, labelPriorityOrder, kindsForZoom, namesPlanForView } from '../../themes/headlessmode/static/js/quiet-corners-maps/terrain-names.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8'));
const FETCH_P1 = fixture('geonames-fetch-p1.min.json');
const FETCH_P2 = fixture('geonames-fetch-p2.min.json');
const COLD_MOUNTAIN = fixture('geonames-search-coldmountain.min.json');
const APOSTROPHE = fixture('geonames-search-apostrophe.min.json');
const DIACRITIC = fixture('geonames-search-diacritic.min.json');
const LAYER7_POINT = fixture('geonames-layer7-point.min.json');

test('KINDS documents a priority ladder: place < summit < gap < ridge/range < water feature < other < stream mouth', () => {
  assert.equal(KINDS[3]['Populated Place'].priority, 1);
  assert.equal(KINDS[5].Summit.priority, 2);
  assert.equal(KINDS[5].Gap.priority, 3);
  assert.equal(KINDS[5].Ridge.priority, 4);
  assert.equal(KINDS[5].Range.priority, 4);
  assert.equal(KINDS[7].Falls.priority, 5);
  assert.equal(KINDS[7].Spring.priority, 5);
  assert.equal(KINDS[7].Lake.priority, 5);
  assert.equal(KINDS[5].Valley.priority, 6);
  assert.equal(KINDS[5].Cliff.priority, 6);
  assert.equal(KINDS[6].Stream.priority, 7);
  assert.equal(KINDS[6].Canal.priority, 7);
  // stream mouth is strictly last
  const all = [KINDS[3]['Populated Place'], KINDS[5].Summit, KINDS[5].Gap, KINDS[5].Ridge,
    KINDS[7].Falls, KINDS[5].Valley, KINDS[6].Stream];
  for (const k of all.slice(0, -1)) assert.ok(k.priority < KINDS[6].Stream.priority);
});

test('KINDS gives place/summit/gap the lowest minZoom, and pushes minor kinds to z12+', () => {
  assert.ok(KINDS[3]['Populated Place'].minZoom <= 9);
  assert.ok(KINDS[5].Summit.minZoom <= 9);
  assert.ok(KINDS[5].Gap.minZoom <= 10);
  assert.ok(KINDS[5].Valley.minZoom >= 12);
  assert.ok(KINDS[6].Stream.minZoom >= 12);
});

test('normalizeFeature: multipoint Summit anchors on its first point, pointCount 1', () => {
  const f = normalizeFeature(5, FETCH_P1.features[0]);
  assert.deepEqual(f, {
    id: 'gnis:985967', name: 'Grassy Knob', kind: 'summit', cls: 'Summit',
    state: 'NC', county: 'Buncombe', anchor: [35.696216699500702, -82.742913199316973],
    pointCount: 1, layer: 5, historical: false,
  });
});

test('normalizeFeature: a multipoint Valley keeps the FIRST point as anchor and records pointCount 2', () => {
  const f = normalizeFeature(5, FETCH_P1.features[1]);
  assert.equal(f.name, 'Green Valley');
  assert.equal(f.kind, 'other-land');
  assert.deepEqual(f.anchor, [35.632466291061633, -82.729287022183115]);
  assert.equal(f.pointCount, 2);
});

test('normalizeFeature: stable id is gnis:<gaz_id>', () => {
  const f = normalizeFeature(5, FETCH_P1.features[2]);
  assert.equal(f.id, 'gnis:986371');
});

test('normalizeFeature: esriGeometryPoint (layer 7) anchors on x/y, pointCount 1', () => {
  const f = normalizeFeature(7, LAYER7_POINT.features[0]);
  assert.equal(f.kind, 'water-feature');
  assert.deepEqual(f.anchor, [35.263, -82.771]);
  assert.equal(f.pointCount, 1);
});

test('normalizeFeature: a feature missing geometry entirely normalizes to null (page 2 of a real fetch drops it)', () => {
  for (const raw of FETCH_P2.features) {
    assert.equal(normalizeFeature(5, raw), null, JSON.stringify(raw));
  }
});

test('normalizeFeature: missing attributes, missing gaz_id, or a non-object payload never throw and return null', () => {
  assert.equal(normalizeFeature(5, null), null);
  assert.equal(normalizeFeature(5, {}), null);
  assert.equal(normalizeFeature(5, { attributes: {} }), null);
  assert.equal(normalizeFeature(5, { attributes: { gaz_name: 'x' }, geometry: { points: [[1, 2]] } }), null);
  assert.equal(normalizeFeature(99, FETCH_P1.features[0]), null, 'unknown layer id');
});

test('normalizeFeature: a known layer with an unmapped class normalizes to kind "other", not null', () => {
  const f = normalizeFeature(5, { attributes: { gaz_id: 1, gaz_name: 'Mystery Thing', gaz_featureclass: 'NotARealClass' }, geometry: { points: [[-82, 35]] } });
  assert.ok(f);
  assert.equal(f.kind, 'other');
});

test('normalizeFeature: apostrophe and diacritic names round-trip verbatim, no HTML stripped that was not there', () => {
  // The measured search probes (geonames-search-apostrophe/diacritic.min.json)
  // carry no `geometry` on their rows -- a name search response, not a bounded
  // fetch -- so a point is added here to exercise normalizeFeature's name
  // handling specifically; anchor/pointCount are covered by the fetch-p1 tests.
  const withGeometry = (raw) => ({ ...raw, geometry: { points: [[-82, 35]] } });
  const oneal = normalizeFeature(5, withGeometry(APOSTROPHE.features[0]));
  assert.equal(oneal.name, "O'Neal Hollow");
  const canada = normalizeFeature(5, withGeometry(DIACRITIC.features[0]));
  assert.equal(canada.name, 'Cañada Atravesada Canyon');
});

test('normalizeFeature: a name carrying markup has angle brackets stripped, never rendered as a tag', () => {
  const f = normalizeFeature(5, { attributes: { gaz_id: 2, gaz_name: '<img onerror=alert(1)>Ridge', gaz_featureclass: 'Ridge' }, geometry: { points: [[-82, 35]] } });
  assert.equal(f.name, 'img onerror=alert(1)Ridge');
});

test('normalizeFeature: the real duplicate-gaz_id rows from a county-straddling search stay separate normalized records (dedupe is the adapter\'s job, not this function\'s)', () => {
  const normalized = COLD_MOUNTAIN.features.map((f) => normalizeFeature(5, f));
  assert.equal(normalized.length, 5);
  assert.ok(normalized.every(Boolean));
  const ids = normalized.map((f) => f.id);
  assert.deepEqual(ids, ['gnis:1010379', 'gnis:1010379', 'gnis:1019725', 'gnis:1019725', 'gnis:1010378']);
});

test('labelPriorityOrder: selected first, then priority, then name, then id -- deterministic regardless of input order', () => {
  const features = [
    { id: 'gnis:2', name: 'Zeta Gap', kind: 'gap', cls: 'Gap', layer: 5 },
    { id: 'gnis:1', name: 'Alpha Gap', kind: 'gap', cls: 'Gap', layer: 5 },
    { id: 'gnis:3', name: 'Only Place', kind: 'place', cls: 'Populated Place', layer: 3 },
    { id: 'gnis:4', name: 'A Stream', kind: 'stream-mouth', cls: 'Stream', layer: 6 },
  ];
  const order = labelPriorityOrder(features);
  assert.deepEqual(order.map((f) => f.id), ['gnis:3', 'gnis:1', 'gnis:2', 'gnis:4']);
  // Reversed input, same result: order does not depend on input order.
  const reversed = labelPriorityOrder([...features].reverse());
  assert.deepEqual(reversed.map((f) => f.id), order.map((f) => f.id));
});

test('labelPriorityOrder: a selectedId always sorts first, ahead of higher priority', () => {
  const features = [
    { id: 'gnis:1', name: 'A Place', kind: 'place', cls: 'Populated Place', layer: 3 },
    { id: 'gnis:2', name: 'B Valley', kind: 'other-land', cls: 'Valley', layer: 5 },
  ];
  const order = labelPriorityOrder(features, { selectedId: 'gnis:2' });
  assert.deepEqual(order.map((f) => f.id), ['gnis:2', 'gnis:1']);
});

test('labelPriorityOrder: zoom drops features below their kind\'s minZoom rather than merely re-ordering them', () => {
  const features = [
    { id: 'gnis:1', name: 'A Place', kind: 'place', cls: 'Populated Place', layer: 3 },
    { id: 'gnis:2', name: 'B Stream', kind: 'stream-mouth', cls: 'Stream', layer: 6 },
  ];
  const atFieldZoom = labelPriorityOrder(features, { zoom: 9 });
  assert.deepEqual(atFieldZoom.map((f) => f.id), ['gnis:1']);
  const atDetailZoom = labelPriorityOrder(features, { zoom: 13 });
  assert.deepEqual(atDetailZoom.map((f) => f.id), ['gnis:1', 'gnis:2']);
});

test('labelPriorityOrder: nullish entries are dropped, never sorted', () => {
  const order = labelPriorityOrder([null, undefined, { id: 'gnis:1', name: 'A', kind: 'place', cls: 'Populated Place', layer: 3 }]);
  assert.equal(order.length, 1);
});

test('kindsForZoom derives from KINDS minZoom: nothing below 8, places+summits at 9, everything at 13', () => {
  assert.deepEqual(kindsForZoom(7), []);
  assert.deepEqual(kindsForZoom(8), ['Populated Place']);
  assert.deepEqual(kindsForZoom(9), ['Populated Place', 'Summit']);
  const all = Object.entries(KINDS).filter(([layer]) => /^\d+$/.test(layer)).flatMap(([, t]) => Object.keys(t)); // GNIS layers only: the nhd table is read by source-stream-names.js
  assert.deepEqual([...kindsForZoom(13)].sort(), [...all].sort());
});

test('namesPlanForView never yields an empty kind list at z8 or above and has no area refusal', () => {
  const huge = { minLon: -125, minLat: 25, maxLon: -66, maxLat: 49 };
  for (let z = 8; z <= 18; z += 1) {
    const plan = namesPlanForView({ zoom: z, bbox: huge });
    assert.ok(plan.kinds.length > 0, `z${z}`);
    assert.equal(plan.budget, 1500);
  }
  assert.deepEqual(namesPlanForView({ zoom: 7, bbox: huge }).kinds, []);
});
