#!/usr/bin/env node
// Deploy gate (QC-E1): the deploy may publish only a tree that PR CI passed on.
//
// This repo allows squash, merge and rebase merges, so the master SHA a deploy
// builds is never the PR head SHA pr-ci.yml tested, and a lookup by $GITHUB_SHA
// would refuse every legitimate deploy. The gate binds by TREE instead: it finds
// the merged PR(s) for the pushed commit, takes each PR head's newest decisive
// pr-ci.yml run, and requires that head's tree to equal the deployed tree. A
// squash or merge of an up-to-date head has the same tree; a head that was behind
// master does not, and is refused as stale.
//
// Decisive = completed with success or failure. A cancelled run is what a newer
// push or a PR edit does to its predecessor (pr-ci.yml's concurrency group), and
// an unfinished run has not decided anything, so neither counts. Nor does a
// failure that executed no job: a pull_request run parked at action_required
// (the PR was opened with the workflow token) holds zero jobs, and GitHub
// concludes it `failure` when the PR closes, after the real run went green.
// Measured 2026-10-26: runs 40332015922 and 40332016835 refused the deploys of
// #51 and #50 red-pr-ci that way. gather() counts each failed run's jobs.
//
// Refusal codes: no-pr, no-pr-ci, red-pr-ci, stale-tree. A manual dispatch may
// pass `override_reason`; the run then deploys and logs the reason as a warning.
//
// STALE_TREE is 'warn', not 'refuse', and that is measured, not a preference: run
// against the 12 master commits ending f71bc6e4 (2026-10-15), 10 were squash merges
// of heads behind master, each with green PR CI, so 'refuse' would have stopped
// 10 of 12 legitimate deploys. A stale head still needs green PR CI on that head;
// only the tree mismatch is downgraded to a warning (the in-job suite below still
// tests the exact deployed tree). Switch to 'refuse' once the merge path lands
// heads that are up to date with master.
//
// Transient GitHub answers are retried, not decided on: a 5xx, a 429 or a network
// error is re-asked after each of RETRY_DELAYS_MS, and a pr-ci.yml runs list with no
// decisive run is re-read on the same delays before it can refuse no-pr-ci. A 4xx is
// an answer and is never retried. Measured 2026-10-22, during a GitHub Actions incident:
// run 39800781901 died on one HTTP 500 from /commits/{sha}/pulls, and run 39801814567
// refused no-pr-ci for a green head whose runs list read empty, then not (0/1/0/1).
//
// CLI:
//   node scripts/ci/deploy-gate.mjs check      (GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_TOKEN, OVERRIDE_REASON)
//   node scripts/ci/deploy-gate.mjs counts <node --test log>   (fails on skipped/todo/zero tests)
import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DECISIVE = new Set(['success', 'failure']);
export const STALE_TREE = 'warn';
export const RETRY_DELAYS_MS = [2000, 5000, 10000];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function newestDecisive(runs) {
  return runs
    .filter((r) => r.status === 'completed' && DECISIVE.has(r.conclusion) && r.jobs !== 0)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
}

export function decide({ deployTree, prs, override, staleTree = STALE_TREE }) {
  if (override && override.trim()) {
    return { ok: true, code: 'override', reason: `override by manual dispatch: ${override.trim()}` };
  }
  if (!prs.length) {
    return { ok: false, code: 'no-pr', reason: 'no merged PR into master contains this commit, so no PR CI run covers it' };
  }
  const refusals = [];
  for (const p of prs) {
    const stale = p.headTree !== deployTree;
    const staleWhy = `PR #${p.number} head ${p.headSha} has tree ${p.headTree}, deploy tree is ${deployTree}: PR CI tested a different tree (head behind master)`;
    if (stale && staleTree === 'refuse') {
      refusals.push({ code: 'stale-tree', reason: staleWhy });
      continue;
    }
    const r = newestDecisive(p.runs);
    if (!r) {
      refusals.push({ code: 'no-pr-ci', reason: `PR #${p.number} head ${p.headSha} has no completed success/failure pr-ci.yml run` });
    } else if (r.conclusion !== 'success') {
      refusals.push({ code: 'red-pr-ci', reason: `PR #${p.number} head ${p.headSha}: newest decisive pr-ci.yml run is ${r.conclusion} (${r.html_url})` });
    } else if (stale) {
      return { ok: true, code: 'stale-tree-warn', reason: `${staleWhy}; that head's pr-ci.yml is green: ${r.html_url}` };
    } else {
      return { ok: true, code: 'pr-ci-green', reason: `PR #${p.number} head ${p.headSha} has the deployed tree ${deployTree}; pr-ci.yml green: ${r.html_url}` };
    }
  }
  return { ok: false, ...refusals[0], refusals };
}

