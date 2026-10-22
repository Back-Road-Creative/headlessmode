// Tests for the build pipeline's overlay wiring: MVUM features reach the worker as
// per-sheet page-pixel vectors, and the legend lists exactly the symbols actually drawn.
// Every seam build.js injects is stubbed, so nothing here touches the network, a canvas,
// a worker or pdf-lib.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISCLAIMER } from '../../themes/headlessmode/static/js/quiet-corners-maps/legend.js';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { projectBbox, inverse } from '../../themes/headlessmode/static/js/quiet-corners-maps/geometry.js';
import { planSheets } from '../../themes/headlessmode/static/js/quiet-corners-maps/sheet-plan.js';
import { TYPES } from '../../themes/headlessmode/static/js/quiet-corners-maps/render-protocol.js';
import { recipeFromControls } from '../../themes/headlessmode/static/js/quiet-corners-maps/app-state.js';
import { runBuild } from '../../themes/headlessmode/static/js/quiet-corners-maps/build.js';

const utm = { zone: 17, hemisphere: 'N' };
const recipe = {
  paper: 'letter', orientation: 'portrait', scale: 24000, overlapIn: 0.5, insetIn: 0.25, dpi: 300,
  maxPages: 24, title: 'Standing Indian', grid: 'utm-1km', layers: { usgsTopo: true, mvum: true },
  // The lon/lat box travels with the recipe, as it does in the app: the aerial
  // companion is requested in lon/lat, not in the projected extent.
  bboxLonLat: { minLon: -83.55, minLat: 35.0, maxLon: -83.45, maxLat: 35.03 },
  extent: projectBbox({ minLon: -83.55, minLat: 35.0, maxLon: -83.45, maxLat: 35.03 }, 17, 'N'), ...utm,
};
const plan = planSheets(recipe);

/** lon/lat of a page-pixel point on `sheet`, so a synthetic road lands exactly where we want it. */
const lonLatOn = (sheet, x, y) => {
  const p = inverse(sheet.extent.minX + x * sheet.metersPerPixel, sheet.extent.maxY - y * sheet.metersPerPixel, 17, 'N');
  return [p.lon, p.lat];
};
/** A road/trail running corner to corner across the middle of one sheet. */
const featureOn = (sheet, id, layer, seasonal) => ({
  id, layer, seasonal,
  paths: [[[0.2, 0.2], [0.8, 0.8]].map(([fx, fy]) => lonLatOn(sheet, fx * sheet.pixel.width, fy * sheet.pixel.height))],
});
const layerResult = (features) => ({ retrievedAt: '2026-09-06T00:00:00.000Z', coverage: 'complete', expectedCount: features.length, receivedCount: features.length, features });

/** A worker that records every render request and answers each with one byte.
 *  Like a real MessagePort it buffers messages emitted before a handler is
 *  installed and flushes them on assignment — READY is posted at construction,
 *  long before runBuild gets round to listening for it. */
function stubWorker() {
  const requests = [], pending = [];
  let handler = null;
  const emit = (data) => (handler ? queueMicrotask(() => handler({ data })) : pending.push(data));
  const w = {
    requests, onerror: null,
    get onmessage() { return handler; },
    set onmessage(fn) {
      handler = fn;
      while (fn && pending.length) queueMicrotask(((d) => () => fn({ data: d }))(pending.shift()));
    },
    postMessage(m) {
      if (m.type !== TYPES.RENDER) return;
      requests.push(m);
      emit({ type: TYPES.DONE, sheetId: m.sheetId, bytes: new Uint8Array([0xff]).buffer });
    },
    terminate() {},
  };
  emit({ type: TYPES.READY });
  return w;
}

/** runBuild with every seam stubbed; returns the worker requests and what createPdf was handed. */
async function build({ mvum = {}, roadQuality, layers, trails, land, sites, fetchImpl, names } = {}) {
  const worker = stubWorker();
  const seen = {};
  const result = await runBuild({
    recipe: layers ? { ...recipe, layers: { ...recipe.layers, ...layers } } : recipe,
    plan, workerFactory: () => worker, PDFLib: {},
    adapters: {
      fetchImpl: fetchImpl || (async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })),
      createImageBitmap: async () => ({ width: 256, height: 256, close() {} }),
      mvum, roadQuality, trails, land, sites, names,
    },
    createPdfImpl: async (a) => { Object.assign(seen, a); return new Uint8Array([0x25, 0x50, 0x44, 0x46]); },
    now: () => '2026-09-06T00:00:00.000Z',
  });
  return { requests: worker.requests, seen, result };
}

