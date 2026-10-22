// The dashboard's layout, measured in a real browser rather than argued from CSS.
//
// Audit findings F01/F02 (.data/plans/2026-09-09-quiet-corners-map-audit-plan.md): the
// print builder is an in-flow flex sibling of the map. Opening it took the map from
// 625px wide to ZERO at 1440px — the panel claimed 906px beside a 500px results column,
// and `flex-1 min-w-0` let the map absorb every pixel of the shortfall. Collapsed, it
// still held a column of its own. At 1024px the map was down to ~209px before the panel
// was opened at all.
//
// Nothing caught it: preview-shots.sh measures DOCUMENT overflow, which a zero-width
// map does not cause, and the Node suite reads source rather than boxes. So the check
// has to be a rendered one. Chromium over the DevTools protocol, Node built-ins only —
// the technique helpers/browser.mjs already established for the print proof.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt() ? 'public/quiet-corners/ not built — run `hugo --configDir site-config --minify` first'
    : false;

/** The floor. A map narrower than this cannot show a county and its surroundings at
 *  once, which is the whole job of this page; the dock's map column (quiet-corners-maps.css)
 *  holds it whichever panel is open. Chosen so the narrowest supported two-column
 *  width (1024px, less the 500px results column and the frame) still clears it. */
const MIN_MAP_WIDTH = 480;

/** Viewports the audit measured, plus 768x1024 — where the map measured ZERO even
 *  with the panel shut, which the audit had not caught. 390x844 belongs to the phone
 *  work (F03) and is not asserted here. */
const VIEWPORTS = [{ w: 1440, h: 1000 }, { w: 1024, h: 768 }, { w: 768, h: 1024 }];

const measure = `(() => {
  const box = (sel) => { const el = document.querySelector(sel); if (!el) return null;
    const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x) }; };
  return { map: box('#qc-map'), panel: box('#qcm-app'), doc: document.documentElement.clientWidth };
})()`;

const openPrintPanel = `(() => { const d = document.getElementById('qcm-app'); if (!d) return false;
  d.open = true; return d.open; })()`;

/** QUX-03a follow-up: same shape as openPrintPanel above but for the OTHER panel.
 *  Declared here (ahead of openLayersPanel's own definition further down, which
 *  also expands every nested disclosure for the layer-switches/map-key gap test)
 *  because that one is a poor fit here -- it forces every "Advanced"/"Names not
 *  shown" subtree open too, which is extra state this map-width check does not
 *  need and would only make a failure here harder to read. */
const openLayersPanelOnly = `(() => { const d = document.getElementById('qcm-layer-panel'); if (!d) return false;
  d.open = true; return d.open; })()`;

/** QUX-03b-i: the third panel — Explore holds the filters, the county/candidate
 *  tables and the sort controls, which used to sit beside the map as flex
 *  siblings of it and are now a .qcm-panel in #qc-sheet with the other three. Same
 *  shape as openPrintPanel/openLayersPanelOnly above. */
const openExplorePanelOnly = `(() => { const d = document.getElementById('qc-explore-panel'); if (!d) return false;
  d.open = true; return d.open; })()`;

// One site server and one Chromium process for the whole file, not one pair per
// test. 25 tests each starting a fresh browser (plus its own profile directory and
// process group) is ~50s of pure launch overhead even on an idle box; on the shared
// CI runner (3 runners over 12 cores, see workspaces CLAUDE.md "One box") that
// overhead multiplies and blew the file-level timeout (180s, then 600s) while every
// individual subtest still passed -- the cost was launching, not testing. The
// viewport can be changed on an already-running Chromium via the DevTools protocol
// (helpers/browser.mjs `setViewport`), and a fresh `navigate()` gives each test a
// clean document the same way a brand-new page did.
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

async function withPage({ w, h }, fn) {
  const { site, page } = await sharedBrowser();
  await page.setViewport({ width: w, height: h });
  await page.navigate(`${site.origin}/quiet-corners/`);
  return fn(page);
}

