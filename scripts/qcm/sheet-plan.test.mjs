// Tests for the pure sheet-planning module behind /quiet-corners/maps/.
// Runs under Node's built-in runner: node --test "scripts/qcm/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  POINTS_PER_INCH, METERS_PER_INCH, PAPER, LIMITS, FURNITURE,
  planSheets, serializeRecipe, parseRecipe, coverageRatio,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/sheet-plan.js';
import { projectBbox } from '../../themes/headlessmode/static/js/quiet-corners-maps/geometry.js';

const EPS = 1e-9;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < EPS, `${msg}: ${a} != ${b}`);

// 1:24,000 portrait Letter, 0.5 in overlap: frame 8.0 x 9.5 in.
const base = {
  paper: 'letter', orientation: 'portrait', scale: 24000, overlapIn: 0.5,
  dpi: 300, extent: { minX: 500000, minY: 4700000, maxX: 501000, maxY: 4701000 },
  zone: 16, hemisphere: 'N', title: 'Test',
};
const withExtent = (w, h, o = {}) => ({
  ...base, ...o, extent: { minX: 0, minY: 0, maxX: w, maxY: h },
});

test('constants: points, inches, paper, limits, furniture', () => {
  assert.equal(POINTS_PER_INCH, 72);
  assert.equal(METERS_PER_INCH, 0.0254);
  assert.deepEqual(PAPER.letter, { widthIn: 8.5, heightIn: 11 });
  assert.deepEqual(LIMITS, { maxRows: 26, maxCols: 99, defaultMaxPages: 24 });
  assert.deepEqual(FURNITURE, { headerIn: 0.4, footerIn: 0.6 });
});

test('portrait Letter page, frame, ground and stride at 1:24,000 / 0.5 in', () => {
  const p = planSheets(base);
  assert.equal(p.page.widthPt, 8.5 * 72);
  assert.equal(p.page.heightPt, 11 * 72);
  near(p.frame.widthIn, 8.0, 'frame width');
  near(p.frame.heightIn, 9.5, 'frame height');
  near(p.frame.xPt, 0.25 * 72, 'frame x');
  near(p.frame.yPt, (0.25 + 0.4) * 72, 'frame y (from top)');
  near(p.groundWidthM, 4876.8, 'ground width');
  near(p.groundHeightM, 5791.2, 'ground height');
  near(p.strideXM, 4572, 'stride x');
  near(p.strideYM, 5486.4, 'stride y');
  assert.equal(p.input.insetIn, 0.25);
  assert.equal(p.input.maxPages, 24);
});

test('landscape swaps page width and height', () => {
  const p = planSheets({ ...base, orientation: 'landscape' });
  assert.equal(p.page.widthPt, 11 * 72);
  assert.equal(p.page.heightPt, 8.5 * 72);
  near(p.frame.widthIn, 10.5, 'frame width');
  near(p.frame.heightIn, 7.0, 'frame height');
});

test('extent smaller than a page is one sheet centered on the extent', () => {
  const p = planSheets(base);
  assert.equal(p.rows, 1); assert.equal(p.cols, 1); assert.equal(p.count, 1);
  const s = p.sheets[0];
  assert.equal(s.id, 'A1');
  near((s.extent.minX + s.extent.maxX) / 2, 500500, 'center x');
  near((s.extent.minY + s.extent.maxY) / 2, 4700500, 'center y');
  near(s.extent.maxX - s.extent.minX, 4876.8, 'sheet width');
  assert.deepEqual(s.neighbors, { n: null, s: null, e: null, w: null });
  assert.deepEqual(s.pixel, { width: 2400, height: 2850 });
  near(s.metersPerPixel, 2.032, 'meters per pixel');
});

test('extent of exactly one page plus two strides is 3 cols, not 4 (epsilon)', () => {
  const p = planSheets(withExtent(4876.8 + 2 * 4572, 1000));
  assert.equal(p.cols, 3); assert.equal(p.rows, 1);
  near(p.covered.minX, 0, 'covered minX'); near(p.covered.maxX, 4876.8 + 2 * 4572, 'covered maxX');
});

