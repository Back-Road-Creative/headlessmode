// QQA-09: ellipsoidal length, area and perimeter, each answered as a FACT RECORD.
// Pure: no DOM, no network, no clock. Coordinates are GeoJSON-style [lon, lat] degrees.
//
// Why this exists: a drawn road or boundary is measured on the WGS84 ellipsoid, never on
// the screen. Web Mercator overstates area by 1/cos^2(lat) (about 4x at 60 deg N) and a
// local-plane length drifts with distance; neither is acceptable for a number a reader
// plans a day around.
//
// Algorithms and accuracy (proved against published values in measure.test.mjs):
//  - Length: Vincenty's inverse formula per segment, on a = 6378137 m, f = 1/298.257223563.
//    Accurate to about 0.5 mm per segment; JFK-LHR matches GeographicLib's 5551759.4 m.
//    It does not converge for NEARLY ANTIPODAL points (about 19,900 km apart), so a segment
//    that long is reported 'unavailable', never as a wrong number.
//  - Area: every edge is split into <= 50 km pieces ON ITS GEODESIC (Vincenty direct), the
//    vertices are mapped to the authalic (equal-area) sphere, and the spherical polygon is
//    summed edge by edge (Karney's signed-excess form). The equal-area map is exact for any
//    region; the only approximation is a 50 km chord standing in for its geodesic piece,
//    well under 1 part in 10^6. Holes are subtracted; a polygon larger than a hemisphere is
//    measured as its smaller side (see the README's unsupported domains).
//  - Dateline: every longitude step is wrapped to [-180, 180], so a segment from 179.5 to
//    -179.5 is a 1 degree hop, and coordinates unwrapped past 180 measure the same.
//  - Poles: handled by the same sums; a ring that encloses a pole is measured correctly.
//
// A fact record: {value, unit, status, method, basis, geometry, precision, source, reason?}.
// status is 'known' | 'approximate' | 'unavailable' | 'not applicable'; zero is a VALUE
// (status 'known'), never 'unavailable'. method is 'derived' (we computed it) or 'published'
// (the source stated it). `source` is whatever the caller says the geometry came from.
export const WGS84 = Object.freeze({ a: 6378137, f: 1 / 298.257223563 });
export const M_PER_MILE = 1609.344;
export const M_PER_FOOT = 0.3048;
const { a, f } = WGS84;
const b = a * (1 - f);
const E2 = f * (2 - f);
const D2R = Math.PI / 180;
const MAX_EDGE_M = 50000;
const LENGTH_PRECISION = 'about 0.5 mm per segment (Vincenty); real accuracy is the source line\'s own detail';
const AREA_PRECISION = 'better than 1 part in 1,000,000 of the area (equal-area map, 50 km geodesic pieces); real accuracy is the source boundary\'s own detail';

/** Metres per degree of latitude and of longitude at `latDeg`, on the ellipsoid (the local
 *  plane near-unpaved.js measures short point-to-line distances in). */
export function metersPerDegree(latDeg) {
  const s = Math.sin(latDeg * D2R), w = 1 - E2 * s * s;
  return { lat: (a * (1 - E2) / (w * Math.sqrt(w))) * D2R, lon: (a / Math.sqrt(w)) * Math.cos(latDeg * D2R) * D2R };
}

const wrap = (rad) => rad - 2 * Math.PI * Math.round(rad / (2 * Math.PI));
const okPos = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[1]) <= 90;

/** Vincenty inverse: {s: metres, a1: initial azimuth in radians} between two [lon, lat]
 *  points, or null when the iteration does not converge (nearly antipodal). */
