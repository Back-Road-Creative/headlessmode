// NOAA's Hazard Mapping System smoke plume analysis, read for the view on screen. Measured live
// 2026-09-15 (00:31-00:44 UTC): 200, `access-control-allow-origin: *`, no key; the whole country
// 103 polygons and 160,863 bytes, 44,085 simplified, a county bbox 6,466. Three measurements
// decide the whole file.
//
// THE HEIGHT. The three density classes are the apparent OPACITY of smoke in satellite imagery,
// which NOAA says approximates 0-10, 10-21 and 21-32 micrograms per cubic metre IN THE COLUMN --
// explicitly with no guarantee about the actual density. That is not the air at head height, and
// it disagreed with the AQI contour over the same ground at the probe. So no string here may read
// as air quality, and the numbers are approximations, never a reading.
//
// THE CLOCK. `Start` and `End_` are STRINGS in the HMS wire format `YYYYDDD HHMM`, UTC day-of-
// year: `2026257 1200` is 2026-09-14 12:00Z. Read as epoch milliseconds they land in 1970; read
// off the service's own `last-modified` they measured 4h32m too new.
//
// THE DAYLIGHT. The analysis is a human reading of GOES true-colour imagery, so nothing is made
// at night and a day's first plumes appear around local noon. An empty map at 03:00 local means
// the day has not been analysed, NOT that the sky is clear -- and the two are told apart by a
// 1 KB `max(Start)` statistics query rather than by assumption.
import { SOURCES } from './source-registry.js';
import { serviceError, envelope, viewReader } from './arcgis-view.js';

const SRC = SOURCES.noaaHmsSmoke;
export const SERVICE = SRC.serviceUrl;
export const CREDIT = SRC.attribution;
export { serviceError };
/** The publisher's own three classes and the order they rank in. Not a scale this app made up. */
export const DENSITY = SRC.layers[0].densityClasses;
export const DENSITY_ORDER = Object.freeze(
  Object.keys(DENSITY).sort((a, b) => DENSITY[a].order - DENSITY[b].order));

/** `YYYYDDD HHMM`, UTC day-of-year, to epoch milliseconds -- or null, which is what an unreadable
 *  window is. A NUMBER is never a time here: the fields are strings, so an epoch is the bug. */
export function parseHmsTime(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})(\d{3}) (\d{2})(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [, y, doy, hh, mm] = m.map(Number);
  if (doy < 1 || doy > 366 || hh > 23 || mm > 59) return null;
  return Date.UTC(y, 0, 1) + (doy - 1) * 86400000 + hh * 3600000 + mm * 60000;
}

const outFields = 'Satellite,Start,End_,Density';

/** The service's own query for one view. Pure, so the request is asserted without a network call.
 *  Bounded and simplified: the national fetch is 44 KB even simplified, and a view is not it. */
export function smokeQueryFor(bbox) {
  return { url: `${SERVICE}/query`,
    params: {
      geometry: envelope(bbox), geometryType: 'esriGeometryEnvelope', inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', returnGeometry: 'true', outSR: '4326',
      maxAllowableOffset: String(SRC.limits.simplifyOffsetDegrees),
      geometryPrecision: String(SRC.limits.geometryPrecision),
      outFields, f: 'geojson',
    } };
}
export const smokeQueryUrl = (bbox) => {
  const q = smokeQueryFor(bbox);
  return `${q.url}?${new URLSearchParams(q.params)}`;
};

/** "Has today been analysed at all?" for a kilobyte: the newest `Start` in the layer, with no
 *  geometry and no features. Cheap enough to ask whenever the view comes up empty. */
export const latestAnalysisUrl = () => `${SERVICE}/query?${new URLSearchParams({
  where: '1=1', returnGeometry: 'false', f: 'json',
  outStatistics: JSON.stringify([{ statisticType: 'max', onStatisticField: 'Start', outStatisticFieldName: 'maxStart' }]),
})}`;

