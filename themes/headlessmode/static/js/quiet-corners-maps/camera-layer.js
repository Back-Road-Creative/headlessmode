// Road/park camera layer: pure logic only -- no DOM, no Leaflet, no globals, except
// fetchCaltransCctv, which takes its fetch implementation by injection so this module never
// touches the network on its own. main.js owns every DOM/Leaflet side effect (drawing pins,
// wiring popupopen/popupclose, painting the report paragraph).
//
// fetchCaltransCctv lives here, not in source-camera.js, on purpose (QUX-08D.md D15): it keeps
// this 08D-i unit off the file #596/08C rewrites, so 08D-i never waits on that PR. Since U4a the
// page no longer calls it: the road list is the build-time snapshot (cameras/index.json plus one
// file per area), read by map area with filesInView; the function stays exported and tested.
import { SOURCES } from './source-registry.js';
import { fetchWithDeadline } from './request.js';
import { normalizeCaltransCctv, isLinkOnly } from './source-camera.js';

const CALTRANS_OPERATOR = 'Caltrans';
// D10: Caltrans advertises a 2-minute refresh, so 30 minutes is 15 missed refreshes -- long
// enough that a normal slow update never misfires as "stuck".
const STALE_MS = 30 * 60 * 1000;

/** Pins load only from this zoom. Below it a view spans too much ground to draw every camera in it,
 *  so nothing is read and the report asks for a closer view. */
export const MIN_PIN_ZOOM = 7;

/** D8's revisit trigger: about 300 DOM markers. The seeds hold 3,591 located road cameras and no zoom up
 *  to 9 gets a whole-file draw under 300, so the draw is capped, not the zoom raised. */
export const MAX_PINS = 300;

/** The pins to draw: located cameras inside `view`, at most `cap`, the ones nearest the view's centre
 *  first. `total` is how many sit in the view, so a report can say when it is showing only some. */
export function pinsToDraw(cameras = [], view, cap = MAX_PINS) {
  const inside = camerasInView(cameras, view);
  if (inside.length <= cap) return { pins: inside, total: inside.length };
  const cLat = (view.minLat + view.maxLat) / 2, cLon = (view.minLon + view.maxLon) / 2;
  const d = (c) => (c.lat - cLat) ** 2 + (c.lon - cLon) ** 2;
  const pins = inside.map((c) => [d(c), c]).sort((a, b) => a[0] - b[0]).slice(0, cap).map((x) => x[1]);
  return { pins, total: inside.length };
}

/** Index rows (of the given layers) not yet read whose area reaches within `meters` of a point: the
 *  cameras there exist but are not loaded, which is not the same as none. */
export function unloadedFilesNear(files, loaded, layers, lat, lon, meters) {
  if (!Array.isArray(files)) return [];
  const dLat = meters / 111000, dLon = meters / (111000 * Math.max(Math.cos(lat * Math.PI / 180), 0.01));
  const reach = { minLon: lon - dLon, minLat: lat - dLat, maxLon: lon + dLon, maxLat: lat + dLat };
  return files.filter((f) => layers.includes(f.layer) && !loaded.has(f.file) && viewTouchesCoverage(reach, f.bbox));
}

/** The sentence both the status and the report use below MIN_PIN_ZOOM. `areaCount` is the summed index
 *  count of the files this view touches. */
function zoomInText(areaCount) {
  return Number.isFinite(areaCount) && areaCount > 0
    ? `Zoom in to see cameras. ${plural(areaCount, 'camera')} in areas this view touches (pins appear from zoom ${MIN_PIN_ZOOM}).`
    : `Zoom in to see cameras (pins appear from zoom ${MIN_PIN_ZOOM}).`;
}

/** A { minLon, minLat, maxLon, maxLat } box grown on every side by `frac` of its own size, so a
 *  file just off screen is already loaded when the map is dragged toward it. */
export function padView(view, frac = 0.1) {
  const dLon = (view.maxLon - view.minLon) * frac;
  const dLat = (view.maxLat - view.minLat) * frac;
  return { minLon: view.minLon - dLon, minLat: view.minLat - dLat, maxLon: view.maxLon + dLon, maxLat: view.maxLat + dLat };
}

