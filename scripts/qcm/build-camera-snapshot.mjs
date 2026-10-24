// Build-time camera snapshots: fetch developer.nps.gov's keyed webcams API, normalize it
// with normalizeNpsWebcams, and write a small static JSON snapshot the browser can load without
// ever holding the key itself (spec QUX-07-08.md:207, tier 2). QUX-08C ships only this builder
// and its tests -- per plan R2-G15 the CLI's `--out` wiring into CI and the first committed
// snapshot file under `static/` land with QUX-08D, the first unit that reads one. There is
// deliberately no default output path here.
//
// Fail-soft, not fail-open: a transient NPS outage, a missing/unregistered NPS_API_KEY, or an
// upstream response that normalizes to zero cameras must never overwrite a known-good snapshot
// with nothing. This site's own rule for a published data file is to overwrite it with a
// tombstone, never just delete it (site CLAUDE.md, "Deleting a published data file") -- the same
// logic applies one step earlier: a build step must not manufacture the empty-catalogue case in
// the first place. So every failure path here is a no-op against `--out`: whatever was already
// on disk (including nothing at all) is left exactly as it was.
//
// The key never reaches the artifact: fetchSnapshot only ever threads apiKey into the outgoing
// request URL, buildSnapshot's output has no field that could carry it, and
// writeSnapshotOrKeepExisting asserts the serialized JSON does not contain the key string before
// writing -- an upstream gate on the one irreversible step (the file write), not a late check
// after the fact.
//
// Camera U5: the NPS row is `nps-webcams` -- every located NPS webcam nationwide, paged, one file per
// state -- and the legacy `--out` file still holds GRSM only, from its own `parkCode=grsm` request,
// untouched. A curated still is HEAD-checked at build time and a 404 makes that camera link-only.
//
// Camera U2 (the directory build): `--out-dir <dir>` writes `index.json` plus one compact file per
// (provider, region) -- the format is camera-snapshot.js's, shared with the browser -- from a
// provider table. NPS GRSM was the first provider on it, moved onto the table with no change to
// what the browser reads (camera U3 adds Caltrans, one file per district): `--out <path>` still
// writes the legacy cameras-nps-grsm.json. Both outputs of one run share memoFetch, so a URL is
// asked for once.
//
// Fail-soft per provider and per file, never fail-open:
//   - a provider that cannot fetch, or whose region normalizes to zero records, leaves every file
//     it already wrote alone (the on-disk state is the only state: nothing is remembered between
//     runs);
//   - `--only a,b` runs just those provider ids (a seed refresh for one operator);
//   - index.json is REBUILT from whatever valid files are on disk, so a provider that failed keeps
//     its old files and its old index rows;
//   - a region over the file budget splits by a 2 degree grid instead of failing; a provider whose
//     files would break the index or directory budget fails soft BEFORE its first write.
// The one loud failure is a key in any output: every key value in the provider table (and every
// serialized file, index included) is checked before ANY file of the run is written.
import { writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeNpsWebcams, normalizeCaltransDistrict, npsCuratedStills, npsStateOf,
  parseHpwrenSites, normalizeHpwrenSites, normalizeAlertWestCameras, alertWestStateOf,
  ARCGIS_LAYERS, normalizeArcgisCameras, arcgisStill, CARS_FEEDS, normalizeCarsCameras, normalizeSrtmcCameras, CARS_STALE_MS,
  ITERIS_LAYERS, normalizeIterisCameras, SOCRATA_LAYERS, normalizeSocrataCameras, LINK_ROAD_LAYERS, normalizeLinkRoadCameras,
  normalizePhenocam, normalizeAviationwx, PHENOCAM_HOME, AVIATIONWX_HOME, WSF_LAYER } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-camera.js';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { compactSnapshot, snapshotProblems, snapshotStale }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/camera-snapshot.js';

export const GRSM_WEBCAMS_URL = 'https://developer.nps.gov/api/v1/webcams?parkCode=grsm';
const GRSM_WEBCAMS_PAGE = 'https://www.nps.gov/grsm/learn/photosmultimedia/webcams.htm';

/** Size budgets (measured: the committed GRSM seed is ~2 KB, a 753-camera Caltrans district about
 *  135 KB at ~180 bytes a row). A file over `fileBytes` splits by grid; `indexBytes` and `dirBytes`
 *  bound what a client downloads to learn what exists and what a build can publish in all.
 *  dirBytes, re-measured with the six ArcGIS operators (2026-10-04): the committed directory is
 *  1,183,788 bytes in 31 files (index.json 8,888 of its 16 KB; the largest ArcGIS file, TripCheck,
 *  is 208,110 of 256 KB). That is over 1 MB, so it rounds up to 2 MB: the 2 MB budget stands, with
 *  about 0.8 MB of headroom. The index, not the directory, is the tight budget: the NPS per-state
 *  refresh (27 rows) on top of these seeds measures 16,082 of 16,384 bytes, so a provider that adds
 *  files (Florida's FL511 layer, 3,799 cameras, is 10 files and about 3 KB of index) does not fit
 *  until index rows get smaller. Raise a budget from a new measurement, never by guess.
 *
 *  Re-measured with the CARS feeds (MN, IN, KS, Spokane; 2026-10-04): the committed directory is
 *  1,582,614 bytes in 35 files (1.51 MB, so the 2 MB budget still stands) and index.json is 10,042
 *  bytes. A normal build serves these seeds as they are (the CARS rows are seed-only), so a live
 *  build cannot grow the directory past what was measured here. The 27-state NPS refresh on top of them measures 17,538 bytes, which no longer fits 16 KB, so
 *  the index budget is 24 KB (7,038 bytes of room). The largest CARS file, Minnesota, is 212,883
 *  of 256 KB, which is within the file budget, and a provider that grows past it splits by grid.
 *
 *  Re-measured with the Iteris and Socrata seeds added (VA, SD, Austin, Baton Rouge; 2026-10-04):
 *  1,879,093 bytes in 39 files (1.79 MB, under the 2 MB budget) and index.json is 10,999 bytes.
 *  The 27-state NPS refresh was not re-run; adding the 957 bytes these rows grew the index by to
 *  the 17,538 measured above gives about 18.5 KB, inside the 24 KB index budget.
 *
 *  Re-measured with the link-only road seeds added (MoDOT, Maryland CHART, DelDOT, NMRoads, NJTA;
 *  2026-10-04): 2,142,810 bytes in 44 files, which passes 2 MB, so the directory budget is the total
 *  rounded up to the next whole MB, 3 MB. index.json is 12,337 bytes; the NPS refresh estimate grows
 *  by the same 1,338 bytes to about 19.8 KB, still inside 24 KB.
 *
 *  Colorado added (2026-10-05): 2,375,083 bytes, over 75% of 3 MB, so dirBytes is 4 MB (owner asked for
 *  every open camera; seeds load per map area, so the directory size is a deploy-size guard). */
export const BUDGETS = Object.freeze({ fileBytes: 256 * 1024, indexBytes: 24 * 1024, dirBytes: 4 * 1024 * 1024 });
const GRID_DEGREES = 2;
const HPWREN_SITES_URL = 'https://www.hpwren.ucsd.edu/cameras/sites.js';
const ALERTWEST_URL = 'https://alertwest.live/api/firecams/v0/cameras';
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** ArcGIS REST camera layers: a plain GET per page, one request at a time with a pause between
 *  pages, an honest user agent and nothing else on the request (no Origin or Referer, no token, no
 *  cookie). A layer that answers only to those is dropped from the table, not worked around. */
export const ARCGIS_PAUSE_MS = 500;
export const ARCGIS_USER_AGENT = 'headlessmode-camera-build/1.0 (+https://headlessmode.com)';
const ARCGIS_MAX_PAGES = 100;
/** The link-only road operators that publish a page or KML, not JSON: read as text, never memoised. */
const LINK_TEXT_URLS = new Set(LINK_ROAD_LAYERS.filter((l) => l.format === 'text').map((l) => l.sourceUrl));
const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Pure: raw NPS payload -> the normalized snapshot object. No network, no fs -- fully testable
 *  without touching either. */
export function buildSnapshot(payload, { fetchedAt, source } = {}) {
  const generatedAt = fetchedAt || new Date().toISOString();
  return {
    generatedAt,
    source: source || GRSM_WEBCAMS_URL,
    cameras: normalizeNpsWebcams(payload, { fetchedAt: generatedAt }),
  };
}

/** GET `url` and parse it as JSON, or say why not. Never throws: every failure (network error,
 *  non-2xx, unparseable body) comes back as `{ ok: false, reason }`. `label` names the upstream in
 *  the reason. The fetch is injectable so nothing that calls this needs the network to be tested. */
export async function fetchJson(url, { fetchImpl = fetch, label = 'upstream', init } = {}) {
  let res;
  try {
    res = init ? await fetchImpl(url, init) : await fetchImpl(url);
  } catch (err) {
    return { ok: false, reason: `fetch-error: ${err && err.message ? err.message : err}` };
  }
  if (!res.ok) return { ok: false, reason: `fetch-error: ${label} answered ${res.status}` };
  try {
    return { ok: true, payload: await res.json() };
  } catch (err) {
    return { ok: false, reason: `fetch-error: response body was not valid JSON (${err.message})` };
  }
}

/** Camera U5: the nationwide list, paged. The recorded GRSM envelope reports `limit: "50"`,
 *  `start: "0"` and a string `total`, so 50 is the page size the API is known to honor; ~251
 *  located cameras are about six requests. Paging past that default is UNVERIFIED (no key was
 *  available to measure it), so the loop trusts only `total` and an empty page, never a bigger
 *  `limit`, and is capped so a lying `total` cannot loop forever. */
export const NPS_WEBCAMS_URL = 'https://developer.nps.gov/api/v1/webcams';
export const NPS_PAGE_LIMIT = 50;
const NPS_MAX_PAGES = 60;
const NPS_WEBCAMS_HOME = 'https://www.nps.gov/';
const nationwideUrl = (apiKey, start) =>
  `${NPS_WEBCAMS_URL}?limit=${NPS_PAGE_LIMIT}&start=${start}&api_key=${encodeURIComponent(apiKey)}`;

