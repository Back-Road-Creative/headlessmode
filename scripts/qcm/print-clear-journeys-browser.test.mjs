// The print-selection Clear contract, proved as reader journeys (audit findings A03/A13).
//
// Clear removes the box, handles, selected quads, extension ring, sheet preview and the
// persisted recipe; leaves the map position and unrelated layers alone; takes the URL
// state with it when the area came from a URL; Undo puts back the exact previous
// selection once; removing the last quad lands in the same empty state as Clear.
//
// print-area-clear.test.mjs already holds the single transitions (box to quads, one quad
// removed, last quad then Undo, quad-set reload, v1 recipe). This file holds what it does
// not: a Clear that is followed by a reload before the IndexedDB delete has landed, a
// Clear that a slow restore then answers, and the whole sequence in one visit. Every
// action is a trusted press or wheel (helpers/trusted-click.mjs, Input.dispatch*);
// page state is read only for assertions, and IndexedDB is held by a stand-in installed
// before any page script runs (the technique late-restore-browser.test.mjs uses).
import { test, after } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { recipeFromControls, EXAMPLE_AREA } from '../../themes/headlessmode/static/js/quiet-corners-maps/app-state.js';
import { quadsCoveringBox } from '../../themes/headlessmode/static/js/quiet-corners-maps/geometry.js';
import { serializeRecipe } from '../../themes/headlessmode/static/js/quiet-corners-maps/sheet-plan.js';
import { DB_NAME, STORE, KEY, VERSION } from '../../themes/headlessmode/static/js/quiet-corners-maps/project-store.js';
import { findChromium, launch } from './helpers/browser.mjs';
import { trustedClick } from './helpers/trusted-click.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage, watchTimers, timersIdle } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt() ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

// view-wiring's routine writer: a trailing throttle of this length writes the map fragment
// (quiet-corners.js createRoutineWriter, waitMs).
const FRAGMENT_THROTTLE_MS = 400;

