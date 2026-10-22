// The box-wide Chromium slot pool (helpers/browser-slots.mjs), held without a browser.
//
// The pool is the one thing that bounds the SUM of Chromiums across every job and
// session on the box -- the sum that ran the VM out of memory on 2026-09-28. So each
// property is pinned on its own: the cap holds across processes, a release frees the
// slot, a dead owner's slot is reclaimed, another user's live owner is not, the wait
// is bounded and names the holders, and 0 means no cap. launch() acquiring a slot
// is covered at the end against a real Chromium when one is on the box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireBrowserSlot, pidAlive, slotCount, slotReserve, DEFAULT_SLOTS } from './helpers/browser-slots.mjs';
import { findChromium, launch } from './helpers/browser.mjs';

const fresh = () => mkdtempSync(path.join(tmpdir(), 'qcm-slots-test-'));
const alive = () => true;
// reserve 0: the older cases count holders from slot-0, which is what a CI job sees.
const fast = { waitMs: 200, pollMs: 10, reserve: 0 };

test('the default cap is small enough that four jobs cannot repeat 2026-09-28', () => {
  assert.equal(DEFAULT_SLOTS, 4);
  assert.equal(slotCount({}), 4);
  assert.equal(slotCount({ QCM_BROWSER_SLOTS: '2' }), 2);
  assert.equal(slotCount({ QCM_BROWSER_SLOTS: '0' }), 0, '0 is the explicit no-cap');
  assert.throws(() => slotCount({ QCM_BROWSER_SLOTS: '-1' }), /non-negative integer/);
  assert.throws(() => slotCount({ QCM_BROWSER_SLOTS: 'lots' }), /non-negative integer/);
});

