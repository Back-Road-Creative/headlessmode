// Deploy gate contract (QC-E1). Run: node --test scripts/test-deploy-gate.mjs
// The deploy publishes a tree; it may publish only a tree PR CI passed on.
// No YAML library is a devDependency, so the workflow is checked by text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decide, gather, counts } from './ci/deploy-gate.mjs';

const T = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const run = (conclusion, created_at = '2026-10-15T10:00:00Z', id = 1) =>
  ({ id, status: 'completed', conclusion, created_at, html_url: `https://x/runs/${id}` });
const pr = (headTree, runs) => ({ number: 9, headSha: 'c'.repeat(40), headTree, runs });

test('squash-merged PR whose tested head has the deployed tree deploys', () => {
  const v = decide({ deployTree: T, prs: [pr(T, [run('success')])] });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.code, 'pr-ci-green');
});

test('commit with no merged PR refuses', () => {
  const v = decide({ deployTree: T, prs: [] });
  assert.deepEqual([v.ok, v.code], [false, 'no-pr']);
});

test('PR with no PR CI run refuses', () => {
  assert.equal(decide({ deployTree: T, prs: [pr(T, [])] }).code, 'no-pr-ci');
});

test('red PR CI refuses', () => {
  assert.equal(decide({ deployTree: T, prs: [pr(T, [run('failure')])] }).code, 'red-pr-ci');
});

test('stale head refuses in refuse mode even when green', () => {
  const v = decide({ deployTree: T, prs: [pr(OTHER, [run('success')])], staleTree: 'refuse' });
  assert.deepEqual([v.ok, v.code], [false, 'stale-tree']);
});

test('stale head with green PR CI deploys with a warning in warn mode (the default)', () => {
  const v = decide({ deployTree: T, prs: [pr(OTHER, [run('success')])] });
  assert.deepEqual([v.ok, v.code], [true, 'stale-tree-warn']);
  assert.match(v.reason, /different tree/);
});

test('stale head with red or absent PR CI still refuses in warn mode', () => {
  assert.equal(decide({ deployTree: T, prs: [pr(OTHER, [run('failure')])] }).code, 'red-pr-ci');
  assert.equal(decide({ deployTree: T, prs: [pr(OTHER, [])] }).code, 'no-pr-ci');
});

test('the newest decisive run decides; cancelled and unfinished runs are not decisive', () => {
  const runs = [
    run('success', '2026-10-15T10:00:00Z', 1),
    run('failure', '2026-10-15T11:00:00Z', 2),
    run('cancelled', '2026-10-15T12:00:00Z', 3),
    { ...run(null, '2026-10-15T13:00:00Z', 4), status: 'in_progress' },
  ];
  assert.equal(decide({ deployTree: T, prs: [pr(T, runs)] }).code, 'red-pr-ci');
  const green = [run('failure', '2026-10-15T10:00:00Z', 1), run('success', '2026-10-15T11:00:00Z', 2),
    run('cancelled', '2026-10-15T12:00:00Z', 3)];
  assert.equal(decide({ deployTree: T, prs: [pr(T, green)] }).ok, true);
});

test('override deploys only with a reason, and says so', () => {
  const v = decide({ deployTree: T, prs: [], override: 'hotfix: PR CI runner outage' });
  assert.deepEqual([v.ok, v.code], [true, 'override']);
  assert.match(v.reason, /hotfix/);
  assert.equal(decide({ deployTree: T, prs: [], override: '   ' }).code, 'no-pr');
});

