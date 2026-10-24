// Every adapter that reads from a remote service ends on its own deadline, and a caller's
// cancel ends it as a cancel. One table, one never-answering fetch: a fetch that hangs is the
// failure this guards (the page waits on a pending note forever), so no adapter is tested
// against a slow-but-answering one here.
//
// An adapter that takes a `timeoutMs` is run with a small one in real time. One that does
// not is run on node:test mock timers, with the clock moved by its registry timeoutMs, so
// the table stays fast and still pins the value the adapter really uses. `rounds` is how many
// answers in a row the adapter waits for before it can finish (a count, then a page).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const M = '../../themes/headlessmode/static/js/quiet-corners-maps/';
const mod = async (name) => import(`${M}${name}.js`);
const { SOURCES, DEFAULT_SOURCE_TIMEOUT_MS } = await mod('source-registry');
const { pageThrough } = await mod('arcgis-pager');
const { fetchCellsForBbox, searchByName } = await mod('source-map-index');
const { fetchCaltransCctv } = await mod('camera-layer');
const { fetchAerial } = await mod('source-aerial');
const { fetchTerrain } = await mod('source-terrain');
const { fetchElevations, profileFor } = await mod('source-elevation');
const { fetchAqi } = await mod('source-aqi');
const { fetchAurora } = await mod('source-aurora');
const { loadEcoregions } = await mod('source-ecoregions');
const { fetchFire } = await mod('source-fire');
const { fetchSmoke } = await mod('source-smoke');
const { fetchFloodView } = await mod('source-flood-zones');
const { fetchJson: fetchGbif } = await mod('source-gbif');
const { createHillshadeFetcher, hillshadeRequestFor } = await mod('source-hillshade');
const landCover = await mod('source-land-cover');
const terrainSurface = await mod('source-terrain-surface');
const { fetchLayer: fetchMvum } = await mod('source-mvum');
const { fetchAlerts, alertsFor } = await mod('source-nws-alerts');
const { fetchFrameTime } = await mod('source-nws-radar');
const { fetchAccess } = await mod('source-padus');
const { createRoadNamesFetcher } = await mod('source-road-names');
const { fetchTiles } = await mod('source-usgs-topo');
const { fetchHourly } = await mod('source-weather');
const { fetchWetlands } = await mod('source-wetlands');
const { fetchStreamNames } = await mod('source-stream-names');
const { fetchBlmRecSites } = await mod('source-blm-rec-sites');
const { fetchCountyLines } = await mod('source-county-lines');
const { fetchFederalLand } = await mod('source-federal-land');
const { fetchRecSites } = await mod('source-rec-sites');
const { fetchRoadQualityReport } = await mod('source-road-basic');
const { fetchSurfaceOwnership } = await mod('source-surface-ownership');
const { fetchTrails } = await mod('source-trails');
const { fetchLandBoundaries } = await mod('source-land-boundaries');
const stateSources = await mod('state-sources');

const SLACK_MS = 250;
const SMALL_MS = 50;
const never = () => new Promise(() => {});
const flush = () => new Promise((resolve) => setImmediate(resolve));

const bbox = { minLon: -83.6, minLat: 35.0, maxLon: -83.4, maxLat: 35.2 };
const sheet = { id: 'S1', pixel: { width: 800, height: 600 } };
const feature = { id: 'r1', name: 'A trail', paths: [[[-83.5, 35.0], [-83.49, 35.01]]] };
const landPair = (() => {
  for (const state of stateSources.STATE_CODES) {
    for (const family of stateSources.LAYER_IDS) {
      const layer = stateSources.layerFor(state, family);
      if (layer && stateSources.isBrowserFetchable(layer) && stateSources.isSemanticallyUniform(layer)) return { state, family };
    }
  }
  throw new Error('no state layer is fetchable from a browser');
})();

