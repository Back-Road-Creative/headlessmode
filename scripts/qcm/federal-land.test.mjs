// Federal designation boundaries, and the paging loop they share with state land.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAMILIES, FAMILY_IDS, LAYER_ID, OUT_FIELDS, SERVICE, queryUrl, normalizeFederal, fetchFederalLand }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/source-federal-land.js';
import { SYMBOL_BY_KEY } from '../../themes/headlessmode/static/js/quiet-corners-maps/legend.js';
import { STYLE } from '../../themes/headlessmode/static/js/quiet-corners-maps/overlay-paths.js';
import { LAYER_BY_ID } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';

const BBOX = { minLon: -83.55, minLat: 35.0, maxLon: -83.4, maxLat: 35.1 };
const ring = (n = 3) => [Array.from({ length: n }, (_, i) => [-83.5 + i / 100, 35.0 + i / 100])];
const feat = (id, name = 'Nantahala National Forest') => ({ attributes: { permanent_identifier: id, name }, geometry: { rings: ring() } });
const answer = (features, more = false) => ({ ok: true, json: async () => ({ features, exceededTransferLimit: more }) });

test('every family draws with a symbol that exists and can be stroked', () => {
  assert.ok(FAMILY_IDS.length >= 4);
  for (const family of FAMILY_IDS) {
    const key = FAMILIES[family].symbol;
    assert.ok(SYMBOL_BY_KEY[key], `${family} names symbol ${key}, which is not in the table`);
    assert.ok(STYLE[key], `${key} is not strokeable, so the family would print nothing`);
    assert.equal(SYMBOL_BY_KEY[key].pattern, 'federal', `${key} must carry the federal dash-dot`);
  }
});

// The parity invariant, at its actual failure point. `layer` is what the preview
// and the sheet test a checkbox against, and these four families share ONE toggle.
test('a federal boundary carries the toggle id, not the family, as its layer', () => {
  const f = normalizeFederal(feat('{abc}'), 'nationalForest');
  assert.equal(f.layer, LAYER_ID);
  assert.equal(f.layer, 'federalLand');
  assert.ok(LAYER_BY_ID[LAYER_ID], 'the toggle must be a real registry entry');
  assert.equal(f.symbolKey, 'fed-forest', 'the family survives in the symbol');
});

test('rings become paths, degenerate rings are dropped, and no personal field is asked for', () => {
  const f = normalizeFederal({ attributes: { name: 'X' }, geometry: { rings: [ring()[0], [[0, 0]]] } }, 'wilderness');
  assert.equal(f.paths.length, 1, 'a one-point ring is not a boundary');
  assert.deepEqual([...OUT_FIELDS], ['name', 'areasqkm'], 'this service publishes no personal field and none is requested');
  assert.match(queryUrl('wilderness'), /\/32\/query$/);
  assert.equal(queryUrl('bogus'), null);
});

// BLM is the legal-safety decision this module exists to record.
test('Bureau of Land Management is not a family', () => {
  assert.ok(!FAMILY_IDS.some((f) => /blm|landManagement/i.test(f)));
  const ids = FAMILY_IDS.map((f) => FAMILIES[f].layerId);
  assert.ok(!ids.includes(36), 'layer 36 is Field Offices — jurisdictions, not holdings');
  assert.deepEqual(ids.sort((a, b) => a - b), [29, 31, 32, 35]);
  assert.match(SERVICE, /^https:\/\/carto\.nationalmap\.gov\//);
});

test('a named unit answering as several records keeps them all, deduped by identifier', async () => {
  const fetchImpl = async () => answer([feat('{a}'), feat('{b}'), feat('{a}')]);
  const r = await fetchFederalLand({ family: 'nationalForest', bboxLonLat: BBOX, fetchImpl });
  assert.equal(r.features.length, 2, 'a repeated identifier is one boundary');
  assert.equal(r.coverage, 'complete');
  assert.equal(r.skipped, null);
});

test('an unknown family is an ordinary fact, not a throw', async () => {
  const r = await fetchFederalLand({ family: 'nope', bboxLonLat: BBOX });
  assert.deepEqual(r.features, []);
  assert.equal(r.coverage, 'unavailable');
});
