// What the map is FOR changes at z=9, and nothing on it said so — audit F08.
//
// The topographic base is added at FIELD_MIN_ZOOM (quiet-corners.js:13, :474) with
// opacity 0.85, into Leaflet's tilePane at z-index 200. Above it sit two things that
// never move: the all-counties `L.geoJSON` fill, 0.7 opacity over a rural county
// (quiet-corners.js:512), and the ranked `hlLayer` choropleth — both in the default
// overlayPane at z-index 400. So the reader zooms in to look at terrain and gets
// terrain seen through a county-coloured filter. Meanwhile the key still names the
// county ranking, a national comparison the reader has stopped making.
//
// Both gates are rendered measurements, not source reads. The county fills get a pane
// of their own so there is something whose composited opacity can be asked for; the
// key is read as text at both zooms. `window.qcMap` (quiet-corners.js) is what lets a
// test put the map at a zoom without synthesising wheel events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt() ? 'public/quiet-corners/ not built — run `hugo --configDir site-config --minify` first'
    : false;

/** The zoom the topo base turns on at, and a national zoom well below it. */
const FIELD_ZOOM = 10;
const NATIONAL_ZOOM = 4;

/** At field zoom the county wash may keep at most this much of its weight. Above it
 *  the contours underneath are a tinted smear rather than a map you could walk. */
const MAX_FIELD_FILL_OPACITY = 0.3;

/** Put the map at `z`, then read the wash and the key the map drew for THAT zoom.
 *
 *  Two things this has to do rather than sleep. The page already opens at
 *  NATIONAL_ZOOM, so `setView(..., 4)` changed nothing, fired no `zoomend`, and made
 *  the map render nothing — the read below then landed on whatever the init render had
 *  left behind, and a fixed 1200 ms hid that it was never refreshed. So step OFF the
 *  target zoom first, and let the move onto it be a real transition. And a fixed sleep
 *  is a guess either way: on a loaded box the render can land after it, on an idle one
 *  it is a second of waiting for something already done. Wait for the condition — the
 *  map at `z`, the render it triggered finished, the key written — with a ceiling.
 *
 *  "The key written" is not enough on its own. The county geometry is its own later
 *  fetch, and until it lands the key honestly reads "<measure> (points)" for the dot
 *  fallback (quiet-corners.js renderLegend). CI caught that read once on a loaded
 *  runner (#595). The counties pane stays empty until the first county layer is added
 *  to it, and the key is refreshed in the same synchronous pass that adds it
 *  (quiet-corners.js, the topo branch through `legendRefresh()`), so a non-empty pane
 *  means the key read below is the one drawn against the geometry. */
const atZoom = (z) => `(async () => {
  const map = window.qcMap;
  if (!map) return { error: 'window.qcMap is not exposed' };
  // County score is opt-in and off by default; this file is about the wash and the
  // key that describe it, both of which the map no longer draws until asked. Turn
  // it on the same way the Field Maps Layers panel does, so what these probes read
  // is the ranking they are testing rather than the "turn it on" administrative key.
  if (window.qcSetScoresSurface) window.qcSetScoresSurface(true);
  let zoomends = 0;
  map.on('zoomend', () => { zoomends++; });
  const CENTER = [44.5, -89.5];
  if (map.getZoom() === ${z}) map.setView(CENTER, ${z} - 1, { animate: false });
  map.setView(CENTER, ${z}, { animate: false });
  const key = () => document.querySelector('.qc-legend-title');
  const countiesDrawn = () => {
    const p = document.querySelector('.leaflet-qc-counties-pane');
    return !!p && p.childElementCount > 0;
  };
  let settled = false;
  for (let i = 0; i < 200 && !settled; i++) {
    const t = key();
    settled = zoomends > 0 && map.getZoom() === ${z} && countiesDrawn()
      && !!t && !!t.textContent.trim();
    if (!settled) await new Promise(r => setTimeout(r, 50));
  }
  const pane = document.querySelector('.leaflet-qc-counties-pane');
  const title = key();
  const sel = document.getElementById('qc-color-by');
  const chosen = sel && sel.selectedOptions[0];
  return {
    zoom: map.getZoom(),
    zoomends,
    settled,
    pane: !!pane,
    opacity: pane ? parseFloat(getComputedStyle(pane).opacity) : null,
    legend: title ? title.textContent.trim() : null,
    colorBy: chosen ? chosen.textContent.trim() : null,
  };
})()`;