for (const vp of VIEWPORTS) {
  test(`the map keeps a usable width at ${vp.w}px with the print panel closed`, { skip }, async () => {
    const seen = await withPage(vp, (p) => p.evaluate(measure));
    assert.ok(seen.map, '#qc-map is not in the page');
    assert.ok(seen.map.w >= MIN_MAP_WIDTH,
      `map is ${seen.map.w}px wide at ${vp.w}px viewport, below the ${MIN_MAP_WIDTH}px floor`);
  });

  test(`opening the print panel does not take the map's width at ${vp.w}px`, { skip }, async () => {
    const seen = await withPage(vp, async (p) => {
      const before = await p.evaluate(measure);
      assert.equal(await p.evaluate(openPrintPanel), true, 'the print panel <details> is missing');
      return { before, after: await p.evaluate(measure) };
    });
    assert.ok(seen.after.map.w >= MIN_MAP_WIDTH,
      `map fell to ${seen.after.map.w}px (from ${seen.before.map.w}px) when the print panel opened, `
      + `below the ${MIN_MAP_WIDTH}px floor — the panel must not compete with the map for width`);
  });

  test(`opening the layers panel does not take the map's width at ${vp.w}px`, { skip }, async () => {
    const seen = await withPage(vp, async (p) => {
      const before = await p.evaluate(measure);
      assert.equal(await p.evaluate(openLayersPanelOnly), true, 'the layers panel <details> is missing');
      return { before, after: await p.evaluate(measure) };
    });
    assert.ok(seen.after.map.w >= MIN_MAP_WIDTH,
      `map fell to ${seen.after.map.w}px (from ${seen.before.map.w}px) when the layers panel opened, `
      + `below the ${MIN_MAP_WIDTH}px floor — the panel must not compete with the map for width`);
  });

  test(`opening the explore panel does not take the map's width at ${vp.w}px`, { skip }, async () => {
    const seen = await withPage(vp, async (p) => {
      const before = await p.evaluate(measure);
      assert.equal(await p.evaluate(openExplorePanelOnly), true, 'the explore panel <details> is missing');
      return { before, after: await p.evaluate(measure) };
    });
    assert.ok(seen.after.map.w >= MIN_MAP_WIDTH,
      `map fell to ${seen.after.map.w}px (from ${seen.before.map.w}px) when the explore panel opened, `
      + `below the ${MIN_MAP_WIDTH}px floor — the panel must not compete with the map for width`);
  });
}

test('the print panel stays inside the viewport when open', { skip }, async () => {
  const seen = await withPage(VIEWPORTS[0], async (p) => {
    await p.evaluate(openPrintPanel);
    return p.evaluate(measure);
  });
  assert.ok(seen.panel.x + seen.panel.w <= seen.doc + 1,
    `the open print panel reaches ${seen.panel.x + seen.panel.w}px in a ${seen.doc}px document`);
});

// ---------------------------------------------------------------------------
// Phone width (audit F03).
//
// The map began 981px down the document, and the filter panel measured x=16
// width=390 in a 390px viewport — 16px of every slider readout clipped off the
// right edge. Neither was caught, for two reasons worth recording:
//
//   1. `#dashboard { overflow-x: clip }` means an element hanging past the right
//      edge does NOT widen the document, so preview-overflow.mjs sees nothing.
//      The check has to measure the CONTROLS, not the document.
//   2. Headless Chromium clamps `--window-size` to a 500px minimum window, so a
//      "390px" run measured 500 CSS pixels and the overflow disappeared. The
//      viewport has to come from Emulation.setDeviceMetricsOverride.
const PHONE = { w: 390, h: 844 };

/** Every element under #dashboard whose box reaches past the viewport's right edge.
 *  Leaflet's own render surface is exempt: its panes and canvas are deliberately wider
 *  than the map box and clipped by it, which is how a slippy map works. Everything
 *  else is a control, and a control that hangs off the screen is unreadable. */
const clipped = `(() => {
  const vw = document.documentElement.clientWidth, out = [];
  for (const el of document.querySelectorAll('#dashboard, #dashboard *')) {
    if (el.closest('.leaflet-container') && el.id !== 'qc-map') continue;
    const r = el.getBoundingClientRect();
    if (Math.round(r.right) > vw + 1) out.push(
      \`\${el.tagName.toLowerCase()}\${el.id ? '#' + el.id : ''} right=\${Math.round(r.right)} > \${vw}\`);
  }
  return out;
})()`;

