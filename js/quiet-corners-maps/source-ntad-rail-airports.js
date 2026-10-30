// BTS NTAD Class I rail lines and public-use airports, the two things a transportation noise map
// is made of, asked by bounding box from geo.dot.gov (the host the noise tiles already use). The
// measurements, and why the airport layer is Airports_ rather than OZ_Airports_All, live on the
// `btsRailClass1` and `btsAirports` rows in source-registry.js.
//
// Three rules shape this module. A box over the area cap is never requested: the reader is told
// to zoom in (rail is the tight one -- 10 sq deg of Tennessee answered 1,987 of a 2,000 cap). A
// geometry that is not a pair of finite numbers is dropped and counted, never drawn. And the
// words say what the layer is: an inventory of where Class I rail runs and which airports are
// open to the public, never how loud a place is and never how often anything passes.
import { SOURCES } from './source-registry.js';
import { SYMBOLS } from './legend.js';
import { fetchWithDeadline, orThrow } from './request.js';

const RAIL = SOURCES.btsRailClass1;
const AIRPORTS = SOURCES.btsAirports;

export const CREDIT_RAIL = RAIL.attribution;
export const CREDIT_AIRPORTS = AIRPORTS.attribution;
export const RAIL_MAX_BBOX_SQ_DEG = RAIL.limits.maxBboxSquareDegrees;
export const AIRPORT_MAX_BBOX_SQ_DEG = AIRPORTS.limits.maxBboxSquareDegrees;
const PAGE = RAIL.limits.maxRecordCount;
const RAIL_FIELDS = ['rrowner1', 'subdiv', 'tracks'];
const AIRPORT_FIELDS = ['loc_id', 'fac_name', 'fac_use', 'city', 'state_name', 'role', 'category', 'icao_identifier', 'atc_tower'];

export function bboxAreaSqDeg({ minLon, minLat, maxLon, maxLat }) {
  return Math.max(0, maxLon - minLon) * Math.max(0, maxLat - minLat);
}
const status = (bbox, cap) => { const areaSqDeg = bboxAreaSqDeg(bbox); return { ok: areaSqDeg <= cap, areaSqDeg }; };
/** Whether a view may be asked at all. Pure, so the refusal is proved without a network. */
export const railBoxStatus = (bbox) => status(bbox, RAIL_MAX_BBOX_SQ_DEG);
export const airportBoxStatus = (bbox) => status(bbox, AIRPORT_MAX_BBOX_SQ_DEG);

const num = (n) => String(Math.round(n * 1e6) / 1e6);
function queryUrl(layer, { minLon, minLat, maxLon, maxLat }, extra) {
  const p = new URLSearchParams({
    where: '1=1', geometry: [minLon, minLat, maxLon, maxLat].map(num).join(','),
    geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    returnGeometry: 'true', resultRecordCount: String(PAGE), f: 'json', ...extra,
  });
  return `${layer.queryUrl}?${p}`;
}
export const railUrl = (bbox) => queryUrl(RAIL.layers[0], bbox,
  { outFields: RAIL_FIELDS.join(','), maxAllowableOffset: String(RAIL.limits.simplifyDegrees) });
export const airportsUrl = (bbox) => queryUrl(AIRPORTS.layers[0], bbox,
  { where: "fac_use='PU'", outFields: AIRPORT_FIELDS.join(',') });

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/** Rail segments out of one response body. A vertex that is not two finite numbers drops its
 *  path, and a segment left with no path is dropped and counted. Paths come back in Leaflet's
 *  [lat, lon] order. */
export function readRail(json) {
  const features = Array.isArray(json && json.features) ? json.features : [];
  const lines = [];
  let dropped = 0;
  for (const f of features) {
    const raw = f && f.geometry && Array.isArray(f.geometry.paths) ? f.geometry.paths : [];
    const paths = raw
      .filter((p) => Array.isArray(p) && p.length >= 2 && p.every((v) => Array.isArray(v) && finite(v[0]) && finite(v[1])))
      .map((p) => p.map((v) => [v[1], v[0]]));
    if (!paths.length) { dropped += 1; continue; }
    const a = (f && f.attributes) || {};
    lines.push({ owner: text(a.rrowner1), subdiv: text(a.subdiv), tracks: finite(a.tracks) ? a.tracks : null, paths });
  }
  return { lines, dropped, seen: features.length, capped: !!json && (json.exceededTransferLimit === true || features.length >= PAGE) };
}

/** Airports out of one response body; a record without a finite x and y is dropped and counted. */
export function readAirports(json) {
  const features = Array.isArray(json && json.features) ? json.features : [];
  const airports = [];
  let dropped = 0;
  for (const f of features) {
    const g = f && f.geometry;
    if (!g || !finite(g.x) || !finite(g.y)) { dropped += 1; continue; }
    const a = f.attributes || {};
    airports.push({ id: text(a.loc_id), name: text(a.fac_name), icao: text(a.icao_identifier), role: text(a.role),
      category: text(a.category), city: text(a.city), state: text(a.state_name), tower: text(a.atc_tower), lat: g.y, lon: g.x });
  }
  return { airports, dropped, seen: features.length, capped: !!json && (json.exceededTransferLimit === true || features.length >= PAGE) };
}