/** The newest analysis window the layer holds, as the service's own string, or null. */
export function readLatestAnalysis(body) {
  const a = body && Array.isArray(body.features) && body.features[0] ? body.features[0].attributes : null;
  const v = a ? a.maxStart : null;
  return typeof v === 'string' && parseHmsTime(v) !== null ? v : null;
}

/** The plumes a response holds. A record whose density is not one of the publisher's three, or
 *  whose window will not parse, is dropped rather than guessed. An error envelope holds none. */
export function readPlumes(body) {
  if (serviceError(body)) return [];
  const out = [];
  for (const f of Array.isArray(body && body.features) ? body.features : []) {
    const p = (f && (f.properties || f.attributes)) || {};
    const density = String(p.Density || '');
    const startMs = parseHmsTime(p.Start);
    if (!(density in DENSITY) || startMs === null) continue;
    out.push({ density, order: DENSITY[density].order, startMs, endMs: parseHmsTime(p.End_),
      satellite: p.Satellite || null, geometry: f.geometry || null });
  }
  return out;
}

/** The thickest class over the view, and the end of the newest window it came from. Thickest
 *  rather than averaged: an averaged class is one NOAA never published. */
export function summarise(rows) {
  if (!rows || !rows.length) return { known: false, count: 0, worst: null, startMs: null, observedMs: null };
  const worst = rows.reduce((m, r) => (r.order > m.order ? r : m), rows[0]);
  return { known: true, count: rows.length, worst: worst.density,
    startMs: rows.reduce((m, r) => Math.max(m, r.startMs), 0),
    observedMs: rows.reduce((m, r) => Math.max(m, r.endMs ?? r.startMs), 0) };
}

const utcDay = (ms) => Math.floor(ms / 86400000);
const clock = (ms) => new Date(ms).toISOString().slice(11, 16);

/** Whether the layer holds an analysis for the UTC day it is read on: the difference between
 *  "no plume over you" and "nobody has looked yet today", which an empty map cannot say. */
export function issuedState(latestStart, nowMs = Date.now()) {
  const ms = parseHmsTime(latestStart);
  if (ms === null) {
    return { issuedToday: false, latestMs: null,
      text: 'The smoke analysis did not say which day it covers, so whether today has been '
        + 'analysed is unknown.' };
  }
  if (utcDay(ms) >= utcDay(nowMs)) return { issuedToday: true, latestMs: ms, text: '' };
  return { issuedToday: false, latestMs: ms,
    text: `Today has not been analysed yet. Smoke is outlined by an analyst from daylight `
      + `satellite images, so the first plumes of a day appear around local noon; the newest `
      + `analysis here ended ${clock(ms)} UTC on the previous day.` };
}

/** Nothing over the view is a real answer only when the day HAS been analysed. */
export function quietText() {
  return 'No smoke plume is outlined over this view in the latest analysis. The analysis covers '
    + 'North America and describes smoke aloft, so a clear map is one analyst finding no plume '
    + 'to outline rather than a reading of the air where you are standing.';
}

export const FAILED_TEXT = 'The smoke analysis could not be read for this view.';

/** How old the analysis window is. The WINDOW leads, because a plume stated bare reads as the
 *  sky outside your window and this product can be hours old. */
export function windowText(at, nowMs = Date.now()) {
  if (!at.known || !at.startMs) return FAILED_TEXT;
  const minutes = Math.max(0, Math.round((nowMs - at.observedMs) / 60000));
  const ago = minutes < 60 ? `${minutes} minute${minutes === 1 ? '' : 's'} ago`
    : `${Math.round(minutes / 60)} hour${Math.round(minutes / 60) === 1 ? '' : 's'} ago`;
  return `Smoke analysed from imagery between ${clock(at.startMs)} and ${clock(at.observedMs)} UTC, `
    + `ending ${ago}.`;
}

