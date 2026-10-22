// The invariant this file exists for: A LAYER THAT PREVIEWS, PRINTS.
//
// Four layers merged with source modules, symbols, controls, preview code and
// passing tests, and none of them reached the printed PDF. source-trails.js,
// source-elevation.js and source-aerial.js were imported by NOTHING; rec sites
// were fetched and previewed but never handed to createPdf; and the vector styling
// table was filtered to keys starting `mvum-`, so a trail or a boundary looked up
// its style, found nothing, and was silently dropped.
//
// Every test here is about the WIRING between modules, which is exactly what unit
// tests of each module could not see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LAYERS, layerControlSpecs, enabledLayers } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';
import { STYLE, vectorsForSheet } from '../../themes/headlessmode/static/js/quiet-corners-maps/overlay-paths.js';
import { SYMBOL_BY_KEY } from '../../themes/headlessmode/static/js/quiet-corners-maps/legend.js';
import { FAMILY_SYMBOL } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-land-boundaries.js';
import { planSheets } from '../../themes/headlessmode/static/js/quiet-corners-maps/sheet-plan.js';
import { projectBbox, inverse } from '../../themes/headlessmode/static/js/quiet-corners-maps/geometry.js';

const read = (rel) => readFileSync(new URL(`../../themes/headlessmode/static/js/quiet-corners-maps/${rel}`, import.meta.url), 'utf8');
const MAIN = read('main.js');
const BUILD = read('build.js');

const plan = planSheets({
  paper: 'letter', orientation: 'portrait', scale: 24000, overlapIn: 0.5, insetIn: 0.25, dpi: 300,
  maxPages: 24, title: 'T', grid: 'utm-1km', layers: { usgsTopo: true },
  extent: projectBbox({ minLon: -83.55, minLat: 35.0, maxLon: -83.45, maxLat: 35.03 }, 17, 'N'),
  zone: 17, hemisphere: 'N',
});
const sheet = plan.sheets[0];
const lonLatOn = (x, y) => {
  const p = inverse(sheet.extent.minX + x * sheet.metersPerPixel, sheet.extent.maxY - y * sheet.metersPerPixel, 17, 'N');
  return [p.lon, p.lat];
};
const across = () => [[0.2, 0.2], [0.8, 0.8]].map(([fx, fy]) => lonLatOn(fx * sheet.pixel.width, fy * sheet.pixel.height));

