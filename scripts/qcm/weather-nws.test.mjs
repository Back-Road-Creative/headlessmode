// NWS forecast layer. Every payload is fixtures/nws-api-2026-09-10.min.json, captured live that
// day; the URL, headers and status each came back with are in its own `_source` line, and the
// reasoning is in source-weather.js. No network here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  pointUrl, quantity, temperatureOf, windOf, normalizeHourly, fetchHourly,
  createForecastLoader, requestHeaders, NO_FORECAST, REFRESH_MS, POINT_REFRESH_MS,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-weather.js';

const F = JSON.parse(readFileSync(new URL('fixtures/nws-api-2026-09-10.min.json', import.meta.url), 'utf8'));
const P = F.hourly.properties.periods;
const POINT = 'https://api.weather.gov/points/33.2699,-85.8337';

test('a quantity is read from its unitCode, and a null value stays unknown', () => {
  assert.deepEqual(quantity(P[0].dewpoint), { value: 21.11111111111111, unit: 'degC' });
  assert.deepEqual(quantity(P[0].relativeHumidity), { value: 59, unit: 'percent' });
  // Real nulls from the raw grid captured the same minute: heatIndex nulled 7 of 130 values,
  // windChill was one null throughout, `weather` nulls its own visibility.
  const g = F.gridNullQuantities;
  assert.equal(quantity({ unitCode: g.heatIndex.uom, value: g.heatIndex.values[0].value }), null);
  assert.equal(quantity({ unitCode: g.windChill.uom, value: g.windChill.values[0].value }), null);
  assert.equal(quantity(g.weather.values[0].value[0].visibility), null);
  assert.equal(quantity(undefined), null);
  assert.equal(quantity(86), null, 'a bare number carries no unit and is not a quantity');
});
test('temperature is read in the unit the response states, in either shape', () => {
  assert.deepEqual(temperatureOf(P[0]), { value: 86, unit: 'degF', celsius: 30 });
  // The SAME grid seconds later with `Feature-Flags: forecast_temperature_qv`: a unit-coded
  // object in degC while `units` still reads "us" -- which is why unitCode is the source.
  assert.equal(F.hourlyTemperatureQv.properties.units, 'us');
  assert.deepEqual(temperatureOf(F.hourlyTemperatureQv.properties.periods[0]), { value: 30, unit: 'degC', celsius: 30 });
  assert.equal(temperatureOf({}), null, 'no temperature is unknown, not 0');
});
test('wind keeps a direction, no direction, a rounding floor and a range apart', () => {
  // Period 1 overnight: "0 mph" with an EMPTY windDirection. 0 mph is rounding to the
  // nearest 5 (the same hour in `units=si` said "5 km/h"), so it is a floor, not a calm.
  assert.deepEqual(windOf(P[0]), { from: null, minSpeed: 0, maxSpeed: 0, unit: 'mph', belowRoundingFloor: true, gust: null });
  assert.deepEqual(windOf(P[3]), { from: 'S', minSpeed: 5, maxSpeed: 5, unit: 'mph', belowRoundingFloor: false, gust: null });
  // A range, real, from the twice-daily product on the same grid the same minute.
  const ranged = windOf(F.twiceDailyRange.properties.periods[0]);
  assert.equal(ranged.minSpeed, 0);
  assert.equal(ranged.maxSpeed, 5);
  assert.equal(P.some((p) => 'windGust' in p), false, 'the hourly product carries no gusts');
  assert.deepEqual(windOf({}), { from: null, minSpeed: null, maxSpeed: null, unit: null, belowRoundingFloor: false, gust: null });
});
test('normalizing keeps every hour, its own offset, and its unknowns as unknown', () => {
  const f = normalizeHourly(F.hourly);
  assert.equal(f.hours.length, P.length, 'an hour must never be silently dropped');
  assert.equal(f.updateTime, '2026-09-10T23:36:22+00:00');
  assert.deepEqual(f.elevation, { value: 333.1464, unit: 'm' });
  const h = f.hours[0];
  assert.equal(h.startTime, '2026-09-10T18:00:00-05:00', "the forecast's own offset, kept");
  assert.deepEqual(h.temperature, { value: 86, unit: 'degF', celsius: 30 });
  assert.deepEqual(h.precipitationChance, { value: 20, unit: 'percent' });
  assert.equal(h.trend, null, 'temperatureTrend was null in all 156 periods, not "steady"');
  assert.equal(h.shortForecast, 'Slight Chance Showers And Thunderstorms');
  assert.equal(h.wind.from, null);
});

