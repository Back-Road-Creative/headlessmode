// The desktop dock: the four map panels in one column down the left of the map,
// never over it.
//
// Before this, at 1024px and up the four <details> panels were absolute overlays
// on the map: Print top-left, Layers top-right, and Explore and Conditions as two
// full-width bars across the map under them. The owner's words: "the Explore and
// Conditions bars stretch across and cover the map, Print sits on the left and
// Layers on the right". Now #qc-map-container is a two-column grid: #qc-sheet is
// column 1, holding the four panels as stacked summary rows with the open one
// filling the rest of the column, and #qc-map is column 2.
//
// Measured in a real browser, by hit-testing as well as by boxes: a panel can sit
// in its own column on paper and still be painted over the map.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt() ? 'public/quiet-corners/ not built — run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const MIN_MAP_WIDTH = 480;
const DESKTOP = [{ w: 1024, h: 768 }, { w: 1280, h: 800 }, { w: 1440, h: 900 }, { w: 1920, h: 1080 }];
const PHONE = [{ w: 320, h: 640 }, { w: 390, h: 844 }, { w: 768, h: 1024 }];
// Top to bottom in the dock: the main task first, the paper last.
const PANELS = ['qc-explore-panel', 'qc-conditions-panel', 'qcm-layer-panel', 'qcm-app'];

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

async function freshPage({ w, h }) {
  const { site, page } = await sharedBrowser();
  await page.setViewport({ width: w, height: h });
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page);
  return page;
}

/** Opens one panel (or none, for null) the way the page's own toggle listener
 *  expects, then waits out the toggle event, two frames of layout and the
 *  ResizeObserver that tells the map its column changed. */
const showOnly = (id) => `(async () => {
  for (const pid of ${JSON.stringify(PANELS)}) {
    const d = document.getElementById(pid);
    if (d) d.open = pid === ${JSON.stringify(id)};
  }
  await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise((r) => setTimeout(r, 100));
  return true;
})()`;

/** Everything one desktop state is checked against, read in one pass. Measured with
 *  the map box at the top of the viewport, where its `position: sticky` holds it once
 *  the reader scrolls past the page header: unscrolled, the bottom of the 640px box is
 *  under the fold at 768-800px tall, with or without the dock. */
const snapshot = `(() => {
  const stage = document.getElementById('qc-map-container');
  window.scrollTo(0, stage.getBoundingClientRect().top + window.scrollY);
  const box = (el) => { const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const name = (el) => !el ? '(nothing)' : el.tagName.toLowerCase() + (el.id ? '#' + el.id
    : (String(el.className || '').trim() ? '.' + String(el.className).trim().split(/\\s+/)[0] : ''));
  const sheet = document.getElementById('qc-sheet'), mapEl = document.getElementById('qc-map');
  const s = box(sheet), m = box(mapEl);
  const misses = [];
  for (const fx of [1 / 6, 1 / 2, 5 / 6]) for (const fy of [1 / 6, 1 / 2, 5 / 6]) {
    const x = m.left + m.width * fx, y = m.top + m.height * fy;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !mapEl.contains(hit)) misses.push(Math.round(x) + ',' + Math.round(y) + ' -> ' + name(hit));
  }
  const reachable = (el) => { if (!el) return 'missing';
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return 'no box';
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit && (hit === el || el.contains(hit)) ? null : 'painted under ' + name(hit); };
  const blocked = {};
  for (const sel of ['.leaflet-control-zoom-in', '.leaflet-control-zoom-out',
    ...${JSON.stringify(PANELS)}.map((id) => '#' + id + ' > summary')]) {
    const why = reachable(document.querySelector(sel));
    if (why) blocked[sel] = why;
  }
  const summaries = ${JSON.stringify(PANELS)}.map((id) => {
    const r = document.querySelector('#' + id + ' > summary').getBoundingClientRect();
    return { id, left: Math.round(r.left), top: Math.round(r.top) };
  });
  return {
    sheet: s, map: m, misses, blocked, summaries,
    overlapX: Math.min(s.right, m.right) - Math.max(s.left, m.left),
    overlapY: Math.min(s.bottom, m.bottom) - Math.max(s.top, m.top),
  };
})()`;

