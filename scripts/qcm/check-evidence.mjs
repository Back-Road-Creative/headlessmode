// The consumer of run-with-evidence.mjs's record (QQA-12a, slice 1). It exits 1, printing one
// plain line per reason, unless the evidence can be trusted for the commit being gated:
//
//   - the file is missing or unparsable, or is not shaped like a record
//   - its commit is not the expected one (stale)
//   - a scripts/qcm/*.test.mjs on disk is absent from it (never run: a glob that missed it)
//   - a file has a failure, or the run exited non-zero
//   - a file reports no test at all
//   - a test (or a whole describe) was skipped and no allowlist entry (file + test-name pattern) names it
//   - the run used a node flag that drops tests (--test-name-pattern, --test-skip-pattern,
//     --test-only, --test-shard), so a partial run cannot look clean
//   - a file given with --require (repeatable; for a test outside --tests-dir, such as
//     scripts/test-verify-claims.js) is absent from the record
//   - with --reject-dirty, the run was made with modified tracked files
//
// --qcm-scope full|site|skip (default full) is the PR CI scope tier (scripts/ci/pr-scope.mjs).
// `full` is everything above. `skip` means the scope job proved no changed file can affect the
// Field Maps app, so the scripts/qcm suite was deliberately not selected: files on disk are not
// demanded, but every other check holds, and at least one --require is mandatory so the tier can
// never pass on an empty record. `site` means only site chrome changed, so only the SITE-COUPLED
// subset was selected: instead of the files on disk, every file of the expected list (--expect,
// repeatable, else the --manifest's "siteCoupled", default scripts/qcm/site-coupling.json) must
// be in the record. It fails closed: an empty or unreadable list, or an entry that is not on
// disk (a stale manifest), is a failure, and --require is mandatory here too. An unknown value
// exits 2.
//
//   node scripts/qcm/check-evidence.mjs --evidence evidence.json --sha <commit|HEAD> \
//        [--tests-dir scripts/qcm] [--allowlist scripts/qcm/evidence-skip-allowlist.json] \
//        [--require <file>]... [--reject-dirty] [--qcm-scope full|site|skip] \
//        [--expect <file>]... [--manifest scripts/qcm/site-coupling.json]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ALLOWLIST = path.join(HERE, 'evidence-skip-allowlist.json');
const DEFAULT_MANIFEST = path.join(HERE, 'site-coupling.json');
const COUNTS = ['pass', 'fail', 'skip', 'todo'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (v) => Number.isInteger(v) && v >= 0;

/** Problems with an allowlist document; an empty array means it is usable. */
export function validateAllowlist(doc) {
  if (!isObject(doc) || !Array.isArray(doc.entries)) return ['allowlist must be an object with an "entries" array'];
  const problems = [];
  doc.entries.forEach((e, i) => {
    if (!isObject(e)) { problems.push(`allowlist entry ${i} is not an object`); return; }
    for (const key of ['file', 'test', 'reason', 'owner']) {
      if (typeof e[key] !== 'string' || e[key].trim() === '') problems.push(`allowlist entry ${i} has no ${key}`);
    }
    if (typeof e.test === 'string') {
      try { new RegExp(e.test); } catch (err) { problems.push(`allowlist entry ${i} has a test pattern that does not compile: ${err.message}`); }
    }
  });
  return problems;
}

function shapeProblems(ev) {
  if (!isObject(ev)) return ['evidence is not a JSON object'];
  const problems = [];
  if (typeof ev.commit !== 'string' || ev.commit === '') problems.push('evidence has no commit sha');
  if (!Number.isInteger(ev.exitCode)) problems.push('evidence has no exit code');
  if (!isObject(ev.files)) { problems.push('evidence has no files map'); return problems; }
  for (const [file, f] of Object.entries(ev.files)) {
    if (!isObject(f) || COUNTS.some((k) => !isCount(f[k])) || !Array.isArray(f.skipped)
      || f.skipped.some((s) => !isObject(s) || typeof s.name !== 'string' || typeof s.reason !== 'string')) {
      problems.push(`evidence for ${file} is malformed (needs pass/fail/skip/todo counts and a skipped list of name+reason)`);
    }
  }
  return problems;
}

export const QCM_SCOPES = ['full', 'site', 'skip'];
const DROPPING_FLAGS = ['--test-name-pattern', '--test-skip-pattern', '--test-only', '--test-shard'];

const allows = (allowlist, file, name) => allowlist.some((e) => e.file === file && new RegExp(e.test).test(name));

/** Why this evidence cannot be trusted for `expectedSha`; an empty array means it can.
 *  `onDisk` is the repo-relative test files that should have run (what the glob matches).
 *  `expected` is the site tier's list: it replaces onDisk as what must have run. */
export function checkEvidence({ evidence, expectedSha, onDisk, allowlist, required = [], rejectDirty = false, qcmScope = 'full', expected = [] }) {
  const shape = shapeProblems(evidence);
  if (shape.length) return shape;
  const reasons = [];
  if (!QCM_SCOPES.includes(qcmScope)) reasons.push(`unknown qcm scope "${qcmScope}" (expected ${QCM_SCOPES.join(' or ')})`);
  const skipTier = qcmScope === 'skip';
  if (skipTier && required.length === 0) {
    reasons.push('qcm scope skip needs at least one --require file: a skipped Field Maps suite must still prove the named tests ran');
  }
  const siteTier = qcmScope === 'site';
  if (siteTier && required.length === 0) {
    reasons.push('qcm scope site needs at least one --require file: a narrowed Field Maps suite must still prove the named tests ran');
  }
  if (siteTier && expected.length === 0) {
    reasons.push('qcm scope site needs an expected list (--expect or the site-coupling manifest) and it is empty: a site run with nothing expected would pass on nothing');
  }
  if (siteTier) {
    for (const f of expected) {
      if (!onDisk.includes(f)) reasons.push(`the site list names ${f}, which is not on disk (stale manifest)`);
    }
  }
  if (evidence.commit !== expectedSha) {
    reasons.push(`stale evidence: recorded for commit ${evidence.commit}, expected ${expectedSha}`);
  }
  if (evidence.exitCode !== 0) reasons.push(`the recorded run exited ${evidence.exitCode}`);
  if (rejectDirty && evidence.dirty === true) reasons.push('the run was made with modified tracked files (dirty tree)');
  for (const arg of Array.isArray(evidence.command) ? evidence.command : []) {
    const flagName = typeof arg === 'string' ? DROPPING_FLAGS.find((f) => arg === f || arg.startsWith(`${f}=`)) : undefined;
    if (flagName) reasons.push(`the run used ${arg}, which drops tests; a narrowed run is not evidence for the whole suite`);
  }
  for (const file of [...new Set([...(skipTier ? [] : siteTier ? expected : onDisk), ...required])]) {
    if (!Object.hasOwn(evidence.files, file)) reasons.push(`not run: ${file} is on disk or required but absent from the evidence`);
  }
  for (const [file, f] of Object.entries(evidence.files)) {
    if (f.fail > 0) reasons.push(`${file}: ${f.fail} failed`);
    if (f.pass + f.fail + f.skip + f.todo === 0) reasons.push(`${file}: 0 tests ran`);
    for (const s of f.skipped) {
      if (!allows(allowlist, file, s.name)) {
        reasons.push(`${file}: skipped "${s.name}" (${s.reason || 'no reason given'}), with no allowlist entry`);
      }
    }
    if (f.skip > f.skipped.length) reasons.push(`${file}: ${f.skip - f.skipped.length} skipped test(s) the evidence does not name`);
  }
  return reasons;
}

/** Allowlist entries that excused no skip in this evidence: the cause may be fixed, so the hole can close. */
export function unusedAllowlistEntries(evidence, allowlist) {
  const skips = Object.entries(evidence.files).flatMap(([file, f]) => f.skipped.map((s) => ({ file, name: s.name })));
  return allowlist.filter((e) => !skips.some((s) => s.file === e.file && new RegExp(e.test).test(s.name)));
}

/** Repo-relative paths of the *.test.mjs files directly in `testsDir` (CI's glob does not recurse). */
export function testFilesOnDisk(testsDir) {
  const dir = path.posix.normalize(testsDir.split(path.sep).join('/')).replace(/\/$/, '');
  return readdirSync(testsDir).filter((n) => n.endsWith('.test.mjs')).sort().map((n) => path.posix.join(dir, n));
}

function flags(argv, name) {
  const out = [];
  argv.forEach((a, i) => {
    if (a !== name) return;
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`check-evidence: ${name} needs a value.`);
    out.push(v);
  });
  return out;
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`check-evidence: ${name} needs a value.`);
  return v;
}

