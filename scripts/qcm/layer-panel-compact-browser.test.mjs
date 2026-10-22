// QUX-04a compact-rows proof, on the real built Field Maps app. Proves the
// brief's own "done when" list for this unit, on rendered output rather than
// on layer-panel.js's pure functions alone (layer-panel.test.mjs already
// covers those in isolation):
//
//   - an off row with a note shows no visible .qcm-hint paragraph, IF that
//     row also carries an "About this layer" fallback (federal/state only —
//     see the note on syncRowNote in main.js: a base/context/reading/extras
//     row has nowhere else the note text lives, so it stays unconditional);
//   - every layer group renders collapsed (closed <details>) by default;
//   - opening a group is a real, trusted click, not `.open = true`;
//   - a search match inside a still-closed group opens that group so the
//     match is actually visible, not merely "in the filtered set";
//   - at 1440px, in the default (all-collapsed) state, the whole open panel (Map key,
//     toolbar, collapsed groups, closed Appearance/Advanced) stays within a measured
//     length budget — the panel is the ONE scroller now (QUX-04c removed the nested
//     .qcm-layer-scroll cap), so its default length is what compaction protects.
//
// Real input over the DevTools protocol (Input.dispatchMouseEvent), never
// `.click()` in the page — same technique and the same reasoning as
// panel-shell-browser.test.mjs's trustedClick: a trusted click on the actual
// rendered layout is the more faithful proof that a summary press works for
// a reader, not just for a test harness poking `.open` directly.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { trustedClick } from './helpers/trusted-click.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, chooseExampleArea } from './helpers/waits.mjs';

/** True visibility for content that MAY sit inside a closed native <details>.
 *  Chromium hides a closed <details>'s non-summary children with
 *  `content-visibility: hidden` rather than `display: none` (confirmed on
 *  this box's headless Chromium 2026-09-27) — that leaves the child's own
 *  `offsetParent`/`getBoundingClientRect` non-null/non-zero even while the
 *  enclosing <details> itself correctly collapses to its summary's height,
 *  so `offsetParent !== null` reads a still-collapsed row as "visible".
 *  `checkVisibility()` is the one call the spec defines to account for
 *  content-visibility, so it, not offsetParent, is this file's visibility
 *  check for anything that can be inside a group's <details>. */
const IS_VISIBLE = `(el) => el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })`;

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built — run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

let shared = null;
async function sharedBrowser() {
  if (!shared) {
    const site = await startSiteServer();
    const page = await launch(CHROMIUM, `${site.origin}/quiet-corners/`, {
      viewport: { width: 1280, height: 900 }, args: ['--hide-scrollbars'],
    });
    await readyDashboard(page, { data: false });
    shared = { site, page };
  }
  return shared;
}
after(async () => {
  if (!shared) return;
  shared.page.close();
  await shared.site.close();
});

async function freshPage() {
  const { site, page } = await sharedBrowser();
  await page.setViewport({ width: 1280, height: 900 });
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: false });
  return page;
}

/** Opens the Layers panel itself with a trusted click — every test needs it
 *  open before any group inside it can be measured or clicked. One click can
 *  land while the dashboard is still settling after `readyDashboard` (CI run
 *  36469072943: a single click, 150 ms, `open === false`), so this re-clicks
 *  a few times and polls `open` rather than reading it once. */
async function openLayerPanel(page) {
  const isOpen = () => page.evaluate("document.getElementById('qcm-layer-panel').open");
  for (let attempt = 0; attempt < 8 && !(await isOpen()); attempt++) {
    await trustedClick(page, '#qcm-layer-panel summary');
    for (let i = 0; i < 5 && !(await isOpen()); i++) {
      await page.evaluate('new Promise(r => setTimeout(r, 100))');
    }
  }
  assert.equal(await isOpen(), true, 'the Layers panel summary did not open the panel');
}

test('every layer group renders collapsed by default', { skip }, async () => {
  const page = await freshPage();
  await openLayerPanel(page);
  const groups = await page.evaluate(`(() => (
    [...document.querySelectorAll('#qcm-layers > .qcm-layer-group')].map((g) => ({
      label: g.getAttribute('aria-label'), open: g.open,
    }))
  ))()`);
  assert.ok(groups.length >= 3, `expected several rendered groups, got ${groups.length}`);
  for (const g of groups) {
    assert.equal(g.open, false, `group "${g.label}" rendered open on first load — groups must start closed`);
  }
});

