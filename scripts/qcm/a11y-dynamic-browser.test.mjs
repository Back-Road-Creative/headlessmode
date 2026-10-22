// QQA-07 (finding F09): dynamic accessibility checks on the BUILT Field Maps app, offline.
//
// pa11y (CI) runs once, on the first paint, and caps "needs review" at a warning. This file
// drives the app into the states a reader reaches and holds each to zero:
//   - axe-core, WCAG 2.2 A and AA, with no violations AND nothing left in "needs review"
//     that EXCLUSIONS below does not name (an exclusion names a rule, a selector and a reason);
//   - the keyboard: Tab reaches every dock control and the finder, a focused control is never
//     off screen or covered (WCAG 2.4.11), Escape closes the finder and a card and gives focus back;
//   - touch targets (product floor 44 px; WCAG 2.5.8 asks 24), 200% text, and reflow at 320 px;
//   - the contrast of the labels the app paints on the map itself, which axe cannot see.
// The app is /quiet-corners/ (the Field Maps app); /quiet-corners/maps/ is its documentation page,
// audited as the first state. No request leaves the box: helpers/a11y-dynamic.mjs answers tiles and services.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium } from './helpers/browser.mjs';
import { connectSession } from './helpers/cdp-session.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage, chooseExampleArea } from './helpers/waits.mjs';
import { contrastRatio, composite } from './helpers/contrast.mjs';
import { stubOffline, runAxe, describeFindings, pressKey, tabThrough, FOCUS_READ } from './helpers/a11y-dynamic.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

// Every waiver. A rule id, the kind of finding (axe "violations" or "incomplete" = needs review),
// a selector and a reason that is true today. Nothing is switched off for a whole rule or page.
// `plate`: axe could not score the text, so assertClean measures it instead, in every state, against
// its own background (ancestors composited, over pure white AND pure black when the plate is
// translucent) at 4.5:1, or `plate: 3` for a one-symbol control or large text (WCAG 1.4.11 / 1.4.3).
const MAP_TEXT = '.qc-place-label, .qcm-sheet-label, .qcm-name-label, .qcm-road-label, .qc-terrain-name-label, .qc-terrain-road-label';
const GLYPHS = '.leaflet-control-zoom a > span[aria-hidden], .qc-reset-view, .qc-finder-toggle, .leaflet-popup-close-button > span[aria-hidden]';
const OVER_MAP = '.qc-legend-note, .leaflet-control-attribution, .leaflet-control-attribution a, .maplibregl-ctrl-attrib-inner, .maplibregl-ctrl-attrib-inner a, '
  + '#qcm-area-strip-text, #qcm-area-edit, #qcm-area-clear, #qc-place-results [role="option"], #qc-sheet summary, #qc-sheet svg text, .qc-terrain-open, #qc-view-share, #qc-view-reset, #qc-locate';
