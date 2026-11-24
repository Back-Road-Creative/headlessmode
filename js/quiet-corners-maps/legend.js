// Legend vocabulary for Quiet Corners Field Maps. Pure data plus pure
// derivations: the legend page lists only symbols that were actually drawn.
//
// ONE physical table. Dash lengths and line widths live here in INCHES -- the
// only unit both renderers derive from (pt = in * 72, px = in * dpi). Before
// this, three tables disagreed: pdf.js stroked the legend swatch at [6, 3] pt
// (0.083 in) while the worker stroked the map at [12, 6] px @300 dpi (0.040 in),
// so the printed key showed a dash twice as long as the map it described, in
// black, at a different width. Add a symbol here; never restate its numbers.
import { POINTS_PER_INCH } from './sheet-plan.js';

const ROAD = '#b3261e';
const TRAIL = '#6a1b9a';
// Non-motorized trails are a different feature class from MVUM's motorized trails,
// so they need their own hue. Orange is unclaimed by the USGS raster underneath
// (brown contours, blue water, green vegetation, grey, red roads) and by us.
const FOOT = '#c9701e';
// Recreation points. USGS convention draws campgrounds and trailheads RED --
// the hue already spent on MVUM roads here, so a trailhead would read as a road.
// Keeping USGS's SHAPES and departing from its colour, deliberately.
const REC = '#2e7d32';
// State land BOUNDARIES. Blue is the one hue left that the USGS raster spends only
// on water, and a boundary never follows a watercourse closely enough to be taken
// for one. It is deliberately NOT distinguished by colour alone: every land
// boundary also carries the `boundary` dash below, which nothing else uses, so the
// class survives the grayscale halftone even if the hue does not. PROOF.md step 9
// is what settles that on paper.
const LAND = '#1a4f8a';
// Parcel boundaries. Grey, not the public-land blue: a parcel is mostly PRIVATE
// property and the land hue would tell a reader they may walk there. Thin and SOLID
// -- the one boundary treatment left, distinct from state (`boundary`), federal
// (dash-dot) and county (dash-dot-dot) by pattern, and from a road by being a third
// its width. Cadastral lines are drawn as fine hairlines for the same reason: they
// are context under the map, not a feature of it.
const PARCEL = '#5a5a5a';
// Mapped wetlands. Its own hue and NOT the LAND blue: a wetland is neither a
// landholding nor a designation, and the public-land blue would say a reader may
// walk there. Teal is unclaimed by the raster (brown contours, blue water, green
// vegetation) and by every mark above. ONE mark, not the service's eight renderer
// classes: eight fills on one sheet is a symbol quiz, and the class a polygon
// carries is named in the layer's row instead.
const WETLAND = '#1f6f78';
const INK = '#000000';
const DEFAULT_WIDTH_IN = 0.8 / 72;

// The SCREEN is not a halftone. On paper the seven land-boundary families share one
// blue, told apart by dash and width, because the sheet is a grayscale halftone
// and a hue would not survive it (LAND, above). On screen that same treatment was
// seven blue dashed hairlines, 1.2 to 2.3 px, unfilled, over a raster whose water
// is blue too: nobody could find a state park, let alone tell it from a refuge.
// So the table carries a SCREEN colour per family and draws each as a filled area.
// Federal designations are the deep, saturated set; state families are the lighter
// set; every hue is unclaimed by the raster (brown contours, blue water, green
// woodland) and by the roads, trails, sites and parcels already drawn on screen.
// The paper values do not move: `color` is still what pdf.js and the worker use.
const SCREEN_HUE = Object.freeze({
  wilderness: '#a01a6c', nationalPark: '#4a5fd6', refuge: '#00897b', nationalForest: '#8a6d00',
  gameLand: '#00a5c8', statePark: '#8bc34a', stateManaged: '#e0508a',
});
// Below this a boundary is a hairline that vanishes against the raster; the paper
// width is honoured above it. `minPx` is a screen quantity, so it lives in `screen`.
const BOUNDARY_MIN_PX = 2.5;
const HAIRLINE_MIN_PX = 1.5;
/** The same symbol with its on-screen drawing declared beside its paper one. */
const onScreen = (symbol, { color = symbol.color, fill = false, minPx = BOUNDARY_MIN_PX } = {}) =>
  ({ ...symbol, screen: Object.freeze({ color, fill, minPx }) });
