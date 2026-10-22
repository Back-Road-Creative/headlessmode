// NWS weather stations: the newest temperature, wind and humidity observation each station in
// view has published, from api.weather.gov. The measurements live on the `nwsObservations` row
// in source-registry.js.
//
// /stations has no bounding-box filter, so WHICH stations exist comes from a catalogue file this
// site serves (built by scripts/qcm/build-nws-stations.mjs, a reviewable diff), and only
// /stations/{id}/observations/latest is read live -- for at most MAX_STATIONS stations, the ones
// nearest the centre of the view (ties by id), so the same view always asks the same stations.
//
// Three rules shape this module. An observation carries its OWN time, which the card keeps apart
// from the time it was fetched. A null value or a quality-control 'X' (failed) reading is
// dropped and counted, never drawn. And a failed request is a stated line, never a blank.
import { SOURCES } from './source-registry.js';
import { SYMBOLS } from './legend.js';

const SRC = SOURCES.nwsObservations;

export const SERVICE = SRC.serviceUrl;
export const CREDIT = SRC.attribution;
export const MAX_STATIONS = SRC.limits.maxStationsPerView;
export const MAX_BBOX_SQ_DEG = SRC.limits.maxBboxSquareDegrees;
export const CATALOGUE_URL = '/data/quiet-corners-maps/nws-stations/stations.json';

/** NWS 403s a request with no User-Agent; the browser supplies its own, so the page sets only
 *  the one header (the same as the forecast and alerts sources). */
export const requestHeaders = () => ({ Accept: 'application/geo+json' });

export function bboxAreaSqDeg({ minLon, minLat, maxLon, maxLat }) {
  return Math.max(0, maxLon - minLon) * Math.max(0, maxLat - minLat);
}
export function boxStatus(bbox) {
  const areaSqDeg = bboxAreaSqDeg(bbox);
  return { ok: areaSqDeg <= MAX_BBOX_SQ_DEG, areaSqDeg };
}

export const cToF = (c) => Math.round((c * 9 / 5 + 32) * 10) / 10;
export const kmhToMph = (k) => k / 1.609344;
const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (deg) => POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

/** The catalogue file into stations. Malformed rows are dropped and counted. */
export function readCatalogue(json) {
  const stations = [];
  let dropped = 0;
  for (const r of Array.isArray(json && json.stations) ? json.stations : []) {
    if (!Array.isArray(r) || !r[0] || !Number.isFinite(r[2]) || !Number.isFinite(r[3])) { dropped += 1; continue; }
    stations.push({ id: String(r[0]), name: String(r[1] || r[0]), lat: r[2], lon: r[3],
      elevM: Number.isFinite(r[4]) ? r[4] : null });
  }
  return { stations, dropped };
}

/** The stations inside the view, and the (at most `max`) nearest its centre. Distance is in
 *  degrees with longitude scaled by cos(latitude); equal distances fall to the id. */
export function stationsInView(stations, { minLon, minLat, maxLon, maxLat }, max = MAX_STATIONS) {
  const cLat = (minLat + maxLat) / 2, cLon = (minLon + maxLon) / 2;
  const k = Math.cos((cLat * Math.PI) / 180);
  const inside = stations.filter((s) => s.lat >= minLat && s.lat <= maxLat && s.lon >= minLon && s.lon <= maxLon);
  const d = (s) => Math.hypot(s.lat - cLat, (s.lon - cLon) * k);
  const sorted = inside.map((s) => ({ s, d: d(s) }))
    .sort((a, b) => (a.d - b.d) || (a.s.id < b.s.id ? -1 : a.s.id > b.s.id ? 1 : 0));
  return { chosen: sorted.slice(0, max).map((x) => x.s), inView: inside.length };
}

export const observationUrl = (id) => SRC.endpoints.latest.replace('{id}', encodeURIComponent(id));

/** One /observations/latest body into a station reading, or null when it has no usable time or
 *  no usable value. `dropped` counts the asked-for values that were null, not a number, or
 *  quality-control 'X'. */
