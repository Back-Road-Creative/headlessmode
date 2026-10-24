// Quiet Corners Field Maps page: Leaflet area selection, quad search, live sheet plan, source checks, worker build, PDF download. Every rule lives in the tested modules; this only wires them to the controls.
import { EXAMPLE_AREA, recipeFromControls, planForRecipe, orientationAdvice, parseUrlRecipe, sourceStateLine, canBuild, layerReport, sourcesInvalidatedBy, viewportFetchPlan, VIEWPORT_FETCH, sourcesMatchArea, sourcePassQueue, areaSet, areaCleared, areaUndone, areaFromBox, areaFromQuads, areaEnvelope, quadToggled, quadSavings } from './app-state.js';
import { serializeRecipe, parseRecipe } from './sheet-plan.js';
import { inverse, cellsForBbox, bboxOfCells, CELL_DEG, cellId, cellFromId, quadsCoveringBox } from './geometry.js';
import { searchByName, fetchCellsForBbox, statesForCells } from './source-map-index.js';
import { fetchLayer } from './source-mvum.js';
import { fetchRoadQuality } from './source-road-basic.js';
import { createProjectStore } from './project-store.js';
import { sanitizeFilename, M_PER_FOOT } from './pdf.js';
import { createCalibrationPdf } from './calibration.js';
import { createKeySheetPdf } from './key-sheet.js';
import { legendRows } from './legend-view.js';
import { previewPolylines, previewSites, screenScaleDenominator, identify, siteCard, displayStyle, siteIconSvg, CARD_POPUP } from './preview-overlay.js';
import { collectRoutes, hitRoutes, toleranceFor, routeKindOf, routeCardLines, roadNameCardLines, routeName, ROAD_NAME_ID_PREFIX } from './route-identify.js';
import { DEFAULT_EMPHASIS, HIGHLIGHT_LINES, nextDisplay, summaryLine, swatchStyle } from './display-controls.js';
import {
  hillshadeRequestFor, createHillshadeFetcher, initialLightState, setManualLight, resetLight,
  setSunNow, ruleForLightState, lightStateText, DEFAULT_MANUAL, LIGHT_COPY,
} from './source-hillshade.js';
import { contoursRequestFor, createContoursFetcher } from './source-contours.js';
import { snowDepthRequestFor, createSnowDepthFetcher, legendText as snowDepthLegend } from './source-snow-depth.js';
import { avalancheLayer, avalancheReader, areaReport as avalancheReport } from './source-avalanche.js';
import { gaugeLayer, gaugeReader, areaReport as gaugeAreaReport } from './source-stream-gauges.js';
import { railLayer, airportLayer, ntadReader, fetchRail, fetchAirports, railReport, airportReport } from './source-ntad-rail-airports.js';
import { nrhpLayer, fetchNrhp, nrhpReport } from './source-nrhp.js';
import { snotelLayer, fetchSnotel, loadCatalogue as loadSnotelCatalogue, snotelReport } from './source-snotel.js';
import { observationLayer, observationReader, loadCatalogue as loadStationCatalogue, areaReport as stationAreaReport } from './source-nws-observations.js';
import { fetchRecSites } from './source-rec-sites.js';
import { fetchBlmRecSites } from './source-blm-rec-sites.js';
import { fetchTrails } from './source-trails.js';
import { fetchLandBoundaries, FAMILY_SYMBOL, statesWithFamily } from './source-land-boundaries.js';
import { fetchFederalLand, FAMILY_IDS as FEDERAL_IDS } from './source-federal-land.js';
import { fetchWetlands } from './source-wetlands.js';
import { fetchCountyLines } from './source-county-lines.js';
import { fetchSurfaceOwnership } from './source-surface-ownership.js';
import { LAYERS, LAYER_IDS, LAYER_BY_ID, TASK_GROUPS, NO_CONTEXT_ROW_ID, layerControlSpecs, baseControlSpecs, contextControlSpecs,
  CONTEXT_SURFACE_IDS, CONTEXT_OVERLAY_IDS, DEFAULT_CONTEXT, surfaceCaption, enabledLayers, LAYERS_WITH_DRAPE, groupHint } from './layer-registry.js';
import { filterLayerSpecs, layerBadge, layerCountLine, selectedScreenRows, layerAboutText, rowSummaryLine, groupIsCollapsedByDefault,
  activeOnMapRows, groupsToCollapse } from './layer-panel.js';
import { SOURCES, DEFAULT_SOURCE_TIMEOUT_MS } from './source-registry.js';
import { fetchWithDeadline, createLatest } from './request.js';
import { floodZonesLayer, floodReader, readZones as readFloodZones, areaReport as floodAreaReport } from './source-flood-zones.js';
import { PRESETS, presetApplied, presetPreviewText, presetLeavesAlone, opensOn } from './layer-presets.js';
import { DEFAULT_BASE, baseLayer, zoomStatus as baseZoomStatus } from './source-basemaps.js';
import { landCoverLayer, coverageText as landCoverText, defaultYearFor } from './source-land-cover.js';
import { symbolForFeature, SYMBOL_BY_KEY } from './legend.js';
import { trailLabelsFor } from './terrain-overlays.js';
import { tilePlan, runBuild } from './build.js';
import { gbifLayer, gbifReader, readAggregate, areaReport as wildlifeAreaReport, creditLines, dateWindow } from './source-gbif.js';
import { nightLightsLayer, zoomStatus, VINTAGE_YEAR } from './source-night-lights.js';
import { transportNoiseLayer, zoomStatus as noiseZoomStatus, VINTAGE_YEAR as NOISE_YEAR } from './source-transport-noise.js';
import { radarLayer, fetchFrameTime, frameVintage } from './source-nws-radar.js';
import { fetchAccess, accessReport } from './source-padus.js';
import { loadEcoregions, areaReport as ecoregionReport } from './source-ecoregions.js';
import { auroraLayer, fetchAurora, cellsInBbox, areaReport, readForecast } from './source-aurora.js';
import { aqiLayer, aqiReader, readFeatures as readAqiFeatures, areaReport as aqiAreaReport, summarise as aqiSummarise } from './source-aqi.js';
import { smokeLayer, smokeReader, readPlumes, summarise as smokeSummarise, areaReport as smokeAreaReport } from './source-smoke.js';
import { fireLayer, fireReader, readPerimeters, summarise as fireSummarise, areaReport as fireAreaReport } from './source-fire.js';
import { terrainSlopeLayer, coverageText as terrainCoverageText } from './source-terrain-surface.js';
import { attachTerrainControl } from './terrain-view.js';
import { fetchBounded, createSearchGuard } from './source-terrain-names.js';
import { fetchElevations, ELEVATION_SOURCE, ELEVATION_CACHE_LIMIT, pointElevationFact } from './source-elevation.js';
import { createUrlSlot, createLru } from './leak-guards.js';
import { KINDS as NAME_KINDS, namesPlanForView } from './terrain-names.js';
import { placeScreenLabels, dedupeAgainstTownLabels, mergeStreamNames, isStaleGeneration, namesAdapterPayload, STATUS_MESSAGE, cappedMessage, nameCardLines, iconFor, SIZE_SCALE, labelFontSize, measureLabel } from './name-labels.js';
import { fetchRoadNames, createRoadNamesFetcher } from './source-road-names.js';
import { fetchStreamNames } from './source-stream-names.js';
import { layersForZoom } from './road-names.js';
import { placeRoadLabels, reservedFromDom, createDebouncer } from './road-labels.js';
import { placesInView, PLACE_GROUPS, defaultFilters, assignRecIds } from './places-in-view.js';
import { formatFragment, DEFAULT_VIEW } from './view-state.js';
import { createSavedPlacesStore } from './saved-places.js';
import { mountSavedPlaces, statusTextFor, CAMERA_NO_LOCATION } from './saved-places-panel.js';
// layerReport aliased: app-state.js already exports its own layerReport (the printable-vector
// summary line); this is camera-layer.js's own, for the roadCameras report paragraph only.
import { camerasInView, layerReport as cameraLayerReport, cardLines as cameraCardLines, ageText as cameraAgeText, stillPlan as cameraStillPlan, PICTURE_TIMEOUT_MS, cameraRef, findCamera, viewTouchesCoverage, viewTouchesLayer, cameraStatus,
  MIN_PIN_ZOOM, padView, filesInView, failureProvider, pinsToDraw, unloadedFilesNear, nearestCoverage, providerRow as cameraProviderRow, aboutLinkText as cameraAboutLinkText } from './camera-layer.js';
import { expandSnapshot } from './camera-snapshot.js';
import { distanceToPathsMeters } from './near-unpaved.js';

/** A canvas 2D context reused across calls for text measurement -- created lazily so
 *  this module still loads under node --test (no DOM there) and only fails if the
 *  names layer is actually switched on in a browser. */
let nameCtx = null;
function measureName(text, sizePx) {
  if (!nameCtx) nameCtx = document.createElement('canvas').getContext('2d');
  // The label's own face and plate (QQA-05a): the box reserved is the box painted.
  // The CSS paints at var(--qc-label-px), which is rem, so the font size the box
  // must be measured at is sizePx scaled by the reader's root font size (sizePx is
  // the 16px-root value from SIZE_SCALE); at the default 16px root the scale is 1.
  const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return measureLabel(nameCtx, text, sizePx * (root > 0 ? root / 16 : 1));
}

// The "kinds per §4.4 initial list" set, derived from terrain-names.js's exported
// KINDS table rather than source-terrain-names.js's internal (unexported)
// CLASSES_BY_LAYER, which is N1 internals this unit does not own.
const ALL_NAME_KINDS = Object.freeze(Object.entries(NAME_KINDS).filter(([layer]) => /^\d+$/.test(layer)).flatMap(([, t]) => Object.keys(t)));

const { L, PDFLib } = window, $ = (id) => document.getElementById(id), query = new URLSearchParams(location.search);
// Which states' land services this map may reach is a fact about the AREA, not
// about the URL. There used to be a page per state, because a CSP naming every
// state's origins did not fit in a _headers line; it does now (see
// state-pages.js), so the drawn rectangle answers the question instead — and a
// rectangle crossing a state line legitimately answers with two.
const checked = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
const mb = (bytes) => (bytes / 1e6).toFixed(1);
const say = (text) => { $('qcm-status').textContent = text; };
const fail = (err) => { say(err.message || String(err)); if (!(err instanceof RangeError || err instanceof TypeError || err.name === 'AbortError')) console.error(err); };
const toBounds = (b) => [[b.minLat, b.minLon], [b.maxLat, b.maxLon]];
// QUX-11a: the "names" layer's on/off state, the same source renderOverlay's
// own `on` reads (:1510-ish) -- shared by listeners that fire outside
// renderOverlay's flow (a pan alone, a filter change) and so cannot reuse its
// local `on` variable.
const namesOn = () => (state.recipe ? state.recipe.layers : controls().layers).names;
// QUX-11b (§2.6): "The fieldset shows when names OR either rec layer is on."
// Before this unit, every renderNameList(...) call site outside renderNames
// gated on namesOn() alone, so a reader who had only ticked Forest Service or
// BLM recreation sites got pins on the map and no way to open "Places in this
// view" for them at all.
// QQA-08: ...or the forest roads and trails, or the road names lettered on the map, are on.
// `roads` is screen-only (no recipe carries it), so it is read from the controls.
const placesListOn = () => {
  const layers = state.recipe ? state.recipe.layers : controls().layers;
  return !!(layers.names || layers.recSites || layers.blmRecSites || layers.mvum || layers.trails || layersFromControls().roads);
};
const ring = (e, zone, hemisphere) => [[e.minX, e.maxY], [e.maxX, e.maxY], [e.maxX, e.minY], [e.minX, e.minY]]
  .map(([x, y]) => { const p = inverse(x, y, zone, hemisphere); return { minLat: p.lat, maxLat: p.lat, minLon: p.lon, maxLon: p.lon }; });
// `storage` carries only Clear's one-word note (project-store.js CLEARED_KEY): Clear then an
// immediate reload cannot wait for the IndexedDB delete, so the next load reads the note.
const store = createProjectStore({ indexedDB: window.indexedDB, serialize: serializeRecipe, parse: parseRecipe,
  storage: (() => { try { return window.localStorage; } catch { return null; } })() });
// replan()'s latest recipe save, which replan does not await. start() waits on it before
// it sets window.qcRestoreSettled, so that flag means the save has landed too.
let lastSave = Promise.resolve();
// QUX-09a: a separate store/key from the print recipe's 'last' key.
const savedStore = createSavedPlacesStore({ storage: typeof localStorage === 'undefined' ? null : localStorage });
let savedPanel = null;
const CORNERS = { 'min-lat': 'minLat', 'max-lat': 'maxLat', 'min-lon': 'minLon', 'max-lon': 'maxLon' };
const state = { routes: [], roadsPlaced: [], bbox: null, area: null, quadNames: new Map(), areaUndo: null, areaGeneration: 0, recipe: null, plan: null, states: { usgsTopo: 'unchecked', mvum: 'unchecked' }, counts: {}, reports: {}, areaStates: [], mvum: {}, roadQuality: {}, recSites: [], trails: null, land: [], fetchedFor: null, abort: null, names: null, namesFor: null, namesGeneration: 0, namesRetrievedAt: null, passAbort: null, namesPlaced: [], selectedNameId: null, retrievedAt: {},
  // QUX-05c: the full GNIS hit chosen through the "Search places" finder
  // (quiet-corners.js's selectNameHit -> window.qcSelectName), independent of
  // the toggleable "Named places & landmarks" layer -- see
  // drawSelectedSearchFeature below for why a selection must survive that
  // layer being off.
  selectedSearchFeature: null,
  // Whether the selected place's card is open. A redraw draws every pin again and
  // reopens the selected one's card only while this is true: choosing a place sets
  // it, and the reader closing the card (its close button, a map click, another
  // card opening) clears it. See trackSelectedCard below.
  selectedCardOpen: false,
  // QUX-11b (§2.6, "Nearby"): the place Nearest-to sorts distance FROM -- set by a row
  // selection, a GNIS pin click, a rec pin click, or the card's Nearby action, never by
  // a redraw on its own. `null` until one of those fires; places-in-view.js only sorts
  // by distance once it is set. {id, name, lonLat} -- lonLat is [lon, lat], the same
  // shape distanceToPathsMeters (near-unpaved.js) takes.
  nearbyFrom: null,
  // QUX-05b: density/size prefs for named-terrain labels (Q/view-state.js's
  // LABEL_DENSITIES/LABEL_SIZES shape). The control itself lives in
  // quiet-corners.js's DOM/persistence; this is the one copy renderNames (2D,
  // below) and terrainOverlaySnapshot (3D hand-off) both read, kept in sync
  // through window.qcSetLabelPrefs.
  labelPrefs: { density: 'standard', size: 'normal' },
  // U1: Undo/Reset. `lastPresetMove` is the exact undo list applyPreset just captured (or
  // null once used or superseded), and `dirty` is whether anything a preset/Undo/Reset can
  // touch has moved since the page opened. `applyingPreset` suppresses the invalidation
  // below while applyPreset/undoPreset/resetPreset are themselves dispatching change events,
  // so their own moves do not stomp the record they are in the middle of writing.
  lastPresetMove: null, dirty: false, applyingPreset: false };

// A row in this set gets a Retry button (unavailable/partial only). recSites and
// blmRecSites are deliberately absent: both write into the SAME `state.recSites`
// array, one REPLACEing and one APPENDing, so a per-layer retry of either would
// drop or duplicate the other's sites. QUX-11b added the `provider` discriminator
// (source-rec-sites.js, source-blm-rec-sites.js) each entry now carries, so a
// retry COULD tell them apart -- but making the rec layers retriable is a
// follow-up, not this unit, so they stay out of this set.
const RETRIABLE = new Set(['mvum', 'trails', 'federalLand', 'countyLines', 'surfaceOwnership', 'wetlands', 'names', ...Object.keys(FAMILY_SYMBOL)]);
const retrying = new Set();

// ONE map, and only one it can ever be. The builder draws on the map the HOST page
// hands it — on /quiet-corners/, the same map the county chooser uses. The
// fallback that made its own Leaflet instance for a page carrying #qcm-map is
// deleted rather than left dormant: with no way to make a map, a second one
// cannot come back by someone adding a div.
let map, cells, sheets, overlay, selection, handles, overlayRenderer, lights, noise, radar;
// Quad-set selection (QUX-10b): quadCells draws each selected quadrangle, quadRing
// draws its addable 8-neighbours. Both live on overlayRenderer, same as `cells`,
// so every rectangle is a real, tab-reachable <path> (see the comment at attach()).
let quadCells, quadRing;
/** The 3D terrain control's api: renderSources() tells an open panel the 2D layers moved on. */
let terrain3d = null;
/** The terrain surface. Alone among the context surfaces its bytes are FETCHED and
 *  repainted rather than handed to Leaflet as a URL: the service publishes no class
 *  breaks for its own colours, and the export's alpha channel is the only thing that
 *  tells "the elevation model does not reach here" from "level ground". */
let terrain;
/** The two NLCD surfaces. Same fetch-the-bytes route as the terrain above, for a different
 *  reason: the export is handed to Leaflet as a `blob:` URL, which img-src already allows,
 *  so this host is in connect-src only. Each holds the YEAR it is pinned to, because the
 *  service answers its newest year without saying so when a request omits one. */
let landCover, treeCanopy;
/** The aurora grid, held from the one fetch that got it. ~900 KB for the whole globe,
 *  so it is asked for when the switch goes on and never again for a pan. */
let aurora, auroraBody = null;
/** The flood map, asked the same bounded way and for the same reason -- but in FOUR questions
 *  rather than one: is there a map here, how many zones, then the zones and the panels that
 *  date them. source-flood-zones.js holds the order and refuses the last two above its gate. */
let flood, floodReads = null;
/** Air quality, and the one reader on this page whose question is BOUNDED: a bbox query,
 *  so a pan asks something new rather than re-indexing what is held. The reader debounces
 *  and abandons the in-flight query, which is why it is a value and not a bare fetch. */
let aqi, aqiReads = null;
/** Stream gauges (E3): a bounded JSON question like the air quality above, drawn as one marker
 *  per station. `gaugesNewestMs` is the newest reading's own time, for the caption. */
let gauges, gaugeReads = null, gaugesNewestMs = null;
let railLines, railReads = null, airportPoints, airportReads = null;   // BTS rail lines and airports (screen only)
let historicPoints, historicReads = null;   // National Register of Historic Places marks (screen only)
let snotelPoints, snotelReads = null, snotelCatalogue = null;   // SNOTEL snowpack marks (screen only); the site list is cached only on success
/** Weather stations (E4): the same shape as the gauges, over a catalogue file read once (cached
 *  only on success, so turning the layer off and on retries a failed read). */
let stations, stationReads = null, stationsNewestMs = null, stationCatalogue = null;
/** Wildlife records: the other bounded question, and the only surface that draws no picture
 *  at all -- three limit=0 counts per cell, shaded as one box, because 97% of GBIF records
 *  state no coordinate precision and a dot would claim one. */
let wildlife, wildlifeReads = null;
/** The frame time the service last reported, and when we asked. Radar is the only
 *  surface here whose age changes while you look at it, so the row is re-read on a
 *  redraw rather than written once when the switch goes on. */
let radarFrameMs = null;
/** The Level III ecoregions, held from the one fetch that got them. 949,718 bytes for the
 *  whole country, so the export is asked for when the switch goes on and never again: a pan
 *  is not a new question when the answer is national. `null` until then. */
let ecoregions = null, ecoregionsPending = null;
/** The SURFACE's own time, per surface, held so the caption can be rewritten without asking
 *  the service again. Each is the time that surface's `claim` says is the honest one: the
 *  aurora's forecast time, the air quality's observed hour. Null means the service did not
 *  state one, which the caption says out loud rather than filling in with the clock. */
let auroraForecastMs = null, aqiObservedMs = null, smokeObservedMs = null, fireMappedMs = null;
let drawing = false, dragStart = null;
/** The two other bounded surfaces, on the same protocol as the air quality reader above. Smoke's
 *  reader also answers the day-state question when the view came back empty: an empty analysis
 *  and an unanalysed day are different facts. */
let smoke, smokeReads = null, fire, fireReads = null;
// Avalanche danger: one national zone file, kept a while by the reader's store; the view picks the zones.
let avalanche, avalancheReads = null;
// D0/D1: the persistent (non-hover) display state every overlay shape is drawn from.
// The Highlight shortcuts and the Advanced controls both go through nextDisplay(), so
// hover, highlight, spotlight and clear can never compound (see display-controls.js).
let currentDisplay = DEFAULT_EMPHASIS;
// Every symbol key a registered layer draws, mapped back to that layer's own id -- so a
// group-level spotlight ("Highlight trails") can target every shape a layer draws, not
// just the one shape under the pointer that qcLayerId already identifies.
const SYMBOL_KEY_TO_LAYER_ID = Object.freeze(
  Object.fromEntries(LAYERS.flatMap((l) => l.symbolKeys.map((k) => [k, l.id]))),
);
// D2's adjustable hillshade context surface: the layer, its light state, and a fetcher
// that already guards generation/timeout (source-hillshade.js).
let hillshade, hillshadeLight = initialLightState();
const hillshadeFetcher = createHillshadeFetcher();
// Contours (E2): one more per-view export from the same 3DEP service, fetched as the hillshade is.
let contours;
const contoursFetcher = createContoursFetcher();
// Modelled snow depth: the same per-view export shape from NOHRSC's MapServer.
let snowDepth;
const snowDepthFetcher = createSnowDepthFetcher();
// E1: while the 3D terrain panel is open, Leaflet's own settle-triggered viewport
// fetches (browseViewport, below) must not start -- the panel dispatches
// qc:terrain-panel and this is the one flag check that consults it.
let terrainPanelOpen = false;
document.addEventListener('qc:terrain-panel', (e) => { terrainPanelOpen = e.detail.open; });
// QUX-08D: cameras. Screen-only (never on the printed PDF, never on the 3D panel --
// C22/C24), so this is its own small block rather than joining the printable-vector state
// above. U4a: the camera list is the build-time snapshot directory, not a live fetch. The index
// (cameras/index.json) is read once, cached ONLY on success; then each camera file whose bbox meets
// the padded view is read once (cameraFiles, keyed by file) and its pins drawn once, from zoom
// MIN_PIN_ZOOM. A failed read is never cached, so the next toggle-on retries.
let cameraLayer;
const CAMERA_DIR = '/data/quiet-corners-maps/cameras/';
const CAMERA_LAYER_IDS = LAYERS.filter((l) => l.group === 'cameras').map((l) => l.id);
let cameraIndex = null, cameraIndexPending = null;
const cameraFiles = new Map();        // file -> { row, cameras, generatedAt, group }
const cameraFilePending = new Map();  // file -> the one read in flight
const cameraFileFailed = new Set();   // files that failed since their layer was last switched on
const cameraLoading = {};             // layer id -> reads in flight for it
const cameraPinCap = {};              // layer id -> { shown, total } of the last draw (MAX_PINS cap)
// QQA-05r-2: Road names on the screen map. `roadLayer` holds the label markers (pane 'qcm-roads');
// `roads` is the last answer (kept so a label-size change re-places without asking again);
// `roadAbort` is this module's own handle on the request in flight, besides the one the source
// keeps for "latest wins"; `roadCredit` is the credit text currently on the map's attribution.
const ROADS_INPUT = `qcm-layer-${LAYER_BY_ID.roads.id}`;   // layerRow's input id for the row
let roadLayer = null, roadAbort = null, roadCredit = null, roadsBadge = '';
let roads = { status: 'empty', entries: [] };
const ROAD_DEBOUNCE_MS = 400;
const ROAD_FETCH_PAD = 0.3;   // each side, as a share of the view
let roadsFetched = null;       // {zoom, bounds} of the held answer
// Whether a zoom reaches any road layer is road-names.js's call (layersForZoom), not a second
// constant here that could drift from the zoom table.
const roadsReach = (zoom) => layersForZoom(zoom).length > 0;
// The 3D view's own fetcher (QQA-06c-2): the shared one keeps a single request in flight, so
// sharing it would let the screen map and the 3D view abort each other's road request.
const roadFetcher3d = createRoadNamesFetcher();
const roadDebounce = createDebouncer(() => runRoads(), ROAD_DEBOUNCE_MS);
// Named places (GNIS), see runNames: their own per-view pass, declared here beside roads' so the map's
// init can wire it before the function bodies below are reached.
const NAMES_FETCH_PAD = 0.3;       // each side, as a share of the view
const PRINT_NAMES_ZOOM = 20;       // a print wants every kind the budget buys, not one zoom's
let namesAbort = null, namesFetched = null, namesCredit = null;   // namesFetched: {zoom, bounds} of the held answer
const namesDebounce = createDebouncer(() => runNames(), VIEWPORT_FETCH.settleMs);
// QUX-09c: every drawn camera pin by its ref, so Show on a saved camera can open the same pin's
// card. Filled when a file's pins are drawn, emptied when their layer is switched off.
const cameraPins = new Map();
// Leaflet closes the previous popup before opening the next one (Map.openPopup()), so at most one
// picture request is ever in flight -- this "one-player rule" is shared across BOTH providers, not
// per-provider state.
let cameraOpenCtrl = null, cameraOpenUrl = null, cameraOpenTimer = null;

function hostMap() {
  if (window.qcMap) return Promise.resolve(window.qcMap);
  // The dashboard builds its map after its data loads, so the event is the seam.
  return new Promise((resolve) => document.addEventListener('qc:map-ready', (e) => resolve(e.detail.map), { once: true }));
}

/** E2's snapshot hand-off for the 3D terrain panel: everything terrain-view.js
 *  needs to drape overlays, show capability notices and place occluded name
 *  labels, read fresh when the panel opens (plan §4.6: "snapshot the current
 *  area, selection, and compatible layers" on opening) and again after every
 *  2D redraw while it stays open (renderSources), so the panel never shows a
 *  layer as loading after 2D has it. The panel only reads this, so closing
 *  needs nothing restored. State slices only, never `state` itself (Owns: "the snapshot
 *  hand-off", not a second owner of D1/N2/U0's own state). */
function terrainOverlaySnapshot() {
  const recipeOn = state.recipe ? state.recipe.layers : controls().layers;
  // Road names are screen-only: no recipe carries them, so the recipe's layers are one switch
  // behind. The row's own state is read live, and the registry-driven capability list is told
  // the row is off because the road pass reports its own state ("shown", "did not load", ...).
  const on = { ...recipeOn, roads: false };
  const mvumFeatures = Object.values(state.mvum).flatMap((r) => (r && Array.isArray(r.features) ? r.features : []));
  // MVUM features come off the source without a symbolKey (every other layer carries its own),
  // and the drape groups and styles by symbolKey -- so untagged roads drew nothing in 3D.
  // Tag them with the key 2D draws them with (symbolForFeature), the same call renderedKeys makes.
  const mvumTagged = mvumFeatures.map((f) => (f.symbolKey ? f : { ...f, symbolKey: symbolForFeature(f).key }));
  const featuresByLayerId = { trails: state.trails?.features || [], mvum: mvumTagged, recSites: state.recSites || [] };
  // Land boundaries are one flat array tagged with which registry layer each
  // feature belongs to (f.layer) -- the same field renderOverlay's own
  // `on[f.layer]` filter reads -- so bucket them the same way rather than
  // re-deriving the split.
  for (const f of state.land) (featuresByLayerId[f.layer] ||= []).push(f);
  // Camera pins: exactly the ones 2D has on the map now, as points (QC 3D row 7).
  for (const layerId of Object.keys(CAMERA_PIN_CLASS)) {
    featuresByLayerId[layerId] = loadedCameraFiles(layerId).flatMap((e) => e.cameras
      .filter((c) => e.pins?.has(cameraRef(c)))
      .map((c) => ({ id: cameraRef(c), name: c.name, symbolKey: layerId, lonLat: [c.lon, c.lat] })));
  }
  const townLabels = (typeof window !== 'undefined' && Array.isArray(window.qcTownLabels)) ? window.qcTownLabels : [];
  return {
    registry: LAYERS_WITH_DRAPE,
    on,
    statesById: state.states,
    featuresByLayerId,
    // D0's live emphasis state and the same symbolKey -> registry-layer-id
    // lookup renderOverlay already uses for spotlight/dim, so the layer
    // highlighted in 2D is the one highlighted over the relief -- no new
    // emphasis state (brief item 3).
    display: currentDisplay,
    layerIdForKey: (key) => SYMBOL_KEY_TO_LAYER_ID[key] || key,
    names: dedupeAgainstTownLabels(state.names?.features || [], townLabels),
    // Trail names, only while the trails layer is ON in 2D -- the 3D view names what 2D draws.
    trailLabels: on.trails ? trailLabelsFor(state.trails?.features || []) : [],
    // QUX-05b: the same density/size prefs and selection 2D's renderNames
    // reads, so the 3D panel's placeScreenLabels call (terrain-view.js) never
    // falls back to the hardcoded 'standard'/'normal' defaults the 2D side
    // left behind.
    prefs: state.labelPrefs,
    selectedId: state.selectedNameId,
    roads: { on: !!layersFromControls().roads, fetch: roadFetcher3d.fetchRoadNames },
  };
}

