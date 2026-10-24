// The terrain slope/aspect surface: unit 1F.
//
// Five things are load-bearing here and each has a measurement behind it, made
// 2026-09-15 against the service with an `Origin: https://headlessmode.com` header:
//
//   1. `bboxSR` is NOT optional. Omit it and ArcGIS reads a lon/lat bbox as Web Mercator
//      METRES, landing every US extent in a sub-metre patch off West Africa and answering
//      all of them with the same 1,897-byte empty picture. That is the whole of the
//      2026-09-06 "3DEP exportImage did not vary per extent" finding: a caller bug, not a
//      broken service. Two distinct hashes with bboxSR=4326, the identical
//      569c47e0f6bc0653 twice without it.
//   2. Slope is DEGREES. `Slope Degrees` is uint8 whole degrees 0-90; percent rise is
//      tan(degrees) x 100 and roughly doubles the number. The service labels no unit
//      anywhere -- its own metadata description of `Slope Degrees` is copied from
//      `Slope Map` and is wrong -- so every number this site shows carries its own unit.
//   3. `format=png32` is the only export that can tell NO COVERAGE from FLAT. png, png8
//      and png24 all come back as PNG colour-type 0 (greyscale, no alpha, no tRNS), and
//      the requested `noData=-1` sentinel cannot survive a uint8 channel: the open
//      Atlantic answers 4,096 pixels of 0, the same value as flat ground. png32 answers
//      RGBA with R=G=B=the degree count and ALPHA 0 where there is no data -- measured
//      (0,0,0,0) over every ocean pixel and 255 over every Smokies pixel.
//   4. Flat is read off the SLOPE surface, never the aspect surface. There is no -1 flat
//      marker in `Aspect Degrees`: over the Bonneville extent 20% of pixels read exactly
//      0 and 99% of those have slope 0, so flat collapses onto due north. `identify` at
//      -113.85,40.77 returned slope 0 AND aspect 0; at -83.49,35.57 slope 34, aspect 328.
//   5. `identify` states missing data as the STRING "NoData" -- not 0, not -1. Measured
//      over the open Atlantic on both rendering rules.
//
// And the two things this layer must never be read as saying: that anywhere is safe to
// travel, or that it knows where the sun falls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVICE, CREDIT, LAYER_LABEL, LAYER_CAVEAT, MAX_IMAGE_SIDE, POINT_CELL_METRES,
  SLOPE_BREAKS, slopeRequestFor, slopeImageUrl, pointRequestFor, readPointValue,
  percentFor, degreesFor, slopeText, bearingWords, terrainReading, paintSlope,
  legendRows, readerStrings, terrainSlopeLayer,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-terrain-surface.js';