test('with no MVUM features the worker gets no vectors and the legend lists no MVUM symbol', async () => {
  const { requests, seen } = await build();
  assert.ok(requests.length > 0, 'every sheet was rendered');
  for (const r of requests) assert.deepEqual(r.vectors ?? [], [], `sheet ${r.sheetId} sent no vectors`);
  assert.deepEqual(seen.legend.entries.filter((e) => e.key.startsWith('mvum-')), []);
  assert.deepEqual(seen.legend.notices, [], 'no MVUM entry means no MVUM disclaimer');
});

test('MVUM features reach the worker as per-sheet page-pixel vectors carrying dpi', async () => {
  const first = plan.sheets[0];
  const { requests } = await build({ mvum: { roads: layerResult([featureOn(first, 'FR-1', 'road', 'seasonal')]) } });
  const req = requests.find((r) => r.sheetId === first.id);
  assert.ok(req, 'the first sheet was rendered');
  assert.equal(req.dpi, 300, 'the request carries the recipe dpi so dash arrays scale');
  assert.ok(Array.isArray(req.vectors) && req.vectors.length > 0, 'the road became at least one vector');
  for (const v of req.vectors) {
    assert.equal(v.key, 'mvum-road-seasonal');
    assert.ok(v.path.length >= 2);
    for (const [x, y] of v.path) {
      assert.ok(Number.isFinite(x) && Number.isFinite(y), 'page px are finite');
      assert.ok(x >= -32 && x <= first.pixel.width + 32, `x within the sheet plus margin: ${x}`);
      assert.ok(y >= -32 && y <= first.pixel.height + 32, `y within the sheet plus margin: ${y}`);
    }
  }
});

test('the legend lists the union of symbols drawn across sheets, with the MVUM disclaimer', async () => {
  const [first, second] = plan.sheets;
  const { seen } = await build({
    mvum: {
      roads: layerResult([featureOn(first, 'FR-1', 'road', 'seasonal')]),
      trails: layerResult([featureOn(second, 'TR-9', 'trail', 'yearlong')]),
    },
  });
  const keys = seen.legend.entries.map((e) => e.key);
  assert.ok(keys.includes('mvum-road-seasonal'), 'the road drawn on sheet 1 is legended');
  assert.ok(keys.includes('mvum-trail-yearlong'), 'the trail drawn on sheet 2 is legended');
  assert.ok(!keys.includes('mvum-road-unknown'), 'a symbol nothing used stays off the legend');
  assert.ok(keys.includes('usgs-topo') && keys.includes('utm-grid'), 'base map and grid still legended');
  assert.ok(seen.legend.notices.includes(DISCLAIMER), 'an MVUM entry brings the disclaimer');
});

// The key said the open dates would be on the sheet and no module ever wrote one:
// `summarize()` collected the windows and nothing but its own test called it.
test('the seasonal open dates travel from MVUM onto the printed key', async () => {
  const [first] = plan.sheets;
  const dated = { ...featureOn(first, 'FR-1', 'road', 'seasonal'), name: 'FR 71',
    vehicles: { passenger: { allowed: 'open', datesOpen: { open: '04-01', close: '12-15' } },
      highClearance: { allowed: null, datesOpen: null } } };
  const undated = { ...featureOn(first, 'FR-2', 'road', 'seasonal'), name: 'FR 12',
    vehicles: { passenger: { allowed: 'open', datesOpen: null }, highClearance: { allowed: null, datesOpen: null } } };
  const { seen } = await build({ mvum: { roads: layerResult([dated, undated]), trails: layerResult([]) } });
  assert.deepEqual(seen.legend.seasonalRoutes,
    ['FR 71: Apr 1 - Dec 15', '1 more seasonal route here: the source gave no dates for it.'],
    'the dates the source stated, and a count of the routes it did not date');
});

