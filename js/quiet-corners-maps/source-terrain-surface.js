// The shape of the ground for the view on screen: how steeply it tilts, and which way a
// tilted piece of it faces.
//
// Measured live 2026-09-15 against the service with an `Origin: https://headlessmode.com`
// header. Four measurements decide everything this file does.
//
// 1. `bboxSR` IS NOT OPTIONAL. Omit it and ArcGIS reads a lon/lat bbox in the service's own
//    Web Mercator METRES, which puts every US extent in a sub-metre patch off West Africa
//    and answers all of them with the same 1,897-byte empty picture. That is the whole of
//    the 2026-09-06 "3DEP exportImage does not vary per extent" finding: the call was
//    broken, not the service. Two distinct hashes with `bboxSR=4326`; the identical
//    `569c47e0f6bc0653` twice without it.
//
// 2. `format=png32` IS THE ONLY EXPORT THAT CAN SAY "NO COVERAGE". `png`, `png8` and
//    `png24` all answer PNG colour-type 0 -- greyscale, no alpha, no tRNS -- and the
//    `noData=-1` sentinel the request asks for cannot survive a uint8 channel, so an open
//    Atlantic extent comes back as 4,096 pixels of 0: the same number as flat ground.
//    png32 answers RGBA with R=G=B=the degree count and ALPHA 0 where the model has
//    nothing. Measured (0,0,0,0) over every ocean pixel, 255 over every Smokies pixel.
//    That is what lets this layer draw nothing where it knows nothing.
//
// 3. FLAT IS READ OFF THE SLOPE SURFACE, NEVER OFF ASPECT. `Aspect Degrees` has no -1 flat
//    marker: over the Bonneville Salt Flats 20% of pixels read exactly 0 and 99% of those
//    have slope 0, so flat collapses onto due north. `identify` at -113.85,40.77 returned
//    slope 0 AND aspect 0. Slope zero means there is no facing direction, and the layer
//    says that instead of picking one.
//
// 4. THE SERVICE PUBLISHES NO LEGEND for its own colour ramps -- `/legend` answers "RGB
//    Composite" with three swatches labelled Band_1..3, no class breaks and no units -- and
//    its slope moved up to 12 degrees for the same ground depending on the cell size asked
//    for. So the site paints the NUMERIC surface with its own breaks, and the legend below
//    is the same table the painter uses. It is true by construction rather than by trust.
//
// And the unit: slope is DEGREES. The service labels no unit anywhere, and its own metadata
// description of `Slope Degrees` is copied from `Slope Map` and is wrong. Percent rise is
// tan(degrees) x 100 -- 45 degrees is 100 per cent -- so the two are never interchangeable
// and every number here carries its unit in the same string.
import { SOURCES } from './source-registry.js';
import { fetchWithDeadline } from './request.js';

const SRC = SOURCES.usgs3depSurface;

export const TERRAIN_SOURCE = SRC;
export const SERVICE = SRC.serviceUrl;
export const CREDIT = SRC.attribution;
/** This layer's own cap, not the service's. 512 square answered 185,910 bytes over the
 *  steepest extent probed; 1024 square answered 633,888, which is no size to re-export on
 *  every pan. The service would allow 8000. */
export const MAX_IMAGE_SIDE = SRC.limits.maxImageSide;
/** Pinned on every point read, because slope IS the cell it was computed over: one point
 *  read 32.64 degrees at a 1 m cell, 39.63 at 3 m and 27.25 at 270 m. A number without a
 *  window is not an answer. */
export const POINT_CELL_METRES = SRC.limits.pointCellMetres;

/** The site's own ramp, in whole degrees, because the service publishes none. Six bands,
 *  open-ended at the top so 90 degrees lands somewhere. `legendRows()` renders exactly
 *  this table, and `paintSlope` colours from exactly this table. */
export const SLOPE_BREAKS = Object.freeze([
  Object.freeze({ from: 0, to: 3, color: '#eef2e4', name: 'level to barely tilted' }),
  Object.freeze({ from: 3, to: 8, color: '#cfe0a8', name: 'gentle' }),
  Object.freeze({ from: 8, to: 15, color: '#f0d27a', name: 'moderate' }),
  Object.freeze({ from: 15, to: 25, color: '#e09a4e', name: 'steep' }),
  Object.freeze({ from: 25, to: 35, color: '#c25f3c', name: 'very steep' }),
  Object.freeze({ from: 35, to: null, color: '#8c2f2f', name: 'cliff-like' }),
]);

