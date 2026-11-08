// FEMA's National Flood Hazard Layer, read for the view on screen.
//
// Measured live 2026-09-15 against `hazards.fema.gov/arcgis/rest/services/public/NFHL`; the
// registry entry holds the numbers and why each one is there. What this file holds is the
// reading, and three rules it exists to enforce.
//
// TENSE. Every other context surface on this page is about a moment. This one is not about a
// moment at all: it is an engineering study's modelled floodplain, adopted as regulation for
// insurance and floodplain management. "There is water here" is not a sentence it can make,
// and neither is "there is not". So no string below is in the present tense about the ground,
// and the page offers it no observation time -- the vintage is per PANEL, and one screen held
// panels effective 2012-11-02 and 2016-12-08.
//
// SENTINELS. 154 of the 159 zones measured carry `STATIC_BFE: -9999`, all 159 carry
// `DEPTH: -9999`, and all 14 panels carry `PRE_DATE: 9999-09-09`. Every one of those is the
// service saying nothing. They are turned into null HERE, once, so no later caller has to
// remember -- and the tests scan every reader-facing string for them.
//
// A 200 THAT IS A FAILURE. Asking layer 28 for geometry without `maxAllowableOffset` answered
// HTTP 200 with an 80-byte `{"error":{"code":500,...}}` body. `res.ok` is true on that, and
// `features` is simply absent, so an adapter that trusts `res.ok` reports a flood plain as
// empty ground. Every body goes through readError first.
import { SOURCES } from './source-registry.js';
import { fetchWithDeadline } from './request.js';

const SRC = SOURCES.femaNfhl;
const LAYER = (id) => SRC.layers.find((l) => l.id === id);
export const SERVICE = SRC.serviceUrl;
export const CREDIT = SRC.attribution;
/** FLD_ZONE -> what FEMA publishes that letter to mean. The SET is read off the service; the
 *  prose is ours, because every field of layer 28 answers `domain: None` and there is no
 *  coded-value label to quote. */
export const ZONE_MEANING = LAYER(28).zones;
export const MAX_FEATURES_DRAWN = SRC.limits.maxFeaturesDrawn;
export const GENERALIZE_DEGREES = SRC.limits.maxAllowableOffset;
export const NO_VALUE = SRC.limits.noValue;
export const NULL_DATE_MS = SRC.limits.nullDateMs;
const ZONE_FIELDS = LAYER(28).fields.join(',');
const PANEL_FIELDS = LAYER(3).fields.join(',');

/** The envelope every query is asked over. `inSR` AND `outSR`, always: the service's own
 *  spatial reference is NAD83 geographic (wkid 4269), so a request that does not name 4326
 *  is read in a different system and answered about slightly different ground. */
const envelope = ({ minLon, minLat, maxLon, maxLat }) => ({
  geometry: `${minLon},${minLat},${maxLon},${maxLat}`,
  geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326',
  spatialRel: 'esriSpatialRelIntersects', where: '1=1', f: 'json',
});

/** Is there a flood map here AT ALL. Layer 0 is the only layer that can answer it, and at
 *  174-247 bytes it is asked unconditionally: zero features on layer 28 means "no study was
 *  ever published" in interior Alaska and "nothing intersects this rectangle" elsewhere. */
export function coverageQueryFor(bbox) {
  return { url: `${SERVICE}/0/query`, params: { ...envelope(bbox), outFields: 'STUDY_ID', returnGeometry: 'false' } };
}

/** How many zones intersect, before asking for any of them. 13 bytes, and it is what stops
 *  a mid-zoom pan asking for 29,016 polygons in fifteen pages. */
export function countQueryFor(bbox) {
  return { url: `${SERVICE}/28/query`, params: { ...envelope(bbox), returnCountOnly: 'true' } };
}

/** The zones themselves. `maxAllowableOffset` is IN the template rather than an argument:
 *  the same 159 features answered 200-with-a-500-inside without it and 399,069 bytes with
 *  it, and a bound a caller can forget is not a bound. */
