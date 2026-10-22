// The page-load restore of the last saved job must never replace an area the reader
// has already chosen on this load. start() (main.js) awaits store.loadRecipe() -- an
// IndexedDB read -- only after the map exists, and the map is what a reader (and
// readyDashboard) waits for. On a slow disk the read lands late: a reader who pressed
// "Use example area" in the meantime had it swapped for last session's job. #646's
// local stress run saw it as a correct ring-cell press followed by no area at all.
//
// This proof holds every IndexedDB open in the page itself (a stand-in installed before
// any page script runs) so the reader's choice is certain to come first.
//
// readyDashboard also waits for window.qcRestoreSettled, which start() sets once that
// restore and the save it set off have both landed. Before the flag, nothing waited for
// that save: on #652's PR CI run 36653058133 the held reload below brought back
// 'Standing Indian / Wayah Bald, North Carolina', the previous test's area, instead of
// 'Old job'. The unheld load restores that area and re-saves it without awaiting, so the
// save could land after heldReload() had seeded the old job.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { recipeFromControls, EXAMPLE_AREA } from '../../themes/headlessmode/static/js/quiet-corners-maps/app-state.js';
import { serializeRecipe } from '../../themes/headlessmode/static/js/quiet-corners-maps/sheet-plan.js';
import { DB_NAME, STORE, KEY, VERSION } from '../../themes/headlessmode/static/js/quiet-corners-maps/project-store.js';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, chooseExampleArea, waitInPage } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt() ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

// Last session's job: a box nowhere near the example area, under its own title.
const OLD_JOB = { title: 'Old job', bbox: { minLon: -81.6, minLat: 36.6, maxLon: -81.45, maxLat: 36.7 } };
const OLD_TEXT = serializeRecipe(recipeFromControls(
  { orientation: 'portrait', scale: 24000, overlapIn: 0.5, dpi: 300, grid: 'none' }, OLD_JOB.bbox, OLD_JOB.title, null));

// indexedDB.open waits on window.__releaseIdb() from open number `pass` + 1 on: 0 holds
// the restore's own read, 1 lets that read through and holds the save it sets off.
const holdIdb = (pass = 0) => `(() => {
  const real = window.indexedDB;
  let release;
  const gate = new Promise((r) => { release = r; });
  window.__releaseIdb = () => release();
  window.__idbHeld = 0;
  let opens = 0;
  const fake = {
    open(name, version) {
      if (opens++ < ${pass}) return real.open(name, version);
      window.__idbHeld++;
      const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      gate.then(() => {
        const r = real.open(name, version);
        r.onupgradeneeded = () => { req.result = r.result; if (req.onupgradeneeded) req.onupgradeneeded(); };
        r.onsuccess = () => { req.result = r.result; if (req.onsuccess) req.onsuccess(); };
        r.onerror = () => { req.error = r.error; if (req.onerror) req.onerror(); };
      });
      return req;
    },
  };
  Object.defineProperty(window, 'indexedDB', { value: fake, configurable: true });
})()`;

const seedOldJob = `(() => new Promise((resolve, reject) => {
  const req = indexedDB.open(${JSON.stringify(DB_NAME)}, ${VERSION});
  req.onupgradeneeded = () => req.result.createObjectStore(${JSON.stringify(STORE)});
  req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction(${JSON.stringify(STORE)}, 'readwrite');
    tx.objectStore(${JSON.stringify(STORE)}).put(${JSON.stringify(OLD_TEXT)}, ${JSON.stringify(KEY)});
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => reject(tx.error);
  };
  req.onerror = () => reject(req.error);
}))()`;

const readArea = `(() => ({
  title: document.getElementById('qcm-title').value,
  minLon: Number(document.getElementById('qcm-min-lon').value),
  maxLat: Number(document.getElementById('qcm-max-lat').value),
}))()`;

let shared = null;
after(async () => {
  if (!shared) return;
  shared.page.close();
  await shared.site.close();
});