import { SOURCES, cspDirectivesFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { LAYER_BY_ID, CONTEXT_LAYER_IDS } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';

const SMOKIES = { minLon: -83.55, minLat: 35.53, maxLon: -83.45, maxLat: 35.63 };
const BONNEVILLE = { minLon: -113.90, minLat: 40.72, maxLon: -113.80, maxLat: 40.82 };

const paramsFor = (bbox, width = 512, height = 512) =>
  slopeRequestFor({ bboxLonLat: bbox, width, height }).params;
const bandFor = (d) => SLOPE_BREAKS.find((b) => d >= b.from && (b.to === null || d < b.to));
const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// --- 1. the caller bug that was recorded against the service -------------------

test('every export pins bboxSR=4326, and two extents ask two different questions', () => {
  const smokies = paramsFor(SMOKIES);
  const bonneville = paramsFor(BONNEVILLE);
  assert.equal(smokies.bboxSR, '4326',
    'without bboxSR ArcGIS reads a lon/lat bbox as Web Mercator metres and every US extent '
    + 'returns the same empty picture — the 2026-09-06 blocker, which was this parameter');
  assert.equal(smokies.imageSR, '3857');
  assert.equal(smokies.bbox, '-83.55,35.53,-83.45,35.63');
  assert.notEqual(smokies.bbox, bonneville.bbox, 'two extents must not collapse to one request');
  assert.notEqual(slopeImageUrl({ bboxLonLat: SMOKIES, width: 512, height: 512 }),
    slopeImageUrl({ bboxLonLat: BONNEVILLE, width: 512, height: 512 }));
  assert.ok(slopeImageUrl({ bboxLonLat: SMOKIES, width: 512, height: 512 }).startsWith(`${SERVICE}/exportImage?`));
});

// --- 3. the only export that can say "no coverage" -----------------------------

test('the export asks for png32 and a nodata sentinel, and clamps its own size', () => {
  const p = paramsFor(SMOKIES);
  assert.equal(p.format, 'png32',
    'png, png8 and png24 all answer greyscale with no alpha, so no-coverage and flat become '
    + 'the same pixel; png32 carries coverage in the alpha channel');
  assert.equal(p.noData, '-1');
  assert.equal(p.noDataInterpretation, 'esriNoDataMatchAny');
  assert.equal(p.renderingRule, JSON.stringify({ rasterFunction: 'Slope Degrees' }),
    'the NUMERIC surface — the service publishes no legend or class breaks for its own colours');
  assert.equal(p.f, 'image');
  // A 4K window would ask for a 633,888-byte export at 1024 square; the cap is measured,
  // not guessed — 512 square answered 185,910 bytes over the steepest extent probed.
  const big = slopeRequestFor({ bboxLonLat: SMOKIES, width: 4000, height: 2400 });
  assert.equal(big.width, MAX_IMAGE_SIDE);
  assert.ok(big.height <= MAX_IMAGE_SIDE);
  assert.equal(big.params.size, `${big.width},${big.height}`);
  assert.ok(MAX_IMAGE_SIDE <= SOURCES.usgs3depSurface.limits.serviceMaxImageSide);
  const tiny = slopeRequestFor({ bboxLonLat: SMOKIES, width: 0, height: -3 });
  assert.equal(tiny.width, 1, 'a zero-width map must still ask a legal question');
  assert.equal(tiny.height, 1);
});

test('paintSlope reads degrees out of the red channel and coverage out of alpha', () => {
  // Four pixels: no coverage, flat, a gentle slope, a cliff — as the service encodes them.
  const px = new Uint8ClampedArray([
    0, 0, 0, 0, // ocean: measured (0,0,0,0) over every pixel of an Atlantic extent
    0, 0, 0, 255, // flat ground: a real zero, opaque
    8, 8, 8, 255,
    46, 46, 46, 255,
  ]);
  const out = paintSlope(px);
  assert.equal(out.missing, 1);
  assert.equal(out.covered, 3);
  assert.equal(px[3], 0, 'ground the model does not reach must stay fully transparent');
  assert.ok(px[7] > 0, 'flat ground is covered ground and must be drawn, not dropped');
  const flat = [px[4], px[5], px[6]];
  const gentle = [px[8], px[9], px[10]];
  const cliff = [px[12], px[13], px[14]];
  assert.notDeepEqual(flat, gentle, 'flat and gentle must not share an ink');
  assert.notDeepEqual(gentle, cliff);
  // The site's own ramp, so the legend is true by construction rather than by trusting
  // colours the service publishes no breaks for.
  assert.deepEqual(gentle, [...hexRgb(bandFor(8).color)]);
  assert.deepEqual(cliff, [...hexRgb(bandFor(46).color)]);
});

test('the legend is the same table the painter uses, in degrees and percent together', () => {
  const rows = legendRows();
  assert.equal(rows.length, SLOPE_BREAKS.length);
  assert.deepEqual(rows.map((r) => r.color), SLOPE_BREAKS.map((b) => b.color));
  // Every row states its unit twice over: a bare number here is the confusion the whole
  // layer is built to avoid, because percent rise is a different number for the same tilt.
  for (const row of rows) {
    assert.match(row.label, /°/, `${row.label} states no degree unit`);
    assert.match(row.label, /%/, `${row.label} does not give the percent equivalent`);
  }
  // Contiguous and open-ended at the top: 90° must land somewhere.
  assert.equal(SLOPE_BREAKS[0].from, 0);
  assert.equal(SLOPE_BREAKS[SLOPE_BREAKS.length - 1].to, null);
  for (let i = 1; i < SLOPE_BREAKS.length; i++) assert.equal(SLOPE_BREAKS[i].from, SLOPE_BREAKS[i - 1].to);
  assert.ok(bandFor(90), '90 degrees must fall in a band');
});

// --- 2. degrees and percent are never interchangeable --------------------------

test('percent rise is tan(degrees) x 100, and every number carries the unit it is in', () => {
  assert.ok(Math.abs(percentFor(45) - 100) < 1e-9, '45 degrees is a 100 per cent rise');
  assert.equal(percentFor(0), 0);
  assert.ok(Math.abs(percentFor(34) - Math.tan(34 * Math.PI / 180) * 100) < 1e-9);
  // Measured on the service's own custom function: SlopeType 1 -> 32.6432, SlopeType 2 ->
  // 64.059, and tan(32.6432°) x 100 = 64.0590. The two units are the same tilt, never the
  // same number, so reading one as the other roughly doubles or halves the answer.
  assert.ok(Math.abs(percentFor(32.6432) - 64.059) < 0.001);
  assert.ok(Math.abs(degreesFor(64.059) - 32.6432) < 0.001);
  assert.notEqual(percentFor(27), 27);
  assert.ok(Math.abs(degreesFor(27) - 15.1096) < 0.001, '27% read as 27° is a different hillside');
  // The one place a slope becomes words.
  assert.match(slopeText(34), /34°/);
  assert.match(slopeText(34), /67% rise/);
  assert.match(slopeText(0), /0°/);
  // The publisher's credit is exempt: "3D Elevation Program" is a programme name, not a
  // measurement. Every other reader-facing string states a quantity and must carry its unit.
  for (const text of readerStrings().filter((t) => t !== CREDIT)) {
    // A digit with neither ° nor % nor a plain-word unit beside it is the failure mode.
    for (const m of text.matchAll(/(\d+(?:\.\d+)?)(.{0,14})/g)) {
      assert.ok(/[°%]|metre|degree|per cent|percent/.test(m[2]) || /^(?:19|20)\d\d$/.test(m[1]),
        `"${m[0]}" states a bare number in: ${text}`);
    }
  }
});

// --- 4 and 5. flat, north, and no data are three different answers -------------

test('identify states missing data as the string NoData, which is not zero', () => {
  assert.deepEqual(readPointValue({ value: '34' }), { known: true, noData: false, value: 34 });
  assert.deepEqual(readPointValue({ value: '0' }), { known: true, noData: false, value: 0 });
  assert.deepEqual(readPointValue({ value: 'NoData' }), { known: false, noData: true, value: null });
  assert.deepEqual(readPointValue(null), { known: false, noData: false, value: null });
  assert.deepEqual(readPointValue({ error: { code: 400 } }), { known: false, noData: false, value: null });
  const req = pointRequestFor({ lon: -83.49, lat: 35.57 }, 'aspect');
  assert.equal(req.url, `${SERVICE}/identify`);
  assert.equal(req.params.renderingRule, JSON.stringify({ rasterFunction: 'Aspect Degrees' }));
  assert.equal(req.params.geometry, JSON.stringify({ x: -83.49, y: 35.57, spatialReference: { wkid: 4326 } }));
  // Slope moved 32.64° -> 39.63° -> 27.25° for one point as the requested cell went 1 m ->
  // 3 m -> 270 m. A point read that does not pin a cell cannot agree with anything.
  assert.equal(req.params.pixelSize, `${POINT_CELL_METRES},${POINT_CELL_METRES}`);
  assert.equal(pointRequestFor({ lon: -83.49, lat: 35.57 }, 'slope').params.renderingRule,
    JSON.stringify({ rasterFunction: 'Slope Degrees' }));
});

test('a bearing comes off the slope surface being non-zero, never off aspect alone', () => {
  const steep = terrainReading({ slope: { value: 34, known: true, noData: false },
    aspect: { value: 328, known: true, noData: false } });
  assert.equal(steep.covered, true);
  assert.equal(steep.flat, false);
  assert.equal(steep.bearing, 'northwest');
  assert.match(steep.text, /34°/);
  assert.match(steep.text, /northwest/);

  // THE measurement: at Bonneville, slope 0 and aspect 0. Aspect alone would read that as
  // due north — 20% of that extent does — and it is flat ground with no facing at all.
  const flat = terrainReading({ slope: { value: 0, known: true, noData: false },
    aspect: { value: 0, known: true, noData: false } });
  assert.equal(flat.flat, true);
  assert.equal(flat.bearing, null, 'flat ground has no facing direction and must not be given one');
  assert.doesNotMatch(flat.text, /north/i, 'flat must never be reported as due north');
  assert.match(flat.text, /flat/i);
  // And the slope surface wins even when aspect names a real-looking bearing.
  const alsoFlat = terrainReading({ slope: { value: 0, known: true, noData: false },
    aspect: { value: 200, known: true, noData: false } });
  assert.equal(alsoFlat.bearing, null);

  // No coverage is its own answer, and it is not flat and not north.
  const gone = terrainReading({ slope: { value: null, known: false, noData: true },
    aspect: { value: null, known: false, noData: true } });
  assert.equal(gone.covered, false);
  assert.equal(gone.flat, false);
  assert.equal(gone.bearing, null);
  assert.match(gone.text, /no elevation/i);
  assert.doesNotMatch(gone.text, /\b0°/, 'missing data must never be reported as zero slope');

  // A service that answered nothing at all is unknown, not zero and not uncovered.
  const silent = terrainReading({ slope: { value: null, known: false, noData: false },
    aspect: { value: null, known: false, noData: false } });
  assert.match(silent.text, /unknown|did not/i);
  assert.equal(silent.bearing, null);

  // A real north-facing hillside keeps its bearing: the flat rule must not eat it.
  const north = terrainReading({ slope: { value: 12, known: true, noData: false },
    aspect: { value: 0, known: true, noData: false } });
  assert.equal(north.bearing, 'north');
  assert.deepEqual([0, 45, 90, 135, 180, 225, 270, 315, 359].map(bearingWords),
    ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'north']);
});

