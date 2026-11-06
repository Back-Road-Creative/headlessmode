// PDF assembly for Quiet Corners Field Maps. Layout functions are pure and use
// page points from the TOP-left (the sheet-plan convention); only the drawing
// step flips to PDF's bottom-left origin. pdf-lib is injected (`window.PDFLib`
// in the browser, a vm-loaded namespace under Node), never imported.
import { POINTS_PER_INCH, METERS_PER_INCH } from './sheet-plan.js';
import { dashPt, swatchSpec, SYMBOL_BY_KEY } from './legend.js';
import { pagePxForSheet } from './overlay-paths.js';

export const TYPE = { minPt: 7, bodyPt: 9, idPt: 20, titlePt: 12 };
// Dash arrays come from legend.js's one physical table; 'solid' and unpatterned
// lines pass undefined so pdf-lib strokes them continuous.
const dashOf = (pattern) => (pattern && pattern !== 'solid' ? dashPt(pattern) : undefined);
const TICK = 3;
const CROSS = 4;
// 3% black. Light enough that contours and road lines read straight through the
// wash, dark enough that the lapped strip is unmistakable on the printed sheet.
const TINT = 0.03;
const WINANSI = /[^\x20-\x7e\xa0-\xff]/g;
const frameOf = (plan) => ({ x: plan.frame.xPt, y: plan.frame.yPt, w: plan.frame.widthIn * POINTS_PER_INCH, h: plan.frame.heightIn * POINTS_PER_INCH });
const ptPerM = (plan) => POINTS_PER_INCH / (plan.input.scale * METERS_PER_INCH);
const txt = (x, y, size, text, role, extra) => ({ x, y, size, text, role, ...extra });
const seg = (x1, y1, x2, y2, width, role) => ({ x1, y1, x2, y2, width, role });
// '#rrggbb' -> pdf-lib rgb(). The key strokes the map's own colours, not black.
const hexRgb = (rgb, hex) => rgb(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);
// pdf-lib draws Helvetica in WinAnsi (see WINANSI), which has no triangle glyphs:
// a '\u25c0' would reach paper as '?'. ASCII chevrons always encode.
const ARROW = { n: (id) => `^ ${id}`, s: (id) => `v ${id}`, e: (id) => `${id} >`, w: (id) => `< ${id}` };
const EDGES = ['n', 's', 'e', 'w'];

/** The overlap strip on each edge that has a neighbour, in frame points. */
function bandsOf(plan, sheet) {
  const f = frameOf(plan), o = plan.input.overlapIn * POINTS_PER_INCH;
  const at = { n: { x: f.x, y: f.y, w: f.w, h: o }, s: { x: f.x, y: f.y + f.h - o, w: f.w, h: o },
    e: { x: f.x + f.w - o, y: f.y, w: o, h: f.h }, w: { x: f.x, y: f.y, w: o, h: f.h } };
  return EDGES.filter((e) => sheet.neighbors[e]).map((edge) => ({ edge, ...at[edge] }));
}

/** Top-origin y in points to PDF y. */
export function toPdfY(plan, yFromTopPt) { return plan.page.heightPt - yFromTopPt; }

/** 1 km bar at 1:24,000, 2 km at 1:48,000: the same length on paper. */
export function scaleBar(plan) {
  const meters = plan.input.scale > 24000 ? 2000 : 1000;
  return { lengthPt: meters * ptPerM(plan), meters, label: `${meters / 1000} km` };
}

/** UTM grid lines at whole multiples of spacingM strictly inside the sheet, in frame points. */
export function gridLines(plan, sheet, { spacingM = 1000 } = {}) {
  const f = frameOf(plan), k = ptPerM(plan), e = sheet.extent;
  const multiples = (lo, hi) => { const out = []; for (let v = Math.floor(lo / spacingM + 1) * spacingM; v < hi; v += spacingM) out.push(v); return out; };
  return {
    eastings: multiples(e.minX, e.maxX).map((value) => ({ x: f.x + (value - e.minX) * k, value })),
    northings: multiples(e.minY, e.maxY).map((value) => ({ y: f.y + (e.maxY - value) * k, value })),
  };
}