/** Everything that needs a map. Called once, with the map the page provides. */
function attach(hostedMap) {
  map = hostedMap;
  // E1: the "3D" control, lazy-loaded -- getArea reads state.bbox at click time, so
  // this needs only a getter, never the state object itself. E2: getOverlayData is
  // the second getter, read at open and again on every renderSources() while the panel is open.
  terrain3d = attachTerrainControl(map, () => state.bbox, {
    getOverlayData: terrainOverlaySnapshot,
    // QC 3D row 5: the 3D dialog's own layer switches tick the 2D checkbox, so the change runs the
    // same handlers a 2D click does and 2D stays the only owner of which layers are on.
    setLayerOn: (id, on) => { const el = $(`qcm-layer-${id}`); if (el && el.checked !== on) el.click(); },
  });
  L.rectangle(toBounds(EXAMPLE_AREA.bboxLonLat), { color: '#a1a1aa', weight: 1, dashArray: '6 4', fill: false, interactive: false }).addTo(map);
  cells = L.layerGroup().addTo(map); sheets = L.layerGroup().addTo(map); overlay = L.layerGroup().addTo(map);
  quadCells = L.layerGroup().addTo(map); quadRing = L.layerGroup().addTo(map);
  // renderOverlay never touches this -- a camera pin is not a previewed vector feature.
  cameraLayer = L.layerGroup().addTo(map);
  // The dashboard builds its map with `preferCanvas: true` (quiet-corners.js:464),
  // which draws vectors into a <canvas>: they are clickable, because the canvas
  // renderer hit-tests, but they are not IN the document, so there is nothing to
  // give a tab stop or an aria-label to. The overlay carries its own SVG renderer
  // so every previewed feature is a real <path> a keyboard can reach. Safe here
  // and nowhere else: previewPolylines caps what it emits per symbol.
  overlayRenderer = L.svg().addTo(map);
  // Same reasoning as the overlay comment above: the print area itself, and the ring
  // cells that extend it, are things a reader edits, not just views -- preferCanvas
  // would make them un-tab-to-able, so they share the overlay's real SVG renderer too.
  selection = L.rectangle(toBounds(EXAMPLE_AREA.bboxLonLat), { renderer: overlayRenderer, color: '#6cc77f', weight: 2, fillOpacity: 0.05 });
  handles = [0, 1].map(() => L.marker([0, 0], { draggable: true, icon: L.divIcon({ className: 'qcm-handle', iconSize: [12, 12] }), keyboard: false })
    .on('dragend', () => { const b = L.latLngBounds(handles.map((h) => h.getLatLng())); setBbox({ minLat: b.getSouth(), minLon: b.getWest(), maxLat: b.getNorth(), maxLon: b.getEast() }); }));

  // The density gate reads the current zoom, so it has to be re-asked when the
  // zoom changes — otherwise a layer that became readable stays hidden until
  // something else happens to redraw.
  // renderLegend too: the key now names what is drawn AT THIS ZOOM, so a reader who
  // zooms in past the topo threshold has to see those rows stop saying "appears when
  // you zoom in" — otherwise the key describes the zoom they arrived at.
  lights = nightLightsLayer(L);   // raster tiles: Leaflet does the asking, not this app
  map.on('zoomend', renderNightLights);
  renderNightLights();
  noise = transportNoiseLayer(L);   // raster tiles, as the lights are
  map.on('zoomend', renderTransportNoise);
  renderTransportNoise();
  // An exported image, not tiles: the service has no cache for Leaflet to ask, so the
  // picture is re-requested for each view -- on pan as well as zoom.
  radar = radarLayer(L);
  map.on('moveend zoomend', renderRadar);
  renderRadar();
  aurora = auroraLayer(L);
  map.on('moveend zoomend', renderAurora);
  renderAurora();
  aqi = aqiLayer(L);
  aqiReads = aqiReader({});
  map.on('moveend zoomend', renderAqi);
  renderAqi();
  gauges = gaugeLayer(L);
  gaugeReads = gaugeReader({});
  map.on('moveend zoomend', renderGauges);
  renderGauges();
  railLines = railLayer(L);
  railReads = ntadReader({ fetchFn: fetchRail });
  airportPoints = airportLayer(L);
  airportReads = ntadReader({ fetchFn: fetchAirports });
  map.on('moveend zoomend', renderRail);
  map.on('moveend zoomend', renderAirports);
  renderRail();
  renderAirports();
  historicPoints = nrhpLayer(L);
  historicReads = ntadReader({ fetchFn: fetchNrhp });
  map.on('moveend zoomend', renderHistoric);
  renderHistoric();
  snotelPoints = snotelLayer(L);
  snotelReads = ntadReader({ fetchFn: (bbox, o) => fetchSnotel(snotelCatalogue, bbox, o) });
  map.on('moveend zoomend', renderSnotel);
  renderSnotel();
  stations = observationLayer(L);
  stationReads = observationReader({});
  map.on('moveend zoomend', renderStations);
  renderStations();
  wildlife = gbifLayer(L);
  wildlifeReads = gbifReader({});
  map.on('moveend zoomend', renderWildlife);
  renderWildlife();
  // Also an export per view, and also with no tile cache behind it -- but read as bytes,
  // because its colours are this site's own and its coverage lives in an alpha channel.
  terrain = terrainSlopeLayer(L);
  map.on('moveend zoomend', renderTerrain);
  renderTerrain();
  // Adjustable hillshade (D2): a qualified rendered picture under a chosen light, the
  // same per-view-export shape as terrain/radar/land cover above.
  hillshade = hillshadeContextLayer(L);
  map.on('moveend zoomend', renderHillshade);
  renderHillshade();
  contours = contoursContextLayer(L);
  map.on('moveend zoomend', renderContours);
  renderContours();
  snowDepth = snowDepthContextLayer(L);
  map.on('moveend zoomend', renderSnowDepth);
  renderSnowDepth();
  avalanche = avalancheLayer(L);
  avalancheReads = avalancheReader({});
  map.on('moveend zoomend', renderAvalanche);
  renderAvalanche();
  // Two more per-view exports with no tile cache, each pinned to a year it states.
  landCover = landCoverLayer(L, { product: 'landCover' });
  treeCanopy = landCoverLayer(L, { product: 'canopy' });
  map.on('moveend zoomend', renderLandCover);
  map.on('moveend zoomend', renderTreeCanopy);
  renderLandCover();
  renderTreeCanopy();
  map.on('zoomend', renderOverlay);
  map.on('zoomend', renderLegend);
  // N2/dedupe: quiet-corners.js's renderPlaceLabels (the dashboard's own town
  // orientation labels) also redraws on every moveend/zoomend, and publishes
  // window.qcTownLabels fresh each time. Reacting to ITS event -- rather than
  // counting on map.on registration order to run this after that one -- is what
  // keeps dedupeAgainstTownLabels (name-labels.js) from ever reading a stale
  // list, no matter what else later changes the town labels (a data arrival, a
  // fresh area). Only the names render needs to redo; nothing else drawn by
  // renderOverlay depends on the town label list.
  document.addEventListener('qc:town-labels-changed', () => {
    if (overlay) renderNames(state.recipe ? state.recipe.layers : controls().layers);
  });
  flood = floodZonesLayer(L);
  floodReads = floodReader({});
  map.on('moveend zoomend', renderFlood);
  renderFlood();
  map.on('zoomend', renderBaseStatus);
  renderBaseStatus();
  smoke = smokeLayer(L);
  smokeReads = smokeReader({});
  map.on('moveend zoomend', renderSmoke);
  renderSmoke();
  fire = fireLayer(L);
  fireReads = fireReader({});
  map.on('moveend zoomend', renderFire);
  renderFire();
  // QQA-05r-2: road names. Their own pane (above the vector overlay at 400, below the town and
  // orientation names at 410 and the markers at 600) that never takes a click, so a road label
  // can never sit between a reader and a pin or a name card.
  map.createPane('qcm-roads');
  map.getPane('qcm-roads').style.zIndex = 405;
  map.getPane('qcm-roads').style.pointerEvents = 'none';
  roadLayer = L.layerGroup().addTo(map);
  map.on('moveend zoomend', () => renderRoads());
  // Names ask for the view the same way roads do, never through the print-area gate.
  map.on('moveend zoomend', () => renderNamesPass());
  // A size or density change re-places from the answer already held; the dashboard re-runs its
  // own town-label declutter in the same event, so ours waits a tick to read the boxes it leaves.
  document.addEventListener('qc:label-prefs-changed', () => setTimeout(drawRoads, 0));
  renderRoads();
  renderNamesPass();
  // QUX-08D: cameras. Deliberately NOT the renderXxx()-on-every-moveend pattern above -- a file's
  // pins are drawn once and never redrawn on pan/zoom. A move only loads the files it newly
  // reaches (none below MIN_PIN_ZOOM), recounts the report and refreshes the entry.
  map.on('moveend', () => { for (const id of CAMERA_LAYER_IDS) refreshCameraLayer(id, false); renderCameraEntry(); });
  // Panning is a viewport change too: a reader who drags east is looking at ground
  // nobody has asked about yet.
  map.on('moveend', browseViewport);
  map.on('zoomend', browseViewport);
  // QUX-11a: a held pan (inside the fetched area) never calls renderOverlay --
  // only zoomend does, above -- so Places in this view would otherwise go
  // stale, still listing names that scrolled out of view. This recompute is
  // pure (places-in-view.js) and never re-places labels.
  map.on('moveend', () => renderNameList(placesListOn()));
  // QQA-08: a tap or click near a drawn forest road or trail opens its card (see onMapIdentify).
  map.on('click', onMapIdentify);
  map.on('mousedown', (e) => { if (drawing) { dragStart = e.latlng; selection.setBounds([dragStart, dragStart]).addTo(map); } });
  map.on('mousemove', (e) => { if (dragStart) selection.setBounds([dragStart, e.latlng]); });
  wireHighlightControls();
  wireHillshadeLightControls();
  // QUX-05b: the density/size control itself lives in quiet-corners.js (DOM +
  // viewPrefsStore persistence) -- this is the one bridge it pushes a resolved
  // {density, size} pref through to the state this module owns, mirroring the
  // window.qcSetScoreOpacity/qcGetScoreOpacity calling convention (defined the
  // other direction, in quiet-corners.js) rather than inventing a new one.
  // QQA-05a: ONE size source for every owned label. The size is written as
  // --qc-label-px on the map container (the CSS of .qcm-name-label, the
  // dashboard's .qc-place-label and the 3D label all read it, falling back to
  // 0.875rem), and 'qc:label-prefs-changed' tells the dashboard -- which draws the
  // town and orientation names itself -- to re-run its declutter at the new size.
  const applyLabelPrefs = function () {
    if (map && map.getContainer) map.getContainer().style.setProperty('--qc-label-px', labelFontSize(state.labelPrefs.size));
    document.dispatchEvent(new CustomEvent('qc:label-prefs-changed', { detail: { ...state.labelPrefs } }));
  };
  window.qcSetLabelPrefs = function (prefs) {
    if (!prefs) return;
    state.labelPrefs = { density: prefs.density, size: prefs.size };
    applyLabelPrefs();
    if (map && overlay) renderOverlay();
  };
  window.qcGetLabelPrefs = function () { return state.labelPrefs; };
  // QUX-05c: quiet-corners.js's selectNameHit (the "Search places" finder) calls
  // this instead of building its own bespoke details DOM -- the one card this
  // unit renders is drawn by drawSelectedSearchFeature below, on the SAME
  // Leaflet popup a map-pin click opens.
  window.qcSelectName = function (hit) {
    state.selectedSearchFeature = hit || null;
    state.selectedNameId = hit ? hit.id : null;
    state.selectedCardOpen = !!hit;
    if (map && overlay) renderSources();
  };
  // Same B1 handoff as start()'s applyPreset(viewToPresetShape(...)) call below
  // for base/context/overlays (view-state.js's window.qcInitialView, resolved by
  // quiet-corners.js's createMap() before this module's attach() ever runs) --
  // read directly here rather than waiting for a later qcSetLabelPrefs push, so
  // the very first render already honours a shared/saved density or size instead
  // of the {density:'standard', size:'normal'} state default above.
  if (window.qcInitialView && window.qcInitialView.labels) {
    state.labelPrefs = { ...window.qcInitialView.labels };
  }
  applyLabelPrefs();
  map.on('mouseup', (e) => {
    if (!dragStart) return; const b = L.latLngBounds(dragStart, e.latlng); dragStart = null; toggleDraw(false);
    setBbox({ minLat: b.getSouth(), minLon: b.getWest(), maxLat: b.getNorth(), maxLon: b.getEast() });
  });
  // Escape cancels an in-progress draw only -- scoped to `drawing`, not a general
  // "closes the top transient thing" dispatcher (that generalization is later work).
  // Registered here (not at module top level) because `map` doesn't exist until attach() runs.
  map.getContainer().addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !drawing) return;
    dragStart = null; toggleDraw(false);
    // Only a box selection has an outline to restore -- in quads mode the envelope
    // (state.bbox) is a derived value, not a shape the reader drew, so Escape must
    // not conjure a rectangle around it.
    if (state.area?.kind === 'box') selection.setBounds(toBounds(state.bbox)).addTo(map); else selection.remove();
  });
}

// 8-neighbour ring for quads-mode drawing: geometry.js's cellNeighbors only gives
// the 4 orthogonal neighbours (its "New exports" list is fixed at cellId/
// cellFromId/quadsCoveringBox -- appended by 10a, owned append-only), so the
// diagonal 4 this unit's ring rule needs are computed here instead.
function eightNeighborIds(id) {
  const [row, col] = id.split(':').map(Number);
  const out = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (dr === 0 && dc === 0) continue;
    out.push(`${row + dr}:${col + dc}`);
  }
  return out;
}
function ringIdsFor(idSet) {
  const ring = new Set();
  for (const id of idSet) for (const n of eightNeighborIds(id)) if (!idSet.has(n)) ring.add(n);
  return ring;
}

/** Quads mode drawing (§2): each selected cell green with a Remove tooltip, and
 *  the ring of addable neighbours around them -- both on overlayRenderer so every
 *  rectangle is a real <path>, classed and data-quad'd only once actually on the
 *  map (Leaflet's own className option cannot carry a data attribute). */
function drawQuadSelection(ids) {
  const idSet = new Set(ids);
  for (const id of ids) {
    const rect = L.rectangle(toBounds(cellFromId(id)), { renderer: overlayRenderer, color: '#6cc77f', weight: 2, fillOpacity: 0.15 })
      .bindTooltip('Remove this quadrangle').on('click', (e) => { if (!routesNear(e).length) quadRemoved(id); }).addTo(quadCells);
    const el = rect.getElement();
    if (el) { el.classList.add('qcm-quad-selected'); el.setAttribute('data-quad', id); el.setAttribute('tabindex', '-1'); }
  }
  for (const id of ringIdsFor(idSet)) {
    const rect = L.rectangle(toBounds(cellFromId(id)), { renderer: overlayRenderer, color: '#a1a1aa', weight: 1, opacity: 0.4, fillOpacity: 0.02 })
      .bindTooltip('Add this quadrangle').on('click', (e) => { if (!routesNear(e).length) quadAdded(id); }).addTo(quadRing);
    const el = rect.getElement();
    if (el) { el.classList.add('qcm-quad-ring'); el.setAttribute('data-quad', id); el.setAttribute('tabindex', '-1'); }
  }
}

/** General area setter (box or quads, QUX-10b) -- setBbox below is a thin wrapper
 *  over this for the box case. Runs through app-state.js's own areaSet() so this
 *  is the same rule app-state.test.mjs / print-area-clear.test.mjs already hold:
 *  the replaced area becomes the one-step undo, and an undo already in hand from
 *  an earlier Clear carries forward untouched when there is no current area to
 *  capture (recordUndo:false, used only by undoArea below, skips this entirely --
 *  Undo must never record itself as its own undo). `area` is never null here --
 *  callers that can reach "no area" (Clear, or the last quad toggled off) go
 *  through clearArea() instead, which has its own undo-capture shape. */
function setArea(area, { title, fit = false, recordUndo = true, announce } = {}) {
  if (recordUndo) {
    state.areaUndo = areaSet({ area: state.area, title: $('qcm-title').value, undo: state.areaUndo }, area, title).undo;
  }
  state.area = area;
  state.bbox = areaEnvelope(area); // the envelope every existing reader (terrain getter, sourcePass, canBuild) keeps reading
  state.areaGeneration = (state.areaGeneration ?? 0) + 1;
  state.passAbort?.abort();   // the source pass for the area just replaced stops asking
  if (title) $('qcm-title').value = title;
  const b = state.bbox;
  for (const [k, n] of Object.entries(CORNERS)) $(`qcm-${k}`).value = b[n].toFixed(4);
  cells.clearLayers(); quadCells.clearLayers(); quadRing.clearLayers();
  if (area.kind === 'quads') {
    // §2 map-drawing rules: hide the box selection and both handles in quads mode.
    selection.remove();
    for (const h of handles) h.remove();
    drawQuadSelection(area.ids);
  } else {
    selection.setBounds(toBounds(b)).addTo(map);
    handles[0].setLatLng([b.minLat, b.minLon]).addTo(map); handles[1].setLatLng([b.maxLat, b.maxLon]).addTo(map);
    const pad = { minLon: b.minLon - CELL_DEG, minLat: b.minLat - CELL_DEG, maxLon: b.maxLon + CELL_DEG, maxLat: b.maxLat + CELL_DEG };
    for (const c of cellsForBbox(pad)) {
      if (c.minLon >= b.minLon && c.maxLon <= b.maxLon && c.minLat >= b.minLat && c.maxLat <= b.maxLat) continue;
      const cid = cellId(c);
      const rect = L.rectangle(toBounds(c), { renderer: overlayRenderer, color: '#a1a1aa', weight: 1, opacity: 0.4, fillOpacity: 0.02 }).bindTooltip('Extend print area here')
        .on('click', (e) => { if (!routesNear(e).length) quadAdded(cid); }).addTo(cells);
      // Same data-quad convention as drawQuadSelection's ring (D3: this cell is the
      // same "click to add this quadrangle" affordance, just offered before quads
      // mode has been entered yet), so a test or an assistive reader can name it.
      const el = rect.getElement();
      // Pointer-only cells with no name: out of the Tab order (the print-area controls are the keyboard route), not a nameless stop.
      if (el) { el.setAttribute('data-quad', cid); el.setAttribute('tabindex', '-1'); }
    }
  }
  if (fit) map.fitBounds(toBounds(b), { padding: [20, 20] });
  resetSources(); replan();
  renderQuadUI();
  renderAreaStrip(announce);
}

function setBbox(b, opts) { setArea(areaFromBox(b), opts); }

/** Ring-cell click (both the box-mode "extend" ring drawn above and the quads-mode
 *  ring drawn by drawQuadSelection): box mode is D3's one-way conversion to quads
 *  (quadsCoveringBox(bbox) plus the clicked cell), announced as a snap since the
 *  reader did not ask for every one of those quads by name; quads mode is a plain
 *  add, since a ring cell is by construction not already selected. */
function quadAdded(id) {
  const wasBox = state.area?.kind === 'box';
  setArea(quadToggled(state.area, id), { announce: wasBox ? 'Snapped to whole quadrangles — Undo to go back' : undefined });
}

/** Selected-quad click or the list's Remove button: both are only ever wired to an
 *  id already in state.area.ids, so this always removes. Removing the last quad
 *  is Clear's own contract (one-step undo, handoff params stripped, store
 *  cleared) -- quadToggled returning null is exactly that case (§2). */
function quadRemoved(id) {
  if (state.area?.kind !== 'quads') return;
  const next = quadToggled(state.area, id);
  if (next === null) { clearArea(); return; }
  setArea(next, {});
}

/** Quad search pick (D2): from box or no area the picked quad becomes the whole
 *  selection -- a single quad, not unioned with the box or its covering quads
 *  (that union is D3's ring-click behaviour, not this one). From quads it adds,
 *  never replaces, so search is the one way to build islands that are far apart. */
function quadPicked(id, name) {
  state.quadNames.set(id, name);
  const ids = state.area?.kind === 'quads' ? state.area.ids : [];
  setArea(areaFromQuads([...ids, id]), { title: name, fit: true });
}

const pageWord = (n) => `${n} page${n === 1 ? '' : 's'}`;
/** §2 list spec's three savings strings, plus a fourth (not enumerated there) for
 *  the one case quadSavings itself documents but the list-item spec's three
 *  strings don't cover: the last remaining quad, whose removal is Clear, not a
 *  smaller plan -- "saves no pages" would be dishonest, since no neighbour keeps
 *  its ground on paper afterward (R2: no invented reassurance). */
function savingsText(n) {
  if (n === null) return 'removing this clears the area';
  if (n > 0) return `saves ${pageWord(n)}`;
  if (n < 0) return `adds ${pageWord(-n)}`;
  return 'saves no pages — its ground still prints on neighbouring sheets';
}

/** Name priority (§2): the findQuad result name, else the map-index name stashed
 *  in state.quadNames by sourcePass, else the cell centre. Never persisted. */
function quadDisplayName(id) {
  const named = state.quadNames.get(id);
  if (named) return named;
  const c = cellFromId(id);
  const lat = (c.minLat + c.maxLat) / 2, lon = (c.minLon + c.maxLon) / 2;
  return `Quadrangle at ${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`;
}

/** Shows/hides #qcm-quad-list and the corner-input hint, and in quads mode rebuilds
 *  the list rows from state.recipe -- called after replan() (setArea, clearArea)
 *  so quadSavings sees the recipe for the area just set, not the previous one. */
function renderQuadUI() {
  const inQuads = state.area?.kind === 'quads';
  const hint = $('qcm-quad-hint');
  if (hint) hint.hidden = !inQuads;
  const list = $('qcm-quad-list');
  if (!list) return;
  list.hidden = !inQuads;
  if (!inQuads) { list.replaceChildren(); return; }
  const savings = state.recipe?.quads ? quadSavings(state.recipe) : null;
  list.replaceChildren();
  for (const id of state.area.ids) {
    const name = quadDisplayName(id);
    const li = document.createElement('li');
    li.dataset.quad = id; // same data-quad convention as the map paths (§8/testability)
    const label = document.createElement('span');
    label.textContent = `${name} — ${savingsText(savings ? savings[id] : null)}`;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.textContent = 'Remove'; btn.setAttribute('aria-label', `Remove ${name}`);
    btn.addEventListener('click', () => {
      const rows = [...list.querySelectorAll('button')];
      const idx = rows.indexOf(btn);
      quadRemoved(id);
      const after = [...list.querySelectorAll('button')];
      (after[idx] ?? after[idx - 1] ?? $('qcm-area-undo')).focus();
    });
    li.append(label, btn);
    list.append(li);
  }
}

/** Strips the params that restore an area (the county-finder handoff ?v=&lat=&lon=&w=&label=,
 *  and the ?fixture= proof hook) so a reload after Clear does not re-derive the just-cleared
 *  area from the URL -- the same history.replaceState pattern quiet-corners.js's "Reset view"
 *  uses. The #map= fragment (view, base layer, overlays) is not area state and stays. */
function stripAreaHandoffParams() {
  if (!location.search) return;
  const q = new URLSearchParams(location.search);
  for (const k of ['v', 'lat', 'lon', 'w', 'label', 'fixture']) q.delete(k);
  const rest = q.toString();
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
}

/** Clear: removes the print area entirely -- map selection, handles, ring cells,
 *  the four coordinate inputs, the title, any in-flight source-check pass, the
 *  saved recipe, and the county-finder handoff query. The cleared area becomes
 *  the one-step Undo. */
function clearArea() {
  if (!state.area) return;
  // areaCleared() (app-state.js): the cleared area becomes the one-step undo.
  state.areaUndo = areaCleared({ area: state.area, title: $('qcm-title').value, undo: state.areaUndo }).undo;
  state.abort?.abort();
  state.area = null;
  state.bbox = null;
  state.areaGeneration = (state.areaGeneration ?? 0) + 1;
  state.passAbort?.abort();
  selection.remove();
  for (const h of handles) h.remove();
  cells.clearLayers(); quadCells.clearLayers(); quadRing.clearLayers(); sheets.clearLayers();
  for (const k of Object.keys(CORNERS)) $(`qcm-${k}`).value = '';
  $('qcm-title').value = '';
  resetSources(); replan();
  renderQuadUI();
  store.clear();
  stripAreaHandoffParams();
  renderAreaStrip();
}

/** Undo: restores the area Clear (or the last setBbox) just replaced. One step,
 *  same contract as the existing layer-preset Undo (content/quiet-corners-maps.md:26). */
function undoArea() {
  if (!state.areaUndo) return;
  // areaUndone() (app-state.js): restores the captured area exactly once.
  const next = areaUndone({ area: state.area, title: $('qcm-title').value, undo: state.areaUndo });
  state.areaUndo = next.undo;
  setArea(next.area, { title: next.title, fit: false, recordUndo: false });
  store.saveRecipe(state.recipe);
  renderAreaStrip('Print area restored');
}

/** Shows/hides the Clear/Undo/Edit strip and keeps its Undo button and status text
 *  in sync with state -- called from setBbox, clearArea and undoArea. `text`, when
 *  given, overrides the default announcement (undoArea uses it so the aria-live
 *  region says "restored" rather than the generic "selected").
 *
 *  The strip shows while there is an area OR an undo in hand -- not just an area
 *  -- because Undo lives inside it (dashboard template) and has to stay reachable
 *  right after Clear, when there is no area but there is exactly one step back
 *  (content/quiet-corners-maps.md:13,207). With no area, Edit and Clear are
 *  disabled: there is nothing to edit or clear. Once Undo is used, or a new area
 *  is drawn, state.bbox is set again and the strip returns to its normal rules. */
function renderAreaStrip(text) {
  const strip = $('qcm-area-strip');
  if (!strip) return;
  const hasArea = !!state.area;
  const hasUndo = !!state.areaUndo;
  strip.hidden = !hasArea && !hasUndo;
  $('qcm-area-undo').disabled = !hasUndo;
  $('qcm-area-edit').disabled = !hasArea;
  $('qcm-area-clear').disabled = !hasArea;
  // §6: quads mode shows a count instead of the generic "Print area selected".
  const quadsCount = state.area?.kind === 'quads' ? state.area.ids.length : 0;
  const defaultText = quadsCount ? `${quadsCount} quadrangle${quadsCount === 1 ? '' : 's'} selected` : hasArea ? 'Print area selected' : hasUndo ? 'Print area cleared' : '';
  $('qcm-area-strip-text').textContent = text || defaultText;
}

function controls() {
  return { orientation: checked('qcm-orientation'), scale: Number($('qcm-scale').value), overlapIn: Number($('qcm-overlap').value), dpi: Number(checked('qcm-dpi')),
    grid: checked('qcm-grid') === 'none' ? 'none' : 'utm-1km', layers: layersFromControls() };
}

/** Reads every registry layer's own checkbox; a required layer is always on. The raster
 *  context surfaces have no checkboxes -- they are one radio group, so at most one can be on
 *  and the reader's single choice answers for all of them. The vector context overlays (fire,
 *  air quality, ...) are ordinary checkboxes and are read like any other layer. */
function layersFromControls() {
  const surface = currentContext();
  return Object.fromEntries(LAYERS.map((l) => {
    if (CONTEXT_SURFACE_IDS.includes(l.id)) return [l.id, l.id === surface];
    const el = $(`qcm-layer-${l.id}`);
    return [l.id, l.required || (el ? el.checked : !!l.defaultOn)];
  }));
}

/** The screen base the reader chose. Nothing is persisted: with no radio yet, or none
 *  ticked, it is topo, so a reader who never opens the panel sees today's map. */
const currentBase = () => checked('qcm-base') || DEFAULT_BASE;

/** The host map owns WHEN a base shows (its field zoom); this hands it WHICH. */
function setBase() {
  if (map && map.qcBase) map.qcBase.set(baseLayer(L, currentBase()));
  renderBaseStatus(); renderLegend();
}

/** The context surface the reader chose. Nothing is persisted: with no radio yet, or none
 *  ticked, it is 'none', so a reader who never opens the panel has a clear map. */
const currentContext = () => checked('qcm-context') || DEFAULT_CONTEXT;

/** One radio moved, so EVERY raster surface redraws -- not only the one that came on. The
 *  one that went off has to take itself off the map, and with four checkboxes each redrew
 *  only itself. `CONTEXT_RENDER` is the same table the checkboxes used; every surface in it
 *  runs. The vector overlays are not touched: they are not in this choice (setOverlay). */
function setContext() {
  invalidate({ layers: Object.fromEntries(CONTEXT_SURFACE_IDS.map((id) => [id, id === currentContext()])) });
  for (const id of CONTEXT_SURFACE_IDS) CONTEXT_RENDER[id]();
  renderSurfaceCaption(); replan(); renderLegend(); syncHillshadeLightVisibility();
}

/** One vector context overlay (fire perimeters, air quality, ...) switched on or off. Its own
 *  checkbox, so it moves nothing else: the raster surface and every other overlay stay as
 *  they were, which is how fire and air quality are drawn together. Redraws itself through
 *  the same `CONTEXT_RENDER` table the surfaces use. */
function setOverlay(event) {
  const input = event.target;
  invalidate({ layers: { [input.value]: input.checked } });
  CONTEXT_RENDER[input.value]();
  renderSurfaceCaption(); replan(); renderLegend();
}

/** QUX-04b: the manual light knobs are only meaningful once hillshadeLight is the chosen
 *  context surface, so Map appearance hides the fieldset (never removes it — its ids stay
 *  wired) the rest of the time and shows a one-line hint in its place, so opening Map
 *  appearance never reveals an empty box. `hidden` on the whole fieldset, not
 *  `.qcm-hillshade-light`'s own display, so its legend goes with it. */
function syncHillshadeLightVisibility() {
  const fieldset = $('qcm-hillshade-fieldset'), hint = $('qcm-appearance-hint');
  const off = currentContext() !== 'hillshadeLight';
  if (fieldset) fieldset.hidden = off;
  if (hint) hint.hidden = !off;
}

/** Where each context surface's OWN time is held. The source's `claim` decides WHICH time a
 *  caption shows (layer-registry.js surfaceCaption); this is only the number it shows. The
 *  night lights are an inventory, so what they have is a vintage and not a moment at all. */
const SURFACE_TIME = {
  nightLights: () => ({ vintage: VINTAGE_YEAR }),
  transportNoise: () => ({ vintage: NOISE_YEAR }),
  nwsRadar: () => ({ timeMs: radarFrameMs }),
  // The analysis window's end: the imagery's own time, never the mirror's `last-modified`.
  noaaHmsSmoke: () => ({ timeMs: smokeObservedMs }),
  // An inventory, so the caption wants a VINTAGE: the newest boundary-mapping date in view.
  nifcFirePerimeters: () => ({ vintage: fireMappedMs ? new Date(fireMappedMs).toISOString().slice(0, 10) : null }),
  swpcAurora: () => ({ timeMs: auroraForecastMs }),
  // Nothing goes here for the flood map either, for a sharper version of the same reason.
  // Its vintage is per FIRM PANEL, and one measured view held panels adopted 2012-11-02 and
  // 2016-12-08 -- four years apart. A single date in the caption would be false for most of
  // the screen, so the caption says the time is unknown and the panel RANGE goes in the
  // layer's own row, where it can say which panels it belongs to.
  epaAirNowAqi: () => ({ timeMs: aqiObservedMs }),
  // The newest reading in view: each station states its own, and the row says so.
  streamGauges: () => ({ timeMs: gaugesNewestMs }),
  nwsObservations: () => ({ timeMs: stationsNewestMs }),
  // Nothing goes here for the terrain surface on purpose. It is a CALCULATION over a
  // national compilation that states no date for a given piece of ground, so there is no
  // honest moment to show -- and the caption says the time is unknown rather than
  // borrowing the wall clock, which is the one thing it must not do.
  //
  // The NLCD pair is the opposite case: an annual model DOES state which year it is for,
  // and it is the app that chose it, so the caption carries that year as a vintage rather
  // than a clock time it would have to invent.
  nlcdLandCover: () => ({ vintage: String(landCover ? landCover.year : defaultYearFor('landCover')) }),
  nlcdTreeCanopy: () => ({ vintage: String(treeCanopy ? treeCanopy.year : defaultYearFor('canopy')) }),
};

/** The one line the map itself carries while a surface or context overlay is drawn: which, and
 *  the time its data refers to. On the map rather than inside the Layers panel, because a panel a
 *  reader has closed is not where "you are looking at a picture of an hour ago" belongs. */
function renderSurfaceCaption() {
  const el = $('qcm-surface-caption'); if (!el) return;
  // The chosen raster surface, then each context overlay that is on: all of them can be
  // drawn at once, so each names itself and the time its own data refers to.
  const on = layersFromControls();
  const ids = [currentContext(), ...CONTEXT_OVERLAY_IDS.filter((id) => on[id])];
  const lines = ids.map((id) => surfaceCaption(id, SURFACE_TIME[id] ? SURFACE_TIME[id]() : {})).filter(Boolean);
  // One block per layer, kept by id, so a toggle adds or removes only its own line and the
  // live region announces that line rather than the whole stack read out again.
  const have = new Map([...el.children].map((c) => [c.dataset.layer, c]));
  lines.forEach((c, i) => {
    let line = have.get(c.layerId);
    if (!line) { line = document.createElement('span'); line.className = 'qcm-surface-caption-line'; line.dataset.layer = c.layerId; }
    if (line.textContent !== c.text) line.textContent = c.text;
    if (el.children[i] !== line) el.insertBefore(line, el.children[i] || null);
    have.delete(c.layerId);
  });
  for (const stale of have.values()) stale.remove();
  el.hidden = !lines.length;
}

