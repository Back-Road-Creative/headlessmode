// The modelled snow depth context surface: NWS NOHRSC Snow Analysis, layer 3 of the
// raster/snow MapServer, exported as one transparent picture per view. Measured live 2026-10-20
// with an `Origin: https://headlessmode.com` header:
//   MapServer?f=json            -> 200, access-control-allow-origin echoed the Origin
//   export (layers=show:3) png32 -> 200 image/png, ACAO echoed; maxImageWidth/Height 4096
//   /legend?f=json layer 3      -> 12 bins, "0 - 0.39" ... "394 - 787", no unit anywhere in the
//                                  service, layer or legend metadata
//   an in-coverage no-snow view (Great Smokies) and an out-of-coverage view (Spain) both answered
//   the same 2,231-byte transparent PNG: modelled zero and no data cannot be told apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SERVICE, DEPTH_LAYER, MAX_IMAGE_SIDE, LAYER_LABEL, LAYER_CAVEAT, LEGEND_BINS,
  snowDepthRequestFor, createSnowDepthFetcher, legendText, readerStrings,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-snow-depth.js';
import { LAYER_BY_ID, CONTEXT_LAYERS, surfaceCaption, enabledLayers }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';
import { SOURCES, cspDirectivesFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';

const MAIN = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
const DOC = readFileSync(new URL('../../content/quiet-corners-maps.md', import.meta.url), 'utf8');
const LEGEND = JSON.parse(readFileSync(new URL('./fixtures/nohrsc-snow-depth-legend-2026-10-20.min.json', import.meta.url), 'utf8'));
const BOX = { minLon: -111, minLat: 44, maxLon: -109, maxLat: 46 };

test('the source row is a modelled raster export from the NOHRSC MapServer on an origin already registered', () => {
  const s = SOURCES.nohrscSnowDepth;
  assert.ok(s, 'no nohrscSnowDepth source');
  assert.equal(s.kind, 'raster-image');
  assert.equal(s.origin, 'https://mapservices.weather.noaa.gov');
  assert.equal(s.origin, SOURCES.nwsRadar.origin);
  assert.equal(s.serviceUrl, 'https://mapservices.weather.noaa.gov/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer');
  assert.equal(SERVICE, s.serviceUrl);
  assert.equal(DEPTH_LAYER, 3);
  assert.equal(s.layers.depth, 3);
  assert.equal(s.claim, 'model');
  assert.equal(s.cors, 'reflects-origin');
  assert.equal(s.measuredOn, '2026-10-20');
  assert.equal(s.limits.serviceMaxImageSide, 4096);
  assert.equal(s.limits.exportTilesAllowed, false);
  assert.match(s.coverageSemantics, /modelled/i);
  assert.match(s.coverageSemantics, /drifts/);
  const csp = cspDirectivesFor();
  assert.ok(csp['connect-src'].includes(s.origin), 'the export is fetched, so connect-src carries the origin');
});

test('the export request shows layer 3 only, pins bboxSR and png32, and caps the size keeping aspect', () => {
  const r = snowDepthRequestFor({ bboxLonLat: BOX, width: 512, height: 512 });
  assert.equal(r.url, `${SERVICE}/export`);
  assert.equal(r.params.bbox, '-111,44,-109,46');
  assert.equal(r.params.bboxSR, '4326');
  assert.equal(r.params.imageSR, '3857');
  assert.equal(r.params.format, 'png32');
  assert.equal(r.params.transparent, 'true');
  assert.equal(r.params.layers, 'show:3', 'layer 7 is snow water equivalent and must not be drawn');
  assert.equal(r.params.f, 'image');
  const big = snowDepthRequestFor({ bboxLonLat: BOX, width: 4000, height: 2000 });
  assert.equal(big.width, MAX_IMAGE_SIDE);
  assert.equal(big.height, MAX_IMAGE_SIDE / 2);
});

test('a failed request is reported once and never retried automatically', async () => {
  let calls = 0;
  const { fetchImage } = createSnowDepthFetcher({ fetchImpl: async () => { calls += 1; return { ok: false, status: 503 }; } });
  const res = await fetchImage(snowDepthRequestFor({ bboxLonLat: BOX, width: 256, height: 256 }));
  assert.equal(res.status, 'error');
  assert.equal(calls, 1);
});

test('the legend bins match the live legend fixture, and no unit is claimed the service does not state', () => {
  assert.equal(LEGEND.layerId, 3);
  assert.equal(LEGEND.legend.length, 12);
  assert.deepEqual(LEGEND_BINS, LEGEND.legend.map((b) => b.label));
  assert.equal(LEGEND_BINS[0], '0 - 0.39');
  assert.equal(LEGEND_BINS[11], '394 - 787');
  const text = legendText();
  for (const label of LEGEND_BINS) assert.ok(text.includes(label), `legend text lacks ${label}`);
  assert.match(text, /units? (are |is )?not stated by the service/i);
  for (const s of readerStrings()) {
    assert.doesNotMatch(s, /\b(inch(es)?|millimet(re|er)s?|centimet(re|er)s?|mm|cm)\b/i, `unverified unit in: ${s}`);
  }
});

test('the label and caveat say modelled, daily, 1 km, may miss drifts, and that blank is zero or no data', () => {
  assert.equal(LAYER_LABEL, 'Snow depth (modelled)');
  assert.match(LAYER_CAVEAT, /modelled/i);
  assert.match(LAYER_CAVEAT, /not measured|not a measurement/i);
  assert.match(LAYER_CAVEAT, /daily/i);
  assert.match(LAYER_CAVEAT, /1 km/);
  assert.match(LAYER_CAVEAT, /drifts/);
  assert.match(LAYER_CAVEAT, /transparent|empty|blank/i);
  assert.match(LAYER_CAVEAT, /no data/i);
  assert.match(LAYER_CAVEAT, /cannot tell|can't tell|not distinguish/i);
});

test('the layer row is a screen-only, off-by-default raster surface in the context group', () => {
  const l = LAYER_BY_ID.snowDepthModel;
  assert.ok(l, 'no snowDepthModel layer');
  assert.equal(l.group, 'context');
  assert.equal(l.sourceId, 'nohrscSnowDepth');
  assert.equal(l.status, 'live');
  assert.equal(l.rasterSurface, true);
  assert.equal(l.screenOnly, true);
  assert.equal(l.defaultOn, false);
  assert.equal(l.emptyMeans, 'ambiguous');
  assert.equal(l.label, LAYER_LABEL);
  assert.equal(l.coverageCaveat, LAYER_CAVEAT);
  assert.ok(CONTEXT_LAYERS.some((x) => x.id === 'snowDepthModel'));
  assert.ok(!enabledLayers({ snowDepthModel: true }).some((x) => x.id === 'snowDepthModel'));
  assert.equal(surfaceCaption('snowDepthModel').claim, 'model');
});

test('the caption never shows a time for the snow depth picture: the service states none', () => {
  // NOHRSC states a refresh cadence (01, 05, 11, 17 UTC) but no valid time on the picture, so
  // the fetch time must not stand in for the data time.
  assert.match(surfaceCaption('snowDepthModel', { nowMs: Date.UTC(2026, 9, 20, 12) }).when, /time is unknown/);
  const table = MAIN.slice(MAIN.indexOf('const SURFACE_TIME = {'));
  assert.doesNotMatch(table.slice(0, table.indexOf('\n};')), /snowDepthModel\s*:/);
});

test('main.js builds the layer, switches it from its control and names its render function', () => {
  assert.match(MAIN, /createSnowDepthFetcher\(/);
  assert.match(MAIN, /layers\.snowDepthModel/);
  assert.match(MAIN, /snowDepthModel:\s*renderSnowDepth/);
  assert.match(MAIN, /qcm-layer-snowDepthModel-report/);
});

test('the product page carries the service URL and lists the surface among those 3D cannot drape', () => {
  assert.ok(DOC.includes(SERVICE), 'the page does not name the service URL');
  assert.match(DOC, /modelled snow depth/i);
});
