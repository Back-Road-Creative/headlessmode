// QQA-05r-2: road names on the screen map, proved in the real built page. What a pure test
// cannot: that the labels land in their own pane (z 405, no pointer events), lean along the
// road, are lettered at the label-size source, never sit under a town name, a GNIS name or a
// camera pin that is in the DOM, that a burst of pans asks the service once and the older
// request is aborted, that nothing is asked below zoom 10, and the three notes (partial, error,
// empty). The transportation service is answered from the sanitised Sylva fixture
// (fixtures/road-names-sylva.json, one live GET per layer); no request leaves the box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage, chooseExampleArea, watchTimers, timersIdle } from './helpers/waits.mjs';
import { PLACE_FEATURES } from './fixtures/gnis-names-declutter.mjs';
import { groupRoads } from '../../themes/headlessmode/static/js/quiet-corners-maps/road-names.js';
import { ROAD_DENSITY_CAP } from '../../themes/headlessmode/static/js/quiet-corners-maps/road-names.js';
import { VIEWPORT_FETCH } from '../../themes/headlessmode/static/js/quiet-corners-maps/app-state.js';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const CEILING = 20000;
// main.js ROAD_DEBOUNCE_MS: the trailing wait before a pan asks the road service. Every
// idle wait below watches timers of exactly this length, so the first test reads main.js
// for it: a changed constant fails there instead of leaving those waits true of any page.
const ROAD_DEBOUNCE_MS = 400;
const BURST_GAP_MS = 60;   // the gap between the pans of a burst: each lands inside the debounce of the last, which is the stimulus
const FIX = JSON.parse(readFileSync(new URL('./fixtures/road-names-sylva.json', import.meta.url), 'utf8'));
/** Every label the fixture could produce at zoom 13, from the same grouping the page uses. */
const KNOWN = new Set(groupRoads(Object.entries(FIX.layers).flatMap(([layer, body]) => body.features.map((f) => ({ ...f, layer: Number(layer) })))).map((e) => e.label));
const SYLVA = [35.375, -83.218, 13];
/** The app's example area (app-state.js EXAMPLE_AREA) is where the GNIS fixture's names sit; this moves the Sylva
 *  roads onto it so a name and a road can land on the same ground. */
const EXAMPLE_CENTRE = [35.05, -83.475];
const TO_EXAMPLE = [EXAMPLE_CENTRE[1] - SYLVA[1], EXAMPLE_CENTRE[0] - SYLVA[0]];
const labelsOf = (layers) => new Set(groupRoads(layers.flatMap((n) => FIX.layers[n].features.map((f) => ({ ...f, layer: Number(n) })))).map((e) => e.label));
/** Labels only a local road (layer 32) can produce. */
const LOCAL_ONLY = new Set([...labelsOf(['32'])].filter((l) => !labelsOf(['29', '30', '31', '35']).has(l)));

// The page's fetch: the transportation service is answered from the fixture in `window.__roadMode`
// ('ok' = every layer complete, 'partial' = the fixture as captured, 'error', 'empty', 'hang'),
// everything else (candidates.json and the rest) goes to the real, local server.
const PATCH_SOURCE = `(() => {
  const fix = ${JSON.stringify(FIX.layers)};
  const real = window.fetch.bind(window);
  window.__roadMode = 'ok'; window.__roadReqs = []; window.__roadShift = [0, 0];
  const names = { 3: ${JSON.stringify(PLACE_FEATURES)} };
  window.fetch = function(input, init) {
    const url = String(input && input.url ? input.url : input);
    // GNIS names (geonames service), answered from the synthetic declutter fixture; nothing leaves the box.
    // The NHD river tier is answered empty: these proofs are hermetic and about the GNIS names.
    if (/nhd\\/MapServer\\/\\d+\\/query/.test(url)) return Promise.resolve(new Response(JSON.stringify({ features: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const g = url.match(/geonames\\/MapServer\\/(\\d+)\\/query/);
    if (g) {
      const rows = names[g[1]] || [];
      return Promise.resolve(new Response(JSON.stringify(/returnCountOnly=true/.test(url) ? { count: rows.length } : { features: rows }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    const m = url.match(/transportation\\/MapServer\\/(\\d+)\\/query/);
    if (!m) return real(input, init);
    const signal = init && init.signal;
    window.__roadReqs.push({ layer: m[1], geometry: new URL(url).searchParams.get('geometry'), signal, at: performance.now() });
    const mode = window.__roadMode;
    const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
    if (mode === 'error') return json({ error: { code: 500, message: 'stubbed' } }, 500);
    if (mode === 'empty') return json({ features: [] });
    if (mode === 'hang') return new Promise((_, reject) => { if (signal) signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); });
    const body = fix[m[1]];
    const [dx, dy] = window.__roadShift;
    const moved = (f) => ({ ...f, geometry: { paths: f.geometry.paths.map((p) => p.map(([x, y]) => [x + dx, y + dy])) } });
    return json({ features: body.features.map(moved), ...(mode === 'partial' && body.exceededTransferLimit ? { exceededTransferLimit: true } : {}) });
  };
})()`;

