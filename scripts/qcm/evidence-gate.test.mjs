// Test evidence a gate can trust (QQA-12a, slice 1). run-with-evidence.mjs runs node --test
// and writes a JSON record of what ran; check-evidence.mjs refuses a record that is missing,
// unparsable, from another commit, silent about a test file on disk, failing, skipping
// without an allowlist entry, or empty. Today a CI step's exit code is the only evidence,
// and a skipped browser file, a file the glob never matched, or a result from an older
// commit all look like a pass.
//
// Offline: the fixtures are tiny test files written to a temp dir (their own git repo, so
// the recorded commit is real) and run by a child node. No browser, no network. The file
// is named evidence-gate.test.mjs because evidence.test.mjs already holds the factor-evidence
// tests for the popup (HM-4), which this unit must not touch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEvidence, validateAllowlist } from './check-evidence.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.join(HERE, 'run-with-evidence.mjs');
const CHECK = path.join(HERE, 'check-evidence.mjs');
const OTHER_SHA = 'f'.repeat(40);

const PASS_A = `import { test } from 'node:test';
import assert from 'node:assert/strict';
test('adds', () => assert.equal(1 + 1, 2));
test('subtracts', () => assert.equal(3 - 1, 2));
`;
const PASS_B = `import { test } from 'node:test';
test('only one', () => {});
`;
const FAILING = `import { test } from 'node:test';
import assert from 'node:assert/strict';
test('holds', () => {});
test('breaks', () => assert.equal(1, 2));
`;
const SKIPPING = `import { test, describe } from 'node:test';
test('runs', () => {});
test('needs a browser', { skip: 'no Chromium on this box' }, () => {});
describe('a group', () => { test('nested skip', { skip: true }, () => {}); });
test('later', { todo: 'not yet' }, () => {});
test('dynamic', (t) => { t.skip('decided at run time'); });
`;
const SKIPPED_SUITES = `import { test, describe } from 'node:test';
test('visible', () => {});
describe.skip('hidden group', () => { test('h1', () => {}); test('h2', () => {}); });
describe('reasoned group', { skip: 'why' }, () => { test('r1', () => {}); });
`;
const EMPTY = '// a test file that registers no test\n';
const BROKEN = 'this is ( not javascript\n';

/** A throwaway git repo with good/ (two passing files) and bad/ (failing, skipping, empty,
 *  unloadable files), plus a public/ directory for the build-marker cases. */
function makeProject() {
  const dir = mkdtempSync(path.join(tmpdir(), 'qcm-evidence-'));
  const put = (rel, text) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  };
  put('good/pass-a.test.mjs', PASS_A);
  put('good/pass-b.test.mjs', PASS_B);
  put('bad/fail.test.mjs', FAILING);
  put('bad/skip.test.mjs', SKIPPING);
  put('suite/groups.test.mjs', SKIPPED_SUITES);
  put('bad/empty.test.mjs', EMPTY);
  put('bad/broken.test.mjs', BROKEN);
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir, encoding: 'utf8' });
  assert.equal(git('init', '-q').status, 0);
  assert.equal(git('add', '-A').status, 0);
  assert.equal(git('commit', '-q', '-m', 'fixtures').status, 0);
  const sha = git('rev-parse', 'HEAD').stdout.trim();
  return { dir, sha, put };
}

// ONLY the env a case names: a parent run under node --test carries NODE_TEST_CONTEXT, which
// turns a nested node --test into a child of the outer run.
const baseEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME });
const node = (script, args, cwd) => spawnSync(process.execPath, [script, ...args], { cwd, env: baseEnv(), encoding: 'utf8', timeout: 120_000 });

const project = makeProject();
process.on('exit', () => rmSync(project.dir, { recursive: true, force: true }));
const evidencePath = (name) => path.join(project.dir, `${name}.json`);
const readEvidence = (name) => JSON.parse(readFileSync(evidencePath(name), 'utf8'));
const produce = (name, files, extra = []) => node(RUN, ['--out', evidencePath(name), ...extra, ...files], project.dir);

const good = produce('good', ['good/pass-a.test.mjs', 'good/pass-b.test.mjs']);
const suites = produce('suites', ['suite/groups.test.mjs']);
const bad = produce('bad', ['bad/fail.test.mjs', 'bad/skip.test.mjs', 'bad/empty.test.mjs', 'bad/broken.test.mjs']);

