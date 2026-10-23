// QUX-03a shell: one map panel open at a time, and closing it (however it
// closes) hands focus back to whatever opened it. panel-state.test.mjs proves
// the pure state machine; this proves quiet-corners.js actually wires it to
// the real <details>/<summary> elements and to a real click/keypress.
//
// Real input, dispatched over the DevTools protocol (the same technique
// helpers/browser.mjs already uses for viewport control) rather than
// `.click()`/synthetic KeyboardEvents in the page: those run with
// `isTrusted: false`, and while quiet-corners.js's exclusivity handler does
// not actually key off `isTrusted` (a `toggle` fired by page script setting
// `.open = true` reports `isTrusted: true` too -- there is no reliable
// "was this a real user action" signal on this event), a trusted click is
// still the more faithful proof that a summary press works for a reader,
// not just for a test harness poking `.open` directly.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { trustedClick } from './helpers/trusted-click.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage, chooseExampleArea } from './helpers/waits.mjs';
import { DB_NAME, STORE, KEY, VERSION } from '../../themes/headlessmode/static/js/quiet-corners-maps/project-store.js';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt() ? 'public/quiet-corners/ not built — run `hugo --configDir site-config --minify` first'
    : false;

const PHONE = { w: 390, h: 844 };

let shared = null;
async function sharedBrowser() {
  if (!shared) {
    const site = await startSiteServer();
    const page = await launch(CHROMIUM, `${site.origin}/quiet-corners/`, {
      args: ['--hide-scrollbars'],
    });
    shared = { site, page };
  }
  return shared;
}
after(async () => {
  if (!shared) return;
  shared.page.close();
  await shared.site.close();
});

// setViewport takes {width, height}; PHONE is kept as {w, h} to match every other
// qcm test file's viewport-literal convention (layout.test.mjs, phone-controls.test.mjs).
//
// QUX-03b-i: navigate() resolving is not the dashboard being ready -- quiet-corners.js
// paints the map and wires the panel/exclusivity listeners, then fetches
// candidates.json un-awaited (see helpers/waits.mjs's header). Every test below fires a
// trusted click within moments of freshPage() returning, so a page returned before that
// wiring lands (or before Explore's own content -- filters, table, candidates -- has its
// data) is a coin flip on whether the click's target is even listening yet, exactly like
// sort-reach.test.mjs:110-118 waits before its own first interaction. readyDashboard()
// is the shared wait for that: it holds for window.qcMap._loaded and, by default, for
// window.qcData() (candidates.json), which is what the Explore-panel tests below read.
async function freshPage() {
  const { site, page } = await sharedBrowser();
  await page.setViewport({ width: PHONE.w, height: PHONE.h });
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page);
  return page;
}

const panelStates = `(() => ({
  layers: document.getElementById('qcm-layer-panel').open,
  print: document.getElementById('qcm-app').open,
  explore: document.getElementById('qc-explore-panel') ? document.getElementById('qc-explore-panel').open : null,
  conditions: document.getElementById('qc-conditions-panel') ? document.getElementById('qc-conditions-panel').open : null,
}))()`;

// County rows come from a separate dataset (the county table body) than the one
// readyDashboard()'s qcData() wait covers (candidates.json / #qc-candidates-section) --
// sort-reach.test.mjs establishes the same explicit extra wait before the first
// county-row interaction, for the same reason.
const hasCountyRows = "!!document.querySelector('#qc-table-body .qc-row[data-fips]')";

test('opening the print panel closes the layers panel — one at a time', { skip }, async () => {
  const page = await freshPage();
  await trustedClick(page, '#qcm-layer-panel summary');
  const afterLayers = await page.evaluate(panelStates);
  assert.equal(afterLayers.layers, true, 'clicking the Layers summary did not open it');

  await trustedClick(page, '#qcm-app summary');
  const afterPrint = await page.evaluate(panelStates);
  assert.equal(afterPrint.print, true, 'clicking the Print summary did not open it');
  assert.equal(afterPrint.layers, false,
    'the Layers panel is still open after Print was opened — both panels are open at once');
});

test('Escape closes the open panel and returns focus to the summary that opened it', { skip }, async () => {
  const page = await freshPage();
  await trustedClick(page, '#qcm-layer-panel summary');
  const opened = await page.evaluate(panelStates);
  assert.equal(opened.layers, true, 'clicking the Layers summary did not open it');

  // Focus moves elsewhere first (e.g. the reader tabbed on), so restoring it
  // to the opener on close is an observable effect, not a no-op.
  await page.evaluate("document.getElementById('qc-locate').focus()");

  await page.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
  });
  await page.evaluate('new Promise(r => setTimeout(r, 150))');

  const after = await page.evaluate(`(() => ({
    layers: document.getElementById('qcm-layer-panel').open,
    activeIsSummary: document.activeElement === document.querySelector('#qcm-layer-panel summary'),
  }))()`);
  assert.equal(after.layers, false, 'Escape did not close the open Layers panel');
  assert.equal(after.activeIsSummary, true,
    'focus was not returned to the Layers summary after Escape closed it');
});

// QUX-03a follow-up: the Close and Back controls the unit's acceptance criteria
// asked for ("Back/Close/Escape restore focus to the opener") but the shell never
// grew -- Escape was the only way out of a panel, and there was no way at all to
// step back to a panel an excursion passed through rather than closing outright.

const backHidden = (sel) => `(() => {
  const btn = document.querySelector('${sel} .qcm-panel-back');
  return btn ? btn.hidden : null;
})()`;

