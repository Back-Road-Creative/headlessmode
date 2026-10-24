// QQA-06c slice 1 (finding F10): the 3D view over STEEP relief, in a real browser.
//
// terrain-panel.test.mjs answers the DEM and topo with a 1x1 grey tile, so the ground is
// flat and nothing about a trail on a hillside is ever exercised. Here the DEM is a
// generated hill and gorge (fixtures/relief-3d.mjs: a 1,800 m summit beside a 650 m gorge,
// computed on request at any zoom, no binary committed) and the trails and Forest Service
// road come back from stubbed service answers, so the page loads them exactly as it does
// live. Nothing reaches the network: every request that is not the local site or one of
// those stubs is refused.
//
// What is measured is what a reader would see, not that a layer object exists:
//   - pixels read back from the WebGL canvas at the projected trail vertices, with the
//     drape layers hidden as the baseline (a trail is "drawn" where the pixel changes),
//   - queryRenderedFeatures at the same points (the casing and line layers answer with
//     the trail's id),
//   - the name label the page places beside it (a DOM span, so its text and its distance
//     from the projected trail are read, not assumed).
// Each at three different pitch / bearing / zoom settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium } from './helpers/browser.mjs';
import { connectSession } from './helpers/cdp-session.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { waitInPage } from './helpers/waits.mjs';
import { SLOW, stubNetwork, loadWithRoutes, openTerrain, closeTerrain, dialogHidden } from './helpers/relief-session.mjs';
import { SUMMIT, reliefElevationM, TRAILS, MVUM_ROAD } from './fixtures/relief-3d.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built — run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

// --- the fixture itself must be steep, or every check below proves nothing about relief.
test('the relief fixture is steep: a 1,000 m span and slopes past 25 degrees', () => {
  let lo = Infinity, hi = -Infinity, steepest = 0;
  const step = 30 / 111320; // 30 m in degrees of latitude
  for (let lon = -83.55; lon <= -83.44; lon += 0.0015) {
    for (let lat = 35.0; lat <= 35.1; lat += 0.0015) {
      const z = reliefElevationM(lon, lat);
      lo = Math.min(lo, z); hi = Math.max(hi, z);
      const dz = Math.max(Math.abs(reliefElevationM(lon + step / Math.cos(lat * Math.PI / 180), lat) - z),
        Math.abs(reliefElevationM(lon, lat + step) - z));
      steepest = Math.max(steepest, (Math.atan(dz / 30) * 180) / Math.PI);
    }
  }
  assert.ok(hi - lo >= 1000, `relief spans only ${hi - lo} m`);
  assert.ok(steepest >= 25, `steepest slope is only ${steepest.toFixed(1)} degrees`);
  assert.ok(reliefElevationM(SUMMIT.lon, SUMMIT.lat) >= 1700, 'the summit is not high');
});

// What the page-side measurement is told about each route: id, name, vertices ([lon, lat]).
const ROUTES = [...TRAILS.map((t) => ({ id: t.id, name: t.name, kind: 'trail', path: t.paths[0] })),
  { id: MVUM_ROAD.id, name: MVUM_ROAD.name, kind: 'road', path: MVUM_ROAD.paths[0] }];

const CAMERAS = Object.freeze([
  { name: 'z13 pitch 45 bearing 0', center: [-83.5205, 35.0383], zoom: 13, pitch: 45, bearing: 0 },
  { name: 'z12.8 pitch 60 bearing 90', center: [-83.515, 35.04], zoom: 12.8, pitch: 60, bearing: 90 },
  { name: 'z12.4 pitch 30 bearing -35', center: [-83.51, 35.03], zoom: 12.4, pitch: 30, bearing: -35 },
]);

/** Runs in the page. Moves the camera, then reads the WebGL canvas three ways at the
 *  projected route vertices: nothing drawn (every drape layer hidden), casing only, and
 *  everything. A route is "drawn" where the full render differs from the empty one. */