for (const vp of DESKTOP) {
  test(`at ${vp.w}x${vp.h} the panels dock left of the map and never cover it, whichever is open`, { skip }, async () => {
    const page = await freshPage(vp);
    for (const id of [null, ...PANELS]) {
      await page.evaluate(showOnly(id));
      const seen = await page.evaluate(snapshot);
      const state = id ? `with #${id} open` : 'with nothing open';
      assert.ok(seen.overlapX <= 0.5 || seen.overlapY <= 0.5,
        `${state}: #qc-sheet and #qc-map share ${Math.round(seen.overlapX)}x${Math.round(seen.overlapY)}px`);
      assert.ok(seen.map.width >= MIN_MAP_WIDTH,
        `${state}: the map is ${Math.round(seen.map.width)}px wide, under the ${MIN_MAP_WIDTH}px floor`);
      assert.deepEqual(seen.misses, [], `${state}: points inside the map rect land on something else`);
      assert.deepEqual(seen.blocked, {}, `${state}: a control cannot be hit`);
      const lefts = seen.summaries.map((x) => x.left);
      assert.ok(Math.max(...lefts) - Math.min(...lefts) <= 1,
        `${state}: the four summaries are not in one column: ${JSON.stringify(seen.summaries)}`);
      assert.ok(seen.sheet.left <= 1, `${state}: the dock starts ${Math.round(seen.sheet.left)}px from the left edge`);
      assert.ok(seen.sheet.right <= seen.map.left + 0.5, `${state}: the dock is not left of the map`);
      const tops = seen.summaries.map((x) => x.top);
      assert.deepEqual([...tops].sort((a, b) => a - b), tops,
        `${state}: the dock does not read Explore, Conditions, Layers, Print top to bottom: ${JSON.stringify(seen.summaries)}`);
    }
  });
}

test('at 1280x800 the open panel is the one scroller between its content and the page', { skip }, async () => {
  const page = await freshPage(DESKTOP[1]);
  for (const id of PANELS) {
    await page.evaluate(showOnly(id));
    const found = await page.evaluate(`(() => {
      const out = [];
      let el = document.querySelector('#${id} > :last-child');
      while (el && el !== document.body) {
        const oy = getComputedStyle(el).overflowY;
        if (oy === 'auto' || oy === 'scroll') out.push(el.id || el.className);
        el = el.parentElement;
      }
      return out;
    })()`);
    assert.deepEqual(found, [id], `with #${id} open the scrolling ancestors are ${JSON.stringify(found)}`);
  }
});

// QQA-02: one dock width per desktop breakpoint. This used to be the opposite test --
// "opening Explore widens the dock" asserted a 332px dock growing to 576px so the
// comparison tables fit, which moved the map's left edge by 244px under a reader who
// had only opened a panel (audit F01/F02). The contract is now invariance: opening or
// closing any panel, opening every nested disclosure and pushing a long unbroken
// string through a panel (a loading note, a feature name) must leave the dock and the
// map's left edge and width where they were, within 1 CSS px once settled, and the map
// keeps its centre and zoom. The comparison data fits the narrow dock as cards instead
// (mobile-cards.test.mjs holds that half).
const WIDTH_TOLERANCE = 1;
const CENTRE_TOLERANCE = 2;
/** quiet-corners-maps.css: --qc-dock-w is clamp(18rem, 26vw, 24rem) at 16px a rem. */
const expectedDock = (w) => Math.min(384, Math.max(288, w * 0.26));
/** Widths named by the plan (1024/1280/1440/1920) plus a short viewport. */
const STABLE = [{ w: 1024, h: 768 }, { w: 1280, h: 800 }, { w: 1440, h: 900 }, { w: 1920, h: 1080 }, { w: 1280, h: 640 }];

/** The numbers the contract is about, read after the same scroll `snapshot` uses. */
const geometry = `(() => {
  const stage = document.getElementById('qc-map-container');
  window.scrollTo(0, stage.getBoundingClientRect().top + window.scrollY);
  const s = document.getElementById('qc-sheet').getBoundingClientRect();
  const el = document.getElementById('qc-map'), m = el.getBoundingClientRect();
  if (!window.__dockCentre) { window.__dockCentre = window.qcMap.getCenter(); window.__dockZoom = window.qcMap.getZoom(); }
  const p = window.qcMap.latLngToContainerPoint(window.__dockCentre);
  const open = document.querySelector('#qc-sheet > .qcm-panel[open]');
  return { dockLeft: s.left, dock: s.width, mapLeft: m.left, mapWidth: m.width,
    sideways: open ? open.scrollWidth - open.clientWidth : 0,
    dx: p.x - el.clientWidth / 2, dy: p.y - el.clientHeight / 2,
    zoom: window.qcMap.getZoom(), zoomWas: window.__dockZoom };
})()`;

/** Opens every <details> inside one panel and appends a long unbroken string to its
 *  content, reads the geometry and the panel's own sideways overflow, then puts both back. */
