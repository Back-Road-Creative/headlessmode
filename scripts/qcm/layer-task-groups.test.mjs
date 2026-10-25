// QQA-18 slice 1: the Layers panel is divided by what a reader is trying to do (plan 4.7), not by
// provider or rendering role. The grouping is presentation only: `group` on a registry row stays
// the rendering role every other module reads, and these task groups are a second, separate map
// from layer id to heading. This proves the map is total (a new provider cannot add a heading),
// that each id has one home, and the pure helpers the panel's Active list and search-restore use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAYERS, TASK_GROUPS, TASK_GROUP_OF, NO_CONTEXT_ROW_ID, GROUPS, CONTEXT_SURFACE_IDS } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';
import { BASES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-basemaps.js';
import { activeOnMapRows, groupsToCollapse } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-panel.js';

const HEADINGS = ['Map style', 'Places & routes', 'Land & access', 'Terrain & landscape', 'Weather & conditions',
  'Night sky', 'Cameras', 'Place facts', 'Explore counties', 'Print options'];

test('the panel headings are the plan 4.7 task groups, in order, and none is a provider or a rendering role', () => {
  assert.deepEqual(TASK_GROUPS.map((g) => g.label), HEADINGS);
  const oldLabels = GROUPS.map((g) => g.label).filter((l) => l !== 'Cameras' && l !== 'Place facts');
  for (const g of TASK_GROUPS) assert.ok(!oldLabels.includes(g.label), `"${g.label}" is an old technical heading`);
  for (const g of TASK_GROUPS) assert.ok(g.hint && g.hint.length > 0, `${g.id} explains itself`);
});

test('every registry id, every base id and the No-context row has exactly one primary group', () => {
  const wanted = [...LAYERS.map((l) => l.id), ...BASES.map((b) => b.id), NO_CONTEXT_ROW_ID];
  for (const id of new Set(wanted)) {
    const homes = TASK_GROUPS.filter((g) => g.ids.includes(id));
    assert.equal(homes.length, 1, `${id} has ${homes.length} task groups; a layer has exactly one primary home`);
    assert.equal(TASK_GROUP_OF[id], homes[0].id);
  }
  const listed = TASK_GROUPS.flatMap((g) => g.ids);
  assert.equal(new Set(listed).size, listed.length, 'an id is listed twice');
  for (const id of listed) assert.ok(wanted.includes(id), `${id} is mapped but is not a registry layer, base or the No-context row`);
});

test('the plan 4.7 table: each id lands where it says, and the print extras are exactly the extraPage rows', () => {
  const home = (g) => TASK_GROUPS.find((x) => x.label === g).ids;
  assert.deepEqual(home('Print options'), LAYERS.filter((l) => l.extraPage).map((l) => l.id).sort((a, b) => ['aerial', 'terrain', 'tripPage'].indexOf(a) - ['aerial', 'terrain', 'tripPage'].indexOf(b)));
  assert.deepEqual(home('Cameras'), ['roadCameras', 'parkCameras', 'linkCameras', 'phenoCameras', 'airportCameras']);
  for (const id of ['mvum', 'trails', 'recSites', 'blmRecSites', 'names']) assert.ok(home('Places & routes').includes(id), id);
  for (const id of ['federalLand', 'surfaceOwnership', 'countyLines', 'gameLands', 'stateParks', 'managedAreas', 'parcels']) assert.ok(home('Land & access').includes(id), id);
  for (const id of ['terrainSlope', 'nlcdLandCover', 'nlcdTreeCanopy', 'wetlands', 'gbifOccurrence']) assert.ok(home('Terrain & landscape').includes(id), id);
  for (const id of ['nwsRadar', 'epaAirNowAqi', 'noaaHmsSmoke', 'nifcFirePerimeters', 'femaNfhl']) assert.ok(home('Weather & conditions').includes(id), id);
  assert.deepEqual(home('Night sky'), ['nightLights', 'swpcAurora']);
  assert.deepEqual(home('Place facts'), ['padusAccess', 'epaEcoregions']);
  assert.deepEqual(home('Explore counties'), ['countyScore']);
  for (const id of ['usgsTopo', 'usgsImagery', 'usgsShadedRelief', 'none']) assert.ok(home('Map style').includes(id), id);
});

test('raster surfaces keep their one-choice semantics wherever they live: every one has a task group', () => {
  for (const id of CONTEXT_SURFACE_IDS) assert.ok(TASK_GROUP_OF[id], `${id} (a radio of the qcm-context choice) has no home`);
});

test('activeOnMapRows: checked layers only; the base choice, the No-context row and print extras are not "on the map"', () => {
  const rows = [
    { id: 'usgsTopo', label: 'USGS Topo', checked: true, group: 'mapStyle', base: true },
    { id: 'none', label: 'No context surface', checked: true, group: 'mapStyle', base: true },
    { id: 'trails', label: 'Trails', checked: true, group: 'places' },
    { id: 'mvum', label: 'MVUM', checked: false, group: 'places' },
    { id: 'tripPage', label: 'Route summary page', checked: true, group: 'print' },
  ];
  assert.deepEqual(activeOnMapRows(rows).map((r) => r.id), ['trails']);
  assert.deepEqual(activeOnMapRows([]), []);
});

test('activeOnMapRows: a row that opens on (road and place names) is lettering, not a layer the reader chose, so it is never listed', () => {
  const rows = [
    { id: 'names', label: 'Named places & landmarks', checked: true, group: 'places', lettering: true },
    { id: 'roads', label: 'Road names', checked: true, group: 'places', lettering: true },
    { id: 'trails', label: 'Trails', checked: true, group: 'places', lettering: false },
  ];
  assert.deepEqual(activeOnMapRows(rows).map((r) => r.id), ['trails']);
});

test('groupsToCollapse: a group the search opened closes on clear, unless the reader touched it', () => {
  assert.deepEqual(groupsToCollapse({ openedByFilter: new Set(['cameras', 'weather']), touched: new Set(['weather']) }), ['cameras']);
  assert.deepEqual(groupsToCollapse({ openedByFilter: new Set(), touched: new Set(['weather']) }), []);
});
