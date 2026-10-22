// build-camera-snapshot.mjs: every fetch is injected, so nothing here touches the network. The
// happy-path canned response is the same real fixture source-camera.test.mjs uses
// (fixtures/nps-webcams-grsm-2026-09-27.min.json), not synthetic data.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSnapshot, fetchSnapshot, writeSnapshotOrKeepExisting, GRSM_WEBCAMS_URL }
  from './build-camera-snapshot.mjs';

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const GRSM = read('fixtures/nps-webcams-grsm-2026-09-27.min.json');
const FAKE_KEY = 'test-sentinel-key-do-not-leak-93f2';

function tmpOut(preexisting) {
  const dir = mkdtempSync(join(tmpdir(), 'qux-08c-'));
  const out = join(dir, 'nps-grsm-cameras.json');
  if (preexisting !== undefined) writeFileSync(out, preexisting);
  return out;
}

const okFetch = () => async () => ({
  ok: true,
  json: async () => GRSM,
});

test('buildSnapshot is pure: real payload in, generatedAt/source/cameras out, no network', () => {
  const snap = buildSnapshot(GRSM, { fetchedAt: '2026-09-27T20:30:00Z', source: GRSM_WEBCAMS_URL });
  assert.equal(snap.generatedAt, '2026-09-27T20:30:00Z');
  assert.equal(snap.source, GRSM_WEBCAMS_URL);
  assert.equal(snap.cameras.length, 5, 'six raw records, one duplicate id, five cameras');
});

test('fetchSnapshot: no key -- fetchImpl is never called', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => GRSM }; };
  const result = await fetchSnapshot({ apiKey: undefined, fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.reason, /^no-key/);
  assert.equal(called, false, 'a missing key must short-circuit before any fetch happens');
});

test('fetchSnapshot: fetchImpl throws -- reported, not raised', async () => {
  const fetchImpl = async () => { throw new Error('ECONNRESET (simulated)'); };
  const result = await fetchSnapshot({ apiKey: FAKE_KEY, fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.reason, /^fetch-error/);
});

test('fetchSnapshot: non-ok response -- reported, not raised', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503 });
  const result = await fetchSnapshot({ apiKey: FAKE_KEY, fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.reason, /^fetch-error/);
  assert.match(result.reason, /503/);
});

test('fetchSnapshot: zero normalized records -- refuses to publish an empty catalogue', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ total: '0', limit: '50', start: '0', data: [] }) });
  const result = await fetchSnapshot({ apiKey: FAKE_KEY, fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.reason, /^zero-records/);
});

test('fetchSnapshot: happy path normalizes the real fixture to 5 cameras', async () => {
  const result = await fetchSnapshot({ apiKey: FAKE_KEY, fetchImpl: okFetch() });
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.cameras.length, 5);
  assert.ok(result.snapshot.generatedAt);
  assert.equal(result.snapshot.source, GRSM_WEBCAMS_URL);
});

test('fetchSnapshot: the api key never appears in the snapshot, even serialized', async () => {
  const result = await fetchSnapshot({ apiKey: FAKE_KEY, fetchImpl: okFetch() });
  assert.equal(result.ok, true);
  assert.doesNotMatch(JSON.stringify(result.snapshot), new RegExp(FAKE_KEY));
});

test('writeSnapshotOrKeepExisting requires an explicit --out target', async () => {
  await assert.rejects(() => writeSnapshotOrKeepExisting({ apiKey: FAKE_KEY, fetchImpl: okFetch() }));
});

test('writeSnapshotOrKeepExisting: no key, no pre-existing file -- writes nothing at all', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qux-08c-'));
  const out = join(dir, 'nps-grsm-cameras.json');
  let called = false;
  const result = await writeSnapshotOrKeepExisting({
    out, apiKey: undefined, fetchImpl: async () => { called = true; },
  });
  assert.equal(result.written, false);
  assert.equal(called, false);
  assert.equal(existsSync(out), false, 'no key means no file is ever created');
  rmSync(dir, { recursive: true, force: true });
});

test('writeSnapshotOrKeepExisting: no key, a pre-existing file -- left byte-identical', async () => {
  const existing = '{"generatedAt":"2026-09-01T00:00:00Z","source":"stale","cameras":[]}';
  const out = tmpOut(existing);
  const result = await writeSnapshotOrKeepExisting({ out, apiKey: undefined, fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.equal(result.written, false);
  assert.equal(readFileSync(out, 'utf8'), existing);
});

test('writeSnapshotOrKeepExisting: fetch throws -- the pre-existing file survives untouched', async () => {
  const existing = '{"generatedAt":"2026-09-01T00:00:00Z","source":"stale","cameras":[{"providerId":"x"}]}';
  const out = tmpOut(existing);
  const fetchImpl = async () => { throw new Error('DNS failure (simulated)'); };
  const result = await writeSnapshotOrKeepExisting({ out, apiKey: FAKE_KEY, fetchImpl });
  assert.equal(result.written, false);
  assert.match(result.reason, /^fetch-error/);
  assert.equal(readFileSync(out, 'utf8'), existing);
});

test('writeSnapshotOrKeepExisting: zero-record response -- the pre-existing catalogue survives', async () => {
  const existing = '{"generatedAt":"2026-09-01T00:00:00Z","source":"stale","cameras":[{"providerId":"x"}]}';
  const out = tmpOut(existing);
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [] }) });
  const result = await writeSnapshotOrKeepExisting({ out, apiKey: FAKE_KEY, fetchImpl });
  assert.equal(result.written, false);
  assert.match(result.reason, /^zero-records/);
  assert.equal(readFileSync(out, 'utf8'), existing);
});

test('writeSnapshotOrKeepExisting: happy path writes 5 cameras and generatedAt/source', async () => {
  const out = tmpOut();
  const result = await writeSnapshotOrKeepExisting({ out, apiKey: FAKE_KEY, fetchImpl: okFetch() });
  assert.equal(result.written, true);
  assert.equal(result.cameraCount, 5);
  const written = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(written.cameras.length, 5);
  assert.ok(written.generatedAt);
  assert.equal(written.source, GRSM_WEBCAMS_URL);
});

test('writeSnapshotOrKeepExisting: happy path overwrites a pre-existing (stale) file', async () => {
  const existing = '{"generatedAt":"2026-09-01T00:00:00Z","source":"stale","cameras":[]}';
  const out = tmpOut(existing);
  const result = await writeSnapshotOrKeepExisting({ out, apiKey: FAKE_KEY, fetchImpl: okFetch() });
  assert.equal(result.written, true);
  const written = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(written.cameras.length, 5);
  assert.notEqual(readFileSync(out, 'utf8'), existing);
});

test('writeSnapshotOrKeepExisting: the api key never lands in the written file, even as bytes', async () => {
  const out = tmpOut();
  await writeSnapshotOrKeepExisting({ out, apiKey: FAKE_KEY, fetchImpl: okFetch() });
  const bytes = readFileSync(out, 'utf8');
  assert.doesNotMatch(bytes, new RegExp(FAKE_KEY));
});

// QUX-08D-ii spec 2.6: the committed seed under static/ is not hand-written -- it is this exact
// formula's output, byte-equal, so a reader (or CI) can always regenerate and diff it rather than
// trust that nobody edited the JSON by hand after the fact.
test('the committed seed is byte-equal to buildSnapshot(fixture, { fetchedAt }) at the pinned capture time', () => {
  const seedPath = new URL('../../static/data/quiet-corners-maps/cameras-nps-grsm.json', import.meta.url);
  // No trailing newline: this is the exact string writeSnapshotOrKeepExisting's own
  // `JSON.stringify(result.snapshot, null, 2)` + `writeFileSync` produces (:75-82) -- the seed is
  // byte-equal to what the build step itself would write, not a hand-formatted copy.
  const expected = JSON.stringify(buildSnapshot(GRSM, { fetchedAt: '2026-09-27T18:34:30.000Z' }), null, 2);
  assert.equal(readFileSync(seedPath, 'utf8'), expected);
});

// ---------------------------------------------------------------------------------------------
// camera U2: `--out-dir` writes index.json plus one compact file per (provider, region). Every
// fetch is injected; nothing here touches the network.
import { readdirSync, statSync, mkdirSync } from 'node:fs';
import { buildSnapshotDir, PROVIDERS, BUDGETS, memoFetch, STATE_BBOX, STATE_BBOX_PAD }
  from './build-camera-snapshot.mjs';
import { expandSnapshot, snapshotProblems }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/camera-snapshot.js';
import { normalizeNpsWebcams }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/source-camera.js';

const NOW = () => '2026-10-04T12:00:00.000Z';
const tmpDir = () => mkdtempSync(join(tmpdir(), 'camera-u2-'));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const listFiles = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile()).map((e) => join(e.parentPath ?? e.path, e.name).slice(dir.length + 1)).sort();

// A synthetic second provider (its own key, its own regions) so the table is exercised as a table.
const rec = (provider, i, lat, lon) => Object.freeze({
  provider, providerId: `${provider}-${i}`, name: `Camera ${i}`, lat, lon,
  locationPrecision: lat === null || lon === null ? null : 'exact', category: 'road',
  operator: 'Test DOT', officialUrl: 'https://example.test/cams', subject: null, bearing: null,
  media: { still: `https://example.test/${provider}/${i}.jpg`, stream: null, streamKind: null },
  capturedAt: null, fetchedAt: '2026-10-04T12:00:00.000Z', validUntil: null, rights: 'unverified',
  attribution: 'Test DOT', health: 'active',
});
const testProvider = (over = {}) => ({
  id: 'test-dot', layer: 'roadCameras', keyEnv: 'TEST_DOT_KEY', source: 'https://example.test/cams.json',
  officialUrl: 'https://example.test/cams',
  async fetch({ env }) {
    if (!env.TEST_DOT_KEY) return { ok: false, reason: 'no-key: TEST_DOT_KEY is not set' };
    return { ok: true, payload: { cams: over.cams || [[36, -122], [37, -121]] } };
  },
  regions(payload) {
    return [{ region: 'ca-d99', regionName: 'Test District',
      records: payload.cams.map(([la, lo], i) => rec('test-dot', i, la, lo)) }];
  },
  ...over,
});
const nps = () => PROVIDERS.find((p) => p.id === 'nps-webcams');
const npsFetch = async () => ({ ok: true, json: async () => GRSM });
const ENV = { NPS_API_KEY: FAKE_KEY };

test('PROVIDERS: nps-webcams is a table entry with a layer, a key env var, fetch and regions', () => {
  const p = nps();
  assert.equal(p.layer, 'parkCameras');
  assert.equal(p.keyEnv, 'NPS_API_KEY');
  assert.equal(typeof p.fetch, 'function');
  assert.equal(typeof p.regions, 'function');
});

test('--out-dir: writes index.json plus one compact file per (provider, region)', async () => {
  const outDir = tmpDir();
  const result = await buildSnapshotDir({ outDir, env: ENV, fetchImpl: npsFetch, now: NOW });
  assert.equal(result.providers.find((p) => p.id === 'nps-webcams').written, true);
  assert.deepEqual(listFiles(outDir), ['index.json', 'nps-webcams/nps-nc.json']);
  const file = readJson(join(outDir, 'nps-webcams/nps-nc.json'));
  assert.deepEqual(snapshotProblems(file), []);
  assert.equal(file.generatedAt, '2026-10-04T12:00:00.000Z');
  // The directory carries the nationwide provider's records: the located ones only (a pin needs a
  // position), under the provider id and operator the nationwide file uses.
  assert.deepEqual(expandSnapshot(file),
    normalizeNpsWebcams(GRSM, { fetchedAt: file.generatedAt, provider: 'nps-webcams', operator: 'National Park Service' })
      .filter((r) => r.lat !== null && r.lon !== null));
  const index = readJson(join(outDir, 'index.json'));
  assert.equal(index.schema, 1);
  assert.equal(index.files.length, 1);
  const row = index.files[0];
  assert.deepEqual(Object.keys(row).sort(),
    ['bbox', 'count', 'file', 'generatedAt', 'layer', 'provider', 'region', 'regionName']);
  assert.equal(row.file, 'nps-webcams/nps-nc.json');
  assert.equal(row.layer, 'parkCameras');
  assert.equal(row.count, 3);
  assert.equal(row.generatedAt, file.generatedAt);
  // bbox covers the three located cameras; the unlocated ones are not published.
  assert.ok(row.bbox.minLat > 35 && row.bbox.maxLat < 36 && row.bbox.minLon < -83 && row.bbox.maxLon > -85);
});

test('--out-dir: a second provider with its own key gets its own files and index row', async () => {
  const outDir = tmpDir();
  const result = await buildSnapshotDir({
    outDir, env: { ...ENV, TEST_DOT_KEY: 'other-key-aaaa-1111' }, now: NOW,
    providers: [nps(), testProvider()], fetchImpl: npsFetch,
  });
  assert.deepEqual(result.providers.map((p) => p.written), [true, true]);
  assert.deepEqual(listFiles(outDir), ['index.json', 'nps-webcams/nps-nc.json', 'test-dot/ca-d99.json']);
  const rows = readJson(join(outDir, 'index.json')).files;
  assert.deepEqual(rows.map((r) => r.provider), ['nps-webcams', 'test-dot']);
});

test('--out-dir: a provider that fails leaves its existing files and its index row alone', async () => {
  const outDir = tmpDir();
  await buildSnapshotDir({ outDir, env: { ...ENV, TEST_DOT_KEY: 'other-key-aaaa-1111' }, now: NOW,
    providers: [nps(), testProvider()], fetchImpl: npsFetch });
  const before = {
    nps: readFileSync(join(outDir, 'nps-webcams/nps-nc.json'), 'utf8'),
    index: readFileSync(join(outDir, 'index.json'), 'utf8'),
  };
  // NPS now answers 503; the other provider has no key and also fails: nothing may change.
  const result = await buildSnapshotDir({ outDir, env: ENV, now: NOW,
    providers: [nps(), testProvider()], fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.deepEqual(result.providers.map((p) => p.written), [false, false]);
  assert.match(result.providers[0].reason, /^fetch-error/);
  assert.match(result.providers[1].reason, /^no-key/);
  assert.equal(readFileSync(join(outDir, 'nps-webcams/nps-nc.json'), 'utf8'), before.nps);
  assert.equal(readFileSync(join(outDir, 'index.json'), 'utf8'), before.index);
  assert.equal(listFiles(outDir).length, 3);
});

test('--out-dir: one provider failing does not stop the other from refreshing', async () => {
  const outDir = tmpDir();
  const result = await buildSnapshotDir({ outDir, env: { TEST_DOT_KEY: 'other-key-aaaa-1111' }, now: NOW,
    providers: [nps(), testProvider()], fetchImpl: npsFetch });
  assert.deepEqual(result.providers.map((p) => p.written), [false, true]);
  assert.deepEqual(listFiles(outDir), ['index.json', 'test-dot/ca-d99.json']);
  assert.equal(readJson(join(outDir, 'index.json')).files.length, 1);
});

test('--out-dir: index.json is rebuilt from every file on disk, including a provider not in this run', async () => {
  const outDir = tmpDir();
  await buildSnapshotDir({ outDir, env: { TEST_DOT_KEY: 'other-key-aaaa-1111' }, now: NOW,
    providers: [testProvider()], fetchImpl: npsFetch });
  await buildSnapshotDir({ outDir, env: ENV, now: NOW, providers: [nps()], fetchImpl: npsFetch });
  const rows = readJson(join(outDir, 'index.json')).files;
  assert.deepEqual(rows.map((r) => r.provider).sort(), ['nps-webcams', 'test-dot']);
});

test('--out-dir: a region that normalizes to zero records keeps its existing file', async () => {
  const outDir = tmpDir();
  const env = { TEST_DOT_KEY: 'other-key-aaaa-1111' };
  await buildSnapshotDir({ outDir, env, now: NOW, providers: [testProvider()] });
  const before = readFileSync(join(outDir, 'test-dot/ca-d99.json'), 'utf8');
  const result = await buildSnapshotDir({ outDir, env, now: NOW, providers: [testProvider({ cams: [] })] });
  assert.equal(result.providers[0].written, false);
  assert.match(result.providers[0].reason, /^zero-records/);
  assert.equal(readFileSync(join(outDir, 'test-dot/ca-d99.json'), 'utf8'), before);
});

test('--out-dir: refuses to write ANY file when any provider key appears in any output', async () => {
  const OTHER = 'other-key-aaaa-1111';
  const env = { ...ENV, TEST_DOT_KEY: OTHER };
  // The NPS records are clean; the OTHER provider's camera name carries the NPS key.
  const leaky = testProvider({
    regions: () => [{ region: 'ca-d99', regionName: 'Test', records: [rec('test-dot', 1, 36, -122)]
      .map((r) => ({ ...r, name: `leaks ${FAKE_KEY}` })) }],
  });
  const outDir = tmpDir();
  await assert.rejects(
    () => buildSnapshotDir({ outDir, env, now: NOW, providers: [nps(), leaky], fetchImpl: npsFetch }),
    /key/);
  assert.deepEqual(listFiles(outDir), [], 'a leak aborts before the first write, clean providers included');
  // And the reverse direction: the NPS data carries the OTHER provider's key.
  const outDir2 = tmpDir();
  const leakyNps = { ...nps(), regions: (p, o) => nps().regions(p, o).map((reg) => ({ ...reg,
    records: reg.records.map((r) => ({ ...r, subject: `x ${OTHER} y` })) })) };
  await assert.rejects(
    () => buildSnapshotDir({ outDir: outDir2, env, now: NOW, providers: [leakyNps, testProvider()], fetchImpl: npsFetch }),
    /key/);
  assert.deepEqual(listFiles(outDir2), []);
});

test('--out-dir: no written file or the index contains a key, even as bytes', async () => {
  const outDir = tmpDir();
  await buildSnapshotDir({ outDir, env: { ...ENV, TEST_DOT_KEY: 'other-key-aaaa-1111' }, now: NOW,
    providers: [nps(), testProvider()], fetchImpl: npsFetch });
  for (const f of listFiles(outDir)) {
    const bytes = readFileSync(join(outDir, f), 'utf8');
    assert.ok(!bytes.includes(FAKE_KEY) && !bytes.includes('other-key-aaaa-1111'), f);
  }
});

test('--out-dir: the written files are minified single-line JSON', async () => {
  const outDir = tmpDir();
  await buildSnapshotDir({ outDir, env: ENV, now: NOW, fetchImpl: npsFetch });
  for (const f of listFiles(outDir)) {
    const bytes = readFileSync(join(outDir, f), 'utf8');
    assert.ok(!bytes.includes('\n'), `${f} must be one line`);
  }
});

test('size budgets are pinned: 256 KB per file, 24 KB index, 4 MB directory', () => {
  assert.deepEqual(BUDGETS, { fileBytes: 256 * 1024, indexBytes: 24 * 1024, dirBytes: 4 * 1024 * 1024 });
});

test('--out-dir: a region over the file budget splits by a 2 degree grid instead of failing', async () => {
  const outDir = tmpDir();
  const cams = [[36.5, -121.5], [36.9, -121.1], [38.5, -121.5], [38.2, -121.9], [36.5, -119.5], [null, null]];
  const result = await buildSnapshotDir({ outDir, env: { TEST_DOT_KEY: 'other-key-aaaa-1111' }, now: NOW,
    budgets: { ...BUDGETS, fileBytes: 700 }, providers: [testProvider({ cams })] });
  assert.equal(result.providers[0].written, true);
  const files = listFiles(outDir).filter((f) => f !== 'index.json');
  assert.ok(files.length >= 3, `expected a split, got ${files.join(',')}`);
  let total = 0;
  for (const f of files) {
    assert.ok(statSync(join(outDir, f)).size <= 700, `${f} is over budget`);
    const file = readJson(join(outDir, f));
    assert.deepEqual(snapshotProblems(file), []);
    assert.equal(file.region, 'ca-d99');
    total += file.rows.length;
  }
  assert.equal(total, cams.length, 'no camera is lost or duplicated by the split');
  const rows = readJson(join(outDir, 'index.json')).files;
  assert.equal(rows.length, files.length);
  assert.equal(rows.reduce((n, r) => n + r.count, 0), cams.length);
  // A later run that no longer needs the split replaces the cells rather than duplicating them.
  await buildSnapshotDir({ outDir, env: { TEST_DOT_KEY: 'other-key-aaaa-1111' }, now: NOW,
    providers: [testProvider({ cams })] });
  assert.deepEqual(listFiles(outDir), ['index.json', 'test-dot/ca-d99.json']);
  assert.equal(readJson(join(outDir, 'index.json')).files.length, 1);
});

test('--out-dir: a provider over the directory or index budget fails soft and leaves the old files', async () => {
  const outDir = tmpDir();
  const env = { TEST_DOT_KEY: 'other-key-aaaa-1111' };
  await buildSnapshotDir({ outDir, env, now: NOW, providers: [testProvider()] });
  const before = readFileSync(join(outDir, 'test-dot/ca-d99.json'), 'utf8');
  const big = [[36, -122], [37, -121], [38, -120]];
  for (const budgets of [{ ...BUDGETS, dirBytes: 500 }, { ...BUDGETS, indexBytes: 50 }]) {
    const result = await buildSnapshotDir({ outDir, env, now: NOW, budgets, providers: [testProvider({ cams: big })] });
    assert.equal(result.providers[0].written, false);
    assert.match(result.providers[0].reason, /^over-budget/);
    assert.equal(readFileSync(join(outDir, 'test-dot/ca-d99.json'), 'utf8'), before);
  }
});

test('--out-dir: a provider or region id that is not a plain slug cannot escape the directory', async () => {
  const outDir = tmpDir();
  const env = { TEST_DOT_KEY: 'other-key-aaaa-1111' };
  const evil = testProvider({ regions: () => [{ region: '../escape', regionName: 'x', records: [rec('test-dot', 1, 36, -122)] }] });
  await assert.rejects(() => buildSnapshotDir({ outDir, env, now: NOW, providers: [evil] }), /region/);
  await assert.rejects(() => buildSnapshotDir({ outDir, env, now: NOW, providers: [testProvider({ id: 'a/b' })] }), /provider/);
});

test('memoFetch: one network call per URL, every caller gets the parsed body', async () => {
  let calls = 0;
  const wrapped = memoFetch(async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ a: 1 }) }; });
  const [a, b] = [await wrapped('https://x.test/1'), await wrapped('https://x.test/1')];
  assert.deepEqual([await a.json(), await b.json()], [{ a: 1 }, { a: 1 }]);
  assert.equal(calls, 1);
  await wrapped('https://x.test/2');
  assert.equal(calls, 2);
});

