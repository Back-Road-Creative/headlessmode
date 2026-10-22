// The physical print-proof record and the test that gates the product
// surfaces on it. Run: node --test "scripts/qcm/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The gate is on the CLAIM, not on a link. It used to forbid any surface naming
// /quiet-corners/maps/ while the record was not `passed` -- and went silent the
// moment the builder stopped being a page to link to and became a panel on the
// dashboard: nothing linked anywhere, every check passed, and the unproven promise
// was live for every visitor. A gate a refactor can satisfy by deleting the thing
// it measures was never measuring the risk.
//
// "Letter", "1:24,000", "0.5 in overlap" are assertions about paper, made by the
// controls, so the caveat ships INSIDE the controls partial, rendered from this
// record. Hosting the builder carries the caveat by construction; these tests
// assert that construction rather than re-checking each host.
const CONTROLS = '../../themes/headlessmode/layouts/partials/qcm-controls.html';
// A surface hosts the builder iff it loads the module -- not a spelling: without
// main.js there are no live controls, whatever markup is on the page.
const HOST_MARKER = 'js/quiet-corners-maps/main.js';
const CAVEAT_MARKER = 'qcm-proof-note';
const PHYSICAL_CLAIMS = ['1:24,000', '1:48,000', 'Letter'];

const SURFACE_FILES = {
  quietCorners: '../../content/quiet-corners.md',
  dashboard: '../../themes/headlessmode/layouts/_default/quiet-corners-dashboard.html',
  maps: '../../themes/headlessmode/layouts/_default/quiet-corners-maps.html',
  controls: CONTROLS,
  // The product catalogue and the llms index are site surfaces, not app files:
  // scripts/test-site-surface.mjs holds them to the same claim rules in every PR CI tier.
  // A "print field maps for this county" handoff could be added in JS.
  dashboardScript: '../../themes/headlessmode/static/js/quiet-corners.js',
};

function readSurfaces() {
  const out = {};
  for (const [key, rel] of Object.entries(SURFACE_FILES)) {
    out[key] = readFileSync(new URL(rel, import.meta.url), 'utf8');
  }
  return out;
}

const RECORD_STATUSES = ['pending', 'passed', 'failed'];
const RECORD_KEYS = [
  'status', 'schemaVersion', 'area', 'measuredOn', 'printer', 'printDialog',
  'browser', 'paper', 'scale', 'dpi', 'pages', 'scaleBarErrorPct',
  'sheetDimensionErrorMm', 'seamOffsetsMm', 'missingTilesAtSeams',
  'grayscaleClassesDistinct', 'legendExact', 'indexCorrect',
  'fitWarningVisible', 'pdfBytes', 'buildSeconds', 'peakMemoryMb',
  'failedSourceRequests', 'photos', 'notes',
];
const ARRAY_KEYS = ['seamOffsetsMm', 'photos'];

// Pure checks. Each returns an array of failure strings (empty = ok) so
// the same functions run against synthetic records/files and the real ones.

function checkSchema(record) {
  const fails = [];
  for (const k of RECORD_KEYS) {
    if (!(k in record)) fails.push(`record is missing key ${k}`);
  }
  if (!RECORD_STATUSES.includes(record.status)) {
    fails.push(`status ${JSON.stringify(record.status)} is not one of ${RECORD_STATUSES.join(', ')}`);
  }
  if (record.schemaVersion !== 1) fails.push(`schemaVersion ${record.schemaVersion} !== 1`);
  for (const k of ARRAY_KEYS) {
    if (!Array.isArray(record[k])) fails.push(`${k} is not an array`);
  }
  return fails;
}

/** A host satisfies this by including the controls partial, which renders the
 *  caveat from the record — the honest way to pass is the only easy way. */
function checkClaimIsCaveated(record, files, controls) {
  const fails = [];
  if (record.status === 'passed') return fails;
  if (!controls.includes(CAVEAT_MARKER)) {
    fails.push(`the controls partial renders no ${CAVEAT_MARKER} while status is ${record.status}`);
  }
  for (const [name, text] of Object.entries(files)) {
    if (!text.includes(HOST_MARKER)) continue;
    if (!text.includes('qcm-controls.html') && !text.includes(CAVEAT_MARKER)) {
      fails.push(`${name} hosts the builder with no caveat while status is ${record.status}`);
    }
  }
  return fails;
}

