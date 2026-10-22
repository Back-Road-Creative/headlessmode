// The per-state source registry, and the privacy property that makes it safe to render.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES, STATE_CODES, LAYER_IDS, MEASURED_ON, layerFor, isBrowserFetchable, outFieldsFor, browserFetchOrigins, layerReportForState, licenceFor, isRedistributable }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/state-sources.js';

const EXPECTED = ['AK','AL','AR','AZ','CA','CO','CT','DC','DE','FL','GA','HI','IA','ID','IL','IN','KS','KY','LA','MA','MD','ME','MI','MN','MO','MS','MT','NC','ND','NE','NH','NJ','NM','NV','NY','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VA','VT','WA','WI','WV','WY'];
const STATUSES = new Set(['live', 'bake', 'download-only', 'none', 'unverified']);

test('every state and DC is present, with every layer recorded', () => {
  assert.deepEqual(STATE_CODES, EXPECTED, 'a missing state would render as a silent blank, not a caveat');
  assert.equal(STATE_CODES.length, 51);
  for (const code of STATE_CODES) {
    for (const id of LAYER_IDS) {
      const layer = layerFor(code, id);
      assert.ok(layer, `${code}.${id} is absent — record "unverified", never omit`);
      assert.ok(STATUSES.has(layer.status), `${code}.${id} has status "${layer.status}"`);
    }
  }
});

test('a resolved layer carries a real url; an unresolved one carries none', () => {
  for (const code of STATE_CODES) {
    for (const id of LAYER_IDS) {
      const l = layerFor(code, id);
      if (l.status === 'live' || l.status === 'bake') {
        assert.ok(typeof l.url === 'string' && l.url.startsWith('https://'), `${code}.${id} claims ${l.status} with no https url`);
      } else if (l.status === 'none' || l.status === 'unverified') {
        assert.equal(l.url, null, `${code}.${id} is ${l.status} but names a url — that is a guess, not a measurement`);
      }
    }
  }
});

test('a live layer reports the CORS mode that was actually observed', () => {
  for (const code of STATE_CODES) {
    for (const id of LAYER_IDS) {
      const l = layerFor(code, id);
      if (l.status !== 'live') continue;
      assert.ok(['star', 'reflects'].includes(l.cors), `${code}.${id} is live but cors is "${l.cors}"`);
      assert.ok(isBrowserFetchable(l), `${code}.${id} should be fetchable from the page`);
    }
  }
});

// The privacy property. A personal field must never be requested, in any state, on any layer.
test('outFieldsFor never returns a field the state marked personal', () => {
  let checked = 0;
  for (const code of STATE_CODES) {
    for (const id of LAYER_IDS) {
      const l = layerFor(code, id);
      const refused = new Set(l.ownerFields || []);
      if (!refused.size) continue;
      checked++;
      for (const f of outFieldsFor(l)) {
        assert.ok(!refused.has(f), `${code}.${id} would request the personal field ${f}`);
      }
    }
  }
  // If this drops to zero the test has stopped testing anything.
  assert.ok(checked >= 20, `only ${checked} layers carry a refuse-list; expected the measured 30+`);
});

test('the refuse-list is not a parcels-only concern', () => {
  const publicLandPII = [];
  for (const code of STATE_CODES) {
    for (const id of ['managedAreas', 'gameLands', 'stateParks']) {
      if ((layerFor(code, id).ownerFields || []).length) publicLandPII.push(`${code}.${id}`);
    }
  }
  // ND's public-land layer carries LESSEE/PHONE/EMAIL; ME's conservation layers carry
  // easement-holder names. A parcels-only filter would have printed both.
  assert.ok(publicLandPII.length >= 10, `expected public-land layers carrying personal fields, found ${publicLandPII.length}`);
  assert.ok(publicLandPII.includes('ND.managedAreas'), 'ND lessee contact details must be refused');
});

test('every browser-fetchable origin is https and de-duplicated', () => {
  const origins = browserFetchOrigins();
  assert.ok(origins.length > 40, `expected many distinct origins, got ${origins.length}`);
  assert.deepEqual(origins, [...new Set(origins)].sort(), 'origins must be unique and sorted for a stable CSP');
  for (const o of origins) assert.ok(o.startsWith('https://'), `${o} is not https`);
});