// The committed seeds under static/ are minified single-line files a build refreshes. They are
// not byte-equal to any fixture once a keyed build has refreshed them, so the contract is the
// shape, the bounds and the budget -- not equality with five recorded cameras.
test('the committed directory seeds parse, pass the shape check, stay in their bbox and in budget', () => {
  const dir = new URL('../../static/data/quiet-corners-maps/cameras/', import.meta.url);
  const dirPath = dir.pathname;
  const index = readJson(join(dirPath, 'index.json'));
  assert.equal(index.schema, 1);
  assert.ok(index.files.length >= 1);
  assert.ok(statSync(join(dirPath, 'index.json')).size <= BUDGETS.indexBytes);
  let total = statSync(join(dirPath, 'index.json')).size;
  for (const row of index.files) {
    const path = join(dirPath, row.file);
    const bytes = readFileSync(path, 'utf8');
    assert.ok(!bytes.includes('\n'), `${row.file} is minified to one line`);
    assert.ok(bytes.length <= BUDGETS.fileBytes, `${row.file} is over the file budget`);
    total += statSync(path).size;
    const file = JSON.parse(bytes);
    assert.deepEqual(snapshotProblems(file), [], row.file);
    assert.equal(row.count, file.rows.length);
    assert.equal(row.provider, file.provider);
    assert.equal(row.region, file.region);
    assert.equal(row.generatedAt, file.generatedAt);
    for (const cam of expandSnapshot(file)) {
      if (cam.lat === null || cam.lon === null) continue;
      assert.ok(cam.lat >= row.bbox.minLat && cam.lat <= row.bbox.maxLat
        && cam.lon >= row.bbox.minLon && cam.lon <= row.bbox.maxLon, `${cam.providerId} is outside ${row.file}'s bbox`);
    }
  }
  assert.ok(total <= BUDGETS.dirBytes);
  assert.equal(index.files.find((r) => r.provider === 'nps-webcams').layer, 'parkCameras');
});

test('the legacy --out file is still produced for the browser that reads it today', async () => {
  // Same module, same fetch: both outputs from one run, byte-identical legacy shape.
  const out = tmpOut();
  const outDir = tmpDir();
  const wrapped = memoFetch(npsFetch);
  const legacy = await writeSnapshotOrKeepExisting({ out, apiKey: FAKE_KEY, fetchImpl: wrapped });
  const dirResult = await buildSnapshotDir({ outDir, env: ENV, fetchImpl: wrapped, now: NOW });
  assert.equal(legacy.written, true);
  assert.equal(dirResult.providers[0].written, true);
  assert.equal(readJson(out).cameras.length, 5);
});

// ---------------------------------------------------------------------------------------------
// camera U3: Caltrans, all 12 districts, one file per district, fail-soft per district.
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { normalizeCaltransDistrict }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/source-camera.js';

const CAL_DISTRICTS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
const CAL = Object.fromEntries(CAL_DISTRICTS.map((nn) => [nn, read(`fixtures/caltrans-cctv-d${nn}-2026-10-04.min.json`)]));
const calProvider = () => PROVIDERS.find((p) => p.id === 'caltrans-cwwp2');
const urlOf = (nn) => `https://cwwp2.dot.ca.gov/data/d${Number(nn)}/cctv/cctvStatusD${nn}.json`;
const calFetch = (down = []) => async (url) => {
  const nn = CAL_DISTRICTS.find((n) => urlOf(n) === url);
  if (!nn) return { ok: false, status: 404 };
  if (down.includes(nn)) return { ok: false, status: 503 };
  return { ok: true, json: async () => CAL[nn] };
};
const calFiles = CAL_DISTRICTS.map((nn) => `caltrans-cwwp2/ca-d${nn}.json`);

test('PROVIDERS: caltrans-cwwp2 is a keyless table entry on the roadCameras layer, one URL per district', () => {
  const p = calProvider();
  assert.ok(p, 'the table has a Caltrans row');
  assert.equal(p.layer, 'roadCameras');
  assert.equal(p.keyEnv, undefined);
  assert.equal(typeof p.fetch, 'function');
  assert.equal(SOURCES.caltransCctv.serviceUrls.length, 12);
  assert.deepEqual(CAL_DISTRICTS.map(urlOf), SOURCES.caltransCctv.serviceUrls);
});

test('--out-dir: the Caltrans provider writes one file per district plus an index row each', async () => {
  const outDir = tmpDir();
  const result = await buildSnapshotDir({ outDir, env: {}, fetchImpl: calFetch(), now: NOW, providers: [calProvider()] });
  assert.equal(result.providers[0].written, true);
  assert.deepEqual(listFiles(outDir), [...calFiles, 'index.json']);
  for (const nn of CAL_DISTRICTS) {
    const file = readJson(join(outDir, `caltrans-cwwp2/ca-d${nn}.json`));
    assert.deepEqual(snapshotProblems(file), []);
    assert.equal(file.region, `ca-d${nn}`);
    assert.equal(file.layer, 'roadCameras');
    assert.equal(file.provider, 'caltrans-cwwp2');
    const records = expandSnapshot(file);
    assert.equal(records.length, CAL[nn].data.length);
    assert.ok(records.every((r) => r.providerId.startsWith(`d${nn}:`)));
    // What the browser will expand is exactly what the adapter produced (minus the build-only region).
    const adapted = normalizeCaltransDistrict(CAL[nn], nn, { fetchedAt: file.generatedAt })
      .map(({ region, ...rest }) => ({ ...rest, media: { ...rest.media, stream: null, streamKind: null } }));
    assert.deepEqual(records.map(({ media, ...r }) => r), adapted.map(({ media, ...r }) => r));
  }
  const rows = readJson(join(outDir, 'index.json')).files;
  assert.deepEqual(rows.map((r) => r.region), CAL_DISTRICTS.map((nn) => `ca-d${nn}`));
  assert.ok(rows.every((r) => r.layer === 'roadCameras' && r.count > 0 && r.bbox));
});

test('--out-dir: a district that fails keeps its old file; the other eleven still refresh', async () => {
  const outDir = tmpDir();
  await buildSnapshotDir({ outDir, env: {}, fetchImpl: calFetch(), now: NOW, providers: [calProvider()] });
  const before = Object.fromEntries(calFiles.map((f) => [f, readFileSync(join(outDir, f), 'utf8')]));
  const later = () => '2026-10-05T12:00:00.000Z';
  const result = await buildSnapshotDir({ outDir, env: {}, fetchImpl: calFetch(['04']), now: later, providers: [calProvider()] });
  assert.equal(result.providers[0].written, true, 'eleven districts answered');
  assert.match(result.providers[0].warnings.join('\n'), /ca-d04.*503/);
  assert.equal(readFileSync(join(outDir, 'caltrans-cwwp2/ca-d04.json'), 'utf8'), before['caltrans-cwwp2/ca-d04.json']);
  for (const f of calFiles.filter((x) => !x.endsWith('ca-d04.json'))) {
    assert.match(readFileSync(join(outDir, f), 'utf8'), /"generatedAt":"2026-10-05T12:00:00.000Z"/, f);
  }
  const rows = readJson(join(outDir, 'index.json')).files;
  assert.equal(rows.length, 12, 'the failed district keeps its index row');
  assert.equal(rows.find((r) => r.region === 'ca-d04').generatedAt, '2026-10-04T12:00:00.000Z');
});

test('--out-dir: every district failing leaves the directory untouched and says why', async () => {
  const outDir = tmpDir();
  await buildSnapshotDir({ outDir, env: {}, fetchImpl: calFetch(), now: NOW, providers: [calProvider()] });
  const before = readFileSync(join(outDir, 'index.json'), 'utf8');
  const result = await buildSnapshotDir({ outDir, env: {}, fetchImpl: calFetch(CAL_DISTRICTS), now: NOW, providers: [calProvider()] });
  assert.equal(result.providers[0].written, false);
  assert.match(result.providers[0].reason, /^fetch-error/);
  assert.equal(readFileSync(join(outDir, 'index.json'), 'utf8'), before);
  assert.equal(listFiles(outDir).length, 13);
});

test('--out-dir: a district that answers with a feed of no cameras keeps its old file', async () => {
  const outDir = tmpDir();
  await buildSnapshotDir({ outDir, env: {}, fetchImpl: calFetch(), now: NOW, providers: [calProvider()] });
  const before = readFileSync(join(outDir, 'caltrans-cwwp2/ca-d09.json'), 'utf8');
  const empty = async (url) => (url === urlOf('09')
    ? { ok: true, json: async () => ({ data: [] }) } : calFetch()(url));
  await buildSnapshotDir({ outDir, env: {}, fetchImpl: empty, now: () => '2026-10-05T12:00:00.000Z', providers: [calProvider()] });
  assert.equal(readFileSync(join(outDir, 'caltrans-cwwp2/ca-d09.json'), 'utf8'), before);
});

test('the committed Caltrans seeds: 12 districts, in budget, every located camera inside its index bbox', () => {
  const dirPath = new URL('../../static/data/quiet-corners-maps/cameras/', import.meta.url).pathname;
  const rows = readJson(join(dirPath, 'index.json')).files.filter((r) => r.provider === 'caltrans-cwwp2');
  assert.deepEqual(rows.map((r) => r.region), CAL_DISTRICTS.map((nn) => `ca-d${nn}`));
  for (const row of rows) {
    const nn = row.region.slice(4);
    assert.equal(row.layer, 'roadCameras');
    assert.equal(row.file, `caltrans-cwwp2/ca-d${nn}.json`);
    const file = readJson(join(dirPath, row.file));
    assert.ok(expandSnapshot(file).every((c) => c.providerId.startsWith(`d${nn}:`)), row.file);
  }
});

// ---------------------------------------------------------------------------------------------
// camera U5: NPS nationwide (`nps-webcams`). The key is NOT available when this was written, so
// the pages below are SYNTHETIC: they reuse the field names and the envelope of the real GRSM
// recording (total/limit/start as strings, data[], relatedParks[], the doubled-host images[]) and
// invent only the park, state, position and id of each camera. Nothing synthetic is committed as
// a seed. What stays unverified until a keyed run: the real paging behaviour past the default
// limit of 50 (the recording shows limit "50", start "0"), the real located-record count, and
// which parks' pages carry a stillimage.
const PARKS = [['yose', 'Yosemite National Park', 'CA', 37.8, -119.5], ['zion', 'Zion National Park', 'UT', 37.3, -113],
  ['acad', 'Acadia National Park', 'ME', 44.35, -68.2], ['yell', 'Yellowstone National Park', 'ID,MT,WY', 44.6, -110.5],
  ['pore', 'Point Reyes National Seashore', 'CA', 38.1, -122.9]];
const synthCam = (i, over = {}) => {
  const [parkCode, fullName, states, lat, lon] = PARKS[i % PARKS.length];
  return {
    id: `SYNTH-${String(i).padStart(4, '0')}`, url: `https://www.nps.gov/media/webcam/view.htm?id=SYNTH-${i}`,
    title: `${fullName} cam ${i}`, description: 'Visit webcam page for current view.',
    images: [{ url: `https://www.nps.govhttps://www.nps.gov/common/uploads/cropped_image/SYNTH-${i}.jpg`, credit: '' }],
    relatedParks: [{ states, parkCode, designation: 'National Park', fullName }],
    status: 'Active', isStreaming: false, latitude: String(lat + i / 1000), longitude: String(lon - i / 1000),
    credit: '', ...over,
  };
};
const synthAll = (n) => Array.from({ length: n }, (_, i) => synthCam(i));
/** A fake developer.nps.gov that pages like the recorded envelope: `limit`/`start` honored, `total` a string. */
const pagedNps = (all, { calls = [], failAt = null, headStatus = {} } = {}) => async (url, init = {}) => {
  calls.push({ url, method: init.method || 'GET' });
  if (init.method === 'HEAD') {
    const status = headStatus[url];
    if (status instanceof Error) throw status;
    return { ok: !status || status < 400, status: status || 200 };
  }
  const u = new URL(url);
  const limit = Number(u.searchParams.get('limit') || 50), start = Number(u.searchParams.get('start') || 0);
  if (failAt !== null && start === failAt) return { ok: false, status: 503 };
  return { ok: true, status: 200, json: async () => ({ total: String(all.length), limit: String(limit), start: String(start),
    data: all.slice(start, start + limit) }) };
};
const npsRun = async (all, opts = {}, outDir = tmpDir()) => {
  const calls = [];
  const result = await buildSnapshotDir({ outDir, env: ENV, now: NOW, providers: [nps()],
    fetchImpl: pagedNps(all, { calls, ...opts }) });
  return { outDir, calls, result };
};
const npsRecords = (outDir) => listFiles(outDir).filter((f) => f.startsWith('nps-webcams/'))
  .flatMap((f) => expandSnapshot(readJson(join(outDir, f))));

test('U5 nps-webcams: pages by limit/start until total, one request per page, key only in the URL', async () => {
  const { calls, result, outDir } = await npsRun(synthAll(120));
  const gets = calls.filter((c) => c.method === 'GET');
  assert.deepEqual(gets.map((c) => new URL(c.url).searchParams.get('start')), ['0', '50', '100']);
  assert.ok(gets.every((c) => new URL(c.url).searchParams.get('limit') === '50'));
  assert.ok(gets.every((c) => new URL(c.url).searchParams.get('api_key') === FAKE_KEY));
  assert.ok(!gets.some((c) => c.url.includes('parkCode')), 'nationwide: no parkCode filter');
  assert.equal(result.providers[0].written, true);
  assert.equal(npsRecords(outDir).length, 120);
});

test('U5 nps-webcams: one file per state, a multi-state park filed under its first state', async () => {
  const { outDir } = await npsRun(synthAll(10));
  assert.deepEqual(listFiles(outDir), ['index.json', 'nps-webcams/nps-ca.json', 'nps-webcams/nps-id.json',
    'nps-webcams/nps-me.json', 'nps-webcams/nps-ut.json']);
  const ca = readJson(join(outDir, 'nps-webcams/nps-ca.json'));
  assert.equal(ca.regionName, 'California');
  assert.equal(ca.operator, 'National Park Service');
  assert.deepEqual(snapshotProblems(ca), []);
  assert.deepEqual(readJson(join(outDir, 'index.json')).files.map((r) => r.region), ['nps-ca', 'nps-id', 'nps-me', 'nps-ut']);
});

test('U5 nps-webcams: a page that fails leaves every existing file alone (fail-soft, never a partial catalogue)', async () => {
  const first = await npsRun(synthAll(120));
  const before = Object.fromEntries(listFiles(first.outDir).map((f) => [f, readFileSync(join(first.outDir, f), 'utf8')]));
  const second = await npsRun(synthAll(120).slice(0, 119), { failAt: 50 }, first.outDir);
  assert.equal(second.result.providers[0].written, false);
  assert.match(second.result.providers[0].reason, /fetch-error/);
  assert.deepEqual(Object.fromEntries(listFiles(first.outDir).map((f) => [f, readFileSync(join(first.outDir, f), 'utf8')])), before);
});

test('U5 nps-webcams: no key means no request and the committed seeds are kept', async () => {
  const outDir = tmpDir();
  const calls = [];
  const result = await buildSnapshotDir({ outDir, env: {}, now: NOW, providers: [nps()], fetchImpl: pagedNps(synthAll(5), { calls }) });
  assert.equal(result.providers[0].written, false);
  assert.match(result.providers[0].reason, /^no-key/);
  assert.deepEqual(calls, []);
  assert.deepEqual(listFiles(outDir), []);
});

test('U5 nps-webcams: records without a position are not published, repeated ids are published once', async () => {
  const all = [...synthAll(4), synthCam(900, { latitude: '', longitude: '' }), synthCam(901, { latitude: null, longitude: null }), synthCam(2)];
  const { outDir } = await npsRun(all);
  const recs = npsRecords(outDir);
  assert.deepEqual(recs.map((r) => r.providerId).sort(), ['SYNTH-0000', 'SYNTH-0001', 'SYNTH-0002', 'SYNTH-0003']);
  assert.ok(recs.every((r) => r.lat !== null && r.lon !== null));
});

test('U5 nps-webcams: an unmapped camera is link-only (still null) and never falls back to images[].url', async () => {
  const { outDir } = await npsRun(synthAll(30));
  const recs = npsRecords(outDir);
  assert.equal(recs.length, 30);
  assert.ok(recs.every((r) => r.media.still === null));
  for (const f of listFiles(outDir)) assert.ok(!readFileSync(join(outDir, f), 'utf8').includes('cropped_image'), f);
});

const LOOK_ROCK = '6878C635-B83A-8F41-A6E3B0160539BEAA';
const LOOK_ROCK_STILL = 'https://www.nps.gov/featurecontent/ard/webcams/images/grsmlarge.jpg';
const NEWFOUND = 'C589EEEF-1DD8-B71B-0B0463C308FF64DD';
const NEWFOUND_STILL = 'https://www.nps.gov/featurecontent/ard/webcams/images/gsnglarge.jpg';
const stillsOf = (outDir) => Object.fromEntries(npsRecords(outDir).map((r) => [r.providerId, r.media.still]));

test('U5 nps-webcams: a curated still is checked with a HEAD and kept when it answers 200', async () => {
  const calls = [];
  const outDir = tmpDir();
  await buildSnapshotDir({ outDir, env: ENV, now: NOW, providers: [nps()], fetchImpl: pagedNps(GRSM.data, { calls }) });
  const heads = calls.filter((c) => c.method === 'HEAD').map((c) => c.url).sort();
  assert.deepEqual(heads, [LOOK_ROCK_STILL, NEWFOUND_STILL, 'https://www.nps.gov/featurecontent/ard/webcams/images/grpklarge.jpg'].sort());
  const stills = stillsOf(outDir);
  assert.equal(stills[LOOK_ROCK], LOOK_ROCK_STILL);
  assert.equal(stills[NEWFOUND], NEWFOUND_STILL);
});

test('U5 nps-webcams: a curated still whose HEAD answers 404 is dropped to link-only; other failures keep it', async () => {
  const outDir = tmpDir();
  await buildSnapshotDir({ outDir, env: ENV, now: NOW, providers: [nps()],
    fetchImpl: pagedNps(GRSM.data, { headStatus: { [LOOK_ROCK_STILL]: 404, [NEWFOUND_STILL]: 503 } }) });
  const stills = stillsOf(outDir);
  assert.equal(stills[LOOK_ROCK], null, '404: the still is gone, the camera stays as a link-only card');
  assert.equal(stills[NEWFOUND], NEWFOUND_STILL, '503 is not proof the picture is gone');
  assert.ok(LOOK_ROCK in stills, 'the camera itself is still published');
  const outDir2 = tmpDir();
  await buildSnapshotDir({ outDir: outDir2, env: ENV, now: NOW, providers: [nps()],
    fetchImpl: pagedNps(GRSM.data, { headStatus: { [NEWFOUND_STILL]: new Error('socket hang up') } }) });
  assert.equal(stillsOf(outDir2)[NEWFOUND], NEWFOUND_STILL, 'a network error on HEAD keeps the still');
});

test('U5 nps-webcams: 251 located cameras across 27 states stay inside every budget, the index beside the Caltrans seeds included', async () => {
  const outDir = tmpDir();
  cpSync(new URL('../../static/data/quiet-corners-maps/cameras', import.meta.url), outDir, { recursive: true });
  const states = Object.keys(STATE_BBOX).slice(0, 27);
  const cams = Array.from({ length: 251 }, (_, i) => {
    const st = states[i % 27], [s, n, w, e] = STATE_BBOX[st];
    return synthCam(i, { latitude: String((s + n) / 2 + i / 10000), longitude: String((w + e) / 2 - i / 10000),
      relatedParks: [{ states: st.toUpperCase(), parkCode: `p${i % 40}`, fullName: `Park ${i % 40}` }] });
  });
  await buildSnapshotDir({ outDir, env: ENV, now: NOW, providers: [nps()], fetchImpl: pagedNps(cams) });
  const sizes = listFiles(outDir).map((f) => [f, statSync(join(outDir, f)).size]);
  for (const [f, size] of sizes.filter(([f]) => f.startsWith('nps-webcams/'))) assert.ok(size < BUDGETS.fileBytes / 2, `${f} is ${size} bytes`);
  const index = readJson(join(outDir, 'index.json'));
  assert.ok(index.files.filter((r) => r.provider === 'nps-webcams').length >= 27, 'one NPS row per state (plus the committed nc seed)');
  assert.ok(index.files.some((r) => r.provider === 'caltrans-cwwp2'), 'the Caltrans seeds are in the same index');
  // Measured 2026-10-04: ~300 bytes a row; 27 NPS state rows + Caltrans leave wave 2 about 16 rows.
  assert.ok(statSync(join(outDir, 'index.json')).size < BUDGETS.indexBytes, 'index.json is over budget');
  assert.ok(npsRecords(outDir).length >= 251, 'all 251 published (plus the committed nc seed)');
});

const IMPLAUSIBLE = read('fixtures/nps-webcams-implausible-2026-10-04.min.json');
const BAD_TITLES = ['First Fort', 'El Morro, Live!', 'Clues', 'Test', 'Question 5'];

test('U5 nps-webcams: placeholder rows and cameras filed far outside their park\'s states are never published', async () => {
  const { outDir } = await npsRun(IMPLAUSIBLE.data);
  const recs = npsRecords(outDir);
  const badIds = IMPLAUSIBLE.data.filter((r) => BAD_TITLES.includes(r.title)).map((r) => r.id);
  assert.equal(badIds.length, 5);
  assert.deepEqual(recs.filter((r) => badIds.includes(r.providerId)), [], 'a bad record was published');
  assert.equal(recs.length, IMPLAUSIBLE.data.length - 5, 'every valid record is kept');
  assert.ok(!listFiles(outDir).includes('nps-webcams/nps-other.json'), 'no park-less bucket');
  const byId = new Map(IMPLAUSIBLE.data.map((r) => [r.id, r]));
  for (const r of recs) {
    const [s, n, w, e] = STATE_BBOX[byId.get(r.providerId).relatedParks[0].states.split(',')[0].toLowerCase()];
    assert.ok(r.lat >= s - STATE_BBOX_PAD && r.lat <= n + STATE_BBOX_PAD && r.lon >= w - STATE_BBOX_PAD && r.lon <= e + STATE_BBOX_PAD, r.title);
  }
  for (const row of readJson(join(outDir, 'index.json')).files) {
    const [s, n, w, e] = STATE_BBOX[row.region.replace('nps-', '')];
    assert.ok(row.bbox.minLat >= s - STATE_BBOX_PAD && row.bbox.maxLat <= n + STATE_BBOX_PAD
      && row.bbox.minLon >= w - STATE_BBOX_PAD && row.bbox.maxLon <= e + STATE_BBOX_PAD, `${row.region} bbox is inside its state`);
  }
});

