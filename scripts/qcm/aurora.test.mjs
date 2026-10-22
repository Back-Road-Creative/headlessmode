// The aurora source, against the bytes the service actually returned. No network.
//
// The gate that matters most here is the INVERSE of the radar one. Radar is an
// observation and must never be offered as an outlook; this is an outlook -- the
// payload's own `Observation Time` and `Forecast Time` are 66 minutes apart -- and must
// never be offered as a look at the sky now. Copying radar's wording gate across would
// have enforced the wrong promise, so this file asserts the opposite direction.
//
// The fixture is the live 2026-09-11 17:00Z payload cut to the US longitudes (235..294
// in the grid's own 0..359) and 40..70N, which keeps both states the layer has to get
// right: flat zero over the lower 48, and real values up near 65N.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SOURCES, cspDirectivesFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import {
  SERVICE, VISIBLE_AT_LEAST, toSignedLon, toGridLon, readForecast, cellsInBbox,
  summarise, forecastHorizon, quietText, fetchAurora, readerStrings,
  LAYER_LABEL, cellBounds, auroraLayer, areaReport,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-aurora.js';
import { LAYER_BY_ID } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';

const body = JSON.parse(readFileSync(new URL('fixtures/swpc-ovation-2026-09-11.min.json', import.meta.url), 'utf8'));

test('the registry entry records what the payload actually says about itself', () => {
  const s = SOURCES.swpcAurora;
  assert.equal(s.kind, 'gridded-forecast');
  assert.equal(s.serviceUrl, SERVICE);
  assert.deepEqual(s.grid.lonRange, [0, 359], 'the grid is 0..359, and the entry has to say so');
  assert.equal(s.grid.cellDegrees, 1);
  assert.deepEqual(s.grid.valueRange, [0, 15]);
  assert.equal(s.limits.requiresKey, false);
  assert.match(s.coverageSemantics, /forecast/i);
  assert.equal(s.dateBasis, 'service-metadata');
});

test('the origin reaches the CSP as a fetch target, and not as an image source', () => {
  const csp = cspDirectivesFor();
  assert.ok(csp['connect-src'].includes('https://services.swpc.noaa.gov'),
    'the app fetches this JSON, so connect-src has to carry its origin');
  assert.ok(!csp['img-src'].includes('https://services.swpc.noaa.gov'),
    'nothing here is painted through an <img>; img-src must not be widened for it');
});

test('grid longitudes are 0..359 and converting is what puts a US cell in North America', () => {
  assert.equal(toSignedLon(270), -90, 'a US longitude of -90 is 270 in this grid');
  assert.equal(toSignedLon(235), -125);
  assert.equal(toSignedLon(0), 0);
  assert.equal(toSignedLon(180), 180, 'the seam itself stays put');
  assert.equal(toGridLon(-90), 270);
  assert.equal(toGridLon(12), 12);
  // Round trip every longitude the grid can hold.
  for (let lon = 0; lon <= 359; lon += 1) assert.equal(toGridLon(toSignedLon(lon)), lon, `lon ${lon}`);
  // The failure this prevents: reading the raw value as a signed longitude puts a
  // Montana cell in Mongolia.
  assert.ok(toSignedLon(250) < -100 && 250 > 100, 'raw grid longitudes are not signed longitudes');
});

test('the payload states its own forecast horizon, and a body without one is unknown', () => {
  const f = readForecast(body);
  assert.equal(f.known, true);
  assert.equal(f.horizonMinutes, 66, 'measured: 17:00:00Z observed, 18:06:00Z forecast');
  assert.ok(f.forecastMs > f.observedMs, 'the forecast is AHEAD of the observation');
  for (const bad of [null, {}, { 'Observation Time': 'x', 'Forecast Time': 'y' }]) {
    assert.equal(readForecast(bad).known, false);
    assert.equal(readForecast(bad).horizonMinutes, null);
  }
});

test('a drawn area reads its own cells, and the lower 48 is quiet rather than broken', () => {
  const lower48 = cellsInBbox(body, { minLon: -125, minLat: 40, maxLon: -66, maxLat: 49 });
  assert.ok(lower48.length > 0, 'the fixture covers this band');
  assert.ok(lower48.every((c) => c.lon >= -125 && c.lon <= -66), 'cells come back in signed longitudes');
  const quiet = summarise(lower48);
  assert.equal(quiet.peak, 0);
  assert.equal(quiet.anyVisible, false, 'flat zero over the lower 48 is the measured normal');
  assert.match(quietText(), /usual answer/i, 'nothing to show is reported as ordinary, not as a gap');
});

test('a high-latitude area reads real values, so quiet is a reading and not a dead path', () => {
  const north = cellsInBbox(body, { minLon: -125, minLat: 64, maxLon: -66, maxLat: 70 });
  const lit = summarise(north);
  assert.ok(lit.peak >= VISIBLE_AT_LEAST, `nothing non-zero near 65N (peak ${lit.peak})`);
  assert.equal(lit.anyVisible, true);
  assert.ok(lit.peak <= 15, 'the grid tops out at 15');
});

