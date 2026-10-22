// Source registry contract for Quiet Corners Field Maps. Run: node --test "scripts/qcm/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SOURCES, APPROVED_ORIGINS, REQUEST_POLICY, FAILURE, cspDirectivesFor,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';

const REQUIRED = ['id', 'name', 'kind', 'origin', 'serviceUrl', 'metadataUrl', 'spatialReference',
  'limits', 'pagination', 'cors', 'attribution', 'termsUrl', 'dateBasis', 'coverageSemantics', 'claim', 'measuredOn'];

/** What KIND of statement a source makes, as data rather than as prose a caller must
 *  read. The page shows a surface's own time, and which time that is depends entirely
 *  on this: a forecast's valid time, an observation's observation time, an inventory's
 *  vintage. Five and no more, so a reader-facing rule can switch on it exhaustively. */
const CLAIMS = ['observation', 'forecast', 'inventory', 'model', 'calculation'];
const CREDENTIAL_PARAM = /^(api[-_]?key|key|token|access[-_]?token|secret|password|sig(nature)?)$/i;

function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out));
  return out;
}

test('every source carries the required keys and its kind-specific block', () => {
  for (const [key, src] of Object.entries(SOURCES)) {
    assert.equal(src.id, key);
    for (const k of REQUIRED) assert.ok(k in src, `${key} lacks ${k}`);
    // Seven kinds: a tile cache read as <img>, a queryable feature layer, a whole-image
    // export, a point forecast, which has no layers because the service turns a
    // lat/lon into a forecast URL itself, a gridded forecast, which is one file
    // covering the whole globe that the caller indexes itself, an alert feed --
    // one GeoJSON collection asked by point whose FEATURES carry the times, added
    // with the NWS alerts source rather than bent into one of the five above -- and a
    // camera feed: a still (and sometimes a stream link) per record, never a tile and
    // never queried by geometry (QUX-08D) -- and an observation feed: a JSON point
    // feed asked by bounding box whose FEATURES carry their own reading times, with no
    // ArcGIS layer behind it (the USGS stream gauges).
    assert.ok(['raster-tiles', 'feature-query', 'raster-image', 'point-forecast', 'gridded-forecast', 'alert-feed', 'camera-feed', 'observation-feed'].includes(src.kind), `${key} kind=${src.kind}`);
    if (src.kind === 'raster-tiles') assert.ok(src.tile && src.tile.urlTemplate, `${key} lacks tile`);
    else if (src.kind === 'raster-image') assert.ok(src.serviceUrl && src.limits, `${key} lacks serviceUrl/limits`);
    else if (src.kind === 'point-forecast') assert.ok(src.endpoints && src.endpoints.point, `${key} lacks endpoints.point`);
    // The feed is asked BY POINT and its message types are the API's own enum, read
    // back off a 400. Both are what a caller has to know before reading a feature.
    else if (src.kind === 'alert-feed') assert.ok(src.endpoints && src.endpoints.active && Array.isArray(src.messageTypes), `${key} lacks endpoints.active/messageTypes`);
    // A whole-globe grid fetched in one piece: the cell size and the range its
    // longitudes are expressed in are what a caller has to know before indexing it.
    else if (src.kind === 'gridded-forecast') assert.ok(src.grid && src.grid.cellDegrees && src.grid.lonRange, `${key} lacks grid`);
    // A camera catalogue has a serviceUrl and a coverageSemantics naming its real
    // footprint (QUX-08D: District 5 only), and is never a tile cache.
    else if (src.kind === 'observation-feed') {
      // Asked by box (USGS: byBox + parameterCodes) or by station from a build-time catalogue
      // (NWS: latest with {id} + catalogue).
      if (src.endpoints && src.endpoints.byBox) {
        assert.ok(src.endpoints.byBox.includes('{bbox}'), `${key} lacks endpoints.byBox`);
        assert.ok(Array.isArray(src.parameterCodes) && src.parameterCodes.length > 0, `${key} lacks parameterCodes`);
      } else {
        assert.ok(src.endpoints && src.endpoints.latest && src.endpoints.latest.includes('{id}') && src.endpoints.catalogue, `${key} lacks endpoints.latest/catalogue`);
      }
      assert.ok(!('tile' in src) && !('layers' in src), `${key} is a point feed, not tiles or an ArcGIS layer`);
    }
    else if (src.kind === 'camera-feed') {
      assert.ok(src.serviceUrl && src.coverageSemantics, `${key} lacks serviceUrl/coverageSemantics`);
      assert.ok(!('tile' in src), `${key} is a camera feed, not a tile cache`);
    }
    else assert.ok(Array.isArray(src.layers) && src.layers.every((l) => l.id !== undefined && l.name && l.fields));
    assert.ok(['service-metadata', 'feature-field', 'unknown'].includes(src.dateBasis));
    // A date, not THE date: sources are measured when they are added, so pinning one
    // day here breaks the moment a source joins — and the point of the field is that
    // each source records when IT was checked.
    assert.match(src.measuredOn, /^\d{4}-\d{2}-\d{2}$/, `${src.id} measuredOn`);
  }
});