/** Tick pairs marking the overlap boundary on every edge that has a neighbor. */
export function overlapTicks(plan, sheet) {
  const f = frameOf(plan), o = plan.input.overlapIn * POINTS_PER_INCH, out = [];
  const at = { n: f.y + o, s: f.y + f.h - o, e: f.x + f.w - o, w: f.x + o };
  for (const edge of ['n', 's', 'e', 'w']) {
    if (!sheet.neighbors[edge]) continue;
    const p = at[edge];
    if (edge === 'n' || edge === 's') out.push({ edge, x1: f.x - TICK, y1: p, x2: f.x + TICK, y2: p }, { edge, x1: f.x + f.w - TICK, y1: p, x2: f.x + f.w + TICK, y2: p });
    else out.push({ edge, x1: p, y1: f.y - TICK, x2: p, y2: f.y + TICK }, { edge, x1: p, y1: f.y + f.h - TICK, x2: p, y2: f.y + f.h + TICK });
  }
  return out;
}

/** A cross at each corner of every overlap band. Two sheets sharing a seam cover
 *  the same ground with that band, so their crosses land on the same four ground
 *  points: aligning two crosses is mechanical, not a judgement about terrain. */
export function registrationCrosses(plan, sheet) {
  return bandsOf(plan, sheet).flatMap((b) => [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]]
    .map(([x, y]) => ({ edge: b.edge, x, y })));
}

/** A TINT-opacity grey wash over each overlap strip, so which strip laps is not a question. */
export function overlapBands(plan, sheet) {
  return bandsOf(plan, sheet).map((b) => ({ ...b, opacity: TINT }));
}

/** Every furniture item of one map sheet with top-origin page-point coordinates. */
export function layoutSheet(plan, sheet, meta) {
  const f = frameOf(plan), fb = f.y + f.h, B = TYPE.bodyPt, M = TYPE.minPt, bar = scaleBar(plan), c = meta.convergenceDeg, nb = sheet.neighbors;
  const barX = f.x + 44;
  const texts = [
    txt(f.x, f.y - 10, TYPE.titlePt, meta.title, 'title', { bold: true }),
    txt(f.x + f.w, f.y - 6, TYPE.idPt, sheet.id, 'id', { bold: true, align: 'right' }),
    txt(f.x, fb + B, B, `1:${String(plan.input.scale).replace(/\B(?=(\d{3})+$)/g, ',')}`, 'scale-rf'),
    txt(barX + bar.lengthPt + 4, fb + B, B, bar.label, 'scale-label'),
    txt(f.x + f.w, fb + B, B, `Grid north up; true north ${Math.abs(c).toFixed(1)} deg ${c < 0 ? 'E' : 'W'} of grid north`, 'north', { align: 'right' }),
    txt(f.x, fb + 2 * B + 2, B, `${meta.datum} / UTM zone ${meta.zone}${meta.hemisphere}`, 'datum'),
    txt(f.x + f.w, fb + 2 * B + 2, B, meta.assembledAtIso, 'assembled', { align: 'right' }),
    txt(f.x, fb + 3 * B + 3, M, meta.sourceLine, 'sources'),
    txt(f.x, fb + 4 * B + 3, M, 'Print at Actual size (100%), never "fit to page"; check the scale bar with a ruler.', 'print-note'),
  ];
  // Edge labels sit INSIDE the overlap band, centred across its width, on purpose:
  // visible while you match two sheets, buried under the lap once they are taped.
  const o = plan.input.overlapIn * POINTS_PER_INCH;
  const mid = { n: [f.x + f.w / 2, f.y + o / 2], s: [f.x + f.w / 2, fb - o / 2],
    e: [f.x + f.w - o / 2, f.y + f.h / 2], w: [f.x + o / 2, f.y + f.h / 2] };
  for (const edge of EDGES) {
    if (!nb[edge]) continue;
    const [x, y] = mid[edge];
    texts.push(txt(x, y, B, ARROW[edge](nb[edge]), `neighbor-${edge}`, { align: 'center', ...(edge === 'n' || edge === 's' ? {} : { rotate: 90 }) }));
  }
  const lines = [
    seg(barX, fb + 5, barX + bar.lengthPt, fb + 5, 1.5, 'scale-bar'),
    seg(barX, fb + 2, barX, fb + 8, 1, 'scale-bar'), seg(barX + bar.lengthPt, fb + 2, barX + bar.lengthPt, fb + 8, 1, 'scale-bar'),
    ...overlapTicks(plan, sheet).map((t) => ({ ...t, width: 0.8, role: 'tick' })),
    ...registrationCrosses(plan, sheet).flatMap((c) => [seg(c.x - CROSS, c.y, c.x + CROSS, c.y, 0.5, 'cross'), seg(c.x, c.y - CROSS, c.x, c.y + CROSS, 0.5, 'cross')]),
  ];
  if (meta.gridEnabled) {
    const g = gridLines(plan, sheet);
    for (const e of g.eastings) { lines.push(seg(e.x, f.y, e.x, fb, 0.4, 'grid')); texts.push(txt(e.x, f.y - 2, M, String(e.value / 1000), 'grid-label', { align: 'center' })); }
    for (const n of g.northings) { lines.push(seg(f.x, n.y, f.x + f.w, n.y, 0.4, 'grid')); texts.push(txt(f.x - 2, n.y + 2, M, String(n.value / 1000), 'grid-label', { align: 'right' })); }
  }
  return { texts, lines, image: f, tints: overlapBands(plan, sheet) };
}

