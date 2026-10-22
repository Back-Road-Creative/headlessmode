// A failed Chromium launch must fail its test file promptly, and the launch must not
// depend on the runner's environment.
//
// PR CI job 108940330679 (2026-09-28): after a WSL restart /run/user/1002 no longer
// existed, Chromium died on "mkdir: cannot create directory '/run/user/1002': Permission
// denied", and the files that launch it ran on to the 600 s --test-timeout instead of
// failing at once. Two causes, one proof each below:
//  - the launch inherited XDG_RUNTIME_DIR, so the environment could break it; it now
//    gets a directory inside its own throwaway profile.
//  - a suite's `withMap` starts a static server, THEN launches; a launch that throws
//    never reaches the `finally` that closes the server, and a listening server keeps
//    the test file's process alive until the timeout. The server no longer holds the
//    process open, and a spawn that cannot even start rejects instead of crashing.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './helpers/browser.mjs';

const HELPERS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers');

// Every "browser" here is a shell script, never a real Chromium, so it takes its slot
// from a pool of its own. On the box-wide pool a busy runner starved these launches
// ("no free browser slot ... after 5000 ms", #608 CI) before the error under test ran.
const SLOTS = mkdtempSync(path.join(tmpdir(), 'qcm-launch-failure-slots-'));
process.env.QCM_BROWSER_SLOT_DIR = SLOTS;
after(() => rmSync(SLOTS, { recursive: true, force: true }));

function scratch(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'qcm-launch-failure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A "browser" that records what it was started with, then dies like the CI one did. */
function dyingBrowser(dir) {
  const bin = path.join(dir, 'chromium');
  writeFileSync(bin, `#!/bin/sh
{ echo "xdg=$XDG_RUNTIME_DIR"; [ -d "$XDG_RUNTIME_DIR" ] && echo present; stat -c 'mode=%a' "$XDG_RUNTIME_DIR"; } > "${dir}/seen" 2>&1
echo "mkdir: cannot create directory '/run/user/1002': Permission denied" >&2
exit 1
`);
  chmodSync(bin, 0o755);
  return bin;
}

test('the browser gets its own runtime dir, so an unwritable XDG_RUNTIME_DIR cannot break the launch', async (t) => {
  const dir = scratch(t);
  const saved = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = '/nonexistent/dir-1002';
  t.after(() => { if (saved === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = saved; });
  await assert.rejects(() => launch(dyingBrowser(dir), 'about:blank', { launchTimeoutMs: 5000, slotWaitMs: 5000 }), /no DevTools port/);
  const seen = readFileSync(path.join(dir, 'seen'), 'utf8');
  assert.doesNotMatch(seen, /nonexistent/, `the browser inherited the runner's XDG_RUNTIME_DIR: ${seen}`);
  assert.match(seen, /present/, `the runtime dir did not exist when the browser started: ${seen}`);
  assert.match(seen, /mode=700/, `Chromium refuses a runtime dir that is not 0700: ${seen}`);
  assert.match(seen, /qcm-chrome/, `the runtime dir is not inside the throwaway profile root: ${seen}`);
});

test('a failed launch frees its slot, and a sibling launch in the same file goes on to run', async (t) => {
  const dir = scratch(t);
  const slots = path.join(dir, 'slots');
  const savedDir = process.env.QCM_BROWSER_SLOT_DIR, savedN = process.env.QCM_BROWSER_SLOTS;
  process.env.QCM_BROWSER_SLOT_DIR = slots;
  process.env.QCM_BROWSER_SLOTS = '1';
  t.after(() => {
    for (const [k, v] of [['QCM_BROWSER_SLOT_DIR', savedDir], ['QCM_BROWSER_SLOTS', savedN]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  const bin = dyingBrowser(dir);
  const started = performance.now();
  for (let i = 0; i < 2; i++) {
    // With ONE slot, the second launch can only reach the browser if the first freed it.
    await assert.rejects(() => launch(bin, 'about:blank', { launchTimeoutMs: 5000, slotWaitMs: 3000 }),
      /no DevTools port/, `launch ${i + 1} did not fail on the browser itself`);
  }
  assert.deepEqual(readdirSync(slots), [], 'a failed launch left its slot file behind');
  assert.ok(performance.now() - started < 10000, 'a dead browser was not reported promptly');
});

test('a binary that cannot be started rejects at once instead of crashing or waiting out the budget', async (t) => {
  const started = performance.now();
  await assert.rejects(
    () => launch(path.join(scratch(t), 'no-such-chromium'), 'about:blank', { launchTimeoutMs: 20000, slotWaitMs: 5000 }),
    /ENOENT|could not start/,
  );
  assert.ok(performance.now() - started < 5000, 'launch() sat out its startup budget on a binary that never started');
});

test('a static server nobody closed does not keep the test file alive', (t) => {
  const dir = scratch(t);
  const script = path.join(dir, 'leak.mjs');
  writeFileSync(script, `import { startSiteServer } from ${JSON.stringify(path.join(HELPERS, 'site-server.mjs'))};
await startSiteServer();
console.log('started');
`);
  const r = spawnSync(process.execPath, [script], { timeout: 8000, encoding: 'utf8' });
  assert.equal(r.error, undefined, `the process was still running after its script finished: ${r.error?.message}`);
  assert.match(r.stdout, /started/);
});
