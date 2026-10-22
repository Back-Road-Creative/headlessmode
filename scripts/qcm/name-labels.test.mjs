// Pure screen declutter for named-terrain labels (Q/name-labels.js). No DOM, no
// fetch -- toPx/measureText are supplied by the caller, exactly like print-
// names.js's placeNameLabels on the print side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  placeScreenLabels, dedupeAgainstTownLabels, stripCensusSuffix, isStaleGeneration, namesAdapterPayload,
  DENSITY_CAP, SIZE_SCALE, STATUS_MESSAGE, iconFor, kindFloor,
  countyStateLine, nameCardLines, labelFontSize, measureLabel, LABEL_FONT_FAMILY,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/name-labels.js';
import { normalizeFeature } from '../../themes/headlessmode/static/js/quiet-corners-maps/terrain-names.js';
import { MIXED_KIND_FEATURES } from './fixtures/gnis-names-declutter.mjs';

const VIEWPORT = { width: 800, height: 600 };
const measureText = (text, sizePx) => ({ width: text.length * sizePx * 0.6, height: sizePx * 1.2 });
// Simple equirectangular projection for the test fixtures -- lon/lat spread far
// enough apart that they do not collide with each other by construction, so a
// test that expects a collision passes a reserved box explicitly instead.
const toPx = (lon, lat) => ({ x: (lon + 100) * 40, y: (50 - lat) * 40 });

const feature = (id, name, kind, lon, lat, extra = {}) => ({
  id, name, kind, cls: kind, layer: kind === 'place' ? 3 : 5, historical: false,
  anchor: [lat, lon], state: 'CO', county: 'Test County', pointCount: 1, ...extra,
});

function manyFeatures(n) {
  // Spaced a full degree apart (40px per test's toPx) so features never collide
  // with each other -- a cap/density/priority test should be limited only by
  // the cap or the ordering rule under test, never by incidental overlap.
  const out = [];
  for (let i = 0; i < n; i++) out.push(feature(`gnis:${1000 + i}`, `Peak ${i}`, 'summit', -105 + i * 5, 39));
  return out;
}

test('determinism: same input twice gives the same placed set and order', () => {
  const features = manyFeatures(10);
  const a = placeScreenLabels(features, { toPx, viewport: VIEWPORT, measureText });
  const b = placeScreenLabels(features, { toPx, viewport: VIEWPORT, measureText });
  assert.deepEqual(a.placed.map((p) => p.id), b.placed.map((p) => p.id));
});

test('determinism: a shuffled input gives the same output', () => {
  const features = manyFeatures(10);
  const shuffled = [...features].reverse();
  const a = placeScreenLabels(features, { toPx, viewport: VIEWPORT, measureText });
  const b = placeScreenLabels(shuffled, { toPx, viewport: VIEWPORT, measureText });
  assert.deepEqual(a.placed.map((p) => p.id), b.placed.map((p) => p.id));
});

test('cap and density scaling: sparse < standard < more', () => {
  const features = manyFeatures(80);
  const sparse = placeScreenLabels(features, { toPx, measureText, prefs: { density: 'sparse' } });
  const standard = placeScreenLabels(features, { toPx, measureText, prefs: { density: 'standard' } });
  const more = placeScreenLabels(features, { toPx, measureText, prefs: { density: 'more' } });
  assert.ok(sparse.placed.length <= DENSITY_CAP.sparse);
  assert.ok(standard.placed.length <= DENSITY_CAP.standard);
  assert.ok(more.placed.length <= DENSITY_CAP.more);
  assert.ok(sparse.placed.length < standard.placed.length, 'sparse places fewer than standard');
  assert.ok(standard.placed.length < more.placed.length, 'standard places fewer than more');
  assert.ok(standard.placed.length <= 40, 'the provisional 40 cap holds for standard density');
});

test('hysteresis: a 2px pan does not swap which labels are placed', () => {
  const features = manyFeatures(30);
  const first = placeScreenLabels(features, { toPx, measureText, prefs: { density: 'sparse' } });
  const previous = new Set(first.placed.map((p) => p.id));
  const toPxPanned = (lon, lat) => { const p = toPx(lon, lat); return { x: p.x + 2, y: p.y + 2 }; };
  const second = placeScreenLabels(features, { toPx: toPxPanned, measureText, prefs: { density: 'sparse' }, previous });
  assert.deepEqual(new Set(second.placed.map((p) => p.id)), previous, 'the same set of labels stays placed after a tiny pan');
});

