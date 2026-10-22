// QQA-17b: camera snapshot schema 2 (bearing, capturedAt, validUntil, precision), still expiry, the
// shared adapter parsers, and the builder's handling of mixed-schema directories. Offline: the
// records are built in the test or taken from the recorded fixtures; the only files read are the
// committed seeds, and nothing here writes outside a temp directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as snap from '../../themes/headlessmode/static/js/quiet-corners-maps/camera-snapshot.js';
import * as cam from '../../themes/headlessmode/static/js/quiet-corners-maps/source-camera.js';
import { buildSnapshotDir } from './build-camera-snapshot.mjs';

const { compactSnapshot, expandSnapshot, snapshotProblems, snapshotStale } = snap;
const GENERATED_AT = '2026-10-04T12:00:00.000Z';
const SEED_DIR = new URL('../../static/data/quiet-corners-maps/cameras/', import.meta.url);
const tmpDir = () => mkdtempSync(join(tmpdir(), 'camera-17b-'));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const header = {
  provider: 'test-dot', layer: 'roadCameras', region: 'ca-d99', regionName: 'Test District',
  generatedAt: GENERATED_AT, source: 'https://example.test/cams.json', operator: 'Test DOT',
  officialUrl: 'https://example.test/cams', attribution: 'Test DOT', rights: 'unverified', category: 'road',
};
const rec = (i, over = {}) => Object.freeze({
  provider: 'test-dot', providerId: `test-dot-${i}`, name: `Camera ${i}`, lat: 36 + i / 100, lon: -122,
  locationPrecision: 'exact', category: 'road', operator: 'Test DOT', officialUrl: 'https://example.test/cams',
  subject: null, bearing: null,
  media: { still: `https://example.test/${i}.jpg`, stream: null, streamKind: null },
  capturedAt: null, fetchedAt: GENERATED_AT, validUntil: null, rights: 'unverified',
  attribution: 'Test DOT', health: 'active', ...over,
});
const RICH = [
  rec(1, { bearing: 270, capturedAt: '2026-10-04T11:58:00.000Z', validUntil: '2026-10-04T12:30:00.000Z' }),
  rec(2, { locationPrecision: 'approximate' }),
  rec(3),
  rec(4, { lat: null, lon: null, locationPrecision: null, bearing: 0 }),
];

test('schema 1 golden: every committed seed file re-compacts byte for byte', () => {
  const files = readdirSync(SEED_DIR, { recursive: true }).filter((f) => f.endsWith('.json') && f !== 'index.json');
  assert.ok(files.length >= 38, `expected the 38 seed files, found ${files.length}`);
  for (const f of files) {
    const text = readFileSync(new URL(f, SEED_DIR), 'utf8');
    const parsed = JSON.parse(text);
    assert.equal(parsed.schema, 1, f);
    const { fields, rows, schema, ...head } = parsed;
    // Caltrans seeds drop the stream and every record is expanded at the default clock: no expiry.
    const again = compactSnapshot(expandSnapshot(parsed), head);
    assert.equal(JSON.stringify(again), text, `${f} would change on a rebuild`);
  }
});

test('schema 2 round trip: bearing, capturedAt, validUntil and precision survive, nothing else moves', () => {
  const file = compactSnapshot(RICH, header);
  assert.equal(file.schema, 2);
  assert.deepEqual(file.fields,
    ['providerId', 'name', 'lat', 'lon', 'still', 'health', 'subject', 'officialUrl',
      'bearing', 'capturedAt', 'validUntil', 'precision']);
  assert.deepEqual(snapshotProblems(file), []);
  assert.deepEqual(expandSnapshot(file, { now: Date.parse('2026-10-04T12:10:00.000Z') }), RICH);
});

test('schema 2 declares only the columns a record needs, in a fixed order', () => {
  const bearingOnly = compactSnapshot([rec(1, { bearing: 12.5 }), rec(2)], header);
  assert.equal(bearingOnly.schema, 2);
  assert.deepEqual(bearingOnly.fields.slice(8), ['bearing']);
  const precisionOnly = compactSnapshot([rec(1, { locationPrecision: 'approximate' }), rec(2)], header);
  assert.deepEqual(precisionOnly.fields.slice(8), ['precision']);
  const withAttribution = compactSnapshot([rec(1, { bearing: 1 }), rec(2, { attribution: 'Someone' })], header);
  assert.deepEqual(withAttribution.fields.slice(8), ['attribution', 'bearing']);
  assert.deepEqual(expandSnapshot(withAttribution).map((r) => r.attribution), ['Test DOT', 'Someone']);
});