const STATE_NAMES = Object.freeze({
  al: 'Alabama', ak: 'Alaska', az: 'Arizona', ar: 'Arkansas', ca: 'California', co: 'Colorado',
  ct: 'Connecticut', de: 'Delaware', dc: 'District of Columbia', fl: 'Florida', ga: 'Georgia',
  hi: 'Hawaii', id: 'Idaho', il: 'Illinois', in: 'Indiana', ia: 'Iowa', ks: 'Kansas',
  ky: 'Kentucky', la: 'Louisiana', me: 'Maine', md: 'Maryland', ma: 'Massachusetts',
  mi: 'Michigan', mn: 'Minnesota', ms: 'Mississippi', mo: 'Missouri', mt: 'Montana',
  ne: 'Nebraska', nv: 'Nevada', nh: 'New Hampshire', nj: 'New Jersey', nm: 'New Mexico',
  ny: 'New York', nc: 'North Carolina', nd: 'North Dakota', oh: 'Ohio', ok: 'Oklahoma',
  or: 'Oregon', pa: 'Pennsylvania', ri: 'Rhode Island', sc: 'South Carolina', sd: 'South Dakota',
  tn: 'Tennessee', tx: 'Texas', ut: 'Utah', vt: 'Vermont', va: 'Virginia', wa: 'Washington',
  wv: 'West Virginia', wi: 'Wisconsin', wy: 'Wyoming', pr: 'Puerto Rico', vi: 'U.S. Virgin Islands',
  gu: 'Guam', as: 'American Samoa', mp: 'Northern Mariana Islands',
});

/** [south, north, west, east] of each state or territory, in degrees, rough and a little generous
 *  on purpose. A located NPS camera must fall inside the box of a state its first related park
 *  lists, padded by STATE_BBOX_PAD; the live list carries cameras filed at a made-up position
 *  (Brisbane, San Diego) and a pin there would be wrong, not just loose. */
export const STATE_BBOX = Object.freeze({
  al: [30.2, 35.0, -88.5, -84.9], ak: [51.2, 71.5, -180, -129.9], az: [31.3, 37.0, -114.9, -109.0],
  ar: [33.0, 36.5, -94.7, -89.6], ca: [32.5, 42.0, -124.5, -114.1], co: [36.9, 41.0, -109.1, -102.0],
  ct: [40.9, 42.1, -73.8, -71.8], de: [38.4, 39.9, -75.8, -75.0], dc: [38.79, 39.0, -77.12, -76.9],
  fl: [24.4, 31.0, -87.7, -79.9], ga: [30.3, 35.0, -85.7, -80.8], hi: [18.9, 22.3, -160.3, -154.8],
  id: [42.0, 49.0, -117.3, -111.0], il: [36.9, 42.6, -91.6, -87.0], in: [37.7, 41.8, -88.1, -84.7],
  ia: [40.3, 43.6, -96.7, -90.1], ks: [36.9, 40.0, -102.1, -94.6], ky: [36.5, 39.2, -89.6, -81.9],
  la: [28.9, 33.1, -94.1, -88.8], me: [43.0, 47.5, -71.1, -66.9], md: [37.9, 39.8, -79.5, -75.0],
  ma: [41.2, 42.9, -73.5, -69.9], mi: [41.7, 48.3, -90.5, -82.1], mn: [43.5, 49.4, -97.3, -89.5],
  ms: [30.1, 35.0, -91.7, -88.1], mo: [36.0, 40.7, -95.8, -89.1], mt: [44.3, 49.0, -116.1, -104.0],
  ne: [40.0, 43.0, -104.1, -95.3], nv: [35.0, 42.0, -120.0, -114.0], nh: [42.7, 45.3, -72.6, -70.6],
  nj: [38.9, 41.4, -75.6, -73.9], nm: [31.3, 37.0, -109.1, -103.0], ny: [40.5, 45.1, -79.8, -71.8],
  nc: [33.8, 36.6, -84.4, -75.4], nd: [45.9, 49.0, -104.1, -96.5], oh: [38.4, 42.0, -84.9, -80.5],
  ok: [33.6, 37.0, -103.1, -94.4], or: [42.0, 46.3, -124.7, -116.4], pa: [39.7, 42.3, -80.6, -74.7],
  ri: [41.1, 42.1, -71.9, -71.1], sc: [32.0, 35.2, -83.4, -78.5], sd: [42.5, 46.0, -104.1, -96.4],
  tn: [34.9, 36.7, -90.4, -81.6], tx: [25.8, 36.5, -106.7, -93.5], ut: [36.9, 42.1, -114.1, -109.0],
  vt: [42.7, 45.1, -73.5, -71.5], va: [36.5, 39.5, -83.7, -75.2], wa: [45.5, 49.1, -124.9, -116.9],
  wv: [37.2, 40.7, -82.7, -77.7], wi: [42.4, 47.1, -92.9, -86.8], wy: [41.0, 45.1, -111.1, -104.0],
  pr: [17.9, 18.6, -67.3, -65.2], vi: [17.6, 18.5, -65.1, -64.5], gu: [13.2, 13.7, 144.6, 145.0],
  as: [-14.6, -14.1, -171.2, -169.4], mp: [14.1, 20.6, 144.8, 146.1],
});
export const STATE_BBOX_PAD = 1.5;

/** True when (lat, lon) is inside the box of at least one state code in `codes`, padded by `pad`
 *  degrees (STATE_BBOX_PAD by default; the ArcGIS road layers pass 0, their rows are real positions). */
export function inAnyStateBox(lat, lon, codes, pad = STATE_BBOX_PAD) {
  return codes.some((c) => {
    const b = STATE_BBOX[c];
    return b && lat >= b[0] - pad && lat <= b[1] + pad
      && lon >= b[2] - pad && lon <= b[3] + pad;
  });
}

/** The two-letter codes (lower case) of the states the row's FIRST related park lists. */
function npsParkStates(row) {
  const park = row && Array.isArray(row.relatedParks) ? row.relatedParks[0] : null;
  return park && typeof park.states === 'string'
    ? park.states.split(',').map((x) => x.trim().toLowerCase()).filter((x) => /^[a-z]{2}$/.test(x)) : [];
}

/** GET every page of the nationwide list: `{ ok, payload: { total, data } }` or the first page's
 *  failure. One failed page fails the provider (its old files stay): a half catalogue must never
 *  replace a whole one. */
async function fetchNpsPages(apiKey, fetchImpl) {
  const data = [];
  let total = Infinity;
  let lastFirstId = null;
  for (let page = 0; page < NPS_MAX_PAGES && data.length < total; page += 1) {
    const got = await fetchJson(nationwideUrl(apiKey, data.length), { fetchImpl, label: 'NPS' });
    if (!got.ok) return got;
    const rows = got.payload && Array.isArray(got.payload.data) ? got.payload.data : [];
    if (rows.length === 0) break;
    // An API that ignores `start` answers the same page every time; stop before it fills `total`.
    const firstId = rows[0] && rows[0].id ? rows[0].id : null;
    if (firstId !== null && firstId === lastFirstId) {
      return { ok: false, reason: 'fetch-error: NPS paging incomplete (the same page came back for a new start)' };
    }
    lastFirstId = firstId;
    data.push(...rows);
    const n = Number(got.payload.total);
    total = Number.isFinite(n) ? n : (rows.length < NPS_PAGE_LIMIT ? data.length : Infinity);
  }
  if (data.length < total) {
    return { ok: false, reason: `fetch-error: NPS paging incomplete (${data.length} of ${total} rows)` };
  }
  return { ok: true, payload: { total: data.length, data } };
}

/** GET every page of one ArcGIS layer: `{ ok, payload: { features } }` or the first failure. A
 *  page that fails, an error body (ArcGIS answers HTTP 200 with `{ error }`), a layer that ignores
 *  `resultOffset` (the same first row twice) or one that claims more rows than it ever sends fails
 *  the layer, so a half catalogue never replaces a whole one. */
export async function fetchArcgisPages(layer, { fetchImpl = fetch, sleep = defaultSleep } = {}) {
  const features = [];
  let lastFirst = null;
  for (let page = 0; page < ARCGIS_MAX_PAGES; page += 1) {
    if (page > 0) await sleep(ARCGIS_PAUSE_MS);
    const url = `${layer.serviceUrl}/query?where=1=1&outFields=${layer.outFields.join(',')}&outSR=4326&f=json`
      + `&resultOffset=${features.length}&resultRecordCount=${layer.pageSize}`;
    const got = await fetchJson(url, { fetchImpl, label: layer.operator, init: { method: 'GET', headers: { 'User-Agent': ARCGIS_USER_AGENT } } });
    if (!got.ok) return got;
    const body = got.payload;
    if (!body || typeof body !== 'object' || body.error || !Array.isArray(body.features)) {
      return { ok: false, reason: `fetch-error: ${layer.operator} answered something that is not a query result` };
    }
    const rows = body.features;
    const more = body.exceededTransferLimit === true;
    if (rows.length === 0) {
      if (more || features.length === 0) {
        return { ok: false, reason: `fetch-error: ${layer.operator} paging incomplete (${features.length} rows, then an empty page)` };
      }
      return { ok: true, payload: { features } };
    }
    const first = JSON.stringify(rows[0]);
    if (first === lastFirst) {
      return { ok: false, reason: `fetch-error: ${layer.operator} paging incomplete (the same page came back for a new offset)` };
    }
    lastFirst = first;
    features.push(...rows);
    if (!more && rows.length < layer.pageSize) return { ok: true, payload: { features } };
  }
  return { ok: false, reason: `fetch-error: ${layer.operator} paging incomplete (over ${ARCGIS_MAX_PAGES} pages)` };
}

/** CARS camera lists (MN, NY, IN, KS) and Spokane's SRTMC map: the same plain GET, honest user
 *  agent and nothing else as the ArcGIS layers, one request per list. A list that is not a
 *  non-empty array, or a map answer that holds a cluster (the query then did not return every
 *  camera) or an error, fails the provider so a half catalogue never replaces a whole one. */
export async function fetchCarsList(feed, { fetchImpl = fetch } = {}) {
  const got = await fetchJson(feed.listUrl, { fetchImpl, label: feed.operator, init: { method: 'GET', headers: { 'User-Agent': ARCGIS_USER_AGENT } } });
  if (!got.ok) return got;
  if (!Array.isArray(got.payload) || got.payload.length === 0) {
    return { ok: false, reason: `fetch-error: ${feed.operator} answered something that is not a camera list` };
  }
  return { ok: true, payload: { raw: got.payload, dead: [] } };
}

const SRTMC_QUERY = 'query($input: MapFeaturesArgs!){mapFeaturesQuery(input:$input){mapFeatures{uri title __typename '
  + 'features{id geometry} ... on Camera{active views(limit:5){uri category ... on CameraView{url}}}}error{message type}}}';

