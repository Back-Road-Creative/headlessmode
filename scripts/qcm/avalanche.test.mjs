// Avalanche danger ratings from avalanche.org: the contract this layer is most able to break.
//
// The publisher's own guide (github.com/NationalAvalancheCenter/Avalanche.org-Public-API-Docs)
// asks third parties not to change the intent of a rating, and names how: a rating changes day to
// day, so it must be EXPIRED, not left on the map; the full forecast lives on the centre's site, so
// each zone links there; no rating is grey with a blue outline, no information is no shading, and
// EXTREME is outlined thick and red. A view with no zone in it is outside every forecast area,
// which is never a statement that a slope is safe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SOURCES, cspDirectivesFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { LAYERS } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';
import {
  MAP_LAYER_URL, readZones, zonesInView, zoneState, zoneStyle, zoneLine, areaReport, createZoneStore,
  readerStrings, CONTEXT_ROW, LAYER_LABEL, LAYER_CAVEAT, FAILED_TEXT, EMPTY_TEXT,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-avalanche.js';

// Three real zones from the live feed, 2026-10-21 07:01 EDT, geometry thinned to about 12 points:
// Bridgeport (no rating, in season, dated), Mt Hood (off season, dated), Uintas (no dates at all).
const LIVE = JSON.parse(readFileSync(new URL('./fixtures/avalanche-map-layer-2026-10-21.min.json', import.meta.url)));
const NOW = Date.UTC(2026, 9, 21, 11, 0, 0);
const HOOD = { minLon: -122.2, minLat: 45.0, maxLon: -121.3, maxLat: 45.7 };

const zone = (props, ring = [[-111, 40], [-110, 40], [-110, 41], [-111, 41], [-111, 40]]) => ({
  type: 'Feature', id: props.id || 1,
  properties: { name: 'Test Zone', center: 'Test Avalanche Center', center_link: 'https://example.org/',
    center_id: 'TAC', timezone: 'America/Denver', state: 'UT', off_season: false,
    travel_advice: 'Advice.', danger: 'considerable', danger_level: 3, color: '#f7941e',
    stroke: '#484848', link: 'https://example.org/forecast', start_date: '2026-10-21T06:00:00',
    end_date: '2026-10-22T06:00:00', warning: { product: null }, ...props },
  geometry: { type: 'Polygon', coordinates: [ring] },
});
const fc = (...features) => ({ type: 'FeatureCollection', features });

test('the measured record: a forecast, from a non-agency host, no key, CORS open', () => {
  const src = SOURCES.avalancheOrgZones;
  assert.equal(src.kind, 'zone-feed');
  assert.equal(src.claim, 'forecast');
  assert.equal(src.origin, 'https://api.avalanche.org');
  assert.equal(MAP_LAYER_URL, 'https://api.avalanche.org/v2/public/products/map-layer');
  assert.equal(src.limits.requiresKey, false);
  assert.equal(src.cors, 'star');
  // The owner's permission is the reason the layer exists at all; the record says where it came from.
  assert.match(src.permission, /2026-10-20/);
  assert.ok(cspDirectivesFor()['connect-src'].includes('https://api.avalanche.org'));
  assert.ok(!cspDirectivesFor()['img-src'].includes('https://api.avalanche.org'), 'nothing is painted as <img>');
});

test('the layer is a screen-only context surface, off by default', () => {
  const row = LAYERS.find((l) => l.id === 'avalancheDanger');
  assert.equal(row, CONTEXT_ROW);
  assert.equal(row.group, 'context');
  assert.equal(row.sourceId, 'avalancheOrgZones');
  assert.equal(row.screenOnly, true);
  assert.equal(row.defaultOn, false);
  assert.equal(row.emptyMeans, 'none');
});

test('the live fixture reads as three zones, none of them rated', () => {
  const zones = readZones(LIVE);
  assert.equal(zones.length, 3);
  for (const z of zones) {
    assert.ok(z.name && z.center && z.geometry && z.bbox, `${z.id} incomplete`);
    assert.equal(z.dangerLevel, -1);
    assert.equal(zoneState(z, NOW).kind, 'no-rating');
  }
  const hood = zones.find((z) => z.name === 'Mt Hood');
  assert.equal(hood.offSeason, true);
  assert.match(zoneLine(hood, NOW), /off season/i);
});

test('a feature with no name, no geometry or a non-number danger level is dropped and counted', () => {
  const got = readZones(fc(zone({ name: '' }), { type: 'Feature', properties: zone({}).properties, geometry: null },
    zone({ danger_level: 'high' }), zone({})));
  assert.equal(got.length, 1);
  assert.equal(readZones(fc()).length, 0);
  assert.equal(readZones(null).length, 0);
  assert.equal(readZones({ error: 'x' }).length, 0);
});

test('a rating is current only inside its window; past its expiry it is not shown as a rating', () => {
  const [z] = readZones(fc(zone({})));
  assert.equal(zoneState(z, Date.UTC(2026, 9, 21, 12)).kind, 'rated');
  // Expired: the colour goes and the line says the rating expired, never "considerable".
  const late = zoneState(z, Date.UTC(2026, 9, 22, 7));
  assert.equal(late.kind, 'expired');
  assert.doesNotMatch(zoneLine(z, Date.UTC(2026, 9, 22, 7)), /considerable/i);
  assert.equal(zoneStyle(z, Date.UTC(2026, 9, 22, 7)).fillOpacity, 0);
  // A rating with no expiry cannot be expired, so it is never presented as current.
  const [open] = readZones(fc(zone({ end_date: null })));
  assert.equal(zoneState(open, NOW).kind, 'undated');
  assert.equal(zoneStyle(open, NOW).fillOpacity, 0);
  assert.doesNotMatch(zoneLine(open, NOW), /considerable/i);
});

test('the feed states no time zone on its dates, so expiry reads them as UTC, the earliest US reading', () => {
  // 2026-10-22T06:00:00 read as UTC expires at 06:00Z; read as Denver local it would last to 12:00Z.
  const [z] = readZones(fc(zone({})));
  assert.equal(zoneState(z, Date.UTC(2026, 9, 22, 6, 1)).kind, 'expired');
  assert.match(zoneLine(z, NOW), /2026-10-22 06:00/);
  assert.match(LAYER_CAVEAT, /time zone/i);
});

test('the style is the publisher\'s: its colour, black outline, red and thick for EXTREME, blue for no rating', () => {
  const at = Date.UTC(2026, 9, 21, 12);
  const [rated] = readZones(fc(zone({})));
  const s = zoneStyle(rated, at);
  assert.equal(s.fillColor, '#f7941e');
  assert.equal(s.color, '#000000');
  assert.ok(s.fillOpacity > 0);
  const [extreme] = readZones(fc(zone({ danger: 'extreme', danger_level: 5, color: '#231f20' })));
  const e = zoneStyle(extreme, at);
  assert.equal(e.color, '#ff0000');
  assert.ok(e.weight > s.weight);
  const [none] = readZones(LIVE);
  const n = zoneStyle(none, NOW);
  assert.equal(n.fillColor, '#888888');
  assert.equal(n.color, '#104efb');
});

test('each zone line names the zone, the centre and the rating, and links to the centre\'s forecast', () => {
  const [z] = readZones(fc(zone({ warning: { product: 'warning' } })));
  const line = zoneLine(z, Date.UTC(2026, 9, 21, 12));
  assert.match(line, /Test Zone/);
  assert.match(line, /Test Avalanche Center/);
  assert.match(line, /considerable \(3 of 5\)/i);
  assert.match(line, /avalanche warning/i);
  assert.match(line, /https:\/\/example\.org\/forecast/);
  // No information at all (expired): link the centre's home page, per the guide.
  assert.match(zoneLine(z, Date.UTC(2026, 9, 23)), /https:\/\/example\.org\/(?!forecast)/);
});

test('the view picks the zones whose box meets it; the report orders them by danger', () => {
  const zones = readZones(LIVE);
  assert.deepEqual(zonesInView(zones, HOOD).map((z) => z.name), ['Mt Hood']);
  assert.deepEqual(zonesInView(zones, { minLon: -80, minLat: 35, maxLon: -79, maxLat: 36 }), []);
  const at = Date.UTC(2026, 9, 21, 12);
  const mixed = readZones(fc(zone({ id: 1, name: 'Low One', danger: 'low', danger_level: 1 }),
    zone({ id: 2, name: 'High One', danger: 'high', danger_level: 4 })));
  const text = areaReport({ status: 'ok', zones: mixed }, at).text;
  assert.ok(text.indexOf('High One') < text.indexOf('Low One'));
  assert.match(text, /full forecast/i);
});

test('an empty view is outside every forecast area, never "safe"; a failed read says it failed', () => {
  const empty = areaReport({ status: 'ok', zones: [] }, NOW).text;
  assert.equal(empty, EMPTY_TEXT);
  assert.match(empty, /no forecast/i);
  assert.equal(areaReport({ status: 'failed' }, NOW).text, FAILED_TEXT);
  assert.equal(areaReport(null, NOW).text, FAILED_TEXT);
  for (const s of readerStrings(NOW)) assert.doesNotMatch(s, /\bsafe to\b|\bno avalanche danger\b/i, s);
});

test('the national file is fetched once and reused, a failure is not cached', async () => {
  let calls = 0, ok = false, clock = NOW;
  const fetchImpl = async () => { calls += 1; return ok ? { ok: true, json: async () => LIVE } : { ok: false }; };
  const store = createZoneStore({ fetchImpl, now: () => clock });
  assert.equal((await store.get()).status, 'failed');
  ok = true;
  assert.equal((await store.get()).zones.length, 3);
  await store.get();
  assert.equal(calls, 2, 'a success is reused');
  clock += SOURCES.avalancheOrgZones.limits.reuseSeconds * 1000 + 1;
  await store.get();
  assert.equal(calls, 3, 'and asked again once it is old');
});

test('the label and caveat say what this is and is not', () => {
  assert.match(LAYER_LABEL, /avalanche/i);
  assert.match(LAYER_CAVEAT, /full forecast/i);
  assert.match(LAYER_CAVEAT, /avalanche\.org/);
  assert.match(LAYER_CAVEAT, /screen only/i);
});

test('the reader answers only the zones in the view it was asked about', async () => {
  const { avalancheReader } = await import('../../themes/headlessmode/static/js/quiet-corners-maps/source-avalanche.js');
  const store = { get: async () => ({ status: 'ok', zones: readZones(LIVE) }) };
  const reads = avalancheReader({ store, waitMs: 0 });
  let got = null;
  await reads.ask(HOOD, (g) => { got = g; });
  assert.deepEqual(got.zones.map((z) => z.name), ['Mt Hood']);
  const failing = avalancheReader({ store: { get: async () => ({ status: 'failed' }) }, waitMs: 0 });
  await failing.ask(HOOD, (g) => { got = g; });
  assert.equal(areaReport(got).text, FAILED_TEXT);
});
