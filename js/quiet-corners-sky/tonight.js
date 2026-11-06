// Tonight's sky for the place a reader picked, in sentences. sun-moon.js owns the arithmetic;
// this file owns nothing but the words, and its whole job is to keep three facts apart.
//
// Darkness, moonlight and cloud are separate. How much of the Moon is lit does not say when
// it is above the horizon — a new Moon can be up for thirteen hours — and neither says
// anything about cloud. So illumination and the above-horizon hours get a line each, and the
// forecast row is left out rather than guessed at: clouds, wind and gusts are the forecast
// card at the foot of this file, and this one says out loud that it does not have them.
// The two cards are deliberately fed apart as well as written apart — sky-cards.js keeps a
// weather failure from taking the calculated times down with it.
//
// A missing time always arrives from the engine with a `state` saying why, and every one of
// the five reads as a sentence here. A dash would tell a reader nothing.
import { sunMoonForDay } from './sun-moon.js';
import { HOUR_MS, REFRESH_MS, gridAt, horizonEnd } from '../quiet-corners-maps/source-weather.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** The calendar day it is at `timeZone` right now — the place's own day, so "tonight" does
 *  not slip to yesterday for a reader whose own clock is hours away from the map. */
export function localDate(timeZone, at = Date.now()) {
  const p = {};
  for (const q of new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(at)) p[q.type] = q.value;
  return `${p.year}-${p.month}-${p.day}`;
}

// Rise and set for either body. The odd states name the horizon rather than a time, because
// that is the fact: "it never rose" is an answer, not a failure to compute one.
const RISE_SET = {
  'rises-and-sets': (b) => `Rises ${b.up.local}, sets ${b.down.local}`,
  'no-rise': (b) => `Sets ${b.down.local}, and does not rise again today`,
  'no-set': (b) => `Rises ${b.up.local}, and stays up past midnight`,
  'always-above': () => 'Above the horizon all day — it neither rises nor sets today',
  'always-below': () => 'Below the horizon all day — it neither rises nor sets today',
};

// Astronomical twilight, the boundary that decides whether the sky is properly dark. Both
// times belong to the day asked for: today's dawn boundary and tonight's dusk one. Nothing
// here extrapolates to tomorrow morning, which the engine was not asked about.
const DARKNESS = {
  'rises-and-sets': (t) => `Ends ${t.morning.local}, returns ${t.evening.local}`,
  'no-set': (t) => `Ends ${t.morning.local}, and does not return today`,
  'no-rise': (t) => `Returns ${t.evening.local}; not fully dark before then today`,
  'always-above': () => 'None tonight — the Sun never drops 18° below the horizon',
  'always-below': () => 'All day — the Sun stays more than 18° below the horizon',
};

/** The hours the Moon is actually up, from the engine's intervals — never from its phase. */
function moonUpText(moon) {
  const spans = moon.aboveHorizon;
  if (!spans.length) return 'Not at all today — it stays below the horizon';
  if (spans.length === 1 && spans[0].fromDayStart && spans[0].toDayEnd) return 'All day and all night';
  return spans.map((s) => `${s.fromDayStart ? 'midnight' : s.start.local} to ${s.toDayEnd ? 'midnight' : s.end.local}`)
    .join(', ');
}

/**
 * One engine result as the lines a reader sees: `{ key, label, value }` in reading order.
 * Five lines, five independent facts. There is deliberately no weather line.
 */
export function tonightFacts(sky) {
  const { sun, moon } = sky, astro = sun.twilight.astronomical;
  return [
    { key: 'sun', label: 'Sun', value: RISE_SET[sun.state](sun.state === 'no-rise' ? { down: sun.set } : { up: sun.rise, down: sun.set }) },
    { key: 'darkness', label: 'Full darkness', value: DARKNESS[astro.state](astro) },
    { key: 'moon', label: 'Moon', value: RISE_SET[moon.state]({ up: moon.rise, down: moon.set }) },
    { key: 'moonUp', label: 'Moon above the horizon', value: moonUpText(moon) },
    { key: 'moonLit', label: 'Moon lit', value: `${moon.illuminatedPercent}% lit (at midday)` },
  ];
}

/** `place`: `{ name, timeZone }`. The zone is the PLACE's own -- the NWS /points response carries
 *  it as an IANA name and source-weather.js hands it over the moment that response lands -- and it is
 *  named on the card because a time without a zone is not a fact. There is no borrowed-zone state
 *  left: a place whose zone could not be looked up gets no stamped times at all. */
export function tonightHtml(sky, place = {}) {
  const rows = tonightFacts(sky).map((r) =>
    `<dt class="qc-tonight-label">${esc(r.label)}</dt><dd class="qc-tonight-value">${esc(r.value)}</dd>`).join('');
  const zone = `Times in ${esc(place.timeZone)}, the zone of the place itself.`;
  return `<h3 class="qc-tonight-head">Tonight\u2019s sky — ${esc(place.name)}</h3>`
    + `<dl class="qc-tonight-rows">${rows}</dl>`
    + '<p class="qc-tonight-note">Each line is its own fact. How much of the Moon is lit does not say '
    + 'when it is up: a thin Moon still washes out a dark sky while it is above the horizon, and a full '
    + 'Moon below the horizon leaves the sky dark. Cloud, wind and gusts are not on this card at all — '
    + 'they are the forecast card beside it — so nothing here tells you whether you will see any of it.</p>'
    + `<p class="qc-tonight-zone">${zone}</p>`;
}