export function makeApi({ token, fetchImpl = fetch, sleep = wait, delays = RETRY_DELAYS_MS }) {
  return async (path) => {
    for (let attempt = 0; ; attempt++) {
      let res, why;
      try {
        res = await fetchImpl(`https://api.github.com${path}`, {
          headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
        });
        if (res.ok) return res.json();
        if (res.status < 500 && res.status !== 429) throw new Error(`GitHub API ${path}: HTTP ${res.status}`);
        why = `HTTP ${res.status}`;
      } catch (e) {
        if (res) throw e;
        why = e.message;
      }
      if (attempt >= delays.length) throw new Error(`GitHub API ${path}: ${why} after ${attempt + 1} attempts`);
      await sleep(delays[attempt]);
    }
  };
}

async function prCiRuns({ repo, headSha, api, sleep, delays }) {
  for (let attempt = 0; ; attempt++) {
    const runs = (await api(`/repos/${repo}/actions/workflows/pr-ci.yml/runs?head_sha=${headSha}&per_page=100`)).workflow_runs;
    if (newestDecisive(runs) || attempt >= delays.length) return runs;
    await sleep(delays[attempt]);
  }
}

export async function gather({ repo, sha, api, sleep = wait, delays = RETRY_DELAYS_MS }) {
  const commit = await api(`/repos/${repo}/commits/${sha}`);
  let merged = (await api(`/repos/${repo}/commits/${sha}/pulls`)).filter((x) => x.merged_at && x.base.ref === 'master');
  if (!merged.length) {
    // GitHub's commit-to-PR association is sometimes empty for a squash merge
    // (measured: master b6c135f6, #743). The subject's "(#N)" names a candidate,
    // accepted only if that PR's merge commit IS this SHA.
    const n = commit.commit.message.split('\n')[0].match(/\(#(\d+)\)\s*$/);
    if (n) {
      const p = await api(`/repos/${repo}/pulls/${n[1]}`);
      if (p.merged_at && p.base.ref === 'master' && p.merge_commit_sha === sha) merged = [p];
    }
  }
  const prs = [];
  for (const p of merged) {
    const head = await api(`/repos/${repo}/git/commits/${p.head.sha}`);
    const runs = await prCiRuns({ repo, headSha: p.head.sha, api, sleep, delays });
    for (const r of runs) {
      if (r.status === 'completed' && r.conclusion === 'failure') {
        r.jobs = (await api(`/repos/${repo}/actions/runs/${r.id}/jobs?per_page=1`)).total_count;
      }
    }
    prs.push({ number: p.number, headSha: p.head.sha, headTree: head.tree.sha, runs });
  }
  return { deployTree: commit.commit.tree.sha, prs };
}

// node --test's summary block. Every test must run: a skip in the deploy suite
// is a check that did not happen (a browser that was missing, a guard that tripped).
export function counts(log) {
  const n = (k) => { const m = log.match(new RegExp(`^# ${k} (\\d+)$`, 'm')); return m ? Number(m[1]) : null; };
  const c = { tests: n('tests'), pass: n('pass'), fail: n('fail'), skipped: n('skipped'), todo: n('todo') };
  if (Object.values(c).some((v) => v === null)) return { ok: false, reason: 'no node --test summary in the log', ...c };
  if (c.tests === 0) return { ok: false, reason: 'zero tests ran', ...c };
  if (c.skipped || c.todo) return { ok: false, reason: `${c.skipped} skipped, ${c.todo} todo: every deploy test must execute`, ...c };
  return { ok: true, reason: `${c.tests} executed, 0 skipped`, ...c };
}

async function check() {
  const { GITHUB_REPOSITORY: repo, GITHUB_SHA: sha, GITHUB_TOKEN: token } = process.env;
  const api = makeApi({ token });
  const v = decide({ ...(await gather({ repo, sha, api })), override: process.env.OVERRIDE_REASON });
  const line = `deploy-gate ${v.ok ? 'PASS' : 'REFUSE'} [${v.code}] ${v.reason}`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  if (v.code === 'override' || v.code === 'stale-tree-warn') console.log(`::warning::${line}`);
  else console.log(v.ok ? line : `::error::${line}`);
  return v.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, file] = process.argv.slice(2);
  if (cmd === 'check') process.exitCode = await check();
  else if (cmd === 'counts') {
    const v = counts(readFileSync(file, 'utf8'));
    console.log(v.ok ? `test counts: ${v.reason}` : `::error::test counts: ${v.reason}`);
    process.exitCode = v.ok ? 0 : 1;
  } else { console.error('usage: deploy-gate.mjs check | counts <log>'); process.exitCode = 2; }
}
