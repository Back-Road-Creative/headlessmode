// Named rivers and creeks from the National Hydrography Dataset flowlines (registry id
// `nhdFlowlines`). The GNIS stream layer names a stream only at its MOUTH, one point that a
// view upstream of it never contains; this reads the line itself, so a name is anchored on the
// reach that is in view. Two requests, both bounded:
//   1. one grouped-statistics request: summed reach length per gnis_id over the view. A single
//      reach is about 0.57 km, so ranking reaches (rather than sums) would put ditches above
//      the Bitterroot. The service rejects ordering by the statistic alias (measured
//      2026-10-06), so the answer (one row per name, well inside maxRecordCount) is ranked here.
//   2. geometry for the chosen names only, never for every reach in the view.
// Returns {status, features, omittedKinds} like source-terrain-names.js fetchBounded:
//   ready   every name asked was answered       capped  more names (or reaches) than one answer carries
//   empty   below the lowest zoom: no request    timeout / error / aborted  the fetchJson shapes
import { SOURCES, REQUEST_POLICY } from './source-registry.js';
import { KINDS } from './terrain-names.js';
import { fetchJson } from './source-terrain-names.js';
import { envelope } from './arcgis-view.js';

const SRC = SOURCES.nhdFlowlines;
const LAYERS = SRC.layers.map((l) => {
  const [id, name, length, ftype] = l.fields;
  return { ...l, f: { id, name, length, ftype } };
});

/** The zoom each kind first appears at: terrain-names.js KINDS is the one record. At z9-10 the
 *  view holds hundreds of named creeks (614 names over the Stevensville z9 extent) and only
 *  the few big rivers read as orientation; z11 (44 names) is where creeks start to be worth a
 *  label. */
export const STREAM_MIN_ZOOM = Object.freeze({ river: KINDS.nhd.River.minZoom, creek: KINDS.nhd.Creek.minZoom });

/** How many names of a kind one view keeps, longest first. */
export function streamBudget(kind, zoom) {
  if (kind === 'river') return zoom <= 9 ? 6 : zoom === 10 ? 8 : 10;
  return zoom <= 11 ? 12 : zoom === 12 ? 20 : 30;
}

/** 'river' for a name ending River or Fork (the Bitterroot River, Clark Fork), else 'creek'. */
export function streamKindOf(name) {
  return /\b(River|Fork)$/.test(name) ? 'river' : 'creek';
}

/** The NHD layer a zoom reads, or null below the lowest river zoom. */
export function nhdLayerForZoom(zoom) {
  if (!Number.isFinite(zoom) || zoom < STREAM_MIN_ZOOM.river) return null;
  return LAYERS.find((l) => zoom >= l.zooms.min && zoom <= l.zooms.max) || null;
}

const ftypeClause = (l) => `${l.f.ftype}=${typeof l.ftype === 'string' ? `'${l.ftype}'` : l.ftype}`;

function checkBbox(b) {
  const v = [b?.minLon, b?.minLat, b?.maxLon, b?.maxLat];
  if (v.some((x) => typeof x !== 'number' || !Number.isFinite(x))) throw new RangeError('bounds must carry finite minLon/minLat/maxLon/maxLat numbers.');
  if (b.minLon >= b.maxLon || b.minLat >= b.maxLat) throw new RangeError('bounds is empty or inverted.');
}

