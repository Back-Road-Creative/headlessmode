// Federal land designations, from the USGS govunits service on the National Map.
//
// One service for the whole country, unlike the state layers: same origin, same
// field names, same geometry everywhere, so there is no catalogue to consult and
// nothing to measure per state. The origin is `carto.nationalmap.gov`, which the
// map's CSP already allows for the topographic base.
//
// Drawn as BOUNDARIES, in the same blue as state land, with a long-dash-dot
// pattern of their own. Colour says what a thing IS and pattern says how it is
// administered, so federal designations reading as "public land, differently
// governed" is the honest arrangement — and it adds no new colour class to a
// sheet that has to stay legible in grayscale.
//
// A boundary says where a designation begins and ends. It does NOT say the ground
// inside is open to you, and it does not say the ground outside is closed. That
// caveat is on the map key already (LAND_COVERAGE_SEMANTICS) and it covers these
// lines too — a National Forest proclamation boundary in particular encloses
// private inholdings that were never federal.
import { pageThrough, PAGE_CAP } from './arcgis-pager.js';
import { SOURCES } from './source-registry.js';

export const SERVICE = 'https://carto.nationalmap.gov/arcgis/rest/services/govunits/MapServer';

/** MEASURED 2026-09-07 against the live service, each verified by name over a real
 *  rectangle: Nantahala National Forest and Southern Nantahala Wilderness in the
 *  Standing Indian fixture, Mount Rainier National Park, Okefenokee National
 *  Wildlife Refuge. Every one answers with `access-control-allow-origin: *`.
 *
 *  BLM (layer 36) IS DELIBERATELY ABSENT. Its polygons are Field Offices —
 *  administrative jurisdictions, not holdings. `Moab Field Office` is 2,907 square
 *  miles, most of which is not BLM land, so drawing it as a land boundary would
 *  tell a reader the opposite of the truth over an area the size of Delaware.
 *  That is the failure the access notice exists to prevent, and no notice fixes a
 *  line that is simply in the wrong place. Federal surface ownership is a
 *  different dataset (PAD-US / SMA) and a separate decision. */
export const FAMILIES = Object.freeze({
  nationalPark: Object.freeze({ layerId: 29, label: 'National Park System unit', symbol: 'fed-park' }),
  nationalForest: Object.freeze({ layerId: 31, label: 'National Forest', symbol: 'fed-forest' }),
  wilderness: Object.freeze({ layerId: 32, label: 'Designated Wilderness', symbol: 'fed-wilderness' }),
  wildlifeRefuge: Object.freeze({ layerId: 35, label: 'National Wildlife Refuge', symbol: 'fed-refuge' }),
});

export const FAMILY_IDS = Object.freeze(Object.keys(FAMILIES));

/** The single layer-registry toggle all four families answer to. */
export const LAYER_ID = 'federalLand';

/** Boundaries only. `name` is what prints; nothing here identifies a person, and
 *  no field on this service does either — it is a federal unit register. */
export const OUT_FIELDS = Object.freeze(['name', 'areasqkm']);

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

export function queryUrl(family) {
  const f = FAMILIES[family];
  return f ? `${SERVICE}/${f.layerId}/query` : null;
}

/** One ArcGIS polygon -> the shape overlay-paths.js already consumes. Rings become
 *  `paths`: a ring is a closed polyline, and stroking it is what a boundary is. */
export function normalizeFederal(raw, family) {
  const a = raw.attributes || {};
  const rings = (raw.geometry?.rings || []).filter((r) => Array.isArray(r) && r.length >= 2);
  return {
    id: str(a.permanent_identifier) || str(a.OBJECTID) || str(a.objectid) || null,
    name: str(a.name) || null,
    // The TOGGLE id, not the family. Downstream, `layer` is what the preview and
    // the sheet test a checkbox against (`on[f.layer]`), and these four families
    // share one control; the family survives in `symbolKey`, which is what decides
    // the ink. Setting the family here would make every federal boundary print and
    // none of them preview -- the exact parity break the map already fixed once.
    layer: LAYER_ID,
    symbolKey: FAMILIES[family]?.symbol || null,
    // outSR=4326 is requested, so rings arrive as [lon, lat] — the order
    // overlay-paths.js expects. The swap to [lat, lon] belongs to the preview.
    paths: rings,
  };
}

/** One family's boundaries intersecting a lon/lat box.
 *
 *  A named unit arrives as SEVERAL records, not one: Nantahala National Forest
 *  answers eight, a 5,344 km² main body plus multi-ring records down to 0.11 km².
 *  They are all real boundary geometry and all are drawn — the sheet's own
 *  rectangle decides what is relevant, and dropping a sliver by area would be this
 *  map inventing a cartographic judgment the source did not make. Dedupe is by
 *  `permanent_identifier`, which is per record and not per name. */
export async function fetchFederalLand({ family, bboxLonLat, fetchImpl = fetch, signal, pageSize = PAGE_CAP } = {}) {
  const spec = FAMILIES[family];
  if (!spec) return { features: [], skipped: `no federal family ${family}`, coverage: 'unavailable', pages: 0, retrievedAt: null };

  const { minLon, minLat, maxLon, maxLat } = bboxLonLat;
  const page = await pageThrough({
    url: queryUrl(family),
    label: spec.label,
    params: {
      geometry: `${minLon},${minLat},${maxLon},${maxLat}`,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      where: '1=1',
      outFields: OUT_FIELDS.join(','),
      returnGeometry: 'true',
    },
    normalize: (one) => {
      const f = normalizeFederal(one, family);
      return f.paths.length ? f : null;
    },
    fetchImpl,
    signal,
    timeoutMs: SOURCES.usgsGovUnits.timeoutMs,
    pageSize,
  });
  return { ...page, skipped: null };
}
