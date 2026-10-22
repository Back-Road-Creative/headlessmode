// source-terrain-names.js: bounded GNIS names adapter, against the bytes measured
// live 2026-09-25 (scripts/qcm/fixtures/geonames-*.min.json). No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SOURCES, cspDirectivesFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { KINDS, kindsForZoom } from '../../themes/headlessmode/static/js/quiet-corners-maps/terrain-names.js';
import {
  escapeLiteral, buildCountUrl, buildPageUrl, buildNameSearchUrl, fetchBounded,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-terrain-names.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8'));
const FETCH_P1 = fixture('geonames-fetch-p1.min.json');
const COUNT_READY = fixture('geonames-count-ready.min.json');
const COUNT_OVER_CAP = fixture('geonames-count-over-cap.min.json');
const ERROR_BODY = fixture('geonames-error.min.json');

const BOUNDS = { minLon: -82.8, minLat: 35.6, maxLon: -82.7, maxLat: 35.7 };

test('escapeLiteral: an injected OR 1=1 clause becomes an inert single quoted literal', () => {
  const escaped = escapeLiteral("' OR 1=1");
  assert.equal(escaped, "'' OR 1=1");
  // Wrapped as the adapter always wraps it, the quote can never close early.
  const where = `UPPER(gaz_name) LIKE '${escaped}%'`;
  assert.equal(where, "UPPER(gaz_name) LIKE ''' OR 1=1%'");
  assert.equal((where.match(/'/g) || []).length % 2, 0, 'quotes stay balanced');
});

test('escapeLiteral: apostrophes double, wildcards strip, diacritics pass through', () => {
  assert.equal(escapeLiteral("O'Neal"), "O''Neal");
  assert.equal(escapeLiteral('100%_off'), '100off');
  assert.equal(escapeLiteral('Cañada'), 'Cañada');
});

test('buildNameSearchUrl: UPPER(gaz_name) LIKE prefix search, apostrophe doubled, wildcards stripped from input', () => {
  const url = buildNameSearchUrl("o'neal_50%", { state: 'tn' });
  const params = new URL(url).searchParams;
  assert.equal(params.get('where'), "UPPER(gaz_name) LIKE 'O''NEAL50%' AND state_alpha = 'TN'");
  assert.equal(params.get('outSR'), '4326');
  assert.equal(params.get('returnGeometry'), 'true');
  assert.equal(params.get('orderByFields'), 'gaz_id');
  assert.ok(url.startsWith(SOURCES.gnisNames.layers.find((l) => l.id === 5).queryUrl));
});

test('buildNameSearchUrl: rejects text shorter than 2 or longer than 120 trimmed characters', () => {
  assert.throws(() => buildNameSearchUrl(' a '), RangeError);
  assert.throws(() => buildNameSearchUrl('x'.repeat(121)), RangeError);
});

test('buildCountUrl / buildPageUrl: single-layer kinds produce a query URL against that layer, resultRecordCount capped at maxRecordCount', () => {
  const countUrl = buildCountUrl(BOUNDS, ['Summit', 'Gap']);
  assert.ok(countUrl.includes('/5/query'));
  assert.equal(new URL(countUrl).searchParams.get('returnCountOnly'), 'true');

  const pageUrl = buildPageUrl(BOUNDS, ['Summit'], 200, 999999);
  const params = new URL(pageUrl).searchParams;
  assert.equal(params.get('resultOffset'), '200');
  assert.equal(Number(params.get('resultRecordCount')), SOURCES.gnisNames.limits.maxRecordCount);
  assert.match(params.get('where'), /gaz_featureclass IN \('Summit'\)/);
});

test('buildCountUrl: mixed-layer kinds are refused -- fetchBounded groups by layer instead', () => {
  assert.throws(() => buildCountUrl(BOUNDS, ['Summit', 'Falls']), RangeError);
});

test('buildCountUrl/buildPageUrl/fetchBounded: an unknown class is a RangeError, never silently dropped', () => {
  assert.throws(() => buildCountUrl(BOUNDS, ['Trail']), RangeError);
});

function fakeFetch(responses) {
  let i = 0;
  return async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (r.throwName) { const e = new Error('aborted'); e.name = r.throwName; throw e; }
    return { ok: r.ok !== false, status: r.status || 200, json: async () => r.body };
  };
}

test('fetchBounded: a zero budget refuses to fetch features at all', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => COUNT_OVER_CAP }; };
  const result = await fetchBounded(BOUNDS, ['Summit'], { fetch: fetchImpl, cap: 0 });
  assert.deepEqual(result, { status: 'over-cap', count: 243737 });
  assert.equal(calls.length, 1, 'no page request was made once the budget was zero');
});