const EXCLUSIONS = [
  {
    rule: 'color-contrast', kind: 'incomplete', selector: MAP_TEXT, plate: 4.5,
    reason: 'These are DOM labels painted over Leaflet raster tiles or the MapLibre canvas. axe cannot read pixels, so it can '
      + 'only say "needs review". Their own contrast is asserted instead, against their own plate (here, and in "owned map label contrast" below).',
  },
  {
    rule: 'color-contrast', kind: 'incomplete', selector: GLYPHS, plate: 3,
    reason: 'These buttons carry a single symbol (+, a house, a magnifier, a close cross), which axe reports as "only non-text characters" '
      + 'or "too short" and will not score. They are named by aria-label; the symbol against its own colour is asserted at 3:1 (WCAG 1.4.11).',
  },
  {
    rule: 'color-contrast', kind: 'incomplete', selector: '.leaflet-control-scale-line', plate: 4.5,
    reason: 'Leaflet draws the scale text with a 1px white text-shadow, which axe reports as "complex text shadows" and will not score. '
      + 'Its colour against its own plate is asserted at 4.5:1.',
  },
  {
    rule: 'color-contrast', kind: 'incomplete', selector: OVER_MAP, plate: 4.5,
    reason: 'These controls and credits sit over the map (or, for #qc-sheet rows on a phone, under the open finder popover). axe reports '
      + '"overlapped by / partially overlaps another element" because the map and its popovers lie under or over their boxes, and cannot '
      + 'say what is behind them. Each one has its own opaque plate; its colour against that plate is asserted at 4.5:1.',
  },
  {
    rule: 'color-contrast', kind: 'incomplete', selector: '.qc-sort-caret[aria-hidden="true"]',
    reason: 'A decorative sort arrow, hidden from assistive technology (aria-hidden); the column name beside it and the sort state carry the meaning. '
      + 'axe reports "only non-text characters".',
  },
  {
    rule: 'target-size', kind: 'incomplete', selector: '.qc-terrain-open',
    reason: 'On a phone the open place finder is a popover that deliberately lies over the control lane below it, so axe cannot be sure of the '
      + 'button\'s free space ("partially obscured by a neighbor"). The button itself measures >= 44x44 in "touch targets" below.',
  },
  {
    rule: 'color-contrast', kind: 'incomplete', selector: '.section-heading',
    reason: 'axe\'s overlap grid counts the Leaflet overlay SVG that extends below the map box (the map clips it, overflow hidden), so the '
      + 'documentation heading under the map is reported as "overlapped". Its true state is asserted by elementFromPoint after it is scrolled into view, in "documentation heading is not covered" below.',
  },
];

// Layers hidden for the length of one axe run. They are pictures (raster tiles and marker images, the 2D canvas, vector overlays, the 3D canvas)
// axe cannot read as colour anyway, and they break it: Leaflet tiles use mix-blend-mode: plus-lighter, which axe has no blend function for ("Axe
// encountered an error" on the nodes under them), and its overlap grid counts their clipped images. Text is not hidden.
const PIXEL_LAYERS = ['.leaflet-container img', '.leaflet-container canvas', '.leaflet-overlay-pane svg', '.qc-terrain-dialog canvas'];

/** The plate check for every EXCLUSIONS entry that has one: text colour (SVG text: fill) against the ancestors' backgrounds, composited. */
const PLATE_CHECK = (entries) => `(() => {
  const parse = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return null; const v = m[1].split(/[ ,\\/]+/).map(Number); return { rgb: v.slice(0, 3), a: v.length > 3 ? v[3] : 1 }; };
  const lum = ([r, g, b]) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const over = (top, under) => top.rgb.map((v, i) => v * top.a + under[i] * (1 - top.a));
  const out = [];
  for (const { selector, need } of ${JSON.stringify(entries)}) for (const el of document.querySelectorAll(selector)) {
    const r = el.getBoundingClientRect(); if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
    const cs = getComputedStyle(el), text = parse(el instanceof SVGElement ? cs.fill : cs.color);
    if (!text) { out.push(selector + ': cannot read the text colour'); continue; }
    const layers = []; for (let n = el; n; n = n.parentElement) { const b = parse(getComputedStyle(n).backgroundColor); if (b && b.a > 0) { layers.push(b); if (b.a === 1) break; } }
    const px = parseFloat(cs.fontSize), large = px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700);
    const floor = large ? Math.min(need, 3) : need;
    let worst = Infinity;
    for (const ground of [[255, 255, 255], [0, 0, 0]]) {
      let bg = ground; for (const l of [...layers].reverse()) bg = over(l, bg);
      worst = Math.min(worst, ratio(over(text, bg), bg));
    }
    if (worst < floor) out.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className.baseVal ?? el.className).trim().split(/\\s+/)[0]) + ' ' + worst.toFixed(2) + ':1, needs ' + floor);
  }
  return out;
})()`;

const PHONE = { w: 390, h: 844 };
const DESKTOP = { w: 1280, h: 800 };
const SLOW = 170000;

let site = null;
let session = null;
let refused = null;
before(async () => {
  if (skip) return;
  site = await startSiteServer();
  session = await connectSession({ args: ['--hide-scrollbars'] });
  refused = await stubOffline(session, site.origin);
  await session.send('Page.enable');
});
after(async () => {
  if (session) session.close();
  if (site) await site.close();
});

