// QQA-16b: finding cameras, pure side. Run: node --test scripts/qcm/camera-find.test.mjs
// A Saved scope that says so when a saved camera's record is gone, a bounded "Search this area" whose
// radius and file bound are stated, and a cluster summary below the pin zoom counted from loaded records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMERA_PURPOSES, MIN_PIN_ZOOM, SEARCH_RADIUS_KM, SEARCH_MAX_FILES, SEARCH_HINT, reachBox,
  searchBox, searchFiles, searchStatus, filesHolding, canonicalCameraRef, savedCameraRows, savedRowText, savedListStatus, cameraListStatus,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/camera-layer.js';

const VIEW = { minLon: -122, minLat: 36, maxLon: -121, maxLat: 37 };
const file = (name, layer, bbox) => ({ file: name, layer, provider: 'caltrans-cwwp2', bbox });
const cam = (id, extra = {}) => ({ provider: 'caltrans-cwwp2', providerId: id, name: `Camera ${id}`, lat: 36.5, lon: -121.5, operator: 'Caltrans', health: 'active', media: { still: 'https://example.test/c.jpg' }, ...extra });

test('the search states its radius and its file bound', () => {
  assert.equal(SEARCH_RADIUS_KM, 100);
  assert.equal(SEARCH_MAX_FILES, 20);
  assert.match(SEARCH_HINT, /within 100 km of its centre/);
  assert.match(SEARCH_HINT, /at most 20 files/);
  assert.match(SEARCH_HINT, /only when you press/i);
});

test('the search box is the view, trimmed to the radius around its centre when the view is wider', () => {
  assert.deepEqual(searchBox(VIEW), VIEW, 'a view inside the radius is searched whole');
  const wide = { minLon: -130, minLat: 30, maxLon: -110, maxLat: 45 };
  const box = searchBox(wide);
  const reach = reachBox(37.5, -120, SEARCH_RADIUS_KM);
  for (const k of ['minLon', 'minLat', 'maxLon', 'maxLat']) assert.ok(Math.abs(box[k] - reach[k]) < 1e-9, k);
});

test('the files a search reads are those meeting its box, for the layers on, nearest the centre first, bounded', () => {
  const files = [
    file('far.json', 'roadCameras', { minLon: -122, minLat: 36.9, maxLon: -121, maxLat: 37 }),
    file('mid.json', 'roadCameras', { minLon: -122, minLat: 36.5, maxLon: -121, maxLat: 36.6 }),
    file('off.json', 'parkCameras', { minLon: -122, minLat: 36, maxLon: -121, maxLat: 37 }),
    file('away.json', 'roadCameras', { minLon: -90, minLat: 36, maxLon: -89, maxLat: 37 }),
  ];
  const centre = { lat: 36.5, lon: -121.5 };
  const all = searchFiles({ files, box: VIEW, layers: ['roadCameras'], centre, max: 20 });
  assert.deepEqual(all.rows.map((r) => r.file), ['mid.json', 'far.json']);
  assert.equal(all.total, 2);
  const bounded = searchFiles({ files, box: VIEW, layers: ['roadCameras', 'parkCameras'], centre, max: 1 });
  assert.equal(bounded.rows.length, 1);
  assert.equal(bounded.total, 3, 'the total is every file met, not the bounded few');
  assert.deepEqual(searchFiles({ files: null, box: VIEW, layers: ['roadCameras'], centre, max: 20 }), { rows: [], total: 0 });
});

test('a search reads only files within the stated radius, not the whole square the box makes', () => {
  const centre = { lat: 36.5, lon: -121.5 };
  const wide = { minLon: -130, minLat: 30, maxLon: -110, maxLat: 45 };
  const box = searchBox(wide, centre);
  const files = [
    file('near.json', 'roadCameras', { minLon: -121.6, minLat: 36.4, maxLon: -121.4, maxLat: 36.6 }),
    // The square's edge midpoint: 0.85 deg north is about 94 km, inside the radius.
    file('edge.json', 'roadCameras', { minLon: -121.5, minLat: 37.35, maxLon: -121.4, maxLat: 37.4 }),
    // The square's corner: about 94 km north and 89 km east, about 130 km away, inside the square only.
    file('corner.json', 'roadCameras', { minLon: -120.5, minLat: 37.35, maxLon: -120.45, maxLat: 37.4 }),
  ];
  for (const f of files) assert.ok(f.bbox.maxLon >= box.minLon && f.bbox.minLon <= box.maxLon && f.bbox.maxLat >= box.minLat && f.bbox.minLat <= box.maxLat, `${f.file} is outside the square`);
  const found = searchFiles({ files, box, layers: ['roadCameras'], centre, max: 20 });
  assert.deepEqual(found.rows.map((r) => r.file), ['near.json', 'edge.json']);
  assert.equal(found.total, 2, 'a file beyond the radius is in neither the total nor the shown');
  // The bound counts only files within the radius: one within it fills a max of 1, the corner never competes.
  assert.deepEqual(searchFiles({ files, box, layers: ['roadCameras'], centre, max: 1 }).rows.map((r) => r.file), ['near.json']);
});

