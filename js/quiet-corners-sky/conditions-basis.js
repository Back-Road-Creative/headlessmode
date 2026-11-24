// QUX-09b "Before you go": the three-source basis for every conditions ask --
// never why a request failed (sky-cards.js and source-nws-alerts.js's own
// failure notes cover that), only what each source actually measures, so a
// reader never mistakes "conditions" for one verdict. Pure and DOM-free so
// scripts/qcm/conditions-basis.test.mjs can scan every place kind without a
// browser.
//
// None of the three sources can promise station, clear, safe or no hazard(s)
// -- nothing here reads an instrument, and a quiet alerts card means no NWS
// product is in force, not that the ground is safe (source-nws-alerts.js's
// own CARD_CAVEAT makes the same claim gate). These lines must never say any
// of those words.

export const SKY_LINE = 'Sun and Moon times are calculated for this exact point.';
export const FORECAST_LINE = "The forecast is the National Weather Service's value for the grid "
  + 'cell that contains this point, not a reading at the point.';
export const ALERTS_LINE = 'Alerts are the Weather Service products whose area covers this point.';
export const GRID_CELL_NOTE = "A summit sits inside a cell's single value; the cell is not a "
  + 'measurement on the summit.';

/** The kinds whose forecast line gains the grid-cell caveat: a terrain feature small enough
 *  that "the cell" and "the point" can read as the same thing when they are not. */
const GRID_CELL_KINDS = new Set(['summit', 'ridge', 'gap']);

/** Always exactly three lines, one per source, in source order (Sky, Forecast, Alerts).
 *  `place.kind` in summit/ridge/gap appends the grid-cell caveat to the SAME forecast line --
 *  a fourth line would read as a fourth source, and there are only three. */
export function basisLines(place = {}) {
  const kind = (place && place.kind) || null;
  const forecast = GRID_CELL_KINDS.has(kind) ? `${FORECAST_LINE} ${GRID_CELL_NOTE}` : FORECAST_LINE;
  return [SKY_LINE, forecast, ALERTS_LINE];
}
