// The legend, on screen. Pure: builds SVG markup strings and row specs from the
// same SYMBOLS table pdf.js prints from, so what the page shows and what the
// sheet prints cannot drift.
//
// One table, two MEDIA. `medium: 'screen'` is a key to the map in front of the
// reader; the default, 'paper', is a key to a printed sheet. They read the same
// symbols and differ only where the two surfaces really differ: the grid and the
// sheet seams are marks on paper alone, and a screen has a zoom, so a symbol the
// map is currently too coarse to draw is named as such instead of being promised.
//
// SVG, not CSS: `border-style: dashed` gives browser-chosen dash lengths that
// cannot be set and cannot be asserted, so a CSS swatch could never be proved
// equal to what pdf.js strokes. `stroke-dasharray` maps 1:1 onto both
// ctx.setLineDash() and pdf-lib's dashArray, so all three read one table.
import { SYMBOLS, swatchSpec, deriveLegend } from './legend.js';
import { markerPath } from './pdf.js';
import { enabledLayers, LAYERS } from './layer-registry.js';
import { drawsAtScale } from './overlay-paths.js';
import { layersForZoom } from './road-names.js';
import { BASE_BY_ID, DEFAULT_BASE } from './source-basemaps.js';

const CSS_PX_PER_IN = 96;
// A 0.0067 in dot is a third of a screen pixel at 1:1. The swatch is a diagram,
// not a proof of scale, so it is magnified -- but by ONE scalar, so every ratio
// the reader compares (dash to gap, road to trail) survives.
const ZOOM = 3;
const W = 48;
const H = 14;

const px = (inches) => +(inches * CSS_PX_PER_IN * ZOOM).toFixed(2);
const svg = (body) => `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true" focusable="false">${body}</svg>`;

/** Inline SVG for one symbol's swatch. Interpolates only frozen constants --
 *  labels go into the DOM as textContent, never into this string. */
export function legendSwatchSvg(symbol, { medium = 'paper' } = {}) {
  const s = swatchSpec(symbol);
  // The screen draws some symbols differently from the sheet (legend.js `screen`):
  // its own hue, and an area for a land boundary. The screen key shows THAT, or
  // it is a key to a different map. The paper key keeps the paper ink.
  const screen = medium === 'screen' && symbol && symbol.screen ? symbol.screen : null;
  if (s.kind === 'raster') return svg(`<rect x="1" y="3" width="${W - 2}" height="8" fill="#d9d9d9" stroke="#9a9a9a" stroke-width="0.5"/>`);
  if (s.kind === 'text') {
    // The sample is the plate itself: the symbol's own colours, never a label from data.
    return svg(`<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="3" fill="${symbol.plate}" fill-opacity="0.82"/><text x="${W / 2}" y="${H / 2 + 3.5}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" font-weight="600" fill="${s.color}">${symbol.sample}</text>`);
  }
  if (s.kind === 'tick') {
    const ticks = [1, W / 2, W - 1].map((x) => `<line x1="${x}" y1="2" x2="${x}" y2="${H - 2}" stroke="#000" stroke-width="1"/>`).join('');
    return svg(`<rect x="1" y="2" width="${W - 2}" height="${H - 4}" fill="#000" fill-opacity="0.03"/>${ticks}`);
  }
  if (s.kind === 'point') {
    // The sheet's own outline, at the largest size the swatch row can hold. A
    // point used to fall through to the line branch below, so four differently
    // shaped symbols all drew the same short stroke.
    const size = Math.min(H - 3, px(s.sizeIn) || H - 3);
    const ring = markerPath(s.marker, W / 2, H / 2, size);
    const body = ring
      ? `<polygon points="${ring.map(([x, y]) => `${+x.toFixed(2)},${+y.toFixed(2)}`).join(' ')}"/>`
      : `<circle cx="${W / 2}" cy="${H / 2}" r="${(size / 2 - 0.5).toFixed(2)}"/>`;
    return svg(`<g fill="${s.color}" fill-opacity="0.35" stroke="${s.color}" stroke-width="1">${body}</g>`);
  }
  const dash = s.dashIn.length ? ` stroke-dasharray="${s.dashIn.map(px).join(' ')}"` : '';
  const color = screen ? screen.color : s.color;
  const fill = screen && screen.fill ? `<rect x="1" y="2" width="${W - 2}" height="${H - 4}" fill="${color}" fill-opacity="0.12"/>` : '';
  return svg(`${fill}<line x1="1" y1="${H / 2}" x2="${W - 1}" y2="${H / 2}" stroke="${color}" stroke-width="${px(s.widthIn)}"${dash} stroke-linecap="butt"/>`);
}

