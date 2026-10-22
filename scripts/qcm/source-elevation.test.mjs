// Elevation: distance plus climb is what makes a route a trip rather than a line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { samplePointsAlong, gainAndLoss, lengthMeters, fetchElevations, profileFor, MAX_POINTS_PER_CALL, ELEVATION_SOURCE, pointElevationFact }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/source-elevation.js';
import { layoutTrip } from '../../themes/headlessmode/static/js/quiet-corners-maps/pdf.js';
import { planSheets } from '../../themes/headlessmode/static/js/quiet-corners-maps/sheet-plan.js';

const plan = planSheets({ paper: 'letter', orientation: 'portrait', scale: 24000, overlapIn: 0.5, dpi: 300,
  title: 'T', extent: { minX: 0, minY: 0, maxX: 9000, maxY: 11000 }, zone: 17, hemisphere: 'N' });

test('sampling keeps both ends, so a summit at the far end is never missed', () => {
  const long = [Array.from({ length: 500 }, (_, i) => [-83.5 + i * 1e-4, 35])];
  const pts = samplePointsAlong(long, 5);
  assert.equal(pts.length, 5);
  assert.deepEqual(pts[0], long[0][0], 'first point kept');
  assert.deepEqual(pts.at(-1), long[0].at(-1), 'last point kept');
  // A short line is returned whole rather than resampled.
  const short = [[[-83.5, 35], [-83.4, 35]]];
  assert.deepEqual(samplePointsAlong(short, 60), short[0]);
  assert.deepEqual(samplePointsAlong([], 10), []);
});

test('climb sums the ups; a NoData sample is bridged, not read as a cliff', () => {
  assert.deepEqual(gainAndLoss([100, 150, 120, 300]), { gainM: 230, lossM: 30, sampled: 4, minM: 100, maxM: 300 });
  // Without bridging, the null would read as a 300 m drop then a 280 m climb.
  const bridged = gainAndLoss([100, 300, null, 280]);
  assert.equal(bridged.gainM, 200);
  assert.equal(bridged.lossM, 20);
  assert.equal(bridged.sampled, 3, 'the null is not counted as a sample');
  assert.deepEqual(gainAndLoss([]), { gainM: 0, lossM: 0, sampled: 0, minM: null, maxM: null });
  assert.equal(gainAndLoss([500]).gainM, 0, 'one point is no climb');
});

test('length is the ellipsoidal one: published degree lengths, not a flat 111320 m', () => {
  // 0.1 degree of longitude at 35 N on WGS84 is 9128.8 m; the flat 111320 * cos(35) shortcut gave 9120.
  assert.ok(Math.abs(lengthMeters([[[-83.5, 35], [-83.4, 35]]]) - 9128.8) < 0.5);
  // One degree of latitude at 35.5 N is 110949.8 m, not the flat 111320.
  assert.ok(Math.abs(lengthMeters([[[-83.5, 35], [-83.5, 36]]]) - 110949.8) < 0.5);
  assert.equal(lengthMeters([]), 0);
  assert.equal(lengthMeters([[[-83.5, 35]]]), 0, 'a single point has no length');
  // A path that cannot be measured is not quietly left out of the total (QQA-09 review).
  assert.equal(lengthMeters([[[-83.5, 35], [-83.4, 35]], [[-83.5, 35], [NaN, 35]]]), null);
  assert.equal(lengthMeters([[[-83.5, 35], [-83.4, 95]]]), null, 'a latitude past the pole');
});

test('fetchElevations chunks, and places a NoData sample as null rather than 0', async () => {
  const points = Array.from({ length: MAX_POINTS_PER_CALL + 30 }, (_, i) => [-83.5, 35 + i * 1e-5]);
  let calls = 0;
  const out = await fetchElevations({
    points,
    fetchImpl: async (url, init) => {
      calls++;
      const sent = JSON.parse(new URLSearchParams(init.body.toString()).get('geometry')).points;
      return { ok: true, json: async () => ({ samples: sent.map((_, k) => ({ locationId: k, value: k === 0 ? 'NoData' : String(1000 + k) })) }) };
    },
  });
  assert.equal(calls, 2, 'a long route becomes a few calls, not one per point');
  assert.equal(out.length, points.length);
  assert.equal(out[0], null, 'NoData is null — 0 would be sea level and invent a cliff');
  assert.equal(out[1], 1001);

  await assert.rejects(fetchElevations({ points: [[-83, 35]], fetchImpl: async () => ({ ok: false, status: 503 }) }), /answered 503/);
});

test('fetchElevations rejects and returns nothing once the caller aborts mid-flight', async () => {
  const controller = new AbortController();
  let settled = false;
  // Stands in for a real in-flight fetch: it never resolves on its own, only
  // reacting when the signal it was handed aborts — the same signal a card
  // that has moved on cancels, so a stale response can never arrive at all.
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const err = new Error('The user aborted a request.');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const pending = fetchElevations({ points: [[-83, 35]], fetchImpl, signal: controller.signal })
    .then((v) => { settled = true; return v; }, (e) => { settled = true; throw e; });
  controller.abort();
  await assert.rejects(pending, /AbortError|aborted/i);
  assert.equal(settled, true, 'the call settles (by rejecting) rather than hanging forever');
});

