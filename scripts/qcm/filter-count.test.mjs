// The active-filter count shown on the Explore panel's summary (QUX-03b-i), tested
// against the SHIPPED source rather than a copy — same extract-and-eval technique
// county-filters.test.mjs already established for a function trapped inside
// quiet-corners.js's IIFE.
//
// `countActiveFilters` has to read "active" exactly the way filterCounties (right
// above it in quiet-corners.js) reads it, or the number on the panel would say
// something the table itself does not agree with. Each assertion below mirrors one
// of filterCounties' own conditions: minRemoteness/minStability/minOverall/
// minAffordability are active above 0, maxSprawl is active only when it is both set
// AND below its 100 no-op ceiling, popMin/popMax are active when present at all
// (there is no numeric no-op end for a free-typed bound), and state is active
// whenever it names one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners.js', import.meta.url), 'utf8');

/** The real function text, by brace matching from its declaration — same helper
 *  county-filters.test.mjs already uses, duplicated rather than imported because
 *  quiet-corners.js's functions are not ESM exports and there is nothing shared to
 *  import it from. */
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
const countActiveFilters = new Function(`${extract('countActiveFilters')}; return countActiveFilters;`)();

const OFF = { minRemoteness: 0, minStability: 0, minOverall: 0, minAffordability: 0, state: '' };

test('every filter at its no-op end counts zero', () => {
  assert.equal(countActiveFilters({ ...OFF }), 0);
});

test('each threshold slider counts one once it is above its no-op end', () => {
  assert.equal(countActiveFilters({ ...OFF, minRemoteness: 75 }), 1, 'remoteness');
  assert.equal(countActiveFilters({ ...OFF, minStability: 60 }), 1, 'stability');
  assert.equal(countActiveFilters({ ...OFF, minOverall: 40 }), 1, 'overall');
  assert.equal(countActiveFilters({ ...OFF, minAffordability: 20 }), 1, 'affordability');
});

test('state counts one whenever it names one', () => {
  assert.equal(countActiveFilters({ ...OFF, state: 'NC' }), 1);
});

test('sprawl counts only when it is set below its 100 no-op ceiling, mirroring filterCounties', () => {
  assert.equal(countActiveFilters({ ...OFF, maxSprawl: 50 }), 1, 'below the ceiling is active');
  assert.equal(countActiveFilters({ ...OFF, maxSprawl: 100 }), 0, '100 is the slider\'s off position');
  assert.equal(countActiveFilters({ ...OFF }), 0, 'absent (sprawl not ready) is not active either');
});

test('population bounds count when present, with no numeric no-op end', () => {
  assert.equal(countActiveFilters({ ...OFF, popMin: 500 }), 1, 'popMin');
  assert.equal(countActiveFilters({ ...OFF, popMax: 5000 }), 1, 'popMax');
  assert.equal(countActiveFilters({ ...OFF, popMin: 500, popMax: 5000 }), 2, 'both together');
});

test('several active filters at once add up', () => {
  assert.equal(
    countActiveFilters({ minRemoteness: 75, minStability: 60, minOverall: 0, minAffordability: 0, state: 'NC' }),
    3,
  );
});