export function zonesQueryFor(bbox) {
  return { url: `${SERVICE}/28/query`,
    params: { ...envelope(bbox), outFields: ZONE_FIELDS, returnGeometry: 'true',
      maxAllowableOffset: String(GENERALIZE_DEGREES), resultRecordCount: String(MAX_FEATURES_DRAWN) } };
}

/** The vintage, which is not on the zone record: layer 28 has no date field among its 24
 *  fields. An effective date is a join to the FIRM panel underneath, one panel at a time. */
export function panelsQueryFor(bbox) {
  return { url: `${SERVICE}/3/query`, params: { ...envelope(bbox), outFields: PANEL_FIELDS, returnGeometry: 'false' } };
}

export const queryUrl = (req) => `${req.url}?${new URLSearchParams(req.params)}`;

/** The ArcGIS error envelope that arrives with a 200 status. Returns the message, or null
 *  when the body is a real answer. Nothing else in this file reads a body without it. */
export function readError(body) {
  const e = body && body.error;
  return e && (e.message || e.code) ? String(e.message || `ArcGIS error ${e.code}`) : null;
}

const features = (body) => (!readError(body) && Array.isArray(body && body.features) ? body.features : []);
/** -9999 in a number field is the service declining to state one. So is a non-finite value. */
const number = (v) => (Number.isFinite(Number(v)) && Number(v) !== NO_VALUE ? Number(v) : null);
/** ZONE_SUBTY arrives empty in three spellings nationally: null, a single space, and the
 *  literal string '<Null>'. All three mean the record has no subtype. */
const text = (v) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && s !== '<Null>' ? s : null;
};
/** Epoch MILLISECONDS, UTC (the service declares datesInUnknownTimezone: false). FEMA's
 *  null date is 9999-09-09; anything at or past it is the sentinel, not a date. */
const day = (ms) => {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 && n < NULL_DATE_MS ? n : null;
};
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Whether FEMA publishes a flood map over this view, and which studies it belongs to. An
 *  error body is NOT coverage: it is reported as a failure by the caller, never as absence. */
export function readCoverage(body) {
  const studies = [...new Set(features(body).map((f) => text(f.attributes && f.attributes.STUDY_ID)).filter(Boolean))].sort();
  return { mapped: studies.length > 0, studies };
}

/** The count, or null when the service would not give one. Null is not zero: zero is an
 *  answer about the ground and null is an answer about the service. */
export function readCount(body) {
  if (!body || readError(body)) return null;
  return Number.isFinite(Number(body.count)) ? Number(body.count) : null;
}

/** One row per zone polygon, with every sentinel already gone. `rings` is Leaflet's
 *  [lat, lon] order, converted here, because the service answers in [lon, lat]. */
export function readZones(body) {
  return features(body).map((f) => {
    const a = f.attributes || {};
    const rings = Array.isArray(f.geometry && f.geometry.rings)
      ? f.geometry.rings.map((ring) => ring.map(([x, y]) => [y, x])) : null;
    return {
      zone: text(a.FLD_ZONE) || 'D',
      subtype: text(a.ZONE_SUBTY),
      // 'T' / 'F' as STRINGS. Read as truthiness, 'F' is true and every X becomes high risk.
      sfha: text(a.SFHA_TF) === 'T',
      bfe: number(a.STATIC_BFE),
      bfeDatum: text(a.V_DATUM),
      depth: number(a.DEPTH),
      lengthUnit: text(a.LEN_UNIT),
      dfirmId: text(a.DFIRM_ID),
      rings,
    };
  });
}

/** One row per FIRM panel. `effectiveMs` is when the MAP became effective -- not when water
 *  was anywhere -- and `preEffectiveMs` is null on every panel measured, because FEMA fills
 *  the column with 9999-09-09 rather than leaving it empty. */
export function readPanels(body) {
  return features(body).map((f) => {
    const a = f.attributes || {};
    return { dfirmId: text(a.DFIRM_ID), panel: text(a.FIRM_PAN), panelType: text(a.PANEL_TYP),
      effectiveMs: day(a.EFF_DATE), preEffectiveMs: day(a.PRE_DATE), scale: text(a.SCALE) };
  });
}