test('the fragment throttle the J02b wait watches is the one quiet-corners.js arms', () => {
  const app = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners.js', import.meta.url), 'utf8');
  const armed = /createRoutineWriter\(\{[\s\S]*?waitMs:\s*(\d+)/.exec(app)?.[1];
  assert.equal(Number(armed), FRAGMENT_THROTTLE_MS, 'quiet-corners.js routine writer waitMs moved: update FRAGMENT_THROTTLE_MS here');
});

const COVERING = quadsCoveringBox(EXAMPLE_AREA.bboxLonLat);

// Last session's job: a box nowhere near the example area, under its own title.
const OLD_JOB = { title: 'Old job', bbox: { minLon: -81.6, minLat: 36.6, maxLon: -81.45, maxLat: 36.7 } };
const OLD_TEXT = serializeRecipe(recipeFromControls(
  { orientation: 'portrait', scale: 24000, overlapIn: 0.5, dpi: 300, grid: 'none' }, OLD_JOB.bbox, OLD_JOB.title, null));

// ---- IndexedDB, held on demand -------------------------------------------------------

/** window.indexedDB replaced before any page script runs. While `window.__idb.held` is
 *  true every open() parks until `window.__idb.release()`; a page that is navigated away
 *  while parked never gets its request through, which is the slow disk this proves. */
const holdScript = (held) => `(() => {
  const real = window.indexedDB;
  let release;
  const gate = new Promise((r) => { release = r; });
  window.__idb = { held: ${held}, parked: 0, release: () => { window.__idb.held = false; release(); } };
  const fake = {
    open(name, version) {
      if (!window.__idb.held) return real.open(name, version);
      window.__idb.parked++;
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

const idbOp = (body) => `(async () => {
  const open = indexedDB.open(${JSON.stringify(DB_NAME)}, ${VERSION});
  open.onupgradeneeded = () => open.result.createObjectStore(${JSON.stringify(STORE)});
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error); });
  try {
    const store = db.transaction(${JSON.stringify(STORE)}, 'readwrite').objectStore(${JSON.stringify(STORE)});
    const req = ${body};
    return await new Promise((res, rej) => { req.onsuccess = () => res(req.result === undefined ? null : req.result); req.onerror = () => rej(req.error); });
  } finally { db.close(); }
})()`;
const storedText = idbOp(`store.get(${JSON.stringify(KEY)})`);
const dropStored = idbOp(`store.delete(${JSON.stringify(KEY)})`);
const putStored = (text) => idbOp(`store.put(${JSON.stringify(text)}, ${JSON.stringify(KEY)})`);

// ---- one browser for the file ---------------------------------------------------------

let shared = null;
async function sharedBrowser() {
  if (!shared) {
    const site = await startSiteServer();
    const page = await launch(CHROMIUM, 'about:blank', { args: ['--hide-scrollbars'], viewport: { width: 1440, height: 1000 } });
    shared = { site, page };
  }
  return shared;
}
after(async () => {
  if (!shared) return;
  shared.page.close();
  await shared.site.close();
});

/** A load of `path` with an empty IndexedDB (or `seed` stored), optionally with IndexedDB
 *  held from the first script on. The stand-in is removed again after the navigation so
 *  the NEXT document in this test loads against the real one. */
async function freshLoad({ path = '/quiet-corners/', seed = null, held = false } = {}) {
  const { site, page } = await sharedBrowser();
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: false });
  await page.evaluate(seed === null ? dropStored : putStored(seed));
  const { identifier } = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `${holdScript(held)}; ${watchTimers(FRAGMENT_THROTTLE_MS)}` });
  try {
    await page.navigate(`${site.origin}${path}`);
  } finally {
    await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  }
  return { site, page };
}

// ---- trusted-input steps ---------------------------------------------------------------

const press = (page, selector, opts = {}) => trustedClick(page, selector, { settleMs: 0, ...opts });

/** Opens the print builder like a reader does, then takes the example area. */
async function chooseExampleByPress(page) {
  await press(page, '#qcm-app > summary', { until: "document.getElementById('qcm-app').open" });
  await press(page, '#qcm-use-example');
  await waitInPage(page, 'the strip to show the chosen example area', "!document.getElementById('qcm-area-strip').hidden && document.getElementById('qcm-area-clear').disabled === false");
}
const pressClear = (page) => press(page, '#qcm-area-clear');
const pressUndo = (page) => press(page, '#qcm-area-undo');

const hasArea = `(() => ({
  stripHidden: document.getElementById('qcm-area-strip').hidden,
  clearDisabled: document.getElementById('qcm-area-clear').disabled,
  corners: ['qcm-min-lat', 'qcm-max-lat', 'qcm-min-lon', 'qcm-max-lon'].map((id) => document.getElementById(id).value),
  title: document.getElementById('qcm-title').value,
}))()`;

/** True once the page holds no area: nothing for Clear to act on, and no corners. */
const NO_AREA_EXPR = `(() => document.getElementById('qcm-area-clear').disabled === true
  && ['qcm-min-lat', 'qcm-max-lat', 'qcm-min-lon', 'qcm-max-lon'].every((id) => document.getElementById(id).value === ''))()`;

/** Everything Clear promises to take off the screen, as one comparable record. */
const emptyState = `(() => {
  const q = (s) => document.querySelectorAll(s).length;
  return {
    corners: ['qcm-min-lat', 'qcm-max-lat', 'qcm-min-lon', 'qcm-max-lon'].map((id) => document.getElementById(id).value),
    title: document.getElementById('qcm-title').value,
    handles: q('.qcm-handle'),
    selectedQuads: q('path.qcm-quad-selected'),
    ringCells: q('path[data-quad]:not(.qcm-quad-selected)'),
    selectionBox: q('#qc-map path.leaflet-interactive'),
    listHidden: document.getElementById('qcm-quad-list').hidden,
    listRows: q('#qcm-quad-list li'),
    sheetLabels: q('#qc-map .qcm-sheet-label'),
    pages: document.querySelector('#qcm-estimate dd[data-field="pages"]').textContent,
    stripText: document.getElementById('qcm-area-strip-text').textContent,
    editDisabled: document.getElementById('qcm-area-edit').disabled,
    clearDisabled: document.getElementById('qcm-area-clear').disabled,
    checkDisabled: document.getElementById('qcm-check').disabled,
  };
})()`;

/** Leaflet fades a removed tooltip out and drops its node 200 ms later (DivOverlay onRemove),
 *  so a sheet label read the instant after Clear or the last removal can still be on its way
 *  out. A label that never goes is a real leftover sheet preview: this wait then fails. */
const sheetPreviewGone = (page) => waitInPage(page, 'the sheet preview labels to leave the map',
  "document.querySelectorAll('#qc-map .qcm-sheet-label').length === 0", 5000);

const mapView = `(() => { const c = window.qcMap.getCenter(); return { lat: c.lat, lng: c.lng, zoom: window.qcMap.getZoom() }; })()`;

/** Ticks one overlay the way a reader does: open Layers, open the group, press the box.
 *  Trails is not part of the print area or its sources, so Clear has no business with it. */
async function pickUnrelatedLayer(page) {
  await press(page, '#qcm-layer-panel > summary', { until: "document.getElementById('qcm-layer-panel').open" });
  await press(page, 'details.qcm-layer-group:has(#qcm-layer-trails) > summary', { until: "document.querySelector('details.qcm-layer-group:has(#qcm-layer-trails)').open" });
  await press(page, '#qcm-layer-trails');
  assert.equal(await page.evaluate("document.getElementById('qcm-layer-trails').checked"), true, 'setup: the Trails overlay should be ticked');
  await press(page, '#qcm-layer-panel > summary', { until: "!document.getElementById('qcm-layer-panel').open" });
}

/** Presses one extend-ring cell that sits on screen and is not already selected. */
async function pressRingCell(page) {
  const covering = new Set(COVERING);
  const pressed = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const target = await page.evaluate(`(() => {
      const covering = new Set(${JSON.stringify(COVERING)});
      const m = document.getElementById('qc-map').getBoundingClientRect();
      const on = (r) => r.width > 0 && r.height > 0 && r.x + r.width / 2 > m.x + 8 && r.x + r.width / 2 < m.right - 8
        && r.y + r.height / 2 > m.y + 8 && r.y + r.height / 2 < m.bottom - 8;
      // Pressable: the point at its centre is the cell itself, not a panel or control over it.
      const open = (e) => { const r = e.getBoundingClientRect(); const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return at === e; };
      const el = [...document.querySelectorAll('#qc-map path[data-quad]:not(.qcm-quad-selected)')]
        .find((e) => !covering.has(e.getAttribute('data-quad')) && on(e.getBoundingClientRect()) && open(e));
      return el ? el.getAttribute('data-quad') : null;
    })()`);
    assert.ok(target, 'expected an on-screen extend-ring cell outside the example area to press');
    await page.evaluate(`(() => { window.__hit = null; document.addEventListener('click', (e) => {
      const c = e.target.closest?.('[data-quad]'); window.__hit = c ? c.getAttribute('data-quad') + (c.classList.contains('qcm-quad-selected') ? ':selected' : '') : 'none'; }, { capture: true, once: true }); })()`);
    await press(page, `path[data-quad="${target}"]`);
    const hit = await page.evaluate('window.__hit');
    pressed.push(`${target}->${hit}`);
    assert.ok(!String(hit).endsWith(':selected') && !covering.has(hit), `the press aimed at ${target} landed on selected quad ${hit}`);
    if (hit && hit !== 'none') return;
  }
  assert.fail(`no press reached an extend-ring cell (presses: ${pressed.join(', ')})`);
}

const quadIds = `[...document.querySelectorAll('#qcm-quad-list li')].map((li) => li.dataset.quad)`;

// ---- J02a: Clear, then reload before the IndexedDB delete has landed -----------------

test('J02a: Clear then an immediate reload, with the IndexedDB delete still waiting, does not bring the area back', { skip }, async () => {
  const { page } = await freshLoad({ held: false });
  await readyDashboard(page, { data: false });
  await chooseExampleByPress(page);
  await waitInPage(page, 'the chosen area to reach IndexedDB',
    `${storedText}.then((t) => typeof t === 'string')`);

  // From here every IndexedDB open parks: the delete Clear sends cannot get through.
  await page.evaluate('window.__idb.held = true; true');
  await pressClear(page);
  assert.ok(await page.evaluate('window.__idb.parked >= 1'), 'setup: Clear never reached IndexedDB, so this proves nothing about its delete');
  assert.equal(await page.evaluate(NO_AREA_EXPR), true, 'setup: Clear should have emptied the page');

  // The reader reloads at once. The stand-in goes with the page; the next document sees
  // the real database, still holding the recipe the delete never reached.
  const url = await page.evaluate('location.href');
  await page.navigate(url);
  await readyDashboard(page, { data: false });
  const after = await page.evaluate(hasArea);
  assert.equal(after.stripHidden, true, `the area Clear removed came back after the reload (title "${after.title}")`);
  assert.deepEqual(after.corners, ['', '', '', ''], 'the reload repainted the cleared box');
});

// ---- J02b: an area that came from the URL ----------------------------------------------

const HANDOFF = '?v=1&lat=35.03&lon=-83.53&w=8&label=Shared+place';
// The shared link's map fragment (view, base layer): not part of the print area, so Clear leaves
// it. The page rewrites it as the map settles on the area, so the test reads the settled one.
const FRAGMENT = '#map=v1&z=9&c=36.1,-82.5&b=usgsTopo';

test('J02b: Clear on an area restored from a shared URL, with the delete still waiting, then a reload: no area, no area params, the map fragment kept', { skip }, async () => {
  const { page } = await freshLoad({ path: `/quiet-corners/${HANDOFF}${FRAGMENT}` });
  await readyDashboard(page, { data: false });
  const landed = await page.evaluate(hasArea);
  assert.equal(landed.stripHidden, false, 'setup: the shared URL should land with its area');
  assert.equal(landed.title, 'Shared place', 'setup: the area should carry the URL\'s label');
  await waitInPage(page, 'the shared area to reach IndexedDB', `${storedText}.then((t) => typeof t === 'string')`);
  // The move onto the area reaches the fragment through view-wiring's routine writer, a
  // trailing 400ms throttle: wait for the rewrite, then for a full throttle window with no
  // further change, so the fragment Clear is held to is the settled one, not the link's.
  await waitInPage(page, 'the map to settle on the shared area and rewrite its fragment',
    `location.hash.startsWith('#map=') && location.hash !== ${JSON.stringify(FRAGMENT)}`);
  // The condition is the writer's own timer: none pending, and the fragment the same on two
  // polls running, so a move that arms another write is waited out instead of raced.
  await waitInPage(page, 'the map fragment to hold still, the throttled writer idle', `(() => {
    const same = window.__fragmentSeen === location.hash;
    window.__fragmentSeen = location.hash;
    return same && ${timersIdle(FRAGMENT_THROTTLE_MS)};
  })()`);
  const fragment = await page.evaluate('location.hash');
  assert.ok(fragment.startsWith('#map='), `setup: the shared link's map fragment should still be there, got "${fragment}"`);
  const view = await page.evaluate(mapView);

  // From here every IndexedDB open parks: the delete Clear sends cannot get through.
  await page.evaluate('window.__idb.held = true; true');
  await press(page, '#qcm-app > summary', { until: "document.getElementById('qcm-app').open" });
  await pressClear(page);
  assert.ok(await page.evaluate('window.__idb.parked >= 1'), 'setup: Clear never reached IndexedDB, so this proves nothing about its delete');
  const search = await page.evaluate('location.search');
  for (const key of ['v', 'lat', 'lon', 'w', 'label']) assert.ok(!search.includes(`${key}=`), `Clear left "${key}" in the URL: ${search}`);
  assert.equal(await page.evaluate('location.hash'), fragment, 'Clear dropped the map fragment, which is not print-area state');

  // Reload the address bar as Clear left it, at once: the stripped URL now takes the saved-
  // recipe path, and the delete that would empty it never ran.
  // (Through about:blank: the address still has its fragment, so navigating straight to it
  // would be a same-document jump, not a fresh load.)
  const href = await page.evaluate('location.href');
  await page.navigate('about:blank');
  await page.navigate(href);
  await readyDashboard(page, { data: false });
  const after = await page.evaluate(hasArea);
  assert.equal(after.stripHidden, true, `the shared area came back after Clear and a reload (title "${after.title}")`);
  assert.deepEqual(after.corners, ['', '', '', ''], 'the reload repainted the cleared box');
  assert.equal(await page.evaluate('location.search'), '', 'the reload should leave no query string behind');
  assert.equal(await page.evaluate('location.hash'), fragment, 'the reload lost the map fragment');
  const reloaded = await page.evaluate(mapView);
  assert.ok(Math.abs(reloaded.lat - view.lat) < 0.01 && Math.abs(reloaded.lng - view.lng) < 0.01 && reloaded.zoom === view.zoom,
    `the reload lost the shared map view: ${JSON.stringify(view)} became ${JSON.stringify(reloaded)}`);
});