const area = (symbol, color) => onScreen(symbol, { color, fill: true });

/** Dash patterns as physical lengths on paper, in inches. */
// `boundary` is a KIND, not a season. The pattern axis otherwise means "when is
// this usable" (solid yearlong / dash seasonal / dot the source did not say), and
// that question is not asked of an area outline: a designation boundary is there
// all year. A long dash is what USGS itself draws an administrative boundary with,
// and it is long enough that no reader confuses it with the seasonal dash.
// `federal` is the same idea one level up: a designation boundary that is there all
// year, administered by a different government. Dash-DOT rather than a second dash
// length, because two long dashes differing only in length are not separable on a
// halftoned sheet, and the dot is the one mark the pattern axis has left.
// `county` is dash-DOT-DOT, the mark USGS itself puts on a county line, and one dot
// more than `federal` so the two stay separable after the halftone.
export const DASH_IN = Object.freeze({
  solid: [], dash: [12 / 300, 6 / 300], dot: [2 / 300, 5 / 300], boundary: [24 / 300, 8 / 300],
  federal: [24 / 300, 6 / 300, 4 / 300, 6 / 300],
  county: [24 / 300, 6 / 300, 4 / 300, 6 / 300, 4 / 300, 6 / 300],
  // `ownership` is a SHORT dash-dot: a third the federal dash, so the two survive
  // the halftone apart, and a dash rather than solid so it is not a parcel line.
  ownership: [8 / 300, 4 / 300, 2 / 300, 4 / 300],
  // `wetland` is an EVEN short dash, the one rhythm left: no long run like the
  // boundary dashes, no dots to be read as `federal` or `county`. Even, because the
  // edge it draws is genuinely approximate -- FWS states a margin of error is
  // inherent and that inspection on the ground may revise any boundary -- and a
  // solid line would claim a precision the photo-interpretation does not have.
  wetland: [4 / 300, 4 / 300],
});

// Inches carry more precision than either output unit needs; rounding at the
// boundary keeps 12/300 * 300 from arriving as 12.000000000000002.
const round = (v) => Math.round(v * 1e6) / 1e6;

/** Dash array for `pattern` in PDF points. */
export const dashPt = (pattern) => (DASH_IN[pattern] || []).map((v) => round(v * POINTS_PER_INCH));
/** Dash array for `pattern` in device pixels at `dpi`. */
export const dashPx = (pattern, dpi) => (DASH_IN[pattern] || []).map((v) => round(v * dpi));
/** Line width in PDF points. */
export const widthPt = (widthIn) => round(widthIn * POINTS_PER_INCH);
/** Line width in device pixels at `dpi`. */
export const widthPx = (widthIn, dpi) => round(widthIn * dpi);

const line = (key, label, pattern, widthIn, color) => ({ key, label, kind: 'line', pattern, widthIn, color });
// A point is sized in inches like everything else, so it scales with the sheet
// rather than with the device. 0.09 in is about 2.3 mm -- readable, and small
// enough that thirteen of them do not crowd a quad.
const POINT_SIZE_IN = 0.09;
const point = (key, label, marker, color) => ({ key, label, kind: 'point', marker, sizeIn: POINT_SIZE_IN, color });

