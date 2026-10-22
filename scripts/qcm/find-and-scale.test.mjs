// You cannot find a place on this map — audit F20, the other half.
//
// The scale and the reset landed in the PR below this one. What is missing still
// is any way to type a name: the Field Maps page has a quad-name search and this
// one has nothing, so finding a town means knowing its county first.
//
// Search reads the SAME full export the labels do, not the filtered candidate
// list. A town the ranking rejected is still a town, and looking it up is exactly
// how a reader asks "why isn't this one a match?".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt() ? 'public/quiet-corners/ not built — run `hugo --configDir site-config --minify` first'
    : false;

async function withMap(fn) {
  return withMapAt({ width: 1440, height: 1000 }, fn);
}

/** The same, at a viewport you choose — the shape layout.test.mjs uses for withPage.
 *  Screen shape is the whole subject of the reset test below, so that test cannot be
 *  run at the one hard-coded desktop size the rest of this file is happy with. */
async function withMapAt(viewport, fn) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, `${site.origin}/quiet-corners/`, {
    viewport, args: ['--hide-scrollbars'],
  });
  try {
    await readyDashboard(page);
    return await fn(page);
  } finally { page.close(); await site.close(); }
}

/** Open the finder and hold until it is typeable. The toggle un-hides a pane it
 *  has already re-homed onto the map's container, so "the box exists" is not the
 *  same question as "the box is open". */
const OPEN_FINDER = `await (async () => {
  const toggle = document.querySelector('.qc-finder-toggle');
  if (!toggle) throw new Error('no search control on the map');
  if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
  return qcWait('the finder box opened', () => {
    const el = document.getElementById('qc-place-search'), pane = el && el.closest('.qc-finder-box');
    return pane && !pane.hidden ? el : null;
  });
})()`;

// renderFinderResults runs synchronously on the input event, so once the export
// it reads has landed there is nothing left to wait for between typing and
// reading the list. readyDashboard() is what waits for the export.
/** Type into the search box and take the first suggestion, the way a reader would. */
const search = (term) => `(async () => {
  const box = ${OPEN_FINDER};
  box.focus();
  box.value = ${JSON.stringify(term)};
  box.dispatchEvent(new Event('input', { bubbles: true }));
  const hits = [...document.querySelectorAll('#qc-place-results [role="option"]')];
  if (!hits.length) return { error: 'no suggestion for ' + ${JSON.stringify(term)} };
  const label = hits[0].textContent.trim();
  const settled = qcMoves();
  hits[0].click();
  await settled('the map stopped moving after choosing ' + label);
  const c = window.qcMap.getCenter();
  return { label, lat: c.lat, lon: c.lng, zoom: window.qcMap.getZoom(), hits: hits.length };
})()`;

test('a distance scale says how far across the map is', { skip }, async () => {
  const seen = await withMap((p) => p.evaluate(`(() => {
    const el = document.querySelector('.leaflet-control-scale-line');
    return el ? { text: el.textContent.trim(), width: el.getBoundingClientRect().width } : null;
  })()`));
  assert.ok(seen, 'the map draws no scale bar at all');
  assert.match(seen.text, /\b(mi|ft)\b/, `the scale reads "${seen.text}" — this map prints letter paper in miles`);
  assert.ok(seen.width > 20, `a ${seen.width}px scale bar cannot be read or compared against`);
});

test('a town can be found by name', { skip }, async () => {
  // Amery, Polk County, Wisconsin — 45.30459, -92.363356 in the export. Names
  // there carry their legal suffix ("Amery city"), so typing the bare name has to
  // work: nobody searches for the word "city".
  const seen = await withMap((p) => p.evaluate(search('Amery')));
  assert.equal(seen.error, undefined, seen.error);
  assert.match(seen.label, /Amery/i, `the first suggestion was "${seen.label}"`);
  assert.ok(Math.abs(seen.lat - 45.305) < 0.4 && Math.abs(seen.lon + 92.363) < 0.4,
    `search moved the map to ${seen.lat}, ${seen.lon}, which is not Amery`);
  assert.ok(seen.zoom >= 9, `arriving at zoom ${seen.zoom} shows no topographic base to arrive ONTO`);
});

test('a town the ranking rejected can still be looked up', { skip }, async () => {
  // North Carolina yields zero candidates under the defaults (audit F06). Its
  // towns are still towns, and this is precisely when a reader searches for one.
  const seen = await withMap((p) => p.evaluate(search('Banner Elk')));
  assert.equal(seen.error, undefined, seen.error);
  assert.match(seen.label, /Banner Elk/i, `the first suggestion was "${seen.label}"`);
  assert.ok(seen.hits >= 1, 'search reads the filtered result, not the full export');
});