/** The one status a base row can need: the relief cache ends before the map does. */
function renderBaseStatus() {
  if (!map) return;
  for (const s of baseControlSpecs(currentBase())) {
    const el = $(`${s.inputId}-report`); if (!el) continue;
    const status = s.checked ? baseZoomStatus(s.id, map.getZoom()) : null;
    el.textContent = status || ''; el.hidden = !status;
  }
}

/** QUX-04a: toggles a row's `.qcm-hint` note to match its OWN checkbox/radio,
 *  read live from the DOM rather than from whatever `spec.checked` said when the
 *  row was created. A plain click never rebuilds the panel — only an area change
 *  does, via renderLayerControls — so a note that only reflected creation-time
 *  state would go stale the moment a reader flips a switch; for a radio group
 *  it would ALSO go stale the moment a reader picks a DIFFERENT option, since
 *  the radio being switched away from never itself fires `change`. rowSummaryLine
 *  (layer-panel.js) is the one place the on/off decision is made; this only
 *  carries its answer to a note this function did not itself create.
 *
 *  A no-op for a row with no "About this layer" disclosure (`.qcm-layer-about`
 *  — base/context/reading/extras rows never get one, only a federal/state
 *  `layer` row does): THOSE notes are the only place their text lives at all
 *  (no `layer`, no About body to fall back to), so they stay unconditional,
 *  exactly as before this unit. Only a row whose note is ALSO restated in its
 *  own About body (layerAboutText already includes the same coverageCaveat) is
 *  safe to hide while off — and not a disabled one, whose note is the reason it
 *  is disabled and appears nowhere else (rowSummaryLine keeps it). */
function syncRowNote(row) {
  const input = row?.querySelector('input');
  const note = row?.querySelector('.qcm-hint');
  if (!input || !note || !row.querySelector('.qcm-layer-about')) return;
  // QQA-05r-2 / N3: a row that opens ON (Road names, Named places -- layer-presets.js opensOn)
  // keeps its caveat in About only; a paragraph under a switch that is on at every page load
  // would lengthen the default panel.
  if (opensOn(LAYER_BY_ID[input.value] || {})) { note.hidden = true; return; }
  note.hidden = !rowSummaryLine({ checked: input.checked, disabled: input.disabled, note: note.textContent });
}

/** One control row: the checkbox (or a base radio), its caveat, and the slot its
 *  per-layer result is written into after a source check.
 *
 *  `layer` (the registry row, from LAYER_BY_ID) is passed only for a row this panel
 *  can retry and describe on its own: it grows the row a `.qcm-layer-state` badge,
 *  an "About this layer" `<details>`, and — only when the layer is in RETRIABLE —
 *  a Retry button. A row with no `layer` (base map radios, context radios, reading
 *  rows) keeps the plain shape it always had. */
function layerRow(spec, onChange = null, { layer = null } = {}) {
  const row = document.createElement('div');
  row.className = 'qcm-layer-row';
  const label = document.createElement('label');
  const input = document.createElement('input');
  input.type = spec.type || 'checkbox'; input.id = spec.inputId; input.name = spec.name || spec.inputId; input.value = spec.id;
  input.checked = spec.checked; input.disabled = spec.disabled;
  if (spec.noteId) input.setAttribute('aria-describedby', spec.noteId);
  input.dataset.layerLabel = spec.label;   // the Active list names a row without parsing its markup
  // ONE listener per element, same as before U1: `handler` is the caller's own onChange
  // (setBase/setContext) or the default invalidate+replan, and refreshPresetPreviews /
  // refreshPresetButtons run after it rather than as a second listener -- every switch,
  // base and context radio included, moves through this one row function. A hand change
  // (not one applyPreset/undoPreset/resetPreset is itself making) marks the page dirty and
  // retires any pending Undo, since it no longer reflects what is on screen.
  const handler = onChange || (() => { invalidate({ layers: { [spec.id]: input.checked } }); replan(); });
  input.addEventListener('change', (event) => {
    handler(event);
    // A camera or reading row's own handler never reaches renderSources(), which is what
    // writes the count line, and the generic `.qcm-controls` change listener below is
    // attached before these rows exist, so the count is refreshed here for every row.
    renderLayerPanelExtras();
    if (!state.applyingPreset) { state.dirty = true; state.lastPresetMove = null; }
    refreshPresetPreviews();
    refreshPresetButtons();
    // Radios share `name`: the option a reader switched AWAY from never fires
    // its own `change`, so every row of this name is resynced, not just this one.
    document.querySelectorAll(`input[name="${input.name}"]`).forEach((sib) => {
      syncRowNote(sib.closest('.qcm-layer-row'));
    });
  });
  label.append(input, document.createTextNode(` ${spec.label}`));
  if (layer) {
    const badge = document.createElement('span');
    badge.className = 'qcm-layer-state'; badge.id = `${spec.inputId}-badge`; badge.hidden = true;
    label.append(document.createTextNode(' '), badge);
  }
  row.append(label);
  // QUX-04a: an off row shows no paragraph here at all, but ONLY once appending
  // the row is complete — syncRowNote (below, after the About disclosure exists)
  // is what actually applies rowSummaryLine's on/off decision to this element.
  if (spec.note) {
    const note = document.createElement('p');
    note.className = 'qcm-hint'; note.id = spec.noteId; note.textContent = spec.note;
    row.append(note);
  }
  // Filled by renderLayerReports(); empty until Check sources has run.
  const report = document.createElement('p');
  // `reportId` where a spec has one: a context surface is now a radio with its own inputId,
  // and its age line keeps the id renderRadar and the rest already write into.
  report.className = 'qcm-layer-report'; report.id = spec.reportId || `${spec.inputId}-report`; report.hidden = true;
  row.append(report);
  if (layer) {
    if (RETRIABLE.has(layer.id)) {
      const retry = document.createElement('button');
      retry.type = 'button'; retry.id = `${spec.inputId}-retry`; retry.className = 'qcm-layer-retry';
      retry.textContent = 'Retry'; retry.hidden = true;
      retry.addEventListener('click', () => retryLayer(layer.id));
      row.append(retry);
    }
    const about = document.createElement('details');
    about.className = 'qcm-layer-about';
    const summary = document.createElement('summary'); summary.textContent = 'About this layer';
    const body = document.createElement('p'); body.id = `${spec.inputId}-about`;
    about.append(summary, body);
    row.append(about);
  }
  syncRowNote(row);
  return row;
}

/** A layer counts as zoom-blocked when it is on, the map is zoomed out past the
 *  viewport-fetch guard, and nothing has been fetched for it yet — the exact
 *  condition `viewportFetchPlan` (app-state.js) already refuses to fetch under.
 *  This never loosens that guard; it only names why a checked row is not loading. */
function isZoomBlocked(layerId) {
  if (!map || typeof map.getZoom !== 'function') return false;
  // Names follow their own zoom table (namesPlanForView), not the print-source guard: blocked
  // only where no kind of name is drawable at all.
  if (layerId === 'names') return namesPlanForView({ zoom: map.getZoom() }).kinds.length === 0;
  return map.getZoom() < VIEWPORT_FETCH.minZoom && state.states[layerId] === 'unchecked';
}

/** The badge, About text and Retry visibility for every row that carries a
 *  registry `layer` — called from renderSources() so a fetch, a retry or a
 *  filter change all keep them current. Also writes the panel's status-role
 *  count line, over every optional selected layer (`layerCountLine` only
 *  counts what it is handed, so a hidden row still counts as "on"): the badged
 *  federal and state rows plus `selectedScreenRows` for context, reading and camera
 *  rows. A print extra (Print options) is a page in the PDF and is not counted. The base-map
 *  choice is not a layer and is not counted. */
function renderLayerPanelExtras() {
  const layers = state.recipe ? state.recipe.layers : layersFromControls();
  const countRows = [];
  for (const l of LAYERS) {
    if (l.group !== 'federal' && l.group !== 'state') continue;
    const inputId = `qcm-layer-${l.id}`;
    const checked = !!layers[l.id];
    const zoomBlocked = checked && isZoomBlocked(l.id);
    // A screen-only row is not a fetch pass: its badge is the map's own answer (renderRoads).
    // A row that opens ON (opensOn: Road names, Named places) is lettering, not a layer the
    // reader chose, so it stays out of the "layers on" count: a fresh load reads "No layers
    // on", and the count moves only when the reader moves a switch.
    const badgeWord = l.screenOnly
      ? (layersFromControls()[l.id] ? (l.id === 'roads' ? roadsBadge || 'on' : 'on') : 'off')
      : layerBadge({
        checked, required: !!l.required, zoomBlocked,
        state: state.states[l.id] ?? null, featureCount: state.counts[l.id] ?? null,
      });
    if (!opensOn(l)) countRows.push({ badge: badgeWord });
    const badgeEl = $(`${inputId}-badge`);
    if (badgeEl) { badgeEl.textContent = badgeWord; badgeEl.hidden = false; }
    const retryEl = $(`${inputId}-retry`);
    if (retryEl) retryEl.hidden = !(checked && (badgeWord === 'unavailable' || badgeWord === 'partial'));
    const aboutEl = $(`${inputId}-about`);
    if (aboutEl) {
      aboutEl.textContent = layerAboutText({
        layer: l,
        source: l.sourceId ? SOURCES[l.sourceId] || null : null,
        fetchedAt: state.retrievedAt[l.id] || null,
        featureCount: state.counts[l.id] ?? null,
      });
    }
  }
  // The checkboxes themselves, not `layers`: a camera toggle changes no recipe, so
  // `state.recipe.layers` is one switch behind a row that is visibly checked once an area is drawn.
  countRows.push(...selectedScreenRows(LAYERS, layersFromControls()));
  const countEl = $('qcm-layer-count');
  if (countEl) countEl.textContent = layerCountLine(countRows);
  renderActiveLayers();
}

let activeListSignature = null;
/** QQA-18: the compact "Active on map" list, read straight off the switches in the panel (the
 *  same read layersFromControls makes), so it can never disagree with a row. It sits above the
 *  groups and ignores the search and active-only filters: a layer you switched on and then
 *  filtered out of sight is still one press from off. Remove presses the row's own control --
 *  a context surface goes through "No context surface" -- so every handler a click on the row
 *  would run still runs. Retry appears only while the row's own Retry is showing; a print extra
 *  is a page in the PDF, not something on the map, and is never listed. The list is rebuilt only
 *  when what it says changes (see the signature below), so a button handler finds its control by
 *  id when pressed, never by holding the node: renderLayerControls can replace every input. */
