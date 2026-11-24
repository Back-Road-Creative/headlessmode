// Caltrans CWWP2 CCTV: a still (and sometimes an HLS stream) for one camera, straight off the
// district JSON feed -- no key, no account, `Access-Control-Allow-Origin: *` confirmed live on
// both the JSON and the image (2026-09-27, `curl -H 'Origin: https://headlessmode.com'` against
// cwwp2.dot.ca.gov/data/d5/cctv/cctvStatusD05.json and .../d7/cctv/cctvStatusD07.json). Recorded
// in scripts/qcm/fixtures/caltrans-cctv-d05-2026-09-27.min.json and
// caltrans-cctv-d07-2026-09-27.min.json, both real records, envelope and field names untouched.
//
// capturedAt is always null here: this feed carries no per-image capture time. The only
// timestamp field on a record, recordTimestamp, LOOKS like one -- it isn't. Proof: many
// unrelated cameras across a whole district share the identical recordDate (41 of 592 D07
// records are all dated 2026-06-26) -- 41 cameras were not photographed in the same instant, so
// this is a catalogue/config edit date, not a photo time. Sharper proof: the D5 index 1 pilot
// camera, confirmed GENUINELY LIVE by its own image's HTTP Last-Modified header (47s old at
// check time, 2026-09-27), carries recordTimestamp 2025-02-27 -- OLDER than the two dead D7
// feeds below (2026-01-08). A field that reads older on a live camera than on a dead one cannot
// be a freshness signal in either direction, so it is never mapped into capturedAt (or anywhere
// else on the record) -- doing so would print a false "captured" date on a camera card. The
// spec's own normalized shape has no slot for "catalogue edit date"; inventing one is not
// warranted by a single ambiguous field on one provider.
//
// D7 index 1130 ("Big Rock Beach") and 1138 ("Malibu Pier") both report inService: "true" while
// their actual still images were, re-fetched fresh this session, a "Temporarily Unavailable"
// placeholder graphic -- a real, reproducible health-field mismatch. Per the finding above, the
// JSON carries no field that tells a dead feed apart from a genuinely live one, so both
// normalize health: 'active', matching what the record itself claims. Detecting the placeholder
// needs the image bytes or the image response's own Last-Modified header -- the camera card's
// job (QUX-08D), never this adapter's; it sees JSON only, and capturedAt: null on every record
// means the card cannot lean on this adapter for freshness either -- it has to check the image.
//
// Rights: the Conditions of Use page (dot.ca.gov/conditions-of-use, fetched live 2026-09-27)
// states a general public-domain default but names "photographs" specifically as data that "may
// require additional permissions prior to your use" -- so a blanket public-domain claim for
// camera stills is not supportable from that text, and no CCTV-specific still/stream/bulk-use
// clause exists on cwwp2.dot.ca.gov/documentation/cctv/cctv.htm either (checked live, same
// date). Both the still and the HLS stream normalize 'unverified', not 'public-domain'.
const PROVIDER = 'caltrans-cwwp2';
const OPERATOR = 'Caltrans';
const OFFICIAL_URL = 'https://cwwp2.dot.ca.gov/documentation/cctv/cctv.htm';
const RIGHTS = 'unverified';
const ATTRIBUTION = 'Caltrans';

