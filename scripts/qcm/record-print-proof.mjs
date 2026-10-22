// Writes the physical print-proof record (plan §11/U13). `--worksheet` prints what to
// measure; every other flag supplies a measurement; `--failed` records an honest failure.
//
// The gate is on the paper CLAIM, not on a link: while the record is not "passed",
// every surface hosting the builder must carry the caveat qcm-controls.html renders
// from this file. That is automatic — flipping the record is the whole change.
//
// This does not re-implement the tolerances. It writes the record, runs the REAL gate
// (scripts/qcm/print-proof.test.mjs), and restores the previous file if the gate refuses
// — so the tool cannot hold an opinion about "passed" that differs from the gate's, and
// there is nothing to keep in sync. The record on disk is only ever a state the gate
// accepts. It does not edit the product surfaces: where that sentence goes in each one
// is a copy decision, so it reports them and lets the gate name them.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RECORD = new URL('../../data/quiet-corners-maps/print-proof.json', import.meta.url);
const REPO = new URL('../../', import.meta.url);

// [record key, flag, kind]. `n` number, `s` non-empty string, `l` comma list, `b` flag.
const FIELDS = [
  ['measuredOn', 'measured-on', 's'], ['printer', 'printer', 's'],
  ['printDialog', 'print-dialog', 's'], ['browser', 'browser', 's'],
  ['dpi', 'dpi', 'n'], ['pages', 'pages', 'n'],
  ['scaleBarErrorPct', 'scale-bar-error-pct', 'n'],
  ['sheetDimensionErrorMm', 'sheet-dimension-error-mm', 'n'],
  ['seamOffsetsMm', 'seams', 'l'], ['missingTilesAtSeams', 'missing-tiles-at-seams', 'n'],
  ['grayscaleClassesDistinct', 'grayscale-distinct', 'b'], ['legendExact', 'legend-exact', 'b'],
  ['indexCorrect', 'index-correct', 'b'], ['fitWarningVisible', 'fit-warning-visible', 'b'],
  ['pdfBytes', 'pdf-bytes', 'n'], ['buildSeconds', 'build-seconds', 'n'],
  ['peakMemoryMb', 'peak-memory-mb', 'n'], ['failedSourceRequests', 'failed-source-requests', 'n'],
  ['photos', 'photos', 'l'],
];

const WORKSHEET = `Print proof worksheet — Standing Indian / Wayah Bald
Build at 1:24,000, Letter portrait, 300 dpi. Print with Actual size (100%), Fit/Shrink OFF.
Record every number even when it fails; the tolerances are section 11's.

  --scale-bar-error-pct       ruler against the printed scale bar   <= 0.5
  --sheet-dimension-error-mm  printed frame width and height        <= 1
  --seams a,b,c,d             overlap offset between neighbours     each <= 1, need >= 4
  --missing-tiles-at-seams    blank patches along the seams         must be 0
  --grayscale-distinct        topo classes distinguishable?         flag = yes
  --legend-exact              lists exactly what is drawn?          flag = yes
  --index-correct             sheet IDs and neighbours right?       flag = yes
  --fit-warning-visible       a scaled sheet warns?                 flag = yes

A passing record stops the "not yet verified on paper" caveat rendering, because the
controls partial reads this file; nothing else has to change.

Also: ${FIELDS.filter(([, , k]) => k !== 'b').map(([, f]) => `--${f}`).join(' ')}`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[argv[i].slice(2)] = true;
    else { out[argv[i].slice(2)] = next; i++; }
  }
  return out;
}

function value(kind, raw, flag) {
  if (kind === 'b') return Boolean(raw);
  if (raw === undefined || raw === true) throw new Error(`missing --${flag}`);
  if (kind === 's') {
    const s = String(raw).trim();
    if (!s) throw new Error(`missing --${flag}`);
    return s;
  }
  if (kind === 'l') {
    const parts = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    return flag === 'seams' ? parts.map(Number) : parts;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${flag} must be a number, got ${raw}`);
  return n;
}

function buildRecord(args, previous) {
  const record = { ...previous, status: args.failed ? 'failed' : 'passed', schemaVersion: 1, paper: 'Letter', scale: 24000 };
  for (const [key, flag, kind] of FIELDS) record[key] = value(kind, args[flag], flag);
  if (typeof args.notes === 'string') record.notes = args.notes;
  return record;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.worksheet) { console.log(WORKSHEET); return 0; }

  const before = readFileSync(RECORD, 'utf8');
  let record;
  try { record = buildRecord(args, JSON.parse(before)); } catch (err) {
    console.error(`record-print-proof: ${err.message}\nrun --worksheet for what to measure`);
    return 2;
  }

  writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);
  try {
    execFileSync('node', ['--test', 'scripts/qcm/print-proof.test.mjs'], { cwd: fileURLToPath(REPO), stdio: 'pipe' });
  } catch (err) {
    writeFileSync(RECORD, before);
    console.error('FAIL: the gate refuses this record, so nothing was written. It said:\n');
    // node --test reports the failure inside a TAP YAML block; the useful lines are the
    // failing subtest name and the `+ 'reason'` entries of the deep-equal diff.
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    for (const line of out.split('\n')) {
      const t = line.trim();
      if (t.startsWith('not ok')) console.error(`  ${t.replace(/^not ok \d+ - /, '')}`);
      const reason = t.match(/^\+\s+'(.+)',?$/);
      if (reason) console.error(`    - ${reason[1]}`);
    }
    console.error('\nRe-measure, record the failure honestly with --failed, or add the missing');
    console.error('surface links — a half-done flip is a red PR.');
    return 1;
  }
  console.log(`wrote ${fileURLToPath(RECORD)} with status ${record.status}; the gate passes.`);
  return 0;
}

process.exit(main());
