// Draped overlays, capability notices and label occlusion for the 3D terrain
// panel (unit E2). Pure -- no DOM, no MapLibre, no fetch. A caller (terrain-view
// open(), wired from main.js) hands this module plain feature arrays already
// bucketed by registry layer id (the same buckets renderOverlay/renderedKeys
// already build in main.js) and gets back MapLibre style JSON fragments plus a
// list of what could not be drawn and why.
//
// Colours/widths/dashes are read from preview-overlay.js's `displayStyle` --
// the SAME D0 table and the SAME live emphasis state (`display`) the 2D preview
// draws from -- so there is never a second palette (plan §4.6, D0's contract)
// and a spotlighted/dimmed layer in 2D reads the same way over the relief.
import { displayStyle, DEFAULT_DISPLAY } from './preview-overlay.js';

/** Per-drapeable-layer vertex budget. MapLibre draws GeoJSON lines on the GPU
 *  rather than as live Leaflet DOM/SVG paths (preview-overlay.js's PREVIEW_BUDGET
 *  caps at 2,000 *features* per symbol for exactly that reason), so the ceiling
 *  here is a vertex count, not a feature count, and can be far higher: 20,000
 *  vertices is comfortably inside one GPU line-layer draw call's interactive
 *  budget even on a mid-range integrated GPU, while still refusing to hand the
 *  panel an unbounded parcel or wetlands layer (surfaceOwnership: 26,863 parcels
 *  measured over one Delaware rectangle in preview-overlay.js's own comment). */
export const MAX_LAYER_VERTICES = 20000;

/** Bounded line-of-sight samples along the camera-to-anchor ray for occlusion
 *  (plan §4.6: "do not show labels through intervening hills unless explicitly
 *  indicated"). 8 interior samples is enough to catch a single intervening ridge
 *  or valley wall -- the common case at the panel's qualified-area scale -- while
 *  staying cheap enough to run for every visible label on every moveend/pitchend
 *  re-placement pass (name-labels.js's own declutter cap is 60 labels at most). */
export const OCCLUSION_SAMPLES = 8;

/** How many coordinates a feature's `paths` (the same [lon, lat] ring-array shape
 *  preview-overlay.js's `previewPolylines` reads) actually carries. A feature with
 *  no paths (a bare point) counts as one vertex, matching capVertices' budget math
 *  below -- a point costs the same one "slot" a two-vertex line segment would not
 *  even fit in, which is deliberately conservative. */
export function vertexCount(paths) {
  if (!Array.isArray(paths)) return 0;
  return paths.reduce((n, ring) => n + (Array.isArray(ring) ? ring.length : 0), 0);
}

/** Keeps features, in order, until `cap` vertices are spent; the rest are
 *  dropped and counted (never silently truncated -- the caller reports
 *  `droppedFeatures`/`droppedVertices` in `overlayLayersFor`'s `dropped` list,
 *  mirroring preview-overlay.js's own onTruncate contract for the 2D preview). */
export function capVertices(features, cap = MAX_LAYER_VERTICES) {
  let used = 0;
  const kept = [];
  let droppedFeatures = 0;
  let droppedVertices = 0;
  for (const f of features) {
    const v = Array.isArray(f.paths) ? Math.max(1, vertexCount(f.paths)) : 1;
    if (used + v > cap) { droppedFeatures += 1; droppedVertices += v; continue; }
    kept.push(f);
    used += v;
  }
  return { kept, used, droppedFeatures, droppedVertices };
}

function toGeoJsonLine(feature) {
  const rings = feature.paths || [];
  return {
    type: 'Feature',
    properties: { id: feature.id ?? null, symbolKey: feature.symbolKey, title: feature.name || null },
    geometry: rings.length > 1
      ? { type: 'MultiLineString', coordinates: rings }
      : { type: 'LineString', coordinates: rings[0] || [] },
  };
}

function toGeoJsonPoint(feature) {
  return {
    type: 'Feature',
    properties: { id: feature.id ?? null, symbolKey: feature.symbolKey, title: feature.name || null },
    geometry: { type: 'Point', coordinates: feature.lonLat },
  };
}

/** The trails the 3D view should NAME: one record per trail id (a trail the source splits
 *  into several segments is one name, not several), shaped like the GNIS names the label
 *  pass already places so both share one declutter and one set of occlusion rules.
 *  `path` is the trail's vertices as [lon, lat], every segment end to end: the panel picks,
 *  at each placement, the vertex nearest the middle of what is on screen -- a trail longer
 *  than the view must be named where the reader can see it, not at a midpoint off the edge.
 *  `anchor` ([lat, lon], the shape names use) is the vertex half way along, the fallback
 *  when no projection is available. Unnamed trails are skipped (a blank label is noise).
 *  `layer`/`cls` are deliberately absent from terrain-names.js's KINDS table, so a trail
 *  takes its "other named feature" priority and zoom gate and never outranks a place. */
