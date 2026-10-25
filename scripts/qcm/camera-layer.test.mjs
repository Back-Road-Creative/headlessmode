// Pure module: no DOM, no Leaflet, no globals except fetchCaltransCctv's injected fetchImpl.
// Run: node --test scripts/qcm/camera-layer.test.mjs
//
// The D07 fixture has NO inService:"false" record -- all three kept D07 rows (1130, 1138, 67)
// report inService:"true" (the C15 "dead feed but claims active" placeholder-image case; see
// source-camera.test.mjs's own header comment and its OUT_OF_SERVICE = cctv(D05, '37')). The
// real out-of-service record is in D05 at index 37 (US-101 : Cabrillo Blvd), so the stillPlan
// inactive-record case below reads from D05, not D07 (QUX-08D.md:205 names D07; that line is
// wrong -- source-camera.js's own header comment and source-camera.test.mjs's own fixture
// naming confirm D05:37 is the real inactive record).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  fetchCaltransCctv, camerasInView, unlocated, layerReport, cardLines, ageText, stillPlan,
  cameraRef, findCamera, viewTouchesCoverage, cameraStatus, MIN_PIN_ZOOM, padView, filesInView,
  MAX_PINS, pinsToDraw, failureProvider, unloadedFilesNear, viewTouchesLayer, providerRow,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/camera-layer.js';
import * as cameraLayer from '../../themes/headlessmode/static/js/quiet-corners-maps/camera-layer.js';
import { expandSnapshot } from '../../themes/headlessmode/static/js/quiet-corners-maps/camera-snapshot.js';
import { LAYER_BY_ID } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';
import { STATE_BBOX, STATE_BBOX_PAD } from './build-camera-snapshot.mjs';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { normalizeCaltransCctv, normalizeNpsWebcams } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-camera.js';

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const D05 = read('fixtures/caltrans-cctv-d05-2026-09-27.min.json');
const FETCHED_AT = '2026-09-27T19:50:00Z';

const NORMALIZED = normalizeCaltransCctv(D05, { fetchedAt: FETCHED_AT });
const PILOT = NORMALIZED.find((c) => c.providerId === '1');           // active, has a still
const OUT_OF_SERVICE = NORMALIZED.find((c) => c.providerId === '37'); // inactive, US-101 Cabrillo Blvd

// NPS half (08D-ii): the same real GRSM capture source-camera.test.mjs uses.
const GRSM = read('fixtures/nps-webcams-grsm-2026-09-27.min.json');
const FETCHED_AT_NPS = '2026-09-27T20:30:00Z';
const NPS_NORMALIZED = normalizeNpsWebcams(GRSM, { fetchedAt: FETCHED_AT_NPS });
const PURCHASE_KNOB_NPS = NPS_NORMALIZED.find((c) => c.providerId === '52E38701-AF1C-D2FC-3F23861BB6E221BB'); // active, has a still
const TWIN_CREEK_NPS = NPS_NORMALIZED.find((c) => c.providerId === '29A53AEC-1DD8-B71B-0BC49F5DA731C317');    // inactive, no still, null lat/lon
const KUWOHI_NPS = NPS_NORMALIZED.find((c) => c.providerId === 'BDFD47F3-1DD8-B71B-0B81AFE928DDCBCF');        // inactive, has a curated still, null lat/lon

test('fetchCaltransCctv: a fetchImpl returning the D05 fixture normalizes to ok:true, cameras', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => D05 };
  };
  const result = await fetchCaltransCctv({ fetchImpl, fetchedAt: FETCHED_AT });
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.cameras));
  assert.ok(result.cameras.length > 0);
  assert.ok(result.cameras.some((c) => c.providerId === '1'));
  // asks exactly the registry serviceUrl -- no other endpoint, no query string appended.
  assert.deepEqual(calls, [SOURCES.caltransCctv.serviceUrl]);
});

test('fetchCaltransCctv: a rejecting fetch returns ok:false and never throws', async () => {
  const fetchImpl = async () => { throw new Error('network down'); };
  await assert.doesNotReject(async () => {
    const result = await fetchCaltransCctv({ fetchImpl });
    assert.equal(result.ok, false);
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
  });
});

test('fetchCaltransCctv: a 500 response returns ok:false and never throws', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => { throw new Error('should not be read'); } });
  const result = await fetchCaltransCctv({ fetchImpl });
  assert.equal(result.ok, false);
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
});

test('camerasInView keeps only located cameras inside the bounds', () => {
  const bounds = { minLon: -121.7, minLat: 36.6, maxLon: -121.6, maxLat: 36.7 };
  const inView = camerasInView(NORMALIZED, bounds);
  assert.ok(inView.every((c) => c.lat !== null && c.lon !== null));
  assert.ok(inView.some((c) => c.providerId === '1'), 'the pilot camera (36.687188,-121.653231) is inside these bounds');
  assert.ok(!inView.some((c) => c.providerId === '37'), 'Cabrillo Blvd (Santa Barbara) is well outside these Salinas-area bounds');
});

test('unlocated returns cameras with a null lat or lon', () => {
  const withGap = [...NORMALIZED, { ...PILOT, providerId: 'no-lat', lat: null }];
  const missing = unlocated(withGap);
  assert.ok(missing.every((c) => c.lat === null || c.lon === null));
  assert.ok(missing.some((c) => c.providerId === 'no-lat'));
});

test('layerReport: count text', () => {
  // The trimmed D05 fixture carries only 2 rows -- synthesize a 12-camera view instead of
  // asking the fixture for a count it was never meant to provide (D8: "the D05 count is
  // unmeasured; the fixtures are trimmed").
  const inView = Array.from({ length: 12 }, (_, i) => ({ ...PILOT, providerId: String(i) }));
  const text = layerReport({ provider: 'caltrans-cwwp2', cameras: NORMALIZED, inView, error: null });
  assert.equal(text, '12 road cameras in this view.');
});

test('layerReport: a single camera in view is not pluralized wrong', () => {
  const text = layerReport({ provider: 'caltrans-cwwp2', cameras: NORMALIZED, inView: [PILOT], error: null });
  assert.equal(text, '1 road camera in this view.');
});

test('layerReport: empty text is distinct from the error text', () => {
  const emptyText = layerReport({ provider: 'caltrans-cwwp2', cameras: NORMALIZED, inView: [], error: null });
  const errorText = layerReport({ provider: 'caltrans-cwwp2', cameras: NORMALIZED, inView: [], error: 'http 500' });
  assert.equal(emptyText, 'No road cameras in this view.');
  assert.equal(errorText, "Caltrans's camera list did not load, so no cameras are shown. Turn the layer off and on to try again.");
  assert.notEqual(emptyText, errorText);
});

test('ageText: fresh (3 min) names the age and what it does not mean', () => {
  const now = new Date('2026-09-27T20:00:00Z');
  const lastModified = new Date(now.getTime() - 3 * 60 * 1000).toUTCString();
  assert.equal(ageText(lastModified, now),
    "Picture file changed 3 min ago, per Caltrans's server. That is when the file changed, not a guaranteed capture time.");
});

test('ageText: 29 minutes is still fresh, 31 minutes is stale', () => {
  const now = new Date('2026-09-27T20:00:00Z');
  const fresh = new Date(now.getTime() - 29 * 60 * 1000).toUTCString();
  const stale = new Date(now.getTime() - 31 * 60 * 1000).toUTCString();
  assert.equal(ageText(fresh, now),
    "Picture file changed 29 min ago, per Caltrans's server. That is when the file changed, not a guaranteed capture time.");
  assert.equal(ageText(stale, now), 'Picture file last changed 31 min ago. The camera may be stuck.');
});

