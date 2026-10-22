// Print area Clear/Undo state transitions (QUX-01). Pure, DOM-free proofs for the
// three transitions main.js wires to the Clear/Undo/Edit strip: setting an area,
// clearing it, and undoing exactly one clear -- a second Undo is a no-op, matching
// the existing layer-preset Undo contract (content/quiet-corners-maps.md:26).
//
// The browser-proof tests below drive the real built app the same way
// names-keyboard.test.mjs and layout.test.mjs do -- headless Chromium over the
// DevTools protocol, one launch() shared for the whole file (helpers/browser.mjs's
// sharedBrowser()/withPage() pattern, GATES.md "one launch() per file").
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_AREA, areaSet, areaCleared, areaUndone, areaFromBox, areaFromQuads, quadToggled, quadSavings,
  recipeFromControls, EXAMPLE_AREA,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/app-state.js';
import { bboxOfCells, cellFromId, quadsCoveringBox } from '../../themes/headlessmode/static/js/quiet-corners-maps/geometry.js';
import { serializeRecipe } from '../../themes/headlessmode/static/js/quiet-corners-maps/sheet-plan.js';
import { DB_NAME, STORE, KEY, VERSION } from '../../themes/headlessmode/static/js/quiet-corners-maps/project-store.js';
import { findChromium, launch } from './helpers/browser.mjs';
import { trustedClick as pressWhenStill } from './helpers/trusted-click.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, chooseExampleArea, waitInPage } from './helpers/waits.mjs';

// QUX-10b renamed the generic `{area, title, undo}` shape's field from `.bbox` to
// `.area` (app-state.js) so a box selection and a quad-set selection go through the
// exact same transitions -- explicitly sanctioned by plan §2. The 4 tests below are
// otherwise unchanged from QUX-01/10a: same transitions, same one-step Undo contract.
test('areaSet: first area has no undo; a second areaSet captures the first as undo', () => {
  const s1 = areaSet(NO_AREA, { minLat: 1, minLon: 2, maxLat: 3, maxLon: 4 }, 'A');
  assert.equal(s1.undo, null);
  const s2 = areaSet(s1, { minLat: 5, minLon: 6, maxLat: 7, maxLon: 8 }, 'B');
  assert.deepEqual(s2.undo, { area: s1.area, title: 'A' });
  assert.deepEqual(s2.area, { minLat: 5, minLon: 6, maxLat: 7, maxLon: 8 });
});

test('areaCleared: captures the cleared area as undo; clearing empty is a no-op', () => {
  const s1 = areaSet(NO_AREA, { minLat: 1, minLon: 2, maxLat: 3, maxLon: 4 }, 'A');
  const c = areaCleared(s1);
  assert.deepEqual(c, { area: null, title: null, undo: { area: s1.area, title: 'A' } });
  assert.equal(areaCleared(NO_AREA), NO_AREA);
});

test('areaUndone: restores exactly once; a second undo is a no-op (matches content/quiet-corners-maps.md:26 contract)', () => {
  const s1 = areaSet(NO_AREA, { minLat: 1, minLon: 2, maxLat: 3, maxLon: 4 }, 'A');
  const c = areaCleared(s1);
  const u = areaUndone(c);
  assert.deepEqual(u, { area: s1.area, title: 'A', undo: null });
  assert.deepEqual(areaUndone(u), u);
});

test('areaSet after Undo does not resurrect the just-undone area a second time', () => {
  const s1 = areaSet(NO_AREA, { minLat: 1, minLon: 2, maxLat: 3, maxLon: 4 }, 'A');
  const u = areaUndone(areaCleared(s1));
  const s2 = areaSet(u, { minLat: 9, minLon: 9, maxLat: 10, maxLon: 10 }, 'C');
  assert.deepEqual(s2.undo, { area: s1.area, title: 'A' });
});

// --- QUX-10b: quadToggled (pure selection-model transitions, §2) -------------------

const Q_NW = '280:-669', Q_NE = '280:-668', Q_SW = '279:-669';

test('quadToggled: no area -> a single-quad selection', () => {
  assert.deepEqual(quadToggled(null, Q_NW), areaFromQuads([Q_NW]));
});

test('quadToggled: quads mode adds an id not yet selected', () => {
  const area = areaFromQuads([Q_NW]);
  assert.deepEqual(quadToggled(area, Q_NE), areaFromQuads([Q_NW, Q_NE]));
});

test('quadToggled: quads mode removes an id already selected', () => {
  const area = areaFromQuads([Q_NW, Q_NE]);
  assert.deepEqual(quadToggled(area, Q_NE), areaFromQuads([Q_NW]));
});

test('quadToggled: removing the last remaining quad returns null (== Clear, §2)', () => {
  const area = areaFromQuads([Q_NW]);
  assert.equal(quadToggled(area, Q_NW), null);
});

