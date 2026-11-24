// Terrain-name print path: normalized GNIS records (terrain-names.js) -> sheet-pixel
// anchors, collision-checked label placement, marker+text draw geometry, manifest
// provenance and legend entries. Pure module -- no DOM, no fetch, no PDFLib.
//
// TRANSPORT CONTRACT (what N2's screen-side registration must hand build.js -- that
// registration, Q/layer-registry.js and Q/main.js, is a different unit and does not
// exist yet):
//   adapters.names = {
//     status: 'ready' | 'partial' | 'capped' | 'over-cap' | 'timeout' | 'error',
//     features: [ ...normalizeFeature() records from terrain-names.js ],
//     retrievedAt: <ISO string>,   // when fetchBounded (source-terrain-names.js) ran
//   }
// build.js reads `adapters.names` exactly like `adapters.trails` / `adapters.land`:
// absent means the names layer was never asked for (nothing drawn, no gate at all);
// present means it was asked for, and `recipe.layers.names !== false` decides whether
// the completeness gate below applies -- an explicit `false` is "disabled", which
// satisfies "until retry or explicit disable" even when a fetch already ran and came
// back partial/over-cap/timeout.

/** kind -> { marker, label }, one entry per kind terrain-names.js's normalizeFeature
 *  can produce (its KINDS table, plus the 'other' vocabulary-gap fallback). `marker`
 *  names a shape pdf.js's markerPath knows how to draw, or null for the default
 *  filled circle -- the same convention legend.js's point() symbols use. */
export const NAME_ICON_BY_KIND = Object.freeze({
  place: { marker: 'square', label: 'Named place' },
  summit: { marker: 'triangle', label: 'Named summit' },
  gap: { marker: 'chevron', label: 'Named gap or pass' },
  ridge: { marker: 'zigzag', label: 'Named ridge or range' },
  river: { marker: 'wave', label: 'Named river (labelled on the reach in view)' },
  creek: { marker: 'wave', label: 'Named creek (labelled on the reach in view)' },
  'water-feature': { marker: 'droplet', label: 'Named falls, spring, lake or reservoir' },
  'other-land': { marker: 'diamond', label: 'Other named landform' },
  'other-water': { marker: 'wave', label: 'Other named water feature' },
  'stream-mouth': { marker: null, label: 'Named stream or canal (labelled at its mouth)' },
  other: { marker: 'diamond', label: 'Other named feature' },
});

// Black, like the label text it sits beside -- the icon SHAPE carries kind
// identity here, not a colour, so a name marker never competes with the hues
// legend.js already spent on roads/trails/land/water.
const NAME_COLOR = '#000000';
const NAME_MARKER_SIZE_IN = 0.07;

/** legend.js's point() shape (kind: 'point'), built the same way so swatchSpec --
 *  generic over any symbol-shaped object -- draws a name marker exactly like a
 *  rec-site marker. Not added to legend.js's own frozen SYMBOLS/SYMBOL_BY_KEY
 *  table: that file is out of this unit's Owns list, so the name vocabulary lives
 *  here as a parallel, self-contained table instead. */
function nameSymbol(kind) {
  const icon = NAME_ICON_BY_KIND[kind] || NAME_ICON_BY_KIND.other;
  return { key: `name-${kind}`, label: icon.label, kind: 'point', marker: icon.marker, sizeIn: NAME_MARKER_SIZE_IN, color: NAME_COLOR };
}

/** Legend entries for exactly the kinds actually drawn on some sheet -- never a
 *  symbol for a kind nothing used, never a drawn kind missing its entry. */
export function nameLegendEntries(drawnKinds) {
  return [...new Set(drawnKinds)].sort().map(nameSymbol);
}

/** The existing completeness-gate wording pattern (source-usgs-topo.js's
 *  accountTiles, surfaced through build.js's `if (!account.complete) throw new
 *  Error(account.message)`; app-state.js's BASE_INCOMPLETE is the same idea on the
 *  screen side), reused for names: an ENABLED names source whose result is not
 *  'ready' blocks export until retry or an explicit `recipe.layers.names === false`. */
export function namesCompletenessGate({ enabled, status }) {
  if (!enabled) return { ok: true };
  if (status === 'ready') return { ok: true };
  const reason = status === 'partial' ? 'partial results'
    : status === 'capped' ? 'a capped answer (more names than one request carries)'
    : status === 'over-cap' ? 'too many features for the area'
    : status === 'timeout' ? 'a timeout'
    : 'an error';
  return { ok: false, reason: `Named terrain (GNIS) must load completely before export (last attempt ended in ${reason}).` };
}

