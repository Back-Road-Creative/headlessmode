// Pure tests for the 3D terrain panel's draped overlays (E2). No DOM, no
// MapLibre, no network -- overlayLayersFor and labelOccluded take plain data
// and a fake registry and return plain data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  overlayLayersFor, trailLabelsFor, capabilityNotices, layerToggleRows, vertexCount, capVertices, labelOccluded,
  MAX_LAYER_VERTICES, OCCLUSION_SAMPLES,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/terrain-overlays.js';

const trailRow = { id: 'trails', label: 'Trails', group: 'federal', drape: 'line' };
const mvumRow = { id: 'mvum', label: 'MVUM', group: 'federal', drape: 'line' };
const landRow = { id: 'countyLines', label: 'County lines', group: 'federal', drape: 'line' };
const namesRow = { id: 'names', label: 'Named places & landmarks', group: 'federal', drape: 'label' };
const hillshadeRow = { id: 'terrainSlope', label: 'Slope', group: 'context', drape: false };
const nightLightsRow = { id: 'nightLights', label: 'Night lights', group: 'context', drape: false };
const REGISTRY = [trailRow, mvumRow, landRow, namesRow, hillshadeRow, nightLightsRow];

const line = (id, symbolKey, paths) => ({ id, symbolKey, name: id, paths });
const pt = (id, symbolKey, lonLat) => ({ id, symbolKey, name: id, lonLat });

test('vertexCount sums every ring/segment of a feature\'s paths; a point counts as one', () => {
  assert.equal(vertexCount([[[-1, 1], [-1.1, 1.1], [-1.2, 1.2]]]), 3);
  assert.equal(vertexCount([[[-1, 1], [-1.1, 1.1]], [[-2, 2], [-2.1, 2.1], [-2.2, 2.2]]]), 5);
  assert.equal(vertexCount(undefined), 0);
  assert.equal(vertexCount([]), 0);
});

test('capVertices keeps features until the budget is spent, then drops the rest', () => {
  const features = [
    line('a', 'trail-nst', [[[-1, 1], [-1.1, 1.1], [-1.2, 1.2]]]),   // 3 vertices
    line('b', 'trail-nst', [[[-2, 2], [-2.1, 2.1], [-2.2, 2.2]]]),   // 3 vertices
    line('c', 'trail-nst', [[[-3, 3], [-3.1, 3.1], [-3.2, 3.2]]]),   // 3 vertices
  ];
  const { kept, used, droppedFeatures, droppedVertices } = capVertices(features, 5);
  assert.deepEqual(kept.map((f) => f.id), ['a']);
  assert.equal(used, 3);
  assert.equal(droppedFeatures, 2);
  assert.equal(droppedVertices, 6);
});

test('capVertices keeps everything under budget and drops nothing', () => {
  const features = [line('a', 'trail-nst', [[[-1, 1], [-1.1, 1.1]]])];
  const { kept, droppedFeatures } = capVertices(features, MAX_LAYER_VERTICES);
  assert.equal(kept.length, 1);
  assert.equal(droppedFeatures, 0);
});

test('overlayLayersFor drapes an ON vector layer with D0\'s own colour/weight and a casing pass', () => {
  const featuresByLayerId = { trails: [line('t1', 'trail-nst', [[[-83, 35], [-83.01, 35.01]]])] };
  const { sources, layers, dropped } = overlayLayersFor(featuresByLayerId, REGISTRY, { on: { trails: true } });
  assert.ok(sources['qc-drape-trails'], 'no source built for trails');
  assert.equal(sources['qc-drape-trails'].data.features.length, 1);
  assert.equal(sources['qc-drape-trails'].data.features[0].geometry.type, 'LineString');
  const casing = layers.find((l) => l.id.endsWith('-casing'));
  const line_ = layers.find((l) => l.id.endsWith('trail-nst') && !l.id.endsWith('-casing'));
  assert.ok(casing, 'no casing/halo layer for the thin trail line');
  assert.ok(line_, 'no line layer for the trail');
  assert.equal(dropped.length, 0);
});

test('overlayLayersFor reports a raster context layer as dropped for reason "raster", never drawn', () => {
  const { sources, layers, dropped } = overlayLayersFor({}, REGISTRY, { on: { terrainSlope: true, nightLights: true } });
  assert.deepEqual(Object.keys(sources), []);
  assert.deepEqual(layers, []);
  assert.deepEqual(dropped.sort((a, b) => a.id.localeCompare(b.id)),
    [{ id: 'nightLights', reason: 'raster' }, { id: 'terrainSlope', reason: 'raster' }]);
});

test('overlayLayersFor reports an ON vector layer with nothing fetched yet as "loading", not silently absent', () => {
  const { sources, dropped } = overlayLayersFor({}, REGISTRY, { on: { trails: true }, statesById: { trails: 'unchecked' } });
  assert.deepEqual(Object.keys(sources), []);
  assert.deepEqual(dropped, [{ id: 'trails', reason: 'loading' }]);
});

