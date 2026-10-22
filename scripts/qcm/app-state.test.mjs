// Tests for the pure page-state layer behind /quiet-corners/maps/.
// Runs under Node's built-in runner: node --test "scripts/qcm/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS, EXAMPLE_AREA, CONUS, recipeFromControls, planForRecipe, bboxAround,
  parseUrlRecipe, serializeUrlRecipe, sourceStateLine, canBuild, applyChange, orientationAdvice,
  sourcesInvalidatedBy, viewportFetchPlan, VIEWPORT_FETCH, sourcesMatchArea, sourcePassQueue,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/app-state.js';
import { readFileSync } from 'node:fs';
import { DEFAULT_LAYERS, LAYERS, LAYER_IDS, enabledLayers } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';
import { FAILURE } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} != ${b}`);
const M_PER_MILE = 1609.344, M_PER_DEG = 111320;
const recipe = () => recipeFromControls({}, EXAMPLE_AREA.bboxLonLat, 'Standing Indian');

test('recipeFromControls: defaults, zone, extent; rejects unknown keys and non-CONUS areas', () => {
  const r = recipe();
  assert.equal(r.zone, 17);
  assert.equal(r.hemisphere, 'N');
  near(r.extent.maxX - r.extent.minX, 13960, 50, 'extent width');
  near(r.extent.maxY - r.extent.minY, 11430, 50, 'extent height');
  for (const k of ['paper', 'orientation', 'scale', 'overlapIn', 'insetIn', 'dpi', 'maxPages', 'grid']) assert.equal(r[k], DEFAULTS[k]);
  assert.deepEqual(r.layers, DEFAULTS.layers);
  assert.deepEqual(r.bboxLonLat, EXAMPLE_AREA.bboxLonLat);
  assert.equal(r.title, 'Standing Indian');
  assert.throws(() => recipeFromControls({ foo: 1 }, EXAMPLE_AREA.bboxLonLat, 't'), TypeError);
  assert.throws(() => recipeFromControls({ scale: 1000 }, EXAMPLE_AREA.bboxLonLat, 't'), RangeError);
  assert.throws(() => recipeFromControls({}, { minLon: -150, minLat: 61, maxLon: -149.8, maxLat: 61.2 }, 't'), /contiguous/);
  assert.deepEqual(CONUS, { minLat: 24, maxLat: 50, minLon: -125, maxLon: -66 });
});

test('planForRecipe: pages, summary text, estimate; landscape and 1:48,000 variants', () => {
  const { plan, estimate, summary } = planForRecipe(recipe());
  assert.equal(plan.count, 9);
  assert.deepEqual([summary.pages, summary.rows, summary.cols], [9, 3, 3]);
  near(summary.groundKm.w, 13.96, 0.01, 'ground km w');
  near(summary.groundKm.h, 11.43, 0.01, 'ground km h');
  assert.equal(summary.text, '9 pages (3 rows × 3 columns) at 1:24,000, Letter portrait, 0.5 in overlap — about 14.0 × 11.4 km');
  assert.equal(estimate.safe, true);
  assert.equal(planForRecipe(recipe(), { uniqueTiles: 10 }).estimate.downloadBytesEstimate, 200000);
  const land = planForRecipe(recipeFromControls({ orientation: 'landscape' }, EXAMPLE_AREA.bboxLonLat, 't'));
  assert.deepEqual([land.summary.rows, land.summary.cols], [3, 3]);
  assert.ok(land.plan.groundWidthM > plan.groundWidthM);
  assert.match(land.summary.text, /Letter landscape/);
  const half = planForRecipe(recipeFromControls({ scale: 48000 }, EXAMPLE_AREA.bboxLonLat, 't'));
  assert.deepEqual([half.summary.pages, half.summary.rows, half.summary.cols], [2, 1, 2]);
  assert.match(half.summary.text, /^2 pages \(1 row × 2 columns\) at 1:48,000/);
});

test('bboxAround: 8 miles wide at the latitude, Letter frame ratio tall, centered', () => {
  const lat = 35.0327, lon = -83.5299;
  const b = bboxAround(lat, lon, 8);
  const widthM = 8 * M_PER_MILE;
  near(b.maxLon - b.minLon, widthM / (M_PER_DEG * Math.cos(lat * Math.PI / 180)), 1e-9, 'lon span');
  near((b.maxLat - b.minLat) * M_PER_DEG / widthM, 9.5 / 8.0, 1e-6, 'height/width');
  near((b.minLon + b.maxLon) / 2, lon, 1e-9, 'center lon');
  near((b.minLat + b.maxLat) / 2, lat, 1e-9, 'center lat');
  assert.deepEqual(bboxAround(lat, lon), b);
});

test('parseUrlRecipe: valid handoff, clamps, and every invalid form is null', () => {
  const p = parseUrlRecipe('?v=1&lat=35.0327&lon=-83.5299');
  assert.equal(p.widthMiles, 8);
  assert.equal(p.label, null);
  assert.deepEqual(p.bboxLonLat, bboxAround(35.0327, -83.5299, 8));
  assert.equal(parseUrlRecipe('?v=1&lat=35.0327&lon=-83.5299&w=40').widthMiles, 20);
  assert.equal(parseUrlRecipe('?v=1&lat=35.0327&lon=-83.5299&w=0.2').widthMiles, 1);
  assert.equal(parseUrlRecipe('?v=1&lat=35.0327&lon=-83.5299&label=' + 'x'.repeat(100)).label.length, 60);
  assert.equal(parseUrlRecipe('?v=1&lat=35.0327&lon=-83.5299&label=Way%00ah%0A%20Bald%20').label, 'Wayah Bald');
  for (const s of ['', '?', '?v=2&lat=35&lon=-83', '?v=1&lat=60&lon=-83', '?v=1&lat=35&lon=abc', '?v=1&lat=35', '?v=1&lat=35&lon=-83&w=x', null]) {
    assert.equal(parseUrlRecipe(s), null, `search ${JSON.stringify(s)}`);
  }
});

test('serializeUrlRecipe round-trips through parseUrlRecipe', () => {
  const s = serializeUrlRecipe({ lat: 35.03271234, lon: -83.52991234, widthMiles: 6, label: 'Wayah Bald, NC' });
  assert.equal(s, '?v=1&lat=35.0327&lon=-83.5299&w=6&label=Wayah+Bald%2C+NC');
  const p = parseUrlRecipe(s);
  assert.deepEqual({ label: p.label, widthMiles: p.widthMiles, bboxLonLat: p.bboxLonLat },
    { label: 'Wayah Bald, NC', widthMiles: 6, bboxLonLat: bboxAround(35.0327, -83.5299, 6) });
  assert.equal(serializeUrlRecipe({ lat: 35, lon: -83 }), '?v=1&lat=35.0000&lon=-83.0000&w=8');
});

test('sourceStateLine and canBuild', () => {
  // The wording comes from the layer registry's own labels now, so the status
  // line names a layer exactly as its checkbox does.
  const on = { usgsTopo: true, mvum: true }, off = { usgsTopo: true, mvum: false };
  assert.equal(sourceStateLine({ usgsTopo: 'ready', mvum: 'partial' }, on), 'USGS Topo: ready · MVUM roads & trails: partial');
  assert.equal(sourceStateLine({ usgsTopo: 'unchecked', mvum: 'unchecked' }, on),
    'USGS Topo: not checked yet · MVUM roads & trails: not checked yet');
  assert.deepEqual(canBuild({ states: { usgsTopo: 'ready', mvum: 'ready' }, layers: on }), { ok: true, reason: null });
  assert.equal(canBuild({ states: { usgsTopo: 'partial', mvum: 'ready' }, layers: on }).reason, 'USGS Topo must load completely before export.');
  assert.equal(canBuild({ states: { usgsTopo: 'ready', mvum: 'unavailable' }, layers: on }).reason, FAILURE.coverageUnknown);
  assert.equal(canBuild({ states: { usgsTopo: 'ready', mvum: 'unknown' }, layers: on }).ok, false);
  assert.deepEqual(canBuild({ states: { usgsTopo: 'ready', mvum: 'unavailable' }, layers: off }), { ok: true, reason: null });
  assert.equal(canBuild({ states: { usgsTopo: 'unchecked', mvum: 'unchecked' }, layers: on }).reason, 'Check sources before building.');
  assert.equal(canBuild({ states: { usgsTopo: 'ready', mvum: 'unchecked' }, layers: on }).reason, 'Check sources before building.');
});

test('canBuild: a layer the Check pass never fetches never blocks Build', () => {
  // Two kinds of row are switched on without the Check pass ever asking a service
  // for them, so after Check sources they still read 'unchecked', as clearFetched
  // left them: a screen-only row (radar, night lights, smoke, …) is drawn on the map
  // and never on a sheet, and an extra page (aerial, shaded relief, route summary)
  // is fetched by the build itself, which drops it rather than fail the map.
  // Gating on either disabled Build with "Check sources before building." for as
  // long as the row stayed on, and checking again could not clear it.
  // The set is read off enabledLayers, the pass's own list, not off the flags, so a
  // new kind of unfetched row cannot slip back into the gate.
  const fetched = (l) => enabledLayers({ [l.id]: true }).some((e) => e.id === l.id);
  const unfetched = LAYERS.filter((l) => !l.stateScoped && !fetched(l));
  assert.ok(unfetched.some((l) => l.screenOnly) && unfetched.some((l) => l.extraPage),
    'the registry should still have screen-only rows and extra pages');
  const afterCheck = Object.fromEntries(LAYER_IDS.map((id) => [id, 'unchecked']));
  for (const l of LAYERS) if (fetched(l) && (l.required || DEFAULTS.layers[l.id])) afterCheck[l.id] = 'ready';
  const layers = { ...DEFAULTS.layers };
  assert.deepEqual(canBuild({ states: afterCheck, layers }), { ok: true, reason: null });
  for (const l of unfetched) {
    assert.deepEqual(canBuild({ states: afterCheck, layers: { ...layers, [l.id]: true } }), { ok: true, reason: null },
      `${l.id} is never fetched by Check sources, so it should not block Build`);
  }
  // A printed overlay still blocks until it is checked, with every unfetched row on.
  const mvum = LAYERS.find((l) => l.id === 'mvum');
  assert.ok(mvum && fetched(mvum) && !mvum.required && !layers.mvum, 'mvum should be a fetched overlay that starts off');
  const allUnfetched = Object.fromEntries(unfetched.map((l) => [l.id, true]));
  assert.equal(canBuild({ states: afterCheck, layers: { ...layers, ...allUnfetched, mvum: true } }).reason,
    'Check sources before building.');
});

test('sourceStateLine names only the rows Build waits on', () => {
  // After Check sources, clearFetched has given every registry layer a state, so the
  // line under the button listed all of them: 32 clauses and about 1,750 characters,
  // most of them rows switched off or never fetched, each reading 'not checked yet'.
  // It now names the base map and the overlays that are on and fetched -- the rows
  // canBuild waits on -- so the line says why Build is or is not enabled.
  const afterCheck = Object.fromEntries(LAYER_IDS.map((id) => [id, 'unchecked']));
  afterCheck.usgsTopo = 'ready';
  // Named places is default-on and, unlike Road names, is fetched for the sheet, so it is a row
  // Build waits on until the reader unticks it; this test is about the rows that are off.
  const layers = { ...DEFAULTS.layers, names: false };
  assert.equal(sourceStateLine(afterCheck, DEFAULTS.layers), 'USGS Topo: ready · Named places & landmarks: not checked yet');
  assert.equal(sourceStateLine(afterCheck, layers), 'USGS Topo: ready');
  assert.equal(sourceStateLine(afterCheck, { ...layers, mvum: true }),
    'USGS Topo: ready · MVUM roads & trails: not checked yet');
  const allOn = Object.fromEntries(LAYER_IDS.map((id) => [id, true]));
  const unfetched = LAYERS.filter((l) => !l.stateScoped && !enabledLayers({ [l.id]: true }).some((e) => e.id === l.id));
  assert.ok(unfetched.length > 0, 'the registry should still have rows the pass never fetches');
  const line = sourceStateLine(afterCheck, allOn);
  for (const l of unfetched) assert.ok(!line.includes(`${l.label}:`), `${l.id} is never fetched, so the line should not name it`);
  // The line explains the button: every clause reads ready exactly when Build is allowed.
  const allReady = Object.fromEntries(LAYER_IDS.map((id) => [id, 'ready']));
  for (const on of [layers, { ...layers, mvum: true }, allOn]) {
    for (const states of [afterCheck, allReady]) {
      const clauses = sourceStateLine(states, on).split(' · ');
      assert.equal(clauses.every((c) => c.endsWith(': ready')), canBuild({ states, layers: on }).ok,
        `the line and the Build gate disagree: ${clauses.join(' · ')}`);
    }
  }
});

test('canBuild: a state land layer no state in the area publishes never blocks Build', () => {
  // Switch Game lands on over North Carolina, then draw an area in Arizona and press
  // Check sources. Arizona publishes no game lands, so the pass skips the family, its
  // switch goes off and disabled, and its state stays 'unchecked' -- while the recipe,
  // planned before the check, still has it on. Build then said "Check sources before
  // building." and checking again could not clear it. Build now waits on exactly the
  // layers the build fetches: enabledLayers for the area's states.
  const afterCheck = Object.fromEntries(LAYER_IDS.map((id) => [id, 'unchecked']));
  afterCheck.usgsTopo = 'ready';
  const layers = { ...DEFAULTS.layers, names: false, gameLands: true };
  assert.ok(!enabledLayers(layers, ['AZ']).some((l) => l.id === 'gameLands'), 'Arizona should publish no game lands');
  assert.ok(enabledLayers(layers, ['NC']).some((l) => l.id === 'gameLands'), 'North Carolina should publish game lands');
  assert.deepEqual(canBuild({ states: afterCheck, layers, areaStates: ['AZ'] }), { ok: true, reason: null });
  assert.equal(sourceStateLine(afterCheck, layers, ['AZ']), 'USGS Topo: ready');
  // Where a state does publish it, it still blocks until checked, and a partial set still refuses.
  assert.equal(canBuild({ states: afterCheck, layers, areaStates: ['NC'] }).reason, 'Check sources before building.');
  assert.equal(sourceStateLine(afterCheck, layers, ['NC']), 'USGS Topo: ready · State game lands: not checked yet');
  assert.equal(canBuild({ states: { ...afterCheck, gameLands: 'partial' }, layers, areaStates: ['AZ', 'NC'] }).ok, false);
  // A failed state lookup leaves no states: the land layers are lost, never the base map.
  assert.deepEqual(canBuild({ states: afterCheck, layers, areaStates: [] }), { ok: true, reason: null });
});

test('the page passes the area\'s states to every Build gate and status line', () => {
  // canBuild and sourceStateLine read no page state themselves, so a call site that
  // leaves the area's states out gates on every land family as if no state published it.
  const src = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/\b(canBuild|sourceStateLine)\(([^;]*?)\)(?=[;.\s}$`?])/g)];
  assert.ok(calls.length >= 3, `expected the page's Build gate and status line calls, found ${calls.length}`);
  for (const [call] of calls) assert.match(call, /state\.areaStates/, `${call} should pass state.areaStates`);
});

