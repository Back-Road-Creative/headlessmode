// Road-name data layer: zoom bands, shield text, name cleanup, grouping, anchors, order, caps.
// Run: node --test scripts/qcm/road-names.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ROAD_CLASSES, ROAD_DENSITY_CAP, layersForZoom, readAttr, shieldText, normalizeRoadName,
  groupRoads, anchorOnPolyline, roadLabelOrder,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/road-names.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/road-names-sylva.json', import.meta.url), 'utf8'));
const cls = (layer) => ROAD_CLASSES.find((c) => c.layer === layer);

test('zoom bands: nothing below 10, then each class from its own first zoom', () => {
  assert.deepEqual(layersForZoom(0), []);
  assert.deepEqual(layersForZoom(9), []);
  assert.deepEqual(layersForZoom(9.9), []);
  assert.deepEqual(layersForZoom(10), [29]);
  assert.deepEqual(layersForZoom(11), [29, 30]);
  assert.deepEqual(layersForZoom(12), [29, 30, 31, 35]);
  assert.deepEqual([...layersForZoom(13)].sort((a, b) => a - b), [29, 30, 31, 32, 35]);
  assert.deepEqual([...layersForZoom(18)].sort((a, b) => a - b), [29, 30, 31, 32, 35]);
  assert.deepEqual(layersForZoom(NaN), []);
  assert.deepEqual(layersForZoom(undefined), []);
});

test('the class table is frozen and carries layer, key, first zoom', () => {
  assert.deepEqual(ROAD_CLASSES.map((c) => [c.layer, c.zoom]).sort((a, b) => a[0] - b[0]),
    [[29, 10], [30, 11], [31, 12], [32, 13], [35, 12]]);
  for (const c of ROAD_CLASSES) assert.ok(c.key && c.label, `layer ${c.layer} lacks key/label rule`);
  assert.throws(() => { ROAD_CLASSES[0].zoom = 1; });
});

test('readAttr is case-insensitive and returns null for blanks', () => {
  assert.equal(readAttr({ US_Route: '74' }, 'us_route'), '74');
  assert.equal(readAttr({ us_route: ' 74 ' }, 'US_ROUTE'), '74');
  assert.equal(readAttr({ name: '' }, 'name'), null);
  assert.equal(readAttr({ name: null }, 'name'), null);
  assert.equal(readAttr({}, 'name'), null);
  assert.equal(readAttr(null, 'name'), null);
  assert.equal(readAttr({ n: 5 }, 'n'), '5');
  assert.equal(readAttr({ federal_lands_route: '###' }, 'federal_lands_route'), null, 'junk is not a route');
});

test('shieldText builds the shield from the route fields', () => {
  assert.equal(shieldText(cls(29), { interstate: '26' }), 'I-26');
  assert.equal(shieldText(cls(29), { interstate: 'I-26' }), 'I-26');
  assert.equal(shieldText(cls(29), { interstate: '26,40' }), 'I-26/40');
  assert.equal(shieldText(cls(29), { interstate: null, us_route: '74' }), 'US 74');
  assert.equal(shieldText(cls(30), { us_route: '74', stco_fipscode: '37099' }), 'US 74');
  assert.equal(shieldText(cls(30), { us_route: '23,74' }), 'US 23/74');
  assert.equal(shieldText(cls(30), { state_route: '107', stco_fipscode: '37099' }), 'NC 107');
  // A business/bypass/alternate qualifier is a suffix, never a route number.
  assert.equal(shieldText(cls(30), { us_route: 'Bus,23', stco_fipscode: '37099' }), 'US 23 Bus');
  assert.equal(shieldText(cls(30), { us_route: '23,Bus' }), 'US 23 Bus');
  assert.equal(shieldText(cls(30), { us_route: '23 Bus' }), 'US 23 Bus');
  assert.equal(shieldText(cls(30), { us_route: 'BYP,74' }), 'US 74 Byp');
  assert.equal(shieldText(cls(30), { us_route: 'Alt,19,23' }), 'US 19/23 Alt');
  assert.equal(shieldText(cls(30), { state_route: 'Bus,107', stco_fipscode: '37099' }), 'NC 107 Bus');
  assert.equal(shieldText(cls(30), { us_route: 'Bus' }), null);
  assert.equal(shieldText(cls(30), { state_route: '73', stco_fipscode: '48245' }), 'TX 73');
  assert.equal(shieldText(cls(30), { STATE_ROUTE: '107', STCO_FIPSCODE: '37099' }), 'NC 107');
  assert.equal(shieldText(cls(35), { federal_lands_route: '4600' }), 'FS 4600');
  // A state route whose state cannot be read yields no shield, never a guessed one.
  assert.equal(shieldText(cls(30), { state_route: '107' }), null);
  assert.equal(shieldText(cls(30), { state_route: '107', stco_fipscode: '99001' }), null);
  assert.equal(shieldText(cls(30), {}), null);
  // Local roads have no shield rule.
  assert.equal(shieldText(cls(32), { us_route: '74' }), null);
});