test('quadToggled: box mode snaps outward to the quads it covers, plus id (D3)', () => {
  const bbox = bboxOfCells([Q_NW, Q_NE].map(cellFromId));
  const area = areaFromBox(bbox);
  assert.deepEqual(quadToggled(area, Q_SW), areaFromQuads([Q_NW, Q_NE, Q_SW]));
});

// --- QUX-10b: quadSavings (per-quad page-count deltas, §3) -------------------------

// A 3x3 block of quads, rows 281..279 (north to south) x cols -670..-668 (west to
// east) -- fresh cells (not EXAMPLE_AREA's own 280/-669..-668 pair) so a corner,
// an edge and the centre of the block are all represented among the 9 ids.
const BLOCK3_IDS = [281, 280, 279].flatMap((row) => [-670, -669, -668].map((col) => `${row}:${col}`));
const BLOCK3_CONTROLS = { orientation: 'portrait', scale: 48000, overlapIn: 0.5, dpi: 300, grid: 'none' };
// Recipes built through recipeFromControls, the same path main.js's replan() uses,
// rather than a hand-written literal -- quadSavings copies every DEFAULTS field
// straight off the recipe it is given (app-state.js quadSavings), so a fixture
// missing one (paper, insetIn, maxPages, ...) throws "paper must be a string"
// rather than testing the behaviour this unit actually cares about.
const recipeFor = (ids, controls = BLOCK3_CONTROLS) => recipeFromControls(controls, bboxOfCells(ids.map(cellFromId)), 'Savings test', ids);

test('quadSavings: 3x3 block at 1:48,000 -- corners save 1, edges and centre save 0 (§3 table)', () => {
  const savings = quadSavings(recipeFor(BLOCK3_IDS));
  const corner = '281:-670', edge = '281:-669', centre = '280:-669';
  assert.equal(savings[corner], 1, `corner ${corner} should save 1 page, got ${savings[corner]}`);
  assert.equal(savings[edge], 0, `edge ${edge} should save 0 pages, got ${savings[edge]}`);
  assert.equal(savings[centre], 0, `centre ${centre} should save 0 pages, got ${savings[centre]}`);
});

test('quadSavings: an L of 3 over the 24-page limit at 1:24,000 still answers (raised maxPages)', () => {
  const ids = [Q_NW, Q_NE, Q_SW]; // 2x2 envelope missing the SE corner
  const savings = quadSavings(recipeFor(ids, { ...BLOCK3_CONTROLS, scale: 24000 }));
  for (const id of ids) assert.equal(typeof savings[id], 'number', `expected a numeric savings value for ${id}, got ${savings[id]}`);
});

test('quadSavings: removing the last remaining quad reports null ("clears the area")', () => {
  assert.deepEqual(quadSavings(recipeFor([Q_NW])), { [Q_NW]: null });
});

// --- Browser proofs: the real built app, not the pure functions above --------------

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt() ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const CORNER_IDS = ['qcm-min-lat', 'qcm-max-lat', 'qcm-min-lon', 'qcm-max-lon'];
const readCorners = `(() => (${JSON.stringify(CORNER_IDS)}.map((id) => document.getElementById(id).value)))()`;

/** The on-screen box an element occupies right now, scrolled into view first so a
 *  trusted click below lands on real screen coordinates rather than an off-screen
 *  guess. `visible` mirrors checkVisibility() where the page has it (Chromium
 *  does); a `[hidden]` ancestor or `display:none` collapses the rect to 0x0
 *  either way, which is what a trusted click on the (still-existing, but
 *  invisible) Undo button after Clear must catch -- `page.evaluate("…click()")`
 *  cannot, because Element.click() fires regardless of visibility. */
async function boundingBox(page, id) {
  return page.evaluate(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return { missing: true, x: 0, y: 0, width: 0, height: 0, visible: false };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const visible = typeof el.checkVisibility === 'function' ? el.checkVisibility() : (r.width > 0 && r.height > 0);
    return { missing: false, x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height, visible };
  })()`);
}

/** A REAL, trusted click on `#id` -- helpers/trusted-click.mjs's press, which lands
 *  only once the target is on screen, uncovered and holding still, and throws on a
 *  missing or zero-size target rather than clicking (0, 0). isTrusted is true, so a
 *  hidden element cannot be "clicked" by naming its id, exactly like the reader this
 *  bug actually blocked. This file's copy never waited after the press; nor does this. */
const trustedClick = (page, id) => pressWhenStill(page, `#${id}`, { settleMs: 0 });

/** Reads the saved recipe straight out of the page's IndexedDB: `true` once
 *  nothing is stored under the store's one key. */
const recipeStored = `(async () => {
  const open = indexedDB.open(${JSON.stringify(DB_NAME)}, ${VERSION});
  open.onupgradeneeded = () => open.result.createObjectStore(${JSON.stringify(STORE)});
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error); });
  try {
    const req = db.transaction(${JSON.stringify(STORE)}, 'readonly').objectStore(${JSON.stringify(STORE)}).get(${JSON.stringify(KEY)});
    const value = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
    return value !== undefined;
  } finally { db.close(); }
})()`;

