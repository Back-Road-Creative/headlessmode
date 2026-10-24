// QQA-16a: the unified Cameras list, pure side. Run: node --test scripts/qcm/camera-list.test.mjs
// The list is computed from the LOADED camera records for a scope, never from the drawn pins, so it
// never inherits the 300-pin cap; each empty or partial state reads apart; each of the five camera
// layer ids sits under exactly one purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMERA_PURPOSES, PURPOSE_OF_LAYER, NEAR_RADIUS_KM, LIST_LIMIT, MAX_PINS,
  kmBetween, reachBox, cameraList, cameraListStatus, cameraRowText,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/camera-layer.js';
import * as cameraLayer from '../../themes/headlessmode/static/js/quiet-corners-maps/camera-layer.js';
import { LAYERS } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';

const rec = (n, lat, lon, layer = 'roadCameras', extra = {}) => ({
  layer,
  camera: { provider: 'caltrans-cwwp2', providerId: `c${n}`, name: `Camera ${n}`, lat, lon, operator: 'Caltrans',
    health: 'active', media: { still: 'https://example.test/c.jpg' }, ...extra },
});
const VIEW = { minLon: -122, minLat: 36, maxLon: -121, maxLat: 37 };
const PLACE = { name: 'Salinas', lat: 36.68, lon: -121.65 };

test('every camera layer id sits under exactly one of four purposes, and every purpose has a layer', () => {
  const ids = LAYERS.filter((l) => l.group === 'cameras').map((l) => l.id);
  assert.deepEqual(ids.slice().sort(), Object.keys(PURPOSE_OF_LAYER).sort());
  assert.deepEqual(CAMERA_PURPOSES.map((p) => p.id), ['roads', 'scenery', 'weather', 'wildlife']);
  for (const id of ids) assert.equal(CAMERA_PURPOSES.filter((p) => p.id === PURPOSE_OF_LAYER[id]).length, 1, id);
  for (const p of CAMERA_PURPOSES) assert.ok(ids.some((id) => PURPOSE_OF_LAYER[id] === p.id), `${p.id} has no layer`);
  assert.deepEqual(PURPOSE_OF_LAYER, { roadCameras: 'roads', parkCameras: 'scenery', linkCameras: 'roads', phenoCameras: 'wildlife', airportCameras: 'weather' });
  assert.equal(NEAR_RADIUS_KM, 25);
});

test('kmBetween is the great-circle distance and reachBox grows a point by that many km', () => {
  assert.equal(kmBetween(36, -121, 36, -121), 0);
  assert.ok(Math.abs(kmBetween(0, 0, 0, 1) - 111.19) < 0.5);
  const box = reachBox(36.68, -121.65, 25);
  assert.ok(box.minLat < 36.68 && box.maxLat > 36.68 && box.minLon < -121.65 && box.maxLon > -121.65);
  assert.ok(Math.abs(kmBetween(36.68, -121.65, box.maxLat, -121.65) - 25) < 0.5);
});

test('the view scope counts every loaded camera inside the view, past the 300-pin cap', () => {
  const entries = [];
  for (let i = 0; i < 350; i++) entries.push(rec(i, 36.2 + (i % 70) * 0.01, -121.9 + Math.floor(i / 70) * 0.1));
  entries.push(rec(900, 40, -100)); // outside the view
  const out = cameraList({ entries, scope: 'view', view: VIEW, purposes: CAMERA_PURPOSES.map((p) => p.id) });
  assert.ok(MAX_PINS < 350);
  assert.equal(out.inScope, 350);
  assert.equal(out.matching.length, 350);
  assert.equal(out.listed.length, LIST_LIMIT);
  assert.equal(out.counts.roads, 350);
});

test('the near scope keeps only cameras within the radius, nearest first, with their distance', () => {
  const entries = [rec(1, 36.70, -121.65), rec(2, 36.68, -121.65), rec(3, 36.9, -121.65), rec(4, 37.5, -121.65), rec(5, 36.69, -121.60)];
  const out = cameraList({ entries, scope: 'near', view: VIEW, place: PLACE, purposes: ['roads'] });
  assert.deepEqual(out.listed.map((r) => r.camera.providerId), ['c2', 'c1', 'c5', 'c3']);
  assert.equal(out.listed[0].km, 0);
  assert.ok(out.listed.every((r, i, a) => i === 0 || a[i - 1].km <= r.km));
  assert.ok(out.listed.every((r) => r.km <= NEAR_RADIUS_KM));
  assert.equal(out.inScope, 4);
});

