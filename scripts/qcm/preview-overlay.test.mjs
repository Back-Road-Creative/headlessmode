// The parity invariant: a layer that prints, previews.
//
// Before this, the Leaflet preview showed topo tiles, the selection rectangle and
// the sheet outlines. MVUM was fetched, handed to the build, and never drawn — so
// the checkbox changed the recipe, the page count, and nothing visible. These
// tests assert the screen and the sheet read the SAME symbol table, so a layer
// cannot reach the paper without reaching the screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { previewPolylines, previewSites, previewStyle, previewSymbolKeys, PREVIEW_BUDGET, screenScaleDenominator } from '../../themes/headlessmode/static/js/quiet-corners-maps/preview-overlay.js';
import { SYMBOLS, SYMBOL_BY_KEY, DASH_IN, symbolForFeature } from '../../themes/headlessmode/static/js/quiet-corners-maps/legend.js';
import { STYLE } from '../../themes/headlessmode/static/js/quiet-corners-maps/overlay-paths.js';
import { markerPath } from '../../themes/headlessmode/static/js/quiet-corners-maps/pdf.js';

const line = (id, layer, seasonal) => ({ id, layer, seasonal, paths: [[[-83.5, 35.0], [-83.45, 35.05], [-83.4, 35.1]]] });
const MVUM = [line('71', 'road', 'seasonal'), line('83', 'road', 'yearlong'), line('T-1', 'trail', 'yearlong')];

test('the preview draws every MVUM feature the sheet would', () => {
  const drawn = previewPolylines(MVUM);
  assert.equal(drawn.length, 3, 'one polyline per feature path');
  assert.deepEqual(previewSymbolKeys(drawn),
    ['mvum-road-seasonal', 'mvum-road-yearlong', 'mvum-trail-yearlong']);
});

// The invariant itself. STYLE is what the print worker strokes with; previewStyle is
// what Leaflet draws with. Both must come from the one physical table in legend.js.
test('every symbol the sheet prints, the screen draws in the same colour', () => {
  for (const key of Object.keys(STYLE)) {
    const preview = previewStyle(key);
    const symbol = SYMBOL_BY_KEY[key];
    assert.ok(preview, `${key} prints but the preview cannot style it`);
    assert.equal(STYLE[key].color, symbol.color, `${key}: the sheet strokes the table's paper colour`);
    // A symbol may name a SCREEN colour in the same table; the preview draws that
    // one and nothing else. Neither medium invents a hue of its own.
    assert.equal(preview.color, symbol.screen?.color ?? symbol.color, `${key}: screen and table disagree on colour`);
  }
});

test('and in the same proportions — a road is to a trail on screen as on paper', () => {
  const ratio = (a, b) => a / b;
  const screenRatio = ratio(previewStyle('mvum-road-yearlong').weight, previewStyle('mvum-trail-yearlong').weight);
  const paperRatio = ratio(SYMBOLS.roadYearlong.widthIn, SYMBOLS.trailYearlong.widthIn);
  assert.ok(Math.abs(screenRatio - paperRatio) < 1e-6, `screen ${screenRatio} vs paper ${paperRatio}`);

  // A screen has no fixed scale, so absolute widths are magnified by one scalar.
  // Assert the ratio, never the pixels — pinning the pixels would make this a
  // change-detector for a display choice.
  const dash = previewStyle('mvum-road-seasonal').dashArray.split(' ').map(Number);
  assert.ok(Math.abs(dash[0] / dash[1] - DASH_IN.dash[0] / DASH_IN.dash[1]) < 1e-6, 'dash:gap ratio must survive');
  assert.equal(previewStyle('mvum-road-yearlong').dashArray, null, 'a solid line carries no dash array');
});

test('Leaflet wants [lat, lon]; the print path stores [lon, lat] — the swap happens once', () => {
  const [first] = previewPolylines([line('71', 'road', 'yearlong')]);
  assert.deepEqual(first.latlngs[0], [35.0, -83.5], 'a swapped pair would put North Carolina in the Indian Ocean');
  assert.equal(first.latlngs.length, 3, 'every vertex survives');
});