async function getJson(url, fetchImpl, signal, timeoutMs) {
  const json = orThrow(await fetchWithDeadline(url, { fetchImpl, signal, timeoutMs }));
  if (json && json.error) throw new Error('service refused the query');
  return json;
}

async function ask(bbox, ok, url, read, key, timeoutMs, { fetchImpl = fetch, signal, nowMs = Date.now() } = {}) {
  const none = { [key]: [], dropped: 0, capped: false, fetchedMs: null };
  if (!ok(bbox).ok) return { status: 'too-wide', ...none };
  let json;
  try { json = await getJson(url(bbox), fetchImpl, signal, timeoutMs); } catch (e) { return { status: 'unavailable', ...none }; }
  const got = read(json);
  return { status: got[key].length ? 'ready' : 'empty', [key]: got[key], dropped: got.dropped, capped: got.capped, fetchedMs: nowMs };
}
/** One view's answer. Never throws: a failure is `status: 'unavailable'`. */
export const fetchRail = (bbox, opts) => ask(bbox, railBoxStatus, railUrl, readRail, 'lines', RAIL.timeoutMs, opts);
export const fetchAirports = (bbox, opts) => ask(bbox, airportBoxStatus, airportsUrl, readAirports, 'airports', AIRPORTS.timeoutMs, opts);

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function railCardLines(line) {
  const lines = [line.subdiv || 'Class I rail line'];
  if (line.owner) lines.push(`Railroad (owner code in the BTS data): ${line.owner}`);
  if (line.tracks !== null && line.tracks !== undefined) lines.push(`Tracks: ${line.tracks}`);
  lines.push('A Class I line as BTS draws it; the data says nothing of how many trains or when.');
  return lines;
}

export function airportCardLines(a) {
  const lines = [a.name || 'Airport'];
  const ids = [a.id ? `FAA identifier ${a.id}` : null, a.icao ? `ICAO ${a.icao}` : null].filter(Boolean);
  if (ids.length) lines.push(ids.join(', '));
  const place = [a.city, a.state].filter(Boolean).join(', ');
  if (place) lines.push(place);
  const kind = [a.role ? `role ${a.role}` : null, a.category ? `category ${a.category}` : null].filter(Boolean);
  if (kind.length) lines.push(`FAA ${kind.join(', ')}`);
  if (a.tower === 'Y' || a.tower === 'N') lines.push(`Control tower: ${a.tower === 'Y' ? 'yes' : 'no'}`);
  lines.push('Listed as open to the public; the list says nothing of how often aircraft use it.');
  return lines;
}

const clock = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
function report(result, o) {
  if (!result || result.status === 'unavailable') return { text: `The BTS service did not answer for this view, so no ${o.plural} are drawn.` };
  if (result.status === 'too-wide') {
    return { text: `This view is wider than ${o.cap} square degrees, which the ${o.noun} request is held under. Zoom in to see ${o.plural}; none are drawn at this size.` };
  }
  if (result.status === 'empty') return { text: o.empty };
  const parts = [`${plural(result.count, o.unit)} in view (${o.scope}). Fetched ${clock(result.fetchedMs)}.`];
  if (result.dropped) parts.push(`${plural(result.dropped, 'record')} had no usable shape and ${result.dropped === 1 ? 'was' : 'were'} left out.`);
  if (result.capped) parts.push(`BTS reports more ${o.plural} than this view can show; zoom in for the rest.`);
  return { text: parts.join(' ') };
}
export const railReport = (r) => report(r && { ...r, count: r.lines && r.lines.length }, {
  plural: 'rail lines', noun: 'rail', unit: 'rail segment', cap: RAIL_MAX_BBOX_SQ_DEG, scope: 'Class I railroads only',
  empty: 'No Class I rail line is in this view. That is this layer’s coverage, not a statement that no railway or no trains are here.' });
export const airportReport = (r) => report(r && { ...r, count: r.airports && r.airports.length }, {
  plural: 'airports', noun: 'airport', unit: 'airport', cap: AIRPORT_MAX_BBOX_SQ_DEG, scope: 'public-use only',
  empty: 'No public-use airport is listed in this view. That is the list, not a statement about the sky or the ground.' });

function card(lines) {
  const el = typeof document !== 'undefined' ? document.createElement('div') : { children: [] };
  if (el.appendChild) lines.forEach((line, i) => { const c = document.createElement(i === 0 ? 'strong' : 'div'); c.textContent = line; el.appendChild(c); });
  return el;
}