async function withDashboard(fn) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', { viewport: { width: 1440, height: 1000 }, args: ['--hide-scrollbars'] });
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PATCH_SOURCE });
    // From the first script on, so a debounce a move arms is a timer the idle waits can see.
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: watchTimers(ROAD_DEBOUNCE_MS, VIEWPORT_FETCH.settleMs) });
    await page.navigate(`${site.origin}/quiet-corners/`);
    await readyDashboard(page, { ms: CEILING });
    return await fn(page);
  } finally { page.close(); await site.close(); }
}

const goTo = (page, [lat, lon, z]) => page.evaluate(`(async () => {
  const settled = qcMoves();
  window.qcMap.setView([${lat}, ${lon}], ${z}, { animate: false });
  await settled('the map settled at zoom ${z}');
  return true;
})()`);
const mode = (page, m) => page.evaluate(`(window.__roadMode = ${JSON.stringify(m)}, window.__roadReqs.length = 0, true)`);
const labelCount = (page) => page.evaluate("document.querySelectorAll('.qcm-road-label').length");
const waitLabels = (page, what, cond) => waitInPage(page, what, `(() => { const n = document.querySelectorAll('.qcm-road-label').length; return ${cond}; })()`, CEILING, null);
const note = (page) => page.evaluate(`(() => { const e = document.getElementById('qcm-layer-roads-report'); return e && !e.hidden ? e.textContent : ''; })()`);
// The road pass is idle once its debounce has run (its request, if any, is then made) or was
// never armed (the view gave it nothing to ask).
const roadsIdle = (page, what = 'the road debounce to have run or never to have been armed') => waitInPage(page, what, timersIdle(ROAD_DEBOUNCE_MS), CEILING, null);
const namesIdle = (page) => waitInPage(page, 'the names debounce to have run', timersIdle(VIEWPORT_FETCH.settleMs), CEILING, null);

test('the road debounce the idle waits watch is the one main.js arms', () => {
  const main = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
  assert.equal(Number(/const ROAD_DEBOUNCE_MS = (\d+);/.exec(main)?.[1]), ROAD_DEBOUNCE_MS, 'main.js ROAD_DEBOUNCE_MS moved: update ROAD_DEBOUNCE_MS here');
});

const READ = `(() => [...document.querySelectorAll('.qcm-road-label')].map((e) => {
  const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
  return { text: e.textContent, x: r.left, y: r.top, w: r.width, h: r.height, fontSize: parseFloat(cs.fontSize), transform: cs.transform };
}))()`;
const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

test('the row is registered on by default, and does not make the layer count lie', { skip }, async () => {
  await withDashboard(async (page) => {
    const row = await page.evaluate(`(() => { const c = document.getElementById('qcm-layer-roads'); return c && { checked: c.checked, label: c.closest('label').textContent.trim() }; })()`);
    assert.ok(row, 'a Road names checkbox is in the Layers panel');
    assert.equal(row.checked, true);
    assert.match(row.label, /^Road names/);
    assert.equal(await page.evaluate("document.getElementById('qcm-layer-count').textContent"), 'No layers on', 'a screen-only default does not count as a layer on');
  });
});

test('below zoom 10: no request at all and no labels', { skip }, async () => {
  await withDashboard(async (page) => {
    await goTo(page, [SYLVA[0], SYLVA[1], 9]);
    await roadsIdle(page);   // a request, if one were coming, is made when the debounce runs
    assert.equal(await page.evaluate('window.__roadReqs.length'), 0, 'zoom 9 asks the road service for nothing');
    assert.equal(await labelCount(page), 0);
  });
});

