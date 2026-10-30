// What layers the map can draw, as data. Pure: no DOM, no network.
//
// Kept OUT of source-registry.js on purpose: that file is the record of MEASURED
// services (every value carries a `measuredOn`). A layer is not a service --
// several layers can come from one service, and a layer entry is a product
// decision, not a measurement.
//
// Before this, the layer set was two hand-written checkboxes in the template and
// three places in code that named `usgsTopo` and `mvum` literally. They had
// already drifted: DEFAULTS.layers said mvum was on, the HTML shipped it
// unchecked, and only an explicit `layers` object from main.js hid it. Adding a
// third layer meant editing all four. Now it is one entry here.
import { SYMBOLS, SYMBOL_BY_KEY } from './legend.js';
import { FAMILY_SYMBOL, usableFamilies, stateList } from './source-land-boundaries.js';
import { LAYER_LABEL as GBIF_LABEL, LAYER_CAVEAT as GBIF_CAVEAT } from './source-gbif.js';
import { LAYER_LABEL as BLM_LABEL, LAYER_CAVEAT as BLM_CAVEAT } from './source-blm-rec-sites.js';
import { LAND_COVER_LABEL, LAND_COVER_CAVEAT, CANOPY_LABEL, CANOPY_CAVEAT } from './source-land-cover.js';
// The one layer whose words are imported, not written here: the Bortle gate holds every
// string it shows a reader, and a copy of the label here is what a later edit would change.
import { LAYER_LABEL as RADAR_LABEL, LAYER_CAVEAT as RADAR_CAVEAT } from './source-nws-radar.js';
// D1 appends D2's row below; it is deliberately not built here (source-hillshade.js's own
// header: "the unit that wires the reader appends this row" -- the layers-reach-paper guard).
import { CONTEXT_ROW as HILLSHADE_ROW } from './source-hillshade.js';
import { CONTEXT_ROW as CONTOURS_ROW } from './source-contours.js';
import { CONTEXT_ROW as SNOW_DEPTH_ROW } from './source-snow-depth.js';
import { CONTEXT_ROW as AVALANCHE_ROW } from './source-avalanche.js';
import { CONTEXT_ROW as GAUGES_ROW } from './source-stream-gauges.js';
import { CONTEXT_ROW as STATIONS_ROW } from './source-nws-observations.js';
// Screen-only CHECKBOXES in the federal group, not context rows: the context group is a radio of
// one, so a preset holding the noise surface beside rail and airports could not be built there.
import { RAIL_ROW, AIRPORT_ROW } from './source-ntad-rail-airports.js';
// Historic places: a screen-only mark layer read live per view, beside them (source-nrhp.js).
import { NRHP_ROW } from './source-nrhp.js';
// SNOTEL snowpack: a screen-only mark layer read live per view, beside them (source-snotel.js).
import { SNOTEL_ROW } from './source-snotel.js';
import { LAYER_LABEL as AURORA_LABEL, LAYER_CAVEAT as AURORA_CAVEAT } from './source-aurora.js';
import { LAYER_LABEL as FLOOD_LABEL, LAYER_CAVEAT as FLOOD_CAVEAT } from './source-flood-zones.js';
import { LAYER_LABEL as AQI_LABEL, LAYER_CAVEAT as AQI_CAVEAT } from './source-aqi.js';
import { LAYER_LABEL as LIGHTS_LABEL, LAYER_CAVEAT as LIGHTS_CAVEAT } from './source-night-lights.js';
import { LAYER_LABEL as NOISE_LABEL, LAYER_CAVEAT as NOISE_CAVEAT } from './source-transport-noise.js';
import { LAYER_ID as PADUS_ID, LAYER_LABEL as PADUS_LABEL, LAYER_CAVEAT as PADUS_CAVEAT } from './source-padus.js';
import { LAYER_ID as ECO_ID, LAYER_LABEL as ECO_LABEL, LAYER_CAVEAT as ECO_CAVEAT, EXPORT_URL as ECO_EXPORT } from './source-ecoregions.js';
import { LAYER_LABEL as TERRAIN_LABEL, LAYER_CAVEAT as TERRAIN_CAVEAT } from './source-terrain-surface.js';
import { LAYER_LABEL as WETLAND_LABEL, LAYER_CAVEAT as WETLAND_CAVEAT, SYMBOL_WETLAND } from './source-wetlands.js';
import { BASES, DEFAULT_BASE } from './source-basemaps.js';
// Only for `claim`: which TIME a surface's caption shows is the source's own claim, and
// that is recorded once, in the measured record, rather than restated per layer here.
import { SOURCES } from './source-registry.js';
import { ROAD_CLASSES } from './road-names.js';
import { LAYER_LABEL as SMOKE_LABEL, LAYER_CAVEAT as SMOKE_CAVEAT } from './source-smoke.js';
import { LAYER_LABEL as FIRE_LABEL, LAYER_CAVEAT as FIRE_CAVEAT } from './source-fire.js';

// The zooms the Road names row quotes, read from the class table so the words cannot drift from it.
const ROAD_FIRST_ZOOM = Math.min(...ROAD_CLASSES.map((c) => c.zoom));
const ROAD_LOCAL_ZOOM = ROAD_CLASSES.find((c) => c.key === 'local').zoom;

const mvumKeys = Object.keys(SYMBOL_BY_KEY).filter((k) => k.startsWith('mvum-'));

/** `render` is how a layer earns its ink: density is a rendering choice, never a
 *  reason to withhold a layer. A dense layer is drawn only where it can be read,
 *  and labelled only where a label helps, rather than being left out.
 *
 *  `labels`   — 'none' draws the line and no text; 'ifRoom' labels a run long
 *               enough to carry one (labelCandidates' minLengthPx decides).
 *  `dropBelowScale` — the coarsest scale DENOMINATOR this layer may draw at.
 *               24000 means "1:24,000 or finer"; at 1:48,000 the same page holds
 *               four times the ground and the layer is dropped instead of
 *               printing as a solid block. null means every scale.
 *
 *  `weightIn` was here too and is gone: it restated legend.js's widths, which is
 *  the one thing that file forbids ("Add a symbol here; never restate its
 *  numbers"), and had already drifted — trails declared 2/300 while its own
 *  trail-nst symbol is 3.5/300. Width comes from the symbol table, once. */
const render = (labels = 'ifRoom', dropBelowScale = null) => ({ labels, dropBelowScale });

/** A state land layer. Unlike every layer above it, this one exists only on a
 *  state page: the services live on ~60 origins and no single CSP can name them
 *  all, so /quiet-corners/maps/nc/ is allowed to reach North Carolina's and
 *  nothing else. `family` is the key into the measured catalogue. */
const land = (family, label, symbolKey, coverageCaveat, extra = {}) => Object.freeze({
  id: family,
  group: 'state',
  label,
  sourceId: null,             // per state, from state-sources.json — not one measured service
  family,
  stateScoped: true,
  defaultOn: false,
  required: false,
  symbolKeys: [symbolKey],
  // A state service answering with nothing means it published no such area HERE.
  // It is not a statement that the ground is private.
  emptyMeans: 'none',
  status: 'live',
  // Family-specific, because three identical caveats in a row is noise the reader
  // learns to skip. The rule they used to repeat — a boundary is not a claim about
  // access — is stated once, prominently, in the page's own body text.
  coverageCaveat,
  render: render('ifRoom'),
  ...extra,
});

/** How the control panel is divided. A flat list of nine checkboxes put three
 *  unlike things side by side: overlays that add ink to the map, extra SHEETS
 *  that add pages to the PDF, and state layers that may not exist where you are.
 *  A reader ticking "Aerial companion sheet" expecting to see it on the map was
 *  reading the list correctly; the list was wrong.
 *
 *  These hints are read ON SCREEN, in the panel, by someone looking at the map --
 *  `renderLayerControls` is the only thing that draws them. So each says what its
 *  switches do to the map first and to paper second, and "page" is kept for a page
 *  of the PDF. State land used to promise "that state's own page"; the per-state
 *  pages were retired (`state-pages.js:mapRulePaths` returns the one dashboard
 *  path), so that sentence sent a reader somewhere that no longer exists. */