/** The symbol keys a recipe's enabled layers COULD draw, before any source check.
 *  Derived from the registry, never from a branch per layer: MVUM was the only
 *  family named here, so trails, recreation points, federal, state and county
 *  boundaries and parcels were drawn on the map with no entry in its key. A layer
 *  now reaches the key by existing, exactly as it reaches the paper.
 *
 *  `states` is which states the drawn area covers, because a state land layer is
 *  only drawable where that state publishes it. Extra SHEETS are excluded: they
 *  add pages, not ink, so they are not marks to look up. */
export function plannedLegendKeys({ layers = {}, grid, states = null, medium = 'paper' } = {}) {
  const keys = enabledLayers(layers, states).flatMap((l) => l.symbolKeys);
  // A screen-only layer (road names) is no sheet's ink, so enabledLayers leaves it out; its own
  // mark still belongs on the screen key while it is on. Paper never plans it.
  if (medium === 'screen') keys.push(...LAYERS.filter((l) => l.screenOnly && layers[l.id]).flatMap((l) => l.symbolKeys));
  // The grid and the sheet seams are printed furniture. They are marks on paper and
  // on nothing else, so the screen key never plans them (audit A11).
  if (medium === 'paper') {
    if (grid && grid !== 'none') keys.push(SYMBOLS.utmGrid.key);
    keys.push(SYMBOLS.overlapTicks.key);
  }
  return [...new Set(keys)];
}

// What the app draws for itself: the grid and the overlap marks are sheet
// furniture, and the base map is a raster with no features to count. No source
// check can confirm or rule any of them out, so none is ever marked.
const SELF_DRAWN = new Set([SYMBOLS.utmGrid.key, SYMBOLS.overlapTicks.key, SYMBOLS.roadName.key]);

/** The words a state owes the reader. `absent` is a statement about the DATA;
 *  `unknown` is a statement about the source, and conflating them is what would
 *  let a service outage read as empty ground. */
const QUALIFIER = Object.freeze({
  absent: 'not in the returned data',
  unknown: 'the source did not answer for this area',
  // A statement about the SCREEN, and about neither of the two above: the layer is
  // on and its source may well have plenty here, but at this zoom the map does not
  // draw it. Saying "not in the returned data" would be a claim about the ground.
  zoom: 'appears when you zoom in',
});

/** True when the screen map draws `symbol` at this zoom. The base map has no zoom
 *  gate any more (audit Q-base, A1): the dashboard's tile layer is on the map at
 *  every zoom, so the key never has to hold the base row back. Everything else
 *  is the same density rule the overlay itself is drawn through, so the key
 *  cannot promise a line the map is holding back. */
function drawnAtZoom(symbol, { zoom, screenScale }) {
  if (symbol.key === SYMBOLS.basemap.key) return true;
  // Road names are drawn from the service's zoom floor (road-names.js), not by a density scale.
  if (symbol.key === SYMBOLS.roadName.key) return typeof zoom !== 'number' || layersForZoom(zoom).length > 0;
  return drawsAtScale(symbol.key, screenScale);
}

/** Rows for the on-page key: every entry the enabled layers could draw, each
 *  marked once a source check has said what came back.
 *
 *  `rendered` — every symbol key the fetched layers really returned; null before
 *  any check, so nothing is claimed either way.
 *  `layerStates` — each layer id's source state, so a layer that never answered
 *  is told apart from one that answered with none of this symbol. */