test('opening Print after Layers closes Layers and reveals Back', { skip }, async () => {
  const page = await freshPage();
  await trustedClick(page, '#qcm-layer-panel summary');
  assert.equal((await page.evaluate(panelStates)).layers, true, 'Layers did not open');

  await trustedClick(page, '#qcm-app summary');
  const after = await page.evaluate(panelStates);
  assert.equal(after.print, true, 'clicking the Print summary did not open it');
  assert.equal(after.layers, false, 'Layers is still open after Print was opened');
  assert.equal(await page.evaluate(backHidden('#qcm-app')), false,
    'Back is still hidden on the Print panel after switching away from Layers');
});

test('Back reopens Layers, closes Print, hides Back again, and focuses the Layers summary', { skip }, async () => {
  const page = await freshPage();
  await trustedClick(page, '#qcm-layer-panel summary');
  await trustedClick(page, '#qcm-app summary');
  assert.equal((await page.evaluate(panelStates)).print, true, 'Print did not open');

  await trustedClick(page, '#qcm-app .qcm-panel-back');
  const after = await page.evaluate(panelStates);
  assert.equal(after.layers, true, 'Back did not reopen the Layers panel');
  assert.equal(after.print, false, 'Back did not close the Print panel');
  assert.equal(await page.evaluate(backHidden('#qcm-layer-panel')), true,
    'Back is still visible on the Layers panel after a Back that emptied the history');

  const focused = await page.evaluate(`(() => {
    const summary = document.querySelector('#qcm-layer-panel summary');
    return document.activeElement === summary;
  })()`);
  assert.equal(focused, true, 'focus did not move into the reopened Layers panel\'s summary');
});

test('Close closes the panel and returns focus to the summary that opened it', { skip }, async () => {
  const page = await freshPage();
  await trustedClick(page, '#qcm-layer-panel summary');
  assert.equal((await page.evaluate(panelStates)).layers, true, 'Layers did not open');

  await trustedClick(page, '#qcm-layer-panel .qcm-panel-close');
  const after = await page.evaluate(`(() => ({
    layers: document.getElementById('qcm-layer-panel').open,
    activeIsSummary: document.activeElement === document.querySelector('#qcm-layer-panel summary'),
  }))()`);
  assert.equal(after.layers, false, 'Close did not close the open Layers panel');
  assert.equal(after.activeIsSummary, true,
    'focus was not returned to the Layers summary after Close closed it');
});

// QUX-03b-i: a third panel, Explore, holds the filters/tables/candidates that used
// to sit outside the map's overlay shell entirely. It has to join the same
// exclusivity/Back/Close/focus-restore machinery the two panels above already
// proved, not a parallel mechanism of its own.

test('opening the Explore panel closes Layers and Print', { skip }, async () => {
  const page = await freshPage();
  await trustedClick(page, '#qcm-layer-panel summary');
  assert.equal((await page.evaluate(panelStates)).layers, true, 'Layers did not open');

  await trustedClick(page, '#qc-explore-panel summary');
  const after = await page.evaluate(panelStates);
  assert.equal(after.explore, true, 'clicking the Explore summary did not open it');
  assert.equal(after.layers, false, 'Layers is still open after Explore was opened');
  assert.equal(after.print, false, 'Print is open even though nothing opened it');
});

test('opening Print after Explore closes Explore and reveals Back', { skip }, async () => {
  const page = await freshPage();
  await trustedClick(page, '#qc-explore-panel summary');
  assert.equal((await page.evaluate(panelStates)).explore, true, 'Explore did not open');

  await trustedClick(page, '#qcm-app summary');
  const after = await page.evaluate(panelStates);
  assert.equal(after.print, true, 'clicking the Print summary did not open it');
  assert.equal(after.explore, false, 'Explore is still open after Print was opened');
  assert.equal(await page.evaluate(backHidden('#qcm-app')), false,
    'Back is still hidden on the Print panel after switching away from Explore');
});

test('Back reopens Layers, closes Explore, hides Back again, and focuses the Layers summary', { skip }, async () => {
  const page = await freshPage();
  await trustedClick(page, '#qcm-layer-panel summary');
  await trustedClick(page, '#qc-explore-panel summary');
  assert.equal((await page.evaluate(panelStates)).explore, true, 'Explore did not open');

  await trustedClick(page, '#qc-explore-panel .qcm-panel-back');
  const after = await page.evaluate(panelStates);
  assert.equal(after.layers, true, 'Back did not reopen the Layers panel');
  assert.equal(after.explore, false, 'Back did not close the Explore panel');
  assert.equal(await page.evaluate(backHidden('#qcm-layer-panel')), true,
    'Back is still visible on the Layers panel after a Back that emptied the history');

  const focused = await page.evaluate(`(() => {
    const summary = document.querySelector('#qcm-layer-panel summary');
    return document.activeElement === summary;
  })()`);
  assert.equal(focused, true, 'focus did not move into the reopened Layers panel\'s summary');
});

test('Close closes the Explore panel and returns focus to its summary', { skip }, async () => {
  const page = await freshPage();
  await trustedClick(page, '#qc-explore-panel summary');
  assert.equal((await page.evaluate(panelStates)).explore, true, 'Explore did not open');

  await trustedClick(page, '#qc-explore-panel .qcm-panel-close');
  const after = await page.evaluate(`(() => ({
    explore: document.getElementById('qc-explore-panel').open,
    activeIsSummary: document.activeElement === document.querySelector('#qc-explore-panel summary'),
  }))()`);
  assert.equal(after.explore, false, 'Close did not close the open Explore panel');
  assert.equal(after.activeIsSummary, true,
    'focus was not returned to the Explore summary after Close closed it');
});

