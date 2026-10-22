// Quiet Corners Field Maps — lazy 3D terrain panel (unit E1).
//
// Leaflet stays the canonical map and print owner (plan §4.6). This module never
// touches Leaflet's view, the print selection or the print recipe; it only reads
// the current area once, on open, to build a SEPARATE MapLibre scene in a dialog
// over the map. Nothing here loads before the reader presses the "3D" button:
// no vendored MapLibre module, no MapLibre CSS, no DEM or base-tile request.
//
// The renderer (MapLibre) is always taken as a parameter rather than imported at
// the top of the file, so the pure logic below (terrainStyle, cameraBoundsFor,
// classifySupport, clampExaggeration, and the open/close lifecycle) can be
// exercised with a fake renderer and no WebGL, no dynamic import and no DOM
// beyond what Node's test runner already provides.
import { SOURCES } from './source-registry.js';
// E2: draped overlays/capability notices reuse D0's own emphasis contract (no
// second palette -- see terrain-overlays.js's own header note), and names-on-
// relief reuse N2's screen-declutter algorithm verbatim (same collision rule as
// 2D) rather than a second placement algorithm for the 3D surface.
import { overlayLayersFor, capabilityNotices, layerToggleRows, labelOccluded, OCCLUSION_SAMPLES } from './terrain-overlays.js';
import { placeScreenLabels, measureLabel } from './name-labels.js';
// QQA-06c-2: road names over the relief reuse the screen map's own modules (which roads, the
// placement, the request); terrain-roads.js is only what a turned, tilted view changes.
import { layersForZoom } from './road-names.js';
import { placeRoadLabels, reservedFromDom } from './road-labels.js';
import {
  leafletZoomFor, padBox, boxContains, screenBearingFor, roadNotice,
  ROAD_PASS_DEBOUNCE_MS, RESERVED_3D_SELECTORS,
} from './terrain-roads.js';

// The panel's MapLibre controls, the credit among them: no 3D label is laid over them.
const PANEL_CONTROLS_3D = '.maplibregl-ctrl';

export const MAX_EXAGGERATION = 1.5;
export const DEFAULT_EXAGGERATION = 1;

// Read from the registry rather than re-typed here, so a change to either
// source's URL cannot drift silently out of sync with this module.
const DEM = SOURCES.terrainDem;
const TOPO = SOURCES.usgsTopo;
export const TERRAIN_DEM_TILE_URL = DEM.serviceUrl;
export const TOPO_BASE_TILE_URL = TOPO.tile.urlTemplate;

// Attribution stays visible in the panel at all times (plan §4.6/§7.4): the DEM's
// full mixed-source wording (never "3DEP" alone) plus the topo base's, read from the
// registry rather than retyped here so a registry edit cannot drift out of sync.
export const TERRAIN_ATTRIBUTION = [DEM.attribution, TOPO.attribution];

export const COPY = Object.freeze({
  noWebgl: '3D terrain needs WebGL, which this browser has turned off.',
  loadFailed: '3D terrain could not load.',
  demError: 'Terrain data could not load for part of this view.',
  contextLost: '3D terrain lost its display context and closed.',
  // E2 capability notices (brief item 4): every layer on in 2D is either drawn
  // here or explicitly disclosed as staying 2D-only -- never a silent gap.
  noticeHeading: 'Layers in this view',
  noticeShown: 'shown',
  noticeLoading: 'loading in 2D first',
  noticeAvailable2d: 'Available in 2D',
});

/** The exaggeration checkbox's visible label. Unticked it names the choice; ticked it states what the
 *  view is now doing -- relief steepened by MAX_EXAGGERATION, so not true scale -- because nothing else
 *  in the panel says so. The factor is read from the constants, never retyped. */
export function exaggerationLabelText(exaggerated) {
  return exaggerated
    ? `Terrain exaggerated ${MAX_EXAGGERATION}× (not true scale)`
    : `Exaggeration: ${DEFAULT_EXAGGERATION}× (default) / ${MAX_EXAGGERATION}× — exaggerated`;
}

/** The labelled checkbox: ticking it asks `onChange` for MAX_EXAGGERATION and rewrites the visible
 *  label to say so, clearing it asks for the default and puts the label back. The accessible name stays
 *  fixed, so a screen reader hears the same control whichever state it is in. */
export function createExaggerationControl(doc, onChange) {
  const label = doc.createElement('label');
  const toggle = doc.createElement('input');
  toggle.type = 'checkbox';
  // A plain literal, so the docs test finds the whole name among the shipped strings; terrain-view.test.mjs
  // holds it to MAX_EXAGGERATION.
  toggle.setAttribute('aria-label', 'Exaggerated terrain (1.5×)');
  const text = doc.createElement('span');
  text.textContent = exaggerationLabelText(false);
  toggle.addEventListener('change', () => {
    text.textContent = exaggerationLabelText(toggle.checked);
    onChange(toggle.checked ? MAX_EXAGGERATION : DEFAULT_EXAGGERATION);
  });
  label.append(toggle, text);
  return { label, toggle };
}

/** Never above the labelled maximum, never below the labelled default. A bad or
 *  missing value falls back to 1x rather than throwing -- the default is always
 *  a legitimate exaggeration to render. */
export function clampExaggeration(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_EXAGGERATION;
  return Math.min(MAX_EXAGGERATION, Math.max(DEFAULT_EXAGGERATION, n));
}