// --- what the layer must never be read as saying -------------------------------

test('nothing this layer says implies a route is safe or that it knows the light', () => {
  // Not "the word never appears" — the layer's whole job is to DENY these, out loud. The
  // rule is that any sentence reaching for one has to be denying it: a clause saying a
  // slope is safe, passable, or tells you when the sun hits is a claim off a bare-earth
  // arithmetic surface averaged over tens of metres, and there is nothing behind it.
  const RISKY = /\b(safe|safely|passable|impassable|easy|recommend\w*|sunrise|sunset|shadow|shade|sunlit)\b/i;
  const DENIAL = /\b(not|never|no|nothing|nor|without|whether|neither|rather than)\b/i;
  for (const text of readerStrings()) {
    for (const sentence of text.split(/(?<=[.;:—])\s+/)) {
      if (!RISKY.test(sentence)) continue;
      assert.match(sentence, DENIAL,
        `this sentence claims something the layer cannot know: "${sentence}"`);
    }
  }
  // And says so out loud rather than leaving it to be inferred.
  assert.match(LAYER_CAVEAT, /not a (judgement|statement) about|never a route|not a route/i);
  assert.match(LAYER_CAVEAT, /shade|sun/i);
  assert.match(LAYER_CAVEAT, /bare earth/i);
  assert.match(LAYER_CAVEAT, /degrees/i);
  assert.match(LAYER_CAVEAT, /flat/i);
  assert.ok(LAYER_LABEL.length && CREDIT.includes('3D Elevation Program'));
});