const measure = (camera) => `(async () => {
  const camera = ${JSON.stringify(camera)};
  const routes = ${JSON.stringify(ROUTES)};
  const map = window.qcTerrainView.inspect();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const idle = () => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('the 3D map never went idle (loaded=' + map.loaded() + ', tiles=' + map.areTilesLoaded() + ')')), 100000);
    map.once('idle', () => { clearTimeout(t); res(); }); map.triggerRepaint(); });
  map.jumpTo({ center: camera.center, zoom: camera.zoom, pitch: camera.pitch, bearing: camera.bearing });
  await idle();
  await wait(500); // the label pass is debounced 150 ms after the move
  const canvas = map.getCanvas();
  const W = canvas.width, H = canvas.height;
  const probe = document.createElement('canvas'); probe.width = W; probe.height = H;
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  const style = map.getStyle();
  const drape = style.layers.filter((l) => l.id.startsWith('qc-drape-'));
  const setVisible = (pred) => { for (const l of drape) map.setLayoutProperty(l.id, 'visibility', pred(l) ? 'visible' : 'none'); };
  const frame = () => new Promise((res) => { map.once('render', () => { ctx.drawImage(canvas, 0, 0); res(ctx.getImageData(0, 0, W, H)); }); map.triggerRepaint(); });
  const same = (a, b) => { const x = a.data, y = b.data; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false; return true; };
  // A layer change reaches the canvas a frame or more later on a loaded machine (the terrain re-draws
  // its drape textures lazily), so one 'render' can still show the previous state. A frame counts once
  // the next one is pixel-identical; the pixels compared stay exactly as before.
  const grab = async () => {
    let prev = await frame();
    for (let i = 0; i < 10; i++) { const cur = await frame(); if (same(prev, cur)) return cur; prev = cur; }
    return prev;
  };
  const lineIds = drape.filter((l) => l.type === 'line').map((l) => l.id);

  // Sample points: every vertex and every midpoint, projected through the 3D terrain.
  const samples = (path) => { const out = [];
    for (let i = 0; i < path.length; i++) { out.push(path[i]);
      if (i + 1 < path.length) out.push([(path[i][0] + path[i + 1][0]) / 2, (path[i][1] + path[i + 1][1]) / 2]); }
    return out.map((ll) => map.project(ll)).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))
      .filter((p) => p.x >= 8 && p.y >= 8 && p.x < W - 8 && p.y < H - 8); };
  const pts = Object.fromEntries(routes.map((r) => [r.id, samples(r.path)]));

  // queryRenderedFeatures with everything drawn.
  setVisible(() => true);
  await grab();
  const qrf = {};
  for (const r of routes) {
    let hit = 0;
    for (const p of pts[r.id]) {
      const f = map.queryRenderedFeatures([[p.x - 3, p.y - 3], [p.x + 3, p.y + 3]], { layers: lineIds });
      if (f.some((x) => x.properties.id === r.id)) hit++;
    }
    qrf[r.id] = hit;
  }
  const full = await grab();
  setVisible(() => false);
  const base = await grab();
  setVisible(() => true);
  await grab();
  // Casing alone: the coloured lines go fully transparent (a paint change, which the terrain's
  // render-to-texture cache re-draws; a visibility toggle on a subset left a stale frame).
  const coloured = lineIds.filter((id) => !id.endsWith('-casing'));
  const opac = Object.fromEntries(coloured.map((id) => [id, map.getPaintProperty(id, 'line-opacity')]));
  for (const id of coloured) map.setPaintProperty(id, 'line-opacity', 0);
  await grab();
  const casing = await grab();
  for (const id of coloured) map.setPaintProperty(id, 'line-opacity', opac[id]);
  await grab();

  const at = (img, p) => { const o = (p.y * W + p.x) * 4; return [img.data[o], img.data[o + 1], img.data[o + 2]]; };
  const delta = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const lum = (c) => (c[0] + c[1] + c[2]) / 3;
  // A route's projected centre can land a pixel off the rasterised line (rounding, anti-aliasing),
  // so a point counts when any pixel in its 3x3 neighbourhood shows the ink.
  const near3 = (p) => { const o = []; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) o.push({ x: p.x + dx, y: p.y + dy }); return o; };
  const result = {};
  for (const r of routes) {
    const n = pts[r.id].length;
    result[r.id] = { n, qrf: qrf[r.id],
      drawn: pts[r.id].filter((p) => near3(p).some((q) => delta(at(full, q), at(base, q)) > 30)).length,
      cased: pts[r.id].filter((p) => near3(p).some((q) => lum(at(casing, q)) - lum(at(base, q)) > 40)).length };
  }
  // Control: a grid of points away from every route. Toggling the drape layers must not
  // change them, or the comparison above is measuring something other than the routes.
  const near = Object.values(pts).flat();
  let control = 0, controlChanged = 0;
  for (let y = 20; y < H - 20; y += 40) for (let x = 20; x < W - 20; x += 40) {
    if (near.some((p) => Math.abs(p.x - x) < 16 && Math.abs(p.y - y) < 16)) continue;
    control++; if (delta(at(full, { x, y }), at(base, { x, y })) > 30) controlChanged++;
  }
  const labels = [...document.querySelectorAll('.qc-terrain-name-label[data-trail-id]')].map((el) => {
    const x = parseFloat(el.style.left), y = parseFloat(el.style.top);
    const mine = pts[el.dataset.trailId] || [];
    const dist = mine.length ? Math.min(...mine.map((p) => Math.hypot(p.x - x, p.y - y))) : null;
    return { id: el.dataset.trailId, text: el.textContent, dist };
  });
  return { canvas: [W, H], pitch: map.getPitch(), bearing: map.getBearing(), zoom: map.getZoom(),
    result, control, controlChanged, labels,
    summit: map.queryTerrainElevation([${SUMMIT.lon}, ${SUMMIT.lat}]),
    gorge: map.queryTerrainElevation([-83.495, 35.06]) };
})()`;

