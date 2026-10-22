// The same-origin address geocoder (GET /api/geocode), against the bytes the US Census geocoder
// actually returned. No network: every upstream is a stub that hands back a captured body.
//
// Three gates. A PRIVACY gate: the query is an address a reader typed, so it is never logged,
// stored, echoed in a body, or sent anywhere but the one upstream. A CLAIM gate: Census places a
// point along a street segment from its address range, so every result says "interpolated" and
// nothing here may promote it to a rooftop. A CONTRACT gate: the shapes and status codes below
// are what the Quiet Corners search box is written against, so they are asserted exactly.
//
// Fixture: scripts/qcm/fixtures/census-geocode-2026-10-08.min.json, captured live 2026-10-08.
// Its address is the Census Bureau's own headquarters, a public building. The multi-match and
// out-of-range cases below are built from that one real record, never from a private address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  handleGeocode, onRequestGet, onRequest, UPSTREAM_URL, BENCHMARK, UPSTREAM_TIMEOUT_MS, MAX_RESULTS,
} from '../../static/functions/api/geocode.js';

const MODULE = new URL('../../static/functions/api/geocode.js', import.meta.url);
const ROUTES = new URL('../../static/_routes.json', import.meta.url);
const FIX = JSON.parse(readFileSync(new URL('fixtures/census-geocode-2026-10-08.min.json', import.meta.url), 'utf8'));
const HQ = FIX.match.body.result.addressMatches[0];
// Code with comment lines stripped: the comments NAME the traps (cookie, console.log) on purpose.
const CODE = readFileSync(MODULE, 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const TOKEN = 'ZQXJ-7731-private-street';
const call = (q, { method = 'GET', headers = {}, ...opts } = {}) => {
  const url = `https://headlessmode.com/api/geocode${q === undefined ? '' : `?q=${encodeURIComponent(q)}`}`;
  return handleGeocode(new Request(url, { method, headers }), opts);
};
const json = (body, init = {}) => () => Promise.resolve(new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'TS0193e6a1=abc; Path=/; Secure; HttpOnly' }, ...init,
}));
const status = (code) => () => Promise.resolve(new Response('upstream said no', { status: code }));
const matches = (list) => ({ result: { addressMatches: list } });
const clone = (m, over = {}) => ({ ...structuredClone(m), ...over });
const at = (m, x, y) => ({ ...structuredClone(m), coordinates: { x, y } });
const OUTCOMES = {
  match: () => call('4600 Silver Hill Rd, Washington, DC', { fetchImpl: json(FIX.match.body) }),
  noMatch: () => call(TOKEN, { fetchImpl: json(FIX.noMatch.body) }),
  badQuery: () => call(`${TOKEN.slice(0, 1)}`, { fetchImpl: json(FIX.match.body) }),
  upstream500: () => call(TOKEN, { fetchImpl: status(500) }),
  upstream429: () => call(TOKEN, { fetchImpl: status(429) }),
  timeout: () => call(TOKEN, { fetchImpl: () => Promise.reject(new DOMException('timed out', 'TimeoutError')) }),
  malformed: () => call(TOKEN, { fetchImpl: () => Promise.resolve(new Response('<html>' + TOKEN, { status: 200 })) }),
  method: () => call(TOKEN, { method: 'POST', fetchImpl: json(FIX.match.body) }),
};

test('a Census match comes back as one interpolated result with the contract shape', async () => {
  const res = await OUTCOMES.match();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    provider: 'us-census',
    benchmark: 'Public_AR_Current',
    results: [{
      id: 'tiger:657091557:L',
      label: '4600 SILVER HILL RD, WASHINGTON, DC, 20233',
      matchClass: 'interpolated',
      lat: 38.84505589808,
      lon: -76.92836638093,
      state: 'DC',
      zip: '20233',
    }],
  });
});

test('a real "no match" is a 200 with an empty results array, not an error', async () => {
  const res = await OUTCOMES.noMatch();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { provider: 'us-census', benchmark: 'Public_AR_Current', results: [] });
});

