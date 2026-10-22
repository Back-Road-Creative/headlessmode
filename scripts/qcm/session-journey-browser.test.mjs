// QC-E3 (journey J11): one reader's session, start to reload, in one browser.
//
// The other 3D proofs each start fresh and drive the map through its API (jumpTo).
// This one walks the path a reader takes with the page's own controls, in order, and
// checks each hand-off keeps what the reader built:
//   2D: draw the example area, turn trails and Forest Service roads on, check them;
//   3D: open it, drag to pan, Tilt up, inspect the trail under a point, North up, close
//       (focus back on the 3D button);
//   2D: turn the roads off; 3D again: the roads are gone from the drape, trails stay;
//   reload: the drawn area comes back (the saved job), and 3D opens over it again.
// Layer choices are not saved across a reload (the saved job is the print area only:
// sheet-plan.js serializeRecipe), so the reload step asserts the area, not the layers.
//
// The DEM and the trail and road answers are the steep-relief stubs
// (helpers/relief-session.mjs); every other host is refused and must stay unasked.
// With QCM_SHOT_DIR set, each 3D state is saved there as a JPEG (pr-ci.yml uploads them
// when the job passes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findChromium } from './helpers/browser.mjs';
import { connectSession } from './helpers/cdp-session.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage } from './helpers/waits.mjs';
import { SLOW, stubNetwork, loadWithRoutes, openTerrain, closeTerrain, tick } from './helpers/relief-session.mjs';
import { SUMMIT, TRAILS, MVUM_ROAD } from './fixtures/relief-3d.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built — run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const AT = TRAILS.find((t) => t.id === 'fx-at-standing-indian');
const SHOT_DIR = process.env.QCM_SHOT_DIR || '';

async function shot(session, name) {
  if (!SHOT_DIR) return;
  mkdirSync(SHOT_DIR, { recursive: true });
  const { data } = await session.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 });
  writeFileSync(join(SHOT_DIR, `j11-${name}.jpg`), Buffer.from(data, 'base64'));
}

const camera = `(() => { const m = window.qcTerrainView.inspect(); const c = m.getCenter();
  return { lng: c.lng, lat: c.lat, pitch: m.getPitch(), bearing: m.getBearing() }; })()`;
const idle = `new Promise((res, rej) => { const m = window.qcTerrainView.inspect();
  const t = setTimeout(() => rej(new Error('3D map never went idle')), 100000);
  m.once('idle', () => { clearTimeout(t); res(true); }); m.triggerRepaint(); })`;
const drapeSources = `[...new Set(window.qcTerrainView.inspect().getStyle().layers
  .filter((l) => l.id.startsWith('qc-drape-')).map((l) => l.source))]`;
const pressButton = (text) => `(() => { const b = [...document.querySelectorAll('.qc-terrain-controls button')]
  .find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`;
const canvasBox = `(() => { const r = document.querySelector('.qc-terrain-dialog canvas').getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`;
const readArea = `(() => ({ title: document.getElementById('qcm-title').value,
  minLon: Number(document.getElementById('qcm-min-lon').value), maxLat: Number(document.getElementById('qcm-max-lat').value) }))()`;
// Ids of the route features queryRenderedFeatures finds within 4 px of each projected
// vertex of the Appalachian Trail: what a pointer over the line would pick up.
const inspectAT = `(() => { const m = window.qcTerrainView.inspect();
  const lines = m.getStyle().layers.filter((l) => l.id.startsWith('qc-drape-') && l.type === 'line').map((l) => l.id);
  const { width, height } = m.getCanvas().getBoundingClientRect(); const hits = [];
  for (const ll of ${JSON.stringify(AT.paths[0])}) { const p = m.project(ll);
    if (p.x < 8 || p.y < 8 || p.x > width - 8 || p.y > height - 8) continue;
    for (const f of m.queryRenderedFeatures([[p.x - 4, p.y - 4], [p.x + 4, p.y + 4]], { layers: lines })) hits.push(f.properties.id); }
  return hits; })()`;
const untick = (id) => `(() => { const cb = document.getElementById('${id}'); cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true })); })()`;
const pathLabels = `[...document.querySelectorAll('#qc-map .leaflet-overlay-pane path[aria-label]')].map((p) => p.getAttribute('aria-label'))`;

async function drag(session, from, to) {
  const mouse = (type, p, buttons) => session.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons, clickCount: 1 });
  await mouse('mouseMoved', from, 0);
  await mouse('mousePressed', from, 1);
  for (let i = 1; i <= 8; i++) await mouse('mouseMoved', { x: from.x + ((to.x - from.x) * i) / 8, y: from.y + ((to.y - from.y) * i) / 8 }, 1);
  await mouse('mouseReleased', to, 0);
}