const layerOpacity = `(() => { const m = window.qcTerrainView.inspect(); const out = {};
  for (const l of m.getStyle().layers) if (l.id.startsWith('qc-drape-') && l.type === 'line' && !l.id.endsWith('-casing'))
    out[l.source] = m.getPaintProperty(l.id, 'line-opacity');
  return out; })()`;

test('3D over steep relief: trail, casing, label and highlight are drawn at three camera settings, and 2D agrees on which trail is which', { skip }, async () => {
  const site = await startSiteServer();
  const docUrl = `${site.origin}/quiet-corners/`;
  const session = await connectSession();
  try {
    const { refused } = await stubNetwork(session, { docUrl, siteOrigin: site.origin });
    await loadWithRoutes(session, docUrl);

    // 2D, the canonical view: the SVG path of each trail is labelled "<name> — <kind>".
    const twoD = await session.evaluate(`[...document.querySelectorAll('#qc-map .leaflet-overlay-pane path[aria-label]')].map((p) => p.getAttribute('aria-label'))`);
    for (const t of TRAILS) {
      assert.ok(twoD.some((l) => l.startsWith(`${t.name} —`)), `2D draws no path labelled "${t.name}" (has: ${JSON.stringify(twoD)})`);
    }

    await openTerrain(session);
    const seenLabels = new Map(); // trail id -> label text, across all cameras
    const opacityNormal = await session.evaluate(layerOpacity);
    let roadChecked = 0;
    for (const camera of CAMERAS) {
      const m = await session.evaluate(measure(camera), { timeoutMs: SLOW });
      const where = `${camera.name} (pitch ${m.pitch.toFixed(0)}, bearing ${m.bearing.toFixed(0)}, zoom ${m.zoom.toFixed(1)})`;
      assert.ok(m.summit >= 1700 && m.gorge <= 760, `${where}: 3D terrain is not the steep fixture (summit ${m.summit} m, gorge ${m.gorge} m)`);
      assert.ok(Math.abs(m.pitch - camera.pitch) < 1, `${where}: the camera did not reach the asked pitch`);
      const at = m.result['fx-at-standing-indian'];
      // The Appalachian Trail crosses the summit: it must be on screen, drawn, cased and queryable.
      assert.ok(at.n >= 12, `${where}: only ${at.n} Appalachian Trail points are on screen`);
      assert.ok(at.drawn / at.n >= 0.7, `${where}: the trail line changed only ${at.drawn} of ${at.n} sampled pixels`);
      assert.ok(at.cased / at.n >= 0.6, `${where}: the white casing showed under only ${at.cased} of ${at.n} sampled points`);
      assert.ok(at.qrf / at.n >= 0.7, `${where}: queryRenderedFeatures found the trail id at only ${at.qrf} of ${at.n} points`);
      assert.ok(m.control >= 20 && m.controlChanged / m.control <= 0.05,
        `${where}: ${m.controlChanged} of ${m.control} off-route pixels changed with the route layers, so the pixel test is not isolating the routes`);
      // The road is drawn too (same sampling), but is NOT given a name in 3D.
      // A camera that frames too little of the road skips it, but at least one camera must check it (below).
      const road = m.result[MVUM_ROAD.id];
      if (road.n >= 6) {
        assert.ok(road.drawn / road.n >= 0.5, `${where}: the road changed only ${road.drawn} of ${road.n} sampled pixels`);
        roadChecked += 1;
      }
      // Labels: at least one trail is named beside its own line, and it is the right name.
      assert.ok(m.labels.length >= 1, `${where}: no trail name is labelled in 3D (labels: ${JSON.stringify(m.labels)})`);
      for (const l of m.labels) {
        const trail = TRAILS.find((t) => t.id === l.id);
        assert.ok(trail, `${where}: a label for unknown id ${l.id}`);
        assert.equal(l.text, trail.name, `${where}: label text for ${l.id}`);
        assert.ok(l.dist !== null && l.dist <= 130, `${where}: "${l.text}" sits ${l.dist} px from its own trail`);
        seenLabels.set(l.id, l.text);
      }
      assert.ok(!m.labels.some((l) => l.id === MVUM_ROAD.id), `${where}: a road name was added to 3D`);
      assert.equal(await session.evaluate(`!![...document.querySelectorAll('.qc-terrain-name-label')].find((e) => e.textContent === ${JSON.stringify(MVUM_ROAD.name)})`), false,
        `${where}: "${MVUM_ROAD.name}" is labelled in 3D`);
    }

    assert.ok(roadChecked >= 1, `no camera framed ${MVUM_ROAD.name} well enough to check it is drawn in 3D`);

    // 2D/3D identity: every trail 3D labelled is the same id and name 2D drew.
    assert.ok(seenLabels.size >= 1, 'no trail was ever labelled in 3D');
    for (const [id, text] of seenLabels) {
      const trail = TRAILS.find((t) => t.id === id);
      assert.equal(text, trail.name);
      assert.ok(twoD.some((l) => l.startsWith(`${text} —`)), `3D labels "${text}" but 2D has no such trail`);
    }
    await closeTerrain(session);

    // Highlight: "Highlight trails" in 2D carries into 3D -- trails stay full, the road dims.
    await session.evaluate(`document.getElementById('qcm-highlight-trails').click(); void 0;`);
    await openTerrain(session);
    const opacityHighlighted = await session.evaluate(layerOpacity);
    assert.equal(opacityNormal['qc-drape-trails'], opacityNormal['qc-drape-mvum'], 'without a highlight the trails and the road should draw alike');
    assert.ok(opacityHighlighted['qc-drape-trails'] >= 0.99, `highlighted trails dimmed to ${opacityHighlighted['qc-drape-trails']}`);
    assert.ok(opacityHighlighted['qc-drape-mvum'] <= 0.3, `the road was not dimmed behind the highlighted trails (${opacityHighlighted['qc-drape-mvum']})`);
    const hl = await session.evaluate(measure(CAMERAS[0]), { timeoutMs: SLOW });
    const hlAt = hl.result['fx-at-standing-indian'];
    assert.ok(hlAt.drawn / hlAt.n >= 0.7, `the highlighted trail changed only ${hlAt.drawn} of ${hlAt.n} sampled pixels`);
    assert.ok(hl.labels.length >= 1, 'the highlighted view lost its trail labels');
    await closeTerrain(session);

    assert.deepEqual(refused.filter((u) => !/favicon/.test(u)), [], 'the page asked for hosts the proof does not stub');
  } finally {
    session.close();
    await site.close();
  }
});