/** What the thickest class over the view means, in NOAA's own terms and no further. */
export function densityText(at) {
  if (!at.known) return quietText();
  const [lo, hi] = DENSITY[at.worst].approxMicrogramsPerCubicMetre;
  return `Thickest plume over this view: ${at.worst}. NOAA grades the classes by how opaque the `
    + `smoke looks from orbit and says ${at.worst} smoke is roughly ${lo}-${hi} micrograms per `
    + 'cubic metre through the whole column of air, with no guarantee about the real density.';
}

/** The layer row for one view: the window first, then the class -- or the state that explains an
 *  empty map. Without `latestBody` the quiet sentence would claim a clear sky, so it is not said. */
export function areaReport(body, latestBody = null, nowMs = Date.now()) {
  if (serviceError(body)) return { known: false, worst: null, text: FAILED_TEXT };
  const at = summarise(readPlumes(body));
  if (at.known) return { known: true, worst: at.worst, text: `${windowText(at, nowMs)} ${densityText(at)}` };
  const state = issuedState(readLatestAnalysis(latestBody), nowMs);
  return { known: false, worst: null, text: state.issuedToday ? quietText() : state.text };
}

/** Every string this source can put in front of a reader, in one place, for the test. */
export function readerStrings(body, nowMs = Date.now()) {
  const at = summarise(readPlumes(body));
  return [CREDIT, LAYER_LABEL, LAYER_CAVEAT, FAILED_TEXT, quietText(), densityText(at),
    windowText(at, nowMs), issuedState(null, nowMs).text, issuedState('2026257 1710', nowMs).text,
    areaReport(body, null, nowMs).text];
}

export const LAYER_LABEL = 'Smoke plumes seen from orbit (NOAA analysis, aloft)';
export const LAYER_CAVEAT = 'An analyst\'s outline of smoke ALOFT, drawn from daylight satellite '
  + 'images: it is a column of air seen from above, not the air at head height, and nothing here '
  + 'describes it as such. The three classes are how opaque the smoke looks '
  + 'from orbit, which NOAA says roughly approximates 0-10, 10-21 and 21-32 micrograms per cubic '
  + 'metre in the column, with no guarantee about the real density. Daylight only — nothing is '
  + 'analysed at night, the first plumes of a day appear around local noon, and the row says '
  + 'when a day has not been analysed instead of showing an empty map as a clear sky. North '
  + 'America only, and screen only.';

/** A Leaflet group holding the plumes, one ink with the class carried by opacity. One ink because
 *  NOAA publishes three CLASSES and no colours, so a hue per class would be a palette this app
 *  invented; opacity says thicker without saying anything the source did not. */
export function smokeLayer(L) {
  const group = L.layerGroup();
  group.draw = function draw(rows) {
    group.clearLayers();
    for (const row of rows || []) {
      if (!row.geometry) continue;
      L.geoJSON({ type: 'Feature', geometry: row.geometry, properties: {} }, {
        style: { color: '#8a6a3e', weight: 1, fillColor: '#8a6a3e',
          fillOpacity: 0.10 + 0.10 * (row.order - 1), interactive: false },
      }).addTo(group);
    }
    return group;
  };
  return group;
}

/** Asked for only when a reader asks, and never throws the map. */
async function getJson(url, fetchImpl, signal) {
  try {
    const res = await fetchImpl(url, { signal });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}
export const fetchSmoke = (bbox, { fetchImpl = fetch, signal } = {}) =>
  getJson(smokeQueryUrl(bbox), fetchImpl, signal);

/** One bbox question at a time, waiting out a drag. The day-state question rides with it, and only
 *  when the view was empty, so the row never mixes one view's plumes with another's day-state. */
export function smokeReader({ fetchImpl = fetch, ...rest } = {}) {
  return viewReader({
    ...rest,
    fetchOne: async (bbox, { signal }) => {
      const body = await fetchSmoke(bbox, { fetchImpl, signal });
      const empty = !serviceError(body) && readPlumes(body).length === 0;
      return { body, latest: empty ? await getJson(latestAnalysisUrl(), fetchImpl, signal) : null };
    },
  });
}
