// U-Q5: the one sheet of paper. Every number a printed calibration sheet is read
// against is asserted here, in the PDF that actually gets printed, so the sheet
// itself never has to be reprinted to check the sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync, constants as Z } from 'node:zlib';
import { planSheets, PAPER, POINTS_PER_INCH } from '../../themes/headlessmode/static/js/quiet-corners-maps/sheet-plan.js';
import { projectBbox } from '../../themes/headlessmode/static/js/quiet-corners-maps/geometry.js';
import {
  PROBE_INSETS_IN, RULER_CM, frameRect, probeRects, rulerBar, layoutCalibration, createCalibrationPdf,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/calibration.js';
import { loadPdfLib } from './helpers/load-pdf-lib.mjs';

const PAGE = { w: PAPER.letter.widthIn * POINTS_PER_INCH, h: PAPER.letter.heightIn * POINTS_PER_INCH };
const CM_PT = (10 / 25.4) * POINTS_PER_INCH;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} !== ${b}`);
// Raw bytes plus every Flate stream inflated: pdf-lib compresses the content stream.
const pdfText = (bytes) => {
  const buf = Buffer.from(bytes); let out = buf.toString('latin1');
  for (const m of buf.toString('latin1').matchAll(/stream\r?\n/g)) {
    try { out += inflateSync(buf.subarray(m.index + m[0].length), { finishFlush: Z.Z_SYNC_FLUSH }).toString('latin1'); } catch { /* not Flate */ }
  }
  return out;
};

test('frameRect is the frame a real sheet prints, not a lookalike', () => {
  const extent = projectBbox({ minLon: -83.55, minLat: 35.0, maxLon: -83.45, maxLat: 35.03 }, 17, 'N');
  const plan = planSheets({ paper: 'letter', orientation: 'portrait', scale: 24000, overlapIn: 0.5, dpi: 300, extent, zone: 17, hemisphere: 'N', title: 'x' });
  const f = frameRect();
  near(f.x, plan.frame.xPt, 'frame x'); near(f.y, plan.frame.yPt, 'frame y');
  near(f.w, plan.frame.widthIn * POINTS_PER_INCH, 'frame w'); near(f.h, plan.frame.heightIn * POINTS_PER_INCH, 'frame h');
  assert.deepEqual([f.x, f.y, f.w, f.h], [18, 46.8, 576, 684]);
});

test('probeRects: four nested rectangles at 0.25, 0.20, 0.17 and 0.15 in from the paper edge', () => {
  assert.deepEqual(PROBE_INSETS_IN, [0.25, 0.2, 0.17, 0.15]);
  const r = probeRects();
  assert.deepEqual(r.map((p) => [p.insetIn, p.x, p.y, p.w, p.h]), [
    [0.25, 18, 18, 576, 756],
    [0.2, 14.4, 14.4, 583.2, 763.2],
    [0.17, 12.24, 12.24, 587.52, 767.52],
    [0.15, 10.8, 10.8, 590.4, 770.4],
  ]);
  // Each is strictly outside the one before it, so "which survived" has one answer.
  for (let i = 1; i < r.length; i += 1) assert.ok(r[i].x < r[i - 1].x && r[i].w > r[i - 1].w, `rect ${i} not outside ${i - 1}`);
  assert.deepEqual(r.map((p) => p.label), ['0.25 in', '0.20 in', '0.17 in', '0.15 in']);
});

test('rulerBar: 10 cm long, ticked and labelled at every centimetre, on both axes', () => {
  const x = rulerBar({ x: 100, y: 200, axis: 'x' }), y = rulerBar({ x: 100, y: 200, axis: 'y' });
  assert.equal(RULER_CM, 10);
  near(x.lengthPt, 283.46456692913387, 'x bar length'); near(y.lengthPt, x.lengthPt, 'y bar length');
  near(x.lines[0].x2 - x.lines[0].x1, x.lengthPt, 'x bar span'); near(y.lines[0].y2 - y.lines[0].y1, y.lengthPt, 'y bar span');
  for (const bar of [x, y]) {
    assert.equal(bar.lines.filter((l) => l.role === 'ruler-tick').length, 11);
    assert.deepEqual(bar.texts.filter((t) => t.role === 'ruler-label').map((t) => t.text), ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    assert.ok(bar.texts.some((t) => t.text === '10 cm'));
  }
  const ticks = x.lines.filter((l) => l.role === 'ruler-tick');
  near(ticks[1].x1 - ticks[0].x1, CM_PT, 'tick spacing');
});

test('layoutCalibration: Letter portrait, a 1 in grid, and corner marks on the real frame corners', () => {
  const l = layoutCalibration();
  assert.deepEqual([l.page.widthPt, l.page.heightPt], [612, 792]);
  const grid = l.lines.filter((g) => g.role === 'grid');
  assert.equal(grid.filter((g) => g.x1 === g.x2).length, 8);
  assert.equal(grid.filter((g) => g.y1 === g.y2).length, 10);
  for (const g of grid) assert.equal(Math.max(g.x1, g.y1) % POINTS_PER_INCH, 0);
  const f = frameRect(), corners = l.lines.filter((g) => g.role === 'corner');
  assert.equal(corners.length, 8);
  const seen = new Set(corners.map((c) => `${c.x1},${c.y1}`));
  assert.deepEqual([...seen].sort(), [`${f.x},${f.y}`, `${f.x},${f.y + f.h}`, `${f.x + f.w},${f.y}`, `${f.x + f.w},${f.y + f.h}`].sort());
  assert.equal(l.rects.filter((r) => r.role === 'probe').length, 4);
  assert.ok(l.lines.some((g) => g.role === 'ruler') && l.texts.some((t) => t.role === 'ruler-label'));
});

test('every drawn label is ASCII, and the instructions name the print settings', () => {
  const l = layoutCalibration();
  for (const t of l.texts) assert.match(t.text, /^[\x20-\x7e]*$/, `non-ASCII label ${JSON.stringify(t.text)} would print as '?'`);
  const prose = l.texts.filter((t) => t.role === 'instruction').map((t) => t.text).join(' ');
  for (const phrase of ['Actual size', '100', 'Fit', 'Shrink', 'OFF', '10 cm', 'insetIn']) {
    assert.ok(prose.includes(phrase), `instructions never mention ${phrase}: ${prose}`);
  }
});

const PDFLib = loadPdfLib();

test('createCalibrationPdf: one 612x792 page carrying the probes, the bars and no "?"', async () => {
  const bytes = await createCalibrationPdf({ PDFLib });
  const doc = await PDFLib.PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 1);
  assert.deepEqual(doc.getPage(0).getSize(), { width: 612, height: 792 });
  const text = pdfText(bytes);
  // Bottom-left origin: a probe inset i in on every side starts at (i*72, i*72).
  for (const p of probeRects()) {
    assert.ok(text.includes(`1 0 0 1 ${p.x} ${p.y} cm`), `probe ${p.label} not drawn at its inset`);
    assert.ok(text.includes(`${p.w} ${p.h} l`), `probe ${p.label} is not ${p.w} x ${p.h} pt`);
  }
  const bar = rulerBar({ x: 0, y: 0, axis: 'x' });
  const segs = [...text.matchAll(/([\d.]+) ([\d.]+) m\n\1 \2 m\n([\d.]+) ([\d.]+) l/g)].map((m) => m.slice(1).map(Number));
  assert.ok(segs.some((s) => s[1] === s[3] && Math.abs(s[2] - s[0] - bar.lengthPt) < 1e-6), 'no 10 cm bar across the horizontal axis');
  assert.ok(segs.some((s) => s[0] === s[2] && Math.abs(s[1] - s[3] - bar.lengthPt) < 1e-6), 'no 10 cm bar down the vertical axis');
  const drawn = [...text.matchAll(/<([0-9A-Fa-f]{2,200})>\s*Tj/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1'));
  for (const label of ['0.25 in', '0.20 in', '0.17 in', '0.15 in', '10 cm']) assert.ok(drawn.includes(label), `${label} missing from the PDF`);
  assert.ok(!drawn.some((t) => t.includes('?')), 'a label fell out of WinAnsi');
});
