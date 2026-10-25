// QQA-10f: expired and old-capture cameras, through the real built page and a real Chromium.
// The page reads a schema 2 park snapshot (PR #787) holding three rows, and what a reader sees on
// each card is asserted from the DOM and from every request the browser made:
//   - a row whose validUntil is past: its card says plainly the picture is out of date (not "no
//     picture is published"), shows no picture, keeps the owner's link, and the browser makes NO
//     request to the still host for it;
//   - a row whose validUntil is ahead: loads its still normally, once;
//   - a row captured two hours ago on an img-plan provider: loads, then says when it was taken and
//     that the camera may be stuck (the age is read from capturedAt; an img-plan still has no
//     header to read, see camera-layer.js ageLine).
// Times are made from the clock at the start of the run, so the proof never goes stale. The session
// and interception mirror camera-requests.test.mjs (a PERSISTENT Fetch.requestPaused subscription
// is the only way to prove "no request"); nothing here reaches nps.gov, whose host is answered
// in-page with a tiny JPEG, and the snapshot is this test's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { findChromium, navigatePage, OFFLINE_ARGS, removeProfile } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage } from './helpers/waits.mjs';
import { settlePaused } from './helpers/paused-request.mjs';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { richParkFilesStub } from './helpers/camera-snapshot-stub.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built — run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const NPS_ORIGIN = SOURCES.npsWebcams.origin; // https://www.nps.gov
const NPS_IMG = `${NPS_ORIGIN}/featurecontent/ard/webcams/images/`;
const isNpsImageUrl = (url) => url.startsWith(NPS_ORIGIN);
const pathOf = (url) => new URL(url).pathname;
// A real, tiny, decodable JPEG, the same one camera-requests.test.mjs paints.
const TINY_JPEG_B64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

// The three rows. Positions are a few kilometres apart inside one Smokies view.
const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
function cameras(now = Date.now()) {
  return [
    { providerId: 'EXPIRED-1', name: 'Expired Ridge Webcam', lat: 35.60, lon: -83.50, still: `${NPS_IMG}expired-ridge.jpg`, validUntil: iso(now - HOUR) },
    { providerId: 'FRESH-2', name: 'Valid Overlook Webcam', lat: 35.63, lon: -83.45, still: `${NPS_IMG}valid-overlook.jpg`, validUntil: iso(now + 24 * HOUR) },
    { providerId: 'STUCK-3', name: 'Old Capture Webcam', lat: 35.57, lon: -83.55, still: `${NPS_IMG}old-capture.jpg`, capturedAt: iso(now - 2 * HOUR), validUntil: iso(now + 24 * HOUR) },
  ];
}

const PROFILE_ROOT = path.join(homedir(), '.cache', 'qcm-chrome');
const deadline = (ms) => { const end = Date.now() + ms; return () => Date.now() < end; };

