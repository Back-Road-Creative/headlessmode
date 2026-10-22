// Unit E1: pure helpers and lifecycle for the lazy 3D terrain panel. No WebGL, no
// dynamic import, no real DOM beyond what Node's test runner already provides --
// the renderer is always a fake injected by the caller (see createTerrainPanel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  terrainStyle, cameraBoundsFor, classifySupport, clampExaggeration,
  createTerrainPanel, trailAnchor, lightPositionFor, MAX_EXAGGERATION, DEFAULT_EXAGGERATION, COPY,
  exaggerationLabelText, createExaggerationControl,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/terrain-view.js';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';

const BBOX = { minLon: -83.0, minLat: 35.4, maxLon: -82.6, maxLat: 35.8 };

test('terrainStyle names exactly the terrarium DEM and the topo base, no other origin', () => {
  const style = terrainStyle({ bboxLonLat: BBOX });
  assert.equal(style.sources.terrainDem.type, 'raster-dem');
  assert.equal(style.sources.terrainDem.encoding, 'terrarium');
  assert.equal(style.sources.terrainDem.tileSize, 256);
  assert.ok(style.sources.terrainDem.tiles[0].startsWith(SOURCES.terrainDem.origin));
  assert.ok(style.sources.topoBase.tiles[0].startsWith(SOURCES.usgsTopo.origin));
  const origins = Object.values(style.sources).map((s) => new URL(s.tiles[0]).origin);
  assert.deepEqual(new Set(origins), new Set([SOURCES.terrainDem.origin, SOURCES.usgsTopo.origin]));
});

test('terrainStyle draws a hillshade layer with only the paint properties this pinned build ships', () => {
  const style = terrainStyle({ bboxLonLat: BBOX });
  const hillshade = style.layers.find((l) => l.type === 'hillshade');
  assert.ok(hillshade, 'a hillshade layer must be present');
  assert.equal(hillshade.paint['hillshade-illumination-anchor'], 'map');
  // MapLibre 6.10.0's vendored bundle carries hillshade-illumination-anchor as a
  // paint property but NOT hillshade-illumination-direction or -altitude (verified
  // against themes/headlessmode/static/vendor/maplibre-gl.mjs: only
  // hillshade-accent-color, hillshade-exaggeration, hillshade-highlight-color,
  // hillshade-illumination-anchor and hillshade-method exist). A paint property this
  // build does not ship must never appear in the style, or the "explicit paint, not
  // global setLight" claim would be untested and silently wrong.
  assert.ok(!('hillshade-illumination-direction' in hillshade.paint));
  assert.ok(!('hillshade-illumination-altitude' in hillshade.paint));
});

test('terrainStyle draws the topo raster layer beneath the hillshade layer', () => {
  const style = terrainStyle({ bboxLonLat: BBOX });
  const topoIdx = style.layers.findIndex((l) => l.source === 'topoBase');
  const hillIdx = style.layers.findIndex((l) => l.type === 'hillshade');
  assert.ok(topoIdx >= 0 && hillIdx >= 0 && topoIdx < hillIdx);
});

test('terrainStyle requires a bbox and clamps exaggeration into the terrain spec', () => {
  assert.throws(() => terrainStyle({}), RangeError);
  const over = terrainStyle({ bboxLonLat: BBOX, exaggeration: 9 });
  assert.equal(over.terrain.exaggeration, MAX_EXAGGERATION);
});

test('lightPositionFor gives the 315/45 NW readability light as a MapLibre light position', () => {
  const [radial, azimuthal, polar] = lightPositionFor({ azimuthDeg: 315, altitudeDeg: 45 });
  assert.ok(radial > 0);
  assert.equal(azimuthal, 315);
  assert.equal(polar, 45); // polar = 90 - altitude
});

