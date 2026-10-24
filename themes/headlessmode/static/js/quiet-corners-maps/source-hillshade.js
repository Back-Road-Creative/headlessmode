// The hillshade context surface: a rendered picture of the model under a CHOSEN light, never
// a measurement and never a real shadow that fell on this ground.
//
// Probed 2026-09-25 over the Blue Ridge (512x512, `usgs3depHillshade` in source-registry.js):
// azimuth 315 answered mean 173.7/sd 33.3, azimuth 135 answered mean 176.0/sd 33.6, distinct
// md5s -- two lights paint the same ground differently. A flat Illinois box held sd 1.4
// regardless of light. `maxImageWidth/Height` on the service is 8000; this layer's own budget
// (`MAX_IMAGE_SIDE`, below) is far under that, because a hillshade export is re-rendered on
// every pan and 3-8s per image is too slow to ask for more pixels than the map can use.
//
// Fixed default: `Hillshade Multidirectional`, a READABILITY light, not one direction's shadow.
// Manual mode: `Hillshade` with Azimuth/Altitude/ZFactor arguments; NW/45 (315, 45) is the
// plan's first manual setting. "Reset light" returns to exactly the fixed rule.
//
// Cancellation/staleness follows source-terrain-surface.js's `live` closure pattern (an
// in-flight request for a view/light the reader has left is dropped, never drawn); the request
// timeout is request.js's deadline at the source's registry `timeoutMs`. No automatic retry loop: a slow/failed request reports its
// status and stops.
//
// "Sun now" is a pure function of lat/lon/date -- quiet-corners-sky/sun-moon.js exports
// altitude only, no azimuth, so this module implements its own self-contained NOAA-style
// approximation rather than editing that file. When the sun is below the horizon, the control
// model says so and falls back to the fixed light; it never clamps a below-horizon sun into
// daytime.
//
// The one sentence this layer must never be read as contradicting: hillshade is not a
// cast-shadow, visibility, or passability calculation.
import { SOURCES } from './source-registry.js';
import { fetchWithDeadline } from './request.js';
import { SYMBOLS } from './legend.js';

const SRC = SOURCES.usgs3depHillshade;

export const HILLSHADE_SOURCE = SRC;
export const SERVICE = SRC.serviceUrl;
export const CREDIT = SRC.attribution;
/** This layer's own cap, not the service's 8000 -- see the header comment. */
export const MAX_IMAGE_SIDE = SRC.limits.maxImageSide;

export const FIXED_RULE = SRC.renderingRules.fixed;
export const DEFAULT_MANUAL = Object.freeze({
  azimuth: SRC.renderingRules.manual.rasterFunctionArguments.Azimuth,
  altitude: SRC.renderingRules.manual.rasterFunctionArguments.Altitude,
});

/** The manual rendering rule for one light. Always built from these two numbers, never from
 *  reader text concatenated into a string -- the whole rule travels through
 *  `JSON.stringify`/`URLSearchParams`. */
export function manualRule(azimuth, altitude) {
  return { rasterFunction: 'Hillshade', rasterFunctionArguments: { Azimuth: azimuth, Altitude: altitude, ZFactor: 1 } };
}

/** Scales width/height down to fit `MAX_IMAGE_SIDE`, PRESERVING ASPECT -- unlike
 *  `source-terrain-surface.js`'s independent-axis `side()` clamp, a hillshade under a chosen
 *  light would visibly distort if stretched. Never exceeds the service's own max either way,
 *  since `MAX_IMAGE_SIDE` already sits far under it. A non-positive dimension is treated as 1. */