function renderActiveLayers() {
  const host = $('qcm-active-layers'); if (!host) return;
  const list = host.querySelector('ul');
  const rows = [...document.querySelectorAll('#qcm-layers .qcm-layer-group input')].map((input) => ({
    id: input.value, label: input.dataset.layerLabel || input.value, checked: input.checked, input,
    group: input.closest('.qcm-layer-group').dataset.taskGroup,
    base: input.name === 'qcm-base' || input.id === 'qcm-context-none',
    lettering: opensOn(LAYER_BY_ID[input.value] || {}),
  }));
  const active = activeOnMapRows(rows).map((r) => {
    const badge = $(`${r.input.id}-badge`), retry = $(`${r.input.id}-retry`);
    return { ...r, word: badge && !badge.hidden ? badge.textContent : '', canRetry: !!(retry && !retry.hidden) };
  });
  host.hidden = !active.length;
  // renderSources runs on every fetch completion, name pick and pin click: rebuilding the list
  // each time would drop keyboard focus from a Remove or Retry button and can swallow a press that
  // straddles the rebuild. Only a change in what the list SAYS touches the DOM.
  const signature = JSON.stringify(active.map((r) => [r.id, r.label, r.word, r.canRetry]));
  if (signature === activeListSignature) return;
  activeListSignature = signature;
  const held = list.contains(document.activeElement)
    ? { id: document.activeElement.closest('[data-active-layer]')?.getAttribute('data-active-layer'), cls: document.activeElement.className } : null;
  list.replaceChildren(...active.map((r) => {
    const item = document.createElement('li');
    item.setAttribute('data-active-layer', r.id);
    const name = document.createElement('span');
    name.className = 'qcm-active-name'; name.textContent = r.label;
    item.append(name);
    if (r.word) {
      const word = document.createElement('span');
      word.className = 'qcm-active-state'; word.textContent = r.word;
      item.append(word);
    }
    if (r.canRetry) {
      const again = document.createElement('button');
      again.type = 'button'; again.className = 'qcm-active-retry'; again.textContent = 'Retry';
      again.setAttribute('aria-label', `Retry ${r.label}`);
      again.addEventListener('click', () => retryLayer(r.id));
      item.append(again);
    }
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'qcm-active-remove'; remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${r.label} from the map`);
    remove.addEventListener('click', () => {
      document.getElementById(CONTEXT_SURFACE_IDS.includes(r.id) ? 'qcm-context-none' : r.input.id)?.click();
      // The list was rebuilt under the focused button: put focus somewhere that still exists.
      (host.hidden ? $('qcm-layer-search') : host.querySelector('.qcm-active-title'))?.focus();
    });
    item.append(remove);
    return item;
  }));
  // A rebuild that had to happen (another row's badge changed) still hands focus back to the
  // same button on the same layer, when both are still there.
  if (held) list.querySelector(`[data-active-layer="${CSS.escape(held.id || '')}"] button.${held.cls.split(' ')[0]}`)?.focus();
}

/** Re-fetches ONE overlay layer — the same adapter call `checkSources` makes for
 *  it, nothing else. Never touches the map view, another layer's data or the
 *  print recipe: it updates this layer's own `state.states`/`state.counts` (and,
 *  for a `state.land` layer, replaces only that layer's entries), then calls
 *  `renderSources()`, the same redraw a fetch inside `checkSources` triggers. */
async function retryPass(id) {
  if (!RETRIABLE.has(id) || retrying.has(id)) return;
  // Names are asked for the view, not the print box: a retry asks the view again.
  if (id === 'names') { namesFetched = null; await runNames(); renderSources(); return; }
  const box = state.fetchedFor || state.recipe?.bboxLonLat;
  if (!box) return;
  retrying.add(id);
  const retryEl = $(`qcm-layer-${id}-retry`);
  if (retryEl) retryEl.disabled = true;
  try {
    if (id === 'mvum') {
      const [roads, trails] = await Promise.all(['roads', 'trails'].map((layer) => fetchLayer({ layer, bboxLonLat: box })));
      state.mvum = { roads, trails };
      state.counts.mvum = roads.features.length + trails.features.length;
      try { state.roadQuality = await fetchRoadQuality({ bboxLonLat: box }); } catch { state.roadQuality = {}; }
      const cov = [roads.coverage, trails.coverage];
      state.states.mvum = cov.every((c) => c === 'complete') ? 'ready' : cov.includes('unavailable') ? 'unavailable' : cov.includes('unknown') ? 'unknown' : 'partial';
    } else if (id === 'trails') {
      state.trails = await fetchTrails({ bboxLonLat: box });
      state.counts.trails = state.trails.features.length;
      state.states.trails = state.trails.coverage === 'complete' ? 'ready' : 'partial';
    } else if (id === 'federalLand') {
      state.land = state.land.filter((f) => f.layer !== id);
      let count = 0, worst = null;
      const answers = await Promise.allSettled(FEDERAL_IDS.map((family) => fetchFederalLand({ family, bboxLonLat: box })));
      for (const a of answers) {
        if (a.status === 'rejected') { worst = 'unavailable'; continue; }
        state.land.push(...a.value.features);
        count += a.value.features.length;
        if (a.value.coverage !== 'complete' && worst !== 'unavailable') worst = 'partial';
      }
      state.counts.federalLand = count; state.states.federalLand = worst || 'ready';
    } else if (id === 'countyLines') {
      state.land = state.land.filter((f) => f.layer !== id);
      const answer = await fetchCountyLines({ bboxLonLat: box });
      state.land.push(...answer.features);
      state.counts.countyLines = answer.features.length;
      state.states.countyLines = answer.coverage === 'complete' ? 'ready' : 'partial';
    } else if (id === 'surfaceOwnership') {
      state.land = state.land.filter((f) => f.layer !== id);
      const answer = await fetchSurfaceOwnership({ bboxLonLat: box });
      state.land.push(...answer.features);
      state.counts.surfaceOwnership = answer.features.length;
      state.states.surfaceOwnership = answer.coverage === 'complete' ? 'ready' : 'partial';
    } else if (id === 'wetlands') {
      state.land = state.land.filter((f) => f.layer !== id);
      const answer = await fetchWetlands({ bboxLonLat: box });
      state.land.push(...answer.features);
      state.counts.wetlands = answer.features.length;
      state.reports.wetlands = answer.report.text;
      state.states.wetlands = answer.refused ? 'unavailable' : answer.coverage === 'complete' ? 'ready' : 'partial';
    } else if (Object.prototype.hasOwnProperty.call(FAMILY_SYMBOL, id)) {
      state.land = state.land.filter((f) => f.layer !== id);
      const codes = statesWithFamily(state.areaStates, id);
      let count = 0, worst = null;
      for (const code of codes) {
        try {
          const r = await fetchLandBoundaries({ state: code, family: id, bboxLonLat: box });
          state.land.push(...r.features);
          count += r.features.length;
          if (r.skipped) worst = 'unavailable';
          else if (r.coverage !== 'complete' && worst !== 'unavailable') worst = 'partial';
        } catch { worst = 'unavailable'; }
      }
      state.counts[id] = count; state.states[id] = worst || 'ready';
    }
    state.retrievedAt[id] = new Date().toISOString();
  } catch (err) {
    state.states[id] = 'unavailable';
    fail(err);
  } finally {
    retrying.delete(id);
    if (retryEl) retryEl.disabled = false;
    renderSources();
  }
}

/** Groups a search or active-only match opened (they were closed), and groups the reader toggled
 *  by hand while that filter was on. Clearing the filter closes the first set minus the second, so
 *  the panel returns to what it was before the search (QQA-18). */
const openedByFilter = new Set();
const touchedWhileFiltering = new Set();
const layerFilterActive = () => !!($('qcm-layer-search')?.value || '').trim() || !!$('qcm-layers-active-only')?.checked;

/** The search box and the "only layers that are on" toggle, together: which rows
 *  and which group headings stay visible, without touching any switch's checked
 *  state. The base radios and "No context surface" always carry `alwaysShow`, so Map style
 *  never reads empty under active-only; every other context radio is a layer like the rest
 *  and is hidden there while it is not the chosen one. A search matches a row's label, note,
 *  keywords and provider, and its group's heading and purpose words. */
function applyLayerFilter() {
  const host = $('qcm-layers'); if (!host) return;
  const query = $('qcm-layer-search')?.value || '';
  const activeOnly = !!$('qcm-layers-active-only')?.checked;
  const rows = [];
  for (const group of TASK_GROUPS) {
    const box = host.querySelector(`.qcm-layer-group[aria-label="${group.label}"]`);
    if (!box) continue;
    for (const row of box.querySelectorAll('.qcm-layer-row')) {
      const input = row.querySelector('input');
      if (!input) continue;
      const layer = LAYER_BY_ID[input.value];
      const source = layer?.sourceId ? SOURCES[layer.sourceId] : null;
      rows.push({
        id: input.id, group: group.id,
        label: row.querySelector('label')?.textContent || '',
        note: row.querySelector('.qcm-hint')?.textContent || '',
        keywords: `${layer?.searchTerms || ''} ${source ? `${source.name} ${source.origin}` : ''}`,
        checked: input.checked,
        alwaysShow: input.name === 'qcm-base' || input.id === 'qcm-context-none',
        el: row,
        groupBox: box,
      });
    }
  }
  const { visibleIds, visibleGroupIds } = filterLayerSpecs(rows, TASK_GROUPS, { query, activeOnly });
  const groupBoxes = new Map();
  for (const r of rows) {
    r.el.hidden = !visibleIds.has(r.id);
    groupBoxes.set(r.group, r.groupBox);
  }
  // UX-03b: the Cameras entry above the groups goes with its rows when a search is for something
  // else. "Only layers that are on" alone never hides it: the coverage note matters most then.
  if (cameraEntry) cameraEntry.hidden = !!query.trim() && !visibleGroupIds.has('cameras');
  // QUX-04a: groups start collapsed, so a match inside a still-closed <details> would be
  // filtered in but invisible. Open it while the reader is filtering, remember that WE opened
  // it, and close it again when the filter clears (QQA-18). A group that was already open, or
  // that the reader toggled themselves meanwhile, is left as they have it.
  const filtering = layerFilterActive();
  for (const [groupId, box] of groupBoxes) {
    const visible = visibleGroupIds.has(groupId);
    box.hidden = !visible;
    if (filtering && visible && !box.open) { box.open = true; openedByFilter.add(groupId); }
  }
  if (!filtering) {
    for (const groupId of groupsToCollapse({ openedByFilter, touched: touchedWhileFiltering })) {
      const box = groupBoxes.get(groupId);
      if (box) box.open = false;
    }
    openedByFilter.clear(); touchedWhileFiltering.clear();
  }
}

/** The one redraw a layer switch owes, by layer. A context surface is the only kind whose
 *  switch does anything beyond the overlay fetch — and until this table only the lights had
 *  it, so ticking radar, aurora or air quality changed nothing until the reader panned.
 *  Everything else is drawn from fetched features by renderOverlay, which replan reaches. */
const CONTEXT_RENDER = {
  nightLights: renderNightLights,
  transportNoise: renderTransportNoise,

  nwsRadar: renderRadar,
  nlcdLandCover: renderLandCover,
  nlcdTreeCanopy: renderTreeCanopy,

  swpcAurora: renderAurora,
  femaNfhl: renderFlood,

  epaAirNowAqi: renderAqi,
  streamGauges: renderGauges,
  nwsObservations: renderStations,
  gbifOccurrence: renderWildlife,

  terrainSlope: renderTerrain,
  noaaHmsSmoke: renderSmoke,
  nifcFirePerimeters: renderFire,

  countyScore: renderCountyScore,
  hillshadeLight: renderHillshade,
  terrainContours: renderContours,
  snowDepthModel: renderSnowDepth,
  avalancheDanger: renderAvalanche,
};

/** The dashboard's own county-comparison colour wash, wired into the same one-dominant-
 *  surface radio group as night lights and the rest. This builder draws none of it — the
 *  wash lives entirely in quiet-corners.js, on the map the two scripts already share — so
 *  this hands the on/off state to the one hook the dashboard exposes on `window` rather
 *  than reaching into its state directly. Kept minimal on purpose: the opacity, threshold
 *  and legend behaviour behind that hook belong to the dashboard, not to this file. */
function renderCountyScore() {
  const layers = layersFromControls();
  const on = !!layers.countyScore;
  if (typeof window.qcSetScoresSurface === 'function') window.qcSetScoresSurface(on);
  renderSurfaceCaption();
}

/** Apply a preset by moving the controls the reader can SEE, and nothing else: each switch is
 *  set and then sent its own change event, so every layer reaches the map down the same path
 *  as a hand-ticked box and this adds no second one. A disabled row (required, or a state
 *  layer this area has no service for) is not a preset's to move. Nothing ends up disabled,
 *  and the status line names what went on — a shortcut you cannot see or undo is a mode.
 *
 *  U1: also records exactly which elements it is about to move, in `undo`, BEFORE moving
 *  them — the only place that already knows which ones that is, so Undo needs no second
 *  pass computing it later. `state.applyingPreset` suppresses layerRow's own dirty/Undo
 *  bookkeeping while these dispatches run, so this function's own bookkeeping at the end
 *  is the one write that lands. Silent (the view-state wiring's initial-view apply, B1) is
 *  a page load, not a preset choice: it neither reports itself nor becomes undoable. */
function applyPreset(p, { silent = false } = {}) {
  const on = new Set(p.layers);
  const moved = [];
  const undo = [];
  state.applyingPreset = true;
  for (const l of LAYERS) {
    const el = $(`qcm-layer-${l.id}`);
    if (!el || el.disabled || presetLeavesAlone(l, p) || el.checked === on.has(l.id)) continue;
    undo.push({ id: el.id, checked: el.checked });
    el.checked = on.has(l.id);
    el.dispatchEvent(new Event('change'));
    if (el.checked) moved.push(l.label);
  }
  // The raster context surface is one radio, not a row per surface: a preset naming none of
  // them means None, which is a move like any other. definePreset refuses a preset naming two.
  // A context overlay (fire, air quality) is a checkbox and was moved by the loop above.
  const surface = $(`qcm-context-${p.layers.find((id) => CONTEXT_SURFACE_IDS.includes(id)) || 'none'}`);
  if (surface && !surface.checked) {
    const prevSurface = document.querySelector('input[name="qcm-context"]:checked');
    if (prevSurface) undo.push({ id: prevSurface.id, checked: true });
    surface.checked = true; surface.dispatchEvent(new Event('change'));
    moved.push(...p.layers.filter((id) => CONTEXT_SURFACE_IDS.includes(id)).map((id) => LAYER_BY_ID[id].label));
  }
  const base = $(`qcm-base-${p.base}`);
  if (base && !base.checked) {
    const prevBase = document.querySelector('input[name="qcm-base"]:checked');
    if (prevBase) undo.push({ id: prevBase.id, checked: true });
    base.checked = true; base.dispatchEvent(new Event('change'));
  }
  state.applyingPreset = false;
  // `silent` is for the view-state wiring's initial-view apply (B1): a page load is
  // not a preset choice and must not read as one in the status region.
  if (!silent) {
    say(presetApplied(p, moved));
    if (undo.length) { state.dirty = true; state.lastPresetMove = undo; }
  }
  refreshPresetButtons();
}

/** Undo: puts back exactly what the last preset press moved, and only that -- the `undo`
 *  list applyPreset itself captured, since nothing else knows which elements it touched.
 *  One-shot, per the panel's own copy ("disabled again afterwards — a second Undo does
 *  not go further back"): cleared here whether or not anything above needed restoring, so
 *  a second press has nothing recorded and reads disabled rather than walking further
 *  back through history this file never kept. */
function undoPreset() {
  const undo = state.lastPresetMove;
  if (!undo) return;
  state.applyingPreset = true;
  for (const { id, checked } of undo) {
    const el = $(id);
    if (!el || el.checked === checked) continue;
    el.checked = checked;
    el.dispatchEvent(new Event('change'));
  }
  state.applyingPreset = false;
  state.lastPresetMove = null;
  say('Undo restored the switches the last preset moved.');
  refreshPresetButtons();
}

/** Reset: every switch, the base map and the context surface, plus the two display
 *  overrides a preset never touches (the highlight shortcut and a manual hillshade light),
 *  back to how the page opened. Never the drawn area, the print recipe or a saved pin --
 *  those are not this panel's to touch. Reuses the exact dispatch path every switch already
 *  moves through for the switches/base/context, and the same helpers the Highlight/
 *  Reset-light buttons already call for the two overrides, rather than a second way to
 *  clear either. */
function resetPreset() {
  state.applyingPreset = true;
  for (const l of LAYERS) {
    if (l.required) continue;
    const el = $(`qcm-layer-${l.id}`);
    // Reset is "how the page opened": a row that opens on (Road names, Named places) goes back on.
    const target = opensOn(l);
    if (!el || el.disabled || el.checked === target) continue;
    el.checked = target;
    el.dispatchEvent(new Event('change'));
  }
  const noneContext = $(`qcm-context-${DEFAULT_CONTEXT}`);
  if (noneContext && !noneContext.checked) { noneContext.checked = true; noneContext.dispatchEvent(new Event('change')); }
  const defaultBase = $(`qcm-base-${DEFAULT_BASE}`);
  if (defaultBase && !defaultBase.checked) { defaultBase.checked = true; defaultBase.dispatchEvent(new Event('change')); }
  refreshDisplay(DEFAULT_EMPHASIS);
  const az = $('qcm-hillshade-azimuth'), alt = $('qcm-hillshade-altitude');
  hillshadeLight = resetLight();
  if (az) az.value = DEFAULT_MANUAL.azimuth;
  if (alt) alt.value = DEFAULT_MANUAL.altitude;
  renderHillshade();
  state.applyingPreset = false;
  state.lastPresetMove = null;
  state.dirty = false;
  say('Reset returned every switch and display override to how the page opened.');
  refreshPresetButtons();
}

/** Undo and Reset are built by renderPresets(), not by the layout, so they are held here
 *  rather than looked up by id: page-controls.test.mjs holds every id main.js reaches for
 *  to an element the page markup already has, and these two exist only once JS has run. */
let presetUndoBtn = null;
let presetResetBtn = null;

/** The two action buttons' only source of truth: `state.dirty` (anything a preset/Undo/
 *  Reset can touch has moved since the page opened) and `state.lastPresetMove` (a preset
 *  press Undo can still put back). A no-op when the panel is not on this page's layout. */
function refreshPresetButtons() {
  if (presetUndoBtn) presetUndoBtn.disabled = !state.lastPresetMove;
  if (presetResetBtn) presetResetBtn.disabled = !state.dirty;
}

/** The initial view resolved by quiet-corners.js (B1) has no controls of its own for
 *  base/surface/overlays -- they live in THIS file's DOM, built above. Shaped into the
 *  one existing mechanism that moves them (applyPreset) rather than inventing a second. */
function viewToPresetShape(view) {
  // QQA-05r-2: a view (link or saved prefs) names the overlays it ADDS; a row that opens on
  // (Road names, Named places & landmarks -- layer-presets.js opensOn) is not one of them, so a
  // page load must not read "not listed" as "off" and untick it. A reader's own untick lasts for
  // the session, like every other switch here.
  const layers = [...new Set([...LAYERS.filter(opensOn).map((l) => l.id), ...(view.overlays || [])])];
  if (view.surface && view.surface !== 'none') layers.push(view.surface);
  return { id: 'initial-view', label: '', question: '', base: view.base, layers };
}

/** What each preset button's `.qcm-preset-preview` line says right now, read straight off
 *  the controls on screen -- the same read `layersFromControls()`/`currentBase()` give
 *  every other caller. Called from the one hook every switch's change event already runs
 *  through (`layerRow`), so a preview never goes stale a click behind what it names. */
function refreshPresetPreviews() {
  const currentSwitches = { ...layersFromControls(), base: currentBase() };
  for (const p of PRESETS) {
    const el = $(`qcm-preset-${p.id}-preview`);
    if (el) el.textContent = presetPreviewText(p, currentSwitches);
  }
}

/** The preset buttons, plus Undo and Reset. Buttons, not a select or
 *  radios, because none of them is a state the page stays in: pressing one moves the
 *  switches below and is then over. Each preset carries a `.qcm-preset-preview` paragraph
 *  naming what it would move, before it is pressed -- `aria-describedby` so a screen
 *  reader hears it as part of the button.
 *
 *  Undo and Reset go on the layer count line (`#qcm-preset-actions`), not into the
 *  4-column grid: with seven presets, nine buttons there needed a third row, past
 *  layout.test.mjs's 600px map-key-reach budget at 390px (a separate row for two more
 *  buttons had already measured 656px under U1). The grid falls back to holding them
 *  if the line is missing. Both start disabled -- there is nothing yet to undo or reset. */
function renderPresets() {
  const host = $('qcm-presets'); if (!host) return;
  const undoBtn = document.createElement('button');
  undoBtn.type = 'button'; undoBtn.id = 'qcm-preset-undo'; undoBtn.className = 'qcm-preset qcm-preset-action';
  undoBtn.textContent = 'Undo'; undoBtn.disabled = true;
  undoBtn.addEventListener('click', undoPreset);
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button'; resetBtn.id = 'qcm-preset-reset'; resetBtn.className = 'qcm-preset qcm-preset-action';
  resetBtn.textContent = 'Reset'; resetBtn.disabled = true;
  resetBtn.addEventListener('click', resetPreset);
  host.replaceChildren(...PRESETS.flatMap((p) => {
    const button = document.createElement('button');
    button.type = 'button'; button.id = `qcm-preset-${p.id}`; button.className = 'qcm-preset';
    button.textContent = p.label; button.title = p.question;
    const previewId = `qcm-preset-${p.id}-preview`;
    button.setAttribute('aria-describedby', previewId);
    button.addEventListener('click', () => applyPreset(p));
    const preview = document.createElement('p');
    preview.className = 'qcm-preset-preview'; preview.id = previewId;
    return [button, preview];
  }));
  ($('qcm-preset-actions') || host).replaceChildren(undoBtn, resetBtn);
  presetUndoBtn = undoBtn; presetResetBtn = resetBtn;
  refreshPresetPreviews();
}

/** The Layers panel, built from the registry so a new layer is one entry, not
 *  template surgery — and grouped, because an extra SHEET and an overlay are not
 *  the same kind of thing and a flat list said they were.
 *
 *  The states the drawn area covers decide which state land rows are offered;
 *  before an area is chosen they render disabled, saying so. */
function renderLayerControls() {
  const host = $('qcm-layers'); if (!host) return;
  const specs = layerControlSpecs(layersFromControls(), undefined, state.areaStates);
  // The base group is a choice of ONE, on screen: radios from source-basemaps, not the
  // print layer's checkbox, which is required and would render disabled -- and controlled
  // nothing the reader was looking at. Rebuilt on every area change, so it re-reads the
  // choice rather than resetting it.
  const base = currentBase();
  const baseSpecs = new Map(baseControlSpecs(base).map((s) => [s.id, s]));
  // The context group's raster surfaces are the base group's twin: radios and an explicit
  // None, so only one view-filling picture is ever laid over the map -- whichever heading each
  // radio sits under (QQA-18 homes them by task; the choice is still the one `qcm-context`
  // name). Its vector overlays are ordinary checkboxes, independent of that choice.
  const contextSpecs = new Map(contextControlSpecs(currentContext()).map((s) => [s.id, s]));
  const specById = new Map(specs.map((s) => [s.id, s]));
  const rowFor = (id) => {
    if (id === NO_CONTEXT_ROW_ID) return layerRow(contextSpecs.get('none'), setContext);
    if (baseSpecs.has(id)) return layerRow(baseSpecs.get(id), setBase);
    if (contextSpecs.has(id)) return layerRow(contextSpecs.get(id), setContext);
    const spec = specById.get(id);
    if (CONTEXT_OVERLAY_IDS.includes(id)) return layerRow(spec, setOverlay);
    const role = LAYER_BY_ID[id].group;
    return layerRow(spec, READING_RENDER[id] || CAMERA_RENDER[id] || SCREEN_RENDER[id] || NAMES_RENDER[id], role === 'federal' || role === 'state' ? { layer: LAYER_BY_ID[id] } : {});
  };
  host.replaceChildren(buildCameraEntry(), ...TASK_GROUPS.map((group) => {
    // QUX-04a: a <details>, not a bare <div> -- ten headings first, collapsed by default
    // (groupIsCollapsedByDefault, layer-panel.js), rather than a wall of switches under one
    // flat scroll. aria-label/role="group" stay on the element applyLayerFilter() finds by
    // `.qcm-layer-group[aria-label="..."]`.
    const box = document.createElement('details');
    box.className = 'qcm-layer-group';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', group.label);
    box.dataset.taskGroup = group.id;
    box.open = !groupIsCollapsedByDefault(group);
    const title = document.createElement('summary');
    title.className = 'qcm-group-title'; title.textContent = group.label;
    // A press on the heading while a filter is on is the reader's own call about this group.
    title.addEventListener('click', () => { if (layerFilterActive()) touchedWhileFiltering.add(group.id); });
    box.append(title);
    if (group.hint) {
      const hint = document.createElement('p');
      hint.className = 'qcm-hint'; hint.textContent = groupHint(group);
      box.append(hint);
    }
    box.append(...group.ids.map(rowFor));
    return box;
  }));
  renderCameraEntry();
  applyLayerFilter();
  renderActiveLayers();
}

/** UX-03b (audit A05/A07): Cameras was one collapsed group low in the list, and nothing said it
 *  covers only some regions rather than the country. This is the first thing under the search:
 *  the camera layers by name, a Go to for each that fits the map to its goTo box (its coverage
 *  box when none is set) and opens the Cameras switches below, and a status per layer
 *  (renderCameraEntry). Not a `.qcm-layer-group`
 *  and not a <details>: the groups all start closed, and this is the one block that does not. */
// Held by reference, not looked up by id: the entry is built here, not in the page markup, and
// page-controls.test.mjs requires every $('qcm-…') id to exist in the page.
let cameraEntry = null;

function buildCameraEntry() {
  const entry = document.createElement('div');
  entry.id = 'qcm-camera-entry'; entry.className = 'qcm-camera-entry';
  entry.setAttribute('role', 'group'); entry.setAttribute('aria-label', 'Cameras: where they work');
  const title = document.createElement('p');
  title.className = 'qcm-camera-entry-title';
  title.textContent = 'Cameras: only where a list covers';
  const list = document.createElement('ul');
  for (const id of ['roadCameras', 'parkCameras', 'linkCameras', 'phenoCameras', 'airportCameras']) {
    const spec = LAYER_BY_ID[id];
    const item = document.createElement('li');
    item.setAttribute('data-camera-region', id);
    const name = document.createElement('span');
    name.className = 'qcm-camera-region-name';
    name.textContent = `${{ roadCameras: 'Road cameras', parkCameras: 'NPS webcams', linkCameras: 'HPWREN, AlertWest, state roads', phenoCameras: 'PhenoCam research cameras', airportCameras: 'AviationWX airport cameras' }[id]}: ${spec.coverageName}`;
    // Five regions share a narrow column: Go to takes its own column so it never claims a line,
    // and the name and status stack beside it.
    const go = document.createElement('button');
    go.type = 'button'; go.className = 'qcm-camera-goto'; go.textContent = 'Go to';
    go.setAttribute('aria-label', `Go to ${spec.goToName || spec.coverageName} cameras`);
    go.addEventListener('click', () => goToCameraRegion(id));
    const status = document.createElement('span');
    status.className = 'qcm-camera-region-status'; status.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.className = 'qcm-camera-region-text';
    text.append(name, ' · ', status);
    item.append(text, go);
    list.append(item);
  }
  entry.append(title, list);
  cameraEntry = entry;
  return entry;
}

/** Go to a camera region: the map fits that region's coverage box, and the Cameras group opens so
 *  the switch is in reach. Turns nothing on: moving the map is not a request for pictures. */
function goToCameraRegion(layerId) {
  const spec = LAYER_BY_ID[layerId];
  if (map) map.fitBounds(toBounds(spec.goTo || spec.coverage), { padding: [20, 20] });
  const group = document.querySelector('.qcm-layer-group[aria-label="Cameras"]');
  if (group) {
    group.open = true;
    // The group sits below five headings in a short panel: bring it into view and put focus on
    // this region's switch so the next key press is the one that turns the layer on.
    group.scrollIntoView({ block: 'nearest' });
    $(`qcm-layer-${layerId}`)?.focus({ preventScroll: true });
  }
  say(`Moved the map to ${spec.goToName || spec.coverageName}. Switch the camera layer on under Cameras.`);
}

// Why a camera layer has no list, per row: `failed` is set when its list did not load and cleared
// when the row is switched off, so turning it off and on retries. "Loading" is a read in flight.
// Finished class names, written out whole so the stylesheet's reach check can find each one.
const CAMERA_PIN_CLASS = {
  roadCameras: 'qcm-camera-pin--road', parkCameras: 'qcm-camera-pin--park', linkCameras: 'qcm-camera-pin--link',
  phenoCameras: 'qcm-camera-pin--research', airportCameras: 'qcm-camera-pin--airport',
};
const CAMERA_LAYER_PROVIDER = { roadCameras: 'caltrans-cwwp2', parkCameras: 'nps-webcams', linkCameras: 'hpwren', phenoCameras: 'phenocam', airportCameras: 'aviationwx' }; // until the index names them
const cameraFailed = Object.fromEntries(CAMERA_LAYER_IDS.map((id) => [id, false]));

/** Loaded camera files of one layer, optionally only those whose bbox meets the view. */
const loadedCameraFiles = (layerId, view) => [...cameraFiles.values()]
  .filter((e) => e.row.layer === layerId && (!view || viewTouchesCoverage(view, e.row.bbox)));
const camerasOf = (entries) => entries.flatMap((e) => e.cameras);

/** Cameras the index counts in the files this view touches: what a zoomed-out report can say without
 *  having read a single file. 0 until the index has arrived. */
const cameraAreaCount = (layerId, view) => filesInView(cameraIndex ? cameraIndex.files : [], view, layerId)
  .reduce((n, f) => n + (Number.isFinite(f.count) ? f.count : 0), 0);

/** Writes each region's one-line status in the Cameras entry. Called on every move, switch and
 *  list arrival; cheap, and a no-op while the panel has no entry. */
function renderCameraEntry() {
  const host = cameraEntry; if (!host) return;
  const layers = layersFromControls();
  const view = map ? viewBbox() : null;
  for (const item of host.querySelectorAll('[data-camera-region]')) {
    const id = item.getAttribute('data-camera-region');
    const on = !!layers[id];
    const status = cameraStatus({
      on, error: cameraFailed[id], loading: on && !cameraFailed[id] && !!cameraLoading[id],
      touches: view ? viewTouchesLayer(view, LAYER_BY_ID[id]) : true,
      belowZoom: !!map && map.getZoom() < MIN_PIN_ZOOM,
      inView: view ? camerasInView(camerasOf(loadedCameraFiles(id, view)), view).length : 0,
      areaCount: view ? cameraAreaCount(id, view) : 0,
    });
    const el = item.querySelector('.qcm-camera-region-status');
    // Only on a change: a pan that leaves the status alone must not re-announce it.
    if (el && el.textContent !== status.text) {
      el.textContent = status.text; el.setAttribute('data-status', status.key);
    }
  }
}

/** The light-emissions surface, on or off, plus the one status its row can need. It is the
 *  only layer whose honest state depends on the ZOOM rather than on what a service
 *  answered: past level 8 Leaflet enlarges level 8, which looks exactly like detail. */
function renderNightLights() {
  if (!lights || !map) return;
  const layers = layersFromControls();
  const on = !!layers.nightLights;
  if (on && !map.hasLayer(lights)) lights.addTo(map);
  if (!on && map.hasLayer(lights)) map.removeLayer(lights);
  renderSurfaceCaption();
  const el = $('qcm-layer-nightLights-report');
  if (!el) return;
  const status = on ? zoomStatus(map.getZoom()) : null;
  el.textContent = status || '';
  el.hidden = !status;
}


/** The transportation-noise surface, on or off, plus its zoom ceiling status (level 12). */
function renderTransportNoise() {
  if (!noise || !map) return;
  const layers = layersFromControls();
  const on = !!layers.transportNoise;
  if (on && !map.hasLayer(noise)) noise.addTo(map);
  if (!on && map.hasLayer(noise)) map.removeLayer(noise);
  renderSurfaceCaption();
  const el = $('qcm-layer-transportNoise-report');
  if (!el) return;
  const status = on ? noiseZoomStatus(map.getZoom()) : null;
  el.textContent = status || '';
  el.hidden = !status;
}

/** Wildlife records, on or off. The same bounded shape as renderAqi -- a pan is a new
 *  question, debounced, with the answer about the view the reader left dropped -- and one
 *  difference: nothing is drawn inside the box. The row leads with the WINDOW and states the
 *  count as a ceiling, then credits every dataset the cell drew on by its own citation.
 *
 *  There is no SURFACE_TIME entry for this one, on purpose. A cell holds records from many
 *  days across the window, so there is no single moment to caption; the caption says the time
 *  is unknown rather than borrowing the wall clock, and the window is in the row below. */
async function renderWildlife() {
  if (!wildlife || !map) return;
  const layers = layersFromControls();
  const el = $('qcm-layer-gbifOccurrence-report');
  if (!layers.gbifOccurrence) {
    wildlifeReads.cancel();
    if (map.hasLayer(wildlife)) map.removeLayer(wildlife);
    wildlife.draw(null, null);
    if (el) { el.textContent = ''; el.hidden = true; }
    return;
  }
  const b = map.getBounds();
  const bbox = { minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth() };
  const win = dateWindow();
  await wildlifeReads.ask(bbox, win, (bodies) => {
    wildlife.draw(readAggregate(bodies.aggregate), bbox);
    if (!map.hasLayer(wildlife)) wildlife.addTo(map);
    if (!el) return;
    // The credit is part of the row, not a footnote: CC BY is an attribution licence, and a
    // count shown without the dataset that published it is the one use the licence forbids.
    el.textContent = [wildlifeAreaReport(bodies, win).text, ...creditLines(bodies.credits)].join(' ');
    el.hidden = false;
  });
}
/** Live radar, on or off, plus the one thing its row must always carry: how old the
 *  picture is. A frame whose age the service will not state is reported as unknown
 *  rather than drawn as current. */
async function renderRadar() {
  if (!radar || !map) return;
  const layers = layersFromControls();
  const on = !!layers.nwsRadar;
  if (!on) {
    if (map.hasLayer(radar)) map.removeLayer(radar);
    const off = $('qcm-layer-nwsRadar-report');
    if (off) { off.textContent = ''; off.hidden = true; }
    return;
  }
  radar.refresh(map);
  if (!map.hasLayer(radar)) radar.addTo(map);
  const el = $('qcm-layer-nwsRadar-report');
  if (!el) return;
  radarFrameMs = await fetchFrameTime({});
  if (!layersFromControls().nwsRadar) return;   // switched off while the frame time was in flight
  renderSurfaceCaption();   // the frame's own time is what the caption shows, not when we asked
  const vintage = frameVintage(radarFrameMs);
  el.textContent = vintage.text;
  el.hidden = false;
}

/** The view's bbox, in the lon/lat every bounded source here takes. */
function viewBbox() {
  const b = map.getBounds();
  return { minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth() };
}

/** The snapshot index, read once per page load and cached ONLY on success (a failure is never
 *  cached, so the next toggle-on retries). Concurrent callers share the one request. */
function loadCameraIndex() {
  if (cameraIndex) return Promise.resolve(cameraIndex);
  if (!cameraIndexPending) {
    cameraIndexPending = (async () => {
      const got = await fetchWithDeadline(`${CAMERA_DIR}index.json`, { init: { cache: 'no-cache' }, timeoutMs: DEFAULT_SOURCE_TIMEOUT_MS });
      if (!got.ok) throw new Error(got.httpStatus ? `The camera index returned ${got.httpStatus}.` : got.error);
      const body = got.body;
      if (!body || !Array.isArray(body.files)) throw new Error('The camera index is not in the expected shape.');
      cameraIndex = body;
      return body;
    })().finally(() => { cameraIndexPending = null; });
  }
  return cameraIndexPending;
}

/** One camera file, read once (cached by file, success only) and expanded into full records. */
function loadCameraFile(row) {
  const hit = cameraFiles.get(row.file);
  if (hit) return Promise.resolve(hit);
  if (!cameraFilePending.has(row.file)) {
    cameraFilePending.set(row.file, (async () => {
      const got = await fetchWithDeadline(`${CAMERA_DIR}${row.file}`, { init: { cache: 'no-cache' }, timeoutMs: DEFAULT_SOURCE_TIMEOUT_MS });
      if (!got.ok) throw new Error(got.httpStatus ? `${row.file} returned ${got.httpStatus}.` : got.error);
      const body = got.body;
      const entry = { row, cameras: expandSnapshot(body), generatedAt: body.generatedAt, group: null };
      cameraFiles.set(row.file, entry);
      return entry;
    })().finally(() => cameraFilePending.delete(row.file)));
  }
  return cameraFilePending.get(row.file);
}

/** The layer's pins, brought to what the view calls for: at most MAX_PINS of the loaded cameras inside
 *  the padded view (nearest its centre first), nothing below MIN_PIN_ZOOM or with the layer off. Each
 *  file keeps its own group and a ref -> marker map; markers are made with the group already on the
 *  map (identify() needs the marker's element). A pin whose card is open is never pulled out from
 *  under the reader, and `keepRef` names one more pin to hold (Show on a saved camera). */
function syncCameraPins(layerId, keepRef = null) {
  if (!map) return;
  const on = !!layersFromControls()[layerId];
  const entries = loadedCameraFiles(layerId);
  let want = new Set(), drawn = { pins: [], total: 0 };
  if (on && map.getZoom() >= MIN_PIN_ZOOM) {
    drawn = pinsToDraw(camerasOf(entries), padView(viewBbox()));
    want = new Set(drawn.pins.map(cameraRef));
  }
  if (on && keepRef) want.add(keepRef);
  cameraPinCap[layerId] = { shown: drawn.pins.length, total: drawn.total };
  const pinClass = CAMERA_PIN_CLASS[layerId];
  for (const e of entries) {
    e.pins ||= new Map();
    for (const [ref, pin] of e.pins) {
      if (want.has(ref) || (on && pin.isPopupOpen())) continue;
      e.group.removeLayer(pin); e.pins.delete(ref); cameraPins.delete(ref);
    }
    for (const c of e.cameras) {
      const ref = cameraRef(c);
      if (!want.has(ref) || e.pins.has(ref) || c.lat === null || c.lon === null) continue;
      if (!e.group) e.group = L.layerGroup().addTo(cameraLayer);
      const pin = L.marker([c.lat, c.lon], {
        icon: L.divIcon({ className: `qcm-camera-pin ${pinClass}` }),
        keyboard: true, title: c.name,
      }).addTo(e.group);
      // The link pin's fill is set here, not in quiet-corners-maps.css (a stylesheet this change does not own).
      wireCameraPin(pin, c, { generatedAt: e.generatedAt });
      e.pins.set(ref, pin); cameraPins.set(ref, pin);
    }
    if (e.group && e.pins.size === 0) { cameraLayer.removeLayer(e.group); e.group = null; }
  }
  // An open 3D panel stands the same pins on the relief.
  terrain3d?.refresh();
}

/** Brings one camera layer up to date with the switch and the view. `retry` is true for the switch
 *  itself (forgets earlier failures); a plain move never retries a failed read. Off: pins leave the
 *  map (their files stay cached). On: below MIN_PIN_ZOOM nothing is read; otherwise every file whose
 *  bbox meets the padded view is read once, drawn once, then the report recounts. */
async function refreshCameraLayer(layerId, retry = false) {
  if (!cameraLayer || !map) return;
  const layers = layersFromControls();
  const el = $(`qcm-layer-${layerId}-report`);
  if (!layers[layerId]) {
    // Pins go with the switch (their files stay cached) and are drawn fresh on the next switch-on:
    // a marker re-added to the map gets a new element, which identify() would not have wired.
    syncCameraPins(layerId);
    if (el) { el.textContent = ''; el.hidden = true; }
    cameraFailed[layerId] = false; renderCameraEntry();
    return;
  }
  if (retry) {
    cameraFailed[layerId] = false;
    for (const e of cameraIndex ? cameraIndex.files : []) if (e.layer === layerId) cameraFileFailed.delete(e.file);
  }
  syncCameraPins(layerId);
  // A failed INDEX is final until the switch is cycled; a failed district file is not, so a move into
  // another district still reads that district.
  if (cameraFailed[layerId] && !cameraIndex) { renderCameraReport(layerId); return; }
  const stillOn = () => !!layersFromControls()[layerId];
  cameraLoading[layerId] = (cameraLoading[layerId] || 0) + 1;
  try {
    if (!cameraIndex) renderCameraEntry();
    try { await loadCameraIndex(); } catch (err) {
      if (!stillOn()) return;
      cameraFailed[layerId] = true; return;
    }
    if (!stillOn()) return;
    if (map.getZoom() >= MIN_PIN_ZOOM) {
      const wanted = filesInView(cameraIndex.files, padView(viewBbox()), layerId)
        .filter((r) => !cameraFiles.has(r.file) && !cameraFileFailed.has(r.file));
      if (wanted.length) renderCameraEntry();
      const results = await Promise.allSettled(wanted.map(loadCameraFile));
      results.forEach((r, i) => { if (r.status === 'rejected') cameraFileFailed.add(wanted[i].file); });
      if (!stillOn()) return;
    }
    // "Unavailable" only when no file this view touches could be read; some read and some not is a
    // partial failure the report names, with the pins that did load kept.
    const here = filesInView(cameraIndex.files, padView(viewBbox()), layerId);
    cameraFailed[layerId] = here.some((r) => cameraFileFailed.has(r.file)) && !here.some((r) => cameraFiles.has(r.file));
    syncCameraPins(layerId);
  } finally {
    cameraLoading[layerId] -= 1;
    if (stillOn()) renderCameraReport(layerId);
  }
}

/** The camera row's report paragraph and the Cameras entry. Counts the pins in the current view
 *  among the loaded files; says to zoom in below MIN_PIN_ZOOM; with nothing in reach, how far the
 *  nearest area with cameras is. */
function renderCameraReport(layerId) {
  const el = $(`qcm-layer-${layerId}-report`);
  if (!el) { renderCameraEntry(); return; }
  if (!layersFromControls()[layerId]) { el.textContent = ''; el.hidden = true; renderCameraEntry(); return; }
  const rows = (cameraIndex ? cameraIndex.files : []).filter((f) => f.layer === layerId);
  const provider = rows.length ? rows[0].provider : CAMERA_LAYER_PROVIDER[layerId];
  if (cameraFailed[layerId]) {
    // Road cameras hold several operators: name one only when every list in reach is that
    // operator's, else the neutral wording (null), never Caltrans for a Kentucky failure.
    const failedProvider = failureProvider(rows, viewBbox(), layerId, layerId === 'roadCameras' ? null : provider);
    el.textContent = cameraLayerReport({ provider: failedProvider, error: 'did not load' });
    el.hidden = false; renderCameraEntry(); return;
  }
  const view = viewBbox();
  const loaded = loadedCameraFiles(layerId, view);
  const cameras = camerasOf(loaded);
  const outsideCoverage = !viewTouchesLayer(view, LAYER_BY_ID[layerId]);
  const reach = nearestCoverage(view, rows.map((f) => ({ id: f.region, name: f.regionName, bbox: f.bbox })));
  el.textContent = cameraLayerReport({
    provider, cameras, inView: camerasInView(cameras, view), error: null, outsideCoverage,
    belowZoom: map.getZoom() < MIN_PIN_ZOOM,
    nearest: reach.inView.length === 0 ? reach.nearest : null,
    areaCount: cameraAreaCount(layerId, view),
    capped: cameraPinCap[layerId] || null,
    failedAreas: rows.filter((f) => cameraFileFailed.has(f.file) && viewTouchesCoverage(padView(view), f.bbox)).length,
  });
  el.hidden = false;
  renderCameraEntry();
}

/** QUX-09c: a camera card's own actions -- Save camera and Before you go, no Copy/Share (a
 *  camera is not a place the share fragment can name). Only `{ ref, name, kind, lat, lon }` is
 *  ever handed to the store: the picture and stream addresses never reach storage. */
function cameraSaveState() {
  const saved = savedStore.read();
  const readOnly = saved.state === 'unreadable' || saved.state === 'newer' || saved.state === 'unavailable';
  return { saved, readOnly };
}

function cameraCardActions(camera) {
  const ref = cameraRef(camera);
  const located = camera.lat !== null && camera.lon !== null;
  const conditionsAvailable = typeof window.qcConditionsFor === 'function';
  const { saved, readOnly } = cameraSaveState();
  const isSaved = !readOnly && (saved.places || []).some((p) => p.ref === ref);
  return [
    {
      label: isSaved ? 'Saved — remove' : 'Save camera',
      disabled: readOnly,
      disabledReason: readOnly ? statusTextFor(saved) : undefined,
      onActivate: (btn) => {
        const nowSaved = btn.textContent === 'Saved — remove';
        if (nowSaved) {
          savedStore.remove(ref);
          btn.textContent = 'Save camera';
        } else {
          const result = savedStore.add({
            ref, name: camera.name, kind: 'camera', lat: camera.lat, lon: camera.lon, state: null, county: null,
          });
          if (!result.ok) return result.reason === 'already' ? 'Already saved.' : "Couldn't save that camera.";
          btn.textContent = 'Saved — remove';
        }
        savedPanel?.render();
        return nowSaved ? 'Removed from saved places.' : 'Saved.';
      },
    },
    {
      label: 'Before you go',
      disabled: !located || !conditionsAvailable,
      disabledReason: !located ? CAMERA_NO_LOCATION : conditionsAvailable ? undefined : 'Conditions are not available on this page.',
      onActivate: () => {
        conditionsBridge({ name: camera.name, kind: 'camera', lat: camera.lat, lon: camera.lon }, { ask: true });
        return 'Conditions shown below the map.';
      },
    },
  ];
}

/** Re-reads the store into an already-built camera card's Save button. */
function syncCameraSave(card, camera) {
  const btn = card.querySelector('.qcm-site-card-action');
  if (!btn) return;
  const { saved, readOnly } = cameraSaveState();
  const ref = cameraRef(camera);
  const isSaved = !readOnly && (saved.places || []).some((p) => p.ref === ref);
  btn.textContent = isSaved ? 'Saved — remove' : 'Save camera';
  btn.disabled = readOnly;
  if (readOnly) btn.title = statusTextFor(saved); else btn.removeAttribute('title');
}

/** An empty media slot for a camera's card: <figure> fills in on popupopen, <p> status carries
 *  the age (or the failure text), <p> links carries the still/about links -- see siteCard's
 *  optional `media` param (QUX-08D, preview-overlay.js). The status is a polite live region
 *  from the start, because its text changes after the card already has focus (spec-a11y-2,
 *  camera-card.test.mjs). */
function cameraMediaNode() {
  const media = document.createElement('div');
  media.className = 'qcm-camera-media';
  const figure = document.createElement('figure');
  const status = document.createElement('p');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const links = document.createElement('p');
  media.append(figure, status, links);
  return { media, figure, status, links };
}

/** Builds one camera's popup card and wires the still-loading lifecycle: popupopen fetches the
 *  still (Caltrans's `fetch` plan reads it as a blob, so Last-Modified is readable under ACAO `*`;
 *  NPS's `img` plan (08D-ii) instead points an `<img>` straight at the still -- `www.nps.gov`
 *  grants no ACAO, so there is no header to read and no age line, only a load/error state), and
 *  the `link`-only plan makes no request at all. popupclose aborts an in-flight Caltrans fetch,
 *  revokes its object URL, and removes any `<img>` (blob-backed or direct-src, either plan) so a
 *  reader who taps through several pins never leaks blobs or races a stale answer onto the wrong
 *  card (Leaflet's Map.openPopup() auto-closes the previous popup, firing this popupclose before
 *  the next popupopen -- the "one-player rule" is shared across both providers). */
function wireCameraPin(pin, camera, meta = {}) {
  const { media, figure, status, links } = cameraMediaNode();
  const row = cameraProviderRow(camera.provider);
  if (row.stillLinkText && camera.media && camera.media.still) {
    const stillLink = document.createElement('a');
    stillLink.href = camera.media.still; stillLink.rel = 'noopener noreferrer'; stillLink.target = '_blank';
    stillLink.textContent = row.stillLinkText;
    links.append(stillLink, document.createTextNode(' '));
  }
  const aboutLink = document.createElement('a');
  aboutLink.href = camera.officialUrl; aboutLink.rel = 'noopener noreferrer'; aboutLink.target = '_blank';
  aboutLink.textContent = cameraAboutLinkText(camera);
  links.append(aboutLink);
  const actions = cameraCardActions(camera);
  const card = siteCard(cameraCardLines(camera, meta), { media, actions });
  identify(pin, camera.name, card);
  // The card is built once per pin, so the Save button is re-read from the store on every open.
  pin.on('popupopen', () => syncCameraSave(card, camera));
  pin.on('popupopen', async () => {
    const plan = cameraStillPlan(camera);
    const failed = `The picture did not load. Use the link below to open it on ${row.operator}'s site.`;
    if (plan === 'img') {
      status.textContent = 'Loading picture (about 2 MB)…';
      const img = document.createElement('img');
      img.loading = 'eager';
      img.alt = `View from ${camera.name} (${row.altCredit})`;
      let timer = null;
      const settle = () => { clearTimeout(timer); if (cameraOpenTimer === timer) cameraOpenTimer = null; };
      const giveUp = () => {
        settle();
        status.textContent = failed;
        img.removeAttribute('src');
        img.remove();
      };
      img.addEventListener('load', () => { settle(); status.textContent = ''; }, { once: true });
      img.addEventListener('error', giveUp, { once: true });
      // An <img> whose server never answers fires neither event, so the card stops waiting itself.
      timer = cameraOpenTimer = setTimeout(giveUp, PICTURE_TIMEOUT_MS);
      img.src = camera.media.still;
      figure.append(img);
      return;
    }
    if (plan !== 'fetch') return;
    const ctrl = new AbortController();
    cameraOpenCtrl = ctrl;
    // A timeout aborts the same controller the card's close does; only the timeout reports. The
    // card's close aborts the fetch, so this card's finally always clears its own timer.
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, PICTURE_TIMEOUT_MS);
    try {
      // The still is read as a blob inside the card's own picture limit (the same 20 s as the timer above, not the 10 s a data source gets); Last-Modified rides along for the age line.
      const got = await fetchWithDeadline(camera.media.still, {
        init: { cache: 'no-cache' }, signal: ctrl.signal, timeoutMs: PICTURE_TIMEOUT_MS,
        read: async (res) => ({ lastModified: res.headers.get('Last-Modified'), blob: await res.blob() }),
      });
      if (ctrl.signal.aborted && !timedOut) return;   // closed by the reader; the picture limit still reports below
      if (!got.ok) throw new Error(got.httpStatus ? `${row.operator}'s server returned ${got.httpStatus}.` : got.error);
      const { lastModified, blob } = got.body;
      cameraOpenUrl = URL.createObjectURL(blob);
      const img = document.createElement('img');
      img.src = cameraOpenUrl;
      img.alt = `Picture from ${camera.name} (${row.altCredit})`;
      figure.append(img);
      status.textContent = cameraAgeText(lastModified, new Date(), camera.provider);
    } catch (err) {
      if (ctrl.signal.aborted && !timedOut) return;
      status.textContent = failed;
    } finally {
      clearTimeout(timer);
    }
  });
  pin.on('popupclose', () => {
    if (cameraOpenCtrl) { cameraOpenCtrl.abort(); cameraOpenCtrl = null; }
    clearTimeout(cameraOpenTimer); cameraOpenTimer = null;
    if (cameraOpenUrl) { URL.revokeObjectURL(cameraOpenUrl); cameraOpenUrl = null; }
    const img = figure.querySelector('img');
    if (img) img.remove();
    status.textContent = '';
  });
}

/** The on/off shape every BOUNDED vector surface shares: switched off it cancels the pending ask,
 *  leaves the map and clears its row; switched on it asks about the view the reader stopped on and
 *  writes the answer. Only `read`, `hold` and `report` differ, so they are the arguments. */
async function renderBounded(id, layer, reads, isOn, read, hold, report) {
  if (!layer || !map) return;
  const el = $(`qcm-layer-${id}-report`);
  if (!isOn()) {
    reads.cancel();
    if (map.hasLayer(layer)) map.removeLayer(layer);
    layer.draw([]);
    if (el) { el.textContent = ''; el.hidden = true; }
    return;
  }
  await reads.ask(viewBbox(), (got) => {
    const rows = read(got);
    hold(rows);                 // the surface's OWN time, for the caption
    renderSurfaceCaption();
    layer.draw(rows);
    if (!map.hasLayer(layer)) layer.addTo(map);
    if (!el) return;
    el.textContent = report(got);
    el.hidden = false;
  });
}

/** Smoke plumes. The one addition to the shape above is in the source: on an empty view the reader
 *  has also asked whether the day was analysed, so a blank map is never read as a clear sky. */
function renderSmoke() {
  return renderBounded('noaaHmsSmoke', smoke, smokeReads,
    () => { const layers = layersFromControls(); return !!layers.noaaHmsSmoke; },
    (got) => readPlumes(got && got.body),
    (rows) => { smokeObservedMs = smokeSummarise(rows).observedMs || null; },
    (got) => smokeAreaReport(got && got.body, got && got.latest).text);
}

/** Avalanche danger zones. No surface time is held: each zone has its own window, which the row
 *  lists, so the caption says the source stated no single time rather than borrowing one. */
function renderAvalanche() {
  return renderBounded('avalancheDanger', avalanche, avalancheReads,
    () => { const layers = layersFromControls(); return !!layers.avalancheDanger; },
    (got) => (got && got.status === 'ok' ? got.zones : []),
    () => {},
    (got) => avalancheReport(got).text);
}

/** Mapped wildfire perimeters. What differs is the row's headline: an AGE, not a time, because the
 *  median boundary measured three weeks old and a bare perimeter reads as a fire's edge now. */
function renderFire() {
  return renderBounded('nifcFirePerimeters', fire, fireReads,
    () => { const layers = layersFromControls(); return !!layers.nifcFirePerimeters; },
    (got) => readPerimeters(got),
    (rows) => { fireMappedMs = fireSummarise(rows).observedMs || null; },
    (got) => fireAreaReport(got).text);
}

/** The aurora outlook, on or off. Its row leads with the forecast TIME, because a
 *  number without its horizon is the misreading this source exists to prevent -- the
 *  mirror of the radar row, which leads with how old its picture is. */
async function renderAurora() {
  if (!aurora || !map) return;
  const layers = layersFromControls();
  const on = !!layers.swpcAurora;
  const el = $('qcm-layer-swpcAurora-report');
  if (!on) {
    if (map.hasLayer(aurora)) map.removeLayer(aurora);
    if (el) { el.textContent = ''; el.hidden = true; }
    return;
  }
  // Fetched only on the way in. A pan redraws what we already hold.
  if (!auroraBody) auroraBody = await fetchAurora({});
  // The answer may land after the reader switched the layer off (or picked another surface):
  // it is kept for the next time, but nothing is drawn for a row that is no longer on.
  if (!layersFromControls().swpcAurora) return;
  // The forecast time, never the observation time 66 minutes behind it and never the
  // moment we fetched: this surface's claim is 'forecast', so that is the time it owns.
  auroraForecastMs = readForecast(auroraBody).forecastMs ?? null;
  renderSurfaceCaption();
  const b = map.getBounds();
  const bbox = { minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth() };
  aurora.draw(auroraBody ? cellsInBbox(auroraBody, bbox) : []);
  if (!map.hasLayer(aurora)) aurora.addTo(map);
  if (!el) return;
  el.textContent = areaReport(auroraBody, bbox).text;
  el.hidden = false;
}


/** The regulatory floodplain, on or off. The same debounced bounded shape as the air quality
 *  above it and NOT the same question: four requests in a fixed order, the cheap two first, and
 *  the geometry asked for only when the count says a readable number of polygons is in view.
 *  Above that ceiling the row says zoom in, which is the honest answer rather than fifteen pages
 *  of shapes nobody can tell apart -- and the layer draws nothing rather than half a picture. */
async function renderFlood() {
  if (!flood || !map) return;
  const layers = layersFromControls();
  const el = $('qcm-layer-femaNfhl-report');
  if (!layers.femaNfhl) {
    floodReads.cancel();
    if (map.hasLayer(flood)) map.removeLayer(flood);
    flood.draw([]);
    if (el) { el.textContent = ''; el.hidden = true; }
    return;
  }
  const b = map.getBounds();
  const bbox = { minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth() };
  await floodReads.ask(bbox, (got) => {
    const report = floodAreaReport(got);
    // Only a drawable answer puts ink down. A failure, an unmapped area and a view over the
    // ceiling all clear the map: leaving the last view's polygons up would put a floodplain
    // over ground this answer says nothing about.
    flood.draw(report.drawable ? readFloodZones(got.zones) : []);
    if (report.drawable && !map.hasLayer(flood)) flood.addTo(map);
    if (!report.drawable && map.hasLayer(flood)) map.removeLayer(flood);
    if (!el) return;
    el.textContent = report.text;
    el.hidden = false;
  });
}
/** Air quality, on or off. The mirror of renderAurora and deliberately NOT its shape:
 *  aurora holds one global file and a pan re-indexes it, while this is a bounded query, so
 *  the new view is a new question. It is asked through aqiReads, which waits out a drag and
 *  drops the answer about the view the reader left. The row leads with the HOUR: this
 *  surface ran 144 minutes behind the wall clock when it was measured. */
async function renderAqi() {
  if (!aqi || !map) return;
  const layers = layersFromControls();
  const on = !!layers.epaAirNowAqi;
  const el = $('qcm-layer-epaAirNowAqi-report');
  if (!on) {
    aqiReads.cancel();
    if (map.hasLayer(aqi)) map.removeLayer(aqi);
    aqi.draw([], null);
    if (el) { el.textContent = ''; el.hidden = true; }
    return;
  }
  const b = map.getBounds();
  const bbox = { minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth() };
  await aqiReads.ask(bbox, (got) => {
    const rows = readAqiFeatures(got);
    aqiObservedMs = aqiSummarise(rows).observedMs ?? null;
    renderSurfaceCaption();
    aqi.draw(rows, bbox);
    if (!map.hasLayer(aqi)) aqi.addTo(map);
    if (!el) return;
    el.textContent = aqiAreaReport(got).text;
    el.hidden = false;
  });
}

/** Stream gauges, on or off. A bounded question like renderAqi: a pan asks again, a drag does
 *  not, and the answer about a view the reader left is dropped. A view over the area cap asks
 *  nothing, and a failed request is a stated line -- the markers are cleared either way so the
 *  last view's gauges never sit on ground this answer says nothing about. */
async function renderGauges() {
  if (!gauges || !map) return;
  const layers = layersFromControls();
  const on = !!layers.streamGauges;
  const el = $('qcm-layer-streamGauges-report');
  if (!on) {
    gaugeReads.cancel();
    if (map.hasLayer(gauges)) map.removeLayer(gauges);
    gauges.draw([], null);
    if (el) { el.textContent = ''; el.hidden = true; }
    return;
  }
  const b = map.getBounds();
  const bbox = { minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth() };
  await gaugeReads.ask(bbox, (got) => {
    const sites = got && got.status !== 'unavailable' ? got.sites : [];
    const times = sites.flatMap((s) => s.readings.map((r) => r.timeMs));
    gaugesNewestMs = times.length ? Math.max(...times) : null;
    renderSurfaceCaption();
    gauges.draw(sites, got && got.fetchedMs);
    if (!map.hasLayer(gauges)) gauges.addTo(map);
    if (!el) return;
    el.textContent = gaugeAreaReport(got).text;
    el.hidden = false;
  });
}

/** One BTS rail/airport row, on or off. A bounded question like renderGauges: a pan asks again, a
 *  drag does not, the answer about a view the reader left is dropped, a view over the area cap asks
 *  nothing, and the markers are cleared either way so the last view's lines never sit on ground
 *  this answer says nothing about. The row's own report line is where the answer is worded. */
async function renderNtad(on, group, reads, draw, reportOf, reportId) {
  if (!group || !map) return;
  const el = $(reportId);
  if (!on) {
    reads.cancel();
    if (map.hasLayer(group)) map.removeLayer(group);
    draw([]);
    if (el) { el.textContent = ''; el.hidden = true; }
    return;
  }
  const b = map.getBounds();
  const bbox = { minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth() };
  await reads.ask(bbox, (got) => {
    draw(got);
    if (!map.hasLayer(group)) group.addTo(map);
    if (el) { el.textContent = reportOf(got).text; el.hidden = false; }
  });
}
function renderRail() {
  const layers = layersFromControls();
  return renderNtad(!!layers.railClass1, railLines, railReads,
    (got) => railLines.draw(Array.isArray(got) ? got : (got && got.lines) || []), railReport, 'qcm-layer-railClass1-report');
}
function renderHistoric() {
  const layers = layersFromControls();
  return renderNtad(!!layers.historicPlaces, historicPoints, historicReads,
    (got) => historicPoints.draw((got && got.places) || []), nrhpReport, 'qcm-layer-historicPlaces-report');
}
async function renderSnotel() {
  if (!snotelPoints || !map) return;
  const layers = layersFromControls();
  const on = !!layers.snotelSnowpack;
  if (on && !snotelCatalogue) {
    const got = await loadSnotelCatalogue();
    if (!layersFromControls().snotelSnowpack) return;
    if (got.status !== 'ready') {
      snotelPoints.draw([]);
      const el = $('qcm-layer-snotelSnowpack-report');
      if (el) { el.textContent = snotelReport({ status: 'catalogue-unavailable' }).text; el.hidden = false; }
      return;
    }
    snotelCatalogue = got.stations;
  }
  return renderNtad(on, snotelPoints, snotelReads,
    (got) => snotelPoints.draw((got && got.sites) || [], got && got.fetchedMs), snotelReport, 'qcm-layer-snotelSnowpack-report');
}
function renderAirports() {
  const layers = layersFromControls();
  return renderNtad(!!layers.airports, airportPoints, airportReads,
    (got) => airportPoints.draw(Array.isArray(got) ? got : (got && got.airports) || []), airportReport, 'qcm-layer-airports-report');
}

/** Weather stations, on or off. Like renderGauges, with the station list read once from this
 *  site first. A list that will not load is a stated line and is retried on the next turn-on. */
async function renderStations() {
  if (!stations || !map) return;
  const layers = layersFromControls();
  const on = !!layers.nwsObservations;
  const el = $('qcm-layer-nwsObservations-report');
  const say = (text) => { if (el) { el.textContent = text; el.hidden = false; } };
  if (!on) {
    stationReads.cancel();
    if (map.hasLayer(stations)) map.removeLayer(stations);
    stations.draw([], null);
    if (el) { el.textContent = ''; el.hidden = true; }
    return;
  }
  if (!stationCatalogue) {
    const got = await loadStationCatalogue();
    if (!layersFromControls().nwsObservations) return;
    if (got.status !== 'ready') {
      stations.draw([], null);
      stationsNewestMs = null;
      renderSurfaceCaption();
      say(stationAreaReport({ status: 'catalogue-unavailable' }).text);
      return;
    }
    stationCatalogue = got.stations;
  }
  const b = map.getBounds();
  const bbox = { minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth() };
  await stationReads.ask(bbox, stationCatalogue, (got) => {
    const sites = got && got.status === 'ready' ? got.sites : [];
    stationsNewestMs = sites.length ? Math.max(...sites.map((s) => s.timeMs)) : null;
    renderSurfaceCaption();
    stations.draw(sites, got && got.fetchedMs);
    if (!map.hasLayer(stations)) stations.addTo(map);
    say(stationAreaReport(got).text);
  });
}

/** One NLCD surface, on or off. The same per-view export shape as the terrain above, with
 *  one difference that matters: the answer the ROW carries is about COVERAGE, and the
 *  picture cannot supply it — Paris and the Gulf of Mexico return byte-identical PNGs. So
 *  the row says whether the service reaches this view at all, from the service's own
 *  published extent, and a view outside it draws nothing and spends no request. */
async function renderSurfaceExport(layer, layerId, product, on) {
  if (!layer || !map) return;
  const el = $(`qcm-layer-${layerId}-report`);
  if (!on) {
    layer.cancel();
    if (map.hasLayer(layer)) map.removeLayer(layer);
    if (el) { el.textContent = ''; el.hidden = true; }
    return;
  }
  renderSurfaceCaption();
  await layer.refresh(map, (got) => {
    if (got && got.drawn) { if (!map.hasLayer(layer)) layer.addTo(map); }
    else if (map.hasLayer(layer)) map.removeLayer(layer);
    if (!el) return;
    el.textContent = got ? landCoverText(product, got.coverage, got.drawn)
      : landCoverText(product, 'unproven', false);
    el.hidden = false;
  });
}

// Declarations, not arrow consts: CONTEXT_RENDER names both of these above, and a const
// there is still in its temporal dead zone when the module body runs. Each reads its own
// switch BY NAME rather than through the shared helper's parameter, because
// layers-reach-paper.test.mjs proves a registered layer is acted on by finding that name
// here -- and a control nothing reads is the defect it exists to catch.
async function renderLandCover() {
  const layers = layersFromControls();
  return renderSurfaceExport(landCover, 'nlcdLandCover', 'landCover', layers.nlcdLandCover);
}
async function renderTreeCanopy() {
  const layers = layersFromControls();
  return renderSurfaceExport(treeCanopy, 'nlcdTreeCanopy', 'canopy', layers.nlcdTreeCanopy);
}

/** The shape of the ground, on or off. The same per-view export shape as the radar, with
 *  one difference that matters: the answer is read rather than displayed, so the row can
 *  say whether the elevation model reached this view at all. A view it does not reach
 *  draws nothing, and the row says that is missing coverage rather than flat land. */
async function renderTerrain() {
  if (!terrain || !map) return;
  const layers = layersFromControls();
  const el = $('qcm-layer-terrainSlope-report');
  if (!layers.terrainSlope) {
    terrain.cancel();
    if (map.hasLayer(terrain)) map.removeLayer(terrain);
    if (el) { el.textContent = ''; el.hidden = true; }
    return;
  }
  renderSurfaceCaption();
  await terrain.refresh(map, (counts) => {
    if (!map.hasLayer(terrain)) terrain.addTo(map);
    if (!el) return;
    el.textContent = counts ? terrainCoverageText(counts)
      : 'The terrain service did not answer for this view, so nothing is drawn.';
    el.hidden = false;
  });
}

/** Applies a new emphasis state everywhere it is drawn: the overlay shapes, the summary
 *  line, the legend swatches, and the `window.qcDisplay` hook other units (B1/U0) read
 *  the state back through. The one place currentDisplay is ever reassigned. */
function refreshDisplay(next) {
  currentDisplay = next;
  if (overlay) renderOverlay();
  renderLegend();
  const summary = $('qcm-display-summary');
  if (summary) summary.textContent = summaryLine(currentDisplay);
  const dimIn = $('qcm-emphasis-dim'), dimOut = $('qcm-emphasis-dim-value');
  if (dimIn) dimIn.value = currentDisplay.dim;
  if (dimOut) { dimOut.textContent = `${Math.round(currentDisplay.dim * 100)}%`; dimIn?.setAttribute('aria-valuetext', dimOut.textContent + ' dimmed'); }
  const linesIn = $('qcm-emphasis-lines'), linesOut = $('qcm-emphasis-lines-value');
  if (linesIn) linesIn.value = currentDisplay.lines;
  if (linesOut) { linesOut.textContent = `${currentDisplay.lines}×`; linesIn?.setAttribute('aria-valuetext', linesOut.textContent); }
  const fillIn = $('qcm-emphasis-fill'), fillOut = $('qcm-emphasis-fill-value');
  if (fillIn) fillIn.value = currentDisplay.fill;
  if (fillOut) { fillOut.textContent = `${Math.round(currentDisplay.fill * 100)}%`; fillIn?.setAttribute('aria-valuetext', fillOut.textContent); }
  const spotSel = $('qcm-emphasis-spotlight');
  if (spotSel) spotSel.value = currentDisplay.spotlight || '';
  for (const id of ['qcm-highlight-trails', 'qcm-highlight-boundaries']) {
    const btn = $(id);
    if (btn) btn.setAttribute('aria-pressed', String(currentDisplay.spotlight === (id.endsWith('trails') ? 'trails' : 'federalLand')));
  }
}

/** Highlight shortcuts + the Advanced controls, all funnelled through nextDisplay() so
 *  hover/highlight/clear can never compound (display-controls.js). Also fills the
 *  spotlight <select> from the registry once, since it never changes at runtime. */
function wireHighlightControls() {
  const trailsBtn = $('qcm-highlight-trails'), boundariesBtn = $('qcm-highlight-boundaries'), clearBtn = $('qcm-highlight-clear');
  if (trailsBtn) trailsBtn.addEventListener('click', () => refreshDisplay(nextDisplay(currentDisplay, { type: 'highlight', layerId: 'trails' })));
  if (boundariesBtn) boundariesBtn.addEventListener('click', () => refreshDisplay(nextDisplay(currentDisplay, { type: 'highlight', layerId: 'federalLand' })));
  if (clearBtn) clearBtn.addEventListener('click', () => refreshDisplay(nextDisplay(currentDisplay, { type: 'clear' })));
  const dim = $('qcm-emphasis-dim'), lines = $('qcm-emphasis-lines'), fill = $('qcm-emphasis-fill'), spotlight = $('qcm-emphasis-spotlight');
  if (dim) dim.addEventListener('input', () => refreshDisplay(nextDisplay(currentDisplay, { type: 'setDim', value: Number(dim.value) })));
  if (lines) lines.addEventListener('input', () => refreshDisplay(nextDisplay(currentDisplay, { type: 'setLines', value: Number(lines.value) })));
  if (fill) fill.addEventListener('input', () => refreshDisplay(nextDisplay(currentDisplay, { type: 'setFill', value: Number(fill.value) })));
  if (spotlight) {
    spotlight.append(...LAYERS.filter((l) => !l.rasterSurface).map((l) => new Option(l.label, l.id)));
    spotlight.addEventListener('change', () => refreshDisplay(nextDisplay(currentDisplay, { type: 'setSpotlight', layerId: spotlight.value || null })));
  }
  // The one hook another unit's Share/Reset-view wiring reads the emphasis state
  // through -- this module owns the only write to currentDisplay.
  window.qcDisplay = {
    getDisplayState: () => currentDisplay,
    setDisplayState: (state) => refreshDisplay({ ...DEFAULT_EMPHASIS, ...state }),
  };
}

/** Which mode/azimuth/altitude to actually request for the current light state.
 *  "sun" above the horizon behaves exactly like "manual" at that azimuth/altitude
 *  (ruleForLightState's own rule); below the horizon or at rest, the fixed rule. */
function hillshadeModeArgs(state) {
  if (state.mode === 'manual' || (state.mode === 'sun' && !state.belowHorizon)) {
    return { mode: 'manual', azimuth: state.azimuth, altitude: state.altitude };
  }
  return { mode: 'fixed' };
}

/** A qualified, adjustable rendered relief picture (D2), wired the same way terrain is:
 *  an ImageOverlay this module refreshes on pan/zoom/light-change. Unlike terrain's
 *  canvas decode, a hillshade PNG is directly displayable, so this just hands the
 *  fetched blob straight to the overlay as an object URL. */
function hillshadeContextLayer(mapL) {
  const layer = mapL.imageOverlay('', [[0, 0], [0, 0]], { opacity: 0.6, interactive: false, alt: '' });
  const picture = createUrlSlot();
  layer.refresh = async function refresh(mapRef, lightState) {
    const b = mapRef.getBounds();
    const size = mapRef.getSize();
    const { mode, azimuth, altitude } = hillshadeModeArgs(lightState);
    const request = hillshadeRequestFor({
      bboxLonLat: { minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth() },
      width: size.x, height: size.y, mode, azimuth, altitude,
    });
    const ticket = picture.ticket();
    const result = await hillshadeFetcher.fetchImage(request);
    if (result.status === 'ready') {
      // Switched off while the fetch was in flight: release() outdated the ticket, so no url is made.
      const objectUrl = picture.set(result.blob, ticket);
      if (objectUrl === null) return { status: 'stale' };
      layer.setBounds(b);
      layer.setUrl(objectUrl);
    }
    return result;
  };
  // Off the map, nothing shows the last picture, so its bytes go back with it.
  layer.release = () => picture.release();
  return layer;
}

/** Contour lines (E2): a transparent PNG from the same 3DEP service, handed straight to an
 *  ImageOverlay as an object URL, the hillshade's shape without its light state. */
function contoursContextLayer(mapL) {
  const layer = mapL.imageOverlay('', [[0, 0], [0, 0]], { opacity: 0.8, interactive: false, alt: '' });
  let objectUrl = null;
  layer.refresh = async function refresh(mapRef) {
    const b = mapRef.getBounds();
    const size = mapRef.getSize();
    const request = contoursRequestFor({
      bboxLonLat: { minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth() },
      width: size.x, height: size.y,
    });
    const result = await contoursFetcher.fetchImage(request);
    if (result.status === 'ready') {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(result.blob);
      layer.setBounds(b);
      layer.setUrl(objectUrl);
    }
    return result;
  };
  return layer;
}

/** The contour row's render function, named for CONTEXT_RENDER. Off removes the overlay and
 *  asks nothing; on, a failed or timed-out request says so and draws nothing. */
async function renderContours() {
  if (!contours || !map) return;
  const layers = layersFromControls();
  const el = $('qcm-layer-terrainContours-report');
  if (!layers.terrainContours) {
    if (map.hasLayer(contours)) map.removeLayer(contours);
    if (el) { el.textContent = ''; el.hidden = true; }
    return;
  }
  renderSurfaceCaption();
  const result = await contours.refresh(map);
  if (!map) return;
  if (result.status === 'ready') {
    if (!map.hasLayer(contours)) contours.addTo(map);
  } else if (result.status !== 'stale' && map.hasLayer(contours)) {
    map.removeLayer(contours);
  }
  if (!el) return;
  el.textContent = result.status === 'ready' || result.status === 'stale'
    ? ''
    : `The contour service did not answer for this view (${result.status}), so nothing is drawn.`;
  el.hidden = !el.textContent;
}

/** Modelled snow depth: a transparent PNG from NOHRSC's MapServer, handed to an ImageOverlay as an
 *  object URL, the contours' shape with a different request. */
function snowDepthContextLayer(mapL) {
  const layer = mapL.imageOverlay('', [[0, 0], [0, 0]], { opacity: 0.7, interactive: false, alt: '' });
  let objectUrl = null;
  layer.refresh = async function refresh(mapRef) {
    const b = mapRef.getBounds();
    const size = mapRef.getSize();
    const request = snowDepthRequestFor({
      bboxLonLat: { minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth() },
      width: size.x, height: size.y,
    });
    const result = await snowDepthFetcher.fetchImage(request);
    if (result.status === 'ready') {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(result.blob);
      layer.setBounds(b);
      layer.setUrl(objectUrl);
    }
    return result;
  };
  return layer;
}

/** The snow depth row's render function, named for CONTEXT_RENDER. Off removes the overlay and asks
 *  nothing; on, the report line carries the service's own key (no unit is claimed) or says the
 *  service did not answer and nothing is drawn. */
async function renderSnowDepth() {
  if (!snowDepth || !map) return;
  const layers = layersFromControls();
  const el = $('qcm-layer-snowDepthModel-report');
  if (!layers.snowDepthModel) {
    if (map.hasLayer(snowDepth)) map.removeLayer(snowDepth);
    if (el) { el.textContent = ''; el.hidden = true; }
    return;
  }
  renderSurfaceCaption();
  const result = await snowDepth.refresh(map);
  if (!map) return;
  if (result.status === 'ready') {
    if (!map.hasLayer(snowDepth)) snowDepth.addTo(map);
  } else if (result.status !== 'stale' && map.hasLayer(snowDepth)) {
    map.removeLayer(snowDepth);
  }
  if (!el) return;
  el.textContent = result.status === 'ready' || result.status === 'stale'
    ? snowDepthLegend()
    : `The snow depth service did not answer for this view (${result.status}), so nothing is drawn.`;
  el.hidden = !el.textContent;
}

/** The hillshade context row's render function -- named, and referenced by name in
 *  CONTEXT_RENDER below, the same static shape layers-reach-paper.test.mjs checks every
 *  other context surface against. Honest light/time controls: the report line always
 *  states which light produced the picture (lightStateText), never a fetch time it did
 *  not ask for. */
async function renderHillshade() {
  if (!hillshade || !map) return;
  const layers = layersFromControls();
  const el = $('qcm-layer-hillshadeLight-report');
  if (!layers.hillshadeLight) {
    if (map.hasLayer(hillshade)) map.removeLayer(hillshade);
    hillshade.release();
    if (el) { el.textContent = ''; el.hidden = true; }
    return;
  }
  renderSurfaceCaption();
  const result = await hillshade.refresh(map, hillshadeLight);
  // Switched off while the picture was loading: the off branch above already cleared the row.
  if (!map || !layersFromControls().hillshadeLight) return;
  if (result.status === 'ready') {
    if (!map.hasLayer(hillshade)) hillshade.addTo(map);
  } else if (result.status !== 'stale') {
    if (map.hasLayer(hillshade)) map.removeLayer(hillshade);
    hillshade.release();
  }
  if (!el) return;
  el.textContent = result.status === 'ready' || result.status === 'stale'
    ? lightStateText(hillshadeLight)
    : `The hillshade service did not answer for this view (${result.status}), so nothing is drawn.`;
  el.hidden = false;
}

/** Wires the light-control row (manual azimuth/altitude, Sun now, Reset light) if the
 *  dashboard template rendered it. Any control missing is a no-op -- it is not part of
 *  every host page's markup. */
function wireHillshadeLightControls() {
  const az = $('qcm-hillshade-azimuth'), alt = $('qcm-hillshade-altitude');
  const sunBtn = $('qcm-hillshade-sun-now'), resetBtn = $('qcm-hillshade-reset-light');
  const applyManual = () => {
    if (!az || !alt) return;
    hillshadeLight = setManualLight(hillshadeLight, Number(az.value), Number(alt.value));
    renderHillshade();
  };
  if (az) az.addEventListener('change', applyManual);
  if (alt) alt.addEventListener('change', applyManual);
  if (sunBtn) sunBtn.addEventListener('click', () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      hillshadeLight = setSunNow(hillshadeLight, { lat: pos.coords.latitude, lon: pos.coords.longitude, date: new Date() });
      renderHillshade();
    });
  });
  if (resetBtn) resetBtn.addEventListener('click', () => {
    hillshadeLight = resetLight();
    if (az) az.value = DEFAULT_MANUAL.azimuth;
    if (alt) alt.value = DEFAULT_MANUAL.altitude;
    renderHillshade();
  });
}

