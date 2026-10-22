// Tests for the pure, versioned Field Maps view-state module. No DOM, no
// Leaflet, no fetch — everything here is string in, object out.
// Runs under Node's built-in runner: node --test "scripts/qcm/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VIEW, MAX_FRAGMENT_CHARS, LABEL_SIZES, parseFragment, formatFragment,
  resolveInitialView, prefsFromView, viewWithPrefs,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/view-state.js';

const ENUMS = { bases: ['usgsTopo', 'usgsImagery', 'usgsShadedRelief', 'none'],
  surfaces: ['none', 'nightLights', 'nlcdLandCover'],
  layerIds: ['mvum', 'trails', 'federalLand', 'countyLines', 'wetlands'] };

const view = (overrides = {}) => ({ ...DEFAULT_VIEW, ...overrides });

test('round-trip: a fully specified valid view survives format -> parse exactly', () => {
  const v = view({
    zoom: 12.5,
    center: [35.03125, -83.53125],
    base: 'usgsImagery',
    surface: 'nightLights',
    overlays: ['mvum', 'trails'],
    county: { scores: true, metric: 'housing', opacity: 0.6, thresholds: [10, 20, 30] },
    labels: { density: 'more', size: 'large' },
    emphasis: { dim: 0.4, lines: 1.5, spotlight: 'trails' },
    camera: { pitch: 30, bearing: 180, exaggeration: 1.5 },
    centerSource: 'user',
  });
  const { fragment, notices } = formatFragment(v);
  assert.equal(notices.length, 0);
  assert.match(fragment, /^#map=v1&/);
  const parsed = parseFragment(fragment, ENUMS);
  assert.deepEqual(parsed.notices, []);
  // centerSource is never serialized — a view read back off a link is always 'link'.
  assert.deepEqual(parsed.view, { ...v, centerSource: 'link' });
});

test('round-trip: a minimal (defaults-only) view survives format -> parse exactly', () => {
  const v = view();
  const { fragment } = formatFragment(v);
  const parsed = parseFragment(fragment, ENUMS);
  assert.deepEqual(parsed.view, { ...v, centerSource: 'link' });
});

test('formatting the same view twice yields identical strings (stability)', () => {
  const v = view({ zoom: 9, center: [40.1, -80.2], overlays: ['mvum', 'wetlands'] });
  const a = formatFragment(v);
  const b = formatFragment(v);
  assert.equal(a.fragment, b.fragment);
});

test('a hash that is not a map fragment is left alone', () => {
  for (const hash of ['#documentation', '#', '', null, undefined, '#map', 'map=v1']) {
    const { view: parsedView, notices } = parseFragment(hash, ENUMS);
    assert.equal(parsedView, null, `expected null for ${JSON.stringify(hash)}`);
    assert.deepEqual(notices, []);
  }
});

test('unsupported version bails out entirely, with a single notice', () => {
  const { view: parsedView, notices } = parseFragment('#map=v2&z=5', ENUMS);
  assert.equal(parsedView, null);
  assert.deepEqual(notices, ['unsupported version']);
});

test('oversized fragment input (> 2 KB) is rejected outright', () => {
  const huge = `#map=v1&o=${Array.from({ length: 400 }, (_, i) => `layer${i}`).join(',')}`;
  assert.ok(huge.length > 2048, 'test fixture must actually exceed 2 KB');
  const { view: parsedView, notices } = parseFragment(huge, ENUMS);
  assert.equal(parsedView, null);
  assert.ok(notices.length === 1 && /2 ?KB|size/i.test(notices[0]), notices.join('; '));
});

test('out-of-range or non-finite center falls back to default with a notice', () => {
  for (const bad of ['999,-83', '35.0,999', 'nope,nope', '35.0']) {
    const { view: parsedView, notices } = parseFragment(`#map=v1&c=${bad}`, ENUMS);
    assert.deepEqual(parsedView.center, DEFAULT_VIEW.center, bad);
    assert.ok(notices.some((n) => /center/i.test(n)), bad);
  }
});

test('out-of-range or non-finite zoom falls back to default with a notice', () => {
  for (const bad of ['-1', '23', 'NaN', '']) {
    const { view: parsedView, notices } = parseFragment(`#map=v1&z=${bad}`, ENUMS);
    assert.equal(parsedView.zoom, DEFAULT_VIEW.zoom, bad);
    if (bad !== '') assert.ok(notices.some((n) => /zoom/i.test(n)), bad);
  }
});

test('unknown base/surface fall back to default with a notice', () => {
  const r1 = parseFragment('#map=v1&b=madeUpBase', ENUMS);
  assert.equal(r1.view.base, DEFAULT_VIEW.base);
  assert.ok(r1.notices.some((n) => /base/i.test(n)));

  const r2 = parseFragment('#map=v1&s=madeUpSurface', ENUMS);
  assert.equal(r2.view.surface, DEFAULT_VIEW.surface);
  assert.ok(r2.notices.some((n) => /surface/i.test(n)));
});

test('unknown overlay layer ids are dropped with a notice, known ones kept', () => {
  const { view: parsedView, notices } = parseFragment('#map=v1&o=mvum,bogusLayer,trails', ENUMS);
  assert.deepEqual(parsedView.overlays, ['mvum', 'trails']);
  assert.ok(notices.some((n) => /bogusLayer/.test(n)));
});

test('formatFragment output is length-bounded and clips overlays with a notice', () => {
  const manyLayers = Array.from({ length: 60 }, (_, i) => `layer-with-a-longish-id-${i}`);
  const v = view({ overlays: manyLayers });
  const { fragment, notices } = formatFragment(v);
  assert.ok(fragment.length <= MAX_FRAGMENT_CHARS, `${fragment.length} > ${MAX_FRAGMENT_CHARS}`);
  assert.ok(notices.some((n) => /clip/i.test(n)));
});

test('location-derived centers are never serialized unless includeLocation is set', () => {
  const v = view({ center: [47.6, -122.3], centerSource: 'location' });
  const suppressed = formatFragment(v);
  assert.doesNotMatch(suppressed.fragment, /[&#]c=/);
  assert.ok(suppressed.notices.some((n) => /location/i.test(n)));

  const included = formatFragment(v, { includeLocation: true });
  assert.match(included.fragment, /[&#]c=47\.6,-122\.3/);
  assert.deepEqual(included.notices, []);
});

test('resolveInitialView: a map fragment wins outright, ignoring legacy and savedPrefs', () => {
  const fragment = formatFragment(view({ center: [35.0, -83.5], base: 'usgsImagery' })).fragment;
  const { view: resolved } = resolveInitialView({
    fragment,
    legacyQuery: '?v=1&lat=40&lon=-90',
    savedPrefs: { base: 'usgsShadedRelief', labels: { density: 'more', size: 'large' } },
    defaults: ENUMS,
  });
  assert.deepEqual(resolved.center, [35.0, -83.5]);
  assert.equal(resolved.base, 'usgsImagery');
  assert.deepEqual(resolved.labels, DEFAULT_VIEW.labels);
});

test('resolveInitialView: legacy link supplies center only when there is no fragment', () => {
  const { view: resolved } = resolveInitialView({
    fragment: null,
    legacyQuery: '?v=1&lat=40.1234&lon=-90.4321',
    savedPrefs: null,
    defaults: ENUMS,
  });
  assert.deepEqual(resolved.center, [40.1234, -90.4321]);
  assert.equal(resolved.centerSource, 'link');
  assert.equal(resolved.zoom, DEFAULT_VIEW.zoom);
});

test('resolveInitialView: savedPrefs fill missing display prefs, never center/zoom', () => {
  const { view: resolved } = resolveInitialView({
    fragment: null,
    legacyQuery: '?v=1&lat=40&lon=-90',
    savedPrefs: { base: 'usgsShadedRelief', labels: { density: 'more', size: 'large' }, emphasis: { dim: 0.5, lines: 2, spotlight: null } },
    defaults: ENUMS,
  });
  assert.deepEqual(resolved.center, [40, -90]); // legacy center, untouched by savedPrefs
  assert.equal(resolved.zoom, DEFAULT_VIEW.zoom);
  assert.equal(resolved.base, 'usgsShadedRelief');
  assert.deepEqual(resolved.labels, { density: 'more', size: 'large' });
});

test('resolveInitialView: with nothing at all, falls back to plain defaults', () => {
  const { view: resolved } = resolveInitialView({});
  assert.deepEqual(resolved, { ...DEFAULT_VIEW, centerSource: 'user' });
});

test('prefsFromView / viewWithPrefs round-trip display prefs without touching center or overlays', () => {
  const v = view({ center: [1, 2], overlays: ['mvum'], base: 'usgsImagery', labels: { density: 'more', size: 'large' } });
  const prefs = prefsFromView(v);
  const restored = viewWithPrefs(view({ center: [9, 9], overlays: [] }), prefs);
  assert.deepEqual(restored.center, [9, 9]);
  assert.deepEqual(restored.overlays, []);
  assert.equal(restored.base, 'usgsImagery');
  assert.deepEqual(restored.labels, { density: 'more', size: 'large' });
});

// QQA-05a: Extra large is a third label size. It rides the same `ld=` field the
// other two do, so a link written before it existed still parses and a size this
// build does not know is still dropped with the notice.
test('label size: xlarge is a known size and round-trips through the #map= link', () => {
  assert.deepEqual([...LABEL_SIZES], ['normal', 'large', 'xlarge']);
  const v = view({ labels: { density: 'standard', size: 'xlarge' } });
  const { fragment, notices } = formatFragment(v);
  assert.equal(notices.length, 0);
  const parsed = parseFragment(fragment, ENUMS);
  assert.deepEqual(parsed.notices, []);
  assert.deepEqual(parsed.view.labels, { density: 'standard', size: 'xlarge' });
});

test('label size: an unknown size ("huge") is still dropped with the notice', () => {
  const { fragment } = formatFragment(view({ labels: { density: 'more', size: 'large' } }));
  const tampered = fragment.replace(/ld=[^&]*/, 'ld=more,huge');
  assert.notEqual(tampered, fragment, 'fixture sanity: the ld field was rewritten');
  const parsed = parseFragment(tampered, ENUMS);
  assert.ok(parsed.notices.some((n) => /invalid label size "huge" dropped/.test(n)), parsed.notices.join(' | '));
  assert.equal(parsed.view.labels.size, DEFAULT_VIEW.labels.size);
  assert.equal(parsed.view.labels.density, 'more');
});
