// How long `launch()` waits for a Chromium it just started to report its DevTools port.
//
// It was a hardcoded 30 s, while every protocol step after it carried the caller's
// `timeoutMs` (120 s by default). Three runners share one box here, and a local suite
// often runs beside them; on PR CI run 36426104056 (#613) two launches took longer than
// 30 s to write DevToolsActivePort and both tests failed on "Chromium reported no
// DevTools port within 30000 ms" -- the assertions never ran. Nothing in the branch
// touched either test. A startup that is slow because the box is busy is not a failed
// test; a startup that never happens still must be, and within a bound.
//
// So the startup wait is its own option, `launchTimeoutMs`, with a default as long as
// the protocol deadline. It is separate from `timeoutMs` because browser-port.test.mjs
// drives a page that never finishes loading with `timeoutMs: 3000` to prove `launch()`
// fails fast; a 3 s startup budget would turn that proof into a load-dependent flake.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_LAUNCH_TIMEOUT_MS, launch } from './helpers/browser.mjs';

// The "browser" below is `sleep`, not Chromium, so it takes its slot from a pool of its
// own: on the box-wide one a busy runner starved it before the startup wait ran (#608).
const SLOTS = mkdtempSync(path.join(tmpdir(), 'qcm-launch-wait-slots-'));
process.env.QCM_BROWSER_SLOT_DIR = SLOTS;
after(() => rmSync(SLOTS, { recursive: true, force: true }));

/** A "browser" that starts, stays up, and never writes DevToolsActivePort. Real
 *  Chromium under load looks exactly like this for the first tens of seconds. */
function silentBrowser(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'qcm-silent-browser-'));
  const bin = path.join(dir, 'chromium');
  writeFileSync(bin, '#!/bin/sh\nexec sleep 30\n');
  chmodSync(bin, 0o755);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return bin;
}

test('the startup wait is the caller\'s launchTimeoutMs, and it is what the failure names', async (t) => {
  // The message proves the 400 ms budget was the one used. The clock only has to tell it
  // apart from the 120 s default, so it is held to half of that, on a monotonic clock:
  // the deploy run 36603029552 took 8.3 s on the loaded box (11.2 s by Date.now(), which
  // steps on WSL2) and failed a 5 s bound on a launch that did give up on time.
  const started = performance.now();
  await assert.rejects(
    () => launch(silentBrowser(t), 'about:blank', { launchTimeoutMs: 400 }),
    /no DevTools port within 400 ms/,
    'launch() did not give up on the port after the launchTimeoutMs it was given',
  );
  const waited = Math.round(performance.now() - started);
  assert.ok(waited < DEFAULT_LAUNCH_TIMEOUT_MS / 2,
    `launch() took ${waited} ms to give up on a 400 ms startup budget; it sat out the default instead`);
});

test('the default startup wait is as long as the protocol deadline, not a shorter hardcoded one', () => {
  // 120000 is launch()'s default `timeoutMs`; the startup budget must not be the odd
  // one out. Asserted on the exported constant because waiting it out would cost the
  // suite two minutes to learn the same thing.
  assert.ok(DEFAULT_LAUNCH_TIMEOUT_MS >= 120000,
    `default startup wait is ${DEFAULT_LAUNCH_TIMEOUT_MS} ms; a busy box needs the full protocol deadline`);
});
