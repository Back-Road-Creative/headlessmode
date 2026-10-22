// The two BTS NTAD layers: Class I rail lines and public-use airports, both read from
// geo.dot.gov (the host the noise tiles already use). Measured 2026-10-20. Fixtures are the
// live responses, trimmed. What the tests pin: the source rows are inventories on an origin
// that is already in connect-src; the layers are screen-only checkboxes OUTSIDE the context
// group (which is a choice of one, so a preset could not hold noise beside them); a box over
// the area cap is never requested; a malformed geometry is dropped and counted; a capped
// answer says so; the preset composes within the budget with exactly one surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RAIL_MAX_BBOX_SQ_DEG, AIRPORT_MAX_BBOX_SQ_DEG, bboxAreaSqDeg, railBoxStatus, airportBoxStatus,
  railUrl, airportsUrl, readRail, readAirports, fetchRail, fetchAirports, railCardLines,
  airportCardLines, railReport, airportReport, railLayer, airportLayer, ntadReader,
  RAIL_ROW, AIRPORT_ROW, readerStrings,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-ntad-rail-airports.js';
import { SOURCES, cspDirectivesFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { LAYER_BY_ID, LAYERS, drapeKindFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';
import { SYMBOL_BY_KEY } from '../../themes/headlessmode/static/js/quiet-corners-maps/legend.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`fixtures/${n}`, import.meta.url), 'utf8'));
const rail = fx('ntad-rail-2026-10-20.min.json');
const air = fx('ntad-airports-2026-10-20.min.json');
const BOX = { minLon: -84.3, minLat: 35.5, maxLon: -83.3, maxLat: 36.3 };

test('both source rows are inventories on geo.dot.gov, keyless, with the measured fields', () => {
  for (const [id, geom, fields] of [
    ['btsRailClass1', 'esriGeometryPolyline', ['rrowner1', 'subdiv', 'tracks']],
    ['btsAirports', 'esriGeometryPoint', ['loc_id', 'fac_name', 'fac_use', 'city', 'state_name', 'role', 'category', 'icao_identifier', 'atc_tower']],
  ]) {
    const s = SOURCES[id];
    assert.ok(s, `no ${id} source`);
    assert.equal(s.kind, 'feature-query');
    assert.equal(s.origin, 'https://geo.dot.gov');
    assert.equal(s.cors, 'reflects-origin');
    assert.equal(s.claim, 'inventory');
    assert.equal(s.measuredOn, '2026-10-20');
    assert.equal(s.limits.maxRecordCount, 2000);
    assert.equal(s.layers[0].geometryType, geom);
    for (const f of fields) assert.ok(s.layers[0].fields.includes(f), `${id} lacks field ${f}`);
  }
  assert.equal(SOURCES.btsRailClass1.origin, SOURCES.btsTransportNoise.origin);
  const connect = cspDirectivesFor(SOURCES)['connect-src'] || [];
  assert.equal(connect.filter((o) => o === 'https://geo.dot.gov').length, 1, 'geo.dot.gov is in connect-src exactly once');
});

test('the layers are screen-only checkboxes outside the context group, and the symbols resolve', () => {
  for (const [row, id] of [[RAIL_ROW, 'railClass1'], [AIRPORT_ROW, 'airports']]) {
    assert.equal(LAYER_BY_ID[id].id, row.id);
    assert.equal(row.group, 'federal', 'the context group is a radio of one; noise + rail needs a checkbox group');
    assert.equal(row.screenOnly, true);
    assert.equal(row.defaultOn, false);
    assert.ok(!row.rasterSurface);
    assert.equal(row.status, 'live');
    assert.equal(drapeKindFor(LAYER_BY_ID[id]), false, `${id} must not be draped in 3D`);
    for (const k of row.symbolKeys) assert.ok(SYMBOL_BY_KEY[k], `${id} symbol ${k} resolves`);
    assert.equal(row.symbolKeys.length, 1);
  }
  assert.equal(SYMBOL_BY_KEY[RAIL_ROW.symbolKeys[0]].kind, 'line');
  assert.equal(SYMBOL_BY_KEY[AIRPORT_ROW.symbolKeys[0]].kind, 'point');
  assert.ok(LAYERS.includes(LAYER_BY_ID.railClass1) && LAYERS.includes(LAYER_BY_ID.airports));
});

test('the area caps are the measured ones and a wide box is never requested', () => {
  assert.equal(RAIL_MAX_BBOX_SQ_DEG, 9);     // 10 sq deg of Tennessee answered 1,987 of a 2,000 cap
  assert.equal(AIRPORT_MAX_BBOX_SQ_DEG, 50);
  assert.ok(Math.abs(bboxAreaSqDeg(BOX) - 0.8) < 1e-9);
  assert.equal(railBoxStatus(BOX).ok, true);
  assert.equal(railBoxStatus({ minLon: -90, minLat: 30, maxLon: -85, maxLat: 35 }).ok, false);
  assert.equal(airportBoxStatus({ minLon: -90, minLat: 30, maxLon: -85, maxLat: 35 }).ok, true);
  assert.equal(airportBoxStatus({ minLon: -100, minLat: 30, maxLon: -90, maxLat: 40 }).ok, false);
});

test('the query URLs ask only the measured fields, in lon/lat, for the box, with no key', () => {
  const r = new URL(railUrl(BOX));
  assert.equal(r.origin, 'https://geo.dot.gov');
  assert.ok(r.pathname.endsWith('/North_American_Class_1_Rail/FeatureServer/0/query'));
  assert.equal(r.searchParams.get('geometry'), '-84.3,35.5,-83.3,36.3');
  assert.equal(r.searchParams.get('inSR'), '4326');
  assert.equal(r.searchParams.get('outSR'), '4326');
  assert.equal(r.searchParams.get('outFields'), 'rrowner1,subdiv,tracks');
  assert.equal(r.searchParams.get('maxAllowableOffset'), '0.001');
  assert.equal(r.searchParams.get('resultRecordCount'), '2000');
  assert.equal(r.searchParams.get('f'), 'json');
  const a = new URL(airportsUrl(BOX));
  assert.ok(a.pathname.endsWith('/Airports_/FeatureServer/0/query'));
  assert.equal(a.searchParams.get('where'), "fac_use='PU'");
  assert.equal(a.searchParams.get('returnGeometry'), 'true');
  for (const u of [r, a]) assert.doesNotMatch(u.search, /key=|token=/i);
});

test('rail: lines read from the fixture; a malformed path is dropped and counted', () => {
  const got = readRail(rail);
  assert.equal(got.lines.length, 3);
  assert.equal(got.dropped, 0);
  assert.deepEqual(got.lines[0].paths[0][0], [36.866, -82.8526], 'Leaflet order: lat, lon');
  assert.equal(got.lines[0].owner, 'NS');
  const bad = { features: [...rail.features, { attributes: {}, geometry: { paths: [[[1, 2]]] } },
    { attributes: {}, geometry: null }, { attributes: {}, geometry: { paths: [[[NaN, 3], [4, 5]]] } }] };
  const dirty = readRail(bad);
  assert.equal(dirty.lines.length, 3);
  assert.equal(dirty.dropped, 3);
  assert.equal(readRail(null).lines.length, 0);
  assert.equal(readRail({ exceededTransferLimit: true, features: rail.features }).capped, true);
});

test('airports: points read from the fixture; a missing coordinate is dropped and counted', () => {
  const got = readAirports(air);
  assert.equal(got.airports.length, 4);
  assert.equal(got.airports[0].id, 'DCM');
  assert.equal(got.airports[0].icao, 'KDCM');
  assert.ok(Math.abs(got.airports[0].lat - 34.7893) < 1e-3 && Math.abs(got.airports[0].lon + 81.1957) < 1e-3);
  const dirty = readAirports({ features: [...air.features, { attributes: { loc_id: 'X' }, geometry: {} },
    { attributes: { loc_id: 'Y' } }] });
  assert.equal(dirty.airports.length, 4);
  assert.equal(dirty.dropped, 2);
  assert.equal(readAirports({ exceededTransferLimit: true, features: air.features }).capped, true);
});

test('cards say what the record says and nothing more', () => {
  const [a] = readAirports(air).airports;
  const lines = airportCardLines(a);
  assert.match(lines[0], /CHESTER CATAWBA RGNL/);
  assert.ok(lines.some((l) => /DCM/.test(l)) && lines.some((l) => /KDCM/.test(l)));
  assert.ok(lines.some((l) => /CHESTER, SOUTH CAROLINA/.test(l)));
  const bare = airportCardLines(readAirports({ features: [air.features[3]] }).airports[0]);
  assert.ok(bare.every((l) => !/null|undefined/.test(l)), bare.join('|'));
  const l = railCardLines(readRail(rail).lines[0]);
  assert.match(l.join(' '), /NS/);
  assert.match(l.join(' '), /ST CHARLES BRANCH/);
  assert.ok(l.every((x) => !/null|undefined/.test(x)));
});

test('a refused, failed, empty or capped view is a sentence, never a blank', async () => {
  let asked = 0;
  const never = async () => { asked += 1; throw new Error('should not be asked'); };
  const wide = { minLon: -90, minLat: 30, maxLon: -85, maxLat: 35 };
  assert.equal((await fetchRail(wide, { fetchImpl: never })).status, 'too-wide');
  assert.equal(asked, 0);
  const ok = (body) => async () => ({ ok: true, json: async () => body });
  const down = async () => ({ ok: false, status: 503 });
  assert.equal((await fetchRail(BOX, { fetchImpl: down })).status, 'unavailable');
  assert.equal((await fetchRail(BOX, { fetchImpl: async () => { throw new Error('x'); } })).status, 'unavailable');
  assert.equal((await fetchRail(BOX, { fetchImpl: ok({ error: { message: 'bad' } }) })).status, 'unavailable');
  assert.equal((await fetchRail(BOX, { fetchImpl: ok({ features: [] }) })).status, 'empty');
  const got = await fetchRail(BOX, { fetchImpl: ok(rail), nowMs: 5 });
  assert.equal(got.status, 'ready');
  assert.equal(got.lines.length, 3);
  const ap = await fetchAirports(BOX, { fetchImpl: ok({ ...air, exceededTransferLimit: true }) });
  assert.equal(ap.status, 'ready');
  assert.equal(ap.capped, true);
  assert.match(airportReport(ap).text, /more airports than/);
  assert.match(railReport({ status: 'too-wide' }).text, /9 square degrees/);
  assert.match(railReport({ status: 'unavailable' }).text, /did not answer/);
  assert.match(railReport({ status: 'empty' }).text, /no Class I/i);
  assert.match(airportReport({ status: 'empty' }).text, /no public-use/i);
  assert.match(railReport(got).text, /3 rail segments/);
});

test('the Leaflet groups draw one thing per record and set text, not markup', () => {
  const made = [];
  const L = {
    layerGroup: () => ({ clearLayers() { made.length = 0; }, addLayer() {} }),
    polyline: (pts, o) => { const x = { pts, o, bindPopup() { return x; }, addTo() { made.push(x); return x; } }; return x; },
    circleMarker: (pt, o) => { const x = { pt, o, bindPopup() { return x; }, addTo() { made.push(x); return x; } }; return x; },
  };
  const rl = railLayer(L); rl.draw(readRail(rail).lines);
  assert.equal(made.length, 3);
  const al = airportLayer(L); al.draw(readAirports(air).airports);
  assert.equal(made.length, 4);
  assert.equal(made[0].o.keyboard, true);
});

test('the reader waits out a drag; an answer for a view the reader left is dropped', async () => {
  const timers = [];
  const reader = ntadReader({ fetchFn: async () => ({ status: 'ready' }), waitMs: 5,
    setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
  const got = [];
  const first = reader.ask(BOX, (r) => got.push(['a', r.status]));
  const second = reader.ask(BOX, (r) => got.push(['b', r.status]));
  assert.equal(await first, false);
  await timers[1]();
  assert.equal(await second, true);
  assert.deepEqual(got, [['b', 'ready']]);
});

test('every reader-facing string frames rail and airports as inventory, not a noise or safety claim', () => {
  const all = readerStrings();
  assert.ok(all.length > 8);
  for (const s of all) {
    assert.doesNotMatch(s, /\b(safe|quiet enough|too loud|decibel|dB)\b/i, s);
  }
  assert.match(RAIL_ROW.coverageCaveat, /not a measurement of noise/i);
  assert.match(AIRPORT_ROW.coverageCaveat, /not a measurement of noise/i);
  assert.match(RAIL_ROW.coverageCaveat, /Class I/);
  assert.match(AIRPORT_ROW.coverageCaveat, /public-use/i);
});