test('a feature on one sheet does not fill a distant sheet with vectors', async () => {
  assert.ok(plan.sheets.length > 1, 'this plan has more than one sheet');
  const [first, second] = plan.sheets;
  const { requests } = await build({ mvum: { roads: layerResult([featureOn(first, 'FR-1', 'road', 'yearlong')]) } });
  const a = requests.find((r) => r.sheetId === first.id);
  const b = requests.find((r) => r.sheetId === second.id);
  assert.ok(a.vectors.length > 0, 'the sheet the road sits on gets vectors');
  assert.ok(b.vectors.length < a.vectors.length, 'clipping is per sheet, so a distant sheet gets fewer');
});

// A Forest Service map labels a road by its NUMBER and a trail by its NAME. The sheet
// follows that convention, so someone who reads those maps reads this one.
test('a road is labelled by its number and a trail by its name', async () => {
  const first = plan.sheets[0];
  const road = { ...featureOn(first, '71', 'road', 'yearlong'), name: 'DRYMAN FORK' };
  const trail = { ...featureOn(first, 'T-2', 'trail', 'yearlong'), name: 'Appalachian Trail' };
  const { seen } = await build({ mvum: { roads: layerResult([road]), trails: layerResult([trail]) } });

  const labels = seen.sheets.flatMap((s) => s.labels || []);
  const textFor = (key) => labels.filter((l) => l.key.startsWith(key)).map((l) => l.text);
  assert.deepEqual(textFor('mvum-road-'), ['71'], 'a road takes its route number, not its name');
  assert.deepEqual(textFor('mvum-trail-'), ['Appalachian Trail'], 'a trail takes its name, not its id');

  for (const l of labels) {
    assert.ok(Number.isFinite(l.x) && Number.isFinite(l.y), 'a label needs a position');
    assert.ok(l.angleDeg >= -90 && l.angleDeg <= 90, 'a label is never upside down');
  }
});

test('every sheet carries a labels array, even when nothing is drawn on it', async () => {
  const { seen } = await build();
  assert.ok(seen.sheets.length);
  for (const s of seen.sheets) assert.deepEqual(s.labels, [], 'an empty sheet still declares no labels');
});

// Road quality reaches the worker as WIDTH, and is optional by construction.
test('a rated road reaches the worker wider than an unrated one, and season is untouched', async () => {
  const first = plan.sheets[0];
  const road = featureOn(first, '71', 'road', 'seasonal');
  const mvum = { roads: layerResult([road]) };

  const plain = await build({ mvum });
  const rated = await build({ mvum, roadQuality: { 71: { maintLevel: 5, surface: 'paved', tier: 'road-high' } } });

  const widthOf = (r) => r.requests.flatMap((q) => q.vectors).filter((v) => v.key === 'mvum-road-seasonal')[0].widthPx;
  assert.ok(widthOf(rated) > widthOf(plain), 'a level-5 road must reach the worker wider');
  for (const r of [plain, rated]) {
    assert.equal(r.requests.flatMap((q) => q.vectors).filter((v) => v.key === 'mvum-road-seasonal')[0].pattern, 'dash',
      'season still owns the pattern axis after the width change');
  }
});

test('with the road inventory unavailable the sheet still builds', async () => {
  const first = plan.sheets[0];
  const { requests } = await build({ mvum: { roads: layerResult([featureOn(first, '71', 'road', 'yearlong')]) }, roadQuality: undefined });
  assert.ok(requests.flatMap((q) => q.vectors).length >= 1, 'roads print at plain width when quality is missing');
});

// The four units that shipped previewing but not printing. Each assertion here
// fails against the code as it was merged, which is the point of having them.
test('a trail and a state land boundary reach the worker as vectors, like a road', async () => {
  const first = plan.sheets[0];
  const trail = { ...featureOn(first, 'T-1', 'trail', 'yearlong'), symbolKey: 'trail-nst', name: 'Appalachian Trail' };
  const boundary = { ...featureOn(first, 'GL-1', 'boundary', 'yearlong'), symbolKey: 'land-game', layer: 'gameLands' };
  const { requests, seen } = await build({
    layers: { trails: true, gameLands: true },
    trails: { features: [trail] },
    land: [boundary],
  });
  const keys = requests.flatMap((r) => r.vectors || []).map((v) => v.key);
  assert.ok(keys.includes('trail-nst'), 'the trail never reached the worker');
  assert.ok(keys.includes('land-game'), 'the boundary never reached the worker');
  const legendKeys = seen.legend.entries.map((e) => e.key);
  assert.ok(legendKeys.includes('trail-nst') && legendKeys.includes('land-game'), 'drawn but not legended');
});

