// NIFC's current interagency fire perimeters, read for the view on screen. Measured live
// 2026-09-15 (00:33-00:44 UTC): key-free, `access-control-allow-origin: *`, on the origin the
// state parcel layers already opened. Four measurements decide the whole file, and each is the
// difference between an honest layer and a dangerous one.
//
// ONE, GEOMETRY IS THE WHOLE COST. 188 national polygons came to 37,342,814 bytes unsimplified
// -- and the transfer FAILED, curl reporting PROTOCOL_ERROR on a truncated stream. The same
// query with `maxAllowableOffset=0.002` returned all 188 in 755,975 bytes, a 49x reduction with
// no feature lost. No code path here omits the parameter.
//
// TWO, "CURRENT" IS THE SERVICE'S WORD, NOT A PROMISE ABOUT THE POLYGON.
// `poly_PolygonDateTime` is when the boundary was MAPPED: median 21.9 days old, p90 60 days,
// 19 of 188 absent, and ONE dated the year 0926 -- which naive "days since" arithmetic renders
// as 401,770 days. A pre-2000 date is corrupt and is read as unknown.
//
// THREE, NOT EVERY RECORD IS A WILDFIRE. `attr_IncidentTypeCategory` measured WF 182, RX 4
// (PRESCRIBED burns -- deliberate, planned fire) and CX 2 (complexes). Drawing an RX as a
// wildfire is a factual error, so the filter is in the query AND in the reader.
//
// FOUR, CONTAINED IS NOT EXCLUDED. NIFC documents the service as incidents not declared
// contained -- yet 56 of 188 measured 100 per cent and 38 carried null.
// `attr_ContainmentDateTime` was null on ALL 188 and is never read.
import { SOURCES } from './source-registry.js';
import { serviceError, envelope, viewReader } from './arcgis-view.js';

const SRC = SOURCES.nifcFirePerimeters;
export const SERVICE = SRC.serviceUrl;
export const CREDIT = SRC.attribution;
export { serviceError };
export const CATEGORIES = SRC.layers[0].categories;
/** The only category this layer draws. The others are planned fire and groupings of incidents. */
export const WILDFIRE = 'WF';
/** The measured floor, below which the national payload did not transfer at all. */
export const MIN_OFFSET = SRC.limits.requiredMaxAllowableOffsetDegrees;
/** Any polygon date before this is corrupt: the service's own count of them is exactly 1. */
export const EARLIEST_REAL_MS = Date.UTC(2000, 0, 1);
const DAY = 86400000;

/** Simplification tied to what the screen can resolve, never below the measured floor: a continental
 *  view cannot draw a two-metre vertex, and asking for one is how 35.6 MB arrives. */
export function offsetForSpan(spanDegrees, widthPx = 1024) {
  const perPixel = Math.abs(Number(spanDegrees) || 0) / Math.max(1, widthPx);
  return Math.max(MIN_OFFSET, Math.round(perPixel * 1e6) / 1e6);
}

/** The service's own query for one view: bounded, simplified, wildfires only, twelve fields. */
export function fireQueryFor(bbox, widthPx = 1024) {
  return { url: `${SERVICE}/query`,
    params: {
      where: `attr_IncidentTypeCategory='${WILDFIRE}'`,
      geometry: envelope(bbox), geometryType: 'esriGeometryEnvelope', inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', returnGeometry: 'true', outSR: '4326',
      maxAllowableOffset: String(offsetForSpan(bbox.maxLon - bbox.minLon, widthPx)),
      outFields: SRC.layers[0].fields.join(','), f: 'geojson',
    } };
}
export const fireQueryUrl = (bbox, widthPx) => {
  const q = fireQueryFor(bbox, widthPx);
  return `${q.url}?${new URLSearchParams(q.params)}`;
};

/** When the boundary was mapped, or null. Epoch milliseconds; a value before 2000 is the corrupt
 *  record the service itself confirms rather than a 401,770-day-old fire. */
export function mappedMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < EARLIEST_REAL_MS) return null;
  return ms;
}

/** The perimeters a response holds, wildfires only. An error envelope holds none. */
export function readPerimeters(body, nowMs = Date.now()) {
  if (serviceError(body)) return [];
  const out = [];
  for (const f of Array.isArray(body && body.features) ? body.features : []) {
    const p = (f && (f.properties || f.attributes)) || {};
    if (p.attr_IncidentTypeCategory !== WILDFIRE) continue;
    const ms = mappedMs(p.poly_PolygonDateTime);
    out.push({
      name: p.poly_IncidentName || 'Unnamed incident',
      acres: Number.isFinite(Number(p.poly_GISAcres)) ? Number(p.poly_GISAcres) : null,
      mappedMs: ms,
      ageDays: ms === null ? null : Math.max(0, Math.round((nowMs - ms) / DAY)),
      contained: Number.isFinite(Number(p.attr_PercentContained)) && p.attr_PercentContained !== null
        ? Number(p.attr_PercentContained) : null,
      mapMethod: p.poly_MapMethod || null,
      state: p.attr_POOState || null,
      geometry: f.geometry || null,
    });
  }
  return out;
}

/** How old the DRAWN SHAPE is. Per feature, not per layer: the median measured three weeks and the
 *  p90 two months, so one "as of" over the lot would be wrong for most of them. */
