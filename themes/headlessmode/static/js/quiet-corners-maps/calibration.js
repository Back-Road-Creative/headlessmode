// The printer calibration sheet (plan U-Q5): ONE Letter page, printed once per
// printer, that settles the two things no digital test can — the printer's real
// scale error, and its true unprintable margin. Everything else about the layout
// is proved in CI without paper, so this sheet carries only what paper answers.
//
// Pure layout plus one small drawing pass; pdf-lib is injected (window.PDFLib in
// the browser, a vm-loaded namespace under Node), never imported. Coordinates are
// page points from the TOP-left, the sheet-plan convention, flipped once at draw
// time. Labels are ASCII by construction: pdf-lib draws Helvetica in WinAnsi and
// calibration.test.mjs fails on any character outside \x20-\x7e.
import { POINTS_PER_INCH, PAPER, FURNITURE } from './sheet-plan.js';

export const RULER_CM = 10;
// Outermost-safe first. A printer that clips 0.15 in but not 0.17 in has its
// answer in which of these rectangles came out whole.
export const PROBE_INSETS_IN = [0.25, 0.2, 0.17, 0.15];
export const FRAME_INSET_IN = 0.25;

const TYPE = { label: 7, body: 9, title: 12 };
const CORNER_PT = 12;
// Round to 1e-4 pt (about 35 nm on paper): keeps the PDF's numbers readable and
// makes 0.2 in land on 14.4, not 14.400000000000002.
const pt = (inches) => Math.round(inches * POINTS_PER_INCH * 1e4) / 1e4;
const cmPt = (n) => (n * 10 / 25.4) * POINTS_PER_INCH;
const seg = (x1, y1, x2, y2, width, role) => ({ x1, y1, x2, y2, width, role });
const txt = (x, y, size, text, role, extra) => ({ x, y, size, text, role, ...extra });

const INSTRUCTIONS = [
  '1. Print at Actual size (100 percent). Turn "Fit to page" and "Shrink oversized pages" OFF.',
  '2. Lay a ruler along each 10 cm bar. 9.9 cm instead of 10.0 means this printer prints 1 percent small.',
  '3. Look at the nested rectangles at the paper edge. The smallest labelled inset that printed complete',
  '   on all four sides is the safe insetIn for this printer; the sheets use 0.25 in today.',
  '4. The corner marks are a real sheet frame corner. A missing mark means the frame is being clipped.',
];

/** The map frame a real sheet prints: inset on four sides, header and footer taken off. */
export function frameRect(paper = 'letter') {
  const p = PAPER[paper], i = FRAME_INSET_IN;
  return { x: pt(i), y: pt(i + FURNITURE.headerIn), w: pt(p.widthIn - 2 * i),
    h: pt(p.heightIn - 2 * i - FURNITURE.headerIn - FURNITURE.footerIn), role: 'frame' };
}

/** The margin probe: one rectangle per candidate inset, each labelled with its own inset. */
export function probeRects(paper = 'letter') {
  const p = PAPER[paper];
  return PROBE_INSETS_IN.map((insetIn) => ({
    insetIn, label: `${insetIn.toFixed(2)} in`, role: 'probe',
    x: pt(insetIn), y: pt(insetIn), w: pt(p.widthIn - 2 * insetIn), h: pt(p.heightIn - 2 * insetIn),
  }));
}

/** A RULER_CM bar along one axis, ticked and numbered at every centimetre. */
export function rulerBar({ x, y, axis, cm = RULER_CM }) {
  const lengthPt = cmPt(cm), horiz = axis === 'x', lines = [], texts = [];
  lines.push(horiz ? seg(x, y, x + lengthPt, y, 1.2, 'ruler') : seg(x, y, x, y + lengthPt, 1.2, 'ruler'));
  for (let i = 0; i <= cm; i += 1) {
    const d = cmPt(i), t = i % 5 === 0 ? 10 : 5;
    if (horiz) {
      lines.push(seg(x + d, y - t, x + d, y, 0.8, 'ruler-tick'));
      texts.push(txt(x + d, y - t - 3, TYPE.label, String(i), 'ruler-label', { align: 'center' }));
    } else {
      lines.push(seg(x - t, y + d, x, y + d, 0.8, 'ruler-tick'));
      texts.push(txt(x - t - 3, y + d + 2.5, TYPE.label, String(i), 'ruler-label', { align: 'right' }));
    }
  }
  texts.push(horiz ? txt(x + lengthPt + 6, y + 3, TYPE.body, `${cm} cm`, 'ruler-end')
    : txt(x, y + lengthPt + 12, TYPE.body, `${cm} cm`, 'ruler-end', { align: 'center' }));
  return { lengthPt, lines, texts };
}

