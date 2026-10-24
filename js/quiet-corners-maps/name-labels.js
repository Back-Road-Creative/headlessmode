// Screen declutter for named-terrain labels (GNIS, via terrain-names.js /
// source-terrain-names.js). Pure -- no DOM, no fetch, no Leaflet; the caller
// supplies `toPx` (lon, lat) -> {x, y} and `measureText` (name, sizePx) ->
// {width, height} (a canvas-measured box, never measured in here).
//
// Mirrors print-names.js's placeNameLabels (same 8-direction offset ring, same
// axis-aligned collision boxes) but for the screen surface: a provisional,
// density-scaled cap instead of "place everything, drop what does not fit",
// and hysteresis so a sub-pixel pan does not visibly shuffle which names show.
//
// Display-preference vocabulary is written to match Q/view-state.js's
// LABEL_DENSITIES ('sparse'|'standard'|'more') / LABEL_SIZES ('normal'|'large'|'xlarge')
// so a future wire-up of window.qcDisplay's `labels` field needs no adapter.
import { labelPriorityOrder } from './terrain-names.js';
import { NAME_ICON_BY_KIND } from './print-names.js';

export const DENSITY_CAP = Object.freeze({ sparse: 15, standard: 40, more: 60 });
// QQA-05a: 14 px is 0.875rem, the stylesheet's own default for every owned label
// (CSS `font-size: var(--qc-label-px, 0.875rem)`), so Normal draws what the CSS
// falls back to. Large and Extra large are the same scale in px; labelFontSize()
// below turns one into the rem string the CSS reads, so there is ONE size source.
export const SIZE_SCALE = Object.freeze({ normal: 14, large: 18, xlarge: 24 });

/** The CSS font-size value (rem, so the reader's root font size scales it) for a
 *  size pref -- what Q/main.js writes to --qc-label-px on the map container.
 *  An unknown or missing size falls back to normal, as placeScreenLabels does. */
export function labelFontSize(size) {
  return `${(SIZE_SCALE[size] || SIZE_SCALE.normal) / 16}rem`;
}

/** The face every owned label is drawn in (quiet-corners.css .qc-place-label,
 *  quiet-corners-maps.css .qcm-name-label / .qc-terrain-name-label) -- written
 *  here once so a layout measurement and the paint cannot disagree. */
export const LABEL_FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const LABEL_FONT_WEIGHT = 600;
/** The plate's padding (CSS `padding: 1px 5px`), counted in the reserved box. */
export const LABEL_PLATE_PAD_X = 5;
export const LABEL_PLATE_PAD_Y = 1;

/** Box of `text` drawn as an owned label at `sizePx`: the canvas-measured text in
 *  the label font, plus the plate's padding. `ctx` is a CanvasRenderingContext2D
 *  (the caller owns it -- this module touches no DOM). */
export function measureLabel(ctx, text, sizePx) {
  ctx.font = `${LABEL_FONT_WEIGHT} ${sizePx}px ${LABEL_FONT_FAMILY}`;
  return {
    width: ctx.measureText(text).width + 2 * LABEL_PLATE_PAD_X,
    height: sizePx * 1.2 + 2 * LABEL_PLATE_PAD_Y,
  };
}

/** How many slots the cap-cutoff loop guarantees a kind before the remainder
 *  fills by plain priority order -- so a numerous kind (town) cannot crowd a
 *  scarcer one (summit) out of the cap entirely (QUX-05b / U12). Never below 1
 *  -- a kind present at all is guaranteed at least one shot at a slot. */
export function kindFloor(cap, kindsPresent) {
  return Math.max(1, Math.floor(cap / Math.max(1, kindsPresent) / 2));
}

