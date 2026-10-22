// Screenshot generator for the Band Coach product page (content/band-coach.md).
//
// Drives the real app in headless Chromium over the Chrome DevTools Protocol,
// using only Node built-ins (global WebSocket + fetch, node:child_process,
// node:fs) — the same no-dependency pattern as scripts/preview-overflow.mjs
// in this repo. It builds the app's DEV bundle (which carries the
// `window.__coach` debug hook stripped from the release file), then clicks
// through the real instrument picker (#picker), the "More ways to
// practise" panel picker (#panelPicker) and real Songs rows — the same
// elements a learner clicks — so every shot proves the real UI renders and
// is the real, current UI rather than a hand-staged mock. There is no
// persistent nav bar in this app. The debug hook is used only to detect
// readiness, never to jump screens.
//
// Usage:
//   node scripts/capture-band-coach-shots.mjs --ref <tag> [outdir]
//
// --ref (or BAND_COACH_REF) is required and names the tag BAND_COACH_REPO
// must be checked out at (verified with `git describe --tags
// --exact-match`) — captures are evidence for a specific release, so a
// checkout that isn't provably on that tag refuses to run rather than let
// a stale or wrong-version UI get recorded as if it belonged to that
// release. It is also written into static/img/band-coach/manifest.json as
// each captured image's `source`.
//
// outdir defaults to static/img/band-coach/ (the path the product page's
// <img> tags reference). BAND_COACH_REPO is required: the path of a local
// checkout of the Band Coach app. There is no default and none is guessed
// from this script's location, because a site worktree can live anywhere.
//
// Re-run this whenever the app's UI changes meaningfully — it always
// rebuilds the dev bundle first, so the shots never go stale silently.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const refFlagIdx = args.indexOf("--ref");
const REF = refFlagIdx >= 0 ? args[refFlagIdx + 1] : process.env.BAND_COACH_REF || null;
const positional = args.filter((a, i) => a !== "--ref" && i !== refFlagIdx + 1);
const OUT_DIR = resolve(__dirname, "..", positional[0] || "static/img/band-coach");
const MANIFEST_PATH = join(OUT_DIR, "manifest.json");

const fail = (msg) => { console.error(`capture-band-coach-shots: ${msg}`); process.exit(1); };

if (!process.env.BAND_COACH_REPO) fail("BAND_COACH_REPO is not set — set it to the path of a local checkout of the Band Coach app, e.g. BAND_COACH_REPO=~/src/band-coach node scripts/capture-band-coach-shots.mjs --ref v1.9.0");
const APP_REPO = resolve(process.env.BAND_COACH_REPO);

// --ref/BAND_COACH_REF pins which tag the checkout at BAND_COACH_REPO must be
// on before we trust its screenshots as evidence for that release — a
// checkout that has since moved on (or was never at a tag) would otherwise
// let a stale or wrong-version UI get recorded as if it were the release's.
function verifyRef(repo, ref) {
  if (!ref) fail("no --ref (or BAND_COACH_REF) given — pass the tag these captures are meant to prove, e.g. --ref v1.9.0");
  let actual;
  try {
    actual = execFileSync("git", ["-C", repo, "describe", "--tags", "--exact-match"], { encoding: "utf8" }).trim();
  } catch (e) {
    fail(`${repo} is not checked out exactly at a tag (git describe --tags --exact-match failed) — cannot prove it is ${ref}:\n${e.stderr || e.message}`);
  }
  if (actual !== ref) fail(`${repo} is at tag "${actual}", not the requested --ref "${ref}" — checkout the right tag before capturing`);
}

function buildApp() {
  if (!existsSync(APP_REPO)) fail(`app repo not found at ${APP_REPO} (set BAND_COACH_REPO)`);
  console.log(`building dev bundle from ${APP_REPO} ...`);
  const r = spawnSync("node", ["build/build.mjs"], { cwd: APP_REPO, encoding: "utf8" });
  if (r.status !== 0) fail(`app build failed:\n${r.stdout}\n${r.stderr}`);
  const dist = join(APP_REPO, "dist", "band-coach.html");
  if (!existsSync(dist)) fail(`build did not produce ${dist}`);
  return dist;
}

function findPlaywrightHeadlessShell() {
  const root = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse();
  for (const d of dirs) {
    const bin = join(root, d, "chrome-headless-shell-linux64", "chrome-headless-shell");
    if (existsSync(bin)) return bin;
  }
  return null;
}
function onPath(name) {
  for (const dir of (process.env.PATH || "").split(":")) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}
