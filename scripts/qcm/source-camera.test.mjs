// Caltrans CWWP2 CCTV adapter, against the bytes the district feeds actually returned. No
// network. Fixtures are real, minimized live captures (2026-09-27, 19:49:02-19:49:06 UTC, curl
// -H 'Origin: https://headlessmode.com' against cwwp2.dot.ca.gov/data/d{5,7}/cctv/...json,
// Access-Control-Allow-Origin: * confirmed on both) -- see scripts/qcm/fixtures/
// caltrans-cctv-d05-2026-09-27.min.json and caltrans-cctv-d07-2026-09-27.min.json, and
// source-camera.js's own header comment for the full provenance and the recordTimestamp finding.
//
// D05 keeps index 1 (the road pilot, live-confirmed) and index 37 (a real inService: "false"
// record, US-101 Cabrillo Blvd / Santa Barbara). D07 keeps index 1130 and 1138 (the two dead
// feeds -- inService: "true" but the actual image is a "Temporarily Unavailable" placeholder)
// and index 67 (a real record whose streamingVideoURL is an empty string, for the
// stream-absent case).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeCaltransCctvRecord, normalizeCaltransCctv, normalizeNpsWebcamRecord,
  normalizeNpsWebcams, repairNpsImageHost, npsCuratedStills, npsStateOf }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/source-camera.js';

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const D05 = read('fixtures/caltrans-cctv-d05-2026-09-27.min.json');
const D07 = read('fixtures/caltrans-cctv-d07-2026-09-27.min.json');
const cctv = (payload, index) => payload.data.find((row) => row.cctv.index === index).cctv;

const PILOT = cctv(D05, '1');                 // US-101 : North Main Street, Salinas -- live
const OUT_OF_SERVICE = cctv(D05, '37');        // US-101 : Cabrillo Blvd -- inService: "false"
const BIG_ROCK = cctv(D07, '1130');            // dead feed #1
const MALIBU_PIER = cctv(D07, '1138');         // dead feed #2
const NO_STREAM = cctv(D07, '67');             // I-5 : (67) Penrose Street -- streamingVideoURL: ""
const FETCHED_AT = '2026-09-27T19:50:00Z';

test('the road pilot maps lat/lon, still, stream and operator exactly', () => {
  const r = normalizeCaltransCctvRecord(PILOT, { fetchedAt: FETCHED_AT });
  assert.equal(r.provider, 'caltrans-cwwp2');
  assert.equal(r.providerId, '1');
  assert.equal(r.name, 'US-101 : North Main Street');
  assert.equal(typeof r.lat, 'number');
  assert.equal(typeof r.lon, 'number');
  assert.equal(r.lat, 36.687188);
  assert.equal(r.lon, -121.653231);
  assert.equal(r.operator, 'Caltrans');
  assert.equal(r.officialUrl, 'https://cwwp2.dot.ca.gov/documentation/cctv/cctv.htm');
  assert.equal(r.media.still, 'https://cwwp2.dot.ca.gov/data/d5/cctv/image/us101northmainstreet/us101northmainstreet.jpg');
  assert.equal(r.media.stream, 'https://wzmedia.dot.ca.gov/D5/101atMainSt-Route183.stream/playlist.m3u8');
  assert.equal(r.media.streamKind, 'hls');
  assert.equal(r.health, 'active');
  assert.equal(r.fetchedAt, FETCHED_AT);
  // recordTimestamp is a real field on the record, but it is a catalogue edit date, not a
  // per-image capture time (see source-camera.js's header comment and the ordering proof in
  // the dead-feed test below) -- mapping it into capturedAt would fabricate a false "captured"
  // date, so capturedAt stays null for every Caltrans record, including this live pilot.
  assert.equal(r.capturedAt, null);
});

test('inService: "false" becomes health: inactive and the record is kept, never dropped', () => {
  const r = normalizeCaltransCctvRecord(OUT_OF_SERVICE, { fetchedAt: FETCHED_AT });
  assert.equal(r.health, 'inactive');
  assert.equal(r.providerId, '37');
  assert.equal(r.name, 'US-101 : Cabrillo Blvd');
  // Out of service is a real, reportable state -- normalizeCaltransCctv must still return it.
  const all = normalizeCaltransCctv(D05, { fetchedAt: FETCHED_AT });
  assert.ok(all.some((rec) => rec.providerId === '37' && rec.health === 'inactive'),
    'the out-of-service record must survive normalizeCaltransCctv, not be filtered out');
});

test('an empty streamingVideoURL becomes media.stream: null, not an empty string', () => {
  const r = normalizeCaltransCctvRecord(NO_STREAM, { fetchedAt: FETCHED_AT });
  assert.equal(r.media.stream, null);
  assert.equal(r.media.streamKind, null);
  assert.equal(r.media.still, 'https://cwwp2.dot.ca.gov/data/d7/cctv/image/i567penrosestreet/i567penrosestreet.jpg');
});

test('the two dead feeds (inService: "true", placeholder image) normalize active -- the JSON alone cannot tell them apart from a live camera', () => {
  for (const [rec, name] of [[BIG_ROCK, 'Big Rock Beach'], [MALIBU_PIER, 'Malibu Pier']]) {
    const r = normalizeCaltransCctvRecord(rec, { fetchedAt: FETCHED_AT });
    assert.equal(r.health, 'active', `${name}: inService: "true" must still map to active -- the JSON carries no field that flags the placeholder`);
    assert.ok(r.media.still.length > 0, `${name}: still URL must still be produced so the card can attempt to load it`);
    // capturedAt must never be fabricated from recordTimestamp -- see the ordering proof below.
    assert.equal(r.capturedAt, null, `${name}: capturedAt must be null, not a catalogue edit date dressed up as a capture time`);
  }
  // Sharper, on the RAW fixture data (capturedAt itself is null on every record now, so the
  // proof has to read recordEpoch directly): the pilot's recordTimestamp (2025-02-27) is OLDER
  // than both dead feeds' (2026-01-08), so a staleness threshold on recordTimestamp would flag
  // the LIVE camera and miss the dead ones -- proof recordTimestamp cannot be a freshness
  // signal, which is exactly why it is never mapped into capturedAt.
  const pilotEpoch = Number(PILOT.recordTimestamp.recordEpoch);
  const bigRockEpoch = Number(BIG_ROCK.recordTimestamp.recordEpoch);
  assert.ok(pilotEpoch < bigRockEpoch,
    'the live pilot camera must carry an OLDER recordTimestamp than a dead feed, proving it is not a freshness signal');
});

test('a real record with a field removed must not throw', () => {
  const stripped = { ...PILOT, location: { ...PILOT.location } };
  delete stripped.location.latitude;
  delete stripped.location.longitude;
  assert.doesNotThrow(() => normalizeCaltransCctvRecord(stripped, { fetchedAt: FETCHED_AT }));
  const r = normalizeCaltransCctvRecord(stripped, { fetchedAt: FETCHED_AT });
  assert.equal(r.lat, null);
  assert.equal(r.lon, null);
  // A record with no coordinate has no location to be precise about -- 'exact' would be a
  // claim this record can't back (spec QUX-07-08.md:182,229-230).
  assert.equal(r.locationPrecision, null);
  assert.equal(r.name, 'US-101 : North Main Street', 'unrelated fields must still map');

  const noImageData = { ...PILOT };
  delete noImageData.imageData;
  assert.doesNotThrow(() => normalizeCaltransCctvRecord(noImageData, { fetchedAt: FETCHED_AT }));
  const r2 = normalizeCaltransCctvRecord(noImageData, { fetchedAt: FETCHED_AT });
  assert.equal(r2.media.still, null);
  assert.equal(r2.media.stream, null);
  assert.equal(r2.media.streamKind, null);

  const noInService = { ...PILOT };
  delete noInService.inService;
  assert.equal(normalizeCaltransCctvRecord(noInService, { fetchedAt: FETCHED_AT }).health, 'unknown');

  assert.equal(normalizeCaltransCctvRecord({}, { fetchedAt: FETCHED_AT }), null, 'no index at all is unusable, not fabricated');
  assert.doesNotThrow(() => normalizeCaltransCctv({}, { fetchedAt: FETCHED_AT }));
  assert.deepEqual(normalizeCaltransCctv({}, { fetchedAt: FETCHED_AT }), []);
  assert.doesNotThrow(() => normalizeCaltransCctv(null, { fetchedAt: FETCHED_AT }));
});

test('normalizeCaltransCctv returns every real record in a district payload', () => {
  const all = normalizeCaltransCctv(D07, { fetchedAt: FETCHED_AT });
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((r) => r.providerId).sort(), ['1130', '1138', '67']);
});

// -- NPS GRSM webcams -------------------------------------------------------------------------
// Fixture: fixtures/nps-webcams-grsm-2026-09-27.min.json, a real live capture (2026-09-27
// 18:34:30 UTC, developer.nps.gov/api/v1/webcams?parkCode=grsm, key omitted). All 6 real
// records, envelope and field names untouched -- see the fixture's own _captured field and
// source-camera.js's NPS header comment for full provenance.
const GRSM = read('fixtures/nps-webcams-grsm-2026-09-27.min.json');
const webcam = (id, urlContains) => GRSM.data.find((row) => row.id === id
  && (urlContains === undefined || row.url.includes(urlContains)));
const PURCHASE_KNOB = webcam('52E38701-AF1C-D2FC-3F23861BB6E221BB');  // Active, has images[], curated still
const LOOK_ROCK = webcam('6878C635-B83A-8F41-A6E3B0160539BEAA');      // Active, has images[], empty credit
const TWIN_CREEK = webcam('29A53AEC-1DD8-B71B-0BC49F5DA731C317');     // Inactive, null lat/lon, no images
const KUWOHI = webcam('BDFD47F3-1DD8-B71B-0B81AFE928DDCBCF');         // Inactive, null lat/lon
const NEWFOUND_GAP_FIRST = webcam('C589EEEF-1DD8-B71B-0B0463C308FF64DD', 'media/webcam/view.htm');
const FETCHED_AT_NPS = '2026-09-27T20:30:00Z';

test('a GRSM webcam maps id, name, coordinates, category, operator and health from the real record', () => {
  const r = normalizeNpsWebcamRecord(PURCHASE_KNOB, { fetchedAt: FETCHED_AT_NPS });
  assert.equal(r.provider, 'nps-grsm');
  assert.equal(r.providerId, '52E38701-AF1C-D2FC-3F23861BB6E221BB');
  assert.equal(r.name, 'Purchase Knob Webcam');
  assert.equal(r.lat, 35.58867834584287);
  assert.equal(r.lon, -83.07446926832199);
  assert.equal(r.category, 'scenic');
  assert.equal(r.operator, 'NPS Air Quality Network');
  assert.equal(r.health, 'active');
  assert.equal(r.fetchedAt, FETCHED_AT_NPS);
  // The API carries no per-image capture time -- never fabricate one, same rule as Caltrans.
  assert.equal(r.capturedAt, null);
});

test('the curated live park-page still wins over the stale, doubled-host images[].url (R2-G11)', () => {
  const r = normalizeNpsWebcamRecord(PURCHASE_KNOB, { fetchedAt: FETCHED_AT_NPS });
  assert.equal(r.media.still, 'https://www.nps.gov/featurecontent/ard/webcams/images/grpklarge.jpg');
  assert.notEqual(r.media.still, PURCHASE_KNOB.images[0].url,
    'must not be the stale API thumbnail, doubled host or not');
  // Every real GRSM record's isStreaming is false -- never build a stream path this feed cannot back.
  assert.equal(r.media.stream, null);
  assert.equal(r.media.streamKind, null);
});

test('repairNpsImageHost strips the real doubled nps.gov host prefix, once, on the real image URL', () => {
  const raw = PURCHASE_KNOB.images[0].url;
  assert.match(raw, /^https:\/\/www\.nps\.govhttps:\/\/www\.nps\.gov\//,
    'fixture must still carry the real upstream doubled-host bug');
  const fixed = repairNpsImageHost(raw);
  assert.equal(fixed,
    'https://www.nps.gov/common/uploads/cropped_image/6834522E-DD60-88CB-0B234B70870F68FD.jpg');
  // A URL that was never doubled passes through unchanged -- not a second repair pass.
  assert.equal(repairNpsImageHost(fixed), fixed);
  assert.equal(repairNpsImageHost(null), null);
});

test('empty credit falls back to "National Park Service" plus the related park\'s name, never blank', () => {
  const r = normalizeNpsWebcamRecord(LOOK_ROCK, { fetchedAt: FETCHED_AT_NPS });
  assert.equal(LOOK_ROCK.credit, '', 'fixture must still carry the real empty-credit case');
  assert.equal(r.attribution, 'National Park Service — Great Smoky Mountains National Park');
  // Look Rock carries real coordinates -- it should claim the precision it actually has.
  assert.equal(r.locationPrecision, 'exact');
});

test('an inactive record with null lat/lon is kept, not dropped, and never plots at 0,0', () => {
  assert.equal(TWIN_CREEK.latitude, null);
  assert.equal(TWIN_CREEK.longitude, null);
  const r = normalizeNpsWebcamRecord(TWIN_CREEK, { fetchedAt: FETCHED_AT_NPS });
  assert.equal(r.health, 'inactive');
  // Decision: keep-with-null. Twin Creek is a real camera the park lists; dropping it would hide
  // that it exists, and Number(null) === 0 would silently plot it in the Gulf of Guinea -- the
  // exact bug this test exists to catch.
  assert.equal(r.lat, null);
  assert.equal(r.lon, null);
  assert.notEqual(r.lat, 0);
  assert.notEqual(r.lon, 0);
  // No coordinate means no location precision to claim (spec QUX-07-08.md:182,229-230) --
  // 'exact' would assert a location this record doesn't have.
  assert.equal(r.locationPrecision, null);
  const all = normalizeNpsWebcams(GRSM, { fetchedAt: FETCHED_AT_NPS });
  assert.ok(all.some((rec) => rec.providerId === TWIN_CREEK.id && rec.lat === null),
    'the null-coordinate inactive record must survive normalizeNpsWebcams, not be filtered out');
  // A second, independent null-coordinate camera proves this is a general rule, not a one-off.
  const kuwohi = normalizeNpsWebcamRecord(KUWOHI, { fetchedAt: FETCHED_AT_NPS });
  assert.equal(kuwohi.lat, null);
  assert.equal(kuwohi.lon, null);
  assert.equal(kuwohi.health, 'inactive');
  assert.equal(kuwohi.locationPrecision, null);
});

test('Twin Creek has no curated still and no API image -- media.still stays null, never invented', () => {
  assert.deepEqual(TWIN_CREEK.images, []);
  const r = normalizeNpsWebcamRecord(TWIN_CREEK, { fetchedAt: FETCHED_AT_NPS });
  assert.equal(r.media.still, null);
});

