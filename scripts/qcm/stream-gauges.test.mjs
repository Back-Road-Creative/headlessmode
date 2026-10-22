// The USGS stream gauge context layer: flow (00060) and stage (00065) as the newest reading
// each station has published. Measured 2026-10-20 against the USGS Water Data OGC API
// (api.waterdata.usgs.gov), the replacement for the legacy NWIS waterservices host, whose
// landing page says it is decommissioned on 2027-02-22. Fixtures are the live responses.
//
// What the tests pin: a reading carries its OWN time (one real station's "latest" is from
// 2009 and must say so); a no-data sentinel is dropped and counted, never drawn as a number;
// a box over the area cap is never requested; the card keeps the reading's time and the time
// it was fetched apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SERVICE, PARAMETER_CODES, MAX_BBOX_SQ_DEG, RECORD_BUDGET, bboxAreaSqDeg, boxStatus, latestUrl,
  namesUrl, readGauges, fetchGauges, cardLines, areaReport, gaugeLayer, gaugeReader,
  readerStrings, CONTEXT_ROW,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-stream-gauges.js';
import { SOURCES, cspDirectivesFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { LAYER_BY_ID } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`fixtures/${n}`, import.meta.url), 'utf8'));
const latest = fx('usgs-latest-continuous-2026-10-20.min.json');
const names = fx('usgs-monitoring-locations-2026-10-20.min.json');
const SMOKIES = { minLon: -83.6, minLat: 35.5, maxLon: -83.0, maxLat: 35.9 };
const FETCHED = Date.parse('2026-10-20T06:34:03Z');

test('the source row is an observation feed on the OGC API, keyless, CORS-open, in connect-src only', () => {
  const s = SOURCES.usgsWaterGauges;
  assert.ok(s, 'no usgsWaterGauges source');
  assert.equal(s.kind, 'observation-feed');
  assert.equal(s.origin, 'https://api.waterdata.usgs.gov');
  assert.equal(s.claim, 'observation');
  assert.equal(s.dateBasis, 'feature-field');
  assert.equal(s.measuredOn, '2026-10-20');
  assert.equal(s.cors, 'star');
  assert.equal(s.limits.requiresKey, false);
  assert.deepEqual(s.parameterCodes, ['00060', '00065']);
  assert.deepEqual(PARAMETER_CODES, ['00060', '00065']);
  assert.equal(s.limits.maxBboxSquareDegrees, 25);
  assert.equal(MAX_BBOX_SQ_DEG, 25);
  assert.equal(s.limits.recordBudgetPerExtent, RECORD_BUDGET);
  assert.match(s.coverageSemantics, /decommission/i, 'the row records why the legacy host was not used');
  const csp = cspDirectivesFor();
  assert.ok(csp['connect-src'].includes(s.origin));
  assert.ok(!csp['img-src'].includes(s.origin), 'JSON only; img-src is not widened');
  assert.equal(SERVICE, s.serviceUrl);
});

test('the layer row is a screen-only context surface, off by default', () => {
  const l = LAYER_BY_ID.streamGauges;
  assert.ok(l, 'no streamGauges layer');
  assert.equal(l, CONTEXT_ROW);
  assert.equal(l.group, 'context');
  assert.equal(l.sourceId, 'usgsWaterGauges');
  assert.equal(l.screenOnly, true);
  assert.equal(l.defaultOn, false);
  assert.equal(l.emptyMeans, 'ambiguous', 'no gauge in view is not a statement that the water is quiet');
});

test('area is degrees squared and a box over the cap is refused before any request', async () => {
  assert.ok(Math.abs(bboxAreaSqDeg(SMOKIES) - 0.24) < 1e-9);
  assert.equal(boxStatus(SMOKIES).ok, true);
  const wide = { minLon: -90, minLat: 30, maxLon: -80, maxLat: 40 };   // 100 square degrees
  assert.equal(boxStatus(wide).ok, false);
  assert.equal(boxStatus({ minLon: 0, minLat: 0, maxLon: 5, maxLat: 5 }).ok, true, '25 exactly is allowed');
  assert.equal(boxStatus({ minLon: 0, minLat: 0, maxLon: 5.01, maxLat: 5 }).ok, false);
  let calls = 0;
  const r = await fetchGauges(wide, { fetchImpl: async () => { calls += 1; throw new Error('must not be asked'); } });
  assert.equal(calls, 0);
  assert.equal(r.status, 'too-wide');
  assert.match(areaReport(r).text, /zoom in/i);
});

