// The AirNow AQI contour source, against the bytes the service actually returned. No network.
//
// The gate that matters most is a CLAIM gate, not a tense gate. The records carry `gridcode` and
// nothing else -- no pollutant field, no index value anywhere in the layer -- so "the category
// over this area, as of this hour" is the only true sentence this source can make, and naming a
// pollutant or standing a number where the index would go invents it, the failure
// aurora.test.mjs guards the other way round. The fixture is the live 2026-09-12 query for the
// western US (-125,31 to -95,49): 58 records, returnGeometry=false.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SOURCES, cspDirectivesFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import {
  SERVICE, CREDIT, CATEGORY_BY_GRIDCODE, STALE_AFTER_MINUTES, aqiQueryFor, aqiQueryUrl,
  readFeatures, summarise, frameVintage, categoryText, quietText, fetchAqi, readerStrings,
  LAYER_LABEL, LAYER_CAVEAT, aqiLayer, areaReport, aqiReader,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-aqi.js';
import { LAYER_BY_ID } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';

const MODULE = new URL('../../themes/headlessmode/static/js/quiet-corners-maps/source-aqi.js', import.meta.url);
const body = JSON.parse(readFileSync(new URL('fixtures/airnow-aqi-contours-2026-09-12.min.json', import.meta.url), 'utf8'));
const OBSERVED_MS = 1789210800000;   // the fixture's own Timestamp: 2026-09-12T11:00:00Z
const WEST = { minLon: -125, minLat: 31, maxLon: -95, maxLat: 49 };
const EAST = { minLon: -85, minLat: 31, maxLon: -66, maxLat: 47 };
// A pollutant the records do not name, and a number standing where the index would be.
const POLLUTANT = /\b(pm\s?-?2\.5|pm\s?-?10|ozone|particulate|particle pollution|nitrogen dioxide|sulfur dioxide|carbon monoxide|smoke)\b/i;
const ABBREV = /\b(O3|NO2|SO2|CO|PM2\.5|PM10)\b/;
const NUMERIC_INDEX = /\b(aqi|air quality index|index)\b[^.]{0,24}?\d/i;

test('the registry entry, the category names and the CSP record what was measured', () => {
  const s = SOURCES.epaAirNowAqi;
  assert.equal(s.serviceUrl, SERVICE);
  assert.equal(s.limits.requiresKey, false, 'the whole point of choosing this one: no key, no account');
  assert.equal(s.limits.maxRecordCount, 2000);
  assert.deepEqual([s.kind, s.cors, s.measuredOn], ['feature-query', 'wildcard', '2026-09-12']);
  assert.equal(s.dateBasis, 'feature-field', 'the age comes from the RECORD, not from service metadata');
  assert.deepEqual(s.layers[0].fields,
    ['OBJECTID', 'Id', 'gridcode', 'Unixtime', 'Timestamp', 'Shape__Area', 'Shape__Length'],
    'the WHOLE field list: no pollutant field and no index value exist to read');
  assert.doesNotMatch(s.coverageSemantics, /forecast/i,
    'the FeatureServer root calls itself a forecast; layer 0 is the latest hour, and the entry must not copy it');
  // The six names are the service's own renderer labels, not a scale this app invented.
  assert.deepEqual(Object.keys(CATEGORY_BY_GRIDCODE), ['1', '2', '3', '4', '5', '6']);
  assert.deepEqual([CATEGORY_BY_GRIDCODE[1], CATEGORY_BY_GRIDCODE[2], CATEGORY_BY_GRIDCODE[3], CATEGORY_BY_GRIDCODE[6]],
    ['Good', 'Moderate', 'Unhealthy for Sensitive Groups', 'Hazardous']);
  const csp = cspDirectivesFor();
  assert.ok(csp['connect-src'].includes(s.origin), 'the app fetches this JSON, so connect-src carries its origin');
  assert.ok(!csp['img-src'].includes(s.origin), 'nothing here is painted through an <img>; img-src is not widened');
});

test('a bbox is asked of the service in its own query language, geometry left behind', () => {
  const req = aqiQueryFor(WEST);
  assert.equal(req.url, `${SERVICE}/query`);
  // inSR 4326 because the bbox is lon/lat and the layer is 3857; returnGeometry false
  // because nothing is drawn in this PR and the contours are national.
  assert.deepEqual(req.params, {
    geometry: '-125,31,-95,49', geometryType: 'esriGeometryEnvelope', inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', returnGeometry: 'false',
    outFields: 'OBJECTID,Id,gridcode,Unixtime,Timestamp', f: 'json',
  });
  assert.ok(aqiQueryUrl(WEST).startsWith(`${SERVICE}/query?`));
  assert.doesNotMatch(aqiQueryUrl(WEST), /(key|token|apikey)=/i);
});