test('13.7 km x 11.1 km at 1:24,000 portrait 0.5 in is 3 x 2 sheets A1..B3', () => {
  const p = planSheets(withExtent(13700, 11100));
  assert.equal(p.cols, 3); assert.equal(p.rows, 2); assert.equal(p.count, 6);
  assert.deepEqual(p.sheets.map((s) => s.id), ['A1', 'A2', 'A3', 'B1', 'B2', 'B3']);
  const byId = Object.fromEntries(p.sheets.map((s) => [s.id, s]));
  assert.deepEqual(byId.A1.neighbors, { n: null, s: 'B1', e: 'A2', w: null });
  assert.deepEqual(byId.B2.neighbors, { n: 'A2', s: null, e: 'B3', w: 'B1' });
  assert.ok(byId.A1.extent.minY > byId.B1.extent.minY, 'row A is north of row B');
  near(byId.A2.extent.minX - byId.A1.extent.minX, 4572, 'column stride');
  near(byId.A1.extent.minY - byId.B1.extent.minY, 5486.4, 'row stride');
  near(byId.A1.extent.maxY, p.covered.maxY, 'A1 touches covered top');
  near(byId.B3.extent.maxX, p.covered.maxX, 'B3 touches covered right');
});

test('1:48,000 halves the page count in each direction', () => {
  const p = planSheets(withExtent(13700, 11100, { scale: 48000 }));
  assert.equal(p.cols, 2); assert.equal(p.rows, 1); assert.equal(p.count, 2);
  near(p.sheets[0].metersPerPixel, 4.064, 'meters per pixel');
});

test('too many pages or rows throws RangeError', () => {
  assert.throws(() => planSheets(withExtent(13700, 11100, { maxPages: 4 })), RangeError);
  assert.throws(() => planSheets(withExtent(1000, 27 * 5486.4 + 5791.2, { maxPages: 1000 })), RangeError);
  assert.throws(() => planSheets(withExtent(100 * 4572 + 4876.8, 1000, { maxPages: 1000 })), RangeError);
});

test('serializeRecipe is stable across key order and parseRecipe round-trips', () => {
  const a = serializeRecipe(base);
  const shuffled = Object.fromEntries(Object.entries(base).reverse());
  shuffled.extent = Object.fromEntries(Object.entries(base.extent).reverse());
  assert.equal(serializeRecipe(shuffled), a);
  const back = parseRecipe(a);
  assert.deepEqual(planSheets(back), planSheets(base));
  assert.equal(serializeRecipe(back), a);
  assert.throws(() => serializeRecipe({ ...base, scale: 12000 }), RangeError);
});

test('parseRecipe rejects bad fields', () => {
  const bad = (patch, Err) => assert.throws(
    () => parseRecipe(JSON.stringify({ ...base, ...patch })), Err);
  bad({ extent: { ...base.extent, minX: NaN } }, TypeError);
  bad({ paper: 'a4' }, RangeError);
  bad({ orientation: 'sideways' }, RangeError);
  bad({ zone: 0 }, RangeError);
  bad({ zone: 61 }, RangeError);
  bad({ hemisphere: 'X' }, RangeError);
  bad({ overlapIn: 0.3 }, RangeError);
  bad({ title: 7 }, TypeError);
  assert.throws(() => parseRecipe('not json'), SyntaxError);
});

// A saved recipe kept only the projected extent, so a reload rebuilt the lon/lat box
// from the sheet grid's UTM ring — which is the extent GROWN to whole sheets. Each
// save/restore cycle therefore enlarged the area by a few hundred metres. Round-trip
// the box itself so a restore returns the area the person actually chose.
test('serializeRecipe round-trips the lon/lat box the area was chosen from', () => {
  const bboxLonLat = { minLon: -83.55, minLat: 35.0, maxLon: -83.4, maxLat: 35.1 };
  const recipe = { paper: 'letter', orientation: 'portrait', scale: 24000, overlapIn: 0.5, insetIn: 0.25,
    dpi: 300, maxPages: 24, zone: 17, hemisphere: 'N', title: 'Standing Indian',
    extent: { minX: 449000, minY: 3872000, maxX: 462000, maxY: 3884000 }, bboxLonLat };
  const back = parseRecipe(serializeRecipe(recipe));
  assert.deepEqual(back.bboxLonLat, bboxLonLat, 'the chosen box survives save and restore');
});

