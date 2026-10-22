// Tests for the pure page-pixel overlay module: lon/lat MVUM paths -> clipped per-sheet vectors + legend keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planSheets } from '../../themes/headlessmode/static/js/quiet-corners-maps/sheet-plan.js';
import { projectBbox, inverse } from '../../themes/headlessmode/static/js/quiet-corners-maps/geometry.js';
import { normalizeFeature } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-mvum.js';
import { STYLE, pagePxForSheet, clipPathToRect, vectorsForSheet, labelCandidates } from '../../themes/headlessmode/static/js/quiet-corners-maps/overlay-paths.js';

const utm = { zone: 17, hemisphere: 'N' };
const plan = planSheets({ paper: 'letter', orientation: 'portrait', scale: 24000, overlapIn: 0.5, dpi: 300, title: 'Standing Indian',
  extent: projectBbox({ minLon: -83.55, minLat: 35.0, maxLon: -83.4, maxLat: 35.1 }, 17, 'N'), ...utm });
const A1 = plan.sheets[0];
const { width: W, height: H } = A1.pixel;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
// lon/lat of a page-pixel point on A1, so synthetic features can be placed exactly.
const lonLatAt = (x, y) => { const e = A1.extent, p = inverse(e.minX + x * A1.metersPerPixel, e.maxY - y * A1.metersPerPixel, 17, 'N'); return [p.lon, p.lat]; };
const road = (id, pts, seasonal = 'seasonal') => ({ id, layer: 'road', seasonal, paths: [pts.map(([x, y]) => lonLatAt(x, y))] });

test('pagePxForSheet maps A1 extent corners to (0,0) and (w,h)', () => {
  const toPx = pagePxForSheet(A1, 17, 'N');
  const e = A1.extent, tl = inverse(e.minX, e.maxY, 17, 'N'), br = inverse(e.maxX, e.minY, 17, 'N');
  const a = toPx(tl.lon, tl.lat), b = toPx(br.lon, br.lat);
  near(a.x, 0, 1e-6, 'tl.x'); near(a.y, 0, 1e-6, 'tl.y'); near(b.x, W, 1e-6, 'br.x'); near(b.y, H, 1e-6, 'br.y');
  assert.deepEqual([plan.count, W, H], [9, 2400, 2850]);
});

test('vectorsForSheet: crossing road -> one dashed vector; outside dropped; edge crossing clipped; keys only from emitted', () => {
  const across = road('1', [[100, 100], [W - 100, H - 100]]);
  const r = vectorsForSheet([across], A1, { ...utm });
  assert.deepEqual([r.vectors.length, r.dropped, [...r.symbolKeys]], [1, 0, ['mvum-road-seasonal']]);
  const v = r.vectors[0];
  assert.deepEqual([v.key, v.pattern, v.widthPx, v.color, v.path.length], ['mvum-road-seasonal', 'dash', 5, STYLE['mvum-road-seasonal'].color, 2]);
  near(v.path[0][0], 100, 1e-6, 'x0'); near(v.path[1][1], H - 100, 1e-6, 'y1');
  // 1e-6, not 1e-12: widths now go through legend.js's unit helpers, which round at
  // the boundary so 12/300 * 300 cannot arrive as 12.000000000000002. A width is a
  // physical length in inches; six decimal places of an inch is 25 nanometres.
  near(vectorsForSheet([across], A1, { ...utm, dpi: 200 }).vectors[0].widthPx, 10 / 3, 1e-6, 'width at 200 dpi');
  const outside = road('2', [[W + 500, 100], [W + 900, 300]]);
  const edge = road('3', [[W - 200, 200], [W + 400, 200]], 'yearlong');
  const both = vectorsForSheet([outside, edge], A1, { ...utm, marginPx: 16 });
  assert.deepEqual([both.vectors.length, both.dropped, [...both.symbolKeys]], [1, 1, ['mvum-road-yearlong']]);
  for (const [x, y] of both.vectors[0].path) assert.ok(x >= -16 - 1e-6 && x <= W + 16 + 1e-6 && y >= -16 - 1e-6 && y <= H + 16 + 1e-6, `(${x},${y}) outside`);
  near(both.vectors[0].path[0][0], W - 200, 1e-6, 'interior start kept'); near(both.vectors[0].path[1][0], W + 16, 1e-6, 'clipped at margin');
  assert.equal(vectorsForSheet([{ layer: 'trail', seasonal: null, paths: [[[0, 0], [1, 1]]] }], A1, utm).dropped, 1);
});

