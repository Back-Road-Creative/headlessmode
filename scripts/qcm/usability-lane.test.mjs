// The usability lane (QA-04): ten user tasks, one per acceptance journey J01 to J10, run by a
// bounded model-driven runner and judged by a verifier that never takes the model's word.
// Everything here is offline: a recorded adapter replays saved answers, a recorded driver
// reports the page facts a real driver would read. See usability/README.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runLane, loadLane } from './usability/lane.mjs';
import { runTask, ACTION_KINDS } from './usability/runner.mjs';
import { verifyTask, evaluateChecks } from './usability/verifier.mjs';
import { calibrate, calibrationStatus, REQUIRED_CLEAN_ROUNDS } from './usability/calibration.mjs';
import { recordedAdapter, createAdapter } from './usability/adapter.mjs';

const HERE = new URL('.', import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, HERE), 'utf8'));
const acceptance = read('acceptance-manifest.json');
const { tasks, recordings } = loadLane();
const IDS = ['J01', 'J02', 'J03', 'J04', 'J05', 'J06', 'J07', 'J08', 'J09', 'J10'];
const task = (id) => tasks.find((t) => t.id === id);

/** A fake clock that moves `stepMs` on every read. */
const clock = (stepMs = 1) => { let t = 0; return () => { t += stepMs; return t; }; };
/** A driver that records the actions it is given and reports fixed facts. */
const driver = (facts = {}) => {
  const acted = [];
  return { acted, observe: async () => ({ note: 'screen' }), act: async (a) => { acted.push(a); }, facts: async () => facts };
};
const script = (...actions) => recordedAdapter({ steps: actions });

test('there is exactly one task per journey J01 to J10, each a journey of the acceptance manifest', () => {
  assert.deepEqual(tasks.map((t) => t.id), IDS);
  const manifestIds = acceptance.journeys.map((j) => j.id);
  for (const t of tasks) assert.ok(manifestIds.includes(t.journey), `${t.id} names unknown journey ${t.journey}`);
  assert.deepEqual(tasks.map((t) => t.journey), IDS);
});

test('every task states a goal in plain words, a bounded budget and at least one check', () => {
  for (const t of tasks) {
    assert.ok(typeof t.task === 'string' && t.task.length > 20, `${t.id} task text`);
    assert.ok(Number.isInteger(t.budget.maxSteps) && t.budget.maxSteps > 0 && t.budget.maxSteps <= 60, `${t.id} maxSteps`);
    assert.ok(Number.isInteger(t.budget.maxMs) && t.budget.maxMs > 0 && t.budget.maxMs <= 300000, `${t.id} maxMs`);
    assert.ok(t.checks.length > 0, `${t.id} checks`);
    for (const c of t.checks) assert.ok(['eq', 'gte', 'lte'].includes(c.op) && 'value' in c && c.fact, `${t.id} check ${JSON.stringify(c)}`);
  }
});