/** A Leaflet group of one polyline per rail segment; the card is a popup whose lines are set as
 *  text, so nothing from the feed is parsed as markup. */
export function railLayer(L) {
  const group = L.layerGroup();
  group.draw = function draw(lines) {
    group.clearLayers();
    for (const line of lines || []) {
      L.polyline(line.paths, { color: '#37474f', weight: 3, opacity: 0.9, keyboard: true }).bindPopup(card(railCardLines(line))).addTo(group);
    }
    return group;
  };
  return group;
}

/** A Leaflet group of one circle marker per airport (keyboard reachable, opens its card on Enter). */
export function airportLayer(L) {
  const group = L.layerGroup();
  group.draw = function draw(airports) {
    group.clearLayers();
    for (const a of airports || []) {
      L.circleMarker([a.lat, a.lon], { radius: 6, weight: 2, color: '#0b5394', fillColor: '#5b9bd5', fillOpacity: 0.85, keyboard: true })
        .bindPopup(card(airportCardLines(a))).addTo(group);
    }
    return group;
  };
  return group;
}

/** One question at a time, only for the view the reader stopped on; an answer about a view the
 *  reader left is dropped. `ask` resolves false when it was dropped. */
export function ntadReader({ fetchFn, waitMs = 400, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null, live = null, drop = null;
  const stop = () => {
    if (timer) clearTimer(timer);
    if (live) live.abort();
    if (drop) drop(false);
    timer = null; live = null; drop = null;
  };
  return {
    cancel: stop,
    ask(bbox, deliver) {
      stop();
      return new Promise((resolve) => {
        drop = resolve;
        timer = setTimer(async () => {
          timer = null;
          const ctl = new AbortController();
          live = ctl;
          const got = await fetchFn(bbox, { signal: ctl.signal });
          if (live !== ctl) return;
          live = null; drop = null;
          deliver(got);
          resolve(true);
        }, waitMs);
      });
    },
  };
}

export const RAIL_LABEL = 'Rail lines (Class I, BTS)';
export const AIRPORT_LABEL = 'Airports (public-use, FAA list via BTS)';
export const RAIL_CAVEAT = 'Where Class I freight railroads run, as the Bureau of Transportation Statistics draws the '
  + 'line, lightly simplified. Class I only: a short line, a branch another operator runs or a spur is not here, so no '
  + 'line in view is not the same as no railway. This is where a source of noise runs, not a measurement of noise: it '
  + 'says nothing of how many trains pass or when, so read it beside the noise surface rather than as a statement of '
  + `how loud a place is. Screen only, not printed. Zoom in to load it: a view wider than ${RAIL_MAX_BBOX_SQ_DEG} square degrees is not requested.`;
export const AIRPORT_CAVEAT = 'Airports the FAA lists as open to the public (public-use), as BTS republishes them, one marker '
  + 'each. A grass strip and a hub look alike: the list gives the facility, not its traffic, and private-use fields and '
  + 'heliports are not asked. This is where a source of noise is, not a measurement of noise, and it says nothing of '
  + 'flight paths or hours. Screen only, not printed. Zoom in to load it: a view wider than '
  + `${AIRPORT_MAX_BBOX_SQ_DEG} square degrees is not requested.`;

const row = (id, label, sourceId, caveat, symbol) => Object.freeze({
  id, group: 'federal', label, sourceId,
  screenOnly: true,   // an inventory read live per view is no basis for a printed sheet
  // Live per-view reads that main.js draws on the 2D map only; 3D lists them as "Available in 2D".
  notIn3d: true,
  defaultOn: false, required: false,
  symbolKeys: [symbol.key],
  emptyMeans: 'ambiguous',
  status: 'live', coverageCaveat: caveat,
  render: { labels: 'none', dropBelowScale: null },
});
export const RAIL_ROW = row('railClass1', RAIL_LABEL, 'btsRailClass1', RAIL_CAVEAT, SYMBOLS.railLine);
export const AIRPORT_ROW = row('airports', AIRPORT_LABEL, 'btsAirports', AIRPORT_CAVEAT, SYMBOLS.airport);

export function readerStrings() {
  const a = { name: null, id: null, icao: null, role: null, category: null, city: null, state: null, tower: null };
  const res = { status: 'ready', lines: [{ owner: null, subdiv: null, tracks: null, paths: [] }], airports: [a], dropped: 1, capped: true, fetchedMs: 0 };
  return [CREDIT_RAIL, CREDIT_AIRPORTS, RAIL_LABEL, AIRPORT_LABEL, RAIL_CAVEAT, AIRPORT_CAVEAT,
    ...railCardLines(res.lines[0]), ...airportCardLines(a),
    railReport(null).text, railReport({ status: 'too-wide' }).text, railReport({ status: 'empty' }).text, railReport(res).text,
    airportReport(null).text, airportReport({ status: 'too-wide' }).text, airportReport({ status: 'empty' }).text, airportReport(res).text];
}
