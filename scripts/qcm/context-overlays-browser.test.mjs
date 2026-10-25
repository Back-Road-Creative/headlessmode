// QQA-06d, in a real browser: vector context overlays (NIFC fire perimeters, air quality,
// smoke, ...) are independent checkboxes that coexist with the one exclusive raster surface,
// and a state saved before the split (a share link naming fire or air quality as its `s=`
// surface) still restores by the same stable layer id.
//
// The two services are stubbed at window.fetch before any page script runs, so the proof is
// offline and deterministic: what is asserted is what the page DRAWS on the map (Leaflet path
// layers carry their ink in `options.color`), not what it requested.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage } from './helpers/waits.mjs';
import { SERVICE as FIRE_SERVICE } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-fire.js';
import { SERVICE as AQI_SERVICE } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-aqi.js';
import { LAYER_BY_ID, CONTEXT_OVERLAY_IDS } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built — run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

// Any view's question to either service gets the stub's answer, whatever box it names.
const FIRE_URL = `${FIRE_SERVICE}/query`;
const AQI_URL = `${AQI_SERVICE}/query`;
const FIRE_INK = '#b4462e';
const AQI_INK = '#b08a3e';

// A wildfire perimeter and one air-quality record, shaped like the services' own answers.
const stubSource = `(() => {
  const realFetch = window.fetch.bind(window);
  const json = (body) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  window.fetch = function (input, init) {
    const url = String(input && input.url ? input.url : input);
    if (url.startsWith(${JSON.stringify(FIRE_URL)})) {
      return json({ type: 'FeatureCollection', features: [{ type: 'Feature',
        properties: { attr_IncidentTypeCategory: 'WF', poly_IncidentName: 'Test Fire', poly_GISAcres: 120,
          poly_PolygonDateTime: Date.now() - 3 * 86400000, attr_PercentContained: 10 },
        geometry: { type: 'Polygon', coordinates: [[[-89.6, 44.4], [-89.4, 44.4], [-89.4, 44.6], [-89.6, 44.6], [-89.6, 44.4]]] } }] });
    }
    if (url.startsWith(${JSON.stringify(AQI_URL)})) {
      return json({ features: [{ attributes: { OBJECTID: 1, Id: 1, gridcode: 3, Unixtime: Math.floor(Date.now() / 1000), Timestamp: Date.now() } }] });
    }
    return realFetch(input, init);
  };
})()`;

let shared = null;
async function sharedSite() {
  if (!shared) {
    const site = await startSiteServer();
    const page = await launch(CHROMIUM, 'about:blank', { viewport: { width: 1280, height: 900 } });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: stubSource });
    shared = { site, page };
  }
  return shared;
}
after(async () => {
  if (!shared) return;
  shared.page.close();
  await shared.site.close();
});

const CENTER = 'window.qcMap.setView([44.5, -89.5], 9, { animate: false }); void 0;';
async function freshPage(hash = '') {
  const { site, page } = await sharedSite();
  // A hash-only change is a same-document navigation (no load event), and the view state is read
  // once at start-up, so every page starts from a blank document.
  await page.navigate('about:blank');
  await page.navigate(`${site.origin}/quiet-corners/${hash}`);
  await readyDashboard(page, { data: false });
  await page.evaluate(CENTER);
  return page;
}

// What is on the map right now, by ink: a path layer a Leaflet group added, still attached.
const drawn = (ink) => `(() => { let n = 0;
  window.qcMap.eachLayer((l) => { if (l.options && l.options.color === ${JSON.stringify(ink)} && l._map) n++; });
  return n; })()`;
const lightsDrawn = "document.querySelectorAll('.leaflet-tile-pane img[src*=\"VIIRS_Black_Marble\"]').length";
const state = `(() => ({
  radio: (document.querySelector('input[name="qcm-context"]:checked') || {}).value || null,
  fire: document.getElementById('qcm-layer-nifcFirePerimeters').checked,
  aqi: document.getElementById('qcm-layer-epaAirNowAqi').checked,
}))()`;
const click = (id) => `document.getElementById(${JSON.stringify(id)}).click(); void 0;`;

