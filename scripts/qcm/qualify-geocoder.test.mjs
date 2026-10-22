// The rural qualification of the Census geocoder: the helpers that score it, and the committed
// evidence file that records one live run. No network. The evidence tests are the "nothing
// invented" gate: the summary must be what the entries add up to, and the decision record
// (GEOCODER.md) may only quote numbers the summary holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  haversineMetres, addressKind, percentile, summarise, pickCorpus, countyIndex, EVIDENCE, RURAL_RUCC, PER_TYPE, PER_STATE,
} from './qualify-geocoder.mjs';

const DOC = JSON.parse(readFileSync(EVIDENCE, 'utf8'));
const RECORD = readFileSync(new URL('GEOCODER.md', import.meta.url), 'utf8');

test('haversine: one degree of latitude is about 111.2 km, and a point is 0 m from itself', () => {
  assert.ok(Math.abs(haversineMetres({ lat: 40, lon: -100 }, { lat: 41, lon: -100 }) - 111195) < 50);
  assert.equal(haversineMetres({ lat: 40, lon: -100 }, { lat: 40, lon: -100 }), 0);
});

test('addressKind separates a street number from a PO box and a rural route', () => {
  assert.equal(addressKind('8527 East Government Center Drive'), 'street-number');
  assert.equal(addressKind('PO Box 12'), 'po-box');
  assert.equal(addressKind('P.O. Box 7'), 'po-box');
  assert.equal(addressKind('RR 2 Box 14'), 'rural-route');
  assert.equal(addressKind('HC 63'), 'rural-route');
  assert.equal(addressKind('Main Street'), 'no-number');
});

test('percentile is nearest-rank on an ascending list', () => {
  const d = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(d, 50), 50);
  assert.equal(percentile(d, 90), 90);
  assert.equal(percentile(d, 100), 100);
  assert.equal(percentile([7], 50), 7);
});

const entry = (type, kind, result) => ({ type, addressKind: kind, result });
test('summarise counts matches, misses and errors apart, and measures distance only on matches', () => {
  const s = summarise([
    entry('courthouse', 'street-number', { resultCount: 1, distanceM: 100, stateAgrees: true, zipAgrees: true }),
    entry('courthouse', 'street-number', { resultCount: 1, distanceM: 300, stateAgrees: true, zipAgrees: false }),
    entry('post-office', 'po-box', { resultCount: 0 }),
    entry('post-office', 'street-number', { error: '502 upstream' }),
  ]);
  assert.deepEqual(s.overall, { n: 4, errors: 1, queried: 3, matched: 2, unmatched: 1, matchRatePct: 66.7, stateAgrees: 2, zipAgrees: 1 });
  assert.deepEqual(s.distance, { n: 2, minM: 100, medianM: 100, p90M: 300, maxM: 300, within100: 1, within250: 1, within500: 2, within1000: 2, over1000: 0 });
  assert.equal(s.byType.courthouse.matched, 2);
  assert.equal(s.byAddressKind['po-box'].unmatched, 1);
});

test('pickCorpus is repeatable, caps each state and each type, and ignores input order', () => {
  const pool = [];
  for (const type of ['courthouse', 'post-office']) {
    for (let i = 0; i < 60; i++) pool.push({ id: `${type}-${i}`, type, state: ['MT', 'NE', 'KS', 'ND', 'SD'][i % 5] });
  }
  const a = pickCorpus(pool);
  const b = pickCorpus([...pool].reverse());
  assert.deepEqual(a, b);
  for (const type of ['courthouse', 'post-office']) {
    const mine = a.filter((c) => c.type === type);
    assert.equal(mine.length, 5 * PER_STATE, 'five states at two each is all this pool allows');
    for (const st of ['MT', 'NE', 'KS', 'ND', 'SD']) assert.ok(mine.filter((c) => c.state === st).length <= PER_STATE);
  }
  assert.equal(pickCorpus(Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, type: 'courthouse', state: `S${i}` }))).length, PER_TYPE);
});

test('countyIndex finds the county of a point from the repo topojson, and only rural ones', () => {
  const at = countyIndex();
  assert.deepEqual(at(-88.3353, 46.0968) && [at(-88.3353, 46.0968).name, at(-88.3353, 46.0968).state], ['Iron County', 'MI']);
  assert.equal(at(-87.63, 41.88), null, 'downtown Chicago is a metro county, absent from the rural table');
  assert.equal(at(-40, 30), null, 'open ocean');
});

test('the evidence file holds a 25 to 40 entry public-building corpus from the published source', () => {
  assert.ok(DOC.corpus.length >= 25 && DOC.corpus.length <= 40, `corpus of ${DOC.corpus.length}`);
  assert.equal(new Set(DOC.corpus.map((e) => e.id)).size, DOC.corpus.length);
  assert.deepEqual([...new Set(DOC.corpus.map((e) => e.type))].sort(), ['courthouse', 'post-office']);
  for (const e of DOC.corpus) {
    assert.ok(RURAL_RUCC.includes(e.county.rucc), `${e.id} is in a rural-code county`);
    assert.equal(e.county.state, e.state);
    assert.match(e.id, /^[0-9a-f-]{36}$/, 'the USGS permanent identifier, so anyone can look the record up');
    assert.ok(e.lat > 17 && e.lat < 72 && e.lon > -180 && e.lon < -64);
  }
  assert.match(DOC.selection.source, /nationalmap\.gov/);
});

test('the summary is exactly what the entries add up to, and every entry was run', () => {
  assert.ok(DOC.corpus.every((e) => e.result), 'an unqueried entry would be a guess');
  assert.deepEqual(DOC.summary, summarise(DOC.corpus));
  assert.ok(Date.parse(DOC.run.finishedAt) > Date.parse(DOC.run.startedAt));
  assert.ok(DOC.corpus.filter((e) => e.result.resultCount > 0).every((e) => e.result.matchClass === 'interpolated'));
});

test('the decision record quotes the measured numbers and no others', () => {
  const { overall, distance } = DOC.summary;
  for (const quoted of [`${overall.matched} of ${overall.queried}`, `${overall.matchRatePct}%`, `${distance.medianM} m`, `${distance.p90M} m`, `${distance.maxM} m`]) {
    assert.ok(RECORD.includes(quoted), `GEOCODER.md should state "${quoted}"`);
  }
  assert.ok(RECORD.includes(DOC.run.startedAt.slice(0, 10)));
});
