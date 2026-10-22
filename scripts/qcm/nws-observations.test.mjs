// The NWS weather station context layer: temperature, wind and humidity as the newest
// observation each station in view has published. Measured 2026-10-20 against
// api.weather.gov (200 application/geo+json, CORS *). /stations has no bbox filter, so the
// station list is a build-time catalogue (scripts/qcm/build-nws-stations.mjs) and only
// /stations/{id}/observations/latest is read live, for at most 12 stations per view.
// Fixtures are the live responses (trimmed to a handful of stations).
//
// What the tests pin: the 12 are the ones nearest the view centre, ties broken by id; a null
// value or a quality-control 'X' (failed) reading is dropped and counted, never drawn; the
// card keeps the observation's own time and the fetch time apart; a failed request is a
// stated line; the build transform keeps airport-style ids and says what it skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SERVICE, MAX_STATIONS, MAX_BBOX_SQ_DEG, CATALOGUE_URL, requestHeaders, bboxAreaSqDeg, boxStatus,
  readCatalogue, stationsInView, observationUrl, readObservation, fetchObservations, cToF,
  kmhToMph, compass, cardLines, areaReport, observationLayer, observationReader, readerStrings,
  CONTEXT_ROW,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-nws-observations.js';
import { SOURCES, cspDirectivesFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { LAYER_BY_ID } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';
import { normalizeStations, serializeCatalogue } from './build-nws-stations.mjs';

const fx = (n) => JSON.parse(readFileSync(new URL(`fixtures/${n}`, import.meta.url), 'utf8'));
const page = fx('nws-stations-page-2026-10-20.min.json');
const ktys = fx('nws-observation-ktys-2026-10-20.min.json');
const FETCHED = Date.parse('2026-10-20T06:51:18Z');
const SMOKIES = { minLon: -84.5, minLat: 35.4, maxLon: -83.5, maxLat: 36.2 };

test('the source row is an observation feed on the NWS origin already approved, no key', () => {
  const s = SOURCES.nwsObservations;
  assert.ok(s, 'no nwsObservations source');
  assert.equal(s.kind, 'observation-feed');
  assert.equal(s.origin, SOURCES.nwsForecast.origin);
  assert.equal(s.claim, 'observation');
  assert.equal(s.dateBasis, 'feature-field');
  assert.equal(s.measuredOn, '2026-10-20');
  assert.equal(s.cors, 'star');
  assert.equal(s.limits.requiresKey, false);
  assert.equal(s.limits.maxStationsPerView, 12);
  assert.equal(MAX_STATIONS, 12);
  assert.ok(s.endpoints.latest.includes('{id}'));
  assert.ok(cspDirectivesFor()['connect-src'].includes(s.origin));
  assert.equal(SERVICE, s.serviceUrl);
});

test('the layer row is a screen-only context surface, off by default', () => {
  const l = LAYER_BY_ID.nwsObservations;
  assert.ok(l, 'no nwsObservations layer');
  assert.equal(l, CONTEXT_ROW);
  assert.equal(l.group, 'context');
  assert.equal(l.sourceId, 'nwsObservations');
  assert.equal(l.screenOnly, true);
  assert.equal(l.defaultOn, false);
  assert.equal(l.emptyMeans, 'ambiguous');
});

test('the one header is Accept, and the catalogue is a file this site serves', () => {
  assert.deepEqual(requestHeaders(), { Accept: 'application/geo+json' });
  assert.ok(CATALOGUE_URL.startsWith('/data/quiet-corners-maps/nws-stations/'));
});

test('the builder keeps four-character airport ids, rounds coordinates, and counts what it skips', () => {
  const r = normalizeStations(page);
  assert.deepEqual(r.rows.map((x) => x[0]), ['K0A9', 'KCHA']);
  assert.equal(r.skipped, 2, 'KINT1 (a river gauge, five characters) and AP016 (an APRS hobby station)');
  const cha = r.rows.find((x) => x[0] === 'KCHA');
  assert.equal(cha[1], 'Chattanooga, Lovell Field');
  assert.ok(cha[2] > 34 && cha[2] < 36 && cha[3] > -86 && cha[3] < -84);
  for (const x of r.rows) {
    for (const n of [x[2], x[3]]) assert.ok(String(n).split('.')[1].length <= 4, `${x[0]} ${n} over 4 decimals`);
  }
  const text = serializeCatalogue({ rows: r.rows, states: ['TN'], fetchedOn: '2026-10-20' });
  assert.deepEqual(JSON.parse(text).stations, r.rows);
  assert.equal(text.trim().split('\n').length, 3, 'two stations on the one data line, between a header and a closing line');
  const five = serializeCatalogue({ rows: [...r.rows, ...r.rows, r.rows[0]], states: ['TN'], fetchedOn: '2026-10-20' });
  assert.equal(five.trim().split('\n').length, 5, 'five stations, two to a line');
  assert.equal(JSON.parse(five).stations.length, 5);
  assert.equal(normalizeStations({ features: [] }).rows.length, 0);
  assert.equal(normalizeStations(null).rows.length, 0);
});

const STATIONS = [
  ['KAAA', 'A', 35.8, -84.0, 100], ['KBBB', 'B', 35.9, -84.0, 100], ['KCCC', 'C', 35.8, -83.9, 100],
  ['KZZZ', 'Far', 40, -100, 1], ['KDDD', 'D', 35.81, -84.0, 100],
];
test('the catalogue reader drops malformed rows and counts them', () => {
  const c = readCatalogue({ stations: [...STATIONS, ['KBAD', 'x', 'north', -84], ['', 'y', 35, -84], null] });
  assert.equal(c.stations.length, 5);
  assert.equal(c.dropped, 3);
  assert.deepEqual(c.stations[0], { id: 'KAAA', name: 'A', lat: 35.8, lon: -84, elevM: 100 });
  assert.equal(readCatalogue(null).stations.length, 0);
});

test('at most 12 stations, nearest the view centre first, ties by id', () => {
  assert.equal(bboxAreaSqDeg(SMOKIES) > 0, true);
  const c = readCatalogue({ stations: STATIONS }).stations;
  const v = stationsInView(c, SMOKIES);
  assert.equal(v.inView, 4, 'Far is outside the view');
  assert.equal(v.chosen.length, 4);
  const centre = { minLon: -84.1, minLat: 35.7, maxLon: -83.9, maxLat: 35.9 };   // centre 35.8,-84.0
  assert.deepEqual(stationsInView(c, centre).chosen.map((s) => s.id), ['KAAA', 'KDDD', 'KCCC', 'KBBB'], 'KAAA is exactly at the centre');
  const tie = readCatalogue({ stations: [['KTWO', 'b', 35.8, -84.1, 1], ['KONE', 'a', 35.8, -83.9, 1]] }).stations;
  assert.deepEqual(stationsInView(tie, centre).chosen.map((s) => s.id), ['KONE', 'KTWO'], 'equal distance falls to the id');
  const many = Array.from({ length: 40 }, (_, i) => ['K' + String(100 + i), 'n', 35.8 + i * 0.001, -84, 1]);
  const m = stationsInView(readCatalogue({ stations: many }).stations, SMOKIES);
  assert.equal(m.chosen.length, 12);
  assert.equal(m.inView, 40);
  assert.deepEqual(stationsInView(c, SMOKIES), stationsInView(c, SMOKIES), 'deterministic');
});

test('area is degrees squared and a view over the cap is refused before any request', async () => {
  assert.equal(MAX_BBOX_SQ_DEG, 25);
  assert.equal(boxStatus(SMOKIES).ok, true);
  const wide = { minLon: -90, minLat: 30, maxLon: -80, maxLat: 40 };
  assert.equal(boxStatus(wide).ok, false);
  let calls = 0;
  const r = await fetchObservations(readCatalogue({ stations: STATIONS }).stations, wide, { fetchImpl: async () => { calls += 1; throw new Error('no'); } });
  assert.equal(calls, 0);
  assert.equal(r.status, 'too-wide');
  assert.match(areaReport(r).text, /zoom in/i);
});

test('unit conversion: degrees C to F, km/h to mph, bearing to a compass point', () => {
  assert.equal(cToF(7), 44.6);
  assert.equal(cToF(0), 32);
  assert.ok(Math.abs(kmhToMph(5.544) - 3.4448) < 1e-3);
  assert.equal(compass(60), 'ENE');
  assert.equal(compass(0), 'N');
  assert.equal(compass(359), 'N');
  assert.equal(compass(180), 'S');
});

test('the live observation reads temperature, wind, humidity with its own time', () => {
  assert.equal(observationUrl('KTYS'), 'https://api.weather.gov/stations/KTYS/observations/latest');
  const o = readObservation(ktys);
  assert.equal(o.id, 'KTYS');
  assert.equal(o.name, 'Knoxville, McGhee Tyson Airport');
  assert.equal(o.timeMs, Date.parse('2026-10-20T06:25:00+00:00'));
  assert.deepEqual([o.lat, o.lon], [35.82, -83.98]);
  assert.equal(o.values.temperature.c, 7);
  assert.equal(o.values.temperature.qc, 'V');
  assert.equal(o.values.humidity.pct, 93);
  assert.equal(o.values.windDirection.deg, 60);
  assert.ok(Math.abs(o.values.windSpeed.kmh - 5.544) < 1e-9);
  assert.equal(o.values.windGust, undefined, 'a null gust is absent, not zero');
  assert.equal(o.dropped, 1, 'the null windGust is counted');
});

test('a quality-control X reading and a non-number are dropped and counted, never drawn', () => {
  const bad = structuredClone(ktys);
  bad.properties.temperature = { unitCode: 'wmoUnit:degC', value: 99, qualityControl: 'X' };
  bad.properties.relativeHumidity = { unitCode: 'wmoUnit:percent', value: 'wet', qualityControl: 'V' };
  const o = readObservation(bad);
  assert.equal(o.values.temperature, undefined);
  assert.equal(o.values.humidity, undefined);
  assert.equal(o.dropped, 3, 'temperature X, humidity not a number, gust null');
  assert.deepEqual(Object.keys(o.values).sort(), ['windDirection', 'windSpeed']);
  const noTime = structuredClone(ktys); noTime.properties.timestamp = 'soon';
  assert.equal(readObservation(noTime), null, 'no usable time means nothing is shown for that station');
  assert.equal(readObservation({ properties: {} }), null);
  const allGone = structuredClone(ktys);
  for (const k of ['temperature', 'windSpeed', 'windDirection', 'relativeHumidity']) allGone.properties[k].value = null;
  assert.equal(readObservation(allGone), null, 'a station with no readable value is not a marker');
  const mps = structuredClone(ktys); mps.properties.windSpeed = { unitCode: 'wmoUnit:m_s-1', value: 2, qualityControl: 'V' };
  assert.ok(Math.abs(readObservation(mps).values.windSpeed.kmh - 7.2) < 1e-9, 'metres per second are converted');
});

test('the card shows each value with its unit, the reading time and the fetch time on separate lines', () => {
  const lines = cardLines(readObservation(ktys), FETCHED);
  const text = lines.join('\n');
  assert.match(lines[0], /Knoxville, McGhee Tyson Airport/);
  assert.match(lines[0], /KTYS/);
  assert.match(text, /Temperature: 45 °F \(7 °C\)/);
  assert.match(text, /Wind: 3 mph \(6 km\/h\) from the ENE \(60°\)/);
  assert.match(text, /Relative humidity: 93%/);
  assert.match(text, /Observed 2026-10-20 06:25 UTC/);
  assert.match(text, /Fetched 2026-10-20 06:51 UTC/);
  assert.ok(lines.some((l) => /^Fetched/.test(l)), 'fetch time is its own line');
  assert.ok(!lines.some((l) => /Observed/.test(l) && /Fetched/.test(l)));
  assert.doesNotMatch(text, /before it was fetched/, 'a 26 minute old reading carries no age note');
  const old = structuredClone(ktys); old.properties.timestamp = '2026-10-18T06:25:00+00:00';
  assert.match(cardLines(readObservation(old), FETCHED).join('\n'), /2 days before it was fetched/);
});

test('a failed request is a stated line; a partial failure names how many stations did not answer', async () => {
  const stations = readCatalogue({ stations: STATIONS }).stations;
  const down = await fetchObservations(stations, SMOKIES, { fetchImpl: async () => { throw new Error('offline'); }, nowMs: FETCHED });
  assert.equal(down.status, 'unavailable');
  assert.match(areaReport(down).text, /did not answer/);
  const none = await fetchObservations([], SMOKIES, { fetchImpl: async () => { throw new Error('unused'); }, nowMs: FETCHED });
  assert.equal(none.status, 'empty');
  assert.match(areaReport(none).text, /no .*station/i);
  assert.match(areaReport(none).text, /rather than|not a statement/i);
  const some = await fetchObservations(stations, SMOKIES, { nowMs: FETCHED, fetchImpl: async (u) => (String(u).includes('/KAAA/')
    ? { ok: true, json: async () => ktys } : { ok: false, status: 404, json: async () => ({}) }) });
  assert.equal(some.status, 'ready');
  assert.equal(some.sites.length, 1);
  assert.equal(some.failed, 3);
  const t = areaReport(some).text;
  assert.match(t, /1 station/);
  assert.match(t, /3 .*did not answer/);
  assert.match(t, /Fetched 2026-10-20 06:51 UTC/);
  assert.equal(some.droppedValues, 1);
  assert.match(t, /1 reading/);
});

test('a view with more stations than the cap says only the nearest are shown', async () => {
  const many = readCatalogue({ stations: Array.from({ length: 30 }, (_, i) => ['K' + String(100 + i), 'n', 35.8 + i * 0.001, -84, 1]) }).stations;
  let asked = 0;
  const r = await fetchObservations(many, SMOKIES, { nowMs: FETCHED, fetchImpl: async () => { asked += 1; return { ok: true, json: async () => ktys }; } });
  assert.equal(asked, 12);
  assert.equal(r.inView, 30);
  assert.match(areaReport(r).text, /12 of 30 stations/);
  assert.match(areaReport(r).text, /nearest/i);
});

test('the layer draws one marker per station with a keyboard-reachable card', () => {
  const L = { layerGroup: () => ({ items: [], clearLayers() { this.items = []; } }),
    circleMarker: (ll, o) => ({ ll, o, popup: null, bindPopup(c) { this.popup = c; return this; }, addTo(g) { g.items.push(this); return this; } }) };
  const group = observationLayer(L);
  group.draw([readObservation(ktys)], FETCHED);
  assert.equal(group.items.length, 1);
  assert.ok(group.items[0].popup && group.items[0].o.keyboard !== false);
  group.draw([], FETCHED);
  assert.equal(group.items.length, 0);
});

test('the reader waits out a drag, and an answer for a view the reader left is dropped', async () => {
  const timers = [];
  const reader = observationReader({ fetchFn: async () => ({ status: 'ready', sites: [] }), waitMs: 5,
    setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
  const got = [];
  const first = reader.ask(SMOKIES, [], (r) => got.push(['a', r.status]));
  const second = reader.ask(SMOKIES, [], (r) => got.push(['b', r.status]));
  assert.equal(await first, false);
  await timers[1]();
  assert.equal(await second, true);
  assert.deepEqual(got, [['b', 'ready']]);
});

test('reader-facing strings call it an observation, never a forecast or a safety statement', () => {
  for (const s of readerStrings()) {
    assert.doesNotMatch(s, /\b(safe to|will (rise|fall|be)|expected to|forecast(ed)? (is|says))\b/i, s);
  }
  assert.match(SOURCES.nwsObservations.coverageSemantics, /not a forecast/i);
});