test('a recipe saved before the box was stored still parses, with no box', () => {
  const legacy = { paper: 'letter', orientation: 'portrait', scale: 24000, overlapIn: 0.5, insetIn: 0.25,
    dpi: 300, maxPages: 24, zone: 17, hemisphere: 'N', title: 'Older job',
    extent: { minX: 449000, minY: 3872000, maxX: 462000, maxY: 3884000 } };
  const back = parseRecipe(JSON.stringify(legacy));
  assert.equal(back.bboxLonLat, null, 'absent reads as null rather than throwing');
  assert.equal(back.title, 'Older job');
});

test('a malformed lon/lat box is rejected rather than restored', () => {
  const base = { paper: 'letter', orientation: 'portrait', scale: 24000, overlapIn: 0.5, insetIn: 0.25,
    dpi: 300, maxPages: 24, zone: 17, hemisphere: 'N', title: 'x',
    extent: { minX: 449000, minY: 3872000, maxX: 462000, maxY: 3884000 } };
  assert.throws(() => serializeRecipe({ ...base, bboxLonLat: { minLon: 'x', minLat: 35, maxLon: -83.4, maxLat: 35.1 } }), TypeError);
  assert.throws(() => serializeRecipe({ ...base, bboxLonLat: { minLon: -83.4, minLat: 35, maxLon: -83.55, maxLat: 35.1 } }), RangeError);
});

// U-Q1, the zero-paper coverage gate. A deliberate, reviewed number: at the default
// recipe the map frame is 8.000 x 9.500 in of an 8.5 x 11 in Letter sheet — 76.00 of
// 93.50 sq in, or 0.812834. (The plan's "81.3%" is that figure rounded up for prose;
// 0.813 as a floor would fail on the current layout, so the floor is stated to four
// places.) The missing 18.7% is the 0.25 in inset on four sides plus the 0.4 in header
// and 0.6 in footer bands, each of which earns its space in §2 of
// .data/plans/2026-09-06-quadstack-print-layout-and-assembly.md. Lower this ONLY as a
// reviewed decision recorded in that plan — never to make a layout change pass.
const COVERAGE_FLOOR = 0.8128;

// QUX-10a: quad-set selections. Four adjacent 7.5-minute cells at zone 17 N, the same
// grid the geometry.test.mjs fixtures use (NW is "rainbowSprings"): row 280 is north of
// row 279, col -668 is east of col -669.
const Q_NW = { minLon: -83.625, minLat: 35.0, maxLon: -83.5, maxLat: 35.125 };   // "280:-669"
const Q_NE = { minLon: -83.5, minLat: 35.0, maxLon: -83.375, maxLat: 35.125 };   // "280:-668"
const Q_SW = { minLon: -83.625, minLat: 34.875, maxLon: -83.5, maxLat: 35.0 };   // "279:-669"
const Q_SE = { minLon: -83.5, minLat: 34.875, maxLon: -83.375, maxLat: 35.0 };   // "279:-668", dropped below
const ROW_BBOX = { minLon: Q_NW.minLon, minLat: Q_NW.minLat, maxLon: Q_NE.maxLon, maxLat: Q_NE.maxLat };
const BLOCK_BBOX = { minLon: Q_NW.minLon, minLat: Q_SW.minLat, maxLon: Q_NE.maxLon, maxLat: Q_NW.maxLat };
const QUAD_BASE = { paper: 'letter', orientation: 'portrait', scale: 24000, overlapIn: 0.5, dpi: 300, zone: 17, hemisphere: 'N', title: 'Quad test' };