test('zoom 13: labels in their own pane, along the road, at the label-size source, clear of each other', { skip }, async () => {
  await withDashboard(async (page) => {
    await goTo(page, SYLVA);
    await waitLabels(page, 'road labels to draw', 'n > 0');
    const pane = await page.evaluate(`(() => { const cs = getComputedStyle(window.qcMap.getPane('qcm-roads')); return { z: cs.zIndex, events: cs.pointerEvents, inPane: [...document.querySelectorAll('.qcm-road-label')].every((e) => window.qcMap.getPane('qcm-roads').contains(e)) }; })()`);
    assert.equal(Number(pane.z), 405);
    assert.equal(pane.events, 'none');
    assert.equal(pane.inPane, true, 'every label is in pane qcm-roads');
    const labels = await page.evaluate(READ);
    assert.ok(labels.length <= ROAD_DENSITY_CAP.standard, `${labels.length} labels > the standard cap`);
    for (const l of labels) {
      assert.ok(KNOWN.has(l.text), `"${l.text}" is not a label the fixture can produce`);
      assert.equal(l.fontSize, 14, 'normal size paints at var(--qc-label-px)');
    }
    assert.ok(labels.some((l) => l.transform !== 'none' && l.transform !== 'matrix(1, 0, 0, 1, 0, 0)'), 'at least one label is turned along its road');
    for (let i = 0; i < labels.length; i += 1) for (let j = i + 1; j < labels.length; j += 1) {
      assert.ok(!overlaps(labels[i], labels[j]), `"${labels[i].text}" overlaps "${labels[j].text}"`);
    }
  });
});

test('a town name, a GNIS name or a camera pin in the DOM keeps road labels off it', { skip }, async () => {
  await withDashboard(async (page) => {
    await goTo(page, SYLVA);
    await waitLabels(page, 'road labels to draw', 'n > 0');
    const first = (await page.evaluate(READ))[0];
    // A camera pin dropped exactly on the first label, as a real pin would sit on a road. The
    // labels are re-placed from the held answer, which is what a size change does.
    await page.evaluate(`(() => {
      // Marked so the wait below can tell the labels re-placed from the held answer from these.
      document.querySelectorAll('.qcm-road-label').forEach((e) => e.setAttribute('data-stale', ''));
      const host = window.qcMap.getContainer(), origin = host.getBoundingClientRect();
      const pin = document.createElement('div'); pin.className = 'qcm-camera-pin'; pin.id = 'probe-pin';
      pin.style.cssText = 'position:absolute;z-index:700;left:${first.x - 4}px;top:${first.y - 4}px;width:${first.w + 8}px;height:${first.h + 8}px;';
      pin.style.left = (${first.x} - 4 - origin.left) + 'px'; pin.style.top = (${first.y} - 4 - origin.top) + 'px';
      host.append(pin);
      document.dispatchEvent(new CustomEvent('qc:label-prefs-changed', { detail: {} }));
    })()`);
    await waitLabels(page, 'the labels to be re-placed around the pin', "n > 0 && !document.querySelector('.qcm-road-label[data-stale]')");
    const pin = await page.evaluate("(() => { const r = document.getElementById('probe-pin').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()");
    const after = await page.evaluate(READ);
    assert.ok(after.length > 0, 'the other roads are still lettered');
    for (const l of after) assert.ok(!overlaps(l, pin), `"${l.text}" was drawn under the camera pin`);
    // And a dashboard town label is a reserved box too: none of the labels sits under one.
    for (const t of await page.evaluate("[...document.querySelectorAll('.qc-place-label')].map((e) => { const r = e.getBoundingClientRect(); return { text: e.textContent, x: r.left, y: r.top, w: r.width, h: r.height }; })")) {
      for (const l of after) assert.ok(!overlaps(l, t), `"${l.text}" overlaps the town label "${t.text}"`);
    }
  });
});