/** clearArea() (main.js) calls store.clear() -- an IndexedDB delete it does not
 *  await -- and the tests below reload right after the click. Under runner load
 *  the reload can beat that delete, the page restores the not-yet-deleted recipe,
 *  and the "no area after reload" read goes red (PR CI run 36462994234, and the
 *  same test on 09a's branch earlier). Wait for the delete to land first; the
 *  assertion after the reload is unchanged. */
async function waitForRecipeState(page, stored, message) {
  for (let i = 0; i < 50; i++) {
    if ((await page.evaluate(recipeStored)) === stored) return;
    await page.evaluate('new Promise(r => setTimeout(r, 100))');
  }
  assert.fail(message);
}
const waitForRecipeCleared = (page) => waitForRecipeState(page, false, 'the saved recipe was still in IndexedDB 5 s after Clear');
const waitForRecipeStored = (page) => waitForRecipeState(page, true, 'no saved recipe reached IndexedDB 5 s after the area was chosen');

let shared = null;

async function sharedBrowser() {
  if (!shared) {
    const site = await startSiteServer();
    const page = await launch(CHROMIUM, `${site.origin}/quiet-corners/`, { args: ['--hide-scrollbars'] });
    shared = { site, page };
  }
  return shared;
}

after(async () => {
  if (!shared) return;
  shared.page.close();
  await shared.site.close();
});

test('Clear removes the area, the strip, ring targets and the saved recipe; reload shows no area', { skip }, async () => {
  const { site, page } = await sharedBrowser();
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: false });
  await chooseExampleArea(page);

  const before = await page.evaluate(`(() => ({
    stripHidden: document.getElementById('qcm-area-strip').hidden,
    handles: document.querySelectorAll('.qcm-handle').length,
    interactivePaths: document.querySelectorAll('#qc-map path.leaflet-interactive').length,
  }))()`);
  assert.equal(before.stripHidden, false, 'the strip should show once the example area is chosen');
  assert.equal(before.handles, 2, 'expected both drag handles on the map once an area is set');
  assert.ok(before.interactivePaths > 1,
    `expected the selection rectangle plus ring-cell targets drawn on the map, got ${before.interactivePaths} interactive path(s)`);
  // Proves the IndexedDB probe reads the store the page writes -- otherwise the
  // post-Clear wait below could pass vacuously.
  await waitForRecipeStored(page);

  await page.evaluate("document.getElementById('qcm-area-clear').click()");
  const after = await page.evaluate(`(() => ({
    stripHidden: document.getElementById('qcm-area-strip').hidden,
    stripText: document.getElementById('qcm-area-strip-text').textContent,
    undoDisabled: document.getElementById('qcm-area-undo').disabled,
    editReachable: !document.getElementById('qcm-area-edit').hidden && !document.getElementById('qcm-area-edit').disabled,
    clearReachable: !document.getElementById('qcm-area-clear').hidden && !document.getElementById('qcm-area-clear').disabled,
    corners: ${readCorners},
    title: document.getElementById('qcm-title').value,
    handles: document.querySelectorAll('.qcm-handle').length,
    interactivePaths: document.querySelectorAll('#qc-map path.leaflet-interactive').length,
  }))()`);
  // The strip must stay reachable after Clear -- Undo lives inside it, and Undo
  // is the only way back to the area Clear just removed (content/quiet-corners-maps.md:13,207).
  assert.equal(after.stripHidden, false, 'the strip should stay visible after Clear so Undo can be reached');
  assert.equal(after.undoDisabled, false, 'Undo should be enabled right after Clear');
  assert.match(after.stripText, /clear/i, 'the strip text should say the area was cleared, not the generic "selected"');
  assert.equal(after.editReachable, false, 'Edit should be hidden or disabled -- there is no area left to edit');
  assert.equal(after.clearReachable, false, 'Clear should be hidden or disabled -- there is nothing left to clear');
  assert.deepEqual(after.corners, ['', '', '', ''], 'Clear should blank all four coordinate inputs');
  assert.equal(after.title, '', 'Clear should blank the title');
  assert.equal(after.handles, 0, 'Clear should remove both drag handles');
  assert.equal(after.interactivePaths, 0, 'Clear should remove the selection rectangle and every ring-cell target');

  // Reload: clearArea() also calls store.clear(), so nothing is left to restore.
  await waitForRecipeCleared(page);
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: false });
  assert.equal(await page.evaluate("document.getElementById('qcm-area-strip').hidden"), true,
    'a reload after Clear should show no area -- the saved recipe was cleared too');
});

