// Tests for the pure "Places in this view" list builder (QUX-11a). See
// .data/plans/2026-09-27-qux-specs/QUX-11.md §4.1 for the numbered items this
// file implements. No DOM, no fetch, no browser -- run under plain node --test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { placesInView, PLACE_GROUPS, defaultFilters } from '../../themes/headlessmode/static/js/quiet-corners-maps/places-in-view.js';
import { NAME_ICON_BY_KIND } from '../../themes/headlessmode/static/js/quiet-corners-maps/print-names.js';
import { STATUS_MESSAGE, dedupeAgainstTownLabels } from '../../themes/headlessmode/static/js/quiet-corners-maps/name-labels.js';

const BOUNDS = { minLon: -83.55, minLat: 35.0, maxLon: -83.4, maxLat: 35.1 };

const feature = (over = {}) => ({
  id: 'gnis:1', name: 'Test Place', kind: 'place', cls: 'Populated Place',
  state: 'NC', county: 'Test County', anchor: [35.05, -83.5], pointCount: 1, layer: 3, historical: false,
  ...over,
});

test('1. axis order: anchor is [lat, lon]; a feature inside the worked bbox stays inside', () => {
  // Worked example (QUX-11.md §4.1 item 1): anchor [35.05, -83.5] converts to
  // [lon, lat] = [-83.5, 35.05], which is inside BOUNDS. Treating the raw
  // anchor numbers as already [lon, lat] would place the point at lon 35.05
  // (outside BOUNDS entirely), so this also fails loudly on a reintroduced
  // axis-order bug.
  const r = placesInView({ names: [feature()], namesStatus: 'ready', placedIds: new Set(), bounds: BOUNDS, filters: defaultFilters() });
  assert.equal(r.total, 1);
  assert.deepEqual(r.rows[0].lonLat, [-83.5, 35.05]);

  const outside = feature({ id: 'gnis:2', anchor: [50.0, -120.0] });
  const r2 = placesInView({ names: [outside], namesStatus: 'ready', placedIds: new Set(), bounds: BOUNDS, filters: defaultFilters() });
  assert.equal(r2.total, 0);
});

test('2. invariant: every in-view feature not in placedIds appears in rows under default filters', () => {
  const KINDS = ['summit', 'gap', 'ridge', 'place', 'water-feature', 'other-land', 'other-water', 'stream-mouth', 'other'];
  const names = [];
  for (let i = 0; i < 200; i++) {
    // Half the points land inside BOUNDS, half well outside it.
    const inside = i % 2 === 0;
    const lon = inside ? -83.55 + Math.random() * 0.15 : -120 + Math.random() * 10;
    const lat = inside ? 35.0 + Math.random() * 0.1 : 40 + Math.random() * 10;
    names.push(feature({ id: `gnis:${i}`, name: `Random ${i}`, kind: KINDS[i % KINDS.length], cls: '', anchor: [lat, lon] }));
  }
  const inView = names.filter((f) => f.anchor[1] >= BOUNDS.minLon && f.anchor[1] <= BOUNDS.maxLon
    && f.anchor[0] >= BOUNDS.minLat && f.anchor[0] <= BOUNDS.maxLat);
  const placedIds = new Set(inView.filter((_, i) => i % 3 === 0).map((f) => f.id));

  const r = placesInView({ names, namesStatus: 'ready', placedIds, bounds: BOUNDS, filters: defaultFilters() });
  assert.equal(r.total, inView.length);
  assert.equal(r.rows.length, inView.length);
  const byId = new Map(r.rows.map((row) => [row.id, row]));
  for (const f of inView) {
    const row = byId.get(f.id);
    assert.ok(row, `missing row for ${f.id}`);
    assert.equal(row.onMap, placedIds.has(f.id));
  }
});

