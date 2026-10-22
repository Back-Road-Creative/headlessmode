// NLCD land cover and tree canopy: unit 1D.
//
// Every number here comes from the qualification measured 2026-09-15 against
// imagery.geoplatform.gov with an `Origin: https://headlessmode.com` header. Six facts are
// load-bearing and each one is a test below.
//
//   1. MRLC's own www.mrlc.gov answered NONE of 33 probes over 19 minutes (TLS completed,
//      no HTTP response) while api.weather.gov and basemap.nationalmap.gov answered 200
//      from the same shell. The plan's endpoint is dark; the USDA Forest Service IIPP
//      mirror is the only measured route, and it is a different publisher's host.
//   2. THE YEAR MUST BE PINNED ON EVERY REQUEST. The default mosaic silently answers the
//      newest year, and an unpinned `identify` costs 155,647 bytes because
//      `returnCatalogItems` defaults on and each of 40 items carries a full CONUS ring.
//      Pinned it is 4,250. So a request that cannot be built without a valid year is the
//      fix, not a rule someone has to remember.
//   3. `returnCatalogItems=false` reaches 217 bytes and DESTROYS the discriminator: Paris
//      and the Gulf of Mexico then come back identical. It must stay on.
//   4. THREE missingness states, none of them visible in the picture: outside coverage is
//      NoData with catalogItems.features length 0; genuine no-data inside coverage is
//      NoData with length 1; an error is HTTP **200** carrying an `{"error":{...}}` body.
//      Paris and the Gulf return byte-identical PNGs, so the image can never answer this.
//   5. THE CLASS CODES ARE PUBLISHED NOWHERE -- `rasterAttributeTable` is `{}`. The table
//      was recovered by pairing 65,536 raw-vs-rendered pixels 1:1 and corroborated by
//      computeHistograms over 100,000,000. Code 12 did not occur in the test extent and is
//      carried as UNVERIFIED rather than as known.
//   6. LAND COVER IS CONUS ONLY. There is no NLCD land-cover service for Alaska, Hawaii or
//      the territories in this catalogue, so they must read as outside coverage and never
//      as unclassified ground.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRODUCT_IDS, productOf, LAND_COVER_CLASSES, CONUS_EXTENT_3857, MAX_IMAGE_SIDE,
  mosaicRuleFor, surfaceRequestFor, surfaceImageUrl, pointRequestFor, pointUrl,
  readPointAnswer, viewCoverage, coverageText, legendRows, yearLine, readerStrings,
  LAND_COVER_LABEL, LAND_COVER_CAVEAT, CANOPY_LABEL, CANOPY_CAVEAT, FETCH_OPTIONS,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-land-cover.js';
