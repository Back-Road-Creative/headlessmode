// QUX-04b starting-set + budget proof, on the real built Field Maps app. Proves the
// four numbered deliverables the plan asks for beyond QUX-04a's own compaction:
//
//   (a) the default (all-groups-collapsed) Layers view shows a .qcm-hint note only
//       for the 18 rows 04a deliberately keeps (13 context, 2 reading, 3 extras —
//       none of which carries an "About this layer" fallback for the note to hide
//       into) PLUS the state group's rows, which stay disabled-with-a-note whenever
//       no area is drawn (this test's own starting state) for the same reason —
//       syncRowNote never hides a disabled row's note, since it is the reason the
//       row is disabled and appears nowhere else — by IDENTITY, not a headcount;
//   (b) a word budget over #qcm-layers, counted the same way the 2026-09-27 usability
//       audit measured the 2,419-word baseline (interactions.mjs's own eval string);
//   (c) exactly ONE scrolling ancestor of #qcm-layers, the open panel: QUX-04c moved the
//       Map key above the list, which freed the nested 40vh .qcm-layer-scroll cap (see the
//       comment on the test below for why 04b had to keep it);
//   (d) a closed group's rows are not in the accessibility tree;
//   (e) the Hillshade light fieldset is hidden unless hillshadeLight is the chosen
//       context surface, and Map appearance shows a one-line hint in its place;
//   (f) "Print the key" lives in the print builder panel, not the Layers panel.
//
// The map-to-layers/map-key gap is NOT pinned here: layout.test.mjs's MAX_LAYERS_GAP
// test already holds both under 600px, and an exact pixel figure measured on this box's
// Chromium (323px / 571px on 2026-09-28) is not what CI's Chromium renders.
//
// Real input over the DevTools protocol (Input.dispatchMouseEvent), never `.click()`
// in the page — same trustedClick/openLayerPanel pattern as
// layer-panel-compact-browser.test.mjs, which this file's helpers are copied from.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { trustedClick } from './helpers/trusted-click.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard } from './helpers/waits.mjs';
import { LAYERS } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';

/** True visibility for content that MAY sit inside a closed native <details> — Chromium
 *  hides a closed <details>'s children with `content-visibility: hidden`, not
 *  `display: none`, so `offsetParent`/getBoundingClientRect alone read a still-collapsed
 *  row as "visible". Verbatim from layer-panel-compact-browser.test.mjs. */
const IS_VISIBLE = `(el) => el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })`;

// The identity list for (a): every row 04a's syncRowNote leaves alone because it has no
// `.qcm-layer-about` fallback to hide its note into (main.js's layerRow only builds that
// fallback for the federal/state groups). Computed from the registry itself, not
// retyped, so a registry change updates this list rather than silently drifting from it.
const KEPT_NOTE_IDS = [
  ...LAYERS.filter((l) => l.group === 'context').map((l) => `qcm-context-${l.id}`),
  ...LAYERS.filter((l) => l.group === 'reading').map((l) => `qcm-layer-${l.id}`),
  ...LAYERS.filter((l) => l.group === 'extras').map((l) => `qcm-layer-${l.id}`),
  // Road cameras (QUX-08D): no About disclosure, so the coverage caveat stays as its note.
  ...LAYERS.filter((l) => l.group === 'cameras').map((l) => `qcm-layer-${l.id}`),
  // Every "state" group row IS stateScoped, so with no area drawn (this test's own
  // starting state, and every fresh dashboard load) layerControlSpecs marks all of
  // them `missing`/disabled with a "Draw an area first…" note — and syncRowNote's
  // own documented rule (main.js) never hides a disabled row's note even though it
  // has an "About this layer" disclosure, because the note is the reason the row is
  // disabled and appears nowhere else. Discovered via TDD: the first red run of this
  // test (2026-09-28) showed exactly these four ids and no others beyond the 18
  // above, confirmed by reading layerControlSpecs/syncRowNote directly.
  ...LAYERS.filter((l) => l.group === 'state').map((l) => `qcm-layer-${l.id}`),
].sort();
const ABOUT_COUNT = LAYERS.filter((l) => l.group === 'federal' || l.group === 'state').length;

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

