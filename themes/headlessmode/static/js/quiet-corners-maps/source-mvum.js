/* Quiet Corners Field Maps — USFS Motor Vehicle Use Map adapter. Pure: bounded envelope queries, paging while
 * the service flags `exceededTransferLimit`, a count cross-check, vehicle/date normalization, honest coverage
 * (complete / partial / unavailable / unknown). Imports the registry only; network, clock and sleep are injected. */
import { SOURCES, REQUEST_POLICY, FAILURE } from './source-registry.js';

export const LAYERS = Object.freeze({ roads: 1, trails: 2 });
export const OUT_FIELDS = Object.freeze([
  'objectid', 'id', 'name', 'symbol', 'mvum_symbol_name', 'seasonal',
  'passengervehicle', 'passengervehicle_datesopen', 'highclearancevehicle', 'highclearancevehicle_datesopen',
  'forestname', 'districtname', 'routestatus', 'jurisdiction', 'surfacetype',
]);
// Layer 2 (trails) has no routestatus/surfacetype; asking for them is an HTTP 400 (measured 2026-09-05).
export const ROAD_ONLY_FIELDS = Object.freeze(['routestatus', 'surfacetype']);
export function fieldsForLayer(layer) { return layer === LAYERS.trails ? OUT_FIELDS.filter((f) => !ROAD_ONLY_FIELDS.includes(f)) : [...OUT_FIELDS]; }
const MAX_SPAN_DEG = 1; // a national download must be impossible by construction
const LAYER_KEY = { 1: 'road', 2: 'trail', roads: 'road', trails: 'trail', road: 'road', trail: 'trail' };
const fmt = (n) => String(Number(n.toFixed(6)));
const blank = (v) => v === null || v === undefined || String(v).trim() === '';
const str = (v) => (blank(v) ? null : String(v).trim().replace(/\s+/g, ' '));
const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export function buildQueryUrl({ layer, bboxLonLat, offset = 0, pageSize = 1000, countOnly = false }) {
  if (!Object.values(LAYERS).includes(layer)) throw new RangeError(`unknown MVUM layer ${layer}`);
  const b = bboxLonLat || {};
  const box = [b.minLon, b.minLat, b.maxLon, b.maxLat];
  if (!box.every(Number.isFinite)) throw new RangeError('bbox needs four finite numbers');
  if (b.minLon >= b.maxLon || b.minLat >= b.maxLat) throw new RangeError('bbox is inverted or empty');
  if (b.maxLon - b.minLon > MAX_SPAN_DEG || b.maxLat - b.minLat > MAX_SPAN_DEG) throw new RangeError(`bbox exceeds ${MAX_SPAN_DEG} degree in one dimension`);
  const params = [`where=${encodeURIComponent('1=1')}`, `geometry=${box.map(fmt).join(',')}`,
    'geometryType=esriGeometryEnvelope', 'inSR=4326', 'spatialRel=esriSpatialRelIntersects'];
  if (countOnly) params.push('returnCountOnly=true');
  else params.push(`outFields=${fieldsForLayer(layer).join(',')}`, 'returnGeometry=true', 'outSR=4326', `resultOffset=${offset}`, `resultRecordCount=${pageSize}`);
  return `${SOURCES.usfsMvum.serviceUrl}/${layer}/query?${params.join('&')}&f=json`;
}

/** "04/01-12/15" → { open: '04-01', close: '12-15' }; blank or malformed → null (the caller records why). */
export function parseDatesOpen(s) {
  const m = /^\s*(\d{2})\/(\d{2})\s*-\s*(\d{2})\/(\d{2})\s*$/.exec(blank(s) ? '' : String(s));
  if (!m || [m[1], m[3]].some((mm) => mm < '01' || mm > '12') || [m[2], m[4]].some((dd) => dd < '01' || dd > '31')) return null;
  return { open: `${m[1]}-${m[2]}`, close: `${m[3]}-${m[4]}` };
}

function enumField(a, field, allowed, warnings) {
  const v = str(a[field]); const low = v === null ? null : v.toLowerCase();
  if (v === null || !allowed.includes(low)) warnings.push(v === null ? `${field}: blank` : `${field}: unrecognized value "${v}"`);
  return v !== null && allowed.includes(low) ? low : null;
}
function vehicle(a, field, warnings) {
  const allowed = enumField(a, field, ['open', 'closed'], warnings);
  const raw = a[`${field}_datesopen`]; const datesOpen = parseDatesOpen(raw);
  if (!datesOpen) warnings.push(blank(raw) ? `${field}_datesopen: blank` : `${field}_datesopen: malformed "${raw}"`);
  return { allowed, datesOpen };
}

