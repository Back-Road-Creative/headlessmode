// Pure single-panel-open state (U0-style: no DOM, no network). Which of the map's
// panels is open, the back-stack of panels it was opened over, and the opener control
// to hand focus back to once everything is closed. quiet-corners.js is the only thing
// that reads a live `<details>` or calls `.focus()`; this only says what it should do.
//
// Written from scratch (there was no existing panel-open logic to extract — today's
// `<details>`/`<summary>` toggle is the whole mechanism, with no exclusivity, no
// close-on-Escape and no focus restore at all).

/** The panels this shell drives. 'explore' (QUX-03b-i: filters, the county/candidate
 *  tables and the sort controls) and 'conditions' (QUX-03b-ii: the moved sky/forecast/
 *  alerts cards) join 'layers'/'print' here without changing any function below —
 *  nothing here branches on which id it is. */
export const PANEL_IDS = Object.freeze(['layers', 'print', 'explore', 'conditions']);

/** QUX-03c: below 1024px the four panels share one bottom sheet that RESIZES the map
 *  instead of covering it or scrolling the page. `sheet` is that sheet's size and
 *  lives here, next to `open`, under one invariant enforced by every transition below
 *  and checked directly in panel-state.test.mjs's random-walk case:
 *
 *    sheet === 'collapsed'  <=>  open === null
 *
 *  A sheet cannot be sized with nothing open (there is no panel to show), and a panel
 *  cannot be open with the sheet collapsed (there would be nothing on screen showing
 *  it). Above 1024px `sheet` is simply never read — the desktop overlay CSS does not
 *  key off it — so it costs that layout nothing. */
export const SHEET_SIZES = Object.freeze(['collapsed', 'half', 'expanded']);

/** Nothing open, no back-stack, no remembered opener, sheet collapsed (the invariant
 *  above, satisfied from the very first state). */
export function initialState() {
  return { open: null, history: [], opener: null, sheet: 'collapsed' };
}

/** Opens `id`. If another panel was open, it goes on the back-stack so `backPanel` can
 *  return to it. Opening the panel that is ALREADY open is a no-op on both history and
 *  opener — otherwise "Back" from a panel opened twice in a row would step to itself,
 *  never actually going anywhere.
 *
 *  `openerEl` is whatever control the caller says triggered this (a summary's id, a
 *  tab button's id — panel-state.js does not care which). It is recorded only when
 *  this open starts from fully closed: switching from one open panel to another keeps
 *  the ORIGINAL opener, because that is the control focus must return to once the
 *  whole excursion (however many panels it passed through) ends.
 *
 *  `sheet`: opening from fully closed sets it to `'half'` — the sheet's default open
 *  size. Switching panels while one is already open keeps the CURRENT size, so paging
 *  from Layers to Print inside an expanded sheet does not snap it back down. */
export function openPanel(state, id, openerEl = null) {
  if (state.open === id) return { ...state };
  const history = state.open ? [...state.history, state.open] : state.history;
  const opener = state.open === null ? (openerEl ?? state.opener) : state.opener;
  const sheet = state.open === null ? 'half' : state.sheet;
  return { ...state, open: id, history, opener, sheet };
}

/** Closes whatever is open. Does NOT touch history — Close and Back are different
 *  actions: Close abandons the back-stack outright, Back consumes one entry of it.
 *  The opener survives a Close (see focusTarget below): it is exactly what a caller
 *  needs right after this call. `sheet` goes back to `'collapsed'` — the invariant
 *  requires it the moment `open` goes to null. */
export function closePanel(state) {
  return { ...state, open: null, sheet: 'collapsed' };
}