// ---- the producer -------------------------------------------------------------------

test('run-with-evidence exits 0 on a clean run, streams node --test output, and records the commit', () => {
  assert.equal(good.status, 0, good.stderr + good.stdout);
  assert.match(good.stdout, /adds/, 'node --test output was not streamed to stdout');
  const ev = readEvidence('good');
  assert.equal(ev.commit, project.sha);
  assert.equal(ev.node, process.version);
  assert.equal(ev.exitCode, 0);
  assert.ok(Date.parse(ev.startedAt) <= Date.parse(ev.endedAt), `${ev.startedAt} .. ${ev.endedAt}`);
  assert.deepEqual(Object.keys(ev.files).sort(), ['good/pass-a.test.mjs', 'good/pass-b.test.mjs']);
  assert.deepEqual(ev.files['good/pass-a.test.mjs'], { pass: 2, fail: 0, skip: 0, todo: 0, skipped: [] });
  assert.deepEqual(ev.files['good/pass-b.test.mjs'], { pass: 1, fail: 0, skip: 0, todo: 0, skipped: [] });
});

test('run-with-evidence exits with node --test\'s own code and still writes the record when a file fails', () => {
  assert.notEqual(bad.status, 0, 'a run with a failing file must not exit 0');
  assert.equal(readEvidence('bad').exitCode, bad.status);
});

test('a failing test is counted under fail, and a file that cannot load counts as one failure', () => {
  const { files } = readEvidence('bad');
  assert.deepEqual(files['bad/fail.test.mjs'], { pass: 1, fail: 1, skip: 0, todo: 0, skipped: [] });
  assert.equal(files['bad/broken.test.mjs'].fail, 1);
  assert.equal(files['bad/broken.test.mjs'].pass, 0);
});

test('skipped tests are counted and listed with their name and reason; todo is its own count', () => {
  const f = readEvidence('bad').files['bad/skip.test.mjs'];
  assert.equal(f.pass, 1);
  assert.equal(f.fail, 0);
  assert.equal(f.skip, 3);
  assert.equal(f.todo, 1);
  assert.deepEqual(f.skipped, [
    { name: 'needs a browser', reason: 'no Chromium on this box' },
    { name: 'nested skip', reason: '' },
    { name: 'dynamic', reason: 'decided at run time' },
  ]);
});

test('a skipped suite is one skip with its name and reason, so describe.skip cannot hide its tests', () => {
  assert.equal(suites.status, 0, suites.stderr + suites.stdout);
  const f = readEvidence('suites').files['suite/groups.test.mjs'];
  assert.equal(f.pass, 1);
  assert.equal(f.skip, 2);
  assert.deepEqual([...f.skipped].sort((a, b) => a.name.localeCompare(b.name)), [
    { name: 'hidden group', reason: '' },
    { name: 'reasoned group', reason: 'why' },
  ]);
  const reasons = checkEvidence({ evidence: readEvidence('suites'), expectedSha: project.sha, onDisk: ['suite/groups.test.mjs'], allowlist: [] });
  assert.equal(reasons.filter((r) => /skipped/.test(r)).length, 2, reasons.join('\n'));
});

test('a file that registers no test is recorded with zero of everything, not left out', () => {
  assert.deepEqual(readEvidence('bad').files['bad/empty.test.mjs'], { pass: 0, fail: 0, skip: 0, todo: 0, skipped: [] });
});

test('the build marker is public/deploy-marker.txt when it exists', () => {
  project.put('pub-marker/deploy-marker.txt', `${OTHER_SHA}\n`);
  const r = produce('marker', ['good/pass-b.test.mjs'], ['--public', 'pub-marker']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readEvidence('marker').build, { kind: 'deploy-marker', value: OTHER_SHA });
});

test('with no marker the build is the mtime of public/index.html, and the record says that is all it has', () => {
  project.put('pub-index/index.html', '<html></html>');
  const when = new Date('2026-10-01T12:00:00Z');
  utimesSync(path.join(project.dir, 'pub-index/index.html'), when, when);
  const r = produce('mtime', ['good/pass-b.test.mjs'], ['--public', 'pub-index']);
  assert.equal(r.status, 0, r.stderr);
  const { build } = readEvidence('mtime');
  assert.equal(build.kind, 'index-mtime');
  assert.equal(build.value, when.toISOString());
  assert.match(build.note, /records no commit/);
});

