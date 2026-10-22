// EPA Level III ecoregions, against the committed export. No network, at test time or at
// runtime: the artifact IS the source, which is the point of the route.
//
// WHY AN EXPORT AND NOT THE SERVICE. Measured 2026-09-14: the national geometry request is
// REFUSED ungeneralized — HTTP 500 with a `text/html` body, so `response.json()` throws
// rather than returning an empty result — and answers only with `maxAllowableOffset`. A live
// route would have to carry that parameter forever and would break the day someone dropped
// it. Baking the generalization into a committed artifact removes the failure mode instead
// of guarding it, and the data has not moved since December 2011, so nothing is lost by it.
// It also keeps gispub.epa.gov out of `SOURCES`, and `cspDirectivesFor` has no offline
// concept: an entry there would spend 15 CSP characters the browser never uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cspDirectivesFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import {
  LAYER_ID, EXPORT_URL, VINTAGE, LEVEL, CREDIT, TERMS_URL, SOURCE_QUERY_URL,
  GENERALIZED_DEGREES, FEATURE_COUNT, EXPORT_BYTES, MEASURED_ON,
  readExport, regionAt, placeText, outsideText, areaReport, readerStrings,
  LAYER_LABEL, LAYER_CAVEAT,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-ecoregions.js';
import { LAYER_BY_ID, GROUP_IDS } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';

const EXPORT_FILE = new URL('../../static/data/quiet-corners/ecoregions-l3.json', import.meta.url);
const raw = readFileSync(EXPORT_FILE, 'utf8');
const geojson = JSON.parse(raw);
const regions = readExport(geojson);

test('the committed export is the measured national Level III layer, whole', () => {
  assert.equal(geojson.type, 'FeatureCollection');
  assert.equal(geojson.features.length, FEATURE_COUNT);
  assert.equal(FEATURE_COUNT, 85, 'Level III is 85 regions; Level IV is 967 and 4.5 MB');
  // The byte count is the provenance: this is the response the recorded command returned.
  assert.equal(Buffer.byteLength(raw), EXPORT_BYTES);
  assert.equal(EXPORT_BYTES, 949718);
  for (const f of geojson.features) {
    for (const k of ['US_L3CODE', 'US_L3NAME', 'NA_L2NAME', 'NA_L1NAME']) {
      assert.ok(f.properties[k], `a feature lacks ${k}`);
    }
    assert.ok(['Polygon', 'MultiPolygon'].includes(f.geometry.type));
  }
  assert.equal(regions.length, FEATURE_COUNT);
  assert.equal(new Set(regions.map((r) => r.code)).size, FEATURE_COUNT, 'a code identifies a region');
});

test('the export is served from this site, so it adds no origin and no CSP character', () => {
  assert.ok(EXPORT_URL.startsWith('/'), 'same-origin, covered by the policy\'s own \'self\'');
  const csp = cspDirectivesFor();
  for (const list of Object.values(csp)) {
    assert.ok(!list.some((o) => o.includes('epa.gov')), 'the EPA host must not reach the policy');
  }
  const module = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/source-ecoregions.js', import.meta.url), 'utf8');
  // The service URL is RECORDED — provenance for the artifact — and must not be fetched.
  assert.ok(module.includes(SOURCE_QUERY_URL), 'the artifact\'s provenance belongs in the module that reads it');
  assert.ok(!/fetch\([^)]*gispub/.test(module), 'the live service is never called at runtime');
  assert.equal(GENERALIZED_DEGREES, 0.01, 'the offset the recorded command carried');
  assert.match(MEASURED_ON, /^\d{4}-\d{2}-\d{2}$/);
});

// MEASURED 2026-09-14 at 47.9,-91.3: US_L3CODE 50, "Northern Lakes and Forests",
// NA_L2NAME "MIXED WOOD SHIELD", NA_L1NAME "NORTHERN FORESTS".
test('a point in the conterminous states lands in the region the service named', () => {
  const r = regionAt(regions, 47.9, -91.3);
  assert.ok(r, 'the Boundary Waters must land in a region');
  assert.equal(r.code, '50');
  assert.equal(r.name, 'Northern Lakes and Forests');
  assert.equal(r.level1, 'NORTHERN FORESTS');
  // A second, far away, so the lookup is not accidentally returning the first feature.
  const sonoran = regionAt(regions, 32.2, -112.0);
  assert.equal(sonoran && sonoran.name, 'Sonoran Basin and Range');
  assert.equal(sonoran.level1, 'NORTH AMERICAN DESERTS');
});