/** The snapshot index's file rows (optionally only one layer's) whose bbox meets the view. */
export function filesInView(files, view, layer) {
  if (!Array.isArray(files)) return [];
  return files.filter((f) => (layer === undefined || f.layer === layer) && viewTouchesCoverage(view, f.bbox));
}

/** The provider a failed layer's report should speak for: the one provider shared by every file of
 *  the layer that touches the padded view, else `fallback`. A layer that holds several operators
 *  (road cameras) passes a null fallback, which reads as the neutral row and names no operator. */
export function failureProvider(files, view, layer, fallback) {
  const providers = new Set(filesInView(files, padView(view), layer).map((f) => f.provider));
  return providers.size === 1 ? [...providers][0] : fallback;
}

/** GETs the registry's own caltransCctv.serviceUrl and normalizes the result. Never throws --
 *  a network failure, a non-ok response or a JSON parse error all become { ok:false, reason }. */
export async function fetchCaltransCctv({ fetchImpl = fetch, signal, fetchedAt } = {}) {
  const got = await fetchWithDeadline(SOURCES.caltransCctv.serviceUrl, { fetchImpl, signal, timeoutMs: SOURCES.caltransCctv.timeoutMs });
  if (!got.ok) {
    if (got.httpStatus) return { ok: false, reason: `Caltrans's server returned ${got.httpStatus}.` };
    return { ok: false, reason: got.error || 'The request to Caltrans failed.' };
  }
  try {
    return { ok: true, cameras: normalizeCaltransCctv(got.body, { fetchedAt }) };
  } catch (err) {
    return { ok: false, reason: (err && err.message) || 'The request to Caltrans failed.' };
  }
}

/** The located cameras (real lat/lon) inside a plain { minLon, minLat, maxLon, maxLat } box --
 *  the same bbox shape main.js already derives from map.getBounds() everywhere else in Q/. */
export function camerasInView(cameras = [], bounds) {
  return cameras.filter((c) => c.lat !== null && c.lon !== null
    && c.lat >= bounds.minLat && c.lat <= bounds.maxLat
    && c.lon >= bounds.minLon && c.lon <= bounds.maxLon);
}

/** Cameras with no usable position -- a null lat or lon (NPS's Kuwohi and Twin Creek, 08D-ii). */
export function unlocated(cameras = []) {
  return cameras.filter((c) => c.lat === null || c.lon === null);
}

/** Whether the map view reaches a region at all: two plain { minLon, minLat, maxLon, maxLat }
 *  boxes overlapping. A view that swallows the region counts, since its cameras are in view. */
export function viewTouchesCoverage(view, coverage) {
  return view.minLon <= coverage.maxLon && view.maxLon >= coverage.minLon
    && view.minLat <= coverage.maxLat && view.maxLat >= coverage.minLat;
}

/** Whether a view touches a camera layer's coverage: its main box or any `coverageMore` box (a
 *  region a single box cannot join, such as Guam across the dateline). */
export function viewTouchesLayer(view, spec) {
  return viewTouchesCoverage(view, spec.coverage)
    || (Array.isArray(spec.coverageMore) && spec.coverageMore.some((c) => viewTouchesCoverage(view, c)));
}

const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

// The park-camera row. nps-webcams is the nationwide provider the snapshot index names; nps-grsm is
// the legacy id the Great Smoky-only normalizer still stamps, so it reads the same row.
const NPS_ROW = Object.freeze({
  noun: 'park camera',
  operator: 'the park',
  plan: 'img',
  linkText: 'Park webcam page',
  stillLinkText: '',
  altCredit: 'National Park Service',
  ageSource: 'none',
  listChecked: true,
  listCheckedLead: 'The park does not publish when this picture was taken.',
  // QQA-10f: the sentence above is false for a record that carries a capture time, so such a card
  // drops it (a row with no such lead falls back to listCheckedLead).
  listCheckedLeadCaptured: '',
  emptyText: 'No park cameras in this view. Park cameras are listed only for parks with a located NPS webcam.',
  errorText: "The park's camera list did not load, so no cameras are shown. Turn the layer off and on to try again.",
  outsideText: 'Outside coverage: this view is not in a US state or territory, the only areas with park cameras here. Use Go to under Cameras.',
});

