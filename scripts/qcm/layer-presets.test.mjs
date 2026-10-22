// The two presets, and the three things S10 asks to be MEASURED before the set is broadened:
// clutter, load size, and — the one that is not mechanical — task completion. The load and
// clutter numbers are enforced by the factory, so importing the module is already the assertion;
// what is left is that the gate bites, that a preset stays a NAMED SET of switches the panel
// already has, and that main.js applies one by moving those switches, not a second path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRESETS, PRESET_BY_ID, BUDGET, MAX_LABEL_WORDS, definePreset, layerSwitches, presetLeavesAlone, opensOn, presetCost, presetApplied,
  presetPreview, presetPreviewText, readerStrings }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-presets.js';
import { LAYERS, LAYER_BY_ID, enabledLayers, layerControlSpecs }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';
import { BASE_BY_ID } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-basemaps.js';

const MAIN = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
const build = (over) => definePreset({ id: 't', label: 'T', question: 'T?', base: 'usgsTopo', layers: ['mvum'], ...over });

test('six presets, each naming real layers, a real base and the question it answers', () => {
  // U1 (F03): task presets plus Reset/Undo -- Map only, Trails & terrain, Land access,
  // Compare counties, retaining the two S10 presets unchanged.
  assert.equal(PRESETS.length, 7, 'the two S10 presets, U1\'s four task presets and Loud or quiet (E5)');
  for (const p of PRESETS) {
    assert.ok(BASE_BY_ID[p.base], `${p.id} names base ${p.base}`);
    for (const id of p.layers) assert.ok(LAYER_BY_ID[id], `${p.id} names layer ${id}`);
    assert.ok(p.question.trim().endsWith('?'), `${p.id} must state a question, not a description`);
    assert.equal(PRESET_BY_ID[p.id], p);
  }
});

// Robust by construction: names are resolved in definePreset, at module load, so a preset
// naming a layer that does not exist cannot be built. This proves the gate bites.
test('a preset cannot name a layer or a base that does not exist', () => {
  assert.doesNotThrow(() => build({}));
  assert.throws(() => build({ layers: ['mvumm'] }), /no such layer mvumm/);
  assert.throws(() => build({ base: 'openStreetMap' }), /no such base map/);
  assert.throws(() => build({ question: '' }), /question/);
  assert.throws(() => build({ layers: ['mvum', 'mvum'] }), /twice/);
  // The printed sheet's raster is always topo; a preset is not what changes that.
  assert.throws(() => build({ layers: ['usgsTopo'] }), /required/);
});

// QUX-04b: the chooser row (`#qcm-presets`) is starting-set NAMES, not sentences -- a name
// long enough to answer the question itself is the clutter the starting-set redesign refuses
// to let back in. Guarded here rather than only in the template, so a future preset cannot
// reintroduce a long label without the module itself refusing to load.
test('a preset label stays a short name, not a sentence, and the cap is refused past it', () => {
  assert.throws(() => build({ label: 'This label has way too many words for a chooser button' }), /word/);
  for (const p of PRESETS) {
    const words = p.label.trim().split(/\s+/).length;
    assert.ok(words <= MAX_LABEL_WORDS, `${p.id}: "${p.label}" is ${words} words, over the ${MAX_LABEL_WORDS}-word cap`);
  }
});

// LOAD SIZE and CLUTTER as numbers. Each unit is justified in layer-presets.js's BUDGET
// comment; this asserts the shipped pair is inside it and that going outside is refused.
test('every preset stays inside the measured budget, and one that does not cannot be built', () => {
  for (const p of PRESETS) {
    const cost = presetCost(p);
    for (const [unit, cap] of Object.entries(BUDGET)) assert.ok(cost[unit] <= cap, `${p.id}: ${cost[unit]} ${unit} > ${cap}`);
  }
  // Seven fetched layers: one more than the pair measured at, and the ceiling holds.
  assert.throws(() => build({ layers: ['mvum', 'trails', 'federalLand', 'countyLines', 'surfaceOwnership', 'recSites', 'blmRecSites'] }),
    /7 fetchLayers is over the measured budget of 6/);
  // Two view-filling pictures: the pair that leaves under a tenth of the base showing.
  // CHANGED with the context radio group. Both view-filling surfaces live in that group, so
  // the pair is now refused one gate EARLIER, by the group contract rather than by the
  // measured budget — a structural refusal ahead of a numeric one. The budget below stays
  // the record of what was measured, and presetCost still reports it.
  assert.throws(() => build({ layers: ['nightLights', 'nwsRadar'] }), /context surface/);
  assert.equal(presetCost(PRESET_BY_ID.nightSky).rasterSurfaces, 1);
});

