// USFS National Forest System Roads: maintenance level and surface type, which
// MVUM does not carry. MVUM answers "may I drive this?"; this answers "can my
// vehicle actually do this?" -- the question an off-road user asks first.
//
// An ENRICHMENT, not a layer: two facts joined onto roads the app already draws,
// keyed on route id. Measured 2026-09-06 over the Standing Indian quad: 30 of 31
// MVUM roads matched (97%), levels 2-5 and four surface types present. An
// unmatched road keeps its plain width -- drawn, never dropped.
import { SOURCES } from './source-registry.js';
import { pageThrough, PAGE_CAP } from './arcgis-pager.js';

const SERVICE = 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RoadBasic_01/MapServer/0';
// Lowercase, deliberately: ArcGIS silently OMITS an outField it does not
// recognise rather than erroring, so `OPER_MAINT_LEVEL` would return nothing at
// all and every road would quietly fall back to its default width.
const FIELDS = ['id', 'oper_maint_level', 'surface_type'];

const lower = (t) => t.charAt(0).toLowerCase() + t.slice(1);
const sentence = (t) => t.charAt(0).toUpperCase() + t.slice(1);
/** The prose the service put after its code, sentence-cased; null when there is none.
 *  ALL CAPS is how the service writes it ('3 - SUITABLE FOR PASSENGER CARS'), and a
 *  shouted phrase in a tooltip reads as an error message. */
function prose(value, codePrefix) {
  const text = String(value ?? '').trim();
  if (!codePrefix.test(text)) return null;
  const rest = text.replace(codePrefix, '').trim();
  return rest ? sentence(rest.toLowerCase()) : null;
}

/** Maintenance level 1-5 from the service's own prose value, or null. */
export function maintenanceLevel(value) {
  const m = /^\s*([1-5])\b/.exec(String(value ?? ''));
  return m ? Number(m[1]) : null;
}

/** The service's OWN words for a maintenance level -- the prose after the number --
 *  in sentence case; null when it gave only a number, or nothing.
 *
 *  Quoted rather than translated. The page has no phrase of its own for a level
 *  nobody here has measured, and inventing one would put words in the inventory's
 *  mouth about how drivable a road is. */
export function maintenanceText(value) {
  return prose(value, /^\s*[1-5]\s*-\s*/);
}

/** Surface family from the service's code prefix; null when unstated. */
export function surfaceFamily(value) {
  const code = String(value ?? '').split(' -')[0].trim().toUpperCase();
  if (!code) return null;
  if (['AC', 'BST', 'PCC'].includes(code)) return 'paved';      // asphalt, bituminous, concrete
  if (['AGG', 'CSOIL', 'GRAVEL'].includes(code)) return 'gravel';
  if (['NAT', 'DIRT', 'IMP'].includes(code)) return 'native';
  return 'other';
}

/** The service's own words for a surface type, in sentence case; null when it gave
 *  only a bare code. `surfaceFamily` still reads the code -- this is the material
 *  the record names, which 'gravel' alone does not tell you. */
export function surfaceText(value) {
  return prose(value, /^\s*[A-Z]+\s*-\s*/i);
}

/** What a road's rating says, in one line, or null when it says nothing.
 *
 *  Silence is the correct answer for an unmatched road: an empty detail line would
 *  read as "the inventory looked and found it ordinary". A contradiction is not
 *  silence and is reported as itself -- `normalizeRoadQuality` already refuses to
 *  pick between two records, and the reader is owed the same refusal in words. */
export function roadDetail(rating) {
  if (!rating) return null;
  if (rating.ambiguous) return 'Inventory records disagree about this road';
  // 'other' is surfaceFamily's answer for a code it cannot read, so saying it out
  // loud reports our parsing gap as a fact about the road.
  const family = rating.surface && rating.surface !== 'other' ? sentence(rating.surface) : null;
  const surface = rating.surfaceText || family;
  const level = rating.maintLevel === null || rating.maintLevel === undefined ? null
    : rating.maintText ? `${lower(rating.maintText)} (level ${rating.maintLevel})`
      : `maintenance level ${rating.maintLevel}`;
  const said = [surface, level].filter(Boolean);
  return said.length ? sentence(said.join('; ')) : null;
}

/** The width tier a road draws at: level 1 thinnest, 4-5 widest. Width, never
 *  pattern -- pattern already carries season (legend.js). */
export function widthTierFor({ maintLevel, surface }) {
  if (maintLevel === 5 || maintLevel === 4) return 'road-high';
  if (maintLevel === 3) return 'road-passenger';
  if (maintLevel === 2) return 'road-highclearance';
  if (maintLevel === 1) return 'road-primitive';
  // No maintenance level: fall back to surface, then to the plain road width.
  if (surface === 'paved') return 'road-high';
  if (surface === 'gravel') return 'road-passenger';
  return null;
}

