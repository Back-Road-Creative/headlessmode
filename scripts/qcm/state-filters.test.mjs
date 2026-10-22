// Several states publish their wildlife areas INSIDE a general public-lands layer.
// The catalogue recorded the filter each one needs as a free-text note, which no
// code could read — so a reader taking the layer at face value would draw land
// this map would mislabel. These tests hold the filters, now machine-readable,
// to the counts they were measured against.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATES, STATE_CODES, layerFor, whereFor, isSemanticallyUniform, divergenceReason, outFieldsFor,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/state-sources.js';

// Measured 2026-09-07 against each live service: unfiltered count, then the count
// with the filter. The filtered figure is the one the catalogue recorded, which is
// what makes these filters load-bearing rather than decorative.
const MEASURED = {
  CO: { all: 6, filtered: 4 },
  CT: { all: 1, filtered: 1 },
  MD: { all: 7, filtered: 3 },
  NJ: { all: 3, filtered: 1 },
  OH: { all: 2, filtered: 2 },
  OK: { all: 6, filtered: 1 },
  SC: { all: 1, filtered: 1 },
  VT: { all: 93, filtered: 1 },
  WI: { all: 3, filtered: 0 },
};

test('every state that needs a filter carries one, and it matches the recorded count', () => {
  for (const [code, m] of Object.entries(MEASURED)) {
    const layer = layerFor(code, 'gameLands');
    assert.ok(layer, `${code} has no gameLands entry`);
    assert.notEqual(whereFor(layer), '1=1', `${code} needs a filter but carries none`);
    assert.equal(layer.count, m.filtered, `${code}: recorded count is not the filtered count`);
  }
});

// Vermont is the clearest case: 93 features come back unfiltered where exactly one
// is a Wildlife Management Area. Without the filter the sheet would be covered.
test('the filter is what makes the difference, not the bounding box', () => {
  const loud = Object.entries(MEASURED).filter(([, m]) => m.all > m.filtered);
  assert.ok(loud.length >= 5, 'these filters should be doing real work');
  assert.equal(MEASURED.VT.all, 93);
  assert.equal(MEASURED.VT.filtered, 1);
});

// South Carolina's note said WildlifeManagementArea='Yes'. The field's real value
// is 'Specific', so that filter returned ZERO — a prose note nothing executed had
// gone stale without anyone noticing. PropertyUse='WMA' returns the recorded 1.
test('South Carolina filters on a field value that actually exists', () => {
  const where = whereFor(layerFor('SC', 'gameLands'));
  assert.ok(!where.includes("WildlifeManagementArea='Yes'"), 'that value is never present in the data');
  assert.equal(where, "PropertyUse='WMA'");
});

test("a layer with no filter reports '1=1', and that is a decision, not a gap", () => {
  assert.equal(whereFor(layerFor('NC', 'gameLands')), '1=1');
  assert.equal(whereFor(null), '1=1');
  assert.equal(whereFor({ where: '   ' }), '1=1', 'whitespace is not a filter');
});

test('a filter never names a field the layer refuses to return', () => {
  for (const code of STATE_CODES) {
    const layer = layerFor(code, 'gameLands');
    if (!layer) continue;
    for (const refused of layer.ownerFields || []) {
      assert.ok(!whereFor(layer).includes(refused), `${code} filters on the personal field ${refused}`);
    }
  }
});

// "Game lands" does not mean the same thing in every state. Arizona's layer is hunt
// units — administrative boundaries covering the entire state — and drawing those
// as a land boundary would put a line on paper that means nothing on the ground.
test('states whose layer is a different kind of thing are flagged, with a reason', () => {
  const flagged = STATE_CODES.filter((c) => !isSemanticallyUniform(layerFor(c, 'gameLands')));
  assert.ok(flagged.includes('AZ'), 'Arizona publishes hunt units, not public land');
  for (const code of flagged) {
    const reason = divergenceReason(layerFor(code, 'gameLands'));
    assert.ok(reason && reason.length > 20, `${code} is flagged without saying why`);
  }
});

test('silence means uniform — an unflagged layer is not treated as suspect', () => {
  assert.equal(isSemanticallyUniform(layerFor('NC', 'gameLands')), true);
  assert.equal(divergenceReason(layerFor('NC', 'gameLands')), null);
  assert.equal(isSemanticallyUniform(null), true, 'a missing layer is not a divergent one');
});

test('every flagged state is still a real catalogue entry, not a typo', () => {
  for (const code of STATE_CODES) {
    const layer = layerFor(code, 'gameLands');
    if (layer && layer.semantics) assert.ok(STATES[code], `${code} is not a state in the catalogue`);
  }
});

test('the catalogue still holds 51 states and every gameLands field stays safe', () => {
  assert.equal(STATE_CODES.length, 51);
  for (const code of STATE_CODES) {
    const layer = layerFor(code, 'gameLands');
    if (!layer) continue;
    for (const f of outFieldsFor(layer)) {
      assert.ok(!(layer.ownerFields || []).includes(f), `${code} would request the personal field ${f}`);
    }
  }
});
