// The context surfaces are a choice of ONE, in a real browser. Four checkboxes let a
// reader stack four opaque rasters over the map and nothing stopped it; the group's own
// hint said "One continuous-colour surface laid over the map" the whole time.
//
// Same shape as base-choice.test.mjs, and offline for the same reason: Leaflet writes a
// tile's src when it places it, so counting <img> elements needs no network. Only the
// night-lights surface is tile-based, which is why it is the one asserted on the map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { CONTEXT_LAYER_IDS } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt() ? 'public/quiet-corners/ not built — run `hugo --configDir site-config --minify` first'
    : false;

const PROBE = `(async () => {
  const wait = async (ok) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise(r => setTimeout(r, 50)); return ok(); };
  await wait(() => window.qcMap && document.querySelectorAll('input[name="qcm-context"]').length);
  window.qcMap.setView([44.5, -89.5], 10, { animate: false });
  const radios = [...document.querySelectorAll('input[name="qcm-context"]')];
  const lights = () => document.querySelectorAll('.leaflet-tile-pane img[src*="VIIRS_Black_Marble"]').length;
  const caption = () => { const el = document.getElementById('qcm-surface-caption');
    return el && !el.hidden ? el.textContent : null; };
  const before = { count: radios.length, ids: radios.map(r => r.id), onAtRest: radios.filter(r => r.checked).map(r => r.value),
    lights: lights(), caption: caption() };
  document.getElementById('qcm-context-nightLights').click();
  const drawn = await wait(() => lights() > 0);
  const onlyOne = radios.filter(r => r.checked).length;
  const named = caption();
  // Every other surface is now unreachable without giving this one up: that is the point.
  document.getElementById('qcm-context-nwsRadar').click();
  const lightsGone = await wait(() => lights() === 0);
  document.getElementById('qcm-context-none').click();
  const off = radios.filter(r => r.checked).map(r => r.value);
  return { before, drawn, onlyOne, named, lightsGone, off, captionOff: caption() };
})()`;

test('the context group is one surface at a time: None at rest, one drawn, and a way back out', { skip }, async () => {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, `${site.origin}/quiet-corners/`, { viewport: { width: 390, height: 844 } });
  try {
    const r = await page.evaluate(PROBE);
    // One radio per registered surface, plus an explicit None -- DERIVED rather than typed.
    // Four units added surfaces in parallel and each had to rewrite one hand-kept total here,
    // so four branches sharing no logic all rewrote this line and no two of them could merge.
    // What it proves is unchanged: the BROWSER must render exactly the group the registry
    // declares, so a surface that silently drops out of the rendered group still fails here.
    // A surface leaving the REGISTRY is a different regression, and the surface's own test
    // is what catches that.
    assert.equal(r.before.count, CONTEXT_LAYER_IDS.length + 1,
      `the page drew ${r.before.count} radios for ${CONTEXT_LAYER_IDS.length} registered surfaces plus None`);
    assert.ok(r.before.ids.includes('qcm-context-none'), 'turning them all off has to be reachable');
    assert.deepEqual(r.before.onAtRest, ['none'], 'a reader who opens the page has no surface over the map');
    assert.equal(r.before.lights, 0);
    assert.equal(r.before.caption, null, 'nothing is captioned while nothing is drawn');
    assert.ok(r.drawn, 'choosing night lights drew no VIIRS tile');
    assert.equal(r.onlyOne, 1, 'more than one context surface was on at once');
    assert.match(String(r.named), /Vintage 2016/, 'the drawn surface must name itself and its own time');
    assert.ok(r.lightsGone, 'choosing radar left the night-lights tiles stacked underneath it');
    assert.deepEqual(r.off, ['none'], '"No context surface" left one on');
    assert.equal(r.captionOff, null, 'the caption outlived the surface it described');
  } finally { page.close(); await site.close(); }
});