/** The corners of the lower 48: the Florida keys and the southern tip of Texas, the
 *  Canadian border, Cape Alava and the coast of Maine. Reset has to show all four. */
const CONUS_CORNERS = { south: 24.5, west: -125, north: 49.4, east: -66.9 };

// "Show the whole country" has to show the whole country, and the country is a fixed
// area while the map rectangle is not. One centre-and-zoom pair can only frame one
// shape: what fits the lower 48 in a wide desktop rectangle crops both coasts off a
// phone. So the gate is the map's VISIBLE bounds containing those corners, measured
// at both widths — not the centre landing somewhere near Kansas, which a cropped view
// satisfies just as well as a correct one.
for (const vp of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
  test(`there is a way back to the whole country at ${vp.width}px`, { skip }, async () => {
    const seen = await withMapAt(vp, (p) => p.evaluate(`(async () => {
      const map = window.qcMap;
      const zoomedIn = qcMoves();
      map.setView([43.55, -90.89], 11, { animate: false });
      await zoomedIn('the map arrived at the view reset has to undo');
      const btn = document.querySelector('.qc-reset-view');
      if (!btn) return { error: 'no reset control on the map' };
      const tabbable = btn.tagName === 'BUTTON' || btn.hasAttribute('href') || btn.tabIndex >= 0;
      // flyToBounds over 0.8 s of rAF frames: its wall-clock length is whatever
      // this box's frame rate makes it, so wait for the frames to stop.
      const framed = qcMoves();
      btn.click();
      await framed('the reset finished framing the country');
      const b = map.getBounds();
      return { tabbable, label: (btn.getAttribute('aria-label') || btn.title || '').trim(),
        south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast(),
        zoom: map.getZoom() };
    })()`));
    assert.equal(seen.error, undefined, seen.error);
    const shown = `${seen.south.toFixed(1)},${seen.west.toFixed(1)} to ${seen.north.toFixed(1)},${seen.east.toFixed(1)} at zoom ${seen.zoom}`;
    assert.ok(seen.west <= CONUS_CORNERS.west,
      `reset shows ${shown} — the west coast is off the left edge`);
    assert.ok(seen.east >= CONUS_CORNERS.east,
      `reset shows ${shown} — the east coast is off the right edge`);
    assert.ok(seen.south <= CONUS_CORNERS.south,
      `reset shows ${shown} — Florida and south Texas are off the bottom`);
    assert.ok(seen.north >= CONUS_CORNERS.north,
      `reset shows ${shown} — the northern border is off the top`);
    assert.ok(seen.tabbable, 'the reset control cannot be reached without a mouse');
    assert.ok(seen.label.length > 0, 'a control with no accessible name is a mystery button');
  });
}

// Geometry is not reachability — the lesson of F01, at control size. A control
// can measure a perfectly good 30x30 and sit underneath a panel; a test that
// clicks it directly still passes, and a reader still cannot press it.
//
// It is measured with BOTH overlay panels open, because that is when this map has
// no corner left: print top-left, layers top-right, filters bottom-left, key
// bottom-right.
test('every map control is reachable with the panels open', { skip }, async () => {
  const seen = await withMap((p) => p.evaluate(`(async () => {
    for (const id of ['qcm-app', 'qcm-layer-panel']) {
      const d = document.getElementById(id); if (d) d.open = true;
    }
    await new Promise(r => setTimeout(r, 300));
    const hit = (sel) => { const el = document.querySelector(sel); if (!el) return 'missing';
      const b = el.getBoundingClientRect();
      const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      if (!top) return 'off-screen';
      return el === top || el.contains(top) || top.contains(el) ? 'reachable' : (top.className || top.tagName); };
    const before = { zoomIn: hit('.leaflet-control-zoom-in'), zoomOut: hit('.leaflet-control-zoom-out'),
      reset: hit('.qc-reset-view'), find: hit('.qc-finder-toggle') };
    ${OPEN_FINDER};
    // The expanded box is the hard case: it is wider than the lane, so it opens
    // over the panels and must be above them to be typed into.
    return { ...before, box: hit('#qc-place-search') };
  })()`));
  for (const [name, got] of Object.entries(seen)) {
    assert.equal(got, 'reachable', `the ${name} control is under ${got}`);
  }
});