export async function fetchSrtmcMap(feed, { fetchImpl = fetch } = {}) {
  const [south, north, west, east] = feed.bbox;
  const body = JSON.stringify({ query: SRTMC_QUERY, variables: { input: { north, south, east, west, zoom: 14, layerSlugs: ['normalCameras'] } } });
  const got = await fetchJson(feed.listUrl, { fetchImpl, label: feed.operator, init: {
    method: 'POST', headers: { 'User-Agent': ARCGIS_USER_AGENT, 'Content-Type': 'application/json' }, body } });
  if (!got.ok) return got;
  const q = got.payload && got.payload.data && got.payload.data.mapFeaturesQuery;
  if (!q || q.error || !Array.isArray(q.mapFeatures) || q.mapFeatures.length === 0) {
    return { ok: false, reason: `fetch-error: ${feed.operator} answered something that is not a map result` };
  }
  if (q.mapFeatures.some((m) => !m || m.__typename !== 'Camera')) {
    return { ok: false, reason: `fetch-error: ${feed.operator} answered a cluster, so the query did not return every camera` };
  }
  return { ok: true, payload: { raw: got.payload, dead: [] } };
}

/** The still check, run only under `--refresh-seeds` (a thousand pictures a build would be a lot
 *  to ask of a state's server): a HEAD per picture, at most CARS_CHECK_CONCURRENCY at a time with a
 *  pause between batches. `stillVerdict` is 'drop' for a refused, missing or non-image answer, the
 *  operator's offline placeholder (size plus etag, never the size alone) and a Last-Modified over a
 *  day old; anything else, an unreachable server included, keeps the picture. */
export const CARS_CHECK_CONCURRENCY = 4;
export const CARS_CHECK_PAUSE_MS = 100;
export const CARS_PLACEHOLDER = Object.freeze({ bytes: 15136, etag: '9c2d059e65a23b43a5b481c16918fed4' });
const BLOCKED_STATUSES = Object.freeze([401, 403, 429]);
const isBlocked = (status) => BLOCKED_STATUSES.includes(status);
/** `{ verdict, reason }` for one HEAD answer. `reason` is 'blocked' (401/403/429: the host refused
 *  us), 'gone' (404/410), 'not-image', 'stand-in' (the offline placeholder), 'stale' (Last-Modified
 *  over a day old), 'error' (any other non-200) or 'ok'. Only the verdict decides keep or drop, and
 *  it is exactly what it always was: of the blocked answers a 403 drops and a 401 or 429 keeps. */
export function stillOutcome(res, { now = Date.now() } = {}) {
  const status = Number(res && res.status);
  if (status === 403) return { verdict: 'drop', reason: 'blocked' };
  if (isBlocked(status)) return { verdict: 'keep', reason: 'blocked' };
  if (status === 404 || status === 410) return { verdict: 'drop', reason: 'gone' };
  if (status !== 200) return { verdict: 'keep', reason: 'error' };
  const h = (k) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(k) : null);
  const type = h('content-type');
  if (type && !/^image\//i.test(type)) return { verdict: 'drop', reason: 'not-image' };
  if (h('content-length') === String(CARS_PLACEHOLDER.bytes) && String(h('etag') || '').replace(/"/g, '') === CARS_PLACEHOLDER.etag) return { verdict: 'drop', reason: 'stand-in' };
  const modified = Date.parse(h('last-modified') || '');
  if (Number.isFinite(modified) && now - modified > CARS_STALE_MS) return { verdict: 'drop', reason: 'stale' };
  return { verdict: 'keep', reason: 'ok' };
}
export const stillVerdict = (res, opts) => stillOutcome(res, opts).verdict;

/** The counts one provider's still check leaves in the refresh log. `blocked` counts every 401,
 *  403 or 429 answer, kept or dropped, so a host that refuses every picture shows even when its
 *  refusals are not all drops. A picture that could not be asked (a network error) is `kept`. */
const emptyStillCounts = () => ({ checked: 0, kept: 0, droppedBlocked: 0, droppedGone: 0, droppedOther: 0, blocked: 0 });
function tallyStill(counts, { verdict, reason }) {
  counts.checked += 1;
  if (reason === 'blocked') counts.blocked += 1;
  if (verdict === 'keep') counts.kept += 1;
  else if (reason === 'blocked') counts.droppedBlocked += 1;
  else if (reason === 'gone') counts.droppedGone += 1;
  else counts.droppedOther += 1;
}

export async function checkCarsStillsDetailed(records, { fetchImpl = fetch, sleep = defaultSleep, now = Date.now() } = {}) {
  const dead = [];
  const counts = emptyStillCounts();
  for (let i = 0; i < records.length; i += CARS_CHECK_CONCURRENCY) {
    if (i > 0) await sleep(CARS_CHECK_PAUSE_MS);
    await Promise.all(records.slice(i, i + CARS_CHECK_CONCURRENCY).map(async (r) => {
      try {
        const res = await fetchImpl(r.media.still, { method: 'HEAD', headers: { 'User-Agent': ARCGIS_USER_AGENT } });
        const outcome = stillOutcome(res, { now });
        tallyStill(counts, outcome);
        if (outcome.verdict === 'drop') dead.push(r.providerId);
      } catch { /* unreachable is not gone */ tallyStill(counts, { verdict: 'keep', reason: 'unreachable' }); }
    }));
  }
  return { dead: dead.sort(), counts };
}

export async function checkCarsStills(records, opts) {
  return (await checkCarsStillsDetailed(records, opts)).dead;
}

export const ARCGIS_MAX_AGE_MS = 7 * 86400000;
// Request volume (stated choice): a full gate is one HEAD per still, about 2,700 across the six
// layers (UDOT 1,168 and TripCheck 1,178 alone). That is run only by `--refresh-seeds`, where a
// person reviews the result and commits the gated seeds. A deploy build (build-site.sh) never
// runs it: it leaves the ArcGIS seeds untouched (see `seedOnly`), so a site build sends operators
// no picture request at all. Inside a refresh the gate is paced: 3 workers, a pause between each.
const ARCGIS_HEAD_CONCURRENCY = 3;
export const ARCGIS_HEAD_PAUSE_MS = 150;

/** Upstream gate: HEAD every picture a layer would publish and drop the cameras whose picture
 *  answers 404, 410 or 5xx, or whose Last-Modified is over 7 days old (a placeholder still is
 *  stale the same way) or whose Content-Length is a size the layer records as its stand-in image
 *  (`layer.placeholderLengths`; a server may re-stamp a stand-in so age alone misses it). A network error, a missing header or a 4xx other than 404/410 keeps the
 *  camera: that is not proof the picture is gone. Returns `{ payload, dropped, counts }`, `counts`
 *  being the per-picture tally the refresh log carries (a 401, 403 or 429 is counted `blocked` and kept). */
export async function gateArcgisStills(payload, layer, { fetchImpl = fetch, now = Date.now(), sleep = defaultSleep } = {}) {
  const features = Array.isArray(payload && payload.features) ? payload.features : [];
  const urlOf = (f) => {
    const got = f && f.attributes && typeof f.attributes === 'object' ? layer.read(f.attributes) : null;
    const url = got ? arcgisStill(got.still, layer) : null;
    return url ? url.href : null;
  };
  const urls = [...new Set(features.map(urlOf).filter(Boolean))];
  const dead = new Set();
  const counts = emptyStillCounts();
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++];
      try {
        const res = await fetchImpl(url, { method: 'HEAD', headers: { 'User-Agent': ARCGIS_USER_AGENT } });
        const length = Number(res.headers && res.headers.get ? res.headers.get('content-length') : NaN);
        const stand = Array.isArray(layer.placeholderLengths) && layer.placeholderLengths.includes(length);
        const modified = Date.parse(res.headers && res.headers.get ? res.headers.get('last-modified') : '');
        const gone = res.status === 404 || res.status === 410;
        const drop = gone || res.status >= 500 || stand || (Number.isFinite(modified) && now - modified > ARCGIS_MAX_AGE_MS);
        if (drop) dead.add(url);
        tallyStill(counts, { verdict: drop ? 'drop' : 'keep', reason: gone ? 'gone' : isBlocked(res.status) ? 'blocked' : drop ? 'other' : 'ok' });
      } catch { /* unreachable is not gone */ tallyStill(counts, { verdict: 'keep', reason: 'unreachable' }); }
      await sleep(ARCGIS_HEAD_PAUSE_MS);
    }
  };
  await Promise.all(Array.from({ length: Math.min(ARCGIS_HEAD_CONCURRENCY, urls.length) }, worker));
  const kept = features.filter((f) => !dead.has(urlOf(f)));
  return { payload: { ...payload, features: kept }, dropped: features.length - kept.length, counts };
}

const PLAIN_GET = Object.freeze({ method: 'GET', headers: Object.freeze({ 'User-Agent': ARCGIS_USER_AGENT }) });

/** GET each list of one Iteris CDN layer (a plain GET, a pause between lists) and merge their
 *  GeoJSON features: `{ ok, payload: { features } }` or the first failure. A list that fails, is
 *  not GeoJSON or is empty fails the layer, so a half catalogue never replaces a whole one. */
export async function fetchIterisLists(layer, { fetchImpl = fetch, sleep = defaultSleep } = {}) {
  const features = [];
  for (const [i, url] of layer.listUrls.entries()) {
    if (i > 0) await sleep(ARCGIS_PAUSE_MS);
    const got = await fetchJson(url, { fetchImpl, label: layer.operator, init: PLAIN_GET });
    if (!got.ok) return got;
    const body = got.payload;
    if (!body || typeof body !== 'object' || !Array.isArray(body.features) || body.features.length === 0) {
      return { ok: false, reason: `fetch-error: ${layer.operator} answered something that is not a camera list` };
    }
    features.push(...body.features);
  }
  return { ok: true, payload: { features } };
}

/** GET every page of one Socrata (SODA) dataset: `$select` of named fields, `$order=:id` so paging
 *  is stable, `$limit` and `$offset`. `{ ok, payload: { rows } }` or the first failure; an error
 *  object, an empty first page, a dataset that ignores `$offset` or runs past the page cap fails
 *  the dataset. */
