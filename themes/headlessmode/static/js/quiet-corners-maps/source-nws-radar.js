// A radar picture for the view that is on screen.
//
// Measured live 2026-09-11 against the service itself, with an
// `Origin: https://headlessmode.com` header:
//   ?f=json                    -> 200, access-control-allow-origin echoed the Origin
//   exportImage, 512x512 PNG   -> 200, image/png, 117,263 bytes, transparent
//   /tile/5/12/8               -> 404, text/html, 600 bytes
// There is no `tileInfo` and no tile cache, so this is an exported IMAGE per view
// rather than an XYZ layer like Black Marble -- which is why `radarLayer()` has to be
// told when to redraw instead of leaving it to Leaflet. The service is already Web
// Mercator (wkid 102100 / latestWkid 3857), so nothing is reprojected on the way in.
//
// AGE is the risk this layer carries that no other surface here does. Every other
// one is durable; this is a rolling window the service refills every few minutes,
// so the ONE thing it must never do is show a picture without saying how old it is.
// `frameVintage()` is that, and no reader-facing string comes from anywhere else.
//
// What it is NOT: base reflectivity is what the beam met aloft, not what reached
// the ground, and it is an observation rather than an outlook. The hourly card
// already answers "what will it do"; this answers "what is falling now".
// `readerStrings()` exists so the test can scan the lot for that promise.
import { SOURCES } from './source-registry.js';

const SRC = SOURCES.nwsRadar;

export const RADAR_SOURCE = SRC;
export const SERVICE = SRC.serviceUrl;
/** The service's own export ceiling, read off ?f=json on 2026-09-11. A request past
 *  it is refused outright rather than clamped by the service. */
export const MAX_IMAGE_WIDTH = SRC.limits.maxImageWidth;
export const MAX_IMAGE_HEIGHT = SRC.limits.maxImageHeight;
/** Past this a frame is old enough that a reader would be wrong to act on it. The
 *  service publishes roughly every two minutes; twenty is ten missed cycles. */
export const STALE_AFTER_MINUTES = 20;
export const LAYER_LABEL = 'Precipitation on radar (live)';
export const LAYER_CAVEAT = 'What the radar beam met aloft in the last few minutes, which is not '
  + 'the same as what is reaching the ground: a beam passes over an intervening ridge, and light '
  + 'returns can be dry air or birds. It is an observation of the minutes just past, never an '
  + 'outlook — the hourly card is what answers the hours ahead. Every frame carries the time it '
  + 'was valid, and a frame older than '
  + `${STALE_AFTER_MINUTES} minutes says so rather than being drawn as current.`;
export const CREDIT = SRC.attribution;

/** The exportImage request for one view. Pure: returns url + params, so the geometry
 *  can be asserted without a network call. Sizes are clamped to the service's own
 *  ceiling — a phone in landscape is nowhere near it, but a 4K desktop with a tall
 *  window is closer than it looks. */
export function radarRequestFor({ bboxLonLat, width, height }) {
  const { minLon, minLat, maxLon, maxLat } = bboxLonLat;
  const w = Math.max(1, Math.min(MAX_IMAGE_WIDTH, Math.round(width)));
  const h = Math.max(1, Math.min(MAX_IMAGE_HEIGHT, Math.round(height)));
  return {
    url: `${SERVICE}/exportImage`,
    params: {
      bbox: `${minLon},${minLat},${maxLon},${maxLat}`,
      bboxSR: '4326',
      imageSR: '3857',
      size: `${w},${h}`,
      format: 'png',
      transparent: 'true',
      f: 'image',
    },
    width: w,
    height: h,
  };
}

export function radarImageUrl(request) {
  const req = request.url ? request : radarRequestFor(request);
  return `${req.url}?${new URLSearchParams(req.params)}`;
}

/** How old the frame on screen is, in the words a reader gets. `validEndMs` is the
 *  service's own `timeInfo.timeExtent[1]`; a service that answers without one is a
 *  service whose age is unknown, which is said rather than assumed to be fresh. */
export function frameVintage(validEndMs, nowMs = Date.now()) {
  if (!Number.isFinite(validEndMs) || validEndMs <= 0) {
    return { known: false, stale: true, minutes: null,
      text: 'The radar service did not say when this frame was taken, so its age is unknown.' };
  }
  const minutes = Math.max(0, Math.round((nowMs - validEndMs) / 60000));
  const at = new Date(validEndMs).toISOString().slice(11, 16);
  const stale = minutes > STALE_AFTER_MINUTES;
  const age = minutes === 0 ? 'just now'
    : minutes === 1 ? '1 minute ago'
      : `${minutes} minutes ago`;
  return {
    known: true,
    stale,
    minutes,
    text: stale
      ? `This radar frame is from ${at} UTC, ${age} — too old to act on. The service publishes `
        + 'every few minutes; reopen the layer for a current one.'
      : `Radar valid ${at} UTC, ${age}.`,
  };
}

/** The service's own rolling window, read off its description. Never throws the map:
 *  an unknown age is a state the row can show, not a reason to lose the layer. */
export async function fetchFrameTime({ fetchImpl = fetch, signal } = {}) {
  try {
    const res = await fetchImpl(`${SERVICE}?f=json`, { signal });
    if (!res.ok) return null;
    const body = await res.json();
    const extent = body && body.timeInfo && body.timeInfo.timeExtent;
    return Array.isArray(extent) && extent.length === 2 ? Number(extent[1]) : null;
  } catch (e) {
    return null;
  }
}

/** Every string this layer can put in front of a reader, in one place, so the test
 *  can scan the lot. */
export function readerStrings() {
  return [LAYER_LABEL, LAYER_CAVEAT, CREDIT,
    frameVintage(Date.now() - 60000).text,
    frameVintage(Date.now() - 90 * 60000).text,
    frameVintage(null).text];
}

/** A Leaflet image overlay whose picture is re-exported for the view it is asked
 *  about. `refresh` is called by the app on moveend and zoomend — the service has no
 *  tile cache, so there is nothing for Leaflet to ask for on its own. */
export function radarLayer(L, { opacity = 0.55 } = {}) {
  const layer = L.imageOverlay('', [[0, 0], [0, 0]], {
    opacity,
    interactive: false,
    // Decorative: the reader-facing statement of what this is lives in the layer row
    // and the map key, and a screen reader hearing a bitmap described as "radar" gains
    // nothing it can act on.
    alt: '',
  });
  layer.refresh = function refresh(map) {
    const b = map.getBounds();
    const size = map.getSize();
    layer.setBounds(b);
    layer.setUrl(radarImageUrl({
      bboxLonLat: { minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth() },
      width: size.x,
      height: size.y,
    }));
  };
  return layer;
}
