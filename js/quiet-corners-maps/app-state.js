// Page state for /quiet-corners/maps/: control values + a lon/lat box -> a
// validated sheet-plan recipe, the page-count summary, the county-finder URL
// recipe, source-state wording and the build-permission rule. Pure (no DOM,
// network, Date or randomness) so node --test covers every rule; main.js only
// wires these to the controls, the map and the print engine.
import { planSheets, serializeRecipe, LIMITS } from './sheet-plan.js';
import { assertPrintable, bboxOfCells, cellFromId, quadsCoveringBox } from './geometry.js';
import { estimate as estimateRender } from './render-protocol.js';
import { FAILURE } from './source-registry.js';
import { LAYERS, LAYER_BY_ID, DEFAULT_LAYERS, enabledLayers } from './layer-registry.js';
// One implementation of the handoff, shared with the dashboard that emits it.
import { WIDTH_MILES, LABEL_MAX, clampMiles, cleanLabel, serializeUrlRecipe } from './handoff.js';
export { serializeUrlRecipe };

export const DEFAULTS = { paper: 'letter', orientation: 'portrait', scale: 24000, overlapIn: 0.5, insetIn: 0.25, dpi: 300, grid: 'utm-1km', layers: DEFAULT_LAYERS, maxPages: 24 };
export const EXAMPLE_AREA = { label: 'Standing Indian / Wayah Bald, North Carolina', bboxLonLat: { minLon: -83.55, minLat: 35.0, maxLon: -83.4, maxLat: 35.1 } };
export const CONUS = { minLat: 24, maxLat: 50, minLon: -125, maxLon: -66 };

const GRIDS = ['utm-1km', 'none'];
const STATES = { ready: 'ready', partial: 'partial', unavailable: 'unavailable', unknown: 'unknown', unchecked: 'not checked yet' };
const CHANGEABLE = ['orientation', 'scale', 'overlapIn', 'dpi', 'grid', 'layers'];
const M_PER_MILE = 1609.344, M_PER_DEG = 111320, FRAME_RATIO = 9.5 / 8.0;
const CHECK_FIRST = 'Check sources before building.';
const BASE_INCOMPLETE = 'USGS Topo must load completely before export.';

function rejectUnknown(obj, allowed, what) {
  if (!obj || typeof obj !== 'object') throw new TypeError(`${what} must be an object`);
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new TypeError(`unknown ${what} key: ${k}`);
}

/** Controls (partial over DEFAULTS) + lon/lat box + title + an optional quad-set selection
 *  (the ids the box was built from, or null for a plain rectangular area) -> validated
 *  recipe for planSheets. */
export function recipeFromControls(controls, bboxLonLat, title, quads = null) {
  rejectUnknown(controls, Object.keys(DEFAULTS), 'control');
  if (controls.layers !== undefined) rejectUnknown(controls.layers, Object.keys(DEFAULTS.layers), 'layer');
  const layers = { ...DEFAULTS.layers, ...(controls.layers || {}) };
  for (const [k, v] of Object.entries(layers)) if (typeof v !== 'boolean') throw new TypeError(`layers.${k} must be true or false`);
  for (const l of LAYERS) {
    if (l.required && !layers[l.id]) throw new RangeError(`${l.label} is the base map and cannot be turned off.`);
  }
  const { layers: _l, grid = DEFAULTS.grid, ...rest } = { ...DEFAULTS, ...controls };
  if (!GRIDS.includes(grid)) throw new RangeError(`grid must be one of ${GRIDS.join(', ')}`);
  const { zone, hemisphere, extent } = assertPrintable(bboxLonLat);
  // A quad set can be far-flung — a handful of disjoint 7.5-minute cells scattered
  // across a county — and still plan under maxPages once the gaps are dropped. But
  // checking that many sheets' worth of ground against every vector source is its own
  // cost, so the envelope itself (the same box a plain rectangular area would be
  // charged for) is capped here, before planning ever runs (plan §0 C10 / §9 D4).
  if (quads && areaKm2(bboxLonLat) > VIEWPORT_FETCH.maxAreaKm2) {
    throw new RangeError('These quadrangles are too far apart to check and print as one set — print them as separate sets.');
  }
  const recipe = { ...rest, extent, zone, hemisphere, title, bboxLonLat: { ...bboxLonLat }, grid, layers };
  if (quads) recipe.quads = quads;
  serializeRecipe(recipe); // sheet-plan validation of every control value, without planning yet
  return recipe;
}