const stress = (id) => `(async () => {
  const panel = document.getElementById(${JSON.stringify(id)});
  const nested = [...panel.querySelectorAll('details')];
  const was = nested.map((d) => d.open);
  nested.forEach((d) => { d.open = true; });
  const probe = document.createElement('span');
  probe.id = 'dock-probe-long';
  probe.textContent = 'LoadingNoteWithNoSpacesAtAll'.repeat(20);
  (panel.querySelector('.qc-controls') || panel.lastElementChild).append(probe);
  await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise((r) => setTimeout(r, 100));
  const g = ${geometry};
  g.nested = nested.length;
  probe.remove();
  nested.forEach((d, i) => { d.open = was[i]; });
  return g;
})()`;

const withinOne = (a, b) => Math.abs(a - b) <= WIDTH_TOLERANCE;

for (const vp of STABLE) {
  test(`at ${vp.w}x${vp.h} no panel, disclosure or long note changes the dock or the map's left edge and width`, { skip }, async () => {
    const page = await freshPage(vp);
    await page.evaluate(showOnly(null));
    const base = await page.evaluate(geometry);
    assert.ok(withinOne(base.dock, expectedDock(vp.w)),
      `with nothing open the dock is ${base.dock.toFixed(2)}px; the one width for ${vp.w}px is ${expectedDock(vp.w).toFixed(2)}px`);
    const check = (g, state, { sideways = true } = {}) => {
      assert.ok(withinOne(g.dock, base.dock), `${state}: the dock is ${g.dock.toFixed(2)}px, was ${base.dock.toFixed(2)}px`);
      assert.ok(withinOne(g.dockLeft, base.dockLeft), `${state}: the dock's left edge moved ${base.dockLeft.toFixed(2)} -> ${g.dockLeft.toFixed(2)}`);
      assert.ok(withinOne(g.mapLeft, base.mapLeft), `${state}: the map's left edge moved ${base.mapLeft.toFixed(2)} -> ${g.mapLeft.toFixed(2)}`);
      assert.ok(withinOne(g.mapWidth, base.mapWidth), `${state}: the map is ${g.mapWidth.toFixed(2)}px wide, was ${base.mapWidth.toFixed(2)}px`);
      assert.ok(Math.hypot(g.dx, g.dy) <= CENTRE_TOLERANCE,
        `${state}: the map's old centre is ${Math.round(g.dx)},${Math.round(g.dy)}px off the middle of the map`);
      assert.equal(g.zoom, g.zoomWas, `${state}: the zoom changed`);
      if (sideways) assert.ok(g.sideways <= 1, `${state}: the open panel scrolls sideways by ${g.sideways}px inside the dock`);
    };
    for (const id of PANELS) {
      await page.evaluate(showOnly(id));
      check(await page.evaluate(geometry), `#${id} open`);
      // The probe is 560 unbroken characters: width invariance is what it proves. Whether such
      // a string wraps is the content's business, so the sideways bar is not asked of it.
      check(await page.evaluate(stress(id)), `#${id} open with every disclosure open and a long note`, { sideways: false });
    }
    await page.evaluate(showOnly(null));
    check(await page.evaluate(geometry), 'every panel closed again');
  });
}

test('the dock is one width across the 1023 <-> 1024px breakpoint and back, with Explore open', { skip }, async () => {
  const page = await freshPage({ w: 1024, h: 768 });
  const settle = () => page.evaluate(`(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 250)); return true; })()`);
  await page.evaluate(showOnly('qc-explore-panel'));
  const first = await page.evaluate(geometry);
  assert.ok(withinOne(first.dock, expectedDock(1024)), `the dock is ${first.dock.toFixed(2)}px at 1024px`);
  await page.setViewport({ width: 1023, height: 768 });
  await settle();
  const narrow = await page.evaluate(`(() => {
    const s = document.getElementById('qc-sheet').getBoundingClientRect();
    const m = document.getElementById('qc-map').getBoundingClientRect();
    return { sheetLeft: s.left, sheetTop: s.top, sheetWidth: s.width, mapBottom: m.bottom, mapLeft: m.left, vw: document.documentElement.clientWidth };
  })()`);
  assert.ok(Math.abs(narrow.sheetWidth - narrow.vw) <= 2 && narrow.sheetLeft <= 2 && narrow.sheetTop >= narrow.mapBottom - 1,
    `at 1023px the panels must be the bottom sheet under the map, got ${JSON.stringify(narrow)}`);
  await page.setViewport({ width: 1024, height: 768 });
  await settle();
  const back = await page.evaluate(geometry);
  assert.ok(withinOne(back.dock, first.dock), `back at 1024px the dock is ${back.dock.toFixed(2)}px, was ${first.dock.toFixed(2)}px`);
  assert.ok(withinOne(back.mapLeft, first.mapLeft), `back at 1024px the map's left edge is ${back.mapLeft.toFixed(2)}, was ${first.mapLeft.toFixed(2)}`);
  assert.ok(withinOne(back.mapWidth, first.mapWidth), `back at 1024px the map is ${back.mapWidth.toFixed(2)}px wide, was ${first.mapWidth.toFixed(2)}px`);
  // A different panel at the same breakpoint lands on the same width.
  await page.evaluate(showOnly('qcm-layer-panel'));
  const layers = await page.evaluate(geometry);
  assert.ok(withinOne(layers.dock, first.dock), `with Layers open at 1024px the dock is ${layers.dock.toFixed(2)}px, was ${first.dock.toFixed(2)}px with Explore`);
});