test('J11: a reader goes 2D layers → 3D pan, tilt, inspect → layer toggle → reload, and each step keeps what came before', { skip }, async () => {
  const site = await startSiteServer();
  const docUrl = `${site.origin}/quiet-corners/`;
  const session = await connectSession();
  try {
    const { refused } = await stubNetwork(session, { docUrl, siteOrigin: site.origin });

    // 2D: area drawn, trails and roads switched on and back from their adapters.
    await loadWithRoutes(session, docUrl);
    const area = await session.evaluate(readArea);
    const twoD = await session.evaluate(pathLabels);
    assert.ok(twoD.some((l) => l.startsWith(`${AT.name} —`)), `2D draws no "${AT.name}" (has ${JSON.stringify(twoD)})`);
    assert.ok(twoD.some((l) => l.startsWith(`${MVUM_ROAD.name} —`)), `2D draws no "${MVUM_ROAD.name}"`);

    // 3D opens over the same area with both layers draped.
    await openTerrain(session);
    assert.deepEqual((await session.evaluate(drapeSources)).filter((s) => /trails|mvum/.test(s)).sort(), ['qc-drape-mvum', 'qc-drape-trails'],
      '3D did not drape the two layers the reader turned on in 2D');
    const summit = await session.evaluate(`window.qcTerrainView.inspect().queryTerrainElevation([${SUMMIT.lon}, ${SUMMIT.lat}])`);
    assert.ok(summit >= 1700, `3D is not over the drawn area's relief (summit ${summit} m)`);
    await shot(session, '3d-open');

    // Pan with a pointer drag on the canvas.
    const c0 = await session.evaluate(camera);
    const box = await session.evaluate(canvasBox);
    const mid = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    await drag(session, mid, { x: mid.x - 160, y: mid.y + 60 });
    await session.evaluate(idle, { timeoutMs: SLOW });
    const c1 = await session.evaluate(camera);
    assert.ok(Math.abs(c1.lng - c0.lng) + Math.abs(c1.lat - c0.lat) > 1e-4, `a drag did not pan 3D (${JSON.stringify(c0)} → ${JSON.stringify(c1)})`);

    // Tilt up twice with the dialog's own button.
    assert.ok(await session.evaluate(pressButton('Tilt up')), 'no Tilt up button in the 3D dialog');
    assert.ok(await session.evaluate(pressButton('Tilt up')), 'no Tilt up button in the 3D dialog');
    await session.evaluate(idle, { timeoutMs: SLOW });
    const c2 = await session.evaluate(camera);
    assert.ok(Math.abs(c2.pitch - Math.min(60, c1.pitch + 20)) < 1, `Tilt up x2 went from pitch ${c1.pitch} to ${c2.pitch}`);
    await shot(session, '3d-tilted');

    // Inspect: frame the trail, and the features under its line answer with its id.
    await session.evaluate(`window.qcTerrainView.inspect().jumpTo({ center: [-83.5205, 35.0383], zoom: 13, pitch: 45, bearing: 0 }); void 0;`);
    await session.evaluate(idle, { timeoutMs: SLOW });
    const hits = await session.evaluate(inspectAT);
    assert.ok(hits.filter((id) => id === AT.id).length >= 6, `the 3D line under the trail answered ${JSON.stringify(hits.slice(0, 20))}`);
    await shot(session, '3d-inspect');

    // North up returns to the opening camera, flat and facing north.
    assert.ok(await session.evaluate(pressButton('North up / reset view')), 'no North up button in the 3D dialog');
    const c3 = await session.evaluate(camera);
    assert.ok(Math.abs(c3.pitch) < 0.5 && Math.abs(c3.bearing) < 0.5, `North up left pitch ${c3.pitch}, bearing ${c3.bearing}`);

    // Close: focus goes back to the button that opened 3D.
    await closeTerrain(session);
    assert.equal(await session.evaluate(`document.activeElement === document.querySelector('.qc-terrain-open')`), true,
      'closing 3D did not return focus to the 3D button');

    // 2D: roads off. 3D again: the road drape is gone, the trails stay.
    await session.evaluate(untick('qcm-layer-mvum'));
    await waitInPage(session, 'the road paths to leave 2D', `!${pathLabels}.some((l) => l.startsWith(${JSON.stringify(`${MVUM_ROAD.name} —`)}))`, 30000, null);
    await openTerrain(session);
    const after = await session.evaluate(drapeSources);
    assert.ok(after.includes('qc-drape-trails'), `trails left 3D after the roads were turned off (${after})`);
    assert.ok(!after.includes('qc-drape-mvum'), `3D still drapes the roads the reader turned off (${after})`);
    await shot(session, '3d-roads-off');
    await closeTerrain(session);

    // Reload: the saved job (the drawn area) comes back, and 3D opens over it again.
    await session.navigate(docUrl);
    await readyDashboard(session, { ms: 60000 });
    assert.deepEqual(await session.evaluate(readArea), area, 'the reload did not bring back the drawn area');
    await session.evaluate(tick('qcm-layer-trails'));
    await session.evaluate("document.getElementById('qcm-check').click()");
    await waitInPage(session, 'the trails layer to read ready after the reload', `document.getElementById('qcm-layer-trails-report')?.dataset?.state === 'ready'`, 30000, null);
    await openTerrain(session);
    const summit2 = await session.evaluate(`window.qcTerrainView.inspect().queryTerrainElevation([${SUMMIT.lon}, ${SUMMIT.lat}])`);
    assert.ok(summit2 >= 1700, `after the reload 3D is not over the restored area (summit ${summit2} m)`);
    assert.ok((await session.evaluate(drapeSources)).includes('qc-drape-trails'), 'after the reload 3D does not drape the trails');
    await shot(session, '3d-after-reload');
    await closeTerrain(session);

    assert.deepEqual(refused.filter((u) => !/favicon/.test(u)), [], 'the page asked for hosts the proof does not stub');
  } finally {
    session.close();
    await site.close();
  }
});
