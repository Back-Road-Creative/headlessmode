// The contour-line context surface: USGS 3DEP's `Contour Smoothed 25` rule, exported as one
// transparent picture per view and laid over the base map. Contours are derived from a gridded
// model, not surveyed, and carry no elevation labels -- this layer never prints one.
//
// The measurements behind the choices (metres over feet, png32 over png) live on the
// `usgs3depContours` row in source-registry.js. The request and fetch machinery is the
// hillshade's, reused rather than copied: same origin, same aspect-preserving size cap, same
// generation- and timeout-guarded fetcher, and the same rule of no automatic retry at 3-8 s per
// image.
import { SOURCES } from './source-registry.js';
import { SYMBOLS } from './legend.js';
import { clampSize, createHillshadeFetcher, hillshadeImageUrl } from './source-hillshade.js';

const SRC = SOURCES.usgs3depContours;

export const CONTOURS_SOURCE = SRC;
export const SERVICE = SRC.serviceUrl;
export const CREDIT = SRC.attribution;
export const MAX_IMAGE_SIDE = SRC.limits.maxImageSide;
export const CONTOUR_RULE = SRC.renderingRules.contour;

/** The exportImage request for one view. Pure, so geometry and rule JSON are assertable
 *  without a network call. */
export function contoursRequestFor({ bboxLonLat, width, height }) {
  const { minLon, minLat, maxLon, maxLat } = bboxLonLat;
  const { width: w, height: h } = clampSize(width, height);
  return {
    url: `${SERVICE}/exportImage`,
    params: {
      bbox: `${minLon},${minLat},${maxLon},${maxLat}`,
      bboxSR: String(SRC.request.bboxSR),
      imageSR: String(SRC.request.imageSR),
      size: `${w},${h}`,
      format: SRC.request.format,
      renderingRule: JSON.stringify(CONTOUR_RULE),
      f: SRC.request.f,
    },
    width: w,
    height: h,
  };
}

export const contoursImageUrl = hillshadeImageUrl;
export const createContoursFetcher = createHillshadeFetcher;

export const LAYER_LABEL = 'Contour lines (25 m interval)';
export const LAYER_CAVEAT = 'Contour lines drawn on the fly from the national elevation model, one '
  + 'line per 25 metres of elevation (about 82 feet) and smoothed. They are derived from a gridded '
  + 'bare-earth model, not surveyed: a small knoll or hollow between two lines is not drawn, a line '
  + 'is not a spot height, and no line is labelled with its elevation. The interval is metric, so '
  + 'do not read it against a feet-based topo sheet. The service has no tile cache, so each view is '
  + 'a live render that can take several seconds, and an area with no coverage draws nothing, '
  + 'which is not the same as flat ground. This is not a survey and says nothing about whether a '
  + 'slope can be climbed. This replaces whichever other context surface was chosen; only one can '
  + 'be drawn at a time.';

export const CONTEXT_ROW = Object.freeze({
  id: 'terrainContours',
  group: 'context',
  label: LAYER_LABEL,
  sourceId: 'usgs3depContours',
  screenOnly: true,      // a live per-view render has no basis for a printed sheet
  rasterSurface: true,   // it fills the view, so the one-surface budget counts it
  defaultOn: false,
  required: false,
  symbolKeys: [SYMBOLS.basemap.key],
  emptyMeans: 'none',
  status: 'live',
  coverageCaveat: LAYER_CAVEAT,
  render: { labels: 'none', dropBelowScale: null },
});

export function readerStrings() {
  return [LAYER_LABEL, LAYER_CAVEAT];
}
