// Pure geometry for the Quiet Corners map planner: WGS84 <-> UTM, zone choice, printability, 7.5-minute cells.
// No DOM, no network, no dependencies. Transverse Mercator via the Krüger series in the form of
// Karney, C.F.F. (2011), "Transverse Mercator with an accuracy of a few nanometers", J. Geodesy 85,
// with the α/β coefficients carried to n⁶ (sub-millimetre well past a zone's ±3°). Scale k and grid
// convergence γ come from the same series (Karney eqs. 26–28).
export const WGS84 = { a: 6378137, f: 1 / 298.257223563 }; // semi-major axis (m), flattening
export const UTM = { k0: 0.9996, falseEasting: 500000, falseNorthingSouth: 10000000 };
export const MAX_SCALE_DEVIATION = 0.0015; // |k − 1| allowed anywhere on a job
export const CELL_DEG = 0.125; // 7.5 minutes
const CONUS = { minLon: -125, minLat: 24, maxLon: -66, maxLat: 50 };
const D2R = Math.PI / 180;

// Ellipsoid-derived constants (third flattening n, rectifying radius A, eccentricity e).
const { a, f } = WGS84;
const n = f / (2 - f);
const n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;
const A = (a / (1 + n)) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
const e = Math.sqrt(f * (2 - f));
const ALPHA = [
  n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180 - 127 * n5 / 288 + 7891 * n6 / 37800,
  13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440 + 281 * n5 / 630 - 1983433 * n6 / 1935360,
  61 * n3 / 240 - 103 * n4 / 140 + 15061 * n5 / 26880 + 167603 * n6 / 181440,
  49561 * n4 / 161280 - 179 * n5 / 168 + 6601661 * n6 / 7257600,
  34729 * n5 / 80640 - 3418889 * n6 / 1995840,
  212378941 * n6 / 319334400,
];
const BETA = [
  n / 2 - 2 * n2 / 3 + 37 * n3 / 96 - n4 / 360 - 81 * n5 / 512 + 96199 * n6 / 604800,
  n2 / 48 + n3 / 15 - 437 * n4 / 1440 + 46 * n5 / 105 - 1118711 * n6 / 3870720,
  17 * n3 / 480 - 37 * n4 / 840 - 209 * n5 / 4480 + 5569 * n6 / 90720,
  4397 * n4 / 161280 - 11 * n5 / 504 - 830251 * n6 / 7257600,
  4583 * n5 / 161280 - 108847 * n6 / 3991680,
  20648693 * n6 / 638668800,
];

// Zone = floor((lon+180)/6)+1: a boundary meridian belongs to the zone east of it (−84 → 17); lon 180 → 60.
// CONUS MVP: the Norway/Svalbard zone exceptions are deliberately not applied.
export function utmZoneForLon(lonDeg) {
  return Math.min(60, Math.floor((lonDeg + 180) / 6) + 1);
}
export function hemisphereForLat(latDeg) {
  return latDeg < 0 ? 'S' : 'N';
}
const centralMeridianDeg = (zone) => (zone - 1) * 6 - 180 + 3;
export function zoneForCentroid(b) {
  const zone = utmZoneForLon((b.minLon + b.maxLon) / 2);
  return { zone, hemisphere: hemisphereForLat((b.minLat + b.maxLat) / 2), centralMeridianDeg: centralMeridianDeg(zone) };
}

