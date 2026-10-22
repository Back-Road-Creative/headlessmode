// How many test files `node --test` may run at once on THIS box, right now.
//
// With no --test-concurrency flag node runs availableParallelism()-1 files at a time
// (11 on the 12-core CI box), and every browser file launches a Chromium. That is the
// right number on a quiet box and the wrong one on a loaded box: 2026-09-28 the two
// PR-CI jobs, a deploy job and a session's local run each did the same, load passed
// 40, the VM ran out of memory and the operator's editor went down with it. The slot
// cap in browser-slots.mjs bounds the browsers; this bounds how many files queue up
// for them, so a file's wait for a slot never eats the workflow's 600 s per-file
// budget with nothing of its own running.
//
// It also never lets more files run than there are browser slots this process may
// hold (slots - reserve, from browser-slots.mjs). Eleven files queued on four slots is
// what spends the 300 s slot waits: 2026-10-06 PR CI failed four files that way. So CI
// (reserve 0, 4 slots) runs 4 files at a time, down from 11 on a 12-core box, and a
// local run (reserve 2) runs 2, so no file ever waits on a slot it may not take.
//
// Same shape as band-coach's tests/helpers/browser.mjs, plus a memory floor: load
// alone is late (it lags a minute) and blind to memory, which was the resource that
// actually ran out.
//
// Usage in a workflow: node --test --test-concurrency=$(node scripts/qcm/helpers/test-concurrency.mjs) ...
import { availableParallelism, loadavg, freemem } from 'node:os';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { slotCount, slotReserve } from './browser-slots.mjs';

/** node's own default: one less than the core count, never below 1. Pinned by
 *  test-concurrency.test.mjs; if a future node changes it, that test says so. */
export const NODE_DEFAULT_CONCURRENCY = (cores) => Math.max(1, cores - 1);

/** What one in-flight browser file costs the box, and what the box must keep for
 *  everything that is not a test: the editor, the sessions, the runners' own
 *  listeners. 4 GiB is the same floor bin/pytest-slot.sh holds the Python suites to. */
export const PER_FILE_BYTES = 512 * 1024 * 1024;
export const RESERVE_BYTES = 4 * 1024 * 1024 * 1024;

/** MemAvailable, which counts reclaimable cache; os.freemem() is MemFree and reads a
 *  healthy box as nearly empty. Falls back to freemem() off Linux. */
export function memAvailableBytes() {
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'));
    if (m) return Number(m[1]) * 1024;
  } catch { /* not Linux */ }
  return freemem();
}

/** The concurrency for this moment. A quiet box (load at or below its core count,
 *  memory to spare) keeps node's default exactly; load above the core count throttles
 *  in proportion; memory below the reserve plus one file's share throttles to what
 *  fits; with a browser cap (slots > 0) at most slots - reserve files. Never below 1. QCM_TEST_CONCURRENCY overrides the whole calculation. */
export function computeTestConcurrency({
  cores = availableParallelism(), load1 = loadavg()[0], memAvailable = memAvailableBytes(), env = process.env,
  slots, reserve,
} = {}) {
  // The override is read before the slot knobs: a bad QCM_BROWSER_SLOT_RESERVE must not
  // crash a run that forced its concurrency, or $(...) in the workflow hands node nothing.
  const forced = env.QCM_TEST_CONCURRENCY;
  if (forced !== undefined && forced !== '') {
    const n = Number(forced);
    if (!Number.isInteger(n) || n < 1) throw new Error(`QCM_TEST_CONCURRENCY must be a positive integer, got ${JSON.stringify(forced)}`);
    return n;
  }
  if (slots === undefined) slots = slotCount(env);
  if (reserve === undefined) reserve = slotReserve(env);
  const base = NODE_DEFAULT_CONCURRENCY(cores);
  const byLoad = load1 > cores ? Math.round((base * cores) / load1) : base;
  const byMemory = Math.floor((memAvailable - RESERVE_BYTES) / PER_FILE_BYTES);
  const bySlots = slots > 0 ? Math.max(1, slots - reserve) : Infinity;
  return Math.max(1, Math.min(byLoad, byMemory, bySlots));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${computeTestConcurrency()}\n`);
}
