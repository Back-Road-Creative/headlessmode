// The on-page key, checked against the same table pdf.js prints from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { legendSwatchSvg, plannedLegendKeys, legendRows } from '../../themes/headlessmode/static/js/quiet-corners-maps/legend-view.js';
import { markerPath } from '../../themes/headlessmode/static/js/quiet-corners-maps/pdf.js';
import { SYMBOLS, DASH_IN, swatchSpec } from '../../themes/headlessmode/static/js/quiet-corners-maps/legend.js';
import { layoutMarkup } from './helpers/layouts.mjs';
import { LAYERS, enabledLayers, layerControlSpecs } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';

const attr = (svg, name) => (svg.match(new RegExp(`${name}="([^"]*)"`)) || [])[1];

test('a swatch carries a dash array exactly when its symbol has one', () => {
  assert.equal(attr(legendSwatchSvg(SYMBOLS.roadYearlong), 'stroke-dasharray'), undefined, 'solid must not be dashed');
  assert.ok(attr(legendSwatchSvg(SYMBOLS.roadSeasonal), 'stroke-dasharray'), 'dash must be dashed');
  assert.ok(attr(legendSwatchSvg(SYMBOLS.roadUnknown), 'stroke-dasharray'), 'dot must be dashed');
});

test('the swatch preserves the ratios a reader compares', () => {
  // One magnification scalar, so dash:gap and road:trail survive it. Assert the
  // ratios, never the absolute pixels -- the zoom is a display choice.
  const dashed = legendSwatchSvg(SYMBOLS.roadSeasonal);
  const [on, off] = attr(dashed, 'stroke-dasharray').split(' ').map(Number);
  assert.ok(Math.abs(on / off - DASH_IN.dash[0] / DASH_IN.dash[1]) < 1e-6, 'dash:gap ratio must survive the zoom');

  const road = Number(attr(legendSwatchSvg(SYMBOLS.roadSeasonal), 'stroke-width'));
  const trail = Number(attr(legendSwatchSvg(SYMBOLS.trailSeasonal), 'stroke-width'));
  assert.ok(Math.abs(road / trail - SYMBOLS.roadSeasonal.widthIn / SYMBOLS.trailSeasonal.widthIn) < 1e-6, 'road:trail width ratio must survive');
});

test('the swatch strokes the same colour pdf.js prints', () => {
  for (const s of [SYMBOLS.roadYearlong, SYMBOLS.trailUnknown, SYMBOLS.utmGrid]) {
    assert.equal(attr(legendSwatchSvg(s), 'stroke'), swatchSpec(s).color, `${s.key} colour drifted from the printed key`);
  }
});

test('raster and tick symbols get their own swatch, not a line', () => {
  assert.ok(!legendSwatchSvg(SYMBOLS.basemap).includes('<line'), 'the basemap swatch is a block, not a rule');
  assert.ok(legendSwatchSvg(SYMBOLS.overlapTicks).includes('fill-opacity'), 'the overlap swatch is a band with ticks');
});

test('a swatch interpolates no free text — labels never enter the markup', () => {
  const hostile = { key: 'x', kind: 'line', pattern: 'solid', widthIn: 0.01, color: '#000000', label: '"><script>alert(1)</script>' };
  const svg = legendSwatchSvg(hostile);
  assert.ok(!svg.includes('script'), 'labels must reach the DOM as textContent, never as markup');
});

test('plannedLegendKeys follows the layer and grid choices', () => {
  const base = plannedLegendKeys({ layers: { usgsTopo: true }, grid: 'none' });
  assert.ok(base.includes('usgs-topo'));
  assert.ok(!base.some((k) => k.startsWith('mvum-')), 'MVUM off means no MVUM keys');
  assert.ok(!base.includes('utm-grid'), 'grid none means no grid key');
  const full = plannedLegendKeys({ layers: { mvum: true }, grid: 'utm-1km' });
  assert.equal(full.filter((k) => k.startsWith('mvum-')).length, 6);
  assert.ok(full.includes('utm-grid'));
});