test('clampExaggeration never exceeds 1.5x and never drops below the 1x default', () => {
  assert.equal(clampExaggeration(0), DEFAULT_EXAGGERATION);
  assert.equal(clampExaggeration(-3), DEFAULT_EXAGGERATION);
  assert.equal(clampExaggeration(3), MAX_EXAGGERATION);
  assert.equal(clampExaggeration('nonsense'), DEFAULT_EXAGGERATION);
  assert.equal(clampExaggeration(undefined), DEFAULT_EXAGGERATION);
  assert.equal(clampExaggeration(1.5), 1.5);
});

test('cameraBoundsFor pads the snapshot area and clamps to valid lon/lat', () => {
  const [[swLon, swLat], [neLon, neLat]] = cameraBoundsFor(BBOX);
  assert.ok(swLon < BBOX.minLon && swLat < BBOX.minLat);
  assert.ok(neLon > BBOX.maxLon && neLat > BBOX.maxLat);
  const [[, clampedLat]] = cameraBoundsFor({ minLon: -83, minLat: -89, maxLon: -82, maxLat: -88 });
  assert.ok(clampedLat >= -85);
});

// E2: the capability-notice copy (brief item 4/5) -- plain language, no jargon
// like "drape" or "raster" leaking into what a reader sees, and each status word
// distinct from the other two so the notice list never reads ambiguous.
test('COPY carries a distinct, plain-language string for each capability-notice status', () => {
  assert.equal(typeof COPY.noticeHeading, 'string');
  assert.ok(COPY.noticeHeading.length > 0);
  const statuses = [COPY.noticeShown, COPY.noticeLoading, COPY.noticeAvailable2d];
  for (const s of statuses) assert.equal(typeof s, 'string');
  assert.equal(new Set(statuses).size, statuses.length, 'two notice statuses read identically');
  assert.doesNotMatch(COPY.noticeAvailable2d.toLowerCase(), /raster|drape/);
});

test('classifySupport: no WebGL means unsupported and carries the reason through', () => {
  assert.deepEqual(classifySupport({ webgl: false }), { supported: false, reason: 'no-webgl', reducedMotion: false });
  assert.deepEqual(classifySupport({ webgl: true, reducedMotion: true }), { supported: true, reason: null, reducedMotion: true });
});

// A fake renderer: enough of MapLibre's Map surface for the lifecycle to exercise
// against, with no WebGL and no real DOM canvas.
function fakeRenderer() {
  const removed = [];
  const maplibregl = {
    Map: class {
      constructor(opts) {
        this.opts = opts;
        this._center = { lng: 0, lat: 0 };
        this._zoom = 10;
        this._pitch = 0;
        this._bearing = 0;
        this._listeners = {};
      }
      on(type, fn) { (this._listeners[type] ||= []).push(fn); }
      getCenter() { return this._center; }
      getZoom() { return this._zoom; }
      getPitch() { return this._pitch; }
      getBearing() { return this._bearing; }
      jumpTo(opts) {
        if ('pitch' in opts) this._pitch = opts.pitch;
        if ('bearing' in opts) this._bearing = opts.bearing;
        if ('center' in opts) this._center = opts.center;
        if ('zoom' in opts) this._zoom = opts.zoom;
      }
      setTerrain() {}
      setLight(light) { this._light = light; }
      resize() {}
      remove() { removed.push(this); }
    },
  };
  return { maplibregl, removed };
}

function fakeDoc() {
  const listeners = {};
  return {
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    defaultView: {
      matchMedia: () => ({ matches: false }),
      addEventListener() {}, removeEventListener() {},
    },
    // QUX-05b: enough of createElement for setupNames' names layer (plain
    // elements with a settable style/className/textContent) and for
    // measureName's canvas 2D text-measurement path.
    createElement(tag) {
      if (tag === 'canvas') {
        return { getContext: () => ({ font: '', measureText: (text) => ({ width: String(text).length * 6 }) }) };
      }
      return {
        tagName: tag, className: '', textContent: '', style: {}, dataset: {}, children: [],
        appendChild(child) { this.children.push(child); return child; },
        replaceChildren(...kids) { this.children = kids; },
      };
    },
    _listeners: listeners,
  };
}