test('the night set asks nothing of the vector services, and lays down one surface', () => {
  const p = PRESET_BY_ID.nightSky;
  assert.deepEqual(presetCost(p), { fetchLayers: 0, rasterSurfaces: 1, symbolKeys: 1 });
  // Screen-only is WHY the fetch count is nil: the surfaces are handed straight to Leaflet.
  for (const id of p.layers) assert.equal(LAYER_BY_ID[id].screenOnly, true, `${id} is not a context surface`);
  assert.equal(p.base, 'none', 'a surface drawn at 0.8 is not something to read a topo sheet through');
});

test('the public-land set is six queries and nineteen marks, and the six are what gets fetched', () => {
  const p = PRESET_BY_ID.publicLandDay;
  assert.deepEqual(presetCost(p), { fetchLayers: 6, rasterSurfaces: 0, symbolKeys: 19 });
  assert.deepEqual(enabledLayers(layerSwitches(p)).filter((l) => !l.required).map((l) => l.id).sort(), [...p.layers].sort(),
    'the cost is counted off the same function the builder fetches from');
  assert.equal(p.base, 'usgsTopo');
});

// A preset is a NAMED SET, not a mode: every switch stated, in the shape the panel reads.
test('a preset states every switch, leaves the required one alone, and locks nothing', () => {
  for (const p of PRESETS) {
    const on = layerSwitches(p);
    assert.deepEqual(Object.keys(on).sort(), LAYERS.map((l) => l.id).sort(), 'a partial set would merge, not apply');
    for (const l of LAYERS) assert.equal(on[l.id], l.required || p.layers.includes(l.id), `${l.id} disagrees with ${p.id}`);
    // U1: publicAccess names state-land families (`land()` rows, `stateScoped: true`).
    // layerControlSpecs with no states arg always reports those rows unavailable --
    // "Draw an area first" -- which is registry.js's own pre-existing contract
    // (enabledLayers/layerControlSpecs both gate on `available.has(l.family)`), not
    // something a preset can or should override before an area is drawn. Checked here
    // only for the layers that are not state-scoped.
    for (const spec of layerControlSpecs(on).filter((s) => p.layers.includes(s.id) && !LAYER_BY_ID[s.id].stateScoped)) {
      assert.equal(spec.checked, true, `${spec.id} was named and did not come up checked`);
      assert.ok(!spec.disabled, `${spec.id} came up locked — a preset is a shortcut, not a mode`);
    }
  }
});

test('the status line names what went on, and says the switches are still the reader\'s', () => {
  const said = presetApplied('nightSky', ['Night light emissions', 'Aurora forecast']);
  for (const rx of [/Night light emissions, Aurora forecast/, /still yours to change/, /Is tonight worth the drive/]) assert.match(said, rx);
  assert.match(presetApplied('nightSky'), /Nothing changed/);
  assert.throws(() => presetApplied('noSuchPreset'), /unknown preset/);
  for (const s of readerStrings()) assert.ok(s && !/[<>]/.test(s), `exported markup: ${JSON.stringify(s)}`);
});

// A source contract, like page-controls.test.mjs: the wiring is DOM code the Node suite cannot
// run, and the property that matters is that it adds no second way to the map.
test('main.js applies a preset through the controls the reader already has', () => {
  const fn = MAIN.slice(MAIN.indexOf('function applyPreset'), MAIN.indexOf('function renderPresets'));
  assert.ok(fn.includes('qcm-layer-') && fn.includes('qcm-base-') && fn.includes('qcm-context-'),
    'a preset must move the checkboxes, the base radio and the context radio');
  assert.ok(/dispatchEvent\(new Event\('change'\)\)/.test(fn), 'each switch needs its own change event — the hand-ticked path');
  assert.ok(fn.includes('el.disabled'), 'a disabled row is not a preset\'s to move');
  assert.ok(!/addTo\(map\)|fetch\(|\.addLayer\(/.test(fn), 'a preset must not reach the map itself — that is the second path this avoids');
  assert.ok(MAIN.includes('renderPresets()'), 'the buttons are never rendered');
  // Before CONTEXT_RENDER only the lights redrew on toggle; the other three waited for a pan.
  assert.match(MAIN, /const CONTEXT_RENDER = \{[^}]*nwsRadar[^}]*swpcAurora[^}]*epaAirNowAqi/);
  // CHANGED with the context radio group: the surfaces used to be four checkboxes, each
  // redrawing itself through CONTEXT_RENDER[spec.id]. One radio moving means the surface
  // that went OFF has to be redrawn too, so the handler runs the whole table.
  const ctx = MAIN.slice(MAIN.indexOf('function setContext'), MAIN.indexOf('function renderSurfaceCaption'));
  assert.ok(ctx.includes('Object.values(CONTEXT_RENDER)'),
    'the surface that was switched off must be redrawn, not only the one switched on');
});