const mapTop = `(() => { const r = document.getElementById('qc-map').getBoundingClientRect();
  return Math.round(r.top + window.scrollY); })()`;

/** How far down the document the map may start before a phone reader has to scroll
 *  past the whole control set to reach the thing they came for. The budget is half
 *  the 390x844 phone screen this file measures: a map tool that opens with the map
 *  starting below the fold of the top half is not showing anyone a map. 600px left
 *  424px of blank page above it and only 251px of map on screen (audit A10); 420px
 *  puts more than half the screen on the map before the reader scrolls at all. */
const MAX_MAP_TOP = 420;

test('no control hangs past the right edge of a phone screen', { skip }, async () => {
  const over = await withPage(PHONE, (p) => p.evaluate(clipped));
  assert.deepEqual(over, [], `${over.length} element(s) reach past the viewport:\n${over.join('\n')}`);
});

test('the map is reachable without scrolling past every filter on a phone', { skip }, async () => {
  const top = await withPage(PHONE, (p) => p.evaluate(mapTop));
  assert.ok(top <= MAX_MAP_TOP, `the map starts ${top}px down the document, past the ${MAX_MAP_TOP}px budget`);
});

/** A control that renders is not the same as a control anyone can use. The map is
 *  `absolute inset-0` inside its container with its tiles at z-index 10 (on #qc-map
 *  itself below 1024px, on its map pane above), so a panel placed in that container's
 *  normal flow is painted underneath the map canvas: laid out, measurable, and
 *  completely unclickable. Hit-testing is the only probe that sees it — every
 *  geometry assertion above passes while the panel is buried. This covers the bars
 *  with no card open; card-over-panels-browser.test.mjs covers them with one. */
const summaryReachable = (panel) => `(() => {
  const s = document.querySelector('${panel} .qcm-panel-summary');
  if (!s) return 'the panel summary is missing';
  s.scrollIntoView({ block: 'center' });
  const r = s.getBoundingClientRect();
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  if (!hit) return 'nothing is painted where the panel summary is';
  if (s.contains(hit) || hit === s) return null;
  return \`\${hit.tagName.toLowerCase()}\${hit.id ? '#' + hit.id : '.' + String(hit.className).trim().split(/\\s+/)[0]}\`;
})()`;

// Both panels, and the tablet widths as well: 1024px is where they move into the dock
// (and where, as overlays, they once overlapped), so it is the width where a summary
// is likeliest to be under the other panel rather than under the map.
const PANELS = [['print', '#qcm-app'], ['layer', '#qcm-layer-panel']];
for (const vp of [PHONE, { w: 768, h: 1024 }, { w: 1024, h: 768 }, { w: 1440, h: 1000 }]) {
  for (const [name, sel] of PANELS) {
    test(`the ${name} panel can actually be opened at ${vp.w}px`, { skip }, async () => {
      const blocker = await withPage(vp, (p) => p.evaluate(summaryReachable(sel)));
      assert.equal(blocker, null,
        `at ${vp.w}px a tap on the ${name} panel's summary lands on ${blocker} instead — `
        + 'the panel is painted under it');
    });
  }
}

// QUX-03b-i: the Explore panel, checked the same way as the two above but kept out
// of the shared PANELS loop deliberately — PANELS/MAX_LAYERS_GAP change only when a
// PR is actually moving panels, with the reason stated, and this unit is that PR
// for Explore alone. A standalone loop over the same summaryReachable helper proves
// the same thing without touching the frozen table.
for (const vp of [PHONE, { w: 768, h: 1024 }, { w: 1024, h: 768 }, { w: 1440, h: 1000 }]) {
  test(`the explore panel can actually be opened at ${vp.w}px`, { skip }, async () => {
    const blocker = await withPage(vp, (p) => p.evaluate(summaryReachable('#qc-explore-panel')));
    assert.equal(blocker, null,
      `at ${vp.w}px a tap on the explore panel's summary lands on ${blocker} instead — `
      + 'the panel is painted under it');
  });
}