test('gather resolves merged PRs, head trees and pr-ci runs through the API', async () => {
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path === `/repos/o/r/commits/${'d'.repeat(40)}`) return { commit: { tree: { sha: T } } };
    if (path.endsWith('/pulls')) return [
      { number: 9, merged_at: '2026-10-15T09:00:00Z', base: { ref: 'master' }, head: { sha: 'c'.repeat(40) } },
      { number: 8, merged_at: null, base: { ref: 'master' }, head: { sha: 'e'.repeat(40) } },
    ];
    if (path === `/repos/o/r/git/commits/${'c'.repeat(40)}`) return { tree: { sha: T } };
    if (path.includes('/actions/workflows/pr-ci.yml/runs')) return { workflow_runs: [run('success')] };
    throw new Error(`unexpected ${path}`);
  };
  const input = await gather({ repo: 'o/r', sha: 'd'.repeat(40), api });
  assert.equal(input.deployTree, T);
  assert.equal(input.prs.length, 1, 'unmerged PR dropped');
  assert.equal(decide(input).ok, true);
  assert.ok(calls.some((c) => c.includes(`head_sha=${'c'.repeat(40)}`)));
});

test('gather falls back to the subject (#N) when GitHub has no commit-to-PR association', async () => {
  // Measured: master b6c135f6 is #743's merge commit, but /commits/{sha}/pulls returned [].
  const D = 'd'.repeat(40);
  const pulls = {
    743: { number: 743, merged_at: '2026-10-11T00:00:00Z', merge_commit_sha: D, base: { ref: 'master' }, head: { sha: 'c'.repeat(40) } },
    744: { number: 744, merged_at: '2026-10-11T00:00:00Z', merge_commit_sha: 'f'.repeat(40), base: { ref: 'master' }, head: { sha: 'e'.repeat(40) } },
  };
  const api = (subject) => async (path) => {
    if (path === `/repos/o/r/commits/${D}`) return { commit: { message: subject, tree: { sha: T } } };
    if (path.endsWith('/pulls')) return [];
    const m = path.match(/\/pulls\/(\d+)$/);
    if (m) return pulls[m[1]];
    if (path.includes('/git/commits/')) return { tree: { sha: T } };
    if (path.includes('/runs')) return { workflow_runs: [run('success')] };
    throw new Error(`unexpected ${path}`);
  };
  const ok = await gather({ repo: 'o/r', sha: D, api: api('docs: reconcile the count (#743)\n\nbody') });
  assert.deepEqual(ok.prs.map((p) => p.number), [743]);
  // A subject naming a PR whose merge commit is another SHA proves nothing.
  const no = await gather({ repo: 'o/r', sha: D, api: api('docs: something (#744)') });
  assert.deepEqual(no.prs, []);
});

test('counts: a skipped or todo test fails the suite; a missing summary fails too', () => {
  const ok = '# tests 3\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  assert.equal(counts(ok).ok, true);
  assert.equal(counts(ok.replace('# skipped 0', '# skipped 2')).ok, false);
  assert.equal(counts(ok.replace('# todo 0', '# todo 1')).ok, false);
  assert.equal(counts(ok.replace('# tests 3', '# tests 0')).ok, false);
  assert.equal(counts('no summary here').ok, false);
});

const wf = readFileSync(new URL('../.github/workflows/deploy-production.yml', import.meta.url), 'utf8');

test('deploy workflow runs the gate before the build and can read PRs and runs', () => {
  const gate = wf.indexOf('node scripts/ci/deploy-gate.mjs check');
  assert.ok(gate > 0, 'gate step missing');
  assert.ok(gate < wf.indexOf('bash scripts/build-site.sh'), 'gate must run before the build');
  assert.match(wf, /^ {2}pull-requests: read/m);
  assert.match(wf, /^ {2}actions: read/m);
  assert.match(wf, /override_reason:/);
});

test('deploy test line runs this contract and the PR CI scope contract, then gates skips', () => {
  // Since #830 the suite runs through run-with-evidence.mjs, which passes its flags to node --test.
  const line = wf.split('\n').find((l) => /node --test|node scripts\/qcm\/run-with-evidence\.mjs/.test(l) && l.includes('scripts/qcm/*.test.mjs'));
  assert.ok(line, 'test line missing');
  for (const f of ['scripts/test-pr-ci-scope.mjs', 'scripts/test-deploy-gate.mjs', 'scripts/test-site-surface.mjs', 'scripts/test-qcm-boundary.mjs']) assert.ok(line.includes(f), f);
  assert.match(wf, /node scripts\/ci\/deploy-gate\.mjs counts /);
});