export const GROUPS = Object.freeze([
  Object.freeze({ id: 'base', label: 'Base map', hint: 'What the map is drawn on, on screen. Printed sheets always carry the USGS Topo base; aerial imagery and shaded relief print as companion sheets under Extra sheets.' }),
  Object.freeze({ id: 'federal', label: 'Federal overlays', hint: 'Drawn on the map anywhere in the lower 48, and on printed sheets.' }),
  // 'Land, sky & light' rather than 'Sky & light': the group holds a surface about the
  // GROUND now, and the old label would have sent a reader looking for terrain past it.
  Object.freeze({ id: 'context', label: 'Land, sky & light context', hint: 'Pick one continuous-colour surface to lay over the map, and tick any outlines or shading to draw on top of it. Screen only \u2014 context is not drawn on a printed sheet.' }),
  // A FOURTH kind of switch, after ink on the map, a page in the PDF and a colour surface
  // over it: an answer in words about the area you drew. Both rows here come from sources
  // whose subject is not where a line runs — usgsGovUnits already draws the boundaries —
  // but what is true of the ground inside it, in the publisher's own wording. Neither
  // draws, so neither belongs in a group whose hint promises ink.
  Object.freeze({ id: 'reading', label: 'Place facts', hint: 'Answers in words about the area you drew, written into this panel. Nothing is drawn on the map and nothing is added to a printed sheet.' }),
  Object.freeze({ id: 'state', label: 'State land', hint: 'Drawn on the map like the federal overlays, but only where the area you drew reaches a state that publishes them.' }),
  Object.freeze({ id: 'cameras', label: 'Cameras', hint: 'Camera locations on the screen map; a picture loads only when you open a camera. Never printed.' }),
  Object.freeze({ id: 'extras', label: 'Extra sheets', hint: 'Added as their own printed pages at the back of the PDF. Not drawn on the map.' }),
]);
export const GROUP_IDS = Object.freeze(GROUPS.map((g) => g.id));

/** QQA-18: how the Layers panel is HEADED. `group` above is a layer's rendering role and stays
 *  that -- drape, the count, the surface caption and the fetch pass all read it. These are the
 *  task groups a reader navigates by (plan 4.7): one primary home per layer id, whatever its
 *  provider or role. Presentation only: a group changes which heading a row sits under, never
 *  its id, its input id, whether it is a radio or a checkbox, or what it draws. The raster
 *  surfaces are still the one `qcm-context` radio choice although they sit under different
 *  headings (Weather, Night sky, Terrain, Explore counties).
 *
 *  `ids` is the row order inside the heading. Every registry id, every screen base and the
 *  No-context row must appear in exactly one `ids` (layer-task-groups.test.mjs), so a new
 *  provider's layer has to be homed here and cannot grow a top-level heading of its own.
 *  `searchTerms` are purpose words a reader types that no label carries; the group's label is
 *  searched too. */
export const NO_CONTEXT_ROW_ID = 'noContextSurface';
export const TASK_GROUPS = Object.freeze([
  Object.freeze({ id: 'mapStyle', label: 'Map style', ids: Object.freeze(['usgsTopo', 'usgsImagery', 'usgsShadedRelief', 'none', NO_CONTEXT_ROW_ID]),
    searchTerms: 'background basemap base map imagery aerial relief',
    hint: 'What the map is drawn on, on screen. Printed sheets always carry the USGS Topo base; aerial imagery and shaded relief print as companion sheets under Print options. No context surface clears the one colour surface chosen under another heading (Terrain, Weather, Explore counties and so on).' }),
  Object.freeze({ id: 'places', label: 'Places & routes', ids: Object.freeze(['mvum', 'trails', 'recSites', 'blmRecSites', 'names', 'roads', 'railClass1', 'airports', 'historicPlaces']),
    searchTerms: 'hiking camping roads campsites trailheads recreation',
    hint: 'Roads, trails, recreation sites and place names, drawn on the map anywhere in the lower 48.' }),
  Object.freeze({ id: 'land', label: 'Land & access', ids: Object.freeze(['federalLand', 'surfaceOwnership', 'countyLines', 'gameLands', 'stateParks', 'managedAreas', 'parcels']),
    searchTerms: 'public land ownership boundaries hunting',
    hint: 'Who manages the land. Federal layers draw anywhere in the lower 48; state rows are offered only where the area you drew reaches a state that publishes them.' }),
  Object.freeze({ id: 'terrain', label: 'Terrain & landscape', ids: Object.freeze(['hillshadeLight', 'terrainSlope', 'terrainContours', 'nlcdLandCover', 'nlcdTreeCanopy', 'wetlands', 'gbifOccurrence', 'transportNoise']),
    searchTerms: 'ground slope steep forest vegetation wildlife species',
    hint: 'The ground and what covers it. Hillshade, slope, land cover and tree canopy are colour surfaces, a choice of one across the whole panel; wetlands and wildlife records draw on top of the map.' }),
  Object.freeze({ id: 'weather', label: 'Weather & conditions', ids: Object.freeze(['nwsRadar', 'epaAirNowAqi', 'noaaHmsSmoke', 'nifcFirePerimeters', 'femaNfhl', 'nwsObservations', 'streamGauges', 'snotelSnowpack', 'snowDepthModel', 'avalancheDanger']),
    searchTerms: 'rain storm forecast air smoke wildfire flood',
    hint: 'What is happening now on the map. Radar is a colour surface, a choice of one across the whole panel; air quality, smoke, fire perimeters and flood zones draw on top and can be on together. Screen only.' }),
  Object.freeze({ id: 'sky', label: 'Night sky', ids: Object.freeze(['nightLights', 'swpcAurora']),
    searchTerms: 'night lights aurora northern lights light pollution',
    hint: 'Night lights is a colour surface, a choice of one across the whole panel; the aurora forecast draws on top. Screen only.' }),
  Object.freeze({ id: 'cameras', label: 'Cameras', ids: Object.freeze(['roadCameras', 'parkCameras', 'linkCameras', 'phenoCameras', 'airportCameras']),
    searchTerms: 'webcam live view',
    hint: 'Camera locations on the screen map; a picture loads only when you open a camera. Never printed.' }),
  Object.freeze({ id: 'facts', label: 'Place facts', ids: Object.freeze(['padusAccess', 'epaEcoregions']),
    searchTerms: 'inspect about this place access ecoregion',
    hint: 'Answers in words about the area you drew, written into this panel. Nothing is drawn on the map and nothing is added to a printed sheet.' }),
  Object.freeze({ id: 'counties', label: 'Explore counties', ids: Object.freeze(['countyScore']),
    searchTerms: 'compare ranking score',
    hint: 'Compare counties. The county score is a colour surface, a choice of one across the whole panel, drawn on the screen map only.' }),
  Object.freeze({ id: 'print', label: 'Print options', ids: Object.freeze(['aerial', 'terrain', 'tripPage']),
    searchTerms: 'pdf companion sheet page paper',
    hint: 'Added as their own printed pages at the back of the PDF. Not drawn on the map, and not counted as on the map.' }),
]);
/** layer id (or base id, or NO_CONTEXT_ROW_ID) -> its task group id. */
export const TASK_GROUP_OF = Object.freeze(Object.fromEntries(TASK_GROUPS.flatMap((g) => g.ids.map((id) => [id, g.id]))));

