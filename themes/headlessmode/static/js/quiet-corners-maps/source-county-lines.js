// County boundaries, from the USGS govunits service on the National Map (layer 23).
//
// WHY A SERVICE AND NOT THE FILE WE ALREADY SHIP. The site serves
// `static/data/quiet-corners/counties-10m.json` same-origin for the county finder,
// and reusing it here would have cost nothing. It was MEASURED against this service
// for Macon County, NC and it is not fit for a true-scale sheet: 28 vertices against
// 6,604, and the coarse outline sits a median of 254 m from the real line, 859 m at
// the 90th percentile and 2,376 m at worst. On a 1:24,000 Letter sheet that is 0.42
// inches typical and 3.9 inches at worst, on a sheet 8.5 inches wide.
//
// A line most of an inch from where the boundary is does not answer the question a
// county line is on the map to answer -- which side of it you are standing on, and
// therefore whose rules apply. It is the same failure as drawing a BLM Field Office
// as a holding: confidently in the wrong place. The 10m file stays where it belongs,
// choosing counties on an index map at 1:5,000,000, where 250 m is a third of a pixel.
//
// The service costs the CSP nothing -- `carto.nationalmap.gov` is already allowed for
// the topographic base and the federal designations.
//
// A county line is a JURISDICTION, not a landholding, so it takes no part in the land
// palette: black like the grid and USGS's own administrative lines, with a dash-dot-dot
// of its own. It also obliges no access notice -- it makes no claim about who may be
// on the ground, only about which county records that ground.
import { pageThrough, PAGE_CAP } from './arcgis-pager.js';
import { SERVICE } from './source-federal-land.js';

export const LAYER_ID = 'countyLines';
export const LAYER_NUMBER = 23;
export const QUERY_URL = `${SERVICE}/${LAYER_NUMBER}/query`;
export const SYMBOL = 'county-line';

/** MEASURED 2026-09-08 against the live service: Macon and Clay Counties, North
 *  Carolina answer over the Standing Indian rectangle, sourced from the 2025
 *  TIGER/Line county file. There is NO `name` field on this layer -- asking for one
 *  returns "Failed to execute query" rather than an empty column, which is how the
 *  first attempt here failed. `gnis_name` carries "Macon County"; `county_name`
 *  carries "Macon". None of these fields identifies a person: it is a register of
 *  civil divisions, and `population` (a count, not a person) is not requested. */
export const OUT_FIELDS = Object.freeze(['gnis_name', 'county_name', 'state_name', 'permanent_identifier']);

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** One ArcGIS polygon -> the shape overlay-paths.js consumes. Rings become `paths`:
 *  a ring is a closed polyline, and stroking it is what a boundary is. */
export function normalizeCounty(raw) {
  const a = raw.attributes || {};
  const rings = (raw.geometry?.rings || []).filter((r) => Array.isArray(r) && r.length >= 2);
  const county = str(a.gnis_name) || str(a.county_name);
  const state = str(a.state_name);
  return {
    id: str(a.permanent_identifier) || str(a.objectid) || str(a.OBJECTID) || null,
    // Qualified by state on purpose: a sheet can straddle a state line, and there
    // are 31 Washington Counties for one label to be ambiguous between.
    name: county && state ? `${county}, ${state}` : county || null,
    // The TOGGLE id, never a family -- `on[f.layer]` is what the preview and the
    // sheet both test, and a mismatch here is the parity break the map fixed once.
    layer: LAYER_ID,
    symbolKey: SYMBOL,
    // outSR=4326 is requested, so rings arrive [lon, lat] as overlay-paths expects.
    paths: rings,
  };
}

/** County boundaries intersecting a lon/lat box. */
export async function fetchCountyLines({ bboxLonLat, fetchImpl = fetch, signal, pageSize = PAGE_CAP } = {}) {
  const { minLon, minLat, maxLon, maxLat } = bboxLonLat;
  const page = await pageThrough({
    url: QUERY_URL,
    label: 'County or Equivalent',
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
      const f = normalizeCounty(one);
      return f.paths.length ? f : null;
    },
    fetchImpl,
    signal,
    pageSize,
  });
  return { ...page, skipped: null };
}