test('profileFor returns the trip facts a route needs', async () => {
  const feature = { paths: [[[-83.5, 35], [-83.45, 35.02], [-83.4, 35.05]]] };
  const p = await profileFor(feature, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ samples: [{ locationId: 0, value: '900' }, { locationId: 1, value: '1100' }, { locationId: 2, value: '1050' }] }) }),
  });
  assert.equal(p.gainM, 200);
  assert.equal(p.lossM, 50);
  assert.equal(p.points, 3);
  assert.ok(p.lengthM > 9000 && p.lengthM < 12000);
  const bad = await profileFor({ paths: [[[-83.5, 35], [-83.45, 35.02]], [[-83.5, 35], [null, 35]]] }, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ samples: [] }) }),
  });
  assert.equal(bad.lengthM, null, 'an unmeasurable path is no length, not a short one (pdf.js prints a dash)');
});

test('the trip page lists every route once, with miles and feet', () => {
  const trips = [
    { name: 'Appalachian Trail', lengthM: 9000, gainM: 400, sampled: 60, useCode: 'H', sheets: ['A1', 'A2'] },
    { name: 'Timber Ridge', lengthM: 3200, gainM: 120, sampled: 40, useCode: 'HBE', sheets: ['B1'] },
  ];
  const [page] = layoutTrip(plan, trips, { title: 'Standing Indian' });
  const cells = page.items.filter((i) => i.role === 'trip-cell').map((i) => i.text);
  assert.equal(cells.filter((c) => c === 'Appalachian Trail').length, 1, 'each route appears once');
  assert.ok(cells.includes('5.6'), 'metres are shown to the reader as miles');
  assert.ok(cells.includes('1312'), 'and climb as feet');
  assert.ok(cells.includes('A1 A2'), 'with the sheets it crosses');
  assert.ok(page.items.some((i) => i.role === 'trip-note'), 'and the sampling caveat');
});

test('a route with no elevation sampled shows a dash, never a fabricated zero', () => {
  const [page] = layoutTrip(plan, [{ name: 'Unknown', lengthM: 1000, gainM: 0, sampled: 0, sheets: ['A1'] }], {});
  const cells = page.items.filter((i) => i.role === 'trip-cell').map((i) => i.text);
  assert.ok(cells.includes('—'), 'unsampled climb reads as unknown, not as flat');
});

test('an empty set still produces a page that says so', () => {
  const pages = layoutTrip(plan, [], { title: 'T' });
  assert.equal(pages.length, 1);
  assert.ok(pages[0].items.some((i) => i.role === 'trip-empty'));
});

test('a long set paginates rather than running off the sheet', () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ name: `Route ${i}`, lengthM: 1000, gainM: 10, sampled: 5, sheets: ['A1'] }));
  const pages = layoutTrip(plan, many, { title: 'T' });
  assert.ok(pages.length > 1, 'it must break across pages');
  const bottom = plan.frame.yPt + plan.frame.heightIn * 72;
  for (const p of pages) for (const i of p.items) assert.ok(i.y <= bottom + 1, `${i.text} ran off the page`);
});

test('the source states what the number is and is not', () => {
  assert.equal(ELEVATION_SOURCE.origin, 'https://elevation.nationalmap.gov');
  assert.match(ELEVATION_SOURCE.coverageSemantics, /planning figure, not a survey/);
});

test('the one-point wording describes a single point\'s value, never a drawn line', () => {
  const t = ELEVATION_SOURCE.pointSemantics;
  assert.equal(typeof t, 'string', 'ELEVATION_SOURCE needs a pointSemantics sentence for a name card');
  assert.match(t, /interpolated between lidar returns/);
  assert.match(t, /not a reading at this (exact )?point/);
  assert.match(t, /bare earth/);
  assert.match(t, /approximate/i);
  assert.doesNotMatch(t, /drawn|line|route|gain|sampled along/i);
  assert.notEqual(t, ELEVATION_SOURCE.coverageSemantics);
});

test('QQA-09: a sampled elevation is a fact record: ground elevation, named source, vertical reference as stated, resolution as stated', () => {
  const f = pointElevationFact(1628.2416);
  assert.equal(f.value, 1628.2416);
  assert.equal(f.unit, 'm');
  assert.equal(f.status, 'approximate');
  assert.equal(f.method, 'published');
  assert.match(f.basis, /ground elevation at the sampled point/i);
  assert.equal(f.source, 'USGS 3D Elevation Program (3DEP)');
  assert.equal(f.verticalReference, 'vertical reference not stated by source');
  assert.equal(f.resolution, 'resolution not stated by source');
  assert.equal(ELEVATION_SOURCE.verticalReference, f.verticalReference);
});

test('QQA-09: zero metres is a value; no data is unknown, never 0', () => {
  const sea = pointElevationFact(0);
  assert.equal(sea.value, 0);
  assert.notEqual(sea.status, 'unavailable');
  for (const nothing of [null, undefined, NaN, 'NoData']) {
    const f = pointElevationFact(nothing);
    assert.equal(f.value, null, String(nothing));
    assert.equal(f.status, 'unavailable');
    assert.match(f.reason, /no elevation|no data/i);
    assert.equal(f.source, 'USGS 3D Elevation Program (3DEP)', 'the source is still named');
  }
});
