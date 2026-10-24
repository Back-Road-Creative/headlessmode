// What the map is drawn ON, on screen: a choice of one, pure like source-night-lights.js.
//
// The base-map checkbox rendered checked and disabled and controlled nothing the reader
// was looking at: quiet-corners.js adds its own topo tiles at field zoom. Print is not
// touched by this -- a sheet's raster is always topo (layer-registry.js keeps usgsTopo
// `required`), and the aerial and relief companions stay pages in the PDF. The host map
// keeps deciding WHEN a base shows (its FIELD_MIN_ZOOM); this module decides WHICH.
import { SOURCES } from './source-registry.js';

export const DEFAULT_BASE = 'usgsTopo';
export const MAX_ZOOM = 16;   // the map's own ceiling (quiet-corners.js FIELD_MAX_ZOOM)

export const BASES = Object.freeze([
  Object.freeze({ id: 'usgsTopo', label: 'USGS Topo', credit: 'USGS The National Map' }),
  Object.freeze({ id: 'usgsImagery', label: 'Aerial imagery (USGS, refreshed June 2024)', credit: 'USGS The National Map: Orthoimagery, June 2024' }),
  Object.freeze({ id: 'usgsShadedRelief', label: 'Shaded relief (USGS 3DEP)', credit: 'USGS The National Map: 3DEP' }),
  Object.freeze({ id: 'none', label: 'No base map — county map only', credit: null }),
]);
export const BASE_BY_ID = Object.freeze(Object.fromEntries(BASES.map((b) => [b.id, b])));

const base = (id) => {
  if (!BASE_BY_ID[id]) throw new RangeError(`Base map: no such base ${id}.`);
  return BASE_BY_ID[id];
};

/** The Leaflet arguments, split from the factory so a test can assert the ceiling with no
 *  Leaflet in the room. Past `maxNativeZoom` Leaflet enlarges the last cached level rather
 *  than asking for one that answers 404. Tiles draw at full opacity: owned overlays carry
 *  their own backplates, so the base is not dimmed to let anything through. */
export function leafletOptions(id) {
  const src = SOURCES[base(id).id];
  return {
    url: src.tile.urlTemplate,
    options: { attribution: base(id).credit, maxNativeZoom: src.tile.maxCachedLevelObserved, maxZoom: MAX_ZOOM, opacity: 1 },
  };
}

/** The layer itself, or null for 'none' -- nothing to add, the county wash stays. */
export function baseLayer(L, id) {
  if (base(id).id === 'none') return null;
  const { url, options } = leafletOptions(id);
  return L.tileLayer(url, options);
}

const ENLARGED = 'Enlarged past its detail — the relief tiles stop at zoom 13.';

/** The row's short status, or null. Only the relief ends before the map does. */
export function zoomStatus(id, zoom) {
  if (base(id).id === 'none') return null;
  return Number(zoom) > SOURCES[id].tile.maxCachedLevelObserved ? ENLARGED : null;
}

/** Every string a reader sees, for the gate night-lights.test.mjs runs over reader text. */
export function readerStrings() {
  return Object.freeze([...BASES.flatMap((b) => [b.label, b.credit]), ENLARGED].filter(Boolean));
}