test('a width override applies on screen too, and an unknown one falls back', () => {
  const plain = previewStyle('mvum-road-yearlong');
  const known = previewStyle('mvum-road-yearlong', 'mvum-trail-yearlong');  // any narrower symbol
  assert.ok(known.weight < plain.weight, 'an override changes the drawn width');
  assert.equal(previewStyle('mvum-road-yearlong', 'no-such-tier').weight, plain.weight,
    'an unknown override falls back rather than drawing nothing');
  assert.equal(previewStyle('no-such-symbol'), null);
});

test('a feature with no drawable geometry is skipped, not drawn as a point', () => {
  assert.deepEqual(previewPolylines([{ id: 'x', layer: 'road', seasonal: null, paths: [[[-83.5, 35]]] }]), []);
  assert.deepEqual(previewPolylines([{ id: 'y', layer: 'road', seasonal: null }]), []);
  assert.deepEqual(previewPolylines([]), []);
});

test('main.js draws the overlay from the shared module, not its own styling', () => {
  const main = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
  assert.ok(main.includes('previewPolylines('), 'the preview must style from the shared table');
  assert.ok(main.includes('renderOverlay()'), 'and actually call it');
  // A second styling path in main.js is how the printed key drifted from the printed
  // map before #386. There must not be a hand-written colour next to the polyline.
  const fn = main.slice(main.indexOf('function renderOverlay'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(!/#[0-9a-f]{6}/i.test(body), 'renderOverlay must not name a colour of its own');
});

test('symbolForFeature and the preview agree on every road/trail combination', () => {
  for (const layer of ['road', 'trail']) {
    for (const seasonal of ['yearlong', 'seasonal', null]) {
      const f = line('1', layer, seasonal);
      const key = symbolForFeature(f).key;
      assert.equal(previewPolylines([f])[0].key, key, `${layer}/${seasonal} disagrees`);
      assert.ok(SYMBOL_BY_KEY[key], `${key} is not in the symbol table`);
    }
  }
});

// Every module main.js calls must be imported. main.js is DOM code the Node suite
// cannot execute, so a missing import is invisible to every other test here — it
// would reach the browser as "fetchRecSites is not defined" on the source check.
// This is the same class of defect as the worker's unbound PATTERNS (#385).
test('main.js imports every module-level function it calls', () => {
  const main = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
  const imported = new Set([...main.matchAll(/^import \{([^}]*)\} from/gm)]
    .flatMap((m) => m[1].split(',').map((n) => n.trim().split(/\s+as\s+/).pop())));
  const declared = new Set([...main.matchAll(/^(?:async )?function (\w+)|^const (\w+) *=/gm)].flatMap((m) => [m[1], m[2]].filter(Boolean)));
  const CALLED = ['fetchRecSites', 'previewSites', 'previewPolylines', 'fetchLayer', 'runBuild', 'createPdf', 'legendRows'];
  for (const fn of CALLED) {
    if (!main.includes(`${fn}(`)) continue;                       // not used on this branch
    assert.ok(imported.has(fn) || declared.has(fn), `main.js calls ${fn}() but never imports or declares it`);
  }
});

// --- density budget ----------------------------------------------------------
// Delaware answers 26,863 parcels over one test rectangle and Utah 13,320
// (state-sources.json). A sheet renders those offline at its own pace; Leaflet
// holds every polyline as live DOM, and handing it 26,863 shapes does not draw a
// busy map, it stops the tab. A frozen tab is a worse answer than a partial one --
// but only if the partial one SAYS SO, which is what onTruncate is for.
const many = (key, n) => Array.from({ length: n }, (_, i) => (
  { id: `${key}-${i}`, symbolKey: key, paths: [[[-83.5, 35], [-83.4, 35.1]]] }));

test('one symbol cannot put more than its budget of polylines on screen', () => {
  const drawn = previewPolylines(many('land-game', 50), { scale: 24000, budget: 20 });
  assert.equal(drawn.length, 20);
  assert.equal(previewSymbolKeys(drawn).length, 1, 'the surviving polylines are still that symbol');
});

test('the budget is PER SYMBOL, so a dense layer cannot starve a sparse one', () => {
  const drawn = previewPolylines([...many('land-game', 50), ...many('land-park', 3)],
    { scale: 24000, budget: 20 });
  const byKey = (k) => drawn.filter((p) => p.key === k).length;
  assert.equal(byKey('land-game'), 20, 'the dense layer is capped');
  assert.equal(byKey('land-park'), 3, 'and the sparse one is untouched');
});

test('truncation is reported with the REAL total, not the capped one', () => {
  let capped = null;
  previewPolylines(many('land-game', 50), { scale: 24000, budget: 20, onTruncate: (c) => { capped = c; } });
  // "20 of 20" would be the bug: counting must continue after drawing stops.
  assert.deepEqual(capped, [{ key: 'land-game', shown: 20, total: 50 }]);
});

test('nothing is reported when nothing was capped', () => {
  let called = false;
  const drawn = previewPolylines(many('land-game', 5), { scale: 24000, budget: 20, onTruncate: () => { called = true; } });
  assert.equal(drawn.length, 5);
  assert.equal(called, false, 'a notice with nothing to report would be noise on every build');
});

test('the shipped budget is a real number and the reader is told when it bites', () => {
  assert.ok(PREVIEW_BUDGET > 100 && PREVIEW_BUDGET < 26863,
    `${PREVIEW_BUDGET} either caps nothing or is too small to be a preview`);
  const main = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
  assert.match(main, /onTruncate/, 'the cap must be wired, not merely available');
  assert.match(main, /qcm-preview-note/, 'and it must reach an element the reader can see');
  assert.match(main, /Every one of them prints/, 'the notice must say paper is unaffected');
});

// F12: browsing density and printing density are different questions, and the
// preview was answering the printing one. `drawsAtScale` was given the RECIPE's
// scale, so a reader on 1:48,000 paper who zoomed the screen to a single ridge
// still saw no parcel lines — the layer was switched on, the data was fetched,
// and the map stayed empty with nothing said. Paper scale decides paper; what a
// CSS pixel covers on the ground decides the screen.
const parcel = { id: 'p1', symbolKey: 'parcel-line', paths: [[[-77.00, 39.00], [-77.01, 39.01]]] };

test('zooming past the paper scale brings a dense layer back on screen', () => {
  assert.equal(previewPolylines([parcel], { scale: 48000 }).length, 0,
    '1:48,000 is coarser than the parcel layer draws at — this is the paper answer');
  const close = screenScaleDenominator(15, 39);
  assert.ok(close < 24000, `z15 is 1:${Math.round(close)}, which should be finer than 1:24,000`);
  assert.equal(previewPolylines([parcel], { scale: close }).length, 1,
    'the reader has zoomed in past the density limit; the lines are readable now');
});

test('the screen scale is the ground one CSS pixel covers', () => {
  // Halving the ground per pixel halves the denominator: one zoom level, one
  // factor of two, whatever the latitude.
  for (const lat of [0, 39, 61]) {
    assert.ok(Math.abs(screenScaleDenominator(14, lat) / screenScaleDenominator(15, lat) - 2) < 1e-9,
      `a zoom level is a factor of two at ${lat}°`);
  }
  // Mercator: the same zoom covers less ground the further from the equator.
  assert.ok(screenScaleDenominator(15, 61) < screenScaleDenominator(15, 0));
});

test('a layer the sheet will drop is named, not silently different', () => {
  let seen = null;
  const drawn = previewPolylines([parcel], {
    scale: screenScaleDenominator(15, 39), paperScale: 48000, onScreenOnly: (r) => { seen = r; },
  });
  assert.equal(drawn.length, 1, 'on screen');
  assert.deepEqual(seen, [{ key: 'parcel-line', paperScale: 48000 }],
    'and the reader is told the sheet will not carry it');
});

test('nothing is reported screen-only when the paper carries it too', () => {
  let called = false;
  previewPolylines([parcel], {
    scale: screenScaleDenominator(15, 39), paperScale: 24000, onScreenOnly: () => { called = true; },
  });
  assert.equal(called, false);
});

// F10, the half #443 left. Recreation sites became real DOM markers with a tab
// stop and an Enter handler; roads, trails and every land boundary stayed
// `interactive: false`, so a drawn boundary answered nothing to a click, a tap
// or a keyboard. A line you cannot ask about is a line you cannot identify, and
// "State game lands" versus "Parcel boundary" is exactly the question a reader
// has when two grey lines cross.
test('every previewed line carries the words to identify it', () => {
  const named = { id: 'gl-9', symbolKey: 'land-game', name: 'Sandhills Game Land',
    paths: [[[-79.5, 35.2], [-79.4, 35.3]]] };
  const anonymous = { id: 'gl-10', symbolKey: 'land-game', paths: [[[-79.5, 35.2], [-79.4, 35.3]]] };
  const [withName] = previewPolylines([named]);
  const [without] = previewPolylines([anonymous]);
  assert.match(withName.title, /Sandhills Game Land/, 'the source gave a name, so the name is used');
  assert.ok(withName.title.includes(SYMBOL_BY_KEY['land-game'].label),
    'and what KIND of thing it is, which the name alone does not say');
  assert.equal(without.title, SYMBOL_BY_KEY['land-game'].label,
    'no name in the source is not an empty tooltip');
  for (const p of previewPolylines(MVUM, { roadQuality: {} })) {
    assert.ok(p.title && p.title.trim(), `${p.key} previewed with nothing to say about it`);
  }
});

// F13's first clause. The app fetches maintenance level and surface for every road
// it draws and spent both on ONE thing: how thick to draw the line. Two grey lines
// of the same weight, one gravel and one needing high clearance, looked identical --
// with the answer already in the browser, fetched, parsed and thrown away.
test('a road tooltip carries the rating the app already fetched for it', () => {
  const quality = {
    71: { maintLevel: 2, surface: 'native', maintText: 'High clearance vehicles',
      surfaceText: 'Native material', tier: 'road-highclearance' },
    83: { ambiguous: true, maintLevel: null, surface: null, maintText: null, surfaceText: null },
  };
  const byId = Object.fromEntries(previewPolylines(MVUM, { roadQuality: quality }).map((p) => [p.id, p]));
  assert.match(byId['71'].title, /Native material/, 'the surface the inventory named');
  assert.match(byId['71'].title, /high clearance vehicles \(level 2\)/, 'and how far it is maintained');
  assert.match(byId['83'].title, /disagree/, 'a contradicted route says so rather than picking a side');
  // A road the inventory never matched keeps the plain tooltip. An empty rating
  // clause would read as "looked, and found it ordinary".
  const plain = previewPolylines(MVUM, { roadQuality: {} }).find((p) => p.id === '71');
  assert.equal(plain.title.includes(';'), false, `an unrated road said: ${plain.title}`);
  // The rating belongs to roads. A trail has no maintenance level, and the join
  // table is keyed on route id -- a trail sharing an id must not inherit a rating.
  const trail = previewPolylines(MVUM, { roadQuality: { 'T-1': quality['71'] } }).find((p) => p.id === 'T-1');
  assert.equal(trail.title.includes('Native material'), false, 'a trail is not a Forest Service road');
});

// The other half of what MVUM already answered: WHO may drive it and WHEN. Both
// were normalized by the adapter and consumed by nothing, so the only thing a
// season ever changed was the dash pattern.
test('a road tooltip says who may drive it and when, from MVUM\'s own answer', () => {
  const seasonal = { ...line('71', 'road', 'seasonal'),
    vehicles: { passenger: { allowed: 'open', datesOpen: { open: '04-01', close: '12-15' } },
      highClearance: { allowed: null, datesOpen: null } } };
  const shut = { ...line('83', 'road', 'yearlong'),
    vehicles: { passenger: { allowed: 'closed', datesOpen: null },
      highClearance: { allowed: 'open', datesOpen: null } } };
  const byId = Object.fromEntries(previewPolylines([seasonal, shut]).map((p) => [p.id, p]));
  assert.match(byId['71'].title, /Apr 1 – Dec 15/, 'the window the source stated');
  assert.match(byId['83'].title, /closed to passenger cars/i);
  assert.match(byId['83'].title, /high-clearance vehicles year-round/i);

  // MVUM trails are motor-vehicle routes too, so the same answer applies to them.
  // Unlike a Road Basic rating, this fact is not roads-only.
  const trail = { ...line('T-1', 'trail', 'yearlong'),
    vehicles: { passenger: { allowed: 'open', datesOpen: null }, highClearance: { allowed: null, datesOpen: null } } };
  assert.match(previewPolylines([trail])[0].title, /year-round/);

  // A feature the source said nothing about keeps the plain tooltip. An empty
  // access clause would read as "asked, and the answer was ordinary".
  assert.equal(previewPolylines(MVUM)[0].title.includes('open to'), false,
    'no stated vehicle, no sentence about vehicles');
});

// F13's analytical half, joined to the layer a reader actually stops at. The app
// already knew where the gravel roads were and where the campsites were, and never
// put the two together -- "is there a gravel road near this campsite?" could only
// be answered by eye, one road at a time.
test('a recreation site says how far it is from a mapped unpaved road', () => {
  const site = { symbolKey: 'rec-campground', name: 'STANDING INDIAN', lonLat: [-83.50, 35.01] };
  const roads = [{ id: '421', symbolKey: 'mvum-road-yearlong',
    paths: [[[-83.60, 35.00], [-83.40, 35.00]]] }];
  const gravel = { 421: { surface: 'gravel', surfaceText: 'Crushed aggregate or gravel', maintLevel: 3 } };

  const [near] = previewSites([site], { roads, roadQuality: gravel });
  assert.match(near.title, /STANDING INDIAN/, 'the site still says what it is');
  assert.match(near.title, /0\.7 mi from a mapped crushed aggregate or gravel road/);
  assert.match(near.title, /straight-line/, 'nothing here routes, so nothing may imply a drive');

  // An unmatched road has an unknown surface, not an unpaved one. The site says
  // nothing extra rather than promising gravel nobody looked up.
  const [unrated] = previewSites([site], { roads, roadQuality: {} });
  assert.equal(unrated.title, 'STANDING INDIAN', 'an unknown surface is not an unpaved one');
  // And with no roads fetched at all, the old behaviour is exactly unchanged.
  assert.equal(previewSites([site])[0].title, 'STANDING INDIAN');
});

test('the drawn overlay is reachable, not decoration', () => {
  const main = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
  const fn = main.slice(main.indexOf('function renderOverlay'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(!/interactive: false/.test(body),
    'a feature the reader cannot click, tap or tab to cannot be identified — '
    + 'this is what made bindTooltip useless on the rec-site layer before #443');
  assert.ok(/bindTooltip/.test(body), 'and it has to actually say something');
  // previewSites only knows about roads it is handed. Composing the answer inside
  // it and never passing them leaves every test above green and the reader with
  // exactly the tooltip they had before -- a fix that is inert on the real page.
  assert.match(body, /previewSites\([^)]*roadQuality/,
    'renderOverlay must hand previewSites the roads, or the near-unpaved answer is '
    + 'computed over an empty list and silently says nothing on the real map');
});

// The trap this pair of facts exists to keep shut: a tab stop needs a DOM node,
// and the dashboard's map draws vectors into a canvas, where there is none. Read
// as one test because either half alone looks fine — the tooltip opens on a
// click either way, and only the keyboard silently loses.
test('the previewed features are real DOM nodes, because the host map is canvas', () => {
  const dir = new URL('../../themes/headlessmode/static/js/', import.meta.url);
  const dash = readFileSync(new URL('quiet-corners.js', dir), 'utf8');
  assert.match(dash, /preferCanvas:\s*true/,
    'if the dashboard ever stops preferring canvas, re-read the overlay renderer below');
  const main = readFileSync(new URL('quiet-corners-maps/main.js', dir), 'utf8');
  assert.match(main, /overlayRenderer\s*=\s*L\.svg\(/,
    'the overlay needs its own SVG renderer or every previewed feature stays out of the document');
  const fn = main.slice(main.indexOf('function renderOverlay'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  // Only the VECTORS need this. #443 made the recreation sites an `L.marker`
  // with a divIcon, which is a DOM node already and takes Leaflet's own
  // `keyboard` handling — the test below this one pins that shape.
  const call = body.slice(body.indexOf('L.polyline'));
  assert.match(call.slice(0, call.indexOf('\n', call.indexOf(')'))), /renderer: overlayRenderer/,
    'a canvas-drawn polyline has no element, so identify() would find nothing and do nothing');
  // identify() lives beside previewSites (it is what makes the preview reachable) and
  // is imported here, so a browser test can drive it without loading the whole app.
  const id = readFileSync(new URL('quiet-corners-maps/preview-overlay.js', dir), 'utf8');
  assert.match(id.slice(id.indexOf('export function identify')).split('\n}')[0], /tabindex/,
    'and the element is what takes the tab stop');
});

// ---------------------------------------------------------------------------
// Point symbols (audit F10)
//
// Parity had a hole in it. `previewSites` read the symbol table, took the marker
// shape off it, and handed `marker` out — and main.js drew `L.circleMarker` for
// every site regardless. A campground, a shelter and a trailhead print as a
// triangle, a lean-to and a square; on screen all three were the same circle.
// So the reader could not tell a trailhead from a campsite until the PDF came
// out, and the key on screen described shapes the screen never drew.
//
// The same loop passed `interactive: false` and then `.bindTooltip()`. A tooltip
// on a non-interactive layer has nothing to open it: the name was attached and
// unreachable by mouse, touch and keyboard alike.
// ---------------------------------------------------------------------------
const site = (symbolKey, name) => ({ symbolKey, name, lonLat: [-83.5, 35.0] });

test('a site is drawn as ITS symbol, not as a circle for everything', () => {
  const drawn = previewSites([site('rec-campground', 'Cable Cove'), site('rec-shelter', 'Cold Spring'),
    site('rec-trailhead', 'Big Creek'), site('rec-site', 'Round Bottom')]);
  assert.deepEqual(drawn.map((d) => d.marker), ['triangle', 'house', 'square', 'dot'],
    'the shapes the sheet prints');
  // The shape must arrive as something Leaflet can draw. A `marker` string that
  // reaches no icon is exactly the bug: it was already there and drew nothing.
  for (const d of drawn) assert.ok(d.svg && d.svg.startsWith('<svg'), `${d.key} carries no drawable icon`);
});

test('the icon geometry comes from the sheet\'s own path, so the two cannot drift', () => {
  const [camp] = previewSites([site('rec-campground', 'Cable Cove')]);
  const size = camp.size;
  const want = markerPath('triangle', size / 2, size / 2, size)
    .map(([x, y]) => `${+x.toFixed(2)},${+y.toFixed(2)}`).join(' ');
  assert.ok(camp.svg.includes(want), `triangle points should be ${want}`);
  const [other] = previewSites([site('rec-site', 'Round Bottom')]);
  assert.ok(other.svg.includes('<circle'), 'a dot has no polygon path and stays a circle');
});

test('every point symbol in the table has a screen shape', () => {
  const points = Object.values(SYMBOLS).filter((s) => s.kind === 'point');
  assert.ok(points.length >= 4, `only ${points.length} point symbols — the table has moved`);
  for (const s of points) {
    const [d] = previewSites([site(s.key, 'x')]);
    assert.ok(d, `${s.key} previews as nothing`);
    assert.equal(d.marker, s.marker, `${s.key} previews as ${d.marker}, prints as ${s.marker}`);
  }
});

test('an unnamed site still says something when it is inspected', () => {
  const [d] = previewSites([{ symbolKey: 'rec-site', lonLat: [-83.5, 35.0] }]);
  assert.ok(d.title && d.title.length, 'a blank tooltip is a control that answers nothing');
});

test('the site markers on screen can actually be opened', () => {
  const main = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
  const loop = main.slice(main.indexOf('previewSites(state.recSites'));
  const body = loop.slice(0, loop.indexOf('\n}'));
  assert.ok(!body.includes('circleMarker'),
    'drawing every site as a circle is the finding; the icon carries the shape now');
  assert.ok(!/interactive:\s*false/.test(body),
    'a tooltip on a non-interactive layer can never be opened');
  assert.ok(/keyboard:\s*true/.test(body), 'a site must be reachable without a mouse');
});

// The half the BLM layer shipped without. siteLines() wrote the directions, description,
// fee text, vintage and agency link, fixture-tested every one -- and nothing rendered any
// of it, so all a pin could say was its name. The lines RIDE on the site, the way
// symbolKey does: rebuilt here, the map would hold a second copy of the wording.
test('the lines a site carries reach the mark, and the card is built out of text', () => {
  const lines = ['Afton Canyon', 'Directions: From Barstow, take Interstate 15 east for 35 miles.'];
  const [blm] = previewSites([{ symbolKey: 'rec-site', name: 'Afton Canyon', lonLat: [-116.4, 35.0], lines }]);
  assert.deepEqual(blm.lines, lines, 'the lines must reach the mark untouched');
  assert.equal(blm.title, 'Afton Canyon', 'and the tooltip stays the short answer, not the whole card');
  // `null`, not `[]`: an empty card is a control that opens onto nothing. A Forest
  // Service site has no lines and keeps exactly the tooltip it had.
  assert.equal(previewSites([site('rec-campground', 'Cable Cove')])[0].lines, null);
  assert.equal(previewSites([{ symbolKey: 'rec-site', lonLat: [-116.4, 35.0], lines: [] }])[0].lines, null);
  const dir = new URL('../../themes/headlessmode/static/js/quiet-corners-maps/', import.meta.url);
  const overlay = readFileSync(new URL('preview-overlay.js', dir), 'utf8');
  const card = overlay.slice(overlay.indexOf('export function siteCard')).split('\n}')[0];
  assert.ok(!/innerHTML|insertAdjacentHTML/.test(card),
    'the lines are provider HTML upstream; assigning them as markup undoes plainText()');
  assert.match(card, /textContent/, 'one text node per line is the whole mechanism');
  assert.match(overlay.slice(overlay.indexOf('export function identify')).split('\n}')[0],
    /'Escape'/, 'a card with no way to shut it is a trap');
  // The wiring the browser proof cannot see: it builds its own pin, so only this says
  // the real loop hands a card over at all.
  const main = readFileSync(new URL('main.js', dir), 'utf8');
  assert.match(main.slice(main.indexOf('previewSites(state.recSites')), /identify\([^)]*siteCard\(/,
    'the site loop must hand the card to identify(), or the lines are built and never shown');
});

// ---------------------------------------------------------------------------
// Land boundaries on screen. All seven families previewed as one blue dashed line,
// 1.2 to 2.3 px wide, unfilled, over a raster whose water is also blue. A screen
// variant in the one table gives each its own hue and a light fill; paper keeps
// its single blue. The style still comes from legend.js -- that is the invariant.
test('a land boundary previews as a filled area in its own screen colour; a road is untouched', () => {
  const park = previewStyle('fed-park');
  const symbol = SYMBOL_BY_KEY['fed-park'];
  assert.equal(park.closed, true, 'a designation is an area');
  assert.equal(park.fill, true);
  assert.equal(park.fillColor, park.color, 'the fill is the same hue as the line');
  assert.equal(park.color, symbol.screen.color, 'the screen hue comes from the table');
  assert.notEqual(park.color, symbol.color, 'and is not the paper blue');
  assert.ok(park.weight >= 2.5, `a boundary is at least 2.5 px on screen, got ${park.weight}`);
  assert.ok(park.fillOpacity > 0 && park.fillOpacity <= 0.2, 'light enough that the topo shows through');
  assert.ok(park.dashArray, 'the federal dash-dot survives on screen');
  const road = previewStyle('mvum-road-yearlong');
  assert.equal(road.closed, undefined); assert.equal(road.fill, undefined); assert.equal(road.fillColor, undefined);
  assert.equal(road.color, SYMBOL_BY_KEY['mvum-road-yearlong'].color, 'a road has no screen variant');
});

test('previewPolylines carries the fill through with the ring it was handed', () => {
  const ring = [[-83.5, 35.0], [-83.4, 35.0], [-83.4, 35.1], [-83.5, 35.0]];
  const [p] = previewPolylines([{ id: 'p1', symbolKey: 'land-park', paths: [ring] }]);
  assert.equal(p.closed, true);
  assert.equal(p.fillColor, previewStyle('land-park').color);
  assert.equal(p.key, 'land-park');
  assert.deepEqual(p.latlngs, ring.map(([lon, lat]) => [lat, lon]), 'the geometry is exactly what it was');
});

test('renderOverlay draws a closed style as a polygon, and lifts a shape under the pointer', () => {
  const main = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
  const fn = main.slice(main.indexOf('function renderOverlay'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /L\.polygon\(/, 'an area style must become a polygon, or the fill is never drawn');
  assert.match(body, /L\.polyline\(/, 'and a line style stays a polyline');
  assert.match(body, /mouseover/); assert.match(body, /mouseout/);
});
