// Historic places: National Register of Historic Places points, asked by bounding box from the
// National Park Service's keyless ArcGIS MapServer (mapservices.nps.gov, layer 0). The
// measurements, and why the keyed NPS API is not used, live on the `npsNrhp` row in
// source-registry.js.
//
// Three rules shape this module. A box over the view gate is never requested (the register is dense:
// 993 listed points sat in 0.09 sq deg of Boston), and a full page says so rather than pass as the
// whole. A geometry that is not a pair of finite numbers is dropped and counted, never drawn. And
// the words say what the layer is: a register inventory with approximate positions, never a
// statement about access, condition or merit. The card's link is built only from a reference number
// made of digits, so nothing from the feed is parsed as a URL or as markup.
import { SOURCES } from './source-registry.js';
import { SYMBOLS } from './legend.js';
import { bboxAreaSqDeg } from './source-ntad-rail-airports.js';

const NRHP = SOURCES.npsNrhp;

export const CREDIT_NRHP = NRHP.attribution;
export const NRHP_MAX_BBOX_SQ_DEG = NRHP.limits.maxBboxSquareDegrees;
export const NRHP_RECORD_BUDGET = NRHP.limits.recordBudgetPerExtent;
const FIELDS = ['RESNAME', 'NRIS_Refnum', 'CertDate', 'City', 'State'];

/** Whether a view may be asked at all. Pure, so the refusal is proved without a network. */
export function nrhpBoxStatus(bbox) {
  const areaSqDeg = bboxAreaSqDeg(bbox);
  return { ok: areaSqDeg <= NRHP_MAX_BBOX_SQ_DEG, areaSqDeg };
}

const num = (n) => String(Math.round(n * 1e6) / 1e6);
export function nrhpUrl({ minLon, minLat, maxLon, maxLat }) {
  const p = new URLSearchParams({
    where: "STATUS='Listed'",   // 648 records are Removed from the register and are not asked
    geometry: [minLon, minLat, maxLon, maxLat].map(num).join(','),
    geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    outFields: FIELDS.join(','), returnGeometry: 'true', resultRecordCount: String(NRHP_RECORD_BUDGET), f: 'json',
  });
  return `${NRHP.layers[0].queryUrl}?${p}`;
}

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** CertDate arrives as 'YYYY-MM-' (and is empty on some records). Month and year, or null. */
export function certDateText(v) {
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-$/.exec(v.trim()) : null;
  const month = m ? Number(m[2]) : 0;
  return month >= 1 && month <= 12 ? `${MONTHS[month - 1]} ${m[1]}` : null;
}

/** The NPS nomination document for a reference number, on NPGallery. Measured 2026-10-20: 8 of 8
 *  sampled real 8- and 9-digit numbers answered application/pdf; a number NPS has nothing for
 *  answers a small placeholder image instead, which is why the card words it "where NPS has scanned
 *  one". Anything that is not 8 or 9 digits (the 'SG' numbers are not served this way) gets no link. */
export function nrhpListingUrl(refnum) {
  return typeof refnum === 'string' && /^\d{8,9}$/.test(refnum)
    ? `https://npgallery.nps.gov/pdfhost/docs/NRHP/Text/${refnum}.pdf` : null;
}

/** Places out of one response body; a record without a finite x and y is dropped and counted. */
export function readNrhp(json) {
  const features = Array.isArray(json && json.features) ? json.features : [];
  const places = [];
  let dropped = 0;
  for (const f of features) {
    const g = f && f.geometry;
    if (!g || !finite(g.x) || !finite(g.y)) { dropped += 1; continue; }
    const a = f.attributes || {};
    places.push({ name: text(a.RESNAME), refnum: text(a.NRIS_Refnum), certified: certDateText(a.CertDate),
      city: text(a.City), state: text(a.State), lat: g.y, lon: g.x });
  }
  return { places, dropped, seen: features.length,
    capped: !!json && (json.exceededTransferLimit === true || features.length >= NRHP_RECORD_BUDGET) };
}

async function getJson(url, fetchImpl, signal) {
  const res = await fetchImpl(url, { signal });
  if (!res || !res.ok) throw new Error(`HTTP ${res && res.status}`);
  const json = await res.json();
  if (json && json.error) throw new Error('service refused the query');
  return json;
}