test('Newfound Gap has no images[] either, but still gets its curated live still (R2-G11)', () => {
  assert.deepEqual(NEWFOUND_GAP_FIRST.images, []);
  const r = normalizeNpsWebcamRecord(NEWFOUND_GAP_FIRST, { fetchedAt: FETCHED_AT_NPS });
  assert.equal(r.media.still, 'https://www.nps.gov/featurecontent/ard/webcams/images/gsnglarge.jpg');
});

test('the duplicate Newfound Gap entry collapses to one record, keeping the first occurrence', () => {
  const all = normalizeNpsWebcams(GRSM, { fetchedAt: FETCHED_AT_NPS });
  assert.equal(all.length, 5, 'six raw records, one real duplicate id, five normalized cameras');
  const newfoundGaps = all.filter((r) => r.providerId === 'C589EEEF-1DD8-B71B-0B0463C308FF64DD');
  assert.equal(newfoundGaps.length, 1);
  // First occurrence wins deterministically: its url is the specific per-camera page, not the
  // second entry's generic ?site=grsm listing page.
  assert.equal(newfoundGaps[0].officialUrl, NEWFOUND_GAP_FIRST.url);
  assert.deepEqual(all.map((r) => r.providerId).sort(), [
    '29A53AEC-1DD8-B71B-0BC49F5DA731C317',
    '52E38701-AF1C-D2FC-3F23861BB6E221BB',
    '6878C635-B83A-8F41-A6E3B0160539BEAA',
    'BDFD47F3-1DD8-B71B-0B81AFE928DDCBCF',
    'C589EEEF-1DD8-B71B-0B0463C308FF64DD',
  ].sort());
});

test('rights stays unverified, the same vocabulary as Caltrans, never a claimed public-domain grant', () => {
  const r = normalizeNpsWebcamRecord(PURCHASE_KNOB, { fetchedAt: FETCHED_AT_NPS });
  assert.equal(r.rights, 'unverified');
});

test('officialUrl falls back to the GRSM webcams page when a record carries no url', () => {
  const noUrl = { ...PURCHASE_KNOB };
  delete noUrl.url;
  const r = normalizeNpsWebcamRecord(noUrl, { fetchedAt: FETCHED_AT_NPS });
  assert.equal(r.officialUrl, 'https://www.nps.gov/grsm/learn/photosmultimedia/webcams.htm');
});

test('a malformed NPS record must not throw and produces no bogus record', () => {
  assert.equal(normalizeNpsWebcamRecord({}, { fetchedAt: FETCHED_AT_NPS }), null,
    'no id at all is unusable, not fabricated');
  assert.doesNotThrow(() => normalizeNpsWebcams({}, { fetchedAt: FETCHED_AT_NPS }));
  assert.deepEqual(normalizeNpsWebcams({}, { fetchedAt: FETCHED_AT_NPS }), []);
  assert.doesNotThrow(() => normalizeNpsWebcams(null, { fetchedAt: FETCHED_AT_NPS }));

  const stripped = { ...PURCHASE_KNOB };
  delete stripped.relatedParks;
  delete stripped.images;
  assert.doesNotThrow(() => normalizeNpsWebcamRecord(stripped, { fetchedAt: FETCHED_AT_NPS }));
  const r = normalizeNpsWebcamRecord(stripped, { fetchedAt: FETCHED_AT_NPS });
  assert.equal(r.media.still, 'https://www.nps.gov/featurecontent/ard/webcams/images/grpklarge.jpg',
    'the curated still map keys off the camera id, not relatedParks or images');
  assert.equal(r.attribution, 'National Park Service', 'no relatedParks means no park name to append');
});

test('D12: an unmapped camera id never falls back to images[0].url -- link-only, not invented', () => {
  // No real GRSM fixture record can exercise this path: every unmapped record (Twin Creek) also
  // has images: [], and every record with a non-empty images[] (Purchase Knob, Look Rock) is
  // mapped in LIVE_STILL_BY_ID. A synthetic record is the only way to cover a mapped-absent id
  // paired with a non-empty images[] -- exactly the combination the old fallback mishandled.
  const UNMAPPED_WITH_IMAGES = {
    ...PURCHASE_KNOB,
    id: 'D12-SYNTHETIC-UNMAPPED-ID-0000000000000000',
    title: 'Synthetic Unmapped Webcam',
  };
  assert.ok(Array.isArray(UNMAPPED_WITH_IMAGES.images) && UNMAPPED_WITH_IMAGES.images.length > 0,
    'fixture must still carry a non-empty images[] for this to be a meaningful regression test');
  const r = normalizeNpsWebcamRecord(UNMAPPED_WITH_IMAGES, { fetchedAt: FETCHED_AT_NPS });
  assert.equal(r.media.still, null,
    'an id absent from the curated live-still map must never fall back to the stale images[0].url');
  assert.notEqual(r.media.still, UNMAPPED_WITH_IMAGES.images[0].url);
});

// ---------------------------------------------------------------------------------------------
// Camera U3: all 12 Caltrans districts. Each fixture is a real, minimised capture of that
// district's feed (2026-10-04): the first record, the four extreme-latitude/longitude records, an
// out-of-service record and a no-stream record where the district has one (D07 also keeps the two
// placeholder feeds). Ids are district-prefixed because `index` is per district.
import { normalizeCaltransDistrict } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-camera.js';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';

const DISTRICTS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
const districtFixture = (nn) => read(`fixtures/caltrans-cctv-d${nn}-2026-10-04.min.json`);
const AREAS = Object.fromEntries(SOURCES.caltransCctv.coverageAreas.map((a) => [a.id, a]));

test('the registry names all 12 districts: an area box and a feed URL each, and the D5 serviceUrl is unchanged', () => {
  assert.equal(SOURCES.caltransCctv.serviceUrl, 'https://cwwp2.dot.ca.gov/data/d5/cctv/cctvStatusD05.json');
  assert.equal(SOURCES.caltransCctv.serviceUrls.length, 12);
  assert.equal(SOURCES.caltransCctv.coverageAreas.length, 12);
  for (const nn of DISTRICTS) {
    const area = AREAS[`ca-d${nn}`];
    assert.ok(area, `ca-d${nn} has a coverage area`);
    assert.equal(area.serviceUrl, `https://cwwp2.dot.ca.gov/data/d${Number(nn)}/cctv/cctvStatusD${nn}.json`);
    assert.ok(SOURCES.caltransCctv.serviceUrls.includes(area.serviceUrl));
    assert.ok(area.bbox.minLon < area.bbox.maxLon && area.bbox.minLat < area.bbox.maxLat, `ca-d${nn} box is ordered`);
  }
});

test('every district fixture normalizes with dNN: ids, the ca-dNN region and the Caltrans provider', () => {
  for (const nn of DISTRICTS) {
    const raw = districtFixture(nn);
    const records = normalizeCaltransDistrict(raw, nn, { fetchedAt: FETCHED_AT });
    assert.equal(records.length, raw.data.length, `d${nn}: no record dropped`);
    assert.ok(records.length >= 5, `d${nn}: a handful of records`);
    const ids = new Set();
    for (const r of records) {
      assert.match(r.providerId, new RegExp(`^d${nn}:\\d+$`), `d${nn}: ${r.providerId}`);
      assert.equal(r.region, `ca-d${nn}`);
      assert.equal(r.provider, 'caltrans-cwwp2');
      assert.equal(r.category, 'road');
      ids.add(r.providerId);
    }
    assert.equal(ids.size, records.length, `d${nn}: ids are unique`);
  }
});

test('every located record lies inside its district box, and the extremes are in the fixtures', () => {
  for (const nn of DISTRICTS) {
    const box = AREAS[`ca-d${nn}`].bbox;
    for (const r of normalizeCaltransDistrict(districtFixture(nn), nn, { fetchedAt: FETCHED_AT })) {
      if (r.lat === null || r.lon === null) continue;
      assert.ok(r.lon >= box.minLon && r.lon <= box.maxLon && r.lat >= box.minLat && r.lat <= box.maxLat,
        `${r.providerId} (${r.lat}, ${r.lon}) is outside ca-d${nn}`);
    }
  }
});

test('a district number from the feed URL may be 5 or "05"; the same camera gets the same id', () => {
  const a = normalizeCaltransDistrict(D05, 5, { fetchedAt: FETCHED_AT });
  const b = normalizeCaltransDistrict(D05, '05', { fetchedAt: FETCHED_AT });
  assert.deepEqual(a, b);
  assert.equal(a.find((r) => r.name === 'US-101 : Cabrillo Blvd').providerId, 'd05:37');
  // The single-record adapter the live D5 layer uses today is untouched: bare index, no region.
  assert.equal(normalizeCaltransCctvRecord(OUT_OF_SERVICE, { fetchedAt: FETCHED_AT }).providerId, '37');
  assert.equal('region' in normalizeCaltransCctvRecord(OUT_OF_SERVICE, { fetchedAt: FETCHED_AT }), false);
});

test('D07 keeps the two placeholder feeds active and the out-of-service records inactive in every district', () => {
  const d07 = normalizeCaltransDistrict(districtFixture('07'), '07', { fetchedAt: FETCHED_AT });
  for (const id of ['d07:1130', 'd07:1138']) {
    assert.equal(d07.find((r) => r.providerId === id).health, 'active', id);
  }
  for (const nn of DISTRICTS) {
    const raw = districtFixture(nn);
    const off = raw.data.filter((row) => row.cctv.inService === 'false').length;
    const got = normalizeCaltransDistrict(raw, nn, { fetchedAt: FETCHED_AT }).filter((r) => r.health === 'inactive').length;
    assert.equal(got, off, `d${nn}: out-of-service records are kept as inactive`);
  }
});

test('an unknown district number or a payload that is not a feed gives no cameras, never an id with no district', () => {
  assert.deepEqual(normalizeCaltransDistrict(D05, 13), []);
  assert.deepEqual(normalizeCaltransDistrict(D05, undefined), []);
  assert.deepEqual(normalizeCaltransDistrict(null, 5), []);
  assert.deepEqual(normalizeCaltransDistrict({ data: 'nope' }, 5), []);
});

// camera U5: the same adapter serves the nationwide `nps-webcams` provider. Defaults stay the
// GRSM ones (the legacy cameras-nps-grsm.json is byte-stable); the build passes the nationwide
// provider id and operator, because "NPS Air Quality Network" is proven for four GRSM cameras only.
const NPS_FIXTURE = read('fixtures/nps-webcams-grsm-2026-09-27.min.json');
const NPS_OTHER_PARK = { id: 'SYNTH-1', title: 'Synthetic Arch cam', latitude: '38.7', longitude: '-109.6', status: 'Active',
  url: '', relatedParks: [{ states: 'UT', parkCode: 'arch', fullName: 'Arches National Park' }] };

test('U5: normalizeNpsWebcams defaults keep the GRSM provider and operator exactly', () => {
  const [r] = normalizeNpsWebcams(NPS_FIXTURE, { fetchedAt: FETCHED_AT });
  assert.equal(r.provider, 'nps-grsm');
  assert.equal(r.operator, 'NPS Air Quality Network');
});

test('U5: provider and operator can be overridden for the nationwide provider', () => {
  const r = normalizeNpsWebcamRecord(NPS_OTHER_PARK, { fetchedAt: FETCHED_AT, provider: 'nps-webcams', operator: 'National Park Service' });
  assert.equal(r.provider, 'nps-webcams');
  assert.equal(r.operator, 'National Park Service');
  assert.equal(r.attribution, 'National Park Service \u2014 Arches National Park');
});

test('U5: a record with no url links to its own park\'s webcam page, never to Great Smoky Mountains', () => {
  const r = normalizeNpsWebcamRecord(NPS_OTHER_PARK, { fetchedAt: FETCHED_AT, provider: 'nps-webcams' });
  assert.equal(r.officialUrl, 'https://www.nps.gov/arch/learn/photosmultimedia/webcams.htm');
  const bare = normalizeNpsWebcamRecord({ id: 'SYNTH-2', title: 'x' }, { fetchedAt: FETCHED_AT, provider: 'nps-webcams' });
  assert.equal(bare.officialUrl, 'https://www.nps.gov/');
  // The legacy default is unchanged.
  assert.equal(normalizeNpsWebcamRecord({ id: 'SYNTH-2', title: 'x' }, { fetchedAt: FETCHED_AT }).officialUrl,
    'https://www.nps.gov/grsm/learn/photosmultimedia/webcams.htm');
});

test('U5: an unmapped record is link-only; the curated map is the four proven GRSM stills and nothing else', () => {
  assert.equal(normalizeNpsWebcamRecord(NPS_OTHER_PARK, { fetchedAt: FETCHED_AT }).media.still, null);
  assert.deepEqual(Object.values(npsCuratedStills()).sort(), [
    'https://www.nps.gov/featurecontent/ard/webcams/images/grcdlarge.jpg',
    'https://www.nps.gov/featurecontent/ard/webcams/images/grpklarge.jpg',
    'https://www.nps.gov/featurecontent/ard/webcams/images/grsmlarge.jpg',
    'https://www.nps.gov/featurecontent/ard/webcams/images/gsnglarge.jpg']);
});

test('U5: npsStateOf is the first state of the first related park, lowercase, or null', () => {
  assert.equal(npsStateOf(NPS_FIXTURE.data[0]), 'nc');
  assert.equal(npsStateOf(NPS_OTHER_PARK), 'ut');
  assert.equal(npsStateOf({ id: 'x' }), null);
  assert.equal(npsStateOf({ id: 'x', relatedParks: [{ states: '' }] }), null);
  assert.equal(npsStateOf({ id: 'x', relatedParks: [{ states: 'ID,MT,WY' }] }), 'id');
});

// ---------------------------------------------------------------------------------------------
// Link-only cameras (HPWREN, AlertWest): a pin, the owner's credit and a link, never a picture.
// Fixtures are real captures, 2026-10-04: hpwren-sites-2026-10-04.min.js is the whole of
// https://www.hpwren.ucsd.edu/cameras/sites.js (82 sites) with its `var sites =` prefix intact;
// alertwest-cameras-2026-10-04.min.json is 16 verbatim rows of
// https://alertwest.live/api/firecams/v0/cameras (the live list has 1,899).
import { readFileSync as readText } from 'node:fs';
import { parseHpwrenSites, normalizeHpwrenSites, normalizeAlertWestCameras, isLinkOnly, LINK_ONLY_PROVIDERS,
  LINK_ROAD_LAYERS, normalizeLinkRoadCameras }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/source-camera.js';
import { stillPlan, cardLines, linkLabel }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/camera-layer.js';

