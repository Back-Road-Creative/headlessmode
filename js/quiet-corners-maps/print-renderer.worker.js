// Print-renderer worker for /quiet-corners/maps/: draws one sheet at a time on an
// OffscreenCanvas from tiles the page fetched and placed, and posts the JPEG back.
// Module worker (`new Worker(url, { type: 'module' })`): the import works under
// `script-src 'self'`. No network, no DOM. Each op's transform maps SOURCE pixel
// space to page pixels for its mesh cell (the page pre-composes the cell affine
// with the tile offset into e,f), so the worker draws every tile at the origin.
import { TYPES, PHASES, PATTERNS, validateRenderRequest, makeProgress, makeDone, makeError, transferablesOf } from './render-protocol.js';

let cancelled = false;
let queue = Promise.resolve(); // renders run one at a time, in order

async function renderSheet(msg) {
  const started = performance.now();
  const req = validateRenderRequest(msg);
  const tiles = new Map(req.tiles.map((t) => [t.key, t.bitmap]));
  const canvas = new OffscreenCanvas(req.width, req.height);
  try {
    postMessage(makeProgress(PHASES.RENDER, req.sheetId));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = req.background || '#ffffff';
    ctx.fillRect(0, 0, req.width, req.height);
    let drewOps = 0;
    for (const { key, sx, sy, sw, sh, transform: t } of req.ops) {
      if (cancelled) return;
      ctx.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
      ctx.drawImage(tiles.get(key), sx, sy, sw, sh, 0, 0, sw, sh);
      drewOps++;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const dashScale = (req.dpi || 300) / 300;
    let drewVectors = 0;
    for (const halo of [true, false]) {
      for (const v of req.vectors || []) {
        if (cancelled) return;
        ctx.setLineDash(PATTERNS[v.pattern].map((d) => d * dashScale));
        ctx.strokeStyle = halo ? '#ffffff' : v.color;
        ctx.lineWidth = halo ? v.widthPx + 2 : v.widthPx;
        ctx.beginPath();
        v.path.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
        if (!halo) drewVectors++;
      }
    }
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: req.jpegQuality === undefined ? 0.85 : req.jpegQuality });
    const bytes = await blob.arrayBuffer();
    if (cancelled) return;
    const done = makeDone(req.sheetId, bytes, { width: req.width, height: req.height, drewOps, drewVectors, ms: performance.now() - started });
    postMessage(done, transferablesOf(done));
  } finally {
    canvas.width = canvas.height = 0; // release the page buffer before the next sheet
    for (const bitmap of tiles.values()) if (bitmap && typeof bitmap.close === 'function') bitmap.close();
  }
}

self.onmessage = ({ data: msg = {} }) => {
  if (msg.type === TYPES.CANCEL) { cancelled = true; self.close(); return; }
  if (msg.type !== TYPES.RENDER) return;
  // One promise chain serialises renders; a failed sheet reports and the chain continues.
  queue = queue.then(() => renderSheet(msg)).catch((err) => { if (!cancelled) postMessage(makeError(msg.sheetId, err)); });
};

postMessage({ type: TYPES.READY });