test('a burst of pans asks once, for the last view; an older request is aborted', { skip }, async () => {
  await withDashboard(async (page) => {
    await mode(page, 'hang');
    await goTo(page, SYLVA);
    await waitInPage(page, 'the first (hung) request', 'window.__roadReqs.length >= 5', CEILING, null);
    const firstBatch = await page.evaluate('window.__roadReqs.length');
    // Five quick moves, each inside the 400 ms debounce of the last.
    await page.evaluate(`(async () => {
      for (let i = 1; i <= 5; i += 1) { window.qcMap.setView([${SYLVA[0]} + i * 0.002, ${SYLVA[1]}], ${SYLVA[2]}, { animate: false }); await new Promise((r) => setTimeout(r, ${BURST_GAP_MS})); }
    })()`);
    await waitInPage(page, 'the one batch of requests for the burst', `window.__roadReqs.length >= ${firstBatch + 5}`, CEILING, null);
    await roadsIdle(page);   // and no second batch is armed behind it
    const reqs = await page.evaluate('window.__roadReqs.map((r) => ({ layer: r.layer, geometry: r.geometry, aborted: r.signal.aborted }))');
    const after = reqs.slice(firstBatch);
    assert.equal(after.length, 5, `one batch (5 layers at zoom 13) for the whole burst, got ${after.length}`);
    assert.equal(new Set(after.map((r) => r.geometry)).size, 1, 'every layer of that batch asks about the same, final view');
    assert.ok(reqs.slice(0, firstBatch).every((r) => r.aborted), 'the request that was in flight was aborted by the newer one');
  });
});

test('a small pan inside the fetched margin asks for nothing and keeps drawing', { skip }, async () => {
  await withDashboard(async (page) => {
    await goTo(page, SYLVA);
    await waitLabels(page, 'road labels to draw', 'n > 0');
    const before = await page.evaluate('window.__roadReqs.length');
    // A quarter of the view's height is inside the 30% margin the fetch added on every side.
    await page.evaluate(`(() => { const m = window.qcMap; m.panBy([0, -Math.round(m.getSize().y / 4)], { animate: false }); })()`);
    await roadsIdle(page);
    assert.equal(await page.evaluate('window.__roadReqs.length'), before, 'a pan inside the fetched box made a request');
    await waitLabels(page, 'labels after the pan', 'n > 0');
  });
});

test('notes: partial says more roads, error keeps the labels and says so, empty says nothing', { skip }, async () => {
  await withDashboard(async (page) => {
    await mode(page, 'partial');
    await goTo(page, SYLVA);
    await waitLabels(page, 'labels from a partial answer', 'n > 0');
    await waitInPage(page, 'the partial note', "document.getElementById('qcm-layer-roads-report').textContent === 'More roads than shown'", CEILING, null);
    const kept = await labelCount(page);

    await mode(page, 'error');
    await goTo(page, [SYLVA[0] + 0.05, SYLVA[1], SYLVA[2]]);
    await waitInPage(page, 'the error note', "document.getElementById('qcm-layer-roads-report').textContent === 'Road names did not load'", CEILING, null);
    assert.ok(kept > 0 && (await labelCount(page)) > 0, 'a failed request keeps the last labels');

    await mode(page, 'empty');
    await goTo(page, [SYLVA[0] - 0.05, SYLVA[1], SYLVA[2]]);
    await waitLabels(page, 'an empty answer to clear the labels', 'n === 0');
    assert.equal(await note(page), '', 'empty is silent');
  });
});

test('the label-size and crowding prefs re-run the placement', { skip }, async () => {
  await withDashboard(async (page) => {
    await goTo(page, SYLVA);
    await waitLabels(page, 'road labels to draw', 'n > 0');
    await page.evaluate("window.qcSetLabelPrefs({ density: 'sparse', size: 'normal' })");
    await waitLabels(page, 'at most the sparse cap', `n > 0 && n <= ${ROAD_DENSITY_CAP.sparse}`);
    await page.evaluate("window.qcSetLabelPrefs({ density: 'standard', size: 'large' })");
    await waitInPage(page, 'labels at 18px', "(() => { const e = document.querySelector('.qcm-road-label'); return e && parseFloat(getComputedStyle(e).fontSize) === 18; })()", CEILING, null);
  });
});

