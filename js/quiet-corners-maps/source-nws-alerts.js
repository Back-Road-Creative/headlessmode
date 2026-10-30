// Active National Weather Service watches, warnings and advisories for the place a reader
// picked. Same origin as the hourly forecast and a SEPARATE adapter on purpose: a forecast is
// a number for an hour, an alert is a product an office issued with a window of its own, and
// neither may be able to blank the other. The page asks for them independently and each
// writes its own card.
//
// Measured live 2026-09-14 (01:13-01:20 UTC on the 15th), recorded with the responses in
// scripts/qcm/fixtures/nws-alerts-2026-09-14.min.json. Three measurements shape the whole file:
//
//  1. 342 of 386 active features carried `geometry: null`. Nine alerts in ten are ZONE-based --
//     reachable only through `affectedZones` / `geocode.UGC` -- so an adapter that reads
//     polygons drops nearly all of them. A missing polygon is normal, never an empty answer.
//  2. All 386 carried `web: "http://www.weather.gov"`: the agency FRONT PAGE, identical on
//     every alert. It is not a page about the alert, so the link a reader is handed is the
//     alert's own `@id` record and `web` is never dressed up as detail.
//  3. `?message_type=Bogus` answered 400 with the API's own enumeration,
//     ["alert","update","cancel"]. A Cancel is the office withdrawing the product; it is not
//     an alert whatever its stated expiry still says.
//
// And the claim gate, the one this card is most able to break: these are the products the
// Weather Service ISSUES, which is not every hazard that exists. A quiet card says no NWS
// product is in force -- never that the ground is free of hazards. Every reader-facing string
// is built here so scripts/qcm/nws-alerts.test.mjs can scan the lot.
import { SOURCES } from './source-registry.js';
import { fetchWithDeadline } from './request.js';

const SRC = SOURCES.nwsAlerts;
export const SERVICE = SRC.serviceUrl;
export const CREDIT = SRC.attribution;
/** The API's own enumeration, read back off its 400 rather than copied from a guide. */
export const MESSAGE_TYPES = Object.freeze([...SRC.messageTypes]);

/** Four decimals, the same 301 the point forecast measured on the longer form. */
export const alertsUrl = (lat, lon) =>
  `${SERVICE}?point=${Math.round(lat * 1e4) / 1e4},${Math.round(lon * 1e4) / 1e4}`;

/** The one header the page sets; the browser supplies its own User-Agent. */
export const requestHeaders = () => ({ Accept: 'application/geo+json' });

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const at = (ms, timeZone) => (Number.isFinite(ms)
  ? new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'UTC', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(ms)
  : null);
const ms = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

/** One feature as the card reads it. `state` is the whole point: three different things --
 *  in force, ended, withdrawn -- that a reader must never see collapsed into one list. The
 *  end time is the alert's OWN `ends`, falling back to `expires`; 8 of 386 stated no `ends`
 *  and none stated no `expires`, and an alert stating neither has an unknown end rather than
 *  an assumed one. */
export function readAlert(feature = {}, nowMs = Date.now()) {
  const p = (feature && feature.properties) || {};
  const endMs = ms(p.ends) ?? ms(p.expires);
  const cancelled = String(p.messageType || '').toLowerCase() === 'cancel';
  return Object.freeze({
    id: p.id || feature.id || null,
    event: p.event || 'Weather alert',
    headline: p.headline || null,
    areaDesc: p.areaDesc || null,
    severity: p.severity || null,
    urgency: p.urgency || null,
    messageType: p.messageType || null,
    senderName: p.senderName || null,
    // The alert's own record. `web` is the agency front page on every single one.
    detailUrl: p['@id'] || feature.id || null,
    agencyUrl: p.web || null,
    sentMs: ms(p.sent), effectiveMs: ms(p.effective), onsetMs: ms(p.onset),
    expiresMs: ms(p.expires), endsMs: ms(p.ends), endMs, endKnown: endMs !== null,
    // No polygon is the NORMAL shape here, not a defect and not an empty answer.
    zoneBased: !feature.geometry,
    zones: Object.freeze([...((p.geocode && p.geocode.UGC) || [])]),
    state: cancelled ? 'cancelled' : (endMs !== null && endMs <= nowMs ? 'expired' : 'in-effect'),
  });
}

/** A response split into what is in force and what is not. A body that is not a
 *  FeatureCollection is unreadable -- a state of its own, never an empty answer. */