async function connectSession({ args = [] } = {}) {
  mkdirSync(PROFILE_ROOT, { recursive: true });
  const profile = mkdtempSync(path.join(PROFILE_ROOT, 'profile-'));
  const child = spawn(CHROMIUM, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
    ...OFFLINE_ARGS, ...args, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b; });
  const cleanup = () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    removeProfile(profile);
  };
  try {
    const file = path.join(profile, 'DevToolsActivePort');
    const portWait = deadline(30000);
    let port = null;
    while (portWait() && child.exitCode === null) {
      try {
        const text = readFileSync(file, 'utf8'), nl = text.indexOf('\n');
        if (nl > 0) { port = Number(text.slice(0, nl)); break; }
      } catch { /* not written yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!port) throw new Error(`Chromium reported no DevTools port: ${stderr.slice(0, 400)}`);
    const jsonWait = deadline(30000);
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
    const listeners = new Map();
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
    const send = (method, params) => new Promise((resolve, reject) => {
      const mine = ++id;
      const timer = setTimeout(() => { pending.delete(mine); reject(new Error(`${method} timed out`)); }, 30000);
      pending.set(mine, (m) => { clearTimeout(timer); m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result); });
      ws.send(JSON.stringify({ id: mine, method, params }));
    });
    const on = (method, fn) => {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(fn);
      return () => listeners.get(method)?.delete(fn);
    };
    const once = (method, ms = 30000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`${method} never fired within ${ms} ms`)); }, ms);
      const off = on(method, (p) => { clearTimeout(timer); off(); resolve(p); });
    });
    const navigate = (target) => navigatePage(send, once, target);
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 30000 });
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

/** Intercepts every request: the stub snapshot files are answered, every www.nps.gov URL gets the
 *  tiny JPEG (and is recorded in `seen` either way), and everything else, the real built page
 *  included, passes through to the local site server. The document's CSP header is dropped so only
 *  the page's own meta policy applies, as in camera-requests.test.mjs. */
async function interceptNetwork(session, { docUrl, files }) {
  const seen = [];
  const unsubscribe = session.on('Fetch.requestPaused', async (p) => {
    const { requestId, request, responseStatusCode, responseHeaders } = p;
    if (responseStatusCode !== undefined) {
      const headers = (responseHeaders || []).filter((h) => h.name.toLowerCase() !== 'content-security-policy');
      await settlePaused(session.send, 'Fetch.continueResponse', { requestId, responseCode: responseStatusCode, responseHeaders: headers });
      return;
    }
    seen.push({ url: request.url });
    if (!isNpsImageUrl(request.url) && files[pathOf(request.url)] !== undefined) {
      await settlePaused(session.send, 'Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body: Buffer.from(files[pathOf(request.url)]).toString('base64'),
      });
    } else if (isNpsImageUrl(request.url)) {
      await settlePaused(session.send, 'Fetch.fulfillRequest', {
        requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'image/jpeg' }], body: TINY_JPEG_B64,
      });
    } else {
      await settlePaused(session.send, 'Fetch.continueRequest', { requestId });
    }
  });
  await session.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*', requestStage: 'Request' },
      { urlPattern: docUrl, requestStage: 'Response' },
    ],
  });
  return { seen, unsubscribe };
}

const CSP_LISTENER_SOURCE = `window.__cspViolations = [];
document.addEventListener('securitypolicyviolation', (e) => {
  window.__cspViolations.push(e.violatedDirective + ': ' + e.blockedURI);
});`;

const viewAt = (lat, lon, zoom) => `(() => { window.qcMap.setView([${lat}, ${lon}], ${zoom}, { animate: false }); void 0; })()`;
const tickParkCameras = `document.getElementById('qcm-layer-parkCameras').click(); void 0;`;
const pinSelector = (name) => `.qcm-camera-pin--park[title=${JSON.stringify(name)}]`;
const pinPresent = (name) => `Boolean(document.querySelector(${JSON.stringify(pinSelector(name))}))`;
const openPin = (name) => `document.querySelector(${JSON.stringify(pinSelector(name))}).click(); void 0;`;
const closePopup = `window.qcMap.closePopup(); void 0;`;
const popupGone = `!document.querySelector('.qcm-site-card')`;
// What a reader sees on the open card: all its text, its pictures, its links, and the polite
// status line the picture's load and age are written to.
const cardState = `(() => {
  const card = document.querySelector('.qcm-site-card');
  if (!card) return null;
  const status = card.querySelector('[role="status"]');
  return {
    text: card.textContent,
    imgs: card.querySelectorAll('img').length,
    status: status ? status.textContent : null,
    links: [...card.querySelectorAll('a')].map((a) => ({ text: a.textContent, href: a.href })),
  };
})()`;

