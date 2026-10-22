// National Forest System surface ownership, from the USFS land-status service.
//
// The federal layer draws the PROCLAMATION boundary, which encloses private
// inholdings that were never federal. This layer is the answer to the question
// that boundary leaves open -- is the ground under my feet Forest Service land --
// drawn parcel by parcel. 81 parcels in the Standing Indian quad, so density is a
// rendering decision made here (thin, unlettered, every scale), never a reason to
// leave the layer out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSurfaceOwnership, normalizeOwnership, OUT_FIELDS, QUERY_URL, LAYER_ID, SYMBOL_NFS, SYMBOL_OTHER }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/source-surface-ownership.js';
import { LAYER_BY_ID, RENDER_BY_SYMBOL } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';
import { SYMBOL_BY_KEY, deriveLegend, LAND_COVERAGE_SEMANTICS } from '../../themes/headlessmode/static/js/quiet-corners-maps/legend.js';
import { STYLE, drawsAtScale, labelCandidates } from '../../themes/headlessmode/static/js/quiet-corners-maps/overlay-paths.js';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';

const ring = [[[-83.5, 35.0], [-83.4, 35.0], [-83.4, 35.1], [-83.5, 35.0]]];
const parcel = (ownerclassification, status = 'Acquired', id = '{D0940D49-CF8A-43AA-97D2-1F875097A415}') => ({
  attributes: { surfaceownershipid: id, ownerclassification, status, nfslandunitname: 'Nantahala National Forest' },
  geometry: { rings: ring },
});

test('a Forest Service parcel and a disposed one draw as different marks, on one toggle', () => {
  const fs = normalizeOwnership(parcel('USDA FOREST SERVICE'));
  const other = normalizeOwnership(parcel('NON-FS', 'Disposed'));
  // The TOGGLE id, not a class: `on[f.layer]` is what the preview and the sheet test.
  assert.equal(fs.layer, LAYER_ID);
  assert.equal(other.layer, LAYER_ID);
  assert.equal(fs.symbolKey, SYMBOL_NFS);
  assert.equal(other.symbolKey, SYMBOL_OTHER, 'ground the Forest Service disposed of is not public land');
  for (const key of [SYMBOL_NFS, SYMBOL_OTHER]) {
    assert.ok(SYMBOL_BY_KEY[key], `${key} is not a legend symbol`);
    assert.ok(STYLE[key], `${key} has no stroke style, so it would vanish from paper`);
  }
  assert.equal(fs.id, '{D0940D49-CF8A-43AA-97D2-1F875097A415}');
  assert.equal(fs.name, 'Nantahala National Forest');
  assert.equal(fs.paths.length, 1);
  assert.equal(normalizeOwnership({ attributes: {}, geometry: { rings: [[[0, 0]]] } }).paths.length, 0);
});

test('the case name is a person and is never requested', () => {
  // Measured 2026-09-10: `casename` over the test quad reads "SLAGLE, C. W.",
  // "CRUSE, E. G." -- the people the Forest Service bought the ground from.
  assert.ok(!OUT_FIELDS.includes('casename'));
  for (const f of OUT_FIELDS) assert.doesNotMatch(f, /case|own(er)?$|mail|addr|deed|phone|tax|comment/i, `${f} looks personal`);
  const src = SOURCES.usfsSurfaceOwnership;
  assert.ok(src, 'the service is not in the measured registry, so it prints uncredited');
  assert.deepEqual([...src.layers[0].fields], [...OUT_FIELDS], 'the registry and the fetch must agree on the field list');
});

test('density is a render rule: thin, unlettered, and drawn at every scale', () => {
  const entry = LAYER_BY_ID[LAYER_ID];
  assert.ok(entry, `${LAYER_ID} is not in the layer registry, so it has no checkbox`);
  assert.deepEqual([...entry.symbolKeys].sort(), [SYMBOL_NFS, SYMBOL_OTHER].sort());
  assert.equal(entry.emptyMeans, 'none');
  for (const key of entry.symbolKeys) {
    assert.equal(RENDER_BY_SYMBOL[key].labels, 'none');
    assert.ok(drawsAtScale(key, 48000), `${key} must still draw at 1:48,000 -- density is not exclusion`);
    // Thinner than every other boundary the sheet draws: 81 of these in a quad.
    for (const s of Object.values(SYMBOL_BY_KEY)) {
      if (s.kind !== 'line' || s.chrome || key === s.key) continue;
      assert.ok(SYMBOL_BY_KEY[key].widthIn <= s.widthIn, `${key} is wider than ${s.key}`);
    }
  }
  // The rule reaches the labeller: a long parcel edge earns no letters.
  const long = [[0, 0], [400, 0], [400, 400]];
  const vectors = entry.symbolKeys.map((key) => ({ key, id: key, labels: RENDER_BY_SYMBOL[key].labels, path: long }));
  assert.deepEqual(labelCandidates(vectors), []);
});

test('a drawn ownership line brings the access notice onto the key', () => {
  const l = deriveLegend({ renderedSymbolKeys: [SYMBOL_NFS], gridEnabled: false, basemapRendered: true });
  assert.deepEqual(l.notices, [LAND_COVERAGE_SEMANTICS]);
});

test('the fetch pages the real query URL and hands back normalized parcels', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push([url, String(opts?.body ?? '')]);
    // Two records, one repeated: a repeated identifier is one boundary, as every
    // other paged layer here already treats it.
    return { ok: true, json: async () => ({ features: [parcel('USDA FOREST SERVICE'), parcel('NON-FS', 'Disposed', '{b}'), parcel('USDA FOREST SERVICE')] }) };
  };
  const out = await fetchSurfaceOwnership({ bboxLonLat: { minLon: -83.55, minLat: 35, maxLon: -83.45, maxLat: 35.03 }, fetchImpl });
  assert.deepEqual(out.features.map((f) => f.symbolKey), [SYMBOL_NFS, SYMBOL_OTHER]);
  assert.equal(out.coverage, 'complete');
  const [url, body] = seen[0];
  assert.equal(url, QUERY_URL);
  assert.match(url, /EDW_SurfaceOwnership_01\/MapServer\/0\/query$/);
  assert.match(body, /outSR=4326/, 'rings must arrive as lon/lat');
  assert.match(body, /geometry=-83\.55%2C35%2C-83\.45%2C35\.03/, `the bbox was not sent: ${body}`);
  assert.doesNotMatch(body, /casename/);
});