test('a ref saved under an old id has the same canonical ref as the one the camera carries now', () => {
  assert.equal(canonicalCameraRef('camera:nps-grsm:ABC'), 'camera:nps-webcams:ABC');
  assert.equal(canonicalCameraRef('camera:caltrans-cwwp2:7'), 'camera:caltrans-cwwp2:d05:7');
  assert.equal(canonicalCameraRef('camera:caltrans-cwwp2:d05:7'), 'camera:caltrans-cwwp2:d05:7');
  assert.equal(canonicalCameraRef('camera:hpwren:L-1'), 'camera:hpwren:L-1');
  assert.equal(canonicalCameraRef(null), null);
});

test('the search status states the radius, the centre and what happened', () => {
  const at = { radiusKm: 100, maxFiles: 20, centre: { lat: 36.5, lon: -121.5 } };
  assert.match(searchStatus({ ...at, pending: true }), /^Searching within 100 km of 36\.50, -121\.50\./);
  assert.match(searchStatus({ ...at, total: 0, shown: 0, read: 0, failed: 0 }), /^Searched within 100 km of 36\.50, -121\.50: no camera list covers that area\./);
  assert.match(searchStatus({ ...at, total: 3, shown: 3, read: 3, failed: 0 }), /^Searched within 100 km of 36\.50, -121\.50: 3 of 3 camera files read\.$/);
  const part = searchStatus({ ...at, total: 3, shown: 3, read: 2, failed: 1 });
  assert.match(part, /2 of 3 camera files read/);
  assert.match(part, /1 did not load/);
  const capped = searchStatus({ ...at, total: 31, shown: 20, read: 20, failed: 0 });
  assert.match(capped, /nearest 20 of 31 files/);
  assert.match(capped, /search closer in/i);
  assert.match(searchStatus({ ...at, indexFailed: true }), /camera index did not load/i);
  assert.equal(searchStatus({ ...at, idle: true }), '');
});

test('below the pin zoom a cluster summary counts loaded records per purpose; without counts the old zoom-in stays', () => {
  const base = { scope: 'view', onLayers: 2, belowZoom: true, hasPlace: true, placeName: '', touches: true, loading: false,
    unavailable: false, failedAreas: 0, nothingLoaded: false, inScope: 15, matching: 15, listed: 15, noPicture: 0, unlocated: 0 };
  const counts = { roads: 12, scenery: 3, weather: 0, wildlife: 0 };
  const cluster = cameraListStatus({ ...base, counts });
  assert.equal(cluster.key, 'cluster');
  assert.match(cluster.text, /^15 cameras loaded in this view at this zoom: 12 Roads, 3 Scenery & parks\./);
  assert.match(cluster.text, new RegExp(`Zoom in to list cameras \\(they are listed from zoom ${MIN_PIN_ZOOM}\\)`));
  assert.doesNotMatch(cluster.text, /Weather|Wildlife/, 'a purpose with none is not listed');
  assert.equal(cameraListStatus({ ...base, counts, inScope: 0, matching: 0, listed: 0 }).key, 'zoom-in', 'nothing loaded stays the zoom-in state');
  assert.equal(cameraListStatus({ ...base, counts, searching: true }).key, 'loading', 'a search in flight reads loading');
  assert.equal(cameraListStatus({ ...base, counts, failedAreas: 1 }).notes.join(' ').includes('1 area did not load'), true);
  assert.equal(cameraListStatus({ ...base }).key, 'zoom-in');
  assert.equal(cameraListStatus({ ...base, counts, scope: 'near', belowZoom: true }).key, 'in-scope', 'the near scope is not a cluster');
  assert.equal(CAMERA_PURPOSES.length, 4);
});

const FILES = [
  file('ca-d05.json', 'roadCameras', { minLon: -122.5, minLat: 34.5, maxLon: -119.5, maxLat: 37.5 }),
  file('ca-d06.json', 'roadCameras', { minLon: -121, minLat: 35, maxLon: -117, maxLat: 38 }),
];

test('the files that can hold a saved camera are those whose area holds its position, else every file of its layer', () => {
  assert.deepEqual(filesHolding({ lat: 36.5, lon: -121.7 }, FILES, 'roadCameras').map((f) => f.file), ['ca-d05.json']);
  assert.deepEqual(filesHolding({ lat: null, lon: null }, FILES, 'roadCameras').map((f) => f.file), ['ca-d05.json', 'ca-d06.json']);
  assert.deepEqual(filesHolding({ lat: 10, lon: 10 }, FILES, 'roadCameras').map((f) => f.file), ['ca-d05.json', 'ca-d06.json']);
  assert.deepEqual(filesHolding({ lat: 36.5, lon: -121.7 }, FILES, 'parkCameras'), []);
});