async function freshPage(viewport = { width: 1280, height: 900 }) {
  const { site, page } = await sharedBrowser();
  await page.setViewport(viewport);
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: false });
  return page;
}

/** Re-clicks and polls `open` instead of one click + one read: under runner
 *  load a single trusted click can land while the dashboard is still settling
 *  (see layer-panel-compact-browser.test.mjs's openLayerPanel). */
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

// (a) + word budget (b), both read off the DEFAULT render — no group opened, matching
// interactions.mjs's own methodology (only #qcm-layer-panel itself is opened).
test('the default Layers view keeps a note only on rows with no About disclosure or a disabled reason, by identity, and stays inside the measured word budget', { skip }, async () => {
  const page = await freshPage();
  const seen = await page.evaluate(`(() => {
    document.getElementById('qcm-layer-panel').open = true;
    const rows = [...document.querySelectorAll('.qcm-layer-row')];
    const shownIds = rows.filter((row) => {
      const note = row.querySelector('.qcm-hint');
      return note && !note.hidden;
    }).map((row) => row.querySelector('input').id).sort();
    return {
      shownIds,
      abouts: document.querySelectorAll('#qcm-layers .qcm-layer-about p').length,
      // Same counting rule as the 2026-09-27 usability audit's interactions.mjs, so this
      // number is directly comparable to its measured baseline (36 rows / 37 hints / 2,419
      // words): rows/hints/words all read off #qcm-layers with individual groups left closed.
      rows: document.querySelectorAll('.qcm-layer-row').length,
      hints: document.querySelectorAll('#qcm-layers .qcm-hint').length,
      words: document.querySelector('#qcm-layers').innerText.trim().split(/\\s+/).length,
    };
  })()`);
  assert.deepEqual(seen.shownIds, KEPT_NOTE_IDS,
    'the rows showing a note while off must be exactly the 18 QUX-04a kept (context/reading/extras with no About disclosure) plus the state rows disabled until an area is drawn, by identity — no more, no fewer');
  assert.equal(seen.abouts, ABOUT_COUNT, '.qcm-layer-about p is one per federal+state row, measured separately from the .qcm-hint notes above');
  // Neither the starting-set rename (item 1) nor the appearance/print moves (item 2) touch
  // anything inside #qcm-layers, so this stays at the audit's own 2,419-word baseline; the
  // ceiling is set a little above the measured number as a regression floor, not a target.
  assert.ok(seen.words <= 2500, `#qcm-layers word count grew past the budget: ${seen.words} words (audit baseline 2,419, ${seen.rows} rows, ${seen.hints} hints)`);
});

// (c) exactly ONE scrolling ancestor reaches #qcm-layers: the open panel itself, at a
// phone and a desktop width. QUX-04b left two (the nested 40vh .qcm-layer-scroll cap plus
// the panel) because the inner cap was what kept layout.test.mjs's MAX_LAYERS_GAP bounded
// with every disclosure forced open: the Map key followed the list in flow, so a tall list
// pushed #qcm-legend thousands of px from the map. QUX-04c moved the Map key ABOVE the
// list (qcm-map-layers.html), so #qcm-legend no longer depends on the list's height and
// the inner cap has no check left to hold; it is gone, and .qcm-layer-scroll is a plain
// width wrapper (overflow visible).
// The predicate is overflow-y only, with no max-height clause: below 1024px the open panel
// is 03c's sheet region (`.qc-sheet .qcm-panel[open] { flex: 1 1 100%; min-height: 0;
// overflow-y: auto }`, no max-height), at and above it `.qcm-panel` carries
// `max-height: calc(100% - 2rem)`. A scroller is a scroller whatever bounds it.
for (const vp of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test(`exactly one scrolling ancestor, the open panel, reaches #qcm-layers at ${vp.width}px`, { skip }, async () => {
    const page = await freshPage(vp);
    await openLayerPanel(page);
    const seen = await page.evaluate(`(() => {
      const found = [];
      let el = document.getElementById('qcm-layers');
      while (el && el !== document.body) {
        const cs = getComputedStyle(el);
        if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') {
          found.push({ id: el.id, cls: el.className });
        }
        el = el.parentElement;
      }
      return { found, innerOverflowY: getComputedStyle(document.querySelector('.qcm-layer-scroll')).overflowY };
    })()`);
    assert.equal(seen.found.length, 1,
      `expected exactly one scrolling ancestor of #qcm-layers (#qcm-layer-panel), found ${seen.found.length}: ${JSON.stringify(seen.found)}`);
    assert.equal(seen.found[0].id, 'qcm-layer-panel', `the one scroller must be the open panel, got ${JSON.stringify(seen.found[0])}`);
    assert.equal(seen.innerOverflowY, 'visible', '.qcm-layer-scroll must not scroll on its own: the inner cap is gone (QUX-04c)');
  });
}

