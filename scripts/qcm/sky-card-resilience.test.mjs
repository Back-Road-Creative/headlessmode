// The two sky cards are fed by ONE request and must fail apart. `/points` hands back the place's
// own IANA zone; the Sun and Moon are arithmetic on that zone and a latitude, owing the forecast
// nothing. So a forecast that fails AFTER the zone arrived says nothing about the Sun and Moon,
// and blanking them is a bug — the plan's acceptance criterion for this unit, word for word: "A
// captured hourly/grid failure after successful timezone lookup leaves Sun/Moon results intact."
//
// The failure is INJECTED at the fetch, through the real loader and the real fetchHourly, so what
// is proved is the path the browser takes. The point response is the captured one
// (fixtures/nws-api-2026-09-10.min.json, `_source`: GET /points/33.2699,-85.8337 -> 200); only the
// hourly and grid answers are replaced, with the two shapes measured from this API — a 500 fault
// and a 404 `problem+json` outside coverage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createForecastLoader } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-weather.js';
import {
  showSkyCards, TONIGHT_ID, HOURLY_ID, NO_ZONE_NOTE, NO_FORECAST_NOTE,
} from '../../themes/headlessmode/static/js/quiet-corners-sky/sky-cards.js';

const F = JSON.parse(readFileSync(new URL('fixtures/nws-api-2026-09-10.min.json', import.meta.url), 'utf8'));
const G = JSON.parse(readFileSync(new URL('fixtures/nws-grid-2026-09-11.min.json', import.meta.url), 'utf8'));
const DASH = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners.js', import.meta.url), 'utf8');

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const OUT_OF_COVERAGE = { title: 'Data Unavailable For Requested Point', detail: 'Unable to provide data for requested point' };

/** A browser fetch for this one place, with each leg answerable independently. */
const fetchFor = ({ point = res(200, F.point), hourly = res(200, F.hourly), grid = res(200, G) } = {}) =>
  async (url) => {
    if (url.includes('/points/')) return point;
    if (url.endsWith('/forecast/hourly')) return hourly;
    return grid;
  };

/** One selected place through the real loader, collecting what each card was written. `calls`
 *  keeps every write in order, because "left intact" means never overwritten, not merely correct
 *  at the end. */
async function draw(fetchImpl, place = { name: 'Ashland', lat: 33.2699, lon: -85.8337 }) {
  const calls = [];
  const loader = createForecastLoader({ fetchImpl });
  await showSkyCards({
    place,
    request: (opts) => loader.request(opts),
    write: (id, html) => calls.push({ id, html }),
  });
  const last = (id) => (calls.filter((c) => c.id === id).pop() || {}).html;
  return { calls, tonight: last(TONIGHT_ID), hourly: last(HOURLY_ID) };
}

const hasSkyFacts = (html) => /Tonight’s sky/.test(html) && /Moon lit/.test(html)
  && /Times in America\/Chicago/.test(html);

test('a 500 on the hourly product leaves the Sun and Moon card standing', async () => {
  const { calls, tonight, hourly } = await draw(fetchFor({ hourly: res(500, {}) }));
  assert.ok(hasSkyFacts(tonight), `the astronomy was lost to a weather fault: "${tonight}"`);
  assert.ok(!tonight.includes(NO_ZONE_NOTE), 'the zone WAS looked up — the card must not claim it was not');
  assert.equal(calls.filter((c) => c.id === TONIGHT_ID).length, 1, 'the sky card is written once and not blanked after');
  assert.match(hourly, new RegExp(NO_FORECAST_NOTE.replace(/[.’]/g, '.')), 'the forecast card carries the failure alone');
});

test('a 500 on the grid product leaves it standing too', async () => {
  // The grid is the second product and the only one carrying gusts and cloud; its fault arrives
  // after both the point and the hourly answers.
  const { tonight, hourly } = await draw(fetchFor({ grid: res(500, {}) }), { name: 'Ashland', lat: 33.27, lon: -85.83 });
  assert.ok(hasSkyFacts(tonight), `a grid fault blanked the astronomy: "${tonight}"`);
  assert.match(hourly, new RegExp(NO_FORECAST_NOTE.replace(/[.’]/g, '.')));
});