test('before a source check nothing is claimed absent; after one, the key shrinks', () => {
  const before = legendRows({ layers: { mvum: true }, grid: 'utm-1km' });
  assert.ok(before.every((r) => r.state === 'planned'), 'an unchecked area asserts nothing about coverage');

  const after = legendRows({ layers: { mvum: true }, grid: 'utm-1km', rendered: ['mvum-road-yearlong'] });
  const byKey = Object.fromEntries(after.map((r) => [r.key, r.state]));
  assert.equal(byKey['mvum-road-yearlong'], 'present');
  assert.equal(byKey['mvum-trail-seasonal'], 'absent');
  // The basemap, grid and overlap ticks are drawn by this app, not fetched, so a
  // source check can never rule them out.
  assert.equal(byKey['usgs-topo'], 'planned');
  assert.equal(byKey['utm-grid'], 'planned');
  assert.equal(byKey['overlap-ticks'], 'planned');
});

test('the page has the key element main.js fills, and fills it safely', () => {
  const page = layoutMarkup();
  const main = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
  assert.ok(page.includes('id="qcm-legend"'), 'the page has no #qcm-legend');
  assert.ok(main.includes("legendRows("), 'main.js must build rows from legend-view, not restate the symbols');
  assert.ok(main.includes('.textContent = row.text'), 'the label must be set as text, never as markup');
});

// F09: with every layer switched on, the key listed the base map, six MVUM
// classes and the sheet furniture — and nothing else. Sixteen symbols the map
// draws (trails, recreation points, federal, state and county boundaries,
// parcels) had no entry, so a reader could see a mark and not look it up.
const ALL_ON = Object.fromEntries(LAYERS.map((l) => [l.id, true]));
const NC = ['NC'];

test('the key plans every symbol its enabled layers can draw', () => {
  const keys = new Set(plannedLegendKeys({ layers: ALL_ON, grid: 'utm-1km', states: NC }));
  for (const layer of enabledLayers(ALL_ON, NC)) {
    for (const k of layer.symbolKeys) {
      assert.ok(keys.has(k), `${layer.id} draws ${k}, and the key never mentions it`);
    }
  }
  // An extra SHEET adds no ink to the map, so it earns no row on the map key.
  assert.ok(!keys.has('naip-aerial'), 'an extra page is not a map symbol');
});

test('a layer switched off keeps its symbols out of the key', () => {
  const keys = plannedLegendKeys({ layers: { usgsTopo: true }, grid: 'none', states: NC });
  assert.ok(!keys.includes('trail-nst'), 'trails off means no trail keys');
  assert.ok(!keys.includes('land-game'), 'state land off means no state land keys');
});

test('the key tells "not in the returned data" from "the source did not say"', () => {
  const rows = legendRows({
    layers: ALL_ON,
    grid: 'none',
    states: NC,
    rendered: ['trail-nst'],
    layerStates: {
      usgsTopo: 'ready', mvum: 'ready', trails: 'ready', federalLand: 'ready',
      countyLines: 'ready', recSites: 'unavailable', gameLands: 'unchecked',
      stateParks: 'unchecked', managedAreas: 'unchecked', parcels: 'unchecked',
    },
  });
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.state]));
  assert.equal(byKey['trail-nst'], 'present', 'the source returned one');
  assert.equal(byKey['trail-nonmotor'], 'absent', 'the source answered and had none of these');
  assert.equal(byKey['fed-park'], 'absent', 'an empty federal answer really means none here');
  // emptyMeans 'ambiguous': every acre is in a county, so nothing back is the
  // service failing to say, never "this ground has no county".
  assert.equal(byKey['county-line'], 'unknown', 'an ambiguous empty answer claims nothing');
  assert.equal(byKey['rec-campground'], 'unknown', 'a source that never answered rules nothing out');
  assert.equal(byKey['land-game'], 'planned', 'an unchecked layer asserts nothing');
});

test('each state says in words what it means, and absent is not unknown', () => {
  const row = (key, opts) => legendRows(opts).find((r) => r.key === key);
  const checked = { layers: ALL_ON, grid: 'none', states: NC, rendered: [] };
  const absent = row('fed-park', { ...checked, layerStates: { federalLand: 'ready' } });
  const unknown = row('fed-park', { ...checked, layerStates: { federalLand: 'unavailable' } });
  assert.match(absent.text, /not in the returned data/i);
  assert.match(unknown.text, /did not/i);
  assert.notEqual(absent.text, unknown.text, 'nothing returned must not read as nothing there');
  assert.ok(row('usgs-topo', { ...checked, layerStates: { usgsTopo: 'ready' } }).text === SYMBOLS.basemap.label,
    'a symbol this app draws itself carries no qualifier');
});

