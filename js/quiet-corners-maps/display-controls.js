// D1: the pure emphasis-state reducer that drives the Highlight shortcuts and the
// Advanced controls. Same discipline as D0's displayStyle (preview-overlay.js): a state
// object in, a state object out, nothing read from the DOM or a Leaflet shape, so hover,
// highlight and clear can never compound. main.js owns the only mutable copy of this
// state and the only DOM/Leaflet side effects.
import { displayStyle, DEFAULT_DISPLAY } from './preview-overlay.js';

// DEFAULT_DISPLAY plus `prior`: the exact non-highlight state to restore on Clear. Kept
// separate from spotlight/lines themselves so a highlight can be undone without guessing
// what the reader had set before it.
export const DEFAULT_EMPHASIS = Object.freeze({ ...DEFAULT_DISPLAY, prior: null });

// The line-weight multiplier a Highlight shortcut applies. Chosen distinct from 1 (off)
// and from displayStyle's own hover bump (+2 absolute weight, not a multiplier), so a
// highlighted line and a hovered line are visibly different things.
export const HIGHLIGHT_LINES = 1.8;

function snapshot(state) {
  return { lines: state.lines, fill: state.fill, dim: state.dim, spotlight: state.spotlight, contrast: state.contrast };
}

/** state, action -> next state. Every branch is a plain object spread; nothing here
 *  mutates its argument or reads anything but the state and the action. */
export function nextDisplay(state, action) {
  switch (action.type) {
    case 'highlight':
      // A highlight already in effect keeps its ORIGINAL prior: highlighting trails,
      // then boundaries, then clearing must undo both at once, not just the second one.
      return { ...state, lines: HIGHLIGHT_LINES, spotlight: action.layerId, prior: state.prior || snapshot(state) };
    case 'clear':
      return state.prior ? { ...state, ...state.prior, prior: null } : { ...state, spotlight: null, lines: DEFAULT_EMPHASIS.lines };
    case 'setLines':
      return { ...state, lines: action.value, prior: null };
    case 'setFill':
      return { ...state, fill: action.value, prior: null };
    case 'setDim':
      return { ...state, dim: action.value, prior: null };
    case 'setContrast':
      return { ...state, contrast: action.value };
    case 'setSpotlight':
      return { ...state, spotlight: action.layerId, prior: null };
    default:
      throw new TypeError(`unknown display action: ${action.type}`);
  }
}

/** A one-line, human-readable summary of what the reader changed from the default --
 *  the visible "active changes" line the Advanced panel is required to show. */
export function summaryLine(state) {
  const parts = [];
  if (state.spotlight) parts.push(`Spotlighting ${state.spotlight}`);
  if (state.lines !== DEFAULT_EMPHASIS.lines) parts.push(`line weight ${state.lines}×`);
  if (state.fill !== DEFAULT_EMPHASIS.fill) parts.push(`fill ${Math.round(state.fill * 100)}%`);
  if (state.dim > 0) parts.push(`base dimmed ${Math.round(state.dim * 100)}%`);
  if (state.contrast !== DEFAULT_EMPHASIS.contrast) parts.push(`${state.contrast} contrast`);
  return parts.length ? parts.join(', ') : 'No changes from the default display.';
}

/** The legend swatch style for one symbol under the current emphasis state -- computed
 *  fresh from the same displayStyle D0 built, never from a drawn shape's own style, so
 *  the swatch and the map can never drift apart. */
export function swatchStyle(key, state, opts) {
  return displayStyle(key, state, opts);
}
