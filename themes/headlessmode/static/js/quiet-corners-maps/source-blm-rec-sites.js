// BLM recreation sites: where you may legally stop on BLM land, in the agency's words.
//
// The map draws BLM BOUNDARIES already (source-federal-land.js, source-surface-
// ownership.js) and nowhere to stop inside them. This is that layer -- and NOT a
// stargazing index, which would be the error source-rec-sites.js warns about: one
// pattern promoted into a national rule. Over all 1,304 records on 2026-09-11, a
// description LIKE filter matched 3 for stargazing, 2 for night sky, 0 for dark sky, and
// ActivityNames 0 for STAR or ASTRO -- three pins nationally. What it DOES carry is
// access: description on 1,302, directions on 1,258. Nothing here scores or ranks.
//
// The fact that shapes the file: those two fields are RAW PROVIDER HTML -- nested <div>,
// <h2>, <hr/>, \xa0, <a rel="nofollow"> -- on a page we control, so plainText() is the
// only door they reach a reader through. FIELD NAMES ARE EXACT and the list only what is
// rendered: ArcGIS answers a bad outFields list with an error, not the rows.
import { pageThrough, PAGE_CAP } from './arcgis-pager.js';
import { SOURCES } from './source-registry.js';

// In the one registry of measured services: one home for the URL, fields and CSP origin.
export const BLM_REC_SITES_SOURCE = SOURCES.blmRecSites;
const SERVICE = BLM_REC_SITES_SOURCE.serviceUrl;
export const FIELDS = BLM_REC_SITES_SOURCE.layers[0].fields;
export const SNIPPET_CHARS = 320;           // how much of one field a card carries
export const LAYER_LABEL = 'BLM recreation sites';
export const LAYER_CAVEAT = 'The Bureau’s own inventory of the places it manages for '
  + 'recreation. Where you may stop, in its words — not a rating, and not a promise '
  + 'the site is open today.';
// `&lt;` is deliberately absent: decoding it hands back a tag opener the stripper passed.
const ENTITY = { nbsp: ' ', amp: '&', quot: '"', '#39': '’', apos: '’', ndash: '–', mdash: '—', hellip: '…' };

/** Provider HTML -> plain text, the ONLY way this module's text reaches a reader. script
 *  and style go with their contents, every other tag becomes a word break, and anything
 *  angle-bracketed after decoding is dropped -- an entity must never re-open a tag. */
export function plainText(html) {
  return String(html ?? '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&([a-z0-9#]{2,8});/gi, (m, n) => ENTITY[n.toLowerCase()] ?? ' ')
    .replace(/[<>]/g, ' ')
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}
/** Cut on a SENTENCE and say so: a mid-word cut reads as the agency's own text and is
 *  not. The caller puts the page URL beside the mark. */
export function shorten(html, limit = SNIPPET_CHARS) {
  const text = plainText(html);
  if (text.length <= limit) return { text, shortened: false };
  const head = text.slice(0, limit + 1);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  const cut = end > 0 ? head.slice(0, end + 1) : `${head.slice(0, head.lastIndexOf(' '))}.`;
  return { text: `${cut.trim()} …`, shortened: true };
}
/** One ArcGIS point -> a normalized site, [lon, lat] as the print path stores it. Text is
 *  reduced here; `url` and `updated` stay verbatim, the agency's own page and the date IT
 *  states. StayLimit is NOT read: empty in all three records captured, coverage unmeasured. */
export function normalizeBlmSite(raw) {
  const a = raw.attributes || {}, g = raw.geometry || {};
  // Number(null) is 0, which is finite -- a null longitude would place the site in the
  // Gulf of Guinea. Reject the empty values before converting.
  const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const lon = num(g.x), lat = num(g.y);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
  const site = {
    // QUX-11b §2.6: the discriminator that lets a merged `state.recSites` (both
    // this layer and source-rec-sites.js write into the same array) tell a BLM
    // site from a Forest Service one, and that rec:<provider>:... row ids
    // (places-in-view.js) are built from.
    provider: 'blm',
    name: plainText(a.RecAreaName) || null, symbolKey: 'rec-site', lonLat: [lon, lat],
    description: shorten(a.RecAreaDescription), directions: shorten(a.RecAreaDirections),
    fee: plainText(a.RecAreaFeeDescription) || null,
    url: str(a.BLMRecURL) || null, updated: str(a.LastUpdatedDate) || null,
  };
  // The lines ride ON the site, beside symbolKey and lonLat, so the drawing code can
  // show them without importing this module and without a second copy of the wording.
  return { ...site, lines: siteLines(site) };
}
const noPage = 'The record carries no BLM page link.';
const moreAt = (url) => (url ? `Shortened here; BLM’s full text is at ${url}` : `Shortened here. ${noPage}`);

// Attribution and vintage per RECORD, as the source states them: a service-wide "as of"
// would be invented.
export const sourceLine = (site) => `${site.updated
  ? `BLM last updated this record ${site.updated}.`
  : 'The record does not say when BLM last updated it.'} ${site.url ? `BLM’s page: ${site.url}` : noPage}`;

/** Every line a reader sees for one site, in order. */
export function siteLines(site) {
  const out = [site.name || 'Unnamed BLM recreation site'];
  for (const [head, part] of [['Directions', site.directions], ['About', site.description]]) {
    if (!part.text) { out.push(`${head}: the record does not say.`); continue; }
    out.push(`${head}: ${part.text}${part.shortened ? ` ${moreAt(site.url)}` : ''}`);
  }
  if (site.fee) out.push(`Fees, as stated: ${site.fee}`);
  out.push(sourceLine(site));
  return out;
}
/** Every string this module can show, fixed ones and the shapes siteLines builds. For the
 *  gate: a TEMPLATE-literal label is still read, and a check scanning quotes alone misses it. */
export function readerStrings() {
  const empty = { description: { text: '' }, directions: { text: '' } };
  const said = { name: 'A site', url: 'https://x.org', updated: '2026-07-06', fee: 'none',
    description: { text: 'About.', shortened: true }, directions: { text: 'Turn.', shortened: true } };
  return [LAYER_LABEL, LAYER_CAVEAT, BLM_REC_SITES_SOURCE.coverageSemantics,
    BLM_REC_SITES_SOURCE.attribution, noPage, moreAt(null), ...siteLines(empty), ...siteLines(said)];
}
/** Recreation sites in a lon/lat box, paged through the one loop every other layer uses:
 *  `coverage` is 'complete' only when the service stopped flagging more, and a truncated set
 *  is refused rather than printed as if finished. */
export async function fetchBlmRecSites({ bboxLonLat, fetchImpl = fetch, signal, pageSize = PAGE_CAP } = {}) {
  const { minLon, minLat, maxLon, maxLat } = bboxLonLat;
  const page = await pageThrough({
    url: `${SERVICE}/query`,
    label: 'BLM recreation sites',
    params: {
      geometry: `${minLon},${minLat},${maxLon},${maxLat}`, geometryType: 'esriGeometryEnvelope',
      inSR: '4326', outSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      outFields: FIELDS.join(','), returnGeometry: 'true',
    },
    normalize: normalizeBlmSite, fetchImpl, signal, timeoutMs: SOURCES.blmRecSites.timeoutMs, pageSize,
  });
  const { features, ...rest } = page;
  return { sites: features, ...rest };
}