// The plan's requirement for this unit: multiple designations must not become duplicate
// acreage. Ecoregions satisfy it by being a PARTITION — 60 random points returned at most
// one region each when measured. A future EPA republish that broke that would show up here.
test('the regions are a partition: no point falls in two of them', () => {
  let hits = 0;
  for (let i = 0; i < 400; i += 1) {
    // A deterministic scatter over the conterminous states; no randomness in CI.
    const lat = 25 + ((i * 37) % 240) / 10;
    const lon = -124 + ((i * 53) % 580) / 10;
    const found = regions.filter((r) => regionAt([r], lat, lon));
    assert.ok(found.length <= 1, `${lat},${lon} falls in ${found.length} regions: ${found.map((r) => r.code)}`);
    if (found.length) hits += 1;
  }
  assert.ok(hits > 200, `only ${hits} of 400 scattered points landed in any region`);
});

// Alaska (64.8,-147.7) and the offshore Atlantic (39.0,-70.0) both returned zero features
// from the live service. That is "this map stops here", NOT "no ecosystem".
test('outside the conterminous states is worded as coverage stopping, not as absence', () => {
  assert.equal(regionAt(regions, 64.8, -147.7), null, 'Alaska is not in this map');
  assert.equal(regionAt(regions, 39.0, -70.0), null, 'offshore Atlantic');
  const text = outsideText();
  assert.match(text, /conterminous|lower 48|48 states/i, 'the reader is told where the map reaches');
  assert.doesNotMatch(text, /\bno ecosystem|no ecoregion here|nothing (grows|lives)\b/i);
  assert.equal(areaReport(regions, { lat: 64.8, lon: -147.7 }).text, text);
  assert.equal(areaReport(regions, { lat: 64.8, lon: -147.7 }).known, false);
  assert.equal(areaReport(regions, null).known, false);
});

test('every explanation carries the source and the vintage', () => {
  assert.equal(VINTAGE, 'December 2011');
  assert.equal(LEVEL, 'Level III');
  const r = regionAt(regions, 47.9, -91.3);
  const report = areaReport(regions, { lat: 47.9, lon: -91.3 });
  assert.equal(report.known, true);
  assert.ok(report.text.includes('Northern Lakes and Forests'));
  assert.ok(report.text.includes(VINTAGE), 'a classification frozen 15 years ago must say so');
  assert.ok(placeText(r).includes(r.level1), 'the broad family is what makes the name mean anything');
  // The credit and the terms are the publisher's own, and the terms page is the one that
  // states EPA geospatial data is public domain under 17 U.S.C. 105 — which is what makes
  // redistributing this artifact from our own hosting lawful.
  assert.match(CREDIT, /Environmental Protection Agency|US EPA/);
  assert.equal(TERMS_URL, 'https://www.epa.gov/web-policies-and-procedures/epa-disclaimers');
});

test('nothing this layer says turns a classification into an observation', () => {
  // An ecoregion boundary is drawn by analysts from geology, physiography, vegetation,
  // climate, soils, land use, wildlife and hydrology. Nothing was counted and nothing was
  // measured at the line, so no string may describe it as seen, sampled or current.
  const OBSERVED = /\b(observed|measured|sampled|surveyed|recorded at|right now|currently|today|this year)\b/i;
  const PARTICULAR = /\b(this acre|your land|the ground here is|you will find|expect to see)\b/i;
  const strings = [...readerStrings(regions, { lat: 47.9, lon: -91.3 }), LAYER_LABEL, LAYER_CAVEAT, CREDIT];
  for (const s of strings) {
    assert.doesNotMatch(s, OBSERVED, `a classification is not an observation: ${s}`);
    assert.doesNotMatch(s, PARTICULAR, `it describes a region, never a particular acre: ${s}`);
  }
  assert.match(LAYER_CAVEAT, /1:250,000|generalized|generalised/i,
    'the boundaries are compiled at 1:250,000 and generalized again for this export');
});

test('the layer is a registry entry that draws nothing and prints nothing', () => {
  const l = LAYER_BY_ID[LAYER_ID];
  assert.ok(l, `${LAYER_ID} is not in the registry`);
  assert.ok(GROUP_IDS.includes(l.group));
  assert.equal(l.group, 'reading');
  assert.equal(l.screenOnly, true);
  assert.equal(l.defaultOn, false, `${EXPORT_BYTES} bytes are fetched only when a reader asks`);
  assert.equal(l.sourceId, null, 'no measured service is fetched: the artifact is the source');
  assert.equal(l.localData, EXPORT_URL, 'and the artifact it reads is declared, not inferred from the null');
  assert.equal(l.emptyMeans, 'ambiguous', 'outside the lower 48 nothing back is coverage, not absence');
  assert.equal(l.coverageCaveat, LAYER_CAVEAT);
});

test('the app reads the switch by its registry id and fetches the export once', () => {
  const main = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
  assert.match(main, /layers\.epaEcoregions/);
  assert.match(main, /qcm-layer-epaEcoregions-report/);
  assert.match(main, /const READING_RENDER = \{[^}]*epaEcoregions/);
  // One national file, held after a single fetch — the aurora grid's shape, not the AQI
  // bbox query's. A pan is not a new question when the answer is the whole country.
  assert.match(main, /if \(!ecoregions\)/, 'the export must be fetched once and held');
});