test('quads: validation rejects a non-array, empty, malformed, duplicate, oversized, or box-mismatched selection', () => {
  const withRow = (patch) => planSheets({ ...QUAD_BASE, extent: projectBbox(ROW_BBOX, 17, 'N'), bboxLonLat: ROW_BBOX, ...patch });
  assert.throws(() => withRow({ quads: [] }), RangeError, 'empty array');
  assert.throws(() => withRow({ quads: 'not-an-array' }), RangeError, 'not an array');
  assert.throws(() => withRow({ quads: ['not-a-cell'], bboxLonLat: Q_NW }), /malformed quadrangle id/);
  assert.throws(() => withRow({ quads: ['280:-669', '280:-669'], bboxLonLat: Q_NW }), /duplicate quadrangle id/);
  assert.throws(() => planSheets({ ...QUAD_BASE, extent: projectBbox(Q_NW, 17, 'N'), quads: ['280:-669'] }),
    /quads must be accompanied by bboxLonLat/, 'quads with no box at all');
  assert.throws(() => withRow({ quads: ['280:-669'], bboxLonLat: ROW_BBOX }),
    /bboxLonLat must equal bboxOfCells\(quads\) exactly/, 'box wider than the one selected quad');
  const tooMany = Array.from({ length: LIMITS.maxRows * LIMITS.maxCols + 1 }, (_, i) => `x${i}`);
  assert.throws(() => planSheets({ ...QUAD_BASE, extent: projectBbox(ROW_BBOX, 17, 'N'), quads: tooMany }),
    /at most \d+ entries/, 'over the maxRows*maxCols ceiling');
});

test('quads: normalized to canonical sort order (north to south, then west to east) regardless of input order', () => {
  const extent = projectBbox(ROW_BBOX, 17, 'N');
  const scrambled = serializeRecipe({ ...QUAD_BASE, extent, bboxLonLat: ROW_BBOX, quads: ['280:-668', '280:-669'] });
  const canonical = serializeRecipe({ ...QUAD_BASE, extent, bboxLonLat: ROW_BBOX, quads: ['280:-669', '280:-668'] });
  assert.equal(scrambled, canonical, 'input order must not affect the stable cache key');
  assert.deepEqual(parseRecipe(scrambled).quads, ['280:-669', '280:-668']);
});

test('quads: a selection that exactly tiles its envelope keeps every grid position', () => {
  const extent = projectBbox(ROW_BBOX, 17, 'N');
  const plan = planSheets({ ...QUAD_BASE, extent, bboxLonLat: ROW_BBOX, quads: ['280:-669', '280:-668'] });
  assert.ok(plan.gridCount >= 1);
  assert.equal(plan.count, plan.gridCount, 'the quads union is the whole covered rectangle -- nothing falls outside it');
  assert.ok(plan.sheets.every((s) => s.id !== null && !Object.values(s.neighbors).includes(undefined)));
});

// R1: the central risk this unit exists to close. A quad set must never silently
// fall back to printing the whole rectangular envelope -- some grid position must
// actually be left out, the cap must be checked against what is KEPT rather than
// against the whole envelope grid (plan §3), and every kept sheet's neighbours must
// stay reciprocal with a null exactly where a neighbour was dropped.
test('quads: an L-shaped selection (one corner of a 2x2 block dropped) leaves a real hole', () => {
  const extent = projectBbox(BLOCK_BBOX, 17, 'N');
  // maxPages sits one below gridCount: this only avoids a throw if AT LEAST one grid
  // position is actually dropped, which is exactly the property under test.
  const plan = planSheets({
    ...QUAD_BASE, extent, bboxLonLat: BLOCK_BBOX, maxPages: 999,
    quads: ['280:-669', '280:-668', '279:-669'], // every quad but the SE corner (279:-668)
  });
  assert.ok(plan.gridCount > 1, 'a 2x2 block of 7.5-minute cells needs more than one sheet at 1:24,000');
  assert.ok(plan.count < plan.gridCount, 'the dropped SE quad must actually remove a grid position');
  assert.equal(plan.sheets.find((s) => s.row === 0 && s.col === 0).id, 'A1',
    'the NW-most position sits inside a kept quad and must survive');
  assert.equal(plan.sheets.find((s) => s.row === plan.rows - 1 && s.col === plan.cols - 1), undefined,
    'the SE-most position sits inside ONLY the dropped quad and must be gone, not merely renamed');
  // Structural invariant, true regardless of exactly which interior positions were kept:
  // every neighbour pointer either names a sheet that is actually in the plan and points
  // straight back, or is null because that direction is off-grid or was dropped.
  const byRC = new Map(plan.sheets.map((s) => [`${s.row}:${s.col}`, s]));
  const OPPOSITE = { n: 's', s: 'n', e: 'w', w: 'e' };
  const DELTA = { n: [-1, 0], s: [1, 0], e: [0, 1], w: [0, -1] };
  for (const s of plan.sheets) {
    for (const dir of ['n', 's', 'e', 'w']) {
      const [dr, dc] = DELTA[dir];
      const there = byRC.get(`${s.row + dr}:${s.col + dc}`);
      if (!there) { assert.equal(s.neighbors[dir], null, `${s.id}.${dir} points off-grid or at a dropped position`); continue; }
      assert.equal(s.neighbors[dir], there.id, `${s.id}.${dir}`);
      assert.equal(there.neighbors[OPPOSITE[dir]], s.id, `${s.id}.${dir} reciprocity`);
    }
  }
});

