// U6: the map key on its own sheet, before any paper is spent on a set. It is
// built from the same legend derivation the on-page key uses and drawn by the same
// pass createPdf uses for the key at the back of a set, so all three read one table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync, constants as Z } from 'node:zlib';
import { planSheets } from '../../themes/headlessmode/static/js/quiet-corners-maps/sheet-plan.js';
import { projectBbox } from '../../themes/headlessmode/static/js/quiet-corners-maps/geometry.js';
import { dashPt, DISCLAIMER } from '../../themes/headlessmode/static/js/quiet-corners-maps/legend.js';
import { legendRows } from '../../themes/headlessmode/static/js/quiet-corners-maps/legend-view.js';
import { keySheetPlan, keySheetLegend, createKeySheetPdf } from '../../themes/headlessmode/static/js/quiet-corners-maps/key-sheet.js';
import { loadPdfLib } from './helpers/load-pdf-lib.mjs';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} !== ${b}`);
const pdfText = (bytes) => {
  const buf = Buffer.from(bytes); let out = buf.toString('latin1');
  for (const m of buf.toString('latin1').matchAll(/stream\r?\n/g)) {
    try { out += inflateSync(buf.subarray(m.index + m[0].length), { finishFlush: Z.Z_SYNC_FLUSH }).toString('latin1'); } catch { /* not Flate */ }
  }
  return out;
};
const LAYERS = { usgsTopo: true, mvum: true, trails: true, recSites: false, federalLand: false };

test('keySheetPlan: the frame a real Letter sheet prints, so the key lays out exactly as it does at the back of a set', () => {
  const extent = projectBbox({ minLon: -83.55, minLat: 35.0, maxLon: -83.45, maxLat: 35.03 }, 17, 'N');
  const real = planSheets({ paper: 'letter', orientation: 'portrait', scale: 24000, overlapIn: 0.5, dpi: 300, extent, zone: 17, hemisphere: 'N', title: 'x' });
  const p = keySheetPlan();
  assert.deepEqual([p.page.widthPt, p.page.heightPt], [612, 792]);
  for (const k of ['xPt', 'yPt', 'widthIn', 'heightIn']) near(p.frame[k], real.frame[k], `frame ${k}`);
});

test('keySheetLegend: the same entries, in the same order, as the on-page key for the same choices', () => {
  const legend = keySheetLegend({ layers: LAYERS, grid: 'utm-1km' });
  const rows = legendRows({ layers: LAYERS, grid: 'utm-1km' });
  assert.deepEqual(legend.entries.map((e) => e.key), rows.map((r) => r.key));
  assert.ok(legend.entries.some((e) => e.key.startsWith('mvum-')), 'an enabled layer reaches the key');
  assert.ok(legend.entries.some((e) => e.key === 'utm-grid'), 'the grid choice reaches the key');
  assert.ok(legend.notices.includes(DISCLAIMER), 'the MVUM notice the drawn symbols oblige is on the sheet');
  assert.ok(!keySheetLegend({ layers: LAYERS, grid: 'none' }).entries.some((e) => e.key === 'utm-grid'), 'no grid, no grid entry');
});

const PDFLib = loadPdfLib();

test('createKeySheetPdf: Letter pages titled as a key, every entry labelled, dashes stroked from the one table, no "?"', async () => {
  const legend = keySheetLegend({ layers: LAYERS, grid: 'utm-1km' });
  const bytes = await createKeySheetPdf({ PDFLib, layers: LAYERS, grid: 'utm-1km' });
  const doc = await PDFLib.PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 1);
  assert.deepEqual(doc.getPage(0).getSize(), { width: 612, height: 792 });
  assert.equal(doc.getTitle(), 'Field Maps map key');
  const text = pdfText(bytes);
  const drawn = [...text.matchAll(/<([0-9A-Fa-f]{2,400})>\s*Tj/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1'));
  assert.ok(drawn.includes('Legend'), 'the page is not titled');
  for (const e of legend.entries) assert.ok(drawn.includes(e.label), `${e.label} missing from the sheet`);
  assert.ok(!drawn.some((t) => t.includes('?')), 'a label fell out of WinAnsi');
  // The seasonal road swatch is dashed on the sheet with the SAME pattern the set prints.
  const [on, off] = dashPt('dash');
  assert.ok(text.includes(`[${on} ${off}] 0 d`), `no dash ${on}/${off} stroked on the key sheet`);
});

// --- wiring (source-contract; DOM code the Node suite cannot execute) ---------------
const main = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');

test('the key sheet has its own button and download anchor, and does not take the map PDF\'s', () => {
  assert.ok(main.includes("$('qcm-key-sheet')"), 'main.js never wires the key-sheet button');
  const fn = main.slice(main.indexOf('async function offerKeySheet'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(body.includes('createKeySheetPdf'), 'the button must build the key sheet');
  assert.ok(body.includes('qcm-key-sheet-download'), 'the key sheet must use its own anchor');
  assert.ok(!body.includes("$('qcm-download')"), 'the key sheet must not overwrite the map PDF download link');
  assert.ok(/state\.recipe\s*\?\s*state\.recipe\.layers\s*:\s*controls\(\)\.layers/.test(body), 'the sheet must read the layer choice the on-page key reads');
});
