// The hillshade context surface: unit D2.
//
// Four things are load-bearing here, each behind a measurement or an explicit contract:
//
//   1. The fixed default is `Hillshade Multidirectional` -- a READABILITY light, not one
//      direction's cast shadow -- and "Reset light" returns to exactly this rule. Manual
//      mode is `Hillshade` with Azimuth/Altitude arguments; NW/45 (azimuth 315, altitude
//      45) is the plan's first manual setting.
//   2. Image dimensions are capped well under the service's own 8000, scaled down
//      PRESERVING ASPECT -- a hillshade export has no alpha/NoData channel to shrink it and
//      is re-rendered on every pan, so an unclamped request would ask a slow service for
//      more pixels than the map can use.
//   3. A response for a bounds/light the reader has already left must never overwrite the
//      current picture (generation guard), and a slow request must abort at the module's
//      timeout rather than hang forever (no automatic retry).
//   4. "Sun now" reports the sun's real position honestly: below the horizon is reported as
//      below the horizon and falls back to the fixed light, never clamped into daytime.
//
// And the one sentence this layer must never be read as contradicting: hillshade is not a
// cast-shadow, visibility, or passability calculation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIXED_RULE, DEFAULT_MANUAL, MAX_IMAGE_SIDE, LAYER_LABEL, LAYER_CAVEAT,
  manualRule, clampSize, hillshadeRequestFor, hillshadeImageUrl,
  createHillshadeFetcher, solarPosition,
  initialLightState, setManualLight, resetLight, setSunNow, ruleForLightState, lightStateText,
  CONTEXT_ROW,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-hillshade.js';