test('with no public/ at all the build is null, not a made-up value', () => {
  const r = produce('nobuild', ['good/pass-b.test.mjs'], ['--public', 'no-such-dir']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readEvidence('nobuild').build, null);
});

test('extra node --test flags pass through, and the default is the CI glob', () => {
  mkdirSync(path.join(project.dir, 'scripts/qcm'), { recursive: true });
  project.put('scripts/qcm/one.test.mjs', PASS_B);
  const r = node(RUN, ['--out', evidencePath('glob'), '--test-timeout=60000'], project.dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(Object.keys(readEvidence('glob').files), ['scripts/qcm/one.test.mjs']);
  assert.ok(readEvidence('glob').command.includes('--test-timeout=60000'), 'the flag did not reach node --test');
});

// ---- the consumer -------------------------------------------------------------------

const GOOD_DISK = ['good/pass-a.test.mjs', 'good/pass-b.test.mjs'];
const clean = () => structuredClone(readEvidence('good'));
const check = (evidence, over = {}) => checkEvidence({ evidence, expectedSha: project.sha, onDisk: GOOD_DISK, allowlist: [], ...over });

test('a clean record from the expected commit with every file on disk passes with no reasons', () => {
  assert.deepEqual(check(clean()), []);
});

test('a record from another commit is stale', () => {
  const reasons = check(clean(), { expectedSha: OTHER_SHA });
  assert.equal(reasons.length, 1, reasons.join('\n'));
  assert.match(reasons[0], /stale/);
  assert.ok(reasons[0].includes(project.sha) && reasons[0].includes(OTHER_SHA));
});

test('a record with no commit is rejected, not treated as a match', () => {
  const ev = clean();
  delete ev.commit;
  assert.ok(check(ev).some((r) => /commit/.test(r)));
});

test('a test file on disk that the record does not mention was not run', () => {
  const reasons = check(clean(), { onDisk: [...GOOD_DISK, 'good/new.test.mjs'] });
  assert.deepEqual(reasons.filter((r) => /not run/.test(r)).length, 1, reasons.join('\n'));
  assert.ok(reasons.some((r) => r.includes('good/new.test.mjs')));
});

test('a file with a failure is rejected and named', () => {
  const ev = clean();
  ev.files['good/pass-a.test.mjs'].fail = 1;
  const reasons = check(ev);
  assert.equal(reasons.length, 1, reasons.join('\n'));
  assert.match(reasons[0], /good\/pass-a\.test\.mjs.*1 failed/);
});

test('a non-zero exit code is rejected even when no file counted a failure', () => {
  const ev = clean();
  ev.exitCode = 1;
  assert.ok(check(ev).some((r) => /exit/.test(r)));
});

test('a skipped test with no allowlist entry is rejected with its name and reason', () => {
  const ev = readEvidence('bad');
  const reasons = checkEvidence({ evidence: ev, expectedSha: project.sha, onDisk: ['bad/skip.test.mjs'], allowlist: [] });
  const skips = reasons.filter((r) => /skipped/.test(r));
  assert.equal(skips.length, 3, reasons.join('\n'));
  assert.ok(skips.some((r) => r.includes('needs a browser') && r.includes('no Chromium on this box')));
});

test('an allowlist entry (file + test-name pattern) lets exactly the skips it names through', () => {
  const ev = readEvidence('bad');
  const entry = { file: 'bad/skip.test.mjs', test: '^needs a browser$', reason: 'fixture', owner: 'owner' };
  const reasons = checkEvidence({ evidence: ev, expectedSha: project.sha, onDisk: ['bad/skip.test.mjs'], allowlist: [entry] });
  const skips = reasons.filter((r) => /skipped/.test(r));
  assert.equal(skips.length, 2, reasons.join('\n'));
  assert.ok(!skips.some((r) => r.includes('needs a browser')));
  // the same pattern under another file's name allows nothing
  const other = checkEvidence({ evidence: ev, expectedSha: project.sha, onDisk: ['bad/skip.test.mjs'], allowlist: [{ ...entry, file: 'bad/other.test.mjs' }] });
  assert.equal(other.filter((r) => /skipped/.test(r)).length, 3);
});

test('a skip count the record does not name is rejected', () => {
  const ev = clean();
  ev.files['good/pass-a.test.mjs'].skip = 1;
  const reasons = check(ev);
  assert.equal(reasons.length, 1, reasons.join('\n'));
  assert.match(reasons[0], /good\/pass-a\.test\.mjs.*1 skipped test\(s\) the evidence does not name/);
});

test('a run narrowed by a node flag that drops tests is rejected', () => {
  for (const flag of ['--test-name-pattern=zzz', '--test-skip-pattern=a', '--test-only', '--test-shard=1/2']) {
    const ev = clean();
    ev.command = ['node', '--test', flag, 'good/pass-a.test.mjs'];
    const reasons = check(ev);
    assert.ok(reasons.some((r) => r.includes(flag.split('=')[0]) && /drop|narrow/.test(r)), `${flag}: ${reasons.join('\n')}`);
  }
  const ev = clean();
  ev.command = ['node', '--test', '--test-timeout=60000', 'good/pass-a.test.mjs'];
  assert.deepEqual(check(ev), []);
});

test('a required file the record leaves out is rejected, even when it lives outside the tests dir', () => {
  const reasons = check(clean(), { required: ['scripts/test-verify-claims.js'] });
  assert.equal(reasons.length, 1, reasons.join('\n'));
  assert.match(reasons[0], /not run.*scripts\/test-verify-claims\.js/);
  assert.deepEqual(check(clean(), { required: ['good/pass-b.test.mjs'] }), []);
});

test('a dirty tree is rejected only when asked', () => {
  const ev = clean();
  ev.dirty = true;
  assert.deepEqual(check(ev), []);
  const reasons = check(ev, { rejectDirty: true });
  assert.equal(reasons.length, 1, reasons.join('\n'));
  assert.match(reasons[0], /modified/);
  assert.deepEqual(check(clean(), { rejectDirty: true }), []);
});

test('a file that reports no test at all is rejected', () => {
  const ev = readEvidence('bad');
  const reasons = checkEvidence({ evidence: ev, expectedSha: project.sha, onDisk: ['bad/empty.test.mjs'], allowlist: [] });
  assert.ok(reasons.some((r) => /bad\/empty\.test\.mjs.*0 tests/.test(r)), reasons.join('\n'));
});

test('a record that is not the right shape is rejected without throwing', () => {
  for (const junk of [null, 'text', [], {}, { commit: project.sha }, { commit: project.sha, files: { 'good/pass-a.test.mjs': { pass: 'many' } } }]) {
    const reasons = check(junk);
    assert.ok(reasons.length > 0, JSON.stringify(junk));
  }
});

test('allowlist entries need file, test, reason and owner, and a test pattern that compiles', () => {
  assert.deepEqual(validateAllowlist({ entries: [] }), []);
  assert.ok(validateAllowlist({ entries: [{ file: 'a', test: 'b', reason: 'c' }] }).some((r) => /owner/.test(r)));
  assert.ok(validateAllowlist({ entries: [{ file: 'a', test: '(', reason: 'c', owner: 'd' }] }).some((r) => /pattern/.test(r)));
  assert.ok(validateAllowlist(null).length > 0);
  assert.ok(validateAllowlist({}).length > 0);
});

test('the shipped allowlist is valid, and starts empty: no skip is legitimate in CI today', () => {
  const real = JSON.parse(readFileSync(path.join(HERE, 'evidence-skip-allowlist.json'), 'utf8'));
  assert.deepEqual(validateAllowlist(real), []);
  assert.deepEqual(real.entries, []);
});

// ---- the consumer as a command ------------------------------------------------------

const cli = (args) => node(CHECK, args, project.dir);
const lines = (r) => r.stdout.split('\n').filter(Boolean);

test('check-evidence exits 0 and prints nothing to fail on for a clean record', () => {
  const r = cli(['--evidence', evidencePath('good'), '--sha', project.sha, '--tests-dir', 'good']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('check-evidence exits 1 for a missing evidence file, one plain line', () => {
  const r = cli(['--evidence', evidencePath('nope'), '--sha', project.sha, '--tests-dir', 'good']);
  assert.equal(r.status, 1);
  assert.equal(lines(r).length, 1, r.stdout);
  assert.match(lines(r)[0], /missing/);
});

test('check-evidence exits 1 for an unparsable evidence file', () => {
  writeFileSync(evidencePath('garbage'), '{ not json');
  const r = cli(['--evidence', evidencePath('garbage'), '--sha', project.sha, '--tests-dir', 'good']);
  assert.equal(r.status, 1);
  assert.match(lines(r)[0], /unparsable/);
});

test('check-evidence exits 1 for another commit, an unrun file, a failure and an unlisted skip, one line per reason', () => {
  const stale = cli(['--evidence', evidencePath('good'), '--sha', OTHER_SHA, '--tests-dir', 'good']);
  assert.equal(stale.status, 1);
  assert.match(lines(stale).join('\n'), /stale/);

  const unrun = cli(['--evidence', evidencePath('good'), '--sha', project.sha, '--tests-dir', 'bad']);
  assert.equal(unrun.status, 1);
  assert.equal(lines(unrun).filter((l) => /not run/.test(l)).length, 4, unrun.stdout);

  // `bad` was run over four files, so a clean tests-dir of the same four sees them all.
  const r = cli(['--evidence', evidencePath('bad'), '--sha', project.sha, '--tests-dir', 'bad']);
  assert.equal(r.status, 1);
  const out = lines(r).join('\n');
  assert.match(out, /bad\/fail\.test\.mjs.*1 failed/);
  assert.match(out, /bad\/skip\.test\.mjs.*skipped.*needs a browser/);
  assert.match(out, /bad\/empty\.test\.mjs.*0 tests/);
  for (const l of lines(r)) assert.ok(!l.includes('\n') && l.trim() === l, l);
});

test('check-evidence --allowlist reads a file, and rejects a malformed one', () => {
  writeFileSync(path.join(project.dir, 'allow.json'), JSON.stringify({ entries: [{ file: 'good/pass-a.test.mjs', test: 'x', reason: 'r' }] }));
  const r = cli(['--evidence', evidencePath('good'), '--sha', project.sha, '--tests-dir', 'good', '--allowlist', 'allow.json']);
  assert.equal(r.status, 1);
  assert.match(lines(r).join('\n'), /owner/);
});

test('check-evidence --require names a file the record must hold, and --reject-dirty refuses a modified tree', () => {
  const base = ['--evidence', evidencePath('good'), '--sha', project.sha, '--tests-dir', 'good'];
  const missing = cli([...base, '--require', 'scripts/test-verify-claims.js']);
  assert.equal(missing.status, 1);
  assert.match(lines(missing).join('\n'), /not run.*scripts\/test-verify-claims\.js/);
  assert.equal(cli([...base, '--require', 'good/pass-a.test.mjs', '--require', 'good/pass-b.test.mjs']).status, 0);

  const ev = clean();
  ev.dirty = true;
  writeFileSync(evidencePath('dirty'), JSON.stringify(ev));
  const dirty = cli(['--evidence', evidencePath('dirty'), '--sha', project.sha, '--tests-dir', 'good', '--reject-dirty']);
  assert.equal(dirty.status, 1);
  assert.match(lines(dirty).join('\n'), /modified/);
});

// ---- the skip tier (PR CI scope: no Field Maps file could be affected) ---------------
// A scope-skipped run deliberately does not run scripts/qcm/*.test.mjs. The tier is an
// explicit input, never an implicit pass: files on disk are not demanded, but the
// explicitly named files must be in the record, and the tier must name at least one.

const SKIP_DISK = [];
test('qcm scope skip: files on disk are not demanded, the required files still are', () => {
  const ev = clean();
  ev.files = { 'scripts/test-verify-claims.js': ev.files['good/pass-a.test.mjs'] };
  assert.deepEqual(check(ev, { onDisk: GOOD_DISK, qcmScope: 'skip', required: ['scripts/test-verify-claims.js'] }), []);
  // full (the default) still demands every file on disk
  assert.ok(check(ev, { onDisk: GOOD_DISK, required: ['scripts/test-verify-claims.js'] }).some((r) => /not run.*good\/pass-a/.test(r)));
  assert.ok(check(ev, { onDisk: GOOD_DISK, qcmScope: 'full', required: ['scripts/test-verify-claims.js'] }).some((r) => /not run/.test(r)));
});

test('qcm scope skip: a required file the record leaves out is still rejected', () => {
  const reasons = check(clean(), { onDisk: SKIP_DISK, qcmScope: 'skip', required: ['scripts/test-deploy-gate.mjs'] });
  assert.equal(reasons.length, 1, reasons.join('\n'));
  assert.match(reasons[0], /not run.*scripts\/test-deploy-gate\.mjs/);
});

test('qcm scope skip with nothing required is rejected, never an implicit pass', () => {
  const reasons = check(clean(), { onDisk: SKIP_DISK, qcmScope: 'skip', required: [] });
  assert.equal(reasons.length, 1, reasons.join('\n'));
  assert.match(reasons[0], /skip.*--require/);
});

test('qcm scope skip still fails on a failure, a stale commit and an unlisted skip', () => {
  const ev = clean();
  ev.files['good/pass-a.test.mjs'].fail = 1;
  const reasons = check(ev, { onDisk: SKIP_DISK, qcmScope: 'skip', required: ['good/pass-a.test.mjs'], expectedSha: OTHER_SHA });
  assert.ok(reasons.some((r) => /failed/.test(r)) && reasons.some((r) => /stale/.test(r)), reasons.join('\n'));
});

test('an unknown qcm scope is rejected', () => {
  const reasons = check(clean(), { qcmScope: 'maybe' });
  assert.ok(reasons.some((r) => /qcm scope/.test(r)), reasons.join('\n'));
});

test('check-evidence --qcm-scope skip: exits 0 with required files, 1 without, 2 on a bad value', () => {
  const base = ['--evidence', evidencePath('good'), '--sha', project.sha, '--tests-dir', 'bad'];
  // 'bad' holds files the good record never ran: full fails, skip does not demand them.
  assert.equal(cli(base).status, 1);
  const skip = cli([...base, '--qcm-scope', 'skip', '--require', 'good/pass-a.test.mjs']);
  assert.equal(skip.status, 0, skip.stdout + skip.stderr);
  const none = cli([...base, '--qcm-scope', 'skip']);
  assert.equal(none.status, 1);
  assert.match(lines(none).join('\n'), /skip.*--require/);
  assert.equal(cli([...base, '--qcm-scope', 'maybe']).status, 2);
  assert.equal(cli([...base, '--qcm-scope', 'full']).status, 1);
});

// ---- the site tier (PR CI scope: only site chrome changed) ---------------------------
// `site` runs the SITE-COUPLED subset of scripts/qcm, listed in a tracked manifest. The
// tier is an explicit input like skip, but it demands MORE than skip: every file of the
// expected list must be in the record, the list may not be empty, and it may not name a file
// that is not on disk (a stale manifest). The engine files outside it are not demanded.

const SITE_EXPECT = ['good/pass-a.test.mjs'];

test('qcm scope site: the expected files are demanded, the rest of the disk is not', () => {
  const ev = clean();
  delete ev.files['good/pass-b.test.mjs'];
  assert.deepEqual(check(ev, { onDisk: GOOD_DISK, qcmScope: 'site', expected: SITE_EXPECT, required: ['good/pass-a.test.mjs'] }), []);
});

test('qcm scope site: an expected file the record leaves out is "not run"', () => {
  const reasons = check(clean(), { onDisk: [...GOOD_DISK, 'good/never.test.mjs'], qcmScope: 'site', expected: ['good/pass-a.test.mjs', 'good/never.test.mjs'], required: ['good/pass-a.test.mjs'] });
  assert.equal(reasons.length, 1, reasons.join('\n'));
  assert.match(reasons[0], /not run.*good\/never\.test\.mjs/);
});

test('qcm scope site fails closed: no expected list, or one naming a file not on disk', () => {
  const none = check(clean(), { onDisk: GOOD_DISK, qcmScope: 'site', expected: [], required: ['good/pass-a.test.mjs'] });
  assert.ok(none.some((r) => /site.*expected/.test(r)), none.join('\n'));
  const missing = check(clean(), { onDisk: GOOD_DISK, qcmScope: 'site', required: ['good/pass-a.test.mjs'] });
  assert.ok(missing.some((r) => /site.*expected/.test(r)), missing.join('\n'));
  const stale = check(clean(), { onDisk: GOOD_DISK, qcmScope: 'site', expected: ['good/pass-a.test.mjs', 'good/deleted.test.mjs'], required: ['good/pass-a.test.mjs'] });
  assert.ok(stale.some((r) => /good\/deleted\.test\.mjs.*not on disk/.test(r)), stale.join('\n'));
});

test('qcm scope site still needs --require, and still fails on a failure, a stale commit and an unlisted skip', () => {
  const noReq = check(clean(), { onDisk: GOOD_DISK, qcmScope: 'site', expected: SITE_EXPECT, required: [] });
  assert.ok(noReq.some((r) => /site.*--require/.test(r)), noReq.join('\n'));
  const ev = clean();
  ev.files['good/pass-a.test.mjs'].fail = 1;
  ev.files['good/pass-b.test.mjs'].skip = 1;
  ev.files['good/pass-b.test.mjs'].skipped = [{ name: 'x', reason: 'r' }];
  const reasons = check(ev, { onDisk: GOOD_DISK, qcmScope: 'site', expected: SITE_EXPECT, required: ['good/pass-a.test.mjs'], expectedSha: OTHER_SHA });
  assert.ok(reasons.some((r) => /failed/.test(r)) && reasons.some((r) => /stale/.test(r)) && reasons.some((r) => /skipped "x"/.test(r)), reasons.join('\n'));
});

test('--expect is only meaningful for the site tier', () => {
  const reasons = check(clean(), { onDisk: GOOD_DISK, qcmScope: 'full', expected: SITE_EXPECT });
  assert.deepEqual(reasons, []);
});

test('check-evidence --qcm-scope site: --expect or --manifest names the list; none is exit 1', () => {
  project.put('site-list.json', JSON.stringify({ siteCoupled: ['good/pass-a.test.mjs'] }));
  project.put('site-empty.json', JSON.stringify({ siteCoupled: [] }));
  const base = ['--evidence', evidencePath('good'), '--sha', project.sha, '--tests-dir', 'good', '--qcm-scope', 'site', '--require', 'good/pass-a.test.mjs'];
  const viaExpect = cli([...base, '--expect', 'good/pass-a.test.mjs']);
  assert.equal(viaExpect.status, 0, viaExpect.stdout + viaExpect.stderr);
  const viaManifest = cli([...base, '--manifest', 'site-list.json']);
  assert.equal(viaManifest.status, 0, viaManifest.stdout + viaManifest.stderr);
  const empty = cli([...base, '--manifest', 'site-empty.json']);
  assert.equal(empty.status, 1);
  assert.match(lines(empty).join('\n'), /site.*expected/);
  const unreadable = cli([...base, '--manifest', 'nope.json']);
  assert.equal(unreadable.status, 1, unreadable.stdout + unreadable.stderr);
  // 'suites' is a record that never ran the expected file
  const other = ['--evidence', evidencePath('suites'), ...base.slice(2)];
  const notRun = cli([...other, '--expect', 'good/pass-a.test.mjs']);
  assert.equal(notRun.status, 1);
  assert.match(lines(notRun).join('\n'), /not run.*good\/pass-a/);
});

test('run-with-evidence --qcm-scope site runs the manifest files and records them', () => {
  project.put('site-run.json', JSON.stringify({ siteCoupled: ['good/pass-a.test.mjs', 'good/pass-b.test.mjs'] }));
  const run = node(RUN, ['--out', evidencePath('site-run'), '--qcm-scope', 'site', '--manifest', 'site-run.json'], project.dir);
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.deepEqual(Object.keys(readEvidence('site-run').files).sort(), ['good/pass-a.test.mjs', 'good/pass-b.test.mjs']);
  // an empty or unreadable manifest must not fall back to the default glob
  project.put('site-run-empty.json', JSON.stringify({ siteCoupled: [] }));
  const empty = node(RUN, ['--out', evidencePath('site-empty'), '--qcm-scope', 'site', '--manifest', 'site-run-empty.json'], project.dir);
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /site/);
  const absent = node(RUN, ['--out', evidencePath('site-absent'), '--qcm-scope', 'site', '--manifest', 'absent.json'], project.dir);
  assert.notEqual(absent.status, 0);
  // full and skip leave the arguments alone
  const skip = node(RUN, ['--out', evidencePath('site-skip'), '--qcm-scope', 'skip', 'good/pass-b.test.mjs'], project.dir);
  assert.equal(skip.status, 0, skip.stderr);
  assert.deepEqual(Object.keys(readEvidence('site-skip').files), ['good/pass-b.test.mjs']);
});