// --- naming a state, and being told when nothing matches (audit A02) ----------
//
// The finder matched `t.name` and nothing else. State was printed in the result
// row but never searched, so the one thing a reader reaches for when a name is
// ambiguous -- adding the state -- narrowed nothing. Ashland is a real town in
// both AL and IL, and "Ashland, IL" landed on the Alabama one because the comma
// and everything after it were matched against the name as literal text.
//
// Ranking had the same shape of bug. Matching was prefix-then-substring, so a
// LONGER name that merely starts with what you typed outranked the town you
// actually named: "Sylva" returned Sylvania AL, Sylvania GA, and only then Sylva
// NC. The legal suffix is why an exact match needs defining at all -- the record
// is "Sylva town", nobody types that, and "Sylva" has to count as exact.

/** Type a query and read the suggestion list WITHOUT choosing anything. */
const suggest = (term) => `(async () => {
  const box = ${OPEN_FINDER};
  box.focus();
  box.value = ${JSON.stringify(term)};
  box.dispatchEvent(new Event('input', { bubbles: true }));
  const list = document.getElementById('qc-place-results');
  // The miss sentence moved OUT of the listbox: a listbox may hold options and
  // groups only, so prose in it is skipped rather than read. What these tests
  // care about is unchanged -- that a reader gets an answer rather than a blank
  // box -- so 'answered' asks that directly instead of asking whether the
  // listbox happens to be the thing showing. (No backticks in here: this comment
  // sits inside a template literal, and one would end the string.)
  const note = document.getElementById('qc-finder-note');
  return {
    answered: Boolean(note && !note.hidden && note.textContent.trim())
      || Boolean(list.querySelectorAll('[role="option"]').length),
    options: [...list.querySelectorAll('[role="option"]')].map(el => el.textContent.trim()),
    message: note && !note.hidden ? note.textContent : null,
  };
})()`;

test('naming the state picks that state', { skip }, async () => {
  const seen = await withMap((p) => p.evaluate(suggest('Ashland, IL')));
  assert.ok(seen.options.length, `"Ashland, IL" suggested nothing (message: ${seen.message})`);
  assert.match(seen.options[0], /,\s*IL$/,
    `"Ashland, IL" offered ${seen.options[0]} first — the state was typed and ignored`);
  for (const opt of seen.options) {
    assert.match(opt, /,\s*IL$/, `${opt} is not in IL, but IL is what was asked for`);
  }
});

test('the town you named outranks the longer name that contains it', { skip }, async () => {
  const seen = await withMap((p) => p.evaluate(suggest('Sylva')));
  assert.ok(seen.options.length, 'Sylva suggested nothing');
  assert.match(seen.options[0], /^Sylva\b/,
    `"Sylva" offered ${seen.options[0]} first — a longer name beat the exact one`);
});

test('a search that matches nothing says so', { skip }, async () => {
  // Ashland is in the export twice, in AL and IL. Neither is in Oregon, so this
  // is a query with a real name and a real state that genuinely has no answer.
  const seen = await withMap((p) => p.evaluate(suggest('Ashland, OR')));
  assert.equal(seen.options.length, 0, `"Ashland, OR" matched ${seen.options.join(' / ')}`);
  assert.equal(seen.answered, true, 'the box went blank — a reader gets no answer at all');
  assert.ok(seen.message && /no/i.test(seen.message),
    `no empty-state message; the box just went blank (message: ${seen.message})`);
});

// --- the combobox keyboard contract (audit A03) -------------------------------
//
// The input declares role="combobox" and the rows declare role="option", but the
// only key the box handled was Escape. Arrow Down did nothing, so there was no
// active option to announce and no `aria-activedescendant` to announce it with: a
// screen reader was told a combobox was there and never told what was in it. The
// rows are separately tabbable buttons, which is a second way through the list and
// not the one the pattern specifies.
//
// https://www.w3.org/WAI/ARIA/apg/patterns/combobox/

/** Type, then send a sequence of keys to the box, then report what the list says. */
const keys = (term, seq) => `(async () => {
  const box = ${OPEN_FINDER};
  box.focus();
  box.value = ${JSON.stringify(term)};
  box.dispatchEvent(new Event('input', { bubbles: true }));
  // The keydown handler is synchronous; the only asynchronous thing a key can
  // start here is the map move Enter sets off by clicking the active option.
  const chosen = qcMoves();
  for (const key of ${JSON.stringify(seq)}) {
    box.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  }
  if (${JSON.stringify(seq)}.includes('Enter')) await chosen('the map stopped moving after Enter');
  const opts = [...document.querySelectorAll('#qc-place-results [role="option"]')];
  const active = opts.find(o => o.getAttribute('aria-selected') === 'true');
  const c = window.qcMap.getCenter();
  return {
    activedescendant: box.getAttribute('aria-activedescendant'),
    activeId: active ? active.id : null,
    activeText: active ? active.textContent.trim() : null,
    options: opts.map(o => ({ id: o.id, text: o.textContent.trim() })),
    zoom: window.qcMap.getZoom(), lat: c.lat, lon: c.lng,
  };
})()`;