const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const capitalize = (s) => s[0].toUpperCase() + s.slice(1);

/** Sheet plan, render estimate and the human summary for one recipe. */
export function planForRecipe(recipe, { uniqueTiles = null } = {}) {
  const plan = planSheets(recipe);
  const estimate = estimateRender({ plan, dpi: recipe.dpi, uniqueTiles: uniqueTiles ?? 0 });
  const { extent } = plan.input;
  const groundKm = { w: (extent.maxX - extent.minX) / 1000, h: (extent.maxY - extent.minY) / 1000 };
  // A quad set drops grid positions the envelope would otherwise print, so the parenthetical
  // says how many are missing rather than pretending the grid is the whole story.
  const grid = plan.count < plan.gridCount
    ? `${plural(plan.rows, 'row')} × ${plural(plan.cols, 'column')}, ${plural(plan.gridCount - plan.count, 'grid position')} not printed`
    : `${plural(plan.rows, 'row')} × ${plural(plan.cols, 'column')}`;
  const text = `${plural(plan.count, 'page')} (${grid}) at 1:${thousands(recipe.scale)}, `
    + `${capitalize(recipe.paper)} ${recipe.orientation}, ${recipe.overlapIn} in overlap — about ${groundKm.w.toFixed(1)} × ${groundKm.h.toFixed(1)} km`;
  return { plan, estimate, summary: { pages: plan.count, rows: plan.rows, cols: plan.cols, groundKm, text } };
}

/** Lon/lat box `widthMiles` wide east–west at that latitude, a portrait Letter frame tall, centered on the point. */
export function bboxAround(lat, lon, widthMiles = WIDTH_MILES.default) {
  const widthM = widthMiles * M_PER_MILE;
  const dLon = widthM / (M_PER_DEG * Math.cos(lat * Math.PI / 180)) / 2;
  const dLat = (widthM * FRAME_RATIO) / M_PER_DEG / 2;
  return { minLon: lon - dLon, minLat: lat - dLat, maxLon: lon + dLon, maxLat: lat + dLat };
}

const finiteParam = (s) => (typeof s === 'string' && s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : null);

/** County-finder handoff `?v=1&lat=..&lon=..[&w=miles][&label=..]` -> { bboxLonLat, label, widthMiles }, or null. Never throws. */
export function parseUrlRecipe(search) {
  try {
    const q = new URLSearchParams(typeof search === 'string' ? search : '');
    if (q.get('v') !== '1') return null;
    const lat = finiteParam(q.get('lat')), lon = finiteParam(q.get('lon'));
    if (lat === null || lon === null || lat < CONUS.minLat || lat > CONUS.maxLat || lon < CONUS.minLon || lon > CONUS.maxLon) return null;
    const w = q.has('w') ? finiteParam(q.get('w')) : WIDTH_MILES.default;
    if (w === null) return null;
    const widthMiles = clampMiles(w);
    const label = cleanLabel(q.get('label'));
    return { bboxLonLat: bboxAround(lat, lon, widthMiles), label: label || null, widthMiles };
  } catch {
    return null;
  }
}


function stateWord(state, name) {
  if (!STATES[state]) throw new RangeError(`${name} state must be one of ${Object.keys(STATES).join(', ')}`);
  return STATES[state];
}

/** The rows Build waits on: exactly the layers the build fetches for this area
 *  (enabledLayers) -- the base map, and each overlay that is switched on, that the
 *  source pass fetches, and, for a state land layer, that a state in the area
 *  publishes. canBuild and the line under the button both read this, so the line
 *  names exactly the rows that hold the button back. */
