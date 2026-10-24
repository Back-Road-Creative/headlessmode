// U1 Undo/Reset proof, on the real built Quiet Corners dashboard (/quiet-corners/
// -- the Layers panel these buttons live in is only wired into that page's
// layout, quiet-corners-dashboard.html, never the Field Maps builder page; see
// layer-panel-browser.test.mjs's header for why a browser proof rather than
// a DOM-less one: applyPreset/undoPreset/resetPreset dispatch real 'change'
// events through layerRow's one hook, and disabled-state wiring on the two new
// buttons is exactly the kind of thing a pure-function test cannot see.
//
// Every fetch() this page could make is intercepted before the page's own
// script runs, the same minimal stub layer-panel-browser.test.mjs uses: the
// area-states lookup and the dashboard's own load-time fetches (counties.json
// and friends) each get a harmless empty body, since this proof exercises
// none of them.
//
// Proves brief-u1.md's task-3 claims: (1) Undo and Reset both start disabled,
// pressing a preset enables both; (2) Undo restores exactly the switches the
// last preset moved and is disabled again afterwards -- a second Undo does
// not go further back; (3) Reset returns every switch, the base map, the
// context surface and the two display overrides (highlight, hillshade light)
// to how the page opened, without moving the drawn area or the map.
//
// QQA-18b (Journey 11) adds the Check conditions proofs at the bottom: exactly which layers
// the preset turns on (and that the Active on map list names them), that Undo puts a prior,
// different state back, and that a share link written before the preset existed restores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { waitInPage, readyDashboard, chooseExampleArea } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const CEILING = 20000;

/** Installed on the page before its own script runs. Every request this
 *  proof could trigger gets a harmless empty body -- it never ticks a layer
 *  that fetches, so it never needs to tell one service call from another. */
const PATCH_SOURCE = `(() => {
  window.fetch = function() {
    return Promise.resolve(new Response('{}', {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
  };
})()`;

/** For the Check conditions proofs, which switch on the fire, smoke and air-quality services:
 *  an empty answer in each service's own shape (GeoJSON, or ArcGIS features), so a layer
 *  that fetches settles as "nothing here" instead of failing on a body it cannot read. */
const EMPTY_SERVICES_SOURCE = `(() => {
  window.fetch = function() {
    return Promise.resolve(new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
  };
})()`;

async function withPatchedFetch(fn, { hash = '', source = PATCH_SOURCE } = {}) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', {
    viewport: { width: 1280, height: 900 }, args: ['--hide-scrollbars'],
  });
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source });
    await page.navigate(`${site.origin}/quiet-corners/${hash}`);
    await readyDashboard(page, { data: false, ms: CEILING });
    return await fn(page);
  } finally { page.close(); await site.close(); }
}

// Eight presets: Undo and Reset left the grid for the layer count line, so the presets still
// fill two rows and the line does not grow past its own text at 1280px (main.js renderPresets).
test('the presets fill two grid rows and Undo/Reset sit on the layer count line', { skip }, async () => {
  await withPatchedFetch(async (page) => {
    const seen = await page.evaluate(`(() => {
      document.getElementById('qcm-layer-panel').open = true;
      const grid = document.getElementById('qcm-presets');
      const tops = [...grid.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().top));
      const row = document.querySelector('.qcm-layer-toolbar .qcm-layer-count-row');
      const h = (el) => Math.round(el.getBoundingClientRect().height);
      return {
        gridIds: [...grid.querySelectorAll('button')].map((b) => b.id),
        rows: new Set(tops).size,
        undoIn: document.getElementById('qcm-preset-undo').parentElement.id,
        resetIn: document.getElementById('qcm-preset-reset').parentElement.id,
        rowInToolbar: !!row && row.contains(document.getElementById('qcm-preset-actions')),
        rowH: row ? h(row) : 0, countH: h(document.getElementById('qcm-layer-count')),
      };
    })()`);
    assert.equal(seen.gridIds.length, 8, `expected the eight presets alone in the grid, got: ${seen.gridIds}`);
    assert.equal(seen.rows, 2, 'the eight presets should fill two rows of four');
    assert.equal(seen.undoIn, 'qcm-preset-actions');
    assert.equal(seen.resetIn, 'qcm-preset-actions');
    assert.equal(seen.rowInToolbar, true, 'Undo/Reset should sit on the count line inside the layer toolbar');
    assert.ok(seen.rowH <= seen.countH + 1,
      `the count line grew to ${seen.rowH}px around Undo/Reset, past its own ${seen.countH}px text`);
  });
});

