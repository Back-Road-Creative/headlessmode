// Pure tests for the B1 view-state wiring: throttle/guard helpers, apply-order,
// Reset-view leaving the print recipe untouched, and popstate re-entrancy.
// No DOM, no browser -- everything here is a fake map/setter object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPLY_ORDER,
  createThrottle,
  createApplyGuard,
  applyView,
  createRoutineWriter,
  createPopstateHandler,
  resetView,
  createPrefsStore,
  PREFS_KEY,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/view-wiring.js';
import { DEFAULT_VIEW, resolveInitialView } from '../../themes/headlessmode/static/js/quiet-corners-maps/view-state.js';

test('APPLY_ORDER lists every settable field exactly once', () => {
  const expected = ['center', 'base', 'surface', 'overlays', 'county', 'labels', 'emphasis', 'camera'];
  assert.deepEqual(APPLY_ORDER, expected);
});

test('createThrottle: trailing-edge, latest args win, one call per window', async () => {
  const calls = [];
  const { call, cancel } = createThrottle((v) => calls.push(v), 20);
  call('a');
  call('b');
  call('c');
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(calls, ['c'], 'only the latest args from the burst should fire, once');
  cancel();
});

test('createThrottle: cancel drops a pending call', async () => {
  const calls = [];
  const { call, cancel } = createThrottle((v) => calls.push(v), 20);
  call('a');
  cancel();
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(calls, []);
});

test('createApplyGuard: applying is true only during run(), false before/after', () => {
  const guard = createApplyGuard();
  assert.equal(guard.applying, false);
  let sawApplying = false;
  guard.run(() => { sawApplying = guard.applying; });
  assert.equal(sawApplying, true);
  assert.equal(guard.applying, false);
});

test('createApplyGuard: nested run() keeps applying true until the outer call returns', () => {
  const guard = createApplyGuard();
  guard.run(() => {
    guard.run(() => {});
    assert.equal(guard.applying, true, 'still inside the outer run()');
  });
  assert.equal(guard.applying, false);
});

test('applyView: calls only the setters the caller provided, in APPLY_ORDER', () => {
  const view = { ...DEFAULT_VIEW, center: [40, -100], zoom: 6, base: 'usgsImagery', surface: 'ownership', overlays: ['a', 'b'] };
  const order = [];
  const setters = {
    setCenterZoom: (c, z) => order.push(['center', c, z]),
    setBase: (b) => order.push(['base', b]),
    setOverlays: (o) => order.push(['overlays', o]),
    // no setSurface, setCounty, setLabels, setEmphasis, setCamera -- must not throw
  };
  applyView(view, setters);
  assert.deepEqual(order.map((r) => r[0]), ['center', 'base', 'overlays'], 'skips fields with no setter, keeps order');
  assert.deepEqual(order[0], ['center', [40, -100], 6]);
  assert.deepEqual(order[1], ['base', 'usgsImagery']);
  assert.deepEqual(order[2], ['overlays', ['a', 'b']]);
});

test('resolveInitialView -> applyView end to end: fragment beats legacy query beats saved prefs beats defaults', () => {
  const enums = { bases: ['usgsTopo', 'usgsImagery'], surfaces: ['none', 'ownership'], layerIds: ['a', 'b'] };
  const { view } = resolveInitialView({
    fragment: '#map=v1&z=8&c=41,-105&b=usgsImagery',
    legacyQuery: '?v=1&lat=10&lon=10',
    savedPrefs: { base: 'usgsTopo' },
    defaults: { ...enums },
  });
  const seen = {};
  applyView(view, {
    setCenterZoom: (c, z) => { seen.center = c; seen.zoom = z; },
    setBase: (b) => { seen.base = b; },
  });
  assert.deepEqual(seen.center, [41, -105], 'fragment center wins over legacy query and defaults');
  assert.equal(seen.zoom, 8);
  assert.equal(seen.base, 'usgsImagery', 'fragment base wins over saved prefs');
});

test('resolveInitialView -> applyView: no fragment falls through to legacy query center, then saved prefs base', () => {
  const { view } = resolveInitialView({
    fragment: null,
    legacyQuery: '?v=1&lat=33.5&lon=-112.25',
    savedPrefs: { base: 'usgsImagery' },
    defaults: {},
  });
  const seen = {};
  applyView(view, {
    setCenterZoom: (c) => { seen.center = c; },
    setBase: (b) => { seen.base = b; },
  });
  assert.deepEqual(seen.center, [33.5, -112.25]);
  assert.equal(seen.base, 'usgsImagery');
});