export function inverse([lon1, lat1], [lon2, lat2]) {
  const L = wrap((lon2 - lon1) * D2R);
  const U1 = Math.atan((1 - f) * Math.tan(lat1 * D2R)), U2 = Math.atan((1 - f) * Math.tan(lat2 * D2R));
  const sU1 = Math.sin(U1), cU1 = Math.cos(U1), sU2 = Math.sin(U2), cU2 = Math.cos(U2);
  let lam = L, sinSig, cosSig, sig, cos2a, cos2sm;
  for (let i = 0; ; i += 1) {
    if (i >= 200 || Math.abs(lam) > Math.PI) return null;
    const sl = Math.sin(lam), cl = Math.cos(lam);
    sinSig = Math.hypot(cU2 * sl, cU1 * sU2 - sU1 * cU2 * cl);
    if (sinSig === 0) return { s: 0, a1: 0 };
    cosSig = sU1 * sU2 + cU1 * cU2 * cl;
    sig = Math.atan2(sinSig, cosSig);
    const sinA = cU1 * cU2 * sl / sinSig;
    cos2a = 1 - sinA * sinA;
    cos2sm = cos2a !== 0 ? cosSig - 2 * sU1 * sU2 / cos2a : 0;
    const C = f / 16 * cos2a * (4 + f * (4 - 3 * cos2a));
    const next = L + (1 - C) * f * sinA * (sig + C * sinSig * (cos2sm + C * cosSig * (-1 + 2 * cos2sm * cos2sm)));
    const done = Math.abs(next - lam) < 1e-12;
    lam = next;
    if (done) break;
  }
  const u2 = cos2a * (a * a - b * b) / (b * b);
  const A = 1 + u2 / 16384 * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const B = u2 / 1024 * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const dSig = B * sinSig * (cos2sm + B / 4 * (cosSig * (-1 + 2 * cos2sm * cos2sm)
    - B / 6 * cos2sm * (-3 + 4 * sinSig * sinSig) * (-3 + 4 * cos2sm * cos2sm)));
  return { s: b * A * (sig - dSig), a1: Math.atan2(cU2 * Math.sin(lam), cU1 * sU2 - sU1 * cU2 * Math.cos(lam)) };
}

/** Vincenty direct: the [lon, lat] reached from [lon1, lat1] after `s` metres on azimuth `a1` (rad). */
export function direct([lon1, lat1], a1, s) {
  const U1 = Math.atan((1 - f) * Math.tan(lat1 * D2R)), sU1 = Math.sin(U1), cU1 = Math.cos(U1);
  const sA1 = Math.sin(a1), cA1 = Math.cos(a1);
  const sig1 = Math.atan2(Math.tan(U1), cA1), sinA = cU1 * sA1, cos2a = 1 - sinA * sinA;
  const u2 = cos2a * (a * a - b * b) / (b * b);
  const A = 1 + u2 / 16384 * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const B = u2 / 1024 * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  let sig = s / (b * A), cos2sm, sinSig, cosSig;
  for (let i = 0; i < 100; i += 1) {
    cos2sm = Math.cos(2 * sig1 + sig); sinSig = Math.sin(sig); cosSig = Math.cos(sig);
    const dSig = B * sinSig * (cos2sm + B / 4 * (cosSig * (-1 + 2 * cos2sm * cos2sm)
      - B / 6 * cos2sm * (-3 + 4 * sinSig * sinSig) * (-3 + 4 * cos2sm * cos2sm)));
    const next = s / (b * A) + dSig;
    const done = Math.abs(next - sig) < 1e-12;
    sig = next;
    if (done) break;
  }
  sinSig = Math.sin(sig); cosSig = Math.cos(sig); cos2sm = Math.cos(2 * sig1 + sig);
  const t = sU1 * sinSig - cU1 * cosSig * cA1;
  const lat = Math.atan2(sU1 * cosSig + cU1 * sinSig * cA1, (1 - f) * Math.hypot(sinA, t));
  const lam = Math.atan2(sinSig * sA1, cU1 * cosSig - sU1 * sinSig * cA1);
  const C = f / 16 * cos2a * (4 + f * (4 - 3 * cos2a));
  const L = lam - (1 - C) * f * sinA * (sig + C * sinSig * (cos2sm + C * cosSig * (-1 + 2 * cos2sm * cos2sm)));
  return [lon1 + L / D2R, lat / D2R];
}

const fact = (o) => ({ value: null, unit: null, status: 'unavailable', method: 'derived', basis: null, geometry: null, precision: null, source: null, ...o });
const baseOf = (opts, extra) => ({ basis: opts.basis ?? extra.basis, source: opts.source ?? null, geometry: extra.geometry });
/** Applies the caller's completeness verdict: {complete: false, reason} downgrades a known value to approximate. */
const graded = (rec, opts) => (rec.status === 'known' && opts.complete === false
  ? { ...rec, status: 'approximate', reason: opts.reason || 'the geometry is not known to be complete' } : rec);

function lineMeters(line) {
  if (!Array.isArray(line) || line.length < 2) return { error: 'a line needs at least two points' };
  if (!line.every(okPos)) return { error: 'a coordinate is missing, not a number, or outside latitude -90 to 90' };
  let sum = 0;
  for (let i = 1; i < line.length; i += 1) {
    const r = inverse(line[i - 1], line[i]);
    if (!r) return { error: 'a segment is nearly antipodal, which the length formula cannot solve' };
    sum += r.s;
  }
  return { meters: sum };
}

