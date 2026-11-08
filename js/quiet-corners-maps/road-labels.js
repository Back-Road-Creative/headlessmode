// Screen placement for road names (QQA-05r-2). Pure: no DOM of its own, no fetch, no Leaflet.
// road-names.js says WHICH roads and in what order; source-road-names.js fetches them; main.js
// draws what this returns. The caller supplies `toPx` (lon, lat) -> {x, y} and
// `measureText` (text, sizePx) -> {width, height} (the plate's box, measured by the caller).
//
// Not name-labels.js's placeScreenLabels: that one is for point features (a marker glyph and an
// 8-way offset ring around one anchor, terrain-names.js's priority order, DENSITY_CAP). A road
// label sits ON its road, rotated along it, and takes the road's own cap (ROAD_DENSITY_CAP).
// What it does share is the box vocabulary, the size scale and the reserved-box convention:
// a box handed in `reserved` is taken before any road gets a slot, so roads yield to towns,
// names and cameras and never the other way round.
import { ROAD_DENSITY_CAP, anchorOnPolyline } from './road-names.js';
import { SIZE_SCALE } from './name-labels.js';

/** What a road label must not cover: the dashboard's town and orientation names, a GNIS name
 *  (its span and its glyph), a camera pin and the map's own controls (zoom, 3D, view buttons,
 *  search, legend, credit, scale bar -- Leaflet keeps them all inside the map container). */
export const RESERVED_SELECTORS = '.qc-place-label, .qcm-name-label, .qcm-name-marker-glyph, .qcm-camera-pin, .leaflet-control';

/** Candidate anchors tried per road when the first one is off screen or taken: the road's own
 *  longest-segment anchor, then the longest few segments of any part, longest first. */
export const ROAD_ANCHOR_TRIES = 8;

/** Reserved boxes from the live DOM, in the container's own pixel space. `container` is any
 *  object with getBoundingClientRect() and querySelectorAll(selector); each match needs
 *  getBoundingClientRect(). A match with no area (display:none, unrendered) reserves nothing.
 *  Boxes are {minX, maxX, minY, maxY}, grown by `pad` so two labels never touch. */
export function reservedFromDom(container, selector = RESERVED_SELECTORS, pad = 2) {
  const origin = container.getBoundingClientRect();
  const boxes = [];
  for (const el of container.querySelectorAll(selector)) {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0) || !(r.height > 0)) continue;
    boxes.push({
      minX: r.left - origin.left - pad, maxX: r.right - origin.left + pad,
      minY: r.top - origin.top - pad, maxY: r.bottom - origin.top + pad,
    });
  }
  return boxes;
}

/** The axis-aligned box of a w x h plate centred on (cx, cy) and turned `deg` degrees. */
export function rotatedBox(cx, cy, w, h, deg) {
  const t = (deg * Math.PI) / 180;
  const bw = Math.abs(w * Math.cos(t)) + Math.abs(h * Math.sin(t));
  const bh = Math.abs(w * Math.sin(t)) + Math.abs(h * Math.cos(t));
  return { minX: cx - bw / 2, maxX: cx + bw / 2, minY: cy - bh / 2, maxY: cy + bh / 2 };
}

const overlaps = (a, b) => a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;

// One anchor per distinct (segment) so a road with a long straight run is tried there first.
function anchorsOf(entry) {
  const out = [];
  if (entry.anchor) out.push(entry.anchor);
  const segs = [];
  for (const part of entry.parts || []) {
    for (let i = 1; i < part.length; i += 1) {
      const len = Math.hypot(part[i][0] - part[i - 1][0], part[i][1] - part[i - 1][1]);
      segs.push({ len, a: part[i - 1], b: part[i] });
    }
  }
  segs.sort((x, y) => y.len - x.len);
  for (const s of segs.slice(0, ROAD_ANCHOR_TRIES)) {
    const a = anchorOnPolyline([s.a, s.b]);
    if (a && !out.some((o) => o.lon === a.lon && o.lat === a.lat)) out.push(a);
  }
  return out;
}

/** Roads -> on-screen labels. `entries` are road-names.js entries, already in printing order.
 *  Each is tried at its anchors in turn and takes the first whose rotated box is inside the
 *  viewport and clear of every reserved and every already placed box. Stops at the density cap
 *  (ROAD_DENSITY_CAP[prefs.density], standard when unknown). Returns {placed, dropped}; a
 *  placed label is {key, label, classKey, x, y, lon, lat, bearing, width, height, sizePx} with (x, y)
 *  the label's centre in container pixels and (lon, lat) the ground point it is anchored at.
 *  `bearingOf(anchor, px)`, when given, replaces the anchor's own bearing -- a view that can be
 *  turned or tilted (the 3D panel) lays the label along the road as the screen shows it. */
export function placeRoadLabels(entries, {
  toPx, viewport, measureText, prefs = {}, reserved = [], marginPx = 2, bearingOf,
} = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const cap = ROAD_DENSITY_CAP[prefs.density] != null ? ROAD_DENSITY_CAP[prefs.density] : ROAD_DENSITY_CAP.standard;
  const sizePx = SIZE_SCALE[prefs.size] || SIZE_SCALE.normal;
  const boxes = [...reserved];
  const placed = [];
  let dropped = 0;
  for (const e of list) {
    if (placed.length >= cap) { dropped += 1; continue; }
    const { width, height } = measureText(e.label, sizePx);
    let hit = null;
    for (const a of anchorsOf(e)) {
      const p = toPx(a.lon, a.lat);
      const bearing = bearingOf ? bearingOf(a, p) : a.bearing;
      const box = rotatedBox(p.x, p.y, width, height, bearing);
      if (viewport && (box.minX < marginPx || box.maxX > viewport.width - marginPx
        || box.minY < marginPx || box.maxY > viewport.height - marginPx)) continue;
      if (boxes.some((b) => overlaps(b, box))) continue;
      hit = { p, a, box, bearing };
      break;
    }
    if (!hit) { dropped += 1; continue; }
    boxes.push(hit.box);
    placed.push({
      key: e.key, label: e.label, classKey: e.classKey,
      x: hit.p.x, y: hit.p.y, lon: hit.a.lon, lat: hit.a.lat, bearing: hit.bearing, width, height, sizePx,
    });
  }
  return { placed, dropped };
}

/** Trailing-edge debounce with an injectable clock (the defaults are wrappers, not the bare
 *  functions: a browser's setTimeout throws "Illegal invocation" when called as a method of `timers`): `call(...args)` restarts the wait, so only
 *  the last call in a burst runs `fn`, `ms` after it. `cancel()` drops a pending run. */
export function createDebouncer(fn, ms, timers = { set: (fn, delay) => setTimeout(fn, delay), clear: (h) => clearTimeout(h) }) {
  let handle = null;
  return {
    call(...args) {
      if (handle !== null) timers.clear(handle);
      handle = timers.set(() => { handle = null; fn(...args); }, ms);
    },
    cancel() { if (handle !== null) { timers.clear(handle); handle = null; } },
    pending() { return handle !== null; },
  };
}
