// The USFWS National Wetlands Inventory, read for one drawn area.
//
// THE BINDING CONSTRAINT IS REQUEST TIME, NOT RECORD COUNT. Measured 2026-09-15:
// merely SENDING resultOffset/resultRecordCount re-costs a query 20x, even at
// offset 0 -- a Louisiana 1-degree extent took 8.71 s unpaged and 176.74 s with
// paging params, against this source's `timeoutMs` of 20,000. Thirty pages of that
// is ninety minutes for one degree square. So this layer asks for a COUNT first and
// REFUSES above `recordBudgetPerExtent`, and that refusal is the layer rather than a
// polish item: it is the only thing keeping the requests inside their own deadline.
// Adding `orderByFields` made it worse still -- that variant never returned inside a
// 180 s cutoff -- and paging is stable without one (overlap 0, union exactly 1,759),
// so no query here sorts.
//
// PAYLOAD IS DRIVEN BY VERTEX COUNT. A DRY Nevada box with 17 features returned
// 2,256,343 bytes, because NWI riverine polygons run for miles and come back whole
// when they merely intersect the box; one feature averaged 3,250 vertices.
// `maxAllowableOffset` is therefore mandatory, not an optimisation (8-15x).
//
// THE CLIENT IS THE ONLY BOUND. `geometry=garbage` answered HTTP 200 with a full
// page and 10,101,505 bytes -- a malformed geometry is SILENTLY IGNORED, not
// rejected. envelopeFor() is what refuses it, here, before anything is sent.
//
// EMPTY IS NOT UNASSESSED, and the wetlands layer cannot tell them apart: Phoenix
// (surveyed, none here), the Brooks Range (never surveyed) and Null Island (off the
// service entirely) all return zero features. The Wetlands_Status layer -- two
// records nationally -- is what separates them, and asking it is what makes an
// empty answer honest. All 105 No_Data parts are Alaska and the Pacific territories.
import { SOURCES } from './source-registry.js';
import { pageThrough } from './arcgis-pager.js';
import { fetchWithDeadline } from './request.js';
import { WETLAND_SEMANTICS } from './legend.js';

const SRC = SOURCES.fwsNwiWetlands;
export const LAYER_ID = 'wetlands';
export const SYMBOL_WETLAND = 'wetland-nwi';
export const WETLANDS_URL = SRC.layers[0].queryUrl;
export const STATUS_URL = SRC.layers[1].queryUrl;
export const VINTAGE_URL = SRC.layers[2].queryUrl;
export const OUT_FIELDS = SRC.layers[0].fields;
export const RECORD_BUDGET = SRC.limits.recordBudgetPerExtent;
export const GENERALISE_DEGREES = SRC.limits.maxAllowableOffsetDegrees;
export const PAGE_SIZE = SRC.limits.maxRecordCount;
// One page past the budget, because returnCountOnly is a LOWER bound: a box counted
// at 3,999 can hand back more rows than that and calling the result partial would be
// a second false answer. Never enough pages for the refused extents.
const MAX_PAGES = Math.ceil(RECORD_BUDGET / PAGE_SIZE) + 1;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const commas = (n) => n.toLocaleString('en-US');

/** The bbox as an ArcGIS envelope string, or a RangeError.
 *
 *  This is the whole server-side bound: a malformed `geometry` is not refused, it is
 *  IGNORED, and the service then answers with a full unbounded page. So a box that
 *  is not four finite, ordered, in-range degrees never becomes a request. */
export function envelopeFor(bbox) {
  const b = bbox || {};
  const [minLon, minLat, maxLon, maxLat] = ['minLon', 'minLat', 'maxLon', 'maxLat'].map((k) => num(b[k]));
  if ([minLon, minLat, maxLon, maxLat].some((v) => v === null)) {
    throw new RangeError('wetlands: an extent must be four finite lon/lat degrees');
  }
  if (minLon >= maxLon || minLat >= maxLat) throw new RangeError('wetlands: extent is empty or inverted');
  if (Math.abs(minLon) > 180 || Math.abs(maxLon) > 180 || Math.abs(minLat) > 90 || Math.abs(maxLat) > 90) {
    throw new RangeError('wetlands: extent is off the Earth');
  }
  return `${minLon},${minLat},${maxLon},${maxLat}`;
}