test('normalizeRoadName cleans route spellings and shouting', () => {
  assert.equal(normalizeRoadName('I- 26'), 'I-26');
  assert.equal(normalizeRoadName('I-  15'), 'I-15');
  assert.equal(normalizeRoadName('US Hwy 74'), 'US 74');
  assert.equal(normalizeRoadName('NC Hwy 107'), 'NC 107');
  assert.equal(normalizeRoadName('DRYLAND LAUREL BRANCH'), 'Dryland Laurel Branch');
  assert.equal(normalizeRoadName('US HWY 74'), 'US 74');
  assert.equal(normalizeRoadName('OLD NC 107 RD'), 'Old NC 107 Rd');
  assert.equal(normalizeRoadName('  <Main>   St  '), 'Main St');
  assert.equal(normalizeRoadName('E Main St'), 'E Main St', 'an already-clean name is unchanged');
  assert.equal(normalizeRoadName('Dills Cove Rd'), 'Dills Cove Rd');
  assert.equal(normalizeRoadName('I-26'), 'I-26');
  // Short all-caps names are left alone (could be a real abbreviation).
  assert.equal(normalizeRoadName('CR 5'), 'CR 5');
  assert.equal(normalizeRoadName(null), '');
  assert.equal(normalizeRoadName(undefined), '');
});

const feat = (layer, attributes, paths) => ({ layer, attributes, geometry: { paths } });
const LINE = (n) => [[-83.2, 35.3], [-83.2 + n * 0.001, 35.3]];

test('groupRoads makes one entry per normalised label, keeping the longest run and all parts', () => {
  const entries = groupRoads([
    feat(31, { name: 'E Main St' }, [LINE(1)]),
    feat(31, { name: 'E MAIN ST' }, [LINE(5)]),
    feat(31, { name: 'E Main St' }, [LINE(3)]),
    feat(32, { name: 'Dills Cove Rd' }, [LINE(2)]),
    feat(32, { name: null }, [LINE(2)]),
    feat(32, { name: '<>' }, [LINE(2)]),
  ]);
  assert.equal(entries.length, 2);
  const main = entries.find((e) => e.label === 'E Main St');
  assert.equal(main.parts.length, 3);
  assert.deepEqual(main.longest, LINE(5));
  assert.ok(main.lengthM > 400 && main.lengthM < 500, `lengthM ${main.lengthM}`);
  assert.equal(main.layer, 31);
  assert.ok(Number.isFinite(main.anchor.lon) && Number.isFinite(main.anchor.lat));
  assert.equal(main.anchor.bearing, 0);
});

test('groupRoads labels a highway by its shield and a local road by its name', () => {
  const entries = groupRoads([
    feat(29, { name: 'I- 26', interstate: '26' }, [LINE(8)]),
    feat(30, { name: 'US Hwy 441', us_route: '441' }, [LINE(4)]),
    feat(30, { name: 'Webster Rd', state_route: '116', stco_fipscode: '37099' }, [LINE(4)]),
    feat(31, { name: 'Ridge Rd' }, [LINE(2)]),
    feat(35, { name: null, federal_lands_route: '4600' }, [LINE(2)]),
  ]);
  assert.deepEqual(entries.map((e) => e.label).sort(), ['FS 4600', 'I-26', 'NC 116', 'Ridge Rd', 'US 441']);
});