test('task text carries no implementation hints (selectors, ids, handlers)', () => {
  for (const t of tasks) assert.doesNotMatch(t.task, /[#<>{}]|data-|querySelector|\bclass=|\.js\b|\bid=/, `${t.id}: ${t.task}`);
});

test('the lane runs all ten journeys, each with a known-good recording', async () => {
  const report = await runLane({ tasks, recordings, now: clock() });
  assert.deepEqual(report.journeys.map((j) => j.id), IDS);
  for (const id of IDS) {
    const good = report.runs.find((r) => r.taskId === id && r.build === 'known-good');
    assert.ok(good, `${id} has a known-good run`);
    assert.equal(good.verdict, 'pass', `${id}: ${JSON.stringify(good)}`);
  }
});

test('a task with no recording (J10 runner missing) fails the lane instead of passing quietly', async () => {
  const without = recordings.filter((r) => r.task !== 'J10');
  await assert.rejects(runLane({ tasks, recordings: without, now: clock() }), /J10.*known-good/);
});

test('the lane is advisory: it never repairs a build or accepts a baseline', async () => {
  const report = await runLane({ tasks, recordings, now: clock() });
  assert.equal(report.advisory, true);
  assert.equal(report.blockingEligible, false);
  const src = ['lane', 'runner', 'verifier', 'calibration', 'adapter'].map((n) => readFileSync(new URL(`usability/${n}.mjs`, HERE), 'utf8')).join('\n');
  assert.doesNotMatch(src, /node:child_process|node:http|node:https|node:net|\bfetch\(|XMLHttpRequest|WebSocket/, 'the lane makes no network call and starts no process');
  assert.doesNotMatch(src, /writeFileSync|appendFileSync|unlinkSync|rmSync/, 'the lane writes nothing but its report, and only from the CLI');
});

test('seeded failures are caught and no known-good build is called a failure', async () => {
  const report = await runLane({ tasks, recordings, now: clock() });
  assert.deepEqual(report.calibration.falsePositives, []);
  assert.deepEqual(report.calibration.falseNegatives, []);
  const seeded = report.runs.filter((r) => r.build !== 'known-good');
  assert.ok(seeded.length >= 5, 'at least the five seeded failures of the plan');
  for (const r of seeded) assert.equal(r.verdict, 'fail', `${r.taskId} ${r.build}`);
  assert.ok(['J01', 'J02', 'J03', 'J05', 'J07'].every((id) => seeded.some((r) => r.taskId === id)));
});

test('runner: stops at the step budget and says so', async () => {
  const t = { id: 'T', budget: { maxSteps: 3, maxMs: 1000 }, checks: [] };
  const d = driver();
  const run = await runTask(t, { adapter: recordedAdapter({ steps: [{ kind: 'key', key: 'Tab' }], loop: true }), driver: d, now: clock() });
  assert.equal(run.outcome, 'budget-steps');
  assert.equal(d.acted.length, 3);
});

test('runner: stops at the time budget', async () => {
  const t = { id: 'T', budget: { maxSteps: 50, maxMs: 100 }, checks: [] };
  const run = await runTask(t, { adapter: recordedAdapter({ steps: [{ kind: 'scroll', direction: 'down' }], loop: true }), driver: driver(), now: clock(40) });
  assert.equal(run.outcome, 'budget-time');
  assert.ok(run.steps.length < 50);
});

test('runner: an action outside the vocabulary is refused and ends the run', async () => {
  const t = { id: 'T', budget: { maxSteps: 5, maxMs: 1000 }, checks: [] };
  for (const bad of [{ kind: 'eval', code: 'x' }, { kind: 'click' }, { kind: 'wait', ms: 99999 }, { kind: 'type', text: 'x'.repeat(500) }, 'click']) {
    const d = driver();
    const run = await runTask(t, { adapter: script(bad), driver: d, now: clock() });
    assert.equal(run.outcome, 'invalid-action', JSON.stringify(bad));
    assert.equal(d.acted.length, 0, 'a refused action reaches nothing');
  }
  assert.deepEqual([...ACTION_KINDS].sort(), ['click', 'done', 'giveUp', 'key', 'scroll', 'type', 'wait']);
});

test('runner: done and giveUp end the run; an adapter that throws ends it as adapter-error', async () => {
  const t = { id: 'T', budget: { maxSteps: 5, maxMs: 1000 }, checks: [] };
  assert.equal((await runTask(t, { adapter: script({ kind: 'done' }), driver: driver(), now: clock() })).outcome, 'claimed-done');
  assert.equal((await runTask(t, { adapter: script({ kind: 'giveUp', reason: 'no camera control' }), driver: driver(), now: clock() })).outcome, 'gave-up');
  const boom = { next: async () => { throw new Error('provider down'); } };
  const run = await runTask(t, { adapter: boom, driver: driver(), now: clock() });
  assert.equal(run.outcome, 'adapter-error');
  assert.match(run.error, /provider down/);
});

test('runner: the observation is handed to the adapter, never the checks', async () => {
  const seen = [];
  const adapter = { next: async (ctx) => { seen.push(ctx); return { kind: 'done' }; } };
  await runTask({ id: 'T', task: 'Do the thing', budget: { maxSteps: 2, maxMs: 1000 }, checks: [{ fact: 'secret', op: 'eq', value: 1 }] }, { adapter, driver: driver(), now: clock() });
  assert.equal(seen[0].task, 'Do the thing');
  assert.ok(!JSON.stringify(seen[0]).includes('secret'), 'the adapter does not see the checks');
});

test('verifier: a done claim with failing facts is a claim-mismatch fail', () => {
  const t = { id: 'T', checks: [{ fact: 'overlays', op: 'eq', value: 0 }] };
  const v = verifyTask(t, { outcome: 'claimed-done' }, { overlays: 2 });
  assert.equal(v.verdict, 'fail');
  assert.ok(v.flags.includes('claim-mismatch'));
  assert.match(v.failures[0], /overlays/);
});

test('verifier: facts that hold without a done claim still fail, flagged unclaimed-pass', () => {
  const t = { id: 'T', checks: [{ fact: 'overlays', op: 'eq', value: 0 }] };
  const v = verifyTask(t, { outcome: 'budget-steps' }, { overlays: 0 });
  assert.equal(v.verdict, 'fail');
  assert.deepEqual(v.flags, ['unclaimed-pass']);
});

test('verifier: a missing fact fails closed; ops eq, gte and lte', () => {
  assert.equal(evaluateChecks([{ fact: 'a', op: 'eq', value: 1 }], {}).length, 1);
  assert.equal(evaluateChecks([{ fact: 'a', op: 'gte', value: 2 }, { fact: 'b', op: 'lte', value: 2 }], { a: 2, b: 2 }).length, 0);
  assert.equal(evaluateChecks([{ fact: 'a', op: 'gte', value: 3 }], { a: 2 }).length, 1);
  assert.equal(evaluateChecks([{ fact: 'a', op: 'lte', value: 1 }], { a: 2 }).length, 1);
  assert.equal(evaluateChecks([{ fact: 'a', op: 'eq', value: true }], { a: 'true' }).length, 1, 'no loose equality');
});

test('calibration: false positives and false negatives are named, per run', () => {
  const r = calibrate([
    { taskId: 'J01', build: 'known-good', verdict: 'pass' },
    { taskId: 'J02', build: 'known-good', verdict: 'fail' },
    { taskId: 'J03', build: 'seeded:missing-camera-group', verdict: 'fail' },
    { taskId: 'J05', build: 'seeded:clipped-card', verdict: 'pass' },
  ]);
  assert.deepEqual(r.falsePositives, [{ taskId: 'J02', build: 'known-good' }]);
  assert.deepEqual(r.falseNegatives, [{ taskId: 'J05', build: 'seeded:clipped-card' }]);
  assert.equal(r.clean, false);
  assert.equal(calibrate([{ taskId: 'J01', build: 'known-good', verdict: 'pass' }]).clean, true);
});

test('calibration status: blocking needs ten consecutive clean scheduled rounds; one miss restarts the count', () => {
  assert.equal(REQUIRED_CLEAN_ROUNDS, 10);
  const clean = { clean: true };
  const dirty = { clean: false };
  const nine = Array(9).fill(clean);
  assert.deepEqual(calibrationStatus(nine), { consecutiveClean: 9, blockingEligible: false });
  assert.deepEqual(calibrationStatus([...nine, clean]), { consecutiveClean: 10, blockingEligible: true });
  assert.deepEqual(calibrationStatus([...nine, clean, dirty]), { consecutiveClean: 0, blockingEligible: false });
  assert.deepEqual(calibrationStatus([clean, clean, dirty, clean]), { consecutiveClean: 1, blockingEligible: false });
  assert.deepEqual(calibrationStatus([]), { consecutiveClean: 0, blockingEligible: false });
});

test('adapter: a recording that runs out is an error; a live provider is refused until authorised', async () => {
  const a = recordedAdapter({ steps: [{ kind: 'done' }] });
  assert.deepEqual(await a.next({}), { kind: 'done' });
  await assert.rejects(a.next({}), /recording ran out/);
  assert.throws(() => createAdapter({ kind: 'live' }), /no model provider is authorised/);
  assert.throws(() => createAdapter({ kind: 'nope' }), /unknown adapter/);
});

test('every recording names a task that exists and ends the way its build says', () => {
  const ids = new Set(tasks.map((t) => t.id));
  for (const r of recordings) {
    assert.ok(ids.has(r.task), `recording for unknown task ${r.task}`);
    assert.match(r.build, /^(known-good|seeded:[a-z-]+)$/);
    assert.ok(r.steps.length > 0 && r.facts && typeof r.facts === 'object');
  }
});

test('the CLI runs the whole lane offline, prints one line per journey, and is advisory by default', () => {
  const cli = new URL('usability/lane.mjs', HERE).pathname;
  assert.ok(existsSync(cli));
  const r = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const id of IDS) assert.match(r.stdout, new RegExp(`${id} .*pass`));
  assert.match(r.stdout, /advisory/);
  const j = spawnSync(process.execPath, [cli, '--json'], { encoding: 'utf8' });
  assert.equal(JSON.parse(j.stdout).journeys.length, 10);
});

test('the lane documents itself: README in the lane folder, pointer in the suite README', () => {
  const readme = readFileSync(new URL('usability/README.md', HERE), 'utf8');
  for (const word of ['advisory', 'recorded', 'J10', 'ten consecutive', 'provider']) assert.match(readme, new RegExp(word), word);
  assert.match(readFileSync(new URL('README.md', HERE), 'utf8'), /usability\/README\.md/);
});
