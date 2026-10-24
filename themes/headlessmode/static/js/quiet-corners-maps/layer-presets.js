// Two named SETS of switches the Layers panel already has. Pure: no DOM, no network.
//
// A preset is NOT a new way for a layer to reach the map. It moves the reader's own
// checkboxes and base radio; every layer still arrives through the registry's toggle and
// main.js's one change handler, so there is no second path to keep in step. Nothing it
// touches is left disabled: a shortcut, never a mode, and every switch it moved can be
// moved straight back. S10 asks for clutter and load size to be MEASURED before the set is
// broadened, so BUDGET is that measurement as numbers `definePreset` refuses to exceed — an
// over-budget preset throws while this module is evaluated, by the page and by every test
// that imports it. Robust by construction, not a gate that finds it later.
import { LAYERS, LAYER_BY_ID, enabledLayers } from './layer-registry.js';
import { BASE_BY_ID } from './source-basemaps.js';

/** What a preset may cost, measured on the two below rather than guessed.
 *
 *  `fetchLayers` — a layer switched on that is neither `screenOnly` nor an `extraPage` is one
 *  bbox query of its own, and arcgis-pager.js pages each query up to MAX_PAGES = 20 requests
 *  of PAGE_CAP = 2000 features. Six layers is a worst case of 120 requests for ONE settled
 *  view; the whole registry ticked (seven federal plus four state families) would be 220. Six
 *  is what the public-land set measured at, and the ceiling stays there until a wider set has
 *  been measured too.
 *  `rasterSurfaces` — the context group's two tile surfaces composite multiplicatively over
 *  the base: lights draw at opacity 0.8 (source-night-lights.js leafletOptions) and radar at
 *  0.55 (source-nws-radar.js radarLayer), so together the base keeps 0.2 x 0.45 of its light,
 *  under a tenth, and nothing beneath is readable. At most ONE. Aurora and air quality are
 *  vector rectangles drawn only where their value is non-trivial, so they may accompany it --
 *  they are independent checkboxes in the panel, not part of the surface choice (QQA-06d).
 *  `symbolKeys` — the distinct marks a preset can draw, which is also the rows a reader scans
 *  in the map key beside it. Nineteen is the public-land set; the night set draws one.
 *  Task completion, the plan's third measure, is the one that is not mechanical: it is
 *  watched, not asserted. What this file holds it to is that a preset states the question it
 *  claims to answer — `question` is required below. */
export const BUDGET = Object.freeze({ fetchLayers: 6, rasterSurfaces: 1, symbolKeys: 19 });

/** QUX-04b: the chooser row (`#qcm-presets`) reads as NAMES, not sentences — a name long
 *  enough to answer the question itself (the original "A day out on public land") is the
 *  clutter the starting-set redesign moved out of the row. Guarded in `definePreset` so a
 *  future preset cannot reintroduce a long label without the module refusing to load. */
export const MAX_LABEL_WORDS = 3;

/** The switch positions a preset asks for — EVERY registry layer, so applying one is a
 *  complete statement, not a partial merge: a layer it does not name goes off. A `required`
 *  layer is never a preset's to move — the printed sheet's raster is always topo. */
export function layerSwitches(preset) {
  return Object.freeze(Object.fromEntries(LAYERS.map((l) => [l.id, l.required || preset.layers.includes(l.id)])));
}

/** True for a row the page opens with ON and the reader owns from then on: default-on and not
 *  `required` (a required base is no switch at all). Road names and Named places & landmarks are
 *  lettering on the map, not a topic a preset or a saved view is about, so neither gets to read
 *  "not listed" as "off" for them. This is the ONE spelling of that rule -- presetLeavesAlone,
 *  resetPreset and viewToPresetShape all ask here; each spelled it as `screenOnly && defaultOn`
 *  before, and the first drawn (not screen-only) default-on row was unticked on every fresh load. */
export function opensOn(layer) {
  return !layer.required && !!layer.defaultOn;
}