const wrap = (text, maxChars) => text.split(' ').reduce((ls, w) => {
  if (ls.length && (ls[ls.length - 1] + ' ' + w).length <= maxChars) ls[ls.length - 1] += ' ' + w; else ls.push(w);
  return ls;
}, []);

/** Index page: the covered area fitted to the frame, one labelled rect per sheet. */
// Taping a stack of look-alike sheets in an arbitrary order lets small seam errors
// accumulate into a corner. Rows first, then join the rows, keeps the error in one axis
// at a time. This belongs on the index page because that is what is on the table.
export function assemblyLines(plan, maxChars) {
  if (plan.count < 2) return [];  // nothing to assemble
  // A quad set drops grid positions, so a row can have a gap in the middle: naming
  // an exact first-row ID list ("A1, A2, A3") would be wrong the moment one of those
  // three is missing. Say so instead, and lean on the per-edge arrows (already on
  // every kept sheet) to carry what an exhaustive list used to.
  if (plan.count < plan.gridCount) {
    return wrap('Not every grid position prints; this index shows the sheets that do. Tape each run of '
      + 'adjacent sheets row by row, then join the rows. An edge with no arrow has no neighbour.', maxChars);
  }
  // The first row that actually has a kept sheet — trivially row 0 whenever nothing was
  // dropped (the branch above), but stated this way rather than hard-coding s.row === 0.
  const firstKeptRow = Math.min(...plan.sheets.map((s) => s.row));
  const firstRow = plan.sheets.filter((s) => s.row === firstKeptRow).map((s) => s.id).join(', ');
  const sentence = `Assembly: tape each row first, left to right (${firstRow}), then join the rows top to bottom. `
    + 'Lay the grey overlap band over its neighbour, line the corner crosses up, and check the arrow '
    + 'on each edge names the sheet next to it.';
  return wrap(sentence, maxChars);
}

export function layoutIndex(plan, meta) {
  const f = frameOf(plan), c = plan.covered, cw = c.maxX - c.minX, ch = c.maxY - c.minY;
  const B = TYPE.bodyPt;
  const lines = assemblyLines(plan, Math.floor(f.w / (B * 0.5)));
  // Reserve the band before fitting the grid, so the two can never overlap.
  const band = lines.length ? lines.length * B * 1.4 + B : 0, gh = f.h - band;
  const k = Math.min(f.w / cw, gh / ch), ox = f.x + (f.w - cw * k) / 2, oy = f.y + (gh - ch * k) / 2;
  const rects = plan.sheets.map((s) => ({ id: s.id, x: ox + (s.extent.minX - c.minX) * k, y: oy + (c.maxY - s.extent.maxY) * k, w: (s.extent.maxX - s.extent.minX) * k, h: (s.extent.maxY - s.extent.minY) * k }));
  const texts = [txt(f.x, f.y - 10, TYPE.titlePt, `${meta.title}: sheet index`, 'title', { bold: true }),
    ...rects.map((r) => txt(r.x + r.w / 2, r.y + r.h / 2 + TYPE.idPt / 3, TYPE.idPt, r.id, 'id', { align: 'center', bold: true })),
    ...lines.map((line, i) => txt(f.x, f.y + gh + B * (1.4 * i + 1), B, line, 'assembly'))];
  return { rects, texts };
}

