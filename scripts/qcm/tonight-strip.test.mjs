// Tonight's sky as a reader reads it: the strings, not the ephemeris.
//
// sun-moon.js already holds the numbers to the U.S. Naval Observatory. What is easy to get
// wrong here is the sentence built from them, so every expectation below is templated from
// the engine's own output rather than re-pinning a USNO minute — a drifting number belongs
// to sun-moon.test.mjs, a drifting sentence belongs here.
//
// Three failures this file exists to stop: a null time rendering as a blank or a dash when
// the Moon simply never rose; moon phase passed off as moonless hours ("0% lit, so dark
// tonight" is wrong — the new Moon in the first case is up for thirteen hours); and a card
// that implies clear skies when it has no forecast on it at all. Cloud, wind and gusts live on the
// forecast card beside this one (sky-clouds.test.mjs); this card's slot stays genuinely empty and
// says so, and sky-card-resilience.test.mjs is what keeps a failure over there off these rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sunMoonForDay } from '../../themes/headlessmode/static/js/quiet-corners-sky/sun-moon.js';
import { tonightFacts, tonightHtml, localDate } from '../../themes/headlessmode/static/js/quiet-corners-sky/tonight.js';
import { layoutMarkup } from './helpers/layouts.mjs';

const REF = JSON.parse(readFileSync(new URL('fixtures/usno-sun-moon-reference.json', import.meta.url), 'utf8'));
const sky = (id) => {
  const c = REF.cases.find((x) => x.id === id);
  return sunMoonForDay({ lat: c.lat, lon: c.lon, date: c.date, timeZone: c.timeZone });
};
const rowsOf = (s) => Object.fromEntries(tonightFacts(s).map((r) => [r.key, r.value]));

test('an ordinary night gives the Sun, full darkness and the Moon one line each', () => {
  const s = sky('franklin-nc-new-moon'), f = rowsOf(s), t = s.sun.twilight.astronomical;
  assert.equal(f.sun, `Rises ${s.sun.rise.local}, sets ${s.sun.set.local}`);
  assert.equal(t.state, 'rises-and-sets');
  assert.equal(f.darkness, `Ends ${t.morning.local}, returns ${t.evening.local}`);
  assert.equal(f.moon, `Rises ${s.moon.rise.local}, sets ${s.moon.set.local}`);
  assert.equal(f.moonUp, `${s.moon.rise.local} to ${s.moon.set.local}`);
  assert.equal(f.moonLit, `${s.moon.illuminatedPercent}% lit (at midday)`);
});

test('no moonrise and no moonset are sentences, never a blank or a dash', () => {
  const noRise = sky('franklin-nc-moon-never-rises'), a = rowsOf(noRise);
  assert.equal(noRise.moon.state, 'no-rise');
  assert.equal(a.moon, `Sets ${noRise.moon.set.local}, and does not rise again today`);
  assert.equal(a.moonUp, `midnight to ${noRise.moon.set.local}`);

  const noSet = sky('franklin-nc-moon-never-sets'), b = rowsOf(noSet);
  assert.equal(noSet.moon.state, 'no-set');
  assert.equal(b.moon, `Rises ${noSet.moon.rise.local}, and stays up past midnight`);
  assert.equal(b.moonUp, `${noSet.moon.rise.local} to midnight`);

  for (const [key, value] of [...Object.entries(a), ...Object.entries(b)]) {
    assert.ok(/[a-z]/.test(value), `${key} rendered "${value}" — a reader needs words, not a gap`);
    assert.ok(!/\bnull\b|undefined|NaN/.test(value), `${key} leaked a missing value: "${value}"`);
  }
});

test('polar day and polar night read as plain statements about the sky', () => {
  const day = rowsOf(sky('utqiagvik-polar-day'));
  assert.equal(day.sun, 'Above the horizon all day — it neither rises nor sets today');
  assert.equal(day.darkness, 'None tonight — the Sun never drops 18° below the horizon');

  const nightSky = sky('utqiagvik-polar-night'), night = rowsOf(nightSky);
  assert.equal(night.sun, 'Below the horizon all day — it neither rises nor sets today');
  assert.equal(nightSky.moon.state, 'always-above');
  assert.equal(night.moon, 'Above the horizon all day — it neither rises nor sets today');
  assert.equal(night.moonUp, 'All day and all night');

  // Far enough north that the Sun never even climbs to 18° below the horizon.
  const deep = sunMoonForDay({ lat: 88, lon: 0, date: '2026-12-21', timeZone: 'UTC' });
  assert.equal(deep.sun.twilight.astronomical.state, 'always-below');
  assert.equal(rowsOf(deep).darkness, 'All day — the Sun stays more than 18° below the horizon');
});

test('how lit the Moon is and when it is up are two facts, never one verdict', () => {
  // The new Moon is 0% lit and above the horizon for thirteen hours of this day.
  const s = sky('franklin-nc-new-moon'), rows = tonightFacts(s);
  assert.equal(s.moon.illuminatedPercent, 0);
  const lit = rows.filter((r) => /lit/.test(r.value)), up = rows.filter((r) => r.key === 'moonUp');
  assert.equal(lit.length, 1, 'illumination belongs on exactly one line');
  assert.equal(up.length, 1, 'the above-horizon hours belong on exactly one line');
  assert.notEqual(lit[0].key, up[0].key, 'the two must not share a line');
  assert.ok(!/lit/.test(up[0].value), `"${up[0].value}" mixes phase into the hours the Moon is up`);

  const html = tonightHtml(s, { name: 'Macon County', timeZone: s.timeZone });
  assert.ok(!/\bso\b[^<.]*\bdark|dark[^<.]*\bbecause\b|no moonlight tonight/i.test(html),
    'the card must not argue darkness from phase');
  assert.ok(!/will be clear|clear skies|good seeing|cloud(?:less)? tonight/i.test(html),
    'the card has no forecast on it and must not imply one');
  assert.match(html, /not on this card/, 'the missing weather has to be said out loud');
  for (const r of rows) assert.ok(!/cloud|wind|gust|overcast|clear/i.test(r.value),
    `${r.key} prints a weather value this card does not have: "${r.value}"`);
  assert.match(html, /Macon County/);
  assert.match(html, new RegExp(s.timeZone.replace('/', '\\/')), 'the card names the zone its times are in');
});

test("the place's own calendar day decides what tonight is, not the reader's box", () => {
  // 03:00 UTC is still the previous evening in New York and already tomorrow at UTC+14.
  const at = Date.UTC(2026, 8, 10, 3, 0, 0);
  assert.equal(localDate('America/New_York', at), '2026-09-09');
  assert.equal(localDate('Pacific/Kiritimati', at), '2026-09-10');
  assert.equal(localDate('UTC', at), '2026-09-10');
});

test('the dashboard carries the strip, so a selected place has somewhere to report', () => {
  assert.match(layoutMarkup(), /id="qc-tonight"/, 'no host element for the card in any layout');
});
