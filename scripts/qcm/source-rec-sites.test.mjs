// Recreation sites: where you may actually stop. This is what shipped INSTEAD of
// the dispersed-camping corridor, which was rejected because its legal input
// expires and a printed sheet cannot re-check a Forest Order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { symbolKeyForSite, shortSiteName, normalizeSite, fetchRecSites, REC_SITES_SOURCE, siteLines }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/source-rec-sites.js';
import { SYMBOL_BY_KEY, swatchSpec } from '../../themes/headlessmode/static/js/quiet-corners-maps/legend.js';
import { markerPath, layoutSites } from '../../themes/headlessmode/static/js/quiet-corners-maps/pdf.js';

// The seven site types actually measured in the Standing Indian quad, 2026-09-06.
const site = (name, type) => ({ attributes: { site_name: name, site_type: type, fee_charged: 'N', seasonal_operational_status: 'OPEN' },
  geometry: { x: -83.52, y: 35.09 } });

test('every measured site type maps to a symbol that exists', () => {
  const MEASURED = ['CAMPING AREA', 'PICNIC SITE', 'GROUP CAMPGROUND', 'HORSE CAMP', 'CAMPGROUND', 'TRAILHEAD', 'INFO SITE/FEE STATION'];
  for (const type of MEASURED) {
    const key = symbolKeyForSite(type);
    assert.ok(SYMBOL_BY_KEY[key], `${type} -> ${key}, which the symbol table does not have`);
    assert.equal(SYMBOL_BY_KEY[key].kind, 'point');
  }
  assert.equal(symbolKeyForSite('CAMPGROUND'), 'rec-campground');
  assert.equal(symbolKeyForSite('TRAILHEAD'), 'rec-trailhead');
  // A camping area is NOT a shelter unless the record says so. The table used to
  // call every CAMPING AREA in the country a shelter, generalised from one forest's
  // A.T. examples; the type on its own now draws the generic mark.
  assert.equal(symbolKeyForSite('CAMPING AREA'), 'rec-site');
  // The record's own name is the supported evidence: the inventory names A.T.
  // shelters 'A.T. <NAME> SHELTER'.
  assert.equal(symbolKeyForSite('CAMPING AREA', 'A.T. ROCK GAP SHELTER'), 'rec-shelter');
  // A mapped type beats a name that merely contains the word.
  assert.equal(symbolKeyForSite('CAMPGROUND', 'SHELTER CREEK CAMPGROUND'), 'rec-campground');
  // A type nobody has seen yet still draws, as the generic mark. Never dropped.
  assert.equal(symbolKeyForSite('SOMETHING INVENTED IN 2030'), 'rec-site');
  assert.equal(symbolKeyForSite(null), 'rec-site');
});

test('the A.T. prefix is dropped, because the trail is drawn beside the mark', () => {
  assert.equal(shortSiteName('A.T. ROCK GAP SHELTER'), 'ROCK GAP SHELTER');
  assert.equal(shortSiteName('AT LONG BRANCH SHELTER'), 'LONG BRANCH SHELTER');
  assert.equal(shortSiteName('STANDING INDIAN CAMPGROUND'), 'STANDING INDIAN CAMPGROUND');
  assert.equal(shortSiteName(''), null);
});

test('a site without usable coordinates is dropped, not placed at null island', () => {
  assert.equal(normalizeSite({ attributes: { site_name: 'x' }, geometry: { x: null, y: 35 } }), null);
  assert.equal(normalizeSite({ attributes: { site_name: 'x' } }), null);
  const ok = normalizeSite(site('STANDING INDIAN CAMPGROUND', 'CAMPGROUND'));
  assert.deepEqual(ok.lonLat, [-83.52, 35.09], '[lon, lat], as the rest of the print path stores it');
  assert.equal(ok.fee, false);
  assert.equal(ok.status, 'OPEN');
});