test('the filters, tables and candidates live inside the Explore panel', { skip }, async () => {
  const page = await freshPage();
  const contained = await page.evaluate(`(() => ({
    controls: !!document.querySelector('#qc-explore-panel #qc-controls'),
    tableHeader: !!document.querySelector('#qc-explore-panel #qc-table-header'),
    tableBody: !!document.querySelector('#qc-explore-panel #qc-table-body'),
    candidates: !!document.querySelector('#qc-explore-panel #qc-candidates-section'),
  }))()`);
  assert.equal(contained.controls, true, '#qc-controls is not inside #qc-explore-panel');
  assert.equal(contained.tableHeader, true, '#qc-table-header is not inside #qc-explore-panel');
  assert.equal(contained.tableBody, true, '#qc-table-body is not inside #qc-explore-panel');
  assert.equal(contained.candidates, true, '#qc-candidates-section is not inside #qc-explore-panel');
});

test('the Explore summary reflects the number of active filters', { skip }, async () => {
  const page = await freshPage();
  const before = await page.evaluate("document.getElementById('qc-explore-summary').textContent");
  await page.evaluate(`(() => {
    const el = document.getElementById('qc-overall');
    el.value = 40;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  // Clears applyFiltersDebounced's 100ms trailing debounce.
  await page.evaluate('new Promise(r => setTimeout(r, 250))');
  const after = await page.evaluate("document.getElementById('qc-explore-summary').textContent");
  assert.notEqual(after, before,
    'the Explore summary text did not change once a filter became active');
  assert.match(after, /filter/i,
    `the Explore summary "${after}" does not mention a filter count after one became active`);
});

// QUX-03b-ii: a fourth panel, Conditions, holds the sky/forecast/alert cards moved out of
// the old right-side drawer. Same exclusivity/Back/Close/focus-restore machinery as Layers/
// Print/Explore above, plus two behaviors unique to it: its closed summary and its own
// location/date header both read the last place a reader picked, written by showSky() in
// quiet-corners.js, and a second pick replaces rather than appends to that text.

test('opening the Conditions panel closes Layers and Print', { skip }, async () => {
  const page = await freshPage();
  await trustedClick(page, '#qcm-layer-panel summary');
  assert.equal((await page.evaluate(panelStates)).layers, true, 'Layers did not open');

  await trustedClick(page, '#qc-conditions-panel summary');
  const after = await page.evaluate(panelStates);
  assert.equal(after.conditions, true, 'clicking the Conditions summary did not open it');
  assert.equal(after.layers, false, 'Layers is still open after Conditions was opened');
  assert.equal(after.print, false, 'Print is open even though nothing opened it');
});

test('opening Print after Conditions closes Conditions and reveals Back', { skip }, async () => {
  const page = await freshPage();
  await trustedClick(page, '#qc-conditions-panel summary');
  assert.equal((await page.evaluate(panelStates)).conditions, true, 'Conditions did not open');

  await trustedClick(page, '#qcm-app summary');
  const after = await page.evaluate(panelStates);
  assert.equal(after.print, true, 'clicking the Print summary did not open it');
  assert.equal(after.conditions, false, 'Conditions is still open after Print was opened');
  assert.equal(await page.evaluate(backHidden('#qcm-app')), false,
    'Back is still hidden on the Print panel after switching away from Conditions');
});

test('Back reopens Layers, closes Conditions, hides Back again, and focuses the Layers summary', { skip }, async () => {
  const page = await freshPage();
  await trustedClick(page, '#qcm-layer-panel summary');
  await trustedClick(page, '#qc-conditions-panel summary');
  assert.equal((await page.evaluate(panelStates)).conditions, true, 'Conditions did not open');

  await trustedClick(page, '#qc-conditions-panel .qcm-panel-back');
  const after = await page.evaluate(panelStates);
  assert.equal(after.layers, true, 'Back did not reopen the Layers panel');
  assert.equal(after.conditions, false, 'Back did not close the Conditions panel');
  assert.equal(await page.evaluate(backHidden('#qcm-layer-panel')), true,
    'Back is still visible on the Layers panel after a Back that emptied the history');

  const focused = await page.evaluate(`(() => {
    const summary = document.querySelector('#qcm-layer-panel summary');
    return document.activeElement === summary;
  })()`);
  assert.equal(focused, true, 'focus did not move into the reopened Layers panel\'s summary');
});

test('Close closes the Conditions panel and returns focus to its summary', { skip }, async () => {
  const page = await freshPage();
  await trustedClick(page, '#qc-conditions-panel summary');
  assert.equal((await page.evaluate(panelStates)).conditions, true, 'Conditions did not open');

  await trustedClick(page, '#qc-conditions-panel .qcm-panel-close');
  const after = await page.evaluate(`(() => ({
    conditions: document.getElementById('qc-conditions-panel').open,
    activeIsSummary: document.activeElement === document.querySelector('#qc-conditions-panel summary'),
  }))()`);
  assert.equal(after.conditions, false, 'Close did not close the open Conditions panel');
  assert.equal(after.activeIsSummary, true,
    'focus was not returned to the Conditions summary after Close closed it');
});

test("picking a county puts that county's name in the Conditions panel's closed summary and header", { skip }, async () => {
  const page = await freshPage();
  await trustedClick(page, '#qc-explore-panel summary');
  await waitInPage(page, 'the county table has rows', hasCountyRows);

  const name = await page.evaluate(`(() => {
    const row = document.querySelector('#qc-table-body .qc-row[data-fips]');
    row.click();
    return row.querySelector('.qc-name').textContent;
  })()`);

  const summary = await page.evaluate("document.getElementById('qc-conditions-summary').textContent");
  assert.ok(summary.includes(name),
    `the Conditions summary "${summary}" does not name the picked county "${name}"`);

  await trustedClick(page, '#qc-conditions-panel summary');
  const heading = await page.evaluate("document.getElementById('qc-conditions-heading').textContent");
  assert.ok(heading.includes(name),
    `the Conditions heading "${heading}" does not name the picked county "${name}"`);
});

test('a second pick replaces the Conditions header — never two names on screen', { skip }, async () => {
  const page = await freshPage();
  await trustedClick(page, '#qc-explore-panel summary');
  await waitInPage(page, 'the county table has rows', hasCountyRows);

  const names = await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#qc-table-body .qc-row[data-fips]')];
    if (rows.length < 2) return null;
    rows[0].click();
    const first = rows[0].querySelector('.qc-name').textContent;
    rows[1].click();
    const second = rows[1].querySelector('.qc-name').textContent;
    return { first, second };
  })()`);
  assert.ok(names, 'the county table does not have at least two rows to pick from');

  await trustedClick(page, '#qc-conditions-panel summary');
  const heading = await page.evaluate("document.getElementById('qc-conditions-heading').textContent");
  assert.ok(heading.includes(names.second),
    `the Conditions heading "${heading}" does not name the second pick "${names.second}"`);
  assert.ok(names.first === names.second || !heading.includes(names.first),
    `the Conditions heading "${heading}" still names the first pick "${names.first}" after a second, different pick`);
});