// A point symbol fell through to the line branch, so the key drew a short
// horizontal stroke for Campground, Shelter, Trailhead and Other site — four
// rows, four different shapes on paper, one identical line on screen. Part of
// audit F10: one shape definition, drawn by the sheet, the map and the key.
test('the key draws a point symbol as its shape, not as a line', () => {
  const points = Object.values(SYMBOLS).filter((s) => s.kind === 'point');
  assert.ok(points.length >= 4, `only ${points.length} point symbols — the table has moved`);
  for (const s of points) {
    const swatch = legendSwatchSvg(s);
    assert.ok(!swatch.includes('<line'), `${s.key} is drawn as a line`);
    if (s.marker === 'dot') { assert.ok(swatch.includes('<circle'), 'a dot is a circle'); continue; }
    assert.ok(swatch.includes('<polygon'), `${s.key} (${s.marker}) has no outline`);
  }
});

test('the key and the sheet trace the same outline', () => {
  const swatch = legendSwatchSvg(SYMBOLS.recShelter);
  const pts = /points="([^"]*)"/.exec(swatch)[1].split(' ').map((p) => p.split(',').map(Number));
  // Recover the box the key drew in, then demand the sheet's own path for it: a
  // shape that merely LOOKS like a lean-to is how the two drift apart again.
  const [x0, y0] = pts[0];
  const h = y0 - pts[2][1] === 0 ? 0 : (pts[2][1] - y0) / -2;
  const cx = x0 + h, cy = y0 - h;
  const want = markerPath('house', cx, cy, h * 2).map(([x, y]) => `${+x.toFixed(2)},${+y.toFixed(2)}`).join(' ');
  assert.equal(pts.map(([x, y]) => `${x},${y}`).join(' '), want);
  assert.ok(h * 2 <= 14, 'the symbol must fit the 14px swatch row');
});

// A11: the key on the screen described the printed sheet. It listed the UTM grid
// and the sheet-overlap marks — furniture that exists only on paper — and named
// the topographic base map at a national zoom where no topo tile is drawn at all.
// The screen key is now its own medium: paper-only symbols are dropped, anything
// that needs a closer zoom says so, and what is drawn right now is listed first.
const NATIONAL = { medium: 'screen', zoom: 4, screenScale: 2000000 };
const FIELD = { medium: 'screen', zoom: 14, screenScale: 18000 };

test('the screen key carries no paper-only symbol, and the paper key keeps them', () => {
  const screen = legendRows({ layers: ALL_ON, grid: 'utm-1km', states: NC, ...FIELD }).map((r) => r.key);
  assert.ok(!screen.includes('utm-grid'), 'the UTM grid is drawn on paper, never on the screen map');
  assert.ok(!screen.includes('overlap-ticks'), 'sheet overlap marks belong to the printed set');
  const paper = legendRows({ layers: ALL_ON, grid: 'utm-1km', states: NC }).map((r) => r.key);
  assert.ok(paper.includes('utm-grid'), 'a reader holding a sheet still has to look the grid up');
  assert.ok(paper.includes('overlap-ticks'), 'a reader holding a sheet still has to look the ticks up');
});

test('the screen key says which symbols only appear when you zoom in', () => {
  // Q-base (A1): the base tile layer is on the map at every zoom now, so the key
  // never has to hold the base row back the way it still holds parcels back.
  const rows = legendRows({ layers: ALL_ON, grid: 'none', states: NC, ...NATIONAL });
  const at = (k) => rows.find((r) => r.key === k);
  assert.equal(at('usgs-topo').state, 'planned', 'the base is drawn at the national zoom too');
  assert.equal(at('parcel-line').state, 'zoom', 'parcels are drawn at 1:24,000 or finer');

  const field = legendRows({ layers: ALL_ON, grid: 'none', states: NC, ...FIELD });
  assert.equal(field.find((r) => r.key === 'usgs-topo').state, 'planned');
  assert.equal(field.find((r) => r.key === 'parcel-line').state, 'planned');
});