/** Geodesic length of a LineString or MultiLineString (GeoJSON geometry). Lines are measured as a
 *  single total; the rest of the world (Point, Polygon) is 'not applicable' -- ask for a perimeter.
 *  `opts`: {basis, source, complete, reason}. */
export function measureLength(geom, opts = {}) {
  const common = baseOf(opts, { basis: 'route length of loaded geometry', geometry: geom?.type ?? null });
  const type = geom?.type;
  if (type !== 'LineString' && type !== 'MultiLineString') {
    return fact({ ...common, status: 'not applicable', reason: `length is measured for lines; this geometry is ${type || 'missing'}` });
  }
  const lines = type === 'LineString' ? [geom.coordinates] : geom.coordinates;
  if (!Array.isArray(lines) || !lines.length) return fact({ ...common, reason: 'the geometry has no lines' });
  let meters = 0;
  for (const line of lines) {
    const r = lineMeters(line);
    if (r.error) return fact({ ...common, reason: r.error });
    meters += r.meters;
  }
  return graded(fact({ ...common, value: meters, unit: 'm', status: 'known', precision: LENGTH_PRECISION }), opts);
}

/** Vertices of a ring with its closing duplicate dropped, or {error}. */
function openRing(ring) {
  if (!Array.isArray(ring) || !ring.every(okPos)) return { error: 'a ring has a missing, non-numeric or out-of-range coordinate' };
  const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
  if (pts.length < 3) return { error: 'a ring needs at least three distinct vertices' };
  return { pts };
}

// Authalic latitude: sin(beta) = q(phi) / q(pi/2), the equal-area map onto a sphere of radius R_Q.
const e = Math.sqrt(E2);
const qOf = (s) => (1 - E2) * (s / (1 - E2 * s * s) - Math.log((1 - e * s) / (1 + e * s)) / (2 * e));
const Q_POLE = qOf(1);
export const AUTHALIC_RADIUS = a * Math.sqrt(Q_POLE / 2);
const authalic = (latDeg) => Math.asin(Math.max(-1, Math.min(1, qOf(Math.sin(latDeg * D2R)) / Q_POLE)));

/** Signed area (m^2) and perimeter (m) of one ring, or {error}. */
function ringMeasure(ring) {
  const o = openRing(ring);
  if (o.error) return o;
  const dense = [];
  let perimeter = 0;
  for (let i = 0; i < o.pts.length; i += 1) {
    const p = o.pts[i], q = o.pts[(i + 1) % o.pts.length];
    const r = inverse(p, q);
    if (!r) return { error: 'an edge is nearly antipodal, which the area formula cannot solve' };
    perimeter += r.s;
    dense.push(p);
    const n = Math.ceil(r.s / MAX_EDGE_M);
    for (let k = 1; k < n; k += 1) dense.push(direct(p, r.a1, (r.s * k) / n));
  }
  // Each edge contributes the signed area between it and the equator; the sum is the polygon's
  // area unless the ring winds once around a pole (net longitude change of +-360 degrees), in
  // which case that sum is the band to the equator and the cap is 2*pi minus it.
  let excess = 0, turn = 0;
  for (let i = 0; i < dense.length; i += 1) {
    const [lon1, lat1] = dense[i], [lon2, lat2] = dense[(i + 1) % dense.length];
    const dLon = wrap((lon2 - lon1) * D2R);
    const t1 = Math.tan(authalic(lat1) / 2), t2 = Math.tan(authalic(lat2) / 2);
    excess += 2 * Math.atan2(Math.tan(dLon / 2) * (t1 + t2), 1 + t1 * t2);
    turn += dLon;
  }
  const winding = Math.round(turn / (2 * Math.PI));
  const sphere = winding ? 2 * Math.PI - winding * excess : Math.abs(excess);
  return { area: AUTHALIC_RADIUS * AUTHALIC_RADIUS * (sphere > 2 * Math.PI ? 4 * Math.PI - sphere : sphere), perimeter, winding, pts: o.pts };
}