// A preset names a SET of switches, and the context group now holds at most one of them.
// Robust by construction: a preset naming two cannot be built, so applyPreset can never
// silently drop one on the floor.
test('a preset cannot name two context surfaces, because only one can ever be drawn', () => {
  assert.doesNotThrow(() => build({ layers: ['nightLights'] }));
  assert.throws(() => build({ layers: ['nightLights', 'swpcAurora'] }), /one context surface/);
  assert.throws(() => build({ layers: ['swpcAurora', 'epaAirNowAqi'] }), /one context surface/);
  for (const p of PRESETS) {
    assert.ok(p.layers.filter((id) => LAYER_BY_ID[id].group === 'context').length <= 1,
      `${p.id} asks for more surfaces than the map can draw`);
  }
});

// U1 task presets. Each stays inside BUDGET (definePreset would refuse it otherwise), so
// this asserts the shipped shape rather than re-measuring the numbers definePreset already
// gated.
test('mapOnly names a real base and turns every overlay off', () => {
  const p = PRESET_BY_ID.mapOnly;
  assert.ok(p, 'mapOnly must exist');
  assert.deepEqual(presetCost(p), { fetchLayers: 0, rasterSurfaces: 0, symbolKeys: 0 });
  const on = layerSwitches(p);
  for (const l of LAYERS) if (!l.required) assert.equal(on[l.id], false, `${l.id} must be off in Map only`);
  assert.equal(p.base, 'usgsTopo', 'the opening experience is a normal base map');
});

test('trailsTerrain reads trails against relief, within budget', () => {
  const p = PRESET_BY_ID.trailsTerrain;
  assert.ok(p, 'trailsTerrain must exist');
  const cost = presetCost(p);
  for (const [unit, cap] of Object.entries(BUDGET)) assert.ok(cost[unit] <= cap, `${p.id}: ${cost[unit]} ${unit} > ${cap}`);
  assert.ok(p.layers.includes('trails') && p.layers.includes('names') && p.layers.includes('hillshadeLight'),
    'trails, names and the hillshade context surface all move');
});

test('publicAccess names federal and state-land families, MVUM and rec sites, within budget', () => {
  const p = PRESET_BY_ID.publicAccess;
  assert.ok(p, 'publicAccess must exist');
  const cost = presetCost(p);
  for (const [unit, cap] of Object.entries(BUDGET)) assert.ok(cost[unit] <= cap, `${p.id}: ${cost[unit]} ${unit} > ${cap}`);
  assert.ok(p.layers.includes('federalLand') && p.layers.includes('mvum') && p.layers.includes('recSites'),
    'federal land, MVUM and rec sites move');
  assert.ok(['gameLands', 'stateParks', 'managedAreas'].some((id) => p.layers.includes(id)),
    'at least one state land family moves');
});

test('compareCounties moves the dashboard\'s own county-score switch, through its existing event', () => {
  const p = PRESET_BY_ID.compareCounties;
  assert.ok(p, 'compareCounties must exist');
  assert.ok(p.layers.includes('countyScore'), 'the county score context surface must move');
  assert.ok(p.layers.includes('countyLines'), 'county boundaries move so the compared counties can be told apart');
  assert.equal(presetCost(p).rasterSurfaces, 1);
  // The context group is a choice of one: naming the wash means the wash is the one
  // context surface, and no other competes with it for the same slot.
  assert.equal(p.layers.filter((id) => LAYER_BY_ID[id].group === 'context').length, 1);
});