export function clampSize(width, height) {
  const w = Math.max(0, Math.round(Number(width) || 0));
  const h = Math.max(0, Math.round(Number(height) || 0));
  if (w <= 0 || h <= 0) return { width: 1, height: 1 };
  if (w <= MAX_IMAGE_SIDE && h <= MAX_IMAGE_SIDE) return { width: w, height: h };
  const scale = MAX_IMAGE_SIDE / Math.max(w, h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** The exportImage request for one view under one light. Pure, so the geometry and the
 *  renderingRule JSON can be asserted without a network call. `mode: 'manual'` requires
 *  `azimuth`/`altitude`; any other mode gets the fixed, readability rule. */
export function hillshadeRequestFor({ bboxLonLat, width, height, mode = 'fixed', azimuth, altitude }) {
  const { minLon, minLat, maxLon, maxLat } = bboxLonLat;
  const { width: w, height: h } = clampSize(width, height);
  const rule = mode === 'manual' ? manualRule(azimuth, altitude) : FIXED_RULE;
  return {
    url: `${SERVICE}/exportImage`,
    params: {
      bbox: `${minLon},${minLat},${maxLon},${maxLat}`,
      bboxSR: String(SRC.request.bboxSR),
      imageSR: String(SRC.request.imageSR),
      size: `${w},${h}`,
      format: SRC.request.format,
      renderingRule: JSON.stringify(rule),
      f: SRC.request.f,
    },
    width: w,
    height: h,
    mode,
  };
}

export function hillshadeImageUrl(request) {
  return `${request.url}?${new URLSearchParams(request.params)}`;
}

/** A generation-guarded, timeout-guarded image fetcher: a response for a bounds/light the
 *  reader has already left is reported `stale`, never drawn, and a request past `timeoutMs`
 *  (default the source's registry `timeoutMs`) aborts and reports `timeout`. No automatic
 *  retry -- a caller that wants another attempt asks again. */
export function createHillshadeFetcher({ fetchImpl = fetch, timeoutMs = SRC.timeoutMs } = {}) {
  let generation = 0;
  async function fetchImage(request, { signal } = {}) {
    generation += 1;
    const myGeneration = generation;
    const got = await fetchWithDeadline(hillshadeImageUrl(request), {
      fetchImpl, signal, timeoutMs, read: (res) => res.blob(),
    });
    if (generation !== myGeneration) return { status: 'stale' };
    if (got.ok) return { status: 'ready', blob: got.body };
    return { status: got.status === 'timeout' ? 'timeout' : 'error', error: got.error };
  }
  return { fetchImage };
}

// --- Sun now: a self-contained, low-precision NOAA-style solar position -----------------
const RAD = Math.PI / 180;

function dayOfYear(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((date.getTime() - start) / 86400000) + 1;
}

/** Declination in degrees, good to about 0.2 degrees -- plenty for a readability light. */
function solarDeclination(n) {
  return 23.44 * Math.sin(RAD * (360 / 365) * (n - 81));
}

/** Solar position for a moment and a place. Ignores the equation of time (a few minutes'
 *  worth of error this layer's light does not need); altitude near solar noon is essentially
 *  unaffected by it since the derivative there is near zero. `aboveHorizon` is the honest
 *  gate: a negative altitude is reported as negative, never clamped to zero. */
export function solarPosition(date, lat, lon) {
  const n = dayOfYear(date);
  const dec = solarDeclination(n);
  const utcHour = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const solarHour = utcHour + lon / 15;
  const hourAngle = (solarHour - 12) * 15;
  const latRad = lat * RAD;
  const decRad = dec * RAD;
  const haRad = hourAngle * RAD;
  const sinAlt = Math.sin(latRad) * Math.sin(decRad) + Math.cos(latRad) * Math.cos(decRad) * Math.cos(haRad);
  const clampedSinAlt = Math.max(-1, Math.min(1, sinAlt));
  const altitude = Math.asin(clampedSinAlt) / RAD;
  const altRad = altitude * RAD;
  const cosLat = Math.cos(latRad);
  const cosAlt = Math.cos(altRad);
  let azimuth = 0;
  if (Math.abs(cosLat) > 1e-9 && Math.abs(cosAlt) > 1e-9) {
    const cosAz = (Math.sin(decRad) - Math.sin(latRad) * clampedSinAlt) / (cosLat * cosAlt);
    azimuth = Math.acos(Math.max(-1, Math.min(1, cosAz))) / RAD;
    if (hourAngle > 0) azimuth = 360 - azimuth;
  }
  return { altitude, azimuth: ((azimuth % 360) + 360) % 360, aboveHorizon: altitude > 0 };
}

// --- The pure light-control model -------------------------------------------------------
export const LIGHT_COPY = Object.freeze({
  fixed: 'Fixed light (Hillshade Multidirectional) — a readability light, not a real time of day.',
  manual: (az, alt) => `Manual light: azimuth ${Math.round(az)}°, altitude ${Math.round(alt)}° — a chosen light, not a real time of day.`,
  belowHorizon: (place) => `The sun is below the horizon${place ? ` at ${place}` : ''} right now, so the fixed light is shown instead.`,
  sunNow: (az, alt, place) => `Sun now${place ? ` at ${place}` : ''}: azimuth ${Math.round(az)}°, altitude ${Math.round(alt)}°.`,
  replacesSurface: 'Hillshade replaces whichever other context surface was chosen — only one can be drawn at a time.',
  notACastShadow: 'Hillshade is not a cast-shadow, visibility, or passability calculation.',
});

export function initialLightState() {
  return { mode: 'fixed', azimuth: null, altitude: null, at: null, place: null, belowHorizon: false };
}

export function setManualLight(state, azimuth, altitude) {
  return { mode: 'manual', azimuth, altitude, at: null, place: null, belowHorizon: false };
}

export function resetLight() {
  return initialLightState();
}

/** Sun now: computes the real solar position and reports it honestly. A below-horizon sun
 *  is never drawn as if it were day -- `ruleForLightState` falls back to the fixed rule and
 *  `lightStateText` says the sun is below the horizon rather than printing a fabricated
 *  altitude. */
export function setSunNow(state, { lat, lon, date, place = null }) {
  const pos = solarPosition(date, lat, lon);
  return {
    mode: 'sun',
    azimuth: pos.azimuth,
    altitude: pos.altitude,
    sunAzimuth: pos.azimuth,
    sunAltitude: pos.altitude,
    at: date,
    place,
    belowHorizon: !pos.aboveHorizon,
  };
}

export function ruleForLightState(state) {
  if (state.mode === 'manual') return manualRule(state.azimuth, state.altitude);
  if (state.mode === 'sun' && !state.belowHorizon) return manualRule(state.azimuth, state.altitude);
  return FIXED_RULE;
}

export function lightStateText(state) {
  if (state.mode === 'manual') return LIGHT_COPY.manual(state.azimuth, state.altitude);
  if (state.mode === 'sun') {
    return state.belowHorizon
      ? LIGHT_COPY.belowHorizon(state.place)
      : LIGHT_COPY.sunNow(state.azimuth, state.altitude, state.place);
  }
  return LIGHT_COPY.fixed;
}

export const LAYER_LABEL = 'Hillshade (adjustable light)';
export const LAYER_CAVEAT = 'A rendered relief picture from the national elevation model under a '
  + 'chosen light direction and altitude, not a measurement: two different lights painted the '
  + 'same Blue Ridge extent to different pixels (measured 2026-09-25, distinct md5s), and a flat '
  + 'Illinois box stayed flat under every light tried. It is not a cast-shadow, visibility, or '
  + 'passability calculation, and it says nothing about the sun at any real hour unless the '
  + 'reader explicitly asks for "Sun now" — and even then, sunlight below the horizon is reported '
  + 'as below the horizon rather than drawn as if it were day. This replaces whichever other '
  + 'context surface was chosen; only one can be drawn at a time.';

/** The context-surface row, in the same shape `layer-registry.js`'s `LAYERS` array declares
 *  every other context surface (see `terrainSlope`) -- exported here, alongside the words it
 *  carries, so a test can prove the row's own shape without duplicating it, and so
 *  `layer-registry.js` can add it verbatim rather than re-typing its fields. Not wired into
 *  `main.js`/controls: that wiring is a later unit's job. */
export const CONTEXT_ROW = Object.freeze({
  id: 'hillshadeLight',
  group: 'context',
  label: LAYER_LABEL,
  sourceId: 'usgs3depHillshade',
  screenOnly: true,      // a live per-view render, re-exported per pan/light change, is no basis for a printed sheet
  rasterSurface: true,   // it fills the view — the surface budget must count it. Not yet in LAYERS: the unit that wires the reader appends this row (layers-reach-paper guard).
  defaultOn: false,
  required: false,
  symbolKeys: [SYMBOLS.basemap.key],
  // An export of nothing is a real answer here, same reasoning as terrainSlope: the service's
  // own coverage, not a near-miss to caveat.
  emptyMeans: 'none',
  status: 'live',
  coverageCaveat: LAYER_CAVEAT,
  render: { labels: 'none', dropBelowScale: null },
});