test('U5 nps-webcams: a camera with no related park is not published even with a plausible position', async () => {
  const { outDir } = await npsRun([synthCam(0), synthCam(1, { relatedParks: [] }), synthCam(2, { relatedParks: undefined })]);
  assert.deepEqual(npsRecords(outDir).map((r) => r.providerId), ['SYNTH-0000']);
});

test('U5 nps-webcams: an API that ignores `start` fails the provider instead of publishing a partial catalogue', async () => {
  const first = await npsRun(synthAll(120));
  const before = Object.fromEntries(listFiles(first.outDir).map((f) => [f, readFileSync(join(first.outDir, f), 'utf8')]));
  const all = synthAll(120);
  const ignoresStart = async (url, init = {}) => init.method === 'HEAD' ? { ok: true, status: 200 }
    : ({ ok: true, status: 200, json: async () => ({ total: '120', limit: '50', start: '0', data: all.slice(0, 50) }) });
  const result = await buildSnapshotDir({ outDir: first.outDir, env: ENV, now: NOW, providers: [nps()], fetchImpl: ignoresStart });
  assert.equal(result.providers[0].written, false);
  assert.match(result.providers[0].reason, /fetch-error: NPS paging incomplete/);
  assert.deepEqual(Object.fromEntries(listFiles(first.outDir).map((f) => [f, readFileSync(join(first.outDir, f), 'utf8')])), before);
});

test('U5 nps-webcams: reaching the page cap before `total` fails the provider', async () => {
  const all = synthAll(60 * 50 + 10);
  const { result } = await npsRun(all);
  assert.equal(result.providers[0].written, false);
  assert.match(result.providers[0].reason, /fetch-error: NPS paging incomplete/);
});

test('U5 memoFetch: a HEAD (or any non-GET) passes straight through, uncached and unparsed', async () => {
  const seen = [];
  const wrapped = memoFetch(async (url, init) => { seen.push(init && init.method); return { ok: true, status: 200 }; });
  const res = await wrapped('https://x.test/a.jpg', { method: 'HEAD' });
  assert.equal(res.status, 200);
  await wrapped('https://x.test/a.jpg', { method: 'HEAD' });
  assert.deepEqual(seen, ['HEAD', 'HEAD']);
});

test('U5 legacy: --out still writes the GRSM-only cameras-nps-grsm.json shape (provider nps-grsm, parkCode=grsm)', async () => {
  const out = tmpOut();
  const urls = [];
  const result = await writeSnapshotOrKeepExisting({ out, apiKey: FAKE_KEY,
    fetchImpl: async (u) => { urls.push(u); return { ok: true, json: async () => GRSM }; } });
  assert.equal(result.written, true);
  assert.deepEqual(urls, [`${GRSM_WEBCAMS_URL}&api_key=${FAKE_KEY}`]);
  const cams = readJson(out).cameras;
  assert.equal(cams.length, 5);
  assert.ok(cams.every((c) => c.provider === 'nps-grsm' && c.operator === 'NPS Air Quality Network'));
});

test('U5 seeds: the committed nps-webcams seed is the GRSM recording, no invented camera', () => {
  const dir = new URL('../../static/data/quiet-corners-maps/cameras/', import.meta.url).pathname;
  const files = readdirSync(join(dir, 'nps-webcams'));
  assert.deepEqual(files, ['nps-nc.json']);
  const file = readJson(join(dir, 'nps-webcams/nps-nc.json'));
  assert.deepEqual(file.rows.map((r) => r[0]).sort(),
    GRSM.data.filter((d) => d.latitude).map((d) => d.id).filter((id, i, a) => a.indexOf(id) === i).sort());
  assert.ok(!existsSync(join(dir, 'nps-grsm')), 'the old nps-grsm seed directory is gone, not left to be indexed');
});

// ---------------------------------------------------------------------------------------------
// Link-only providers: HPWREN and AlertWest. Pins and links, never a picture and never a request
// to the owner's host from the reader's browser.
import { cspValue } from './gen-headers.mjs';
import { stateOrigins } from '../../themes/headlessmode/static/js/quiet-corners-maps/state-pages.js';
import { APPROVED_ORIGINS } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';

const HPWREN_TEXT = readFileSync(new URL('fixtures/hpwren-sites-2026-10-04.min.js', import.meta.url), 'utf8');
const AW_ROWS = read('fixtures/alertwest-cameras-2026-10-04.min.json');
const hpwrenP = () => PROVIDERS.find((p) => p.id === 'hpwren');
const alertwestP = () => PROVIDERS.find((p) => p.id === 'alertwest');
const HPWREN_URL = 'https://www.hpwren.ucsd.edu/cameras/sites.js';
const AW_URL = 'https://alertwest.live/api/firecams/v0/cameras';
/** A fake of both owners: sites.js as text, the AlertWest list as JSON; `fail` maps a URL to a status. */
const linkFetch = ({ calls = [], fail = {}, aw = AW_ROWS, hp = HPWREN_TEXT } = {}) => async (url, init = {}) => {
  calls.push({ url, method: init.method || 'GET' });
  if (fail[url]) return { ok: false, status: fail[url] };
  if (url === HPWREN_URL) return { ok: true, status: 200, text: async () => hp, json: async () => JSON.parse(hp) };
  if (url === AW_URL) return { ok: true, status: 200, json: async () => aw, text: async () => JSON.stringify(aw) };
  throw new Error(`unexpected request ${url}`);
};
const linkRun = async (opts = {}, outDir = tmpDir()) => {
  const result = await buildSnapshotDir({ outDir, env: {}, now: NOW, providers: [hpwrenP(), alertwestP()], fetchImpl: linkFetch(opts) });
  return { outDir, result };
};

test('link-only PROVIDERS: hpwren and alertwest are keyless table entries on a link-only layer', () => {
  for (const [p, source] of [[hpwrenP(), HPWREN_URL], [alertwestP(), AW_URL]]) {
    assert.ok(p, 'provider missing');
    assert.equal(p.layer, 'linkCameras');
    assert.equal(p.keyEnv, undefined);
    assert.equal(p.source, source);
    assert.equal(typeof p.fetch, 'function');
    assert.equal(typeof p.regions, 'function');
  }
});

test('link-only build: HPWREN writes one California file, 55 pins, every still null, no image URL on disk', async () => {
  const { outDir, result } = await linkRun();
  assert.equal(result.providers.find((p) => p.id === 'hpwren').written, true);
  assert.deepEqual(listFiles(outDir).filter((f) => f.startsWith('hpwren/')), ['hpwren/hpwren-ca.json']);
  const file = readJson(join(outDir, 'hpwren/hpwren-ca.json'));
  assert.deepEqual(snapshotProblems(file), []);
  assert.equal(file.rows.length, 55);
  assert.equal(file.layer, 'linkCameras');
  assert.equal(file.attribution, 'HPWREN, UC San Diego');
  const stillAt = file.fields.indexOf('still');
  assert.ok(file.rows.every((r) => r[stillAt] === null), 'a link-only pin stores no image URL');
  const bytes = readFileSync(join(outDir, 'hpwren/hpwren-ca.json'), 'utf8');
  assert.ok(!/\.(jpg|jpeg|png|gif)\b/i.test(bytes), 'no image file name in the snapshot');
  assert.ok(!bytes.includes('"owner"') && !bytes.includes('azimuth'), 'no camera fields beyond the names');
});

test('link-only build: AlertWest writes one file per non-California US state, 12 pins, every still null, no image host on disk', async () => {
  const { outDir } = await linkRun();
  const files = listFiles(outDir).filter((f) => f.startsWith('alertwest/')).sort();
  assert.deepEqual(files, ['id', 'nv', 'co', 'wa', 'hi', 'or', 'mt', 'wy', 'az', 'nm'].sort().map((s) => `alertwest/alertwest-${s}.json`));
  let pins = 0;
  for (const f of files) {
    const file = readJson(join(outDir, f));
    assert.deepEqual(snapshotProblems(file), [], f);
    assert.equal(file.layer, 'linkCameras');
    assert.equal(file.officialUrl, 'https://alertwest.live/');
    const stillAt = file.fields.indexOf('still');
    assert.ok(file.rows.every((r) => r[stillAt] === null), `${f} stores an image URL`);
    pins += file.rows.length;
    const bytes = readFileSync(join(outDir, f), 'utf8');
    assert.ok(!bytes.includes('weathernode') && !/\.jpg/i.test(bytes), `${f} names an image`);
  }
  assert.equal(pins, 12);
  assert.ok(!files.some((f) => /-ca\.json$|-ab\.json$/.test(f)), 'no California or Alberta file');
});

test('link-only build: AlertWest cameras filed far outside their state, and HPWREN sites far outside California, are not published', async () => {
  const stray = (name, lat, lon, state) => ({ name, source: name, site: { id: name, latitude: String(lat), longitude: String(lon), state } });
  const aw = [stray('Good', 39.5, -119.8, 'NV'), stray('Nowhere', 0, 0, 'NV'), stray('Brisbane', -27.4, 153.0, 'HI'),
    stray('Hawaii', 20.8, -156.9, 'HI')];
  const hp = `var sites = ${JSON.stringify({
    ok: { name: 'Ok', lat: 33.3, long: -116.9, cams: { a: { name: 'A', owner: 'hpwren', active: 'y', experimental: 'n' } } },
    far: { name: 'Far', lat: -27.4, long: 153.0, cams: { a: { name: 'A', owner: 'hpwren', active: 'y', experimental: 'n' } } },
    zero: { name: 'Zero', lat: 0, long: 0, cams: { a: { name: 'A', owner: 'hpwren', active: 'y', experimental: 'n' } } },
  })};`;
  const { outDir } = await linkRun({ aw, hp });
  const ids = listFiles(outDir).filter((f) => f.startsWith('alertwest/') || f.startsWith('hpwren/'))
    .flatMap((f) => expandSnapshot(readJson(join(outDir, f))).map((r) => r.providerId)).sort();
  assert.deepEqual(ids, ['Good:Good', 'Hawaii:Hawaii', 'ok']);
});

test('link-only build: a 403 from AlertWest or a failing HPWREN list keeps the last good files byte for byte', async () => {
  const { outDir } = await linkRun();
  const before = Object.fromEntries(listFiles(outDir).map((f) => [f, readFileSync(join(outDir, f), 'utf8')]));
  const second = await buildSnapshotDir({ outDir, env: {}, now: () => '2026-10-05T12:00:00.000Z',
    providers: [hpwrenP(), alertwestP()], fetchImpl: linkFetch({ fail: { [AW_URL]: 403, [HPWREN_URL]: 500 } }) });
  const aw = second.providers.find((p) => p.id === 'alertwest');
  const hp = second.providers.find((p) => p.id === 'hpwren');
  assert.equal(aw.written, false);
  assert.match(aw.reason, /403/);
  assert.equal(hp.written, false);
  assert.match(hp.reason, /500/);
  const after = Object.fromEntries(listFiles(outDir).map((f) => [f, readFileSync(join(outDir, f), 'utf8')]));
  assert.deepEqual(after, before);
});

test('link-only build: a CloudFront 403 page or an HTML body in place of the list also keeps the files', async () => {
  const { outDir } = await linkRun();
  const before = readFileSync(join(outDir, 'alertwest/alertwest-nv.json'), 'utf8');
  const html403 = async (url) => (url === AW_URL
    ? { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }
    : { ok: true, status: 200, text: async () => '<html>403 ERROR</html>', json: async () => { throw new SyntaxError('x'); } });
  const got = await buildSnapshotDir({ outDir, env: {}, now: NOW, providers: [hpwrenP(), alertwestP()], fetchImpl: html403 });
  assert.deepEqual(got.providers.map((p) => p.written), [false, false]);
  assert.equal(readFileSync(join(outDir, 'alertwest/alertwest-nv.json'), 'utf8'), before);
  assert.ok(existsSync(join(outDir, 'hpwren/hpwren-ca.json')));
});

test('link-only build: a list that normalizes to no cameras publishes nothing and keeps the files', async () => {
  const { outDir } = await linkRun();
  const before = readFileSync(join(outDir, 'hpwren/hpwren-ca.json'), 'utf8');
  const got = await buildSnapshotDir({ outDir, env: {}, now: NOW, providers: [hpwrenP(), alertwestP()],
    fetchImpl: linkFetch({ aw: [], hp: 'var sites = {};' }) });
  assert.deepEqual(got.providers.map((p) => p.written), [false, false]);
  assert.match(got.providers[0].reason, /zero-records/);
  assert.equal(readFileSync(join(outDir, 'hpwren/hpwren-ca.json'), 'utf8'), before);
});

test('link-only build: the run asks each owner for its list once and makes no other request (no picture, no HEAD)', async () => {
  const calls = [];
  await linkRun({ calls });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`).sort(), [`GET ${AW_URL}`, `GET ${HPWREN_URL}`].sort());
});

test('link-only build: memoFetch lets the HPWREN script through as text instead of parsing it as JSON', async () => {
  let n = 0;
  const memo = memoFetch(async () => { n += 1; return { ok: true, status: 200, text: async () => HPWREN_TEXT, json: async () => { throw new Error('not JSON'); } }; });
  const res = await memo(HPWREN_URL);
  assert.equal(await res.text(), HPWREN_TEXT);
  await memo(HPWREN_URL);
  assert.equal(n, 2, 'a script is passed through, not cached as JSON');
});

test('link-only CSP: the policy and the source registry name no HPWREN or AlertWest host', () => {
  const policy = cspValue(stateOrigins());
  assert.ok(!/hpwren|ucsd|alertwest|weathernode/i.test(policy), 'a link-only owner must not be in the policy');
  assert.ok(!APPROVED_ORIGINS.some((o) => /hpwren|ucsd|alertwest|weathernode/i.test(o)), 'APPROVED_ORIGINS names an owner');
});

const LINK_PAGE = new URL('../../public/quiet-corners/index.html', import.meta.url);
test('link-only CSP: the built page meta policy names no HPWREN or AlertWest host', {
  skip: existsSync(LINK_PAGE) ? false : 'no built public/quiet-corners/index.html (run scripts/build-site.sh)',
}, () => {
  const meta = readFileSync(LINK_PAGE, 'utf8').match(/http-equiv=["']?Content-Security-Policy["']?[^>]*\bcontent="([^"]*)"/i);
  assert.ok(meta, 'built page has a CSP meta');
  assert.ok(!/hpwren|ucsd|alertwest|weathernode/i.test(meta[1]), 'the built meta policy names an owner');
});

test('link-only seeds: the committed files hold only links -- no still, no image host -- and fit every budget', () => {
  const dir = new URL('../../static/data/quiet-corners-maps/cameras/', import.meta.url).pathname.replace(/\/$/, '');
  const index = readJson(join(dir, 'index.json'));
  const rows = index.files.filter((r) => r.layer === 'linkCameras');
  assert.deepEqual([...new Set(rows.map((r) => r.provider))].sort(), ['alertwest', 'deldot', 'hpwren', 'mdchart', 'modot', 'njta', 'nmroads']);
  for (const id of ['modot', 'mdchart', 'deldot', 'nmroads', 'njta']) {
    assert.ok(rows.filter((r) => r.provider === id).reduce((n, r) => n + r.count, 0) >= 100, `${id} seed is the real list`);
  }
  assert.ok(rows.some((r) => r.provider === 'hpwren' && r.count >= 40), 'HPWREN seed is the real list');
  assert.ok(rows.filter((r) => r.provider === 'alertwest').reduce((n, r) => n + r.count, 0) >= 100, 'AlertWest seed is the real list');
  for (const row of rows) {
    const bytes = readFileSync(join(dir, row.file), 'utf8');
    const file = JSON.parse(bytes);
    assert.deepEqual(snapshotProblems(file), [], row.file);
    assert.ok(file.rows.every((r) => r[file.fields.indexOf('still')] === null), `${row.file} stores a still`);
    assert.ok(!/weathernode|\.jpe?g|\.png/i.test(bytes), `${row.file} names an image`);
    assert.ok(bytes.length <= BUDGETS.fileBytes);
  }
  const total = listFiles(dir).reduce((n, f) => n + statSync(join(dir, f)).size, 0);
  assert.ok(statSync(join(dir, 'index.json')).size <= BUDGETS.indexBytes, 'index.json is over budget');
  assert.ok(total <= BUDGETS.dirBytes, `directory is ${total} bytes, budget ${BUDGETS.dirBytes}`);
});

// ---------------------------------------------------------------------------------------------
// ArcGIS REST camera layers (state and city operators): one generic adapter, six provider ids.
// Nothing here touches the network; the fixture is real rows from each layer (see source-camera.test.mjs).
import { fetchArcgisPages, gateArcgisStills, parseArgs, ARCGIS_HEAD_PAUSE_MS, ARCGIS_PAUSE_MS, ARCGIS_USER_AGENT } from './build-camera-snapshot.mjs';
import { ARCGIS_LAYERS, arcgisStill } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-camera.js';

const AGF = { ...read('fixtures/arcgis-cameras-2026-10-04.min.json'), ...read('fixtures/arcgis-small-2026-10-05.min.json') };
const agLayer = (id) => ARCGIS_LAYERS.find((l) => l.id === id);
const agProvider = (id) => PROVIDERS.find((p) => p.id === id);
const AG_IDS = ARCGIS_LAYERS.map((l) => l.id);
/** A fake ArcGIS server: `pages` answers in order; records every request. */
const fakeArcgis = (pages, calls = []) => async (url, init) => {
  calls.push({ url: String(url), init });
  const i = calls.length - 1;
  const body = pages[Math.min(i, pages.length - 1)];
  if (body === 'boom') throw new Error('socket hang up');
  if (typeof body === 'number') return { ok: false, status: body };
  return { ok: true, status: 200, json: async () => body };
};

test('ArcGIS: the seven operators are PROVIDERS rows, keyless, on the road-camera layer', () => {
  assert.deepEqual(AG_IDS, ['ky-kytc', 'tx-arlington', 'ks-lawrence', 'or-salem', 'or-tripcheck', 'ut-udot', 'wa-kirkland']);
  for (const id of AG_IDS) {
    const p = agProvider(id);
    assert.ok(p, id);
    assert.equal(p.layer, 'roadCameras');
    assert.equal(p.keyEnv, undefined, 'a public layer needs no key');
    assert.equal(p.source, agLayer(id).serviceUrl);
    assert.equal(p.officialUrl, agLayer(id).officialUrl);
    assert.equal(typeof p.fetch, 'function');
    assert.equal(typeof p.regions, 'function');
  }
});

test('ArcGIS request: a plain GET of <layer>/query with the documented parameters, an honest user agent, nothing spoofed', async () => {
  const layer = agLayer('ks-lawrence');
  const calls = [];
  const got = await fetchArcgisPages(layer, { fetchImpl: fakeArcgis([{ features: AGF['ks-lawrence'] }], calls), sleep: async () => {} });
  assert.equal(got.ok, true);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(`${url.origin}${url.pathname}`, `${layer.serviceUrl}/query`);
  assert.equal(url.searchParams.get('where'), '1=1');
  assert.equal(url.searchParams.get('outFields'), layer.outFields.join(','));
  assert.equal(url.searchParams.get('outSR'), '4326');
  assert.equal(url.searchParams.get('f'), 'json');
  assert.equal(url.searchParams.get('resultOffset'), '0');
  assert.equal(url.searchParams.get('resultRecordCount'), String(layer.pageSize));
  const init = calls[0].init || {};
  assert.ok(!init.method || init.method === 'GET');
  assert.ok(!init.body);
  const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  assert.match(headers['user-agent'], /headlessmode/i);
  assert.equal(headers['user-agent'], ARCGIS_USER_AGENT);
  for (const forbidden of ['origin', 'referer', 'cookie', 'authorization', 'x-requested-with']) {
    assert.equal(headers[forbidden], undefined, `no ${forbidden} header`);
  }
  assert.ok(!/token=/i.test(calls[0].url), 'no scraped token');
  assert.ok(!/[?&]f=pjson|\/query\?.*returnIdsOnly/i.test(calls[0].url));
});

test('ArcGIS paging: resultOffset advances by what each page held, one request per page, a pause between pages', async () => {
  const layer = { ...agLayer('ks-lawrence'), pageSize: 2 };
  const f = AGF['ks-lawrence'];
  const calls = []; const sleeps = [];
  const fetchImpl = fakeArcgis([
    { features: f.slice(0, 2), exceededTransferLimit: true },
    { features: f.slice(2, 4), exceededTransferLimit: true },
    { features: f.slice(4, 5) },
  ], calls);
  const got = await fetchArcgisPages(layer, { fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(got.ok, true);
  assert.equal(got.payload.features.length, 5);
  assert.deepEqual(calls.map((c) => new URL(c.url).searchParams.get('resultOffset')), ['0', '2', '4']);
  assert.deepEqual(sleeps, [ARCGIS_PAUSE_MS, ARCGIS_PAUSE_MS], 'a pause between pages, none before the first or after the last');
  assert.ok(ARCGIS_PAUSE_MS >= 200 && ARCGIS_PAUSE_MS <= 2000);
});

test('ArcGIS paging: a failed, errored, empty or looping layer is a failure, never a half catalogue', async () => {
  const layer = { ...agLayer('ks-lawrence'), pageSize: 2 };
  const f = AGF['ks-lawrence'];
  const run = (pages) => fetchArcgisPages(layer, { fetchImpl: fakeArcgis(pages), sleep: async () => {} });
  const page = (a, b, more) => ({ features: f.slice(a, b), ...(more ? { exceededTransferLimit: true } : {}) });
  for (const [name, pages] of [
    ['page 2 answers 503', [page(0, 2, true), 503]],
    ['page 2 throws', [page(0, 2, true), 'boom']],
    ['an error body with HTTP 200', [{ error: { code: 400, message: 'Invalid query' } }]],
    ['no features key', [{ nope: 1 }]],
    ['zero features', [{ features: [] }]],
    ['the offset is ignored (same page forever)', [page(0, 2, true)]],
    ['more claimed than ever answered', [page(0, 2, true), { features: [], exceededTransferLimit: true }]],
  ]) {
    const got = await run(pages);
    assert.equal(got.ok, false, name);
    assert.match(got.reason, /^fetch-error/, name);
  }
});

test('ArcGIS paging: a runaway layer is capped, not looped forever', async () => {
  const layer = { ...agLayer('ks-lawrence'), pageSize: 100 };
  let n = 0;
  const fetchImpl = async () => { n += 1; return { ok: true, status: 200, json: async () => ({
    features: [{ attributes: { FacilityID: `x${n}` }, geometry: { x: -95, y: 38.9 } }], exceededTransferLimit: true }) }; };
  const got = await fetchArcgisPages(layer, { fetchImpl, sleep: async () => {} });
  assert.equal(got.ok, false);
  assert.ok(n <= 100, `stopped after ${n} requests`);
});

test('ArcGIS provider fetch: goes through the injected fetch with the layer\'s own URL (no other host is asked)', async () => {
  const calls = [];
  const p = agProvider('ut-udot');
  const got = await p.fetch({ env: {}, fetchImpl: fakeArcgis([{ features: AGF['ut-udot'] }], calls) });
  assert.equal(got.ok, true);
  const heads = calls.filter((c) => c.init && c.init.method === 'HEAD');
  assert.ok(heads.every((c) => c.url.startsWith(agLayer('ut-udot').imageOrigin + '/')), 'a still check asks the picture host only');
  assert.ok(calls.filter((c) => !heads.includes(c)).every((c) => c.url.startsWith(`${agLayer('ut-udot').serviceUrl}/query?`)));
});

test('ArcGIS regions: one file per layer state, filed as <provider>-<state>, named for its state and operator', () => {
  for (const id of AG_IDS) {
    const regions = agProvider(id).regions({ features: AGF[id] }, { fetchedAt: '2026-10-04T18:00:00Z' });
    assert.equal(regions.length, 1, id);
    assert.equal(regions[0].region, `${id}-${agLayer(id).states[0]}`);
    assert.match(regions[0].region, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(regions[0].regionName.includes(agLayer(id).label), regions[0].regionName);
    assert.ok(regions[0].records.length >= 3, id);
  }
});

test('ArcGIS plausibility gate: a position outside the layer\'s state is dropped (a pin in Paris, a pin in the ocean)', () => {
  const base = AGF['ks-lawrence'][0];
  const at = (x, y, id) => ({ attributes: { ...base.attributes, FacilityID: id }, geometry: { x, y } });
  const regions = agProvider('ks-lawrence').regions({ features: [
    at(-95.2, 38.9, 'ok'), at(2.35, 48.85, 'paris'), at(-30, 30, 'ocean'), at(-80.2, 25.8, 'miami'),
  ] }, { fetchedAt: '2026-10-04T18:00:00Z' });
  assert.deepEqual(regions[0].records.map((r) => r.providerId), ['ok']);
});

test('ArcGIS plausibility gate: the state box is not padded, so a border camera just over the line is dropped', () => {
  const at = (x, y, id) => ({ attributes: { attributes_title: `US101 at ${id}`, attributes_filename: `https://tripcheck.com/RoadCams/cams/${id}.jpg`, attributes_cameraId: id }, geometry: { x, y } });
  const regions = agProvider('or-tripcheck').regions({ features: [at(-124.1, 41.72, 'cushing'), at(-123.0, 42.3, 'grants')] }, { fetchedAt: '2026-10-04T18:00:00Z' });
  assert.deepEqual(regions[0].records.map((r) => r.providerId), ['grants']);
});

