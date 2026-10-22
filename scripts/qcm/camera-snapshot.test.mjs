// camera-snapshot.js: the compact on-disk camera format shared by the build and the browser.
// Real fixtures only (the same recorded NPS and Caltrans captures source-camera.test.mjs uses);
// no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeNpsWebcams, normalizeCaltransCctv }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/source-camera.js';
import { compactSnapshot, expandSnapshot, snapshotProblems, SNAPSHOT_SCHEMA }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/camera-snapshot.js';

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const GENERATED_AT = '2026-09-27T18:34:30.000Z';
const NPS = normalizeNpsWebcams(read('fixtures/nps-webcams-grsm-2026-09-27.min.json'), { fetchedAt: GENERATED_AT });
const CALTRANS = normalizeCaltransCctv(read('fixtures/caltrans-cctv-d05-2026-09-27.min.json'), { fetchedAt: GENERATED_AT });

const npsHeader = {
  provider: 'nps-grsm', layer: 'parkCameras', region: 'grsm', regionName: 'Great Smoky Mountains',
  generatedAt: GENERATED_AT, source: 'https://developer.nps.gov/api/v1/webcams?parkCode=grsm',
  operator: 'NPS Air Quality Network', officialUrl: 'https://www.nps.gov/grsm/learn/photosmultimedia/webcams.htm',
  attribution: NPS[0].attribution, rights: 'unverified', category: 'scenic',
};
const caltransHeader = {
  provider: 'caltrans-cwwp2', layer: 'roadCameras', region: 'ca-d05', regionName: 'Caltrans District 5',
  generatedAt: GENERATED_AT, source: 'https://cwwp2.dot.ca.gov/data/d5/cctv/cctvStatusD05.json',
  operator: 'Caltrans', officialUrl: CALTRANS[0].officialUrl,
  attribution: 'Caltrans', rights: 'unverified', category: 'road',
};
// D11: stills only, so a stream never survives the format.
const withoutStream = (r) => ({ ...r, media: { ...r.media, stream: null, streamKind: null } });

test('NPS records survive compact -> expand unchanged', () => {
  const file = compactSnapshot(NPS, npsHeader);
  assert.deepEqual(expandSnapshot(file), NPS);
});

test('Caltrans records survive compact -> expand, minus the stream the format drops', () => {
  const file = compactSnapshot(CALTRANS, caltransHeader);
  assert.deepEqual(expandSnapshot(file), CALTRANS.map(withoutStream));
});

test('the file is compact: schema 1, header fields, positional rows, shared officialUrl nulled', () => {
  const file = compactSnapshot(CALTRANS, caltransHeader);
  assert.equal(file.schema, SNAPSHOT_SCHEMA);
  assert.equal(file.schema, 1);
  for (const key of ['provider', 'layer', 'region', 'regionName', 'generatedAt', 'source',
    'operator', 'officialUrl', 'attribution', 'rights', 'category']) {
    assert.equal(file[key], caltransHeader[key], key);
  }
  assert.deepEqual(file.fields,
    ['providerId', 'name', 'lat', 'lon', 'still', 'health', 'subject', 'officialUrl']);
  assert.equal(file.rows.length, CALTRANS.length);
  const urlCol = file.fields.indexOf('officialUrl');
  for (const row of file.rows) {
    assert.equal(row.length, file.fields.length);
    assert.equal(row[urlCol], null, 'a row whose officialUrl equals the header stores null');
  }
  const nps = compactSnapshot(NPS, npsHeader);
  assert.ok(nps.rows.every((row) => typeof row[urlCol] === 'string'), 'a per-camera url is kept');
});

test('a record whose attribution differs from the header gets an attribution column and round-trips', () => {
  const mixed = [NPS[0], Object.freeze({ ...NPS[1], attribution: 'A photographer' })];
  const file = compactSnapshot(mixed, npsHeader);
  assert.ok(file.fields.includes('attribution'));
  assert.deepEqual(expandSnapshot(file), mixed);
});

test('expandSnapshot returns frozen records stamped fetchedAt = generatedAt', () => {
  const out = expandSnapshot(compactSnapshot(NPS, npsHeader));
  for (const r of out) {
    assert.ok(Object.isFrozen(r));
    assert.ok(Object.isFrozen(r.media));
    assert.equal(r.fetchedAt, GENERATED_AT);
  }
});

test('compactSnapshot refuses a record the shared header cannot describe', () => {
  assert.throws(() => compactSnapshot([{ ...NPS[0], operator: 'Someone else' }], npsHeader), /operator/);
  assert.throws(() => compactSnapshot([{ ...NPS[0], provider: 'caltrans-cwwp2' }], npsHeader), /provider/);
  assert.throws(() => compactSnapshot([{ ...NPS[0], capturedAt: '2026-01-01T00:00:00Z' }], npsHeader), /capturedAt/);
});

test('expandSnapshot refuses an unknown schema', () => {
  assert.throws(() => expandSnapshot({ ...compactSnapshot(NPS, npsHeader), schema: 2 }), /schema/);
});

test('snapshotProblems: a good file has none, bad rows and headers are named', () => {
  assert.deepEqual(snapshotProblems(compactSnapshot(NPS, npsHeader)), []);
  const good = compactSnapshot(NPS, npsHeader);
  assert.ok(snapshotProblems({ ...good, rows: [['short']] }).length > 0);
  assert.ok(snapshotProblems({ ...good, region: '' }).length > 0);
  assert.ok(snapshotProblems(null).length > 0);
  const badLat = { ...good, rows: [[...good.rows[0].slice(0, 2), 123, ...good.rows[0].slice(3)]] };
  assert.ok(snapshotProblems(badLat).some((p) => /lat/.test(p)));
});
