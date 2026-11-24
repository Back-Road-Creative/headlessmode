// One-shot geolocation for the "Use my location" control (B3). Pure -- no
// DOM, no Leaflet, no `navigator` reference of its own -- so node --test
// covers every outcome without a browser. quiet-corners.js passes its own
// `navigator.geolocation` (or a fake, in tests) and its own coverage bounds
// (the CONUS_BOUNDS constant it already uses for the "whole country" reset)
// in; nothing here imports either.
//
// Contract: ONE `getCurrentPosition` call per `requestOnce`, NEVER
// `watchPosition` -- this is a one-shot fix, not a background location watch
// (plan §4.3). Every outcome (denied, timeout, unavailable, coarse accuracy,
// out-of-area, unsupported, ok) resolves to a classification object and
// never throws or rejects, so a caller can always render `copy` without a
// try/catch of its own.

/** A fix farther than this from its own reported point (in meters) is shown
 *  as approximate rather than treated as a precise location. 2 km, per the
 *  plan's own example threshold -- proposed and not independently measured. */
export const DEFAULT_COARSE_METERS = 2000;

/** [[south, west], [north, east]], the same shape as quiet-corners.js's own
 *  CONUS_BOUNDS -- passed in by the caller rather than duplicated here. */
export function withinBounds(lat, lon, bounds) {
  if (!bounds) return true;
  const [[south, west], [north, east]] = bounds;
  return lat >= south && lat <= north && lon >= west && lon <= east;
}

const COPY = {
  unsupported: 'This browser cannot report your location.',
  denied: 'Location permission was denied. The map has not moved.',
  timeout: 'Finding your location took too long. Try again.',
  unavailable: 'Your location is not available right now. The map has not moved.',
  error: 'Could not find your location. The map has not moved.',
  outOfArea: 'That location is outside the area this map covers. The map has not moved.',
  ok: 'Found your location. The map moved there.',
  coarse: (km) => `Found your approximate location (accuracy over ${km} km). The map moved there.`,
};

/** `{ position, error, bounds, coarseMeters, unsupported }` -> a classification
 *  `{ kind, copy, inArea, approximate, latitude?, longitude?, accuracy? }`.
 *  `kind` is one of 'unsupported' | 'denied' | 'timeout' | 'unavailable' |
 *  'error' | 'out-of-area' | 'ok'. Never throws. */
export function classifyLocateResult({
  position = null, error = null, bounds = null,
  coarseMeters = DEFAULT_COARSE_METERS, unsupported = false,
} = {}) {
  if (unsupported) return { kind: 'unsupported', copy: COPY.unsupported, inArea: false, approximate: false };

  if (error) {
    // GeolocationPositionError codes: 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT.
    if (error.code === 1) return { kind: 'denied', copy: COPY.denied, inArea: false, approximate: false };
    if (error.code === 3) return { kind: 'timeout', copy: COPY.timeout, inArea: false, approximate: false };
    if (error.code === 2) return { kind: 'unavailable', copy: COPY.unavailable, inArea: false, approximate: false };
    return { kind: 'error', copy: COPY.error, inArea: false, approximate: false };
  }

  const coords = position && position.coords;
  if (!coords || typeof coords.latitude !== 'number' || typeof coords.longitude !== 'number') {
    return { kind: 'error', copy: COPY.error, inArea: false, approximate: false };
  }

  const { latitude, longitude, accuracy } = coords;
  if (!withinBounds(latitude, longitude, bounds)) {
    return { kind: 'out-of-area', copy: COPY.outOfArea, inArea: false, approximate: false };
  }

  const approximate = typeof accuracy === 'number' && accuracy > coarseMeters;
  return {
    kind: 'ok',
    copy: approximate ? COPY.coarse(Math.round(coarseMeters / 1000)) : COPY.ok,
    inArea: true,
    approximate,
    latitude,
    longitude,
    accuracy,
  };
}

/** Fires ONE `geolocation.getCurrentPosition` (never `watchPosition`) and
 *  resolves to its classification -- success or failure alike, and an
 *  unsupported/missing `geolocation` too. `options` carries the bounded
 *  `timeout`/`maximumAge` passed straight to `getCurrentPosition` plus the
 *  classifier's own `bounds`/`coarseMeters`. Never rejects. */
export function requestOnce(geolocation, {
  enableHighAccuracy = false, timeout = 10000, maximumAge = 60000,
  bounds = null, coarseMeters = DEFAULT_COARSE_METERS,
} = {}) {
  return new Promise((resolve) => {
    if (!geolocation || typeof geolocation.getCurrentPosition !== 'function') {
      resolve(classifyLocateResult({ unsupported: true }));
      return;
    }
    geolocation.getCurrentPosition(
      (position) => resolve(classifyLocateResult({ position, bounds, coarseMeters })),
      (error) => resolve(classifyLocateResult({ error, bounds, coarseMeters })),
      { enableHighAccuracy, timeout, maximumAge },
    );
  });
}