test("ArcGIS plausibility gate: Oregon's box starts at the 42.0N state line, not short of it", () => {
  // 'US199 at South of Oregon State Line' sits at 41.994N, in California; 'OR140 at Nevada State Line' at 42.004N is Oregon's.
  const at = (x, y, id) => ({ attributes: { attributes_title: `US199 at ${id}`, attributes_filename: `https://tripcheck.com/RoadCams/cams/${id}.jpg`, attributes_cameraId: id }, geometry: { x, y } });
  const regions = agProvider('or-tripcheck').regions({ features: [at(-123.72021, 41.99402, 'ca-side'), at(-119.9, 42.004, 'or-side')] }, { fetchedAt: '2026-10-04T18:00:00Z' });
  assert.deepEqual(regions[0].records.map((r) => r.providerId), ['or-side']);
});

test('ArcGIS build: every operator writes compact files that pass the shape check, with the operator as credit', async () => {
  const outDir = tmpDir();
  const fetchImpl = async (url, init) => {
    if (init && init.method === 'HEAD') return { ok: true, status: 200, headers: { get: () => null } };
    const layer = ARCGIS_LAYERS.find((l) => String(url).startsWith(`${l.serviceUrl}/query?`));
    return layer ? { ok: true, status: 200, json: async () => ({ features: AGF[layer.id] }) } : { ok: false, status: 404 };
  };
  const result = await buildSnapshotDir({ outDir, env: {}, now: NOW, fetchImpl, sleep: async () => {},
    providers: AG_IDS.map(agProvider) });
  assert.deepEqual(result.providers.map((p) => [p.id, p.written]), AG_IDS.map((id) => [id, true]));
  const rows = readJson(join(outDir, 'index.json')).files;
  assert.deepEqual(rows.map((r) => r.provider).sort(), [...AG_IDS].sort());
  assert.ok(rows.every((r) => r.layer === 'roadCameras'));
  for (const row of rows) {
    const file = readJson(join(outDir, row.file));
    assert.deepEqual(snapshotProblems(file), [], row.file);
    for (const cam of expandSnapshot(file)) {
      assert.equal(cam.attribution, agLayer(row.provider).operator);
      assert.equal(cam.rights, 'unverified');
      assert.ok(cam.media.still.startsWith(agLayer(row.provider).imageOrigin + '/'), cam.media.still);
    }
  }
});

test('ArcGIS build: a layer that answers 503 keeps its existing files and does not stop the others', async () => {
  const outDir = tmpDir();
  const good = async (url) => {
    const layer = ARCGIS_LAYERS.find((l) => String(url).startsWith(`${l.serviceUrl}/query?`));
    return { ok: true, status: 200, json: async () => ({ features: AGF[layer.id] }) };
  };
  await buildSnapshotDir({ outDir, env: {}, now: NOW, fetchImpl: good, providers: [agProvider('ky-kytc'), agProvider('tx-arlington')] });
  const before = readFileSync(join(outDir, 'ky-kytc/ky-kytc-ky.json'), 'utf8');
  const flaky = async (url) => (String(url).startsWith(agLayer('ky-kytc').serviceUrl)
    ? { ok: false, status: 503 } : good(url));
  const result = await buildSnapshotDir({ outDir, env: {}, now: () => '2026-10-05T12:00:00.000Z', fetchImpl: flaky,
    providers: [agProvider('ky-kytc'), agProvider('tx-arlington')] });
  assert.deepEqual(result.providers.map((p) => p.written), [false, true]);
  assert.match(result.providers[0].reason, /^fetch-error/);
  assert.equal(readFileSync(join(outDir, 'ky-kytc/ky-kytc-ky.json'), 'utf8'), before);
});

test('memoFetch passes the request init (headers) through to the real fetch on a GET', async () => {
  const seen = [];
  const wrapped = memoFetch(async (url, init) => { seen.push(init); return { ok: true, status: 200, json: async () => ({ a: 1 }) }; });
  await wrapped('https://example.test/a', { headers: { 'User-Agent': 'x' } });
  assert.deepEqual(seen[0], { headers: { 'User-Agent': 'x' } });
});

test('directory budget: the measured total fits 4 MB (3 MB left no 25% headroom once Colorado was added), at most 8 MB; the file budget is unchanged and the index budget is the 20 KB measured below', () => {
  const dir = new URL('../../static/data/quiet-corners-maps/cameras/', import.meta.url).pathname;
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
  const total = files.reduce((n, e) => n + statSync(join(e.parentPath ?? e.path, e.name)).size, 0);
  const MB = 1024 * 1024;
  assert.ok(total > 1 * MB, `the committed directory is ${total} bytes: the six ArcGIS operators are in it`);
  assert.ok(total < BUDGETS.dirBytes, `the committed directory (${total} bytes) fits the directory budget`);
  assert.equal(BUDGETS.dirBytes, 4 * MB, 'dirBytes is 4 MB: the whole-MB roundup (3 MB) left under 25% headroom after Colorado');
  assert.ok(BUDGETS.dirBytes <= 8 * MB);
  assert.equal(BUDGETS.fileBytes, 256 * 1024);
  assert.equal(BUDGETS.indexBytes, 24 * 1024);
  assert.ok(statSync(join(dir, 'index.json')).size <= BUDGETS.indexBytes);
});

// ---------------------------------------------------------------------------------------------
// CARS camera lists (MN, IN, KS) and Spokane SRTMC. Nothing here touches the network.
import { CARS_FEEDS } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-camera.js';
import { fetchCarsList, fetchSrtmcMap, checkCarsStills, stillVerdict, CARS_CHECK_CONCURRENCY, CARS_PLACEHOLDER }
  from './build-camera-snapshot.mjs';

const CF = { ...read('fixtures/cars-cameras-2026-10-04.min.json'), co: read('fixtures/cars-co-2026-10-05.min.json') };
const CARS_IDS = CARS_FEEDS.map((f) => f.id);
const carsFeed = (id) => CARS_FEEDS.find((f) => f.id === id);
const carsProvider = (id) => PROVIDERS.find((p) => p.id === id);
const jsonRes = (body) => ({ ok: true, status: 200, json: async () => body });
const hdrs = (o) => ({ get: (k) => o[k.toLowerCase()] ?? null });
const FRESH_AT = '2026-10-04T18:00:00Z';

test('CARS: the five feeds are PROVIDERS rows, keyless, on the road-camera layer', () => {
  assert.deepEqual(CARS_IDS, ['mn-511', 'in-511', 'ks-kandrive', 'wa-srtmc', 'co-cotrip']);
  for (const id of CARS_IDS) {
    const p = carsProvider(id);
    assert.ok(p, id);
    assert.equal(p.layer, 'roadCameras');
    assert.equal(p.keyEnv, undefined);
    assert.equal(p.source, carsFeed(id).listUrl);
    assert.equal(p.officialUrl, carsFeed(id).officialUrl);
  }
});

test('CARS list request: one plain GET with the build\'s user agent and nothing else', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); return jsonRes(CF.mn); };
  const got = await fetchCarsList(carsFeed('mn-511'), { fetchImpl });
  assert.equal(got.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://mntg.carsprogram.org/cameras_v1/api/cameras');
  assert.equal(calls[0].init.method, 'GET');
  assert.deepEqual(Object.keys(calls[0].init.headers), ['User-Agent']);
  assert.equal(calls[0].init.headers['User-Agent'], ARCGIS_USER_AGENT);
});

test('CARS list: a non-array answer, an empty list and a failure each fail the provider (old files stay)', async () => {
  for (const body of [{ healthy: true }, [], 'x']) {
    const got = await fetchCarsList(carsFeed('mn-511'), { fetchImpl: async () => jsonRes(body) });
    assert.equal(got.ok, false);
    assert.match(got.reason, /^fetch-error/);
  }
  assert.equal((await fetchCarsList(carsFeed('mn-511'), { fetchImpl: async () => ({ ok: false, status: 503 }) })).ok, false);
});

test('SRTMC request: one POST of the map query over Spokane at zoom 14, a cluster in the answer fails the provider', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); return jsonRes(CF.wa); };
  const got = await fetchSrtmcMap(carsFeed('wa-srtmc'), { fetchImpl });
  assert.equal(got.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://www.srtmc.org/api/graphql');
  assert.equal(calls[0].init.method, 'POST');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.variables.input.layerSlugs, ['normalCameras']);
  assert.equal(body.variables.input.zoom, 14);
  assert.equal(calls[0].init.headers['User-Agent'], ARCGIS_USER_AGENT);
  const clustered = { data: { mapFeaturesQuery: { mapFeatures: [{ __typename: 'Cluster' }], error: null } } };
  const bad = await fetchSrtmcMap(carsFeed('wa-srtmc'), { fetchImpl: async () => jsonRes(clustered) });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /cluster/);
  const err = await fetchSrtmcMap(carsFeed('wa-srtmc'), { fetchImpl: async () => jsonRes({ data: { mapFeaturesQuery: { mapFeatures: null, error: { message: 'x' } } } }) });
  assert.equal(err.ok, false);
});

test('still verdict: a live picture passes; 403, 404, a non-image, the offline placeholder and a stale Last-Modified do not', () => {
  const now = Date.parse(FRESH_AT);
  const ok = { status: 200, headers: hdrs({ 'content-type': 'image/jpeg', 'last-modified': 'Sun, 04 Oct 2026 17:59:00 GMT', 'content-length': '24098' }) };
  assert.equal(stillVerdict(ok, { now }), 'keep');
  assert.equal(stillVerdict({ ...ok, headers: hdrs({ 'content-type': 'image/jpeg', 'content-length': '24098' }) }, { now }), 'keep',
    'no Last-Modified: the list\'s own stamp already decided');
  assert.equal(stillVerdict({ status: 403, headers: hdrs({}) }, { now }), 'drop');
  assert.equal(stillVerdict({ status: 404, headers: hdrs({}) }, { now }), 'drop');
  assert.equal(stillVerdict({ status: 410, headers: hdrs({}) }, { now }), 'drop');
  assert.equal(stillVerdict({ status: 500, headers: hdrs({}) }, { now }), 'keep', 'a 5xx is not proof the picture is gone');
  assert.equal(stillVerdict({ ...ok, headers: hdrs({ 'content-type': 'text/html' }) }, { now }), 'drop');
  assert.equal(stillVerdict({ ...ok, headers: hdrs({ 'content-type': 'image/jpeg', 'content-length': '15136', etag: `"${CARS_PLACEHOLDER.etag}"` }) }, { now }), 'drop');
  assert.equal(stillVerdict({ ...ok, headers: hdrs({ 'content-type': 'image/jpeg', 'content-length': '15136', etag: '"other"' }) }, { now }), 'keep',
    'the size alone is not the fingerprint');
  assert.equal(stillVerdict({ ...ok, headers: hdrs({ 'content-type': 'image/jpeg', 'last-modified': 'Fri, 02 Oct 2026 17:59:00 GMT' }) }, { now }), 'drop');
});

test('still check: HEAD every picture, 4 at a time with a pause between batches, and return the dead ids', async () => {
  const records = Array.from({ length: 10 }, (_, i) => ({ providerId: `c${i}`, media: { still: `https://public.carsprogram.org/cameras/MN/C${i}` } }));
  let live = 0, peak = 0;
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    live += 1; peak = Math.max(peak, live);
    await new Promise((r) => { setTimeout(r, 2); });
    live -= 1;
    return { status: url.endsWith('C3') ? 404 : 200, headers: hdrs({ 'content-type': 'image/jpeg' }) };
  };
  const sleeps = [];
  const dead = await checkCarsStills(records, { fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, now: Date.parse(FRESH_AT) });
  assert.deepEqual(dead, ['c3']);
  assert.equal(CARS_CHECK_CONCURRENCY, 4);
  assert.ok(peak <= 4, `peak concurrency ${peak}`);
  assert.equal(seen.length, 10);
  assert.ok(seen.every((s) => s.init.method === 'HEAD' && s.init.headers['User-Agent'] === ARCGIS_USER_AGENT));
  assert.deepEqual(sleeps.length, 2, 'ten pictures in batches of 4: a pause between batches, none after the last');
  const thrown = await checkCarsStills(records.slice(0, 2), { fetchImpl: async () => { throw new Error('reset'); }, sleep: async () => {}, now: 0 });
  assert.deepEqual(thrown, [], 'unreachable is not gone');
});

test('CARS build without the still check is seed-only: zero requests, an existing seed file byte-identical', async () => {
  const outDir = tmpDir();
  const seeded = await buildSnapshotDir({ outDir, env: {}, now: NOW, sleep: async () => {}, checkStills: true, providers: CARS_IDS.map(carsProvider),
    fetchImpl: async (url, init) => {
      if (init && init.method === 'HEAD') return { status: 200, headers: hdrs({ 'content-type': 'image/jpeg' }) };
      const feed = CARS_FEEDS.find((f) => url === f.listUrl);
      return feed ? jsonRes(feed.id === 'wa-srtmc' ? CF.wa : CF[feed.id.slice(0, 2)]) : { ok: false, status: 404 };
    } });
  assert.ok(seeded.providers.every((p) => p.written));
  const before = new Map(readdirSync(outDir, { recursive: true }).filter((f) => statSync(join(outDir, f)).isFile()).map((f) => [f, readFileSync(join(outDir, f), 'utf8')]));
  const urls = [];
  const result = await buildSnapshotDir({ outDir, env: {}, now: NOW, sleep: async () => {}, providers: CARS_IDS.map(carsProvider),
    fetchImpl: async (url, init) => { urls.push(`${init && init.method || 'GET'} ${url}`); return { ok: false, status: 404 }; } });
  assert.deepEqual(urls, [], 'a normal build must not fetch a CARS list');
  assert.ok(result.providers.every((p) => !p.written && /seed-only/.test(p.reason)), JSON.stringify(result.providers));
  for (const [f, text] of before) assert.equal(readFileSync(join(outDir, f), 'utf8'), text, f);
});

test('CARS build with the still check: the lists are requested and every file is valid', async () => {
  const outDir = tmpDir();
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push(`${init && init.method || 'GET'} ${url}`);
    if (init && init.method === 'HEAD') return { status: 200, headers: hdrs({ 'content-type': 'image/jpeg' }) };
    const feed = CARS_FEEDS.find((f) => url === f.listUrl);
    return feed ? jsonRes(feed.id === 'wa-srtmc' ? CF.wa : CF[feed.id.slice(0, 2)]) : { ok: false, status: 404 };
  };
  const result = await buildSnapshotDir({ outDir, env: {}, now: NOW, fetchImpl, sleep: async () => {}, checkStills: true, providers: CARS_IDS.map(carsProvider) });
  assert.deepEqual(result.providers.map((p) => [p.id, p.written]), CARS_IDS.map((id) => [id, true]));
  assert.ok(urls.some((u) => u.startsWith('GET ')));
  const rows = readJson(join(outDir, 'index.json')).files;
  for (const row of rows) {
    const file = readJson(join(outDir, row.file));
    assert.deepEqual(snapshotProblems(file), [], row.file);
    for (const cam of expandSnapshot(file)) {
      assert.equal(cam.attribution, carsFeed(row.provider).operator);
      assert.equal(cam.rights, 'unverified');
      assert.ok(carsFeed(row.provider).imageOrigins.some((o) => cam.media.still.startsWith(`${o}/`)), cam.media.still);
    }
  }
});

test('CARS build with the still check: a picture that answers 404 is left out of the files', async () => {
  const outDir = tmpDir();
  const fetchImpl = async (url, init) => {
    if (init && init.method === 'HEAD') {
      return { status: String(url).endsWith('C30405-v1') ? 404 : 200, headers: hdrs({ 'content-type': 'image/jpeg' }) };
    }
    return jsonRes(CF.mn);
  };
  const result = await buildSnapshotDir({ outDir, env: {}, now: NOW, fetchImpl, sleep: async () => {}, checkStills: true, providers: [carsProvider('mn-511')] });
  assert.equal(result.providers[0].written, true);
  const file = readJson(join(outDir, readJson(join(outDir, 'index.json')).files[0].file));
  assert.deepEqual(expandSnapshot(file).map((c) => c.providerId), ['507909', '507907', '507906']);
});

test('a provider fetch gets the build clock, not the wall clock', async () => {
  let seen = null;
  const probe = { id: 'clock-probe', layer: 'roadCameras', async fetch(args) { seen = args.now; return { ok: false, reason: 'probe' }; } };
  await buildSnapshotDir({ outDir: tmpDir(), env: {}, now: NOW, fetchImpl: async () => { throw new Error('no fetch'); }, providers: [probe] });
  assert.equal(typeof seen, 'function');
  assert.equal(seen(), Date.parse(NOW()));
});

test('CARS build: a position outside the feed\'s state is dropped (a pin in Paris)', () => {
  const rows = [{ ...CF.mn[0], id: 1 }, { ...CF.mn[0], id: 2, location: { latitude: 48.85, longitude: 2.35 } }];
  const regions = carsProvider('mn-511').regions({ raw: rows, dead: [] }, { fetchedAt: FRESH_AT });
  assert.deepEqual(regions[0].records.map((r) => r.providerId), ['1']);
});

const NOW_MS = Date.parse('2026-10-04T18:00:00Z');
const DAY = 86400000;
const headAnswers = (byName) => async (url, init) => {
  const hit = Object.entries(byName).find(([k]) => String(url).includes(k));
  const v = hit ? hit[1] : { status: 200, age: 1 };
  if (v === 'boom') throw new Error('reset');
  return { ok: v.status < 400, status: v.status, headers: { get: (h) => (/last-modified/i.test(h) && v.age != null
    ? new Date(NOW_MS - v.age * DAY).toUTCString() : null) } };
};

test('ArcGIS still gate: a 404, a 5xx, or a picture older than 7 days is dropped; a network error keeps it', async () => {
  const layer = agLayer('ks-lawrence');
  const names = AGF['ks-lawrence'].filter((f) => layer.read(f.attributes)).map((f) => f.attributes.Hyperlink);
  assert.ok(names.length >= 5);
  const [a, b, c, d] = names.map((u) => u.split('/').pop());
  const fetchImpl = headAnswers({ [a]: { status: 404 }, [b]: { status: 500 }, [c]: { status: 200, age: 30 }, [d]: 'boom' });
  const before = AGF['ks-lawrence'].filter((f) => layer.read(f.attributes)).length;
  const got = await gateArcgisStills({ features: AGF['ks-lawrence'] }, layer, { fetchImpl, now: NOW_MS });
  const after = got.payload.features.filter((f) => layer.read(f.attributes)).length;
  assert.equal(before - after, 3, 'three of the four checked pictures are gone; the unreachable one stays');
  assert.equal(got.dropped, 3);
});

test('ArcGIS still gate: a fresh picture and a missing Last-Modified are kept; the check is a plain HEAD with the honest agent', async () => {
  const layer = agLayer('ut-udot');
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); return { ok: true, status: 200, headers: { get: () => null } }; };
  const got = await gateArcgisStills({ features: AGF['ut-udot'] }, layer, { fetchImpl, now: NOW_MS });
  assert.equal(got.dropped, 0);
  assert.ok(calls.length > 0);
  for (const c of calls) {
    assert.equal(c.init.method, 'HEAD');
    assert.equal(c.init.headers['User-Agent'], ARCGIS_USER_AGENT);
    assert.ok(!Object.keys(c.init.headers).some((h) => /^(origin|referer|cookie)$/i.test(h)));
  }
});

test('ArcGIS still gate: a still with the layer\'s recorded stand-in Content-Length is dropped even when freshly dated', async () => {
  const layer = agLayer('ut-udot');
  assert.deepEqual([...layer.placeholderLengths], [36809]);
  const rows = AGF['ut-udot'].filter((f) => layer.read(f.attributes));
  const logo = arcgisStill(layer.read(rows[0].attributes).still, layer).href;
  const fetchImpl = async (url) => ({ ok: true, status: 200, headers: { get: (h) => (/content-length/i.test(h)
    ? (String(url) === logo ? '36809' : '51234') : (/last-modified/i.test(h) ? new Date(NOW_MS).toUTCString() : null)) } });
  const got = await gateArcgisStills({ features: AGF['ut-udot'] }, layer, { fetchImpl, now: NOW_MS, sleep: async () => {} });
  assert.equal(got.dropped, rows.filter((f) => arcgisStill(layer.read(f.attributes).still, layer).href === logo).length);
  assert.ok(got.dropped >= 1);
});

