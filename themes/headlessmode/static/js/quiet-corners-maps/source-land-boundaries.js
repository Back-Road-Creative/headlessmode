// State public-land boundaries: game lands, state parks and other managed areas,
// read per state from the measured catalogue in state-sources.json.
//
// Drawn as BOUNDARIES, never as fill. A filled area would be a new kind through
// the protocol, the worker, the preview and the legend; a polygon ring is already
// the shape overlay-paths.js consumes (an array of [lon, lat] points), so a ring
// handed over as `paths` rides the pipeline that exists. That is also how paper
// topographic maps draw a designation: a distinctive line with the name inside,
// not a wash of colour over the contours.
//
// A boundary says where a designation begins and ends. It does NOT say the ground
// inside is open to you, and it does not say the ground outside is closed. Access
// is the managing agency's to state, not this map's to infer.
//
// Every state publishes its own service, with its own field names and its own
// idea of what a "game land" is. Nothing here is hardcoded per state: the URL,
// the layer id, the safe field list and the WHERE clause all come from the
// catalogue, which was measured against the live services.
import { layerFor, whereFor, outFieldsFor, isBrowserFetchable, isSemanticallyUniform, isDrawable } from './state-sources.js';
import { pageThrough, PAGE_CAP } from './arcgis-pager.js';
import { DEFAULT_SOURCE_TIMEOUT_MS } from './source-registry.js';
// The notice a drawn boundary obliges lives with the symbols it attaches to.
export { LAND_COVERAGE_SEMANTICS } from './legend.js';

/** Which legend symbol each family draws with. One per family, not one for "state
 *  land": a game land and a state park answer to different agencies under
 *  different rules, and merging them would tell the reader less than the source
 *  knows. */
// `parcels` is deliberately NOT keyed `land-`. The three above are public land and
// share the `land-` notice about access; a parcel is mostly PRIVATE property, and
// attaching "not a statement that the ground inside is open" to it would be answering
// a question nobody asked while leaving the real one -- this is a record, not a survey,
// and not permission -- unsaid. Its own key, its own notice. See legend.js NOTICES.
export const FAMILY_SYMBOL = Object.freeze({
  gameLands: 'land-game',
  stateParks: 'land-park',
  managedAreas: 'land-managed',
  parcels: 'parcel-line',
});

export const FAMILY_LABEL = Object.freeze({
  gameLands: 'State game lands',
  stateParks: 'State parks and forests',
  managedAreas: 'Other state-managed areas',
  parcels: 'Parcel boundaries',
});

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** The /query endpoint for a catalogue entry.
 *
 *  The catalogue is not uniform here and cannot be: North Carolina's url already
 *  ends in `/FeatureServer/21` (and repeats 21 as layerId), while Arizona's ends
 *  in `/FeatureServer` with layerId 0. Appending the id unconditionally would ask
 *  NC for layer 21 of layer 21. */
export function queryUrl(layer) {
  if (!layer || !layer.url) return null;
  const base = layer.url.replace(/\/+$/, '');
  const endsWithLayerId = /\/\d+$/.test(base);
  const withLayer = endsWithLayerId ? base : `${base}/${layer.layerId ?? 0}`;
  return `${withLayer}/query`;
}

/** True when this state's entry can be drawn: reachable from the browser AND the
 *  same kind of thing the family name claims. Arizona's game lands are hunt units
 *  covering the whole state, so drawing them as a land boundary would put a line
 *  on paper that means nothing on the ground. */
export function isUsable(layer) {
  return isDrawable(layer);
}

/** Normalize whatever a caller holds -- one code, several, or nothing -- into a
 *  list of state codes. There is one map now rather than one page per state, so
 *  the states come from the AREA the reader drew, and an area straddling a line
 *  legitimately has two. */
export function stateList(states) {
  if (!states) return [];
  const list = Array.isArray(states) ? states : [states];
  return [...new Set(list.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))].sort();
}

/** The families these states can actually draw, in a stable order. A family
 *  counts as usable when ANY of the states publishes it: a box crossing from
 *  North Carolina into Georgia should offer what either of them has, and the
 *  fetch then simply returns nothing from the one that does not. */
