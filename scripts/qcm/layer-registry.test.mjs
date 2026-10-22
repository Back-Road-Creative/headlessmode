// The layer registry, and the property that makes it worth having: a new layer
// is one entry, not an edit in four places.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LAYERS, groupHint, shortLabel, LAYER_BY_ID, LAYER_IDS, DEFAULT_LAYERS, GROUPS, GROUP_IDS, enabledLayers, layerControlSpecs,
  baseControlSpecs, contextControlSpecs, CONTEXT_LAYERS, DEFAULT_CONTEXT, surfaceCaption, LAYER_DRAPE, drapeKindFor }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';
import { layerAboutText } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-panel.js';
import { SYMBOL_BY_KEY, SYMBOLS } from '../../themes/headlessmode/static/js/quiet-corners-maps/legend.js';
import { LAYER_IDS as CATALOGUE_FAMILIES } from '../../themes/headlessmode/static/js/quiet-corners-maps/state-sources.js';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { DEFAULTS, sourceStateLine, canBuild, layerReport } from '../../themes/headlessmode/static/js/quiet-corners-maps/app-state.js';
import { layoutMarkup } from './helpers/layouts.mjs';

test('every entry names a real source and real symbols', () => {
  for (const l of LAYERS) {
    // A state land layer has no single measured service: its endpoint is per state,
    // out of state-sources.json. So it must name a catalogue FAMILY instead, and
    // must not claim a sourceId it does not have.
    if (l.stateScoped) {
      assert.equal(l.sourceId, null, `${l.id} is state-scoped and cannot name one source`);
      assert.ok(CATALOGUE_FAMILIES.includes(l.family), `${l.id} names family ${l.family}, which the catalogue does not have`);
    } else if (l.localData) {
      // A layer whose source is a file THIS SITE serves, not a service the browser calls:
      // source-registry.js is the record of measured services and an entry there would put
      // the publisher's origin into the generated CSP for a fetch that never happens. The
      // declaration is required so a layer that quietly lost its sourceId cannot pass here.
      assert.equal(l.sourceId, null, `${l.id} reads a local file and cannot also name a service`);
      assert.ok(l.localData.startsWith('/'), `${l.id} localData ${l.localData} is not served from this site`);
    } else {
      assert.ok(SOURCES[l.sourceId], `${l.id} names sourceId ${l.sourceId}, which source-registry does not have`);
    }
    // CHANGED with the `reading` group. This used to read "every layer draws something",
    // which was true of every layer there was: a row that answers in WORDS about the area —
    // the filed public-access category, the kind of country — puts no mark on the map and
    // owes the key no row. The invariant worth keeping is still enforced and now in both
    // directions: a layer that draws must name symbols, and one that does not must not.
    assert.equal(l.symbolKeys.length > 0, l.group !== 'reading',
      `${l.id}: symbolKeys and the reading group disagree`);
    // A typo'd symbol key would silently draw nothing and print no legend entry.
    for (const k of l.symbolKeys) assert.ok(SYMBOL_BY_KEY[k], `${l.id} names symbol ${k}, which legend.js does not have`);
    assert.ok(['ambiguous', 'none', 'blocking'].includes(l.emptyMeans), `${l.id} emptyMeans=${l.emptyMeans}`);
    assert.ok(['live', 'planned'].includes(l.status), `${l.id} status=${l.status}`);
  }
});

test('the registry is the ONE place a layer default is written', () => {
  assert.deepEqual(DEFAULTS.layers, DEFAULT_LAYERS,
    'app-state DEFAULTS.layers must derive from the registry — they used to disagree with the HTML');
  assert.equal(DEFAULT_LAYERS.usgsTopo, true, 'the base map is on');
  assert.equal(DEFAULT_LAYERS.mvum, false, 'an overlay is off until asked for');
});

