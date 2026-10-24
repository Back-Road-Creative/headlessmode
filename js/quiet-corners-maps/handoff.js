// The county finder -> Field Maps handoff, in one file because BOTH ends load it.
//
// The Quiet Corners dashboard writes these query strings and the Field Maps app
// parses them. Before this they lived only in app-state.js, which the dashboard
// cannot reach: /js/quiet-corners.js is loaded as a module now precisely so it
// can, because the alternative was a hand-written query string on the emitting
// side that would drift from the parser in silence and land the reader on a
// subtly wrong rectangle.
//
// Pure: no DOM, no network, no Date.

/** The printable width of a proposed area, in miles. A county is usually wider
 *  than the maximum, so a handoff proposes a CENTRED box rather than the county:
 *  the app says "confirm or adjust before building" for exactly that reason. */
export const WIDTH_MILES = Object.freeze({ min: 1, max: 20, default: 8 });
export const LABEL_MAX = 60;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

export const clampMiles = (w) => Math.min(WIDTH_MILES.max, Math.max(WIDTH_MILES.min, w));

/** A label safe to put in a URL and then on a printed sheet: control characters
 *  stripped, trimmed, and cut to a length the sheet header can hold. */
export const cleanLabel = (label) => String(label || '').replace(CONTROL_CHARS, '').trim().slice(0, LABEL_MAX).trim();

/** The query string the county finder emits for "start a field map near here".
 *  `v=1` is the contract version: the parser rejects anything else outright. */
export function serializeUrlRecipe({ lat, lon, widthMiles = WIDTH_MILES.default, label }) {
  const q = new URLSearchParams({
    v: '1',
    lat: Number(lat).toFixed(4),
    lon: Number(lon).toFixed(4),
    w: String(clampMiles(widthMiles)),
  });
  const clean = cleanLabel(label);
  if (clean) q.set('label', clean);
  return `?${q}`;
}

/** Where a county row's "print field maps here" link points.
 *
 *  One map, one path. This used to choose a per-state page, because the CSP that
 *  decided which services a page could contact was bound to its path; the state
 *  now comes from the area the reader lands on, so the state argument is accepted
 *  and ignored rather than removed, and an old caller keeps working. */
export function handoffHref({ lat, lon, label, widthMiles } = {}) {
  // The builder is a panel on /quiet-corners/ itself; /quiet-corners/maps/ is
  // the methodology page and has no map on it to hand a recipe to.
  return `/quiet-corners/${serializeUrlRecipe({ lat, lon, label, widthMiles })}`;
}
