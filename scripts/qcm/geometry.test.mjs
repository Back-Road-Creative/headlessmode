// node --test "scripts/qcm/*.test.mjs" — pure-geometry contract for the Quiet Corners map planner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as g from '../../themes/headlessmode/static/js/quiet-corners-maps/geometry.js';

const here = dirname(fileURLToPath(import.meta.url));
const modulePath = join(here, '../../themes/headlessmode/static/js/quiet-corners-maps/geometry.js');
const ncat = JSON.parse(readFileSync(join(here, 'fixtures/ncat-utm-reference.json'), 'utf8'));
const index = JSON.parse(readFileSync(join(here, 'fixtures/map-indices-standing-indian.json'), 'utf8'));
const standingIndian = { minLon: -83.55, minLat: 35.0, maxLon: -83.4, maxLat: 35.1 };
const rainbowSprings = { minLon: -83.625, minLat: 35.0, maxLon: -83.5, maxLat: 35.125 };

// "-01 27 10.49" → decimal degrees; the sign lives on the degrees field, so "-00 10 26.14" stays negative.
const dmsToDeg = (s) => {
  const [d, m, sec] = s.trim().split(/\s+/);
  const sign = d.startsWith('-') ? -1 : 1;
  return sign * (Math.abs(Number(d)) + Number(m) / 60 + Number(sec) / 3600);
};
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (|Δ|=${Math.abs(a - b)} > ${tol})`);

test('forward matches the 12 NOAA NCAT reference points to 5 mm, k to 2e-8, γ to 1e-4°', () => {
  assert.equal(ncat.points.length, 12);
  for (const p of ncat.points) {
    const r = g.forward(p.lat, p.lon, p.zone, p.hemisphere);
    near(r.easting, p.easting, 0.005, `${p.name} easting`);
    near(r.northing, p.northing, 0.005, `${p.name} northing`);
    near(r.scaleFactor, p.scaleFactor, 2e-8, `${p.name} k`);
    near(r.convergenceDeg, dmsToDeg(p.convergenceDms), 1e-4, `${p.name} γ`);
  }
});

test('inverse round-trips every reference point to 1e-9° (≈0.1 mm)', () => {
  for (const p of ncat.points) {
    const { easting, northing } = g.forward(p.lat, p.lon, p.zone, p.hemisphere);
    const back = g.inverse(easting, northing, p.zone, p.hemisphere);
    near(back.lat, p.lat, 1e-9, `${p.name} lat`);
    near(back.lon, p.lon, 1e-9, `${p.name} lon`);
  }
});

test('southern hemisphere: false northing applied and round-trips', () => {
  const f = g.forward(-35, -83.5, 17, 'S');
  assert.ok(f.northing > 6e6 && f.northing < 1e7);
  near(g.inverse(f.easting, f.northing, 17, 'S').lat, -35, 1e-9, 'lat');
});

test('zone selection: floor rule, boundary lon belongs to the eastern zone (−84 → 17), 180 → 60', () => {
  const cases = [[-83.5, 17], [-84.0001, 16], [-84, 17], [-105.27, 13], [-122.33, 10], [180, 60], [-180, 1]];
  for (const [lon, zone] of cases) assert.equal(g.utmZoneForLon(lon), zone, `lon ${lon}`);
  assert.equal(g.hemisphereForLat(35), 'N');
  assert.equal(g.hemisphereForLat(-35), 'S');
  assert.deepEqual(g.zoneForCentroid(standingIndian), { zone: 17, hemisphere: 'N', centralMeridianDeg: -81 });
});

test('projectBbox: in-zone Standing Indian area (lon −83.7…−83.3) is printable in zone 17, deviation < 0.0006', () => {
  const bbox = { minLon: -83.7, minLat: 35.0, maxLon: -83.3, maxLat: 35.1 };
  const ext = g.projectBbox(bbox, 17, 'N');
  assert.ok(ext.minX < ext.maxX && ext.minY < ext.maxY);
  assert.ok(ext.maxScaleDeviation < 0.0006, `deviation ${ext.maxScaleDeviation}`);
  const ok = g.assertPrintable(bbox);
  assert.equal(ok.zone, 17);
  assert.equal(ok.extent.maxScaleDeviation, ext.maxScaleDeviation);
});

test('MAX_SCALE_DEVIATION is the plan number 0.0015 and the ~0.3° and ~1° 16/17 crossings measure below it (accepted)', () => {
  assert.equal(g.MAX_SCALE_DEVIATION, 0.0015);
  // Crossing by ~1° (lon −84.9…−83.9): centroid picks zone 16, east edge sits 3.1° from its meridian → k−1 ≈ 5.8e-4.
  const wide = g.projectBbox({ minLon: -84.9, minLat: 35.0, maxLon: -83.9, maxLat: 35.1 }, 16, 'N');
  assert.ok(wide.maxScaleDeviation > 0.0005 && wide.maxScaleDeviation < 0.0007, `~1° crossing: ${wide.maxScaleDeviation}`);
  assert.equal(g.assertPrintable({ minLon: -84.9, minLat: 35.0, maxLon: -83.9, maxLat: 35.1 }).zone, 16);
  // Crossing by ~0.3° (lon −84.3…−83.9): centroid −84.1 → zone 16, east edge 3.1° out → same edge deviation.
  const narrow = g.projectBbox({ minLon: -84.3, minLat: 35.0, maxLon: -83.9, maxLat: 35.1 }, 16, 'N');
  assert.ok(narrow.maxScaleDeviation < g.MAX_SCALE_DEVIATION, `~0.3° crossing: ${narrow.maxScaleDeviation}`);
  assert.equal(g.assertPrintable({ minLon: -84.3, minLat: 35.0, maxLon: -83.9, maxLat: 35.1 }).zone, 16);
});

test('assertPrintable rejects a bbox reaching 5° past its meridian (lon −86…−82 in zone 17) and says "split"', () => {
  assert.throws(() => g.assertPrintable({ minLon: -86, minLat: 35.0, maxLon: -82, maxLat: 35.1 }),
    (e) => e instanceof RangeError && /split/.test(e.message) && /0\.00\d+/.test(e.message));
});

test('assertPrintable guards: outside CONUS, antimeridian, empty/inverted', () => {
  const conus = (e) => e instanceof RangeError && /contiguous/.test(e.message);
  assert.throws(() => g.assertPrintable({ minLon: -150, minLat: 60, maxLon: -149, maxLat: 61 }), conus);
  assert.throws(() => g.assertPrintable({ minLon: 179, minLat: 35, maxLon: -179, maxLat: 36 }), RangeError);
  assert.throws(() => g.assertPrintable({ minLon: -83.5, minLat: 35, maxLon: -83.6, maxLat: 36 }), RangeError);
  assert.throws(() => g.assertPrintable({ minLon: -83.5, minLat: 35, maxLon: -83.5, maxLat: 35 }), RangeError);
});

test('cells: cellForPoint, neighbors, cellsForBbox against the map-index fixture, bboxOfCells', () => {
  assert.equal(g.CELL_DEG, 0.125);
  assert.deepEqual(g.cellForPoint(35.0327, -83.5299), rainbowSprings);
  assert.deepEqual(g.cellNeighbors(rainbowSprings), {
    n: { minLon: -83.625, minLat: 35.125, maxLon: -83.5, maxLat: 35.25 },
    s: { minLon: -83.625, minLat: 34.875, maxLon: -83.5, maxLat: 35.0 },
    e: { minLon: -83.5, minLat: 35.0, maxLon: -83.375, maxLat: 35.125 },
    w: { minLon: -83.75, minLat: 35.0, maxLon: -83.625, maxLat: 35.125 },
  });
  const cells = g.cellsForBbox(standingIndian);
  assert.equal(cells.length, 4);
  assert.deepEqual(cells[0], rainbowSprings, 'row-major from the north-west');
  assert.deepEqual(cells[3], { minLon: -83.5, minLat: 34.875, maxLon: -83.375, maxLat: 35.0 });
  assert.deepEqual(index.features.map((f) => f.attributes.CELL_NAME).sort(), ['Dillard', 'Hightower Bald', 'Prentiss', 'Rainbow Springs']);
  const key = (c) => [c.minLon, c.minLat, c.maxLon, c.maxLat].map((v) => (Math.round(v * 1000) / 1000).toFixed(3)).join(',');
  const fixtureKeys = index.features.map((f) => {
    const pts = f.geometry.rings[0];
    const lons = pts.map((p) => p[0]); const lats = pts.map((p) => p[1]);
    const b = { minLon: Math.min(...lons), minLat: Math.min(...lats), maxLon: Math.max(...lons), maxLat: Math.max(...lats) };
    const cell = g.cellForPoint((b.minLat + b.maxLat) / 2, (b.minLon + b.maxLon) / 2);
    for (const k of Object.keys(cell)) near(b[k], cell[k], 1e-3, `${f.attributes.CELL_NAME} ${k}`);
    return key(b);
  });
  assert.deepEqual(new Set(cells.map(key)), new Set(fixtureKeys));
  assert.deepEqual(g.bboxOfCells(cells), { minLon: -83.625, minLat: 34.875, maxLon: -83.375, maxLat: 35.125 });
});

test('purity: no import, fetch, or Date in the module', () => {
  const src = readFileSync(modulePath, 'utf8');
  for (const bad of [/\bimport\b/, /\bfetch\b/, /\bDate\b/, /\brequire\(/, /\bdocument\b/, /\bwindow\b/]) assert.doesNotMatch(src, bad);
});

// QUX-10a: stable per-quad ids, and the box->quads query a quad-set selection is built from.
test('cellId/cellFromId round-trip, and a malformed id is rejected', () => {
  assert.equal(g.cellId(rainbowSprings), '280:-669');
  assert.deepEqual(g.cellFromId('280:-669'), rainbowSprings);
  assert.equal(g.cellId(g.cellFromId('279:-668')), '279:-668', 'round-trips the other direction too');
  for (const bad of ['280', '280:', ':-669', '280:-669:0', '28a:-669', '', null, undefined, 7, '280:-669 ']) {
    assert.throws(() => g.cellFromId(bad), RangeError, `expected a throw for ${JSON.stringify(bad)}`);
  }
});

test('quadsCoveringBox: open-interval, so a box edge on a cell line does not pull in the outside cell', () => {
  // standingIndian's minLat 35.0 sits exactly on the line between row 279 (34.875..35.0)
  // and row 280 (35.0..35.125), and its own span (35.0..35.1) never reaches past that line
  // into row 279's interior. cellsForBbox (closed) still pulls row 279 in because its edge
  // touches it; quadsCoveringBox (open) must not, or a stored quad set would silently grow
  // past the box the reader actually drew.
  const closed = g.cellsForBbox(standingIndian).map(g.cellId);
  const open = g.quadsCoveringBox(standingIndian);
  assert.equal(closed.length, 4, 'closed interval pulls in both rows straddling minLat');
  assert.deepEqual(open, ['280:-669', '280:-668'], 'open interval keeps only the row the interior actually meets');
});

test('quadsCoveringBox: row-major north to south, then west to east (canonical sort order)', () => {
  // A box whose edges sit inside cell interiors on every side (no boundary coincidence),
  // spanning 2 rows x 2 cols, so the order is unambiguous.
  const box = { minLon: -83.6, minLat: 34.9, maxLon: -83.45, maxLat: 35.05 };
  assert.deepEqual(g.quadsCoveringBox(box), ['280:-669', '280:-668', '279:-669', '279:-668']);
});