export const LAYERS = Object.freeze([
  Object.freeze({
    id: 'usgsTopo',
    group: 'base',
    label: 'USGS Topo',
    sourceId: 'usgsTopo',
    defaultOn: true,
    required: true,           // the PRINT base: every sheet's raster is topo. The screen base is baseControlSpecs' choice.
    symbolKeys: [SYMBOLS.basemap.key],
    emptyMeans: 'blocking',   // a tile the service will not return is a failure, never blank paper
    status: 'live',
    // Audit A11 found the national view had no topo under it at all: the switch
    // stayed checked and disabled at every zoom, so it named a layer that was not
    // on the screen. Audit Q-base (A1) resolved this the other way: the base tile
    // layer is on the map at every zoom, including national, so there is no gap
    // left for this caveat to describe.
    coverageCaveat: null,
    render: render('none'),
  }),
  Object.freeze({
    id: 'mvum',
    group: 'federal',
    label: 'MVUM roads & trails',
    sourceId: 'usfsMvum',
    defaultOn: false,
    required: false,
    symbolKeys: mvumKeys,
    // MVUM is published forest by forest, so nothing back can mean "outside a
    // published forest" rather than "no routes here". The page must say which.
    emptyMeans: 'ambiguous',
    status: 'live',
    coverageCaveat: 'Published forest by forest; an empty result can mean no coverage rather than no routes.',
    // 'ifRoom', not 'none': the sheet has always labelled MVUM routes, and build.js
    // has a resolver whose only job is picking road number vs trail name. The old
    // 'none' here described no shipped behaviour — it was never read.
    render: render('ifRoom'),
  }),
  Object.freeze({
    id: 'trails',
    group: 'federal',
    label: 'Hiking & non-motorized trails',
    sourceId: 'usgsQuadIndex',   // same host, already CSP-allowed
    defaultOn: false,
    required: false,
    symbolKeys: ['trail-nst', 'trail-nonmotor', 'trail-nonmotor-unstated'],
    // A trail the source says nothing about is still a trail; an empty answer for
    // the whole area means the area genuinely has none in this dataset.
    emptyMeans: 'none',
    status: 'live',
    coverageCaveat: 'Allowed uses appear only where the source states them; a blank field is silence, not a prohibition.',
    render: render('ifRoom'),
  }),
  Object.freeze({
    id: 'federalLand',
    group: 'federal',
    label: 'National parks, forests, wilderness & refuges',
    sourceId: 'usgsGovUnits',    // same host as the topo base, already CSP-allowed
    defaultOn: false,
    required: false,
    symbolKeys: ['fed-wilderness', 'fed-park', 'fed-refuge', 'fed-forest'],
    // An empty answer over a rectangle is a real answer here: most of the country
    // carries no federal designation, and saying "none" is the truth rather than a
    // near-miss to caveat.
    emptyMeans: 'none',
    status: 'live',
    coverageCaveat: 'A proclamation boundary encloses private inholdings that were never federal. Bureau of Land Management is not drawn: its polygons are administrative jurisdictions, not holdings.',
    render: render('ifRoom'),
  }),
  Object.freeze({
    id: 'countyLines',
    group: 'federal',
    label: 'County boundaries',
    sourceId: 'usgsGovUnits',    // same host as the topo base, already CSP-allowed
    defaultOn: false,
    required: false,
    symbolKeys: ['county-line'],
    // Every square foot of the lower 48 is in a county, so an empty answer over a
    // rectangle is never "none here" -- it is the service failing to say. Treating
    // it as a real answer would print a sheet claiming the ground has no county.
    emptyMeans: 'ambiguous',
    status: 'live',
    coverageCaveat: 'Drawn from the 2025 TIGER/Line county file, not from the generalized outlines the county finder uses.',
    render: render('ifRoom'),
  }),
  Object.freeze({
    id: 'surfaceOwnership',
    group: 'federal',
    label: 'National Forest land ownership, parcel by parcel',
    sourceId: 'usfsSurfaceOwnership',   // same host as MVUM, already CSP-allowed
    defaultOn: false,
    required: false,
    symbolKeys: ['own-nfs', 'own-other'],
    // The Forest Service's own land-status record covers every National Forest,
    // so nothing back over a rectangle means no National Forest System ground
    // here -- a real answer, and the common one across most of the country.
    emptyMeans: 'none',
    status: 'live',
    coverageCaveat: 'The Forest Service’s land-status record, not a survey. It says whose ground a parcel is, not whether you may enter it.',
    // 81 parcels in one quad. Density is answered here, by drawing every parcel as
    // a hairline with no letters, at every scale -- never by leaving the layer out.
    render: render('none'),
  }),
  Object.freeze({
    id: 'recSites',
    group: 'federal',
    label: 'Campsites, shelters & trailheads',
    sourceId: 'usfsMvum',        // same host, already CSP-allowed
    defaultOn: false,
    required: false,
    symbolKeys: ['rec-campground', 'rec-shelter', 'rec-trailhead', 'rec-site'],
    emptyMeans: 'none',
    status: 'live',
    coverageCaveat: 'Open/closed status is the Forest Service inventory’s last sync, not a live check.',
    render: render('ifRoom'),
  }),
  Object.freeze({
    id: 'blmRecSites',
    group: 'federal',
    label: BLM_LABEL,
    sourceId: 'blmRecSites',
    defaultOn: false,
    required: false,
    // The generic mark, shared with the Forest Service layer: on paper the two are one
    // thing, a place you may stop, and a second dot would be a symbol quiz.
    symbolKeys: ['rec-site'],
    emptyMeans: 'none',   // published nationally, so nothing back is a real answer
    status: 'live',
    coverageCaveat: BLM_CAVEAT,
    render: render('ifRoom'),
  }),
  // The wetlands inventory. A VECTOR overlay rather than a context surface, deliberately:
  // it draws shapes where the inventory holds them instead of filling the view, so it can
  // be on at the same time as whichever continuous surface the reader chose, and the
  // canopy and access layers stay readable beneath it.
  Object.freeze({
    id: 'wetlands',
    group: 'federal',
    label: WETLAND_LABEL,
    sourceId: 'fwsNwiWetlands',
    defaultOn: false,
    required: false,
    symbolKeys: [SYMBOL_WETLAND],
    // NOT the 'none' the other national federal layers carry. Nothing back here has
    // three possible meanings -- mapped and empty, never mapped, or off the service
    // altogether -- and only the Wetlands_Status point query can say which, which is
    // what source-wetlands.js's coverageReport is for. Until it has answered, an
    // empty result genuinely is ambiguous.
    emptyMeans: 'ambiguous',
    status: 'live',
    coverageCaveat: WETLAND_CAVEAT,
    // 'none': 1,759 polygons measured in one desktop view over Horicon Marsh, and a
    // Cowardin code is not a name anyone reads in the field. Density is answered by
    // the hairline width in legend.js and by the count-first refusal in the adapter,
    // never by leaving the layer out.
    render: render('none'),
  }),
  // Named terrain and places (GNIS), via terrain-names.js / source-terrain-names.js
  // (N1) and Q/name-labels.js's screen declutter. 'federal' group, not a new one:
  // the group's own hint ("Drawn on the map anywhere in the lower 48, and on printed
  // sheets") already describes this layer exactly. `defaultOn` like Road names: the
  // default flows from here alone (DEFAULT_LAYERS -> app-state DEFAULTS), and a stored
  // layers.names=false survives because recipeFromControls only fills keys it was not given.
  Object.freeze({
    id: 'names',
    group: 'federal',
    label: 'Named places & landmarks',
    sourceId: 'gnisNames',
    defaultOn: true,
    required: false,
    symbolKeys: ['name-place', 'name-summit', 'name-gap', 'name-ridge', 'name-water-feature',
      'name-other-land', 'name-other-water', 'name-river', 'name-creek', 'name-stream-mouth', 'name-other'],
    // A GNIS query genuinely returning nothing for an area is a real answer, like
    // federalLand above -- most rectangles hold at least one named feature, but an
    // empty one is not ambiguous the way countyLines' "every foot has a county" is.
    emptyMeans: 'none',
    status: 'live',
    coverageCaveat: 'On by default; untick it for a plain map. GNIS gives one published point per name '
      + '-- the primary point, not every place the name is used, and never an elevation (a name\'s card '
      + 'fetches an approximate one from USGS 3DEP). A name with '
      + 'several points (a valley, a summit split across counties) is reduced to its first point. Screen '
      + 'labels declutter automatically. The USGS Topo base prints its own names, and these decluttered '
      + 'ones may repeat some of them; the printed base cannot be decluttered.',
    render: render('ifRoom'),
  }),
  // QQA-05r-2: road names on the screen map, from The National Map transportation service
  // (source-road-names.js), lettered by main.js renderRoads in its own pane. Same group as the
  // names above. `screenOnly` because nothing here is a sheet's ink -- a printed sheet already
  // carries the topo base's own road lettering -- and `defaultOn` because a map with no road
  // names is the gap this row closes; a reader who does not want them unticks it.
  Object.freeze({
    id: 'roads',
    group: 'federal',
    label: 'Road names',
    sourceId: 'usgsRoadNames',
    screenOnly: true,
    defaultOn: true,
    required: false,
    symbolKeys: [SYMBOLS.roadName.key],   // amber lettering on a dark plate; the key shows that sample
    emptyMeans: 'ambiguous',   // the dataset is CONUS-focused: an empty answer elsewhere is not "no roads"
    status: 'live',
    coverageCaveat: `Road names from USGS The National Map transportation data, screen only: they are not drawn on printed sheets. Highways start at zoom ${ROAD_FIRST_ZOOM}, and local roads appear from zoom ${ROAD_LOCAL_ZOOM}. ${SOURCES.usgsRoadNames.coverageCaveat}`,
    render: render('none'),
  }),
  // BTS rail lines and public-use airports: where the sources of the noise surface below are.
  // Their rows live with their words in source-ntad-rail-airports.js (screen-only, off by default).
  RAIL_ROW,
  AIRPORT_ROW,
  NRHP_ROW,
  SNOTEL_ROW,
  // A CONTINUOUS-COLOUR SURFACE: a third kind, neither ink on the map nor a page in the PDF
  // but a raster under the vectors on screen. main.js hands Leaflet the URL, so there is no
  // fetch of its own; `screenOnly` keeps it out of the overlay fetch as `extraPage` does a sheet.
  Object.freeze({
    id: 'nightLights',
    group: 'context',
    label: LIGHTS_LABEL,
    sourceId: 'nasaBlackMarble',
    screenOnly: true,
    // A view-filling PICTURE, not shapes drawn where a value is non-trivial: it hides
    // whatever is under it everywhere, so two of them stacked leave no base readable.
    // layer-presets.js's budget is what counts them; the opacity itself stays in the
    // source module, never restated here.
    rasterSurface: true,
    defaultOn: false,
    required: false,
    symbolKeys: [SYMBOLS.basemap.key],   // a raster, like the base and both companions
    emptyMeans: 'none',   // no light in a tile is a real answer, not a near-miss
    status: 'live',
    coverageCaveat: LIGHTS_CAVEAT,
    render: render('none'),
  }),
  // The same shape as the lights: a view-filling tile picture handed to Leaflet by main.js.
  // A modelled annual average, so `emptyMeans: 'ambiguous'` -- a blank tile can mean the model
  // found nothing loud OR that the place is outside the lower 48.
  Object.freeze({
    id: 'transportNoise',
    group: 'context',
    label: NOISE_LABEL,
    sourceId: 'btsTransportNoise',
    screenOnly: true,
    rasterSurface: true,   // the other view-filling picture — see nightLights above
    defaultOn: false,
    required: false,
    symbolKeys: [SYMBOLS.basemap.key],
    emptyMeans: 'ambiguous',
    status: 'live',
    coverageCaveat: NOISE_CAVEAT,
    render: render('none'),
  }),
  // The fifth context surface, and the only one that is not about a moment at all. Radar saw
  // something minutes ago; the air was a category last hour; this is an engineering study's
  // floodplain adopted as regulation. That difference is why it belongs in this group rather
  // than beside the federal boundaries: it is laid OVER the map as one picture, one at a time,
  // and putting it next to a weather alert is the misreading it is most prone to.
  //
  // Vector polygons, not a raster: it carries no `rasterSurface`, because the surface budget
  // counts view-filling pictures and this draws only where a study drew a line.
  Object.freeze({
    id: 'femaNfhl',
    group: 'context',
    label: FLOOD_LABEL,
    sourceId: 'femaNfhl',
    screenOnly: true,   // a regulatory map, per-panel dated, is not a sheet this page prints
    defaultOn: false,
    required: false,
    symbolKeys: [SYMBOLS.basemap.key],
    // NOT the 'none' the sky surfaces use. Zero zone polygons over a rectangle means "FEMA
    // published no study here" in interior Alaska and "nothing intersects" elsewhere, and only
    // the separate coverage query on layer 0 tells those apart (source-flood-zones.js).
    emptyMeans: 'ambiguous',
    status: 'live',
    coverageCaveat: FLOOD_CAVEAT,
    render: render('none'),
  }),
  // The same shape as the lights, and the same reason: an exported raster under the
  // vectors, handed to Leaflet by main.js rather than fetched here. What it does not
  // share is durability -- the service holds a rolling two-hour window, so its row
  // carries the frame's own age and `renderRadar` rewrites that on every redraw.
  Object.freeze({
    id: 'nwsRadar',
    group: 'context',
    label: RADAR_LABEL,
    sourceId: 'nwsRadar',
    screenOnly: true,   // a two-hour window has no business on a printed sheet
    rasterSurface: true,   // the other view-filling picture — see nightLights above
    defaultOn: false,
    required: false,
    symbolKeys: [SYMBOLS.basemap.key],
    emptyMeans: 'none',   // clear air is a real answer, not a near-miss
    status: 'live',
    coverageCaveat: RADAR_CAVEAT,
    render: render('none'),
  }),
  // The second BOUNDED surface, and the only one that is not a picture at all: three limit=0
  // counts per cell, ~4 KB, shaded as one box. It draws no point on purpose -- 97% of GBIF
  // records state no coordinate precision, so a dot would be a claim the data cannot back --
  // which is also why `rasterSurface` is absent: one shaded box hides nothing beneath it.
  Object.freeze({
    id: 'gbifOccurrence',
    group: 'context',
    label: GBIF_LABEL,
    sourceId: 'gbifOccurrence',
    screenOnly: true,   // a live bounded query is no basis for a printed sheet
    defaultOn: false,
    required: false,
    symbolKeys: [SYMBOLS.basemap.key],
    // NOT the 'none' the sky surfaces use. Nothing back means nobody submitted a record here,
    // which is a statement about recording effort and not about the ground — the one reading
    // this layer exists to forbid, so the registry says it is ambiguous out loud.
    emptyMeans: 'ambiguous',
    status: 'live',
    coverageCaveat: GBIF_CAVEAT,
    render: render('none'),
  }),
  // The mirror of the radar row above. Radar is an observation and its row states how
  // OLD the picture is; this is an outlook and its row states how far AHEAD the forecast
  // reaches. Both are screen-only, for opposite reasons: radar goes stale in two hours,
  // this one was never about the moment the sheet is printed at all.
  Object.freeze({
    id: 'swpcAurora',
    group: 'context',
    label: AURORA_LABEL,
    sourceId: 'swpcAurora',
    screenOnly: true,
    defaultOn: false,
    required: false,
    symbolKeys: [SYMBOLS.basemap.key],
    emptyMeans: 'none',   // zero over the lower 48 is the model's answer, not a gap
    status: 'live',
    coverageCaveat: AURORA_CAVEAT,
    render: render('none'),
  }),
  // The two READING rows. Neither draws and neither prints: `screenOnly` keeps them out of
  // the overlay fetch, and renderLayerReports hands their rows to their own modules.
  Object.freeze({
    id: PADUS_ID,
    group: 'reading',
    label: PADUS_LABEL,
    sourceId: 'padusPublicAccess',
    screenOnly: true,
    defaultOn: false,
    required: false,
    symbolKeys: [],      // it puts no mark on the map, so it owes the key no row
    // In the lower 48 an empty answer is a real "no protected land here"; outside them the
    // inventory is thin AND a background polygon fills the gap, so an empty answer never
    // appears there at all. The two cannot be told apart from the response alone.
    emptyMeans: 'ambiguous',
    status: 'live',
    coverageCaveat: PADUS_CAVEAT,
    render: render('none'),
  }),
  Object.freeze({
    id: ECO_ID,
    group: 'reading',
    label: ECO_LABEL,
    // NO measured service: the source is a committed export of the EPA layer, which is why
    // gispub.epa.gov is absent from source-registry.js and from the CSP. See
    // source-ecoregions.js for the provenance an entry there would have carried.
    // `localData` is how that is DECLARED rather than inferred from a null sourceId --
    // a layer that quietly lost its source would otherwise look exactly like this one.
    sourceId: null,
    localData: ECO_EXPORT,
    screenOnly: true,
    defaultOn: false,
    required: false,
    symbolKeys: [],
    // Outside the conterminous states nothing comes back, and that is the map stopping
    // rather than ground without character.
    emptyMeans: 'ambiguous',
    status: 'live',
    coverageCaveat: ECO_CAVEAT,
    render: render('none'),
  }),
  // The third context surface, and the only one whose question is BOUNDED: lights and
  // radar hand Leaflet a URL for whatever is on screen, and aurora holds one global file.
  // This is a bbox query against a feature service, so a pan is a new question -- asked
  // again, debounced, with the answer about the view you left abandoned (source-aqi.js).
  Object.freeze({
    id: 'epaAirNowAqi',
    group: 'context',
    label: AQI_LABEL,
    sourceId: 'epaAirNowAqi',
    screenOnly: true,   // an hour-old surface has no business on a printed sheet
    defaultOn: false,
    required: false,
    symbolKeys: [SYMBOLS.basemap.key],
    // NOT the 'none' the two rows above use. Those cover the globe; these contours stop
    // at the border, so nothing back can mean the surface does not reach here rather than
    // clean air -- which is exactly what the source's own quietText says out loud.
    emptyMeans: 'ambiguous',
    status: 'live',
    coverageCaveat: AQI_CAVEAT,
    render: render('none'),
  }),
  // Two more bounded questions, the same shape as the AQI row above -- separate rows because they
  // are separate facts: smoke is a column seen from orbit, a perimeter is the record of an
  // incident, and the AQI contour is an interpolation at head height.
  Object.freeze({
    id: 'noaaHmsSmoke',
    group: 'context',
    label: SMOKE_LABEL,
    sourceId: 'noaaHmsSmoke',
    screenOnly: true,   // a daylight analysis that can be hours old has no business on paper
    defaultOn: false,
    required: false,
    symbolKeys: [SYMBOLS.basemap.key],
    // NOT 'none': blank means no plume outlined OR no analysis yet today, per `issuedState`.
    emptyMeans: 'ambiguous',
    status: 'live',
    coverageCaveat: SMOKE_CAVEAT,
    render: render('none'),
  }),
  Object.freeze({
    id: 'nifcFirePerimeters',
    group: 'context',
    label: FIRE_LABEL,
    sourceId: 'nifcFirePerimeters',
    screenOnly: true,   // a boundary whose median age is three weeks is no basis for a sheet
    defaultOn: false,
    required: false,
    symbolKeys: [SYMBOLS.basemap.key],
    // Nothing back is a real answer, but it is NOT "no fire is burning" -- the source says so.
    emptyMeans: 'none',
    status: 'live',
    coverageCaveat: FIRE_CAVEAT,
    render: render('none'),
  }),
  // The fourth context surface and the first one about the GROUND rather than the sky. Like
  // the radar it is an export per view with no tile cache behind it; unlike every other
  // surface here, its bytes are fetched and repainted rather than handed to Leaflet as a URL,
  // because the service publishes no class breaks for its own colours and because the alpha
  // channel is the only thing that separates "no elevation model here" from "level ground".
  Object.freeze({
    id: 'terrainSlope',
    group: 'context',
    label: TERRAIN_LABEL,
    sourceId: 'usgs3depSurface',
    screenOnly: true,   // a live render, re-exported per pan, is no basis for a printed sheet
    rasterSurface: true,   // it fills the view — the surface budget must count it
    defaultOn: false,
    required: false,
    symbolKeys: [SYMBOLS.basemap.key],
    // An export of nothing is a REAL answer here and a readable one: png32 carries coverage
    // in its alpha channel, so "the model does not reach here" is told apart from level
    // ground rather than guessed at. That is why this is 'none' and not 'ambiguous'.
    emptyMeans: 'none',
    status: 'live',
    coverageCaveat: TERRAIN_CAVEAT,
    render: render('none'),
  }),
  // The two NLCD surfaces: the same per-view export with no tile cache behind it, and the
  // same fetch-the-bytes route as the slope surface -- here because the export is handed to
  // Leaflet as a `blob:` URL, which img-src already allows, so the pair costs the policy one
  // connect-src host rather than two directives' worth.
  //
  // They are two ROWS rather than one with a sub-switch because the context group is already
  // a choice of one: two radios in the same group is the "switch between land cover and
  // canopy" the plan asks for, with no second mechanism invented to hold it.
  //
  // `emptyMeans: 'ambiguous'` and not the 'none' the sky surfaces carry. These stop at the
  // CONUS border: nothing drawn can mean the service never mapped this ground, which is a
  // different sentence from "no cover here", and source-land-cover.js's viewCoverage is what
  // tells the two apart before a request is spent.
  Object.freeze({
    id: 'nlcdLandCover',
    group: 'context',
    label: LAND_COVER_LABEL,
    sourceId: 'nlcdLandCover',
    screenOnly: true,   // a live per-view render, and an annual product, is no basis for a sheet
    rasterSurface: true,
    defaultOn: false,
    required: false,
    symbolKeys: [SYMBOLS.basemap.key],
    emptyMeans: 'ambiguous',
    status: 'live',
    coverageCaveat: LAND_COVER_CAVEAT,
    render: render('none'),
  }),
  Object.freeze({
    id: 'nlcdTreeCanopy',
    group: 'context',
    label: CANOPY_LABEL,
    sourceId: 'nlcdTreeCanopy',
    screenOnly: true,
    rasterSurface: true,
    defaultOn: false,
    required: false,
    symbolKeys: [SYMBOLS.basemap.key],
    emptyMeans: 'ambiguous',
    status: 'live',
    coverageCaveat: CANOPY_CAVEAT,
    render: render('none'),
  }),
  // The seventh context surface, and the first backed by LOCAL data rather than a measured
  // service: the county-comparison colour wash the dashboard already draws is a continuous
  // raster over the map exactly like night lights or the NLCD pair, so it belongs in the same
  // one-dominant-surface radio group rather than a second toggle living outside it. `sourceId`
  // stays null and `localData` names the site's own export, the same way ecoregions declares
  // it -- and `surfaceCaption` below is the one place that had assumed every context surface
  // names a measured SOURCES entry with a `claim`; a local-data row has no claim, only the
  // vintage the dashboard already tracks, so that function is the one that had to bend to fit
  // this row rather than a second registry or a second caption path being built beside it.
  Object.freeze({
    id: 'countyScore',
    group: 'context',
    label: 'County score',
    sourceId: null,
    localData: '/data/quiet-corners/counties.json',
    screenOnly: true,   // the dashboard's own wash, not a fetch this builder makes or a sheet it prints
    rasterSurface: true,   // a continuous colour fill over the map, like night lights and NLCD
    defaultOn: false,
    required: false,
    symbolKeys: [SYMBOLS.basemap.key],
    // Null is a real county the pipeline never scored, not "score is zero" -- the dashboard's
    // own UNKNOWN_BAND already tells the two apart on the map and in the table, and this
    // registry row must not claim a firmer answer than that.
    emptyMeans: 'ambiguous',
    status: 'live',
    coverageCaveat: 'Comparative, not absolute: a band shows how a county ranks against others in this data, not a fixed grade. A county the pipeline never scored renders as “not measured,” never as zero.',
    render: render('none'),
  }),
  // Extra PAGES, not overlays: they add sheets to the PDF rather than ink to the
  // map, so enabledLayers leaves them out of the overlay fetch. They live here
  // anyway because the registry is the one place a toggle is declared — and
  // because both of them shipped with no control at all, which is how they came to
  // be unreachable code.
  Object.freeze({
    id: 'aerial',
    group: 'extras',
    label: 'Aerial companion sheet',
    sourceId: 'usdaNaip',
    extraPage: true,
    defaultOn: false,
    required: false,
    symbolKeys: [SYMBOLS.basemap.key],
    emptyMeans: 'none',
    status: 'live',
    coverageCaveat: 'Flown on a multi-year cycle, so it can be several seasons old. It shows ground cover, not legal access. To see it on the map, choose it under Map style.',
    render: render('none'),
  }),
  Object.freeze({
    id: 'terrain',
    group: 'extras',
    label: 'Shaded relief companion sheet',
    sourceId: 'usgs3dep',        // same service as the route climb, already CSP-allowed
    extraPage: true,
    defaultOn: false,
    required: false,
    symbolKeys: [SYMBOLS.basemap.key],
    emptyMeans: 'none',
    status: 'live',
    coverageCaveat: 'Shows the shape of the ground, not what is on it. Contour values stay on the topo sheet. To see it on the map, choose it under Map style.',
    render: render('none'),
  }),
  Object.freeze({
    id: 'tripPage',
    group: 'extras',
    label: 'Route summary page (length & climb)',
    sourceId: 'usgs3dep',
    extraPage: true,
    defaultOn: false,
    required: false,
    symbolKeys: [SYMBOLS.basemap.key],
    emptyMeans: 'none',
    status: 'live',
    coverageCaveat: 'Climb is summed from points sampled along the drawn line, so a short steep pitch between samples can be missed.',
    render: render('none'),
  }),
  land('gameLands', 'State game lands', FAMILY_SYMBOL.gameLands,
    'Wildlife-agency land. Seasons and permits are the agency’s to state, not this map’s.'),
  land('stateParks', 'State parks & forests', FAMILY_SYMBOL.stateParks,
    'Camping, fires and vehicle access vary unit by unit; the boundary says nothing about them.'),
  land('managedAreas', 'Other state-managed areas', FAMILY_SYMBOL.managedAreas,
    'A catch-all: what the designation means differs from state to state.'),
  land('parcels', 'Parcel boundaries', FAMILY_SYMBOL.parcels,
    'The county\u2019s recording and tax map, not a survey, and coverage differs county by county.', {
    // 1:24,000 ONLY. At 1:48,000 the same sheet holds four times the ground, and
    // Delaware's 26,863 parcels over one test rectangle stop being lines and become
    // a filled rectangle. `labels: 'none'` for the same reason -- a parcel id is not
    // a name anyone reads in the field, and 26,863 of them is not a map.
    render: render('none', 24000),
    // A state's parcel compilation covers the counties that joined it. Nothing here
    // therefore means "this compilation does not reach this county", NEVER "no parcels
    // exist" -- treating silence as none would print unowned-looking ground.
    emptyMeans: 'ambiguous',
  }),
  HILLSHADE_ROW,
  CONTOURS_ROW,
  SNOW_DEPTH_ROW,
  // Avalanche danger: the publisher's coloured forecast zones (source-avalanche.js).
  AVALANCHE_ROW,
  // The first context row that draws POINTS from a JSON feed (source-stream-gauges.js).
  GAUGES_ROW,
  // Weather stations: POINTS from the NWS observation feed (source-nws-observations.js).
  STATIONS_ROW,
  // A camera pin marks a point, and its picture is fetched only when a reader opens
  // that pin's popup (main.js), never as part of the printable-vector fetch loop --
  // so it gets its own `cameras` group instead of joining `overlay` (QUX-08D C22).
  Object.freeze({
    id: 'roadCameras',
    group: 'cameras',
    // The colour its 2D pin is drawn in, so the 3D panel's point for it matches (QC 3D row 7).
    pinColor: '#38bdf8',
    label: 'Road cameras (state DOTs and cities)',
    // Several operators, so no single source: the About text names them all in coverageCaveat. The
    // Caltrans picture host still reaches the CSP from SOURCES, not from this row.
    sourceId: null,
    localData: '/data/quiet-corners-maps/cameras/',
    screenOnly: true,
    defaultOn: false,
    required: false,
    symbolKeys: [SYMBOLS.basemap.key],
    emptyMeans: 'none',
    status: 'live',
    coverageCaveat: "Screen only. Operators: Caltrans (all twelve California districts), the Kentucky Transportation Cabinet, the City of Arlington, Texas, the City of Lawrence, Kansas, the City of Salem, Oregon, Oregon DOT (TripCheck), Utah DOT (UDOT Traffic), Minnesota DOT (511MN), Indiana DOT (511IN), Kansas DOT (KanDrive), the Spokane Regional Transportation Management Center, Virginia DOT (VDOT), South Dakota DOT (SDDOT), the City of Austin Transportation and Public Works, the City of Baton Rouge / LA DOTD, Colorado DOT (COtrip), the City of Kirkland, Washington and Washington State Ferries (WSDOT) at its ferry terminals. Each operator's list is its own: where a picture's age is shown it is when the operator's server last changed the file, not a guaranteed capture time.",
    // UX-03b: where this layer has cameras at all -- the panel's Cameras entry names it and its
    // Go to control fits the map to the box. Road cameras come from Caltrans (all twelve California
    // districts) and from state and city agencies in other states, so the box holds every US state box
    // the build can file a road camera under (build-camera-snapshot.mjs STATE_BBOX padded by
    // STATE_BBOX_PAD, a test holds them; territories left out, no road provider files them): the
    // same box as linkCameras. Which file to read is decided by each file's own bbox in the snapshot
    // index, not by this box. Go to opens on California, where the dense Caltrans lists are, not on
    // the whole country. searchTerms are words a reader types that the label lacks.
    coverageName: 'US states',
    goToName: 'California',
    coverage: Object.freeze({ minLon: -180, minLat: 17.4, maxLon: -65.4, maxLat: 73 }),
    goTo: Object.freeze({ minLon: -124.3, minLat: 32.4, maxLon: -114.4, maxLat: 42.1 }),
    searchTerms: 'webcam cctv traffic highway DOT Caltrans California Los Angeles San Francisco San Diego Sacramento Monterey Santa Barbara San Luis Obispo Kentucky Louisville Texas Arlington Kansas Lawrence Oregon Salem TripCheck Utah UDOT Minnesota 511MN Indiana 511IN KanDrive Washington Spokane SRTMC Virginia VDOT South Dakota SDDOT Austin Louisiana Baton Rouge Colorado COtrip Denver Kirkland Seattle ferry ferries WSF terminal',
    render: render('none'),
  }),
  // QUX-08D-ii: NPS park webcams (nationwide), the same screen-only cameras group as
  // roadCameras -- a second provider, not a second kind of layer.
  Object.freeze({
    id: 'parkCameras',
    group: 'cameras',
    // The colour its 2D pin is drawn in, so the 3D panel's point for it matches (QC 3D row 7).
    pinColor: '#facc15',
    label: 'Park cameras (NPS parks)',
    sourceId: 'npsWebcams',
    screenOnly: true,
    defaultOn: false,
    required: false,
    symbolKeys: [SYMBOLS.basemap.key],
    emptyMeans: 'none',
    status: 'live',
    coverageCaveat: 'Screen only. The park does not publish when each picture was taken.',
    // UX-03b: the park's own extent, rounded out (see roadCameras above).
    coverageName: 'US national parks',
    // Every state and territory box the build can file under this layer (build-camera-snapshot.mjs
    // STATE_BBOX padded by STATE_BBOX_PAD, a test holds them): the Americas side in one box, Guam and the Marianas, across
    // the dateline, in coverageMore.
    coverage: Object.freeze({ minLon: -180, minLat: -16.1, maxLon: -63, maxLat: 73 }),
    coverageMore: Object.freeze([Object.freeze({ minLon: 143.1, minLat: 11.7, maxLon: 147.6, maxLat: 22.1 })]),
    // Go to opens at a park (the whole US is too far out to draw a pin), not at the coverage box.
    goToName: 'Great Smoky Mountains',
    goTo: Object.freeze({ minLon: -84.05, minLat: 35.4, maxLon: -83.0, maxLat: 35.8 }),
    searchTerms: 'webcam NPS National Park Service Great Smoky Mountains Yellowstone Yosemite Tennessee North Carolina Gatlinburg',
    render: render('none'),
  }),
  // Link-only cameras (HPWREN, AlertWest): the same screen-only cameras group, a third row rather
  // than a fold into roadCameras (state and city road cameras, with pictures) or
  // parkCameras. The snapshot index already names this layer 'linkCameras'. A pin makes no request:
  // its card is a name, a credit and a link to the owner's own page.
  Object.freeze({
    id: 'linkCameras',
    group: 'cameras',
    // The colour its 2D pin is drawn in, so the 3D panel's point for it matches (QC 3D row 7).
    pinColor: '#c4b5fd',
    label: 'Camera links (fire and road cameras)',
    sourceId: null,
    // The lists are this site's own snapshot files; no HPWREN or AlertWest service is ever called.
    localData: '/data/quiet-corners-maps/cameras/',
    screenOnly: true,
    defaultOn: false,
    required: false,
    symbolKeys: [SYMBOLS.basemap.key],
    emptyMeans: 'none',
    status: 'live',
    coverageCaveat: 'Screen only. No pictures: a pin links to the owner\u2019s own page, and this page loads nothing from it. Lists from HPWREN (UC San Diego), AlertWest, Missouri DOT (MoDOT), Maryland CHART, Delaware DOT (DelDOT), New Mexico DOT (NMRoads) and the New Jersey Turnpike Authority.',
    coverageName: 'US states',
    goToName: 'the West',
    // Every US state AlertWest can file plus HPWREN's California, so a refreshed list is never read
    // as "outside coverage" (STATE_BBOX padded by STATE_BBOX_PAD, a test holds them). Go to opens on the West, where the
    // lists are dense.
    coverage: Object.freeze({ minLon: -180, minLat: 17.4, maxLon: -65.4, maxLat: 73 }),
    goTo: Object.freeze({ minLon: -158.3, minLat: 19, maxLon: -102, maxLat: 49 }),
    searchTerms: 'webcam camera link wildfire fire HPWREN AlertWest UC San Diego road Missouri MoDOT Maryland CHART Delaware DelDOT NMRoads New Jersey Turnpike California Nevada Oregon Washington Idaho Montana Wyoming Colorado Utah Arizona New Mexico Hawaii',
    render: render('none'),
  }),
  // PhenoCam Network and AviationWX: one screen-only row per network, each with its own credit and
  // coverage. A pin's picture is a plain <img> from the owner's host (camera-layer.js PROVIDERS).
  Object.freeze({
    id: 'phenoCameras',
    group: 'cameras',
    // The colour its 2D pin is drawn in, so the 3D panel's point for it matches (QC 3D row 7).
    pinColor: '#4ade80',
    label: 'Research cameras (PhenoCam)',
    sourceId: 'phenocam',
    screenOnly: true,
    defaultOn: false,
    required: false,
    symbolKeys: [SYMBOLS.basemap.key],
    emptyMeans: 'none',
    status: 'live',
    coverageCaveat: 'Screen only. PhenoCam Network research cameras in the 50 states and DC that sent a picture in the 30 days before the list was checked (the network does not say when each picture was taken), plus USGS and Alaska Volcano Observatory volcano cameras and NOAA GLERL Great Lakes cameras whose newest picture was under a day old when the list was checked.',
    coverageName: 'US states and territories',
    goToName: 'the United States',
    // Every state and territory box the build can file under this layer (STATE_BBOX padded by STATE_BBOX_PAD, a
    // camera-layer test holds them): the Americas side in one box, like parkCameras. Across the dateline, in
    // coverageMore, Guam and the Marianas (volcview/gu-mp.json) and the western Aleutians (volcview/ak-west.json).
    coverage: Object.freeze({ minLon: -180, minLat: -16.1, maxLon: -63, maxLat: 73 }),
    coverageMore: Object.freeze([Object.freeze({ minLon: 143.1, minLat: 11.7, maxLon: 147.6, maxLat: 22.1 }),
      Object.freeze({ minLon: 171.9, minLat: 50.9, maxLon: 180, maxLat: 53.7 })]),
    goTo: Object.freeze({ minLon: -125, minLat: 24, maxLon: -66.5, maxLat: 49.5 }),
    searchTerms: 'webcam camera research phenology PhenoCam forest grassland crop season volcano ash Alaska Aleutian USGS VolcView Alaska Volcano Observatory Great Lakes GLERL lighthouse pier',
    render: render('none'),
  }),
  Object.freeze({
    id: 'airportCameras',
    group: 'cameras',
    // The colour its 2D pin is drawn in, so the 3D panel's point for it matches (QC 3D row 7).
    pinColor: '#c084fc',
    label: 'Airport cameras (AviationWX)',
    sourceId: 'aviationwx',
    screenOnly: true,
    defaultOn: false,
    required: false,
    symbolKeys: [SYMBOLS.basemap.key],
    emptyMeans: 'none',
    status: 'live',
    coverageCaveat: 'Screen only. Webcams at the United States airports on the public AviationWX list, one pin per camera. Weather data from AviationWX.org.',
    coverageName: 'US airports',
    goToName: 'the United States',
    // The 50 states and DC, padded like the build's state boxes (Alaska's Aleutians reach -180).
    coverage: Object.freeze({ minLon: -180, minLat: 17.4, maxLon: -65.4, maxLat: 73 }),
    goTo: Object.freeze({ minLon: -125, minLat: 24, maxLon: -66.5, maxLat: 49.5 }),
    searchTerms: 'webcam camera airport airfield aviation weather AviationWX pilot runway',
    render: render('none'),
  }),
]);