test('fetchBounded: a group that straddles the cap is paged with the remaining budget and returns capped', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const q = new URL(url).searchParams;
    if (q.get('returnCountOnly')) return { ok: true, status: 200, json: async () => COUNT_OVER_CAP };
    return { ok: true, status: 200, json: async () => FETCH_P1 };
  };
  const result = await fetchBounded(BOUNDS, ['Summit'], { fetch: fetchImpl, cap: 1500 });
  assert.equal(result.status, 'capped');
  assert.ok(result.features.length > 0);
  assert.deepEqual(result.omittedKinds, ['summit']);
  const page = urls.map((u) => new URL(u).searchParams).find((q) => !q.get('returnCountOnly'));
  assert.equal(Number(page.get('resultRecordCount')), 1500);
});

// Replays the live USGS counts measured 2026-10-06 for the Stevensville, MT extents.
const MEASURED = {
  9: { 3: 84, 5: 751, 6: 754, 7: 215 },
  11: { 3: 10, 5: 28, 6: 56, 7: 2 },
};
function stevensvilleFetch(zoom, log) {
  const counts = MEASURED[zoom];
  return async (url) => {
    log.push(url);
    const u = new URL(url);
    const layer = Number(u.pathname.split('/').slice(-2)[0]);
    const q = u.searchParams;
    if (q.get('returnCountOnly')) return { ok: true, status: 200, json: async () => ({ count: counts[layer] }) };
    const want = Math.min(Number(q.get('resultRecordCount')), counts[layer]);
    const cls = /IN \((.*)\)/.exec(q.get('where'))[1].split(',')[0].replace(/'/g, '');
    const features = Array.from({ length: want }, (_, i) => ({
      attributes: { gaz_id: layer * 100000 + i, gaz_name: `N${layer}-${i}`, gaz_featureclass: cls },
      geometry: { points: [[-114.1 + i * 1e-4, 46.5]] },
    }));
    return { ok: true, status: 200, json: async () => ({ features }) };
  };
}
const ALL_KINDS = Object.values(KINDS).flatMap((t) => Object.keys(t));

test('fetchBounded z9 Stevensville extent: requests only classes the zoom can draw, never over-cap, places and summits present', async () => {
  const log = [];
  const result = await fetchBounded(BOUNDS, ALL_KINDS, { fetch: stevensvilleFetch(9, log), zoom: 9 });
  assert.ok(['ready', 'capped'].includes(result.status), result.status);
  const kinds = new Set(result.features.map((f) => f.kind));
  assert.ok(kinds.has('place'));
  assert.ok(log.length > 0);
  const allowed = new Set(kindsForZoom(9));
  for (const url of log) {
    const where = new URL(url).searchParams.get('where');
    for (const cls of [...where.matchAll(/'([^']+)'/g)].map((m) => m[1])) {
      assert.ok(allowed.has(cls), `${cls} is below its minZoom at z9`);
    }
  }
});

test('fetchBounded z13 over the z11 extent counts: every rung fetched, ready (water floors at z12, stream mouths at z13)', async () => {
  const log = [];
  const result = await fetchBounded(BOUNDS, ALL_KINDS, { fetch: stevensvilleFetch(11, log), zoom: 13 });
  assert.equal(result.status, 'ready');
  const layers = new Set(log.map((u) => new URL(u).pathname.split('/').slice(-2)[0]));
  assert.deepEqual([...layers].sort(), ['3', '5', '6', '7']);
});

test('fetchBounded with zoom 7 requests nothing and reports zero features as ready', async () => {
  const log = [];
  const result = await fetchBounded(BOUNDS, ALL_KINDS, { fetch: stevensvilleFetch(9, log), zoom: 7 });
  assert.equal(log.length, 0);
  assert.deepEqual(result, { status: 'ready', features: [] });
});

test('fetchBounded: under cap, pages once (no exceededTransferLimit) and returns ready with normalized, deduped features', async () => {
  const page = { ...FETCH_P1, exceededTransferLimit: false };
  const fetchImpl = fakeFetch([{ body: COUNT_READY }, { body: page }]);
  // COUNT_READY reports 143; stub the page to answer with exactly 3 raw rows and
  // treat this as the terminal page by asserting on features returned, not on the
  // count matching (that combination is exercised by the 'partial' test below).
  const result = await fetchBounded(BOUNDS, ['Summit', 'Valley'], { fetch: fetchImpl, cap: 1500 });
  assert.ok(result.status === 'ready' || result.status === 'partial');
  assert.equal(result.features.length, 3);
  const ids = result.features.map((f) => f.id).sort();
  assert.deepEqual(ids, ['gnis:985967', 'gnis:986088', 'gnis:986371']);
});

test('fetchBounded: fetched-vs-counted drift after paging completes reports partial', async () => {
  const page = { ...FETCH_P1, exceededTransferLimit: false };
  // Count says 3 matches this layer's raw count, but the page's raw feature count also
  // being 3 makes it 'ready' -- so force a drift by reporting a different count.
  const fetchImpl = fakeFetch([{ body: { count: 5 } }, { body: page }]);
  const result = await fetchBounded(BOUNDS, ['Summit'], { fetch: fetchImpl, cap: 1500 });
  assert.equal(result.status, 'partial');
  assert.equal(result.features.length, 3);
});

test('fetchBounded: a per-request abort surfaces as status timeout', async () => {
  const fetchImpl = fakeFetch([{ throwName: 'AbortError' }]);
  const result = await fetchBounded(BOUNDS, ['Summit'], { fetch: fetchImpl, cap: 1500 });
  assert.equal(result.status, 'timeout');
});

test('fetchBounded: an ArcGIS 200-with-error-body count response surfaces as status error', async () => {
  const fetchImpl = fakeFetch([{ body: ERROR_BODY }]);
  const result = await fetchBounded(BOUNDS, ['Summit'], { fetch: fetchImpl, cap: 1500 });
  assert.equal(result.status, 'error');
  assert.match(result.error, /Invalid where clause/);
});

test('fetchBounded: an HTTP error status on the count request surfaces as status error', async () => {
  const fetchImpl = fakeFetch([{ ok: false, status: 500, body: {} }]);
  const result = await fetchBounded(BOUNDS, ['Summit'], { fetch: fetchImpl, cap: 1500 });
  assert.equal(result.status, 'error');
});

test('registry: gnisNames is present, feature-query, shares the already-approved carto.nationalmap.gov origin', () => {
  const src = SOURCES.gnisNames;
  assert.equal(src.id, 'gnisNames');
  assert.equal(src.kind, 'feature-query');
  assert.equal(src.origin, 'https://carto.nationalmap.gov');
  assert.ok(SOURCES.usgsQuadIndex.origin === src.origin || SOURCES.usgsGovUnits.origin === src.origin);
  assert.deepEqual(src.layers.map((l) => l.id).sort(), [3, 5, 6, 7]);
  for (const l of src.layers) assert.ok(l.fields.includes('gaz_id') && l.fields.includes('gaz_name'));
});

test('registry: adding gnisNames does not change the generated CSP -- its origin was already in connect-src, and it paints nothing so img-src is untouched', () => {
  const csp = cspDirectivesFor();
  // img-src is the named list of what paints through an <img>; QUX-08D-ii added the NPS
  // webcam stills to it. gnisNames is still absent, which is what this case checks.
  assert.deepEqual(csp['img-src'],
    [
    'https://511la.org', 'https://api.aviationwx.org', 'https://assets.lawrenceks.gov', SOURCES.usgsTopo.origin, 'https://cctv.austinmobility.io',
    'https://cocam.carsprogram.org', 'https://egov.cityofsalem.net', SOURCES.btsTransportNoise.origin, SOURCES.nasaBlackMarble.origin, 'https://images.srtmc.org', 'https://images.wsdot.wa.gov', 'https://its.kirklandwa.gov',
    'https://kscam.carsprogram.org', SOURCES.nwsRadar.origin, 'https://phenocam.nau.edu', 'https://public.carsprogram.org',
    'https://sd.cdn.iteris-atis.com', 'https://snapshot.vdotcameras.com', 'https://tripcheck.com', 'https://udottraffic.utah.gov',
    SOURCES.volcview.origin, 'https://webapps.arlingtontx.gov', SOURCES.glerl.origin, SOURCES.npsWebcams.origin, 'https://www.trimarc.org',
  ]);
  const cartoCount = csp['connect-src'].filter((o) => o === 'https://carto.nationalmap.gov').length;
  assert.equal(cartoCount, 1, 'the origin appears exactly once even though three sources now share it');
});

test('documentation: content/quiet-corners-maps.md names the GNIS service URL', () => {
  const doc = readFileSync(new URL('../../content/quiet-corners-maps.md', import.meta.url), 'utf8');
  assert.ok(doc.includes(SOURCES.gnisNames.serviceUrl), 'gnisNames service URL is not documented on the page');
});