/** Legend pages at bodyPt: a new page whenever the frame is full, never a smaller size. */
export function layoutLegend(plan, legend) {
  const f = frameOf(plan), B = TYPE.bodyPt, row = 2 * B, pages = [];
  let y = Infinity, items;
  const place = (fill) => {
    if (y > f.y + f.h) { items = [txt(f.x, f.y - 10, TYPE.titlePt, 'Legend', 'title', { bold: true })]; pages.push({ items }); y = f.y + row; }
    fill(y); y += row;
  };
  for (const e of legend.entries) place((yy) => items.push({ x: f.x, y: yy, w: 36, size: B, symbol: e, role: 'swatch' }, txt(f.x + 44, yy, B, e.label, 'entry')));
  // Every notice the drawn symbols oblige, each its own paragraph. One string
  // could only ever carry one of them, so the boundary notice had nowhere to go.
  const cols = Math.floor(f.w / (B * 0.5));
  for (const notice of legend.notices || []) {
    place(() => {});   // a blank row between paragraphs
    for (const line of wrap(notice, cols)) place((yy) => items.push(txt(f.x, yy, B, line, 'disclaimer')));
  }
  // The open dates the routes on this sheet actually stated. The key promised
  // these for months and no module ever wrote one, so a reader who saw the promise
  // searched the paper for a section that was not there. Here it is.
  if (legend.seasonalRoutes && legend.seasonalRoutes.length) {
    place(() => {});
    place((yy) => items.push(txt(f.x, yy, B, 'Seasonal routes', 'seasonal-title', { bold: true })));
    for (const route of legend.seasonalRoutes) {
      for (const line of wrap(route, cols)) place((yy) => items.push(txt(f.x, yy, B, line, 'seasonal')));
    }
  }
  // Credit for every source the build consumed. It cannot go in the sheet footer,
  // which is one unwrapped 7 pt line; the key is the page with room for it.
  if (legend.attribution && legend.attribution.length) {
    place(() => {});
    place((yy) => items.push(txt(f.x, yy, B, 'Sources', 'attribution-title', { bold: true })));
    for (const credit of legend.attribution) {
      for (const line of wrap(credit, cols)) place((yy) => items.push(txt(f.x, yy, B, line, 'attribution')));
    }
  }
  return pages;
}

// A label sits ON the map, over contours and tile imagery, so it needs a halo to
// stay readable. pdf-lib has no text stroke: draw white copies around the glyph
// first, then the black one. 8 offsets, not 4 -- with 4 the diagonals of a
// contour line still cut the stem.
const HALO_PT = 0.5;
const HALO_OFFSETS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

/** Vector labels (page px on the sheet raster) -> texts in page points inside the image.
 *  The raster is drawn into `image`, so the same ratio maps a label into it. */
export function layoutLabels(image, pixel, labels = []) {
  const sx = image.w / pixel.width, sy = image.h / pixel.height;
  return labels.map((l) => txt(image.x + l.x * sx, image.y + l.y * sy, TYPE.minPt, l.text, 'label',
    // page px grow downward and PDF rotation is counter-clockwise, so the sign flips.
    { align: 'center', rotate: -l.angleDeg, halo: true }));
}

/** A marker's outline as page-point segments, centred on (x, y). Returned as
 *  geometry rather than drawn, so it is testable without a PDF and so the screen
 *  and the sheet can draw the same shape from one definition. */