test('nothing this layer can show a reader calls it a picture of the sky now', () => {
  const strings = readerStrings(body);
  assert.ok(strings.length >= 3);
  for (const s of strings) {
    assert.doesNotMatch(s, /\b(right now|currently visible|happening now|observed now|is visible now)\b/i,
      `this source is an outlook, never an observation of now: ${s}`);
  }
  const horizon = forecastHorizon(body, Date.parse('2026-09-11T17:30:00Z'));
  assert.match(horizon.text, /forecast/i, 'the word forecast is not optional here');
  assert.match(horizon.text, /18:06 UTC/, 'the forecast time itself, not the time it was drawn');
  assert.match(horizon.text, /not a picture of the sky/i);
  assert.equal(forecastHorizon(null).known, false);
});

test('no string literal in the module claims an observation either', () => {
  const src = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/source-aurora.js', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  // Template literals included: a backtick sentence reaches a reader exactly as a
  // quoted one does.
  for (const m of code.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)) {
    assert.doesNotMatch(m[2], /\b(right now|currently visible|happening now|is visible now)\b/i,
      `literal promises an observation: ${m[2]}`);
  }
});

test('the service is asked for only when something asks, and a refusal loses nothing else', async () => {
  let calls = 0;
  const ok = async () => { calls += 1; return { ok: true, json: async () => body }; };
  assert.equal(calls, 0, 'importing the module must not fetch ~900 KB');
  const got = await fetchAurora({ fetchImpl: ok });
  assert.equal(calls, 1);
  assert.equal(readForecast(got).horizonMinutes, 66);

  assert.equal(await fetchAurora({ fetchImpl: async () => ({ ok: false, status: 503 }) }), null);
  assert.equal(await fetchAurora({ fetchImpl: async () => { throw new Error('offline'); } }), null);
});

test('the layer is offered on screen only, and off until it is asked for', () => {
  const l = LAYER_BY_ID.swpcAurora;
  assert.equal(l.sourceId, 'swpcAurora');
  assert.equal(l.screenOnly, true, 'an hour-ahead outlook has no business on a printed sheet');
  assert.equal(l.defaultOn, false, '~900 KB must not be fetched for a reader who never asked');
  assert.equal(l.emptyMeans, 'none', 'zero over the lower 48 is the answer, not a gap');
  assert.match(l.label, /forecast/i, 'the label is the one string a reader is guaranteed to see');
});

test('a cell is drawn as the box the model meant, not half a cell off', () => {
  assert.deepEqual(cellBounds({ lon: -90, lat: 45 }), { minLon: -90, minLat: 45, maxLon: -89, maxLat: 46 });
});

test('only cells worth drawing get a box, and the value carries into the shading', () => {
  const drawn = [];
  const L = {
    layerGroup: () => ({ clearLayers() {}, addTo() { return this; } }),
    rectangle: (bounds, opts) => { drawn.push({ bounds, opts }); return { addTo() {} }; },
  };
  const layer = auroraLayer(L);
  layer.draw([
    { lon: -90, lat: 45, value: 0 },
    { lon: -91, lat: 45, value: VISIBLE_AT_LEAST - 0.5 },
    { lon: -92, lat: 65, value: 3 },
    { lon: -93, lat: 66, value: 15 },
  ]);
  assert.equal(drawn.length, 2, 'a cell below the floor is not drawn at all, not drawn faintly');
  assert.ok(drawn[1].opts.fillOpacity > drawn[0].opts.fillOpacity, 'a 15 must not read like a 3');
  assert.ok(drawn.every((d) => d.opts.interactive === false));
});

test("the row leads with the forecast time, whether or not there is anything to report", () => {
  const now = Date.parse('2026-09-11T17:30:00Z');
  const quiet = areaReport(body, { minLon: -125, minLat: 40, maxLon: -66, maxLat: 49 }, now);
  assert.equal(quiet.anyVisible, false);
  assert.match(quiet.text, /18:06 UTC/, 'the horizon comes first even when the answer is nothing');
  assert.match(quiet.text, /usual answer/i);

  const lit = areaReport(body, { minLon: -125, minLat: 64, maxLon: -66, maxLat: 70 }, now);
  assert.equal(lit.anyVisible, true);
  assert.match(lit.text, /18:06 UTC/);
  assert.match(lit.text, /out of 15/, 'a bare number would not say what scale it is on');
  // The whole point: a peak is never stated without its horizon attached.
  assert.ok(lit.text.indexOf('18:06') < lit.text.indexOf('out of 15'),
    'the forecast time must come before the number it qualifies');

  assert.equal(areaReport(null, { minLon: -1, minLat: -1, maxLon: 1, maxLat: 1 }, now).anyVisible, false);
});

test('the app reads the switch by its registry id and clears the row when it goes off', () => {
  const main = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
  // layers-reach-paper.test.mjs wants the literal read; this asserts the behaviour
  // around it that a literal cannot see.
  assert.match(main, /layers\.swpcAurora/, 'the control has to be read by its registry id');
  assert.match(main, /qcm-layer-swpcAurora-report/, 'the row it writes into');
  assert.match(main, /if \(!auroraBody\) auroraBody = await fetchAurora/,
    '~900 KB is fetched once on the way in, not again on every pan');
  const off = main.slice(main.indexOf('async function renderAurora'));
  assert.match(off.slice(0, off.indexOf('}\n\n')), /hidden = true/, 'switching off clears the row');
});