// ============================================================================
// QUX-03c: PHONE — the bottom sheet (#qc-sheet) below 1024px. Every case here
// runs at both 390x844 and 320x568 unless noted; #8 (overflow) and #9
// (rotation) each need their own widths/sequence and sit outside the loop.
// ============================================================================

// layout.test.mjs:319 — same floor, restated here (not imported: that file has
// no exports, only assertions) so the sheet's own map-height checks hold the
// dashboard to the one number the rest of the suite already measures against.
const MIN_MAP_ON_SCREEN = 280;
// Same 44px goal phone-controls.test.mjs, print-options.test.mjs and
// find-and-scale.test.mjs each restate locally (WCAG 2.5.8).
const TOUCH_GOAL = 44;
const PHONE_VIEWPORTS = [{ w: 390, h: 844 }, { w: 320, h: 568 }];
const SUMMARY_SELECTORS = [
  '#qcm-layer-panel summary', '#qcm-app summary', '#qc-explore-panel summary', '#qc-conditions-panel summary',
];

/** Same as freshPage() above but for an arbitrary viewport, since the sheet has to be
 *  proven at more than the one 390x844 every other test in this file uses. */
async function freshPageAt(vp) {
  const { site, page } = await sharedBrowser();
  await page.setViewport({ width: vp.w, height: vp.h });
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page);
  return page;
}

/** A trusted drag on `selector`: press at its centre, move `dy` px (down positive,
 *  up negative) over several intermediate steps, then release — so a `pointerup`
 *  handler measuring total displacement sees a real gesture, not one teleporting
 *  mouseMoved. Same CDP technique as trustedClick above, extended with the move
 *  steps a drag (as opposed to a click) needs. */
async function trustedDrag(page, selector, dy) {
  const at = await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  const steps = 8;
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const y = Math.round(at.y + (dy * i) / steps);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y, button: 'left', buttons: 1 });
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y + dy, button: 'left', clickCount: 1 });
  await page.evaluate('new Promise(r => setTimeout(r, 150))');
}

const sheetSnapshot = `(() => {
  const sheet = document.getElementById('qc-sheet');
  const sizeBtn = document.querySelector('.qc-sheet-size');
  const map = document.getElementById('qc-map');
  const container = document.getElementById('qc-map-container');
  return {
    sheet: sheet ? sheet.getAttribute('data-sheet') : null,
    sizeHidden: sizeBtn ? sizeBtn.hidden : null,
    mapHeight: map ? map.clientHeight : 0,
    containerHeight: container ? container.clientHeight : 0,
    sheetHeight: sheet ? sheet.clientHeight : 0,
  };
})()`;

function rectOf(sel) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return { found: false, w: 0, h: 0 };
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { found: true, w: Math.round(r.width), h: Math.round(r.height) };
  })()`;
}

/** Same "is the real pixel at this element's centre painted by it" question
 *  print-options.test.mjs's local hitTestable asks, returned as data instead of
 *  asserted directly so both directions can share one expression. */
function hitTestable(sel) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return { found: false, ok: false, reason: 'missing from the page' };
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return { found: true, ok: false, reason: 'zero-size rect' };
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    if (!hit) return { found: true, ok: false, reason: 'nothing painted at its centre' };
    const ok = hit === el || el.contains(hit) || hit.contains(el);
    return { found: true, ok, reason: ok ? null : 'painted under ' + (hit.id ? '#' + hit.id : hit.tagName.toLowerCase()) };
  })()`;
}