test('selected name is reserved before the general budget', () => {
  const features = manyFeatures(50); // all higher priority than the selected one below
  const selected = feature('gnis:9999', 'Low Priority Water', 'other-water', -104, 40);
  const all = [...features, selected];
  const result = placeScreenLabels(all, {
    toPx, measureText, prefs: { density: 'sparse' }, selectedId: 'gnis:9999',
  });
  assert.ok(result.placed.some((p) => p.id === 'gnis:9999'), 'the selected feature is placed even though its priority is worst');
  assert.equal(result.placed[0].id, 'gnis:9999', 'the selected feature is placed first');
});

test('collision with a reserved town-label box drops the overlapping name', () => {
  const p = toPx(-105, 39);
  const reserved = [{ minX: p.x - 200, maxX: p.x + 200, minY: p.y - 200, maxY: p.y + 200 }];
  const features = [feature('gnis:1', 'Blocked Peak', 'summit', -105, 39)];
  const result = placeScreenLabels(features, { toPx, viewport: VIEWPORT, measureText, reserved });
  assert.equal(result.placed.length, 0, 'every candidate offset collided with the reserved box');
  assert.equal(result.dropped, 1);
});

test('dedupeAgainstTownLabels removes a GNIS feature sharing a town label\'s name and state', () => {
  const features = [
    feature('gnis:1', 'Springfield', 'place', -105, 39, { state: 'CO' }),
    feature('gnis:2', 'Unique Peak', 'summit', -104, 40, { state: 'CO' }),
  ];
  const townLabels = [{ name: 'Springfield', state: 'CO' }];
  const deduped = dedupeAgainstTownLabels(features, townLabels);
  assert.deepEqual(deduped.map((f) => f.id), ['gnis:2']);
});

test('dedupeAgainstTownLabels normalizes a Census legal-suffix town name against a bare GNIS name, per state', () => {
  const features = [
    feature('gnis:1', 'Ashland', 'place', -85.83, 33.27, { state: 'AL' }),
    feature('gnis:2', 'Ashland', 'place', -122.7, 42.19, { state: 'OR' }),
    feature('gnis:3', 'New York', 'place', -73.94, 40.66, { state: 'NY' }),
  ];
  const townLabels = [
    { name: 'Ashland town', state: 'AL' }, // candidates.json's raw Census name
    { name: 'New York', state: 'NY' }, // navigation-places.json's display_name, no suffix to strip
  ];
  const deduped = dedupeAgainstTownLabels(features, townLabels);
  assert.deepEqual(deduped.map((f) => f.id), ['gnis:2'],
    'the AL and NY GNIS features drop (name+state match after normalization); the OR one is a different state and stays');
});

test('dedupeAgainstTownLabels compares names case-insensitively once the suffix is stripped', () => {
  const features = [feature('gnis:1', 'ASHLAND', 'place', -85.83, 33.27, { state: 'AL' })];
  const townLabels = [{ name: 'Ashland town', state: 'AL' }];
  const deduped = dedupeAgainstTownLabels(features, townLabels);
  assert.deepEqual(deduped, [], 'a case difference alone should not save a GNIS feature from the dedupe');
});

test('stripCensusSuffix: trailing Census designators strip, everything else is left alone', () => {
  assert.equal(stripCensusSuffix('Ashland town'), 'Ashland');
  assert.equal(stripCensusSuffix('Ashland city'), 'Ashland');
  assert.equal(stripCensusSuffix('Ashland village'), 'Ashland');
  assert.equal(stripCensusSuffix('Ashland borough'), 'Ashland');
  assert.equal(stripCensusSuffix('Anytown municipality'), 'Anytown');
  assert.equal(stripCensusSuffix('Ruidoso CDP'), 'Ruidoso');
  // Longest-match-first: the shorter " borough" suffix must not fire and leave
  // "Juneau city and" behind.
  assert.equal(stripCensusSuffix('Juneau city and borough'), 'Juneau');
  // Case-sensitive: a capitalized "City" is a real part of the name, not the
  // lowercase Census suffix, so Nevada's consolidated city-county is untouched.
  assert.equal(stripCensusSuffix('Carson City'), 'Carson City');
  // A lowercase "cdp" is not the exact Census token and is left alone too.
  assert.equal(stripCensusSuffix('Ruidoso cdp'), 'Ruidoso cdp');
  // No trailing designator at all.
  assert.equal(stripCensusSuffix('Ashland'), 'Ashland');
});