/** True for a row a preset does not get to move: a `required` layer, and a row that opens on
 *  (opensOn) the preset does not itself name, so "a layer it does not name goes off" stops short
 *  of the lettering the page opened with. A preset that DOES list it moves it. */
export function presetLeavesAlone(layer, preset) {
  return !!layer.required || (opensOn(layer) && !preset.layers.includes(layer.id));
}

/** What one preset costs on one settled viewport, in the three units BUDGET caps. */
export function presetCost(preset) {
  const on = layerSwitches(preset);
  const drawn = LAYERS.filter((l) => on[l.id] && !l.required && !l.extraPage);
  return Object.freeze({
    fetchLayers: enabledLayers(on).filter((l) => !l.required).length,
    rasterSurfaces: drawn.filter((l) => l.rasterSurface).length,
    symbolKeys: new Set(drawn.flatMap((l) => l.symbolKeys)).size,
  });
}

/** A preset, or a throw. Every name is resolved against the registry and the base list HERE,
 *  at module load, so a preset naming a layer that does not exist cannot be a preset at all.
 *  Exported only so the gate can be proven to bite; PRESETS below is the one place the app
 *  defines one, and all main.js imports. */
export function definePreset({ id, label, question, base, layers }) {
  const bad = (why) => { throw new RangeError(`preset ${id}: ${why}`); };
  if (!label || !question) bad('needs a label and the question it answers');
  const labelWords = label.trim().split(/\s+/).length;
  if (labelWords > MAX_LABEL_WORDS) bad(`label is ${labelWords} words, over the ${MAX_LABEL_WORDS}-word cap`);
  if (!BASE_BY_ID[base]) bad(`no such base map ${base}`);
  for (const l of layers) {
    if (!LAYER_BY_ID[l]) bad(`no such layer ${l}`);
    if (LAYER_BY_ID[l].required) bad(`${l} is required and is not a preset's to switch`);
  }
  if (new Set(layers).size !== layers.length) bad('names a layer twice');
  // The raster context surfaces are a choice of ONE (layer-registry.js contextControlSpecs),
  // so a preset naming two is a set the panel cannot hold. Refused here rather than silently
  // dropped by applyPreset, which would leave the reader a set nobody asked for. A vector
  // context overlay (fire, air quality) is an independent checkbox and may accompany one.
  const surfaces = layers.filter((l) => LAYER_BY_ID[l].group === 'context' && LAYER_BY_ID[l].rasterSurface);
  if (surfaces.length > 1) bad(`names ${surfaces.length} raster context surfaces and the map draws one context surface at a time`);
  const p = Object.freeze({ id, label, question, base, layers: Object.freeze([...layers]) });
  const cost = presetCost(p);
  for (const [unit, cap] of Object.entries(BUDGET)) {
    if (cost[unit] > cap) bad(`${cost[unit]} ${unit} is over the measured budget of ${cap}`);
  }
  return p;
}

