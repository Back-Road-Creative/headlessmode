// USGS Topo tile adapter for Quiet Corners Field Maps: which zoom level, which tiles, bounded fetching,
// and missing-tile accounting. Everything but fetchTiles is pure; fetchTiles takes its fetch as an
// argument (no network in tests, no Date anywhere). Tile scheme: Web Mercator, 256 px, world origin
// top-left — the service's {z}/{y}/{x} addressing is the standard XYZ grid with y and x swapped in the path.
import { inverse } from './geometry.js';
import { SOURCES, REQUEST_POLICY, FAILURE } from './source-registry.js';
import { fetchWithDeadline } from './request.js';
import { mercatorPixel, TILE_SIZE, EARTH_RADIUS } from './raster-placement.js';

export { TILE_SIZE, EARTH_RADIUS };
const D2R = Math.PI / 180, TOPO = SOURCES.usgsTopo;

/** Ground metres per tile pixel at `level` and latitude (equator value × cos lat); level 16 ≈ 2.389 m. */
export function mercatorResolution(level, latDeg = 0) {
  return ((2 * Math.PI * EARTH_RADIUS) / (TILE_SIZE * 2 ** level)) * Math.cos(latDeg * D2R);
}

/** Integer tile column/row plus the fractional world pixel of a lon/lat at `level`. */
export function lonLatToTile(lonDeg, latDeg, level) {
  const { x: px, y: py } = mercatorPixel(lonDeg, latDeg, level);
  return { x: Math.floor(px / TILE_SIZE), y: Math.floor(py / TILE_SIZE), px, py };
}

/** WGS84 bounds of tile (x, y) at `level`. */
export function tileBounds(x, y, level) {
  const n = 2 ** level, lat = (row) => Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) / D2R;
  return { minLon: (x / n) * 360 - 180, minLat: lat(y + 1), maxLon: ((x + 1) / n) * 360 - 180, maxLat: lat(y) };
}

/** Smallest level whose resolution at latDeg is ≤ metersPerPixel; past maxLevel the cache falls short. */
export function chooseLevel({ metersPerPixel, latDeg, maxLevel = TOPO.tile.maxCachedLevelObserved }) {
  let level = 0;
  while (level < maxLevel && mercatorResolution(level, latDeg) > metersPerPixel) level++;
  const sourceMetersPerPixel = mercatorResolution(level, latDeg);
  return { level, sourceMetersPerPixel, shortfall: sourceMetersPerPixel > metersPerPixel, ratio: sourceMetersPerPixel / metersPerPixel };
}

const tileRef = (z, x, y) => ({
  key: `${z}/${x}/${y}`, z, x, y, url: TOPO.tile.urlTemplate.replace('{z}', z).replace('{y}', y).replace('{x}', x),
});

/** Tiles covering one sheet: its UTM extent sampled to a WGS84 bbox (corners + 8 per edge), padded by bufferPx source pixels. */
export function tilesForSheet(sheet, { zone, hemisphere, level, bufferPx = 8 }) {
  const e = sheet.extent, b = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
  for (let i = 0; i <= 8; i++) {
    const t = i / 8, x = e.minX + t * (e.maxX - e.minX), y = e.minY + t * (e.maxY - e.minY);
    for (const [ex, ny] of [[x, e.minY], [x, e.maxY], [e.minX, y], [e.maxX, y]]) {
      const { lat, lon } = inverse(ex, ny, zone, hemisphere);
      b.minLon = Math.min(b.minLon, lon); b.maxLon = Math.max(b.maxLon, lon);
      b.minLat = Math.min(b.minLat, lat); b.maxLat = Math.max(b.maxLat, lat);
    }
  }
  const nw = mercatorPixel(b.minLon, b.maxLat, level), se = mercatorPixel(b.maxLon, b.minLat, level);
  const x0 = Math.floor((nw.x - bufferPx) / TILE_SIZE), x1 = Math.floor((se.x + bufferPx) / TILE_SIZE);
  const y0 = Math.floor((nw.y - bufferPx) / TILE_SIZE), y1 = Math.floor((se.y + bufferPx) / TILE_SIZE);
  const tiles = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push(tileRef(level, x, y));
  return { level, tiles, bboxLonLat: b };
}

/** Tiles for every sheet of a plan, de-duplicated; `shared` counts tiles used by two or more sheets. */
export function tilesForPlan(plan, opts) {
  const perSheet = {}, byKey = new Map(), uses = new Map();
  for (const sheet of plan.sheets) {
    const { tiles } = tilesForSheet(sheet, opts);
    perSheet[sheet.id] = tiles.map((t) => t.key);
    for (const t of tiles) { byKey.set(t.key, t); uses.set(t.key, (uses.get(t.key) || 0) + 1); }
  }
  const unique = [...byKey.values()];
  return { level: opts.level, perSheet, unique, count: unique.length, shared: [...uses.values()].filter((n) => n >= 2).length };
}

/** Is `count` tiles within the job budget and the service's export cap? */
export function budgetCheck(count, { maxTiles = 6000, exportCap = TOPO.limits.maxExportTilesCount } = {}) {
  const cap = Math.min(maxTiles, exportCap), ok = count <= cap;
  return { ok, message: `This job needs ${count} tiles; the budget is ${cap}.${ok ? '' : ' Shrink the area or choose a coarser scale.'}` };
}

/** Which required tile keys were not received; message is the registry's blocking failure or null. */
export function accountTiles(required, received) {
  const have = new Set(received), missing = required.filter((k) => !have.has(k));
  return { missing, complete: missing.length === 0, message: missing.length ? FAILURE.tilesMissing(missing.length, required.length) : null };
}

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});
const ABORTED = { ok: false, status: null, bytes: null, error: 'aborted' };

/** Fetch unique tiles with bounded concurrency, per-request timeout, retries on network/5xx/429 only, and cancel via `signal`. */
export async function fetchTiles(tiles, {
  fetchImpl = globalThis.fetch, signal, concurrency = REQUEST_POLICY.maxConcurrent, timeoutMs = TOPO.timeoutMs,
  retries = REQUEST_POLICY.retries, backoffMs = REQUEST_POLICY.retryBackoffMs, onProgress,
} = {}) {
  const queue = [...new Map(tiles.map((t) => [t.key, t])).values()], results = new Map(), requested = queue.length;
  let received = 0, retriedCount = 0, next = 0;
  const attempt = async (tile) => {
    const got = await fetchWithDeadline(tile.url, { fetchImpl, signal, timeoutMs, read: (res) => res.arrayBuffer() });
    if (got.ok) return { ok: true, status: got.httpStatus, bytes: got.body, error: null };
    if (got.httpStatus) return { ok: false, status: got.httpStatus, bytes: null, error: `HTTP ${got.httpStatus}` };
    return { ok: false, status: null, bytes: null, error: got.status === 'timeout' ? `timeout after ${timeoutMs} ms` : got.error };
  };
  const retryable = (r) => r.status === null || r.status === 429 || r.status >= 500;
  const worker = async () => {
    while (next < queue.length) {
      const tile = queue[next++];
      let r = signal?.aborted ? ABORTED : await attempt(tile);
      for (let i = 0; i < retries && !r.ok && retryable(r) && !signal?.aborted; i++) {
        retriedCount++;
        await sleep(backoffMs[Math.min(i, backoffMs.length - 1)] ?? 0, signal);
        r = signal?.aborted ? ABORTED : await attempt(tile);
      }
      results.set(tile.key, r);
      if (r.ok) received++;
      onProgress?.(received, requested);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, requested)) }, worker));
  return { results, requested, received, retriedCount };
}
