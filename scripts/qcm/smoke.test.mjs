// NOAA HMS smoke plumes: the contract this layer is most able to break.
//
// A smoke plume is ALOFT -- NOAA's density classes describe the column, not the air at head
// height -- so a string that reads as air quality is a factual error. The times are
// `YYYYDDD HHMM` STRINGS, so treating them as epoch milliseconds puts the analysis in 1970.
// And the product is DAYLIGHT-only: before the day's first analysis the layer is legitimately
// empty, which must never be drawn as "clear sky" -- the reason for the `max(Start)` question.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import {
  SERVICE, DENSITY_ORDER, parseHmsTime, smokeQueryFor, smokeQueryUrl, latestAnalysisUrl,
  serviceError, readPlumes, summarise, readLatestAnalysis, issuedState, areaReport,
  readerStrings, LAYER_LABEL, LAYER_CAVEAT,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-smoke.js';

const BBOX = { minLon: -91.2, minLat: 43.3, maxLon: -90.5, maxLat: 43.8 };
const NOW = Date.UTC(2026, 8, 14, 21, 0, 0);          // 2026-09-14 21:00Z, day 257

const plume = (Density, Start, End_) => ({
  type: 'Feature', properties: { Satellite: 'GOES-EAST', Density, Start, End_ },
  geometry: { type: 'Polygon', coordinates: [[[-91, 43.4], [-90.7, 43.4], [-90.7, 43.7], [-91, 43.4]]] },
});
const body = (...features) => ({ type: 'FeatureCollection', features });

test('the measured record says what this source is: an observation, aloft, on an origin already allowed', () => {
  const src = SOURCES.noaaHmsSmoke;
  assert.equal(src.claim, 'observation');
  assert.equal(src.origin, 'https://services2.arcgis.com');
  assert.equal(src.kind, 'feature-query');
  assert.equal(src.dateBasis, 'feature-field');
  // The two sentences the layer cannot be honest without.
  assert.match(src.coverageSemantics, /ALOFT/);
  assert.match(src.coverageSemantics, /DAYLIGHT/);
  assert.ok(src.serviceUrl.startsWith(src.origin));
});

test('`Start`/`End_` are day-of-year STRINGS, and anything else is unknown rather than 1970', () => {
  // 2026 day 257 is 2026-09-14. The whole reason this function exists.
  assert.equal(parseHmsTime('2026257 1200'), Date.UTC(2026, 8, 14, 12, 0, 0));
  assert.equal(parseHmsTime('2026257 1710'), Date.UTC(2026, 8, 14, 17, 10, 0));
  assert.equal(parseHmsTime('2026001 0000'), Date.UTC(2026, 0, 1, 0, 0, 0));
  // A number is NOT an epoch here. Reading one as milliseconds is the bug this guards.
  for (const bad of [1789430400000, '1789430400000', '2026257', '', null, undefined,
    'nonsense', '2026400 1200', '2026257 2500']) {
    assert.equal(parseHmsTime(bad), null, `${bad} must be unknown, not a date`);
  }
});

test('the view query is BOUNDED, simplified, and asks only for the fields that say something', () => {
  const q = smokeQueryFor(BBOX);
  assert.equal(q.url, `${SERVICE}/query`);
  assert.equal(q.params.geometry, '-91.2,43.3,-90.5,43.8');
  assert.equal(q.params.geometryType, 'esriGeometryEnvelope');
  assert.equal(q.params.inSR, '4326');
  assert.equal(q.params.f, 'geojson');           // the service hands back GeoJSON directly
  assert.equal(q.params.returnGeometry, 'true'); // a plume's whole point is WHERE it is
  assert.ok(Number(q.params.maxAllowableOffset) > 0, 'an unsimplified fetch is the national payload');
  for (const f of ['Satellite', 'Start', 'End_', 'Density']) {
    assert.ok(q.params.outFields.split(',').includes(f), `${f} is not asked for`);
  }
  const url = smokeQueryUrl(BBOX);
  assert.ok(url.startsWith('https://services2.arcgis.com/'), url);
  assert.doesNotMatch(url, /where=1(%3D|=)1/, 'the whole country is not a view');
  // The literal parentheses in the publisher's own path are left as the publisher writes
  // them: it answered that way, and percent-encoding them was never measured.
  assert.ok(url.includes('NOAA_Satellite_Smoke_Detection_(v1)'), url);
});

