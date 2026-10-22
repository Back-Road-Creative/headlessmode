// Snowpack at SNOTEL sites: snow depth (SNWD) and snow water equivalent (WTEQ) from the USDA
// Natural Resources Conservation Service AWDB REST service. The measurements live on the
// `usdaSnotel` row in source-registry.js.
//
// The station list is a catalogue file this site serves (scripts/qcm/build-snotel-stations.mjs, a
// reviewable diff); only /v1/data is read live, for ONE request covering at most MAX stations, the
// ones nearest the centre of the view (the same choice as the NWS stations, so a view always asks
// the same sites).
//
// Three rules shape this module. A value is a daily value with its own date, which the card keeps
// apart from the time it was fetched, and a stale day is spelled out. A zero is a zero, and an
// element the service omitted is "not reported", never 0. And an empty view means no SNOTEL site is
// listed there, which is not a statement about snow.
import { SOURCES } from './source-registry.js';
import { SYMBOLS } from './legend.js';
import { stationsInView } from './source-nws-observations.js';

const SRC = SOURCES.usdaSnotel;

export const CREDIT_SNOTEL = SRC.attribution;
export const SNOTEL_MAX_STATIONS = SRC.limits.maxStationsPerView;
export const SNOTEL_MAX_BBOX_SQ_DEG = SRC.limits.maxBboxSquareDegrees;
export const CATALOGUE_URL = SRC.endpoints.catalogue;
const WINDOW_DAYS = 7;

export function bboxAreaSqDeg({ minLon, minLat, maxLon, maxLat }) {
  return Math.max(0, maxLon - minLon) * Math.max(0, maxLat - minLat);
}
export function snotelBoxStatus(bbox) {
  const areaSqDeg = bboxAreaSqDeg(bbox);
  return { ok: areaSqDeg <= SNOTEL_MAX_BBOX_SQ_DEG, areaSqDeg };
}

