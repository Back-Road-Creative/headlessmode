// Removing a browser's profile directory must never fail the test that used it.
//
// `launch()` kills Chromium's process group with SIGKILL and then removes the profile
// it created under ~/.cache/qcm-chrome. The kill is asynchronous: for a few tens of
// milliseconds a renderer is still flushing `Default/Cache/Cache_Data`, and a plain
// recursive rmSync that walks into that directory finds a file it did not list and
// throws `ENOTEMPTY: directory not empty, rmdir …/Cache_Data`. CI run 36267536043 on
// PR #572 hit exactly that at the end of dashboard-candidates.test.mjs "the town popup
// says which of its numbers belong to the county": the test's own assertions had
// passed, cleanup threw, and because the throw came out of `page.close()` before the
// test's `site.close()` ran, the file then sat until its 600 s timeout. E1's local
// suite saw the same error once. A profile directory is scratch: whether it is gone
// matters to disk hygiene, never to the test's verdict.
//
// This test writes into a directory from another process while removing it, the way a
// dying renderer does, and holds `removeProfile` to two things: it does not throw, and
// it keeps trying long enough that the directory is gone once the writer has stopped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfile } from './helpers/browser.mjs';

// A writer that keeps dropping files into the profile's cache directory for `ms`
// milliseconds — the shape of a renderer still flushing its cache after the browser
// process was killed. It writes into the directory as long as it exists and never
// recreates it: a killed renderer's in-flight writes land in a directory that is
// there, and once it is gone they fail, which is what the process-group SIGKILL in
// `launch()` guarantees (a survivor that could recreate the profile is what that kill
// is for). The race under test is only the one between listing a directory and
// removing it.
const WRITER = `
  const fs = require('node:fs'); const path = require('node:path');
  const [dir, ms] = [process.argv[1], Number(process.argv[2])];
  const cache = path.join(dir, 'Default', 'Cache', 'Cache_Data');
  const until = Date.now() + ms; let n = 0;
  while (Date.now() < until) {
    try { fs.writeFileSync(path.join(cache, 'f' + (n++)), 'x'); } catch {}
  }
`;

test('a profile still being written to by a dying renderer is removed without throwing', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'qcm-teardown-'));
  const profile = path.join(root, 'profile-abc');
  mkdirSync(path.join(profile, 'Default', 'Cache', 'Cache_Data'), { recursive: true });
  const writer = spawn(process.execPath, ['-e', WRITER, profile, '400'], { stdio: 'ignore' });
  try {
    // Let the writer get going before the removal starts, so the race is real.
    await new Promise((r) => setTimeout(r, 50));
    assert.doesNotThrow(() => removeProfile(profile), 'removing the profile threw');
    // The removal is repeated until the directory is gone, so it outlasts the writer's
    // flush — a single pass threw ENOTEMPTY 4 times in 5 against this same writer.
    assert.equal(existsSync(profile), false, 'the profile directory survived the removal');
    await new Promise((resolve) => writer.on('exit', resolve));
  } finally {
    try { writer.kill('SIGKILL'); } catch { /* already exited */ }
    rmSync(root, { recursive: true, force: true });
  }
});

// PR #623's CI run 36536254857 failed the test above with the directory still there
// and a "not removed: ENOTEMPTY" warning after 222 ms, a tenth of the 2 s deadline. The
// loop only gives up when its deadline clock says the time is spent, so that clock
// moved ~2 s in ~0.2 s: `Date.now()` is the wall clock, and the WSL2 box every runner
// shares steps it when it resyncs with the host. The deadline has to be measured on a
// clock that only counts elapsed time. This pins that without a race: the profile
// cannot be removed (its `Default` directory is read-only) until a child process
// restores it 300 ms in, and meanwhile the wall clock jumps an hour forward.
test('a wall-clock jump mid-removal does not cut the retries short', { skip: process.getuid?.() === 0 && 'root ignores the read-only directory' }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'qcm-teardown-'));
  const profile = path.join(root, 'profile-jump');
  const locked = path.join(profile, 'Default');
  mkdirSync(path.join(locked, 'Cache'), { recursive: true });
  chmodSync(locked, 0o555);
  const unlock = spawn(process.execPath, ['-e',
    `setTimeout(() => require('node:fs').chmodSync(process.argv[1], 0o755), 300)`, locked], { stdio: 'ignore' });
  const realNow = Date.now;
  let calls = 0;
  Date.now = () => realNow() + (calls++ > 0 ? 3_600_000 : 0);
  try {
    assert.doesNotThrow(() => removeProfile(profile), 'removing the profile threw');
    assert.equal(existsSync(profile), false, 'a wall-clock jump ended the retries before the deadline');
  } finally {
    Date.now = realNow;
    await new Promise((resolve) => (unlock.exitCode === null ? unlock.on('exit', resolve) : resolve()));
    try { chmodSync(locked, 0o755); } catch { /* already removed */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('a profile that is already gone is not an error either', () => {
  assert.doesNotThrow(() => removeProfile(path.join(tmpdir(), 'qcm-teardown-never-existed')));
});

// camera-requests.test.mjs and terrain-panel.test.mjs open their own DevTools session, so
// they start Chromium without `launch()` -- and each removed its profile with one plain
// rmSync, the exact removal this file exists to replace. PR CI run 37765530647 on #772
// failed "park cameras: no eager requests ..." on `ENOTEMPTY: directory not empty, rmdir
// …/Default/Cache/Cache_Data` after the test's assertions had run. So every profile a
// file in this directory hands Chromium goes back through removeProfile.
test('every Chromium profile a test here creates is removed by removeProfile', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const profiles = [];
  for (const file of readdirSync(here, { recursive: true }).filter((f) => f.endsWith('.mjs'))) {
    if (file === path.join('helpers', 'browser.mjs')) continue; // removeProfile itself
    const src = readFileSync(path.join(here, file), 'utf8');
    for (const m of src.matchAll(/--user-data-dir=\$\{(\w+)\}/g)) {
      const name = m[1];
      profiles.push({
        at: `${file}:${src.slice(0, m.index).split('\n').length}`,
        removed: src.includes(`removeProfile(${name})`),
        plain: new RegExp(`rmSync\\(${name}\\b`).test(src),
      });
    }
  }
  assert.ok(profiles.length > 0, 'the scan found no --user-data-dir in this directory, so it is not finding profiles at all');
  const bad = profiles.filter((p) => !p.removed || p.plain).map((p) => p.at);
  assert.deepEqual(bad, [], `a Chromium profile here is not removed through removeProfile (a plain rmSync throws ENOTEMPTY while a renderer still flushes its cache): ${bad.join(', ')}`);
});
