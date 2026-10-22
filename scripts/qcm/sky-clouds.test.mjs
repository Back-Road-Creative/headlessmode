// Cloud cover on the hourly conditions card: the forecast grid's own `skyCover` series, and the
// ways a percentage goes wrong. Payloads are captured, never invented —
// fixtures/nws-grid-2026-09-11.min.json carries skyCover as `wmoUnit:percent` in fourteen PT1H runs
// reaching across local midnight, its `_source` line naming the URL, status, size and retrieval
// time. The two daylight-saving cases are the one exception: no captured payload spans a clock
// change, so they keep the captured SHAPE — `{ uom, values: [{ validTime, value }] }`, UTC offsets
// and all — and move only the timestamps.
//
// Five failures this file exists to stop: an hour the grid does not cover printing as 0% (a clear
// sky the forecast never promised); a value in some other unit printed as a percentage; a real
// forecast 0 being swallowed as "unknown"; the two 1 AMs of a fall-back night collapsing onto one
// value; and an hour after local midnight reading as the previous evening's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GRID_FIELDS, expandSeries, normalizeGrid, gridAt, normalizeHourly,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-weather.js';
import { conditionsFacts, conditionsHtml, cloudPercentOf } from '../../themes/headlessmode/static/js/quiet-corners-sky/tonight.js';

const F = JSON.parse(readFileSync(new URL('fixtures/nws-api-2026-09-10.min.json', import.meta.url), 'utf8'));
const G = JSON.parse(readFileSync(new URL('fixtures/nws-grid-2026-09-11.min.json', import.meta.url), 'utf8'));
const hourly = { status: 'ok', timeZone: 'America/Chicago', ...normalizeHourly(F.hourly), grid: normalizeGrid(G) };
const rowsAt = (at, forecast = hourly) => Object.fromEntries(conditionsFacts(forecast, at).map((r) => [r.key, r.value]));

/** The captured payload with its skyCover series swapped for `runs`, everything else untouched:
 *  the same `uom` shape, the same wind series beside it, and the captured `P7DT8H` horizon moved to
 *  start where the runs do — the horizon state is its own test and must not swallow these. */
const withSky = (runs, uom = 'wmoUnit:percent') => ({
  ...hourly,
  validTimes: `${runs[0].validTime.split('/')[0]}/P7DT8H`,
  grid: normalizeGrid({ properties: { ...G.properties, skyCover: { uom, values: runs } } }),
});
const hourRuns = (isoHours, values) => isoHours.map((t, i) => ({ validTime: `${t}/PT1H`, value: values[i] }));
/** The rows for one hour, with the forecast dated to that hour: the refresh window is its own test
 *  (weather-hourly-card.test.mjs) and a captured `generatedAt` would expire every hour but its own. */
const at = (iso, forecast = hourly) => rowsAt(Date.parse(iso), { ...forecast, generatedAt: iso });

test('skyCover rides the same grid as the wind, expanded by interval and aligned by time', () => {
  assert.ok(GRID_FIELDS.includes('skyCover'), 'the card cannot read a field the grid reader does not carry');
  const sky = expandSeries(G.properties.skyCover);
  assert.deepEqual([sky.unit, G.properties.skyCover.values.length, sky.hours.size], ['percent', 14, 14],
    'fourteen PT1H runs, in the unit the service states');
  const grid = normalizeGrid(G);
  assert.deepEqual(gridAt(grid, Date.parse('2026-09-10T23:00:00Z')).skyCover, { value: 39, unit: 'percent' });
  // windGust's runs start and end elsewhere; an hour one field covers and the other does not stays
  // independently present or absent, which is why the fields are matched by timestamp.
  assert.equal(gridAt(grid, Date.parse('2026-09-11T10:00:00Z')).skyCover, null,
    'unknown for this field, not zero, and not the neighbouring hour’s value');
});

test('an ordinary hour states the cloud cover as a percentage of sky', () => {
  assert.equal(rowsAt(Date.parse('2026-09-10T23:00:00Z')).cloud, '39% of the sky forecast covered');
});

test('an hour the grid does not state is unknown, and never a clear sky', () => {
  // 16:00Z is inside the provider's horizon but past the captured grid slice, so the field is absent.
  const f = rowsAt(Date.parse('2026-09-11T16:00:00Z'), { ...hourly, generatedAt: '2026-09-11T16:00:00+00:00' });
  assert.equal(f.cloud, 'Not stated for this hour — which is not the same as a clear sky');
  assert.ok(!/\b0\s*%/.test(f.cloud), `an absence printed as a number: "${f.cloud}"`);
});

