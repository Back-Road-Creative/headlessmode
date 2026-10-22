// QQA-04b: the finder's street-address lookup, without a browser.
//
// geocodeAddress asks this site's own GET /api/geocode?q= (QQA-04a answers it from the
// U.S. Census geocoder). The contract is shared with that function, so these tests
// stub fetch with exactly the bodies and statuses it documents. Fixtures are
// synthetic: an invented road and the Census Bureau's public headquarters address; a
// private residence never appears in the repo (plan section 4.2 / QQA-00).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  geocodeAddress, buildGeocodeUrl, GEOCODE_TIMEOUT_MS,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/address-geocode.js';
import {
  addressStatusText, ADDRESS_ESTIMATE_NOTE, ADDRESS_PROMPT_MESSAGE, ADDRESS_UNAVAILABLE_MESSAGE,
  groupFinderResults, rankFinderGroups, flattenGroups, GROUP_ORDER,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/search-shell.js';

const QUERY = '100 Example Rd, Anytown, NC';
const HIT = (n) => ({
  id: `tiger:9000${n}:L`, label: `${n}00 EXAMPLE RD, ANYTOWN, NC, 28000`, matchClass: 'interpolated',
  lat: 35.5 + n / 100, lon: -82.5, state: 'NC', zip: '28000',
});
const ok = (results) => ({ provider: 'us-census', benchmark: 'Public_AR_Current', results });
const reply = (status, body) => async () => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

test('the request is one same-origin GET with the query encoded and nothing else', async () => {
  assert.equal(buildGeocodeUrl('  ' + QUERY + '  '), '/api/geocode?q=' + encodeURIComponent(QUERY));
  let seen;
  const out = await geocodeAddress(QUERY, { fetchImpl: async (url, init) => { seen = { url, init }; return reply(200, ok([HIT(1)]))(); } });
  assert.equal(out.status, 'ready');
  assert.equal(seen.url, '/api/geocode?q=' + encodeURIComponent(QUERY));
  assert.equal(seen.init.credentials, 'omit', 'cookies must not ride along');
  assert.equal(seen.init.referrerPolicy, 'no-referrer');
  assert.equal(seen.init.cache, 'no-store');
  assert.equal(seen.init.method === undefined || seen.init.method === 'GET', true);
  assert.ok(seen.init.signal, 'the request must be cancellable');
});

test('a 200 with matches is ready, keeps the provider fields and caps at five', async () => {
  const six = [1, 2, 3, 4, 5, 6].map(HIT);
  const out = await geocodeAddress(QUERY, { fetchImpl: reply(200, ok(six)) });
  assert.equal(out.status, 'ready');
  assert.equal(out.results.length, 5);
  assert.deepEqual(out.results[0], {
    id: 'tiger:90001:L', label: '100 EXAMPLE RD, ANYTOWN, NC, 28000', matchClass: 'interpolated',
    lat: 35.51, lon: -82.5, state: 'NC', zip: '28000', provider: 'us-census', benchmark: 'Public_AR_Current',
  });
});

test('rows with no label or a point that is not a finite coordinate are dropped, never guessed', async () => {
  const bad = [
    { ...HIT(1), label: '' }, { ...HIT(2), lat: 'x' }, { ...HIT(3), lon: null },
    { ...HIT(4), lat: 95 }, { ...HIT(5), lon: -181 }, null, 7, HIT(6),
  ];
  const out = await geocodeAddress(QUERY, { fetchImpl: reply(200, ok(bad)) });
  assert.equal(out.status, 'ready');
  assert.deepEqual(out.results.map((r) => r.id), ['tiger:90006:L']);
});

test('an empty results array is a real no-match; nothing usable in it is too', async () => {
  assert.equal((await geocodeAddress(QUERY, { fetchImpl: reply(200, ok([])) })).status, 'none');
  assert.equal((await geocodeAddress(QUERY, { fetchImpl: reply(200, ok([{ label: '' }])) })).status, 'none');
});

test('every failure maps to its own status and none of them is a no-match', async () => {
  const want = [
    [502, { error: 'upstream' }, 'unavailable'],
    [504, { error: 'timeout' }, 'timeout'],
    [429, { error: 'rate-limited' }, 'rate-limited'],
    [400, { error: 'bad-query' }, 'bad-query'],
    [404, { error: 'not-found' }, 'unavailable'],
    [500, {}, 'unavailable'],
  ];
  for (const [status, body, expected] of want) {
    const out = await geocodeAddress(QUERY, { fetchImpl: reply(status, body) });
    assert.equal(out.status, expected, `HTTP ${status}`);
    assert.equal(out.results, undefined);
  }
  const notJson = async () => new Response('<html>nope</html>', { status: 200 });
  assert.equal((await geocodeAddress(QUERY, { fetchImpl: notJson })).status, 'unavailable');
  assert.equal((await geocodeAddress(QUERY, { fetchImpl: reply(200, { provider: 'us-census' }) })).status, 'unavailable');
  const offline = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal((await geocodeAddress(QUERY, { fetchImpl: offline })).status, 'unavailable');
});

test('text the endpoint would refuse never goes out', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return reply(200, ok([HIT(1)]))(); };
  for (const q of ['', '  ', 'ab', 'x'.repeat(201), null, undefined]) {
    assert.equal((await geocodeAddress(q, { fetchImpl })).status, 'bad-query', JSON.stringify(q));
  }
  assert.equal(calls, 0);
});