test('the source credit is on the map while the row is on, and gone when it is off', { skip }, async () => {
  await withDashboard(async (page) => {
    const credit = "document.querySelector('.leaflet-control-attribution').textContent.includes('National Transportation Dataset')";
    await waitInPage(page, 'the road credit', credit, CEILING, null);
    await goTo(page, SYLVA);
    await waitLabels(page, 'road labels to draw', 'n > 0');
    await page.evaluate(`(() => { const c = document.getElementById('qcm-layer-roads'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitLabels(page, 'labels to clear', 'n === 0');
    await waitInPage(page, 'the credit to go', `!(${credit})`, CEILING, null);
    // Off means off: a further pan asks the service for nothing.
    const asked = await page.evaluate('window.__roadReqs.length');
    await goTo(page, [SYLVA[0] + 0.05, SYLVA[1], SYLVA[2]]);
    await roadsIdle(page);
    assert.equal(await page.evaluate('window.__roadReqs.length'), asked, 'a pan with the row off asks nothing');
  });
});

const alphaOf = (rgba) => { const m = /rgba?\(([^)]+)\)/.exec(rgba); const p = m ? m[1].split(',') : []; return p.length > 3 ? Number(p[3]) : 1; };

test('zoom 11 letters highway routes; the label sits on a plate of alpha >= 0.78', { skip }, async () => {
  await withDashboard(async (page) => {
    await goTo(page, [SYLVA[0], SYLVA[1], 11]);
    await waitLabels(page, 'road labels to draw', 'n > 0');
    const labels = await page.evaluate(READ);
    assert.ok(labels.some((l) => /^(US|NC) /.test(l.text)), `zoom 11 draws a "US " or "NC " route label, got ${JSON.stringify(labels.map((l) => l.text))}`);
    const bg = await page.evaluate("getComputedStyle(document.querySelector('.qcm-road-label')).backgroundColor");
    assert.ok(alphaOf(bg) >= 0.78, `road label plate ${bg} is under alpha 0.78`);
  });
});

test('zoom 13 letters at least one local road, not only highways', { skip }, async () => {
  await withDashboard(async (page) => {
    assert.ok(LOCAL_ONLY.size > 0, 'the fixture has local-road names no other layer carries');
    await goTo(page, SYLVA);
    await waitLabels(page, 'road labels to draw', 'n > 0');
    const drawn = (await page.evaluate(READ)).map((l) => l.text);
    assert.ok(drawn.some((t) => LOCAL_ONLY.has(t)), `no local road among ${JSON.stringify(drawn)}`);
  });
});

test('GNIS names drawn AFTER the roads (zoom 14) push road labels off them', { skip }, async () => {
  await withDashboard(async (page) => {
    await page.evaluate(`window.__roadShift = ${JSON.stringify(TO_EXAMPLE)}`);
    await chooseExampleArea(page);
    await goTo(page, [EXAMPLE_CENTRE[0], EXAMPLE_CENTRE[1], 14]);
    await waitLabels(page, 'road labels to draw over the example area', 'n > 0');
    const before = await labelCount(page);
    await page.evaluate(`(() => { const cb = document.getElementById('qcm-layer-names'); cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await page.evaluate("document.getElementById('qcm-check').click()");
    await waitInPage(page, 'GNIS name labels', "document.querySelectorAll('.qcm-name-label').length > 0", CEILING, null);
    // The roads are re-placed from the held answer once the names are on screen: poll until no
    // road label box meets a name label or a name glyph, then until both debounces have run, so
    // the state read below is the settled one and not a gap between two passes.
    const CLASH = `(() => {
      const box = (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
      const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
      const names = [...document.querySelectorAll('.qcm-name-label, .qcm-name-marker-glyph')].map(box).filter((b) => b.w > 0 && b.h > 0);
      return { names: names.length, roads: document.querySelectorAll('.qcm-road-label').length,
        clashes: [...document.querySelectorAll('.qcm-road-label')].map(box).filter((r) => names.some((n) => hit(r, n))).length };
    })()`;
    await waitInPage(page, 'no road label over a GNIS name', `(() => { const c = ${CLASH}; return c.names > 0 && c.roads > 0 && c.clashes === 0; })()`, CEILING, null);
    await roadsIdle(page);
    await namesIdle(page);
    const after = await page.evaluate(CLASH);
    assert.equal(after.clashes, 0, `${after.clashes} road labels sit on a GNIS name (${after.roads} roads, ${after.names} name boxes)`);
    assert.ok(after.roads > 0 && before > 0, 'roads are still lettered where there is room');
  });
});

test('a preset leaves Road names alone: it stays on, and no preview says it turns off', { skip }, async () => {
  await withDashboard(async (page) => {
    await goTo(page, SYLVA);
    await waitLabels(page, 'road labels to draw', 'n > 0');
    const previews = await page.evaluate("[...document.querySelectorAll('.qcm-preset-preview')].map((e) => e.textContent)");
    assert.ok(previews.length >= 6, 'every preset carries a preview line');
    for (const t of previews) assert.ok(!/Road names/.test(t), `a preview names Road names: ${t}`);
    await page.evaluate("document.getElementById('qcm-preset-mapOnly').click()");
    await roadsIdle(page);
    assert.equal(await page.evaluate("document.getElementById('qcm-layer-roads').checked"), true, 'a preset switched Road names off');
    await waitLabels(page, 'the road labels to be on the map after the preset', 'n > 0');
    assert.ok((await labelCount(page)) > 0, 'and the labels are still on the map');
  });
});

// QQA-05r-3: a road name reads as a road (amber) and never sits under a map control.
test('road labels are amber and none sits under a Leaflet control', { skip }, async () => {
  await withDashboard(async (page) => {
    await goTo(page, [SYLVA[0], SYLVA[1], 11]);
    await waitLabels(page, 'road labels to draw', 'n > 0');
    const color = await page.evaluate("getComputedStyle(document.querySelector('.qcm-road-label')).color");
    assert.equal(color, 'rgb(253, 230, 138)');
    const labels = await page.evaluate(READ);
    const controls = await page.evaluate("[...document.querySelectorAll('#qc-map .leaflet-control')].map((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }).filter((r) => r.w > 0 && r.h > 0)");
    assert.ok(controls.length > 0, 'the map has controls on screen');
    for (const l of labels) for (const c of controls) assert.ok(!overlaps(l, c), `"${l.text}" is drawn under a map control`);
  });
});

// Review: the key follows the row. A screen-only switch changes no recipe, so the key must read
// the controls, not the recipe's one-switch-behind layers.
test('switching Road names off takes the Road name row out of the key, and zoom 7 says zoom in', { skip }, async () => {
  await withDashboard(async (page) => {
    const keyRows = "[...document.querySelectorAll('#qcm-legend li')].map((li) => li.textContent)";
    await goTo(page, [SYLVA[0], SYLVA[1], 7]);
    assert.ok((await page.evaluate(keyRows)).some((t) => /Road name.*appears when you zoom in/.test(t)), 'zoom 7 key says the road names appear when you zoom in');
    await goTo(page, [SYLVA[0], SYLVA[1], 11]);
    await waitLabels(page, 'road labels to draw', 'n > 0');
    assert.ok((await page.evaluate(keyRows)).some((t) => /Road name/.test(t)), 'the key names Road name while the row is on');
    await page.evaluate(`(() => { const c = document.getElementById('qcm-layer-roads'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitLabels(page, 'labels to clear', 'n === 0');
    assert.ok(!(await page.evaluate(keyRows)).some((t) => /Road name/.test(t)), 'no key row reads Road name once the row is off');
  });
});

// Review: the contrast and forced-colour rules sat before the base rule and lost to it.
test('prefers-contrast and forced-colors change the road plate', { skip }, async () => {
  await withDashboard(async (page) => {
    await goTo(page, [SYLVA[0], SYLVA[1], 11]);
    await waitLabels(page, 'road labels to draw', 'n > 0');
    const css = () => page.evaluate("(() => { const cs = getComputedStyle(document.querySelector('.qcm-road-label')); return { color: cs.color, bg: cs.backgroundColor }; })()");
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-contrast', value: 'more' }] });
    let c = await css();
    assert.equal(c.color, 'rgb(255, 255, 255)');
    assert.equal(c.bg, 'rgb(0, 0, 0)');
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-contrast', value: 'no-preference' }, { name: 'forced-colors', value: 'active' }] });
    c = await css();
    assert.notEqual(c.color, 'rgb(253, 230, 138)', 'forced colors keeps the system palette, not the amber');
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'none' }] });
  });
});