export function readObservation(json) {
  const p = (json && json.properties) || {};
  const timeMs = Date.parse(p.timestamp);
  if (!Number.isFinite(timeMs)) return null;
  let dropped = 0;
  const get = (key) => {
    const q = p[key];
    if (!q || q.value === null || q.value === undefined || q.value === '' || typeof q.value === 'boolean'
      || !Number.isFinite(Number(q.value)) || q.qualityControl === 'X') { dropped += 1; return null; }
    return { v: Number(q.value), unit: String(q.unitCode || ''), qc: q.qualityControl || null };
  };
  const kmh = (q) => (/m_s-1$/.test(q.unit) ? q.v * 3.6 : /mi_h-1$/.test(q.unit) ? q.v * 1.609344
    : /kn|kt/.test(q.unit) ? q.v * 1.852 : q.v);
  const values = {};
  const t = get('temperature');
  if (t) values.temperature = { c: /degF$/.test(t.unit) ? (t.v - 32) * 5 / 9 : t.v, qc: t.qc };
  const h = get('relativeHumidity');
  if (h) values.humidity = { pct: Math.round(h.v), qc: h.qc };
  const ws = get('windSpeed');
  if (ws) values.windSpeed = { kmh: kmh(ws), qc: ws.qc };
  const wd = get('windDirection');
  if (wd) values.windDirection = { deg: wd.v, qc: wd.qc };
  const wg = get('windGust');
  if (wg) values.windGust = { kmh: kmh(wg), qc: wg.qc };
  if (!values.temperature && !values.humidity && !values.windSpeed) return null;
  const c = json.geometry && json.geometry.type === 'Point' ? json.geometry.coordinates : null;
  const id = String(p.stationId || '');
  return { id, name: p.stationName || null,
    lat: Array.isArray(c) ? c[1] : null, lon: Array.isArray(c) ? c[0] : null, timeMs, values, dropped };
}

/** One view's answer. Never throws: a failure is a status. The view is asked about only when it is
 *  under the area cap; each chosen station is its own request and one failing leaves the rest. */
export async function fetchObservations(stations, bbox, { fetchImpl = fetch, signal, nowMs = Date.now() } = {}) {
  const base = { sites: [], failed: 0, droppedValues: 0, inView: 0, shown: 0, fetchedMs: null };
  if (!boxStatus(bbox).ok) return { ...base, status: 'too-wide' };
  const { chosen, inView } = stationsInView(stations, bbox);
  if (!chosen.length) return { ...base, status: 'empty', inView };
  const answers = await Promise.all(chosen.map(async (s) => {
    try {
      const res = await fetchImpl(observationUrl(s.id), { signal, headers: requestHeaders() });
      if (!res || !res.ok) return null;
      const o = readObservation(await res.json());
      if (!o) return null;
      return { ...o, id: o.id || s.id, name: o.name || s.name,
        lat: Number.isFinite(o.lat) ? o.lat : s.lat, lon: Number.isFinite(o.lon) ? o.lon : s.lon };
    } catch (e) { return null; }
  }));
  const sites = answers.filter(Boolean);
  return { status: sites.length ? 'ready' : 'unavailable', sites, failed: answers.length - sites.length,
    droppedValues: sites.reduce((n, s) => n + s.dropped, 0), inView, shown: chosen.length, fetchedMs: nowMs };
}

/** The catalogue, read once by the page. Never throws. */
export async function loadCatalogue(fetchImpl = fetch) {
  try {
    const res = await fetchImpl(CATALOGUE_URL);
    if (!res || !res.ok) throw new Error('catalogue');
    return { status: 'ready', ...readCatalogue(await res.json()) };
  } catch (e) { return { status: 'unavailable', stations: [], dropped: 0 }; }
}

const clock = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function spanText(fromMs, toMs) {
  const min = Math.round((toMs - fromMs) / 60000);
  if (min < 90) return plural(Math.max(0, min), 'minute');
  if (min < 2 * 1440) return plural(Math.round(min / 60), 'hour');
  if (min < 2 * 525600) return plural(Math.round(min / 1440), 'day');
  return plural(Math.round(min / 525600), 'year');
}

/** The card's lines: each value with its unit, then the observation's own time and the fetch
 *  time on separate lines. */
export function cardLines(site, fetchedMs) {
  const v = site.values;
  const lines = [`${site.name || 'NWS station'}, ${site.id}`];
  if (v.temperature) lines.push(`Temperature: ${Math.round(cToF(v.temperature.c))} °F (${Math.round(v.temperature.c)} °C)`);
  if (v.windSpeed) {
    const mph = (k) => `${Math.round(kmhToMph(k))} mph (${Math.round(k)} km/h)`;
    let w = `Wind: ${mph(v.windSpeed.kmh)}`;
    if (v.windDirection) w += ` from the ${compass(v.windDirection.deg)} (${Math.round(v.windDirection.deg)}°)`;
    if (v.windGust) w += `, gusting ${mph(v.windGust.kmh)}`;
    lines.push(w);
  }
  if (v.humidity) lines.push(`Relative humidity: ${v.humidity.pct}%`);
  const age = Number.isFinite(fetchedMs) && fetchedMs - site.timeMs >= 90 * 60000
    ? ` (${spanText(site.timeMs, fetchedMs)} before it was fetched)` : '';
  lines.push(`Observed ${clock(site.timeMs)}${age}`);
  if (Number.isFinite(fetchedMs)) lines.push(`Fetched ${clock(fetchedMs)}`);
  return lines;
}

