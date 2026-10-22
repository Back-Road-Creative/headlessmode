// Active NWS watches, warnings and advisories, against the bytes the service actually returned.
// No network.
//
// Six response states, one test each, because they are six different sentences and collapsing
// any two of them is how a card starts lying:
//
//   nonempty     something is in force, and the card must show WHEN and WHOSE it is
//   empty        a valid FeatureCollection with no features -- the API saying nothing is in
//                force here. Measured: `/alerts/active?point=35.1823,-83.3815` -> 200, 0 features
//   expired      the response is held in the page while an alert's own end time passes. The
//                alert does not become false, it stops being IN EFFECT, and saying "in effect"
//                about it is the failure this unit exists to stop
//   cancelled    the office withdrew it. messageType is the API's own enum -- a bogus value
//                answered 400 with ["alert","update","cancel"] -- and a Cancel is not an alert
//   polygonless  342 of 386 live features carried `geometry: null`. A zone-based alert covers
//                named NWS zones, not a drawn shape, and treating no polygon as no alert would
//                drop nine alerts in ten
//   failed       the service answered 400/500 or the fetch threw. A failure is a stated state,
//                and it must not be able to blank the hourly forecast card beside it
//
// The seventh gate is a CLAIM gate, the one the AQI source guards in its own direction: NWS
// alerts are the products the Weather Service issues, which is not every hazard that exists.
// A quiet card must never read as "nothing can hurt you here".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SOURCES, APPROVED_ORIGINS, cspDirectivesFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import {
  SERVICE, CREDIT, MESSAGE_TYPES, CARD_TITLE, CARD_CAVEAT, QUIET_TEXT, FAILED_TEXT,
  alertsUrl, requestHeaders, readAlert, readAlerts, effectText, alertRows, alertsHtml,
  fetchAlerts, readerStrings,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-nws-alerts.js';

const FIX = JSON.parse(readFileSync(new URL('fixtures/nws-alerts-2026-09-14.min.json', import.meta.url), 'utf8'));
const DASH = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners.js', import.meta.url), 'utf8');

// The two captured alerts, and the instants that make each state true.
const FLOOD = FIX.active.features[0];            // Flash Flood Warning, Pitkin CO, a real polygon
const HEAT = FIX.active.features[1];             // Heat Advisory, six Texas zones, geometry: null
const NOW = Date.parse('2026-09-15T01:30:00Z');  // flood expires 02:15Z, heat 2026-09-16T00:00Z
const AFTER_FLOOD = Date.parse('2026-09-15T03:00:00Z');
const DENVER = { name: 'Pitkin County, CO', timeZone: 'America/Denver' };

// Any sentence that would turn "no NWS product is in force" into "you are safe". The
// honest phrasings ("not every hazard that exists") are deliberately NOT in here -- what
// is caught is a safety verdict, not a disclaimer that names the gap.
const ALL_HAZARD = /\b(no hazards?|no dangers?|nothing to worry|all ?clear|safe to \w+|it is safe|you are safe|ground is safe)\b/i;

test('the registry entry is measured, and it adds no origin to the CSP', () => {
  const s = SOURCES.nwsAlerts;
  assert.equal(s.serviceUrl, SERVICE);
  assert.equal(s.origin, SOURCES.nwsForecast.origin, 'the same host the hourly forecast already uses');
  assert.equal(s.limits.requiresKey, false);
  assert.equal(s.claim, 'forecast', 'an alert states a hazard for a window that has not ended');
  assert.equal(s.dateBasis, 'feature-field', 'the times come from the ALERT, never from the response');
  assert.match(s.measuredOn, /^\d{4}-\d{2}-\d{2}$/);
  // The whole reason this unit needed no qualification doc: the origin was already approved,
  // so the generated header cannot move.
  assert.ok(APPROVED_ORIGINS.includes('https://api.weather.gov'));
  const csp = cspDirectivesFor();
  // QUX-08D-ii: npsWebcams is cors:'none' and is excluded from connect-src, so this is no
  // longer every approved origin verbatim -- it is every origin except that one exception.
  assert.deepEqual(csp['connect-src'], APPROVED_ORIGINS.filter((o) => !Object.values(SOURCES).some((x) => x.cors === 'none' && x.origin === o)));
  assert.ok(!csp['img-src'].includes(s.origin), 'nothing here paints through an <img>');
  // The API's own enumeration, read back off a 400 rather than copied from a guide.
  assert.deepEqual(MESSAGE_TYPES, ['alert', 'update', 'cancel']);
});

test('the ask is a point query on the already-approved host, with the Accept the API wants', () => {
  assert.equal(alertsUrl(35.18234, -83.38157), `${SERVICE}?point=35.1823,-83.3816`);
  assert.equal(requestHeaders().Accept, 'application/geo+json');
  assert.ok(alertsUrl(35.1823, -83.3815).startsWith('https://api.weather.gov/'), 'no second origin');
});

