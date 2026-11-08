// QQA-04b: the finder's street-address lookup.
//
// One request to this site's own GET /api/geocode?q=<text> (same origin, so the page
// CSP's connect-src 'self' already covers it). The function behind it (QQA-04a) asks the
// U.S. Census geocoder and answers in a fixed shape; this module is the browser's
// half of that contract and nothing else. Pure of the DOM, so node --test covers it.
//
// What a Census match is: the geocoder interpolates a point along the street's address
// range (matchClass "interpolated"). It is never a rooftop or a doorway, and the finder
// words every row that way (search-shell.js ADDRESS_ESTIMATE_NOTE).
//
// Privacy: the typed text appears in exactly one place, the request URL. It is never
// logged, stored, or returned in a status; the caller keeps it out of the share URL,
// saved views, the title and analytics. The request carries no cookies and no referrer.
//
// The request goes through request.js (fetchWithDeadline), so it has a deadline and a cancel
// like every other read in the map; no-raw-fetch.test.mjs holds that.
import { fetchWithDeadline } from './request.js';

export const GEOCODE_PATH = '/api/geocode';
/** Client-side deadline; the function's own upstream deadline is 8 s. */
export const GEOCODE_TIMEOUT_MS = 10000;
/** The endpoint refuses anything outside 3..200 characters with 400 bad-query. */
export const QUERY_MIN = 3;
export const QUERY_MAX = 200;
/** The endpoint returns at most five; the page never shows more. */
export const MAX_RESULTS = 5;

/** The request URL for a query, trimmed the way the endpoint trims it. */
export function buildGeocodeUrl(query) {
  return GEOCODE_PATH + '?q=' + encodeURIComponent(String(query).trim());
}

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/** The rows of a 200 body that can be shown: a label and a finite point on Earth.
 *  The endpoint already drops points outside the US envelope; anything unusable that
 *  still arrives is dropped here rather than guessed at. */
function normalizeResults(body) {
  const provider = typeof body.provider === 'string' ? body.provider : 'us-census';
  const benchmark = typeof body.benchmark === 'string' ? body.benchmark : '';
  const rows = Array.isArray(body.results) ? body.results : [];
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const label = typeof r.label === 'string' ? r.label.trim() : '';
    if (!label || !finite(r.lat) || !finite(r.lon)) continue;
    if (r.lat < -90 || r.lat > 90 || r.lon < -180 || r.lon > 180) continue;
    out.push({
      id: typeof r.id === 'string' ? r.id : '',
      label,
      matchClass: typeof r.matchClass === 'string' ? r.matchClass : 'interpolated',
      lat: r.lat,
      lon: r.lon,
      state: typeof r.state === 'string' ? r.state : '',
      zip: typeof r.zip === 'string' ? r.zip : '',
      provider,
      benchmark,
    });
    if (out.length === MAX_RESULTS) break;
  }
  return out;
}

/** Looks an address up. Never throws; resolves to one of
 *  - `{ status: 'ready', results }`  -- one to five street matches
 *  - `{ status: 'none' }`            -- the lookup worked and found no street match
 *  - `{ status: 'bad-query' }`       -- text the endpoint refuses (no request sent for
 *                                       a length it would refuse)
 *  - `{ status: 'rate-limited' }`    -- HTTP 429
 *  - `{ status: 'timeout' }`         -- HTTP 504, or no answer within `timeoutMs`
 *  - `{ status: 'unavailable' }`     -- 502, any other HTTP failure (404 when the
 *                                       endpoint is not deployed), a body that is not
 *                                       the contract's, or no network
 *  - `{ status: 'aborted' }`         -- the caller's own `signal` cancelled it (a newer
 *                                       search superseded it) */
export async function geocodeAddress(query, { signal, timeoutMs = GEOCODE_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (q.length < QUERY_MIN || q.length > QUERY_MAX) return { status: 'bad-query' };
  const got = await fetchWithDeadline(buildGeocodeUrl(q), {
    fetchImpl, signal, timeoutMs,
    init: { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' },
  });
  if (got.status === 'aborted') return { status: 'aborted' };
  if (got.status === 'timeout') return { status: 'timeout' };
  if (!got.ok) {
    if (got.httpStatus === 429) return { status: 'rate-limited' };
    if (got.httpStatus === 504) return { status: 'timeout' };
    if (got.httpStatus === 400) return { status: 'bad-query' };
    return { status: 'unavailable' };
  }
  const body = got.body;
  if (!body || typeof body !== 'object' || !Array.isArray(body.results)) return { status: 'unavailable' };
  const results = normalizeResults(body);
  return results.length ? { status: 'ready', results } : { status: 'none' };
}
