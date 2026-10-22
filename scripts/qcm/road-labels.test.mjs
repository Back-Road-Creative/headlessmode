// QQA-05r-2: the pure half of road names on the screen map -- reserved boxes read from a DOM
// (a fake one here), placement under the road cap, and the debounce the moveend handler uses.
// The browser half is road-labels-browser.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reservedFromDom, rotatedBox, placeRoadLabels, createDebouncer, RESERVED_SELECTORS }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/road-labels.js';
import { ROAD_DENSITY_CAP } from '../../themes/headlessmode/static/js/quiet-corners-maps/road-names.js';

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
const fakeDom = (origin, found) => {
  const asked = [];
  return {
    asked,
    getBoundingClientRect: () => origin,
    querySelectorAll: (sel) => { asked.push(sel); return found.map((r) => ({ getBoundingClientRect: () => r })); },
  };
};

test('reservedFromDom: boxes are in container pixels, padded, and empty rects reserve nothing', () => {
  const dom = fakeDom(rect(100, 50, 800, 600), [rect(150, 90, 60, 20), rect(0, 0, 0, 0), rect(300, 200, 40, 0)]);
  const boxes = reservedFromDom(dom, undefined, 2);
  assert.deepEqual(boxes, [{ minX: 48, maxX: 112, minY: 38, maxY: 62 }]);
  assert.deepEqual(dom.asked, [RESERVED_SELECTORS]);
});

test('reservedFromDom asks for towns, GNIS names and cameras', () => {
  for (const sel of ['.qc-place-label', '.qcm-name-label', '.qcm-camera-pin']) {
    assert.ok(RESERVED_SELECTORS.includes(sel), `${sel} must be reserved`);
  }
});

// QQA-05r-3: the map's own controls (zoom, 3D, view buttons, search, legend, credit, scale)
// live inside the map container, so one selector reserves them all.
test('RESERVED_SELECTORS names the map controls, and reservedFromDom returns a control box', () => {
  assert.ok(RESERVED_SELECTORS.split(',').map((x) => x.trim()).includes('.leaflet-control'), '.leaflet-control must be reserved');
  const dom = fakeDom(rect(0, 0, 800, 600), [rect(10, 10, 30, 60)]);
  assert.deepEqual(reservedFromDom(dom), [{ minX: 8, maxX: 42, minY: 8, maxY: 72 }]);
  assert.deepEqual(dom.asked, [RESERVED_SELECTORS]);
});

test('rotatedBox: 0 and 90 degrees swap width and height; 45 is the diagonal', () => {
  const flat = rotatedBox(10, 10, 40, 10, 0);
  assert.deepEqual([flat.maxX - flat.minX, flat.maxY - flat.minY], [40, 10]);
  const up = rotatedBox(10, 10, 40, 10, 90);
  assert.ok(Math.abs(up.maxX - up.minX - 10) < 1e-9 && Math.abs(up.maxY - up.minY - 40) < 1e-9);
  const diag = rotatedBox(0, 0, 40, 10, 45);
  assert.ok(Math.abs((diag.maxX - diag.minX) - (40 + 10) * Math.SQRT1_2) < 1e-9);
});

// A road is a horizontal line at lat `y`; (lon, lat) maps 1:1 to pixels.
const road = (key, y, x0 = 100, x1 = 300, rank = 3) => ({
  key, label: key, classKey: 'local', rank, lengthM: x1 - x0, parts: [[[x0, y], [x1, y]]],
  longest: [[x0, y], [x1, y]], anchor: { lon: (x0 + x1) / 2, lat: y, bearing: 0 },
});
const base = {
  toPx: (lon, lat) => ({ x: lon, y: lat }), viewport: { width: 600, height: 400 },
  measureText: (t) => ({ width: 60, height: 20 }),
};

test('placeRoadLabels: a clear road is placed centred on its anchor', () => {
  const { placed, dropped } = placeRoadLabels([road('A', 100)], base);
  assert.equal(dropped, 0);
  assert.deepEqual([placed[0].x, placed[0].y, placed[0].bearing, placed[0].sizePx], [200, 100, 0, 14]);
});

test('placeRoadLabels: a reserved box wins, and the road moves to another spot or drops', () => {
  // The whole road is covered: dropped.
  const covered = placeRoadLabels([road('A', 100)], { ...base, reserved: [{ minX: 0, maxX: 600, minY: 80, maxY: 120 }] });
  assert.equal(covered.placed.length, 0);
  assert.equal(covered.dropped, 1);
  // Only its middle is covered, and it has a second segment on clear ground: it moves there.
  const bent = { ...road('B', 100), parts: [[[100, 100], [200, 100], [200, 300]]], anchor: { lon: 150, lat: 100, bearing: 0 } };
  const moved = placeRoadLabels([bent], { ...base, reserved: [{ minX: 100, maxX: 200, minY: 80, maxY: 120 }] });
  assert.equal(moved.placed.length, 1);
  assert.deepEqual([moved.placed[0].x, moved.placed[0].y], [200, 200]);
});

test('placeRoadLabels: two roads never overlap; the earlier (more important) one keeps the spot', () => {
  const { placed, dropped } = placeRoadLabels([road('US 74', 100), road('Main St', 105)], base);
  assert.deepEqual(placed.map((p) => p.label), ['US 74']);
  assert.equal(dropped, 1);
});

test('placeRoadLabels: a label that would leave the viewport is not placed there', () => {
  const edge = { ...road('E', 100, 0, 20), anchor: { lon: 10, lat: 100, bearing: 0 } };
  assert.equal(placeRoadLabels([edge], base).placed.length, 0);
});

test('placeRoadLabels: the cap is ROAD_DENSITY_CAP[density], standard when unknown, and size follows the pref', () => {
  const count = (prefs, list) => placeRoadLabels(list, { ...base, viewport: { width: 2000, height: 2000 }, measureText: () => ({ width: 10, height: 4 }), prefs }).placed.length;
  const wide = Array.from({ length: 60 }, (_, i) => road(`W${i}`, 10 + i * 10, 100, 300));
  assert.equal(count({ density: 'sparse' }, wide), ROAD_DENSITY_CAP.sparse);
  assert.equal(count({ density: 'standard' }, wide), ROAD_DENSITY_CAP.standard);
  assert.equal(count({ density: 'more' }, wide), ROAD_DENSITY_CAP.more);
  assert.equal(count({ density: 'bogus' }, wide), ROAD_DENSITY_CAP.standard);
  assert.equal(count({}, wide), ROAD_DENSITY_CAP.standard);
  assert.equal(placeRoadLabels([road('A', 100)], { ...base, prefs: { size: 'large' } }).placed[0].sizePx, 18);
});

test('createDebouncer: latest wins, one run per burst, cancel drops it', () => {
  const pending = new Map(); let id = 0;
  const timers = { set: (fn, ms) => { id += 1; pending.set(id, { fn, ms }); return id; }, clear: (h) => pending.delete(h) };
  const seen = [];
  const d = createDebouncer((v) => seen.push(v), 400, timers);
  d.call('a'); d.call('b'); d.call('c');
  assert.equal(pending.size, 1, 'each call replaces the pending timer');
  assert.equal([...pending.values()][0].ms, 400);
  assert.equal(d.pending(), true);
  const [handle, { fn }] = [...pending.entries()][0];
  pending.delete(handle); fn();
  assert.deepEqual(seen, ['c']);
  assert.equal(d.pending(), false);
  d.call('d'); d.cancel();
  assert.equal(pending.size, 0);
  assert.deepEqual(seen, ['c']);
});
