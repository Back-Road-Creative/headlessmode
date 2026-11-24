// The compact on-disk camera snapshot format, shared by the build (scripts/qcm/
// build-camera-snapshot.mjs writes it) and the browser (a later unit reads it). Pure: no DOM, no
// network, no imports.
//
// One file holds one (provider, region): a header every record shares, then positional rows.
//
//   { schema:1, provider, layer, region, regionName, generatedAt, source,
//     operator, officialUrl, attribution, rights, category,
//     fields:["providerId","name","lat","lon","still","health","subject","officialUrl"],
//     rows:[[...], ...] }
//
// A row's officialUrl is null when it equals the header's. `attribution` is a header field; a
// file whose records do not all share it gets one extra trailing "attribution" column, so the
// format never silently rewrites a credit. Streams are dropped (D11: stills only).
//
// Schema 2 is additive. A file is written as schema 2 only when a record needs a field schema 1
// has no slot for, and then `fields` declares the extra columns after the schema 1 ones, in this
// order and only the ones some record needs: "bearing" (degrees, 0 to 360, or null),
// "capturedAt" and "validUntil" (canonical ISO strings, as Date#toISOString writes them, or null)
// and "precision" ("exact" or "approximate" for a located row, null for an unlocated one; schema 1
// derives it, "exact" when located). A file with no such record stays schema 1, byte for byte as
// before, so the committed schema 1 seeds never change on a rebuild. A reader accepts both.
// Anything the format still cannot hold (a bad bearing, an unknown precision, a time that is not
// canonical ISO) is refused rather than flattened: the format is robust by construction, it
// cannot write a file that expands to something different.
export const SNAPSHOT_SCHEMA = 1;
export const SNAPSHOT_SCHEMA_RICH = 2;

const BASE_FIELDS = Object.freeze(['providerId', 'name', 'lat', 'lon', 'still', 'health', 'subject', 'officialUrl']);
const HEADER_KEYS = Object.freeze(['provider', 'layer', 'region', 'regionName', 'generatedAt', 'source',
  'operator', 'officialUrl', 'attribution', 'rights', 'category']);
// Header values every record must agree with, record field -> header field (same name).
const SHARED = Object.freeze(['provider', 'operator', 'rights', 'category']);
// Schema 2's optional columns, in the only order they may appear (after the schema 1 columns and
// the optional trailing "attribution").
const RICH_FIELDS = Object.freeze(['bearing', 'capturedAt', 'validUntil', 'precision']);
const PRECISIONS = Object.freeze(['exact', 'approximate']);
const HEALTHS = Object.freeze(['active', 'inactive', 'unknown']);

const isStr = (v) => typeof v === 'string' && v.length > 0;
const isStrOrNull = (v) => v === null || typeof v === 'string';
const isNumOrNull = (v) => v === null || (typeof v === 'number' && Number.isFinite(v));
const isBearing = (v) => typeof v === 'number' && v >= 0 && v <= 360;
// Canonical only (what Date#toISOString writes), so a time survives compact -> expand unchanged.
const isCanonicalTime = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)
  && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v;
const isLocated = (lat, lon) => lat !== null && lon !== null;
const derivedPrecision = (lat, lon) => (isLocated(lat, lon) ? 'exact' : null);
const nowMs = (now) => (now instanceof Date ? now.getTime() : Number(now));

/** Why `file.fields` is not a column list this module reads (or null): the schema 1 columns, an
 *  optional "attribution", then schema 2's extra columns in order -- none for schema 1, at least
 *  one for schema 2. */
function fieldsProblem(file) {
  const { fields, schema } = file;
  const base = BASE_FIELDS.length + (Array.isArray(fields) && fields[BASE_FIELDS.length] === 'attribution' ? 1 : 0);
  if (!Array.isArray(fields) || BASE_FIELDS.some((f, i) => fields[i] !== f)) return 'fields is not the schema 1 column list';
  let at = -1;
  for (const f of fields.slice(base)) {
    const i = RICH_FIELDS.indexOf(f);
    if (i <= at) return `fields has an unknown or out-of-order column ${JSON.stringify(f)}`;
    at = i;
  }
  const rich = fields.length - base;
  if (schema === SNAPSHOT_SCHEMA && rich > 0) return 'fields has a schema 2 column in a schema 1 file';
  if (schema === SNAPSHOT_SCHEMA_RICH && rich === 0) return 'a schema 2 file must declare at least one extra column';
  return null;
}

