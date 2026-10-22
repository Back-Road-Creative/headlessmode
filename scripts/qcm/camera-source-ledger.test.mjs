// The camera source ledger (scripts/qcm/camera-source-ledger.json) and its intake report
// (camera-source-ledger.md) are a reviewed document. This test holds that document in place: the
// ledger cannot fall behind the code, a row cannot drop a field, and a rights line cannot be
// written without the page it came from. Pure: reads files and imports the camera modules; no
// browser, no network.
//
// The list of camera sources is read from the code at test time (the build's PROVIDERS table, the
// adapter tables in source-camera.js, the committed seed index), never copied here, so adding a
// provider to the code without a ledger row fails this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import * as sourceCamera from '../../themes/headlessmode/static/js/quiet-corners-maps/source-camera.js';
import { PROVIDERS } from './build-camera-snapshot.mjs';

const here = (rel) => new URL(rel, import.meta.url);
const LEDGER_URL = here('camera-source-ledger.json');
const REPORT_URL = here('camera-source-ledger.md');
const readJson = (url) => JSON.parse(readFileSync(url, 'utf8'));

const FIELDS = Object.freeze(['id', 'operator', 'sourceUrl', 'adapter', 'status', 'coverage', 'purpose',
  'credentialsAndLimits', 'rights', 'stableIds', 'positionPrecision', 'media', 'captureTime',
  'lastQualified', 'health', 'duplicates', 'owner']);
const STATUSES = new Set(['merged', 'pending', 'candidate', 'rejected']);
const PURPOSES = new Set(['roads', 'scenery', 'water', 'weather-aviation', 'wildlife', 'science']);
const MEDIA = new Set(['still', 'stream', 'embed', 'link-only']);
const PRECISIONS = new Set(['exact', 'approximate', 'mixed', 'unknown']);
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const isoDateOk = (s) => {
  const m = ISO_DATE.exec(String(s));
  if (!m) return false;
  const d = new Date(`${m[0]}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(m[0]);
};

/** Every provider id the merged code knows, each from the place that defines it. */
function codeProviderIds() {
  const ids = new Set();
  for (const p of PROVIDERS) ids.add(p.id); // the build's provider table
  for (const id of sourceCamera.LINK_ONLY_PROVIDERS) ids.add(id);
  for (const table of ['ARCGIS_LAYERS', 'CARS_FEEDS', 'ITERIS_LAYERS', 'SOCRATA_LAYERS']) {
    for (const layer of sourceCamera[table] || []) ids.add(layer.id);
  }
  // Adapters with a default provider id: the legacy Great Smoky Mountains NPS file and Caltrans.
  ids.add(sourceCamera.normalizeNpsWebcamRecord({ id: 'probe' }).provider);
  ids.add(sourceCamera.normalizeCaltransCctvRecord({ index: 1 }).provider);
  // Whatever the committed seeds actually carry.
  const index = readJson(here('../../static/data/quiet-corners-maps/cameras/index.json'));
  for (const f of index.files) ids.add(f.provider);
  ids.add(readJson(here('../../static/data/quiet-corners-maps/cameras-nps-grsm.json')).cameras[0].provider);
  return [...ids].sort();
}

const ledger = existsSync(LEDGER_URL) ? readJson(LEDGER_URL) : { rows: [] };
const rows = Array.isArray(ledger.rows) ? ledger.rows : [];
const report = existsSync(REPORT_URL) ? readFileSync(REPORT_URL, 'utf8') : '';

test('the ledger and its intake report exist', () => {
  assert.ok(existsSync(LEDGER_URL), 'scripts/qcm/camera-source-ledger.json is missing');
  assert.ok(existsSync(REPORT_URL), 'scripts/qcm/camera-source-ledger.md is missing');
  assert.ok(rows.length > 0, 'the ledger has no rows');
});

test('every provider id the merged code knows has exactly one ledger row, and it is merged', () => {
  const known = codeProviderIds();
  assert.ok(known.length >= 18, `expected the code to know 18+ camera providers, found ${known.length}`);
  for (const id of known) {
    const matches = rows.filter((r) => r.id === id);
    assert.equal(matches.length, 1, `provider ${id} must have exactly one ledger row, found ${matches.length}`);
    assert.equal(matches[0].status, 'merged', `provider ${id} is in the merged code, so its row must be merged`);
  }
  const merged = rows.filter((r) => r.status === 'merged').map((r) => r.id).sort();
  assert.deepEqual(merged, known, 'the merged rows are exactly the providers the code knows');
});

test('row ids are unique, and a merged id is never also a candidate', () => {
  const ids = rows.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'a row id appears twice');
  const known = new Set(codeProviderIds());
  for (const r of rows) {
    if (known.has(r.id)) assert.notEqual(r.status, 'candidate', `${r.id} is merged code and cannot be a candidate`);
    if (r.status === 'merged') assert.ok(known.has(r.id), `${r.id} is marked merged but no merged code knows it`);
  }
});

test('every row has every field, and nothing else but pending rows\' pr', () => {
  for (const r of rows) {
    const extra = Object.keys(r).filter((k) => !FIELDS.includes(k) && !(k === 'pr' && r.status === 'pending'));
    assert.deepEqual(extra, [], `${r.id} has fields outside the ledger shape`);
    for (const f of FIELDS) {
      assert.ok(Object.hasOwn(r, f), `${r.id} is missing ${f}`);
      if (f === 'lastQualified') continue; // a date or null
      const v = r[f];
      if (f === 'duplicates') assert.ok(Array.isArray(v), `${r.id}.duplicates must be an array`);
      else assert.ok(typeof v === 'string' && v.trim().length > 0, `${r.id}.${f} must be a non-empty string`);
    }
    if (r.status === 'pending') assert.match(r.pr, /^#\d+$/, `${r.id} is pending and must name its PR as "#N"`);
  }
});

test('status, purpose, media, precision and the yes/no fields come from the allowed sets', () => {
  for (const r of rows) {
    assert.ok(STATUSES.has(r.status), `${r.id}.status ${r.status}`);
    assert.ok(PURPOSES.has(r.purpose), `${r.id}.purpose ${r.purpose}`);
    assert.ok(MEDIA.has(r.media), `${r.id}.media ${r.media}`);
    assert.ok(PRECISIONS.has(r.positionPrecision.split(/[ :]/)[0]), `${r.id}.positionPrecision ${r.positionPrecision}`);
    assert.match(r.captureTime, /^(yes|no)$/, `${r.id}.captureTime must be exactly yes or no`);
    assert.match(r.stableIds, /^(yes|no): \S/, `${r.id}.stableIds must be "yes: how" or "no: why"`);
    assert.match(r.owner, /^QQA-\d+[a-z]?$/, `${r.id}.owner must be a unit id`);
    assert.match(r.sourceUrl, /^https:\/\/\S+$/, `${r.id}.sourceUrl must be one https URL`);
  }
});

test('the adapter is "none" or an adapter the merged code exports (a pending row may name its PR\'s)', () => {
  const exported = new Set(Object.keys(sourceCamera));
  for (const r of rows) {
    if (r.adapter === 'none') continue;
    if (r.status === 'pending') { assert.match(r.adapter, /^[A-Za-z][A-Za-z0-9]*$/, `${r.id}.adapter`); continue; }
    assert.ok(exported.has(r.adapter), `${r.id}.adapter ${r.adapter} is not exported by source-camera.js`);
  }
});

test('a rights value is "unverified" or a quoted line with the page URL and the date it was read', () => {
  const asOf = ledger.asOf;
  assert.ok(isoDateOk(asOf), 'the ledger needs an asOf date');
  for (const r of rows) {
    if (r.rights === 'unverified') continue;
    assert.match(r.rights, /"[^"]{8,}"/, `${r.id}.rights must quote the usage line`);
    assert.match(r.rights, /https:\/\/\S+/, `${r.id}.rights must carry the page URL`);
    assert.ok(isoDateOk(r.rights), `${r.id}.rights must carry the ISO date it was read`);
    const read = ISO_DATE.exec(r.rights)[0];
    assert.ok(read <= asOf, `${r.id}.rights was read ${read}, after the ledger's asOf ${asOf}`);
  }
});