/** The two READING rows: a sentence about the area the reader drew, not ink on the map.
 *  They redraw on their own switch and on a new area, and they are the only rows in the
 *  panel whose answer is in words — which is why they are a table of their own rather than
 *  a branch inside renderLayerReports, whose subject is what a FETCHED layer returned. */
const READING_RENDER = { padusAccess: renderPadusAccess, epaEcoregions: renderEcoregions };

/** QUX-08D: the camera row's own onChange table, kept separate from READING_RENDER above --
 *  cameras are neither a printable-vector layer (renderLayerReports) nor a reading over a
 *  drawn area; toggling the checkbox fetches (or shows/hides) pins. */
// QUX-09c: the latest render promise per row, so Show on a saved camera can await the render the
// checkbox's own `change` started instead of starting (and fetching) a second one.
const cameraRenders = {};
const CAMERA_RENDER = Object.fromEntries(CAMERA_LAYER_IDS.map((id) => [id,
  () => (cameraRenders[id] = refreshCameraLayer(id, true))]));

/** QQA-05r-2: a screen-only row in the federal group (Road names) draws labels on the map and
 *  puts nothing on a printed sheet, so toggling it neither invalidates the recipe nor re-plans:
 *  it only asks the map to draw (or clear) its labels. */
const SCREEN_RENDER = { roads: () => { renderRoads(); renderLegend(); }, railClass1: () => { renderRail(); renderLegend(); }, airports: () => { renderAirports(); renderLegend(); },
  historicPlaces: () => { renderHistoric(); renderLegend(); },
  snotelSnowpack: () => { renderSnotel(); renderLegend(); } };
/** The names row is a printable layer AND a per-view pass: the default invalidate + replan, then
 *  ask for the view (or clear, when it went off). */
const NAMES_RENDER = { names: (event) => { invalidate({ layers: { names: event.target.checked } }); replan(); renderNamesPass(); } };

/** Somewhere to hide a reading row, and the guard both renderers share: no area drawn yet
 *  means there is nothing to answer about, which is not the same as an empty answer. */
function readingRow(rowId, on) {
  const el = $(rowId);
  if (el && (!on || !state.bbox)) { el.textContent = ''; el.hidden = true; }
  return on && state.bbox ? el : null;
}

/** Public access, for the area drawn. `res.ok` is never consulted: this service answers a
 *  bad request HTTP 200 with an error object and no `features` key, so accessReport reads
 *  the BODY and tells a failure from an empty answer. */
async function renderPadusAccess() {
  const layers = layersFromControls();
  const el = readingRow('qcm-layer-padusAccess-report', !!layers.padusAccess);
  if (!el) return;
  const b = state.bbox;
  const body = await fetchAccess({ minLon: b.minLon, minLat: b.minLat, maxLon: b.maxLon, maxLat: b.maxLat });
  if (!layersFromControls().padusAccess || state.bbox !== b) return;   // the area moved under the answer
  el.textContent = accessReport(body, new Date().toISOString().slice(0, 10)).text;
  el.hidden = false;
}

/** What kind of country this is, from the committed export. Fetched once and held: the file
 *  is the whole conterminous states, so the second question costs nothing. */
async function renderEcoregions() {
  const layers = layersFromControls();
  const el = readingRow('qcm-layer-epaEcoregions-report', !!layers.epaEcoregions);
  if (!el) return;
  if (!ecoregions) {
    // Two quick toggles share the one request instead of starting a second 950 KB read.
    ecoregionsPending ??= loadEcoregions({}).finally(() => { ecoregionsPending = null; });
    ecoregions = await ecoregionsPending;
  }
  if (!layersFromControls().epaEcoregions || !state.bbox) return;
  const b = state.bbox;
  const at = { lat: (b.minLat + b.maxLat) / 2, lon: (b.minLon + b.maxLon) / 2 };
  el.textContent = ecoregions
    ? ecoregionReport(ecoregions, at).text
    : 'The landscape description this site serves could not be loaded, so nothing is known here yet. Try again.';
  el.hidden = false;
}

/** What each layer actually answered, under its own control.
 *
 *  layerReport is the only thing that can tell "the service answered and this area
 *  has none" from "there is no coverage here" — the whole point of the registry's
 *  emptyMeans. It was written, tested, and never rendered: the page showed one
 *  summary line for every layer at once. */
function renderLayerReports() {
  for (const l of LAYERS) {
    const el = $(`qcm-layer-${l.id}-report`);
    if (!el || l.screenOnly) continue;   // renderNightLights / renderRadar own those rows; this would hide them
    const on = state.recipe ? state.recipe.layers[l.id] : false;
    const s = state.states[l.id];
    if (!on && !l.required) { el.hidden = true; continue; }
    if (!s || s === 'unchecked') { el.hidden = true; continue; }
    const report = layerReport({ layerId: l.id, state: s, featureCount: state.counts[l.id] ?? null });
    // A source that can say MORE than the registry's emptyMeans gets to. Wetlands tells
    // "mapped, none here" from "never mapped" from "off the service entirely", and a
    // three-way emptyMeans cannot carry that; its adapter writes the sentence and this
    // row prints it. Every other layer keeps the generic one.
    el.textContent = state.reports[l.id] ? `${l.label}: ${state.reports[l.id]}` : report.text;
    el.dataset.state = report.state;
    el.hidden = false;
  }
}