/** records (normalized, see source-camera.js) + header -> the compact file object. */
export function compactSnapshot(records, header) {
  for (const key of HEADER_KEYS) {
    if (key === 'officialUrl' || key === 'attribution' || key === 'source') continue;
    if (!isStr(header && header[key])) throw new Error(`compactSnapshot: header.${key} is required`);
  }
  const list = Array.isArray(records) ? records : [];
  const needs = new Set();
  for (const r of list) {
    for (const key of SHARED) {
      if (r[key] !== header[key]) {
        throw new Error(`compactSnapshot: ${r.providerId} has ${key} ${JSON.stringify(r[key])}, the header says ${JSON.stringify(header[key])}`);
      }
    }
    const located = isLocated(r.lat, r.lon);
    if (located ? !PRECISIONS.includes(r.locationPrecision) : r.locationPrecision !== null) {
      throw new Error(`compactSnapshot: ${r.providerId} locationPrecision ${JSON.stringify(r.locationPrecision)} is not valid for ${located ? 'a located' : 'an unlocated'} camera`);
    }
    if (r.locationPrecision !== derivedPrecision(r.lat, r.lon)) needs.add('precision');
    if (r.bearing !== null && r.bearing !== undefined) {
      if (!isBearing(r.bearing)) throw new Error(`compactSnapshot: ${r.providerId} bearing ${JSON.stringify(r.bearing)} is not a number of degrees from 0 to 360`);
      needs.add('bearing');
    }
    for (const key of ['capturedAt', 'validUntil']) {
      if (r[key] === null || r[key] === undefined) continue;
      if (!isCanonicalTime(r[key])) throw new Error(`compactSnapshot: ${r.providerId} ${key} ${JSON.stringify(r[key])} is not a canonical ISO time (Date#toISOString)`);
      needs.add(key);
    }
  }
  const perRowAttribution = list.some((r) => r.attribution !== header.attribution);
  const rich = RICH_FIELDS.filter((f) => needs.has(f));
  const fields = [...BASE_FIELDS, ...(perRowAttribution ? ['attribution'] : []), ...rich];
  const rows = list.map((r) => {
    const row = [r.providerId, r.name, r.lat, r.lon, r.media ? r.media.still : null, r.health, r.subject,
      r.officialUrl === header.officialUrl ? null : r.officialUrl];
    if (perRowAttribution) row.push(r.attribution);
    for (const f of rich) {
      row.push(f === 'precision' ? r.locationPrecision : (r[f] === undefined ? null : r[f]));
    }
    return row;
  });
  const out = { schema: rich.length ? SNAPSHOT_SCHEMA_RICH : SNAPSHOT_SCHEMA };
  for (const key of HEADER_KEYS) out[key] = header[key] === undefined ? null : header[key];
  out.fields = fields;
  out.rows = rows;
  return out;
}

/** True when a `validUntil` cell is past at `at` (milliseconds). A row is valid up to and including
 *  the instant. The browser does not run snapshotProblems on a loaded file, so a cell that is not a
 *  time string (hand-edited, damaged) reaches here; it counts as past rather than as NaN, which no
 *  comparison is ever less than and which would keep the still forever. */
function pastExpiry(validUntil, at) {
  return typeof validUntil !== 'string' || !(Date.parse(validUntil) >= at);
}

/** The compact file -> frozen full records, `fetchedAt` = the file's `generatedAt`. A row whose
 *  `validUntil` is before `now` (a Date, or milliseconds; default the clock) has lost its still:
 *  `media.still` is null, the rest of the record is as written. */
export function expandSnapshot(file, { now = Date.now() } = {}) {
  if (!file || (file.schema !== SNAPSHOT_SCHEMA && file.schema !== SNAPSHOT_SCHEMA_RICH)) {
    throw new Error(`expandSnapshot: unsupported schema ${file && file.schema}`);
  }
  const problem = fieldsProblem(file);
  if (problem) throw new Error(`expandSnapshot: unsupported schema ${file.schema}: ${problem}`);
  const at = nowMs(now);
  const col = Object.fromEntries(file.fields.map((name, i) => [name, i]));
  const rich = (row, name) => (col[name] === undefined ? null : row[col[name]]);
  return file.rows.map((row) => {
    const lat = row[col.lat], lon = row[col.lon];
    const officialUrl = row[col.officialUrl];
    const validUntil = rich(row, 'validUntil');
    const expired = validUntil !== null && pastExpiry(validUntil, at);
    return Object.freeze({
      provider: file.provider,
      providerId: row[col.providerId],
      name: row[col.name],
      lat, lon,
      locationPrecision: col.precision === undefined ? derivedPrecision(lat, lon) : row[col.precision],
      category: file.category,
      operator: file.operator,
      officialUrl: officialUrl === null ? file.officialUrl : officialUrl,
      subject: row[col.subject],
      bearing: rich(row, 'bearing'),
      media: Object.freeze({ still: expired ? null : row[col.still], stream: null, streamKind: null }),
      capturedAt: rich(row, 'capturedAt'),
      fetchedAt: file.generatedAt,
      validUntil,
      rights: file.rights,
      attribution: col.attribution === undefined ? file.attribution : row[col.attribution],
      health: row[col.health],
    });
  });
}