test('a trusted click on a group summary opens it, revealing its rows', { skip }, async () => {
  const page = await freshPage();
  await openLayerPanel(page);
  const before = await page.evaluate(`(() => {
    const isVisible = ${IS_VISIBLE};
    const row = document.getElementById('qcm-layer-federalLand').closest('.qcm-layer-row');
    return { groupOpen: row.closest('.qcm-layer-group').open, rowVisible: isVisible(row) };
  })()`);
  assert.equal(before.groupOpen, false, 'the federal group should start closed');
  assert.equal(before.rowVisible, false, 'a row inside a closed group must not be visible');

  await trustedClick(page, '.qcm-layer-group[aria-label="Federal overlays"] summary');
  const after = await page.evaluate(`(() => {
    const isVisible = ${IS_VISIBLE};
    const row = document.getElementById('qcm-layer-federalLand').closest('.qcm-layer-row');
    return { groupOpen: row.closest('.qcm-layer-group').open, rowVisible: isVisible(row) };
  })()`);
  assert.equal(after.groupOpen, true, 'a trusted click on the group summary did not open it');
  assert.equal(after.rowVisible, true, 'the federal-land row is still not visible after opening its group');
});

test('an off federal-group row (with an About fallback) shows no visible note; checking it reveals the note', { skip }, async () => {
  const page = await freshPage();
  await openLayerPanel(page);
  await trustedClick(page, '.qcm-layer-group[aria-label="Federal overlays"] summary');

  const noteEl = "document.getElementById('qcm-layer-federalLand').closest('.qcm-layer-row').querySelector('.qcm-hint')";
  const hasAbout = await page.evaluate(
    "!!document.getElementById('qcm-layer-federalLand').closest('.qcm-layer-row').querySelector('.qcm-layer-about')");
  assert.equal(hasAbout, true, 'federalLand should carry an "About this layer" fallback — the row this test scopes to');

  const offHidden = await page.evaluate(`${noteEl}.hidden`);
  assert.equal(offHidden, true, 'an off federal-land row must not show its .qcm-hint note');

  await page.evaluate(`(() => {
    const cb = document.getElementById('qcm-layer-federalLand');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const onHidden = await page.evaluate(`${noteEl}.hidden`);
  const onText = await page.evaluate(`${noteEl}.textContent`);
  assert.equal(onHidden, false, 'checking federalLand should reveal its .qcm-hint note');
  assert.ok(onText.length > 0, 'the revealed note should carry the registry note text');
});

/** The row, its note and whether a reader can see that note, once `group` is open. */
async function rowNoteSeen(page, group, inputId) {
  await trustedClick(page, `.qcm-layer-group[aria-label="${group}"] summary`);
  return page.evaluate(`(() => {
    const isVisible = ${IS_VISIBLE};
    const input = document.getElementById(${JSON.stringify(inputId)});
    const row = input && input.closest('.qcm-layer-row');
    const note = row && row.querySelector('.qcm-hint');
    if (!note) return null;
    return { checked: input.checked, disabled: input.disabled, hasAbout: !!row.querySelector('.qcm-layer-about'),
      seen: !note.hidden && isVisible(note), text: note.textContent };
  })()`);
}

// A context surface's caveat (coverage, age) is the only place its text lives — the
// row has no "About this layer" to move it into — and it is what a reader weighs when
// choosing between the radios, so it stays on screen while the radio is unchosen.
test('an unchosen context row keeps its caveat visible — it has no About disclosure to hide into', { skip }, async () => {
  const page = await freshPage();
  await openLayerPanel(page);
  const r = await rowNoteSeen(page, 'Land, sky & light context', 'qcm-context-nwsRadar');
  assert.ok(r, 'the radar context row lost its .qcm-hint caveat');
  assert.equal(r.checked, false, 'radar should be unchosen on first load (the default is No context surface)');
  assert.equal(r.hasAbout, false, 'a context row carries no About disclosure');
  assert.equal(r.seen, true, `the unchosen radar row hides its only caveat: ${JSON.stringify(r.text)}`);
});

// A greyed switch with no reason beside it reads as broken. Before an area is drawn
// every state row is disabled, and its note is why; layerAboutText never restates it.
test('a disabled state row keeps its reason visible while off', { skip }, async () => {
  const page = await freshPage();
  await openLayerPanel(page);
  const r = await rowNoteSeen(page, 'State land', 'qcm-layer-gameLands');
  assert.ok(r, 'the game-lands row lost its .qcm-hint reason');
  assert.equal(r.disabled, true, 'with no area drawn the game-lands row should be disabled');
  assert.equal(r.hasAbout, true, 'a state row carries an About disclosure — the case where an off note is hidden');
  assert.equal(r.seen, true, `the disabled game-lands row hides why it is disabled: ${JSON.stringify(r.text)}`);
  assert.match(r.text, /Draw an area first/);
});

test('searching opens a matching group so the match is actually visible, not merely filtered-in', { skip }, async () => {
  const page = await freshPage();
  await openLayerPanel(page);

  const closedBefore = await page.evaluate(
    '!document.getElementById(\'qcm-layer-federalLand\').closest(\'.qcm-layer-group\').open');
  assert.equal(closedBefore, true, 'the federal group should start closed');

  await page.evaluate(`(() => {
    const box = document.getElementById('qcm-layer-search');
    box.value = 'refuge';
    box.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);

  const afterSearch = await page.evaluate(`(() => {
    const row = document.getElementById('qcm-layer-federalLand').closest('.qcm-layer-row');
    return { groupOpen: row.closest('.qcm-layer-group').open, rowHidden: row.hidden };
  })()`);
  assert.equal(afterSearch.groupOpen, true, 'a search match inside a closed group must open that group');
  assert.equal(afterSearch.rowHidden, false, 'the matching row must be visible after the search');

  // Clearing the query leaves the group open (the reader's own state is not
  // clobbered) but must not leave anything the search filtered out hidden.
  await page.evaluate(`(() => {
    const box = document.getElementById('qcm-layer-search');
    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const cleared = await page.evaluate(
    "document.getElementById('qcm-layer-federalLand').closest('.qcm-layer-row').hidden");
  assert.equal(cleared, false, 'clearing the search should leave every row visible again');
});

test('the active-only toggle also opens a matching still-closed group', { skip }, async () => {
  const page = await freshPage();
  await openLayerPanel(page);
  await trustedClick(page, '.qcm-layer-group[aria-label="Federal overlays"] summary');
  await page.evaluate(`(() => {
    const cb = document.getElementById('qcm-layer-federalLand');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  // Close the group again by hand so the toggle below has to reopen it.
  await trustedClick(page, '.qcm-layer-group[aria-label="Federal overlays"] summary');
  const closed = await page.evaluate(
    '!document.getElementById(\'qcm-layer-federalLand\').closest(\'.qcm-layer-group\').open');
  assert.equal(closed, true, 'the federal group should be closed again after the second click');

  await page.evaluate(`(() => {
    const cb = document.getElementById('qcm-layers-active-only');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const after = await page.evaluate(
    'document.getElementById(\'qcm-layer-federalLand\').closest(\'.qcm-layer-group\').open');
  assert.equal(after, true, 'active-only should reopen a group holding the one checked row it kept visible');
});

test('the active count line still tracks a switch inside an opened group', { skip }, async () => {
  const page = await freshPage();
  await openLayerPanel(page);
  const before = await page.evaluate("document.getElementById('qcm-layer-count').textContent");
  assert.equal(before, 'No layers on', `expected the panel to open with nothing on, got: ${before}`);

  // renderLayerPanelExtras() (main.js) — the count line's writer — runs from
  // renderSources(), and replan() (the checkbox's own change handler calls it)
  // no-ops with no area chosen (state.bbox unset): "Choose an area first" is
  // canBuild's own gate reason. So an area has to be chosen first, same as
  // layer-panel-browser.test.mjs does before exercising any fetch-driven row —
  // otherwise this is proving the precondition message, not the count line.
  await chooseExampleArea(page);
  await trustedClick(page, '.qcm-layer-group[aria-label="Federal overlays"] summary');
  await page.evaluate(`(() => {
    const cb = document.getElementById('qcm-layer-federalLand');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const after = await page.evaluate("document.getElementById('qcm-layer-count').textContent");
  assert.notEqual(after, 'No layers on', 'the count line did not update after a row inside an opened group was checked');
});

// Measured at 1440x900 only: that is where the panel box is tallest (calc(100% - 2rem) of
// the map container). Not asserted at 390: 03c's half sheet is ~274px tall by design, so
// the panel is expected to scroll there.
// It does NOT fit at 1440 today: measured 2026-09-28 on the QUX-03c tip with the Map key
// moved above the list, scrollHeight=1055 vs clientHeight=639 (Map key, presets, toolbar,
// nine collapsed groups, closed Appearance/Advanced). So this is a BUDGET, not a fit: the
// whole collapsed panel stays within the measured 1055px + 40px. It fails if a change makes
// the default-state panel longer; shrinking it is welcome and never fails.
// UX-03b (2026-10-03): the Cameras entry (title, two region rows with Go to and a status line)
// sits above the groups so a reader finds cameras and their two regions without opening anything.
// The budget above is NOT moved for it: the panel minus the entry must still fit 1055 + 40, and the
// entry has its own cap. Measured 1237 with the entry, 162px of it, so 1075 without.
// 2026-10-04: the entry grew from two regions to five (PhenoCam and AviationWX added), and five rows
// cannot fit a flat 200px: the title is two lines (36px) and a row is never under one name line plus
// its status (32px). So the cap is per part instead: the title, and EACH region row, has its own
// ceiling, and the entry may be no taller than those ceilings summed for the rows it really has.
// Measured at 1280 with Go to in its own column and the status inline: title 36, rows 32/32/49/49/49.
const COLLAPSED_PANEL_BUDGET = 1055 + 40;
const CAMERA_ENTRY_TITLE_MAX = 40;
const CAMERA_ROW_MAX = 52;
test('the Named places fieldset is off screen until the names layer has answered for this view', { skip }, async () => {
  // N3: names open ON, so without this rule every fresh load carries the
  // fieldset's legend and a "have not loaded yet" line (84px) under the
  // layer list before any request has returned -- a notice about nothing.
  // The row's own badge already says the layer is loading; the fieldset
  // appears with its first answer (an answered status, or a rec answer).
  const page = await freshPage({ width: 1440, height: 900 });
  await openLayerPanel(page);
  const state = await page.evaluate(`(() => ({
    namesOn: document.getElementById('qcm-layer-names').checked,
    fieldsetHidden: document.querySelector('.qcm-names').hidden,
  }))()`);
  assert.equal(state.namesOn, true, 'the premise: the names row opens on');
  assert.equal(state.fieldsetHidden, true, 'no answer yet, so no Named places fieldset');
});

test('in the default all-collapsed state at 1440px, the open Layers panel stays within its measured length budget', { skip }, async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await openLayerPanel(page);
  const box = await page.evaluate(`(() => {
    const el = document.getElementById('qcm-layer-panel');
    const entry = document.getElementById('qcm-camera-entry');
    const h = (n) => Math.round(n.getBoundingClientRect().height);
    return {
      scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, entry: entry ? h(entry) : 0,
      title: entry ? h(entry.querySelector('.qcm-camera-entry-title')) : 0,
      rows: entry ? [...entry.querySelectorAll('[data-camera-region]')].map((li) => [li.getAttribute('data-camera-region'), h(li)]) : [],
    };
  })()`);
  // The entry's own share is capped apart from the budget, so the budget cannot absorb other growth.
  assert.ok(box.rows.length > 0, 'the Cameras entry lists no region');
  assert.ok(box.title <= CAMERA_ENTRY_TITLE_MAX, `the Cameras entry title is ${box.title}px tall (cap ${CAMERA_ENTRY_TITLE_MAX})`);
  for (const [id, height] of box.rows) {
    assert.ok(height <= CAMERA_ROW_MAX, `the ${id} row of the Cameras entry is ${height}px tall (cap ${CAMERA_ROW_MAX})`);
  }
  const entryMax = CAMERA_ENTRY_TITLE_MAX + CAMERA_ROW_MAX * box.rows.length;
  assert.ok(box.entry > 0 && box.entry <= entryMax, `the Cameras entry is ${box.entry}px tall (cap ${entryMax} for ${box.rows.length} regions)`);
  assert.ok(box.scrollHeight - box.entry <= COLLAPSED_PANEL_BUDGET,
    `the collapsed Layers panel grew past its budget (scrollHeight=${box.scrollHeight} less the Cameras entry's ${box.entry}, clientHeight=${box.clientHeight}, budget=${COLLAPSED_PANEL_BUDGET})`);
});