// (d) a closed group's rows are not in the accessibility tree (checkVisibility, the same
// content-visibility-aware check layer-panel-compact-browser.test.mjs uses).
test("a closed group's rows are not visible", { skip }, async () => {
  const page = await freshPage();
  await openLayerPanel(page);
  const federalRowVisible = await page.evaluate(`(() => {
    const isVisible = ${IS_VISIBLE};
    const row = document.getElementById('qcm-layer-federalLand').closest('.qcm-layer-row');
    return isVisible(row);
  })()`);
  assert.equal(federalRowVisible, false, 'the federal group starts closed; its rows must not be visible');
});

// (e) the Hillshade light fieldset is hidden unless hillshadeLight is the chosen context
// surface — HIDDEN, not removed, so its ids stay wired the moment the reader switches back —
// and Map appearance never opens onto nothing: its hint shows exactly when the fieldset does not.
test('the Hillshade light fieldset is hidden until hillshadeLight is chosen, then shown', { skip }, async () => {
  const page = await freshPage();
  await openLayerPanel(page);
  const before = await page.evaluate("document.getElementById('qcm-hillshade-fieldset').hidden");
  assert.equal(before, true, 'the hillshade light controls must start hidden — no hillshade context surface is on by default');
  const hint = () => page.evaluate("document.getElementById('qcm-appearance-hint')?.hidden ?? 'missing'");
  assert.equal(await hint(), false, 'with the light controls hidden, Map appearance must show its hint rather than open onto nothing');

  await trustedClick(page, '.qcm-layer-group[aria-label="Land, sky & light context"] summary');
  await page.evaluate(`(() => {
    const radio = document.getElementById('qcm-context-hillshadeLight');
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const shown = await page.evaluate("document.getElementById('qcm-hillshade-fieldset').hidden");
  assert.equal(shown, false, 'choosing hillshadeLight must reveal the hillshade light controls');
  assert.equal(await hint(), true, 'once the light controls show, the hint pointing at them must go');

  await page.evaluate(`(() => {
    const none = document.getElementById('qcm-context-none');
    none.checked = true;
    none.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const hiddenAgain = await page.evaluate("document.getElementById('qcm-hillshade-fieldset').hidden");
  assert.equal(hiddenAgain, true, 'switching the context surface away from hillshadeLight must hide the controls again');
  assert.equal(await hint(), false, 'and the hint must come back with them hidden');
});

// (f) "Print the key" lives in the print builder panel, never the Layers panel.
test('Print the key lives in the print builder panel, not the Layers panel', { skip }, async () => {
  const page = await freshPage();
  const seen = await page.evaluate(`(() => {
    const btn = document.getElementById('qcm-key-sheet');
    const dl = document.getElementById('qcm-key-sheet-download');
    return {
      btnInPrint: !!btn && !!btn.closest('#qcm-app'),
      btnInLayers: !!btn && !!btn.closest('#qcm-layer-panel'),
      dlInPrint: !!dl && !!dl.closest('#qcm-app'),
      dlInLayers: !!dl && !!dl.closest('#qcm-layer-panel'),
    };
  })()`);
  assert.equal(seen.btnInPrint, true, '#qcm-key-sheet must live inside the print builder panel (#qcm-app)');
  assert.equal(seen.btnInLayers, false, '#qcm-key-sheet must not live inside the Layers panel (#qcm-layer-panel)');
  assert.equal(seen.dlInPrint, true, '#qcm-key-sheet-download must live inside the print builder panel (#qcm-app)');
  assert.equal(seen.dlInLayers, false, '#qcm-key-sheet-download must not live inside the Layers panel (#qcm-layer-panel)');
});