export const STATUS_MESSAGE = Object.freeze({
  zero: 'No named terrain found in this area.',
  // QUX-11a §2.5: replaces the old "showing nothing until it completes" text
  // -- a partial answer's features ARE shown, under Places in this view
  // (Q/places-in-view.js), even though the map still labels none of them.
  partial: 'Named terrain for this area came back with a different number of names than the '
    + 'service counted, so the map labels none of them. The names that arrived are listed under '
    + 'Places in this view.',
  // Static fallback; placeScreenLabels builds the real one from omittedKinds.
  capped: 'Showing the most important names here -- zoom in for more.',
  'over-cap': 'Too many named features here -- zoom in or refine the area.',
  timeout: 'Named terrain timed out for this area.',
  error: 'Named terrain could not load for this area.',
  // The river tier (NHD) is its own request: its failure is a note beside the names, never a status
  // that blanks the GNIS answer.
  rivers: 'Rivers did not load',
});

// Reading order of the message (not the label priority ladder): where you are, the skyline, then water.
const KIND_PHRASE = Object.freeze({
  place: 'places', summit: 'peaks', gap: 'gaps', ridge: 'ridges', river: 'rivers', creek: 'named creeks', 'other-land': 'other landforms',
  'stream-mouth': 'creeks', 'water-feature': 'lakes', 'other-water': 'other water', other: 'other names',
});
const phrases = (kinds) => Object.keys(KIND_PHRASE).filter((k) => kinds.includes(k)).map((k) => KIND_PHRASE[k]);
const joinAnd = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0] || '');

/** The honest message for a capped answer: what is drawn, what zooming in adds. */
export function cappedMessage(shownKinds, omittedKinds) {
  const shown = joinAnd(phrases(shownKinds));
  const omitted = joinAnd(phrases(omittedKinds));
  if (!shown || !omitted) return STATUS_MESSAGE.capped;
  return `Showing ${shown} here -- zoom in for ${omitted}`;
}

/** kind -> {marker, label}, or the 'other' fallback -- the same table pdf.js's
 *  print path uses, so a name's icon shape means the same thing on screen and
 *  on paper. */
export function iconFor(kind) {
  return NAME_ICON_BY_KIND[kind] || NAME_ICON_BY_KIND.other;
}

// QUX-05c: ONE field-list builder for the one details card a selected GNIS
// name opens, shared by the map-pin declutter loop and the search-selection
// path (Q/main.js) -- neither a missing county nor a missing state is ever
// silently blank or silently dropped, which the two bespoke builders this
// replaced both did.
export function countyStateLine(county, state) {
  if (county && state) return `${county}, ${state}`;
  if (county) return `${county}, state not published`;
  if (state) return `county not published, ${state}`;
  return 'County and state not published';
}

/** The one field list every selected-name card shows: name, kind, county/state
 *  (never blank), the GNIS source line, coordinates, and the one-published-
 *  point disclaimer. `anchor` is `[lat, lon]`, matching terrain-names.js's
 *  normalized shape. */
export function nameCardLines(name, kindLabel, county, state, anchor) {
  const [lat, lon] = anchor;
  return [
    name,
    kindLabel,
    countyStateLine(county, state),
    'Source: USGS GNIS',
    `Coordinates: ${lat.toFixed(4)}, ${lon.toFixed(4)}`,
    'Location is the published primary point, not every place this name is used.',
  ];
}

const boxOf = (cx, cy, w, h) => ({ minX: cx - w / 2, maxX: cx + w / 2, minY: cy - h / 2, maxY: cy + h / 2 });
const overlaps = (a, b) => a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;

/** A reserved box for a marker glyph in screen-pixel space -- the same shape
 *  print-names.js's markerBox uses on paper. */
export function markerBox(x, y, sizePx) { return boxOf(x, y, sizePx, sizePx); }

/** Trailing Census legal/statistical designators to strip before comparing a
 *  town orientation label's name (candidates.json carries the raw Census name,
 *  e.g. "Ashland town") against a GNIS feature's bare name ("Ashland"). Checked
 *  longest-first, so "Juneau city and borough" strips to "Juneau" rather than
 *  the first, shorter suffix that happens to match its tail ("...and borough").
 *  Matched case-sensitively and only at the very end of the string: a real
 *  place whose own name ends in a capitalized word that looks like a suffix
 *  ("Carson City") is never touched, and nothing mid-name is ever stripped. */
const CENSUS_SUFFIXES = [
  ' city and borough', ' municipality', ' borough', ' village', ' town', ' city', ' CDP',
];