export function readAlerts(body, nowMs = Date.now()) {
  if (!Array.isArray(body && body.features)) return { status: 'unreadable', inEffect: [], ended: [] };
  const rows = body.features.map((f) => readAlert(f, nowMs));
  return {
    status: 'ok',
    inEffect: rows.filter((r) => r.state === 'in-effect'),
    ended: rows.filter((r) => r.state !== 'in-effect'),
  };
}

/** Where an alert applies. A zone-based one names its zones because that is what it HAS;
 *  saying so beats an outline nobody drew. */
export function areaText(row) {
  const where = row.areaDesc || 'the areas the alert names';
  return row.zoneBased
    ? `Applies to the National Weather Service zones it names: ${where}${row.zones.length ? ` (${row.zones.join(', ')})` : ''} — this one carries no outline, which is the usual shape.`
    : `Applies inside the outline the office drew, over ${where}.`;
}

/** The window, in the SELECTED PLACE's zone. Issue time and end time are separate facts and
 *  both are shown: an alert sent an hour ago and one sent a minute ago are different things.
 *  A cancelled product says so instead of a window; an ended one says it ended. */
export function effectText(row, timeZone) {
  const sent = at(row.sentMs, timeZone);
  const issued = sent ? `Issued ${sent}` : 'The alert did not state when it was issued';
  if (row.state === 'cancelled') {
    return `${issued}, then cancelled by ${row.senderName || 'the issuing office'} — it is no longer in effect.`;
  }
  const end = at(row.endMs, timeZone);
  if (row.state === 'expired') {
    return `${issued}. It ran out ${end} and is no longer in effect.`;
  }
  const start = Number.isFinite(row.onsetMs) && Number.isFinite(row.sentMs) && row.onsetMs > row.sentMs
    ? at(row.onsetMs, timeZone) : null;
  const until = end ? `until ${end}` : 'until a time the alert did not state';
  return start ? `${issued}, in effect from ${start} ${until}.` : `${issued}, in effect ${until}.`;
}

/** The rows a reader sees, in reading order: what is in force first, then what has ended or
 *  been withdrawn. A failure and a quiet feed each get exactly one row, and they say
 *  different things, because "we could not ask" is not "nothing is in force". */
export function alertRows(result, place = {}, nowMs = Date.now()) {
  const zone = place.timeZone || null;
  if (!result || result.status === 'failed') return [{ key: 'failed', label: 'Alerts', value: FAILED_TEXT }];
  const got = readAlerts(result.body, nowMs);
  if (got.status !== 'ok') return [{ key: 'unreadable', label: 'Alerts', value: UNREADABLE_TEXT }];
  if (!got.inEffect.length && !got.ended.length) return [{ key: 'quiet', label: 'Alerts', value: QUIET_TEXT }];
  const row = (r, suffix) => ({
    key: r.id || r.event, label: `${r.event}${suffix}`,
    value: `${effectText(r, zone)} ${areaText(r)} Issued by ${r.senderName || 'the National Weather Service'}.`,
    href: r.detailUrl,
  });
  return [
    ...got.inEffect.map((r) => row(r, '')),
    ...got.ended.map((r) => row(r, r.state === 'cancelled' ? ' (cancelled)' : ' (ended)')),
  ];
}

/** The card. No control and no motion, so no keyboard path beyond the links themselves. */
export function alertsHtml(result, place = {}, nowMs = Date.now()) {
  const rows = alertRows(result, place, nowMs).map((r) => {
    const link = r.href
      ? ` <a href="${esc(r.href)}" rel="noopener">the Weather Service record for this alert</a>`
      : '';
    return `<dt class="qc-tonight-label">${esc(r.label)}</dt><dd class="qc-tonight-value">${esc(r.value)}${link}</dd>`;
  }).join('');
  const zone = place.timeZone
    ? `Times in ${esc(place.timeZone)}, the zone of the place itself.`
    : 'This place’s own clock zone could not be looked up, so the times below are UTC.';
  return `<h3 class="qc-tonight-head">${esc(CARD_TITLE)} — ${esc(place.name)}</h3>`
    + `<dl class="qc-tonight-rows">${rows}</dl>`
    + `<p class="qc-tonight-note">${esc(CARD_CAVEAT)}</p>`
    + `<p class="qc-tonight-zone">${zone} ${esc(CREDIT)}.</p>`;
}