/** The catalogue file into sites. Malformed rows are dropped and counted. */
export function readCatalogue(json) {
  const stations = [];
  let dropped = 0;
  for (const r of Array.isArray(json && json.stations) ? json.stations : []) {
    if (!Array.isArray(r) || !r[0] || !Number.isFinite(r[2]) || !Number.isFinite(r[3])) { dropped += 1; continue; }
    stations.push({ id: String(r[0]), name: String(r[1] || r[0]), lat: r[2], lon: r[3], elevFt: Number.isFinite(r[4]) ? r[4] : null });
  }
  return { stations, dropped };
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The one /v1/data question for these site ids, over the last WINDOW_DAYS days. */
export function snotelUrl(ids, nowMs = Date.now()) {
  const triplets = ids.map((id) => `${id}:SNTL`).join(',');
  const q = [`stationTriplets=${triplets.split(',').map(encodeURIComponent).join(',')}`,
    `elements=${SRC.elements.join(',')}`, 'duration=DAILY',
    `beginDate=${day(nowMs - WINDOW_DAYS * 86400000)}`, `endDate=${day(nowMs)}`];
  return `${SRC.endpoints.data}?${q.join('&')}`;
}

/** The newest usable daily value of one element, or null. A null, non-number or bad date is skipped. */
function newest(el) {
  let best = null;
  for (const v of Array.isArray(el && el.values) ? el.values : []) {
    if (!v || typeof v.value !== 'number' || !Number.isFinite(v.value) || !/^\d{4}-\d{2}-\d{2}$/.test(String(v.date))) continue;
    if (!best || v.date > best.date) best = { v: v.value, date: v.date };
  }
  return best;
}

/** One /v1/data body into per-site readings; a site with no usable value is left out. */
export function readSnotel(json) {
  const sites = [];
  for (const s of Array.isArray(json) ? json : []) {
    const m = /^(\d+:[A-Z]{2}):SNTL$/.exec(String((s && s.stationTriplet) || ''));
    if (!m) continue;
    let snowDepthIn = null, sweIn = null;
    for (const el of Array.isArray(s.data) ? s.data : []) {
      const code = el && el.stationElement && el.stationElement.elementCode;
      if (code === 'SNWD') snowDepthIn = newest(el);
      else if (code === 'WTEQ') sweIn = newest(el);
    }
    if (snowDepthIn || sweIn) sites.push({ id: m[1], snowDepthIn, sweIn });
  }
  return sites;
}

/** One view's answer. Never throws: a failure is a status. A view over the area cap, or with no site
 *  in it, makes no request. */
export async function fetchSnotel(catalogue, bbox, { fetchImpl = fetch, signal, nowMs = Date.now() } = {}) {
  const base = { sites: [], failed: 0, inView: 0, shown: 0, fetchedMs: null };
  if (!snotelBoxStatus(bbox).ok) return { ...base, status: 'too-wide' };
  const { chosen, inView } = stationsInView(catalogue || [], bbox, SNOTEL_MAX_STATIONS);
  if (!chosen.length) return { ...base, status: 'empty', inView };
  let json;
  try {
    const res = await fetchImpl(snotelUrl(chosen.map((s) => s.id), nowMs), { signal });
    if (!res || !res.ok) throw new Error('HTTP');
    json = await res.json();
  } catch (e) { return { ...base, status: 'unavailable', inView, shown: chosen.length }; }
  const byId = new Map(readSnotel(json).map((r) => [r.id, r]));
  const sites = chosen.filter((s) => byId.has(s.id)).map((s) => ({ ...byId.get(s.id), name: s.name, lat: s.lat, lon: s.lon, elevFt: s.elevFt }));
  return { status: sites.length ? 'ready' : 'unavailable', sites, failed: chosen.length - sites.length, inView,
    shown: chosen.length, fetchedMs: nowMs };
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
const trim = (n) => String(Math.round(n * 10) / 10);

/** The card's lines. Depth in inches with centimetres beside, water equivalent in inches with
 *  millimetres beside; the reading's own day and the fetch time on separate lines. */
export function snotelCardLines(site, fetchedMs) {
  const lines = [`${site.name || 'SNOTEL site'}, ${site.id}`];
  if (Number.isFinite(site.elevFt)) lines.push(`Elevation: ${Math.round(site.elevFt).toLocaleString('en-US')} ft`);
  lines.push(site.snowDepthIn ? `Snow depth: ${trim(site.snowDepthIn.v)} in (${Math.round(site.snowDepthIn.v * 2.54)} cm)`
    : 'Snow depth: not reported');
  lines.push(site.sweIn ? `Snow water equivalent: ${trim(site.sweIn.v)} in (${Math.round(site.sweIn.v * 25.4)} mm)`
    : 'Snow water equivalent: not reported');
  const days = [...new Set([site.snowDepthIn, site.sweIn].filter(Boolean).map((x) => x.date))].sort();
  const last = days[days.length - 1];
  if (last) {
    const age = Number.isFinite(fetchedMs) ? Math.round((Date.parse(day(fetchedMs)) - Date.parse(last)) / 86400000) : 0;
    lines.push(`Reading for ${days.join(' and ')} (a daily value, not a time of day)${age >= 2 ? `; ${age} days before it was fetched` : ''}`);
  }
  if (Number.isFinite(fetchedMs)) lines.push(`Fetched ${clock(fetchedMs)}`);
  return lines;
}

const EMPTY = 'There is no SNOTEL site here: none is listed in this view. That is the site list, not a statement that there is no snow.';
/** What the layer row says. A failed or refused request is a sentence, never a blank. */
export function snotelReport(result) {
  if (!result || result.status === 'unavailable') return { text: 'The USDA Natural Resources Conservation Service did not answer with a usable reading for the SNOTEL sites in this view, so none are drawn.' };
  if (result.status === 'catalogue-unavailable') return { text: 'The list of SNOTEL sites did not load, so none are drawn. Turn the layer off and on to try again.' };
  if (result.status === 'too-wide') return { text: `This view is wider than ${SNOTEL_MAX_BBOX_SQ_DEG} square degrees, which the SNOTEL request is held under. Zoom in to see sites; none are drawn at this size.` };
  if (result.status === 'empty') return { text: EMPTY };
  const head = result.inView > result.shown
    ? `${result.shown} of ${plural(result.inView, 'site')} in view are shown, the nearest the centre of the view; zoom in for the rest.`
    : `${plural(result.sites.length, 'SNOTEL site')} in view.`;
  const none = result.sites.filter((s) => s.snowDepthIn && s.snowDepthIn.v === 0).length;
  const parts = [`${head} Each marker carries the day of its own reading. Fetched ${clock(result.fetchedMs)}.`];
  if (none) parts.push(`${plural(none, 'site')} measured no snow on the ground at the latest reading.`);
  if (result.failed) parts.push(`${plural(result.failed, 'site')} had no usable reading and ${result.failed === 1 ? 'is' : 'are'} not drawn.`);
  return { text: parts.join(' ') };
}

/** A Leaflet group of one circle marker per site; the card is a popup whose lines are set as text,
 *  so nothing from the feed is parsed as markup. */
export function snotelLayer(L) {
  const group = L.layerGroup();
  group.draw = function draw(sites, fetchedMs) {
    group.clearLayers();
    for (const site of sites || []) {
      const card = typeof document !== 'undefined' ? document.createElement('div') : { children: [] };
      if (card.appendChild) {
        snotelCardLines(site, fetchedMs).forEach((line, i) => {
          const el = document.createElement(i === 0 ? 'strong' : 'div');
          el.textContent = line;
          card.appendChild(el);
        });
      }
      L.circleMarker([site.lat, site.lon], { radius: 6, weight: 2, color: '#0f4c5c', fillColor: '#7fc8d8', fillOpacity: 0.9, keyboard: true })
        .bindPopup(card).addTo(group);
    }
    return group;
  };
  return group;
}

export const SNOTEL_LABEL = 'Snowpack at SNOTEL sites (snow depth and water content)';
export const SNOTEL_CAVEAT = 'The newest daily snow depth and snow water equivalent from the USDA Natural Resources Conservation '
  + 'Service SNOTEL sites nearest the centre of the view, at most 12 of them. The sites are Western and alpine: '
  + 'about 900 stations in 13 states, mostly on high mountain ground, and most Eastern counties have none. '
  + 'No SNOTEL site here means none is listed in the view, not that there is no snow. A reading is one daily value '
  + 'with its own date, shown apart from the time it was fetched, and in autumn a zero or a missing value is '
  + 'ordinary. It is what one instrument measured, not an avalanche forecast, not a road or trail condition and not '
  + 'the snow around it. Screen only, not printed. Zoom in to load it: a view wider than '
  + `${SNOTEL_MAX_BBOX_SQ_DEG} square degrees is not requested.`;

export const SNOTEL_ROW = Object.freeze({
  id: 'snotelSnowpack', group: 'federal', label: SNOTEL_LABEL, sourceId: 'usdaSnotel',
  screenOnly: true,   // a live reading has no basis for a printed sheet
  notIn3d: true,      // main.js draws it on the 2D map only; 3D lists it as "Available in 2D"
  defaultOn: false, required: false,
  symbolKeys: [SYMBOLS.snotelSite.key],
  emptyMeans: 'ambiguous',
  status: 'live', coverageCaveat: SNOTEL_CAVEAT,
  render: { labels: 'none', dropBelowScale: null },
});

export function readerStrings() {
  const site = { id: '1:CO', name: null, snowDepthIn: { v: 0, date: '2026-10-19' }, sweIn: null };
  return [CREDIT_SNOTEL, SNOTEL_LABEL, SNOTEL_CAVEAT, EMPTY, ...snotelCardLines(site, Date.parse('2026-10-20T00:00:00Z')),
    snotelReport(null).text, snotelReport({ status: 'catalogue-unavailable' }).text, snotelReport({ status: 'too-wide' }).text,
    snotelReport({ status: 'ready', sites: [site], inView: 20, shown: 12, failed: 1, fetchedMs: 0 }).text];
}
