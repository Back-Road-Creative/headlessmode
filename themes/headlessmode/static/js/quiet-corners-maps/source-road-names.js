// Road names from The National Map transportation service (registry id `usgsRoadNames`).
// The zoom bands, labels and grouping are road-names.js; this file only asks and classifies
// the answer. Nothing here draws.
//
// An answer is one of four statuses, and the difference between them is the point:
//   ok       every layer asked answered in full
//   partial  something is missing and we know it: a layer hit its page limit
//            (`exceededTransferLimit`), or one layer failed while another answered
//   error    nothing usable came back: a non-2xx, a thrown fetch, or an ArcGIS `{"error"}`
//            body inside a 200 (serviceError, arcgis-view.js). NEVER reported as empty --
//            a silent failure must not read as "there are no roads here"
//   empty    every layer answered and had nothing (also: below zoom 10, with no request made)
// A call replaced by a newer one, or aborted by its caller, reports `stale` and no entries;
// the caller ignores it (the same convention source-hillshade.js uses).
import { SOURCES } from './source-registry.js';
import { serviceError, envelope } from './arcgis-view.js';
import { layersForZoom, groupRoads, roadLabelOrder, ROAD_CLASSES } from './road-names.js';

const SRC = SOURCES.usgsRoadNames;
const FIELDS = SRC.layers[0].fields;

/** What the publisher's own label layer (19) excludes. Copied so a name it has retired is
 *  never requested, let alone shown. */
export const ROAD_QUERY_PUBLISHER_FILTER = "name NOT LIKE '%Squaw%' AND name NOT LIKE '%SQUAW%'";

/** Results kept in memory, oldest dropped first. */
export const ROAD_CACHE_LIMIT = 32;

function checkBbox(b) {
  const vals = [b?.minLon, b?.minLat, b?.maxLon, b?.maxLat];
  if (vals.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new RangeError('bbox must carry finite minLon/minLat/maxLon/maxLat numbers.');
  }
}

/** The /query URL for one layer over a lon/lat box. Longest segments first, so the 200-row page
 *  keeps the roads worth lettering. Throws RangeError for a layer the zoom has not reached
 *  (when `zoom` is given), a layer that is not a road class, or a malformed box. */
export function buildRoadQuery({ layer, bbox, zoom } = {}) {
  checkBbox(bbox);
  const allowed = zoom === undefined ? ROAD_CLASSES.map((c) => c.layer) : layersForZoom(zoom);
  if (!allowed.includes(layer)) throw new RangeError(`road layer ${layer} is not drawn at zoom ${zoom}.`);
  const params = new URLSearchParams({
    where: `name IS NOT NULL AND ${ROAD_QUERY_PUBLISHER_FILTER}`,
    geometry: envelope(bbox),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: FIELDS.join(','),
    returnGeometry: 'true',
    geometryPrecision: '5',
    orderByFields: 'Shape_Length DESC',
    resultRecordCount: '200',
    f: 'json',
  });
  return `${SRC.serviceUrl}/${layer}/query?${params}`;
}

const round = (n) => n.toFixed(3);
const cacheKey = (b, zoom) => `${round(b.minLon)},${round(b.minLat)},${round(b.maxLon)},${round(b.maxLat)}@${zoom}`;

/** One layer's answer: {features, exceeded} or {failed}. Never throws, except to say aborted. */
async function askLayer({ layer, bbox, zoom, fetchImpl, signal }) {
  try {
    const res = await fetchImpl(buildRoadQuery({ layer, bbox, zoom }), { signal });
    if (!res.ok) return { failed: `HTTP ${res.status}` };
    const body = await res.json();
    const refused = serviceError(body);
    if (refused) return { failed: refused };
    if (!Array.isArray(body?.features)) return { failed: 'the service answered without a feature list.' };
    return { features: body.features.map((f) => ({ ...f, layer })), exceeded: body.exceededTransferLimit === true };
  } catch (err) {
    return signal.aborted ? { aborted: true } : { failed: err?.message || String(err) };
  }
}

/** A fetcher with its own in-flight slot and cache. The module's `fetchRoadNames` is one shared
 *  instance; tests and a second map each make their own. */
export function createRoadNamesFetcher() {
  let live = null;
  const cache = new Map();

  async function fetchRoadNames({ bbox, zoom, fetchImpl = fetch, signal } = {}) {
    // Latest wins: whatever was in flight is about a view the reader has left.
    if (live) live.abort();
    const attribution = SRC.attribution;
    const layers = layersForZoom(zoom);
    if (!layers.length) { live = null; return { status: 'empty', entries: [], attribution }; }
    checkBbox(bbox);

    const key = cacheKey(bbox, zoom);
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key); cache.set(key, hit);   // most recently used goes last
      live = null;
      return { ...hit, entries: [...hit.entries] };
    }

    const controller = new AbortController();
    live = controller;
    const onAbort = () => controller.abort();
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort); }
    try {
      const answers = await Promise.all(layers.map((layer) => askLayer({ layer, bbox, zoom, fetchImpl, signal: controller.signal })));
      if (controller.signal.aborted) return { status: 'stale', entries: [], attribution };
      const failed = answers.filter((a) => a.failed).length;
      const exceeded = answers.some((a) => a.exceeded);
      const entries = roadLabelOrder(groupRoads(answers.flatMap((a) => a.features || [])));
      let status;
      if (failed) status = entries.length ? 'partial' : 'error';
      else if (exceeded) status = 'partial';
      else status = entries.length ? 'ok' : 'empty';
      const result = { status, entries, attribution };
      if (!failed) {
        cache.set(key, result);
        while (cache.size > ROAD_CACHE_LIMIT) cache.delete(cache.keys().next().value);
      }
      return { ...result, entries: [...entries] };
    } finally {
      if (live === controller) live = null;
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  return { fetchRoadNames };
}

const shared = createRoadNamesFetcher();
export const fetchRoadNames = (args) => shared.fetchRoadNames(args);