/** Two files making the same promise is two places to forget the caveat, and the
 *  caveat only ships with one of them. */
function checkClaimsHaveOneHome(files) {
  const fails = [];
  for (const claim of PHYSICAL_CLAIMS) {
    const carriers = Object.entries(files).filter(([, text]) => text.includes(claim)).map(([n]) => n);
    const stray = carriers.filter((n) => n !== 'controls');
    if (!carriers.includes('controls')) fails.push(`the controls do not state ${claim}`);
    if (stray.length) fails.push(`${claim} is also claimed by ${stray.join(', ')}`);
  }
  return fails;
}

function isIsoDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function checkPassedTolerances(record, files) {
  const fails = [];
  if (record.status !== 'passed') return fails;

  if (!isIsoDate(record.measuredOn)) fails.push(`measuredOn ${JSON.stringify(record.measuredOn)} is not an ISO date`);
  for (const k of ['printer', 'browser', 'printDialog']) {
    if (typeof record[k] !== 'string' || record[k].length === 0) fails.push(`${k} must be non-empty`);
  }
  if (!(typeof record.scaleBarErrorPct === 'number' && record.scaleBarErrorPct <= 0.5)) {
    fails.push(`scaleBarErrorPct ${record.scaleBarErrorPct} exceeds 0.5%`);
  }
  if (!(typeof record.sheetDimensionErrorMm === 'number' && record.sheetDimensionErrorMm <= 1)) {
    fails.push(`sheetDimensionErrorMm ${record.sheetDimensionErrorMm} exceeds 1mm`);
  }
  const seams = Array.isArray(record.seamOffsetsMm) ? record.seamOffsetsMm : [];
  if (seams.length < 4) fails.push(`seamOffsetsMm has ${seams.length} entries, need >= 4`);
  seams.forEach((mm, i) => {
    if (!(typeof mm === 'number' && mm <= 1)) fails.push(`seam ${i} offset ${mm}mm exceeds 1mm`);
  });
  if (record.missingTilesAtSeams !== 0) fails.push(`missingTilesAtSeams ${record.missingTilesAtSeams} !== 0`);
  for (const k of ['grayscaleClassesDistinct', 'legendExact', 'indexCorrect']) {
    if (record[k] !== true) fails.push(`${k} is not true`);
  }
  for (const k of ['pdfBytes', 'buildSeconds', 'pages']) {
    if (!(typeof record[k] === 'number' && record[k] > 0)) fails.push(`${k} is not a positive number`);
  }
  if (!Array.isArray(record.photos) || record.photos.length === 0) fails.push('photos is empty');

  // Once the ruler has settled it the caveat is a false statement. It goes on its
  // own, so what is checked is that the conditional is real and reads THIS record.
  const controls = files.controls || '';
  if (!/ne \$proof\.status "passed"/.test(controls)) {
    fails.push('the caveat is not conditional on the record, so a passed proof would still warn');
  }
  return fails;
}

// --- Synthetic-input coverage: both branches, each failure mode named. ---

const GOOD_SEAMS = [0.2, 0.3, 0.4, 0.5];
const PASSED_GOOD = {
  status: 'passed', schemaVersion: 1, area: 'x', measuredOn: '2026-09-05',
  printer: 'HP LaserJet', printDialog: 'Chrome print dialog', browser: 'Chromium 128',
  paper: 'Letter', scale: 24000, dpi: 300, pages: 6, scaleBarErrorPct: 0.2,
  sheetDimensionErrorMm: 0.5, seamOffsetsMm: GOOD_SEAMS, missingTilesAtSeams: 0,
  grayscaleClassesDistinct: true, legendExact: true, indexCorrect: true,
  fitWarningVisible: true, pdfBytes: 1234567, buildSeconds: 12, peakMemoryMb: 400,
  failedSourceRequests: 0, photos: ['seam1.jpg'], notes: '',
};
const GOOD_CONTROLS = `{{- if ne $proof.status "passed" }}<p class="${CAVEAT_MARKER}">not yet verified</p>{{- end }}
<p>Letter</p><option value="24000">1:24,000</option><option value="48000">1:48,000</option>`;
const CAVEATED_FILES = { controls: GOOD_CONTROLS, a: `<script src="${HOST_MARKER}"></script>{{ partial "qcm-controls.html" . }}` };
const BARE_HOST_FILES = { controls: GOOD_CONTROLS, a: `<script src="${HOST_MARKER}"></script>` };