test('Undo restores the exact cleared area once; a second Undo is a no-op', { skip }, async () => {
  const { site, page } = await sharedBrowser();
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: false });
  await chooseExampleArea(page);

  const original = await page.evaluate(readCorners);

  await page.evaluate("document.getElementById('qcm-area-clear').click()");
  assert.equal(await page.evaluate("document.getElementById('qcm-area-undo').disabled"), false,
    'Undo should be enabled right after Clear');

  await page.evaluate("document.getElementById('qcm-area-undo').click()");
  const restored = await page.evaluate(`(() => ({
    stripHidden: document.getElementById('qcm-area-strip').hidden,
    text: document.getElementById('qcm-area-strip-text').textContent,
    corners: ${readCorners},
    undoDisabled: document.getElementById('qcm-area-undo').disabled,
  }))()`);
  assert.equal(restored.stripHidden, false, 'the strip should show again once Undo restores the area');
  assert.equal(restored.text, 'Print area restored',
    'Undo should announce the restore distinctly from a plain area selection');
  assert.deepEqual(restored.corners, original, 'Undo should restore the exact coordinates Clear removed');
  assert.equal(restored.undoDisabled, true, 'Undo should disable itself once used -- one step, no further back');

  await page.evaluate("document.getElementById('qcm-area-undo').click()");
  const secondClick = await page.evaluate(`(() => ({
    corners: ${readCorners},
    undoDisabled: document.getElementById('qcm-area-undo').disabled,
  }))()`);
  assert.deepEqual(secondClick.corners, original, 'a second Undo must not change the already-restored coordinates');
  assert.equal(secondClick.undoDisabled, true, 'a second Undo is a no-op -- Undo stays disabled');
});

test('a real click can reach Undo after Clear (trusted CDP click, not page.evaluate click())', { skip }, async () => {
  const { site, page } = await sharedBrowser();
  // Wide enough that the strip sits in its desktop absolute-position lane
  // (quiet-corners-maps.css:236-241) rather than mobile normal flow, so its
  // on-screen box is predictable regardless of how far down the panels run.
  await page.setViewport({ width: 1280, height: 900 });
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: false });
  await chooseExampleArea(page);
  const original = await page.evaluate(readCorners);

  await trustedClick(page, 'qcm-area-clear');

  const undoBox = await boundingBox(page, 'qcm-area-undo');
  assert.equal(undoBox.missing, false, 'the Undo button should still exist in the DOM after Clear');
  assert.ok(undoBox.visible, `Undo should be reachable (checkVisibility()) right after a real Clear click, got ${JSON.stringify(undoBox)}`);
  assert.ok(undoBox.width > 0 && undoBox.height > 0,
    `Undo should have a non-zero on-screen box right after a real Clear click, got ${JSON.stringify(undoBox)}`);
  const undoDisabled = await page.evaluate("document.getElementById('qcm-area-undo').disabled");
  assert.equal(undoDisabled, false, 'Undo should be enabled, not just present, right after a real Clear click');

  await trustedClick(page, 'qcm-area-undo');

  const restoredCorners = await page.evaluate(readCorners);
  assert.deepEqual(restoredCorners, original, 'a real Undo click should restore the exact corners Clear removed');
});

test('reload after Clear via the county-finder handoff query shows no area', { skip }, async () => {
  const { site, page } = await sharedBrowser();
  const handoffUrl = `${site.origin}/quiet-corners/?v=1&lat=35.03&lon=-83.53&w=8&label=Test`;
  await page.navigate(handoffUrl);
  await readyDashboard(page, { data: false });

  assert.equal(await page.evaluate("document.getElementById('qcm-area-strip').hidden"), false,
    'a county-finder handoff should land with the proposed area already shown');

  await page.evaluate("document.getElementById('qcm-area-clear').click()");
  const search = await page.evaluate('location.search');
  for (const key of ['v', 'lat', 'lon', 'w', 'label']) {
    assert.ok(!search.includes(`${key}=`), `Clear should strip "${key}" from the handoff query, got: ${search}`);
  }
  // Same rule as the "Clear removes the area..." test above: the strip stays up so
  // Undo (which just captured the handoff-proposed area) can be reached.
  assert.equal(await page.evaluate("document.getElementById('qcm-area-strip').hidden"), false,
    'the strip should stay visible after Clear so Undo can be reached');
  assert.equal(await page.evaluate("document.getElementById('qcm-area-undo').disabled"), false,
    'Undo should be enabled right after Clear');

  // Reload the URL Clear actually left behind (stripAreaHandoffParams already removed
  // the handoff params via history.replaceState) -- not the original handoff link, which
  // would legitimately re-propose the same area again by design: a handoff always wins
  // over a saved recipe, on purpose, so a bookmarked or re-clicked county-finder link
  // keeps working. What Clear promises is that nothing is left to restore on its own.
  const strippedUrl = await page.evaluate('location.href');
  await waitForRecipeCleared(page);
  await page.navigate(strippedUrl);
  await readyDashboard(page, { data: false });
  assert.equal(await page.evaluate("document.getElementById('qcm-area-strip').hidden"), true,
    'a reload of the post-Clear URL should show no area -- the saved recipe was cleared too');
});

// --- QUX-10b: quads-mode browser proofs (§5) ----------------------------------------