export const SYMBOLS = Object.freeze({
  basemap: { key: 'usgs-topo', label: 'USGS Topo base map', kind: 'raster' },
  // A road's NAME on the screen map (QQA-05r-3): amber lettering on the dark plate, so the key
  // says what an amber plate is. `kind: 'text'` is a fourth kind; `screenOnly` keeps it off the
  // printed key, where the base map's own road lettering is not this app's mark.
  roadName: { key: 'road-name', label: 'Road name', kind: 'text', sample: 'Rd', color: '#fde68a', plate: '#0d0d1a', screenOnly: true },
  roadYearlong: line('mvum-road-yearlong', 'Forest road, open year-round (MVUM)', 'solid', 5 / 300, ROAD),
  // The promise is back because `seasonalRoutes` below carries the stated windows
  // onto this page. It was removed one commit ago because nothing wrote a date to
  // any sheet.
  roadSeasonal: line('mvum-road-seasonal', 'Forest road, seasonal (open dates on this key)', 'dash', 5 / 300, ROAD),
  roadUnknown: line('mvum-road-unknown', 'Forest road, season not stated by the source', 'dot', 5 / 300, ROAD),
  trailYearlong: line('mvum-trail-yearlong', 'Forest trail, open year-round (MVUM)', 'solid', 3 / 300, TRAIL),
  trailSeasonal: line('mvum-trail-seasonal', 'Forest trail, seasonal (open dates on this key)', 'dash', 3 / 300, TRAIL),
  trailUnknown: line('mvum-trail-unknown', 'Forest trail, season not stated by the source', 'dot', 3 / 300, TRAIL),
  // Non-motorized trails. Width carries designation prominence here rather than
  // difficulty: this source publishes no trail class, and `seasonopen` came back
  // empty for every record measured, so the pattern axis stays free to mean what
  // it already means -- dot is "the source did not say".
  trailNonMotor: line('trail-nonmotor', 'Trail, non-motorized (allowed uses lettered on the sheet)', 'solid', 2 / 300, FOOT),
  trailNonMotorUnstated: line('trail-nonmotor-unstated', 'Trail, allowed uses not published by the source', 'dot', 2 / 300, FOOT),
  trailNst: line('trail-nst', 'National Scenic or Historic Trail', 'solid', 3.5 / 300, FOOT),
  // Recreation points. `kind: 'point'` is a third kind alongside line and raster;
  // `marker` names the shape, `sizeIn` its drawn size on paper.
  recCampground: point('rec-campground', 'Campground', 'triangle', REC),
  recShelter: point('rec-shelter', 'Shelter or primitive camping area', 'house', REC),
  recTrailhead: point('rec-trailhead', 'Trailhead', 'square', REC),
  recSite: point('rec-site', 'Other recreation site', 'dot', REC),
  // Road quality rides the WIDTH axis, never the pattern axis: pattern already
  // means season above (solid yearlong / dash seasonal / dot unstated), and a
  // road's maintenance level and its season are independent facts. A dash that
  // meant either would be a swatch that cannot say which.
  roadHigh: line('road-high', 'Forest road, paved or well surfaced (level 4-5)', 'solid', 7 / 300, ROAD),
  roadPassenger: line('road-passenger', 'Forest road, suitable for passenger cars (level 3)', 'solid', 5 / 300, ROAD),
  roadHighClearance: line('road-highclearance', 'Forest road, high-clearance vehicles (level 2)', 'solid', 3.5 / 300, ROAD),
  roadPrimitive: line('road-primitive', 'Forest road, not maintained for standard vehicles (level 1)', 'solid', 2.5 / 300, ROAD),
  // State land boundaries. One symbol per family rather than one for "state land":
  // a game land and a state park are governed by different agencies under different
  // rules, and a sheet that merged them would tell the reader less than the source
  // knows. Width separates them where colour and pattern cannot -- these are the
  // only three symbols sharing both.
  landGame: area(line('land-game', 'State game land or wildlife management area (boundary)', 'boundary', 3 / 300, LAND), SCREEN_HUE.gameLand),
  landPark: area(line('land-park', 'State park or forest (boundary)', 'boundary', 4 / 300, LAND), SCREEN_HUE.statePark),
  landManaged: area(line('land-managed', 'Other state-managed area (boundary)', 'boundary', 2 / 300, LAND), SCREEN_HUE.stateManaged),
  // Federal designations, from one national service. Same blue -- colour says what
  // a thing IS, and this is public land like the three above -- with the `federal`
  // dash-dot saying it answers to a different government. Zero new colour classes,
  // which is what keeps the sheet legible once the halftone flattens the hues.
  // Wilderness is widest: it is the strictest designation on the sheet and the one
  // whose line changes what a reader may legally do inside it.
  fedWilderness: area(line('fed-wilderness', 'Designated Wilderness (boundary)', 'federal', 4 / 300, LAND), SCREEN_HUE.wilderness),
  fedPark: area(line('fed-park', 'National Park System unit (boundary)', 'federal', 3 / 300, LAND), SCREEN_HUE.nationalPark),
  fedRefuge: area(line('fed-refuge', 'National Wildlife Refuge (boundary)', 'federal', 2.5 / 300, LAND), SCREEN_HUE.refuge),
  fedForest: area(line('fed-forest', 'National Forest (boundary)', 'federal', 2.5 / 300, LAND), SCREEN_HUE.nationalForest),
  // Black, not LAND blue, and deliberately: a county line is a jurisdiction, not a
  // landholding, and drawing it in the public-land hue would say it encloses land
  // you may walk on. Thin, because it is context under everything else on the sheet.
  countyLine: onScreen(line('county-line', 'County boundary', 'county', 2 / 300, INK), { minPx: HAIRLINE_MIN_PX }),
  parcelLine: onScreen(line('parcel-line', 'Parcel boundary (county record)', 'solid', 1.5 / 300, PARCEL), { minPx: HAIRLINE_MIN_PX }),
  // Surface ownership, parcel by parcel, inside a National Forest. LAND blue for
  // ground the Forest Service owns -- it IS public land -- and the parcel grey for a
  // parcel it disposed of, which is somebody else's now. Hairline: 81 of these sit
  // in one quad, and the width is where density is answered, not the toggle.
  ownNfs: onScreen(line('own-nfs', 'National Forest System land, Forest Service owned (parcel boundary)', 'ownership', 1.5 / 300, LAND), { minPx: HAIRLINE_MIN_PX }),
  ownOther: onScreen(line('own-other', 'Inside a National Forest, not Forest Service owned (parcel boundary)', 'ownership', 1.5 / 300, PARCEL), { minPx: HAIRLINE_MIN_PX }),
  // Mapped wetland. Filled on screen like the designation areas, because a wetland is
  // a patch of ground and not a line; hairline on paper, because a dense marsh returns
  // more than a thousand of them in one desktop view and width is where density is
  // answered. The label says INVENTORY, not "wetland": what is drawn is a catalogue
  // with a vintage, and the year it was drawn from is in the layer's own row.
  wetlandNwi: area(line('wetland-nwi', 'Mapped wetland (National Wetlands Inventory, from aerial imagery)', 'wetland', 1.5 / 300, WETLAND), '#2bb3c0'),
  // Named terrain (GNIS), screen-side owned by Q/name-labels.js and printed by
  // Q/print-names.js -- ONE marker-shape vocabulary shared by both surfaces so a
  // name's icon means the same thing on screen and on paper. print-names.js's own
  // NAME_ICON_BY_KIND table is the source of these shapes/labels; kept here too
  // (rather than only there) because layer-registry.test.mjs requires every
  // non-'reading' layer's `symbolKeys` to resolve against this frozen table, and
  // that invariant is not weakened for one layer. Black ink, like a name label's
  // own text -- the SHAPE carries kind identity, not a colour already spent above.
  nameSummit: point('name-summit', 'Named summit', 'triangle', INK),
  nameGap: point('name-gap', 'Named gap or pass', 'chevron', INK),
  nameRidge: point('name-ridge', 'Named ridge or range', 'zigzag', INK),
  nameWaterFeature: point('name-water-feature', 'Named falls, spring, lake or reservoir', 'droplet', INK),
  nameOtherLand: point('name-other-land', 'Other named landform', 'diamond', INK),
  nameOtherWater: point('name-other-water', 'Other named water feature', 'wave', INK),
  namePlace: point('name-place', 'Named place', 'square', INK),
  nameRiver: point('name-river', 'Named river (labelled on the reach in view)', 'wave', INK),
  nameCreek: point('name-creek', 'Named creek (labelled on the reach in view)', 'wave', INK),
  nameStreamMouth: point('name-stream-mouth', 'Named stream or canal (labelled at its mouth)', 'dot', INK),
  nameOther: point('name-other', 'Other named feature', 'diamond', INK),
  // BTS NTAD rail and airports (screen-only layers, source-ntad-rail-airports.js): the sources a
  // noise map is made of. Rail is a SOLID dark line, the one hue the roads, trails and boundaries
  // above do not use; an airport is a round dot in a blue none of the named-place marks carry.
  railLine: onScreen(line('rail-class1', 'Class I rail line (BTS)', 'solid', 3 / 300, '#37474f'), { minPx: 2 }),
  airport: point('airport-public', 'Public-use airport (FAA list)', 'dot', '#0b5394'),
  // National Register of Historic Places (screen-only, source-nrhp.js): a diamond in a brown no
  // other mark carries, so a listed property is not read as a named landform (a black diamond).
  historicPlace: point('historic-place', 'Historic place (National Register of Historic Places)', 'diamond', '#8d4a1f'),
  // SNOTEL snowpack sites (screen-only, source-snotel.js): a teal square no other mark carries.
  snotelSite: point('snotel-site', 'SNOTEL snowpack site (USDA NRCS)', 'square', '#0f4c5c'),
  // Sheet chrome, not a feature: the grid is drawn by the page layout at its own
  // width, never handed to the worker as an overlay vector. `chrome` is what keeps
  // it out of STYLE — a prefix filter there is what kept real features OUT.
  // `paperOnly` is a second, separate fact from `chrome`: chrome says the worker is
  // never handed this as an overlay vector, paperOnly says the mark does not exist
  // on the screen map at all. The on-page key led with both of these, so a phone
  // reader was told about sheet seams and grid ticks before anything actually drawn
  // in front of them (audit A11).
  utmGrid: { ...line('utm-grid', 'UTM grid, 1 km', 'solid', 0.4 / 72, INK), chrome: true, paperOnly: true },
  overlapTicks: { key: 'overlap-ticks', label: 'Overlap with the neighbouring sheet: grey band, edge ticks, corner crosses', kind: 'tick', paperOnly: true },
});