// null must stay null: Number(null) is 0 (finite), so a naive `Number.isFinite(Number(v))` guard
// would silently turn a real missing coordinate into 0,0 -- exactly the bug the NPS half below
// exists to avoid (Twin Creek and Kuwohi carry real JS null latitude/longitude). Caltrans never
// hits this path (its tests only delete fields, producing undefined), so this guard is
// behavior-preserving for the Caltrans half.
const num = (v) => {
  if (v === null || v === undefined) return null;
  // Number('') is 0 too: the NPS API sends an empty string for a camera with no position, and a
  // nationwide layer must not pin those at 0,0.
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (typeof v === 'string' && v.length ? v : null);
// Shared by every provider (spec QUX-07-08.md:182 -- the field's type is 'exact' | 'approximate'
// | null): a record with no lat or no lon has no location to be precise about, so it must not
// claim 'exact' (:229-230). No merged provider produces an 'approximate' fix today; an adapter
// whose source gives only a rough one (a town centroid, a zip code) passes 'approximate' as the
// third argument, and the snapshot format (schema 2) carries it. Any other override is a bug in
// the adapter, not feed data, so it throws.
export const precisionFor = (lat, lon, override = 'exact') => {
  if (override !== 'exact' && override !== 'approximate') {
    throw new Error(`precisionFor: precision must be 'exact' or 'approximate', not ${JSON.stringify(override)}`);
  }
  return lat === null || lon === null ? null : override;
};

// The one parser for the richer fields the snapshot format (schema 2) can carry. No merged adapter
// calls these: none of the sources gives a bearing, a capture time or an expiry it can vouch for
// (see the Caltrans note at the top of this file), and a field is never invented. An adapter whose
// source does publish one maps it through here, so a malformed value becomes null instead of a
// date or heading that was never real.
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/** An ISO 8601 date-time WITH a zone (Z or an offset) -> the canonical ISO string
 *  (`2026-10-04T11:58:00.000Z`), else null: a date alone, a time with no zone (whose zone would be
 *  a guess), a real calendar date that does not exist, a number or any other format. For capturedAt
 *  and validUntil. */
export function parseIsoTime(v) {
  if (typeof v !== 'string') return null;
  const m = ISO_INSTANT.exec(v.trim());
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  const ms = Date.parse(v.trim());
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

const PLAIN_DECIMAL = /^\d+(?:\.\d+)?$/;

/** A compass heading in degrees (0 to 360, a number or a plain decimal string) -> the number, else
 *  null. A word such as "North" is never turned into degrees, and neither is a string Number()
 *  would still read (`0x5A`, `0b11`, `1e2`, `+90`). */
export const parseBearing = (v) => {
  const n = typeof v === 'number' ? num(v) : (typeof v === 'string' && PLAIN_DECIMAL.test(v.trim()) ? num(v) : null);
  return n !== null && n >= 0 && n <= 360 ? n : null;
};

/** One camera, in the shape every Quiet Corners camera provider normalizes to. Never throws: a
 *  missing or malformed field becomes null (or the safest default) rather than an exception,
 *  because a malformed record inside a live government feed is normal, not exceptional. Returns
 *  null only when the record carries no usable index at all -- there is nothing to key it by. */
export function normalizeCaltransCctvRecord(cctv = {}, { fetchedAt } = {}) {
  const index = cctv && cctv.index;
  if (index === undefined || index === null || index === '') return null;
  const loc = cctv.location || {};
  const img = cctv.imageData || {};
  const still = img.static || {};
  const inService = cctv.inService;
  const stream = str(img.streamingVideoURL);
  const lat = num(loc.latitude), lon = num(loc.longitude);
  return Object.freeze({
    provider: PROVIDER,
    providerId: String(index),
    name: str(loc.locationName) || str(loc.nearbyPlace) || `Caltrans camera ${index}`,
    lat, lon,
    // A surveyed camera position, not a zip-code centroid -- 'exact' describes the provider's
    // own precision, but only when this record actually carries coordinates.
    locationPrecision: precisionFor(lat, lon),
    category: 'road',
    operator: OPERATOR,
    officialUrl: OFFICIAL_URL,
    subject: str(img.imageDescription),
    // Caltrans gives a cardinal `location.direction` string ("South", "North", ...), never a
    // numeric bearing -- converting eight named directions into invented degrees would be a
    // fabrication the spec forbids, so this stays null.
    bearing: null,
    media: { still: str(still.currentImageURL), stream, streamKind: stream ? 'hls' : null },
    // Never recordTimestamp -- see the header comment. This feed has no per-image capture time.
    capturedAt: null,
    fetchedAt: fetchedAt || new Date().toISOString(),
    validUntil: null, // tier 1: the browser fetches this live, there is no build-job snapshot to expire
    rights: RIGHTS,
    attribution: ATTRIBUTION,
    health: inService === 'false' ? 'inactive' : (inService === 'true' ? 'active' : 'unknown'),
  });
}

/** Every camera in one district feed's raw payload (`{ data: [{ cctv: {...} }, ...] }`), fetched
 *  straight off cwwp2.dot.ca.gov -- tier 1, no build step, no key. A payload that is not shaped
 *  like the real feed normalizes to an empty list rather than throwing. */
export function normalizeCaltransCctv(payload, { fetchedAt } = {}) {
  const rows = (payload && Array.isArray(payload.data)) ? payload.data : [];
  return rows
    .map((row) => normalizeCaltransCctvRecord(row && row.cctv, { fetchedAt }))
    .filter((record) => record !== null);
}

/** One Caltrans district's feed -> its cameras, for the build-time snapshot. `index` is unique only
 *  within a district, so the id is `dNN:<index>` and the record carries `region: 'ca-dNN'`.
 *  `district` is 1-12 (or "05"); anything else gives no cameras rather than an id with no district.
 *  normalizeCaltransCctvRecord and normalizeCaltransCctv are untouched: the live District 5 layer
 *  still uses the bare index. */
export function normalizeCaltransDistrict(payload, district, { fetchedAt } = {}) {
  const n = Number(district);
  if (!Number.isInteger(n) || n < 1 || n > 12) return [];
  const nn = String(n).padStart(2, '0');
  return normalizeCaltransCctv(payload, { fetchedAt }).map((record) => Object.freeze({
    ...record, providerId: `d${nn}:${record.providerId}`, region: `ca-d${nn}`,
  }));
}

// Camera U5: this adapter now serves two outputs. Its defaults are the GRSM ones (provider
// `nps-grsm`, operator `NPS Air Quality Network`), so the legacy cameras-nps-grsm.json is
// byte-stable. The nationwide `nps-webcams` build passes `{ provider, operator }`: the Air Quality
// Network claim is proven for four GRSM cameras only, so every other park's camera is credited to
// the National Park Service. Only the four proven stills below are curated; every other camera is
// link-only (still: null), and the build drops a curated still whose HEAD answers 404.
//
// NPS webcams API (developer.nps.gov/api/v1/webcams?parkCode=grsm), GRSM (Great Smoky Mountains)
// scenic cameras only -- QUX-07's ledger found every other checked NPS-listed camera is either
// third-party (Cape Hatteras is an EarthCam embed) or link-only (Cape Cod), so this adapter
// covers GRSM alone. Recorded in scripts/qcm/fixtures/nps-webcams-grsm-2026-09-27.min.json, a
// real capture (2026-09-27T18:34:30Z), envelope and field names untouched -- see the fixture's
// own _captured field for full provenance. No network in this module; build-time fetching is
// build-camera-snapshot.mjs's job.
//
// media.still: NEVER the API's images[].url. QUX-07 found that field is a stale gallery
// thumbnail (Purchase Knob's Last-Modified was 2025-01-11, ~8.5 months old at capture time) and
// carries a real upstream bug -- the host prefix is doubled
// ("https://www.nps.govhttps://www.nps.gov/..."). Plan R2-G11: the live still is the GRSM park
// page's own <img src>, `nps.gov/featurecontent/ard/webcams/images/<cam>large.jpg`, confirmed
// ~10-25 min old by Last-Modified at verification time vs. the API thumbnail's months-old one.
// LIVE_STILL_BY_ID is that hand-curated id -> park-page camera-code map for the four active GRSM
// cameras (QUX-07-camera-ledger.md:50, QUX-07-captures/nps-webcams.md "Dispatcher verification");
// D12: a camera id absent from this map gets media.still: null (link-only), never a fallback to
// the stale images[].url thumbnail -- that field carries the same doubled-host bug and can be
// months stale, so falling back to it would silently show a broken or wrong-looking picture
// instead of just linking out. Twin Creek is Inactive and appears on no GRSM webcams-page still,
// so it is deliberately left out of the map -- media.still stays null rather than guessing a
// camera code. repairNpsImageHost remains exported and tested on its own; nothing in this module
// calls it anymore.
//
// capturedAt is always null: like Caltrans, NPS publishes no per-image capture time on this
// endpoint (QUX-07-08.md:188) -- fabricating one from fetch time would misrepresent a possibly
// stale image as fresh.
//
// latitude/longitude: real GRSM records carry JS null (not just a missing field) for an inactive
// camera (Twin Creek, Kuwohi -- confirmed in the fixture) -- kept as null, never coerced to 0,0
// or dropped from the catalogue; see num()'s null-safety fix above, added for this exact case.
//
// Rights: QUX-07-08.md:64 (written before verification) says "treat as public domain," but the
// actual fetch in QUX-07-captures/nps-webcams.md:20 found the NPS API documentation page's body
// is JS-loader/nav chrome only in a plain GET -- "the terms/rate-limit language on this
// documentation page could not be independently verified." No page checked states a public-domain
// grant for camera media specifically. Per the brief, a later, actually-fetched finding overrides
// an earlier hedge, so this stays 'unverified' -- the same vocabulary Caltrans uses, and for the
// same reason (an unverified claim, not a denial).
const NPS_PROVIDER = 'nps-grsm';
// QUX-07-08.md:58-60 and the camera ledger (QUX-07-camera-ledger.md:12): all four active GRSM
// cameras are run by NPS's own Air Resources Division webcam program, not a third party -- the
// spec's own operator vocabulary (QUX-07-08.md:184) names it "NPS Air Quality Network".
const NPS_OPERATOR = 'NPS Air Quality Network';
const GRSM_WEBCAMS_PAGE = 'https://www.nps.gov/grsm/learn/photosmultimedia/webcams.htm';
const NPS_RIGHTS = 'unverified';
const NPS_FALLBACK_ATTRIBUTION = 'National Park Service';
const NPS_CATEGORY = 'scenic';
const NPS_HOST_PREFIX = 'https://www.nps.gov';

// id -> the park-page camera code used in nps.gov/featurecontent/ard/webcams/images/<code>large.jpg
// (QUX-07-camera-ledger.md:50,72). Twin Creek has no still on the GRSM webcams page and is
// intentionally left unmapped.
const LIVE_STILL_BY_ID = Object.freeze({
  'BDFD47F3-1DD8-B71B-0B81AFE928DDCBCF': 'grcd', // Kuwohi (Clingmans Dome)
  'C589EEEF-1DD8-B71B-0B0463C308FF64DD': 'gsng', // Newfound Gap
  '52E38701-AF1C-D2FC-3F23861BB6E221BB': 'grpk', // Purchase Knob
  '6878C635-B83A-8F41-A6E3B0160539BEAA': 'grsm', // Look Rock
});

/** Strips the real upstream `https://www.nps.govhttps://www.nps.gov/...` doubled-host bug,
 *  exactly once. A URL that was never doubled, or isn't a string, passes through unchanged. */
export function repairNpsImageHost(url) {
  if (typeof url !== 'string') return url;
  const doubled = NPS_HOST_PREFIX + NPS_HOST_PREFIX;
  return url.startsWith(doubled) ? url.slice(NPS_HOST_PREFIX.length) : url;
}

const npsStillUrl = (cam) => `https://www.nps.gov/featurecontent/ard/webcams/images/${cam}large.jpg`;

/** id -> the curated live-still URL, for every camera with one (the build HEAD-checks each). */
export function npsCuratedStills() {
  return Object.fromEntries(Object.entries(LIVE_STILL_BY_ID).map(([id, cam]) => [id, npsStillUrl(cam)]));
}

/** The lowercase two-letter state a webcam is filed under: the first state of its first related
 *  park (a park spanning states goes to the first listed), or null when the record names none. */
export function npsStateOf(webcam) {
  const park = webcam && Array.isArray(webcam.relatedParks) ? webcam.relatedParks[0] : null;
  const first = park && typeof park.states === 'string' ? park.states.split(',')[0].trim() : '';
  return /^[A-Za-z]{2}$/.test(first) ? first.toLowerCase() : null;
}

function npsStillFor(webcam) {
  // D12: the API's own images[].url is a stale, sometimes doubled-host thumbnail the park's own
  // page does not use (see the doubled-host repairNpsImageHost tests above) -- an unmapped camera
  // gets no still at all (link-only) rather than a fabricated, possibly-broken fallback picture.
  const cam = LIVE_STILL_BY_ID[webcam.id];
  return cam ? npsStillUrl(cam) : null;
}

function npsAttributionFor(webcam) {
  const credit = str(webcam.credit);
  if (credit) return credit;
  const park = Array.isArray(webcam.relatedParks) ? webcam.relatedParks[0] : null;
  const parkName = park && str(park.fullName);
  return parkName ? `${NPS_FALLBACK_ATTRIBUTION} — ${parkName}` : NPS_FALLBACK_ATTRIBUTION;
}

/** One GRSM webcam, in the same normalized shape normalizeCaltransCctvRecord returns. Never
 *  throws. Returns null only when the record carries no usable id at all. */
export function normalizeNpsWebcamRecord(webcam = {}, { fetchedAt, provider, operator } = {}) {
  const id = str(webcam && webcam.id);
  if (!id) return null;
  const nationwide = Boolean(provider);
  const park = Array.isArray(webcam.relatedParks) ? webcam.relatedParks[0] : null;
  const parkCode = park && str(park.parkCode);
  // The fallback page is the record's own park's, never GRSM's, once the record is not a GRSM one.
  const fallbackPage = !nationwide ? GRSM_WEBCAMS_PAGE
    : (parkCode && /^[a-z0-9]+$/i.test(parkCode) ? `https://www.nps.gov/${parkCode.toLowerCase()}/learn/photosmultimedia/webcams.htm` : 'https://www.nps.gov/');
  const lat = num(webcam.latitude), lon = num(webcam.longitude);
  return Object.freeze({
    provider: provider || NPS_PROVIDER,
    providerId: id,
    name: str(webcam.title) || `NPS webcam ${id}`,
    lat, lon,
    locationPrecision: precisionFor(lat, lon),
    category: NPS_CATEGORY,
    operator: operator || NPS_OPERATOR,
    officialUrl: str(webcam.url) || fallbackPage,
    subject: str(webcam.description),
    // NPS gives no bearing field at all (unlike Caltrans's cardinal direction) -- always null.
    bearing: null,
    media: { still: npsStillFor(webcam), stream: null, streamKind: null }, // isStreaming is
    // false on every real GRSM record (QUX-07-08.md:51-52) -- never build a stream path here.
    capturedAt: null,
    fetchedAt: fetchedAt || new Date().toISOString(),
    validUntil: null, // set by the snapshot builder that calls this, not by the record itself
    rights: NPS_RIGHTS,
    attribution: npsAttributionFor(webcam),
    health: webcam.status === 'Inactive' ? 'inactive' : (webcam.status === 'Active' ? 'active' : 'unknown'),
  });
}

/** Every camera in one NPS `/webcams` payload (`{ data: [...] }`), deduped by id -- the real GRSM
 *  feed lists Newfound Gap twice (QUX-07-08.md:50). The first occurrence in feed order wins,
 *  keeping the more specific per-camera `url` over the second entry's generic listing-page url.
 *  A payload that isn't shaped like the real feed normalizes to an empty list, never throws. */
export function normalizeNpsWebcams(payload, { fetchedAt, provider, operator } = {}) {
  const rows = (payload && Array.isArray(payload.data)) ? payload.data : [];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const record = normalizeNpsWebcamRecord(row, { fetchedAt, provider, operator });
    if (record && !seen.has(record.providerId)) {
      seen.add(record.providerId);
      out.push(record);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Link-only cameras: HPWREN (UC San Diego), AlertWest and six state road operators (see
// LINK_ROAD_LAYERS below). A pin shows the camera's name, the
// owner's credit and a link to the owner's own page, and NO picture. HPWREN's terms are
// non-commercial with credit and AlertWest's licence is CC BY-NC-ND; the site owner decided
// (D5) not to show those pictures. So nothing here keeps an image address: the record has
// media.still null by construction, the snapshot file therefore has none, the browser loads
// nothing from the owner's host, and the page's CSP gains no img-src host for either.
//
// Only these fields are ever copied from an owner's list: an id, a name, a position, the owner's
// credit and link, the link-only flag and (HPWREN) the names of the site's cameras. Nothing
// else from the lists (heights, bearings, equipment, times, image URLs) is read into a record.
export const LINK_ONLY_PROVIDERS = Object.freeze(['hpwren', 'alertwest',
  'modot', 'mdchart', 'deldot', 'nmroads', 'njta']);

/** True for a camera that shows a link and no picture. Holds for the provider as well as the flag:
 *  the compact snapshot format has no slot for the flag, so a record read back from a file has
 *  lost it, and the provider is what still says so. */
export function isLinkOnly(camera) {
  return !!camera && (camera.linkOnly === true || LINK_ONLY_PROVIDERS.includes(camera.provider));
}

const HPWREN_CAMERAS_PAGE = 'https://www.hpwren.ucsd.edu/cameras/';
const HPWREN_CREDIT = 'HPWREN, UC San Diego';
const ALERTWEST_HOME = 'https://alertwest.live/';
const ALERTWEST_CREDIT = 'AlertWest';
const LINK_ONLY_CATEGORY = 'fire';
// The licences are known, and they are why these are links: HPWREN's stills are free for
// non-commercial use with credit and may not be cropped (its own camera pages say so), and
// AlertWest carries ALERTCalifornia's CC BY-NC-ND 4.0. The site shows no
// picture under either, so `rights` stays 'unverified' (no picture right is claimed) and neither
// owner gets a SOURCES row, which would put its host into APPROVED_ORIGINS and the CSP.
const LINK_ONLY_RIGHTS = 'unverified';

/** HPWREN's sites.js (`var sites = { ... };`) as DATA: the prefix and trailing `;` are cut off and
 *  the rest is parsed, never run. The live file is valid JSON; if it ever turns into a JS object
 *  literal (bare keys, single quotes, trailing commas) a tiny repair is tried before giving up.
 *  Anything that is still not an object comes back null. */
export function parseHpwrenSites(text) {
  if (typeof text !== 'string') return null;
  const body = text.replace(/^\s*(?:var|let|const)\s+sites\s*=\s*/, '').replace(/;?\s*$/, '');
  const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
  try { return asObject(JSON.parse(body)); } catch { /* fall through to the repair */ }
  const repaired = body
    .replace(/'((?:[^'\\]|\\.)*)'/g, (_, s) => JSON.stringify(s.replace(/\\'/g, "'")))
    .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)\s*:/g, '$1"$2":')
    .replace(/,(\s*[}\]])/g, '$1');
  try { return asObject(JSON.parse(repaired)); } catch { return null; }
}