// Plan §4.6 asks for hillshade direction/altitude/anchor as paint properties, "global
// setLight is not a substitute" -- true of the MapLibre style spec in general, but NOT
// of the exact pinned 6.10.0 vendor bundle: grepping maplibre-gl.mjs for `hillshade-*`
// paint properties turns up only hillshade-accent-color, hillshade-exaggeration,
// hillshade-highlight-color, hillshade-illumination-anchor and hillshade-method --
// never hillshade-illumination-direction or hillshade-illumination-altitude. Anchor
// (map vs viewport) IS a paint property here, so it stays on the layer; direction and
// altitude are not, so they are set through the one global map.setLight() call this
// panel ever makes for its one hillshade layer. That is a documented exception to
// "never setLight," not a silent substitution -- see lightPositionFor() and its call
// in createTerrainPanel.open() below.
const READABILITY_LIGHT = Object.freeze({ azimuthDeg: 315, altitudeDeg: 45 });

/** A MapLibre `light.position` triple [radial, azimuthal, polar] for the fixed
 *  readability light (plan §4.6: northwest/45°). `polar` is measured from the
 *  vertical, so altitude-from-horizon is inverted: 90 - altitudeDeg. */
export function lightPositionFor({ azimuthDeg = READABILITY_LIGHT.azimuthDeg, altitudeDeg = READABILITY_LIGHT.altitudeDeg } = {}) {
  return [1.15, azimuthDeg, 90 - altitudeDeg];
}

/** A MapLibre style JSON for the snapshot area: a terrarium raster-dem source, a
 *  hillshade layer with the anchor this build's paint spec supports, and the
 *  existing USGS topo raster draped on top. No other origin appears -- the two
 *  hosts here are exactly the DEM and the base tiles already declared in
 *  source-registry.js. Direction/altitude are applied separately via setLight()
 *  (see the note above `lightPositionFor`). */
export function terrainStyle({ bboxLonLat, exaggeration = DEFAULT_EXAGGERATION } = {}) {
  if (!bboxLonLat) throw new RangeError('terrainStyle requires bboxLonLat');
  return {
    version: 8,
    sources: {
      terrainDem: {
        type: 'raster-dem', tiles: [TERRAIN_DEM_TILE_URL], tileSize: 256,
        encoding: 'terrarium', maxzoom: DEM.tile.maxNativeZoomObserved,
      },
      topoBase: { type: 'raster', tiles: [TOPO_BASE_TILE_URL], tileSize: 256 },
    },
    layers: [
      { id: 'qc-terrain-topo', type: 'raster', source: 'topoBase' },
      {
        id: 'qc-terrain-hillshade', type: 'hillshade', source: 'terrainDem',
        // 'map' keeps the light anchored to the ground rather than rotating with
        // the camera -- the one paint property 6.10.0 ships for this.
        paint: { 'hillshade-illumination-anchor': 'map' },
      },
    ],
    terrain: { source: 'terrainDem', exaggeration: clampExaggeration(exaggeration) },
  };
}

/** The first version constrains panning to the qualified area (plan §4.6): pad the
 *  snapshot bbox by a fraction of its own size and clamp to valid lon/lat. */
export function cameraBoundsFor(bboxLonLat, { padFactor = 0.15 } = {}) {
  const { minLon, minLat, maxLon, maxLat } = bboxLonLat;
  const padLon = (maxLon - minLon) * padFactor, padLat = (maxLat - minLat) * padFactor;
  const clampLon = (v) => Math.max(-180, Math.min(180, v));
  const clampLat = (v) => Math.max(-85, Math.min(85, v));
  return [
    [clampLon(minLon - padLon), clampLat(minLat - padLat)],
    [clampLon(maxLon + padLon), clampLat(maxLat + padLat)],
  ];
}

/** No WebGL -> the panel never imports MapLibre and shows plain copy instead
 *  (§4.6 last bullet, §7.1). Reduced motion is carried through so the caller
 *  knows to use jumpTo rather than an animated camera move. */
export function classifySupport({ webgl, reducedMotion = false } = {}) {
  if (!webgl) return { supported: false, reason: 'no-webgl', reducedMotion };
  return { supported: true, reason: null, reducedMotion };
}

// A canvas 2D context reused for name-label text measurement over the terrain
// canvas -- same lazy-creation trick main.js's own measureName uses, so this
// module still loads under node --test (no DOM there).
let nameCtx = null;
function measureName(doc, text, sizePx) {
  if (!nameCtx) nameCtx = doc.createElement('canvas').getContext('2d');
  // Same face and plate as the 2D label (QQA-05a), so the 3D box matches its paint.
  return measureLabel(nameCtx, text, sizePx);
}