test('lastQualified is an ISO date or null, and a candidate or rejected row was never qualified', () => {
  for (const r of rows) {
    if (r.lastQualified !== null) assert.ok(isoDateOk(r.lastQualified) && /^\d{4}-\d{2}-\d{2}$/.test(r.lastQualified), `${r.id}.lastQualified`);
    if (r.status === 'candidate' || r.status === 'rejected') assert.equal(r.lastQualified, null, `${r.id} was never qualified`);
  }
});

test('a rejected row says why in its health field', () => {
  for (const r of rows.filter((x) => x.status === 'rejected')) {
    assert.match(r.health, /^rejected: \S/, `${r.id} is rejected and must say why`);
  }
});

test('duplicates name real other rows, both ways', () => {
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const r of rows) {
    for (const d of r.duplicates) {
      assert.notEqual(d, r.id, `${r.id} lists itself as a duplicate`);
      assert.ok(byId.has(d), `${r.id} lists ${d}, which is not a row`);
      assert.ok(byId.get(d).duplicates.includes(r.id), `${r.id} lists ${d} but ${d} does not list ${r.id}`);
    }
  }
});

test('a merged row\'s coverage carries the camera count measured from the committed seeds', () => {
  const index = readJson(here('../../static/data/quiet-corners-maps/cameras/index.json'));
  const total = new Map();
  for (const f of index.files) total.set(f.provider, (total.get(f.provider) || 0) + f.count);
  total.set('nps-grsm', readJson(here('../../static/data/quiet-corners-maps/cameras-nps-grsm.json')).cameras.length);
  for (const r of rows.filter((x) => x.status === 'merged')) {
    assert.ok(total.has(r.id), `${r.id} has no committed seed`);
    assert.ok(r.coverage.includes(`${total.get(r.id)} cameras`), `${r.id}.coverage must say "${total.get(r.id)} cameras" (the seed's count)`);
  }
});

test('the intake report names every row id and carries the review checklist', () => {
  for (const r of rows) assert.ok(report.includes(`\`${r.id}\``), `the report does not name \`${r.id}\``);
  assert.match(report, /^## Ranked gap list$/m);
  assert.match(report, /^## Review checklist for adding a source$/m);
  for (const rule of ['allowlist', 'reviewable diff', 'never publishes silently', 'builds never refresh images', 'last good catalogue']) {
    assert.ok(report.toLowerCase().includes(rule.toLowerCase()), `the checklist does not state: ${rule}`);
  }
});
