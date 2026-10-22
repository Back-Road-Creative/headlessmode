// Lives in scripts/qcm/ on purpose: pr-ci.yml's node step globs scripts/qcm/*.test.mjs, so CI runs this with no workflow edit (a scripts/test_*.py would have to be named in pr-ci.yml).
// Tests for bin/verify-worktree.sh: it must take its commands from the workflow at run time, so
// every expectation below is parsed from a workflow file here, never copied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'bin', 'verify-worktree.sh');
const REAL_WORKFLOW = join(ROOT, '.github', 'workflows', 'pr-ci.yml');

/** Run the script with a clean env: no inherited prefix, lock or CHROME_PATH unless the test sets it. */
const run = (args, env = {}) => {
  const clean = { ...process.env };
  for (const k of ['VERIFY_PYTEST_PREFIX', 'CHROME_PATH', 'NODE_TEST_CONTEXT']) delete clean[k];
  return spawnSync('bash', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...clean, ...env } });
};
const planLines = (r) => r.stdout.split('\n').filter(Boolean);
const tmp = () => mkdtempSync(join(tmpdir(), 'verify-worktree-test-'));

/** Independent parse of a workflow: the commands the script is supposed to mirror. */
const expectedFrom = (text) => {
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''));
  const body = (l) => l.trim().replace(/^- /, '').replace(/^run:\s*/, '');
  return {
    css: lines.map(body).filter((s) => s === 'npm run build:css'),
    site: lines.map(body).filter((s) => s.startsWith('bash scripts/build-site.sh ')),
    py: lines.map(body).filter((s) => s.startsWith('venv/bin/python3 ') && s.includes('scripts/')),
    node: lines.filter((l) => /^\s*run:\s+node (--test|scripts\/qcm\/run-with-evidence\.mjs) /.test(l)).map((l) => l.replace(/^\s*run:\s+/, '')),
  };
};

// The node step really runs a one-test file (tests d and the log-tail test), and --test-timeout bounds the
// whole file: 1000 ms failed #748's CI when a loaded runner took 4.2 s to start it. 600000 is the repo's own value.
const FIXTURE = `name: fixture
env:
  CHROME_PATH: '/x/chrome'
jobs:
  j:
    steps:
      - name: css
        run: npm run build:css
      - name: site
        run: |
          echo "=== build ==="
          bash scripts/build-site.sh --configDir site-config --minify
      - name: py
        run: |
          echo hello
          # venv/bin/python3 scripts/commented_out.py
          venv/bin/python3 scripts/ok_one.py --flag
          venv/bin/python3 -m pytest scripts/test_two.py -v
          venv/bin/python3 -c "print('no scripts path here')"
          node scripts/not_python.js
          venv/bin/python3 scripts/fail_three.py
      - name: node
        run: node --test --test-timeout=600000 "scripts/qcm/*.test.mjs"
`;
const fixtureFile = (text = FIXTURE) => {
  const p = join(tmp(), 'wf.yml');
  writeFileSync(p, text);
  return p;
};

test('(a) --plan on the real repo mirrors pr-ci.yml, in order', () => {
  const r = run(['--plan']);
  assert.equal(r.status, 0, r.stderr);
  const want = expectedFrom(readFileSync(REAL_WORKFLOW, 'utf8'));
  assert.ok(want.py.length > 10, 'the workflow should name many python lines');
  assert.equal(want.css.length, 1);
  assert.equal(want.site.length, 1);
  assert.equal(want.node.length, 1);
  const got = planLines(r);
  assert.equal(got.length, 2 + want.py.length + 1, 'css + site + every python line + node');
  assert.equal(got[0], want.css[0]);
  assert.equal(got[1], want.site[0]);
  const py = got.slice(2, -1);
  assert.deepEqual(py.map((l) => l.replace(/^\S*python3 /, '')), want.py.map((l) => l.replace(/^venv\/bin\/python3 /, '')));
  assert.equal(got.at(-1), want.node[0].replace(/^run:\s*/, ''));
});