/** The same press addressed by a CSS selector -- the quads-mode targets (a selected
 *  quad's own <path>, a ring cell, a quad-list row) are not id'd elements, they are
 *  found by their `data-quad` attribute (main.js drawQuadSelection/renderQuadUI, both
 *  QUX-10b). The ring cells move while the map settles after setScale; one sample then
 *  a click missed the cell under CI load, so the list never converted -- #643 run
 *  36587629762, 'the quad list to hold a row for every covering quad ...' after 60 s. */
const trustedClickSelector = (page, selector) => pressWhenStill(page, selector, { settleMs: 0 });

// The example area's own covering quads -- computed with the real geometry function
// rather than a hand-typed literal, so a change to CELL_DEG or EXAMPLE_AREA's bbox
// fails this file loudly instead of silently drifting from it.
const COVERING = quadsCoveringBox(EXAMPLE_AREA.bboxLonLat);

/** Sets the map scale through a real change event -- the same wiring a reader's own
 *  <select> fires (main.js's CONTROL_KEY listener). */
async function setScale(page, scale) {
  await page.evaluate(`(() => {
    const el = document.getElementById('qcm-scale');
    el.value = ${JSON.stringify(String(scale))};
    el.dispatchEvent(new Event('change'));
  })()`);
}

/** Chooses the example area, sets 1:48,000, then clicks the first extend-ring cell
 *  that is not already one of the area's own covering quads -- the D3 box->quads
 *  conversion. Returns the 3 ids now selected (COVERING plus the clicked one, the
 *  clicked one last). */
async function enterQuadsModeFromExample(page, site) {
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: false });
  // #qcm-app (the print builder) stays closed here on purpose. It is a <details>
  // that starts closed (audit F01 -- opening it must never cost the map width),
  // but it is also `position: absolute` over `.qc-map-container` (the "sticky
  // map box"): at wide viewports its open content sits at a higher z-order than
  // parts of the map that are still geometrically inside #qc-map's own rect, so
  // a trusted click aimed at a ring/map-path target can land on the panel
  // instead (confirmed via elementFromPoint). Callers that need a trusted click
  // on a panel-interior element (e.g. a #qcm-quad-list Remove button) open it
  // themselves, right before that click, the way find-and-scale.test.mjs does
  // for controls inside it.
  await chooseExampleArea(page);
  await setScale(page, 48000);
  // Leaflet's SVG renderer draws every shape in its own unclipped coordinate space --
  // `.leaflet-container` clips what's actually visible with `overflow: hidden`, but
  // getBoundingClientRect() on a ring cell still reports its full (possibly
  // off-map) geometry. A ring cell whose rect only barely overlaps the map (or not
  // at all) yields a center point outside the map's own on-screen box, so a
  // trusted click there misses the map entirely. Filter to cells whose center
  // actually falls inside #qc-map's rect, not just "first one found".
  const pickTarget = () => page.evaluate(`(() => {
    const covering = new Set(${JSON.stringify(COVERING)});
    const mapRect = document.getElementById('qc-map').getBoundingClientRect();
    const onMap = (r) => r.width > 0 && r.height > 0
      && (r.x + r.width / 2) >= mapRect.x && (r.x + r.width / 2) <= mapRect.x + mapRect.width
      && (r.y + r.height / 2) >= mapRect.y && (r.y + r.height / 2) <= mapRect.y + mapRect.height;
    // Never a selected quad: #646 run 36621545215 found the previous test's saved quads
    // restored under the example box (the pre-#650 late restore), picked the selected
    // 281:-670 and removed it. Only an extend/ring cell is a conversion target.
    const el = [...document.querySelectorAll('#qc-map path[data-quad]:not(.qcm-quad-selected)')]
      .find((e) => !covering.has(e.getAttribute('data-quad')) && onMap(e.getBoundingClientRect()));
    return el ? el.getAttribute('data-quad') : null;
  })()`);
  // Each ring cell's click handler adds its own id (main.js drawQuadSelection), so the
  // cell that gets added is whichever path the press reached -- and under CI load that
  // was not always the one measured a moment before: #646 run 36603618563 aimed at
  // 279:-670 and added its neighbour 280:-670, and a second press added nothing. So a
  // capture listener records the cell the press actually hit, and the helper carries
  // on from that cell: any extend-ring cell is what the D3 conversion needs. A press
  // that reached no cell is retried on a fresh target; one that reached a covering
  // quad would have changed the selection, so it fails, naming the cell.
  const covering = new Set(COVERING);
  let added = null, pressed = [];
  for (let attempt = 0; attempt < 3 && !added; attempt++) {
    const target = await pickTarget();
    if (!target) throw new Error("expected at least one on-screen extend-ring cell outside the example area's own covering quads");
    await page.evaluate(`(() => {
      window.__qcmPressedQuad = null;
      window.__qcmPressedSelected = false;
      document.addEventListener('click', (e) => {
        const cell = e.target.closest?.('[data-quad]');
        window.__qcmPressedQuad = cell?.getAttribute('data-quad') ?? 'none';
        window.__qcmPressedSelected = Boolean(cell?.classList.contains('qcm-quad-selected'));
      }, { capture: true, once: true });
    })()`);
    await trustedClickSelector(page, `path[data-quad="${target}"]`);
    const hit = await page.evaluate('window.__qcmPressedQuad');
    pressed.push(`${target}->${hit}`);
    if (await page.evaluate('window.__qcmPressedSelected')) {
      throw new Error(`the press aimed at ring cell ${target} landed on selected quad ${hit}, which removes it (presses: ${pressed.join(', ')})`);
    }
    if (hit && hit !== 'none' && covering.has(hit)) {
      throw new Error(`the press aimed at ring cell ${target} landed on covering quad ${hit} (presses: ${pressed.join(', ')})`);
    }
    if (hit && hit !== 'none') added = hit;
  }
  if (!added) throw new Error(`no press reached an extend-ring cell (presses: ${pressed.join(', ')})`);
  // The click only starts the conversion: every caller reads #qcm-quad-list rows
  // next, and on a loaded CI runner the list had not rendered yet -- `li[data-quad]
  // span` came back null (#637 49bd9139, "a quad list Remove button..."). Wait
  // for every quad's own row, the state each caller actually starts from.
  const ids = [...COVERING, added];
  // Its own selected path too: a caller clicks path.qcm-quad-selected next, and under
  // 4x load one found none there with the rows already listed.
  try {
    await waitInPage(page, 'the quad list and the map to hold a row and a selected path for every covering quad and the clicked ring cell',
      `${JSON.stringify(ids)}.every((id) => document.querySelector('#qcm-quad-list li[data-quad="' + id + '"]')
        && document.querySelector('path.qcm-quad-selected[data-quad="' + id + '"]'))`);
  } catch (err) {
    // Which half never arrived, per id -- a bare timeout said neither.
    const seen = await page.evaluate(`JSON.stringify({
      per: ${JSON.stringify(ids)}.map((id) => [id, Boolean(document.querySelector('#qcm-quad-list li[data-quad="' + id + '"]')),
        Boolean(document.querySelector('path.qcm-quad-selected[data-quad="' + id + '"]'))]),
      list: [...document.querySelectorAll('#qcm-quad-list li')].map((li) => li.dataset.quad),
      selectedPaths: document.querySelectorAll('path.qcm-quad-selected').length,
      ringPaths: document.querySelectorAll('path.qcm-quad-ring').length,
      handles: document.querySelectorAll('.qcm-handle').length,
      status: document.getElementById('qcm-status')?.textContent ?? null,
      strip: document.getElementById('qcm-area-strip')?.hidden ?? null })`);
    throw new Error(`${err.message}: ${seen} (presses: ${pressed.join(', ')})`);
  }
  return ids;
}

