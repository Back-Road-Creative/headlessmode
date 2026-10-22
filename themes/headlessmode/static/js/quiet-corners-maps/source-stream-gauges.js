// USGS stream gauges: the newest streamflow (00060) and gage-height (00065) reading each active
// station has published, asked by bounding box from the USGS Water Data OGC API. The
// measurements, and why the legacy waterservices host is not used, live on the
// `usgsWaterGauges` row in source-registry.js.
//
// Three rules shape this module. A reading carries its OWN time, because one station's newest
// flow was published in 2009; the card keeps that time and the time the answer was fetched on
// separate lines. A no-data sentinel or a non-number is dropped and counted, never drawn as a
// value. And a box over the area cap is never requested: the reader is told to zoom in.
import { SOURCES } from './source-registry.js';
import { SYMBOLS } from './legend.js';

const SRC = SOURCES.usgsWaterGauges;

export const SERVICE = SRC.serviceUrl;
export const CREDIT = SRC.attribution;
export const PARAMETER_CODES = SRC.parameterCodes;
export const MAX_BBOX_SQ_DEG = SRC.limits.maxBboxSquareDegrees;
export const RECORD_BUDGET = SRC.limits.recordBudgetPerExtent;

/** Parameter code -> the words a reader sees. Gage height is the water surface above the
 *  station's own datum, so it is never compared between stations. */
const PARAMETERS = Object.freeze({
  '00060': { label: 'Streamflow', unit: 'ft³/s' },
  '00065': { label: 'Gage height', unit: 'ft' },
});
const UNIT_WORDS = Object.freeze({ 'ft^3/s': 'ft³/s', ft: 'ft' });
/** NWIS no-data sentinel, as the legacy service published it in `noDataValue`. */
const SENTINEL = -999999;

export function bboxAreaSqDeg({ minLon, minLat, maxLon, maxLat }) {
  return Math.max(0, maxLon - minLon) * Math.max(0, maxLat - minLat);
}

/** Whether a view may be asked at all. Pure, so the refusal is proved without a network. */
export function boxStatus(bbox) {
  const areaSqDeg = bboxAreaSqDeg(bbox);
  return { ok: areaSqDeg <= MAX_BBOX_SQ_DEG, areaSqDeg };
}

const num = (n) => String(Math.round(n * 1e6) / 1e6);

export function latestUrl({ minLon, minLat, maxLon, maxLat }) {
  return SRC.endpoints.byBox
    .replace('{bbox}', [minLon, minLat, maxLon, maxLat].map(num).join(','))
    .replace('{codes}', PARAMETER_CODES.join(','))
    .replace('{limit}', String(RECORD_BUDGET));
}

export function namesUrl(ids) {
  return SRC.endpoints.names.replace('{ids}', ids.join(',')).replace('{limit}', String(RECORD_BUDGET));
}

/** Station readings out of the two response bodies. `names` may be null: the station number
 *  alone still identifies a station. Returns the stations, how many candidate readings were
 *  dropped as unreadable, and the count of features seen (for the budget check). */
export function readGauges(latest, names) {
  const nameById = new Map();
  for (const f of Array.isArray(names && names.features) ? names.features : []) {
    const p = (f && f.properties) || {};
    if (p.id && p.monitoring_location_name) nameById.set(p.id, p.monitoring_location_name);
  }
  const sites = new Map();
  let dropped = 0;
  const features = Array.isArray(latest && latest.features) ? latest.features : [];
  for (const f of features) {
    const p = (f && f.properties) || {};
    const spec = PARAMETERS[p.parameter_code];
    if (!spec) continue;   // not a code that was asked for
    const value = p.value === null || p.value === undefined || p.value === '' ? NaN : Number(p.value);
    const timeMs = Date.parse(p.time);
    const c = f.geometry && f.geometry.type === 'Point' ? f.geometry.coordinates : null;
    if (!Number.isFinite(value) || value <= SENTINEL || !Number.isFinite(timeMs)
      || !Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) { dropped += 1; continue; }
    const id = String(p.monitoring_location_id || '');
    let site = sites.get(id);
    if (!site) {
      site = { id, siteNo: id.replace(/^USGS-/, ''), name: nameById.get(id) || null,
        lat: c[1], lon: c[0], readings: [] };
      sites.set(id, site);
    }
    const reading = { code: p.parameter_code, label: spec.label,
      unit: UNIT_WORDS[p.unit_of_measure] || spec.unit, value, timeMs,
      approval: p.approval_status || null };
    const at = site.readings.findIndex((r) => r.code === reading.code);
    if (at === -1) site.readings.push(reading);
    else if (site.readings[at].timeMs < reading.timeMs) site.readings[at] = reading;
  }
  return { sites: [...sites.values()], dropped, seen: features.length };
}

async function getJson(url, fetchImpl, signal) {
  const res = await fetchImpl(url, { signal });
  if (!res || !res.ok) throw new Error(`HTTP ${res && res.status}`);
  return res.json();
}

/** One view's answer. Never throws: a failure is `status: 'unavailable'`. The names request
 *  is secondary, so its failure leaves the stations unnamed rather than hiding them. */
