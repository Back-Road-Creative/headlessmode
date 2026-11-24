// BTS National Transportation Noise Map 2020 (Lower 48: aviation + road + rail), a hosted tile
// cache on geo.dot.gov: a CONTEXT surface on the screen, never a printed sheet. Measured live
// 2026-10-20 from this box. Same shape as source-night-lights.js; three measurements differ.
//
// (1) The path is {z}/{y}/{x} under /MapServer/tile, ArcGIS's own order. (2) The cache holds
// levels 1-12 and stops: level 13 answered 404 with a text/html error page, not an empty
// tile, so the ceiling is enforced twice -- tileUrl() refuses it and Leaflet's maxNativeZoom
// upscales level 12 rather than asking for a level that errors. (3) The values are BTS's
// "potential noise levels ... for an average annual day", a 24-hour A-weighted equivalent
// (LAeq) from a model fed 2020 traffic, and BTS says they should not be used for individual
// locations. So this module prints no decibel figure for any place, and the only numbers a
// reader sees are the range BTS's own service legend states for its colour bands.
//
// Alaska and Hawaii are separate services (NTAD_Noise_2020_Alaska_..., _Hawaii_...) with
// their own caches; one Leaflet URL cannot switch service by region, so this row is the
// Lower 48 only and says so rather than painting nothing over the other two.
import { SOURCES } from './source-registry.js';

const SRC = SOURCES.btsTransportNoise;
export const TILE_TEMPLATE = SRC.tile.urlTemplate;
export const MAX_NATIVE_ZOOM = SRC.tile.maxCachedLevelObserved;
export const VINTAGE_YEAR = String(SRC.vintage);
// The map's own ceiling (quiet-corners.js FIELD_MAX_ZOOM), as the night lights use it.
export const MAX_ZOOM = 16;
export const CREDIT = `${SRC.attribution} — ${VINTAGE_YEAR} model`;

export const LAYER_LABEL = `Transportation noise (modelled, ${VINTAGE_YEAR})`;

export const LAYER_CAVEAT = 'Modelled annual average of aircraft, road and rail noise for the lower 48 '
  + `states, from ${VINTAGE_YEAR} traffic: a typical day, not a measurement at your spot or any particular hour. `
  + 'BTS says it should not be used to judge individual locations. Its own legend runs from 45 to over 90 '
  + 'A-weighted decibels, in bands; this map does not redraw them. Alaska and Hawaii are not shown. Detail '
  + `stops at zoom ${MAX_NATIVE_ZOOM}, coarser than the 1:24,000 print scale; closer in, the same picture is enlarged.`;

/** One URL for one tile; RangeError past the cache, as the 404 body is not a tile. */
export function tileUrl({ z, y, x }) {
  if (!Number.isInteger(z) || z < 0 || z > MAX_NATIVE_ZOOM) {
    throw new RangeError(`Transportation noise: the tile set has no level ${z}; it stops at zoom ${MAX_NATIVE_ZOOM}.`);
  }
  return TILE_TEMPLATE.replace('{z}', z).replace('{y}', y).replace('{x}', x);
}

/** The Leaflet arguments, split from the factory so a test needs no Leaflet. */
export function leafletOptions() {
  return {
    url: TILE_TEMPLATE,
    options: {
      attribution: CREDIT,
      maxNativeZoom: MAX_NATIVE_ZOOM,
      maxZoom: MAX_ZOOM,
      tileSize: SRC.tile.size,
      opacity: 0.7,
    },
  };
}

export function transportNoiseLayer(L) {
  const { url, options } = leafletOptions();
  return L.tileLayer(url, options);
}

const ENLARGED = `Enlarged past its detail — the ${VINTAGE_YEAR} noise model stops at zoom ${MAX_NATIVE_ZOOM}.`;

/** The row's short status, or null. An upscaled tile looks exactly like real detail. */
export function zoomStatus(zoom) {
  return Number(zoom) > MAX_NATIVE_ZOOM ? ENLARGED : null;
}

/** Every string this layer shows a reader, in one derived place. */
export function readerStrings() {
  return Object.freeze([LAYER_LABEL, LAYER_CAVEAT, CREDIT, ENLARGED, SRC.coverageSemantics]);
}
