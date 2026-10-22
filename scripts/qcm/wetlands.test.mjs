// The USFWS National Wetlands Inventory adapter.
//
// Every number asserted here was MEASURED against the live service on 2026-09-15
// (unit 1E qualification). The three that decide the design:
//
//  * REQUEST TIME, not record count, is the binding constraint. Merely SENDING
//    resultOffset/resultRecordCount re-costs the query 20x -- a Louisiana 1-degree
//    extent took 8.71 s unpaged and 176.74 s with paging params, against a
//    REQUEST_POLICY.timeoutMs of 20,000. So the count-first refusal IS the layer,
//    not a polish item, and `orderByFields` (which never returned inside 180 s at
//    all) must never be added.
//  * PAYLOAD is driven by VERTEX count. A DRY Nevada box with 17 features returned
//    2,256,343 bytes, because riverine polygons run for miles and come back whole.
//    maxAllowableOffset is mandatory, and a malformed geometry is SILENTLY IGNORED
//    (geometry=garbage answered HTTP 200 with 10,101,505 bytes), so the client is
//    the only bound that exists.
//  * EMPTY is not UNASSESSED. Wetlands_Status holds two national records, and a
//    point query against it is the only thing that tells Phoenix (surveyed, none
//    here) from the Brooks Range (never surveyed) from off-service ground.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SOURCES, REQUEST_POLICY } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import {
  LAYER_ID, SYMBOL_WETLAND, RECORD_BUDGET, GENERALISE_DEGREES, PAGE_SIZE,
  envelopeFor, countQuery, featureQuery, statusQuery, vintageQuery,
  readCount, budgetVerdict, readStatus, readVintage, normalizeWetland,
  coverageReport, fetchWetlands, LAYER_LABEL, LAYER_CAVEAT, WETLAND_SEMANTICS, readerStrings,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-wetlands.js';
import { LAYER_BY_ID } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';
import { SYMBOL_BY_KEY } from '../../themes/headlessmode/static/js/quiet-corners-maps/legend.js';

const BOX = { minLon: -88.65, minLat: 43.42, maxLon: -88.55, maxLat: 43.52 };   // Horicon Marsh, WI

