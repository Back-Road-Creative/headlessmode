// NOAA SWPC's OVATION aurora model, read for one drawn area.
//
// This source is the MIRROR of the radar layer, and copying radar's gate onto it would
// be exactly wrong. Radar is an observation and may never be dressed up as an outlook.
// This is an outlook -- the payload's own `Observation Time` and `Forecast Time`
// measured 66 minutes apart -- and may never be dressed up as an observation. Every
// reader-facing string here goes through `forecastHorizon()` for that reason.
//
// Two more things the payload itself decides:
//
// Longitudes run 0..359, not -180..180. A US longitude of -90 is 270 in this grid, so
// `toSignedLon` is not a convenience, it is the difference between reading the Rockies
// and reading the far side of the planet.
//
// It is ~900 KB for the whole globe and usually flat zero over the lower 48 -- all
// 1,560 cells there measured 0 at the probe, the first non-zero values sitting near
// 65N. So nothing fetches it on first render, and "nothing to show" is the normal
// answer rather than a failure to report.
import { SOURCES } from './source-registry.js';

export const AURORA_SOURCE = SOURCES.swpcAurora;
export const SERVICE = AURORA_SOURCE.serviceUrl;

/** The grid's own scale: values 0..15 are the modelled chance, in percent, of aurora
 *  overhead in that cell. Below this a cell is not worth drawing at all. */
export const VISIBLE_AT_LEAST = 1;

/** 0..359 -> -180..180. The grid is expressed the other way round from every other
 *  coordinate in this app, and mixing the two silently reads the wrong hemisphere. */
export const toSignedLon = (lon) => (lon > 180 ? lon - 360 : lon);

/** -180..180 -> 0..359, for asking the grid about a place. */
export const toGridLon = (lon) => (lon < 0 ? lon + 360 : lon);

/** The payload's own two timestamps. A body that will not state them is unknown rather
 *  than assumed current -- the same rule the radar layer follows, for the same reason. */
export function readForecast(body) {
  const observedMs = Date.parse(body?.['Observation Time'] ?? '');
  const forecastMs = Date.parse(body?.['Forecast Time'] ?? '');
  if (!Number.isFinite(observedMs) || !Number.isFinite(forecastMs)) {
    return { known: false, observedMs: null, forecastMs: null, horizonMinutes: null };
  }
  return {
    known: true,
    observedMs,
    forecastMs,
    horizonMinutes: Math.round((forecastMs - observedMs) / 60000),
  };
}

/** Every cell of the grid that falls inside a drawn area, longitudes already converted
 *  to the signed form the rest of the app uses. */
export function cellsInBbox(body, { minLon, minLat, maxLon, maxLat }) {
  const out = [];
  for (const point of body?.coordinates ?? []) {
    const [gridLon, lat, value] = point;
    const lon = toSignedLon(gridLon);
    if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
    out.push({ lon, lat, value });
  }
  return out;
}

/** What those cells amount to. `none` is the ordinary answer over the lower 48 and is
 *  reported as such, not as a gap in the data. */
export function summarise(cells) {
  const peak = cells.reduce((max, c) => Math.max(max, c.value), 0);
  return { cells: cells.length, peak, anyVisible: peak >= VISIBLE_AT_LEAST };
}

/** The one place a reader-facing sentence about this layer is made. It always names the
 *  forecast time and always says the word forecast: the failure this guards against is
 *  a reader taking a modelled hour-ahead chance for a look at tonight's sky. */
export function forecastHorizon(body, nowMs = Date.now()) {
  const f = readForecast(body);
  if (!f.known) {
    return { known: false, text: 'The aurora service did not state a forecast time, so this is not shown.' };
  }
  const at = new Date(f.forecastMs).toISOString().slice(11, 16);
  const ahead = Math.round((f.forecastMs - nowMs) / 60000);
  const when = ahead > 0 ? `about ${ahead} minutes from now` : 'now past';
  return {
    known: true,
    text: `Forecast for ${at} UTC, ${when}. This is a model of the chance of aurora `
      + 'overhead, not a picture of the sky and not a reading of cloud.',
  };
}

/** Nothing to show is a result, not an error, so it gets its own sentence. */
export function quietText() {
  return 'No aurora is forecast over this area. That is the usual answer here: the '
    + 'model reads zero across the lower 48 on almost every night.';
}

/** Fetched only when a reader asks for it -- ~900 KB for the whole globe. Never throws
 *  the map: a service that will not answer leaves the rest of the page alone. */
export async function fetchAurora({ fetchImpl = fetch, signal } = {}) {
  try {
    const res = await fetchImpl(SERVICE, { signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

/** Every string this layer can put in front of a reader, in one place, so a test can
 *  scan the lot for the promise this source must never make. */
export function readerStrings(body) {
  return [AURORA_SOURCE.attribution, LAYER_LABEL, LAYER_CAVEAT, quietText(),
    forecastHorizon(body).text, forecastHorizon(null).text];
}

/** The layer's own words. "forecast" is in the label itself, because the label is the
 *  one string a reader is guaranteed to see and the promise this source must never make
 *  is that it shows the sky as it is. */
export const LAYER_LABEL = 'Aurora forecast (about an hour ahead)';
export const LAYER_CAVEAT = 'The modelled chance of aurora overhead about an hour from now -- an '
  + 'outlook, never a look at the sky. It says nothing about cloud, so a high number and a clear '
  + 'night are two separate questions, and it is drawn on the model\'s own 1-degree grid, which is '
  + 'roughly 110 km a side and far coarser than the area you drew. Over the lower 48 it reads zero '
  + 'on almost every night; that is the ordinary answer here, not a gap in the data.';

/** The 1-degree cell a grid point stands for. The point is the cell's corner, not its
 *  middle, which is the difference between drawing the box the model meant and drawing
 *  it half a cell off. */
export function cellBounds({ lon, lat }, cellDegrees = AURORA_SOURCE.grid.cellDegrees) {
  return { minLon: lon, minLat: lat, maxLon: lon + cellDegrees, maxLat: lat + cellDegrees };
}

/** A Leaflet group holding one box per cell worth drawing. Cells below
 *  VISIBLE_AT_LEAST are not drawn at all rather than drawn faintly: a box a reader can
 *  see is a box a reader will read something into. */
export function auroraLayer(L) {
  const group = L.layerGroup();
  group.draw = function draw(cells) {
    group.clearLayers();
    for (const cell of cells) {
      if (cell.value < VISIBLE_AT_LEAST) continue;
      const b = cellBounds(cell);
      L.rectangle([[b.minLat, b.minLon], [b.maxLat, b.maxLon]], {
        // Opacity carries the value, so a 15 does not read the same as a 2.
        color: '#7ee081', weight: 1, fillColor: '#7ee081',
        fillOpacity: 0.12 + 0.55 * (Math.min(cell.value, 15) / 15),
        interactive: false,
      }).addTo(group);
    }
    return group;
  };
  return group;
}

/** What the layer's row says, for one drawn area: the forecast time first, because a
 *  number without its horizon is the misreading this whole source guards against. */
export function areaReport(body, bbox, nowMs = Date.now()) {
  const horizon = forecastHorizon(body, nowMs);
  if (!horizon.known) return { anyVisible: false, text: horizon.text };
  const s = summarise(cellsInBbox(body, bbox));
  return {
    anyVisible: s.anyVisible,
    peak: s.peak,
    text: s.anyVisible
      ? `${horizon.text} Peak over this area: ${s.peak} out of 15.`
      : `${horizon.text} ${quietText()}`,
  };
}