test('ArcGIS still gate: HEADs are paced and a deploy build (seedOnly) sends the operators nothing', async () => {
  const layer = agLayer('ut-udot');
  const pauses = [];
  let heads = 0;
  const fetchImpl = async () => { heads += 1; return { ok: true, status: 200, headers: { get: () => null } }; };
  await gateArcgisStills({ features: AGF['ut-udot'] }, layer, { fetchImpl, now: NOW_MS, sleep: async (ms) => { pauses.push(ms); } });
  assert.equal(pauses.length, heads);
  assert.ok(pauses.every((ms) => ms === ARCGIS_HEAD_PAUSE_MS));
  const calls = [];
  const outDir = tmpDir();
  const result = await buildSnapshotDir({ outDir, env: {}, now: NOW, seedOnly: true, sleep: async () => {},
    fetchImpl: async (u) => { calls.push(String(u)); throw new Error('no network'); }, providers: AG_IDS.map(agProvider) });
  assert.deepEqual(result.providers.map((p) => p.written), AG_IDS.map(() => false));
  assert.deepEqual(calls, []);
});

test('ArcGIS build: a malformed picture escape never throws out of buildSnapshotDir and the other providers still write', async () => {
  const outDir = tmpDir();
  const poisoned = JSON.parse(JSON.stringify(AGF['ks-lawrence']));
  poisoned[0].attributes.Hyperlink = 'https://assets.lawrenceks.gov/gis/traffic/GEN_50% Mass.jpeg';
  const fetchImpl = async (url, init) => {
    if (init && init.method === 'HEAD') return { ok: true, status: 200, headers: { get: () => null } };
    const layer = ARCGIS_LAYERS.find((l) => String(url).startsWith(`${l.serviceUrl}/query?`));
    return { ok: true, status: 200, json: async () => ({ features: layer.id === 'ks-lawrence' ? poisoned : AGF[layer.id] }) };
  };
  const result = await buildSnapshotDir({ outDir, env: {}, now: NOW, fetchImpl, sleep: async () => {}, providers: AG_IDS.map(agProvider) });
  assert.deepEqual(result.providers.map((p) => p.written), AG_IDS.map(() => true));
});

test('CLI --only: keeps the named providers, rejects an unknown id, and needs an output', () => {
  assert.deepEqual(parseArgs(['--refresh-seeds', '--only', 'ky-kytc,ut-udot']).only, ['ky-kytc', 'ut-udot']);
  assert.equal(parseArgs(['--refresh-seeds']).only, null);
  assert.throws(() => parseArgs(['--refresh-seeds', '--only', 'nope']), /names no provider: nope/);
  assert.throws(() => parseArgs(['--only', 'ky-kytc']), /--out/);
  assert.equal(parseArgs(['--out-dir', 'x']).refreshSeeds, false, 'a deploy build never contacts operators');
  assert.equal(parseArgs(['--refresh-seeds']).refreshSeeds, true);
});

// ---------------------------------------------------------------------------------------------
// Iteris CDN GeoJSON (VA, SC, SD) and Socrata SODA (Austin, Baton Rouge): two more adapters on the
// same plain-GET rules as ArcGIS. Nothing here touches the network; fixtures are real rows.
import { fetchIterisLists, fetchSocrataPages } from './build-camera-snapshot.mjs';
import { ITERIS_LAYERS, SOCRATA_LAYERS } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-camera.js';

const ITF = read('fixtures/iteris-cameras-2026-10-04.min.json');
const SOF = read('fixtures/socrata-cameras-2026-10-04.min.json');
const itL = (id) => ITERIS_LAYERS.find((l) => l.id === id);
const soL = (id) => SOCRATA_LAYERS.find((l) => l.id === id);
const IT_IDS = ITERIS_LAYERS.map((l) => l.id);
const SO_IDS = SOCRATA_LAYERS.map((l) => l.id);
/** Body per Iteris list URL: an SD "cameras" or "rwis" list, else the layer's one list. */
const itBody = (url) => {
  const u = String(url);
  if (u.includes('/icons.rwis.')) return { type: 'FeatureCollection', features: ITF['sd-sddot'].rwis };
  if (u.includes('sd.cdn.')) return { features: ITF['sd-sddot'].cameras };
  if (u.includes('iteriscloud.com')) return { type: 'FeatureCollection', features: ITF['va-vdot'] };
  return null;
};
const itFetch = (calls = []) => async (url, init) => {
  calls.push({ url: String(url), init });
  const body = itBody(url);
  return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404 };
};
const soFetch = (pages, calls = []) => async (url, init) => {
  calls.push({ url: String(url), init });
  const body = pages[Math.min(calls.length - 1, pages.length - 1)];
  if (body === 'boom') throw new Error('socket hang up');
  if (typeof body === 'number') return { ok: false, status: body };
  return { ok: true, status: 200, json: async () => body };
};

test('Iteris and Socrata: four PROVIDERS rows on the road-camera layer, keyless', () => {
  assert.deepEqual(IT_IDS, ['va-vdot', 'sd-sddot']);
  assert.deepEqual(SO_IDS, ['tx-austin', 'la-batonrouge']);
  for (const id of [...IT_IDS, ...SO_IDS]) {
    const p = agProvider(id);
    assert.ok(p, id);
    assert.equal(p.layer, 'roadCameras');
    assert.equal(p.keyEnv, undefined);
    assert.equal(typeof p.fetch, 'function');
    assert.equal(typeof p.regions, 'function');
    assert.match(p.officialUrl, /^https:\/\//);
  }
  assert.ok(!PROVIDERS.some((p) => /^mt-/.test(p.id)), 'Montana is not built');
});

test('Iteris request: plain GETs of the layer\'s own list URLs with the honest user agent and nothing else', async () => {
  const calls = []; const sleeps = [];
  const got = await fetchIterisLists(itL('sd-sddot'), { fetchImpl: itFetch(calls), sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(got.ok, true);
  assert.deepEqual(calls.map((c) => c.url), itL('sd-sddot').listUrls);
  assert.equal(got.payload.features.length, 6);
  assert.deepEqual(sleeps, [ARCGIS_PAUSE_MS], 'a pause between the two lists, none before the first');
  for (const c of calls) {
    const init = c.init || {};
    assert.ok(!init.method || init.method === 'GET');
    assert.ok(!init.body);
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    assert.equal(headers['user-agent'], ARCGIS_USER_AGENT);
    for (const forbidden of ['origin', 'referer', 'cookie', 'authorization', 'x-requested-with']) assert.equal(headers[forbidden], undefined, forbidden);
    assert.ok(!/token=|graphql/i.test(c.url));
  }
});

test('Iteris request: a list that fails, throws, is not GeoJSON or is empty fails the layer (no half catalogue)', async () => {
  const good = (u) => itBody(u);
  for (const [name, fetchImpl] of [
    ['second list 503', async (u) => (String(u).includes('rwis') ? { ok: false, status: 503 } : { ok: true, status: 200, json: async () => good(u) })],
    ['second list throws', async (u) => { if (String(u).includes('rwis')) throw new Error('socket hang up'); return { ok: true, status: 200, json: async () => good(u) }; }],
    ['no features key', async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) })],
    ['zero features', async () => ({ ok: true, status: 200, json: async () => ({ features: [] }) })],
    ['an XML error body', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } })],
  ]) {
    const got = await fetchIterisLists(itL('sd-sddot'), { fetchImpl, sleep: async () => {} });
    assert.equal(got.ok, false, name);
    assert.match(got.reason, /^fetch-error/, name);
  }
});