test('over-cap and partial statuses place nothing and carry a distinct message', () => {
  const features = manyFeatures(5);
  for (const status of ['over-cap', 'partial', 'timeout', 'error']) {
    const result = placeScreenLabels(features, { toPx, viewport: VIEWPORT, measureText, status });
    assert.equal(result.placed.length, 0, `${status} places no labels`);
    assert.equal(result.message, STATUS_MESSAGE[status]);
  }
  // 'ready' with zero features gets its own distinct message too.
  const zero = placeScreenLabels([], { toPx, viewport: VIEWPORT, measureText, status: 'ready' });
  assert.equal(zero.placed.length, 0);
  assert.equal(zero.message, STATUS_MESSAGE.zero);
});

test('isStaleGeneration: a response is stale exactly when a newer fetch has since started', () => {
  assert.equal(isStaleGeneration(1, 1), false);
  assert.equal(isStaleGeneration(1, 2), true);
});

test('namesAdapterPayload builds the {status, features, retrievedAt} transport shape', () => {
  const result = { status: 'ready', features: [feature('gnis:1', 'X', 'summit', -105, 39)] };
  const payload = namesAdapterPayload(result, '2026-09-26T00:00:00.000Z');
  assert.deepEqual(payload, { status: 'ready', features: result.features, retrievedAt: '2026-09-26T00:00:00.000Z' });
  assert.equal(namesAdapterPayload(null, '2026-09-26T00:00:00.000Z'), null);
  const overCap = namesAdapterPayload({ status: 'over-cap', count: 5000 }, '2026-09-26T00:00:00.000Z');
  assert.deepEqual(overCap, { status: 'over-cap', features: [], retrievedAt: '2026-09-26T00:00:00.000Z' });
});

test('iconFor falls back to the "other" icon for an unknown kind', () => {
  assert.equal(iconFor('summit').marker, 'triangle');
  assert.equal(iconFor('nonsense-kind').marker, 'diamond');
});

test('kindFloor: shrinks as more kinds compete, never below 1', () => {
  assert.equal(kindFloor(40, 2), 10, 'two kinds share the standard cap 40/2/2');
  assert.equal(kindFloor(15, 1), 7, 'one kind gets half the sparse cap');
  assert.equal(kindFloor(40, 50), 1, 'never drops below a floor of 1');
});

test('kind budget: a dominant place count does not crowd every summit out of the cap', () => {
  // MIXED_KIND_FEATURES is raw Esri-shaped (gnis-names-declutter.mjs fixture);
  // normalizeFeature (terrain-names.js) is the same conversion production code
  // runs before a feature ever reaches placeScreenLabels. Layer 3 = Populated
  // Place, layer 5 = Summit (terrain-names.js's KINDS table).
  const features = MIXED_KIND_FEATURES
    .map((f) => normalizeFeature(f.attributes.gaz_featureclass === 'Populated Place' ? 3 : 5, f))
    .filter(Boolean);
  assert.equal(features.length, 45, 'fixture sanity: 35 places + 10 summits');
  const result = placeScreenLabels(features, { toPx, measureText, prefs: { density: 'standard' } });
  const summitIds = result.placed.filter((p) => p.kind === 'summit').map((p) => p.id);
  assert.equal(summitIds.length, 10, 'all 10 summits keep a slot beside the 35 places');
  assert.equal(result.placed.length, DENSITY_CAP.standard, 'the cap still holds at 40 total');
});

test('prefs.size === "large" reaches the placed labels\' size, not the hardcoded normal', () => {
  const features = manyFeatures(5);
  const result = placeScreenLabels(features, { toPx, measureText, prefs: { size: 'large' } });
  assert.ok(result.placed.length > 0);
  for (const p of result.placed) assert.equal(p.sizePx, SIZE_SCALE.large);
});