function replan() {
  sheets.clearLayers(); state.plan = null;
  if (!state.bbox) {
    state.recipe = null;
    for (const f of ['pages', 'ground', 'download']) $('qcm-estimate').querySelector(`dd[data-field="${f}"]`).textContent = '—';
    $('qcm-check').disabled = true;
    renderSources();
    return;
  }
  try {
    const recipe = recipeFromControls(controls(), state.bbox, $('qcm-title').value.trim() || 'Field maps', state.area?.kind === 'quads' ? state.area.ids : null);
    const { level, tiles } = tilePlan(planForRecipe(recipe).plan);
    const { plan, estimate, summary } = planForRecipe(recipe, { uniqueTiles: tiles.count });
    state.recipe = recipe; state.plan = plan;
    for (const s of plan.sheets) L.polygon(ring(s.extent, recipe.zone, recipe.hemisphere).map((p) => [p.minLat, p.minLon]), { color: '#f0fdf4', weight: 1, fill: false, interactive: false })
      .bindTooltip(s.id, { permanent: true, direction: 'center', className: 'qcm-sheet-label' }).addTo(sheets);
    const field = (name, text) => { $('qcm-estimate').querySelector(`dd[data-field="${name}"]`).textContent = text; };
    const cheaper = orientationAdvice(recipe); // the one real paper saving: don't print a 3x3 when a 2x3 covers it
    field('pages', cheaper ? `${summary.text}. ${cheaper.text}` : summary.text); field('ground', `${summary.groundKm.w.toFixed(1)} × ${summary.groundKm.h.toFixed(1)} km`);
    field('download', `${mb(estimate.downloadBytesEstimate)} MB (${tiles.count} tiles at level ${level}) · PDF about ${mb(estimate.pdfBytesEstimate)} MB · peak memory ${mb(estimate.peakBytes)} MB`);
    say(''); lastSave = store.saveRecipe(recipe);
  } catch (err) { state.recipe = null; fail(err); }
  $('qcm-check').disabled = !state.plan; renderSources();
}

/** A control change throws away only what it can actually have changed.
 *
 *  `resetSources()` below is the right answer to a NEW AREA and the wrong answer
 *  to everything else: every vector layer is fetched for one bbox, so ticking a
 *  layer on or choosing landscape used to blank the map and demand another Check
 *  sources for data already in hand. Scale and DPI are the real exception —
 *  they move the topo tile level — and `sourcesInvalidatedBy` is where that fact
 *  is written down and tested. */
function invalidate(change) {
  for (const id of sourcesInvalidatedBy(change)) { state.states[id] = 'unchecked'; delete state.counts[id]; delete state.reports[id]; }
}

/** Throw away every fetched answer, WITHOUT touching what is on screen. Browsing
 *  refreshes through this one: the previous features stay drawn until the new
 *  answer arrives and renderOverlay redraws from it, so panning never blinks the
 *  map empty. `resetSources` is the same clear plus the wipe, for a NEW AREA. */
function clearFetched() {
  // Named places are fetched for the VIEW by runNames, not for the print area, so a new area or a
  // browse pass never throws them away (that would blank the labels on every pan).
  const names = { state: state.states.names, count: state.counts.names, report: state.reports.names };
  state.states = Object.fromEntries(LAYER_IDS.map((id) => [id, 'unchecked']));
  state.counts = {}; state.reports = {}; state.mvum = {}; state.roadQuality = {}; state.recSites = []; state.trails = null; state.land = [];
  if (names.state !== undefined) { state.states.names = names.state; state.counts.names = names.count; state.reports.names = names.report; }
  state.fetchedFor = null;
}

function resetSources() { clearFetched(); overlay.clearLayers(); }
/** The source states a PRINT reads. Names are fetched for the view, so unless that answer was for
 *  this exact print box the names row reads 'unchecked' and a Check (or Build) asks for them. */
function printStates() {
  const wantsNames = state.recipe?.layers.names;
  if (!wantsNames || sourcesMatchArea(state.namesFor, state.recipe.bboxLonLat)) return state.states;
  return { ...state.states, names: 'unchecked' };
}

function renderSources() {
  const gate = state.recipe ? canBuild({ states: printStates(), layers: state.recipe.layers, areaStates: state.areaStates }) : { ok: false, reason: 'Choose an area first.' };
  const layers = state.recipe ? state.recipe.layers : layersFromControls();
  $('qcm-sources').textContent = `${sourceStateLine(state.states, layers, state.areaStates)}${gate.ok ? '' : ` — ${gate.reason}`}`;
  $('qcm-build').disabled = !gate.ok;
  renderLegend();
  renderOverlay();
  renderLayerReports();
  renderLayerPanelExtras();
  for (const redraw of Object.values(READING_RENDER)) redraw();
  // An open 3D panel follows the same layers, so what it drapes and lists is never stale.
  terrain3d?.refresh();
}

/** Every symbol key the fetched layers really returned, or null before any source
 *  check. EVERY layer, not just MVUM: this read one branch, so a trail, a
 *  campsite or a boundary could be drawn on the map and marked absent in its key.
 *  Each non-MVUM feature already carries the symbolKey it draws with. */
function renderedKeys() {
  if (Object.values(state.states).every((s) => s === 'unchecked')) return null;
  const mvum = Object.values(state.mvum).flatMap((r) => (r && Array.isArray(r.features) ? r.features : []))
    .map((f) => symbolForFeature(f).key);
  const carried = [state.trails?.features || [], state.land, state.recSites || []]
    .flat().map((f) => f.symbolKey);
  const names = (state.namesPlaced || []).map((p) => `name-${p.kind}`);
  return [...mvum, ...carried, ...names].filter(Boolean);
}

/** Draw the fetched layers on the preview, styled from the same table the sheet
 *  prints from. The invariant: a layer that prints, previews. */
function renderOverlay() {
  clearOverlayKeepingCard();
  const on = state.recipe ? state.recipe.layers : controls().layers;
  const features = on.mvum ? Object.values(state.mvum).flatMap((r) => (r && Array.isArray(r.features) ? r.features : [])) : [];
  // Trails and land boundaries preview through the SAME call as MVUM: each feature
  // carries its own symbolKey, so the styling table decides, not this function.
  const drawn = [...features,
    ...(on.trails ? state.trails?.features || [] : []),
    ...state.land.filter((f) => on[f.layer])];
  // A cap the reader cannot see is worse than no cap: they would count parcels on
  // screen, count them on paper, and find the map dishonest. So say it, naming the
  // layer and both numbers, and say plainly that paper is unaffected.
  const note = $('qcm-preview-note');
  note.hidden = true; note.textContent = '';
  const notes = [];
  const truncatedGroups = new Set();   // QQA-09: route kinds the preview cut short, so a length on them is not whole
  const label = (k) => SYMBOL_BY_KEY[k]?.label || k;
  const onTruncate = (capped) => {
    for (const c of capped) { const g = routeKindOf(c.key)?.group; if (g) truncatedGroups.add(g); }
    const fmt = (n) => n.toLocaleString('en-US');
    notes.push(`On screen only: ${capped.map((c) => `${label(c.key)} — ${fmt(c.shown)} of ${fmt(c.total)} drawn`).join('; ')}. Every one of them prints.`);
  };
  // The other direction, and the one F12 opened: too dense for the chosen paper,
  // readable on the screen the reader is actually looking at. Naming the finer
  // scale is the whole remedy — the layer is there, the sheet is what drops it.
  const onScreenOnly = (rows) => {
    const at = (n) => `1:${n.toLocaleString('en-US')}`;
    notes.push(`${rows.map((r) => label(r.key)).join(', ')} will not print at `
      + `${at(rows[0].paperScale)} — choose a finer scale to keep ${rows.length > 1 ? 'them' : 'it'} on paper.`);
  };
  const flush = () => { note.textContent = notes.join(' '); note.hidden = !notes.length; };
  // The gate is what a CSS pixel covers here, now — not the recipe's paper scale.
  const polys = previewPolylines(drawn, {
    roadQuality: state.roadQuality,
    scale: screenScaleDenominator(map.getZoom(), map.getCenter().lat),
    paperScale: state.recipe?.scale ?? Number($('qcm-scale').value),
    onTruncate, onScreenOnly,
  });
  // QQA-08: the same lines, as data the tap handler and "Places in this view" read.
  state.routes = collectRoutes(polys);
  state.truncatedGroups = truncatedGroups;
  for (const p of polys) {
    // An area style (a land boundary) is a polygon with its light fill; anything
    // else stays a line. Both come from the table, so this function chooses nothing.
    const stroke = { color: p.color, weight: p.weight, dashArray: p.dashArray || undefined };
    const shape = p.closed
      ? L.polygon(p.latlngs, { ...stroke, renderer: overlayRenderer, fill: true, fillColor: p.fillColor, fillOpacity: p.fillOpacity })
      : L.polyline(p.latlngs, { ...stroke, renderer: overlayRenderer });
    // The layer's own id, so a spotlight (D1) can target this one shape; a WeakMap
    // would work too, but the shape already carries its own `options` bag.
    shape.options.qcLayerId = p.id ?? p.key;
    // The REGISTRY layer id this shape belongs to (trails, federalLand, ...), not the
    // per-shape id above -- a group-level spotlight/highlight targets every shape a
    // layer draws, and displayStyle's spotlight comparison is a plain equality, so this
    // is the only change needed to make "Highlight trails" light up every trail shape.
    const spotlightId = SYMBOL_KEY_TO_LAYER_ID[p.key] || shape.options.qcLayerId;
    shape.setStyle(displayStyle(p.key, currentDisplay, { layerId: spotlightId }));
    // Under the pointer the shape thickens, computed fresh from the canonical
    // symbol every time (displayStyle) so repeated hover/unhover never compounds.
    shape.on('mouseover', () => shape.setStyle(displayStyle(p.key, currentDisplay, { hover: true, layerId: spotlightId })));
    shape.on('mouseout', () => shape.setStyle(displayStyle(p.key, currentDisplay, { layerId: spotlightId })));
    identify(shape.bindTooltip(p.title).addTo(overlay), p.title);
  }
  flush();
  // N2: named places render regardless of the recreation-site switches below --
  // this used to sit after the early return and so never ran unless recSites or
  // blmRecSites was also on, which left the names layer silently undrawable.
  renderNames(on);
  // QUX-11b: cleared unconditionally, before the early return below -- a rec
  // layer toggled off must not leave selectPlace holding a detached marker.
  recPins.clear();
  // Both recreation layers fill `state.recSites`, so reading only the Forest Service
  // switch left a reader who ticked BLM alone with a count and no pins.
  if (!on.recSites && !on.blmRecSites) return;
  // The roads go with the sites: a campsite's tooltip says how far the nearest
  // inventory-stated unpaved road is, and it can only say that about roads it was
  // handed (F13). `features` is the MVUM set already drawn for this area.
  // QUX-11b: the same stable `rec:<provider>:...` ids "Places in this view" rows
  // carry (places-in-view.js's assignRecIds), computed once per render over the
  // WHOLE recSites array so an id never depends on which of these sites falls in
  // the current viewport.
  const recIds = assignRecIds(state.recSites || []);
  for (const m of previewSites(state.recSites || [],
    { roads: features, roadQuality: state.roadQuality })) {
    // A divIcon, not a vector: the shape comes from the symbol table (so a
    // trailhead reads as a trailhead), and it is real DOM, so Leaflet's own
    // `keyboard` handling gives it a tab stop and Enter opens it. This loop used
    // to bind a tooltip to a non-interactive layer, which nothing could open.
    const pin = L.marker(m.latlng, {
      icon: L.divIcon({ className: 'qcm-site-marker', html: m.svg,
        iconSize: [m.size, m.size], iconAnchor: [m.size / 2, m.size / 2] }),
      keyboard: true,
      alt: m.title,
      title: m.title,
    }).bindTooltip(m.title).addTo(overlay);
    const id = recIds.get(m.site);
    if (id) recPins.set(id, pin);
    // QUX-11b: a rec pin click is one of the four places `nearbyFrom` is set
    // from -- same shape selectPlace and the GNIS chooseName/chooseFeat above
    // write, so "Places in this view" never has to know which kind of place
    // last set it.
    const chooseSite = () => {
      if (!id) return;
      state.selectedNameId = id;
      state.selectedSearchFeature = null;
      state.selectedCardOpen = true;
      state.nearbyFrom = { id, name: m.title, lonLat: m.site.lonLat };
    };
    pin.on('click', () => { chooseSite(); renderSources(); });
    // A BLM record carries the agency's own directions, description, fee text, vintage
    // and page link — lines source-blm-rec-sites.js worded and nothing showed. They go in
    // a card: a paragraph in a hover label is not a control. A Forest Service site has
    // none and keeps the tooltip it had.
    // QUX-11b (§2.6 item 4): `near` -- the near-unpaved phrase, previously folded
    // into the tooltip title -- rides as the card's own last line now that Enter
    // opens a card, not just the tooltip, for any site with lines. Mirrors
    // site-card.test.mjs's own harness wiring exactly, so a site with lines but no
    // near phrase (or vice versa) never gets a card `siteCard` would refuse.
    const cardLines = m.lines ? [...m.lines, m.near].filter(Boolean) : null;
    identify(pin, m.title, cardLines ? siteCard(cardLines) : null, chooseSite);
    trackSelectedCard(pin, id && id === state.selectedNameId);
  }
}

// QUX-06: one on-demand USGS 3DEP point elevation per opened name card. Module
// scope, not pin-scope -- renderNames' own comment above notes a click redraws
// and tears the whole overlay down, so the marker a fetch started under is
// often gone before that fetch resolves, and only a guard/controller that
// outlives any one marker can still drop or cancel it. Reuses
// source-terrain-names.js's createSearchGuard and the AbortController pattern
// quiet-corners.js's own name search already uses (nameSearchGuard/
// nameSearchController), rather than inventing a second cancellation scheme.
const elevationGuard = createSearchGuard();
let elevationController = null;
// QUX-06 fix: a redraw (Check sources, or a pan/zoom settling) tears the
// whole overlay down and rebuilds it, and rebuilding reopens the popup for
// whichever id was already selected -- so without a cache, the SAME point
// gets re-fetched from 3DEP on every redraw, flickering the line back to
// "loading…" for an answer it already had. Keyed by each call site's own
// stable id (never by a screen-projected latlng, which jitters between
// renders), and only ever holds a settled answer: a metres number, or null
// for NoData -- an error or an abort is never cached, so either still
// retries on the next popupopen.
const elevationCache = createLru(ELEVATION_CACHE_LIMIT);
// The cache above only helps once an answer has landed. A redraw that lands
// WHILE the answer is still loading (town labels or the bulk names answer
// arriving, a pan settling, the Places list reselecting the same row) also
// tears the pin down and reopens its card -- and reopening used to abort the
// request in flight and send the same point to 3DEP again, so a card could
// re-ask forever under a busy map, and a proof waiting for its one request
// saw the count skip past it (PR CI runs 37600249024, 37611351249). Keyed
// like the cache: one request per point at a time, which a reopen of the same
// point joins. Cleared when the request settles either way, so an error or an
// abort still retries on the next popupopen exactly as the cache comment says.
const elevationInFlight = new Map();

/** Wires a one-point elevation fetch into `card`'s popup lifecycle. `anchor`
 *  is [lat, lon] (name-labels.js's convention); fetchElevations wants
 *  [[lon, lat]]. `key` identifies the point across redraws (the declutter
 *  loop's `p.id` / a search hit's own `id`) for elevationCache above. Gated
 *  on the pin's own 'popupopen' -- renderNames only calls pin.openPopup() for
 *  the selected id and drawSelectedSearchFeature only ever draws the one
 *  chosen search hit, so this never fires for a name whose card merely
 *  exists unopened, on hover, or on a map move. */
function attachElevation(pin, card, anchor, key) {
  const line = document.createElement('p');
  line.className = 'qcm-site-card-elevation';
  const caveat = document.createElement('p');
  caveat.className = 'qcm-site-card-elevation-caveat';
  caveat.hidden = true;
  const actions = card.querySelector('.qcm-site-card-actions');
  if (actions) card.insertBefore(line, actions); else card.append(line);
  // The caveat goes above the actions too, so their dock stays the card's last
  // child. It only appears once the answer lands, and the name card is taller
  // than its 230 px popup (quiet-corners-maps.css's cap). Before the dock, a
  // caveat above the actions slid them 134 px down under a pointer already on
  // its way to one; docked (quiet-corners-maps.css), they hold the popup's
  // bottom edge and the caveat grows the lines that scroll under them.
  // Appended after the dock instead, it lifted the dock 110 px off that edge at
  // the end of the scroll.
  // The line holds its height: every text it shows wraps to the same two lines.
  if (actions) card.insertBefore(caveat, actions); else card.append(caveat);
  const renderElevation = (m) => {
    // QQA-09: a fact record. No data is "unknown", never 0 ft; a real 0 m prints as 0 ft.
    const fact = pointElevationFact(m);
    if (fact.value === null) {
      line.textContent = 'Approximate terrain elevation: unknown for this point.';
      caveat.hidden = true;
      return;
    }
    const feet = Math.round(fact.value / M_PER_FOOT);
    line.textContent = `Approximate terrain elevation: ${feet.toLocaleString('en-US')} ft`;
    caveat.textContent = `Ground elevation at this point. Source: ${fact.source}. Vertical reference: ${fact.verticalReference.replace(/^vertical reference /, '')}. `
      + `Resolution: ${fact.resolution.replace(/^resolution /, '')}. ${ELEVATION_SOURCE.pointSemantics}`;
    caveat.hidden = false;
  };
  pin.on('popupopen', () => {
    // Cancellation semantics stay exactly as they were for a genuine new
    // selection even on a cache hit: bump the guard and abort whatever was
    // still in flight for a DIFFERENT point, so its slow answer can never
    // land on this reopened card. The same point's own request in flight is
    // kept and joined below, never aborted by a redraw of its card.
    const token = elevationGuard.bump();
    const sameFlight = elevationInFlight.get(key) || null;
    if (elevationController && (!sameFlight || elevationController !== sameFlight.controller)) elevationController.abort();
    if (elevationCache.has(key)) {
      elevationController = null;
      renderElevation(elevationCache.get(key));
      return;
    }
    line.textContent = 'Approximate terrain elevation: loading…';
    caveat.hidden = true;
    let flight = sameFlight;
    if (!flight) {
      const controller = new AbortController();
      const answer = fetchElevations({ points: [[anchor[1], anchor[0]]], signal: controller.signal })
        .then((elevations) => {
          const m = elevations[0];
          const settled = m === null || m === undefined ? null : m;
          elevationCache.set(key, settled);
          return settled;
        })
        .finally(() => { if (elevationInFlight.get(key) === flight) elevationInFlight.delete(key); });
      flight = { controller, answer };
      elevationInFlight.set(key, flight);
    }
    elevationController = flight.controller;
    flight.answer
      .then((m) => {
        if (!elevationGuard.isCurrent(token)) return;
        renderElevation(m);
      })
      .catch((err) => {
        if (err?.name === 'AbortError' || !elevationGuard.isCurrent(token)) return;
        line.textContent = 'Approximate terrain elevation: unavailable.';
      });
  });
}

// QUX-11a: one Leaflet marker per drawn GNIS name (placed, or the selected
// fallback below), keyed by id, so a "Places in this view" row selection
// (selectPlace) can find and reopen the SAME marker renderNames just drew.
// Cleared and rebuilt every render, because renderOverlay clears the whole
// overlay first (:1460-ish).
const namePins = new Map();
// QUX-11b: the same pattern as namePins above, but for recreation-site pins --
// keyed by the stable `rec:<provider>:...` id assignRecIds (places-in-view.js)
// computes, so selectPlace can find and reopen a rec row's own pin exactly the
// way it already does for a GNIS row. Cleared every render REGARDLESS of
// whether either rec layer is on (the rec loop below returns early when
// neither is), so a layer toggled off never leaves a stale, detached marker
// reference behind for selectPlace to open.
const recPins = new Map();
// Every marker renderNames draws: the placed names, the selected fallback and a
// searched-for name. renderOverlay clears the whole overlay before it calls
// renderNames, but the 'qc:town-labels-changed' redraw (attach(), above) runs on
// every pan with no clear, so renderNames removes its own previous markers first.
// Without that, each pan left the last pass's markers behind: one more marker per
// name per pan (scripts/qcm/town-label-dedupe.test.mjs).
const nameMarkers = [];
// QUX-11a: in memory only (E10) -- no storage key, so no privacy addition.
let placeFilters = defaultFilters();

/** Named terrain & places (GNIS), N2. Declutter is computed fresh every render
 *  (name-labels.js's placeScreenLabels), never baked into a tile, so displayStyle's
 *  emphasis/contrast rules reach it exactly like every other owned vector. `status`
 *  gates placement outright -- only ready and capped (the important kinds, with a note naming
 *  what zooming in adds) draw; partial/over-cap/timeout/error never draws a
 *  silently-truncated "complete" layer, per name-labels.js's own STATUS_MESSAGE.
 *
 *  QUX-11a: "Places in this view" (renderNameList, below) lists every fetched
 *  name whose point is in the current bounds, labelled or not -- independent
 *  of this function's own declutter cap, and never silently empty for a
 *  status that isn't a real answer (partial/timeout/error/not-yet-fetched). */
function renderNames(on) {
  // The selected name's pin rides the redraw when its card is open. Tearing it
  // down and opening the card again on a fresh pin (what every redraw did)
  // closed a popup Leaflet keeps in the pane for 200 ms while it fades, so a
  // pan, a names answer or an elevation landing put a second -- then a third --
  // `.leaflet-popup` beside the live card, and the card itself blinked. The pin
  // below is moved and re-iconed in place instead; its card, handlers and the
  // elevation already on it stay. It is removed only if this pass has no place
  // for it (names off, or the name out of view).
  const kept = on.names ? keptNamePin() : null;
  const keep = kept ? { id: state.selectedNameId, pin: kept, used: false } : null;
  for (const m of nameMarkers) if (m !== kept) overlay.removeLayer(m);
  nameMarkers.length = 0;
  namePins.clear();
  if (!on.names) {
    state.namesPlaced = []; state.namesDropped = 0; state.namesMessage = null;
    // QUX-11b: names off no longer means the list is hidden outright -- a
    // reader who ticked only a rec layer still needs a way to open it.
    renderNameList(placesListOn());
    drawSelectedSearchFeature(new Set());
    drawRoads();   // the space the names held is the roads' again
    return;
  }
  const status = state.names?.status || 'error';
  const townLabels = (typeof window !== 'undefined' && Array.isArray(window.qcTownLabels)) ? window.qcTownLabels : [];
  const deduped = dedupeAgainstTownLabels(state.names?.features || [], townLabels);
  const size = map.getSize();
  const toPx = (lon, lat) => map.latLngToContainerPoint([lat, lon]);
  const { placed, dropped, message } = placeScreenLabels(deduped, {
    toPx, viewport: { width: size.x, height: size.y }, measureText: measureName,
    prefs: state.labelPrefs, selectedId: state.selectedNameId, zoom: map.getZoom(), status,
    previous: new Set((state.namesPlaced || []).map((p) => p.id)),
    omittedKinds: state.names?.omittedKinds || [],
  });
  state.namesPlaced = placed; state.namesDropped = dropped; state.namesMessage = message;
  const box = 240, half = box / 2;
  for (const p of placed) {
    // p.sizePx: name-labels.js already resolved state.labelPrefs.size against
    // SIZE_SCALE (falling back to 'normal') before this loop ever runs -- the
    // box/half layout constants above stay fixed regardless of label size.
    const sizePx = p.sizePx;
    const dx = p.labelX - p.x, dy = p.labelY - p.y;
    const { width: tw, height: th } = measureName(p.name, sizePx);
    const html = document.createElement('div');
    html.style.cssText = `position:relative;width:${box}px;height:${box}px;`;
    const glyph = document.createElement('div');
    glyph.className = 'qcm-name-marker-glyph';
    glyph.style.cssText = `position:absolute;left:${half - sizePx / 2}px;top:${half - sizePx / 2}px;width:${sizePx}px;height:${sizePx}px;`;
    glyph.innerHTML = siteIconSvg(p.marker, sizePx, '#111111');
    const label = document.createElement('span');
    label.className = `qcm-name-label${p.selected ? ' is-selected' : ''}`;
    label.textContent = p.name;
    // No font-size here: the CSS (var(--qc-label-px)) draws it, from the same
    // SIZE_SCALE value measureName reserved this box with.
    label.style.cssText = `position:absolute;left:${half + dx - tw / 2}px;top:${half + dy - th / 2}px;width:${tw}px;height:${th}px;`;
    html.append(glyph, label);
    const latlng = map.containerPointToLatLng([p.x, p.y]);
    const icon = L.divIcon({ className: 'qcm-name-marker', html: html.outerHTML, iconSize: [box, box], iconAnchor: [half, half] });
    if (keep && p.id === keep.id) {
      keep.used = true;
      keepNamePin(keep.pin, latlng, icon);
      nameMarkers.push(keep.pin);
      namePins.set(p.id, keep.pin);
      continue;
    }
    const pin = L.marker(latlng, { icon, keyboard: true, alt: p.name, title: p.name }).addTo(overlay);
    nameMarkers.push(pin);
    namePins.set(p.id, pin);
    // Choosing a name only records which one (state.selectedNameId); it is never
    // opened here. A click also redraws (renderSources tears this very layer down),
    // so the popup this loop opens below -- on whichever marker THIS render places
    // for the selected id -- is always the fresh one, never the layer a click just
    // removed out from under itself.
    // QUX-11b (§2.6): a GNIS pin click is one of the four places `nearbyFrom`
    // is set from, so "Nearest to <name>" (the places list's sort) can measure
    // from a name as well as a recreation site.
    const chooseName = () => { state.selectedNameId = p.id; state.selectedSearchFeature = null; state.selectedCardOpen = true; state.nearbyFrom = { id: p.id, name: p.name, lonLat: [latlng.lng, latlng.lat] }; };
    pin.on('click', () => { chooseName(); renderSources(); });
    // QUX-09b: `open: p.selected` -- this loop builds a card for every PLACED
    // marker, most of which the reader never opens, so the ask:false mismatch
    // check must fire only for the one this render pass is about to show
    // (p.selected/pin.openPopup() below); unconditionally, it fired once per
    // marker and the header ended up naming whichever was built last, not the
    // one actually on screen (before-you-go.test.mjs test 2).
    const card = nameCard({ id: p.id, name: p.name, kind: p.kind, county: p.county, state: p.state, anchor: [latlng.lat, latlng.lng] }, p.iconLabel, { open: p.selected });
    attachElevation(pin, card, [latlng.lat, latlng.lng], p.id);
    identify(pin, p.name, card, chooseName);
    trackSelectedCard(pin, p.selected);
  }
  // QUX-11a §2.4 item 2: a selected name that the declutter loop above did NOT
  // place (crowded out, or a `partial` answer, which places nothing at all)
  // still gets a marker -- glyph only, no label span, so it never competes for
  // the collision budget it was just refused. Covers the browser test's
  // partial-answer row selection (§4.2 step 7) and any name too close to the
  // viewport edge for every label offset to fit.
  if (state.selectedNameId && !placed.some((p) => p.id === state.selectedNameId)) {
    // Reads state.names.features directly, not `deduped` -- a name the reader
    // just selected (from a pin or a list row) must never lose its fallback
    // marker to the town-label dedupe above, which the placed loop is subject
    // to but a deliberately chosen selection should not be.
    const feat = (state.names?.features || []).find((f) => f.id === state.selectedNameId);
    const selLatlng = feat && L.latLng(feat.anchor[0], feat.anchor[1]);
    if (feat && map.getBounds().contains(selLatlng)) {
      const sizePx = SIZE_SCALE[state.labelPrefs.size] || SIZE_SCALE.normal;
      const glyphHtml = `<div class="qcm-name-marker-glyph" style="width:${sizePx}px;height:${sizePx}px;">${siteIconSvg(iconFor(feat.kind).marker, sizePx, '#111111')}</div>`;
      const icon = L.divIcon({ className: 'qcm-name-marker is-unlabelled', html: glyphHtml, iconSize: [sizePx, sizePx], iconAnchor: [sizePx / 2, sizePx / 2] });
      if (keep && feat.id === keep.id) {
        keep.used = true;
        keepNamePin(keep.pin, selLatlng, icon);
        nameMarkers.push(keep.pin);
        namePins.set(feat.id, keep.pin);
      } else {
      const pin = L.marker(selLatlng, { icon, keyboard: true, alt: feat.name, title: feat.name }).addTo(overlay);
      nameMarkers.push(pin);
      namePins.set(feat.id, pin);
      const chooseFeat = () => { state.selectedNameId = feat.id; state.selectedSearchFeature = null; state.selectedCardOpen = true; state.nearbyFrom = { id: feat.id, name: feat.name, lonLat: [feat.anchor[1], feat.anchor[0]] }; };
      pin.on('click', () => { chooseFeat(); renderSources(); });
      const card = nameCard(feat, iconFor(feat.kind).label, { open: true });
      attachElevation(pin, card, feat.anchor, feat.id);
      identify(pin, feat.name, card, chooseFeat);
      trackSelectedCard(pin, true);
      }
    }
  }
  renderNameList(true);
  // namePins, not just `placed`: a searched-for name the declutter loop left unplaced
  // already has the selected fallback marker above, and a second marker for it would
  // sit on the same point.
  drawSelectedSearchFeature(new Set(namePins.keys()), keep);
  // Kept for a place this pass never gave it: off the map, like any other pin.
  if (keep && !keep.used) overlay.removeLayer(keep.pin);
  // Road labels reserve what is on the map only when they are placed, so names that arrive or
  // change after the roads were drawn send the held road answer back through placement.
  drawRoads();
}

// Named places (GNIS) run their own per-view pass, like roads: the padded view, keyed by zoom, a
// held answer reused while a pan stays inside it, latest wins. No area or zoom gate refuses it --
// what a view can draw is decided by namesPlanForView and fetchBounded's rung budget.

/** The ONE names fetch: the kinds this zoom draws, under the extent's record budget. */
function fetchNamesFor(box, zoom, signal) {
  const { kinds, budget } = namesPlanForView({ zoom, bbox: box });
  return fetchBounded(box, kinds, { zoom, signal, cap: budget });
}

/** GNIS and the NHD river tier for the same padded view and zoom, started together. Each is its own
 *  promise: the GNIS answer draws the moment it arrives and the river tier is merged in when it
 *  lands, so a slow or failed NHD request never delays, blanks or errors the GNIS names. */
function startNamesAndStreams(box, zoom, signal) {
  return {
    gnis: fetchNamesFor(box, zoom, signal).catch(() => ({ status: 'error' })),
    streams: fetchStreamNames(box, { zoom, signal }).catch(() => ({ status: 'error', features: [], omittedKinds: [] })),
  };
}

/** The NHD credit stays on the map's attribution exactly while the names row is on. */
function setNamesCredit(on) {
  const text = on ? SOURCES.nhdFlowlines.attribution : null;
  if (text === namesCredit) return;
  if (namesCredit && map.attributionControl) map.attributionControl.removeAttribution(namesCredit);
  if (text && map.attributionControl) map.attributionControl.addAttribution(text);
  namesCredit = text;
}

/** Write a names answer into page state. ready -> 'ready'; capped (more names than one request
 *  carries, the important kinds drawn) -> 'partial' with the note naming what zooming in adds;
 *  never 'unavailable' for a drawable answer. */