test('an ArcGIS error arrives inside a 200-shaped body, and `details` is where it is written', () => {
  const err = { error: { code: 400, message: '', details: ["'Invalid field: NOSUCHFIELD' parameter is invalid"] } };
  assert.match(serviceError(err), /Invalid field/);
  assert.equal(readPlumes(err).length, 0, 'an error envelope is not a set of plumes');
  // An error is never "no smoke here": that would paint a failure as a clear sky.
  const report = areaReport(err, null, NOW);
  assert.equal(report.known, false);
  assert.match(report.text, /could not be read/i);
  assert.doesNotMatch(report.text, /No smoke plume/i);
  assert.equal(serviceError(body()), null);
  assert.equal(serviceError(null), null);
});

test('a plume is read only when its density and its window both parse', () => {
  const rows = readPlumes(body(
    plume('Light', '2026257 1200', '2026257 1500'),
    plume('Heavy', '2026257 1710', '2026257 2000'),
    plume('Extreme', '2026257 1200', '2026257 1500'),   // not one of the publisher's three
    plume('Medium', 'nonsense', '2026257 1500'),        // unreadable window
  ));
  assert.deepEqual(rows.map((r) => r.density), ['Light', 'Heavy']);
  assert.equal(rows[0].startMs, Date.UTC(2026, 8, 14, 12, 0, 0));
  assert.equal(rows[1].endMs, Date.UTC(2026, 8, 14, 20, 0, 0));
  // Worst is the publisher's own class ORDER, never an average: NOAA published three
  // labels and an averaged label is one it never published.
  assert.deepEqual([...DENSITY_ORDER], ['Light', 'Medium', 'Heavy']);
  const at = summarise(rows);
  assert.equal(at.worst, 'Heavy');
  assert.equal(at.observedMs, Date.UTC(2026, 8, 14, 20, 0, 0));
  assert.equal(summarise([]).known, false);
});

test('an empty map before the day\'s first analysis is NOT clear air, and the statistics query tells them apart', () => {
  assert.ok(latestAnalysisUrl().includes('outStatistics'), 'the cheap question is a statistics query');
  assert.match(latestAnalysisUrl(), /returnGeometry=false/);
  assert.equal(readLatestAnalysis({ features: [{ attributes: { maxStart: '2026257 1710' } }] }), '2026257 1710');
  assert.equal(readLatestAnalysis({ features: [] }), null);

  // Same UTC day as the newest analysis: an empty view genuinely means no plume here.
  assert.equal(issuedState('2026257 1710', NOW).issuedToday, true);
  // 00:32Z on the 15th, newest analysis still day 257: the day's map is not out yet.
  const notYet = issuedState('2026257 1710', Date.UTC(2026, 8, 15, 0, 32, 0));
  assert.equal(notYet.issuedToday, false);
  assert.match(notYet.text, /not been analysed yet/i);
  assert.doesNotMatch(notYet.text, /no smoke/i, 'an unanalysed day must never read as no smoke');
  // The service saying nothing at all is its own unknown, not a quiet sky either.
  assert.equal(issuedState(null, NOW).issuedToday, false);

  const quiet = areaReport(body(), { features: [{ attributes: { maxStart: '2026257 1710' } }] }, NOW);
  assert.equal(quiet.known, false);
  assert.match(quiet.text, /No smoke plume/i);
  const blind = areaReport(body(), { features: [] }, NOW);
  assert.doesNotMatch(blind.text, /No smoke plume/i, 'no analysis at all is not an empty analysis');
});

test('every string this layer can show a reader talks about the column, never about air quality', () => {
  const strings = readerStrings(body(plume('Medium', '2026257 1200', '2026257 1500')), NOW);
  assert.ok(strings.length > 5);
  for (const s of strings) {
    assert.equal(typeof s, 'string');
    assert.doesNotMatch(s, /air quality|AQI|breathe|unhealthy/i,
      `"${s}" reads as ground-level air, and this layer measures the column`);
  }
  // The caveat carries BOTH limits: what the classes approximate, and that NOAA
  // guarantees nothing about them.
  assert.match(LAYER_CAVEAT, /column/i);
  assert.match(LAYER_CAVEAT, /no guarantee/i);
  assert.match(LAYER_CAVEAT, /daylight/i);
  assert.match(LAYER_LABEL, /smoke/i);
  // The report leads with the analysis WINDOW: a plume stated bare reads as the sky now.
  const report = areaReport(body(plume('Light', '2026257 1200', '2026257 1500')), null, NOW);
  assert.equal(report.known, true);
  assert.match(report.text, /12:00/);
  assert.match(report.text, /Light/);
});