// HPWREN's own page opens a camera set from its address: `#mode=realTime&cams=<site>_<cam>.<site>_<cam>`
// (read from the page's own script, which splits on `_` and `.`, escaping a literal `_` as `\_`).
const hpwrenPart = (id) => String(id).replace(/_/g, '\\_');
const hpwrenLink = (siteId, camIds) => `${HPWREN_CAMERAS_PAGE}#mode=realTime&cams=${
  encodeURIComponent(camIds.map((c) => `${hpwrenPart(siteId)}_${hpwrenPart(c)}`).join('.'))}`;

/** One pin per HPWREN site that has at least one of HPWREN's own working cameras: `owner` hpwren
 *  (cameras other networks run, such as ALERTCalifornia's, are not HPWREN's to credit), `active` y
 *  and `experimental` n. The card lists that site's qualifying camera names. */
export function normalizeHpwrenSites(sites, { fetchedAt } = {}) {
  if (!sites || typeof sites !== 'object' || Array.isArray(sites)) return [];
  const out = [];
  for (const [siteId, site] of Object.entries(sites)) {
    if (!site || typeof site !== 'object') continue;
    const lat = num(site.lat), lon = num(site.long);
    if (lat === null || lon === null) continue;
    const cams = Object.entries(site.cams && typeof site.cams === 'object' ? site.cams : {})
      .filter(([, c]) => c && c.owner === 'hpwren' && c.active === 'y' && c.experimental === 'n');
    if (cams.length === 0) continue;
    const names = [...new Set(cams.map(([, c]) => str(c.name)).filter(Boolean))];
    out.push(Object.freeze({
      provider: 'hpwren',
      providerId: siteId,
      name: str(site.name) || `HPWREN site ${siteId}`,
      lat, lon,
      locationPrecision: precisionFor(lat, lon),
      category: LINK_ONLY_CATEGORY,
      operator: 'HPWREN',
      officialUrl: hpwrenLink(siteId, cams.map(([id]) => id)),
      subject: names.length ? `Cameras: ${names.join(', ')}` : null,
      bearing: null,
      media: { still: null, stream: null, streamKind: null },
      linkOnly: true,
      capturedAt: null,
      fetchedAt: fetchedAt || new Date().toISOString(),
      validUntil: null,
      rights: LINK_ONLY_RIGHTS,
      attribution: HPWREN_CREDIT,
      health: 'active',
    }));
  }
  return out;
}

const US_STATE_CODES = new Set(('al ak az ar ca co ct de dc fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm '
  + 'ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy').split(' '));

/** The lower-case US state code of an AlertWest camera, or null (no state, or a Canadian one). */
export function alertWestStateOf(row) {
  const raw = row && row.site && typeof row.site.state === 'string' ? row.site.state.trim().toLowerCase() : '';
  return US_STATE_CODES.has(raw) ? raw : null;
}

/** AlertWest's camera list: one pin per camera outside California (California's cameras are
 *  ALERTCalifornia's, which the site does not carry) and inside a US state. The row's image object
 *  is never read, so no image address can reach a record. */
export function normalizeAlertWestCameras(list, { fetchedAt } = {}) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const row of list) {
    const state = alertWestStateOf(row);
    if (!state || state === 'ca') continue;
    const name = str(row.name);
    const lat = num(row.site.latitude), lon = num(row.site.longitude);
    if (!name || lat === null || lon === null) continue;
    const providerId = row.site.id === null || row.site.id === undefined ? name : `${row.site.id}:${name}`;
    if (seen.has(providerId)) continue;
    seen.add(providerId);
    out.push(Object.freeze({
      provider: 'alertwest',
      providerId,
      name,
      lat, lon,
      locationPrecision: precisionFor(lat, lon),
      category: LINK_ONLY_CATEGORY,
      operator: 'AlertWest',
      officialUrl: ALERTWEST_HOME,
      subject: null,
      bearing: null,
      media: { still: null, stream: null, streamKind: null },
      linkOnly: true,
      capturedAt: null,
      fetchedAt: fetchedAt || new Date().toISOString(),
      validUntil: null,
      rights: LINK_ONLY_RIGHTS,
      attribution: ALERTWEST_CREDIT,
      health: 'active',
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Link-only road operators (camera c8): MoDOT, Maryland CHART, DelDOT, NMRoads and the NJ Turnpike
// Authority each publish a camera list, but their pictures and streams are not ours to
// hotlink. Each layer below names the owner's own list (`sourceUrl`, read by a plain GET at build
// time) and its public camera page, and `parse` turns that list into plain rows
// { id, name, lat, lon, url, active } -- nothing else is read, so no picture, stream or camera
// field can reach a record. Checked 2026-10-04 by plain GET: NJTA's disclaimer, Maryland.gov's privacy notice (linked from CHART), Delaware.gov's privacy
// policy (linked from DelDOT) and MoDOT's privacy policy contain no reuse ban; no terms page is linked from nmroads.com.
// Rights stay 'unverified' and the credit is the owner's name. WV511 was dropped: its disclaimer forbids republishing.
const LINK_ROAD_CATEGORY = 'road';
const LINK_DEDUPE_METERS = 30;

const decodeEntities = (s) => s.replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => String.fromCodePoint(n[0] === 'x' || n[0] === 'X' ? parseInt(n.slice(1), 16) : Number(n)))
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const listOf = (v) => (Array.isArray(v) ? v : null);

/** The NJTA camera page keeps its list as JSON in the `data-block-config` attribute of its map block. */
function parseNjtaPage(text) {
  if (typeof text !== 'string') return null;
  const attr = /data-block-config="([^"]*)"/.exec(text);
  if (!attr) return null;
  let config;
  try { config = JSON.parse(decodeEntities(attr[1])); } catch { return null; }
  const cameras = config && config.initialData && config.initialData.cameras;
  if (!cameras || typeof cameras !== 'object') return null;
  const roads = [['turnpike', 'New Jersey Turnpike'], ['parkway', 'Garden State Parkway']];
  if (!roads.some(([key]) => Array.isArray(cameras[key]))) return null;
  return roads.flatMap(([key, road]) => (Array.isArray(cameras[key]) ? cameras[key] : [])
    .filter((c) => c && c.type === 'camera' && typeof c.relative_text === 'string')
    .map((c) => ({ id: `${key}:${c.id}`, name: `${road}: ${c.relative_text.trim()}`, lat: c.lat, lon: c.lng, url: null, active: true })));
}

export const LINK_ROAD_LAYERS = Object.freeze([
  Object.freeze({
    id: 'modot', state: 'mo', label: 'MoDOT', format: 'json', operator: 'Missouri DOT (MoDOT)',
    sourceUrl: 'https://traveler.modot.org/timconfig/feed/desktop/StreamingCams2.json',
    officialUrl: 'https://traveler.modot.org/map/',
    // The list has no id: a camera is its place name and position.
    parse: (body) => listOf(body) && body.filter((r) => r && typeof r === 'object').map((r) => ({
      id: `${r.location}|${num(r.y) === null ? '' : num(r.y).toFixed(5)},${num(r.x) === null ? '' : num(r.x).toFixed(5)}`,
      name: r.location, lat: r.y, lon: r.x, url: null, active: true })),
  }),
  Object.freeze({
    id: 'mdchart', state: 'md', label: 'CHART', format: 'json', operator: 'Maryland CHART',
    sourceUrl: 'https://chart.maryland.gov/DataFeeds/GetCamerasJson',
    officialUrl: 'https://chart.maryland.gov/InteractiveMap/GetInteractiveMap',
    parse: (body) => listOf(body) && body.filter((r) => r && typeof r === 'object').map((r) => ({
      id: r.id, name: r.description || r.name, lat: r.lat, lon: r.lon, url: r.publicVideoURL, active: r.opStatus === 'OK' })),
  }),
  Object.freeze({
    id: 'deldot', state: 'de', label: 'DelDOT', format: 'json', operator: 'Delaware DOT (DelDOT)',
    sourceUrl: 'https://tmc.deldot.gov/json/videocamera.json',
    officialUrl: 'https://deldot.gov/Traffic/cameras/',
    parse: (body) => listOf(body && body.videoCameras) && body.videoCameras.filter((r) => r && typeof r === 'object').map((r) => ({
      id: r.id, name: r.title, lat: r.lat, lon: r.lon, url: null, active: r.status === 'Active' && r.enabled !== false })),
  }),
  Object.freeze({
    id: 'nmroads', state: 'nm', label: 'NMRoads', format: 'json', operator: 'New Mexico DOT (NMRoads)',
    sourceUrl: 'https://servicev5.nmroads.com/RealMapWAR/GetCameraInfo',
    officialUrl: 'https://www.nmroads.com/',
    parse: (body) => listOf(body && body.cameraInfo) && body.cameraInfo.filter((r) => r && typeof r === 'object').map((r) => ({
      id: r.name, name: r.title, lat: r.lat, lon: r.lon, url: null, active: r.enabled !== false })),
  }),
  Object.freeze({
    id: 'njta', state: 'nj', label: 'NJTA', format: 'text', operator: 'New Jersey Turnpike Authority',
    sourceUrl: 'https://www.njta.gov/travel-resources/camera-list/',
    officialUrl: 'https://www.njta.gov/travel-resources/camera-list/',
    parse: parseNjtaPage,
  }),
]);

/** Metres between two points, flat-earth: exact enough for a 30 m test. */
const metersApart = (a, b) => Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180));