test('Undo and Reset start disabled; pressing a preset enables both', { skip }, async () => {
  await withPatchedFetch(async (page) => {
    const before = await page.evaluate(`(() => ({
      undo: document.getElementById('qcm-preset-undo').disabled,
      reset: document.getElementById('qcm-preset-reset').disabled,
    }))()`);
    assert.equal(before.undo, true, 'Undo should start disabled -- nothing to undo yet');
    assert.equal(before.reset, true, 'Reset should start disabled -- nothing to reset yet');

    // mapOnly moves nothing from a fresh page (every overlay is already off, on the
    // default base) -- trailsTerrain is the one that actually has something to move.
    await page.evaluate("document.getElementById('qcm-preset-trailsTerrain').click()");
    const after = await page.evaluate(`(() => ({
      undo: document.getElementById('qcm-preset-undo').disabled,
      reset: document.getElementById('qcm-preset-reset').disabled,
    }))()`);
    assert.equal(after.undo, false, 'pressing a preset that moves something should enable Undo');
    assert.equal(after.reset, false, 'pressing a preset that moves something should enable Reset');
  });
});

test('Undo restores exactly what the last preset moved, once, then disables itself', { skip }, async () => {
  await withPatchedFetch(async (page) => {
    // Trails & terrain turns trails/names/hillshadeLight on. Names opens ON since N3
    // (layer-presets.js opensOn), so Undo is measured against the state the preset
    // found, not against a blank slate.
    const readSwitches = `(() => ({
      trails: document.getElementById('qcm-layer-trails').checked,
      names: document.getElementById('qcm-layer-names').checked,
      hillshadeLight: document.getElementById('qcm-context-hillshadeLight').checked,
    }))()`;
    const before = await page.evaluate(readSwitches);
    assert.deepEqual(before, { trails: false, names: true, hillshadeLight: false },
      'a fresh page has the names lettering on and nothing else the preset touches');
    await page.evaluate("document.getElementById('qcm-preset-trailsTerrain').click()");
    const moved = await page.evaluate(`(() => ({
      trails: document.getElementById('qcm-layer-trails').checked,
      names: document.getElementById('qcm-layer-names').checked,
      hillshadeLight: document.getElementById('qcm-context-hillshadeLight').checked,
    }))()`);
    assert.deepEqual(moved, { trails: true, names: true, hillshadeLight: true },
      'trailsTerrain should have turned its three switches on');

    await page.evaluate("document.getElementById('qcm-preset-undo').click()");
    const restored = await page.evaluate(`(() => ({
      trails: document.getElementById('qcm-layer-trails').checked,
      names: document.getElementById('qcm-layer-names').checked,
      hillshadeLight: document.getElementById('qcm-context-hillshadeLight').checked,
      undoDisabled: document.getElementById('qcm-preset-undo').disabled,
    }))()`);
    assert.deepEqual(
      { trails: restored.trails, names: restored.names, hillshadeLight: restored.hillshadeLight },
      before,
      'Undo should restore exactly the switches trailsTerrain moved',
    );
    assert.equal(restored.undoDisabled, true, 'Undo should read disabled again after one use');

    // A second Undo (were it not disabled) must not go further back: press it
    // anyway and confirm nothing moves, proving the one-shot contract rather
    // than only the button's own disabled attribute.
    await page.evaluate("document.getElementById('qcm-preset-undo').click()");
    const stillOff = await page.evaluate(`(() => ({
      trails: document.getElementById('qcm-layer-trails').checked,
      names: document.getElementById('qcm-layer-names').checked,
    }))()`);
    assert.deepEqual(stillOff, { trails: before.trails, names: before.names }, 'a second Undo must not move anything further');
  });
});