test('a rec site rides its sheet into the PDF and earns a legend entry', async () => {
  const first = plan.sheets[0];
  const site = { symbolKey: 'rec-campground', name: 'Standing Indian CG', lonLat: lonLatOn(first, first.pixel.width / 2, first.pixel.height / 2) };
  const { seen } = await build({ layers: { recSites: true }, sites: [site] });
  assert.ok(seen.sheets.every((s) => Array.isArray(s.sites)), 'every sheet declares its sites');
  assert.ok(seen.sheets.some((s) => s.sites.length === 1), 'the site reached a sheet');
  assert.ok(seen.legend.entries.map((e) => e.key).includes('rec-campground'), 'a drawn marker with no key entry is unreadable');
});

test('the aerial companion is built only when asked, and never fails the map', async () => {
  const off = await build();
  assert.deepEqual(off.seen.aerials, [], 'no aerial page unless the box is ticked');
  const on = await build({ layers: { aerial: true } });
  assert.equal(on.seen.aerials.length, plan.sheets.length, 'one companion per sheet');
  // An extra is an extra: a refusing imagery service costs the companion, not the map.
  const broken = await build({
    layers: { aerial: true },
    fetchImpl: async (url) => (String(url).includes('imagery')
      ? { ok: false, status: 503 }
      : { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }),
  });
  assert.deepEqual(broken.seen.aerials, [], 'the aerial dropped out');
  assert.ok(broken.seen.sheets.length > 0, 'and the map still printed');
});

// The two newest layers, at the seam the parity invariant actually broke at once:
// a boundary reaches the SHEET through state.land and the preview through the same
// list, so a federal boundary that prints must be a federal boundary that previews.
test('a federal boundary reaches the worker and earns its own legend entry', async () => {
  const first = plan.sheets[0];
  const wild = { ...featureOn(first, '{w}', 'boundary', null), symbolKey: 'fed-wilderness', layer: 'federalLand', name: 'Southern Nantahala Wilderness' };
  const forest = { ...featureOn(first, '{f}', 'boundary', null), symbolKey: 'fed-forest', layer: 'federalLand', name: 'Nantahala National Forest' };
  const { requests, seen } = await build({ layers: { federalLand: true }, land: [wild, forest] });
  const keys = requests.flatMap((r) => r.vectors || []).map((v) => v.key);
  assert.ok(keys.includes('fed-wilderness'), 'the wilderness boundary never reached the worker');
  assert.ok(keys.includes('fed-forest'), 'the forest boundary never reached the worker');
  const legendKeys = seen.legend.entries.map((e) => e.key);
  assert.ok(legendKeys.includes('fed-wilderness') && legendKeys.includes('fed-forest'), 'drawn but not legended');
  // Four families share ONE toggle, so one unticked box drops all of them. The
  // recipe main.js builds carries an explicit boolean for EVERY registry layer,
  // which is the shape that matters: build.js reads `!== false`, so an absent key
  // is on and only an explicit false is off.
  const off = await build({ layers: { federalLand: false, gameLands: false, stateParks: false, managedAreas: false }, land: [wild, forest] });
  assert.deepEqual(off.requests.flatMap((r) => r.vectors || []).map((v) => v.key).filter((k) => k.startsWith('fed-')), []);
});

// A federal boundary obliges the same access notice a state one does: a
// proclamation boundary encloses private inholdings that were never federal.
// The case the old hardcoded gate got wrong: someone who wants national forests
// and no state land at all. Every state family is off, so a gate naming only the
// three state families drops adapters.land entirely and the federal boundaries
// vanish from paper with nothing said.
test('federal boundaries print when every STATE family is switched off', async () => {
  const first = plan.sheets[0];
  const fed = { ...featureOn(first, '{w}', 'boundary', null), symbolKey: 'fed-forest', layer: 'federalLand', name: 'Nantahala National Forest' };
  const { requests } = await build({
    layers: { federalLand: true, gameLands: false, stateParks: false, managedAreas: false },
    land: [fed],
  });
  const keys = requests.flatMap((r) => r.vectors || []).map((v) => v.key);
  assert.ok(keys.includes('fed-forest'), 'federal land only prints when a state family happens to be on');
});