// The PRINT contract: a sheet's raster is always topo. The screen base is chosen below.
test('a required layer cannot be switched off (print)', () => {
  const specs = layerControlSpecs({ mvum: false });
  const base = specs.find((s) => s.id === 'usgsTopo');
  assert.equal(base.checked, true);
  assert.equal(base.disabled, true, 'the base map renders checked and disabled');
  assert.deepEqual(enabledLayers({}).map((l) => l.id), ['usgsTopo'], 'a required layer is always fetched');
  assert.deepEqual(enabledLayers({ mvum: true }).map((l) => l.id), ['usgsTopo', 'mvum']);
});

test('the screen base is a choice: four radios, topo checked by default, and the print contract still holds', () => {
  const radios = baseControlSpecs();
  assert.deepEqual(radios.map((r) => r.id), ['usgsTopo', 'usgsImagery', 'usgsShadedRelief', 'none']);
  for (const r of radios) {
    assert.equal(r.inputId, `qcm-base-${r.id}`); assert.equal(r.name, 'qcm-base'); assert.equal(r.group, 'base');
    assert.equal(r.checked, r.id === 'usgsTopo', `${r.id} checked by default`);
    assert.ok(!r.disabled, 'a choice is never disabled');
  }
  assert.equal(baseControlSpecs('none').filter((r) => r.checked).map((r) => r.id).join(), 'none');
  assert.deepEqual(enabledLayers({}).map((l) => l.id), ['usgsTopo'], 'the PDF still prints topo');
  assert.match(GROUPS.find((g) => g.id === 'base').hint, /on screen/i);
  for (const id of ['aerial', 'terrain']) {
    assert.match(layerControlSpecs({}).find((s) => s.id === id).note, /under Base map/, `${id} points at the screen choice`);
  }
});

// --- the context group is a choice of ONE -----------------------------------
// The group's hint has always said "One continuous-colour surface laid over the map".
// It was four independent checkboxes, so four opaque rasters could be stacked and
// nothing stopped it. Radios, plus an explicit None, are what make the sentence true.

test('the context group is a choice of one: a radio per surface, an explicit None, and None by default', () => {
  const specs = contextControlSpecs();
  assert.equal(DEFAULT_CONTEXT, 'none', 'no surface is laid over the map until a reader asks for one');
  assert.ok(CONTEXT_LAYERS.length >= 4, 'the four surfaces this group exists for');
  assert.deepEqual(specs.map((s) => s.id), [...CONTEXT_LAYERS.map((l) => l.id), 'none'],
    'every context layer, then the way back out');
  for (const spec of specs) {
    assert.equal(spec.type, 'radio', `${spec.id} is still a checkbox — four could be on at once`);
    assert.equal(spec.name, 'qcm-context', `${spec.id} must share the group's name or it is not a choice`);
    assert.equal(spec.group, 'context');
    assert.equal(spec.inputId, `qcm-context-${spec.id}`);
    assert.ok(!spec.disabled, 'a choice the reader cannot make is not a choice');
  }
  // Exactly one on, always, and None is it until asked otherwise.
  assert.deepEqual(specs.filter((s) => s.checked).map((s) => s.id), ['none']);
  for (const l of CONTEXT_LAYERS) {
    assert.deepEqual(contextControlSpecs(l.id).filter((s) => s.checked).map((s) => s.id), [l.id],
      `choosing ${l.id} must leave exactly one surface on`);
  }
  // Turning them all off again has to be reachable, which is the whole reason None is a row.
  assert.deepEqual(contextControlSpecs('none').filter((s) => s.checked).map((s) => s.id), ['none']);
  // Each surface keeps the caveat it already had, and the report line it already writes into.
  for (const l of CONTEXT_LAYERS) {
    const spec = specs.find((s) => s.id === l.id);
    assert.equal(spec.label, l.label);
    assert.equal(spec.note, l.coverageCaveat, `${l.id} lost its caveat in the move to radios`);
    assert.ok(spec.noteId, `${l.id} needs its caveat wired to the input`);
    assert.equal(spec.reportId, `qcm-layer-${l.id}-report`, `${l.id}'s status line must keep its id`);
  }
});

