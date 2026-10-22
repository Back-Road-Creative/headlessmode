// The rules acceptance-manifest.json must obey. Pure: the manifest and the set of file names
// in scripts/qcm come in as arguments, a list of problems comes out (empty means valid).
// acceptance-manifest.test.mjs runs it over the real manifest and over broken copies.

const JOURNEY_STATUSES = new Set(['planned', 'partial', 'covered']);
const REPORT_STATUSES = new Set(['unconfirmed', 'reproduced', 'fixed']);
const SHA40 = /^[0-9a-f]{40}$/;
const VIEWPORT = /^[1-9]\d*x[1-9]\d*$/;
export const JOURNEY_IDS = Array.from({ length: 11 }, (_, i) => `J${String(i + 1).padStart(2, '0')}`);
export const CORE_VIEWPORTS = ['320x568', '390x844', '768x1024', '1024x768', '1440x1000', '844x390'];

const dupes = (list) => list.filter((x, i) => list.indexOf(x) !== i);

export function validateManifest(m, files) {
  const problems = [];
  const bad = (msg) => problems.push(msg);
  if (!m || typeof m !== 'object') return ['the manifest is not an object'];

  if (typeof m.version !== 'number') bad('version must be a number');
  for (const k of ['journeys', 'viewports', 'reports']) {
    if (!Array.isArray(m[k])) bad(`${k} must be an array`);
  }

  if (Array.isArray(m.journeys)) {
    const ids = m.journeys.map((j) => j.id);
    for (const d of new Set(dupes(ids))) bad(`duplicate journey id ${d}`);
    for (const id of JOURNEY_IDS) if (!ids.includes(id)) bad(`journey ${id} is missing`);
    for (const id of ids) if (!JOURNEY_IDS.includes(id)) bad(`unexpected journey id ${id}`);
    for (const j of m.journeys) {
      if (typeof j.title !== 'string' || j.title === '') bad(`${j.id} needs a title`);
      if (!JOURNEY_STATUSES.has(j.status)) bad(`${j.id} status "${j.status}" is not one of ${[...JOURNEY_STATUSES]}`);
      if (!Array.isArray(j.coveredBy)) { bad(`${j.id} coveredBy must be an array`); continue; }
      for (const f of j.coveredBy) {
        if (f.includes('/')) bad(`${j.id}: ${f} must be a bare file name (the CI glob is flat)`);
        else if (!f.endsWith('.test.mjs')) bad(`${j.id}: ${f} must end .test.mjs`);
        else if (!files.has(f)) bad(`${j.id}: ${f} does not exist in scripts/qcm`);
      }
      for (const d of new Set(dupes(j.coveredBy))) bad(`${j.id} lists ${d} twice`);
      // QQA-12: evidence-bundle.mjs calls a journey's evidence stale only when a changed file
      // matches this list, so an empty or missing list would make stale evidence look fresh.
      if (!Array.isArray(j.invalidatedBy) || j.invalidatedBy.length === 0) {
        bad(`${j.id} needs a non-empty invalidatedBy list`);
      } else {
        for (const g of j.invalidatedBy) {
          if (typeof g !== 'string' || g.trim() === '' || g.startsWith('/') || g.includes('..')) {
            bad(`${j.id}: invalidatedBy entry ${JSON.stringify(g)} must be a repo-relative path, prefix or glob`);
          }
        }
        for (const d of new Set(dupes(j.invalidatedBy))) bad(`${j.id} lists invalidatedBy ${d} twice`);
      }
      if (j.status === 'covered' && j.coveredBy.length === 0) bad(`${j.id} is covered by nothing`);
      if (j.status === 'partial' && j.coveredBy.length === 0) bad(`${j.id} is partial but names no file`);
    }
  }

  if (Array.isArray(m.viewports)) {
    for (const v of m.viewports) if (!VIEWPORT.test(String(v))) bad(`bad viewport ${v}`);
    for (const d of new Set(dupes(m.viewports))) bad(`duplicate viewport ${d}`);
    for (const core of CORE_VIEWPORTS) if (!m.viewports.includes(core)) bad(`missing core viewport ${core}`);
  }

  if (Array.isArray(m.reports)) {
    for (const d of new Set(dupes(m.reports.map((r) => r.id)))) bad(`duplicate report id ${d}`);
    for (const r of m.reports) {
      if (!REPORT_STATUSES.has(r.status)) bad(`${r.id}: bad status ${r.status}`);
      if (!SHA40.test(String(r.auditedSha ?? ''))) bad(`${r.id}: auditedSha must be 40 lowercase hex`);
      if (!Array.isArray(r.known)) bad(`${r.id}: known must be an array`);
      if (!Array.isArray(r.unknown)) bad(`${r.id}: unknown must be an array`);
      if ((r.status === 'unconfirmed' || r.status === 'reproduced') && r.closedAt) {
        bad(`${r.id} is ${r.status} but has closedAt`);
      }
      if (r.status === 'reproduced' || r.status === 'fixed') {
        if (!SHA40.test(String(r.buildSha ?? ''))) bad(`${r.id}: ${r.status} needs a 40-hex buildSha`);
        if (Array.isArray(r.unknown) && r.unknown.length > 0) bad(`${r.id} still has unknowns: ${r.unknown.join(', ')}`);
      }
    }
  }
  return problems;
}