export const LAYER_BY_ID = Object.freeze(Object.fromEntries(LAYERS.map((l) => [l.id, l])));

/** A row's label without its trailing source note: "Rail lines (Class I, BTS)" -> "Rail lines". */
export function shortLabel(label) {
  return String(label).replace(/\s*\([^)]*\)\s*$/, '');
}

/** The hint `renderLayerControls` draws under a group heading. A group whose rows mostly
 *  print but some are `screenOnly` gets those rows named, from the registry, because no
 *  row says so itself and a hand-written list would miss the next screen-only row. */
export function groupHint(group, registry = LAYERS) {
  if (!group.hint) return '';
  const rows = registry.filter((l) => l.group === group.id);
  const screen = rows.filter((l) => l.screenOnly);
  if (!screen.length || screen.length === rows.length) return group.hint;
  return `${group.hint} Screen only, not printed: ${screen.map((l) => shortLabel(l.label)).join(', ')}.`;
}

/** Whether the 3D terrain panel (E2) can drape a layer, derived rather than
 *  restated on each of the ~33 rows above -- the same reasoning `render`'s own
 *  header comment gives for not retyping legend.js's widths: a derivable fact
 *  restated per row is a fact that can drift.
 *
 *  'line'  -- vector geometry (a line, polygon outline or point) draped over the
 *             terrain with D0's own colours (preview-overlay.js), never a second
 *             palette.
 *  'label' -- the one text-label layer (named terrain & places); draped as DOM
 *             labels with an occlusion pass, not a MapLibre line/circle layer.
 *  false   -- cannot drape: a continuous-colour context surface (`group ===
 *             'context'`, plan §4.6's "unsupported context layers"), the base
 *             map (drawn as the panel's own topo raster already, not a toggle),
 *             a PDF-only extra page, or a words-only 'reading' row that puts no
 *             mark on the 2D map either. */
