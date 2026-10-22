// QQA-06c slice 2: road names in the 3D view. Pure pieces (terrain-roads.js, the bearingOf hook in
// road-labels.js) and the panel's road pass (terrain-view.js setupRoads) against a fake renderer.
// No WebGL, no network: the road service is a function the test hands in. The same pass in a
// real browser over the real MapLibre bundle is terrain-road-names-browser.test.mjs.
// Run: node --test scripts/qcm/terrain-road-names.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupRoads } from '../../themes/headlessmode/static/js/quiet-corners-maps/road-names.js';
import { placeRoadLabels } from '../../themes/headlessmode/static/js/quiet-corners-maps/road-labels.js';
import {
  screenBearingFor, leafletZoomFor, roadNotice, ROAD_NOTICE, ROAD_PASS_DEBOUNCE_MS,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/terrain-roads.js';
import { createTerrainPanel } from '../../themes/headlessmode/static/js/quiet-corners-maps/terrain-view.js';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { measureLabel } from '../../themes/headlessmode/static/js/quiet-corners-maps/name-labels.js';

const BBOX = { minLon: -83.3, minLat: 35.3, maxLon: -83.2, maxLat: 35.4 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

// A west-to-east road and a north-to-south one, near Sylva NC, one local-road feature each.
const feature = (name, paths) => ({ layer: 32, attributes: { name }, geometry: { paths } });
const ENTRIES = groupRoads([
  feature('Grassy Creek Rd', [[[-83.25, 35.35], [-83.24, 35.35]]]),
  feature('Cabin Ridge Rd', [[[-83.23, 35.36], [-83.23, 35.35]]]),
]);

// --- screenBearingFor ------------------------------------------------------------------------

const northUp = (lon, lat) => ({ x: (lon + 83.3) * 20000, y: (35.4 - lat) * 20000 });
// The same ground seen turned a quarter circle: east on the ground runs down the screen.
const quarterTurn = (lon, lat) => ({ x: (35.4 - lat) * 20000, y: (lon + 83.3) * 20000 });

test('screenBearingFor: north-up gives the road its own bearing, a turned view turns it with the road', () => {
  const eastWest = ENTRIES.find((e) => e.label === 'Grassy Creek Rd').anchor;
  assert.equal(screenBearingFor(northUp, eastWest) + 0, 0, 'an east-west road lies flat on a north-up screen');
  const turned = screenBearingFor(quarterTurn, eastWest);
  assert.equal(Math.round(turned), 90, 'the same road runs down a screen turned a quarter circle');
});

test('screenBearingFor: always upright, whatever way the view is turned', () => {
  const a = ENTRIES[0].anchor;
  for (let deg = 0; deg < 360; deg += 15) {
    const t = (deg * Math.PI) / 180;
    const turn = (lon, lat) => { const p = northUp(lon, lat); return { x: p.x * Math.cos(t) - p.y * Math.sin(t), y: p.x * Math.sin(t) + p.y * Math.cos(t) }; };
    const b = screenBearingFor(turn, a);
    assert.ok(b > -90 - 1e-9 && b <= 90 + 1e-9, `${b} at view turn ${deg} is not upright`);
  }
});

test('placeRoadLabels: bearingOf decides the rotation the plate is placed at', () => {
  const base = { toPx: northUp, viewport: { width: 2000, height: 2000 }, measureText: () => ({ width: 100, height: 20 }) };
  const flat = placeRoadLabels(ENTRIES, base).placed.find((p) => p.label === 'Grassy Creek Rd');
  assert.equal(flat.bearing + 0, 0);
  const turned = placeRoadLabels(ENTRIES, { ...base, bearingOf: () => 90 }).placed.find((p) => p.label === 'Grassy Creek Rd');
  assert.equal(turned.bearing, 90, 'the hook reaches the placed label');
});

test('placeRoadLabels: a placed label carries the lon/lat it was anchored at', () => {
  const base = { toPx: northUp, viewport: { width: 2000, height: 2000 }, measureText: () => ({ width: 100, height: 20 }) };
  const p = placeRoadLabels(ENTRIES, base).placed.find((q) => q.label === 'Grassy Creek Rd');
  assert.ok(Math.abs(p.lon + 83.245) < 1e-9 && Math.abs(p.lat - 35.35) < 1e-9, `anchored at ${p.lon},${p.lat}`);
});

// --- the zoom the 3D camera asks the road service about ---------------------------------------

test('leafletZoomFor: a 512px-tile zoom is one Leaflet zoom lower than the same ground in 256px tiles', () => {
  assert.equal(leafletZoomFor(11), 12);
  assert.equal(leafletZoomFor(11.6), 12, 'never rounded up into a band the view has not reached');
  assert.equal(leafletZoomFor(8.99), 9);
  assert.equal(leafletZoomFor(NaN), 0);
});

// --- the words ---------------------------------------------------------------------------------

test('roadNotice: error, empty, loading, shown and zoomed-out read differently, and error uses 2D\'s own sentence', () => {
  const states = ['loading', 'ok', 'partial', 'empty', 'error', 'far'];
  const texts = states.map((s) => roadNotice(s));
  assert.equal(new Set(texts).size, states.length, `states share a sentence: ${JSON.stringify(texts)}`);
  assert.equal(roadNotice('error'), 'Road names did not load');
  assert.match(roadNotice('ok'), /^Road names: shown$/);
  assert.match(roadNotice('partial'), /More roads than shown/);
  assert.equal(roadNotice('off'), null, 'a row that is off earns no line');
  assert.ok(Object.isFrozen(ROAD_NOTICE));
});

// --- the panel's road pass ---------------------------------------------------------------------

function fakeDoc() {
  return {
    addEventListener() {},
    defaultView: { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} },
    createElement(tag) {
      if (tag === 'canvas') return { getContext: () => ({ font: '', measureText: (t) => ({ width: String(t).length * 7 }) }) };
      return {
        tagName: tag, className: '', textContent: '', style: {}, children: [],
        appendChild(c) { this.children.push(c); return c; },
        replaceChildren(...k) { this.children = k; },
        remove() { this.removed = true; },
      };
    },
  };
}

function fakeRenderer({ zoom = 11 } = {}) {
  const maps = [];
  const maplibregl = {
    Map: class {
      constructor(opts) { this.opts = opts; this.listeners = {}; this.zoom = zoom; this.bounds = BBOX; maps.push(this); }
      on(type, fn) { (this.listeners[type] ||= []).push(fn); }
      off(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
      getCenter() { return { lng: -83.25, lat: 35.35 }; }
      getZoom() { return this.zoom; }
      getBounds() { const b = this.bounds; return { getWest: () => b.minLon, getSouth: () => b.minLat, getEast: () => b.maxLon, getNorth: () => b.maxLat }; }
      project(p) { return northUp(p[0], p[1]); }
      getContainer() { return { clientWidth: 2000, clientHeight: 2000 }; }
      setTerrain() {} setLight() {} resize() {} remove() {}
    },
  };
  return { maplibregl, maps };
}

function openWith(roads, { prefs, zoom } = {}) {
  const { maplibregl, maps } = fakeRenderer({ zoom });
  const doc = fakeDoc();
  const panel = createTerrainPanel({ maplibregl, doc, dispatch: () => {} });
  const container = doc.createElement('div');
  const states = [];
  panel.open({ bboxLonLat: BBOX, container, overlay: { roads: { ...roads, onState: (s) => states.push(s) }, prefs } });
  return { panel, container, map: maps[0], states };
}
const okFetcher = (calls = []) => async (args) => { calls.push(args); return { status: 'ok', entries: ENTRIES }; };
const roadEl = (container) => container.children.find((c) => c.className === 'qc-terrain-roads');

test('3D road pass: on -> loading, then the labels the 2D module would place, at the same size source', async () => {
  const calls = [];
  const { panel, container, states } = openWith({ on: true, fetch: okFetcher(calls) }, { prefs: { size: 'large' } });
  assert.deepEqual(states, ['loading'], 'the first thing said is that road names are on their way');
  await tick();
  assert.deepEqual(states, ['loading', 'ok']);
  const labels = roadEl(container).children;
  assert.deepEqual(labels.map((l) => l.textContent).sort(), ['Cabin Ridge Rd', 'Grassy Creek Rd']);
  for (const l of labels) {
    assert.equal(l.style.fontSize, '18px', 'the label-size setting reaches 3D');
    assert.equal(l.className, 'qc-terrain-road-label');
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].zoom, 12, 'the 3D zoom is asked as the 2D zoom of the same ground');
  assert.deepEqual(calls[0].bbox.minLon < BBOX.minLon && calls[0].bbox.maxLat > BBOX.maxLat, true, 'padded like 2D\'s fetch');
  assert.ok(calls[0].signal, 'the request carries an abort signal');
  panel.close();
});

test('3D road pass: off asks nothing and draws nothing', async () => {
  const calls = [];
  const { panel, container, states } = openWith({ on: false, fetch: okFetcher(calls) });
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(roadEl(container), undefined);
  assert.deepEqual(states, []);
  panel.close();
});

test('3D road pass: below the first road zoom nothing is asked and the state says zoom in', async () => {
  const calls = [];
  const { panel, container, states } = openWith({ on: true, fetch: okFetcher(calls) }, { zoom: 7 });
  await tick();
  assert.equal(calls.length, 0, 'zoom 7 asks the road service for nothing');
  assert.deepEqual(states, ['far']);
  assert.equal(roadEl(container).children.length, 0);
  panel.close();
});

test('3D road pass: a failed request says so and draws nothing; an empty answer is a different state', async () => {
  const failed = openWith({ on: true, fetch: async () => ({ status: 'error', entries: [] }) });
  await tick();
  assert.deepEqual(failed.states, ['loading', 'error']);
  assert.equal(roadEl(failed.container).children.length, 0);
  failed.panel.close();
  const empty = openWith({ on: true, fetch: async () => ({ status: 'empty', entries: [] }) });
  await tick();
  assert.deepEqual(empty.states, ['loading', 'empty']);
  empty.panel.close();
  const thrown = openWith({ on: true, fetch: async () => { throw new Error('boom'); } });
  await tick();
  assert.deepEqual(thrown.states, ['loading', 'error'], 'a thrown fetch is an error, never an empty map');
  thrown.panel.close();
});

test('3D road pass: a stale answer (a newer request replaced it) changes nothing', async () => {
  const { panel, container, states } = openWith({ on: true, fetch: async () => ({ status: 'stale', entries: [] }) });
  await tick();
  assert.deepEqual(states, ['loading']);
  assert.equal(roadEl(container).children.length, 0);
  panel.close();
});

test('3D road pass: a failed refetch keeps the labels already on the relief and says so', async () => {
  let n = 0;
  const { panel, container, states, map } = openWith({ on: true, fetch: async () => (++n === 1 ? { status: 'ok', entries: ENTRIES } : { status: 'error', entries: [] }) });
  await tick();
  assert.equal(roadEl(container).children.length, 2);
  map.bounds = { minLon: -83.6, minLat: 35.6, maxLon: -83.5, maxLat: 35.7 };   // out of the box fetched
  map.listeners.moveend.forEach((f) => f());
  await sleep(ROAD_PASS_DEBOUNCE_MS + 150);
  assert.equal(n, 2, 'leaving the fetched box asks again');
  assert.equal(states.at(-1), 'error');
  assert.equal(roadEl(container).children.length, 2, 'the last labels are kept');
  panel.close();
});

test('3D road pass: the source credit rides on the panel only while roads are on', () => {
  const credit = SOURCES.usgsRoadNames.attribution;
  assert.ok(credit && typeof credit === 'string');
  const seen = [];
  const { maplibregl } = fakeRenderer();
  maplibregl.AttributionControl = class { constructor(o) { seen.push(o.customAttribution); } };
  const doc = fakeDoc();
  const mk = (on) => {
    const panel = createTerrainPanel({ maplibregl, doc, dispatch: () => {} });
    const orig = maplibregl.Map.prototype.addControl;
    maplibregl.Map.prototype.addControl = function add() {};
    panel.open({ bboxLonLat: BBOX, container: doc.createElement('div'), overlay: { roads: { on, fetch: async () => ({ status: 'empty', entries: [] }) } } });
    maplibregl.Map.prototype.addControl = orig;
    panel.close();
  };
  mk(true); mk(false);
  assert.ok(seen[0].includes(credit), 'credit present with roads on');
  assert.ok(!seen[1].includes(credit), 'credit absent with roads off');
});

test('3D road pass: close removes the layer, the listeners and any pending pass', async () => {
  const { panel, container, map } = openWith({ on: true, fetch: okFetcher() });
  await tick();
  panel.close();
  assert.equal(roadEl(container).removed, true);
  assert.deepEqual(panel.debug(), { maps: 0, listeners: 0, objectUrls: 0, inflight: 0 });
  assert.deepEqual([...(map.listeners.moveend || []), ...(map.listeners.pitchend || [])], [], 'the road pass\'s map listeners were taken off');
});

// --- names, roads and the panel's own controls share one screen --------------------------------

// A container that answers reservedFromDom the way the browser would: the panel's controls and
// credit at fixed boxes, each 3D name plate where terrain-view.js put it (centred, as the CSS's
// translate(-50%, -50%) paints it), measured with the plate the placement itself uses.
const plateCtx = { font: '', measureText: (t) => ({ width: String(t).length * 7 }) };
function screenContainer(doc, controls = []) {
  const c = doc.createElement('div');
  const rect = (l, t, w, h) => ({ left: l, top: t, right: l + w, bottom: t + h, width: w, height: h });
  c.getBoundingClientRect = () => rect(0, 0, 2000, 2000);
  c.querySelectorAll = (sel) => {
    const out = [];
    if (sel.includes('.maplibregl-ctrl')) out.push(...controls.map((b) => ({ getBoundingClientRect: () => b })));
    if (sel.includes('.qc-terrain-name-label')) {
      for (const s of nameSpans(c)) {
        const box = nameBox(s);
        out.push({ getBoundingClientRect: () => rect(box.minX, box.minY, box.maxX - box.minX, box.maxY - box.minY) });
      }
    }
    return out;
  };
  return { c, rect };
}
const nameSpans = (c) => c.children.find((k) => k.className === 'qc-terrain-names')?.children || [];
function nameBox(s) {
  const { width: w, height: h } = measureLabel(plateCtx, s.textContent, parseFloat(s.style.fontSize));
  const x = parseFloat(s.style.left), y = parseFloat(s.style.top);
  return { minX: x - w / 2, maxX: x + w / 2, minY: y - h / 2, maxY: y + h / 2 };
}
function roadBox(s) {
  const x = parseFloat(s.style.left), y = parseFloat(s.style.top), w = parseFloat(s.style.width), h = parseFloat(s.style.height);
  return { minX: x - w / 2, maxX: x + w / 2, minY: y - h / 2, maxY: y + h / 2 };
}
const hits = (a, b) => a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
const summit = (id, name, lon, lat) => ({ id, name, kind: 'summit', cls: 'Summit', layer: 5, anchor: [lat, lon] });

test('3D names keep off the panel credit and controls, as road names already do', () => {
  const { maplibregl } = fakeRenderer();
  const doc = fakeDoc();
  const panel = createTerrainPanel({ maplibregl, doc, dispatch: () => {} });
  // The credit strip along the bottom of the canvas (MapLibre's attribution is a .maplibregl-ctrl).
  const credit = { left: 0, top: 1960, right: 2000, bottom: 2000, width: 2000, height: 40 };
  const { c } = screenContainer(doc, [credit]);
  panel.open({
    bboxLonLat: BBOX, container: c,
    overlay: { names: [summit('gnis:1', 'Hog Mountain', -83.25, 35.30075), summit('gnis:2', 'Jones Mountain', -83.28, 35.38)] },
  });
  const spans = nameSpans(c);
  assert.deepEqual(spans.map((s) => s.textContent), ['Jones Mountain'], 'the open name still draws; the one under the credit finds no room');
  const strip = { minX: credit.left, maxX: credit.right, minY: credit.top, maxY: credit.bottom };
  for (const s of spans) assert.ok(!hits(nameBox(s), strip), `${s.textContent} sits on the credit`);
  panel.close();
});

test('3D road names are placed again whenever the names are, so a road never lands on a moved name', async () => {
  const { maplibregl, maps } = fakeRenderer();
  const doc = fakeDoc();
  const panel = createTerrainPanel({ maplibregl, doc, dispatch: () => {} });
  const { c } = screenContainer(doc);
  panel.open({
    bboxLonLat: BBOX, container: c,
    overlay: { names: [summit('gnis:1', 'Hog Mountain', -83.285, 35.385)], roads: { on: true, fetch: okFetcher(), onState: () => {} } },
  });
  await tick();
  const map = maps[0];
  const roads = () => roadEl(c).children;
  assert.ok(roads().some((s) => s.textContent === 'Grassy Creek Rd'), 'the road is lettered before the terrain arrives');
  // The terrain tiles arrive once the view holds still: project() now answers on the relief, which
  // moves everything, and the map goes idle. The name lands where the road label was.
  const shift = { dx: 800, dy: 716 };
  map.project = (p) => { const q = northUp(p[0], p[1]); return { x: q.x + shift.dx, y: q.y + shift.dy }; };
  for (const fn of map.listeners.idle || []) fn();
  await sleep(400);
  assert.equal(nameSpans(c).length, 1);
  const name = nameBox(nameSpans(c)[0]);
  for (const r of roads()) assert.ok(!hits(roadBox(r), name), `${r.textContent} sits on the name it was placed before`);
  panel.close();
});
