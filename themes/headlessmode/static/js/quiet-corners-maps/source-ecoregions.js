// EPA Level III ecoregions (Omernik), read from a committed export rather than a service.
//
// WHY THE EXPORT AND NOT THE LIVE SERVICE. Measured 2026-09-14 against
// gispub.epa.gov: the national geometry request is REFUSED ungeneralized — HTTP 500 with a
// `text/html` body, so `response.json()` throws rather than returning an empty result — and
// answers only when `maxAllowableOffset` is present. A live route would carry that
// parameter forever and break the day someone dropped it. Baking the generalization into a
// committed artifact removes the failure mode instead of guarding it. Nothing is lost by
// it: the data has not moved since December 2011, so there is no freshness to gain, and the
// export is 949,718 bytes raw / 263,584 gzipped against 4.5 MB for Level IV.
//
// AND IT SPENDS NO CSP. `cspDirectivesFor` puts every SOURCES origin into connect-src and
// has no offline concept, so an entry there would cost 15 characters the browser never
// uses. The artifact is served from this site, which the policy's own 'self' already
// covers. The provenance that an entry would have carried is here instead, beside the code
// that reads it — SOURCE_QUERY_URL is a record, never a fetch.
//
// RIGHTS. EPA's own Terms of Use for Geospatial Data: "Unless otherwise specified,
// geospatial data produced by the EPA is by default in the public domain and is not subject
// to domestic copyright protection under 17 U.S.C. § 105." Redistributing this artifact
// from our own hosting is what that sentence permits; TERMS_URL is the page it is on.

export const LAYER_ID = 'epaEcoregions';
/** Same-origin, so no host reaches the policy. Fetched once, when a reader asks. */
export const EXPORT_URL = '/data/quiet-corners/ecoregions-l3.json';
export const LEVEL = 'Level III';
/** The service publishes ONE vintage, in its own layer names, and no date on a record. */
export const VINTAGE = 'December 2011';
export const CREDIT = 'Map service: US EPA Office of Environmental Information (OEI). '
  + 'Data: US EPA Office of Research and Development (ORD)';
export const TERMS_URL = 'https://www.epa.gov/web-policies-and-procedures/epa-disclaimers';
export const PRODUCT_URL = 'https://www.epa.gov/eco-research/level-iii-and-iv-ecoregions-continental-united-states';
/** Provenance for the committed file: the query that produced it, byte for byte. Recorded,
 *  never called — scripts/qcm/gen-ecoregions.mjs is what runs it, offline, by hand. */
export const SOURCE_QUERY_URL = 'https://gispub.epa.gov/arcgis/rest/services/ORD/USEPA_Ecoregions_Level_III_and_IV/MapServer/11/query';
export const GENERALIZED_DEGREES = 0.01;
export const FEATURE_COUNT = 85;
export const EXPORT_BYTES = 949718;
export const MEASURED_ON = '2026-09-14';

/** The export, reduced to what a lookup needs: the names, and the rings with a bounding box
 *  in front of them so 85 regions are not each walked for every point. */
export function readExport(geojson) {
  const features = (geojson && Array.isArray(geojson.features)) ? geojson.features : [];
  return features.map((f) => {
    const p = f.properties || {};
    const polygons = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const poly of polygons) {
      for (const [lon, lat] of poly[0]) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
    return Object.freeze({
      code: String(p.US_L3CODE), name: p.US_L3NAME,
      level2: p.NA_L2NAME, level1: p.NA_L1NAME,
      polygons, bbox: Object.freeze({ minLon, minLat, maxLon, maxLat }),
    });
  });
}

/** Ray casting over one ring, in lon/lat. A vertex exactly on the ray is the classic
 *  double-count, which the strict-then-loose comparison on the latitudes avoids. */
function inRing(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside the outer ring and outside every hole. A GeoJSON polygon's first ring is its
 *  outline and the rest are holes; treating them all as outlines puts a reader in a region
 *  that was cut out from under them. */
function inPolygon(poly, lon, lat) {
  if (!inRing(poly[0], lon, lat)) return false;
  for (let i = 1; i < poly.length; i += 1) if (inRing(poly[i], lon, lat)) return false;
  return true;
}

/** The ONE region a point is in, or null. Never a list: 60 probed points returned at most
 *  one region each, because ecoregions are a partition rather than an inventory — which is
 *  why nothing here can double-count, and why the first match is the answer. */
export function regionAt(regions, lat, lon) {
  if (!Array.isArray(regions) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  for (const r of regions) {
    const b = r.bbox;
    if (lon < b.minLon || lon > b.maxLon || lat < b.minLat || lat > b.maxLat) continue;
    if (r.polygons.some((poly) => inPolygon(poly, lon, lat))) return r;
  }
  return null;
}

/** The region in words, with the families it sits inside, because "Northern Lakes and
 *  Forests" means little on its own. The Level I and II names are the publisher's own
 *  spelling, capitals included: this app does not restyle a label it did not write. */
export function placeText(region) {
  return `${LEVEL} ecoregion ${region.code}: ${region.name} — part of ${region.level2}, `
    + `within ${region.level1}.`;
}

/** Zero features came back for Alaska and for the offshore Atlantic alike. Both are this
 *  map stopping, and neither is a statement that the ground has no ecosystem. */
export function outsideText() {
  return 'This landscape classification covers the conterminous states only, and the place you '
    + 'drew is outside it. That is where the map stops, not a statement about the ground.';
}

/** The row this layer owns. Every sentence carries the vintage: a reader meeting a confident
 *  regional name has no way to guess the lines were last drawn in 2011. */
export function areaReport(regions, point) {
  const region = point ? regionAt(regions, point.lat, point.lon) : null;
  if (!region) return { known: false, region: null, text: outsideText() };
  return { known: true, region,
    text: `${placeText(region)} A classification of the landscape compiled by EPA analysts and `
      + `frozen at ${VINTAGE}, from geology, landforms, vegetation, climate, soils, land use, `
      + 'wildlife and hydrology together. It describes the region, not the parcel.' };
}

/** One national file, fetched when a reader asks and held. A pan is not a new question when
 *  the answer is the whole country. Never throws the map. */
export async function loadEcoregions({ fetchImpl = fetch, url = EXPORT_URL, signal } = {}) {
  try {
    const res = await fetchImpl(url, { signal });
    if (!res.ok) return null;
    return readExport(await res.json());
  } catch (e) { return null; }
}

/** Every string this source can put in front of a reader, in one place, for the test. */
export function readerStrings(regions, point) {
  const report = areaReport(regions, point);
  const region = report.region;
  return [CREDIT, LAYER_LABEL, LAYER_CAVEAT, outsideText(), report.text,
    ...(region ? [placeText(region)] : [])];
}

export const LAYER_LABEL = 'What kind of country this is (EPA ecoregions)';
export const LAYER_CAVEAT = 'Expert-drawn regions of broad ecological similarity — the name for the '
  + `kind of country you are in, and the family it belongs to. Compiled at 1:250,000, frozen at `
  + `${VINTAGE}, and generalized further for the copy this site serves, so a boundary is `
  + 'approximate by roughly a kilometre. It is a classification of the landscape rather than a '
  + 'reading of it, and it says nothing about any particular acre. Conterminous states only: '
  + 'outside them the row says the map stops rather than that the ground has no character.';
