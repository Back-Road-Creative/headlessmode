// Every control on the dashboard, measured as a thumb meets it (audit F05/F06).
//
// The finder button was brought to 122x44 on a phone in #470 and
// find-and-scale.test.mjs holds it there — but it was the only control anyone
// measured. Everything else on the page kept the desktop treatment: the 14 map
// layer switches are a 13x13 checkbox in a 20.6px label, the 20 print-builder
// controls run 17-32px tall, the five filter sliders are the UA default 16px,
// the pagination buttons 28.7px, and the Leaflet zoom pair 30x30 in the same
// control lane the 44px finder button already sits in.
//
// Two separate gates, because they fail differently:
//
//   1. Size and reachability. 44px is this product's own touch-target goal
//      (find-and-scale.test.mjs states the provenance: WCAG 2.2 Target Size
//      asks 24px at AA, 44px is the AAA figure). A control that is big enough
//      but painted under something else is the same failure to a thumb, so the
//      centre of every target is hit-tested as well — the idiom layout.test.mjs
//      already uses for the panel summaries.
//   2. Font size on anything you type into. Mobile Safari zooms the whole page
//      when a focused field's text is under 16px, which throws the reader out
//      of the map. Same number find-and-scale.test.mjs holds #qc-place-search to.
//
// The effective target is the wrapping <label>, not the raw box: a 13x13
// checkbox inside a label is hit by tapping the label's words.
//
// Both gates are scoped to 390x844. The desktop control lane is 30px wide and
// must stay that way; find-and-scale.test.mjs asserts it does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt() ? 'public/quiet-corners/ not built — run `hugo --configDir site-config --minify` first'
    : false;

const PHONE = { w: 390, h: 844 };
const TOUCH_GOAL = 44;
const NO_ZOOM_FONT_PX = 16;

/** Leaflet's zoom pair are anchors, not buttons, so they are named explicitly;
 *  everything else a thumb presses on this page is an input, select or button. */
const CONTROLS = '#dashboard input, #dashboard select, #dashboard button, '
  + '#dashboard .leaflet-control-zoom a';

/** Anything a reader types or picks into. A closed <details> can report stale
 *  non-zero rects for its descendants (mid-close-transition leftovers), not a
 *  clean 0x0 -- so a control is never trusted just because its own rect looks
 *  empty. Instead each panel is opened in its own pass below and a control is
 *  measured only in the pass where its actual panel (via .closest()) is open. */
const TEXT_FIELDS = '#dashboard input:not([type="checkbox"]):not([type="radio"])'
  + ':not([type="range"]), #dashboard select';

/** The shell's exclusive panels (PANEL_IDS in panel-state.js): Layers and Print
 *  from QUX-03a, Explore from QUX-03b-i -- the filters, score controls and both
 *  tables now live inside it, closed by default. Only one is ever open at once
 *  (wirePanels() in quiet-corners.js), so a single `openEveryPanel` pass would
 *  leave the others closed -- each is opened in its own pass instead, with the
 *  always-visible controls outside every panel (zoom, the finder) measured on
 *  the first pass only so they are not counted twice. A control inside a panel
 *  this list does not name would be measured while its panel is closed and
 *  report "nothing painted at its centre" (that is how QUX-03b-i's move was
 *  caught), so a new panel must be added here, never worked around. */
const PANEL_IDS = ['qcm-layer-panel', 'qcm-app', 'qc-explore-panel', 'qc-conditions-panel'];
const PANEL_SELECTOR = PANEL_IDS.map((id) => '#' + id).join(', ');
const PANEL_PASSES = PANEL_IDS.map((id, i) => ({ id, includeOutside: i === 0 }));

/** Opens `panelId` (and any <details> nested inside it -- e.g. Layers' own
 *  "Advanced" and "Names not shown" disclosures) and closes the other panels,
 *  the same one-at-a-time state a real reader produces by clicking a summary. */
function openPanelScript(panelId) {
  return `(() => {
    for (const id of ${JSON.stringify(PANEL_IDS)}) {
      const d = document.getElementById(id);
      if (!d) throw new Error('panel #' + id + ' is missing from the dashboard');
      d.open = id === ${JSON.stringify(panelId)};
    }
    document.querySelectorAll('#${panelId} details').forEach((d) => { d.open = true; });
  })()`;
}

const name = "(el) => el.id ? '#' + el.id : el.tagName.toLowerCase() "
  + "+ (el.type ? '[type=' + el.type + ']' : '') "
  + "+ (String(el.className).trim() ? '.' + String(el.className).trim().split(/\\s+/)[0] : '')";

/** The box a thumb actually lands on: the wrapping label where there is one. */
const effective = "(el) => { const lab = el.closest('label'); "
  + 'return (lab && lab.contains(el)) ? lab : el; }';

/** True when `el` belongs to this pass: outside both panels (only on the pass
 *  that claims those) or inside the panel this pass just opened. */
const inScope = (panelId, includeOutside) => `(el) => {
  const host = el.closest('${PANEL_SELECTOR}');
  return host ? host.id === ${JSON.stringify(panelId)} : ${includeOutside};
}`;

