// What a phone shows of the results tables, measured in a real browser.
//
// Audit finding F19 (.data/plans/2026-09-09-quiet-corners-map-audit-plan.md): at
// 1023px and below the stylesheet hid results columns 6+ (affordability,
// remoteness, sprawl) and candidate columns 4 and 6+. The filters above them do
// not shrink -- so a reader could set the affordability filter on a phone and
// never see an affordability figure. The measure you asked about was the one off
// screen.
//
// Each row is a comparison card at that width now, and no column is dropped. Each
// cell carries its own column heading in `data-label`, written by labelCells() in
// quiet-corners.js from the table's own header row, and the card draws it with
// `content: attr(data-label)`. That is the property worth gating: a label typed
// into the stylesheet instead would drift the first time a column moved, and
// nothing would notice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { waitInPage } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt() ? 'public/quiet-corners/ not built — run `hugo --configDir site-config --minify` first'
    : false;

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 1000 };

/** A table needs its data fetched before it has a row to look at, and the two
 *  tables load from different files: the candidate list is its own ~1.8MB fetch
 *  that lands well after the county rows. Waiting on the county table and then
 *  reading the candidate one is how this test failed on a loaded runner while
 *  passing everywhere else. */
const hasRows = (bodyId, rowClass) => `!!document.querySelector('#${bodyId} .${rowClass}')`;

/** Reads one table: its headings, and the first row's cells with the label each
 *  one actually draws. `content` on ::after resolves attr() to the stamped value,
 *  so this is what a reader sees, not what the markup intends. */
const readTable = (headerId, bodyId, rowClass) => `(() => {
  const header = document.getElementById(${JSON.stringify(headerId)});
  const row = document.querySelector('#${bodyId} .${rowClass}');
  if (!header || !row) return null;
  const own = (el) => Array.prototype.filter.call(el.childNodes, n => n.nodeType === 3)
    .map(n => n.textContent).join('').trim();
  const headings = Array.prototype.map.call(header.querySelectorAll('span[data-sort]'), own);
  const box = row.getBoundingClientRect();
  const cells = Array.prototype.map.call(row.children, (c) => {
    const r = c.getBoundingClientRect();
    const after = getComputedStyle(c, '::after').content;
    return {
      text: c.textContent.trim(),
      label: c.getAttribute('data-label'),
      drawn: after && after !== 'none' ? after.replace(/^"|"$/g, '') : null,
      visible: r.width > 0 && r.height > 0,
      overflows: r.right > box.right + 1,
    };
  });
  return { headings, cells, headerVisible: header.getBoundingClientRect().height > 0 };
})()`;

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

for (const [what, headerId, bodyId, rowClass] of [
  ['county', 'qc-table-header', 'qc-table-body', 'qc-row'],
  ['candidate town', 'qc-candidates-header', 'qc-candidates-body', 'qc-candidate-row'],
]) {
  test(`every ${what} measure is on screen at 390px, each beside its own heading`, { skip }, async () => {
    const seen = await onPage(PHONE, hasRows(bodyId, rowClass),
      (p) => p.evaluate(readTable(headerId, bodyId, rowClass)));
    assert.ok(seen, `no ${what} row rendered — the table never loaded`);
    assert.equal(seen.cells.length, seen.headings.length,
      `the card shows ${seen.cells.length} of ${seen.headings.length} columns; `
      + 'a phone must not drop a measure the filters above it can still set');
    seen.cells.forEach((cell, i) => {
      assert.ok(cell.visible, `the ${JSON.stringify(seen.headings[i])} column is not on screen`);
      assert.equal(cell.label, seen.headings[i],
        `cell ${i} is labelled ${JSON.stringify(cell.label)} under the heading `
        + `${JSON.stringify(seen.headings[i])} — the label must come from the header row`);
      assert.equal(cell.overflows, false,
        `the ${JSON.stringify(seen.headings[i])} column runs past the edge of its card`);
    });
    // The first cell is the card's subject and needs no label; every other one
    // has to say what it is, because the column heading is gone at this width.
    assert.equal(seen.headerVisible, false, 'the column header row is still taking space on a phone');
    seen.cells.slice(1).forEach((cell, i) => {
      assert.equal(cell.drawn, seen.headings[i + 1],
        `the card draws ${JSON.stringify(cell.drawn)} for the `
        + `${JSON.stringify(seen.headings[i + 1])} column`);
    });
  });
}