export function ageText(row, nowMs = Date.now()) {
  if (!row || row.mappedMs === null) {
    return `${row ? row.name : 'This perimeter'}: when this boundary was mapped is not stated, `
      + 'so how old the shape is cannot be said.';
  }
  const days = row.ageDays ?? Math.max(0, Math.round((nowMs - row.mappedMs) / DAY));
  const when = days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`;
  return `${row.name}: boundary mapped ${when}.`;
}

/** Containment as NIFC published it. `null` is its own state -- not reported -- and reading it as
 *  zero would invent a number for 38 of every 188 records. */
export function containmentText(percent) {
  if (percent === null || percent === undefined || !Number.isFinite(Number(percent))) {
    return 'Containment not reported for this incident.';
  }
  const n = Number(percent);
  return n >= 100
    ? 'Reported 100% contained — contained incidents stay in this layer, so a perimeter here is '
      + 'not proof of active fire.'
    : `Reported ${n}% contained.`;
}

/** The view's headline: how many perimeters, and how old the oldest drawn shape is. */
export function summarise(rows) {
  if (!rows || !rows.length) return { known: false, count: 0, oldestAgeDays: null, observedMs: null };
  const dated = rows.filter((r) => r.mappedMs !== null);
  return { known: true, count: rows.length,
    oldestAgeDays: dated.length ? Math.max(...dated.map((r) => r.ageDays)) : null,
    observedMs: dated.length ? Math.max(...dated.map((r) => r.mappedMs)) : null };
}

export function quietText() {
  return 'No mapped fire perimeter reaches this view. The layer is the interagency record of '
    + 'incidents large enough to have had a boundary mapped, so nothing drawn here is not a '
    + 'statement that no fire is burning.';
}

export const FAILED_TEXT = 'The fire perimeter service could not be read for this view.';

/** The layer row for one view. The AGE leads: a perimeter stated bare reads as the edge of a
 *  fire right now, and the median measured three weeks old. */
export function areaReport(body, nowMs = Date.now()) {
  if (serviceError(body)) return { known: false, count: 0, text: FAILED_TEXT };
  const rows = readPerimeters(body, nowMs);
  const at = summarise(rows);
  if (!at.known) return { known: false, count: 0, text: quietText() };
  const lead = at.oldestAgeDays === null
    ? 'None of these boundaries states when it was mapped.'
    : `${at.count} mapped perimeter${at.count === 1 ? '' : 's'} in view; the oldest boundary was `
      + `mapped ${at.oldestAgeDays} day${at.oldestAgeDays === 1 ? '' : 's'} ago.`;
  const named = rows.slice(0, 3).map((r) => `${ageText(r, nowMs)} ${containmentText(r.contained)}`);
  return { known: true, count: at.count, text: [lead, ...named].join(' ') };
}

/** Every string this source can put in front of a reader, in one place, for the test. */
export function readerStrings(body, nowMs = Date.now()) {
  const rows = readPerimeters(body, nowMs);
  return [CREDIT, LAYER_LABEL, LAYER_CAVEAT, FAILED_TEXT, quietText(),
    containmentText(null), containmentText(0), containmentText(100),
    ageText(rows[0] || null, nowMs), areaReport(body, nowMs).text];
}

export const LAYER_LABEL = 'Mapped wildfire perimeters (interagency record)';
export const LAYER_CAVEAT = 'The interagency RECORD of an incident, not a live fire edge: each '
  + 'boundary was mapped at some earlier moment — the median measured three weeks old — so the '
  + 'row states the age of every shape it draws rather than one "as of" for the layer. '
  + 'Prescribed burns and complexes are filtered out, because planned fire is not wildfire, and '
  + 'incidents reported 100% contained remain in the service, so a perimeter is not proof of '
  + 'active fire. NIFC states these data are dynamic and are not legal documents; nothing here '
  + 'is a closure, an evacuation order or a statement about any road. Screen only.';

/** A Leaflet group holding the perimeters. One ink and an outline that carries: an age badge is in
 *  the row, not in a colour ramp this app would have to invent. */
export function fireLayer(L) {
  const group = L.layerGroup();
  group.draw = function draw(rows) {
    group.clearLayers();
    for (const row of rows || []) {
      if (!row.geometry) continue;
      L.geoJSON({ type: 'Feature', geometry: row.geometry, properties: {} }, {
        style: { color: '#b4462e', weight: 1.5, fillColor: '#b4462e', fillOpacity: 0.18,
          interactive: false },
      }).addTo(group);
    }
    return group;
  };
  return group;
}

/** Asked for only when a reader asks, and never throws the map. */
export async function fetchFire(bbox, { fetchImpl = fetch, signal, widthPx } = {}) {
  try {
    const res = await fetchImpl(fireQueryUrl(bbox, widthPx), { signal });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

/** One bbox question at a time, waiting out a drag — the same protocol as the other bounded surfaces,
 *  so a pan is a new question and the answer about the view you left is dropped. */
export function fireReader({ fetchImpl = fetch, widthPx, ...rest } = {}) {
  return viewReader({ ...rest, fetchOne: (bbox, { signal }) => fetchFire(bbox, { fetchImpl, signal, widthPx }) });
}