/** Symbols by their `key`, for renderers that hold a key rather than a symbol. */
export const SYMBOL_BY_KEY = Object.freeze(Object.fromEntries(Object.values(SYMBOLS).map((s) => [s.key, s])));

/** Everything needed to draw one swatch, in physical units. The screen legend
 *  and the printed key both go through here, so neither can drift from the map. */
export function swatchSpec(symbol) {
  const s = symbol || {};
  const widthIn = s.widthIn || DEFAULT_WIDTH_IN;
  return {
    key: s.key, label: s.label, kind: s.kind || 'line', pattern: s.pattern || 'solid',
    dashIn: DASH_IN[s.pattern] || [], widthIn, widthPt: widthPt(widthIn), color: s.color || INK,
    marker: s.marker || null, sizeIn: s.sizeIn || null, sizePt: s.sizeIn ? widthPt(s.sizeIn) : null,
  };
}

export const DISCLAIMER = 'Road-use designations and seasons come from the Forest Service Motor Vehicle Use Map for the forests that publish it. They are not a statement of current passability or of temporary closures. Check current orders with the managing forest before travel.';

/** The sentence a drawn boundary obliges the sheet to carry. It lived in
 *  source-land-boundaries.js, exported and tested and read by nothing: no page
 *  and no PDF ever printed it, so the map drew designation lines with no word
 *  about what they do and do not permit. It belongs beside DISCLAIMER, because
 *  what a notice attaches to is a SYMBOL, and this is the file that owns those. */