test('arrow down marks an option active and names it', { skip }, async () => {
  const seen = await withMap((p) => p.evaluate(keys('Ashland', ['ArrowDown'])));
  assert.ok(seen.options.length >= 2, `Ashland offered ${seen.options.length} suggestions`);
  assert.ok(seen.options[0].id, 'the options have no ids, so nothing can point at one');
  assert.equal(seen.activedescendant, seen.options[0].id,
    'aria-activedescendant does not name the first option — Arrow Down moved nothing');
  assert.equal(seen.activeId, seen.options[0].id,
    'no option is marked aria-selected, so a sighted reader sees no highlight either');
});

test('enter chooses the active option', { skip }, async () => {
  // Two downs, so this cannot pass by falling back to "the first hit".
  const seen = await withMap((p) => p.evaluate(keys('Ashland', ['ArrowDown', 'ArrowDown', 'Enter'])));
  assert.ok(seen.zoom >= 10, `Enter left the map at zoom ${seen.zoom} — it chose nothing`);
});

test('typing again clears the stale active option', { skip }, async () => {
  // An activedescendant left pointing at a row that no longer exists is a dangling
  // reference: the reader is told about an option that is not in the list.
  const seen = await withMap((p) => p.evaluate(`(async () => {
    const box = ${OPEN_FINDER};
    box.focus();
    box.value = 'Ashland';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    box.value = 'Sylva';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    const opts = [...document.querySelectorAll('#qc-place-results [role="option"]')];
    return {
      activedescendant: box.getAttribute('aria-activedescendant'),
      selected: opts.filter(o => o.getAttribute('aria-selected') === 'true').length,
      ids: opts.map(o => o.id),
    };
  })()`));
  assert.ok(!seen.activedescendant || seen.ids.indexOf(seen.activedescendant) >= 0,
    `aria-activedescendant still points at ${seen.activedescendant}, which is not in the list`);
  assert.equal(seen.selected, 0, 'a stale option is still marked selected after the query changed');
});

// --- typing coordinates instead of a name -------------------------------------
//
// A reader does not always arrive with a name. They have a pair of numbers off a
// GPS, a trailhead listing, or another map, and the only way to reach that spot
// here was to guess which town is nearest it. The finder read every query as a
// name, so "34.5, -83.2" was matched against the export as literal text, hit
// nothing, and came back as a town that does not exist.
//
// Decimal degrees only, latitude first. Degrees/minutes/seconds is a separate
// parse and is deliberately not handled here.

test('coordinates typed into the finder move the map there', { skip }, async () => {
  // The north Georgia mountains. No town record sits on that exact pair, so a
  // name search cannot be the thing that answers this.
  const seen = await withMap((p) => p.evaluate(search('34.5, -83.2')));
  assert.equal(seen.error, undefined, seen.error);
  assert.equal(seen.hits, 1, `a coordinate pair offered ${seen.hits} options, not one place`);
  assert.match(seen.label, /34\.5000/, `the option read "${seen.label}"`);
  assert.ok(Math.abs(seen.lat - 34.5) < 0.05 && Math.abs(seen.lon + 83.2) < 0.05,
    `the map went to ${seen.lat}, ${seen.lon}, not the pair that was typed`);
  assert.equal(seen.zoom, 11, `coordinates arrived at zoom ${seen.zoom}, not FIND_ZOOM`);
});

test('a coordinate pair is read with or without the comma', { skip }, async () => {
  // Nobody agrees on the separator, and a pasted pair carries whatever spacing
  // it was copied with.
  const seen = await withMap(async (p) => ({
    comma: await p.evaluate(suggest('34.5,-83.2')),
    space: await p.evaluate(suggest(' 34.5 -83.2 ')),
  }));
  for (const [form, got] of Object.entries(seen)) {
    assert.equal(got.options.length, 1,
      `the ${form} form suggested ${got.options.join(' / ')} (message: ${got.message})`);
    assert.match(got.options[0], /^34\.5000, -83\.2000$/,
      `the ${form} form offered "${got.options[0]}"`);
  }
});

test('an out-of-range pair says what is out of range', { skip }, async () => {
  // 95 is not a latitude — most likely the pair was typed longitude first. That
  // is a different mistake from searching for a town that is not in the list,
  // and "No town matching 95, -83" sends the reader looking for a town.
  const seen = await withMap((p) => p.evaluate(suggest('95, -83')));
  assert.equal(seen.options.length, 0, `"95, -83" matched ${seen.options.join(' / ')}`);
  assert.equal(seen.answered, true, 'the box went blank — a reader gets no answer at all');
  assert.ok(seen.message, 'no empty-state message; the box just went blank');
  assert.match(seen.message, /latitude/i,
    `the message never names the range that was broken: "${seen.message}"`);
  assert.doesNotMatch(seen.message, /no town/i,
    `an impossible latitude was reported as a missing town: "${seen.message}"`);
});