export async function fetchSocrataPages(layer, { fetchImpl = fetch, sleep = defaultSleep } = {}) {
  const rows = [];
  let lastFirst = null;
  for (let page = 0; page < ARCGIS_MAX_PAGES; page += 1) {
    if (page > 0) await sleep(ARCGIS_PAUSE_MS);
    const url = `${layer.resourceUrl}?$select=${layer.outFields.join(',')}&$order=:id`
      + `&$limit=${layer.pageSize}&$offset=${rows.length}`;
    const got = await fetchJson(url, { fetchImpl, label: layer.operator, init: PLAIN_GET });
    if (!got.ok) return got;
    const body = got.payload;
    if (!Array.isArray(body)) return { ok: false, reason: `fetch-error: ${layer.operator} answered something that is not a row list` };
    if (body.length === 0) {
      return rows.length === 0 ? { ok: false, reason: `fetch-error: ${layer.operator} answered no rows` } : { ok: true, payload: { rows } };
    }
    const first = JSON.stringify(body[0]);
    if (first === lastFirst) return { ok: false, reason: `fetch-error: ${layer.operator} paging incomplete (the same page came back for a new offset)` };
    lastFirst = first;
    rows.push(...body);
    if (body.length < layer.pageSize) return { ok: true, payload: { rows } };
  }
  return { ok: false, reason: `fetch-error: ${layer.operator} paging incomplete (over ${ARCGIS_MAX_PAGES} pages)` };
}

/** HEAD each curated still that a located camera in `data` would publish; the ids whose still
 *  answers 404 or 410 come back so the camera is published link-only. Any other outcome (a 5xx,
 *  a network error) keeps the still: it is not proof the picture is gone. */
async function deadCuratedStills(data, fetchImpl) {
  const curated = npsCuratedStills();
  const ids = [...new Set(data.filter((w) => curated[w && w.id] && num(w.latitude) !== null && num(w.longitude) !== null)
    .map((w) => w.id))];
  const dead = [];
  await Promise.all(ids.map(async (id) => {
    try {
      const res = await fetchImpl(curated[id], { method: 'HEAD' });
      if (res.status === 404 || res.status === 410) dead.push(id);
    } catch { /* unreachable is not gone */ }
  }));
  return dead.sort();
}
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

const grsmUrl = (apiKey) => `${GRSM_WEBCAMS_URL}&api_key=${encodeURIComponent(apiKey)}`;

/** Fetches and normalizes one snapshot, or reports why it couldn't. Never throws -- every
 *  failure (no key, network error, non-2xx, unparseable body, zero normalized records) comes
 *  back as `{ ok: false, reason }` so the caller can leave an existing artifact untouched. The
 *  fetch is always injectable so this, and everything that calls it, is testable with no network. */
export async function fetchSnapshot({ apiKey, fetchImpl = fetch, source } = {}) {
  if (!apiKey) return { ok: false, reason: 'no-key: NPS_API_KEY is not set in the environment' };

  const got = await fetchJson(grsmUrl(apiKey), { fetchImpl, label: 'NPS' });
  if (!got.ok) return got;

  const snapshot = buildSnapshot(got.payload, { fetchedAt: new Date().toISOString(), source });
  if (snapshot.cameras.length === 0) {
    return { ok: false, reason: 'zero-records: normalized to 0 cameras, refusing to publish an empty catalogue' };
  }
  return { ok: true, snapshot };
}

/** Writes the snapshot to `out`, or leaves whatever is already there untouched when fetchSnapshot
 *  couldn't produce one. `out` is required -- there is no default path under `static/` (R2-G15:
 *  this unit ships no published data file). */
export async function writeSnapshotOrKeepExisting({ out, apiKey, fetchImpl = fetch, source, alsoGuard = [] } = {}) {
  if (!out) throw new Error('build-camera-snapshot: writeSnapshotOrKeepExisting requires `out`.');
  const result = await fetchSnapshot({ apiKey, fetchImpl, source });
  if (!result.ok) return { written: false, reason: result.reason };

  const json = JSON.stringify(result.snapshot, null, 2);
  // Upstream gate on the one irreversible step in this module (the write): confirm the key
  // cannot be in the bytes about to be committed, rather than trusting that nothing upstream put
  // it there.
  if ([apiKey, ...alsoGuard].some((key) => key && json.includes(key))) {
    throw new Error('build-camera-snapshot: refusing to write -- the API key appears in the snapshot output.');
  }
  writeFileSync(out, json);
  return { written: true, reason: 'ok', cameraCount: result.snapshot.cameras.length };
}

// ---------------------------------------------------------------------------------------------
// The directory build.

/** One file per state the layer covers; a position outside that state (a pin in the ocean, a
 *  swapped coordinate) is junk and is never published. */
function stateRegions(layer, records) {
  return layer.states.map((state) => ({
    region: `${layer.id}-${state}`,
    regionName: `${STATE_NAMES[state]} (${layer.label})`,
    records: records.filter((r) => inAnyStateBox(r.lat, r.lon, [state])),
  }));
}

// Colorado (2026-10-05). The COtrip list holds more cameras than the directory budget comfortably
// holds, so it is thinned to one camera per 0.025 degree cell (about 2.8 km; the lowest numeric id
// wins, so a refresh is stable).
export const THIN_CELLS_PER_DEGREE = 40;
const idNumber = (r) => { const n = Number(r.providerId); return Number.isFinite(n) ? n : Infinity; };

/** One record per grid cell, the lowest numeric providerId winning; kept is sorted by id. */
export function thinByCell(records) {
  const best = new Map();
  for (const r of records) {
    const key = `${Math.floor(r.lat * THIN_CELLS_PER_DEGREE)},${Math.floor(r.lon * THIN_CELLS_PER_DEGREE)}`;
    const held = best.get(key);
    if (!held || idNumber(r) < idNumber(held)) best.set(key, r);
  }
  const kept = [...best.values()].sort((a, b) => idNumber(a) - idNumber(b));
  return { kept, dropped: records.length - kept.length };
}

const CARS_RECORD_FILTERS = Object.freeze({ 'co-cotrip': (records) => thinByCell(records).kept });

const TERRITORIES = new Set(['pr', 'vi', 'gu', 'as', 'mp']);
/** True when (lat, lon) is inside the (unpadded) box of one of the 50 states or DC; territories do
 *  not count. The boxes are rough, so a camera a box lets through from over the border is named by
 *  `FOREIGN_NAME` below. */
const inUnitedStates = (lat, lon) => Object.entries(STATE_BBOX)
  .some(([code, b]) => !TERRITORIES.has(code) && lat >= b[0] && lat <= b[1] && lon >= b[2] && lon <= b[3]);
// PhenoCam descriptions end in the country when it is not the US ("..., Ontario, Canada"); three
// live Canadian sites sit inside the rough Maine, New York and Washington boxes.
const FOREIGN_NAME = /,\s*(Canada|Mexico)\.?\s*$/i;
const FOREIGN_ICAO = /^(C|MM)/i;

const PHENOCAM_URL = 'https://phenocam.nau.edu/api/cameras/?format=json&limit=2000';
const AVIATIONWX_URL = 'https://api.aviationwx.org/v1/airports';

/** One file named `us` per provider: a state split would put ~50 more rows in an index.json whose
 *  16 KB budget the NPS state files already use (~300 bytes a row). */
const usRegion = (records) => (records.length ? [{ region: 'us', regionName: 'United States',
  records: [...records].sort((x, y) => (x.providerId < y.providerId ? -1 : 1)) }] : []);

// ---- WSDOT ferry terminal cameras (wa-wsf) ----------------------------------------------------
/** One GET of WSDOT's ferry-map camera list, turned into the GeoJSON-shaped rows normalizeIterisCameras
 *  reads (`{ ok, payload: { features } }`). An answer that is not the list, or an empty one, fails the
 *  provider so a half catalogue never replaces a whole one. Pictures are not asked for here. */
export async function fetchWsfCameras(layer, { fetchImpl = fetch } = {}) {
  const got = await fetchJson(layer.listUrls[0], { fetchImpl, label: layer.operator, init: PLAIN_GET });
  if (!got.ok) return got;
  const list = got.payload && Array.isArray(got.payload.FeedContentList) ? got.payload.FeedContentList : null;
  if (!list || list.length === 0) return { ok: false, reason: `fetch-error: ${layer.operator} answered something that is not a camera list` };
  const features = list.map((x) => x && x.FerryCamera).filter((c) => c && typeof c === 'object').map((c) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [c.Lon, c.Lat] },
    properties: { id: c.CamID, title: c.Title, image_url: c.ImgURL, active: c.IsActive },
  }));
  return { ok: true, payload: { features } };
}

/** One provider per row. `fetch({ env, fetchImpl })` -> `{ ok, payload }` or `{ ok:false, reason }`
 *  (a key comes from `env[keyEnv]`, never from anywhere else); `regions(payload, { fetchedAt })`
 *  -> `[{ region, regionName, records }]`, the records already normalized by source-camera.js. */
const normalize = (feed, raw, fetchedAt) => (feed.kind === 'srtmc'
  ? normalizeSrtmcCameras(raw, feed, { fetchedAt }) : normalizeCarsCameras(raw, feed, { fetchedAt }));

// USGS VolcView + AVO and NOAA GLERL rows (their fetchers are the block under PROVIDERS).
import { normalizeVolcview, normalizeGlerl, VOLCVIEW_HOME, GLERL_HOME }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/source-camera.js';
const VOLCVIEW_URL = 'https://volcview.wr.usgs.gov/ashcam-api/webcamApi/webcams';
const AVO_URL = 'https://avo.alaska.edu/ashcam-api/webcamApi/webcams';
const GLERL_PAGE_URL = 'https://www.glerl.noaa.gov/metdata/';
LINK_TEXT_URLS.add(GLERL_PAGE_URL); // the page is read as text, so memoFetch must not parse it