export const PRESETS = Object.freeze([
  // The sky question. The boundary families are off: none says anything about tonight, and
  // each is ink and a query spent elsewhere. Radar is off for two reasons — it is the SECOND
  // view-filling picture, which the budget refuses, and it reports precipitation the beam met
  // in the minutes just past, not cloud tonight (the hourly card answers the hours ahead).
  // The base is `none` by the same arithmetic: a topo sheet read through a surface drawn at
  // 0.8 is not a topo sheet, and the county wash stays either way.
  definePreset({
    id: 'nightSky',
    label: 'Night sky',
    question: 'Is tonight worth the drive from here — and how far out would you have to go?',
    base: 'none',
    // ONE surface, not three. The context group became a choice of one, so asking for the
    // lights AND the aurora AND the air quality was asking for a set the panel cannot hold
    // -- and always had been: three filled surfaces over each other leave nothing readable.
    // The lights are the one that answers the question the preset asks, and the other two
    // stay a radio click away with their own captions.
    layers: ['nightLights'],
  }),
  // The ground question, and the largest set measured: where the federal designations are,
  // whose parcel you are on inside a National Forest, which roads and trails you may use and
  // when, and where you may stop. Topo underneath, because this set is read against terrain.
  definePreset({
    id: 'publicLandDay',
    label: 'Public land',
    question: 'Where may I legally go around here, and what is there when I arrive?',
    base: 'usgsTopo',
    layers: ['federalLand', 'surfaceOwnership', 'mvum', 'trails', 'recSites', 'blmRecSites'],
  }),
  // U1 (F03): task presets, added to the two S10 presets above rather than replacing them.
  // The opening experience the plan asks for -- "a normal base map, local orientation
  // names, and compact controls; no county tint or score thresholds apply until the
  // reader chooses them" -- is what the panel already shows before any preset is pressed;
  // this one names that state explicitly, as a switch a reader can get back to.
  definePreset({
    id: 'mapOnly',
    label: 'Map only',
    question: 'What does the ground itself look like here, with nothing else drawn over it?',
    base: 'usgsTopo',
    layers: [],
  }),
  // The trail-and-terrain question: read a route against the shape of the ground under
  // it. Named places carry the ridge/gap/summit vocabulary a trail's own line does not
  // state, and the hillshade context surface is the one context slot spent on relief
  // rather than a sky or ground picture -- the pair the plan calls "hillshade context +
  // names on".
  definePreset({
    id: 'trailsTerrain',
    label: 'Trails & terrain',
    question: 'Which trails are here, and what does the ground do around them?',
    base: 'usgsTopo',
    layers: ['trails', 'names', 'hillshadeLight'],
  }),
  // Federal AND state land in one set: the two families the plan asks for ("federal land
  // + state land families + MVUM/roads + rec sites"), distinct from publicLandDay above by
  // reaching into state-managed land where the drawn area has it, rather than the Forest
  // Service's own land-status record (surfaceOwnership) and BLM's separate rec-site feed.
  // The three state families named are the ones layer-registry.js's `land()` rows
  // describe in access terms ("Camping, fires and vehicle access vary"); parcels is left
  // off -- a 1:24,000-only boundary about ownership, not access, is a different question.
  definePreset({
    id: 'publicAccess',
    label: 'Land access',
    question: 'Which public and state-managed land reaches this ground, and how do I get onto it?',
    base: 'usgsTopo',
    layers: ['federalLand', 'mvum', 'recSites', 'gameLands', 'stateParks', 'managedAreas'],
  }),
  // The county-comparison question, reached through the SAME switch the dashboard's own
  // "turn scores on" row moves (window.qcSetScoresSurface, main.js's renderCountyScore) --
  // never a second state. County lines go on so the compared counties can be told apart;
  // nothing else moves, so nothing competes with the wash for the one context slot.
  definePreset({
    id: 'compareCounties',
    label: 'Compare counties',
    question: 'How does this county compare to the ones around it?',
    base: 'usgsTopo',
    layers: ['countyLines', 'countyScore'],
  }),
  // The noise question, asked of the three things a noise map is made of. ONE surface (the 2020
  // modelled noise tiles) with rail lines and airports as checkboxes over it -- possible only
  // because those two are not context rows, and the context group is a choice of one. Roads and
  // names are the screen lettering that lets a reader place the picture; the topo base stays under.
  // Road names open ON and a preset leaves such a row alone unless it lists it (layer-presets.test:
  // no preset lists roads), so they are part of this set by staying on, not by being named here.
  definePreset({
    id: 'loudOrQuiet',
    label: 'Loud or quiet',
    question: 'Is this place near the rail lines and airports that make it loud, or away from them?',
    base: 'usgsTopo',
    layers: ['transportNoise', 'railClass1', 'airports', 'names'],
  }),
  // QQA-18b, the plan's "Check conditions" task preset, built from the Weather & conditions
  // group. Radar is the group's one view-filling surface; air quality, smoke and fire
  // perimeters are vector overlays that sit beside it (QQA-06d), so the set obeys the
  // one-surface rule by construction and costs no fetched layer (all four are screen-only).
  // Flood zones are left out on purpose: a regulatory floodplain is not a condition, and
  // laying it beside a weather alert is the misreading the registry warns about -- it is one
  // switch away. Topo stays under it: radar is clear where nothing falls, unlike the lights.
  // "Explore outdoors", the plan's other task preset, is not a button of its own: it is
  // `publicLandDay` (where may I go, and what is there) and `trailsTerrain` (which trails,
  // and what the ground does), and a third set over the same rows would be a near-duplicate.
  // Ids never change -- saved and shared views restore a preset by id.
  definePreset({
    id: 'checkConditions',
    label: 'Check conditions',
    question: 'What are the rain, the air and any fires doing around here?',
    base: 'usgsTopo',
    layers: ['nwsRadar', 'epaAirNowAqi', 'noaaHmsSmoke', 'nifcFirePerimeters'],
  }),
]);
export const PRESET_BY_ID = Object.freeze(Object.fromEntries(PRESETS.map((p) => [p.id, p])));