test('Reset returns switches, base and display overrides to opening state, and leaves the drawn area alone', { skip }, async () => {
  await withPatchedFetch(async (page) => {
    await chooseExampleArea(page);

    await page.evaluate("document.getElementById('qcm-preset-publicAccess').click()");
    // A highlight shortcut and a manual hillshade light are display overrides
    // Reset must also clear -- neither is a preset's to move, so pressing a
    // preset alone would leave them and Reset would fail its own copy.
    await page.evaluate("document.getElementById('qcm-highlight-trails').click()");

    const dirty = await page.evaluate(`(() => ({
      federalLand: document.getElementById('qcm-layer-federalLand').checked,
      base: document.querySelector('input[name="qcm-base"]:checked').id,
      spotlight: document.getElementById('qcm-highlight-trails').getAttribute('aria-pressed'),
      resetDisabled: document.getElementById('qcm-preset-reset').disabled,
    }))()`);
    assert.equal(dirty.federalLand, true, 'publicAccess should have turned federalLand on');
    assert.equal(dirty.spotlight, 'true', 'the trails highlight shortcut should read pressed');
    assert.equal(dirty.resetDisabled, false, 'Reset should read enabled once something has moved');

    const mapBefore = await page.evaluate(`(() => {
      const c = window.qcMap.getCenter();
      return { lat: c.lat, lng: c.lng, zoom: window.qcMap.getZoom() };
    })()`);

    await page.evaluate("document.getElementById('qcm-preset-reset').click()");
    await waitInPage(page, 'federalLand to read off after Reset',
      "document.getElementById('qcm-layer-federalLand').checked === false", CEILING, null);

    const clean = await page.evaluate(`(() => ({
      federalLand: document.getElementById('qcm-layer-federalLand').checked,
      base: document.querySelector('input[name="qcm-base"]:checked').id,
      context: document.querySelector('input[name="qcm-context"]:checked').id,
      spotlight: document.getElementById('qcm-highlight-trails').getAttribute('aria-pressed'),
      resetDisabled: document.getElementById('qcm-preset-reset').disabled,
      undoDisabled: document.getElementById('qcm-preset-undo').disabled,
    }))()`);
    assert.equal(clean.federalLand, false, 'Reset should turn federalLand back off');
    assert.equal(clean.base, 'qcm-base-usgsTopo', 'Reset should restore the default base map');
    assert.equal(clean.context, 'qcm-context-none', 'Reset should restore no context surface');
    assert.equal(clean.spotlight, 'false', 'Reset should clear the highlight shortcut');
    assert.equal(clean.resetDisabled, true, 'Reset should read disabled again once nothing is left to reset');
    assert.equal(clean.undoDisabled, true, 'Reset should also clear any pending Undo');

    const mapAfter = await page.evaluate(`(() => {
      const c = window.qcMap.getCenter();
      return { lat: c.lat, lng: c.lng, zoom: window.qcMap.getZoom() };
    })()`);
    assert.deepEqual(mapAfter, mapBefore, 'Reset must never move the map or touch the drawn area');
  });
});

// ---- QQA-18b: Check conditions -------------------------------------------------------------
const CONDITIONS = ['epaAirNowAqi', 'nifcFirePerimeters', 'noaaHmsSmoke', 'nwsRadar'];
// Road names and Named places open ON (layer-presets.js opensOn) and are lettering, not
// layers a reader switched on: the snapshot leaves them out, like the Active list does.
const LETTERING = ['names', 'roads'];

/** Every Layers-panel switch in one object, so "exactly which layers are on" is one deepEqual:
 *  the on layers by id (a context radio counts under its layer id, "None" and the base radios
 *  do not), plus the chosen base and context radio. */
const SNAPSHOT = `(() => ({
  on: [...document.querySelectorAll('#qcm-layers .qcm-layer-row input')]
    .filter((i) => i.checked && i.name !== 'qcm-base' && i.id !== 'qcm-context-none'
      && !${JSON.stringify(LETTERING)}.includes(i.value)).map((i) => i.value).sort(),
  base: document.querySelector('input[name="qcm-base"]:checked').id,
  context: document.querySelector('input[name="qcm-context"]:checked').id,
  active: [...document.querySelectorAll('#qcm-active-layers [data-active-layer]')].map((li) => li.getAttribute('data-active-layer')).sort(),
  undoDisabled: document.getElementById('qcm-preset-undo').disabled,
}))()`;
const activeIs = (ids) => `JSON.stringify([...document.querySelectorAll('#qcm-active-layers [data-active-layer]')]
  .map((li) => li.getAttribute('data-active-layer')).sort()) === ${JSON.stringify(JSON.stringify([...ids].sort()))}`;

test('Check conditions turns on exactly radar, air quality, smoke and fire perimeters, and the Active list names them', { skip }, async () => {
  await withPatchedFetch(async (page) => {
    const before = await page.evaluate(SNAPSHOT);
    assert.deepEqual(before.on, [], 'a fresh page has nothing on');
    assert.deepEqual(before.active, [], 'and an empty Active on map list');

    await page.evaluate("document.getElementById('qcm-preset-checkConditions').click()");
    await waitInPage(page, 'the Active on map list to name the preset\'s layers', activeIs(CONDITIONS), CEILING, null);
    const after = await page.evaluate(SNAPSHOT);
    assert.deepEqual(after.on, CONDITIONS, 'exactly the four weather layers are on -- not the flood zones, not another group');
    assert.equal(after.context, 'qcm-context-nwsRadar', 'radar is the one view-filling surface');
    assert.equal(after.base, 'qcm-base-usgsTopo');
    assert.deepEqual(after.active, CONDITIONS);
    assert.equal(after.undoDisabled, false);
    // The one-surface rule held in the real panel: the three others are checkboxes, not radios.
    const kinds = await page.evaluate(`['epaAirNowAqi', 'noaaHmsSmoke', 'nifcFirePerimeters'].map((id) => document.getElementById('qcm-layer-' + id).type)`);
    assert.deepEqual(kinds, ['checkbox', 'checkbox', 'checkbox']);
    assert.equal(await page.evaluate("document.getElementById('qcm-layer-femaNfhl').checked"), false);
  }, { source: EMPTY_SERVICES_SOURCE });
});