test('an unavailable layer explains itself instead of rendering blank', () => {
  const missing = layerReportForState('PA', 'parcels'); // measured: no statewide service
  assert.equal(missing.usable, false);
  assert.match(missing.text, /no statewide source for PA/);

  const present = layerReportForState('NC', 'parcels');
  assert.equal(present.usable, true);
  assert.ok(present.outFields.length, 'a usable layer offers safe fields');
  assert.ok(!present.outFields.includes('ownname'), 'NC owner name must never be requested');
});

test('the file records when it was measured', () => {
  assert.match(MEASURED_ON, /^\d{4}-\d{2}-\d{2}$/);
});

// --- catalogue field names --------------------------------------------------
// outFieldsFor puts every value of `fields` into the query, so a name the service
// does not publish is not cosmetic: ArcGIS refuses the whole request and the layer
// fails every time it is asked, while still being offered on its state page. Four
// live entries were in that state until 2026-09-07 (MA, OR, SC, WV managedAreas).
//
// Only the network can say whether a field EXISTS —
// `node scripts/qcm/probe-state-layer.mjs --audit` is that check. What is testable
// offline is the shape, which is what caught West Virginia: `Acres/Hectares` is two
// fields written as one and can never be a field name.
test('every catalogue field name could actually be a field name', () => {
  const NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;
  const bad = [];
  for (const code of STATE_CODES) {
    for (const id of LAYER_IDS) {
      const layer = layerFor(code, id);
      for (const [key, value] of Object.entries((layer && layer.fields) || {})) {
        if (typeof value !== 'string' || !NAME.test(value)) bad.push(`${code}.${id}.${key} = ${JSON.stringify(value)}`);
      }
    }
  }
  assert.deepEqual(bad, [], 'these cannot be ArcGIS field names, so their queries can only fail');
});

// Massachusetts publishes one statewide OpenSpace layer holding municipal, federal
// and state land; all three of its families are WHERE-clause subsets of it. The
// families must not silently overlap, or the same ground prints under two symbols.
test('a state splitting one service across families gives each family its own clause', () => {
  const clauses = ['gameLands', 'stateParks', 'managedAreas'].map((f) => layerFor('MA', f));
  for (const l of clauses) {
    assert.equal(l.status, 'live');
    assert.match(l.where, /MANAGR_TYPE='S'/, 'every MA family is limited to state-managed land');
  }
  assert.equal(new Set(clauses.map((l) => l.where)).size, 3, 'three families, three different clauses');
  // The catch-all excludes the two named families rather than repeating them.
  assert.match(layerFor('MA', 'managedAreas').where, /NOT LIKE 'DCR%'/);
  assert.match(layerFor('MA', 'managedAreas').where, /NOT LIKE '%DFG%'/);
});

// --- licence --------------------------------------------------------------
// Three entries record a licensing or confidentiality warning in free text, and
// two of them say outright that the data may not be redistributed. Nothing read
// those words: Idaho's parcels were unreachable only because their status is
// `bake`, which is luck rather than a rule.

test("a publisher's refusal blocks the layer at every seam, whatever its status says", () => {
  const forbidden = { status: 'live', cors: 'star', url: 'https://example.gov/a/MapServer/0', licence: { redistribute: 'no', note: 'no' } };
  assert.equal(isRedistributable(forbidden), false);
  assert.equal(isBrowserFetchable(forbidden), false, 'live + CORS-open is not enough');

  // The same object without the licence is fetchable, so it is the licence doing the work.
  const { licence, ...allowed } = forbidden;
  assert.equal(isBrowserFetchable(allowed), true);
});

test('silence is not refusal — an unlicensed entry is unknown and still usable', () => {
  assert.deepEqual(licenceFor({}), { redistribute: 'unknown', note: null });
  assert.deepEqual(licenceFor(null), { redistribute: 'unknown', note: null });
  assert.equal(isRedistributable({ status: 'live', cors: 'star' }), true);
  // 204 measured entries publish nothing about licensing; treating that as a
  // refusal would empty the catalogue.
  const usable = STATE_CODES.flatMap((c) => LAYER_IDS.map((id) => layerFor(c, id))).filter(isBrowserFetchable);
  assert.ok(usable.length > 100, `only ${usable.length} usable entries — silence is being read as refusal`);
});

