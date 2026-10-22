// GET /api/geocode?q=<text> -- the Quiet Corners address search, relayed to the US Census geocoder.
//
// Why a function at all: geocoding.geo.census.gov sends no Access-Control-Allow-Origin header (measured
// 2026-10-08, preflight included), so a browser on headlessmode.com cannot call it. Its JSONP mode would
// run census.gov script inside the page, which this site's content policy exists to prevent. A same-origin
// relay is the one route left that keeps `connect-src 'self'`.
//
// What it promises, and scripts/qcm/geocode-function.test.mjs holds it to:
//   * The query is an address a reader typed. It goes to Census and nowhere else: this file has no
//     console call, no cache, no storage, and never puts the query in a response body.
//   * Nothing the reader's browser sent is forwarded, and nothing Census sent back is passed on (its
//     response carries a tracking header this site must not hand to a reader).
//   * Census places a point along the street segment from an address range. Every result is
//     "interpolated"; the page must say "estimated along the street, not a doorstep".
//
// Cloudflare Pages serves this file from /functions/api/geocode.js in the production branch (the build
// publishes public/ as that branch's root). static/_routes.json limits invocation to /api/*, so every
// other request stays a free static hit. The file is also served as a plain static file, which is fine:
// it is public source.
//
// Contract (the search box is written against these exact shapes):
//   200 {provider, benchmark, results:[{id, label, matchClass, lat, lon, state, zip}]}, at most 5
//   400 {error:'bad-query'}  504 {error:'timeout'}  502 {error:'upstream'}  429 {error:'rate-limited'}
//   405 for any method but GET. Every response is no-store JSON with nosniff.

export const UPSTREAM_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
export const BENCHMARK = 'Public_AR_Current';
export const UPSTREAM_TIMEOUT_MS = 8000;
export const MAX_RESULTS = 5;
const MIN_QUERY = 3;
const MAX_QUERY = 200;

// A coarse sanity box, not a boundary: it keeps a bad upstream coordinate (London, 0/0, a swapped pair)
// off the map while holding Alaska (including the Aleutians across the antimeridian), Hawaii, Puerto
// Rico and the Virgin Islands. Census also answers for Guam, American Samoa and the Northern Marianas,
// which fall outside it and are dropped.
const LAT_MIN = 17;
const LAT_MAX = 72;
const LON_WEST_MAX = -64;
const LON_EAST_MIN = 172;

const HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
};

const reply = (status, body, extra = {}) => new Response(JSON.stringify(body), {
  status, headers: { ...HEADERS, ...extra },
});
const fail = (status, error, extra) => reply(status, { error }, extra);

const inUnitedStates = (lon, lat) => Number.isFinite(lon) && Number.isFinite(lat)
  && typeof lon === 'number' && typeof lat === 'number'
  && lat >= LAT_MIN && lat <= LAT_MAX
  && ((lon >= -180 && lon <= LON_WEST_MAX) || (lon >= LON_EAST_MIN && lon <= 180));

// One Census record to one contract result, or null when it cannot be shown honestly. The upstream
// record is never passed through: only these seven fields leave.
function toResult(m) {
  if (!m || typeof m !== 'object') return null;
  const label = m.matchedAddress;
  const tigerId = m.tigerLine?.tigerLineId;
  const lon = m.coordinates?.x;
  const lat = m.coordinates?.y;
  if (typeof label !== 'string' || !label) return null;
  if ((typeof tigerId !== 'string' && typeof tigerId !== 'number') || tigerId === '') return null;
  if (!inUnitedStates(lon, lat)) return null;
  const side = typeof m.tigerLine.side === 'string' ? m.tigerLine.side : '';
  const part = (v) => (typeof v === 'string' ? v : '');
  return {
    id: `tiger:${tigerId}:${side}`,
    label,
    matchClass: 'interpolated',
    lat,
    lon,
    state: part(m.addressComponents?.state),
    zip: part(m.addressComponents?.zip),
  };
}

const isDeadline = (err) => err?.name === 'TimeoutError' || err?.name === 'AbortError';

export async function handleGeocode(request, { fetchImpl = fetch, timeoutMs = UPSTREAM_TIMEOUT_MS } = {}) {
  if (request.method !== 'GET') return fail(405, 'method', { allow: 'GET' });

  const q = (new URL(request.url).searchParams.get('q') ?? '').trim();
  if (q.length < MIN_QUERY || q.length > MAX_QUERY) return fail(400, 'bad-query');

  const upstream = new URL(UPSTREAM_URL);
  upstream.searchParams.set('address', q);
  upstream.searchParams.set('benchmark', BENCHMARK);
  upstream.searchParams.set('format', 'json');

  let data;
  try {
    const res = await fetchImpl(upstream.toString(), {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 429) return fail(429, 'rate-limited');
    if (res.status !== 200) return fail(502, 'upstream');
    data = await res.json();
  } catch (err) {
    return isDeadline(err) ? fail(504, 'timeout') : fail(502, 'upstream');
  }

  const list = data?.result?.addressMatches;
  if (!Array.isArray(list)) return fail(502, 'upstream');
  return reply(200, {
    provider: 'us-census',
    benchmark: BENCHMARK,
    results: list.map(toResult).filter(Boolean).slice(0, MAX_RESULTS),
  });
}

// Pages routes a method-specific export first, so GET lands in onRequestGet and every other method in
// onRequest, which answers 405 rather than falling through to a static-asset 404.
export const onRequestGet = ({ request }) => handleGeocode(request);
export const onRequest = ({ request }) => handleGeocode(request);