function backVisibleScript(panelSel) {
  return `(() => {
    const btn = document.querySelector('${panelSel} .qcm-panel-back');
    return !!btn && !btn.hidden;
  })()`;
}

const scrollRegionsScript = `(() => {
  const sheet = document.getElementById('qc-sheet');
  const out = [];
  sheet.querySelectorAll('.qcm-panel').forEach((el) => {
    const oy = getComputedStyle(el).overflowY;
    if (oy === 'auto' || oy === 'scroll') out.push(el.id);
  });
  return out;
})()`;

for (const vp of PHONE_VIEWPORTS) {
  test(`sheet: loads collapsed, size button hidden, every summary reachable, map on screen (${vp.w}x${vp.h})`, { skip }, async () => {
    const page = await freshPageAt(vp);
    const snap = await page.evaluate(sheetSnapshot);
    assert.equal(snap.sheet, 'collapsed', `#qc-sheet[data-sheet] is "${snap.sheet}" on load, expected "collapsed"`);
    assert.equal(snap.sizeHidden, true, '.qc-sheet-size must start hidden while the sheet is collapsed');
    assert.ok(snap.mapHeight >= MIN_MAP_ON_SCREEN,
      `#qc-map is only ${snap.mapHeight}px tall on load — under the ${MIN_MAP_ON_SCREEN}px floor`);

    for (const sel of SUMMARY_SELECTORS) {
      const box = await page.evaluate(rectOf(sel));
      assert.ok(box.found, `${sel} is missing from the page`);
      assert.ok(box.h >= TOUCH_GOAL, `${sel} measures ${box.w}x${box.h}, under the ${TOUCH_GOAL}px touch target`);
      const hit = await page.evaluate(hitTestable(sel));
      assert.ok(hit.ok, `${sel} is not hit-testable on load: ${hit.reason}`);
    }
  });

  test(`sheet: opening a panel sizes it to half, keeps 40%+ of the stage for the map, and the open panel is the one scroll region (${vp.w}x${vp.h})`, { skip }, async () => {
    const page = await freshPageAt(vp);
    // Baseline zoom hit-test BEFORE the sheet does anything: at 320x568 the
    // Leaflet zoom-in anchor (top-left) and the Share/Reset view-controls row
    // (a full-width top-right Leaflet control, quiet-corners.css:1140-1150,
    // outside this spec's Owns list) already overlap on load, sheet
    // collapsed, before any panel opens -- confirmed identical rects for both
    // the baseline and the half-open sheet this session, so this is a
    // pre-existing, sheet-independent control-layout issue, not something
    // #qc-sheet introduces. This test's job is proving the SHEET keeps the
    // zoom control clear, so it checks the sheet made things no worse rather
    // than asserting an absolute pass a pre-existing, out-of-Owns-list issue
    // would fail regardless of the sheet (same reasoning as the horizontal-
    // overflow test below).
    const zoomBefore = await page.evaluate(hitTestable('.leaflet-control-zoom-in'));

    await trustedClick(page, '#qcm-layer-panel summary');
    const snap = await page.evaluate(sheetSnapshot);
    assert.equal(snap.sheet, 'half', `data-sheet is "${snap.sheet}" after opening Layers, expected "half"`);
    assert.ok(snap.mapHeight >= 0.40 * snap.containerHeight,
      `#qc-map is ${snap.mapHeight}px of a ${snap.containerHeight}px stage — under 40%`);

    const scrollers = await page.evaluate(scrollRegionsScript);
    assert.deepEqual(scrollers, ['qcm-layer-panel'],
      `expected #qcm-layer-panel to be the ONE overflow-y:auto region inside #qc-sheet, found: ${JSON.stringify(scrollers)}`);

    const closeBtn = await page.evaluate(rectOf('#qcm-layer-panel .qcm-panel-close'));
    assert.ok(closeBtn.found && closeBtn.h >= TOUCH_GOAL, `Layers' Close button measures ${closeBtn.w}x${closeBtn.h}`);
    const sizeBtn = await page.evaluate(rectOf('.qc-sheet-size'));
    assert.ok(sizeBtn.found && sizeBtn.h >= TOUCH_GOAL, `.qc-sheet-size measures ${sizeBtn.w}x${sizeBtn.h} while the sheet is half`);

    const zoom = await page.evaluate(hitTestable('.leaflet-control-zoom-in'));
    assert.ok(zoom.ok || zoom.reason === zoomBefore.reason,
      `the zoom-in control is not hit-testable with the sheet open, and not from the same pre-existing cause as on load: ${zoom.reason} (was: ${zoomBefore.reason})`);
  });

  test(`sheet: the size button toggles half <-> expanded (${vp.w}x${vp.h})`, { skip }, async () => {
    const page = await freshPageAt(vp);
    await trustedClick(page, '#qcm-layer-panel summary');
    await trustedClick(page, '.qc-sheet-size');
    let snap = await page.evaluate(sheetSnapshot);
    assert.equal(snap.sheet, 'expanded', `data-sheet is "${snap.sheet}" after the size button, expected "expanded"`);
    assert.ok(snap.sheetHeight >= 0.95 * snap.containerHeight,
      `#qc-sheet is ${snap.sheetHeight}px of a ${snap.containerHeight}px stage while expanded — under 95%`);

    await trustedClick(page, '.qc-sheet-size');
    snap = await page.evaluate(sheetSnapshot);
    assert.equal(snap.sheet, 'half', `data-sheet is "${snap.sheet}" after a second size-button click, expected "half"`);
  });

  test(`sheet: dragging the handle moves half -> expanded -> half -> collapsed, closing the panel and restoring focus (${vp.w}x${vp.h})`, { skip }, async () => {
    const page = await freshPageAt(vp);
    await trustedClick(page, '#qcm-layer-panel summary');
    assert.equal((await page.evaluate(sheetSnapshot)).sheet, 'half');

    await trustedDrag(page, '.qc-sheet-handle', -200);
    assert.equal((await page.evaluate(sheetSnapshot)).sheet, 'expanded',
      'dragging the handle up 200px from half did not expand the sheet');

    await trustedDrag(page, '.qc-sheet-handle', 200);
    assert.equal((await page.evaluate(sheetSnapshot)).sheet, 'half',
      'dragging the handle down 200px from expanded did not settle on half');

    await trustedDrag(page, '.qc-sheet-handle', 200);
    const after = await page.evaluate(`(() => ({
      sheet: document.getElementById('qc-sheet').getAttribute('data-sheet'),
      layersOpen: document.getElementById('qcm-layer-panel').open,
      activeIsSummary: document.activeElement === document.querySelector('#qcm-layer-panel summary'),
    }))()`);
    assert.equal(after.sheet, 'collapsed', 'dragging the handle down 200px from half did not collapse the sheet');
    assert.equal(after.layersOpen, false, 'the Layers panel is still open after the sheet collapsed by drag');
    assert.ok(after.activeIsSummary, 'focus was not restored to the Layers summary after the drag closed the sheet');
  });

  test(`sheet: switching panels keeps half, and Back returns to the previous panel still half (${vp.w}x${vp.h})`, { skip }, async () => {
    const page = await freshPageAt(vp);
    await trustedClick(page, '#qcm-layer-panel summary');
    await trustedClick(page, '#qcm-app summary');
    const snap = await page.evaluate(sheetSnapshot);
    assert.equal(snap.sheet, 'half', `data-sheet is "${snap.sheet}" after switching to Print, expected "half"`);

    const backVisible = await page.evaluate(backVisibleScript('#qcm-app'));
    assert.equal(backVisible, true, 'the Back button is not visible on Print after switching from Layers');

    await trustedClick(page, '#qcm-app .qcm-panel-back');
    const after = await page.evaluate(`(() => ({
      layersOpen: document.getElementById('qcm-layer-panel').open,
      sheet: document.getElementById('qc-sheet').getAttribute('data-sheet'),
    }))()`);
    assert.equal(after.layersOpen, true, 'Back from Print did not reopen Layers');
    assert.equal(after.sheet, 'half', `data-sheet is "${after.sheet}" after Back, expected "half"`);
  });

  test(`sheet: expanding then opening a different panel via its own summary keeps it expanded (${vp.w}x${vp.h})`, { skip }, async () => {
    const page = await freshPageAt(vp);
    await trustedClick(page, '#qcm-layer-panel summary');
    await trustedClick(page, '.qc-sheet-size');
    assert.equal((await page.evaluate(sheetSnapshot)).sheet, 'expanded');

    await trustedClick(page, '#qcm-app summary');
    const snap = await page.evaluate(sheetSnapshot);
    assert.equal(snap.sheet, 'expanded',
      `data-sheet is "${snap.sheet}" after opening Print from an expanded sheet, expected it to stay "expanded"`);
  });

  test(`sheet: Escape from half collapses it and restores focus to the opener (${vp.w}x${vp.h})`, { skip }, async () => {
    const page = await freshPageAt(vp);
    await trustedClick(page, '#qcm-layer-panel summary');
    assert.equal((await page.evaluate(sheetSnapshot)).sheet, 'half');

    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.evaluate('new Promise(r => setTimeout(r, 150))');

    const after = await page.evaluate(`(() => ({
      sheet: document.getElementById('qc-sheet').getAttribute('data-sheet'),
      layersOpen: document.getElementById('qcm-layer-panel').open,
      activeIsSummary: document.activeElement === document.querySelector('#qcm-layer-panel summary'),
    }))()`);
    assert.equal(after.sheet, 'collapsed', `data-sheet is "${after.sheet}" after Escape, expected "collapsed"`);
    assert.equal(after.layersOpen, false, 'Escape did not close the Layers panel');
    assert.ok(after.activeIsSummary, 'focus was not restored to the Layers summary after Escape');
  });
}

