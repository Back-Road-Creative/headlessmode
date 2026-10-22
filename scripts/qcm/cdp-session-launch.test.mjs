// connectSession() must start Chromium the way launch() does (helpers/browser.mjs).
//
// It spawned its own browser with a hardcoded 30 s wait for DevToolsActivePort and no
// private runtime dir. At host load ~60 four cases of terrain-relief-browser's sibling
// proofs failed with "Chromium reported no DevTools port: " (empty stderr) or "mkdir:
// cannot create directory '/run/user/1002': Permission denied" -- the two failures
// browser-launch-wait.test.mjs and browser-launch-failure.test.mjs were written for,
// fixed in launch() and never in this copy. These hold connectSession to the same two
// properties with a shell script standing in for Chromium.
//
// terrain-panel.test.mjs and camera-requests.test.mjs still carry their own copies of
// the session body; they are not covered here.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_LAUNCH_TIMEOUT_MS } from './helpers/browser.mjs';
import { connectSession } from './helpers/cdp-session.mjs';

// The "browser" is a shell script, so it takes its slot from a pool of its own (#608).
const SLOTS = mkdtempSync(path.join(tmpdir(), 'qcm-cdp-session-slots-'));
process.env.QCM_BROWSER_SLOT_DIR = SLOTS;
after(() => rmSync(SLOTS, { recursive: true, force: true }));

function scratch(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'qcm-cdp-session-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function script(dir, body) {
  const bin = path.join(dir, 'chromium');
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

test('the startup wait is the caller\'s launchTimeoutMs, and it is what the failure names', async (t) => {
  const bin = script(scratch(t), 'exec sleep 30');
  const started = performance.now();
  await assert.rejects(
    () => connectSession({ binary: bin, launchTimeoutMs: 400 }),
    /no DevTools port within 400 ms/,
    'connectSession() did not give up on the port after the launchTimeoutMs it was given',
  );
  const waited = Math.round(performance.now() - started);
  assert.ok(waited < DEFAULT_LAUNCH_TIMEOUT_MS / 2,
    `connectSession() took ${waited} ms to give up on a 400 ms startup budget`);
});

test('with no launchTimeoutMs the failure names the shared default, not a hardcoded 30 s', async (t) => {
  // A browser that exits at once ends the wait early whatever the budget, so the message
  // can be read without sitting out two minutes.
  const bin = script(scratch(t), 'exit 1');
  await assert.rejects(
    () => connectSession({ binary: bin }),
    new RegExp(`no DevTools port within ${DEFAULT_LAUNCH_TIMEOUT_MS} ms`),
  );
});

test('the browser gets its own 0700 runtime dir, so an unwritable XDG_RUNTIME_DIR cannot break it', async (t) => {
  const dir = scratch(t);
  const saved = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = '/nonexistent/dir-1002';
  t.after(() => { if (saved === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = saved; });
  const bin = script(dir, `{ echo "xdg=$XDG_RUNTIME_DIR"; [ -d "$XDG_RUNTIME_DIR" ] && echo present; stat -c 'mode=%a' "$XDG_RUNTIME_DIR"; } > "${dir}/seen" 2>&1
echo "mkdir: cannot create directory '/run/user/1002': Permission denied" >&2
exit 1`);
  await assert.rejects(() => connectSession({ binary: bin, launchTimeoutMs: 5000 }), /no DevTools port/);
  const seen = readFileSync(path.join(dir, 'seen'), 'utf8');
  assert.doesNotMatch(seen, /nonexistent/, `the browser inherited the runner's XDG_RUNTIME_DIR: ${seen}`);
  assert.match(seen, /present/, `the runtime dir did not exist when the browser started: ${seen}`);
  assert.match(seen, /mode=700/, `Chromium refuses a runtime dir that is not 0700: ${seen}`);
  assert.match(seen, /qcm-chrome/, `the runtime dir is not inside the throwaway profile root: ${seen}`);
});

test('a failed session frees its slot, and a binary that cannot start rejects at once', async (t) => {
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
  const bin = script(dir, 'exit 1');
  for (let i = 0; i < 2; i++) {
    await assert.rejects(() => connectSession({ binary: bin, launchTimeoutMs: 5000 }), /no DevTools port/);
  }
  const started = performance.now();
  await assert.rejects(
    () => connectSession({ binary: path.join(dir, 'no-such-chromium'), launchTimeoutMs: 20000 }),
    /ENOENT|could not start/,
  );
  assert.ok(performance.now() - started < 5000, 'connectSession() sat out its startup budget on a binary that never started');
  assert.deepEqual(readdirSync(slots), [], 'a failed session left its slot file behind');
});