test('overlayLayersFor caps vertices per layer and reports the drop', () => {
  const many = Array.from({ length: 3 }, (_, i) => line(`t${i}`, 'trail-nst', [Array.from({ length: 4 }, (_, j) => [-83 - i - j * 0.01, 35])]));
  const { sources, dropped } = overlayLayersFor({ trails: many }, REGISTRY, { on: { trails: true }, vertexCap: 6 });
  assert.equal(sources['qc-drape-trails'].data.features.length, 1);
  const drop = dropped.find((d) => d.id === 'trails');
  assert.ok(drop && drop.reason === 'vertex-cap' && drop.droppedFeatures === 2);
});

test('overlayLayersFor never drapes the names layer -- that is a separate DOM/occlusion pass', () => {
  const { sources, layers } = overlayLayersFor({ names: [pt('n1', 'name-summit', [-83, 35])] }, REGISTRY, { on: { names: true } });
  assert.deepEqual(Object.keys(sources), []);
  assert.deepEqual(layers, []);
});

test('overlayLayersFor draws a point layer (rec sites) as a circle layer, D0 colours', () => {
  const recRow = { id: 'recSites', label: 'Rec sites', group: 'federal', drape: 'line' };
  const reg = [...REGISTRY, recRow];
  const { sources, layers } = overlayLayersFor({ recSites: [pt('s1', 'rec-campground', [-83, 35])] }, reg, { on: { recSites: true } });
  assert.equal(sources['qc-drape-recSites'].data.features[0].geometry.type, 'Point');
  assert.ok(layers.some((l) => l.type === 'circle'));
});

test('overlayLayersFor carries emphasis (spotlight/dim) from the same D0 helper as 2D, no new state', () => {
  const featuresByLayerId = { trails: [line('t1', 'trail-nst', [[[-83, 35], [-83.01, 35.01]]])] };
  const display = { lines: 1, fill: 1, dim: 0, spotlight: 'trails', contrast: 'normal' };
  const other = { lines: 1, fill: 1, dim: 0, spotlight: 'mvum', contrast: 'normal' };
  const { layers: spotlit } = overlayLayersFor(featuresByLayerId, REGISTRY, { on: { trails: true }, display, layerIdForKey: () => 'trails' });
  const { layers: dimmed } = overlayLayersFor(featuresByLayerId, REGISTRY, { on: { trails: true }, display: other, layerIdForKey: () => 'trails' });
  const spotlitLine = spotlit.find((l) => l.type === 'line' && !l.id.endsWith('-casing'));
  const dimmedLine = dimmed.find((l) => l.type === 'line' && !l.id.endsWith('-casing'));
  assert.ok(spotlitLine.paint['line-opacity'] > dimmedLine.paint['line-opacity'],
    'the spotlit layer must be brighter than the same layer dimmed by another spotlight');
});

test('capabilityNotices lists every ON layer as "shown" (drapes) or "available-2d" (context), nothing else', () => {
  const notices = capabilityNotices(REGISTRY, { trails: true, terrainSlope: true, mvum: false }, {});
  assert.deepEqual(notices.map((n) => n.id).sort(), ['terrainSlope', 'trails']);
  assert.equal(notices.find((n) => n.id === 'trails').status, 'shown');
  assert.equal(notices.find((n) => n.id === 'terrainSlope').status, 'available-2d');
});

test('capabilityNotices marks an ON vector layer with nothing fetched yet "loading", not "shown"', () => {
  const notices = capabilityNotices(REGISTRY, { trails: true }, { trails: 'unchecked' });
  assert.equal(notices.find((n) => n.id === 'trails').status, 'loading');
});

test('capabilityNotices still says nothing about reading rows, extra sheets and the base map', () => {
  const registry = [
    { id: 'readingRow', label: 'Reading', group: 'reading', drape: false },
    { id: 'extraSheet', label: 'Extra', group: 'overlay', extraPage: true, drape: false },
    { id: 'baseRow', label: 'Base', group: 'base', drape: false },
  ];
  assert.deepEqual(capabilityNotices(registry, { readingRow: true, extraSheet: true, baseRow: true }, {}), []);
});

test('layerToggleRows offers a switch for every layer 3D can draw, ticked as 2D has it, and none for the rest', () => {
  const required = { id: 'usgsTopo', label: 'USGS Topo', group: 'base', drape: false, required: true };
  const roadsRow = { id: 'roads', label: 'Road names', group: 'federal', drape: 'line' };
  const rows = layerToggleRows([...REGISTRY, required, roadsRow], { trails: true, mvum: false, terrainSlope: true, roads: false }, { on: true });
  assert.deepEqual(rows.map((r) => r.id), ['trails', 'mvum', 'countyLines', 'names', 'roads']);
  assert.equal(rows.find((r) => r.id === 'trails').on, true);
  assert.equal(rows.find((r) => r.id === 'mvum').on, false);
  // Road names: the snapshot tells the capability list they are off (the road pass reports its own
  // state), so the switch reads the road row's own on, not on.roads.
  assert.equal(rows.find((r) => r.id === 'roads').on, true);
  assert.equal(rows.find((r) => r.id === 'trails').label, 'Trails');
});