test('ageText: an hours-scale staleness is reported in hours', () => {
  const now = new Date('2026-09-27T20:00:00Z');
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toUTCString();
  assert.equal(ageText(twoHoursAgo, now), 'Picture file last changed 2 h ago. The camera may be stuck.');
});

test('ageText: null or unparseable never fabricates an age, and no output matches "live"', () => {
  const now = new Date('2026-09-27T20:00:00Z');
  const nullText = ageText(null, now);
  const garbageText = ageText('not a date', now);
  assert.equal(nullText, "Caltrans's server did not say when this picture changed.");
  assert.equal(garbageText, "Caltrans's server did not say when this picture changed.");
  for (const text of [
    nullText, garbageText,
    ageText(new Date(now.getTime() - 3 * 60 * 1000).toUTCString(), now),
    ageText(new Date(now.getTime() - 2 * 60 * 60 * 1000).toUTCString(), now),
  ]) {
    assert.doesNotMatch(text, /\blive\b/i, text);
  }
});

test('stillPlan: an inactive record returns link, using D05:37, the real inService:"false" record', () => {
  assert.equal(OUT_OF_SERVICE.health, 'inactive');
  assert.equal(stillPlan(OUT_OF_SERVICE), 'link');
});

test('stillPlan: an active Caltrans record with a still fetches', () => {
  assert.equal(PILOT.health, 'active');
  assert.ok(PILOT.media.still);
  assert.equal(stillPlan(PILOT), 'fetch');
});

test('stillPlan: an active record with no still is link-only, never fetch', () => {
  const noStill = { ...PILOT, media: { ...PILOT.media, still: null } };
  assert.equal(stillPlan(noStill), 'link');
});

test('cardLines: never contains the word "live"', () => {
  for (const c of [PILOT, OUT_OF_SERVICE]) {
    const lines = cardLines(c, { generatedAt: FETCHED_AT });
    assert.ok(Array.isArray(lines) && lines.length > 0);
    for (const line of lines) assert.doesNotMatch(line, /\blive\b/i, line);
  }
});

test('cardLines: an inactive camera names Caltrans and out-of-service', () => {
  const lines = cardLines(OUT_OF_SERVICE, { generatedAt: FETCHED_AT });
  assert.ok(lines.includes('Caltrans lists this camera as out of service.'), lines.join(' | '));
  assert.ok(lines.includes(OUT_OF_SERVICE.name));
});

test('cameraRef and findCamera round-trip', () => {
  const ref = cameraRef(PILOT);
  assert.equal(ref, 'camera:caltrans-cwwp2:1');
  assert.equal(findCamera(NORMALIZED, ref), PILOT);
  assert.equal(findCamera(NORMALIZED, 'camera:caltrans-cwwp2:not-a-real-id'), null);
});

// --- NPS (08D-ii): test 8, camera-layer.js extended for a second provider ---

test('layerReport: NPS count text uses "park camera", not "road camera"', () => {
  // cameras here is deliberately inView itself (all located), isolating the count text from the
  // unlocated sentence, which is covered separately below with the real NPS_NORMALIZED list.
  const inView = Array.from({ length: 3 }, (_, i) => ({ ...PURCHASE_KNOB_NPS, providerId: String(i) }));
  const text = layerReport({ provider: 'nps-grsm', cameras: inView, inView, error: null });
  assert.equal(text, '3 park cameras in this view.');
});

test('layerReport: NPS empty and error text are distinct, and name the park, not Caltrans', () => {
  const emptyText = layerReport({ provider: 'nps-grsm', cameras: [], inView: [], error: null });
  const errorText = layerReport({ provider: 'nps-grsm', cameras: [], inView: [], error: 'http 500' });
  assert.equal(emptyText, 'No park cameras in this view. Park cameras are listed only for parks with a located NPS webcam.');
  assert.equal(errorText, "The park's camera list did not load, so no cameras are shown. Turn the layer off and on to try again.");
  assert.notEqual(emptyText, errorText);
});

test('layerReport: the report names Kuwohi and Twin Creek as unlocated, each with its own reason', () => {
  const text = layerReport({ provider: 'nps-grsm', cameras: NPS_NORMALIZED, inView: [], error: null });
  // Kuwohi is inactive but keeps its curated still (mapped in LIVE_STILL_BY_ID) -- "out of
  // service", not "no picture". Twin Creek is inactive with no still at all -- "no picture".
  assert.match(text, /2 more have no map position:/);
  assert.match(text, /Kuwohi \(out of service\)/);
  assert.match(text, /Twin Creek \(no picture\)/);
  assert.doesNotMatch(text, /\blive\b/i, text);
});

test('stillPlan: an active NPS record with a curated still is "img", never "fetch" (no ACAO to read)', () => {
  assert.equal(PURCHASE_KNOB_NPS.health, 'active');
  assert.ok(PURCHASE_KNOB_NPS.media.still);
  assert.equal(stillPlan(PURCHASE_KNOB_NPS), 'img');
});

test('stillPlan: Twin Creek (inactive, no still) is "link"', () => {
  assert.equal(TWIN_CREEK_NPS.health, 'inactive');
  assert.equal(stillPlan(TWIN_CREEK_NPS), 'link');
});

test('cardLines: NPS adds the no-capture-time line naming the checked date, and still never says "live"', () => {
  const lines = cardLines(PURCHASE_KNOB_NPS, { generatedAt: FETCHED_AT_NPS });
  assert.ok(lines.includes('The park does not publish when this picture was taken. Camera list checked 27 Sep 2026.'),
    lines.join(' | '));
  for (const line of lines) assert.doesNotMatch(line, /\blive\b/i, line);
});

test('cardLines: an inactive NPS camera (Kuwohi) still gets the out-of-service line, same vocabulary as Caltrans', () => {
  const lines = cardLines(KUWOHI_NPS, { generatedAt: FETCHED_AT_NPS });
  assert.ok(lines.includes('NPS Air Quality Network lists this camera as out of service.'), lines.join(' | '));
});

test('cameraRef and findCamera round-trip for an NPS camera too, same helper, no provider branch', () => {
  const ref = cameraRef(PURCHASE_KNOB_NPS);
  assert.equal(ref, 'camera:nps-grsm:52E38701-AF1C-D2FC-3F23861BB6E221BB');
  assert.equal(findCamera(NPS_NORMALIZED, ref), PURCHASE_KNOB_NPS);
});

// UX-03b (audit A05/A07): the two supported regions are named and bounded, and "outside
// coverage" reads apart from "none in this view", "loading", "unavailable" and "layer off".
const GRSM_CAMS = normalizeNpsWebcams(GRSM, { fetchedAt: FETCHED_AT });
const inside = (box, c) => c.lat >= box.minLat && c.lat <= box.maxLat && c.lon >= box.minLon && c.lon <= box.maxLon;

// The Caltrans box is county-based (District 5), not derived from data: the repo's capture holds
// only two located rows, so this checks those and nothing more. The GRSM box is checked against the
// park snapshot's own cameras.
test('coverage: every located Caltrans D05 camera sits inside roadCameras.coverage', () => {
  const box = LAYER_BY_ID.roadCameras.coverage;
  assert.ok(box, 'roadCameras carries its coverage box');
  const located = NORMALIZED.filter((c) => c.lat !== null && c.lon !== null);
  assert.ok(located.length > 0);
  const outside = located.filter((c) => !inside(box, c)).map((c) => c.providerId);
  assert.deepEqual(outside, [], 'the box must hold the whole captured catalogue');
});

test('coverage: every located GRSM webcam sits inside parkCameras.coverage', () => {
  const box = LAYER_BY_ID.parkCameras.coverage;
  assert.ok(box, 'parkCameras carries its coverage box');
  const located = GRSM_CAMS.filter((c) => c.lat !== null && c.lon !== null);
  assert.ok(located.length >= 3);
  assert.deepEqual(located.filter((c) => !inside(box, c)).map((c) => c.providerId), []);
});