test('a purpose filter narrows the list but not the in-scope count, and counts per purpose stay whole', () => {
  const entries = [rec(1, 36.5, -121.5), rec(2, 36.6, -121.5, 'parkCameras'), rec(3, 36.7, -121.5, 'airportCameras'), rec(4, 36.8, -121.5, 'phenoCameras'), rec(5, 36.4, -121.5, 'linkCameras')];
  const out = cameraList({ entries, scope: 'view', view: VIEW, purposes: ['scenery', 'weather'] });
  assert.equal(out.inScope, 5);
  assert.deepEqual(out.matching.map((r) => r.camera.providerId).sort(), ['c2', 'c3']);
  assert.deepEqual(out.counts, { roads: 2, scenery: 1, weather: 1, wildlife: 1 });
  assert.equal(cameraList({ entries, scope: 'view', view: VIEW, purposes: [] }).matching.length, 0);
});

test('a camera with no map position is not listed and is counted apart', () => {
  const entries = [rec(1, 36.5, -121.5), rec(2, null, null)];
  const out = cameraList({ entries, scope: 'view', view: VIEW, purposes: ['roads'] });
  assert.equal(out.inScope, 1);
  assert.equal(out.unlocated, 1);
});

test('the status keys read apart, in the order a reader needs them', () => {
  const base = { scope: 'view', onLayers: 1, belowZoom: false, hasPlace: true, placeName: 'Salinas', touches: true, loading: false,
    unavailable: false, failedAreas: 0, nothingLoaded: false, inScope: 12, matching: 12, listed: 12, noPicture: 0, unlocated: 0 };
  const key = (o) => cameraListStatus({ ...base, ...o }).key;
  assert.equal(key({ onLayers: 0 }), 'layers-off');
  assert.equal(key({ scope: 'near', hasPlace: false }), 'no-place');
  assert.equal(key({ belowZoom: true }), 'zoom-in');
  assert.equal(key({ scope: 'near', belowZoom: true }), 'in-scope', 'zoom does not gate the near scope');
  assert.equal(key({ loading: true }), 'loading');
  assert.equal(key({ unavailable: true, inScope: 0, matching: 0, listed: 0 }), 'unavailable');
  assert.equal(key({ touches: false, inScope: 0, matching: 0, listed: 0 }), 'outside-coverage');
  assert.equal(key({ nothingLoaded: true, inScope: 0, matching: 0, listed: 0 }), 'nothing-loaded');
  assert.equal(key({ inScope: 0, matching: 0, listed: 0 }), 'none');
  assert.equal(key({ matching: 0, listed: 0 }), 'filtered-out');
  assert.equal(key({ failedAreas: 2 }), 'partial');
  assert.equal(key({ noPicture: 12 }), 'images-unavailable');
  assert.equal(key({}), 'in-scope');
});

test('the status text names the scope, the count, and what a reader cannot see', () => {
  const s = (o) => cameraListStatus({ scope: 'view', onLayers: 1, belowZoom: false, hasPlace: true, placeName: 'Salinas', touches: true,
    loading: false, unavailable: false, failedAreas: 0, nothingLoaded: false, inScope: 12, matching: 12, listed: 12, noPicture: 0, unlocated: 0, ...o });
  assert.match(s({}).text, /^12 cameras in this view\.$/);
  assert.match(s({ scope: 'near' }).text, /12 cameras near Salinas, within 25 km, nearest first\./);
  assert.match(s({ inScope: 1, matching: 1, listed: 1 }).text, /^1 camera in this view\.$/);
  assert.match(s({ matching: 0, listed: 0 }).text, /12 cameras in this view are hidden by the purpose filter/);
  assert.match(s({ failedAreas: 2 }).notes.join(' '), /2 areas did not load/);
  assert.match(s({ noPicture: 5 }).notes.join(' '), /5 of the 12 have no picture here/);
  assert.match(s({ unlocated: 3 }).notes.join(' '), /3 loaded cameras have no map position and are not listed/);
  // The honest 300 case: the list says how many there are, how many it lists, and why.
  const big = s({ inScope: 350, matching: 350, listed: LIST_LIMIT }).notes.join(' ');
  assert.match(big, new RegExp(`Listing the nearest ${LIST_LIMIT} of 350`));
  assert.match(big, /map draws at most 300 pins/);
  assert.equal(s({ inScope: 120, matching: 120, listed: LIST_LIMIT }).notes.join(' ').includes('300 pins'), false);
});

