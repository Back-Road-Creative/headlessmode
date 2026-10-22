// Towns that exist versus towns that qualify — audit F06.
//
// Candidate dots are drawn only where the PARENT COUNTY passed the county filters,
// so the map's town layer is a filter result wearing the costume of geography. The
// export holds 1,574 incorporated places, every one with coordinates; the defaults
// leave 127. Pick North Carolina — 37 towns in the export, and not one county there
// clears the default score thresholds — and the state empties: no dots, no rows, and
// nothing on screen saying whether that means "no matches" or "no towns".
//
// A reader cannot tell a strict filter from an empty country. These gates hold the
// distinction: the places stay on the map as context, the counts say which number is
// which, and an empty result explains itself and offers a way out that keeps the area
// the reader chose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt() ? 'public/quiet-corners/ not built — run `hugo --configDir site-config --minify` first'
    : false;

/** Every town in the export, and the state that goes empty under the defaults. */
const ALL_PLACES = 1574;
const EMPTY_STATE = 'NC';

const waitForRows = `(async () => {
  for (let i = 0; i < 100; i++) {
    if (document.querySelector('.qc-candidate-row')) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
})()`;

const selectState = (abbr) => `(async () => {
  const sel = document.getElementById('qc-state');
  sel.value = ${JSON.stringify(abbr)};
  // The filter itself applies synchronously off this event. Selecting a state no
  // longer moves the map on its own -- Zoom to state is a separate, explicit
  // button -- so the fixture clicks it itself to get the same settled view these
  // proofs need.
  const zoomed = qcMoves();
  // A real select fires both; the dashboard listens on input.
  sel.dispatchEvent(new Event('input', { bubbles: true }));
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('qc-zoom-state').click();
  await zoomed('the map finished zooming to ' + ${JSON.stringify(abbr)});
  const section = document.getElementById('qc-candidates-section');
  return {
    sectionText: section ? section.textContent.replace(/\\s+/g, ' ').trim() : null,
    rows: document.querySelectorAll('.qc-candidate-row').length,
    reset: !!document.getElementById('qc-reset-scores'),
  };
})()`;

/** What the place layer actually drew. Leaflet renders these markers to a canvas
 *  (preferCanvas), so there is no element to count — but a layer given its own pane
 *  gets its own canvas, and non-transparent pixels in THAT canvas are the places and
 *  nothing else. No raster tiles load at this zoom, so the canvas is same-origin. */
const placePixels = `(async () => {
  const count = () => {
    const pane = document.querySelector('.leaflet-qc-places-pane');
    if (!pane) return { pane: false, painted: 0 };
    let painted = 0;
    for (const c of pane.querySelectorAll('canvas')) {
      const ctx = c.getContext('2d');
      if (!ctx || !c.width || !c.height) continue;
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      for (let i = 3; i < data.length; i += 4) if (data[i] > 40) painted++;
    }
    return { pane: true, painted };
  };
  // Leaflet's canvas renderer repaints on its own animation frame, so "has it
  // drawn yet" is a question about frames and not about milliseconds. Poll for
  // the paint, and hand back the LAST sample whatever it is: when the layer
  // genuinely draws nothing the assertions below say why far better than a
  // timeout message could, and they still get to say it.
  const end = Date.now() + 30000;
  let seen = count();
  while (!seen.painted && Date.now() < end) {
    await new Promise(r => setTimeout(r, 100));
    seen = count();
  }
  return seen;
})()`;

async function onDashboard(fn) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, `${site.origin}/quiet-corners/`, {
    viewport: { width: 1440, height: 1000 }, args: ['--hide-scrollbars'],
  });
  try {
    await readyDashboard(page);
    assert.equal(await page.evaluate(waitForRows), true, 'no candidate rows rendered');
    return await fn(page);
  } finally { page.close(); await site.close(); }
}

test('the counts say how many towns matched out of how many there are', { skip }, async () => {
  const text = await onDashboard((p) => p.evaluate(
    `document.getElementById('qc-candidates-section').textContent.replace(/\\s+/g, ' ').trim()`));
  assert.match(text, new RegExp(String(ALL_PLACES).replace(/(\d)(?=(\d{3})+$)/g, '$1,?')),
    `the candidates section never says how many towns exist (${ALL_PLACES}); a bare match count `
    + `reads as the whole country. Section said: ${JSON.stringify(text.slice(0, 200))}`);
});

test('a state with no matches says so, and says it is not a state with no towns', { skip }, async () => {
  const seen = await onDashboard((p) => p.evaluate(selectState(EMPTY_STATE)));
  assert.equal(seen.rows, 0, `${EMPTY_STATE} was expected to match nothing under the defaults`);
  assert.match(seen.sectionText || '', /no .*match|match.*none|0 of/i,
    `${EMPTY_STATE} empties the table and the section explains nothing. It said: `
    + JSON.stringify((seen.sectionText || '').slice(0, 200)));
  assert.ok(seen.reset,
    'an empty result offers no way back — the reader has to undo five sliders by hand or lose '
    + 'the state they picked. #qc-reset-scores should relax the scores and keep the area.');
});

test('the towns stay on the map when none of them qualify', { skip }, async () => {
  const seen = await onDashboard(async (p) => {
    await p.evaluate(selectState(EMPTY_STATE));
    return p.evaluate(placePixels);
  });
  assert.ok(seen.pane,
    'there is no place-context layer at all — the only town markers on the map are the ones '
    + 'that passed the county filters, so an empty result looks like empty country');
  assert.ok(seen.painted > 0,
    `the place-context layer is present but drew nothing with ${EMPTY_STATE} selected; the `
    + `${ALL_PLACES}-town export has 37 places there whatever the scores say`);
});