const smallTargetsFor = (panelId, includeOutside) => `(() => {
  const name = ${name}, effective = ${effective}, inScope = ${inScope(panelId, includeOutside)}, out = [];
  for (const el of document.querySelectorAll('${CONTROLS}')) {
    if (!inScope(el)) continue;
    const target = effective(el);
    target.scrollIntoView({ block: 'center' });
    const r = target.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const size = Math.round(r.width) + 'x' + Math.round(r.height);
    if (r.width < ${TOUCH_GOAL} || r.height < ${TOUCH_GOAL}) {
      out.push(name(el) + ' measures ' + size); continue;
    }
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    if (!hit) { out.push(name(el) + ' (' + size + ') has nothing painted at its centre'); continue; }
    if (target !== hit && !target.contains(hit)) {
      out.push(name(el) + ' (' + size + ') is painted under ' + name(hit));
    }
  }
  return out;
})()`;

const smallFontsFor = (panelId, includeOutside) => `(() => {
  const name = ${name}, inScope = ${inScope(panelId, includeOutside)}, out = [];
  for (const el of document.querySelectorAll('${TEXT_FIELDS}')) {
    if (!inScope(el)) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const px = parseFloat(getComputedStyle(el).fontSize);
    if (px < ${NO_ZOOM_FONT_PX}) out.push(name(el) + ' is ' + px + 'px');
  }
  return out;
})()`;

/** One saved place, so the scan meets a saved-places row's Show / Share /
 *  Remove as well as the section's own controls. A fresh page has no row, and a
 *  control the scan never sees is a control it cannot hold to 44px (QUX-09a).
 *  Same seeding idiom as saved-places-browser.test.mjs case 4. */
const SEED_SAVED_PLACE = JSON.stringify({
  schemaVersion: 1,
  places: [{ ref: 'gnis:555001', name: 'Phone Scan Summit', kind: 'summit', lat: 36.1, lon: -82.2,
    state: 'NC', county: 'Test County', savedAt: '2026-09-01T00:00:00.000Z' }],
});
const seedSavedPlace = `localStorage.setItem('qc-saved-places', ${JSON.stringify(SEED_SAVED_PLACE)});`;

async function onPhone(exprFor) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', {
    viewport: { width: PHONE.w, height: PHONE.h }, args: ['--hide-scrollbars'],
  });
  try {
    const { identifier } = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: seedSavedPlace });
    await page.navigate(`${site.origin}/quiet-corners/`);
    await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    await readyDashboard(page, { data: false });
    await waitInPage(page, 'the seeded saved-places row', "document.querySelector('.qc-saved-row') != null");
    let out = [];
    for (const pass of PANEL_PASSES) {
      await page.evaluate(openPanelScript(pass.id));
      await page.evaluate('new Promise(r => setTimeout(r, 400))');
      const found = await page.evaluate(exprFor(pass.id, pass.includeOutside));
      out = out.concat(found);
    }
    return out;
  } finally { page.close(); await site.close(); }
}

test('every dashboard control is a 44px target a thumb can reach on a phone', { skip }, async () => {
  const missed = await onPhone(smallTargetsFor);
  assert.deepEqual(missed, [],
    `${missed.length} control(s) on a ${PHONE.w}px screen are under the ${TOUCH_GOAL}px this `
    + `product aims for, or are painted under something else:\n  ${missed.join('\n  ')}`);
});

test('no dashboard field is small enough to zoom the page on a phone', { skip }, async () => {
  const tiny = await onPhone(smallFontsFor);
  assert.deepEqual(tiny, [],
    `${tiny.length} field(s) carry text under ${NO_ZOOM_FONT_PX}px, so mobile Safari zooms the `
    + `whole page the moment one is focused:\n  ${tiny.join('\n  ')}`);
});

// QQA-05d: the small text on the map's own controls, read as the browser computes it.
// The 44px gate above says a thumb can hit these; this says the label on them is
// readable. type-scale.test.mjs holds the same numbers against the stylesheet text.
const MAP_TEXT = [
  { sel: '.qc-view-btn', min: 14, what: 'Share/Reset/Use my location' },
  { sel: '.qcm-preset', min: 14, what: 'a starting-set button' },
  { sel: '.qc-terrain-open', min: 14, what: 'the 3D button' },
  { sel: '.leaflet-control-attribution', min: 12, what: 'the map credit line' },
];

// QQA-05e: the credit is folded behind a "Credits" chip on a phone, so it is opened first --
// its text is still held to 12px once a reader taps it.
const mapTextFor = (panelId, includeOutside) => `(() => {
  const chip = document.querySelector('#dashboard .qc-credit-toggle');
  if (chip && chip.getAttribute('aria-expanded') !== 'true') chip.click();
  const inScope = ${inScope(panelId, includeOutside)}, out = [];
  for (const { sel, min, what } of ${JSON.stringify(MAP_TEXT)}) {
    for (const el of document.querySelectorAll('#dashboard ' + sel)) {
      if (!inScope(el)) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const px = parseFloat(getComputedStyle(el).fontSize);
      out.push((px < min ? 'SMALL ' : 'ok ') + what + ' (' + sel + ') is ' + px + 'px, needs ' + min);
    }
  }
  return out;
})()`;

test('the map controls and credit line carry readable text on a phone', { skip }, async () => {
  const seen = await onPhone(mapTextFor);
  const small = seen.filter((s) => s.startsWith('SMALL '));
  assert.deepEqual(small, [], `text under its floor on a ${PHONE.w}px screen:\n  ${small.join('\n  ')}`);
  for (const { sel, what } of MAP_TEXT) {
    assert.ok(seen.some((s) => s.includes(`(${sel})`)),
      `${what} (${sel}) was never rendered, so its size was not measured`);
  }
});
