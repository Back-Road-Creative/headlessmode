// Run `node --test` and leave a JSON record of what it ran (QQA-12a, slice 1).
//
//   node scripts/qcm/run-with-evidence.mjs --out evidence.json [--public public] \
//        [--qcm-scope full|site|skip] [--manifest scripts/qcm/site-coupling.json] \
//        [node --test flags=with-equals] [files or globs...]
//
// --qcm-scope site (PR CI scope tier, scripts/ci/pr-scope.mjs) adds the manifest's SITE-COUPLED
// test files to the run. An empty or unreadable manifest exits 2 rather than falling back to the
// default glob. full and skip change nothing here (skip passes only the named files).

// With no file or glob it runs the glob CI runs, scripts/qcm/*.test.mjs. Normal test output
// streams as it does without this wrapper; the exit code is node --test's own. The record is
// written even when the run fails, because a failing record is evidence too.
//
// Give node's flags as --flag=value: a bare value after a flag is read as a file.
//
// The record (check-evidence.mjs is its consumer): the commit, whether tracked files were
// modified, the build marker, node's version, start and end time, the exit code, and per
// test file its pass / fail / skip / todo counts and the name and reason of each skipped test.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORTER = path.join(HERE, 'evidence-reporter.mjs');
export const DEFAULT_GLOB = 'scripts/qcm/*.test.mjs';
const DEFAULT_MANIFEST = path.join(HERE, 'site-coupling.json');
export const SCHEMA_VERSION = 1;

const posix = (p) => p.split(path.sep).join('/');

/** Per-file counts from the reporter's lines. A suite counts only when it is skipped (or todo):
 *  node emits just the suite event for describe.skip, with none for the tests inside it, so
 *  the suite is the only place that skip shows. A file-level event (a test
 *  named for its own file) is not a test: a failure there is the file failing to load or
 *  being cancelled, and counts as one failure; a pass there means nothing ran it as a test. */
export function summarize(records, cwd) {
  const files = {};
  for (const r of records) {
    const rel = posix(path.relative(cwd, r.file));
    const entry = (files[rel] ??= { pass: 0, fail: 0, skip: 0, todo: 0, skipped: [] });
    if (r.suite) {
      if (r.skip !== false) {
        entry.skip += 1;
        entry.skipped.push({ name: r.name, reason: r.skip });
      } else if (r.todo !== false) entry.todo += 1;
      continue;
    }
    const fileLevel = r.nesting === 0 && (r.name === path.basename(r.file) || r.name === r.file || r.name === rel);
    if (fileLevel) {
      if (r.status === 'fail') entry.fail += 1;
      continue;
    }
    if (r.status === 'fail') entry.fail += 1;
    else if (r.skip !== false) {
      entry.skip += 1;
      entry.skipped.push({ name: r.name, reason: r.skip });
    } else if (r.todo !== false) entry.todo += 1;
    else entry.pass += 1;
  }
  return files;
}

/** What public/ says about the build. Hugo records no commit in public/ before the tests run:
 *  deploy-marker.txt is written by deploy-production.yml AFTER them. So the marker is used
 *  when there is one, and otherwise the record falls back to public/index.html's mtime and
 *  says that is all it has. null: no build to describe. */
export function buildMarker(publicDir) {
  const marker = path.join(publicDir, 'deploy-marker.txt');
  if (existsSync(marker)) return { kind: 'deploy-marker', value: readFileSync(marker, 'utf8').trim() };
  const index = path.join(publicDir, 'index.html');
  if (existsSync(index)) {
    return {
      kind: 'index-mtime',
      value: statSync(index).mtime.toISOString(),
      note: 'the build records no commit in public/ before the tests run; this is only the mtime of public/index.html',
    };
  }
  return null;
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const own = { out: null, publicDir: 'public', qcmScope: 'full', manifest: DEFAULT_MANIFEST };
  const KEYS = { out: 'out', public: 'publicDir', 'qcm-scope': 'qcmScope', manifest: 'manifest' };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const eq = a.match(/^--(out|public|qcm-scope|manifest)=(.*)$/);
    if (eq) own[KEYS[eq[1]]] = eq[2];
    else if (/^--(out|public|qcm-scope|manifest)$/.test(a)) {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error(`run-with-evidence: ${a} needs a value.`);
      own[KEYS[a.slice(2)]] = v;
      i += 1;
    } else rest.push(a);
  }
  if (!own.out) throw new Error('run-with-evidence: --out <evidence.json> is required.');
  if (!['full', 'site', 'skip'].includes(own.qcmScope)) throw new Error(`run-with-evidence: --qcm-scope must be full, site or skip, got "${own.qcmScope}".`);
  if (own.qcmScope === 'site') {
    let files;
    try { files = JSON.parse(readFileSync(own.manifest, 'utf8')).siteCoupled; } catch (err) {
      throw new Error(`run-with-evidence: qcm scope site needs a readable manifest: ${own.manifest}: ${err.message}`);
    }
    if (!Array.isArray(files) || files.length === 0 || files.some((f) => typeof f !== 'string')) {
      throw new Error(`run-with-evidence: qcm scope site needs a non-empty "siteCoupled" list in ${own.manifest}.`);
    }
    rest.push(...files);
  }
  if (!rest.some((a) => !a.startsWith('-'))) rest.push(DEFAULT_GLOB);
  return { ...own, nodeArgs: rest };
}

function readRecords(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function main(argv) {
  const { out, publicDir, nodeArgs } = parseArgs(argv);
  const cwd = process.cwd();
  const scratch = mkdtempSync(path.join(tmpdir(), 'qcm-evidence-run-'));
  const eventsFile = path.join(scratch, 'events.jsonl');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // set when this runs under another node --test; it would make ours a child of that run
  const stdoutReporter = process.stdout.isTTY ? 'spec' : 'tap';
  const args = [
    '--test',
    `--test-reporter=${stdoutReporter}`, '--test-reporter-destination=stdout',
    `--test-reporter=${REPORTER}`, `--test-reporter-destination=${eventsFile}`,
    ...nodeArgs,
  ];
  const startedAt = new Date();
  const exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: 'inherit' });
    child.on('error', (err) => { console.error(`run-with-evidence: ${err.message}`); resolve(1); });
    child.on('close', (code) => resolve(code ?? 1));
  });
  const endedAt = new Date();

  const evidence = {
    schemaVersion: SCHEMA_VERSION,
    commit: git(cwd, ['rev-parse', 'HEAD']),
    dirty: (git(cwd, ['status', '--porcelain', '--untracked-files=no']) ?? '') !== '',
    build: buildMarker(path.resolve(cwd, publicDir)),
    node: process.version,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    command: ['node', ...args.filter((a) => !a.includes(scratch) && a !== REPORTER && !a.startsWith('--test-reporter'))],
    exitCode,
    files: summarize(readRecords(eventsFile), cwd),
  };
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(path.dirname(path.resolve(cwd, out)), { recursive: true });
  writeFileSync(path.resolve(cwd, out), `${JSON.stringify(evidence, null, 2)}\n`);
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { console.error(err.message); process.exitCode = 2; });
}