const HPWREN_TEXT = readText(new URL('fixtures/hpwren-sites-2026-10-04.min.js', import.meta.url), 'utf8');
const AW = read('fixtures/alertwest-cameras-2026-10-04.min.json');
const LINK_FETCHED_AT = '2026-10-04T18:00:00Z';
const hpwren = (sites) => normalizeHpwrenSites(sites, { fetchedAt: LINK_FETCHED_AT });
const hpCam = (over = {}) => ({ name: 'Boucher Hill', owner: 'hpwren', active: 'y', experimental: 'n', ...over });
const hpSite = (cams, over = {}) => ({ name: 'Boucher Hill, on Palomar Mountain', lat: 33.33462, long: -116.91938, elev: 1664, cams, ...over });

test('link-only: parseHpwrenSites reads the real sites.js as data (82 sites), no eval', () => {
  const sites = parseHpwrenSites(HPWREN_TEXT);
  assert.equal(Object.keys(sites).length, 82);
  assert.equal(sites.bh.name, 'Boucher Hill, on Palomar Mountain');
  assert.equal(sites.bh.cams['bh-n-mobo-c'].owner, 'hpwren');
});

test('link-only: parseHpwrenSites tolerates a hand-written (non-JSON) object literal and refuses anything else', () => {
  const sloppy = "var sites = {\n  a: { name: 'Alpha Peak', lat: 33.1, long: -117.2, cams: { 'a-n': { name: 'Alpha', owner: 'hpwren', active: 'y', experimental: 'n', }, }, },\n};\n";
  assert.deepEqual(Object.keys(parseHpwrenSites(sloppy)), ['a']);
  assert.equal(parseHpwrenSites(sloppy).a.cams['a-n'].owner, 'hpwren');
  assert.equal(parseHpwrenSites('<html>403</html>'), null);
  assert.equal(parseHpwrenSites('var sites = process.exit(1);'), null, 'code is never run');
  assert.equal(parseHpwrenSites(''), null);
  assert.equal(parseHpwrenSites(undefined), null);
});

test('link-only: one HPWREN pin per site with a qualifying camera (active y, owner hpwren, experimental n)', () => {
  const records = hpwren(parseHpwrenSites(HPWREN_TEXT));
  assert.equal(records.length, 55, '55 of the 82 live sites have a qualifying camera');
  assert.equal(new Set(records.map((r) => r.providerId)).size, 55);
  const boucher = records.find((r) => r.providerId === 'bh');
  assert.equal(boucher.name, 'Boucher Hill, on Palomar Mountain');
  assert.equal(boucher.lat, 33.33462);
  assert.equal(boucher.lon, -116.91938);
  assert.equal(boucher.attribution, 'HPWREN, UC San Diego');
  assert.equal(boucher.operator, 'HPWREN');
  assert.equal(boucher.linkOnly, true);
  assert.equal(boucher.media.still, null);
  assert.equal(boucher.media.stream, null);
  assert.match(boucher.subject, /^Cameras: .*Boucher Hill/);
});

test('link-only: HPWREN excludes cameras owned by others, experimental and inactive ones, and sites left with none', () => {
  const records = hpwren({
    own: hpSite({ a: hpCam({ name: 'Own North' }), b: hpCam({ name: 'Own East' }) }),
    mixed: hpSite({ a: hpCam({ name: 'HPWREN view' }), b: hpCam({ name: 'ALERTCalifornia view', owner: 'alert' }),
      c: hpCam({ name: 'Trial view', experimental: 'y' }), d: hpCam({ name: 'Dark view', active: 'n' }) }),
    other: hpSite({ a: hpCam({ owner: 'alert' }) }),
    trial: hpSite({ a: hpCam({ experimental: 'y' }) }),
    dark: hpSite({ a: hpCam({ active: 'n' }) }),
    empty: hpSite({}),
  });
  assert.deepEqual(records.map((r) => r.providerId).sort(), ['mixed', 'own']);
  const mixed = records.find((r) => r.providerId === 'mixed');
  assert.equal(mixed.subject, 'Cameras: HPWREN view');
  for (const word of ['ALERTCalifornia', 'Trial', 'Dark']) assert.ok(!JSON.stringify(mixed).includes(word), `${word} leaked`);
  assert.equal(records.find((r) => r.providerId === 'own').subject, 'Cameras: Own North, Own East');
});

test('link-only: HPWREN repeated camera names are listed once, and a site without a position is not pinned', () => {
  const records = hpwren({
    one: hpSite({ a: hpCam(), b: hpCam(), c: hpCam({ name: 'Boucher Hill East' }) }),
    nowhere: hpSite({ a: hpCam() }, { lat: null }),
    blank: hpSite({ a: hpCam() }, { long: '' }),
  });
  assert.deepEqual(records.map((r) => r.providerId), ['one']);
  assert.equal(records[0].subject, 'Cameras: Boucher Hill, Boucher Hill East');
});