test('the screen key names the base the reader chose; the paper key always says topo', () => {
  const row = (opts) => legendRows({ layers: ALL_ON, grid: 'none', states: NC, ...opts }).find((r) => r.key === 'usgs-topo');
  assert.equal(row({ ...FIELD }).text, SYMBOLS.basemap.label, 'untouched, the screen key reads as today');
  assert.match(row({ ...FIELD, base: 'usgsImagery' }).text, /Aerial imagery/);
  assert.match(row({ ...FIELD, base: 'usgsShadedRelief' }).text, /Shaded relief/);
  assert.equal(row({ ...FIELD, base: 'none' }), undefined, 'no base map, no base row');
  assert.equal(row({ base: 'usgsImagery' }).text, SYMBOLS.basemap.label, 'paper prints topo whatever the screen shows');
  assert.equal(row({ base: 'none' }).text, SYMBOLS.basemap.label);
});

// N3: the names row opens ON, so on every fresh load the screen key listed all nine
// GNIS kinds as "appears when you zoom in" -- 212px of rows for lettering the map had
// not drawn, while the paper key (build.test.mjs) lists exactly the kinds drawn. The
// screen key now holds a fetched lettering kind back until the map has really drawn it.
test('the screen key lists a lettering kind only once the map has drawn it', () => {
  const nameKeys = (rows) => rows.filter((r) => r.key.startsWith('name-')).map((r) => r.key);
  const fresh = legendRows({ layers: ALL_ON, grid: 'none', states: NC, ...FIELD });
  assert.deepEqual(nameKeys(fresh), [], 'nothing fetched yet, so no name kind is listed on screen');
  const drawn = legendRows({ layers: ALL_ON, grid: 'none', states: NC, ...FIELD, rendered: ['name-summit', 'mvum-road'], layerStates: { names: 'ready' } });
  assert.deepEqual(nameKeys(drawn), ['name-summit'], 'exactly the kinds drawn, no more');
  assert.equal(drawn.find((r) => r.key === 'name-summit').state, 'present');
  const national = legendRows({ layers: ALL_ON, grid: 'none', states: NC, ...NATIONAL, rendered: ['name-place'], layerStates: { names: 'ready' } });
  assert.deepEqual(nameKeys(national), ['name-place'], 'a drawn kind is listed whatever the zoom says');
  const paper = legendRows({ layers: ALL_ON, grid: 'none', states: NC });
  assert.ok(nameKeys(paper).length >= 9, 'the paper key still plans every kind the sheet could carry');
});

test('the screen key leads with what is drawn right now', () => {
  const rows = legendRows({ layers: ALL_ON, grid: 'none', states: NC, ...NATIONAL });
  const first = rows.findIndex((r) => r.state === 'zoom');
  assert.ok(first > 0, 'something is drawn at this zoom, and it must come first');
  assert.ok(rows.slice(first).every((r) => r.state === 'zoom'),
    'a symbol that only appears when zoomed in must not be listed above one drawn now');
});

test('the base symbol never reports a zoom gate, at any zoom the map supports', () => {
  // Q-base (A1) removed the base tile layer's zoom floor: quiet-corners.js no
  // longer gates syncBase on FIELD_MIN_ZOOM, so the key must never tell a reader
  // to zoom in for a base that is already on the map.
  for (const zoom of [0, 4, 9, 13, 16]) {
    const rows = legendRows({ layers: ALL_ON, grid: 'none', states: NC, medium: 'screen', zoom, screenScale: 2000000 });
    const row = rows.find((r) => r.key === 'usgs-topo');
    assert.notEqual(row.state, 'zoom', `usgs-topo reported 'zoom' at zoom ${zoom}`);
  }
});

test('the base-map switch carries no coverage caveat now the base draws at every zoom', () => {
  const base = layerControlSpecs({}).find((s) => s.id === 'usgsTopo');
  assert.equal(base.note, null, 'there is no gap left for a coverage caveat to describe');
  assert.equal(base.noteId, null);
});