export const PROVIDERS = Object.freeze([
  /** Every located NPS webcam, one file per state (a park spanning states is filed under its first
   *  listed state). Per state, not per park or one national file, because of the budgets: ~100
   *  park rows would put index.json (~300 bytes a row, 16 KB budget; measured 11.5 KB with the
   *  live set's 27 NPS state rows plus the Caltrans seeds, ~16 rows of headroom left) over budget, and one national file makes every viewer download every camera. A state file is a
   *  few KB, and a state that ever outgrows 256 KB splits by grid on its own. */
  Object.freeze({
    id: 'nps-webcams',
    layer: 'parkCameras',
    keyEnv: 'NPS_API_KEY',
    source: NPS_WEBCAMS_URL,
    officialUrl: NPS_WEBCAMS_HOME,
    async fetch({ env = {}, fetchImpl = fetch } = {}) {
      const apiKey = env.NPS_API_KEY;
      if (!apiKey) return { ok: false, reason: 'no-key: NPS_API_KEY is not set in the environment' };
      const got = await fetchNpsPages(apiKey, fetchImpl);
      if (!got.ok) return got;
      return { ok: true, payload: { ...got.payload, deadStills: await deadCuratedStills(got.payload.data, fetchImpl) } };
    },
    regions(payload, { fetchedAt } = {}) {
      const dead = new Set(payload.deadStills || []);
      const rowOf = new Map();
      for (const row of payload.data || []) if (row && row.id && !rowOf.has(row.id)) rowOf.set(row.id, row);
      const byState = new Map();
      for (const r of normalizeNpsWebcams(payload, { fetchedAt, provider: 'nps-webcams', operator: 'National Park Service' })) {
        if (r.lat === null || r.lon === null) continue; // a pin needs a position
        // Upstream plausibility gate: a camera with no park, or a position outside every state
        // its first park lists, is junk (test rows, a pin in Brisbane) and is never published.
        const row = rowOf.get(r.providerId);
        const state = npsStateOf(row);
        if (!state || !inAnyStateBox(r.lat, r.lon, npsParkStates(row))) continue;
        const rec = dead.has(r.providerId) ? Object.freeze({ ...r, media: { ...r.media, still: null } }) : r;
        if (!byState.has(state)) byState.set(state, []);
        byState.get(state).push(rec);
      }
      return [...byState].sort(([x], [y]) => (x < y ? -1 : 1)).map(([state, records]) => ({
        region: `nps-${state}`, regionName: STATE_NAMES[state], records }));
    },
  }),
  Object.freeze({
    id: 'caltrans-cwwp2',
    layer: 'roadCameras',
    source: SOURCES.caltransCctv.metadataUrl,
    officialUrl: SOURCES.caltransCctv.metadataUrl,
    /** Keyless. Asks every district feed; a district that fails is left out of `payload.districts`
     *  and named in `warnings`, so its existing file stays. Fails only when no district answered. */
    async fetch({ fetchImpl = fetch } = {}) {
      const areas = SOURCES.caltransCctv.coverageAreas;
      const got = await Promise.all(areas.map((area) => fetchJson(area.serviceUrl, { fetchImpl, label: 'Caltrans' })));
      const districts = {};
      const warnings = [];
      areas.forEach((area, i) => {
        if (got[i].ok) districts[area.id] = got[i].payload;
        else warnings.push(`${area.id}: ${got[i].reason}`);
      });
      if (Object.keys(districts).length === 0) return { ok: false, reason: `fetch-error: no Caltrans district answered (${warnings.join('; ')})` };
      return { ok: true, payload: { districts }, warnings };
    },
    regions(payload, { fetchedAt } = {}) {
      return SOURCES.caltransCctv.coverageAreas
        .filter((area) => payload.districts && area.id in payload.districts)
        .map((area) => ({ region: area.id, regionName: `Caltrans ${area.name}`,
          records: normalizeCaltransDistrict(payload.districts[area.id], area.id.slice(4), { fetchedAt }) }));
    },
  }),
  /** HPWREN (UC San Diego): one pin per site, link-only (no picture, no image address kept). One
   *  California file: the network's sites sit in Southern California (live: 32.6-38.5 N). Keyless.
   *  A site outside the padded California box is junk and is never published. */
  Object.freeze({
    id: 'hpwren',
    layer: 'linkCameras',
    source: HPWREN_SITES_URL,
    officialUrl: 'https://www.hpwren.ucsd.edu/cameras/',
    async fetch({ fetchImpl = fetch } = {}) {
      let res;
      try { res = await fetchImpl(HPWREN_SITES_URL); } catch (err) { return { ok: false, reason: `fetch-error: ${err && err.message ? err.message : err}` }; }
      if (!res.ok) return { ok: false, reason: `fetch-error: HPWREN answered ${res.status}` };
      let text;
      try { text = await res.text(); } catch (err) { return { ok: false, reason: `fetch-error: HPWREN body unreadable (${err.message})` }; }
      const sites = parseHpwrenSites(text);
      if (!sites) return { ok: false, reason: 'fetch-error: HPWREN sites.js was not a site list' };
      return { ok: true, payload: { sites } };
    },
    regions(payload, { fetchedAt } = {}) {
      const records = normalizeHpwrenSites(payload.sites, { fetchedAt }).filter((r) => inAnyStateBox(r.lat, r.lon, ['ca']));
      return [{ region: 'hpwren-ca', regionName: 'California (HPWREN)', records }];
    },
  }),
  /** AlertWest: one pin per non-California US camera, link-only. One file per state (a state is a
   *  few KB; one national file would make every viewer download every camera). The image object of
   *  each row is never read. A CloudFront 403 is an ordinary fetch failure: the files stay. */
  Object.freeze({
    id: 'alertwest',
    layer: 'linkCameras',
    source: ALERTWEST_URL,
    officialUrl: 'https://alertwest.live/',
    async fetch({ fetchImpl = fetch } = {}) {
      const got = await fetchJson(ALERTWEST_URL, { fetchImpl, label: 'AlertWest' });
      if (!got.ok) return got;
      if (!Array.isArray(got.payload)) return { ok: false, reason: 'fetch-error: AlertWest answered something that is not a camera list' };
      return got;
    },
    regions(payload, { fetchedAt } = {}) {
      const byState = new Map();
      const stateOf = new Map((Array.isArray(payload) ? payload : []).filter((row) => row && row.site)
        .map((row) => [row.site.id == null ? row.name : `${row.site.id}:${row.name}`, alertWestStateOf(row)]));
      for (const r of normalizeAlertWestCameras(payload, { fetchedAt })) {
        const state = stateOf.get(r.providerId);
        if (!state || !inAnyStateBox(r.lat, r.lon, [state])) continue; // a pin must sit in its own state
        if (!byState.has(state)) byState.set(state, []);
        byState.get(state).push(r);
      }
      return [...byState].sort(([x], [y]) => (x < y ? -1 : 1)).map(([state, records]) => ({
        region: `alertwest-${state}`, regionName: `${STATE_NAMES[state]} (AlertWest)`, records }));
    },
  }),
  /** MoDOT, Maryland CHART, DelDOT, NMRoads and NJTA: link-only, one file per state, keyless.
   *  Each is a plain GET of the owner's own list with the build's honest user agent and nothing else
   *  on the request; a failure or an answer that is not the list leaves the old file alone. */
  ...LINK_ROAD_LAYERS.map((layer) => Object.freeze({
    id: layer.id,
    layer: 'linkCameras',
    source: layer.sourceUrl,
    officialUrl: layer.officialUrl,
    async fetch({ fetchImpl = fetch, seedOnly = false } = {}) {
      // A deploy build keeps the committed seed; only --refresh-seeds asks the owner.
      if (seedOnly) return { ok: false, reason: 'seed-only: refreshed under --refresh-seeds, so the committed seed stays' };
      const init = { method: 'GET', headers: { 'User-Agent': ARCGIS_USER_AGENT } };
      let rows;
      if (layer.format === 'text') {
        let res;
        try { res = await fetchImpl(layer.sourceUrl, init); } catch (err) { return { ok: false, reason: `fetch-error: ${err && err.message ? err.message : err}` }; }
        if (!res.ok) return { ok: false, reason: `fetch-error: ${layer.operator} answered ${res.status}` };
        try { rows = layer.parse(await res.text()); } catch (err) { return { ok: false, reason: `fetch-error: ${layer.operator} body unreadable (${err.message})` }; }
      } else {
        const got = await fetchJson(layer.sourceUrl, { fetchImpl, label: layer.operator, init });
        if (!got.ok) return got;
        rows = layer.parse(got.payload);
      }
      if (!rows) return { ok: false, reason: `fetch-error: ${layer.operator} answered something that is not a camera list` };
      return { ok: true, payload: { rows } };
    },
    /** One file for the owner's state. A pin outside it (a swapped coordinate, a pin at sea) is junk. */
    regions(payload, { fetchedAt } = {}) {
      const records = normalizeLinkRoadCameras(payload.rows, layer, { fetchedAt })
        .filter((r) => inAnyStateBox(r.lat, r.lon, [layer.state]));
      return [{ region: `${layer.id}-${layer.state}`, regionName: `${STATE_NAMES[layer.state]} (${layer.label})`, records }];
    },
  })),
  ...ARCGIS_LAYERS.map((layer) => Object.freeze({
    id: layer.id,
    layer: 'roadCameras',
    source: layer.serviceUrl,
    officialUrl: layer.officialUrl,
    async fetch({ fetchImpl = fetch, sleep, seedOnly = false } = {}) {
      // A deploy build keeps the committed, already gated seeds (the HEAD gate is refresh-only).
      if (seedOnly) return { ok: false, reason: 'seed-only: stills are checked only by --refresh-seeds, so the committed seed stays' };
      const got = await fetchArcgisPages(layer, { fetchImpl, sleep });
      if (!got.ok) return got;
      const gated = await gateArcgisStills(got.payload, layer, { fetchImpl, sleep });
      return { ok: true, payload: { ...gated.payload, stillCounts: gated.counts } };
    },
    /** One file per state the layer covers. A position outside that state's unpadded box (a pin in
     *  the ocean, a swapped coordinate, a border camera of the next state) is junk and is never published. */
    regions(payload, { fetchedAt } = {}) {
      const records = normalizeArcgisCameras(payload, layer, { fetchedAt });
      return layer.states.map((state) => ({
        region: `${layer.id}-${state}`,
        regionName: `${STATE_NAMES[state]} (${layer.label})`,
        records: records.filter((r) => inAnyStateBox(r.lat, r.lon, [state], 0)),
      }));
    },
  })),
  ...CARS_FEEDS.map((feed) => Object.freeze({
    id: feed.id,
    layer: 'roadCameras',
    source: feed.listUrl,
    officialUrl: feed.officialUrl,
    async fetch({ fetchImpl = fetch, sleep, checkStills = false, now = Date.now } = {}) {
      // Seed-only: a normal build never fetches these lists, so what the site serves is always the
      // still-checked seed; only `--refresh-seeds` fetches and checks.
      if (!checkStills) return { ok: false, reason: 'seed-only: refreshed under --refresh-seeds' };
      const got = feed.kind === 'srtmc' ? await fetchSrtmcMap(feed, { fetchImpl }) : await fetchCarsList(feed, { fetchImpl });
      if (!got.ok) return got;
      const at = new Date(now()).toISOString();
      const records = normalize(feed, got.payload.raw, at);
      const checked = await checkCarsStillsDetailed(records, { fetchImpl, sleep, now: now() });
      return { ok: true, payload: { ...got.payload, dead: checked.dead, stillCounts: checked.counts } };
    },
    /** One file per state the feed covers; a position outside that state is junk and never published. */
    regions(payload, { fetchedAt } = {}) {
      const dead = new Set(payload.dead || []);
      const records = normalize(feed, payload.raw, fetchedAt).filter((r) => !dead.has(r.providerId));
      return feed.states.map((state) => ({
        region: `${feed.id}-${state}`,
        regionName: `${STATE_NAMES[state]} (${feed.label})`,
        records: (CARS_RECORD_FILTERS[feed.id] || ((all) => all))(records.filter((r) => inAnyStateBox(r.lat, r.lon, [state]))),
      }));
    },
  })),
  ...ITERIS_LAYERS.map((layer) => Object.freeze({
    id: layer.id,
    layer: 'roadCameras',
    source: layer.listUrls[0],
    officialUrl: layer.officialUrl,
    async fetch({ fetchImpl = fetch, sleep, seedOnly = false } = {}) {
      // A deploy build keeps the committed seed; only --refresh-seeds asks the operator.
      if (seedOnly) return { ok: false, reason: 'seed-only: refreshed under --refresh-seeds, so the committed seed stays' };
      return fetchIterisLists(layer, { fetchImpl, sleep });
    },
    regions(payload, { fetchedAt } = {}) {
      return stateRegions(layer, normalizeIterisCameras(payload, layer, { fetchedAt }));
    },
  })),
  ...SOCRATA_LAYERS.map((layer) => Object.freeze({
    id: layer.id,
    layer: 'roadCameras',
    source: layer.resourceUrl,
    officialUrl: layer.officialUrl,
    async fetch({ fetchImpl = fetch, sleep, seedOnly = false } = {}) {
      // A deploy build keeps the committed seed; only --refresh-seeds asks the operator.
      if (seedOnly) return { ok: false, reason: 'seed-only: refreshed under --refresh-seeds, so the committed seed stays' };
      return fetchSocrataPages(layer, { fetchImpl, sleep });
    },
    regions(payload, { fetchedAt } = {}) {
      return stateRegions(layer, normalizeSocrataCameras(payload, layer, { fetchedAt }));
    },
  })),
  /** PhenoCam Network: one request for the whole list (limit=2000; the list held 1084 sites on
   *  2026-10-04). A list that says it is longer than what came back fails the provider. Keeps active,
   *  recent sites inside the US; the site's contact fields are never read (source-camera.js). */
  Object.freeze({
    id: 'phenocam',
    layer: 'phenoCameras',
    source: 'https://phenocam.nau.edu/api/cameras/',
    officialUrl: PHENOCAM_HOME,
    async fetch({ fetchImpl = fetch, seedOnly = false } = {}) {
      // A deploy build keeps the committed seed; only --refresh-seeds asks the owner.
      if (seedOnly) return { ok: false, reason: 'seed-only: refreshed under --refresh-seeds, so the committed seed stays' };
      const got = await fetchJson(PHENOCAM_URL, { fetchImpl, label: 'PhenoCam' });
      if (!got.ok) return got;
      const body = got.payload;
      const rows = body && Array.isArray(body.results) ? body.results : null;
      if (!rows) return { ok: false, reason: 'fetch-error: PhenoCam answered something that is not the camera list' };
      if ((body.next !== null && body.next !== undefined) || (Number.isFinite(Number(body.count)) && Number(body.count) > rows.length)) {
        return { ok: false, reason: `fetch-error: PhenoCam paging incomplete (${rows.length} of ${body.count} sites)` };
      }
      return { ok: true, payload: body };
    },
    regions(payload, { fetchedAt } = {}) {
      const nameOf = new Map((payload.results || []).map((s) => [s && s.Sitename, s && s.sitemetadata && s.sitemetadata.site_description]));
      return usRegion(normalizePhenocam(payload, { fetchedAt }).filter((r) => r.lat !== null && r.lon !== null
        && inUnitedStates(r.lat, r.lon) && !FOREIGN_NAME.test(nameOf.get(r.providerId) || '')));
    },
  }),
  /** AviationWX: one request for the airport list (the API allows 50 a minute and 2000 a day, so
   *  no image is ever requested at build time). One pin per webcam. */
  Object.freeze({
    id: 'aviationwx',
    layer: 'airportCameras',
    source: AVIATIONWX_URL,
    officialUrl: AVIATIONWX_HOME,
    async fetch({ fetchImpl = fetch, seedOnly = false } = {}) {
      // A deploy build keeps the committed seed; only --refresh-seeds asks the owner.
      if (seedOnly) return { ok: false, reason: 'seed-only: refreshed under --refresh-seeds, so the committed seed stays' };
      const got = await fetchJson(AVIATIONWX_URL, { fetchImpl, label: 'AviationWX' });
      if (!got.ok) return got;
      if (!got.payload || got.payload.success !== true || !Array.isArray(got.payload.airports)) {
        return { ok: false, reason: 'fetch-error: AviationWX did not answer success with an airport list' };
      }
      return got;
    },
    regions(payload, { fetchedAt } = {}) {
      // A Canadian (C...) or Mexican (MM...) ICAO code is foreign even when its position sits in a rough US box.
      const foreign = new Set((payload.airports || []).filter((a) => a && typeof a.icao === 'string' && FOREIGN_ICAO.test(a.icao)).map((a) => a.id));
      return usRegion(normalizeAviationwx(payload, { fetchedAt })
        .filter((r) => inUnitedStates(r.lat, r.lon) && !foreign.has(r.providerId.split(':')[0])));
    },
  }),
  /** WSDOT ferry terminal cameras: one GET of the ferry map's list; only the pictures under /wsf/ are the
   *  terminals' own (WSDOT's road cameras in the same list are left to a road feed). Stills are HEAD-checked
   *  under --refresh-seeds only, four at a time, a pause between batches. */
  Object.freeze({
    id: WSF_LAYER.id,
    layer: 'roadCameras',
    source: WSF_LAYER.listUrls[0],
    officialUrl: WSF_LAYER.officialUrl,
    async fetch({ fetchImpl = fetch, sleep, seedOnly = false, now = Date.now } = {}) {
      // A deploy build keeps the committed seed; only --refresh-seeds asks the operator.
      if (seedOnly) return { ok: false, reason: 'seed-only: refreshed under --refresh-seeds, so the committed seed stays' };
      const got = await fetchWsfCameras(WSF_LAYER, { fetchImpl });
      if (!got.ok) return got;
      const at = new Date(now()).toISOString();
      const dead = await checkCarsStills(normalizeIterisCameras(got.payload, WSF_LAYER, { fetchedAt: at }), { fetchImpl, sleep, now: now() });
      return { ok: true, payload: { ...got.payload, dead } };
    },
    regions(payload, { fetchedAt } = {}) {
      const dead = new Set(payload.dead || []);
      return stateRegions(WSF_LAYER, normalizeIterisCameras(payload, WSF_LAYER, { fetchedAt }).filter((r) => !dead.has(r.providerId)));
    },
  }),
  {
    id: 'volcview',
    layer: 'phenoCameras',
    source: VOLCVIEW_URL,
    officialUrl: VOLCVIEW_HOME,
    async fetch({ fetchImpl = fetch, sleep = defaultSleep, checkStills = false, now = Date.now } = {}) {
      // Seed-only: a normal build never contacts USGS or AVO; only --refresh-seeds does.
      if (!checkStills) return { ok: false, reason: 'seed-only: refreshed under --refresh-seeds, so the committed seed stays' };
      return fetchVolcview({ fetchImpl, sleep, now });
    },
    regions(payload, { fetchedAt } = {}) {
      const dead = new Set(payload.dead || []);
      const kept = normalizeVolcview(payload, { fetchedAt })
        .filter((r) => !dead.has(r.providerId) && inVolcviewCoverage(r.lat, r.lon));
      // Cameras east of the dateline (lon > 0) get their own files, the western Aleutians apart from Guam and
      // the Marianas, so no file's box runs from -177 to 179 and the index never claims the whole Pacific.
      const aleutian = (r) => r.lat >= VOLCVIEW_EXTRA_BOXES[0][0] && r.lat <= VOLCVIEW_EXTRA_BOXES[0][1];
      const byId = (rows) => [...rows].sort((x, y) => (x.providerId < y.providerId ? -1 : 1));
      return [...usRegion(kept.filter((r) => r.lon <= 0)), ...[
        ['ak-west', 'West of the dateline (western Aleutians)', kept.filter((r) => r.lon > 0 && aleutian(r))],
        ['gu-mp', 'Guam and the Northern Mariana Islands', kept.filter((r) => r.lon > 0 && !aleutian(r))],
      ].filter(([, , rows]) => rows.length).map(([region, regionName, rows]) => ({ region, regionName, records: byId(rows) }))];
    },
  },
  {
    id: 'glerl',
    layer: 'phenoCameras',
    source: GLERL_PAGE_URL,
    officialUrl: GLERL_HOME,
    async fetch({ fetchImpl = fetch, sleep = defaultSleep, checkStills = false, now = Date.now } = {}) {
      if (!checkStills) return { ok: false, reason: 'seed-only: refreshed under --refresh-seeds, so the committed seed stays' };
      return fetchGlerl({ fetchImpl, sleep, now });
    },
    regions(payload, { fetchedAt } = {}) {
      const dead = new Set(payload.dead || []);
      return usRegion(normalizeGlerl(payload, { fetchedAt }).filter((r) => !dead.has(r.providerId)));
    },
  },
]);