export function normalizeFeature(raw, layerKey) {
  const layer = LAYER_KEY[layerKey];
  if (!layer) throw new RangeError(`unknown MVUM layer ${layerKey}`);
  const a = (raw && raw.attributes) || {}; const warnings = [];
  for (const f of ['id', 'name']) if (blank(a[f])) warnings.push(`${f}: blank`);
  const seasonal = enumField(a, 'seasonal', ['seasonal', 'yearlong'], warnings);
  const vehicles = { passenger: vehicle(a, 'passengervehicle', warnings), highClearance: vehicle(a, 'highclearancevehicle', warnings) };
  const paths = ((raw && raw.geometry && raw.geometry.paths) || []).map((p) => p.map(([lon, lat]) => [lon, lat]));
  if (!paths.length) warnings.push('geometry: no paths');
  return {
    objectId: a.objectid ?? null, id: str(a.id), name: str(a.name), layer, symbol: str(a.symbol), symbolName: str(a.mvum_symbol_name),
    seasonal, vehicles, forest: str(a.forestname), district: str(a.districtname), routeStatus: str(a.routestatus),
    jurisdiction: str(a.jurisdiction), surface: str(a.surfacetype), paths, warnings,
  };
}

/** Groups the many segments one road id returns; datesOpen collects the distinct passenger windows as "MM-DD..MM-DD". */
export function summarize(features) {
  const byId = new Map(); const symbolsUsed = new Set(); const forests = new Set();
  for (const f of features) {
    const key = f.id ?? `objectid:${f.objectId}`;
    if (!byId.has(key)) byId.set(key, { id: f.id, name: f.name, segments: 0, layer: f.layer, seasonal: f.seasonal, datesOpen: new Set() });
    const e = byId.get(key); e.segments += 1;
    const d = f.vehicles.passenger.datesOpen; if (d) e.datesOpen.add(`${d.open}..${d.close}`);
    if (f.symbolName) symbolsUsed.add(f.symbolName);
    if (f.forest) forests.add(f.forest);
  }
  return { byId, symbolsUsed, forests };
}

// One request with REQUEST_POLICY backoff: 429/5xx/network errors retry; other 4xx, ArcGIS `error` bodies and bad JSON do not.
async function requestJson(url, { fetchImpl, signal, timeoutMs, retries, sleep }) {
  let last = 'no attempt';
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal && signal.aborted) return { ok: false, error: 'aborted' };
    if (attempt > 0) await sleep(REQUEST_POLICY.retryBackoffMs[Math.min(attempt - 1, REQUEST_POLICY.retryBackoffMs.length - 1)]);
    const ctl = new AbortController(); const onAbort = () => ctl.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(onAbort, timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctl.signal });
      if (!res.ok) { last = `HTTP ${res.status}`; if (res.status === 429 || res.status >= 500) continue; return { ok: false, error: last }; }
      let body; try { body = await res.json(); } catch { return { ok: false, error: 'malformed JSON' }; }
      if (body && body.error) return { ok: false, error: `service error ${body.error.code ?? ''}`.trim() };
      return { ok: true, body: body || {} };
    } catch (e) {
      if (signal && signal.aborted) return { ok: false, error: 'aborted' };
      last = ctl.signal.aborted ? `timeout after ${timeoutMs} ms` : `network error: ${e && e.message}`;
    } finally { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); }
  }
  return { ok: false, error: `${last} after ${retries + 1} attempts` };
}

export async function fetchLayer({ layer, bboxLonLat, fetchImpl = globalThis.fetch, signal, pageSize = 1000,
  timeoutMs = REQUEST_POLICY.timeoutMs, retries = REQUEST_POLICY.retries, onProgress, now = () => new Date().toISOString(), sleep = defaultSleep }) {
  const layerId = LAYERS[layer] ?? layer; const layerKey = LAYER_KEY[layerId];
  const opts = { fetchImpl, signal, timeoutMs, retries, sleep };
  const warnings = []; const features = [];
  const count = await requestJson(buildQueryUrl({ layer: layerId, bboxLonLat, countOnly: true }), opts);
  const expectedCount = count.ok && Number.isInteger(count.body.count) ? count.body.count : null;
  if (expectedCount === null) warnings.push(`count query failed: ${count.ok ? 'no count in response' : count.error}`);
  const totalPages = expectedCount === null ? null : Math.max(1, Math.ceil(expectedCount / pageSize));
  let pages = 0; let error = null; let retrievedAt = null;
  for (let more = true; more;) {
    const page = pages + 1;
    if (onProgress) onProgress(page, features.length, expectedCount, totalPages === null ? null : FAILURE.paging(page, totalPages));
    const r = await requestJson(buildQueryUrl({ layer: layerId, bboxLonLat, offset: features.length, pageSize }), opts);
    if (!r.ok) { error = `page ${page} failed: ${r.error}`; break; }
    pages += 1; retrievedAt = now();
    const got = Array.isArray(r.body.features) ? r.body.features : [];
    for (const raw of got) { const f = normalizeFeature(raw, layerKey); features.push(f); for (const w of f.warnings) warnings.push(`objectid ${f.objectId}: ${w}`); }
    more = r.body.exceededTransferLimit === true;
    if (more && !got.length) { error = `page ${page} was empty but flagged as partial`; break; }
  }
  const receivedCount = features.length;
  let coverage = 'partial';
  if (pages === 0) coverage = expectedCount === null ? 'unknown' : 'unavailable';
  else if (!error && (expectedCount === null || receivedCount === expectedCount)) coverage = 'complete';
  return { coverage, layer: layerKey, features, expectedCount, receivedCount, pages, warnings, retrievedAt, error };
}

