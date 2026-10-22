// Tests for the quality-evidence bundle check (QQA-12). Every SHA and reason here is synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyEvidence, manifestJourneyIds, matchesScope } from './evidence-bundle.mjs';

const CANDIDATE = 'c'.repeat(40);
const OLD = 'a'.repeat(40);
const SQUASH = 'b'.repeat(40);
const ids = manifestJourneyIds();
const good = () => ({
  auditedSha: CANDIDATE,
  journeys: ids.map((id) => ({ id, result: 'pass' })),
});
// treeOf maps a sha to a tree id; changedFiles lists paths changed between two shas. Both injected.
const TREES = { [CANDIDATE]: 'tree-new', [OLD]: 'tree-old', [SQUASH]: 'tree-new' };
const opts = (extra = {}) => ({
  candidateSha: CANDIDATE,
  treeOf: (sha) => {
    if (!(sha in TREES)) throw new Error(`unknown sha ${sha}`);
    return TREES[sha];
  },
  changedFiles: () => [],
  ...extra,
});
const withJourney = (id, patch) => {
  const b = good();
  b.journeys = b.journeys.map((j) => (j.id === id ? { id, ...patch } : j));
  return b;
};

test('manifest ids come from acceptance-manifest.json', () => {
  const m = JSON.parse(readFileSync(new URL('./acceptance-manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(ids, m.journeys.map((j) => j.id));
  assert.ok(ids.length >= 10);
});

test('a complete synthetic bundle at the candidate passes', () => {
  assert.deepEqual(verifyEvidence(good(), opts()), { ok: true, problems: [] });
});

test('an old-tree bundle with a diff into the journey scope is rejected as stale', () => {
  const r = verifyEvidence({ ...good(), auditedSha: OLD }, opts({ changedFiles: () => ['themes/headlessmode/static/js/quiet-corners-maps/main.js'] }));
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /stale/);
  assert.match(r.problems.join('\n'), /quiet-corners-maps\/main\.js/);
});

test('a different sha with an equal tree (a squash) passes without looking at the diff', () => {
  const r = verifyEvidence({ ...good(), auditedSha: SQUASH }, opts({ changedFiles: () => { throw new Error('diff must not be needed'); } }));
  assert.deepEqual(r, { ok: true, problems: [] });
});

test('an old tree whose diff misses every journey list passes', () => {
  const r = verifyEvidence({ ...good(), auditedSha: OLD }, opts({ changedFiles: () => ['README.md', 'content/about.md'] }));
  assert.deepEqual(r, { ok: true, problems: [] });
});

test('a diff inside one journey list fails only that journey', () => {
  const file = 'scripts/qcm/point-elevation-browser.test.mjs';
  const owners = JSON.parse(readFileSync(new URL('./acceptance-manifest.json', import.meta.url), 'utf8')).journeys
    .filter((j) => j.invalidatedBy.some((e) => matchesScope(file, e))).map((j) => j.id);
  // J10 (planned, no covering test yet) deliberately lists all of scripts/qcm/: fail closed.
  assert.deepEqual(owners, ['J05', 'J10']);
  const r = verifyEvidence({ ...good(), auditedSha: OLD }, opts({ changedFiles: () => [file] }));
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 2);
  assert.match(r.problems.find((p) => p.includes('J05')), new RegExp(`J05.*stale.*${file}`));
  assert.ok(r.problems.every((p) => /J05|J10/.test(p)), r.problems.join(' | '));
});

test('ancestry alone never makes evidence fresh (no isAncestor path)', () => {
  const r = verifyEvidence({ ...good(), auditedSha: OLD }, opts({ isAncestor: () => true, changedFiles: () => ['package.json'] }));
  assert.equal(r.ok, false);
});

test('glob and prefix entries in a journey list both match', () => {
  const manifest = { journeys: [
    { id: 'J01', invalidatedBy: ['src/dir/', 'css/qc*.css', 'one.txt'] },
    { id: 'J02', invalidatedBy: ['other/**/x.js'] },
  ] };
  const b = { auditedSha: OLD, journeys: [{ id: 'J01', result: 'pass' }, { id: 'J02', result: 'pass' }] };
  const run = (f) => verifyEvidence(b, opts({ manifest, changedFiles: () => [f] })).problems.length;
  assert.equal(run('src/dir/deep/a.js'), 1);
  assert.equal(run('css/qc-maps.css'), 1);
  assert.equal(run('css/sub/qc-maps.css'), 0);
  assert.equal(run('one.txt'), 1);
  assert.equal(run('src/dirx/a.js'), 0);
  assert.equal(run('other/a/b/x.js'), 1);
});

test('a journey with no invalidation list is stale when the trees differ (fail closed)', () => {
  const manifest = { journeys: [{ id: 'J01' }] };
  const b = { auditedSha: OLD, journeys: [{ id: 'J01', result: 'pass' }] };
  const r = verifyEvidence(b, opts({ manifest, changedFiles: () => ['README.md'] }));
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /J01.*no invalidation list/);
});

