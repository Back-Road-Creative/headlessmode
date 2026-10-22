// Can a reader re-rank the results tables on a phone? Measured by hit-testing a
// real browser, not by reading the markup.
//
// The finding: below 1024px the stylesheet hides both header rows
// (quiet-corners.css, `.qc-log-header, .qc-candidates-header { display: none }`)
// because each row becomes a comparison card and has no columns to click. The
// column headings were the ONLY re-rank control on the page, and `display:none`
// takes them out of the tab order as well, so the keyboard path went with them.
// Measured at 390x844 before the fix: 15 sortable headings in the document, none
// of them with a box, none of them hittable. The reader sees "Sorted by Overall,
// highest first." and has no way to ask for anything else.
//
// "Hidden" and "painted under the map" are the same failure to a thumb, so this
// hit-tests with elementFromPoint the way layout.test.mjs already does for the
// print and layer panels, rather than asserting that some element exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { trustedClick } from './helpers/trusted-click.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { waitInPage } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt() ? 'public/quiet-corners/ not built — run `hugo --configDir site-config --minify` first'
    : false;

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 1000 };

/** QUX-03b-i: the sort controls now live inside the Explore panel, closed by
 *  default. Measured against this exact page: a closed <details>'s non-summary
 *  content keeps a non-zero getBoundingClientRect() (author CSS gives it
 *  display:flex/grid, overriding the UA stylesheet's display:none), but
 *  Chromium still skips it for scrollIntoView and elementFromPoint — the same
 *  two things `hittable()` below relies on. So a real reader taps the summary
 *  open first, with the shared trustedClick (helpers/trusted-click.mjs) that
 *  panel-shell-browser.test.mjs uses for the same panel. */

/** Two, not eight. A "Sort by" picker plus a "Reverse" toggle is a legitimate
 *  answer on a phone, and so is a row of eight tappable headings on a desktop;
 *  the gate stays out of that choice and only asks that re-ranking is possible
 *  at all. */
const MIN_REACHABLE = 2;

/** Anything that offers a sort, whatever shape it takes: the desktop column
 *  headings carry `data-sort`, the phone picker carries `data-sort-control` and
 *  its direction toggle `data-sort-dir`. */
const SORT_CONTROLS = '[data-sort], [data-sort-control], [data-sort-dir]';

const reachableSorts = `(() => {
  const hittable = (el) => { const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return !!hit && (el === hit || el.contains(hit)); };
  const all = [...document.querySelectorAll('${SORT_CONTROLS}')];
  return { total: all.length, reachable: all.filter(hittable).length };
})()`;

/** Reads the headings a table actually shows, the same way labelCells() does:
 *  direct text nodes only, because the tooltip is a child element. A column the
 *  data has not enabled yet (sprawl ships `display:none`) is not offered. */
const shownHeadings = (headerId) => `
  [...document.querySelectorAll('#${headerId} span[data-sort]')]
    .filter(s => s.style.display !== 'none')
    .map(s => [...s.childNodes].filter(n => n.nodeType === 3)
      .map(n => n.textContent).join('').trim())`;

/** Picks a column the table is not already sorted by, applies it through the
 *  picker, then reverses it — reading the first row and the sort sentence after
 *  each. A control that is present but inert leaves all three readings equal. */
const rerank = (headerId, bodyId, rowClass, noteId) => `(() => {
  const sel = document.querySelector('select[data-sort-control="${headerId}"]');
  if (!sel) return { error: 'no sort picker for #${headerId}' };
  const first = () => { const r = document.querySelector('#${bodyId} .${rowClass}');
    return r ? r.textContent.trim() : null; };
  const note = () => (document.getElementById('${noteId}') || {}).textContent.trim();
  const before = { row: first(), note: note(), value: sel.value };
  const other = [...sel.options].map(o => o.value).find(v => v !== sel.value);
  if (!other) return { error: 'the picker offers only one column' };
  const label = [...sel.options].find(o => o.value === other).textContent;
  sel.value = other;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  const afterPick = { row: first(), note: note(), value: sel.value };
  const flip = document.querySelector('button[data-sort-dir="${headerId}"]');
  if (!flip) return { error: 'no direction toggle for #${headerId}' };
  flip.click();
  const afterFlip = { row: first(), note: note() };
  return { before, afterPick, afterFlip, label,
    options: [...sel.options].map(o => o.textContent),
    headings: ${shownHeadings(headerId)} };
})()`;

const hasRows = (bodyId, rowClass) => `!!document.querySelector('#${bodyId} .${rowClass}')`;

async function onPage(viewport, ready, fn) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, `${site.origin}/quiet-corners/`, {
    viewport, args: ['--hide-scrollbars'],
  });
  try {
    // Loudly: a probe that gave up quietly left the measurements below reading a
    // page that had not rendered yet, and reporting it as a page that renders wrong.
    await waitInPage(page, `the dashboard rendered ${ready}`, ready);
    return await fn(page);
  } finally { page.close(); await site.close(); }
}

for (const vp of [PHONE, DESKTOP]) {
  test(`a reader can re-rank the tables at ${vp.width}px`, { skip }, async () => {
    const seen = await onPage(vp, hasRows('qc-table-body', 'qc-row'), async (p) => {
      await trustedClick(p, '#qc-explore-panel summary');
      return p.evaluate(reachableSorts);
    });
    assert.ok(seen.reachable >= MIN_REACHABLE,
      `${seen.reachable} of ${seen.total} sort controls can be tapped at ${vp.width}px — `
      + `a reader needs at least ${MIN_REACHABLE} to choose a column and a direction`);
  });
}

for (const [what, headerId, bodyId, rowClass, noteId] of [
  ['county', 'qc-table-header', 'qc-table-body', 'qc-row', 'qc-sort-note'],
  ['candidate town', 'qc-candidates-header', 'qc-candidates-body', 'qc-candidate-row',
    'qc-candidates-sort-note'],
]) {
  test(`the ${what} sort picker actually re-ranks the table on a phone`, { skip }, async () => {
    const seen = await onPage(PHONE, hasRows(bodyId, rowClass),
      (p) => p.evaluate(rerank(headerId, bodyId, rowClass, noteId)));
    assert.equal(seen.error, undefined, seen.error);
    // The options are the table's own headings, in its own order. A second list
    // typed into the markup would drift the first time a column moved.
    assert.deepEqual(seen.options, seen.headings,
      'the picker offers a list of its own instead of the table’s header row');
    assert.ok(seen.before.row, `no ${what} row rendered — the table never loaded`);
    assert.notEqual(seen.afterPick.row, seen.before.row,
      `choosing ${JSON.stringify(seen.label)} left the top row unchanged — the picker is inert`);
    assert.notEqual(seen.afterPick.note, seen.before.note,
      'the sort sentence did not follow the picker');
    assert.match(seen.afterPick.note, new RegExp('Sorted by ' + seen.label + ','),
      `the sentence still names another column after picking ${JSON.stringify(seen.label)}`);
    assert.notEqual(seen.afterFlip.row, seen.afterPick.row,
      'reversing the direction left the top row unchanged');
    assert.notEqual(seen.afterFlip.note, seen.afterPick.note,
      'the sort sentence did not follow the direction toggle');
  });
}