export function markerPath(marker, x, y, sizePt) {
  const h = sizePt / 2;
  if (marker === 'triangle') return [[x, y - h], [x + h, y + h], [x - h, y + h], [x, y - h]];
  if (marker === 'square') return [[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h], [x - h, y - h]];
  // A shelter is a house: the three-walled lean-to every trail map draws.
  if (marker === 'house') return [[x - h, y + h], [x - h, y], [x, y - h], [x + h, y], [x + h, y + h], [x - h, y + h]];
  // The terrain-name icon family (print-names.js's NAME_ICON_BY_KIND): a
  // consistent, once-defined shape per kind, each with its legend label as the
  // text alternative for a reader who cannot tell two thin marks apart.
  if (marker === 'chevron') return [[x - h, y + h], [x, y - h], [x + h, y + h]];
  if (marker === 'zigzag') return [[x - h, y + h], [x - h / 2, y - h], [x + h / 2, y + h], [x + h, y - h]];
  if (marker === 'droplet') return [[x, y - h], [x + h * 0.6, y + h * 0.2], [x, y + h], [x - h * 0.6, y + h * 0.2], [x, y - h]];
  if (marker === 'diamond') return [[x, y - h], [x + h, y], [x, y + h], [x - h, y], [x, y - h]];
  if (marker === 'wave') return [[x - h, y], [x - h / 2, y - h / 2], [x, y], [x + h / 2, y + h / 2], [x + h, y]];
  return null;   // 'dot' is a filled circle, drawn directly
}

/** Sites (lon/lat) -> marks in page points inside the image rect, with a label. */
export function layoutSites(image, pixel, sites = [], toPx = null) {
  if (!toPx) return [];
  const sx = image.w / pixel.width, sy = image.h / pixel.height;
  const out = [];
  for (const site of sites) {
    const p = toPx(site.lonLat[0], site.lonLat[1]);
    if (!(p.x >= 0 && p.x <= pixel.width && p.y >= 0 && p.y <= pixel.height)) continue;
    const symbol = SYMBOL_BY_KEY[site.symbolKey];
    if (!symbol) continue;
    const spec = swatchSpec(symbol);
    const x = image.x + p.x * sx, y = image.y + p.y * sy;
    out.push({ x, y, marker: spec.marker, sizePt: spec.sizePt, color: spec.color, name: site.name, role: 'site' });
  }
  return out;
}

/** Name markers (print-names.js's placeNameLabels output, already in sheet-pixel
 *  space) -> marks in page points inside the image rect, same sx/sy transform as
 *  layoutLabels/layoutSites. Kept separate from layoutSites: a name mark already
 *  carries its own shape and colour (there is no legend.js SYMBOL_BY_KEY entry to
 *  look up, since that table is out of this unit's Owns list), so nothing here
 *  needs a `toPx` or a symbol lookup. */
export function layoutNameMarks(image, pixel, marks = []) {
  const sx = image.w / pixel.width, sy = image.h / pixel.height;
  return marks.map((m) => ({ x: image.x + m.x * sx, y: image.y + m.y * sy, marker: m.marker, sizePt: m.sizePx * sx, color: m.color, name: m.name || null }));
}

const M_PER_MILE_ = 1609.344;
// Exported: QUX-06's on-screen elevation card converts the same metres-to-feet
// way this sheet's climb column does, rather than redefining the constant.
export const M_PER_FOOT = 0.3048;

/** The trip page: every named route on the set with its length, climb and sheets.
 *  Pure layout — one page's worth of rows, paginated like the legend. */
export function layoutTrip(plan, trips = [], meta = {}) {
  const f = frameOf(plan), B = TYPE.bodyPt, M = TYPE.minPt;
  const pages = [];
  let items = [], y = f.y + B * 2;
  const push = () => { if (items.length) pages.push({ items }); items = []; y = f.y + B * 2; };
  items.push(txt(f.x, f.y, TYPE.titlePt, `${meta.title || 'Field maps'}: routes on this set`, 'title', { bold: true }));
  if (!trips.length) {
    items.push(txt(f.x, y, B, 'No named routes were drawn on these sheets.', 'trip-empty'));
    push();
    return pages;
  }
  const cols = [f.x, f.x + f.w * 0.46, f.x + f.w * 0.60, f.x + f.w * 0.74, f.x + f.w * 0.88];
  const header = () => {
    for (const [i, label] of ['Route', 'Miles', 'Climb ft', 'Uses', 'Sheets'].entries()) {
      items.push(txt(cols[i], y, M, label, 'trip-head', { bold: true }));
    }
    y += B * 1.4;
  };
  header();
  for (const t of trips) {
    if (y > f.y + f.h - B) { push(); header(); }
    const miles = t.lengthM ? (t.lengthM / M_PER_MILE_).toFixed(1) : '—';
    const climb = Number.isFinite(t.gainM) && t.sampled ? String(Math.round(t.gainM / M_PER_FOOT)) : '—';
    const cells = [t.name || t.id || 'unnamed', miles, climb, t.useCode || '—', (t.sheets || []).join(' ')];
    for (const [i, v] of cells.entries()) items.push(txt(cols[i], y, M, String(v), 'trip-cell'));
    y += B * 1.15;
  }
  if (y < f.y + f.h - B * 3) {
    y += B;
    items.push(txt(f.x, y, M, 'Climb is summed from elevation sampled along the drawn line, so a short steep', 'trip-note'));
    items.push(txt(f.x, y + B, M, 'pitch between samples can be missed. Treat it as a planning figure.', 'trip-note'));
  }
  push();
  return pages;
}