test('link-only: the HPWREN owner link is the camera page\'s own address for that site\'s qualifying cameras', () => {
  const records = hpwren({ bh: hpSite({ 'bh-n-mobo-c': hpCam(), 'bh-e-mobo-c': hpCam(), 'bh-x': hpCam({ owner: 'alert' }) }) });
  assert.equal(records[0].officialUrl,
    'https://www.hpwren.ucsd.edu/cameras/#mode=realTime&cams=bh_bh-n-mobo-c.bh_bh-e-mobo-c');
  for (const r of hpwren(parseHpwrenSites(HPWREN_TEXT))) {
    assert.match(r.officialUrl, /^https:\/\/www\.hpwren\.ucsd\.edu\/cameras\/#mode=realTime&cams=/);
  }
});

test('link-only: HPWREN carries only id, name, position, credit, link, flag and the camera names', () => {
  const [r] = hpwren({ bh: hpSite({ a: hpCam({ imager: 'color', azimuth: 90, noa: 'n', agl: 35 }) }, { elev: 1664 }) });
  const text = JSON.stringify(r);
  for (const word of ['elev', '1664', 'azimuth', 'imager', 'agl', 'noa']) assert.ok(!text.includes(word), `${word} leaked`);
  assert.equal(r.bearing, null);
  assert.equal(r.capturedAt, null);
  assert.equal(r.health, 'active');
});

test('link-only: AlertWest keeps non-California US cameras, one pin each, and discards every image URL', () => {
  const records = normalizeAlertWestCameras(AW, { fetchedAt: LINK_FETCHED_AT });
  assert.equal(AW.length, 16);
  assert.equal(records.length, 12, 'three California rows and one Alberta row are dropped');
  const names = records.map((r) => r.name);
  assert.ok(!names.includes('Axis-MtAukum1'), 'California is ALERTCalifornia\'s');
  assert.ok(!names.includes('Axis-VirginiaHills2'), 'Alberta is not a US state');
  const text = JSON.stringify(records);
  for (const word of ['weathernode', '.jpg', 'prod.', 'Brand', 'SerialNumber', 'pan', 'tilt']) {
    assert.ok(!text.includes(word), `${word} leaked into a record`);
  }
  const nv = records.find((r) => r.name === 'Axis-Montezuma');
  assert.equal(nv.lat, 37.7008);
  assert.equal(nv.lon, -117.3838);
  assert.equal(nv.attribution, 'AlertWest');
  assert.equal(nv.operator, 'AlertWest');
  assert.equal(nv.officialUrl, 'https://alertwest.live/');
  assert.equal(nv.linkOnly, true);
  assert.equal(nv.media.still, null);
  assert.equal(nv.media.stream, null);
});

test('link-only: AlertWest drops a row with no position, no state or a state that is not a US state', () => {
  const row = (over, state = 'NV') => ({ name: 'Axis-X', site: { id: '1', latitude: '39.0', longitude: '-119.0', state, ...over },
    image: { url: 'https://prod.weathernode.net/x.jpg' } });
  const out = normalizeAlertWestCameras([row({}), row({ latitude: null }), row({ longitude: '' }), row({}, null),
    row({}, 'AB'), row({}, 'ca'), row({ id: '2' }, 'nv')], { fetchedAt: LINK_FETCHED_AT });
  assert.deepEqual(out.map((r) => r.providerId), ['1:Axis-X', '2:Axis-X']);
  assert.deepEqual(normalizeAlertWestCameras({ not: 'a list' }), []);
  assert.deepEqual(normalizeAlertWestCameras(null), []);
});

test('link-only: the providers are named, and isLinkOnly also holds for a record the snapshot format has flattened', () => {
  assert.deepEqual([...LINK_ONLY_PROVIDERS].sort(),
    ['alertwest', 'deldot', 'hpwren', 'mdchart', 'modot', 'njta', 'nmroads']);
  for (const layer of LINK_ROAD_LAYERS) assert.equal(isLinkOnly({ provider: layer.id }), true, layer.id);
  assert.equal(isLinkOnly({ provider: 'hpwren' }), true);
  assert.equal(isLinkOnly({ provider: 'alertwest', linkOnly: undefined }), true);
  assert.equal(isLinkOnly({ provider: 'nps-grsm', linkOnly: true }), true);
  assert.equal(isLinkOnly({ provider: 'caltrans-cwwp2' }), false);
  assert.equal(isLinkOnly(null), false);
});

test('link-only card: no picture, no request, whatever the record claims', () => {
  const [pin] = hpwren({ bh: hpSite({ a: hpCam() }) });
  assert.equal(stillPlan(pin), 'link');
  // Even a record that somehow carries a still must not be painted or fetched.
  for (const provider of LINK_ONLY_PROVIDERS) {
    assert.equal(stillPlan({ provider, health: 'active', linkOnly: true, media: { still: 'https://example.test/x.jpg' } }), 'link');
    assert.equal(stillPlan({ provider, health: 'active', media: { still: 'https://example.test/x.jpg' } }), 'link');
  }
});

test('link-only card: name, credit, camera names and a "View on" link; the no-picture line says why in plain words', () => {
  const [pin] = hpwren({ bh: hpSite({ a: hpCam({ name: 'Boucher Hill' }) }) });
  const lines = cardLines(pin, { generatedAt: LINK_FETCHED_AT });
  assert.equal(lines[0], 'Boucher Hill, on Palomar Mountain');
  assert.ok(lines.includes('HPWREN, UC San Diego'));
  assert.ok(lines.includes('Cameras: Boucher Hill'));
  assert.ok(lines.some((l) => /not shown here/.test(l) && /HPWREN/.test(l)));
  assert.ok(!lines.includes('No picture is published for this camera.'), 'the generic line would be wrong here');
  assert.equal(linkLabel(pin), 'View on HPWREN');
  const [aw] = normalizeAlertWestCameras(AW, { fetchedAt: LINK_FETCHED_AT });
  assert.equal(linkLabel(aw), 'View on AlertWest');
  assert.ok(cardLines(aw, {}).includes('AlertWest'));
  assert.equal(linkLabel({ provider: 'caltrans-cwwp2', operator: 'Caltrans' }), null, 'other providers keep their own link text');
});

// Link-only road operators (camera c8): MoDOT, Maryland CHART, DelDOT, NMRoads and NJTA publish
// a camera list but their pictures cannot be hotlinked. The normaliser keeps a name, a position and
// the owner's link; no picture or stream address survives it.
const roadLayer = (id) => LINK_ROAD_LAYERS.find((l) => l.id === id);
const roadAt = '2026-10-04T18:00:00Z';

test('link-only roads: five layers, each with one state, an https list and page, and a credit', () => {
  assert.deepEqual(LINK_ROAD_LAYERS.map((l) => l.id), ['modot', 'mdchart', 'deldot', 'nmroads', 'njta']);
  assert.deepEqual(LINK_ROAD_LAYERS.map((l) => l.state), ['mo', 'md', 'de', 'nm', 'nj']);
  for (const l of LINK_ROAD_LAYERS) {
    assert.match(l.sourceUrl, /^https:\/\//);
    assert.match(l.officialUrl, /^https:\/\//);
    assert.ok(l.operator && l.label);
    assert.equal(typeof l.parse, 'function');
  }
});

test('link-only roads: a record is a pin and a link -- still null, rights unverified, no stream, road category', () => {
  const rows = [{ id: 'a', name: 'I-70 at Exit 5', lat: 38.6, lon: -90.2, url: null, active: true }];
  const [r] = normalizeLinkRoadCameras(rows, roadLayer('modot'), { fetchedAt: roadAt });
  assert.equal(r.provider, 'modot');
  assert.equal(r.providerId, 'a');
  assert.equal(r.category, 'road');
  assert.equal(r.rights, 'unverified');
  assert.equal(r.linkOnly, true);
  assert.deepEqual(r.media, { still: null, stream: null, streamKind: null });
  assert.equal(r.officialUrl, roadLayer('modot').officialUrl);
  assert.equal(r.attribution, roadLayer('modot').operator);
  assert.equal(r.health, 'active');
  assert.equal(r.fetchedAt, roadAt);
});

test('link-only roads: a row without a name or a real position is dropped; a foreign page address is not kept', () => {
  const layer = roadLayer('mdchart');
  const rows = [
    { id: 'n', name: '', lat: 39, lon: -76 },
    { id: 'p', name: 'No position', lat: null, lon: -76 },
    { id: 'z', name: 'Zero', lat: 0, lon: 0 },
    { id: 'u', name: 'Foreign link', lat: 39.1, lon: -76.1, url: 'https://evil.example.test/page' },
    { id: 'h', name: 'Plain http', lat: 39.2, lon: -76.2, url: 'http://chart.maryland.gov/Video/GetVideo/h' },
    { id: 'g', name: 'Good link', lat: 39.3, lon: -76.3, url: 'https://chart.maryland.gov/Video/GetVideo/g' },
  ];
  const out = normalizeLinkRoadCameras(rows, layer, { fetchedAt: roadAt });
  assert.deepEqual(out.map((r) => r.providerId), ['u', 'h', 'g']);
  assert.equal(out[0].officialUrl, layer.officialUrl);
  assert.equal(out[1].officialUrl, layer.officialUrl);
  assert.equal(out[2].officialUrl, 'https://chart.maryland.gov/Video/GetVideo/g');
});

test('link-only roads: an active pin is kept over an inactive one within 30 m', () => {
  const layer = roadLayer('mdchart');
  const rows = [{ id: 'a', name: 'A', lat: 39, lon: -76.5, active: false }, { id: 'b', name: 'B', lat: 39.0001, lon: -76.5, active: true }];
  const out = normalizeLinkRoadCameras(rows, layer, { fetchedAt: roadAt });
  assert.deepEqual(out.map((r) => [r.providerId, r.health]), [['b', 'active']]);
});

test('link-only roads: same id is one pin, and pins of one operator within 30 m are one pin', () => {
  const layer = roadLayer('deldot');
  const rows = [
    { id: 'a', name: 'A', lat: 39.0, lon: -75.5 },
    { id: 'a', name: 'A again', lat: 39.5, lon: -75.5 },
    { id: 'b', name: 'B, 11 m north', lat: 39.0001, lon: -75.5 },
    { id: 'c', name: 'C, 111 m north', lat: 39.001, lon: -75.5 },
  ];
  assert.deepEqual(normalizeLinkRoadCameras(rows, layer, { fetchedAt: roadAt }).map((r) => r.providerId), ['a', 'c']);
});

test('link-only roads: an out-of-service row keeps its pin as inactive; non-lists normalize to []', () => {
  const layer = roadLayer('deldot');
  const [r] = normalizeLinkRoadCameras([{ id: 'a', name: 'A', lat: 39, lon: -75.5, active: false }], layer, { fetchedAt: roadAt });
  assert.equal(r.health, 'inactive');
  assert.deepEqual(normalizeLinkRoadCameras(null, layer), []);
  assert.deepEqual(normalizeLinkRoadCameras({}, layer), []);
});

test('link-only roads: the parsers read each owner\'s list shape and refuse any other', () => {
  const j = (f) => JSON.parse(readText(new URL(`fixtures/${f}`, import.meta.url), 'utf8'));
  const t = (f) => readText(new URL(`fixtures/${f}`, import.meta.url), 'utf8');
  assert.equal(roadLayer('modot').parse(j('c8-modot-streamingcams-2026-10-04.min.json')).length, 3);
  assert.equal(roadLayer('mdchart').parse(j('c8-mdchart-cameras-2026-10-04.min.json')).length, 3);
  assert.equal(roadLayer('deldot').parse(j('c8-deldot-videocamera-2026-10-04.min.json')).length, 3);
  assert.equal(roadLayer('nmroads').parse(j('c8-nmroads-camerainfo-2026-10-04.min.json')).length, 3);
  assert.equal(roadLayer('njta').parse(t('c8-njta-camera-list-2026-10-04.html')).length, 5);
  for (const l of LINK_ROAD_LAYERS) {
    assert.equal(l.parse(null), null, l.id);
    assert.equal(l.parse(l.id === 'njta' ? '<html>sign in</html>' : { error: 'x' }), null, l.id);
  }
});

test('link-only roads: the card shows no picture and a "View on" link for every operator', () => {
  for (const l of LINK_ROAD_LAYERS) {
    const [r] = normalizeLinkRoadCameras([{ id: 'a', name: 'Cam', lat: 39, lon: -75.5 }], l, { fetchedAt: roadAt });
    assert.equal(stillPlan({ ...r, media: { still: 'https://example.test/x.jpg' } }), 'link');
    assert.equal(linkLabel(r), `View on ${l.operator}`);
    assert.ok(cardLines(r, {}).every((line) => !/\.(jpe?g|png)\b/i.test(line)));
  }
});

// ---------------------------------------------------------------------------------------------
// ArcGIS REST camera layers: one adapter, one field map per operator. The fixture is real rows,
// copied unchanged from each layer's own query answer on 2026-10-04 (`query?where=1=1&outSR=4326
// &f=json`), including the rows the adapter must refuse: a second picture host, a plain-http
// address, a camera the operator marks offline or retired, a doubled slash in the path.
import { ARCGIS_LAYERS, normalizeArcgisCameras }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/source-camera.js';

const AG = { ...read('fixtures/arcgis-cameras-2026-10-04.min.json'), ...read('fixtures/arcgis-small-2026-10-05.min.json') };
const AG_AT = '2026-10-04T18:00:00Z';
const layerOf = (id) => ARCGIS_LAYERS.find((l) => l.id === id);
const agRecords = (id, payload = { features: AG[id] }) => normalizeArcgisCameras(payload, layerOf(id), { fetchedAt: AG_AT });

test('arcgis: seven operators, each its own provider id sharing one adapter', () => {
  assert.deepEqual(ARCGIS_LAYERS.map((l) => l.id),
    ['ky-kytc', 'tx-arlington', 'ks-lawrence', 'or-salem', 'or-tripcheck', 'ut-udot', 'wa-kirkland']);
  for (const l of ARCGIS_LAYERS) {
    assert.match(l.serviceUrl, /^https:\/\/[a-z0-9.]+\/[A-Za-z0-9]+\/(arcgis|ArcGIS)\/rest\/services\/[A-Za-z0-9_]+\/FeatureServer\/\d+$/, l.id);
    assert.ok(l.outFields.length > 0 && l.outFields.every((f) => /^[A-Za-z_]+$/.test(f)), `${l.id} asks for named fields only`);
    assert.ok(!l.outFields.includes('*'), `${l.id} never asks for every field`);
    assert.ok(Number.isInteger(l.pageSize) && l.pageSize >= 100 && l.pageSize <= 2000, l.id);
    assert.ok(l.states.length >= 1 && l.states.every((s) => /^[a-z]{2}$/.test(s)), l.id);
    assert.equal(typeof l.read, 'function');
    assert.ok(l.operator && l.label && /^https:\/\//.test(l.officialUrl), `${l.id} names its operator and public page`);
  }
});

test('arcgis: every picture host is an exact registry entry (img only, no wildcard, no connect-src)', () => {
  for (const l of ARCGIS_LAYERS) {
    const src = SOURCES[l.sourceId];
    assert.ok(src, `${l.id} has no registry entry ${l.sourceId}`);
    assert.equal(src.kind, 'camera-feed');
    assert.equal(src.paintedAs, 'img');
    assert.equal(src.cors, 'none');
    assert.equal(src.origin, l.imageOrigin);
    assert.match(src.origin, /^https:\/\/[a-z0-9.-]+$/, 'an exact https origin, never a wildcard');
    assert.ok(!src.origin.includes('*'));
    assert.equal(src.metadataUrl, l.serviceUrl);
    assert.equal(src.attribution, l.operator);
  }
  assert.equal(new Set(ARCGIS_LAYERS.map((l) => l.imageOrigin)).size, 7);
});

test('arcgis: Kentucky keeps https www.trimarc.org rows the operator marks online; http, other hosts and Offline are dropped', () => {
  const rows = agRecords('ky-kytc');
  assert.equal(AG['ky-kytc'].length, 7);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.media.still.startsWith('https://www.trimarc.org/images/')));
  assert.equal(rows[0].name, 'I-71 at Old Brownsboro Rd');
  assert.equal(rows[0].providerId, 'CCTV05161');
});

test('arcgis: Arlington keeps Status Online over https; Offline, Retired, an unexplained status and plain http are dropped', () => {
  const rows = agRecords('tx-arlington');
  assert.equal(AG['tx-arlington'].length, 7);
  assert.deepEqual(rows.map((r) => r.name), ['Abram & Center', 'Abram & Collins', 'Abram & Cooper']);
  assert.ok(rows.every((r) => r.media.still.startsWith('https://webapps.arlingtontx.gov/webcams/')));
});

test('arcgis: every card links the operator\'s public camera map, not a home page', () => {
  assert.equal(layerOf('tx-arlington').officialUrl, 'https://experience.arcgis.com/experience/a2fceb484bd04e2c9f795e8c9ce78786');
  assert.equal(layerOf('or-salem').officialUrl, 'https://salem.maps.arcgis.com/apps/instant/sidebar/index.html?appid=1dc340e3cbe34aadb723d0d6dd763e15');
  assert.match(layerOf('ks-lawrence').officialUrl, /lawrenceks\.maps\.arcgis\.com\/apps\//);
  const terms = (id) => SOURCES[layerOf(id).sourceId].termsUrl;
  for (const id of ['tx-arlington', 'or-salem']) assert.equal(terms(id), layerOf(id).officialUrl);
});

test('arcgis: TripCheck drops a camera named for a neighbouring state', () => {
  const layer = layerOf('or-tripcheck');
  const row = (title) => ({ attributes_title: title, attributes_filename: 'https://tripcheck.com/RoadCams/cams/x.jpg', attributes_cameraId: 1 });
  assert.equal(layer.read(row('US97 California at Grass Lake')), null);
  assert.equal(layer.read(row('Idaho at the I-84 border')), null);
  for (const t of ['I-5 Washington - Vancouver at Mill Plain', 'Grays Harbor Westport - WA (USCG)', 'SR 299 California at Cedar Pass', 'I-82 Washington at Plymouth Port of Entry']) {
    assert.equal(layer.read(row(t)), null, t);
  }
  for (const t of ['OR99W at Durham Rd', 'Washington County - 185th Ave at Evergreen Pkwy', 'US26 at Washington Park']) assert.ok(layer.read(row(t)), t);
});

test('arcgis: Lawrence names a camera from its picture file and keeps in-service rows', () => {
  const rows = agRecords('ks-lawrence');
  assert.equal(rows.length, 5);
  assert.equal(rows[0].name, '2nd & Locust');
  assert.equal(rows[0].providerId, 'DE-1000');
  assert.equal(rows[0].media.still, 'https://assets.lawrenceks.gov/gis/traffic/GEN_2nd%20&%20Locust.jpeg');
  const gone = JSON.parse(JSON.stringify(AG['ks-lawrence']));
  gone[0].attributes.Status = 32; // Abandoned
  assert.equal(normalizeArcgisCameras({ features: gone }, layerOf('ks-lawrence'), { fetchedAt: AG_AT }).length, 4);
});

test('arcgis: Salem keeps CAMERA_OFFLINE "No" on egov.cityofsalem.net only', () => {
  const rows = agRecords('or-salem');
  assert.equal(AG['or-salem'].length, 5);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].name, 'Devonshire Ct NE and Lancaster Dr NE');
  assert.ok(rows.every((r) => r.media.still.startsWith('https://egov.cityofsalem.net/traffic-cameras/cameras/')));
});

test('arcgis: TripCheck addresses with a space are percent-encoded so a plain GET reaches them', () => {
  const rows = agRecords('or-tripcheck');
  assert.equal(AG['or-tripcheck'].length, 6);
  assert.equal(rows.length, 5, 'the fixture\'s "US97 California at Grass Lake" row is a California camera and is dropped');
  assert.ok(rows.every((r) => !/California/.test(r.name)));
  const spaced = rows.find((r) => r.providerId === '451');
  assert.equal(spaced.media.still, 'https://tripcheck.com/RoadCams/cams/Jacksonville%20Hill%20WB_pid1980.JPG');
  assert.equal(spaced.name, 'OR238 at Jacksonville Hill');
  assert.ok(rows.every((r) => !/\s/.test(r.media.still)));
});

test('arcgis: UDOT keeps IsOnline "True" rows and upgrades the http address to https', () => {
  const rows = agRecords('ut-udot');
  assert.equal(AG['ut-udot'].length, 7);
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.media.still.startsWith('https://udottraffic.utah.gov/1_devices/')));
  assert.equal(rows[0].providerId, '17343');
  assert.equal(rows[0].name, '100 E / Alpine Hwy / SR-74 @ 1120 N, AFK');
});

test('arcgis: a record carries the operator as credit, rights unverified, the operator page, the layer\'s position and no stream', () => {
  for (const l of ARCGIS_LAYERS) {
    for (const r of agRecords(l.id)) {
      assert.equal(r.provider, l.id);
      assert.equal(r.operator, l.operator);
      assert.equal(r.attribution, l.operator, 'credit = operator name');
      assert.equal(r.officialUrl, l.officialUrl);
      assert.equal(r.rights, 'unverified');
      assert.equal(r.category, 'road');
      assert.equal(r.health, 'active');
      assert.equal(r.locationPrecision, 'exact');
      assert.equal(r.media.stream, null);
      assert.equal(r.capturedAt, null);
      assert.equal(r.fetchedAt, AG_AT);
      assert.ok(r.name && r.providerId);
      assert.ok(Number.isFinite(r.lat) && Number.isFinite(r.lon));
      assert.ok(Object.isFrozen(r));
    }
  }
});

test('arcgis: the position is the geometry the layer answered in WGS84 (x = longitude, y = latitude)', () => {
  const [first] = agRecords('ks-lawrence');
  assert.equal(first.lon, Math.round(AG['ks-lawrence'][0].geometry.x * 1e6) / 1e6);
  assert.equal(first.lat, Math.round(AG['ks-lawrence'][0].geometry.y * 1e6) / 1e6);
});

test('arcgis: a row with no coordinates, a 0,0 position or a repeated id is dropped; nothing throws', () => {
  const base = AG['ks-lawrence'][0];
  const withGeom = (geometry, id = base.attributes.FacilityID) =>
    ({ attributes: { ...base.attributes, FacilityID: id }, geometry });
  const out = normalizeArcgisCameras({ features: [
    withGeom(undefined, 'a'), withGeom(null, 'b'), withGeom({ x: null, y: 38.9 }, 'c'), withGeom({ x: 'NaN', y: 'NaN' }, 'd'),
    withGeom({ x: 0, y: 0 }, 'e'), withGeom({ x: -95.2, y: 38.9 }, 'ok'), withGeom({ x: -95.3, y: 38.8 }, 'ok'),
    null, 'junk', { attributes: null }, {},
  ] }, layerOf('ks-lawrence'), { fetchedAt: AG_AT });
  assert.deepEqual(out.map((r) => r.providerId), ['ok']);
  assert.equal(out[0].lon, -95.2, 'the first of a repeated id wins');
  for (const bad of [null, undefined, 'x', 3, [], {}, { features: 'no' }, { error: { code: 400 } }]) {
    assert.deepEqual(normalizeArcgisCameras(bad, layerOf('ky-kytc'), { fetchedAt: AG_AT }), []);
  }
});

test('arcgis: a row whose picture is missing or not an address is dropped, never published without a picture', () => {
  const row = (still) => ({ attributes: { ...AG['ks-lawrence'][0].attributes, Hyperlink: still }, geometry: AG['ks-lawrence'][0].geometry });
  for (const still of [null, '', ' ', 'GEN_x.jpeg', 'javascript:alert(1)', 'https://elsewhere.example/x.jpg', 'https://assets.lawrenceks.gov.evil.example/x.jpg',
    'ftp://assets.lawrenceks.gov/x.jpg', 'http://assets.lawrenceks.gov/x.jpg']) {
    assert.deepEqual(normalizeArcgisCameras({ features: [row(still)] }, layerOf('ks-lawrence'), { fetchedAt: AG_AT }), [], String(still));
  }
});

// ---------------------------------------------------------------------------------------------
// CARS (Castle Rock) camera lists: MN, IN and KS publish one keyless JSON list each, and
// Spokane's SRTMC publishes the same pictures through a GraphQL map query. One adapter per shape.
// Fixture: fixtures/cars-cameras-2026-10-04.min.json, real rows trimmed to the fields read.
import { CARS_FEEDS, CARS_STALE_MS, normalizeCarsCameras, normalizeSrtmcCameras }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/source-camera.js';

const CF = { ...read('fixtures/cars-cameras-2026-10-04.min.json'), co: read('fixtures/cars-co-2026-10-05.min.json') };
const CARS_AT = '2026-10-04T18:00:00Z';
const feedOf = (id) => CARS_FEEDS.find((f) => f.id === id);
const carsRecords = (id, rows = CF[id.slice(0, 2)]) => normalizeCarsCameras(rows, feedOf(id), { fetchedAt: CARS_AT });
const srtmc = (payload = CF.wa) => normalizeSrtmcCameras(payload, feedOf('wa-srtmc'), { fetchedAt: CARS_AT });