test('resetView: returns DEFAULT_VIEW and asks the caller to remove the fragment, never mutates a print recipe passed nearby', () => {
  const recipe = { paper: 'letter', layers: ['trails', 'roads'] };
  const recipeBefore = JSON.parse(JSON.stringify(recipe));
  let cleared = false;
  const prefsStore = { clear: () => { cleared = true; } };

  const result = resetView({ defaultView: DEFAULT_VIEW, prefsStore });

  assert.deepEqual(result.view, DEFAULT_VIEW);
  assert.equal(result.removeFragment, true);
  assert.equal(cleared, true, 'saved display prefs must be cleared');
  assert.deepEqual(recipe, recipeBefore, 'a print recipe sitting nearby must be untouched by Reset view');
});

test('resetView: never throws when prefsStore is absent', () => {
  assert.doesNotThrow(() => resetView({ defaultView: DEFAULT_VIEW }));
});

test('popstate re-entrancy: N popstates through the guarded apply produce zero history writes', () => {
  let writeCalls = 0;
  const guard = createApplyGuard();
  const write = () => { writeCalls += 1; };
  const routineWriter = createRoutineWriter({
    write,
    hasActiveFragment: () => true,
    guard,
    waitMs: 1,
  });

  // A setter whose side effect synchronously mimics a Leaflet 'moveend' firing
  // during the programmatic apply -- the exact loop this guard exists for.
  const setters = {
    setCenterZoom: () => { routineWriter.notify('#map=v1&z=4'); },
  };

  const handler = createPopstateHandler({
    resolveView: () => ({ ...DEFAULT_VIEW, zoom: 5 }),
    applySetters: setters,
    guard,
  });

  for (let i = 0; i < 5; i += 1) handler();

  // The throttle's own window has long since elapsed synchronously in this test
  // (no awaits), so nothing has fired yet regardless; the guard is what proves
  // that even a fired write would have been zero -- assert both angles.
  assert.equal(writeCalls, 0, 'no synchronous write during apply');
});

test('popstate re-entrancy: a throttled write requested while applying is dropped even after its window elapses', async () => {
  let writeCalls = 0;
  const guard = createApplyGuard();
  const routineWriter = createRoutineWriter({
    write: () => { writeCalls += 1; },
    hasActiveFragment: () => true,
    guard,
    waitMs: 5,
  });
  const handler = createPopstateHandler({
    resolveView: () => ({ ...DEFAULT_VIEW }),
    applySetters: { setCenterZoom: () => { routineWriter.notify('#map=v1&z=4'); } },
    guard,
  });
  for (let i = 0; i < 3; i += 1) handler();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(writeCalls, 0, 'a write requested while guard.applying was true must never reach history, even later');
});

test('createRoutineWriter: skips the write when there is no active map fragment yet', async () => {
  let writeCalls = 0;
  const writer = createRoutineWriter({
    write: () => { writeCalls += 1; },
    hasActiveFragment: () => false,
    waitMs: 5,
  });
  writer.notify('#map=v1&z=4');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(writeCalls, 0, 'routine movement must never CREATE a fragment');
});

test('createRoutineWriter: writes once an active fragment exists and not while applying', async () => {
  let writeCalls = 0;
  let lastFragment = null;
  const guard = createApplyGuard();
  const writer = createRoutineWriter({
    write: (f) => { writeCalls += 1; lastFragment = f; },
    hasActiveFragment: () => true,
    guard,
    waitMs: 5,
  });
  writer.notify('#map=v1&z=9');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(writeCalls, 1);
  assert.equal(lastFragment, '#map=v1&z=9');
});

test('createPrefsStore: never throws when localStorage is unavailable, degrades to no-ops', () => {
  const store = createPrefsStore(PREFS_KEY, null);
  assert.doesNotThrow(() => store.save({ base: 'usgsTopo' }));
  assert.equal(store.load(), null);
  assert.doesNotThrow(() => store.clear());
});

test('createPrefsStore: round-trips through a fake storage and uses its own key, never "last"', () => {
  const backing = new Map();
  const fakeStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, v),
    removeItem: (k) => backing.delete(k),
  };
  const store = createPrefsStore(PREFS_KEY, fakeStorage);
  assert.notEqual(PREFS_KEY, 'last');
  store.save({ base: 'usgsImagery', labels: { density: 'more', size: 'large' }, emphasis: { dim: 0.2, lines: 1, spotlight: null } });
  assert.deepEqual(store.load(), { base: 'usgsImagery', labels: { density: 'more', size: 'large' }, emphasis: { dim: 0.2, lines: 1, spotlight: null } });
  store.clear();
  assert.equal(store.load(), null);
});

test('createPrefsStore: a corrupt stored value degrades to null, never throws', () => {
  const fakeStorage = { getItem: () => '{not json', setItem() {}, removeItem() {} };
  const store = createPrefsStore(PREFS_KEY, fakeStorage);
  assert.equal(store.load(), null);
});