const viewport = (vp) => session.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false });
/** Loads the app fresh at `vp`. `area` draws the example area (zoom and name layers need it). */
async function openApp(vp, { area = false } = {}) {
  await viewport(vp);
  await session.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(session, { ms: 60000 });
  if (area) await chooseExampleArea(session);
}
const tick = (id) => session.evaluate(`(() => { const cb = document.getElementById('${id}'); cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); true; })()`);
const openPanel = async (summarySel) => {
  await session.evaluate(`document.querySelector(${JSON.stringify(summarySel)}).click(); true`);
  await session.evaluate(`new Promise((r) => setTimeout(r, 400))`);
};
const PANELS = [
  ['Explore', '#qc-explore-summary', '#qc-explore-panel'],
  ['Conditions', '#qc-conditions-summary', '#qc-conditions-panel'],
  ['Layers and map key', '#qcm-layer-panel > summary', '#qcm-layer-panel'],
  ['Print field maps', '#qcm-app > summary', '#qcm-app'],
];
const openFinder = async () => {
  await session.evaluate(`document.querySelector('.qc-finder-toggle').click(); true`);
  await waitInPage(session, 'the finder box to open', `(() => { const b = document.querySelector('.qc-finder-box'); return Boolean(b) && !b.hidden; })()`, 15000, null);
};
const findPlaces = (term) => session.evaluate(`(() => {
  const box = document.getElementById('qc-place-search');
  box.focus(); box.value = ${JSON.stringify(term)};
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return document.querySelectorAll('#qc-place-results [role="option"]').length;
})()`);
/** Names on over the example area, then one name's card opened from the keyboard. */
async function openNameCard() {
  await tick('qcm-layer-names');
  await session.evaluate(`document.getElementById('qcm-check').click(); true`);
  await waitInPage(session, 'name markers', `document.querySelectorAll('.qcm-name-marker').length > 0`, 30000, null);
  await waitInPage(session, 'the Check pass to finish', `!document.getElementById('qcm-check').disabled`, 30000, null);
  await session.evaluate(`document.querySelector('.qcm-name-marker').focus(); true`);
  await pressKey(session, 'Enter');
  await waitInPage(session, 'the name card', `Boolean(document.querySelector('.qcm-site-card'))`, 15000, null);
}

/** axe over the page as it is now, asserting nothing is left over after the EXCLUSIONS. */
async function assertClean(state) {
  // A Leaflet card fades in over a few hundred ms; axe sampling it mid-fade measures a half-transparent colour that nobody sees.
  await session.evaluate(`new Promise((r) => { const t0 = Date.now(); const tick = () => (document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity) || Date.now() - t0 > 3000) ? r(true) : setTimeout(tick, 50); tick(); })`);
  const r = await runAxe(session, EXCLUSIONS, PIXEL_LAYERS);
  const bad = [...r.violations.map((v) => ({ ...v, rule: `${v.rule} [violation]` })), ...r.incomplete.map((v) => ({ ...v, rule: `${v.rule} [needs review]` }))];
  assert.equal(bad.length, 0, `${state}: ${bad.length} accessibility finding(s)\n${describeFindings(bad)}`);
  const thin = await session.evaluate(PLATE_CHECK(EXCLUSIONS.filter((e) => e.plate).map((e) => ({ selector: e.selector, need: e.plate }))));
  assert.deepEqual(thin, [], `${state}: text axe could not score is under its contrast floor on its own plate`);
  return r;
}

// ---- 1. axe, state by state ----------------------------------------------------------------

test('axe: the Field Maps documentation page (/quiet-corners/maps/) has no findings', { skip }, async () => {
  await viewport(DESKTOP);
  await session.navigate(`${site.origin}/quiet-corners/maps/`);
  await assertClean('documentation page, 1280x800');
});

test('axe: initial load at 1280x800', { skip }, async () => {
  await openApp(DESKTOP);
  await assertClean('initial load, 1280x800');
});

