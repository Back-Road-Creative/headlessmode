// Sheet planning for /quiet-corners/maps/: turns a projected extent into a
// centered grid of true-scale Letter sheets. Pure and deterministic — no DOM,
// network, canvas, Date or randomness — so it runs identically in the browser
// and under `node --test`. Units are inches, points (1/72 in) and projected
// meters in the job's UTM zone; never CSS px.
//
// Coordinate convention: frame.xPt / frame.yPt are measured from the TOP-left
// of the page, y growing downward. PDF's origin is bottom-left; that flip
// belongs to the pdf unit, not here.
import { forward, cellFromId, bboxOfCells } from './geometry.js';

export const POINTS_PER_INCH = 72;
export const METERS_PER_INCH = 0.0254;
export const PAPER = { letter: { widthIn: 8.5, heightIn: 11 } };
export const LIMITS = { maxRows: 26, maxCols: 99, defaultMaxPages: 24 };
export const FURNITURE = { headerIn: 0.4, footerIn: 0.6 };

const ORIENTATIONS = ['portrait', 'landscape'];
const SCALES = [24000, 48000];
const OVERLAPS = [0.25, 0.5, 0.75];
const DPIS = [300, 200];
const HEMISPHERES = ['N', 'S'];
const EPSILON_M = 1e-6;
const KEY_ORDER = ['paper', 'orientation', 'scale', 'overlapIn', 'insetIn', 'dpi',
  'maxPages', 'extent', 'zone', 'hemisphere', 'title'];
const EXTENT_KEYS = ['minX', 'minY', 'maxX', 'maxY'];
const BBOX_KEYS = ['minLon', 'minLat', 'maxLon', 'maxLat'];

// The lon/lat box the area was chosen from. Optional: recipes saved before it was
// stored carry only the projected extent, and a restore then rebuilt the box from the
// sheet grid's UTM ring — the extent grown to whole sheets — so every save/restore
// cycle enlarged the area. Kept alongside the extent so a restore returns what the
// person actually selected; absent reads as null rather than throwing.
function optionalBbox(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object') throw new TypeError('bboxLonLat must be an object');
  const box = {};
  for (const k of BBOX_KEYS) box[k] = num(v[k], `bboxLonLat.${k}`);
  if (box.maxLon <= box.minLon || box.maxLat <= box.minLat) throw new RangeError('bboxLonLat must have positive width and height');
  return box;
}