test('coverage: parkCameras is nationwide, so a view outside the Smokies that holds park cameras is not "outside coverage"', () => {
  const park = LAYER_BY_ID.parkCameras, road = LAYER_BY_ID.roadCameras.coverage;
  const yellowstone = { minLon: -111.2, minLat: 44.1, maxLon: -109.9, maxLat: 45.1 };
  assert.equal(viewTouchesCoverage(yellowstone, park.coverage), true);
  assert.equal(viewTouchesCoverage(road, park.coverage), true, 'California is covered (park cameras may exist there)');
  assert.equal(viewTouchesCoverage({ minLon: 2, minLat: 48, maxLon: 3, maxLat: 49 }, park.coverage), false);
  const cam = { id: 'nps-webcams:yell', provider: 'nps-webcams', providerId: 'yell', name: 'Old Faithful', lat: 44.46, lon: -110.83, active: true };
  const text = layerReport({ provider: 'nps-webcams', cameras: [cam], inView: [cam], error: null,
    outsideCoverage: !viewTouchesCoverage(yellowstone, park.coverage) });
  assert.doesNotMatch(text, /Outside coverage/i);
  assert.match(text, /^1 park camera in this view\./);
  assert.ok(park.goTo && viewTouchesCoverage(park.goTo, park.coverage), 'Go to opens inside the coverage');
});

test('viewTouchesCoverage: overlap, containment, and clear misses', () => {
  const box = { minLon: -122, minLat: 34, maxLon: -119, maxLat: 37 };
  assert.equal(viewTouchesCoverage({ minLon: -121, minLat: 35, maxLon: -120, maxLat: 36 }, box), true, 'view inside');
  assert.equal(viewTouchesCoverage({ minLon: -130, minLat: 20, maxLon: -70, maxLat: 50 }, box), true, 'view swallows the region');
  assert.equal(viewTouchesCoverage({ minLon: -119.5, minLat: 36.5, maxLon: -110, maxLat: 40 }, box), true, 'corner overlap');
  assert.equal(viewTouchesCoverage({ minLon: -90, minLat: 35, maxLon: -80, maxLat: 36 }, box), false, 'east of it');
  assert.equal(viewTouchesCoverage({ minLon: -121, minLat: 40, maxLon: -120, maxLat: 41 }, box), false, 'north of it');
});

test('cameraStatus: layer off, loading, unavailable, outside coverage, none in view and N in view read apart', () => {
  const base = { on: true, loading: false, error: false, touches: true, inView: 0 };
  const states = {
    off: cameraStatus({ ...base, on: false }),
    loading: cameraStatus({ ...base, loading: true }),
    unavailable: cameraStatus({ ...base, error: true }),
    outside: cameraStatus({ ...base, touches: false }),
    none: cameraStatus({ ...base }),
    some: cameraStatus({ ...base, inView: 3 }),
    zoomIn: cameraStatus({ ...base, belowZoom: true }),
  };
  assert.deepEqual(Object.fromEntries(Object.entries(states).map(([k, v]) => [k, v.key])), {
    off: 'layer-off', loading: 'loading', unavailable: 'unavailable', outside: 'outside-coverage', none: 'none-in-view', some: 'in-view', zoomIn: 'zoom-in',
  });
  assert.equal(new Set(Object.values(states).map((v) => v.text)).size, 7, 'seven states, seven different sentences');
  assert.match(states.zoomIn.text, /zoom in/i);
  assert.match(states.outside.text, /outside coverage/i);
  assert.match(states.none.text, /none in this view/i);
  assert.match(states.some.text, /^3 cameras in this view/);
  assert.match(cameraStatus({ ...base, inView: 1 }).text, /^1 camera in this view/);
});

test('cameraStatus: off wins over everything, loading and unavailable win over the view', () => {
  const x = { on: false, loading: true, error: true, touches: false, inView: 0 };
  assert.equal(cameraStatus(x).key, 'layer-off');
  assert.equal(cameraStatus({ ...x, on: true }).key, 'loading');
  assert.equal(cameraStatus({ ...x, on: true, loading: false }).key, 'unavailable');
});

test('layerReport: an outside-coverage view says so and is not the "none in this view" sentence', () => {
  for (const provider of ['caltrans-cwwp2', 'nps-grsm']) {
    const outside = layerReport({ provider, cameras: [], inView: [], outsideCoverage: true });
    const none = layerReport({ provider, cameras: [], inView: [] });
    assert.match(outside, /^Outside coverage/);
    assert.notEqual(outside, none);
  }
  assert.equal(layerReport({ provider: 'caltrans-cwwp2', cameras: [], inView: [], error: 'x', outsideCoverage: true }),
    layerReport({ provider: 'caltrans-cwwp2', error: 'x' }), 'a failed load still reads as a failed load');
});

// --- camera U1: one provider table, neutral fallback, legacy ref aliases, nearestCoverage ---

// Characterization: the exact text the two shipped provider ids read today. The provider table
// must reproduce it byte for byte (behaviour-preserving refactor).
test('provider table keeps the exact outside-coverage text for both shipped providers', () => {
  assert.equal(layerReport({ provider: 'caltrans-cwwp2', outsideCoverage: true }),
    'Outside coverage: this view is not in a US state, the only areas with road cameras here. Use Go to under Cameras.');
  assert.equal(layerReport({ provider: 'nps-grsm', outsideCoverage: true }),
    'Outside coverage: this view is not in a US state or territory, the only areas with park cameras here. Use Go to under Cameras.');
});

test('layerReport: an absent provider still reads as the original Caltrans text (08D-i callers pass none)', () => {
  assert.equal(layerReport({ inView: [], cameras: [] }),
    'No road cameras in this view.');
  assert.equal(layerReport({ error: 'x' }),
    "Caltrans's camera list did not load, so no cameras are shown. Turn the layer off and on to try again.");
});

test('layerReport: an unknown provider reads neutral, never Caltrans or District 5 or Smoky text', () => {
  const unknown = 'wsdot-arcgis';
  const texts = [
    layerReport({ provider: unknown, cameras: [], inView: [] }),
    layerReport({ provider: unknown, cameras: [], inView: [], error: 'http 500' }),
    layerReport({ provider: unknown, cameras: [], inView: [], outsideCoverage: true }),
    layerReport({ provider: unknown, cameras: [PILOT], inView: [PILOT] }),
  ];
  for (const text of texts) {
    assert.doesNotMatch(text, /caltrans|district 5|central coast|smoky|park|road/i, text);
  }
  assert.equal(texts[3], '1 camera in this view.');
  assert.equal(new Set(texts.slice(0, 3)).size, 3, 'empty, error and outside still read apart');
  assert.match(texts[2], /^Outside coverage/);
});

test('stillPlan: an unknown provider is link even with an active record and a still', () => {
  const stranger = { ...PILOT, provider: 'wsdot-arcgis' };
  assert.equal(PILOT.health, 'active');
  assert.ok(stranger.media.still);
  assert.equal(stillPlan(stranger), 'link');
  assert.equal(stillPlan({ ...PILOT, provider: undefined }), 'link');
});