test('a 404 outside coverage is a state, and the astronomy still stands beside it', async () => {
  const { tonight, hourly } = await draw(fetchFor({ hourly: res(404, OUT_OF_COVERAGE) }),
    { name: 'Ashland', lat: 33.271, lon: -85.831 });
  assert.ok(hasSkyFacts(tonight), `a no-forecast state blanked the astronomy: "${tonight}"`);
  assert.match(hourly, /no forecast for this location/i, 'the coverage state is shown rather than an error');
});

test('a point lookup that fails has no zone to stand on, and the card says exactly that', async () => {
  const { tonight, hourly } = await draw(fetchFor({ point: res(500, {}) }), { name: 'Ashland', lat: 33.272, lon: -85.832 });
  assert.ok(tonight.includes(NO_ZONE_NOTE), 'no zone was ever looked up, so no times can be stamped');
  assert.ok(!/Moon lit/.test(tonight), 'unstamped times must not be printed anyway');
  assert.match(hourly, new RegExp(NO_FORECAST_NOTE.replace(/[.’]/g, '.')));
});

test('a point response with no zone in it says so once, and is not redrawn by the forecast', async () => {
  const zoneless = { ...F.point, properties: { ...F.point.properties, timeZone: null } };
  const { calls, tonight } = await draw(fetchFor({ point: res(200, zoneless), hourly: res(500, {}) }),
    { name: 'Ashland', lat: 33.274, lon: -85.834 });
  assert.ok(tonight.includes(NO_ZONE_NOTE));
  assert.equal(calls.filter((c) => c.id === TONIGHT_ID).length, 1, 'one honest sentence, not two');
});

test('a place the reader has already moved off writes nothing', async () => {
  const calls = [];
  const loader = createForecastLoader({ fetchImpl: fetchFor({ hourly: res(500, {}) }) });
  await showSkyCards({
    place: { name: 'Ashland', lat: 33.273, lon: -85.833 },
    request: (opts) => loader.request(opts),
    write: (id, html) => calls.push({ id, html }),
    isCurrent: () => false,
  });
  assert.deepEqual(calls, [], 'a superseded place must not paint over the one the reader is looking at');
});

test('the dashboard uses this module rather than keeping its own copy of the sequence', () => {
  assert.match(DASH, /from '\.\/quiet-corners-sky\/sky-cards\.js'/, 'quiet-corners.js must import the sequencer');
  assert.match(DASH, /showSkyCards\(/);
  assert.ok(!/\bsky\(null\)/.test(DASH),
    'the old unconditional blank-the-astronomy call is the bug this unit removes');
});

// The alert card is drawn from the same place's zone, and that zone arrives with the forecast's
// point lookup -- a fact already in flight. Without a seam the alerts would have to ask /points a
// second time for it. onZone is that seam, and these two tests are why it is safe to rely on:
// it fires exactly when a zone really arrived, and never when one did not.
test('onZone hands the alert card the zone the point lookup carried', async () => {
  const seen = [];
  const loader = createForecastLoader({ fetchImpl: fetchFor({ hourly: res(500, {}) }) });
  await showSkyCards({
    place: { name: 'Ashland', lat: 33.273, lon: -85.833 },
    request: (opts) => loader.request(opts),
    write: () => {},
    onZone: (z) => seen.push(z),
  });
  assert.deepEqual(seen, [F.point.properties.timeZone],
    'the zone is handed over once, and it is the one /points actually answered with');
});

test('onZone stays silent when no zone ever arrived', async () => {
  const seen = [];
  const zoneless = { ...F.point, properties: { ...F.point.properties, timeZone: null } };
  const loader = createForecastLoader({
    fetchImpl: fetchFor({ point: res(200, zoneless), hourly: res(500, {}) }),
  });
  await showSkyCards({
    place: { name: 'Ashland', lat: 33.274, lon: -85.834 },
    request: (opts) => loader.request(opts),
    write: () => {},
    onZone: (z) => seen.push(z),
  });
  assert.deepEqual(seen, [],
    'a null zone is not a zone: the alert card must stamp times in UTC and say so, not in a zone it invented');
});