test('applyChange: immutable control update that re-validates and re-plans', () => {
  const r = recipe();
  const next = applyChange(r, { orientation: 'landscape', scale: 48000, layers: { mvum: false } });
  assert.equal(r.orientation, 'portrait');
  assert.equal(next.orientation, 'landscape');
  // Derived, not hardcoded: the registry is the one place a layer is declared, so
  // adding one must not break this test. A literal set here would defeat that.
  assert.deepEqual(next.layers, { ...DEFAULT_LAYERS, mvum: false });
  assert.deepEqual(next.bboxLonLat, r.bboxLonLat);
  assert.equal(next.title, r.title);
  assert.deepEqual([planForRecipe(next).summary.pages, planForRecipe(next).summary.rows, planForRecipe(next).summary.cols], [4, 2, 2]);
  assert.throws(() => applyChange(r, { foo: 1 }), TypeError);
  assert.throws(() => applyChange(r, { paper: 'letter' }), TypeError);
});

test('orientationAdvice: names the cheaper orientation, stays quiet when it is not cheaper', () => {
  const wide = { minLon: -83.55, minLat: 35.0, maxLon: -83.35, maxLat: 35.1 };
  const portrait = recipeFromControls({}, wide, 'Wide area');
  assert.equal(planForRecipe(portrait).summary.pages, 12);
  const advice = orientationAdvice(portrait);
  assert.deepEqual(
    { orientation: advice.orientation, pages: advice.pages, rows: advice.rows, cols: advice.cols, saved: advice.saved },
    { orientation: 'landscape', pages: 9, rows: 3, cols: 3, saved: 3 });
  assert.deepEqual({ pages: advice.currentPages, rows: advice.currentRows, cols: advice.currentCols }, { pages: 12, rows: 3, cols: 4 });
  assert.equal(advice.text, 'Landscape would need 9 pages (3 rows × 3 columns) instead of 12 — the same ground on 3 fewer sheets.');

  // One page saved, one row: every singular in the sentence.
  const thin = recipeFromControls({}, { minLon: -83.55, minLat: 35.0, maxLon: -83.35, maxLat: 35.02 }, 'Thin strip');
  assert.equal(orientationAdvice(thin).text,
    'Landscape would need 3 pages (1 row × 3 columns) instead of 4 — the same ground on 1 fewer sheet.');

  // Equal page counts: no advice. The example area plans 3 × 3 either way.
  assert.equal(orientationAdvice(recipe()), null);
  // The other orientation is worse: no advice.
  assert.equal(orientationAdvice(recipeFromControls({}, { minLon: -83.55, minLat: 35.0, maxLon: -83.4, maxLat: 35.08 }, 'Tall area')), null);
  // Already on the cheaper orientation: no advice back the other way.
  assert.equal(orientationAdvice(applyChange(portrait, { orientation: 'landscape' })), null);
  // The other orientation does not plan at all (over maxPages): no advice, no throw.
  assert.equal(orientationAdvice(recipeFromControls({ maxPages: 12 }, { minLon: -83.55, minLat: 35.0, maxLon: -83.25, maxLat: 35.08 }, 'Capped')), null);
});

