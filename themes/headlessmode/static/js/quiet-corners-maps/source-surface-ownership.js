// National Forest System surface ownership, from the USFS land-status service.
//
// The federal layer draws a PROCLAMATION boundary, and a proclamation boundary
// encloses private inholdings that were never federal. This layer answers the
// question that line leaves open -- is the ground under my feet Forest Service
// land -- parcel by parcel, from the Forest Service's own Land Status Record
// System. Bureau of Land Management, PAD-US and the BLM SMA are a separate
// dataset and a separate decision; this is Forest Service ground only.
//
// apps.fs.usda.gov is already a CSP-allowed origin (MVUM, recreation sites).
// MEASURED 2026-09-10 over the Standing Indian rectangle: 81 parcels, 77 owned
// by the Forest Service and 4 `NON-FS` (status `Disposed`), CORS reflects the
// origin, maxRecordCount 2000, pagination supported.
//
// `casename` IS A PERSON. Over that rectangle it reads "SLAGLE, C. W.", "CRUSE,
// E. G.", "PARKER, W. B." -- the people the ground was bought from. It is never
// requested, nor is `comments`, nor the tax fields. What is asked for is the
// record id, the owner class, the record status and the forest's name.
import { pageThrough, PAGE_CAP } from './arcgis-pager.js';

export const SERVICE = 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_SurfaceOwnership_01/MapServer';
export const LAYER_NUMBER = 0;
export const QUERY_URL = `${SERVICE}/${LAYER_NUMBER}/query`;
export const LAYER_ID = 'surfaceOwnership';
export const SYMBOL_NFS = 'own-nfs';
export const SYMBOL_OTHER = 'own-other';
export const OUT_FIELDS = Object.freeze(['surfaceownershipid', 'ownerclassification', 'status', 'nfslandunitname']);

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** The class the service uses for its own ground. Anything else -- `NON-FS`, a
 *  blank, a class nobody has seen -- draws as not-Forest-Service: a disposed
 *  parcel is somebody else's now, and the public-land blue would say otherwise. */
const FOREST_SERVICE = 'USDA FOREST SERVICE';

/** One ArcGIS polygon -> the shape overlay-paths.js consumes. Rings become `paths`:
 *  a ring is a closed polyline, and stroking it is what a boundary is. */
export function normalizeOwnership(raw) {
  const a = raw.attributes || {};
  const rings = (raw.geometry?.rings || []).filter((r) => Array.isArray(r) && r.length >= 2);
  return {
    id: str(a.surfaceownershipid) || str(a.objectid) || str(a.OBJECTID) || null,
    // The forest, not the case: it is what the preview tooltip can honestly say.
    name: str(a.nfslandunitname) || null,
    // The TOGGLE id -- `on[f.layer]` is what the preview and the sheet both test.
    layer: LAYER_ID,
    symbolKey: str(a.ownerclassification).toUpperCase() === FOREST_SERVICE ? SYMBOL_NFS : SYMBOL_OTHER,
    // outSR=4326 is requested, so rings arrive [lon, lat] as overlay-paths expects.
    paths: rings,
  };
}

/** Ownership parcels intersecting a lon/lat box, paged like every other layer. */
export async function fetchSurfaceOwnership({ bboxLonLat, fetchImpl = fetch, signal, pageSize = PAGE_CAP } = {}) {
  const { minLon, minLat, maxLon, maxLat } = bboxLonLat;
  const page = await pageThrough({
    url: QUERY_URL,
    label: 'Surface ownership',
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
      const f = normalizeOwnership(one);
      return f.paths.length ? f : null;
    },
    fetchImpl,
    signal,
    pageSize,
  });
  return { ...page, skipped: null };
}
