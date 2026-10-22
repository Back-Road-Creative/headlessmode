// The one ArcGIS paging loop, and the truncation it exists to refuse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageThrough, PAGE_CAP, MAX_PAGES } from '../../themes/headlessmode/static/js/quiet-corners-maps/arcgis-pager.js';

const ring = () => [[[-83.5, 35.0], [-83.4, 35.05], [-83.45, 35.1]]];
const feat = (id) => ({ attributes: { permanent_identifier: id }, geometry: { rings: ring() } });
const norm = (o) => ({ id: o.attributes.permanent_identifier, paths: o.geometry.rings });
const answer = (features, more = false) => ({ ok: true, json: async () => ({ features, exceededTransferLimit: more }) });

test('pageThrough follows exceededTransferLimit and reports complete only when the service stops', async () => {
  let call = 0;
  const fetchImpl = async () => (++call < 3 ? answer([feat(`{${call}}`)], true) : answer([feat('{last}')], false));
  const paged = await pageThrough({ url: 'x', params: {}, fetchImpl, normalize: norm });
  assert.equal(paged.pages, 3);
  assert.equal(paged.features.length, 3);
  assert.equal(paged.coverage, 'complete');
});

// The truncation this loop exists to refuse. A service that flags "more" forever
// while handing back nothing new must end as partial, never as a silent loop.
test('a service flagging more but repeating itself stops, and says partial', async () => {
  const fetchImpl = async () => answer([feat('{same}')], true);
  const r = await pageThrough({ url: 'x', params: {}, fetchImpl, normalize: norm });
  assert.equal(r.coverage, 'partial', 'a truncated boundary set looks finished on paper');
  assert.equal(r.pages, 2, 'one real page, then one that added nothing');
});

test('the page cap is honoured and an HTTP error names the layer', async () => {
  assert.equal(PAGE_CAP, 2000);
  assert.equal(MAX_PAGES, 20);
  let seen = null;
  await pageThrough({
    url: 'x', params: {}, pageSize: 99999, normalize: () => null,
    fetchImpl: async (_u, o) => { seen = o.body.get('resultRecordCount'); return answer([]); },
  });
  assert.equal(seen, String(PAGE_CAP), 'a caller cannot ask for more than the service allows');
  await assert.rejects(
    pageThrough({ url: 'x', params: {}, label: 'Designated Wilderness', normalize: () => null,
      fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /Designated Wilderness: the service answered 503/);
});