test('no richer field anywhere: the file is schema 1 with the schema 1 columns', () => {
  const file = compactSnapshot([rec(1), rec(2), rec(3, { lat: null, lon: null, locationPrecision: null })], header);
  assert.equal(file.schema, 1);
  assert.equal(file.fields.length, 8);
});

test('expiry: a row whose validUntil has passed loses its still, others keep it', () => {
  const file = compactSnapshot([
    rec(1, { validUntil: '2026-10-04T12:30:00.000Z' }),
    rec(2, { validUntil: '2026-10-04T14:00:00.000Z' }),
    rec(3),
  ], header);
  const at = (iso) => expandSnapshot(file, { now: Date.parse(iso) }).map((r) => r.media.still !== null);
  assert.deepEqual(at('2026-10-04T12:29:59.000Z'), [true, true, true]);
  assert.deepEqual(at('2026-10-04T12:30:00.000Z'), [true, true, true], 'valid up to and including the instant');
  assert.deepEqual(at('2026-10-04T12:30:00.001Z'), [false, true, true]);
  assert.deepEqual(at('2026-10-04T15:00:00.000Z'), [false, false, true], 'no validUntil never expires');
  const expired = expandSnapshot(file, { now: Date.parse('2026-10-04T15:00:00.000Z') })[0];
  assert.equal(expired.validUntil, '2026-10-04T12:30:00.000Z', 'the record still says when it expired');
  assert.ok(Object.isFrozen(expired) && Object.isFrozen(expired.media));
});

test('expiry: a validUntil that does not read as a time drops the still -- an unreadable expiry never keeps a picture forever', () => {
  // The browser does not run snapshotProblems on what it loads, so a hand-edited or damaged cell
  // reaches expandSnapshot as is. Date.parse of it is NaN, and NaN < now is false: that kept the
  // still at any date. An expiry nobody can read is treated as passed.
  const file = compactSnapshot([rec(1, { validUntil: '2999-01-01T00:00:00.000Z' }),
    rec(2, { validUntil: '2999-01-01T00:00:00.000Z' })], header);
  const col = file.fields.indexOf('validUntil');
  const bad = { ...file, rows: file.rows.map((r, i) => (i === 0 ? Object.assign([...r], { [col]: 'garbage' }) : r)) };
  const now = Date.parse('2026-10-04T12:00:00.000Z');
  assert.deepEqual(expandSnapshot(bad, { now }).map((r) => r.media.still !== null), [false, true]);
  const allBad = { ...file, rows: file.rows.map((r) => Object.assign([...r], { [col]: 42 })) };
  assert.equal(snapshotStale(allBad, now), true, 'every still has an unreadable expiry: nothing in the file can show');
});

test('expiry: the default clock is Date.now()', () => {
  const file = compactSnapshot([rec(1, { validUntil: '2001-01-01T00:00:00.000Z' }),
    rec(2, { validUntil: '2999-01-01T00:00:00.000Z' })], header);
  assert.deepEqual(expandSnapshot(file).map((r) => r.media.still !== null), [false, true]);
  assert.deepEqual(expandSnapshot(file, {}).map((r) => r.media.still !== null), [false, true]);
});

test('snapshotStale: true only when the file has stills and every one has expired', () => {
  const file = compactSnapshot([rec(1, { validUntil: '2026-10-04T12:30:00.000Z' }),
    rec(2, { validUntil: '2026-10-04T14:00:00.000Z' })], header);
  assert.equal(snapshotStale(file, Date.parse('2026-10-04T13:00:00.000Z')), false);
  assert.equal(snapshotStale(file, Date.parse('2026-10-04T14:00:00.001Z')), true);
  const oneForever = compactSnapshot([rec(1, { validUntil: '2026-10-04T12:30:00.000Z' }), rec(2)], header);
  assert.equal(snapshotStale(oneForever, Date.parse('2030-01-01T00:00:00.000Z')), false);
  const linkOnly = compactSnapshot([rec(1, { validUntil: '2026-10-04T12:30:00.000Z',
    media: { still: null, stream: null, streamKind: null } })], header);
  assert.equal(snapshotStale(linkOnly, Date.parse('2030-01-01T00:00:00.000Z')), false, 'no stills, nothing to expire');
  assert.equal(snapshotStale(compactSnapshot([rec(1)], header), Date.parse('2030-01-01T00:00:00.000Z')), false);
});