test('axe: the example area drawn with place names, 1280x800', { skip }, async () => {
  await openApp(DESKTOP, { area: true });
  await tick('qcm-layer-names');
  await tick('qcm-layer-roads');
  await session.evaluate(`document.getElementById('qcm-check').click(); true`);
  await waitInPage(session, 'name markers', `document.querySelectorAll('.qcm-name-marker').length > 0`, 30000, null);
  await assertClean('example area with names, 1280x800');
});

for (const [name, summary, panel] of PANELS) {
  test(`axe: dock panel "${name}" open at 1280x800`, { skip }, async () => {
    await openApp(DESKTOP);
    await openPanel(summary);
    assert.equal(await session.evaluate(`document.querySelector(${JSON.stringify(panel)}).open`), true, `${name} did not open`);
    await assertClean(`${name} panel, 1280x800`);
  });
}

test('axe: phone 390x844 with the bottom sheet at half and expanded', { skip }, async () => {
  await openApp(PHONE);
  await assertClean('phone, sheet collapsed');
  await openPanel('#qcm-layer-panel > summary');
  assert.equal(await session.evaluate(`document.getElementById('qc-sheet').dataset.sheet`), 'half');
  await assertClean('phone, sheet half');
  await session.evaluate(`document.querySelector('.qc-sheet-size').click(); true`);
  await session.evaluate(`new Promise((r) => setTimeout(r, 400))`);
  assert.equal(await session.evaluate(`document.getElementById('qc-sheet').dataset.sheet`), 'expanded');
  await assertClean('phone, sheet expanded');
});

test('axe: the place finder open with results (1280x800 and phone)', { skip }, async () => {
  for (const vp of [DESKTOP, PHONE]) {
    await openApp(vp);
    await openFinder();
    const n = await findPlaces('Sylva');
    assert.ok(n > 0, `the finder offered nothing for "Sylva" at ${vp.w}px`);
    await assertClean(`finder with ${n} result(s), ${vp.w}x${vp.h}`);
  }
});

test('axe: a feature card open (1280x800 and phone)', { skip }, async () => {
  for (const vp of [DESKTOP, PHONE]) {
    await openApp(vp, { area: true });
    await openNameCard();
    await assertClean(`name card, ${vp.w}x${vp.h}`);
  }
});

// ---- 3D: needs WebGL; a browser without it is a stated skip, never a pass -----------------------

const WEBGL = `(() => { try { const c = document.createElement('canvas'); return Boolean(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; } })()`;
async function openTerrain() {
  await session.evaluate(`document.querySelector('.qc-terrain-open').click(); true`);
  await waitInPage(session, 'a canvas in the 3D dialog', `Boolean(document.querySelector('.qc-terrain-dialog canvas'))`, SLOW, null);
  await waitInPage(session, 'the 3D map to be reachable', `Boolean(window.qcTerrainView && window.qcTerrainView.inspect())`, 30000, null);
  await session.evaluate(`new Promise((res, rej) => { const m = window.qcTerrainView.inspect();
    const t = setTimeout(() => rej(new Error('3D map never went idle')), 100000);
    m.once('idle', () => { clearTimeout(t); res(true); }); m.triggerRepaint(); })`, { timeoutMs: SLOW });
}

test('axe: the 3D dialog open (skipped, stated, when this Chromium has no WebGL)', { skip }, async (t) => {
  await openApp(DESKTOP, { area: true });
  await tick('qcm-layer-names');
  await tick('qcm-layer-trails');
  await session.evaluate(`document.getElementById('qcm-check').click(); true`);
  await waitInPage(session, 'name markers', `document.querySelectorAll('.qcm-name-marker').length > 0`, 30000, null);
  if (!await session.evaluate(WEBGL)) {
    t.skip('STATED SKIP: this Chromium creates no WebGL context, so the MapLibre 3D dialog cannot draw; its labels are still contrast-checked from their stylesheet rule in "owned map label contrast".');
    return;
  }
  await openTerrain();
  await assertClean('3D dialog, 1280x800');
  // The dialog's own keyboard contract: Escape closes it and focus goes back to the button that opened it.
  await pressKey(session, 'Escape');
  await waitInPage(session, 'the 3D dialog to close', `(() => { const d = document.querySelector('.qc-terrain-dialog'); return !d || d.hidden; })()`, 15000, null);
  assert.equal(await session.evaluate(`document.activeElement.classList.contains('qc-terrain-open')`), true, 'Escape closed the 3D dialog but focus did not return to its opener');
});