test('cars: five feeds, each its own provider id; Iowa and New York are not among them', () => {
  assert.deepEqual(CARS_FEEDS.map((f) => f.id), ['mn-511', 'in-511', 'ks-kandrive', 'wa-srtmc', 'co-cotrip']);
  for (const f of CARS_FEEDS) {
    assert.match(f.listUrl, /^https:\/\/[a-z0-9.]+\/(cameras_v1\/api\/cameras|api\/graphql)$/, f.id);
    assert.ok(f.operator && f.label && /^https:\/\//.test(f.officialUrl), `${f.id} names its operator and public page`);
    assert.ok(f.states.every((s) => /^[a-z]{2}$/.test(s)), f.id);
    assert.ok(f.imageOrigins.length >= 1 && f.imageOrigins.every((o) => /^https:\/\/[a-z0-9.-]+$/.test(o)), f.id);
  }
});

test('cars: every picture host is an exact registry entry (img only, no wildcard, no connect-src)', () => {
  for (const f of CARS_FEEDS) {
    assert.deepEqual(f.sourceIds.map((id) => SOURCES[id].origin), f.imageOrigins, f.id);
    for (const id of f.sourceIds) {
      const src = SOURCES[id];
      assert.equal(src.kind, 'camera-feed');
      assert.equal(src.paintedAs, 'img');
      assert.equal(src.cors, 'none');
      assert.ok(src.termsUrl && /^https:\/\//.test(src.termsUrl), `${id} cites the operator's terms page`);
    }
  }
});

test('cars: Minnesota takes the still view, or the preview of a video view; a stale picture is dropped', () => {
  const rows = carsRecords('mn-511');
  assert.equal(CF.mn.length, 5);
  assert.deepEqual(rows.map((r) => r.providerId), ['507910', '507909', '507907', '507906'],
    '508008 (picture dated 2026-09-28) is stale and dropped');
  assert.equal(rows[0].media.still, 'https://public.carsprogram.org/cameras/MN/C30405-v1', 'the first still view');
  assert.equal(rows[2].media.still, 'https://public.carsprogram.org/cameras/MN/C30112', 'a video view: its preview picture');
  assert.ok(rows.every((r) => r.media.stream === null && r.media.streamKind === null), 'the video address is never kept');
});

test('cars: a picture older than the freshness window is dropped, one inside it is kept', () => {
  assert.equal(CARS_STALE_MS, 24 * 3600 * 1000);
  const base = CF.mn[0];
  const at = (iso) => [{ ...base, views: [{ ...base.views[0], imageTimestamp: Date.parse(iso) }] }];
  assert.equal(carsRecords('mn-511', at('2026-10-03T18:30:00Z')).length, 1);
  assert.equal(carsRecords('mn-511', at('2026-10-03T17:30:00Z')).length, 0);
  const noStamp = [{ ...base, views: [{ type: 'STILL_IMAGE', url: base.views[0].url }] }];
  assert.equal(carsRecords('mn-511', noStamp).length, 1, 'no stamp in the list: the build\'s own still check decides');
});

test('cars: Indiana and Kansas read the preview address; a KC Scout still on its own host is dropped', () => {
  assert.deepEqual(carsRecords('in-511').map((r) => r.providerId), ['24576', '24577'],
    'the stale one and the inactive one are dropped');
  assert.equal(carsRecords('in-511')[0].media.still, 'https://public.carsprogram.org/cameras/IN/INDOT_232_rAWV3JdKh7zqndQk.flv.png');
  const ks = carsRecords('ks-kandrive');
  assert.deepEqual(ks.map((r) => r.providerId), ['1', '2394', '2395']);
  assert.equal(ks[1].media.still, 'https://kscam.carsprogram.org/snapshots/GEN_5-015-0677-2-K-15atMarket.jpeg');
  assert.ok(ks.every((r) => !JSON.stringify(r).includes('token=')), 'a stream token never reaches a record');
});

test('cars: a record carries the operator as credit, rights unverified, the operator page and no bearing', () => {
  const r = carsRecords('mn-511')[0];
  assert.deepEqual(r, {
    provider: 'mn-511', providerId: '507910', name: 'T.H.371 (Nisswa - MP 46.2)',
    lat: 46.52457553458154, lon: -94.29621126391358, locationPrecision: 'exact', category: 'road',
    operator: 'Minnesota DOT (511MN)', officialUrl: 'https://511mn.org/list/cameras', subject: null, bearing: null,
    media: { still: 'https://public.carsprogram.org/cameras/MN/C30405-v1', stream: null, streamKind: null },
    capturedAt: null, fetchedAt: CARS_AT, validUntil: null, rights: 'unverified',
    attribution: 'Minnesota DOT (511MN)', health: 'active',
  });
});

test('cars: a row that is private, unlocated, unnamed, repeated or on a foreign host is dropped; nothing throws', () => {
  const base = CF.mn[0];
  const row = (over) => ({ ...base, ...over });
  const odd = [
    row({ id: 1, public: false }), row({ id: 2, location: { latitude: 0, longitude: 0 } }),
    row({ id: 3, location: {} }), row({ id: 4, name: '' }), row({ id: 5, views: [] }),
    row({ id: 6, views: [{ type: 'STILL_IMAGE', url: 'http://public.carsprogram.org/cameras/MN/C1' }] }),
    row({ id: 7, views: [{ type: 'STILL_IMAGE', url: 'https://example.com/cameras/MN/C1' }] }),
    row({ id: 8, views: [{ type: 'STILL_IMAGE', url: 'https://public.carsprogram.org.evil.test/x' }] }),
    row({ id: 9 }), row({ id: 9 }), null, 'junk', 7,
  ];
  assert.deepEqual(carsRecords('mn-511', odd).map((r) => r.providerId), ['9']);
  for (const bad of [null, undefined, {}, 'x', 7]) assert.deepEqual(normalizeCarsCameras(bad, feedOf('mn-511'), { fetchedAt: CARS_AT }), []);
});

test('srtmc: Spokane keeps only SRTMC\'s own pictures, port 443 and cache-busting query removed; WSDOT pictures are dropped', () => {
  const rows = srtmc();
  assert.deepEqual(rows.map((r) => r.providerId), ['1', '4'], 'camera/513 and camera/514 are WSDOT pictures on public.carsprogram.org');
  assert.equal(rows[0].media.still, 'https://images.srtmc.org/dd34a7df-511d-4286-a15e-a7eb3969d47d.jpg');
  assert.equal(rows[0].lat, 47.74406);
  assert.equal(rows[0].lon, -117.40722, 'GeoJSON order: longitude first');
  assert.equal(rows[0].operator, 'Spokane Regional Transportation Management Center');
  assert.equal(rows[0].rights, 'unverified');
  assert.ok(rows.every((r) => r.media.stream === null));
  assert.deepEqual(feedOf('wa-srtmc').imageOrigins, ['https://images.srtmc.org']);
});

test('cars: Kansas credits only KDOT-owned cameras; City of Topeka and KTA rows are dropped by owner', () => {
  const kdot = CF.ks[0];
  const owned = (id, name) => ({ ...kdot, id, cameraOwner: { name } });
  const rows = [owned(101, 'KDOT ITS'), owned(102, 'KDOT RWIS'), owned(103, 'City of Topeka'), owned(104, 'KTA'),
    owned(105, 'KC Scout'), { ...kdot, id: 106, cameraOwner: undefined }, { ...kdot, id: 107, cameraOwner: { name: 'kdot its ' } }];
  assert.deepEqual(carsRecords('ks-kandrive', rows).map((r) => r.providerId), ['101', '102']);
  assert.equal(feedOf('mn-511').owners, undefined, 'only Kansas filters by owner');
});

test('cars: each committed CARS seed names its feed\'s operator list page, not a home page', () => {
  for (const f of CARS_FEEDS) {
    const seed = JSON.parse(readFileSync(new URL(`../../static/data/quiet-corners-maps/cameras/${f.id}/${f.id}-${f.states[0]}.json`, import.meta.url), 'utf8'));
    assert.equal(seed.officialUrl, f.officialUrl, f.id);
    assert.equal(seed.operator, f.operator, f.id);
    // COtrip has no list page of its own (the site is one app shell); its card links the home page, as the unit brief set.
    if (f.id !== 'co-cotrip') assert.match(f.officialUrl, /\/list\/cameras$/, `${f.id} links its operator's camera list page`);
  }
});

test('srtmc: inactive cameras, clusters, other hosts and a stale picture stamp are dropped; a cluster fails the whole query', () => {
  const mf = CF.wa.data.mapFeaturesQuery.mapFeatures;
  const wrap = (m) => ({ data: { mapFeaturesQuery: { mapFeatures: m, error: null } } });
  assert.equal(srtmc(wrap([{ ...mf[0], active: false }])).length, 0);
  assert.equal(srtmc(wrap([{ ...mf[0], __typename: 'Cluster' }])).length, 0);
  assert.equal(srtmc(wrap([{ ...mf[0], views: [{ uri: 'x', url: 'https://example.com/a.jpg', category: 'IMAGE' }] }])).length, 0);
  const stale = mf[0].views.map((v) => ({ ...v, url: v.url.replace(/\?\d+$/, '?1790000000000') }));
  assert.equal(srtmc(wrap([{ ...mf[0], views: stale }])).length, 0);
  for (const bad of [null, {}, { data: null }, { data: { mapFeaturesQuery: null } }]) assert.deepEqual(srtmc(bad), []);
});

test('arcgis: a picture address with a malformed escape drops that row only, never throws', () => {
  const base = AG['ks-lawrence'][0];
  const row = (id, link) => ({ attributes: { ...base.attributes, FacilityID: id, Hyperlink: link }, geometry: base.geometry });
  const rows = agRecords('ks-lawrence', { features: [
    row('good', 'https://assets.lawrenceks.gov/gis/traffic/GEN_ok.jpeg'),
    row('pct', 'https://assets.lawrenceks.gov/gis/traffic/GEN_50% Mass.jpeg'),
    row('bad', 'https://assets.lawrenceks.gov/gis/traffic/GEN_a%E0b.jpeg'),
  ] });
  assert.deepEqual(rows.map((r) => r.providerId), ['good']);
  const arl = AG['tx-arlington'][0];
  assert.deepEqual(agRecords('tx-arlington', { features: [{ attributes: { ...arl.attributes, Status: 'Online',
    Pic_URL: 'https://webapps.arlingtontx.gov/webcams/a%zz.jpg' }, geometry: arl.geometry }] }), []);
});

test('arcgis: coordinates are rounded to 6 decimals and each operator links its public page', () => {
  const base = AG['ks-lawrence'][0];
  const rows = agRecords('ks-lawrence', { features: [{ attributes: base.attributes, geometry: { x: -95.123456789012, y: 38.100000000004 } }] });
  assert.equal(rows[0].lon, -95.123457);
  assert.equal(rows[0].lat, 38.1);
  assert.equal(layerOf('ks-lawrence').officialUrl,
    'https://lawrenceks.maps.arcgis.com/apps/instant/basic/index.html?appid=d7c108bb6a0c405aa50a3e8168102b75');
});

// ---------------------------------------------------------------------------------------------
// Iteris CDN GeoJSON (Virginia, South Dakota) and Socrata SODA (Austin, Baton Rouge).
// Fixtures are real rows copied unchanged from each list on 2026-10-04 (Socrata rows are what
// `$select=<named fields>` answers). Montana is NOT built: its terms forbid redistribution without
// MDT's written permission, so there is no Montana row and no Montana host anywhere.
import { ITERIS_LAYERS, normalizeIterisCameras, SOCRATA_LAYERS, normalizeSocrataCameras }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/source-camera.js';

const IT = read('fixtures/iteris-cameras-2026-10-04.min.json');
const SO = read('fixtures/socrata-cameras-2026-10-04.min.json');
const itLayer = (id) => ITERIS_LAYERS.find((l) => l.id === id);
const soLayer = (id) => SOCRATA_LAYERS.find((l) => l.id === id);
const itPayload = (id) => ({ features: id === 'sd-sddot' ? [...IT[id].cameras, ...IT[id].rwis] : IT[id] });
const itRecords = (id, payload = itPayload(id)) => normalizeIterisCameras(payload, itLayer(id), { fetchedAt: AG_AT });
const soRecords = (id, rows = SO[id]) => normalizeSocrataCameras({ rows }, soLayer(id), { fetchedAt: AG_AT });

test('iteris and socrata: the tables, one provider id per operator, no Montana', () => {
  assert.deepEqual(ITERIS_LAYERS.map((l) => l.id), ['va-vdot', 'sd-sddot']);
  assert.deepEqual(SOCRATA_LAYERS.map((l) => l.id), ['tx-austin', 'la-batonrouge']);
  for (const l of [...ITERIS_LAYERS, ...SOCRATA_LAYERS]) {
    const src = SOURCES[l.sourceId];
    assert.ok(src, `${l.id} has no registry entry ${l.sourceId}`);
    assert.equal(src.kind, 'camera-feed');
    assert.equal(src.paintedAs, 'img');
    assert.equal(src.cors, 'none');
    assert.equal(src.origin, l.imageOrigin);
    assert.match(src.origin, /^https:\/\/[a-z0-9.-]+$/);
    assert.equal(src.attribution, l.operator);
    assert.ok(l.operator && l.label && /^https:\/\//.test(l.officialUrl));
    assert.ok(l.states.length === 1 && /^[a-z]{2}$/.test(l.states[0]));
  }
  assert.ok(!JSON.stringify([ITERIS_LAYERS, SOURCES]).includes('mt.cdn.iteris-atis.com'), 'no Montana host');
  assert.ok(!Object.keys(SOURCES).some((k) => /Mt[A-Z]|montana/i.test(k)), 'no Montana registry row');
  // SCDOT's disclaimer (https://www.511sc.org/static/disclaimer.html) bars displaying or publishing its content without written permission.
  assert.ok(!JSON.stringify([ITERIS_LAYERS, SOURCES]).match(/scdot|skyvdn|sc\.cdn\.iteris/i), 'South Carolina is not a source');
});

test('iteris: the list URLs are the keyless CDN GeoJSON files, no GraphQL and no 511 node endpoint', () => {
  assert.deepEqual(itLayer('va-vdot').listUrls, ['https://data.511-atis-ttrip-prod.iteriscloud.com/datasets/cameras/icons.cameras.geojson']);
  assert.deepEqual(itLayer('sd-sddot').listUrls, [
    'https://sd.cdn.iteris-atis.com/geojson/icons/metadata/icons.cameras.geojson',
    'https://sd.cdn.iteris-atis.com/geojson/icons/metadata/icons.rwis.geojson']);
  for (const l of ITERIS_LAYERS) for (const u of l.listUrls) assert.ok(!/graphql|511\.vdot|node/i.test(u), u);
});

test('iteris: Virginia keeps active cameras and rewrites a /thumbs/X.flv.png thumbnail to /X.png on snapshot.vdotcameras.com', () => {
  const rows = itRecords('va-vdot');
  assert.equal(rows.length, 6);
  assert.equal(rows[0].providerId, '3958');
  assert.equal(rows[0].name, 'University Drive and Sager Avenue');
  assert.equal(rows[0].media.still, 'https://snapshot.vdotcameras.com/0i6a7bfbs60yq2lbgivq0b8xk3scij3c.png');
  assert.equal(rows[5].media.still, 'https://snapshot.vdotcameras.com/466F22EA888D5F71.png');
  assert.ok(rows.every((r) => !r.media.still.includes('/thumbs/')));
  assert.equal(rows[0].operator, 'Virginia DOT (VDOT)');
  assert.equal(rows[0].officialUrl, 'https://511.vdot.virginia.gov/');
  const [f] = IT['va-vdot'];
  assert.equal(rows[0].lon, f.geometry.coordinates[0]);
  assert.equal(rows[0].lat, f.geometry.coordinates[1]);
});

test('iteris: an inactive camera, another host, plain http and a missing picture are all dropped', () => {
  const base = IT['va-vdot'][0];
  const mod = (props) => ({ ...base, properties: { ...base.properties, ...props } });
  for (const props of [{ active: false }, { image_url: null }, { image_url: '' },
    { image_url: 'https://elsewhere.example/thumbs/x.flv.png' },
    { image_url: 'https://snapshot.vdotcameras.com.evil.example/x.png' },
    { image_url: 'http://snapshot.vdotcameras.com/x.png' }, { description: '' }]) {
    assert.deepEqual(normalizeIterisCameras({ features: [mod(props)] }, itLayer('va-vdot'), { fetchedAt: AG_AT }), [], JSON.stringify(props));
  }
});

test('iteris: South Dakota is one pin per site (cameras list and RWIS list), the first still on the card', () => {
  const rows = itRecords('sd-sddot');
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map((r) => r.providerId), ['CSDATY', 'CSDBK0', 'CSDBK1', 'CSD3FK', 'CSDAGR', 'CSDALP']);
  assert.equal(rows[0].name, 'Watertown North (I-29)');
  assert.equal(rows[3].name, 'Three Forks (US-16)');
  assert.equal(rows[0].media.still, IT['sd-sddot'].cameras[0].properties.cameras[0].image);
  assert.equal(rows[3].media.still, IT['sd-sddot'].rwis[0].properties.cameras[0].image);
  assert.ok(rows.every((r) => r.media.still.startsWith('https://sd.cdn.iteris-atis.com/camera_images/')));
  assert.equal(rows[0].operator, 'South Dakota DOT (SDDOT)');
  assert.equal(rows[0].officialUrl, 'https://www.sd511.org/');
});

test('iteris: a South Dakota site with no usable still is dropped; a bad first still falls to the next good one; a repeated site wins once', () => {
  const site = IT['sd-sddot'].cameras[0];
  const cams = site.properties.cameras;
  const withCams = (cameras, id = site.id) => ({ ...site, id, properties: { ...site.properties, cameras } });
  const out = normalizeIterisCameras({ features: [
    withCams([], 'none'), withCams([{ image: 'https://elsewhere.example/a.jpg' }], 'wronghost'),
    withCams([{ image: 'https://elsewhere.example/a.jpg' }, cams[1]], 'second'), withCams(cams, 'dup'), withCams([cams[2]], 'dup'),
  ] }, itLayer('sd-sddot'), { fetchedAt: AG_AT });
  assert.deepEqual(out.map((r) => r.providerId), ['second', 'dup']);
  assert.equal(out[0].media.still, cams[1].image);
  assert.equal(out[1].media.still, cams[0].image);
});

test('iteris: a record carries the operator as credit, rights unverified, the operator page, a frozen shape and no stream', () => {
  for (const l of ITERIS_LAYERS) {
    for (const r of itRecords(l.id)) {
      assert.equal(r.provider, l.id);
      assert.equal(r.attribution, l.operator);
      assert.equal(r.operator, l.operator);
      assert.equal(r.officialUrl, l.officialUrl);
      assert.equal(r.rights, 'unverified');
      assert.equal(r.category, 'road');
      assert.equal(r.health, 'active');
      assert.equal(r.media.stream, null);
      assert.equal(r.fetchedAt, AG_AT);
      assert.ok(r.media.still.startsWith(`${l.imageOrigin}/`));
      assert.ok(Number.isFinite(r.lat) && Number.isFinite(r.lon) && r.name && r.providerId);
      assert.ok(Object.isFrozen(r));
    }
  }
});

test('iteris: no coordinates, a 0,0 position, a non-Point and a junk row are dropped; nothing throws', () => {
  const base = IT['va-vdot'][0];
  const at = (geometry, id) => ({ ...base, geometry, properties: { ...base.properties, id } });
  const out = normalizeIterisCameras({ features: [
    at(undefined, 'a'), at(null, 'b'), at({ type: 'Point', coordinates: [] }, 'c'), at({ type: 'Point', coordinates: [0, 0] }, 'd'),
    at({ type: 'Polygon', coordinates: [[-80, 33]] }, 'e'), at({ type: 'Point', coordinates: ['x', 'y'] }, 'f'),
    at({ type: 'Point', coordinates: [-80.9, 33.9] }, 'ok'), null, 'junk', {}, { properties: null },
  ] }, itLayer('va-vdot'), { fetchedAt: AG_AT });
  assert.deepEqual(out.map((r) => r.providerId), ['ok']);
  for (const bad of [null, undefined, 'x', 3, [], {}, { features: 'no' }]) {
    assert.deepEqual(normalizeIterisCameras(bad, itLayer('va-vdot'), { fetchedAt: AG_AT }), []);
  }
});

test('socrata: Austin keeps only TURNED_ON cameras with a Point and a picture on cctv.austinmobility.io', () => {
  assert.equal(SO['tx-austin'].length, 7);
  const rows = soRecords('tx-austin');
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.providerId), ['1', '10', ...rows.slice(2).map((r) => r.providerId)]);
  assert.equal(rows[0].name, '830 BLK W RUNDBERG LN (Little Walnut Creek Library, HEB)');
  assert.equal(rows[1].name, '35TH ST / JACKSON AVE', 'a leading space in the location name is trimmed');
  assert.equal(rows[0].media.still, 'https://cctv.austinmobility.io/image/1.jpg');
  assert.equal(rows[0].lon, -97.698158);
  assert.equal(rows[0].lat, 30.363686);
  assert.equal(rows[0].operator, 'City of Austin Transportation and Public Works');
  assert.equal(rows[0].officialUrl, 'https://data.austintexas.gov/d/b4k4-adkb');
  assert.equal(rows[0].rights, 'unverified', 'the catalog says public domain for the list; the pictures are not covered by that');
});

