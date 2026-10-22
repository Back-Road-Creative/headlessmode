// The road-quality enrichment: maintenance level and surface, joined onto roads
// the app already draws. Pure parsing and a stubbed fetch — no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maintenanceLevel, maintenanceText, surfaceFamily, surfaceText, roadDetail, widthTierFor,
  normalizeRoadQuality, fetchRoadQuality, fetchRoadQualityReport, ROAD_BASIC_SOURCE }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/source-road-basic.js';
import { SYMBOL_BY_KEY } from '../../themes/headlessmode/static/js/quiet-corners-maps/legend.js';

// Real values, copied from a live query over the Standing Indian quad on 2026-09-06.
const REAL = [
  { attributes: { id: '421', oper_maint_level: '3 - SUITABLE FOR PASSENGER CARS', surface_type: 'AGG - CRUSHED AGGREGATE OR GRAVEL' } },
  { attributes: { id: '67', oper_maint_level: '5 - HIGH DEGREE OF USER COMFORT', surface_type: 'AC - ASPHALT' } },
  { attributes: { id: '83', oper_maint_level: '4 - MODERATE DEGREE OF USER COMFORT', surface_type: 'BST - BITUMINOUS SURFACE TREATMENT' } },
  { attributes: { id: '437', oper_maint_level: '2 - HIGH CLEARANCE VEHICLES', surface_type: 'NAT - NATIVE MATERIAL' } },
];

test('maintenance level is read from the service prose, not guessed', () => {
  for (const [text, level] of [['3 - SUITABLE FOR PASSENGER CARS', 3], ['5 - HIGH DEGREE OF USER COMFORT', 5],
    ['1 - BASIC CUSTODIAL CARE (CLOSED)', 1], ['', null], [null, null], [undefined, null],
    ['UNKNOWN', null], ['9 - NOT A LEVEL', null], ['ML3', null]]) {
    assert.equal(maintenanceLevel(text), level, `${text}`);
  }
});

test('surface codes map to families a reader can act on', () => {
  for (const [code, family] of [['AC - ASPHALT', 'paved'], ['BST - BITUMINOUS SURFACE TREATMENT', 'paved'],
    ['PCC - PORTLAND CEMENT CONCRETE', 'paved'], ['AGG - CRUSHED AGGREGATE OR GRAVEL', 'gravel'],
    ['NAT - NATIVE MATERIAL', 'native'], ['', null], [null, null]]) {
    assert.equal(surfaceFamily(code), family, `${code}`);
  }
});

test('every tier names a symbol that exists, so a typo cannot draw nothing', () => {
  for (const level of [1, 2, 3, 4, 5]) {
    const tier = widthTierFor({ maintLevel: level, surface: null });
    assert.ok(SYMBOL_BY_KEY[tier], `level ${level} -> ${tier}, which legend.js does not have`);
  }
  // Widths must be strictly ordered: a level-5 road cannot draw thinner than a level-1.
  const w = (l) => SYMBOL_BY_KEY[widthTierFor({ maintLevel: l, surface: null })].widthIn;
  assert.ok(w(5) >= w(4) && w(4) > w(3) && w(3) > w(2) && w(2) > w(1), 'width must fall as the road gets rougher');
});

test('with no maintenance level, surface decides; with neither, nothing is claimed', () => {
  assert.equal(widthTierFor({ maintLevel: null, surface: 'paved' }), 'road-high');
  assert.equal(widthTierFor({ maintLevel: null, surface: 'gravel' }), 'road-passenger');
  assert.equal(widthTierFor({ maintLevel: null, surface: 'native' }), null, 'a native surface alone is not a rating');
  assert.equal(widthTierFor({ maintLevel: null, surface: null }), null);
});

test('normalizeRoadQuality builds the join table from real service records', () => {
  const table = normalizeRoadQuality(REAL);
  assert.deepEqual(Object.keys(table).sort(), ['421', '437', '67', '83']);
  assert.deepEqual(table['421'], { maintLevel: 3, surface: 'gravel', tier: 'road-passenger',
    maintText: 'Suitable for passenger cars', surfaceText: 'Crushed aggregate or gravel' });
  assert.deepEqual(table['437'], { maintLevel: 2, surface: 'native', tier: 'road-highclearance',
    maintText: 'High clearance vehicles', surfaceText: 'Native material' });
});