test('PROVIDERS table: holds the two shipped ids, and stillPlan reads its plan from it', () => {
  const { PROVIDERS } = cameraLayer;
  assert.ok(PROVIDERS, 'camera-layer exports the PROVIDERS table');
  assert.equal(PROVIDERS['caltrans-cwwp2'].plan, 'fetch');
  assert.equal(PROVIDERS['nps-webcams'].plan, 'img', 'the nationwide NPS provider the snapshot index names has its own row');
  assert.equal(PROVIDERS['nps-webcams'], PROVIDERS['nps-grsm'], 'the legacy id reads the same row');
  assert.equal(PROVIDERS['nps-grsm'].plan, 'img');
  assert.equal(PROVIDERS['caltrans-cwwp2'].noun, 'road camera');
  assert.equal(PROVIDERS['nps-grsm'].noun, 'park camera');
  assert.equal(PROVIDERS['nps-grsm'].listChecked, true);
  assert.equal(PROVIDERS['caltrans-cwwp2'].listChecked, true);
  assert.equal(PROVIDERS['nps-grsm'].ageSource, 'none');
  assert.equal(PROVIDERS['caltrans-cwwp2'].ageSource, 'last-modified');
  for (const [id, row] of Object.entries(PROVIDERS)) {
    assert.ok(['fetch', 'img', 'link'].includes(row.plan), id);
    for (const key of ['noun', 'operator', 'linkText', 'altCredit', 'ageSource', 'emptyText', 'errorText', 'outsideText']) {
      assert.equal(typeof row[key], 'string', `${id}.${key}`);
    }
    assert.equal(typeof row.listChecked, 'boolean', id);
    // a table row is the only place a plan lives: stillPlan must follow it.
    assert.equal(stillPlan({ ...PILOT, provider: id }), row.plan, id);
  }
});

test('cardLines: the list-checked line follows the table, so an unknown provider never gets the NPS line', () => {
  const stranger = { ...PILOT, provider: 'wsdot-arcgis', operator: 'WSDOT' };
  const lines = cardLines(stranger, { generatedAt: FETCHED_AT });
  for (const line of lines) assert.doesNotMatch(line, /park does not publish|Camera list checked/, line);
  assert.ok(cardLines(PURCHASE_KNOB_NPS, { generatedAt: FETCHED_AT_NPS }).some((l) => /Camera list checked 27 Sep 2026\./.test(l)));
});

test('LEGACY_REF_ALIASES: a bare Caltrans ref resolves to District 5, an nps-grsm ref to nps-webcams', () => {
  const { findCamera: find, LEGACY_REF_ALIASES } = cameraLayer;
  assert.ok(Array.isArray(LEGACY_REF_ALIASES) && LEGACY_REF_ALIASES.length >= 2, 'the alias table is exported');
  const d05One = { ...PILOT, providerId: 'd05:1' };
  const d04One = { ...PILOT, providerId: 'd04:1' };
  const webcam = { ...PURCHASE_KNOB_NPS, provider: 'nps-webcams' };
  const catalog = [d04One, d05One, webcam];
  assert.equal(find(catalog, 'camera:caltrans-cwwp2:1'), d05One, 'bare index -> d05');
  assert.equal(find(catalog, 'camera:caltrans-cwwp2:d04:1'), d04One, 'an already-prefixed ref is not re-aliased');
  assert.equal(find(catalog, 'camera:nps-grsm:52E38701-AF1C-D2FC-3F23861BB6E221BB'), webcam, 'same UUID under nps-webcams');
  assert.equal(find(catalog, 'camera:caltrans-cwwp2:nope'), null);
  assert.equal(find(catalog, 'camera:nps-grsm:nope'), null);
});

test('findCamera: an exact match wins before any alias, so today\'s records keep resolving', () => {
  assert.equal(findCamera(NORMALIZED, 'camera:caltrans-cwwp2:1'), PILOT);
  assert.equal(findCamera(NPS_NORMALIZED, 'camera:nps-grsm:52E38701-AF1C-D2FC-3F23861BB6E221BB'), PURCHASE_KNOB_NPS);
});

const AREAS = [
  { id: 'a-west', name: 'West', bbox: { minLon: -123, minLat: 36, maxLon: -121, maxLat: 38 } },
  { id: 'a-east', name: 'East', bbox: { minLon: -84, minLat: 35, maxLon: -83, maxLat: 36 } },
];

test('nearestCoverage: areas the view touches come back as inView, in input order', () => {
  const view = { minLon: -122.5, minLat: 36.5, maxLon: -121.5, maxLat: 37.5 };
  const r = cameraLayer.nearestCoverage(view, AREAS);
  assert.deepEqual(r.inView.map((a) => a.id), ['a-west']);
  assert.equal(r.nearest.area.id, 'a-west');
  assert.equal(r.nearest.km, 0);
  const swallow = cameraLayer.nearestCoverage({ minLon: -130, minLat: 20, maxLon: -70, maxLat: 50 }, AREAS);
  assert.deepEqual(swallow.inView.map((a) => a.id), ['a-west', 'a-east']);
});

test('nearestCoverage: a view touching nothing names the closest area and a plausible distance in km', () => {
  // Centred on (-110, 36.5): West's edge at -121 is 11 degrees of longitude away, East's at -84 is 26.
  const view = { minLon: -111, minLat: 36, maxLon: -109, maxLat: 37 };
  const r = cameraLayer.nearestCoverage(view, AREAS);
  assert.deepEqual(r.inView, []);
  assert.equal(r.nearest.area.id, 'a-west');
  // 11 deg of longitude at ~36.5N is about 980 km.
  assert.ok(r.nearest.km > 900 && r.nearest.km < 1060, `km ${r.nearest.km}`);
  assert.equal(Number.isInteger(r.nearest.km), true, 'whole kilometres');
});

test('nearestCoverage: no areas means nothing in view and no nearest, never a throw', () => {
  const view = { minLon: -111, minLat: 36, maxLon: -109, maxLat: 37 };
  assert.deepEqual(cameraLayer.nearestCoverage(view, []), { inView: [], nearest: null });
  assert.deepEqual(cameraLayer.nearestCoverage(view), { inView: [], nearest: null });
});

// --- camera U4a: the browser reads snapshots by map area ---

test('MIN_PIN_ZOOM is 7: below it no camera file is read', () => {
  assert.equal(MIN_PIN_ZOOM, 7);
});

test('cameraStatus: zoom-in reads apart from none-in-view, and outside coverage still wins over it', () => {
  const base = { on: true, loading: false, error: false, touches: true, inView: 0 };
  assert.equal(cameraStatus({ ...base, belowZoom: true }).key, 'zoom-in');
  assert.equal(cameraStatus({ ...base, belowZoom: true, touches: false }).key, 'outside-coverage');
  assert.equal(cameraStatus({ ...base, belowZoom: true, loading: true }).key, 'loading');
  assert.equal(cameraStatus({ ...base, belowZoom: false }).key, 'none-in-view');
});

test('padView grows a view by a fraction of its own size on every side', () => {
  const v = { minLon: -122, minLat: 36, maxLon: -120, maxLat: 38 };
  assert.deepEqual(padView(v, 0.5), { minLon: -123, minLat: 35, maxLon: -119, maxLat: 39 });
  assert.deepEqual(padView(v, 0), v);
});

test('filesInView: only the index files whose bbox meets the view', () => {
  const files = [
    { file: 'a.json', layer: 'roadCameras', bbox: { minLon: -123, minLat: 36, maxLon: -121, maxLat: 38 } },
    { file: 'b.json', layer: 'roadCameras', bbox: { minLon: -119, minLat: 33, maxLon: -117, maxLat: 35 } },
    { file: 'c.json', layer: 'parkCameras', bbox: { minLon: -122.5, minLat: 36.5, maxLon: -122, maxLat: 37 } },
  ];
  const view = { minLon: -122.4, minLat: 36.4, maxLon: -121.6, maxLat: 37.2 };
  assert.deepEqual(filesInView(files, view, 'roadCameras').map((f) => f.file), ['a.json']);
  assert.deepEqual(filesInView(files, view, 'parkCameras').map((f) => f.file), ['c.json']);
  assert.deepEqual(filesInView(files, { minLon: -90, minLat: 30, maxLon: -89, maxLat: 31 }, 'roadCameras'), []);
  assert.deepEqual(filesInView(undefined, view, 'roadCameras'), []);
});