test('J02d: Clear on the ?fixture=standing-indian area takes the fixture param with it, so a reload stays empty', { skip }, async () => {
  const { page } = await freshLoad({ path: '/quiet-corners/?fixture=standing-indian' });
  await readyDashboard(page, { data: false });
  assert.equal((await page.evaluate(hasArea)).stripHidden, false, 'setup: the fixture URL should land with its area');
  await press(page, '#qcm-app > summary', { until: "document.getElementById('qcm-app').open" });
  await pressClear(page);
  assert.ok(!(await page.evaluate('location.search')).includes('fixture'), 'Clear left ?fixture= in the URL');
  await page.navigate(await page.evaluate('location.href'));
  await readyDashboard(page, { data: false });
  const after = await page.evaluate(hasArea);
  assert.equal(after.stripHidden, true, `the fixture area came back after Clear and a reload (title "${after.title}")`);
});

// ---- J02c: a slow restore that answers after Clear -------------------------------------

test('J02c: a restore that is still reading when the reader clears does not repaint the cleared area', { skip }, async () => {
  const { page } = await freshLoad({ seed: OLD_TEXT, held: true });
  await readyDashboard(page, { data: false, restored: false });
  assert.ok(await page.evaluate('window.__idb.parked >= 1'), 'setup: the restore never opened IndexedDB');

  await chooseExampleByPress(page);
  assert.equal((await page.evaluate(hasArea)).title, EXAMPLE_AREA.label, 'setup: the example area should be on screen');
  await pressClear(page);
  assert.equal(await page.evaluate(NO_AREA_EXPR), true, 'setup: Clear should have emptied the page');

  // The disk answers: the restore finds last session's job and, finding no area, paints it.
  await page.evaluate('window.__idb.release()');
  await waitInPage(page, 'the late restore to settle (window.qcRestoreSettled)', 'window.qcRestoreSettled === true');
  const after = await page.evaluate(emptyState);
  assert.deepEqual(after.corners, ['', '', '', ''], `the late restore repainted "${OLD_JOB.title}" over the cleared selection`);
  assert.equal(after.handles, 0, 'the late restore drew handles after Clear');
  assert.equal(after.clearDisabled, true, 'the late restore left an area for Clear to act on');
});