// --- USGS VolcView + AVO and NOAA GLERL (seed-only; see the PROVIDERS rows above) -----------------
// Plain GET and HEAD with the build's own User-Agent only: no browser agent, Origin or Referer. A
// host that refuses it (403) drops that picture, and a provider with nothing left is not published.
// NDBC buoy cameras are not here: their image host answers 403 to this agent.

// US territory for volcano cameras: the 50 states and DC (inUnitedStates), Alaska west of the dateline
// (the Aleutians, lon 172 to 180) and the territories (PR, VI, GU, AS, MP), as the unit spec counts them.
const VOLCVIEW_EXTRA_BOXES = Object.freeze([[51.0, 53.6, 172.0, 180.0], ...['pr', 'vi', 'gu', 'as', 'mp'].map((c) => STATE_BBOX[c])]);
// The rough Alaska box spills into British Columbia and Yukon (east of -141) and the rough Washington
// box into British Columbia (north of 49.0) and onto southern Vancouver Island; those corners are not
// US territory. East of -141 a point in the Alaska box stays only inside the panhandle polygon below,
// and everything south of the polygon (Prince Rupert, Haida Gwaii) is Canada.
//
// Sources, read 2026-10-09 (public geography, nothing invented):
//  - Point A, Cape Muzon: USGS GNIS feature 1420865, 54.6678 N 132.6889 W. Point B, the south end of
//    the Portland Channel boundary: International Boundary Commission digital boundary v1.3 (NAD83),
//    54.7074 N 130.6156 W. The straight A-B line is the Dixon Entrance line of the 1903 Alaska
//    Boundary Tribunal award (about 54 40 N); Canada reads it as the maritime boundary, the US as
//    only dividing the land. This filter treats it as the cut-off: a camera south of it is not US.
//  - The Portland Channel vertices between B and the 56th parallel, and the Juan de Fuca / Haro Strait
//    / Boundary Pass chain below, are vertices of the same IBC shapefile, thinned to about 500 m.
//  - The north and west edges are the older rough hull, unchanged.
const PANHANDLE_BORDER = [[-141, 60.3], [-135.5, 59.8], [-133.4, 58.9], [-130.0, 56.1], [-130.0, 55.3],
  [-130.1752, 55.0979], [-130.3369, 54.9248], [-130.5803, 54.7903], [-130.6156, 54.7074], [-132.6889, 54.6678], [-141, 54.6678]];