test('N slots admit N holders and the N+1th waits, then fails naming the holders', async () => {
  const dir = fresh();
  try {
    const held = [];
    for (let i = 0; i < 2; i++) held.push(await acquireBrowserSlot({ dir, slots: 2, pid: 100 + i, isAlive: alive, ...fast }));
    assert.deepEqual(readdirSync(dir).sort(), ['slot-0', 'slot-1']);
    assert.equal(readFileSync(path.join(dir, 'slot-0'), 'utf8'), '100', 'the slot file names its owner');
    const t0 = Date.now();
    await assert.rejects(
      acquireBrowserSlot({ dir, slots: 2, pid: 102, isAlive: alive, ...fast }),
      (err) => /no free browser slot/.test(err.message) && /pid 100/.test(err.message) && /pid 101/.test(err.message),
    );
    assert.ok(Date.now() - t0 >= 190, 'it waited the whole budget before giving up');
    held[0]();
    const again = await acquireBrowserSlot({ dir, slots: 2, pid: 102, isAlive: alive, ...fast });
    assert.equal(readFileSync(path.join(dir, 'slot-0'), 'utf8'), '102', 'the released slot is the one taken');
    again(); again();
    held[1]();
    assert.deepEqual(readdirSync(dir), [], 'every release, even a repeated one, leaves nothing behind');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a waiter gets the slot as soon as a holder releases, within its budget', async () => {
  const dir = fresh();
  try {
    const release = await acquireBrowserSlot({ dir, slots: 1, pid: 200, isAlive: alive, ...fast });
    setTimeout(release, 50);
    const t0 = Date.now();
    const mine = await acquireBrowserSlot({ dir, slots: 1, pid: 201, isAlive: alive, waitMs: 2000, pollMs: 10, reserve: 0 });
    assert.ok(Date.now() - t0 < 1000, 'took the slot when it freed, not at the deadline');
    mine();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a slot whose owner died is reclaimed; another user's live owner (EPERM) is not", async () => {
  const dir = fresh();
  try {
    writeFileSync(path.join(dir, 'slot-0'), '4000001');
    writeFileSync(path.join(dir, 'slot-1'), '4000002');
    const isAlive = (pid) => pid === 4000002 || pid === 300;
    const first = await acquireBrowserSlot({ dir, slots: 2, pid: 300, isAlive, ...fast });
    assert.equal(readFileSync(path.join(dir, 'slot-0'), 'utf8'), '300', 'the dead owner\'s slot was reclaimed');
    assert.equal(readFileSync(path.join(dir, 'slot-1'), 'utf8'), '4000002', 'the live owner keeps its slot');
    await assert.rejects(acquireBrowserSlot({ dir, slots: 2, pid: 301, isAlive, ...fast }), /no free browser slot/);
    first();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pidAlive: own pid is alive, an impossible pid is not', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(2 ** 22 - 1), false, 'above pid_max on every Linux default');
});

test('slots 0 is no cap: nothing written, release is a no-op', async () => {
  const dir = fresh();
  try {
    const release = await acquireBrowserSlot({ dir, slots: 0, pid: 400, isAlive: alive, ...fast });
    assert.deepEqual(readdirSync(dir), []);
    release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('slotReserve: CI keeps none, a local run keeps half, the knob wins, nonsense throws', () => {
  assert.equal(slotReserve({ GITHUB_ACTIONS: 'true' }), 0, 'a CI job takes any slot');
  assert.equal(slotReserve({}), 2, 'no env: 2 of the default 4 are CI\'s');
  assert.equal(slotReserve({ QCM_BROWSER_SLOTS: '6' }), 3);
  assert.equal(slotReserve({ QCM_BROWSER_SLOTS: '0' }), 0);
  assert.equal(slotReserve({ QCM_BROWSER_SLOT_RESERVE: '1' }), 1, 'explicit wins');
  assert.equal(slotReserve({ QCM_BROWSER_SLOT_RESERVE: '3', GITHUB_ACTIONS: 'true' }), 3, 'explicit beats CI');
  assert.equal(slotReserve({ QCM_BROWSER_SLOT_RESERVE: '0' }), 0);
  assert.throws(() => slotReserve({ QCM_BROWSER_SLOT_RESERVE: '-1' }), /non-negative integer/);
  assert.throws(() => slotReserve({ QCM_BROWSER_SLOT_RESERVE: 'some' }), /non-negative integer/);
});

test('a local acquirer (reserve 2 of 4) never creates slot-0 or slot-1', async () => {
  const dir = fresh();
  try {
    const a = await acquireBrowserSlot({ dir, slots: 4, pid: 500, isAlive: alive, ...fast, reserve: 2 });
    const b = await acquireBrowserSlot({ dir, slots: 4, pid: 501, isAlive: alive, ...fast, reserve: 2 });
    assert.deepEqual(readdirSync(dir).sort(), ['slot-2', 'slot-3'], 'slot-0 and slot-1 stay free for CI');
    await assert.rejects(
      acquireBrowserSlot({ dir, slots: 4, pid: 502, isAlive: alive, ...fast, reserve: 2 }),
      (err) => /no free browser slot/.test(err.message) && /QCM_BROWSER_SLOT_RESERVE/.test(err.message) && /reserve/.test(err.message),
      'waits and fails though slot-0 is free, naming the reserve and its knob',
    );
    assert.equal(readdirSync(dir).includes('slot-0'), false);
    // CI (reserve 0) finds slot-0 free of local competition.
    const ci = await acquireBrowserSlot({ dir, slots: 4, reserve: 0, pid: 503, isAlive: alive, ...fast });
    assert.equal(readFileSync(path.join(dir, 'slot-0'), 'utf8'), '503');
    ci(); a(); b();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reserve >= slots throws at once, naming both numbers', async () => {
  const dir = fresh();
  try {
    const t0 = Date.now();
    await assert.rejects(
      acquireBrowserSlot({ dir, slots: 2, reserve: 2, pid: 600, isAlive: alive, waitMs: 5000, pollMs: 10 }),
      (err) => /reserve/.test(err.message) && /\b2\b.*\b2\b/.test(err.message),
    );
    assert.ok(Date.now() - t0 < 1000, 'it did not wait');
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('slots 0 stays no cap even with a reserve', async () => {
  const dir = fresh();
  try {
    const release = await acquireBrowserSlot({ dir, slots: 0, pid: 700, isAlive: alive, ...fast, reserve: 2 });
    assert.deepEqual(readdirSync(dir), []);
    release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const CHROMIUM = findChromium();
test('launch() holds a slot while the browser runs and frees it on close', {
  skip: CHROMIUM ? false : 'no Chromium on this box (set CHROME_PATH to run this)',
}, async () => {
  const dir = fresh();
  const saved = { dir: process.env.QCM_BROWSER_SLOT_DIR, slots: process.env.QCM_BROWSER_SLOTS };
  process.env.QCM_BROWSER_SLOT_DIR = dir;
  process.env.QCM_BROWSER_SLOTS = '1';
  try {
    const page = await launch(CHROMIUM, 'about:blank');
    try {
      assert.deepEqual(readdirSync(dir), ['slot-0']);
      assert.equal(readFileSync(path.join(dir, 'slot-0'), 'utf8'), String(process.pid));
      await assert.rejects(
        launch(CHROMIUM, 'about:blank', { slotWaitMs: 200 }),
        /no free browser slot/,
        'a second launch under a 1-slot cap fails with the reason, never starts a browser',
      );
    } finally { page.close(); }
    assert.deepEqual(readdirSync(dir), [], 'close released the slot');
  } finally {
    for (const [k, v] of [['QCM_BROWSER_SLOT_DIR', saved.dir], ['QCM_BROWSER_SLOTS', saved.slots]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the starvation message for a CI acquirer (reserve 0) names no reserved range', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qcm-slots-'));
  const alive = () => true;
  const release = await acquireBrowserSlot({ dir, slots: 1, reserve: 0, pid: 800, isAlive: alive, ...fast });
  await assert.rejects(
    acquireBrowserSlot({ dir, slots: 1, reserve: 0, pid: 801, isAlive: alive, ...fast }),
    (e) => /no free browser slot/.test(e.message) && !/slot--1/.test(e.message) && !/reserved for CI/.test(e.message),
  );
  release();
});