// ---- J01x: the whole contract in one visit ---------------------------------------------

test('J01x: Clear then Undo gives back the exact quads once; the layer choice and map view never move; the last quad removed is the same empty state as Clear', { skip }, async () => {
  const { page } = await freshLoad({});
  await readyDashboard(page, { data: false });
  await chooseExampleByPress(page);
  // The open builder panel sits over part of the map; close it so the ring is pressable.
  await press(page, '#qcm-app > summary', { until: "!document.getElementById('qcm-app').open" });
  await pressRingCell(page);
  await waitInPage(page, 'the quad list to hold the selected quads', `(${quadIds}).length >= ${COVERING.length + 1}`);
  const ids = await page.evaluate(quadIds);
  assert.ok(ids.length > COVERING.length && COVERING.every((id) => ids.includes(id)), `setup: expected the example's quads plus the pressed one, got ${ids}`);
  await pickUnrelatedLayer(page);
  const view = await page.evaluate(mapView);
  const stored = await page.evaluate(storedText);
  assert.equal(typeof stored, 'string', 'setup: the chosen quads should have reached IndexedDB');

  // Clear: the selection goes, the map and the layer stay.
  await pressClear(page);
  assert.equal(await page.evaluate(NO_AREA_EXPR), true, 'Clear should empty the page');
  await sheetPreviewGone(page);
  const cleared = await page.evaluate(emptyState);
  assert.equal(cleared.handles + cleared.selectedQuads + cleared.ringCells + cleared.selectionBox + cleared.listRows, 0,
    `Clear left selection drawing behind: ${JSON.stringify(cleared)}`);
  assert.equal(cleared.listHidden, true, 'Clear should hide the quad list');
  assert.deepEqual(await page.evaluate(mapView), view, 'Clear moved the map');
  assert.equal(await page.evaluate("document.getElementById('qcm-layer-trails').checked"), true, 'Clear unticked an unrelated layer');
  await waitInPage(page, 'the persisted recipe to be deleted', `${storedText}.then((t) => t === null)`);

  // Undo: exactly the quads that were selected, once.
  await pressUndo(page);
  await waitInPage(page, 'Undo to restore the quad list', `(${quadIds}).length === ${ids.length}`);
  const restored = await page.evaluate(`({ ids: ${quadIds}, handles: document.querySelectorAll('.qcm-handle').length,
    undoDisabled: document.getElementById('qcm-area-undo').disabled })`);
  assert.deepEqual([...restored.ids].sort(), [...ids].sort(), 'Undo did not restore exactly the quads Clear removed');
  assert.equal(restored.handles, 0, 'Undo restored quads mode with box handles');
  assert.equal(restored.undoDisabled, true, 'Undo is one step: it should disable itself once used');
  assert.deepEqual(await page.evaluate(mapView), view, 'Undo moved the map');
  assert.equal(await page.evaluate("document.getElementById('qcm-layer-trails').checked"), true, 'Undo unticked an unrelated layer');
  await pressUndo(page);
  assert.deepEqual([...(await page.evaluate(quadIds))].sort(), [...ids].sort(), 'a second Undo changed the selection');

  // Removing quads one by one: each removal takes only its own quad; the last lands where Clear did.
  await press(page, '#qcm-app > summary', { until: "document.getElementById('qcm-app').open" });
  let left = [...ids];
  while (left.length > 1) {
    const gone = left[0];
    await press(page, `#qcm-quad-list li[data-quad="${gone}"] button`);
    left = left.slice(1);
    await waitInPage(page, `only ${gone} to leave the list`, `(${quadIds}).length === ${left.length}`);
    assert.deepEqual([...(await page.evaluate(quadIds))].sort(), [...left].sort(), `removing ${gone} changed another quad`);
  }
  await press(page, `#qcm-quad-list li[data-quad="${left[0]}"] button`);
  await waitInPage(page, 'the last removal to empty the page', NO_AREA_EXPR);
  await sheetPreviewGone(page);
  const lastRemoved = await page.evaluate(emptyState);
  assert.deepEqual(lastRemoved, cleared, 'removing the last quad did not reach the same empty state as Clear');
  await waitInPage(page, 'the persisted recipe to be deleted', `${storedText}.then((t) => t === null)`);
  assert.deepEqual(await page.evaluate(mapView), view, 'removing quads moved the map');
  assert.equal(await page.evaluate("document.getElementById('qcm-layer-trails').checked"), true, 'removing quads unticked an unrelated layer');
});