/** A fake renderer wide enough to exercise setupNames' 3D placement path
 *  (map.project/getContainer/queryTerrainElevation, none of which the
 *  lifecycle-only fakeRenderer() above provides). `project` mirrors
 *  name-labels.test.mjs's own toPx convention ((lon+100)*40, (50-lat)*40) so
 *  the same "1 degree apart never collides" spacing works here too. No
 *  queryTerrainElevation -- sampleElevation's fallback (0 everywhere) means
 *  labelOccluded never fires, so placement is limited only by the density
 *  cap and priority order, exactly like the pure name-labels.js tests. */
function fakeNamesRenderer({ zoom = 10 } = {}) {
  const removed = [];
  const maplibregl = {
    Map: class {
      constructor(opts) { this.opts = opts; this._listeners = {}; }
      on(type, fn) { (this._listeners[type] ||= []).push(fn); }
      getCenter() { return { lng: 0, lat: 0 }; }
      getZoom() { return zoom; }
      project([lon, lat]) { return { x: (lon + 100) * 40, y: (50 - lat) * 40 }; }
      getContainer() { return { clientWidth: 5000, clientHeight: 3000 }; }
      setTerrain() {}
      setLight() {}
      resize() {}
      remove() { removed.push(this); }
    },
  };
  return { maplibregl, removed };
}

test('open/close x10 with a fake renderer leaves every debug() counter at 0 and calls remove() exactly 10 times', () => {
  const { maplibregl, removed } = fakeRenderer();
  const doc = fakeDoc();
  const win = { addEventListener() {}, removeEventListener() {} };
  const events = [];
  const panel = createTerrainPanel({ maplibregl, doc, win, dispatch: (d) => events.push(d) });
  for (let i = 0; i < 10; i += 1) {
    panel.open({ bboxLonLat: BBOX, container: {} });
    panel.close();
  }
  assert.deepEqual(panel.debug(), { maps: 0, listeners: 0, objectUrls: 0, inflight: 0 });
  assert.equal(removed.length, 10);
});

test('qc:terrain-panel open/close events are dispatched in order', () => {
  const { maplibregl } = fakeRenderer();
  const doc = fakeDoc();
  const events = [];
  const panel = createTerrainPanel({ maplibregl, doc, dispatch: (d) => events.push(d) });
  panel.open({ bboxLonLat: BBOX, container: {} });
  panel.close();
  assert.deepEqual(events, [{ open: true }, { open: false }]);
});

test('the exaggeration control never exceeds the labelled 1.5x maximum', () => {
  const { maplibregl } = fakeRenderer();
  const doc = fakeDoc();
  const panel = createTerrainPanel({ maplibregl, doc, dispatch: () => {} });
  panel.open({ bboxLonLat: BBOX, container: {} });
  assert.equal(panel.setExaggeration(4), MAX_EXAGGERATION);
  assert.equal(panel.setExaggeration(-1), DEFAULT_EXAGGERATION);
  panel.close();
});

// QQA-11 slice 2: the exaggeration label says what the view is doing. Ticked, it states that the
// relief is steepened and by how much; unticked, it goes back. The factor is read from
// MAX_EXAGGERATION, never retyped, so a change to the maximum cannot leave the label lying.
test('exaggerationLabelText states the exaggeration, and its factor, only while it is on', () => {
  const on = exaggerationLabelText(true);
  const off = exaggerationLabelText(false);
  assert.notEqual(on, off, 'the label must change when the box is ticked');
  assert.ok(on.includes(`${MAX_EXAGGERATION}×`), `ticked label must carry the factor: ${on}`);
  assert.match(on, /exaggerated/i);
  assert.match(on, /not true scale/i);
  assert.doesNotMatch(off, /not true scale/i, 'the unticked label must not claim an exaggeration');
});