// ---- 2. keyboard ---------------------------------------------------------------------------

// The dock at >= 1024 px: the four panel summaries, the map's own controls and the view buttons.
const DOCK_CONTROLS = {
  'Explore': '#qc-explore-summary', 'Conditions': '#qc-conditions-summary',
  'Layers and map key': '#qcm-layer-panel > summary', 'Print field maps': '#qcm-app > summary',
  'Zoom in': '.leaflet-control-zoom-in', 'Zoom out': '.leaflet-control-zoom-out',
  'Show the whole country': '.qc-reset-view', 'Search places (the finder)': '.qc-finder-toggle',
  'View in 3D': '.qc-terrain-open', 'Share view': '#qc-view-share', 'Reset view': '#qc-view-reset', 'Use my location': '#qc-locate',
};
const hidden = (stops) => stops.filter((s) => !s.inView || !s.reached)
  .map((s) => `${s.name} "${s.label}" ${s.label ? '' : '[' + s.attrs + '] '}at ${s.rect.join(',')} (${s.inView ? `covered by ${s.owner}` : 'outside the viewport'})`);

test('keyboard: Tab reaches every dock control and the finder, and focus is never hidden (1280x800)', { skip }, async () => {
  await openApp(DESKTOP);
  const stops = await tabThrough(session, 150, Object.values(DOCK_CONTROLS));
  const reached = new Set(stops.flatMap((s) => s.matched));
  const missed = Object.entries(DOCK_CONTROLS).filter(([, sel]) => !reached.has(sel)).map(([n]) => n);
  assert.deepEqual(missed, [], `Tab never reached: ${missed.join(', ')} (${stops.length} stops: ${stops.map((x) => x.name).join(' > ')})`);
  assert.deepEqual(hidden(stops), [], 'a focused control was off screen or covered');
});

test('keyboard: focus stays visible through the open Layers panel (1280x800) and the open bottom sheet (phone)', { skip }, async () => {
  await openApp(DESKTOP);
  await openPanel('#qcm-layer-panel > summary');
  assert.deepEqual(hidden(await tabThrough(session, 150)), [], '1280: a focused control was off screen or covered with Layers open');
  await openApp(PHONE);
  await openPanel('#qcm-layer-panel > summary');
  assert.deepEqual(hidden(await tabThrough(session, 150)), [], 'phone: a focused control was off screen or covered with the sheet at half');
  // Slice 2 (not asserted here): with the sheet EXPANDED on a phone, five map controls stay in the Tab order under the sheet,
  // the area strip and the header link -- Zoom in, Search places, Share view, Use my location, Map credits (see the RETURN of QQA-07).
});

test('keyboard: Escape closes the finder and returns focus to its button', { skip }, async () => {
  await openApp(DESKTOP);
  await session.evaluate(`document.querySelector('.qc-finder-toggle').focus(); true`);
  await pressKey(session, 'Enter');
  await waitInPage(session, 'the finder box to open', `!document.querySelector('.qc-finder-box').hidden`, 15000, null);
  assert.ok(await findPlaces('Sylva') > 0, 'the finder offered nothing for "Sylva"');
  assert.equal(await session.evaluate(`document.activeElement.id`), 'qc-place-search');
  // The box's own contract (quiet-corners.js): the first Escape clears a query in progress and keeps focus in the input,
  // the second, on an empty box, closes it and hands focus back to the button.
  await pressKey(session, 'Escape');
  await waitInPage(session, 'the query to clear', `document.getElementById('qc-place-search').value === ''`, 15000, null);
  assert.equal(await session.evaluate(`document.activeElement.id`), 'qc-place-search', 'the first Escape should keep focus in the input');
  await pressKey(session, 'Escape');
  await waitInPage(session, 'the finder box to close', `document.querySelector('.qc-finder-box').hidden`, 15000, null);
  assert.equal(await session.evaluate(`document.activeElement.classList.contains('qc-finder-toggle')`), true,
    `focus after Escape is ${await session.evaluate('document.activeElement.tagName + "." + document.activeElement.className')}, not the finder button`);
});