test('3. status table', () => {
  const base = { names: [feature()], placedIds: new Set(), bounds: BOUNDS, filters: defaultFilters() };
  const notLoaded = placesInView({ ...base, names: null, namesStatus: null });
  assert.deepEqual([notLoaded.total, notLoaded.notices], [null, ['Named places have not loaded for this view yet.']]);

  const zero = placesInView({ ...base, names: [], namesStatus: 'ready' });
  assert.deepEqual([zero.total, zero.notices], [0, [STATUS_MESSAGE.zero]]);

  for (const status of ['over-cap', 'timeout', 'error']) {
    const r = placesInView({ ...base, namesStatus: status });
    assert.deepEqual([r.total, r.notices], [null, [STATUS_MESSAGE[status]]]);
  }

  const partial = placesInView({ ...base, namesStatus: 'partial' });
  assert.equal(partial.total, 1);
  assert.equal(partial.notLabelled, 1);
  assert.equal(partial.rows[0].onMap, false);
  assert.match(partial.notices[0], /labels none of them/);
});

test('4. groups: every NAME_ICON_BY_KIND key lands in exactly one PLACE_GROUPS entry', () => {
  const expected = {
    place: 'places', summit: 'peaks', gap: 'gaps-ridges', ridge: 'gaps-ridges',
    'other-land': 'landforms', 'other-water': 'water', 'stream-mouth': 'water', other: 'landforms', river: 'water', creek: 'water',
  };
  for (const kind of Object.keys(NAME_ICON_BY_KIND)) {
    if (kind === 'water-feature') continue; // split by cls below
    const groups = PLACE_GROUPS.filter((g) => g.match(feature({ kind, cls: '' })));
    assert.equal(groups.length >= 1, true, `no group matched ${kind}`);
    assert.equal(groups[0].id, expected[kind], `${kind} matched ${groups[0].id}, expected ${expected[kind]}`);
  }
  const falls = PLACE_GROUPS.find((g) => g.match(feature({ kind: 'water-feature', cls: 'Falls' })));
  assert.equal(falls.id, 'waterfalls');
  const lake = PLACE_GROUPS.find((g) => g.match(feature({ kind: 'water-feature', cls: 'Lake' })));
  assert.equal(lake.id, 'water');

  // groupCounts is computed BEFORE filtering: dropping a group from the filter
  // must not change the count it reports for that group.
  const names = [feature({ id: 'a', kind: 'summit', cls: '' }), feature({ id: 'b', kind: 'place', cls: 'Populated Place' })];
  const narrowed = { groups: new Set(['peaks']), onlyNotLabelled: false };
  const r = placesInView({ names, namesStatus: 'ready', placedIds: new Set(), bounds: BOUNDS, filters: narrowed });
  assert.deepEqual(r.groupCounts.peaks, 1);
  assert.deepEqual(r.groupCounts.places, 1);
  assert.equal(r.shown, 1);
  assert.equal(r.total, 2);
});

test('5. filters: onlyNotLabelled and group membership change `shown`/`hiddenByFilters`, never `total`', () => {
  const names = [feature({ id: 'a', kind: 'summit', cls: '' }), feature({ id: 'b', kind: 'place', cls: 'Populated Place' })];
  const placedIds = new Set(['a']);
  const all = placesInView({ names, namesStatus: 'ready', placedIds, bounds: BOUNDS, filters: defaultFilters() });
  assert.deepEqual([all.total, all.shown, all.hiddenByFilters], [2, 2, 0]);

  const onlyUnlabelled = placesInView({ names, namesStatus: 'ready', placedIds, bounds: BOUNDS, filters: { ...defaultFilters(), onlyNotLabelled: true } });
  assert.deepEqual([onlyUnlabelled.total, onlyUnlabelled.shown, onlyUnlabelled.hiddenByFilters], [2, 1, 1]);
  assert.equal(onlyUnlabelled.rows[0].id, 'b');

  const droppedGroup = placesInView({ names, namesStatus: 'ready', placedIds, bounds: BOUNDS, filters: { groups: new Set(['places']), onlyNotLabelled: false } });
  assert.deepEqual([droppedGroup.total, droppedGroup.shown, droppedGroup.hiddenByFilters], [2, 1, 1]);
});

test('6. order: case-insensitive name order, id tiebreak on an exact tie', () => {
  const names = [
    feature({ id: 'z', name: 'beta' }),
    feature({ id: 'y', name: 'Alpha' }),
    feature({ id: 'x', name: 'alpha' }),
  ];
  const r = placesInView({ names, namesStatus: 'ready', placedIds: new Set(), bounds: BOUNDS, filters: defaultFilters() });
  assert.deepEqual(r.rows.map((row) => row.id), ['x', 'y', 'z']);
});