// name, the registry source whose timeoutMs it must use (null: DEFAULT_SOURCE_TIMEOUT_MS), whether
// it takes `timeoutMs`, the sequential answers it waits for, and how to call it.
const ROWS = [
  { name: 'pageThrough', param: true, call: (o) => pageThrough({ url: 'x', params: {}, normalize: (r) => r, ...o }) },
  { name: 'fetchCellsForBbox', source: 'usgsQuadIndex', param: true, call: (o) => fetchCellsForBbox({ bboxLonLat: bbox, retries: 0, ...o }) },
  { name: 'searchByName', source: 'usgsQuadIndex', param: true, call: (o) => searchByName({ name: 'rainbow springs', ...o }) },
  { name: 'fetchStreamNames', source: 'nhdFlowlines', param: true, call: ({ fetchImpl, ...o }) => fetchStreamNames(bbox, { zoom: 13, fetch: fetchImpl, ...o }) },
  { name: 'fetchCaltransCctv', source: 'caltransCctv', call: (o) => fetchCaltransCctv(o) },
  { name: 'fetchAerial', source: 'usdaNaip', call: (o) => fetchAerial({ sheet, bboxLonLat: bbox, ...o }) },
  { name: 'fetchTerrain', source: 'usgs3dep', call: (o) => fetchTerrain({ sheet, bboxLonLat: bbox, ...o }) },
  { name: 'fetchElevations', source: 'usgs3dep', call: (o) => fetchElevations({ points: [[-83.5, 35.0]], ...o }) },
  { name: 'profileFor', source: 'usgs3dep', call: (o) => profileFor(feature, o) },
  { name: 'fetchAqi', source: 'epaAirNowAqi', call: ({ fetchImpl, signal }) => fetchAqi(bbox, { fetchImpl, signal }) },
  { name: 'fetchAurora', source: 'swpcAurora', call: (o) => fetchAurora(o) },
  { name: 'loadEcoregions', source: null, call: (o) => loadEcoregions(o) },
  { name: 'fetchFire', source: 'nifcFirePerimeters', call: ({ fetchImpl, signal }) => fetchFire(bbox, { fetchImpl, signal }) },
  { name: 'fetchSmoke', source: 'noaaHmsSmoke', call: ({ fetchImpl, signal }) => fetchSmoke(bbox, { fetchImpl, signal }) },
  { name: 'fetchFloodView', source: 'femaNfhl', call: ({ fetchImpl, signal }) => fetchFloodView(bbox, { fetchImpl, signal }) },
  { name: 'gbif fetchJson', source: 'gbifOccurrence', call: ({ fetchImpl, signal }) => fetchGbif('https://api.gbif.org/v1/x', { fetchImpl, signal }) },
  { name: 'createHillshadeFetcher', source: 'usgs3depHillshade', param: true, timeoutIn: 'factory',
    call: ({ fetchImpl, signal, timeoutMs }) => createHillshadeFetcher({ fetchImpl, ...(timeoutMs ? { timeoutMs } : {}) })
      .fetchImage(hillshadeRequestFor({ bboxLonLat: bbox, width: 400, height: 300 }), { signal }),
    verdict: (v) => v.status },
  { name: 'land-cover fetchSurface', source: 'nlcdLandCover',
    call: ({ fetchImpl, signal }) => landCover.fetchSurface(landCover.surfaceRequestFor({ bboxLonLat: bbox, width: 400, height: 300 }), { fetchImpl, signal }) },
  { name: 'land-cover fetchPoint', source: 'nlcdLandCover',
    call: ({ fetchImpl, signal }) => landCover.fetchPoint(landCover.pointRequestFor({ lon: -83.5, lat: 35.1 }), { fetchImpl, signal }) },
  { name: 'fetchMvum', source: 'usfsMvum', param: true, rounds: 2,
    call: (o) => fetchMvum({ layer: 'roads', bboxLonLat: bbox, retries: 0, ...o }) },
  { name: 'fetchAlerts', source: 'nwsAlerts', call: (o) => fetchAlerts({ lat: 35.1, lon: -83.5, ...o }), verdict: (v) => v.detail },
  { name: 'alertsFor', source: 'nwsAlerts', param: true, call: ({ fetchImpl, signal, timeoutMs }) => alertsFor({ lat: 35.1, lon: -83.5, fetchImpl, timeoutMs, signal }), verdict: (v) => v.detail },
  { name: 'fetchFrameTime', source: 'nwsRadar', call: (o) => fetchFrameTime(o) },
  { name: 'fetchAccess', source: 'padusPublicAccess', call: ({ fetchImpl, signal }) => fetchAccess(bbox, { fetchImpl, signal }) },
  { name: 'fetchRoadNames', source: 'usgsRoadNames', call: ({ fetchImpl, signal }) => createRoadNamesFetcher().fetchRoadNames({ bbox, zoom: 14, fetchImpl, signal }) },
  { name: 'terrain-surface fetchSlopeImage', source: 'usgs3depSurface',
    call: ({ fetchImpl, signal }) => terrainSurface.fetchSlopeImage(terrainSurface.slopeRequestFor({ bboxLonLat: bbox, width: 400, height: 300 }), { fetchImpl, signal }) },
  { name: 'terrain-surface fetchPoint', source: 'usgs3depSurface',
    call: ({ fetchImpl, signal }) => terrainSurface.fetchPoint({ lon: -83.5, lat: 35.1 }, 'slope', { fetchImpl, signal }) },
  { name: 'fetchTiles', source: 'usgsTopo', param: true,
    call: async (o) => { const r = await fetchTiles([{ key: '1/1/1', url: 'https://x.invalid/1' }], { retries: 0, ...o }); return r.results.get('1/1/1').error; } },
  { name: 'fetchHourly', source: 'nwsForecast', call: (o) => fetchHourly({ lat: 35.1, lon: -83.5, ...o }) },
  { name: 'fetchWetlands', source: 'fwsNwiWetlands', rounds: 2, call: ({ fetchImpl, signal }) => fetchWetlands({ bboxLonLat: bbox, fetchImpl, signal }) },
  // The pager callers have no timeoutMs of their own: the value they hand pageThrough is what is pinned.
  { name: 'fetchBlmRecSites', source: 'blmRecSites', call: (o) => fetchBlmRecSites({ bboxLonLat: bbox, ...o }) },
  { name: 'fetchCountyLines', source: 'usgsGovUnits', call: (o) => fetchCountyLines({ bboxLonLat: bbox, ...o }) },
  { name: 'fetchFederalLand', source: 'usgsGovUnits', call: (o) => fetchFederalLand({ family: 'nationalPark', bboxLonLat: bbox, ...o }) },
  { name: 'fetchRecSites', source: null, call: (o) => fetchRecSites({ bboxLonLat: bbox, ...o }) },
  { name: 'fetchRoadQualityReport', source: null, call: (o) => fetchRoadQualityReport({ bboxLonLat: bbox, ...o }) },
  { name: 'fetchSurfaceOwnership', source: 'usfsSurfaceOwnership', call: (o) => fetchSurfaceOwnership({ bboxLonLat: bbox, ...o }) },
  { name: 'fetchTrails', source: null, call: (o) => fetchTrails({ bboxLonLat: bbox, ...o }) },
  { name: 'fetchLandBoundaries', source: null, call: (o) => fetchLandBoundaries({ ...landPair, bboxLonLat: bbox, ...o }) },
];