/** How long a proof keeps IndexedDB held while it checks that readyDashboard is still
 *  waiting. A readyDashboard that waits stays pending for as long as the hold lasts, so
 *  this is the length of the hold, not a bet on load; one that does not wait returns
 *  within a poll of the map being up. */
const HOLD_MS = 1500;

/** Seeds OLD_JOB unheld, then loads the page again with IndexedDB held (see holdIdb). */
async function heldReload(pass = 0) {
  if (!shared) {
    const site = await startSiteServer();
    const page = await launch(CHROMIUM, 'about:blank', { args: ['--hide-scrollbars'] });
    shared = { site, page };
  }
  const { site, page } = shared;
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: false });
  await page.evaluate(seedOldJob);

  const { identifier } = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: holdIdb(pass) });
  try {
    await page.navigate(`${site.origin}/quiet-corners/`);
  } finally {
    await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  }
  await readyDashboard(page, { data: false, restored: false });
  // The save is only set off once the restore's read has landed, so wait for it to be held.
  if (pass) await waitInPage(page, 'the save the restore set off to reach the held IndexedDB', 'window.__idbHeld >= 1');
  assert.ok(await page.evaluate('window.__idbHeld >= 1'), 'the restore never opened IndexedDB -- the proof would prove nothing');
  return page;
}

async function releaseAndSettle(page) {
  await page.evaluate('window.__releaseIdb()');
  await waitInPage(page, 'the held restore to settle (window.qcRestoreSettled)', 'window.qcRestoreSettled === true');
}

/** Starts readyDashboard on a page whose IndexedDB is held; 'pending' if it is still
 *  waiting HOLD_MS later, 'ready' if it already returned. */
async function readyWhileHeld(page) {
  const ready = readyDashboard(page, { data: false }).then(() => 'ready');
  const early = await Promise.race([ready, new Promise((r) => { setTimeout(r, HOLD_MS, 'pending'); })]);
  return { early, ready };
}

test('readyDashboard holds while the last-job restore is still reading IndexedDB', { skip }, async () => {
  const page = await heldReload();
  const { early, ready } = await readyWhileHeld(page);
  assert.equal(early, 'pending', 'readyDashboard returned while the restore was still reading -- a proof could act before it lands');
  await page.evaluate('window.__releaseIdb()');
  assert.equal(await ready, 'ready');
  assert.equal((await page.evaluate(readArea)).title, OLD_JOB.title, 'once readyDashboard returns, the restored job is on screen');
});

test('readyDashboard holds until the save the restore set off has landed', { skip }, async () => {
  const page = await heldReload(1);
  assert.equal((await page.evaluate(readArea)).title, OLD_JOB.title, 'setup: the restore itself has landed and only its save is held');
  const { early, ready } = await readyWhileHeld(page);
  assert.equal(early, 'pending', 'readyDashboard returned while the restore\'s own save was still pending -- a seed written next could lose to it');
  await page.evaluate('window.__releaseIdb()');
  assert.equal(await ready, 'ready');
});

test('an area the reader chose while the restore was still reading is kept', { skip }, async () => {
  const page = await heldReload();
  await chooseExampleArea(page);
  const chosen = await page.evaluate(readArea);
  assert.equal(chosen.title, EXAMPLE_AREA.label, 'sanity: the example area should be on screen before the restore lands');

  await releaseAndSettle(page);
  const after = await page.evaluate(readArea);
  assert.deepEqual(after, chosen, `the late restore replaced the reader's area with "${after.title}"`);
});

test('with no choice made, the held restore still brings back the last job', { skip }, async () => {
  const page = await heldReload();
  await releaseAndSettle(page);
  const after = await page.evaluate(readArea);
  assert.equal(after.title, OLD_JOB.title, 'the restore should still bring back the last saved job');
  assert.equal(after.minLon.toFixed(2), OLD_JOB.bbox.minLon.toFixed(2), 'the restored box should be the saved one');
});