/** Strips one trailing Census legal/statistical suffix from `name`, or returns
 *  it unchanged when none matches. Pure string op -- see CENSUS_SUFFIXES for
 *  which suffixes and why the match is case-sensitive. */
export function stripCensusSuffix(name) {
  const s = typeof name === 'string' ? name : '';
  for (const suffix of CENSUS_SUFFIXES) {
    if (s.endsWith(suffix)) return s.slice(0, -suffix.length);
  }
  return s;
}

/** Drops a GNIS feature that shares a name and state with an existing town
 *  orientation label (S/quiet-corners.js renderPlaceLabels), so the two
 *  declutter systems never draw the same town twice under different rules.
 *  Names are compared after stripCensusSuffix and a case-insensitive trim --
 *  a town label carries its raw Census name, a GNIS feature its bare one --
 *  but state still has to match exactly, so the same town name in two
 *  different states is never conflated. */
export function dedupeAgainstTownLabels(features, townLabels) {
  const list = Array.isArray(features) ? features : [];
  const town = Array.isArray(townLabels) ? townLabels : [];
  if (!town.length) return list;
  const key = (name, state) => `${stripCensusSuffix(name || '').trim().toLowerCase()}␟${state || ''}`;
  const taken = new Set(town.map((t) => key(t.name, t.state)));
  return list.filter((f) => !taken.has(key(f.name, f.state)));
}

/** GNIS names plus NHD river/creek records for one view. A GNIS stream-mouth record is dropped
 *  when an NHD record carries the same name (NHD has no state, so a null state matches any), so a
 *  stream is named once, on the reach in view rather than at its mouth. */
export function mergeStreamNames(gnisFeatures, streamFeatures) {
  const gnis = Array.isArray(gnisFeatures) ? gnisFeatures : [];
  const streams = Array.isArray(streamFeatures) ? streamFeatures : [];
  if (!streams.length) return gnis;
  const norm = (n) => String(n || '').trim().toLowerCase();
  const taken = streams.map((f) => [norm(f.name), f.state || null]);
  const dup = (f) => f.kind === 'stream-mouth' && taken.some(([n, st]) => n === norm(f.name) && (!st || !f.state || st === f.state));
  return [...gnis.filter((f) => !dup(f)), ...streams];
}

/** Whether a names fetch that started when the generation counter read `token`
 *  is stale: true exactly when a newer viewport settle has since started its
 *  own fetch and bumped the counter to `current`. The caller drops (never
 *  applies) a stale result, so a response for an older area can never replace
 *  the current one, no matter the order responses arrive in. */
export function isStaleGeneration(token, current) {
  return token !== current;
}

/** Builds the `adapters.names` transport shape print-names.js documents:
 *  `{status, features, retrievedAt}`. `result` is fetchBounded's return value
 *  (which carries `features` only for 'ready'/'partial'); `null` in means no
 *  fetch was ever asked for, so no adapter is handed to the print build. */
export function namesAdapterPayload(result, retrievedAt) {
  if (!result) return null;
  return { status: result.status, features: result.features || [], retrievedAt };
}

// A fixed, deterministic ring of candidate label offsets around the anchor,
// tried in this order -- same convention as print-names.js's placement ring.
const OFFSETS = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];

/** Previously-placed features are tried before newcomers, within their
 *  existing relative order -- the hysteresis rule: nothing already on screen
 *  loses its slot to a same-priority feature just because the viewport moved
 *  a couple of pixels, since it gets first shot at the collision budget. */
function orderForHysteresis(prioritized, previousIds) {
  if (!previousIds || previousIds.size === 0) return prioritized;
  const kept = [];
  const fresh = [];
  for (const f of prioritized) (previousIds.has(f.id) ? kept : fresh).push(f);
  return [...kept, ...fresh];
}

