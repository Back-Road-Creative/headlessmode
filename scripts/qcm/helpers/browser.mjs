// A headless Chromium driven over the DevTools protocol with Node built-ins only.
//
// Same technique scripts/preview-overflow.mjs already uses here: Node 22's built-in
// fetch + WebSocket, no puppeteer, no Playwright. puppeteer is deliberately NOT a
// dependency of this repo (package.json carries pa11y-ci and tailwindcss); adding one
// to run a test would be a heavier change than the test.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { acquireBrowserSlot } from './browser-slots.mjs';

const CANDIDATES = ['/snap/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'];

/** True when a missing browser (or a missing build) must FAIL the run rather than skip it:
 *  under CI -- GitHub Actions sets CI to exactly 'true' -- or when a developer opts in with
 *  QCM_REQUIRE_BROWSER=1 to rehearse CI locally. About sixty test files turn a null
 *  findChromium() into a `skip`, and node --test counts a skip as neither pass nor fail, so a
 *  runner that lost its browser went green with the browser proofs not run (QQA-01). */
export const browserRequired = (env = process.env) => env.CI === 'true' || env.QCM_REQUIRE_BROWSER === '1';

/** The pure rule behind findChromium, with its inputs passed in so it can be tested.
 *  Not required: the named CHROME_PATH / PUPPETEER_EXECUTABLE_PATH if it exists, else the
 *  first candidate on disk, else null -- a developer without Chromium still runs the pure
 *  tests. Required: the same search, but a named path that is not on disk throws naming it
 *  (a typo'd or stale CHROME_PATH must not quietly fall through to some other browser),
 *  and finding nothing throws saying how to supply one. */
export function resolveChromium({ env = process.env, candidates = CANDIDATES, exists = existsSync } = {}) {
  const required = browserRequired(env);
  const via = env.CHROME_PATH ? 'CHROME_PATH' : env.PUPPETEER_EXECUTABLE_PATH ? 'PUPPETEER_EXECUTABLE_PATH' : null;
  const named = via ? env[via] : null;
  if (named && exists(named)) return named;
  if (named && required) {
    throw new Error(`${via} names ${named}, which does not exist. This run requires a browser `
      + `(CI=true or QCM_REQUIRE_BROWSER=1), so it will not fall back to another one or skip: `
      + `point ${via} at a Chromium that is installed.`);
  }
  const found = candidates.find((p) => exists(p)) ?? null;
  if (found === null && required) {
    throw new Error(`No Chromium found, and CI requires one (CI=true or QCM_REQUIRE_BROWSER=1): the browser tests `
      + `would otherwise be skipped and the run would go green without them. Looked in ${candidates.join(', ')}. `
      + `Install Chromium or set CHROME_PATH to its executable.`);
  }
  return found;
}

/** The Chromium CI already points pa11y at, or the first one on disk; null when none and the
 *  run does not require one (see resolveChromium for when it throws instead). */
export const findChromium = () => resolveChromium();

/** A port for a server this process is about to start and keep. NOT for handing to a
 *  child: the socket is closed before this resolves, so between here and the child's
 *  bind the number belongs to nobody -- see the header of browser-port.test.mjs. */
export const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/** An origin a navigation is REFUSED at, for proofs that a failed navigation rejects at once.
 *  Not a freePort() number: that is free only until something binds it, and a launch()'s own
 *  `--remote-debugging-port=0` can land on exactly it (PR CI run 37496887896 did), after which
 *  the "closed" port answers. Port 2 is privileged: nothing on the box listens there and no
 *  non-root process can start to, so the refusal cannot go stale mid-test. Not port 1: that is
 *  on Chromium's restricted list and fails as ERR_UNSAFE_PORT before any connection is tried. */
export const REFUSED_ORIGIN = 'http://127.0.0.1:2';

/** One place every throwaway Chromium profile lives, so a leaked one is easy to find
 *  and nothing lands loose in the home directory itself. */
const PROFILE_ROOT = path.join(homedir(), '.cache', 'qcm-chrome');