function applyNamesResult(result, box) {
  const features = result.features || [];
  const zero = result.status === 'ready' && features.length === 0;
  state.names = result;
  state.namesFor = { ...box };
  state.namesRetrievedAt = new Date().toISOString();
  state.counts.names = result.status === 'over-cap' ? result.count : features.length;
  state.reports.names = zero ? STATUS_MESSAGE.zero
    : result.status === 'capped' ? cappedMessage([...new Set(features.map((f) => f.kind))], result.omittedKinds || [])
      : (STATUS_MESSAGE[result.status] || null);
  state.states.names = result.status === 'ready' ? 'ready'
    : result.status === 'capped' || result.status === 'partial' ? 'partial' : 'unavailable';
}

/** Moveend/zoomend and the row's own switch: clear at once when the row is off, otherwise wait for
 *  the pan to stop. */
function renderNamesPass() {
  if (!map) return;
  setNamesCredit(namesOn());
  if (!namesOn()) {
    namesDebounce.cancel();
    if (namesAbort) namesAbort.abort();
    state.namesGeneration += 1;
    namesFetched = null;
    return;
  }
  namesDebounce.call();
}

async function runNames() {
  if (!map || !namesOn()) return;
  const zoom = map.getZoom();
  const b = map.getBounds();
  if (!namesPlanForView({ zoom }).kinds.length) {
    // Below the lowest zoom any name draws at: nothing to ask, and nothing held is still true.
    if (namesAbort) namesAbort.abort();
    state.namesGeneration += 1;
    namesFetched = null; state.names = null; state.namesFor = null; state.streamsNote = null;
    state.states.names = 'unchecked'; delete state.counts.names; state.reports.names = null;
    renderSources();
    return;
  }
  if (namesFetched && namesFetched.zoom === zoom && state.states.names !== 'unavailable' && namesFetched.bounds.contains(b)) {
    if (namesAbort) namesAbort.abort();
    return;
  }
  const padded = b.pad(NAMES_FETCH_PAD);
  const box = { minLon: padded.getWest(), minLat: padded.getSouth(), maxLon: padded.getEast(), maxLat: padded.getNorth() };
  if (namesAbort) namesAbort.abort();
  const mine = new AbortController();
  namesAbort = mine;
  const token = ++state.namesGeneration;
  const asked = startNamesAndStreams(box, zoom, mine.signal);
  const result = await asked.gnis;
  const current = () => !(mine.signal.aborted || namesAbort !== mine || isStaleGeneration(token, state.namesGeneration) || !namesOn());
  if (!current()) return;
  if (result.status === 'error' || result.status === 'timeout') {
    // Keep the last labels: they are still true of the ground they were drawn on.
    state.states.names = 'unavailable';
    state.reports.names = STATUS_MESSAGE[result.status];
    namesFetched = null;
    renderSources();
    return;
  }
  // The GNIS answer draws now; the river tier follows when it lands.
  state.streamsNote = null;
  applyNamesResult(result, box);
  renderSources();
  const streams = await asked.streams;
  if (!current()) return;
  const streamsFailed = streams.status === 'error' || streams.status === 'timeout';
  state.streamsNote = streamsFailed ? STATUS_MESSAGE.rivers : null;
  applyNamesResult({ ...result, features: mergeStreamNames(result.features, streams.features) }, box);
  if (streamsFailed) state.reports.names = [state.reports.names, STATUS_MESSAGE.rivers].filter(Boolean).join(' ');
  // A failed river request is asked again at the next settle; a held box would never retry it.
  namesFetched = streamsFailed ? null : { zoom, bounds: padded };
  renderSources();
}

/** QQA-05r-2: road names on the screen map. Called on every moveend/zoomend and when the row is
 *  toggled. Anything that clears (row off, zoom below the first road zoom) acts at once and
 *  cancels what is pending; anything that asks waits 400 ms for the pan to stop, and a newer
 *  view aborts the older request (the source's own latest-wins, plus `roadAbort` for the
 *  off/zoomed-out case where no newer request follows). `on` is the layers object when the
 *  caller already has one. */
function renderRoads(on) {
  if (!map || !roadLayer) return;
  const layers = on || layersFromControls();
  roadDebounce.cancel();
  setRoadCredit(!!layers.roads);
  if (!layers.roads || !roadsReach(map.getZoom())) {
    if (roadAbort) roadAbort.abort();
    roads = { status: 'empty', entries: [] };
    roadsFetched = null;
    clearRoads();
    setRoadsNote('', '');
    renderNameList(placesListOn());
    return;
  }
  roadDebounce.call();
}

/** The credit stays on the map's attribution exactly while the row is on. */
function setRoadCredit(on) {
  const text = on ? SOURCES.usgsRoadNames.attribution : null;
  if (text === roadCredit) return;
  if (roadCredit && map.attributionControl) map.attributionControl.removeAttribution(roadCredit);
  if (text && map.attributionControl) map.attributionControl.addAttribution(text);
  roadCredit = text;
}

function clearRoads() { if (roadLayer) roadLayer.clearLayers(); state.roadsPlaced = []; }

/** The row's note and badge. Quiet when the answer is complete or empty; a short plain-words
 *  sentence when it is not. */
function setRoadsNote(text, badge) {
  roadsBadge = badge;
  // The row's own elements are made by layerRow from the registry id, not written in a layout.
  const el = $(`${ROADS_INPUT}-report`);
  if (el) { el.textContent = text; el.hidden = !text; }
  const b = $(`${ROADS_INPUT}-badge`);
  if (b) { b.textContent = layersFromControls().roads ? (badge || 'on') : 'off'; b.hidden = false; }
}

/** One fetch for the view as it is now, then draw. A newer view, the row going off or the zoom
 *  dropping below 10 while this waits makes its answer stale, and a stale answer draws nothing. */
async function runRoads() {
  if (!map || !roadLayer) return;
  const zoom = map.getZoom();
  const b = map.getBounds();
  // A pan that stays inside the box already fetched (same zoom) re-places the held answer and asks
  // for nothing; a fetch is for the view PLUS a margin, so a small drag does not cost a request.
  if (roadsFetched && roadsFetched.zoom === zoom && roads.status !== 'error' && roadsFetched.bounds.contains(b)) {
    if (roadAbort) roadAbort.abort();
    drawRoads();
    return;
  }
  const padded = b.pad(ROAD_FETCH_PAD);
  const bbox = { minLon: padded.getWest(), minLat: padded.getSouth(), maxLon: padded.getEast(), maxLat: padded.getNorth() };
  if (roadAbort) roadAbort.abort();
  const mine = new AbortController();
  roadAbort = mine;
  let got;
  try {
    got = await fetchRoadNames({ bbox, zoom, signal: mine.signal });
  } catch (err) {
    got = { status: 'error', entries: [] };
  }
  if (mine.signal.aborted || got.status === 'stale' || roadAbort !== mine) return;
  if (!layersFromControls().roads || !roadsReach(map.getZoom())) return;
  if (got.status === 'error') {
    // Keep the last labels: they are still true of the ground they were drawn on.
    setRoadsNote('Road names did not load', 'unavailable');
    return;
  }
  roads = got;
  roadsFetched = { zoom, bounds: padded };
  setRoadsNote(got.status === 'partial' ? 'More roads than shown' : '', got.status === 'partial' ? 'partial' : '');
  drawRoads();
}

/** Place and draw the held answer for the view as it is now. */
function drawRoads() {
  if (!map || !roadLayer) return;
  clearRoads();
  if (!layersFromControls().roads || !roadsReach(map.getZoom()) || !roads.entries.length) { renderNameList(placesListOn()); return; }
  const size = map.getSize();
  const container = map.getContainer();
  const { placed } = placeRoadLabels(roads.entries, {
    toPx: (lon, lat) => map.latLngToContainerPoint([lat, lon]),
    viewport: { width: size.x, height: size.y },
    measureText: measureName,
    prefs: state.labelPrefs,
    // Read from the page, not recomputed: what is on the map now is what a road must clear.
    reserved: reservedFromDom(container),
  });
  for (const p of placed) {
    const el = document.createElement('span');
    el.className = 'qcm-road-label';
    el.textContent = p.label;
    // No font-size: the CSS reads var(--qc-label-px), the value measureName reserved this box at.
    el.style.cssText = `width:${p.width}px;height:${p.height}px;transform:rotate(${p.bearing}deg);`;
    L.marker(map.containerPointToLatLng([p.x, p.y]), {
      pane: 'qcm-roads', interactive: false, keyboard: false,
      icon: L.divIcon({ className: 'qcm-road-marker', html: el.outerHTML, iconSize: [p.width, p.height], iconAnchor: [p.width / 2, p.height / 2] }),
    }).addTo(roadLayer);
  }
  // QQA-08: the roads lettered on the map are also rows in "Places in this view".
  state.roadsPlaced = placed;
  renderNameList(placesListOn());
}

/** QUX-05c: draws the ONE card for a name chosen through the "Search places" finder
 *  (window.qcSelectName), independent of whether the "Named places &
 *  landmarks" layer is even on. That layer defaults OFF (layer-registry.js),
 *  so a naive "just let the declutter loop above draw the selected id" would
 *  silently open no popup at all for the common case of searching a name
 *  without ever switching the bulk layer on. Deduped against `placedIds` (every
 *  name renderNames drew this pass, placed or the selected fallback) so a
 *  feature already drawn for this render never gets a second, overlapping marker. */
function drawSelectedSearchFeature(placedIds, keep = null) {
  const hit = state.selectedSearchFeature;
  if (!hit || placedIds.has(hit.id)) return;
  const latlng = L.latLng(hit.anchor[0], hit.anchor[1]);
  if (keep && hit.id === keep.id) {
    // Same pin, same open card, across this redraw (renderNames's `keep`).
    keep.used = true;
    keepNamePin(keep.pin, latlng);
    nameMarkers.push(keep.pin);
    namePins.set(hit.id, keep.pin);
    return;
  }
  const pin = L.marker(latlng, { keyboard: true, alt: hit.name, title: hit.name }).addTo(overlay);
  nameMarkers.push(pin);
  // In namePins too, so the next redraw's `keep` finds it and selectPlace can open it.
  namePins.set(hit.id, pin);
  const card = nameCard(hit, iconFor(hit.kind).label, { open: true });
  attachElevation(pin, card, hit.anchor, hit.id);
  identify(pin, hit.name, card);
  trackSelectedCard(pin, true);
}

/** Every redraw tears the pins down and draws them again, and a card the reader closed
 *  must not come back with the next pan or zoom. So a pin's card reopens on a redraw
 *  only while state.selectedCardOpen says the reader still has it open. A popupclose
 *  clears that only when the pin is still on the map: Leaflet's removeLayer drops a
 *  layer from the map before firing its `remove`, which is what closes a popup when a
 *  redraw takes the pin away, so that close is the redraw's and not the reader's.
 *  Clicking or keying the marker opens its card again and sets it back. */
/** Move a kept pin to where this pass placed its name and give it this pass's
 *  icon. Leaflet reuses the pin's own DIV for a DivIcon (createIcon(oldIcon)), so
 *  the tab stop, role and label `identify` put on it stay; setIcon re-binds the
 *  open popup to the pin without closing it, and setLatLng moves it along. */
/** The one pin a redraw keeps: the selected name's, while its card is open and
 *  it is still on the overlay. Both renderOverlay's clear and renderNames's
 *  teardown spare exactly this pin, so the same answer serves both. */
function keptNamePin() {
  if (!state.selectedNameId || !state.selectedCardOpen) return null;
  const pin = namePins.get(state.selectedNameId);
  return pin && pin.isPopupOpen() && overlay.hasLayer(pin) ? pin : null;
}

/** renderOverlay's clear. overlay.clearLayers() took the selected pin with
 *  everything else before renderNames ever ran, closing the card on every
 *  redraw; the same loop, minus that one pin. */
function clearOverlayKeepingCard() {
  const kept = keptNamePin();
  overlay.eachLayer((layer) => { if (layer !== kept) overlay.removeLayer(layer); });
}

function keepNamePin(pin, latlng, icon = null) {
  pin.setLatLng(latlng);
  if (icon) pin.setIcon(icon);
}

function trackSelectedCard(pin, selected) {
  pin.on('popupopen', () => { state.selectedCardOpen = true; });
  pin.on('popupclose', () => { if (map.hasLayer(pin)) state.selectedCardOpen = false; });
  if (selected && state.selectedCardOpen) pin.openPopup();
}

/** Best-effort clipboard copy, modeled on quiet-corners.js's qc-view-share
 *  handler: the modern Clipboard API when it exists, else a hidden textarea +
 *  execCommand('copy'). Resolves on success, rejects on failure -- siteCard's
 *  own action wiring turns a rejection into visible status text, never a
 *  silent no-op. */
function copyTextToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) resolve(); else reject(new Error('copy command was refused'));
    } catch (err) { reject(err); }
  });
}

/** Reuses view-state.js's own share-link machinery (formatFragment) rather
 *  than inventing a second URL format: the same fragment quiet-corners.js's
 *  "Share view" button writes, just centered on the chosen name instead of
 *  the current map center. `window.qcCurrentView` (quiet-corners.js) supplies
 *  the rest of the view; DEFAULT_VIEW is the fallback before that bridge is
 *  wired (e.g. under node --test). */
function buildShareUrl(anchor) {
  const base = typeof window.qcCurrentView === 'function' ? window.qcCurrentView() : DEFAULT_VIEW;
  const view = { ...base, center: [anchor[0], anchor[1]], camera: null, centerSource: 'user' };
  const f = formatFragment(view, { includeLocation: false });
  return location.origin + location.pathname + location.search + f.fragment;
}

/** QUX-09a "Show": flyTo + reopen the same 05c card via quiet-corners.js's
 *  window.qcShowSavedPlace bridge (selectNameHit, "Search places" pattern). */
function onShowSavedPlace(place) {
  if (place.ref.startsWith('camera:')) {
    showSavedCamera(place).then((text) => { if (text) savedPanel?.render(text); });
    return;
  }
  const hit = { id: place.ref, name: place.name, kind: place.kind, county: place.county, state: place.state, anchor: [place.lat, place.lon] };
  if (typeof window.qcShowSavedPlace === 'function') window.qcShowSavedPlace(hit);
}

/** QUX-09c: the layer row that draws each camera provider, and the provider's name in a status
 *  (camera-layer.js's table). A provider this table does not know is looked up in the index. */
const CAMERA_PROVIDER_LAYER = { 'caltrans-cwwp2': 'roadCameras', 'nps-webcams': 'parkCameras', 'nps-grsm': 'parkCameras', hpwren: 'linkCameras', alertwest: 'linkCameras' };
const cameraLayerFor = (providerId) => CAMERA_PROVIDER_LAYER[providerId]
  || (cameraIndex && (cameraIndex.files.find((f) => f.provider === providerId) || {}).layer) || null;

/** QUX-09c "Show" on a saved camera: switch its layer on if it is off (the reader pressed Show,
 *  so the reads are theirs), load the file(s) that can hold the camera whatever the zoom or view,
 *  then open the same pin's card -- whose own popupopen fetches the picture; nothing here requests
 *  one. Resolves to a status sentence, or '' when the card opened. Never opens a picture for a
 *  camera the operator's current list no longer has. */
async function showSavedCamera(place) {
  const providerId = String(place.ref).split(':')[1];
  const layerId = cameraLayerFor(providerId);
  const box = layerId && $(`qcm-layer-${layerId}`);
  if (!box || !map) return "Not in this site's camera lists.";
  if (!box.checked) {
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await cameraRenders[layerId];
  }
  let index;
  try { index = await loadCameraIndex(); } catch (err) { return 'The camera list did not load. Try the layer again.'; }
  // The files whose area holds the saved position; with no position to go on, every file of the layer.
  const ofLayer = index.files.filter((f) => f.layer === layerId);
  const at = Number.isFinite(place.lat) && Number.isFinite(place.lon)
    ? ofLayer.filter((f) => place.lon >= f.bbox.minLon && place.lon <= f.bbox.maxLon && place.lat >= f.bbox.minLat && place.lat <= f.bbox.maxLat) : [];
  const results = await Promise.allSettled((at.length ? at : ofLayer).map(loadCameraFile));
  const camera = findCamera(camerasOf(loadedCameraFiles(layerId)), place.ref);
  // Hold this one pin whatever the view and the cap say: the card is about to open on it.
  if (camera) syncCameraPins(layerId, cameraRef(camera));
  if (!camera) {
    return results.some((r) => r.status === 'rejected') ? 'The camera list did not load. Try the layer again.'
      : `Not in ${cameraProviderRow(providerId).operator}'s current camera list.`;
  }
  const pin = cameraPins.get(cameraRef(camera));
  if (camera.lat === null || camera.lon === null || !pin) return CAMERA_NO_LOCATION;
  const zoom = Math.max(map.getZoom(), 12);
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) map.setView([camera.lat, camera.lon], zoom, { animate: false });
  else map.flyTo([camera.lat, camera.lon], zoom);
  pin.openPopup();
  return '';
}

/** QUX-09c: located cameras from the files ALREADY LOADED, nearest first, for the layers that are
 *  on right now (a file stays cached after its layer is switched off, and that layer's pins are
 *  gone). It never turns a layer on and never fetches (spec: nothing loads until a camera is
 *  selected). A zero-length segment makes distanceToPathsMeters a plain point-to-point distance. */
window.qcCamerasNear = function (lat, lon, maxMeters) {
  const onLayers = CAMERA_LAYER_IDS.filter((id) => $(`qcm-layer-${id}`)?.checked);
  const all = onLayers.flatMap((id) => camerasOf(loadedCameraFiles(id)));
  // Files load by map area, so "none loaded near here" can mean "not read yet". Said apart: the
  // list carries `notLoaded` when an index area that reaches this place has not been read (no fetch
  // here: the cached index holds the boxes), or the index itself has not arrived for an on layer.
  const notLoaded = onLayers.length > 0 && (cameraIndex
    ? unloadedFilesNear(cameraIndex.files, new Set(cameraFiles.keys()), onLayers, lat, lon, maxMeters).length > 0
    : true);
  const near = all.filter((c) => c.lat !== null && c.lon !== null)
    .map((c) => ({ ref: cameraRef(c), name: c.name, provider: c.provider,
      meters: distanceToPathsMeters([lon, lat], [[[c.lon, c.lat], [c.lon, c.lat]]]) }))
    .filter((c) => c.meters !== null && c.meters <= maxMeters)
    .sort((a, b) => a.meters - b.meters);
  near.notLoaded = notLoaded;
  return near;
};
window.qcShowCamera = (ref) => showSavedCamera({ ref });

/** QUX-09a "Share": the same buildShareUrl a card's own Share place uses. */
function onShareSavedPlace(place) {
  return copyTextToClipboard(buildShareUrl([place.lat, place.lon])).then(() => 'Link copied')
    .catch(() => "Couldn't copy the link — select and copy it from the address bar after sharing.");
}

/** QUX-09b "Before you go": the one guarded call into quiet-corners.js's
 *  window.qcConditionsFor bridge. Absent on the standalone Field Maps page,
 *  which carries none of the three dashboard slots (or the header) to write
 *  into -- every caller below goes through this rather than the bridge
 *  itself, so there is exactly one place that knows the guard's exact text. */
function conditionsBridge(place, opts) {
  if (typeof window.qcConditionsFor === 'function') window.qcConditionsFor(place, opts);
}

/** QUX-09b "Before you go" on a saved-places row: same bridge, `ask:true`. */
function onConditionsSavedPlace(place) {
  conditionsBridge({ name: place.name, kind: place.kind, lat: place.lat, lon: place.lon }, { ask: true });
}

/** QUX-05c's Copy coordinates/Share place, QUX-09a's Save, QUX-09b's Before
 *  you go, and QUX-11b's Nearby, which sets `state.nearbyFrom` to THIS place so
 *  "Places in this view" can sort by distance from it. Nearby stays last: the
 *  places-in-view browser test reaches it as the card's last action, and
 *  before-you-go.test.mjs reaches Before you go as the fourth. `feat.id` is
 *  already a `gnis:<digits>` string, passed straight through as the ref. */
function nameCardActions(feat) {
  const { anchor } = feat;
  const coordsText = `${anchor[0].toFixed(4)}, ${anchor[1].toFixed(4)}`;
  const conditionsAvailable = typeof window.qcConditionsFor === 'function';
  const saved = savedStore.read();
  const readOnly = saved.state === 'unreadable' || saved.state === 'newer' || saved.state === 'unavailable';
  const isSaved = !readOnly && (saved.places || []).some((p) => p.ref === feat.id);
  return [
    {
      label: 'Copy coordinates',
      onActivate: () => copyTextToClipboard(coordsText).then(() => 'Coordinates copied')
        .catch(() => "Couldn't copy — select and copy the text above."),
    },
    {
      label: 'Share place',
      onActivate: () => copyTextToClipboard(buildShareUrl(anchor)).then(() => 'Link copied')
        .catch(() => "Couldn't copy the link — select and copy it from the address bar after sharing."),
    },
    {
      label: isSaved ? 'Saved — remove' : 'Save place',
      disabled: readOnly,
      disabledReason: readOnly ? statusTextFor(saved) : undefined,
      onActivate: (btn) => {
        const nowSaved = btn.textContent === 'Saved — remove';
        if (nowSaved) {
          savedStore.remove(feat.id);
          btn.textContent = 'Save place';
        } else {
          const result = savedStore.add({
            ref: feat.id, name: feat.name, kind: feat.kind,
            lat: anchor[0], lon: anchor[1], state: feat.state, county: feat.county,
          });
          if (!result.ok) return result.reason === 'already' ? 'Already saved.' : "Couldn't save that place.";
          btn.textContent = 'Saved — remove';
        }
        savedPanel?.render();
        return nowSaved ? 'Removed from saved places.' : 'Saved.';
      },
    },
    {
      label: 'Before you go',
      disabled: !conditionsAvailable,
      disabledReason: conditionsAvailable ? undefined : 'Conditions are not available on this page.',
      onActivate: () => {
        conditionsBridge({ name: feat.name, kind: feat.kind, lat: anchor[0], lon: anchor[1] }, { ask: true });
        return 'Conditions shown below the map.';
      },
    },
    {
      // QUX-11b (§2.6): the fourth of the four places `nearbyFrom` can be set
      // from -- this one also opens "Places in this view" and focuses its
      // count line, so choosing Nearby from a card takes the reader straight
      // to the sorted list rather than leaving them to find it themselves.
      label: 'Nearby',
      onActivate: () => {
        state.nearbyFrom = { id: feat.id, name: feat.name, lonLat: [anchor[1], anchor[0]] };
        const details = $('qcm-names-suppressed');
        if (details) details.open = true;
        renderNameList(placesListOn());
        $('qcm-places-count')?.focus();
        return `Nearby set to ${feat.name}. Sort "Places in this view" by nearest to see distances.`;
      },
    },
  ];
}

/** The one card builder for a GNIS name (QUX-11a §2.4 item 3), shared by the
 *  placed-label loop, the fallback marker and the search-selection path. Takes
 *  the full feature since QUX-09a's Save needs `feat.id` too. QUX-09b: this is
 *  THE ONE "card open" hook for the ask:false mismatch check -- every card a
 *  reader can see routes through here. `open` must be true only for the card
 *  this call is actually about to show (the caller's own `pin.openPopup()`):
 *  the placed-label loop builds one of these per placed marker on every
 *  render, and firing the mismatch check for all of them left the header
 *  naming whichever marker the loop happened to build last, not the one on
 *  screen. */
function nameCard(feat, kindLabel, { open = false } = {}) {
  if (open) conditionsBridge({ name: feat.name, kind: feat.kind, lat: feat.anchor[0], lon: feat.anchor[1] }, { ask: false });
  return siteCard(nameCardLines(feat.name, kindLabel, feat.county, feat.state, feat.anchor), { actions: nameCardActions(feat) });
}

/** QUX-11a §2.4 item 4 / QUX-11b: select a row from "Places in this view" --
 *  sets the same field a pin click sets, redraws (so the fresh, post-redraw
 *  pin is the one this opens, never one a redraw is about to tear down),
 *  opens its popup, and on close hands focus back to the opener row rather
 *  than wherever `identify`'s own popupclose handler (Q/preview-overlay.js:367)
 *  leaves it -- that handler is registered when the pin is created, strictly
 *  before this `once`, so Leaflet's registration-order semantics run it
 *  first (it focuses the pin) and this second (it moves focus to the row).
 *
 *  QUX-11b: takes the whole `row` (places-in-view.js's row shape), not a bare
 *  id -- a row selection is also one of the four places `nearbyFrom` is set
 *  from, and needs `row.name`/`row.lonLat` to do it; `row.source` (`'gnis'`
 *  for a name, the provider id for a rec row) says which pin map to read. */
function selectPlace(row) {
  const { id, name, lonLat, source } = row;
  state.selectedNameId = id;
  state.selectedSearchFeature = null;
  state.selectedCardOpen = true;
  if (name && Array.isArray(lonLat)) state.nearbyFrom = { id, name, lonLat };
  renderSources();
  // QQA-08: a road or trail has no pin; its card opens on the map beside the line.
  if (source === 'route' || source === 'road-name') {
    state.selectedCardOpen = false;
    openRouteCard(id, L.latLng(lonLat[1], lonLat[0]), { restoreFocus: true });
    return;
  }
  const pin = (source === 'gnis' ? namePins : recPins).get(id);
  if (!pin) return;
  pin.openPopup();
  pin.once('popupclose', () => {
    const details = $('qcm-names-suppressed');
    if (!details || !details.open) return;
    document.querySelector(`.qcm-place-row[data-place-id="${id}"]`)?.focus();
  });
}

/** QQA-09: what routeCompleteness needs to say whether a loaded route is the whole route. */
function routeContext() {
  return { fetchedFor: state.fetchedFor, truncated: state.truncatedGroups,
    coverage: { 'mvum-road': state.states.mvum, 'mvum-trail': state.states.mvum, trail: state.states.trails } };
}

/** QQA-08: the card for a forest road, a trail or a road lettered on the map -- the one a tap
 *  on the line, a choice in the chooser and a row in "Places in this view" all open, so the
 *  same feature id always shows the same title. Not bound to an overlay pin, so a redraw does
 *  not close it. `restoreFocus` hands the keyboard back to the opener row when it shuts. */
function openRouteCard(id, latlng, { restoreFocus = false } = {}) {
  const route = state.routes.find((r) => r.id === id);
  const lettered = id.startsWith(ROAD_NAME_ID_PREFIX)
    ? state.roadsPlaced.find((r) => `${ROAD_NAME_ID_PREFIX}${r.key}` === id) : null;
  const lines = route ? routeCardLines(route, routeContext()) : lettered ? roadNameCardLines(lettered) : null;
  if (!lines) return null;
  state.selectedNameId = id;
  const card = siteCard(lines);
  card.dataset.routeId = id;
  card.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); map.closePopup(); } });
  const popup = L.popup({ ...CARD_POPUP, autoPan: true }).setLatLng(latlng).setContent(card);
  popup.openOn(map);
  card.focus({ preventScroll: true });
  if (restoreFocus) {
    const onClose = (e) => {
      if (e.popup !== popup) return;
      map.off('popupclose', onClose);
      const details = $('qcm-names-suppressed');
      if (details && details.open) document.querySelector(`.qcm-place-row[data-place-id="${id}"]`)?.focus();
    };
    map.on('popupclose', onClose);
  }
  return popup;
}

/** QQA-08: two or more routes within tolerance of one tap -- a small list to choose from,
 *  never a silent pick. Each choice opens the same card the line's own tap would. */
function openRouteChooser(hits, latlng) {
  const box = document.createElement('div');
  box.className = 'qcm-route-chooser';
  box.tabIndex = -1;
  box.setAttribute('role', 'group');
  const heading = `${hits.length} roads and trails here. Choose one.`;
  box.setAttribute('aria-label', heading);
  const h = document.createElement('p');
  h.className = 'qcm-site-card-name';
  h.textContent = heading;
  const ul = document.createElement('ul');
  for (const { route } of hits) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'qcm-route-choice';
    b.dataset.routeId = route.id;
    b.textContent = `${routeName(route)} — ${route.kindLabel}`;
    b.addEventListener('click', () => openRouteCard(route.id, latlng));
    li.append(b); ul.append(li);
  }
  box.append(h, ul);
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); map.closePopup(); } });
  L.popup({ ...CARD_POPUP, autoPan: true }).setLatLng(latlng).setContent(box).openOn(map);
  ul.querySelector('button')?.focus({ preventScroll: true });
}

/** QQA-08: the drawn forest roads and trails within a finger's width of a click or tap (12 CSS
 *  px for touch and pen, 6 for a mouse), nearest first. The print-area cells and the sheets sit
 *  under the lines and answer a click of their own (extend, add, remove), so they ask this first
 *  and stand down when a road or trail is what the reader pointed at. */
function routesNear(e) {
  if (drawing || !state.routes.length || !e.containerPoint) return [];
  return hitRoutes(state.routes, e.containerPoint, {
    toPx: (ll) => map.latLngToContainerPoint(ll),
    tolerancePx: toleranceFor(e.originalEvent && e.originalEvent.pointerType),
  });
}

/** QQA-08: a click or tap on the map. One road or trail near it opens its card; two or more
 *  open the chooser, never a silent pick. (Leaflet hands a map-level listener the map as
 *  `sourceTarget` for a DOM click, so what was under the pointer is found by distance, not by
 *  target.) */
function onMapIdentify(e) {
  const hits = routesNear(e);
  if (hits.length === 1) openRouteCard(hits[0].route.id, e.latlng);
  else if (hits.length > 1) openRouteChooser(hits, e.latlng);
}

/** "Places in this view" (QUX-11a): every GNIS name already fetched whose
 *  point is in the current bounds, labelled or not -- independent of the
 *  declutter cap above, and never silently empty for a status that is not a
 *  real answer. Always recomputes the summary/report/filter counts (cheap:
 *  at most 1500 names); builds row DOM only while the list is open, so a pan
 *  with the list shut costs no DOM work. */