test('a plain name still searches names', { skip }, async () => {
  // The coordinate branch runs before the name search, so this is the guard that
  // it does not swallow ordinary queries on its way past.
  const seen = await withMap((p) => p.evaluate(suggest('Amery')));
  assert.ok(seen.options.length, `"Amery" suggested nothing (message: ${seen.message})`);
  assert.match(seen.options[0], /^Amery\b/, `"Amery" offered ${seen.options[0]} first`);
});

// --- the finder on a phone (audit A09) ----------------------------------------
//
// Nothing in the stylesheet mentioned this control below 1024px, so a phone got
// the desktop lane exactly as it is: a 30x30 icon button whose only visible
// content is the glyph "⌕", opening a box whose text is 12px. That is two
// separate problems on a touch screen. The button says nothing about what it
// does and is a small thing to hit, and mobile Safari zooms the whole page
// whenever a focused input's text is under 16px — which throws the reader out of
// the map they opened the search to move around in.
//
// 44px is this product's own touch-target goal. It is not the WCAG AA minimum:
// the AA criterion (WCAG 2.2 Target Size (Minimum)) is 24px, and 44px is the AAA
// figure. The number gated here is the product's goal, stated as such.
const TOUCH_GOAL = 44;
const NO_ZOOM_FONT_PX = 16;

/** Open the finder, type a query, and measure what a thumb has to hit. */
const finderMetrics = `(async () => {
  const toggle = document.querySelector('.qc-finder-toggle');
  if (!toggle) return { error: 'no search control on the map' };
  const button = toggle.getBoundingClientRect();
  const words = toggle.textContent.replace(/[^A-Za-z0-9 ]+/g, ' ').trim();
  const box = ${OPEN_FINDER};
  box.focus();
  box.value = 'Ashland';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  const hit = document.querySelector('#qc-place-results [role="option"]');
  const pane = document.querySelector('.qc-finder-box').getBoundingClientRect();
  return {
    buttonWidth: button.width, buttonHeight: button.height, words,
    inputFontPx: parseFloat(getComputedStyle(box).fontSize),
    rowHeight: hit ? hit.getBoundingClientRect().height : 0,
    paneLeft: pane.left, paneRight: pane.right, viewport: window.innerWidth,
  };
})()`;

test('the phone search says what it is and is big enough to hit', { skip }, async () => {
  const seen = await withMapAt({ width: 390, height: 844 }, (p) => p.evaluate(finderMetrics));
  assert.equal(seen.error, undefined, seen.error);
  // QUX-05a renamed the control from "Find a town" to "Search places" (the
  // box now finds peaks and other named places too, merged in alongside
  // towns) -- this still checks the same thing: the phone gets more than a
  // lone glyph.
  assert.match(seen.words, /search/i,
    `the control's only visible content is ${JSON.stringify(seen.words)} — a lone glyph on a `
    + 'phone map is easy to scroll straight past');
  assert.ok(seen.buttonHeight >= TOUCH_GOAL && seen.buttonWidth >= TOUCH_GOAL,
    `the search control measures ${seen.buttonWidth}x${seen.buttonHeight} on a phone; this `
    + `product aims for ${TOUCH_GOAL}px touch targets`);
  assert.ok(seen.inputFontPx >= NO_ZOOM_FONT_PX,
    `the search input is ${seen.inputFontPx}px — mobile Safari zooms the page on focus below `
    + `${NO_ZOOM_FONT_PX}px, which throws the reader out of the map`);
  assert.ok(seen.rowHeight >= TOUCH_GOAL,
    `a suggestion row is ${seen.rowHeight}px tall, under the ${TOUCH_GOAL}px this product aims `
    + 'for; the wrong town is one mis-tap away');
  assert.ok(seen.paneLeft >= 0 && seen.paneRight <= seen.viewport + 1,
    `the open search box spans ${seen.paneLeft} to ${seen.paneRight} in a ${seen.viewport}px `
    + 'viewport, so part of it is off screen');
});