// --- the measured contract ---------------------------------------------------
// Catches: a later edit relaxing the budget, the generalisation or the page size
// back to the registry-wide defaults, which a 20x-costlier service cannot afford.
// maxRecordCount is 1,000 here, NOT the 2,000 every other feature-query carries.
test('the registry entry carries the measured limits, and claims to be an inventory', () => {
  const src = SOURCES.fwsNwiWetlands;
  assert.equal(src.kind, 'feature-query');
  assert.equal(src.origin, 'https://fwspublicservices.wim.usgs.gov');
  // A photo-interpreter drew a boundary from imagery of a stated year. Nobody stood
  // there (not an observation), nothing was computed (not a model or a calculation),
  // and nothing is projected forward (not a forecast).
  assert.equal(src.claim, 'inventory');
  // The wetland features carry NO date and the service publishes none: copyrightText
  // and serviceDescription are both empty. The year lives in Data_Source, per project.
  assert.equal(src.dateBasis, 'unknown');
  assert.equal(src.cors, 'reflects-origin');
  assert.equal(src.limits.maxRecordCount, 1000, 'the server clamps 2000 to 1000');
  assert.equal(src.limits.maxAllowableOffsetDegrees, 0.0001);
  assert.equal(src.limits.recordBudgetPerExtent, 4000);
  assert.equal(RECORD_BUDGET, src.limits.recordBudgetPerExtent);
  assert.equal(GENERALISE_DEGREES, src.limits.maxAllowableOffsetDegrees);
  assert.equal(PAGE_SIZE, src.limits.maxRecordCount);
  // Three services, because the wetlands layer alone cannot say whether the ground
  // was surveyed or when the imagery it was drawn from was flown.
  const names = src.layers.map((l) => l.name);
  assert.ok(names.includes('Wetlands Mapping Status'), 'nothing can tell empty from unassessed');
  assert.ok(names.includes('Source Type'), 'nothing can state the vintage');
  // www.fws.gov/wetlandsmapservice 301s to this host; registering it would cost a
  // second origin for one service, and the CSP re-checks the host on a redirect hop.
  for (const l of src.layers) assert.match(l.queryUrl, /^https:\/\/fwspublicservices\.wim\.usgs\.gov\//);
});

// --- the client is the only bound there is -----------------------------------
// Catches hazard 1: `geometry=garbage` answered HTTP 200 with a full 1,000-record
// page and 10,101,505 bytes. There is no server-side refusal to lean on.
test('a malformed extent is refused here, because the service answers one with 10 MB', () => {
  for (const bad of [null, {}, { minLon: 'garbage', minLat: 43, maxLon: -88, maxLat: 44 },
    { minLon: NaN, minLat: 43, maxLon: -88, maxLat: 44 },
    { minLon: -88, minLat: 43, maxLon: -89, maxLat: 44 },             // inverted
    { minLon: -88.6, minLat: 43.4, maxLon: -88.6, maxLat: 43.5 },     // zero width
    { minLon: -188, minLat: 43, maxLon: -88, maxLat: 44 }]) {
    assert.throws(() => envelopeFor(bad), RangeError, `${JSON.stringify(bad)} was let through`);
    assert.throws(() => countQuery(bad), RangeError);
    assert.throws(() => featureQuery(bad), RangeError);
  }
  assert.equal(envelopeFor(BOX), '-88.65,43.42,-88.55,43.52');
});

// Catches the payload blow-up: 17 dry-box features measured 2,256,343 bytes raw and
// 150,910 generalised. Without the offset this layer is 8-15x its budget.
test('every feature query generalises geometry and asks in lon/lat', () => {
  const p = featureQuery(BOX).params;
  assert.equal(p.maxAllowableOffset, String(GENERALISE_DEGREES),
    'geometry is returned whole without this: a 17-feature dry box measured 2.2 MB');
  assert.equal(p.outSR, '4326', 'maxAllowableOffset is in the units of outSR, and paths must be lon/lat');
  assert.equal(p.inSR, '4326');
  assert.equal(p.geometryType, 'esriGeometryEnvelope');
  assert.equal(p.geometry, envelopeFor(BOX), 'the envelope must be built here, never passed through');
  assert.equal(p.returnGeometry, 'true');
  // Layer 0 is a JOIN, so every field name is TABLE-QUALIFIED; a bare ATTRIBUTE
  // fails the whole query with a 200 and an error body.
  assert.match(p.outFields, /Wetlands\.OBJECTID/);
  for (const f of p.outFields.split(',')) assert.match(f, /^Wetlands\./, `${f} is not table-qualified`);
});

// Catches the worst regression available here: adding an explicit sort. The variant
// with orderByFields=Wetlands.OBJECTID ASC did not return inside a 180 s cutoff at
// all, and paging is already stable without one (overlap 0, union exactly 1,759).
test('no query asks the service to sort', () => {
  for (const q of [countQuery(BOX), featureQuery(BOX), statusQuery(-88.6, 43.47), vintageQuery(-88.6, 43.47)]) {
    assert.ok(!('orderByFields' in q.params), `${q.url} sorts: that request never returned in 180 s`);
  }
});

// --- the count-first gate ----------------------------------------------------
// Catches the nine-fold timeout overrun. The Louisiana degree square is 29,608
// records and ~90 minutes of wall clock; the gate is what keeps this layer inside
// REQUEST_POLICY at all, so its refusal must be a real, tested branch.
test('the count gate refuses an oversized extent instead of paging it', () => {
  const q = countQuery(BOX);
  assert.equal(q.params.returnCountOnly, 'true');
  assert.equal(q.params.returnGeometry, 'false');
  assert.ok(!('maxAllowableOffset' in q.params), 'a count has no geometry to generalise');

  assert.equal(budgetVerdict(1759).ok, true, 'a real desktop view over dense marsh must still work');
  const refused = budgetVerdict(29608);
  assert.equal(refused.ok, false);
  assert.match(refused.text, /smaller area/i, 'the refusal must say what to do next');
  assert.match(refused.text, /29,608/, 'the refusal states the number it refused');
  // A count the service would not give is not permission to fetch everything.
  assert.equal(budgetVerdict(null).ok, false);
  assert.ok(RECORD_BUDGET < 29608);
  // Four pages of 1,000 at ~11 s each fits a 20 s-per-request policy; thirty do not.
  assert.ok(RECORD_BUDGET / PAGE_SIZE <= 4, 'the budget must stay inside REQUEST_POLICY');
  assert.equal(REQUEST_POLICY.timeoutMs, 20000);
});

// Catches the join duplicate: 583 features carried 582 distinct OBJECTIDs while
// returnCountOnly said 582, reproducibly. A paging loop deriving page counts from
// the count stops one row early, and a feature with no id cannot be deduped at all.
test('returnCountOnly is read as a lower bound, and features dedupe on Wetlands.OBJECTID', () => {
  const count = readCount({ count: 582 });
  assert.equal(count.atLeast, 582);
  assert.equal(count.known, true);
  assert.equal(count.count, undefined,
    'a lower bound must not be exposed as a count: 582 arrived as 583 features');
  assert.equal(readCount({ error: { code: 400 } }).known, false, 'an error body arrives as HTTP 200 here');
  assert.equal(readCount(null).known, false);

  const raw = (oid) => ({
    attributes: { 'Wetlands.OBJECTID': oid, 'Wetlands.WETLAND_TYPE': 'Freshwater Pond' },
    geometry: { rings: [[[-88.6, 43.4], [-88.5, 43.4], [-88.5, 43.5], [-88.6, 43.4]]] },
  });
  const one = normalizeWetland(raw(1933));
  assert.equal(one.id, '1933', 'without an id the shared pager cannot dedupe at all');
  assert.equal(one.layer, LAYER_ID);
  assert.equal(one.symbolKey, SYMBOL_WETLAND);
  assert.equal(one.paths.length, 1);
  assert.deepEqual(one.paths[0][0], [-88.6, 43.4], 'rings must arrive lon/lat for overlay-paths');
  assert.equal(normalizeWetland({ attributes: {}, geometry: { rings: [] } }), null, 'a ringless row draws nothing');
});

// --- the requirement this unit exists for ------------------------------------
// Catches the false empty. Phoenix answered Digital + count 0; the Brooks Range
// answered No_Data + count 0; Null Island returned no status feature at all. All
// three look identical in the wetlands layer alone, and one of them means the map
// is lying about the ground.
test('empty, never-surveyed and off-service are three different sentences', () => {
  assert.equal(readStatus({ features: [{ attributes: { STATUS: 'Digital' } }] }), 'Digital');
  assert.equal(readStatus({ features: [{ attributes: { STATUS: 'No_Data' } }] }), 'No_Data');
  assert.equal(readStatus({ features: [] }), 'off-service', 'zero status features is a THIRD state');
  assert.equal(readStatus({ error: { code: 400 } }), 'unknown');
  assert.equal(readStatus(null), 'unknown');

  const surveyed = coverageReport({ status: 'Digital', featureCount: 0 });
  const never = coverageReport({ status: 'No_Data', featureCount: 0 });
  const off = coverageReport({ status: 'off-service', featureCount: 0 });
  const unknown = coverageReport({ status: 'unknown', featureCount: 0 });
  const found = coverageReport({ status: 'Digital', featureCount: 41 });
  const texts = [surveyed.text, never.text, off.text, unknown.text, found.text];
  assert.equal(new Set(texts).size, texts.length, 'two of these states read the same to a reader');
  assert.match(surveyed.text, /surveyed|mapped/i);
  assert.match(surveyed.text, /none/i);
  assert.match(never.text, /never been mapped/i);
  assert.doesNotMatch(never.text, /there are no wetlands/i, 'unsurveyed ground is not empty ground');
  assert.match(off.text, /outside/i);
  assert.equal(surveyed.assessed, true);
  assert.equal(never.assessed, false);
  assert.equal(off.assessed, false);
  assert.equal(found.count, 41);
  // 105 No_Data parts, all Alaska and the Pacific territories: moot for the lower
  // 48, decisive above it. Saying so is what stops a CONUS reader mistrusting a
  // real empty answer.
  assert.match(never.text, /Alaska/i);
});

// --- vintage, per place ------------------------------------------------------
// Catches "1:1". Nevada returned the IMAGE_SCALE sentinel `1` and Wisconsin
// returned 20000, and a card printing 1:1 is worse than one saying nothing. The
// Wisconsin line is also 1994 black-and-white imagery -- 32 years old -- so a
// boundary shown without its vintage presents it as current.
test('vintage is read per place, and the scale sentinel never prints as 1:1', () => {
  const wi = readVintage({ features: [{ attributes: { PROJECT_NAME: 'Dodge County', IMAGE_YR: 1994,
    IMAGE_SCALE: 20000, ALL_SCALES: '1:20K', SOURCE_TYPE: 'BW' } }] });
  assert.equal(wi.known, true);
  assert.equal(wi.year, 1994);
  assert.match(wi.text, /1994/);
  assert.match(wi.text, /1:20K/, 'the scale a reader can act on');
  assert.match(wi.text, /black and white/i, 'BW is a source type, not a word a reader knows');

  const nv = readVintage({ features: [{ attributes: { PROJECT_NAME: 'Central Nevada', IMAGE_YR: 2022,
    IMAGE_SCALE: 1, ALL_SCALES: null, SOURCE_TYPE: 'CIR' } }] });
  assert.equal(nv.year, 2022);
  assert.doesNotMatch(nv.text, /1:1\b/, 'IMAGE_SCALE 1 is a sentinel, not a one-to-one map');
  assert.match(nv.text, /scale is not stated/i);

  const none = readVintage({ features: [] });
  assert.equal(none.known, false);
  assert.match(none.text, /did not/i, 'silence is stated, never assumed current');
  assert.equal(readVintage(null).known, false);
  // 28 years apart on adjacent panes of one national layer, so the layer may never
  // carry one national date.
  assert.notEqual(wi.year, nv.year);
});

// --- the words a reader is given ---------------------------------------------
// Catches the layer shipping as "wetlands are here", which is a claim about access,
// legality and today's ground that an aerial photo-interpretation cannot make.
test('the layer says what a wetland polygon does not claim', () => {
  const all = readerStrings().join(' ');
  assert.match(LAYER_LABEL, /wetland/i);
  for (const word of [/access/i, /regulat/i, /wet today/i, /aerial/i, /not a survey/i]) {
    assert.match(all, word, `nothing in this layer's words covers ${word}`);
  }
  // The registry's own prose has to agree with the layer's, because the source
  // record is what the page's source table prints.
  assert.match(SOURCES.fwsNwiWetlands.coverageSemantics, /Absence of a polygon is NOT absence of wetland/);
  assert.match(WETLAND_SEMANTICS, /survey/i);
  assert.match(WETLAND_SEMANTICS, /access/i);
  assert.ok(LAYER_CAVEAT.length > 80, 'a one-clause caveat cannot carry vintage, coverage and limits');
});

// --- the layer is wired, and its words reach the map -------------------------
// Catches the defect layers-reach-paper.test.mjs exists for, one layer earlier: a
// registry entry, a symbol and a module with nothing joining them.
test('the registry entry names this module’s symbol and source, and main.js fetches it', () => {
  const layer = LAYER_BY_ID[LAYER_ID];
  assert.ok(layer, `layer-registry has no ${LAYER_ID} entry`);
  assert.equal(layer.sourceId, 'fwsNwiWetlands');
  assert.deepEqual([...layer.symbolKeys], [SYMBOL_WETLAND]);
  assert.ok(SYMBOL_BY_KEY[SYMBOL_WETLAND], 'the symbol table has no mark for a wetland');
  assert.equal(layer.label, LAYER_LABEL);
  assert.equal(layer.coverageCaveat, LAYER_CAVEAT);
  // An empty answer here is genuinely ambiguous until the status layer is asked,
  // which is the whole point of coverageReport above.
  assert.equal(layer.emptyMeans, 'ambiguous');
  assert.equal(layer.group, 'federal', 'a vector overlay, so any context surface can still be on');
  const main = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
  assert.match(main, /fetchWetlands\(/, 'the control would switch on a layer nothing fetches');
});

// --- the fetch, offline ------------------------------------------------------
// A stub service, so the ORDER is provable without a network: count first, and the
// feature query only if the count allowed it. Catches the one regression that would
// look fine in every unit test above -- the gate computed and then not obeyed.
function stubService({ count, features = [], status = 'Digital', vintage = true }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const params = new URLSearchParams(init.body);
    calls.push({ url, params });
    const json = (body) => ({ ok: true, json: async () => body });
    if (params.get('returnCountOnly') === 'true') return json({ count });
    if (url.includes('Wetlands_Status')) {
      return json({ features: status === 'off-service' ? [] : [{ attributes: { STATUS: status } }] });
    }
    if (url.includes('Data_Source')) {
      return json({ features: vintage
        ? [{ attributes: { PROJECT_NAME: 'Dodge County', IMAGE_YR: 1994, IMAGE_SCALE: 20000,
          ALL_SCALES: '1:20K', SOURCE_TYPE: 'BW' } }] : [] });
    }
    return json({ features });
  };
  return { fetchImpl, calls };
}

test('an oversized extent is counted and then not fetched', async () => {
  const { fetchImpl, calls } = stubService({ count: 29608 });
  const answer = await fetchWetlands({ bboxLonLat: BOX, fetchImpl });
  assert.equal(answer.refused, true);
  assert.equal(answer.features.length, 0);
  assert.equal(answer.coverage, 'refused');
  assert.equal(calls.length, 1, 'the gate was computed and then ignored');
  assert.equal(calls[0].params.get('returnCountOnly'), 'true');
  assert.match(answer.report.text, /29,608/);
});

test('an allowed extent is fetched, deduped, and reported with its vintage', async () => {
  // The measured join duplicate: the same OBJECTID twice, under two code rows.
  const ring = [[-88.6, 43.4], [-88.5, 43.4], [-88.5, 43.5], [-88.6, 43.4]];
  const row = (oid, code) => ({ attributes: { 'Wetlands.OBJECTID': oid, 'Wetlands.ATTRIBUTE': code,
    'Wetlands.WETLAND_TYPE': 'Freshwater Emergent Wetland' }, geometry: { rings: [ring] } });
  const { fetchImpl, calls } = stubService({ count: 2, features: [row(1, 'PEM1Af'), row(1, 'PEM1Af'), row(2, 'PEM1B')] });
  const answer = await fetchWetlands({ bboxLonLat: BOX, fetchImpl });
  assert.equal(answer.refused, false);
  assert.equal(answer.features.length, 2, 'the join duplicate reached the map');
  assert.equal(answer.coverage, 'complete');
  assert.equal(answer.status, 'Digital');
  assert.match(answer.report.text, /1994/, 'a 32-year-old line was shown without its year');
  assert.ok(calls.some((c) => c.url.includes('Wetlands_Status')), 'nothing asked whether this ground was surveyed');
  assert.ok(calls.some((c) => c.url.includes('Data_Source')), 'nothing asked how old the imagery is');
});

test('an empty answer over unsurveyed ground never reads as "no wetlands here"', async () => {
  const { fetchImpl } = stubService({ count: 0, features: [], status: 'No_Data', vintage: false });
  const answer = await fetchWetlands({ bboxLonLat: BOX, fetchImpl });
  assert.equal(answer.status, 'No_Data');
  assert.equal(answer.report.assessed, false);
  assert.match(answer.report.text, /never been mapped/i);
  // No survey happened here, so no imagery year may be attached to it.
  assert.doesNotMatch(answer.report.text, /Mapped from/);
});