test('compactSnapshot rejects a bad bearing, precision or time instead of writing it', () => {
  const bad = (over, re) => assert.throws(() => compactSnapshot([rec(1, over)], header), re, JSON.stringify(over));
  bad({ bearing: -1 }, /bearing/);
  bad({ bearing: 360.5 }, /bearing/);
  bad({ bearing: Number.NaN }, /bearing/);
  bad({ bearing: '90' }, /bearing/);
  bad({ locationPrecision: 'rough' }, /locationPrecision/);
  bad({ locationPrecision: null }, /locationPrecision/);
  bad({ lat: null, lon: null, locationPrecision: 'exact' }, /locationPrecision/);
  bad({ lat: null, lon: null, locationPrecision: 'approximate' }, /locationPrecision/);
  bad({ capturedAt: '2026-10-04' }, /capturedAt/);
  bad({ capturedAt: '2026-10-04T11:58:00Z' }, /capturedAt/);
  bad({ capturedAt: 1759579080000 }, /capturedAt/);
  bad({ validUntil: 'tomorrow' }, /validUntil/);
  bad({ validUntil: '2026-02-30T00:00:00.000Z' }, /validUntil/);
});

test('snapshotProblems names a hand-edited schema 2 file that breaks the rules', () => {
  const good = compactSnapshot(RICH, header);
  const col = (name) => good.fields.indexOf(name);
  const edit = (name, value, row = 0) => ({ ...good, rows: good.rows.map((r, i) => {
    if (i !== row) return r;
    const copy = [...r]; copy[col(name)] = value; return copy;
  }) });
  assert.ok(snapshotProblems(edit('bearing', 361)).some((p) => /bearing/.test(p)));
  assert.ok(snapshotProblems(edit('bearing', '90')).some((p) => /bearing/.test(p)));
  assert.ok(snapshotProblems(edit('capturedAt', 'soon')).some((p) => /capturedAt/.test(p)));
  assert.ok(snapshotProblems(edit('validUntil', '2026-10-04T12:30:00Z')).some((p) => /validUntil/.test(p)));
  assert.ok(snapshotProblems(edit('precision', 'rough', 1)).some((p) => /precision/.test(p)));
  assert.ok(snapshotProblems(edit('precision', 'exact', 3)).some((p) => /precision/.test(p)), 'an unlocated row has no precision');
  assert.ok(snapshotProblems(edit('precision', null, 1)).some((p) => /precision/.test(p)), 'a located row needs one');
  assert.ok(snapshotProblems({ ...good, schema: 1 }).length > 0, 'schema 1 cannot carry a richer column');
  assert.ok(snapshotProblems({ ...good, schema: 3 }).some((p) => /schema/.test(p)));
  const plain = compactSnapshot([rec(1)], header);
  assert.ok(snapshotProblems({ ...plain, schema: 2 }).length > 0, 'schema 2 declares at least one richer column');
  const swapped = { ...good, fields: [...good.fields.slice(0, 8), 'capturedAt', 'bearing', 'validUntil', 'precision'] };
  assert.ok(snapshotProblems(swapped).some((p) => /fields/.test(p)));
  assert.throws(() => expandSnapshot({ ...plain, schema: 2 }), /schema/);
  assert.throws(() => expandSnapshot({ ...good, schema: 3 }), /schema/);
});

// --- the shared adapter helpers ----------------------------------------------------------------

test('parseIsoTime: an ISO 8601 instant with a zone becomes the canonical ISO string, anything else null', () => {
  assert.equal(cam.parseIsoTime('2026-10-04T11:58:00Z'), '2026-10-04T11:58:00.000Z');
  assert.equal(cam.parseIsoTime('2026-10-04T07:58:00-04:00'), '2026-10-04T11:58:00.000Z');
  assert.equal(cam.parseIsoTime('2026-10-04T11:58:00.5Z'), '2026-10-04T11:58:00.500Z');
  assert.equal(cam.parseIsoTime('2026-10-04T11:58Z'), '2026-10-04T11:58:00.000Z');
  for (const v of [undefined, null, '', '   ', '2026-10-04', '2026-10-04T11:58:00', 'Oct 4 2026 11:58 AM',
    1759579080000, '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-10-04T24:00:00Z', 'yesterday', {}]) {
    assert.equal(cam.parseIsoTime(v), null, String(v));
  }
});

