// QUX-09a/09a-ii browser proof (§4.2 of .data/plans/2026-09-27-qux-specs/QUX-09.md):
// all six scenarios -- Save/Show/Share (09a-i) plus Download/Import/Clear/Undo
// (09a-ii). Drives headless Chromium over CDP like names-keyboard.test.mjs,
// geonames stubbed in-page. One shared browser/profile (GATES.md §5): a saved
// place from an earlier scenario stays for a later one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { findChromium, launch } from './helpers/browser.mjs';
import { trustedClick as pressWhenStill } from './helpers/trusted-click.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { waitInPage, readyDashboard, chooseExampleArea } from './helpers/waits.mjs';
import { PLACE_FEATURES } from './fixtures/gnis-names-declutter.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const CEILING = 20000;
const SAVED_KEY = 'qc-saved-places';
const SAVED_KEY_JSON = JSON.stringify(SAVED_KEY);

// fetchBounded pages layers 3/5/6/7 unconditionally, so all need an answer.
// Only layer 3 carries fixtures -- this file proves Save/Show/Share, not
// declutter/kind-badge behavior covered elsewhere.
const COUNTS = { 3: PLACE_FEATURES.length, 5: 0, 6: 0, 7: 0 };
const PAGES = { 3: PLACE_FEATURES, 5: [], 6: [], 7: [] };

// api.weather.gov answered from the committed fixtures before-you-go.test.mjs
// uses. Show (test 2) picks a place, so the Conditions cards ask NWS; left live,
// the alert card's answer landed whenever the network let it and grew the card
// above the saved list by 81 px after trustedClick had measured Share -- the click
// hit section#qc-alerts (click-log diagnostic, qux-scd-4.log, under 4x load).
const NWS_API = JSON.parse(readFileSync(new URL('fixtures/nws-api-2026-09-10.min.json', import.meta.url), 'utf8'));
const NWS_GRID = JSON.parse(readFileSync(new URL('fixtures/nws-grid-2026-09-11.min.json', import.meta.url), 'utf8'));
const NWS_ALERTS = JSON.parse(readFileSync(new URL('fixtures/nws-alerts-2026-09-14.min.json', import.meta.url), 'utf8'));

// Patches fetch (geonames stub + counter), URL.createObjectURL (Download
// builds an <a download> whose click headless Chromium cannot hand to a
// person -- capturing the Blob's own text is what the Download checks need)
// and clipboard.writeText (CDP has no clipboard dialog) onto `window.__qc*`.
function patchSource() {
  return `(() => {
    const counts = ${JSON.stringify(COUNTS)};
    const pages = ${JSON.stringify(PAGES)};
    const NWS_API = ${JSON.stringify(NWS_API)};
    const NWS_GRID = ${JSON.stringify(NWS_GRID)};
    const NWS_ALERTS = ${JSON.stringify(NWS_ALERTS)};
    const nwsJson = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/geo+json' },
    }));
    const nwsAnswer = (url) => {
      if (url.indexOf('/points/') !== -1) return nwsJson(NWS_API.point);
      if (url.indexOf('/forecast/hourly') !== -1) return nwsJson(NWS_API.hourly);
      if (url.indexOf('/gridpoints/') !== -1) return nwsJson(NWS_GRID);
      if (url.indexOf('/alerts/active') !== -1) return nwsJson(NWS_ALERTS.active);
      return nwsJson({}, 404);
    };
    window.__qcFetches = [];
    const realFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
      const url = String(input && input.url ? input.url : input);
      window.__qcFetches.push({ url, at: performance.now() });
      // The NHD river tier is answered empty: these proofs are hermetic and about the GNIS names.
      if (/nhd\\/MapServer\\/\\d+\\/query/.test(url)) return Promise.resolve(new Response(JSON.stringify({ features: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
      const m = url.match(/geonames\\/MapServer\\/(\\d+)\\/query/);
      if (m) {
        const isCount = /returnCountOnly=true/.test(url);
        const body = isCount ? { count: counts[m[1]] ?? 0 } : { features: pages[m[1]] ?? [] };
        return Promise.resolve(new Response(JSON.stringify(body), {
          status: 200, headers: { 'content-type': 'application/json' },
        }));
      }
      if (url.indexOf('https://api.weather.gov/') === 0) return nwsAnswer(url);
      return realFetch(input, init);
    };

    window.__qcLastBlobText = null;
    const realCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function(blob) {
      window.__qcLastBlobType = blob.type;
      blob.text().then((t) => { window.__qcLastBlobText = t; });
      return realCreateObjectURL(blob);
    };

    window.__qcLastCopiedText = null;
    if (!navigator.clipboard) Object.defineProperty(navigator, 'clipboard', { value: {}, configurable: true });
    navigator.clipboard.writeText = function(text) { window.__qcLastCopiedText = text; return Promise.resolve(); };
  })()`;
}

