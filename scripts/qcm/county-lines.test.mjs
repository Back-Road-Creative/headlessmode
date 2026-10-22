// County boundaries from govunits layer 23.
//
// The load-bearing decision this covers is that the boundaries come from the SERVICE
// and not from static/data/quiet-corners/counties-10m.json, which the site already
// serves same-origin. That file is generalized for a 1:5,000,000 index map: measured
// against this service for Macon County, NC it carries 28 vertices against 6,604 and
// sits a median of 254 m from the real line, 2,376 m at worst -- 0.42 to 3.9 inches on
// a 1:24,000 Letter sheet. A county line exists to answer "whose rules apply where I
// am standing", and one an inch out of place answers it wrongly with confidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCountyLines, normalizeCounty, OUT_FIELDS, QUERY_URL, LAYER_ID, SYMBOL }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/source-county-lines.js';
import { LAYERS } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';
import { SYMBOL_BY_KEY } from '../../themes/headlessmode/static/js/quiet-corners-maps/legend.js';

const macon = {
  attributes: { gnis_name: 'Macon County', county_name: 'Macon', state_name: 'North Carolina',
    permanent_identifier: 'fea7b1e5-0d45-48e9-918d-de56564321b7' },
  geometry: { rings: [[[-83.5, 35.0], [-83.4, 35.0], [-83.4, 35.1], [-83.5, 35.0]]] },
};

test('a county normalizes to a boundary the sheet and the preview both understand', () => {
  const f = normalizeCounty(macon);
  // The TOGGLE id, not a family: `on[f.layer]` is what both ends test.
  assert.equal(f.layer, LAYER_ID);
  assert.equal(f.symbolKey, SYMBOL);
  assert.ok(SYMBOL_BY_KEY[SYMBOL], `${SYMBOL} is not a real legend symbol`);
  assert.equal(f.id, 'fea7b1e5-0d45-48e9-918d-de56564321b7');
  assert.equal(f.paths.length, 1);
  // Qualified by state: a sheet can straddle a state line, and Washington County is
  // the name of 31 different places.
  assert.equal(f.name, 'Macon County, North Carolina');
});

test('a record with no usable ring is dropped rather than drawn as nothing', () => {
  assert.equal(normalizeCounty({ attributes: {}, geometry: { rings: [[[0, 0]]] } }).paths.length, 0);
});

test('the query asks for no field that identifies a person, and none the layer lacks', () => {
  // Layer 23 has NO `name` field -- asking for one returns "Failed to execute query"
  // and loses the whole layer, which is how the first attempt at this failed.
  assert.ok(!OUT_FIELDS.includes('name'), 'layer 23 has no `name` field; the query would fail outright');
  for (const f of OUT_FIELDS) assert.doesNotMatch(f, /own|mail|addr|deed|phone/i, `${f} looks personal`);
});

test('an empty answer is ambiguous, never "no counties here"', () => {
  // Every square foot of the lower 48 is in a county, so zero features means the
  // service did not say -- treating it as "none" would print a false sheet.
  const entry = LAYERS.find((l) => l.id === LAYER_ID);
  assert.ok(entry, 'countyLines is not in the layer registry, so it has no checkbox');
  assert.equal(entry.emptyMeans, 'ambiguous');
  assert.deepEqual(entry.symbolKeys, [SYMBOL]);
});

test('the fetch pages the real query URL and hands back normalized boundaries', async () => {
  const seen = [];
  // The pager POSTs; the parameters are in the body, not the query string.
  const fetchImpl = async (url, opts) => {
    seen.push([url, String(opts?.body ?? '')]);
    return { ok: true, json: async () => ({ features: [macon] }) };
  };
  const out = await fetchCountyLines({ bboxLonLat: { minLon: -83.55, minLat: 35, maxLon: -83.45, maxLat: 35.03 }, fetchImpl });
  assert.equal(out.features.length, 1);
  assert.equal(out.features[0].layer, LAYER_ID);
  const [url, body] = seen[0];
  assert.equal(url, QUERY_URL, `${url} is not the county query`);
  assert.match(body, /outSR=4326/, 'rings must arrive as lon/lat');
  assert.match(body, /geometry=-83\.55%2C35%2C-83\.45%2C35\.03/, `the bbox was not sent: ${body}`);
});