export function usableFamilies(states, families = Object.keys(FAMILY_SYMBOL)) {
  const codes = stateList(states);
  return families.filter((f) => codes.some((code) => isUsable(layerFor(code, f))));
}

/** Which of `states` publish `family` in a form this map can read. */
export function statesWithFamily(states, family) {
  return stateList(states).filter((code) => isUsable(layerFor(code, family)));
}

/** Pick a display name out of whatever this state chose to call the field. The
 *  catalogue's `fields` map is per state, so there is no single right key. */
export function nameOf(attributes = {}, layer = null) {
  const named = ['name', 'propertyName', 'unitName', 'areaName', 'label'];
  for (const key of named) {
    const field = layer && layer.fields && layer.fields[key];
    if (field && str(attributes[field])) return str(attributes[field]);
  }
  return null;
}

/** One ArcGIS polygon -> the shape overlay-paths.js already consumes.
 *  `rings` become `paths`: a ring is a closed polyline, and stroking it is
 *  exactly what a boundary is. */
export function normalizeBoundary(raw, family, layer = null) {
  const a = raw.attributes || {};
  const rings = (raw.geometry?.rings || []).filter((r) => Array.isArray(r) && r.length >= 2);
  return {
    id: str(a.OBJECTID) || str(a.objectid) || null,
    name: nameOf(a, layer),
    layer: family,
    symbolKey: FAMILY_SYMBOL[family] || null,
    // outSR=4326 is requested, so rings arrive as [lon, lat] — the order
    // overlay-paths.js expects. The swap to [lat, lon] belongs to the preview.
    paths: rings,
  };
}

const skip = (reason) => ({ features: [], skipped: reason, coverage: 'unavailable', pages: 0, retrievedAt: null });

/** One family's boundaries for one state, intersecting a lon/lat box.
 *
 *  Returns `{ features: [], skipped: <reason> }` rather than throwing when the
 *  state has nothing usable: a state without a readable service is an ordinary
 *  fact about the catalogue, not a failure of the request.
 *
 *  PAGED, because a single query returns one page and says so in
 *  `exceededTransferLimit`. Reading only the first page is how a boundary goes
 *  missing from paper with nothing said: the catalogue records 15 usable parcel
 *  services whose own measured bbox returns more than one page (Delaware 26,863
 *  against a 2,000 cap), and any family can exceed it on a large enough
 *  rectangle. `coverage` is 'complete' only when the service stopped flagging
 *  more; anything else is 'partial', which canBuild refuses to print. */
export async function fetchLandBoundaries({ state, family, bboxLonLat, fetchImpl = fetch, signal, pageSize = PAGE_CAP } = {}) {
  const layer = layerFor(state, family);
  if (!layer) return skip(`no ${family} record for ${state}`);
  if (!isBrowserFetchable(layer)) return skip(`${family} for ${state} is not readable from a browser`);
  if (!isSemanticallyUniform(layer)) return skip(`${family} for ${state} is a different kind of area`);

  const { minLon, minLat, maxLon, maxLat } = bboxLonLat;
  const outFields = outFieldsFor(layer);
  const page = await pageThrough({
    url: queryUrl(layer),
    label: `${FAMILY_LABEL[family] || family} (${state})`,
    params: {
      geometry: `${minLon},${minLat},${maxLon},${maxLat}`,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      // Several states publish their wildlife areas inside a general public-lands
      // layer; without this clause the sheet fills with land it would mislabel.
      // Vermont answers 93 features where exactly one is a WMA.
      where: whereFor(layer),
      outFields: outFields.length ? outFields.join(',') : 'OBJECTID',
      returnGeometry: 'true',
    },
    normalize: (one) => {
      const f = normalizeBoundary(one, family, layer);
      return f.paths.length ? f : null;
    },
    fetchImpl,
    signal,
    timeoutMs: DEFAULT_SOURCE_TIMEOUT_MS,
    pageSize: Math.min(pageSize, layer.maxRecordCount || PAGE_CAP),
  });
  return { ...page, skipped: null };
}