// The guard proper. A layer in the registry that nothing fetches is a control the
// user can switch on to no effect — which is what shipped for trails.
test('every non-required live layer is actually fetched by main.js', () => {
  // A state land layer is read through a loop over FAMILY_SYMBOL rather than by
  // name, so accept that form for those and a literal for the rest. What is NOT
  // accepted is neither, which is precisely how the trails layer shipped: a
  // control the user could switch on that fetched nothing.
  const iteratesFamilies = /Object\.keys\(FAMILY_SYMBOL\)/.test(MAIN) && /layers\[family\]/.test(MAIN);
  // A camera layer is read the same way: CAMERA_LAYER_IDS is derived from the cameras group, the
  // moveend loop refreshes each id and refreshCameraLayer reads layers[layerId]. All three must
  // hold, and the layer must sit in that group, or its switch draws nothing.
  const iteratesCameras = /CAMERA_LAYER_IDS = LAYERS\.filter\(\(l\) => l\.group === 'cameras'\)/.test(MAIN)
    && /for \(const id of CAMERA_LAYER_IDS\) refreshCameraLayer\(id/.test(MAIN)
    && /function refreshCameraLayer\(layerId[^)]*\) \{[^]*?if \(!layers\[layerId\]\)/.test(MAIN);
  for (const layer of LAYERS.filter((l) => !l.required && l.status === 'live')) {
    if (layer.stateScoped) {
      assert.ok(iteratesFamilies,
        `${layer.id} is state-scoped but main.js does not loop the families — its control does nothing`);
      assert.ok(Object.keys(FAMILY_SYMBOL).includes(layer.family),
        `${layer.id} names family ${layer.family}, which the loop would never visit`);
      continue;
    }
    if (layer.group === 'cameras') {
      assert.ok(iteratesCameras,
        `${layer.id} is a camera layer but main.js no longer refreshes CAMERA_LAYER_IDS by layers[layerId] — its control does nothing`);
      continue;
    }
    // An extra PAGE is acted on in build.js, which is the only place that knows the
    // sheets. Both aerial and tripPage shipped with no control at all AND no
    // reader, which is how they became unreachable code.
    const where = layer.extraPage ? BUILD : MAIN;
    const file = layer.extraPage ? 'build.js' : 'main.js';
    assert.match(where, new RegExp(`layers[?]?(\\.|\\[')${layer.id}`),
      `nothing in ${file} reads recipe.layers.${layer.id} — its control does nothing`);
  }
});

// Both extras must be reachable AND offered. A page nobody can switch on is the
// same defect as a page nothing builds.
test('every extra page has a control and a builder', () => {
  for (const layer of LAYERS.filter((l) => l.extraPage)) {
    assert.ok(layerControlSpecs({}).some((spec) => spec.id === layer.id),
      `${layer.id} renders no control, so nobody can ask for it`);
    assert.ok(!enabledLayers({ [layer.id]: true }).some((l) => l.id === layer.id),
      `${layer.id} is an extra page, not an overlay to fetch`);
  }
  // DERIVED, not two hardcoded function names. The old form matched `fetchAerial(`
  // and went quiet the moment the aerial and relief pages started sharing one
  // companion loop, which passes the fetcher as a value rather than calling it by
  // name. What actually has to be true is that build.js branches on the control:
  // a registry entry nothing in build.js reads is a switch wired to nothing.
  for (const layer of LAYERS.filter((l) => l.extraPage)) {
    assert.ok(BUILD.includes(`recipe.layers?.${layer.id}`),
      `${layer.id} has a control, and build.js never asks whether it is on`);
  }
  assert.match(BUILD, /profileFor\(/, 'the trip page has no elevation');
});

test('every module main.js calls is imported, and every source module it names exists', () => {
  const imported = new Set([...MAIN.matchAll(/^import \{([^}]*)\} from/gm)]
    .flatMap((m) => m[1].split(',').map((n) => n.trim().split(/\s+as\s+/).pop())));
  for (const fn of ['fetchTrails', 'fetchLandBoundaries', 'fetchRecSites', 'fetchLayer', 'runBuild']) {
    assert.ok(MAIN.includes(`${fn}(`), `main.js never calls ${fn}`);
    assert.ok(imported.has(fn), `main.js calls ${fn}() but never imports it`);
  }
});

// STYLE was filtered to `mvum-` keys. A trail looked itself up, found nothing, and
// vectorsForSheet dropped it without a word.
test('every drawable line symbol has a stroke style, so nothing is silently dropped', () => {
  for (const s of Object.values(SYMBOL_BY_KEY)) {
    if (s.kind !== 'line' || s.chrome) continue;
    assert.ok(STYLE[s.key], `${s.key} is a drawable line with no stroke style — it would vanish`);
  }
});

test('a trail and a land boundary become vectors on a sheet, exactly as a road does', () => {
  const feature = (symbolKey) => ({ id: symbolKey, symbolKey, paths: [across()] });
  for (const key of ['trail-nst', 'trail-nonmotor', 'land-game', 'land-park', 'land-managed']) {
    const { vectors, symbolKeys, dropped } = vectorsForSheet([feature(key)], sheet, { zone: 17, hemisphere: 'N', dpi: 300 });
    assert.equal(dropped, 0, `${key} was dropped`);
    assert.ok(vectors.length > 0, `${key} produced no vector`);
    assert.equal(vectors[0].key, key, `${key} was restyled as something else`);
    assert.ok(symbolKeys.has(key), `${key} would not appear on the legend`);
    assert.equal(vectors[0].color, SYMBOL_BY_KEY[key].color, `${key}: the sheet and the key disagree on ink`);
  }
});

// A feature carrying its own symbolKey must keep it. symbolForFeature answers the
// MVUM road/trail question, and asking it about a boundary returns a ROAD.
test("a feature's own symbolKey wins over the MVUM road/trail guess", () => {
  const { vectors } = vectorsForSheet([{ id: 'x', symbolKey: 'land-game', layer: 'road', seasonal: 'yearlong', paths: [across()] }],
    sheet, { zone: 17, hemisphere: 'N', dpi: 300 });
  assert.equal(vectors[0].key, 'land-game', 'the boundary was drawn as a road');
});

test('an unknown symbol key is dropped and counted, never drawn in some default ink', () => {
  const { vectors, dropped } = vectorsForSheet([{ id: 'x', symbolKey: 'not-a-symbol', paths: [across()] }],
    sheet, { zone: 17, hemisphere: 'N', dpi: 300 });
  assert.equal(vectors.length, 0);
  assert.equal(dropped, 1);
});

// The print path, read from build.js itself: these are the seams that were missing.
test('build.js hands the extra layers to the vector path and the PDF', () => {
  assert.match(BUILD, /adapters\.trails/, 'trails never reach the build');
  assert.match(BUILD, /adapters\.land/, 'land boundaries never reach the build');
  assert.match(BUILD, /adapters\.sites/, 'rec sites never reach the build');
  assert.match(BUILD, /createPdfImpl\(\{[^}]*trips/, 'the trip page is never passed to the PDF');
  assert.match(BUILD, /createPdfImpl\(\{[^}]*aerials/, 'aerial sheets are never passed to the PDF');
  assert.match(BUILD, /sites,/, 'a sheet carries no sites, so layoutSites has nothing to place');
});

test('a drawn site earns its legend entry, or the reader gets a marker with no key', () => {
  assert.match(BUILD, /for \(const site of sites\) if \(site\.symbolKey\) drawnKeys\.add/,
    'site symbols must join drawnKeys, or the legend omits what the sheet shows');
});

// A state layer row must know which states the AREA is in, or the map offers every
// state's layers everywhere and the fetches come back empty with no explanation.
// This used to read the page's own path, because there was a page per state.
test('main.js builds the layer controls from the states the drawn area covers', () => {
  // `[^)]*` cannot cross the ) in layersFromControls(); match the argument instead.
  assert.match(MAIN, /layerControlSpecs\(.*state\.areaStates\)/,
    'the controls are built without the area states, so a state row is offered everywhere');
  assert.match(MAIN, /statesForCells\(/, 'main.js never works out which states the area is in');
  assert.match(MAIN, /statesWithFamily\(state\.areaStates/, 'the land fetch does not follow the area');
  assert.ok(!/PAGE_STATE|qcm-state-band/.test(MAIN),
    'the per-state page is gone; nothing may still read a state off the page');
});

// A registry field that production code never reads is a promise the product does
// not keep. `render` sat unread on all nine layers for three merged PRs, declaring
// densities and label rules that decided nothing.
test('every field of a layer render block is read by production code', () => {
  const OVERLAY = read('overlay-paths.js'), PREVIEW = read('preview-overlay.js'), REGISTRY = read('layer-registry.js');
  const fields = [...new Set(LAYERS.flatMap((l) => Object.keys(l.render)))];
  assert.deepEqual(fields.sort(), ['dropBelowScale', 'labels'], 'a new render field needs a reader in this list');
  for (const f of fields) {
    assert.ok(OVERLAY.includes(f), `overlay-paths.js never reads render.${f}`);
  }
  assert.ok(REGISTRY.includes('RENDER_BY_SYMBOL'), 'the rules must be keyed by symbol: the drawing code holds no layer id');
  assert.ok(OVERLAY.includes('RENDER_BY_SYMBOL') && PREVIEW.includes('drawsAtScale'),
    'the preview must drop what the sheet drops, or it promises ink the paper will not carry');
  // width is deliberately NOT a render field: legend.js is the one physical table,
  // and the registry's old weightIn copy had already drifted from trail-nst. The
  // deepEqual above is what keeps it from coming back.
});

// The print path honours a feature's own symbolKey; the preview did not, so a
// state park boundary previewed as a dotted forest ROAD and printed as a blue
// boundary. Parity is the invariant, and colour is most of it.
test('the preview resolves a symbol the same way the sheet does', async () => {
  const { previewPolylines } = await import('../../themes/headlessmode/static/js/quiet-corners-maps/preview-overlay.js');
  const path = [across()];
  for (const key of [...Object.values(FAMILY_SYMBOL), 'trail-nst', 'trail-nonmotor']) {
    const [drawn] = previewPolylines([{ id: 'x', symbolKey: key, paths: path }], { scale: 24000 });
    assert.equal(drawn.key, key, `preview drew ${key} as ${drawn.key}`);
    // The colour the SCREEN draws: the table's screen variant where one is declared
    // (every land family has one, each its own hue), else the paper colour. Either
    // way it is the table's answer for THIS key, so a wrong symbol still shows here.
    const symbol = SYMBOL_BY_KEY[key];
    assert.equal(drawn.color, symbol.screen?.color ?? symbol.color, `${key} previewed in the wrong colour`);
  }
  // and an MVUM feature, which carries no symbolKey, still resolves by season
  const [road] = previewPolylines([{ id: '1', layer: 'road', seasonal: 'yearlong', paths: path }], { scale: 24000 });
  assert.equal(road.key, 'mvum-road-yearlong');
});