test('a git failure resolving a sha is stale, not a pass', () => {
  const r = verifyEvidence({ ...good(), auditedSha: 'd'.repeat(40) }, opts());
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /stale.*cannot resolve/);
  const r2 = verifyEvidence({ ...good(), auditedSha: OLD }, opts({ changedFiles: () => { throw new Error('boom'); } }));
  assert.equal(r2.ok, false);
  assert.match(r2.problems.join('\n'), /stale.*cannot list/);
});

test('a missing bundle fails', () => {
  for (const b of [undefined, null, 'x']) {
    const r = verifyEvidence(b, opts());
    assert.equal(r.ok, false);
    assert.match(r.problems.join('\n'), /no evidence bundle/);
  }
});

test('a missing journey fails and names the id', () => {
  const b = good();
  b.journeys = b.journeys.filter((j) => j.id !== ids[3]);
  const r = verifyEvidence(b, opts());
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), new RegExp(`${ids[3]}.*missing`));
});

test('a skipped journey fails', () => {
  const r = verifyEvidence(withJourney(ids[0], { result: 'skipped' }), opts());
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), new RegExp(`${ids[0]}.*skipped`));
});

test('a failed journey fails', () => {
  const r = verifyEvidence(withJourney(ids[1], { result: 'fail' }), opts());
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), new RegExp(`${ids[1]}.*fail`));
});

test('a bare not-applicable fails', () => {
  const r = verifyEvidence(withJourney(ids[2], { result: 'not-applicable' }), opts());
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /class/);
  assert.match(r.problems.join('\n'), /reason/);
});

test('not-applicable with class C and a cited reason passes', () => {
  const b = withJourney(ids[2], {
    result: 'not-applicable',
    class: 'C',
    reason: 'synthetic renderer limitation: headless renderer has no GPU path',
  });
  assert.equal(verifyEvidence(b, opts()).ok, true);
});

test('not-applicable with an unknown class fails', () => {
  const b = withJourney(ids[2], { result: 'not-applicable', class: 'Z', reason: 'because' });
  assert.match(verifyEvidence(b, opts()).problems.join('\n'), /class/);
});

test('an unknown result, an unknown journey id and a duplicate are reported', () => {
  const b = withJourney(ids[1], { result: 'maybe' });
  b.journeys.push({ id: 'J99', result: 'pass' }, { id: ids[0], result: 'pass' });
  const text = verifyEvidence(b, opts()).problems.join('\n');
  assert.match(text, /J99/);
  assert.match(text, /twice/);
  assert.match(text, /maybe/);
});

test('artifact references are optional but must be strings when present', () => {
  assert.equal(verifyEvidence(withJourney(ids[0], { result: 'pass', artifacts: ['shots/a.png'] }), opts()).ok, true);
  assert.equal(verifyEvidence(withJourney(ids[0], { result: 'pass', artifacts: [1] }), opts()).ok, false);
});
