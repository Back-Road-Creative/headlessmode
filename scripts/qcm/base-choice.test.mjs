// The base map can be unselected, in a real browser: four radios, and choosing one swaps
// the tiles under the county map. Skips like field-zoom.test.mjs when there is no
// Chromium or no built site. Tile <img> elements get their src when Leaflet places
// them, so this needs no network — nothing here waits for a tile to load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt() ? 'public/quiet-corners/ not built — run `hugo --configDir site-config --minify` first'
    : false;

const PROBE = `(async () => {
  const wait = async (ok) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise(r => setTimeout(r, 50)); return ok(); };
  await wait(() => window.qcMap && document.querySelectorAll('input[name="qcm-base"]').length);
  const map = window.qcMap;
  map.setView([44.5, -89.5], 10, { animate: false });
  const tiles = (s) => document.querySelectorAll('.leaflet-tile-pane img[src*="' + s + '"]').length;
  const radios = document.querySelectorAll('input[name="qcm-base"]').length;
  const topoFirst = await wait(() => tiles('USGSTopo') > 0);
  document.getElementById('qcm-base-none').click();
  const topoGone = await wait(() => tiles('USGSTopo') === 0);
  document.getElementById('qcm-base-usgsImagery').click();
  const imagery = await wait(() => tiles('USGSImageryOnly') > 0);
  return { radios, topoFirst, topoGone, imagery, zoom: map.getZoom() };
})()`;

test('the base map is a choice on screen: topo by default, none removes it, imagery draws', { skip }, async () => {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, `${site.origin}/quiet-corners/`, { viewport: { width: 1440, height: 1000 } });
  try {
    const r = await page.evaluate(PROBE);
    assert.equal(r.radios, 4, 'one radio per base: topo, imagery, relief, none');
    assert.equal(r.zoom, 10);
    assert.ok(r.topoFirst, 'a reader who never touches the control sees today’s topo');
    assert.ok(r.topoGone, '"No base map" left USGSTopo tiles on the map');
    assert.ok(r.imagery, 'choosing imagery drew no USGSImageryOnly tile');
  } finally { page.close(); await site.close(); }
});