test('a row names the camera, its source, the distance where near, and why there is no picture', () => {
  const plain = cameraRowText({ ...rec(1, 36.5, -121.5), km: 3.24 }, { near: false });
  assert.equal(plain.name, 'Camera 1');
  assert.equal(plain.meta, 'Caltrans');
  assert.equal(cameraRowText({ ...rec(1, 36.5, -121.5), km: 3.24 }, { near: true }).meta, 'Caltrans · 3.2 km');
  assert.equal(cameraRowText({ ...rec(1, 36.5, -121.5), km: 18.6 }, { near: true }).meta, 'Caltrans · 19 km');
  assert.equal(cameraRowText({ ...rec(1, 36.5, -121.5, 'linkCameras', { provider: 'hpwren', operator: 'HPWREN' }), km: 0 }, { near: true }).meta, 'HPWREN · 0.0 km · link only');
  assert.match(cameraRowText({ ...rec(1, 36.5, -121.5, 'roadCameras', { health: 'inactive' }), km: 1 }, { near: false }).meta, /out of service/);
  assert.match(cameraRowText({ ...rec(1, 36.5, -121.5, 'roadCameras', { media: { still: null } }), km: 1 }, { near: false }).meta, /no picture/);
});

test('the place "Near selected place" measures from is the latest pick: finder, else a pin or list pick, else the drawn area', () => {
  const search = { name: 'Finder Pick', anchor: [36.1, -121.2] };
  const nearby = { id: 'gnis:1', name: 'Pin Peak', lonLat: [-120.5, 35.5] };
  const bbox = { minLon: -122, minLat: 36, maxLon: -121, maxLat: 37 };
  assert.deepEqual(cameraLayer.listPlace({ search, nearby, bbox }), { lat: 36.1, lon: -121.2, name: 'Finder Pick' });
  // nearbyFrom is [lon, lat]; the place is { lat, lon }.
  assert.deepEqual(cameraLayer.listPlace({ nearby, bbox }), { lat: 35.5, lon: -120.5, name: 'Pin Peak' });
  assert.deepEqual(cameraLayer.listPlace({ bbox }), { lat: 36.5, lon: -121.5, name: 'the drawn area' });
  assert.equal(cameraLayer.listPlace({ search: { name: 'x', anchor: [NaN, 1] }, nearby: { name: 'y', lonLat: [1] } }), null);
  assert.equal(cameraLayer.listPlace({}), null);
});

test('the load state of a scope comes from the files that scope reaches, not from the map view', () => {
  const rows = [{ file: 'a.json', layer: 'roadCameras' }, { file: 'b.json', layer: 'roadCameras' }];
  const set = (...f) => (file) => f.includes(file);
  const state = (o) => cameraLayer.listLoadState({ near: true, reaching: ['roadCameras'], rows, isLoaded: set(), isFailed: set(), indexRead: true, layerFailed: {}, ...o });
  // near: every file around the place failed -> unavailable, whatever the map view's own flag says.
  assert.deepEqual(state({ isFailed: set('a.json', 'b.json') }), { unavailable: true, failedAreas: 2, nothingLoaded: false });
  // near: the view's flag is set (a district parked on failed) but the place's files loaded -> neither unavailable nor partial.
  assert.deepEqual(state({ isLoaded: set('a.json', 'b.json'), layerFailed: { roadCameras: true } }), { unavailable: false, failedAreas: 0, nothingLoaded: false });
  // near: one failed, one loaded -> partial (one area), not unavailable.
  assert.deepEqual(state({ isLoaded: set('a.json'), isFailed: set('b.json') }), { unavailable: false, failedAreas: 1, nothingLoaded: false });
  // near: nothing tried yet is the only nothing-loaded; the index not read yet is too.
  assert.deepEqual(state({}), { unavailable: false, failedAreas: 0, nothingLoaded: true });
  assert.equal(state({ indexRead: false, rows: [] }).nothingLoaded, true);
  // near: the index itself failed -> unavailable.
  assert.equal(state({ indexRead: false, rows: [], layerFailed: { roadCameras: true } }).unavailable, true);
  // view: the map view's own flag and per-layer failures still decide.
  const view = (o) => state({ near: false, ...o });
  assert.equal(view({ layerFailed: { roadCameras: true }, isFailed: set('a.json') }).unavailable, true);
  assert.deepEqual(view({ isLoaded: set('a.json'), isFailed: set('b.json') }), { unavailable: false, failedAreas: 1, nothingLoaded: false });
  assert.equal(view({ isFailed: set('a.json') }).nothingLoaded, true, 'view: none loaded yet and the flag not set reads nothing-loaded as before');
  assert.equal(view({ reaching: [] }).nothingLoaded, false);
});