// QUX-03b-ii: the Conditions panel, checked the same way and kept out of the frozen
// PANELS table for the same reason Explore's own loop states above — this unit is
// the PR actually moving THIS panel, so it gets its own standalone loop.
for (const vp of [PHONE, { w: 768, h: 1024 }, { w: 1024, h: 768 }, { w: 1440, h: 1000 }]) {
  test(`the conditions panel can actually be opened at ${vp.w}px`, { skip }, async () => {
    const blocker = await withPage(vp, (p) => p.evaluate(summaryReachable('#qc-conditions-panel')));
    assert.equal(blocker, null,
      `at ${vp.w}px a tap on the conditions panel's summary lands on ${blocker} instead — `
      + 'the panel is painted under it');
  });
}

// F04: the layer switches and the map key sat sixth and seventh inside the print
// builder, after Area/Paper/Scale/Overlap/Grid. On a phone that put them 1,050px
// below the bottom of the map — the reader turns a layer on, and cannot see what
// it did without scrolling a screen and a half back up. They are map controls, not
// paper settings, so they belong on the map. This measures the distance rather
// than the markup: wherever they end up, they have to be reachable from the map.
const MAX_LAYERS_GAP = 600;

const measureLayers = `(() => {
  const box = (sel) => { const el = document.querySelector(sel); if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top + scrollY), bottom: Math.round(r.bottom + scrollY) }; };
  return { map: box('#qc-map'), layers: box('#qcm-layers'), legend: box('#qcm-legend') };
})()`;

/** Opens the Layers panel (and every disclosure nested inside it — "Advanced",
 *  "Names not shown on the map") so #qcm-layers/#qcm-legend are measured where
 *  they actually land rather than where a collapsed subtree last reported it.
 *  QUX-03a's shell keeps only one of the two map panels open at a time
 *  (quiet-corners.js's wirePanels()), and both #qcm-layers and #qcm-legend live
 *  in the Layers panel only (qcm-map-layers.html), so opening just that one —
 *  not the Print panel too — is both sufficient and the state a reader who
 *  opened Layers would actually be in. */
const openLayersPanel = `(() => {
  document.getElementById('qcm-layer-panel').open = true;
  document.getElementById('qcm-app').open = false;
  document.querySelectorAll('#qcm-layer-panel details').forEach((d) => { d.open = true; });
})()`;

for (const vp of [{ w: 1440, h: 1000 }, { w: 390, h: 844 }]) {
  test(`the layer switches and the map key stay next to the map at ${vp.w}px`, { skip }, async () => {
    const seen = await withPage(vp, async (p) => {
      await p.evaluate(openLayersPanel);
      return p.evaluate(measureLayers);
    });
    assert.ok(seen.layers, '#qcm-layers is not in the page');
    assert.ok(seen.legend, '#qcm-legend is not in the page');
    for (const [name, box] of [['layer switches', seen.layers], ['map key', seen.legend]]) {
      const gap = box.top - seen.map.bottom;
      assert.ok(gap <= MAX_LAYERS_GAP,
        `the ${name} sit ${gap}px below the map at ${vp.w}px, past the ${MAX_LAYERS_GAP}px `
        + 'reach — a map control the reader cannot see the map from is not a map control');
    }
  });
}

// A11: opening a panel on a phone put the map off the screen.
//
// Each panel sits in normal flow 16px under the map at 390x844. The layer panel opened
// to 691px inside an 844px screen: scroll the least that shows all of it and 137px of a
// 506px map is left; scroll one notch further, so the panel's own top is at the top of
// the screen, and the map is gone entirely -- which is the state the audit screenshot
// caught. The print panel is the same shape and worse: measured 2026-09-10 it opened to
// 1416px, taller than the phone screen itself, so there is NO scroll position that shows
// the whole paper recipe at all and the map is at 0px by the time its bottom is reached.
// A map key -- or a paper recipe naming the area it prints -- that describes a map the
// reader cannot see while reading it is not describing anything.
//
// A panel therefore has to be bounded the way it already is on the two-column layout:
// it scrolls in its own box instead of growing down the page. The measurement is the
// reader's -- scroll the least that brings the whole open panel into view, then ask how
// much map is still on the screen. Both panels answer to the same number, so the two
// gates agree rather than each picking its own floor.

