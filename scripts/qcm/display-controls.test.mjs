// D1: the pure emphasis-state reducer. nextDisplay never touches the DOM, Leaflet or the
// registry -- it takes a state object and an action and returns the next state object, so
// main.js can drive the Highlight shortcuts and the Advanced controls through one function
// node --test can cover completely.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextDisplay, DEFAULT_EMPHASIS, HIGHLIGHT_LINES, summaryLine, swatchStyle } from '../../themes/headlessmode/static/js/quiet-corners-maps/display-controls.js';
import { DEFAULT_DISPLAY } from '../../themes/headlessmode/static/js/quiet-corners-maps/preview-overlay.js';
import { recipeFromControls } from '../../themes/headlessmode/static/js/quiet-corners-maps/app-state.js';

test('DEFAULT_EMPHASIS carries every DEFAULT_DISPLAY field plus a null prior, and is frozen', () => {
  assert.throws(() => { DEFAULT_EMPHASIS.lines = 2; }, TypeError);
  for (const k of Object.keys(DEFAULT_DISPLAY)) assert.equal(DEFAULT_EMPHASIS[k], DEFAULT_DISPLAY[k]);
  assert.equal(DEFAULT_EMPHASIS.prior, null);
});

test('highlight sets the spotlight and thickens lines, and clear restores the exact prior state', () => {
  const highlighted = nextDisplay(DEFAULT_EMPHASIS, { type: 'highlight', layerId: 'trails' });
  assert.equal(highlighted.spotlight, 'trails');
  assert.equal(highlighted.lines, HIGHLIGHT_LINES);
  const cleared = nextDisplay(highlighted, { type: 'clear' });
  assert.deepEqual(cleared, DEFAULT_EMPHASIS, 'clear must return exactly to the state before the highlight, not a close approximation');
});

test('clear before any highlight is a no-op on spotlight/lines', () => {
  const cleared = nextDisplay(DEFAULT_EMPHASIS, { type: 'clear' });
  assert.equal(cleared.spotlight, null);
  assert.equal(cleared.lines, DEFAULT_EMPHASIS.lines);
});

test('switching the highlight target directly (highlight trails, then highlight boundaries, then clear) does not compound: clear restores the pre-highlight state, not the mid-highlight one', () => {
  const custom = { ...DEFAULT_EMPHASIS, fill: 0.6 };
  const trails = nextDisplay(custom, { type: 'highlight', layerId: 'trails' });
  const boundaries = nextDisplay(trails, { type: 'highlight', layerId: 'federalLand' });
  assert.equal(boundaries.spotlight, 'federalLand');
  assert.equal(boundaries.lines, HIGHLIGHT_LINES, 'still exactly one highlight thickness, not stacked');
  const cleared = nextDisplay(boundaries, { type: 'clear' });
  assert.deepEqual(cleared, custom, 'clear must undo both highlights at once, back to the state before the first one');
});

test('an Advanced control change while highlighted drops the stale prior (a manual edit wins over restoring an old snapshot)', () => {
  const highlighted = nextDisplay(DEFAULT_EMPHASIS, { type: 'highlight', layerId: 'trails' });
  const edited = nextDisplay(highlighted, { type: 'setFill', value: 0.5 });
  assert.equal(edited.prior, null);
  assert.equal(edited.fill, 0.5);
  assert.equal(edited.spotlight, 'trails', 'the spotlight itself is untouched by a fill edit');
});

test('setLines, setFill, setDim, setContrast, setSpotlight each set exactly their own field', () => {
  assert.equal(nextDisplay(DEFAULT_EMPHASIS, { type: 'setLines', value: 1.5 }).lines, 1.5);
  assert.equal(nextDisplay(DEFAULT_EMPHASIS, { type: 'setFill', value: 0.3 }).fill, 0.3);
  assert.equal(nextDisplay(DEFAULT_EMPHASIS, { type: 'setDim', value: 0.4 }).dim, 0.4);
  assert.equal(nextDisplay(DEFAULT_EMPHASIS, { type: 'setContrast', value: 'high' }).contrast, 'high');
  assert.equal(nextDisplay(DEFAULT_EMPHASIS, { type: 'setSpotlight', layerId: 'federalLand' }).spotlight, 'federalLand');
});

test('an unknown action type throws rather than silently returning the same state', () => {
  assert.throws(() => nextDisplay(DEFAULT_EMPHASIS, { type: 'bogus' }), TypeError);
});

test('summaryLine names only the fields that differ from the default, and says so plainly at default', () => {
  assert.equal(summaryLine(DEFAULT_EMPHASIS), 'No changes from the default display.');
  const changed = nextDisplay(DEFAULT_EMPHASIS, { type: 'setDim', value: 0.5 });
  assert.match(summaryLine(changed), /dim/i);
  const spotlit = nextDisplay(DEFAULT_EMPHASIS, { type: 'setSpotlight', layerId: 'trails' });
  assert.match(summaryLine(spotlit), /trails/);
});

test('swatchStyle derives from displayStyle: the spotlighted key differs from a dimmed one', () => {
  const state = { ...DEFAULT_EMPHASIS, spotlight: 'trails' };
  const lit = swatchStyle('trail-nst', state, { layerId: 'trails' });
  const dimmed = swatchStyle('fed-park', state, { layerId: 'federalLand' });
  assert.equal(lit.opacity, 1);
  assert.equal(dimmed.opacity, 0.25);
});

// Item 6: screen emphasis must never reach the printed recipe or the sheet's credits.
// recipeFromControls's own `rejectUnknown` gate is the enforcement -- this proves it holds
// for the emphasis shape specifically, not just in the abstract.
test('recipeFromControls output is identical whatever the emphasis state, and a "display" control key is rejected outright', () => {
  const bbox = { minLon: -83.55, minLat: 35.0, maxLon: -83.4, maxLat: 35.1 };
  const before = recipeFromControls({}, bbox, 'Test area');
  // Every emphasis action this unit defines, applied in sequence -- none of it is a
  // `controls` field, so recipeFromControls never sees it and the recipe cannot move.
  let emphasis = DEFAULT_EMPHASIS;
  for (const action of [
    { type: 'highlight', layerId: 'trails' },
    { type: 'setFill', value: 0.4 },
    { type: 'setDim', value: 0.6 },
    { type: 'setContrast', value: 'high' },
    { type: 'clear' },
  ]) emphasis = nextDisplay(emphasis, action);
  assert.notDeepEqual(emphasis, DEFAULT_EMPHASIS, 'sanity: the emphasis state actually changed');
  const after = recipeFromControls({}, bbox, 'Test area');
  assert.deepEqual(after, before, 'recipeFromControls must not be sensitive to any emphasis state at all');
  assert.throws(() => recipeFromControls({ display: emphasis }, bbox, 'Test area'), TypeError,
    'a display/emphasis key must never be accepted as a print control');
});
