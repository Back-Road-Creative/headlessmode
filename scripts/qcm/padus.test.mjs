// PAD-US public access, against the bytes the service actually returned. No network.
//
// Four traps were MEASURED on this service on 2026-09-14 and every one of them reads as a
// plausible answer rather than as a failure. They are what this file is for:
//
//  1. A bad request answers HTTP 200 with `{"error":{…}}` and NO `features` key, so
//     `response.ok` is true and `(json.features ?? []).length === 0` reads it as "no
//     protected land here". The fixture is that exact body.
//  2. Outside the lower 48 the layer is mostly ONE 105,513,892-acre `Non-PAD-US Area`
//     polygon carrying `Pub_Access: UK`. Read plainly it tells a reader in interior Alaska
//     that public access is unknown across a sixth of the country. It means the inventory
//     stops there.
//  3. `GIS_Acres` is the WHOLE unit's area, not the part on screen. Six records intersecting
//     a 491,877-acre rectangle sum to 3,033,604 acres — 6.2x the box — with nothing
//     overlapping. So the field may be reported per named unit and never summed.
//  4. The service's own renderer defines classes for RA, OA and XA only. There is no `UK`
//     class and no default symbol, yet a /query returns 43,047 UK records. Anything that
//     inherits the service's symbology drops a third of the inventory silently, so UK has
//     to be decided here rather than inherited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SOURCES, cspDirectivesFor, APPROVED_ORIGINS } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import {
  LAYER_ID, SERVICE, CREDIT, ACCESS_TEXT, ACCESS_ORDER, FILLER_UNIT, OUT_FIELDS,
  padusQueryFor, padusQueryUrl, readAccess, countByAccess, unitLine, accessReport,
  quietText, serviceErrorText, outsideCoverageText, readerStrings, LAYER_LABEL, LAYER_CAVEAT,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-padus.js';
import { LAYER_BY_ID, GROUP_IDS } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';

const fixture = (n) => JSON.parse(readFileSync(new URL(`fixtures/${n}.json`, import.meta.url), 'utf8'));
// The live 2026-09-15 query over -91.6,47.7 -> -91.0,48.1 (the Boundary Waters box), six
// records, five OA and the wilderness RA, filler excluded server-side.
const BW = fixture('padus-boundary-waters-2026-09-15');
// The same question asked over interior Alaska with no exclusion: seven records, one of
// them the 105,513,892-acre filler.
const ALASKA = fixture('padus-alaska-filler-2026-09-15');
// HTTP 200, `application/json`, an `error` object and no `features` key at all.
const ERROR_200 = fixture('padus-error-envelope-2026-09-15');
const EMPTY = { features: [] };
const BW_BOX = { minLon: -91.6, minLat: 47.7, maxLon: -91.0, maxLat: 48.1 };

test('the registry entry records what was measured, and costs the CSP nothing', () => {
  const s = SOURCES.padusPublicAccess;
  assert.equal(s.serviceUrl, SERVICE);
  assert.equal(s.limits.requiresKey, false);
  assert.deepEqual([s.kind, s.cors, s.claim], ['feature-query', 'wildcard', 'inventory']);
  // The service publishes NO version string anywhere — not in the FeatureServer JSON, the
  // layer JSON or the item JSON. Claiming one would be inventing it.
  assert.equal(s.dateBasis, 'unknown');
  // services.arcgis.com was already in connect-src for the AirNow contours, so this source
  // adds no origin and no character to the policy. That is the whole reason it was chosen.
  assert.equal(s.origin, 'https://services.arcgis.com');
  assert.equal(SOURCES.epaAirNowAqi.origin, s.origin, 'the origin this entry reuses');
  assert.ok(APPROVED_ORIGINS.includes(s.origin));
  const csp = cspDirectivesFor();
  assert.ok(!csp['img-src'].includes(s.origin), 'it is fetched, never painted as an <img>');
  // The field list is what a row renders; asking for one the layer lacks is trap 1.
  const fields = new Set(s.layers[0].fields);
  assert.deepEqual([...fields], [...OUT_FIELDS]);
  for (const f of ['Unit_Nm', 'Pub_Access', 'GIS_Acres']) assert.ok(fields.has(f), `${f} is read and unrequested`);
});

