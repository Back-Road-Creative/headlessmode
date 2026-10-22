// Registry contract for the 'names' layer: present, reachable, and reaches
// paper the same way every other federal overlay does. main.js's own fetch/
// build wiring is covered functionally by name-labels.test.mjs's
// isStaleGeneration/namesAdapterPayload (main.js cannot be imported under
// node --test -- it reads `window` at module scope) and by the end-to-end
// case added to build.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LAYERS, LAYER_BY_ID, GROUPS, DEFAULT_LAYERS, enabledLayers } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';
import { DEFAULTS, recipeFromControls } from '../../themes/headlessmode/static/js/quiet-corners-maps/app-state.js';
import { SYMBOL_BY_KEY } from '../../themes/headlessmode/static/js/quiet-corners-maps/legend.js';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';

test('the names row is registered, live, on by default, and reaches paper', () => {
  const names = LAYER_BY_ID.names;
  assert.ok(names, 'a "names" layer row exists');
  assert.equal(names.status, 'live');
  assert.equal(names.defaultOn, true, 'a reader who touches nothing sees GNIS names, like Road names');
  assert.equal(names.required, false);
  assert.equal(names.screenOnly, undefined, 'names is drawn on the map, not screen-only');
  assert.equal(names.extraPage, undefined, 'names is drawn on the main sheet, not an extra page');
  assert.ok(GROUPS.some((g) => g.id === names.group), `names names a real group (${names.group})`);
  assert.equal(SOURCES[names.sourceId]?.id, 'gnisNames', 'names points at the measured GNIS service');
  assert.ok(names.symbolKeys.length > 0, 'names draws and must name symbols');
  for (const k of names.symbolKeys) assert.ok(SYMBOL_BY_KEY[k], `${k} must be a real legend symbol`);
});

test('enabledLayers includes names unless the reader switched it off', () => {
  assert.ok(!enabledLayers({}).some((l) => l.id === 'names'), 'a bare map with no recipe asks for nothing');
  assert.ok(!enabledLayers({ names: false }).some((l) => l.id === 'names'), 'off when switched off');
  assert.ok(enabledLayers({ names: true }).some((l) => l.id === 'names'), 'on once asked for');
});

test('names is in the default recipe, from the registry alone', () => {
  assert.equal(DEFAULT_LAYERS.names, true);
  assert.equal(DEFAULTS.layers.names, true, 'app-state DEFAULTS flows from the registry, no second literal');
  assert.ok(enabledLayers(DEFAULT_LAYERS).some((l) => l.id === 'names'));
  const rec = recipeFromControls({}, { minLon: -83.55, minLat: 35.0, maxLon: -83.45, maxLat: 35.03 }, 'Default');
  assert.equal(rec.layers.names, true, 'a fresh recipe carries names');
  const off = recipeFromControls({ layers: { names: false } }, { minLon: -83.55, minLat: 35.0, maxLon: -83.45, maxLat: 35.03 }, 'Stored off');
  assert.equal(off.layers.names, false, 'a stored names:false stays off');
});

// The per-view pass and the Check press both ask for names. Ticking the row arms the view pass
// (settleMs later); pressing Check right away answers the print box first. Check's answer must
// drop the armed view pass, or the same view is fetched twice and the second fetch lands in
// whatever the reader does next (seen as a stray carto + hydro request inside a card open).
test("Check's names answer cancels the view pass the row toggle armed", () => {
  const main = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
  const start = main.indexOf('if (layers.names && !browse) {');
  assert.ok(start > 0, "sourcePass has a names block gated on !browse");
  const block = main.slice(start, main.indexOf('if (stale()) return;', start));
  assert.match(block, /namesFetched = null;/, 'the held view answer is dropped');
  assert.match(block, /namesDebounce\.cancel\(\);/, 'the armed view pass is dropped with it');
});