test('layerReport: below the zoom floor it says zoom in, and names the nearest area only when asked', () => {
  const plain = layerReport({ provider: 'caltrans-cwwp2', belowZoom: true });
  assert.match(plain, /^Zoom in to see cameras/);
  assert.match(plain, /zoom 7/);
  const near = layerReport({ provider: 'caltrans-cwwp2', inView: [], nearest: { area: { name: 'District 4 (San Francisco Bay Area)' }, km: 140 } });
  assert.match(near, /^No road cameras in this view\./);
  assert.match(near, /Nearest cameras are 140 km away \(District 4 \(San Francisco Bay Area\)\)\./);
  assert.doesNotMatch(layerReport({ provider: 'caltrans-cwwp2', inView: [] }), /Nearest/);
  assert.equal(layerReport({ provider: 'caltrans-cwwp2', error: 'x', belowZoom: true }), layerReport({ provider: 'caltrans-cwwp2', error: 'x' }));
});

test('ageText names the provider operator, never a hardcoded Caltrans', () => {
  const now = new Date('2026-10-04T12:00:00Z');
  const fresh = new Date(now.getTime() - 3 * 60 * 1000).toUTCString();
  assert.equal(ageText(fresh, now, 'caltrans-cwwp2'), ageText(fresh, now));
  assert.match(ageText(fresh, now, 'wsdot-arcgis'), /per the operator's server/);
  assert.doesNotMatch(ageText(fresh, now, 'wsdot-arcgis'), /Caltrans/);
  assert.equal(ageText(null, now, 'wsdot-arcgis'), "The operator's server did not say when this picture changed.");
});

test('cardLines: a Caltrans card says its health is as of the last list check; picture age stays out of it', () => {
  const lines = cardLines(OUT_OF_SERVICE, { generatedAt: '2026-10-04T16:00:00.000Z' });
  assert.ok(lines.some((l) => /health is as of the last list check/i.test(l) && /Camera list checked 4 Oct 2026\./.test(l)), lines.join(' | '));
  assert.ok(lines.every((l) => !/\blive\b/i.test(l)));
  const noDate = cardLines(PILOT, {});
  assert.ok(noDate.some((l) => /Camera list checked 27 Sep 2026\./.test(l)), 'falls back to the record\'s own fetchedAt');
});

test('provider table: every row carries the operator name ageText and the card links read from', () => {
  for (const [id, row] of Object.entries(cameraLayer.PROVIDERS)) {
    assert.equal(typeof row.operator, 'string', id);
  }
  assert.equal(cameraLayer.providerRow('caltrans-cwwp2').linkText, 'About Caltrans cameras');
  assert.equal(cameraLayer.providerRow('nope').stillLinkText, '');
});

// --- camera U4a review fixes ---

// D8 revisit trigger: about 300 DOM markers. Measured from the committed seeds (3,591 located Caltrans
// cameras): with every touching file drawn whole, a zoom-7 view over LA or Fresno drew 3,500+ markers
// and no zoom up to 9 got under 300, so the draw is capped instead of the zoom raised.
const SEED_DIR = new URL('../../static/data/quiet-corners-maps/cameras/', import.meta.url);
const seedRoad = () => {
  const idx = JSON.parse(readFileSync(new URL('index.json', SEED_DIR), 'utf8'));
  return idx.files.filter((f) => f.layer === 'roadCameras')
    .flatMap((f) => expandSnapshot(JSON.parse(readFileSync(new URL(f.file, SEED_DIR), 'utf8'))));
};

test('MAX_PINS is the D8 trigger of 300', () => { assert.equal(MAX_PINS, 300); });

test('pinsToDraw: a zoom-7 view over LA holds thousands of seed cameras but draws at most MAX_PINS, nearest the centre', () => {
  const cams = seedRoad();
  const view = { minLon: -121.5, minLat: 32.5, maxLon: -114.5, maxLat: 37.5 };
  const { pins, total } = pinsToDraw(cams, view);
  assert.ok(total > 1000, `the seeds put ${total} cameras in this view`);
  assert.equal(pins.length, MAX_PINS);
  const cLat = (view.minLat + view.maxLat) / 2, cLon = (view.minLon + view.maxLon) / 2;
  const d = (c) => (c.lat - cLat) ** 2 + (c.lon - cLon) ** 2;
  const worstKept = Math.max(...pins.map(d));
  const kept = new Set(pins);
  for (const c of camerasInView(cams, view)) if (!kept.has(c)) assert.ok(d(c) >= worstKept, 'a dropped camera is never nearer the centre than a kept one');
});

test('pinsToDraw: under the cap every located camera in view is drawn; unlocated and off-view ones never', () => {
  const view = { minLon: 0, minLat: 0, maxLon: 10, maxLat: 10 };
  const cams = [{ lat: 1, lon: 1 }, { lat: null, lon: null }, { lat: 50, lon: 50 }, { lat: 9, lon: 9 }];
  const { pins, total } = pinsToDraw(cams, view);
  assert.deepEqual(pins, [cams[0], cams[3]]);
  assert.equal(total, 2);
});

test('layerReport: the zoom-in report says how many cameras sit in the areas this view touches', () => {
  const r = layerReport({ provider: 'caltrans-cwwp2', belowZoom: true, areaCount: 145 });
  assert.match(r, /^Zoom in to see cameras\. 145 cameras in areas this view touches/);
  assert.match(r, /zoom 7/);
  assert.match(cameraStatus({ on: true, belowZoom: true, areaCount: 145 }).text, /145 cameras in areas this view touches/);
  assert.doesNotMatch(layerReport({ provider: 'caltrans-cwwp2', belowZoom: true }), /areas this view touches/);
});

test('layerReport: a capped draw says how many pins are shown and that zooming in shows the rest', () => {
  const inView = Array.from({ length: 500 }, () => ({ lat: 1, lon: 1 }));
  const r = layerReport({ provider: 'caltrans-cwwp2', inView, cameras: inView, capped: { shown: 300, total: 500 } });
  assert.match(r, /500 .*in this view/);
  assert.match(r, /Showing the 300 nearest the centre; zoom in to see the rest\./);
  assert.doesNotMatch(layerReport({ provider: 'caltrans-cwwp2', inView, cameras: inView }), /Showing the/);
});

test('unloadedFilesNear: index files not yet read whose area reaches a point, within the distance', () => {
  const files = [
    { file: 'a.json', layer: 'roadCameras', bbox: { minLon: -122, minLat: 36, maxLon: -121, maxLat: 37 } },
    { file: 'b.json', layer: 'roadCameras', bbox: { minLon: -119, minLat: 33, maxLon: -118, maxLat: 34 } },
    { file: 'c.json', layer: 'parkCameras', bbox: { minLon: -122, minLat: 36, maxLon: -121, maxLat: 37 } },
  ];
  const none = new Set();
  assert.deepEqual(unloadedFilesNear(files, none, ['roadCameras'], 36.5, -121.5, 25000).map((f) => f.file), ['a.json']);
  assert.deepEqual(unloadedFilesNear(files, new Set(['a.json']), ['roadCameras'], 36.5, -121.5, 25000), [], 'a read file is not "unloaded"');
  assert.deepEqual(unloadedFilesNear(files, none, ['roadCameras'], 36.5, -120.9, 25000).map((f) => f.file), ['a.json'], 'just outside the box but within 25 km');
  assert.deepEqual(unloadedFilesNear(files, none, ['roadCameras'], 36.5, -120.0, 25000), [], 'far outside');
  assert.deepEqual(unloadedFilesNear(files, none, ['parkCameras'], 36.5, -121.5, 25000).map((f) => f.file), ['c.json'], 'only the layers asked for');
  assert.deepEqual(unloadedFilesNear(undefined, none, ['roadCameras'], 36.5, -121.5, 25000), []);
});

test('layerReport: a partial failure names how many areas did not load and keeps the cameras that did', () => {
  const inView = [{ lat: 1, lon: 1 }];
  const r = layerReport({ provider: 'caltrans-cwwp2', inView, cameras: inView, failedAreas: 2 });
  assert.match(r, /^1 road camera in this view\./);
  assert.match(r, /2 areas did not load\./);
  assert.doesNotMatch(layerReport({ provider: 'caltrans-cwwp2', inView, cameras: inView }), /did not load/);
});

// The card's owner link: a link-only camera says "View on <owner>", every other camera keeps its
// provider's own text (main.js used to label every non-NPS link "About Caltrans cameras").
test('aboutLinkText: link-only pins read "View on <owner>", Caltrans and NPS keep their own text', () => {
  const { aboutLinkText } = cameraLayer;
  assert.equal(typeof aboutLinkText, 'function', 'camera-layer exports aboutLinkText');
  assert.equal(aboutLinkText({ provider: 'hpwren', operator: 'HPWREN' }), 'View on HPWREN');
  assert.equal(aboutLinkText({ provider: 'alertwest', operator: 'AlertWest' }), 'View on AlertWest');
  assert.equal(aboutLinkText({ provider: 'caltrans-cwwp2', operator: 'Caltrans' }), 'About Caltrans cameras');
  assert.equal(aboutLinkText({ provider: 'nps-webcams', operator: 'National Park Service' }), 'Park webcam page');
});

test('coverage: every snapshot-index file box sits whole inside one of its layer’s coverage boxes', () => {
  const index = read('../../static/data/quiet-corners-maps/cameras/index.json');
  assert.ok(index.files.length > 0);
  for (const f of index.files) {
    const spec = LAYER_BY_ID[f.layer];
    // coverageMore is coverage too (viewTouchesLayer reads both), so a file across the dateline sits in one of those boxes.
    assert.ok([spec.coverage, ...(spec.coverageMore || [])].some((box) => box.minLon <= f.bbox.minLon && box.maxLon >= f.bbox.maxLon
      && box.minLat <= f.bbox.minLat && box.maxLat >= f.bbox.maxLat), `${f.file} falls outside ${f.layer}'s coverage boxes`);
  }
});

// Coverage honesty: a layer's coverage must hold everything the snapshot can file under it, so a
// refreshed list is never read as "outside coverage". STATE_BBOX is the build's own state clamp.
// The build accepts a row within STATE_BBOX_PAD of a state box, so coverage must hold the padded box
// (longitude clamped to the globe: nothing sits west of -180).
const boxOf = ([minLat, maxLat, minLon, maxLon]) => ({
  minLon: Math.max(-180, minLon - STATE_BBOX_PAD), minLat: minLat - STATE_BBOX_PAD,
  maxLon: maxLon + STATE_BBOX_PAD, maxLat: maxLat + STATE_BBOX_PAD,
});
const TERRITORIES = new Set(['pr', 'vi', 'gu', 'as', 'mp']);
const containedBy = (spec, b) => viewTouchesLayer({ minLon: b.minLon, minLat: b.minLat, maxLon: b.minLon, maxLat: b.minLat }, spec)
  && [[b.minLon, b.minLat], [b.maxLon, b.minLat], [b.minLon, b.maxLat], [b.maxLon, b.maxLat]]
    .every(([lon, lat]) => [spec.coverage, ...(spec.coverageMore || [])].some((c) => inside(c, { lat, lon })));

test('coverage: parkCameras holds every state and territory box the build can file, Guam and Samoa included', () => {
  const spec = LAYER_BY_ID.parkCameras;
  const missed = Object.entries(STATE_BBOX).filter(([, b]) => !containedBy(spec, boxOf(b))).map(([c]) => c);
  assert.deepEqual(missed, []);
});

test('coverage: linkCameras holds every US state box AlertWest can file, and California for HPWREN', () => {
  const spec = LAYER_BY_ID.linkCameras;
  const missed = Object.entries(STATE_BBOX).filter(([c]) => !TERRITORIES.has(c)).filter(([, b]) => !containedBy(spec, boxOf(b))).map(([c]) => c);
  assert.deepEqual(missed, []);
  assert.ok(spec.goTo && viewTouchesLayer(spec.goTo, spec), 'Go to opens inside the coverage');
});

test('coverage: roadCameras holds every US state box a road provider can file, and Go to opens on California inside it', () => {
  const spec = LAYER_BY_ID.roadCameras;
  const missed = Object.entries(STATE_BBOX).filter(([c]) => !TERRITORIES.has(c)).filter(([, b]) => !containedBy(spec, boxOf(b))).map(([c]) => c);
  assert.deepEqual(missed, []);
  assert.equal(spec.coverageName, 'US states');
  assert.doesNotMatch(spec.label, /California/);
  assert.ok(spec.goTo && viewTouchesLayer(spec.goTo, spec), 'Go to opens inside the coverage');
});

test('coverage: every row of the committed snapshot index sits inside its layer coverage', () => {
  const index = read('../../static/data/quiet-corners-maps/cameras/index.json');
  const outside = index.files.filter((f) => !containedBy(LAYER_BY_ID[f.layer], f.bbox)).map((f) => f.file);
  assert.deepEqual(outside, []);
});

test('viewTouchesLayer: a view over Guam touches the park layer, one over Paris does not; no park text says a territory is outside the United States', () => {
  const park = LAYER_BY_ID.parkCameras;
  assert.equal(viewTouchesLayer({ minLon: 144.5, minLat: 13.3, maxLon: 144.9, maxLat: 13.6 }, park), true);
  assert.equal(viewTouchesLayer({ minLon: 2, minLat: 48, maxLon: 3, maxLat: 49 }, park), false);
  assert.doesNotMatch(layerReport({ provider: 'nps-webcams', outsideCoverage: true }), /outside the United States/i);
});

test('Go to: a layer whose Go to box differs from its coverage names that target, so the button never says the coverage name', () => {
  for (const id of ['roadCameras', 'parkCameras', 'linkCameras']) assert.ok(LAYER_BY_ID[id].goToName, `${id} names its Go to target`);
  assert.notEqual(LAYER_BY_ID.linkCameras.goToName, LAYER_BY_ID.linkCameras.coverageName);
});

// A road list that fails must not blame Caltrans when the failing list is another operator's.
const ROAD_FILES = [
  { layer: 'roadCameras', provider: 'caltrans-cwwp2', file: 'ca.json', bbox: { minLon: -124.5, minLat: 32.5, maxLon: -114, maxLat: 42 } },
  { layer: 'roadCameras', provider: 'ky-kytc', file: 'ky.json', bbox: { minLon: -89.6, minLat: 36.5, maxLon: -81.9, maxLat: 39.2 } },
];
const LOUISVILLE = { minLon: -86, minLat: 38, maxLon: -85.4, maxLat: 38.4 };

test('failureProvider: a Kentucky-only view names the Kentucky provider, never Caltrans', () => {
  const provider = failureProvider(ROAD_FILES, LOUISVILLE, 'roadCameras', null);
  assert.equal(provider, 'ky-kytc');
  assert.doesNotMatch(layerReport({ provider, error: 'did not load' }), /Caltrans/);
});

test('failureProvider: a view over two operators, or none, falls back to the given provider', () => {
  const both = { minLon: -120, minLat: 30, maxLon: -80, maxLat: 40 };
  assert.equal(failureProvider(ROAD_FILES, both, 'roadCameras', null), null);
  assert.equal(failureProvider(ROAD_FILES, { minLon: 10, minLat: 40, maxLon: 11, maxLat: 41 }, 'roadCameras', null), null);
  assert.equal(failureProvider([], LOUISVILLE, 'parkCameras', 'nps-webcams'), 'nps-webcams');
  assert.doesNotMatch(layerReport({ provider: null, error: 'did not load' }), /Caltrans/);
});

test('road layer: a view outside the US-states box reads the outside-coverage text', () => {
  const europe = { minLon: 2, minLat: 47, maxLon: 3, maxLat: 48 };
  assert.equal(viewTouchesLayer(europe, LAYER_BY_ID.roadCameras), false);
  assert.match(layerReport({ provider: 'caltrans-cwwp2', outsideCoverage: true }), /^Outside coverage:/);
});

// The wiring, not only the helper: renderCameraReport's failure path must ask failureProvider, with
// no operator fallback for the road layer, or a Kentucky failure reads as Caltrans's again.
test("renderCameraReport: a road list failure is worded by failureProvider, never by the index's first row", () => {
  const src = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function renderCameraReport('), src.indexOf('const view = viewBbox();', src.indexOf('function renderCameraReport(')));
  const failure = body.slice(body.indexOf('if (cameraFailed[layerId])'));
  assert.match(failure, /failureProvider\(rows, viewBbox\(\), layerId, layerId === 'roadCameras' \? null : provider\)/);
  assert.match(failure, /cameraLayerReport\(\{ provider: failedProvider, error: 'did not load' \}\)/);
});

test('coverage: phenoCameras and airportCameras hold every US state box their lists can file, and Go to opens inside', () => {
  for (const id of ['phenoCameras', 'airportCameras']) {
    const spec = LAYER_BY_ID[id];
    assert.ok(spec, `${id} is a registry row`);
    assert.equal(spec.group, 'cameras');
    assert.equal(spec.screenOnly, true);
    const missed = Object.entries(STATE_BBOX).filter(([c]) => !TERRITORIES.has(c)).filter(([, b]) => !containedBy(spec, boxOf(b))).map(([c]) => c);
    assert.deepEqual(missed, [], id);
    assert.ok(spec.goTo && viewTouchesLayer(spec.goTo, spec), `${id}: Go to opens inside the coverage`);
  }
});

test('coverage: phenoCameras holds every state and territory box the volcano list can file and the western Aleutians, but not Paris or Tokyo', () => {
  const spec = LAYER_BY_ID.phenoCameras;
  const missed = Object.entries(STATE_BBOX).filter(([, b]) => !containedBy(spec, boxOf(b))).map(([c]) => c);
  assert.deepEqual(missed, []);
  assert.ok(containedBy(spec, { minLon: 172, minLat: 51, maxLon: 180, maxLat: 53.6 }), 'the Aleutians west of the dateline');
  for (const [name, view] of [['Amchitka', { minLon: 179, minLat: 51.2, maxLon: 179.6, maxLat: 51.6 }], ['Guam', { minLon: 144.5, minLat: 13.3, maxLon: 144.9, maxLat: 13.6 }]]) {
    assert.equal(viewTouchesLayer(view, spec), true, name);
  }
  for (const [name, view] of [['Paris', { minLon: 2, minLat: 48, maxLon: 3, maxLat: 49 }], ['Tokyo', { minLon: 139.5, minLat: 35.4, maxLon: 140, maxLat: 35.9 }]]) {
    assert.equal(viewTouchesLayer(view, spec), false, name);
  }
});

test('PhenoCam and AviationWX cards: a plain <img> of the owner\'s picture, the owner named, never the link-only wording', () => {
  const cam = (provider, operator) => ({ provider, operator, name: 'X', health: 'active', media: { still: 'https://example.invalid/a.jpg' } });
  for (const [provider, operator, noun] of [['phenocam', 'PhenoCam Network', 'research camera'], ['aviationwx', 'AviationWX.org', 'airport camera']]) {
    const c = cam(provider, operator);
    assert.equal(stillPlan(c), 'img', provider);
    assert.equal(providerRow(provider).noun, noun);
    assert.match(providerRow(provider).altCredit, new RegExp(operator.split('.')[0]));
    assert.ok(!cardLines(c, { generatedAt: '2026-10-04T00:00:00Z' }).some((l) => /not shown here/.test(l)), provider);
    assert.match(layerReport({ provider, inView: [c, c] }), new RegExp(`^2 ${noun}s in this view\\.`));
  }
});

test('VolcView and GLERL cards: a plain <img> of the owner\'s picture, the operator named, never the link-only wording', () => {
  const cam = (provider, operator) => ({ provider, operator, name: 'X', health: 'active', media: { still: 'https://example.invalid/a.jpg' } });
  for (const [provider, operator, noun, credit] of [['volcview', 'USGS VolcView', 'volcano camera', /USGS VolcView/],
    ['glerl', 'NOAA GLERL', 'Great Lakes camera', /NOAA GLERL/]]) {
    const c = cam(provider, operator);
    assert.equal(stillPlan(c), 'img', provider);
    assert.equal(providerRow(provider).noun, noun);
    assert.match(providerRow(provider).altCredit, credit);
    assert.equal(providerRow(provider).ageSource, 'none', 'neither operator publishes when a picture was taken');
    assert.ok(providerRow(provider).linkText.length > 0 && !/^About these cameras$/.test(providerRow(provider).linkText), provider);
    assert.ok(!cardLines(c, { generatedAt: '2026-10-05T00:00:00Z' }).some((l) => /not shown here/.test(l)), provider);
    assert.match(layerReport({ provider, inView: [c, c] }), new RegExp(`^2 ${noun}s in this view\\.`));
  }
});

// --- QQA-10f: an expired row, and a picture age read from capturedAt -------------------------
// Added 2026-10-09. These reach the module through the namespace so a missing export fails one
// test at a time instead of the whole file at link time.
const NOW_10F = new Date('2026-10-09T15:00:00.000Z');
const ago = (ms) => new Date(NOW_10F.getTime() - ms).toISOString();
const MIN = 60 * 1000, HOUR = 60 * MIN;
const NO_STILL = (camera) => ({ ...camera, media: { ...camera.media, still: null } });

test('capturedAgeText: under 30 minutes names the age and the source, over it says the camera may be stuck', () => {
  const fresh = cameraLayer.capturedAgeText(ago(3 * MIN), NOW_10F, 'nps-webcams');
  assert.equal(fresh, "Picture taken 3 min ago, per the park's listing.");
  assert.equal(cameraLayer.capturedAgeText(ago(29 * MIN), NOW_10F, 'nps-webcams'), "Picture taken 29 min ago, per the park's listing.");
  assert.equal(cameraLayer.capturedAgeText(ago(31 * MIN), NOW_10F, 'nps-webcams'),
    "Picture taken 31 min ago, per the park's listing. The camera may be stuck.");
  assert.equal(cameraLayer.capturedAgeText(ago(2 * HOUR), NOW_10F, 'nps-webcams'),
    "Picture taken 2 h ago, per the park's listing. The camera may be stuck.");
});

test('capturedAgeText: the same 30 minute line ageText uses decides "stuck" (one rule, two sources)', () => {
  const edge = (text) => /may be stuck/.test(text);
  for (const minutes of [1, 29, 30, 31, 90, 600]) {
    const fromHeader = ageText(new Date(NOW_10F.getTime() - minutes * MIN).toUTCString(), NOW_10F, 'nps-webcams');
    const fromCapture = cameraLayer.capturedAgeText(ago(minutes * MIN), NOW_10F, 'nps-webcams');
    assert.equal(edge(fromCapture), edge(fromHeader), `${minutes} min`);
  }
});

test('capturedAgeText: a missing, unreadable or future time says nothing, and no line says "live"', () => {
  for (const bad of [null, undefined, '', 'yesterday', 12345, {}]) {
    assert.equal(cameraLayer.capturedAgeText(bad, NOW_10F, 'nps-webcams'), null, String(bad));
  }
  assert.equal(cameraLayer.capturedAgeText(ago(-2 * HOUR), NOW_10F, 'nps-webcams'), null, 'a time two hours ahead is bad data, not a fresh picture');
  assert.match(cameraLayer.capturedAgeText(ago(-2 * MIN), NOW_10F, 'nps-webcams'), /^Picture taken 0 min ago/, 'a couple of minutes of clock skew reads as just now');
  for (const minutes of [1, 90]) assert.doesNotMatch(cameraLayer.capturedAgeText(ago(minutes * MIN), NOW_10F, 'caltrans-cwwp2'), /\blive\b/i);
  assert.match(cameraLayer.capturedAgeText(ago(5 * MIN), NOW_10F, 'caltrans-cwwp2'), /per Caltrans's listing/);
});

test('ageLine: an img-plan card reads its age from capturedAt, and says nothing when there is none', () => {
  const stuck = { ...PURCHASE_KNOB_NPS, capturedAt: ago(2 * HOUR) };
  assert.equal(stillPlan(stuck), 'img');
  assert.equal(cameraLayer.ageLine(stuck, { now: NOW_10F }), "Picture taken 2 h ago, per the park's listing. The camera may be stuck.");
  assert.equal(cameraLayer.ageLine({ ...PURCHASE_KNOB_NPS, capturedAt: null }, { now: NOW_10F }), '', 'no capture time: no age line, as before');
  assert.equal(cameraLayer.ageLine({ ...PURCHASE_KNOB_NPS, capturedAt: 'garbage' }, { now: NOW_10F }), '');
});

test('ageLine: on a fetch plan the picture file\'s Last-Modified wins, capturedAt fills in when the header is absent', () => {
  const withCapture = { ...PILOT, capturedAt: ago(2 * HOUR) };
  const header = new Date(NOW_10F.getTime() - 3 * MIN).toUTCString();
  assert.equal(cameraLayer.ageLine(withCapture, { lastModified: header, now: NOW_10F }), ageText(header, NOW_10F, PILOT.provider),
    'a readable header is the measured age of the file just fetched');
  assert.equal(cameraLayer.ageLine(withCapture, { lastModified: null, now: NOW_10F }),
    "Picture taken 2 h ago, per Caltrans's listing. The camera may be stuck.");
  assert.equal(cameraLayer.ageLine(withCapture, { lastModified: 'not a date', now: NOW_10F }),
    "Picture taken 2 h ago, per Caltrans's listing. The camera may be stuck.", 'an unreadable header is no header');
  assert.equal(cameraLayer.ageLine(PILOT, { lastModified: null, now: NOW_10F }), ageText(null, NOW_10F, PILOT.provider),
    'neither source: the existing "did not say" line, unchanged');
});

test('pictureExpired: only a camera that lost its still to a validUntil that has passed', () => {
  const expired = NO_STILL({ ...PURCHASE_KNOB_NPS, validUntil: ago(HOUR) });
  assert.equal(cameraLayer.pictureExpired(expired, NOW_10F), true);
  assert.equal(cameraLayer.pictureExpired(NO_STILL({ ...PURCHASE_KNOB_NPS, validUntil: ago(-HOUR) }), NOW_10F), false, 'expiry still ahead');
  assert.equal(cameraLayer.pictureExpired(NO_STILL({ ...PURCHASE_KNOB_NPS, validUntil: ago(0) }), NOW_10F), false, 'valid up to and including the instant');
  assert.equal(cameraLayer.pictureExpired(NO_STILL({ ...PURCHASE_KNOB_NPS, validUntil: null }), NOW_10F), false, 'no expiry: just no picture');
  assert.equal(cameraLayer.pictureExpired({ ...PURCHASE_KNOB_NPS, validUntil: ago(HOUR) }, NOW_10F), false, 'a camera that still has its picture is not expired');
  assert.equal(cameraLayer.pictureExpired(NO_STILL({ ...PURCHASE_KNOB_NPS, validUntil: 'garbage' }), NOW_10F), true, 'an unreadable expiry counts as past, as expandSnapshot does');
});

test('expired row end to end: expandSnapshot drops the still, the plan is link, the card says out of date and not "no picture published"', () => {
  const file = {
    schema: 2, provider: 'nps-webcams', layer: 'parkCameras', region: 'nps-xx', regionName: 'Test', generatedAt: '2026-10-09T12:00:00.000Z',
    source: null, operator: 'National Park Service', officialUrl: 'https://www.nps.gov/', attribution: 'National Park Service',
    rights: 'unverified', category: 'scenic',
    fields: ['providerId', 'name', 'lat', 'lon', 'still', 'health', 'subject', 'officialUrl', 'validUntil'],
    rows: [
      ['a', 'Old One', 35.1, -83.1, 'https://www.nps.gov/a.jpg', 'active', null, null, ago(HOUR)],
      ['b', 'Fresh One', 35.2, -83.2, 'https://www.nps.gov/b.jpg', 'active', null, null, ago(-HOUR)],
      ['c', 'No Still', 35.3, -83.3, null, 'active', null, null, null],
    ],
  };
  const [old, fresh, none] = expandSnapshot(file, { now: NOW_10F });
  assert.equal(old.media.still, null);
  assert.equal(stillPlan(old), 'link', 'no request is ever made for it');
  const oldLines = cardLines(old, { generatedAt: file.generatedAt, now: NOW_10F });
  assert.ok(oldLines.some((l) => /out of date/i.test(l)), oldLines.join(' | '));
  assert.ok(!oldLines.some((l) => /No picture is published/i.test(l)), oldLines.join(' | '));
  assert.equal(stillPlan(fresh), 'img');
  assert.ok(!cardLines(fresh, { generatedAt: file.generatedAt, now: NOW_10F }).some((l) => /out of date/i.test(l)));
  const noneLines = cardLines(none, { generatedAt: file.generatedAt, now: NOW_10F });
  assert.ok(noneLines.includes('No picture is published for this camera.'), 'a row that never had a picture reads as before');
  assert.ok(!noneLines.some((l) => /out of date/i.test(l)));
});

test('cardLines: an out-of-service camera keeps the out-of-service line even when its expiry has passed', () => {
  const lines = cardLines(NO_STILL({ ...OUT_OF_SERVICE, validUntil: ago(HOUR) }), { generatedAt: FETCHED_AT, now: NOW_10F });
  assert.ok(lines.includes('Caltrans lists this camera as out of service.'), lines.join(' | '));
  assert.ok(!lines.some((l) => /out of date/i.test(l)), lines.join(' | '));
});

test('cardLines: an NPS card that carries a capture time no longer says the park publishes none', () => {
  const plain = cardLines(PURCHASE_KNOB_NPS, { generatedAt: FETCHED_AT_NPS });
  assert.ok(plain.some((l) => /does not publish when this picture was taken/.test(l)), 'unchanged without a capture time');
  const captured = cardLines({ ...PURCHASE_KNOB_NPS, capturedAt: ago(5 * MIN) }, { generatedAt: FETCHED_AT_NPS });
  assert.ok(!captured.some((l) => /does not publish/.test(l)), captured.join(' | '));
  assert.ok(captured.includes('Camera list checked 27 Sep 2026.'), captured.join(' | '));
});