test('schema check: every real key present, status/schemaVersion/array-shape enforced', () => {
  assert.deepEqual(checkSchema(PASSED_GOOD), []);
  assert.deepEqual(checkSchema({ ...PASSED_GOOD, status: 'bogus' }),
    ['status "bogus" is not one of pending, passed, failed']);
  assert.deepEqual(checkSchema({ ...PASSED_GOOD, schemaVersion: 2 }),
    ['schemaVersion 2 !== 1']);
  assert.deepEqual(checkSchema({ ...PASSED_GOOD, seamOffsetsMm: 'nope' }),
    ['seamOffsetsMm is not an array']);
  const { status: _drop, ...withoutStatus } = PASSED_GOOD;
  assert.deepEqual(checkSchema(withoutStatus),
    ['record is missing key status', 'status undefined is not one of pending, passed, failed']);
});

test('passed record with good numbers and a real conditional: ok', () => {
  assert.deepEqual(checkClaimIsCaveated(PASSED_GOOD, CAVEATED_FILES, GOOD_CONTROLS), []);
  assert.deepEqual(checkPassedTolerances(PASSED_GOOD, CAVEATED_FILES), []);
});

test('passed record with a 1.2mm seam: fails naming the seam', () => {
  const record = { ...PASSED_GOOD, seamOffsetsMm: [0.2, 0.3, 1.2, 0.4] };
  const fails = checkPassedTolerances(record, CAVEATED_FILES);
  assert.ok(fails.some((f) => f.includes('seam 2 offset 1.2mm exceeds 1mm')), fails.join('; '));
});

test('passed record whose caveat is unconditional: fails, because it would warn forever', () => {
  const files = { ...CAVEATED_FILES, controls: `<p class="${CAVEAT_MARKER}">always</p>` };
  const fails = checkPassedTolerances(PASSED_GOOD, files);
  assert.ok(fails.some((f) => f.includes('not conditional on the record')), fails.join('; '));
});

// Both pending failures, including the one the old link gate could not see: a page
// that HOSTS the builder rather than linking to one. That file was silent before.
test('pending: a bare host fails, and so does a partial that dropped the caveat', () => {
  const pending = { ...PASSED_GOOD, status: 'pending' };
  assert.ok(checkClaimIsCaveated(pending, BARE_HOST_FILES, GOOD_CONTROLS)
    .some((f) => f.includes('a hosts the builder with no caveat')));
  const bare = '<p>Letter</p>';
  assert.ok(checkClaimIsCaveated(pending, { controls: bare }, bare)
    .some((f) => f.includes('renders no qcm-proof-note')));
});

test('a physical claim made outside the controls fails, naming the stray file', () => {
  const fails = checkClaimsHaveOneHome({ ...CAVEATED_FILES, b: 'prints on Letter paper' });
  assert.ok(fails.some((f) => f.includes('Letter is also claimed by b')), fails.join('; '));
});

// --- The real record and the real surfaces, run through the same functions. ---

const REAL_RECORD = JSON.parse(readFileSync(new URL('../../data/quiet-corners-maps/print-proof.json', import.meta.url), 'utf8'));

test('the real print-proof record matches the schema', () => {
  assert.deepEqual(checkSchema(REAL_RECORD), []);
});

test('the real record is pending today, so every real surface hosting the builder is caveated', () => {
  const files = readSurfaces();
  assert.deepEqual(checkClaimIsCaveated(REAL_RECORD, files, files.controls), []);
  assert.deepEqual(checkPassedTolerances(REAL_RECORD, files), []);
});

test('the real physical claims are made in exactly one file', () => {
  assert.deepEqual(checkClaimsHaveOneHome(readSurfaces()), []);
});

// Without this, a suite passing because NOBODY hosts the builder reads as a pass.
test('some real surface actually hosts the builder', () => {
  const hosts = Object.entries(readSurfaces()).filter(([, t]) => t.includes(HOST_MARKER)).map(([n]) => n);
  assert.deepEqual(hosts, ['dashboard'], 'one map, one host — a second host is a second map');
});

test('quiet-corners-maps.md still links back to /quiet-corners/, where the map is', () => {
  const text = readFileSync(new URL('../../content/quiet-corners-maps.md', import.meta.url), 'utf8');
  assert.match(text, /\(\/quiet-corners\/\)/);
});