export function drapeKindFor(layer) {
  if (layer.id === 'names') return 'label';
  // A camera pin is a point the 3D panel stands on the relief where 2D pins it (QC 3D row 7).
  if (layer.group === 'cameras') return 'point';
  if (layer.group === 'context' || layer.group === 'base' || layer.group === 'reading'
    || layer.extraPage) return false;
  // Rail lines and airports are live screen-only reads (source-ntad-rail-airports.js): nothing in
  // 3D drapes them, and a point row must not be given the 'line' drape. `notIn3d` is what makes
  // terrain-overlays tell the reader so ("Available in 2D") rather than drop them silently.
  if (layer.notIn3d) return false;
  return 'line';
}
export const LAYER_DRAPE = Object.freeze(Object.fromEntries(LAYERS.map((l) => [l.id, drapeKindFor(l)])));
/** LAYERS with `drape` resolved onto each row, for a caller (terrain-overlays.js
 *  via main.js) that wants one self-describing registry rather than a side table. */
export const LAYERS_WITH_DRAPE = Object.freeze(LAYERS.map((l) => Object.freeze({ ...l, drape: LAYER_DRAPE[l.id] })));

/** Render rules keyed by the SYMBOL a feature carries, because that is all the
 *  drawing code holds: overlay-paths sees a symbolKey, never a layer id. Built
 *  from the registry, so a layer's rule reaches the paper by existing. */
