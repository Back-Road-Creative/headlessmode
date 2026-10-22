// The offline browser proof (plan §10, U12).
//
// Every other test here runs the pipeline's pure parts under Node. This one runs the
// WHOLE pipeline in a real browser — module Worker, OffscreenCanvas, createImageBitmap,
// canvas.convertToBlob, pdf-lib — against a local origin, with no network. Those four
// browser APIs are the product's load-bearing assumptions and Node cannot stand in for
// any of them: before this, the only evidence they worked was a manual smoke run.
//
// Skips (rather than fails) when no Chromium is on the box, the way the capture tests do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { FURNITURE, POINTS_PER_INCH } from '../../themes/headlessmode/static/js/quiet-corners-maps/sheet-plan.js';
import { findChromium, launch } from './helpers/browser.mjs';
import { startModuleServer } from './helpers/module-server.mjs';
import { loadPdfLib } from './helpers/load-pdf-lib.mjs';

const CHROMIUM = findChromium();
const skip = CHROMIUM ? false : 'no Chromium on this box (set CHROME_PATH to run this proof)';

// A small area so the proof stays a couple of sheets and a few hundred tiles: the point
// is that every stage runs in the browser, not that it runs at production scale.
const AREA = { minLon: -83.55, minLat: 35.0, maxLon: -83.45, maxLat: 35.03 };

const harness = (origin) => `<!doctype html><meta charset="utf-8"><title>qcm proof</title>
<script type="module">
import { projectBbox } from '${origin}/js/geometry.js';
import { planSheets } from '${origin}/js/sheet-plan.js';
import { runBuild } from '${origin}/js/build.js';
const recipeFor = (area) => ({ paper: 'letter', orientation: 'portrait', scale: 24000, overlapIn: 0.5,
  insetIn: 0.25, dpi: 300, maxPages: 24, title: 'Standing Indian', grid: 'utm-1km',
  layers: { usgsTopo: true, mvum: true }, zone: 17, hemisphere: 'N',
  extent: projectBbox(area, 17, 'N') });
// Serve every tile from the local origin: same-origin bytes keep the canvas clean,
// which is what lets convertToBlob succeed at all.
const fetchImpl = (url, opts) => fetch('${origin}/tile/' + encodeURIComponent(String(url)), opts);
const build = async (area, extra) => {
  const recipe = recipeFor(area), plan = planSheets(recipe);
  const out = await runBuild({ recipe, plan, PDFLib: window.PDFLib,
    workerFactory: () => new Worker('${origin}/js/print-renderer.worker.js', { type: 'module' }),
    adapters: { fetchImpl, createImageBitmap: (b) => createImageBitmap(b), mvum: {} }, ...extra });
  return { out, plan };
};
window.__build = async (area) => {
  await import('${origin}/vendor/pdf-lib.min.js');
  const { out, plan } = await build(area);
  let binary = '';
  for (const b of out.pdfBytes) binary += String.fromCharCode(b);
  return { base64: btoa(binary), stats: out.stats, planned: plan.count, manifest: out.manifest };
};
// The rendered sheet, decoded back to pixels. The tiles are greyscale, so channel 0 carries
// everything and JPEG's chroma subsampling cannot muddy the comparison.
const pixelsOf = async (jpeg) => {
  const bmp = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
  const cx = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d', { willReadFrequently: true });
  cx.drawImage(bmp, 0, 0);
  return cx.getImageData(0, 0, bmp.width, bmp.height);
};
const diff = (A, B, a, b, w, h) => {
  let sum = 0, max = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.abs(A.data[((a.y + y) * A.width + a.x + x) * 4] - B.data[((b.y + y) * B.width + b.x + x) * 4]);
    sum += d; if (d > max) max = d;
  }
  return { mean: sum / (w * h), max, pixels: w * h };
};
window.__seam = async (area) => {
  const { plan } = await build(area, { createPdfImpl: async ({ sheets }) => { window.__sheets = sheets; return new Uint8Array(1); } });
  const img = {};
  for (const s of window.__sheets) img[s.id] = await pixelsOf(s.jpeg);
  const o = Math.round(plan.input.overlapIn * plan.input.dpi);
  const { width: W, height: H } = plan.sheets[0].pixel;
  const ew = plan.sheets.find((s) => s.neighbors.e), ns = plan.sheets.find((s) => s.neighbors.s);
  const S = 8; // the control offset: a seam this far out must be loud, or the test proves nothing
  return { sheets: plan.sheets.map((s) => s.id), overlapPx: o, shiftPx: S,
    horizontal: { pair: [ew.id, ew.neighbors.e], ...diff(img[ew.id], img[ew.neighbors.e], { x: W - o, y: 0 }, { x: 0, y: 0 }, o - S, H),
      control: diff(img[ew.id], img[ew.neighbors.e], { x: W - o, y: 0 }, { x: S, y: 0 }, o - S, H).mean },
    vertical: { pair: [ns.id, ns.neighbors.s], ...diff(img[ns.id], img[ns.neighbors.s], { x: 0, y: H - o }, { x: 0, y: 0 }, W, o - S),
      control: diff(img[ns.id], img[ns.neighbors.s], { x: 0, y: H - o }, { x: 0, y: S }, W, o - S).mean } };
};
window.__ready = true;
</script>`;