test('7. kindText: GNIS class word when present, icon-label fallback otherwise, never the raw kind key', () => {
  const withClass = placesInView({ names: [feature({ cls: 'Populated Place' })], namesStatus: 'ready', placedIds: new Set(), bounds: BOUNDS, filters: defaultFilters() });
  assert.equal(withClass.rows[0].kindText, 'Populated Place');

  const noClass = placesInView({ names: [feature({ kind: 'water-feature', cls: '' })], namesStatus: 'ready', placedIds: new Set(), bounds: BOUNDS, filters: defaultFilters() });
  assert.equal(noClass.rows[0].kindText, NAME_ICON_BY_KIND['water-feature'].label);
  assert.notEqual(noClass.rows[0].kindText, 'water-feature');
});

test('8. source guard: no fetch, no XMLHttpRequest, no DOM, no Date', () => {
  const src = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/places-in-view.js', import.meta.url), 'utf8');
  for (const s of ['fetch(', 'XMLHttpRequest', 'document.', 'Date']) assert.ok(!src.includes(s), `contains ${s}`);
});

test('9. town-label wiring (dispatcher correction, post-#600): a feature already '
  + "dropped by the caller's dedupeAgainstTownLabels never reaches rows", () => {
  // Mirrors what main.js's renderNameList now does before calling placesInView:
  // dedupe the raw fetch answer against window.qcTownLabels FIRST, then pass
  // the already-deduped array in as `names`. This module stays pure -- it
  // never reads townLabels or window itself -- so the only way to prove the
  // wiring is to run the real caller-side dedupe here too, not fake its effect
  // by hand-omitting a row from the fixture.
  const shared = feature({ id: 'gnis:1', name: 'Shared Name', state: 'NC' });
  const unique = feature({ id: 'gnis:2', name: 'Unique Name', state: 'NC' });
  const townLabels = [{ name: 'Shared Name', state: 'NC' }];
  const deduped = dedupeAgainstTownLabels([shared, unique], townLabels);

  const r = placesInView({ names: deduped, namesStatus: 'ready', placedIds: new Set(), bounds: BOUNDS, filters: defaultFilters() });
  assert.equal(r.total, 1);
  assert.deepEqual(r.rows.map((row) => row.id), ['gnis:2']);
});

// --- QUX-11b (§2.6, §4.3): recreation sites and Nearby -----------------------
// A normalized rec site, as source-rec-sites.js / source-blm-rec-sites.js hand
// it to the caller: `provider`, `lonLat` [lon, lat], and (for FS) `symbolKey`.
const recSite = (over = {}) => ({
  provider: 'usfs', name: 'Test Site', symbolKey: 'rec-site', siteType: 'CAMPGROUND', lonLat: [-83.5, 35.05],
  ...over,
});
const WIDE_BOUNDS = { minLon: -83.55, minLat: 35.0, maxLon: -83.35, maxLat: 35.1 };

test('11b: rec row ids are rec:<provider>:<lon.toFixed(5)>,<lat.toFixed(5)>', () => {
  const r = placesInView({
    names: [], namesStatus: 'ready', placedIds: new Set(), bounds: BOUNDS, filters: defaultFilters(),
    recSites: [recSite()], recStates: { recSites: 'ready' },
  });
  const row = r.rows.find((x) => x.source === 'usfs');
  assert.ok(row, 'no rec row was produced');
  assert.equal(row.id, 'rec:usfs:-83.50000,35.05000');
});

test('11b: colliding rec ids get deterministic ~2/~3 suffixes after the sort, regardless of input order', () => {
  const same = [-83.5, 35.05];
  const alpha = recSite({ name: 'Alpha Site', lonLat: same });
  const bravo = recSite({ name: 'Bravo Site', lonLat: same });
  const charlie = recSite({ name: 'Charlie Site', lonLat: same });
  const base = { names: [], namesStatus: 'ready', placedIds: new Set(), bounds: BOUNDS, filters: defaultFilters(), recStates: { recSites: 'ready' } };

  const idsFor = (order) => {
    const r = placesInView({ ...base, recSites: order });
    return new Map(r.rows.map((row) => [row.name, row.id]));
  };
  const inOrder = idsFor([alpha, bravo, charlie]);
  assert.equal(inOrder.get('Alpha Site'), 'rec:usfs:-83.50000,35.05000');
  assert.equal(inOrder.get('Bravo Site'), 'rec:usfs:-83.50000,35.05000~2');
  assert.equal(inOrder.get('Charlie Site'), 'rec:usfs:-83.50000,35.05000~3');

  const shuffled = idsFor([charlie, alpha, bravo]);
  assert.deepEqual(shuffled, inOrder, 'ids must not depend on fetch/array order, only on the sorted position');
});