// Same convention as names-keyboard.test.mjs: every <details> except #qcm-app
// starts open, so a marker under a closed panel is never elementFromPoint's hit.
const openEveryPanel = "(() => { for (const d of document.querySelectorAll('details:not(#qcm-app)')) d.open = true; })()";

let shared = null;

async function sharedBrowser() {
  if (!shared) {
    const site = await startSiteServer();
    const page = await launch(CHROMIUM, 'about:blank', {
      viewport: { width: 1280, height: 900 }, args: ['--hide-scrollbars'],
    });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: patchSource() });
    // A real "Save File" flow has nothing to answer it headlessly; denying it
    // outright keeps the Download click from ever blocking on a dialog CDP
    // never shows -- the test reads the blob text captured above instead.
    await page.send('Page.setDownloadBehavior', { behavior: 'deny' });
    shared = { site, page };
  }
  return shared;
}

after(async () => {
  if (!shared) return;
  shared.page.close();
  await shared.site.close();
});

/** Turns Named places on, waits for a placed marker (names-keyboard.test.mjs's setup). */
async function readyNamesLayer(page) {
  await page.evaluate(openEveryPanel);
  await chooseExampleArea(page);
  await page.evaluate(`(() => {
    const cb = document.getElementById('qcm-layer-names');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await page.evaluate("document.getElementById('qcm-check').click()");
  await waitInPage(page, 'name markers to render', "document.querySelectorAll('.qcm-name-marker').length > 0", CEILING, null);
}

/** Since QUX-03b-ii the saved-places section sits inside the Conditions panel
 *  (#qc-conditions-panel -- the old right-side drawer's contents, after the alert
 *  card), which is closed on every load and exclusive with the other panels
 *  (wirePanels(), quiet-corners.js), so openEveryPanel cannot be relied on to
 *  leave it open. Opened on its own before a row or footer control is clicked;
 *  with it shut, trustedClick's centre lands on whatever panel is open instead. */
async function openConditions(page) {
  await page.evaluate("document.getElementById('qc-conditions-panel').open = true");
}

/** Opens the first placed marker's card, waits for its five actions (05c's
 *  two, 09a's Save third, 09b's Before you go fourth, then QUX-11b's Nearby
 *  last). */
async function openFirstNameCard(page) {
  await trustedClick(page, '.qcm-name-marker');
  await waitInPage(page, 'the name card to open with its five actions',
    "document.querySelectorAll('.qcm-site-card-action').length === 5", CEILING, null);
}

// Under $HOME, never the OS temp dir: snap Chromium (CI's CHROME_PATH) runs with a
// private /tmp, so a fixture written there is invisible to the browser and
// DOM.setFileInputFiles hands the page a file that does not exist -- tests 5 and 6
// then wait out their ceilings (`/tmp/claude-1002/qux-09a-import-snap-RED.log`).
// helpers/browser.mjs stages its profiles under ~/.cache for the same reason.
const IMPORT_ROOT = path.join(homedir(), '.cache', 'qcm-import');
mkdirSync(IMPORT_ROOT, { recursive: true });
const IMPORT_DIR = mkdtempSync(path.join(IMPORT_ROOT, 'qux-09a-import-'));
after(() => { try { rmSync(IMPORT_DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

/** helpers/trusted-click.mjs's press, then proof it landed. Where the press, release
 *  and click actually go is recorded, and a click that never reaches its target fails
 *  here naming where it went instead of as a later 'never came true'. This file's
 *  copy never waited after the press; keep it that way. */
async function trustedClick(page, selector) {
  // A pick's Conditions cards start as one-line "Asking…"/"Working out…" notes and
  // repaint taller when their answers land, moving everything below them (the
  // saved list included). Press only once they have all answered.
  await waitInPage(page, 'the Conditions cards to finish answering',
    `!['qc-tonight', 'qc-hourly', 'qc-alerts'].some((id) => { const el = document.getElementById(id);
      return el && /^(Working out tonight|Asking the National Weather Service)/.test(el.textContent.trim()); })`,
    CEILING, null);
  await page.evaluate(`(() => { const log = window.__qcClickLog = [];
    const name = (el) => el && el.nodeType === 1 ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '') : String(el);
    for (const t of ['mousedown', 'mouseup', 'click']) document.addEventListener(t, (e) => {
      log.push({ t, target: name(e.target), hit: Boolean(e.target.closest && e.target.closest(${JSON.stringify(selector)})), x: e.clientX, y: e.clientY, scrollY });
    }, { capture: true, once: true }); })()`);
  const pressed = await pressWhenStill(page, selector, { settleMs: 0 });
  const landed = "(window.__qcClickLog || []).some((e) => e.t === 'click' && e.hit)";
  try { await waitInPage(page, `the click on ${selector} to reach it`, landed, CEILING, null); }
  catch (err) {
    const seen = await page.evaluate(`JSON.stringify({ events: window.__qcClickLog, scrollY,
      nowAt: (() => { const el = document.querySelector(${JSON.stringify(selector)}); const r = el && el.getBoundingClientRect(); return r && [r.left + r.width / 2, r.top + r.height / 2]; })(),
      active: document.activeElement && (document.activeElement.id || document.activeElement.className || document.activeElement.tagName) })`);
    throw new Error(`${err.message}: ${seen}`);
  }
  return pressed;
}

test('1. Save on a card writes one entry and the list gains a row, reaching no network', { skip }, async () => {
  const { site, page } = await sharedBrowser();
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: false, ms: CEILING });
  await readyNamesLayer(page);
  await openFirstNameCard(page);

  // Both checks are by start time, never by count. A count baseline read here
  // races whatever the open card is still asking for: the resource-timing side
  // saw a basemap tile finish during the click (qux-09a-iii-browser.log,
  // '129 !== 128'), and the fetch side saw a Conditions card's weather request
  // START between the baseline and the click (PR CI run 37600263497,
  // '22 !== 23', Save itself green) -- trustedClick waits for those cards to
  // settle, but only after the baseline was taken. What Save must not do is
  // START a request, and a fetch or timing entry begun at or after the press is
  // the only kind that could be Save's.
  const clicked = await trustedClick(page, '.qcm-site-card-action:nth-child(3)');
  await waitInPage(page, 'the Save button to flip to Saved -- remove',
    "document.querySelectorAll('.qcm-site-card-action')[2].textContent === 'Saved \\u2014 remove'", CEILING, null);

  const after1 = await page.evaluate(`({
    fetches: window.__qcFetches.filter(f => f.at >= ${clicked.at}).map(f => f.url),
    started: performance.getEntriesByType('resource').filter(e => e.startTime >= ${clicked.at}).map(e => e.name),
  })`);
  assert.deepEqual(after1.fetches, [], 'Save should reach no network (fetch() calls begun after the click)');
  assert.deepEqual(after1.started, [], 'Save should start no request (resource-timing entries begun after the click)');

  const storedText = await page.evaluate(`localStorage.getItem(${SAVED_KEY_JSON})`);
  const stored = JSON.parse(storedText);
  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.places.length, 1);
  assert.match(stored.places[0].ref, /^gnis:\d+$/);

  await waitInPage(page, 'the saved-places list to gain a row',
    "document.querySelectorAll('#qc-saved-list .qc-saved-row').length === 1", CEILING, null);
});

test('2. a saved place survives navigation, and Show reopens the same card', { skip }, async () => {
  const { site, page } = await sharedBrowser();
  const savedName = await page.evaluate(`JSON.parse(localStorage.getItem(${SAVED_KEY_JSON})).places[0].name`);

  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: false, ms: CEILING });

  await waitInPage(page, 'the saved-places row to survive the reload',
    "document.querySelectorAll('#qc-saved-list .qc-saved-row').length === 1", CEILING, null);

  await openConditions(page);
  // Show: nth-child(1) -- 09a row order is Show, Share, Remove.
  await trustedClick(page, '.qc-saved-row .qc-saved-row-action:nth-child(1)');
  await waitInPage(page, 'the same card to reopen with the saved place’s name',
    `(() => { const el = document.querySelector('.qcm-site-card-name');
      return Boolean(el) && el.textContent.indexOf(${JSON.stringify('')}) !== -1 && el.textContent.length > 0; })()`,
    CEILING, null);
  const cardName = await page.evaluate("document.querySelector('.qcm-site-card-name').textContent");
  assert.ok(cardName.includes(savedName), `Show should reopen a card naming the saved place (got "${cardName}")`);
});

test('3. Share on a saved-places row copies a link carrying the place’s own coordinates, never a device-location center or saved-place data', { skip }, async () => {
  const { page } = await sharedBrowser();
  await waitInPage(page, 'a saved-places row to Share', "document.querySelectorAll('#qc-saved-list .qc-saved-row').length > 0", CEILING, null);

  // `c=` is the place's own location, the point of Share; what must never
  // happen is a device-location center or any saved-places schema field.
  const place = await page.evaluate(`JSON.parse(localStorage.getItem(${SAVED_KEY_JSON})).places[0]`);

  await openConditions(page);
  await page.evaluate('window.__qcLastCopiedText = null; void 0;');
  await trustedClick(page, '.qc-saved-row .qc-saved-row-action:nth-child(2)'); // Share
  await waitInPage(page, 'a share link to be copied', 'window.__qcLastCopiedText != null', CEILING, null);

  const copied = await page.evaluate('window.__qcLastCopiedText');
  const fragment = copied.slice(copied.indexOf('#'));
  const expectedC = `c=${Number(place.lat.toFixed(5))},${Number(place.lon.toFixed(5))}`;
  assert.ok(fragment.includes(expectedC), `share link should carry the saved place's own coordinates (${expectedC}): ${fragment}`);
  assert.ok(!/ref=|schemaVersion|qc-saved/i.test(fragment), `a saved-place share link should carry no saved-place data of its own: ${fragment}`);
});

