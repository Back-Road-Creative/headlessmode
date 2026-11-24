// Bounded GNIS names adapter: builds ArcGIS query URLs against the geonames
// MapServer (layers 3/5/6/7 -- source-registry.js `gnisNames`) and fetches a
// bounded set of named-terrain features, count-first, never unbounded.
//
// The service answered an injected `OR 1=1` where clause with a real count
// (measured 2026-09-25) -- every `where` this module builds passes reader text
// through escapeLiteral first and always wraps it in a single quoted literal, so
// there is nothing for a caller to concatenate raw.
import { SOURCES } from './source-registry.js';
import { fetchWithDeadline } from './request.js';
import { normalizeFeature, kindsForZoom, KINDS } from './terrain-names.js';

export { createSearchGuard } from './request.js';

const SOURCE = SOURCES.gnisNames;
const TIMEOUT_MS = SOURCE.timeoutMs;
const LAYERS_BY_ID = Object.fromEntries(SOURCE.layers.map((l) => [l.id, l]));
const DEFAULT_CAP = SOURCE.limits.recordBudgetPerExtent;
const PAGE_SIZE_CAP = SOURCE.limits.maxRecordCount;

/** Every measured featureclass, grouped by the layer it lives on -- the allow-list
 *  `buildNameSearchUrl`'s `kinds` filter draws from, so a class filter is always a
 *  fixed literal from this table, never arbitrary caller text. */
const CLASSES_BY_LAYER = {
  3: ['Populated Place'],
  5: ['Arch', 'Area', 'Arroyo', 'Basin', 'Beach', 'Bench', 'Bend', 'Cape', 'Cliff', 'Crater',
    'Flat', 'Gap', 'Island', 'Isthmus', 'Lava', 'Pillar', 'Plain', 'Range', 'Ridge', 'Slope',
    'Summit', 'Valley', 'Woods'],
  6: ['Canal', 'Stream'],
  7: ['Bar', 'Bay', 'Channel', 'Falls', 'Glacier', 'Gut', 'Lake', 'Levee', 'Rapids',
    'Reservoir', 'Sea', 'Spring', 'Swamp'],
};

function assertFiniteBbox(b) {
  const vals = [b?.minLon, b?.minLat, b?.maxLon, b?.maxLat];
  if (vals.some((v) => typeof v !== 'number' || !Number.isFinite(v))) throw new RangeError('bounds must carry finite minLon/minLat/maxLon/maxLat numbers.');
  if (b.minLon >= b.maxLon || b.minLat >= b.maxLat) throw new RangeError('bounds is empty or inverted.');
}

/** Doubles a single quote so text can never close the literal it is placed inside,
 *  and strips `%`/`_` (SQL LIKE wildcards) so a search term cannot widen its own
 *  match. Always produces one inert, single-quoted literal -- the only shape any
 *  `where` clause in this module builds from reader text. */
