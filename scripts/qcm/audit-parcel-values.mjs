#!/usr/bin/env node
// Do the parcels layers this map would REQUEST carry personal names in their VALUES?
//
// The catalogue's `ownerFields` refuse-list is built from field NAMES, and a name
// is not evidence. North Dakota's `Ownership` is declared with a coded-value domain
// of nine categories (Private, Municipal, State, County, Railroad, ...) and its
// catalogue note read "CLEAN: no owner fields, appears deliberately stripped" —
// while Walsh County had populated the same field with individual landowners,
// truncated to its 15-character limit: AAFEDT THOMAS A, AAFEDT BRUCE L. A
// coded-value domain is a schema promise, not a data guarantee.
//
// It is also why this reads DISTINCT values rather than a page of rows. The first
// audit sampled 40 rows per layer, drew them from counties where the field is null
// or properly coded, and reported every state clean.
//
//   node scripts/qcm/audit-parcel-values.mjs                # every fetchable state
//   node scripts/qcm/audit-parcel-values.mjs --state ND     # one
import { STATE_CODES, layerFor, isBrowserFetchable, outFieldsFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/state-sources.js';
import { queryUrl } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-land-boundaries.js';

// SURNAME FIRST [MI], or any value carrying a probate/estate marker.
const PERSONISH = /^[A-Z][A-Z'-]{1,}\s+[A-Z][A-Z'-]{1,}(\s+[A-Z]{1,2})?\s*$|\b(TRUST|TRUSTEE|ETAL|ET AL|LIFE EST|REVOCABLE|HEIRS)\b/;
// Place and agency names are person-shaped and are not people.
const PLACE = /\b(COUNTY|CITY|TOWN|TWP|TOWNSHIP|VILLAGE|BOROUGH|PARISH|DISTRICT|ASSESSOR|DEPARTMENT|STATE OF|UNITED STATES|SCHOOL|PARK)\b/i;
const SAMPLE = 300;

export async function auditState(code, fetchImpl = fetch) {
  const layer = layerFor(code, 'parcels');
  if (!isBrowserFetchable(layer)) return null;
  const url = queryUrl(layer), findings = [];
  for (const field of outFieldsFor(layer)) {
    const p = new URLSearchParams({
      f: 'json', where: `${field} IS NOT NULL`, outFields: field,
      returnDistinctValues: 'true', returnGeometry: 'false', resultRecordCount: String(SAMPLE),
    });
    let json;
    try { json = await (await fetchImpl(`${url}?${p}`, { signal: AbortSignal.timeout(35000) })).json(); }
    catch { findings.push({ field, error: 'unreachable' }); continue; }
    if (json.error) { findings.push({ field, error: json.error.message || 'refused' }); continue; }
    const values = (json.features || []).map((f) => String(f.attributes?.[field] ?? '').trim()).filter(Boolean);
    if (values.length < 5) continue;
    const hits = values.filter((v) => PERSONISH.test(v) && !PLACE.test(v));
    if (hits.length >= 3 && hits.length / values.length > 0.15) {
      findings.push({ field, personish: hits.length, distinct: values.length, examples: hits.slice(0, 3) });
    }
  }
  return { code, findings };
}

const only = process.argv[process.argv.indexOf('--state') + 1];
const codes = process.argv.includes('--state') ? [only.toUpperCase()] : STATE_CODES;
let leaks = 0;
for (const code of codes) {
  const r = await auditState(code);
  if (!r) continue;
  const bad = r.findings.filter((f) => f.personish);
  for (const f of bad) {
    leaks++;
    console.log(`${code} ${f.field}: ${f.personish}/${f.distinct} distinct values look like people — ${f.examples.join(' | ')}`);
  }
  for (const f of r.findings.filter((x) => x.error)) console.log(`${code} ${f.field}: ${f.error}`);
}
console.log(leaks ? `\n${leaks} field(s) must be added to ownerFields.` : '\nNo requested parcels field carries person-shaped values.');