import { SOURCES, cspDirectivesFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { LAYER_BY_ID, LAYERS } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';

const BLUE_RIDGE = { minLon: -82.9, minLat: 35.5, maxLon: -82.7, maxLat: 35.7 };

// --- 1. the fixed rule, manual mode, and Reset light ----------------------------

test('the fixed default rule is Hillshade Multidirectional, and manual mode is Hillshade with arguments', () => {
  assert.deepEqual(FIXED_RULE, { rasterFunction: 'Hillshade Multidirectional' });
  assert.deepEqual(DEFAULT_MANUAL, { azimuth: 315, altitude: 45 }, 'NW/45 is the plan\'s first manual setting');
  assert.deepEqual(manualRule(315, 45), {
    rasterFunction: 'Hillshade',
    rasterFunctionArguments: { Azimuth: 315, Altitude: 45, ZFactor: 1 },
  });
  assert.deepEqual(manualRule(135, 20), {
    rasterFunction: 'Hillshade',
    rasterFunctionArguments: { Azimuth: 135, Altitude: 20, ZFactor: 1 },
  });
});

test('hillshadeRequestFor emits the exact renderingRule JSON, URL-encoded, for fixed and manual modes', () => {
  const fixed = hillshadeRequestFor({ bboxLonLat: BLUE_RIDGE, width: 512, height: 512, mode: 'fixed' });
  assert.equal(fixed.params.renderingRule, JSON.stringify({ rasterFunction: 'Hillshade Multidirectional' }));
  assert.equal(fixed.params.bboxSR, '4326');
  assert.equal(fixed.params.imageSR, '3857');
  assert.equal(fixed.params.bbox, '-82.9,35.5,-82.7,35.7');
  assert.equal(fixed.params.f, 'image');

  const manual = hillshadeRequestFor({
    bboxLonLat: BLUE_RIDGE, width: 512, height: 512, mode: 'manual', azimuth: 315, altitude: 45,
  });
  assert.equal(manual.params.renderingRule, JSON.stringify({
    rasterFunction: 'Hillshade', rasterFunctionArguments: { Azimuth: 315, Altitude: 45, ZFactor: 1 },
  }));

  const other = hillshadeRequestFor({
    bboxLonLat: BLUE_RIDGE, width: 512, height: 512, mode: 'manual', azimuth: 135, altitude: 20,
  });
  assert.notEqual(manual.params.renderingRule, other.params.renderingRule,
    'two different lights must ask two different questions');

  // URL-encoded, no reader text concatenated -- the whole rule travels through
  // URLSearchParams, never string-built by hand.
  const url = hillshadeImageUrl(manual);
  assert.ok(url.startsWith(`${SOURCES.usgs3depHillshade.serviceUrl}/exportImage?`));
  assert.ok(url.includes(encodeURIComponent(JSON.stringify({
    rasterFunction: 'Hillshade', rasterFunctionArguments: { Azimuth: 315, Altitude: 45, ZFactor: 1 },
  }))));
});

test('Reset light returns to exactly the fixed rule', () => {
  const manual = setManualLight(initialLightState(), 135, 20);
  assert.equal(manual.mode, 'manual');
  const reset = resetLight();
  assert.equal(reset.mode, 'fixed');
  assert.deepEqual(ruleForLightState(reset), FIXED_RULE);
  assert.deepEqual(ruleForLightState(initialLightState()), FIXED_RULE);
});

// --- 2. dimension cap, preserving aspect ----------------------------------------

test('clampSize scales down preserving aspect ratio and never exceeds the service max', () => {
  const square = clampSize(4000, 4000);
  assert.equal(square.width, MAX_IMAGE_SIDE);
  assert.equal(square.height, MAX_IMAGE_SIDE);

  const wide = clampSize(4000, 2000);
  assert.equal(wide.width, MAX_IMAGE_SIDE);
  assert.equal(wide.height, MAX_IMAGE_SIDE / 2, 'a 2:1 request must stay 2:1 after scaling down');

  const tall = clampSize(1000, 3000);
  assert.equal(tall.height, MAX_IMAGE_SIDE);
  assert.ok(Math.abs(tall.width - MAX_IMAGE_SIDE / 3) <= 1);

  const small = clampSize(300, 200);
  assert.deepEqual(small, { width: 300, height: 200 }, 'a request already under the cap is left alone');

  const degenerate = clampSize(0, -5);
  assert.equal(degenerate.width, 1);
  assert.equal(degenerate.height, 1);

  assert.ok(MAX_IMAGE_SIDE < SOURCES.usgs3depHillshade.limits.serviceMaxImageSide,
    'this layer\'s own budget must sit well under the service\'s 8000');
  const req = hillshadeRequestFor({ bboxLonLat: BLUE_RIDGE, width: 5000, height: 5000 });
  assert.ok(req.width <= MAX_IMAGE_SIDE && req.height <= MAX_IMAGE_SIDE);
});

// --- 3. generation guard, timeout, no automatic retry ---------------------------

test('a response for a bounds/light the reader left is dropped by the generation guard', async () => {
  const fetcher = createHillshadeFetcher({
    fetchImpl: async () => ({ ok: true, blob: async () => ({ size: 1 }) }),
  });
  const requestA = hillshadeRequestFor({ bboxLonLat: BLUE_RIDGE, width: 100, height: 100, mode: 'fixed' });
  const requestB = hillshadeRequestFor({ bboxLonLat: BLUE_RIDGE, width: 100, height: 100, mode: 'manual', azimuth: 135, altitude: 20 });
  const first = fetcher.fetchImage(requestA);
  const second = fetcher.fetchImage(requestB);
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.status, 'stale', 'the older bounds/light request must never win');
  assert.equal(secondResult.status, 'ready');
});

test('a slow request aborts at the module timeout and reports timeout, with no retry loop', async () => {
  let fetchCalls = 0;
  const fetcher = createHillshadeFetcher({
    timeoutMs: 20,
    fetchImpl: (url, { signal } = {}) => {
      fetchCalls += 1;
      return new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    },
  });
  const request = hillshadeRequestFor({ bboxLonLat: BLUE_RIDGE, width: 100, height: 100, mode: 'fixed' });
  const result = await fetcher.fetchImage(request);
  assert.equal(result.status, 'timeout');
  assert.equal(fetchCalls, 1, 'a timed-out request must not be retried automatically');
});

// --- 4. Sun now: honest below-horizon, never clamped into daytime --------------

