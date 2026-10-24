// Calibration: is the lane's verdict worth trusting? Each run is labelled by the build it saw,
// `known-good` or `seeded:<failure>`. A known-good build called a failure is a false positive;
// a seeded failure called a pass is a false negative. A task may become merge-blocking only
// after ten consecutive scheduled rounds with neither; one miss restarts the count.

export const REQUIRED_CLEAN_ROUNDS = 10;

/** @param {{taskId: string, build: string, verdict: string}[]} runs */
export function calibrate(runs) {
  const falsePositives = runs.filter((r) => r.build === 'known-good' && r.verdict !== 'pass').map(({ taskId, build }) => ({ taskId, build }));
  const falseNegatives = runs.filter((r) => r.build !== 'known-good' && r.verdict === 'pass').map(({ taskId, build }) => ({ taskId, build }));
  return { falsePositives, falseNegatives, clean: falsePositives.length === 0 && falseNegatives.length === 0 };
}

/** @param {{clean: boolean}[]} rounds oldest first */
export function calibrationStatus(rounds) {
  let consecutiveClean = 0;
  for (let i = rounds.length - 1; i >= 0 && rounds[i].clean; i--) consecutiveClean++;
  return { consecutiveClean, blockingEligible: consecutiveClean >= REQUIRED_CLEAN_ROUNDS };
}
