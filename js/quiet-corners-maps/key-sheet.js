// The map key on its own sheet (plan U6): every symbol the chosen layers CAN draw,
// on paper, before any sheet of the set is spent. It mirrors the calibration sheet
// -- one button, one small PDF, injected pdf-lib -- and it invents nothing: the
// entries come from the same derivation the on-page key uses (legend-view.js),
// the layout from the same layoutLegend a built set puts at its back, and the ink
// from the same drawing pass (pdf.js pageDrawer). Three keys, one table.
//
// Pure until createKeySheetPdf: no DOM, no network.
import { PAPER, FURNITURE, POINTS_PER_INCH } from './sheet-plan.js';
import { deriveLegend } from './legend.js';
import { plannedLegendKeys } from './legend-view.js';
import { layoutLegend, pageDrawer } from './pdf.js';
import { FRAME_INSET_IN } from './calibration.js';

/** The plan-shaped object layoutLegend reads: a Letter portrait page and the frame a
 *  real sheet prints (sheet-plan.js's inset, header and footer), so the key sheet
 *  paginates exactly as the key at the back of a set does. */
export function keySheetPlan(paper = 'letter') {
  const p = PAPER[paper], i = FRAME_INSET_IN;
  return {
    page: { widthPt: p.widthIn * POINTS_PER_INCH, heightPt: p.heightIn * POINTS_PER_INCH },
    frame: { xPt: i * POINTS_PER_INCH, yPt: (i + FURNITURE.headerIn) * POINTS_PER_INCH,
      widthIn: p.widthIn - 2 * i, heightIn: p.heightIn - 2 * i - FURNITURE.headerIn - FURNITURE.footerIn },
  };
}

/** What the enabled layers could draw, as a legend -- the on-page key's own
 *  derivation, so the sheet and the screen cannot disagree. `states` is which
 *  states the drawn area covers, because a state land layer is only drawable there. */
export function keySheetLegend({ layers = {}, grid = 'none', states = null } = {}) {
  const planned = plannedLegendKeys({ layers, grid, states });
  return deriveLegend({ renderedSymbolKeys: planned, gridEnabled: !!grid && grid !== 'none', basemapRendered: true });
}

/** The key sheet's pages: layoutLegend over keySheetPlan, ready to draw. */
export function layoutKeySheet({ paper = 'letter', layers, grid, states } = {}) {
  return layoutLegend(keySheetPlan(paper), keySheetLegend({ layers, grid, states }));
}

/** The key-sheet PDF, ready to print. */
export async function createKeySheetPdf({ PDFLib, paper = 'letter', layers, grid, states }) {
  const { PDFDocument, StandardFonts } = PDFLib, plan = keySheetPlan(paper);
  const doc = await PDFDocument.create({ updateMetadata: false });
  const fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
  const draw = pageDrawer({ PDFLib, plan, fonts });
  for (const p of layoutKeySheet({ paper, layers, grid, states })) {
    draw(doc.addPage([plan.page.widthPt, plan.page.heightPt]), { texts: p.items.filter((i) => i.role !== 'swatch'), swatches: p.items.filter((i) => i.role === 'swatch') });
  }
  doc.setTitle('Field Maps map key');
  doc.setSubject('Every symbol the chosen layers can draw, and the notices they oblige');
  doc.setProducer('Quiet Corners Field Maps'); doc.setCreator('Quiet Corners Field Maps');
  return doc.save({ useObjectStreams: false });
}
