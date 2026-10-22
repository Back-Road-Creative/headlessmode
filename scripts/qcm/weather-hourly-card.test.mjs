// The forecast card: the grid product's run-length encoding, and the sentences built from it. Payloads are
// captured, never invented — fixtures/nws-api-2026-09-10.min.json and nws-grid-2026-09-11.min.json, each
// carrying in its `_source` line the URL, status, size, headers and retrieval time it came back with. Four
// failures this stops: reading an interval as ONE hour (a captured windSpeed run spans PT20H); zipping series
// by index (49/44/82/84 entries over one span, so index 3 is a different hour in each); printing an absent
// field as a fact; and showing a forecast past its refresh window or the horizon as current.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  durationHours, expandSeries, horizonEnd, normalizeGrid, gridAt, normalizeHourly,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-weather.js';
import { conditionsFacts, conditionsHtml, fromDirection } from '../../themes/headlessmode/static/js/quiet-corners-sky/tonight.js';

const F = JSON.parse(readFileSync(new URL('fixtures/nws-api-2026-09-10.min.json', import.meta.url), 'utf8'));
const G = JSON.parse(readFileSync(new URL('fixtures/nws-grid-2026-09-11.min.json', import.meta.url), 'utf8'));
const hourly = { status: 'ok', timeZone: 'America/Chicago', ...normalizeHourly(F.hourly), grid: normalizeGrid(G) };
const rowsAt = (at, forecast = hourly) => Object.fromEntries(conditionsFacts(forecast, at).map((r) => [r.key, r.value]));

test('a run is expanded across every hour it covers, in days as well as hours', () => {
  assert.equal(durationHours('PT20H'), 20, 'one captured windSpeed entry spans twenty hours');
  assert.deepEqual(['P1D', 'P7DT8H', 'PT30M'].map(durationHours), [24, 176, 0],
    'P1D is a real captured run and P7DT8H the validTimes span; a form never sent is not guessed at');
  // Two captured windSpeed runs: 17:00Z for PT3H at 5.556, then 20:00Z for PT20H at 3.704.
  const speed = expandSeries(G.properties.windSpeed);
  assert.deepEqual([speed.unit, G.properties.windSpeed.values.length], ['km_h-1', 2], 'metric, in two runs');
  assert.equal(speed.hours.size, 23, 'three hours plus twenty, not two');
  assert.equal(speed.hours.get(Date.parse('2026-09-10T19:00:00Z')), 5.556);
  assert.deepEqual([speed.hours.get(Date.parse('2026-09-11T15:00:00Z')), speed.hours.has(Date.parse('2026-09-11T16:00:00Z'))],
    [3.704, false], 'the PT20H run reaches its last hour and not one hour past it');
  // windChill's captured run is a real null over the whole span. Unknown is absent, never 0.
  assert.equal(G.properties.windChill.values[0].value, null);
  assert.equal(expandSeries(G.properties.windChill).hours.size, 0, 'a null must not become 176 zeroes');
});

test('two fields with different run boundaries align by timestamp, never by index', () => {
  const p = G.properties, grid = normalizeGrid(G);
  assert.deepEqual(['windGust', 'windSpeed', 'windDirection', 'skyCover'].map((k) => p[k].values.length),
    [4, 2, 9, 14], 'four different entry counts over one span — the trap this test exists for');
  // Index 3 is a different hour in each series, so zipping would silently pair the wrong hours.
  assert.equal(p.windGust.values[3].validTime.split('/')[0], '2026-09-11T03:00:00+00:00');
  assert.equal(p.skyCover.values[3].validTime.split('/')[0], '2026-09-10T20:00:00+00:00');
  assert.deepEqual(gridAt(grid, Date.parse('2026-09-11T03:00:00Z')), {
    windDirection: { value: 170, unit: 'degree_(angle)' },   // hour 2 of the PT2H run that began 02:00Z
    windSpeed: { value: 3.704, unit: 'km_h-1' },             // hour 8 of the PT20H run that began 20:00Z
    windGust: { value: 11.112, unit: 'km_h-1' },             // the run that begins at this hour
    skyCover: { value: 49, unit: 'percent' },                // hour 1 of the PT1H run at this hour
  });
  // An hour one field does not cover stays absent for that field alone.
  const outside = gridAt(grid, Date.parse('2026-09-11T10:00:00Z'));
  assert.equal(outside.windSpeed.value, 3.704);
  assert.equal(outside.windGust, null, 'unknown for this field, not zero, and not the neighbour’s value');
});