export function trailLabelsFor(features = []) {
  const byId = new Map();
  for (const f of features) {
    const name = typeof f?.name === 'string' ? f.name.trim() : '';
    if (!name || !Array.isArray(f.paths)) continue;
    const key = f.id ?? name;
    const row = byId.get(key) || { id: String(key), name, kind: 'trail', layer: 'trail', cls: 'trail', path: [] };
    for (const p of f.paths) if (Array.isArray(p)) row.path.push(...p.filter((v) => Array.isArray(v) && v.length >= 2));
    byId.set(key, row);
  }
  const out = [];
  for (const row of byId.values()) {
    if (row.path.length < 2) continue;
    const mid = row.path[Math.floor(row.path.length / 2)];
    out.push({ ...row, anchor: [mid[1], mid[0]] });
  }
  return out;
}

/** Draped MapLibre sources/layers for the layers ON in 2D with fetched normalized
 *  geometry (plan §4.6/brief item 1).
 *
 *  `featuresByLayerId` — `{ [registryLayerId]: features[] }`, plain data already
 *  bucketed by the caller (the same buckets main.js's renderOverlay/renderedKeys
 *  build from `state.trails`, `state.mvum`, `state.land`, `state.recSites`); each
 *  feature carries `symbolKey`, `id`, `name`, and either `paths` ([lon,lat] ring
 *  array, preview-overlay.js's own shape) or `lonLat` (a point).
 *  `registry` — layer rows carrying `.id`, `.group` and `.drape`
 *  ('line'|'label'|false — layer-registry.js's `LAYERS_WITH_DRAPE`).
 *  `on` — which registry ids are switched on in 2D right now.
 *  `statesById` — `state.states`-shaped source-state map, for "loading" notices.
 *  `display`/`layerIdForKey` — D0's live emphasis state and the same symbolKey ->
 *  registry-layer-id lookup main.js already builds (`SYMBOL_KEY_TO_LAYER_ID`), so
 *  a spotlighted/dimmed layer in 2D reads the same way over the relief. No new
 *  emphasis state is read or written here.
 *
 *  Returns `{ sources, layers, dropped }` — `sources`/`layers` are MapLibre style
 *  JSON fragments (`map.addSource`/`map.addLayer` one at a time, or spread into a
 *  style's own `sources`/`layers`); `dropped` is `[{id, reason, ...}]` for every
 *  ON layer that drew nothing, so the panel's capability list (capabilityNotices,
 *  below) can say why rather than leave a silent gap. */
export function overlayLayersFor(featuresByLayerId = {}, registry = [], {
  on = {}, statesById = {}, vertexCap = MAX_LAYER_VERTICES,
  display = DEFAULT_DISPLAY, layerIdForKey = (key) => key,
} = {}) {
  const sources = {};
  const layers = [];
  const dropped = [];

  for (const l of registry) {
    if (!on[l.id]) continue;
    if (l.drape === false) {
      // A context surface (raster or one-at-a-time radio surface) cannot drape;
      // a base/extraPage/reading row is not an overlay toggle at all and earns no
      // notice (it is never drawn on the 2D map either -- see layer-registry.js's
      // drapeKindFor). Only report the ones a reader actually ticked as ink.
      if (l.group === 'context') dropped.push({ id: l.id, reason: 'raster' });
      continue;
    }
    if (l.drape !== 'line' && l.drape !== 'point') continue; // 'label' (names) is a separate DOM/occlusion pass

    const features = featuresByLayerId[l.id] || [];
    if (!features.length) {
      const st = statesById[l.id];
      // Only an EXPLICIT non-terminal state (still fetching, e.g. 'unchecked')
      // reads as "loading". No entry at all is not a claim that a fetch is in
      // flight -- it just means this caller isn't tracking that source's state,
      // so it is silently empty rather than misreported as loading.
      if (st && st !== 'ready' && st !== 'unavailable') dropped.push({ id: l.id, reason: 'loading' });
      continue;
    }

    const { kept, droppedFeatures, droppedVertices } = capVertices(features, vertexCap);
    if (droppedFeatures) dropped.push({ id: l.id, reason: 'vertex-cap', droppedFeatures, droppedVertices });
    if (!kept.length) continue;

    const lineFeatures = kept.filter((f) => Array.isArray(f.paths));
    const pointFeatures = kept.filter((f) => Array.isArray(f.lonLat));
    const sourceId = `qc-drape-${l.id}`;
    sources[sourceId] = {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [...lineFeatures.map(toGeoJsonLine), ...pointFeatures.map(toGeoJsonPoint)],
      },
    };

    const keys = new Set(kept.map((f) => f.symbolKey));
    for (const key of keys) {
      // The SAME D0 helper 2D draws from, with the SAME live emphasis state --
      // never a second palette, never a second spotlight/dim rule.
      // A camera pin has no D0 symbol style; it keeps the colour its 2D pin is drawn in.
      const style = l.drape === 'point' ? { color: l.pinColor, weight: 4, opacity: 1 }
        : displayStyle(key, display, { layerId: layerIdForKey(key) });
      if (!style) continue;
      const hasLine = lineFeatures.some((f) => f.symbolKey === key);
      const hasPoint = pointFeatures.some((f) => f.symbolKey === key);
      if (hasLine) {
        // A casing/halo pass, drawn first (under), matching D0's own casingStyle
        // contract for a selected 2D shape: plan §4.6 names thin lines/dashes on
        // steep relief by name as the reason native draping alone is not enough.
        layers.push({
          id: `${sourceId}-${key}-casing`, type: 'line', source: sourceId,
          filter: ['==', ['get', 'symbolKey'], key],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#ffffff', 'line-width': style.weight + 2, 'line-opacity': Math.min(1, style.opacity + 0.1) },
        });
        layers.push({
          id: `${sourceId}-${key}`, type: 'line', source: sourceId,
          filter: ['==', ['get', 'symbolKey'], key],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': style.color, 'line-width': style.weight, 'line-opacity': style.opacity,
            ...(style.dashArray ? { 'line-dasharray': style.dashArray.split(' ').map(Number) } : {}),
          },
        });
      }
      if (hasPoint) {
        layers.push({
          id: `${sourceId}-${key}-point`, type: 'circle', source: sourceId,
          filter: ['==', ['get', 'symbolKey'], key],
          paint: {
            'circle-color': style.color, 'circle-radius': Math.max(4, style.weight * 1.5),
            'circle-opacity': style.opacity, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5,
          },
        });
      }
    }
  }
  return { sources, layers, dropped };
}