export function forward(latDeg, lonDeg, zone, hemisphere) {
  const phi = latDeg * D2R;
  const lam = (lonDeg - centralMeridianDeg(zone)) * D2R;
  const tau = Math.tan(phi);
  const sigma = Math.sinh(e * Math.atanh((e * tau) / Math.sqrt(1 + tau * tau)));
  const tauP = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau); // conformal latitude
  const cosLam = Math.cos(lam), sinLam = Math.sin(lam);
  const xiP = Math.atan2(tauP, cosLam);
  const etaP = Math.asinh(sinLam / Math.sqrt(tauP * tauP + cosLam * cosLam));
  let xi = xiP, eta = etaP, p = 1, q = 0;
  for (let j = 1; j <= 6; j++) {
    const s = Math.sin(2 * j * xiP), c = Math.cos(2 * j * xiP), sh = Math.sinh(2 * j * etaP), ch = Math.cosh(2 * j * etaP);
    xi += ALPHA[j - 1] * s * ch;
    eta += ALPHA[j - 1] * c * sh;
    p += 2 * j * ALPHA[j - 1] * c * ch;
    q += 2 * j * ALPHA[j - 1] * s * sh;
  }
  const gamma = Math.atan((tauP / Math.sqrt(1 + tauP * tauP)) * Math.tan(lam)) + Math.atan2(q, p);
  const sinPhi = Math.sin(phi);
  const k = UTM.k0 * (Math.sqrt(1 - e * e * sinPhi * sinPhi) * Math.sqrt(1 + tau * tau) / Math.sqrt(tauP * tauP + cosLam * cosLam)) * (A / a) * Math.hypot(p, q);
  const y = UTM.k0 * A * xi + (hemisphere === 'S' ? UTM.falseNorthingSouth : 0);
  return { easting: UTM.k0 * A * eta + UTM.falseEasting, northing: y, scaleFactor: k, convergenceDeg: gamma / D2R };
}

export function inverse(easting, northing, zone, hemisphere) {
  const xi = (northing - (hemisphere === 'S' ? UTM.falseNorthingSouth : 0)) / (UTM.k0 * A);
  const eta = (easting - UTM.falseEasting) / (UTM.k0 * A);
  let xiP = xi, etaP = eta;
  for (let j = 1; j <= 6; j++) {
    xiP -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etaP -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const sh = Math.sinh(etaP), cosXi = Math.cos(xiP);
  const tauP = Math.sin(xiP) / Math.sqrt(sh * sh + cosXi * cosXi);
  let tau = tauP, d; // Newton iteration from conformal to geodetic latitude
  do {
    const s = Math.sinh(e * Math.atanh((e * tau) / Math.sqrt(1 + tau * tau)));
    const t = tau * Math.sqrt(1 + s * s) - s * Math.sqrt(1 + tau * tau);
    d = ((tauP - t) / Math.sqrt(1 + t * t)) * ((1 + (1 - e * e) * tau * tau) / ((1 - e * e) * Math.sqrt(1 + tau * tau)));
    tau += d;
  } while (Math.abs(d) > 1e-14);
  return { lat: Math.atan(tau) / D2R, lon: centralMeridianDeg(zone) + Math.atan2(sh, cosXi) / D2R };
}

// k grows monotonically with distance from the central meridian, so the extreme |k−1| over a
// rectangle lies on its boundary: corners plus `samplesPerEdge` points along each edge suffice.
export function projectBbox(b, zone, hemisphere, samplesPerEdge = 8) {
  const out = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, maxScaleDeviation: 0 };
  for (let i = 0; i <= samplesPerEdge; i++) {
    const t = i / samplesPerEdge;
    const lon = b.minLon + t * (b.maxLon - b.minLon), lat = b.minLat + t * (b.maxLat - b.minLat);
    for (const [la, lo] of [[b.minLat, lon], [b.maxLat, lon], [lat, b.minLon], [lat, b.maxLon]]) {
      const r = forward(la, lo, zone, hemisphere);
      out.minX = Math.min(out.minX, r.easting); out.maxX = Math.max(out.maxX, r.easting);
      out.minY = Math.min(out.minY, r.northing); out.maxY = Math.max(out.maxY, r.northing);
      out.maxScaleDeviation = Math.max(out.maxScaleDeviation, Math.abs(r.scaleFactor - 1));
    }
  }
  return out;
}