/** The full enrichment answer: the join table, plus how much of it there is.
 *
 *  PAGED, through the one loop every other layer here uses. A single /query answers
 *  one page and says so in `exceededTransferLimit`; this adapter read only the first
 *  one, so on a rectangle past the transfer limit every road beyond the cap quietly
 *  lost its rating and fell back to its plain width -- indistinguishable, on paper,
 *  from a road the inventory has nothing to say about. `coverage` is 'complete' only
 *  when the service stopped flagging more, the same word the county, federal and
 *  state land adapters return. `ambiguous` counts the routes two records disagreed
 *  about, which are left unrated rather than picked between. */
export async function fetchRoadQualityReport({ bboxLonLat, fetchImpl = fetch, signal, pageSize = PAGE_CAP } = {}) {
  const { minLon, minLat, maxLon, maxLat } = bboxLonLat;
  const page = await pageThrough({
    url: `${SERVICE}/query`,
    label: 'Road quality',
    params: {
      geometry: `${minLon},${minLat},${maxLon},${maxLat}`,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: FIELDS.join(','),
      returnGeometry: 'false',
    },
    // Identity: the pager dedupes on a normalized `id`, and a second record for a
    // route is exactly what the join table has to reconcile, not drop unseen.
    normalize: (one) => one,
    fetchImpl,
    signal,
    pageSize,
  });
  const byId = normalizeRoadQuality(page.features);
  const ambiguous = Object.values(byId).filter((r) => r.ambiguous).length;
  return { byId, coverage: page.coverage, pages: page.pages, ambiguous, retrievedAt: page.retrievedAt };
}

/** { [routeId]: { maintLevel, surface, tier } } for a lon/lat box -- the table the
 *  preview and the sheet index directly. `fetchRoadQualityReport` is the same fetch
 *  with the coverage answer attached. */
export async function fetchRoadQuality(opts) {
  return (await fetchRoadQualityReport(opts)).byId;
}

/** Pure: ArcGIS features -> the join table. Exported so a test needs no network. */
export function normalizeRoadQuality(features) {
  const byId = {};
  for (const f of features) {
    const a = f.attributes || {};
    const id = a.id === null || a.id === undefined ? '' : String(a.id).trim();
    if (!id) continue;
    const maintLevel = maintenanceLevel(a.oper_maint_level);
    const surface = surfaceFamily(a.surface_type);
    const maintWords = maintenanceText(a.oper_maint_level);
    const surfaceWords = surfaceText(a.surface_type);
    const prev = byId[id];
    if (!prev) {
      byId[id] = { maintLevel, surface, maintText: maintWords, surfaceText: surfaceWords,
        tier: widthTierFor({ maintLevel, surface }) };
      continue;
    }
    // Silence never contradicts a rating: the best-attested record still wins.
    // But two records that both state a value and disagree are a conflict, and
    // picking one would be the map asserting something the source does not. Drop
    // back to unrated -- the road draws at its plain width -- and say so.
    const conflict = (x, y) => x !== null && y !== null && x !== y;
    const ambiguous = prev.ambiguous
      || conflict(prev.maintLevel, maintLevel) || conflict(prev.surface, surface);
    // Once a route is ambiguous it stays unrated: a later record cannot un-say a
    // contradiction, it can only be a third opinion.
    const level = ambiguous ? null : (prev.maintLevel ?? maintLevel);
    const surf = ambiguous ? null : (prev.surface ?? surface);
    byId[id] = { maintLevel: level, surface: surf,
      // The words follow their value: a contradicted route keeps neither record's
      // phrasing, or the tooltip would assert exactly what the rating refused to.
      maintText: ambiguous ? null : (prev.maintText ?? maintWords),
      surfaceText: ambiguous ? null : (prev.surfaceText ?? surfaceWords),
      tier: widthTierFor({ maintLevel: level, surface: surf }) };
    if (ambiguous) byId[id].ambiguous = true;
  }
  return byId;
}

export const ROAD_BASIC_SOURCE = Object.freeze({
  id: 'usfsRoadBasic',
  name: 'USFS National Forest System Roads',
  origin: new URL(SERVICE).origin,
  serviceUrl: SERVICE,
  attribution: SOURCES.usfsMvum.attribution,
  coverageSemantics: 'Maintenance level and surface are the Forest Service road inventory’s own '
    + 'record, not a report of current condition. A road can wash out, gate, or be logged over without '
    + 'the inventory changing. Where no record matched, or where two records disagree about the same '
    + 'route, the road is drawn at its plain width rather than guessed at.',
});
