// USGS 3DEP elevation: how far a trail climbs.
//
// Length alone does not tell you whether a trail is a stroll or a day's work.
// Distance plus elevation gain is what AllTrails sells as a difficulty score, and
// 3DEP is public domain — no licence, no key, no terms page.
//
// getSamples takes MANY points in one request, which is what makes this practical:
// a trail is sampled along its length in a handful of calls rather than one call
// per vertex. Verified 2026-09-06 against the Standing Indian quad: five points
// returned 1217.9, 823.5, 1341.0, 1265.3, 1430.1 m.
//
// NOT used for a slope tint, deliberately. The service does expose a
// `Slope Degrees` raster function and it returns correct values through
// `identify` (17° at a Rainier point, 29° at Standing Indian). But `exportImage`
// with a Remap/Colormap threshold chain returned a BYTE-IDENTICAL image for
// Mount Rainier and for North Carolina — a constant, not terrain. A slope tint
// built on that would have printed nothing while appearing to work. The tint is
// blocked on a spike, not shipped broken. See the plan's §4 note.
import { measureLength } from './measure.js';

const SERVICE = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer';

// One request carries many points; this bounds how many, so a long trail becomes
// a few calls rather than one enormous URL.
export const MAX_POINTS_PER_CALL = 200;

/** Evenly spaced points along a polyline, in [lon, lat]. Always includes both
 *  ends, so the climb to a summit at the far end is never missed. */
export function samplePointsAlong(paths = [], maxPoints = 60) {
  const pts = paths.flat().filter((p) => Array.isArray(p) && p.length === 2);
  if (pts.length <= maxPoints) return pts;
  const step = (pts.length - 1) / (maxPoints - 1);
  const out = [];
  for (let i = 0; i < maxPoints; i++) out.push(pts[Math.round(i * step)]);
  return out;
}

/** Total climb and descent, in metres, from an elevation profile. Nulls are
 *  bridged rather than treated as a drop to zero — a NoData pixel over water or
 *  off the DEM edge would otherwise invent a thousand-metre cliff. */
export function gainAndLoss(elevations = []) {
  let gain = 0, loss = 0, prev = null, sampled = 0;
  for (const e of elevations) {
    if (e === null || e === undefined || !Number.isFinite(e)) continue;
    sampled++;
    if (prev !== null) { const d = e - prev; if (d > 0) gain += d; else loss -= d; }
    prev = e;
  }
  return {
    gainM: Math.round(gain), lossM: Math.round(loss), sampled,
    minM: sampled ? Math.round(Math.min(...elevations.filter(Number.isFinite))) : null,
    maxM: sampled ? Math.round(Math.max(...elevations.filter(Number.isFinite))) : null,
  };
}

/** Ground length of a lon/lat polyline in metres, geodesic on WGS84 (measure.js). A path of fewer than
 *  two points has no length and adds 0; a path that cannot be measured (a bad coordinate, a nearly
 *  antipodal segment) makes the whole answer null, because a total that silently left it out is a
 *  wrong number printed as a right one. */
export function lengthMeters(paths = []) {
  let total = 0;
  for (const path of paths) {
    if (Array.isArray(path) && path.length < 2) continue;
    const r = measureLength({ type: 'LineString', coordinates: path });
    if (r.status !== 'known') return null;
    total += r.value;
  }
  return total;
}

/** Elevations for a list of [lon, lat] points, in order, chunked into requests. */
export async function fetchElevations({ points, fetchImpl = fetch, signal } = {}) {
  const out = [];
  for (let i = 0; i < points.length; i += MAX_POINTS_PER_CALL) {
    const chunk = points.slice(i, i + MAX_POINTS_PER_CALL);
    const body = new URLSearchParams({
      geometry: JSON.stringify({ points: chunk, spatialReference: { wkid: 4326 } }),
      geometryType: 'esriGeometryMultipoint',
      returnFirstValueOnly: 'true',
      f: 'json',
    });
    const res = await fetchImpl(`${SERVICE}/getSamples`, { method: 'POST', body, signal });
    if (!res.ok) throw new Error(`Elevation: the service answered ${res.status}.`);
    const json = await res.json();
    if (json.error) throw new Error(`Elevation: ${json.error.message || 'the service refused the query.'}`);
    // getSamples may return fewer samples than points asked for (NoData is
    // omitted, not nulled), so place each by its own index rather than by order.
    const byIndex = new Map((json.samples || []).map((s) => [Number(s.locationId ?? -1), s.value]));
    for (let k = 0; k < chunk.length; k++) {
      const raw = byIndex.has(k) ? byIndex.get(k) : (json.samples || [])[k]?.value;
      const n = raw === 'NoData' || raw === null || raw === undefined ? null : Number(raw);
      out.push(Number.isFinite(n) ? n : null);
    }
  }
  return out;
}

/** A trail's trip facts: length, climb, and the sheets it crosses. */
export async function profileFor(feature, { fetchImpl = fetch, maxPoints = 60, signal } = {}) {
  const points = samplePointsAlong(feature.paths, maxPoints);
  const elevations = points.length ? await fetchElevations({ points, fetchImpl, signal }) : [];
  const lengthM = lengthMeters(feature.paths);
  return { ...gainAndLoss(elevations), lengthM: lengthM === null ? null : Math.round(lengthM), points: points.length };
}

export const ELEVATION_SOURCE = Object.freeze({
  id: 'usgs3dep',
  name: 'USGS 3DEP elevation',
  origin: new URL(SERVICE).origin,
  serviceUrl: SERVICE,
  attribution: 'USGS 3D Elevation Program (3DEP)',
  coverageSemantics: 'Elevation gain is computed from points sampled along the drawn line, so it '
    + 'reflects the mapped route rather than the tread underfoot, and a short steep pitch between '
    + 'samples can be missed. Treat it as a planning figure, not a survey.',
  // The same source described for ONE point, the name card's elevation line, where the
  // drawn-line wording above does not apply. Taken from source-registry.js: the usgs3dep
  // entry's `claim: 'model'` note (a gridded surface interpolated between lidar returns,
  // not a reading at your point) and the usgs3depSurface entry, on the same 3DEP
  // ImageServer, which states the elevation is bare earth.
  pointSemantics: 'The value comes from a gridded surface interpolated between lidar returns, not '
    + 'a reading at this exact point. It is bare earth, so trees, buildings and snow are not in '
    + 'it. Treat it as approximate guidance.',
  // QQA-09. Searched the repo (source-registry.js usgs3dep and usgs3depSurface, this file): neither
  // the vertical datum nor the grid resolution is stated anywhere, so neither is guessed here.
  quantity: 'ground elevation at the sampled point',
  verticalReference: 'vertical reference not stated by source',
  resolution: 'resolution not stated by source',
});

/** One sampled elevation as a fact record. `metres` is what fetchElevations answered: a number
 *  (0 is a real elevation) or null/NoData, which is `unavailable` -- unknown, never 0. */
export function pointElevationFact(metres) {
  const has = typeof metres === 'number' && Number.isFinite(metres);
  const { quantity, verticalReference, resolution, attribution } = ELEVATION_SOURCE;
  return { value: has ? metres : null, unit: has ? 'm' : null, status: has ? 'approximate' : 'unavailable', method: 'published',
    basis: quantity, geometry: 'Point', precision: resolution, source: attribution, verticalReference, resolution,
    ...(has ? { reason: 'a surface interpolated between lidar returns, not a reading at this exact point' }
      : { reason: 'the source returned no elevation (no data) for this point' }) };
}