test('fee is yes, no or unknown — a blank field is silence, not "no fee"', () => {
  const feeOf = (v) => normalizeSite({ attributes: { site_name: 'x', fee_charged: v }, geometry: { x: -83.5, y: 35 } }).fee;
  assert.equal(feeOf('Y'), true);
  assert.equal(feeOf('N'), false);
  assert.equal(feeOf(''), null, 'a blank fee field never said "no fee"');
  assert.equal(feeOf(null), null);
  assert.equal(feeOf(undefined), null);
});

test('markerPath draws a closed outline centred on the point', () => {
  for (const marker of ['triangle', 'square', 'house']) {
    const path = markerPath(marker, 100, 100, 8);
    assert.deepEqual(path[0], path.at(-1), `${marker} must close`);
    for (const [x, y] of path) {
      assert.ok(Math.abs(x - 100) <= 4.001 && Math.abs(y - 100) <= 4.001, `${marker} escaped its own size box`);
    }
  }
  assert.equal(markerPath('dot', 100, 100, 8), null, 'a dot is a filled circle, not an outline');
});

test('layoutSites places a site inside the image and drops one off the sheet', () => {
  const image = { x: 20, y: 40, w: 400, h: 500 }, pixel = { width: 800, height: 1000 };
  // A stub projector: lon/lat -> page px. Centre, and far off the sheet.
  const toPx = (lon) => (lon === -83.52 ? { x: 400, y: 500 } : { x: 5000, y: 5000 });
  const sites = [
    { symbolKey: 'rec-campground', name: 'IN', lonLat: [-83.52, 35.09] },
    { symbolKey: 'rec-trailhead', name: 'OUT', lonLat: [-99, 35] },
    { symbolKey: 'no-such-symbol', name: 'BOGUS', lonLat: [-83.52, 35.09] },
  ];
  const out = layoutSites(image, pixel, sites, toPx);
  assert.equal(out.length, 1, 'off-sheet and unknown-symbol sites are both dropped');
  assert.equal(out[0].name, 'IN');
  assert.equal(out[0].x, image.x + image.w / 2);
  assert.equal(out[0].y, image.y + image.h / 2);
  assert.equal(out[0].marker, 'triangle');
  assert.ok(out[0].sizePt > 0);
  assert.deepEqual(layoutSites(image, pixel, sites, null), [], 'no projector, no marks');
});

test('a point symbol carries a size in inches, so it scales with the sheet', () => {
  const spec = swatchSpec(SYMBOL_BY_KEY['rec-campground']);
  assert.equal(spec.kind, 'point');
  assert.ok(spec.sizeIn > 0 && spec.sizePt > 0);
  // 0.09 in at 72 pt/in is 6.48 pt. Assert the relationship, not the constant.
  assert.ok(Math.abs(spec.sizePt - spec.sizeIn * 72) < 1e-6);
});

test('fetchRecSites uses the exact field names, and reports a refusal honestly', async () => {
  let seen = null;
  const r = await fetchRecSites({
    bboxLonLat: { minLon: -83.6, minLat: 35.0, maxLon: -83.4, maxLat: 35.125 },
    fetchImpl: async (url, init) => { seen = init.body.toString(); return { ok: true, json: async () => ({ features: [site('A.T. ROCK GAP SHELTER', 'CAMPING AREA'), site('DEEP GAP', 'TRAILHEAD')] }) }; },
  });
  assert.equal(r.sites.length, 2);
  assert.equal(r.sites[0].name, 'ROCK GAP SHELTER');
  // recarea_name vs recareaname cost a live query returning zero rows during
  // development: ArcGIS answers a bad outFields list with an error, not the rows.
  assert.match(seen, /site_name/);
  assert.match(seen, /seasonal_operational_status/);
  assert.match(seen, /outSR=4326/);
  await assert.rejects(fetchRecSites({ bboxLonLat: { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 },
    fetchImpl: async () => ({ ok: false, status: 502 }) }), /answered 502/);
});

