// The state-coverage table, and the gate that stops it drifting from the catalogue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { coverage, CODES } from './gen-coverage.mjs';
import { STATE_CODES, layerFor, isDrawable } from '../../themes/headlessmode/static/js/quiet-corners-maps/state-sources.js';
import { statesWithLayers, DEFAULT_FAMILIES } from '../../themes/headlessmode/static/js/quiet-corners-maps/state-pages.js';

const COMMITTED = JSON.parse(readFileSync(new URL('../../data/quiet-corners-maps/coverage.json', import.meta.url), 'utf8'));
const PARTIAL = readFileSync(new URL('../../themes/headlessmode/layouts/partials/qcm-coverage.html', import.meta.url), 'utf8');

// The drift gate. Same idea as static/_headers: JS computes, the file is the
// artifact, and a catalogue edit that skips the regeneration fails here rather
// than shipping a page that quietly disagrees with what the map will fetch.
test('the committed file is what the generator produces today', () => {
  assert.deepEqual(COMMITTED, coverage(),
    'run `node scripts/qcm/gen-coverage.mjs --write` — the catalogue moved and this file did not');
});

test('every state appears exactly once, one character per default family', () => {
  assert.deepEqual(Object.keys(COMMITTED.states).sort(), [...STATE_CODES].sort());
  assert.deepEqual(COMMITTED.families.map((f) => f.id), [...DEFAULT_FAMILIES]);
  for (const [code, row] of Object.entries(COMMITTED.states)) {
    assert.equal(row.length, DEFAULT_FAMILIES.length, `${code} judges the wrong number of families`);
    for (const c of row) assert.ok(c in CODES, `${code} carries unknown code ${c}`);
  }
});

// The table and the fetch must answer the same question, or the page promises
// what the map will not draw. This is what caught Nebraska: offered on
// isBrowserFetchable alone, refused by the fetch as a different kind of area.
test('the table agrees with the function the builder offers layers from', () => {
  const listed = Object.entries(COMMITTED.states).filter(([, r]) => r.includes('y')).map(([c]) => c).sort();
  assert.deepEqual(listed, [...statesWithLayers()].sort(),
    'a state the page claims coverage for must be one the builder offers layers for');
  assert.ok(listed.length > 40, `only ${listed.length} states covered`);
  // Per CELL, not just per state: a family offered and never drawable is a
  // checkbox that produces nothing.
  for (const [code, row] of Object.entries(COMMITTED.states)) {
    DEFAULT_FAMILIES.forEach((id, i) => {
      assert.equal(row[i] === 'y', isDrawable(layerFor(code, id)), `${code}.${id} disagrees with isDrawable`);
    });
  }
});

// An absent family says WHY. "No source" and "the publisher forbids it" are
// different facts about a state, and a blank cell would tell a reader neither.
test('an unusable family carries a reason, and the licence refusal is visible', () => {
  const seen = new Set(Object.values(COMMITTED.states).flatMap((r) => [...r]));
  assert.ok(seen.has('l'), 'the licence refusal must be visible to a reader, not only to the fetch');
  for (const [code, row] of Object.entries(COMMITTED.states)) {
    DEFAULT_FAMILIES.forEach((id, i) => {
      if (row[i] !== 'l') return;
      assert.equal((layerFor(code, id).licence || {}).redistribute, 'no',
        `${code}.${id} is shown as licence-refused but the catalogue does not say so`);
    });
  }
});

test('the template renders the generated file and decides nothing itself', () => {
  assert.match(PARTIAL, /index site\.Data "quiet-corners-maps"/, 'the partial must read the generated data');
  assert.ok(!/isBrowserFetchable|redistribute|cors/.test(PARTIAL),
    'the template must not re-derive usability — that is a second implementation');
  // Colour is never the only signal: every cell carries its own word.
  for (const word of ['licence', 'no source', 'unmeasured', 'not usable']) {
    assert.ok(PARTIAL.includes(word), `the table never says "${word}"`);
  }
});
