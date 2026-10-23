// QQA-13c2: the settled heap is flat once the 3D view has warmed up, measured in a real browser.
//
// JSHeapUsedSize (after a forced HeapProfiler.collectGarbage, repeated until two reads agree)
// climbs about 1.1 MB over the first ten 3D open/close cycles (code, shapes and caches the view
// builds lazily) and is flat after that. So the bound starts after a 21-cycle warm-up: TAIL_CYCLES
// more cycles may add at most HEAP_TAIL_LIMIT bytes. scripts/qcm/README.md, "Leak cycles", has
// the measured numbers and the method.
//
// This is its own file, not a second test in leak-cycles-browser.test.mjs, because CI caps each
// FILE at --test-timeout=600000 (pr-ci.yml): 41 cycles in one file ran 186 to 301 s on the dev
// container, half the cap before any contention. The listener, node and map counts stay in
// leak-cycles-browser.test.mjs; each file now holds about 21 cycles of the work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skip, freshPage, cycle, settledHeap } from './helpers/leak-page.mjs';

const WARM_CYCLES = 21;
// Cycles run after the warm-up reading, and the most the settled heap may grow across them.
// Measured on the dev container, cycle 21 -> cycle 41: +68,788 / +74,488 / +70,496 bytes in three
// probe runs and +73,800 / +74,772 / +84,988 in three runs of this test (cycle 41 -> 61 added
// 28,544 to 34,048 more, and in the run taken to 101 the heap ended 41,728 below cycle 21).
// 256 KiB is about 3x the largest of those, and a leak of 13 KiB a cycle trips it; the 58 KB a
// cycle #785 read off the warm-up would add 1.16 MB.
const TAIL_CYCLES = 20;
const HEAP_TAIL_LIMIT = 256 * 1024;

test(`${TAIL_CYCLES} 3D open/close cycles after a ${WARM_CYCLES}-cycle warm-up add under ${HEAP_TAIL_LIMIT} bytes to the settled heap`, { skip }, async (t) => {
  const session = await freshPage(t);
  await session.send('Performance.enable');
  for (let i = 0; i < WARM_CYCLES; i++) await cycle(session, i);
  const warm = await settledHeap(session);
  assert.ok(Number.isFinite(warm), `no JSHeapUsedSize came back (got ${warm})`);
  for (let i = WARM_CYCLES; i < WARM_CYCLES + TAIL_CYCLES; i++) await cycle(session, i);
  const tail = await settledHeap(session);
  t.diagnostic(`heap after ${WARM_CYCLES} cycles: ${warm}; after ${WARM_CYCLES + TAIL_CYCLES}: ${tail}; growth ${tail - warm} (limit ${HEAP_TAIL_LIMIT})`);
  assert.ok(tail - warm < HEAP_TAIL_LIMIT,
    `the settled heap grew ${tail - warm} bytes across ${TAIL_CYCLES} cycles after warm-up (limit ${HEAP_TAIL_LIMIT}): ${warm} -> ${tail}`);
});
