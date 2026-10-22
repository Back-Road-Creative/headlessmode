// A class the documentation page writes is a class the documentation page's
// stylesheets style.
//
// #517 made a dead `.qcm-*` class fail the build: a class token written in no
// template and no script paints nothing, so it must not exist. That check asks
// whether the name is written down ANYWHERE. It cannot ask the next question,
// and the next question is where the seven rules below were hiding.
//
// `.qcm-docs` and the six `.qcm-coverage` rules named real elements on
// /quiet-corners/maps/ and painted none of them, because they lived in
// quiet-corners-maps.css and that sheet is linked by exactly one layout --
// quiet-corners-dashboard.html, the /quiet-corners/ app page -- which is not
// this page. Measured before the move: `min-width: 32rem` computed to 0px, the
// row separators to 0px, the monospace row headers to the system sans stack,
// and the dotted `abbr` to a plain underline. Written down is not the same as
// reachable. It is the same shape as the `.qcm-app` CLASS rules that left ten
// dashboard controls looking like plain text (panel-chrome.test.mjs).
//
// So this measures the OUTCOME, on the page, the way panel-chrome.test.mjs
// does: it asks the rendered document which qcm- classes it carries and whether
// the sheets it actually loaded have a rule for each. No list of selector names
// to keep in step, and a rule that moves into an unlinked sheet tomorrow fails
// here rather than going quiet.
//
// The limit, stated: this asks whether a class is STYLED, not whether the
// styling is right. A class used purely as a scripting hook would fail it --
// there are none on this page, which has no JavaScript at all, and a hook with
// no styling intent belongs in a data attribute anyway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners/maps') ? 'public/quiet-corners/maps/ not built — run `hugo --configDir site-config --minify` first'
    : false;

const PAGE = '/quiet-corners/maps/';

/** Every qcm- class the document carries, and whether a loaded sheet styles it. */
const unstyled = `(() => {
  const worn = new Set();
  for (const el of document.querySelectorAll('[class]')) {
    for (const c of el.classList) if (c.startsWith('qcm-')) worn.add(c);
  }
  const styled = new Set();
  // A rule can be both: Chrome gives every CSSStyleRule a cssRules list for CSS
  // nesting, and an EMPTY list is still an object. Testing it for truth instead
  // of length skips every plain rule in the sheet and reads the whole site as
  // unstyled. The first draft did exactly that and failed naming all four
  // classes while the page was demonstrably painting them.
  const walk = (rules) => {
    for (const r of rules) {
      if (r.selectorText) {
        for (const m of r.selectorText.matchAll(/\\.(-?[_a-zA-Z][\\w-]*)/g)) styled.add(m[1]);
      }
      if (r.cssRules && r.cssRules.length) walk(r.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    // A sheet the page failed to load has no rules; that is the failure, not a skip.
    try { walk(sheet.cssRules); } catch { /* cross-origin, not possible here */ }
  }
  return {
    worn: [...worn].sort(),
    missing: [...worn].filter((c) => !styled.has(c)).sort(),
    sheets: [...document.styleSheets].map((s) => (s.href || '').replace(/^https?:\\/\\/[^/]+/, '')),
  };
})()`;

/** What a reader actually gets from the coverage table, in computed values. */
const coverage = `(() => {
  const t = document.querySelector('table.qcm-coverage');
  if (!t) return { table: 'no table.qcm-coverage on the page' };
  const px = (el, prop) => (el ? parseFloat(getComputedStyle(el)[prop]) : NaN);
  const abbr = t.querySelector('abbr');
  return {
    minWidth: px(t, 'minWidth'),
    separator: px(t.querySelector('tbody td'), 'borderBottomWidth'),
    rowHeadFont: getComputedStyle(t.querySelector('tbody th')).fontFamily,
    abbrUnderline: abbr ? getComputedStyle(abbr).textDecorationLine : null,
    abbrDotted: abbr ? parseFloat(getComputedStyle(abbr).borderBottomWidth) : NaN,
    docsPadTop: px(document.querySelector('.qcm-docs'), 'paddingTop'),
    overflows: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
})()`;

async function onDocsPage(probe, width = 1280) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, `${site.origin}${PAGE}`, {
    viewport: { width, height: 900 }, args: ['--hide-scrollbars'],
  });
  try { return await page.evaluate(probe); } finally { page.close(); await site.close(); }
}

test('every qcm- class this page wears is styled by a sheet this page loaded', { skip }, async () => {
  const seen = await onDocsPage(unstyled);
  assert.ok(seen.worn.length > 0, `${PAGE} carries no qcm- class at all — this gate is measuring nothing`);
  assert.deepEqual(seen.missing, [],
    `${PAGE} writes ${seen.missing.join(', ')} and loads no sheet that styles `
    + `${seen.missing.length === 1 ? 'it' : 'them'}. The rules exist, in a stylesheet this page does `
    + `not link — it loads ${seen.sheets.join(', ')}. Move the rules to a sheet this page loads `
    + '(style.css is on every page), or link the sheet that has them. Leaving them where they are '
    + 'means they paint nothing here, and no build gate can see that.');
});

test('the state coverage table is drawn as a table, not as running text', { skip }, async () => {
  const t = await onDocsPage(coverage);
  assert.equal(typeof t.minWidth, 'number', t.table);
  assert.ok(t.separator >= 1, `the coverage rows have no separator (border-bottom ${t.separator}px) — 51 rows run together`);
  assert.match(t.rowHeadFont, /mono/i, `the state-code column is not monospace: ${t.rowHeadFont}`);
  assert.equal(t.abbrUnderline, 'none', 'the abbr keeps its browser underline instead of the dotted cue');
  assert.ok(t.abbrDotted >= 1, `the abbr lost its dotted underline (border-bottom ${t.abbrDotted}px)`);
  assert.ok(t.docsPadTop >= 1, `.qcm-docs has no top padding (${t.docsPadTop}px) — the section starts flush against the sheet band`);
  assert.equal(t.overflows, false, 'the documentation page scrolls sideways');
});

test('the table still does not widen the phone', { skip }, async () => {
  const t = await onDocsPage(coverage, 390);
  assert.equal(t.overflows, false,
    'the coverage table widened the document at 390px — its min-width must stay inside .table-scroll');
});