test('the caller cancelling is aborted, not an outage', async () => {
  const ctl = new AbortController();
  const hang = (_url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new DOMException('x', 'AbortError'))));
  const p = geocodeAddress(QUERY, { fetchImpl: hang, signal: ctl.signal });
  ctl.abort();
  assert.equal((await p).status, 'aborted');
  ctl.signal.aborted && assert.equal((await geocodeAddress(QUERY, { fetchImpl: hang, signal: ctl.signal })).status, 'aborted');
});

test('the deadline is 10 s and an answer that never comes is a timeout', async () => {
  assert.equal(GEOCODE_TIMEOUT_MS, 10000);
  const hang = (_url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new DOMException('x', 'AbortError'))));
  const out = await geocodeAddress(QUERY, { fetchImpl: hang, timeoutMs: 20 });
  assert.equal(out.status, 'timeout');
});

test('the module never logs or stores what was typed', async () => {
  const seen = [];
  const keep = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => seen.push(a);
  try {
    await geocodeAddress(QUERY, { fetchImpl: reply(502, { error: 'upstream' }) });
    await geocodeAddress(QUERY, { fetchImpl: async () => { throw new Error(QUERY); } });
  } finally { Object.assign(console, keep); }
  assert.deepEqual(seen, []);
});

// --- the wording and the grouping ---------------------------------------------------

test('a street match is always said to be an estimate along the street, never a doorstep', () => {
  assert.match(ADDRESS_ESTIMATE_NOTE, /estimated along the street, not a doorstep/i);
  assert.match(addressStatusText('ready', 2), /^2 street matches/);
  assert.match(addressStatusText('ready', 1), /^1 street match\b/);
  for (const n of [1, 2]) assert.match(addressStatusText('ready', n), /estimated along the street, not a doorstep/i);
});

test('no match and unavailable are different sentences; both offer the alternatives; neither blames a town', () => {
  const none = addressStatusText('none');
  const down = addressStatusText('unavailable');
  assert.notEqual(none, down);
  for (const s of [none, down, addressStatusText('timeout'), addressStatusText('rate-limited'), addressStatusText('bad-query')]) {
    assert.match(s, /coordinates \(latitude, longitude\)/i, s);
    assert.match(s, /drag the map/i, s);
    assert.doesNotMatch(s, /no town|is in this list|no names|nearby|not available yet/i, s);
  }
  assert.match(none, /no street match/i);
  assert.doesNotMatch(none, /unavailable/i);
  assert.match(down, /unavailable right now/i);
  assert.equal(down, ADDRESS_UNAVAILABLE_MESSAGE);
  assert.match(addressStatusText('searching'), /looking up/i);
  assert.equal(addressStatusText('idle'), '');
});

test('typing an address only offers Search, and says where Search sends it', () => {
  assert.match(ADDRESS_PROMPT_MESSAGE, /press search/i);
  assert.match(ADDRESS_PROMPT_MESSAGE, /census/i);
  assert.doesNotMatch(ADDRESS_PROMPT_MESSAGE, /no town|not available|not found/i);
});

test('address rows form their own group, after coordinates and before towns', () => {
  assert.deepEqual(GROUP_ORDER, ['coordinate', 'address', 'town', 'name']);
  const groups = groupFinderResults({
    coordHit: { label: 'c', lat: 1, lon: 2 }, addressHits: [HIT(1), HIT(2)],
    townHits: [{ label: 't', lat: 1, lon: 2 }], nameHits: [{ name: 'n' }],
  });
  assert.deepEqual(groups.map((g) => g.id), ['coordinate', 'address', 'town', 'name']);
  assert.match(groups[1].label, /street/i);
  assert.deepEqual(flattenGroups(groups).map((i) => i.optionId), [0, 1, 2, 3, 4].map((i) => 'qc-place-opt-' + i));
  assert.deepEqual(rankFinderGroups(groups, { exactNameStateMatch: true }).map((g) => g.id),
    ['coordinate', 'address', 'name', 'town']);
  assert.deepEqual(groupFinderResults({ addressHits: [] }), []);
});
