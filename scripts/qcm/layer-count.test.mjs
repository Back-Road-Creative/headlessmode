// A06 (UX-03a): the Layers panel's shared count line counts EVERY optional selected
// screen layer, not only the federal and state rows main.js could badge. Before this,
// checking Road cameras left the line reading "No layers on" beside a checked box.
//
// Pure half: layer-panel.js's selectedScreenRows says which of the registry's non-fetched
// rows are selected; layerCountLine only counts what it is handed. The browser half is
// layer-count-browser.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layerCountLine, selectedScreenRows, COUNTED_SCREEN_GROUPS } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-panel.js';
import { LAYERS, GROUPS } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';

const line = (layers) => layerCountLine(selectedScreenRows(LAYERS, layers));

test('a checked camera layer is counted, never "No layers on"', () => {
  assert.equal(line({ roadCameras: true }), '1 layer on');
  assert.equal(line({ parkCameras: true }), '1 layer on');
  assert.equal(line({ roadCameras: true, parkCameras: true }), '2 layers on');
});

test('context, reading and extras layers count the same way', () => {
  assert.equal(line({ aerial: true }), '1 layer on');
  assert.equal(line({ padusAccess: true }), '1 layer on');
  const context = LAYERS.find((l) => l.group === 'context');
  assert.equal(line({ [context.id]: true }), '1 layer on');
});

test('nothing selected still reads "No layers on"; the required print base is never counted', () => {
  assert.equal(line({}), 'No layers on');
  assert.equal(line({ usgsTopo: true }), 'No layers on');
});

test('federal and state rows are not counted here: main.js badges them, so counting them twice would read 2 for 1', () => {
  const federal = LAYERS.find((l) => l.group === 'federal');
  const state = LAYERS.find((l) => l.group === 'state');
  assert.deepEqual(selectedScreenRows(LAYERS, { [federal.id]: true, [state.id]: true }), []);
  assert.equal(line({ [federal.id]: true, [state.id]: true, roadCameras: true }), '1 layer on');
});

test('selected is not loaded: a row carries no fetch badge, so a failed or empty one still counts', () => {
  const rows = selectedScreenRows(LAYERS, { roadCameras: true });
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].badge, 'off');
  assert.notEqual(rows[0].badge, 'loading', 'a camera layer is not in the loading tally: its fetch is reported on its own row');
});

test('no required row sits in a counted group, so the count needs no `required` filter', () => {
  const stray = LAYERS.filter((l) => COUNTED_SCREEN_GROUPS.includes(l.group) && l.required).map((l) => l.id);
  assert.deepEqual(stray, [], 'a required row in a counted group would always read as "on"');
});

test('every registry group is either counted here, badged by main.js, or the basemap choice', () => {
  const badgedByMain = new Set(['federal', 'state']);
  for (const g of GROUPS) {
    if (g.id === 'base') continue;
    assert.ok(badgedByMain.has(g.id) || COUNTED_SCREEN_GROUPS.includes(g.id),
      `group "${g.id}" is in no count: its checked rows would read "No layers on"`);
  }
});