test('solarPosition reports a well-known daytime altitude and an honest below-horizon nadir', () => {
  // Equator, summer solstice, local solar noon (lon 0 so UTC noon is solar noon): the
  // textbook fact is altitude = 90 - 23.44 = 66.56 degrees, independent of any azimuth
  // sign convention.
  const noon = solarPosition(new Date('2026-06-21T12:00:00Z'), 0, 0);
  assert.equal(noon.aboveHorizon, true);
  assert.ok(Math.abs(noon.altitude - 66.56) < 1.5, `expected ~66.56 degrees, got ${noon.altitude}`);
  assert.ok(Number.isFinite(noon.azimuth) && noon.azimuth >= 0 && noon.azimuth < 360);

  // Equator, equinox, local solar midnight: the sun sits at the antisolar point, altitude
  // approx -90 degrees -- the nadir, unambiguous regardless of declination's small residual.
  const midnight = solarPosition(new Date('2026-03-20T00:00:00Z'), 0, 0);
  assert.equal(midnight.aboveHorizon, false);
  assert.ok(midnight.altitude < -80, `expected a deep below-horizon altitude, got ${midnight.altitude}`);
});

test('a below-horizon sun is never clamped into daytime, and the control model falls back honestly', () => {
  const state = setSunNow(initialLightState(), {
    lat: 0, lon: 0, date: new Date('2026-03-20T00:00:00Z'), place: 'the equator',
  });
  assert.equal(state.mode, 'sun');
  assert.equal(state.belowHorizon, true);
  assert.ok(state.sunAltitude < -80);
  // The fixed rule is used while the sun is below the horizon -- never the manual rule
  // with a negative altitude asked as if it were day.
  assert.deepEqual(ruleForLightState(state), FIXED_RULE);
  assert.match(lightStateText(state), /below the horizon/i);
  assert.doesNotMatch(lightStateText(state), /\d+° altitude/i, 'a below-horizon state must not print a fabricated positive altitude');

  const daytime = setSunNow(initialLightState(), {
    lat: 0, lon: 0, date: new Date('2026-06-21T12:00:00Z'), place: 'the equator',
  });
  assert.equal(daytime.belowHorizon, false);
  assert.notDeepEqual(ruleForLightState(daytime), FIXED_RULE);
  assert.equal(ruleForLightState(daytime).rasterFunction, 'Hillshade');
  assert.match(lightStateText(daytime), /sun/i);
});

// --- Hillshade is not a cast-shadow, visibility, or passability calculation ----

test('the module documents that hillshade is not a cast-shadow, visibility, or passability calculation', () => {
  assert.match(LAYER_CAVEAT, /not a cast-shadow/i);
  assert.match(LAYER_CAVEAT, /visibility/i);
  assert.match(LAYER_CAVEAT, /passability/i);
  assert.ok(LAYER_LABEL.length);
});

// --- the registry contract, the CSP bill, and the replacement-surface rule -----

test('the source is its own measured entry and costs the CSP nothing new', () => {
  const src = SOURCES.usgs3depHillshade;
  assert.ok(src, 'the hillshade export is a source of its own, not a second endpoint on usgs3dep');
  assert.equal(src.kind, 'raster-image');
  assert.equal(src.claim, 'model');
  assert.equal(src.origin, SOURCES.usgs3dep.origin, 'the origin is already in connect-src');
  const csp = cspDirectivesFor();
  assert.ok(csp['connect-src'].includes(src.origin));
});

test('the context-surface row replaces the one surface slot and never reaches the print fetch', () => {
  assert.equal(CONTEXT_ROW.group, 'context', 'the context group is the registry\'s exclusive-surface slot');
  assert.equal(CONTEXT_ROW.sourceId, 'usgs3depHillshade');
  assert.equal(CONTEXT_ROW.screenOnly, true, 'a live per-view render has no business on a printed sheet');
  assert.equal(CONTEXT_ROW.rasterSurface, true, 'it fills the view, so the surface budget must count it');
  assert.equal(CONTEXT_ROW.defaultOn, false);

  // D1 (scripts/qcm/hillshade-wiring.test.mjs) appended this exact row to LAYERS and
  // wired main.js to read it in the same change layers-reach-paper.test.mjs requires.
  assert.equal(LAYER_BY_ID.hillshadeLight, CONTEXT_ROW,
    'hillshadeLight must be registered, and registered as D2\'s row unmodified');
  const slope = LAYERS.find((row) => row.id === 'terrainSlope');
  for (const key of ['group', 'screenOnly', 'rasterSurface', 'defaultOn', 'required', 'status']) {
    assert.equal(CONTEXT_ROW[key], slope[key], `CONTEXT_ROW.${key} must match the slope surface it will sit beside`);
  }
});