test('the four access codes are the service\'s own words, and UK is one of them', () => {
  assert.deepEqual([...ACCESS_ORDER], ['OA', 'RA', 'XA', 'UK']);
  assert.deepEqual(Object.keys(ACCESS_TEXT).sort(), ['OA', 'RA', 'UK', 'XA']);
  assert.match(ACCESS_TEXT.OA, /^Open/);
  assert.match(ACCESS_TEXT.RA, /^Restricted/);
  assert.match(ACCESS_TEXT.XA, /^Closed/);
  // The renderer has NO class for UK, so the picture drops 43,047 records the query returns.
  // Unknown is a fourth answer here, never a shade of Open and never silence.
  assert.match(ACCESS_TEXT.UK, /^Unknown/);
  assert.notEqual(ACCESS_TEXT.UK, ACCESS_TEXT.OA);
});

test('the query excludes the filler server-side and asks only for fields the layer has', () => {
  const req = padusQueryFor(BW_BOX);
  assert.equal(req.url, `${SERVICE}/query`);
  assert.match(req.params.where, /Unit_Nm <> 'Non-PAD-US Area'/,
    'robust by construction: the continent-sized filler never reaches the reader at all');
  assert.equal(req.params.geometryType, 'esriGeometryEnvelope');
  assert.equal(req.params.inSR, '4326');
  assert.equal(req.params.returnGeometry, 'false', 'nothing here draws a polygon, and geometry is 150x the bytes');
  assert.deepEqual(req.params.outFields.split(','), [...OUT_FIELDS]);
  const url = padusQueryUrl(BW_BOX);
  assert.ok(url.startsWith(`${SERVICE}/query?`));
  assert.ok(!/(key|token|apikey)=/i.test(url), 'key-free is why this source was chosen');
});

// TRAP 1. `response.ok` is TRUE on this body.
test('an HTTP 200 carrying an error object is a failure to answer, not an empty answer', () => {
  assert.ok(!('features' in ERROR_200) && ERROR_200.error, 'the fixture must be the real shape');
  assert.equal(readAccess(ERROR_200), null, 'no features array means the service did not answer');
  assert.equal(readAccess(null), null);
  assert.equal(readAccess({}), null);
  const report = accessReport(ERROR_200);
  assert.equal(report.known, false);
  assert.equal(report.text, serviceErrorText());
  assert.notEqual(report.text, quietText(), 'a failure must never be worded as "no protected land here"');
  assert.match(report.text, /did not answer|failed/i);
  // And the real empty answer is a DIFFERENT sentence.
  assert.equal(accessReport(EMPTY).text, quietText());
});

// TRAP 2. In CONUS "not protected" returns zero records; outside it returns a filler that
// reads like an answer.
test('the Non-PAD-US filler is suppressed and reported as coverage stopping', () => {
  const filler = ALASKA.features.filter((f) => f.attributes.Unit_Nm === FILLER_UNIT);
  assert.equal(filler.length, 1, 'the fixture must still carry the record this test is about');
  assert.equal(filler[0].attributes.Pub_Access, 'UK');
  assert.equal(filler[0].attributes.GIS_Acres, 105513892);

  const read = readAccess(ALASKA);
  assert.ok(!read.rows.some((r) => r.unit === FILLER_UNIT), 'the filler must not become a unit');
  assert.equal(read.fillerCount, 1);
  const report = accessReport(ALASKA);
  assert.ok(report.text.includes(outsideCoverageText()),
    'a reader must be told the inventory stops here, not that access is unknown');
  assert.doesNotMatch(report.text, /105,?513,?892/, 'the filler\'s acreage may never be shown');
  assert.doesNotMatch(report.text, new RegExp(FILLER_UNIT), 'nor its name, which reads as a place');
  // The real Alaska units in the same answer still arrive.
  assert.ok(read.rows.some((r) => r.unit === 'Koyukuk National Wildlife Refuge' && r.code === 'RA'));
});

// TRAP 3. Six records intersecting a 491,877-acre box sum to 3,033,604 acres.
test('acreage is reported per named unit and never summed over the area', () => {
  const read = readAccess(BW);
  const total = read.rows.reduce((n, r) => n + (r.unitAcres || 0), 0);
  assert.ok(total > 3000000, `the fixture must still reproduce the trap; it sums to ${total}`);
  const strings = readerStrings(BW);
  for (const s of strings) {
    assert.doesNotMatch(s, /3,?033,?604/, `a summed acreage reached a reader: ${s}`);
    assert.doesNotMatch(s, /\b(total|combined|altogether|together|across this area)\b[^.]{0,40}acres/i,
      `acreage is described as the area's, and it is the units' own: ${s}`);
  }
  // Where an acreage IS shown it is the unit's whole area, said so in words, beside the
  // unit's own name — because the polygons run far outside whatever is on screen.
  const wilderness = read.rows.find((r) => r.unit === 'Boundary Waters Canoe Area Wilderness');
  assert.equal(wilderness.unitAcres, 1098221);
  const line = unitLine(wilderness);
  assert.ok(line.includes('Boundary Waters Canoe Area Wilderness'));
  assert.match(line, /whole unit/i, 'the acreage must say what it is the area OF');
  assert.match(line, /1,098,221 acres/);
});

