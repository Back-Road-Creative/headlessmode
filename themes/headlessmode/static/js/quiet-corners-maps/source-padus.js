// PAD-US public access, read for one drawn area and answered in WORDS.
//
// It draws nothing. usgsGovUnits already puts federal designation boundaries on the map,
// and this layer's subject is not where the line is but what the manager filed about
// getting in — four categories whose own service defines a colour for only three of them.
// A picture drawn from those colours drops 43,047 records; a picture drawn from colours we
// invented would say a thing EPA-style ramps are criticised for elsewhere in this app. So
// the answer is a sentence in the Layers panel, in the service's own words.
//
// Measured live 2026-09-15 with `Origin: https://headlessmode.com`, no key, no account:
// `access-control-allow-origin: *`, `maxRecordCount` 2,000, 305,960 records nationally.
//
// FOUR TRAPS, each of which reads as a plausible answer rather than as a failure:
//
//  * A bad request answers HTTP 200 with `{"error":{…}}` and NO `features` key. `res.ok` is
//    TRUE. Everything here tests for `features`, never for a status. (usgsGovUnits layer 23
//    taught this; PAD-US is its nastiest form.)
//  * `Non-PAD-US Area` is background fill for the country PAD-US does not inventory — two
//    polygons, 110,871,316 acres, `Pub_Access: UK`. In CONUS "not protected" returns zero
//    records; in interior Alaska it returns this instead, and read plainly it says public
//    access is unknown across a sixth of the country. Excluded in the WHERE clause AND
//    dropped again here, because the exclusion is one edit away from being lost.
//  * `GIS_Acres` is the WHOLE unit's area. Six records over a 491,877-acre box sum to
//    3,033,604. Nothing overlaps; the polygons run outside the box. Per unit, or not at all.
//  * `UK` is a fourth answer, not a shade of `OA` and not silence.
import { SOURCES, FAILURE } from './source-registry.js';

const SRC = SOURCES.padusPublicAccess;
const LAYER = SRC.layers[0];
export const LAYER_ID = 'padusAccess';
export const SERVICE = SRC.serviceUrl;
export const CREDIT = SRC.attribution;
/** The four codes, in the order a reader meets them. UK last because it is the one the
 *  service's own picture has no answer for, never because it is a lesser kind of Open. */
export const ACCESS_ORDER = Object.freeze(['OA', 'RA', 'XA', 'UK']);
/** code -> the service's own field description, word for word. Not a gloss this app wrote. */
export const ACCESS_TEXT = LAYER.accessValues;
export const FILLER_UNIT = LAYER.fillerUnitName;
export const OUT_FIELDS = LAYER.fields;
export const EXCLUDE_WHERE = LAYER.excludeWhere;

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const acres = (n) => n.toLocaleString('en-US');

/** The service's own query for one area. Pure, so the request can be asserted without a
 *  network call. Geometry is left behind deliberately: nothing here draws a polygon, and
 *  the same Boundary Waters box costs 4,710 bytes without it against 707,959 with it. */
export function padusQueryFor({ minLon, minLat, maxLon, maxLat }) {
  return { url: `${SERVICE}/query`,
    params: {
      geometry: `${minLon},${minLat},${maxLon},${maxLat}`,
      geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', returnGeometry: 'false',
      where: EXCLUDE_WHERE, outFields: OUT_FIELDS.join(','), f: 'json',
    } };
}

export const padusQueryUrl = (bbox) => {
  const req = bbox && bbox.url ? bbox : padusQueryFor(bbox);
  return `${req.url}?${new URLSearchParams(req.params)}`;
};

/** What a response holds, or NULL when it is not a feature response at all — an ArcGIS
 *  error envelope included, which arrives at HTTP 200 with no `features` key. Null and an
 *  empty `rows` are different answers and the caller must not be able to confuse them. */
export function readAccess(body) {
  if (!body || !Array.isArray(body.features)) return null;
  const rows = [];
  let fillerCount = 0;
  for (const f of body.features) {
    const a = (f && f.attributes) || {};
    const unit = str(a.Unit_Nm);
    const code = str(a.Pub_Access).toUpperCase();
    if (!unit || !(code in ACCESS_TEXT)) continue;
    if (unit === FILLER_UNIT) { fillerCount += 1; continue; }
    const n = Number(a.GIS_Acres);
    rows.push({ unit, code, access: ACCESS_TEXT[code], manager: str(a.MngNm_Desc),
      designation: str(a.DesTp_Desc), unitAcres: Number.isFinite(n) && n > 0 ? Math.round(n) : null });
  }
  return { rows, fillerCount, capped: !!body.exceededTransferLimit };
}

/** How many units carry each code. Every code is present even at zero, so a caller cannot
 *  read a missing key as "none reported" and a zero as something else. */