// QQA-02: the dock is one narrow column at every desktop width (288px at 1024px), so
// the comparison data is cards there too. This replaces "the desktop table is still a
// table", which asserted the header row on screen and no drawn labels -- the layout the
// dock used to widen to 656px to fit. The bar is the phone's, held at least as tightly:
// every column still on screen with its own heading drawn beside the value, the header
// row gone (the sort picker, tested in sort-reach.test.mjs, replaces it), nothing past
// the edge of its card, no name cut short, and no sideways scroll in the dock.
const DOCK_WIDTHS = [{ width: 1024, height: 768 }, DESKTOP, { width: 1920, height: 1080 }];

/** Every row of one table, read with the panel open: whether the card is wider than the
 *  panel, whether any cell is cut off by its own box, and the panel's own sideways scroll. */
const readDockCards = (bodyId, rowClass) => `(async () => {
  const panel = document.getElementById('qc-explore-panel');
  panel.open = true;
  await new Promise((r) => setTimeout(r, 150));
  const rows = [...document.querySelectorAll('#${bodyId} .${rowClass}')]
    .filter((r) => r.getBoundingClientRect().width > 0);
  const pb = panel.getBoundingClientRect();
  const cut = [], wide = [];
  for (const row of rows) {
    const rb = row.getBoundingClientRect();
    if (rb.right > pb.right + 1 || rb.left < pb.left - 1) wide.push(row.textContent.trim().slice(0, 40));
    for (const c of row.children) {
      if (c.scrollWidth > c.clientWidth + 1) cut.push(c.textContent.trim().slice(0, 40));
      if (c.getBoundingClientRect().right > rb.right + 1) wide.push('cell ' + c.textContent.trim().slice(0, 20));
    }
  }
  return { rows: rows.length, cut, wide, panelScroll: [panel.scrollWidth, panel.clientWidth],
    dock: document.getElementById('qc-sheet').getBoundingClientRect().width };
})()`;

for (const vp of DOCK_WIDTHS) {
  for (const [what, headerId, bodyId, rowClass] of [
    ['county', 'qc-table-header', 'qc-table-body', 'qc-row'],
    ['candidate town', 'qc-candidates-header', 'qc-candidates-body', 'qc-candidate-row'],
  ]) {
    test(`at ${vp.width}px the ${what} rows are cards in the dock: every measure labelled, nothing cut off`, { skip }, async () => {
      const seen = await onPage(vp, hasRows(bodyId, rowClass), async (p) => {
        const table = await p.evaluate(readTable(headerId, bodyId, rowClass));
        const dock = await p.evaluate(readDockCards(bodyId, rowClass));
        return { table, dock };
      });
      const { table, dock } = seen;
      assert.ok(table, `no ${what} row rendered — the table never loaded`);
      assert.equal(table.headerVisible, false, `the ${what} column header row is still taking space in the dock`);
      assert.equal(table.cells.length, table.headings.length,
        `the card shows ${table.cells.length} of ${table.headings.length} columns`);
      table.cells.forEach((cell, i) => {
        assert.ok(cell.visible, `the ${JSON.stringify(table.headings[i])} column is not on screen`);
        assert.equal(cell.label, table.headings[i], `cell ${i} is labelled ${JSON.stringify(cell.label)}`);
        assert.equal(cell.overflows, false, `the ${JSON.stringify(table.headings[i])} column runs past the edge of its card`);
        if (i > 0) assert.equal(cell.drawn, table.headings[i],
          `the card draws ${JSON.stringify(cell.drawn)} beside the ${JSON.stringify(table.headings[i])} value`);
      });
      assert.ok(dock.rows > 0, `no ${what} row had a box with Explore open`);
      assert.deepEqual(dock.wide, [], `${what} rows or cells hang past the dock`);
      assert.deepEqual(dock.cut, [], `${what} cells are cut off by their own box`);
      assert.ok(dock.panelScroll[0] <= dock.panelScroll[1] + 1,
        `Explore scrolls sideways in the ${Math.round(dock.dock)}px dock: ${dock.panelScroll[0]}px of content in ${dock.panelScroll[1]}px`);
    });
  }
}