test('a response is read into records and summarised to the WORST category over the area', () => {
  const rows = readFeatures(body);
  assert.equal(rows.length, 58, 'the live query returned 58 contours for the western US');
  assert.ok(rows.every((r) => r.gridcode >= 1 && r.gridcode <= 6));
  assert.ok(rows.every((r) => r.observedMs === OBSERVED_MS), 'every record in the layer shares one hour');
  for (const bad of [null, undefined, {}, { features: null }, { features: [{}] }, { error: { code: 400 } }]) {
    assert.deepEqual(readFeatures(bad), [], `${JSON.stringify(bad)} is nothing, not a throw`);
  }
  const s = summarise(rows);
  assert.equal(s.known, true);
  assert.equal(s.count, 58);
  assert.equal(s.worst, 2, 'the fixture holds gridcodes 1 and 2; the worse of the two is what a reader needs');
  assert.equal(s.category, 'Moderate');
  assert.equal(s.observedMs, OBSERVED_MS);
  // Empty is a reading, not a failure: the contours cover the US only.
  assert.deepEqual(summarise([]), { known: false, count: 0, worst: null, category: null, observedMs: null });
});

test('the frame carries its own age, from the record Timestamp, and says when it is too old', () => {
  const fresh = frameVintage(OBSERVED_MS, OBSERVED_MS + 40 * 60000);
  assert.equal(fresh.known, true);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.minutes, 40);
  assert.match(fresh.text, /11:00 UTC/, 'the hour the reading belongs to, not the hour it was fetched');
  assert.match(fresh.text, /40 minutes ago/);
  // Measured 2026-09-12 13:24Z: the newest contour in the whole layer was 11:00Z, 144
  // minutes back. A radar-style 20-minute floor would call every frame stale.
  assert.ok(STALE_AFTER_MINUTES > 144, "the floor has to clear the service's own measured lag");
  assert.equal(frameVintage(OBSERVED_MS, OBSERVED_MS + 144 * 60000).stale, false);
  const old = frameVintage(OBSERVED_MS, OBSERVED_MS + (STALE_AFTER_MINUTES + 1) * 60000);
  assert.equal(old.stale, true);
  assert.match(old.text, /too old to act on/i);
  for (const bad of [null, undefined, 0, NaN, 'x']) {
    assert.deepEqual({ ...frameVintage(bad), text: 0 }, { known: false, stale: true, minutes: null, text: 0 });
    assert.match(frameVintage(bad).text, /unknown/i, 'an unstated hour is said, never assumed current');
  }
});

test('nothing this source shows a reader names a pollutant or stands a number as the index', () => {
  const text = categoryText(summarise(readFeatures(body)));
  assert.match(text, /Moderate/);
  assert.match(text, /category/i, 'what the layer holds is a category, and the word is not optional');
  assert.doesNotMatch(text, /\d/,
    'a digit here would read as an index value, and there is no index value in the layer');
  assert.equal(categoryText(summarise([])), quietText());
  assert.match(quietText(), /no .*contour/i);
  const strings = readerStrings(body);
  assert.ok(strings.length >= 5);
  for (const s of [...strings, CREDIT]) {
    assert.doesNotMatch(s, POLLUTANT, `the layer has no pollutant field; naming one invents it: ${s}`);
    assert.doesNotMatch(s, ABBREV, `pollutant abbreviation in a reader string: ${s}`);
    assert.doesNotMatch(s, NUMERIC_INDEX, `no index value exists, so no number may stand as one: ${s}`);
    assert.doesNotMatch(s, /\d\s*(µg|ug\/|ppb|ppm)/i, `a concentration this source never read: ${s}`);
  }
  // And the module's own literals, template literals included: a backtick sentence
  // reaches a reader exactly as a quoted one does.
  const code = readFileSync(MODULE, 'utf8').split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  for (const m of code.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)) {
    assert.doesNotMatch(m[2], POLLUTANT, `literal names a pollutant the records do not carry: ${m[2]}`);
    assert.doesNotMatch(m[2], NUMERIC_INDEX, `literal stands a number where the index would go: ${m[2]}`);
  }
});