export function coverageMessage(r) {
  if (r.coverage === 'complete') return `MVUM: ${r.receivedCount} ${r.layer} segments, complete.`;
  if (r.coverage !== 'partial') return FAILURE.coverageUnknown;
  return `MVUM coverage for this area is incomplete: received ${r.receivedCount} of ${r.expectedCount ?? 'an unknown number of'} ${r.layer} segments.`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const VEHICLE_LABEL = { passenger: 'passenger cars', highClearance: 'high-clearance vehicles' };

/** '04-01' → 'Apr 1'. No year, ever: MVUM states a window that recurs, and printing
 *  one would invent an edition of the map the service never published. */
function dayText(md) {
  const m = /^(\d{2})-(\d{2})$/.exec(String(md ?? ''));
  const month = m ? MONTHS[Number(m[1]) - 1] : null;
  return month ? `${month} ${Number(m[2])}` : null;
}

/** What MVUM SAID about driving this route, or null when it said nothing at all.
 *
 *  Every one of these facts was already fetched and normalized, and every one was
 *  spent on choosing a dash pattern. A road open to high-clearance trucks between
 *  April and December drew identically to a road open to anything year-round.
 *
 *  Only a stated value counts, which cuts both ways here. A blank vehicle field is
 *  the inventory not answering — not a ban, so it is never reported as closed, and
 *  not a permission, so it is never reported as open. And `open` with no window on
 *  a route the source itself called seasonal is NOT year-round: naming the gap is
 *  the whole difference between quoting the map and improving on it. */
export function mvumAccessText(feature) {
  const vehicles = (feature && feature.vehicles) || {};
  const yearlong = !!feature && feature.seasonal === 'yearlong';
  const said = [];
  for (const kind of ['passenger', 'highClearance']) {
    const { allowed = null, datesOpen = null } = vehicles[kind] || {};
    const label = VEHICLE_LABEL[kind];
    if (allowed === 'closed') { said.push(`closed to ${label}`); continue; }
    if (allowed !== 'open') continue;
    const from = dayText(datesOpen && datesOpen.open);
    const to = dayText(datesOpen && datesOpen.close);
    if (from && to) said.push(`open to ${label} ${from} – ${to}`);
    else if (yearlong) said.push(`open to ${label} year-round`);
    else said.push(`open to ${label}, dates not stated`);
  }
  if (!said.length) return null;
  const text = said.join('; ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** '04-01'..'12-15' -> 'Apr 1 - Dec 15'; null when the source gave no usable pair.
 *  ASCII only: these lines are drawn into the PDF, whose standard fonts cannot
 *  encode an en dash and silently substitute '?'. */
function windowText(d) {
  const from = dayText(d && d.open), to = dayText(d && d.close);
  return from && to ? `${from} - ${to}` : null;
}

/** The open windows the drawn MVUM routes actually stated, one line per route, plus
 *  a count of the routes the source called seasonal and gave no window for.
 *
 *  The printed key promised these and nothing wrote one: `summarize()` collects the
 *  windows and nothing but its own test has ever called it, so a reader who saw
 *  `dates on sheet when supplied` searched the paper for a section that was not
 *  there.
 *
 *  The undated count matters. Listing only the dated routes would read as
 *  "these are the seasonal roads here", and a reader would drive an unlisted one in
 *  February on the strength of that. Segments of one route can carry different
 *  windows, and both are kept: choosing between them would invent a road that opens
 *  on a date the source never gave for that stretch. */
export function seasonalWindows(features = []) {
  const byRoute = new Map();
  for (const f of features) {
    if (!f || f.seasonal !== 'seasonal') continue;
    const key = f.id ?? f.name ?? `objectid:${f.objectId}`;
    if (!byRoute.has(key)) byRoute.set(key, { label: str(f.name) || str(f.id) || 'Unnamed route', windows: new Map() });
    const entry = byRoute.get(key);
    for (const kind of ['passenger', 'highClearance']) {
      const dates = ((f.vehicles || {})[kind] || {}).datesOpen;
      const text = windowText(dates);
      // Ordered by the source's own MM-DD, not by the printed month name: 'Dec'
      // sorts before 'Jan' as text, and a key that opened with December would
      // read as the earlier window.
      if (text) entry.windows.set(text, dates.open);
    }
  }
  const dated = [...byRoute.values()].filter((e) => e.windows.size);
  const ordered = (e) => [...e.windows.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([t]) => t);
  return {
    lines: dated.map((e) => `${e.label}: ${ordered(e).join('; ')}`).sort(),
    undated: byRoute.size - dated.length,
  };
}