function num(v, name) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${name} must be a finite number`);
  return v;
}
function oneOf(v, allowed, name) {
  if (!allowed.includes(v)) throw new RangeError(`${name} must be one of ${allowed.join(', ')}`);
  return v;
}

// A quad-set selection: 1..maxRows*maxCols distinct quadrangle ids, each valid under
// cellFromId, normalized to canonical sort order (north to south, then west to east —
// the same order quadsCoveringBox returns, so a selection built from it round-trips
// unchanged), and accompanied by a bboxLonLat that is EXACTLY bboxOfCells(quads). That
// last check is deliberate, not incidental: it is what keeps a stored recipe's box from
// silently drifting away from the quads it claims to be, the migration trap the
// quad-set feature exists to close (see plan §0 C6).
function sortQuadIds(ids) {
  const parsed = ids.map((id) => { const [row, col] = id.split(':').map(Number); return { id, row, col }; });
  parsed.sort((a, b) => b.row - a.row || a.col - b.col);
  return parsed.map((p) => p.id);
}
function optionalQuads(quads, bboxLonLat) {
  if (quads === undefined || quads === null) return null;
  if (!Array.isArray(quads) || quads.length === 0) throw new RangeError('quads must be a non-empty array of quadrangle ids');
  const maxQuads = LIMITS.maxRows * LIMITS.maxCols;
  if (quads.length > maxQuads) throw new RangeError(`quads must have at most ${maxQuads} entries`);
  const seen = new Set();
  for (const id of quads) {
    cellFromId(id); // throws RangeError on a malformed id
    if (seen.has(id)) throw new RangeError(`duplicate quadrangle id: ${id}`);
    seen.add(id);
  }
  const sorted = sortQuadIds(quads);
  if (!bboxLonLat) throw new RangeError('quads must be accompanied by bboxLonLat');
  const expected = bboxOfCells(sorted.map(cellFromId));
  for (const k of BBOX_KEYS) {
    if (bboxLonLat[k] !== expected[k]) throw new RangeError('bboxLonLat must equal bboxOfCells(quads) exactly');
  }
  return sorted;
}

// Validates a recipe and fills defaults. Every planSheets/serialize/parse call
// goes through here, so a bad field can never reach the geometry.
function validateInput(input) {
  if (!input || typeof input !== 'object') throw new TypeError('input must be an object');
  const paper = input.paper;
  if (typeof paper !== 'string') throw new TypeError('paper must be a string');
  if (!PAPER[paper]) throw new RangeError(`paper must be one of ${Object.keys(PAPER).join(', ')}`);
  const insetIn = input.insetIn === undefined ? 0.25 : num(input.insetIn, 'insetIn');
  if (insetIn < 0) throw new RangeError('insetIn must be >= 0');
  const maxPages = input.maxPages === undefined ? LIMITS.defaultMaxPages : num(input.maxPages, 'maxPages');
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new RangeError('maxPages must be a positive integer');
  const zone = num(input.zone, 'zone');
  if (!Number.isInteger(zone) || zone < 1 || zone > 60) throw new RangeError('zone must be an integer 1..60');
  if (typeof input.title !== 'string') throw new TypeError('title must be a string');
  const ext = input.extent;
  if (!ext || typeof ext !== 'object') throw new TypeError('extent must be an object');
  const extent = {};
  for (const k of EXTENT_KEYS) extent[k] = num(ext[k], `extent.${k}`);
  if (extent.maxX <= extent.minX || extent.maxY <= extent.minY) throw new RangeError('extent must have positive width and height');
  const bboxLonLat = optionalBbox(input.bboxLonLat);
  return {
    paper,
    orientation: oneOf(input.orientation, ORIENTATIONS, 'orientation'),
    scale: oneOf(num(input.scale, 'scale'), SCALES, 'scale'),
    overlapIn: oneOf(num(input.overlapIn, 'overlapIn'), OVERLAPS, 'overlapIn'),
    insetIn,
    dpi: oneOf(num(input.dpi, 'dpi'), DPIS, 'dpi'),
    maxPages,
    extent,
    zone,
    hemisphere: oneOf(input.hemisphere, HEMISPHERES, 'hemisphere'),
    title: input.title,
    bboxLonLat,
    quads: optionalQuads(input.quads, bboxLonLat),
  };
}

const rowLetter = (r) => String.fromCharCode(65 + r);
const countAlong = (extentM, groundM, strideM) =>
  1 + Math.ceil(Math.max(0, extentM - groundM - EPSILON_M) / strideM);

// A quad cell's lon/lat box projected to a closed ring of UTM points (8 samples per
// edge, the density projectBbox uses for its extent-only scan — geometry.js:96-109).
// Unlike projectBbox this keeps the points IN ORDER around the ring, because
// Sutherland–Hodgman clipping needs an ordered polygon, not just a bounding box: a
// 7.5-minute cell is very slightly bowed in projection (grid convergence), and a core
// that just grazes a corner needs the real edge, not its bounding rectangle.
function projectRing(b, zone, hemisphere, samplesPerEdge = 8) {
  const lerp = (lo, hi, t) => lo + t * (hi - lo);
  const latLon = [];
  for (let i = 0; i <= samplesPerEdge; i++) latLon.push([b.minLat, lerp(b.minLon, b.maxLon, i / samplesPerEdge)]); // south, west -> east
  for (let i = 1; i <= samplesPerEdge; i++) latLon.push([lerp(b.minLat, b.maxLat, i / samplesPerEdge), b.maxLon]); // east, south -> north
  for (let i = 1; i <= samplesPerEdge; i++) latLon.push([b.maxLat, lerp(b.maxLon, b.minLon, i / samplesPerEdge)]); // north, east -> west
  for (let i = 1; i <= samplesPerEdge; i++) latLon.push([lerp(b.maxLat, b.minLat, i / samplesPerEdge), b.minLon]); // west, north -> south
  return latLon.map(([lat, lon]) => { const p = forward(lat, lon, zone, hemisphere); return [p.easting, p.northing]; });
}

// Sutherland–Hodgman: clip a (possibly non-convex-looking but here always simple)
// polygon against one axis-aligned rectangle, one half-plane at a time.
function clipHalfPlane(points, inside, intersect) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const curr = points[i], prev = points[(i + points.length - 1) % points.length];
    const currIn = inside(curr), prevIn = inside(prev);
    if (currIn) {
      if (!prevIn) out.push(intersect(prev, curr));
      out.push(curr);
    } else if (prevIn) {
      out.push(intersect(prev, curr));
    }
  }
  return out;
}
const lerpPoint = (a, b, t) => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
function clipToRect(poly, rect) {
  let pts = poly;
  pts = clipHalfPlane(pts, (p) => p[0] >= rect.minX, (a, b) => lerpPoint(a, b, (rect.minX - a[0]) / (b[0] - a[0])));
  pts = clipHalfPlane(pts, (p) => p[0] <= rect.maxX, (a, b) => lerpPoint(a, b, (rect.maxX - a[0]) / (b[0] - a[0])));
  pts = clipHalfPlane(pts, (p) => p[1] >= rect.minY, (a, b) => lerpPoint(a, b, (rect.minY - a[1]) / (b[1] - a[1])));
  pts = clipHalfPlane(pts, (p) => p[1] <= rect.maxY, (a, b) => lerpPoint(a, b, (rect.maxY - a[1]) / (b[1] - a[1])));
  return pts;
}
function polygonArea(pts) {
  if (pts.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}
// core ∩ (union of the selected quads' polygons), in core-local metres (subtracting
// the core's own corner before clipping keeps the numbers in the low thousands
// instead of the full UTM easting/northing range, so float error stays small). The
// selected quads never overlap each other, so summing each one's clipped area IS the
// union area — no double count.
function coreQuadArea(core, polygons) {
  let total = 0;
  for (const poly of polygons) {
    const shifted = poly.map(([x, y]) => [x - core.minX, y - core.minY]);
    const localCore = { minX: 0, minY: 0, maxX: core.maxX - core.minX, maxY: core.maxY - core.minY };
    total += polygonArea(clipToRect(shifted, localCore));
  }
  return total;
}
// The keep-test threshold: a dropped core may still graze a quad along a shared
// boundary (float slop, or the ring's polygon sampling), but never by more than a
// sliver a few square metres wide. 1 m² separates "genuinely inside" from that slop.
const MIN_KEPT_AREA_M2 = 1;

export function planSheets(rawInput) {
  const input = validateInput(rawInput);
  const { scale, overlapIn, insetIn, dpi, extent, quads } = input;
  const dims = PAPER[input.paper];
  const landscape = input.orientation === 'landscape';
  const pageWidthIn = landscape ? dims.heightIn : dims.widthIn;
  const pageHeightIn = landscape ? dims.widthIn : dims.heightIn;
  const page = { widthIn: pageWidthIn, heightIn: pageHeightIn,
    widthPt: pageWidthIn * POINTS_PER_INCH, heightPt: pageHeightIn * POINTS_PER_INCH };
  const frame = {
    widthIn: pageWidthIn - 2 * insetIn,
    heightIn: pageHeightIn - 2 * insetIn - FURNITURE.headerIn - FURNITURE.footerIn,
    xPt: insetIn * POINTS_PER_INCH,
    yPt: (insetIn + FURNITURE.headerIn) * POINTS_PER_INCH,
  };
  if (frame.widthIn <= overlapIn || frame.heightIn <= overlapIn) throw new RangeError('inset leaves no map frame');
  const mPerIn = scale * METERS_PER_INCH;
  const groundWidthM = frame.widthIn * mPerIn;
  const groundHeightM = frame.heightIn * mPerIn;
  const strideXM = (frame.widthIn - overlapIn) * mPerIn;
  const strideYM = (frame.heightIn - overlapIn) * mPerIn;
  const cols = countAlong(extent.maxX - extent.minX, groundWidthM, strideXM);
  const rows = countAlong(extent.maxY - extent.minY, groundHeightM, strideYM);
  if (rows > LIMITS.maxRows) throw new RangeError(`${rows} rows of sheets; the limit is ${LIMITS.maxRows}`);
  if (cols > LIMITS.maxCols) throw new RangeError(`${cols} columns of sheets; the limit is ${LIMITS.maxCols}`);
  const gridCount = rows * cols;
  if (!quads && gridCount > input.maxPages) throw new RangeError(`${gridCount} pages; the limit is ${input.maxPages}`);
  const coveredW = groundWidthM + (cols - 1) * strideXM;
  const coveredH = groundHeightM + (rows - 1) * strideYM;
  const cx = (extent.minX + extent.maxX) / 2;
  const cy = (extent.minY + extent.maxY) / 2;
  const covered = { minX: cx - coveredW / 2, minY: cy - coveredH / 2, maxX: cx + coveredW / 2, maxY: cy + coveredH / 2 };
  const pixel = { width: Math.round(frame.widthIn * dpi), height: Math.round(frame.heightIn * dpi) };
  const metersPerPixel = mPerIn / dpi;

  // Without quads every grid position is kept — today's behaviour, byte for byte.
  // With quads, a grid position is kept iff its CORE (its share of `covered` with no
  // overlap band — the last row/column stretched to covered's own edge to absorb the
  // countAlong epsilon slack) meets the union of the selected quads' polygons by more
  // than MIN_KEPT_AREA_M2. `keep` is null in the no-quads case so idAt/neighbours below
  // need no special-casing.
  let keep = null;
  if (quads) {
    const polygons = quads.map((id) => projectRing(cellFromId(id), input.zone, input.hemisphere));
    keep = new Set();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const coreMinX = covered.minX + c * strideXM;
        const coreMaxX = c === cols - 1 ? covered.maxX : coreMinX + strideXM;
        const coreMaxY = covered.maxY - r * strideYM;
        const coreMinY = r === rows - 1 ? covered.minY : coreMaxY - strideYM;
        const core = { minX: coreMinX, minY: coreMinY, maxX: coreMaxX, maxY: coreMaxY };
        if (coreQuadArea(core, polygons) > MIN_KEPT_AREA_M2) keep.add(r * cols + c);
      }
    }
    // The limit applies to what actually prints, not to the envelope grid: a quad set
    // can span a grid far larger than maxPages as long as few enough of its positions
    // are kept (plan §3, "the limit applies to kept, not to the grid").
    if (keep.size > input.maxPages) throw new RangeError(`${keep.size} pages; the limit is ${input.maxPages}`);
  }

  const idAt = (r, c) => {
    if (r < 0 || c < 0 || r >= rows || c >= cols) return null;
    if (keep && !keep.has(r * cols + c)) return null;
    return rowLetter(r) + (c + 1);
  };
  const sheets = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (keep && !keep.has(r * cols + c)) continue;
      const minX = covered.minX + c * strideXM;
      const maxY = covered.maxY - r * strideYM; // row A is northernmost
      sheets.push({
        id: idAt(r, c), row: r, col: c,
        extent: { minX, minY: maxY - groundHeightM, maxX: minX + groundWidthM, maxY },
        neighbors: { n: idAt(r - 1, c), s: idAt(r + 1, c), e: idAt(r, c + 1), w: idAt(r, c - 1) },
        pixel: { ...pixel }, metersPerPixel,
      });
    }
  }
  return { page, frame, groundWidthM, groundHeightM, strideXM, strideYM,
    rows, cols, count: sheets.length, gridCount, covered, sheets, input };
}

/** Share of the printed page that carries map: frame area / page area. The remainder is
 *  the inset margins plus the header and footer bands. Pure, so CI can hold a coverage
 *  floor without printing anything (plan §4, U-Q1). */
export function coverageRatio(plan) {
  return (plan.frame.widthIn * plan.frame.heightIn) / (plan.page.widthIn * plan.page.heightIn);
}

// v2 adds quads; recipeVersion is written first so a human or a debugger sees it
// before anything else. An absent recipeVersion on read means 1 — every recipe ever
// saved before this unit shipped still parses exactly as it did before.
const RECIPE_VERSION = 2;

// Canonical JSON: fixed key order and defaults filled, so two recipes that
// plan the same sheets serialize to the same string (a stable cache key).
export function serializeRecipe(rawInput) {
  const input = validateInput(rawInput);
  const ordered = { recipeVersion: RECIPE_VERSION };
  for (const k of KEY_ORDER) ordered[k] = input[k];
  ordered.extent = Object.fromEntries(EXTENT_KEYS.map((k) => [k, input.extent[k]]));
  if (input.bboxLonLat) ordered.bboxLonLat = Object.fromEntries(BBOX_KEYS.map((k) => [k, input.bboxLonLat[k]]));
  if (input.quads) ordered.quads = input.quads;
  return JSON.stringify(ordered);
}

export function parseRecipe(text) {
  if (typeof text !== 'string') throw new TypeError('recipe must be a string');
  const raw = JSON.parse(text);
  const { recipeVersion, ...rest } = raw;
  const version = recipeVersion === undefined ? 1 : recipeVersion;
  if (!Number.isInteger(version) || version < 1 || version > RECIPE_VERSION) {
    throw new RangeError(`recipe version ${version} is newer than this page understands`);
  }
  if (version === 1 && rest.quads !== undefined) {
    throw new RangeError('quads require recipe version 2, not 1');
  }
  return validateInput(rest);
}