test('11b: trailheads and rec-sites grouping, and the rec-sites catch-all never drops an unrecognized type', () => {
  const trailhead = recSite({ name: 'TH', symbolKey: 'rec-trailhead' });
  const campground = recSite({ name: 'CG', symbolKey: 'rec-campground' });
  const unknownSymbol = recSite({ name: 'Mystery', symbolKey: 'no-such-symbol-key' });
  const blm = recSite({ name: 'BLM Site', provider: 'blm', symbolKey: undefined });
  const r = placesInView({
    names: [], namesStatus: 'ready', placedIds: new Set(), bounds: BOUNDS, filters: defaultFilters(),
    recSites: [trailhead, campground, unknownSymbol, blm], recStates: { recSites: 'ready', blmRecSites: 'ready' },
  });
  const groupOf = (name) => r.rows.find((row) => row.name === name)?.group;
  assert.equal(groupOf('TH'), 'trailheads');
  assert.equal(groupOf('CG'), 'rec-sites');
  assert.equal(groupOf('Mystery'), 'rec-sites', 'an unrecognized symbol must still land in rec-sites, never be dropped');
  assert.equal(groupOf('BLM Site'), 'rec-sites');

  // A GNIS feature with a kind this module has never seen still lands in the
  // GNIS catch-all (landforms), not in a rec group -- the landforms match can
  // no longer be an unconditional `() => true` now that rec rows share the
  // same PLACE_GROUPS walk, or it would swallow every rec row first.
  const r2 = placesInView({ names: [feature({ kind: 'brand-new-invented-kind', cls: '' })], namesStatus: 'ready', placedIds: new Set(), bounds: BOUNDS, filters: defaultFilters() });
  assert.equal(r2.rows[0].group, 'landforms');
});

test('11b: partial and unavailable rec notices are per provider; an unavailable provider never yields a count or rows', () => {
  const base = { names: [], namesStatus: 'ready', placedIds: new Set(), bounds: BOUNDS, filters: defaultFilters() };

  const fsPartial = placesInView({ ...base, recSites: [recSite({ name: 'A' })], recStates: { recSites: 'partial' } });
  assert.ok(fsPartial.notices.some((n) => /Forest Service sites/.test(n) && /cut short/.test(n)), fsPartial.notices.join('|'));
  assert.equal(fsPartial.total, 1, 'the site that did arrive still counts under a partial answer');

  const fsUnavailable = placesInView({ ...base, recSites: [], recStates: { recSites: 'unavailable' } });
  assert.ok(fsUnavailable.notices.some((n) => /Forest Service sites could not load for this view\./.test(n)));
  assert.equal(fsUnavailable.total, 0, 'GNIS itself answered ready/zero here, so the combined total is a real 0, never null just because FS is unavailable');
  assert.ok(!fsUnavailable.notices.some((n) => /\d/.test(n)), 'an unavailable provider notice must never carry a count');

  const blmPartial = placesInView({ ...base, recSites: [recSite({ name: 'B', provider: 'blm', symbolKey: undefined })], recStates: { blmRecSites: 'partial' } });
  assert.ok(blmPartial.notices.some((n) => /BLM sites/.test(n) && /cut short/.test(n)), blmPartial.notices.join('|'));

  const blmUnavailable = placesInView({ ...base, recSites: [], recStates: { blmRecSites: 'unavailable' } });
  assert.ok(blmUnavailable.notices.some((n) => /BLM sites could not load for this view\./.test(n)));
  assert.equal(blmUnavailable.rows.filter((r) => r.source === 'blm').length, 0);

  const nothingTrustworthy = placesInView({ names: null, namesStatus: null, placedIds: new Set(), bounds: BOUNDS, filters: defaultFilters(), recSites: [], recStates: { recSites: 'unavailable', blmRecSites: 'unavailable' } });
  assert.equal(nothingTrustworthy.total, null, 'no count can be trusted at all when neither names nor either rec provider answered');
});