// Monotonic, for the same reason as removeProfile's deadline below.
const deadline = (ms) => { const end = performance.now() + ms; return () => performance.now() < end; };

/** The port Chromium itself bound, read from the file it writes once it is listening.
 *  First line is the port, second the browser's websocket path; requiring that newline
 *  is what keeps a half-written file from being read as a truncated number. */
export async function boundPort(profile, child, stderr, timeoutMs) {
  const file = path.join(profile, 'DevToolsActivePort');
  const running = deadline(timeoutMs);
  // `pid` is undefined when the spawn itself failed (no such binary): nothing will ever
  // write the file, so waiting out the budget would only delay the error.
  while (running() && child.exitCode === null && child.pid !== undefined) {
    try {
      const text = readFileSync(file, 'utf8'), nl = text.indexOf('\n');
      if (nl > 0) return Number(text.slice(0, nl));
    } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 25)); // let a pending 'error'/'data' event land in stderr
  throw new Error(`Chromium reported no DevTools port within ${timeoutMs} ms: ${stderr().slice(0, 400)}`);
}

async function waitForJson(url, timeoutMs) {
  const running = deadline(timeoutMs);
  let last = null;
  while (running()) {
    try { return await (await fetch(url)).json(); } catch (err) { last = err; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} never answered within ${timeoutMs} ms: ${last?.message ?? 'unknown'}`);
}

/** Removes a launched browser's profile directory, and never throws. The process-group
 *  SIGKILL that precedes this is asynchronous: for some tens of milliseconds a renderer
 *  is still flushing `Default/Cache/Cache_Data`, and a single-pass recursive removal
 *  that walks into that directory meets a file it did not list and throws ENOTEMPTY
 *  (CI run 36267536043 on #572, at the end of a test whose own assertions had passed;
 *  the throw came out of `page.close()` before the test's `site.close()`, so the file
 *  then sat until its 600 s timeout). So the removal is repeated until the directory is
 *  gone or two seconds have passed -- an explicit loop, because rmSync's own
 *  `maxRetries` did not outlive a 400 ms writer on Node 22 in the test below. Whatever
 *  is still there after that is a scratch directory under ~/.cache/qcm-chrome, which is
 *  a disk-hygiene matter and never a test's verdict. The deadline runs on
 *  `performance.now()`, not the wall clock: the WSL2 box the runners share steps
 *  `Date.now()` when it resyncs with the host, and on #623's CI run 36536254857 that
 *  ended the loop after 222 ms.
 *  browser-profile-teardown.test.mjs holds this to all three properties. */
export function removeProfile(profile, { deadlineMs = 2000, stepMs = 50 } = {}) {
  const end = performance.now() + deadlineMs;
  let last;
  for (;;) {
    try { rmSync(profile, { recursive: true, force: true }); return; } catch (err) { last = err; }
    if (performance.now() >= end) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stepMs);
  }
  process.emitWarning(`browser profile ${profile} not removed: ${last.code ?? last.message}`);
}

/** How long a just-started Chromium gets to write DevToolsActivePort and answer /json
 *  before the launch is a failure. It was a hardcoded 30 s while every protocol step
 *  after it had 120 s; three runners share this box, and on PR CI run 36426104056 two
 *  launches took longer than 30 s to come up under that load and failed tests whose
 *  assertions never ran. Same budget as the protocol deadline now, and a caller can set
 *  it on its own (`launchTimeoutMs`) -- browser-launch-wait.test.mjs holds both. */
export const DEFAULT_LAUNCH_TIMEOUT_MS = 120000;
/** launch()'s per-command protocol deadline; files that open their own DevTools client use it too. */
export const DEFAULT_PROTOCOL_TIMEOUT_MS = 120000;

/** The flags that keep a test browser on this box: every host but 127.0.0.1 is
 *  unresolvable, and no proxy is used -- Chromium on Linux takes one from `http_proxy` in
 *  its environment, and a request handed to a proxy never resolves its own host here. The
 *  dashboard starts its USGS base tiles before its load event, which waits for them, so
 *  without these every navigation to it waited on the internet. `launch()` passes them; a
 *  test file that starts its own Chromium passes them too, and browser-offline.test.mjs
 *  fails one that does not. */
export const OFFLINE_ARGS = Object.freeze([
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--no-proxy-server',
]);

/** The name of the record launch() keeps on every document its page loads,
 *  `{ errors, more, listFull }`. `errors` holds the first five things the page threw,
 *  or rejected with no handler for, each with where it came from, and `more` counts
 *  the rest; `listFull` says the browser's list of the page's requests (its
 *  resource-timing buffer) filled up, so a failed request may be missing from it. The
 *  record is made before the page's own scripts run, is not enumerable, and prevents
 *  nothing: the console still gets every error. waits.mjs reads it when a wait runs
 *  out (PAGE_STATE). */
export const PAGE_RECORD = '__qcPageRecord';

const RECORDER_SRC = `(() => {
  try {
    const name = ${JSON.stringify(PAGE_RECORD)};
    if (Object.prototype.hasOwnProperty.call(window, name)) return;
    const record = { errors: [], more: 0, listFull: false };
    Object.defineProperty(window, name, { value: record });
    const note = (text) => {
      if (record.errors.length < 5) record.errors.push(String(text).slice(0, 200));
      else record.more += 1;
    };
    const where = (file, line) => {
      if (!file) return '';
      if (file === location.href) return ' (in the page itself, line ' + line + ')';
      let shown = file;
      try { const u = new URL(file); if (u.origin !== 'null' && u.origin === location.origin) shown = u.pathname; } catch {}
      return ' (' + shown + ':' + line + ')';
    };
    addEventListener('error', (e) => { if (e instanceof ErrorEvent) note(e.message + where(e.filename, e.lineno)); }, true);
    addEventListener('unhandledrejection', (e) => {
      let why;
      try { why = String(e.reason); } catch { why = '(a reason that cannot be printed)'; }
      note('Uncaught (in promise) ' + why);
    });
    performance.addEventListener('resourcetimingbufferfull', () => { record.listFull = true; });
  } catch {}
})()`;

/** Navigates a DevTools page session to `target` and waits up to `loadMs` for its load
 *  event, through that session's `send(method, params)` and `once(method, ms)`. Every
 *  navigation a test here drives goes through this: launch()'s `navigate`, and the test
 *  files that open their own session (dashboard-load-failure.test.mjs holds that).
 *  A navigation Chromium could not complete REJECTS, naming Chromium's reason
 *  (`net::ERR_CONNECTION_REFUSED` and the like). It used to resolve: Chromium's error
 *  page fires a load event like any page, and the caller then spent a whole wait on
 *  a tab that was never going to be its page. The error page's own load is waited
 *  out before rejecting, because a load still to come would settle the NEXT
 *  navigation's wait before that page had loaded. ERR_ABORTED (a 204, a download)
 *  commits nothing and no load follows it, so that wait is cancelled where `once`
 *  can cancel, and never awaited. The 120 s default is launch()'s protocol deadline.
 *  With CI runners sharing the box, the dashboard's load event took over 30 s five
 *  times across three suites on 2026-09-27 ('never fired within 30000 ms'), each time
 *  before the test had asserted anything; camera-requests.test.mjs's own navigate
 *  still waited only 30 s after terrain-panel.test.mjs's had been raised.
 *  dashboard-load-failure.test.mjs holds all of it. */
export async function navigatePage(send, once, target, loadMs = 120000) {
  const loaded = once('Page.loadEventFired', loadMs);
  // If the navigate itself fails first, this one still settles later; give it a
  // handler now so it cannot surface as an unhandled rejection.
  loaded.catch(() => {});
  const { errorText } = await send('Page.navigate', { url: target });
  if (!errorText) { await loaded; return; }
  if (errorText === 'net::ERR_ABORTED') loaded.cancel?.();
  else await loaded.catch(() => {});
  throw new Error(`navigation to ${target} failed: ${errorText}`);
}

/** Starts headless Chromium and returns { evaluate, send, port, setViewport, navigate,
 *  close }. `evaluate` runs an async expression in the page and resolves its value,
 *  throwing on a page-side exception; `port` is the DevTools port this browser bound for
 *  itself. `timeoutMs` bounds every protocol call once the browser is up;
 *  `launchTimeoutMs` bounds the startup itself and is separate so a short protocol
 *  deadline (browser-port.test.mjs uses 3 s to prove a stalled page fails fast) does not
 *  also shrink the startup one.
 *  Before anything is spawned the launch takes one of the box-wide browser slots
 *  (browser-slots.mjs; `slotWaitMs` bounds that wait) and holds it until `close`: the
 *  sum of Chromiums across every job and session on the box is what the slots bound,
 *  and a launch that skipped them would be the one that breaks the bound. An error
 *  thrown once the slot is held carries `slotWaitMs`, how long that wait took, so a
 *  caller timing the launch can leave out time spent on other jobs' browsers. The browser
 *  takes OFFLINE_ARGS, so nothing a page loads leaves this box (browser-offline.test.mjs).
 *  A navigation Chromium could not complete rejects with Chromium's own reason, the first
 *  one included, so launch() itself does (`navigate`); and every document the page loads
 *  keeps a PAGE_RECORD of what it threw. */
export async function launch(binary, url, {
  timeoutMs = DEFAULT_PROTOCOL_TIMEOUT_MS, launchTimeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS, args = [], viewport = null,
  slotWaitMs = undefined,
} = {}) {
  const asked = performance.now();
  const releaseSlot = await acquireBrowserSlot(slotWaitMs === undefined ? {} : { waitMs: slotWaitMs });
  const waitedForSlot = performance.now() - asked;
  // Under $HOME, not /tmp: snap chromium gets a private /tmp namespace, so a profile
  // there is real to the browser and invisible to us -- and DevToolsActivePort with it.
  // scripts/preview-shots.sh stages its probe profile in $HOME for the same reason.
  let profile, runtimeDir;
  try {
    mkdirSync(PROFILE_ROOT, { recursive: true });
    profile = mkdtempSync(path.join(PROFILE_ROOT, 'profile-'));
    // Chromium wants a 0700 runtime dir and, when XDG_RUNTIME_DIR names one that is
    // missing or unwritable (/run/user/1002 after a WSL restart, PR CI job
    // 108940330679), dies at startup on the mkdir. The browser gets one inside its own
    // throwaway profile instead, so the runner's environment cannot break a launch;
    // removeProfile takes it away with the profile.
    runtimeDir = path.join(profile, 'xdg-runtime');
    mkdirSync(runtimeDir, { mode: 0o700 });
  } catch (err) {
    if (profile) removeProfile(profile);
    releaseSlot();
    if (err instanceof Error) err.slotWaitMs = waitedForSlot;
    throw err;
  }
  // Its own process group, so cleanup can kill the renderers and zygote too: a survivor
  // recreates the profile directory the moment rmSync has removed it.
  const child = spawn(binary, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
    ...OFFLINE_ARGS, ...args,
    // Port 0: Chromium binds it itself and there is no window in which the number
    // belongs to nobody, so a parallel test file cannot be handed the same one.
    '--remote-debugging-port=0', 'about:blank',
  ], {
    stdio: ['ignore', 'ignore', 'pipe'], detached: true,
    env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir },
  });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b; });
  // A binary that cannot start emits 'error'; with no listener that is an uncaught
  // exception that takes the whole test process down. Record it as the launch's stderr.
  child.on('error', (err) => { stderr += `could not start ${binary}: ${err.message}`; });

  const cleanup = () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    removeProfile(profile);
    releaseSlot();
  };

  try {
    const port = await boundPort(profile, child, () => stderr, launchTimeoutMs);
    const targets = await waitForJson(`http://127.0.0.1:${port}/json`, launchTimeoutMs);
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error(`no page target among ${targets.length}: ${stderr.slice(0, 400)}`);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`devtools socket failed: ${stderr.slice(0, 400)}`)), { once: true });
    });

    let id = 0;
    const pending = new Map();
    const events = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method && events.has(m.method)) { events.get(m.method)(null); events.delete(m.method); }
    });
    // A socket that goes away settles everything still waiting on it. Without this a
    // browser that dies mid-drive leaves its waiters pending, and an event waiter with
    // no deadline pends forever -- `node --test` has no per-file timeout, so that is
    // the whole run hung until something outside kills it.
    ws.addEventListener('close', () => {
      const why = `devtools socket closed: ${stderr.slice(0, 400)}`;
      for (const [mine, settle] of pending) settle({ id: mine, error: { message: why } });
      pending.clear();
      for (const settle of events.values()) settle(new Error(why));
      events.clear();
    });
    /** Waits for one protocol event under the same deadline every `send()` carries. An
     *  event that never fires is a failed test, never a hung run. `cancel()` settles the
     *  wait at once, for a caller that has learned the event is not coming. */
    const once = (method, ms = timeoutMs) => {
      let settle;
      const fired = new Promise((resolve, reject) => {
        const timer = setTimeout(() => settle(new Error(`${method} never fired within ${ms} ms`)), ms);
        settle = (err) => {
          clearTimeout(timer);
          if (events.get(method) === settle) events.delete(method);
          err ? reject(err) : resolve();
        };
      });
      events.set(method, settle);
      fired.cancel = () => settle(new Error(`${method} wait cancelled`));
      return fired;
    };
    const send = (method, params) => new Promise((resolve, reject) => {
      const mine = ++id;
      const timer = setTimeout(() => { pending.delete(mine); reject(new Error(`${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
      pending.set(mine, (m) => { clearTimeout(timer); m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result); });
      ws.send(JSON.stringify({ id: mine, method, params }));
    });

    // Chromium is started on about:blank and navigated here: passing the URL on the
    // command line makes the page navigate AFTER the socket attaches, which destroys
    // the execution context out from under the first evaluate.
    await send('Page.enable');
    // Every document this page loads keeps a record of what it threw, made before its own
    // scripts run; a wait that runs out reads it (PAGE_RECORD, PAGE_STATE in waits.mjs).
    await send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER_SRC });
    // --window-size cannot be trusted for narrow widths: headless Chromium clamps the
    // window to a 500px minimum, so a 390px phone measures 500 CSS pixels and every
    // overflow at phone width silently disappears. Emulation.setDeviceMetricsOverride
    // is what actually sets the viewport -- the same call scripts/preview-overflow.mjs
    // makes for the same reason.
    /** Sets the viewport on the ALREADY-RUNNING browser via the DevTools protocol --
     *  no relaunch needed. Exposed so a caller that wants several viewports (e.g. a
     *  layout suite covering four breakpoints) can reuse one Chromium process instead
     *  of starting a new one per viewport. */
    const setViewport = async (vp) => {
      await send('Emulation.setDeviceMetricsOverride', {
        width: vp.width, height: vp.height,
        deviceScaleFactor: 1, mobile: Boolean(vp.mobile),
      });
    };
    if (viewport) await setViewport(viewport);

    /** Navigates the SAME page to a new URL (or reloads the current one) and waits for
     *  load, without spawning a new browser. Each call is a fresh document -- any JS
     *  state (open panels, etc.) from a prior navigation is gone -- so a caller can
     *  reuse one page across many independent checks the way a fresh `launch()` per
     *  check used to be used for. A failed navigation rejects (navigatePage). */
    const navigate = (target) => navigatePage(send, once, target, timeoutMs);
    await navigate(url);

    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error(`page threw: ${d.exception?.description ?? d.text}`);
      }
      return r.result.value;
    };
    return {
      evaluate, send, port, setViewport, navigate,
      close: () => { try { ws.close(); } finally { cleanup(); } },
    };
  } catch (err) {
    cleanup();
    if (err instanceof Error) err.slotWaitMs = waitedForSlot;
    throw err;
  }
}