test('NONEMPTY: an alert in force carries its own times, its office and a link to the record', () => {
  const got = readAlerts(FIX.active, NOW);
  assert.equal(got.status, 'ok');
  assert.equal(got.inEffect.length, 2);
  const flood = got.inEffect[0];
  assert.equal(flood.event, 'Flash Flood Warning');
  assert.equal(flood.state, 'in-effect');
  assert.equal(flood.senderName, 'NWS Grand Junction CO');
  assert.equal(flood.areaDesc, 'Pitkin, CO');
  // The agency link is the alert's OWN record. All 386 live features carried
  // web: "http://www.weather.gov" -- the agency front page -- so `web` is never
  // offered as "details of this alert".
  assert.equal(flood.detailUrl, FLOOD.properties['@id']);
  assert.ok(flood.detailUrl.startsWith('https://api.weather.gov/alerts/'));
  assert.notEqual(flood.detailUrl, FLOOD.properties.web);
  assert.equal(flood.expiresMs, Date.parse(FLOOD.properties.expires));
  assert.equal(flood.sentMs, Date.parse(FLOOD.properties.sent));
  const html = alertsHtml({ status: 'ok', body: FIX.active }, DENVER, NOW);
  assert.match(html, /Flash Flood Warning/);
  assert.match(html, /NWS Grand Junction CO/);
  assert.match(html, new RegExp(flood.detailUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the reader needs a way to the agency record itself');
  assert.doesNotMatch(html, /\bnull\b|undefined|NaN|Invalid Date/);
});

test('the times are the ALERT’s own, stamped in the selected place’s zone', () => {
  const rows = alertRows({ status: 'ok', body: FIX.active }, DENVER, NOW);
  const flood = rows.find((r) => /Flash Flood Warning/.test(r.label));
  // 2026-09-14T20:15:00-06:00. In Denver that is 8:15 PM MDT; the same instant in
  // New York is 10:15 PM EDT. Reading the browser's zone, or UTC, gets this wrong.
  assert.match(flood.value, /Sep 14, 8:15[\s\u202f]PM MDT/);
  const east = alertRows({ status: 'ok', body: FIX.active },
    { name: 'x', timeZone: 'America/New_York' }, NOW).find((r) => /Flash Flood/.test(r.label));
  assert.match(east.value, /Sep 14, 10:15[\s\u202f]PM EDT/);
  // Issue time and end time are separate facts and both are shown: an alert sent an
  // hour ago and one sent a minute ago are different things to a reader.
  assert.match(effectText(readAlert(FLOOD, NOW), 'America/Denver'), /Issued/);
  assert.match(effectText(readAlert(FLOOD, NOW), 'America/Denver'), /until/i);
});

test('EMPTY: no product in force is an answer, and never a claim that nothing can hurt you', () => {
  const got = readAlerts(FIX.empty, NOW);
  assert.equal(got.status, 'ok');
  assert.deepEqual([got.inEffect.length, got.ended.length], [0, 0]);
  const html = alertsHtml({ status: 'ok', body: FIX.empty }, DENVER, NOW);
  assert.match(html, /no .*(alert|watch|warning|advisory)/i);
  assert.ok(QUIET_TEXT.length > 40 && /National Weather Service/.test(QUIET_TEXT));
  for (const s of [...readerStrings(), html]) {
    assert.doesNotMatch(s, ALL_HAZARD, `"${s.slice(0, 90)}" turns a quiet feed into a safety claim`);
  }
  assert.match(html, /not every hazard|does not cover every|only the hazards/i,
    'the card must say out loud what this feed is not');
});

test('EXPIRED: a held response goes out of date, and an ended alert stops being in effect', () => {
  // Same bytes, later clock. Nothing about the response changed; the flood warning's
  // own end time passed.
  const early = readAlerts(FIX.active, NOW), late = readAlerts(FIX.active, AFTER_FLOOD);
  assert.equal(early.inEffect.length, 2);
  assert.equal(late.inEffect.length, 1, 'the flood warning ended at 02:15Z');
  assert.equal(late.inEffect[0].event, 'Heat Advisory');
  assert.equal(late.ended.length, 1);
  assert.equal(late.ended[0].state, 'expired');
  assert.equal(late.ended[0].event, 'Flash Flood Warning');
  const html = alertsHtml({ status: 'ok', body: FIX.active }, DENVER, AFTER_FLOOD);
  assert.match(html, /Heat Advisory/);
  // The ended one may still be named -- a reader who saw it wants to know it lapsed --
  // but it comes AFTER what is in force, and its own line says it is over.
  assert.ok(html.indexOf('Heat Advisory') < html.indexOf('Flash Flood Warning'),
    'what is in force has to come before what has ended');
  assert.match(html.slice(html.indexOf('Flash Flood Warning')), /no longer in effect/i);
  assert.doesNotMatch(html.slice(0, html.indexOf('Flash Flood Warning')), /no longer in effect/i);
});

test('CANCELLED: a withdrawn product is not an alert, whatever its end time says', () => {
  // The cancelled fixture's end time is still in the future: only messageType says so.
  const cancelled = FIX.cancelled.features[0];
  assert.equal(cancelled.properties.messageType, 'Cancel');
  assert.ok(Date.parse(cancelled.properties.expires) > NOW, 'it has not expired -- it was withdrawn');
  const got = readAlerts(FIX.cancelled, NOW);
  assert.equal(got.inEffect.length, 0, 'a Cancel must never be counted as in force');
  assert.equal(got.ended.length, 1);
  assert.equal(got.ended[0].state, 'cancelled');
  const html = alertsHtml({ status: 'ok', body: FIX.cancelled }, DENVER, NOW);
  assert.match(html, /cancell?ed/i);
  assert.doesNotMatch(html, /in effect until/i);
});

test('POLYGONLESS: a zone-based alert is an alert, and it says where it actually applies', () => {
  assert.equal(HEAT.geometry, null, 'the fixture keeps the measured shape: 342 of 386 had none');
  const heat = readAlert(HEAT, NOW);
  assert.equal(heat.zoneBased, true);
  assert.equal(heat.state, 'in-effect');
  assert.deepEqual(heat.zones, HEAT.properties.geocode.UGC);
  assert.equal(heat.areaDesc, HEAT.properties.areaDesc);
  const html = alertsHtml({ status: 'ok', body: { ...FIX.active, features: [HEAT] } },
    { name: 'Travis County, TX', timeZone: 'America/Chicago' }, NOW);
  assert.match(html, /Heat Advisory/);
  assert.match(html, /Williamson; Travis/, 'the named areas are what a zone alert has instead of a shape');
  assert.match(html, /zone|county|area/i);
  // A polygon is not required to report an alert, and its absence must not be drawn
  // as precision the alert does not have.
  assert.doesNotMatch(html, /exact|precise(ly)? where|drawn boundary/i);
});

test('FAILED: a service failure is a stated state, and it cannot blank the forecast beside it', async () => {
  const boom = await fetchAlerts({ lat: 39.1, lon: -106.8, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(boom.status, 'failed');
  const http = await fetchAlerts({ lat: 39.1, lon: -106.8,
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => FIX.badRequest.body }) });
  assert.equal(http.status, 'failed');
  assert.equal(http.httpStatus, 400);
  const html = alertsHtml(http, DENVER, NOW);
  assert.match(html, /could not|unavailable|did not answer/i);
  assert.doesNotMatch(html, /no alerts|nothing in force|none in effect/i,
    'a failure must never be rendered as an empty answer -- that is the one lie this state can tell');
  assert.ok(FAILED_TEXT.length > 30);

  // The wiring: alerts are asked for separately from the hourly forecast and carry
  // their own catch, so neither can blank the other.
  assert.match(DASH, /qc-alerts/, 'the alerts card needs its own element to write into');
  const call = DASH.slice(DASH.lastIndexOf('alertsFor('));
  assert.match(call.slice(0, 400), /\.catch\(/, 'the alerts request needs its own failure path');
  assert.ok(!/alertsHtml[^\n]*qc-hourly/.test(DASH), 'the two cards must not share a slot');
  assert.ok(!/conditionsHtml[^\n]*qc-alerts/.test(DASH), 'nor the other way round');
});

test('the card names its publisher and never invents a hazard the feed did not state', () => {
  assert.equal(CREDIT, SOURCES.nwsAlerts.attribution);
  const html = alertsHtml({ status: 'ok', body: FIX.active }, DENVER, NOW);
  assert.match(html, new RegExp(CREDIT.split(',')[0]));
  assert.match(CARD_TITLE, /alert|warning|advisor/i);
  assert.match(CARD_CAVEAT, /not every hazard|does not cover every|only the hazards/i);
  for (const s of readerStrings()) {
    assert.doesNotMatch(s, /\bnull\b|undefined|NaN/, s);
    assert.doesNotMatch(s, ALL_HAZARD, s);
  }
});

test('the dashboard carries the alerts card, so a selected place has somewhere to report it', () => {
  assert.match(readFileSync(new URL('../../themes/headlessmode/layouts/_default/quiet-corners-dashboard.html', import.meta.url), 'utf8'),
    /id="qc-alerts"/, 'no host element for the alerts card');
});