// Per-provider vocabulary: ONE table, one row per provider id. Everything provider-specific this
// module says or decides (noun, report text, still plan, list-checked card line) is read from it,
// so a new provider is one new row, not a branch in five functions. Fields:
//   noun           what one camera is called in counts ("3 road cameras in this view.")
//   operator       who the card/links name when speaking of the provider's side
//   plan           'fetch' (read via fetch() so Last-Modified is readable), 'img' (plain <img>, no
//                  ACAO to read headers from) or 'link' (no request is ever made)
//   linkText       the card's "about" link; stillLinkText the "open this picture" link ('' = none)
//   altCredit      the credit in the picture's alt text
//   ageSource      'last-modified' (the picture file's header), 'captured' or 'none'
//   listChecked    whether the card says when the camera list was last checked (listCheckedLead
//                  is the sentence before the date; listCheckedLeadCaptured, when a row has it, is
//                  the one used instead for a record that carries a capturedAt)
//   emptyText / errorText / outsideText   the three layer-report sentences
// A provider id that is not in the table gets NEUTRAL_PROVIDER: neutral words and plan 'link',
// never another provider's text (08D-i used to fall back to Caltrans, which put Caltrans's name
// and District 5 on any new provider's report).
const PROVIDERS = Object.freeze({
  'caltrans-cwwp2': Object.freeze({
    noun: 'road camera',
    operator: 'Caltrans',
    plan: 'fetch',
    linkText: 'About Caltrans cameras',
    stillLinkText: "Open this picture on Caltrans's site",
    altCredit: 'Caltrans',
    ageSource: 'last-modified',
    listChecked: true,
    listCheckedLead: 'Camera health is as of the last list check; the picture is read when you open it.',
    emptyText: 'No road cameras in this view.',
    errorText: "Caltrans's camera list did not load, so no cameras are shown. Turn the layer off and on to try again.",
    outsideText: 'Outside coverage: this view is not in a US state, the only areas with road cameras here. Use Go to under Cameras.',
  }),
  'nps-webcams': NPS_ROW,
  'nps-grsm': NPS_ROW,
  phenocam: Object.freeze({
    noun: 'research camera',
    operator: 'the PhenoCam Network',
    plan: 'img',
    linkText: "This camera's PhenoCam page",
    stillLinkText: '',
    altCredit: 'PhenoCam Network (CC BY)',
    ageSource: 'none',
    listChecked: true,
    listCheckedLead: 'The network does not publish when this picture was taken; the list keeps cameras that sent one in the previous 30 days.',
    emptyText: 'No research cameras in this view.',
    errorText: "The PhenoCam camera list did not load, so no cameras are shown. Turn the layer off and on to try again.",
    outsideText: 'Outside coverage: this view is not in a US state, the only areas with research cameras here. Use Go to under Cameras.',
  }),
  aviationwx: Object.freeze({
    noun: 'airport camera',
    operator: 'AviationWX.org',
    plan: 'img',
    linkText: "This airport's AviationWX page",
    stillLinkText: '',
    altCredit: 'AviationWX.org',
    ageSource: 'none',
    listChecked: true,
    listCheckedLead: 'Weather data from AviationWX.org. The picture is read when you open it.',
    emptyText: 'No airport cameras in this view.',
    errorText: "The AviationWX airport list did not load, so no cameras are shown. Turn the layer off and on to try again.",
    outsideText: 'Outside coverage: this view is not in a US state, the only areas with airport cameras here. Use Go to under Cameras.',
  }),
  volcview: Object.freeze({
    noun: 'volcano camera',
    operator: 'USGS VolcView',
    plan: 'img',
    linkText: "This camera's VolcView page",
    stillLinkText: '',
    altCredit: 'USGS VolcView',
    ageSource: 'none',
    listChecked: true,
    listCheckedLead: 'The camera belongs to the owner credited here, shown through USGS VolcView. The picture is read when you open it; the list keeps cameras that sent one in the day before it was checked.',
    emptyText: 'No volcano cameras in this view.',
    errorText: "The USGS VolcView camera list did not load, so no cameras are shown. Turn the layer off and on to try again.",
    outsideText: 'Outside coverage: this view is not in the United States, the only area with volcano cameras here. Use Go to under Cameras.',
  }),
  glerl: Object.freeze({
    noun: 'Great Lakes camera',
    operator: 'NOAA GLERL',
    plan: 'img',
    linkText: "This station's NOAA GLERL page",
    stillLinkText: '',
    altCredit: 'NOAA GLERL',
    ageSource: 'none',
    listChecked: true,
    listCheckedLead: 'NOAA GLERL does not publish when this picture was taken; the list keeps cameras that sent one in the day before it was checked.',
    emptyText: 'No Great Lakes cameras in this view.',
    errorText: "The NOAA GLERL camera list did not load, so no cameras are shown. Turn the layer off and on to try again.",
    outsideText: 'Outside coverage: this view is not on the Great Lakes, the only area with these cameras. Use Go to under Cameras.',
  }),
});

