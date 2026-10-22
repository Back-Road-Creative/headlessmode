// D0: the pure display-state contract. displayStyle answers "how does this
// symbol look right now" from the immutable canonical symbol table plus a
// small state object -- never from a Leaflet shape's own (already-mutated)
// style -- so repeated hover/unhover or spotlight/clear cannot compound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayStyle, casingStyle, previewStyle, DEFAULT_DISPLAY } from '../../themes/headlessmode/static/js/quiet-corners-maps/preview-overlay.js';
import { SYMBOLS, SYMBOL_BY_KEY } from '../../themes/headlessmode/static/js/quiet-corners-maps/legend.js';

const ROAD = 'mvum-road-yearlong';
const AREA = 'fed-park'; // a filled/closed symbol

test('displayStyle at the default state matches previewStyle plus opacity 1', () => {
  const base = previewStyle(ROAD);
  const d = displayStyle(ROAD);
  assert.equal(d.weight, base.weight);
  assert.equal(d.color, base.color);
  assert.equal(d.dashArray, base.dashArray);
  assert.equal(d.opacity, 1);
});

test('no compounding: hover, unhover, hover again are all byte-identical', () => {
  const hover1 = displayStyle(ROAD, DEFAULT_DISPLAY, { hover: true });
  const unhover = displayStyle(ROAD, DEFAULT_DISPLAY, { hover: false });
  const hover2 = displayStyle(ROAD, DEFAULT_DISPLAY, { hover: true });
  assert.deepEqual(hover1, hover2, 'hovering twice must not thicken the line twice');
  assert.deepEqual(unhover, displayStyle(ROAD, DEFAULT_DISPLAY), 'unhover returns to the plain base');
  assert.notDeepEqual(hover1, unhover, 'hover is visibly different from unhovered');
});

test('hover adds exactly +2 weight on top of the computed base', () => {
  const base = displayStyle(ROAD, DEFAULT_DISPLAY);
  const hovered = displayStyle(ROAD, DEFAULT_DISPLAY, { hover: true });
  assert.equal(+(hovered.weight - base.weight).toFixed(3), 2);
});

test('spotlight, then cleared, returns exactly to the base style', () => {
  const base = displayStyle(ROAD, DEFAULT_DISPLAY, { layerId: 'a' });
  const spotlit = displayStyle(ROAD, { ...DEFAULT_DISPLAY, spotlight: 'b' }, { layerId: 'a' });
  const cleared = displayStyle(ROAD, DEFAULT_DISPLAY, { layerId: 'a' });
  assert.notDeepEqual(spotlit, base, 'spotlighting another layer dims this one');
  assert.deepEqual(cleared, base, 'clearing the spotlight must not leave a residual dim');
});

test('spotlight dims every other layer but leaves the spotlighted one unchanged', () => {
  const state = { ...DEFAULT_DISPLAY, spotlight: 'target' };
  const spotlighted = displayStyle(AREA, state, { layerId: 'target' });
  const other = displayStyle(AREA, state, { layerId: 'someone-else' });
  const plain = displayStyle(AREA, DEFAULT_DISPLAY, { layerId: 'target' });
  assert.deepEqual(spotlighted, plain, 'the spotlighted layer is drawn exactly as if nothing were spotlit');
  assert.equal(other.opacity, 0.25, 'a non-spotlit stroke is dimmed to 25%');
  assert.equal(other.fillOpacity, +(plain.fillOpacity * 0.25).toFixed(4), 'its fill dims the same fraction');
});

test('lines multiplier scales weight and never drops below MIN_WEIGHT (1.2)', () => {
  const base = displayStyle(ROAD, DEFAULT_DISPLAY);
  for (const lines of [1, 1.5, 2]) {
    const d = displayStyle(ROAD, { ...DEFAULT_DISPLAY, lines });
    assert.equal(d.weight, +(base.weight * lines).toFixed(3));
    assert.ok(d.weight >= 1.2, `weight ${d.weight} fell under the documented MIN_WEIGHT floor`);
  }
});