/** Steps back one entry: reopens the last panel on the stack, or closes if there is
 *  none. The popped entry is dropped, not re-pushed, so a second Back keeps moving
 *  backward instead of bouncing between the same two panels. Opener is untouched for
 *  the same reason as closePanel — it is not this state's job to know whether the
 *  caller has consumed it yet.
 *
 *  `sheet` follows the same rule as openPanel's, because reopening a history entry
 *  from a FULLY CLOSED state (Close leaves history alone, so Back still works right
 *  after a Close — see closePanel above) is exactly that: an open, and needs the
 *  sheet back at `'half'`. Stepping back while something is already open (paging
 *  through the stack) keeps the current size, same as openPanel. Emptying the stack
 *  with nothing open forces `'collapsed'`, the same invariant closePanel enforces. */
export function backPanel(state) {
  if (state.history.length === 0) return { ...state, open: null, sheet: 'collapsed' };
  const history = state.history.slice(0, -1);
  const open = state.history[state.history.length - 1];
  const sheet = state.open === null ? 'half' : state.sheet;
  return { ...state, open, history, sheet };
}

/** Resizes the sheet to `size` (one of SHEET_SIZES). Three cases fall outside a plain
 *  `{...state, sheet: size}`:
 *   - `size` is not one of SHEET_SIZES: no-op, a copy of `state`. Callers (the size
 *     button, drag/keyboard handling) only ever pass a SHEET_SIZES member, but this
 *     keeps a typo from corrupting the invariant instead of asserting on it.
 *   - `state.open === null`: an empty sheet cannot be sized — there is nothing to
 *     show at any size — so this always lands on `'collapsed'` regardless of `size`.
 *   - `size === 'collapsed'`: sizing the sheet down to nothing IS closing whatever is
 *     open (dragging the handle all the way down is indistinguishable from pressing
 *     Close), so this defers to closePanel — same opener-survives, focus-restores-next
 *     behaviour a Close click gets. */
export function resizeSheet(state, size) {
  if (!SHEET_SIZES.includes(size)) return { ...state };
  if (state.open === null) return { ...state, sheet: 'collapsed' };
  if (size === 'collapsed') return closePanel(state);
  return { ...state, sheet: size };
}

/** Pure snap rule for a drag-release on the sheet handle: `dyPx` is the total pointer
 *  displacement (positive = downward, the drag/DOM side computes this, not here) and
 *  `extentPx` is the stage's own height (`#qc-map-container.clientHeight`) — the drag
 *  is a fraction of the STAGE, not of the sheet's own current (smaller) box, so the
 *  same physical swipe means the same thing regardless of which size it started from.
 *  `extentPx * 0.2` is the snap threshold in both directions.
 *
 *  From `'half'`: a swipe up past the threshold expands; a swipe down past it closes
 *  (through resizeSheet('collapsed'), i.e. through closePanel); anything smaller snaps
 *  back to `'half'` — a drag is a gesture, never a live resize, so release always
 *  lands on exactly one of the three sizes.
 *  From `'expanded'`: down past 3x the threshold closes outright (skipping over half
 *  reads as "get me out", not "make room"); down past the threshold but under 3x drops
 *  to `'half'`; anything smaller snaps back to `'expanded'`.
 *  From `'collapsed'`: nothing to drag — the handle is not interactive without an open
 *  panel under it — always a copy of `state`, unchanged. */
export function snapSheet(state, dyPx, extentPx) {
  if (state.sheet === 'collapsed') return { ...state };
  const threshold = extentPx * 0.2;
  if (state.sheet === 'half') {
    if (dyPx <= -threshold) return resizeSheet(state, 'expanded');
    if (dyPx >= threshold) return resizeSheet(state, 'collapsed');
    return resizeSheet(state, 'half');
  }
  // 'expanded'
  if (dyPx >= threshold * 3) return resizeSheet(state, 'collapsed');
  if (dyPx >= threshold) return resizeSheet(state, 'half');
  return resizeSheet(state, 'expanded');
}

/** The control the DOM side should call `.focus()` on, once the panel this state
 *  describes has actually closed on screen with nothing left to go back to. Returns
 *  null while a panel is still open (there is nothing to restore focus FROM yet) —
 *  the caller should not blur an open panel out from under a reader. */
export function focusTarget(state) {
  return state.open === null ? state.opener : null;
}