const boxOf = (cx, cy, w, h) => ({ minX: cx - w / 2, maxX: cx + w / 2, minY: cy - h / 2, maxY: cy + h / 2 });
const overlaps = (a, b) => a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;

/** A reserved box for an existing point marker (a rec site, or a name's own
 *  anchor marker) in sheet-pixel space, so a later label cannot be placed on
 *  top of it. */
export function markerBox(x, y, sizePx) { return boxOf(x, y, sizePx, sizePx); }

// Helvetica in WinAnsi averages close to 0.6 * size per character -- generous
// enough that a real collision is never missed at the cost of occasionally
// dropping a label that would just barely have fit. The safe side for "never
// overlapped".
const textWidthPx = (text, sizePx) => text.length * sizePx * 0.6;

/** A reserved box for a text label (an existing trail/road label, or a name
 *  label) in sheet-pixel space. Ignores the label's own rotation angle for the
 *  approximation -- an axis-aligned box a little larger than the true rotated
 *  extent, which is again the safe side for "never overlapped". */
export function approxLabelBox(text, x, y, sizePx) {
  return boxOf(x, y, textWidthPx(text, sizePx), sizePx * 1.2);
}

/** Deterministic label placement for named-terrain anchors, sharing the collision
 *  budget with everything already reserved on the sheet (existing trail/road
 *  labels, rec-site markers, sheet edges/margin via `pixel`+`marginPx`). The
 *  ANCHOR MARKER is drawn for every feature unconditionally and never moves; only
 *  its TEXT LABEL can fail to place, in which case it is dropped and counted --
 *  the marker still prints, so a reader can see something is there even when its
 *  name lost the collision budget.
 *
 *  `features` must already be in the order the caller wants placed (terrain-
 *  names.js's labelPriorityOrder) -- this function places in array order and
 *  never re-sorts, so a deterministic ordering in is a deterministic placement
 *  out.
 *
 *  `toPx(lon, lat)` projects to sheet-pixel space (overlay-paths.js's
 *  pagePxForSheet -- note the (lon, lat) argument order, while a normalized
 *  feature's own `anchor` is [lat, lon]). `reserved` is boxes already spoken for
 *  in that same space. `sizePx` is the physical label/marker size already
 *  converted to this sheet's raster resolution. */
export function placeNameLabels(features, { toPx, reserved = [], pixel, sizePx, marginPx = 8 }) {
  const boxes = [...reserved];
  const marks = [];
  const labels = [];
  let dropped = 0;
  // A fixed, deterministic ring of candidate offsets around the anchor, tried in
  // this order for every label: north first (reads naturally beside a point
  // marker), then clockwise around the remaining seven compass points.
  const OFFSETS = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
  for (const f of features) {
    const p = toPx(f.anchor[1], f.anchor[0]);
    const known = !!NAME_ICON_BY_KIND[f.kind];
    const icon = known ? NAME_ICON_BY_KIND[f.kind] : NAME_ICON_BY_KIND.other;
    const kind = known ? f.kind : 'other';

    const markerAt = markerBox(p.x, p.y, sizePx);
    boxes.push(markerAt);
    marks.push({ id: f.id, kind, marker: icon.marker, x: p.x, y: p.y, sizePx, color: NAME_COLOR, name: f.name });

    const w = textWidthPx(f.name, sizePx), h = sizePx * 1.2, gap = sizePx * 0.6;
    let placed = null;
    for (const [dx, dy] of OFFSETS) {
      const cx = p.x + dx * (w / 2 + gap), cy = p.y + dy * (h / 2 + gap);
      const box = boxOf(cx, cy, w, h);
      if (box.minX < -marginPx || box.maxX > pixel.width + marginPx || box.minY < -marginPx || box.maxY > pixel.height + marginPx) continue;
      if (boxes.some((b) => overlaps(b, box))) continue;
      placed = { box, x: cx, y: cy };
      break;
    }
    if (!placed) { dropped++; continue; }
    boxes.push(placed.box);
    labels.push({ id: f.id, kind, text: f.name, x: placed.x, y: placed.y, angleDeg: 0 });
  }
  return { marks, labels, dropped };
}
