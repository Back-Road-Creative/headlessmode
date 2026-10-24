// The one request helper every remote read in the map goes through: a deadline that
// always fires, a caller abort that is never called a timeout, and latest-wins.
// No network: every fetch is a fake, and the timing slack is scheduler allowance.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchWithDeadline, withDeadline, createLatest, createSearchGuard, orThrow,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/request.js';
import { createForecastLoader } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-weather.js';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { alertsFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-nws-alerts.js';

const SLACK_MS = 250;
const never = () => new Promise(() => {});
const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });

// Run `fn` with AbortSignal.any removed, the way an older browser or a test double sees it.
async function withoutAbortSignalAny(fn) {
  const saved = AbortSignal.any;
  delete AbortSignal.any;
  try { return await fn(); } finally { AbortSignal.any = saved; }
}

test('a fetch that never resolves ends as timeout within the deadline plus slack', async () => {
  const t0 = Date.now();
  const got = await fetchWithDeadline('https://x.invalid/a', { fetchImpl: never, timeoutMs: 50 });
  assert.equal(got.ok, false);
  assert.equal(got.status, 'timeout');
  assert.ok(Date.now() - t0 < 50 + SLACK_MS, `took ${Date.now() - t0} ms`);
});

test('a caller abort is aborted, never timeout, before and during the request', async () => {
  const pre = new AbortController();
  pre.abort();
  let calls = 0;
  const r0 = await fetchWithDeadline('https://x.invalid/a', { fetchImpl: () => { calls += 1; return never(); }, signal: pre.signal, timeoutMs: 5000 });
  assert.equal(r0.status, 'aborted');
  assert.equal(calls, 0, 'an already-cancelled call never reaches the network');

  const mid = new AbortController();
  const pending = fetchWithDeadline('https://x.invalid/a', { fetchImpl: never, signal: mid.signal, timeoutMs: 5000 });
  setTimeout(() => mid.abort(), 20);
  const r1 = await pending;
  assert.equal(r1.ok, false);
  assert.equal(r1.status, 'aborted');
});

test('the timer is cleared and the caller listener removed once the call settles', async () => {
  const set = [], cleared = [];
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  globalThis.setTimeout = (...a) => { const id = realSet(...a); set.push(id); return id; };
  globalThis.clearTimeout = (id) => { cleared.push(id); return realClear(id); };
  const caller = new AbortController();
  let added = 0, removed = 0;
  const realAdd = caller.signal.addEventListener.bind(caller.signal);
  const realRemove = caller.signal.removeEventListener.bind(caller.signal);
  caller.signal.addEventListener = (...a) => { added += 1; return realAdd(...a); };
  caller.signal.removeEventListener = (...a) => { removed += 1; return realRemove(...a); };
  try {
    const ok = await fetchWithDeadline('https://x.invalid/a', { fetchImpl: async () => json({ a: 1 }), signal: caller.signal, timeoutMs: 5000 });
    assert.deepEqual(ok.body, { a: 1 });
    const bad = await fetchWithDeadline('https://x.invalid/a', { fetchImpl: async () => { throw new Error('offline'); }, signal: caller.signal, timeoutMs: 5000 });
    assert.equal(bad.status, 'error');
    assert.equal(bad.error, 'offline');
  } finally { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; }
  assert.equal(added, 2);
  assert.equal(removed, added, 'every listener added is removed');
  for (const id of set) assert.ok(cleared.includes(id), 'every timer started is cleared');
});

test('the deadline fires without AbortSignal.any, for the helper and both loaders', async () => {
  await withoutAbortSignalAny(async () => {
    assert.equal(typeof AbortSignal.any, 'undefined');
    const got = await fetchWithDeadline('https://x.invalid/a', { fetchImpl: never, timeoutMs: 40 });
    assert.equal(got.status, 'timeout');

    // A load that ends only when its signal aborts: if no timeout reaches it, this hangs.
    const endsOnAbort = ({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ status: 'aborted-by-signal' }), { once: true });
    });
    const loader = createForecastLoader({ load: endsOnAbort, timeoutMs: 40 });
    const t0 = Date.now();
    const weather = await loader.request({ lat: 35, lon: -83 });
    assert.equal(weather.status, 'aborted-by-signal');
    assert.ok(Date.now() - t0 < 40 + SLACK_MS);

    const t1 = Date.now();
    const alerts = await alertsFor({ lat: 35, lon: -83, timeoutMs: 40, fetchImpl: (_u, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }) });
    assert.notEqual(alerts, undefined);
    assert.ok(Date.now() - t1 < 40 + SLACK_MS, 'the alerts request ended by its own deadline');
  });
});