function resolveSha(value) {
  if (/^[0-9a-f]{40}$/.test(value)) return value;
  return execFileSync('git', ['rev-parse', '--verify', `${value}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function main(argv) {
  const evidenceFile = flag(argv, '--evidence');
  const shaArg = flag(argv, '--sha');
  if (!evidenceFile || !shaArg) throw new Error('usage: check-evidence.mjs --evidence <file> --sha <commit|HEAD> [--tests-dir <dir>] [--allowlist <file>] [--require <file>]... [--reject-dirty] [--qcm-scope full|site|skip] [--expect <file>]... [--manifest <file>]');
  const qcmScope = flag(argv, '--qcm-scope') ?? 'full';
  if (!QCM_SCOPES.includes(qcmScope)) throw new Error(`check-evidence: --qcm-scope must be ${QCM_SCOPES.join(' or ')}, got "${qcmScope}".`);
  const testsDir = flag(argv, '--tests-dir') ?? 'scripts/qcm';
  const allowlistFile = flag(argv, '--allowlist') ?? DEFAULT_ALLOWLIST;

  const fail = (reasons) => { for (const r of reasons) console.log(r); return 1; };
  if (!existsSync(evidenceFile)) return fail([`evidence file missing: ${evidenceFile}`]);
  let evidence;
  try { evidence = JSON.parse(readFileSync(evidenceFile, 'utf8')); } catch (err) {
    return fail([`evidence file unparsable: ${evidenceFile}: ${err.message}`]);
  }
  let allowDoc;
  try { allowDoc = JSON.parse(readFileSync(allowlistFile, 'utf8')); } catch (err) {
    return fail([`allowlist unreadable: ${allowlistFile}: ${err.message}`]);
  }
  const allowProblems = validateAllowlist(allowDoc);
  if (allowProblems.length) return fail(allowProblems);

  let expected = flags(argv, '--expect');
  if (qcmScope === 'site' && expected.length === 0) {
    const manifest = flag(argv, '--manifest') ?? DEFAULT_MANIFEST;
    try { expected = JSON.parse(readFileSync(manifest, 'utf8')).siteCoupled; } catch (err) {
      return fail([`site list unreadable: ${manifest}: ${err.message}`]);
    }
    if (!Array.isArray(expected)) return fail([`site list ${manifest} has no "siteCoupled" array`]);
  }
  const reasons = checkEvidence({ evidence, expectedSha: resolveSha(shaArg), onDisk: testFilesOnDisk(testsDir), allowlist: allowDoc.entries,
    required: flags(argv, '--require'), rejectDirty: argv.includes('--reject-dirty'), qcmScope, expected });
  if (reasons.length) return fail(reasons);
  if (isObject(evidence)) {
    for (const e of unusedAllowlistEntries(evidence, allowDoc.entries)) {
      console.error(`warning: allowlist entry for ${e.file} /${e.test}/ excused no skip in this run; remove it if the cause is gone`);
    }
  }
  const files = Object.values(evidence.files);
  console.log(`evidence ok: ${files.length} test files, ${files.reduce((n, f) => n + f.pass, 0)} passed, commit ${evidence.commit}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (err) { console.error(err.message); process.exitCode = 2; }
}