const viewParams = (bounds) => ({ geometry: envelope(bounds), geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects' });

function layerOrThrow(zoom) {
  const layer = nhdLayerForZoom(zoom);
  if (!layer) throw new RangeError(`no stream layer is read at zoom ${zoom}.`);
  return layer;
}

/** Summed reach length per name over the view. Below the creek floor only River/Fork names are
 *  asked, so a river is never crowded out of the 2,000-row page by the creeks around it. */
export function buildStatsUrl(bounds, zoom) {
  checkBbox(bounds);
  const l = layerOrThrow(zoom);
  const clauses = [`${l.f.name} <> ' '`, ftypeClause(l)];
  if (zoom < STREAM_MIN_ZOOM.creek) clauses.push(`(${l.f.name} LIKE '% River' OR ${l.f.name} LIKE '% Fork')`);
  const params = new URLSearchParams({
    where: clauses.join(' AND '), ...viewParams(bounds),
    groupByFieldsForStatistics: `${l.f.id},${l.f.name}`,
    outStatistics: JSON.stringify([{ statisticType: 'sum', onStatisticField: l.f.length, outStatisticFieldName: 'total_km' }]),
    f: 'json',
  });
  return `${l.queryUrl}?${params}`;
}

/** Reaches of the chosen names, in lon/lat. Ids are digits only: anything else never reaches `where`. */
export function buildGeometryUrl(bounds, zoom, ids) {
  checkBbox(bounds);
  const l = layerOrThrow(zoom);
  if (!ids.length || ids.some((id) => !/^\d+$/.test(id))) throw new RangeError('ids must be a non-empty list of digit strings.');
  const params = new URLSearchParams({
    where: `${l.f.id} IN (${ids.map((id) => `'${id}'`).join(',')}) AND ${ftypeClause(l)}`, ...viewParams(bounds),
    outFields: l.fields.join(','), returnGeometry: 'true', outSR: '4326', geometryPrecision: '4',
    resultRecordCount: String(SRC.limits.maxRecordCount), f: 'json',
  });
  return `${l.queryUrl}?${params}`;
}

/** The part of segment a->b inside the box (Liang-Barsky), or null. Points are [lon, lat]. */
function clipSegment(a, b, box) {
  let t0 = 0; let t1 = 1;
  const dx = b[0] - a[0]; const dy = b[1] - a[1];
  for (const [p, q] of [[-dx, a[0] - box.minLon], [dx, box.maxLon - a[0]], [-dy, a[1] - box.minLat], [dy, box.maxLat - a[1]]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [[a[0] + t0 * dx, a[1] + t0 * dy], [a[0] + t1 * dx, a[1] + t1 * dy]];
}

/** One reach's in-view pieces, and their length in degrees (longitude shrunk by latitude so the
 *  half-way point is not skewed east-west). */
function inView(reach, box) {
  const pieces = [];
  let length = 0;
  const k = Math.cos(((box.minLat + box.maxLat) / 2) * Math.PI / 180);
  for (const path of reach.geometry?.paths || []) {
    for (let i = 1; i < path.length; i++) {
      const c = clipSegment(path[i - 1], path[i], box);
      if (!c) continue;
      const len = Math.hypot((c[1][0] - c[0][0]) * k, c[1][1] - c[0][1]);
      pieces.push({ seg: c, len });
      length += len;
    }
  }
  return { pieces, length };
}

/** The point half-way along the in-view length of a reach's longest in-view piece set. */
function midpoint({ pieces, length }) {
  let left = length / 2;
  for (const { seg, len } of pieces) {
    if (left <= len || seg === pieces[pieces.length - 1].seg) {
      const t = len > 0 ? Math.min(1, left / len) : 0;
      return [seg[0][1] + t * (seg[1][1] - seg[0][1]), seg[0][0] + t * (seg[1][0] - seg[0][0])];
    }
    left -= len;
  }
  return null;
}

/** [lat, lon] on the longest in-view reach of one name, or null when no reach is in view. */
export function anchorForReaches(reaches, bounds) {
  let best = null;
  for (const r of reaches) {
    const v = inView(r, bounds);
    if (v.length > 0 && (!best || v.length > best.length)) best = v;
  }
  return best ? midpoint(best) : null;
}

const cleanName = (raw) => (typeof raw === 'string' ? raw.replace(/[<>]/g, '').trim() : '');
const failure = (result, signal) => {
  if (signal && signal.aborted) return { status: 'aborted', features: [], omittedKinds: [] };
  return result.timedOut ? { status: 'timeout', features: [], omittedKinds: [] } : { status: 'error', error: result.error, features: [], omittedKinds: [] };
};

/** Named rivers and creeks in a view at a zoom: the longest names per kind, one record each,
 *  anchored on the reach in view. */
export async function fetchStreamNames(bounds, { zoom, fetch: fetchImpl = globalThis.fetch, signal, timeoutMs = REQUEST_POLICY.timeoutMs } = {}) {
  checkBbox(bounds);
  const layer = nhdLayerForZoom(zoom);
  if (!layer) return { status: 'empty', features: [], omittedKinds: [] };

  const stats = await fetchJson(buildStatsUrl(bounds, zoom), { fetchImpl, signal, timeoutMs });
  if (!stats.ok) return failure(stats, signal);
  const rows = Array.isArray(stats.body.features) ? stats.body.features : [];
  let capped = stats.body.exceededTransferLimit === true;

  const byKind = { river: [], creek: [] };
  for (const row of rows) {
    const a = row.attributes || {};
    const rawId = String(a[layer.f.id] ?? '').trim();
    const name = cleanName(a[layer.f.name]);
    const km = Number(a.total_km);
    if (!/^\d+$/.test(rawId) || !name || !Number.isFinite(km)) continue;
    const kind = streamKindOf(name);
    if (zoom < STREAM_MIN_ZOOM[kind]) continue;
    byKind[kind].push({ id: String(Number(rawId)), rawId, name, kind, km });
  }
  const chosen = [];
  const omittedKinds = [];
  for (const kind of ['river', 'creek']) {
    const ranked = byKind[kind].sort((x, y) => y.km - x.km || x.name.localeCompare(y.name) || (x.id < y.id ? -1 : 1));
    const keep = streamBudget(kind, zoom);
    if (ranked.length > keep) { capped = true; omittedKinds.push(kind); }
    chosen.push(...ranked.slice(0, keep));
  }
  if (!chosen.length) return { status: capped ? 'capped' : 'ready', features: [], omittedKinds };

  const geo = await fetchJson(buildGeometryUrl(bounds, zoom, chosen.map((c) => c.rawId)), { fetchImpl, signal, timeoutMs });
  if (!geo.ok) return failure(geo, signal);
  if (geo.body.exceededTransferLimit === true) capped = true;
  const reaches = new Map();
  for (const f of Array.isArray(geo.body.features) ? geo.body.features : []) {
    const a = f.attributes || {};
    if (a[layer.f.ftype] !== layer.ftype) continue; // the request already asks for this; a service that ignores it is not believed
    const id = String(Number(String(a[layer.f.id] ?? '').trim()));
    if (!reaches.has(id)) reaches.set(id, []);
    reaches.get(id).push(f);
  }

  const features = [];
  for (const c of chosen) {
    const anchor = anchorForReaches(reaches.get(c.id) || [], bounds);
    if (!anchor) continue;
    features.push({
      id: `nhd:${c.id}`, name: c.name, kind: c.kind, cls: c.kind === 'river' ? 'River' : 'Creek',
      state: null, county: null, anchor, pointCount: 1, layer: 'nhd', historical: false,
      lengthKm: Math.round(c.km * 10) / 10,
    });
  }
  return { status: capped ? 'capped' : 'ready', features, omittedKinds };
}