test('the map key panel describes the screen it sits on, not the sheet', () => {
  const page = layoutMarkup();
  assert.ok(!page.includes('What each line means on the printed sheet'),
    'the live key is a key to the map on the screen; the paper key is the Print panel’s');
});

test('main.js asks legend-view for the SCREEN key, at the zoom the map is at', () => {
  const main = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
  const fn = main.slice(main.indexOf('function renderLegend'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /medium:\s*'screen'/, 'the on-page key must be built as a screen key');
  assert.match(body, /zoom:\s*map\.getZoom\(\)/, 'the zoom qualifier needs the map’s current zoom');
  assert.match(body, /screenScale:/, 'the density gate needs the scale a screen pixel covers');
  assert.match(main, /map\.on\('zoomend', renderLegend\)/,
    'a key that names the zoom has to be rebuilt when the zoom changes');
});

// The key beside the map has to show the colour the map draws, or it is a key to a
// different map. The paper key keeps the paper blue; it describes the sheet.
test('the screen swatch for a land boundary carries the screen colour and a fill; the paper swatch does not', () => {
  const s = SYMBOLS.landPark;
  const screen = legendSwatchSvg(s, { medium: 'screen' });
  assert.equal(attr(screen, 'stroke'), s.screen.color, 'the screen swatch strokes the screen hue');
  assert.ok(screen.includes('<rect') && screen.includes(`fill="${s.screen.color}"`), 'an area symbol shows a filled block behind its line');
  const paper = legendSwatchSvg(s);
  assert.equal(attr(paper, 'stroke'), swatchSpec(s).color, 'the paper swatch strokes the paper blue');
  assert.ok(!paper.includes(s.screen.color) && !paper.includes('<rect'), 'paper is unchanged');
  const row = legendRows({ layers: ALL_ON, states: NC, ...FIELD }).find((r) => r.key === s.key);
  assert.ok(row.svg.includes(s.screen.color), 'the on-page key is built as a screen key');
});

// QQA-05r-3: the Road names row has a key symbol of its own: an amber-on-dark "Road name"
// sample, on the screen key only (a printed sheet carries the base map's own lettering).
test('the screen key shows an amber-on-dark Road name sample when the roads layer is on', () => {
  assert.deepEqual(LAYERS.find((l) => l.id === 'roads').symbolKeys, [SYMBOLS.roadName.key]);
  const rows = legendRows({ layers: { roads: true }, grid: 'none', medium: 'screen', zoom: 13, screenScale: 24000 });
  const row = rows.find((r) => r.key === SYMBOLS.roadName.key);
  assert.ok(row, 'the key has a Road name row');
  assert.equal(row.text, 'Road name');
  assert.equal(row.state, 'planned', 'drawn by the app, so no source check can rule it out');
  assert.match(row.svg, /fill="#fde68a"/, 'amber text');
  assert.match(row.svg, /<rect[^>]*fill="#0d0d1a"/, 'on the dark plate');
  // Changed on purpose (review): the sample is the short word "Rd" at 12px, so the key row's own
  // text is not doubled by an SVG text node and the sample clears the 12px floor.
  assert.match(row.svg, />Rd</);
  assert.match(row.svg, /font-size="12"/);
  assert.ok(!row.svg.includes('<line'));
  const off = legendRows({ layers: { roads: false }, grid: 'none', medium: 'screen', zoom: 13, screenScale: 24000 });
  assert.ok(!off.some((r) => r.key === SYMBOLS.roadName.key), 'no row once the layer is off');
  const paper = legendRows({ layers: { roads: true }, grid: 'none', medium: 'paper' });
  assert.ok(!paper.some((r) => r.key === SYMBOLS.roadName.key), 'never on the printed key');
});

// Review: the key must not promise a road name where the map draws none (below zoom 10).
test('the Road name row says it appears when you zoom in below the first road zoom', () => {
  const at = (zoom) => legendRows({ layers: { roads: true }, grid: 'none', medium: 'screen', zoom, screenScale: 24000 }).find((r) => r.key === SYMBOLS.roadName.key);
  assert.equal(at(7).state, 'zoom');
  assert.match(at(7).text, /appears when you zoom in/);
  assert.equal(at(10).state, 'planned');
  assert.equal(at(10).text, 'Road name');
});