// The preview helper: what a preset button's aria-describedby says BEFORE it is pressed.
test('presetPreview lists only switches that would move, and the base only when it differs', () => {
  const p = PRESET_BY_ID.compareCounties;
  const already = { ...layerSwitches(p), base: p.base };
  const preview = presetPreview(p, already);
  assert.deepEqual(preview.turnsOn, [], 'nothing to turn on when every switch already matches');
  assert.deepEqual(preview.turnsOff, [], 'nothing to turn off when every switch already matches');
  assert.equal(preview.base, null, 'base already matches, so it is not named');

  const fresh = presetPreview(p, {});
  assert.ok(fresh.turnsOn.includes(LAYER_BY_ID.countyScore.label));
  assert.ok(fresh.turnsOn.includes(LAYER_BY_ID.countyLines.label));
  assert.equal(fresh.base, null, 'an unknown current base makes no claim either way');

  const differentBase = presetPreview(p, { ...layerSwitches(p), base: 'none' });
  assert.equal(differentBase.base, p.base, 'a differing base is named');

  const text = presetPreviewText(p, {});
  assert.match(text, /Turns on:.*County score/i);
  assert.doesNotMatch(text, /[<>]/, 'no markup in reader text');
});

// Road names is lettering on the map, not a topic: no preset lists it, so "every layer a preset
// does not name goes off" must not reach it. A screen-only default-on row is the reader's, not the
// preset's -- the preview never says it turns off and applyPreset leaves it where it is.
test('a default-on screen row is not a preset\'s to turn off, in the preview or the press', () => {
  assert.ok(LAYER_BY_ID.roads.screenOnly && LAYER_BY_ID.roads.defaultOn);
  for (const p of PRESETS) {
    assert.ok(!p.layers.includes('roads'), `${p.id} lists roads; this test is about presets that do not`);
    assert.equal(presetLeavesAlone(LAYER_BY_ID.roads, p), true, `${p.id} would move Road names`);
    assert.ok(!presetPreview(p, { roads: true }).turnsOff.includes('Road names'), `${p.id} preview says it turns Road names off`);
    assert.doesNotMatch(presetPreviewText(p, { roads: true }), /Road names/);
  }
  const asked = definePreset({ id: 'x', label: 'Roads view', question: 'q', base: 'usgsTopo', layers: ['roads'] });
  assert.equal(presetLeavesAlone(LAYER_BY_ID.roads, asked), false, 'a preset that names roads still moves it');
  assert.equal(presetLeavesAlone(LAYER_BY_ID.trails, PRESETS[0]), false, 'an ordinary row is still the preset\'s to move');
});

// N3 made Named places & landmarks open on, like Road names, and J1's fresh-load journey went
// red: the silent initial-view apply read "not listed" as "off" and unticked it, because three
// places (presetLeavesAlone, resetPreset, viewToPresetShape) each spelled "the reader's own row"
// as `screenOnly && defaultOn`. One predicate, `opensOn`, is the only spelling now: every
// default-on row that is not required is the reader's, screen-only or drawn.
test('every row that opens on is the reader\'s, not a preset\'s or a page load\'s, to turn off', () => {
  const own = LAYERS.filter(opensOn);
  assert.deepEqual(own.map((l) => l.id).sort(), ['names', 'roads'], 'the rows that open on');
  assert.ok(own.some((l) => !l.screenOnly), 'at least one of them is drawn, not screen-only -- the case that was unticked');
  assert.equal(opensOn(LAYER_BY_ID.usgsTopo), false, 'a required base is not a switch the reader owns');
  for (const l of own) {
    for (const p of PRESETS.filter((q) => !q.layers.includes(l.id))) {
      assert.equal(presetLeavesAlone(l, p), true, `${p.id} would move ${l.label}`);
      assert.ok(!presetPreview(p, { [l.id]: true }).turnsOff.includes(l.label), `${p.id} preview says it turns ${l.label} off`);
    }
  }
  assert.doesNotMatch(MAIN, /screenOnly && !!l\.defaultOn|l\.screenOnly && l\.defaultOn/,
    'main.js spells the reader\'s own row itself instead of asking opensOn');
  assert.match(MAIN, /LAYERS\.filter\(opensOn\)/, 'viewToPresetShape seeds the initial view with every row that opens on');
});
