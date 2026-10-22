// A minimal CDP session with a PERSISTENT event subscription (`on`), which
// helpers/browser.mjs's launch() does not expose: its event model answers each CDP event
// ONCE, and the 3D proofs need every Fetch.requestPaused the page fires. Spawn, profile
// and cleanup mirror launch() (same flags, same PROFILE_ROOT under $HOME, same
// process-group kill) and, like launch(), the session holds one box-wide browser slot
// (browser-slots.mjs) from before the spawn until `close`. The startup wait, the private
// 0700 runtime dir and the spawn-error handling are launch()'s own (boundPort,
// DEFAULT_LAUNCH_TIMEOUT_MS): a hardcoded 30 s here failed PR CI under runner load. Used by
// terrain-relief-browser.test.mjs; terrain-panel.test.mjs and camera-requests.test.mjs
// still carry their own copies of the body below.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  boundPort, DEFAULT_LAUNCH_TIMEOUT_MS, findChromium, navigatePage, OFFLINE_ARGS, removeProfile,
} from './browser.mjs';
import { acquireBrowserSlot } from './browser-slots.mjs';

const CHROMIUM = findChromium();
const PROFILE_ROOT = path.join(homedir(), '.cache', 'qcm-chrome');
const deadline = (ms) => { const end = Date.now() + ms; return () => Date.now() < end; };

export async function connectSession({
  args = [], binary = CHROMIUM, launchTimeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS,
} = {}) {
  const releaseSlot = await acquireBrowserSlot();
  let profile, runtimeDir;
  try {
    mkdirSync(PROFILE_ROOT, { recursive: true });
    profile = mkdtempSync(path.join(PROFILE_ROOT, 'profile-'));
    // Same reason as launch(): an unwritable XDG_RUNTIME_DIR kills Chromium at startup.
    runtimeDir = path.join(profile, 'xdg-runtime');
    mkdirSync(runtimeDir, { mode: 0o700 });
  } catch (err) {
    if (profile) removeProfile(profile);
    releaseSlot();
    throw err;
  }
  const child = spawn(binary, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
    ...OFFLINE_ARGS, ...args, '--remote-debugging-port=0', 'about:blank',
  ], {
    stdio: ['ignore', 'ignore', 'pipe'], detached: true,
    env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir },
  });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b; });
  // A binary that cannot start emits 'error'; unheard, it takes the test process down.
  child.on('error', (err) => { stderr += `could not start ${binary}: ${err.message}`; });
  const cleanup = () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    removeProfile(profile);
    releaseSlot();
  };
  try {
    const port = await boundPort(profile, child, () => stderr, launchTimeoutMs);
    const jsonWait = deadline(launchTimeoutMs);
    let targets = null;
    while (jsonWait()) {
      try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    const target = targets?.find((t) => t.type === 'page');
    if (!target) throw new Error(`no page target: ${stderr.slice(0, 400)}`);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`devtools socket failed: ${stderr.slice(0, 400)}`)), { once: true });
    });
    let id = 0;
    const pending = new Map();
    const listeners = new Map(); // method -> Set(handler)
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method && listeners.has(m.method)) { for (const fn of listeners.get(m.method)) fn(m.params); }
    });
    ws.addEventListener('close', () => {
      const why = `devtools socket closed: ${stderr.slice(0, 400)}`;
      for (const [, settle] of pending) settle({ error: { message: why } });
      pending.clear();
    });
    const send = (method, params, timeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS) => new Promise((resolve, reject) => {
      const mine = ++id;
      const timer = setTimeout(() => { pending.delete(mine); reject(new Error(`${method} timed out`)); }, timeoutMs);
      pending.set(mine, (m) => { clearTimeout(timer); m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result); });
      ws.send(JSON.stringify({ id: mine, method, params }));
    });
    /** Persistent subscription — every matching event, not just the first.
     *  Returns an unsubscribe function. */
    const on = (method, fn) => {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(fn);
      return () => listeners.get(method)?.delete(fn);
    };
    const once = (method, ms = 30000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`${method} never fired within ${ms} ms`)); }, ms);
      const off = on(method, (p) => { clearTimeout(timer); off(); resolve(p); });
    });
    // navigatePage waits launch()'s 120 s for the load, not this once()'s 30 s default.
    const navigate = (target) => navigatePage(send, once, target);
    // `timeoutMs` for a page-side wait that is slow on a loaded box (a WebGL render under
    // software GL); the CDP call and the page-side evaluation share the one budget.
    const evaluate = async (expression, { timeoutMs = 30000 } = {}) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs }, timeoutMs + 5000);
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error(`page threw: ${d.exception?.description ?? d.text}`);
      }
      return r.result.value;
    };
    return { send, on, once, evaluate, navigate, close: () => { try { ws.close(); } finally { cleanup(); } } };
  } catch (err) {
    cleanup();
    throw err;
  }
}
