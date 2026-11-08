// Evidence availability and source vintage for the Quiet Corners dashboard (HM-4).
//
// The producer scores an unavailable sprawl factor as 0.0, so a score alone cannot say
// whether a zero was measured or simply had no data behind it. Producer contract
// (WS-QC1, evidence_schema_version 1) adds a per-county `sprawl_factor_status` block;
// WS-QC2 adds `freshness` (source vintage vs run time) to summary.json. These helpers
// read those blocks and fall back to an explicit "unknown" for a v1 dataset that
// carries neither. They never alter a score, ranking or filter.

export const EVIDENCE_STATES = ['observed', 'partial', 'unavailable', 'unknown'];

const TITLES = {
  observed: 'Measured: every input came from a source record.',
  partial: 'Estimate: scored on a gap-filled input.',
  unavailable: 'No source evidence for this county. The score of 0 is not a measurement.',
  unknown: 'Not recorded: this dataset does not say whether the figure was measured.',
};

/** @returns {{state: string, value: number|null}} */
export function factorEvidence(county, factor) {
  const status = county && county.sprawl_factor_status;
  const raw = status && typeof status === 'object' ? status[factor] : undefined;
  const state = EVIDENCE_STATES.includes(raw) ? raw : 'unknown';
  const factors = county && county.sprawl_factors;
  const v = factors && typeof factors === 'object' ? factors[factor] : undefined;
  return { state, value: typeof v === 'number' && Number.isFinite(v) ? v : null };
}

/** @returns {{text: string, title: string, state: string}} */
export function factorDisplay(county, factor) {
  const { state, value } = factorEvidence(county, factor);
  const num = value === null ? '0' : value.toFixed(0);
  let text;
  if (state === 'observed') text = num;
  else if (state === 'partial') text = num + ' est.';
  else if (state === 'unavailable') text = 'no data';
  else text = 'n/a';
  return { text, title: TITLES[state], state };
}

/** @returns {{generated: string|null, sourceVintage: object|null, refreshSchedule: string|null, schemaVersion: number}} */
export function freshness(summary) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const f = s.freshness && typeof s.freshness === 'object' ? s.freshness : {};
  const vintage = f.source_vintage;
  return {
    generated: s.generated_at || null,
    sourceVintage: vintage && typeof vintage === 'object' && !Array.isArray(vintage) ? vintage : null,
    refreshSchedule: typeof f.refresh_schedule === 'string' ? f.refresh_schedule : null,
    schemaVersion: typeof s.evidence_schema_version === 'number' ? s.evidence_schema_version : 0,
  };
}

/** 'known' when the dataset records per-factor availability; else the explicit v1 state. */
export function availabilityState(summary) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const a = s.sprawl_factor_availability;
  return s.evidence_schema_version >= 1 && a && typeof a === 'object' ? 'known' : 'unknown';
}