test('a ring click in box mode converts to quads (D3): list count, no handles, announced, sheets drawn', { skip }, async () => {
  const { site, page } = await sharedBrowser();
  const ids = await enterQuadsModeFromExample(page, site);

  const after = await page.evaluate(`(() => ({
    listCount: document.getElementById('qcm-quad-list').children.length,
    listHidden: document.getElementById('qcm-quad-list').hidden,
    hintHidden: document.getElementById('qcm-quad-hint').hidden,
    handles: document.querySelectorAll('.qcm-handle').length,
    stripText: document.getElementById('qcm-area-strip-text').textContent,
    sheetCount: document.querySelectorAll('#qc-map .qcm-sheet-label').length,
  }))()`);
  assert.equal(after.listHidden, false, 'the quad list should show once a ring click enters quads mode');
  assert.equal(after.listCount, ids.length, `expected ${ids.length} rows in the quad list, got ${after.listCount}`);
  assert.equal(after.hintHidden, false, 'the corner-input hint should show in quads mode');
  assert.equal(after.handles, 0, 'quads mode has no box handles to drag');
  assert.match(after.stripText, /Snapped/, 'a box->quads conversion should say so, not read as a plain selection');
  assert.ok(after.sheetCount > 0, `expected a printable sheet plan for the 3-quad set, got ${after.sheetCount} sheet(s)`);
});