test('every source declares its claim type, and only one of the five', () => {
  for (const [key, src] of Object.entries(SOURCES)) {
    assert.ok('claim' in src, `${key} does not declare what kind of claim it makes`);
    assert.ok(CLAIMS.includes(src.claim), `${key} claim=${src.claim} is not one of ${CLAIMS.join(', ')}`);
  }
  // DERIVED from each source's own coverageSemantics, never invented. Each pair below is
  // the prose and the value it forces; if one is ever edited the other has to move with it.
  assert.equal(SOURCES.nwsRadar.claim, 'observation');
  assert.match(SOURCES.nwsRadar.coverageSemantics, /observation of the last few minutes and never an outlook/);
  assert.equal(SOURCES.swpcAurora.claim, 'forecast');
  assert.match(SOURCES.swpcAurora.coverageSemantics, /A FORECAST about an hour ahead, never an observation of now/);
  assert.equal(SOURCES.nasaBlackMarble.claim, 'inventory');
  assert.match(SOURCES.nasaBlackMarble.coverageSemantics, /averaged over one year/);
  // Interpolated, preliminary -- and still an observation of a past hour, not an outlook.
  assert.equal(SOURCES.epaAirNowAqi.claim, 'observation');
  assert.match(SOURCES.epaAirNowAqi.coverageSemantics, /for one past hour/);
  assert.match(SOURCES.epaAirNowAqi.coverageSemantics, /INTERPOLATED/);
  // Basemaps and boundary services are published compilations, not readings of now.
  for (const id of ['usgsTopo', 'usgsImagery', 'usgsShadedRelief', 'usgsQuadIndex', 'usgsGovUnits',
    'usfsMvum', 'usfsSurfaceOwnership', 'usdaNaip', 'blmRecSites', 'padusPublicAccess']) {
    assert.equal(SOURCES[id].claim, 'inventory', `${id} is a published compilation`);
  }
  assert.equal(SOURCES.nwsForecast.claim, 'forecast');
  // An alert states a hazard through a window that has not ended, so the time worth
  // showing is that window -- not a moment anything was read off an instrument.
  assert.equal(SOURCES.nwsAlerts.claim, 'forecast');
  assert.match(SOURCES.nwsAlerts.coverageSemantics, /not every hazard that exists/);
  assert.match(SOURCES.nwsAlerts.coverageSemantics, /ZONE-based/);
  // PAD-US counts and draws parcels and designations that exist on paper — not an observation of
  // the ground, not a forecast, not a calculation. Its prose carries the two facts that decide
  // every use of it: the acreage rule, and that the layer is already flat so nothing stacks.
  assert.match(SOURCES.padusPublicAccess.coverageSemantics, /never summed over an\s+extent/);
  assert.match(SOURCES.padusPublicAccess.coverageSemantics, /already flattened/);
  // A gridded elevation surface is interpolated between lidar returns, not a reading at your point.
  assert.equal(SOURCES.usgs3dep.claim, 'model');
  // A modelled floodplain adopted as regulation. NOT an observation, and the one thing it must
  // never be mistaken for is the alert feed two entries above it.
  assert.equal(SOURCES.femaNfhl.claim, 'model');
  assert.match(SOURCES.femaNfhl.coverageSemantics, /REGULATORY MAP/);
  assert.match(SOURCES.femaNfhl.coverageSemantics, /says nothing about where water is now/);
});

test('registry objects are deep-frozen (assignment throws in strict mode)', () => {
  assert.throws(() => { SOURCES.usgsTopo = null; });
  assert.throws(() => { SOURCES.usgsTopo.origin = 'https://example.invalid'; });
  assert.throws(() => { SOURCES.usgsTopo.tile.size = 512; });
  assert.throws(() => { SOURCES.usfsMvum.layers[0].fields.push('x'); });
  assert.throws(() => { APPROVED_ORIGINS.push('https://example.invalid'); });
  assert.throws(() => { REQUEST_POLICY.timeoutMs = 1; });
  assert.throws(() => { FAILURE.coverageUnknown = ''; });
});