// QUX-10a: quads threaded through the page-state layer. Same NW/NE quad pair the
// geometry.test.mjs / sheet-plan.test.mjs fixtures use, one full row -- picked so its
// bboxLonLat is exactly bboxOfCells(quads) (the equality optionalQuads enforces) and its
// shape (twice as wide as tall) mirrors the "wide area" fixture just above, so it is
// expected to favour landscape the same way.
const ROW_QUADS = ['280:-669', '280:-668'];
const ROW_BBOX = { minLon: -83.625, minLat: 35.0, maxLon: -83.375, maxLat: 35.125 };
const Q_NW = { minLon: -83.625, minLat: 35.0, maxLon: -83.5, maxLat: 35.125 };
const Q_NE = { minLon: -83.5, minLat: 35.0, maxLon: -83.375, maxLat: 35.125 };
const Q_SW = { minLon: -83.625, minLat: 34.875, maxLon: -83.5, maxLat: 35.0 };
const BLOCK_QUADS = ['280:-669', '280:-668', '279:-669']; // an L-shape: every quad but the SE corner
const BLOCK_BBOX = { minLon: Q_NW.minLon, minLat: Q_SW.minLat, maxLon: Q_NE.maxLon, maxLat: Q_NW.maxLat };

test('recipeFromControls threads an optional quad-set selection through to the recipe', () => {
  const r = recipeFromControls({ maxPages: 999 }, ROW_BBOX, 'Quad set', ROW_QUADS);
  assert.deepEqual(r.quads, ROW_QUADS);
  assert.equal(recipe().quads, undefined, 'no 4th argument -> no quads field at all, exactly like before this unit');
  assert.throws(() => recipeFromControls({}, EXAMPLE_AREA.bboxLonLat, 'x', ROW_QUADS), RangeError,
    'EXAMPLE_AREA.bboxLonLat is not bboxOfCells(ROW_QUADS) -- the mismatch must be rejected, not silently widened');
});