test('keyboard: Escape closes a feature card and returns focus to the marker that opened it', { skip }, async () => {
  await openApp(DESKTOP, { area: true });
  await openNameCard();
  assert.deepEqual(hidden([await session.evaluate(FOCUS_READ)].filter(Boolean)), [], 'the focused control in the open card is hidden');
  await pressKey(session, 'Escape');
  await waitInPage(session, 'the card to close', `![...document.querySelectorAll('.qcm-site-card')].some((c) => c.closest('.leaflet-popup')?.style.opacity !== '0')`, 15000, null);
  assert.equal(await session.evaluate(`document.activeElement.classList.contains('qcm-name-marker')`), true,
    `focus after Escape is ${await session.evaluate('document.activeElement.tagName + "." + document.activeElement.className')}, not the marker`);
});

// ---- 3. touch targets, text scaling, reflow -----------------------------------------------------

const TOUCH_FLOOR = 44; // WCAG 2.5.8 asks 24 CSS px; the product floor is 44 (touch_goal in the other qcm tests)
// The primary touch controls at phone width, each with why it is primary.
const PRIMARY_TOUCH = [
  ['#qc-explore-summary', 'opens the Explore panel: the first thing a reader does'],
  ['#qc-conditions-summary', 'opens Conditions'],
  ['#qcm-layer-panel > summary', 'opens Layers, the only way to turn a layer on'],
  ['#qcm-app > summary', 'opens the print builder'],
  ['.leaflet-control-zoom-in', 'zoom is the main map gesture without a pinch'],
  ['.leaflet-control-zoom-out', 'zoom out'],
  ['.qc-reset-view', 'gets a lost reader back to the whole country'],
  ['.qc-finder-toggle', 'the place finder'],
  ['.qc-terrain-open', 'opens 3D terrain'],
  ['#qc-view-share', 'shares the view'],
  ['#qc-view-reset', 'resets the view'],
  ['#qc-locate', 'centres on the reader'],
  ['.qc-sheet-handle', 'resizes the bottom sheet'],
];
const SHEET_OPEN_TOUCH = [
  ['#qcm-layer-panel .qcm-panel-close', 'closes the open panel'],
  ['.qc-sheet-size', 'switches the sheet between half and expanded'],
];
const sizes = (list) => session.evaluate(`${JSON.stringify(list.map(([s]) => s))}.map((sel) => {
  const el = document.querySelector(sel), r = el && el.getBoundingClientRect();
  return { sel, w: r ? Math.round(r.width * 10) / 10 : 0, h: r ? Math.round(r.height * 10) / 10 : 0 };
})`);
const tooSmall = (list, found) => found.filter((f) => f.w < TOUCH_FLOOR || f.h < TOUCH_FLOOR)
  .map((f) => `${f.sel} is ${f.w}x${f.h} (${list.find(([s]) => s === f.sel)[1]})`);

test('touch targets: every primary control measures >= 44x44 CSS px at 390x844', { skip }, async () => {
  await openApp(PHONE);
  const closed = tooSmall(PRIMARY_TOUCH, await sizes(PRIMARY_TOUCH));
  await openPanel('#qcm-layer-panel > summary');
  const open = tooSmall(SHEET_OPEN_TOUCH, await sizes(SHEET_OPEN_TOUCH));
  assert.deepEqual([...closed, ...open], [], 'primary controls under the 44x44 touch floor');
});