test('a quad list Remove button removes exactly that quadrangle, by its reported savings, and moves focus', { skip }, async () => {
  const { site, page } = await sharedBrowser();
  const ids = await enterQuadsModeFromExample(page, site);
  const removeId = ids[ids.length - 1]; // the clicked ring cell -- never the last quad left, so never the null/"clears" case

  // A raw count of #qc-map .qcm-sheet-label nodes lags each replan(): with the map's
  // fadeAnimation on, Leaflet 1.9.4 fades a removed tooltip out and deletes its
  // container 200 ms after sheets.clearLayers() (DivOverlay onRemove). The reliable
  // page count is the summary field replan() itself overwrites each call.
  const pageCount = (text) => Number((text.match(/^(\d+) page/) || [])[1]);

  const before = await page.evaluate(`(() => ({
    pagesText: document.querySelector('#qcm-estimate dd[data-field="pages"]').textContent,
    label: document.querySelector('li[data-quad="${removeId}"] span').textContent,
  }))()`);
  const saved = before.label.match(/saves (\d+) page/i);
  const added = before.label.match(/adds (\d+) page/i);
  const expectedDelta = saved ? -Number(saved[1]) : added ? Number(added[1]) : 0;

  // The Remove button lives inside #qcm-app, which enterQuadsModeFromExample leaves
  // closed -- open it here, right before the one click that needs to reach inside it.
  await page.evaluate("(() => { const d = document.getElementById('qcm-app'); if (d) d.open = true; })()");
  await trustedClickSelector(page, `li[data-quad="${removeId}"] button`);

  const after = await page.evaluate(`(() => ({
    listCount: document.getElementById('qcm-quad-list').children.length,
    rowGone: document.querySelector('li[data-quad="${removeId}"]') === null,
    pagesText: document.querySelector('#qcm-estimate dd[data-field="pages"]').textContent,
    focusInList: document.activeElement.closest('#qcm-quad-list') !== null,
    focusIsUndo: document.activeElement.id === 'qcm-area-undo',
  }))()`);
  assert.equal(after.rowGone, true, "the removed quadrangle's own row should be gone from the list");
  assert.equal(after.listCount, ids.length - 1, 'the list should shrink by exactly one row');
  assert.equal(pageCount(after.pagesText), pageCount(before.pagesText) + expectedDelta,
    `page count should change by exactly the savings the list reported ("${before.label}"), got "${before.pagesText}" -> "${after.pagesText}"`);
  assert.ok(after.focusInList || after.focusIsUndo, "focus should move to another row's Remove button, or to Undo if none remain");
});

test("clicking a selected quad's own path on the map removes it, the same as its Remove button", { skip }, async () => {
  const { site, page } = await sharedBrowser();
  const ids = await enterQuadsModeFromExample(page, site);
  const removeId = COVERING[0]; // one of the example area's own quads, always present

  await trustedClickSelector(page, `path.qcm-quad-selected[data-quad="${removeId}"]`);

  const after = await page.evaluate(`(() => ({
    listCount: document.getElementById('qcm-quad-list').children.length,
    rowGone: document.querySelector('li[data-quad="${removeId}"]') === null,
    pathGone: document.querySelector('path.qcm-quad-selected[data-quad="${removeId}"]') === null,
  }))()`);
  assert.equal(after.rowGone, true, "removing a quadrangle by clicking its map path should drop its list row too");
  assert.equal(after.pathGone, true, "the clicked quadrangle's own selected-path should no longer be drawn");
  assert.equal(after.listCount, ids.length - 1, 'the list should shrink by exactly one row');
});

test('removing every quadrangle clears the area; Undo restores the last one removed', { skip }, async () => {
  const { site, page } = await sharedBrowser();
  const ids = await enterQuadsModeFromExample(page, site);
  // The Remove buttons below live inside #qcm-app, which enterQuadsModeFromExample
  // leaves closed -- open it once before this test's own panel-interior clicks.
  await page.evaluate("(() => { const d = document.getElementById('qcm-app'); if (d) d.open = true; })()");

  for (const id of ids.slice(0, -1)) {
    await trustedClickSelector(page, `li[data-quad="${id}"] button`);
  }
  const lastId = ids[ids.length - 1];
  const oneLeft = await page.evaluate("document.getElementById('qcm-quad-list').children.length");
  assert.equal(oneLeft, 1, `expected exactly one quadrangle left before the final removal, got ${oneLeft}`);

  await trustedClickSelector(page, `li[data-quad="${lastId}"] button`);

  const cleared = await page.evaluate(`(() => ({
    listHidden: document.getElementById('qcm-quad-list').hidden,
    stripHidden: document.getElementById('qcm-area-strip').hidden,
    stripText: document.getElementById('qcm-area-strip-text').textContent,
    undoDisabled: document.getElementById('qcm-area-undo').disabled,
  }))()`);
  assert.equal(cleared.listHidden, true, 'removing the last quadrangle should hide the quad list (== Clear)');
  assert.equal(cleared.stripHidden, false, 'the strip should stay up so Undo can be reached');
  assert.match(cleared.stripText, /clear/i, 'the strip should say the area was cleared');
  assert.equal(cleared.undoDisabled, false, 'Undo should be enabled right after the last quadrangle is removed');

  await page.evaluate("document.getElementById('qcm-area-undo').click()");
  const restored = await page.evaluate(`(() => ({
    listHidden: document.getElementById('qcm-quad-list').hidden,
    listCount: document.getElementById('qcm-quad-list').children.length,
    row: document.querySelector('li[data-quad="${lastId}"]') !== null,
    handles: document.querySelectorAll('.qcm-handle').length,
    undoDisabled: document.getElementById('qcm-area-undo').disabled,
  }))()`);
  assert.equal(restored.listHidden, false, 'Undo should bring the quad list back');
  assert.equal(restored.listCount, 1, 'Undo should restore exactly the one quadrangle that was just removed');
  assert.equal(restored.row, true, `expected the restored row to be the last-removed quadrangle (${lastId})`);
  assert.equal(restored.handles, 0, 'Undo restores quads mode, not a box -- no handles');
  assert.equal(restored.undoDisabled, true, 'Undo is one step -- it disables itself once used');
});