test('the desktop search still fits the 30px control lane', { skip }, async () => {
  // The phone treatment must not leak upward: on a desktop this button shares a
  // 30px-wide lane down the left edge with zoom and reset, and a wide labelled
  // button there would cover the map for no reason.
  const seen = await withMapAt({ width: 1440, height: 1000 }, (p) => p.evaluate(finderMetrics));
  assert.equal(seen.error, undefined, seen.error);
  assert.ok(seen.buttonWidth <= 32 && seen.buttonHeight <= 32,
    `the search button measures ${seen.buttonWidth}x${seen.buttonHeight} on a desktop, wider `
    + 'than the control lane it sits in');
  assert.ok(seen.paneRight <= seen.viewport + 1,
    `the open search box reaches ${seen.paneRight} in a ${seen.viewport}px viewport`);
});

// --- the finder on a short screen ---------------------------------------------
//
// The open box is re-homed into the map's frame, #qc-map-container, and placed under
// its button. The frame was `overflow: hidden`, which clips but is still a scroll
// container: a reader cannot scroll it, and a script can. On a short screen the box ran
// past the frame's bottom edge, so its last rows and "Search" were clipped out of
// reach, and Arrow Down onto a row past the edge had setFinderActive's
// scrollIntoView({ block: 'nearest' }) scroll the frame itself to show it. The whole map
// slid up inside its own frame, and nothing a reader can do slides it back.
//
// Measured before the fix: as it opened, the box ended at 931px under a frame edge at
// 854px at 390x667 (77px past it) and at 509px under 383px at 844x390 (126px past); the
// arrow keys then scrolled the frame 28px and 76px; and centring an element 400px below
// the frame's edge, as the last test does, scrolled it 708px.
//
// The fix has two halves and each is held on its own. The box is capped to the room
// under its button, takes that height out of its list, and is placed again when the
// screen turns (the two short-screen tests and the turning test). The frame is
// `overflow: clip`, which is no scroll container (the last test).

/** Fill the list and measure the box against the frame as it opens, then walk the list
 *  with the keys, noting after each one where the frame and the active row are, and
 *  measure the box once more at the end. */
const walkFinder = `(async () => {
  const box = ${OPEN_FINDER};
  box.focus();
  // This fills the list to its row limit (FIND_MAX_HITS, 8 rows, in quiet-corners.js).
  box.value = 'mount';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  const frame = document.getElementById('qc-map-container');
  const list = document.getElementById('qc-place-results');
  const fit = () => ({
    frame: frame.getBoundingClientRect().bottom,
    pane: box.closest('.qc-finder-box').getBoundingClientRect().bottom,
    names: document.getElementById('qc-name-search-btn').getBoundingClientRect().bottom,
  });
  const opened = fit();
  const keys = [...Array(9).fill('ArrowDown'), ...Array(9).fill('ArrowUp'), 'End', 'Home'];
  const steps = keys.map((key) => {
    box.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    const row = list.querySelector('[aria-selected="true"]');
    const r = row && row.getBoundingClientRect(), l = list.getBoundingClientRect();
    const e = frame.getBoundingClientRect();
    return {
      key, top: frame.scrollTop, left: frame.scrollLeft,
      shown: Boolean(r) && r.top >= Math.max(l.top, e.top) - 1 && r.bottom <= Math.min(l.bottom, e.bottom) + 1,
    };
  });
  return { rows: list.querySelectorAll('[role="option"]').length, opened, walked: fit(), steps };
})()`;

const px = (n) => `${Math.round(n)}px`;
/** One line for a box that runs past the frame's bottom edge, none for one that fits. */
const pastTheEdge = (when, f) => (f.pane <= f.frame + 1 && f.names <= f.frame + 1 ? []
  : [`${when}, the open search ends at ${px(f.pane)} and "Search" at ${px(f.names)}, `
    + `past the map frame's bottom edge at ${px(f.frame)}`]);

for (const viewport of [{ width: 390, height: 667 }, { width: 844, height: 390 }]) {
  test(`at ${viewport.width}x${viewport.height} the open search fits inside the map frame, and its arrow keys keep the chosen row in sight`, { skip }, async () => {
    const seen = await withMapAt(viewport, (p) => p.evaluate(walkFinder));
    assert.ok(seen.rows >= 6, `"mount" offered ${seen.rows} rows, too few to reach the bottom of a short screen`);
    // Every measurement goes in one report, so a red run shows all of them, not just the first.
    const moved = seen.steps.filter((s) => s.top !== 0 || s.left !== 0);
    const unseen = seen.steps.filter((s) => !s.shown);
    const problems = [
      ...pastTheEdge('as it opened', seen.opened),
      ...pastTheEdge('after the arrow keys', seen.walked),
      ...(moved.length ? ['the arrow keys scrolled the map inside its own frame: '
        + moved.map((s) => `${s.key} to ${s.top},${s.left}`).join(', ')] : []),
      ...(unseen.length ? [`the chosen row was out of sight after ${unseen.map((s) => s.key).join(', ')}`] : []),
    ];
    assert.deepEqual(problems, [], `${problems.join('; ')}. What is past the frame's edge is clipped out of reach.`);
  });
}