/** One polygon in words. The base flood elevation is printed ONLY with the datum and unit
 *  the same record states -- unlike a gage stage, this elevation is self-describing, and a
 *  number without its datum is not an elevation anyone can stand next to. */
export function zoneText(row) {
  const name = row.subtype ? `Zone ${row.zone}, ${row.subtype}` : `Zone ${row.zone}`;
  const parts = [`${name} — ${ZONE_MEANING[row.zone] || ZONE_MEANING.D}`];
  parts.push(row.sfha
    ? 'FEMA designates this a Special Flood Hazard Area.'
    : 'FEMA does not designate this a Special Flood Hazard Area.');
  if (row.bfe !== null && row.bfeDatum && row.lengthUnit) {
    parts.push(`Base flood elevation ${row.bfe} ${row.lengthUnit.toLowerCase()} above ${row.bfeDatum}.`);
  }
  if (row.depth !== null && row.lengthUnit) parts.push(`Modelled depth ${row.depth} ${row.lengthUnit.toLowerCase()}.`);
  return parts.join(' ');
}

/** The vintage line. A RANGE where a view holds panels of different ages, because one
 *  effective date for a screen would be false: this envelope carried 2012 and 2016 panels. */
export function vintageText(panels = []) {
  const days = [...new Set(panels.map((p) => p.effectiveMs).filter(Boolean))].sort((a, b) => a - b);
  if (!days.length) return 'The service did not return a FIRM panel for this view, so the effective date of these zones is unknown.';
  if (days.length === 1) return `These panels became effective ${iso(days[0])}.`;
  return `Effective dates run per panel from ${iso(days[0])} to ${iso(days[days.length - 1])} — `
    + 'a single view holds panels adopted years apart, so no one date covers this screen.';
}

/** Ground FEMA has not mapped. Said as what it is -- nobody studied it -- because the one
 *  reading it must never get is that the study was done and came back clear. */
export function quietText() {
  return 'FEMA has published no flood map over this view. That is ground no flood study has covered, '
    + 'which is not a finding of low risk.';
}

/** What the layer's row says for one view. Four answers, and they are different answers:
 *  the service failed, FEMA mapped nothing here, the view holds more zones than can be drawn,
 *  or here is the census with the panels' own dates in front of it. */
export function areaReport({ coverage = null, count = null, zones = null, panels = null } = {}) {
  const failure = readError(count) || readError(coverage) || readError(zones);
  const n = readCount(count);
  if (failure || n === null) {
    return { known: false, mapped: null, drawable: false, count: null,
      text: 'The flood map service did not answer for this view, so nothing is drawn. '
        + 'That is the service, and says nothing about the ground.' };
  }
  const { mapped } = readCoverage(coverage);
  if (!mapped) return { known: true, mapped: false, drawable: false, count: n, text: quietText() };
  if (n > MAX_FEATURES_DRAWN) {
    return { known: true, mapped: true, drawable: false, count: n,
      text: `${n.toLocaleString('en-US')} flood-zone polygons reach this view, more than this map draws at once. `
        + `Zoom in until fewer than ${MAX_FEATURES_DRAWN.toLocaleString('en-US')} are in sight.` };
  }
  const rows = readZones(zones);
  const sfha = rows.filter((r) => r.sfha).length;
  const census = rows.length
    ? `${n.toLocaleString('en-US')} flood-zone polygons cover this view, ${sfha} of them inside a Special Flood Hazard Area.`
    : `${n.toLocaleString('en-US')} flood-zone polygons cover this view.`;
  return { known: true, mapped: true, drawable: true, count: n,
    text: `${vintageText(readPanels(panels))} ${census} These boundaries are a study's model adopted `
      + 'as regulation, not a record of where water has been.' };
}

/** The layer's own words. The label names the MAP rather than the hazard, because "flood
 *  zones" alone reads as a picture of where floods happen and this is a picture of where a
 *  study drew a line. */