/** Whether every vertex of `hole` is inside or on `outer` (both open vertex lists), tested in degrees with
 *  longitudes unwrapped around the outer ring's first vertex. A hole outside its ring would otherwise
 *  be subtracted from an area it does not belong to. Degrees are not the geodesic, so a vertex within
 *  a hair of a long outer edge can be judged wrongly; the answer is then 'unavailable', never a number. */
function holeInside(hole, outer) {
  const lon0 = outer[0][0];
  const un = ([lon, lat]) => [lon0 + wrap((lon - lon0) * D2R) / D2R, lat];
  const ring = outer.map(un);
  return hole.map(un).every(([x, y]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      const cross = (xj - xi) * (y - yi) - (yj - yi) * (x - xi);
      if (Math.abs(cross) < 1e-12 && x >= Math.min(xi, xj) && x <= Math.max(xi, xj) && y >= Math.min(yi, yj) && y <= Math.max(yi, yj)) return true;
      if ((yi > y) !== (yj > y) && x < xi + ((y - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
    }
    return inside;
  });
}

/** Geodesic area and perimeter of a Polygon or MultiPolygon: {area, perimeter}, two fact records.
 *  Rings after the first are holes: their area is subtracted, their edges counted in the perimeter.
 *  `opts`: {basis (area), perimeterBasis, source, complete, reason}. */
export function measurePolygon(geom, opts = {}) {
  const type = geom?.type;
  const area0 = baseOf(opts, { basis: 'boundary area (ground, on the ellipsoid)', geometry: type ?? null });
  const perim0 = baseOf({ basis: opts.perimeterBasis, source: opts.source }, { basis: 'boundary length (outer edge and any holes)', geometry: type ?? null });
  if (type !== 'Polygon' && type !== 'MultiPolygon') {
    const reason = `area and perimeter are measured for polygons; this geometry is ${type || 'missing'}`;
    return { area: fact({ ...area0, status: 'not applicable', reason }), perimeter: fact({ ...perim0, status: 'not applicable', reason }) };
  }
  const polys = type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  const fail = (reason) => ({ area: fact({ ...area0, reason }), perimeter: fact({ ...perim0, reason }) });
  if (!Array.isArray(polys) || !polys.length || polys.some((p) => !Array.isArray(p) || !p.length)) return fail('the geometry has no rings');
  let area = 0, perimeter = 0;
  for (const rings of polys) {
    const outer = ringMeasure(rings[0]);
    if (outer.error) return fail(outer.error);
    let holes = 0;
    perimeter += outer.perimeter;
    for (const ring of rings.slice(1)) {
      const hole = ringMeasure(ring);
      if (hole.error) return fail(hole.error);
      // A ring around a pole has no inside in degrees; its holes are taken as given.
      if (!outer.winding && !holeInside(hole.pts, outer.pts)) return fail('a hole lies outside its outer ring, so the polygon is not valid');
      holes += hole.area;
      perimeter += hole.perimeter;
    }
    if (holes > outer.area) return fail('the holes are larger than the outer ring, so the polygon is not valid');
    area += outer.area - holes;
  }
  return {
    area: graded(fact({ ...area0, value: area, unit: 'm2', status: 'known', precision: AREA_PRECISION }), opts),
    perimeter: graded(fact({ ...perim0, value: perimeter, unit: 'm', status: 'known', precision: LENGTH_PRECISION }), opts),
  };
}

const grouped = (n, digits) => n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** "3.2 mi (5.1 km)" for a length fact; under a tenth of a mile, feet and metres. Null for a fact with no value. */
export function formatLength(rec) {
  if (!rec || !Number.isFinite(rec.value)) return null;
  const m = rec.value;
  if (m < 0.1 * M_PER_MILE) return `${grouped(Math.round(m / M_PER_FOOT), 0)} ft (${grouped(Math.round(m), 0)} m)`;
  return `${grouped(m / M_PER_MILE, 1)} mi (${grouped(m / 1000, m < 10000 ? 2 : 1)} km)`;
}

/** "12.5 sq mi (32.4 km2)" for an area fact; under a square mile, acres and hectares. */
export function formatArea(rec) {
  if (!rec || !Number.isFinite(rec.value)) return null;
  const m2 = rec.value, SQ_MILE = M_PER_MILE * M_PER_MILE;
  if (m2 < SQ_MILE) return `${grouped(m2 / 4046.8564224, 1)} acres (${grouped(m2 / 10000, 1)} ha)`;
  return `${grouped(m2 / SQ_MILE, 1)} sq mi (${grouped(m2 / 1e6, 1)} km²)`;
}