test('withDeadline: timedOut is true only when the timer, not the caller, ended it', async () => {
  const d = withDeadline(undefined, 20);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(d.signal.aborted, true);
  assert.equal(d.timedOut, true);
  d.dispose();
  const caller = new AbortController();
  const e = withDeadline(caller.signal, 5000);
  caller.abort();
  assert.equal(e.signal.aborted, true);
  assert.equal(e.timedOut, false);
  e.dispose();
  assert.throws(() => withDeadline(undefined, 0), RangeError);
  assert.throws(() => withDeadline(undefined, undefined), RangeError);
});

test('HTTP failure, bad JSON and a good body keep their own shapes', async () => {
  const http = await fetchWithDeadline('u', { fetchImpl: async () => ({ ok: false, status: 503 }), timeoutMs: 1000 });
  assert.deepEqual([http.ok, http.status, http.httpStatus, http.error], [false, 'error', 503, 'HTTP 503']);
  const bad = await fetchWithDeadline('u', { fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } }), timeoutMs: 1000 });
  assert.deepEqual([bad.ok, bad.status, bad.malformed, bad.error], [false, 'error', true, 'Malformed JSON response.']);
  const sent = [];
  const good = await fetchWithDeadline('u', { fetchImpl: async (u, init) => { sent.push(init); return json({ z: 1 }); }, init: { method: 'POST' }, timeoutMs: 1000 });
  assert.deepEqual([good.ok, good.status, good.httpStatus, good.body], [true, 'ok', 200, { z: 1 }]);
  assert.equal(sent[0].method, 'POST');
  assert.ok(sent[0].signal instanceof AbortSignal);
});

test('createLatest: a new call aborts the previous one and the first result is stale', async () => {
  const latest = createLatest();
  const seen = [];
  const task = (label) => (signal) => new Promise((resolve) => {
    seen.push({ label, signal });
    signal.addEventListener('abort', () => resolve(`${label}-aborted`), { once: true });
    if (label === 'second') setTimeout(() => resolve('second-done'), 10);
  });
  const first = latest.run(task('first'));
  const second = latest.run(task('second'));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(seen[0].signal.aborted, true, 'the first call was aborted by the second');
  assert.equal(seen[1].signal.aborted, false);
  assert.equal(a.stale, true);
  assert.equal(b.stale, false);
  assert.equal(b.value, 'second-done');
});

test('createLatest: a stale call that throws is stale, a current one rethrows', async () => {
  const latest = createLatest();
  const first = latest.run(() => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 10)));
  const second = latest.run(async () => 'ok');
  assert.deepEqual(await first, { stale: true, value: undefined });
  assert.equal((await second).value, 'ok');
  await assert.rejects(latest.run(async () => { throw new Error('boom'); }), /boom/);
});

test('createSearchGuard keeps its bump / isCurrent contract on the shared helper', () => {
  const guard = createSearchGuard();
  const a = guard.bump();
  assert.equal(guard.isCurrent(a), true);
  const b = guard.bump();
  assert.equal(guard.isCurrent(a), false);
  assert.equal(guard.isCurrent(b), true);
});