test('Check conditions replaces a different prior state, and Undo puts that state back', { skip }, async () => {
  await withPatchedFetch(async (page) => {
    // A prior state the preset must overwrite on every axis: an overlay it turns off, a raster
    // surface it swaps for radar, a base it changes, and one of its own overlays already on.
    await page.evaluate(`['qcm-layer-trails', 'qcm-layer-noaaHmsSmoke', 'qcm-context-nightLights', 'qcm-base-none']
      .forEach((id) => document.getElementById(id).click())`);
    const prior = await page.evaluate(SNAPSHOT);
    assert.deepEqual(prior.on, ['nightLights', 'noaaHmsSmoke', 'trails']);
    assert.equal(prior.base, 'qcm-base-none');

    await page.evaluate("document.getElementById('qcm-preset-checkConditions').click()");
    await waitInPage(page, 'the Active on map list to follow the preset', activeIs(CONDITIONS), CEILING, null);
    const applied = await page.evaluate(SNAPSHOT);
    assert.deepEqual(applied.on, CONDITIONS, 'trails and night lights went off; the four weather layers are on');
    assert.equal(applied.base, 'qcm-base-usgsTopo');

    await page.evaluate("document.getElementById('qcm-preset-undo').click()");
    await waitInPage(page, 'the Active on map list to follow Undo', activeIs(['nightLights', 'noaaHmsSmoke', 'trails']), CEILING, null);
    const undone = await page.evaluate(SNAPSHOT);
    assert.deepEqual({ ...undone, undoDisabled: prior.undoDisabled }, prior, 'Undo restores the prior layers, surface, base and Active list exactly');
    assert.equal(undone.undoDisabled, true, 'and is spent');
  }, { source: EMPTY_SERVICES_SOURCE });
});

test('a share link written before the weather preset existed still restores its layer set by id', { skip }, async () => {
  // A set the Public land preset leaves behind (preset-era layers only), as an old link carries it.
  const publicLand = ['blmRecSites', 'federalLand', 'mvum', 'recSites', 'surfaceOwnership', 'trails'];
  await withPatchedFetch(async (page) => {
    await waitInPage(page, 'the old link\'s layers on', `document.getElementById('qcm-layer-trails').checked && document.getElementById('qcm-layer-blmRecSites').checked`, CEILING, null);
    const s = await page.evaluate(SNAPSHOT);
    assert.deepEqual(s.on, publicLand);
    assert.equal(s.base, 'qcm-base-usgsTopo');
    assert.equal(s.undoDisabled, true, 'restoring a link is not a preset press, so there is nothing to Undo');
  }, { hash: `#map=v1&z=9&c=44.5,-89.5&b=usgsTopo&o=${publicLand.join(',')}` });

  // A weather set in the pre-QQA-06d shape: radar as `s=`, fire and air quality as `o=`.
  await withPatchedFetch(async (page) => {
    await waitInPage(page, 'the old weather link\'s layers on', `document.getElementById('qcm-context-nwsRadar').checked && document.getElementById('qcm-layer-nifcFirePerimeters').checked`, CEILING, null);
    const s = await page.evaluate(SNAPSHOT);
    assert.deepEqual(s.on, ['epaAirNowAqi', 'nifcFirePerimeters', 'nwsRadar']);
    // Pressing the preset on top of it adds only what is missing, and Undo takes only that back.
    await page.evaluate("document.getElementById('qcm-preset-checkConditions').click()");
    await waitInPage(page, 'smoke added', "document.getElementById('qcm-layer-noaaHmsSmoke').checked", CEILING, null);
    assert.deepEqual((await page.evaluate(SNAPSHOT)).on, CONDITIONS);
    await page.evaluate("document.getElementById('qcm-preset-undo').click()");
    await waitInPage(page, 'smoke removed again', "!document.getElementById('qcm-layer-noaaHmsSmoke').checked", CEILING, null);
    assert.deepEqual((await page.evaluate(SNAPSHOT)).on, ['epaAirNowAqi', 'nifcFirePerimeters', 'nwsRadar']);
  }, { hash: '#map=v1&z=9&c=44.5,-89.5&b=usgsTopo&s=nwsRadar&o=epaAirNowAqi,nifcFirePerimeters', source: EMPTY_SERVICES_SOURCE });
});