test('no URL carries a credential-shaped query parameter', () => {
  for (const s of strings(SOURCES)) {
    assert.doesNotMatch(s, /(key|token|apikey)=/i, s);
    if (!/^https?:\/\//.test(s)) continue;
    for (const name of new URL(s.replace(/\{[^}]+\}/g, '0')).searchParams.keys()) {
      assert.doesNotMatch(name, CREDENTIAL_PARAM, `${s} has credential-shaped param ${name}`);
    }
  }
});

test('every origin is a bare https:// origin with no path, and APPROVED_ORIGINS derives from them', () => {
  const origins = Object.values(SOURCES).map((s) => s.origin);
  for (const o of origins) {
    assert.ok(o.startsWith('https://'), o);
    assert.equal(new URL(o).origin, o, `${o} is not a bare origin`);
    assert.equal(new URL(o).pathname, '/');
  }
  assert.deepEqual([...APPROVED_ORIGINS], [...new Set(origins)].sort());
  // Derived, not counted: adding a source must not break this test. What matters is
  // that the list is exactly the sources' origins, de-duplicated and sorted.
  assert.deepEqual(APPROVED_ORIGINS, [...new Set(Object.values(SOURCES).map((s) => s.origin))].sort());
  assert.ok(APPROVED_ORIGINS.length >= 3);
});

// Every camera-feed host: pictures painted through an <img>, never fetched by the page. Each is an
// exact origin (no wildcard) and each appears in img-src only.
const CAMERA_PICTURE_ORIGINS = Object.values(SOURCES).filter((s) => s.kind === 'camera-feed' && s.cors === 'none').map((s) => s.origin);

test('camera-feed hosts: twenty-one exact origins, all https, none wildcard, all cors none and painted as an img', () => {
  assert.deepEqual([...CAMERA_PICTURE_ORIGINS].sort(), [
    'https://511la.org', 'https://api.aviationwx.org', 'https://assets.lawrenceks.gov', 'https://cctv.austinmobility.io', 'https://cocam.carsprogram.org', 'https://egov.cityofsalem.net',
    'https://images.srtmc.org', 'https://images.wsdot.wa.gov', 'https://its.kirklandwa.gov', 'https://kscam.carsprogram.org', 'https://phenocam.nau.edu', 'https://public.carsprogram.org',
    'https://sd.cdn.iteris-atis.com', 'https://snapshot.vdotcameras.com',
    'https://tripcheck.com', 'https://udottraffic.utah.gov', 'https://volcview.wr.usgs.gov', 'https://webapps.arlingtontx.gov',
    'https://www.glerl.noaa.gov', 'https://www.nps.gov', 'https://www.trimarc.org']);
  for (const s of Object.values(SOURCES).filter((x) => x.kind === 'camera-feed' && x.cors === 'none')) {
    assert.match(s.origin, /^https:\/\/[a-z0-9.-]+$/, s.id);
    assert.equal(s.paintedAs, 'img', s.id);
  }
});

test('cspDirectivesFor derives connect-src from all origins except cors:none, and img-src from what the browser paints', () => {
  const csp = cspDirectivesFor();
  // npsWebcams is cors:'none' (QUX-08D-ii): the page never connects to www.nps.gov itself,
  // only to a same-origin build-time snapshot, so its origin is excluded from connect-src.
  assert.deepEqual(csp['connect-src'], APPROVED_ORIGINS.filter((o) => !CAMERA_PICTURE_ORIGINS.includes(o)));
  for (const o of CAMERA_PICTURE_ORIGINS) assert.ok(!csp['connect-src'].includes(o), `${o} is painted only, never connected to`);
  assert.ok(!csp['connect-src'].includes(SOURCES.npsWebcams.origin));
  // What belongs here is not "raster" but "loaded into an <img>": the topo base and
  // the night-light surface, because a tile cache always is, radar, because its
  // export goes straight to an overlay rather than through a canvas, and the NPS
  // webcam stills, painted straight into an <img src> (QUX-08D-ii). Named rather
  // than re-derived, so adding one stays a deliberate edit here — that is what puts
  // a host in img-src, and a host missing from it paints nothing and says nothing.
  assert.deepEqual(csp['img-src'],
    [
    'https://511la.org', 'https://api.aviationwx.org', 'https://assets.lawrenceks.gov', SOURCES.usgsTopo.origin, 'https://cctv.austinmobility.io',
    'https://cocam.carsprogram.org', 'https://egov.cityofsalem.net', SOURCES.btsTransportNoise.origin, SOURCES.nasaBlackMarble.origin, 'https://images.srtmc.org', 'https://images.wsdot.wa.gov', 'https://its.kirklandwa.gov',
    'https://kscam.carsprogram.org', SOURCES.nwsRadar.origin, 'https://phenocam.nau.edu', 'https://public.carsprogram.org',
    'https://sd.cdn.iteris-atis.com', 'https://snapshot.vdotcameras.com', 'https://tripcheck.com', 'https://udottraffic.utah.gov',
    SOURCES.volcview.origin, 'https://webapps.arlingtontx.gov', SOURCES.glerl.origin, SOURCES.npsWebcams.origin, 'https://www.trimarc.org',
  ]);
  assert.deepEqual(Object.keys(csp).sort(), ['connect-src', 'img-src']);
});