test('the same road on two layers is one entry at its most important class', () => {
  const [e, ...rest] = groupRoads([
    feat(30, { name: 'US Hwy 74', us_route: '74' }, [LINE(2)]),
    feat(29, { name: 'US Hwy 74', us_route: '74' }, [LINE(3)]),
  ]);
  assert.equal(rest.length, 0);
  assert.equal(e.layer, 29);
  assert.equal(e.parts.length, 2);
});

test('groupRoads over the real Sylva capture yields unique labels and no retired names', () => {
  const features = Object.entries(FIX.layers).flatMap(([layer, l]) => l.features.map((f) => ({ ...f, layer: Number(layer) })));
  const entries = groupRoads(features);
  assert.ok(entries.length > 10);
  assert.equal(new Set(entries.map((e) => e.label.toLowerCase())).size, entries.length);
  assert.ok(entries.every((e) => !/squaw/i.test(e.label)));
  assert.ok(entries.some((e) => /^US \d/.test(e.label)), 'a US shield is present');
});

test('anchorOnPolyline: midpoint and upright bearing of the longest segment', () => {
  // Three segments: short east, long north-east, short south-east.
  const line = [[-83.20, 35.30], [-83.199, 35.30], [-83.18, 35.32], [-83.179, 35.319]];
  const a = anchorOnPolyline(line);
  assert.ok(Math.abs(a.lon - (-83.1895)) < 1e-9, `lon ${a.lon}`);
  assert.ok(Math.abs(a.lat - 35.31) < 1e-9, `lat ${a.lat}`);
  // Heading up and to the right: text rotates counter-clockwise on screen (negative).
  assert.ok(a.bearing < -30 && a.bearing > -60, `bearing ${a.bearing}`);
  // Reversed line: same anchor, same upright bearing.
  const b = anchorOnPolyline([...line].reverse());
  assert.ok(Math.abs(b.bearing - a.bearing) < 1e-9);
  // Due east is 0, due west is flipped upright to 0, vertical is within range.
  assert.equal(anchorOnPolyline([[-83.2, 35.3], [-83.1, 35.3]]).bearing, 0);
  assert.equal(anchorOnPolyline([[-83.1, 35.3], [-83.2, 35.3]]).bearing, 0);
  const v = anchorOnPolyline([[-83.2, 35.3], [-83.2, 35.4]]).bearing;
  assert.ok(v >= -90 && v <= 90);
  for (const [x, y] of [[1, 1], [-1, 1], [-1, -1], [1, -1], [0.1, 5]]) {
    const r = anchorOnPolyline([[-83.2, 35.3], [-83.2 + x * 0.01, 35.3 + y * 0.01]]).bearing;
    assert.ok(r >= -90 && r <= 90, `bearing ${r} out of upright range`);
  }
  assert.equal(anchorOnPolyline([]), null);
  assert.equal(anchorOnPolyline([[-83.2, 35.3]]), null);
});

test('roadLabelOrder: interstate, US/state, connecting, 4WD, local, then longer first', () => {
  const entries = groupRoads([
    feat(32, { name: 'Long Local Rd' }, [LINE(9)]),
    feat(32, { name: 'Short Local Rd' }, [LINE(1)]),
    feat(35, { name: 'Jeep Track' }, [LINE(9)]),
    feat(31, { name: 'Connector Rd' }, [LINE(1)]),
    feat(30, { name: 'US Hwy 74', us_route: '74' }, [LINE(1)]),
    feat(29, { name: 'I- 26', interstate: '26' }, [LINE(1)]),
    feat(29, { name: 'Smoky Expy', us_route: '23' }, [LINE(1)]),
  ]);
  assert.deepEqual(roadLabelOrder(entries).map((e) => e.label),
    ['I-26', 'US 23', 'US 74', 'Connector Rd', 'Jeep Track', 'Long Local Rd', 'Short Local Rd']);
  // Does not mutate its input.
  const before = entries.map((e) => e.label);
  roadLabelOrder(entries);
  assert.deepEqual(entries.map((e) => e.label), before);
});

test('density caps are their own table, frozen, and not the GNIS ones', () => {
  assert.deepEqual({ ...ROAD_DENSITY_CAP }, { sparse: 12, standard: 25, more: 40 });
  assert.throws(() => { ROAD_DENSITY_CAP.standard = 99; });
});