/** The whole sheet: grid, probe, frame corners, both ruler bars, and the instructions. */
export function layoutCalibration(paper = 'letter') {
  const p = PAPER[paper], page = { widthPt: pt(p.widthIn), heightPt: pt(p.heightIn) };
  const rects = probeRects(paper), lines = [], texts = [];
  for (let x = POINTS_PER_INCH; x < page.widthPt; x += POINTS_PER_INCH) lines.push(seg(x, 0, x, page.heightPt, 0.25, 'grid'));
  for (let y = POINTS_PER_INCH; y < page.heightPt; y += POINTS_PER_INCH) lines.push(seg(0, y, page.widthPt, y, 0.25, 'grid'));
  const f = frameRect(paper);
  for (const [cx, sx] of [[f.x, 1], [f.x + f.w, -1]]) {
    for (const [cy, sy] of [[f.y, 1], [f.y + f.h, -1]]) {
      lines.push(seg(cx, cy, cx + sx * CORNER_PT, cy, 1, 'corner'), seg(cx, cy, cx, cy + sy * CORNER_PT, 1, 'corner'));
    }
  }
  // Each probe label sits just inside its own top edge, staggered across the page so
  // rectangles 2.2 pt apart do not stack their labels on top of one another.
  rects.forEach((r, i) => texts.push(txt(page.widthPt / 2 + (i - 1.5) * 72, r.y + 9, TYPE.label, r.label, 'probe-label', { align: 'center' })));
  const bars = [rulerBar({ x: 108, y: 300, axis: 'x' }), rulerBar({ x: 108, y: 396, axis: 'y' })];
  for (const b of bars) { lines.push(...b.lines); texts.push(...b.texts); }
  texts.push(txt(36, 40, TYPE.title, 'Field Maps printer calibration - Letter, portrait', 'title', { bold: true }));
  INSTRUCTIONS.forEach((line, i) => texts.push(txt(36, 60 + i * 13, TYPE.body, line, 'instruction')));
  return { page, rects, lines, texts };
}

/** The single-page calibration PDF, ready to print. */
export async function createCalibrationPdf({ PDFLib, paper = 'letter' }) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib, l = layoutCalibration(paper);
  const doc = await PDFDocument.create({ updateMetadata: false });
  const fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
  const black = rgb(0, 0, 0), page = doc.addPage([l.page.widthPt, l.page.heightPt]);
  // Snapped to 1e-9 pt: the raw flip of a 0.20 in probe lands on 14.399999999999977,
  // which reads as a different inset in the PDF and in any downstream check.
  const flip = (y) => Math.round((l.page.heightPt - y) * 1e9) / 1e9;
  for (const r of l.rects) page.drawRectangle({ x: r.x, y: flip(r.y + r.h), width: r.w, height: r.h, borderColor: black, borderWidth: 0.6 });
  for (const s of l.lines) page.drawLine({ start: { x: s.x1, y: flip(s.y1) }, end: { x: s.x2, y: flip(s.y2) }, thickness: s.width, color: black });
  for (const t of l.texts) {
    const font = t.bold ? fonts.bold : fonts.regular, w = font.widthOfTextAtSize(t.text, t.size);
    page.drawText(t.text, { x: t.x + (t.align === 'right' ? -w : t.align === 'center' ? -w / 2 : 0), y: flip(t.y), size: t.size, font, color: black });
  }
  doc.setTitle('Field Maps printer calibration');
  doc.setSubject('Print once per printer: scale error and unprintable margin');
  doc.setProducer('Quiet Corners Field Maps'); doc.setCreator('Quiet Corners Field Maps');
  return doc.save({ useObjectStreams: false });
}