/** One page's drawing pass, shared by a built set and the stand-alone key sheet
 *  (key-sheet.js): swatch, marker and text ink is defined here once, so a key
 *  printed on its own is the key printed at the back of a set, stroke for stroke. */
export function pageDrawer({ PDFLib, plan, fonts }) {
  const { rgb, degrees } = PDFLib, black = rgb(0, 0, 0), white = rgb(1, 1, 1);
  return (page, { texts = [], lines = [], rects = [], swatches = [], tints = [], sites = [] }) => {
    for (const t of tints) page.drawRectangle({ x: t.x, y: toPdfY(plan, t.y + t.h), width: t.w, height: t.h, color: black, opacity: t.opacity });
    for (const r of rects) page.drawRectangle({ x: r.x, y: toPdfY(plan, r.y + r.h), width: r.w, height: r.h, borderColor: black, borderWidth: 0.8 });
    for (const l of lines) page.drawLine({ start: { x: l.x1, y: toPdfY(plan, l.y1) }, end: { x: l.x2, y: toPdfY(plan, l.y2) }, thickness: l.width, color: black, dashArray: dashOf(l.pattern) });
    for (const s of swatches) {
      const y = toPdfY(plan, s.y - 3), spec = swatchSpec(s.symbol);
      if (spec.kind === 'raster') { page.drawRectangle({ x: s.x, y: y - 4, width: s.w, height: 8, color: rgb(0.85, 0.85, 0.85) }); continue; }
      if (spec.kind === 'tick') {
        // The overlap entry is a band with ticks, not a line: it used to fall through
        // to the line branch and print as a plain rule with an undefined width.
        page.drawRectangle({ x: s.x, y: y - 4, width: s.w, height: 8, color: black, opacity: TINT });
        for (const dx of [0, s.w / 2, s.w]) page.drawLine({ start: { x: s.x + dx, y: y - 4 }, end: { x: s.x + dx, y: y + 4 }, thickness: 0.8, color: black });
        continue;
      }
      page.drawLine({ start: { x: s.x, y }, end: { x: s.x + s.w, y }, thickness: spec.widthPt, color: hexRgb(rgb, spec.color), dashArray: dashOf(spec.pattern) });
    }
    for (const s of sites) {
      const col = hexRgb(rgb, s.color), yy = toPdfY(plan, s.y);
      const path = markerPath(s.marker, s.x, yy, s.sizePt);
      if (path) {
        // A halo first: a mark on contours needs the same protection a label does.
        for (const [w, c] of [[s.sizePt * 0.34, white], [s.sizePt * 0.16, col]]) {
          for (let i = 1; i < path.length; i++) {
            page.drawLine({ start: { x: path[i - 1][0], y: path[i - 1][1] }, end: { x: path[i][0], y: path[i][1] }, thickness: w, color: c });
          }
        }
      } else {
        page.drawCircle({ x: s.x, y: yy, size: s.sizePt / 2, borderColor: white, borderWidth: s.sizePt * 0.3 });
        page.drawCircle({ x: s.x, y: yy, size: s.sizePt / 2.6, color: col });
      }
    }
    for (const t of texts) {
      const font = t.bold ? fonts.bold : fonts.regular, text = t.text.replace(WINANSI, '?'), rot = t.rotate || 0;
      const w = font.widthOfTextAtSize(text, t.size), d = t.align === 'right' ? -w : t.align === 'center' ? -w / 2 : 0;
      const x = t.x + (rot ? 0 : d), y = toPdfY(plan, t.y) + (rot ? d : 0);
      const put = (dx, dy, color) => page.drawText(text, { x: x + dx, y: y + dy, size: t.size, font, color, rotate: degrees(rot) });
      if (t.halo) for (const [hx, hy] of HALO_OFFSETS) put(hx * HALO_PT, hy * HALO_PT, white);
      put(0, 0, black);
    }
  };
}