/** How much map has to stay on the screen while the whole open panel is in view.
 *  A third of the 390x844 phone screen: enough to see a county and what a switch --
 *  or a paper setting -- just did to it. */
const MIN_MAP_ON_SCREEN = 280;

const openPanel = (sel) => `(() => { const d = document.querySelector('${sel}');
  if (!d) return false; d.open = true; return d.open; })()`;

/** Scrolls the least amount that brings the whole open panel onto the screen, then
 *  reports how much of the map is still visible there. */
const mapLeftOnScreen = (sel) => `(() => {
  const first = document.querySelector('${sel}').getBoundingClientRect();
  scrollBy(0, Math.max(0, first.bottom - innerHeight));
  const m = document.getElementById('qc-map').getBoundingClientRect();
  const p = document.querySelector('${sel}').getBoundingClientRect();
  return { map: Math.round(Math.max(0, Math.min(m.bottom, innerHeight) - Math.max(m.top, 0))),
           panel: Math.round(p.height), wholePanelVisible: Math.round(p.top) >= -1 };
})()`;

for (const [name, sel] of PANELS) {
  test(`the map stays on the screen when the ${name} panel opens on a phone`, { skip }, async () => {
    const seen = await withPage(PHONE, async (p) => {
      assert.equal(await p.evaluate(openPanel(sel)), true, `the ${name} panel <details> is missing`);
      return p.evaluate(mapLeftOnScreen(sel));
    });
    assert.ok(seen.wholePanelVisible,
      `the open ${name} panel is ${seen.panel}px tall, past the ${PHONE.h}px phone screen itself`);
    assert.ok(seen.map >= MIN_MAP_ON_SCREEN,
      `with the ${seen.panel}px ${name} panel open, ${seen.map}px of map is left on a ${PHONE.h}px `
      + `screen -- below the ${MIN_MAP_ON_SCREEN}px a reader needs to see what it just did`);
  });
}

// D1: the Highlight shortcuts and Advanced controls landed inside the SAME
// #qcm-layer-panel <details> as the Layers switches (qcm-map-layers.html), ahead of
// them in the DOM. That panel already caps and scrolls itself at 60vh below 1024px
// (audit A11) rather than growing the document — the new controls only satisfy item
// 5 if they inherit that cap instead of the panel growing past it or the panel
// itself escaping the 60vh box now that it holds more. Measured, not assumed: the
// panel's own rendered height must stay bounded and the Clear-highlight button —
// the last of the new controls, so the one likeliest to fall outside a broken cap —
// must actually be reachable inside it.
// 60vh of content (the CSS cap) plus the panel's own padding/border, which sit
// outside max-height because nothing here sets box-sizing: border-box on it (measured
// overhead ~26px: 0.75rem+0.75rem padding + 1px+1px border). A generous round number
// above that, not the bare 60vh figure, or this test would be asserting a box-model
// detail rather than "the panel is capped and scrolling."
const MAX_LAYER_PANEL_HEIGHT = Math.ceil(PHONE.h * 0.6) + 40;

const layerPanelWithHighlight = `(() => {
  const panel = document.getElementById('qcm-layer-panel');
  const clear = document.getElementById('qcm-highlight-clear');
  if (!panel || !clear) return { panelHeight: -1, clearReachable: false };
  const p = panel.getBoundingClientRect();
  clear.scrollIntoView({ block: 'center' });
  const r = clear.getBoundingClientRect();
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return { panelHeight: Math.round(p.height), clearReachable: !!hit && (clear.contains(hit) || hit === clear) };
})()`;

test('the extended Layers panel (Highlight + Advanced, then Layers) still caps and scrolls within itself on a phone', { skip }, async () => {
  const seen = await withPage(PHONE, async (p) => {
    assert.equal(await p.evaluate(openPanel('#qcm-layer-panel')), true, 'the layer panel <details> is missing');
    return p.evaluate(layerPanelWithHighlight);
  });
  assert.ok(seen.panelHeight > 0, 'the layer panel did not render');
  assert.ok(seen.panelHeight <= MAX_LAYER_PANEL_HEIGHT,
    `the layer panel is ${seen.panelHeight}px tall with Highlight added, past its own ${MAX_LAYER_PANEL_HEIGHT}px `
    + 'cap (60vh) -- the new controls must scroll inside the panel, not grow it');
  assert.ok(seen.clearReachable,
    'the Clear-highlight control, last in the new Highlight block, is not reachable -- '
    + 'the extended panel is overflowing or something is painted over it');
});

