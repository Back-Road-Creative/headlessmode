// Evidence availability and source vintage (HM-4), against the pure module the
// Quiet Corners popup and methodology panel read. Producer contract: WS-QC1
// (sprawl_factor_status, evidence_schema_version, sprawl_factor_availability) and
// WS-QC2 (freshness.source_vintage / run_time / refresh_schedule).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factorEvidence, factorDisplay, freshness, availabilityState } from '../../themes/headlessmode/static/js/quiet-corners-maps/evidence.js';

test('genuine measured zero shows 0, not "no data"', () => {
  const c = { sprawl_factors: { interstate: 0 }, sprawl_factor_status: { interstate: 'observed' } };
  assert.deepEqual(factorEvidence(c, 'interstate'), { state: 'observed', value: 0 });
  const d = factorDisplay(c, 'interstate');
  assert.equal(d.text, '0');
  assert.equal(d.state, 'observed');
});

test('unavailable evidence reads "no data" even though the score is 0', () => {
  const c = { sprawl_factors: { permits: 0 }, sprawl_factor_status: { permits: 'unavailable' } };
  const d = factorDisplay(c, 'permits');
  assert.equal(d.text, 'no data');
  assert.equal(d.state, 'unavailable');
  assert.notEqual(d.text, factorDisplay({ sprawl_factors: { permits: 0 }, sprawl_factor_status: { permits: 'observed' } }, 'permits').text);
});

test('partial shows the rounded number with an estimate marker', () => {
  const c = { sprawl_factors: { migration: 12.4 }, sprawl_factor_status: { migration: 'partial' } };
  const d = factorDisplay(c, 'migration');
  assert.equal(d.text, '12 est.');
  assert.equal(d.state, 'partial');
  assert.match(d.title, /gap-filled|estimate/i);
});

test('observed non-zero shows the rounded number', () => {
  const c = { sprawl_factors: { recreation: 57.6 }, sprawl_factor_status: { recreation: 'observed' } };
  assert.equal(factorDisplay(c, 'recreation').text, '58');
});

test('a county with no status block is unknown, never "no data"', () => {
  const c = { sprawl_factors: { metro_growth: 0 } };
  assert.deepEqual(factorEvidence(c, 'metro_growth'), { state: 'unknown', value: 0 });
  const d = factorDisplay(c, 'metro_growth');
  assert.equal(d.state, 'unknown');
  assert.equal(d.text, 'n/a');
  assert.ok(d.title.length > 0);
});

test('a status outside the four values reads as unknown', () => {
  const c = { sprawl_factors: { interstate: 3 }, sprawl_factor_status: { interstate: 'bogus' } };
  assert.equal(factorEvidence(c, 'interstate').state, 'unknown');
  assert.equal(factorDisplay(c, 'interstate').text, 'n/a');
});

test('a missing key in a present status block is unknown; missing value is null', () => {
  const c = { sprawl_factor_status: { permits: 'observed' } };
  assert.deepEqual(factorEvidence(c, 'interstate'), { state: 'unknown', value: null });
  assert.equal(factorEvidence(c, 'permits').value, null);
});

test('legacy unknown status is explicit and distinct', () => {
  const c = { sprawl_factors: { permits: 5 }, sprawl_factor_status: { permits: 'unknown' } };
  assert.equal(factorDisplay(c, 'permits').text, 'n/a');
});

test('null or empty county does not throw', () => {
  assert.equal(factorEvidence(null, 'interstate').state, 'unknown');
  assert.equal(factorDisplay(undefined, 'interstate').text, 'n/a');
});

test('v1 summary: availability unknown, freshness nulls, version 0', () => {
  const v1 = { generated_at: '2026-08-01T00:00:00Z', pipeline_version: '1.0' };
  assert.equal(availabilityState(v1), 'unknown');
  assert.deepEqual(freshness(v1), { generated: '2026-08-01T00:00:00Z', sourceVintage: null, refreshSchedule: null, schemaVersion: 0 });
  assert.equal(availabilityState(null), 'unknown');
  assert.deepEqual(freshness(null), { generated: null, sourceVintage: null, refreshSchedule: null, schemaVersion: 0 });
});

test('schema version alone is not enough: availability block must be an object', () => {
  assert.equal(availabilityState({ evidence_schema_version: 1 }), 'unknown');
  assert.equal(availabilityState({ evidence_schema_version: 1, sprawl_factor_availability: 'x' }), 'unknown');
});

test('v2 summary: generation time and source vintage stay separate', () => {
  const v2 = {
    generated_at: '2026-09-30T06:00:00Z',
    evidence_schema_version: 1,
    sprawl_factor_availability: { interstate: { observed: 3000, unavailable: 5 } },
    freshness: {
      source_vintage: { census_pep: '2024', acs_b07001: '2023 1-year' },
      run_time: '2026-09-30T06:00:00Z',
      refresh_schedule: '0 6 * * 1',
    },
  };
  assert.equal(availabilityState(v2), 'known');
  const f = freshness(v2);
  assert.equal(f.generated, '2026-09-30T06:00:00Z');
  assert.deepEqual(f.sourceVintage, { census_pep: '2024', acs_b07001: '2023 1-year' });
  assert.equal(f.refreshSchedule, '0 6 * * 1');
  assert.equal(f.schemaVersion, 1);
  assert.notDeepEqual(f.generated, f.sourceVintage);
});

test('freshness ignores a malformed source_vintage', () => {
  assert.equal(freshness({ freshness: { source_vintage: 'oops' } }).sourceVintage, null);
  assert.equal(freshness({ freshness: { refresh_schedule: 5 } }).refreshSchedule, null);
});
