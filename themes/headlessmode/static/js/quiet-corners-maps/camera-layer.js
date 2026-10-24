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
//                  is the sentence before the date)
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
export function cardLines(camera, { generatedAt } = {}) {
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
  } else if (!camera.media || !camera.media.still) {
    lines.push('No picture is published for this camera.');
  }
  const row = providerRow(camera.provider);
  if (row.listChecked) {
    // The snapshot's own generatedAt; a record expanded from a snapshot carries it as fetchedAt.
    lines.push(`${row.listCheckedLead} Camera list checked ${formatCheckedDate(generatedAt || camera.fetchedAt)}.`);
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

/** The ref a camera now carries for a saved `ref`: the ref itself, or what LEGACY_REF_ALIASES says it became.
 *  Two refs naming one camera share a canonical ref, so a list can tell a saved camera under an old id. */
export function canonicalCameraRef(ref) {
  return legacyRef(ref) || ref;
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

// QQA-16a: the reader-facing Cameras list. Everything here works on LOADED camera records
// ({ camera, layer } entries), never on the drawn pins, so the list does not inherit MAX_PINS.

/** The radius of the "Near selected place" scope, in km. Stated in the UI beside the place. */
export const NEAR_RADIUS_KM = 25;

/** Rows drawn in the list at once. The count above them is the whole scope; this only bounds the DOM. */
export const LIST_LIMIT = 50;

/** The four reader purposes a camera layer is filed under (providers stay under Sources). */
export const CAMERA_PURPOSES = Object.freeze([
  Object.freeze({ id: 'roads', label: 'Roads' }),
  Object.freeze({ id: 'scenery', label: 'Scenery & parks' }),
  Object.freeze({ id: 'weather', label: 'Weather & aviation' }),
  Object.freeze({ id: 'wildlife', label: 'Wildlife & seasons' }),
]);

/** Each camera layer id under exactly one purpose. linkCameras holds state road-camera links and
 *  HPWREN/AlertWest fire-lookout links; most of its cameras are road links, so it sits under roads.
 *  phenoCameras also holds the volcano and Great Lakes cameras, so its purpose is the one most of
 *  it shares: seasons and the living landscape. */
export const PURPOSE_OF_LAYER = Object.freeze({
  roadCameras: 'roads', parkCameras: 'scenery', linkCameras: 'roads', phenoCameras: 'wildlife', airportCameras: 'weather',
});

/** Great-circle km between two lat/lon points. */
export function kmBetween(aLat, aLon, bLat, bLon) {
  const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The plain bbox that holds every point within `km` of a point (a little more at its corners). */
export function reachBox(lat, lon, km) {
  const dLat = km / 111.19, dLon = km / (111.19 * Math.max(Math.cos(toRad(lat)), 0.01));
  return { minLon: lon - dLon, minLat: lat - dLat, maxLon: lon + dLon, maxLat: lat + dLat };
}

/** The list for one scope. `entries` are { camera, layer } for the layers that are on, from the
 *  files already loaded. scope 'view': located cameras inside `view`, nearest its centre first;
 *  scope 'near': located cameras within `radiusKm` of `place` ({ lat, lon }), nearest first. Returns
 *  { inScope, counts (per purpose, before the filter), matching (after it), listed (the first `limit`),
 *  noPicture (of matching), unlocated }. */
export function cameraList({ entries = [], scope = 'view', view, place = null, radiusKm = NEAR_RADIUS_KM, purposes = [], limit = LIST_LIMIT } = {}) {
  const near = scope === 'near';
  const counts = Object.fromEntries(CAMERA_PURPOSES.map((p) => [p.id, 0]));
  const scoped = [];
  let unlocatedCount = 0;
  const from = near ? place : view && { lat: (view.minLat + view.maxLat) / 2, lon: (view.minLon + view.maxLon) / 2 };
  for (const entry of entries) {
    const c = entry.camera;
    if (c.lat === null || c.lon === null) { unlocatedCount += 1; continue; }
    if (!from || (!near && camerasInView([c], view).length === 0)) continue;
    const km = kmBetween(from.lat, from.lon, c.lat, c.lon);
    if (near && km > radiusKm) continue;
    const purpose = PURPOSE_OF_LAYER[entry.layer];
    counts[purpose] += 1;
    scoped.push({ camera: c, layer: entry.layer, purpose, km });
  }
  scoped.sort((a, b) => a.km - b.km || (a.camera.providerId < b.camera.providerId ? -1 : 1));
  const matching = scoped.filter((r) => purposes.includes(r.purpose));
  return {
    inScope: scoped.length, counts, matching, listed: matching.slice(0, limit),
    noPicture: matching.filter((r) => stillPlan(r.camera) === 'link').length, unlocated: unlocatedCount,
  };
}

/** The place "Near selected place" measures from, as { lat, lon, name }: the latest pick wins. The
 *  finder's pick (`search`, anchor [lat, lon]) is held only until another pick replaces it; a name
 *  pin, a recreation pin or a places-list row clears it and sets `nearby` ({ name, lonLat: [lon, lat] }).
 *  With neither, the centre of the drawn area; null when there is no place at all. */
export function listPlace({ search = null, nearby = null, bbox = null } = {}) {
  if (search && Array.isArray(search.anchor) && search.anchor.length === 2 && search.anchor.every(Number.isFinite)) {
    return { lat: search.anchor[0], lon: search.anchor[1], name: search.name };
  }
  if (nearby && Array.isArray(nearby.lonLat) && nearby.lonLat.length === 2 && nearby.lonLat.every(Number.isFinite)) {
    return { lat: nearby.lonLat[1], lon: nearby.lonLat[0], name: nearby.name };
  }
  return bbox ? { lat: (bbox.minLat + bbox.maxLat) / 2, lon: (bbox.minLon + bbox.maxLon) / 2, name: 'the drawn area' } : null;
}

/** What failed, for the status line, judged from the files the SCOPE reaches. `rows` are the index rows
 *  of the layers in `reaching` that the scope's box meets; `isLoaded` / `isFailed` say what became of a
 *  file; `layerFailed` is the per-layer flag the map view sets. Near: only the place's own files decide
 *  (unavailable when every one failed or the index could not be read; nothing-loaded only before any
 *  was tried), so a district that failed under the map elsewhere neither hides nor taints this list.
 *  View: the layer flags still decide, as they describe that very view. */
export function listLoadState({ near = false, reaching = [], rows = [], isLoaded = () => false, isFailed = () => false, indexRead = false, layerFailed = {} } = {}) {
  if (reaching.length === 0) return { unavailable: false, failedAreas: 0, nothingLoaded: false };
  if (near) {
    const failed = rows.filter((r) => isFailed(r.file)).length;
    const unavailable = (!indexRead && reaching.every((id) => layerFailed[id])) || (rows.length > 0 && failed === rows.length);
    return { unavailable, failedAreas: failed, nothingLoaded: !unavailable && (!indexRead || (rows.length > 0 && failed === 0 && !rows.some((r) => isLoaded(r.file)))) };
  }
  let failedAreas = 0;
  for (const id of reaching) failedAreas += rows.filter((r) => r.layer === id && isFailed(r.file)).length || (layerFailed[id] ? 1 : 0);
  return {
    unavailable: reaching.every((id) => layerFailed[id]), failedAreas,
    nothingLoaded: !indexRead || (rows.length > 0 && !rows.some((r) => isLoaded(r.file))),
  };
}

const camerasWord = (n) => (n === 1 ? 'camera' : 'cameras');

/** The cluster summary below MIN_PIN_ZOOM: loaded cameras in the view, counted per purpose. */
function clusterStatus({ counts, inScope, failedAreas, unlocated }) {
  const parts = CAMERA_PURPOSES.filter((p) => counts[p.id] > 0).map((p) => `${counts[p.id]} ${p.label}`);
  const notes = ['Only cameras already loaded are counted; Search this area loads more.'];
  if (failedAreas > 0) notes.push(`${plural(failedAreas, 'area')} did not load, so cameras may be missing.`);
  if (unlocated > 0) notes.push(`${unlocated} loaded ${camerasWord(unlocated)} ${unlocated === 1 ? 'has' : 'have'} no map position and ${unlocated === 1 ? 'is' : 'are'} not counted.`);
  return { key: 'cluster', text: `${plural(inScope, 'camera')} loaded in this view at this zoom: ${parts.join(', ')}. Zoom in to list cameras (they are listed from zoom ${MIN_PIN_ZOOM}).`, notes };
}

/** The one state the list is in, as { key, text, notes }. Keys read apart: layers-off, no-place, zoom-in,
 *  cluster (broad zoom, loaded cameras counted per purpose), loading, unavailable, outside-coverage, nothing-loaded, none, filtered-out, partial, images-unavailable,
 *  in-scope. `notes` are the extra sentences a listed result owes the reader (a failed area, the list's
 *  own limit and the pin cap, cameras with no picture or no position). */
export function cameraListStatus({ scope = 'view', onLayers = 0, belowZoom = false, hasPlace = false, placeName = '', touches = true,
  loading = false, unavailable = false, failedAreas = 0, nothingLoaded = false, inScope = 0, matching = 0, listed = 0, noPicture = 0,
  unlocated = 0, radiusKm = NEAR_RADIUS_KM, counts = null, searching = false } = {}) {
  const near = scope === 'near';
  const phrase = near ? `near ${placeName}` : 'in this view';
  const state = (key, text, notes = []) => ({ key, text, notes });
  if (onLayers === 0) return state('layers-off', 'No camera layer is on. Switch one on above to list its cameras.');
  if (near && !hasPlace) return state('no-place', `Choose a place with Search places, or draw an area, to list cameras within ${radiusKm} km of it.`);
  if (!near && belowZoom) {
    if (searching) return state('loading', 'Loading the camera list.');
    // QQA-16b: with records already loaded (a search read them) the broad view is counted per purpose,
    // from those records, never from drawn pins; with none, the old zoom-in state stands.
    if (counts && inScope > 0) return clusterStatus({ counts, inScope, failedAreas, unlocated });
    return state('zoom-in', `Zoom in to list cameras in this view (cameras load from zoom ${MIN_PIN_ZOOM}).`);
  }
  if (loading) return state('loading', 'Loading the camera list.');
  if (unavailable) return state('unavailable', 'Camera list unavailable. Turn the layer off and on to retry.');
  if (!touches) {
    return state('outside-coverage', near
      ? `Outside coverage: no camera layer that is on reaches within ${radiusKm} km of ${placeName}.`
      : 'Outside coverage: no camera layer that is on reaches this view.');
  }
  if (nothingLoaded) return state('nothing-loaded', `No camera list has been read ${phrase} yet.`);
  const notes = [];
  if (failedAreas > 0) notes.push(`${plural(failedAreas, 'area')} did not load, so cameras may be missing. Turn the layer off and on to retry.`);
  if (unlocated > 0) notes.push(`${unlocated} loaded ${camerasWord(unlocated)} ${unlocated === 1 ? 'has' : 'have'} no map position and ${unlocated === 1 ? 'is' : 'are'} not listed.`);
  if (inScope === 0) return state('none', near ? `No cameras near ${placeName}, within ${radiusKm} km.` : 'No cameras in this view.', notes);
  if (matching === 0) {
    return state('filtered-out', `${inScope} ${camerasWord(inScope)} ${phrase} ${inScope === 1 ? 'is' : 'are'} hidden by the purpose filter. Turn a purpose back on to list ${inScope === 1 ? 'it' : 'them'}.`, notes);
  }
  if (listed < matching) notes.push(`Listing the nearest ${listed} of ${matching}; zoom in or narrow by purpose to see the rest.`);
  if (inScope > MAX_PINS) notes.push(`The map draws at most ${MAX_PINS} pins at a time; this list counts every loaded camera ${phrase}, so it can hold more than the map shows.`);
  const allBare = noPicture === matching;
  if (noPicture > 0 && !allBare) notes.push(`${noPicture} of the ${matching} have no picture here and open the owner's page or say why.`);
  if (allBare) notes.push("Each opens its owner's page or says why there is no picture.");
  const base = `${matching} ${camerasWord(matching)} ${near ? `${phrase}, within ${radiusKm} km, nearest first` : phrase}.`;
  if (failedAreas > 0) return state('partial', `${base} This list is partial.`, notes);
  if (allBare) return state('images-unavailable', `${base} None has a picture here.`, notes);
  return state('in-scope', base, notes);
}

// QQA-16b: finding cameras. "Search this area" reads the camera files for the view on request, bounded
// by a radius and a file count that the page states; the Saved scope lists the cameras this browser
// saved and says so when one is no longer in the operator's list.

/** The most a "Search this area" reaches from the view's centre, in km. */
export const SEARCH_RADIUS_KM = 100;

/** The most camera files one search reads. */
export const SEARCH_MAX_FILES = 20;

export const SEARCH_HINT = `Search this area reads the camera files within ${SEARCH_RADIUS_KM} km of its centre, at most ${SEARCH_MAX_FILES} files, `
  + 'only when you press the button. Moving the map never searches.';

/** Said wherever saving is off. Nothing is written when this browser blocks site storage. */
export const SAVING_UNAVAILABLE = 'Saving unavailable: this browser is blocking site storage, so nothing saved here would survive a reload.';

/** The box a search reads: the view, trimmed to SEARCH_RADIUS_KM around its centre when wider. `centre`
 *  is the map's own centre ({ lat, lon }); without it, the middle of the box (which a broad view's
 *  projection puts off the map's centre). */
export function searchBox(view, centre = { lat: (view.minLat + view.maxLat) / 2, lon: (view.minLon + view.maxLon) / 2 }) {
  const reach = reachBox(centre.lat, centre.lon, SEARCH_RADIUS_KM);
  return { minLon: Math.max(view.minLon, reach.minLon), minLat: Math.max(view.minLat, reach.minLat), maxLon: Math.min(view.maxLon, reach.maxLon), maxLat: Math.min(view.maxLat, reach.maxLat) };
}

/** The index rows a search reads: those of `layers` meeting `box`, nearest `centre` first, at most `max`.
 *  A row counts only when its area comes within SEARCH_RADIUS_KM of `centre` (the box is a square, whose
 *  corners lie further out). `total` is every row met, so a status can say when the bound cut the search short. */
export function searchFiles({ files, box, layers = [], centre, max = SEARCH_MAX_FILES } = {}) {
  if (!Array.isArray(files)) return { rows: [], total: 0 };
  const met = files.filter((f) => layers.includes(f.layer) && viewTouchesCoverage(box, f.bbox))
    .map((f) => [kmToBox(centre.lat, centre.lon, f.bbox), f]).filter((x) => x[0] <= SEARCH_RADIUS_KM).sort((a, b) => a[0] - b[0] || (a[1].file < b[1].file ? -1 : 1));
  return { rows: met.slice(0, max).map((x) => x[1]), total: met.length };
}

/** The search's one status sentence, always naming its radius and centre. `pending` while it runs. */
export function searchStatus({ radiusKm = SEARCH_RADIUS_KM, centre, pending = false, indexFailed = false, idle = false, total = 0, shown = 0, read = 0, failed = 0 } = {}) {
  if (idle) return '';
  const where = `within ${radiusKm} km of ${centre.lat.toFixed(2)}, ${centre.lon.toFixed(2)}`;
  if (pending) return `Searching ${where}.`;
  if (indexFailed) return `Searched ${where}: the camera index did not load. Press the button to try again.`;
  if (total === 0) return `Searched ${where}: no camera list covers that area.`;
  let text = `Searched ${where}: ${read} of ${shown} camera files read.`;
  if (failed > 0) text += ` ${failed} did not load.`;
  if (total > shown) text += ` Only the nearest ${shown} of ${total} files were read; search closer in for the rest.`;
  return text;
}

/** The index rows of a layer that could hold a camera saved at `place`: those whose area holds its
 *  position, else (no position, or none holds it) every row of the layer. */
export function filesHolding(place, files, layer) {
  const ofLayer = (files || []).filter((f) => f.layer === layer);
  const at = Number.isFinite(place.lat) && Number.isFinite(place.lon)
    ? ofLayer.filter((f) => place.lon >= f.bbox.minLon && place.lon <= f.bbox.maxLon && place.lat >= f.bbox.minLat && place.lat <= f.bbox.maxLat) : [];
  return at.length ? at : ofLayer;
}

/** One row per saved camera: { place, state, camera, layer }. listed: found in a loaded file; gone: the
 *  files that could hold it are read and it is not there (or no list of its source exists); failed: it
 *  cannot be told because a file or the index did not load; pending: not read yet. Keyed by source and id
 *  (findCamera), so the same id from another source is another camera. */
export function savedCameraRows({ saved = [], entries = [], layerOf, files = [], indexState = 'read', isLoaded = () => false, isFailed = () => false } = {}) {
  const cameras = entries.map((e) => e.camera);
  return saved.map((place) => {
    const camera = findCamera(cameras, place.ref);
    if (camera) return { place, state: 'listed', camera, layer: entries.find((e) => e.camera === camera).layer };
    const row = (state) => ({ place, state, camera: null, layer: null });
    if (indexState !== 'read') return row(indexState);
    const layer = layerOf(place);
    const holding = layer ? filesHolding(place, files, layer) : [];
    if (holding.length === 0 || holding.every((f) => isLoaded(f.file))) return row('gone');
    return row(holding.some((f) => isFailed(f.file)) ? 'failed' : 'pending');
  });
}

/** A saved row's two lines. A camera that is not listed keeps its saved name and says why. */
export function savedRowText(row, provider) {
  if (row.state === 'listed') return cameraRowText({ camera: row.camera, km: 0 });
  const why = { gone: 'no longer in the camera list', failed: 'not checked: the camera list did not load', pending: 'checking the camera list' }[row.state];
  return { name: row.place.name, meta: `${provider.operator} · ${why}` };
}

/** The Saved scope's one state, as { key, text, notes }. `readState` is the store's read state;
 *  `readMessage` its own sentence when it is read-only (newer, unreadable). */
export function savedListStatus({ readState = 'ok', readMessage = '', total = 0, listed = 0, gone = 0, failed = 0, pending = 0 } = {}) {
  const state = (key, text, notes = []) => ({ key, text, notes });
  if (readState === 'unavailable') return state('saving-unavailable', SAVING_UNAVAILABLE);
  if (readState === 'newer' || readState === 'unreadable') return state('saved-readonly', readMessage);
  if (total === 0) return state('none-saved', 'No cameras saved yet. Save one from its row or its card.');
  if (pending > 0) return state('loading', `Checking ${plural(total, 'saved camera')} against the camera list.`);
  const notes = [];
  if (gone > 0) notes.push(`${gone} ${gone === 1 ? 'is' : 'are'} no longer in the camera list. ${gone === 1 ? 'It stays' : 'They stay'} saved until you remove ${gone === 1 ? 'it' : 'them'}.`);
  if (failed > 0) notes.push(`${failed} could not be checked because the camera list did not load.`);
  return state('saved', `${plural(total, 'saved camera')}, stored only in this browser.`, notes);
}

/** A row's two lines: the camera's name, and its source, distance (near scope) and why it has no picture. */
export function cameraRowText(row, { near = false } = {}) {
  const c = row.camera;
  const parts = [c.operator];
  if (near) parts.push(`${row.km < 10 ? row.km.toFixed(1) : Math.round(row.km)} km`);
  if (isLinkOnly(c)) parts.push('link only');
  else if (c.health === 'inactive') parts.push('out of service');
  else if (!c.media || !c.media.still) parts.push('no picture');
  return { name: c.name, meta: parts.join(' · ') };
}

export { CALTRANS_OPERATOR, PROVIDERS };