test('(b) --plan against a fixture lists exactly the fixture commands', () => {
  const r = run(['--plan', '--workflow', fixtureFile(), '--python', '/py']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(planLines(r), [
    'npm run build:css',
    'bash scripts/build-site.sh --configDir site-config --minify',
    '/py scripts/ok_one.py --flag',
    '/py -m pytest scripts/test_two.py -v',
    '/py scripts/fail_three.py',
    'node --test --test-timeout=600000 "scripts/qcm/*.test.mjs"',
  ]);
});

test('the node step may go through the evidence wrapper, and a local run gets a RUNNER_TEMP', () => {
  const wrapped = FIXTURE.replace(
    'run: node --test --test-timeout=600000 "scripts/qcm/*.test.mjs"',
    'run: node scripts/qcm/run-with-evidence.mjs --out "$RUNNER_TEMP/e.json" --test-timeout=600000 "scripts/qcm/*.test.mjs"',
  );
  const r = run(['--plan', '--workflow', fixtureFile(wrapped), '--python', '/py']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(planLines(r).at(-1), 'node scripts/qcm/run-with-evidence.mjs --out "$RUNNER_TEMP/e.json" --test-timeout=600000 "scripts/qcm/*.test.mjs"');
  assert.match(readFileSync(SCRIPT, 'utf8'), /export RUNNER_TEMP="\$\{RUNNER_TEMP:-\$LOG_DIR\}"/);
});

test('(c) --python is substituted into every python line', () => {
  const r = run(['--plan', '--python', '/some/python']);
  const py = planLines(r).filter((l) => l.includes('scripts/') && /python/.test(l.split(' ')[0]));
  assert.ok(py.length > 10);
  for (const l of py) assert.ok(l.startsWith('/some/python '), l);
  assert.ok(!r.stdout.includes('venv/bin/python3'));
});

test('--plan applies VERIFY_PYTEST_PREFIX to python lines and --lock to the node line', () => {
  const r = run(['--plan', '--workflow', fixtureFile(), '--python', '/py', '--lock', '/l.lock'], { VERIFY_PYTEST_PREFIX: 'slot --' });
  const got = planLines(r);
  assert.equal(got[2], 'slot -- /py scripts/ok_one.py --flag');
  assert.equal(got[0], 'npm run build:css');
  assert.equal(got.at(-1), 'flock -w 3600 /l.lock node --test --test-timeout=600000 "scripts/qcm/*.test.mjs"');
});

test('a workflow with no python lines or no node line is an error, not an empty plan', () => {
  const r = run(['--plan', '--workflow', fixtureFile('jobs:\n  j:\n    steps:\n      - run: echo hi\n')]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no .* found/i);
});

test('(d) execution runs every step, exits non-zero, and names the failing one', () => {
  const dir = tmp();
  const stub = join(dir, 'py');
  // Exits 1 when any argument names fail_*, and records each script it saw.
  writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${dir}/seen"\ncase "$*" in *fail_*) exit 1;; esac\nexit 0\n`);
  chmodSync(stub, 0o755);
  // A real (tiny) node --test file: it passes only if CHROME_PATH reached it, defaulted from the workflow's env: block.
  const chromeTest = join(dir, 'chrome.test.mjs');
  writeFileSync(chromeTest, `import { test } from 'node:test'; import assert from 'node:assert/strict';
test('chrome path', () => assert.equal(process.env.CHROME_PATH, '/x/chrome'));\n`);
  const wf = fixtureFile(FIXTURE.replace('"scripts/qcm/*.test.mjs"', chromeTest));
  const logDir = join(dir, 'logs');
  const r = run(['--workflow', wf, '--python', stub, '--skip-build', '--log-dir', logDir]);
  assert.notEqual(r.status, 0, r.stdout);
  const seen = readFileSync(join(dir, 'seen'), 'utf8');
  assert.match(seen, /ok_one/);
  assert.match(seen, /test_two/);
  assert.match(seen, /fail_three/, 'a failure must not stop the remaining python lines');
  assert.match(r.stdout, /FAIL\s+exit 1\s+python: scripts\/fail_three\.py/);
  assert.match(r.stdout, /PASS\s+exit 0\s+node --test/, 'node step still ran, CHROME_PATH defaulted from the workflow env');
  assert.match(r.stdout, /PASS\s+exit 0\s+python: scripts\/ok_one\.py/);
});

test('(d) all steps passing exits 0; a failing build step is named and fails', () => {
  const dir = tmp();
  const passTest = join(dir, 'pass.test.mjs');
  writeFileSync(passTest, "import { test } from 'node:test'; test('ok', () => {});\n");
  const ok = fixtureFile(FIXTURE.replace('venv/bin/python3 scripts/fail_three.py', 'venv/bin/python3 scripts/fine.py')
    .replace('"scripts/qcm/*.test.mjs"', passTest));
  const stub = join(dir, 'py');
  writeFileSync(stub, '#!/bin/sh\nexit 0\n');
  chmodSync(stub, 0o755);
  const good = run(['--workflow', ok, '--python', stub, '--skip-build', '--log-dir', join(dir, 'l1')]);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  // Without --skip-build the fixture's `npm run build:css` / hugo lines run for real in the repo root;
  // point the workflow at a failing build instead, so nothing heavy runs.
  const badBuild = fixtureFile(FIXTURE.replace('npm run build:css', 'false').replace('bash scripts/build-site.sh --configDir site-config --minify', 'true'));
  const bad = run(['--workflow', badBuild, '--python', stub, '--log-dir', join(dir, 'l2')]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout + bad.stderr, /build:css|build css/i);
});

test('a failed step prints the tail of its own log, so a CI run whose temp dir is gone still says why', () => {
  const dir = tmp();
  const stub = join(dir, 'py');
  // fail_three prints 60 numbered lines and a reason, then fails; every other line passes quietly.
  writeFileSync(stub, `#!/bin/sh\ncase "$*" in *fail_*) i=1; while [ $i -le 60 ]; do echo "noise $i"; i=$((i+1)); done; echo "REASON: fixture said no" >&2; exit 1;; esac\nexit 0\n`);
  chmodSync(stub, 0o755);
  const passTest = join(dir, 'pass.test.mjs');
  writeFileSync(passTest, "import { test } from 'node:test'; test('ok', () => {});\n");
  const wf = fixtureFile(FIXTURE.replace('"scripts/qcm/*.test.mjs"', passTest));
  const r = run(['--workflow', wf, '--python', stub, '--skip-build', '--log-dir', join(dir, 'logs')]);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stdout, /REASON: fixture said no/, 'the failing step\'s own message is not in the summary');
  assert.match(r.stdout, /noise 60/, 'the end of the failing log is shown');
  assert.doesNotMatch(r.stdout, /noise 1\n/, 'only the tail is shown, not the whole log');
  // A passing step's log stays out of the summary.
  assert.doesNotMatch(r.stdout, /# pass 1/, 'a passing step printed its log');
});

test('a missing interpreter fails at run time with a message, not in --plan', () => {
  const r = run(['--workflow', fixtureFile(), '--skip-build', '--python', '/nonexistent/python']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /python/i);
});
