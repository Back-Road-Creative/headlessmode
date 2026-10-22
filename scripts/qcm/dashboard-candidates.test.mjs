// What a candidate town row does when you use it — measured in a real browser.
//
// Audit F07: the row had a mouse click handler and nothing else. County rows next
// to it carry tabindex="0", role="button", an aria-label and an Enter/Space handler
// (quiet-corners.js, renderCounties); the candidate rows carried none of it, so the
// entire candidate table was unreachable by keyboard. The click that did work flew
// to zoom 8 — one level BELOW FIELD_MIN_ZOOM, the threshold the topo base turns on
// at, so activating a town left you above the detail you activated it for.
//
// Audit F17: candidate scores are inherited from the parent county. The table says
// so once, above the table. The town's own popup repeats none of it, so a
// county-wide affordability or quietness number reads as a measurement of the town.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt() ? 'public/quiet-corners/ not built — run `hugo --configDir site-config --minify` first'
    : false;

const SRC = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners.js', import.meta.url), 'utf8');

/** candidates.json is ~1.8MB and loads after the first render, so the rows are not
 *  there when the page settles. readyDashboard() has already waited for the export
 *  to reach the page; this waits for the table it feeds to actually draw. */
const waitForRows = `window.qcWait('a candidate row rendered',
  () => document.querySelector('.qc-candidate-row'))`;

const rowSemantics = `(() => {
  const rows = [...document.querySelectorAll('.qc-candidate-row')];
  return rows.map((r) => ({ tabindex: r.getAttribute('tabindex'), role: r.getAttribute('role'),
    label: r.getAttribute('aria-label'), name: (r.querySelector('.qc-name') || {}).textContent }));
})()`;

/** Enter on the first row, then read what the map did about it. */
const activateFirstRow = `(async () => {
  const row = document.querySelector('.qc-candidate-row');
  const name = row.querySelector('.qc-name').textContent;
  row.focus();
  row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  // A row that opens nothing is the failure this test exists to name, so the wait
  // reports its own expiry rather than handing the assertion a silent null.
  const popup = await window.qcWait('Enter on ' + name.trim() + ' opened a popup',
    () => document.querySelector('.leaflet-popup-content'));
  return { popup: popup.textContent, name };
})()`;

async function onDashboard(fn) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, `${site.origin}/quiet-corners/`, {
    viewport: { width: 1440, height: 1000 }, args: ['--hide-scrollbars'],
  });
  try {
    await readyDashboard(page);
    await page.evaluate(waitForRows);
    return await fn(page);
  } finally { page.close(); await site.close(); }
}

test('a candidate town row is reachable and operable by keyboard', { skip }, async () => {
  const rows = await onDashboard((p) => p.evaluate(rowSemantics));
  assert.ok(rows.length > 0, 'no candidate rows to check');
  const broken = rows.filter((r) => r.tabindex !== '0' || r.role !== 'button' || !r.label);
  assert.deepEqual(broken, [],
    `${broken.length} of ${rows.length} candidate rows carry no keyboard semantics — `
    + 'the county rows beside them have tabindex="0", role="button" and an aria-label');
});

test('activating a candidate town opens that town, not just a viewport', { skip }, async () => {
  const seen = await onDashboard((p) => p.evaluate(activateFirstRow));
  assert.ok(seen.popup, `Enter on "${seen.name}" opened no popup — the row moved the map and said nothing`);
  assert.ok(seen.popup.includes(seen.name.trim()),
    `the popup that opened names "${seen.popup.slice(0, 60)}", not the activated town "${seen.name}"`);
});

test('the town popup says which of its numbers belong to the county', { skip }, async () => {
  const seen = await onDashboard((p) => p.evaluate(activateFirstRow));
  assert.match(seen.popup || '', /[Cc]ounty context/,
    'the town popup shows inherited county scores with nothing marking them as the county\'s — '
    + `a county-wide number reads as the town's own. Popup said: ${JSON.stringify(seen.popup)}`);
});

test('a candidate town is flown to at a zoom the topo base actually covers', { skip }, () => {
  const call = SRC.match(/flyToRM\(\[lat, lon\][^)]*\)/);
  assert.ok(call, 'the candidate row no longer flies to a lat/lon — update this gate');
  assert.doesNotMatch(call[0], /,\s*[0-8]\s*,/,
    `the candidate fly still passes a literal zoom below FIELD_MIN_ZOOM: ${call[0]}`);
  assert.match(call[0], /FIELD_MIN_ZOOM/,
    `the candidate fly should name the threshold it has to clear, not a number: ${call[0]}`);
});