/** Text a control cannot show: a labelled control whose content is wider than its own box. */
const CLIPPED = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('button, summary, a[href], label, select, [role="button"]')) {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'inline' || el.closest('[hidden], .leaflet-tile-pane')) continue;
    if (!(el.textContent || '').trim()) continue;
    if (el.classList.contains('skip-link') && !el.matches(':focus')) continue; // a 1px clip by design (style.css .skip-link), shown in full on :focus
    if (el.scrollWidth > el.clientWidth + 1) out.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).trim().split(/\\s+/)[0]) + ' "' + el.textContent.trim().slice(0, 30) + '" ' + el.scrollWidth + ' > ' + el.clientWidth);
  }
  return out;
})()`;
const OVERFLOW = `(() => ({ doc: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }))()`;
/** What runs past the right edge outside the map (the map is the one thing allowed to pan). */
const WIDE = `[...document.body.querySelectorAll('*')].filter((el) => {
  if (el.parentElement && el.parentElement.closest('.leaflet-container')) return false;
  const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
  return r.width && cs.visibility !== 'hidden' && r.right > document.documentElement.clientWidth + 1;
}).slice(0, 8).map((el) => (el.parentElement ? (el.parentElement.id ? '#' + el.parentElement.id : el.parentElement.tagName.toLowerCase() + '.' + String(el.parentElement.className.baseVal ?? el.parentElement.className).trim().split(/\\s+/)[0]) + ' > ' : '') + (el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className.baseVal ?? el.className).trim().split(/\\s+/)[0]) + ' right=' + Math.round(el.getBoundingClientRect().right))`;

/** Offenders present in two reads 400 ms apart: a row mid-scroll as a panel opens is not an overflow. */
async function stableWide() {
  const first = await session.evaluate(WIDE);
  await session.evaluate(`new Promise((r) => setTimeout(r, 400))`);
  const second = await session.evaluate(WIDE);
  return first.filter((x) => second.includes(x));
}

test('text scaling: at 200% text nothing labelled is clipped and the page does not scroll sideways at 390px', { skip }, async () => {
  await openApp(PHONE);
  await session.evaluate(`document.documentElement.style.fontSize = '200%'; true`);
  await session.evaluate(`new Promise((r) => setTimeout(r, 400))`);
  assert.deepEqual(await session.evaluate(CLIPPED), [], '200%, panels closed: clipped text');
  const closed = await session.evaluate(OVERFLOW);
  assert.ok(closed.doc <= closed.view + 1, `200%, panels closed: the page is ${closed.doc}px wide in a ${closed.view}px viewport: ${(await session.evaluate(WIDE)).join('; ')}`);
  await openPanel('#qcm-layer-panel > summary');
  assert.deepEqual(await session.evaluate(CLIPPED), [], '200%, Layers open: clipped text');
  const open = await session.evaluate(OVERFLOW);
  assert.ok(open.doc <= open.view + 1, `200%, Layers open: the page is ${open.doc}px wide in a ${open.view}px viewport: ${(await session.evaluate(WIDE)).join('; ')}`);
});

test('reflow: at a 320px viewport (400% zoom of 1280) the page scrolls only the map', { skip }, async () => {
  await openApp({ w: 320, h: 256 });
  const a = await session.evaluate(OVERFLOW);
  assert.ok(a.doc <= a.view + 1, `320px: the page is ${a.doc}px wide in a ${a.view}px viewport: ${(await session.evaluate(WIDE)).join('; ')}`);
  await openPanel('#qcm-layer-panel > summary');
  const b = await session.evaluate(OVERFLOW);
  assert.ok(b.doc <= b.view + 1, `320px, Layers open: the page is ${b.doc}px wide in a ${b.view}px viewport`);
  const wide = await stableWide();
  assert.deepEqual(wide, [], `320px (viewport ${b.view}px): content outside the map runs past the right edge`);
});

// ---- 4. the labels the app paints on the map ---------------------------------------------------

// Probe elements carry each label class, so the stylesheet rule is measured even when the label
// is not on screen (3D needs WebGL); live labels are read too.
const LABEL_CLASSES = ['qc-place-label', 'qc-place-label--nav', 'qcm-sheet-label', 'qcm-name-label', 'qcm-road-label', 'qc-terrain-name-label', 'qc-terrain-road-label'];
const LABELS = `(() => {
  const parse = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c).slice(1)[0].split(/[ ,\\/]+/).map(Number); return { rgb: m.slice(0, 3), a: m.length > 3 ? m[3] : 1 }; };
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none';
  document.body.appendChild(host);
  const rows = [];
  const read = (el, where) => { const cs = getComputedStyle(el); const t = parse(cs.color), b = parse(cs.backgroundColor);
    rows.push({ where, cls: String(el.className).trim(), text: t.rgb, plate: b.rgb, alpha: b.a, px: parseFloat(cs.fontSize), weight: Number(cs.fontWeight) || 400 }); };
  for (const c of ${JSON.stringify(LABEL_CLASSES)}) {
    const el = document.createElement('span'); el.className = c.replace('--nav', '') + (c.includes('--nav') ? ' ' + c : ''); el.textContent = 'Label'; host.appendChild(el); read(el, 'rule');
  }
  host.remove();
  for (const el of document.querySelectorAll(${JSON.stringify(MAP_TEXT)})) read(el, 'live');
  return rows;
})()`;
const large = (r) => r.px >= 24 || (r.px >= 18.66 && r.weight >= 700); // WCAG "large text"

test('owned map label contrast: text on its own plate >= 4.5:1 (3:1 large) and the plate alpha >= 0.75', { skip }, async () => {
  await openApp(DESKTOP, { area: true });
  await tick('qcm-layer-names');
  await tick('qcm-layer-roads');
  await session.evaluate(`window.qcMap.setView([35.05, -83.475], 13, { animate: false }); document.getElementById('qcm-check').click(); true`);
  await waitInPage(session, 'a name label', `document.querySelectorAll('.qcm-name-label').length > 0`, 30000, null);
  const rows = await session.evaluate(LABELS);
  assert.ok(rows.filter((r) => r.where === 'live').length > 0, 'no label was on the map to measure');
  const bad = [];
  for (const r of rows) {
    const need = large(r) ? 3 : 4.5;
    const own = contrastRatio(r.text, r.plate);
    // The plate is translucent: its worst case is the plate over pure white and over pure black.
    const worst = Math.min(...[[255, 255, 255], [0, 0, 0]].map((g) => contrastRatio(r.text, composite(r.plate, r.alpha, g))));
    if (own < need) bad.push(`${r.cls} (${r.where}): text on its plate is ${own.toFixed(2)}:1, needs ${need}`);
    if (worst < need) bad.push(`${r.cls} (${r.where}): over white or black the plate gives ${worst.toFixed(2)}:1, needs ${need}`);
    if (r.alpha < 0.75) bad.push(`${r.cls} (${r.where}): plate alpha ${r.alpha} is under 0.75`);
  }
  assert.deepEqual(bad, [], 'label contrast');
});

// ---- 5. what axe will not score, asserted by hand ----------------------------------------------
// (The text it cannot score is measured against its own plate inside every axe state: see PLATE_CHECK.)

test('documentation heading is not covered: .section-heading is the topmost thing at its centre once scrolled into view', { skip }, async () => {
  await openApp(DESKTOP);
  const top = await session.evaluate(`(() => {
    const h = document.querySelector('.section-heading'); if (!h) return 'no .section-heading on the page';
    h.scrollIntoView({ block: 'center' });
    const r = h.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit && (hit === h || h.contains(hit)) ? 'ok' : 'covered by ' + (hit ? hit.tagName + '.' + String(hit.className.baseVal ?? hit.className) : 'nothing');
  })()`);
  assert.equal(top, 'ok');
});

test('nothing outside the local site and the stubs was asked for', { skip }, () => {
  assert.deepEqual([...new Set(refused.map((u) => new URL(u).origin))], [], 'the page asked for a host the test does not stub');
});
