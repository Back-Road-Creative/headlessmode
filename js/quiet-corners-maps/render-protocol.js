// Render protocol between the /quiet-corners/maps/ page and its print-renderer
// worker: message shapes, deterministic progress text and a memory estimate.
// Pure (no DOM, network, Date or randomness): shared by page, worker and node --test.

import { SYMBOLS, dashPx, DASH_IN } from './legend.js';

export const TYPES = { RENDER: 'render', CANCEL: 'cancel', PROGRESS: 'progress', DONE: 'done', ERROR: 'error', READY: 'ready' };
export const PHASES = { FETCH: 'fetch', RENDER: 'render', ASSEMBLE: 'assemble' };

/** Dash arrays in px at 300 dpi (the worker scales them by dpi/300), derived from
 *  legend.js's one physical table so the map cannot drift from the key.
 *
 *  Derived, never re-listed. Hand-listing the patterns here is how a symbol added to
 *  the one physical table arrives at a worker that cannot stroke it — the same shape
 *  as #385, where the worker referenced a PATTERNS it never imported. Deriving makes
 *  the omission impossible rather than merely testable. */
export const PATTERNS = Object.freeze(
  Object.fromEntries(Object.keys(DASH_IN).map((name) => [name, dashPx(name, 300)])),
);
const SYMBOL_KEYS = new Set(Object.values(SYMBOLS).map((s) => s.key));
const MAX_SIDE_PX = 6000;
const MAX_LINE_PX = 20;
const SAFE_PEAK_BYTES = 1.2e9;
// Above 16 MP (a 4000 x 4000 page) encoding takes seconds and assembly holds several such JPEGs.
const OK_PAGE_MEGAPIXELS = 16;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const need = (cond, Err, field, what) => { if (!cond) throw new Err(`${field} ${what}`); };
const pageMp = (plan, dpi) => Math.round(plan.frame.widthIn * dpi) * Math.round(plan.frame.heightIn * dpi) / 1e6;

/** Fixed progress strings: 'Fetching a/b', 'Rendering <sheetId>', 'Assembling a/b'. */
export function progressText(phase, a, b) {
  if (phase === PHASES.FETCH) return `Fetching ${a}/${b}`;
  if (phase === PHASES.RENDER) return `Rendering ${a}`;
  if (phase === PHASES.ASSEMBLE) return `Assembling ${a}/${b}`;
  throw new RangeError(`unknown phase ${phase}`);
}

/** Memory/size estimate: peak = one RGBA page canvas + one encoded page + the tile cache. */
export function estimate({ plan, dpi, jpegBytesPerMegapixel = 180000, tileBytes = 20000, uniqueTiles }) {
  const peakAt = (mp) => mp * 4e6 + mp * jpegBytesPerMegapixel + uniqueTiles * tileBytes;
  const okAt = (mp) => peakAt(mp) <= SAFE_PEAK_BYTES && mp <= OK_PAGE_MEGAPIXELS;
  const pageMegapixels = pageMp(plan, dpi);
  const peakBytes = peakAt(pageMegapixels);
  let recommendation = 'ok';
  if (!okAt(pageMegapixels)) recommendation = dpi > 200 && okAt(pageMp(plan, 200)) ? 'use-200-dpi' : 'reduce-area';
  return {
    pageMegapixels, peakBytes, recommendation, safe: peakBytes <= SAFE_PEAK_BYTES,
    pdfBytesEstimate: plan.sheets.length * pageMegapixels * jpegBytesPerMegapixel + 200000, // 200 KB of PDF structure
    downloadBytesEstimate: uniqueTiles * tileBytes,
  };
}