function waitsOn(layers, areaStates) {
  const ids = new Set(enabledLayers(layers, areaStates).map((l) => l.id));
  return (l) => ids.has(l.id);
}

/** 'USGS Topo: ready · MVUM: partial'; unchecked reads 'not checked yet'. One clause
 *  per row Build waits on, so a new layer needs no edit here and a row that is off, or
 *  never fetched, does not pad the line with 'not checked yet'. */
export function sourceStateLine(states, layers, areaStates = null) {
  const waits = waitsOn(layers, areaStates);
  return LAYERS.filter((l) => waits(l) && states[l.id] !== undefined)
    .map((l) => `${l.label}: ${stateWord(states[l.id], l.id)}`).join(' \u00b7 ');
}

/** Build only when the base map is ready and every enabled overlay the build fetches
 *  is ready. A disabled overlay is ignored, and so is a row no pass ever answers: a
 *  screen-only row, an extra page, or a state land layer no state in the area
 *  publishes. Each would read 'unchecked' forever. */
export function canBuild({ states, layers, areaStates = null }) {
  const block = (reason) => ({ ok: false, reason });
  const waits = waitsOn(layers, areaStates);
  for (const l of LAYERS) {
    if (!waits(l)) continue;                         // off, or no Check pass ever answers it
    if (states[l.id] === undefined) continue;
    if (states[l.id] === 'unchecked') return block(CHECK_FIRST);
    if (stateWord(states[l.id], l.id) === 'ready') continue;
    // A required layer failing is a base-map failure; an overlay failing is a
    // coverage question, and its own emptyMeans decides the wording.
    return block(l.required ? BASE_INCOMPLETE : FAILURE.coverageUnknown);
  }
  return { ok: true, reason: null };
}

/** Per-layer sentence: distinguishes "answered, nothing here" from "no coverage",
 *  which the one-line summary above cannot. Branches on the registry's
 *  emptyMeans, never on a layer id. */
export function layerReport({ layerId, state, featureCount = null }) {
  const layer = LAYER_BY_ID[layerId];
  if (!layer) throw new RangeError(`unknown layer ${layerId}`);
  const say = (s, text) => ({ id: layerId, state: s, text: `${layer.label}: ${text}` });
  if (state === 'unchecked') return say('unchecked', 'not checked yet.');
  if (state !== 'ready') return say('blocked', FAILURE.coverageUnknown);
  if (featureCount === null) return say('ready', 'ready.');
  if (featureCount > 0) return say('ready', `${featureCount} feature${featureCount === 1 ? '' : 's'} in this area.`);
  return layer.emptyMeans === 'ambiguous'
    ? say('empty', `answered, but returned nothing. ${layer.coverageCaveat}`)
    : say('empty', 'answered, and there is nothing of this kind in this area.');
}

/**
 * Which fetched sources a control change actually invalidates.
 *
 * Every vector layer is asked for one thing — `recipe.bboxLonLat` — so choosing
 * landscape, widening the overlap, dropping the grid or ticking a layer on cannot
 * change a single answer already in hand. Scale and DPI are the exception: they
 * set the sheet's metres-per-pixel, which picks the topo tile level (`build.js`
 * `tilePlan` -> `chooseLevel`), so they ask for tiles nobody has checked.
 *
 * An area change is not a control change and is rejected here: a new bbox
 * invalidates everything, and the caller that moves the area says so itself.
 */
export function sourcesInvalidatedBy(change) {
  rejectUnknown(change, CHANGEABLE, 'change');
  return Object.keys(change).some((k) => k === 'scale' || k === 'dpi') ? ['usgsTopo'] : [];
}

