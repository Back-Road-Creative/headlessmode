// One ArcGIS paging loop, for every layer this map reads.
//
// A single /query answers one page and says so in `exceededTransferLimit`. Reading
// only the first page is how a boundary goes missing from paper with nothing said
// — the catalogue records services whose own measured bbox returns more than one
// page (Delaware, 26,863 against a 2,000 cap). This existed once, inside the state
// land fetcher; the federal layers need the same loop, and two hand-written copies
// of a paging protocol is the drift this file exists to prevent.
import { REQUEST_POLICY } from './source-registry.js';
import { fetchWithDeadline } from './request.js';

/** A page bigger than any measured service allows, and a hard stop on the loop.
 *  20 pages of 2,000 is 40,000 features — past any honest sheet, and the point at
 *  which "this area is too big" is the true answer. */
export const PAGE_CAP = 2000;
export const MAX_PAGES = 20;

/** Read every page of one ArcGIS query.
 *
 *  Each page is its own request with its own `timeoutMs`. The default is the old
 *  REQUEST_POLICY ceiling: callers that have not yet passed their source's own timeout
 *  keep the 20 s the wetlands and federal-land measurements were taken against.
 *  A timeout or a caller cancel throws, like any other failed page.
 *
 *  `normalize` turns a raw feature into this map's shape and may return null to
 *  drop it. `coverage` is 'complete' only when the service stopped flagging more;
 *  anything else is 'partial', which canBuild refuses to print — a truncated
 *  boundary set is worse than none, because it looks finished on paper.
 */
export async function pageThrough({
  url, params, normalize, label = 'the service',
  fetchImpl = fetch, signal, pageSize = PAGE_CAP, maxPages = MAX_PAGES, timeoutMs = REQUEST_POLICY.timeoutMs,
} = {}) {
  const size = Math.max(1, Math.min(pageSize, PAGE_CAP));
  const features = [], seen = new Set();
  let received = 0, pages = 0, more = true, complete = true;

  while (more) {
    if (pages >= maxPages) { complete = false; break; }
    const body = new URLSearchParams({
      ...params,
      resultOffset: String(received),
      resultRecordCount: String(size),
      f: 'json',
    });
    const got = await fetchWithDeadline(url, { fetchImpl, signal, timeoutMs, init: { method: 'POST', body } });
    if (got.status === 'aborted') throw Object.assign(new Error(`${label}: the request was cancelled.`), { name: 'AbortError' });
    if (got.status === 'timeout') throw new Error(`${label}: the service did not answer within ${timeoutMs} ms.`);
    if (got.httpStatus !== undefined && !got.ok) throw new Error(`${label}: the service answered ${got.httpStatus}.`);
    if (!got.ok) throw new Error(`${label}: ${got.error}`);
    const json = got.body;
    if (json.error) throw new Error(`${label}: ${json.error.message || 'the service refused the query.'}`);

    const raw = Array.isArray(json.features) ? json.features : [];
    received += raw.length;
    pages += 1;
    let added = 0;
    for (const one of raw) {
      const f = normalize(one);
      if (!f) continue;
      if (f.id && seen.has(f.id)) continue;   // a service ignoring resultOffset repeats itself
      if (f.id) seen.add(f.id);
      features.push(f);
      added += 1;
    }
    more = json.exceededTransferLimit === true;
    // Flagged as partial but handing back nothing new means paging is not being
    // honoured. Stop and say partial rather than loop, or trust a truncated set.
    if (more && added === 0) { complete = false; break; }
  }

  return { features, coverage: complete ? 'complete' : 'partial', pages, retrievedAt: new Date().toISOString() };
}