export function renderBySymbol(registry = LAYERS) {
  return Object.freeze(Object.fromEntries(
    registry.flatMap((l) => l.symbolKeys.map((k) => [k, l.render])),
  ));
}
export const RENDER_BY_SYMBOL = renderBySymbol();
export const LAYER_IDS = Object.freeze(LAYERS.map((l) => l.id));

/** The one place a layer default is written. app-state's DEFAULTS.layers reads this. */
export const DEFAULT_LAYERS = Object.freeze(Object.fromEntries(LAYERS.map((l) => [l.id, l.defaultOn])));

/** Whether the source pass ever asks a service for this row once it is on. An extra
 *  page is fetched by the build itself, a screen-only row is drawn and never printed,
 *  and neither gets a state from Check sources. canBuild asks this too, so the gate
 *  waits on exactly the rows the pass answers. */
export function fetchedBySourcePass(l) {
  return l.status === 'live'
    && !l.extraPage                                   // an extra page is not an overlay to fetch
    && !l.screenOnly;                                 // nor is a raster context surface
}

/** Layers a build actually fetches: live, switched on, and — for a state layer —
 *  available in the state whose page this is. A state layer switched on but not
 *  published by that state is silently not fetched rather than erroring: the
 *  control that offered it is disabled, so this is belt and braces. */