const extentParams = (bbox) => ({
  geometry: envelopeFor(bbox), geometryType: 'esriGeometryEnvelope',
  inSR: '4326', spatialRel: 'esriSpatialRelIntersects', where: '1=1',
});

/** The gate. 13-15 bytes and 0.24-0.87 s, and the cheapest question this service answers. */
export function countQuery(bbox) {
  return { url: WETLANDS_URL, params: { ...extentParams(bbox), returnCountOnly: 'true', returnGeometry: 'false', f: 'json' } };
}

/** The real query, generalised. `outSR=4326` twice over: maxAllowableOffset is in the
 *  units of outSR (0.0001 deg is about 11 m), and overlay-paths wants lon/lat rings. */
export function featureQuery(bbox) {
  return { url: WETLANDS_URL,
    params: { ...extentParams(bbox), outFields: OUT_FIELDS.join(','), returnGeometry: 'true',
      outSR: '4326', maxAllowableOffset: String(GENERALISE_DEGREES), f: 'json' } };
}

const pointParams = (lon, lat, fields) => ({
  geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326',
  spatialRel: 'esriSpatialRelIntersects', outFields: fields.join(','),
  returnGeometry: 'false', f: 'json',
});

/** Was this ground ever surveyed? 200 bytes, 0.28 s, and the only question that can answer it. */
export const statusQuery = (lon, lat) => ({ url: STATUS_URL, params: pointParams(lon, lat, SRC.layers[1].fields) });
/** How old is the imagery the wetlands here were drawn from? 1,902 bytes, 0.23 s. */
export const vintageQuery = (lon, lat) => ({ url: VINTAGE_URL, params: pointParams(lon, lat, SRC.layers[2].fields) });

/** The count, as the LOWER BOUND it is. Layer 0 is a join: 583 features arrived under
 *  582 distinct OBJECTIDs while returnCountOnly said 582. Exposing it as `count` is how
 *  a paging loop comes to derive page counts from it and stop a row early. */
export function readCount(body) {
  const n = body && typeof body === 'object' && !body.error ? num(body.count) : null;
  return n === null || n < 0 ? { known: false, atLeast: null } : { known: true, atLeast: n };
}

/** Refuse, or go. An unknown count is a refusal: not knowing how big an extent is has
 *  never been permission to fetch all of it. */
export function budgetVerdict(atLeast) {
  const n = typeof atLeast === 'object' && atLeast !== null ? atLeast.atLeast : atLeast;
  if (num(n) === null) {
    return { ok: false, atLeast: null,
      text: 'The wetlands service would not say how much it holds for this area, so it was not '
        + 'asked for it. Draw a smaller area and switch the layer on again.' };
  }
  if (n > RECORD_BUDGET) {
    return { ok: false, atLeast: n,
      text: `This area holds at least ${commas(n)} mapped wetlands, past the ${commas(RECORD_BUDGET)} `
        + 'this map will fetch in one go. Asking for them would take minutes and time out rather '
        + 'than fail, so nothing was fetched. Draw a smaller area.' };
  }
  return { ok: true, atLeast: n, text: null };
}

/** 'Digital' | 'No_Data' | 'off-service' | 'unknown'.
 *
 *  Zero features is a THIRD state and not a missing one: it means the point is off the
 *  national status layer altogether (Null Island returned `{"features":[]}`). An
 *  ArcGIS error arrives as HTTP 200 with an `error` body, so it is checked here too. */
export function readStatus(body) {
  if (!body || typeof body !== 'object' || body.error || !Array.isArray(body.features)) return 'unknown';
  if (!body.features.length) return 'off-service';
  const status = str(body.features[0] && body.features[0].attributes && body.features[0].attributes.STATUS);
  return SRC.layers[1].statuses.includes(status) ? status : 'unknown';
}

// FWS's own abbreviations, spelled out: nothing on a map should read `CIR`.
const SOURCE_TYPE = { BW: 'black and white', CIR: 'colour infrared', NC: 'natural colour',
  C: 'colour', DOQ: 'digital orthophoto' };