// The mirror of the same bug: one state family on used to print every OTHER
// family's boundaries too, because the gate was per-REQUEST, not per feature.
test('a family that is off does not ride in on a family that is on', async () => {
  const first = plan.sheets[0];
  const game = { ...featureOn(first, 'GL-1', 'boundary', null), symbolKey: 'land-game', layer: 'gameLands' };
  const park = { ...featureOn(first, 'SP-1', 'boundary', null), symbolKey: 'land-park', layer: 'stateParks' };
  const { requests } = await build({
    layers: { gameLands: true, stateParks: false, managedAreas: false, federalLand: false },
    land: [game, park],
  });
  const keys = requests.flatMap((r) => r.vectors || []).map((v) => v.key);
  assert.ok(keys.includes('land-game'), 'the family that was on did not print');
  assert.ok(!keys.includes('land-park'), 'a switched-off family printed anyway');
});

test('a federal boundary brings the access notice onto the key, exactly once', async () => {
  const first = plan.sheets[0];
  const fed = { ...featureOn(first, '{w}', 'boundary', null), symbolKey: 'fed-park', layer: 'federalLand', name: 'Great Smoky Mountains' };
  const state = { ...featureOn(first, 'GL-1', 'boundary', null), symbolKey: 'land-game', layer: 'gameLands' };
  const both = await build({ layers: { federalLand: true, gameLands: true }, land: [fed, state] });
  const notices = both.seen.legend.notices.filter((n) => /not a statement that the ground/.test(n));
  assert.equal(notices.length, 1, 'state and federal boundaries must share one notice, not print it twice');
  const fedOnly = await build({ layers: { federalLand: true }, land: [fed] });
  assert.ok(fedOnly.seen.legend.notices.some((n) => /not a statement that the ground/.test(n)),
    'a federal boundary drawn alone printed no access notice');
});

test('the relief companion is built only when asked, and never fails the map', async () => {
  const off = await build();
  assert.deepEqual(off.seen.companions, [], 'no relief page unless the box is ticked');
  const on = await build({ layers: { terrain: true } });
  assert.equal(on.seen.companions.length, plan.sheets.length, 'one companion per sheet');
  assert.ok(on.seen.companions.every((c) => c.format === 'png'), 'relief must declare PNG, or embedJpg throws on it');
  // An extra is an extra: a refusing elevation service costs the companion, not the map.
  const broken = await build({
    layers: { terrain: true },
    fetchImpl: async (url) => (String(url).includes('elevation')
      ? { ok: false, status: 503 }
      : { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }),
  });
  assert.deepEqual(broken.seen.companions, [], 'the relief sheet dropped out');
  assert.ok(broken.seen.sheets.length > 0, 'and the map still printed');
});

test('the trip page lists named routes only, and survives an elevation outage', async () => {
  const first = plan.sheets[0];
  const named = { ...featureOn(first, 'T-1', 'trail', 'yearlong'), symbolKey: 'trail-nst', name: 'Appalachian Trail' };
  const anon = { ...featureOn(first, 'T-2', 'trail', 'yearlong'), symbolKey: 'trail-nonmotor' };
  const { seen } = await build({
    layers: { tripPage: true, trails: true },
    trails: { features: [named, anon] },
    // 3DEP refuses; the row must still appear with a blank climb rather than vanish.
    fetchImpl: async (url) => (String(url).includes('elevation')
      ? { ok: false, status: 500 }
      : { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }),
  });
  assert.equal(seen.trips.length, 1, 'only the named route is listed');
  assert.equal(seen.trips[0].name, 'Appalachian Trail');
  assert.equal(seen.trips[0].sampled, false, 'the climb is blank, not invented');
  assert.ok(seen.trips[0].sheets.length >= 1, 'it names the sheets it crosses');
});

// --- credit ----------------------------------------------------------------
// The sheet footer named USGS Topo and MVUM and nothing else, while NAIP, 3DEP,
// the trails host, the rec-sites host and every state agency printed uncredited.
// Terms of use are the reason: each SOURCES entry carries the credit its
// publisher asks for, and a hand-written line could not keep up with them.