test('the two recorded refusals are actually recorded, and reach no origin list', () => {
  assert.equal(licenceFor(layerFor('ID', 'parcels')).redistribute, 'no');
  assert.equal(licenceFor(layerFor('IL', 'managedAreas')).redistribute, 'no');
  for (const [state, family] of [['ID', 'parcels'], ['IL', 'managedAreas']]) {
    assert.equal(isBrowserFetchable(layerFor(state, family)), false, `${state} ${family} is fetchable`);
  }
  const origins = browserFetchOrigins();
  assert.ok(!origins.some((o) => o.includes('gis.idwr.idaho.gov')), 'a forbidden origin reached the CSP allowlist');

  const report = layerReportForState('ID', 'parcels');
  assert.equal(report.usable, false);
  assert.match(report.text, /does not permit redistribution/, 'and the reason is said out loud, not hidden as "unavailable"');
});

// The rule that keeps this from rotting: a note that talks about licensing or
// confidentiality is a legal question, and a legal question must be answered in
// a field, not left as prose nobody parses.
test('a licensing or confidentiality note must carry an explicit verdict', () => {
  const flagged = /licen[cs]|confidential|exempt|cannot be shared/i;
  const missing = [];
  for (const code of STATE_CODES) {
    for (const id of LAYER_IDS) {
      const layer = layerFor(code, id);
      if (!layer || !layer.note || !flagged.test(layer.note)) continue;
      if (!layer.licence || !['yes', 'no', 'unknown'].includes(layer.licence.redistribute)) missing.push(`${code}.${id}`);
    }
  }
  assert.deepEqual(missing, [], 'these entries warn about licensing and record no verdict');
});

// --- parcels: names in the VALUES, not in the field name ----------------------
// The refuse-list is built from field NAMES, and a name is not evidence. North
// Dakota's `Ownership` is declared with a coded-value domain of nine categories
// (Private, Municipal, State, County, Railroad, ...) and its catalogue note read
// "CLEAN: no owner fields, appears deliberately stripped" — while Walsh County had
// populated the same field with individual landowners, truncated to its 15-char
// limit. A coded-value domain is a schema promise, not a data guarantee.
//
// Only the network can read values, so `scripts/qcm/audit-parcel-values.mjs` is
// that check and `valuesAuditedOn` is its receipt. What is testable offline is
// that no parcels layer is OFFERED without one — so a state added later cannot
// reach the map on a field list nobody looked at.
test('every parcels layer this map would fetch has had its VALUES audited', () => {
  const unaudited = [];
  for (const code of STATE_CODES) {
    const l = layerFor(code, 'parcels');
    if (!isBrowserFetchable(l)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(l.valuesAuditedOn || '')) unaudited.push(code);
  }
  assert.deepEqual(unaudited, [],
    'run `node scripts/qcm/audit-parcel-values.mjs` and record valuesAuditedOn');
});

test("North Dakota's Ownership stays refused, whatever its declared domain says", () => {
  const nd = layerFor('ND', 'parcels');
  assert.ok((nd.ownerFields || []).includes('Ownership'), 'ND would request individual landowners');
  assert.ok(!outFieldsFor(nd).includes('Ownership'));
  assert.match(nd.note, /Walsh County/, 'the reason is the evidence, not a field-name guess');
});

// The property that makes parcels printable at all: boundaries and acreage, never
// a person. Asserted across every state rather than for the one that was caught.
test('no parcels layer requests a field its own catalogue entry calls personal', () => {
  let checked = 0;
  for (const code of STATE_CODES) {
    const l = layerFor(code, 'parcels');
    if (!isBrowserFetchable(l)) continue;
    const refused = new Set(l.ownerFields || []);
    if (refused.size) checked++;
    for (const f of outFieldsFor(l)) assert.ok(!refused.has(f), `${code}.parcels would request ${f}`);
  }
  assert.ok(checked >= 20, `only ${checked} fetchable parcels layers carry a refuse-list`);
});