export function countByAccess(rows = []) {
  const out = Object.fromEntries(ACCESS_ORDER.map((c) => [c, 0]));
  for (const r of rows) if (r.code in out) out[r.code] += 1;
  return out;
}

/** One unit, in one sentence. The acreage is the unit's OWN total and says so: these
 *  polygons run far outside whatever the reader drew, and a figure without that clause is
 *  read as the area on screen. Summing these is the error this wording exists to prevent. */
export function unitLine(row) {
  const who = row.manager ? ` Managed by ${row.manager}.` : '';
  const what = row.designation ? ` ${row.designation}.` : '';
  const size = row.unitAcres
    ? ` The whole unit measures ${acres(row.unitAcres)} acres, most of which may lie outside the area you drew.` : '';
  return `${row.unit} — ${row.access}.${what}${who}${size}`;
}

/** Nothing covering the area is a result, not an error. Worded for BOTH halves of the
 *  country, because the same empty body means different things in them: in the lower 48
 *  PAD-US inventories the ground and silence is a real "none"; Alaska, Hawaii and the
 *  territories carry 3,133 records between them against CONUS's 302,827. */
export function quietText() {
  return 'No protected area in this inventory covers the area you drew. Across the lower 48 that '
    + 'is a real answer. Alaska, Hawaii and the territories are inventoried far more thinly, so '
    + 'there it can mean the inventory does not reach rather than that the ground is unprotected.';
}

/** The failure that looks most like an answer, in its own words. */
export function serviceErrorText() {
  return 'The protected-areas service did not answer with any records — it replied, but with an '
    + 'error rather than a result. That is a failure to answer and not a statement that there is '
    + 'no protected land here. Try again.';
}

/** What the continent-sized filler means, which is not what it says. */
export function outsideCoverageText() {
  return 'Part of this area is outside what PAD-US inventories at all: it is covered by a single '
    + 'background polygon with no access category of its own. That is the inventory stopping, not '
    + 'public access being unknown.';
}

/** The row this layer owns, for one drawn area. Categories first, in the service's own
 *  words and with the number of units in each, then the units themselves. */
export function accessReport(body, retrievedOn = null) {
  const read = readAccess(body);
  if (!read) return { known: false, text: serviceErrorText(), rows: [] };
  const { rows, fillerCount, capped } = read;
  const parts = [];
  if (fillerCount) parts.push(outsideCoverageText());
  if (!rows.length) {
    parts.push(quietText());
    return { known: false, text: parts.join(' '), rows };
  }
  const counts = countByAccess(rows);
  const heads = ACCESS_ORDER.filter((c) => counts[c])
    .map((c) => `${counts[c]} ${counts[c] === 1 ? 'unit' : 'units'}: ${ACCESS_TEXT[c]}`);
  parts.push(`${rows.length} protected ${rows.length === 1 ? 'unit' : 'units'} here, `
    + 'as the land manager filed it — ' + heads.join('; ') + '.');
  parts.push(...rows.map(unitLine));
  if (capped) parts.push('The service capped this answer, so it is not the whole list for this area.');
  // The service publishes no version and no date on a record, so the only honest date is
  // the one the answer was fetched on — the registry's own noUniformDate sentence.
  if (retrievedOn) parts.push(FAILURE.noUniformDate(retrievedOn));
  return { known: true, text: parts.join(' '), rows };
}

/** Asked for only when a reader asks, and never throws the map. `res.ok` is deliberately
 *  not consulted: this service answers a bad request 200. `accessReport` reads the body. */
export async function fetchAccess(bbox, { fetchImpl = fetch, signal } = {}) {
  try {
    const res = await fetchImpl(padusQueryUrl(bbox), { signal });
    return await res.json();
  } catch (e) { return null; }
}

/** Every string this source can put in front of a reader, in one place, for the test. */
export function readerStrings(body) {
  const report = accessReport(body);
  return [CREDIT, LAYER_LABEL, LAYER_CAVEAT, quietText(), serviceErrorText(), outsideCoverageText(),
    report.text, ...report.rows.map(unitLine)];
}

export const LAYER_LABEL = 'Public access, as the land manager filed it (PAD-US)';
export const LAYER_CAVEAT = 'Four categories a land manager reported — Open, Restricted, Closed or '
  + 'Unknown — for the protected units your area touches, in the words the service itself uses. It '
  + 'is a description of a management regime at whatever date it was filed, never a live check: it '
  + 'says nothing about camping, fires, hunting, driving a two-track or being there after dark, '
  + 'and a boundary here still encloses private inholdings. Unknown means nobody told '
  + 'PAD-US, which is neither Open nor Closed. Each unit\'s acreage is the whole unit, not the part '
  + 'you drew. The unit\'s own manager is the authority; this only tells you which manager to ask.';