/** The document's own horizontal overflow, absolute: `scrollWidth` is what the page
 *  would scroll sideways by, and `clientWidth` is the width the reader can see. */
const docOverflow = `(() => {
  const de = document.documentElement;
  return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth };
})()`;

test('sheet: no document-level horizontal overflow at 320/390/768, collapsed, half or expanded', { skip }, async () => {
  // Absolute (audit A02): the page never scrolls sideways at any width, in any
  // sheet state. This used to compare each state to that width's own on-load
  // scrollWidth, because a 320px page carried an overflow (an unwrapped <code>
  // sample in the Documentation prose) that was there before any sheet
  // interaction. That overflow is gone from the built page, so the baseline now
  // only hides a regression: a later overflow that is already present on load
  // would pass. Load itself is checked here too.
  const widths = [320, 390, 768];
  const bad = [];
  for (const w of widths) {
    const page = await freshPageAt({ w, h: 700 });
    const over = async (label) => {
      const { scrollWidth, clientWidth } = await page.evaluate(docOverflow);
      if (scrollWidth > clientWidth) bad.push(`${w}px ${label} (scrollWidth ${scrollWidth}, clientWidth ${clientWidth})`);
    };
    await over('on load');
    await trustedClick(page, '#qcm-layer-panel summary'); // -> half
    await over('half');
    await trustedClick(page, '.qc-sheet-size'); // -> expanded
    await over('expanded');
    await trustedClick(page, '.qc-sheet-size'); // -> half
    await trustedClick(page, '#qcm-layer-panel .qcm-panel-close'); // -> collapsed
    await over('collapsed');
  }
  assert.deepEqual(bad, [], `the page scrolls sideways at: ${bad.join(', ')}`);
});