export const LAND_COVERAGE_SEMANTICS =
  'A boundary marks where a designation begins and ends. It is not a statement that the ground '
  + 'inside is open to the public, nor that the ground outside is closed. An empty result means '
  + "the state's service returned nothing for this area, which is not the same as \"no public "
  + 'land here". Confirm access and current closures with the managing agency before you travel.';

/** What a parcel line is, and what it is not. Its own notice rather than the land one
 *  above: the land notice answers "may I walk here" for PUBLIC ground, and a parcel is
 *  mostly private, where the honest answers are different ones. A parcel line is a
 *  county's tax and recording record, drawn to locate a property, not surveyed to
 *  establish where its corners are -- the two disagree routinely, and the record is
 *  not the authority on the ground. */
export const PARCEL_SEMANTICS =
  'Parcel lines are the county\'s own record of who is taxed for what. They are not a survey and '
  + 'do not establish a boundary on the ground; a recorded line and a surveyed line often disagree. '
  + 'They are not permission to enter, and coverage varies county by county, so a blank area means '
  + 'the county published nothing here rather than that the ground is unowned.';

/** What a wetland mark obliges the sheet to carry. Its own notice, beside the two
 *  above, because it answers a different question: the land notice answers "may I walk
 *  here" for public ground, the parcel notice "whose is this", and this one "is this
 *  line current, and does it mean anything legally" — to which FWS's own Limitations
 *  page says no, twice over. Lives here, with the other notices, because what a notice
 *  attaches to is a SYMBOL; source-wetlands.js re-exports it beside the layer's words. */
export const WETLAND_SEMANTICS =
  'Wetland boundaries are a reconnaissance inventory drawn from aerial imagery, not a survey: FWS '
  + 'states a margin of error is inherent and that inspection on the ground may revise any boundary. '
  + 'They use a biological definition that may not match Clean Water Act boundaries and must not be '
  + 'read as the presence, absence or extent of wetlands regulated by any federal, state, Tribal or '
  + 'local law, nor as a statement of access. Some farmed wetlands, seagrass and submerged aquatic '
  + 'vegetation are excluded from the programme outright, so an unmarked area is not proof of dry '
  + 'ground. Check with the managing agency before you rely on a line.';

