// USFS recreation sites: where you can actually stop.
//
// MVUM says which roads are open and the trails layer says where you can walk.
// Neither says where you may sleep. This is the layer that answers it -- and it
// is what shipped INSTEAD of the dispersed-camping corridor, which was rejected
// because its legal input expires and a printed sheet cannot re-check an order.
// A campground drawn from the Forest Service's own inventory is a fact; a
// corridor drawn from a lapsed order is a liability.
//
// apps.fs.usda.gov is already a CSP-allowed origin. Measured 2026-09-06 over the
// Standing Indian quad: 13 sites -- 5 camping areas (three of them A.T.
// shelters), a campground, a group campground, a horse camp, 3 trailheads, a
// picnic site and a fee station.
//
// FIELD NAMES ARE EXACT. `recarea_name` not `recareaname`; ArcGIS answers a bad
// outFields list with an error rather than the rows, so a typo here returns
// nothing at all and the layer silently disappears. Verified against the
// service's own schema, not from memory.
import { pageThrough, PAGE_CAP } from './arcgis-pager.js';
import { DEFAULT_SOURCE_TIMEOUT_MS } from './source-registry.js';

const SERVICE = 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RecInfraRecreationSites_02/MapServer/0';
const FIELDS = ['site_name', 'site_type', 'fee_charged', 'seasonal_operational_status', 'open_season', 'total_capacity'];

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

// The site types measured in the field, mapped to the four marks a 1:24,000 sheet
// can carry without turning into a symbol quiz. An unrecognised type still draws --
// as the generic mark -- because a site we cannot classify is still a site.
const TYPE_SYMBOL = {
  'CAMPGROUND': 'rec-campground',
  'GROUP CAMPGROUND': 'rec-campground',
  'HORSE CAMP': 'rec-campground',
  'TRAILHEAD': 'rec-trailhead',
};

// 'CAMPING AREA' is deliberately ABSENT from that table. It used to map to
// 'rec-shelter' because in the Standing Indian quad those records are A.T.
// shelters -- a fact about one forest promoted into a national rule. The type says
// only that people camp there; a shelter is a built structure, and the inventory
// carries no field asserting one. The evidence it does carry is the record's own
// name: the A.T. shelters are named 'A.T. <NAME> SHELTER'.
const SHELTER_NAME = /\bSHELTERS?\b/i;

/** Which mark a site draws with. The type decides first, so a mapped type is never
 *  overridden by a name that merely contains the word; only then does the name's
 *  own evidence promote a site to a shelter. An unrecognised type still draws -- as
 *  the generic mark -- because a site we cannot classify is still a site. */
export function symbolKeyForSite(siteType, siteName) {
  const byType = TYPE_SYMBOL[str(siteType).toUpperCase()];
  if (byType) return byType;
  return SHELTER_NAME.test(str(siteName)) ? 'rec-shelter' : 'rec-site';
}

/** Yes, no, or unknown -- never a guess. 'Y' is a fee, 'N' is no fee, and anything
 *  else (blank, absent, a code nobody has seen) is `null`: the source did not say. */
export function feeStated(value) {
  const v = str(value).toUpperCase();
  if (v === 'Y') return true;
  if (v === 'N') return false;
  return null;
}

/** A.T. shelters are named 'A.T. <NAME> SHELTER' in the inventory; the sheet is
 *  more readable with the prefix dropped, since the trail is drawn beside it. */
export function shortSiteName(name) {
  const n = str(name);
  return n.replace(/^A\.?T\.?\s+/i, '').replace(/\s+/g, ' ').trim() || null;
}

/** One ArcGIS point -> a normalized site. Geometry is [lon, lat], as the rest of
 *  the print path stores it. */