test('socrata: Austin drops a status other than TURNED_ON, a missing Point and a missing or foreign picture', () => {
  const base = SO['tx-austin'][0];
  const mod = (o) => ({ ...base, ...o });
  for (const o of [{ camera_status: 'DESIRED' }, { camera_status: 'VOID' }, { camera_status: 'REMOVED' }, { camera_status: undefined },
    { location: undefined }, { location: { type: 'Point', coordinates: [] } }, { location: { type: 'Point', coordinates: [0, 0] } },
    { screenshot_address: undefined }, { screenshot_address: '' }, { screenshot_address: 'https://elsewhere.example/1.jpg' },
    { screenshot_address: 'http://cctv.austinmobility.io/image/1.jpg' }, { location_name: '  ' }]) {
    assert.deepEqual(soRecords('tx-austin', [mod(o)]), [], JSON.stringify(o));
  }
});

test('socrata: Baton Rouge reads the point from the_geom, the picture from image_view on 511la.org, and names the camera from its code', () => {
  const rows = soRecords('la-batonrouge');
  assert.equal(rows.length, 4);
  assert.equal(rows[0].providerId, '1');
  assert.equal(rows[0].name, 'Baton Rouge traffic camera b24');
  assert.equal(rows[1].name, 'Baton Rouge traffic camera 297.C1');
  assert.equal(rows[0].media.still, 'https://511la.org/map/Cctv/b24--1');
  assert.equal(rows[0].lon, SO['la-batonrouge'][0].the_geom.coordinates[0]);
  assert.equal(rows[0].operator, 'City of Baton Rouge / LA DOTD');
  assert.equal(rows[0].officialUrl, 'https://data.brla.gov/d/6z6u-ts44');
  assert.equal(rows[0].rights, 'unverified');
  assert.equal(soRecords('la-batonrouge', [{ ...SO['la-batonrouge'][0], image_view: 'https://511la.org/other/path' }]).length, 0, 'only the /map/Cctv/ picture path is kept');
});

test('socrata: a repeated id, a junk row and a payload that is not a row list normalize to what is valid', () => {
  const base = SO['tx-austin'][0];
  const out = normalizeSocrataCameras({ rows: [base, { ...base, location: { type: 'Point', coordinates: [-97.1, 30.1] } }, null, 'junk', 7, {}] },
    soLayer('tx-austin'), { fetchedAt: AG_AT });
  assert.equal(out.length, 1);
  assert.equal(out[0].lon, -97.698158, 'the first of a repeated id wins');
  for (const bad of [null, undefined, 'x', 3, [], {}, { rows: 'no' }, { error: true, message: 'Not found' }]) {
    assert.deepEqual(normalizeSocrataCameras(bad, soLayer('tx-austin'), { fetchedAt: AG_AT }), []);
  }
  assert.ok(out.every((r) => Object.isFrozen(r) && r.media.stream === null && r.category === 'road'));
});

// ---------------------------------------------------------------------------------------------
// PhenoCam Network and AviationWX (keyless, owner-published lists). Fixtures are trimmed live
// captures of 2026-10-04: phenocam-cameras-2026-10-04.min.json keeps the fields the adapter may
// read plus contact1/contact2 (kept ON PURPOSE so the privacy tests have something to leak), and
// aviationwx-airports-2026-10-04.min.json is the whole airport list.
import { normalizePhenocamSite, normalizePhenocam, normalizeAviationwx }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/source-camera.js';
import { cspDirectivesFor, APPROVED_ORIGINS }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';

const PHENO = read('fixtures/phenocam-cameras-2026-10-04.min.json');
const AVWX = read('fixtures/aviationwx-airports-2026-10-04.min.json');
const BUILD_DATE = '2026-10-04T12:00:00.000Z';
const site = (over = {}) => ({ Sitename: 'amherst', Lat: 42.3942, Lon: -72.5289, active: true, date_last: '2026-10-03',
  contact1: 'Dee Morse <dee_morse AT nps DOT gov>', contact2: 'Ann Other <ann AT example DOT edu>',
  sitemetadata: { site_description: 'UMass Amherst Test Camera' }, ...over });

test('phenocam: a site maps to id, description, position, still, owner page and the CC BY credit', () => {
  const r = normalizePhenocamSite(site(), { fetchedAt: BUILD_DATE });
  assert.equal(r.provider, 'phenocam');
  assert.equal(r.providerId, 'amherst');
  assert.equal(r.name, 'UMass Amherst Test Camera');
  assert.equal(r.lat, 42.3942);
  assert.equal(r.lon, -72.5289);
  assert.equal(r.media.still, 'https://phenocam.nau.edu/data/latest/amherst.jpg');
  assert.equal(r.officialUrl, 'https://phenocam.nau.edu/webcam/sites/amherst/');
  assert.equal(r.attribution, 'PhenoCam Network (CC BY)');
  assert.equal(r.rights, 'CC BY');
  assert.equal(r.operator, 'PhenoCam Network');
  assert.equal(r.health, 'active');
});

test('phenocam privacy: no contact field, name or address survives into a record', () => {
  const r = normalizePhenocamSite(site(), { fetchedAt: BUILD_DATE });
  const text = JSON.stringify(r);
  for (const leak of ['contact', 'Dee Morse', 'dee_morse', 'Ann Other', ' AT ', ' DOT ', '@']) {
    assert.ok(!text.includes(leak), `record leaks ${JSON.stringify(leak)}`);
  }
  assert.deepEqual(Object.keys(r).sort(), Object.keys(normalizeNpsWebcamRecord({ id: 'x' })).sort(),
    'the same record shape as every other camera provider, no extra field to carry a person');
});

test('phenocam privacy: (at), bare "at <domain>" and fullwidth-at addresses in a description fall back to the Sitename', () => {
  for (const bad of ['dee(at)nps.gov', 'dee at nps.gov', 'dee\uFF20nps.gov']) {
    const r = normalizePhenocamSite(site({ sitemetadata: { site_description: bad } }), { fetchedAt: BUILD_DATE });
    assert.equal(r.name, 'amherst', `${JSON.stringify(bad)} must not be published`);
  }
  assert.equal(normalizePhenocamSite(site({ sitemetadata: { site_description: 'Camera at Harvard Forest' } }), {}).name,
    'Camera at Harvard Forest', 'a plain "at" in prose is kept');
});

test('phenocam: a site with no usable Sitename, or one that is not URL-safe, is dropped', () => {
  for (const bad of [{ Sitename: '' }, { Sitename: null }, { Sitename: 'a/../b' }, { Sitename: 'x y' }, { Sitename: 'a?b=1' }]) {
    assert.equal(normalizePhenocamSite(site(bad), { fetchedAt: BUILD_DATE }), null, JSON.stringify(bad));
  }
  assert.equal(normalizePhenocamSite(null), null);
});

test('phenocam: no description falls back to the Sitename, a position-less site keeps null, not 0,0', () => {
  assert.equal(normalizePhenocamSite(site({ sitemetadata: null }), {}).name, 'amherst');
  const r = normalizePhenocamSite(site({ Lat: null, Lon: '' }), {});
  assert.equal(r.lat, null);
  assert.equal(r.lon, null);
});

test('phenocam: only active sites whose date_last is within 30 days of the build date are kept', () => {
  const rows = [site({ Sitename: 'fresh', date_last: '2026-10-03' }),
    site({ Sitename: 'edge', date_last: '2026-09-04' }),       // exactly 30 days
    site({ Sitename: 'stale', date_last: '2026-09-03' }),      // 31 days
    site({ Sitename: 'off', active: false }),
    site({ Sitename: 'nodate', date_last: null }),
    site({ Sitename: 'baddate', date_last: 'soon' })];
  const got = normalizePhenocam({ results: rows }, { fetchedAt: BUILD_DATE }).map((r) => r.providerId);
  assert.deepEqual(got, ['fresh', 'edge']);
});