/** True when the file has stills and every one of them has expired at `now` (a Date, or
 *  milliseconds): nothing in it can show a picture any more. A file with no `validUntil` column, a
 *  still with no expiry, or no stills at all is never stale. The build marks such a file in
 *  index.json instead of dropping it. */
export function snapshotStale(file, now = Date.now()) {
  const col = Object.fromEntries(file.fields.map((name, i) => [name, i]));
  if (col.validUntil === undefined) return false;
  const at = nowMs(now);
  const stills = file.rows.filter((row) => row[col.still] !== null);
  return stills.length > 0 && stills.every((row) => row[col.validUntil] !== null && pastExpiry(row[col.validUntil], at));
}

/** Every reason a parsed file is not a well-formed snapshot (an empty list means it is fine).
 *  Used by the builder before it indexes or trusts a file on disk, and by the seed test. */
export function snapshotProblems(file) {
  if (!file || typeof file !== 'object' || Array.isArray(file)) return ['file is not an object'];
  const problems = [];
  if (file.schema !== SNAPSHOT_SCHEMA && file.schema !== SNAPSHOT_SCHEMA_RICH) {
    problems.push(`schema is ${file.schema}, expected ${SNAPSHOT_SCHEMA} or ${SNAPSHOT_SCHEMA_RICH}`);
  }
  for (const key of ['provider', 'layer', 'region', 'regionName', 'generatedAt', 'operator', 'rights', 'category']) {
    if (!isStr(file[key])) problems.push(`${key} must be a non-empty string`);
  }
  for (const key of ['source', 'officialUrl', 'attribution']) {
    if (!isStrOrNull(file[key])) problems.push(`${key} must be a string or null`);
  }
  const fieldsIssue = fieldsProblem(file);
  if (fieldsIssue) {
    problems.push(fieldsIssue);
    return problems;
  }
  if (!Array.isArray(file.rows)) { problems.push('rows must be an array'); return problems; }
  const col = Object.fromEntries(file.fields.map((name, i) => [name, i]));
  file.rows.forEach((row, i) => {
    const at = `rows[${i}]`;
    if (!Array.isArray(row) || row.length !== file.fields.length) { problems.push(`${at} must have ${file.fields.length} columns`); return; }
    if (!isStr(row[col.providerId])) problems.push(`${at}.providerId must be a non-empty string`);
    if (!isStr(row[col.name])) problems.push(`${at}.name must be a non-empty string`);
    if (!isNumOrNull(row[col.lat]) || (row[col.lat] !== null && Math.abs(row[col.lat]) > 90)) problems.push(`${at}.lat must be a latitude or null`);
    if (!isNumOrNull(row[col.lon]) || (row[col.lon] !== null && Math.abs(row[col.lon]) > 180)) problems.push(`${at}.lon must be a longitude or null`);
    if ((row[col.lat] === null) !== (row[col.lon] === null)) problems.push(`${at} has only one of lat/lon`);
    if (!isStrOrNull(row[col.still])) problems.push(`${at}.still must be a string or null`);
    if (!HEALTHS.includes(row[col.health])) problems.push(`${at}.health must be one of ${HEALTHS.join('/')}`);
    if (!isStrOrNull(row[col.subject])) problems.push(`${at}.subject must be a string or null`);
    if (!isStrOrNull(row[col.officialUrl])) problems.push(`${at}.officialUrl must be a string or null`);
    if (col.attribution !== undefined && !isStr(row[col.attribution])) problems.push(`${at}.attribution must be a non-empty string`);
    if (col.bearing !== undefined && row[col.bearing] !== null && !isBearing(row[col.bearing])) problems.push(`${at}.bearing must be degrees from 0 to 360 or null`);
    for (const key of ['capturedAt', 'validUntil']) {
      if (col[key] !== undefined && row[col[key]] !== null && !isCanonicalTime(row[col[key]])) problems.push(`${at}.${key} must be a canonical ISO time or null`);
    }
    if (col.precision !== undefined) {
      const ok = isLocated(row[col.lat], row[col.lon]) ? PRECISIONS.includes(row[col.precision]) : row[col.precision] === null;
      if (!ok) problems.push(`${at}.precision must be ${PRECISIONS.join('/')} for a located row and null for an unlocated one`);
    }
  });
  return problems;
}
