// One way to read from the network in this map: a deadline that always fires, a caller
// cancel that is never mistaken for a timeout, and latest-wins for a reader who keeps typing.
//
// Three hand-written copies of "abort after N ms" existed before this file, and two of them
// only applied the deadline when `AbortSignal.any` was there. The deadline here uses a plain
// AbortController, so it works in every browser and in a test double, and it settles the
// call itself, so a fetch that ignores its signal still ends as a timeout.

/** A signal that aborts when the caller's does or after `timeoutMs`, whichever is first.
 *  `timedOut` is true only when the timer ended it. Call `dispose()` once the work settles:
 *  it clears the timer and removes the listener from the caller's signal. */
export function withDeadline(signal, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive number; a request with no deadline is the bug this file prevents.');
  }
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort); }
  const timer = setTimeout(() => {
    if (!(signal && signal.aborted)) timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    dispose() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

const readJson = (res) => res.json();

/** One bounded request that reads its JSON body inside the deadline. Never throws.
 *  - `{ ok: true, status: 'ok', httpStatus, body }`
 *  - `{ ok: false, status: 'timeout', error }`   -- `timeoutMs` passed with no answer, or the
 *    request was abandoned by something other than the caller.
 *  - `{ ok: false, status: 'aborted', error }`   -- the caller's own `signal` ended it.
 *  - `{ ok: false, status: 'error', error }`     -- network failure, a non-2xx (`httpStatus`
 *    is set), or a body that is not JSON (`malformed: true`).
 *  `init` is passed to fetch beside the deadline signal; `read` swaps the body reader. */
export async function fetchWithDeadline(url, { fetchImpl = globalThis.fetch, signal, timeoutMs, init, read = readJson } = {}) {
  if (signal && signal.aborted) return { ok: false, status: 'aborted', error: 'aborted' };
  // A missing or bad deadline is a caller bug, but this call promises never to throw, so it
  // comes back as an error the panel can show instead of an exception that kills the panel.
  let deadline;
  try { deadline = withDeadline(signal, timeoutMs); } catch (err) { return { ok: false, status: 'error', error: err.message }; }
  // Rejects when the deadline or the caller ends the call, so a fetchImpl that never
  // looks at its signal cannot hold this call open. It waits one macrotask first: a real
  // fetch rejects within microtasks of the abort, and an answer already in hand still counts.
  let grace;
  const ended = new Promise((_, reject) => {
    deadline.signal.addEventListener('abort', () => {
      grace = setTimeout(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), 0);
    }, { once: true });
  });
  const work = (async () => {
    const res = await fetchImpl(url, { ...init, signal: deadline.signal });
    if (!res.ok) return { ok: false, status: 'error', httpStatus: res.status, error: `HTTP ${res.status}` };
    let body;
    try { body = await read(res); } catch (err) {
      if (deadline.signal.aborted) throw err;
      return { ok: false, status: 'error', malformed: true, error: 'Malformed JSON response.' };
    }
    return { ok: true, status: 'ok', httpStatus: res.status, body };
  })();
  try {
    return await Promise.race([work, ended]);
  } catch (err) {
    // The caller's cancel is judged first. An AbortError nobody here asked for (the browser
    // giving up on the request) reads as a timeout, as fetchJson always treated it.
    if (signal && signal.aborted) return { ok: false, status: 'aborted', error: err?.message || 'aborted' };
    if (deadline.timedOut || err?.name === 'AbortError') return { ok: false, status: 'timeout', error: `No answer within ${timeoutMs} ms.` };
    return { ok: false, status: 'error', error: err?.message || String(err) };
  } finally {
    clearTimeout(grace);
    deadline.dispose();
  }
}

/** Latest wins. `begin()` aborts whatever the previous call was doing and hands out a
 *  token and a fresh signal; `isCurrent(token)` is false once a newer call has begun.
 *  `run(task)` wraps both: `task(signal)` runs, and the answer is `{ stale, value }` --
 *  a stale answer is never to be drawn. A stale task that throws is stale, not an error. */
export function createLatest() {
  let generation = 0;
  let controller = null;
  const begin = () => {
    if (controller) controller.abort();
    controller = new AbortController();
    return { token: ++generation, signal: controller.signal };
  };
  const isCurrent = (token) => token === generation;
  async function run(task) {
    const { token, signal } = begin();
    try {
      const value = await task(signal);
      return { stale: !isCurrent(token), value };
    } catch (err) {
      if (!isCurrent(token)) return { stale: true, value: undefined };
      throw err;
    }
  }
  return { begin, isCurrent, run };
}

/** A late response for a query the reader has already replaced must never overwrite what
 *  is on screen. `bump()` on every new submission, hand the returned token to the in-flight
 *  call, and check `isCurrent(token)` once it resolves before rendering -- an older token
 *  means a newer search has since started and this result is stale. */
export function createSearchGuard() {
  const latest = createLatest();
  return { bump: () => latest.begin().token, isCurrent: latest.isCurrent };
}
