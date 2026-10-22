// The USGS 3DEP contour-line context layer. No new origin: the same 3DEPElevation ImageServer
// that already backs the slope and hillshade surfaces, asked for its `Contour Smoothed 25`
// raster function. Measured 2026-10-20 (Great Smokies -83.6,35.6,-83.4,35.7, 512x512):
//   - rasterFunctionInfos lists Contour 25, Contour Smoothed 25 and Preset 2ft/5ft/10ft Contour
//     Interval; Smoothed 25 answered 200 image/png in 0.14-0.5 s, the 5 ft preset 4.2 s.
//   - format=png answers PNG colour-type 0 (greyscale, no alpha: an opaque white sheet);
//     format=png32 answers RGBA with fully transparent (0,0,0,0) ground and opaque black lines,
//     so only png32 can be laid over the base map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SERVICE, MAX_IMAGE_SIDE, CONTOUR_RULE, LAYER_LABEL, LAYER_CAVEAT, contoursRequestFor,
  createContoursFetcher,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-contours.js';
import { LAYER_BY_ID, CONTEXT_LAYERS, surfaceCaption, enabledLayers }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';
import { SOURCES, cspDirectivesFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';

const MAIN = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
const SMOKIES = { minLon: -83.6, minLat: 35.6, maxLon: -83.4, maxLat: 35.7 };

test('the source row shares the 3DEP origin, asks for Contour Smoothed 25 and adds nothing to the CSP', () => {
  const s = SOURCES.usgs3depContours;
  assert.ok(s, 'no usgs3depContours source');
  assert.equal(s.kind, 'raster-image');
  assert.equal(s.origin, SOURCES.usgs3depSurface.origin);
  assert.equal(s.serviceUrl, SOURCES.usgs3depSurface.serviceUrl);
  assert.equal(SERVICE, s.serviceUrl);
  assert.deepEqual(s.renderingRules.contour, { rasterFunction: 'Contour Smoothed 25' });
  assert.deepEqual(CONTOUR_RULE, s.renderingRules.contour);
  assert.equal(s.request.format, 'png32', 'png is greyscale with no alpha: an opaque sheet over the base map');
  assert.equal(s.request.bboxSR, 4326);
  assert.equal(s.cors, 'star');
  assert.equal(s.claim, 'model');
  assert.equal(s.measuredOn, '2026-10-20');
  assert.equal(s.limits.exportTilesAllowed, false);
  const csp = cspDirectivesFor();
  assert.ok(csp['connect-src'].includes(s.origin));
  assert.ok(!csp['img-src'].includes(s.origin), 'the export is fetched as bytes, so img-src stays as it was');
});

test('the export request pins bboxSR, png32 and the rule, and caps the size keeping aspect', () => {
  const r = contoursRequestFor({ bboxLonLat: SMOKIES, width: 512, height: 512 });
  assert.equal(r.url, `${SERVICE}/exportImage`);
  assert.equal(r.params.bbox, '-83.6,35.6,-83.4,35.7');
  assert.equal(r.params.bboxSR, '4326');
  assert.equal(r.params.imageSR, '3857');
  assert.equal(r.params.format, 'png32');
  assert.equal(r.params.f, 'image');
  assert.deepEqual(JSON.parse(r.params.renderingRule), { rasterFunction: 'Contour Smoothed 25' });
  const big = contoursRequestFor({ bboxLonLat: SMOKIES, width: 4000, height: 2000 });
  assert.equal(big.width, MAX_IMAGE_SIDE);
  assert.equal(big.height, MAX_IMAGE_SIDE / 2);
});

test('a failed request is reported once and never retried automatically', async () => {
  let calls = 0;
  const { fetchImage } = createContoursFetcher({ fetchImpl: async () => { calls += 1; return { ok: false, status: 503 }; } });
  const res = await fetchImage(contoursRequestFor({ bboxLonLat: SMOKIES, width: 256, height: 256 }));
  assert.equal(res.status, 'error');
  assert.equal(calls, 1);
});

test('the layer row is a screen-only, off-by-default raster surface that states interval and resolution', () => {
  const l = LAYER_BY_ID.terrainContours;
  assert.ok(l, 'no terrainContours layer');
  assert.equal(l.group, 'context');
  assert.equal(l.sourceId, 'usgs3depContours');
  assert.equal(l.status, 'live');
  assert.equal(l.rasterSurface, true);
  assert.equal(l.screenOnly, true);
  assert.equal(l.defaultOn, false);
  assert.equal(l.label, LAYER_LABEL);
  assert.match(l.coverageCaveat, /25 metres/);
  assert.match(l.coverageCaveat, /not a survey/i);
  assert.equal(l.coverageCaveat, LAYER_CAVEAT);
  assert.ok(CONTEXT_LAYERS.some((x) => x.id === 'terrainContours'));
  assert.ok(!enabledLayers({ terrainContours: true }).some((x) => x.id === 'terrainContours'));
  assert.equal(surfaceCaption('terrainContours').claim, 'model');
});

test('main.js builds the layer, switches it from its control and names its render function', () => {
  assert.match(MAIN, /createContoursFetcher\(/);
  assert.match(MAIN, /layers\.terrainContours/);
  assert.match(MAIN, /terrainContours:\s*renderContours/);
});