function findBrowserBinary() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const shell = findPlaywrightHeadlessShell();
  if (shell) return shell;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const p = onPath(name);
    if (p) return p;
  }
  return null;
}

function spawnBrowser(bin, userDataDir) {
  const args = [
    "--headless",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--no-sandbox",
    "about:blank",
  ];
  const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
  return new Promise((resolvePromise, reject) => {
    let buf = "";
    const onErr = (err) => reject(err);
    child.once("error", onErr);
    child.stderr.on("data", (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) { child.off("error", onErr); resolvePromise({ child, browserWsUrl: m[1] }); }
    });
    child.once("exit", (code) => {
      if (!buf.includes("DevTools listening")) reject(new Error(`browser exited (code ${code}) before DevTools was ready:\n${buf}`));
    });
    setTimeout(() => reject(new Error("timed out waiting for DevTools")), 15000).unref();
  });
}

async function main() {
  verifyRef(APP_REPO, REF);
  const distFile = buildApp();
  mkdirSync(OUT_DIR, { recursive: true });

  const bin = findBrowserBinary();
  if (!bin) fail("no Chromium-family browser found; set CHROME_BIN");
  const userDataDir = mkdtempSync(join(tmpdir(), "band-coach-shots-"));
  const { child, browserWsUrl } = await spawnBrowser(bin, userDataDir);

  const browserWs = new WebSocket(browserWsUrl);
  await new Promise((res, rej) => {
    browserWs.addEventListener("open", () => res(), { once: true });
    browserWs.addEventListener("error", (e) => rej(new Error(String(e))), { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  browserWs.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve: res, reject: rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    }
  });
  const sendBrowser = (method, params = {}) => new Promise((res, rej) => {
    const id = ++nextId;
    pending.set(id, { resolve: res, reject: rej });
    browserWs.send(JSON.stringify({ id, method, params }));
  });

  const { targetId } = await sendBrowser("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await sendBrowser("Target.attachToTarget", { targetId, flatten: true });
  const pagePending = new Map();
  let pageNextId = 0;
  const pageListeners = new Set();
  browserWs.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.sessionId !== sessionId) return;
    if (msg.id !== undefined && pagePending.has(msg.id)) {
      const { resolve: res, reject: rej } = pagePending.get(msg.id);
      pagePending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method) {
      for (const fn of pageListeners) fn(msg);
    }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++pageNextId;
    pagePending.set(id, { resolve: res, reject: rej });
    browserWs.send(JSON.stringify({ id, method, params, sessionId }));
  });

  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error("evaluate failed: " + (result.exceptionDetails.exception?.description || result.exceptionDetails.text));
    }
    return result.result.value;
  }
  async function waitFor(expression, timeoutMs = 5000) {
    const start = Date.now();
    for (;;) {
      const ok = await evaluate(`Boolean(${expression})`);
      if (ok) return;
      if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${expression}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  await send("Runtime.enable");
  await send("Page.enable");
  await send("DOM.enable");

  const loaded = new Promise((res) => {
    const handler = (msg) => { if (msg.method === "Page.loadEventFired") { pageListeners.delete(handler); res(); } };
    pageListeners.add(handler);
  });
  await send("Page.navigate", { url: "file://" + distFile });
  await loaded;
  await waitFor("document.readyState === 'complete' && !!document.getElementById('cv') && !!window.__coach");

  const captured = [];
  // scrollIntoView: capturing only the viewport (no captureBeyondViewport),
  // some real content — the song practice section, the rail menu's "More
  // options" body — renders well below the fold at 900px tall. Without
  // this a shot silently repeats whatever was already on screen instead of
  // the thing the click just revealed, so every shot that reveals such
  // content must name it here rather than assume the top of the page.
  async function shoot(name, { width, height = 900, clipHeight, scrollIntoView } = { width: 1440 }) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 500 });
    if (scrollIntoView) {
      await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(scrollIntoView)}); if (!el) throw new Error('scrollIntoView target not found: ${scrollIntoView}'); el.scrollIntoView({ block: "start" }); })()`);
    } else {
      await evaluate("window.scrollTo(0, 0)");
    }
    await new Promise((r) => setTimeout(r, 150)); // let layout/scroll settle
    const params = { format: "png", fromSurface: true };
    if (clipHeight) params.clip = { x: 0, y: 0, width, height: clipHeight, scale: 1 };
    const { data } = await send("Page.captureScreenshot", params);
    const path = join(OUT_DIR, `${name}.png`);
    writeFileSync(path, Buffer.from(data, "base64"));
    const kb = Math.round(statSync(path).size / 1024);
    console.log(`${name}.png  ${width}x${clipHeight || height}  ${kb}KB`);
    captured.push({ name, viewport: `${width}x${clipHeight || height}` });
  }

  // Drives the real instrument picker (#picker), the "More ways to
  // practise" panel picker (#panelPicker) and the "More options" rail menu
  // (#railMenu) — the same elements a learner clicks. There is no
  // persistent nav bar in this app; window.__coach is used only to read
  // state (readiness), never to jump screens.
  async function click(selector) {
    await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('not found: ${selector}'); el.click(); })()`);
    await new Promise((r) => setTimeout(r, 250));
  }
  async function clickByText(selector, text) {
    await evaluate(`(() => { const el = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e => e.textContent.trim() === ${JSON.stringify(text)}); if (!el) throw new Error('not found: ${text}'); el.click(); })()`);
    await new Promise((r) => setTimeout(r, 250));
  }

  // 1. The instrument-picker sheet, open the way a first-time learner sees
  // it (a fresh profile boots with it already open) — 26 instruments
  // grouped by family, plus the Tools row (Ear training / How to play it /
  // Music theory).
  await waitFor("document.getElementById('picker').hidden === false");
  await shoot("instrument-picker", { width: 1440, height: 900 });

  // 2. Main trainer, keyboard instrument, desktop width — picking a picker
  // button is what a learner does to close the sheet and land here.
  await click('#picker button[data-mod="kbd"]');
  await shoot("trainer-keyboard", { width: 1440, height: 900 });

  // 3. Ear training, opened from the "More ways to practise" panel picker.
  await click('#panelPickerDisclosure summary');
  await click('#panelPicker button[data-panel="ear"]');
  await shoot("panel-ear", { width: 1440, height: 900 });

  // 4. Songs list — panels.open() auto-closes the previously open panel, so
  // this can be picked directly from the panel picker without closing ear
  // training first.
  await click('#panelPickerDisclosure summary');
  await click('#panelPicker button[data-panel="songs"]');
  await shoot("panel-songs", { width: 1440, height: 900 });

  // 5. A song practice screen — opening a starter tune from the list starts
  // its first step right away. The practice section renders below the song
  // list/import/export sections in the DOM, so it needs scrolling into view.
  await clickByText(".panel-songs-row button", "Hot Cross Buns");
  await shoot("song-practice", { width: 1440, height: 900, scrollIntoView: ".panel-songs-practice" });

  // 6. Progress ("My progress"), also from the panel picker.
  await click('#panelPickerDisclosure summary');
  await click('#panelPicker button[data-panel="history"]');
  await shoot("panel-history", { width: 1440, height: 900 });

  // 7. Back to the main trainer — clicking an instrument button closes any
  // open panel and selects it, the real way learners return from a panel.
  await click('#picker button[data-mod="kbd"]');

  // Settings-equivalent: the "More options" rail menu (reset, backup/
  // restore, check for updates) in the side aside — there is no dedicated
  // Settings screen; theme/note-name options are always visible, not
  // gated behind this disclosure.
  await click('#railMenu summary');
  await shoot("settings", { width: 1440, height: 900, scrollIntoView: "#railMenu" });
  await click('#railMenu summary'); // close it again before the phone shot

  // 8. Main trainer again at phone width, proving layout works down to
  // 390px — the always-visible picker and instrument view, not a nav bar.
  await shoot("trainer-phone", { width: 390, height: 844 });

  try { await sendBrowser("Target.closeTarget", { targetId }); } catch {}
  browserWs.close();
  child.kill("SIGKILL");
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}

  writeManifest(captured, REF);
  console.log(`wrote screenshots to ${OUT_DIR}`);
}

// Merges ref/captured_at/viewport into each captured image's manifest
// entry, preserving its existing `scenario` text — the manifest's other
// entries (if any weren't captured this run) are left untouched.
function writeManifest(captured, ref) {
  let manifest = { product: "band-coach", images: {} };
  if (existsSync(MANIFEST_PATH)) manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const capturedAt = new Date().toISOString();
  for (const { name, viewport } of captured) {
    const key = `${name}.png`;
    const prior = manifest.images[key] || {};
    manifest.images[key] = { ...prior, source: ref, captured_at: capturedAt, viewport };
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${MANIFEST_PATH}`);
}

main().catch((err) => fail(err.stack || String(err)));