const NEUTRAL_PROVIDER = Object.freeze({
  noun: 'camera',
  operator: 'the operator',
  plan: 'link',
  linkText: 'About these cameras',
  stillLinkText: '',
  altCredit: 'the camera operator',
  ageSource: 'none',
  listChecked: false,
  listCheckedLead: '',
  emptyText: 'No cameras in this view.',
  errorText: "This layer's camera list did not load, so no cameras are shown. Turn the layer off and on to try again.",
  outsideText: 'Outside coverage: this view is not in an area this camera layer covers. Use Go to under Cameras.',
});

/** The table row for a provider id; an unknown, absent or inherited-key id gets the neutral row. */
export function providerRow(id) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? PROVIDERS[id] : NEUTRAL_PROVIDER;
}

/** The one short status a region shows in the Cameras entry, as { key, text }. The seven keys are the
 *  seven things the contract says must read apart; the order below is the precedence when more than
 *  one is true (a switched-off layer is just off, however the view sits). `touches` is
 *  viewTouchesCoverage for the current view; `inView` the located cameras inside it. */
export function cameraStatus({ on, loading = false, error = false, touches = true, belowZoom = false, inView = 0, areaCount = 0 }) {
  if (!on) return { key: 'layer-off', text: 'Layer off.' };
  if (loading) return { key: 'loading', text: 'Loading the camera list.' };
  if (error) return { key: 'unavailable', text: 'Camera list unavailable. Turn the layer off and on to retry.' };
  if (!touches) return { key: 'outside-coverage', text: 'Outside coverage: this view is not in the region.' };
  if (belowZoom) return { key: 'zoom-in', text: zoomInText(areaCount) };
  if (inView === 0) return { key: 'none-in-view', text: 'None in this view.' };
  return { key: 'in-view', text: `${plural(inView, 'camera')} in this view.` };
}

// Strips the API's own " Webcam" suffix for the unlocated list only -- cardLines and the popup
// title keep the full record name (e.g. "Kuwohi Webcam") unchanged.
function shortName(name) {
  return typeof name === 'string' ? name.replace(/\s+Webcam$/i, '') : name;
}

// Why a camera has no map position, for the unlocated sentence. An inactive record that still
// carries a curated still (Kuwohi) reads as "out of service"; one with neither a position nor a
// picture (Twin Creek) reads as "no picture" -- the two null-lat/lon NPS records read apart.
function unlocatedReason(camera) {
  const hasStill = !!(camera.media && camera.media.still);
  if (camera.health === 'inactive') return hasStill ? 'out of service' : 'no picture';
  return 'no picture';
}

function unlocatedSentence(cameras) {
  const missing = unlocated(cameras);
  if (missing.length === 0) return '';
  const verb = missing.length === 1 ? 'has' : 'have';
  const names = missing.map((c) => `${shortName(c.name)} (${unlocatedReason(c)})`).join(', ');
  return ` ${missing.length} more ${verb} no map position: ${names}.`;
}