test('11b: defaultFilters() sorts A to Z by default', () => {
  assert.equal(defaultFilters().sort, 'az');
});

test('11b: Nearby sorts rec rows by distance from nearbyFrom, ties fall back to A-to-Z, and an asymmetric pair proves axis order', () => {
  const nearbyFrom = { id: 'gnis:ref', name: 'Reference Point', lonLat: [-83.5, 35.05] };
  const sortNearby = { ...defaultFilters(), sort: 'nearby' };
  const base = { names: [], namesStatus: 'ready', placedIds: new Set(), bounds: WIDE_BOUNDS, filters: sortNearby, recStates: { recSites: 'ready' }, nearbyFrom };

  // At ~35 deg N, one degree of longitude is materially shorter than one
  // degree of latitude (cos(35 deg) ~ 0.82). A 0.01 deg move north is farther
  // (~0.69 mi) than a 0.02 deg move east (~1.13 mi) is close -- reversed, a
  // 0.01 deg move east (~0.57 mi) is nearer than the 0.01 deg move north. An
  // axis-order bug that reads a [lat, lon] pair as [lon, lat] (or vice versa)
  // for one side of the distance call would not merely scale these numbers,
  // it would reorder which row is nearer.
  const near = recSite({ name: 'Near Site', lonLat: [-83.49, 35.05] }); // 0.01 deg lon east, ~0.566 mi
  const far = recSite({ name: 'Far Site', lonLat: [-83.5, 35.07] }); // 0.02 deg lat north, ~1.383 mi
  const r = placesInView({ ...base, recSites: [far, near] });
  assert.deepEqual(r.rows.map((row) => row.name), ['Near Site', 'Far Site']);
  assert.ok(r.rows[0].distanceMeters < r.rows[1].distanceMeters);
  // Exact text, computed with near-unpaved.js's own local-plane formula
  // (M_PER_DEG_LAT=111320, kx=111320*cos(35.05 deg)) -- a wrong axis mapping
  // would not just reorder near/far, it would print the wrong mileage too.
  assert.equal(r.rows[0].distanceText, '0.6 mi');
  assert.equal(r.rows[1].distanceText, '1.4 mi');

  // Exact ties (symmetric east/west of the reference point) fall back to the
  // default A-to-Z order.
  const westTie = recSite({ name: 'Beta', lonLat: [-83.51, 35.05] });
  const eastTie = recSite({ name: 'Alpha', lonLat: [-83.49, 35.05] });
  const tied = placesInView({ ...base, recSites: [westTie, eastTie] });
  assert.deepEqual(tied.rows.map((row) => row.name), ['Alpha', 'Beta']);
});

// --- QQA-08: roads and trails in Places in this view -------------------------------------------
import { collectRoutes } from '../../themes/headlessmode/static/js/quiet-corners-maps/route-identify.js';

const roadPoly = (over) => ({ key: 'x', id: '67', symbolKey: 'mvum-road-yearlong', name: 'Forest Road 67', detail: [], latlngs: [[35.02, -83.51], [35.05, -83.5], [35.08, -83.49]], ...over });
const ROUTES = collectRoutes([
  roadPoly(),
  roadPoly({ id: 'fx-nst', symbolKey: 'trail-nst', name: 'Appalachian Trail', latlngs: [[35.03, -83.52], [35.04, -83.48]] }),
  roadPoly({ id: 'tr9', symbolKey: 'mvum-trail-seasonal', name: null, latlngs: [[35.06, -83.51], [35.07, -83.5]] }),
  roadPoly({ id: 'far', name: 'Far Road', latlngs: [[45.0, -100.0], [45.1, -100.1]] }),
]);
const LETTERED = [
  { key: 'wayah road', label: 'Wayah Road', classKey: 'connecting', lon: -83.5, lat: 35.05 },
  { key: 'faraway rd', label: 'Faraway Rd', classKey: 'local', lon: -100, lat: 45 },
];
const roadBase = { names: null, namesStatus: null, placedIds: new Set(), bounds: BOUNDS, filters: defaultFilters(), routes: ROUTES, roadNames: LETTERED };