// --- the registry contract, and the CSP bill ----------------------------------

test('the surface is its own measured source, and it costs the CSP nothing', () => {
  const src = SOURCES.usgs3depSurface;
  assert.ok(src, 'the display surface is a source of its own, not a second endpoint on usgs3dep');
  assert.equal(src.kind, 'raster-image');
  // Arithmetic over a measured elevation model: deterministic, same input same answer,
  // reproduced from the service's own elevation grid to within 0.3%.
  assert.equal(src.claim, 'calculation');
  assert.equal(src.origin, SOURCES.usgs3dep.origin, 'the origin is already in connect-src');
  assert.equal(src.paintedAs, undefined,
    'handing the URL to an <img> would put this host in img-src and cost 26 characters; '
    + 'the bytes are fetched and painted from a canvas instead');
  const csp = cspDirectivesFor();
  assert.ok(csp['connect-src'].includes(src.origin));
  assert.ok(!csp['img-src'].includes(src.origin), 'this layer must not reach img-src');
  assert.match(src.coverageSemantics, /DEGREES/);
  assert.match(src.coverageSemantics, /UNDEFINED on flat ground|flat/);
  assert.match(src.coverageSemantics, /bare earth/);
  assert.match(src.coverageSemantics, /no legend/);

  // And the wrong sentence the 2026-09-06 caller bug left behind is gone: NAIP's entry
  // blamed 3DEP for returning identical imagery per extent. That was a missing bboxSR.
  assert.doesNotMatch(SOURCES.usdaNaip.coverageSemantics, /3DEP/,
    'the NAIP entry blamed 3DEP for a caller bug; the bug was an omitted bboxSR');
});

test('the layer is one of the context surfaces, screen only, and says what nothing back means', () => {
  const l = LAYER_BY_ID.terrainSlope;
  assert.ok(l, 'the slope surface has no layer entry, so no reader can reach it');
  assert.equal(l.group, 'context', 'a view-filling raster belongs in the one-at-a-time group');
  assert.ok(CONTEXT_LAYER_IDS.includes('terrainSlope'));
  assert.equal(l.sourceId, 'usgs3depSurface');
  assert.equal(l.screenOnly, true, 'a live render has no business on a printed sheet');
  assert.equal(l.rasterSurface, true, 'it fills the view, so the surface budget must count it');
  assert.equal(l.defaultOn, false);
  // Alpha 0 is a readable answer: the model does not reach here. Not "flat", not "none".
  assert.equal(l.emptyMeans, 'none');
  assert.equal(l.coverageCaveat, LAYER_CAVEAT);
  assert.equal(l.label, LAYER_LABEL);
});

