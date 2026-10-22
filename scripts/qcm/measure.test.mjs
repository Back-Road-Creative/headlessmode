// QQA-09: ellipsoidal length, area and perimeter as fact records. Every number is proved against a
// PUBLISHED value (GeographicLib/Karney's JFK-LHR line, the WGS84 meridian quadrant and total area,
// the equator's own arc length) with a tolerance a haversine, Web Mercator or flat-degrees
// implementation fails -- each of those failures is asserted too, so the tolerance is known to bite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WGS84, M_PER_MILE, AUTHALIC_RADIUS, metersPerDegree, inverse, measureLength, measurePolygon, formatLength, formatArea,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/measure.js';

const line = (...c) => ({ type: 'LineString', coordinates: c });
const box = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const poly = (...rings) => ({ type: 'Polygon', coordinates: rings });
const near = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want} +-${tol} (off by ${got - want})`);
const rel = (got, want, tol, what) => near(got / want, 1, tol, what);
const FIELDS = ['value', 'unit', 'status', 'method', 'basis', 'geometry', 'precision', 'source'];

test('WGS84 constants are the published ones', () => {
  assert.equal(WGS84.a, 6378137);
  assert.equal(1 / WGS84.f, 298.257223563);
  assert.equal(M_PER_MILE, 1609.344);
});

test('length: JFK to LHR is GeographicLib\'s published 5551759.400 m, to a millimetre-scale tolerance', () => {
  const jfk = [-73.8, 40.6], lhr = [-0.5, 51.6];            // Karney's geodesic example
  const got = measureLength(line(jfk, lhr)).value;
  near(got, 5551759.400, 0.005, 'JFK-LHR');
  // A spherical (haversine, R = 6371008.8) answer is about 11 km out, so 5 mm really does exclude it.
  const R = 6371008.8, r = (d) => d * Math.PI / 180;
  const h = Math.sin(r(51.6 - 40.6) / 2) ** 2 + Math.cos(r(40.6)) * Math.cos(r(51.6)) * Math.sin(r(73.3) / 2) ** 2;
  const haversine = 2 * R * Math.asin(Math.sqrt(h));
  assert.ok(Math.abs(haversine - 5551759.4) > 5000, `haversine ${haversine} must fail the tolerance`);
});

test('length: the meridian quadrant is 10001965.729 m and the equator quadrant is a*pi/2', () => {
  near(measureLength(line([0, 0], [0, 90])).value, 10001965.7293, 0.01, 'equator to pole');
  near(measureLength(line([0, 0], [90, 0])).value, WGS84.a * Math.PI / 2, 0.001, 'a quarter of the equator');
  near(measureLength(line([10, 0], [10, 1])).value, 110574.389, 0.01, 'first degree of latitude');
});

test('length: a many-vertex line sums its segments; a MultiLineString sums its lines', () => {
  const a = line([0, 0], [0, 1]), b = line([0, 1], [0, 2]);
  const both = measureLength(line([0, 0], [0, 1], [0, 2])).value;
  near(both, measureLength(a).value + measureLength(b).value, 1e-6, 'additive');
  near(measureLength({ type: 'MultiLineString', coordinates: [a.coordinates, b.coordinates] }).value, both, 1e-6, 'multiline');
});

test('length: across the dateline a 1 degree hop is 1 degree, and unwrapped longitudes measure the same', () => {
  const across = measureLength(line([179.5, 60], [-179.5, 60])).value;
  const plain = measureLength(line([0.5, 60], [1.5, 60])).value;
  near(across, plain, 1e-6, 'dateline hop');
  near(measureLength(line([179.5, 60], [180.5, 60])).value, plain, 1e-6, 'unwrapped 180.5');
  assert.ok(across < 60000, `a naive subtraction would measure 359 degrees, got ${across}`);
});

test('length: zero is a value, not a gap', () => {
  const r = measureLength(line([-83.5, 35], [-83.5, 35]));
  assert.equal(r.value, 0);
  assert.equal(r.status, 'known');
  assert.equal(r.unit, 'm');
});

test('length: empty, degenerate, NaN and out-of-range geometry is unavailable with a reason, never a number', () => {
  const bad = [line(), line([0, 0]), line([0, 0], [NaN, 1]), line([0, 0], [1, 91]), line([0, 0], [1, null]),
    { type: 'MultiLineString', coordinates: [] }, { type: 'LineString', coordinates: null }];
  for (const g of bad) {
    const r = measureLength(g);
    assert.equal(r.status, 'unavailable', JSON.stringify(g));
    assert.equal(r.value, null, JSON.stringify(g));
    assert.ok(r.reason && r.reason.length > 8, `a reason: ${JSON.stringify(g)}`);
  }
  assert.equal(inverse([0, 0], [179.9, 0.5]), null, 'near-antipodal points do not converge');
  assert.equal(measureLength(line([0, 0], [179.9, 0.5])).status, 'unavailable', 'and are refused, not mis-measured');
});

test('length: a point or a polygon is not applicable, not zero', () => {
  for (const g of [{ type: 'Point', coordinates: [0, 0] }, poly(box(0, 0, 1, 1)), null, undefined]) {
    const r = measureLength(g);
    assert.equal(r.status, 'not applicable');
    assert.equal(r.value, null);
  }
});

test('a fact record carries every field, states its method and the caller\'s source', () => {
  const r = measureLength(line([0, 0], [0, 1]), { source: 'USFS MVUM' });
  assert.deepEqual(Object.keys(r).filter((k) => FIELDS.includes(k)).sort(), [...FIELDS].sort());
  assert.equal(r.status, 'known');
  assert.equal(r.method, 'derived');
  assert.equal(r.source, 'USFS MVUM');
  assert.match(r.basis, /loaded geometry/);
  assert.match(r.precision, /0\.5 mm/);
});

test('completeness: an incomplete geometry is approximate and keeps the caller\'s reason', () => {
  const r = measureLength(line([0, 0], [0, 1]), { complete: false, reason: 'only the part loaded in this view' });
  assert.equal(r.status, 'approximate');
  assert.equal(r.reason, 'only the part loaded in this view');
  assert.ok(r.value > 110000, 'the value is still reported');
  assert.equal(measureLength(line([0, 0], [0, 0]), { complete: false }).status, 'approximate', 'zero stays a value when incomplete');
  assert.equal(measureLength(line([0, 0], [NaN, 0]), { complete: false }).status, 'unavailable', 'incomplete never turns a gap into a number');
});

test('area: the WGS84 octant times eight is the published 510065621.724 km2', () => {
  const octant = poly([[0, 0], [90, 0], [0, 90], [0, 0]]);
  rel(measurePolygon(octant).area.value * 8, 510065621.724e6, 1e-9, 'sphere surface');
  near(AUTHALIC_RADIUS, 6371007.181, 0.01, 'authalic radius');
});

test('area: a 1 degree cell on the equator is its two published arcs multiplied, and not a spherical cell', () => {
  const cell = measurePolygon(poly(box(0, 0, 1, 1))).area.value;
  rel(cell, 111319.4908 * 110574.389, 1e-4, 'equator cell');
  assert.ok(Math.abs(cell / (111194.93 ** 2) - 1) > 4e-3, 'a spherical R=6371 km cell differs by more than the tolerance');
});

test('area: at 60.5 N the cell is the local arcs multiplied; Web Mercator\'s and flat degrees\' areas are far off', () => {
  const m = metersPerDegree(60.5);
  const cell = measurePolygon(poly(box(10, 60, 11, 61))).area.value;
  rel(cell, m.lon * m.lat, 5e-4, 'cell at 60.5 N');
  const mercator = 111319.4908 ** 2 / Math.cos(60.5 * Math.PI / 180);   // 1 degree of x by 1 degree of y, both stretched by 1/cos
  assert.ok(mercator / cell > 3, `Web Mercator overstates this cell about 4x (${mercator / cell}); the tolerance excludes it`);
  assert.ok(Math.abs(111319.4908 * 110574.389 / cell - 1) > 0.5, 'flat degrees x degrees is also far off');
});

test('area: a ring of latitude 60 N encloses the polar cap 2*pi*R^2*(1 - sin beta)', () => {
  const ring = Array.from({ length: 361 }, (_, i) => [i - 180, 60]);
  const got = measurePolygon(poly(ring)).area.value;
  rel(got, 34415850514904, 2e-4, 'cap at 60 N');                   // closed form on the authalic sphere
  const south = measurePolygon(poly(ring.map(([x, y]) => [x, -y]).reverse())).area.value;
  rel(south, got, 1e-6, 'the mirror cap, wound the other way');
});

test('area: a ring along the equator is a hemisphere, whichever side is meant', () => {
  const ring = Array.from({ length: 361 }, (_, i) => [i - 180, 0]);
  rel(measurePolygon(poly(ring)).area.value, 510065621.724e6 / 2, 1e-9, 'half the ellipsoid');
});

test('area: shifting a polygon across the dateline, or writing it unwrapped, changes nothing', () => {
  const plain = measurePolygon(poly(box(0, 60, 2, 61))).area.value;
  rel(measurePolygon(poly(box(179, 60, 181, 61))).area.value, plain, 1e-9, 'unwrapped past 180');
  rel(measurePolygon(poly([[179, 60], [-179, 60], [-179, 61], [179, 61], [179, 60]])).area.value, plain, 1e-9, 'wrapped');
});

test('area: ring orientation does not matter, and holes are subtracted, in a Polygon and a MultiPolygon', () => {
  const outer = box(0, 0, 4, 4), hole = box(1, 1, 2, 2);
  const solid = measurePolygon(poly(outer)).area.value, hollow = measurePolygon(poly(outer, hole)).area.value;
  const hAlone = measurePolygon(poly(hole)).area.value;
  rel(solid - hollow, hAlone, 1e-12, 'the hole removes exactly its own area');
  rel(measurePolygon(poly([...outer].reverse())).area.value, solid, 1e-12, 'clockwise = counter-clockwise');
  const multi = measurePolygon({ type: 'MultiPolygon', coordinates: [[outer, hole], [box(10, 0, 11, 1)]] });
  rel(multi.area.value, hollow + measurePolygon(poly(box(10, 0, 11, 1))).area.value, 1e-12, 'multipolygon sums');
});

test('area: long slanted edges follow the geodesic, not a straight line on the equal-area sphere', () => {
  // Reference values from an independent computation (QQA-09 review): each edge traced by RK4
  // integration of the geodesic ODE on WGS84, area by Green's theorem along the traced path.
  // Every edge here is slanted and 1,000-10,000 km long; joining the vertices directly on the
  // authalic sphere (no 50 km pieces) is off by 6.9e-4 and 3.5e-5, so 1e-7 is a bite, not a formality.
  const cases = [
    [poly([[-120, 10], [-30, 15], [-40, 60], [-110, 55], [-120, 10]]), 34801313637519.375, 23896660.242001012, 'a continent-sized quadrilateral'],
    [poly([[175, -20], [-172, -18], [-175, -10], [179, -8], [172, -14], [175, -20]]), 1497518969751.107, 4773742.161378648, 'an irregular pentagon on the dateline'],
  ];
  for (const [g, area, perimeter, what] of cases) {
    const r = measurePolygon(g);
    rel(r.area.value, area, 1e-7, `${what}: area`);
    rel(r.perimeter.value, perimeter, 1e-9, `${what}: perimeter`);
  }
});

test('area: a hole outside its outer ring is invalid; a hole touching the ring, or inside a polar cap, is not', () => {
  const outer = box(0, 0, 4, 4);
  for (const hole of [box(10, 10, 11, 11), box(3, 3, 5, 5)]) {
    const r = measurePolygon(poly(outer, hole));
    assert.equal(r.area.status, 'unavailable', JSON.stringify(hole));
    assert.match(r.area.reason, /outside its outer ring/);
  }
  const touching = measurePolygon(poly(outer, box(0, 0, 1, 1)));
  assert.equal(touching.area.status, 'known', 'a hole sharing the corner and two edges of its ring is valid GeoJSON');
  const dateline = measurePolygon(poly(box(179, 0, 183, 4), [[-179, 1], [-178, 1], [-178, 2], [-179, 2], [-179, 1]]));
  assert.equal(dateline.area.status, 'known', 'a hole written wrapped inside a ring written unwrapped');
  const cap = [[0, 60], [90, 60], [180, 60], [-90, 60], [0, 60]];
  const capped = measurePolygon(poly(cap, box(10, 80, 20, 81)));
  assert.equal(capped.area.status, 'known', 'a ring around the pole has no inside in degrees; its holes are taken as given');
  near(capped.area.value, measurePolygon(poly(cap)).area.value - measurePolygon(poly(box(10, 80, 20, 81))).area.value, 1, 'and subtracted');
});

test('perimeter: counts the outer edge and every hole, on the ellipsoid', () => {
  const outer = measurePolygon(poly(box(0, 0, 1, 1))).perimeter.value;
  near(outer, 111319.49 + 110574.39 * 2 + measureLength(line([0, 1], [1, 1])).value, 1, 'one degree cell');
  const withHole = measurePolygon(poly(box(0, 0, 4, 4), box(1, 1, 2, 2))).perimeter.value;
  near(withHole, measurePolygon(poly(box(0, 0, 4, 4))).perimeter.value + measurePolygon(poly(box(1, 1, 2, 2))).perimeter.value, 1e-6, 'hole edges add');
});

test('area: zero is a value; empty, degenerate, NaN, invalid-hole and wrong-type geometry are not', () => {
  const flat = measurePolygon(poly([[0, 0], [1, 0], [2, 0], [0, 0]]));
  assert.equal(flat.area.status, 'known');
  assert.ok(flat.area.value < 1e-3, `a sliver of zero width is ~0 (${flat.area.value})`);
  const bad = [poly(), poly([[0, 0], [1, 1]]), poly([[0, 0], [NaN, 1], [1, 1], [0, 0]]), poly(box(0, 0, 1, 1), box(-5, -5, 5, 5)),
    { type: 'MultiPolygon', coordinates: [] }];
  for (const g of bad) {
    const r = measurePolygon(g);
    for (const f of [r.area, r.perimeter]) {
      assert.equal(f.status, 'unavailable', JSON.stringify(g));
      assert.equal(f.value, null);
      assert.ok(f.reason);
    }
  }
  const wrong = measurePolygon(line([0, 0], [1, 1]));
  assert.equal(wrong.area.status, 'not applicable');
  assert.equal(wrong.perimeter.status, 'not applicable');
  assert.equal(measurePolygon(poly(box(0, 0, 1, 1)), { complete: false, reason: 'clipped' }).area.status, 'approximate');
});

test('metersPerDegree: the published values at the equator and the pole', () => {
  near(metersPerDegree(0).lon, 111319.4908, 0.001, 'equator longitude degree');
  near(metersPerDegree(0).lat, 110574.2758, 0.001, 'equator latitude degree');
  near(metersPerDegree(90).lat, (6399593.6259 * Math.PI) / 180, 0.001, 'polar latitude degree (c = 6399593.6259 m)');
  near(metersPerDegree(60).lon, 55800.0, 0.01, 'longitude degree at 60 N');
});

test('formatting: miles first, kilometres beside them; feet for a short run; null for no value', () => {
  assert.equal(formatLength({ value: 5551759.4 }), '3,449.7 mi (5,551.8 km)');
  assert.equal(formatLength({ value: 5000 }), '3.1 mi (5.00 km)');
  assert.equal(formatLength({ value: 100 }), '328 ft (100 m)');
  assert.equal(formatLength({ value: 0 }), '0 ft (0 m)', 'zero is shown, not hidden');
  assert.equal(formatLength({ value: null }), null);
  assert.equal(formatArea({ value: 5e6 }), '1.9 sq mi (5.0 km²)');
  assert.equal(formatArea({ value: 4046.8564224 }), '1.0 acres (0.4 ha)');
});
