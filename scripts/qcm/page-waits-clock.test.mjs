// The page-side waits must measure their ceiling on a clock that only counts elapsed time.
//
// `qcWait` (WAITS_SRC in helpers/waits.mjs) runs inside the page and times out when its
// ceiling is spent. It read `Date.now()`, the wall clock, and the WSL2 box every runner
// shares steps that clock when it resyncs with the host. A CI run reported a 60,000 ms page
// wait giving up inside a test that had run 54.9 s in total: the clock jumped, and a wait
// that still had time left threw "never came true". The node-side `waitInPage` already
// measures on `performance.now()`, and so does `removeProfile` (see
// browser-profile-teardown.test.mjs). These tests evaluate WAITS_SRC against a stand-in
// window whose `Date.now()` jumps after its first call, so they need no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WAITS_SRC } from './helpers/waits.mjs';

const HOUR = 3_600_000;

/** Install the page-side waits on a fresh stand-in window. `jump(n)` is added to the
 *  real wall clock on the page's n-th `Date.now()` call. Once `stop()` is called the page
 *  schedules no more polls, so a wait that never ends cannot keep this file alive. */
function install(jump) {
  const realNow = Date.now;
  let calls = 0;
  let stopped = false;
  const pageDate = { now: () => realNow() + jump(calls++) };
  const pageTimeout = (fn, ms) => (stopped ? undefined : setTimeout(fn, ms));
  const win = {};
  new Function('window', 'Date', 'performance', 'setTimeout', `return ${WAITS_SRC}`)(
    win, pageDate, performance, pageTimeout);
  return { win, stop: () => { stopped = true; } };
}

/** Settle `promise` or report that it was still pending after `ms`. */
function within(promise, ms) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ late: true }), ms); });
  const settled = promise.then((value) => ({ value }), (error) => ({ error }));
  return Promise.race([settled, late]).finally(() => clearTimeout(timer));
}

test('a forward wall-clock jump does not end a wait that still has time left', async () => {
  const { win, stop } = install((n) => (n > 0 ? HOUR : 0));
  let polls = 0;
  try {
    const got = await within(win.qcWait('the third poll', () => (++polls >= 3 ? 'here' : null), 5000), 3000);
    assert.equal(got.error, undefined, `the wait threw after ${polls} poll(s) with time left: ${got.error?.message}`);
    assert.equal(got.value, 'here');
  } finally {
    stop();
  }
});

test('a backward wall-clock jump does not stretch the ceiling', async () => {
  const { win, stop } = install((n) => (n > 0 ? -HOUR : 0));
  try {
    const got = await within(win.qcWait('the impossible', () => false, 200), 3000);
    assert.ok(!got.late, 'a 200 ms wait was still waiting after 3 s: its ceiling moved with the wall clock');
    assert.match(String(got.error?.message), /^waited 200 ms and the impossible never came true$/);
  } finally {
    stop();
  }
});

test('with a steady clock the ceiling still ends the wait, and not before it is spent', async () => {
  const { win, stop } = install(() => 0);
  const start = performance.now();
  try {
    const got = await within(win.qcWait('the impossible', () => false, 200), 3000);
    assert.ok(!got.late, 'a 200 ms wait was still waiting after 3 s');
    assert.match(String(got.error?.message), /^waited 200 ms and the impossible never came true$/);
    assert.ok(performance.now() - start >= 200, `the wait gave up after ${Math.round(performance.now() - start)} ms`);
  } finally {
    stop();
  }
});