/** The layer row's report paragraph. Distinguishes "loaded, nothing here" from "did not load"
 *  (QUX-08D.md plan :181) -- a silent zero and a silent failure must never read the same. NPS
 *  cameras (08D-ii) add the unlocated sentence: Kuwohi and Twin Creek carry no lat/lon at all, so
 *  they never appear on the map even when the layer is on -- the report says so by name rather
 *  than letting them silently vanish. */
export function layerReport({ provider = 'caltrans-cwwp2', cameras = [], inView = [], error = null, outsideCoverage = false, belowZoom = false, nearest = null, areaCount = 0, capped = null, failedAreas = 0 } = {}) {
  const row = providerRow(provider);
  if (error) return row.errorText;
  // UX-03b: a view that never reaches the region is not "no cameras here" -- there are none to
  // have, anywhere near. Says so, and where they are.
  if (outsideCoverage) return row.outsideText;
  // U4a: below the zoom floor no file is read, so "none here" would be a claim about cameras never
  // looked for. Say to zoom in instead.
  if (belowZoom) return zoomInText(areaCount);
  const base = inView.length === 0
    ? row.emptyText
    : `${plural(inView.length, row.noun)} in this view.`;
  // With nothing in view, say how far the nearest area with cameras is (nearestCoverage's result).
  const near = inView.length === 0 && nearest && nearest.area
    ? ` Nearest cameras are ${nearest.km} km away (${nearest.area.name}).` : '';
  const cap = capped && capped.total > capped.shown
    ? ` Showing the ${capped.shown} nearest the centre; zoom in to see the rest.` : '';
  const partial = failedAreas > 0
    ? ` ${plural(failedAreas, 'area')} did not load. Turn the layer off and on to retry.` : '';
  return base + cap + near + unlocatedSentence(cameras) + partial;
}

/** Plain strings for the camera's popup card. Never contains the word "live" -- a dead Caltrans
 *  feed cannot be told apart from a live one from this page (QUX-08D.md C15); the card reports
 *  what the file's own modification time says, never a liveness claim. */
export function cardLines(camera, { generatedAt, now = new Date() } = {}) {
  // A link-only camera (HPWREN, AlertWest): name, the owner's credit, what the owner lists, and
  // why there is no picture. The owner's own link is drawn by the caller, labelled by linkLabel.
  if (isLinkOnly(camera)) {
    const owner = camera.operator;
    return [camera.name, camera.attribution || owner, camera.subject,
      `${owner}'s pictures are not shown here, because its terms limit how they can be reused. `
      + `The link opens ${owner}'s own page.`].filter(Boolean);
  }
  const lines = [camera.name, camera.operator];
  // Caltrans's cardinal location.direction string is never mapped into a numeric bearing
  // (source-camera.js, not touched by 08D-i) -- camera.bearing is always null for every
  // Caltrans record today, so this branch is structural, ready for a future provider/field
  // that actually supplies one, but unreachable for 08D-i's data.
  if (camera.bearing !== null && camera.bearing !== undefined) {
    lines.push(`Faces ${camera.bearing}, per ${camera.operator}.`);
  }
  if (camera.health === 'inactive') {
    lines.push(`${camera.operator} lists this camera as out of service.`);
  } else if (pictureExpired(camera, now)) {
    // QQA-10f: the snapshot row had a picture and its validUntil has passed, so expandSnapshot took
    // the still away. That is not "none published": the reader is told it is out of date.
    lines.push("This camera's picture is out of date, so none is shown.");
  } else if (!camera.media || !camera.media.still) {
    lines.push('No picture is published for this camera.');
  }
  const row = providerRow(camera.provider);
  if (row.listChecked) {
    // The snapshot's own generatedAt; a record expanded from a snapshot carries it as fetchedAt.
    const lead = camera.capturedAt && row.listCheckedLeadCaptured !== undefined ? row.listCheckedLeadCaptured : row.listCheckedLead;
    lines.push(`${lead} Camera list checked ${formatCheckedDate(generatedAt || camera.fetchedAt)}.`.trim());
  }
  return lines;
}