// The registry's timeoutMs is the deadline for the two NWS loaders, not a number they restate.
// A fake clock stands in for the wait: nothing ends the request but the timer.
test('the forecast and alerts loaders take their default deadline from the registry', async () => {
  const endsOnAbort = (signal, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  for (const [id, run] of [
    ['nwsForecast', (opts) => createForecastLoader({ load: ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ status: 'ended' }), { once: true })), ...opts }).request({ lat: 35, lon: -83 })],
    ['nwsAlerts', (opts) => alertsFor({ lat: 35, lon: -83, fetchImpl: (_u, { signal }) => new Promise((_, reject) => endsOnAbort(signal, reject)), ...opts })],
  ]) {
    const ms = SOURCES[id].timeoutMs;
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let settled = false;
      const pending = run({}).then(() => { settled = true; });
      mock.timers.tick(ms - 1);
      await new Promise((r) => setImmediate(r));
      assert.equal(settled, false, `${id} ended before its registry deadline of ${ms} ms`);
      mock.timers.tick(1);
      await new Promise((r) => setImmediate(r));
      assert.equal(settled, true, `${id} did not end at its registry deadline of ${ms} ms`);
      await pending;
    } finally { mock.timers.reset(); }
  }
});

test('fetchWithDeadline with no timeoutMs returns an error rather than throwing', async () => {
  let called = false;
  const result = await fetchWithDeadline('https://example.test/a', { fetchImpl: async () => { called = true; return new Response('{}'); } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
  assert.match(result.error, /timeoutMs/);
  assert.equal(called, false);
});

test('anyStatus reads the body of a non-2xx answer; without it the body is never read', async () => {
  const problem = { detail: 'No forecast for this point.' };
  let reads = 0;
  const notFound = { ok: false, status: 404, json: async () => { reads += 1; return problem; } };
  const plain = await fetchWithDeadline('https://x.invalid/a', { fetchImpl: async () => notFound, timeoutMs: 1000 });
  assert.equal(plain.ok, false);
  assert.equal(plain.httpStatus, 404);
  assert.equal(plain.body, undefined);
  assert.equal(reads, 0);
  const any = await fetchWithDeadline('https://x.invalid/a', { fetchImpl: async () => notFound, timeoutMs: 1000, anyStatus: true });
  assert.equal(any.ok, false);
  assert.equal(any.status, 'error');
  assert.equal(any.httpStatus, 404);
  assert.deepEqual(any.body, problem);
  const unreadable = { ok: false, status: 502, json: async () => { throw new SyntaxError('<html>'); } };
  const bad = await fetchWithDeadline('https://x.invalid/a', { fetchImpl: async () => unreadable, timeoutMs: 1000, anyStatus: true });
  assert.equal(bad.httpStatus, 502);
  assert.equal(bad.body, undefined);
  assert.equal(bad.malformed, undefined, 'a bad body on an error status is the error, not a malformed answer');
  const okBad = { ok: true, status: 200, json: async () => { throw new SyntaxError('<html>'); } };
  const malformed = await fetchWithDeadline('https://x.invalid/a', { fetchImpl: async () => okBad, timeoutMs: 1000, anyStatus: true });
  assert.equal(malformed.malformed, true);
});

test('a custom reader that fails is not reported as bad JSON', async () => {
  const res = { ok: true, status: 200, arrayBuffer: async () => { throw new Error('stream cut'); } };
  const got = await fetchWithDeadline('https://x.invalid/a', { fetchImpl: async () => res, timeoutMs: 1000, read: (r) => r.arrayBuffer() });
  assert.equal(got.malformed, true);
  assert.doesNotMatch(got.error, /JSON/);
});

test('orThrow hands back an ok body and throws everything else with its status', async () => {
  assert.deepEqual(orThrow({ ok: true, status: 'ok', body: { a: 1 } }), { a: 1 });
  assert.throws(() => orThrow({ ok: false, status: 'error', httpStatus: 503, error: 'HTTP 503' }),
    (err) => err.message === 'HTTP 503' && err.status === 'error' && err.httpStatus === 503);
  assert.throws(() => orThrow({ ok: false, status: 'timeout', error: 'No answer within 5 ms.' }, 'Elevation: slow.'),
    (err) => err.message === 'Elevation: slow.' && err.status === 'timeout' && err.httpStatus === undefined);
  assert.throws(() => orThrow({ ok: false, status: 'aborted', error: 'aborted' }),
    (err) => err.name === 'AbortError' && err.status === 'aborted');
});