test('phenocam: repeated Sitename once, a payload that is not the list gives no cameras', () => {
  assert.equal(normalizePhenocam({ results: [site(), site()] }, { fetchedAt: BUILD_DATE }).length, 1);
  for (const bad of [null, {}, { results: 'x' }, []]) assert.deepEqual(normalizePhenocam(bad, { fetchedAt: BUILD_DATE }), []);
});

test('phenocam privacy: over the whole live fixture no record carries any contact string or an @', () => {
  const records = normalizePhenocam(PHENO, { fetchedAt: BUILD_DATE });
  assert.ok(records.length > 400, `live fixture should yield hundreds, got ${records.length}`);
  const contacts = PHENO.results.flatMap((s) => [s.contact1, s.contact2]).filter(Boolean);
  assert.ok(contacts.length > 100, 'the fixture really carries contacts');
  const text = JSON.stringify(records);
  assert.ok(!text.includes('@'));
  assert.ok(!/ AT [a-z0-9_.-]+ DOT /i.test(text), 'no obfuscated address either');
  for (const c of contacts) assert.ok(!text.includes(c), `contact leaked: ${c}`);
});

test('aviationwx: one record per webcam, indexed from 0, image at size=720, owner page the airport url, API credit', () => {
  const records = normalizeAviationwx(AVWX, { fetchedAt: BUILD_DATE });
  const cams = AVWX.airports.filter((a) => a.has_webcams && !a.unlisted);
  assert.equal(records.length, cams.reduce((n, a) => n + a.webcam_count, 0));
  const first = records.find((r) => r.providerId === '02id:0');
  assert.equal(first.provider, 'aviationwx');
  assert.equal(first.media.still, 'https://api.aviationwx.org/v1/airports/02id/webcams/0/image?size=720');
  assert.equal(records.find((r) => r.providerId === '02id:1').media.still,
    'https://api.aviationwx.org/v1/airports/02id/webcams/1/image?size=720');
  assert.ok(!records.some((r) => r.providerId === '02id:2'), 'webcam_count 2 means indices 0 and 1 only');
  assert.equal(first.officialUrl, 'https://02id.aviationwx.org/');
  assert.equal(first.attribution, AVWX.meta.attribution);
  assert.equal(first.attribution, 'Weather data from AviationWX.org');
  assert.equal(first.lat, 44.55117);
  assert.equal(first.lon, -115.30583);
  assert.match(first.name, /Morgan Ranch Airport/);
});

test('aviationwx: no webcams, unlisted, an unsafe id or a missing position gives nothing; maintenance stays, marked inactive', () => {
  const a = (over) => ({ id: 'kxyz', name: 'X Field', lat: 40, lon: -100, has_webcams: true, webcam_count: 1,
    url: 'https://kxyz.aviationwx.org/', unlisted: false, maintenance: false, ...over });
  const meta = { attribution: 'Weather data from AviationWX.org' };
  const ids = (over) => normalizeAviationwx({ meta, airports: [a(over)] }, { fetchedAt: BUILD_DATE }).map((r) => r.providerId);
  assert.deepEqual(ids({}), ['kxyz:0']);
  assert.deepEqual(ids({ has_webcams: false }), []);
  assert.deepEqual(ids({ unlisted: true }), []);
  assert.deepEqual(ids({ webcam_count: 0 }), []);
  assert.deepEqual(ids({ id: '../x' }), []);
  assert.deepEqual(ids({ lat: null }), []);
  assert.deepEqual(ids({ webcam_count: 3 }), ['kxyz:0', 'kxyz:1', 'kxyz:2']);
  const [m] = normalizeAviationwx({ meta, airports: [a({ maintenance: true })] }, { fetchedAt: BUILD_DATE });
  assert.equal(m.health, 'inactive');
  assert.deepEqual(normalizeAviationwx(null, {}), []);
  assert.deepEqual(normalizeAviationwx({ airports: 'x' }, {}), []);
});

test('aviationwx: a url that is not on the airport own aviationwx.org host is replaced by the airport page, never trusted', () => {
  const [r] = normalizeAviationwx({ meta: {}, airports: [{ id: 'kxyz', name: 'X', lat: 1, lon: 2, has_webcams: true,
    webcam_count: 1, url: 'https://evil.example/', unlisted: false }] }, { fetchedAt: BUILD_DATE });
  assert.equal(r.officialUrl, 'https://kxyz.aviationwx.org/');
  assert.equal(r.attribution, 'Weather data from AviationWX.org', 'meta.attribution missing: the documented string');
});

test('CSP: each picture host joins img-src as an exact host, painted as an <img>, and never joins connect-src', () => {
  const csp = cspDirectivesFor();
  for (const [key, origin] of [['phenocam', 'https://phenocam.nau.edu'], ['aviationwx', 'https://api.aviationwx.org']]) {
    const s = SOURCES[key];
    assert.equal(s.origin, origin);
    assert.equal(s.paintedAs, 'img');
    assert.equal(s.cors, 'none', 'the page never fetch()es it: the build reads the list');
    assert.equal(s.kind, 'camera-feed');
    assert.ok(csp['img-src'].includes(origin));
    assert.ok(!csp['connect-src'].includes(origin));
    assert.ok(APPROVED_ORIGINS.includes(origin));
    assert.ok(!origin.includes('*'));
  }
  assert.ok(csp['img-src'].every((o) => !o.includes('*')), 'no wildcard host anywhere in img-src');
});

test('CSP: every still a PhenoCam or AviationWX record paints is on an img-src host', () => {
  const imgHosts = new Set(cspDirectivesFor()['img-src']);
  const records = [...normalizePhenocam(PHENO, { fetchedAt: BUILD_DATE }), ...normalizeAviationwx(AVWX, { fetchedAt: BUILD_DATE })];
  assert.ok(records.length > 500);
  for (const r of records) assert.ok(imgHosts.has(new URL(r.media.still).origin), r.media.still);
});

test('phenocam privacy: a description holding an address falls back to the Sitename', () => {
  for (const d of ['Run by dee@nps.gov at the ridge', 'Contact dee AT nps DOT gov for data', 'Call dee at nps dot gov']) {
    const r = normalizePhenocamSite(site({ sitemetadata: { site_description: d } }), { fetchedAt: BUILD_DATE });
    assert.equal(r.name, 'amherst', d);
    assert.ok(!JSON.stringify(r).includes('@'));
  }
  assert.equal(normalizePhenocamSite(site({ sitemetadata: { site_description: 'Meet at the dock, Maine' } }), { fetchedAt: BUILD_DATE }).name,
    'Meet at the dock, Maine', 'a plain "at" is not an address');
});

// ---------------------------------------------------------------------------------------------
// Colorado (COtrip): one more operator on the CARS adapter above. The fixture is real rows copied
// unchanged on 2026-10-05: cars-co-2026-10-05.min.json (the CDOT list, plus a Douglas County and a
// Colorado Springs row).
const CO_AT = '2026-10-05T12:00:00Z';
const coRecords = (rows = CF.co) => normalizeCarsCameras(rows, feedOf('co-cotrip'), { fetchedAt: CO_AT });

test('colorado: the COtrip feed credits Colorado DOT, links cotrip.org, keeps CDOT\'s own rows on cocam.carsprogram.org', () => {
  const f = feedOf('co-cotrip');
  assert.equal(f.kind, 'cars');
  assert.deepEqual(f.states, ['co']);
  assert.equal(f.operator, 'Colorado DOT (COtrip)');
  assert.equal(f.officialUrl, 'https://www.cotrip.org/');
  assert.equal(f.listUrl, 'https://cotg.carsprogram.org/cameras_v1/api/cameras');
  assert.deepEqual(f.imageOrigins, ['https://cocam.carsprogram.org']);
  assert.deepEqual(f.sourceIds, ['carsCo']);
  assert.deepEqual([...f.owners], ['Colorado DOT', 'CDOT Cellular']);
  assert.equal(SOURCES.carsCo.termsUrl, 'https://www.cotrip.org/');
});

test('colorado: video previews and stills are kept; a county or city owner, and a stale picture, are dropped', () => {
  assert.equal(CF.co.length, 9);
  const rows = coRecords();
  assert.equal(rows.length, 6, 'two Colorado DOT video previews, two stills, two fresh Cellular rows');
  assert.ok(rows.every((r) => r.media.still.startsWith('https://cocam.carsprogram.org/')));
  assert.ok(rows.every((r) => r.media.stream === null && r.media.streamKind === null), 'the video address is never kept');
  assert.ok(rows.some((r) => r.media.still.includes('/Snapshots/')) && rows.some((r) => r.media.still.includes('/Cellular/')));
  const owners = new Set(coRecords().map((r) => r.providerId));
  for (const r of CF.co.filter((x) => ['Douglas County', 'Colorado Springs'].includes(x.cameraOwner.name))) assert.ok(!owners.has(String(r.id)), `${r.cameraOwner.name} is another operator`);
  for (const r of rows) {
    assert.equal(r.attribution, 'Colorado DOT (COtrip)');
    assert.equal(r.rights, 'unverified');
    assert.equal(r.officialUrl, 'https://www.cotrip.org/');
    assert.equal(r.fetchedAt, CO_AT);
  }
});

// Small state and city feeds. Kirkland: real rows copied unchanged from the layer's query answer on 2026-10-05
// (fixtures/arcgis-small-2026-10-05.min.json). WSF: a slice of WSDOT's ferry-map camera list (fixtures/wsf-2026-10-05.min.json).
test('arcgis small feeds: Kirkland keeps only the City of Kirkland\'s own cameras on its.kirklandwa.gov and links the city\'s own camera page', () => {
  const rows = agRecords('wa-kirkland');
  assert.equal(AG['wa-kirkland'].length, 6);
  assert.equal(rows.length, 3, 'WSDOT, Bellevue and Redmond rows belong to other operators and are dropped');
  assert.ok(rows.every((r) => r.media.still.startsWith('https://its.kirklandwa.gov/CamView/')));
  assert.ok(rows.every((r) => r.lat > 47 && r.lat < 48 && r.lon < -122 && r.lon > -123), 'x is longitude, y latitude (the layer\'s LAT and LON attributes are swapped and unused)');
  assert.equal(rows[0].name, '100th Ave. N.E. and N.E. 132nd St.');
  assert.equal(layerOf('wa-kirkland').officialUrl, 'https://www.kirklandwa.gov/Home/My-Neighborhood/Traffic-Cameras');
  assert.ok(rows.every((r) => r.officialUrl === layerOf('wa-kirkland').officialUrl && r.rights === 'unverified'));
  assert.ok(!layerOf('wa-kirkland').officialUrl.includes('arcgis.com'), 'the card links the operator\'s page, not a data catalogue');
});

test('arcgis small feeds: Kirkland is credited by name and keyless', () => {
  const l = layerOf('wa-kirkland');
  assert.match(l.operator, /Kirkland/);
  assert.ok(!JSON.stringify(l.outFields).includes('token'));
  assert.equal(SOURCES[l.sourceId].termsUrl, 'https://www.kirklandwa.gov/Site-Footer/Website-Disclaimer');
});

import { WSF_LAYER } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-camera.js';
const WSF = read('fixtures/wsf-2026-10-05.min.json');
const wsfGeo = (list = WSF.FeedContentList) => ({ features: list.map((x) => x.FerryCamera).map((c) => ({ type: 'Feature',
  geometry: { type: 'Point', coordinates: [c.Lon, c.Lat] }, properties: { id: c.CamID, title: c.Title, image_url: c.ImgURL, active: c.IsActive } })) });

test('wsf: the ferry-terminal layer is one exact registry host (img only) with WSDOT\'s credit and keyless', () => {
  const src = SOURCES[WSF_LAYER.sourceId];
  assert.ok(src);
  assert.equal(src.kind, 'camera-feed');
  assert.equal(src.paintedAs, 'img');
  assert.equal(src.cors, 'none');
  assert.equal(src.origin, WSF_LAYER.imageOrigin);
  assert.equal(src.limits.requiresKey, false);
  assert.equal(src.metadataUrl, WSF_LAYER.listUrls[0]);
  assert.equal(new URL(WSF_LAYER.listUrls[0]).origin, 'https://wsdot.com', 'the list URL is the final one, not an off-host redirect');
  assert.equal(src.attribution, WSF_LAYER.operator);
  assert.equal(src.termsUrl, 'https://wsdot.wa.gov/about/policies/travel-information-disclaimer');
});

test('wsf: terminal pictures (/wsf/) become records; WSDOT road-camera rows in the same list do not', () => {
  const rows = normalizeIterisCameras(wsfGeo(), WSF_LAYER, { fetchedAt: '2026-10-05T12:00:00Z' });
  assert.equal(WSF.FeedContentList.length, 7);
  assert.equal(rows.length, 4, 'four /wsf/ pictures; the three orflow road cameras are left to a road feed');
  assert.ok(rows.every((r) => r.media.still.startsWith('https://images.wsdot.wa.gov/wsf/')));
  assert.equal(rows[0].name, 'WSF Bainbridge Ferry Holding');
  assert.equal(rows[0].providerId, '9040');
  assert.ok(rows.every((r) => r.rights === 'unverified' && r.operator === 'Washington State Ferries (WSDOT)'));
});

test('wsf: a /wsf/ picture on another host, plain http or with an address path trick is dropped', () => {
  const geo = wsfGeo(WSF.FeedContentList.slice(0, 1));
  for (const bad of ['http://images.wsdot.wa.gov/wsf/Bainbridge/Bainbridge.jpg', 'https://example.com/wsf/Bainbridge/Bainbridge.jpg', 'https://images.wsdot.wa.gov/orflow/305vc00023.jpg', 'https://images.wsdot.wa.gov/wsf/../orflow/305vc00023.jpg', 'https://images.wsdot.wa.gov/wsf/%2e%2e/orflow/305vc00023.jpg', 'https://images.wsdot.wa.gov/wsf/..%2forflow/305vc00023.jpg', 'https://images.wsdot.wa.gov/wsf/./Bainbridge/Bainbridge.jpg', 'https://images.wsdot.wa.gov/wsf/a\\..\\b.jpg', 'https://images.wsdot.wa.gov/wsf/a/.\t./b.jpg', 'https://images.wsdot.wa.gov/wsf/a/b.jpg\n', 'https://images.wsdot.wa.gov/wsf/', 'https://images.wsdot.wa.gov/wsf/Bainbridge/', '']) {
    const g = JSON.parse(JSON.stringify(geo)); g.features[0].properties.image_url = bad;
    assert.deepEqual(normalizeIterisCameras(g, WSF_LAYER, {}), [], bad);
  }
});

