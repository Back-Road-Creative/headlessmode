// USGS 7.5-minute quadrangle index adapter: fetches quad NAMES for a bounded area or a
// name search from map_indices layer 10, cross-checking each service polygon against the
// arithmetic cell geometry.js already computes from lon/lat alone.
import { SOURCES, REQUEST_POLICY } from './source-registry.js';
import { cellForPoint, cellNeighbors, cellsForBbox } from './geometry.js';
import { fetchWithDeadline } from './request.js';
import { MAX_PAGES } from './arcgis-pager.js';

export { MAX_PAGES };

const LAYER = SOURCES.usgsQuadIndex.layers[0];
const TIMEOUT_MS = SOURCES.usgsQuadIndex.timeoutMs;
export const OUT_FIELDS = LAYER.fields;
const MAX_BBOX_DEG = 2;
const TOLERANCE_DEG = 1e-3;

function assertFiniteBbox(b) {
  const vals = [b?.minLon, b?.minLat, b?.maxLon, b?.maxLat];
  if (vals.some((v) => typeof v !== 'number' || !Number.isFinite(v))) throw new RangeError('bboxLonLat must carry finite minLon/minLat/maxLon/maxLat numbers.');
  if (b.minLon >= b.maxLon || b.minLat >= b.maxLat) throw new RangeError('bboxLonLat is empty or inverted.');
  if (b.maxLon - b.minLon > MAX_BBOX_DEG || b.maxLat - b.minLat > MAX_BBOX_DEG) throw new RangeError(`bboxLonLat exceeds ${MAX_BBOX_DEG}° in one dimension; query a bounded area.`);
}

export function buildBboxQueryUrl({ bboxLonLat, offset = 0, pageSize = 200 }) {
  assertFiniteBbox(bboxLonLat);
  const { minLon, minLat, maxLon, maxLat } = bboxLonLat;
  const params = new URLSearchParams({
    geometry: `${minLon},${minLat},${maxLon},${maxLat}`, geometryType: 'esriGeometryEnvelope', inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', outFields: OUT_FIELDS.join(','), returnGeometry: 'true', outSR: '4326',
    resultOffset: String(offset), resultRecordCount: String(pageSize), f: 'json',
  });
  return `${LAYER.queryUrl}?${params.toString()}`;
}

const escapeSqlLiteral = (s) => s.replace(/'/g, "''");

export function buildNameQueryUrl({ name, state = null, limit = 20 }) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length < 2 || trimmed.length > 60) throw new RangeError('name must be 2-60 characters (trimmed).');
  let where = `UPPER(CELL_NAME) LIKE '%${escapeSqlLiteral(trimmed.toUpperCase())}%'`;
  if (state) where += ` AND STATE_ALPHA LIKE '%${escapeSqlLiteral(String(state).trim().toUpperCase())}%'`;
  const params = new URLSearchParams({ where, outFields: OUT_FIELDS.join(','), returnGeometry: 'true', outSR: '4326', resultRecordCount: String(limit), f: 'json' });
  return `${LAYER.queryUrl}?${params.toString()}`;
}

function ringBbox(rings) {
  const [ring] = rings;
  const lons = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  return { minLon: Math.min(...lons), maxLon: Math.max(...lons), minLat: Math.min(...lats), maxLat: Math.max(...lats) };
}

const cellsMatch = (a, b, tol = TOLERANCE_DEG) => Math.abs(a.minLon - b.minLon) <= tol && Math.abs(a.minLat - b.minLat) <= tol
  && Math.abs(a.maxLon - b.maxLon) <= tol && Math.abs(a.maxLat - b.maxLat) <= tol;

export function normalizeCell(feature) {
  const attrs = feature.attributes;
  const bbox = ringBbox(feature.geometry.rings);
  const cell = cellForPoint((bbox.minLat + bbox.maxLat) / 2, (bbox.minLon + bbox.maxLon) / 2);
  return {
    cellId: attrs.CELL_ID, name: attrs.CELL_NAME, primaryState: attrs.PRIMARY_STATE,
    states: String(attrs.STATE_ALPHA).split(',').map((s) => s.trim()), mapcode: attrs.CELL_MAPCODE,
    bbox, cell, matchesArithmetic: cellsMatch(bbox, cell), warnings: [],
  };
}

export const neighborsOf = (cell) => cellNeighbors(cell);

/** Every state a set of quad cells touches, sorted and de-duplicated. STATE_ALPHA
 *  is comma-separated on a cell that straddles a line, which normalizeCell has
 *  always split; nothing read it until the map stopped being one page per state
 *  and started asking the AREA which states it is in. */
export function statesForCells(cells = []) {
  return [...new Set(cells.flatMap((c) => c.states || [])
    .map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))].sort();
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const isRetryableStatus = (status) => status === 429 || status >= 500;