test('fire perimeters and air quality are independent checkboxes in the context group', { skip }, async () => {
  const page = await freshPage();
  const r = await page.evaluate(`(() => {
    const el = (id) => document.getElementById(id);
    const group = [...document.querySelectorAll('.qcm-layer-group')].find((g) => g.getAttribute('aria-label') === 'Land, sky & light context');
    return { fireType: el('qcm-layer-nifcFirePerimeters').type, aqiType: el('qcm-layer-epaAirNowAqi').type,
      fireInGroup: group.contains(el('qcm-layer-nifcFirePerimeters')), aqiInGroup: group.contains(el('qcm-layer-epaAirNowAqi')),
      noFireRadio: !el('qcm-context-nifcFirePerimeters'), noAqiRadio: !el('qcm-context-epaAirNowAqi'),
      radios: [...document.querySelectorAll('input[name="qcm-context"]')].map((x) => x.value) };
  })()`);
  assert.equal(r.fireType, 'checkbox');
  assert.equal(r.aqiType, 'checkbox');
  assert.ok(r.fireInGroup && r.aqiInGroup, 'the overlays stay in the context group, not a new top-level group');
  assert.ok(r.noFireRadio && r.noAqiRadio, 'a vector overlay must not also be a radio');
  assert.ok(r.radios.includes('none') && r.radios.includes('nightLights'), 'the raster surfaces are still the radio choice');
  assert.ok(!r.radios.includes('nifcFirePerimeters') && !r.radios.includes('epaAirNowAqi'));
});

test('fire + air quality are drawn together, and a raster surface does not take either away', { skip }, async () => {
  const page = await freshPage();
  await page.evaluate(click('qcm-layer-nifcFirePerimeters'));
  await waitInPage(page, 'the fire perimeter drawn', `${drawn(FIRE_INK)} > 0`, 20000, null);
  await page.evaluate(click('qcm-layer-epaAirNowAqi'));
  await waitInPage(page, 'the air-quality box drawn', `${drawn(AQI_INK)} > 0`, 20000, null);
  assert.ok(await page.evaluate(`${drawn(FIRE_INK)} > 0`), 'turning air quality on took the fire perimeters off');
  assert.deepEqual(await page.evaluate(state), { radio: 'none', fire: true, aqi: true });

  // The exclusive raster group is untouched: choosing a surface keeps both overlays.
  await page.evaluate(click('qcm-context-nightLights'));
  await waitInPage(page, 'the night-lights tiles', `${lightsDrawn} > 0`, 20000, null);
  assert.ok(await page.evaluate(`${drawn(FIRE_INK)} > 0 && ${drawn(AQI_INK)} > 0`), 'a raster surface removed an overlay');
  assert.deepEqual(await page.evaluate(state), { radio: 'nightLights', fire: true, aqi: true });
  const caption = await page.evaluate("document.getElementById('qcm-surface-caption').textContent");
  assert.ok(caption.includes(LAYER_BY_ID.nightLights.label), 'the surface still names itself');
  assert.ok(caption.includes(LAYER_BY_ID.nifcFirePerimeters.label), 'the overlay on the map names itself too');

  // None clears the raster only.
  await page.evaluate(click('qcm-context-none'));
  await waitInPage(page, 'the lights gone', `${lightsDrawn} === 0`, 20000, null);
  assert.ok(await page.evaluate(`${drawn(FIRE_INK)} > 0 && ${drawn(AQI_INK)} > 0`), '"No context surface" cleared the overlays');

  // Each overlay goes off by itself.
  await page.evaluate(click('qcm-layer-nifcFirePerimeters'));
  await waitInPage(page, 'the fire perimeter removed', `${drawn(FIRE_INK)} === 0`, 20000, null);
  assert.ok(await page.evaluate(`${drawn(AQI_INK)} > 0`), 'turning fire off took air quality with it');
});

test('a link saved before the split restores by stable id: fire or air quality named as the surface', { skip }, async () => {
  for (const [id, key, ink] of [['nifcFirePerimeters', 'fire', FIRE_INK], ['epaAirNowAqi', 'aqi', AQI_INK]]) {
    const page = await freshPage(`#map=v1&z=9&c=44.5,-89.5&b=usgsTopo&s=${id}`);
    await waitInPage(page, `${id} switched on from the old link`, `document.getElementById('qcm-layer-${id}').checked`, 20000, null);
    const s = await page.evaluate(state);
    assert.equal(s[key], true, `an old link naming ${id} as its surface did not turn it on`);
    assert.equal(s.radio, 'none', 'the radio group is a raster choice only; the overlay is not in it');
    await waitInPage(page, `${id} drawn`, `${drawn(ink)} > 0`, 20000, null);
  }
});

