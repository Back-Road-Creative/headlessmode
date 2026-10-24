// The usability lane: run every journey's task against its recordings, verify each run
// independently, and report. Advisory: a failing run is reported, never repaired, and nothing
// here can block a merge until calibrationStatus() says ten clean scheduled rounds.
//
//   node scripts/qcm/usability/lane.mjs            one line per journey, then the calibration
//   node scripts/qcm/usability/lane.mjs --json     the whole report as JSON
//   node scripts/qcm/usability/lane.mjs --strict   exit 1 when a known-good build fails or a
//                                                  seeded failure is not caught
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { recordedAdapter } from './adapter.mjs';
import { runTask } from './runner.mjs';
import { verifyTask } from './verifier.mjs';
import { calibrate, calibrationStatus } from './calibration.mjs';

const HERE = new URL('.', import.meta.url);
const readJson = (name) => JSON.parse(readFileSync(new URL(name, HERE), 'utf8'));

export function loadLane() {
  return { tasks: readJson('tasks.json').tasks, recordings: readJson('recordings.json').recordings };
}

/** A driver that replays what a page would report: it records the actions it is given and
 *  answers `facts()` with the facts saved beside the recording. */
function recordedDriver(recording) {
  const acted = [];
  return { acted, observe: async () => ({ note: 'recorded screen', step: acted.length }), act: async (a) => { acted.push(a); }, facts: async () => recording.facts };
}

export async function runLane({ tasks, recordings, now }) {
  for (const t of tasks) {
    if (!recordings.some((r) => r.task === t.id && r.build === 'known-good')) throw new Error(`${t.id} has no known-good recording, so its runner cannot be judged`);
  }
  const runs = [];
  for (const t of tasks) {
    for (const rec of recordings.filter((r) => r.task === t.id)) {
      const driver = recordedDriver(rec);
      const run = await runTask(t, { adapter: recordedAdapter(rec), driver, now });
      const v = verifyTask(t, run, await driver.facts());
      runs.push({ taskId: t.id, build: rec.build, outcome: run.outcome, steps: run.steps.length, verdict: v.verdict, flags: v.flags, failures: v.failures });
    }
  }
  const calibration = calibrate(runs);
  const journeys = tasks.map((t) => ({
    id: t.id,
    phase: t.phase || 'later',
    verdict: runs.find((r) => r.taskId === t.id && r.build === 'known-good').verdict,
    seeded: runs.filter((r) => r.taskId === t.id && r.build !== 'known-good').map((r) => ({ build: r.build, verdict: r.verdict })),
  }));
  return { advisory: true, blockingEligible: calibrationStatus([calibration]).blockingEligible, journeys, runs, calibration };
}

export function formatReport(report, tasks) {
  const lines = ['Usability lane (advisory, recorded answers, no model called)'];
  for (const j of report.journeys) {
    const seeded = j.seeded.length ? `  seeded ${j.seeded.map((s) => `${s.build.replace('seeded:', '')}=${s.verdict}`).join(', ')}` : '';
    lines.push(`${j.id} ${j.verdict}  known-good${seeded}  - ${tasks.find((t) => t.id === j.id).task}`);
  }
  const c = report.calibration;
  lines.push(`calibration: ${c.falsePositives.length} false positive(s), ${c.falseNegatives.length} false negative(s); blocking eligible: ${report.blockingEligible ? 'yes' : 'no (needs ten consecutive clean scheduled rounds)'}`);
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const { tasks, recordings } = loadLane();
  const report = await runLane({ tasks, recordings });
  console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatReport(report, tasks));
  const bad = !report.calibration.clean || report.journeys.some((j) => j.verdict !== 'pass');
  if (args.includes('--strict') && bad) process.exitCode = 1;
}