const RGB = SLOPE_BREAKS.map((b) => [1, 3, 5].map((i) => parseInt(b.color.slice(i, i + 2), 16)));

/** Percent RISE from degrees, the service's own relationship: its custom `Slope` function
 *  answered 32.6432 with SlopeType 1 and 64.059 with SlopeType 2, and tan(32.6432 deg) x 100
 *  is 64.0590. Kept here so nothing anywhere else has to remember which is which. */
export const percentFor = (degrees) => Math.tan((Number(degrees) * Math.PI) / 180) * 100;
export const degreesFor = (percent) => (Math.atan(Number(percent) / 100) * 180) / Math.PI;

/** The one place a steepness becomes words, and it never leaves without its unit. */
export function slopeText(degrees) {
  return `${Math.round(Number(degrees))}° (${Math.round(percentFor(degrees))}% rise)`;
}

const band = (degrees) => SLOPE_BREAKS.findIndex(
  (b) => degrees >= b.from && (b.to === null || degrees < b.to));

/** The legend, in both units on every row, because a reader who knows slope in per cent is
 *  the reader most likely to halve this layer's numbers in their head. */
export function legendRows() {
  return SLOPE_BREAKS.map((b) => ({
    color: b.color,
    name: b.name,
    label: b.to === null
      ? `${b.from}° and steeper (${Math.round(percentFor(b.from))}% rise and more)`
      : `${b.from}–${b.to}° (${Math.round(percentFor(b.from))}–${Math.round(percentFor(b.to))}% rise)`,
  }));
}

/** The exportImage request for one view. Pure, so the geometry can be asserted without a
 *  network call -- and `bboxSR` is in here rather than at the call site for the reason at
 *  the top of this file. Size is clamped to this layer's own cap; the map is free to be
 *  bigger than the picture it is given. */
export function slopeRequestFor({ bboxLonLat, width, height }) {
  const { minLon, minLat, maxLon, maxLat } = bboxLonLat;
  const side = (n) => Math.max(1, Math.min(MAX_IMAGE_SIDE, Math.round(Number(n) || 0)));
  const w = side(width);
  const h = side(height);
  return {
    url: `${SERVICE}/exportImage`,
    params: {
      bbox: `${minLon},${minLat},${maxLon},${maxLat}`,
      bboxSR: String(SRC.request.bboxSR),
      imageSR: String(SRC.request.imageSR),
      size: `${w},${h}`,
      format: SRC.request.format,
      renderingRule: JSON.stringify(SRC.renderingRules.slopeDegrees),
      noData: String(SRC.request.noData),
      noDataInterpretation: SRC.request.noDataInterpretation,
      f: 'image',
    },
    width: w,
    height: h,
  };
}

export function slopeImageUrl(request) {
  const req = request && request.url ? request : slopeRequestFor(request);
  return `${req.url}?${new URLSearchParams(req.params)}`;
}

/** One point, one surface, one pinned cell size. Two calls make a reading: the slope says
 *  whether there is a facing direction at all, and only then does the aspect mean anything. */
export function pointRequestFor({ lon, lat }, surface = 'slope') {
  const rule = surface === 'aspect' ? SRC.renderingRules.aspectDegrees : SRC.renderingRules.slopeDegrees;
  return {
    url: `${SERVICE}/identify`,
    params: {
      geometry: JSON.stringify({ x: Number(lon), y: Number(lat), spatialReference: { wkid: 4326 } }),
      geometryType: 'esriGeometryPoint',
      returnGeometry: 'false',
      returnCatalogItems: 'false',
      pixelSize: `${POINT_CELL_METRES},${POINT_CELL_METRES}`,
      renderingRule: JSON.stringify(rule),
      noData: String(SRC.request.noData),
      noDataInterpretation: SRC.request.noDataInterpretation,
      f: 'json',
    },
  };
}

export const pointUrl = (req) => `${req.url}?${new URLSearchParams(req.params)}`;

/** `identify` states missing data as the STRING "NoData" -- measured, on both rendering
 *  rules, over the open Atlantic. Not 0, not -1, and reading it as a number gives NaN, so
 *  it is caught by name. Three outcomes, never two: a value, a stated absence of data, and
 *  a service that said nothing usable. */
