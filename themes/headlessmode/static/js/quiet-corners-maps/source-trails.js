// Non-motorized trails from The National Map's transportation service.
//
// MVUM is MOTOR VEHICLE data by definition, so a trail that bans vehicles is
// definitionally absent from it. Every foot trail around Standing Indian --
// including the Appalachian Trail -- printed as blank ground before this.
//
// carto.nationalmap.gov is already a CSP-allowed origin (it serves the quad
// index), and this layer answers with `Access-Control-Allow-Origin: *`.
//
// Measured 2026-09-06 over the Standing Indian quad: 63 segments, every one
// carrying `sourceoriginator: "U.S. Forest Service"` -- so this is the USFS trail
// inventory, republished. 7 are `NST - Appalachian`. 6 of the 63 carry NO
// allowed-use flags at all, which is the case the honesty rule below exists for.
import { pageThrough, PAGE_CAP } from './arcgis-pager.js';

const SERVICE = 'https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/37';
const USE_FIELDS = { hike: 'hikerpedestrian', bike: 'bicycle', horse: 'packsaddle', motor: 'motorcycle' };
const FIELDS = ['permanentidentifier', 'name', 'trailnumber', 'trailtype', 'nationaltraildesignation',
  'lengthmiles', ...Object.values(USE_FIELDS)];

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** Allowed uses as the source states them. `null` means the source said NOTHING —
 *  which is not the same as "no", and must never be printed as a prohibition. */
export function allowedUses(a) {
  const stated = Object.entries(USE_FIELDS).filter(([, f]) => str(a[f]).toUpperCase() === 'Y').map(([use]) => use);
  const anyFieldPresent = Object.values(USE_FIELDS).some((f) => str(a[f]) !== '');
  return anyFieldPresent ? stated : null;
}

/** A short code for the sheet: 'HB' for hike+bike. null when nothing was stated. */
export function useCode(uses) {
  if (uses === null) return null;
  const letter = { hike: 'H', bike: 'B', horse: 'E', motor: 'M' };   // E for equestrian; M is rare here
  return uses.map((u) => letter[u]).join('') || null;
}

/** Which symbol a trail draws with. A National Scenic Trail is drawn more
 *  prominently, as every Forest Service map does. A trail whose uses the source
 *  did not state takes the DOTTED symbol — the same meaning "dot" already carries
 *  for MVUM season: the source did not say, so check locally. */
export function symbolKeyForTrail({ designation, uses }) {
  if (designation) return 'trail-nst';
  return uses === null ? 'trail-nonmotor-unstated' : 'trail-nonmotor';
}

/** One ArcGIS feature -> the shape overlay-paths.js already consumes. */
export function normalizeTrail(raw) {
  const a = raw.attributes || {};
  const uses = allowedUses(a);
  const designation = str(a.nationaltraildesignation) || null;
  return {
    id: str(a.permanentidentifier) || str(a.trailnumber) || null,
    name: str(a.name) || null,
    number: str(a.trailnumber) || null,
    layer: 'trail-nonmotor',
    designation,
    uses,
    useCode: useCode(uses),
    lengthMiles: Number.isFinite(a.lengthmiles) ? a.lengthmiles : null,
    symbolKey: symbolKeyForTrail({ designation, uses }),
    // outSR=4326 is requested, so paths already arrive as [lon, lat] — the order
    // overlay-paths.js expects. No swap here; the swap belongs to the preview.
    paths: (raw.geometry?.paths || []).filter((p) => Array.isArray(p) && p.length >= 2),
  };
}

/** Trails intersecting a lon/lat box, normalized.
 *
 *  PAGED, through the one loop every other layer here uses. A single /query answers
 *  one page and says so in `exceededTransferLimit`; this adapter read only the first
 *  one and its caller reported that as the whole answer, so a rectangle past the
 *  transfer limit printed a sheet missing trails with nothing said (audit F14).
 *  `coverage` is 'complete' only when the service stopped flagging more — the same
 *  word, meaning the same thing, as the recreation-site and land adapters return. */
export async function fetchTrails({ bboxLonLat, fetchImpl = fetch, signal, pageSize = PAGE_CAP } = {}) {
  const { minLon, minLat, maxLon, maxLat } = bboxLonLat;
  const page = await pageThrough({
    url: `${SERVICE}/query`,
    label: 'Trails',
    params: {
      geometry: `${minLon},${minLat},${maxLon},${maxLat}`,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: FIELDS.join(','),
      returnGeometry: 'true',
    },
    // A trail with no drawable geometry is dropped here rather than by
    // normalizeTrail, which stays a pure shape-for-shape translation.
    normalize: (raw) => { const t = normalizeTrail(raw); return t.paths.length ? t : null; },
    fetchImpl,
    signal,
    pageSize,
  });
  return {
    ...page,
    // How many trails the source told us nothing about. The page reports this
    // rather than letting silence read as "no bikes allowed".
    usesUnstated: page.features.filter((f) => f.uses === null).length,
  };
}

export const TRAILS_SOURCE = Object.freeze({
  id: 'nationalMapTrails',
  name: 'Trails (The National Map)',
  origin: new URL(SERVICE).origin,
  serviceUrl: SERVICE,
  attribution: 'USGS The National Map: National Transportation Dataset; U.S. Census Bureau TIGER/Line; U.S. Forest Service',
  coverageSemantics: 'Allowed uses are shown only where the source states them. A blank field is '
    + 'silence, not a prohibition: where nothing was stated the trail is drawn dotted and no use '
    + 'letters are printed. Confirm access and current closures with the managing agency before travel.',
});