export function enabledLayers(layers = {}, states = null) {
  const available = new Set(usableFamilies(states));
  return LAYERS.filter((l) => fetchedBySourcePass(l)
    && (l.required || layers[l.id])
    && (!l.stateScoped || available.has(l.family)));
}

/** Which state layers the drawn area can offer at all. Empty before an area is
 *  chosen, which is why the controls say so rather than hiding the rows. */
export function availableStateLayers(states = null) {
  return usableFamilies(states);
}

/** The context group's EXCLUSIVITY FOLLOWS HOW A ROW RENDERS, not what it is about (QQA-06d).
 *
 *  A row that fills the view as a picture -- `rasterSurface`: night lights at 0.8 and radar
 *  at 0.55 composite to under a tenth of whatever is beneath them, and NLCD, slope, the
 *  county wash and the hillshade fill the same way -- hides what is under it everywhere, so
 *  two of them stacked leave no base readable. Those are a choice of ONE, exactly like the
 *  base group above: radios, plus an explicit None (a reader who turned one on must be able
 *  to turn it off again; with radios alone there is no way back).
 *
 *  A row that draws vector ink on top -- NIFC fire perimeters (`L.geoJSON`), the AQI shaded
 *  box, smoke, flood zones, aurora, wildlife points -- hides nothing beneath it, so nothing
 *  makes it exclusive. Those are ordinary independent checkboxes in the same group, and they
 *  coexist with whichever surface is chosen: fire and air quality are visible together.
 *
 *  Both lists come from the one flag the surface budget (layer-presets.js) already counts, so
 *  there is no second table to drift. `CONTEXT_LAYER_IDS` stays every context row, because
 *  an old link or saved state naming fire as its surface (`s=nifcFirePerimeters`) must still
 *  parse and turn fire on: ids never change, only the control that carries them.
 *
 *  Each surface keeps the caveat it already carried and the report line it already writes
 *  into (`reportId`), so nothing about WHAT one draws changes here. */