/** The card's own words, in one place. */
export const CARD_TITLE = 'Active weather alerts';
export const CARD_CAVEAT = 'These are the products the National Weather Service issues, which is '
  + 'not every hazard that exists: a quiet card means no NWS product is in force here, not that '
  + 'the ground is free of danger, and nothing here speaks to road conditions, water temperature '
  + 'or what the weather does between alerts. Nine alerts in ten carry no outline at all, so most '
  + 'name the zones they apply to instead of a shape. Each alert’s own issue and end times are '
  + 'shown rather than the moment this page asked.';
export const QUIET_TEXT = 'No National Weather Service watch, warning or advisory is in force for '
  + 'this place right now. That is the feed answering, and it speaks only for the products this '
  + 'agency issues.';
export const FAILED_TEXT = 'The National Weather Service alert feed could not be reached for this '
  + 'place, so whether anything is in force here is unknown. This is a failure to ask, not an answer.';
export const UNREADABLE_TEXT = 'The National Weather Service alert feed answered with something '
  + 'this page could not read, so whether anything is in force here is unknown.';

/** One ask. A non-200 is a FAILURE, not an empty answer: the API answers 400 for a query
 *  parameter it does not recognise, and rendering that as "nothing in force" is the one lie
 *  this state is able to tell. */
export async function fetchAlerts({ lat, lon, fetchImpl = fetch, signal, timeoutMs = SRC.timeoutMs } = {}) {
  const got = await fetchWithDeadline(alertsUrl(lat, lon), {
    fetchImpl, signal, timeoutMs, init: { headers: requestHeaders() }, anyStatus: true,
  });
  if (got.ok) return { status: 'ok', httpStatus: got.httpStatus, body: got.body };
  if (got.httpStatus !== undefined) {
    const problem = (got.body && typeof got.body === 'object') ? got.body : {};
    return { status: 'failed', httpStatus: got.httpStatus, detail: problem.detail || problem.title || '' };
  }
  return { status: 'failed', httpStatus: null, detail: got.error };
}

// QUX-09b (D5): the registry's per-source deadline, as source-weather.js's loader carries -- a hung
// request must still land in FAILED_TEXT above, not hold this card's pending note up forever.
export const DEFAULT_TIMEOUT_MS = SRC.timeoutMs;

/** One place at a time. Move the map from A to B and A's slower answer can land second;
 *  showing it puts A's warnings under B's name. The previous ask is aborted, and the page
 *  drops any answer for a place it has moved off. */
let live = null;
export async function alertsFor({ lat, lon, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  if (live) live.abort();
  const ctl = (live = new AbortController());
  const onAbort = () => ctl.abort();
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  let got;
  try { got = await fetchAlerts({ lat, lon, fetchImpl, signal: ctl.signal, timeoutMs }); } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  if (live === ctl) live = null;
  return got;
}

/** Every string this source can put in front of a reader, for the test to scan. */
export function readerStrings() {
  const sample = readAlert({
    geometry: null,
    properties: { id: 'x', '@id': 'https://api.weather.gov/alerts/x', event: 'Heat Advisory',
      areaDesc: 'Travis', senderName: 'NWS Austin/San Antonio TX', messageType: 'Alert',
      sent: '2026-09-15T00:49:00-05:00', onset: '2026-09-15T12:00:00-05:00',
      expires: '2026-09-15T19:00:00-05:00', geocode: { UGC: ['TXZ192'] } },
  }, Date.parse('2026-09-15T01:30:00Z'));
  const like = (extra, nowMs) => readAlert({ geometry: null, properties: {
    event: 'Heat Advisory', areaDesc: 'Travis', senderName: 'NWS Austin/San Antonio TX',
    sent: '2026-09-15T00:49:00-05:00', expires: '2026-09-15T19:00:00-05:00', ...extra } }, nowMs);
  const ended = like({ expires: '2026-09-15T01:00:00-05:00' }, Date.parse('2026-09-16T00:00:00Z'));
  const cancelled = like({ messageType: 'Cancel' }, Date.parse('2026-09-15T01:30:00Z'));
  return [CREDIT, CARD_TITLE, CARD_CAVEAT, QUIET_TEXT, FAILED_TEXT, UNREADABLE_TEXT,
    ...[sample, ended, cancelled].flatMap((r) => [effectText(r, 'America/Chicago'), areaText(r)])];
}