/** Just enough DOM for createExaggerationControl: elements with children, attributes and listeners. */
function exagDoc() {
  const el = (tag) => ({
    tagName: tag, children: [], attrs: {}, listeners: {}, _text: '', checked: false,
    set textContent(v) { this._text = String(v); this.children = []; },
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    append(...kids) { this.children.push(...kids); },
    fire(type) { for (const fn of this.listeners[type] || []) fn(); },
  });
  return { createElement: el };
}

test('createExaggerationControl rewrites its visible label on tick and untick, and sets the exaggeration', () => {
  const calls = [];
  const { label, toggle } = createExaggerationControl(exagDoc(), (value) => calls.push(value));
  assert.equal(label.textContent, exaggerationLabelText(false));
  toggle.checked = true; toggle.fire('change');
  assert.equal(label.textContent, exaggerationLabelText(true), 'ticked: the label states the exaggeration');
  toggle.checked = false; toggle.fire('change');
  assert.equal(label.textContent, exaggerationLabelText(false), 'unticked: the label goes back');
  assert.deepEqual(calls, [MAX_EXAGGERATION, DEFAULT_EXAGGERATION]);
  assert.equal(label.children[0], toggle, 'the checkbox stays inside its label');
  assert.equal(toggle.attrs['aria-label'], `Exaggerated terrain (${MAX_EXAGGERATION}×)`, 'the control keeps a fixed accessible name');
});

test('resetView jumps back to the initial center/zoom with bearing and pitch at 0, never animated', () => {
  const { maplibregl } = fakeRenderer();
  const doc = fakeDoc();
  const panel = createTerrainPanel({ maplibregl, doc, dispatch: () => {} });
  panel.open({ bboxLonLat: BBOX, container: {} });
  panel.tilt(30);
  panel.resetView();
  // Lifecycle exposes no raw map reference outside the module; assert via the
  // observable effect instead -- resetView put pitch back to 0, so tilting by 0
  // from here must read back exactly 0, not 30.
  assert.equal(panel.tilt(0), 0);
  panel.close();
});

test('tilt clamps to a sane range and never goes negative', () => {
  const { maplibregl } = fakeRenderer();
  const doc = fakeDoc();
  const panel = createTerrainPanel({ maplibregl, doc, dispatch: () => {} });
  panel.open({ bboxLonLat: BBOX, container: {} });
  assert.equal(panel.tilt(-100), 0);
  assert.equal(panel.tilt(1000), 60);
  panel.close();
});

test('close never touches anything outside this module (no Leaflet/global reference is read or written)', () => {
  const { maplibregl } = fakeRenderer();
  const doc = fakeDoc();
  const panel = createTerrainPanel({ maplibregl, doc, dispatch: () => {} });
  const before = { ...globalThis };
  panel.open({ bboxLonLat: BBOX, container: {} });
  panel.close();
  assert.deepEqual(Object.keys(globalThis).sort(), Object.keys(before).sort());
});