function renderNameList(on) {
  const fieldset = document.querySelector('.qcm-names');
  const report = $('qcm-names-report'), details = $('qcm-names-suppressed'), ul = $('qcm-names-list');
  const groupsHost = $('qcm-places-filter-groups'), onlyBox = $('qcm-places-only-unlabelled'), countEl = $('qcm-places-count');
  const sortSelect = $('qcm-places-sort'), nearbyOption = $('qcm-places-sort-nearby'), nearbyCaption = $('qcm-places-nearby-caption');
  if (!fieldset || !report || !details || !ul) return;
  const namesStatus = state.names?.status ?? null;
  // N3: the names row opens on, so this fieldset would otherwise sit under the
  // layer list on every fresh load carrying only "have not loaded yet". It
  // appears with the first answer for this view -- a names status, or a rec
  // provider's -- and the row's own badge covers the loading state until then.
  const recAnswered = (st) => st != null && st !== 'unchecked';
  const answered = namesStatus != null || recAnswered(state.states.recSites) || recAnswered(state.states.blmRecSites)
    || state.routes.length > 0 || state.roadsPlaced.length > 0;
  fieldset.hidden = !on || !answered;
  if (fieldset.hidden) return;

  // Correction (dispatcher, post-review): §0/§2's "no town-label dedupe" was
  // true only at the plan's own baseline SHA -- PR #600 (not yet merged) gives
  // window.qcTownLabels a real writer, so this list reads through the SAME
  // dedupeAgainstTownLabels gate renderNames' declutter loop already reads
  // through (main.js ~1712-1713), not the raw fetch answer. placesInView
  // itself stays pure: it is handed the already-deduped array and never reads
  // window itself.
  const townLabels = (typeof window !== 'undefined' && Array.isArray(window.qcTownLabels)) ? window.qcTownLabels : [];
  const deduped = dedupeAgainstTownLabels(state.names?.features || [], townLabels);
  const b = map.getBounds();
  const bounds = { minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth() };
  const placedIds = new Set((state.namesPlaced || []).map((p) => p.id));
  const result = placesInView({
    names: deduped, namesStatus, placedIds, bounds,
    filters: placeFilters, selectedId: state.selectedNameId,
    // QUX-11b: passed unconditionally, not gated on which rec layer is on --
    // the rec pin loop (renderOverlay, below) already draws all of
    // state.recSites regardless of which single provider switch is ticked
    // (only the OR of both gates it at all), so this list stays consistent
    // with what the map itself shows.
    recSites: state.recSites,
    recStates: { recSites: state.states.recSites, blmRecSites: state.states.blmRecSites },
    nearbyFrom: state.nearbyFrom,
    routes: state.routes, roadNames: state.roadsPlaced,
  });

  const notices = state.streamsNote ? [...result.notices, state.streamsNote] : result.notices;
  if (notices.length) { report.hidden = false; report.textContent = notices.join(' '); }
  else { report.hidden = true; report.textContent = ''; }

  const summary = details.querySelector('summary');
  if (summary) summary.textContent = placesSummaryText(result, namesStatus);

  if (groupsHost) {
    groupsHost.replaceChildren(...PLACE_GROUPS.map((g) => {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = placeFilters.groups.has(g.id);
      cb.addEventListener('change', () => {
        if (cb.checked) placeFilters.groups.add(g.id); else placeFilters.groups.delete(g.id);
        renderNameList(placesListOn());
      });
      label.append(cb, document.createTextNode(` ${g.label} (${result.groupCounts[g.id]})`));
      return label;
    }));
  }
  if (onlyBox) onlyBox.checked = placeFilters.onlyNotLabelled;
  if (countEl) {
    let text = result.total == null ? '' : `Showing ${result.shown} of ${result.total} places in this view.`;
    if (result.hiddenByFilters > 0) text += ` ${result.hiddenByFilters} ${result.hiddenByFilters === 1 ? 'is' : 'are'} hidden by the filters above.`;
    countEl.textContent = text;
  }

  // QUX-11b (§2.6 "Nearby"): the second sort option stays disabled, and its
  // label plain "Nearest to", until nearbyFrom is set by a row selection, a
  // GNIS or rec pin click, or a card's Nearby action (chooseName/chooseFeat/
  // chooseSite/selectPlace/nameCardActions, above). The caption -- distance is
  // straight-line and only over places already loaded for this view, never a
  // route -- shows only while the list is actually sorted that way, the same
  // condition places-in-view.js gates its own per-row distanceMeters on.
  const nearbySortActive = placeFilters.sort === 'nearby' && !!state.nearbyFrom;
  if (nearbyOption) {
    nearbyOption.disabled = !state.nearbyFrom;
    nearbyOption.textContent = state.nearbyFrom ? `Nearest to ${state.nearbyFrom.name}` : 'Nearest to';
  }
  if (sortSelect) sortSelect.value = placeFilters.sort;
  if (nearbyCaption) {
    nearbyCaption.hidden = !nearbySortActive;
    nearbyCaption.textContent = nearbySortActive
      ? `Straight-line distance from ${state.nearbyFrom.name}: not a route, a trail or an entrance, and only places already loaded for this view.`
      : '';
  }

  details.hidden = !result.total;
  if (!details.open) return;
  // QQA-08: the road rows land late (the road names arrive after the list first draws), so the
  // list is rebuilt under a reader who has already tabbed to a row. Put the keyboard back.
  const heldId = ul.contains(document.activeElement) ? document.activeElement.dataset?.placeId : null;
  ul.replaceChildren(...result.rows.map((row) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'qcm-place-row';
    button.dataset.placeId = row.id;
    if (row.selected) button.setAttribute('aria-current', 'true');
    const name = document.createElement('span');
    name.textContent = row.name;
    const meta = document.createElement('span');
    meta.className = 'qcm-place-row-meta';
    meta.textContent = ` ${row.kindText}${row.state ? `, ${row.state}` : ''}${row.onMap ? '' : ' — not labelled on the map'}${row.distanceText ? ` — ${row.distanceText}` : ''}`;
    button.append(name, meta);
    button.addEventListener('click', () => selectPlace(row));
    li.append(button);
    return li;
  }));
  if (heldId) ul.querySelector(`.qcm-place-row[data-place-id="${CSS.escape(heldId)}"]`)?.focus({ preventScroll: true });
}

/** The `<summary>` text (§2.2's Summary column). `total == null` covers both
 *  "not fetched yet" and a refusal (timeout/error) -- neither is a
 *  count the reader should read as zero. */
function placesSummaryText({ total, notLabelled }, namesStatus) {
  if (total == null) return 'Places in this view';
  if (total === 0) return 'Places in this view (0)';
  if (namesStatus === 'partial') return `Places in this view (${total}; none labelled)`;
  return `Places in this view (${total}; ${notLabelled} not labelled on the map)`;
}

function renderLegend() {
  const ul = $('qcm-legend'); if (!ul) return;
  // Screen-only switches change no recipe, so `state.recipe.layers` is one switch behind them
  // (see the count line above): the key reads those from the controls themselves.
  const fromControls = layersFromControls();
  const layers = { ...(state.recipe ? state.recipe.layers : controls().layers),
    ...Object.fromEntries(LAYERS.filter((l) => l.screenOnly).map((l) => [l.id, fromControls[l.id]])) };
  // The SCREEN key: the marks on the map in front of the reader, in that order,
  // with the ones that need a closer zoom named as such. The grid and the sheet
  // seams stay on the printed key, where they are the only place they exist.
  const rows = legendRows({
    layers, grid: checked('qcm-grid'), rendered: renderedKeys(),
    layerStates: state.states, states: state.areaStates,
    medium: 'screen', zoom: map.getZoom(), base: currentBase(),
    screenScale: screenScaleDenominator(map.getZoom(), map.getCenter().lat),
  });
  ul.replaceChildren(...rows.map((row) => {
    const li = document.createElement('li');
    li.dataset.state = row.state;
    const swatch = document.createElement('span');
    swatch.className = 'qcm-legend-swatch';
    swatch.innerHTML = row.svg; // frozen constants only; see legend-view.js
    // D1: the key dims/spotlights exactly like the drawn shapes, from the same
    // displayStyle math (swatchStyle) and the same symbol-key -> layer-id lookup
    // renderOverlay uses -- one source of truth for what "highlighted" looks like.
    const style = swatchStyle(row.key, currentDisplay, { layerId: SYMBOL_KEY_TO_LAYER_ID[row.key] || row.key });
    swatch.style.opacity = String(style.opacity ?? 1);
    const label = document.createElement('span');
    label.textContent = row.text;
    li.append(swatch, label);
    return li;
  }));
}

/** Ask every switched-on source what it has for one box.
 *
 *  `bboxLonLat` makes this answerable for the VIEWPORT and not only for the print
 *  recipe, which is what browsing needs: no area has to be drawn first, the status
 *  line is left alone, and the Check button never greys out under the reader's
 *  cursor. The box that was asked is recorded in `state.fetchedFor` so a build can
 *  never hand the PDF an answer fetched for somewhere else. */
async function sourcePass({ bboxLonLat = null, browse = false } = {}) {
  // Clear (and any new setBbox) bumps state.areaGeneration; a pass whose box has
  // since been replaced or removed must stop writing rather than repopulate state
  // Clear just emptied. Checked after every await below, alongside the existing
  // namesGeneration guard where one already exists.
  const myGeneration = state.areaGeneration;
  const stale = () => isStaleGeneration(myGeneration, state.areaGeneration);
  const { plan, recipe } = state;
  const box = bboxLonLat || recipe?.bboxLonLat;
  if (!box || (!browse && !plan)) return;
  // One controller per pass: setArea/clearArea abort it, so the requests of a pass whose area has
  // been replaced are cancelled at the network instead of finishing for nothing.
  const ctrl = new AbortController(), signal = ctrl.signal;
  state.passAbort = ctrl;
  const layers = bboxLonLat ? layersFromControls() : recipe.layers;
  // The base map's answer is a question about the SHEET — which tile level the
  // scale picks — so browsing must not throw it away and must not re-ask it. Read
  // before the clear, or a pan would silently demote a ready base map to
  // 'not checked yet' and put the Check-sources sentence back under the button.
  let topo = state.states.usgsTopo;
  if (!browse) { $('qcm-check').disabled = true; say('Checking sources…'); resetSources(); } else clearFetched();
  if (!browse) {
    // An unreachable server, a timeout and an HTTP error all read as "unavailable". So does a
    // plan with no tile to ask for: a throw here would leave Check sources disabled for good.
    let url = null;
    try { url = tilePlan(plan).tiles.unique[0].url; } catch { /* no tile is "unavailable" */ }
    const ok = url !== null && (await fetchWithDeadline(url, {
      signal, timeoutMs: SOURCES.usgsTopo.timeoutMs, read: async () => null,
    })).ok;
    if (stale()) return;
    topo = ok ? 'ready' : 'unavailable';
  }
  // Which states the area covers, from the quad index this page already uses.
  // A failure here costs the state land layers, never the base map.
  try { state.areaStates = statesForCells((await fetchCellsForBbox({ bboxLonLat: box, signal })).cells); }
  catch { if (stale()) return; state.areaStates = []; }
  if (stale()) return;
  renderLayerControls();
  state.states.usgsTopo = topo;
  state.counts.usgsTopo = null;   // a raster base has no feature count to report
  if (layers.mvum) {
    try {
      const [roads, trails] = await Promise.all(['roads', 'trails'].map((layer) => fetchLayer({ layer, bboxLonLat: box, signal })));
      if (stale()) return;
      state.mvum = { roads, trails };
      state.counts.mvum = roads.features.length + trails.features.length;
      // Road quality is detail, not a gate: if the inventory is down the roads still
      // print, at their plain width. Never let it fail the source check.
      try { state.roadQuality = await fetchRoadQuality({ bboxLonLat: box, signal }); }
      catch { if (stale()) return; state.roadQuality = {}; }
      const cov = [roads.coverage, trails.coverage];
      state.states.mvum = cov.every((c) => c === 'complete') ? 'ready' : cov.includes('unavailable') ? 'unavailable' : cov.includes('unknown') ? 'unknown' : 'partial';
    } catch (err) { if (stale()) return; state.states.mvum = 'unknown'; fail(err); }
  }
  if (stale()) return;
  if (layers.recSites) {
    // The adapter pages and says whether it finished; this used to write 'ready'
    // whenever the fetch did not throw, so a box past the transfer limit printed a
    // sheet missing sites while the source panel called the layer ready (F14).
    try {
      const answer = await fetchRecSites({ bboxLonLat: box, signal });
      if (stale()) return;
      state.recSites = answer.sites;
      state.states.recSites = answer.coverage === 'complete' ? 'ready' : 'partial';
    } catch { if (stale()) return; state.recSites = []; state.states.recSites = 'unavailable'; }
    state.counts.recSites = state.recSites.length;
  }
  if (stale()) return;
  // BLM sites join the SAME mark list as the Forest Service ones, as the four federal
  // designation families share `state.land`: downstream both are a point with a symbol.
  if (layers.blmRecSites) {
    try {
      const answer = await fetchBlmRecSites({ bboxLonLat: box, signal });
      if (stale()) return;
      state.recSites.push(...answer.sites);
      state.counts.blmRecSites = answer.sites.length;
      state.states.blmRecSites = answer.coverage === 'complete' ? 'ready' : 'partial';
    } catch { if (stale()) return; state.counts.blmRecSites = 0; state.states.blmRecSites = 'unavailable'; }
  }
  if (stale()) return;
  if (layers.trails) {
    try {
      const result = await fetchTrails({ bboxLonLat: box, signal });
      if (stale()) return;
      state.trails = result;
      state.counts.trails = state.trails.features.length;
      state.states.trails = state.trails.coverage === 'complete' ? 'ready' : 'partial';
    } catch (err) { if (stale()) return; state.states.trails = 'unavailable'; fail(err); }
  }
  if (stale()) return;
  // Federal designations. One national service, so no per-state fan-out: the four
  // families are asked in parallel and the worst answer wins, exactly as the state
  // land loop below does. They share `state.land` because they are the same kind
  // of thing to everything downstream -- a boundary with a symbolKey.
  if (layers.federalLand) {
    let count = 0, worst = null;
    const answers = await Promise.allSettled(FEDERAL_IDS.map(
      (family) => fetchFederalLand({ family, bboxLonLat: box, signal })));
    if (stale()) return;
    for (const a of answers) {
      if (a.status === 'rejected') { worst = 'unavailable'; fail(a.reason); continue; }
      state.land.push(...a.value.features);
      count += a.value.features.length;
      if (a.value.coverage !== 'complete' && worst !== 'unavailable') worst = 'partial';
    }
    state.counts.federalLand = count;
    state.states.federalLand = worst || 'ready';
  }
  if (stale()) return;
  // County lines ride the same channel: one national service, boundaries with a
  // symbolKey, pushed into `state.land` because that is what everything downstream
  // means by "a boundary to stroke". Zero features is NOT "no counties here" -- the
  // registry says emptyMeans 'unknown' for exactly that reason.
  if (layers.countyLines) {
    try {
      const answer = await fetchCountyLines({ bboxLonLat: box, signal });
      if (stale()) return;
      state.land.push(...answer.features);
      state.counts.countyLines = answer.features.length;
      state.states.countyLines = answer.coverage === 'complete' ? 'ready' : 'partial';
    } catch (err) { if (stale()) return; state.states.countyLines = 'unavailable'; fail(err); }
  }
  if (stale()) return;
  // Surface ownership rides the same channel: boundaries with a symbolKey, into
  // `state.land`. 'partial' is refused by canBuild, so a truncated parcel set
  // never prints as though it were the whole forest.
  if (recipe.layers.surfaceOwnership) {
    try {
      const answer = await fetchSurfaceOwnership({ bboxLonLat: recipe.bboxLonLat, signal });
      if (stale()) return;
      state.land.push(...answer.features);
      state.counts.surfaceOwnership = answer.features.length;
      state.states.surfaceOwnership = answer.coverage === 'complete' ? 'ready' : 'partial';
    } catch (err) { if (stale()) return; state.states.surfaceOwnership = 'unavailable'; fail(err); }
  }
  if (stale()) return;
  // Wetlands ride the same channel -- shapes with a symbolKey, into `state.land`.
  // What is different is the REFUSAL: the adapter asks for a count first and declines
  // an extent past its budget, because asking anyway would take minutes and time out
  // rather than fail. A refusal is reported as unavailable, so canBuild blocks the
  // sheet instead of printing a map with the wetlands quietly missing, and the
  // adapter's own sentence (which distinguishes "mapped, none here" from "never
  // mapped") is kept for the layer's row.
  if (layers.wetlands) {
    try {
      const answer = await fetchWetlands({ bboxLonLat: box, signal });
      if (stale()) return;
      state.land.push(...answer.features);
      state.counts.wetlands = answer.features.length;
      state.reports.wetlands = answer.report.text;
      state.states.wetlands = answer.refused ? 'unavailable'
        : answer.coverage === 'complete' ? 'ready' : 'partial';
    } catch (err) { if (stale()) return; state.states.wetlands = 'unavailable'; fail(err); }
  }
  if (stale()) return;
  // Named terrain & places (GNIS). A browse pass skips them: runNames asks for the view on its own
  // per-view pass. Print and Check still ask for the print box, through the same budgeted fetch.
  if (layers.names && !browse) {
    const token = ++state.namesGeneration;
    try {
      const result = await fetchNamesFor(box, PRINT_NAMES_ZOOM, signal);
      if (isStaleGeneration(token, state.namesGeneration) || stale()) { /* superseded; drop it */ } else {
        applyNamesResult(result, box);
        namesFetched = null;   // the held view answer is gone; the next move asks the view again
        namesDebounce.cancel();   // and the view pass the row toggle armed is answered: one fetch, not two
      }
    } catch (err) {
      if (!isStaleGeneration(token, state.namesGeneration) && !stale()) { state.states.names = 'unavailable'; fail(err); }
    }
  }
  if (stale()) return;
  // A box on a state line covers two states, and both are asked. The worst
  // answer wins: one state timing out must not read as a complete set.
  for (const family of Object.keys(FAMILY_SYMBOL)) {
    if (!layers[family]) continue;
    const codes = statesWithFamily(state.areaStates, family);
    if (!codes.length) continue;                // no state here publishes it
    let count = 0, worst = null;
    for (const code of codes) {
      try {
        const r = await fetchLandBoundaries({ state: code, family, bboxLonLat: box, signal });
        if (stale()) return;
        state.land.push(...r.features);
        count += r.features.length;
        // 'partial' is a real answer, not a near-miss: the service had more to give
        // and stopped. canBuild refuses it, so a truncated boundary set never prints.
        if (r.skipped) worst = 'unavailable';
        else if (r.coverage !== 'complete' && worst !== 'unavailable') worst = 'partial';
      } catch (err) { if (stale()) return; worst = 'unavailable'; fail(err); }
    }
    state.counts[family] = count;
    state.states[family] = worst || 'ready';
  }
  if (stale()) return;
  state.fetchedFor = { ...box };
  if (!browse) $('qcm-check').disabled = false;
  renderSources();
  if (!browse) say('Source check finished.');
}

// Browsing the map is its own question, asked once the map stops moving. F11: a
// reader who ticks "Trails" and pans should see trails, not a Check sources button
// -- and the debounce is what keeps a drag from firing a query per frame.
let settle = null;
function browseViewport() {
  if (terrainPanelOpen) return; // E1: pause hidden 2D work while the terrain panel is open
  clearTimeout(settle);
  settle = setTimeout(() => {
    const b = map.getBounds();
    const plan = viewportFetchPlan({
      bboxLonLat: { minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth() },
      zoom: map.getZoom(), layers: layersFromControls(),
      states: state.states, areaStates: state.areaStates, fetchedFor: state.fetchedFor,
    });
    if (plan.layers.length) checkSources({ bboxLonLat: plan.bboxLonLat, browse: true });
    // A view that cannot be served is told so. 'none-on' and 'held' are not
    // refusals worth a sentence: nothing was asked for, or it is already drawn.
    else if (plan.code === 'zoom' || plan.code === 'area') say(plan.reason);
  }, VIEWPORT_FETCH.settleMs);
}

// Every writer of the source state -- the Check button, a build's re-ask, the
// viewport browse, a row's Retry -- goes through ONE queue, so no two passes
// ever write it side by side. A browse that comes due mid-pass is dropped and
// planned again once the queue is idle (sourcePassQueue in app-state.js).
const sourcePasses = sourcePassQueue(
  (opts) => (opts.retry ? retryPass(opts.retry) : sourcePass(opts)),
  () => browseViewport());
const checkSources = (opts = {}) => sourcePasses(opts);
const retryLayer = (id) => sourcePasses({ retry: id });

const busy = (on) => { $('qcm-build').disabled = on; $('qcm-check').disabled = on; $('qcm-cancel').hidden = !on; $('qcm-progress').hidden = !on; if (on) $('qcm-download').hidden = true; };

async function build() {
  // `state.fetchedFor` is the whole safety of viewport browsing: the sources in
  // hand may have been fetched for a view the reader has since left, and the PDF
  // must only ever draw the area it says it drew. Any mismatch re-asks.
  const stale = !sourcesMatchArea(state.fetchedFor, state.recipe.bboxLonLat);
  // Names are fetched for the view: they are reused for the print only when `state.namesFor` is this
  // exact print bbox (printStates); otherwise checkSources below re-fetches them for the print bounds.
  if (stale || state.states.usgsTopo === 'unchecked' || (state.recipe.layers.mvum && state.states.mvum === 'unchecked')
    || (state.recipe.layers.names && printStates().names === 'unchecked')) await checkSources();
  const gate = canBuild({ states: printStates(), layers: state.recipe.layers, areaStates: state.areaStates });
  if (!gate.ok) { say(gate.reason); return; }
  const ctrl = new AbortController(), progress = $('qcm-progress');
  state.abort = ctrl; busy(true);
  try {
    const { pdfBytes, stats } = await runBuild({
      recipe: state.recipe, plan: state.plan, PDFLib, signal: ctrl.signal,
      adapters: {
        fetchImpl: globalThis.fetch.bind(globalThis), createImageBitmap: (b) => createImageBitmap(b),
        mvum: state.mvum, roadQuality: state.roadQuality,
        trails: state.trails, land: state.land, sites: state.recSites,
        names: state.recipe.layers.names ? namesAdapterPayload(state.names, state.namesRetrievedAt) : null,
      },
      workerFactory: () => new Worker(new URL('./print-renderer.worker.js', import.meta.url), { type: 'module' }),
      onProgress: ({ text, a, b }) => { say(text); if (b) { progress.max = b; progress.value = a; } else progress.removeAttribute('value'); },
    });
    const url = URL.createObjectURL(new Blob([pdfBytes], { type: 'application/pdf' })), a = $('qcm-download');
    a.href = url; a.download = `${sanitizeFilename(state.recipe.title)}.pdf`; a.dataset.stats = JSON.stringify(stats); a.hidden = false; a.click();
    say(`PDF ready: ${stats.sheets} sheets from ${stats.tileCount} tiles at level ${stats.level}, ${mb(stats.bytes)} MB in ${Math.round(stats.ms / 1000)} s. Print at Actual size / 100%.`);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) { fail(err); } finally { busy(false); state.abort = null; renderSources(); }
}

// Latest wins: a slower answer to an earlier name must not replace the list for the name typed since.
// The earlier request is cancelled the moment the next search begins, and the status says so at once.
const quadSearch = createLatest();
async function findQuad() {
  const ul = $('qcm-quad-results'); ul.replaceChildren(); ul.hidden = true;
  say('Searching…');
  const name = $('qcm-quad-name').value;
  const { stale, value: r } = await quadSearch.run((signal) => searchByName({ name, signal }));
  if (stale) return;
  if (!r.ok) { say(r.error); return; }
  if (!r.cells.length) { say('No quadrangle matches that name.'); return; }
  for (const c of r.cells) {
    const li = document.createElement('li'), pick = () => { ul.hidden = true; quadPicked(cellId(c.cell), c.name); };
    li.setAttribute('role', 'option'); li.tabIndex = 0; li.textContent = `${c.name} (${c.states.join(', ')})`;
    li.addEventListener('click', pick); li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    ul.append(li);
  }
  ul.hidden = false; say(`${r.cells.length} matching quadrangles; choose one.`);
}

function toggleDraw(on) {
  drawing = on; $('qcm-draw').setAttribute('aria-pressed', String(on)); map.dragging[on ? 'disable' : 'enable'](); map.getContainer().style.cursor = on ? 'crosshair' : '';
  if (on) { cells.clearLayers(); say('Press and drag on the map to draw the area, or type its corners below.'); }
}
$('qcm-draw').addEventListener('click', () => toggleDraw(!drawing));
$('qcm-use-example').addEventListener('click', () => setBbox(EXAMPLE_AREA.bboxLonLat, { title: EXAMPLE_AREA.label, fit: true }));
$('qcm-area-clear').addEventListener('click', clearArea);
$('qcm-area-undo').addEventListener('click', undoArea);
$('qcm-area-edit').addEventListener('click', () => toggleDraw(true));
$('qcm-quad').addEventListener('click', findQuad);
$('qcm-quad-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') findQuad(); });
$('qcm-check').addEventListener('click', () => checkSources());
$('qcm-build').addEventListener('click', build);
$('qcm-cancel').addEventListener('click', () => state.abort?.abort());
$('qcm-layer-search')?.addEventListener('input', applyLayerFilter);
$('qcm-layers-active-only')?.addEventListener('change', applyLayerFilter);
// QUX-11a §2.3: the static filter controls (the per-group checkboxes are
// rebuilt each render, above, and wire themselves as they're created).
$('qcm-places-only-unlabelled')?.addEventListener('change', () => {
  placeFilters.onlyNotLabelled = $('qcm-places-only-unlabelled').checked;
  renderNameList(placesListOn());
});
$('qcm-places-show-all')?.addEventListener('click', () => { placeFilters = defaultFilters(); renderNameList(placesListOn()); });
// QUX-11b (§2.6 "Nearby"): the option itself stays disabled until nearbyFrom
// is set (renderNameList, above), so a browser refusing the change event on a
// disabled <option> is the only guard this needs.
$('qcm-places-sort')?.addEventListener('change', (e) => {
  placeFilters.sort = e.target.value;
  renderNameList(placesListOn());
});
// A pan alone only calls renderNameList (:1520-ish, moveend listener above);
// opening the <details> after that needs its own recompute so the just-shown
// list is never stale row DOM from before it was opened.
$('qcm-names-suppressed')?.addEventListener('toggle', () => renderNameList(placesListOn()));
for (const k of Object.keys(CORNERS)) $(`qcm-${k}`).addEventListener('change', () => {
  const v = Object.fromEntries(Object.entries(CORNERS).map(([id, n]) => [n, Number($(`qcm-${id}`).value)]));
  if (Object.values(v).every(Number.isFinite)) setBbox(v);
});
// Radios answer by group name, selects by id; a control this table does not name
// (the title) feeds no source at all, so it invalidates nothing.
const CONTROL_KEY = { 'qcm-scale': 'scale', 'qcm-dpi': 'dpi', 'qcm-orientation': 'orientation', 'qcm-overlap': 'overlapIn', 'qcm-grid': 'grid' };
for (const el of document.querySelectorAll('.qcm-controls select, .qcm-controls input[type="radio"], .qcm-controls input[type="checkbox"], #qcm-title')) {
  el.addEventListener('change', () => {
    const key = CONTROL_KEY[el.name] || CONTROL_KEY[el.id];
    invalidate(key ? { [key]: el.value } : {});
    replan();
  });
}

// One sheet of paper, once per printer: the scale error and the unprintable margin
// are the only two things the zero-paper CI proof cannot settle. No route and no
// link — the flag is the whole entry point.
const calibrationUrl = createUrlSlot();
async function offerCalibrationSheet() {
  const bytes = await createCalibrationPdf({ PDFLib }), a = $('qcm-calibration-download');
  a.href = calibrationUrl.set(new Blob([bytes], { type: 'application/pdf' }));
  a.hidden = false;
  say('Calibration sheet ready. Print ONE copy at Actual size / 100% with Fit and Shrink off, then read the instructions on the sheet.');
}
$('qcm-calibrate').addEventListener('click', () => { offerCalibrationSheet().catch(fail); });

// The key on its own sheet: what the chosen layers CAN draw, before any sheet of
// the set is spent. Same layer choice and grid the on-page key reads, so the two
// cannot disagree; its own anchor, so it never takes the map PDF's.
const keySheetUrl = createUrlSlot();
async function offerKeySheet() {
  const layers = state.recipe ? state.recipe.layers : controls().layers;
  const bytes = await createKeySheetPdf({ PDFLib, layers, grid: checked('qcm-grid'), states: state.areaStates });
  const a = $('qcm-key-sheet-download');
  a.href = keySheetUrl.set(new Blob([bytes], { type: 'application/pdf' })); a.download = 'field-maps-key.pdf';
  a.hidden = false;
  say('Map key ready: every symbol the chosen layers can draw, with the notices they oblige. Print at Actual size / 100%.');
}
$('qcm-key-sheet').addEventListener('click', () => { offerKeySheet().catch(fail); });

(async function start() {
  // Each await below gets its stage in window.qcRestoreStage first, so a restore wait
  // that runs out (readyDashboard, scripts/qcm/helpers/waits.mjs) names the
  // await it stalled in rather than only that the flag never came.
  window.qcRestoreStage = 'waiting for the dashboard map (qc:map-ready)';
  attach(await hostMap());
  savedPanel = mountSavedPlaces({ store: savedStore, onShow: onShowSavedPlace, onShare: onShareSavedPlace, onConditions: onConditionsSavedPlace });
  // The calibration sheet is an EXTRA, never a mode: an early return here skipped the
  // whole builder, so ?calibrate=1 left the page able to do nothing but calibrate.
  if (query.get('calibrate') === '1') offerCalibrationSheet().catch(fail);
  // renderPresets() builds the preview paragraphs before the layer/base/context controls
  // exist, so its own initial fill reads registry defaults; refresh once more now that
  // renderLayerControls() has built the real switches.
  renderPresets(); renderLayerControls(); renderSources(); refreshPresetPreviews();
  // B1 view-state wiring: quiet-corners.js resolves the reader's initial view
  // (link fragment / legacy query / saved display prefs) before this DOM even
  // exists, and stashes it here since it has no controls of its own for base/
  // surface/overlays. Applied once, silently -- a page load is not a preset.
  if (window.qcInitialView) applyPreset(viewToPresetShape(window.qcInitialView), { silent: true });
  const handoff = parseUrlRecipe(location.search);
  if (query.get('fixture') === 'standing-indian') {
    setBbox(EXAMPLE_AREA.bboxLonLat, { title: EXAMPLE_AREA.label, fit: true }); say(`Fixture mode: ${EXAMPLE_AREA.label}.`);
  } else if (handoff) {
    setBbox(handoff.bboxLonLat, { title: handoff.label || 'Field maps', fit: true }); say('Proposed area from the county finder — confirm or adjust before building.');
  } else {
    const generation = state.areaGeneration;
    window.qcRestoreStage = 'reading the saved job from IndexedDB';
    const r = await store.loadRecipe();
    // The read above lands after the map is up, so a reader may already have chosen an
    // area on this load; that choice is the job now, and last session's must not replace it.
    // Clearing is a choice too: setArea and clearArea both advance areaGeneration, so a
    // reader who chose and then cleared (state.area is null again) still outranks the read.
    if (!r || state.area || state.areaGeneration !== generation) return;
    $('qcm-scale').value = r.scale; $('qcm-overlap').value = r.overlapIn;
    for (const [name, v] of [['qcm-orientation', r.orientation], ['qcm-dpi', r.dpi]]) document.querySelector(`input[name="${name}"][value="${v}"]`).checked = true;
    // Prefer the box the area was chosen from: rebuilding it from the sheet grid's UTM
    // ring returns the extent grown to whole sheets, so each restore enlarged the area.
    // R1: a v2 recipe's `quads` must restore as quads, not the box a bare setBbox would
    // silently print as -- that's the "restore prints the whole envelope" trap (§9 R1).
    if (r.quads) {
      setArea(areaFromQuads(r.quads), { title: r.title, fit: true });
    } else {
      setBbox(r.bboxLonLat ?? bboxOfCells(ring(r.extent, r.zone, r.hemisphere)), { title: r.title, fit: true });
    }
    say(r.bboxLonLat || r.quads ? 'Restored your last area.' : 'Restored your last area; the box is rebuilt from the saved sheet extent.');
  }
}()).catch(fail)
  // The restore (or the fixture or hand-off area) and the save it set off have both
  // landed, or failed. readyDashboard (scripts/qcm/helpers/waits.mjs) waits on this flag,
  // so a proof that writes IndexedDB next is never overwritten by that save.
  .then(() => { window.qcRestoreStage = 'waiting for the last recipe save to land in IndexedDB'; return Promise.allSettled([lastSave]); })
  .then(() => { window.qcRestoreStage = 'settled'; window.qcRestoreSettled = true; });