// F13's first clause: "expose these properties in road details". The app already
// FETCHES surface and maintenance level for every road it draws and spends both on
// one thing -- how thick to draw the line. A reader looking at two grey lines cannot
// tell the gravel one from the one that needs high clearance, though the inventory
// said so and the answer is already in the browser.
test('the rating is reported in the inventory\'s own words, not ours', () => {
  // The service states it in prose after the code: keeping that prose means the page
  // never has to invent a phrase for a level or a surface nobody has measured yet.
  assert.equal(maintenanceText('3 - SUITABLE FOR PASSENGER CARS'), 'Suitable for passenger cars');
  assert.equal(maintenanceText('2 - HIGH CLEARANCE VEHICLES'), 'High clearance vehicles');
  assert.equal(surfaceText('AGG - CRUSHED AGGREGATE OR GRAVEL'), 'Crushed aggregate or gravel');
  assert.equal(surfaceText('BST - BITUMINOUS SURFACE TREATMENT'), 'Bituminous surface treatment');
  // A bare code is not prose. The family is still read from it (surfaceFamily), but
  // there are no words to quote, and inventing them is what this function exists to avoid.
  assert.equal(surfaceText('AGG'), null);
  assert.equal(maintenanceText('3'), null);
  assert.equal(surfaceText(''), null);
  assert.equal(maintenanceText(null), null);
});

test('roadDetail says what is known, and stays silent about what is not', () => {
  assert.equal(roadDetail({ maintLevel: 3, maintText: 'Suitable for passenger cars',
    surface: 'gravel', surfaceText: 'Crushed aggregate or gravel' }),
  'Crushed aggregate or gravel; suitable for passenger cars (level 3)');
  // Surface stated, level not: the reader still learns the thing they came for.
  assert.equal(roadDetail({ maintLevel: null, maintText: null, surface: 'native', surfaceText: 'Native material' }),
    'Native material');
  // 'other' is what surfaceFamily answers for a code it does not recognise. Printing
  // it says "the inventory named a surface, and we could not read it" -- which is our
  // problem, not a fact about the road.
  assert.equal(roadDetail({ maintLevel: null, maintText: null, surface: 'other', surfaceText: null }), null);
  assert.equal(roadDetail({ maintLevel: null, maintText: null, surface: 'other', surfaceText: 'Bituminous compacted' }),
    'Bituminous compacted', 'but the words the record did carry are still worth saying');
  // A family with no prose behind it still says something true.
  assert.equal(roadDetail({ maintLevel: null, maintText: null, surface: 'gravel', surfaceText: null }), 'Gravel');
  assert.equal(roadDetail({ maintLevel: 2, maintText: null, surface: null, surfaceText: null }),
    'Maintenance level 2');
  // Nothing matched. The road is drawn at its plain width and says nothing extra --
  // an empty detail line would read as "the inventory says it is ordinary".
  assert.equal(roadDetail({ maintLevel: null, maintText: null, surface: null, surfaceText: null }), null);
  assert.equal(roadDetail(undefined), null);
  // Two records disagreed. Saying so is the honest answer; picking one is not.
  assert.equal(roadDetail({ ambiguous: true, maintLevel: null, surface: null }),
    'Inventory records disagree about this road');
});

test('an ambiguous route reports the disagreement, not one side of it', () => {
  const table = normalizeRoadQuality([
    { attributes: { id: '900', oper_maint_level: '2 - HIGH CLEARANCE VEHICLES', surface_type: 'NAT - NATIVE MATERIAL' } },
    { attributes: { id: '900', oper_maint_level: '5 - HIGH DEGREE OF USER COMFORT', surface_type: 'AC - ASPHALT' } },
  ]);
  assert.equal(table['900'].maintText, null, 'a contradicted record must not keep one side\'s words');
  assert.equal(table['900'].surfaceText, null);
  assert.equal(roadDetail(table['900']), 'Inventory records disagree about this road');
});

test('a record with no id is skipped, and a rated record beats an unrated duplicate', () => {
  const table = normalizeRoadQuality([
    { attributes: { id: '', oper_maint_level: '5 - HIGH', surface_type: 'AC' } },
    { attributes: { id: null, oper_maint_level: '5 - HIGH', surface_type: 'AC' } },
    { attributes: { id: '900', oper_maint_level: '3 - SUITABLE FOR PASSENGER CARS', surface_type: 'AGG' } },
    { attributes: { id: '900', oper_maint_level: null, surface_type: null } },
  ]);
  assert.deepEqual(Object.keys(table), ['900'], 'an id-less record cannot be joined to anything');
  assert.equal(table['900'].maintLevel, 3, 'the unrated duplicate must not erase the rated one');
});

