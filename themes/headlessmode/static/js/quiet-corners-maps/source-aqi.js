// EPA AirNow's hourly air quality contours, read for one drawn area.
//
// Measured live 2026-09-12: `?f=json` answered 200 with `access-control-allow-origin: *` and
// no key; a western-US `/query` returned 58 records with no `exceededTransferLimit`; the whole
// country returned 115, ALL sharing one Unixtime -- 11:00Z, read at 13:24Z.
//
// THE CONSTRAINT. A record carries OBJECTID, Id, gridcode, Unixtime, Timestamp, Shape__Area,
// Shape__Length -- the whole list. No pollutant field and no index value exist anywhere in the
// layer, and `gridcode` is the AQI CATEGORY 1..6, named by the service's own renderer labels.
// So "the category over this area, as of this hour" is all that can be said; naming a
// pollutant, or standing a number where the index would go, invents a reading out of a field
// that is not there. Every reader-facing string is built here so aqi.test.mjs can scan the lot.
//
// AGE, the way the radar layer does it: an OBSERVATION of a past hour, carrying that hour from
// the record's own Timestamp. NOT a forecast -- the FeatureServer root calls itself "AirNow
// National AQI Forecast Updated Nightly", boilerplate from another service, and matching it
// would be the aurora layer's mistake run backwards.
import { SOURCES } from './source-registry.js';

const SRC = SOURCES.epaAirNowAqi;
export const SERVICE = SRC.serviceUrl;
export const CREDIT = SRC.attribution;
/** gridcode -> the service renderer's own label. Not a scale this app invented. */
export const CATEGORY_BY_GRIDCODE = SRC.layers[0].categories;
/** The layer publishes hourly and ran 144 minutes behind the wall clock when measured, so
 *  radar's twenty-minute floor would mark every frame stale. */
export const STALE_AFTER_MINUTES = 240;

/** The service's own query for one area. Pure, so the request can be asserted without a
 *  network call. The bbox goes out in lon/lat and the service reprojects; geometry is left
 *  behind because nothing here draws a polygon yet. */
export function aqiQueryFor({ minLon, minLat, maxLon, maxLat }) {
  return { url: `${SERVICE}/query`,
    params: {
      geometry: `${minLon},${minLat},${maxLon},${maxLat}`,
      geometryType: 'esriGeometryEnvelope', inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', returnGeometry: 'false',
      outFields: 'OBJECTID,Id,gridcode,Unixtime,Timestamp', f: 'json',
    } };
}

export const aqiQueryUrl = (bbox) => {
  const req = bbox && bbox.url ? bbox : aqiQueryFor(bbox);
  return `${req.url}?${new URLSearchParams(req.params)}`;
};

/** The records a response holds, reduced to the two fields that say anything. A body that
 *  is not a feature response -- an ArcGIS `error` envelope included -- is nothing to report
 *  rather than a throw. `Timestamp` is MILLISECONDS, `Unixtime` SECONDS; the wrong one
 *  puts the hour in 1970. */
export function readFeatures(body) {
  const out = [];
  for (const f of Array.isArray(body && body.features) ? body.features : []) {
    const a = (f && f.attributes) || {};
    const gridcode = Number(a.gridcode);
    if (!Number.isInteger(gridcode) || !(gridcode in CATEGORY_BY_GRIDCODE)) continue;
    const ms = Number.isFinite(Number(a.Timestamp)) ? Number(a.Timestamp) : Number(a.Unixtime) * 1000;
    if (!Number.isFinite(ms) || ms <= 0) continue;
    out.push({ id: a.OBJECTID, gridcode, category: CATEGORY_BY_GRIDCODE[gridcode], observedMs: ms });
  }
  return out;
}

/** The WORST category over the area, and the hour it belongs to. Worst rather than averaged:
 *  an averaged category would be a value the service never published. */
export function summarise(rows) {
  if (!rows.length) return { known: false, count: 0, worst: null, category: null, observedMs: null };
  const worst = rows.reduce((m, r) => Math.max(m, r.gridcode), 0);
  return { known: true, count: rows.length, worst, category: CATEGORY_BY_GRIDCODE[worst],
    observedMs: rows.reduce((m, r) => Math.max(m, r.observedMs), 0) };
}

/** How old the reading is, in the words a reader gets, from the record's own Timestamp. A
 *  record that will not state one has an unknown age, which is said rather than assumed
 *  current -- the radar layer's rule, for the same reason. */
export function frameVintage(observedMs, nowMs = Date.now()) {
  const ms = Number(observedMs);
  if (!Number.isFinite(ms) || ms <= 0) {
    return { known: false, stale: true, minutes: null,
      text: 'The air quality service did not say which hour this covers, so its age is unknown.' };
  }
  const minutes = Math.max(0, Math.round((nowMs - ms) / 60000));
  const at = new Date(ms).toISOString().slice(11, 16);
  const age = minutes === 0 ? 'just now' : minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const stale = minutes > STALE_AFTER_MINUTES;
  return { known: true, stale, minutes,
    text: stale
      ? `This covers the hour from ${at} UTC, ${age} — too old to act on. Reopen the layer for `
        + 'the hour EPA has published since.'
      : `Air quality for the hour from ${at} UTC, ${age}.` };
}

