// The independent verifier. It reads facts from the page (what a driver reports after the run)
// and compares them with the task's checks. The model's "done" is only one input: a claim
// without the facts is a failure, and facts without a claim are a failure that is flagged, so a
// reviewer can see the page was fine and the model simply did not say so.

/** Check failures as readable strings; a fact that is absent fails the check. Strict equality. */
export function evaluateChecks(checks, facts) {
  const failures = [];
  for (const c of checks) {
    if (!Object.prototype.hasOwnProperty.call(facts, c.fact)) { failures.push(`${c.fact}: not reported`); continue; }
    const got = facts[c.fact];
    const ok = c.op === 'eq' ? got === c.value
      : c.op === 'gte' ? typeof got === 'number' && got >= c.value
      : c.op === 'lte' ? typeof got === 'number' && got <= c.value
      : false;
    if (!ok) failures.push(`${c.fact}: wanted ${c.op} ${JSON.stringify(c.value)}, got ${JSON.stringify(got)}`);
  }
  return failures;
}

/** @returns {{verdict: 'pass'|'fail', flags: string[], failures: string[]}} */
export function verifyTask(task, run, facts) {
  const failures = evaluateChecks(task.checks, facts);
  const claimed = run.outcome === 'claimed-done';
  if (claimed && failures.length === 0) return { verdict: 'pass', flags: [], failures };
  const flags = [];
  if (claimed) flags.push('claim-mismatch');
  else if (failures.length === 0) flags.push('unclaimed-pass');
  if (!claimed) failures.unshift(`run ended: ${run.outcome}`);
  return { verdict: 'fail', flags, failures };
}