async function openCard(session, name) {
  await session.evaluate(openPin(name));
  await waitInPage(session, `the card for ${name}`, `Boolean(document.querySelector('.qcm-site-card')?.textContent.includes(${JSON.stringify(name)}))`, 15000, null);
}
async function closeCard(session) {
  await session.evaluate(closePopup);
  await waitInPage(session, 'the card to close', popupGone, 5000, null);
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('expired and old-capture park cameras: an expired row requests nothing and says it is out of date, a valid row loads, a two-hour-old capture says the camera may be stuck', { skip }, async () => {
  const [expired, valid, stuck] = cameras();
  const site = await startSiteServer();
  const docUrl = `${site.origin}/quiet-corners/`;
  const session = await connectSession();
  try {
    await session.send('Page.enable');
    await session.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: CSP_LISTENER_SOURCE });
    const { seen } = await interceptNetwork(session, { docUrl, files: richParkFilesStub([expired, valid, stuck]) });
    await session.navigate(docUrl);
    await readyDashboard(session, { ms: 60000 });
    const stillRequests = (file) => seen.filter((r) => isNpsImageUrl(r.url) && pathOf(r.url).endsWith(`/${file}`));
    const npsRequests = () => seen.filter((r) => isNpsImageUrl(r.url));

    await session.evaluate(viewAt(35.6, -83.5, 10));
    await session.evaluate(tickParkCameras);
    for (const c of [expired, valid, stuck]) await waitInPage(session, `the pin for ${c.name}`, pinPresent(c.name), 30000, null);
    assert.equal(npsRequests().length, 0, 'a still was requested before any card was opened');

    // 1. Expired: the card says so plainly, shows no picture, keeps the owner's link, and the
    // browser never asks the still host for it.
    await openCard(session, expired.name);
    await pause(750); // a request, if one were coming, is made on open; give it time to show
    const old = await session.evaluate(cardState);
    assert.match(old.text, /out of date/i, `the expired card does not say the picture is out of date: ${JSON.stringify(old.text)}`);
    assert.doesNotMatch(old.text, /no picture is published/i, `the expired card says no picture is published: ${JSON.stringify(old.text)}`);
    assert.equal(old.imgs, 0, 'the expired card shows a picture');
    assert.ok(old.links.some((l) => l.text === 'Park webcam page' && l.href === 'https://www.nps.gov/'), `the owner link was dropped: ${JSON.stringify(old.links)}`);
    assert.equal(old.links.some((l) => /expired-ridge/.test(l.href)), false, 'the card links the expired still');
    assert.deepEqual(stillRequests('expired-ridge.jpg'), [], 'the browser requested the expired still');
    assert.equal(npsRequests().length, 0, `opening an expired card made a request to the still host: ${JSON.stringify(npsRequests())}`);
    await closeCard(session);

    // 2. A row whose validUntil is ahead loads normally: one request, one picture, no out-of-date line.
    await openCard(session, valid.name);
    await waitInPage(session, 'the valid still to load', `Boolean(document.querySelector('.qcm-site-card img'))`, 15000, null);
    await waitInPage(session, 'the load status to clear', `document.querySelector('.qcm-site-card [role="status"]').textContent === ''`, 15000, null);
    const ok = await session.evaluate(cardState);
    assert.equal(ok.imgs, 1);
    assert.doesNotMatch(ok.text, /out of date/i);
    assert.doesNotMatch(ok.text, /may be stuck/i, 'a row with no capture time must not be called stuck');
    assert.equal(stillRequests('valid-overlook.jpg').length, 1, `expected one request for the valid still: ${JSON.stringify(npsRequests())}`);
    await closeCard(session);

    // 3. A capture two hours old on an img-plan provider: the picture loads, then the card says
    // when it was taken and that the camera may be stuck. The age is read from capturedAt.
    await openCard(session, stuck.name);
    await waitInPage(session, 'the old-capture age line', `/may be stuck/.test(document.querySelector('.qcm-site-card [role="status"]')?.textContent || '')`, 15000, null);
    const age = await session.evaluate(cardState);
    assert.equal(age.imgs, 1, 'the old-capture card should still show its picture');
    assert.match(age.status, /^Picture taken 2 h ago, per the park's listing\. The camera may be stuck\.$/, age.status);
    assert.doesNotMatch(age.text, /does not publish when this picture was taken/, 'the card says no capture time exists beside one it shows');
    assert.doesNotMatch(age.text, /\blive\b/i);
    assert.equal(stillRequests('old-capture.jpg').length, 1);

    // The whole run: two stills requested, the expired one never, and no CSP violation.
    assert.equal(npsRequests().length, 2, `unexpected still-host requests: ${JSON.stringify(npsRequests())}`);
    assert.deepEqual(await session.evaluate('window.__cspViolations'), [], 'CSP violation(s) during the expiry flow');
  } finally {
    session.close();
    await site.close();
  }
});