/**
 * Browsing the map is not the print recipe. What a settled viewport should ask
 * for, and for which box — `{ layers: [], bboxLonLat: null, reason }` when the
 * honest answer is "nothing".
 *
 * Every refusal is a bound, not a preference:
 *  - Below `minZoom` the USGS topo base is not drawn at all, so there is no field
 *    map to overlay; asking would spend a query on a view that cannot use it.
 *  - Over `maxAreaKm2` the vector services either time out or return a truncated
 *    answer that looks complete (the F14 failure), so a state-sized view is
 *    refused outright rather than half-answered.
 *  - The base map is a tile layer that already follows the viewport itself, and an
 *    extra sheet is never drawn on the map — `enabledLayers` excludes both.
 *  - A view that sits inside the box the sources already came from asks for
 *    nothing, UNLESS a layer switched on since then was not in that answer. That
 *    second half is the reason `states` is a parameter: containment alone would
 *    leave a freshly ticked layer permanently missing while panning.
 */
export const VIEWPORT_FETCH = Object.freeze({ minZoom: 9, maxAreaKm2: 2500, settleMs: 600 });

const areaKm2 = (b) => {
  const midLat = (b.minLat + b.maxLat) / 2;
  const w = (b.maxLon - b.minLon) * M_PER_DEG * Math.cos(midLat * Math.PI / 180);
  return Math.abs(w * (b.maxLat - b.minLat) * M_PER_DEG) / 1e6;
};
const covers = (outer, inner) => outer.minLon <= inner.minLon && outer.minLat <= inner.minLat
  && outer.maxLon >= inner.maxLon && outer.maxLat >= inner.maxLat;

/** Were the sources in hand fetched for exactly this area? The one guard that makes
 *  viewport browsing safe to print from: a browse fetch answers for the view, which
 *  is not the print box, and a PDF must only ever draw the area it says it drew.
 *  Never true before any fetch. Exact corners, deliberately — "close enough" is how
 *  a sheet ends up with features from next door. */
export function sourcesMatchArea(fetchedFor, bboxLonLat) {
  if (!fetchedFor || !bboxLonLat) return false;
  return ['minLon', 'minLat', 'maxLon', 'maxLat'].every((k) => fetchedFor[k] === bboxLonLat[k]);
}

/** No print area selected: the state Clear returns to and the state a fresh page
 *  boots with. */
export const NO_AREA = Object.freeze({ area: null, title: null, undo: null });

/** A new area is drawn or edited. The area it replaces (if any) becomes the one-step
 *  undo; an undo already in hand from a prior Clear is carried forward untouched so a
 *  Clear-then-redraw-then-Clear sequence still offers the earlier area back, not the
 *  one just overwritten. `area` is one of the shapes areaFromBox/areaFromQuads return
 *  -- a box selection and a quad-set selection go through the exact same transition. */
export function areaSet(current, area, title) {
  const undo = current.area ? { area: current.area, title: current.title } : current.undo;
  return { area, title, undo };
}

/** Clear: the area (if any) becomes the one-step undo. Clearing an already-empty
 *  area is a no-op so a stray Clear cannot overwrite a real undo with nothing. */
export function areaCleared(current) {
  if (!current.area) return current;
  return { area: null, title: null, undo: { area: current.area, title: current.title } };
}

/** Undo: restores the captured area exactly once. With nothing to undo it is a
 *  no-op, matching the existing layer-preset Undo contract (one step, not a stack). */
export function areaUndone(current) {
  if (!current.undo) return current;
  return { area: current.undo.area, title: current.undo.title, undo: null };
}

/** A plain rectangular selection. */
export function areaFromBox(bbox) {
  return { kind: 'box', bbox };
}

// Canonical quad-id order: row descending (north to south), then column ascending
// (west to east) -- the same order quadsCoveringBox returns and sheet-plan.js's
// sortQuadIds enforces on the recipe, so a selection built here round-trips through
// the recipe unchanged.
function sortQuadIds(ids) {
  const parsed = ids.map((id) => { const [row, col] = id.split(':').map(Number); return { id, row, col }; });
  parsed.sort((a, b) => b.row - a.row || a.col - b.col);
  return parsed.map((p) => p.id);
}

/** A quad-set selection: null when empty (removing the last quad clears the area,
 *  not leaves an empty set), otherwise deduped and sorted into canonical order. */