// Canada west of the Juan de Fuca / Haro Strait / Boundary Pass line (IBC v1.3) and north of it, up to 49.05
// (the 49.0 to 49.4 band is the other clause of inCanadianCorner). Victoria, Saanich, Sidney, Duncan and
// the Gulf Islands sit inside the rough Washington box (lat up to 49.1, lon from -124.9).
const SW_BC_BORDER = [[-124.9, 48.4934], [-124.7272, 48.4934], [-124.0121, 48.2967], [-123.6791, 48.24], [-123.5412, 48.2246],
  [-123.2484, 48.284], [-123.1151, 48.4228], [-123.1599, 48.4535], [-123.2189, 48.5487], [-123.2679, 48.694],
  [-123.0085, 48.7671], [-123.0085, 48.8312], [-123.3222, 49.0021], [-123.3222, 49.05], [-124.9, 49.05]];
function insidePolygon(poly, lat, lon) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const insidePanhandle = (lat, lon) => insidePolygon(PANHANDLE_BORDER, lat, lon);
const inCanadianCorner = (lat, lon) => (lon > -141 && lon <= -129.9 && lat <= 71.5 && !insidePanhandle(lat, lon))
  || (lat > 49.0 && lat <= 49.4 && lon >= -124.9 && lon <= -117.0)
  || insidePolygon(SW_BC_BORDER, lat, lon);
function inVolcviewCoverage(lat, lon) {
  if (inCanadianCorner(lat, lon)) return false;
  return inUnitedStates(lat, lon) || VOLCVIEW_EXTRA_BOXES.some((b) => lat >= b[0] && lat <= b[1] && lon >= b[2] && lon <= b[3]);
}
async function fetchVolcview({ fetchImpl, sleep, now }) {
  const lists = {};
  for (const [key, url, label] of [['volcview', VOLCVIEW_URL, 'USGS VolcView'], ['avo', AVO_URL, 'the AVO ashcam API']]) {
    if (key === 'avo') await sleep(ARCGIS_PAUSE_MS);
    const got = await fetchJson(url, { fetchImpl, label, init: PLAIN_GET });
    if (!got.ok) return got;
    if (!got.payload || !Array.isArray(got.payload.webcams)) return { ok: false, reason: `fetch-error: ${label} did not answer a webcam list` };
    lists[key] = got.payload;
  }
  const records = normalizeVolcview(lists, { fetchedAt: new Date(now()).toISOString() })
    .filter((r) => inVolcviewCoverage(r.lat, r.lon));
  return { ok: true, payload: { ...lists, dead: await checkCarsStills(records, { fetchImpl, sleep, now: now() }) } };
}

async function fetchGlerl({ fetchImpl, sleep, now }) {
  let res;
  try { res = await fetchImpl(GLERL_PAGE_URL, PLAIN_GET); } catch (err) {
    return { ok: false, reason: `fetch-error: ${err && err.message ? err.message : err}` };
  }
  if (!res.ok) return { ok: false, reason: `fetch-error: NOAA GLERL answered ${res.status}` };
  let metdataHtml;
  try { metdataHtml = await res.text(); } catch (err) { return { ok: false, reason: `fetch-error: ${err.message}` }; }
  const records = normalizeGlerl({ metdataHtml }, { fetchedAt: new Date(now()).toISOString() });
  if (records.length === 0) return { ok: false, reason: 'fetch-error: NOAA GLERL page held no camera table' };
  return { ok: true, payload: { metdataHtml, dead: await checkCarsStills(records, { fetchImpl, sleep, now: now() }) } };
}

/** Wraps a fetch so each URL is requested once and every caller gets the parsed body: one run can
 *  feed the legacy `--out` file and the `--out-dir` files from a single upstream request. A failed
 *  response is not cached (the second caller asks again). */
export function memoFetch(fetchImpl = fetch) {
  const cache = new Map();
  return async (url, init) => {
    // A HEAD (or any non-GET) is a probe, not a body: never cached, never parsed.
    if (init && init.method && init.method !== 'GET') return fetchImpl(url, init);
    // A script (HPWREN's sites.js) or a page (NJTA) is read as text by its own provider, never parsed as JSON here.
    if (/\.js(\?|$)/.test(url) || LINK_TEXT_URLS.has(url)) return fetchImpl(url, init);
    if (cache.has(url)) return cache.get(url);
    const res = await fetchImpl(url, init);
    if (!res.ok) return res;
    const payload = await res.json();
    const memo = { ok: true, status: res.status, json: async () => payload };
    cache.set(url, memo);
    return memo;
  };
}

const minify = (value) => JSON.stringify(value);
const byteLength = (text) => Buffer.byteLength(text, 'utf8');

function bboxOf(records) {
  let box = null;
  for (const r of records) {
    if (r.lat === null || r.lon === null) continue;
    box = box
      ? { minLon: Math.min(box.minLon, r.lon), minLat: Math.min(box.minLat, r.lat),
        maxLon: Math.max(box.maxLon, r.lon), maxLat: Math.max(box.maxLat, r.lat) }
      : { minLon: r.lon, minLat: r.lat, maxLon: r.lon, maxLat: r.lat };
  }
  return box;
}

/** Splits a record list into grid cells of GRID_DEGREES. Located records go to the cell holding
 *  them; records with no position share one `unlocated` cell. Returns `[{ cell, records }]`. */
function gridCells(records) {
  const cells = new Map();
  for (const r of records) {
    const cell = r.lat === null || r.lon === null
      ? 'unlocated'
      : `${Math.floor(r.lat / GRID_DEGREES) * GRID_DEGREES}_${Math.floor(r.lon / GRID_DEGREES) * GRID_DEGREES}`;
    if (!cells.has(cell)) cells.set(cell, []);
    cells.get(cell).push(r);
  }
  return [...cells].sort(([x], [y]) => (x < y ? -1 : 1)).map(([cell, list]) => ({ cell, records: list }));
}

function headerFor(provider, region, records, generatedAt) {
  const first = records[0];
  return {
    provider: provider.id, layer: provider.layer, region: region.region, regionName: region.regionName,
    generatedAt, source: provider.source || null, operator: first.operator,
    officialUrl: provider.officialUrl || null, attribution: first.attribution,
    rights: first.rights, category: first.category,
  };
}

/** Every valid snapshot file already under `outDir` (one directory deep), as
 *  `{ file, size, json, parsed }`. A file that is unreadable or is not a well-formed snapshot is
 *  left out of the index, never deleted. */
function readExisting(outDir) {
  const found = [];
  if (!existsSync(outDir)) return found;
  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const f of readdirSync(join(outDir, entry.name), { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith('.json')) continue;
      const file = `${entry.name}/${f.name}`;
      try {
        const json = readFileSync(join(outDir, file), 'utf8');
        const parsed = JSON.parse(json);
        if (snapshotProblems(parsed).length === 0) found.push({ file, size: byteLength(json), json, parsed });
      } catch { /* unreadable or not JSON: not ours to index */ }
    }
  }
  return found.sort((x, y) => (x.file < y.file ? -1 : 1));
}

/** A file whose stills have all expired by `nowMs` is still listed (every camera in it keeps its pin
 *  and link); the row also says `stale: true`. The key is absent otherwise, so a file with no expiry
 *  indexes exactly as it did under schema 1. */
function indexRow(file, parsed, nowMs) {
  const records = parsed.rows.map((row) => ({ lat: row[parsed.fields.indexOf('lat')], lon: row[parsed.fields.indexOf('lon')] }));
  const row = { file, provider: parsed.provider, layer: parsed.layer, region: parsed.region,
    regionName: parsed.regionName, bbox: bboxOf(records), count: parsed.rows.length,
    generatedAt: parsed.generatedAt };
  if (snapshotStale(parsed, nowMs)) row.stale = true;
  return row;
}

const indexJson = (rows) => minify({ schema: 1, files: rows });

/** Plans one provider's files: `[{ file, json, parsed }]`, or `{ reason }` when it has nothing to
 *  publish. A region over the file budget splits by grid; a cell still over budget is an
 *  over-budget failure (this provider only). Throws on an id that is not a plain slug. */
function planProvider(provider, payload, { generatedAt, budgets }) {
  const regions = provider.regions(payload, { fetchedAt: generatedAt }) || [];
  const files = [];
  for (const region of regions) {
    if (!SLUG.test(region.region || '')) throw new Error(`build-camera-snapshot: region id ${JSON.stringify(region.region)} must be a plain slug`);
    const records = region.records || [];
    if (records.length === 0) continue; // a region that went empty keeps its existing file
    const whole = compactSnapshot(records, headerFor(provider, region, records, generatedAt));
    const wholeJson = minify(whole);
    const parts = byteLength(wholeJson) <= budgets.fileBytes
      ? [{ name: `${region.region}.json`, records, file: whole, json: wholeJson }]
      : gridCells(records).map(({ cell, records: cellRecords }) => {
        const file = compactSnapshot(cellRecords, headerFor(provider, region, cellRecords, generatedAt));
        return { name: `${region.region}.${cell}.json`, records: cellRecords, file, json: minify(file) };
      });
    for (const part of parts) {
      if (byteLength(part.json) > budgets.fileBytes) {
        return { reason: `over-budget: ${provider.id}/${part.name} is ${byteLength(part.json)} bytes after splitting, the file budget is ${budgets.fileBytes}` };
      }
      files.push({ file: `${provider.id}/${part.name}`, region: region.region, json: part.json, parsed: part.file });
    }
  }
  if (files.length === 0) return { reason: 'zero-records: normalized to 0 cameras, refusing to publish an empty catalogue' };
  return { files };
}