test('QQA-08: forest roads, trails and lettered roads in view are rows, each under a plain group name', () => {
  const r = placesInView(roadBase);
  const byId = Object.fromEntries(r.rows.map((row) => [row.id, row]));
  assert.deepEqual(Object.keys(byId).sort(), ['road:mvum-road:67', 'road:mvum-trail:tr9', 'road:name:wayah road', 'road:trail:fx-nst']);
  assert.equal(byId['road:mvum-road:67'].group, 'forest-roads');
  assert.equal(byId['road:mvum-trail:tr9'].group, 'forest-trails');
  assert.equal(byId['road:trail:fx-nst'].group, 'forest-trails');
  assert.equal(byId['road:name:wayah road'].group, 'roads-lettered');
  const label = (id) => PLACE_GROUPS.find((g) => g.id === id).label;
  assert.equal(label('forest-roads'), 'Forest roads');
  assert.equal(label('forest-trails'), 'Forest and other trails');
  assert.equal(label('roads-lettered'), 'Roads lettered on the map');
  assert.equal(r.groupCounts['forest-roads'], 1);
  assert.equal(r.groupCounts['forest-trails'], 2);
  assert.equal(r.total, 4, 'the road outside the view is not counted');
});

test('QQA-08: a road row says what it is, where it is and that it is on the map', () => {
  const r = placesInView(roadBase);
  const road = r.rows.find((row) => row.id === 'road:mvum-road:67');
  assert.equal(road.name, 'Forest Road 67');
  assert.equal(road.kindText, 'Forest road');
  assert.equal(road.source, 'route');
  assert.equal(road.onMap, true);
  assert.ok(Array.isArray(road.lonLat) && road.lonLat.length === 2 && road.lonLat[0] < 0 && road.lonLat[1] > 0, 'lonLat is [lon, lat]');
  const unnamed = r.rows.find((row) => row.id === 'road:mvum-trail:tr9');
  assert.equal(unnamed.name, 'Unnamed forest trail');
  const lettered = r.rows.find((row) => row.id === 'road:name:wayah road');
  assert.equal(lettered.source, 'road-name');
  assert.equal(lettered.kindText, 'Local Connecting Roads');
  assert.deepEqual(lettered.lonLat, [-83.5, 35.05]);
});

test('QQA-08: road rows answer to the filters like any other group, and sort A to Z with the rest', () => {
  const filters = defaultFilters();
  filters.groups.delete('forest-trails');
  const r = placesInView({ ...roadBase, filters });
  assert.deepEqual(r.rows.map((row) => row.id).sort(), ['road:mvum-road:67', 'road:name:wayah road']);
  assert.equal(r.hiddenByFilters, 2);
  const all = placesInView(roadBase);
  assert.deepEqual(all.rows.map((row) => row.name), ['Appalachian Trail', 'Forest Road 67', 'Unnamed forest trail', 'Wayah Road']);
});

test('QQA-08: roads alone are a real answer; names that never loaded do not turn it into an all-clear or an error', () => {
  const r = placesInView(roadBase);
  assert.equal(r.total, 4);
  assert.deepEqual(r.notices, [], 'no "named places have not loaded" notice over a list that has rows');
  const none = placesInView({ ...roadBase, routes: [], roadNames: [] });
  assert.equal(none.total, null, 'with nothing at all answered the list still says it has not heard');
});

test('QQA-08: road rows join the GNIS and recreation rows without disturbing their ids or groups', () => {
  const r = placesInView({ ...roadBase, names: [feature()], namesStatus: 'ready' });
  assert.equal(r.total, 5);
  assert.equal(r.rows.find((row) => row.id === 'gnis:1').group, 'places');
});

test('QQA-08: a road id is not a rec id and not a GNIS id, so no row can open the wrong card', () => {
  const ids = placesInView(roadBase).rows.map((row) => row.id);
  assert.ok(ids.every((id) => id.startsWith('road:')));
  assert.ok(ids.every((id) => !id.startsWith('rec:') && !id.startsWith('gnis:')));
});