export function areaFromQuads(ids) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return null;
  return { kind: 'quads', ids: sortQuadIds(unique) };
}

/** The bounding box of a selection, whichever kind it is -- the value every existing
 *  reader (terrain getter, sourcePass, build's sourcesMatchArea) keeps reading as
 *  state.bbox regardless of how the area was selected. */
export function areaEnvelope(area) {
  if (!area) return null;
  return area.kind === 'quads' ? bboxOfCells(area.ids.map(cellFromId)) : area.bbox;
}

/** One quadrangle clicked on the map, in the ring, or picked from quad search:
 *  - quads mode: add id if it is not already selected, else remove it (last one
 *    removed -> null, which callers treat the same as Clear).
 *  - box mode: snaps the box outward to the quads it covers, plus id (D3) -- this
 *    is a one-way conversion; the box itself becomes the one-step undo.
 *  - no area: a single-quad selection. */
export function quadToggled(area, id) {
  if (!area) return areaFromQuads([id]);
  if (area.kind === 'quads') {
    const ids = area.ids.includes(id) ? area.ids.filter((x) => x !== id) : [...area.ids, id];
    return areaFromQuads(ids);
  }
  return areaFromQuads([...quadsCoveringBox(area.bbox), id]);
}

/** Per-quad page savings for the recipe's current quad set: { id -> pagesSaved },
 *  pagesSaved = count(all) - count(all without id). Plans with maxPages raised to
 *  LIMITS.maxRows * LIMITS.maxCols so it still answers when the current selection
 *  is over the ordinary 24-page limit -- the reader needs exactly this number to
 *  see which quad to drop to get under it. Removing the last remaining quad reports
 *  null for that id ("clears the area"), not a page count. */
export function quadSavings(recipe) {
  const ids = recipe.quads;
  if (!ids || ids.length === 0) return null;
  const maxPages = LIMITS.maxRows * LIMITS.maxCols;
  const controls = {};
  for (const k of Object.keys(DEFAULTS)) controls[k] = k === 'layers' ? { ...recipe.layers } : recipe[k];
  controls.maxPages = maxPages;
  const countFor = (subset) => {
    if (!subset.length) return 0;
    const bbox = bboxOfCells(subset.map(cellFromId));
    return planSheets(recipeFromControls(controls, bbox, recipe.title, subset)).count;
  };
  const all = countFor(ids);
  const savings = {};
  for (const id of ids) {
    const rest = ids.filter((x) => x !== id);
    savings[id] = rest.length === 0 ? null : all - countFor(rest);
  }
  return savings;
}

export function viewportFetchPlan({ bboxLonLat, zoom, layers = {}, states = {}, areaStates = null, fetchedFor = null }) {
  // `code` separates the two refusals worth telling the reader about ('zoom',
  // 'area' \u2014 a layer is on and this view cannot serve it) from the two that are
  // simply nothing to say ('none-on', 'held'). Saying every one of them would put a
  // sentence on the status line on every pan.
  const skip = (code, reason) => ({ layers: [], bboxLonLat: null, code, reason });
  // The names layer is not one of these: it runs its own per-view pass (main.js runNames, sized by
  // namesPlanForView and fetchBounded's rung budget), so it never rides the zoom/area gates below and
  // its state, never set by a browse pass, cannot hold the `held` check false on every pan.
  const wanted = enabledLayers(layers, areaStates).filter((l) => !l.required && l.id !== 'names').map((l) => l.id);
  if (!wanted.length) return skip('none-on', 'No map layers are switched on.');
  if (!Number.isFinite(zoom) || zoom < VIEWPORT_FETCH.minZoom) return skip('zoom', `Zoom in to level ${VIEWPORT_FETCH.minZoom} to load map layers here.`);
  if (areaKm2(bboxLonLat) > VIEWPORT_FETCH.maxAreaKm2) return skip('area', 'This view covers too much ground to load in full \u2014 zoom in.');
  const held = (id) => states[id] !== undefined && states[id] !== 'unchecked';
  if (fetchedFor && covers(fetchedFor, bboxLonLat) && wanted.every(held)) {
    return skip('held', 'This view is inside the area already loaded.');
  }
  return { layers: wanted, bboxLonLat: { ...bboxLonLat }, code: 'fetch', reason: null };
}

