// readyDashboard()'s start-up waits (the map, then the last-job restore) never run
// on a budget below WAIT_MS, whatever a proof passes as `ms`.
//
// Fourteen browser proofs define a 20 s `CEILING` for the waits inside their own
// proof and handed the same 20 s to readyDashboard() for start-up. WAIT_MS is 60 s
// precisely because load 45 is this box's operating condition (waits.mjs); under
// three concurrent PR CI runs on 2026-10-07 the dashboard took longer than 20 s to
// restore and 4 proofs on #734 (and 3 on #733, 1 on #731) failed before asserting
// anything: "waited 20000 ms and the last-job restore to settle
// (window.qcRestoreSettled) never came true, and the page reports no failure of its
// own". The budget a proof measures its own steps by is not the budget the page
// needs to start, so the helper floors the latter and `ms` only ever raises it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readyDashboard, startupBudget, WAIT_MS, WAITS_SRC } from './helpers/waits.mjs';

test('startupBudget: a budget below WAIT_MS is raised to it; one above is kept', () => {
  assert.equal(startupBudget(20000), WAIT_MS);
  assert.equal(startupBudget(WAIT_MS), WAIT_MS);
  assert.equal(startupBudget(90000), 90000);
  assert.equal(startupBudget(undefined), WAIT_MS);
});

/** A page whose map is "ready" only on the Nth poll, with no trouble to report.
 *  The clock is stepped so each poll looks 25 s later than the last: a 20 s budget
 *  runs out on the first poll, a 60 s one survives to the third. */
function slowPage(readyOnPoll) {
  let polls = 0;
  return {
    polls: () => polls,
    async evaluate(expression) {
      if (expression === WAITS_SRC) return undefined;
      if (expression.includes('qcMap')) { polls += 1; return polls >= readyOnPoll; }
      if (expression.includes('qcRestoreSettled')) return true;
      return null;                                   // PAGE_TROUBLE: nothing to report
    },
  };
}

test('readyDashboard with ms: 20000 still waits WAIT_MS for the map', async (t) => {
  const realNow = performance.now;
  let now = 0;
  performance.now = () => { now += 25000; return now; };   // every look at the clock is +25 s
  t.after(() => { performance.now = realNow; });
  const page = slowPage(3);
  await readyDashboard(page, { data: false, ms: 20000 });
  assert.equal(page.polls(), 3, 'the map wait gave up before its third poll');
});