test('reload preserves the exact quad selection: same rows, no handles, no corner-input edits', { skip }, async () => {
  const { site, page } = await sharedBrowser();
  const ids = await enterQuadsModeFromExample(page, site);

  const before = await page.evaluate(`(() => ({
    ids: [...document.querySelectorAll('#qcm-quad-list li')].map((li) => li.dataset.quad).sort(),
    corners: ${readCorners},
  }))()`);
  assert.deepEqual(before.ids, [...ids].sort(), 'sanity: the list should hold exactly the 3 selected ids before reload');

  // Both ends of the round trip are IndexedDB, and neither is awaited by anything this
  // test can see: renderPlan fires store.saveRecipe without waiting (main.js), and
  // start() restores through `await store.loadRecipe()` after window.qcMap exists, which
  // was all readyDashboard waited for then (it waits for window.qcRestoreSettled now).
  // Under 4x load this read 'a reload should restore quads mode' as hidden in 3 of 8
  // runs. Reload only once the recipe holding these ids is stored, and read only once
  // the restore has painted.
  await waitInPage(page, 'the last recipe in IndexedDB to hold every selected quad',
    `new Promise((resolve) => { const open = indexedDB.open('quiet-corners-field-maps', 1);
      open.onerror = () => resolve(false);
      open.onsuccess = () => { try { const get = open.result.transaction('recipes', 'readonly').objectStore('recipes').get('last');
        get.onsuccess = () => { const text = get.result; open.result.close();
          resolve(typeof text === 'string' && ${JSON.stringify(ids)}.every((id) => text.includes(id))); };
        get.onerror = () => { open.result.close(); resolve(false); }; } catch { open.result.close(); resolve(false); } }; })`);

  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: false });
  await waitInPage(page, 'the reload to restore the quad list',
    "!document.getElementById('qcm-quad-list').hidden && document.querySelectorAll('#qcm-quad-list li').length > 0");

  const after = await page.evaluate(`(() => ({
    ids: [...document.querySelectorAll('#qcm-quad-list li')].map((li) => li.dataset.quad).sort(),
    listHidden: document.getElementById('qcm-quad-list').hidden,
    handles: document.querySelectorAll('.qcm-handle').length,
    corners: ${readCorners},
  }))()`);
  assert.equal(after.listHidden, false, 'a reload should restore quads mode, not show no area');
  assert.deepEqual(after.ids, before.ids, 'a reload should restore the exact same set of quadrangles (R1)');
  assert.equal(after.handles, 0, 'a reload into quads mode should draw no box handles');
  assert.deepEqual(after.corners, before.corners, 'the envelope corner inputs should read the same after reload');
});

test('a v1 recipe with no quads field (pre-10b save) still restores as a box, not quads', { skip }, async () => {
  const { site, page } = await sharedBrowser();
  const controls = { orientation: 'portrait', scale: 24000, overlapIn: 0.5, dpi: 300, grid: 'none' };
  const recipe = recipeFromControls(controls, EXAMPLE_AREA.bboxLonLat, 'Legacy box', null);
  const legacy = JSON.parse(serializeRecipe(recipe));
  delete legacy.recipeVersion; // exactly what a save made before recipeVersion existed looked like (sheet-plan.test.mjs:263)
  const legacyText = JSON.stringify(legacy);

  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: false });
  await page.evaluate(`(() => new Promise((resolve, reject) => {
    const req = indexedDB.open(${JSON.stringify(DB_NAME)}, ${VERSION});
    req.onupgradeneeded = () => req.result.createObjectStore(${JSON.stringify(STORE)});
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(${JSON.stringify(STORE)}, 'readwrite');
      tx.objectStore(${JSON.stringify(STORE)}).put(${JSON.stringify(legacyText)}, ${JSON.stringify(KEY)});
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  }))()`);

  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: false });
  // The same unawaited restore as the reload test above: under load this read 'a v1
  // recipe should still restore an area' as hidden (PR CI run 36640093929). setArea
  // draws the handles, the quad list and the strip in one pass, so once the strip shows
  // the reads below see the finished restore.
  await waitInPage(page, 'the reload to restore the legacy box', "!document.getElementById('qcm-area-strip').hidden");
  const restored = await page.evaluate(`(() => ({
    handles: document.querySelectorAll('.qcm-handle').length,
    listHidden: document.getElementById('qcm-quad-list').hidden,
    stripHidden: document.getElementById('qcm-area-strip').hidden,
  }))()`);
  assert.equal(restored.stripHidden, false, 'a v1 recipe should still restore an area');
  assert.equal(restored.handles, 2, 'a v1 (box-only) recipe should restore as a box, with both drag handles');
  assert.equal(restored.listHidden, true, 'a v1 recipe has no quads field, so the quad list should stay hidden');
});
