// The finder's result shell: pure grouping/ordering over what the two existing
// search paths (a coordinate pair, a town match) already produce. This carries
// no DOM and no Leaflet -- quiet-corners.js hands it a coordinate hit and/or a
// list of town hits, and gets back groups in a fixed order with globally
// sequential option ids, so the option a keydown handler indexes into and the
// option this module built are always the same row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROUP_ORDER, groupFinderResults, flattenGroups, isExactNameStateMatch, rankFinderGroups } from
  '../../themes/headlessmode/static/js/quiet-corners-maps/search-shell.js';

const coordHit = { label: '34.5000, -83.2000', lat: 34.5, lon: -83.2 };
const town = (name, state, county, lat, lon) => ({ name, state, county, lat, lon });

test('a coordinate hit alone comes back as one "Coordinates" group', () => {
  const groups = groupFinderResults({ coordHit, townHits: [] });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'coordinate');
  assert.equal(groups[0].label, 'Coordinates');
  assert.equal(groups[0].items.length, 1);
  assert.equal(groups[0].items[0].optionId, 'qc-place-opt-0');
  assert.equal(groups[0].items[0].label, coordHit.label);
});

test('town hits alone come back as one "Towns" group, in the order given', () => {
  const hits = [
    town('Ashland town', 'AL', 'Clay County', 33.27, -85.83),
    town('Ashland city', 'IL', 'Sangamon County', 39.7, -89.9),
  ];
  const groups = groupFinderResults({ coordHit: null, townHits: hits });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'town');
  assert.equal(groups[0].label, 'Towns');
  assert.deepEqual(groups[0].items.map((i) => i.name), ['Ashland town', 'Ashland city']);
});

test('option ids are sequential across groups, coordinates first', () => {
  const hits = [town('Sylva', 'NC', 'Jackson County', 35.37, -83.22)];
  const groups = groupFinderResults({ coordHit, townHits: hits });
  // Only two of the three GROUP_ORDER slots are populated here (no name hits);
  // the populated ones must still appear in GROUP_ORDER's relative order.
  assert.deepEqual(groups.map((g) => g.id), GROUP_ORDER.filter((id) => id !== 'name' && id !== 'address'));
  const flat = flattenGroups(groups);
  assert.deepEqual(flat.map((i) => i.optionId), ['qc-place-opt-0', 'qc-place-opt-1']);
});

test('name hits render as a third "Geographic names" group, after coordinates and towns', () => {
  const hits = [town('Sylva', 'NC', 'Jackson County', 35.37, -83.22)];
  const names = [{ id: 'gnis:1', name: 'Cold Mountain', kind: 'summit', state: 'NC', county: 'Haywood' }];
  const groups = groupFinderResults({ coordHit, townHits: hits, nameHits: names });
  assert.deepEqual(groups.map((g) => g.id), GROUP_ORDER.filter((id) => id !== 'address'));
  assert.equal(groups[2].label, 'Geographic names');
  assert.equal(groups[2].items[0].id, 'gnis:1');
});

test('isExactNameStateMatch requires an exact name and a matching state', () => {
  const f = { name: 'Cold Mountain', state: 'NC' };
  assert.equal(isExactNameStateMatch(f, { query: 'Cold Mountain', state: 'NC' }), true);
  assert.equal(isExactNameStateMatch(f, { query: 'cold mountain', state: 'nc' }), true, 'case-insensitive');
  assert.equal(isExactNameStateMatch(f, { query: 'Cold Mtn', state: 'NC' }), false, 'not an exact name');
  assert.equal(isExactNameStateMatch(f, { query: 'Cold Mountain', state: 'SC' }), false, 'wrong state');
  assert.equal(isExactNameStateMatch(f, { query: 'Cold Mountain' }), false, 'no state qualifier at all');
  assert.equal(isExactNameStateMatch(null, { query: 'x', state: 'NC' }), false);
});

test('rankFinderGroups leaves group order alone without an exact match', () => {
  const hits = [town('Sylva', 'NC', 'Jackson County', 35.37, -83.22)];
  const names = [{ id: 'gnis:1', name: 'Sylva', state: 'NC', county: 'Jackson' }];
  const groups = groupFinderResults({ coordHit: null, townHits: hits, nameHits: names });
  const ranked = rankFinderGroups(groups, { exactNameStateMatch: false });
  assert.deepEqual(ranked.map((g) => g.id), ['town', 'name']);
});

test('rankFinderGroups moves "Geographic names" ahead of "Towns" on an exact match, never ahead of coordinates', () => {
  const hits = [town('Sylva', 'NC', 'Jackson County', 35.37, -83.22)];
  const names = [{ id: 'gnis:1', name: 'Sylva', state: 'NC', county: 'Jackson' }];
  const groups = groupFinderResults({ coordHit, townHits: hits, nameHits: names });
  const ranked = rankFinderGroups(groups, { exactNameStateMatch: true });
  assert.deepEqual(ranked.map((g) => g.id), ['coordinate', 'name', 'town']);
});

test('no hits at all comes back as no groups', () => {
  assert.deepEqual(groupFinderResults({ coordHit: null, townHits: [] }), []);
  assert.deepEqual(groupFinderResults(), []);
});

// QUX-05a: pins the merged-box contract this module already supports (no new
// production logic in this file for QUX-05a -- quiet-corners.js's finder is
// the one that starts calling groupFinderResults/rankFinderGroups together
// with a real remote result). A query that is a real town AND has a nearby,
// differently-named GNIS feature -- "Highlands" (NC) vs. "Highlands Gap" --
// so the two groups are genuinely independent hits, not the same place typed
// two ways.
test('a live example query ("Highlands") merges a town match and a GNIS name match, town first by default', () => {
  const hits = [town('Highlands', 'NC', 'Macon County', 35.05, -83.19)];
  const names = [{ id: 'gnis:1017738', name: 'Highlands Gap', kind: 'gap', state: 'NC', county: 'Macon' }];
  const groups = groupFinderResults({ coordHit: null, townHits: hits, nameHits: names });
  assert.deepEqual(groups.map((g) => g.id), ['town', 'name']);
  assert.equal(groups[0].items[0].name, 'Highlands');
  assert.equal(groups[1].items[0].name, 'Highlands Gap');
  assert.equal(groups[1].items[0].kind, 'gap');
  // "Highlands" (the query) never exactly matches "Highlands Gap" (the GNIS
  // name), so this is not the exact-match case -- rankFinderGroups leaves the
  // default town-then-name order alone.
  const exact = isExactNameStateMatch(names[0], { query: 'Highlands', state: 'NC' });
  assert.equal(exact, false);
  const ranked = rankFinderGroups(groups, { exactNameStateMatch: exact });
  assert.deepEqual(ranked.map((g) => g.id), ['town', 'name']);
});

test('flattenGroups preserves within-group order across groups', () => {
  const hits = [
    town('A', 'AL', 'A County', 1, 1),
    town('B', 'AL', 'B County', 2, 2),
  ];
  const groups = groupFinderResults({ coordHit, townHits: hits });
  const flat = flattenGroups(groups);
  assert.deepEqual(flat.map((i) => i.name || i.label), [coordHit.label, 'A', 'B']);
});