export function escapeLiteral(text) {
  const s = typeof text === 'string' ? text : '';
  return s.replace(/[%_]/g, '').replace(/'/g, "''");
}

/** Which layer a class belongs to, or null if it names no measured class. */
function layerForClass(cls) {
  for (const [layerId, classes] of Object.entries(CLASSES_BY_LAYER)) {
    if (classes.includes(cls)) return Number(layerId);
  }
  return null;
}

/** Groups a `kinds` list (featureclass strings) by the layer each belongs to.
 *  Throws on a class this module has no layer for -- an allow-list violation,
 *  never a class to silently drop. */
function groupByLayer(kinds) {
  const groups = new Map();
  for (const cls of kinds) {
    const layerId = layerForClass(cls);
    if (layerId === null) throw new RangeError(`${cls} is not a known GNIS featureclass.`);
    if (!groups.has(layerId)) groups.set(layerId, []);
    groups.get(layerId).push(cls);
  }
  return groups;
}

function classesWhere(classes) {
  return `gaz_featureclass IN (${classes.map((c) => `'${escapeLiteral(c)}'`).join(',')})`;
}

function envelopeParams(bounds) {
  const { minLon, minLat, maxLon, maxLat } = bounds;
  return {
    geometry: `${minLon},${minLat},${maxLon},${maxLat}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
  };
}

/** kinds must all belong to the SAME layer -- fetchBounded groups by layer and
 *  calls this once per group; a mixed-layer call is a programming error. */
function assertSingleLayer(kinds) {
  const groups = groupByLayer(kinds);
  if (groups.size !== 1) throw new RangeError('buildCountUrl/buildPageUrl take kinds from a single GNIS layer; fetchBounded groups by layer.');
  const [[layerId, classes]] = groups;
  return { layerId, classes };
}

export function buildCountUrl(bounds, kinds) {
  assertFiniteBbox(bounds);
  const { layerId, classes } = assertSingleLayer(kinds);
  const params = new URLSearchParams({
    ...envelopeParams(bounds), where: classesWhere(classes), returnCountOnly: 'true', f: 'json',
  });
  return `${LAYERS_BY_ID[layerId].queryUrl}?${params.toString()}`;
}

export function buildPageUrl(bounds, kinds, offset, pageSize) {
  assertFiniteBbox(bounds);
  const { layerId, classes } = assertSingleLayer(kinds);
  const capped = Math.max(1, Math.min(pageSize, PAGE_SIZE_CAP));
  const params = new URLSearchParams({
    ...envelopeParams(bounds), where: classesWhere(classes), outFields: LAYERS_BY_ID[layerId].fields.join(','),
    returnGeometry: 'true', outSR: '4326', orderByFields: 'gaz_id',
    resultOffset: String(offset), resultRecordCount: String(capped), f: 'json',
  });
  return `${LAYERS_BY_ID[layerId].queryUrl}?${params.toString()}`;
}

/** UPPER(gaz_name) LIKE '<escaped>%' -- a prefix search over a single layer,
 *  optionally narrowed by state and by class. Defaults to layer 5 (Landforms),
 *  the layer the 2026-09-25 search probes were measured against. */
export function buildNameSearchUrl(text, { state = null, kinds = null, limit = 20 } = {}) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length < 2 || trimmed.length > 120) throw new RangeError('text must be 2-120 characters (trimmed).');
  const layerId = kinds && kinds.length ? assertSingleLayer(kinds).layerId : 5;
  let where = `UPPER(gaz_name) LIKE '${escapeLiteral(trimmed.toUpperCase())}%'`;
  if (state) where += ` AND state_alpha = '${escapeLiteral(String(state).trim().toUpperCase())}'`;
  if (kinds && kinds.length) where += ` AND ${classesWhere(kinds)}`;
  const cappedLimit = Math.max(1, Math.min(limit, PAGE_SIZE_CAP));
  const params = new URLSearchParams({
    where, outFields: LAYERS_BY_ID[layerId].fields.join(','), returnGeometry: 'true',
    outSR: '4326', orderByFields: 'gaz_id', resultRecordCount: String(cappedLimit), f: 'json',
  });
  return `${LAYERS_BY_ID[layerId].queryUrl}?${params.toString()}`;
}

function readError(body) {
  const e = body && body.error;
  return e && (e.message || e.code) ? String(e.message || `ArcGIS error ${e.code}`) : null;
}

function readCount(body) {
  if (!body || readError(body)) return null;
  return Number.isFinite(Number(body.count)) ? Number(body.count) : null;
}

/** One request, capped at `timeoutMs` (default: the registry's per-source value for GNIS,
 *  20 s -- measured latency up to 31 s, so a flat 10 s would time out routinely; no
 *  automatic retry loop here -- a single slow/failed request fails the whole bounded
 *  fetch to `error`/`timeout` rather than masking it). The deadline, the caller-abort
 *  rule and the cleanup live in request.js; this adds the ArcGIS `error` body check. */
export async function fetchJson(url, { fetchImpl, signal, timeoutMs }) {
  const got = await fetchWithDeadline(url, { fetchImpl, signal, timeoutMs });
  if (!got.ok) return { ok: false, timedOut: got.status === 'timeout', error: got.error };
  const err = readError(got.body);
  if (err) return { ok: false, timedOut: false, error: err };
  return { ok: true, body: got.body };
}

/** A submission longer than this never reaches the network -- the caller shows a
 *  local "shorten your search" message instead. Documented cap, not a service
 *  limit: gaz_name itself is 120 characters (source-registry.js), but a query
 *  this long cannot plausibly prefix-match a real name. */
export const MAX_QUERY_LEN = 80;

/** Qualified GNIS name search (plan §4.3/§4.4): one bounded request for a reader-
 *  typed name, built through `buildNameSearchUrl` (escaped, allow-listed, capped)
 *  and timed the way `fetchBounded` times a page request. Never paginated and
 *  never count-first -- a search has its own small visible cap, not the bounded-
 *  viewport completeness contract. Returns:
 *  - `{ status: 'empty' }`               -- nothing to search (blank/whitespace).
 *  - `{ status: 'too-long', max }`       -- longer than MAX_QUERY_LEN; no request sent.
 *  - `{ status: 'aborted' }`             -- the caller's own `signal` cancelled this
 *                                           request (a newer submission superseded it).
 *  - `{ status: 'timeout' }`             -- exceeded `timeoutMs` (default: GNIS's registry timeoutMs).
 *  - `{ status: 'error', error }`        -- malformed where clause, HTTP failure, or
 *                                           unparseable JSON.
 *  - `{ status: 'ready', features, capped }` -- normalized, deduped by gaz_id;
 *    `capped` is true when the response returned as many rows as `limit` asked
 *    for, meaning more names may exist that this call did not see.
 */
export async function searchByName(text, {
  state = null, kinds = null, limit = 20,
  fetch: fetchImpl = globalThis.fetch, signal, timeoutMs = TIMEOUT_MS,
} = {}) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return { status: 'empty' };
  if (trimmed.length > MAX_QUERY_LEN) return { status: 'too-long', max: MAX_QUERY_LEN };

  let url;
  let layerId;
  try {
    url = buildNameSearchUrl(trimmed, { state, kinds, limit });
    layerId = kinds && kinds.length ? assertSingleLayer(kinds).layerId : 5;
  } catch (err) {
    return { status: 'error', error: err.message };
  }

  const result = await fetchJson(url, { fetchImpl, signal, timeoutMs });
  if (!result.ok) {
    if (signal && signal.aborted) return { status: 'aborted' };
    return result.timedOut ? { status: 'timeout' } : { status: 'error', error: result.error };
  }

  const rawFeatures = Array.isArray(result.body.features) ? result.body.features : [];
  const seen = new Map();
  for (const raw of rawFeatures) {
    const normalized = normalizeFeature(layerId, raw);
    if (normalized) seen.set(normalized.id, normalized);
  }
  const cappedLimit = Math.max(1, Math.min(limit, PAGE_SIZE_CAP));
  return { status: 'ready', features: [...seen.values()], capped: rawFeatures.length >= cappedLimit };
}

/** Two zoom levels per plan §4.3 ("closer" for a precise point, "wider" for a
 *  feature that reads as an area from the ground), keyed by the normalized
 *  `kind` terrain-names.js's KINDS table assigns. z12 -- the field-zoom floor
 *  (quiet-corners.js FIELD_MIN_ZOOM) -- is the documented fallback for a kind
 *  not listed here, never a rule applied to every feature. */
const CLOSE_ZOOM = 13;
const WIDE_ZOOM = 11;
const FALLBACK_ZOOM = 12;
const ZOOM_BY_KIND = Object.freeze({
  summit: CLOSE_ZOOM, gap: CLOSE_ZOOM,
  ridge: WIDE_ZOOM, place: WIDE_ZOOM,
});
export function zoomForKind(kind) {
  return Object.prototype.hasOwnProperty.call(ZOOM_BY_KIND, kind) ? ZOOM_BY_KIND[kind] : FALLBACK_ZOOM;
}

/** Rung order the budget is spent in: places, then summits/gaps/ridges/landforms,
 *  then water, then stream mouths (the priority ladder in terrain-names.js). */
const RUNG_ORDER = [3, 5, 7, 6];

/** Distinct kind slugs (terrain-names.js KINDS) of a class list, ladder order. */
function kindSlugs(layerId, classes) {
  const entries = classes.map((c) => KINDS[layerId][c]).filter(Boolean);
  return [...new Map(entries.sort((a, b) => a.priority - b.priority).map((e) => [e.kind, e])).keys()];
}

/** Count-first, bounded, deterministic. Returns:
 *  - `{ status: 'over-cap', count }`      -- a zero budget: nothing may be fetched.
 *  - `{ status: 'timeout' }`              -- a request exceeded its per-request cap.
 *  - `{ status: 'error', error }`         -- a malformed/failed response.
 *  - `{ status: 'capped', features, omittedKinds }` -- the extent holds more names than
 *                                             the budget: layer groups are counted and
 *                                             paged in rung order, the group that
 *                                             straddles the budget is paged with the
 *                                             remaining budget, later groups are
 *                                             skipped and listed in omittedKinds.
 *  - `{ status: 'partial', features }`    -- paging finished but the fetched count
 *                                             drifted from the counted total (the
 *                                             service changed between the two).
 *  - `{ status: 'ready', features }`      -- complete, deduped by gaz_id.
 *  `kinds` may span multiple layers; each layer is counted and paged separately and
 *  the results are merged. With `zoom`, only classes kindsForZoom(zoom) allows are
 *  requested (none at all below the lowest minZoom). */
export async function fetchBounded(bounds, kinds, { fetch: fetchImpl = globalThis.fetch, signal, cap = DEFAULT_CAP, zoom } = {}) {
  assertFiniteBbox(bounds);
  let wanted = kinds;
  if (zoom !== undefined) {
    const allowed = new Set(kindsForZoom(zoom));
    wanted = kinds.filter((c) => allowed.has(c));
  }
  const groups = groupByLayer(wanted);
  const timeoutMs = TIMEOUT_MS;
  const ordered = RUNG_ORDER.filter((l) => groups.has(l)).map((l) => [l, groups.get(l)]);

  // Count and decide, rung by rung, what the budget buys.
  const plan = [];
  const omitted = [];
  let spent = 0;
  let capped = false;
  for (const [layerId, classes] of ordered) {
    if (capped) { omitted.push(...kindSlugs(layerId, classes)); continue; }
    const result = await fetchJson(buildCountUrl(bounds, classes), { fetchImpl, signal, timeoutMs });
    if (!result.ok) return result.timedOut ? { status: 'timeout' } : { status: 'error', error: result.error };
    const count = readCount(result.body);
    if (count === null) return { status: 'error', error: 'GNIS count query returned no usable count.' };
    if (count === 0) continue;
    const remaining = cap - spent;
    if (remaining <= 0) return { status: 'over-cap', count: spent + count };
    if (count <= remaining) { plan.push({ layerId, classes, count, limit: count }); spent += count; continue; }
    plan.push({ layerId, classes, count, limit: remaining });
    spent += remaining;
    capped = true;
    omitted.push(...kindSlugs(layerId, classes));
  }

  const seen = new Map();
  let rawFetched = 0;
  let countedTotal = 0;
  for (const { layerId, classes, count, limit } of plan) {
    countedTotal += count;
    let offset = 0;
    for (;;) {
      const url = buildPageUrl(bounds, classes, offset, Math.min(PAGE_SIZE_CAP, limit - offset));
      const result = await fetchJson(url, { fetchImpl, signal, timeoutMs });
      if (!result.ok) return result.timedOut ? { status: 'timeout' } : { status: 'error', error: result.error };
      const rawFeatures = Array.isArray(result.body.features) ? result.body.features : [];
      rawFetched += rawFeatures.length;
      for (const raw of rawFeatures) {
        const normalized = normalizeFeature(layerId, raw);
        if (normalized) seen.set(normalized.id, normalized);
      }
      offset += rawFeatures.length;
      if (result.body.exceededTransferLimit === true && offset < limit && rawFeatures.length > 0) continue;
      break;
    }
  }

  const features = [...seen.values()];
  if (capped) return { status: 'capped', features, omittedKinds: [...new Set(omitted)] };
  return { status: rawFetched === countedTotal ? 'ready' : 'partial', features };
}