test('dock: no document-level horizontal overflow at 1440 on load or with each panel open', { skip }, async () => {
  // The desktop half of A02: the same absolute rule where the panels are a dock
  // beside the map instead of a sheet under it.
  const page = await freshPageAt({ w: 1440, h: 900 });
  const bad = [];
  const over = async (label) => {
    const { scrollWidth, clientWidth } = await page.evaluate(docOverflow);
    if (scrollWidth > clientWidth) bad.push(`${label} (scrollWidth ${scrollWidth}, clientWidth ${clientWidth})`);
  };
  await over('on load');
  for (const sel of SUMMARY_SELECTORS) {
    await trustedClick(page, sel);
    await over(`${sel} open`);
  }
  assert.deepEqual(bad, [], `the page scrolls sideways at 1440px: ${bad.join(', ')}`);
});

test('sheet: rotating 390x844 -> 844x390 keeps a half-open sheet at half with the map still usable', { skip }, async () => {
  const page = await freshPageAt({ w: 390, h: 844 });
  await trustedClick(page, '#qcm-layer-panel summary');
  assert.equal((await page.evaluate(sheetSnapshot)).sheet, 'half');

  await page.setViewport({ width: 844, height: 390 });
  await page.evaluate('new Promise(r => setTimeout(r, 200))');

  const snap = await page.evaluate(sheetSnapshot);
  assert.equal(snap.sheet, 'half', `data-sheet is "${snap.sheet}" after rotating, expected it to stay "half"`);
  assert.ok(snap.mapHeight >= 0.40 * snap.containerHeight,
    `#qc-map is ${snap.mapHeight}px of a ${snap.containerHeight}px stage after rotation — under 40%`);

  const zoomInMap = await page.evaluate(`(() => {
    const mapRect = document.getElementById('qc-map').getBoundingClientRect();
    const zoom = document.querySelector('.leaflet-control-zoom');
    if (!zoom) return { found: false };
    const zr = zoom.getBoundingClientRect();
    return {
      found: true,
      inside: zr.left >= mapRect.left - 1 && zr.top >= mapRect.top - 1
        && zr.right <= mapRect.right + 1 && zr.bottom <= mapRect.bottom + 1,
    };
  })()`);
  assert.ok(zoomInMap.found, 'the Leaflet zoom control is missing after rotation');
  assert.ok(zoomInMap.inside, 'the Leaflet zoom control is no longer contained inside #qc-map after rotation');
});

// A04: the combined state. A print area chosen puts the area strip (Edit, Undo,
// Clear, ~110px plus its margins) above the sheet in the same stage, and a half
// sheet used to keep its 45% regardless, so the map was left ~190px of a 606px
// stage at 390x844 and ~80px at 320x568. The sheet's own comment (quiet-corners.css)
// puts the map's floor at 35% of the stage. A tall phone is held to that; a short
// one cannot be (the sheet's grip bar and four summaries alone are ~150px of a
// ~400px stage, and squeezing them out of the frame clips them, which the
// inside-the-frame tests below catch), so it is held to an absolute map height: today's ~80px, a floor that
// stops it getting worse, not a statement that 80px is enough.
const MIN_PANEL_ROOM = 88; // two touch goals: a summary row plus one row to act on
const SHORT_PHONE_MIN_MAP = 72;

for (const vp of PHONE_VIEWPORTS) {
  const tall = vp.h >= 700;
  test(`sheet: with a print area chosen, a half sheet keeps the map usable (${vp.w}x${vp.h})`, { skip }, async () => {
    await forgetSavedRecipe();
    const page = await freshPageAt(vp);
    await chooseExampleArea(page);
    for (const sel of ['#qcm-layer-panel summary', '#qcm-app summary']) {
      await trustedClick(page, sel);
      const snap = await page.evaluate(sheetSnapshot);
      assert.equal(snap.sheet, 'half', `data-sheet is "${snap.sheet}" after opening ${sel}, expected "half"`);
      if (tall) {
        assert.ok(snap.mapHeight >= 0.35 * snap.containerHeight,
          `with a print area chosen and ${sel} open, #qc-map is ${snap.mapHeight}px of a ${snap.containerHeight}px stage — under 35%`);
      } else {
        assert.ok(snap.mapHeight >= SHORT_PHONE_MIN_MAP,
          `with a print area chosen and ${sel} open, #qc-map is only ${snap.mapHeight}px tall — under ${SHORT_PHONE_MIN_MAP}px`);
      }
      assert.ok(snap.sheetHeight >= MIN_PANEL_ROOM,
        `with a print area chosen and ${sel} open, the sheet is only ${snap.sheetHeight}px tall — under ${MIN_PANEL_ROOM}px`);
    }
  });
}