const registryMs = (row) => (row.source ? SOURCES[row.source].timeoutMs : DEFAULT_SOURCE_TIMEOUT_MS);

/** Settles to {value} or {error}, and reports when it has. */
function watch(promise) {
  const out = { done: false };
  promise.then((value) => { out.done = true; out.value = value; }, (error) => { out.done = true; out.error = error; });
  return out;
}

/** Move the mock clock `ms`, then in 1 ms steps (the helper settles one macrotask after a
 *  deadline) until the call is done, for at most `steps` steps. */
async function advance(out, ms, steps = 25) {
  await flush();
  mock.timers.tick(ms);
  for (let i = 0; i < steps && !out.done; i += 1) { await flush(); mock.timers.tick(1); }
  await flush();
}

const looksLikeTimeout = (out, row) => {
  if (out.error) return !(out.error.name === 'AbortError') && /within \d+ ms|did not answer|time(d)? ?out/i.test(String(out.error.message));
  const text = row.verdict ? row.verdict(out.value) : out.value;
  return typeof text === 'string' && /within \d+ ms|did not answer|time(d)? ?out/i.test(text);
};

/** The call with no `timeoutMs` passed, on mock timers: not settled one tick short of the
 *  registry value, settled once it has passed. This is the value the adapter really uses. */
async function assertRegistryDeadline(t, row) {
  const ms = registryMs(row);
  const rounds = row.rounds || 1;
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const out = watch(row.call({ fetchImpl: never }));
  await flush();
  mock.timers.tick(ms - 1);
  await flush();
  assert.equal(out.done, false, `settled before its ${ms} ms deadline`);
  for (let r = 0; r < rounds && !out.done; r += 1) await advance(out, r === 0 ? 1 : ms);
  assert.ok(out.done, `still waiting ${rounds} x ${ms} ms in: the call has no deadline of its own`);
}