export function legendRows({
  layers, grid, rendered = null, layerStates = null, states = null,
  medium = 'paper', zoom = null, screenScale = null, base = DEFAULT_BASE,
}) {
  const screen = medium === 'screen';
  // The screen's base is the reader's choice; paper always prints topo, so its key
  // always says so. No base map on screen means no base row to look up.
  const baseLabel = (symbol) => (screen && symbol.key === SYMBOLS.basemap.key && base !== DEFAULT_BASE
    ? `${BASE_BY_ID[base].label} — base map` : symbol.label);
  const enabled = enabledLayers(layers, states);
  const planned = plannedLegendKeys({ layers, grid, states, medium });
  const legend = deriveLegend({ renderedSymbolKeys: planned, gridEnabled: !screen && grid && grid !== 'none', basemapRendered: true });
  const present = rendered === null ? null : new Set(rendered);
  const owner = new Map();
  for (const l of enabled) for (const k of l.symbolKeys) if (!owner.has(k)) owner.set(k, l);
  // A layer that returned nothing AT ALL is the only case emptyMeans speaks to:
  // per symbol, a layer that returned other symbols really did answer "none of
  // this kind here".
  const silent = new Set(enabled.filter((l) => !present || !l.symbolKeys.some((k) => present.has(k))).map((l) => l.id));

  const stateOf = (symbol) => {
    // Asked first, and about the screen only: a symbol the map is not drawing at
    // this zoom has no source answer worth reporting, and reporting one would tell
    // the reader the ground is empty when it is the zoom that is wrong.
    if (screen && !drawnAtZoom(symbol, { zoom, screenScale })) return 'zoom';
    const layer = owner.get(symbol.key);
    if (present === null || SELF_DRAWN.has(symbol.key) || !layer || layer.emptyMeans === 'blocking') return 'planned';
    if (present.has(symbol.key)) return 'present';
    // No per-layer states supplied means the caller has one flat "checked" answer,
    // which is what the source check used to be.
    const s = layerStates ? layerStates[layer.id] : 'ready';
    if (!s || s === 'unchecked') return 'planned';
    if (s !== 'ready') return 'unknown';
    return silent.has(layer.id) && layer.emptyMeans === 'ambiguous' ? 'unknown' : 'absent';
  };

  // Lettering the map fetches by kind (the GNIS names row, which opens ON) is listed on
  // screen only once a kind has really been drawn: the paper key already lists exactly the
  // kinds drawn, and a fresh load listing nine "appears when you zoom in" rows for names
  // the map has not placed yet was 212px of key describing nothing on the screen.
  const heldBack = (symbol) => {
    if (!screen || SELF_DRAWN.has(symbol.key)) return false;
    const layer = owner.get(symbol.key);
    if (!layer || layer.required || !layer.defaultOn || layer.screenOnly) return false;
    return !(present && present.has(symbol.key));
  };
  const rows = legend.entries.filter((symbol) => !(symbol.screenOnly && !screen) && !(screen && (symbol.paperOnly || (base === 'none' && symbol.key === SYMBOLS.basemap.key))) && !heldBack(symbol)).map((symbol) => {
    const state = stateOf(symbol);
    const label = baseLabel(symbol);
    return {
      key: symbol.key,
      label,
      text: QUALIFIER[state] ? `${label} \u2014 ${QUALIFIER[state]}` : label,
      svg: legendSwatchSvg(symbol, { medium }),
      state,
    };
  });
  // Lead with what is on the screen in front of the reader. The paper key keeps its
  // printed reading order, which is the order the marks appear on a sheet; the
  // screen key answers "what am I looking at" first and "what would appear if I
  // zoomed in" second. Stable, so within each half the printed order survives.
  if (!screen) return rows;
  return [...rows.filter((r) => r.state !== 'zoom'), ...rows.filter((r) => r.state === 'zoom')];
}
