import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSheets } from '../../themes/headlessmode/static/js/quiet-corners-maps/sheet-plan.js';
import { projectBbox } from '../../themes/headlessmode/static/js/quiet-corners-maps/geometry.js';
import { SYMBOLS, deriveLegend } from '../../themes/headlessmode/static/js/quiet-corners-maps/legend.js';
import {
  TYPE, toPdfY, scaleBar, gridLines, overlapTicks, registrationCrosses, overlapBands,
  layoutSheet, layoutIndex, layoutLegend, layoutLabels, layoutNameMarks, markerPath, createPdf, sanitizeFilename,
  assemblyLines,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/pdf.js';
import { placeNameLabels, NAME_ICON_BY_KIND } from '../../themes/headlessmode/static/js/quiet-corners-maps/print-names.js';
import { loadPdfLib } from './helpers/load-pdf-lib.mjs';
import { inflateSync, constants as Z } from 'node:zlib';

// Standing Indian west half; lat 35.0..35.1 plans 3 rows, 35.09 keeps it to A1..B3.
const extent = projectBbox({ minLon: -83.55, minLat: 35.0, maxLon: -83.4, maxLat: 35.09 }, 17, 'N');
const recipe = { paper: 'letter', orientation: 'portrait', scale: 24000, overlapIn: 0.5, dpi: 300, extent, zone: 17, hemisphere: 'N', title: 'Standing Indian' };
const plan = planSheets(recipe);
const A1 = plan.sheets[0];
const frame = { x: plan.frame.xPt, y: plan.frame.yPt, w: plan.frame.widthIn * 72, h: plan.frame.heightIn * 72 };
const meta = { title: 'Standing Indian', zone: 17, hemisphere: 'N', datum: 'WGS84', assembledAtIso: '2026-09-05T12:00:00Z',
  convergenceDeg: -1.45, sourceLine: 'USGS Topo; USFS MVUM retrieved 2026-09-05', gridEnabled: true };
// Raw bytes plus every Flate stream inflated (the attachment stream is compressed).
const pdfText = (bytes) => {
  const buf = Buffer.from(bytes); let out = buf.toString('latin1');
  for (const m of buf.toString('latin1').matchAll(/stream\r?\n/g)) {
    try { out += inflateSync(buf.subarray(m.index + m[0].length), { finishFlush: Z.Z_SYNC_FLUSH }).toString('latin1'); } catch { /* not Flate */ }
  }
  return out;
};
const inside = (t) => t.x >= 0 && t.x <= plan.page.widthPt && t.y >= 0 && t.y <= plan.page.heightPt;
// Baseline 1x1 gray JPEG: one-code Huffman tables, a single zero DC block.
const JPEG = Uint8Array.from(Buffer.from('ffd8ffdb004300' + '01'.repeat(64) + 'ffc0000b080001000101011100'
  + 'ffc40026' + '0001' + '00'.repeat(15) + '00' + '1001' + '00'.repeat(15) + '00' + 'ffda0008010100003f003fffd9', 'hex'));

test('plan is 6 sheets and toPdfY flips from the top', () => {
  assert.deepEqual(plan.sheets.map((s) => s.id), ['A1', 'A2', 'A3', 'B1', 'B2', 'B3']);
  assert.equal(toPdfY(plan, 100), 692);
  assert.deepEqual(TYPE, { minPt: 7, bodyPt: 9, idPt: 20, titlePt: 12 });
});

test('scaleBar: 1 km at 1:24,000 and 2 km at 1:48,000 have the same length', () => {
  const a = scaleBar(plan), b = scaleBar(planSheets({ ...recipe, scale: 48000 }));
  assert.ok(Math.abs(a.lengthPt - 118.11) < 0.01); assert.equal(a.meters, 1000); assert.equal(a.label, '1 km');
  assert.ok(Math.abs(b.lengthPt - a.lengthPt) < 1e-9); assert.equal(b.meters, 2000); assert.equal(b.label, '2 km');
});

test('gridLines(A1): whole-km lines inside the frame', () => {
  const g = gridLines(plan, A1, { spacingM: 1000 });
  assert.ok(g.eastings.length >= 3 && g.northings.length >= 4);
  for (const e of g.eastings) { assert.equal(e.value % 1000, 0); assert.ok(e.x > frame.x && e.x < frame.x + frame.w); }
  for (const n of g.northings) { assert.equal(n.value % 1000, 0); assert.ok(n.y > frame.y && n.y < frame.y + frame.h); }
});

test('overlapTicks(A1): only on the s and e edges', () => {
  const edges = new Set(overlapTicks(plan, A1).map((t) => t.edge));
  assert.deepEqual([...edges].sort(), ['e', 's']);
});

test('layoutSheet(A1): furniture roles, texts on the page, image on the frame', () => {
  const l = layoutSheet(plan, A1, meta);
  const byRole = (r) => l.texts.filter((t) => t.role === r).map((t) => t.text);
  assert.deepEqual(byRole('id'), ['A1']);
  assert.deepEqual(byRole('neighbor-s'), ['v B1']); assert.deepEqual(byRole('neighbor-e'), ['A2 >']);
  assert.deepEqual(byRole('neighbor-n'), []); assert.deepEqual(byRole('neighbor-w'), []);
  assert.ok(byRole('print-note')[0].includes('Actual size'));
  assert.deepEqual(byRole('assembled'), [meta.assembledAtIso]);
  assert.equal(byRole('scale-rf')[0], '1:24,000');
  for (const r of ['title', 'scale-label', 'north', 'datum', 'sources', 'grid-label']) assert.ok(byRole(r).length, r);
  assert.ok(l.texts.every(inside)); assert.ok(l.texts.every((t) => t.size >= TYPE.minPt));
  assert.deepEqual(l.image, frame);
  assert.equal(layoutSheet(plan, A1, { ...meta, gridEnabled: false }).texts.filter((t) => t.role === 'grid-label').length, 0);
});

const OPPOSITE = { n: 's', s: 'n', e: 'w', w: 'e' };
const ARROWED = { n: (id) => `^ ${id}`, s: (id) => `v ${id}`, e: (id) => `${id} >`, w: (id) => `< ${id}` };
const OVER = plan.input.overlapIn * 72;
const key = (p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`;

// U-A1
test('layoutSheet(A1): edge labels sit inside the overlap band, not outside the frame', () => {
  const byRole = (r) => layoutSheet(plan, A1, meta).texts.filter((t) => t.role === r)[0];
  const s = byRole('neighbor-s'), e = byRole('neighbor-e');
  assert.ok(s.y > frame.y + frame.h - OVER && s.y < frame.y + frame.h, `s label at ${s.y}`);
  assert.ok(e.x > frame.x + frame.w - OVER && e.x < frame.x + frame.w, `e label at ${e.x}`);
  assert.equal(e.rotate, 90);
  assert.ok(s.x > frame.x && s.x < frame.x + frame.w);
});

// U-Q4
test('every sheet prints exactly its neighbours, nulls print nothing, and seams are reciprocal', () => {
  const byId = new Map(plan.sheets.map((s) => [s.id, s]));
  for (const sheet of plan.sheets) {
    const texts = layoutSheet(plan, sheet, meta).texts;
    for (const edge of ['n', 's', 'e', 'w']) {
      const printed = texts.filter((t) => t.role === `neighbor-${edge}`).map((t) => t.text);
      const nb = sheet.neighbors[edge];
      assert.deepEqual(printed, nb ? [ARROWED[edge](nb)] : [], `${sheet.id}.${edge}`);
      if (nb) assert.equal(byId.get(nb).neighbors[OPPOSITE[edge]], sheet.id, `${sheet.id}.${edge} reciprocity`);
    }
    // A label the font cannot encode prints as '?', which is not a label.
    for (const t of texts) assert.doesNotMatch(t.text, /[^\x20-\x7e\xa0-\xff]/);
  }
});

// U-A2
test('registrationCrosses: band corners, and both sheets of a seam mark the same ground', () => {
  const a1 = registrationCrosses(plan, A1), A2 = plan.sheets[1], B1 = plan.sheets[3];
  assert.equal(a1.length, 8);                       // A1 neighbours s and e: four corners each
  assert.deepEqual(registrationCrosses(plan, plan.sheets[4]).length, 12);  // B2: n, e, w
  const shifted = (list, edge, dx, dy) => list.filter((p) => p.edge === edge)
    .map((p) => key({ x: p.x - dx, y: p.y - dy })).sort();
  assert.deepEqual(shifted(a1, 'e', frame.w - OVER, 0), shifted(registrationCrosses(plan, A2), 'w', 0, 0));
  assert.deepEqual(shifted(a1, 's', 0, frame.h - OVER), shifted(registrationCrosses(plan, B1), 'n', 0, 0));
});

// U-A3
test('overlapBands(A1): a very light tint over the s and e strips only', () => {
  const b = overlapBands(plan, A1);
  assert.deepEqual(b.map((r) => r.edge).sort(), ['e', 's']);
  const e = b.find((r) => r.edge === 'e'), s = b.find((r) => r.edge === 's');
  assert.deepEqual([e.x, e.y, e.w, e.h], [frame.x + frame.w - OVER, frame.y, OVER, frame.h]);
  assert.deepEqual([s.x, s.y, s.w, s.h], [frame.x, frame.y + frame.h - OVER, frame.w, OVER]);
  assert.ok(b.every((r) => r.opacity > 0 && r.opacity <= 0.05), 'tint must stay light enough to read through');
  assert.deepEqual(layoutSheet(plan, A1, meta).tints, b);
  assert.equal(overlapBands(plan, plan.sheets[0]).length, 2);
});

test('layoutIndex: six labelled rects inside the frame', () => {
  const i = layoutIndex(plan, meta);
  assert.deepEqual(i.rects.map((r) => r.id), ['A1', 'A2', 'A3', 'B1', 'B2', 'B3']);
  for (const r of i.rects) {
    assert.ok(r.x >= frame.x - 1e-6 && r.x + r.w <= frame.x + frame.w + 1e-6 && r.y >= frame.y - 1e-6 && r.y + r.h <= frame.y + frame.h + 1e-6);
  }
  assert.ok(i.texts.some((t) => t.text === 'B3'));
});

test('layoutLegend: 60 entries need two pages and never shrink below minPt', () => {
  const entries = Array.from({ length: 60 }, (_, k) => ({ ...SYMBOLS.roadSeasonal, key: `k${k}`, label: `Entry ${k}` }));
  const pages = layoutLegend(plan, { entries, notices: ['x'], pages: 1 });
  assert.equal(pages.length, 2);
  for (const p of pages) for (const it of p.items) { assert.ok(it.size >= TYPE.minPt); assert.ok(inside(it)); }
  assert.equal(layoutLegend(plan, deriveLegend({ renderedSymbolKeys: ['usgs-topo'], gridEnabled: false, basemapRendered: true })).length, 1);
});

// The key promised the open dates for months and nothing ever wrote one to a
// sheet. This is the page they land on.
test('layoutLegend: the seasonal open dates are printed on the key', () => {
  const legend = { entries: [SYMBOLS.roadSeasonal], notices: [],
    seasonalRoutes: ['FR 71: Apr 1 - Dec 15', '2 more seasonal routes here: the source gave no dates for them.'],
    pages: 1 };
  const text = layoutLegend(plan, legend).flatMap((pg) => pg.items).filter((i) => i.text);
  const joined = text.map((i) => i.text).join('\n');
  assert.match(joined, /Seasonal routes/, 'the section names itself, or the dates are loose text');
  assert.match(joined, /FR 71: Apr 1 - Dec 15/);
  assert.match(joined, /2 more seasonal routes/, 'the undated routes are on the paper too');
  for (const it of layoutLegend(plan, legend).flatMap((pg) => pg.items)) {
    assert.ok(it.size >= TYPE.minPt);
    assert.ok(inside(it), `a seasonal row fell off the page: ${it.text}`);
  }
  // No dates, no heading. A "Seasonal routes" title over nothing reads as a claim
  // that none are seasonal.
  const bare = layoutLegend(plan, { entries: [SYMBOLS.roadSeasonal], notices: [], seasonalRoutes: [], pages: 1 });
  assert.equal(bare.flatMap((pg) => pg.items).some((i) => /Seasonal routes/.test(i.text || '')), false);
});

test('sanitizeFilename', () => {
  assert.equal(sanitizeFilename('Standing Indian / Wayah Bald (NC)'), 'Standing-Indian-Wayah-Bald-NC');
  assert.equal(sanitizeFilename(''), 'field-maps');
  assert.equal(sanitizeFilename('x'.repeat(80)).length, 60);
});

const PDFLib = loadPdfLib();
const manifest = { marker: 'MANIFEST-MARKER-7f3a', recipe };
const sheets = plan.sheets.map((s) => ({ id: s.id, jpeg: JPEG, convergenceDeg: -1.45 }));
const legend = deriveLegend({ renderedSymbolKeys: ['usgs-topo', 'mvum-road-seasonal'], gridEnabled: true, basemapRendered: true });

test('createPdf: 6 sheets + index + legend, Letter portrait, manifest attached, title set', async () => {
  const bytes = await createPdf({ PDFLib, plan, sheets, meta, legend, manifest });
  const doc = await PDFLib.PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 8);
  for (const p of doc.getPages()) assert.deepEqual(p.getSize(), { width: 612, height: 792 });
  const text = pdfText(bytes);
  assert.ok(Buffer.from(bytes).toString('latin1').includes('field-maps-manifest.json')); assert.ok(text.includes('MANIFEST-MARKER-7f3a'));
  // Every seam is labelled on both of its sheets, and nothing fell out of WinAnsi into '?'.
  const drawn = [...text.matchAll(/<([0-9A-Fa-f]{2,80})>\s*Tj/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1'));
  assert.equal(drawn.filter((t) => /^[\^v<] |\s>$/.test(t)).length, 14);
  assert.ok(!drawn.some((t) => t.includes('?')));
  assert.equal(doc.getTitle(), 'Standing Indian');
});

test('createPdf: landscape pages, a long legend adds a page, non-Latin title does not throw', async () => {
  const lp = planSheets({ ...recipe, orientation: 'landscape', maxPages: 24 });
  const ls = lp.sheets.map((s) => ({ id: s.id, jpeg: JPEG, convergenceDeg: 0 }));
  const entries = Array.from({ length: 60 }, (_, k) => ({ ...SYMBOLS.trailUnknown, key: `k${k}`, label: `Entry ${k}` }));
  const title = 'Wayah Bald — 山';
  const long = { entries, notices: ['d'], pages: 1 };
  const bytes = await createPdf({ PDFLib, plan: lp, sheets: ls, meta: { ...meta, title }, legend: long, manifest });
  const doc = await PDFLib.PDFDocument.load(bytes);
  assert.ok(layoutLegend(lp, long).length >= 2);
  assert.equal(doc.getPageCount(), lp.count + 1 + layoutLegend(lp, long).length);
  assert.deepEqual(doc.getPage(0).getSize(), { width: 792, height: 612 });
  assert.ok(doc.getTitle().includes('Wayah Bald'));
});

// A set arrives as a stack of look-alike sheets. Taping them in an arbitrary order lets
// small seam errors accumulate into a corner; taping each row first, then joining rows,
// keeps the error in one axis at a time. The index page is where someone looks first, so
// the order belongs there rather than in documentation they will not have on the table.
test('layoutIndex: the assembly order is printed, naming the real first row', () => {
  const i = layoutIndex(plan, meta);
  const order = i.texts.filter((t) => t.role === 'assembly').map((t) => t.text).join(' ');
  assert.ok(order, 'the index page prints no assembly order');
  assert.match(order, /row/i, 'the order must say rows are taped first');
  assert.match(order, /A1, A2, A3/, 'it names the actual first row rather than an example');
  assert.match(order, /overlap|band/i, 'it points at the grey overlap band');
  assert.match(order, /cross/i, 'it points at the corner crosses');
  for (const t of i.texts.filter((x) => x.role === 'assembly')) {
    assert.ok(t.x >= frame.x - 1e-6, 'assembly text starts inside the frame');
    assert.ok(t.y <= frame.y + frame.h + 1e-6, 'assembly text stays on the page');
    assert.doesNotMatch(t.text, /[^\x20-\x7e]/, `non-WinAnsi character would print as "?": ${t.text}`);
  }
});

test('layoutIndex: a single-sheet plan prints no assembly order', () => {
  const one = planSheets({ ...recipe, extent: projectBbox({ minLon: -83.55, minLat: 35.0, maxLon: -83.54, maxLat: 35.005 }, 17, 'N') });
  assert.equal(one.count, 1, 'this fixture is a one-sheet plan');
  assert.deepEqual(layoutIndex(one, meta).texts.filter((t) => t.role === 'assembly'), [],
    'nothing to assemble, so nothing to say');
});

// QUX-10a: a quad set drops grid positions, so a row can have a gap in the middle --
// naming an exact first-row id list ("A1, A2, A3") would be wrong the moment one of
// those is missing. Same 2x2 quad block (minus its SE corner) as sheet-plan.test.mjs's
// R1 fixture, at the same scale/paper/overlap/dpi as this file's own `recipe`, so its
// gridCount/count-dropping behaviour is the one already proven there.
const Q_NW = { minLon: -83.625, minLat: 35.0, maxLon: -83.5, maxLat: 35.125 };
const Q_NE = { minLon: -83.5, minLat: 35.0, maxLon: -83.375, maxLat: 35.125 };
const Q_SW = { minLon: -83.625, minLat: 34.875, maxLon: -83.5, maxLat: 35.0 };
const BLOCK_QUADS = ['280:-669', '280:-668', '279:-669']; // every quad but the SE corner
const BLOCK_BBOX = { minLon: Q_NW.minLon, minLat: Q_SW.minLat, maxLon: Q_NE.maxLon, maxLat: Q_NW.maxLat };
const quadPlan = planSheets({ ...recipe, extent: projectBbox(BLOCK_BBOX, 17, 'N'),
  bboxLonLat: BLOCK_BBOX, quads: BLOCK_QUADS, maxPages: 999, title: 'L-shape' });

test('assemblyLines/layoutIndex: a quad set that drops grid positions prints a general note, not an exact first row', () => {
  assert.ok(quadPlan.count >= 2 && quadPlan.count < quadPlan.gridCount,
    'sanity: this fixture keeps at least 2 sheets and drops at least one');
  const lines = assemblyLines(quadPlan, 1000).join(' ');
  assert.match(lines, /not every grid position prints/i);
  assert.match(lines, /tape each run of adjacent sheets row by row/i);
  assert.doesNotMatch(lines, /\bA1, A2\b/, 'no exact sheet list is named once positions can be missing');

  const i = layoutIndex(quadPlan, { ...meta, title: 'L-shape' });
  const order = i.texts.filter((t) => t.role === 'assembly').map((t) => t.text).join(' ');
  assert.match(order, /not every grid position prints/i);
  for (const t of i.texts.filter((x) => x.role === 'assembly')) {
    assert.doesNotMatch(t.text, /[^\x20-\x7e]/, `non-WinAnsi character would print as "?": ${t.text}`);
  }
});

// Road and trail labels. overlay-paths.js has computed label positions since it was
// written, and NOTHING consumed them: the worker cannot draw text and pdf.js drew it
// only for grid values, the scale bar, sheet ids, the index and the key. So every MVUM
// road printed as an anonymous red line. These assert the labels reach the paper.
const IMAGE = { x: 100, y: 50, w: 400, h: 500 };
const PIXEL = { width: 800, height: 1000 };

test('layoutLabels maps page pixels into the image rect the raster was drawn into', () => {
  const [mid] = layoutLabels(IMAGE, PIXEL, [{ key: 'mvum-road-seasonal', text: '71', x: 400, y: 500, angleDeg: 0 }]);
  // Dead centre of the raster must land dead centre of the image on the page.
  assert.equal(mid.x, IMAGE.x + IMAGE.w / 2);
  assert.equal(mid.y, IMAGE.y + IMAGE.h / 2);
  assert.equal(mid.text, '71');
  assert.equal(mid.role, 'label');
  assert.equal(mid.align, 'center');
  assert.equal(mid.halo, true, 'a label sits on contours and imagery; without a halo it is unreadable');

  const [corner] = layoutLabels(IMAGE, PIXEL, [{ key: 'k', text: 'x', x: 0, y: 0, angleDeg: 0 }]);
  assert.equal(corner.x, IMAGE.x);
  assert.equal(corner.y, IMAGE.y);
});

test('label rotation flips sign: page pixels grow down, PDF rotation goes counter-clockwise', () => {
  const [up] = layoutLabels(IMAGE, PIXEL, [{ key: 'k', text: 'a', x: 10, y: 10, angleDeg: 30 }]);
  assert.equal(up.rotate, -30);
  const [down] = layoutLabels(IMAGE, PIXEL, [{ key: 'k', text: 'b', x: 10, y: 10, angleDeg: -45 }]);
  assert.equal(down.rotate, 45);
});

test('labels stay on the page and never shrink below the minimum type size', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ key: 'k', text: `FR ${i}`, x: i * 40, y: i * 50, angleDeg: i * 9 - 90 }));
  for (const t of layoutLabels(IMAGE, PIXEL, many)) {
    assert.ok(t.x >= IMAGE.x && t.x <= IMAGE.x + IMAGE.w, `${t.text} escaped the image horizontally`);
    assert.ok(t.y >= IMAGE.y && t.y <= IMAGE.y + IMAGE.h, `${t.text} escaped the image vertically`);
    assert.ok(t.size >= TYPE.minPt);
  }
  assert.deepEqual(layoutLabels(IMAGE, PIXEL, []), [], 'no vectors, no labels');
  assert.deepEqual(layoutLabels(IMAGE, PIXEL), [], 'a sheet with no labels key is not an error');
});

test('createPdf: a road number and a trail name reach the printed sheet', async () => {
  // The end-to-end proof for labels: not "layoutLabels returned something", but
  // "the text is in the PDF bytes". pdfText() reads what a printer would set.
  const labelled = plan.sheets.map((s, i) => ({
    id: s.id, jpeg: JPEG, convergenceDeg: -1.45,
    labels: i === 0
      ? [{ key: 'mvum-road-yearlong', text: 'FR-QCM-71', x: s.pixel.width / 2, y: s.pixel.height / 2, angleDeg: 22 },
         { key: 'mvum-trail-yearlong', text: 'Standing Indian Loop', x: s.pixel.width / 4, y: s.pixel.height / 3, angleDeg: -70 }]
      : [],
  }));
  // pdf-lib writes every string as a hex operand -- <46522D...> Tj -- so a plain
  // substring search over the stream finds nothing. Decode the operands, as the
  // seam-label assertion above does.
  const drawnIn = (bytes) => [...pdfText(bytes).matchAll(/<([0-9A-Fa-f]{2,200})>\s*Tj/g)]
    .map((m) => Buffer.from(m[1], 'hex').toString('latin1'));

  const drawn = drawnIn(await createPdf({ PDFLib, plan, sheets: labelled, meta, legend, manifest }));
  assert.ok(drawn.includes('FR-QCM-71'), 'the road number never reached the paper');
  assert.ok(drawn.includes('Standing Indian Loop'), 'the trail name never reached the paper');

  const unlabelled = drawnIn(await createPdf({ PDFLib, plan, sheets, meta, legend, manifest }));
  assert.ok(!unlabelled.includes('FR-QCM-71'), 'an unlabelled build must stay unlabelled');
  // The halo draws the glyph 9 times; the reader must still see one road number, not nine.
  assert.equal(drawn.filter((t) => t === 'FR-QCM-71').length, 9, 'halo is 8 white passes plus the black one');
});

// --- named terrain on paper (N3) --------------------------------------------
// GNIS-normalized records (terrain-names.js) -> sheet-pixel anchors -> a marker
// that never moves plus a text label that shares the collision budget with
// whatever the caller already reserved (existing trail/road labels, rec-site
// markers, the sheet edges). print-names.js's placeNameLabels is the pure core;
// these tests exercise it directly, and the diacritics/marker-shape tests below
// prove the result actually reaches PDF bytes.
const identityToPx = (lon, lat) => ({ x: lon, y: lat });
const NAME_PIXEL = { width: 1000, height: 1000 };
const feature = (id, name, kind, x, y) => ({ id, name, kind, cls: kind, layer: 5, anchor: [y, x], pointCount: 1, historical: false });

test('placeNameLabels: an isolated name gets a marker at its anchor and a nearby label', () => {
  const f = feature('gnis:1', 'Cold Mountain', 'summit', 500, 500);
  const { marks, labels, dropped } = placeNameLabels([f], { toPx: identityToPx, pixel: NAME_PIXEL, sizePx: 12 });
  assert.equal(dropped, 0);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].x, 500); assert.equal(marks[0].y, 500);
  assert.equal(marks[0].marker, NAME_ICON_BY_KIND.summit.marker);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].text, 'Cold Mountain');
  // The label sits near the anchor, not on top of it and not far away.
  const dist = Math.hypot(labels[0].x - 500, labels[0].y - 500);
  assert.ok(dist > 0 && dist < 60, `label drifted ${dist}px from its anchor`);
});

test('placeNameLabels: a name colliding with an existing trail label is displaced, never overlapped', () => {
  const f = feature('gnis:2', 'Beech Gap', 'gap', 500, 500);
  // A reserved box standing exactly where the first (north) candidate would land.
  const reserved = [{ minX: 470, maxX: 530, minY: 460, maxY: 500 }];
  const overlaps = (a, b) => a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
  const { labels, dropped } = placeNameLabels([f], { toPx: identityToPx, reserved, pixel: NAME_PIXEL, sizePx: 12 });
  assert.equal(dropped, 0);
  assert.equal(labels.length, 1);
  const w = 'Beech Gap'.length * 12 * 0.6, h = 12 * 1.2;
  const box = { minX: labels[0].x - w / 2, maxX: labels[0].x + w / 2, minY: labels[0].y - h / 2, maxY: labels[0].y + h / 2 };
  assert.ok(!overlaps(box, reserved[0]), 'the placed label still overlaps the reserved trail label');
});

test('placeNameLabels: the anchor marker never moves, whether or not its label placed', () => {
  const f = feature('gnis:3', 'Long Spring', 'water-feature', 500, 500);
  const ring = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]
    .map(([dx, dy]) => ({ minX: 500 + dx * 200 - 100, maxX: 500 + dx * 200 + 100, minY: 500 + dy * 200 - 100, maxY: 500 + dy * 200 + 100 }));
  const blocked = placeNameLabels([f], { toPx: identityToPx, reserved: ring, pixel: NAME_PIXEL, sizePx: 12 });
  const open = placeNameLabels([f], { toPx: identityToPx, pixel: NAME_PIXEL, sizePx: 12 });
  assert.equal(blocked.marks[0].x, 500); assert.equal(blocked.marks[0].y, 500);
  assert.equal(open.marks[0].x, 500); assert.equal(open.marks[0].y, 500);
});

test('placeNameLabels: a label with nowhere to go is dropped and counted, the marker still prints', () => {
  const f = feature('gnis:4', 'A Very Long Named Feature That Cannot Fit Anywhere Nearby', 'other-land', 500, 500);
  // Every compass offset is walled off close in, and the sheet itself is tiny, so
  // no candidate box can land inside bounds without overlapping a wall.
  const walls = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]
    .map(([dx, dy]) => ({ minX: 500 + dx * 20 - 400, maxX: 500 + dx * 20 + 400, minY: 500 + dy * 20 - 400, maxY: 500 + dy * 20 + 400 }));
  const { marks, labels, dropped } = placeNameLabels([f], { toPx: identityToPx, reserved: walls, pixel: NAME_PIXEL, sizePx: 12 });
  assert.equal(dropped, 1);
  assert.equal(labels.length, 0);
  assert.equal(marks.length, 1, 'the anchor marker still drew even though its name was dropped');
});

test('placeNameLabels: deterministic given a deterministic order, never re-sorted', () => {
  const fa = feature('gnis:a', 'Alpha Ridge', 'ridge', 200, 200);
  const fb = feature('gnis:b', 'Beta Falls', 'water-feature', 700, 700);
  const once = placeNameLabels([fb, fa], { toPx: identityToPx, pixel: NAME_PIXEL, sizePx: 12 });
  const twice = placeNameLabels([fb, fa], { toPx: identityToPx, pixel: NAME_PIXEL, sizePx: 12 });
  assert.deepEqual(once, twice, 'the same input order must produce the same output every time');
  // Placed in the order given, not re-sorted by id/name/priority: that is
  // labelPriorityOrder's job (terrain-names.js), called before this function.
  assert.deepEqual(once.marks.map((m) => m.id), ['gnis:b', 'gnis:a']);
});

test('markerPath: every terrain-name icon shape is a finite, drawable polyline', () => {
  for (const shape of ['chevron', 'zigzag', 'droplet', 'diamond', 'wave']) {
    const path = markerPath(shape, 10, 10, 8);
    assert.ok(Array.isArray(path) && path.length >= 2, `${shape} did not return a polyline`);
    for (const [x, y] of path) assert.ok(Number.isFinite(x) && Number.isFinite(y), `${shape} has a non-finite point`);
  }
  // 'stream-mouth' has no shape: the default filled circle, same as a rec 'dot'.
  assert.equal(markerPath(NAME_ICON_BY_KIND['stream-mouth'].marker, 10, 10, 8), null);
});

test('layoutNameMarks: sheet-pixel marks scale into the image rect like layoutSites', () => {
  const [mark] = layoutNameMarks(IMAGE, PIXEL, [{ x: 400, y: 500, marker: 'triangle', sizePx: PIXEL.width / 20, color: '#000000', name: 'Cold Mountain' }]);
  assert.equal(mark.x, IMAGE.x + IMAGE.w / 2);
  assert.equal(mark.y, IMAGE.y + IMAGE.h / 2);
  assert.equal(mark.marker, 'triangle');
  assert.equal(mark.name, 'Cold Mountain');
  assert.ok(mark.sizePt > 0 && Number.isFinite(mark.sizePt));
  assert.deepEqual(layoutNameMarks(IMAGE, PIXEL, []), []);
});

// Diacritics: a named terrain feature can carry a Latin-1 accented letter (GNIS
// publishes "Cañón" and "Étang" spellings). pdf-lib embeds Helvetica in WinAnsi
// (see pdf.js's WINANSI regex), which already covers the Latin-1 Supplement
// range (0xA0-0xFF) that both of these fall in -- so both names print literally.
// A character genuinely outside WinAnsi falls back to '?' (pageDrawer's existing
// `text.replace(WINANSI, '?')`), the same fallback every other label on this
// sheet already uses; this test documents that names take the identical path,
// not a separate one.
test('createPdf: a named-terrain label with diacritics reaches the paper, never as boxes', async () => {
  const first = plan.sheets[0];
  const named = plan.sheets.map((s, i) => ({
    id: s.id, jpeg: JPEG, convergenceDeg: -1.45,
    labels: i === 0
      ? [{ key: 'name-summit', text: 'Cañón Peak', x: s.pixel.width / 2, y: s.pixel.height / 2, angleDeg: 0 },
         { key: 'name-water-feature', text: "Étang de l'Ours", x: s.pixel.width / 4, y: s.pixel.height / 4, angleDeg: 0 }]
      : [],
    nameMarks: i === 0
      ? [{ id: 'gnis:1', kind: 'summit', marker: 'triangle', x: first.pixel.width / 2, y: first.pixel.height / 2, sizePx: 20, color: '#000000', name: 'Cañón Peak' }]
      : [],
  }));
  const bytes = await createPdf({ PDFLib, plan, sheets: named, meta, legend, manifest });
  const drawn = [...pdfText(bytes).matchAll(/<([0-9A-Fa-f]{2,200})>\s*Tj/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1'));
  assert.ok(drawn.includes('Cañón Peak'), 'the diacritic name never reached the paper');
  assert.ok(drawn.includes("Étang de l'Ours"), 'the diacritic name never reached the paper');
  assert.ok(!drawn.some((t) => t.includes('?')), 'a supported diacritic must never fall back to a box/question mark');
});