export const LAYER_LABEL = 'FEMA flood hazard map (regulatory floodplain)';
export const LAYER_CAVEAT = 'The floodplain an engineering study modelled and FEMA adopted for '
  + 'insurance and floodplain management — never a picture of where water has been or will be, and '
  + 'never comparable with a weather alert. Its age belongs to the PANEL rather than the screen: one '
  + 'view measured panels adopted four years apart, so the row gives the range rather than one date. '
  + 'Zone X is not one thing and the subtype says which: the 0.2%-annual-chance area, minimal hazard '
  + 'and areas behind a levee all arrive as X. Where FEMA has published no study, nothing is drawn — '
  + 'which is ground nobody assessed, not ground found to be low risk.';

/** Every string this source can put in front of a reader, in one place, for the test. */
export function readerStrings({ coverage = null, count = null, zones = null, panels = null } = {}) {
  const parts = readPanels(panels);
  return [CREDIT, LAYER_LABEL, LAYER_CAVEAT, quietText(), vintageText(parts), vintageText([]),
    areaReport({ coverage, count, zones, panels }).text,
    areaReport({ coverage, count: { count: 29016 } }).text,
    areaReport({ coverage: { features: [] }, count: { count: 0 } }).text,
    areaReport({ coverage, count: { error: { code: 500, message: 'Error performing query operation' } } }).text,
    ...readZones(zones).slice(0, 4).map(zoneText)];
}

/** A Leaflet group of the drawn zones. Two inks and no more: inside the Special Flood Hazard
 *  Area, and outside it. A colour per zone letter would be a palette this app invented --
 *  the service publishes no renderer for these polygons that a key could honestly quote. */
export function floodZonesLayer(L) {
  const group = L.layerGroup();
  group.draw = function draw(rows = []) {
    group.clearLayers();
    for (const row of rows) {
      if (!row.rings || !row.rings.length) continue;
      L.polygon(row.rings, {
        color: row.sfha ? '#2563eb' : '#64748b', weight: 1,
        fillColor: row.sfha ? '#2563eb' : '#94a3b8',
        fillOpacity: row.sfha ? 0.28 : 0.1, interactive: true,
      }).bindTooltip(zoneText(row)).addTo(group);
    }
    return group;
  };
  return group;
}

const getJson = async (req, fetchImpl, signal) => {
  const got = await fetchWithDeadline(queryUrl(req), { fetchImpl, signal, timeoutMs: SRC.timeoutMs });
  return got.ok ? got.body : null;
};

/** One view's worth of questions, in the order that makes the expensive one conditional:
 *  coverage and count first (247 and 13 bytes), and the zones and their panels only when
 *  the count is under the ceiling. Above it nothing further is asked at all — the refusal
 *  is the answer, and paging fifteen times for a picture nobody can read is not. */
export async function fetchFloodView(bbox, { fetchImpl = fetch, signal } = {}) {
  const [coverage, count] = await Promise.all([
    getJson(coverageQueryFor(bbox), fetchImpl, signal),
    getJson(countQueryFor(bbox), fetchImpl, signal),
  ]);
  const n = readCount(count);
  if (!readCoverage(coverage).mapped || n === null || n > MAX_FEATURES_DRAWN) return { coverage, count };
  const [zones, panels] = await Promise.all([
    getJson(zonesQueryFor(bbox), fetchImpl, signal),
    getJson(panelsQueryFor(bbox), fetchImpl, signal),
  ]);
  return { coverage, count, zones, panels };
}

/** The same bounded-reader shape the air-quality surface uses, and for the same reason: a
 *  pan is a NEW question here, not a re-index of something held, so the ask waits out a drag
 *  and the answer about the view the reader left is abandoned rather than drawn. */
export function floodReader({ fetchImpl = fetch, waitMs = 500,
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
          const got = await fetchFloodView(bbox, { fetchImpl, signal: ctl.signal });
          if (live !== ctl) return;   // a newer ask took over and already resolved this one
          live = null; drop = null;
          deliver(got);
          resolve(true);
        }, waitMs);
      });
    },
  };
}