/** Which notice each symbol family obliges. Matched on the drawn keys, never
 *  hand-listed per build: a symbol added to a family brings its notice with it,
 *  which is what stopped being true when land symbols shipped without one. */
// Prefixes, plural: state and federal boundaries oblige the SAME notice, and two
// rows carrying the same text would print it twice on a sheet drawing both.
const NOTICES = Object.freeze([
  Object.freeze({ prefixes: ['mvum-'], text: DISCLAIMER }),
  Object.freeze({ prefixes: ['land-', 'fed-', 'own-'], text: LAND_COVERAGE_SEMANTICS }),
  Object.freeze({ prefixes: ['parcel-'], text: PARCEL_SEMANTICS }),
  Object.freeze({ prefixes: ['wetland-'], text: WETLAND_SEMANTICS }),
]);

// Reading order on the printed key: base map, then roads, then trails, then the
// sheet's own furniture last. Anything NOT named here still appears — appended in
// table order, just before the furniture — because a symbol the sheet drew and the
// key omits is a mark the reader cannot look up. Hand-listing every symbol is how
// trails, rec sites, road quality tiers and land boundaries came to be drawn on
// the map and missing from the legend.
const ORDER_HEAD = ['basemap', 'roadYearlong', 'roadSeasonal', 'roadUnknown',
  'roadHigh', 'roadPassenger', 'roadHighClearance', 'roadPrimitive',
  'trailYearlong', 'trailSeasonal', 'trailUnknown'];
const ORDER_TAIL = ['utmGrid', 'overlapTicks'];
const ORDER = [
  ...ORDER_HEAD,
  ...Object.keys(SYMBOLS).filter((k) => !ORDER_HEAD.includes(k) && !ORDER_TAIL.includes(k)),
  ...ORDER_TAIL,
];

/** The width a road is drawn at, given its quality tier. Falls back to the
 *  season symbol's own width when the road inventory had no record for it. */
export function widthInForTier(tier, fallbackIn) {
  const symbol = tier ? SYMBOL_BY_KEY[tier] : null;
  return symbol ? symbol.widthIn : fallbackIn;
}

/** Symbol for a rendered MVUM feature: { layer: 'road'|'trail', seasonal: 'seasonal'|'yearlong'|null }. */
export function symbolForFeature(f) {
  const season = f.seasonal === 'seasonal' || f.seasonal === 'yearlong' ? f.seasonal : 'unknown';
  return SYMBOLS[(f.layer === 'trail' ? 'trail' : 'road') + season[0].toUpperCase() + season.slice(1)];
}

/** Legend entries in fixed order from the symbol keys actually drawn, plus every
 *  notice those keys oblige. */
export function deriveLegend({ renderedSymbolKeys, gridEnabled, basemapRendered, seasonalWindows = null }) {
  const keys = new Set(renderedSymbolKeys);
  if (basemapRendered) keys.add(SYMBOLS.basemap.key);
  if (gridEnabled) keys.add(SYMBOLS.utmGrid.key); else keys.delete(SYMBOLS.utmGrid.key);
  const entries = ORDER.map((k) => SYMBOLS[k]).filter((s) => keys.has(s.key));
  const notices = NOTICES.filter((n) => entries.some((s) => n.prefixes.some((p) => s.key.startsWith(p)))).map((n) => n.text);
  // The open dates, but only when a seasonal symbol is actually on this sheet: a
  // heading over an empty list reads as "nothing here is seasonal", which is a
  // claim about the ground rather than about what was drawn.
  const anySeasonal = entries.some((s) => s.key.endsWith('-seasonal'));
  const w = anySeasonal && seasonalWindows ? seasonalWindows : { lines: [], undated: 0 };
  // The undated routes are counted, never dropped. A list of only the dated ones
  // would read as "these are the seasonal roads here", and a reader would drive an
  // unlisted one in February on the strength of it.
  const missing = w.undated > 0
    ? [`${w.undated} more seasonal route${w.undated === 1 ? '' : 's'} here: the source gave no dates for ${w.undated === 1 ? 'it' : 'them'}.`]
    : [];
  return { entries, notices, seasonalRoutes: [...w.lines, ...missing], pages: 1 };
}