test('saved cameras: found, gone, failed and pending read apart, keyed by source and id', () => {
  const saved = [
    { ref: 'camera:caltrans-cwwp2:d05:1', name: 'Saved One', lat: 36.5, lon: -121.7 },
    { ref: 'camera:caltrans-cwwp2:d05:2', name: 'Saved Two', lat: 36.5, lon: -121.7 },
    { ref: 'camera:nps-webcams:PK-1', name: 'Park One', lat: 35.5, lon: -83 },
    { ref: 'camera:somewhere-else:9', name: 'Unknown Source', lat: 1, lon: 1 },
  ];
  const entries = [{ camera: cam('d05:1'), layer: 'roadCameras' }];
  const layerOf = (p) => ({ 'caltrans-cwwp2': 'roadCameras', 'nps-webcams': 'parkCameras' })[p.ref.split(':')[1]] || null;
  const common = { saved, entries, layerOf, files: FILES, indexState: 'read' };
  const loaded = new Set(['ca-d05.json']);
  const rows = savedCameraRows({ ...common, isLoaded: (f) => loaded.has(f), isFailed: () => false });
  assert.deepEqual(rows.map((r) => [r.place.ref, r.state]), [
    ['camera:caltrans-cwwp2:d05:1', 'listed'],
    ['camera:caltrans-cwwp2:d05:2', 'gone'],
    ['camera:nps-webcams:PK-1', 'gone'],
    ['camera:somewhere-else:9', 'gone'],
  ]);
  assert.equal(rows[0].camera.providerId, 'd05:1');
  assert.equal(rows[0].layer, 'roadCameras');
  // The same id from another source is not the same camera.
  const other = savedCameraRows({ ...common, entries: [{ camera: cam('d05:1', { provider: 'hpwren' }), layer: 'linkCameras' }], isLoaded: (f) => loaded.has(f), isFailed: () => false });
  assert.equal(other[0].state, 'gone');
  // Not yet read: pending. A failed read cannot call it gone: failed. An index not read: pending, or failed.
  assert.equal(savedCameraRows({ ...common, entries: [], isLoaded: () => false, isFailed: () => false })[1].state, 'pending');
  assert.equal(savedCameraRows({ ...common, entries: [], isLoaded: () => false, isFailed: (f) => f === 'ca-d05.json' })[1].state, 'failed');
  assert.equal(savedCameraRows({ ...common, entries: [], indexState: 'pending', isLoaded: () => false, isFailed: () => false })[1].state, 'pending');
  assert.equal(savedCameraRows({ ...common, entries: [], indexState: 'failed', isLoaded: () => false, isFailed: () => false })[1].state, 'failed');
  // A camera found by an old id still lists (the legacy alias), keyed to its saved ref.
  const legacy = savedCameraRows({ ...common, saved: [{ ref: 'camera:caltrans-cwwp2:1', name: 'Old', lat: 36.5, lon: -121.7 }], isLoaded: () => true, isFailed: () => false });
  assert.equal(legacy[0].state, 'listed');
});

test('a saved row says why it has no camera instead of vanishing', () => {
  const place = { ref: 'camera:caltrans-cwwp2:d05:2', name: 'Saved Two' };
  const text = (state, camera = null) => savedRowText({ place, state, camera, layer: null }, { operator: 'Caltrans' });
  assert.deepEqual(text('listed', cam('d05:2')), { name: 'Camera d05:2', meta: 'Caltrans' });
  assert.deepEqual(text('gone'), { name: 'Saved Two', meta: 'Caltrans · no longer in the camera list' });
  assert.deepEqual(text('failed'), { name: 'Saved Two', meta: 'Caltrans · not checked: the camera list did not load' });
  assert.deepEqual(text('pending'), { name: 'Saved Two', meta: 'Caltrans · checking the camera list' });
});

test('the Saved status: saving unavailable, nothing saved, and a count with what could not be shown', () => {
  const s = (o) => savedListStatus({ readState: 'ok', readMessage: '', total: 3, listed: 3, gone: 0, failed: 0, pending: 0, ...o });
  const off = s({ readState: 'unavailable', total: 0, listed: 0 });
  assert.equal(off.key, 'saving-unavailable');
  assert.match(off.text, /^Saving unavailable: this browser is blocking site storage/);
  assert.equal(s({ readState: 'newer', readMessage: 'Written by a newer page.', total: 0, listed: 0 }).key, 'saved-readonly');
  assert.equal(s({ readState: 'newer', readMessage: 'Written by a newer page.', total: 0, listed: 0 }).text, 'Written by a newer page.');
  assert.equal(s({ readState: 'empty', total: 0, listed: 0 }).key, 'none-saved');
  assert.match(s({ readState: 'empty', total: 0, listed: 0 }).text, /Save one from its row or its card/);
  assert.equal(s({}).key, 'saved');
  assert.equal(s({}).text, '3 saved cameras, stored only in this browser.');
  assert.equal(s({ total: 1, listed: 1 }).text, '1 saved camera, stored only in this browser.');
  assert.match(s({ listed: 1, gone: 2 }).notes.join(' '), /2 are no longer in the camera list/);
  assert.match(s({ listed: 2, gone: 1 }).notes.join(' '), /^1 is no longer in the camera list\./);
  assert.match(s({ listed: 2, failed: 1 }).notes.join(' '), /1 could not be checked because the camera list did not load/);
  assert.equal(s({ listed: 2, pending: 1 }).key, 'loading');
});
