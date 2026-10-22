// Pure tests for the B3 one-shot geolocation helper: outcome classification
// and the getCurrentPosition-once/watchPosition-never contract. No DOM, no
// browser -- everything here is a fake `navigator.geolocation`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLocateResult, requestOnce, withinBounds, DEFAULT_COARSE_METERS } from '../../themes/headlessmode/static/js/quiet-corners-maps/locate.js';
import { formatFragment, prefsFromView, DEFAULT_VIEW } from '../../themes/headlessmode/static/js/quiet-corners-maps/view-state.js';

// The same shape and values as quiet-corners.js's own CONUS_BOUNDS.
const CONUS_BOUNDS = [[24.5, -125.0], [49.4, -66.9]];

const position = (lat, lon, accuracy) => ({ coords: { latitude: lat, longitude: lon, accuracy } });

test('classifyLocateResult: unsupported browser', () => {
  const c = classifyLocateResult({ unsupported: true });
  assert.equal(c.kind, 'unsupported');
  assert.match(c.copy, /cannot report/i);
});

test('classifyLocateResult: PERMISSION_DENIED', () => {
  const c = classifyLocateResult({ error: { code: 1 }, bounds: CONUS_BOUNDS });
  assert.equal(c.kind, 'denied');
  assert.match(c.copy, /denied/i);
  assert.equal(c.inArea, false);
});

test('classifyLocateResult: TIMEOUT', () => {
  const c = classifyLocateResult({ error: { code: 3 }, bounds: CONUS_BOUNDS });
  assert.equal(c.kind, 'timeout');
  assert.match(c.copy, /too long/i);
});

test('classifyLocateResult: POSITION_UNAVAILABLE', () => {
  const c = classifyLocateResult({ error: { code: 2 }, bounds: CONUS_BOUNDS });
  assert.equal(c.kind, 'unavailable');
  assert.match(c.copy, /not available/i);
});

test('classifyLocateResult: an unrecognised error code still gets plain-language copy, never an exception', () => {
  const c = classifyLocateResult({ error: { code: 99 }, bounds: CONUS_BOUNDS });
  assert.equal(c.kind, 'error');
  assert.ok(c.copy);
});

test('classifyLocateResult: a fix inside the coverage area and within the coarse threshold is ok, not approximate', () => {
  const c = classifyLocateResult({ position: position(35.0, -83.0, 30), bounds: CONUS_BOUNDS });
  assert.equal(c.kind, 'ok');
  assert.equal(c.inArea, true);
  assert.equal(c.approximate, false);
});

test('classifyLocateResult: accuracy over the coarse threshold is shown as approximate, still ok/in-area', () => {
  const c = classifyLocateResult({ position: position(35.0, -83.0, 5000), bounds: CONUS_BOUNDS });
  assert.equal(c.kind, 'ok');
  assert.equal(c.inArea, true);
  assert.equal(c.approximate, true);
  assert.match(c.copy, /approximate/i);
});

test('classifyLocateResult: a fix outside the coverage bounds is out-of-area and the map is told not to move', () => {
  // Paris, well outside CONUS_BOUNDS.
  const c = classifyLocateResult({ position: position(48.8566, 2.3522, 20), bounds: CONUS_BOUNDS });
  assert.equal(c.kind, 'out-of-area');
  assert.equal(c.inArea, false);
  assert.match(c.copy, /does not cover|outside the area/i);
});

test('classifyLocateResult: no bounds passed means every fix is in-area', () => {
  const c = classifyLocateResult({ position: position(48.8566, 2.3522, 20) });
  assert.equal(c.inArea, true);
});

test('withinBounds: exact edges of the box count as inside', () => {
  assert.equal(withinBounds(24.5, -125.0, CONUS_BOUNDS), true);
  assert.equal(withinBounds(49.4, -66.9, CONUS_BOUNDS), true);
  assert.equal(withinBounds(24.4, -125.0, CONUS_BOUNDS), false);
});

test('requestOnce: no navigator.geolocation resolves unsupported, never throws', async () => {
  const c = await requestOnce(null, { bounds: CONUS_BOUNDS });
  assert.equal(c.kind, 'unsupported');
});

test('requestOnce: calls getCurrentPosition exactly once and watchPosition never, for one click', async () => {
  let getCalls = 0;
  let watchCalls = 0;
  const fake = {
    getCurrentPosition(success) { getCalls++; success(position(35.0, -83.0, 15)); },
    watchPosition() { watchCalls++; },
  };
  const c = await requestOnce(fake, { bounds: CONUS_BOUNDS });
  assert.equal(getCalls, 1);
  assert.equal(watchCalls, 0);
  assert.equal(c.kind, 'ok');
});

test('requestOnce: passes a bounded timeout/maximumAge through to getCurrentPosition and never enables high accuracy by default', async () => {
  let seenOptions = null;
  const fake = {
    getCurrentPosition(success, error, options) { seenOptions = options; success(position(35.0, -83.0, 15)); },
  };
  await requestOnce(fake, { bounds: CONUS_BOUNDS, timeout: 10000, maximumAge: 60000 });
  assert.equal(seenOptions.enableHighAccuracy, false);
  assert.equal(seenOptions.timeout, 10000);
  assert.equal(seenOptions.maximumAge, 60000);
});

test('requestOnce: a getCurrentPosition failure resolves (never rejects) with the classified error', async () => {
  const fake = { getCurrentPosition(success, error) { error({ code: 1 }); } };
  const c = await requestOnce(fake, { bounds: CONUS_BOUNDS });
  assert.equal(c.kind, 'denied');
});

// Serialization guard (plan §4.3 / §4.1 formatFragment contract), asserted
// end to end from a location-derived view: the routine fragment writer must
// never carry a location-derived center unless explicitly told to.
test('serialization guard: a location-derived view formats with no c= unless includeLocation is passed', () => {
  const view = { ...DEFAULT_VIEW, center: [35.0, -83.0], centerSource: 'location' };
  const routine = formatFragment(view, { includeLocation: false });
  assert.ok(!/(^|&)c=/.test(routine.fragment), `routine fragment should carry no center: ${routine.fragment}`);
  assert.match(routine.notices.join(' '), /suppressed/i);

  const shared = formatFragment(view, { includeLocation: true });
  assert.match(shared.fragment, /(^|&)c=35(\.\d+)?,-83(\.\d+)?/);
});

test('serialization guard: prefsFromView of a location-derived view carries no center', () => {
  const view = { ...DEFAULT_VIEW, center: [35.0, -83.0], centerSource: 'location' };
  const prefs = prefsFromView(view);
  assert.ok(!('center' in prefs), `prefsFromView leaked a center: ${JSON.stringify(prefs)}`);
  assert.deepEqual(Object.keys(prefs).sort(), ['base', 'emphasis', 'labels']);
});

test('DEFAULT_COARSE_METERS is a documented, sane threshold', () => {
  assert.equal(DEFAULT_COARSE_METERS, 2000);
});