// --- the active surface names itself, its time, and its age ------------------
// Which time is shown is the SOURCE's claim, never the retrieval time: a forecast shows
// the time it is for, an observation the time it was taken, an inventory its vintage.

test('a context surface caption names the surface and the time its own claim refers to', () => {
  const now = Date.UTC(2026, 8, 14, 18, 0, 0);
  const radar = surfaceCaption('nwsRadar', { timeMs: now - 4 * 60000, nowMs: now });
  assert.equal(radar.claim, 'observation');
  assert.ok(radar.text.startsWith(LAYER_BY_ID.nwsRadar.label), 'the caption has to say WHICH surface');
  assert.match(radar.text, /Observed 17:56 UTC, 4 minutes ago/);

  const aurora = surfaceCaption('swpcAurora', { timeMs: now + 62 * 60000, nowMs: now });
  assert.equal(aurora.claim, 'forecast');
  assert.match(aurora.text, /Forecast for 19:02 UTC, 62 minutes from now/);
  assert.doesNotMatch(aurora.text, /Observed/, 'a forecast must never be captioned as an observation');

  const lights = surfaceCaption('nightLights', { vintage: '2016', nowMs: now });
  assert.equal(lights.claim, 'inventory');
  assert.match(lights.text, /Vintage 2016/);
  assert.doesNotMatch(lights.text, /Observed|Forecast/);

  const noise = surfaceCaption('transportNoise', { vintage: '2020', nowMs: now });
  assert.equal(noise.claim, 'model');
  assert.match(noise.text, /Modelled for 2020/);

  const aqi = surfaceCaption('epaAirNowAqi', { timeMs: now - 144 * 60000, nowMs: now });
  assert.equal(aqi.claim, 'observation');
  assert.match(aqi.text, /Observed 15:36 UTC, 144 minutes ago/);

  // An unknown time is SAID. Never blank, and never quietly "now".
  for (const id of CONTEXT_LAYERS.map((l) => l.id)) {
    const blank = surfaceCaption(id, { timeMs: null, vintage: null, nowMs: now });
    assert.match(blank.text, /unknown/i, `${id} says nothing when its time is missing`);
    assert.doesNotMatch(blank.text, /\bnow\b\.$/, `${id} falls back to the wall clock`);
    assert.ok(blank.text.startsWith(LAYER_BY_ID[id].label));
  }
  // Only a context surface is captioned: nothing else is laid over the map as one.
  assert.equal(surfaceCaption('none'), null);
  assert.equal(surfaceCaption('mvum'), null);
  assert.equal(surfaceCaption('nope'), null);
});

// --- the county score wash is a registry row, not a second mechanism ----------
// The dashboard's county-comparison colour wash is local data, continuous over the
// map, and never printed. Those are exactly the three things `screenOnly`,
// `rasterSurface` and the `context` group already mean for night lights and the NLCD
// pair -- so the row must reuse them rather than a second registry or an adapter.

test('county score is a local-data, screen-only, continuous context surface', () => {
  const county = LAYER_BY_ID.countyScore;
  assert.ok(county, 'countyScore must be a registry entry');
  assert.equal(county.group, 'context', 'one dominant surface, alongside the other context rows');
  assert.equal(county.screenOnly, true, 'the wash is drawn on screen only, never on a printed sheet');
  assert.equal(county.rasterSurface, true, 'a continuous colour fill counts against the surface budget');
  assert.equal(county.sourceId, null, 'a local file is not a measured service');
  assert.ok(county.localData && county.localData.startsWith('/'), 'localData must name a site-served path');
  assert.equal(county.defaultOn, false, 'scores are opt-in, not on by default');

  // Joining CONTEXT_LAYERS is what gives it a radio row for free, with no new template code.
  assert.ok(CONTEXT_LAYERS.some((l) => l.id === 'countyScore'), 'countyScore must join the one-dominant-surface group');
  assert.ok(contextControlSpecs(DEFAULT_CONTEXT).some((s) => s.id === 'countyScore'),
    'countyScore must render a control row like every other context surface');

  // The one invariant that matters most: screenOnly keeps it out of the printable-vector
  // fetch loop entirely, whether or not a reader ever turns it on.
  assert.ok(!enabledLayers({ countyScore: true }).some((l) => l.id === 'countyScore'),
    'countyScore must never enter the printable-vector fetch loop, even when switched on');
});

