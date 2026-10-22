import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SYMBOLS, SYMBOL_BY_KEY, DISCLAIMER, LAND_COVERAGE_SEMANTICS, PARCEL_SEMANTICS, DASH_IN, dashPt, dashPx, widthPt, widthPx, swatchSpec, symbolForFeature, deriveLegend }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/legend.js';
import { PATTERNS } from '../../themes/headlessmode/static/js/quiet-corners-maps/render-protocol.js';
import { STYLE } from '../../themes/headlessmode/static/js/quiet-corners-maps/overlay-paths.js';
import { layoutMarkup } from './helpers/layouts.mjs';

test('symbolForFeature maps the six road/trail season cases', () => {
  assert.equal(symbolForFeature({ layer: 'road', seasonal: 'yearlong' }), SYMBOLS.roadYearlong);
  assert.equal(symbolForFeature({ layer: 'road', seasonal: 'seasonal' }), SYMBOLS.roadSeasonal);
  assert.equal(symbolForFeature({ layer: 'road', seasonal: null }), SYMBOLS.roadUnknown);
  assert.equal(symbolForFeature({ layer: 'trail', seasonal: 'yearlong' }), SYMBOLS.trailYearlong);
  assert.equal(symbolForFeature({ layer: 'trail', seasonal: 'seasonal' }), SYMBOLS.trailSeasonal);
  assert.equal(symbolForFeature({ layer: 'trail', seasonal: undefined }), SYMBOLS.trailUnknown);
  assert.equal(SYMBOLS.roadSeasonal.key, 'mvum-road-seasonal');
  // Widths are physical now: a trail is 3 px at 300 dpi, which is 0.01 in, which is 0.72 pt.
  assert.equal(SYMBOLS.trailSeasonal.widthIn, 3 / 300);
  assert.equal(widthPt(SYMBOLS.trailSeasonal.widthIn), 0.72);
});

test('deriveLegend: basemap only gives one entry and no notice', () => {
  const l = deriveLegend({ renderedSymbolKeys: ['usgs-topo'], gridEnabled: false, basemapRendered: true });
  assert.deepEqual(l, { entries: [SYMBOLS.basemap], notices: [], seasonalRoutes: [], pages: 1 });
});

test('deriveLegend: mvum entries come in fixed order with the disclaimer; unknown keys ignored; grid only when enabled', () => {
  const keys = new Set(['mvum-road-seasonal', 'bogus', 'mvum-road-yearlong', 'overlap-ticks']);
  const l = deriveLegend({ renderedSymbolKeys: keys, gridEnabled: true, basemapRendered: true });
  assert.deepEqual(l.entries.map((e) => e.key),
    ['usgs-topo', 'mvum-road-yearlong', 'mvum-road-seasonal', 'utm-grid', 'overlap-ticks']);
  assert.deepEqual(l.notices, [DISCLAIMER]);
  const noGrid = deriveLegend({ renderedSymbolKeys: keys, gridEnabled: false, basemapRendered: false });
  assert.deepEqual(noGrid.entries.map((e) => e.key), ['mvum-road-yearlong', 'mvum-road-seasonal', 'overlap-ticks']);
});

// The unit lock. Three renderers used to hold three dash tables in three units and
// they drifted: the printed key showed a dash twice as long as the map it described.
// These assert the tables are now one table, so a future edit cannot re-split them.
test('a dash is the same physical length in points and in pixels', () => {
  for (const pattern of Object.keys(DASH_IN)) {
    const pt = dashPt(pattern), px = dashPx(pattern, 300);
    assert.equal(pt.length, px.length, `${pattern} differs in segment count`);
    pt.forEach((v, i) => assert.ok(Math.abs(v / 72 - px[i] / 300) < 1e-9,
      `${pattern}[${i}]: ${v}pt is ${v / 72}in but ${px[i]}px@300 is ${px[i] / 300}in`));
  }
});