test('with WebGL turned off, 3D says so and the 2D map keeps its trails and keeps panning', { skip }, async () => {
  const site = await startSiteServer();
  const docUrl = `${site.origin}/quiet-corners/`;
  const session = await connectSession({ args: ['--disable-3d-apis'] });
  try {
    await stubNetwork(session, { docUrl, siteOrigin: site.origin });
    await loadWithRoutes(session, docUrl);
    const trails2d = `[...document.querySelectorAll('#qc-map .leaflet-overlay-pane path[aria-label]')].map((p) => p.getAttribute('aria-label')).filter((l) => /Trail —/.test(l)).length`;
    const before = await session.evaluate(trails2d);
    assert.ok(before >= TRAILS.length, `2D drew ${before} trail paths before the 3D press`);

    await session.evaluate(`document.querySelector('.qc-terrain-open').click(); void 0;`);
    await waitInPage(session, 'the no-WebGL notice', `Boolean(document.querySelector('.qc-terrain-fallback'))`, 15000, null);
    assert.match(await session.evaluate(`document.querySelector('.qc-terrain-fallback').textContent`), /WebGL/);
    assert.equal(await session.evaluate(`document.querySelector('.qc-terrain-dialog canvas')`), null, 'a 3D canvas exists without WebGL');

    await session.evaluate(`document.querySelector('.qc-terrain-dialog .qc-terrain-close').click(); void 0;`);
    await waitInPage(session, 'the notice to close', dialogHidden, 15000, null);
    const c0 = await session.evaluate(`(() => { const c = window.qcMap.getCenter(); return [c.lng, c.lat]; })()`);
    await session.evaluate(`window.qcMap.panBy([120, 0], { animate: false }); void 0;`);
    const c1 = await session.evaluate(`(() => { const c = window.qcMap.getCenter(); return [c.lng, c.lat]; })()`);
    assert.notEqual(c1[0], c0[0], '2D did not pan after the 3D attempt');
    assert.equal(await session.evaluate(trails2d), before, '2D lost trail paths after the 3D attempt');
  } finally {
    session.close();
    await site.close();
  }
});
