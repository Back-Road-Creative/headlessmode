// QQA-05r-2: the registry contract for the 'roads' row (Road names on the screen map): a
// screen-only, default-on row in the same group as GNIS names, with About text that says where
// the names come from and when they start. main.js cannot be imported under node --test (it
// reads `window` at module scope), so the drawing is proved in road-labels-browser.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAYERS, LAYER_BY_ID, GROUPS, DEFAULT_LAYERS, enabledLayers, fetchedBySourcePass } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';
import { layerAboutText } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-panel.js';
import { SYMBOL_BY_KEY } from '../../themes/headlessmode/static/js/quiet-corners-maps/legend.js';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { ROAD_CLASSES } from '../../themes/headlessmode/static/js/quiet-corners-maps/road-names.js';

const roads = LAYER_BY_ID.roads;

test('the roads row sits directly after names, in the same group, screen-only and on by default', () => {
  assert.ok(roads, 'a "roads" layer row exists');
  const ids = LAYERS.map((l) => l.id);
  assert.equal(ids.indexOf('roads'), ids.indexOf('names') + 1, 'roads follows names');
  assert.equal(roads.group, LAYER_BY_ID.names.group);
  assert.ok(GROUPS.some((g) => g.id === roads.group));
  assert.equal(roads.label, 'Road names');
  assert.equal(roads.sourceId, 'usgsRoadNames');
  assert.equal(SOURCES[roads.sourceId].id, 'usgsRoadNames');
  assert.equal(roads.screenOnly, true);
  assert.equal(roads.defaultOn, true);
  assert.equal(roads.required, false);
  assert.equal(roads.status, 'live');
  assert.ok(roads.symbolKeys.length > 0);
  for (const k of roads.symbolKeys) assert.ok(SYMBOL_BY_KEY[k], `${k} must be a real legend symbol`);
});

test('the default-on set is the base map, Road names and Named places, nothing else', () => {
  const on = Object.entries(DEFAULT_LAYERS).filter(([, v]) => v).map(([k]) => k).sort();
  assert.deepEqual(on, ['names', 'roads', 'usgsTopo']);
});

test('a screen-only row is never fetched for paper, switched on or not', () => {
  assert.equal(fetchedBySourcePass(roads), false);
  assert.ok(!enabledLayers({ roads: true }).some((l) => l.id === 'roads'));
  assert.ok(!enabledLayers(DEFAULT_LAYERS).some((l) => l.id === 'roads'));
});

test('About text names USGS The National Map, the first zoom, the local-road zoom and the source caveat', () => {
  const text = layerAboutText({ layer: roads, source: SOURCES.usgsRoadNames });
  const first = Math.min(...ROAD_CLASSES.map((c) => c.zoom));
  const local = ROAD_CLASSES.find((c) => c.key === 'local').zoom;
  assert.match(text, /USGS The National Map/);
  assert.ok(text.includes(`zoom ${first}`), `names zoom ${first}: ${text}`);
  assert.ok(text.includes(`from zoom ${local}`), `names zoom ${local}: ${text}`);
  assert.ok(text.includes(SOURCES.usgsRoadNames.coverageCaveat), 'carries the source caveat verbatim');
  assert.match(text, /not (drawn|printed)|screen/i, 'says it is not on the printed sheet');
});