/** The one place a category is put into words. No digit reaches it at all: a number here
 *  would read as the index value, and the layer holds no index value to read. */
export function categoryText(summary) {
  if (!summary || !summary.known) return quietText();
  return `Worst category over this area: ${summary.category}. That is the category EPA `
    + 'published for the area, not a measurement taken in it.';
}

/** Nothing covering the area is a result, not an error, so it gets its own sentence. */
export function quietText() {
  return 'No air quality contour covers this area. The surface is published for the United '
    + 'States only, and an uncovered area is the service not saying rather than clean air.';
}

/** Asked for only when a reader asks, and never throws the map. */
export async function fetchAqi(bbox, { fetchImpl = fetch, signal } = {}) {
  try {
    const res = await fetchImpl(aqiQueryUrl(bbox), { signal });
    return res.ok ? await res.json() : null;
  } catch (e) { return null; }
}

/** Every string this source can put in front of a reader, in one place, for the test. */
export function readerStrings(body, at = summarise(readFeatures(body))) {
  return [CREDIT, LAYER_LABEL, LAYER_CAVEAT, quietText(), categoryText(at), frameVintage(null).text,
    frameVintage(at.observedMs, (at.observedMs || 0) + 60000).text,
    frameVintage(at.observedMs, (at.observedMs || 0) + 400 * 60000).text,
    areaReport(body).text, areaReport(null).text];
}

/** The layer own words. The label carries the hour rather than the category, because the
 *  label is the one string a reader is guaranteed to see and the hour is the thing this
 *  surface hides: latest ran 144 minutes behind the wall clock when measured. */
export const LAYER_LABEL = 'Air quality category (the latest hour EPA published)';
export const LAYER_CAVEAT = 'The category EPA published for one past hour, shaded over the area '
  + 'you are looking at rather than drawn contour by contour: the query leaves the outlines '
  + 'behind, so the box says what the worst category in view was, not where the air changes. The '
  + 'surface is interpolated between monitors, so ground with no monitor near it still takes a '
  + 'colour from what was measured elsewhere, and EPA states the hourly data are not fully '
  + 'verified and validated. United States only, and the latest hour can run hours behind the '
  + 'clock, so the row says which hour it covers and how old that is.';

/** A Leaflet group holding ONE box: the area that was asked about, shaded by the worst
 *  category in it. Not a box per contour -- the query leaves geometry behind, and drawing
 *  outlines nobody fetched would be inventing where the air changes. One ink, opacity
 *  carrying the category, because a colour per category would be a palette this app made
 *  up: the renderer own colours were not captured at the probe, only its six names. */
export function aqiLayer(L) {
  const group = L.layerGroup();
  group.draw = function draw(rows, bbox) {
    group.clearLayers();
    const at = summarise(rows || []);
    if (!at.known || !bbox) return group;
    L.rectangle([[bbox.minLat, bbox.minLon], [bbox.maxLat, bbox.maxLon]], {
      color: '#b08a3e', weight: 1, fillColor: '#b08a3e',
      fillOpacity: 0.06 + 0.06 * (at.worst - 1), interactive: false,
    }).addTo(group);
    return group;
  };
  return group;
}

/** What the layer row says for one drawn area: the HOUR first, then the category. A
 *  category stated bare reads as the air outside the window, and this surface is hours
 *  old. Nothing over the area states no category, so it needs no hour. */
export function areaReport(body, nowMs = Date.now()) {
  const at = summarise(readFeatures(body));
  if (!at.known) return { known: false, worst: null, stale: false, text: quietText() };
  const vintage = frameVintage(at.observedMs, nowMs);
  // A page the service capped is not the whole area, so the worst it holds is a floor.
  const capped = body && body.exceededTransferLimit
    ? ' The service capped this answer, so a worse category may cover part of this area.' : '';
  return { known: true, worst: at.worst, stale: vintage.stale,
    text: `${vintage.text} ${categoryText(at)}${capped}` };
}

/** One bbox query at a time, and only for the view the reader stopped on. Unlike the
 *  aurora grid -- one global file held after a single fetch -- this is a bounded query, so
 *  a pan is a NEW question and asking again is correct. What is not correct is asking per
 *  frame of a drag, so the ask waits, and an answer about the view you left is abandoned
 *  rather than written into the row. `ask` resolves false when it was dropped. */
export function aqiReader({ fetchImpl = fetch, waitMs = 400,
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
          const got = await fetchAqi(bbox, { fetchImpl, signal: ctl.signal });
          if (live !== ctl) return;   // a newer ask took over and already resolved this one
          live = null; drop = null;
          deliver(got);
          resolve(true);
        }, waitMs);
      });
    },
  };
}