import { SOURCES, cspDirectivesFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { LAYER_BY_ID, CONTEXT_LAYER_IDS, surfaceCaption } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';

const DRIFTLESS = { minLon: -90.45, minLat: 43.65, maxLon: -90.35, maxLat: 43.75 };
const PARIS = { minLon: 2.30, minLat: 48.80, maxLon: 2.40, maxLat: 48.90 };
const DENALI = { minLon: -151.05, minLat: 63.05, maxLon: -150.95, maxLat: 63.15 };
const HALEAKALA = { minLon: -156.30, minLat: 20.65, maxLon: -156.20, maxLat: 20.75 };

const exportParams = (product, year) =>
  surfaceRequestFor({ product, bboxLonLat: DRIFTLESS, width: 900, height: 700, year }).params;

// --- 2 & 3. the year is pinned by construction, and the catalogue stays on ------

test('no request can be built without a year the product actually holds', () => {
  // The mosaic holds 40 land-cover rasters 1985-2024 and 41 canopy rasters 1985-2025.
  // Land cover stops at 2024: only canopy reaches 2025.
  assert.throws(() => mosaicRuleFor('landCover', 1984), RangeError);
  assert.throws(() => mosaicRuleFor('landCover', 2025), RangeError,
    'the land-cover mosaic stops at 2024 — 2025 exists for canopy only');
  assert.throws(() => mosaicRuleFor('canopy', 2026), RangeError);
  assert.throws(() => mosaicRuleFor('landCover', 'newest'), RangeError);
  assert.throws(() => mosaicRuleFor('landCover', null), RangeError);
  assert.doesNotThrow(() => mosaicRuleFor('landCover', 2024));
  assert.doesNotThrow(() => mosaicRuleFor('canopy', 2025));
  assert.equal(JSON.parse(mosaicRuleFor('landCover', 2001)).mosaicMethod, 'esriMosaicAttribute');
  assert.equal(JSON.parse(mosaicRuleFor('landCover', 2001)).where, 'beginyear=2001');
});

test('every export and every point read carries the pinned year, and the catalogue stays on', () => {
  for (const product of PRODUCT_IDS) {
    const src = productOf(product);
    const year = src.time.defaultObserved;
    const img = exportParams(product, year);
    const pt = pointRequestFor({ product, lon: -90.40, lat: 43.70, year }).params;
    for (const [where, params] of [['export', img], ['identify', pt]]) {
      assert.ok(params.mosaicRule,
        `${product} ${where} sends no mosaicRule — the service would answer the newest year and say nothing`);
      assert.equal(JSON.parse(params.mosaicRule).where, `beginyear=${year}`, `${product} ${where}`);
    }
    // 4,250 bytes pinned against 155,647 unpinned is a 36x difference, and it is the
    // catalogue items that carry it — the same items the coverage answer is read from.
    assert.equal(pt.returnCatalogItems, 'true',
      `${product}: returnCatalogItems=false reaches 217 bytes and makes Paris and the Gulf identical`);
    assert.equal(pt.returnGeometry, 'false');
  }
  // Two years are two different questions, not one cached answer.
  assert.notEqual(exportParams('landCover', 1985).mosaicRule, exportParams('landCover', 2024).mosaicRule);
});

// --- 4. three missingness states, read from the body and never from the status ---

test('outside coverage, genuine no-data and a service error are three separate answers', () => {
  // Paris: 347 bytes, value NoData, ZERO catalog items — the mosaic holds nothing here.
  const outside = readPointAnswer({ value: 'NoData', catalogItems: { features: [] } }, 'landCover', 2024);
  // Gulf of Mexico: 4,250 bytes, value NoData, the pinned raster IS in the catalogue —
  // inside the country, and genuinely unclassified.
  const noData = readPointAnswer(
    { value: 'NoData', catalogItems: { features: [{ attributes: { beginyear: 2024 } }] } }, 'landCover', 2024);
  // HTTP 200 with an error body. `res.ok` is true on every one of these.
  const failed = readPointAnswer({ error: { code: 400, message: 'Unable to complete operation.' } }, 'landCover', 2024);
  const value = readPointAnswer(
    { value: '41', catalogItems: { features: [{ attributes: { beginyear: 2024 } }] } }, 'landCover', 2024);

  assert.equal(outside.state, 'outsideCoverage');
  assert.equal(noData.state, 'noData');
  assert.equal(failed.state, 'error');
  assert.equal(value.state, 'value');
  assert.equal(new Set([outside, noData, failed, value].map((a) => a.text)).size, 4,
    'the four answers must not collapse into one sentence — the picture already cannot tell them apart');
  assert.match(outside.text, /outside|does not (reach|cover)/i);
  assert.doesNotMatch(outside.text, /unclassified/i,
    'Alaska is not unclassified ground; it is ground this service never mapped');
  assert.equal(value.label, 'Deciduous Forest');

  // The trap: a missing service answers 200 with {"error":{"code":404}}. A client that
  // tested res.ok would read that as data.
  assert.equal(readPointAnswer({ error: { code: 404, message: 'HTTP 404 Not Found' } }, 'landCover', 2024).state, 'error');
  // And nothing at all — a fetch that threw — is still not "no data here".
  assert.equal(readPointAnswer(null, 'landCover', 2024).state, 'error');
});

// --- 5. the recovered class table, with its one unverified row ------------------

test('land cover reads the measured class table, and code 12 is carried as unverified', () => {
  assert.equal(Object.keys(LAND_COVER_CLASSES).length, 16);
  for (const [code, cls] of Object.entries(LAND_COVER_CLASSES)) {
    assert.match(cls.color, /^#[0-9A-F]{6}$/, `${code} colour`);
    assert.ok(cls.label.length > 2, `${code} label`);
  }
  // Four of these were confirmed both ways round: identify for the raw code and a
  // 1x1-pixel export for the rendered colour.
  assert.equal(LAND_COVER_CLASSES[41].label, 'Deciduous Forest');
  assert.equal(LAND_COVER_CLASSES[41].color, '#68AB5F');
  assert.equal(LAND_COVER_CLASSES[23].color, '#EB0000');
  assert.equal(LAND_COVER_CLASSES[95].label, 'Emergent Herbaceous Wetlands');
  // 15 of 16 were paired pixel-for-pixel over 65,536 pixels with zero unmatched.
  assert.equal(Object.values(LAND_COVER_CLASSES).filter((c) => c.verified).length, 15);
  // Perennial Ice/Snow does not occur in the Wisconsin test extent. Its COLOUR is measured
  // off the legend swatch; the number 12 comes from the legend's ORDER.
  assert.equal(LAND_COVER_CLASSES[12].verified, false);
  assert.match(LAND_COVER_CLASSES[12].note, /legend|not measured|unverified/i);
  const iceRow = legendRows('landCover').find((r) => r.code === 12);
  assert.match(iceRow.label, /unverified|not measured/i,
    'the one code the site guessed must say so where a reader can see it');
  assert.equal(legendRows('landCover').filter((r) => /unverified|not measured/i.test(r.label)).length, 1,
    'exactly one row is unverified — flagging more would be as dishonest as flagging none');
});

// --- canopy: percent, and two values that are not percentages -------------------

test('canopy is a percentage, and 254 and 255 are never read as one', () => {
  const pct = readPointAnswer({ value: '77', catalogItems: { features: [{}] } }, 'canopy', 2025);
  assert.equal(pct.state, 'value');
  assert.equal(pct.percent, 77);
  assert.match(pct.text, /77%/, 'a canopy number without its unit is a different claim');
  assert.equal(readPointAnswer({ value: '0', catalogItems: { features: [{}] } }, 'canopy', 2025).percent, 0,
    '0% canopy is a measured answer — NW Las Vegas — not a missing one');
  // "The non-processing area is represented by value 254, and the background is
  // represented by the value 255" — the service's own description.
  for (const sentinel of [254, 255]) {
    const a = readPointAnswer({ value: String(sentinel), catalogItems: { features: [{}] } }, 'canopy', 2025);
    assert.notEqual(a.state, 'value', `${sentinel} is not a percentage and must never be averaged or ramped`);
    assert.equal(a.percent, null);
    assert.doesNotMatch(a.text, /254%|255%/);
  }
  // The canopy legend states the sentinels rather than colouring them in with the ramp.
  const canopyKey = legendRows('canopy').map((r) => r.label).join(' ');
  assert.match(canopyKey, /254/);
  assert.match(canopyKey, /255/);
  assert.match(canopyKey, /not a percentage|not percentages/i);
});

// --- 6 & bounded requests ------------------------------------------------------

test('an export is bounded and transparent, so ground that was never classified is left undrawn', () => {
  const p = exportParams('landCover', 2024);
  assert.equal(p.bboxSR, '4326', 'a lon/lat bbox against a Web Mercator service must declare its own SR');
  assert.equal(p.imageSR, '3857');
  assert.equal(p.format, 'png32');
  // With the default `png` and no transparent=true an out-of-coverage export is opaque
  // #000000 across all 65,536 pixels — the tRNS chunk keys transparency to RGB(253,253,253),
  // not black — and paints a black rectangle over the basemap.
  assert.equal(p.transparent, 'true');
  assert.equal(p.f, 'image', 'f=json answers an href to a generated file, which is an extra round trip');
  // The service accepted a deliberate 5,000 x 5,000 request, so it will not protect the
  // app from itself.
  const huge = surfaceRequestFor({ product: 'landCover', bboxLonLat: DRIFTLESS, width: 5000, height: 4000, year: 2024 });
  assert.equal(huge.params.size, `${MAX_IMAGE_SIDE},${MAX_IMAGE_SIDE}`);
  assert.ok(MAX_IMAGE_SIDE <= 512);
  assert.ok(surfaceImageUrl(huge).startsWith(`${productOf('landCover').serviceUrl}/exportImage?`));
  assert.ok(pointUrl(pointRequestFor({ product: 'canopy', lon: -90.4, lat: 43.7, year: 2025 })).includes('mosaicRule='));
  // The service echoes the Origin and sets access-control-allow-credentials: true. It is
  // keyless and anonymous, and a credentialled cross-origin request is not what it is for.
  assert.equal(FETCH_OPTIONS.credentials, 'omit');
});

test('the CONUS boundary is stated, never painted: outside the extent is outside coverage', () => {
  // The service publishes its own extent. Outside it is proof of absence; inside it is
  // not proof of presence — the Gulf point sits inside the rectangle and is NoData.
  assert.equal(viewCoverage(PARIS), 'outside');
  assert.equal(viewCoverage(DENALI), 'outside', 'there is no NLCD land-cover service for Alaska in this catalogue');
  assert.equal(viewCoverage(HALEAKALA), 'outside', 'nor for Hawaii');
  assert.equal(viewCoverage(DRIFTLESS), 'unproven');
  assert.match(coverageText('landCover', 'outside'), /outside|does not (reach|cover)/i);
  assert.doesNotMatch(coverageText('landCover', 'outside'), /no trees|unclassified|nothing grows/i);
  assert.notEqual(coverageText('landCover', 'outside'), coverageText('landCover', 'unproven'));
  assert.ok(Number.isFinite(CONUS_EXTENT_3857.xmin) && CONUS_EXTENT_3857.xmax > CONUS_EXTENT_3857.xmin);
});

// --- the registry contract, and the CSP bill -----------------------------------

test('both products are measured sources on one origin, costing one connect-src host and no img-src', () => {
  const before = cspDirectivesFor(Object.fromEntries(
    Object.entries(SOURCES).filter(([k]) => k !== 'nlcdLandCover' && k !== 'nlcdTreeCanopy')));
  const after = cspDirectivesFor();
  const added = after['connect-src'].filter((o) => !before['connect-src'].includes(o));
  assert.deepEqual(added, ['https://imagery.geoplatform.gov'],
    'ONE new origin for both products — the second entry costs the policy nothing');
  assert.deepEqual(after['img-src'], before['img-src'],
    'the bytes are fetched and painted from a blob: URL, which img-src already allows; '
    + 'handing the export URL to an <img> would double the bill to 48 characters');
  // imagery.nationalmap.gov (NAIP) is a DIFFERENT host and does not cover this one.
  assert.notEqual(SOURCES.nlcdLandCover.origin, SOURCES.usdaNaip.origin);
  for (const id of ['nlcdLandCover', 'nlcdTreeCanopy']) {
    const src = SOURCES[id];
    assert.equal(src.kind, 'raster-image');
    assert.equal(src.origin, 'https://imagery.geoplatform.gov');
    assert.equal(src.paintedAs, undefined);
    // Nothing read the land cover: it is an algorithm's guess from Landsat, and USGS ships
    // a separate Land Cover Confidence product precisely because the guess can be wrong.
    assert.equal(src.claim, 'model');
    assert.equal(src.cors, 'reflects-origin');
    assert.equal(src.limits.requiresKey, false);
    assert.equal(src.measuredOn, '2026-09-15');
    assert.match(src.coverageSemantics, /CONUS ONLY|CONUS here/);
  }
  // The vintage is read from `description`, which the catalogue backs: the canopy
  // service's own serviceDescription still says v2023-5 and contradicts it.
  assert.match(SOURCES.nlcdTreeCanopy.name, /v2025-6/);
  assert.deepEqual([...SOURCES.nlcdLandCover.time.years], [1985, 2024]);
  assert.deepEqual([...SOURCES.nlcdTreeCanopy.time.years], [1985, 2025]);
});

test('both surfaces are one-at-a-time context layers that state the year on screen', () => {
  for (const [layerId, label] of [['nlcdLandCover', LAND_COVER_LABEL], ['nlcdTreeCanopy', CANOPY_LABEL]]) {
    const l = LAYER_BY_ID[layerId];
    assert.ok(l, `${layerId} has no layer entry, so no reader can reach it`);
    assert.equal(l.group, 'context');
    assert.ok(CONTEXT_LAYER_IDS.includes(layerId));
    assert.equal(l.sourceId, layerId);
    assert.equal(l.screenOnly, true);
    assert.equal(l.rasterSurface, true, 'it fills the view, so the surface budget must count it');
    assert.equal(l.defaultOn, false);
    // Nothing drawn can mean the service never mapped this ground rather than that the
    // ground has no cover — which is exactly what `ambiguous` is for.
    assert.equal(l.emptyMeans, 'ambiguous');
    assert.equal(l.label, label);
  }
  assert.equal(LAYER_BY_ID.nlcdLandCover.coverageCaveat, LAND_COVER_CAVEAT);
  assert.equal(LAYER_BY_ID.nlcdTreeCanopy.coverageCaveat, CANOPY_CAVEAT);

  // The year on screen is a value the app chose. The service will not say it, and the
  // default answer is silently the newest year, so "current" is never printed.
  const cap = surfaceCaption('nlcdLandCover', { vintage: '2024', nowMs: Date.UTC(2026, 8, 14) });
  assert.equal(cap.claim, 'model');
  assert.match(cap.text, /Modelled for 2024/);
  assert.doesNotMatch(cap.text, /Observed|Forecast/);
  assert.match(surfaceCaption('nlcdTreeCanopy', { vintage: null }).text, /unknown/i);
  assert.match(yearLine('landCover', 2024), /2024/);
  assert.notEqual(yearLine('landCover', 2024), yearLine('canopy', 2025));
});

test('nothing a reader is shown claims to be current, or a look at the ground', () => {
  const said = readerStrings().join('\n');
  assert.doesNotMatch(said, /\bcurrent\b|\btoday\b|\bright now\b/i,
    'the newest land cover is 2024 and the newest canopy 2025 — neither is now');
  assert.match(LAND_COVER_CAVEAT, /2024/);
  assert.match(LAND_COVER_CAVEAT, /Alaska|Hawaii/, 'the CONUS-only limit belongs where the reader is');
  assert.match(CANOPY_CAVEAT, /2025/);
  assert.match(CANOPY_CAVEAT, /shade/i, '70% canopy is not 70% shade on a trail');
  // The serving host is not the authoring agency, and a reader chasing the data deserves
  // to know which door it came through.
  assert.match(SOURCES.nlcdLandCover.attribution, /USGS EROS/);
  assert.match(SOURCES.nlcdLandCover.attribution, /Forest Service/);
  assert.match(SOURCES.nlcdTreeCanopy.attribution, /Forest Service/);
  assert.ok(said.includes(SOURCES.nlcdLandCover.attribution));
});