test('every source a build consumed is credited on the key', async () => {
  const [first] = plan.sheets;
  const { seen } = await build({
    layers: { trails: true, recSites: true, aerial: true, tripPage: true },
    mvum: { roads: layerResult([featureOn(first, 'FR-1', 'road', 'seasonal')]) },
  });
  const credits = seen.legend.attribution.join('\n');
  for (const id of ['usgsTopo', 'usfsMvum', 'usgsQuadIndex', 'usdaNaip', 'usgs3dep']) {
    assert.ok(credits.includes(SOURCES[id].attribution), `${id} was consumed and printed uncredited`);
  }
});

test('a source no enabled layer uses is not credited, and one service is credited once', async () => {
  const { seen } = await build({ mvum: {} });   // base map only
  const credits = seen.legend.attribution;
  assert.ok(credits.join('\n').includes(SOURCES.usgsTopo.attribution));
  assert.ok(!credits.join('\n').includes(SOURCES.usdaNaip.attribution), 'no aerial sheet was built');

  // trails and recSites name hosts that MVUM and the quad index already credit;
  // the same credit must not print twice.
  const { seen: both } = await build({ layers: { trails: true, recSites: true } });
  const texts = both.legend.attribution;
  assert.equal(new Set(texts).size, texts.length, 'a shared service was credited twice');
});

// A screen-only surface (night lights, radar, etc.) never enters the printable
// vector fetch loop and never becomes a companion page, so switching it on for
// the screen must not put its publisher on the printed key: the reader would be
// told a source contributed to a sheet that never drew from it.
test('a screen-only layer switched on for the screen is not credited on the printed key', async () => {
  const { seen } = await build({ layers: { nightLights: true } });
  const credits = seen.legend.attribution.join('\n');
  assert.ok(!credits.includes(SOURCES.nasaBlackMarble.attribution),
    'nightLights is screenOnly and never reaches paper, but was credited anyway');
});

test('a drawn state boundary is credited to its own agency, per family', async () => {
  const [first] = plan.sheets;
  const boundary = { id: '1', name: 'Nantahala', layer: 'gameLands', symbolKey: 'land-game',
    paths: [[[0.2, 0.2], [0.8, 0.8], [0.2, 0.2]].map(([fx, fy]) => lonLatOn(first, fx * first.pixel.width, fy * first.pixel.height))] };
  const { seen } = await build({ layers: { gameLands: true }, land: [boundary] });
  const credits = seen.legend.attribution.join('\n');
  assert.match(credits, /State game lands/, 'the family that drew is named');
  assert.ok(!/State parks/.test(credits), 'a family that drew nothing is not credited');
});

// --- named terrain (N3) ------------------------------------------------------
// adapters.names mirrors adapters.trails/adapters.land: absent means the layer
// was never asked for; present, its `status` gates export exactly like the
// tile completeness check above, until retry or an explicit `layers.names: false`.
const gnisFeature = (id, name, kind, sheet, fx, fy) =>
  ({ id, name, kind, cls: kind, layer: 5, historical: false, anchor: [lonLatOn(sheet, fx * sheet.pixel.width, fy * sheet.pixel.height)[1], lonLatOn(sheet, fx * sheet.pixel.width, fy * sheet.pixel.height)[0]] });

test('a drawn name earns its manifest provenance and its legend entry, kept off when nothing drew', async () => {
  const first = plan.sheets[0];
  const f = gnisFeature('gnis:1', 'Cold Mountain', 'summit', first, 0.5, 0.5);
  const off = await build();
  assert.equal(off.seen.manifest.names, undefined, 'no adapters.names means no names block at all');
  assert.ok(!off.seen.legend.entries.some((e) => e.key.startsWith('name-')), 'nothing drawn means no name legend entries');

  const { seen } = await build({ names: { status: 'ready', features: [f], retrievedAt: '2026-09-25T00:00:00.000Z' } });
  assert.ok(seen.manifest.names, 'a drawn name must carry manifest provenance');
  assert.equal(seen.manifest.names.sourceId, 'gnisNames');
  assert.equal(seen.manifest.names.retrievedAt, '2026-09-25T00:00:00.000Z');
  assert.ok(seen.manifest.names.dataVintage, 'the GNIS data vintage must be separate from the retrieval date');
  assert.notEqual(seen.manifest.names.dataVintage, seen.manifest.names.retrievedAt);
  assert.deepEqual(seen.manifest.names.drawn.map((d) => d.id), ['gnis:1']);
  assert.equal(seen.manifest.names.dropped, 0);

  const legendKeys = seen.legend.entries.map((e) => e.key);
  assert.ok(legendKeys.includes('name-summit'), 'a drawn summit name must be legended');
  assert.equal(legendKeys.filter((k) => k.startsWith('name-')).length, 1, 'exactly the kinds drawn, no more');
  assert.ok(seen.legend.attribution.join('\n').includes(SOURCES.gnisNames.attribution), 'GNIS credited once something drew from it');
});

