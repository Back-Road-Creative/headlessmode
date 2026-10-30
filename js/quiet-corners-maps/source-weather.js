// National Weather Service: what the weather will do at the place you picked. Free, no key, `access-control-allow-origin: *`,
// so the browser fetches it direct. Every fact here was measured 2026-09-10 and recorded with the response it came from, in the
// `_source` lines of scripts/qcm/fixtures/nws-api-2026-09-10.min.json; the reader-facing version is the NWS entry in
// content/quiet-corners-maps.md. TWO STEPS: `/points/{lat},{lon}` maps a lat/lon to an office and grid cell and hands back the
// forecast URL, used AS GIVEN -- hand-building `/gridpoints/BMX/96,76/...` hard-codes a grid the office may renumber.
import { SOURCES } from './source-registry.js';
import { withDeadline, fetchWithDeadline, orThrow } from './request.js';

const API = SOURCES.nwsForecast.origin;
// The refresh intervals are the service's own cache-control, not taste: `max-age=3600` on the hourly product, `max-age=85988` on /points -- a grid cell never moves.
export const REFRESH_MS = 3600 * 1000;
export const POINT_REFRESH_MS = 24 * 3600 * 1000;
export const NO_FORECAST = 'no-forecast-here';
export const COVERAGE = 'The National Weather Service forecasts the United States and its territories only. There is no forecast for this location.';

/** Four decimals: `/points/33.269912,-85.833712` answered 301 to the short form. */
export const pointUrl = (lat, lon) => `${API}/points/${Math.round(lat * 1e4) / 1e4},${Math.round(lon * 1e4) / 1e4}`;

/** The one header the page sets. NWS 403s a request with no User-Agent and its preflight
 *  allows that header, but script cannot set it (a forbidden header name) and the
 *  browser's own measured 200. */
export const requestHeaders = () => ({ Accept: 'application/geo+json' });

/** A `{ unitCode, value }` pair as a value plus its WMO unit, or null. Null is the point:
 *  this API nulls what it lacks rather than omitting it, so unknown must never read as 0. */
export function quantity(raw) {
  if (!raw || typeof raw !== 'object' || !Number.isFinite(raw.value)) return null;
  return { value: raw.value, unit: String(raw.unitCode || '').replace(/^wmoUnit:/, '') || null };
}

/** Temperature from EITHER shape, in the unit the response states: a bare number beside
 *  `temperatureUnit: "F"`, or -- same URL, `Feature-Flags: forecast_temperature_qv` --
 *  `{ unitCode: "wmoUnit:degC", value: 30 }` with `units` still "us". Assuming either prints 30 F. */
export function temperatureOf(period = {}) {
  const q = quantity(period.temperature);
  const value = q ? q.value : period.temperature;
  const unit = q ? q.unit : (period.temperatureUnit ? `deg${period.temperatureUnit}` : null);
  if (!Number.isFinite(value) || !unit) return null;
  return { value, unit, celsius: Math.round((unit === 'degF' ? (value - 32) * 5 / 9 : value) * 10) / 10 };
}

// "5 mph", "0 to 5 mph", "5 km/h". The range is real: the twice-daily product on the same grid the same minute said "0 to 5 mph".
const SPEED = /^\s*(\d+)(?:\s*to\s*(\d+))?\s*(mph|km\/h|kt)\s*$/i;

/** Wind as four separable states, because they mean different things. `from` is where it COMES FROM; an empty `windDirection`
 *  is "not stated", not north. A "0 mph" hour is rounding to the nearest 5, not a measured calm -- the same hour in `units=si`
 *  came back "5 km/h" -- so the flag names the floor. No captured hourly period carried a `windGust` at all, so absent stays
 *  null and the gust parse follows windSpeed's format, which the same renderer writes. */
export function windOf(period = {}) {
  const m = SPEED.exec(period.windSpeed || ''), g = SPEED.exec(period.windGust || '');
  const minSpeed = m ? Number(m[1]) : null, maxSpeed = m ? Number(m[2] ?? m[1]) : null;
  return {
    from: period.windDirection || null, minSpeed, maxSpeed, unit: m ? m[3].toLowerCase() : null,
    belowRoundingFloor: maxSpeed === 0, gust: g ? Number(g[2] ?? g[1]) : null,
  };
}