// QUX-05b: the 3D names pass (setupNames, via open()'s overlay.names/prefs/
// selectedId) reads the same density/size prefs and selection 2D's renderNames
// does, instead of always falling back to SIZE_SCALE.normal and an unreserved
// budget.
test('setupNames threads prefs.size and selectedId into the 3D placement call', () => {
  const { maplibregl } = fakeNamesRenderer();
  const doc = fakeDoc();
  const panel = createTerrainPanel({ maplibregl, doc, dispatch: () => {} });
  const container = doc.createElement('div');

  // Spaced 1 degree apart at fakeNamesRenderer's project scale (40px/degree),
  // same convention name-labels.test.mjs's manyFeatures() uses -- collision-
  // free by construction, so the sparse cap (15), not incidental overlap, is
  // what would drop the 17th feature.
  // cls: 'Summit' + layer: 5 (terrain-names.js's KINDS table) -- the same
  // fields normalizeFeature would set -- so labelPriorityOrder's minZoom gate
  // (Summit's minZoom is 9, fakeNamesRenderer's getZoom() returns 10) keeps
  // every one of these instead of falling through to UNKNOWN_KIND's minZoom
  // 12 and being silently zoom-filtered before the cap is even reached. Lon
  // starts at -90, not -105 like name-labels.test.mjs's own manyFeatures():
  // that helper never passes a `viewport`, so its negative-x candidates are
  // never bounds-checked -- this test does supply one (setupNames always
  // does), so every anchor has to land on-screen at fakeNamesRenderer's
  // project scale ((lon+100)*40) to begin with.
  const names = [];
  for (let i = 0; i < 16; i++) {
    names.push({ id: `gnis:${i}`, name: `Peak ${String(i).padStart(2, '0')}`, kind: 'summit', cls: 'Summit', layer: 5, anchor: [39, -90 + i] });
  }
  // Sorts last by name once kind ties -- exactly the one a plain priority cap
  // drops. Marking it selectedId must keep its slot instead.
  names.push({ id: 'gnis:selected', name: 'Zzz Worst Priority Peak', kind: 'summit', cls: 'Summit', layer: 5, anchor: [39, -90 + 16] });

  panel.open({
    bboxLonLat: BBOX, container,
    overlay: { names, prefs: { density: 'sparse', size: 'large' }, selectedId: 'gnis:selected' },
  });

  const labelsEl = container.children[0];
  assert.equal(labelsEl.children.length, 15, 'the sparse density cap (15) reaches the 3D panel too');
  assert.ok(
    labelsEl.children.some((el) => el.textContent === 'Zzz Worst Priority Peak'),
    'selectedId reaches placeScreenLabels: the worst-priority name keeps its slot instead of being capped out',
  );
  for (const el of labelsEl.children) {
    assert.equal(el.style.fontSize, '18px', 'prefs.size === "large" reaches every 3D label, not the hardcoded SIZE_SCALE.normal (14px)');
  }
  panel.close();
});

test('trailAnchor picks the on-screen vertex nearest the view centre, and none when the trail is off screen', () => {
  const toPx = ([lon, lat]) => ({ x: lon * 100, y: lat * 100 });
  const project = (lon, lat) => toPx([lon, lat]);
  const trail = { id: 't', name: 'Long Trail', kind: 'trail', layer: 'trail', cls: 'trail', path: [[-5, 1], [1, 1], [4, 1], [9, 1], [30, 1]] };
  const viewport = { width: 1000, height: 300 };
  const camera = { lon: 5, lat: 1, elevation: 3000 };
  const a = trailAnchor(trail, project, viewport, camera);
  assert.equal(a.id, 't');
  assert.equal(a.kind, 'trail');
  assert.deepEqual(a.anchor, [1, 4], 'the vertex at x=400 is the on-screen one nearest the middle (500)');
  const off = trailAnchor({ ...trail, path: [[-5, 1], [30, 1]] }, project, viewport, camera);
  assert.equal(off, null);
  assert.equal(trailAnchor({ ...trail, path: [] }, project, viewport, camera), null);
});

test('trailAnchor skips a vertex hidden behind relief and uses the next visible one', () => {
  const project = (lon, lat) => ({ x: lon * 100, y: lat * 100 });
  const trail = { id: 't', name: 'Long Trail', kind: 'trail', layer: 'trail', cls: 'trail', path: [[4, 1], [8, 1]] };
  const camera = { lon: 5, lat: 1, elevation: 100 };
  // A ridge at lon 4.4 stands between the camera (lon 5) and the vertex at lon 4.
  const sampleElevation = (lon) => (lon > 4.3 && lon < 4.6 ? 5000 : 0);
  const a = trailAnchor(trail, project, { width: 1000, height: 300 }, camera, { sampleElevation });
  assert.deepEqual(a.anchor, [1, 8]);
});