export async function fetchGauges(bbox, { fetchImpl = fetch, signal, nowMs = Date.now() } = {}) {
  if (!boxStatus(bbox).ok) return { status: 'too-wide', sites: [], dropped: 0, capped: false, fetchedMs: null };
  let latest;
  try { latest = await getJson(latestUrl(bbox), fetchImpl, signal); } catch (e) {
    return { status: 'unavailable', sites: [], dropped: 0, capped: false, fetchedMs: null };
  }
  const first = readGauges(latest, null);
  const capped = first.seen >= RECORD_BUDGET;
  let names = null;
  if (first.sites.length) {
    try { names = await getJson(namesUrl(first.sites.map((s) => s.id)), fetchImpl, signal); } catch (e) { names = null; }
  }
  const got = names ? readGauges(latest, names) : first;
  return { status: got.sites.length ? 'ready' : 'empty', sites: got.sites, dropped: got.dropped,
    capped, fetchedMs: nowMs, namesMissing: !names && first.sites.length > 0 };
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

/** The card's lines. The value, its unit, the READING's own time and the FETCH time are
 *  separate, because the reading can be hours or years older than the fetch. */
export function cardLines(site, fetchedMs) {
  const head = `${site.name || 'USGS gauge'}, USGS ${site.siteNo}`;
  const lines = [head];
  for (const r of site.readings) lines.push(`${r.label}: ${r.value} ${r.unit}`);
  const sameTime = site.readings.every((r) => r.timeMs === site.readings[0].timeMs);
  for (const r of (sameTime ? site.readings.slice(0, 1) : site.readings)) {
    const age = Number.isFinite(fetchedMs) && fetchedMs - r.timeMs >= 90 * 60000
      ? ` (${spanText(r.timeMs, fetchedMs)} before it was fetched)` : '';
    const marks = [...new Set((sameTime ? site.readings : [r]).map((x) => x.approval).filter(Boolean))];
    const state = marks.length ? `, ${marks.join(' and ')} data` : '';
    lines.push(`${sameTime ? '' : `${r.label} `}${sameTime ? 'Reading time' : 'reading time'} ${clock(r.timeMs)}${age}${state}`);
  }
  if (Number.isFinite(fetchedMs)) lines.push(`Fetched ${clock(fetchedMs)}`);
  return lines;
}

/** What the layer row says. A failed or refused request is a sentence, never a blank. */
export function areaReport(result) {
  if (!result || result.status === 'unavailable') {
    return { text: 'The USGS water service did not answer for this view, so no gauges are drawn.' };
  }
  if (result.status === 'too-wide') {
    return { text: `This view is wider than ${MAX_BBOX_SQ_DEG} square degrees, which the gauge `
      + 'request is held under. Zoom in to see gauges; none are drawn at this size.' };
  }
  if (result.status === 'empty') {
    return { text: 'No active gauge reports flow or gage height in this view. That is the '
      + 'network not reaching here, rather than a statement about the water.' };
  }
  const newest = Math.max(...result.sites.flatMap((s) => s.readings.map((r) => r.timeMs)));
  const parts = [`${plural(result.sites.length, 'gauge')} in view. Each marker carries its own reading time; the newest is ${clock(newest)}. Fetched ${clock(result.fetchedMs)}.`];
  if (result.dropped) parts.push(`${plural(result.dropped, 'reading')} had no usable value and ${result.dropped === 1 ? 'was' : 'were'} left out.`);
  if (result.capped) parts.push('USGS reports more gauges than this view can show; zoom in for the rest.');
  if (result.namesMissing) parts.push('Station names did not load, so markers show the station number.');
  return { text: parts.join(' ') };
}

/** A Leaflet group of one circle marker per station. The card is a popup whose lines are set
 *  as text, so nothing from the feed is parsed as markup. A circle marker is keyboard
 *  reachable (Leaflet gives its path a tab stop) and opens its card on Enter. */
export function gaugeLayer(L) {
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
        radius: 7, weight: 2, color: '#1d4f6e', fillColor: '#4aa3d8', fillOpacity: 0.85, keyboard: true,
      }).bindPopup(card).addTo(group);
    }
    return group;
  };
  return group;
}

/** One question at a time, only for the view the reader stopped on; an answer about a view
 *  the reader left is dropped. `ask` resolves false when it was dropped. */
export function gaugeReader({ fetchFn = fetchGauges, waitMs = 400,
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

export const LAYER_LABEL = 'Stream gauges (flow and gage height, latest USGS reading)';
export const LAYER_CAVEAT = 'The newest streamflow and gage-height reading each active USGS gauge '
  + 'has published, one marker per station. Every reading carries its own time and the card shows '
  + 'it separately from the time it was fetched, because a reading can be hours old and a few '
  + 'stations’ newest are years old. Most values are provisional and subject to revision. This '
  + 'is not a forecast, not a flood warning and not a statement that a crossing is safe; a view '
  + 'with no gauge means none reports there, not that the water is low. Zoom in to load gauges: a '
  + 'view wider than 25 square degrees is not requested. This replaces whichever other context '
  + 'surface was chosen; only one can be drawn at a time.';

export const CONTEXT_ROW = Object.freeze({
  id: 'streamGauges',
  group: 'context',
  label: LAYER_LABEL,
  sourceId: 'usgsWaterGauges',
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
  const site = { id: 'USGS-1', siteNo: '1', name: null, readings: [] };
  return [CREDIT, LAYER_LABEL, LAYER_CAVEAT, ...cardLines(site, 0),
    areaReport(null).text, areaReport({ status: 'too-wide' }).text, areaReport({ status: 'empty' }).text];
}