test('two steps, four decimals, and the only header a browser will let us send', async () => {
  assert.equal(pointUrl(33.269912, -85.833712), POINT, 'six decimals answered 301 to four');
  assert.equal(pointUrl(33.2699, -85.8337), POINT);
  // NWS 403s a request with no User-Agent and its preflight allows that header, but a browser
  // forbids script setting it and sends its own, which measured 200.
  assert.deepEqual(Object.keys(requestHeaders()).map((n) => n.toLowerCase()), ['accept']);
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(url);
    assert.equal(init.headers.Accept, 'application/geo+json');
    return { ok: true, status: 200, json: async () => (seen.length === 1 ? F.point : F.hourly) };
  };
  const res = await fetchHourly({ lat: 33.269912, lon: -85.833712, fetchImpl });
  assert.deepEqual(seen, [POINT, F.point.properties.forecastHourly]);
  assert.equal(res.timeZone, 'America/Chicago');
  assert.equal(res.nearest, 'Ashland, AL');
  assert.equal(res.hours.length, 6);
});
test('outside the United States there is no forecast here, and no crash', async () => {
  const notUs = async () => ({ ok: false, status: 404, json: async () => F.pointOutOfCoverage.body });
  const res = await fetchHourly({ lat: 48.8566, lon: 2.3522, fetchImpl: notUs });
  assert.equal(res.status, NO_FORECAST);
  assert.match(res.detail, /Unable to provide data for requested point/);
  assert.match(res.coverage, /United States/);
  assert.equal(res.hours, undefined, 'there is no forecast to show, not an empty one');
  // Anything else is a fault, and a fault is loud.
  const broken = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(fetchHourly({ lat: 33.2699, lon: -85.8337, fetchImpl: broken }), /503/);
});

// Deferred, because the point of the next test is controlling WHICH answer lands first.
const defer = () => { let r; const p = new Promise((res) => { r = res; }); return { p, resolve: r }; };
test('the late answer for a place you have left is discarded, and aborted', async () => {
  const a = defer(); const b = defer(); const signals = [];
  const load = async ({ lat, signal }) => { signals.push(signal); return lat === 1 ? a.p : b.p; };
  const loader = createForecastLoader({ load });
  const first = loader.request({ lat: 1, lon: 1 });
  const second = loader.request({ lat: 2, lon: 2 });
  b.resolve({ status: 'ok', label: 'B' });
  assert.equal((await second).label, 'B');
  a.resolve({ status: 'ok', label: 'A' });   // A's slower answer lands second
  const late = await first;
  assert.equal(late.status, 'superseded');
  assert.equal(late.label, undefined, "the superseded place's forecast is not returned");
  assert.equal(loader.current.label, 'B', 'the card still shows where the reader is');
  assert.equal(signals[0].aborted, true, 'the abandoned request is cancelled, not left running');
  assert.equal(signals[1].aborted, false);
});
test('a forecast is refetched on the hour, matching what NWS caches it for', async () => {
  assert.equal(REFRESH_MS, 3600 * 1000, 'the hourly product sends cache-control max-age=3600');
  assert.equal(POINT_REFRESH_MS, 24 * 3600 * 1000, '/points sends max-age=85988');
  let calls = 0; let now = 0;
  const loader = createForecastLoader({ now: () => now, load: async () => { calls++; return { status: 'ok' }; } });
  await loader.request({ lat: 1, lon: 1 });
  now += REFRESH_MS - 1;
  await loader.request({ lat: 1, lon: 1 });
  assert.equal(calls, 1, 'inside the hour the answer is reused');
  now += 2;
  await loader.request({ lat: 1, lon: 1 });
  assert.equal(calls, 2, 'past the hour it is refetched');
});