test('the service is asked only when something asks, and a refusal loses nothing else', async () => {
  const calls = [];
  const ok = async (url) => { calls.push(url); return { ok: true, json: async () => body }; };
  assert.equal(calls.length, 0, 'importing the module must not fetch');
  const got = await fetchAqi(WEST, { fetchImpl: ok });
  assert.equal(calls.length, 1);
  assert.equal(calls[0], aqiQueryUrl(WEST), 'the bbox the caller asked about, not the whole country');
  assert.equal(readFeatures(got).length, 58);
  assert.equal(await fetchAqi(WEST, { fetchImpl: async () => ({ ok: false, status: 503 }) }), null);
  assert.equal(await fetchAqi(WEST, { fetchImpl: async () => { throw new Error('offline'); } }), null);
  assert.equal(await fetchAqi(WEST, { fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('x'); } }) }), null);
});

// --- the switch half ------------------------------------------------------------------
// A fake clock, because the debounce is the behaviour under test and a real 400 ms wait
// in a unit suite is a sleep, not a proof.
const fakeClock = () => {
  const q = [];
  return {
    set(fn) { return q.push(fn); },
    clear(id) { if (id) q[id - 1] = null; },
    run() { for (let i = 0; i < q.length; i += 1) { const fn = q[i]; q[i] = null; if (fn) fn(); } },
  };
};
const tick = () => new Promise((r) => { setImmediate(r); });

test('the layer is offered on screen only, and off until it is asked for', () => {
  const l = LAYER_BY_ID.epaAirNowAqi;
  assert.equal(l.sourceId, 'epaAirNowAqi');
  assert.equal(l.group, 'context');
  assert.equal(l.screenOnly, true, 'an hour-old surface has no business on a printed sheet');
  assert.equal(l.defaultOn, false, 'nothing is asked of the service for a reader who never asked');
  assert.equal(l.status, 'live');
  // NOT aurora's 'none': the contours stop at the border, and the source's own quietText
  // says an uncovered area is the service not saying rather than clean air.
  assert.equal(l.emptyMeans, 'ambiguous');
  assert.equal(l.label, LAYER_LABEL);
  assert.equal(l.coverageCaveat, LAYER_CAVEAT);
  assert.match(LAYER_CAVEAT, /interpolated between monitors/i,
    "EPA's own words: ground with no monitor near it still takes a colour");
  assert.match(LAYER_CAVEAT, /not fully verified and validated/i, "EPA's own words about the hourly data");
});

test('the box covers the area asked about, and a worse category is a stronger shade', () => {
  const drawn = [];
  const L = {
    layerGroup: () => ({ clearLayers() {}, addTo() { return this; } }),
    rectangle: (bounds, opts) => { drawn.push({ bounds, opts }); return { addTo() {} }; },
  };
  const layer = aqiLayer(L);
  layer.draw(readFeatures(body), WEST);
  assert.equal(drawn.length, 1, 'one box over the area asked about: the query leaves the outlines behind');
  assert.deepEqual(drawn[0].bounds, [[31, -125], [49, -95]]);
  assert.equal(drawn[0].opts.interactive, false);
  layer.draw([], WEST);
  layer.draw(readFeatures(body), null);
  assert.equal(drawn.length, 1, 'nothing to say draws nothing at all, rather than an empty box');
  layer.draw([{ gridcode: 6, category: CATEGORY_BY_GRIDCODE[6], observedMs: OBSERVED_MS }], WEST);
  assert.ok(drawn[1].opts.fillOpacity > drawn[0].opts.fillOpacity, 'Hazardous must not read like Moderate');
});

test('the row leads with the HOUR and only then the category', () => {
  const r = areaReport(body, OBSERVED_MS + 40 * 60000);
  assert.equal(r.known, true);
  assert.match(r.text, /40 minutes ago/);
  // The whole point. Measured at the probe: the newest contour in the layer was 144
  // minutes behind the wall clock, so a category stated bare reads as the air outside.
  assert.ok(r.text.indexOf('11:00 UTC') < r.text.indexOf('Moderate'),
    'the hour the reading belongs to must come before the category it qualifies');
  const old = areaReport(body, OBSERVED_MS + (STALE_AFTER_MINUTES + 1) * 60000);
  assert.equal(old.stale, true);
  assert.ok(old.text.indexOf('11:00 UTC') < old.text.indexOf('Moderate'), 'a stale row leads with the hour too');
  // Nothing over the area states no category at all, so it needs no hour.
  assert.equal(areaReport({ features: [] }, OBSERVED_MS).known, false);
  assert.equal(areaReport({ features: [] }, OBSERVED_MS).text, quietText());
  assert.equal(areaReport(null, OBSERVED_MS).text, quietText());
  // A capped page cannot promise the worst: the service stopped short of the answer.
  assert.match(areaReport({ ...body, exceededTransferLimit: true }, OBSERVED_MS + 60000).text, /capped/i);
});

