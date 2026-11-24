// Road names over the 3D relief (QQA-06c slice 2). Pure: no DOM, no fetch, no MapLibre. The
// roads themselves are road-names.js / source-road-names.js / road-labels.js, the same modules
// the screen map uses; this file is only what is different about a tilted, turned, MapLibre view:
// which zoom to ask the road service about, how far to pad the request, which way a label lies
// on a screen the reader can rotate, and the words the capability list uses for each state.
/** How long a view must hold still before the road service is asked, as on the screen map. */
export const ROAD_PASS_DEBOUNCE_MS = 400;

/** The request covers the view plus this share of it on every side, as on the screen map, so a
 *  small drag re-places the answer already held instead of asking again. */
export const ROAD_FETCH_PAD = 0.3;

/** What a road label must not cover over the relief: the map's own controls (its credit) and the
 *  GNIS names this panel letters. */
export const RESERVED_3D_SELECTORS = '.maplibregl-ctrl, .qc-terrain-name-label';

/** MapLibre counts zoom in 512px tiles, Leaflet in 256px ones: the same ground is one Leaflet
 *  zoom higher. Whole zooms, rounded down, so the road service is never asked about a band the
 *  view has not reached. Anything that is not a finite number is 0 (no road class). */
export function leafletZoomFor(maplibreZoom) {
  if (typeof maplibreZoom !== 'number' || !Number.isFinite(maplibreZoom)) return 0;
  return Math.floor(maplibreZoom) + 1;
}

/** A lon/lat box grown by `share` of its own size on every side. */
export function padBox(box, share = ROAD_FETCH_PAD) {
  const dx = (box.maxLon - box.minLon) * share, dy = (box.maxLat - box.minLat) * share;
  return { minLon: box.minLon - dx, minLat: box.minLat - dy, maxLon: box.maxLon + dx, maxLat: box.maxLat + dy };
}

/** Whether `inner` lies wholly inside `outer`. */
export function boxContains(outer, inner) {
  return !!outer && inner.minLon >= outer.minLon && inner.maxLon <= outer.maxLon
    && inner.minLat >= outer.minLat && inner.maxLat <= outer.maxLat;
}

const STEP_DEG = 0.0005;   // about 50 m: far shorter than a segment, far longer than a pixel

/** The CSS rotation (degrees, clockwise on screen) that lays a label along a road on THIS
 *  screen. road-names.js's anchor `bearing` is the angle on a north-up flat map; once the reader
 *  turns or tilts the 3D view it points the wrong way, so the road's direction is re-projected:
 *  a short step along it is sent through `toPx` ((lon, lat) -> {x, y}) and the angle is read off
 *  the two screen points. Folded into (-90, 90] so the text never reads upside down. An anchor
 *  without a usable step (the projection returns the same point twice) keeps its own bearing. */
export function screenBearingFor(toPx, anchor) {
  const t = (anchor.bearing * Math.PI) / 180;
  const cosLat = Math.max(0.01, Math.cos((anchor.lat * Math.PI) / 180));
  // The anchor bearing is a CSS rotation: east = (cos, sin) with y pointing south.
  const a = toPx(anchor.lon, anchor.lat);
  const b = toPx(anchor.lon + (Math.cos(t) * STEP_DEG) / cosLat, anchor.lat - Math.sin(t) * STEP_DEG);
  const dx = b.x - a.x, dy = b.y - a.y;
  if (!(Math.hypot(dx, dy) > 1e-9)) return anchor.bearing;
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  while (deg > 90) deg -= 180;
  while (deg <= -90) deg += 180;
  return deg + 0;
}

/** The words for each state. 'error' and the partial sentence are the screen map's own. */
export const ROAD_NOTICE = Object.freeze({
  loading: 'Road names: loading',
  ok: 'Road names: shown',
  partial: 'Road names: shown. More roads than shown',
  empty: 'Road names: no road names found in this view',
  error: 'Road names did not load',
  far: 'Road names: zoom in to show them',
});

/** The capability-list sentence for a road state: 'loading', 'ok', 'partial', 'empty', 'error',
 *  'far' (zoomed out past the first road zoom). null for 'off' or anything unknown: a row that
 *  is off earns no line. */
export function roadNotice(state) {
  return Object.hasOwn(ROAD_NOTICE, state) ? ROAD_NOTICE[state] : null;
}