function probeWebgl(doc) {
  try {
    const canvas = doc.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch { return false; }
}

/** The trail's label anchor for this view: of its vertices, the one on screen (inside the
 *  viewport) and not behind relief that is nearest the viewport centre, as a name record
 *  placeScreenLabels can take; null when no vertex qualifies (the trail is off screen or
 *  hidden, so it is not named this pass). Pure given its arguments. */
export function trailAnchor(trail, toPx, viewport, camera, { sampleElevation = () => 0 } = {}) {
  if (!trail || !Array.isArray(trail.path) || !trail.path.length) return null;
  const cx = viewport.width / 2, cy = viewport.height / 2;
  const onScreen = [];
  for (const [lon, lat] of trail.path) {
    const p = toPx(lon, lat);
    if (!p || !(p.x >= 0 && p.y >= 0 && p.x <= viewport.width && p.y <= viewport.height)) continue;
    onScreen.push({ lon, lat, d: Math.hypot(p.x - cx, p.y - cy) });
  }
  onScreen.sort((a, b) => a.d - b.d);
  for (const v of onScreen) {
    const anchor = { lon: v.lon, lat: v.lat, elevation: sampleElevation(v.lon, v.lat) };
    if (!labelOccluded({ anchor, camera, sampleElevation, samples: OCCLUSION_SAMPLES })) {
      return { id: trail.id, name: trail.name, kind: 'trail', layer: trail.layer, cls: trail.cls, anchor: [v.lat, v.lon] };
    }
  }
  return null;
}

/** The lifecycle core: given a renderer (real MapLibre or a fake), tracks every
 *  resource this module opens so a caller (or a test) can prove none of it
 *  survives a close. `dispatch` defaults to a real `qc:terrain-panel` CustomEvent
 *  on `doc`; a test can pass its own to observe ordering without touching the DOM. */
export function createTerrainPanel({ maplibregl, doc = document, win, dispatch } = {}) {
  const w = win || doc.defaultView || (typeof window !== 'undefined' ? window : undefined);
  const send = dispatch || ((detail) => doc.dispatchEvent(new CustomEvent('qc:terrain-panel', { detail })));
  const counters = { maps: 0, listeners: 0, objectUrls: 0, inflight: 0 };
  let current = null;

  function addListener(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    current.listeners.push([target, type, fn, opts]);
    counters.listeners += 1;
  }

  function isOpen() { return !!current; }

  /** A map.on()/map.off() listener, tracked the same way addListener tracks a
   *  DOM one -- close() removes it and the leak counter falls back to zero,
   *  same as every other resource this module opens. MapLibre's Map exposes
   *  on/off, not addEventListener, so it needs its own small wrapper rather
   *  than reusing addListener's target.addEventListener call directly. */
  function addMapListener(map, type, fn) {
    if (typeof map.on !== 'function') return;
    map.on(type, fn);
    current.listeners.push([{ removeEventListener: () => { if (typeof map.off === 'function') map.off(type, fn); } }, 'x', () => {}]);
    counters.listeners += 1;
  }

  /** Draped overlays (brief item 1): the layers ON in 2D with fetched geometry,
   *  as MapLibre GeoJSON sources + line/circle layers with D0's own colours
   *  (terrain-overlays.js's overlayLayersFor). `overlayData.dropped` is handed
   *  back on `current` so the capability-notice list (built by the caller, which
   *  owns the dialog DOM) can say why a layer drew nothing rather than leave a
   *  silent gap. Deferred to style load exactly like the setLight() call above --
   *  the same "Style is not done loading" constraint applies to addSource. */
  function applyOverlay(map, overlayData) {
    if (!overlayData) { current.overlayDropped = []; return; }
    const { sources, layers, dropped } = overlayLayersFor(
      overlayData.featuresByLayerId, overlayData.registry,
      { on: overlayData.on, statesById: overlayData.statesById, display: overlayData.display, layerIdForKey: overlayData.layerIdForKey },
    );
    current.overlayDropped = dropped;
    // Each pass replaces the one before it (refreshOverlay), and only the newest pass may draw:
    // one still waiting on 'load' when a newer snapshot arrives must not add stale data after it.
    const pass = (current.overlayPass || 0) + 1;
    current.overlayPass = pass;
    const owner = current;
    const add = () => {
      if (current !== owner || owner.overlayPass !== pass || typeof map.addSource !== 'function') return;
      removeOverlay(map);
      for (const [id, src] of Object.entries(sources)) map.addSource(id, src);
      for (const layer of layers) map.addLayer(layer);
      owner.overlayIds = { sources: Object.keys(sources), layers: layers.map((l) => l.id) };
    };
    if (!owner.styleLoaded && typeof map.isStyleLoaded === 'function' && !map.isStyleLoaded() && typeof map.once === 'function') {
      map.once('style.load', add);
    } else {
      add();
    }
  }

  /** Takes off the map every draped layer and source the last overlay pass added (layers first:
   *  MapLibre refuses to remove a source a layer still draws from). */
  function removeOverlay(map) {
    const ids = current?.overlayIds;
    if (!ids) return;
    for (const id of ids.layers) if (map.getLayer?.(id)) map.removeLayer(id);
    for (const id of ids.sources) if (map.getSource?.(id)) map.removeSource(id);
    current.overlayIds = null;
  }

  /** The 2D layers moved on while the panel is open (a fetch finished, a layer was turned on or
   *  off): drape the new snapshot in place of the old one, so 3D shows what 2D has now. */
  function refreshOverlay(overlayData) {
    if (!current) return;
    applyOverlay(current.map, overlayData);
  }

  /** Names on relief (brief item 2): the same declutter algorithm 2D uses
   *  (name-labels.js's placeScreenLabels) against the 3D projection (`map.project`),
   *  re-placed on moveend/pitchend, debounced with one pass in flight, filtered by
   *  occlusion (terrain-overlays.js's labelOccluded) so a name behind a ridge is not
   *  shown (plan §4.6). DOM labels over the canvas, continuing E1's approach rather
   *  than switching to MapLibre glyphs. `doc`/`win` close over the panel's own. */
  /** Ground height under a lon/lat, 0 when the renderer cannot say (no terrain yet). */
  function sampleElevation(map, lon, lat) {
    if (typeof map.queryTerrainElevation === 'function') {
      const e = map.queryTerrainElevation([lon, lat]);
      return typeof e === 'number' ? e : 0;
    }
    return 0;
  }

  /** Straight-line camera proxy: MapLibre 6.10's public FreeCameraOptions API is not exercised by
   *  the fake renderer terrain-view.test.mjs uses, so the sightline's near end is the map centre
   *  lifted well above the terrain -- adequate for "is a ridge between the viewer and this
   *  anchor", which is what labelOccluded actually tests, over the panel's small qualified area. */
  function cameraProxy(map) {
    const center = typeof map.getCenter === 'function' ? map.getCenter() : { lng: 0, lat: 0 };
    return { lon: center.lng, lat: center.lat, elevation: sampleElevation(map, center.lng, center.lat) + 3000 };
  }

  function setupNames(map, container, gnisNames, prefs, selectedId, trails = []) {
    const trailList = Array.isArray(trails) ? trails : [];
    if (((!gnisNames || !gnisNames.length) && !trailList.length) || typeof container?.appendChild !== 'function') { current.namesEl = null; return; }
    const gnis = Array.isArray(gnisNames) ? gnisNames : [];
    const labelsEl = doc.createElement('div');
    labelsEl.className = 'qc-terrain-names';
    // A child of `container` (already `position: relative`, see
    // quiet-corners-terrain.css's .qc-terrain-canvas), appended after MapLibre's
    // own canvas markup so it paints on top -- inset:0 then means the canvas's
    // own box, not the whole dialog (which also holds the notices/controls bars).
    container.appendChild(labelsEl);
    current.namesEl = labelsEl;
    current.previousNameIds = null;
    let inFlight = false, pending = false, timer = null;

    function place() {
      if (!current) return;
      if (inFlight) { pending = true; return; }
      inFlight = true;
      try {
        const camera = cameraProxy(map);
        const sample = (lon, lat) => sampleElevation(map, lon, lat);
        const toPx = (lon, lat) => (typeof map.project === 'function' ? map.project([lon, lat]) : { x: 0, y: 0 });
        const container_ = typeof map.getContainer === 'function' ? map.getContainer() : null;
        const viewport = container_ ? { width: container_.clientWidth, height: container_.clientHeight } : { width: 0, height: 0 };
        // Trail names ride the same declutter as the GNIS names. A trail is long, so its
        // label sits on the vertex that is on screen, unhidden by relief, and nearest the
        // middle of the view -- chosen anew each pass, since the view moves.
        const names = gnis.concat(trailList.map((t) => trailAnchor(t, toPx, viewport, camera, { sampleElevation: sample })).filter(Boolean));
        // The panel's own controls and credit are kept clear, as the road pass keeps them.
        const reserved = typeof container.querySelectorAll === 'function' && typeof container.getBoundingClientRect === 'function'
          ? reservedFromDom(container, PANEL_CONTROLS_3D) : [];
        const { placed } = placeScreenLabels(names, {
          toPx, viewport, measureText: (text, sizePx) => measureName(doc, text, sizePx),
          prefs, selectedId, reserved,
          zoom: typeof map.getZoom === 'function' ? map.getZoom() : 0,
          previous: current.previousNameIds,
        });
        current.previousNameIds = new Set(placed.map((p) => p.id));
        const byId = new Map(names.map((f) => [f.id, f]));
        const visible = placed.filter((p) => {
          const f = byId.get(p.id);
          if (!f || !Array.isArray(f.anchor)) return true;
          const anchor = { lon: f.anchor[1], lat: f.anchor[0], elevation: sample(f.anchor[1], f.anchor[0]) };
          return !labelOccluded({ anchor, camera, sampleElevation: sample, samples: OCCLUSION_SAMPLES });
        });
        labelsEl.replaceChildren(...visible.map((p) => {
          const span = doc.createElement('span');
          span.className = 'qc-terrain-name-label';
          span.style.left = `${p.labelX}px`;
          span.style.top = `${p.labelY}px`;
          span.style.fontSize = `${p.sizePx}px`;
          span.textContent = p.name;
          if (p.kind === 'trail') span.dataset.trailId = p.id;
          return span;
        }));
        // Road names keep off the names, so they are placed again whenever the names move (an
        // idle pass after the terrain tiles arrive moves every name the road pass had cleared).
        current.afterNames?.();
      } finally {
        inFlight = false;
        if (pending) { pending = false; place(); }
      }
    }

    function debounced() {
      if (timer) { (w || win)?.clearTimeout ? w.clearTimeout(timer) : clearTimeout(timer); }
      const schedule = w?.setTimeout ? w.setTimeout.bind(w) : setTimeout;
      timer = schedule(place, 150);
      current.namesTimer = timer;
    }

    addMapListener(map, 'moveend', debounced);
    addMapListener(map, 'pitchend', debounced);
    // Terrain tiles arrive after a move ends; until they do `project` and the elevation
    // probe answer for flat ground, so labels placed at moveend sit off the relief. Once
    // the map goes idle the picture is final: place again.
    addMapListener(map, 'idle', debounced);
    place();
  }

  /** Road names on relief (QQA-06c-2): the roads the screen map would letter for this view, over
   *  the 3D canvas. `roads` is the caller's snapshot: `{on, fetch, onState}`. `fetch` is a road
   *  fetcher of its own (source-road-names.js's createRoadNamesFetcher -- its latest-wins and cache
   *  are per instance, so the 3D view and the screen map never abort each other); the query,
   *  normalisation, caps and bands are all that module and road-names.js, unchanged. What this
   *  adds: the 3D zoom asked as the Leaflet zoom of the same ground, the same 30% fetch margin,
   *  labels laid along the road as THIS screen shows it (terrain-roads.js screenBearingFor), the
   *  GNIS names and the map's own controls reserved, and the occlusion test names get. Mirrors
   *  2D's states: a failed request keeps the last labels and says so; empty is not an error;
   *  stale draws nothing. `onState` hears 'loading' | 'ok' | 'partial' | 'empty' | 'error' | 'far'. */
  function setupRoads(map, container, roads, prefs) {
    if (!roads || !roads.on || typeof roads.fetch !== 'function' || typeof container?.appendChild !== 'function') { current.roadsEl = null; return; }
    const onState = typeof roads.onState === 'function' ? roads.onState : () => {};
    const layerEl = doc.createElement('div');
    layerEl.className = 'qc-terrain-roads';
    container.appendChild(layerEl);
    current.roadsEl = layerEl;
    let held = { status: 'empty', entries: [] };
    let fetched = null, live = null, timer = null;
    const mine = () => !!current && current.roadsEl === layerEl;
    const zoomNow = () => leafletZoomFor(typeof map.getZoom === 'function' ? map.getZoom() : NaN);
    const viewBox = () => {
      const b = map.getBounds();
      return { minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth() };
    };
    const needsFetch = () => {
      if (!layersForZoom(zoomNow()).length) return false;
      return !(fetched && fetched.zoom === zoomNow() && held.status !== 'error' && boxContains(fetched.box, viewBox()));
    };

    function draw() {
      if (!mine()) return;
      layerEl.replaceChildren();
      if (!held.entries.length || !layersForZoom(zoomNow()).length) return;
      const toPx = (lon, lat) => map.project([lon, lat]);
      const size = map.getContainer();
      const camera = cameraProxy(map);
      const sample = (lon, lat) => sampleElevation(map, lon, lat);
      const reserved = typeof container.querySelectorAll === 'function' && typeof container.getBoundingClientRect === 'function'
        ? reservedFromDom(container, RESERVED_3D_SELECTORS) : [];
      const { placed } = placeRoadLabels(held.entries, {
        toPx, viewport: { width: size.clientWidth, height: size.clientHeight },
        measureText: (text, sizePx) => measureName(doc, text, sizePx),
        prefs, reserved, bearingOf: (anchor) => screenBearingFor(toPx, anchor),
      });
      const visible = placed.filter((p) => !labelOccluded({
        anchor: { lon: p.lon, lat: p.lat, elevation: sample(p.lon, p.lat) }, camera, sampleElevation: sample, samples: OCCLUSION_SAMPLES,
      }));
      layerEl.replaceChildren(...visible.map((p) => {
        const span = doc.createElement('span');
        span.className = 'qc-terrain-road-label';
        span.textContent = p.label;
        span.style.left = `${p.x}px`;
        span.style.top = `${p.y}px`;
        span.style.width = `${p.width}px`;
        span.style.height = `${p.height}px`;
        span.style.fontSize = `${p.sizePx}px`;
        span.style.transform = `translate(-50%, -50%) rotate(${p.bearing}deg)`;
        return span;
      }));
    }

    async function ask() {
      if (live) live.abort();
      const request = new AbortController();
      live = request;
      current.roadsAbort = request;
      const zoom = zoomNow();
      const padded = padBox(viewBox());
      onState('loading');
      let got;
      try { got = await roads.fetch({ bbox: padded, zoom, signal: request.signal }); } catch { got = { status: 'error', entries: [] }; }
      if (request.signal.aborted || got.status === 'stale' || live !== request || !mine()) return;
      if (got.status === 'error') { onState('error'); return; }   // the labels already up are still true
      held = got;
      fetched = { zoom, box: padded };
      onState(got.status === 'partial' ? 'partial' : got.status === 'empty' ? 'empty' : 'ok');
      draw();
    }

    function pass() {
      if (!mine()) return;
      if (!layersForZoom(zoomNow()).length) {
        if (live) live.abort();
        held = { status: 'empty', entries: [] };
        fetched = null;
        layerEl.replaceChildren();
        onState('far');
        return;
      }
      if (needsFetch()) { ask(); return; }
      if (live) live.abort();
      draw();
    }

    function debounced() {
      const clear = w?.clearTimeout ? w.clearTimeout.bind(w) : clearTimeout;
      const schedule = w?.setTimeout ? w.setTimeout.bind(w) : setTimeout;
      if (timer) clear(timer);
      // A pan that asks for nothing re-places as fast as the names do; one that asks waits for the
      // view to hold still, as 2D does.
      timer = schedule(pass, needsFetch() ? ROAD_PASS_DEBOUNCE_MS : 150);
      current.roadsTimer = timer;
    }

    current.afterNames = draw;
    addMapListener(map, 'moveend', debounced);
    addMapListener(map, 'pitchend', debounced);
    pass();
  }

  /** Opens over `container` (a DOM node the caller already placed in the dialog).
   *  Never throws on a renderer failure -- the caller decides what "could not
   *  load" copy to show; this only guarantees no resource leaks either way.
   *  `overlay` (E2) is the caller's snapshot of the layers/names compatible with
   *  the area at the moment of open -- draped and never revisited until the panel
   *  is reopened, matching plan §4.6's "snapshot ... on opening". */
  function open({ bboxLonLat, exaggeration = DEFAULT_EXAGGERATION, container, overlay: overlayData } = {}) {
    if (current) return current;
    current = { listeners: [], objectUrls: [] };
    const style = terrainStyle({ bboxLonLat, exaggeration: clampExaggeration(exaggeration) });
    const map = new maplibregl.Map({ container, style, bounds: cameraBoundsFor(bboxLonLat), attributionControl: false });
    current.map = map;
    counters.maps += 1;
    // Draped layers can go on once the style is parsed ('style.load'), not after the first full
    // render ('load'), which waits on every tile: on a slow or failing tile host it came late or
    // never and nothing was draped. After it isStyleLoaded() still reads false while tiles fetch,
    // so the flag, not that call, says a later overlay pass need not wait.
    const opened = current;
    if (typeof map.once === 'function') map.once('style.load', () => { opened.styleLoaded = true; });
    // Visible at all times, never conditional on a control the reader could collapse
    // away -- a fake renderer in tests carries no AttributionControl, so this is
    // skipped there rather than thrown.
    if (typeof map.addControl === 'function' && typeof maplibregl.AttributionControl === 'function') {
      // The roads credit rides on the panel exactly while road names are on in this view.
      const credit = overlayData?.roads?.on ? [...TERRAIN_ATTRIBUTION, SOURCES.usgsRoadNames.attribution] : TERRAIN_ATTRIBUTION;
      map.addControl(new maplibregl.AttributionControl({ customAttribution: credit, compact: false }));
    }
    // Direction/altitude for the one hillshade layer this panel ever draws (see the
    // note above lightPositionFor): the one documented setLight() exception. The
    // real vendored bundle throws "Style is not done loading" if setLight is called
    // before the style has finished (verified against a live browser building unit
    // E1's browser proof, scripts/qcm/terrain-panel.test.mjs — the pure/fake-renderer
    // unit tests in terrain-view.test.mjs never exercise this because their fake Map
    // has no `once`, so the bug was invisible there). A real Map exposes
    // isStyleLoaded()/once('load', ...) and this applies through them; the fake
    // renderer has neither, so it keeps calling setLight synchronously exactly as
    // before and every existing unit test is unaffected.
    if (typeof map.setLight === 'function') {
      const applyLight = () => map.setLight({ position: lightPositionFor(), anchor: 'map' });
      if (typeof map.isStyleLoaded === 'function' && !map.isStyleLoaded() && typeof map.once === 'function') {
        map.once('load', applyLight);
      } else {
        applyLight();
      }
    }
    // Snapshot the just-built camera so "North up / reset view" has somewhere to jump
    // back to -- taken after construction so it reflects what the renderer actually
    // resolved the padded bounds to, not a value this module guessed.
    current.initial = {
      center: typeof map.getCenter === 'function' ? map.getCenter() : undefined,
      zoom: typeof map.getZoom === 'function' ? map.getZoom() : undefined,
    };
    applyOverlay(map, overlayData);
    setupNames(map, container, overlayData?.names, overlayData?.prefs, overlayData?.selectedId, overlayData?.trailLabels);
    setupRoads(map, container, overlayData?.roads, overlayData?.prefs);
    if (w) {
      const onResize = () => map.resize();
      addListener(w, 'resize', onResize);
      addListener(w, 'orientationchange', onResize);
    }
    if (typeof map.on === 'function') {
      map.on('webglcontextlost', () => close());
      map.on('error', (e) => { if (e?.sourceId === 'terrainDem') { /* visible notice is the caller's job */ } });
    }
    send({ open: true });
    return current;
  }

  /** Closing NEVER touches the Leaflet view, the print selection, or the print
   *  recipe -- it only releases what this module itself created. */
  function close() {
    if (!current) return;
    // A pending debounced name-placement pass must never fire against a map the
    // next line is about to destroy -- same reasoning as revoking objectUrls below.
    if (current.namesTimer) { (w?.clearTimeout || clearTimeout)(current.namesTimer); }
    if (current.namesEl?.remove) current.namesEl.remove();
    // Same for a pending road pass and a road request still in flight: neither may answer into a
    // map that is gone, or leave the road service holding a request for a view nobody has.
    if (current.roadsTimer) { (w?.clearTimeout || clearTimeout)(current.roadsTimer); }
    if (current.roadsAbort) current.roadsAbort.abort();
    if (current.roadsEl?.remove) current.roadsEl.remove();
    for (const [target, type, fn, opts] of current.listeners) target.removeEventListener(type, fn, opts);
    counters.listeners -= current.listeners.length;
    for (const url of current.objectUrls) { try { URL.revokeObjectURL(url); } catch { /* already gone */ } }
    counters.objectUrls -= current.objectUrls.length;
    current.map.remove();
    counters.maps -= 1;
    current = null;
    send({ open: false });
  }

  /** What the last open() draped/dropped, for the caller's capability-notice list
   *  (which owns the dialog DOM, see attachTerrainControl below) -- read after
   *  open() returns, since applyOverlay may resolve synchronously or on 'load'. */
  function overlayReport() { return current?.overlayDropped || []; }

  function setExaggeration(value) {
    if (!current) return;
    const exag = clampExaggeration(value);
    if (typeof current.map.setTerrain === 'function') current.map.setTerrain({ source: 'terrainDem', exaggeration: exag });
    return exag;
  }

  /** North up / reset view (plan §4.6): jumps back to the snapshot camera with
   *  bearing and pitch at 0. jumpTo, never easeTo/flyTo -- no camera animation,
   *  reduced motion or not, matching the task's "never an animated camera move". */
  function resetView() {
    if (!current) return;
    current.map.jumpTo({ ...current.initial, bearing: 0, pitch: 0 });
  }

  /** Tilt up/down (plan §4.6): the alternative to gesture-based pitch, clamped to a
   *  sane 0-60 range so the terrain never flips past the horizon. Returns the pitch
   *  actually applied so a caller can reflect it without asking the map directly. */
  function tilt(delta) {
    if (!current) return;
    const from = typeof current.map.getPitch === 'function' ? current.map.getPitch() : 0;
    const pitch = Math.max(0, Math.min(60, from + delta));
    current.map.jumpTo({ pitch });
    return pitch;
  }

  function debug() { return { ...counters }; }

  /** Read-only introspection for the browser proof (terrain-panel.test.mjs) --
   *  the draped GeoJSON sources/layers and the placed name-label DOM nodes,
   *  since neither is reachable from outside this closure otherwise. Never used
   *  by production code, only by the CDP test harness. */
  function styleSnapshot() {
    if (!current?.map || typeof current.map.getStyle !== 'function') return null;
    const style = current.map.getStyle() || {};
    return {
      sourceIds: Object.keys(style.sources || {}),
      layers: (style.layers || [])
        .filter((l) => l.id.startsWith('qc-drape-'))
        .map((l) => ({ id: l.id, type: l.type, paint: l.paint })),
      names: current.namesEl
        ? Array.from(current.namesEl.querySelectorAll('.qc-terrain-name-label')).map((el) => el.textContent)
        : [],
      roads: current.roadsEl && current.roadsEl.querySelectorAll
        ? Array.from(current.roadsEl.querySelectorAll('.qc-terrain-road-label')).map((el) => el.textContent)
        : [],
    };
  }

  /** The live renderer map, for the relief browser proof (terrain-relief-browser.test.mjs)
   *  to project, query and read pixels from; null while closed. Like styleSnapshot it is
   *  never used by production code. */
  function inspect() { return current?.map ?? null; }

  return { open, close, isOpen, setExaggeration, resetView, tilt, debug, overlayReport, refreshOverlay, styleSnapshot, inspect };
}

const VENDOR_MODULE_URL = new URL('../../vendor/maplibre-gl.mjs', import.meta.url).href;
const VENDOR_CSS_URL = new URL('../../vendor/maplibre-gl.css', import.meta.url).href;
let cssInjected = false;

function ensureCss(doc) {
  if (cssInjected) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = VENDOR_CSS_URL;
  doc.head.appendChild(link);
  cssInjected = true;
}

/** Adds the "3D" Leaflet control (left-edge lane, same shape as the existing
 *  reset/finder buttons) and wires it to a lazily-built panel. `getArea` reads
 *  the current 2D area at the moment of the click -- `state.bbox` if a print
 *  selection is set, else the Leaflet map bounds -- so main.js needs to pass
 *  only a getter, never its `state` object itself. */
export function attachTerrainControl(map, getArea, { L = window.L, doc = document, importer, getOverlayData, setLayerOn } = {}) {
  let panel = null, dialog = null, opener = null, layerInputs = null;
  // QQA-06c-2: Road names are not a draped layer, so the registry-driven list below cannot tell
  // "shown" from "did not load". The road pass reports its own state (loading / ok / partial /
  // empty / error / far) and this one line follows it, in the same words the screen map's row uses.
  let roadsState = null, roadsLi = null;
  function paintRoadsLi() {
    if (!roadsLi) return;
    const text = roadNotice(roadsState);
    roadsLi.textContent = text || '';
    roadsLi.hidden = !text;
    roadsLi.className = `qc-terrain-notice qc-terrain-notice-roads-${roadsState || 'pending'}`;
    roadsLi.setAttribute('data-roads-state', roadsState || '');
  }
  function setRoadsState(state) { roadsState = state; paintRoadsLi(); }

  /** The panel's compact capability list (brief item 4), built from the SAME
   *  snapshot handed to panel.open() -- so "shown"/"loading"/"Available in 2D"
   *  always describes what the panel actually drew, never a second read of
   *  live 2D state that could have moved on since the snapshot was taken. */
  function renderNotices(overlayData) {
    const existing = dialog.querySelector('.qc-terrain-notices');
    if (existing) existing.remove();
    if (!overlayData) return;
    const notices = capabilityNotices(overlayData.registry, overlayData.on, overlayData.statesById);
    const roadsOn = !!overlayData.roads?.on;
    if (!notices.length && !roadsOn) return;
    const wrap = doc.createElement('div');
    wrap.className = 'qc-terrain-notices';
    const heading = doc.createElement('p');
    heading.className = 'qc-terrain-notices-heading';
    heading.textContent = COPY.noticeHeading;
    const list = doc.createElement('ul');
    const STATUS_COPY = { shown: COPY.noticeShown, loading: COPY.noticeLoading, 'available-2d': COPY.noticeAvailable2d };
    for (const n of notices) {
      const li = doc.createElement('li');
      li.textContent = `${n.label}: ${STATUS_COPY[n.status] || n.status}`;
      li.className = `qc-terrain-notice qc-terrain-notice-${n.status}`;
      list.appendChild(li);
    }
    if (roadsOn) {
      roadsLi = doc.createElement('li');
      roadsLi.setAttribute('data-layer-id', 'roads');
      list.appendChild(roadsLi);
      paintRoadsLi();
    }
    wrap.append(heading, list);
    dialog.insertBefore(wrap, dialog.firstChild);
  }

  function snapshotBbox() {
    const explicit = getArea?.();
    if (explicit) return explicit;
    const b = map.getBounds();
    return { minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth() };
  }

  function buildDialog() {
    dialog = doc.createElement('div');
    dialog.className = 'qc-terrain-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', '3D terrain');
    dialog.hidden = true;
    doc.body.appendChild(dialog);
    return dialog;
  }

  function closePanel() {
    panel?.close();
    if (dialog) dialog.hidden = true;
    opener?.focus();
  }

  function onKeydown(e) { if (e.key === 'Escape') closePanel(); }

  async function openPanel() {
    if (!dialog) dialog = buildDialog();
    dialog.hidden = false;
    dialog.innerHTML = '';
    const reducedMotion = doc.defaultView.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const webgl = probeWebgl(doc);
    const support = classifySupport({ webgl, reducedMotion });
    if (!support.supported) {
      const p = doc.createElement('p');
      p.className = 'qc-terrain-fallback';
      p.textContent = COPY.noWebgl;
      dialog.appendChild(p);
      addCloseButton();
      dialog.focus?.();
      return;
    }
    let maplibregl;
    try {
      const load = importer || (() => import(/* webpackIgnore: true */ VENDOR_MODULE_URL));
      maplibregl = await load();
    } catch {
      const p = doc.createElement('p');
      p.className = 'qc-terrain-fallback';
      p.textContent = COPY.loadFailed;
      dialog.appendChild(p);
      addCloseButton();
      return;
    }
    ensureCss(doc);
    const container = doc.createElement('div');
    container.className = 'qc-terrain-canvas';
    dialog.appendChild(container);
    addControls(reducedMotion);
    panel = createTerrainPanel({ maplibregl, doc, win: doc.defaultView });
    // Snapshot of the 2D layers at open (plan §4.6), read again by refresh() whenever 2D's layers
    // move on while the panel is up. The panel only ever reads it; it never writes back to it,
    // so closing needs nothing to restore.
    roadsState = null; roadsLi = null;
    const overlayData = overlaySnapshot();
    panel.open({ bboxLonLat: snapshotBbox(), container, overlay: overlayData });
    renderNotices(overlayData);
    addLayerToggles(overlayData);
    doc.addEventListener('keydown', onKeydown);
  }

  function overlaySnapshot() {
    const overlayData = getOverlayData?.();
    return overlayData?.roads ? { ...overlayData, roads: { ...overlayData.roads, onState: setRoadsState } } : overlayData;
  }

  /** 2D's layers changed (a fetch finished, a layer was switched): an open panel drapes the new
   *  snapshot and its capability list says what is shown now, instead of keeping "loading in 2D
   *  first" until it is closed and opened again. The road pass keeps running as it was. */
  function refresh() {
    if (!panel?.isOpen() || !dialog) return;
    const overlayData = overlaySnapshot();
    panel.refreshOverlay(overlayData);
    renderNotices(overlayData);
    syncLayerToggles(overlayData);
  }

  /** QC 3D row 5: the dialog covers the 2D layer panel, so it carries its own switches. Each one
   *  hands the change to 2D (setLayerOn ticks the 2D checkbox), and 2D's redraw comes back through
   *  refresh() -- one layer state, never a 3D copy of it. Built once per open and only re-ticked
   *  after, so a switch keeps keyboard focus while the list redraws. */
  function addLayerToggles(overlayData) {
    layerInputs = null;
    const bar = dialog.querySelector('.qc-terrain-controls');
    if (!setLayerOn || !bar || !overlayData) return;
    const rows = layerToggleRows(overlayData.registry, overlayData.on, overlayData.roads);
    if (!rows.length) return;
    // Collapsed behind one button, so the switches never take height from the relief; opened,
    // they float above the bar.
    const box = doc.createElement('details');
    box.className = 'qc-terrain-layers';
    const summary = doc.createElement('summary');
    summary.textContent = 'Layers';
    const set = doc.createElement('fieldset');
    const legend = doc.createElement('legend');
    legend.textContent = 'Layers in 2D and 3D';
    set.appendChild(legend);
    box.append(summary, set);
    layerInputs = new Map();
    for (const row of rows) {
      const label = doc.createElement('label');
      const input = doc.createElement('input');
      input.type = 'checkbox';
      input.checked = row.on;
      input.setAttribute('data-layer-id', row.id);
      input.addEventListener('change', () => setLayerOn(row.id, input.checked));
      label.append(input, ` ${row.label}`);
      set.appendChild(label);
      layerInputs.set(row.id, input);
    }
    bar.insertBefore(box, bar.querySelector('.qc-terrain-close'));
  }

  function syncLayerToggles(overlayData) {
    if (!layerInputs || !overlayData) return;
    for (const row of layerToggleRows(overlayData.registry, overlayData.on, overlayData.roads)) {
      const input = layerInputs.get(row.id);
      if (input && input.checked !== row.on) input.checked = row.on;
    }
  }

  function addCloseButton() {
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'qc-terrain-close';
    close.textContent = 'Close';
    close.addEventListener('click', closePanel);
    dialog.appendChild(close);
  }

  function addControls(reducedMotion) {
    const bar = doc.createElement('div');
    bar.className = 'qc-terrain-controls';
    const northUp = doc.createElement('button');
    northUp.type = 'button'; northUp.textContent = 'North up / reset view';
    // panel is assigned synchronously right after addControls() returns (openPanel's
    // next line), before any click can reach this handler -- see the closure note
    // on `panel` at the top of attachTerrainControl.
    northUp.addEventListener('click', () => panel?.resetView());
    const tiltUp = doc.createElement('button');
    tiltUp.type = 'button'; tiltUp.textContent = 'Tilt up';
    tiltUp.addEventListener('click', () => panel?.tilt(10));
    const tiltDown = doc.createElement('button');
    tiltDown.type = 'button'; tiltDown.textContent = 'Tilt down';
    tiltDown.addEventListener('click', () => panel?.tilt(-10));
    const { label: exagLabel } = createExaggerationControl(doc, (value) => panel?.setExaggeration(value));
    const close = doc.createElement('button');
    close.type = 'button'; close.className = 'qc-terrain-close'; close.textContent = 'Close';
    close.addEventListener('click', closePanel);
    bar.append(northUp, tiltUp, tiltDown, exagLabel, close);
    dialog.appendChild(bar);
  }

  const wrap = L.DomUtil.create('div', 'leaflet-bar qc-terrain-control');
  const button = L.DomUtil.create('button', 'qc-terrain-open', wrap);
  button.type = 'button';
  button.textContent = '3D';
  button.setAttribute('aria-label', 'View this area in 3D terrain');
  L.DomEvent.disableClickPropagation(wrap);
  L.DomEvent.on(button, 'click', () => { opener = button; openPanel(); });

  const control = L.control({ position: 'topleft' });
  control.onAdd = () => wrap;
  control.addTo(map);

  // debug() exists so a browser-level proof (scripts/qcm/terrain-panel.test.mjs)
  // can read this module's own leak counters from outside it after ten open/close
  // cycles, without reaching into the closure over `panel`. Zeros before the
  // first open, same shape createTerrainPanel's own debug() returns.
  const api = {
    closePanel,
    refresh,
    isOpen: () => !!panel?.isOpen(),
    debug: () => panel?.debug() ?? { maps: 0, listeners: 0, objectUrls: 0, inflight: 0 },
    // E2: read-only style/label introspection for the browser proof, null while closed.
    styleSnapshot: () => panel?.styleSnapshot() ?? null,
    inspect: () => panel?.inspect() ?? null,
  };
  if (typeof window !== 'undefined') window.qcTerrainView = api;
  return api;
}
