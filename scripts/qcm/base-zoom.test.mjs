// A1: the base tile layer used to carry a zoom-9 floor (FIELD_MIN_ZOOM) on top of
// source-basemaps.js's own per-source ceiling, so a national reader who never
// touched the Layers panel saw no base under the choropleth at all. The floor is
// gone; each source's own measured cache ceiling (`maxCachedLevelObserved`) is
// now the only limit, honoured as Leaflet's `maxNativeZoom` so a source that runs
// out of detail enlarges its last cached level instead of being silently swapped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BASES, leafletOptions, zoomStatus, readerStrings } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-basemaps.js';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { VIEWPORT_FETCH } from '../../themes/headlessmode/static/js/quiet-corners-maps/app-state.js';

const DASH = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners.js', import.meta.url), 'utf8');

test('the base tile layer carries no zoom-9 floor: syncBase adds it unconditionally', () => {
  const start = DASH.indexOf('const syncBase = function()');
  assert.ok(start > -1, 'syncBase not found -- has it moved or been renamed?');
  const end = DASH.indexOf('map.qcBase', start);
  assert.ok(end > start, 'could not find the end of syncBase');
  const body = DASH.slice(start, end);
  assert.ok(!/FIELD_MIN_ZOOM/.test(body), 'syncBase still reads FIELD_MIN_ZOOM -- the floor is back');
  assert.ok(!/\bminZoom\b/.test(body), 'syncBase still gates on a minZoom check');
});

test('the initial base tile layer sets no minZoom option of its own', () => {
  const start = DASH.indexOf('let baseTiles = baseLayer(');
  assert.ok(start > -1, 'baseTiles is no longer built from baseLayer()');
  const line = DASH.slice(start, DASH.indexOf('\n', start));
  assert.ok(!/minZoom/.test(line), 'the dashboard passes its own minZoom instead of trusting source-basemaps.js');
});

test('each base source honours its own measured cache ceiling as maxNativeZoom', () => {
  for (const id of ['usgsTopo', 'usgsImagery', 'usgsShadedRelief']) {
    assert.equal(
      leafletOptions(id).options.maxNativeZoom,
      SOURCES[id].tile.maxCachedLevelObserved,
      `${id}'s maxNativeZoom must track its measured cache ceiling, not a hand-picked number`,
    );
  }
});

test('a source past its native ceiling says so; a source at or under it does not', () => {
  assert.match(zoomStatus('usgsShadedRelief', 14), /enlarged/i, 'past the relief ceiling (13) the row must say so');
  assert.equal(zoomStatus('usgsShadedRelief', 13), null, 'at its own ceiling the relief is not "enlarged" yet');
  assert.equal(zoomStatus('usgsTopo', 16), null, 'topo is cached through 16, the map’s own ceiling');
});

test('"no base map" is its own honest choice, distinct from an enlarged one', () => {
  const none = BASES.find((b) => b.id === 'none');
  assert.match(none.label, /no base map/i);
  assert.notEqual(none.label, zoomStatus('usgsShadedRelief', 14), 'off and enlarged must read as different states');
  assert.ok(readerStrings().includes(none.label));
});

test('the remote vector-fetch guard is untouched -- base zoom is a separate gate', () => {
  // VIEWPORT_FETCH (app-state.js) gates the remote overlay fetch, not the base
  // tile layer. A1 removes the base's zoom floor without touching this guard.
  assert.deepEqual(VIEWPORT_FETCH, Object.freeze({ minZoom: 9, maxAreaKm2: 2500, settleMs: 600 }));
});