export function normalizeSite(raw) {
  const a = raw.attributes || {}, g = raw.geometry || {};
  // Number(null) is 0, which is finite -- so a null longitude would place the site
  // at 0,0, in the Gulf of Guinea. Reject the empty values before converting.
  const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const lon = num(g.x), lat = num(g.y);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const status = str(a.seasonal_operational_status).toUpperCase();
  const site = {
    // QUX-11b §2.6: the discriminator that lets a merged `state.recSites` (both
    // this layer and source-blm-rec-sites.js write into the same array) tell a
    // Forest Service site from a BLM one, and that rec:<provider>:... row ids
    // (places-in-view.js) are built from.
    provider: 'usfs',
    name: shortSiteName(a.site_name),
    siteType: str(a.site_type) || null,
    symbolKey: symbolKeyForSite(a.site_type, a.site_name),
    // Three-valued on purpose. `=== 'Y'` turned a blank or absent field into `false`
    // -- "no fee" -- which the source never said. Silence is `null`, and the sheet
    // has to say "not stated" rather than promise a free night.
    fee: feeStated(a.fee_charged),
    // 'OPEN' here is the inventory's last sync, not a live check -- the same class
    // of claim as MVUM's closure gap, and the sheet says so.
    status: status || null,
    openSeason: str(a.open_season) || null,
    lonLat: [lon, lat],
  };
  // QUX-11b (§2.6): the lines ride ON the site, same as source-blm-rec-sites.js's
  // normalizeBlmSite -- so the drawing code (previewSites, main.js) can show a
  // card without importing this module a second time. Without this, a Forest
  // Service pin drew with no `lines` at all and Enter/click opened nothing.
  return { ...site, lines: siteLines(site) };
}

/** Recreation sites intersecting a lon/lat box.
 *
 *  PAGED, through the one loop every other layer here uses. A single /query answers
 *  one page and says so in `exceededTransferLimit`; this adapter read only the first
 *  one and reported it as the whole answer, so a rectangle past the transfer limit
 *  came back short with nothing said. `coverage` is 'complete' only when the service
 *  stopped flagging more -- the same word, meaning the same thing, as the county,
 *  federal and state land adapters return. */
export async function fetchRecSites({ bboxLonLat, fetchImpl = fetch, signal, pageSize = PAGE_CAP } = {}) {
  const { minLon, minLat, maxLon, maxLat } = bboxLonLat;
  const page = await pageThrough({
    url: `${SERVICE}/query`,
    label: 'Recreation sites',
    params: {
      geometry: `${minLon},${minLat},${maxLon},${maxLat}`,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: FIELDS.join(','),
      returnGeometry: 'true',
    },
    normalize: normalizeSite,
    fetchImpl,
    signal,
    timeoutMs: DEFAULT_SOURCE_TIMEOUT_MS,
    pageSize,
  });
  const { features, ...rest } = page;
  return { sites: features, ...rest };
}

export const REC_SITES_SOURCE = Object.freeze({
  id: 'usfsRecSites',
  name: 'USFS recreation sites',
  origin: new URL(SERVICE).origin,
  serviceUrl: SERVICE,
  attribution: 'U.S. Forest Service Enterprise Map Services Program',
  coverageSemantics: 'Open/closed status and seasonal dates are the Forest Service inventory’s '
    + 'last sync, not a live check: a site can close for damage, fire or funding without the '
    + 'inventory changing. Confirm with the managing forest before relying on a site. A fee is '
    + 'shown only where the record states one: a blank field is silence, not a free night.',
});

/** The card a Forest Service pin shows (QUX-11b §2.6, E7): six lines, built only
 *  from fields already fetched -- name, type, fee (three-valued, never collapsing
 *  a blank field into "no fee"), status (with the same not-a-live-check caveat
 *  REC_SITES_SOURCE states above), open season, and an attribution+caveat line.
 *  Each field says plainly when the inventory did not state it, rather than
 *  dropping the line -- "the record does not say" is a different answer than
 *  "there is nothing there", and a reader must be able to tell them apart. */
export function siteLines(site) {
  const type = site.siteType
    ? `Type, as the inventory states it: ${site.siteType}`
    : 'Type: the record does not say.';
  const feeLine = site.fee === true ? 'Fee: the inventory says a fee is charged.'
    : site.fee === false ? 'Fee: the inventory says no fee is charged.'
    : 'Fee: the record does not say.';
  const status = site.status
    ? `Status in the inventory: ${site.status} — its last sync, not a live check.`
    : 'Status: the record does not say.';
  const season = site.openSeason
    ? `Open season, as stated: ${site.openSeason}`
    : 'Open season: the record does not say.';
  return [
    site.name || 'Unnamed Forest Service recreation site',
    type,
    feeLine,
    status,
    season,
    `${REC_SITES_SOURCE.attribution} Confirm with the managing forest before relying on a site.`,
  ];
}