/** The panel's compact capability list (brief item 4): every registry layer ON
 *  in 2D, as 'shown' (drapes), 'loading' (ON, vector, nothing fetched yet -- same
 *  rule overlayLayersFor's `dropped` uses) or 'available-2d' (a context surface
 *  that cannot drape). A layer that is OFF, or that draws nothing on the 2D map
 *  at all (base/extraPage/reading), is never listed -- there is nothing to
 *  disclose about a layer the reader did not ask for or that 2D itself never
 *  shows as ink. */
export function capabilityNotices(registry = [], on = {}, statesById = {}) {
  const notices = [];
  for (const l of registry) {
    if (!on[l.id]) continue;
    if (l.drape === false) {
      if (l.group === 'context') notices.push({ id: l.id, label: l.label, status: 'available-2d' });
      continue;
    }
    if (l.drape === 'label') { notices.push({ id: l.id, label: l.label, status: 'shown' }); continue; }
    const st = statesById[l.id];
    notices.push({ id: l.id, label: l.label, status: (st && st !== 'ready' && st !== 'unavailable') ? 'loading' : 'shown' });
  }
  return notices;
}

/** The switches the 3D panel offers (QC 3D matrix row 5): one per layer 3D can draw, ticked as
 *  2D has it. A required layer has no switch in 2D either, and a layer 3D cannot draw would
 *  change nothing on the relief, so neither gets one. Road names read the road row's own `on`:
 *  the snapshot tells the capability list roads are off because the road pass reports itself. */
export function layerToggleRows(registry = [], on = {}, roads = null) {
  return registry.filter((l) => l.drape && !l.required)
    .map((l) => ({ id: l.id, label: l.label, on: l.id === 'roads' ? !!roads?.on : !!on[l.id] }));
}

/** Straight-line interpolation between two lon/lat points at fraction `t` --
 *  adequate over the panel's qualified (padded-snapshot) area, which is small
 *  enough that great-circle curvature is not the thing occlusion has to get
 *  right; the terrain sample is where the real answer lives. */
function lerp(a, b, t) { return a + (b - a) * t; }

/** Whether an anchor is hidden behind terrain along the straight camera-to-anchor
 *  ray (plan §4.6: "do not show labels through intervening hills unless
 *  explicitly indicated"). `sampleElevation(lon, lat, t)` is the caller's ground
 *  height at that ray point -- in the real panel, MapLibre's
 *  `map.queryTerrainElevation`; here, a plain function so this stays pure and
 *  testable with a fake ridge. Samples only the OCCLUSION_SAMPLES-bounded
 *  interior of the ray (never the endpoints -- the camera and the anchor's own
 *  ground are not "intervening"). True the moment any interior sample's terrain
 *  rises above the straight sightline between camera and anchor elevation at
 *  that same fraction. */
export function labelOccluded({ anchor, camera, sampleElevation, samples = OCCLUSION_SAMPLES }) {
  if (!anchor || !camera || typeof sampleElevation !== 'function') return false;
  for (let i = 1; i < samples; i += 1) {
    const t = i / samples;
    const lon = lerp(camera.lon, anchor.lon, t);
    const lat = lerp(camera.lat, anchor.lat, t);
    const sightlineElevation = lerp(camera.elevation, anchor.elevation, t);
    const groundElevation = sampleElevation(lon, lat, t);
    if (typeof groundElevation === 'number' && groundElevation > sightlineElevation) return true;
  }
  return false;
}
