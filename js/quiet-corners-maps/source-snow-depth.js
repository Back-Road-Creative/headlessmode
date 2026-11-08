// The modelled snow depth context surface: NOAA NOHRSC's National Snow Analysis (layer 3 of the
// raster/snow MapServer), exported as one transparent picture per view and laid over the base map.
// It is a MODEL on a 1 km grid, never a measurement where the reader stands, and it states no unit
// -- the service names none for its 12 legend bins, so neither does this file.
//
// The measurements behind the choices live on the `nohrscSnowDepth` row in source-registry.js. The
// size cap and the generation- and timeout-guarded fetcher are the hillshade's, reused: same
// "no automatic retry" rule, and the export is fetched as bytes so img-src is unchanged.
import { SOURCES } from './source-registry.js';
import { SYMBOLS } from './legend.js';
import { clampSize, createHillshadeFetcher, hillshadeImageUrl } from './source-hillshade.js';

const SRC = SOURCES.nohrscSnowDepth;

export const SNOW_DEPTH_SOURCE = SRC;
export const SERVICE = SRC.serviceUrl;
export const CREDIT = SRC.attribution;
export const DEPTH_LAYER = SRC.layers.depth;
export const MAX_IMAGE_SIDE = SRC.limits.maxImageSide;

/** The service's own legend for layer 3, bin labels in order, fixture
 *  scripts/qcm/fixtures/nohrsc-snow-depth-legend-2026-10-20.min.json (a test holds them equal). */
export const LEGEND_BINS = Object.freeze([
  '0 - 0.39', '0.39 - 2.0', '2.0 - 3.9', '3.9 - 9.8', '9.8 - 20', '20 - 39',
  '39 - 59', '59 - 98', '98 - 197', '197 - 295', '295 - 394', '394 - 787',
]);

/** The MapServer `export` request for one view. Pure, so geometry and the layer filter are
 *  assertable without a network call. `layers=show:3` is depth only; 7 is water equivalent. */
export function snowDepthRequestFor({ bboxLonLat, width, height }) {
  const { minLon, minLat, maxLon, maxLat } = bboxLonLat;
  const { width: w, height: h } = clampSize(width, height);
  return {
    url: `${SERVICE}/export`,
    params: {
      bbox: `${minLon},${minLat},${maxLon},${maxLat}`,
      bboxSR: String(SRC.request.bboxSR),
      imageSR: String(SRC.request.imageSR),
      size: `${w},${h}`,
      format: SRC.request.format,
      transparent: String(SRC.request.transparent),
      layers: `show:${DEPTH_LAYER}`,
      f: SRC.request.f,
    },
    width: w,
    height: h,
  };
}

export const snowDepthImageUrl = hillshadeImageUrl;
export const createSnowDepthFetcher = createHillshadeFetcher;

export const LAYER_LABEL = 'Snow depth (modelled)';
export const LAYER_CAVEAT = 'A modelled snow depth on a 1 km grid, updated daily: an analysis from '
  + 'a snow model that takes in ground, airborne and satellite snow observations, not a '
  + 'measurement where you stand. A 1 km square averages out slopes, tree lines and road cuts, so '
  + 'it may miss local drifts and bare ridges. An empty (transparent) area means modelled zero or '
  + 'no data, and the service cannot tell the two apart. The service states no unit for its '
  + 'colour bins, so none is given here. It covers the lower 48 states and fills in between the '
  + 'SNOTEL sites, which measure depth at their own spots in the West. It is not a trail or '
  + 'avalanche report. This replaces whichever other context surface was chosen; only one can be '
  + 'drawn at a time.';

/** The key line: the service's own bins, in order, with the honest note about units. */
export function legendText() {
  return `Key, light to dark: ${LEGEND_BINS.join(', ')}. Units not stated by the service.`;
}

export const CONTEXT_ROW = Object.freeze({
  id: 'snowDepthModel',
  group: 'context',
  label: LAYER_LABEL,
  sourceId: 'nohrscSnowDepth',
  screenOnly: true,      // a daily model picture has no basis for a printed sheet
  rasterSurface: true,   // it fills the view, so the one-surface budget counts it
  defaultOn: false,
  required: false,
  symbolKeys: [SYMBOLS.basemap.key],
  // Transparent is modelled zero OR no data and the service does not say which.
  emptyMeans: 'ambiguous',
  status: 'live',
  coverageCaveat: LAYER_CAVEAT,
  render: { labels: 'none', dropBelowScale: null },
});

export function readerStrings() {
  return [LAYER_LABEL, LAYER_CAVEAT, legendText(), CREDIT];
}