/** Sheets, index and legend pages plus the manifest attachment; returns the PDF bytes. */
export async function createPdf({ PDFLib, plan, sheets, meta, legend, manifest, trips = [], aerials = [], companions = [] }) {
  const { PDFDocument, StandardFonts } = PDFLib;
  const doc = await PDFDocument.create({ updateMetadata: false });
  const fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
  const size = [plan.page.widthPt, plan.page.heightPt], draw = pageDrawer({ PDFLib, plan, fonts });
  for (const s of sheets) {
    const page = doc.addPage(size), l = layoutSheet(plan, plan.sheets.find((p) => p.id === s.id), { ...meta, convergenceDeg: s.convergenceDeg });
    const img = await doc.embedJpg(s.jpeg);
    page.drawImage(img, { x: l.image.x, y: toPdfY(plan, l.image.y + l.image.h), width: l.image.w, height: l.image.h });
    const planned = plan.sheets.find((p) => p.id === s.id);
    // Site markers are placed here rather than in the worker: they are page
    // furniture at a fixed physical size, like a label, not ink that scales with
    // the map image. layoutSites clips to the image rect itself.
    draw(page, {
      ...l,
      rects: [l.image],
      texts: [...l.texts, ...layoutLabels(l.image, planned.pixel, s.labels)],
      sites: [
        ...layoutSites(l.image, planned.pixel, s.sites || [], pagePxForSheet(planned, meta.zone, meta.hemisphere)),
        ...layoutNameMarks(l.image, planned.pixel, s.nameMarks || []),
      ],
    });
  }
  draw(doc.addPage(size), layoutIndex(plan, meta));
  for (const p of layoutLegend(plan, legend)) draw(doc.addPage(size), { texts: p.items.filter((i) => i.role !== 'swatch'), swatches: p.items.filter((i) => i.role === 'swatch') });
  // Companions, after the map sheets: same extent, same frame, same scale, so a
  // pair can be laid side by side and read as one. Never an overlay -- an aerial
  // and a topo raster fight until the contours lose, and a hillshade under
  // contours is two greys describing the same ground.
  //
  // ONE loop for every companion kind. It embeds by the DECLARED format rather
  // than assuming JPEG: relief is fetched as PNG, because JPEG ringing on a ridge
  // line reads as a terrace that is not there, and embedJpg on PNG bytes throws.
  for (const a of [...aerials, ...companions]) {
    const planned = plan.sheets.find((p) => p.id === a.id);
    if (!planned) continue;
    const page = doc.addPage(size), l = layoutSheet(plan, planned, { ...meta, gridEnabled: false });
    const img = a.format === 'png' ? await doc.embedPng(a.bytes) : await doc.embedJpg(a.bytes);
    page.drawImage(img, { x: l.image.x, y: toPdfY(plan, l.image.y + l.image.h), width: l.image.w, height: l.image.h });
    draw(page, { texts: l.texts.filter((t) => t.role !== 'grid-label'), rects: [l.image] });
  }
  // Only when there is something to say. A set with no named routes gets no trip
  // page rather than a page announcing its own emptiness.
  if (trips.length) for (const p of layoutTrip(plan, trips, meta)) draw(doc.addPage(size), { texts: p.items });
  await doc.attach(new TextEncoder().encode(JSON.stringify(manifest)), 'field-maps-manifest.json', { mimeType: 'application/json', description: 'Field Maps build manifest' });
  const when = new Date(meta.assembledAtIso);
  doc.setTitle(meta.title); doc.setSubject(`${meta.title} field maps`); doc.setProducer(`Quiet Corners Field Maps: ${meta.title}`); doc.setCreator('Quiet Corners Field Maps');
  doc.setCreationDate(when); doc.setModificationDate(when);
  return doc.save({ useObjectStreams: false });
}

/** ASCII-safe file stem, at most 60 characters, 'field-maps' when nothing survives. */
export function sanitizeFilename(title) {
  return String(title || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+/, '').slice(0, 60).replace(/-+$/, '') || 'field-maps';
}