test('4. corrupt stored text is never deleted, Save is disabled, and Download exports the raw text', { skip }, async () => {
  const { site, page } = await sharedBrowser();
  const { identifier } = await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem(${SAVED_KEY_JSON}, 'not json{');`,
  });
  await page.navigate(`${site.origin}/quiet-corners/`);
  await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  await readyDashboard(page, { data: false, ms: CEILING });

  await waitInPage(page, 'the saved-places status to report the unreadable text',
    "/could not be read/i.test(document.getElementById('qc-saved-status').textContent)", CEILING, null);
  const statusText = await page.evaluate("document.getElementById('qc-saved-status').textContent");
  assert.match(statusText, /could not be read/i);
  assert.match(statusText, /nothing has been deleted/i);

  await readyNamesLayer(page);
  await openFirstNameCard(page);
  const saveBtn = await page.evaluate(`(() => {
    const btn = document.querySelectorAll('.qcm-site-card-action')[2];
    return { disabled: btn.disabled, title: btn.title };
  })()`);
  assert.equal(saveBtn.disabled, true, 'Save should be disabled while the store is read-only');
  assert.match(saveBtn.title, /could not be read/i);

  await openConditions(page);
  await page.evaluate('window.__qcLastBlobText = null; void 0;');
  await trustedClick(page, '#qc-saved-download');
  await waitInPage(page, 'the download to capture the raw stored text', 'window.__qcLastBlobText != null', CEILING, null);
  const blobText = await page.evaluate('window.__qcLastBlobText');
  assert.equal(blobText, 'not json{', 'Download should export the raw unreadable text byte-identical');

  const stillStored = await page.evaluate(`localStorage.getItem(${SAVED_KEY_JSON})`);
  assert.equal(stillStored, 'not json{', 'a failed parse must never delete the stored text (R2-G2)');

  // Clears the seeded corruption so the Import scenario lands on a readable
  // (empty) store -- importText() refuses to write over unreadable text.
  await page.evaluate(`localStorage.removeItem(${SAVED_KEY_JSON}); void 0;`);
});

test('5. Import merges a fixture file and the rows appear', { skip }, async () => {
  const { page } = await sharedBrowser();
  const fixture = {
    schemaVersion: 1,
    places: [
      { ref: 'gnis:555001', name: 'Import Test Summit', kind: 'summit', lat: 36.1, lon: -82.2, state: 'NC', county: 'Test County', savedAt: '2026-09-01T00:00:00.000Z' },
      { ref: 'gnis:555002', name: 'Import Test Place', kind: 'place', lat: 36.2, lon: -82.3, state: 'NC', county: 'Test County', savedAt: '2026-09-01T00:00:00.000Z' },
    ],
  };
  const fixturePath = path.join(IMPORT_DIR, 'saved-places-import.json');
  writeFileSync(fixturePath, JSON.stringify(fixture));

  await page.send('DOM.enable');
  const { root } = await page.send('DOM.getDocument', {});
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#qc-saved-import' });
  await page.send('DOM.setFileInputFiles', { files: [fixturePath], nodeId });

  await waitInPage(page, 'the import status to report the added count',
    "/imported 2 places/i.test(document.getElementById('qc-saved-status').textContent)", CEILING, null);
  await waitInPage(page, 'both imported rows to appear',
    "document.querySelectorAll('#qc-saved-list .qc-saved-row').length === 2", CEILING, null);
});

test('5b. Download GPX saves the imported places as waypoints and says so in the status line', { skip }, async () => {
  const { page } = await sharedBrowser();
  await openConditions(page);
  await page.evaluate('window.__qcLastBlobText = null; void 0;');
  await trustedClick(page, '#qc-saved-download-gpx');
  await waitInPage(page, 'the GPX download to capture its text', 'window.__qcLastBlobText != null', CEILING, null);
  const gpx = await page.evaluate('window.__qcLastBlobText');
  assert.match(gpx, /<gpx version="1\.1"/);
  assert.equal((gpx.match(/<wpt /g) || []).length, 2);
  assert.equal(await page.evaluate('window.__qcLastBlobType'), 'application/gpx+xml');
  assert.match(await page.evaluate("document.getElementById('qc-saved-status').textContent"), /GPX file with 2 places/);
});

test('6. Clear asks for confirmation, then Undo restores the cleared text byte-identical', { skip }, async () => {
  const { page } = await sharedBrowser();
  const beforeClear = await page.evaluate(`localStorage.getItem(${SAVED_KEY_JSON})`);
  assert.ok(beforeClear, 'setup: the Import scenario should have left saved places in storage');

  await openConditions(page);
  await trustedClick(page, '#qc-saved-clear');
  await waitInPage(page, 'Clear to ask for confirmation',
    "/^Confirm: clear/.test(document.getElementById('qc-saved-clear').textContent)", CEILING, null);

  await trustedClick(page, '#qc-saved-clear');
  await waitInPage(page, 'the saved-places key to be cleared', `localStorage.getItem(${SAVED_KEY_JSON}) === null`, CEILING, null);
  const undoHidden = await page.evaluate("document.getElementById('qc-saved-undo').hidden");
  assert.equal(undoHidden, false, 'Undo clear should appear once a clear has happened');

  await trustedClick(page, '#qc-saved-undo');
  await waitInPage(page, 'the saved-places key to be restored', `localStorage.getItem(${SAVED_KEY_JSON}) !== null`, CEILING, null);
  const afterUndo = await page.evaluate(`localStorage.getItem(${SAVED_KEY_JSON})`);
  assert.equal(afterUndo, beforeClear, 'Undo should restore the cleared text byte-identical');
});