// TRAP 4. UK is a fourth answer, never a shade of the first.
test('every category in view is named in the service\'s own words, unknown included', () => {
  const read = readAccess(BW);
  assert.equal(read.rows.length, 6);
  assert.deepEqual(countByAccess(read.rows), { OA: 5, RA: 1, XA: 0, UK: 0 });
  const report = accessReport(BW);
  assert.equal(report.known, true);
  assert.ok(report.text.includes(ACCESS_TEXT.OA), 'the gloss is the service\'s, verbatim');
  assert.ok(report.text.includes(ACCESS_TEXT.RA));
  // A category with nothing in it is not claimed; one with something in it always is.
  const ak = accessReport(ALASKA);
  assert.ok(ak.text.includes(ACCESS_TEXT.UK), 'three of Alaska\'s real units are UK and must be said');
  assert.ok(readAccess(ALASKA).rows.filter((r) => r.code === 'UK').length >= 3);
});

test('a capped page says the answer is partial rather than complete', () => {
  const capped = { ...BW, exceededTransferLimit: true };
  assert.equal(readAccess(capped).capped, true);
  assert.match(accessReport(capped).text, /capped|more than|not the whole/i);
  assert.doesNotMatch(accessReport(BW).text, /capped/i);
});

test('no string this layer shows turns a filed category into permission', () => {
  // "Open" is a management category a land manager filed, at whatever date they filed it.
  // It is not a statement that the gate is unlocked tonight, and none of these words may
  // appear in anything this layer can put in front of a reader.
  const PERMISSION = /\b(you may|allowed to|permitted to|free to|feel free|go ahead|safe to|welcome to)\b/i;
  const ACTIVITY = /\b(camp|campfire|fires|hunt|hunting|drive|driving|overnight|after dark)\b/i;
  const strings = [...readerStrings(BW), ...readerStrings(ALASKA), ...readerStrings(ERROR_200),
    LAYER_LABEL, LAYER_CAVEAT, CREDIT];
  for (const s of strings) {
    assert.doesNotMatch(s, PERMISSION, `this layer states a filed category, never a permission: ${s}`);
  }
  // The caveat is the one place the separate activity rules are named, and it names them
  // to say they are NOT here.
  assert.match(LAYER_CAVEAT, ACTIVITY);
  assert.match(LAYER_CAVEAT, /manager|agency/i);
  for (const s of strings.filter((x) => x !== LAYER_CAVEAT)) {
    assert.doesNotMatch(s, ACTIVITY, `an activity rule is not this layer's to state: ${s}`);
  }
});

test('the layer is a registry entry that draws nothing and prints nothing', () => {
  const l = LAYER_BY_ID[LAYER_ID];
  assert.ok(l, `${LAYER_ID} is not in the registry`);
  assert.ok(GROUP_IDS.includes(l.group));
  assert.equal(l.group, 'reading', 'it answers in words; it is not ink on the map');
  assert.equal(l.screenOnly, true, 'so renderLayerReports leaves its row to this module');
  assert.equal(l.defaultOn, false, 'nothing is fetched before a reader asks');
  assert.equal(l.sourceId, 'padusPublicAccess');
  // Inside the lower 48 an empty answer is real; outside it the inventory is thin and the
  // filler means an empty answer never appears there at all. Ambiguous, and said so.
  assert.equal(l.emptyMeans, 'ambiguous');
  assert.equal(l.coverageCaveat, LAYER_CAVEAT);
});

test('the app reads the switch by its registry id and writes the row it owns', () => {
  const main = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
  assert.match(main, /layers\.padusAccess/, 'the control has to be read by its registry id');
  assert.match(main, /qcm-layer-padusAccess-report/, 'the row it writes into');
  assert.match(main, /const READING_RENDER = \{[^}]*padusAccess/,
    'a reading layer redraws on its own switch; the default handler only replans');
});