/** Where the open box is once the page has laid out at its new size. */
const placedFinder = `(async () => {
  // A frame for the new size to lay out, and one more for whatever that set off.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const pane = document.querySelector('.qc-finder-box');
  const e = document.getElementById('qc-map-container').getBoundingClientRect();
  const b = pane.getBoundingClientRect();
  return {
    open: !pane.hidden, query: document.getElementById('qc-place-search').value,
    frame: e.bottom, frameRight: e.right, pane: b.bottom, paneRight: b.right,
    names: document.getElementById('qc-name-search-btn').getBoundingClientRect().bottom,
  };
})()`;

test('an open search still fits inside the map frame after the phone turns, and keeps its query', { skip }, async () => {
  // Where the box sits and how tall it may be are worked out from the frame and the
  // button. Turning a phone with the search open changes both: on its side the frame is
  // much shorter, and turned back upright the screen is too narrow for the box to sit
  // beside the labelled button the way it did on the wide one.
  const turns = await withMapAt({ width: 390, height: 844 }, async (p) => {
    await p.evaluate(`(async () => {
      const box = ${OPEN_FINDER};
      box.value = 'mount';
      box.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const seen = [];
    for (const vp of [{ width: 844, height: 390 }, { width: 390, height: 844 }]) {
      await p.setViewport(vp);
      seen.push({ at: `${vp.width}x${vp.height}`, ...(await p.evaluate(placedFinder)) });
    }
    return seen;
  });
  const problems = turns.flatMap((t) => [
    ...(t.open ? [] : [`turned to ${t.at}, the search closed`]),
    ...(t.query === 'mount' ? [] : [`turned to ${t.at}, the query became ${JSON.stringify(t.query)}`]),
    ...pastTheEdge(`turned to ${t.at}`, t),
    ...(t.paneRight <= t.frameRight + 1 ? [] : [`turned to ${t.at}, the open search reaches ${px(t.paneRight)}, `
      + `past the map frame's right edge at ${px(t.frameRight)}`]),
  ]);
  assert.deepEqual(problems, [], `${problems.join('; ')}.`);
});

test('centring an element below the frame\'s edge does not scroll the map inside its own frame', { skip }, async () => {
  // The frame clips whatever runs past it and a reader has no way to scroll it, so a
  // script must not be able to either: helpers/trusted-click.mjs centres every element
  // it presses, and on a frame that could scroll, centring one near or past its bottom
  // edge slid the whole map up inside it. The tests above keep the open search inside
  // that edge, and panel-shell-browser.test.mjs the sheet and its direct children, but
  // boxes deeper in the sheet's panels can still end past it. So this puts an element
  // there on purpose rather than rely on one being there: without one, a frame that can
  // scroll would pass with nothing to scroll to.
  const seen = await withMapAt({ width: 390, height: 844 }, (p) => p.evaluate(`(async () => {
    const frame = document.getElementById('qc-map-container');
    const probe = document.createElement('div');
    probe.style.cssText = 'position: absolute; left: 0; top: calc(100% + 400px); width: 10px; height: 10px';
    frame.appendChild(probe);
    const below = probe.offsetParent === frame
      && probe.getBoundingClientRect().top > frame.getBoundingClientRect().bottom;
    probe.scrollIntoView({ block: 'center', inline: 'center' });
    const at = { top: frame.scrollTop, left: frame.scrollLeft };
    probe.remove();
    return { below, at };
  })()`));
  assert.ok(seen.below, 'the probe did not land below the frame\'s bottom edge, so there was nothing to scroll to');
  assert.deepEqual(seen.at, { top: 0, left: 0 },
    `centring an element below the frame's edge scrolled the map inside it to ${seen.at.top},${seen.at.left}`);
});

// --- leaving the open finder by the keyboard ------------------------------------
//
// The open box sits over the map and, on a phone, over the bottom sheet, so Tab or
// Shift+Tab out of it can move focus to a control the box itself is covering. At 320x568
// with the sheet at half, Shift+Tab from the search box moves to the sheet's Conditions
// summary with the summary's centre under the box, and one more Shift+Tab reaches the
// Explore summary, which the box covers entirely (WCAG 2.2 SC 2.4.11). So the box closes
// when Tab or Shift+Tab moves focus out of it, as Escape and its own button close it.
// Only the keyboard does: a press on the map moves focus to the map as well, and the last
// test holds the box open through one.

/** A real Tab press, or Shift+Tab. The browser acts on a key sent this way, so focus
 *  moves; the synthetic keydown walkFinder sends moves nothing. */
async function pressTab(page, shift = false) {
  const key = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: shift ? 8 : 0 };
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

/** Open the search and fill its list, leaving focus in the box. */
const typedFinder = `(async () => {
  const box = ${OPEN_FINDER};
  box.focus();
  box.value = 'mount';
  box.dispatchEvent(new Event('input', { bubbles: true }));
})()`;

/** Where focus is, whether the search is open, and whether the control with focus can be
 *  seen: the point at its centre has to be that control, not something on top of it. */
const focusState = `(async () => {
  // A frame for the press to land, and one more for whatever it set off.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const pane = document.querySelector('.qc-finder-box');
  const el = document.activeElement;
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
  return {
    what: el === document.body ? 'the page itself' : el.id ? '#' + el.id
      : el.tagName.toLowerCase() + ' "' + el.textContent.trim().slice(0, 24) + '"',
    inPane: pane.contains(el), onMap: document.getElementById('qc-map').contains(el),
    open: !pane.hidden, expanded: document.querySelector('.qc-finder-toggle').getAttribute('aria-expanded'),
    query: document.getElementById('qc-place-search').value,
    seen: Boolean(hit) && el.contains(hit),
  };
})()`;

test('Shift+Tab out of the open search closes it, so focus is not left under the box', { skip }, async () => {
  const seen = await withMapAt({ width: 320, height: 568 }, async (p) => {
    // Opening a panel puts the sheet at half.
    await p.evaluate(`(async () => {
      document.querySelector('#qcm-layer-panel summary').click();
      return qcWait('the sheet at half', () => document.getElementById('qc-sheet').getAttribute('data-sheet') === 'half' || null);
    })()`);
    await p.evaluate(typedFinder);
    await pressTab(p, true);
    return p.evaluate(focusState);
  });
  const problems = [
    ...(seen.inPane ? [`Shift+Tab kept focus inside the search, on ${seen.what}`] : []),
    ...(seen.open || seen.expanded !== 'false' ? [`focus moved on to ${seen.what} and the search stayed open`] : []),
    ...(seen.seen ? [] : [`${seen.what} has focus and the point at its centre is something else on top of it`]),
  ];
  assert.deepEqual(problems, [], `${problems.join('; ')}.`);
});

test('Tab through the open search keeps it open, and Tab out of it closes it', { skip }, async () => {
  const steps = await withMapAt({ width: 390, height: 844 }, async (p) => {
    await p.evaluate(typedFinder);
    const seen = [];
    do {
      await pressTab(p);
      seen.push(await p.evaluate(focusState));
    } while (seen.length < 4 && seen[seen.length - 1].inPane);
    return seen;
  });
  const path = steps.map((s) => `${s.what} (search ${s.open ? 'open' : 'closed'})`).join(', then ');
  // "Search" is the last control in the box, so reaching it is Tab staying inside.
  assert.ok(steps.some((s) => s.what === '#qc-name-search-btn'),
    `Tab from the box never reached "Search" in it: ${path}`);
  const out = steps.findIndex((s) => !s.inPane);
  assert.ok(out > 0 && steps.slice(0, out).every((s) => s.open) && !steps[out].open && steps[out].expanded === 'false',
    `Tab from the search box went to ${path}; it has to stay open while focus is in it and close once focus leaves`);
});

test('dragging the map with the search open keeps it open with its query', { skip }, async () => {
  // A reader opens the search, then drags the map to look around before choosing.
  // Leaflet focuses the map on that press (its keyboard handler does, on mousedown), so a
  // box that closed whenever focus left it would close, and drop the query, on every drag.
  const seen = await withMapAt({ width: 1440, height: 1000 }, async (p) => {
    await p.evaluate(typedFinder);
    const at = await p.evaluate(`(() => {
      const r = document.getElementById('qc-map').getBoundingClientRect();
      return { x: Math.round(r.left + r.width * 0.7), y: Math.round(r.top + r.height * 0.6) };
    })()`);
    await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', buttons: 1, clickCount: 1 });
    for (const step of [1, 2, 3]) {
      await p.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: at.x + 30 * step, y: at.y + 20 * step, button: 'left', buttons: 1,
      });
    }
    await p.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: at.x + 90, y: at.y + 60, button: 'left', buttons: 0, clickCount: 1,
    });
    return p.evaluate(focusState);
  });
  assert.ok(seen.onMap, `after the drag focus is on ${seen.what}, not the map, so the drag never took focus out of the search`);
  assert.ok(seen.open && seen.expanded === 'true', 'dragging the map closed the search');
  assert.equal(seen.query, 'mount', `dragging the map changed the query to ${JSON.stringify(seen.query)}`);
});