// A large rectangle answers in pages. Reading only the first one and calling it
// 'ready' is how the sheet reports a truncated answer as a complete one.
test('fetchRecSites pages, and says partial when the service still has more', async () => {
  const page = (features, more) => ({ ok: true, json: async () => ({ features, exceededTransferLimit: more }) });
  const bbox = { minLon: -83.6, minLat: 35.0, maxLon: -83.4, maxLat: 35.125 };
  let call = 0; const offsets = [];
  const two = await fetchRecSites({
    bboxLonLat: bbox,
    fetchImpl: async (_u, o) => { offsets.push(o.body.get('resultOffset'));
      return ++call === 1 ? page([site('A', 'CAMPGROUND')], true) : page([site('B', 'TRAILHEAD')], false); },
  });
  assert.deepEqual(offsets, ['0', '1'], 'the second page must start after the first');
  assert.equal(two.pages, 2);
  assert.equal(two.sites.length, 2);
  assert.equal(two.coverage, 'complete');

  const stuck = await fetchRecSites({ bboxLonLat: bbox, fetchImpl: async () => page([], true) });
  assert.equal(stuck.coverage, 'partial', 'a truncated answer must not read as a complete one');
});

test('the source says plainly that OPEN is a sync, not a live check', () => {
  assert.equal(REC_SITES_SOURCE.origin, 'https://apps.fs.usda.gov', 'already a CSP-allowed origin');
  assert.match(REC_SITES_SOURCE.coverageSemantics, /last sync, not a live check/);
});

// QUX-11b §2.6: the provider discriminator both normalizers gain, so
// `state.recSites` entries can be told apart -- the field the RETRIABLE
// comment (Q/main.js) asks for, and rec:<provider>:... ids read.
test('11b: normalizeSite tags every site with provider "usfs"', () => {
  const ok = normalizeSite(site('STANDING INDIAN CAMPGROUND', 'CAMPGROUND'));
  assert.equal(ok.provider, 'usfs');
});

// QUX-11b §2.6 (E7): a Forest Service pin gets a card, built only from fields
// already fetched. Six lines, in order: name, type, fee (three-valued),
// status, open season, attribution+caveat.
test('11b: siteLines gives a Forest Service site a six-line card', () => {
  const named = site('STANDING INDIAN CAMPGROUND', 'CAMPGROUND');
  named.attributes.open_season = 'May 1 - Oct 31';
  const lines = siteLines(normalizeSite(named));
  assert.equal(lines.length, 6);
  assert.equal(lines[0], 'STANDING INDIAN CAMPGROUND');
  assert.match(lines[1], /^Type, as the inventory states it: CAMPGROUND/);
  assert.match(lines[2], /no fee is charged/);
  assert.match(lines[3], /^Status in the inventory: OPEN/);
  assert.match(lines[3], /not a live check/);
  assert.match(lines[4], /^Open season, as stated: May 1 - Oct 31/);
  assert.equal(lines[5], `${REC_SITES_SOURCE.attribution} Confirm with the managing forest before relying on a site.`);
});

test('11b: siteLines fee is three-valued -- Y, N and blank are three different lines, never "no fee" for blank', () => {
  const feeLine = (fee) => {
    const raw = site('X', 'CAMPGROUND');
    raw.attributes.fee_charged = fee;
    return siteLines(normalizeSite(raw))[2];
  };
  const y = feeLine('Y'), n = feeLine('N'), blank = feeLine('');
  assert.match(y, /a fee is charged/);
  assert.match(n, /no fee is charged/);
  assert.match(blank, /the record does not say/);
  assert.notEqual(y, n); assert.notEqual(n, blank); assert.notEqual(y, blank);
});

test('11b: siteLines states plainly when the type, status or open season is silent', () => {
  const raw = site('X', '');
  raw.attributes.seasonal_operational_status = '';
  raw.attributes.open_season = '';
  const lines = siteLines(normalizeSite(raw));
  assert.equal(lines[1], 'Type: the record does not say.');
  assert.equal(lines[3], 'Status: the record does not say.');
  assert.equal(lines[4], 'Open season: the record does not say.');
});

test('11b: siteLines names an unnamed Forest Service site', () => {
  const raw = site('', 'CAMPGROUND');
  const lines = siteLines(normalizeSite(raw));
  assert.equal(lines[0], 'Unnamed Forest Service recreation site');
});
