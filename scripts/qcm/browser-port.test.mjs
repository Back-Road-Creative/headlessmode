// The DevTools endpoint a launched browser is driven through must belong to that
// browser's OWN child process.
//
// It did not. `launch()` used to pick a port by binding :0, reading the number and
// CLOSING the socket, then spawn Chromium on that number tens of milliseconds later.
// Nothing held the port across the gap. `node --test` runs the browser-launching test
// files as parallel processes, so under load two of them were handed the same number:
// one Chromium won the bind, the other printed `bind() failed: Address already in use
// (98)` and STAYED ALIVE, and the loser's `launch()` then read the WINNER's target list
// off that port and drove someone else's browser. In CI that showed up as
// field-zoom.test.mjs reading the map key at a zoom find-and-scale.test.mjs had set,
// and as `Runtime.evaluate timed out after 120000 ms` in two more tests of the same run
// — green locally on the identical SHA.
//
// Reproducing that by launching two browsers and hoping they collide would be a flaky
// test about a race. This one is deterministic: a decoy browser OWNS the port that a
// pre-spawn chooser hands out, so any implementation that picks a port before spawning
// lands on the stranger and is caught every time. The fix is to let Chromium bind the
// port itself (`--remote-debugging-port=0`) and read back what it bound, which leaves
// no gap for this test — or a parallel CI run — to exploit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findChromium, freePort, launch, OFFLINE_ARGS, removeProfile } from './helpers/browser.mjs';

const CHROMIUM = findChromium();
const skip = CHROMIUM ? false : 'no Chromium on this box (set CHROME_PATH to run this proof)';

/** The stranger. Its user agent is browser-level, so it identifies which BROWSER a page
 *  is running in even after the victim navigates that page to its own URL — which is
 *  exactly what the losing `launch()` did. */
const DECOY_UA = 'QCM-DECOY-BROWSER';

async function startDecoy(port) {
  const profile = mkdtempSync(path.join(tmpdir(), 'qcm-decoy-'));
  const child = spawn(CHROMIUM, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
    `--user-agent=${DECOY_UA}`, ...OFFLINE_ARGS, `--remote-debugging-port=${port}`, 'about:blank',
  ], { stdio: 'ignore' });
  const close = () => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    removeProfile(profile);
  };
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    try { if ((await (await fetch(`http://127.0.0.1:${port}/json`)).json()).length) return close; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  close();
  throw new Error(`the decoy never listened on ${port}`);
}

/** Makes every pre-spawn port chooser inside browser.mjs hand out the decoy's port.
 *  `browser.mjs` does `import net from 'node:net'`, and a builtin's default export IS
 *  the shared module object, so this reaches it. After the fix nothing consults it. */
function serveOnly(port) {
  const real = net.createServer;
  net.createServer = () => ({
    on() {}, address: () => ({ port }),
    listen(_p, _h, cb) { cb(); }, close(cb) { cb(); },
  });
  return () => { net.createServer = real; };
}

test('a launched browser is driven through its own port, not a stranger who owns the one picked for it', { skip }, async (t) => {
  const decoyPort = await freePort();
  const stopDecoy = await startDecoy(decoyPort);
  t.after(stopDecoy);
  const restoreNet = serveOnly(decoyPort);
  t.after(restoreNet);

  const browser = await launch(CHROMIUM, 'data:text/html,<title>victim</title>');
  t.after(() => browser.close());

  const ua = await browser.evaluate('navigator.userAgent');
  assert.ok(!ua.includes(DECOY_UA),
    `launch() attached to the decoy on port ${decoyPort} and is driving its browser (user agent ${ua})`);
  assert.notEqual(browser.port, decoyPort,
    `launch() connected to ${decoyPort}, the port the decoy already owned`);
});

// A page that never finishes loading must FAIL the launch, not hang it.
//
// Every wait in `launch()` had a deadline except one. `boundPort` gives up after 30 s,
// `waitForJson` after 30 s, and every `send()` carries `timeoutMs` — but the
// `await once('Page.loadEventFired')` between them had neither a timer nor any handling
// of the socket going away, so when the load event never came that promise never
// settled. `node --test` has no per-file timeout, so the whole run sat there until
// something outside killed it.
//
// Measured: PR #498's CI job hung 29 minutes in this spot and was cancelled from the
// outside, which read as a red PR and suspended the merge robot; the three green runs
// either side of it did the same step in 70-87 s. Fourteen test files here drive a
// browser through this helper, so any one of them can take the whole suite down.
//
// The stall has to be in a SUBRESOURCE, not the document: a document that never answers
// is already caught, because `Page.navigate` carries the `send()` deadline and rejects
// on its own. `load` is what waits for the whole page, so the document is served at
// once and the stylesheet it asks for is accepted and then left unanswered — navigation
// commits, `Page.navigate` resolves, and the load event never fires.
test('a page whose subresource never answers fails the launch instead of hanging it', { skip }, async (t) => {
  const held = [];
  const site = http.createServer((req, res) => {
    if (req.url === '/slow.css') { held.push(res); return; } // accepted, never answered
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>stall</title><link rel="stylesheet" href="/slow.css">');
  });
  const port = await freePort();
  await new Promise((r) => site.listen(port, '127.0.0.1', r));
  t.after(() => new Promise((r) => { held.forEach((res) => res.destroy()); site.close(r); }));

  // The clock leaves out the wait for a box-wide browser slot (browser-slots.mjs). That
  // wait belongs to whoever else is running Chromium, not to this page: on #621's CI run
  // 36584044204 four local test browsers held every slot and this launch took 137 s to
  // give up, with the 3 s load deadline working as it should. A private slot held by a
  // live `sleep 70` reproduces it (79 s) on the unchanged helper.
  let slotWaitMs;
  const started = performance.now();
  await assert.rejects(
    () => launch(CHROMIUM, `http://127.0.0.1:${port}/`, { timeoutMs: 3000 }),
    (err) => { slotWaitMs = err.slotWaitMs; return /never fired|timed out|closed/i.test(err.message); },
    'launch() resolved or hung on a page that never finishes loading',
  );
  assert.equal(typeof slotWaitMs, 'number', 'launch() must report its browser-slot wait on the error it throws');
  const waited = Math.round(performance.now() - started - slotWaitMs);
  assert.ok(waited < 60000, `launch() took ${waited} ms past its slot wait to give up; it must fail fast, not hang the run`);
});