test('the requests carry the bbox, both parameter codes, the budget, and only the fields read', () => {
  const u = new URL(latestUrl(SMOKIES));
  assert.equal(u.origin + u.pathname, `${SERVICE}/collections/latest-continuous/items`);
  assert.equal(u.searchParams.get('bbox'), '-83.6,35.5,-83,35.9');
  assert.equal(u.searchParams.get('parameter_code'), '00060,00065');
  assert.equal(u.searchParams.get('limit'), String(RECORD_BUDGET));
  assert.equal(u.searchParams.get('f'), 'json');
  const n = new URL(namesUrl(['USGS-03460000', 'USGS-03460795']));
  assert.equal(n.searchParams.get('id'), 'USGS-03460000,USGS-03460795');
  assert.equal(n.pathname.endsWith('/collections/monitoring-locations/items'), true);
});

test('the live fixture reads into five stations, each reading with its own time and unit', () => {
  const g = readGauges(latest, names);
  assert.equal(g.sites.length, 5);
  assert.equal(g.dropped, 0);
  const cat = g.sites.find((s) => s.siteNo === '03460000');
  assert.equal(cat.name, 'CATALOOCHEE CREEK NEAR CATALOOCHEE, NC');
  assert.deepEqual([cat.lat, cat.lon].map((x) => Math.round(x * 1e4) / 1e4), [35.6672, -83.0728]);
  const flow = cat.readings.find((r) => r.code === '00060');
  assert.deepEqual([flow.value, flow.unit, flow.timeMs], [41.1, 'ft³/s', Date.parse('2026-10-20T05:30:00Z')]);
  assert.equal(flow.label, 'Streamflow');
  const stage = cat.readings.find((r) => r.code === '00065');
  assert.deepEqual([stage.value, stage.unit, stage.label], [2.2, 'ft', 'Gage height']);
  assert.equal(stage.approval, 'Provisional');
  // One station's newest flow reading was published in 2009: its own time must survive.
  const old = g.sites.find((s) => s.siteNo === '03469175').readings[0];
  assert.equal(old.timeMs, Date.parse('2009-10-01T04:45:00Z'));
  assert.equal(old.approval, 'Approved');
});

test('a missing name falls back to the station number, never to a blank', () => {
  const g = readGauges(latest, null);
  assert.equal(g.sites.length, 5);
  assert.ok(g.sites.every((s) => s.name === null));
  assert.match(cardLines(g.sites[0], FETCHED)[0], /USGS \d{8}/);
});

test('no-data sentinels, non-numbers and unlocated stations are dropped and counted, not drawn', () => {
  const f = (id, code, value, time = '2026-10-20T06:15:00+00:00', geometry = { type: 'Point', coordinates: [-83, 35.6] }) =>
    ({ type: 'Feature', geometry, properties: { monitoring_location_id: id, parameter_code: code, value, unit_of_measure: code === '00060' ? 'ft^3/s' : 'ft', time } });
  const body = { features: [
    f('USGS-1', '00060', '-999999'), f('USGS-2', '00060', 'Ice'), f('USGS-3', '00060', null),
    f('USGS-4', '00060', '12.5', 'not a time'), f('USGS-5', '00060', '9', undefined, null),
    f('USGS-6', '00065', '3.1'), f('USGS-6', '00060', '-999999.0'),
    f('USGS-7', '63160', '1359.88'),
  ] };
  const g = readGauges(body, null);
  assert.deepEqual(g.sites.map((s) => s.siteNo), ['6']);
  assert.deepEqual(g.sites[0].readings.map((r) => r.code), ['00065']);
  assert.equal(g.dropped, 6, 'seven candidate readings were bad; the unrequested 63160 is not a drop, it is ignored');
});

test('two readings for one station and parameter keep the newer', () => {
  const mk = (value, time) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [-83, 35.6] },
    properties: { monitoring_location_id: 'USGS-9', parameter_code: '00060', value, unit_of_measure: 'ft^3/s', time } });
  const g = readGauges({ features: [mk('1', '2026-10-20T01:00:00+00:00'), mk('2', '2026-10-20T03:00:00+00:00'), mk('3', '2026-10-20T02:00:00+00:00')] }, null);
  assert.equal(g.sites[0].readings.length, 1);
  assert.equal(g.sites[0].readings[0].value, 2);
});