// Trails take the "other named feature" zoom gate (12), so these run at 13.
test('a named trail is lettered in 3D with its id on the label, sharing the declutter with the place names', () => {
  const { maplibregl } = fakeNamesRenderer({ zoom: 13 });
  const doc = fakeDoc();
  const panel = createTerrainPanel({ maplibregl, doc, dispatch: () => {} });
  const container = doc.createElement('div');
  const names = [{ id: 'gnis:1', name: 'Some Peak', kind: 'summit', cls: 'Summit', layer: 5, anchor: [39, -90] }];
  const trailLabels = [{ id: 'fx-trail', name: 'Test Trail', kind: 'trail', layer: 'trail', cls: 'trail', path: [[-95, 40], [-94, 40.5]], anchor: [40.5, -94] }];
  panel.open({ bboxLonLat: BBOX, container, overlay: { names, trailLabels, prefs: { density: 'standard', size: 'normal' } } });
  const labelsEl = container.children[0];
  const trailEl = labelsEl.children.find((el) => el.textContent === 'Test Trail');
  assert.ok(trailEl, 'the trail name is lettered');
  assert.equal(trailEl.dataset.trailId, 'fx-trail');
  const peakEl = labelsEl.children.find((el) => el.textContent === 'Some Peak');
  assert.ok(peakEl, 'the place name is still lettered');
  assert.equal(peakEl.dataset.trailId, undefined, 'only trail labels carry a trail id');
  panel.close();
  assert.deepEqual(panel.debug(), { maps: 0, listeners: 0, objectUrls: 0, inflight: 0 });
});

test('a trail with no place names still opens the label layer', () => {
  const { maplibregl } = fakeNamesRenderer({ zoom: 13 });
  const doc = fakeDoc();
  const panel = createTerrainPanel({ maplibregl, doc, dispatch: () => {} });
  const container = doc.createElement('div');
  panel.open({ bboxLonLat: BBOX, container, overlay: { names: [], trailLabels: [{ id: 'x', name: 'Only Trail', kind: 'trail', layer: 'trail', cls: 'trail', path: [[-95, 40], [-94, 40.5]], anchor: [40.5, -94] }] } });
  assert.equal(container.children[0].children.length, 1);
  panel.close();
});

/** A fake renderer that keeps a style the way MapLibre does: a second addSource/addLayer with an
 *  id already present throws, and a source cannot be removed while a layer still uses it. */
function fakeStyleRenderer() {
  const maplibregl = {
    Map: class {
      constructor() { this.sources = {}; this.layers = []; }
      on() {}
      getCenter() { return { lng: 0, lat: 0 }; }
      getZoom() { return 10; }
      setTerrain() {}
      setLight() {}
      resize() {}
      remove() {}
      addSource(id, src) { if (this.sources[id]) throw new Error(`source ${id} exists`); this.sources[id] = src; }
      addLayer(layer) { if (this.layers.some((l) => l.id === layer.id)) throw new Error(`layer ${layer.id} exists`); this.layers.push(layer); }
      getLayer(id) { return this.layers.find((l) => l.id === id); }
      getSource(id) { return this.sources[id]; }
      removeLayer(id) { this.layers = this.layers.filter((l) => l.id !== id); }
      removeSource(id) {
        if (this.layers.some((l) => l.source === id)) throw new Error(`source ${id} in use`);
        delete this.sources[id];
      }
    },
  };
  return { maplibregl };
}

const TRAILS_ROW = { id: 'trails', label: 'Trails', group: 'federal', drape: 'line' };
const trailLine = (id) => ({ id, symbolKey: 'trail-nst', name: id, paths: [[[-83, 35.5], [-82.9, 35.6]]] });
const trailsOverlay = (state, features) => ({
  registry: [TRAILS_ROW], on: { trails: true }, statesById: { trails: state }, featuresByLayerId: { trails: features },
});