// --- the panels cover neither each other nor the map (audit A04, then the dock) ---
//
// History: the print builder and the layer panel were once absolute overlays from
// min-width:1024px, anchored to opposite sides of the map container. At 1024 the print
// panel spanned x=65-417 and the layer panel x=283-587, so 134px of the layer panel's
// title was painted under the print panel. Since the dock they are rows of one column
// beside the map (#qc-sheet, grid column 1) at 1024px and up, and rows of the bottom
// sheet under the map below it. Kept: the two must still never share pixels. Added:
// the dock and the map never share pixels either, at any of these widths -- the
// owner's complaint was panels laid over the map.
const measurePanels = `(() => {
  const box = (sel) => { const el = document.querySelector(sel); if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right),
             top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
  return { print: box('#qcm-app'), layers: box('#qcm-layer-panel'),
           sheet: box('#qc-sheet'), map: box('#qc-map') };
})()`;

const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left);
const vOverlap = (a, b) => Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);

for (const vp of [{ w: 1440, h: 1000 }, { w: 1280, h: 900 }, { w: 1024, h: 768 }, { w: 768, h: 1024 }]) {
  test(`the print and layer panels do not cover each other at ${vp.w}px`, { skip }, async () => {
    const seen = await withPage(vp, (p) => p.evaluate(measurePanels));
    assert.ok(seen.print, '#qcm-app is not in the page');
    assert.ok(seen.layers, '#qcm-layer-panel is not in the page');
    const x = overlap(seen.print, seen.layers);
    const y = vOverlap(seen.print, seen.layers);
    assert.ok(x <= 0 || y <= 0,
      `at ${vp.w}px the panels share ${x}x${y}px: print ${seen.print.left}-${seen.print.right}, `
      + `layers ${seen.layers.left}-${seen.layers.right} — one is painted over the other`);
    const mx = overlap(seen.sheet, seen.map);
    const my = vOverlap(seen.sheet, seen.map);
    assert.ok(mx <= 0 || my <= 0,
      `at ${vp.w}px #qc-sheet and #qc-map share ${mx}x${my}px — the panels are laid over the map`);
  });
}

/** The dashboard ends where its content ends. #dashboard used to carry
 *  `min-height: 100vh` (#180 swapped it in for `height: 100vh; overflow: hidden`),
 *  but it starts below the ~84px site header, so on any screen taller than its
 *  content it padded out an empty band before the methodology: 83px at 1440x900,
 *  258px at 1440x1600, 218px at 2560x1440. Nothing in the band is clickable or
 *  readable; it only pushes #documentation further down. Measured after the data
 *  has loaded, since the tables and cards are what fill the column. */
const emptyBand = `(() => {
  const d = document.getElementById('dashboard'), doc = document.getElementById('documentation');
  if (!d || !doc) return { missing: !d ? '#dashboard' : '#documentation' };
  let content = 0;
  for (const c of d.children) {
    const b = c.getBoundingClientRect();
    if (b.height > 0) content = Math.max(content, b.bottom);
  }
  return { gap: Math.round(doc.getBoundingClientRect().top - content) };
})()`;

for (const vp of [{ w: 1440, h: 900 }, { w: 1440, h: 1600 }, { w: 2560, h: 1440 }, { w: 1024, h: 768 }, PHONE]) {
  test(`no empty band between the dashboard and its documentation at ${vp.w}x${vp.h}`, { skip }, async () => {
    const seen = await withPage(vp, async (p) => { await readyDashboard(p); return p.evaluate(emptyBand); });
    assert.equal(seen.missing, undefined, `${seen.missing} is not in the page`);
    assert.ok(seen.gap <= 1,
      `at ${vp.w}x${vp.h} the documentation starts ${seen.gap}px below the dashboard's last content`);
  });
}