test('the direction is the one the wind comes FROM, and an unstated one is not north', () => {
  assert.equal(fromDirection({ value: 160 }), 'south-southeast');
  assert.equal(fromDirection({ value: 0 }), 'north', '0 degrees IS north when it is stated');
  assert.deepEqual([fromDirection(null), fromDirection({ value: null })], [null, null], 'unstated is never north');
});

test('an ordinary hour reads as separate facts a reader can act on', () => {
  const f = rowsAt(Date.parse('2026-09-10T23:00:00Z'));
  assert.equal(f.hour, '6 PM CDT');
  // The hourly period here says "0 mph" with an EMPTY windDirection while the grid states 160 degrees
  // and 3.704 km/h for the same hour — which is why the grid is what the card reads.
  assert.equal(f.wind, 'From the south-southeast, 2 mph');
  assert.equal(f.gust, 'Peaks near 6 mph — a gust is a peak, not a sustained speed');
});

test('a field the forecast does not state says so, and never reads as zero or calm', () => {
  // 16:00Z is inside the provider's horizon but past the captured grid slice, so every field is
  // unknown. The capture's generatedAt is 16 hours earlier, which is the expired state's job and not
  // this test's, so the forecast is dated to the hour being asked about.
  const f = rowsAt(Date.parse('2026-09-11T16:00:00Z'), { ...hourly, generatedAt: '2026-09-11T16:00:00+00:00' });
  assert.equal(f.wind, 'Not stated for this hour');
  assert.equal(f.gust, 'Not stated for this hour — which is not the same as no gusts');
  for (const [key, value] of Object.entries(f)) {
    assert.ok(!/\b0%|\bcalm\b|\bnull\b|undefined|NaN/i.test(value), `${key} printed an absence as a number: "${value}"`);
  }
});

test('a forecast past its refresh window says it is stale instead of showing numbers', () => {
  const f = rowsAt(Date.parse(hourly.generatedAt) + 3600 * 1000 + 1);
  assert.deepEqual([f.wind, f.gust], [undefined, undefined], 'stale numbers are not shown as current');
  assert.equal(f.expired,
    'Issued 2026-09-10T23:53:21+00:00 and not refreshed since, so it is out of date — these numbers are not current.');
});

test('past the provider’s horizon the weather is absent and the astronomy still stands', () => {
  assert.equal(horizonEnd('2026-09-10T17:00:00+00:00/P7DT8H'), Date.parse('2026-09-18T01:00:00Z'));
  assert.deepEqual([horizonEnd(''), horizonEnd('not a span')], [null, null]);
  const f = rowsAt(Date.parse('2026-09-18T02:00:00Z'), { ...hourly, generatedAt: '2026-09-18T01:00:00+00:00' });
  assert.equal(f.horizon, 'Weather not available yet — this forecast reaches September 17 and no further. '
    + 'The calculated sun and moon times still stand.');
  assert.deepEqual([f.wind, f.gust], [undefined, undefined]);
});

test('the card shows the coverage state rather than an empty hour, and adds no control or motion', () => {
  const none = conditionsFacts({ status: 'no-forecast-here', coverage: 'There is no forecast for this location.' }, Date.now());
  assert.equal(none.length, 1);
  const html = conditionsHtml(hourly, { name: 'Macon County' }, Date.parse('2026-09-10T23:00:00Z'));
  assert.match(html, /Macon County/);
  assert.match(html, /comes FROM/, 'the from-direction is said out loud');
  assert.ok(!/\bclear skies\b|good seeing|dark(?:ness)? tonight/i.test(html),
    'wind and gusts are not a verdict about the sky being clear');
  // Clouds landed with the resilient-sky unit; the row and its unknown state are sky-clouds.test.mjs's
  // subject. What stays this file's is that adding them did not turn the card into a verdict.
  assert.match(html, /Cloud cover/, 'the cloud row is on the card now');
  assert.ok(!/\bwill be clear\b|cloudless/i.test(html), 'a cloud percentage is not a promise of a clear sky');
  assert.ok(!/<(?:button|input|select|a|details|summary)\b/i.test(html),
    'nothing here is interactive, so there is no keyboard path to get wrong');
  assert.ok(!/transition|animation|@keyframes/i.test(html), 'nothing moves, so there is no reduced-motion case');
});