/** An hourly response as the card reads it. Every period survives, in order, with its own
 *  UTC offset verbatim: an all-unknown hour is still an hour, dropping it silently shortens
 *  the night, and re-stamping in the browser's zone turns a 6pm into a 7pm. */
export function normalizeHourly(json = {}) {
  const p = json.properties || {};
  return {
    generatedAt: p.generatedAt ?? null, updateTime: p.updateTime ?? null, units: p.units ?? null,
    validTimes: p.validTimes ?? null, elevation: quantity(p.elevation),
    hours: (p.periods || []).map((period) => ({
      startTime: period.startTime ?? null, endTime: period.endTime ?? null,
      isDaytime: period.isDaytime === true, temperature: temperatureOf(period),
      trend: period.temperatureTrend ?? null,   // null in all 156 periods: "not stated"
      precipitationChance: quantity(period.probabilityOfPrecipitation),
      dewpoint: quantity(period.dewpoint), humidity: quantity(period.relativeHumidity),
      wind: windOf(period), shortForecast: period.shortForecast || null,
    })),
  };
}

// A 404 `application/problem+json` is the API holding nothing for this point: a state to
// show, not an error to throw. Every other status is a fault, and loud.
async function getJson(url, { fetchImpl, signal }) {
  const got = await fetchWithDeadline(url, {
    fetchImpl, signal, timeoutMs: SOURCES.nwsForecast.timeoutMs, init: { headers: requestHeaders() }, anyStatus: true,
  });
  if (got.ok) return { json: got.body };
  if (got.httpStatus === 404) {
    const problem = (got.body && typeof got.body === 'object') ? got.body : {};
    return { status: NO_FORECAST, detail: problem.detail || problem.title || '', coverage: COVERAGE };
  }
  return orThrow(got, got.httpStatus ? `NWS answered ${got.httpStatus} for ${url}.` : undefined);
}

// The gridpoints product, the OTHER shape on this origin -- `/gridpoints/{office}/{x},{y}`, named by
// /points as `forecastGridData`, verified live 2026-09-11 02:28Z (200, 243,078 bytes, geo+json,
// CORS-open, max-age=3600). Gusts live HERE and nowhere else: not one captured hourly forecast carried
// a `windGust` key. Two properties corrupt a naive read. (1) A value covers an ISO 8601 INTERVAL --
// `{"validTime":"2026-09-10T17:00:00+00:00/PT3H","value":9.26}` -- measured PT1H to PT12H for windGust,
// PT20H in one windSpeed entry, and P1D and P7DT8H forms in the same payload. (2) Each field has its own
// run boundaries AND entry count over one span (windGust 49, windSpeed 44, windDirection 82, skyCover
// 84), so INDEXES NEVER LINE UP: expand each onto an hour grid, then align by timestamp. Units are
// metric whatever `units` says -- except skyCover, which the service states as `wmoUnit:percent`
// and which is read ONLY under that unit (tonight.js:cloudPercentOf), because a fraction or a count
// of eighths printed as a percentage reads as a sky far clearer than the one forecast.
export const GRID_FIELDS = ['windDirection', 'windSpeed', 'windGust', 'skyCover'];
export const HOUR_MS = 3600 * 1000;
const DURATION = /^P(?:(\d+)D)?(?:T(\d+)H)?$/;   // the forms sent: PT3H, PT20H, P1D, P7DT8H

/** Whole hours in a duration. A form this product has never sent reads as 0, not a guess. */
export function durationHours(duration) {
  const m = DURATION.exec(String(duration || ''));
  return m ? Number(m[1] || 0) * 24 + Number(m[2] || 0) : 0;
}

/** A series as `{ unit, hours: Map<epochMs, value> }`. A null-valued run leaves its hours ABSENT rather
 *  than present-and-zero -- one captured windChill run nulled the whole span. */
export function expandSeries(series = {}) {
  const hours = new Map();
  for (const run of series.values || []) {
    const [start, duration] = String(run.validTime || '').split('/');
    const at = Date.parse(start);
    if (!Number.isFinite(at) || !Number.isFinite(run.value)) continue;
    for (let h = 0, n = durationHours(duration); h < n; h++) hours.set(at + h * HOUR_MS, run.value);
  }
  return { unit: String(series.uom || '').replace(/^wmoUnit:/, '') || null, hours };
}