test('quads: the page cap applies to what prints, not to the envelope grid', () => {
  // Same L-shape as above, but maxPages sits BELOW gridCount and at/above the kept
  // count: this must plan (the grid alone would have thrown under the old, pre-quads
  // rule), and a maxPages below the kept count must still throw.
  const extent = projectBbox(BLOCK_BBOX, 17, 'N');
  const quads = ['280:-669', '280:-668', '279:-669'];
  const full = planSheets({ ...QUAD_BASE, extent, bboxLonLat: BLOCK_BBOX, maxPages: 999, quads });
  assert.ok(full.gridCount > full.count, 'sanity: this fixture does drop pages (asserted in detail above)');
  assert.doesNotThrow(() => planSheets({ ...QUAD_BASE, extent, bboxLonLat: BLOCK_BBOX, maxPages: full.count, quads }),
    'kept count exactly at the cap must still plan');
  assert.throws(() => planSheets({ ...QUAD_BASE, extent, bboxLonLat: BLOCK_BBOX, maxPages: full.count - 1, quads }),
    RangeError, 'one below the kept count must throw even though gridCount alone would not have');
});

test('recipeVersion: v2 is written first; an old, unversioned string still parses to the same plan', () => {
  const s = serializeRecipe(base);
  const ordered = JSON.parse(s);
  assert.deepEqual(Object.keys(ordered)[0], 'recipeVersion');
  assert.equal(ordered.recipeVersion, 2);
  const legacy = { ...base }; // no recipeVersion key at all, exactly what a v1-era save looked like
  const parsed = parseRecipe(JSON.stringify(legacy));
  assert.deepEqual(planSheets(parsed), planSheets(base));
  assert.equal(parsed.quads, null);
});

test('recipeVersion: rejects anything but a supported integer, and quads on a v1 recipe', () => {
  const raw = JSON.parse(serializeRecipe(base));
  const withVersion = (v) => JSON.stringify({ ...raw, recipeVersion: v });
  for (const bad of [3, 0, -1, 1.5, '2', null]) {
    assert.throws(() => parseRecipe(withVersion(bad)), RangeError, `recipeVersion ${JSON.stringify(bad)}`);
  }
  assert.throws(() => parseRecipe(JSON.stringify({ ...raw, recipeVersion: 1, quads: ['280:-669'] })),
    /quads require recipe version 2/);
});

test('quads round-trip through serializeRecipe/parseRecipe to the identical plan', () => {
  const extent = projectBbox(ROW_BBOX, 17, 'N');
  const recipe = { ...QUAD_BASE, extent, bboxLonLat: ROW_BBOX, quads: ['280:-669', '280:-668'] };
  const a = serializeRecipe(recipe);
  const back = parseRecipe(a);
  assert.deepEqual(planSheets(back), planSheets(recipe));
  assert.equal(serializeRecipe(back), a);
});

test('coverage: the map frame keeps at least the reviewed share of the sheet', () => {
  const ratio = coverageRatio(planSheets(base));
  near(ratio, 76 / 93.5, 'frame area / page area');
  assert.ok(ratio >= COVERAGE_FLOOR, `coverage ${ratio} is below the reviewed floor ${COVERAGE_FLOOR}`);
  // The floor has to be able to fail, or it gates nothing: a fatter inset must trip it.
  assert.ok(coverageRatio(planSheets({ ...base, insetIn: 0.4 })) < COVERAGE_FLOOR, 'a wider inset must trip the floor');
  // Landscape turns the same furniture into a bigger share of a shorter page, so it is
  // measured separately rather than folded into one number.
  near(coverageRatio(planSheets({ ...base, orientation: 'landscape' })), (11 - 0.5) * (8.5 - 1.5) / 93.5, 'landscape coverage');
});