/** Opens the dashboard, runs one probe expression once the map exists, closes up. */
async function probe(expression) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, `${site.origin}/quiet-corners/`, {
    viewport: { width: 1440, height: 1000 }, args: ['--hide-scrollbars'],
  });
  try {
    // The map is what this file measures, not the towns export, so it waits for
    // the map alone -- but it waits loudly. Twelve seconds and a quiet `false`
    // was how a loaded box turned into "window.qcMap is not exposed", which
    // accuses the page of never exposing what it had not yet built.
    await readyDashboard(page, { data: false });
    return await page.evaluate(expression);
  } finally { page.close(); await site.close(); }
}

async function seen(z) {
  const seenAt = await probe(atZoom(z));
  assert.equal(seenAt.error, undefined, seenAt.error);
  // Say THIS rather than let a half-built page answer a question about the key: a
  // probe that timed out is a measurement that was never taken, and asserting on
  // one is how a green run and a red run stop meaning different things.
  assert.ok(seenAt.settled,
    `the map never settled at zoom ${z}: reached ${seenAt.zoom} after ${seenAt.zoomends} `
    + `zoomend(s), key ${JSON.stringify(seenAt.legend)}`);
  return seenAt;
}

test('the county wash gets out of the way of the topographic base at field zoom', { skip }, async () => {
  const near = await seen(FIELD_ZOOM);
  assert.equal(near.error, undefined, near.error);
  assert.equal(near.zoom, FIELD_ZOOM, `the map did not reach zoom ${FIELD_ZOOM}`);
  assert.ok(near.pane,
    'the county fills share the default overlayPane with everything else, so nothing '
    + 'can fade them on their own — give them a pane (.leaflet-qc-counties-pane)');
  assert.ok(near.opacity <= MAX_FIELD_FILL_OPACITY,
    `the county wash is still at ${near.opacity} at zoom ${FIELD_ZOOM}, above the `
    + `${MAX_FIELD_FILL_OPACITY} ceiling — the topo base is being read through it`);
});

test('the county wash is at full strength when counties are the subject', { skip }, async () => {
  const far = await seen(NATIONAL_ZOOM);
  assert.ok(far.pane, 'the county pane is missing at national zoom');
  assert.ok(far.opacity >= 0.9,
    `the county wash is only ${far.opacity} at zoom ${NATIONAL_ZOOM} — at national zoom `
    + 'the choropleth IS the map, and fading it there fixes nothing and costs the view');
});

test('the map key stops describing a comparison the reader has left', { skip }, async () => {
  const far = await seen(NATIONAL_ZOOM);
  const near = await seen(FIELD_ZOOM);
  // Not a fixed string: the Color by control chooses the measure, and the key has
  // to name whichever one is in force. Asserting they agree is the stronger claim.
  assert.ok(far.colorBy, 'the Color by control is missing from the dashboard');
  assert.ok(far.zoomends > 0,
    `the probe read the key at zoom ${NATIONAL_ZOOM} without ever making the map render it: `
    + 'the page already opens at that zoom, so setView changed nothing and fired no zoomend. '
    + 'Whatever the init render happened to leave behind is what this assertion is reading');
  // Both reads are of the zoom they claim to be of. Without this, a probe that ended up
  // somewhere else reports the key's disagreement instead of the view's.
  assert.equal(far.zoom, NATIONAL_ZOOM, 'the far probe did not end at national zoom');
  assert.equal(near.zoom, FIELD_ZOOM, 'the near probe did not end at field zoom');
  assert.equal(far.legend, far.colorBy,
    `at national zoom the key should name the measure the map is painting `
    + `(${JSON.stringify(far.colorBy)}), got ${JSON.stringify(far.legend)}`);
  assert.notEqual(near.legend, far.legend,
    `the key reads ${JSON.stringify(near.legend)} at zoom ${FIELD_ZOOM} as well as at `
    + `zoom ${NATIONAL_ZOOM} — at field zoom the county ranking is not what is on screen`);
});