test('the card gives value, unit, the reading time and the fetch time as separate lines', () => {
  const g = readGauges(latest, names);
  const lines = cardLines(g.sites.find((s) => s.siteNo === '03460000'), FETCHED);
  const text = lines.join('\n');
  assert.match(lines[0], /CATALOOCHEE CREEK NEAR CATALOOCHEE, NC/);
  assert.match(lines[0], /03460000/);
  assert.match(text, /Streamflow: 41\.1 ft³\/s/);
  assert.match(text, /Gage height: 2\.2 ft/);
  assert.match(text, /Reading time 2026-10-20 05:30 UTC/);
  assert.match(text, /Fetched 2026-10-20 06:34 UTC/);
  assert.match(text, /Provisional/);
  assert.ok(lines.some((l) => /Fetched/.test(l) && !/Reading time/.test(l)), 'fetch time is its own line');
  const old = cardLines(g.sites.find((s) => s.siteNo === '03469175'), FETCHED).join('\n');
  assert.match(old, /Reading time 2009-10-01 04:45 UTC/);
  assert.match(old, /years? before it was fetched/);
});

test('a failed request is a stated state, never a blank', async () => {
  const down = await fetchGauges(SMOKIES, { fetchImpl: async () => { throw new Error('offline'); }, nowMs: FETCHED });
  assert.equal(down.status, 'unavailable');
  assert.match(areaReport(down).text, /did not answer/);
  const bad = await fetchGauges(SMOKIES, { fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }), nowMs: FETCHED });
  assert.equal(bad.status, 'unavailable');
  const empty = await fetchGauges(SMOKIES, { fetchImpl: async () => ({ ok: true, json: async () => ({ features: [] }) }), nowMs: FETCHED });
  assert.equal(empty.status, 'empty');
  assert.match(areaReport(empty).text, /no active gauge/i);
  assert.match(areaReport(empty).text, /not .*(dry|quiet|safe)|rather than/i);
});

test('a good answer names the count, the dropped, the newest time and says capped when it is', async () => {
  const fetchImpl = async (url) => ({ ok: true, json: async () => (String(url).includes('monitoring-locations') ? names : latest) });
  const r = await fetchGauges(SMOKIES, { fetchImpl, nowMs: FETCHED });
  assert.equal(r.status, 'ready');
  assert.equal(r.fetchedMs, FETCHED);
  assert.equal(r.sites.length, 5);
  const t = areaReport(r).text;
  assert.match(t, /5 gauges/);
  assert.match(t, /Fetched 2026-10-20 06:34 UTC/);
  // A response at the budget may be a page of something longer.
  const full = { features: Array.from({ length: RECORD_BUDGET }, (_, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [-83, 35] },
    properties: { monitoring_location_id: `USGS-${i}`, parameter_code: '00060', value: '1', unit_of_measure: 'ft^3/s', time: '2026-10-20T06:15:00+00:00' } })) };
  const c = await fetchGauges(SMOKIES, { fetchImpl: async (u) => ({ ok: true, json: async () => (String(u).includes('monitoring-locations') ? { features: [] } : full) }), nowMs: FETCHED });
  assert.equal(c.capped, true);
  assert.match(areaReport(c).text, /more gauges than this view can show/i);
});

test('the layer draws one marker per station, with a keyboard-reachable card', () => {
  const made = [];
  const L = { layerGroup: () => { const g = { items: [], clearLayers() { this.items = []; }, addLayer(x) { this.items.push(x); return this; } }; return g; },
    circleMarker: (ll, o) => { const m = { ll, o, popup: null, bindPopup(c) { this.popup = c; return this; }, addTo(g) { g.items.push(this); made.push(this); return this; } }; return m; } };
  const group = gaugeLayer(L);
  group.draw(readGauges(latest, names).sites, FETCHED);
  assert.equal(group.items.length, 5);
  assert.ok(group.items.every((m) => m.popup && m.o.keyboard !== false));
  group.draw([], FETCHED);
  assert.equal(group.items.length, 0);
});

test('the reader waits out a drag, and an answer for a view the reader left is dropped', async () => {
  const timers = [];
  const reader = gaugeReader({ fetchFn: async () => ({ status: 'ready', sites: [] }), waitMs: 5,
    setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
  const got = [];
  const first = reader.ask(SMOKIES, (r) => got.push(['a', r.status]));
  const second = reader.ask(SMOKIES, (r) => got.push(['b', r.status]));
  assert.equal(await first, false);
  await timers[1]();
  assert.equal(await second, true);
  assert.deepEqual(got, [['b', 'ready']]);
});

test('every reader-facing string avoids a safety or flood claim', () => {
  for (const s of readerStrings()) {
    assert.doesNotMatch(s, /\b(safe to (cross|wade|paddle)|flood(ing)? (is|will)|will rise|is flooding|expected to)\b/i, s);
  }
  assert.match(SOURCES.usgsWaterGauges.coverageSemantics, /not .*safe/i);
});
