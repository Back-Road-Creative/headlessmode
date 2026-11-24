// Both sky cards for the place a reader just picked, in the order the facts arrive.
//
// One request feeds two cards that owe each other nothing. `/points` answers first and carries the
// place's own IANA zone; the Sun and Moon are arithmetic on that zone and a latitude, needing no
// forecast at all, so they are written the moment the zone lands rather than waiting. The hourly
// and grid products answer after, and fill the forecast card.
//
// The rule this file exists to hold: A FORECAST FAILURE AFTER THE ZONE ARRIVED IS NOT A REASON TO
// BLANK THE ASTRONOMY. The sequence used to end `if (r.status !== 'ok') sky(null)`, which redrew
// the sky card as "this place's own clock zone could not be looked up" on an NWS 500 — an untrue
// sentence about a lookup that had already succeeded, wiping five calculated times that were still
// correct. The zone is latched instead, and the no-zone card is only ever drawn when no zone was
// ever handed over. scripts/qcm/sky-card-resilience.test.mjs injects each failure at the fetch.
import { tonightFor, conditionsHtml, esc } from './tonight.js';

export const TONIGHT_ID = 'qc-tonight';
export const HOURLY_ID = 'qc-hourly';

export const NO_ZONE_NOTE = 'This place’s own clock zone could not be looked up, so tonight’s times cannot be stamped in it.';
export const TONIGHT_FAILED_NOTE = 'Tonight’s sky could not be worked out here.';
export const NO_FORECAST_NOTE = 'The forecast could not be reached for this place.';

const note = (text) => `<p class="qc-tonight-note">${esc(text)}</p>`;
const noZoneCard = (name) => `<h3 class="qc-tonight-head">Tonight’s sky — ${esc(name)}</h3>${note(NO_ZONE_NOTE)}`;

/**
 * Draw both cards for one `place` (`{ name, lat, lon }`).
 *
 * `request`  the forecast loader's `request`, called with `onPoint` so the zone arrives early.
 * `write`    `(elementId, html) => void`.
 * `isCurrent` false once the reader has picked somewhere else: a slower answer for the place they
 *            left must not paint over the one they are looking at.
 * `onZone`   called once with the place's IANA zone if one ever arrives, and never otherwise. The
 *            alerts card stamps its own issue and end times in that zone, and the zone comes with
 *            this request's point lookup -- so it is handed over rather than looked up twice. A
 *            zone that never arrives must leave that card in UTC saying so, which is why this
 *            never fires with null.
 */
export function showSkyCards({
  place, request, write, isCurrent = () => true, onZone = () => {},
  tonight = tonightFor, conditions = conditionsHtml,
}) {
  let zoned = false, drawn = false;
  const sky = (zone) => {
    if (zone && !zoned) onZone(zone);
    zoned = zoned || Boolean(zone);
    drawn = true;
    try { write(TONIGHT_ID, zone ? tonight({ ...place, timeZone: zone }) : noZoneCard(place.name)); }
    catch (err) { write(TONIGHT_ID, note(TONIGHT_FAILED_NOTE)); }
  };
  // Drawn only when no zone ever arrived, and only if nothing is on the card already. A
  // `status !== 'ok'` is a statement about the weather, which is the other card's business.
  const skyWithoutZone = () => { if (!zoned && !drawn) sky(null); };
  return request({ lat: place.lat, lon: place.lon, withGrid: true, onPoint: (p) => { if (isCurrent()) sky(p.timeZone); } })
    .then((r) => {
      if (!isCurrent()) return;
      skyWithoutZone();
      write(HOURLY_ID, conditions(r, place));
    })
    .catch(() => {
      if (!isCurrent()) return;
      skyWithoutZone();
      write(HOURLY_ID, note(NO_FORECAST_NOTE));
    });
}