/** One view's answer. Never throws: a failure is `status: 'unavailable'`. */
export async function fetchNrhp(bbox, { fetchImpl = fetch, signal, nowMs = Date.now() } = {}) {
  const none = { places: [], dropped: 0, capped: false, fetchedMs: null };
  if (!nrhpBoxStatus(bbox).ok) return { status: 'too-wide', ...none };
  let json;
  try { json = await getJson(nrhpUrl(bbox), fetchImpl, signal); } catch (e) { return { status: 'unavailable', ...none }; }
  const got = readNrhp(json);
  return { status: got.places.length ? 'ready' : 'empty', places: got.places, dropped: got.dropped, capped: got.capped, fetchedMs: nowMs };
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function nrhpCardLines(p) {
  const lines = [p.name || 'Historic place'];
  if (p.refnum) lines.push(`National Register reference number ${p.refnum}`);
  if (p.certified) lines.push(`Listed: ${p.certified}`);
  const place = [p.city, p.state].filter(Boolean).join(', ');
  if (place) lines.push(place);
  lines.push('On the National Register of Historic Places; the register says nothing of access, and the position is approximate.');
  return lines;
}

const clock = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const LINK_TEXT = 'NPS nomination document (PDF, where NPS has scanned one)';
const EMPTY = 'No listed historic place is in this view. That is the register’s list, not a statement that nothing old stands here.';
export function nrhpReport(result) {
  if (!result || result.status === 'unavailable') return { text: 'The National Park Service service did not answer for this view, so no historic places are drawn.' };
  if (result.status === 'too-wide') {
    return { text: `This view is wider than ${NRHP_MAX_BBOX_SQ_DEG} square degrees, which the historic places request is held under. Zoom in to see them; none are drawn at this size.` };
  }
  if (result.status === 'empty') return { text: EMPTY };
  const n = result.places.length;
  const parts = [`${plural(n, 'historic place')} in view (National Register of Historic Places, listed properties). Fetched ${clock(result.fetchedMs)}.`];
  if (result.dropped) parts.push(`${plural(result.dropped, 'record')} had no usable position and ${result.dropped === 1 ? 'was' : 'were'} left out.`);
  if (result.capped) parts.push(`The register holds more historic places than this view can show (${NRHP_RECORD_BUDGET} at most); zoom in for the rest.`);
  return { text: parts.join(' ') };
}

function card(p) {
  const lines = nrhpCardLines(p);
  const el = typeof document !== 'undefined' ? document.createElement('div') : { children: [] };
  if (el.appendChild) {
    lines.forEach((line, i) => { const c = document.createElement(i === 0 ? 'strong' : 'div'); c.textContent = line; el.appendChild(c); });
    const href = nrhpListingUrl(p.refnum);
    if (href) {
      const a = document.createElement('a');
      a.href = href; a.textContent = LINK_TEXT; a.target = '_blank'; a.rel = 'noopener noreferrer';
      const row = document.createElement('div'); row.appendChild(a); el.appendChild(row);
    }
  }
  return el;
}

/** A Leaflet group of one circle marker per place (keyboard reachable, opens its card on Enter).
 *  The card is set as text, so nothing from the feed is parsed as markup. */
export function nrhpLayer(L) {
  const group = L.layerGroup();
  group.draw = function draw(places) {
    group.clearLayers();
    for (const p of places || []) {
      L.circleMarker([p.lat, p.lon], { radius: 5, weight: 2, color: '#8d4a1f', fillColor: '#d9a066', fillOpacity: 0.85, keyboard: true })
        .bindPopup(card(p)).addTo(group);
    }
    return group;
  };
  return group;
}

export const NRHP_LABEL = 'Historic places (National Register, NPS)';
export const NRHP_CAVEAT = 'Properties listed on the National Register of Historic Places, as the National Park Service '
  + 'publishes them, one mark each with its reference number and the month it was certified. A listing is a record, '
  + 'not a statement about access, condition or whether anything still stands, and many are private. Positions are '
  + 'approximate, so a mark can sit a street away from the place. No mark in view means none is listed there, not '
  + 'that nothing old is there. Screen only, not printed. Zoom in to load it: a view wider than '
  + `${NRHP_MAX_BBOX_SQ_DEG} square degrees is not requested, and ${NRHP_RECORD_BUDGET} marks is the most one view shows.`;

export const NRHP_ROW = Object.freeze({
  id: 'historicPlaces', group: 'federal', label: NRHP_LABEL, sourceId: 'npsNrhp',
  screenOnly: true,   // an inventory read live per view is no basis for a printed sheet
  notIn3d: true,      // main.js draws it on the 2D map only; 3D lists it as "Available in 2D"
  defaultOn: false, required: false,
  symbolKeys: [SYMBOLS.historicPlace.key],
  emptyMeans: 'ambiguous',
  status: 'live', coverageCaveat: NRHP_CAVEAT,
  render: { labels: 'none', dropBelowScale: null },
});

export function readerStrings() {
  const p = { name: null, refnum: null, certified: null, city: null, state: null };
  const res = { status: 'ready', places: [p], dropped: 1, capped: true, fetchedMs: 0 };
  return [CREDIT_NRHP, NRHP_LABEL, NRHP_CAVEAT, LINK_TEXT, EMPTY, ...nrhpCardLines(p),
    ...nrhpCardLines({ name: 'N', refnum: '83003042', certified: certDateText('1983-01-'), city: 'C', state: 'S' }),
    nrhpReport(null).text, nrhpReport({ status: 'too-wide' }).text, nrhpReport({ status: 'empty' }).text, nrhpReport(res).text];
}
