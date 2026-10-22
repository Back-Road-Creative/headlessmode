// The Historic places layer: National Register of Historic Places points from the National Park
// Service's keyless ArcGIS MapServer (mapservices.nps.gov, layer 0). Measured 2026-10-20 (GET only):
// 74,636 points nationally, 114 in -84.2,35.8,-83.6,36.2 (112 with STATUS='Listed'), maxRecordCount
// 2000, CORS echoes the request Origin. The fixture is a live query, trimmed. What the tests pin: an
// inventory row on a NEW origin that reaches connect-src; a screen-only mark row in the federal group; a box over the gate is never requested; a malformed geometry is dropped and counted;
// a capped answer says so; the listing link is built only from a refnum that is all digits; and no
// string implies the place is open, visitable, significant or safe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  NRHP_MAX_BBOX_SQ_DEG, NRHP_RECORD_BUDGET, nrhpBoxStatus, nrhpUrl, readNrhp, fetchNrhp, certDateText,
  nrhpListingUrl, nrhpCardLines, nrhpReport, nrhpLayer, NRHP_ROW, readerStrings,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-nrhp.js';
import { SOURCES, cspDirectivesFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { LAYER_BY_ID, LAYERS, LAYERS_WITH_DRAPE, drapeKindFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';
import { capabilityNotices } from '../../themes/headlessmode/static/js/quiet-corners-maps/terrain-overlays.js';
import { SYMBOL_BY_KEY } from '../../themes/headlessmode/static/js/quiet-corners-maps/legend.js';

const fixture = JSON.parse(readFileSync(new URL('fixtures/nrhp-2026-10-20.min.json', import.meta.url), 'utf8'));
const text = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const KNOXVILLE = { minLon: -84.2, minLat: 35.8, maxLon: -83.6, maxLat: 36.2 };

test('the source row is a keyless inventory on mapservices.nps.gov, which reaches connect-src once', () => {
  const s = SOURCES.npsNrhp;
  assert.ok(s, 'no npsNrhp source');
  assert.equal(s.kind, 'feature-query');
  assert.equal(s.origin, 'https://mapservices.nps.gov');
  assert.equal(s.cors, 'reflects-origin');
  assert.equal(s.claim, 'inventory');
  assert.equal(s.dateBasis, 'feature-field', 'CertDate is the listing date each record carries');
  assert.equal(s.measuredOn, '2026-10-20');
  assert.equal(s.limits.requiresKey, false);
  assert.equal(s.limits.maxRecordCount, 2000);
  assert.equal(s.limits.recordBudgetPerExtent, 500);
  assert.equal(NRHP_RECORD_BUDGET, 500);
  assert.equal(s.layers[0].id, 0, 'layer 0 is the points; layer 1 is polygons');
  assert.equal(s.layers[0].geometryType, 'esriGeometryPoint');
  assert.match(s.layers[0].queryUrl, /cultural_resources\/nrhp_locations\/MapServer\/0\/query$/);
  for (const f of ['RESNAME', 'NRIS_Refnum', 'CertDate', 'City', 'State', 'STATUS']) assert.ok(s.layers[0].fields.includes(f), `no field ${f}`);
  assert.doesNotMatch(JSON.stringify(s), /developer\.nps\.gov|api[_-]?key/i, 'the keyed NPS API is not used');
  const connect = cspDirectivesFor(SOURCES)['connect-src'] || [];
  assert.equal(connect.filter((o) => o === 'https://mapservices.nps.gov').length, 1);
});

test('the row is a screen-only mark layer in the federal group, with one resolving point symbol', () => {
  assert.equal(LAYER_BY_ID.historicPlaces.id, NRHP_ROW.id);
  assert.ok(LAYERS.includes(LAYER_BY_ID.historicPlaces));
  assert.equal(NRHP_ROW.group, 'federal');
  assert.equal(NRHP_ROW.sourceId, 'npsNrhp');
  assert.equal(NRHP_ROW.screenOnly, true);
  assert.equal(NRHP_ROW.notIn3d, true);
  assert.equal(NRHP_ROW.defaultOn, false);
  assert.equal(NRHP_ROW.status, 'live');
  assert.equal(NRHP_ROW.symbolKeys.length, 1);
  assert.equal(SYMBOL_BY_KEY[NRHP_ROW.symbolKeys[0]].kind, 'point');
  assert.equal(drapeKindFor(NRHP_ROW), false);
  assert.deepEqual(capabilityNotices(LAYERS_WITH_DRAPE, { historicPlaces: true }, {}).map((n) => [n.id, n.status]), [['historicPlaces', 'available-2d']]);
  // A row that draws cannot sit in the words-only `reading` group (layer-registry.test.mjs enforces it).
  assert.notEqual(NRHP_ROW.group, 'reading');
});

test('the view gate is the measured one and a wide box is never requested', async () => {
  assert.equal(NRHP_MAX_BBOX_SQ_DEG, 0.25);
  assert.equal(nrhpBoxStatus(KNOXVILLE).ok, true, '0.24 sq deg held 114 points');
  assert.equal(nrhpBoxStatus({ minLon: -85, minLat: 35, maxLon: -83, maxLat: 37 }).ok, false);
  let asked = 0;
  const never = async () => { asked += 1; throw new Error('should not be asked'); };
  assert.equal((await fetchNrhp({ minLon: -85, minLat: 35, maxLon: -83, maxLat: 37 }, { fetchImpl: never })).status, 'too-wide');
  assert.equal(asked, 0);
});

test('the query asks listed places only, the measured fields, 500 rows, in lon/lat, with no key', () => {
  const u = new URL(nrhpUrl(KNOXVILLE));
  assert.equal(u.origin, 'https://mapservices.nps.gov');
  assert.ok(u.pathname.endsWith('/nrhp_locations/MapServer/0/query'));
  assert.equal(u.searchParams.get('where'), "STATUS='Listed'");
  assert.equal(u.searchParams.get('geometry'), '-84.2,35.8,-83.6,36.2');
  assert.equal(u.searchParams.get('inSR'), '4326');
  assert.equal(u.searchParams.get('outSR'), '4326');
  assert.equal(u.searchParams.get('outFields'), 'RESNAME,NRIS_Refnum,CertDate,City,State');
  assert.equal(u.searchParams.get('resultRecordCount'), '500');
  assert.equal(u.searchParams.get('returnGeometry'), 'true');
  assert.equal(u.searchParams.get('f'), 'json');
  assert.doesNotMatch(u.search, /key=|token=/i);
});

test('places read from the fixture; a bad coordinate is dropped and counted; a full page is capped', () => {
  const got = readNrhp(fixture);
  assert.equal(got.places.length, 5);
  assert.equal(got.dropped, 0);
  assert.equal(got.capped, false);
  assert.equal(got.places[0].name, 'Knoxville Business College');
  assert.equal(got.places[0].refnum, '83003042');
  assert.equal(got.places[0].lat, 35.963908);
  assert.equal(got.places[0].lon, -83.91675);
  const dirty = readNrhp({ features: [...fixture.features, { attributes: { RESNAME: 'X' }, geometry: {} },
    { attributes: {} }, { attributes: {}, geometry: { x: NaN, y: 3 } }] });
  assert.equal(dirty.places.length, 5);
  assert.equal(dirty.dropped, 3);
  assert.equal(readNrhp(null).places.length, 0);
  assert.equal(readNrhp({ exceededTransferLimit: true, features: fixture.features }).capped, true);
  const full = { features: Array.from({ length: 500 }, (_, i) => ({ attributes: { RESNAME: `p${i}` }, geometry: { x: -83, y: 36 } })) };
  assert.equal(readNrhp(full).capped, true, 'a page as long as the budget may hide more');
});

test('the listing date is read from CertDate as month and year, and only when it is one', () => {
  assert.equal(certDateText('1983-01-'), 'January 1983');
  assert.equal(certDateText('2017-06-'), 'June 2017');
  assert.equal(certDateText(''), null);
  assert.equal(certDateText(null), null);
  assert.equal(certDateText('1983-13-'), null);
  assert.equal(certDateText('soon'), null);
});

test('the listing link is built only from an all-digit refnum, on the NPS NPGallery host', () => {
  assert.equal(nrhpListingUrl('83003042'), 'https://npgallery.nps.gov/pdfhost/docs/NRHP/Text/83003042.pdf');
  assert.equal(nrhpListingUrl('100001066'), 'https://npgallery.nps.gov/pdfhost/docs/NRHP/Text/100001066.pdf');
  for (const bad of ['SG100001066', '../83003042', '8300304', '83003042?x=1', '', null, undefined, '83003042/../a']) {
    assert.equal(nrhpListingUrl(bad), null, `refused ${JSON.stringify(bad)}`);
  }
});

test('the card says what the record says and nothing more', () => {
  const [a, , , organ] = readNrhp(fixture).places;
  const lines = nrhpCardLines(a);
  assert.equal(lines[0], 'Knoxville Business College');
  assert.ok(lines.some((l) => /83003042/.test(l) && /reference/i.test(l)), lines.join('|'));
  assert.ok(lines.some((l) => /January 1983/.test(l)));
  assert.ok(lines.some((l) => /Knoxville, TENNESSEE/.test(l)));
  const bare = nrhpCardLines(organ);
  assert.ok(bare.every((l) => !/null|undefined|Invalid/.test(l)), bare.join('|'));
  assert.ok(!bare.some((l) => /Listed:/.test(l)), 'no date is invented when the record has none');
  assert.ok(nrhpCardLines({}).every((l) => !/null|undefined/.test(l)));
  assert.equal(nrhpCardLines({})[0], 'Historic place');
});

test('a refused, failed, empty or capped view is a sentence, never a blank', async () => {
  const ok = (body) => async () => ({ ok: true, json: async () => body });
  assert.equal((await fetchNrhp(KNOXVILLE, { fetchImpl: async () => ({ ok: false, status: 503 }) })).status, 'unavailable');
  assert.equal((await fetchNrhp(KNOXVILLE, { fetchImpl: async () => { throw new Error('x'); } })).status, 'unavailable');
  assert.equal((await fetchNrhp(KNOXVILLE, { fetchImpl: ok({ error: { message: 'bad' } }) })).status, 'unavailable');
  assert.equal((await fetchNrhp(KNOXVILLE, { fetchImpl: ok({ features: [] }) })).status, 'empty');
  const got = await fetchNrhp(KNOXVILLE, { fetchImpl: ok(fixture), nowMs: 5 });
  assert.equal(got.status, 'ready');
  assert.equal(got.places.length, 5);
  const capped = await fetchNrhp(KNOXVILLE, { fetchImpl: ok({ ...fixture, exceededTransferLimit: true }) });
  assert.match(nrhpReport(capped).text, /more historic places than/);
  assert.match(nrhpReport({ status: 'too-wide' }).text, /0\.25 square degrees/);
  assert.match(nrhpReport({ status: 'unavailable' }).text, /did not answer/);
  assert.match(nrhpReport({ status: 'empty' }).text, /No listed historic place/);
  assert.match(nrhpReport(got).text, /5 historic places in view/);
  assert.match(nrhpReport(null).text, /did not answer/);
});

test('the Leaflet group draws one keyboard-reachable marker per place and sets text, not markup', () => {
  const made = [];
  const L = {
    layerGroup: () => ({ clearLayers() { made.length = 0; } }),
    circleMarker: (pt, o) => { const x = { pt, o, bindPopup(c) { x.card = c; return x; }, addTo() { made.push(x); return x; } }; return x; },
  };
  const g = nrhpLayer(L);
  g.draw(readNrhp(fixture).places);
  assert.equal(made.length, 5);
  assert.equal(made[0].o.keyboard, true);
  assert.deepEqual(made[0].pt, [35.963908, -83.91675]);
  g.draw([]);
  assert.equal(made.length, 0);
});

test('every reader-facing string frames the layer as a register inventory, not access or merit', () => {
  const all = readerStrings();
  assert.ok(all.length > 8);
  for (const s of all) {
    assert.doesNotMatch(s, /[<>]/, s);
    assert.doesNotMatch(s, /\b(safe|worth a visit|open to the public|open to visitors|you may visit|accessible)\b/i, s);
  }
  assert.match(NRHP_ROW.coverageCaveat, /not a statement about access/i);
  assert.match(NRHP_ROW.coverageCaveat, /approximate/i);
  assert.match(NRHP_ROW.coverageCaveat, /Screen only/);
});

test('the docs, the privacy load line and the control register carry the layer', () => {
  assert.match(text('content/quiet-corners-maps.md'), /\*\*National Register of Historic Places\*\*/);
  const privacy = text('content/privacy.md');
  assert.match(privacy, /National Park Service \(historic places\)/);
  const reg = JSON.parse(text('scripts/qcm/control-register.json'));
  assert.ok(reg.derived.layerCheckboxes.rows.historicPlaces, 'no control-register row for historicPlaces');
  assert.match(reg.derived.layerCheckboxes.rows.historicPlaces.effect, /Historic places/);
});