export function assertPrintable(b) {
  const vals = [b.minLon, b.minLat, b.maxLon, b.maxLat];
  if (vals.some((v) => typeof v !== 'number' || !Number.isFinite(v))) throw new RangeError('Area must be a finite lon/lat box.');
  if (b.minLon > b.maxLon && Math.abs(b.maxLon - b.minLon) > 180) throw new RangeError('Area crosses the antimeridian (±180°); choose one side.');
  if (b.minLon >= b.maxLon || b.minLat >= b.maxLat) throw new RangeError('Area is empty or inverted (min must be less than max).');
  if (b.minLon < CONUS.minLon || b.maxLon > CONUS.maxLon || b.minLat < CONUS.minLat || b.maxLat > CONUS.maxLat) {
    throw new RangeError('Area must lie within lat 24…50, lon −125…−66: contiguous United States only.');
  }
  const { zone, hemisphere } = zoneForCentroid(b);
  const extent = projectBbox(b, zone, hemisphere);
  if (extent.maxScaleDeviation > MAX_SCALE_DEVIATION) {
    throw new RangeError(`Area reaches too far from UTM zone ${zone}'s central meridian: scale deviation ${extent.maxScaleDeviation.toFixed(5)} exceeds ${MAX_SCALE_DEVIATION}. Print it true to scale by splitting the area into smaller jobs, one per zone.`);
  }
  return { zone, hemisphere, extent };
}

// 7.5-minute cells: eighth-degree tiles on a global grid anchored at lon 0 / lat 0 (the USGS quad grid).
const cellAt = (col, row) => ({ minLon: col * CELL_DEG, minLat: row * CELL_DEG, maxLon: (col + 1) * CELL_DEG, maxLat: (row + 1) * CELL_DEG });
export function cellForPoint(latDeg, lonDeg) {
  return cellAt(Math.floor(lonDeg / CELL_DEG), Math.floor(latDeg / CELL_DEG));
}
export function cellNeighbors(c) {
  const col = Math.round(c.minLon / CELL_DEG), row = Math.round(c.minLat / CELL_DEG);
  return { n: cellAt(col, row + 1), s: cellAt(col, row - 1), e: cellAt(col + 1, row), w: cellAt(col - 1, row) };
}
// Closed-interval intersection: a bbox edge lying exactly on a cell line pulls in the cells on both
// sides (matches the national map-index service, which over-includes rather than drops a sheet).
export function cellsForBbox(b) {
  const c0 = Math.ceil(b.minLon / CELL_DEG) - 1, c1 = Math.floor(b.maxLon / CELL_DEG);
  const r0 = Math.ceil(b.minLat / CELL_DEG) - 1, r1 = Math.floor(b.maxLat / CELL_DEG);
  const cells = [];
  for (let row = r1; row >= r0; row--) for (let col = c0; col <= c1; col++) cells.push(cellAt(col, row));
  return cells;
}
export function bboxOfCells(cells) {
  return {
    minLon: Math.min(...cells.map((c) => c.minLon)), minLat: Math.min(...cells.map((c) => c.minLat)),
    maxLon: Math.max(...cells.map((c) => c.maxLon)), maxLat: Math.max(...cells.map((c) => c.maxLat)),
  };
}

// Stable ID for a quad-set selection: "row:col", row/col the same signed integers cellNeighbors
// derives from minLat/minLon. Arithmetic, not a network lookup, so it never goes stale.
const CELL_ID_RE = /^-?\d+:-?\d+$/;
export function cellId(c) {
  return `${Math.round(c.minLat / CELL_DEG)}:${Math.round(c.minLon / CELL_DEG)}`;
}
export function cellFromId(id) {
  if (typeof id !== 'string' || !CELL_ID_RE.test(id)) throw new RangeError(`malformed quadrangle id: ${JSON.stringify(id)}`);
  const [row, col] = id.split(':').map(Number);
  return cellAt(col, row);
}
// Open-interval box -> quads: only cells whose INTERIOR meets the box's interior. A box edge lying
// exactly on a cell line (e.g. EXAMPLE_AREA's minLat 35.0) must not pull in the outside cell the way
// cellsForBbox's closed interval deliberately does (:136-144) — that would silently grow the
// selection past what the box actually covers. Row-major from the north-west, like cellsForBbox.
export function quadsCoveringBox(b) {
  const r0 = Math.floor(b.minLat / CELL_DEG), r1 = Math.ceil(b.maxLat / CELL_DEG) - 1;
  const c0 = Math.floor(b.minLon / CELL_DEG), c1 = Math.ceil(b.maxLon / CELL_DEG) - 1;
  const ids = [];
  for (let row = r1; row >= r0; row--) for (let col = c0; col <= c1; col++) ids.push(`${row}:${col}`);
  return ids;
}