// The window #595's CI run landed in, held open on purpose: counties-10m.json parked
// in flight, so the key is the dot fallback's "<measure> (points)". A probe that
// settles there is measuring the load order, not the key.
test('the zoom probe waits for the county geometry, not just for any key', { skip }, async () => {
  const site = await startSiteServer({ hold: /\/counties-10m\.json$/ });
  const page = await launch(CHROMIUM, `${site.origin}/quiet-corners/`, {
    viewport: { width: 1440, height: 1000 }, args: ['--hide-scrollbars'],
  });
  try {
    await readyDashboard(page, { data: false });
    const held = await page.evaluate(atZoom(NATIONAL_ZOOM));
    assert.equal(held.error, undefined, held.error);
    assert.equal(held.settled, false,
      `the probe settled while the county geometry was still in flight, on key ${JSON.stringify(held.legend)}`);
    site.release();
    const landed = await page.evaluate(atZoom(NATIONAL_ZOOM));
    assert.ok(landed.settled, `the probe never settled once the geometry landed (key ${JSON.stringify(landed.legend)})`);
    assert.equal(landed.legend, landed.colorBy);
  } finally { page.close(); await site.close(); }
});

// The zoom is not the only thing the key answers to. Its title is the label of
// whichever measure `Color by` has in force, so a reader who changes the measure
// without touching the map has changed what the key must say — and `zoomend`, the
// event the key is otherwise wired to, never fires for that. This is the reader
// doing it, through the control, with the map left where it was.
test('the map key names the measure the reader just chose, with no zoom to prompt it', { skip }, async () => {
  const r = await probe(`(async () => {
    const wait = (ms) => new Promise(res => setTimeout(res, ms));
    // Same opt-in as atZoom() above: this case is about the key tracking the chosen
    // measure, which only happens while scores are the surface on screen.
    if (window.qcSetScoresSurface) window.qcSetScoresSurface(true);
    const key = () => { const t = document.querySelector('.qc-legend-title'); return t ? t.textContent.trim() : null; };
    for (let i = 0; i < 200 && !key(); i++) await wait(50);
    const sel = document.getElementById('qc-color-by');
    if (!sel) return { error: 'the Color by control is missing from the dashboard' };
    let zoomends = 0;
    window.qcMap.on('zoomend', () => { zoomends++; });
    const before = { label: sel.selectedOptions[0].textContent.trim(), key: key() };
    const other = Array.from(sel.options).find(o => o.value !== sel.value);
    sel.value = other.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const want = other.textContent.trim();
    for (let i = 0; i < 100 && key() !== want; i++) await wait(50);
    return { before, chose: want, after: key(), zoom: window.qcMap.getZoom(), zoomends };
  })()`);
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.zoom, NATIONAL_ZOOM, 'this case is about a key that changes with the map standing still');
  assert.equal(r.zoomends, 0, 'the map moved, so this no longer proves the key refreshes without a zoom');
  assert.equal(r.before.key, r.before.label,
    `the key opened reading ${JSON.stringify(r.before.key)} while the map painted `
    + `${JSON.stringify(r.before.label)}`);
  assert.equal(r.after, r.chose,
    `the reader switched the map to ${JSON.stringify(r.chose)} and the key still reads `
    + `${JSON.stringify(r.after)} — it is naming a measure that is no longer on screen`);
});
