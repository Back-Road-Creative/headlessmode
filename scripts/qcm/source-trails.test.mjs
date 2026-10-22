// Non-motorized trails, and the rule that silence is not a prohibition.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedUses, useCode, symbolKeyForTrail, normalizeTrail, fetchTrails, TRAILS_SOURCE }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/source-trails.js';
import { SYMBOL_BY_KEY } from '../../themes/headlessmode/static/js/quiet-corners-maps/legend.js';

// Shapes copied from a live query over the Standing Indian quad, 2026-09-06.
const raw = (attrs, paths = [[[-83.5, 35.0], [-83.45, 35.05]]]) => ({ attributes: attrs, geometry: { paths } });
const AT = raw({ permanentidentifier: 'a1', name: 'Appalachian National Scenic Trail', trailnumber: 'TR1',
  nationaltraildesignation: 'NST - Appalachian', hikerpedestrian: 'Y', bicycle: null, packsaddle: null, motorcycle: null });
const MULTI = raw({ permanentidentifier: 'a2', name: 'Timber Ridge', trailnumber: 'TR22',
  hikerpedestrian: 'Y', bicycle: 'Y', packsaddle: 'Y', motorcycle: null });
const SILENT = raw({ permanentidentifier: 'a3', name: 'Unnamed Spur' });

test('a stated use is read; an unstated one is silence, not a "no"', () => {
  assert.deepEqual(allowedUses(AT.attributes), ['hike']);
  assert.deepEqual(allowedUses(MULTI.attributes), ['hike', 'bike', 'horse']);
  // Every use field absent -> null. This is the distinction the whole layer turns on:
  // 6 of the 63 trails measured in the test quad were like this.
  assert.equal(allowedUses(SILENT.attributes), null, 'no fields at all means the source said nothing');
  // Fields PRESENT but all "N" is a real statement: this trail allows nothing listed.
  assert.deepEqual(allowedUses({ hikerpedestrian: 'N', bicycle: 'N', packsaddle: 'N', motorcycle: 'N' }), [],
    'an explicit "N" is data, and must not be confused with silence');
});

test('the use code is compact and omitted entirely when nothing was stated', () => {
  assert.equal(useCode(['hike']), 'H');
  assert.equal(useCode(['hike', 'bike', 'horse']), 'HBE');
  assert.equal(useCode(null), null, 'silence prints no letters at all');
  assert.equal(useCode([]), null, 'and neither does an explicit nothing-allowed');
});

test('a National Scenic Trail gets its own symbol; silence gets the dotted one', () => {
  assert.equal(symbolKeyForTrail({ designation: 'NST - Appalachian', uses: ['hike'] }), 'trail-nst');
  assert.equal(symbolKeyForTrail({ designation: null, uses: ['hike'] }), 'trail-nonmotor');
  // Dot already means "the source did not say" for MVUM season. Same meaning here.
  assert.equal(symbolKeyForTrail({ designation: null, uses: null }), 'trail-nonmotor-unstated');
  for (const key of ['trail-nst', 'trail-nonmotor', 'trail-nonmotor-unstated']) {
    assert.ok(SYMBOL_BY_KEY[key], `${key} is not in the symbol table`);
  }
  assert.equal(SYMBOL_BY_KEY['trail-nonmotor-unstated'].pattern, 'dot');
  assert.ok(SYMBOL_BY_KEY['trail-nst'].widthIn > SYMBOL_BY_KEY['trail-nonmotor'].widthIn,
    'a National Scenic Trail draws more prominently');
});

test('normalizeTrail produces the shape overlay-paths already consumes', () => {
  const t = normalizeTrail(MULTI);
  assert.equal(t.name, 'Timber Ridge');
  assert.equal(t.useCode, 'HBE');
  assert.equal(t.symbolKey, 'trail-nonmotor');
  // [lon, lat], because outSR=4326 is requested and that is the order the print
  // path stores. A swap here would put North Carolina in the Indian Ocean.
  assert.deepEqual(t.paths[0][0], [-83.5, 35.0]);
  assert.equal(normalizeTrail(AT).symbolKey, 'trail-nst');
  assert.equal(normalizeTrail(SILENT).useCode, null);
});

test('a trail with no drawable geometry is dropped, not drawn as a point', () => {
  assert.deepEqual(normalizeTrail(raw({ name: 'x' }, [[[-83.5, 35]]])).paths, []);
  assert.deepEqual(normalizeTrail({ attributes: { name: 'y' } }).paths, []);
});

test('fetchTrails asks in lon/lat, and counts what the source stayed silent about', async () => {
  let seen = null;
  const r = await fetchTrails({
    bboxLonLat: { minLon: -83.6, minLat: 35.0, maxLon: -83.4, maxLat: 35.125 },
    fetchImpl: async (url, init) => { seen = { url, body: init.body.toString() }; return { ok: true, json: async () => ({ features: [AT, MULTI, SILENT] }) }; },
  });
  assert.equal(r.features.length, 3);
  assert.equal(r.usesUnstated, 1, 'the page must be able to say how much the source did not state');
  // outSR must be requested, or geometry comes back in Web Mercator and every
  // trail lands off the coast of Africa.
  assert.match(seen.body, /outSR=4326/);
  assert.match(seen.body, /nationaltraildesignation/);

  await assert.rejects(fetchTrails({ bboxLonLat: { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 },
    fetchImpl: async () => ({ ok: false, status: 500 }) }), /answered 500/);
});

// A large rectangle answers in pages, and a single /query says so in
// `exceededTransferLimit`. This adapter read only the first page and its caller
// called the result 'ready', so a box past the transfer limit printed a sheet
// missing trails with nothing said — the same defect the recreation-site adapter
// already had fixed (audit F14).
test('fetchTrails pages, and says partial when the service still has more', async () => {
  const page = (features, more) => ({ ok: true, json: async () => ({ features, exceededTransferLimit: more }) });
  const bbox = { minLon: -83.6, minLat: 35.0, maxLon: -83.4, maxLat: 35.125 };
  let call = 0; const offsets = [];
  const two = await fetchTrails({
    bboxLonLat: bbox,
    fetchImpl: async (_u, o) => { offsets.push(o.body.get('resultOffset'));
      return ++call === 1 ? page([AT], true) : page([MULTI], false); },
  });
  assert.deepEqual(offsets, ['0', '1'], 'the second page must start after the first');
  assert.equal(two.pages, 2);
  assert.equal(two.features.length, 2);
  assert.equal(two.coverage, 'complete');

  const stuck = await fetchTrails({ bboxLonLat: bbox, fetchImpl: async () => page([], true) });
  assert.equal(stuck.coverage, 'partial', 'a truncated answer must not read as a complete one');
});

test('the source states plainly what a blank field means', () => {
  assert.equal(TRAILS_SOURCE.origin, 'https://carto.nationalmap.gov', 'already a CSP-allowed origin');
  assert.match(TRAILS_SOURCE.coverageSemantics, /silence, not a prohibition/);
});