export function readPointValue(body) {
  const raw = body && !body.error ? body.value : undefined;
  if (raw === undefined || raw === null) return { known: false, noData: false, value: null };
  if (String(raw).trim().toLowerCase() === 'nodata') return { known: false, noData: true, value: null };
  const n = Number(raw);
  return Number.isFinite(n) ? { known: true, noData: false, value: n }
    : { known: false, noData: false, value: null };
}

/** The eight-point compass, clockwise from north, which is how the service reports aspect
 *  (0-359, the downslope direction). Words rather than a number: a bearing to a tenth of a
 *  degree over a cell tens of metres across is precision the surface does not have. */
const POINTS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
export function bearingWords(degrees) {
  const d = ((Number(degrees) % 360) + 360) % 360;
  return POINTS[Math.round(d / 45) % 8];
}

/** One place, in the reader's words. The rule that matters is the first branch after
 *  coverage: a slope of zero means there is no facing direction, whatever the aspect
 *  surface says -- and it says 0, which is also due north. */
export function terrainReading({ slope, aspect }) {
  const s = slope || { known: false, noData: false, value: null };
  const a = aspect || { known: false, noData: false, value: null };
  if (s.noData) {
    return { covered: false, flat: false, degrees: null, percent: null, bearing: null,
      text: 'No elevation model covers this point, so it has no slope or facing to report.' };
  }
  if (!s.known) {
    return { covered: false, flat: false, degrees: null, percent: null, bearing: null,
      text: 'The terrain service did not answer for this point, so its steepness is unknown.' };
  }
  if (s.value === 0) {
    return { covered: true, flat: true, degrees: 0, percent: 0, bearing: null,
      text: 'Flat ground here — slope 0°, so it has no facing direction at all.' };
  }
  const bearing = a.known ? bearingWords(a.value) : null;
  const where = bearing ? `, facing ${bearing}`
    : ' — the service did not give a facing direction here';
  return { covered: true, flat: false, degrees: s.value, percent: percentFor(s.value), bearing,
    text: `Slope ${slopeText(s.value)}${where}. Measured over a cell about `
      + `${POINT_CELL_METRES} metres across, which is the window this number describes.` };
}

/** Recolour a decoded png32 export in place: the red channel IS the degree count and the
 *  alpha channel IS coverage. Ground the model does not reach keeps alpha 0 and is left
 *  transparent rather than being painted the colour of level ground -- which is the one
 *  thing the greyscale formats made impossible. Returns the two counts so the layer row
 *  can say whether it drew anything at all. */
export function paintSlope(rgba, opacity = 255) {
  let covered = 0;
  let missing = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) { missing += 1; continue; }
    covered += 1;
    const [r, g, b] = RGB[band(rgba[i])] || RGB[RGB.length - 1];
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = opacity;
  }
  return { covered, missing };
}

export const LAYER_LABEL = 'Steepness of the ground (slope, in degrees)';
export const LAYER_CAVEAT = 'The shape of the land worked out from a national elevation model — '
  + 'arithmetic on a surface, not a look at the ground. It is not a judgement about whether '
  + 'anywhere is safe to travel: a slope figure says how steeply a patch tilts, averaged over a '
  + 'square tens of metres across, and it knows nothing about the tread underfoot, loose rock, '
  + 'mud, ice, or a drop narrower than the cell it sits in. Nor is it a picture of sun or shade '
  + 'at any hour — which way a hillside faces is a compass direction and nothing more. The '
  + 'elevation under it is bare earth, with trees, buildings and snow taken out. Steepness is in '
  + 'degrees, never per cent rise, and the two are different numbers for the same tilt. On flat '
  + 'ground there is no facing direction and the layer says so rather than choosing one; where '
  + 'the model reaches nothing, it draws nothing.';

/** Every string this layer can put in front of a reader, in one place, so the test can scan
 *  the lot for a number without a unit and for a promise it cannot keep. */
export function readerStrings() {
  return [LAYER_LABEL, LAYER_CAVEAT, CREDIT,
    ...legendRows().map((r) => `${r.name}: ${r.label}`),
    slopeText(0), slopeText(34),
    terrainReading({ slope: { known: true, noData: false, value: 34 }, aspect: { known: true, noData: false, value: 328 } }).text,
    terrainReading({ slope: { known: true, noData: false, value: 0 }, aspect: { known: true, noData: false, value: 0 } }).text,
    terrainReading({ slope: { known: false, noData: true, value: null }, aspect: { known: false, noData: true, value: null } }).text,
    terrainReading({ slope: { known: false, noData: false, value: null }, aspect: { known: false, noData: false, value: null } }).text,
    coverageText({ covered: 0, missing: 4 }), coverageText({ covered: 4, missing: 0 })];
}