test('refreshOverlay drapes a layer whose data arrived after open, and reports it no longer loading', () => {
  const { maplibregl } = fakeStyleRenderer();
  const panel = createTerrainPanel({ maplibregl, doc: fakeDoc(), dispatch: () => {} });
  const opened = panel.open({ bboxLonLat: BBOX, container: {}, overlay: trailsOverlay('loading', []) });
  assert.deepEqual(panel.overlayReport(), [{ id: 'trails', reason: 'loading' }]);
  assert.deepEqual(Object.keys(opened.map.sources), []);

  panel.refreshOverlay(trailsOverlay('ready', [trailLine('t1')]));
  assert.deepEqual(Object.keys(opened.map.sources), ['qc-drape-trails']);
  assert.equal(opened.map.sources['qc-drape-trails'].data.features.length, 1);
  assert.deepEqual(panel.overlayReport(), []);
});

test('refreshOverlay replaces what it drew before (no duplicate ids) and clears a layer turned off', () => {
  const { maplibregl } = fakeStyleRenderer();
  const panel = createTerrainPanel({ maplibregl, doc: fakeDoc(), dispatch: () => {} });
  const opened = panel.open({ bboxLonLat: BBOX, container: {}, overlay: trailsOverlay('ready', [trailLine('t1')]) });
  const before = opened.map.layers.map((l) => l.id);
  assert.ok(before.length > 0, 'nothing draped at open');

  panel.refreshOverlay(trailsOverlay('ready', [trailLine('t1'), trailLine('t2')]));
  assert.deepEqual(opened.map.layers.map((l) => l.id), before);
  assert.equal(opened.map.sources['qc-drape-trails'].data.features.length, 2);

  panel.refreshOverlay({ ...trailsOverlay('ready', [trailLine('t1')]), on: { trails: false } });
  assert.deepEqual(opened.map.layers, []);
  assert.deepEqual(Object.keys(opened.map.sources), []);
});

// MapLibre's isStyleLoaded() is false whenever a source is still fetching tiles, and 'load' waits for
// the first full render, so on a slow tile host neither ever says go. The drape waits only for the
// style itself ('style.load'), once; a refresh after that draws at once.
test('the drape waits for the style, not the tiles: it draws on style.load, and a later refresh draws at once', () => {
  const { maplibregl } = fakeStyleRenderer();
  const Base = maplibregl.Map;
  let styleDone = false, tilesDone = false;
  const handlers = [];
  maplibregl.Map = class extends Base {
    isStyleLoaded() { return styleDone && tilesDone; }
    once(type, fn) { if (type === 'style.load') handlers.push(fn); }
  };
  const panel = createTerrainPanel({ maplibregl, doc: fakeDoc(), dispatch: () => {} });
  const opened = panel.open({ bboxLonLat: BBOX, container: {}, overlay: trailsOverlay('ready', [trailLine('t1')]) });
  assert.deepEqual(Object.keys(opened.map.sources), [], 'draped before the style was parsed');
  styleDone = true;
  for (const fn of handlers.splice(0)) fn();
  assert.deepEqual(Object.keys(opened.map.sources), ['qc-drape-trails'], 'style.load did not drape');
  panel.refreshOverlay(trailsOverlay('ready', [trailLine('t1'), trailLine('t2')]));
  assert.equal(opened.map.sources['qc-drape-trails'].data.features.length, 2, 'the refresh waited for a style.load that already happened');
});

test('refreshOverlay while closed does nothing', () => {
  const { maplibregl } = fakeStyleRenderer();
  const panel = createTerrainPanel({ maplibregl, doc: fakeDoc(), dispatch: () => {} });
  assert.doesNotThrow(() => panel.refreshOverlay(trailsOverlay('ready', [trailLine('t1')])));
});