test('parseBearing: degrees 0 to 360 as a number, anything else (a compass word, blank, out of range) null', () => {
  assert.equal(cam.parseBearing(0), 0);
  assert.equal(cam.parseBearing(90), 90);
  assert.equal(cam.parseBearing(359.5), 359.5);
  assert.equal(cam.parseBearing(360), 360);
  assert.equal(cam.parseBearing('270'), 270);
  for (const v of [undefined, null, '', ' ', 'North', 'NE', -1, 361, Number.NaN, Infinity, {}, []]) {
    assert.equal(cam.parseBearing(v), null, String(v));
  }
});

test('parseBearing: a string must be a plain decimal -- hex, binary, exponent and signed forms are null, never a heading', () => {
  for (const v of ['0x5A', '0b11', '0o7', '1e2', '+90', '-0', 'Infinity', '9,0', '90deg', '1_0']) {
    assert.equal(cam.parseBearing(v), null, v);
  }
  assert.equal(cam.parseBearing(' 90 '), 90);
  assert.equal(cam.parseBearing('45.5'), 45.5);
  assert.equal(cam.parseBearing('0'), 0);
  assert.equal(cam.parseBearing('360'), 360);
});

test('precisionFor: no position is null; located is exact unless the adapter says approximate', () => {
  assert.equal(cam.precisionFor(1, 2), 'exact');
  assert.equal(cam.precisionFor(1, 2, 'exact'), 'exact');
  assert.equal(cam.precisionFor(1, 2, 'approximate'), 'approximate');
  assert.equal(cam.precisionFor(null, 2, 'approximate'), null);
  assert.equal(cam.precisionFor(1, null), null);
  assert.throws(() => cam.precisionFor(1, 2, 'rough'), /precision/);
});

test('no merged adapter supplies a bearing, capture time, expiry or approximate position today', () => {
  const caltrans = cam.normalizeCaltransCctvRecord({ index: 1, location: { latitude: '36', longitude: '-120' },
    recordTimestamp: { recordDate: '2026-06-26', recordTime: '10:00:00' }, imageData: { static: { currentImageURL: 'https://x.test/a.jpg' } } });
  assert.equal(caltrans.capturedAt, null);
  assert.equal(caltrans.bearing, null);
  assert.equal(caltrans.validUntil, null);
  assert.equal(caltrans.locationPrecision, 'exact');
});

// --- the builder -------------------------------------------------------------------------------

const testProvider = (records, over = {}) => ({
  id: 'test-dot', layer: 'roadCameras', keyEnv: 'TEST_DOT_KEY', source: 'https://example.test/cams.json',
  officialUrl: 'https://example.test/cams',
  async fetch({ env }) {
    return env.TEST_DOT_KEY ? { ok: true, payload: {} } : { ok: false, reason: 'no-key: TEST_DOT_KEY is not set' };
  },
  regions() { return [{ region: 'ca-d99', regionName: 'Test District', records }]; },
  ...over,
});
const ENV = { TEST_DOT_KEY: 'test-key-17b-aaaa' };

test('builder: a directory of schema 1 and schema 2 files is indexed whole, each file in its own schema', async () => {
  const outDir = tmpDir();
  // A schema 1 file and a schema 2 file already on disk from earlier runs of other providers.
  const put = (provider, region, records) => {
    const file = compactSnapshot(records.map((r) => ({ ...r, provider })), { ...header, provider, region, regionName: region });
    mkdirSync(join(outDir, provider), { recursive: true });
    writeFileSync(join(outDir, provider, `${region}.json`), JSON.stringify(file));
    return file;
  };
  assert.equal(put('old-one', 'xx-1', [rec(1), rec(2)]).schema, 1);
  assert.equal(put('old-two', 'xx-2', [rec(1, { bearing: 45 })]).schema, 2);
  // This run writes a third file: schema 2 because one record has a bearing.
  const result = await buildSnapshotDir({ outDir, env: ENV, now: () => GENERATED_AT,
    providers: [testProvider([rec(1, { bearing: 180 }), rec(2)])] });
  assert.equal(result.providers[0].written, true);
  const rows = readJson(join(outDir, 'index.json')).files;
  assert.deepEqual(rows.map((r) => r.file), ['old-one/xx-1.json', 'old-two/xx-2.json', 'test-dot/ca-d99.json']);
  assert.deepEqual(rows.map((r) => r.count), [2, 1, 2]);
  assert.equal(readJson(join(outDir, 'test-dot/ca-d99.json')).schema, 2);
  assert.equal(readJson(join(outDir, 'old-one/xx-1.json')).schema, 1);
  for (const r of rows) assert.deepEqual(snapshotProblems(readJson(join(outDir, r.file))), [], r.file);
});