test('a forecast zero is a real zero and is printed, not swallowed as unknown', () => {
  const f = at('2026-09-10T17:00:00Z', withSky(hourRuns(['2026-09-10T17:00:00+00:00'], [0])));
  assert.equal(f.cloud, '0% of the sky forecast covered', 'a stated 0 is a forecast, not a missing value');
  assert.equal(cloudPercentOf({ value: 0, unit: 'percent' }), 0);
  assert.equal(cloudPercentOf(null), null);
});

test('a percentage is printed only when the grid says percent', () => {
  // The captured series is wmoUnit:percent. A run of eighths under any other unit read as a
  // percentage would print 3% for a sky three-eighths covered.
  assert.equal(cloudPercentOf({ value: 3, unit: 'okta' }), null);
  const f = at('2026-09-10T17:00:00Z', withSky(hourRuns(['2026-09-10T17:00:00+00:00'], [3]), 'wmoUnit:okta'));
  assert.equal(f.cloud, 'Not stated for this hour — which is not the same as a clear sky',
    'a unit this card cannot read is unknown, never a number in the wrong scale');
});

test('the two 1 AMs of a fall-back night keep their own hours and their own values', () => {
  // America/Chicago returns to standard time at 07:00Z on 2026-11-01: local 1 AM happens twice,
  // once at 06:00Z as CDT and again at 07:00Z as CST. Epoch hours keep them apart; a local-clock
  // key would put one value in both, or lose one.
  const runs = hourRuns(['2026-11-01T05:00:00+00:00', '2026-11-01T06:00:00+00:00',
    '2026-11-01T07:00:00+00:00', '2026-11-01T08:00:00+00:00'], [10, 20, 30, 40]);
  const forecast = withSky(runs);
  assert.equal(expandSeries({ uom: 'wmoUnit:percent', values: runs }).hours.size, 4, 'four real hours, not three');
  const first = at('2026-11-01T06:00:00Z', forecast), second = at('2026-11-01T07:00:00Z', forecast);
  assert.deepEqual([first.hour, first.cloud], ['1 AM CDT', '20% of the sky forecast covered']);
  assert.deepEqual([second.hour, second.cloud], ['1 AM CST', '30% of the sky forecast covered'],
    'the second 1 AM is its own hour with its own cloud');
});

test('the hour a spring-forward night skips is never printed', () => {
  // 2026-03-08: 2 AM CST never happens — 07:00Z is 1 AM CST and 08:00Z is already 3 AM CDT.
  const forecast = withSky(hourRuns(['2026-03-08T07:00:00+00:00', '2026-03-08T08:00:00+00:00'], [25, 75]));
  const one = at('2026-03-08T07:00:00Z', forecast), three = at('2026-03-08T08:00:00Z', forecast);
  assert.deepEqual([one.hour, three.hour], ['1 AM CST', '3 AM CDT']);
  assert.deepEqual([one.cloud, three.cloud], ['25% of the sky forecast covered', '75% of the sky forecast covered']);
  assert.ok(!/2 AM/.test(`${one.hour}${three.hour}`), 'an hour the zone skipped must not be invented');
});

test('a run crossing local midnight lands on the next day’s hours, not the previous evening’s', () => {
  // The captured series runs 17:00Z 2026-09-10 to 06:00Z 2026-09-11, straight across midnight in
  // the place's own zone: 04:00Z is 11 PM and 05:00Z is 12 AM the next day.
  const evening = at('2026-09-11T04:00:00Z'), after = at('2026-09-11T05:00:00Z');
  assert.deepEqual([evening.hour, evening.cloud], ['11 PM CDT', '45% of the sky forecast covered']);
  assert.deepEqual([after.hour, after.cloud], ['12 AM CDT', '46% of the sky forecast covered']);
});

test('past the provider’s horizon there is no cloud number, said as a date rather than a blank', () => {
  const f = rowsAt(Date.parse('2026-09-18T02:00:00Z'), { ...hourly, generatedAt: '2026-09-18T01:00:00+00:00' });
  assert.equal(f.horizon, 'Weather not available yet — this forecast reaches September 17 and no further. '
    + 'The calculated sun and moon times still stand.');
  assert.equal(f.cloud, undefined, 'no hour, so no cloud value to state');
});

test('the card names cloud cover and keeps it a forecast rather than a verdict', () => {
  const html = conditionsHtml(hourly, { name: 'Macon County' }, Date.parse('2026-09-10T23:00:00Z'));
  assert.match(html, /Cloud cover/, 'the row has to be labelled');
  assert.match(html, /39% of the sky forecast covered/);
  assert.ok(!/Cloud cover is not here yet/.test(html), 'the card carries clouds now; the old apology must go');
  assert.ok(!/\bclear skies\b|good seeing|you will see/i.test(html),
    'a percentage is not a promise about what a reader will see');
});
