// The file-concurrency helper the workflows hand to `node --test` (helpers/test-concurrency.mjs).
//
// Every browser test file launches its own Chromium, and node's default of
// availableParallelism()-1 concurrent files made one suite 11 browsers on the 12-core
// CI box. Two PR-CI jobs, a deploy job and a local run doing that at once is what ran
// the VM out of memory on 2026-09-28. This holds the helper to: node's default on a
// quiet box with no browser cap, never more files than browser slots this process may
// hold (4 in CI, 2 for a local run, with the default cap), proportional throttling
// under load, a memory floor, and an explicit override.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  computeTestConcurrency, NODE_DEFAULT_CONCURRENCY, PER_FILE_BYTES, RESERVE_BYTES,
} from './helpers/test-concurrency.mjs';

const GiB = 1024 ** 3;
// slots 0: no browser cap, so the older cases keep pinning load and memory alone.
const plenty = { memAvailable: 20 * GiB, env: {}, slots: 0, reserve: 0 };

test("node's own default concurrency is one less than the core count", () => {
  assert.equal(NODE_DEFAULT_CONCURRENCY(12), 11);
  assert.equal(NODE_DEFAULT_CONCURRENCY(4), 3);
  assert.equal(NODE_DEFAULT_CONCURRENCY(1), 1, 'a single-core box still has to run something');
});

test('a quiet box with memory to spare keeps exactly node\'s default', () => {
  assert.equal(computeTestConcurrency({ cores: 12, load1: 1, ...plenty }), 11);
  assert.equal(computeTestConcurrency({ cores: 12, load1: 12, ...plenty }), 11, 'load at the core count is still quiet');
  assert.equal(computeTestConcurrency({ cores: 4, load1: 2, ...plenty }), 3, 'a small runner is not sped up either');
});

test('load above the core count throttles in proportion', () => {
  assert.equal(computeTestConcurrency({ cores: 12, load1: 24, ...plenty }), 6, 'double the cores in load halves the files');
  assert.equal(computeTestConcurrency({ cores: 12, load1: 42.7, ...plenty }), 3, 'the 2026-09-28 load must not still launch 11 browsers');
});

test('memory below the reserve plus per-file share throttles to what fits', () => {
  const twoFiles = RESERVE_BYTES + 2 * PER_FILE_BYTES;
  assert.equal(computeTestConcurrency({ cores: 12, load1: 1, memAvailable: twoFiles, env: {}, slots: 0, reserve: 0 }), 2);
  assert.equal(computeTestConcurrency({ cores: 12, load1: 1, memAvailable: RESERVE_BYTES, env: {}, slots: 0, reserve: 0 }), 1, 'nothing to spare still runs one file');
  assert.equal(computeTestConcurrency({ cores: 12, load1: 1, memAvailable: 0, env: {}, slots: 0, reserve: 0 }), 1, 'never below 1');
});

test('the tighter of load and memory wins', () => {
  assert.equal(computeTestConcurrency({ cores: 12, load1: 24, memAvailable: RESERVE_BYTES + 2 * PER_FILE_BYTES, env: {}, slots: 0, reserve: 0 }), 2);
  assert.equal(computeTestConcurrency({ cores: 12, load1: 48, memAvailable: 20 * GiB, env: {}, slots: 0, reserve: 0 }), 3);
});

test('QCM_TEST_CONCURRENCY overrides the calculation, and rejects nonsense', () => {
  assert.equal(computeTestConcurrency({ cores: 12, load1: 1000, memAvailable: 0, env: { QCM_TEST_CONCURRENCY: '7' } }), 7);
  assert.throws(() => computeTestConcurrency({ ...plenty, env: { QCM_TEST_CONCURRENCY: '0' } }), /positive integer/);
  assert.throws(() => computeTestConcurrency({ ...plenty, env: { QCM_TEST_CONCURRENCY: 'many' } }), /positive integer/);
  assert.equal(computeTestConcurrency({ memAvailable: 20 * GiB, env: { QCM_TEST_CONCURRENCY: '3', QCM_BROWSER_SLOT_RESERVE: 'x' } }), 3,
    'the override wins before the slot knobs are read, so a bad reserve cannot empty $(...) in the workflow');
});

test('files in flight never exceed the browser slots this run may hold', () => {
  const quiet = { cores: 12, load1: 1, memAvailable: 20 * GiB, env: {} };
  assert.equal(computeTestConcurrency({ ...quiet, slots: 4, reserve: 0 }), 4, 'CI: 4 slots, not 11 files queued on them');
  assert.equal(computeTestConcurrency({ ...quiet, slots: 4, reserve: 2 }), 2, 'local: 2 usable slots, 2 files');
  assert.equal(computeTestConcurrency({ ...quiet, slots: 4, reserve: 3 }), 1);
  assert.equal(computeTestConcurrency({ ...quiet, slots: 4, reserve: 4 }), 1, 'never below 1');
  assert.equal(computeTestConcurrency({ ...quiet, slots: 16, reserve: 0 }), 11, 'a roomy pool leaves node\'s default alone');
  assert.equal(computeTestConcurrency({ ...quiet, slots: 0, reserve: 0 }), 11, 'slots 0 is no cap');
  assert.equal(computeTestConcurrency({ cores: 12, load1: 48, memAvailable: 20 * GiB, env: {}, slots: 4, reserve: 0 }), 3, 'load still throttles below the cap');
  assert.equal(computeTestConcurrency({ ...quiet, env: { QCM_TEST_CONCURRENCY: '9' }, slots: 4, reserve: 2 }), 9, 'the override still wins');
});

test('run as a script it prints one positive integer, the shape $(...) in the workflow needs', () => {
  const script = fileURLToPath(new URL('./helpers/test-concurrency.mjs', import.meta.url));
  const out = execFileSync(process.execPath, [script], { encoding: 'utf8' });
  assert.match(out, /^[1-9]\d*\n$/);
});
