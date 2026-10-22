// S9, live radar — the picture half.
//
// The service has no tile cache, so every frame is an `exportImage` request this code
// composes by hand. That makes the request geometry the thing worth gating: a wrong
// bboxSR silently draws the right rain in the wrong place, and a size past the
// service's own ceiling is a 400 rather than a smaller picture.
//
// AGE is the other risk, and the reason this layer gets a switch only now. Every
// other surface on this map is durable -- a road is where it was last year, a 2016
// light composite is a 2016 light composite. Radar is a rolling window the service
// refills every few minutes, so a picture drawn without its own timestamp is the
// failure mode. `frameVintage()` is the only route a reader-facing string takes,
// and it is gated at fresh, stale and unknown.
//
// And WHAT IT MEANS: base reflectivity is an OBSERVATION of what the beam met
// aloft. The hourly card answers the hours ahead, so no string this layer can show
// may offer a forecast -- template literals included, because a backtick label is
// read exactly as a quoted one is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVICE, MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT, STALE_AFTER_MINUTES, LAYER_LABEL, CREDIT,
  radarRequestFor, radarImageUrl, radarLayer, frameVintage, fetchFrameTime, readerStrings,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-nws-radar.js';
import { SOURCES, cspDirectivesFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { LAYER_BY_ID } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';
import { readFileSync } from 'node:fs';

const VIEW = { minLon: -90, minLat: 43, maxLon: -88, maxLat: 45 };

test('the registry entry records what the service actually answered', () => {
  const s = SOURCES.nwsRadar;
  assert.equal(s.origin, 'https://mapservices.weather.noaa.gov');
  assert.equal(s.kind, 'raster-image', 'a whole-image export, the registry’s own word for it');
  assert.equal(s.limits.requiresKey, false);
  assert.equal(s.limits.maxImageWidth, 15000);
  assert.equal(s.limits.maxImageHeight, 4100);
  assert.equal(s.spatialReference.wkid, 3857, 'already Web Mercator: nothing is reprojected');
  assert.equal(s.cors, 'reflects-origin', 'the header echoed the request Origin on a real call');
  assert.equal(s.measuredOn, '2026-09-11');
});

// The overlay hands a URL to an <img>. connect-src does not cover that, so a radar
// origin present only there paints nothing and reports no error the map can see.
test('the radar origin reaches the CSP as an image source, not only a fetch target', () => {
  const csp = cspDirectivesFor();
  assert.ok(csp['img-src'].includes('https://mapservices.weather.noaa.gov'),
    'the overlay’s <img> would be blocked');
  assert.ok(csp['connect-src'].includes('https://mapservices.weather.noaa.gov'),
    'the service description is still fetched');
});

test('the export request asks for the view it is going to draw', () => {
  const req = radarRequestFor({ bboxLonLat: VIEW, width: 800, height: 600 });
  assert.equal(req.url, `${SERVICE}/exportImage`);
  assert.equal(req.params.bbox, '-90,43,-88,45');
  assert.equal(req.params.bboxSR, '4326', 'the bbox is longitude/latitude off the map');
  assert.equal(req.params.imageSR, '3857', 'the picture comes back in the map’s own projection');
  assert.equal(req.params.size, '800,600');
  assert.equal(req.params.transparent, 'true', 'an opaque frame would erase the map under it');
  assert.equal(req.params.format, 'png');
  assert.equal(req.params.f, 'image');
  assert.match(radarImageUrl(req), /^https:\/\/mapservices\.weather\.noaa\.gov\//);
});

test('a request never asks for more picture than the service will export', () => {
  const req = radarRequestFor({ bboxLonLat: VIEW, width: 99000, height: 99000 });
  assert.equal(req.width, MAX_IMAGE_WIDTH);
  assert.equal(req.height, MAX_IMAGE_HEIGHT);
  assert.equal(req.params.size, `${MAX_IMAGE_WIDTH},${MAX_IMAGE_HEIGHT}`);
  const tiny = radarRequestFor({ bboxLonLat: VIEW, width: 0, height: -5 });
  assert.equal(tiny.params.size, '1,1', 'a zero-sized export is a 400, not an empty picture');
});

test('the layer redraws for the view it is asked about', () => {
  const calls = { url: null, bounds: null };
  const L = {
    imageOverlay: (url, bounds, options) => ({
      url, bounds, options,
      setUrl(u) { calls.url = u; },
      setBounds(b) { calls.bounds = b; },
    }),
  };
  const layer = radarLayer(L);
  assert.equal(layer.options.interactive, false, 'the picture must not swallow a click on the map');
  assert.equal(layer.options.alt, '', 'a bitmap described as “radar” gives a screen reader nothing');
  layer.refresh({
    getBounds: () => ({ getWest: () => -90, getSouth: () => 43, getEast: () => -88, getNorth: () => 45 }),
    getSize: () => ({ x: 640, y: 480 }),
  });
  assert.ok(calls.bounds, 'the overlay has to be placed before it is painted');
  assert.match(calls.url, /bbox=-90%2C43%2C-88%2C45/);
  assert.match(calls.url, /size=640%2C480/);
});

test('the layer is offered on screen only, and off until it is asked for', () => {
  const l = LAYER_BY_ID.nwsRadar;
  assert.equal(l.sourceId, 'nwsRadar');
  assert.equal(l.screenOnly, true, 'a two-hour window has no business on a printed sheet');
  assert.equal(l.defaultOn, false);
});

test('every frame says how old it is, and an old one says it is too old', () => {
  const now = Date.UTC(2026, 8, 11, 14, 30, 0);
  const fresh = frameVintage(now - 3 * 60000, now);
  assert.equal(fresh.known, true);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.minutes, 3);
  assert.match(fresh.text, /14:27 UTC/, 'the frame’s own valid time, not the time it was drawn');
  assert.match(fresh.text, /3 minutes ago/);

  const old = frameVintage(now - 90 * 60000, now);
  assert.equal(old.stale, true);
  assert.match(old.text, /too old to act on/);

  const edge = frameVintage(now - STALE_AFTER_MINUTES * 60000, now);
  assert.equal(edge.stale, false, 'the threshold itself is still current, not stale');

  const unknown = frameVintage(null, now);
  assert.equal(unknown.known, false);
  assert.equal(unknown.stale, true, 'an unknown age is treated as unusable, never as fresh');
  assert.match(unknown.text, /did not say when this frame was taken/);
});

test('the frame time comes from the service, and a service that will not say loses nothing else', async () => {
  const asked = [];
  const ok = await fetchFrameTime({
    fetchImpl: async (u) => {
      asked.push(u);
      return { ok: true, json: async () => ({ timeInfo: { timeExtent: [1789130760000, 1789137853000] } }) };
    },
  });
  assert.equal(ok, 1789137853000, 'the END of the window is the frame on screen');
  assert.deepEqual(asked, [`${SERVICE}?f=json`]);

  assert.equal(await fetchFrameTime({ fetchImpl: async () => ({ ok: false, status: 503 }) }), null);
  assert.equal(await fetchFrameTime({ fetchImpl: async () => { throw new Error('offline'); } }), null,
    'a radar outage costs the layer its age, never the map');
});

/** The prohibition, gated rather than commented. */
const FORBIDDEN = [/\bforecast/i, /\bwill rain/i, /\bexpect(ed)?\b/i];

test('nothing this layer can show a reader offers a forecast', () => {
  for (const line of readerStrings()) {
    for (const pattern of FORBIDDEN) {
      assert.ok(!pattern.test(line), `${pattern} matches a reader-facing string: ${line}`);
    }
  }
});

test('no string literal in the module promises a forecast either', () => {
  const src = readFileSync(
    new URL('../../themes/headlessmode/static/js/quiet-corners-maps/source-nws-radar.js', import.meta.url),
    'utf8');
  // Comments may name the prohibition; strings may not.
  const withoutComments = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, ' ');
  const literals = [...withoutComments.matchAll(/'([^'\\]*)'|`([^`\\$]*)`/g)].map((m) => m[1] ?? m[2] ?? '');
  for (const lit of literals) {
    assert.ok(!/\bforecast/i.test(lit), `a string literal offers a forecast: ${lit}`);
  }
  assert.ok(LAYER_LABEL.includes('live'), 'the label has to say the picture is a live one');
  assert.ok(CREDIT.includes('NOAA'), 'the source is credited where a reader can see it');
});

test('the app writes the frame age into the layer row, and clears it when switched off', () => {
  const main = readFileSync(
    new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
  assert.match(main, /frameVintage\(/, 'nothing turns a frame time into words for the reader');
  assert.match(main, /qcm-layer-nwsRadar-report/, 'the age has nowhere to be read');
  assert.match(main, /map\.on\('moveend zoomend', renderRadar\)/,
    'an exported image must be re-requested on pan, not only on zoom');
});