test('a names source stuck partial/over-cap/timeout blocks export until retry or explicit disable', async () => {
  const first = plan.sheets[0];
  const f = gnisFeature('gnis:2', 'Beech Gap', 'gap', first, 0.5, 0.5);
  for (const status of ['partial', 'over-cap', 'timeout', 'error']) {
    await assert.rejects(
      build({ names: { status, features: [f], retrievedAt: '2026-09-25T00:00:00.000Z' } }),
      /Named terrain \(GNIS\)/,
      `status ${status} must block export`,
    );
  }
  // Explicit disable lets the same not-ready adapter data through with nothing drawn.
  const { seen } = await build({
    layers: { names: false },
    names: { status: 'partial', features: [f], retrievedAt: '2026-09-25T00:00:00.000Z' },
  });
  assert.equal(seen.manifest.names, undefined, 'an explicitly disabled names layer draws nothing and gates nothing');
});

// Names is default-on, so a project stored before that change with names:false must print exactly as
// it did: recipeFromControls keeps the stored switch, and runBuild neither gates nor draws names.
test('a recipe stored with names:false still prints without names, even with a not-ready adapter', async () => {
  const bbox = { minLon: -83.55, minLat: 35.0, maxLon: -83.45, maxLat: 35.03 };
  const stored = { ...recipe, layers: recipeFromControls({ layers: { names: false } }, bbox, 'Stored').layers };
  assert.equal(stored.layers.names, false);
  const f = gnisFeature('gnis:3', 'Beech Gap', 'gap', plan.sheets[0], 0.5, 0.5);
  const worker = stubWorker(); const seen = {};
  await runBuild({
    recipe: stored, plan, workerFactory: () => worker, PDFLib: {},
    adapters: {
      fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }),
      createImageBitmap: async () => ({ width: 256, height: 256, close() {} }),
      names: { status: 'partial', features: [f], retrievedAt: '2026-09-25T00:00:00.000Z' },
    },
    createPdfImpl: async (a) => { Object.assign(seen, a); return new Uint8Array([0x25, 0x50, 0x44, 0x46]); },
    now: () => '2026-09-06T00:00:00.000Z',
  });
  assert.equal(seen.manifest.names, undefined, 'nothing drawn, nothing gated');
});

test('the sheet footer points at the key rather than pretending to be the whole list', async () => {
  const [first] = plan.sheets;
  const { seen } = await build({
    layers: { trails: true, recSites: true, aerial: true },
    mvum: { roads: layerResult([featureOn(first, 'FR-1', 'road', 'seasonal')]) },
  });
  // One unwrapped 7 pt line cannot carry eight credits, so it says where they are.
  assert.match(seen.meta.sourceLine, /full source credits on the map key/);
  assert.match(seen.meta.sourceLine, /retrieved 2026-09-06/, 'and still carries the retrieval record');
});

// --- named terrain reaches the PAGE, not just the manifest (N2 end-to-end) --
// The manifest/legend tests above (N3) prove provenance and the key entry; this
// proves the sheet passed to createPdfImpl actually carries a mark to draw --
// main.js's `adapters.names` wiring is worthless if nothing ends up on the page.
test('a build with the names layer on draws a name mark on the sheet that holds it', async () => {
  const first = plan.sheets[0];
  const f = gnisFeature('gnis:3', 'Sam Knob', 'summit', first, 0.5, 0.5);
  const { seen } = await build({
    layers: { names: true },
    names: { status: 'ready', features: [f], retrievedAt: '2026-09-25T00:00:00.000Z' },
  });
  const sheet = seen.sheets.find((s) => s.id === first.id);
  assert.ok(sheet, 'the sheet holding the name was assembled');
  assert.ok(Array.isArray(sheet.nameMarks) && sheet.nameMarks.some((m) => m.id === 'gnis:3'),
    'the named feature reached the sheet as a drawn mark, not just the manifest');
});