test('measured facts: CORS modes, tile cache observation, messages', () => {
  assert.equal(SOURCES.usgsTopo.cors, 'star');
  assert.equal(SOURCES.usgsQuadIndex.cors, 'star');
  assert.equal(SOURCES.usfsMvum.cors, 'reflects-origin');
  assert.equal(SOURCES.caltransCctv.cors, 'star');
  // QUX-08D-ii: the page reads a same-origin build-time snapshot, never www.nps.gov
  // directly, so this source is the one exception to "every origin is in connect-src".
  assert.equal(SOURCES.npsWebcams.cors, 'none');
  assert.equal(SOURCES.npsWebcams.paintedAs, 'img');
  assert.equal(SOURCES.usgsTopo.tile.level17Observed, 404);
  assert.equal(SOURCES.usgsTopo.tile.maxCachedLevelObserved, 16);
  // Measured 2026-09-12 on the topo host: imagery is cached through 16, relief through 13.
  assert.equal(SOURCES.usgsImagery.tile.maxCachedLevelObserved, 16);
  assert.equal(SOURCES.usgsShadedRelief.tile.maxCachedLevelObserved, 13);
  assert.equal(SOURCES.usfsMvum.dateBasis, 'unknown');
  assert.equal(FAILURE.tilesMissing(3, 84),
    'USGS Topo did not return 3 of 84 required tiles. PDF creation is blocked.');
  assert.equal(FAILURE.paging(2, 5),
    'MVUM returned more records than one response can contain; fetching page 2 of 5.');
  assert.deepEqual(REQUEST_POLICY, { timeoutMs: 20000, retries: 2, retryBackoffMs: [500, 2000], maxConcurrent: 6 });
});

// The page's source table listed three of five federal services for two weeks
// after the other two shipped. Documentation that can drift from the code is
// documentation that will, so the check is mechanical.
test('every measured source is named on the page that documents them', () => {
  const doc = readFileSync(new URL('../../content/quiet-corners-maps.md', import.meta.url), 'utf8');
  for (const s of Object.values(SOURCES)) {
    assert.ok(doc.includes(s.serviceUrl), `${s.id} (${s.name}) is fetched and undocumented`);
  }
  assert.match(doc, /State land services/, 'the per-state services need naming too');
});

// The road-name source shares gnisNames' origin, so adding it must cost the CSP nothing.
test('usgsRoadNames is on the shared National Map origin: the CSP is identical with and without it', () => {
  const without = Object.fromEntries(Object.entries(SOURCES).filter(([id]) => id !== 'usgsRoadNames'));
  assert.ok(!('usgsRoadNames' in without) && Object.keys(without).length === Object.keys(SOURCES).length - 1);
  assert.deepEqual(cspDirectivesFor(SOURCES), cspDirectivesFor(without));
  assert.equal(SOURCES.usgsRoadNames.origin, SOURCES.gnisNames.origin);
  assert.ok(APPROVED_ORIGINS.includes(SOURCES.usgsRoadNames.origin));
});

test('usgsRoadNames carries the measured service facts and its own docs row', () => {
  const s = SOURCES.usgsRoadNames;
  assert.equal(s.kind, 'feature-query');
  assert.equal(s.serviceUrl, 'https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer');
  assert.equal(s.metadataUrl, `${s.serviceUrl}?f=pjson`);
  assert.equal(s.attribution, 'USGS The National Map: National Transportation Dataset; U.S. Census Bureau – TIGER/Line; U.S. Forest Service. Data Refreshed October, 2026.');
  assert.equal(s.termsUrl, SOURCES.gnisNames.termsUrl);
  assert.equal(s.claim, 'inventory');
  assert.equal(s.limits.maxRecordCount, 2000);
  assert.deepEqual(s.layers.map((l) => l.id), [29, 30, 31, 32, 35]);
  assert.match(s.coverageCaveat, /CONUS/);
  assert.match(s.coverageCaveat, /monthly/);
  const doc = readFileSync(new URL('../../content/quiet-corners-maps.md', import.meta.url), 'utf8');
  const row = doc.split('\n').find((l) => l.startsWith('|') && l.includes('transportation MapServer') && l.includes('Road names'));
  assert.ok(row, 'a source-table row names the road-name layers');
  assert.ok(row.includes(s.serviceUrl));
});