// --- the sheet stays inside the map frame -------------------------------------
//
// #qc-map-container clips whatever runs past its edges, so a sheet control laid
// out below the frame's bottom edge is cut off: on a phone it can be neither seen
// nor pressed. Every other sheet test here presses through
// helpers/trusted-click.mjs, which centres its target first -- and while the
// frame was `overflow: hidden` that centring scrolled the frame itself, which no
// reader can do. So these measure the layout itself, in the frame's own
// coordinates, without pressing the grip at all: the size button is driven by
// its click handler, and a frame something has scrolled still reads true.

const sheetFit = `(() => {
  const frame = document.getElementById('qc-map-container');
  const sheet = document.getElementById('qc-sheet');
  const f = frame.getBoundingClientRect();
  const edge = frame.clientTop + frame.clientHeight;
  const past = (el) => Math.round(el.getBoundingClientRect().bottom - f.top + frame.scrollTop - edge);
  const name = (el) => el.id ? '#' + el.id : '.' + el.className.split(' ')[0];
  return {
    sheet: sheet.getAttribute('data-sheet'),
    past: [sheet, ...sheet.children].filter((el) => el.getClientRects().length)
      .map((el) => ({ name: name(el), by: past(el) })).filter((b) => b.by > 1),
    caption: !document.getElementById('qcm-surface-caption').hidden,
    strip: !document.getElementById('qcm-area-strip').hidden,
  };
})()`;

/** main.js restores the last print recipe from IndexedDB on every load, and every
 *  test in this file shares one page: an area one test chose came back, strip and
 *  all, in the next, and "nothing above the sheet" was then not true. Delete it from
 *  a same-origin page that runs none of the app, so no save still in flight there
 *  can land after the delete. */
async function forgetSavedRecipe() {
  const { site, page } = await sharedBrowser();
  await page.navigate(`${site.origin}/robots.txt`);
  await page.evaluate(`new Promise((resolve, reject) => {
    const open = indexedDB.open(${JSON.stringify(DB_NAME)}, ${VERSION});
    open.onupgradeneeded = () => open.result.createObjectStore(${JSON.stringify(STORE)});
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(${JSON.stringify(STORE)}, 'readwrite');
      tx.objectStore(${JSON.stringify(STORE)}).delete(${JSON.stringify(KEY)});
      tx.oncomplete = () => { open.result.close(); resolve(true); };
      tx.onerror = () => { open.result.close(); reject(tx.error); };
    };
  })`);
}

/** `shows` is [caption, strip] per step: what sat in the frame above the sheet. */
function assertInsideFrame(seen, sheets, shows) {
  assert.deepEqual(seen.map((s) => s.sheet), sheets);
  assert.deepEqual(seen.map((s) => [s.caption, s.strip]), shows,
    'what showed above the sheet at each step, as [surface caption, print-area strip]');
  const cut = seen.flatMap((s) => s.past.map((b) => `${s.when}: ${b.name} ends ${b.by}px past it`));
  assert.deepEqual(cut, [], `the map frame clips at its bottom edge, so this is cut off: ${cut.join('; ')}`);
}

for (const vp of PHONE_VIEWPORTS) {
  test(`sheet: collapsed, half and expanded each end inside the map frame (${vp.w}x${vp.h})`, { skip }, async () => {
    await forgetSavedRecipe();
    const page = await freshPageAt(vp);
    const seen = [{ when: 'collapsed', ...(await page.evaluate(sheetFit)) }];
    await trustedClick(page, '#qcm-layer-panel summary');
    seen.push({ when: 'half', ...(await page.evaluate(sheetFit)) });
    await page.evaluate("document.querySelector('.qc-sheet-size').click()");
    seen.push({ when: 'expanded', ...(await page.evaluate(sheetFit)) });
    assertInsideFrame(seen, ['collapsed', 'half', 'expanded'], Array(3).fill([false, false]));
  });

  test(`sheet: stays inside the map frame under the print-area strip, and when the surface caption appears over an expanded sheet (${vp.w}x${vp.h})`, { skip }, async () => {
    // Both sit in the same frame as the sheet, above it: the strip shows once an
    // area is chosen, the caption names a context surface while one is drawn. The
    // caption appears here with the sheet already expanded, so nothing about the
    // sheet itself changes -- only the room the frame has left for it.
    await forgetSavedRecipe();
    const page = await freshPageAt(vp);
    await chooseExampleArea(page);
    const seen = [{ when: 'collapsed', ...(await page.evaluate(sheetFit)) }];
    await trustedClick(page, '#qcm-layer-panel summary');
    seen.push({ when: 'half', ...(await page.evaluate(sheetFit)) });
    await page.evaluate("document.querySelector('.qc-sheet-size').click()");
    seen.push({ when: 'expanded', ...(await page.evaluate(sheetFit)) });
    await page.evaluate("document.getElementById('qcm-context-nightLights').click()");
    await waitInPage(page, 'the surface caption to show', "!document.getElementById('qcm-surface-caption').hidden");
    // A ResizeObserver runs after layout in the frame the size changed in, so by
    // the second frame's callback the first frame's observers have run.
    await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    seen.push({ when: 'expanded, once the caption showed', ...(await page.evaluate(sheetFit)) });
    await page.evaluate("document.querySelector('.qc-sheet-size').click()");
    seen.push({ when: 'half again', ...(await page.evaluate(sheetFit)) });
    assertInsideFrame(seen, ['collapsed', 'half', 'expanded', 'expanded', 'half'],
      [[false, true], [false, true], [false, true], [true, true], [true, true]]);
  });
}
