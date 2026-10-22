// Tonight's sky, held to the U.S. Naval Observatory.
//
// S7 of the sky/weather plan wants sunset, the twilight boundaries, sunrise, moonrise/set,
// how much of the Moon is lit and when it is actually up — for any latitude and longitude,
// in the selected place's own time zone. Three things are easy to get wrong and each has a
// test here: a fixed UTC offset instead of a real zone (so a daylight-saving day runs 24
// hours and events land on the wrong date); a no-rise or polar day treated as a failure
// rather than a fact; and moon phase passed off as moonless hours.
//
// Reference values come from USNO's /api/rstt/oneday, fetched 2026-09-10, with the request
// URL recorded beside every case in fixtures/usno-sun-moon-reference.json. That service
// publishes civil twilight only, so nautical and astronomical twilight are checked for
// internal consistency instead — the same solar position the USNO comparison validates at
// −0.833° and −6°, read at −12° and −18°.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sunMoonForDay, sunAltitude } from '../../themes/headlessmode/static/js/quiet-corners-sky/sun-moon.js';

const REF = JSON.parse(readFileSync(new URL('fixtures/usno-sun-moon-reference.json', import.meta.url), 'utf8'));
const byId = (id) => REF.cases.find((c) => c.id === id);
// A minute or two is the honest budget for a low-precision series read against a service
// that rounds to the minute; above 60° a shallow horizon crossing turns the same position
// error into more clock time, so those cases get five. The budget is looser than the
// measurement: on 2026-09-10 every value below matched USNO to the rounded minute.
const TOL_MIN = 2, TOL_MIN_POLAR = 5;

const sky = (c) => sunMoonForDay({ lat: c.lat, lon: c.lon, date: c.date, timeZone: c.timeZone });
const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
function closeTo(got, want, tol, what) {
  assert.ok(got, `${what}: engine returned nothing, USNO says ${want}`);
  let d = Math.abs(minutes(got.local) - minutes(want));
  if (d > 720) d = 1440 - d; // a time either side of local midnight
  assert.ok(d <= tol, `${what}: engine ${got.local} vs USNO ${want} (${d} min > ${tol})`);
}

test('every USNO reference case matches: Sun, civil twilight, Moon and illumination', () => {
  for (const c of REF.cases) {
    const tol = c.polar ? TOL_MIN_POLAR : TOL_MIN, s = sky(c), m = s.moon;
    for (const [want, got, what] of [[c.sun.rise, s.sun.rise, 'sunrise'], [c.sun.set, s.sun.set, 'sunset'],
      [c.sun.civilBegin, s.sun.twilight.civil.morning, 'civil dawn'], [c.sun.civilEnd, s.sun.twilight.civil.evening, 'civil dusk'],
      [c.moon.rise, m.rise, 'moonrise'], [c.moon.set, m.set, 'moonset']]) if (want) closeTo(got, want, tol, `${c.id} ${what}`);
    if (!c.moon.rise) assert.equal(m.rise, null, `${c.id}: USNO lists no moonrise`);
    if (!c.moon.set) assert.equal(m.set, null, `${c.id}: USNO lists no moonset`);
    assert.equal(m.state, c.moon.state, `${c.id} moon state`);
    assert.ok(Math.abs(m.illuminatedPercent - c.fracillum) <= 1, `${c.id} illumination: ${m.illuminatedPercent}% vs USNO ${c.fracillum}%`);
  }
});

test('polar day and polar night are states a caller can read, not thrown errors', () => {
  const day = sky(byId('utqiagvik-polar-day'));
  assert.deepEqual([day.sun.state, day.sun.rise, day.sun.set], ['always-above', null, null]);
  assert.equal(day.sun.twilight.civil.state, 'always-above');
  const night = sky(byId('utqiagvik-polar-night'));
  assert.equal(night.sun.state, 'always-below');
  // USNO still gives civil twilight that date: the Sun reaches −6° without reaching the horizon.
  assert.equal(night.sun.twilight.civil.state, 'rises-and-sets');
  assert.equal(night.sun.twilight.astronomical.state, 'rises-and-sets');
  assert.equal(night.moon.state, 'always-above');
  assert.deepEqual(night.moon.aboveHorizon.map((i) => [i.fromDayStart, i.toDayEnd]), [[true, true]]);
});

test('the place’s own time zone decides the day, daylight saving included', () => {
  const c = byId('franklin-nc-spring-forward'), s = sky(c);
  assert.equal(s.day.hours, c.localDayHours); // 23, not 24
  // A fixed −4 offset would report a 00:03 moonrise here. In New York that instant is
  // 23:03 the previous evening, still EST, so this day has no moonrise at all.
  assert.deepEqual([s.moon.rise, s.moon.state], [null, 'no-rise']);
  // The day opens at 00:00 EST (05:00 UTC) and the Sun rises on EDT: the offset moves
  // inside the day, which is precisely what one fixed offset cannot express.
  const gap = (e) => new Date(e.ms).getUTCHours() - Number(e.local.slice(0, 2));
  assert.equal(s.day.start.utc, '2026-03-08T05:00:00.000Z');
  assert.deepEqual([gap(s.day.start), gap(s.sun.rise)], [5, 4]);
  assert.equal(sunMoonForDay({ ...c, date: '2026-11-01' }).day.hours, 25);
});

test('how lit the Moon is and when it is up are separate facts', () => {
  // New Moon: 0% lit, yet above the horizon most of the day. Phase alone cannot be read
  // as moonless hours, and calculated darkness is not a claim about cloud either.
  const s = sky(byId('franklin-nc-new-moon'));
  assert.equal(s.moon.illuminatedPercent, 0);
  assert.equal(s.moon.aboveHorizon.length, 1);
  assert.ok((s.moon.aboveHorizon[0].end.ms - s.moon.aboveHorizon[0].start.ms) / 3600000 > 12, 'the new Moon is up all day');
  assert.equal(Object.hasOwn(s, 'clouds'), false, 'clouds are a forecast, not an output of this module');
});

test('the twilight bands nest, and the astronomical one ends where the Sun is 18° down', () => {
  const s = sky(byId('franklin-nc-new-moon')), t = s.sun.twilight, at = (e) => minutes(e.local);
  const order = [t.astronomical.morning, t.nautical.morning, t.civil.morning, s.sun.rise,
    s.sun.set, t.civil.evening, t.nautical.evening, t.astronomical.evening].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the bands must nest around the day');
  for (const [name, depth] of [['civil', -6], ['nautical', -12], ['astronomical', -18]]) {
    for (const edge of ['morning', 'evening']) {
      const h = sunAltitude(t[name][edge].ms, 35.1826, -83.3815);
      assert.ok(Math.abs(h - depth) < 0.02, `${name} ${edge}: Sun at ${h}°, wanted ${depth}°`);
    }
  }
});

test('bad input throws, so a caller can tell a failure from a real empty answer', () => {
  const ok = { lat: 35.1826, lon: -83.3815, date: '2026-09-10', timeZone: 'America/New_York' };
  assert.throws(() => sunMoonForDay({ ...ok, lat: 95 }), /lat/);
  assert.throws(() => sunMoonForDay({ ...ok, lon: 'west' }), /lon/);
  assert.throws(() => sunMoonForDay({ ...ok, date: '9/10/2026' }), /date/);
  assert.throws(() => sunMoonForDay({ ...ok, timeZone: 'Mars/Olympus' }));
});
