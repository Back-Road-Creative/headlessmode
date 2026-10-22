// The county filters, tested against the SHIPPED source rather than a copy.
//
// `filterCounties` lives inside quiet-corners.js's IIFE, so nothing could import
// it and nothing tested it. It is a plain function declaration, so this extracts
// its real text and evaluates it — a rename, a reordered clause or a changed
// comparison is caught, and there is no second implementation to drift.
//
// The rule the file already writes down, above filterCounties: "Null scores are
// 'unknown': an ACTIVE threshold filter only admits rows known to satisfy it, so
// null is excluded. A slider at its no-op end (min 0 / max 100) is inactive and
// lets unknowns through." Every filter obeyed it except remoteness, which had no
// no-op end at all (the slider bottomed out at 25 miles) and excluded an unknown
// distance unconditionally. Audit F16: "A quiet location close to a city must
// remain discoverable."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../../themes/headlessmode/layouts/_default/quiet-corners-dashboard.html', import.meta.url), 'utf8');

/** The real function text, by brace matching from its declaration. */
function extract(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.notEqual(at, -1, `${name} is gone from quiet-corners.js`);
  let depth = 0, i = SRC.indexOf('{', at);
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) return SRC.slice(at, j + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}
const filterCounties = new Function('sprawlReady', `${extract('filterCounties')}; return filterCounties;`)(false);

const county = (over = {}) => ({
  state: 'NC', distance_to_metro_mi: 90, stability_score: 80, overall_score: 70,
  affordability_score: 60, sprawl_risk: 10, population: 2000, ...over,
});
const OFF = { minRemoteness: 0, minStability: 0, minOverall: 0, minAffordability: 0, state: '' };
const ids = (rows) => rows.map((c) => c.id);

test('the remoteness slider has an off position, and off means off', () => {
  const near = county({ id: 'near', distance_to_metro_mi: 10 });
  const unknown = county({ id: 'unknown', distance_to_metro_mi: null });
  const far = county({ id: 'far', distance_to_metro_mi: 120 });
  const all = [near, unknown, far];

  // The whole finding: a genuinely quiet county ten miles from a city, and one
  // whose distance was never computed, must both be reachable.
  assert.deepEqual(ids(filterCounties(all, { ...OFF })), ['near', 'unknown', 'far'],
    'an inactive remoteness filter admits every county, unknown distance included');

  // Active, it still means what it says — including excluding the unknown, which
  // is the same rule every other threshold follows.
  // No test can separate the explicit `=== null` clause from its absence here:
  // `null < 75` coerces to `0 < 75`, so the comparison alone already excludes an
  // unknown at any positive threshold. The clause is kept because it says the
  // intent out loud and matches every sibling filter — not because it is
  // load-bearing. What IS load-bearing is the `> 0` guard in front of it, which
  // the first assertion above covers.
  assert.deepEqual(ids(filterCounties(all, { ...OFF, minRemoteness: 75 })), ['far'],
    'an active threshold admits only counties known to satisfy it');
  assert.deepEqual(ids(filterCounties(all, { ...OFF, minRemoteness: 10 })), ['near', 'far'],
    'and the boundary is inclusive');
});

test('the slider can reach its off position and says so', () => {
  const slider = HTML.match(/<input[^>]*id="qc-remoteness"[^>]*>/);
  assert.ok(slider, 'the remoteness slider is gone');
  assert.match(slider[0], /min="0"/, 'a slider that bottoms out at 25 miles cannot be switched off');
  assert.match(SRC, /minRemoteness === 0 \? 'Any'/, 'and 0 reads as Any, not as "0+"');
  // F16 asked for a precise label. "Remoteness" alone reads as a score like the
  // ones beside it; it is a raw distance in miles, and the slider's numbers are
  // miles. The dimension keeps its name — it is called Remoteness in the scoring
  // weights, the table and the methodology — so the label names the unit instead
  // of renaming the thing.
  assert.match(HTML, /Remoteness: miles to a city/, 'the control names its unit');
  assert.match(HTML, /Great-circle distance from county centroid/, 'and keeps its source note');
});

test('every other threshold still behaves, so this did not move the rule', () => {
  const unknowns = county({ id: 'u', stability_score: null, overall_score: null, affordability_score: null });
  assert.deepEqual(ids(filterCounties([unknowns], { ...OFF })), ['u'], 'all sliders off admits unknowns');
  for (const k of ['minStability', 'minOverall', 'minAffordability']) {
    assert.deepEqual(ids(filterCounties([unknowns], { ...OFF, [k]: 1 })), [], `${k} active excludes an unknown`);
  }
  assert.deepEqual(ids(filterCounties([county({ id: 'x' })], { ...OFF, state: 'VT' })), [], 'state still filters');
});
