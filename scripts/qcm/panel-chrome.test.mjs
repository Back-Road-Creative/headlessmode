// Every control on the two map panels is painted as something to press.
//
// Tailwind's preflight resets a <button> and a <select> to `background-color:
// transparent` with a `border: 0 solid` — so on this page a control carries no
// chrome at all unless this site's own CSS puts it back. quiet-corners-maps.css
// did, in one rule, but that rule was keyed on a `.qcm-app` CLASS while the
// print panel carries `qcm-app` as an ID. It matched nothing, and nobody could
// see that it matched nothing: ten buttons and selects — Draw a rectangle, Find
// a quadrangle, Use this area, both scale/overlap selects, Check sources, Build
// PDF, Cancel, Calibration sheet, Print the key — rendered as bare text on a
// dark panel, an action indistinguishable from a label. #513 hit it with the
// new preset buttons and patched those two locally.
//
// A selector that matches nothing is invisible, which is why this measures the
// OUTCOME instead. It asks the rendered page what a reader would see, so it
// fails for a control added tomorrow under a selector nobody checked, and it
// has no list of selector names to keep in step with the stylesheet.
//
// Not scoped to visible controls: `#qcm-cancel` and the three download links
// are `hidden` until a build runs, and computed style is answerable for them
// anyway. Checkboxes and radios are excluded — they are UA widgets that the
// stylesheet deliberately leaves alone (see the `:not()` lists in
// quiet-corners-maps.css), and their label carries the chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt() ? 'public/quiet-corners/ not built — run `hugo --configDir site-config --minify` first'
    : false;

/** The print builder and the layer/map-key panel, by the ids layout.test.mjs uses. */
const PANELS = ['#qcm-app', '#qcm-layer-panel'];
const PRESSABLE = 'button, select';
const FIELDS = 'input:not([type="checkbox"]):not([type="radio"])';

const probe = `(() => {
  for (const d of document.querySelectorAll('details')) d.open = true;
  const name = (el) => (el.id ? '#' + el.id : el.tagName.toLowerCase())
    + ' ("' + (el.textContent || el.value || '').trim().slice(0, 32) + '")';
  const bare = [];
  for (const panel of ${JSON.stringify(PANELS)}) {
    const host = document.querySelector(panel);
    if (!host) { bare.push(panel + ' is not in the page at all'); continue; }
    for (const el of host.querySelectorAll('${PRESSABLE}, ${FIELDS}')) {
      const cs = getComputedStyle(el);
      const transparent = /^rgba\\(.*,\\s*0\\)$/.test(cs.backgroundColor) || cs.backgroundColor === 'transparent';
      const borderless = parseFloat(cs.borderTopWidth) < 1;
      const missing = [];
      if (transparent) missing.push('background ' + cs.backgroundColor);
      // A download link is an <a>, which the chrome rule does not dress; its
      // background comes from .qcm-build and it is legible without a border.
      if (borderless && el.matches('${PRESSABLE}')) missing.push('border ' + cs.borderTopWidth);
      if (missing.length) bare.push(panel + ' ' + name(el) + ': ' + missing.join(', '));
    }
  }
  return bare;
})()`;

test('no control on the map panels is painted as bare text', { skip }, async () => {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, `${site.origin}/quiet-corners/`, {
    viewport: { width: 1280, height: 900 },
  });
  let bare;
  try {
    bare = await page.evaluate(probe);
  } finally { page.close(); await site.close(); }
  assert.deepEqual(bare, [],
    `${bare.length} control(s) on the map panels carry no chrome, so they read as a label `
    + `rather than as something to press:\n  ${bare.join('\n  ')}`);
});