/** The end of the forecast horizon, from a `validTimes` span. Past it there is no weather to show. */
export function horizonEnd(validTimes) {
  const [start, dur] = String(validTimes || '').split('/'), at = Date.parse(start), n = durationHours(dur);
  return Number.isFinite(at) && n ? at + n * HOUR_MS : null;
}

export function normalizeGrid(json = {}) {
  const p = json.properties || {};
  return { series: Object.fromEntries(GRID_FIELDS.map((n) => [n, expandSeries(p[n])])) };
}

/** Every grid field for ONE hour, aligned by timestamp and independently present or absent. */
export function gridAt(grid, at) {
  const series = (grid && grid.series) || {};
  return Object.fromEntries(GRID_FIELDS.map((n) => [n, series[n] && series[n].hours.has(at)
    ? { value: series[n].hours.get(at), unit: series[n].unit } : null]));
}

/** The hourly forecast for a lat/lon: the point lookup, then the URL it named, plus with `withGrid` the
 *  `forecastGridData` URL it also named. `onPoint` gets the place the moment the FIRST response lands --
 *  its `timeZone` is the one fact the astronomy needs, and that card must not wait on a forecast. */
export async function fetchHourly({ lat, lon, fetchImpl = fetch, signal, onPoint, withGrid = false } = {}) {
  const point = await getJson(pointUrl(lat, lon), { fetchImpl, signal });
  if (point.status === NO_FORECAST) return point;
  const props = point.json.properties || {};
  // `nearest` is the API's own named place, for a card that must say where it means.
  const near = props.relativeLocation && props.relativeLocation.properties;
  const nearest = near && near.city && near.state ? `${near.city}, ${near.state}` : null;
  const place = { timeZone: props.timeZone ?? null, nearest };
  if (onPoint) onPoint(place);
  const hourly = await getJson(props.forecastHourly, { fetchImpl, signal });
  if (hourly.status === NO_FORECAST) return hourly;
  const grid = withGrid ? await getJson(props.forecastGridData, { fetchImpl, signal }) : null;
  return { status: 'ok', ...place, ...normalizeHourly(hourly.json), grid: grid && grid.json ? normalizeGrid(grid.json) : null };
}

/** One forecast at a time for one selected place. Move the map from A to B and A's slower answer can land second; showing it
 *  puts A's weather under B's name, which is worse than showing nothing. Each request takes a ticket; an answer whose ticket is
 *  no longer the latest comes back `superseded`, never becomes `current`, and is aborted. The memo enforces REFRESH_MS. */
// QUX-09b (D5): a request must not hold a pending note up forever -- the registry's per-source
// deadline, combined with the caller's own abort so a superseded pick still cancels immediately.
// The deadline comes from request.js's withDeadline, which needs no `AbortSignal.any`: a browser
// or test double without it used to lose the timeout altogether.
export const DEFAULT_TIMEOUT_MS = SOURCES.nwsForecast.timeoutMs;

export function createForecastLoader({ load = fetchHourly, fetchImpl, now = () => Date.now(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let seq = 0, inFlight = null, memo = null;
  const loader = {
    current: null,
    async request({ lat, lon, ...rest }) {
      const key = pointUrl(lat, lon);
      if (memo && memo.key === key && now() - memo.at < REFRESH_MS) {
        if (rest.onPoint) rest.onPoint(memo.result);
        return memo.result;
      }
      const ticket = ++seq;
      if (inFlight) inFlight.abort();
      inFlight = new AbortController();
      const deadline = withDeadline(inFlight.signal, timeoutMs);
      // A superseded request's early `onPoint` would stamp the abandoned place's zone on the card.
      const opts = rest.onPoint ? { ...rest, onPoint: (p) => { if (ticket === seq) rest.onPoint(p); } } : rest;
      let result;
      try { result = await load({ lat, lon, fetchImpl, signal: deadline.signal, ...opts }); } finally { deadline.dispose(); }
      if (ticket !== seq) return { status: 'superseded', key };
      memo = { key, at: now(), result };
      return (loader.current = result);
    },
  };
  return loader;
}