/** The vintage of the imagery this place's wetlands were drawn from.
 *
 *  IMAGE_SCALE is NOT uniform: Wisconsin returned 20000, Nevada the sentinel `1`. A
 *  card printing "1:1" is worse than one saying the scale is not stated, so ALL_SCALES
 *  (a string, "1:20K") is preferred and a scale below 1,000 is treated as absent. */
export function readVintage(body) {
  const rows = body && typeof body === 'object' && !body.error && Array.isArray(body.features) ? body.features : [];
  const a = (rows[0] && rows[0].attributes) || {};
  const year = num(Number(a.IMAGE_YR)) && Number(a.IMAGE_YR) > 1900 ? Number(a.IMAGE_YR) : null;
  if (!rows.length || year === null) {
    return { known: false, year: null, scale: null, project: null,
      text: 'The inventory did not state which imagery the wetlands here were drawn from, so '
        + 'their age is unknown — not current.' };
  }
  const allScales = str(a.ALL_SCALES);
  const numeric = Number(a.IMAGE_SCALE);
  const scale = allScales || (Number.isFinite(numeric) && numeric >= 1000 ? `1:${commas(numeric)}` : null);
  const kind = SOURCE_TYPE[str(a.SOURCE_TYPE).toUpperCase()] || null;
  const project = str(a.PROJECT_NAME) || null;
  const from = [kind, 'aerial imagery'].filter(Boolean).join(' ');
  return { known: true, year, scale, project,
    text: `Mapped from ${year} ${from}${scale ? ` at ${scale}` : ', at a scale the source did not '
      + 'state (its scale is not stated here rather than guessed)'}${project ? `, in the ${project} `
      + 'mapping project' : ''}. That is when the picture was taken, not a visit to the ground.` };
}

/** The sentence the layer's row carries, and the one thing this unit exists for: empty,
 *  never-surveyed and off-service are three different facts and must read as three
 *  different sentences. Two of them look identical in the wetlands layer alone. */
export function coverageReport({ status = 'unknown', featureCount = 0, partial = false, vintage = null } = {}) {
  const assessed = status === 'Digital';
  // The AGE belongs to the mapping project, not to the layer, so it is stated only where
  // this ground was actually mapped: appending "mapped from 1994 imagery" to unsurveyed
  // ground would be describing a survey that never happened.
  const age = vintage && vintage.known ? ` ${vintage.text}` : '';
  const say = (text) => ({ status, assessed, count: featureCount, vintage, text });
  if (featureCount > 0) {
    const capped = partial
      ? ' The service capped this answer, so more are mapped here than were drawn.' : '';
    return say(`${commas(featureCount)} mapped wetland${featureCount === 1 ? '' : 's'} drawn in this `
      + `area.${capped} A boundary is a photo-interpreter's reading of aerial imagery, not a survey `
      + `and not a statement that the ground is wet today.${age}`);
  }
  if (status === 'No_Data') {
    return say('This ground has never been mapped by the National Wetlands Inventory, so nothing '
      + 'was drawn. That is NOT a finding of no wetlands — it is the survey not reaching here. '
      + 'Every unmapped area is in Alaska or the Pacific territories.');
  }
  if (status === 'off-service') {
    return say('This area is outside the National Wetlands Inventory altogether — the coverage '
      + 'layer has no record of it either way, so the inventory says nothing about this ground.');
  }
  if (status === 'unknown') {
    return say('Nothing was drawn here, and the coverage layer did not answer, so whether this '
      + 'ground was ever mapped is unknown. Treat a blank area as unchecked rather than as dry.');
  }
  return say('This ground was mapped by the National Wetlands Inventory and none were found in '
    + `this area. An empty answer here is a real answer, unlike an unmapped area.${age}`);
}

/** One ArcGIS polygon -> the shape overlay-paths.js consumes. Rings become `paths`,
 *  as every other boundary layer does. `id` is load-bearing rather than decorative:
 *  the shared pager's `seen` set is what removes the join duplicate, and it only runs
 *  when a normalized feature carries one. */
export function normalizeWetland(raw) {
  const a = (raw && raw.attributes) || {};
  const rings = ((raw && raw.geometry && raw.geometry.rings) || []).filter((r) => Array.isArray(r) && r.length >= 2);
  const id = str(a['Wetlands.OBJECTID']) || str(a.OBJECTID);
  if (!rings.length || !id) return null;
  return { id, name: str(a['Wetlands.WETLAND_TYPE']) || null, layer: LAYER_ID, symbolKey: SYMBOL_WETLAND, paths: rings };
}