// The card lives in Leaflet's popup pane, inside #qc-map: with the map in its own
// column it cannot reach the dock. Horizontally it stays inside the map column, and
// its middle is painted as the card, not under a panel. (Vertically it can still run
// past the top of the map, clipped there, when flyToCounty opens it before the fly
// lands; that is the same with or without the dock and not this layout's to fix.)
test('at 1280x800 a county card opens inside the map, not over the dock', { skip }, async () => {
  const page = await freshPage(DESKTOP[1]);
  await page.evaluate(showOnly('qc-explore-panel'));
  await waitInPage(page, 'the county table has rows', "!!document.querySelector('#qc-table-body .qc-row[data-fips]')");
  await page.evaluate(`(async () => {
    const settled = qcMoves();
    document.querySelector('#qc-table-body .qc-row[data-fips]').click();
    await settled('the map stopped moving after the county pick');
    return true;
  })()`);
  await waitInPage(page, 'the county card to open', "!!document.querySelector('#qc-map .leaflet-popup')");
  const seen = await page.evaluate(`(() => {
    const card = document.querySelector('#qc-map .leaflet-popup-content-wrapper');
    const p = card.getBoundingClientRect();
    const m = document.getElementById('qc-map').getBoundingClientRect();
    const y = (Math.max(p.top, m.top) + Math.min(p.bottom, m.bottom)) / 2;
    const hit = document.elementFromPoint((p.left + p.right) / 2, y);
    return { p: [p.left, p.top, p.right, p.bottom].map(Math.round), m: [m.left, m.top, m.right, m.bottom].map(Math.round),
      hit: !!hit && card.contains(hit), by: hit ? (hit.id || String(hit.className)) : null };
  })()`);
  assert.ok(seen.p[0] >= seen.m[0] - 1 && seen.p[2] <= seen.m[2] + 1,
    `the card ${JSON.stringify(seen.p)} runs outside the map column ${JSON.stringify(seen.m)}`);
  assert.ok(seen.hit, `the middle of the card is painted under ${seen.by}`);
});