test('the map, the worker and the printed key all read the same table', () => {
  // render-protocol's PATTERNS is what the worker strokes the map with.
  // Derived from DASH_IN, so this asserts the DERIVATION, not a copy of the list:
  // a hardcoded set here would fail the moment a symbol legitimately added a pattern,
  // which is the opposite of what a shared table is for.
  assert.deepEqual(Object.keys(PATTERNS).sort(), Object.keys(DASH_IN).sort());
  assert.deepEqual(PATTERNS.dash, [12, 6]);
  assert.deepEqual(PATTERNS.boundary, [24, 8], 'the boundary dash reaches the worker');
  for (const pattern of Object.keys(DASH_IN)) assert.deepEqual(PATTERNS[pattern], dashPx(pattern, 300));
  // overlay-paths' STYLE is what the page hands the worker per feature.
  for (const [key, style] of Object.entries(STYLE)) {
    const symbol = SYMBOL_BY_KEY[key];
    assert.ok(symbol, `STYLE has ${key}, SYMBOLS does not`);
    assert.equal(style.pattern, symbol.pattern);
    assert.equal(style.color, symbol.color);
    assert.equal(style.widthPx, widthPx(symbol.widthIn, 300));
    // ...and the swatch on the printed key is the same ink at the same width.
    const spec = swatchSpec(symbol);
    assert.equal(spec.color, style.color);
    assert.ok(Math.abs(spec.widthPt / 72 - style.widthPx / 300) < 1e-9, `${key}: key and map widths differ`);
  }
  // Every LINE symbol reaches the map, not just the mvum- ones: a prefix filter here
  // is what kept trails and land boundaries off the sheet. Derived, so adding a
  // symbol to the table does not break this.
  const lineSymbols = Object.values(SYMBOL_BY_KEY).filter((s) => s.kind === 'line' && !s.chrome);
  assert.deepEqual(Object.keys(STYLE).sort(), lineSymbols.map((s) => s.key).sort());
  assert.ok(Object.keys(STYLE).includes('trail-nst'), 'a trail must be strokeable');
  assert.ok(Object.keys(STYLE).includes('land-game'), 'a land boundary must be strokeable');
});

test('swatchSpec classifies every symbol kind, including the tick entry', () => {
  assert.equal(swatchSpec(SYMBOLS.basemap).kind, 'raster');
  assert.equal(swatchSpec(SYMBOLS.overlapTicks).kind, 'tick');
  assert.equal(swatchSpec(SYMBOLS.roadSeasonal).kind, 'line');
  // The tick entry used to fall through to the line branch with an undefined width.
  assert.ok(swatchSpec(SYMBOLS.overlapTicks).widthPt > 0, 'a swatch always has a real width');
  assert.deepEqual(swatchSpec(SYMBOLS.roadSeasonal).dashIn, DASH_IN.dash);
});

// The notice a drawn boundary obliges. It existed as an exported constant with a
// test, and no page and no PDF ever printed it: the map drew designation lines
// with no word about what they do and do not permit.
test('a drawn land boundary brings the access notice onto the key', () => {
  const l = deriveLegend({ renderedSymbolKeys: ['land-park'], gridEnabled: false, basemapRendered: true });
  assert.deepEqual(l.notices, [LAND_COVERAGE_SEMANTICS]);
  assert.match(l.notices[0], /not a statement that the ground/);

  // Both families of notice, in symbol order, when both were drawn.
  const both = deriveLegend({ renderedSymbolKeys: ['mvum-road-yearlong', 'land-game'], gridEnabled: false, basemapRendered: true });
  assert.deepEqual(both.notices, [DISCLAIMER, LAND_COVERAGE_SEMANTICS]);

  // Every land symbol obliges it, not just the one that happened to be listed.
  for (const key of Object.values(SYMBOL_BY_KEY).filter((s) => s.key.startsWith('land-')).map((s) => s.key)) {
    const one = deriveLegend({ renderedSymbolKeys: [key], gridEnabled: false, basemapRendered: true });
    assert.ok(one.notices.includes(LAND_COVERAGE_SEMANTICS), `${key} printed no access notice`);
  }
});

test('the access notice reaches the reader off paper too', () => {
  const page = layoutMarkup();
  const body = readFileSync(new URL('../../content/quiet-corners-maps.md', import.meta.url), 'utf8');
  // A state page shares the layout and supplies no .Content, so the caveat cannot
  // live in the prose alone — it would be absent from all 51 pages that offer the
  // layers it is about.
  assert.match(page, /designation begins and ends/, 'the state pages carry it in the layout');
  assert.match(body, /not a statement that the ground inside is open to you/, 'the federal page carries it in the body');
});

// --- parcels get their OWN notice, not the public-land one -------------------
// The three state land families share `land-` and the access notice that comes with
// it. A parcel is mostly PRIVATE property: "not a statement that the ground inside is
// open to the public" answers a question nobody asked about it, while leaving the two
// that matter unsaid -- a recorded line is not a surveyed line, and it is not
// permission. Keying the symbol `land-parcel` would have silently attached the wrong
// one, which is why it is `parcel-line`.
test('a parcel boundary obliges the parcel notice and not the public-land notice', () => {
  const only = deriveLegend({ renderedSymbolKeys: ['parcel-line'], gridEnabled: false, basemapRendered: false });
  assert.deepEqual(only.notices, [PARCEL_SEMANTICS]);
  assert.ok(!only.notices.includes(LAND_COVERAGE_SEMANTICS), 'a parcel is not public land');

  // Drawn together, both notices print, each once.
  const both = deriveLegend({ renderedSymbolKeys: ['parcel-line', 'land-game'], gridEnabled: false, basemapRendered: false });
  assert.equal(both.notices.length, 2);
  assert.ok(both.notices.includes(PARCEL_SEMANTICS) && both.notices.includes(LAND_COVERAGE_SEMANTICS));
});

