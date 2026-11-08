// Raster placement for Quiet Corners Field Maps: how a true-scale UTM sheet maps onto Web Mercator
// tile pixels. Pure — no DOM, canvas, network or Date. Coordinate convention: page pixels have their
// origin at the TOP-left of the map frame, x right, y DOWN (sheet.pixel is the frame size); Mercator
// "world pixels" at a level have their origin at the top-left of the world, x east, y south — the same
// handedness, so an affine {a,b,c,d,e,f} here is exactly what ctx.setTransform(a,b,c,d,e,f) takes:
// pageX = a·mx + c·my + e, pageY = b·mx + d·my + f.
import { inverse } from './geometry.js';

export const TILE_SIZE = 256;
export const EARTH_RADIUS = 6378137;
const D2R = Math.PI / 180;

/** Web Mercator world pixel of a lon/lat at `level` (256·2^level pixels across the world). */
export function mercatorPixel(lonDeg, latDeg, level) {
  const n = TILE_SIZE * 2 ** level, s = Math.sin(latDeg * D2R);
  return { x: ((lonDeg + 180) / 360) * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
}

/** (grid+1)² lattice over the sheet, row-major from the top-left: page pixel ↔ world Mercator pixel. */
export function controlPoints(sheet, { zone, hemisphere, level, grid = 4 }) {
  const { extent: e, pixel: p } = sheet, pts = [];
  for (let r = 0; r <= grid; r++) for (let c = 0; c <= grid; c++) {
    const u = c / grid, v = r / grid;
    const { lat, lon } = inverse(e.minX + u * (e.maxX - e.minX), e.maxY - v * (e.maxY - e.minY), zone, hemisphere);
    pts.push({ pagePx: { x: u * p.width, y: v * p.height }, mercPx: mercatorPixel(lon, lat, level) });
  }
  return pts;
}

// 3×3 normal-equation solve by Gauss-Jordan with partial pivoting.
function solve3(M, v) {
  const m = M.map((row, i) => [...row, v[i]]);
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(m[r][i]) > Math.abs(m[p][i])) p = r;
    [m[i], m[p]] = [m[p], m[i]];
    for (let r = 0; r < 3; r++) if (r !== i) { const k = m[r][i] / m[i][i]; for (let j = i; j < 4; j++) m[r][j] -= k * m[i][j]; }
  }
  return m.map((row, i) => row[3] / row[i]);
}

/** Least-squares affine mercPx → pagePx over ≥3 points (solved about the Mercator centroid for conditioning). */
export function fitAffine(points) {
  if (points.length < 3) throw new RangeError('fitAffine needs at least 3 points');
  const cx = points.reduce((s, p) => s + p.mercPx.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.mercPx.y, 0) / points.length;
  const N = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], rx = [0, 0, 0], ry = [0, 0, 0];
  for (const { mercPx: m, pagePx: p } of points) {
    const row = [m.x - cx, m.y - cy, 1];
    for (let i = 0; i < 3; i++) { rx[i] += row[i] * p.x; ry[i] += row[i] * p.y; for (let j = 0; j < 3; j++) N[i][j] += row[i] * row[j]; }
  }
  const [a, c, e0] = solve3(N, rx), [b, d, f0] = solve3(N, ry);
  const e = e0 - a * cx - c * cy, f = f0 - b * cx - d * cy;
  let max = 0, sum = 0;
  for (const { mercPx: m, pagePx: p } of points) {
    const r = Math.hypot(a * m.x + c * m.y + e - p.x, b * m.x + d * m.y + f - p.y);
    max = Math.max(max, r); sum += r * r;
  }
  return { a, b, c, d, e, f, residualMaxPx: max, residualRmsPx: Math.sqrt(sum / points.length) };
}

/** One affine per grid cell (fitted on the cell's four lattice corners); ok when the worst residual is within budget. */
export function placementMesh(sheet, { zone, hemisphere, level, grid = 4, maxResidualPx = 0.5 }) {
  const pts = controlPoints(sheet, { zone, hemisphere, level, grid }), at = (r, c) => pts[r * (grid + 1) + c];
  const w = sheet.pixel.width / grid, h = sheet.pixel.height / grid, cells = [];
  let worst = 0;
  for (let r = 0; r < grid; r++) for (let c = 0; c < grid; c++) {
    const affine = fitAffine([at(r, c), at(r, c + 1), at(r + 1, c), at(r + 1, c + 1)]);
    worst = Math.max(worst, affine.residualMaxPx);
    cells.push({ pageRect: { x: c * w, y: r * h, w, h }, affine, residualMaxPx: affine.residualMaxPx });
  }
  return { level, cells, worstResidualPx: worst, ok: worst <= maxResidualPx };
}

/** Per cell × intersecting tile (at mesh.level): clip to cell.pageRect, setTransform(op.transform), drawImage(img, sx, sy, sw, sh, dx, dy, sw, sh). */
export function tileDrawOps(mesh, tiles) {
  const ops = [];
  mesh.cells.forEach(({ pageRect: r, affine: t }, cellIndex) => {
    const det = t.a * t.d - t.b * t.c; // page → Mercator: invert the affine at the cell's four corners
    const corners = [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]
      .map(([X, Y]) => [(t.d * (X - t.e) - t.c * (Y - t.f)) / det, (t.a * (Y - t.f) - t.b * (X - t.e)) / det]);
    const x0 = Math.min(...corners.map((p) => p[0])), x1 = Math.max(...corners.map((p) => p[0]));
    const y0 = Math.min(...corners.map((p) => p[1])), y1 = Math.max(...corners.map((p) => p[1]));
    for (const tile of tiles) {
      const tx = tile.x * TILE_SIZE, ty = tile.y * TILE_SIZE;
      const sx = Math.max(0, x0 - tx), sy = Math.max(0, y0 - ty);
      const sw = Math.min(TILE_SIZE, x1 - tx) - sx, sh = Math.min(TILE_SIZE, y1 - ty) - sy;
      if (sw > 0 && sh > 0) ops.push({ cellIndex, key: tile.key, sx, sy, sw, sh, dx: tx + sx, dy: ty + sy, transform: t });
    }
  });
  return ops;
}