test('a saved raster surface still selects that raster, and a new link can hold a raster plus overlays', { skip }, async () => {
  const old = await freshPage('#map=v1&z=9&c=44.5,-89.5&b=none&s=nightLights');
  await waitInPage(old, 'night lights chosen from the old link', "document.getElementById('qcm-context-nightLights').checked", 20000, null);
  assert.deepEqual(await old.evaluate(state), { radio: 'nightLights', fire: false, aqi: false });

  const page = await freshPage('#map=v1&z=9&c=44.5,-89.5&b=none&s=nightLights&o=nifcFirePerimeters,epaAirNowAqi');
  await waitInPage(page, 'all three restored', "document.getElementById('qcm-layer-epaAirNowAqi').checked && document.getElementById('qcm-layer-nifcFirePerimeters').checked", 20000, null);
  assert.deepEqual(await page.evaluate(state), { radio: 'nightLights', fire: true, aqi: true });
  await waitInPage(page, 'both overlays drawn beside the lights', `${drawn(FIRE_INK)} > 0 && ${drawn(AQI_INK)} > 0 && ${lightsDrawn} > 0`, 20000, null);
});

test('Reset clears the raster surface and the overlays together', { skip }, async () => {
  const page = await freshPage();
  await page.evaluate(click('qcm-layer-nifcFirePerimeters') + click('qcm-context-nightLights'));
  await page.evaluate(click('qcm-preset-reset'));
  assert.deepEqual(await page.evaluate(state), { radio: 'none', fire: false, aqi: false });
  await waitInPage(page, 'the fire perimeter removed', `${drawn(FIRE_INK)} === 0`, 20000, null);
});

// The caption is one line per thing on the map, in a box with a ceiling: a surface plus all six
// overlays used to be one run-on paragraph of ten-odd lines floated over the map.
const CAPTION_BUDGET_PX = 160;
test('the caption with every overlay on is one line each and stays inside its height budget', { skip }, async () => {
  const { page } = await sharedSite();
  for (const vp of [{ width: 390, height: 844, mobile: true }, { width: 1280, height: 900 }]) {
    await page.setViewport(vp);
    const fresh = await freshPage();
    await fresh.evaluate(`(() => {
      for (const id of ${JSON.stringify(CONTEXT_OVERLAY_IDS)}) { const el = document.getElementById('qcm-layer-' + id); if (el && !el.disabled && !el.checked) el.click(); }
      document.getElementById('qcm-context-nightLights').click();
    })()`);
    const want = await fresh.evaluate(`1 + ${JSON.stringify(CONTEXT_OVERLAY_IDS)}.filter((id) => { const el = document.getElementById('qcm-layer-' + id); return el && el.checked; }).length`);
    assert.ok(want >= 3, `${vp.width}px: too few overlays could be switched on (${want}) for this to prove anything`);
    await waitInPage(fresh, 'every caption line', `document.querySelectorAll('#qcm-surface-caption .qcm-surface-caption-line').length === ${want}`, 20000, null);
    const m = await fresh.evaluate(`(() => { const el = document.getElementById('qcm-surface-caption');
      const lines = [...el.querySelectorAll('.qcm-surface-caption-line')];
      return { height: el.getBoundingClientRect().height, blocks: lines.every((l) => getComputedStyle(l).display === 'block'),
        scrolls: getComputedStyle(el).overflowY, live: el.getAttribute('aria-live') }; })()`);
    assert.ok(m.blocks, `${vp.width}px: each caption entry must be on its own line`);
    assert.ok(m.height <= CAPTION_BUDGET_PX, `${vp.width}px: caption is ${m.height}px tall with everything on; budget ${CAPTION_BUDGET_PX}px`);
    assert.equal(m.scrolls, 'auto', `${vp.width}px: a caption capped in height must scroll, not clip`);
  }
  await page.setViewport({ width: 1280, height: 900 });
});