/** What the layer row says about the VIEW, as opposed to a point: whether the model reached
 *  this part of the country at all. An export of nothing is a real answer here, because
 *  alpha tells it apart from level ground. */
export function coverageText({ covered, missing }) {
  if (!covered) {
    return 'The national elevation model does not reach this view, so nothing is drawn. '
      + 'That is missing coverage, not level ground.';
  }
  return missing
    ? 'Part of this view is outside the national elevation model and is left undrawn.'
    : 'Steepness drawn for this view from the national elevation model.';
}

/** Fetched as BYTES, never handed to an <img> as a URL: that is what keeps this host out of
 *  img-src -- the origin is already in connect-src for the route-climb source, so the whole
 *  layer costs the CSP nothing -- and it is the only route that can read the alpha channel
 *  the coverage answer lives in. Never throws the map. */
export async function fetchSlopeImage(request, { fetchImpl = fetch, signal } = {}) {
  const got = await fetchWithDeadline(slopeImageUrl(request), { fetchImpl, signal, timeoutMs: SRC.timeoutMs, read: (res) => res.blob() });
  return got.ok ? got.body : null;
}

export async function fetchPoint(lonLat, surface, { fetchImpl = fetch, signal } = {}) {
  const got = await fetchWithDeadline(pointUrl(pointRequestFor(lonLat, surface)), { fetchImpl, signal, timeoutMs: SRC.timeoutMs });
  return got.ok ? got.body : null;
}

/** A Leaflet image overlay whose picture is re-exported for the view it is asked about, the
 *  same shape as the radar layer -- and deliberately not the same route to the screen. The
 *  radar hands Leaflet a URL; this fetches the bytes, reads the degrees out of them, and
 *  paints its own ramp onto a canvas, because the service's colours have no published
 *  breaks and its alpha is the only thing that separates "flat" from "not surveyed".
 *
 *  `refresh` is called on moveend and zoomend: there is no tile cache (`exportTilesAllowed`
 *  is false), so every extent is a live render and nothing happens unless it is asked for.
 *  An in-flight export for a view the reader has left is abandoned, never drawn. */
export function terrainSlopeLayer(L, { opacity = 0.7, fetchImpl = fetch, documentRef = null } = {}) {
  const doc = documentRef || (typeof document === 'undefined' ? null : document);
  const layer = L.imageOverlay('', [[0, 0], [0, 0]], {
    opacity,
    interactive: false,
    // Decorative: what this surface is gets said in the layer row and the map key, and a
    // screen reader hearing a bitmap called "slope" gains nothing it can act on.
    alt: '',
  });
  let live = null;
  // Bumped by every cancel() and every new ask. An ask holds the number it began under and is stale the
  // moment that is no longer the current one -- through the decode as well as the fetch, because a switch-off
  // or a newer view can land while the picture is still decoding, after `live` has already been cleared.
  let generation = 0;
  layer.cancel = () => { generation += 1; if (live) { live.abort(); live = null; } };
  layer.refresh = async function refresh(map, report = () => {}) {
    if (!doc) return null;
    layer.cancel();
    const mine = generation;
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    live = ctl;
    const b = map.getBounds();
    const size = map.getSize();
    const request = slopeRequestFor({
      bboxLonLat: { minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth() },
      width: size.x,
      height: size.y,
    });
    const blob = await fetchSlopeImage(request, { fetchImpl, signal: ctl ? ctl.signal : undefined });
    if (generation !== mine) return null;   // the reader moved on; this answer is about a view they left
    if (live === ctl) live = null;
    if (!blob) { report(null); return null; }
    let counts;
    try {
      const bitmap = await createImageBitmap(blob);
      if (generation !== mine) return null;   // switched off, or a newer view asked, while this decoded
      const canvas = doc.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      counts = paintSlope(image.data);
      ctx.putImageData(image, 0, 0);
      layer.setBounds(b);
      layer.setUrl(canvas.toDataURL('image/png'));
    } catch {
      // A reply that will not decode is a failed answer, not a reason to leave the row on "Loading...".
      if (generation === mine) report(null);
      return null;
    }
    report(counts);
    return counts;
  };
  return layer;
}
