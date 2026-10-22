// A county picked from the table before the county geometry has arrived must still
// be the pick. quiet-corners.js attaches geo.json + counties-10m.json on their own,
// after the table (loadData), so on a slow link a reader can press a row while
// flyToCounty has no point for it yet. It used to answer that press by blanking the
// panel: the Conditions header read "Pick a county or a town to see conditions
// there." to a reader who had just picked one. PR CI run 36610861814 caught it as
// panel-shell-browser test 770 under runner load.
//
// This proof holds geo.json in the page itself (a fetch wrapper installed before any
// page script runs), picks rows while it is held, then lets it through.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt() ? 'public/quiet-corners/ not built — run `hugo --configDir site-config --minify` first'
    : false;

const NO_PICK = 'Pick a county or a town to see conditions there.';

// Every geo.json request waits on window.__releaseGeo(); everything else goes straight out.
const HOLD_GEO = `(() => {
  const real = window.fetch.bind(window);
  let release;
  const gate = new Promise((r) => { release = r; });
  window.__releaseGeo = () => release();
  window.__geoHeld = 0;
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (/\\/geo\\.json(\\?|$)/.test(url)) { window.__geoHeld++; return gate.then(() => real(input, init)); }
    return real(input, init);
  };
})()`;

let shared = null;
after(async () => {
  if (!shared) return;
  shared.page.close();
  await shared.site.close();
});

async function heldPage() {
  if (!shared) {
    const site = await startSiteServer();
    const page = await launch(CHROMIUM, 'about:blank', { viewport: { width: 1280, height: 900 } });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: HOLD_GEO });
    shared = { site, page };
  }
  const { site, page } = shared;
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page);
  await page.evaluate("document.getElementById('qc-explore-panel').open = true");
  await waitInPage(page, 'the county table has rows',
    "!!document.querySelector('#qc-table-body .qc-row[data-fips]')");
  assert.equal(await page.evaluate('window.__geoHeld'), 1, 'geo.json was not held — the proof would prove nothing');
  return page;
}

const heading = "document.getElementById('qc-conditions-heading').textContent";
const summary = "document.getElementById('qc-conditions-summary').textContent";

/** Clicks table rows in order (in-page, as panel-shell-browser does) and returns their names. */
const pickRows = (page, n) => page.evaluate(`(() => {
  const rows = [...document.querySelectorAll('#qc-table-body .qc-row[data-fips]')].slice(0, ${n});
  return rows.map((row) => { row.click(); return row.querySelector('.qc-name').textContent; });
})()`);

test('a county picked while its geometry is loading is named at once, then gets its conditions', { skip }, async () => {
  const page = await heldPage();
  const [name] = await pickRows(page, 1);

  const early = { heading: await page.evaluate(heading), summary: await page.evaluate(summary) };
  assert.notEqual(early.heading, NO_PICK, 'a reader who just picked a county was told to pick one');
  assert.ok(early.heading.includes(name), `the heading "${early.heading}" does not name the pick "${name}"`);
  assert.ok(early.summary.includes(name), `the summary "${early.summary}" does not name the pick "${name}"`);

  await page.evaluate('window.__releaseGeo()');
  await waitInPage(page, `the Conditions header for ${name}`,
    `!!document.querySelector('#qc-conditions-for h2') && document.querySelector('#qc-conditions-for h2').textContent.includes(${JSON.stringify(name)})`);
  assert.ok((await page.evaluate(heading)).includes(name), 'the heading lost the pick once the geometry arrived');
});

test('a second pick while the geometry is loading wins — the first is never replayed over it', { skip }, async () => {
  const page = await heldPage();
  const [first, second] = await pickRows(page, 2);
  assert.notEqual(first, second, 'the first two rows share a name; the proof cannot tell them apart');
  assert.ok((await page.evaluate(heading)).includes(second), 'the second pick is not the one named');

  await page.evaluate('window.__releaseGeo()');
  await waitInPage(page, `the Conditions header for ${second}`,
    `!!document.querySelector('#qc-conditions-for h2') && document.querySelector('#qc-conditions-for h2').textContent.includes(${JSON.stringify(second)})`);
  const h = await page.evaluate(heading);
  assert.ok(h.includes(second) && !h.includes(first), `the heading "${h}" should name "${second}" only`);
});