// QUX-05c: one field-list builder for the one details card, shared by the map-pin
// declutter loop and the search-selection path -- see Q/main.js and
// S/quiet-corners.js's selectNameHit. Neither missing field is ever silently
// dropped or left blank.
test('countyStateLine never returns blank text, in every combination of missing fields', () => {
  assert.equal(countyStateLine('Routt', 'CO'), 'Routt, CO');
  assert.equal(countyStateLine('Routt', null), 'Routt, state not published');
  assert.equal(countyStateLine(null, 'CO'), 'county not published, CO');
  assert.equal(countyStateLine(null, null), 'County and state not published');
});

test('nameCardLines builds the one field list both selection paths share', () => {
  const lines = nameCardLines('Cold Mountain', 'Named summit', 'Haywood', 'NC', [35.4132, -82.9987]);
  assert.deepEqual(lines, [
    'Cold Mountain', 'Named summit', 'Haywood, NC', 'Source: USGS GNIS',
    'Coordinates: 35.4132, -82.9987',
    'Location is the published primary point, not every place this name is used.',
  ]);
});

test('nameCardLines never drops the county/state line when both are missing', () => {
  const lines = nameCardLines('Mystery Peak', 'Named summit', null, null, [40, -105]);
  assert.equal(lines.length, 6, 'no line is silently omitted when county/state are both null');
  assert.equal(lines[2], 'County and state not published');
});

// QQA-05a: the three sizes are 14 / 18 / 24 px. 14 is 0.875rem, the CSS default of
// every owned label, so Normal draws exactly what the stylesheet falls back to.
test('SIZE_SCALE is 14 / 18 / 24 and Extra large reaches the placed labels', () => {
  assert.deepEqual({ ...SIZE_SCALE }, { normal: 14, large: 18, xlarge: 24 });
  const result = placeScreenLabels(manyFeatures(5), { toPx, measureText, prefs: { size: 'xlarge' } });
  assert.ok(result.placed.length > 0);
  for (const p of result.placed) assert.equal(p.sizePx, 24);
});

test('labelFontSize turns a size pref into the rem string the --qc-label-px property carries', () => {
  assert.equal(labelFontSize('normal'), '0.875rem');
  assert.equal(labelFontSize('large'), '1.125rem');
  assert.equal(labelFontSize('xlarge'), '1.5rem');
  assert.equal(labelFontSize('huge'), '0.875rem', 'an unknown size falls back to normal, as placeScreenLabels does');
  assert.equal(labelFontSize(undefined), '0.875rem');
});

// The layout box has to be the box the CSS paints: same weight, same sans stack,
// plus the plate's 5px side padding and 1px top/bottom padding.
test('measureLabel measures the font string the stylesheet draws, plate included', () => {
  const fonts = [];
  const ctx = { set font(v) { fonts.push(v); }, measureText: (t) => ({ width: t.length * 7 }) };
  const box = measureLabel(ctx, 'Sylva', 18);
  assert.equal(fonts.at(-1), `600 18px ${LABEL_FONT_FAMILY}`);
  assert.ok(!/monospace/.test(LABEL_FONT_FAMILY) && /sans-serif/.test(LABEL_FONT_FAMILY));
  assert.equal(box.width, 5 * 7 + 10, 'text width + 5px plate padding each side');
  assert.equal(box.height, 18 * 1.2 + 2, 'line box + 1px plate padding top and bottom');
});

test('capped status places labels and carries an honest message built from omittedKinds', () => {
  const features = [feature('gnis:1', 'Stevensville', 'place', -90, 40), feature('gnis:2', 'Lone Rock', 'summit', -85, 42)];
  const result = placeScreenLabels(features, {
    toPx, viewport: VIEWPORT, measureText, status: 'capped', omittedKinds: ['water-feature', 'stream-mouth'],
  });
  assert.equal(result.placed.length, 2);
  assert.match(STATUS_MESSAGE.capped, /zoom in/);
  assert.match(result.message, /places and peaks/);
  assert.match(result.message, /zoom in for/);
  assert.match(result.message, /creeks/);
  assert.match(result.message, /lakes/);
});

test('namesAdapterPayload keeps a capped answer\'s features', () => {
  const result = { status: 'capped', features: [feature('gnis:1', 'X', 'place', -114, 46)], omittedKinds: ['stream-mouth'] };
  assert.deepEqual(namesAdapterPayload(result, 't'), { status: 'capped', features: result.features, retrievedAt: 't' });
});