/** What the page says once a preset is applied: the switches it moved ON, because a shortcut
 *  whose effect a reader cannot see is a mode, and that they are still theirs, because that is
 *  the difference. `moved` is in panel order. */
export function presetApplied(preset_, moved = []) {
  const p = typeof preset_ === 'string' ? PRESET_BY_ID[preset_] : preset_;
  if (!p) throw new RangeError(`unknown preset ${preset_}`);
  const on = moved.length ? `Switched on: ${moved.join(', ')}.` : 'Nothing changed — these switches were already set.';
  return `${p.label}. ${p.question} ${on} Every switch is still yours to change.`;
}

/** What a preset button's `aria-describedby` element says BEFORE the button is pressed --
 *  which switches would move, in the reader's own labels, and only the ones that would
 *  actually change: a switch already in the preset's position is not "turned on" again,
 *  and the base is named only when the reader's current base disagrees with the preset's.
 *  `currentSwitches` is the same shape `layerSwitches()` returns, plus an optional `base`
 *  key; an unknown/omitted base makes no claim either way, since "differs" needs a value
 *  to differ FROM. A layer a preset leaves alone (presetLeavesAlone) is never listed. */
export function presetPreview(preset, currentSwitches = {}) {
  const desired = layerSwitches(preset);
  const turnsOn = [];
  const turnsOff = [];
  for (const l of LAYERS) {
    if (presetLeavesAlone(l, preset)) continue;
    const now = currentSwitches[l.id] === true;
    const want = desired[l.id];
    if (want && !now) turnsOn.push(l.label);
    else if (!want && now) turnsOff.push(l.label);
  }
  const base = currentSwitches.base !== undefined && currentSwitches.base !== preset.base ? preset.base : null;
  return Object.freeze({ turnsOn: Object.freeze(turnsOn), turnsOff: Object.freeze(turnsOff), base });
}

/** `presetPreview`, rendered as the one line of reader text the preview element shows. */
export function presetPreviewText(preset, currentSwitches = {}) {
  const { turnsOn, turnsOff, base } = presetPreview(preset, currentSwitches);
  const parts = [turnsOn.length ? `Turns on: ${turnsOn.join(', ')}.` : 'Turns on: nothing — already set.'];
  if (turnsOff.length) parts.push(`Turns off: ${turnsOff.join(', ')}.`);
  if (base) parts.push(`Base: ${BASE_BY_ID[base].label}.`);
  return parts.join(' ');
}

/** Every string this module can show a reader, for the gates that read reader text. */
export function readerStrings() {
  return Object.freeze([
    ...PRESETS.flatMap((p) => [p.label, p.question]),
    presetApplied(PRESETS[0], ['x']),
    presetApplied(PRESETS[0]),
    presetPreviewText(PRESET_BY_ID.compareCounties, {}),
  ]);
}