test('recipeFromControls: a quad selection over an oversized envelope is refused before planning ever runs (D4)', () => {
  // ~3,045 km^2 at this latitude -- well over VIEWPORT_FETCH.maxAreaKm2 (2,500) -- but
  // still one narrow, printable UTM zone, so the throw can only be the D4 area cap.
  const tooBig = { minLon: -83.6, minLat: 34.5, maxLon: -83.3, maxLat: 35.5 };
  assert.throws(() => recipeFromControls({}, tooBig, 't', ['280:-669']), /too far apart/);
  assert.doesNotThrow(() => recipeFromControls({}, tooBig, 't'),
    'the same box with no quads is a plain rectangular area and is not subject to this cap');
});

test('applyChange: a control change must not drop the selected quads (R1)', () => {
  const r = recipeFromControls({ maxPages: 999 }, ROW_BBOX, 'Quad set', ROW_QUADS);
  const next = applyChange(r, { orientation: 'landscape' });
  assert.deepEqual(next.quads, ROW_QUADS, 'quads must survive a control change, never silently fall back to the rectangular envelope');
  assert.equal(applyChange(recipe(), { orientation: 'landscape' }).quads, undefined, 'a plain area stays plain');
});

test('planForRecipe: a quad set that drops grid positions says so in the summary text', () => {
  const full = planForRecipe(recipeFromControls({ maxPages: 999 }, ROW_BBOX, 'Quad set', ROW_QUADS));
  assert.equal(full.plan.count, full.plan.gridCount, 'this selection exactly tiles its envelope: nothing to report as missing');
  assert.doesNotMatch(full.summary.text, /not printed/);

  const holed = planForRecipe(recipeFromControls({ maxPages: 999 }, BLOCK_BBOX, 'L-shape', BLOCK_QUADS));
  assert.ok(holed.plan.count < holed.plan.gridCount, 'the dropped SE quad must actually remove a grid position');
  assert.match(holed.summary.text, new RegExp(`${holed.plan.gridCount - holed.plan.count} grid positions? not printed`));
});