/** Tonight at one place, computed and written in one call — what the dashboard needs. */
export function tonightFor(place, at = Date.now()) {
  const sky = sunMoonForDay({ lat: place.lat, lon: place.lon, timeZone: place.timeZone, date: localDate(place.timeZone, at) });
  return tonightHtml(sky, place);
}

// ---- The forecast card -------------------------------------------------------------------------
// A second card, not more rows above: the times up there are arithmetic and always there, while wind is a
// forecast with a horizon, a refresh window and fields it does not always state, and one voice for both would
// let calculated darkness read as a promise of a clear sky. Three semantics the strings keep: a direction is
// where the wind comes FROM and none stated is never north; a gust is a PEAK and no gust field is not a
// forecast of no gusts; an absent value is unknown, never 0.
const POINTS = ['north', 'north-northeast', 'northeast', 'east-northeast', 'east', 'east-southeast', 'southeast', 'south-southeast', 'south', 'south-southwest', 'southwest', 'west-southwest', 'west', 'west-northwest', 'northwest', 'north-northwest'];
const inZone = (at, timeZone, opts) => new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'UTC', ...opts }).format(at);
const mphOf = (q) => (q ? Math.round(q.value / 1.609344) : null);   // the grid states km_h-1

/** Cloud cover as a whole percent, and ONLY from the unit the grid states. The captured skyCover
 *  series is `wmoUnit:percent`; anything else is unknown rather than a number in the wrong scale,
 *  because three eighths of sky printed as "3%" reads as a clear night. An hour the grid does not
 *  cover is absent, and absent is never 0 -- but a stated 0 IS a forecast and is printed. */
export function cloudPercentOf(q) {
  return q && Number.isFinite(q.value) && q.unit === 'percent' ? Math.round(q.value) : null;
}

/** Where the wind COMES FROM, in words, from the grid's degrees (the hourly product's letters measured
 *  EMPTY on an hour the grid put at 160). None stated is never quietly north. */
export function fromDirection(degrees) {
  return degrees && Number.isFinite(degrees.value) ? POINTS[Math.round(degrees.value / 22.5) % 16] : null;
}

/** The rows for the hour containing `at`, or the one row saying why there are none: no forecast here, one
 *  past its refresh window (stale numbers are never shown as current), or an hour past the provider's
 *  horizon (not out yet -- the times above stand). Cloud, wind and gusts are three independent rows:
 *  each is present or absent on its own, and none of the three states is ever inferred from another. */
export function conditionsFacts(forecast, at = Date.now()) {
  const say = (key, value) => [{ key, label: 'Forecast', value }];
  if (!forecast || forecast.status !== 'ok') return say('none', (forecast && forecast.coverage) || 'No forecast for this place.');
  const zone = forecast.timeZone, issued = Date.parse(forecast.generatedAt);
  if (Number.isFinite(issued) && at - issued > REFRESH_MS) return say('expired', `Issued ${forecast.generatedAt} and not refreshed since, so it is out of date \u2014 these numbers are not current.`);
  const hour = Math.floor(at / HOUR_MS) * HOUR_MS, end = horizonEnd(forecast.validTimes);
  if (end && hour >= end) return say('horizon', `Weather not available yet \u2014 this forecast reaches ${inZone(end - HOUR_MS, zone, { month: 'long', day: 'numeric' })} and no further. The calculated sun and moon times still stand.`);
  const g = gridAt(forecast.grid, hour), from = fromDirection(g.windDirection), speed = mphOf(g.windSpeed), gust = mphOf(g.windGust);
  const cloud = cloudPercentOf(g.skyCover);
  return [
    { key: 'hour', label: 'Hour', value: inZone(hour, zone, { hour: 'numeric', timeZoneName: 'short' }) },
    { key: 'cloud', label: 'Cloud cover', value: cloud === null ? 'Not stated for this hour — which is not the same as a clear sky' : `${cloud}% of the sky forecast covered` },
    { key: 'wind', label: 'Wind', value: from === null && speed === null ? 'Not stated for this hour' : `${from ? `From the ${from}` : 'Direction not stated'}, ${speed === null ? 'speed not stated' : `${speed} mph`}` },
    { key: 'gust', label: 'Gusts', value: gust === null ? 'Not stated for this hour \u2014 which is not the same as no gusts' : `Peaks near ${gust} mph \u2014 a gust is a peak, not a sustained speed` },
  ];
}

/** The forecast card. No control and no motion, so no keyboard path and no reduced-motion case. */
export function conditionsHtml(forecast, place = {}, at = Date.now()) {
  return `<h3 class="qc-tonight-head">This hour\u2019s conditions \u2014 ${esc(place.name)}</h3><dl class="qc-tonight-rows">`
    + conditionsFacts(forecast, at).map((r) => `<dt class="qc-tonight-label">${esc(r.label)}</dt><dd class="qc-tonight-value">${esc(r.value)}</dd>`).join('')
    + '</dl><p class="qc-tonight-note">Wind is named for the direction it comes FROM, and a gust is a peak rather than '
    + 'a sustained speed. Cloud cover is the share of sky the forecast expects to be covered in this hour, for a grid '
    + 'cell rather than for the spot you are standing on, and it is a forecast rather than a look at the sky. All three '
    + 'come from the National Weather Service grid product, which states a value over an interval rather than an hour; '
    + 'a field it does not state is unknown, not zero, and an unknown sky is not a clear one.</p>';
}