// A manual UTC formatter, not toLocaleDateString: the card must read the same regardless of the
// visitor's locale/timezone, and must never claim more precision than the snapshot actually has.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatCheckedDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'an unknown date';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function formatDuration(ms) {
  if (ms < 60 * 60 * 1000) return `${Math.round(ms / (60 * 1000))} min`;
  return `${Math.round(ms / (60 * 60 * 1000))} h`;
}

/** How old the picture FILE is, per its own Last-Modified header -- never a claim about when the
 *  scene was captured (Caltrans publishes no per-image capture time; see source-camera.js). */
export function ageText(lastModified, now = new Date(), provider = 'caltrans-cwwp2') {
  const server = `${providerRow(provider).operator}'s server`;
  const unsaid = `${server[0].toUpperCase()}${server.slice(1)} did not say when this picture changed.`;
  if (!lastModified) return unsaid;
  const modified = new Date(lastModified);
  if (Number.isNaN(modified.getTime())) return unsaid;
  const age = now.getTime() - modified.getTime();
  if (age < STALE_MS) {
    return `Picture file changed ${formatDuration(age)} ago, per ${server}. `
      + 'That is when the file changed, not a guaranteed capture time.';
  }
  return `Picture file last changed ${formatDuration(age)} ago. The camera may be stuck.`;
}

/** How long an open card waits for its picture before it gives up and points the reader at the
 *  owner's link (both plans: an <img> that never fires load or error, and a fetch that never
 *  answers). 20 s, the same limit the alerts and forecast requests use. */
export const PICTURE_TIMEOUT_MS = 20000;

// A capturedAt a little ahead of the reader's clock is clock skew and reads as just now; further
// ahead is bad data and says nothing.
const SKEW_MS = 5 * 60 * 1000;

/** How old the picture is per the record's own capturedAt (a snapshot field, QQA-17b), or null when
 *  there is no readable time to say anything from. The same 30-minute line as ageText decides
 *  "may be stuck", so the two sources agree. It is the listed capture time, not a claim that the
 *  picture is being refreshed. */
export function capturedAgeText(capturedAt, now = new Date(), provider = 'caltrans-cwwp2') {
  if (typeof capturedAt !== 'string' || capturedAt === '') return null;
  const taken = new Date(capturedAt);
  if (Number.isNaN(taken.getTime())) return null;
  const age = now.getTime() - taken.getTime();
  if (age < -SKEW_MS) return null;
  const source = `${providerRow(provider).operator}'s listing`;
  const head = `Picture taken ${formatDuration(Math.max(age, 0))} ago, per ${source}.`;
  return age < STALE_MS ? head : `${head} The camera may be stuck.`;
}

/** The picture age line for a camera's card, as a string ('' for none). One rule: the picture file's
 *  Last-Modified, when the fetch plan read a readable one, wins (it was measured on this fetch);
 *  otherwise the record's capturedAt; otherwise a fetch-plan card says the server did not say, and an
 *  img-plan card, which has no header to read, says nothing. */
export function ageLine(camera, { lastModified = null, now = new Date() } = {}) {
  if (lastModified && !Number.isNaN(new Date(lastModified).getTime())) return ageText(lastModified, now, camera.provider);
  const captured = capturedAgeText(camera.capturedAt, now, camera.provider);
  if (captured) return captured;
  return stillPlan(camera) === 'fetch' ? ageText(null, now, camera.provider) : '';
}

/** True for a camera whose still was taken away by an expired `validUntil` (expandSnapshot drops the
 *  still and keeps validUntil): no picture, and an expiry that has passed, valid up to and including
 *  the instant. An unreadable expiry counts as past, as it does there. A row with no expiry, or an
 *  expiry still ahead, is just a camera with no picture. */
export function pictureExpired(camera, now = new Date()) {
  if (!camera || (camera.media && camera.media.still)) return false;
  const until = camera.validUntil;
  if (until === null || until === undefined) return false;
  return !(typeof until === 'string' && Date.parse(until) >= (now instanceof Date ? now.getTime() : Number(now)));
}

/** The plan comes from the provider table: 'fetch', 'img' or 'link' (inactive, no still at all,
 *  or a provider the table does not know -- no request is ever made). */
