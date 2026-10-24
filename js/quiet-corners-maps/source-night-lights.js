// NASA Black Marble night lights, through GIBS: a continuous-colour CONTEXT surface on
// the screen, never a printed sheet and never an overlay fetched into a build. WMTS
// tiles, no key and no account, already Web Mercator. Measured live 2026-09-11.
//
// THE PROHIBITION, which is the plan's, gated by scripts/qcm/night-lights.test.mjs: this
// layer must never print a Bortle class, a darkness score, or a 1-9 anything derived from
// radiance. Black Marble measures light leaving the ground UPWARD as a satellite sees it;
// the Bortle scale describes what a human eye sees standing underneath. One is not a
// conversion of the other, and a number that looks like a sky rating will be read as one.
// The test extracts every string LITERAL here and in layer-registry.js and fails on those
// claims -- a comment like this may name the prohibition, a reader-facing string may not.
//
// Two measurements shape the rest. The path is {z}/{y}/{x} -- GIBS's own
// {TileMatrix}/{TileRow}/{TileCol}, reversed from the order source-usgs-topo.js uses, so
// swapping them draws a tile from elsewhere on Earth with no error. And the set has
// levels 0-8 and stops: level 9 answered HTTP 400 with a 427-byte XML body, not an empty
// tile, so the ceiling is enforced twice -- tileUrl() refuses it and Leaflet's
// maxNativeZoom upscales level 8 rather than asking for a level that errors.
import { SOURCES } from './source-registry.js';

const SRC = SOURCES.nasaBlackMarble;
export const TILE_TEMPLATE = SRC.tile.urlTemplate;
export const VINTAGES = SRC.time.values;
export const DEFAULT_TIME = SRC.time.default;
export const VINTAGE_YEAR = DEFAULT_TIME.slice(0, 4);   // a reader reads a year, not a date
export const MAX_NATIVE_ZOOM = SRC.tile.maxCachedLevelObserved;
// The map's own ceiling (quiet-corners.js FIELD_MAX_ZOOM): the surface stays on screen past
// its detail instead of vanishing at level 9. CREDIT carries the year because a ten-year-old
// composite dated nowhere reads as a picture of last night.
export const MAX_ZOOM = 16;
export const CREDIT = `${SRC.attribution} — ${VINTAGE_YEAR} composite`;

export const LAYER_LABEL = `Night light emissions (${VINTAGE_YEAR} satellite composite)`;

export const LAYER_CAVEAT = 'Light sent upward from the ground, photographed from orbit and '
  + `averaged over ${VINTAGE_YEAR} — the newest composite this source publishes. Ground with no `
  + 'colour on it emitted no light the satellite could see that year. It records what was '
  + 'emitted then, not what the sky overhead looks like today. Finest detail is zoom 8; '
  + 'closer in, the same picture is enlarged.';

/** One URL for one tile: `y` before `x`, and a time the service publishes. RangeErrors
 *  rather than a shrug -- both failures otherwise answer 400 with an XML body, and
 *  main.js's `fail` shows a RangeError to the reader without a console stack. */
export function tileUrl({ z, y, x, time = DEFAULT_TIME }) {
  if (!VINTAGES.includes(time)) {
    throw new RangeError(`Night lights: this source publishes ${VINTAGES.join(' and ')}, not ${time}.`);
  }
  if (!Number.isInteger(z) || z < 0 || z > MAX_NATIVE_ZOOM) {
    throw new RangeError(`Night lights: the composite has no level ${z}; it stops at zoom ${MAX_NATIVE_ZOOM}.`);
  }
  return TILE_TEMPLATE.replace('{time}', time).replace('{z}', z).replace('{y}', y).replace('{x}', x);
}

/** The Leaflet arguments, split from the factory so a test can assert the ceiling with no
 *  Leaflet in the room. Opacity is fixed, not a control: the plan asks for one only where
 *  it solves a real reading problem. */
export function leafletOptions({ time = DEFAULT_TIME } = {}) {
  return {
    url: TILE_TEMPLATE.replace('{time}', time),
    options: {
      attribution: CREDIT,
      maxNativeZoom: MAX_NATIVE_ZOOM,   // past this, enlarge level 8 rather than 400
      maxZoom: MAX_ZOOM,
      tileSize: SRC.tile.size,
      opacity: 0.8,
    },
  };
}

/** The Leaflet layer itself. `L` is passed in: this module never touches window. */
export function nightLightsLayer(L, { time = DEFAULT_TIME } = {}) {
  const { url, options } = leafletOptions({ time });
  return L.tileLayer(url, options);
}

const ENLARGED = `Enlarged past its detail — the ${VINTAGE_YEAR} composite stops at zoom 8.`;

/** The row's short status, or null. An upscaled tile looks exactly like real detail. */
export function zoomStatus(zoom) {
  return Number(zoom) > MAX_NATIVE_ZOOM ? ENLARGED : null;
}

/** Every string this layer shows a reader, in one derived place, so the Bortle gate holds
 *  the real thing. A reader-facing string not returned here is one the gate cannot see. */
export function readerStrings() {
  return Object.freeze([LAYER_LABEL, LAYER_CAVEAT, CREDIT, ENLARGED,
    zoomStatus(MAX_NATIVE_ZOOM + 1), SRC.coverageSemantics].filter(Boolean));
}