test('the upstream call is the documented Census URL, with an 8 second deadline and nothing from the reader', async () => {
  assert.equal(UPSTREAM_TIMEOUT_MS, 8000);
  assert.equal(BENCHMARK, 'Public_AR_Current');
  let seen;
  await call('  4600 Silver Hill Rd, Washington, DC  ', {
    headers: { cookie: 'sid=secret', authorization: 'Bearer secret', referer: 'https://headlessmode.com/?q=secret', 'user-agent': 'reader-agent/1', 'x-forwarded-for': '203.0.113.9', 'cf-connecting-ip': '203.0.113.9' },
    fetchImpl: (url, init) => { seen = { url: new URL(url), init }; return json(FIX.match.body)(); },
  });
  assert.equal(seen.url.origin + seen.url.pathname, UPSTREAM_URL);
  assert.equal(UPSTREAM_URL, 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress');
  assert.deepEqual([...seen.url.searchParams.entries()].sort(), [
    ['address', '4600 Silver Hill Rd, Washington, DC'], ['benchmark', 'Public_AR_Current'], ['format', 'json'],
  ], 'q is trimmed, and only these three parameters go upstream');
  assert.equal(seen.init.method, 'GET');
  assert.ok(seen.init.signal instanceof AbortSignal, 'an AbortSignal carries the deadline');
  assert.equal(seen.init.signal.aborted, false);
  const sent = JSON.stringify(Object.fromEntries(new Headers(seen.init.headers ?? {})));
  assert.doesNotMatch(sent, /secret|203\.0\.113|reader-agent|cookie|authorization|referer|forwarded/i,
    'no reader header or cookie is forwarded');
  assert.ok(!('body' in seen.init) || seen.init.body == null);
});

test('q must be 3 to 200 characters after trimming, else 400 bad-query and no upstream call', async () => {
  for (const q of [undefined, '', '   ', 'ab', '  ab  ', 'x'.repeat(201), ` ${'x'.repeat(201)} `]) {
    let called = false;
    const res = await call(q, { fetchImpl: () => { called = true; return json(FIX.match.body)(); } });
    assert.equal(res.status, 400, `q=${JSON.stringify(q)?.slice(0, 20)}`);
    assert.deepEqual(await res.json(), { error: 'bad-query' });
    assert.equal(called, false, 'a rejected query never leaves the function');
  }
  for (const q of ['abc', 'x'.repeat(200), ` ${'x'.repeat(200)} `]) {
    const res = await call(q, { fetchImpl: json(FIX.noMatch.body) });
    assert.equal(res.status, 200, `q of length ${q.length} is in range`);
  }
});

test('an upstream 5xx, redirect or odd status is 502 upstream', async () => {
  for (const code of [500, 502, 503, 404, 400]) {
    const res = await call(TOKEN, { fetchImpl: status(code) });
    assert.equal(res.status, 502, `upstream ${code}`);
    assert.deepEqual(await res.json(), { error: 'upstream' });
  }
  const res = await call(TOKEN, { fetchImpl: () => Promise.reject(new TypeError('fetch failed')) });
  assert.equal(res.status, 502, 'a network failure is an upstream failure');
});

test('an upstream 429 is 429 rate-limited', async () => {
  const res = await OUTCOMES.upstream429();
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { error: 'rate-limited' });
});

test('a timeout or abort is 504 timeout, including the real deadline firing', async () => {
  for (const name of ['TimeoutError', 'AbortError']) {
    const res = await call(TOKEN, { fetchImpl: () => Promise.reject(new DOMException('x', name)) });
    assert.equal(res.status, 504, name);
    assert.deepEqual(await res.json(), { error: 'timeout' });
  }
  // A hung upstream: the function's own signal must be what ends it.
  const hung = (_u, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  // AbortSignal.timeout's timer is unref'd, so a hung stub alone would let node exit first.
  const keepAlive = setTimeout(() => {}, 5000);
  const res = await call(TOKEN, { fetchImpl: hung, timeoutMs: 25 });
  clearTimeout(keepAlive);
  assert.equal(res.status, 504);
  assert.deepEqual(await res.json(), { error: 'timeout' });
});

test('a 200 that is not Census JSON is 502 upstream, never a crash or an empty "no match"', async () => {
  const bodies = [
    () => Promise.resolve(new Response('<html>maintenance</html>', { status: 200 })),
    () => Promise.resolve(new Response('', { status: 200 })),
    json({}), json({ result: {} }), json({ result: { addressMatches: 'none' } }), json(null), json([]),
  ];
  for (const fetchImpl of bodies) {
    const res = await call(TOKEN, { fetchImpl });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'upstream' });
  }
});

test('a point outside the United States, or not a finite number, is dropped from the results', async () => {
  const list = [
    at(HQ, -0.1276, 51.5072),          // London
    at(HQ, 0, 0),                      // null island
    at(HQ, Number.NaN, 38.8),
    at(HQ, -76.9, null),
    at(HQ, '-76.9', '38.8'),           // strings are not coordinates
    at(HQ, -76.9, 95),
    { ...structuredClone(HQ), coordinates: undefined },
    at(HQ, -149.9, 61.2),              // Anchorage: Alaska is inside
    at(HQ, -157.86, 21.31),            // Honolulu: Hawaii is inside
    at(HQ, -66.1, 18.45),              // San Juan: Puerto Rico is inside
  ];
  const body = await (await call(TOKEN, { fetchImpl: json(matches(list)) })).json();
  assert.deepEqual(body.results.map((r) => [r.lon, r.lat]), [[-149.9, 61.2], [-157.86, 21.31], [-66.1, 18.45]]);
});