async function key(page, k, code, text) {
  const base = { key: k, code: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

test('at 1280x800 Tab reaches the dock before the map, Enter opens a panel and Escape returns focus', { skip }, async () => {
  const page = await freshPage(DESKTOP[1]);
  await page.evaluate('document.activeElement && document.activeElement.blur(), true');
  let where = null;
  for (let i = 0; i < 80 && !where; i++) {
    await key(page, 'Tab', 9);
    where = await page.evaluate(`(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return null;
      if (a.closest('#qc-map')) return 'map:' + (a.id || a.className);
      if (a.closest('#qc-sheet')) return 'sheet:' + (a.parentElement.id || a.className);
      return null;
    })()`);
  }
  assert.equal(where, 'sheet:qc-explore-panel', `Tab reached ${where} first, not the Explore summary at the top of the dock`);
  await key(page, 'Enter', 13, '\r');
  await page.evaluate('new Promise((r) => setTimeout(r, 150))');
  assert.equal(await page.evaluate("document.getElementById('qc-explore-panel').open"), true, 'Enter on the summary did not open Explore');
  await key(page, 'Escape', 27);
  await page.evaluate('new Promise((r) => setTimeout(r, 150))');
  const after = await page.evaluate(`({ open: document.getElementById('qc-explore-panel').open,
    focus: document.activeElement === document.querySelector('#qc-explore-panel > summary') })`);
  assert.deepEqual(after, { open: false, focus: true }, 'Escape must close Explore and put focus back on its summary');
});

// Below 1024px the dock is not used: the four panels stay the bottom sheet under the
// map. #qc-sheet now comes before #qc-map in the markup (so desktop Tab order matches
// what is seen), and a flex `order` keeps it at the bottom here. Nothing on the
// dashboard may hang past the right edge, the sheet may not hold more than its width,
// and the zoom control stays reachable whichever panel is open. Measured on #dashboard
// rather than the whole document: the methodology text under the dashboard is not
// this layout's to fix. At 320px the Share/Reset/Locate row already covers the zoom
// control with the sheet shut (panel-shell-browser.test.mjs records the same), so
// there the check is that opening a panel makes it no worse.
/** Page-side: every dashboard element whose box ends past `vw`, as 'id right=N'. Only
 *  what the reader can see is measured: a <details> that is shut (every layer group
 *  starts shut, layer-panel.js groupIsCollapsedByDefault) keeps its content out of
 *  layout, and Chromium then answers getBoundingClientRect for that content with a
 *  box from whichever layout last included it, not the one on screen. Under load that
 *  box was 'p right=338' at 320px and 'p right=786' at 768px for the Federal overlays
 *  hint (2026-10-06, two suite runs), with nothing on the page wider than the viewport.
 *  checkVisibility() is false for skipped content and for display:none, true for
 *  anything laid out, so an overflow in an OPEN group is still reported. */
const HANGS_PAST = `(vw) => {
  const over = [];
  for (const el of document.querySelectorAll('#dashboard, #dashboard *')) {
    if (el.closest('.leaflet-container') && el.id !== 'qc-map') continue;
    if (!el.checkVisibility()) continue;
    const r = el.getBoundingClientRect();
    if (r.width && Math.round(r.right) > vw + 1) over.push((el.id || el.tagName.toLowerCase()) + ' right=' + Math.round(r.right));
  }
  return over;
}`;

test('the sideways check ignores content the reader cannot see inside a shut group, and still reports it once the group is open', { skip }, async () => {
  const page = await freshPage(PHONE[0]);
  await page.evaluate(showOnly('qcm-layer-panel'));
  const seen = await page.evaluate(`(() => {
    const vw = document.documentElement.clientWidth;
    const group = document.querySelector('#qcm-layer-panel .qcm-layer-group');
    const wide = document.createElement('p');
    wide.id = 'dock-probe-wide'; wide.textContent = 'probe'; wide.style.width = (vw + 200) + 'px';
    group.append(wide);
    const groupShut = !group.open;
    const shut = (${HANGS_PAST})(vw);
    group.open = true;
    const open = (${HANGS_PAST})(vw);
    wide.remove(); group.open = false;
    return { groupShut, shut, open };
  })()`);
  assert.equal(seen.groupShut, true, 'the first layer group must start shut for this check to mean anything');
  assert.deepEqual(seen.shut, [], 'a wide element inside a shut group is not on screen and must not count');
  assert.ok(seen.open.some((x) => x.startsWith('dock-probe-wide right=')), `the same element in the open group must be reported, got ${JSON.stringify(seen.open)}`);
});

for (const vp of PHONE) {
  test(`at ${vp.w}x${vp.h} nothing scrolls sideways and the zoom control stays reachable with each panel open`, { skip }, async () => {
    const page = await freshPage(vp);
    let zoomShut = null;
    for (const id of [null, ...PANELS]) {
      await page.evaluate(showOnly(id));
      const seen = await page.evaluate(`(() => {
        const vw = document.documentElement.clientWidth, s = document.getElementById('qc-sheet');
        const over = (${HANGS_PAST})(vw);
        const z = document.querySelector('.leaflet-control-zoom-out');
        z.scrollIntoView({ block: 'center' });
        const r = z.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { over, sheet: [s.scrollWidth, s.clientWidth],
          zoom: !!hit && !!hit.closest('.leaflet-control-zoom'), by: hit ? (hit.id || hit.className) : null };
      })()`);
      const state = id ? `with #${id} open` : 'with nothing open';
      assert.deepEqual(seen.over, [], `${state}: part of the dashboard hangs past the ${vp.w}px viewport`);
      assert.ok(seen.sheet[0] <= seen.sheet[1], `${state}: #qc-sheet holds ${seen.sheet[0]}px in ${seen.sheet[1]}px`);
      if (id === null) zoomShut = seen.zoom;
      if (vp.w >= 390 || zoomShut) assert.ok(seen.zoom, `${state}: the zoom control is painted under ${seen.by}`);
    }
  });
}