test('fetchRoadQuality asks for lowercase fields and reports a refusal honestly', async () => {
  let seen = null;
  const ok = await fetchRoadQuality({
    bboxLonLat: { minLon: -83.6, minLat: 35.0, maxLon: -83.4, maxLat: 35.125 },
    fetchImpl: async (url, init) => { seen = { url, body: init.body.toString() }; return { ok: true, json: async () => ({ features: REAL }) }; },
  });
  assert.equal(Object.keys(ok).length, 4);
  assert.match(seen.url, /EDW_RoadBasic_01\/MapServer\/0\/query$/);
  // ArcGIS silently OMITS an outField it does not recognise, so the uppercase form
  // would return nothing at all and every road would fall back to its plain width.
  assert.match(seen.body, /oper_maint_level/);
  assert.match(seen.body, /surface_type/);
  assert.ok(!/OPER_MAINT_LEVEL/.test(seen.body), 'uppercase field names fail silently against ArcGIS');
  assert.match(seen.body, /geometry=-83.6%2C35\b/);

  await assert.rejects(
    fetchRoadQuality({ bboxLonLat: { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 }, fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /answered 503/);
  await assert.rejects(
    fetchRoadQuality({ bboxLonLat: { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 },
      fetchImpl: async () => ({ ok: true, json: async () => ({ error: { message: 'Invalid field' } }) }) }),
    /Invalid field/);
});

// One request answers one page. A rectangle bigger than the transfer limit used to
// come back truncated with nothing said, and every road past the cap silently lost
// its rating.
test('fetchRoadQualityReport pages, and says partial when the service still has more', async () => {
  const page = (features, more) => ({ ok: true, json: async () => ({ features, exceededTransferLimit: more }) });
  let call = 0; const offsets = [];
  const r = await fetchRoadQualityReport({
    bboxLonLat: { minLon: -83.6, minLat: 35.0, maxLon: -83.4, maxLat: 35.125 },
    fetchImpl: async (_u, o) => { offsets.push(o.body.get('resultOffset'));
      return ++call === 1 ? page(REAL.slice(0, 2), true) : page(REAL.slice(2), false); },
  });
  assert.deepEqual(offsets, ['0', '2'], 'the second page must start after the first');
  assert.equal(r.pages, 2);
  assert.equal(r.coverage, 'complete');
  assert.deepEqual(Object.keys(r.byId).sort(), ['421', '437', '67', '83']);

  const stuck = await fetchRoadQualityReport({ bboxLonLat: { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 },
    fetchImpl: async () => page([], true) });
  assert.equal(stuck.coverage, 'partial', 'a truncated enrichment must not read as a complete one');
  assert.deepEqual(stuck.byId, {});
});

test('two records disagreeing about one route are marked ambiguous, not picked between', () => {
  const table = normalizeRoadQuality([
    { attributes: { id: '900', oper_maint_level: '2 - HIGH CLEARANCE VEHICLES', surface_type: 'NAT - NATIVE MATERIAL' } },
    { attributes: { id: '900', oper_maint_level: '5 - HIGH DEGREE OF USER COMFORT', surface_type: 'AC - ASPHALT' } },
  ]);
  assert.equal(table['900'].ambiguous, true);
  assert.equal(table['900'].maintLevel, null, 'the map must not claim a level the source contradicts');
  assert.equal(table['900'].surface, null);
  assert.equal(table['900'].tier, null, 'no tier means the road draws at its plain width');
  // Silence is not a contradiction: an unrated duplicate still loses to a rating.
  const agreed = normalizeRoadQuality([
    { attributes: { id: '901', oper_maint_level: '3 - SUITABLE FOR PASSENGER CARS', surface_type: 'AGG - GRAVEL' } },
    { attributes: { id: '901', oper_maint_level: null, surface_type: null } },
  ]);
  assert.equal(agreed['901'].maintLevel, 3);
  assert.equal(agreed['901'].ambiguous, undefined, 'no conflict, no flag');
});

test('the source declares what it does and does not assert', () => {
  assert.equal(ROAD_BASIC_SOURCE.origin, 'https://apps.fs.usda.gov', 'already a CSP-allowed origin');
  assert.match(ROAD_BASIC_SOURCE.coverageSemantics, /not a report of current condition/);
  assert.match(ROAD_BASIC_SOURCE.coverageSemantics, /drawn at its plain width rather than guessed/);
});