// --- road cameras are a registry row in their own group, not a reuse of overlay -----
// Cameras are screen-only pins whose picture loads on open, never printed and never
// drawn on the 3D terrain panel (QUX-08D C22/C24) -- so they get their own `cameras`
// group rather than joining `overlay` or `context`.

test('road cameras are a screen-only registry row in their own cameras group', () => {
  const cams = LAYER_BY_ID.roadCameras;
  assert.ok(cams, 'roadCameras must be a registry entry');
  assert.equal(cams.group, 'cameras', 'cameras get their own group, not overlay or context');
  assert.equal(cams.sourceId, null, 'the road row holds several operators, so it names no single source');
  assert.equal(cams.screenOnly, true, 'a camera pin is never printed');
  assert.equal(cams.defaultOn, false, 'cameras are opt-in, not on by default');
  assert.equal(cams.required, false);
  assert.deepEqual(cams.symbolKeys, [SYMBOLS.basemap.key]);
  assert.equal(cams.emptyMeans, 'none');
  assert.equal(cams.status, 'live');
  assert.ok(cams.coverageCaveat && cams.coverageCaveat.length > 0, 'the District 5 caveat must be readable in the panel');

  assert.ok(GROUPS.some((g) => g.id === 'cameras'), 'the cameras group must be declared');
  const group = GROUPS.find((g) => g.id === 'cameras');
  assert.match(group.hint, /screen|map/i, 'the group hint must say what it does on the map');

  // screenOnly keeps it out of the printable-vector fetch loop, exactly like county score.
  assert.ok(!enabledLayers({ roadCameras: true }).some((l) => l.id === 'roadCameras'),
    'roadCameras must never enter the printable-vector fetch loop, even when switched on');
});

test('park cameras (NPS, 08D-ii) are a screen-only registry row in the same cameras group', () => {
  const cams = LAYER_BY_ID.parkCameras;
  assert.ok(cams, 'parkCameras must be a registry entry');
  assert.equal(cams.group, 'cameras', 'cameras get their own group, not overlay or context');
  assert.equal(cams.sourceId, 'npsWebcams');
  assert.equal(cams.screenOnly, true, 'a camera pin is never printed');
  assert.equal(cams.defaultOn, false, 'cameras are opt-in, not on by default');
  assert.equal(cams.required, false);
  assert.deepEqual(cams.symbolKeys, [SYMBOLS.basemap.key]);
  assert.equal(cams.emptyMeans, 'none');
  assert.equal(cams.status, 'live');
  assert.ok(cams.coverageCaveat && cams.coverageCaveat.length > 0, 'the park coverage caveat must be readable in the panel');

  // screenOnly keeps it out of the printable-vector fetch loop, exactly like roadCameras.
  assert.ok(!enabledLayers({ parkCameras: true }).some((l) => l.id === 'parkCameras'),
    'parkCameras must never enter the printable-vector fetch loop, even when switched on');
});

test('every control gets a real id, so it is addressable and testable', () => {
  for (const spec of layerControlSpecs({})) {
    assert.equal(spec.inputId, `qcm-layer-${spec.id}`);
    if (spec.note) assert.equal(spec.noteId, `${spec.inputId}-note`, 'a caveat needs an id for aria-describedby');
  }
  // The old markup used name= with no id at all, which is why the layer controls
  // were the only controls on the page with no test coverage.
  const page = layoutMarkup();
  assert.ok(page.includes('id="qcm-layers"'), 'the page needs the host the registry fills');
  assert.ok(!page.includes('name="qcm-layer-mvum"'), 'the hand-written checkbox should be gone');
});