/** One provider's row in the refresh log: counts and reasons only (no camera ids, no urls).
 *  `status` is 'written', 'kept-last-good' (the provider failed or was refused and the committed
 *  files stay), 'zero-records' (it answered but nothing survived) or 'all-blocked' (every checked
 *  picture answered 401, 403 or 429: the host is refusing us, which is not the same as the
 *  pictures being gone). The count fields are null for a provider that ran no still check. */
function refreshRow(r) {
  const c = r.stills || null;
  const allBlocked = Boolean(c && c.checked > 0 && c.blocked === c.checked);
  const status = allBlocked ? 'all-blocked' : r.written ? 'written'
    : /^zero-records/.test(r.reason || '') ? 'zero-records' : 'kept-last-good';
  const reason = allBlocked
    ? `every checked still (${c.checked} of ${c.checked}) answered 401/403/429, the host is refusing the check; ${r.reason}`
    : r.reason;
  const n = (k) => (c ? c[k] : null);
  return { id: r.id, status, reason, written: Boolean(r.written), checked: n('checked'), kept: n('kept'),
    droppedBlocked: n('droppedBlocked'), droppedGone: n('droppedGone'), droppedOther: n('droppedOther'), blocked: n('blocked') };
}

export function refreshReport(results, generatedAt) {
  return { schema: 1, generatedAt, providers: results.map(refreshRow) };
}

/** The one stdout line a refresh prints for a report row. */
export function formatRefreshLine(row) {
  const counts = row.checked === null
    ? 'no still check'
    : `kept ${row.kept}, dropped-blocked ${row.droppedBlocked}, dropped-gone ${row.droppedGone}, dropped-other ${row.droppedOther}`;
  return `refresh-log ${row.id}: ${row.status} -- ${counts} (${row.reason})`;
}

/** Builds `outDir`: for each provider in `providers`, fetch, normalize, and write its region files;
 *  then rebuild `index.json` from every valid file on disk. Returns
 *  `{ providers: [{ id, written, reason, files }], index }`. Never throws for an upstream failure.
 *  Throws (before writing anything) only for a key in an output or an unsafe id. */
export async function buildSnapshotDir({
  outDir, env = process.env, fetchImpl = fetch, providers = PROVIDERS, budgets = BUDGETS, sleep, seedOnly = false, checkStills = false,
  now = () => new Date().toISOString(), reportPath = null,
} = {}) {
  if (!outDir) throw new Error('build-camera-snapshot: buildSnapshotDir requires `outDir`.');
  const generatedAt = now();
  const generatedMs = Date.parse(generatedAt);
  // Every key in the table, not just this provider's: a provider's data must never carry another's.
  const keys = providers.map((p) => p.keyEnv && env[p.keyEnv]).filter(Boolean);

  const results = [];
  const planned = [];
  for (const provider of providers) {
    if (!SLUG.test(provider.id || '')) throw new Error(`build-camera-snapshot: provider id ${JSON.stringify(provider.id)} must be a plain slug`);
    // The build's own clock, not the wall clock: a CARS view's age and the still check are judged
    // against it, so a refresh (and a test with a fixed `now`) gets one answer however late it runs.
    const got = await provider.fetch({ env, fetchImpl, sleep, seedOnly, checkStills, now: () => Date.parse(now()) });
    if (!got.ok) { results.push({ id: provider.id, written: false, reason: got.reason, files: [], stills: null }); continue; }
    const stills = got.payload && got.payload.stillCounts ? got.payload.stillCounts : null;
    const plan = planProvider(provider, got.payload, { generatedAt, budgets });
    if (plan.reason) { results.push({ id: provider.id, written: false, reason: plan.reason, files: [], stills }); continue; }

    // Upstream gate on the budgets, before this provider's first write: what the directory would
    // hold if this provider's files replaced its own earlier files for the same regions.
    const replacing = new Set(plan.files.map((f) => f.region));
    const kept = readExisting(outDir).filter((e) => !(e.parsed.provider === provider.id && replacing.has(e.parsed.region))
      && !planned.some((p) => p.file === e.file));
    const all = [...kept.map((e) => ({ file: e.file, size: e.size, parsed: e.parsed })),
      ...planned.map((p) => ({ file: p.file, size: byteLength(p.json), parsed: p.parsed })),
      ...plan.files.map((f) => ({ file: f.file, size: byteLength(f.json), parsed: f.parsed }))];
    const indexBytes = byteLength(indexJson(all.map((e) => indexRow(e.file, e.parsed, generatedMs))));
    const dirBytes = indexBytes + all.reduce((n, e) => n + e.size, 0);
    if (indexBytes > budgets.indexBytes || dirBytes > budgets.dirBytes) {
      results.push({ id: provider.id, written: false, files: [], stills,
        reason: `over-budget: ${provider.id} would make index.json ${indexBytes} bytes (budget ${budgets.indexBytes}) and the directory ${dirBytes} bytes (budget ${budgets.dirBytes})` });
      continue;
    }
    planned.push(...plan.files.map((f) => ({ ...f, provider: provider.id })));
    results.push({ id: provider.id, written: true, reason: 'ok', files: plan.files.map((f) => f.file), warnings: got.warnings || [], stills });
  }

  // Key gate over everything the run is about to write, index included -- before the first write.
  const existingAfter = (() => {
    const replaced = new Set(planned.map((p) => `${p.provider}\0${p.region}`));
    return readExisting(outDir).filter((e) => !replaced.has(`${e.parsed.provider}\0${e.parsed.region}`));
  })();
  const finalRows = [
    ...existingAfter.map((e) => indexRow(e.file, e.parsed, generatedMs)),
    ...planned.map((p) => indexRow(p.file, p.parsed, generatedMs)),
  ].sort((x, y) => (x.file < y.file ? -1 : 1));
  const index = indexJson(finalRows);
  // The refresh log exists only for a refresh: a seed-only build asked nobody anything, so it has
  // nothing to report and writes nothing.
  const report = reportPath && checkStills && !seedOnly ? refreshReport(results, generatedAt) : null;
  const reportJson = report ? `${JSON.stringify(report, null, 2)}\n` : null;
  for (const { file, json } of [...planned, { file: 'index.json', json: index }, ...(reportJson ? [{ file: 'refresh report', json: reportJson }] : [])]) {
    if (keys.some((key) => json.includes(key))) {
      throw new Error(`build-camera-snapshot: refusing to write -- an API key appears in ${file}.`);
    }
  }
  if (reportJson) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, reportJson);
  }
  if (planned.length === 0) return { providers: results, index: null, report };

  const stale = readExisting(outDir).filter((e) => planned.some((p) => p.provider === e.parsed.provider
    && p.region === e.parsed.region) && !planned.some((p) => p.file === e.file));
  for (const p of planned) {
    mkdirSync(dirname(join(outDir, p.file)), { recursive: true });
    writeFileSync(join(outDir, p.file), p.json);
  }
  // A region that no longer splits (or splits differently) must not leave its old cells behind.
  for (const e of stale) rmSync(join(outDir, e.file), { force: true });
  writeFileSync(join(outDir, 'index.json'), index);
  return { providers: results, index: finalRows, report };
}

// ---------------------------------------------------------------------------------------------
// CLI.

const SEED_DIR = fileURLToPath(new URL('../../static/data/quiet-corners-maps/cameras', import.meta.url));
/** Where `--refresh-seeds` writes its refresh log: under `.data/`, which .gitignore already covers,
 *  so it is a build artifact that is never committed. Overwritten by each refresh. */
export const REFRESH_REPORT_PATH = fileURLToPath(new URL('../../.data/qcm-camera-refresh-report.json', import.meta.url));

export function parseArgs(argv) {
  const value = (flag) => {
    const i = argv.indexOf(flag);
    if (i === -1) return undefined;
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`build-camera-snapshot: ${flag} needs a value.`);
    return argv[i + 1];
  };
  const out = value('--out');
  // `--refresh-seeds` is the same build pointed at the committed seeds (needs the real keys).
  const outDir = argv.includes('--refresh-seeds') ? SEED_DIR : value('--out-dir');
  if (!out && !outDir) throw new Error('build-camera-snapshot: --out <path> and/or --out-dir <dir> (or --refresh-seeds) is required.');
  // `--only a,b` runs just those provider ids (a seed refresh for one operator).
  const only = value('--only');
  const ids = only ? only.split(',').map((x) => x.trim()).filter(Boolean) : null;
  const unknown = ids ? ids.filter((id) => !PROVIDERS.some((p) => p.id === id)) : [];
  if (unknown.length) throw new Error(`build-camera-snapshot: --only names no provider: ${unknown.join(', ')}.`);
  const refreshSeeds = argv.includes('--refresh-seeds');
  return { out, outDir, only: ids, refreshSeeds, reportPath: refreshSeeds ? REFRESH_REPORT_PATH : null };
}

async function main() {
  const { out, outDir, only, refreshSeeds, reportPath } = parseArgs(process.argv.slice(2));
  const fetchImpl = memoFetch(fetch);
  if (out) {
    const result = await writeSnapshotOrKeepExisting({
      out, apiKey: process.env.NPS_API_KEY, fetchImpl,
      alsoGuard: PROVIDERS.map((p) => p.keyEnv && process.env[p.keyEnv]).filter(Boolean),
    });
    if (result.written) console.log(`wrote ${result.cameraCount} camera(s) to ${out}`);
    else console.log(`kept the existing snapshot at ${out} untouched -- ${result.reason}`);
  }
  if (outDir) {
    const result = await buildSnapshotDir({
      outDir, env: process.env, fetchImpl, seedOnly: !refreshSeeds, checkStills: refreshSeeds, reportPath, providers: only ? PROVIDERS.filter((p) => only.includes(p.id)) : PROVIDERS });
    for (const p of result.providers) {
      if (p.written) {
        console.log(`${p.id}: wrote ${p.files.length} file(s) under ${outDir}`);
        for (const w of p.warnings || []) console.log(`${p.id}: kept the existing file for ${w}`);
      } else console.log(`${p.id}: kept the existing files under ${outDir} untouched -- ${p.reason}`);
    }
    if (result.report) {
      for (const row of result.report.providers) console.log(formatRefreshLine(row));
      console.log(`refresh log written to ${reportPath}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