// Every drawing operator of one page, with y resolved to page points. pdf-lib writes one
// operator per line and only ever emits translate or scale `cm`s, so accumulating e/f
// (and a/d, for the image box) since the last `q` places what is drawn. Text is absolute:
// its Tm carries the position outright.
function pageInk(doc, index) {
  const list = doc.getPage(index).node.Contents();
  const text = (list.asArray ? list.asArray() : [list]).map((r) => {
    const st = doc.context.lookup(r), raw = Buffer.from(st.getContents ? st.getContents() : st.contents);
    try { return inflateSync(raw); } catch { return raw; }
  }).map((b) => b.toString('latin1')).join('\n');
  let dx = 0, dy = 0, sx = 1, sy = 1, min = Infinity, max = -Infinity;
  const images = [], see = (y) => { if (y < min) min = y; if (y > max) max = y; };
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/), op = parts.pop(), v = parts.map(Number);
    if (op === 'q') { dx = dy = 0; sx = sy = 1; }
    else if (op === 'cm' && v.length === 6) { dx += v[4]; dy += v[5]; sx *= v[0]; sy *= v[3]; }
    else if (op === 'Tm' && v.length === 6) see(v[5]);
    else if ((op === 'm' || op === 'l') && v.length === 2) see(dy + v[1]);
    else if (op === 'Do') images.push({ x: dx, y: dy, w: sx, h: sy });
  }
  return { min, max, images };
}

// How long one page-side build may run. The launch default (120 s) is sized for a UI poke,
// not for rendering, encoding and decoding four 300 dpi sheets. Measured on the qcm suite
// while other runners shared the box: the whole-pipeline proof took 32-101 s and U-Q2 took
// 58-104 s when green, and U-Q2 failed three runs on 'Runtime.evaluate timed out after
// 120000 ms' (two local suites, PR #595's CI run 36357660799). 240 s is ~2.3x the slowest
// green run, and both proofs at their full budget still finish inside the 600 s
// --test-timeout that pr-ci.yml puts on this FILE, so a real hang is still caught and named.
const PROOF_EVALUATE_MS = 240000;

const openProof = async (t) => {
  // The harness imports its modules by absolute URL, so it can only be written once the
  // server knows its own port — hence the callback.
  const server = await startModuleServer(harness);
  t.after(() => server.close());
  const browser = await launch(CHROMIUM, server.origin, { timeoutMs: PROOF_EVALUATE_MS });
  t.after(() => browser.close());
  await browser.evaluate('new Promise((r) => { const t = setInterval(() => { if (window.__ready) { clearInterval(t); r(true); } }, 25); })');
  return { server, browser };
};