// The proof that it scales past two: a third layer produces a row with NO template edit.
test('a planned layer renders as a disabled "coming" row, with no template change', () => {
  const third = { id: 'ownership', label: 'Land ownership', sourceId: 'usgsTopo', defaultOn: false,
    required: false, symbolKeys: ['usgs-topo'], emptyMeans: 'none', status: 'planned',
    coverageCaveat: null, render: { labels: 'none', dropBelowScale: null } };
  const specs = layerControlSpecs({}, [...LAYERS, third]);
  assert.equal(specs.length, LAYERS.length + 1, 'the extra layer produced a row');

  const row = specs.at(-1);
  assert.equal(row.id, 'ownership');
  assert.equal(row.label, 'Land ownership (coming)', 'a planned layer says so in its own label');
  assert.equal(row.disabled, true, 'a planned layer cannot be switched on');
  assert.equal(row.checked, false);
  assert.equal(row.note, 'Not available yet.');
  assert.equal(row.inputId, 'qcm-layer-ownership');
  assert.equal(row.noteId, 'qcm-layer-ownership-note');

  // The existing rows are untouched by the addition — no ordering or id churn.
  assert.deepEqual(specs.slice(0, LAYERS.length), layerControlSpecs({}));
  assert.ok(LAYER_IDS.length >= 2);
  assert.ok(LAYER_BY_ID.mvum);
});

test('sourceStateLine and canBuild loop the registry instead of naming layers', () => {
  const src = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/app-state.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function canBuild'), src.indexOf('export function layerReport'));
  assert.ok(!/layers\.mvum/.test(body), 'canBuild must not name a layer literally');
  assert.ok(!/states\.usgsTopo/.test(body), 'canBuild must not name a layer literally');
  // and it still behaves the same
  assert.equal(canBuild({ states: { usgsTopo: 'ready', mvum: 'ready' }, layers: { usgsTopo: true, mvum: true } }).ok, true);
  assert.equal(canBuild({ states: { usgsTopo: 'ready', mvum: 'unavailable' }, layers: { usgsTopo: true, mvum: false } }).ok, true);
  assert.match(sourceStateLine({ usgsTopo: 'ready', mvum: 'ready' }, { usgsTopo: true, mvum: true }), /USGS Topo: ready/);
});

// layerReport is what makes "no coverage" distinguishable from "nothing here".
test('layerReport tells no-coverage apart from nothing-here', () => {
  assert.equal(layerReport({ layerId: 'mvum', state: 'unchecked' }).state, 'unchecked');
  assert.equal(layerReport({ layerId: 'mvum', state: 'ready', featureCount: 128 }).text,
    'MVUM roads & trails: 128 features in this area.');
  const empty = layerReport({ layerId: 'mvum', state: 'ready', featureCount: 0 });
  assert.equal(empty.state, 'empty');
  // MVUM is emptyMeans:'ambiguous', so an empty answer must NOT read as "no routes".
  assert.match(empty.text, /returned nothing/);
  assert.match(empty.text, /forest by forest/);
  assert.equal(layerReport({ layerId: 'mvum', state: 'unavailable' }).state, 'blocked');
  assert.throws(() => layerReport({ layerId: 'nope', state: 'ready' }), RangeError);
});

// --- grouping ---------------------------------------------------------------
// A flat list of nine checkboxes put three unlike things side by side: overlays
// that add ink, extra SHEETS that add pages, and state layers that may not exist
// where you are. A reader who ticked "Aerial companion sheet" expecting to see it
// on the map was reading the list correctly.

test('every layer belongs to a declared group, and every group is used', () => {
  for (const l of LAYERS) {
    assert.ok(GROUP_IDS.includes(l.group), `${l.id} is in group ${l.group}, which is not declared`);
  }
  const used = new Set(LAYERS.map((l) => l.group));
  for (const g of GROUP_IDS) assert.ok(used.has(g), `group ${g} is declared and holds no layer`);

  // An extra SHEET is never in the same group as an overlay: that is the whole point.
  for (const l of LAYERS) {
    assert.equal(l.group === 'extras', !!l.extraPage, `${l.id}: extraPage and the extras group must agree`);
  }
  assert.equal(LAYER_BY_ID.usgsTopo.group, 'base');
  for (const l of LAYERS.filter((x) => x.stateScoped)) assert.equal(l.group, 'state');
});