test('Socrata request: a plain GET of /resource/<id>.json with named fields, a stable order and $offset paging, a pause between pages', async () => {
  const layer = { ...soL('tx-austin'), pageSize: 2 };
  const rows = SOF['tx-austin'];
  const calls = []; const sleeps = [];
  const got = await fetchSocrataPages(layer, { fetchImpl: soFetch([rows.slice(0, 2), rows.slice(2, 4), rows.slice(4, 5)], calls), sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(got.ok, true);
  assert.equal(got.payload.rows.length, 5);
  assert.deepEqual(calls.map((c) => new URL(c.url).searchParams.get('$offset')), ['0', '2', '4']);
  assert.deepEqual(sleeps, [ARCGIS_PAUSE_MS, ARCGIS_PAUSE_MS]);
  const url = new URL(calls[0].url);
  assert.equal(`${url.origin}${url.pathname}`, layer.resourceUrl);
  assert.match(layer.resourceUrl, /^https:\/\/[a-z.]+\/resource\/[a-z0-9]{4}-[a-z0-9]{4}\.json$/);
  assert.equal(url.searchParams.get('$limit'), '2');
  assert.equal(url.searchParams.get('$select'), layer.outFields.join(','));
  assert.equal(url.searchParams.get('$order'), ':id', 'paging needs a stable order');
  const init = calls[0].init || {};
  assert.ok(!init.method || init.method === 'GET');
  const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  assert.equal(headers['user-agent'], ARCGIS_USER_AGENT);
  for (const forbidden of ['origin', 'referer', 'cookie', 'authorization', 'x-app-token']) assert.equal(headers[forbidden], undefined, forbidden);
  assert.ok(!/app_token|token=/i.test(calls[0].url));
});

test('Socrata paging: a failed, errored, empty or looping dataset is a failure, never a half catalogue', async () => {
  const layer = { ...soL('tx-austin'), pageSize: 2 };
  const rows = SOF['tx-austin'];
  const run = (pages) => fetchSocrataPages(layer, { fetchImpl: soFetch(pages), sleep: async () => {} });
  for (const [name, pages] of [
    ['page 2 answers 503', [rows.slice(0, 2), 503]],
    ['page 2 throws', [rows.slice(0, 2), 'boom']],
    ['an error object with HTTP 200', [{ error: true, message: 'Not found' }]],
    ['zero rows', [[]]],
    ['the offset is ignored (same page forever)', [rows.slice(0, 2)]],
  ]) {
    const got = await run(pages);
    assert.equal(got.ok, false, name);
    assert.match(got.reason, /^fetch-error/, name);
  }
});

test('Socrata paging: a runaway dataset is capped, not looped forever', async () => {
  const layer = { ...soL('tx-austin'), pageSize: 1 };
  let n = 0;
  const fetchImpl = async () => { n += 1; return { ok: true, status: 200, json: async () => [{ camera_id: `x${n}` }] }; };
  const got = await fetchSocrataPages(layer, { fetchImpl, sleep: async () => {} });
  assert.equal(got.ok, false);
  assert.ok(n <= 100, `stopped after ${n} requests`);
});

test('Iteris and Socrata regions: one file per state named <provider>-<state> and for its operator', () => {
  for (const id of IT_IDS) {
    const payload = { features: id === 'sd-sddot' ? [...ITF[id].cameras, ...ITF[id].rwis] : ITF[id] };
    const regions = agProvider(id).regions(payload, { fetchedAt: '2026-10-04T18:00:00Z' });
    assert.equal(regions.length, 1, id);
    assert.equal(regions[0].region, `${id}-${itL(id).states[0]}`);
    assert.ok(regions[0].regionName.includes(itL(id).label));
    assert.ok(regions[0].records.length >= 3, id);
  }
  for (const id of SO_IDS) {
    const regions = agProvider(id).regions({ rows: SOF[id] }, { fetchedAt: '2026-10-04T18:00:00Z' });
    assert.equal(regions[0].region, `${id}-${soL(id).states[0]}`);
    assert.ok(regions[0].regionName.includes(soL(id).label));
    assert.ok(regions[0].records.length >= 3, id);
  }
});

test('Iteris and Socrata plausibility gate: a position outside the layer\'s state is dropped', () => {
  const f = ITF['va-vdot'][0];
  const at = (coordinates, id) => ({ ...f, geometry: { type: 'Point', coordinates }, properties: { ...f.properties, id } });
  const regions = agProvider('va-vdot').regions({ features: [at([-78, 37.5], 'ok'), at([2.35, 48.85], 'paris'), at([-30, 30], 'ocean')] }, { fetchedAt: '2026-10-04T18:00:00Z' });
  assert.deepEqual(regions[0].records.map((r) => r.providerId), ['ok']);
  const a = SOF['tx-austin'][0];
  const austin = agProvider('tx-austin').regions({ rows: [a, { ...a, camera_id: 'far', location: { type: 'Point', coordinates: [-80.2, 25.8] } }, { ...a, camera_id: 'paris', location: { type: 'Point', coordinates: [2.35, 48.85] } }] }, { fetchedAt: '2026-10-04T18:00:00Z' });
  assert.deepEqual(austin[0].records.map((r) => r.providerId), ['1'], 'Miami and Paris are both outside the padded Texas box');
});

test('Iteris and Socrata build: every operator writes compact files that pass the shape check, with the operator as credit', async () => {
  const outDir = tmpDir();
  const fetchImpl = async (url, init) => {
    if (itBody(url)) return itFetch()(url, init);
    const layer = SOCRATA_LAYERS.find((l) => String(url).startsWith(`${l.resourceUrl}?`));
    return layer ? { ok: true, status: 200, json: async () => SOF[layer.id] } : { ok: false, status: 404 };
  };
  const ids = [...IT_IDS, ...SO_IDS];
  const result = await buildSnapshotDir({ outDir, env: {}, now: NOW, fetchImpl, sleep: async () => {}, providers: ids.map(agProvider) });
  assert.deepEqual(result.providers.map((p) => [p.id, p.written]), ids.map((id) => [id, true]));
  const rows = readJson(join(outDir, 'index.json')).files;
  assert.deepEqual(rows.map((r) => r.provider).sort(), [...ids].sort());
  assert.ok(rows.every((r) => r.layer === 'roadCameras'));
  for (const row of rows) {
    const file = readJson(join(outDir, row.file));
    assert.deepEqual(snapshotProblems(file), [], row.file);
    const layer = itL(row.provider) || soL(row.provider);
    for (const cam of expandSnapshot(file)) {
      assert.equal(cam.attribution, layer.operator);
      assert.equal(cam.rights, 'unverified');
      assert.ok(cam.media.still.startsWith(`${layer.imageOrigin}/`), cam.media.still);
    }
  }
});

test('Iteris and Socrata build: a list that answers 503 keeps its existing files and does not stop the others', async () => {
  const outDir = tmpDir();
  const providers = [agProvider('va-vdot'), agProvider('sd-sddot')];
  await buildSnapshotDir({ outDir, env: {}, now: NOW, fetchImpl: itFetch(), providers });
  const before = readFileSync(join(outDir, 'va-vdot/va-vdot-va.json'), 'utf8');
  const flaky = async (url, init) => (String(url).includes('iteriscloud.com') ? { ok: false, status: 503 } : itFetch()(url, init));
  const result = await buildSnapshotDir({ outDir, env: {}, now: () => '2026-10-05T12:00:00.000Z', fetchImpl: flaky, providers });
  assert.deepEqual(result.providers.map((p) => p.written), [false, true]);
  assert.match(result.providers[0].reason, /^fetch-error/);
  assert.equal(readFileSync(join(outDir, 'va-vdot/va-vdot-va.json'), 'utf8'), before);
});

test('committed seeds: the four new operators are in the index, under budget, with no Montana file', () => {
  const dir = new URL('../../static/data/quiet-corners-maps/cameras/', import.meta.url).pathname;
  const index = readJson(join(dir, 'index.json'));
  const ids = new Set(index.files.map((r) => r.provider));
  for (const id of [...IT_IDS, ...SO_IDS]) assert.ok(ids.has(id), `${id} has a committed seed`);
  assert.ok(![...ids].some((id) => /^mt-/.test(id)));
  assert.ok(!ids.has('sc-scdot'), 'South Carolina is not built');
  assert.ok(!existsSync(join(dir, 'sc-scdot')), 'no sc-scdot seed directory');
  for (const row of index.files) {
    assert.ok(statSync(join(dir, row.file)).size <= BUDGETS.fileBytes, `${row.file} is over the file budget`);
    if ([...IT_IDS, ...SO_IDS].includes(row.provider)) {
      const file = readJson(join(dir, row.file));
      assert.deepEqual(snapshotProblems(file), [], row.file);
      const layer = itL(row.provider) || soL(row.provider);
      for (const cam of expandSnapshot(file)) {
        assert.equal(cam.rights, 'unverified');
        assert.equal(cam.attribution, layer.operator);
        assert.ok(cam.media.still.startsWith(`${layer.imageOrigin}/`));
      }
    }
  }
});

test('Iteris and Socrata: a deploy build (seedOnly) sends the operators nothing and keeps the committed seed', async () => {
  const urls = [];
  const result = await buildSnapshotDir({ outDir: tmpDir(), env: {}, now: NOW, seedOnly: true, sleep: async () => {},
    providers: [...IT_IDS, ...SO_IDS].map((id) => PROVIDERS.find((p) => p.id === id)),
    fetchImpl: async (url, init) => { urls.push(`${init && init.method || 'GET'} ${url}`); return { ok: false, status: 404 }; } });
  assert.deepEqual(urls, [], 'a deploy build must not fetch an Iteris or Socrata list');
  assert.equal(result.providers.length, IT_IDS.length + SO_IDS.length);
  assert.ok(result.providers.every((p) => !p.written && /seed-only/.test(p.reason)), JSON.stringify(result.providers));
});

// ---------------------------------------------------------------------------------------------
// QQA-10d: the raw refresh log. A `--refresh-seeds` run writes, per provider, what it did and why.
// Nothing here touches the network; every answer comes from a stub fetch.
import * as snap from './build-camera-snapshot.mjs';
import { spawnSync } from 'node:child_process';

const R_NOW = Date.parse(FRESH_AT);
const R_OK = { status: 200, headers: hdrs({ 'content-type': 'image/jpeg', 'last-modified': 'Sun, 04 Oct 2026 17:59:00 GMT' }) };
const carsFetch = (headStatus, { onHead } = {}) => async (url, init) => {
  if (init && init.method === 'HEAD') {
    if (onHead) onHead(String(url));
    const status = typeof headStatus === 'function' ? headStatus(String(url)) : headStatus;
    return status === 200 ? R_OK : { status, headers: hdrs({}) };
  }
  const feed = CARS_FEEDS.find((f) => url === f.listUrl);
  return feed ? jsonRes(feed.id === 'wa-srtmc' ? CF.wa : CF[feed.id.slice(0, 2)]) : { ok: false, status: 404 };
};
const reportOf = (path) => readJson(path);
const rowOf = (report, id) => report.providers.find((p) => p.id === id);

test('refresh log: a still verdict carries a reason (blocked 401/403/429, gone 404/410, not-image, error) and the keep/drop call is unchanged', () => {
  const out = (res) => snap.stillOutcome(res, { now: R_NOW });
  assert.deepEqual(out({ status: 403, headers: hdrs({}) }), { verdict: 'drop', reason: 'blocked' });
  assert.deepEqual(out({ status: 401, headers: hdrs({}) }), { verdict: 'keep', reason: 'blocked' }, 'a 401 was always a keep; only the reason is new');
  assert.deepEqual(out({ status: 429, headers: hdrs({}) }), { verdict: 'keep', reason: 'blocked' }, 'a 429 was always a keep; only the reason is new');
  assert.deepEqual(out({ status: 404, headers: hdrs({}) }), { verdict: 'drop', reason: 'gone' });
  assert.deepEqual(out({ status: 410, headers: hdrs({}) }), { verdict: 'drop', reason: 'gone' });
  assert.deepEqual(out({ status: 500, headers: hdrs({}) }), { verdict: 'keep', reason: 'error' });
  assert.deepEqual(out({ status: 200, headers: hdrs({ 'content-type': 'text/html' }) }), { verdict: 'drop', reason: 'not-image' });
  assert.deepEqual(out(R_OK), { verdict: 'keep', reason: 'ok' });
  const stand = out({ status: 200, headers: hdrs({ 'content-type': 'image/jpeg', 'content-length': '15136', etag: `"${CARS_PLACEHOLDER.etag}"` }) });
  assert.equal(stand.verdict, 'drop');
  assert.equal(stand.reason, 'stand-in');
  const stale = out({ status: 200, headers: hdrs({ 'content-type': 'image/jpeg', 'last-modified': 'Fri, 02 Oct 2026 17:59:00 GMT' }) });
  assert.deepEqual(stale, { verdict: 'drop', reason: 'stale' });
  for (const res of [{ status: 403, headers: hdrs({}) }, { status: 401, headers: hdrs({}) }, { status: 404, headers: hdrs({}) }, R_OK]) {
    assert.equal(stillVerdict(res, { now: R_NOW }), out(res).verdict, 'stillVerdict is the same call as before');
  }
});

test('refresh log: checkCarsStillsDetailed tallies kept, dropped-blocked, dropped-gone and dropped-other; checkCarsStills still returns the dead ids', async () => {
  const records = ['ok1', 'ok2', 'ok3', 'ok4', 'blk', 'gone', 'gone2', 'html', 'slow', 'down'].map((id) => ({ providerId: id, media: { still: `https://example.test/${id}` } }));
  const answers = { blk: { status: 403 }, gone: { status: 404 }, gone2: { status: 410 }, slow: { status: 429 },
    down: { status: 503 }, html: { status: 200, headers: hdrs({ 'content-type': 'text/html' }) } };
  const fetchImpl = async (url) => {
    const a = answers[url.split('/').pop()];
    return a ? { headers: hdrs({}), ...a } : R_OK;
  };
  const opts = { fetchImpl, sleep: async () => {}, now: R_NOW };
  const detailed = await snap.checkCarsStillsDetailed(records, opts);
  assert.deepEqual(detailed.dead, ['blk', 'gone', 'gone2', 'html']);
  assert.deepEqual(detailed.counts, { checked: 10, kept: 6, droppedBlocked: 1, droppedGone: 2, droppedOther: 1, blocked: 2 },
    'blocked counts every 401/403/429 answer, kept or dropped; the 429 and the 503 stay kept');
  assert.deepEqual(await checkCarsStills(records, opts), detailed.dead);
  const thrown = await snap.checkCarsStillsDetailed(records.slice(0, 3), { fetchImpl: async () => { throw new Error('reset'); }, sleep: async () => {}, now: 0 });
  assert.deepEqual(thrown.counts, { checked: 3, kept: 3, droppedBlocked: 0, droppedGone: 0, droppedOther: 0, blocked: 0 }, 'unreachable is kept, never counted as blocked');
});

test('refresh log: a refresh writes a report with one row per provider (written, kept-last-good, zero-records) and counts', async () => {
  const outDir = tmpDir();
  const reportPath = join(tmpDir(), 'nested', 'report.json');
  const failing = { id: 'down-dot', layer: 'roadCameras', async fetch() { return { ok: false, reason: 'fetch-error: Down DOT answered 503' }; } };
  const gone = (url) => (url.endsWith('C30405-v1') ? 404 : 200);
  const result = await buildSnapshotDir({ outDir, env: { TEST_DOT_KEY: 'other-key-aaaa-1111' }, now: NOW, sleep: async () => {}, checkStills: true, reportPath,
    fetchImpl: carsFetch(gone), providers: [carsProvider('mn-511'), failing, testProvider({ id: 'empty-dot', cams: [] }),
      carsProvider('in-511')] });
  assert.equal(result.providers.find((p) => p.id === 'mn-511').written, true);
  const report = reportOf(reportPath);
  assert.equal(report.generatedAt, NOW());
  assert.deepEqual(report.providers.map((p) => p.id), ['mn-511', 'down-dot', 'empty-dot', 'in-511']);
  const mn = rowOf(report, 'mn-511');
  assert.equal(mn.status, 'written');
  assert.equal(mn.written, true);
  assert.equal(mn.droppedGone, 1);
  assert.equal(mn.droppedBlocked, 0);
  assert.equal(mn.checked, 4, 'the fixture lists 5 rows, 4 of them pass the normalizer and are checked');
  assert.equal(mn.kept, 3);
  assert.equal(rowOf(report, 'down-dot').status, 'kept-last-good');
  assert.match(rowOf(report, 'down-dot').reason, /503/);
  assert.equal(rowOf(report, 'down-dot').checked, null, 'a provider that ran no still check says so with null, not 0');
  assert.equal(rowOf(report, 'empty-dot').status, 'zero-records');
});

test('refresh log: a CDN that refuses every picture is reported as all-blocked, not as ordinary drops, and the last good files stay', async () => {
  const outDir = tmpDir();
  await buildSnapshotDir({ outDir, env: {}, now: NOW, sleep: async () => {}, checkStills: true, fetchImpl: carsFetch(200), providers: [carsProvider('mn-511')] });
  const before = readFileSync(join(outDir, 'index.json'), 'utf8');
  const reportPath = join(tmpDir(), 'report.json');
  const result = await buildSnapshotDir({ outDir, env: {}, now: NOW, sleep: async () => {}, checkStills: true, reportPath,
    fetchImpl: carsFetch(403), providers: [carsProvider('mn-511')] });
  assert.equal(result.providers[0].written, false);
  const row = rowOf(reportOf(reportPath), 'mn-511');
  assert.equal(row.status, 'all-blocked');
  assert.equal(row.written, false);
  assert.equal(row.droppedBlocked, 4);
  assert.equal(row.droppedGone, 0);
  assert.equal(row.kept, 0);
  assert.match(row.reason, /every checked still .*401\/403\/429/);
  assert.match(row.reason, /zero-records/, 'the original reason is kept');
  assert.equal(readFileSync(join(outDir, 'index.json'), 'utf8'), before, 'the existing seed is untouched');
});

test('refresh log: every picture answering 429 is all-blocked even though each is kept and the files are written', async () => {
  const reportPath = join(tmpDir(), 'report.json');
  await buildSnapshotDir({ outDir: tmpDir(), env: {}, now: NOW, sleep: async () => {}, checkStills: true, reportPath,
    fetchImpl: carsFetch(429), providers: [carsProvider('mn-511')] });
  const row = rowOf(reportOf(reportPath), 'mn-511');
  assert.equal(row.status, 'all-blocked');
  assert.equal(row.written, true);
  assert.equal(row.kept, 4);
  assert.equal(row.droppedBlocked, 0);
});

test('refresh log: some pictures blocked is not all-blocked; the counts say how many of each', async () => {
  const reportPath = join(tmpDir(), 'report.json');
  const mixed = (url) => (url.endsWith('C30405-v1') ? 403 : url.endsWith('C30329-v1') ? 404 : 200);
  await buildSnapshotDir({ outDir: tmpDir(), env: {}, now: NOW, sleep: async () => {}, checkStills: true, reportPath,
    fetchImpl: carsFetch(mixed), providers: [carsProvider('mn-511')] });
  const row = rowOf(reportOf(reportPath), 'mn-511');
  assert.equal(row.status, 'written');
  assert.deepEqual([row.checked, row.kept, row.droppedBlocked, row.droppedGone, row.droppedOther], [4, 2, 1, 1, 0]);
});

test('refresh log: a seed-only build makes no network call and writes no report, even when given a report path', async () => {
  const outDir = tmpDir();
  const reportPath = join(tmpDir(), 'report.json');
  const urls = [];
  const result = await buildSnapshotDir({ outDir, env: {}, now: NOW, sleep: async () => {}, seedOnly: true, reportPath,
    providers: [...CARS_IDS, ...AG_IDS, ...IT_IDS, ...SO_IDS].map((id) => PROVIDERS.find((p) => p.id === id)),
    fetchImpl: async (url, init) => { urls.push(`${init && init.method || 'GET'} ${url}`); return { ok: false, status: 404 }; } });
  assert.deepEqual(urls, []);
  assert.ok(result.providers.every((p) => !p.written));
  assert.equal(existsSync(reportPath), false);
  const plain = await buildSnapshotDir({ outDir, env: {}, now: NOW, sleep: async () => {}, fetchImpl: carsFetch(200), checkStills: true, providers: [carsProvider('mn-511')] });
  assert.equal(plain.providers[0].written, true);
  assert.equal(existsSync(reportPath), false, 'a refresh with no report path writes none either');
});

test('refresh log: ArcGIS layers report the same counts (404 gone, 5xx other, 403 blocked-and-kept)', async () => {
  const layer = agLayer('ks-lawrence');
  const names = AGF['ks-lawrence'].filter((f) => layer.read(f.attributes)).map((f) => f.attributes.Hyperlink.split('/').pop());
  const [a, b, c] = names;
  const fetchImpl = headAnswers({ [a]: { status: 404 }, [b]: { status: 500 }, [c]: { status: 403 } });
  const got = await gateArcgisStills({ features: AGF['ks-lawrence'] }, layer, { fetchImpl, now: NOW_MS, sleep: async () => {} });
  assert.equal(got.dropped, 2);
  assert.deepEqual(got.counts, { checked: names.length, kept: names.length - 2, droppedBlocked: 0, droppedGone: 1, droppedOther: 1, blocked: 1 });
});

test('refresh log: the report holds counts and reasons only, no key and no per-camera id', async () => {
  const reportPath = join(tmpDir(), 'report.json');
  await buildSnapshotDir({ outDir: tmpDir(), env: ENV, now: NOW, sleep: async () => {}, checkStills: true, reportPath,
    fetchImpl: async (url, init) => (init && init.method === 'HEAD' ? { status: String(url).endsWith('C30405-v1') ? 404 : 200, headers: hdrs({ 'content-type': 'image/jpeg' }) }
      : npsFetch(url, init)), providers: [carsProvider('mn-511'), nps()] });
  const text = readFileSync(reportPath, 'utf8');
  assert.ok(!text.includes(FAKE_KEY));
  assert.ok(!text.includes('C30405'), 'no camera id or url');
  assert.deepEqual(Object.keys(rowOf(JSON.parse(text), 'mn-511')).sort(),
    ['blocked', 'checked', 'droppedBlocked', 'droppedGone', 'droppedOther', 'id', 'kept', 'reason', 'status', 'written']);
});

test('refresh log: one stdout line per provider, status first, counts after', () => {
  assert.equal(snap.formatRefreshLine({ id: 'mn-511', status: 'written', reason: 'ok', written: true, checked: 5, kept: 4, droppedBlocked: 0, droppedGone: 1, droppedOther: 0, blocked: 0 }),
    'refresh-log mn-511: written -- kept 4, dropped-blocked 0, dropped-gone 1, dropped-other 0 (ok)');
  assert.equal(snap.formatRefreshLine({ id: 'down-dot', status: 'kept-last-good', reason: 'fetch-error: x', written: false, checked: null, kept: null, droppedBlocked: null, droppedGone: null, droppedOther: null, blocked: null }),
    'refresh-log down-dot: kept-last-good -- no still check (fetch-error: x)');
});

test('refresh log: --refresh-seeds names the report path, a deploy build names none, and the path is gitignored', () => {
  const refresh = parseArgs(['--refresh-seeds']);
  assert.equal(refresh.reportPath, snap.REFRESH_REPORT_PATH);
  assert.equal(parseArgs(['--out-dir', 'x']).reportPath, null);
  assert.ok(snap.REFRESH_REPORT_PATH.startsWith(new URL('../../', import.meta.url).pathname));
  const root = new URL('../../', import.meta.url).pathname;
  const ignored = spawnSync('git', ['check-ignore', '-q', snap.REFRESH_REPORT_PATH], { cwd: root });
  assert.equal(ignored.status, 0, 'the report is an uncommitted build artifact: git must ignore its path');
});

// Link-only road operators (MoDOT, Maryland CHART, DelDOT, NMRoads, NJ Turnpike Authority):
// owner-published camera LISTS, no picture and no stream address kept. One file per state.
const C8 = [
  { id: 'modot', state: 'mo', name: 'Missouri (MoDOT)', operator: 'Missouri DOT (MoDOT)',
    url: 'https://traveler.modot.org/timconfig/feed/desktop/StreamingCams2.json', fixture: 'c8-modot-streamingcams-2026-10-04.min.json', rows: 3 },
  { id: 'mdchart', state: 'md', name: 'Maryland (CHART)', operator: 'Maryland CHART',
    url: 'https://chart.maryland.gov/DataFeeds/GetCamerasJson', fixture: 'c8-mdchart-cameras-2026-10-04.min.json', rows: 3 },
  { id: 'deldot', state: 'de', name: 'Delaware (DelDOT)', operator: 'Delaware DOT (DelDOT)',
    url: 'https://tmc.deldot.gov/json/videocamera.json', fixture: 'c8-deldot-videocamera-2026-10-04.min.json', rows: 3 },
  { id: 'nmroads', state: 'nm', name: 'New Mexico (NMRoads)', operator: 'New Mexico DOT (NMRoads)',
    url: 'https://servicev5.nmroads.com/RealMapWAR/GetCameraInfo', fixture: 'c8-nmroads-camerainfo-2026-10-04.min.json', rows: 3 },
  { id: 'njta', state: 'nj', name: 'New Jersey (NJTA)', operator: 'New Jersey Turnpike Authority',
    url: 'https://www.njta.gov/travel-resources/camera-list/', fixture: 'c8-njta-camera-list-2026-10-04.html', rows: 5, text: true },
];
const c8Raw = (c) => readFileSync(new URL(`fixtures/${c.fixture}`, import.meta.url), 'utf8');
const c8Body = (c) => (c.text ? c8Raw(c) : JSON.parse(c8Raw(c)));
const c8Provider = (id) => PROVIDERS.find((p) => p.id === id);
/** A fake of the owners' lists: `bodies` maps an id to a replacement body, `fail` an id to a status. */
const c8Fetch = ({ bodies = {}, fail = {}, calls = [] } = {}) => async (url, init = {}) => {
  const c = C8.find((x) => x.url === url);
  if (!c) throw new Error(`unexpected request ${url}`);
  calls.push({ url, init });
  if (fail[c.id]) return { ok: false, status: fail[c.id] };
  const body = c.id in bodies ? bodies[c.id] : c8Body(c);
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
};
const c8Run = async (id, opts = {}, outDir = tmpDir()) => {
  const result = await buildSnapshotDir({ outDir, env: {}, now: NOW, providers: [c8Provider(id)], fetchImpl: c8Fetch(opts) });
  return { outDir, result };
};
const c8File = (outDir, c) => readJson(join(outDir, `${c.id}/${c.id}-${c.state}.json`));
const stillAt = (file) => file.fields.indexOf('still');

test('c8 PROVIDERS: five keyless link-only table entries, one per operator', () => {
  for (const c of C8) {
    const p = c8Provider(c.id);
    assert.ok(p, `${c.id} missing`);
    assert.equal(p.layer, 'linkCameras');
    assert.equal(p.keyEnv, undefined);
    assert.equal(p.source, c.url);
    assert.equal(typeof p.fetch, 'function');
    assert.equal(typeof p.regions, 'function');
  }
});

for (const c of C8) {
  test(`c8 ${c.id}: one ${c.state} file, ${c.rows} pins, every still null, no image or stream address on disk`, async () => {
    const { outDir, result } = await c8Run(c.id);
    assert.equal(result.providers.find((p) => p.id === c.id).written, true);
    assert.deepEqual(listFiles(outDir).filter((f) => f.startsWith(`${c.id}/`)), [`${c.id}/${c.id}-${c.state}.json`]);
    const file = c8File(outDir, c);
    assert.deepEqual(snapshotProblems(file), []);
    assert.equal(file.layer, 'linkCameras');
    assert.equal(file.region, `${c.id}-${c.state}`);
    assert.equal(file.regionName, c.name);
    assert.equal(file.operator, c.operator);
    assert.equal(file.attribution, c.operator);
    assert.equal(file.rights, 'unverified');
    assert.equal(file.rows.length, c.rows);
    assert.ok(file.rows.every((r) => r[stillAt(file)] === null), 'a link-only pin stores no image URL');
    const bytes = readFileSync(join(outDir, `${c.id}/${c.id}-${c.state}.json`), 'utf8');
    assert.ok(!/\.(jpe?g|png|gif)\b|m3u8|rtmp|\.stream\b|example\.test|cctvIp/i.test(bytes), 'no picture or stream address');
    const cams = expandSnapshot(file);
    for (const cam of cams) {
      assert.ok(cam.name && Number.isFinite(cam.lat) && Number.isFinite(cam.lon));
      assert.match(cam.officialUrl, /^https:\/\//, 'every pin links to the owner');
      assert.equal(cam.media.still, null);
    }
  });

  test(`c8 ${c.id}: a pin outside its own state is not published`, async () => {
    const body = c8Body(c);
    let bad;
    if (c.id === 'modot') bad = [...body, { ...body[0], location: 'Far away', x: -122.4, y: 37.7 }];
    else if (c.id === 'mdchart') bad = [...body, { ...body[0], id: 'zz', lat: 37.7, lon: -122.4 }];
    else if (c.id === 'deldot') bad = { ...body, videoCameras: [...body.videoCameras, { ...body.videoCameras[0], id: 'ZZ', lat: 37.7, lon: -122.4 }] };
    else if (c.id === 'nmroads') bad = { cameraInfo: [...body.cameraInfo, { ...body.cameraInfo[0], name: 'zz', lat: 37.7, lon: -122.4 }] };
    else bad = c8Raw(c).replace('40.707298', '37.7').replace('-74.154912', '-122.4');
    const { outDir } = await c8Run(c.id, { bodies: { [c.id]: bad } });
    const file = c8File(outDir, c);
    const expected = c.id === 'njta' ? c.rows - 1 : c.rows;
    assert.equal(file.rows.length, expected);
    assert.ok(file.rows.every((r) => r[2] < 37.7 - 0.01 || r[2] > 37.7 + 0.01), 'the San Francisco pin was dropped');
  });

  test(`c8 ${c.id}: a 403 keeps the last good file byte for byte`, async () => {
    const first = await c8Run(c.id);
    const path = join(first.outDir, `${c.id}/${c.id}-${c.state}.json`);
    const before = readFileSync(path, 'utf8');
    const second = await c8Run(c.id, { fail: { [c.id]: 403 } }, first.outDir);
    const row = second.result.providers.find((p) => p.id === c.id);
    assert.equal(row.written, false);
    assert.match(row.reason, /^fetch-error/);
    assert.equal(readFileSync(path, 'utf8'), before);
  });

  test(`c8 ${c.id}: an answer that is not the owner's list is a fetch failure, files kept`, async () => {
    const first = await c8Run(c.id);
    const path = join(first.outDir, `${c.id}/${c.id}-${c.state}.json`);
    const before = readFileSync(path, 'utf8');
    const junk = c.text ? '<html><body>Please sign in</body></html>' : { error: 'nope' };
    const second = await c8Run(c.id, { bodies: { [c.id]: junk } }, first.outDir);
    const row = second.result.providers.find((p) => p.id === c.id);
    assert.equal(row.written, false);
    assert.match(row.reason, /^fetch-error/);
    assert.equal(readFileSync(path, 'utf8'), before);
  });

  test(`c8 ${c.id}: a network error is reported, not raised`, async () => {
    const result = await c8Provider(c.id).fetch({ fetchImpl: async () => { throw new Error('ECONNRESET (simulated)'); } });
    assert.equal(result.ok, false);
    assert.match(result.reason, /^fetch-error/);
  });

  test(`c8 ${c.id}: plain GET, honest user agent, no Origin, Referer, cookie or token`, async () => {
    const calls = [];
    await c8Provider(c.id).fetch({ fetchImpl: c8Fetch({ calls }) });
    assert.equal(calls.length, 1);
    const init = calls[0].init;
    assert.equal(init.method, 'GET');
    assert.deepEqual(Object.keys(init.headers).map((h) => h.toLowerCase()).sort(), ['user-agent']);
    assert.equal(init.headers['User-Agent'], ARCGIS_USER_AGENT);
  });
}

test('c8 dedupe: two pins of one operator within 30 m collapse, 100 m apart both stay', async () => {
  const c = C8[1];
  const body = c8Body(c);
  const near = { ...body[0], id: 'near', lat: body[0].lat + 0.0001, lon: body[0].lon }; // ~11 m
  const far = { ...body[0], id: 'far', lat: body[0].lat + 0.001, lon: body[0].lon }; // ~111 m
  const { outDir } = await c8Run(c.id, { bodies: { [c.id]: [...body, near, far] } });
  assert.equal(c8File(outDir, c).rows.length, c.rows + 1);
});

test('c8 dedupe: the same id twice is one pin', async () => {
  const c = C8[1];
  const body = c8Body(c);
  const { outDir } = await c8Run(c.id, { bodies: { [c.id]: [...body, { ...body[1], lat: body[1].lat + 0.01 }] } });
  assert.equal(c8File(outDir, c).rows.length, c.rows);
});

test('c8 link-only: an image or stream field in the owner\'s row never reaches a record', async () => {
  const c = C8[3];
  const body = c8Body(c);
  const dirty = { cameraInfo: body.cameraInfo.map((r) => ({ ...r, snapshotFile: 'http://ss.example.test/snapshots/x.jpg', image: 'https://img.example.test/a.png' })) };
  const { outDir } = await c8Run(c.id, { bodies: { [c.id]: dirty } });
  const bytes = readFileSync(join(outDir, 'nmroads/nmroads-nm.json'), 'utf8');
  assert.ok(!/example\.test|\.jpg|\.png/.test(bytes));
});

test('c8 MD CHART: a per-camera page on the owner\'s host is kept, any other host falls back to the map page', async () => {
  const c = C8[1];
  const body = c8Body(c);
  const evil = { ...body[0], id: 'evil', lat: body[0].lat + 0.01, publicVideoURL: 'https://evil.example.test/x' };
  const { outDir } = await c8Run(c.id, { bodies: { [c.id]: [body[0], evil] } });
  const cams = expandSnapshot(c8File(outDir, c));
  assert.equal(cams.find((x) => x.providerId === body[0].id).officialUrl, body[0].publicVideoURL);
  assert.equal(cams.find((x) => x.providerId === 'evil').officialUrl, 'https://chart.maryland.gov/InteractiveMap/GetInteractiveMap');
});

test('c8 NJTA: Turnpike and Parkway pins are both read and named for their road', async () => {
  const c = C8[4];
  const { outDir } = await c8Run(c.id);
  const names = expandSnapshot(c8File(outDir, c)).map((x) => x.name);
  assert.ok(names.some((n) => /^New Jersey Turnpike: /.test(n)));
  assert.ok(names.some((n) => /^Garden State Parkway: /.test(n)));
});

test('c8 memoFetch: a text list (HTML) is passed through, never parsed as JSON', async () => {
  const c = C8[4];
  const memo = memoFetch(c8Fetch());
  const res = await memo(c.url, { method: 'GET' });
  assert.match(await res.text(), /data-block-config/);
});

test('c8 CSP: no new owner host in the registry, the policy or the approved origins', () => {
  const owners = /modot|chart\.maryland|deldot|nmroads|njta/i;
  assert.ok(!APPROVED_ORIGINS.some((o) => owners.test(o)), 'APPROVED_ORIGINS names an owner');
  assert.ok(!owners.test(cspValue(stateOrigins())), 'the policy names an owner');
});

test('link-only road operators: a deploy build (seedOnly) sends them nothing and keeps the committed seed', async () => {
  const calls = [];
  const result = await buildSnapshotDir({ outDir: tmpDir(), env: {}, now: NOW, seedOnly: true,
    providers: C8.map((c) => c8Provider(c.id)), fetchImpl: c8Fetch({ calls }) });
  assert.deepEqual(calls, [], 'a deploy build must not fetch a link-only road list');
  assert.equal(result.providers.length, C8.length);
  assert.ok(result.providers.every((p) => !p.written && /seed-only/.test(p.reason)), JSON.stringify(result.providers));
});

// ---------------------------------------------------------------------------------------------
// PhenoCam Network and AviationWX: keyless owner-published lists, one `us` region file each (a
// state split would add ~50 index rows against a 16 KB index budget the NPS states already use).
// The PhenoCam fixture is the live 2026-10-04 list cut to 841 of 1084 rows (count rewritten to match);
// contact1/contact2 hold fake values of the live shape ("Test Person N <tpN AT example DOT org>") so
// the privacy tests still have contact strings to catch without republishing real researchers.
const PHENO_LIST = read('fixtures/phenocam-cameras-2026-10-04.min.json');
const AVWX_LIST = read('fixtures/aviationwx-airports-2026-10-04.min.json');
const PHENO_URL = 'https://phenocam.nau.edu/api/cameras/?format=json&limit=2000';
const AVWX_URL = 'https://api.aviationwx.org/v1/airports';
const pheno = () => PROVIDERS.find((p) => p.id === 'phenocam');
const avwx = () => PROVIDERS.find((p) => p.id === 'aviationwx');
const listFetch = (calls = [], { phenoBody = PHENO_LIST, avwxBody = AVWX_LIST, down = [] } = {}) => async (url, init = {}) => {
  calls.push({ url, method: init.method || 'GET' });
  if (down.includes(url)) return { ok: false, status: 503 };
  if (url === PHENO_URL) return { ok: true, status: 200, json: async () => phenoBody };
  if (url === AVWX_URL) return { ok: true, status: 200, json: async () => avwxBody };
  return { ok: false, status: 404 };
};
const regionRecords = (outDir, provider) => listFiles(outDir).filter((f) => f.startsWith(`${provider}/`))
  .flatMap((f) => expandSnapshot(readJson(join(outDir, f))));

test('PROVIDERS: phenocam and aviationwx are keyless rows with their own layer, fetch and regions', () => {
  for (const [p, layer] of [[pheno(), 'phenoCameras'], [avwx(), 'airportCameras']]) {
    assert.ok(p, 'row exists');
    assert.equal(p.layer, layer);
    assert.equal(p.keyEnv, undefined);
    assert.equal(typeof p.fetch, 'function');
    assert.equal(typeof p.regions, 'function');
  }
  assert.equal(pheno().source, 'https://phenocam.nau.edu/api/cameras/');
  assert.equal(avwx().source, AVWX_URL);
});

test('phenocam: one request for the list, none for any picture; one us file; US, active, 30-day sites only', async () => {
  const calls = [];
  const outDir = tmpDir();
  const result = await buildSnapshotDir({ outDir, env: {}, now: NOW, providers: [pheno()], fetchImpl: listFetch(calls) });
  assert.equal(result.providers[0].written, true);
  assert.deepEqual(calls, [{ url: PHENO_URL, method: 'GET' }], 'the list only: pictures are loaded by the reader browser');
  assert.deepEqual(listFiles(outDir), ['index.json', 'phenocam/us.json']);
  const file = readJson(join(outDir, 'phenocam/us.json'));
  assert.deepEqual(snapshotProblems(file), []);
  assert.equal(file.layer, 'phenoCameras');
  assert.equal(file.attribution, 'PhenoCam Network (CC BY)');
  const ids = new Set(expandSnapshot(file).map((r) => r.providerId));
  assert.equal(ids.size, 494, 'live 2026-10-04: 665 active and recent worldwide, 494 in the 50 states and DC');
  assert.ok(!ids.has('NEON.D04.GUAN.DP1.00033'), 'Puerto Rico is a territory, not one of the 50 states or DC');
  for (const kept of ['amherst', 'harvard', 'bigtraillake', 'haha']) assert.ok(ids.has(kept), kept); // MA, MA, AK, HI
  for (const dropped of ['koffler', 'queens', 'vancouversaltmarsh', 'aguamarga', 'alercecosteroforest']) {
    assert.ok(!ids.has(dropped), `${dropped} is outside the US`);
  }
  const stale = PHENO_LIST.results.filter((s) => !s.active || Date.parse('2026-10-04') - Date.parse(s.date_last) > 30 * 864e5);
  assert.ok(stale.length > 50 && stale.every((s) => !ids.has(s.Sitename)), 'no inactive or older-than-30-day site');
  const row = readJson(join(outDir, 'index.json')).files.find((r) => r.provider === 'phenocam');
  assert.equal(row.count, 494);
  assert.equal(row.layer, 'phenoCameras');
});

test('phenocam privacy: no written byte carries a contact string, a name from one, or an @', async () => {
  const outDir = tmpDir();
  await buildSnapshotDir({ outDir, env: {}, now: NOW, providers: [pheno()], fetchImpl: listFetch() });
  const bytes = listFiles(outDir).map((f) => readFileSync(join(outDir, f), 'utf8')).join('\n');
  assert.ok(!bytes.includes('@'));
  assert.ok(!/contact/i.test(bytes));
  assert.ok(!/ AT [a-z0-9_.-]+ DOT /i.test(bytes));
  const contacts = PHENO_LIST.results.flatMap((s) => [s.contact1, s.contact2]).filter(Boolean);
  assert.ok(contacts.length > 100);
  for (const c of contacts) {
    assert.ok(!bytes.includes(c), `contact leaked: ${c}`);
    const person = c.split('<')[0].trim();
    if (person.length > 6) assert.ok(!bytes.includes(person), `a contact name leaked: ${person}`);
  }
  // Every column of every row is one of the schema's own, so there is nowhere for a person to ride.
  const file = readJson(join(outDir, 'phenocam/us.json'));
  assert.deepEqual(file.fields, ['providerId', 'name', 'lat', 'lon', 'still', 'health', 'subject', 'officialUrl']);
  assert.ok(file.rows.every((r) => r[6] === null), 'subject is empty: no free text beyond the site description');
});

test('phenocam: every card has the credit line and the owner-page link; the picture is on the owner host', async () => {
  const outDir = tmpDir();
  await buildSnapshotDir({ outDir, env: {}, now: NOW, providers: [pheno()], fetchImpl: listFetch() });
  for (const r of regionRecords(outDir, 'phenocam')) {
    assert.equal(r.attribution, 'PhenoCam Network (CC BY)');
    assert.equal(r.officialUrl, `https://phenocam.nau.edu/webcam/sites/${r.providerId}/`);
    assert.equal(r.media.still, `https://phenocam.nau.edu/data/latest/${r.providerId}.jpg`);
  }
});

test('phenocam: a list that says there are more rows than it returned fails the provider (no half catalogue)', async () => {
  const outDir = tmpDir();
  for (const body of [{ ...PHENO_LIST, count: PHENO_LIST.results.length + 1 }, { ...PHENO_LIST, next: 'https://phenocam.nau.edu/api/cameras/?limit=2000&offset=2000' }]) {
    const result = await buildSnapshotDir({ outDir, env: {}, now: NOW, providers: [pheno()], fetchImpl: listFetch([], { phenoBody: body }) });
    assert.equal(result.providers[0].written, false);
    assert.match(result.providers[0].reason, /^fetch-error: PhenoCam paging incomplete/);
  }
  assert.deepEqual(listFiles(outDir), []);
});

test('phenocam: a failed fetch keeps the last good file and its index row byte for byte', async () => {
  const outDir = tmpDir();
  await buildSnapshotDir({ outDir, env: {}, now: NOW, providers: [pheno()], fetchImpl: listFetch() });
  const before = ['phenocam/us.json', 'index.json'].map((f) => readFileSync(join(outDir, f), 'utf8'));
  const later = () => '2026-10-05T12:00:00.000Z';
  for (const fetchImpl of [listFetch([], { down: [PHENO_URL] }), async () => { throw new Error('ECONNRESET'); },
    listFetch([], { phenoBody: { count: 0, next: null, results: [] } })]) {
    const result = await buildSnapshotDir({ outDir, env: {}, now: later, providers: [pheno()], fetchImpl });
    assert.equal(result.providers[0].written, false);
    assert.deepEqual(['phenocam/us.json', 'index.json'].map((f) => readFileSync(join(outDir, f), 'utf8')), before);
  }
});

test('aviationwx: one request for the airport list and none per image; one pin per webcam; credit is meta.attribution', async () => {
  const calls = [];
  const outDir = tmpDir();
  const result = await buildSnapshotDir({ outDir, env: {}, now: NOW, providers: [avwx()], fetchImpl: listFetch(calls) });
  assert.equal(result.providers[0].written, true);
  assert.deepEqual(calls, [{ url: AVWX_URL, method: 'GET' }], 'the rate limit is 50/min: the list only, never an image');
  assert.deepEqual(listFiles(outDir), ['aviationwx/us.json', 'index.json']);
  const file = readJson(join(outDir, 'aviationwx/us.json'));
  assert.deepEqual(snapshotProblems(file), []);
  assert.equal(file.layer, 'airportCameras');
  assert.equal(file.attribution, AVWX_LIST.meta.attribution);
  const records = expandSnapshot(file);
  const us = AVWX_LIST.airports.filter((a) => a.has_webcams && !a.unlisted && a.lat < 49.5);
  assert.equal(records.length, 107, 'live 2026-10-04: 51 airports, 108 webcams, one (lat 50.06) outside the US');
  assert.ok(us.length >= 50);
  assert.ok(records.every((r) => r.attribution === 'Weather data from AviationWX.org'));
  assert.ok(records.every((r) => /^https:\/\/[a-z0-9-]+\.aviationwx\.org\/$/.test(r.officialUrl)));
  assert.ok(records.every((r) => /^https:\/\/api\.aviationwx\.org\/v1\/airports\/[a-z0-9-]+\/webcams\/\d+\/image\?size=720$/.test(r.media.still)));
  assert.equal(new Set(records.map((r) => r.providerId)).size, records.length);
});

test('phenocam: a site named for the Gulf of Mexico stays; one ending in ", Canada" is dropped', async () => {
  const mk = (Sitename, d) => ({ Sitename, Lat: 29.3, Lon: -90.1, active: true, date_last: '2026-10-03', sitemetadata: { site_description: d } });
  const body = { count: 2, next: null, results: [mk('gulfsite', 'Marsh on the Gulf of Mexico, Louisiana'), mk('cansite', 'Field station, Ontario, Canada')] };
  const outDir = tmpDir();
  await buildSnapshotDir({ outDir, env: {}, now: NOW, providers: [pheno()], fetchImpl: listFetch([], { phenoBody: body }) });
  assert.deepEqual(regionRecords(outDir, 'phenocam').map((r) => r.providerId), ['gulfsite']);
});

test('aviationwx: a Canadian (C...) or Mexican (MM...) airport inside a US box is dropped', async () => {
  const mk = (id, icao) => ({ id, name: id, icao, lat: 42.3, lon: -83.0, has_webcams: true, webcam_count: 1, unlisted: false });
  const body = { success: true, meta: {}, airports: [mk('cyqg', 'CYQG'), mk('mmmx', 'MMMX'), mk('kdtw', 'KDTW'), mk('02id', null)] };
  const outDir = tmpDir();
  await buildSnapshotDir({ outDir, env: {}, now: NOW, providers: [avwx()], fetchImpl: listFetch([], { avwxBody: body }) });
  assert.deepEqual(regionRecords(outDir, 'aviationwx').map((r) => r.providerId).sort(), ['02id:0', 'kdtw:0']);
});

test('aviationwx: a failed fetch keeps the last good file; an unlisted airport is never published', async () => {
  const outDir = tmpDir();
  const hidden = { ...AVWX_LIST, airports: AVWX_LIST.airports.map((a, i) => (i === 0 ? { ...a, unlisted: true } : a)) };
  await buildSnapshotDir({ outDir, env: {}, now: NOW, providers: [avwx()], fetchImpl: listFetch([], { avwxBody: hidden }) });
  assert.ok(!regionRecords(outDir, 'aviationwx').some((r) => r.providerId.startsWith(`${AVWX_LIST.airports[0].id}:`)));
  const before = readFileSync(join(outDir, 'aviationwx/us.json'), 'utf8');
  for (const fetchImpl of [listFetch([], { down: [AVWX_URL] }), listFetch([], { avwxBody: { success: false, airports: [] } })]) {
    const result = await buildSnapshotDir({ outDir, env: {}, now: () => '2026-10-05T12:00:00.000Z', providers: [avwx()], fetchImpl });
    assert.equal(result.providers[0].written, false);
    assert.equal(readFileSync(join(outDir, 'aviationwx/us.json'), 'utf8'), before);
  }
});

test('budgets: both new providers beside the committed seeds stay under 256 KB a file, 16 KB index, 2 MB directory', async () => {
  const outDir = tmpDir();
  cpSync(new URL('../../static/data/quiet-corners-maps/cameras', import.meta.url), outDir, { recursive: true });
  const result = await buildSnapshotDir({ outDir, env: {}, now: NOW, providers: [pheno(), avwx()], fetchImpl: listFetch() });
  assert.deepEqual(result.providers.map((p) => p.written), [true, true]);
  const sizes = Object.fromEntries(listFiles(outDir).map((f) => [f, statSync(join(outDir, f)).size]));
  for (const f of ['phenocam/us.json', 'aviationwx/us.json']) assert.ok(sizes[f] <= BUDGETS.fileBytes, `${f} is ${sizes[f]}`);
  assert.ok(sizes['phenocam/us.json'] < BUDGETS.fileBytes * 0.75, 'headroom: the list can grow by a third before it grid-splits');
  assert.ok(sizes['index.json'] <= BUDGETS.indexBytes, `index.json is ${sizes['index.json']}`);
  const dirBytes = Object.values(sizes).reduce((n, s) => n + s, 0);
  assert.ok(dirBytes <= BUDGETS.dirBytes, `directory is ${dirBytes}`);
  assert.ok(dirBytes < BUDGETS.dirBytes * 0.75, `directory is ${dirBytes} of ${BUDGETS.dirBytes}`);
});

test('the committed phenocam and aviationwx files pass the shape check, carry the credit and no contact', () => {
  const dirPath = new URL('../../static/data/quiet-corners-maps/cameras/', import.meta.url).pathname;
  const index = readJson(join(dirPath, 'index.json'));
  for (const [provider, credit] of [['phenocam', 'PhenoCam Network (CC BY)'], ['aviationwx', 'Weather data from AviationWX.org']]) {
    const rows = index.files.filter((r) => r.provider === provider);
    assert.equal(rows.length, 1, provider);
    const bytes = readFileSync(join(dirPath, rows[0].file), 'utf8');
    const file = JSON.parse(bytes);
    assert.deepEqual(snapshotProblems(file), []);
    assert.equal(file.attribution, credit);
    assert.equal(rows[0].count, file.rows.length);
    assert.ok(!bytes.includes('@') && !/contact/i.test(bytes));
  }
});

// ---------------------------------------------------------------------------------------------
// Colorado (COtrip) road cameras. Nothing here touches the network; the fixture is real rows (see
// source-camera.test.mjs). The list is thinned to one camera per 0.025 degree cell (about 2.8 km)
// to fit the directory budget.
import { thinByCell, THIN_CELLS_PER_DEGREE } from './build-camera-snapshot.mjs';

const CO_ID = 'co-cotrip';
const coProvider = () => PROVIDERS.find((p) => p.id === CO_ID);
const CO_AT = '2026-10-05T12:00:00.000Z';

test('co: a keyless PROVIDERS row on the road-camera layer, appended after the existing ones', () => {
  const p = coProvider();
  assert.ok(p);
  assert.equal(p.layer, 'roadCameras');
  assert.equal(p.keyEnv, undefined);
  assert.equal(typeof p.fetch, 'function');
  assert.equal(p.source, 'https://cotg.carsprogram.org/cameras_v1/api/cameras');
});

test('thinByCell: one record per cell, the lowest numeric id wins, the dropped count comes back', () => {
  assert.equal(THIN_CELLS_PER_DEGREE, 40, 'a 0.025 degree cell, about 2.8 km');
  const at = (providerId, lat, lon) => ({ providerId, lat, lon });
  const { kept, dropped } = thinByCell([at('20', 33.501, -84.501), at('9', 33.505, -84.505), at('100', 33.509, -84.509), at('7', 33.6, -84.5)]);
  assert.deepEqual(kept.map((r) => r.providerId), ['7', '9'], 'sorted by id; 9 beats 20 and 100 by number, not by text');
  assert.equal(dropped, 2);
  assert.deepEqual(thinByCell([]), { kept: [], dropped: 0 });
});

test('co: a normal build is seed-only and sends the operator nothing', async () => {
  const calls = [];
  const result = await buildSnapshotDir({ outDir: tmpDir(), env: {}, now: NOW, sleep: async () => {}, seedOnly: true, providers: [coProvider()],
    fetchImpl: async (url, init) => { calls.push(`${init && init.method || 'GET'} ${url}`); return { ok: false, status: 404 }; } });
  assert.deepEqual(calls, []);
  assert.ok(result.providers.every((p) => !p.written && /seed-only/.test(p.reason)), JSON.stringify(result.providers));
});

test('co build: under --refresh-seeds it writes valid files with its credit, rights unverified and a picture on its host', async () => {
  const outDir = tmpDir();
  const heads = [];
  const fetchImpl = async (url, init) => {
    if (init && init.method === 'HEAD') { heads.push(String(url)); return { status: 200, headers: { get: (h) => (/content-type/i.test(h) ? 'image/jpeg' : null) } }; }
    if (url === carsFeed(CO_ID).listUrl) return jsonRes(CF.co);
    return { ok: false, status: 404 };
  };
  const result = await buildSnapshotDir({ outDir, env: {}, now: () => CO_AT, fetchImpl, sleep: async () => {}, checkStills: true, providers: [coProvider()] });
  assert.deepEqual(result.providers.map((p) => [p.id, p.written]), [[CO_ID, true]]);
  assert.ok(heads.length > 0 && heads.every((u) => new URL(u).origin === 'https://cocam.carsprogram.org'), heads.slice(0, 3).join());
  for (const row of readJson(join(outDir, 'index.json')).files) {
    const file = readJson(join(outDir, row.file));
    assert.deepEqual(snapshotProblems(file), [], row.file);
    assert.equal(file.attribution, 'Colorado DOT (COtrip)');
    assert.equal(file.rights, 'unverified');
    for (const cam of expandSnapshot(file)) assert.ok(cam.media.still.startsWith('https://'), cam.media.still);
  }
});

test('co committed seed: in the index, valid, credited and inside its 300 KB share', () => {
  const dir = new URL('../../static/data/quiet-corners-maps/cameras/', import.meta.url).pathname;
  const index = readJson(join(dir, 'index.json'));
  const rows = index.files.filter((r) => r.provider === CO_ID);
  assert.ok(rows.length >= 1, `${CO_ID} is in index.json`);
  let bytes = 0;
  let cams = [];
  for (const row of rows) {
    const text = readFileSync(join(dir, row.file), 'utf8');
    bytes += Buffer.byteLength(text);
    const file = JSON.parse(text);
    assert.deepEqual(snapshotProblems(file), [], row.file);
    assert.equal(file.rights, 'unverified');
    assert.ok(!text.trim().includes('\n'), `${row.file} is a single line`);
    cams = cams.concat(expandSnapshot(file));
  }
  assert.ok(bytes <= 300 * 1024, `added ${bytes} bytes, the share is 300 KB`);
  assert.ok(cams.length > 300);
  for (const cam of cams) assert.ok(cam.lat !== null && cam.lon !== null && cam.media.still, `${CO_ID} ${cam.providerId}`);
});

// Small state and city feeds: Kirkland rides the generic ArcGIS adapter and gate above (its fixture is
// merged into AGF); WSDOT's ferry terminal cameras are a custom list read through the Iteris GeoJSON reader.
test('ArcGIS small feeds: Kirkland is its own state file and a pin outside Washington is never published', () => {
  const regions = agProvider('wa-kirkland').regions({ features: AGF['wa-kirkland'] }, { fetchedAt: '2026-10-05T12:00:00Z' });
  assert.deepEqual(regions.map((r) => r.region), ['wa-kirkland-wa']);
  assert.ok(regions[0].records.length >= 3);
  assert.ok(regions[0].records.every((r) => r.provider === 'wa-kirkland'));
  const far = JSON.parse(JSON.stringify(AGF['wa-kirkland'].slice(0, 1)));
  far[0].geometry = { x: -122.2, y: -47.7 };
  assert.deepEqual(agProvider('wa-kirkland').regions({ features: far }, { fetchedAt: 'x' })[0].records, []);
});

import { fetchWsfCameras } from './build-camera-snapshot.mjs';
import { WSF_LAYER, normalizeIterisCameras as normalizeWsf } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-camera.js';

const WSFX = read('fixtures/wsf-2026-10-05.min.json');
const wsfFetch = (body = WSFX, calls = []) => async (url, init) => {
  calls.push({ url: String(url), init });
  return { ok: true, status: 200, json: async () => body };
};

test('WSF: a PROVIDERS row on the road-camera layer, keyless, one request for the list with the honest user agent', async () => {
  const p = agProvider('wa-wsf');
  assert.equal(p.layer, 'roadCameras');
  assert.equal(p.keyEnv, undefined);
  assert.match(p.officialUrl, /^https:\/\/www\.wsdot\.wa\.gov\/ferries\//);
  const calls = [];
  const got = await fetchWsfCameras(WSF_LAYER, { fetchImpl: wsfFetch(WSFX, calls) });
  assert.equal(got.ok, true);
  assert.equal(got.payload.features.length, WSFX.FeedContentList.length);
  assert.deepEqual(calls.map((c) => c.url), WSF_LAYER.listUrls);
  const headers = Object.fromEntries(Object.entries(calls[0].init.headers).map(([k, v]) => [k.toLowerCase(), v]));
  assert.equal(headers['user-agent'], ARCGIS_USER_AGENT);
  for (const forbidden of ['origin', 'referer', 'cookie', 'authorization']) assert.equal(headers[forbidden], undefined, forbidden);
});

test('WSF: an answer that is not the list, an empty list or a failing server fails the provider', async () => {
  for (const [name, fetchImpl] of [
    ['not the list', wsfFetch({ nope: 1 })],
    ['empty list', wsfFetch({ FeedContentList: [] })],
    ['503', async () => ({ ok: false, status: 503 })],
    ['throws', async () => { throw new Error('socket hang up'); }],
  ]) {
    const got = await fetchWsfCameras(WSF_LAYER, { fetchImpl });
    assert.equal(got.ok, false, name);
    assert.match(got.reason, /^fetch-error:/, name);
  }
});

test('WSF: only the terminals\' own /wsf/ pictures are published; a WSDOT road camera in the same list is not (no double listing)', () => {
  const road = WSFX.FeedContentList.filter((x) => !x.FerryCamera.ImgURL.includes('/wsf/'));
  const own = WSFX.FeedContentList.filter((x) => x.FerryCamera.ImgURL.includes('/wsf/'));
  assert.ok(road.length >= 2 && own.length >= 3, 'the fixture holds both kinds');
  const payload = { features: [...own, ...road].map((x) => x.FerryCamera).map((c) => ({ type: 'Feature',
    geometry: { type: 'Point', coordinates: [c.Lon, c.Lat] }, properties: { id: c.CamID, title: c.Title, image_url: c.ImgURL, active: c.IsActive } })) };
  const [region] = agProvider('wa-wsf').regions(payload, { fetchedAt: '2026-10-05T12:00:00Z' });
  assert.equal(region.region, 'wa-wsf-wa');
  assert.deepEqual(region.records.map((r) => r.providerId).sort(), own.map((x) => String(x.FerryCamera.CamID)).sort());
  assert.ok(region.records.every((r) => r.media.still.startsWith('https://images.wsdot.wa.gov/wsf/') && r.rights === 'unverified'));
  assert.ok(region.records.every((r) => r.attribution === 'Washington State Ferries (WSDOT)'));
  const inactive = JSON.parse(JSON.stringify(payload)); inactive.features[0].properties.active = false;
  assert.equal(normalizeWsf(inactive, WSF_LAYER, {}).length, own.length - 1, 'an inactive camera is dropped');
  const noPos = JSON.parse(JSON.stringify(payload)); noPos.features[0].geometry.coordinates = [null, null];
  assert.equal(normalizeWsf(noPos, WSF_LAYER, {}).length, own.length - 1, 'a camera with no position is dropped');
});

test('WSF: the still check asks only the registered picture host, four at a time, and drops a 404', async () => {
  const heads = []; let live = 0, peak = 0;
  const deadUrl = 'https://images.wsdot.wa.gov/wsf/lopez/approach.jpg';
  const fetchImpl = async (url, init) => {
    if (init && init.method === 'HEAD') {
      heads.push(String(url)); live += 1; peak = Math.max(peak, live);
      await new Promise((r) => setImmediate(r)); live -= 1;
      return { status: String(url) === deadUrl ? 404 : 200, headers: { get: (h) => (h === 'content-type' ? 'image/jpeg' : null) } };
    }
    return { ok: true, status: 200, json: async () => WSFX };
  };
  const outDir = tmpDir();
  const result = await buildSnapshotDir({ outDir, env: {}, now: NOW, sleep: async () => {}, checkStills: true,
    providers: [agProvider('wa-wsf')], fetchImpl });
  assert.ok(heads.length >= 3 && heads.every((u) => u.startsWith('https://images.wsdot.wa.gov/wsf/')), heads.join(' '));
  assert.ok(peak <= 4, `peak ${peak}`);
  assert.equal(result.providers[0].written, true, JSON.stringify(result.providers));
  const kept = result.providers[0].files.flatMap((f) => expandSnapshot(JSON.parse(readFileSync(join(outDir, f), 'utf8'))));
  assert.ok(kept.length >= 3 && kept.every((c) => c.media.still !== deadUrl), 'the 404 camera is not published');
  assert.equal(kept.length, heads.length - 1);
});

test('WSF: a deploy build (seedOnly) sends nothing and keeps the committed seed', async () => {
  const calls = [];
  const result = await buildSnapshotDir({ outDir: tmpDir(), env: {}, now: NOW, seedOnly: true,
    providers: [agProvider('wa-wsf')], fetchImpl: wsfFetch(WSFX, calls) });
  assert.deepEqual(calls, []);
  assert.ok(result.providers.every((p) => !p.written && /seed-only/.test(p.reason)), JSON.stringify(result.providers));
});

// ---------------------------------------------------------------------------------------------
// USGS VolcView + AVO ashcams and NOAA GLERL Great Lakes cameras. Both are seed-only: a normal
// build never contacts either operator; only --refresh-seeds reads the lists and HEADs each still.
// NDBC buoy cameras are NOT here: the image host (www.ndbc.noaa.gov/buoycam) answers 403 to the
// build's own honest User-Agent, and this build never spoofs another (see content/quiet-corners-maps.md).
import { ARCGIS_USER_AGENT as SCI_UA } from './build-camera-snapshot.mjs';

const SCI_VV = read('fixtures/volcview-2026-10-05.min.json');
const SCI_GL = read('fixtures/glerl-2026-10-05.min.json');
const SCI_AT = '2026-10-05T12:00:00.000Z';
const SCI_NOW = () => SCI_AT;
const VV_URL = 'https://volcview.wr.usgs.gov/ashcam-api/webcamApi/webcams';
const AVO_URL = 'https://avo.alaska.edu/ashcam-api/webcamApi/webcams';
const GL_URL = 'https://www.glerl.noaa.gov/metdata/';
const volc = () => PROVIDERS.find((p) => p.id === 'volcview');
const glerl = () => PROVIDERS.find((p) => p.id === 'glerl');
const sciFresh = (hours) => new Date(Date.parse(SCI_AT) - hours * 3600e3).toUTCString();

/** A recording fetch: GETs answer the fixture lists, HEADs answer per still (`head[url]` = status or
 *  { status, modified }); `stats.maxParallel` is the most HEADs ever in flight at once. */
function sciFetch({ calls = [], vv = SCI_VV.volcview, avo = SCI_VV.avo, html = SCI_GL.metdataHtml, head = {}, down = [] } = {}) {
  const stats = { parallel: 0, maxParallel: 0 };
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || null, init });
    if (down.includes(url)) return { ok: false, status: 503 };
    if (init.method === 'HEAD') {
      stats.parallel += 1; stats.maxParallel = Math.max(stats.maxParallel, stats.parallel);
      await new Promise((r) => { setImmediate(r); });
      stats.parallel -= 1;
      const h = head[url] ?? 200;
      const status = typeof h === 'number' ? h : h.status;
      const modified = typeof h === 'number' ? sciFresh(1) : h.modified;
      return { ok: status === 200, status, headers: { get: (k) => ({ 'content-type': 'image/jpeg', 'last-modified': modified })[k.toLowerCase()] ?? null } };
    }
    if (url === VV_URL) return { ok: true, status: 200, json: async () => vv };
    if (url === AVO_URL) return { ok: true, status: 200, json: async () => avo };
    if (url === GL_URL) return { ok: true, status: 200, text: async () => html };
    return { ok: false, status: 404 };
  };
  impl.calls = calls; impl.stats = stats;
  return impl;
}
const sciBuild = async (providers, opts = {}) => {
  const outDir = opts.outDir || tmpDir();
  const sleeps = [];
  const result = await buildSnapshotDir({ outDir, env: {}, now: SCI_NOW, providers, checkStills: true,
    sleep: async (ms) => { sleeps.push(ms); }, ...opts });
  return { outDir, result, sleeps };
};
const VV_KEPT = ['akutan_aksd', 'amchitka_aht', 'anchorPoint-N', 'anchorPoint-NE', 'augustine', 'crater-sinnott',
  'kilauea-f1-cam', 'kilauea-kw-cam', 'korovin_kowe', 'msh-dome', 'ys-bbsn'];

test('PROVIDERS: volcview and glerl are keyless rows on the research-camera layer with their own fetch and regions', () => {
  for (const [p, source] of [[volc(), VV_URL], [glerl(), 'https://www.glerl.noaa.gov/metdata/']]) {
    assert.ok(p, 'row exists');
    assert.equal(p.layer, 'phenoCameras');
    assert.equal(p.keyEnv, undefined);
    assert.equal(p.source, source);
    assert.equal(typeof p.fetch, 'function');
    assert.equal(typeof p.regions, 'function');
  }
  assert.equal(volc().officialUrl, 'https://volcview.wr.usgs.gov/');
  assert.equal(glerl().officialUrl, 'https://www.glerl.noaa.gov/metdata/');
});

test('volcview and glerl: a build without --refresh-seeds (or a deploy build) sends the operators nothing and keeps the seed', async () => {
  for (const extra of [{ checkStills: false }, { seedOnly: true, checkStills: false }]) {
    const f = sciFetch();
    const { result, outDir } = await sciBuild([volc(), glerl()], { ...extra, fetchImpl: f });
    assert.deepEqual(f.calls, [], 'a build must not contact USGS, AVO or NOAA');
    assert.ok(result.providers.every((p) => !p.written && /seed-only/.test(p.reason)), JSON.stringify(result.providers));
    assert.deepEqual(listFiles(outDir).filter((f) => f !== 'index.json'), [], 'no provider file is written');
  }
});

test('volcview refresh: two plain GETs with the build\'s own User-Agent, then a HEAD per candidate still, at most 4 at a time', async () => {
  mock.method(Date, 'now', () => Date.parse(SCI_AT));
  try {
    const f = sciFetch();
    const { outDir, result, sleeps } = await sciBuild([volc()], { fetchImpl: f });
    assert.equal(result.providers[0].written, true, JSON.stringify(result.providers));
    const gets = f.calls.filter((c) => c.method === 'GET');
    assert.deepEqual(gets.map((c) => c.url).sort(), [AVO_URL, VV_URL]);
    for (const c of f.calls) {
      assert.deepEqual(Object.keys(c.headers || {}), ['User-Agent'], `${c.url}: no Origin, Referer or browser header`);
      assert.equal(c.headers['User-Agent'], SCI_UA);
      assert.ok(!/Mozilla|Chrome|Safari/i.test(c.headers['User-Agent']));
    }
    const heads = f.calls.filter((c) => c.method === 'HEAD').map((c) => c.url);
    assert.equal(heads.length, VV_KEPT.length, 'only a camera that would be published is asked about');
    assert.ok(heads.every((u) => u.startsWith('https://volcview.wr.usgs.gov/ashcam-api/images/webcams/')));
    assert.ok(f.stats.maxParallel <= 4 && f.stats.maxParallel >= 2, `parallel HEADs: ${f.stats.maxParallel}`);
    assert.ok(sleeps.length >= 2 && sleeps.every((ms) => ms > 0), 'a pause between requests and between batches');
    assert.deepEqual(listFiles(outDir), ['index.json', 'volcview/ak-west.json', 'volcview/us.json']);
    const file = readJson(join(outDir, 'volcview/us.json'));
    const west = readJson(join(outDir, 'volcview/ak-west.json'));
    assert.deepEqual(snapshotProblems(file), []);
    assert.deepEqual(snapshotProblems(west), []);
    assert.deepEqual(expandSnapshot(west).map((r) => r.providerId), ['amchitka_aht']);
    const spans = readJson(join(outDir, 'index.json')).files.map((e) => e.bbox.maxLon - e.bbox.minLon);
    assert.ok(spans.every((w) => w <= 180), `no index file box is wider than 180 degrees of longitude: ${spans}`);
    assert.equal(file.layer, 'phenoCameras');
    assert.equal(file.operator, 'USGS VolcView');
    assert.equal(file.rights, 'unverified');
    assert.equal(file.officialUrl, 'https://volcview.wr.usgs.gov/');
    assert.ok(file.fields.includes('attribution'), 'each row credits its own owner');
    const rows = [...expandSnapshot(file), ...expandSnapshot(west)];
    assert.deepEqual(rows.map((r) => r.providerId).sort(), VV_KEPT);
    assert.equal(rows.find((r) => r.providerId === 'akutan_aksd').attribution, 'Alaska Volcano Observatory, via USGS VolcView');
    assert.ok(rows.every((r) => r.officialUrl.startsWith('https://volcview.wr.usgs.gov/ashcam-gui/webcam.html?webcam=')));
    assert.ok(!readFileSync(join(outDir, 'volcview/us.json'), 'utf8').includes('bearing'));
    assert.equal(readJson(join(outDir, 'index.json')).files.reduce((n, e) => n + e.count, 0), VV_KEPT.length);
  } finally { mock.restoreAll(); }
});

test('volcview refresh: a 404, a 403 (the host refuses the build agent) and a Last-Modified over a day old each drop that camera', async () => {
  mock.method(Date, 'now', () => Date.parse(SCI_AT));
  try {
    const still = (c) => `https://volcview.wr.usgs.gov/ashcam-api/images/webcams/${c}/current.jpg`;
    const head = { [still('akutan_aksd')]: 404, [still('augustine')]: 403, [`${still('msh-dome')}`.replace('.jpg', '.jpeg')]: { status: 200, modified: sciFresh(80) },
      [still('ys-bbsn')]: { status: 200, modified: sciFresh(23) } };
    const { outDir } = await sciBuild([volc()], { fetchImpl: sciFetch({ head }) });
    const ids = expandSnapshot(readJson(join(outDir, 'volcview/us.json'))).map((r) => r.providerId);
    assert.deepEqual(ids.sort(), VV_KEPT.filter((c) => !['akutan_aksd', 'augustine', 'msh-dome', 'amchitka_aht'].includes(c)));
  } finally { mock.restoreAll(); }
});

test('volcview refresh: every still refused leaves no file (the provider is dropped, not published empty)', async () => {
  mock.method(Date, 'now', () => Date.parse(SCI_AT));
  try {
    const head = Object.fromEntries(SCI_VV.volcview.webcams.map((w) => [w.currentImageUrl, 403]));
    const { outDir, result } = await sciBuild([volc()], { fetchImpl: sciFetch({ head }) });
    assert.equal(result.providers[0].written, false);
    assert.deepEqual(listFiles(outDir).filter((f) => f !== 'index.json'), [], 'no provider file is written');
  } finally { mock.restoreAll(); }
});

test('volcview refresh: either list failing fails the provider and keeps the last good file byte for byte', async () => {
  mock.method(Date, 'now', () => Date.parse(SCI_AT));
  try {
    const outDir = tmpDir();
    await sciBuild([volc()], { outDir, fetchImpl: sciFetch() });
    const before = ['volcview/us.json', 'index.json'].map((f) => readFileSync(join(outDir, f), 'utf8'));
    for (const down of [[VV_URL], [AVO_URL]]) {
      const { result } = await sciBuild([volc()], { outDir, fetchImpl: sciFetch({ down }) });
      assert.equal(result.providers[0].written, false, down[0]);
      assert.match(result.providers[0].reason, /fetch-error/);
      assert.deepEqual(['volcview/us.json', 'index.json'].map((f) => readFileSync(join(outDir, f), 'utf8')), before);
    }
    const { result } = await sciBuild([volc()], { outDir, fetchImpl: sciFetch({ avo: { webcams: 'x' } }) });
    assert.equal(result.providers[0].written, false, 'a list that is not a webcam list is an error, not an empty publish');
  } finally { mock.restoreAll(); }
});

test('volcview regions: Alaska west of the dateline and the territories are kept (Hawaii, Amchitka, Guam, Puerto Rico, Samoa yes; Canada and Mexico no), Guam in its own file', () => {
  const cam = (code, lat, lon) => ({ webcamCode: code, webcamName: code, latitude: lat, longitude: lon, externalUrl: null,
    currentImageUrl: `https://volcview.wr.usgs.gov/ashcam-api/images/webcams/${code}/current.jpg`,
    lastImageTimestamp: Date.parse(SCI_AT) / 1000 - 60 });
  const payload = { volcview: { webcams: [cam('guam', 13.47, 144.75), cam('hawaii', 19.4, -155.28), cam('amchitka', 51.38, 179.3),
    cam('semi', 52.7, -174.1), cam('lsitkin', 51.95, 178.5), cam('pr', 18.2, -66.5), cam('seattle', 47.6, -122.3),
    cam('alberta', 53.0, -114.0), cam('mexico', 24.0, -104.0), cam('kamchatka', 56.0, 160.0), cam('samoa', -14.3, -170.7)] }, avo: { webcams: [] } };
  const regions = volc().regions(payload, { fetchedAt: SCI_AT });
  // Guam goes to its own file, not the western Aleutians one, so neither file's box spans the Pacific.
  assert.deepEqual(regions.map((r) => [r.region, r.records.map((x) => x.providerId)]),
    [['us', ['hawaii', 'pr', 'samoa', 'seattle', 'semi']], ['ak-west', ['amchitka', 'lsitkin']], ['gu-mp', ['guam']]]);
});

test('volcview regions: Canadian points inside the rough Alaska and Washington boxes are dropped; the panhandle and Aleutians stay', () => {
  const cam = (code, lat, lon) => ({ webcamCode: code, webcamName: code, latitude: lat, longitude: lon, externalUrl: null,
    currentImageUrl: `https://volcview.wr.usgs.gov/ashcam-api/images/webcams/${code}/current.jpg`,
    lastImageTimestamp: Date.parse(SCI_AT) / 1000 - 60 });
  const payload = { volcview: { webcams: [cam('yukon', 60.7, -135.0), cam('bc', 49.05, -123.0), cam('juneau', 58.3, -134.4),
    cam('sitka', 57.05, -135.33), cam('ketchikan', 55.34, -131.64), cam('haines', 59.23, -135.45), cam('amchitka', 51.38, 179.3),
    cam('spurr', 61.3, -152.25), cam('rainier', 46.85, -121.76), cam('bham', 48.75, -122.48)] }, avo: { webcams: [] } };
  const regions = volc().regions(payload, { fetchedAt: SCI_AT });
  assert.deepEqual(regions.flatMap((r) => r.records.map((x) => x.providerId)).sort(), ['amchitka', 'bham', 'haines', 'juneau', 'ketchikan', 'rainier', 'sitka', 'spurr']);
});

test('volcview regions: Atlin, Stewart, Mount Edziza and Dease Lake (British Columbia) drop; Juneau, Sitka, Ketchikan, Haines, Skagway, Hyder and Yakutat stay', () => {
  const cam = (code, lat, lon) => ({ webcamCode: code, webcamName: code, latitude: lat, longitude: lon, externalUrl: null,
    currentImageUrl: `https://volcview.wr.usgs.gov/ashcam-api/images/webcams/${code}/current.jpg`,
    lastImageTimestamp: Date.parse(SCI_AT) / 1000 - 60 });
  const payload = { volcview: { webcams: [cam('atlin', 59.58, -133.7), cam('stewart', 55.94, -129.99), cam('edziza', 57.7, -130.6),
    cam('dease', 58.44, -130.0), cam('juneau', 58.3, -134.4), cam('sitka', 57.05, -135.33), cam('ketchikan', 55.34, -131.64),
    cam('haines', 59.23, -135.45), cam('skagway', 59.45, -135.3), cam('hyder', 55.906, -130.01), cam('yakutat', 59.55, -139.7)] }, avo: { webcams: [] } };
  const [region] = volc().regions(payload, { fetchedAt: SCI_AT });
  assert.deepEqual(region.records.map((r) => r.providerId), ['haines', 'hyder', 'juneau', 'ketchikan', 'sitka', 'skagway', 'yakutat']);
});

test('volcview regions: a camera east of the dateline (lon > 0) goes to its own ak-west region, so no file box crosses the antimeridian', () => {
  const cam = (code, lat, lon) => ({ webcamCode: code, webcamName: code, latitude: lat, longitude: lon, externalUrl: null,
    currentImageUrl: `https://volcview.wr.usgs.gov/ashcam-api/images/webcams/${code}/current.jpg`,
    lastImageTimestamp: Date.parse(SCI_AT) / 1000 - 60 });
  const payload = { volcview: { webcams: [cam('amchitka', 51.38, 179.3), cam('semi', 51.96, 179.65), cam('kanaga', 51.87, -176.7)] }, avo: { webcams: [] } };
  const regions = volc().regions(payload, { fetchedAt: SCI_AT });
  assert.deepEqual(regions.map((r) => [r.region, r.records.map((x) => x.providerId)]), [['us', ['kanaga']], ['ak-west', ['amchitka', 'semi']]]);
});

test('glerl refresh: the table page and a HEAD per still, plain GET and the build\'s own agent; at most 4 at a time', async () => {
  mock.method(Date, 'now', () => Date.parse(SCI_AT));
  try {
    const f = sciFetch();
    const { outDir, result, sleeps } = await sciBuild([glerl()], { fetchImpl: f });
    assert.equal(result.providers[0].written, true, JSON.stringify(result.providers));
    const gets = f.calls.filter((c) => c.method === 'GET');
    assert.deepEqual(gets.map((c) => c.url), [GL_URL]);
    for (const c of f.calls) assert.deepEqual(c.headers, { 'User-Agent': SCI_UA }, c.url);
    assert.equal(f.calls.filter((c) => c.method === 'HEAD').length, 53);
    assert.ok(f.stats.maxParallel <= 4 && f.stats.maxParallel >= 2);
    assert.ok(sleeps.length > 0);
    const file = readJson(join(outDir, 'glerl/us.json'));
    assert.deepEqual(snapshotProblems(file), []);
    assert.equal(file.layer, 'phenoCameras');
    assert.equal(file.operator, 'NOAA GLERL');
    assert.equal(file.attribution, 'NOAA Great Lakes Environmental Research Laboratory (GLERL)');
    assert.equal(file.rights, 'unverified');
    assert.equal(expandSnapshot(file).length, 53);
  } finally { mock.restoreAll(); }
});

test('glerl refresh: a still last modified years ago (the 2013 Muskegon cameras) and a 404 each drop that camera', async () => {
  mock.method(Date, 'now', () => Date.parse(SCI_AT));
  try {
    const u = (c) => `https://www.glerl.noaa.gov/metdata/cams/${c}.jpg`;
    const head = {};
    for (const c of ['mkg01', 'mkg02', 'mkg03', 'mkg04', 'mkg05', 'mkg07']) head[u(c)] = { status: 200, modified: 'Mon, 04 Mar 2013 15:00:00 GMT' };
    head[u('apn01')] = 404;
    const { outDir } = await sciBuild([glerl()], { fetchImpl: sciFetch({ head }) });
    const ids = expandSnapshot(readJson(join(outDir, 'glerl/us.json'))).map((r) => r.providerId);
    assert.equal(ids.length, 53 - 7);
    for (const gone of ['mkg01', 'mkg07', 'apn01']) assert.ok(!ids.includes(gone), gone);
    for (const kept of ['mkg08', 'apn02', 'wsl01']) assert.ok(ids.includes(kept), kept);
  } finally { mock.restoreAll(); }
});

test('glerl refresh: a page that answers an error fails the provider; memoFetch hands the page through as text', async () => {
  const { result } = await sciBuild([glerl()], { fetchImpl: sciFetch({ down: [GL_URL] }) });
  assert.equal(result.providers[0].written, false);
  assert.match(result.providers[0].reason, /fetch-error/);
  const res = await memoFetch(sciFetch())(GL_URL, { method: 'GET', headers: { 'User-Agent': SCI_UA } });
  assert.match(await res.text(), /Alpena/);
});

test('the committed volcview and glerl seeds pass the shape check, carry their credits, no bearing, only pinned picture hosts, and fit 150 KB', () => {
  const dir = new URL('../../static/data/quiet-corners-maps/cameras/', import.meta.url).pathname;
  let total = 0;
  for (const [provider, host, credit] of [['volcview', 'https://volcview.wr.usgs.gov/', /via USGS VolcView$|^USGS Volcano Hazards Program$/],
    ['glerl', 'https://www.glerl.noaa.gov/', /^NOAA Great Lakes Environmental Research Laboratory \(GLERL\)$/]]) {
    const text = readFileSync(join(dir, provider, 'us.json'), 'utf8');
    total += Buffer.byteLength(text);
    assert.equal(text.trimEnd().split('\n').length, 1, 'one compact line');
    const file = JSON.parse(text);
    assert.deepEqual(snapshotProblems(file), []);
    assert.equal(file.provider, provider);
    assert.equal(file.layer, 'phenoCameras');
    assert.equal(file.rights, 'unverified');
    const records = expandSnapshot(file);
    assert.ok(records.length >= 20, `${provider}: ${records.length}`);
    for (const r of records) {
      assert.ok(r.media.still.startsWith(host), r.media.still);
      assert.match(r.attribution, credit);
      assert.equal(r.bearing, null);
      assert.ok(r.lat !== null && r.lon !== null && !(r.lat === 0 && r.lon === 0));
    }
    assert.ok(readJson(join(dir, 'index.json')).files.some((r) => r.provider === provider && r.count === records.length), `${provider} is in index.json`);
  }
  assert.ok(total <= 150 * 1024, `added seeds are ${total} bytes`);
});