test('the whole pipeline builds a PDF in a real browser, offline', { skip }, async (t) => {
  const { server, browser } = await openProof(t);
  const result = await browser.evaluate(`window.__build(${JSON.stringify(AREA)})`);

  console.log(`  proof: ${result.stats.sheets} sheets, ${result.stats.tileCount} tiles at level ${result.stats.level}, ${result.stats.bytes} B, ${result.stats.ms} ms, ${server.tileRequests.length} tile requests served locally`);
  assert.ok(result.stats.sheets >= 2, `expected a multi-sheet plan, got ${result.stats.sheets}`);
  assert.equal(result.stats.sheets, result.planned, 'every planned sheet was rendered');
  assert.ok(server.tileRequests.length > 0, 'tiles were fetched from the local origin');

  const pdf = Buffer.from(result.base64, 'base64');
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-', 'the bytes are a PDF');
  assert.equal(pdf.byteLength, result.stats.bytes, 'the reported size is the real size');

  const { PDFDocument } = loadPdfLib();
  const doc = await PDFDocument.load(pdf);
  // Sheets, plus the index page, plus the legend page.
  assert.equal(doc.getPageCount(), result.planned + 2, 'sheets + index + legend');

  // True-scale printing lives or dies on the page box: Letter portrait is 612 x 792 pt.
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    assert.ok(Math.abs(width - 612) < 0.5, `page width ${width} is not Letter portrait`);
    assert.ok(Math.abs(height - 792) < 0.5, `page height ${height} is not Letter portrait`);
  }

  // U-Q3: furniture geometry, read back out of the PDF rather than off the layout code.
  await t.test('the frame, header band and footer band land where the plan computes them', () => {
    const inset = result.manifest.recipe.insetIn * POINTS_PER_INCH, pageH = 11 * POINTS_PER_INCH;
    const top = pageH - inset - FURNITURE.headerIn * POINTS_PER_INCH;   // PDF y of the frame's top
    const bottom = inset + FURNITURE.footerIn * POINTS_PER_INCH;       // ... and of its bottom
    const ink = pageInk(doc, 0);
    assert.equal(ink.images.length, 1, 'a sheet page carries exactly one map image');
    const want = { x: inset, y: bottom, w: 8.5 * POINTS_PER_INCH - 2 * inset, h: top - bottom };
    for (const k of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(ink.images[0][k] - want[k]) < 1e-6, `map image ${k} is ${ink.images[0][k]}, not ${want[k]}`);
    // Nothing is drawn outside the inset, so no map content reaches under the footer, and
    // both bands are actually used rather than silently empty.
    assert.ok(ink.min >= inset - 1e-6, `ink reaches ${ink.min} pt, inside the ${inset} pt margin`);
    assert.ok(ink.max <= pageH - inset + 1e-6, `ink reaches ${ink.max} pt, past the top margin`);
    assert.ok(ink.min < bottom, 'the footer band carries the source and print notes');
    assert.ok(ink.max > top, 'the header band carries the title and sheet id');
  });
});

// A 2x2 area, so one build yields both an east-west and a north-south seam.
const SEAM_AREA = { minLon: -83.55, minLat: 35.0, maxLon: -83.45, maxLat: 35.09 };
// The worker encodes each sheet as JPEG at quality 0.85, and the two strips of a seam sit
// at different offsets inside their pages, so the 8x8 DCT grid falls in a different phase
// on each: identical source pixels come back with slightly different rounding. Hence a
// mean/max absolute difference rather than equality. Measured on this fixture: mean 0.5 of
// a grey level, worst single pixel 49, against a control (the same strips 8 px out of
// register) of 13-18 mean. The mean is the load-bearing number; the max only has to rule
// out a whole region being wrong, so it is set well clear of one ringing pixel.
const SEAM_MEAN = 2, SEAM_MAX = 64;

test('U-Q2: adjacent sheets carry the same ground in their overlap strip', { skip }, async (t) => {
  const { browser } = await openProof(t);
  const r = await browser.evaluate(`window.__seam(${JSON.stringify(SEAM_AREA)})`);
  const show = (s) => `${s.pair.join('|')} mean ${s.mean.toFixed(3)} max ${s.max} (control ${s.control.toFixed(3)})`;
  console.log(`  seam: sheets ${r.sheets.join(',')}, overlap ${r.overlapPx}px; E-W ${show(r.horizontal)}; N-S ${show(r.vertical)}`);

  assert.equal(r.sheets.length, 4, 'a 2x2 plan gives both a horizontal and a vertical seam');
  assert.equal(r.overlapPx, 150, '0.5 in of overlap at 300 dpi');
  for (const s of [r.horizontal, r.vertical]) {
    assert.ok(s.pixels > 100000, `the strip is a real sample, got ${s.pixels} px`);
    assert.ok(s.mean <= SEAM_MEAN, `${s.pair.join('|')} overlap differs by ${s.mean} grey levels on average`);
    assert.ok(s.max <= SEAM_MAX, `${s.pair.join('|')} overlap differs by ${s.max} grey levels at worst`);
    // Without this the assertions above would pass on a flat image and prove nothing:
    // the same strips 8 px out of register must be far louder than in register.
    assert.ok(s.control > 8 * Math.max(s.mean, 0.25), `a ${r.shiftPx} px misregistration is indistinguishable (${s.control} vs ${s.mean}); the fixture has no detail to align`);
  }
});