// ---------------------------------------------------------------------------------------------
// USGS VolcView / AVO ashcam cameras and NOAA GLERL Great Lakes cameras (keyless, owner-published).
// volcview-2026-10-05.min.json is a real slice of both ashcam API answers of 2026-10-05 (the
// VolcView list and the AVO list, trimmed to the fields the adapter may read); glerl-2026-10-05.min.json
// is the real camera table of https://www.glerl.noaa.gov/metdata/ of the same day.
import { normalizeVolcview, normalizeGlerl, GLERL_STATIONS, VOLCVIEW_HOME, GLERL_HOME }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/source-camera.js';

const VV = read('fixtures/volcview-2026-10-05.min.json');
const GL = read('fixtures/glerl-2026-10-05.min.json');
const VV_AT = '2026-10-05T12:00:00.000Z';
const vvIds = (payload = VV, at = VV_AT) => normalizeVolcview(payload, { fetchedAt: at }).map((r) => r.providerId).sort();
const vvCam = (over) => ({ webcamCode: 'zz-test', webcamName: 'Test cam', latitude: 46.2, longitude: -122.2,
  externalUrl: null, currentImageUrl: 'https://volcview.wr.usgs.gov/ashcam-api/images/webcams/zz-test/current.jpg',
  lastImageTimestamp: Date.parse(VV_AT) / 1000 - 600, vName: 'Test', ...over });

test('volcview: only cameras whose owner is stated or federal, with a position and a picture under a day old', () => {
  assert.deepEqual(vvIds(), ['akutan_aksd', 'amchitka_aht', 'anchorPoint-N', 'anchorPoint-NE', 'augustine',
    'crater-sinnott', 'kilauea-f1-cam', 'kilauea-kw-cam', 'korovin_kowe', 'msh-dome', 'ys-bbsn']);
  const all = new Set(VV.volcview.webcams.map((w) => w.webcamCode));
  const dropped = [...all].filter((c) => !vvIds().includes(c)).sort();
  assert.deepEqual(dropped, ['akunIsland-N', 'akunIsland-W', 'chignikLagoon-SE', 'rainier-elbe', 'shasta-snowcrest'],
    'two stale (a year old), one at 0,0, one WSDOT-owned, one private resort');
});

test('volcview: a record carries the id, name, position, the VolcView picture, the owner credit and no bearing', () => {
  const r = normalizeVolcview(VV, { fetchedAt: VV_AT }).find((x) => x.providerId === 'anchorPoint-N');
  assert.equal(r.provider, 'volcview');
  assert.equal(r.name, 'Anchor Point - N');
  assert.equal(r.lat, 59.75539);
  assert.equal(r.lon, -151.77345);
  assert.equal(r.locationPrecision, 'exact');
  assert.equal(r.media.still, 'https://volcview.wr.usgs.gov/ashcam-api/images/webcams/anchorPoint-N/current.jpg');
  assert.equal(r.media.stream, null);
  assert.equal(r.officialUrl, 'https://volcview.wr.usgs.gov/ashcam-gui/webcam.html?webcam=anchorPoint-N');
  assert.equal(r.operator, 'USGS VolcView');
  assert.equal(r.attribution, 'FAA weather cameras, via USGS VolcView');
  assert.equal(r.rights, 'unverified');
  assert.equal(r.bearing, null, 'the feed bearing is not published');
  assert.equal(r.capturedAt, null);
  assert.equal(r.validUntil, null);
  assert.equal(r.health, 'active');
  assert.ok(normalizeVolcview(VV, { fetchedAt: VV_AT }).some((x) => x.providerId === 'anchorPoint-NE' && x.lat === r.lat && x.lon === r.lon),
    'two directions on one tower are two cameras, not one');
});

test('volcview: each camera is credited to its actual owner: the AVO organization field first, then the page it links to', () => {
  const credit = Object.fromEntries(normalizeVolcview(VV, { fetchedAt: VV_AT }).map((r) => [r.providerId, r.attribution]));
  assert.equal(credit.akutan_aksd, 'Alaska Volcano Observatory, via USGS VolcView');
  assert.equal(credit['kilauea-f1-cam'], 'USGS Hawaiian Volcano Observatory, via USGS VolcView');
  assert.equal(credit.korovin_kowe, 'Alaska Volcano Observatory, via USGS VolcView', 'the organization wins over a junk link');
  assert.equal(credit['crater-sinnott'], 'National Park Service, via USGS VolcView', 'no organization: the nps.gov page it links to');
  assert.equal(credit['msh-dome'], 'USGS Volcano Hazards Program', 'a usgs.gov page');
  assert.equal(credit['ys-bbsn'], 'USGS Volcano Hazards Program', 'no owner stated: the federal publisher of the feed');
  const yvo = normalizeVolcview({ volcview: { webcams: [vvCam()] }, avo: { webcams: [{ ...vvCam(), organization: 'YVO' }] } }, { fetchedAt: VV_AT });
  assert.equal(yvo[0].attribution, 'USGS Yellowstone Volcano Observatory, via USGS VolcView');
});

test('volcview: a camera that links to a private or state owner, with no organization, is dropped (their terms are unknown)', () => {
  for (const url of ['https://sc.snowcrest.net/x.jpg', 'https://images.wsdot.wa.gov/x.jpg', 'https://mtbachelor.powdr-dev.com/x', 'https://video-monitoring.com/x', 'http://www.timberlinelodge.com/x']) {
    assert.deepEqual(vvIds({ volcview: { webcams: [vvCam({ externalUrl: url })] }, avo: { webcams: [] } }), [], url);
  }
  for (const url of [null, '', 'https://avcams.faa.gov/x', 'https://avcamsplus.faa.gov/x', 'https://weathercams.faa.gov/x', 'https://www.nps.gov/x', 'https://volcanoes.usgs.gov/x', 'https://tahoma.wr.usgs.gov/x']) {
    assert.deepEqual(vvIds({ volcview: { webcams: [vvCam({ externalUrl: url })] }, avo: { webcams: [] } }), ['zz-test'], String(url));
  }
  assert.deepEqual(vvIds({ volcview: { webcams: [vvCam({ externalUrl: 'https://notusgs.gov.evil.example/x' })] }, avo: { webcams: [] } }), [],
    'a look-alike host is not a federal one');
});

test('volcview: an organization the AVO list names that is not a known federal or observatory one drops the camera (fail closed)', () => {
  for (const organization of ['UAF', 'DGGS', 'WSDOT', 'Private', 'CalVO']) {
    assert.deepEqual(vvIds({ volcview: { webcams: [vvCam()] }, avo: { webcams: [{ ...vvCam(), organization }] } }), [], organization);
  }
  for (const organization of [{ name: 'UAF' }, ['UAF'], 42, true, 0, false]) {
    assert.deepEqual(vvIds({ volcview: { webcams: [vvCam()] }, avo: { webcams: [{ ...vvCam(), organization }] } }), [], JSON.stringify(organization));
  }
  for (const organization of [null, undefined, '']) {
    assert.deepEqual(vvIds({ volcview: { webcams: [vvCam()] }, avo: { webcams: [{ ...vvCam(), organization }] } }), ['zz-test'], String(organization));
  }
});

test('volcview: a newest picture stamped in the future (bad clock) is dropped; ten minutes of skew is kept', () => {
  const at = Date.parse(VV_AT) / 1000;
  const run = (ts) => vvIds({ volcview: { webcams: [vvCam({ lastImageTimestamp: ts })] }, avo: { webcams: [] } });
  assert.deepEqual(run(at + 600), ['zz-test']);
  assert.deepEqual(run(at + 601), []);
  assert.deepEqual(run(at + 30 * 86400), []);
});

test('volcview: a picture older than 24 hours, or with no timestamp, is stale; exactly 24 hours is kept', () => {
  const at = Date.parse(VV_AT) / 1000;
  const run = (ts) => vvIds({ volcview: { webcams: [vvCam({ lastImageTimestamp: ts })] }, avo: { webcams: [] } });
  assert.deepEqual(run(at - 86400), ['zz-test']);
  assert.deepEqual(run(at - 86401), []);
  assert.deepEqual(run(null), []);
  assert.deepEqual(run(0), []);
});

test('volcview: no still, a still off the VolcView image host, or no position, is dropped; 0,0 is no position', () => {
  const one = (over) => vvIds({ volcview: { webcams: [vvCam(over)] }, avo: { webcams: [] } });
  assert.deepEqual(one({}), ['zz-test']);
  assert.deepEqual(one({ currentImageUrl: null }), []);
  assert.deepEqual(one({ currentImageUrl: 'https://evil.example/a.jpg' }), []);
  assert.deepEqual(one({ currentImageUrl: 'http://volcview.wr.usgs.gov/a.jpg' }), [], 'https only');
  assert.deepEqual(one({ latitude: null }), []);
  assert.deepEqual(one({ longitude: '' }), []);
  assert.deepEqual(one({ latitude: 0, longitude: 0 }), []);
});

test('volcview: one camera listed by both APIs is one record; the same camera under a second code within 50 m is one record', () => {
  const dup = { volcview: { webcams: [vvCam({ webcamCode: 'x-N', webcamName: 'Akun Island - N' }), vvCam({ webcamCode: 'x-N' })] },
    avo: { webcams: [{ ...vvCam({ webcamCode: 'x-N' }), organization: 'FAA' }] } };
  assert.deepEqual(vvIds(dup), ['x-N']);
  const near = { volcview: { webcams: [vvCam({ webcamCode: 'a-1', webcamName: 'Akun Island - N', latitude: 54.1469 }),
    vvCam({ webcamCode: 'Akun Island-N', webcamName: 'Akun Island-N', latitude: 54.14693 })] }, avo: { webcams: [] } };
  assert.equal(vvIds(near).length, 1, 'same name (ignoring spaces and dashes), 3 m apart');
  const far = { volcview: { webcams: [vvCam({ webcamCode: 'a-1', webcamName: 'Akun Island - N', latitude: 54.1469 }),
    vvCam({ webcamCode: 'a-2', webcamName: 'Akun Island - N', latitude: 54.1569 })] }, avo: { webcams: [] } };
  assert.equal(vvIds(far).length, 2, '1 km apart is two cameras');
});

test('volcview: a camera only the AVO list has is not published (its picture is on a host this site does not pin)', () => {
  const avoOnly = { volcview: { webcams: [] }, avo: { webcams: [{ ...vvCam(), organization: 'AVO',
    currentImageUrl: 'https://avo.alaska.edu/ashcam-api/images/webcams/zz-test/current.jpg' }] } };
  assert.deepEqual(vvIds(avoOnly), []);
});

test('volcview: a payload that is not the two lists gives no cameras and never throws', () => {
  for (const bad of [null, {}, [], { volcview: 'x' }, { volcview: { webcams: 'x' }, avo: null }, { volcview: { webcams: [null, 3, {}] } }]) {
    assert.deepEqual(normalizeVolcview(bad, { fetchedAt: VV_AT }), [], JSON.stringify(bad));
  }
  assert.equal(VOLCVIEW_HOME, 'https://volcview.wr.usgs.gov/');
});

test('glerl: every camera in the table of a station this module knows is one record, in the lake it sits in', () => {
  const records = normalizeGlerl(GL, { fetchedAt: VV_AT });
  assert.equal(records.length, 53);
  const ids = records.map((r) => r.providerId);
  assert.equal(new Set(ids).size, 53);
  for (const stem of ['apn01', 'chi03', 'mcy02', 'mkg08', 'mkglight06', 'shv04', 'srl05', 'std12', 'tbi05', 'wsl03']) assert.ok(ids.includes(stem), stem);
  const r = records.find((x) => x.providerId === 'apn01');
  assert.equal(r.provider, 'glerl');
  assert.equal(r.name, 'Alpena Light (camera 1)');
  assert.equal(r.lat, 45.060359);
  assert.equal(r.lon, -83.422986);
  assert.equal(r.media.still, 'https://www.glerl.noaa.gov/metdata/cams/apn01.jpg');
  assert.equal(r.officialUrl, 'https://www.glerl.noaa.gov/metdata/apn/');
  assert.equal(r.operator, 'NOAA GLERL');
  assert.equal(r.attribution, 'NOAA Great Lakes Environmental Research Laboratory (GLERL)');
  assert.equal(r.rights, 'unverified');
  assert.equal(r.bearing, null);
  assert.equal(records.find((x) => x.providerId === 'srl01').officialUrl, 'https://www.glerl.noaa.gov/res/recon/station-srl.html');
  assert.equal(records.find((x) => x.providerId === 'mkglight01').lon, -86.341389);
});

test('glerl: a camera of a station with no known position, a commented-out camera and a thumbnail are never records', () => {
  const html = '<table><tr><td><a href="cams/apn01.jpg?1"><img src="cams/apn01-tns.jpg?1"></a></td>'
    + '<td><a href="cams/zzz01.jpg?1"><img src="cams/zzz01-tns.jpg?1"></a></td>'
    + '<!--<td><a href="cams/apn02.jpg?1"><img src="cams/apn02-tns.jpg?1"></a></td>-->'
    + '<td><a href="cams/apn01.jpg?2">again</a></td></table>';
  assert.deepEqual(normalizeGlerl({ metdataHtml: html }, { fetchedAt: VV_AT }).map((x) => x.providerId), ['apn01']);
  for (const bad of [null, {}, { metdataHtml: 5 }, { metdataHtml: '' }]) assert.deepEqual(normalizeGlerl(bad, { fetchedAt: VV_AT }), []);
  assert.equal(GLERL_HOME, 'https://www.glerl.noaa.gov/metdata/');
});

test('glerl: every station sits in the Great Lakes region and names the page it was read from', () => {
  for (const s of GLERL_STATIONS) {
    assert.ok(s.lat > 41 && s.lat < 48 && s.lon < -82 && s.lon > -88, s.code);
    assert.match(s.page, /^https:\/\/www\.glerl\.noaa\.gov\/(metdata\/[a-z]+\/|res\/recon\/station-[a-z]+\.html)$/, s.code);
  }
});

test('CSP: the VolcView and GLERL picture hosts join img-src as exact hosts, painted as an <img>, never in connect-src', () => {
  const csp = cspDirectivesFor();
  for (const [key, origin] of [['volcview', 'https://volcview.wr.usgs.gov'], ['glerl', 'https://www.glerl.noaa.gov']]) {
    const s = SOURCES[key];
    assert.equal(s.origin, origin);
    assert.equal(s.paintedAs, 'img');
    assert.equal(s.cors, 'none');
    assert.equal(s.kind, 'camera-feed');
    assert.equal(s.limits.requiresKey, false);
    assert.ok(csp['img-src'].includes(origin));
    assert.ok(!csp['connect-src'].includes(origin));
  }
  const hosts = new Set(cspDirectivesFor()['img-src']);
  for (const r of [...normalizeVolcview(VV, { fetchedAt: VV_AT }), ...normalizeGlerl(GL, { fetchedAt: VV_AT })]) {
    assert.ok(hosts.has(new URL(r.media.still).origin), r.media.still);
  }
});