export const CONTEXT_LAYERS = Object.freeze(LAYERS.filter((l) => l.group === 'context'));
export const CONTEXT_LAYER_IDS = Object.freeze(CONTEXT_LAYERS.map((l) => l.id));
export const CONTEXT_SURFACE_LAYERS = Object.freeze(CONTEXT_LAYERS.filter((l) => l.rasterSurface));
export const CONTEXT_SURFACE_IDS = Object.freeze(CONTEXT_SURFACE_LAYERS.map((l) => l.id));
export const CONTEXT_OVERLAY_LAYERS = Object.freeze(CONTEXT_LAYERS.filter((l) => !l.rasterSurface));
export const CONTEXT_OVERLAY_IDS = Object.freeze(CONTEXT_OVERLAY_LAYERS.map((l) => l.id));
export const DEFAULT_CONTEXT = 'none';
export const NO_CONTEXT_LABEL = 'No context surface';

export function contextControlSpecs(current = DEFAULT_CONTEXT) {
  const chosen = CONTEXT_SURFACE_IDS.includes(current) ? current : DEFAULT_CONTEXT;
  const row = (id, label, note) => ({
    id, group: 'context', type: 'radio', name: 'qcm-context', inputId: `qcm-context-${id}`,
    // The status line each surface already writes its age into. Keeping the id means
    // renderRadar and the others need no second table of where to put their words.
    reportId: `qcm-layer-${id}-report`,
    label, checked: id === chosen, disabled: false,
    note: note || null, noteId: note ? `qcm-context-${id}-note` : null,
  });
  return [...CONTEXT_SURFACE_LAYERS.map((l) => row(l.id, l.label, l.coverageCaveat)),
    row('none', NO_CONTEXT_LABEL, null)];
}

/** The words that put a surface's OWN time in front of a reader, chosen by the source's
 *  `claim` and by nothing else. Retrieval time is not in here at all: the time a picture was
 *  fetched is a fact about the network, and showing it where an observation time belongs is
 *  the misreading these surfaces are most prone to. */
const CLAIM_WORDS = Object.freeze({
  observation: Object.freeze({ at: 'Observed', unknown: 'the source did not say when it was observed, so its time is unknown' }),
  forecast: Object.freeze({ at: 'Forecast for', unknown: 'the source did not state a forecast time, so its time is unknown' }),
  inventory: Object.freeze({ at: 'Vintage', unknown: 'the source did not state a vintage, so its age is unknown' }),
  model: Object.freeze({ at: 'Modelled for', unknown: 'the source did not state a model time, so its time is unknown' }),
  calculation: Object.freeze({ at: 'Computed for', unknown: 'the source did not say what it was computed from, so its time is unknown' }),
});

const utcClock = (ms) => new Date(ms).toISOString().slice(11, 16);
const minutes = (n) => `${n} minute${n === 1 ? '' : 's'}`;

/** How far the surface's time is from now, in the reader's words. Both directions, because
 *  a forecast is ahead and an observation is behind and saying "ago" for either would be a
 *  claim about which. */
function gap(ms, nowMs) {
  const m = Math.round((ms - nowMs) / 60000);
  if (m === 0) return 'right now';
  return m > 0 ? `${minutes(m)} from now` : `${minutes(-m)} ago`;
}

/** The caption the map carries while a context surface is drawn: WHICH surface, and the
 *  time ITS data refers to. Pure, so the wording is proved here rather than in a browser.
 *
 *  Returns null for anything that is not a context surface -- 'none' included -- because
 *  nothing else is laid over the map as one. An unknown time is stated as unknown: never
 *  blank, and never quietly the wall clock. */
export function surfaceCaption(layerId, { timeMs = null, vintage = null, nowMs = Date.now() } = {}) {
  const layer = LAYER_BY_ID[layerId];
  if (!layer || layer.group !== 'context') return null;
  // A local-data context surface (countyScore today) names no measured service and so has
  // no `claim` of its own to look up -- it is always the dashboard's own vintage, the same
  // wording an inventory-claim source already carries.
  const claim = layer.sourceId ? SOURCES[layer.sourceId].claim : 'inventory';
  const words = CLAIM_WORDS[claim];
  const ms = Number(timeMs);
  let when;
  // A VINTAGE is a year, not a moment, and it is no longer only an inventory that has one:
  // the NLCD surfaces are annual MODELS, and stamping "Modelled for 00:00 UTC" on a year
  // would be a precision the product does not have. A surface that states a year gets the
  // year; the rest is unchanged, and the inventory wording is the same sentence it was.
  if (vintage) {
    when = `${words.at} ${vintage} — not a picture of now.`;
  } else if (claim === 'inventory') {
    when = `${words.unknown}.`;
  } else if (Number.isFinite(ms) && ms > 0) {
    when = `${words.at} ${utcClock(ms)} UTC, ${gap(ms, nowMs)}.`;
  } else {
    when = `${words.unknown}.`;
  }
  return Object.freeze({ layerId, claim, label: layer.label, when, text: `${layer.label} — ${when}` });
}

/** One radio per screen base. Print is untouched: usgsTopo stays `required` above, so
 *  the sheet's raster is always topo whatever the screen shows. Same shape as a layer
 *  spec so main.js draws it with the same row. */
export function baseControlSpecs(current = DEFAULT_BASE) {
  return BASES.map((b) => ({
    id: b.id, group: 'base', type: 'radio', name: 'qcm-base', inputId: `qcm-base-${b.id}`,
    label: b.label, checked: b.id === current, disabled: false, note: null, noteId: null,
  }));
}

/** One spec per control row. Pure — main.js only turns these into elements.
 *  `registry` is injectable so a test can prove a THIRD layer renders without
 *  editing the real one; production always passes the real registry. */
export function layerControlSpecs(layers = {}, registry = LAYERS, states = null) {
  const codes = stateList(states);
  const available = new Set(usableFamilies(codes));
  return registry.map((l) => {
    // A state layer is offered only where a state covering the drawn area
    // publishes something this map can read. Saying WHY it is unavailable beats
    // hiding the row: a reader who came looking for game lands deserves an
    // answer, not a shorter list.
    const missing = l.stateScoped && !available.has(l.family);
    // These three sit in the same list as the layers that DRAW, are enabled from
    // the start, and change nothing visible when switched on: the difference is a
    // page in a PDF nobody has built yet. The registry has always known which
    // they are (`extraPage` keeps them out of the overlay fetch above); saying it
    // out loud is the whole fix.
    const printOnly = l.extraPage
      ? 'Adds a page to the printed PDF — it does not draw on the map.' : null;
    const why = !codes.length
      ? 'Draw an area first — state land layers depend on which state it is in.'
      : `Not published by ${codes.join(' or ')} in a form this map can read.`;
    return {
      id: l.id,
      group: l.group,
      inputId: `qcm-layer-${l.id}`,
      noteId: printOnly || l.coverageCaveat || l.status !== 'live' || missing ? `qcm-layer-${l.id}-note` : null,
      label: l.status === 'live' ? l.label : `${l.label} (coming)`,
      checked: (l.required || !!layers[l.id]) && !missing,
      disabled: l.required || l.status !== 'live' || missing,
      note: l.status !== 'live' ? 'Not available yet.'
        : (missing ? why : [printOnly, l.coverageCaveat].filter(Boolean).join(' ') || null),
    };
  });
}
