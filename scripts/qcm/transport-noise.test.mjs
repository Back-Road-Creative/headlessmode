// The transportation-noise context layer: the Bureau of Transportation Statistics' National
// Transportation Noise Map 2020 (CONUS, aviation + road + rail), a hosted tile cache on
// geo.dot.gov. Measured 2026-10-20: PNG 256 px, Web Mercator, levels 1-12 (level 13 answers a
// 404 HTML page, not an empty tile), the request Origin echoed, no key. The values are
// "potential noise levels ... for an average annual day", modelled, and BTS says they should
// not be used for individual locations -- so the layer must never print a decibel for a spot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TILE_TEMPLATE, MAX_NATIVE_ZOOM, VINTAGE_YEAR, tileUrl, leafletOptions, transportNoiseLayer,
  zoomStatus, readerStrings,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-transport-noise.js';
import { LAYER_BY_ID, CONTEXT_LAYERS, surfaceCaption, enabledLayers }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';
import { SOURCES, cspDirectivesFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';

const MAIN = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
const BASE = 'https://geo.dot.gov/server/rest/services/Hosted/NTAD_Noise_2020_CONUS_Aviation_Road_Rail/MapServer';

test('a tile URL is {z}/{y}/{x}, row before column, and stops at level 12', () => {
  assert.equal(TILE_TEMPLATE, `${BASE}/tile/{z}/{y}/{x}`);
  assert.equal(tileUrl({ z: 5, y: 12, x: 9 }), `${BASE}/tile/5/12/9`);
  assert.equal(MAX_NATIVE_ZOOM, 12);
  // Measured: 13/3120/2408 answered 404 with a text/html body.
  assert.throws(() => tileUrl({ z: 13, y: 3120, x: 2408 }), RangeError);
  const { url, options } = leafletOptions();
  assert.equal(url, TILE_TEMPLATE);
  assert.equal(options.maxNativeZoom, 12, 'else Leaflet asks for level 13 and fills the console with 404s');
  assert.ok(options.maxZoom > 12);
  assert.equal(transportNoiseLayer({ tileLayer: (u, o) => ({ u, o }) }).u, url);
  assert.equal(zoomStatus(12), null);
  assert.match(zoomStatus(14), /enlarged/i);
  assert.match(zoomStatus(14), /zoom 12/);
});

test('the source row is a modelled 2020 tile cache on geo.dot.gov and reaches img-src', () => {
  const s = SOURCES.btsTransportNoise;
  assert.ok(s, 'no btsTransportNoise source');
  assert.equal(s.kind, 'raster-tiles');
  assert.equal(s.origin, 'https://geo.dot.gov');
  assert.equal(s.serviceUrl, BASE);
  assert.equal(s.claim, 'model');
  assert.equal(s.dateBasis, 'unknown');
  assert.equal(s.measuredOn, '2026-10-20');
  assert.match(s.coverageSemantics, /2020/);
  assert.equal(s.tile.maxCachedLevelObserved, 12);
  assert.ok(cspDirectivesFor()['img-src'].includes('https://geo.dot.gov'));
});

test('the layer row is a screen-only, off-by-default raster surface in the context group', () => {
  const l = LAYER_BY_ID.transportNoise;
  assert.ok(l, 'no transportNoise layer');
  assert.equal(l.group, 'context');
  assert.equal(l.sourceId, 'btsTransportNoise');
  assert.equal(l.status, 'live');
  assert.equal(l.rasterSurface, true, 'a view-filling picture counts against the one-surface budget');
  assert.equal(l.screenOnly, true);
  assert.equal(l.defaultOn, false);
  assert.ok(l.emptyMeans);
  assert.match(l.coverageCaveat, /modelled annual average/i);
  assert.match(l.coverageCaveat, /zoom 12/);
  assert.match(l.label, /2020/);
  assert.ok(CONTEXT_LAYERS.some((x) => x.id === 'transportNoise'));
  assert.ok(!enabledLayers({ transportNoise: true }).some((x) => x.id === 'transportNoise'));
  const cap = surfaceCaption('transportNoise', { vintage: VINTAGE_YEAR });
  assert.equal(cap.claim, 'model');
  assert.match(cap.text, /Modelled for 2020/);
});

test('no reader string states a decibel figure for a place or invents a band', () => {
  for (const t of readerStrings()) {
    assert.ok(!/\b\d+(\.\d+)?\s*dB/i.test(t) || /service'?s? (own )?legend|BTS/i.test(t), t);
    assert.ok(!/\bquiet (here|spot)\b|\bsafe\b/i.test(t), t);
  }
});

test('main.js builds the layer, switches it from its control and reports the ceiling', () => {
  assert.match(MAIN, /transportNoiseLayer\(/);
  assert.match(MAIN, /layers\.transportNoise/);
  assert.match(MAIN, /transportNoise: renderTransportNoise/);
  assert.match(MAIN, /transportNoise: \(\) => \(\{ vintage: /);
});