/** Checks a render request; throws TypeError/RangeError naming the offending field. */
export function validateRenderRequest(msg) {
  need(msg && typeof msg === 'object', TypeError, 'message', 'must be an object');
  need(typeof msg.sheetId === 'string' && msg.sheetId, TypeError, 'sheetId', 'must be a non-empty string');
  for (const k of ['width', 'height']) need(Number.isInteger(msg[k]) && msg[k] > 0 && msg[k] <= MAX_SIDE_PX, RangeError, k, `must be an integer 1..${MAX_SIDE_PX}`);
  need(msg.background === undefined || typeof msg.background === 'string', TypeError, 'background', 'must be a string');
  const q = msg.jpegQuality === undefined ? 0.85 : msg.jpegQuality;
  need(finite(q) && q > 0 && q <= 1, RangeError, 'jpegQuality', 'must be in (0, 1]');
  need(msg.dpi === undefined || (Number.isInteger(msg.dpi) && msg.dpi > 0), RangeError, 'dpi', 'must be a positive integer');
  need(Array.isArray(msg.tiles), TypeError, 'tiles', 'must be an array');
  const keys = new Set(msg.tiles.map((t, i) => { need(t && typeof t.key === 'string' && t.bitmap, TypeError, `tiles[${i}]`, 'needs key and bitmap'); return t.key; }));
  need(Array.isArray(msg.ops), TypeError, 'ops', 'must be an array');
  msg.ops.forEach((o, i) => {
    need(o && keys.has(o.key), RangeError, `ops[${i}].key`, 'has no tile');
    for (const k of ['sx', 'sy', 'sw', 'sh']) need(finite(o[k]), TypeError, `ops[${i}].${k}`, 'must be a number');
    need(o.transform && ['a', 'b', 'c', 'd', 'e', 'f'].every((k) => finite(o.transform[k])), TypeError, `ops[${i}].transform`, 'must have finite a..f');
  });
  need(msg.vectors === undefined || Array.isArray(msg.vectors), TypeError, 'vectors', 'must be an array');
  (msg.vectors || []).forEach((v, i) => {
    const at = `vectors[${i}]`;
    need(v && typeof v === 'object', TypeError, at, 'must be an object');
    need(SYMBOL_KEYS.has(v.key), RangeError, `${at}.key`, 'is not a legend symbol key');
    need(Array.isArray(v.path) && v.path.length >= 2 && v.path.every((p) => Array.isArray(p) && p.length === 2 && p.every(finite)),
      RangeError, `${at}.path`, 'needs 2+ finite [x, y] points');
    need(Object.hasOwn(PATTERNS, v.pattern), RangeError, `${at}.pattern`, `must be one of ${Object.keys(PATTERNS).join(', ')}`);
    need(finite(v.widthPx) && v.widthPx > 0 && v.widthPx <= MAX_LINE_PX, RangeError, `${at}.widthPx`, `must be in (0, ${MAX_LINE_PX}]`);
    need(/^#[0-9a-f]{6}$/i.test(v.color), RangeError, `${at}.color`, 'must be #rrggbb');
  });
  return msg;
}

/** Dispatches validation by message type; unknown types are a TypeError. */
export function validateMessage(msg) {
  const type = msg && msg.type;
  if (type === TYPES.RENDER) return validateRenderRequest(msg);
  need(Object.values(TYPES).includes(type), TypeError, 'type', `unknown message type ${type}`);
  return msg;
}

/** Progress message carrying the fixed text for (phase, a, b). */
export const makeProgress = (phase, a, b) => ({ type: TYPES.PROGRESS, phase, text: progressText(phase, a, b), a, b });

/** Done message: the encoded JPEG bytes (ArrayBuffer) plus { width, height, drewOps, drewVectors, ms }. */
export const makeDone = (sheetId, jpegBytes, { width, height, drewOps, drewVectors = 0, ms }) =>
  ({ type: TYPES.DONE, sheetId, bytes: jpegBytes, stats: { width, height, drewOps, drewVectors, ms } });

/** Error message for one sheet; the worker keeps serving after posting it. */
export const makeError = (sheetId, error) => ({ type: TYPES.ERROR, sheetId, message: String((error && error.message) || error) });

/** Transfer list for postMessage: the bytes buffer and any ImageBitmap tiles. */
export function transferablesOf(msg) {
  const Bitmap = globalThis.ImageBitmap;
  const bitmaps = (msg.tiles || []).map((t) => t.bitmap).filter((b) => Bitmap && b instanceof Bitmap);
  return msg.bytes instanceof ArrayBuffer ? [msg.bytes, ...bitmaps] : bitmaps;
}