// Retries like REQUEST_POLICY: 429/5xx or a network throw; never another 4xx. A JSON
// `error` object or malformed JSON fails the page immediately (a data problem, not transient).
// Each attempt has its own `timeoutMs`, and a timeout is NOT retried: a service that did not
// answer in time is the failure, and three more waits would triple what the reader sits through.
async function fetchJsonPage(url, { fetchImpl, signal, retries, timeoutMs }) {
  const backoff = REQUEST_POLICY.retryBackoffMs;
  const maxAttempts = retries + 1;
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const got = await fetchWithDeadline(url, { fetchImpl, signal, timeoutMs });
    if (got.status === 'aborted') return { ok: false, error: 'aborted' };
    if (got.status === 'timeout') return { ok: false, error: got.error, timedOut: true };
    if (got.status === 'error' && !got.malformed && (got.httpStatus === undefined || isRetryableStatus(got.httpStatus))) {
      lastError = got.error;
      if (attempt < maxAttempts - 1) { await sleep(backoff[Math.min(attempt, backoff.length - 1)]); continue; }
      return { ok: false, error: lastError };
    }
    if (!got.ok) return { ok: false, error: got.error };
    if (got.body?.error) return { ok: false, error: got.body.error.message || 'USGS quad index returned an error.' };
    return { ok: true, body: got.body };
  }
  return { ok: false, error: lastError || 'Request failed.' };
}

// Paging stops at `maxPages`, and at a page that adds no cell not already read: a service
// that flags "more" forever, or ignores resultOffset and repeats itself, ends as 'partial'
// rather than as a loop. An honest bbox (2 degrees at most) is one or two pages.
export async function fetchCellsForBbox({
  bboxLonLat, fetchImpl = globalThis.fetch, signal, pageSize = 200,
  timeoutMs = TIMEOUT_MS, retries = REQUEST_POLICY.retries, maxPages = MAX_PAGES,
}) {
  const cells = []; const warnings = []; const seen = new Set();
  let pages = 0;
  let offset = 0;
  let coverage = 'complete';
  let error = null;
  let timedOut = false;
  for (;;) {
    if (signal?.aborted) { coverage = pages === 0 ? 'unavailable' : 'partial'; break; }
    const url = buildBboxQueryUrl({ bboxLonLat, offset, pageSize });
    const result = await fetchJsonPage(url, { fetchImpl, signal, retries, timeoutMs });
    if (!result.ok) { error = result.error; timedOut = result.timedOut === true; coverage = pages === 0 ? 'unavailable' : 'partial'; break; }
    pages += 1;
    const features = Array.isArray(result.body.features) ? result.body.features : [];
    let added = 0;
    for (const feature of features) {
      const cell = normalizeCell(feature);
      if (seen.has(cell.cellId)) continue;
      seen.add(cell.cellId);
      cells.push(cell);
      added += 1;
    }
    if (result.body.exceededTransferLimit !== true) break;
    if (added === 0) { error = 'The quad index flagged more pages but returned nothing new.'; coverage = 'partial'; break; }
    if (pages >= maxPages) { error = `The quad index kept paging past ${maxPages} pages.`; coverage = 'partial'; break; }
    offset += features.length;
  }
  if (coverage === 'complete') {
    for (const arithmetic of cellsForBbox(bboxLonLat)) {
      if (!cells.some((c) => cellsMatch(c.cell, arithmetic))) {
        const b = arithmetic;
        warnings.push(`No quad returned for arithmetic cell [minLon:${b.minLon}, minLat:${b.minLat}, maxLon:${b.maxLon}, maxLat:${b.maxLat}]; the service may lack coverage there (open water or outside CONUS).`);
      }
    }
  }
  const out = { coverage, cells, pages, warnings };
  if (error) out.error = error;
  if (timedOut) out.timedOut = true;
  return out;
}

export async function searchByName({ name, state, fetchImpl = globalThis.fetch, signal, limit = 20, timeoutMs = TIMEOUT_MS }) {
  let url;
  try { url = buildNameQueryUrl({ name, state, limit }); } catch (err) { return { ok: false, cells: [], error: err.message }; }
  const got = await fetchWithDeadline(url, { fetchImpl, signal, timeoutMs });
  if (!got.ok) return { ok: false, cells: [], error: got.error, ...(got.status === 'timeout' ? { timedOut: true } : {}) };
  if (got.body?.error) return { ok: false, cells: [], error: got.body.error.message || 'USGS quad index returned an error.' };
  try {
    const features = Array.isArray(got.body?.features) ? got.body.features : [];
    return { ok: true, cells: features.map(normalizeCell), error: null };
  } catch (err) {
    return { ok: false, cells: [], error: err?.message || String(err) };
  }
}