test('orientationAdvice: a quad set drops the "(rows × columns)" aside, since it names the envelope grid, not what prints', () => {
  // A single quad cell (Q_NW): portrait needs 9 pages (3 rows x 3 cols), landscape
  // needs 8 (4 rows x 2 cols) -- confirmed empirically. ROW_BBOX, though the same
  // 2:1 shape as the "wide area" fixture above, does NOT favour landscape at its
  // larger absolute size: countAlong's ceiling is a step function of real size,
  // not just aspect ratio, so shape alone does not predict which way it falls.
  const withQuads = recipeFromControls({ maxPages: 999 }, Q_NW, 'Quad set', ['280:-669']);
  const advice = orientationAdvice(withQuads);
  assert.ok(advice, 'landscape needs 8 pages against portrait\'s 9 for this single-quad envelope');
  assert.doesNotMatch(advice.text, /\(\d+ rows? × \d+ columns?\)/, 'the envelope shape is not what the reader will see print');
  assert.match(advice.text, /^Landscape would need \d+ pages? instead of \d+ — the same ground on \d+ fewer sheets?\.$/);
});

// F11, first half. Every vector layer is fetched for `recipe.bboxLonLat` and
// nothing else (main.js's checkSources passes that one key to fetchLayer,
// fetchTrails, fetchRecSites, fetchFederalLand, fetchCountyLines and
// fetchLandBoundaries). Turning a checkbox on, or choosing landscape, cannot
// change what is on the ground — yet `resetSources()` threw away every fetched
// layer and cleared the overlay on both, so the map went blank and the reader
// had to press Check sources again to get back what was already downloaded.
test('a control change invalidates only what it can actually change', () => {
  for (const change of [{ orientation: 'landscape' }, { overlapIn: 1 }, { grid: 'none' },
    { layers: { trails: true } }, { layers: { mvum: false } }]) {
    assert.deepEqual(sourcesInvalidatedBy(change), [],
      `${JSON.stringify(change)} cannot change what the services hold for this bbox`);
  }
  // Scale and DPI are the exception: the topo level comes from the sheet's
  // metres-per-pixel (build.js:22 chooseLevel), so a scale or dpi change asks
  // for tiles nobody has checked. The vectors are still good.
  for (const change of [{ scale: 48000 }, { dpi: 200 }]) {
    assert.deepEqual(sourcesInvalidatedBy(change), ['usgsTopo'],
      `${JSON.stringify(change)} moves the tile level, and nothing else`);
  }
  assert.deepEqual(sourcesInvalidatedBy({ scale: 48000, layers: { trails: true } }), ['usgsTopo'],
    'two changes at once invalidate the union, not everything');
  assert.throws(() => sourcesInvalidatedBy({ bboxLonLat: {} }), TypeError,
    'an area change is not a control change — it invalidates everything, and setBbox says so');
});

