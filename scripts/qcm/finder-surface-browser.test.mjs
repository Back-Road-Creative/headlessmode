// QQA-03a: the finder is one readable surface.
//
// Before: .qc-finder-box had no background. The field, the result rows and the
// empty/error notes were each their own little panel, and the notes (no fill at all)
// sat straight over dense map labels; the desktop input text was 12px.
//
// Now the box is ONE opaque surface with padding, and everything the finder shows
// (field, result rows, loading/empty/error notes, the Search button) sits on it.
// Held at both a phone and a desktop size by measuring the rendered page:
//   - the input's computed font-size is at least 16px (also what stops mobile Safari
//     zooming the page on focus);
//   - the box's background is opaque (alpha 1) and the box itself is not faded;
//   - the box has padding, so the field does not touch its edge;
//   - on a phone the toggle, the Search button and a result row are at least 44px tall;
//   - what a pointer meets at the box's corners and over its note is the box or its
//     content, never a map label painted behind it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const TOUCH_GOAL = 44;
const NO_ZOOM_FONT_PX = 16;

async function withMapAt(viewport, fn) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, `${site.origin}/quiet-corners/`, { viewport, args: ['--hide-scrollbars'] });
  try {
    await readyDashboard(page);
    return await fn(page);
  } finally { page.close(); await site.close(); }
}

/** Open the finder, type, and measure the rendered surface. */
const measure = (term) => `(async () => {
  const toggle = document.querySelector('.qc-finder-toggle');
  const toggleHeight = toggle.getBoundingClientRect().height;
  if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
  const input = document.getElementById('qc-place-search');
  input.focus();
  input.value = ${JSON.stringify(term)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const pane = document.querySelector('.qc-finder-box');
  const cs = getComputedStyle(pane);
  const alpha = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return 0;
    const p = m[1].split(/[ ,\\/]+/).filter(Boolean); return p.length > 3 ? parseFloat(p[3]) : 1; };
  const box = pane.getBoundingClientRect();
  const inside = (el) => !!el && pane.contains(el);
  const probe = (x, y) => document.elementFromPoint(x, y);
  const note = document.querySelector('#qc-finder-note:not([hidden])');
  const row = document.querySelector('#qc-place-results [role="option"]');
  const btn = document.getElementById('qc-name-search-btn');
  const nb = note && note.getBoundingClientRect();
  const corners = [[box.left + 3, box.top + 3], [box.right - 3, box.top + 3],
    [box.left + 3, box.bottom - 3], [box.right - 3, box.bottom - 3]];
  const overlaps = [...corners.map(([x, y]) => probe(x, y)),
    ...(nb ? [probe(nb.left + nb.width / 2, nb.top + nb.height / 2)] : [])];
  return {
    inputFontPx: parseFloat(getComputedStyle(input).fontSize),
    boxAlpha: alpha(cs.backgroundColor), boxBackground: cs.backgroundColor,
    boxOpacity: parseFloat(cs.opacity),
    paddings: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(parseFloat),
    toggleHeight, buttonHeight: btn.getBoundingClientRect().height,
    rowHeight: row ? row.getBoundingClientRect().height : 0,
    noteFontPx: note ? parseFloat(getComputedStyle(note).fontSize) : 0,
    noteText: note ? note.textContent.trim() : '',
    buttonFontPx: parseFloat(getComputedStyle(btn).fontSize),
    exposed: overlaps.filter((el) => !inside(el)).map((el) => el ? el.tagName + '.' + el.className : 'null'),
  };
})()`;

for (const vp of [{ width: 390, height: 844, phone: true }, { width: 1280, height: 800, phone: false }]) {
  const where = `${vp.width}x${vp.height}`;

  test(`at ${where} the finder is one opaque, padded surface with 16px input text`, { skip }, async () => {
    const seen = await withMapAt(vp, (p) => p.evaluate(measure('zzqq no such place')));
    const problems = [];
    if (!(seen.inputFontPx >= NO_ZOOM_FONT_PX)) problems.push(`input text is ${seen.inputFontPx}px, under ${NO_ZOOM_FONT_PX}px`);
    if (seen.boxAlpha !== 1) problems.push(`the finder box background is ${seen.boxBackground} (alpha ${seen.boxAlpha}), not opaque`);
    if (seen.boxOpacity !== 1) problems.push(`the finder box is drawn at opacity ${seen.boxOpacity}`);
    if (!seen.paddings.every((n) => n >= 8)) problems.push(`the box padding is ${seen.paddings.join('/')}px, under 8px on a side`);
    if (!seen.noteText) problems.push('a miss produced no note to measure');
    if (!(seen.noteFontPx >= 14)) problems.push(`the empty-state note is ${seen.noteFontPx}px, under 14px`);
    if (seen.exposed.length) problems.push(`something other than the finder is painted at its corners or over its note: ${seen.exposed.join(', ')}`);
    assert.deepEqual(problems, [], problems.join('; '));
  });

  test(`at ${where} the result rows and Search sit on the same surface${vp.phone ? ' and are 44px targets' : ''}`, { skip }, async () => {
    const seen = await withMapAt(vp, (p) => p.evaluate(measure('Ashland')));
    const problems = [];
    if (seen.boxAlpha !== 1) problems.push(`the box behind the result rows is ${seen.boxBackground}, not opaque`);
    if (!(seen.rowHeight > 0)) problems.push('"Ashland" produced no result row to measure');
    if (!(seen.buttonFontPx >= 14)) problems.push(`the Search button text is ${seen.buttonFontPx}px, under 14px`);
    if (vp.phone) {
      if (!(seen.toggleHeight >= TOUCH_GOAL)) problems.push(`the search toggle is ${seen.toggleHeight}px tall`);
      if (!(seen.buttonHeight >= TOUCH_GOAL)) problems.push(`the Search button is ${seen.buttonHeight}px tall`);
      if (!(seen.rowHeight >= TOUCH_GOAL)) problems.push(`a result row is ${seen.rowHeight}px tall`);
    }
    assert.deepEqual(problems, [], problems.join('; '));
  });
}

test('the primary action is named Search, and its accessible name contains its visible text', { skip }, async () => {
  const seen = await withMapAt({ width: 1280, height: 800 }, (p) => p.evaluate(`(() => {
    const b = document.getElementById('qc-name-search-btn');
    return { visible: b.textContent.trim(), label: b.getAttribute('aria-label') };
  })()`));
  assert.equal(seen.visible, 'Search');
  const name = (seen.label || seen.visible).toLowerCase();
  assert.ok(name.includes(seen.visible.toLowerCase()), `accessible name ${JSON.stringify(name)} does not contain the visible text`);
});