test('at most 5 results, in upstream order, taken after the bad ones are dropped', async () => {
  assert.equal(MAX_RESULTS, 5);
  const list = Array.from({ length: 8 }, (_, i) => clone(HQ, { tigerLine: { side: i % 2 ? 'R' : 'L', tigerLineId: String(1000 + i) } }));
  list.unshift(at(HQ, 12, 51));
  const body = await (await call(TOKEN, { fetchImpl: json(matches(list)) })).json();
  assert.equal(body.results.length, 5);
  assert.deepEqual(body.results.map((r) => r.id), ['tiger:1000:L', 'tiger:1001:R', 'tiger:1002:L', 'tiger:1003:R', 'tiger:1004:L']);
});

test('a record missing its label or TIGER id is dropped rather than shown half-filled', async () => {
  const list = [
    clone(HQ, { matchedAddress: '' }), clone(HQ, { matchedAddress: undefined }), clone(HQ, { tigerLine: undefined }),
    clone(HQ, { tigerLine: { side: 'L' } }), null, 'text', HQ,
  ];
  const body = await (await call(TOKEN, { fetchImpl: json(matches(list)) })).json();
  assert.deepEqual(body.results.map((r) => r.id), ['tiger:657091557:L']);
});

test('every result is "interpolated": Census never reports a rooftop or a doorway', async () => {
  const list = [HQ, clone(HQ, { tigerLine: { side: 'R', tigerLineId: '5' } }), clone(HQ, { matchType: 'Exact', matchClass: 'rooftop' })];
  const body = await (await call(TOKEN, { fetchImpl: json(matches(list)) })).json();
  assert.equal(body.results.length, 3);
  assert.ok(body.results.every((r) => r.matchClass === 'interpolated'));
  assert.ok(body.results.every((r) => Object.keys(r).sort().join() === 'id,label,lat,lon,matchClass,state,zip'),
    'only the contract fields leave the function; the upstream record is not passed through');
});

test('every response on every path carries no-store, JSON utf-8 and nosniff, and no upstream cookie', async () => {
  for (const [name, run] of Object.entries(OUTCOMES)) {
    const res = await run();
    assert.equal(res.headers.get('cache-control'), 'no-store', name);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8', name);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', name);
    assert.equal(res.headers.get('set-cookie'), null, `${name}: the Census cookie stays on the server`);
    JSON.parse(await res.text());
  }
});

test('the query never appears in any response body, error or success', async () => {
  for (const [name, run] of Object.entries(OUTCOMES)) {
    const text = await (await run()).text();
    assert.ok(!text.includes(TOKEN), `${name} echoed the query`);
  }
  // Census itself echoes the input; the 200 "no match" body must not repeat it.
  const nm = JSON.stringify(FIX.noMatch.body);
  assert.ok(nm.includes('Zzxqv Plugh Way 99999'), 'the fixture really does carry the echo');
  const res = await call('Zzxqv Plugh Way 99999', { fetchImpl: json(FIX.noMatch.body) });
  assert.ok(!(await res.text()).includes('Zzxqv'));
});

test('anything but GET is 405 with Allow: GET and no upstream call', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
    let called = false;
    const res = await call(TOKEN, { method, fetchImpl: () => { called = true; return json(FIX.match.body)(); } });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('allow'), 'GET');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(called, false);
    assert.ok(!(await res.text()).includes(TOKEN));
  }
});

test('the Pages entry points hand the request to the handler', async () => {
  const get = new Request(`https://headlessmode.com/api/geocode?q=${encodeURIComponent('a')}`);
  assert.equal((await onRequestGet({ request: get })).status, 400, 'GET reaches the handler (and its validation)');
  const post = new Request('https://headlessmode.com/api/geocode?q=abc', { method: 'POST' });
  assert.equal((await onRequest({ request: post })).status, 405, 'other methods get the 405, not a static-asset 404');
});

test('the function never logs, stores or forwards: a source-level backstop', () => {
  assert.doesNotMatch(CODE, /console\./, 'a console call is a log line that could carry the query');
  assert.doesNotMatch(CODE, /request\.headers|\.headers\.get\(|cookie/i, 'no reader header is read at all');
  assert.doesNotMatch(CODE, /\b(caches|KV|env\.|localStorage|waitUntil|cf:)/, 'nothing is stored or cached');
  assert.doesNotMatch(CODE, /\bimport\b/, 'no dependency');
});

test('_routes.json confines the Function to /api/*, so every other request is a free static hit', () => {
  const routes = JSON.parse(readFileSync(ROUTES, 'utf8'));
  assert.deepEqual(routes, { version: 1, include: ['/api/*'], exclude: [] });
});
