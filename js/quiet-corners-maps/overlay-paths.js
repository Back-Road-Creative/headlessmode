// Page-pixel overlay paths for one sheet: normalized MVUM features (lon/lat
// paths from source-mvum.js) -> clipped polylines in the sheet's pixel space,
// styled per legend symbol so the worker can stroke them. Pure: no DOM,
// network, Date or randomness. x grows right, y grows down from the sheet's top-left.
import { forward } from './geometry.js';
import { symbolForFeature, SYMBOL_BY_KEY, widthPx, widthInForTier } from './legend.js';
import { RENDER_BY_SYMBOL } from './layer-registry.js';

/** Stroke style per legend key; widths are px at 300 dpi. Derived from the one
 *  physical table in legend.js -- the swatch on the key uses the same numbers.
 *
 *  EVERY line symbol, not just the mvum- ones. Restricting this to a key prefix is
 *  what kept trails and state land boundaries off the printed sheet: they had
 *  symbols, controls and tests, and vectorsForSheet then looked them up here and
 *  found nothing. A symbol added to the table now reaches the paper by existing. */
export const STYLE = Object.freeze(Object.fromEntries(
  Object.values(SYMBOL_BY_KEY).filter((s) => s.kind === 'line' && !s.chrome)
    .map((s) => [s.key, { pattern: s.pattern, widthPx: widthPx(s.widthIn, 300), color: s.color }]),
));

/** (lon, lat) -> { x, y } page px on `sheet` via UTM in the job's zone. */
export function pagePxForSheet(sheet, zone, hemisphere) {
  const { extent: e, pixel } = sheet;
  const sx = pixel.width / (e.maxX - e.minX), sy = pixel.height / (e.maxY - e.minY);
  return (lon, lat) => { const p = forward(lat, lon, zone, hemisphere); return { x: (p.easting - e.minX) * sx, y: (e.maxY - p.northing) * sy }; };
}

// Liang–Barsky parametric span [t0, t1] of one segment inside the rect, or null.
function clipSegment([x0, y0], [x1, y1], r) {
  const dx = x1 - x0, dy = y1 - y0;
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, x0 - r.minX], [dx, r.maxX - x0], [-dy, y0 - r.minY], [dy, r.maxY - y0]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; } else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return [t0, t1, (t) => [x0 + t * dx, y0 + t * dy]];
}

/** Sub-paths of `path` inside the sheet pixel rect grown by marginPx; a segment that leaves and re-enters splits the path. */
export function clipPathToRect(path, { width, height }, marginPx = 0) {
  const r = { minX: -marginPx, minY: -marginPx, maxX: width + marginPx, maxY: height + marginPx };
  const out = [];
  let cur = null;
  for (let i = 1; i < path.length; i++) {
    const c = clipSegment(path[i - 1], path[i], r);
    if (!c) { cur = null; continue; }
    const [t0, t1, at] = c;
    if (t0 > 0 || !cur) { cur = [at(t0)]; out.push(cur); }
    cur.push(at(t1));
    if (t1 < 1) cur = null;
  }
  return out;
}

/** True when `key`'s layer may draw at this scale denominator. `dropBelowScale`
 *  is the COARSEST scale the layer is readable at, so 1:48,000 drops a layer
 *  declaring 24000 while 1:24,000 keeps it. A symbol no layer claims draws — the
 *  registry decides density, and silence is not a prohibition. */
export function drawsAtScale(key, scale, rules = RENDER_BY_SYMBOL) {
  const limit = rules[key]?.dropBelowScale;
  return !(limit && scale && scale > limit);
}

/** Vectors for the worker plus the legend keys actually emitted; features with nothing inside the sheet count as dropped.
 *  `scale` is the recipe's scale denominator: a layer too dense to read at it is dropped here, not withheld from the map. */
export function vectorsForSheet(features, sheet, { zone, hemisphere, dpi = 300, marginPx = 16, roadQuality = {}, scale = null, renderRules = RENDER_BY_SYMBOL }) {
  const toPx = pagePxForSheet(sheet, zone, hemisphere);
  const vectors = [], symbolKeys = new Set();
  let dropped = 0;
  for (const f of features) {
    // A feature that already knows its own symbol says so; symbolForFeature is the
    // MVUM road/trail decision, and asking it about a trail or a land boundary
    // would silently answer with a road.
    const key = f.symbolKey || symbolForFeature(f).key, s = STYLE[key];
    if (!s) { dropped++; continue; }
    if (!drawsAtScale(key, scale, renderRules)) { dropped++; continue; }
    const subs = (f.paths || []).flatMap((p) => clipPathToRect(p.map(([lon, lat]) => { const q = toPx(lon, lat); return [q.x, q.y]; }), sheet.pixel, marginPx));
    if (!subs.length) { dropped++; continue; }
    symbolKeys.add(key);
    // Width carries road quality; the symbol's own pattern still carries season.
    const tier = key.startsWith('mvum-road-') ? (roadQuality[f.id] || {}).tier : null;
    const widthIn = widthInForTier(tier, SYMBOL_BY_KEY[key].widthIn);
    // The label rule rides on the vector: labelCandidates holds no registry.
    const labels = renderRules[key]?.labels || 'ifRoom';
    for (const path of subs) vectors.push({ key, id: f.id ?? null, labels, path, pattern: s.pattern, widthPx: widthPx(widthIn, dpi), color: s.color });
  }
  return { vectors, symbolKeys, dropped };
}

const segLen = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const pathLen = (p) => p.reduce((sum, pt, i) => (i ? sum + segLen(p[i - 1], pt) : 0), 0);

/** One label per feature id: the midpoint of its longest sub-path when that is at least minLengthPx long, angled along the segment. */
export function labelCandidates(vectors, { minLengthPx = 120 } = {}) {
  const best = new Map();
  for (const v of vectors) {
    if (v.id === null || v.id === undefined) continue;
    if (v.labels === 'none') continue;   // the layer asked not to be lettered
    const len = pathLen(v.path);
    if (len >= minLengthPx && !(best.has(v.id) && best.get(v.id).len >= len)) best.set(v.id, { v, len });
  }
  return [...best.values()].map(({ v, len }) => {
    let rest = len / 2, i = 1;
    while (i < v.path.length - 1 && rest > segLen(v.path[i - 1], v.path[i])) rest -= segLen(v.path[i - 1], v.path[i++]);
    const [a, b] = [v.path[i - 1], v.path[i]], t = rest / segLen(a, b);
    let angleDeg = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
    if (angleDeg > 90) angleDeg -= 180; else if (angleDeg < -90) angleDeg += 180;
    return { key: v.key, text: v.id, x: a[0] + t * (b[0] - a[0]), y: a[1] + t * (b[1] - a[1]), angleDeg };
  });
}