/** What the layer row says. A failed or refused request is a sentence, never a blank. */
export function areaReport(result) {
  if (!result || result.status === 'unavailable') {
    return { text: 'The National Weather Service did not answer for the stations in this view, so no observations are drawn.' };
  }
  if (result.status === 'catalogue-unavailable') {
    return { text: 'The list of weather stations did not load, so none are drawn. Turn the layer off and on to try again.' };
  }
  if (result.status === 'too-wide') {
    return { text: `This view is wider than ${MAX_BBOX_SQ_DEG} square degrees, which the station request is held under. Zoom in to see stations; none are drawn at this size.` };
  }
  if (result.status === 'empty') {
    return { text: 'No listed weather station is in this view. That is the station list not reaching here, rather than a statement about the weather.' };
  }
  const newest = Math.max(...result.sites.map((s) => s.timeMs));
  const head = result.inView > result.shown
    ? `${result.shown} of ${plural(result.inView, 'station')} in view are shown, the nearest the centre of the view; zoom in for the rest.`
    : `${plural(result.sites.length, 'station')} in view.`;
  const parts = [`${head} Each marker carries its own observation time; the newest is ${clock(newest)}. Fetched ${clock(result.fetchedMs)}.`];
  if (result.failed) parts.push(`${plural(result.failed, 'station')} did not answer with a usable reading and ${result.failed === 1 ? 'is' : 'are'} not drawn.`);
  if (result.droppedValues) parts.push(`${plural(result.droppedValues, 'reading')} had no usable value (missing or failed quality control) and ${result.droppedValues === 1 ? 'was' : 'were'} left out.`);
  return { text: parts.join(' ') };
}

/** A Leaflet group of one circle marker per station; the card is a popup whose lines are set as
 *  text, so nothing from the feed is parsed as markup. */
export function observationLayer(L) {
  const group = L.layerGroup();
  group.draw = function draw(sites, fetchedMs) {
    group.clearLayers();
    for (const site of sites || []) {
      const card = (typeof document !== 'undefined' ? document.createElement('div') : { children: [] });
      if (card.appendChild) {
        cardLines(site, fetchedMs).forEach((line, i) => {
          const el = document.createElement(i === 0 ? 'strong' : 'div');
          el.textContent = line;
          card.appendChild(el);
        });
      }
      L.circleMarker([site.lat, site.lon], {
        radius: 7, weight: 2, color: '#7a4a12', fillColor: '#e8a33d', fillOpacity: 0.85, keyboard: true,
      }).bindPopup(card).addTo(group);
    }
    return group;
  };
  return group;
}

/** One question at a time, only for the view the reader stopped on; `ask` resolves false when
 *  its answer was dropped. */
export function observationReader({ fetchFn = fetchObservations, waitMs = 400,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null, live = null, drop = null;
  const stop = () => {
    if (timer) clearTimer(timer);
    if (live) live.abort();
    if (drop) drop(false);
    timer = null; live = null; drop = null;
  };
  return {
    cancel: stop,
    ask(bbox, stations, deliver) {
      stop();
      return new Promise((resolve) => {
        drop = resolve;
        timer = setTimer(async () => {
          timer = null;
          const ctl = new AbortController();
          live = ctl;
          const got = await fetchFn(stations, bbox, { signal: ctl.signal });
          if (live !== ctl) return;
          live = null; drop = null;
          deliver(got);
          resolve(true);
        }, waitMs);
      });
    },
  };
}

export const LAYER_LABEL = 'Weather stations (temperature, wind and humidity now)';
export const LAYER_CAVEAT = 'The newest temperature, wind and relative-humidity observation from the '
  + 'National Weather Service stations nearest the centre of the view, at most 12 of them. The station '
  + 'list covers Tennessee, North Carolina, Georgia, South Carolina and Colorado only. Every '
  + 'observation carries its own time and the card shows it separately from the time it was '
  + 'fetched. This is what a station measured, not a forecast, and not the weather everywhere '
  + 'around it: stations are mostly airports, and a mountain valley can differ a lot from the '
  + 'nearest one. A reading that failed quality control or is missing is left out. Zoom in to load '
  + 'stations: a view wider than 25 square degrees is not requested. This replaces whichever '
  + 'other context surface was chosen; only one can be drawn at a time.';

export const CONTEXT_ROW = Object.freeze({
  id: 'nwsObservations',
  group: 'context',
  label: LAYER_LABEL,
  sourceId: 'nwsObservations',
  screenOnly: true,   // a live reading has no basis for a printed sheet
  defaultOn: false,
  required: false,
  symbolKeys: [SYMBOLS.basemap.key],
  emptyMeans: 'ambiguous',
  status: 'live',
  coverageCaveat: LAYER_CAVEAT,
  render: { labels: 'none', dropBelowScale: null },
});

export function readerStrings() {
  const site = { id: 'KXXX', name: null, timeMs: 0, values: { temperature: { c: 0 }, windSpeed: { kmh: 0 }, windDirection: { deg: 0 }, humidity: { pct: 0 } } };
  return [CREDIT, LAYER_LABEL, LAYER_CAVEAT, ...cardLines(site, 0),
    areaReport(null).text, areaReport({ status: 'catalogue-unavailable' }).text,
    areaReport({ status: 'too-wide' }).text, areaReport({ status: 'empty' }).text];
}