export function stillPlan(camera) {
  // Link-only means no picture and no request, whatever the record carries.
  if (!camera || isLinkOnly(camera)) return 'link';
  if (camera.health === 'inactive' || !camera.media || !camera.media.still) return 'link';
  return providerRow(camera.provider).plan;
}

/** The text of the owner link on a link-only camera's card ("View on HPWREN"), or null for any
 *  other camera, whose cards keep their own link text. */
export function linkLabel(camera) {
  return isLinkOnly(camera) && camera.operator ? `View on ${camera.operator}` : null;
}

/** The text of the owner link on a camera's card: "View on HPWREN" for a link-only camera, else the
 *  provider's own text ("About Caltrans cameras", "Park webcam page"). */
export function aboutLinkText(camera) {
  return linkLabel(camera) || providerRow(camera.provider).linkText;
}

/** A stable id for a camera, round-tripped by findCamera. QUX-09c consumes both. */
export function cameraRef(camera) {
  return `camera:${camera.provider}:${camera.providerId}`;
}

/** Refs saved before a provider's ids changed, and the ref they now mean. Tried only when no
 *  camera carries the saved ref as written. A bare Caltrans index (no `dNN:` prefix) was always
 *  District 5; the Great Smoky catalogue became the nationwide nps-webcams provider with the same
 *  UUIDs. Each row is { pattern, to } for String.replace. */
export const LEGACY_REF_ALIASES = Object.freeze([
  Object.freeze({ pattern: /^camera:caltrans-cwwp2:(?!d\d{2}:)(.+)$/, to: 'camera:caltrans-cwwp2:d05:$1' }),
  Object.freeze({ pattern: /^camera:nps-grsm:(.+)$/, to: 'camera:nps-webcams:$1' }),
]);

function legacyRef(ref) {
  if (typeof ref !== 'string') return null;
  for (const { pattern, to } of LEGACY_REF_ALIASES) {
    if (pattern.test(ref)) return ref.replace(pattern, to);
  }
  return null;
}

/** The camera a saved ref names, or null. An exact match wins; otherwise the ref is tried once
 *  through LEGACY_REF_ALIASES, so a place saved under an old id keeps opening its camera. */
export function findCamera(cameras = [], ref) {
  const exact = cameras.find((c) => cameraRef(c) === ref);
  if (exact) return exact;
  const aliased = legacyRef(ref);
  return aliased ? cameras.find((c) => cameraRef(c) === aliased) || null : null;
}

const toRad = (deg) => (deg * Math.PI) / 180;
const EARTH_KM = 6371;

// Great-circle km from a point to the nearest point of a plain bbox (0 inside it). The nearest
// point is the point clamped into the box; for the small areas used here that is the right one.
function kmToBox(lat, lon, box) {
  const nLat = Math.min(Math.max(lat, box.minLat), box.maxLat);
  const nLon = Math.min(Math.max(lon, box.minLon), box.maxLon);
  const dLat = toRad(nLat - lat);
  const dLon = toRad(nLon - lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat)) * Math.cos(toRad(nLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Where a layer's coverage sits relative to the view. `areas` is [{ id, name, bbox }] (the layer's
 *  static coverage list). `inView` is every area the view touches, in input order; `nearest` is the
 *  area closest to the view's centre as { area, km } (whole km, 0 when the centre is inside it), or
 *  null when there are no areas. Pure: no DOM, no network. */
export function nearestCoverage(view, areas = []) {
  const list = Array.isArray(areas) ? areas : [];
  const inView = list.filter((a) => viewTouchesCoverage(view, a.bbox));
  let nearest = null;
  if (list.length > 0) {
    const lat = (view.minLat + view.maxLat) / 2;
    const lon = (view.minLon + view.maxLon) / 2;
    for (const area of list) {
      const km = kmToBox(lat, lon, area.bbox);
      if (!nearest || km < nearest.km) nearest = { area, km };
    }
    nearest = { area: nearest.area, km: Math.round(nearest.km) };
  }
  return { inView, nearest };
}

export { CALTRANS_OPERATOR, PROVIDERS };