/** Deterministic screen declutter. `features` need not be pre-sorted or
 *  pre-deduped -- ordering goes through terrain-names.js's labelPriorityOrder
 *  (selected first, then priority/name/id), so shuffled input always produces
 *  the same placed set. `status` (fetchBounded's status) gates placement
 *  outright: only 'ready' and 'capped' (an honest, labelled subset) place a label, so a
 *  partial/over-cap/timeout/error result never draws a silently-incomplete "complete" layer. */
export function placeScreenLabels(features, {
  toPx, viewport, measureText, prefs = {}, selectedId = null, zoom,
  reserved = [], previous = null, status = 'ready', marginPx = 4, omittedKinds = [],
} = {}) {
  const list = Array.isArray(features) ? features : [];
  if (status !== 'ready' && status !== 'capped') return { placed: [], dropped: list.length, message: STATUS_MESSAGE[status] || null };
  if (!list.length) return { placed: [], dropped: 0, message: STATUS_MESSAGE.zero };

  const message = status === 'capped'
    ? cappedMessage(labelPriorityOrder(list, {}).map((f) => f.kind), omittedKinds) : null;
  const prioritized = labelPriorityOrder(list, { zoom, selectedId });
  const previousIds = previous instanceof Set ? previous : (previous ? new Set(previous) : null);
  const ordered = orderForHysteresis(prioritized, previousIds);

  const density = DENSITY_CAP[prefs.density] != null ? prefs.density : 'standard';
  const cap = DENSITY_CAP[density];
  const sizePx = SIZE_SCALE[prefs.size] || SIZE_SCALE.normal;

  // Kind budgets: split `ordered` into a floor-guaranteed tier (up to
  // kindFloor(cap, kindsPresent) of each present kind, in their existing
  // relative order -- so the selected feature, already sorted first, always
  // lands in tier 1) and a remainder tier that fills whatever the cap has
  // left over, still in priority order. Concatenating the two preserves
  // `ordered`'s own order whenever only one kind is present (every item then
  // belongs to the same running counter), so single-kind callers see no
  // change at all.
  const kindsPresent = new Set(ordered.map((f) => f.kind)).size;
  const floor = kindFloor(cap, kindsPresent);
  const floorRemaining = new Map();
  const tier1 = [];
  const tier2 = [];
  for (const f of ordered) {
    if (!floorRemaining.has(f.kind)) floorRemaining.set(f.kind, floor);
    const remaining = floorRemaining.get(f.kind);
    if (remaining > 0) {
      tier1.push(f);
      floorRemaining.set(f.kind, remaining - 1);
    } else {
      tier2.push(f);
    }
  }
  const budgeted = [...tier1, ...tier2];

  const boxes = [...reserved];
  const placed = [];
  let dropped = 0;
  let placedCount = 0;

  for (const f of budgeted) {
    if (placedCount >= cap) { dropped++; continue; }
    const p = toPx(f.anchor[1], f.anchor[0]);
    const icon = iconFor(f.kind);
    const markAt = markerBox(p.x, p.y, sizePx);
    // QUX-11a §2.5: reserves the anchor's box whether or not a label fits;
    // main.js draws a marker only for a placed name (or the selected one).
    boxes.push(markAt);
    const { width: w, height: h } = measureText(f.name, sizePx);
    const gap = sizePx * 0.5;
    let placement = null;
    for (const [dx, dy] of OFFSETS) {
      const cx = p.x + dx * (w / 2 + gap);
      const cy = p.y + dy * (h / 2 + gap);
      const box = boxOf(cx, cy, w, h);
      if (viewport && (box.minX < -marginPx || box.maxX > viewport.width + marginPx
        || box.minY < -marginPx || box.maxY > viewport.height + marginPx)) continue;
      if (boxes.some((b) => overlaps(b, box))) continue;
      placement = { x: cx, y: cy, box };
      break;
    }
    if (!placement) { dropped++; continue; }
    boxes.push(placement.box);
    placed.push({
      id: f.id, name: f.name, kind: f.kind, state: f.state, county: f.county,
      marker: icon.marker, iconLabel: icon.label,
      x: p.x, y: p.y, labelX: placement.x, labelY: placement.y,
      sizePx,
      selected: f.id === selectedId,
    });
    placedCount++;
  }
  return { placed, dropped, message };
}