// --- Occlusion -------------------------------------------------------------

test('labelOccluded is false when the terrain never rises above the camera-to-anchor line', () => {
  const occluded = labelOccluded({
    anchor: { lon: -83, lat: 35, elevation: 1000 },
    camera: { lon: -83.1, lat: 35.1, elevation: 3000 },
    sampleElevation: () => 500, // flat, well below the sightline everywhere
  });
  assert.equal(occluded, false);
});

test('labelOccluded is true when a sampled point along the ray is higher than the sightline', () => {
  const occluded = labelOccluded({
    anchor: { lon: -83, lat: 35, elevation: 1000 },
    camera: { lon: -83.1, lat: 35.1, elevation: 1000 },
    // A ridge right in the middle of the ray, well above the flat 1000m sightline.
    sampleElevation: (lon, lat, t) => (t > 0.4 && t < 0.6 ? 5000 : 500),
  });
  assert.equal(occluded, true);
});

test('labelOccluded samples a bounded number of points along the ray', () => {
  let calls = 0;
  labelOccluded({
    anchor: { lon: -83, lat: 35, elevation: 1000 },
    camera: { lon: -83.1, lat: 35.1, elevation: 1000 },
    sampleElevation: () => { calls++; return 0; },
  });
  assert.ok(calls <= OCCLUSION_SAMPLES, `sampled ${calls} points, more than the documented bound ${OCCLUSION_SAMPLES}`);
  assert.ok(calls > 0);
});

test('trailLabelsFor gives one named record per trail id, joins its segments, and skips the unnamed', () => {
  const rows = trailLabelsFor([
    { id: 'a', name: 'Ridge Trail', symbolKey: 'trail-nst', paths: [[[-83.5, 35.0], [-83.49, 35.01]]] },
    { id: 'a', name: 'Ridge Trail', symbolKey: 'trail-nst', paths: [[[-83.49, 35.01], [-83.48, 35.02], [-83.47, 35.03]]] },
    { id: 'b', name: '   ', paths: [[[-83.4, 35.0], [-83.41, 35.0]]] },
    { id: 'c', paths: [[[-83.4, 35.0], [-83.41, 35.0]]] },
    { id: 'd', name: 'Point Only', lonLat: [-83.4, 35.0] },
    { id: 'e', name: 'Stub', paths: [[[-83.4, 35.0]]] },
  ]);
  assert.equal(rows.length, 1);
  const [t] = rows;
  assert.equal(t.id, 'a');
  assert.equal(t.name, 'Ridge Trail');
  assert.equal(t.kind, 'trail');
  assert.equal(t.path.length, 5);
  // The fallback anchor is a [lat, lon] vertex of the trail itself (names use [lat, lon]).
  assert.ok(t.path.some(([lon, lat]) => lon === t.anchor[1] && lat === t.anchor[0]));
});

test('trailLabelsFor tolerates no features at all', () => {
  assert.deepEqual(trailLabelsFor(), []);
  assert.deepEqual(trailLabelsFor([null, undefined]), []);
});

test('camera pins stand on the relief as points in their 2D pin colour, listed as shown and switchable in 3D', () => {
  const registry = [{ id: 'roadCameras', group: 'cameras', label: 'Road cameras', drape: 'point', pinColor: '#38bdf8' }];
  const cams = [
    { id: 'cam-a', name: 'Pass summit (synthetic)', symbolKey: 'roadCameras', lonLat: [-114.1, 46.2] },
    { id: 'cam-b', name: 'Valley junction (synthetic)', symbolKey: 'roadCameras', lonLat: [-114.0, 46.3] },
  ];
  const { sources, layers, dropped } = overlayLayersFor({ roadCameras: cams }, registry, { on: { roadCameras: true } });
  assert.deepEqual(dropped, []);
  assert.equal(sources['qc-drape-roadCameras'].data.features.length, 2);
  const circles = layers.filter((l) => l.source === 'qc-drape-roadCameras' && l.type === 'circle');
  assert.equal(circles.length, 1, 'one circle layer for the pins');
  assert.equal(circles[0].paint['circle-color'], '#38bdf8');
  assert.deepEqual(capabilityNotices(registry, { roadCameras: true }, {}), [{ id: 'roadCameras', label: 'Road cameras', status: 'shown' }]);
  assert.deepEqual(layerToggleRows(registry, { roadCameras: false }).map((r) => r.id), ['roadCameras']);
  assert.deepEqual(overlayLayersFor({ roadCameras: cams }, registry, { on: {} }).layers, [], 'off in 2D, nothing in 3D');
});
