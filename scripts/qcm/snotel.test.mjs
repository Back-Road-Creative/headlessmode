// The SNOTEL snowpack layer: snow depth (SNWD) and snow water equivalent (WTEQ) at USDA NRCS
// SNOTEL sites, from the AWDB REST service. Measured 2026-10-20 (GET): the SNTL station list answers
// 200, CORS *, 407,574 bytes for 919 active sites in 13 Western states, so it is a build-time
// catalogue (scripts/qcm/build-snotel-stations.mjs); /v1/data answers many stations in ONE request,
// daily values with their own date, and omits an element a site does not report. Fixtures are live
// answers, trimmed. What the tests pin: the origin reaches connect-src; a screen-only mark row in the
// federal group; the 12 nearest are asked, in one request; a zero is a zero and a missing element is
// "not reported", never 0; a stale day is spelled out; an empty view says "no SNOTEL site here", not
// "no snow"; and NRCS is named in the privacy page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SNOTEL_MAX_STATIONS, SNOTEL_MAX_BBOX_SQ_DEG, snotelBoxStatus, readCatalogue, snotelUrl, readSnotel,
  fetchSnotel, snotelCardLines, snotelReport, snotelLayer, SNOTEL_ROW, readerStrings,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-snotel.js';
import { SOURCES, cspDirectivesFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { LAYER_BY_ID, LAYERS, LAYERS_WITH_DRAPE, drapeKindFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';
import { capabilityNotices } from '../../themes/headlessmode/static/js/quiet-corners-maps/terrain-overlays.js';
import { SYMBOL_BY_KEY } from '../../themes/headlessmode/static/js/quiet-corners-maps/legend.js';
import { normalizeStations, serializeCatalogue } from './build-snotel-stations.mjs';

const fx = (n) => JSON.parse(readFileSync(new URL(`fixtures/${n}`, import.meta.url), 'utf8'));
const stationsRaw = fx('snotel-stations-2026-10-20.min.json');
const data = fx('snotel-data-2026-10-20.min.json');
const text = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const FETCHED = Date.parse('2026-10-20T08:24:00Z');
const CO_BOX = { minLon: -106.5, minLat: 38.5, maxLon: -105.5, maxLat: 39.5 };
const CO3 = { minLon: -108, minLat: 37.5, maxLon: -105, maxLat: 40.2 };   // Alta Lakes, Black Mesa, Lake Eldora
const catalogue = () => readCatalogue(JSON.parse(serializeCatalogue({ ...normalizeStations(stationsRaw), states: ['x'], fetchedOn: '2026-10-20' }))).stations;

test('the source row is a keyless observation feed on wcc.sc.egov.usda.gov, which reaches connect-src once', () => {
  const s = SOURCES.usdaSnotel;
  assert.ok(s, 'no usdaSnotel source');
  assert.equal(s.kind, 'observation-feed');
  assert.equal(s.origin, 'https://wcc.sc.egov.usda.gov');
  assert.equal(s.cors, 'star');
  assert.equal(s.claim, 'observation');
  assert.equal(s.dateBasis, 'feature-field');
  assert.equal(s.measuredOn, '2026-10-20');
  assert.equal(s.limits.requiresKey, false);
  assert.equal(s.limits.maxStationsPerView, 12);
  assert.deepEqual([...s.elements], ['SNWD', 'WTEQ']);
  assert.match(s.endpoints.data, /\/awdbRestApi\/services\/v1\/data$/);
  assert.equal(SNOTEL_MAX_STATIONS, 12);
  const connect = cspDirectivesFor(SOURCES)['connect-src'] || [];
  assert.equal(connect.filter((o) => o === 'https://wcc.sc.egov.usda.gov').length, 1);
  assert.match(s.coverageSemantics, /Western/);
  assert.match(s.coverageSemantics, /no SNOTEL site/i);
});

test('the row is a screen-only mark layer in the federal group, with one resolving point symbol', () => {
  assert.equal(LAYER_BY_ID.snotelSnowpack.id, SNOTEL_ROW.id);
  assert.ok(LAYERS.includes(LAYER_BY_ID.snotelSnowpack));
  assert.equal(SNOTEL_ROW.group, 'federal');
  assert.notEqual(SNOTEL_ROW.group, 'reading');
  assert.equal(SNOTEL_ROW.sourceId, 'usdaSnotel');
  assert.equal(SNOTEL_ROW.screenOnly, true);
  assert.equal(SNOTEL_ROW.notIn3d, true);
  assert.equal(SNOTEL_ROW.defaultOn, false);
  assert.equal(SNOTEL_ROW.status, 'live');
  assert.equal(SNOTEL_ROW.symbolKeys.length, 1);
  assert.equal(SYMBOL_BY_KEY[SNOTEL_ROW.symbolKeys[0]].kind, 'point');
  assert.equal(drapeKindFor(SNOTEL_ROW), false);
  assert.deepEqual(capabilityNotices(LAYERS_WITH_DRAPE, { snotelSnowpack: true }, {}).map((n) => [n.id, n.status]), [['snotelSnowpack', 'available-2d']]);
});

test('the caveat says the sites are Western and alpine and that an empty view is not "no snow"', () => {
  const c = SNOTEL_ROW.coverageCaveat;
  assert.match(c, /Western/);
  assert.match(c, /alpine|high-elevation|mountain/i);
  assert.match(c, /most Eastern counties have none/i);
  assert.match(c, /no SNOTEL site here/i);
  assert.match(c, /not that there is no snow/i);
  assert.match(snotelReport({ status: 'empty' }).text, /no SNOTEL site here/i);
  assert.match(snotelReport({ status: 'empty' }).text, /not .*no snow/i);
});

test('the build transform keeps active SNTL sites and the few fields the layer needs', () => {
  const { rows, skipped } = normalizeStations([...stationsRaw, { stationTriplet: '9:XX:SNTL', name: 'No position' },
    { stationTriplet: '5:CO:SCAN', name: 'Wrong network', latitude: 38, longitude: -105, elevation: 1 }]);
  assert.equal(skipped, 2);
  assert.equal(rows.length, 5);
  const r = rows.find((x) => x[0] === '1344:CO');
  assert.deepEqual(r, ['1344:CO', 'Alta Lakes', 37.8893, -107.8448, 11290]);
  assert.ok(JSON.stringify(rows).length < 600, 'no raw field (huc, county, shefId) is kept');
  const file = serializeCatalogue({ rows, states: ['CO'], fetchedOn: '2026-10-20' });
  const back = JSON.parse(file);
  assert.equal(back.stations.length, 5);
  assert.deepEqual(back.columns, ['id', 'name', 'lat', 'lon', 'elevFt']);
  assert.ok(file.split('\n').length < 8, 'rows are packed several to a line');
});

test('the catalogue reads back to stations and drops a malformed row, counted', () => {
  const got = readCatalogue({ stations: [['1:CO', 'A', 38, -106, 9000], ['bad'], ['2:CO', 'B', 'x', -106, 1]] });
  assert.equal(got.stations.length, 1);
  assert.equal(got.dropped, 2);
  assert.equal(got.stations[0].elevFt, 9000);
  assert.equal(readCatalogue(null).stations.length, 0);
});

test('one request asks the 12 nearest sites with the measured elements and a dated window, no key', () => {
  const u = new URL(snotelUrl(['1344:CO', '1186:CO'], FETCHED));
  assert.equal(u.origin, 'https://wcc.sc.egov.usda.gov');
  assert.equal(u.pathname, '/awdbRestApi/services/v1/data');
  assert.equal(u.searchParams.get('stationTriplets'), '1344:CO:SNTL,1186:CO:SNTL');
  assert.equal(u.searchParams.get('elements'), 'SNWD,WTEQ');
  assert.equal(u.searchParams.get('duration'), 'DAILY');
  assert.equal(u.searchParams.get('beginDate'), '2026-10-13');
  assert.equal(u.searchParams.get('endDate'), '2026-10-20');
  assert.doesNotMatch(u.search, /key=|token=/i);
});

test('the newest usable day wins per element; zero is a reading; an absent element is absent', () => {
  const sites = readSnotel(data);
  assert.equal(sites.length, 5);
  const alta = sites.find((s) => s.id === '1344:CO');
  assert.equal(alta.snowDepthIn.v, 7);
  assert.equal(alta.snowDepthIn.date, '2026-10-18');
  assert.equal(alta.sweIn.v, 1.7);
  const zero = sites.find((s) => s.id === '1186:CO');
  assert.equal(zero.snowDepthIn.v, 0, 'a zero depth is a measured zero');
  assert.equal(zero.sweIn.v, 0.4);
  const ak = sites.find((s) => s.id === '957:AK');
  assert.ok(ak.snowDepthIn && ak.snowDepthIn.v > 0);
  assert.equal(ak.sweIn, null, 'the feed omitted WTEQ for this site; it is not 0');
  const dirty = readSnotel([{ stationTriplet: '1:CO:SNTL', data: [{ stationElement: { elementCode: 'SNWD' },
    values: [{ date: '2026-10-19', value: 4 }, { date: '2026-10-20', value: null }, { date: '2026-10-21', value: 'x' }, { date: 'bad', value: 3 }] }] },
  { stationTriplet: '2:CO:SNTL', data: [] }, null]);
  assert.equal(dirty.length, 1);
  assert.equal(dirty[0].snowDepthIn.v, 4, 'null, non-number and bad-date entries are skipped');
  assert.deepEqual(readSnotel(null), []);
});

test('the card spells out inches and metric, a zero, a missing element and a stale day', () => {
  const [alta, zero] = readSnotel(data);
  const site = (s, id) => ({ ...s, name: id });
  const lines = snotelCardLines(site(alta, 'Alta Lakes'), FETCHED);
  assert.equal(lines[0], 'Alta Lakes, 1344:CO');
  assert.ok(lines.some((l) => /Snow depth: 7 in \(18 cm\)/.test(l)), lines.join('|'));
  assert.ok(lines.some((l) => /Snow water equivalent: 1\.7 in \(43 mm\)/.test(l)), lines.join('|'));
  assert.ok(lines.some((l) => /Reading for 2026-10-18/.test(l)));
  assert.ok(lines.some((l) => /Fetched 2026-10-20 08:24 UTC/.test(l)));
  assert.ok(lines.some((l) => /2 days before/.test(l)), 'a two-day-old daily value is said to be old');
  const zl = snotelCardLines(site(zero, 'Black Mesa'), FETCHED);
  assert.ok(zl.some((l) => /Snow depth: 0 in \(0 cm\)/.test(l)), zl.join('|'));
  const ak = readSnotel(data).find((s) => s.id === '957:AK');
  const al = snotelCardLines({ ...ak, name: 'AK' }, FETCHED);
  assert.ok(al.some((l) => /Snow water equivalent: not reported/.test(l)), al.join('|'));
  assert.ok(al.every((l) => !/null|undefined|NaN/.test(l)));
});

test('a view over the area cap is never requested; an empty view and failures are stated', async () => {
  assert.equal(SNOTEL_MAX_BBOX_SQ_DEG, 25);
  assert.equal(snotelBoxStatus(CO3).ok, true);
  assert.equal(snotelBoxStatus({ minLon: -120, minLat: 30, maxLon: -100, maxLat: 45 }).ok, false);
  let asked = 0;
  const spy = async () => { asked += 1; return { ok: true, json: async () => data }; };
  const cat = catalogue();
  assert.equal((await fetchSnotel(cat, { minLon: -120, minLat: 30, maxLon: -100, maxLat: 45 }, { fetchImpl: spy })).status, 'too-wide');
  assert.equal(asked, 0);
  const east = await fetchSnotel(cat, { minLon: -84.2, minLat: 35.8, maxLon: -83.6, maxLat: 36.2 }, { fetchImpl: spy });
  assert.equal(east.status, 'empty');
  assert.equal(asked, 0, 'no site in view, no request');
  assert.equal((await fetchSnotel(cat, CO3, { fetchImpl: async () => ({ ok: false, status: 503 }) })).status, 'unavailable');
  assert.equal((await fetchSnotel(cat, CO3, { fetchImpl: async () => { throw new Error('x'); } })).status, 'unavailable');
  const got = await fetchSnotel(cat, CO3, { fetchImpl: spy, nowMs: FETCHED });
  assert.equal(got.sites.length, 3, 'only the chosen sites are kept, though the fixture answers five');
  assert.equal(got.status, 'ready');
  assert.equal(asked, 1, 'one request for all chosen sites');
  assert.ok(got.sites.every((s) => s.name && Number.isFinite(s.lat) && Number.isFinite(s.lon)));
  assert.match(snotelReport({ status: 'too-wide' }).text, /25 square degrees/);
  assert.match(snotelReport({ status: 'unavailable' }).text, /did not answer/);
  assert.match(snotelReport({ status: 'catalogue-unavailable' }).text, /did not load/);
  assert.match(snotelReport(got).text, /Fetched 2026-10-20 08:24 UTC/);
});

test('the nearest 12 are chosen when more are in view, and the report says so', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `${i}:CO`, name: `S${i}`, lat: 39 + i * 0.01, lon: -106, elevFt: 9000 }));
  let url = null;
  const got = await fetchSnotel(many, CO_BOX, { fetchImpl: async (u) => { url = u; return { ok: true, json: async () => [] }; }, nowMs: FETCHED });
  assert.equal(decodeURIComponent(new URL(url).searchParams.get('stationTriplets')).split(',').length, 12);
  assert.equal(got.status, 'unavailable', 'a 200 with no usable site is not a blank map');
  const sites = readSnotel(data).map((s) => ({ ...s, name: 'n', lat: 39, lon: -106 }));
  assert.match(snotelReport({ status: 'ready', sites, inView: 30, shown: 12, failed: 0, fetchedMs: FETCHED }).text, /12 of 30 sites/);
  assert.match(snotelReport({ status: 'ready', sites, inView: 5, shown: 5, failed: 2, fetchedMs: FETCHED }).text, /2 sites .*no usable reading/);
});