// --- an answer that lands after the reader moved on stays unreported -----------------------------

// A layer wired to fakes, with the decode held open so a test can act between "the bytes arrived"
// and "the picture decoded". `decodes` holds one deferred per createImageBitmap call.
function layerWithHeldDecode() {
  const calls = { setUrl: [], setBounds: 0 };
  const L = { imageOverlay: () => ({
    setBounds() { calls.setBounds += 1; },
    setUrl(u) { calls.setUrl.push(u); },
  }) };
  const doc = { createElement: () => ({
    width: 0, height: 0,
    getContext: () => ({
      drawImage() {},
      getImageData: () => ({ data: new Uint8ClampedArray([40, 40, 40, 255]) }),
      putImageData() {},
    }),
    toDataURL: () => 'data:image/png;base64,AAAA',
  }) };
  const fetchImpl = async () => ({ ok: true, status: 200, blob: async () => ({ size: 4 }) });
  const decodes = [];
  const prior = globalThis.createImageBitmap;
  globalThis.createImageBitmap = () => new Promise((resolve, reject) => { decodes.push({ resolve, reject }); });
  const layer = terrainSlopeLayer(L, { documentRef: doc, fetchImpl });
  const map = {
    getBounds: () => ({ getWest: () => -83.55, getSouth: () => 35.53, getEast: () => -83.45, getNorth: () => 35.63 }),
    getSize: () => ({ x: 256, y: 256 }),
  };
  const restore = () => { globalThis.createImageBitmap = prior; };
  const untilDecodes = async (n) => { for (let i = 0; i < 50 && decodes.length < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };
  return { layer, map, calls, decodes, restore, untilDecodes };
}

test('a decode that fails after the layer was switched off reports nothing', async () => {
  const h = layerWithHeldDecode();
  try {
    const reports = [];
    const pending = h.layer.refresh(h.map, (c) => reports.push(c));
    await h.untilDecodes(1);
    assert.equal(h.decodes.length, 1, 'the ask reached its decode');
    h.layer.cancel();                                   // what main.js renderTerrain does when the switch goes off
    h.decodes[0].reject(new Error('cannot decode'));
    assert.equal(await pending, null);
    assert.deepEqual(reports, [], 'a late failure would re-add the layer and un-hide the row while the switch is off');
  } finally { h.restore(); }
});

test('a decode that succeeds after the layer was switched off reports and draws nothing', async () => {
  const h = layerWithHeldDecode();
  try {
    const reports = [];
    const pending = h.layer.refresh(h.map, (c) => reports.push(c));
    await h.untilDecodes(1);
    h.layer.cancel();
    h.decodes[0].resolve({ width: 1, height: 1 });
    assert.equal(await pending, null);
    assert.deepEqual(reports, [], 'a late success would re-add the layer and un-hide the row while the switch is off');
    assert.deepEqual(h.calls.setUrl, [], 'and would paint a picture onto a layer that is off');
  } finally { h.restore(); }
});

test('a decode for a view the reader left does not report or draw over the newer ask', async () => {
  const h = layerWithHeldDecode();
  try {
    const first = [];
    const second = [];
    const p1 = h.layer.refresh(h.map, (c) => first.push(c));
    await h.untilDecodes(1);
    const p2 = h.layer.refresh(h.map, (c) => second.push(c));
    await h.untilDecodes(2);
    h.decodes[0].resolve({ width: 1, height: 1 });
    assert.equal(await p1, null);
    assert.deepEqual(first, [], 'the superseded ask is silent');
    assert.deepEqual(h.calls.setUrl, [], 'and draws nothing');
    h.decodes[1].resolve({ width: 1, height: 1 });
    const got = await p2;
    assert.deepEqual(second, [got], 'the newer ask reports once');
    assert.equal(h.calls.setUrl.length, 1);
  } finally { h.restore(); }
});

test('an ask nobody interrupted still reports once, on success and on a failed decode', async () => {
  const h = layerWithHeldDecode();
  try {
    const ok = [];
    const p1 = h.layer.refresh(h.map, (c) => ok.push(c));
    await h.untilDecodes(1);
    h.decodes[0].resolve({ width: 1, height: 1 });
    await p1;
    assert.equal(ok.length, 1);
    assert.ok(ok[0] && ok[0].covered === 1, 'the counts, not the failure');
    const bad = [];
    const p2 = h.layer.refresh(h.map, (c) => bad.push(c));
    await h.untilDecodes(2);
    h.decodes[1].reject(new Error('cannot decode'));
    await p2;
    assert.deepEqual(bad, [null], 'a failed decode of the current view is the failed answer');
  } finally { h.restore(); }
});