test('a control spec carries its group, so main.js needs no second table', () => {
  for (const spec of layerControlSpecs({})) {
    assert.equal(spec.group, LAYER_BY_ID[spec.id].group);
  }
  // and the groups partition the specs — nothing is dropped by the grouping loop
  const specs = layerControlSpecs({});
  const grouped = GROUP_IDS.flatMap((g) => specs.filter((s) => s.group === g));
  assert.equal(grouped.length, specs.length, 'a layer whose group is unlisted would vanish from the panel');
});

// Three of these switches produce a PAGE, not an overlay: the aerial and shaded
// relief companions and the route summary. They sit in the same list as the
// layers that draw, they are enabled from the start, and switching one on
// changes nothing you can see — the map is identical and the difference is in a
// PDF you have not built yet. The registry has always known (`extraPage` gates
// the fetch at layer-registry.js's overlay filter); the reader never was told.
test('a switch that only adds a page to the PDF says so', () => {
  const specs = layerControlSpecs({});
  const extras = LAYERS.filter((l) => l.extraPage);
  assert.ok(extras.length >= 2, 'the companion sheets are the case this is about');
  for (const l of extras) {
    const spec = specs.find((s) => s.id === l.id);
    assert.ok(spec.note, `${l.id} has no note at all`);
    assert.match(spec.note, /not draw on the map|does not appear on the map/i,
      `${l.id} does not tell the reader it is print-only`);
    assert.ok(spec.noteId, `${l.id} needs the note wired to the input for a screen reader`);
  }
  for (const l of LAYERS.filter((x) => !x.extraPage && x.status === 'live')) {
    const spec = specs.find((s) => s.id === l.id);
    assert.ok(!spec.note || !/not draw on the map/i.test(spec.note),
      `${l.id} draws on the map and must not claim otherwise`);
  }
});

// The group hints are read in the Layers panel, on screen, by someone looking at
// the map — `renderLayerControls` is the only thing that draws them and it draws
// them there. Three of the five were written from the printer's point of view.
// "Drawn on every sheet" answers a question about a PDF the reader has not built;
// what they are about to see is ink appearing on the map in front of them. And in
// a panel where two hints use "page" to mean a page of that PDF, a third used it
// to mean a page of this website.
//
// So: a hint that mentions paper has to say what the toggle does on the map too,
// and the word "page" is reserved for the PDF.
const PAPER = /\b(sheet|sheets|printed|print|pdf)\b/i;
const SCREEN = /\b(map|screen|on screen)\b/i;

test('every group hint says what the switches do on the map, not only on paper', () => {
  const withHints = GROUPS.filter((g) => g.hint);
  assert.ok(withHints.length >= 4, 'the panel is grouped and the groups explain themselves');
  for (const g of withHints) {
    assert.match(g.hint, SCREEN,
      `the "${g.label}" hint never mentions the map a reader is looking at: ${g.hint}`);
    if (PAPER.test(g.hint)) {
      assert.ok(SCREEN.test(g.hint),
        `the "${g.label}" hint answers about paper only: ${g.hint}`);
    }
  }
});

test('"page" in the Layers panel means a page of the PDF, nothing else', () => {
  for (const g of GROUPS.filter((x) => x.hint && /\bpages?\b/i.test(x.hint))) {
    assert.match(g.hint, PAPER,
      `the "${g.label}" hint says "page" without saying it is a printed one: ${g.hint}`);
  }
});