test('clipPathToRect: a path leaving and re-entering yields two sub-paths', () => {
  const subs = clipPathToRect([[10, 10], [50, 10], [150, 10], [150, 50], [50, 50]], { width: 100, height: 100 });
  assert.equal(subs.length, 2);
  assert.deepEqual(subs[0], [[10, 10], [50, 10], [100, 10]]);
  near(subs[1][0][0], 100, 1e-9, 're-entry x'); assert.deepEqual(subs[1][1], [50, 50]);
  assert.deepEqual(clipPathToRect([[-5, -5], [-1, -1]], { width: 10, height: 10 }), []);
  assert.equal(clipPathToRect([[-5, -5], [-1, -1]], { width: 10, height: 10 }, 5).length, 1);
});

test('labelCandidates: one label per id at the midpoint of the longest sub-path; short paths get none', () => {
  const vectors = [
    { key: 'mvum-road-seasonal', id: '7', path: [[0, 0], [100, 0]] },
    { key: 'mvum-road-seasonal', id: '7', path: [[0, 100], [200, 100], [200, 400]] },
    { key: 'mvum-road-yearlong', id: '8', path: [[0, 0], [50, 50]] },
  ];
  const labels = labelCandidates(vectors, { minLengthPx: 120 });
  assert.deepEqual(labels, [{ key: 'mvum-road-seasonal', text: '7', x: 200, y: 150, angleDeg: 90 }]);
  assert.deepEqual(labelCandidates(vectors, { minLengthPx: 60 }).map((l) => l.text), ['7', '8']);
});

test('fixture roads (normalized) land on at least one of the 9 sheets', () => {
  const p1 = JSON.parse(readFileSync(new URL('fixtures/mvum-roads-p1.min.json', import.meta.url), 'utf8'));
  const features = p1.features.map((f) => normalizeFeature(f, 'roads'));
  const hits = plan.sheets.map((s) => [s.id, vectorsForSheet(features, s, utm).vectors.length]).filter(([, n]) => n > 0);
  assert.ok(hits.length >= 1, JSON.stringify(hits));
  for (const [, n] of hits) assert.ok(n >= 1);
  const keys = new Set(hits.flatMap(([id]) => [...vectorsForSheet(features, plan.sheets.find((s) => s.id === id), utm).symbolKeys]));
  assert.ok(keys.has('mvum-road-seasonal'));
});

// Road quality rides the WIDTH axis. Season keeps the pattern axis, so a road can
// say both things at once -- which it could not if either fact borrowed the other's.
test('a road takes its width from its maintenance level, and keeps its season pattern', () => {
  const r71 = road('71', [[100, 100], [W - 100, H - 100]]);   // seasonal by default
  const drawn = (roadQuality) => vectorsForSheet([r71], A1, { ...utm, roadQuality }).vectors[0];

  const plain = drawn(undefined);
  const paved = drawn({ 71: { tier: 'road-high' } });
  const rough = drawn({ 71: { tier: 'road-primitive' } });

  assert.ok(paved.widthPx > plain.widthPx, `paved ${paved.widthPx} should exceed unrated ${plain.widthPx}`);
  assert.ok(rough.widthPx < plain.widthPx, `unmaintained ${rough.widthPx} should be under unrated ${plain.widthPx}`);
  assert.ok(paved.widthPx >= rough.widthPx * 2, 'the tiers must be tellable apart on paper');

  // The fact that must NOT have been overwritten by the one just added:
  for (const v of [plain, paved, rough]) {
    assert.equal(v.pattern, 'dash', 'season still owns the pattern axis');
    assert.equal(v.key, 'mvum-road-seasonal');
    assert.equal(v.color, STYLE['mvum-road-seasonal'].color, 'colour still means "this is a road"');
  }
});

