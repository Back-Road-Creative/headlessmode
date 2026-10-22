// A box-wide cap on how many headless Chromiums the qcm tests run at once.
//
// Every browser test file is its own `node --test` process and launches its own
// Chromium; node runs availableParallelism()-1 files at a time, so on this 12-core
// box one suite is 11 browsers, and the two PR-CI jobs plus a deploy job plus a
// session's local run that share the box are 30-40 -- each one fine alone, the SUM
// what took the VM down on 2026-09-28 (~1,900 Chromium PIDs started in 73 minutes,
// journald "Under memory pressure" until the operator restarted WSL at 18:13 EDT).
// Nothing in node, the workflow, or the cgroup the runners live in bounds that sum:
// the memory caps only decide who gets killed once it is already too late.
//
// So the bound lives where the browser is started. A launch takes one of
// QCM_BROWSER_SLOTS (default 4) slot files under one directory every process on the
// box can see, and waits -- bounded, then fails with the holders named -- when they
// are all taken. A slot is a file holding the owner's pid; an owner that died without
// releasing (SIGKILLed test process, cancelled job) is detected by the pid and the slot
// reclaimed, so a crash never leaks a slot for good. Node built-ins only, like the
// rest of this helper set. browser-slots.test.mjs holds every property below.
//
// The reserve, in plain words: a CI job and a session's local run are the same OS
// user, so the pid check cannot tell them apart, and on 2026-10-06 local runs held all
// four slots while PR CI waited out its 300 s and failed. Only the environment tells
// them apart: GitHub sets GITHUB_ACTIONS in every job step, a session shell has
// neither. So a process outside GitHub Actions never takes the first RESERVE slots
// (default half of them: slot-0 and slot-1 of 4); those are CI's. QCM_BROWSER_SLOT_RESERVE
// sets the number explicitly (0 gives a local run every slot, e.g. a box with no runner).
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const DEFAULT_SLOTS = 4;

/** One directory for every user and job on the box: a per-user or per-job directory
 *  would bound each of them and not their sum, which is the fault. Under tmpdir so a
 *  runner's `git clean` never touches it, and world-writable (sticky) so the runners'
 *  user and a session's user share it; the chmod is best-effort because a directory
 *  another user created is already fine to use. Override: QCM_BROWSER_SLOT_DIR. */
export function slotDir() {
  const dir = process.env.QCM_BROWSER_SLOT_DIR || path.join(tmpdir(), 'qcm-browser-slots');
  mkdirSync(dir, { recursive: true });
  try { chmodSync(dir, 0o1777); } catch { /* not ours to chmod; still usable */ }
  return dir;
}

/** How many slots the box allows; `QCM_BROWSER_SLOTS=0` disables the cap (a local
 *  developer with the box to themselves). */
export function slotCount(env = process.env) {
  const raw = env.QCM_BROWSER_SLOTS;
  if (raw === undefined || raw === '') return DEFAULT_SLOTS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`QCM_BROWSER_SLOTS must be a non-negative integer, got ${JSON.stringify(raw)}`);
  return n;
}

/** How many of the lowest-numbered slots a process outside GitHub Actions must leave
 *  alone. QCM_BROWSER_SLOT_RESERVE when set; else 0 inside GitHub Actions (CI takes any
 *  slot) and half the slots (rounded down) everywhere else. */
export function slotReserve(env = process.env) {
  const raw = env.QCM_BROWSER_SLOT_RESERVE;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new Error(`QCM_BROWSER_SLOT_RESERVE must be a non-negative integer, got ${JSON.stringify(raw)}`);
    return n;
  }
  if (env.GITHUB_ACTIONS) return 0;
  return Math.floor(slotCount(env) / 2);
}

/** Whether a pid is still running. EPERM is another user's live process (the runners
 *  and a session run as different users on this box) and counts as alive; only ESRCH
 *  is a dead owner. */
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tries every slot from `reserve` up, once. Returns the held slot's file, or null when all are taken. A
 *  slot whose owner is dead is reclaimed on the way past; the `wx` open is what makes
 *  two reclaimers race safely -- only one of them creates the file, the other sees
 *  EEXIST, re-reads a live pid, and moves on. */
function tryAcquire(dir, slots, reserve, pid, isAlive) {
  for (let i = reserve; i < slots; i++) {
    const file = path.join(dir, `slot-${i}`);
    for (let attempt = 0; attempt < 3; attempt++) {
      let fd;
      try { fd = openSync(file, 'wx'); } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        let owner = NaN;
        try { owner = Number(readFileSync(file, 'utf8').trim()); } catch { continue; /* removed under us */ }
        const hasPid = Number.isInteger(owner) && owner > 0;
        if (hasPid && isAlive(owner)) break;          // taken: next slot
        // A dead owner, or (on the second look) a file that never got its pid -- a
        // writer is between open and write for microseconds, not two attempts.
        if (hasPid || attempt >= 1) { try { unlinkSync(file); } catch { /* the other reclaimer got it */ } }
        continue;
      }
      writeSync(fd, String(pid));
      closeSync(fd);
      return file;
    }
  }
  return null;
}

/** Who holds the slots right now, for the error a starved launch throws. */
function holders(dir, slots) {
  const out = [];
  for (let i = 0; i < slots; i++) {
    try { out.push(`slot-${i}=pid ${readFileSync(path.join(dir, `slot-${i}`), 'utf8').trim()}`); } catch { /* free */ }
  }
  return out.join(', ') || 'none';
}

/** Takes one browser slot, waiting up to `waitMs` for one to free up. Resolves to a
 *  release function (idempotent; safe to call from a cleanup that may run twice).
 *  With `slots` 0 there is no cap and the release is a no-op. The wait is bounded so
 *  a starved file fails with the reason in the message rather than sitting mute until
 *  the workflow's 600 s per-file timeout cancels it with nothing named. */
export async function acquireBrowserSlot({
  dir = slotDir(), slots = slotCount(), reserve = slotReserve(), pid = process.pid, isAlive = pidAlive,
  waitMs = Number(process.env.QCM_BROWSER_SLOT_WAIT_MS) || 300000, pollMs = 250, now = Date.now,
} = {}) {
  if (slots === 0) return () => {};
  if (reserve >= slots) {
    throw new Error(`browser slot reserve ${reserve} leaves no slot of ${slots} for this process; lower QCM_BROWSER_SLOT_RESERVE `
      + 'or raise QCM_BROWSER_SLOTS (a run that could never launch fails now rather than after the wait)');
  }
  const end = now() + waitMs;
  for (;;) {
    const file = tryAcquire(dir, slots, reserve, pid, isAlive);
    if (file) {
      let held = true;
      return () => { if (!held) return; held = false; try { unlinkSync(file); } catch { /* already reclaimed */ } };
    }
    if (now() >= end) {
      const reserved = reserve > 0 ? `, slot-0..slot-${reserve - 1} reserved for CI` : '';
      throw new Error(`no free browser slot in ${dir} after ${waitMs} ms (${slots} slots${reserved}: ${holders(dir, slots)}); `
        + 'the box is running as many Chromiums as it can -- raise QCM_BROWSER_SLOTS only with the memory to match; '
        + `this process may use ${slots - reserve} of them (reserve ${reserve}, set QCM_BROWSER_SLOT_RESERVE)`);
    }
    await sleep(pollMs);
  }
}