// E2: every row has a drape answer for the 3D terrain panel, so a new layer
// cannot ship silently undecided between "drawn in 3D" and "Available in 2D".
test('every layer names a drape kind for the 3D terrain panel', () => {
  for (const l of LAYERS) {
    assert.ok(['line', 'label', 'point', false].includes(LAYER_DRAPE[l.id]),
      `${l.id} has no valid drape kind (got ${LAYER_DRAPE[l.id]})`);
  }
  assert.equal(LAYER_DRAPE.names, 'label', 'names drapes as DOM labels, not a line layer');
  for (const l of LAYERS.filter((x) => x.group === 'context')) {
    assert.equal(LAYER_DRAPE[l.id], false, `${l.id} is a context surface and cannot drape`);
  }
  // A camera pin marks a point, and the 3D panel stands it on the relief where 2D pins it
  // (QC 3D matrix row 7, replacing QUX-08D C24's "never drawn in 3D"), in 2D's own pin colour.
  for (const l of LAYERS.filter((x) => x.group === 'cameras')) {
    assert.equal(LAYER_DRAPE[l.id], 'point', `${l.id} is a camera pin the 3D panel should show`);
    assert.match(l.pinColor || '', /^#[0-9a-f]{6}$/i, `${l.id} names the colour its 2D pin is drawn in`);
  }
  for (const l of LAYERS.filter((x) => x.extraPage)) {
    assert.equal(LAYER_DRAPE[l.id], false, `${l.id} is a PDF-only extra page, not a map overlay`);
  }
  // A layer that draws ink on the 2D map (symbolKeys, not 'reading'/'base'/extraPage/cameras)
  // is drapeable, never silently false -- that would be a layer the panel forgets.
  for (const l of LAYERS.filter((x) => x.group !== 'context' && x.group !== 'base'
    && x.group !== 'reading' && x.group !== 'cameras' && !x.extraPage)) {
    assert.notEqual(LAYER_DRAPE[l.id], false, `${l.id} draws on the 2D map but the panel drops it`);
  }
});

test('drapeKindFor is a pure function of a row, matching the frozen LAYER_DRAPE table', () => {
  for (const l of LAYERS) assert.equal(drapeKindFor(l), LAYER_DRAPE[l.id]);
});

// UX-03b (audit A05/A07): the camera rows name where they work and answer a search for webcam,
// an operator or a place; the coverage box is what the panel's Go to control moves the map to.
test('camera rows carry a coverage box and the search words webcam, operator and place', () => {
  const rows = { roadCameras: LAYER_BY_ID.roadCameras, parkCameras: LAYER_BY_ID.parkCameras };
  for (const [id, row] of Object.entries(rows)) {
    const c = row.coverage;
    assert.ok(c && c.minLon < c.maxLon && c.minLat < c.maxLat, `${id} needs an ordered coverage box`);
    assert.ok(c.minLon >= -180 && c.maxLon <= 180 && c.minLat >= -90 && c.maxLat <= 90, `${id} coverage is lon/lat`);
    assert.ok(row.coverageName && row.coverageName.length > 0, `${id} names its region`);
    assert.match(row.searchTerms, /webcam/i, `${id} must answer a search for webcam`);
  }
  assert.match(rows.roadCameras.searchTerms, /california/i);
  assert.match(rows.parkCameras.searchTerms, /\bNPS\b/);
  assert.match(rows.parkCameras.searchTerms, /tennessee/i);
});

test('only the camera rows carry coverage/searchTerms (no other row silently gains a region)', () => {
  const extra = LAYERS.filter((l) => (l.coverage || l.searchTerms) && l.group !== 'cameras').map((l) => l.id);
  assert.deepEqual(extra, []);
});

// camera U4a: the road layer now reads the 12-district snapshot, so its row says California.
test('roadCameras covers California: the box holds every Caltrans district and no copy says District 5 only', () => {
  const row = LAYER_BY_ID.roadCameras;
  assert.equal(row.coverageName, 'US states');
  assert.equal(row.goToName, 'California');
  assert.doesNotMatch(`${row.label} ${row.coverageName} ${row.coverageCaveat}`, /Central Coast|District 5/);
  const areas = SOURCES.caltransCctv.coverageAreas;
  assert.equal(areas.length, 12);
  for (const a of areas) {
    assert.ok(a.bbox.minLon >= row.coverage.minLon && a.bbox.maxLon <= row.coverage.maxLon
      && a.bbox.minLat >= row.coverage.minLat && a.bbox.maxLat <= row.coverage.maxLat, `${a.id} sits inside roadCameras.coverage`);
  }
  assert.doesNotMatch(SOURCES.caltransCctv.coverageSemantics, /District 5 \(Central Coast\) only/);
});

test('road cameras: the About text does not name Caltrans as the only source', () => {
  const road = LAYER_BY_ID.roadCameras;
  assert.equal(road.sourceId, null);
  assert.ok(road.localData && road.localData.startsWith('/'), 'the lists are this site\u2019s own snapshot files');
  const about = layerAboutText({ layer: road, source: null });
  assert.doesNotMatch(about, /Source: Caltrans/);
  for (const name of ['Caltrans', 'Kentucky', 'Arlington', 'Lawrence', 'Salem', 'Oregon', 'Utah']) {
    assert.match(about, new RegExp(name), `the road About text must name ${name}`);
  }
});

// A hand-kept name list fell behind once already (the CARS lists joined the road row and its
// About text still named only the ArcGIS operators), so read the operators from the committed lists.
test('road cameras: the About text names the operator of every committed road camera list', () => {
  const dir = new URL('../../static/data/quiet-corners-maps/cameras/', import.meta.url);
  const index = JSON.parse(readFileSync(new URL('index.json', dir), 'utf8'));
  const operators = new Set(index.files.filter((f) => f.layer === 'roadCameras')
    .map((f) => JSON.parse(readFileSync(new URL(f.file, dir), 'utf8')).operator));
  assert.ok(operators.size >= 2);
  const about = layerAboutText({ layer: LAYER_BY_ID.roadCameras, source: null });
  for (const name of operators) assert.ok(about.includes(name), `the road About text must name ${name}`);
});

test('camera links: the About text names the owner of every committed link-only camera list', () => {
  const dir = new URL('../../static/data/quiet-corners-maps/cameras/', import.meta.url);
  const index = JSON.parse(readFileSync(new URL('index.json', dir), 'utf8'));
  const operators = new Set(index.files.filter((f) => f.layer === 'linkCameras')
    .map((f) => JSON.parse(readFileSync(new URL(f.file, dir), 'utf8')).operator));
  assert.ok(operators.size >= 2);
  const about = layerAboutText({ layer: LAYER_BY_ID.linkCameras, source: null });
  for (const name of operators) assert.ok(about.includes(name), `the camera links About text must name ${name}`);
});

// The Federal overlays hint promised "every printed sheet" while Road names (and,
// once the BTS, NRHP and SNOTEL rows landed, four more) never print. Nothing on a
// row says it is screen only, so the hint is the reader's one answer — and a
// hand-written list of exceptions would go stale with the next screen-only row.
// groupHint() builds the exception from the registry, so it cannot.
test('a group hint that mentions printing names every row in it that does not print', () => {
  for (const g of GROUPS.filter((x) => x.hint && PAPER.test(x.hint))) {
    const rows = LAYERS.filter((l) => l.group === g.id);
    const screen = rows.filter((l) => l.screenOnly);
    if (!screen.length || screen.length === rows.length) continue;
    const hint = groupHint(g);
    assert.doesNotMatch(hint, /\bevery printed sheet\b/i,
      `the "${g.label}" hint promises every sheet, but ${screen.map((l) => l.id).join(', ')} never print`);
    for (const l of screen) {
      assert.ok(hint.includes(shortLabel(l.label)),
        `the "${g.label}" hint does not name ${l.id} (${shortLabel(l.label)}) as screen only: ${hint}`);
    }
  }
});

test('groupHint leaves a group with nothing to except exactly as written', () => {
  for (const g of GROUPS.filter((x) => x.id !== 'federal')) assert.equal(groupHint(g), g.hint);
  assert.equal(groupHint({ id: 'none', label: 'x' }), '');
});