/** One source pass at a time. `run(opts)` is a pass that writes shared page state
 *  as it goes -- layer states, the land list, the box it answered for -- so two
 *  passes side by side leave a mix of both. That happened on 2026-09-26: choosing
 *  the example area moved the map, the debounced viewport browse fired while the
 *  Check button's pass was still out, and the badge read whichever finished last.
 *
 *  So a pass asked while another runs waits its turn. A BROWSE asked then is not
 *  queued at all: it was planned against state the running pass is about to
 *  replace, so it is dropped and `onIdle()` is called once the queue drains, to
 *  plan again against the new state (usually finding the view already held).
 *  A failed pass never jams the queue; its caller still sees the rejection. */
export function sourcePassQueue(run, onIdle) {
  let inFlight = null;
  let replan = false;
  return function ask(opts = {}) {
    if (opts.browse && inFlight) { replan = true; return inFlight.catch(() => {}); }
    const prior = inFlight ? inFlight.catch(() => {}) : Promise.resolve();
    const pass = prior.then(() => run(opts));
    inFlight = pass;
    const settle = () => {
      if (inFlight !== pass) return;       // a later pass is queued behind this one
      inFlight = null;
      if (replan) { replan = false; onIdle(); }
    };
    pass.then(settle, settle);
    return pass;
  };
}

/** Immutable control update (orientation/scale/overlapIn/dpi/grid/layers.*), re-validated from scratch. */
export function applyChange(recipe, change) {
  rejectUnknown(change, CHANGEABLE, 'change');
  const controls = {};
  for (const k of Object.keys(DEFAULTS)) controls[k] = k === 'layers' ? { ...recipe.layers } : recipe[k];
  Object.assign(controls, change, change.layers ? { layers: { ...recipe.layers, ...change.layers } } : {});
  // A control change (orientation, scale, overlap...) never touches which quads were
  // selected. Rebuilding without carrying recipe.quads through would silently fall back
  // to the plain rectangular envelope on the very next replan — the R1 migration trap.
  return recipeFromControls(controls, recipe.bboxLonLat, recipe.title, recipe.quads ?? null);
}

const OTHER_ORIENTATION = { portrait: 'landscape', landscape: 'portrait' };

/**
 * The other orientation, when it plans strictly fewer pages for the same ground — the
 * one paper saving worth more than any margin trim. `null` when it ties, costs more, or
 * will not plan at all (over the page/row/column limits), so this never nags.
 */
export function orientationAdvice(recipe) {
  const other = OTHER_ORIENTATION[recipe.orientation];
  if (!other) return null;
  const now = planForRecipe(recipe).summary;
  let alt;
  try {
    alt = planForRecipe(applyChange(recipe, { orientation: other })).summary;
  } catch {
    return null;
  }
  if (alt.pages >= now.pages) return null;
  const saved = now.pages - alt.pages;
  // A quad set's row/column count describes the envelope grid, not the sheets that
  // actually print, so the "(R rows × C columns)" aside would name a shape the reader
  // never sees. Drop it in quads mode; the page counts alone still make the case.
  const text = recipe.quads
    ? `${capitalize(other)} would need ${plural(alt.pages, 'page')} instead of ${now.pages} — `
      + `the same ground on ${plural(saved, 'fewer sheet')}.`
    : `${capitalize(other)} would need ${plural(alt.pages, 'page')} `
      + `(${plural(alt.rows, 'row')} × ${plural(alt.cols, 'column')}) instead of ${now.pages} — `
      + `the same ground on ${plural(saved, 'fewer sheet')}.`;
  return { orientation: other, pages: alt.pages, rows: alt.rows, cols: alt.cols,
    currentPages: now.pages, currentRows: now.rows, currentCols: now.cols, saved, text };
}