test('a pan is a new bounded question: debounced, and the stale one abandoned', async () => {
  const clock = fakeClock();
  const seen = [];
  const reader = aqiReader({
    fetchImpl: async (url, opts) => { seen.push({ url, signal: opts.signal }); return { ok: true, json: async () => body }; },
    setTimer: clock.set, clearTimer: clock.clear,
  });
  const got = [];
  const a = reader.ask(WEST, (b) => got.push(readFeatures(b).length));
  const c = reader.ask(EAST, (b) => got.push(readFeatures(b).length));
  clock.run(); await tick();
  assert.equal(seen.length, 1, 'a drag must cost one request, not one per frame');
  assert.equal(seen[0].url, aqiQueryUrl(EAST), 'the view the reader ended on, not the one they left');
  assert.equal(await a, false, 'the superseded ask reports that it was dropped');
  assert.equal(await c, true);
  assert.deepEqual(got, [58]);
});

test('an in-flight query is abandoned the moment a newer view asks', async () => {
  const clock = fakeClock();
  const seen = [];
  let release;
  const reader = aqiReader({
    fetchImpl: async (url, opts) => {
      seen.push({ url, signal: opts.signal });
      if (seen.length === 1) await new Promise((r) => { release = r; });
      return { ok: true, json: async () => body };
    },
    setTimer: clock.set, clearTimer: clock.clear,
  });
  const got = [];
  const first = reader.ask(WEST, () => got.push('west'));
  clock.run(); await tick();
  assert.equal(seen.length, 1);
  const second = reader.ask(EAST, () => got.push('east'));
  assert.equal(seen[0].signal.aborted, true, 'the request for the view you left is abandoned, not awaited');
  assert.equal(await first, false);
  clock.run(); await tick();
  release(); await tick();
  assert.equal(await second, true);
  assert.deepEqual(got, ['east'], 'a late answer about the old view must never reach the row');
  reader.cancel();
});

test('no string and no literal this layer can show a reader offers a forecast', () => {
  // The FeatureServer ROOT calls itself "AirNow National AQI Forecast Updated Nightly".
  // That is boilerplate from another service; layer 0 is an observation of a past hour.
  const FORECASTY = /\b(forecast|outlook|expected|expect|tonight|later today|will be|due to)\b/i;
  const strings = [...readerStrings(body), LAYER_LABEL, LAYER_CAVEAT,
    areaReport(body, OBSERVED_MS + 60000).text, areaReport(null, OBSERVED_MS).text];
  assert.ok(strings.some((s) => s === LAYER_CAVEAT), 'the caveat is a reader-facing string like any other');
  for (const s of strings) {
    assert.doesNotMatch(s, FORECASTY, `this source is an observation of a past hour, never a forecast: ${s}`);
    assert.doesNotMatch(s, POLLUTANT, `the layer has no pollutant field; naming one invents it: ${s}`);
    assert.doesNotMatch(s, ABBREV, `pollutant abbreviation in a reader string: ${s}`);
    assert.doesNotMatch(s, NUMERIC_INDEX, `no index value exists, so no number may stand as one: ${s}`);
  }
  const code = readFileSync(MODULE, 'utf8').split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  for (const m of code.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)) {
    assert.doesNotMatch(m[2], FORECASTY, `literal offers a forecast this source cannot make: ${m[2]}`);
  }
});

test('the app reads the switch by its registry id and asks again when the view moves', () => {
  const main = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
  assert.match(main, /layers\.epaAirNowAqi/, 'the control has to be read by its registry id');
  assert.match(main, /qcm-layer-epaAirNowAqi-report/, 'the row it writes into');
  assert.match(main, /map\.on\('moveend zoomend', renderAqi\)/,
    'a bbox query makes a pan a NEW question, unlike the one global file aurora holds');
  assert.match(main, /aqiReader\(/, 'unbounded, a drag fires one query per frame');
  assert.ok(!/if \(!aqiBody\) aqiBody = await/.test(main),
    "aurora's fetch-once gate would enforce the wrong behaviour for a bbox query");
  const off = main.slice(main.indexOf('async function renderAqi'));
  assert.match(off.slice(0, off.indexOf('}\n\n')), /hidden = true/, 'switching off clears the row');
});