const post = async (q, fetchImpl, signal) => {
  const got = await fetchWithDeadline(q.url, {
    fetchImpl, signal, timeoutMs: SRC.timeoutMs, init: { method: 'POST', body: new URLSearchParams(q.params) },
  });
  return got.ok ? got.body : null;
};

/** Count, then decide, then fetch. The order is the design.
 *
 *  A refusal is a real answer and carries its own words, so the row can say why nothing
 *  was drawn rather than showing a blank map. An empty result asks the status layer at
 *  the box's centre -- one 200-byte request, only when the answer was empty -- because
 *  that is the only thing that can tell "none here" from "never surveyed". */
export async function fetchWetlands({ bboxLonLat, fetchImpl = fetch, signal } = {}) {
  const count = readCount(await post(countQuery(bboxLonLat), fetchImpl, signal));
  const verdict = budgetVerdict(count);
  if (!verdict.ok) {
    return { features: [], coverage: 'refused', refused: true, status: null,
      atLeast: verdict.atLeast, report: { status: 'refused', assessed: null, count: 0, text: verdict.text } };
  }
  const q = featureQuery(bboxLonLat);
  const page = await pageThrough({
    url: q.url, label: 'The National Wetlands Inventory', params: q.params,
    normalize: normalizeWetland, fetchImpl, signal, timeoutMs: SRC.timeoutMs, pageSize: PAGE_SIZE, maxPages: MAX_PAGES,
  });
  const partial = page.coverage !== 'complete';
  // Two point queries at the box's centre, asked TOGETHER and only after the budget
  // passed: ~2 KB and a quarter-second each. The status one is what tells an empty
  // answer from unsurveyed ground; the vintage one is the only place a date exists at
  // all, because the wetland features carry none and the service publishes none. Both
  // are the difference between drawing a 1994 line and presenting it as current.
  const mid = [(bboxLonLat.minLon + bboxLonLat.maxLon) / 2, (bboxLonLat.minLat + bboxLonLat.maxLat) / 2];
  const [statusBody, vintageBody] = await Promise.all([
    post(statusQuery(mid[0], mid[1]), fetchImpl, signal),
    post(vintageQuery(mid[0], mid[1]), fetchImpl, signal),
  ]);
  const status = readStatus(statusBody);
  const vintage = readVintage(vintageBody);
  return { ...page, refused: false, status, vintage, atLeast: verdict.atLeast,
    report: coverageReport({ status, featureCount: page.features.length, partial, vintage }) };
}

/** The layer's own words. The label names the INVENTORY rather than "wetlands",
 *  because what is drawn is a catalogue with a vintage and not the ground. */
export const LAYER_LABEL = 'Mapped wetlands (USFWS National Wetlands Inventory)';
export const LAYER_CAVEAT = 'Boundaries a photo-interpreter drew from aerial imagery of a stated '
  + 'year, not a survey and not a visit: the imagery ranges from the 1970s to the 2020s and the row '
  + 'names the year for the area you drew. A polygon says nothing about access, ownership, whether '
  + 'the ground is wet today, or whether any law regulates it. A blank area may mean the ground was '
  + 'mapped and holds none, or that it has never been mapped — the row says which. A large area '
  + 'is refused rather than fetched slowly.';
/** The notice this layer's mark obliges. It LIVES in legend.js, beside the land and
 *  parcel notices, because what a notice attaches to is a symbol and that file owns
 *  those; it is re-exported here so every word this source shows a reader is reachable
 *  from the source, which is what readerStrings() below is scanned for. */
export { WETLAND_SEMANTICS } from './legend.js';

/** Every string this source can put in front of a reader, in one place, for the gates
 *  that read reader text. */
export function readerStrings() {
  return [LAYER_LABEL, LAYER_CAVEAT, WETLAND_SEMANTICS, SRC.attribution,
    budgetVerdict(29608).text, budgetVerdict(null).text,
    readVintage(null).text,
    ...['Digital', 'No_Data', 'off-service', 'unknown'].map((s) => coverageReport({ status: s }).text),
    coverageReport({ status: 'Digital', featureCount: 41 }).text];
}