test('builder: a file whose stills have all expired is kept and marked stale in the index, not dropped', async () => {
  const outDir = tmpDir();
  const expiring = [rec(1, { validUntil: '2026-10-04T12:30:00.000Z' }), rec(2, { validUntil: '2026-10-04T13:00:00.000Z' })];
  await buildSnapshotDir({ outDir, env: ENV, now: () => GENERATED_AT, providers: [testProvider(expiring)] });
  let row = readJson(join(outDir, 'index.json')).files[0];
  assert.equal('stale' in row, false, 'fresh at build time: no stale key at all');
  const LATER = '2026-10-04T18:00:00.000Z';
  await buildSnapshotDir({ outDir, env: ENV, now: () => LATER, providers: [testProvider(expiring)] });
  const index = readJson(join(outDir, 'index.json'));
  assert.equal(index.schema, 1);
  assert.ok(Array.isArray(index.files));
  row = index.files[0];
  assert.equal(row.stale, true);
  assert.equal(row.count, 2, 'still listed, every camera still counted');
  assert.equal(row.file, 'test-dot/ca-d99.json');
  assert.deepEqual(expandSnapshot(readJson(join(outDir, row.file)), { now: Date.parse(LATER) }).map((r) => r.media.still), [null, null]);
});

test('builder: a stale last-good file from another provider is marked when the index is rebuilt', async () => {
  const outDir = tmpDir();
  await buildSnapshotDir({ outDir, env: ENV, now: () => GENERATED_AT,
    providers: [testProvider([rec(1, { validUntil: '2026-10-04T12:30:00.000Z' })])] });
  const other = { ...testProvider([rec(1)]), id: 'other-dot', keyEnv: 'OTHER_KEY' };
  other.regions = () => [{ region: 'xx-1', regionName: 'Other', records: [rec(1, { provider: 'other-dot' })] }];
  await buildSnapshotDir({ outDir, env: { ...ENV, OTHER_KEY: 'other-key-17b-bbbb' }, now: () => '2026-10-05T00:00:00.000Z',
    providers: [other] });
  const rows = readJson(join(outDir, 'index.json')).files;
  assert.deepEqual(rows.map((r) => [r.provider, r.stale === true]), [['other-dot', false], ['test-dot', true]]);
});

test('last good: a region that comes back empty keeps its schema 2 file and the index byte for byte', async () => {
  const outDir = tmpDir();
  const records = [rec(1, { bearing: 90, capturedAt: '2026-10-04T11:58:00.000Z', validUntil: '2026-10-04T12:30:00.000Z' })];
  await buildSnapshotDir({ outDir, env: ENV, now: () => GENERATED_AT, providers: [testProvider(records)] });
  const before = {
    file: readFileSync(join(outDir, 'test-dot/ca-d99.json'), 'utf8'),
    index: readFileSync(join(outDir, 'index.json'), 'utf8'),
  };
  assert.equal(JSON.parse(before.file).schema, 2);
  const result = await buildSnapshotDir({ outDir, env: ENV, now: () => '2026-10-04T20:00:00.000Z',
    providers: [testProvider([])] });
  assert.equal(result.providers[0].written, false);
  assert.match(result.providers[0].reason, /^zero-records/);
  assert.equal(readFileSync(join(outDir, 'test-dot/ca-d99.json'), 'utf8'), before.file);
  assert.equal(readFileSync(join(outDir, 'index.json'), 'utf8'), before.index);
});

test('builder: a record with a bad bearing is refused before anything is written', async () => {
  const outDir = tmpDir();
  await assert.rejects(() => buildSnapshotDir({ outDir, env: ENV, now: () => GENERATED_AT,
    providers: [testProvider([rec(1, { bearing: 400 })])] }), /bearing/);
  assert.deepEqual(readdirSync(outDir), []);
});