/** Pins from `parse`d rows of one owner: a name and a real position are required, a page address is
 *  kept only if it is https on the owner's own host (else the layer's camera page stands in), the
 *  same id is one pin, and so are two pins within 30 m (the first wins, unless it is inactive and the later one is active). A row's `active: false`
 *  makes it 'inactive'. No picture or stream address exists in the rows, so none is in a record. */
export function normalizeLinkRoadCameras(rows, layer, { fetchedAt } = {}) {
  if (!Array.isArray(rows)) return [];
  const host = new URL(layer.officialUrl).host;
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const name = str(typeof row.name === 'string' ? row.name.trim() : row.name);
    const lat = num(row.lat), lon = num(row.lon);
    const providerId = row.id === null || row.id === undefined ? null : str(String(row.id).trim());
    if (!name || !providerId || lat === null || lon === null || (lat === 0 && lon === 0)) continue;
    if (seen.has(providerId)) continue;
    const near = out.findIndex((r) => metersApart(r, { lat, lon }) < LINK_DEDUPE_METERS);
    // a nearby pin hides this one, unless that pin is inactive and this one is active
    if (near >= 0 && !(out[near].health === 'inactive' && row.active !== false)) continue;
    seen.add(providerId);
    let page = layer.officialUrl;
    try {
      const u = new URL(row.url);
      if (u.protocol === 'https:' && u.host === host && !u.username && !u.password) page = u.href;
    } catch { /* no page address: the layer's own camera page */ }
    const rec = Object.freeze({
      provider: layer.id, providerId, name, lat, lon,
      locationPrecision: precisionFor(lat, lon),
      category: LINK_ROAD_CATEGORY,
      operator: layer.operator,
      officialUrl: page,
      subject: null, bearing: null,
      media: { still: null, stream: null, streamKind: null },
      linkOnly: true,
      capturedAt: null,
      fetchedAt: fetchedAt || new Date().toISOString(),
      validUntil: null,
      rights: LINK_ONLY_RIGHTS,
      attribution: layer.operator,
      health: row.active === false ? 'inactive' : 'active',
    });
    if (near >= 0) out[near] = rec; else out.push(rec);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// ArcGIS REST camera layers: state and city operators that publish their cameras as a public
// FeatureServer layer. One adapter reads them all; each operator is its own provider id with its
// own field map (`read`), because no two of them name a field the same way. The builder asks
// `<serviceUrl>/query?where=1=1&outFields=<outFields>&outSR=4326&f=json`, so `geometry.x` is the
// longitude and `geometry.y` the latitude whatever the layer's own projection is.
//
// Every row is checked three ways before it is kept: the operator marks it in service (`read`
// returns null for an offline, retired or unexplained status), its picture address is an exact
// https address on the one host registered for the operator (no other host reaches img-src), and
// it has a real position. The fixture rows (scripts/qcm/fixtures/arcgis-cameras-2026-10-04.min.json)
// are unchanged live rows, including each kind of row dropped here.
//
// Measured 2026-10-04 with a plain GET and the build's own user agent: most pictures answer 200
// image/* and are current by Last-Modified, but a few per layer are 404, 5xx or months old (a
// layer's own timestamp field is NOT the test: one was months old while its pictures were minutes
// old). So the builder HEADs every still (gateArcgisStills) and drops the dead and stale (> 7 days)
// ones. A stale one covers Lawrence's stand-ins (75-104 days old); UDOT re-stamps its 'UDOT TRAFFIC' logo
// (36,809 bytes, 46 of 1,168 cameras, all marked online) with a fresh date, so that layer records the
// length in `placeholderLengths` and the gate drops a still of that Content-Length too. The gate
// sends one HEAD per still, so it runs only under --refresh-seeds (see build-camera-snapshot.mjs). Terms are
// unverified for every operator, so rights stay 'unverified' and the credit is the operator's name.
//
// Owner links: each card links the operator's public camera map (Arlington's ArcGIS Experience,
// Salem's and Lawrence's instant apps); all answer 200 to a plain GET with the build's user agent.
//
// Candidates measured and left out (2026-10-04): Iowa DOT (IMAGE_URL is a dated per-snapshot path
// that is stale once frozen into a seed), Louisiana DOTD (HLS streams and 511 page links only, no
// still; from the hunt's saved rows), UDOT's 196-camera rural layer (not re-verified). Florida and
// Georgia were in the hunt and are not here: their pictures were not re-verified in this change.
// Georgia and Louisiana were looked at again on 2026-10-05 and dropped: their stills sit on the IBI
// 511 hosts, whose "no image" stand-in comes and goes per camera within minutes, so no refresh-time
// check holds at view time (and 511ga.org answers 429 to a single paced client). No IBI 511 sites.
const ARCGIS_CATEGORY = 'road';
// Total: a stray '%' or a bad escape in upstream data is a dropped row (null), never a thrown build.
const fileStem = (url) => {
  try { return decodeURIComponent(url.pathname.split('/').pop() || '').replace(/\.[A-Za-z0-9]+$/, ''); } catch { return null; }
};
const round6 = (n) => Math.round(n * 1e6) / 1e6;

const NEIGHBOUR_STATE_NAME = /^(?:\S+\s+){0,2}(?:California|Idaho|Washington|Nevada)\s+(?:-|at)\s|\s-\s+WA\b/i;

export const ARCGIS_LAYERS = Object.freeze([
  Object.freeze({
    id: 'ky-kytc', sourceId: 'arcgisKyKytc', label: 'KYTC', states: ['ky'], pageSize: 1000,
    operator: 'Kentucky Transportation Cabinet', officialUrl: 'https://maps.kytc.ky.gov/trafficcameras/',
    serviceUrl: 'https://services2.arcgis.com/CcI36Pduqd0OR4W9/arcgis/rest/services/trafficCamerasCur_Prd/FeatureServer/0',
    imageOrigin: 'https://www.trimarc.org',
    outFields: ['OBJECTID', 'id', 'name', 'status', 'state', 'description', 'snapshot', 'updateTS'],
    read: (a) => (a.status === 'Online' ? { still: a.snapshot, name: a.description, id: a.name } : null),
  }),
  Object.freeze({
    id: 'tx-arlington', sourceId: 'arcgisTxArlington', label: 'Arlington', states: ['tx'], pageSize: 1000,
    operator: 'City of Arlington, Texas', officialUrl: 'https://experience.arcgis.com/experience/a2fceb484bd04e2c9f795e8c9ce78786',
    serviceUrl: 'https://services.arcgis.com/jXi5GuMZwfCYtZP9/arcgis/rest/services/Traffic_Camera_Updates_view/FeatureServer/0',
    imageOrigin: 'https://webapps.arlingtontx.gov',
    outFields: ['Camera_Location', 'Description', 'Status', 'Pic_URL'],
    read: (a) => (a.Status === 'Online' ? { still: a.Pic_URL, name: a.Camera_Location, idFromStill: true } : null),
  }),
  Object.freeze({
    id: 'ks-lawrence', sourceId: 'arcgisKsLawrence', label: 'Lawrence', states: ['ks'], pageSize: 2000,
    operator: 'City of Lawrence, Kansas', officialUrl: 'https://lawrenceks.maps.arcgis.com/apps/instant/basic/index.html?appid=d7c108bb6a0c405aa50a3e8168102b75',
    serviceUrl: 'https://services.arcgis.com/8O9UlSTnqjKptoda/arcgis/rest/services/Traffic_Cameras/FeatureServer/4',
    imageOrigin: 'https://assets.lawrenceks.gov',
    outFields: ['FacilityID', 'CameraType', 'Status', 'Hyperlink', 'Comments'],
    // Status 8 is the in-service code; the camera has no name field, so its picture file ("GEN_2nd & Locust.jpeg") names it.
    read: (a) => (a.Status === 8 ? { still: a.Hyperlink, id: a.FacilityID, nameFromStill: true } : null),
  }),
  Object.freeze({
    id: 'or-salem', sourceId: 'arcgisOrSalem', label: 'Salem', states: ['or'], pageSize: 1000,
    operator: 'City of Salem, Oregon', officialUrl: 'https://salem.maps.arcgis.com/apps/instant/sidebar/index.html?appid=1dc340e3cbe34aadb723d0d6dd763e15',
    serviceUrl: 'https://services.arcgis.com/kIA6yS9KDGqZL7U3/arcgis/rest/services/TrafficCams/FeatureServer/0',
    imageOrigin: 'https://egov.cityofsalem.net',
    outFields: ['OBJECTID', 'INTERSECTION', 'AGENCY', 'CAMTYPE', 'IMAGE_LINK', 'CAMERA_OFFLINE'],
    read: (a) => (a.CAMERA_OFFLINE === 'No' ? { still: a.IMAGE_LINK, name: a.INTERSECTION, id: a.OBJECTID } : null),
  }),
  Object.freeze({
    id: 'or-tripcheck', sourceId: 'arcgisOrTripcheck', label: 'TripCheck', states: ['or'], pageSize: 1000,
    operator: 'Oregon DOT (TripCheck)', officialUrl: 'https://tripcheck.com/',
    serviceUrl: 'https://services.arcgis.com/uUvqNMGPm7axC2dD/arcgis/rest/services/TripCheck_Cameras/FeatureServer/0',
    imageOrigin: 'https://tripcheck.com',
    outFields: ['ObjectId', 'attributes_title', 'attributes_route', 'attributes_filename', 'attributes_cameraId', 'attributes_videoId'],
    // The layer files border cameras of its neighbours under Oregon, named in TripCheck's own pattern:
    // one or two route words, then the state, then ' - ' or ' at ' ("I-5 Washington - Vancouver at Mill Plain",
    // "US97 California at Grass Lake"), or a trailing ' - WA' ("Grays Harbor Westport - WA (USCG)").
    // Such a name is that state's camera and is dropped; "Washington County - ..." and "at Washington
    // Park" stay. (Rows south of Oregon's 42.0N line, in California, are dropped by the unpadded state box at build time.)
    read: (a) => (NEIGHBOUR_STATE_NAME.test(String(a.attributes_title || '').trim()) ? null
      : { still: a.attributes_filename, name: a.attributes_title, id: a.attributes_cameraId }),
  }),
  Object.freeze({
    id: 'ut-udot', sourceId: 'arcgisUtUdot', label: 'UDOT', states: ['ut'], pageSize: 2000,
    operator: 'Utah DOT (UDOT Traffic)', officialUrl: 'https://www.udottraffic.utah.gov/',
    serviceUrl: 'https://services.arcgis.com/pA2nEVnB6tquxgOW/arcgis/rest/services/CCTV/FeatureServer/0',
    imageOrigin: 'https://udottraffic.utah.gov',
    outFields: ['OBJECTID', 'ExtId', 'DisplayName', 'ImageUrl', 'IsOnline', 'IsCommFailed'],
    // The layer lists the picture over http; the same address answers over https, so it is upgraded.
    upgradeHttp: true,
    placeholderLengths: Object.freeze([36809]),
    read: (a) => (a.IsOnline === 'True' ? { still: a.ImageUrl, name: a.DisplayName, id: a.ExtId } : null),
  }),
  Object.freeze({
    id: 'wa-kirkland', sourceId: 'arcgisWaKirkland', label: 'Kirkland', states: ['wa'], pageSize: 2000,
    operator: 'City of Kirkland, Washington', officialUrl: 'https://www.kirklandwa.gov/Home/My-Neighborhood/Traffic-Cameras',
    serviceUrl: 'https://services2.arcgis.com/loGMwowmR0OPlOQb/arcgis/rest/services/TRN_TrafficCams_10032022/FeatureServer/0',
    imageOrigin: 'https://its.kirklandwa.gov',
    outFields: ['OBJECTID', 'TRAFCAM_ID', 'LOCATION', 'OWNER', 'IMAGE_'],
    // Owner 'CoK' is the city's own; the layer also maps WSDOT's, Bellevue's and Redmond's cameras.
    read: (a) => (a.OWNER === 'CoK' ? { still: a.IMAGE_, name: a.LOCATION, id: a.TRAFCAM_ID } : null),
  }),
]);

/** The picture address as an exact https address on the layer's one registered host, or null.
 *  `new URL` percent-encodes a space or a control character, so a plain GET reaches the file. */
export function arcgisStill(raw, layer) {
  const text = str(typeof raw === 'string' ? raw.trim() : raw);
  if (!text) return null;
  let url;
  const fixed = layer.fixStill ? layer.fixStill(text) : text;
  try { url = new URL(layer.upgradeHttp ? fixed.replace(/^http:\/\//i, 'https://') : fixed); } catch { return null; }
  if (url.protocol !== 'https:' || url.origin !== layer.imageOrigin) return null;
  if (url.username || url.password || url.pathname.includes('//')) return null;
  return url;
}

/** Every in-service, located camera in one ArcGIS query answer (`{ features: [{ attributes,
 *  geometry: { x, y } }] }`), deduped by id (the first row wins). Anything else, a row that is not
 *  an object included, is dropped; a payload that is not a query answer normalizes to []. */
export function normalizeArcgisCameras(payload, layer, { fetchedAt } = {}) {
  const rows = payload && Array.isArray(payload.features) ? payload.features : [];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const a = row && row.attributes && typeof row.attributes === 'object' ? row.attributes : null;
    if (!a) continue;
    const got = layer.read(a);
    if (!got) continue;
    const url = arcgisStill(got.still, layer);
    const g = row.geometry;
    let lat = g ? num(g.y) : null, lon = g ? num(g.x) : null;
    if (lat !== null && lon !== null) { lat = round6(lat); lon = round6(lon); }
    if (!url || lat === null || lon === null || (lat === 0 && lon === 0)) continue;
    const stem = got.idFromStill || got.nameFromStill ? fileStem(url) : '';
    if (stem === null) continue;
    const providerId = str(String(got.idFromStill ? stem : (got.id ?? '')).trim());
    const name = str(String(got.nameFromStill ? stem.replace(/^[A-Z]{2,4}_/, '') : (got.name ?? '')).trim());
    if (!providerId || !name || seen.has(providerId)) continue;
    seen.add(providerId);
    out.push(Object.freeze({
      provider: layer.id, providerId, name, lat, lon,
      locationPrecision: precisionFor(lat, lon),
      category: ARCGIS_CATEGORY,
      operator: layer.operator,
      officialUrl: layer.officialUrl,
      subject: null, bearing: null,
      media: { still: url.href, stream: null, streamKind: null },
      capturedAt: null,
      fetchedAt: fetchedAt || new Date().toISOString(),
      validUntil: null,
      rights: RIGHTS,
      attribution: layer.operator,
      health: 'active',
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// CARS (Castle Rock) camera lists. Minnesota, Indiana and Kansas each publish one keyless
// JSON list (`<state>tg.carsprogram.org/cameras_v1/api/cameras`: id, name, location, cameraOwner,
// views[{ type, url, videoPreviewUrl, imageTimestamp }]), and Spokane's SRTMC publishes its own
// cameras (and WSDOT's, which are dropped) through a GraphQL map query. A camera's picture is its first STILL_IMAGE view, else the
// preview picture of a video view; the video address itself (it carries a short-lived token) is
// never kept. Measured 2026-10-04 with a plain GET and the build's own user agent: the lists answer
// without a key or a cookie, and the pictures answer 200 image/* with a current Last-Modified.
//
// Terms were read on each operator's own page before it was added (the quotes are in the PR): the
// MN, IN, KS and SRTMC pages are disclaimers with no clause against copying or republishing a
// picture. Iowa DOT's terms forbid copying and republishing without written consent, Colorado's
// COtrip terms (added 2026-10-05) are a disclaimer with no such clause, and New York's 511NY and NYSDOT pages hold no terms text at all (the
// ny.gov disclaimer covers only links leaving the portal), so neither Iowa nor New York is here. Rights stay 'unverified' and the credit is the
// operator's name.
//
// A picture is kept only when the list's owner is the credited operator (Kansas), its address is an
// exact https address on a host registered for the feed, and (when the list stamps it) the stamp is under a day old.
export const CARS_STALE_MS = 24 * 60 * 60 * 1000;
const CARS_HOST = 'https://public.carsprogram.org';
const CARS_CATEGORY = 'road';

export const CARS_FEEDS = Object.freeze([
  Object.freeze({
    id: 'mn-511', kind: 'cars', label: 'MnDOT', states: ['mn'],
    operator: 'Minnesota DOT (511MN)', officialUrl: 'https://511mn.org/list/cameras',
    listUrl: 'https://mntg.carsprogram.org/cameras_v1/api/cameras',
    imageOrigins: [CARS_HOST], sourceIds: ['carsPublic'],
  }),
  Object.freeze({
    id: 'in-511', kind: 'cars', label: 'INDOT', states: ['in'],
    operator: 'Indiana DOT (511IN)', officialUrl: 'https://511in.org/list/cameras',
    listUrl: 'https://intg.carsprogram.org/cameras_v1/api/cameras',
    imageOrigins: [CARS_HOST], sourceIds: ['carsPublic'],
  }),
  Object.freeze({
    id: 'ks-kandrive', kind: 'cars', label: 'KDOT', states: ['ks'],
    operator: 'Kansas DOT (KanDrive)', officialUrl: 'https://kandrive.gov/list/cameras',
    listUrl: 'https://kstg.carsprogram.org/cameras_v1/api/cameras',
    imageOrigins: ['https://kscam.carsprogram.org'], sourceIds: ['carsKs'],
    // The list also holds City of Topeka, Kansas Turnpike Authority and KC Scout cameras; only
    // the credited operator's own rows are kept.
    owners: Object.freeze(['KDOT ITS', 'KDOT RWIS']),
  }),
  Object.freeze({
    id: 'wa-srtmc', kind: 'srtmc', label: 'SRTMC', states: ['wa'],
    operator: 'Spokane Regional Transportation Management Center', officialUrl: 'https://srtmc.org/list/cameras',
    listUrl: 'https://www.srtmc.org/api/graphql',
    // The Spokane County box the map query asks for, [south, north, west, east].
    bbox: [47.2, 48.3, -118.0, -116.8],
    // Only SRTMC's own pictures: the map query also lists WSDOT's pictures on public.carsprogram.org.
    imageOrigins: ['https://images.srtmc.org'], sourceIds: ['srtmcImages'],
  }),
  Object.freeze({
    id: 'co-cotrip', kind: 'cars', label: 'CDOT', states: ['co'],
    operator: 'Colorado DOT (COtrip)', officialUrl: 'https://www.cotrip.org/',
    listUrl: 'https://cotg.carsprogram.org/cameras_v1/api/cameras',
    imageOrigins: ['https://cocam.carsprogram.org'], sourceIds: ['carsCo'],
    // Only CDOT's own rows (the list also holds other owners' cameras).
    owners: Object.freeze(['Colorado DOT', 'CDOT Cellular']),
  }),
]);

/** A picture address as an exact https address on one of the feed's hosts, or null. `new URL`
 *  drops a default port (":443"); the query is dropped too, since on these hosts it is only a
 *  cache-buster that would change every build. */
function carsStill(raw, feed) {
  const text = str(typeof raw === 'string' ? raw.trim() : raw);
  if (!text) return null;
  let url;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== 'https:' || !feed.imageOrigins.includes(url.origin)) return null;
  if (url.username || url.password || url.pathname.includes('//')) return null;
  url.search = ''; url.hash = '';
  return url;
}

const stampOf = (ms) => (Number.isFinite(Number(ms)) && Number(ms) > 0 ? Number(ms) : null);
const fetchedMs = (fetchedAt) => (Number.isFinite(Date.parse(fetchedAt)) ? Date.parse(fetchedAt) : Date.now());

function carsRecord(feed, { providerId, name, lat, lon, still }, fetchedAt) {
  return Object.freeze({
    provider: feed.id, providerId, name, lat, lon,
    locationPrecision: precisionFor(lat, lon),
    category: CARS_CATEGORY,
    operator: feed.operator,
    officialUrl: feed.officialUrl,
    subject: null, bearing: null,
    media: { still: still.href, stream: null, streamKind: null },
    capturedAt: null,
    fetchedAt: fetchedAt || new Date().toISOString(),
    validUntil: null,
    rights: RIGHTS,
    attribution: feed.operator,
    health: 'active',
  });
}

/** Every public, active, located camera in a CARS list (an array of rows), deduped by id, whose
 *  picture is on a registered host and not stale by the list's own stamp. Anything else, a row
 *  that is not an object included, is dropped; a payload that is not a list normalizes to []. */
export function normalizeCarsCameras(payload, feed, { fetchedAt } = {}) {
  const rows = Array.isArray(payload) ? payload : [];
  const now = fetchedMs(fetchedAt);
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || row.public !== true || row.active === false) continue;
    if (feed.owners && !(row.cameraOwner && feed.owners.includes(row.cameraOwner.name))) continue;
    const lat = row.location ? num(row.location.latitude) : null;
    const lon = row.location ? num(row.location.longitude) : null;
    if (lat === null || lon === null || (lat === 0 && lon === 0)) continue;
    const providerId = row.id === undefined || row.id === null ? null : str(String(row.id));
    const name = typeof row.name === 'string' ? str(row.name.trim()) : null;
    if (!providerId || !name || seen.has(providerId)) continue;
    let still = null, stamp = null;
    for (const v of Array.isArray(row.views) ? row.views : []) {
      if (!v || typeof v !== 'object') continue;
      still = carsStill(v.type === 'STILL_IMAGE' ? v.url : v.videoPreviewUrl, feed);
      if (still) { stamp = stampOf(v.imageTimestamp); break; }
    }
    if (!still || (stamp !== null && now - stamp > CARS_STALE_MS)) continue;
    seen.add(providerId);
    out.push(carsRecord(feed, { providerId, name, lat, lon, still }, fetchedAt));
  }
  return out;
}

/** The same for SRTMC's GraphQL answer (`{ data: { mapFeaturesQuery: { mapFeatures } } }`): active
 *  Camera features with a picture on a registered host. The camera id is the number in its `uri`
 *  ("camera/513"); the position is GeoJSON, longitude first. Only SRTMC's own
 *  images.srtmc.org pictures pass the host check; the WSDOT pictures on public.carsprogram.org that
 *  the same map shows are dropped. */
export function normalizeSrtmcCameras(payload, feed, { fetchedAt } = {}) {
  const q = payload && payload.data && payload.data.mapFeaturesQuery;
  const rows = q && Array.isArray(q.mapFeatures) ? q.mapFeatures : [];
  const now = fetchedMs(fetchedAt);
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row || row.__typename !== 'Camera' || row.active !== true) continue;
    const idMatch = typeof row.uri === 'string' ? /^camera\/(\d+)$/.exec(row.uri) : null;
    const coords = row.features && row.features[0] && row.features[0].geometry && row.features[0].geometry.coordinates;
    const lon = Array.isArray(coords) ? num(coords[0]) : null, lat = Array.isArray(coords) ? num(coords[1]) : null;
    const name = typeof row.title === 'string' ? str(row.title.trim()) : null;
    if (!idMatch || !name || lat === null || lon === null || (lat === 0 && lon === 0) || seen.has(idMatch[1])) continue;
    let still = null, stamp = null;
    for (const v of Array.isArray(row.views) ? row.views : []) {
      if (!v || typeof v.url !== 'string') continue;
      still = carsStill(v.url, feed);
      if (still) { const m = /\?(\d{12,})$/.exec(v.url); stamp = m ? stampOf(m[1]) : null; break; }
    }
    if (!still || (stamp !== null && now - stamp > CARS_STALE_MS)) continue;
    seen.add(idMatch[1]);
    out.push(carsRecord(feed, { providerId: idMatch[1], name, lat, lon, still }, fetchedAt));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Iteris CDN GeoJSON (Virginia, South Dakota) and Socrata SODA (Austin, Baton
// Rouge): two more adapters on the ArcGIS pattern above. Each operator is its own provider id with
// its own field map (`read`), a registry host entry (the one image origin) and the same row gates:
// in service, a real position, and an exact https picture address on the one registered host.
// Fixtures: scripts/qcm/fixtures/iteris-cameras-2026-10-04.min.json and socrata-cameras-2026-10-04
// .min.json, real rows copied unchanged, measured 2026-10-04 with a plain GET and the build's own
// user agent: every picture answered 200 image/* and was minutes old by Last-Modified (Austin: about
// 1 in 40 sampled pictures answered 403, a camera whose file is missing, which is why a located
// camera is only as live as its picture; the card says when the list was last checked, not when the
// picture was taken). Rights stay 'unverified' for every row.
//
// Montana (mt.cdn.iteris-atis.com) runs the same CDN but its terms forbid redistribution without
// MDT's written permission, so it has no row here and no host in the registry. South Carolina is
// left out for the same reason: the SCDOT Disclaimer (https://www.511sc.org/static/disclaimer.html,
// read 2026-10-04) says "You may not modify, publish, transmit, display ... or in any way exploit,
// any of the content ... without the express written permission of SCDOT".
//
// Terms pages actually read on 2026-10-04 (plain GET):
//  - Virginia: https://511.vdot.virginia.gov/ is an app shell; every path returns the same page and
//    its script names only an SMS terms-of-service link. No terms page was found. The vdot.virginia.gov
//    footer reads only "(c) Copyright 2026, VDOT. All rights reserved". Virginia stays 'unverified'
//    with operator credit and an owner link (owner's standing rule), not a grant.
//  - South Dakota: the Disclaimer (https://www.sd.gov/kb_view.do?sysparm_article=KB0010221) reads:
//    "Anyone may view, copy or distribute information found on the State's website for personal or
//    informational use without owing an obligation to the State." That grant is for personal or
//    informational use, which this free informational map is; rights stay 'unverified' (the page
//    covers the State's website, not the picture host by name) and the operator is credited.
//  - Austin: the picture host's own operator site, https://austinmobility.io/ (Austin Transportation
//    and Public Works), links its footer Disclaimer to the City's Open Data Terms of Use
//    (https://datahub.austintexas.gov/stories/s/City-of-Austin-Open-Data-Terms-of-Use/ranj-cccq/),
//    the governing page. It says data "are offered free and without restriction", that "Data and
//    content created by City of Austin government employees within the scope of their employment are
//    not subject to copyright protection", and asks for attribution "to both the City of Austin and
//    the City Department that is the source of the cited data", so the credit names both. (The
//    austintexas.gov legal notice covers that website, not these pictures, and is not relied on.)
//  - Baton Rouge: https://511la.org/about/disclaimer has only warranty language and a My 511 account
//    terms of use; no sentence about copying or reusing pictures. Its dataset metadata
//    (https://data.brla.gov/api/views/6z6u-ts44.json) reads license 'Public Domain'.
//
// Austin's dataset metadata (https://datahub.austintexas.gov/api/views/b4k4-adkb.json, 2026-10-04)
// reads license { name: 'Public Domain' }, licenseId PUBLIC_DOMAIN. That licenses the list of
// locations; the pictures are served from cctv.austinmobility.io and are not named by it, so the
// rows stay 'unverified' rather than borrow the dataset's licence.

/** One camera record from an adapter's already-checked parts. `url` is a URL object. */
function cameraRecord(layer, { providerId, name, lat, lon, url, fetchedAt }) {
  return Object.freeze({
    provider: layer.id, providerId, name, lat, lon,
    locationPrecision: precisionFor(lat, lon),
    category: ARCGIS_CATEGORY,
    operator: layer.operator,
    officialUrl: layer.officialUrl,
    subject: null, bearing: null,
    media: { still: url.href, stream: null, streamKind: null },
    capturedAt: null,
    fetchedAt: fetchedAt || new Date().toISOString(),
    validUntil: null,
    rights: RIGHTS,
    attribution: layer.operator,
    health: 'active',
  });
}

/** The operator lists a thumbnail at `/thumbs/<id>.flv.png`, which answers 301 to `/<id>.png`. */
const thumbToStill = (text) => text.replace(/^(https:\/\/[^/]+)\/thumbs\/([^/]+)\.flv\.png$/, '$1/$2.png');
const trimmed = (v) => str(typeof v === 'string' ? v.trim() : v);

const ITERIS_LIST = '/geojson/icons/metadata/icons.cameras.geojson';
export const ITERIS_LAYERS = Object.freeze([
  Object.freeze({
    id: 'va-vdot', sourceId: 'iterisVaVdot', label: 'VDOT', states: ['va'],
    operator: 'Virginia DOT (VDOT)', officialUrl: 'https://511.vdot.virginia.gov/',
    listUrls: Object.freeze(['https://data.511-atis-ttrip-prod.iteriscloud.com/datasets/cameras/icons.cameras.geojson']),
    imageOrigin: 'https://snapshot.vdotcameras.com', fixStill: thumbToStill,
    read: (p) => (p.active === true ? { still: p.image_url, name: p.description, id: p.id } : null),
  }),
  Object.freeze({
    id: 'sd-sddot', sourceId: 'iterisSdSddot', label: 'SDDOT', states: ['sd'],
    operator: 'South Dakota DOT (SDDOT)', officialUrl: 'https://www.sd511.org/',
    listUrls: Object.freeze([`https://sd.cdn.iteris-atis.com${ITERIS_LIST}`, 'https://sd.cdn.iteris-atis.com/geojson/icons/metadata/icons.rwis.geojson']),
    imageOrigin: 'https://sd.cdn.iteris-atis.com',
    // One pin per site: the site's stills in list order; the card shows the first still that is on the registered host.
    read: (p, row) => {
      const route = trimmed(p.route) || trimmed(p.description);
      const name = trimmed(p.name);
      return {
        still: (Array.isArray(p.cameras) ? p.cameras : []).map((c) => (c && typeof c === 'object' ? c.image : null)),
        name: name && route ? `${name} (${route})` : name, id: row.id,
      };
    },
  }),
]);

/** Every in-service, located camera in one merged Iteris answer (`{ features: [GeoJSON Point
 *  features] }`), deduped by id (the first row wins). Anything else is dropped; a payload that is
 *  not a feature list normalizes to []. */
export function normalizeIterisCameras(payload, layer, { fetchedAt } = {}) {
  const rows = payload && Array.isArray(payload.features) ? payload.features : [];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const p = row && row.properties && typeof row.properties === 'object' ? row.properties : null;
    if (!p) continue;
    const got = layer.read(p, row);
    if (!got) continue;
    const url = [].concat(got.still).map((raw) => arcgisStill(raw, layer)).find(Boolean);
    const g = row.geometry;
    const c = g && g.type === 'Point' && Array.isArray(g.coordinates) ? g.coordinates : [];
    const lon = num(c[0]), lat = num(c[1]);
    if (!url || lat === null || lon === null || (lat === 0 && lon === 0)) continue;
    const providerId = str(String(got.id ?? '').trim());
    const name = str(String(got.name ?? '').trim());
    if (!providerId || !name || seen.has(providerId)) continue;
    seen.add(providerId);
    out.push(cameraRecord(layer, { providerId, name, lat, lon, url, fetchedAt }));
  }
  return out;
}

export const SOCRATA_LAYERS = Object.freeze([
  Object.freeze({
    id: 'tx-austin', sourceId: 'socrataTxAustin', label: 'Austin', states: ['tx'], pageSize: 1000,
    operator: 'City of Austin Transportation and Public Works', officialUrl: 'https://data.austintexas.gov/d/b4k4-adkb',
    resourceUrl: 'https://datahub.austintexas.gov/resource/b4k4-adkb.json',
    imageOrigin: 'https://cctv.austinmobility.io',
    outFields: ['camera_id', 'location_name', 'camera_status', 'screenshot_address', 'location'],
    read: (r) => (r.camera_status === 'TURNED_ON'
      ? { still: r.screenshot_address, name: r.location_name, id: r.camera_id, point: r.location } : null),
  }),
  Object.freeze({
    id: 'la-batonrouge', sourceId: 'socrataLaBatonrouge', label: 'Baton Rouge', states: ['la'], pageSize: 1000,
    operator: 'City of Baton Rouge / LA DOTD', officialUrl: 'https://data.brla.gov/d/6z6u-ts44',
    resourceUrl: 'https://data.brla.gov/resource/6z6u-ts44.json',
    imageOrigin: 'https://511la.org',
    outFields: ['id', 'image_view', 'the_geom'],
    // The dataset has no name column: the picture's own code (".../map/Cctv/b24--1") names the camera.
    read: (r) => {
      const code = typeof r.image_view === 'string' ? /^https:\/\/511la\.org\/map\/Cctv\/([A-Za-z0-9._-]+?)--\d+$/.exec(r.image_view.trim()) : null;
      return code ? { still: r.image_view, name: `Baton Rouge traffic camera ${code[1]}`, id: r.id, point: r.the_geom } : null;
    },
  }),
]);

/** Every in-service, located camera in one Socrata answer (`{ rows: [row] }`), deduped by id. */
export function normalizeSocrataCameras(payload, layer, { fetchedAt } = {}) {
  const rows = payload && Array.isArray(payload.rows) ? payload.rows : [];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const got = layer.read(row);
    if (!got) continue;
    const url = arcgisStill(got.still, layer);
    const pt = got.point;
    const c = pt && pt.type === 'Point' && Array.isArray(pt.coordinates) ? pt.coordinates : [];
    const lon = num(c[0]), lat = num(c[1]);
    if (!url || lat === null || lon === null || (lat === 0 && lon === 0)) continue;
    const providerId = str(String(got.id ?? '').trim());
    const name = str(String(got.name ?? '').trim());
    if (!providerId || !name || seen.has(providerId)) continue;
    seen.add(providerId);
    out.push(cameraRecord(layer, { providerId, name, lat, lon, url, fetchedAt }));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// WSDOT ferry terminal cameras. WSDOT's ferry map answers one JSON list (build-camera-snapshot.mjs turns it
// into GeoJSON-shaped rows so normalizeIterisCameras reads it). The list also carries WSDOT's road cameras
// near each terminal (SR 305, orflow and nw pictures); only the pictures under /wsf/ are the terminals' own,
// so every other row is dropped here, which keeps any WSDOT road-camera list from being published twice.
// True only for a picture file whose own path (after URL parsing) sits under /wsf/ with no dot segment, no
// percent-encoded dot or slash, and no backslash, whitespace or control character (which URL parsing would
// silently drop or turn into a slash), so a "/wsf/../orflow/..." road picture cannot pass the prefix check.
function wsfTerminalPicture(raw) {
  if (typeof raw !== 'string' || /%2[ef]|[\\\s\x00-\x1f\x7f]/i.test(raw)) return false;
  let url;
  try { url = new URL(raw); } catch { return false; }
  if (url.origin !== 'https://images.wsdot.wa.gov' || !url.pathname.startsWith('/wsf/') || url.pathname.endsWith('/')) return false;
  return !/(^|\/)\.\.?(\/|$)/.test(raw.slice(url.origin.length).split(/[?#]/)[0]);
}
export const WSF_LAYER = Object.freeze({
  id: 'wa-wsf', sourceId: 'wsdotWaFerries', label: 'WSF terminals', states: ['wa'],
  operator: 'Washington State Ferries (WSDOT)', officialUrl: 'https://www.wsdot.wa.gov/ferries/vesselwatch/default.aspx',
  listUrls: Object.freeze(['https://wsdot.com/ferries/vesselwatch/Cameras.ashx']),
  imageOrigin: 'https://images.wsdot.wa.gov',
  read: (p) => (p.active === true && wsfTerminalPicture(p.image_url)
    ? { still: p.image_url, name: p.title, id: p.id } : null),
});

// ---------------------------------------------------------------------------------------------
// PhenoCam Network and AviationWX: two keyless camera networks their owners publish as JSON lists.
// The build reads each list once (build-camera-snapshot.mjs); the reader's browser then loads one
// picture straight from the owner's host when a pin is opened (an <img src>, so the host is in
// img-src and never connect-src). Nothing here stores a picture.
//
// PhenoCam's list carries each site's contact1/contact2 (a person's name and an obfuscated
// address). The normalizer builds a record from a fixed set of fields and never reads those two,
// so the record has no slot a person could be copied into.

const PHENOCAM_PROVIDER = 'phenocam';
const PHENOCAM_OPERATOR = 'PhenoCam Network';
const PHENOCAM_CREDIT = 'PhenoCam Network (CC BY)'; // the site page credits the site's own PI
const PHENOCAM_HOME = 'https://phenocam.nau.edu/';
const PHENOCAM_MAX_AGE_DAYS = 30;
// A Sitename goes into a URL path: letters, digits, dot, dash, underscore only ("NEON.D01.HARV...").
const PHENOCAM_SITENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PHENOCAM_NAME_MAX = 160;
const PHENOCAM_ADDRESS = /[@＠]|\bat\b[^.]{0,60}?\bdot\b|\bat\b\)?\s*[a-z0-9-]+(\.[a-z0-9-]+)*\.(gov|edu|org|com|net|us|ca)\b/i;

const AVIATIONWX_PROVIDER = 'aviationwx';
const AVIATIONWX_OPERATOR = 'AviationWX.org';
const AVIATIONWX_CREDIT = 'Weather data from AviationWX.org'; // meta.attribution of the list
const AVIATIONWX_HOME = 'https://aviationwx.org/';
const AVIATIONWX_ID = /^[a-z0-9][a-z0-9-]*$/;

/** One PhenoCam site, in the shared record shape. Never throws; null when the Sitename cannot be
 *  put safely into a URL. Reads Sitename, Lat, Lon and sitemetadata.site_description only. */
export function normalizePhenocamSite(site, { fetchedAt } = {}) {
  const id = site && typeof site.Sitename === 'string' ? site.Sitename : '';
  if (!PHENOCAM_SITENAME.test(id)) return null;
  const description = site.sitemetadata && str(site.sitemetadata.site_description);
  // A description that holds an address ("@", or the list's "x AT y DOT z" / "x at y dot z" form)
  // is never published: the Sitename stands in.
  const clean = description && !PHENOCAM_ADDRESS.test(description) ? description.trim() : '';
  const name = clean || id;
  const lat = num(site.Lat), lon = num(site.Lon);
  return Object.freeze({
    provider: PHENOCAM_PROVIDER,
    providerId: id,
    name: name.length > PHENOCAM_NAME_MAX ? `${name.slice(0, PHENOCAM_NAME_MAX - 1)}…` : name,
    lat, lon,
    locationPrecision: precisionFor(lat, lon),
    category: 'scenic',
    operator: PHENOCAM_OPERATOR,
    officialUrl: `https://phenocam.nau.edu/webcam/sites/${id}/`,
    subject: null,
    bearing: null,
    media: { still: `https://phenocam.nau.edu/data/latest/${id}.jpg`, stream: null, streamKind: null },
    capturedAt: null,
    fetchedAt: fetchedAt || new Date().toISOString(),
    validUntil: null,
    rights: 'CC BY',
    attribution: PHENOCAM_CREDIT,
    health: 'active',
  });
}

/** Every PhenoCam site in one list payload (`{ results: [...] }`) that is active and whose
 *  `date_last` is within 30 days of `fetchedAt` (the build date), once per Sitename. A payload
 *  that is not the list gives no cameras. Where a site is (the US or not) is the builder's call. */
export function normalizePhenocam(payload, { fetchedAt } = {}) {
  const rows = payload && Array.isArray(payload.results) ? payload.results : [];
  const now = Date.parse(fetchedAt || new Date().toISOString());
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row || row.active !== true) continue;
    const last = typeof row.date_last === 'string' ? Date.parse(row.date_last) : NaN;
    // whole days: a date_last is a calendar day, the build date has a time of day
    if (!Number.isFinite(last) || Math.floor((now - last) / 86400000) > PHENOCAM_MAX_AGE_DAYS) continue;
    const record = normalizePhenocamSite(row, { fetchedAt });
    if (record && !seen.has(record.providerId)) { seen.add(record.providerId); out.push(record); }
  }
  return out;
}

/** Every webcam of every listed airport in one `/v1/airports` payload: one record per webcam
 *  index 0..webcam_count-1 (zero-based, checked live 2026-10-04: webcams/2 is a 404 for an
 *  airport with webcam_count 2). Unlisted airports and airports with no webcam are skipped. The
 *  owner page is the airport's own `<id>.aviationwx.org` page; the credit is the API's
 *  meta.attribution. */
export function normalizeAviationwx(payload, { fetchedAt } = {}) {
  const airports = payload && Array.isArray(payload.airports) ? payload.airports : [];
  const credit = (payload && payload.meta && str(payload.meta.attribution)) || AVIATIONWX_CREDIT;
  const out = [];
  for (const a of airports) {
    if (!a || a.has_webcams !== true || a.unlisted === true) continue;
    const id = typeof a.id === 'string' ? a.id : '';
    const count = Number.isInteger(a.webcam_count) ? a.webcam_count : 0;
    const lat = num(a.lat), lon = num(a.lon);
    if (!AVIATIONWX_ID.test(id) || count < 1 || lat === null || lon === null) continue;
    // Only the airport's own host is trusted as the owner page; anything else falls back to it.
    const own = `https://${id}.aviationwx.org/`;
    const page = typeof a.url === 'string' && a.url.startsWith(own) ? a.url : own;
    for (let n = 0; n < count; n += 1) {
      out.push(Object.freeze({
        provider: AVIATIONWX_PROVIDER,
        providerId: `${id}:${n}`,
        name: count > 1 ? `${str(a.name) || id} (camera ${n + 1})` : (str(a.name) || id),
        lat, lon,
        locationPrecision: 'exact',
        category: 'scenic',
        operator: AVIATIONWX_OPERATOR,
        officialUrl: page,
        subject: null,
        bearing: null,
        media: { still: `https://api.aviationwx.org/v1/airports/${id}/webcams/${n}/image?size=720`, stream: null, streamKind: null },
        capturedAt: null,
        fetchedAt: fetchedAt || new Date().toISOString(),
        validUntil: null,
        rights: 'unverified',
        attribution: credit,
        health: a.maintenance === true ? 'inactive' : 'active',
      }));
    }
  }
  return out;
}
export { PHENOCAM_HOME, AVIATIONWX_HOME };

// ---------------------------------------------------------------------------------------------
// USGS VolcView / AVO ashcams and NOAA GLERL Great Lakes cameras (keyless, owner-published).
// Terms read 2026-10-05 and quoted in content/quiet-corners-maps.md. Both are credited and linked
// to the owner; rights stay 'unverified' (the USGS page says some non-USGS images on its sites are
// used with permission, and GLERL asks only for a byline), so the card links back to the owner.

const VOLCVIEW_PROVIDER = 'volcview';
const VOLCVIEW_OPERATOR = 'USGS VolcView';
const VOLCVIEW_HOME = 'https://volcview.wr.usgs.gov/';
const VOLCVIEW_IMAGES = 'https://volcview.wr.usgs.gov/ashcam-api/images/';
const VOLCVIEW_PAGE = 'https://volcview.wr.usgs.gov/ashcam-gui/webcam.html?webcam=';
const VOLCVIEW_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const VOLCVIEW_SKEW_MS = 10 * 60 * 1000;
const VOLCVIEW_DEDUPE_M = 50;
const VOLCVIEW_VIA = ', via USGS VolcView';
const VOLCVIEW_FEDERAL_CREDIT = 'USGS Volcano Hazards Program';
// The AVO API names each camera's `organization`. A camera it does not name is credited by the
// page it links to (`externalUrl`); one that links to a private or state owner is not published.
const VOLCVIEW_ORG_CREDIT = Object.freeze({
  AVO: `Alaska Volcano Observatory${VOLCVIEW_VIA}`,
  HVO: `USGS Hawaiian Volcano Observatory${VOLCVIEW_VIA}`,
  YVO: `USGS Yellowstone Volcano Observatory${VOLCVIEW_VIA}`,
  FAA: `FAA weather cameras${VOLCVIEW_VIA}`,
});

function volcviewOwnerCredit(cam, organization) {
  if (organization !== null && organization !== undefined && organization !== '') {
    // The feed names an owner: credit a known federal or observatory one, drop any other (UAF, DGGS, WSDOT,
    // private: their terms are unchecked). Only a camera with no named organization falls to its link.
    // A value that is not a string (an object, a list, a number) names no known owner either.
    return typeof organization === 'string' && Object.hasOwn(VOLCVIEW_ORG_CREDIT, organization) ? VOLCVIEW_ORG_CREDIT[organization] : null;
  }
  const link = str(cam.externalUrl);
  if (!link) return VOLCVIEW_FEDERAL_CREDIT;
  let host = '';
  try { host = new URL(link).hostname.toLowerCase(); } catch { return null; }
  if (/^(avcams|avcamsplus|weathercams)\.faa\.gov$/.test(host)) return VOLCVIEW_ORG_CREDIT.FAA;
  if (host === 'nps.gov' || host.endsWith('.nps.gov')) return `National Park Service${VOLCVIEW_VIA}`;
  if (host === 'usgs.gov' || host.endsWith('.usgs.gov')) return VOLCVIEW_FEDERAL_CREDIT;
  return null;
}

const volcviewList = (list) => (list && Array.isArray(list.webcams) ? list.webcams.filter((w) => w && typeof w === 'object') : []);
const volcviewKey = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '');
const metresApart = (a, b) => Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180));

/** Every VolcView camera in one `{ volcview: <ashcam list>, avo: <ashcam list> }` payload that has an
 *  owner this site may credit, a position, a picture on the VolcView image host and a newest
 *  picture under 24 hours old at `fetchedAt`. A camera is one record per `webcamCode` (the AVO list
 *  repeats most of the VolcView list), and one named the same within 50 m of another is the same
 *  camera under a second code. A camera only the AVO list has is skipped: its picture is on a host
 *  this site does not pin. The feed's bearing is never read. */
export function normalizeVolcview(payload, { fetchedAt } = {}) {
  const at = fetchedAt || new Date().toISOString();
  const now = Date.parse(at);
  const organizations = new Map(volcviewList(payload && payload.avo).map((w) => [w.webcamCode, w.organization]));
  const candidates = [];
  const seen = new Set();
  for (const cam of volcviewList(payload && payload.volcview)) {
    const code = typeof cam.webcamCode === 'string' && cam.webcamCode.length <= 80 ? cam.webcamCode : '';
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const lat = num(cam.latitude), lon = num(cam.longitude);
    const stamp = Number.isFinite(cam.lastImageTimestamp) ? cam.lastImageTimestamp * 1000 : NaN;
    const still = typeof cam.currentImageUrl === 'string' && cam.currentImageUrl.startsWith(VOLCVIEW_IMAGES) ? cam.currentImageUrl : null;
    const credit = volcviewOwnerCredit(cam, organizations.get(code));
    if (!still || !credit || lat === null || lon === null || (lat === 0 && lon === 0)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if (!(stamp > 0) || !(now - stamp <= VOLCVIEW_MAX_AGE_MS) || stamp - now > VOLCVIEW_SKEW_MS) continue;
    const name = str(cam.webcamName) || code;
    candidates.push({ code, name: name.length > 80 ? `${name.slice(0, 79)}…` : name, lat, lon, still, credit, stamp });
  }
  candidates.sort((x, y) => (y.stamp - x.stamp) || (x.code < y.code ? -1 : 1));
  const kept = [];
  for (const c of candidates) {
    const key = volcviewKey(c.name);
    if (kept.some((k) => volcviewKey(k.name) === key && metresApart(k, c) < VOLCVIEW_DEDUPE_M)) continue;
    kept.push(c);
  }
  return kept.sort((x, y) => (x.code < y.code ? -1 : 1)).map((c) => Object.freeze({
    provider: VOLCVIEW_PROVIDER,
    providerId: c.code,
    name: c.name,
    lat: c.lat, lon: c.lon,
    locationPrecision: 'exact',
    category: 'scenic',
    operator: VOLCVIEW_OPERATOR,
    officialUrl: `${VOLCVIEW_PAGE}${encodeURIComponent(c.code)}`,
    subject: null,
    bearing: null,
    media: { still: c.still, stream: null, streamKind: null },
    capturedAt: null,
    fetchedAt: at,
    validUntil: null,
    rights: 'unverified',
    attribution: c.credit,
    health: 'active',
  }));
}

const GLERL_PROVIDER = 'glerl';
const GLERL_OPERATOR = 'NOAA GLERL';
const GLERL_HOME = 'https://www.glerl.noaa.gov/metdata/';
const GLERL_CREDIT = 'NOAA Great Lakes Environmental Research Laboratory (GLERL)';
const glerlPage = (code) => `${GLERL_HOME}${code}/`;
const glerlRecon = (code) => `https://www.glerl.noaa.gov/res/recon/station-${code}.html`;
/** The stations that have cameras on https://www.glerl.noaa.gov/metdata/ on 2026-10-05, with the
 *  position GLERL's own map on that page gives (mkglight: the degrees on its station page,
 *  43 13' 36" N 86 20' 29" W) and the station page the card links to. A camera is
 *  `<code>NN.jpg` in the table; a code not listed here has no known position and is skipped. */
export const GLERL_STATIONS = Object.freeze([
  { code: 'apn', name: 'Alpena Light', lat: 45.060359, lon: -83.422986, page: glerlPage('apn') },
  { code: 'chi', name: 'Chicago Station', lat: 41.916516, lon: -87.572113, page: glerlPage('chi') },
  { code: 'mcy', name: 'Michigan City Pier', lat: 41.728913, lon: -86.911559, page: glerlPage('mcy') },
  { code: 'mkg', name: 'Muskegon Station', lat: 43.226847, lon: -86.338736, page: glerlPage('mkg') },
  { code: 'mkglight', name: 'Muskegon Light', lat: 43.226667, lon: -86.341389, page: glerlPage('mkglight') },
  { code: 'shv', name: 'South Haven Pier', lat: 42.401334, lon: -86.287934, page: glerlPage('shv') },
  { code: 'srl', name: 'Spectacle Reef Light', lat: 45.773104, lon: -84.138083, page: glerlRecon('srl') },
  { code: 'std', name: 'Stannard Rock Light', lat: 47.183457, lon: -87.225097, page: glerlRecon('std') },
  { code: 'tbi', name: 'Thunder Bay Island Station', lat: 45.034817, lon: -83.19415, page: glerlPage('tbi') },
  { code: 'wsl', name: 'White Shoal Light', lat: 45.84181, lon: -85.1357, page: glerlRecon('wsl') },
].map(Object.freeze));

/** Every GLERL camera in the table of `{ metdataHtml }` (the text of the /metdata/ page) whose
 *  station is in GLERL_STATIONS, once per camera. A commented-out camera and a thumbnail are not
 *  cameras. Whether a still is still fresh is the builder's HEAD check, not this function's. */
export function normalizeGlerl(payload, { fetchedAt } = {}) {
  const html = payload && typeof payload.metdataHtml === 'string' ? payload.metdataHtml.replace(/<!--[\s\S]*?-->/g, '') : '';
  const stations = new Map(GLERL_STATIONS.map((s) => [s.code, s]));
  const seen = new Set();
  const out = [];
  for (const [, code, nn] of html.matchAll(/<a\s+href="cams\/([a-z]+)(\d\d)\.jpg[^"]*"/g)) {
    const station = stations.get(code);
    const id = `${code}${nn}`;
    if (!station || seen.has(id)) continue;
    seen.add(id);
    out.push(Object.freeze({
      provider: GLERL_PROVIDER,
      providerId: id,
      name: `${station.name} (camera ${Number(nn)})`,
      lat: station.lat, lon: station.lon,
      locationPrecision: 'exact',
      category: 'scenic',
      operator: GLERL_OPERATOR,
      officialUrl: station.page,
      subject: null,
      bearing: null,
      media: { still: `${GLERL_HOME}cams/${id}.jpg`, stream: null, streamKind: null },
      capturedAt: null,
      fetchedAt: fetchedAt || new Date().toISOString(),
      validUntil: null,
      rights: 'unverified',
      attribution: GLERL_CREDIT,
      health: 'active',
    }));
  }
  return out;
}
export { VOLCVIEW_HOME, GLERL_HOME };