test('a road the inventory has no record for is drawn at its plain width, never dropped', () => {
  const unknown = road('NOT-IN-INVENTORY', [[100, 100], [W - 100, H - 100]], 'yearlong');
  const withTable = vectorsForSheet([unknown], A1, { ...utm, roadQuality: { 71: { tier: 'road-high' } } });
  const without = vectorsForSheet([unknown], A1, utm);
  assert.equal(withTable.vectors.length, 1, 'an unmatched road still prints');
  assert.equal(withTable.vectors[0].widthPx, without.vectors[0].widthPx, 'at exactly its plain width');
});

test('a trail never takes a road width, whatever the table says', () => {
  const t = { id: '71', layer: 'trail', seasonal: 'yearlong',
    paths: [[[100, 100], [W - 100, H - 100]].map(([x, y]) => lonLatAt(x, y))] };
  const a = vectorsForSheet([t], A1, utm).vectors[0];
  const b = vectorsForSheet([t], A1, { ...utm, roadQuality: { 71: { tier: 'road-high' } } }).vectors[0];
  assert.equal(a.widthPx, b.widthPx, 'road quality is a fact about roads; a trail sharing an id must be untouched');
});

// --- the registry's render rules, applied ---------------------------------
// `render` was declared on every layer and read by nothing: a layer could say
// "too dense to draw at 1:48,000" or "never letter me" and be ignored. These
// prove the declaration reaches the paper.

test('dropBelowScale drops a layer at a scale coarser than it can be read at', () => {
  const rules = { 'land-park': { labels: 'ifRoom', dropBelowScale: 24000 } };
  const boundary = { id: '1', symbolKey: 'land-park', paths: [[[100, 100], [W - 100, H - 100]].map(([x, y]) => lonLatAt(x, y))] };

  const fine = vectorsForSheet([boundary], A1, { ...utm, scale: 24000, renderRules: rules });
  assert.equal(fine.vectors.length, 1, '1:24,000 is at the limit, so it draws');
  assert.equal(fine.dropped, 0);

  const coarse = vectorsForSheet([boundary], A1, { ...utm, scale: 48000, renderRules: rules });
  assert.equal(coarse.vectors.length, 0, '1:48,000 holds four times the ground; the layer is dropped');
  assert.equal(coarse.dropped, 1, 'dropped, not silently absent');
  assert.equal(coarse.symbolKeys.size, 0, 'and it must not reach the legend either');

  // A layer with no limit is unaffected at any scale — silence is not a prohibition.
  const open = vectorsForSheet([boundary], A1, { ...utm, scale: 48000, renderRules: { 'land-park': { labels: 'ifRoom', dropBelowScale: null } } });
  assert.equal(open.vectors.length, 1);
});

test("labels:'none' keeps a layer on the map and off the lettering", () => {
  const rules = { 'land-game': { labels: 'none', dropBelowScale: null }, 'land-park': { labels: 'ifRoom', dropBelowScale: null } };
  const long = (x) => [[x, 50], [x, H - 50]].map(([a, b]) => lonLatAt(a, b));
  const silent = { id: 'g1', symbolKey: 'land-game', paths: [long(600)] };
  const spoken = { id: 'p1', symbolKey: 'land-park', paths: [long(1200)] };

  const { vectors } = vectorsForSheet([silent, spoken], A1, { ...utm, scale: 24000, renderRules: rules });
  assert.equal(vectors.length, 2, 'both are drawn');
  const labelled = labelCandidates(vectors).map((l) => l.text);
  assert.deepEqual(labelled, ['p1'], 'only the layer that allows labels is lettered');
});

test('the real registry rules ride on every vector, so nothing has to look them up', () => {
  const { vectors } = vectorsForSheet([road('7', [[100, 100], [W - 100, H - 100]])], A1, { ...utm, scale: 24000 });
  assert.equal(vectors[0].labels, 'ifRoom', 'MVUM is lettered on the sheet, and now says so');
});