// The pure decision above is worth nothing if the page does not route through it.
test('the page asks that question instead of wiping everything', () => {
  const main = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
  const listeners = main.split('\n').filter((l) => /addEventListener\('change'/.test(l));
  assert.ok(listeners.length >= 2, 'the layer rows and the print controls both listen for a change');
  for (const l of listeners) {
    assert.ok(!/resetSources\(\)/.test(l),
      `a control change must not wipe the fetched layers: ${l.trim()}`);
  }
  assert.match(main, /sourcesInvalidatedBy/, 'and it has to ask what the change really invalidates');
  // A new area still wipes: it makes every fetched answer wrong. Since QUX-10b every
  // area change (box, quad set, Undo) goes through setArea, and setBbox is its box form.
  const body = (name) => { const s = main.slice(main.indexOf(`function ${name}(`)); return s.slice(0, s.indexOf('\n}')); };
  assert.match(body('setArea'), /resetSources\(\)/,
    'a new area invalidates every layer, and that path must keep saying so');
  assert.match(main, /function setBbox\([^)]*\) \{ setArea\(/, 'a drawn box is an area change like any other');
});

test('a settled viewport asks only for what it can honestly load', () => {
  const on = { mvum: true, trails: true };
  const small = { minLon: -83.55, minLat: 35.0, maxLon: -83.4, maxLat: 35.1 };
  const unchecked = { mvum: 'unchecked', trails: 'unchecked' };

  const plan = viewportFetchPlan({ bboxLonLat: small, zoom: 11, layers: on, states: unchecked });
  assert.deepEqual(plan.layers, ['mvum', 'trails'], 'both switched-on overlays');
  assert.deepEqual(plan.bboxLonLat, small, 'for the box on screen');
  assert.equal(plan.reason, null);

  // The topo base only appears at z>=9, so below it there is no field map to
  // overlay -- and a national viewport is exactly the query that truncates.
  for (const zoom of [8, 5, 0, NaN, undefined]) {
    const r = viewportFetchPlan({ bboxLonLat: small, zoom, layers: on, states: unchecked });
    assert.deepEqual(r.layers, [], `zoom ${zoom} asks for nothing`);
    assert.match(r.reason, /zoom in/i, `zoom ${zoom} says why`);
  }
  const wide = { minLon: -84.5, minLat: 34.5, maxLon: -82.5, maxLat: 36.0 };
  const big = viewportFetchPlan({ bboxLonLat: wide, zoom: 10, layers: on, states: unchecked });
  assert.deepEqual(big.layers, [], 'too much ground for one query');
  assert.match(big.reason, /too much ground/i);

  // The base map is a tile layer that already follows the viewport itself, and an
  // extra sheet is not drawn on the map at all: neither is ever fetched here.
  const noneOn = viewportFetchPlan({ bboxLonLat: small, zoom: 11, layers: { aerial: true }, states: {} });
  assert.deepEqual(noneOn.layers, [], 'the base map and extra sheets are not overlays');
  assert.match(noneOn.reason, /switched on/i);

  // Panning inside data already in hand asks for nothing -- that is the whole
  // point of remembering which box the sources came from.
  const inside = { minLon: -83.5, minLat: 35.02, maxLon: -83.45, maxLat: 35.06 };
  const ready = { mvum: 'ready', trails: 'ready' };
  assert.deepEqual(viewportFetchPlan({ bboxLonLat: inside, zoom: 12, layers: on, states: ready, fetchedFor: small }).layers,
    [], 'already loaded');
  // ...but a layer switched on since that fetch is still missing, so it asks again.
  assert.deepEqual(viewportFetchPlan({ bboxLonLat: inside, zoom: 12, layers: on, states: { mvum: 'ready' }, fetchedFor: small }).layers,
    ['mvum', 'trails'], 'a newly enabled layer was never in that answer');
  // Panning OUT of it asks again, for the new box.
  const outside = { minLon: -83.3, minLat: 35.0, maxLon: -83.2, maxLat: 35.05 };
  assert.deepEqual(viewportFetchPlan({ bboxLonLat: outside, zoom: 12, layers: on, states: ready, fetchedFor: small }).bboxLonLat,
    outside, 'a new view is a new question');
  assert.ok(VIEWPORT_FETCH.settleMs > 0, 'and it waits for the map to settle');

  // Only two of the four refusals are worth a sentence on the status line, so the
  // plan says which kind it is rather than making main.js match on prose.
  assert.equal(viewportFetchPlan({ bboxLonLat: small, zoom: 8, layers: on, states: unchecked }).code, 'zoom');
  assert.equal(viewportFetchPlan({ bboxLonLat: wide, zoom: 10, layers: on, states: unchecked }).code, 'area');
  assert.equal(viewportFetchPlan({ bboxLonLat: small, zoom: 11, layers: {}, states: {} }).code, 'none-on');
  assert.equal(viewportFetchPlan({ bboxLonLat: inside, zoom: 12, layers: on, states: ready, fetchedFor: small }).code, 'held');
  assert.equal(plan.code, 'fetch');
});

test('names never ride the viewport area or zoom gate: they run their own per-view pass', () => {
  // Stevensville MT at zoom 10, about 10,000 km2: far over maxAreaKm2 for every other layer.
  const z10 = { minLon: -114.5, minLat: 46.0, maxLon: -113.7, maxLat: 46.9 };
  const onlyNames = viewportFetchPlan({ bboxLonLat: z10, zoom: 10, layers: { names: true }, states: { names: 'unchecked' } });
  assert.notEqual(onlyNames.code, 'area', 'a names-only view is never refused for its size');
  assert.notEqual(onlyNames.code, 'zoom');
  assert.deepEqual(onlyNames.layers, [], 'and the browse pass does not fetch names -- runNames does');
  assert.equal(onlyNames.code, 'none-on');
  // Names are in the mix with a layer that IS gated: the gated layer still refuses, names stay out of the list.
  assert.equal(viewportFetchPlan({ bboxLonLat: z10, zoom: 10, layers: { names: true, mvum: true }, states: {} }).code, 'area');
  // Names' state is never written by a browse pass, so it must not keep a view 'held' open forever.
  const small = { minLon: -114.2, minLat: 46.45, maxLon: -114.0, maxLat: 46.6 };
  const inside = { minLon: -114.15, minLat: 46.5, maxLon: -114.05, maxLat: 46.55 };
  const held = viewportFetchPlan({ bboxLonLat: inside, zoom: 12, layers: { names: true, mvum: true }, states: { mvum: 'ready' }, fetchedFor: small });
  assert.equal(held.code, 'held', 'a pan inside the fetched box does not re-fetch the other layers because names is unchecked');
});

test('the page browses on a settled viewport and never prints someone else’s area', () => {
  const main = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
  assert.match(main, /viewportFetchPlan/, 'the browse decision is the tested one, not a copy');
  assert.match(main, /VIEWPORT_FETCH\.settleMs/, 'debounced by the tested constant');
  assert.match(main, /map\.on\('moveend'/, 'panning is a viewport change too, not only zooming');
  assert.match(main, /plan\.code === 'zoom' \|\| plan\.code === 'area'[\s\S]{0,60}say\(plan\.reason\)/,
    'and a view it cannot serve is told so, by code and not by matching prose');
  // The guard that makes browsing safe: sources fetched for a viewport must never
  // be handed to a build for a different area.
  assert.match(main, /state\.fetchedFor = \{ \.\.\.box \}/, 'the page records which box the sources came from');
  assert.match(main, /sourcesMatchArea\(state\.fetchedFor, state\.recipe\.bboxLonLat\)/, 'and build asks the tested guard');
  // Order, not presence: the base map's state is a fact about the SHEET, and a
  // browse fetch that cleared it first would demote a ready base map to
  // 'not checked yet' on every pan.
  assert.match(main, /let topo = state\.states\.usgsTopo;[\s\S]{0,300}?clearFetched\(\)/,
    'the base-map state is read before the fetched data is cleared');
  assert.match(main, /clearFetched\(\)\s*\{[\s\S]*?\n\}/, 'and clearFetched leaves the drawn overlay alone');
  assert.doesNotMatch(main.slice(main.indexOf('function clearFetched'), main.indexOf('function resetSources')),
    /overlay\.clearLayers/, 'so a refresh never blinks the map empty');
});

test('sources fetched for one area are never good enough for another', () => {
  const box = { minLon: -83.55, minLat: 35.0, maxLon: -83.4, maxLat: 35.1 };
  assert.equal(sourcesMatchArea({ ...box }, box), true, 'the same corners are the same area');
  assert.equal(sourcesMatchArea(null, box), false, 'nothing fetched yet is never a match');
  assert.equal(sourcesMatchArea(box, null), false, 'and neither is no area');
  // A viewport that CONTAINS the print box is still not the print box: the vector
  // services answer per query envelope, and the sheet must draw its own.
  assert.equal(sourcesMatchArea({ minLon: -83.6, minLat: 34.9, maxLon: -83.3, maxLat: 35.2 }, box), false,
    'a wider view is not this area');
  for (const k of ['minLon', 'minLat', 'maxLon', 'maxLat']) {
    assert.equal(sourcesMatchArea({ ...box, [k]: box[k] + 1e-9 }, box), false, `${k} moved at all`);
  }
});

// ── one source pass at a time ──
// checkSources() writes shared state as it goes (layer states, state.land,
// state.fetchedFor). On 2026-09-26 the viewport-browse pass, fired by the
// map settling after "Use example area", ran beside the Check button's pass:
// both cleared and refilled the same lists, so the badge read whichever pass
// finished last and a proof's focused marker was rebuilt under it (#567, #571).

const deferred = () => { let resolve, reject; const p = new Promise((res, rej) => { resolve = res; reject = rej; }); return { p, resolve, reject }; };

test('sourcePassQueue never runs two passes at once', async () => {
  let running = 0, peak = 0;
  const gates = [];
  const ask = sourcePassQueue(async () => {
    running += 1; peak = Math.max(peak, running);
    const g = deferred(); gates.push(g); await g.p;
    running -= 1;
  }, () => {});
  const first = ask();
  const second = ask();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(gates.length, 1, 'the second pass must wait for the first');
  gates[0].resolve(); await first;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(gates.length, 2, 'the second pass runs once the first is done');
  gates[1].resolve(); await second;
  assert.equal(peak, 1);
});

test('a browse asked during a pass is not run then, but re-planned once the queue is idle', async () => {
  const runs = [];
  let idle = 0;
  const gate = deferred();
  const ask = sourcePassQueue(async (opts) => { runs.push(opts.browse ? 'browse' : 'check'); if (!opts.browse) await gate.p; }, () => { idle += 1; });
  const check = ask({});
  const browse = ask({ browse: true });
  gate.resolve(); await check; await browse;
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(runs, ['check'], 'a browse planned for the old state must not run after the check');
  assert.equal(idle, 1, 'the dropped browse is re-planned exactly once, against the new state');
});

test('a check asked during a browse waits for it, and the queue survives a failed pass', async () => {
  const runs = [];
  const gate = deferred();
  let idle = 0;
  const ask = sourcePassQueue(async (opts) => {
    runs.push(opts.browse ? 'browse' : 'check');
    if (opts.browse && runs.length === 1) { await gate.p; throw new Error('browse failed'); }
  }, () => { idle += 1; });
  const browse = ask({ browse: true });
  const check = ask({});
  gate.resolve();
  await assert.rejects(browse, /browse failed/);
  await check;
  assert.deepEqual(runs, ['browse', 'check']);
  assert.equal(idle, 0, 'nothing was deferred, so nothing is re-planned');
  await ask({ browse: true });
  assert.deepEqual(runs, ['browse', 'check', 'browse'], 'an idle queue runs a browse at once');
});