test('the parcel notice says the three things a parcel line is not', () => {
  for (const claim of [/not a survey/i, /not permission to enter/i, /coverage varies county by county/i]) {
    assert.match(PARCEL_SEMANTICS, claim);
  }
});

test('a parcel line is not drawn in the public-land colour, and not at 1:48,000', async () => {
  const { SYMBOL_BY_KEY: table } = await import('../../themes/headlessmode/static/js/quiet-corners-maps/legend.js');
  const { RENDER_BY_SYMBOL } = await import('../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js');
  const { drawsAtScale } = await import('../../themes/headlessmode/static/js/quiet-corners-maps/overlay-paths.js');
  assert.notEqual(table['parcel-line'].color, table['land-game'].color, 'the land hue would say "you may walk here"');
  assert.equal(RENDER_BY_SYMBOL['parcel-line'].dropBelowScale, 24000);
  assert.equal(drawsAtScale('parcel-line', 24000), true);
  // At 1:48,000 one sheet holds four times the ground; 26,863 parcels become solid ink.
  assert.equal(drawsAtScale('parcel-line', 48000), false);
});

// The key said "dates on sheet when supplied" for months and no module ever wrote
// one. This is where the dates reach the paper.
test('deriveLegend: the seasonal open dates go on the key, under a heading', () => {
  const keys = ['mvum-road-seasonal', 'mvum-road-yearlong'];
  const l = deriveLegend({ renderedSymbolKeys: keys, gridEnabled: false, basemapRendered: false,
    seasonalWindows: { lines: ['FR 71: Apr 1 - Dec 15'], undated: 2 } });
  assert.deepEqual(l.seasonalRoutes,
    ['FR 71: Apr 1 - Dec 15', '2 more seasonal routes here: the source gave no dates for them.']);

  // Listing only the dated routes would read as "these are the seasonal roads
  // here", and a reader would drive an unlisted one in February on that.
  const allDated = deriveLegend({ renderedSymbolKeys: keys, gridEnabled: false, basemapRendered: false,
    seasonalWindows: { lines: ['FR 71: Apr 1 - Dec 15'], undated: 0 } });
  assert.deepEqual(allDated.seasonalRoutes, ['FR 71: Apr 1 - Dec 15']);
  assert.equal(deriveLegend({ renderedSymbolKeys: keys, gridEnabled: false, basemapRendered: false,
    seasonalWindows: { lines: [], undated: 1 } }).seasonalRoutes[0],
  '1 more seasonal route here: the source gave no dates for it.');

  // No seasonal symbol on the sheet, no section — a heading over an empty list
  // reads as "none are seasonal", which is a different claim entirely.
  assert.deepEqual(deriveLegend({ renderedSymbolKeys: ['mvum-road-yearlong'], gridEnabled: false,
    basemapRendered: false, seasonalWindows: { lines: ['FR 71: Apr 1 - Dec 15'], undated: 0 } }).seasonalRoutes, []);
  assert.deepEqual(deriveLegend({ renderedSymbolKeys: keys, gridEnabled: false, basemapRendered: false }).seasonalRoutes, []);
});

// The seven land-boundary families printed in one blue, and previewed in that same
// blue at hairline width over a raster whose water is blue too: a reader could not
// find a state park on the screen, let alone tell it from a refuge. The table now
// carries a SCREEN variant per family. Paper is untouched -- the halftone argument
// for one blue is about paper.
test('on screen each land boundary family is its own colour and an area; on paper all stay one blue', () => {
  const families = ['fed-wilderness', 'fed-park', 'fed-refuge', 'fed-forest', 'land-game', 'land-park', 'land-managed'];
  const screen = families.map((k) => SYMBOL_BY_KEY[k].screen);
  for (const [i, k] of families.entries()) assert.equal(screen[i]?.fill, true, `${k} is an area on screen, not a stray line`);
  const colours = screen.map((s) => s.color);
  assert.equal(new Set(colours).size, families.length, 'every family gets its own hue');
  const spent = Object.values(SYMBOL_BY_KEY).filter((s) => !families.includes(s.key))
    .flatMap((s) => [s.color, s.screen?.color]).filter(Boolean);
  for (const c of colours) assert.ok(!spent.includes(c), `${c} is already spent on another symbol`);
  for (const k of ['fed-park', 'land-park']) {
    assert.equal(swatchSpec(SYMBOL_BY_KEY[k]).color, '#1a4f8a', `${k}: the printed key keeps the paper blue`);
    assert.equal(STYLE[k].color, '#1a4f8a', `${k}: the worker strokes the sheet in the paper blue`);
  }
});