test('the Leaflet group draws one keyboard-reachable marker per site and sets text, not markup', () => {
  const made = [];
  const L = {
    layerGroup: () => ({ clearLayers() { made.length = 0; } }),
    circleMarker: (pt, o) => { const x = { pt, o, bindPopup(c) { x.card = c; return x; }, addTo() { made.push(x); return x; } }; return x; },
  };
  const g = snotelLayer(L);
  g.draw(readSnotel(data).map((s) => ({ ...s, name: 'n', lat: 39, lon: -106 })), FETCHED);
  assert.equal(made.length, 5);
  assert.equal(made[0].o.keyboard, true);
  g.draw([], null);
  assert.equal(made.length, 0);
});

test('every reader-facing string is plain text and claims neither avalanche nor travel safety', () => {
  const all = readerStrings();
  assert.ok(all.length > 8);
  for (const s of all) {
    assert.doesNotMatch(s, /[<>]/, s);
    assert.doesNotMatch(s, /\b(safe to|avalanche (danger|forecast) is|good skiing|passable)\b/i, s);
  }
  assert.match(SNOTEL_ROW.coverageCaveat, /not an avalanche/i);
  assert.match(SNOTEL_ROW.coverageCaveat, /Screen only/);
});

test('the docs, the privacy page and the control register name the layer and NRCS', () => {
  assert.match(text('content/quiet-corners-maps.md'), /\*\*SNOTEL snowpack\*\*/);
  assert.match(text('content/privacy.md'), /USDA Natural Resources Conservation Service/);
  const reg = JSON.parse(text('scripts/qcm/control-register.json'));
  assert.ok(reg.derived.layerCheckboxes.rows.snotelSnowpack, 'no control-register row for snotelSnowpack');
  assert.match(reg.derived.layerCheckboxes.rows.snotelSnowpack.effect, /Snowpack at SNOTEL sites/);
  const py = text('scripts/test_qc_privacy_accuracy.py');
  assert.match(py, /"usda\.gov": "Forest Service",.*NRCS/, 'the suffix map line carries a comment about NRCS');
});