test('fill multiplier scales fillOpacity on an area symbol only', () => {
  const base = displayStyle(AREA, DEFAULT_DISPLAY);
  const dimmer = displayStyle(AREA, { ...DEFAULT_DISPLAY, fill: 0.5 });
  assert.equal(dimmer.fillOpacity, +(base.fillOpacity * 0.5).toFixed(4));
  const road = displayStyle(ROAD, { ...DEFAULT_DISPLAY, fill: 0.5 });
  assert.equal(road.fillOpacity, undefined, 'a line symbol has no fill to scale');
});

test('dash pattern survives every branch: hover, spotlight, contrast, selected', () => {
  const key = 'mvum-road-seasonal'; // dashed on paper
  const dash = previewStyle(key).dashArray;
  assert.ok(dash, 'fixture must actually carry a dash');
  assert.equal(displayStyle(key, DEFAULT_DISPLAY, { hover: true }).dashArray, dash);
  assert.equal(displayStyle(key, { ...DEFAULT_DISPLAY, spotlight: 'x' }, { layerId: 'y' }).dashArray, dash);
  assert.equal(displayStyle(key, { ...DEFAULT_DISPLAY, contrast: 'high' }).dashArray, dash);
  assert.equal(displayStyle(key, DEFAULT_DISPLAY, { selected: true }).dashArray, dash);
});

test('contrast high adds +0.8 weight and draws at full opacity', () => {
  const base = displayStyle(ROAD, DEFAULT_DISPLAY);
  const high = displayStyle(ROAD, { ...DEFAULT_DISPLAY, contrast: 'high' });
  assert.equal(+(high.weight - base.weight).toFixed(3), 0.8);
  assert.equal(high.opacity, 1);
});

test('selected computes a casing flag distinct from the drawn stroke', () => {
  const plain = displayStyle(ROAD, DEFAULT_DISPLAY);
  const selected = displayStyle(ROAD, DEFAULT_DISPLAY, { selected: true });
  assert.equal(plain.casing, undefined, 'an unselected style carries no casing');
  assert.equal(selected.casing, true);
  assert.equal(selected.casingColor, '#ffffff');
  assert.equal(selected.casingWeight, selected.weight + 3);
});

test('casingStyle is pure and returns null for a non-selected style', () => {
  const plain = displayStyle(ROAD, DEFAULT_DISPLAY);
  assert.equal(casingStyle(plain), null);
  const selected = displayStyle(ROAD, DEFAULT_DISPLAY, { selected: true });
  const casing = casingStyle(selected);
  assert.deepEqual(casing, { color: '#ffffff', weight: selected.casingWeight, dashArray: selected.dashArray || undefined });
  // calling it again changes nothing -- pure function, no drawing side effect
  assert.deepEqual(casingStyle(selected), casing);
});

test('previewStyle is unchanged for every symbol key (D0 must not touch it)', () => {
  for (const symbol of Object.values(SYMBOLS)) {
    if (symbol.kind === 'raster' || symbol.kind === 'tick') continue;
    const style = previewStyle(symbol.key);
    assert.ok(style, `${symbol.key} must still style`);
    const screen = symbol.screen || {};
    assert.equal(style.color, screen.color || symbol.color, `${symbol.key}: colour drifted`);
    assert.equal(style.weight, Math.max(screen.minPx || 1.2, style.weight), `${symbol.key}: weight floor drifted`);
    assert.equal(style.key, symbol.key);
    if (screen.fill) {
      assert.equal(style.closed, true);
      assert.equal(style.fill, true);
      assert.equal(style.fillColor, style.color);
      assert.equal(style.fillOpacity, 0.12, `${symbol.key}: FILL_OPACITY constant drifted`);
    } else {
      assert.equal(style.closed, undefined);
    }
  }
});

test('DEFAULT_DISPLAY is frozen and carries the documented shape', () => {
  assert.throws(() => { DEFAULT_DISPLAY.lines = 2; }, TypeError);
  assert.deepEqual(DEFAULT_DISPLAY, { lines: 1, fill: 1, dim: 0, spotlight: null, contrast: 'normal' });
});