for (const row of ROWS) {
  const ms = registryMs(row);
  const rounds = row.rounds || 1;

  test(`${row.name} ends on its deadline when the service never answers`, async (t) => {
    if (row.param) {
      const t0 = Date.now();
      const out = watch(row.call({ fetchImpl: never, timeoutMs: SMALL_MS }));
      while (!out.done && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 5));
      assert.ok(out.done, 'still waiting after 5 s');
      assert.ok(Date.now() - t0 < SMALL_MS * rounds + SLACK_MS, `took ${Date.now() - t0} ms`);
      return;
    }
    await assertRegistryDeadline(t, row);
  });

  // The default is the moved value, so a row that takes `timeoutMs` is run once more without it.
  if (row.param) test(`${row.name} ends on its registry deadline when no timeoutMs is passed`, (t) => assertRegistryDeadline(t, row));

  test(`${row.name} ends as a cancel, not a timeout, when the caller aborts`, async (t) => {
    mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => mock.timers.reset());
    const caller = new AbortController();
    const out = watch(row.call({ fetchImpl: never, signal: caller.signal, ...(row.param ? { timeoutMs: ms } : {}) }));
    await flush();
    mock.timers.tick(5);
    await flush();
    assert.equal(out.done, false, 'settled with nobody asking');
    caller.abort();
    await advance(out, 0);
    assert.ok(out.done, 'a caller abort did not end the call');
    assert.equal(looksLikeTimeout(out, row), false, `ended as a timeout: ${out.error?.message ?? JSON.stringify(out.value)}`);
  });
}

// These four promise "never throws the map": a reader-asked layer whose area is missing or
// malformed reads as "no answer", it does not reject into the caller. Building the URL is part of
// the call, so it sits inside that promise too (B1 moved it out of the old try for three of them;
// fetchSmoke built it synchronously before any promise existed).
test('the never-throws adapters answer null for a missing or malformed area', async () => {
  const fetchImpl = async () => { throw new Error('no network in this test'); };
  for (const [name, fn] of [['fetchAqi', fetchAqi], ['fetchFire', fetchFire], ['fetchAccess', fetchAccess], ['fetchSmoke', fetchSmoke]]) {
    for (const bbox of [null, undefined, {}]) {
      let got;
      try { got = await fn(bbox, { fetchImpl }); } catch (e) { assert.fail(`${name}(${JSON.stringify(bbox)}) threw ${e.constructor.name}: ${e.message}`); }
      assert.equal(got, null, `${name}(${JSON.stringify(bbox)})`);
    }
  }
});

test('the table covers every source module that reads from a service', async () => {
  const { readdirSync } = await import('node:fs');
  const dir = new URL(M, import.meta.url);
  // Modules whose adapters are tested above through their exports, or that only build
  // requests, plus main.js (PR-B2) and the layer factories, which call these same adapters.
  const covered = [
    'arcgis-pager', 'source-map-index', 'source-terrain-names', 'source-stream-names', 'camera-layer',
    'source-aerial', 'source-terrain', 'source-elevation', 'source-aqi', 'source-aurora', 'source-ecoregions',
    'source-fire', 'source-smoke', 'source-flood-zones', 'source-gbif', 'source-hillshade', 'source-land-cover',
    'source-mvum', 'source-nws-alerts', 'source-nws-radar', 'source-padus', 'source-road-names',
    'source-terrain-surface', 'source-usgs-topo', 'source-weather', 'source-wetlands', 'source-blm-rec-sites',
    'source-county-lines', 'source-federal-land', 'source-rec-sites', 'source-road-basic',
    'source-surface-ownership', 'source-trails', 'source-land-boundaries',
  ];
  // Source modules that reached master after QQA-13 and still make their own raw calls (no-raw-fetch.test.mjs
  // lists them too). They have no deadline to pin yet; a row replaces the entry when each moves onto request.js.
  const pending = [
    'source-avalanche', 'source-nrhp', 'source-ntad-rail-airports',
    'source-nws-observations', 'source-snotel', 'source-stream-gauges',
  ];
  const { readFileSync } = await import('node:fs');
  const reaching = readdirSync(dir).filter((f) => f.startsWith('source-') && f.endsWith('.js'))
    .filter((f) => /\bfetchImpl\b|\bfetch:\s*fetchImpl/.test(readFileSync(new URL(f, dir), 'utf8')))
    .map((f) => f.replace(/\.js$/, ''));
  assert.deepEqual(reaching.filter((n) => !covered.includes(n) && !pending.includes(n)), [], 'add a row for the new source module');
  assert.deepEqual(pending.filter((n) => !reaching.includes(n)), [], 'no longer reads from a service: drop it from pending');
});
