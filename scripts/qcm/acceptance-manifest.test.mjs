// The acceptance manifest's contract: which journeys the Quiet Corners acceptance plan names,
// what covers part of each today, which viewports a run uses, and how a user-reported failure
// moves from "unconfirmed" to "fixed" (README.md, "Acceptance manifest"). The manifest is data;
// validateManifest (acceptance-manifest.mjs) is the rulebook, this file proves each rule can
// fail and that the real manifest passes them all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { validateManifest } from './acceptance-manifest.mjs';

const HERE = new URL('.', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('acceptance-manifest.json', HERE), 'utf8'));
const FILES = new Set(readdirSync(HERE));
const SHA = '0123456789abcdef0123456789abcdef01234567';

/** The real manifest, copied, then broken one way; returns the problems found. */
function broken(edit, files = FILES) {
  const m = structuredClone(manifest);
  edit(m);
  return validateManifest(m, files);
}
const report = (m) => m.reports.find((r) => r.id === 'A03-user-clear');
const journey = (m, id) => m.journeys.find((j) => j.id === id);
function assertFlags(problems, re) {
  assert.ok(problems.some((p) => re.test(p)), `expected a problem matching ${re}, got: ${problems.join(' | ') || '(none)'}`);
}

test('the real manifest passes every rule', () => {
  assert.deepEqual(validateManifest(manifest, FILES), []);
});

test('the three sections and a numeric version are required', () => {
  assertFlags(broken((m) => { m.version = '1'; }), /version/);
  assertFlags(broken((m) => { delete m.journeys; }), /journeys/);
  assertFlags(broken((m) => { delete m.viewports; }), /viewports/);
  assertFlags(broken((m) => { delete m.reports; }), /reports/);
  assert.ok(validateManifest(null, FILES).length > 0);
});

test('journey ids are unique and exactly J01..J11', () => {
  assertFlags(broken((m) => { m.journeys[1].id = 'J01'; }), /duplicate journey id/);
  assertFlags(broken((m) => { m.journeys.pop(); }), /J11/);
  assertFlags(broken((m) => { journey(m, 'J11').id = 'J12'; }), /J12|J11/);
});

test('every journey has a title, an allowed status and a coveredBy array', () => {
  assertFlags(broken((m) => { journey(m, 'J01').title = ''; }), /J01.*title/);
  assertFlags(broken((m) => { journey(m, 'J01').status = 'done'; }), /J01.*status/);
  assertFlags(broken((m) => { delete journey(m, 'J01').coveredBy; }), /J01.*coveredBy/);
});

test('a coveredBy entry must exist, be a bare *.test.mjs name, and appear once', () => {
  assertFlags(broken((m) => { journey(m, 'J01').coveredBy = ['no-such.test.mjs']; }), /no-such\.test\.mjs.*does not exist/);
  assertFlags(broken((m) => { journey(m, 'J01').coveredBy = ['helpers/waits.mjs']; }), /bare file name/);
  assertFlags(broken((m) => { journey(m, 'J01').coveredBy = ['build-identity.mjs']; }), /\.test\.mjs/);
  assertFlags(broken((m) => { journey(m, 'J01').coveredBy = ['print-area-clear.test.mjs', 'print-area-clear.test.mjs']; }), /twice/);
});

test('every journey carries a non-empty invalidatedBy list of repo-relative entries', () => {
  assertFlags(broken((m) => { delete journey(m, 'J01').invalidatedBy; }), /J01.*invalidatedBy/);
  assertFlags(broken((m) => { journey(m, 'J05').invalidatedBy = []; }), /J05.*invalidatedBy/);
  assertFlags(broken((m) => { journey(m, 'J05').invalidatedBy = ['/abs/path']; }), /J05.*repo-relative/);
  assertFlags(broken((m) => { journey(m, 'J05').invalidatedBy = ['a/', 'a/']; }), /J05.*twice/);
});

test('covered and partial need a covering file; planned may have none', () => {
  assertFlags(broken((m) => { Object.assign(journey(m, 'J01'), { status: 'covered', coveredBy: [] }); }), /J01.*covered by nothing/);
  assertFlags(broken((m) => { Object.assign(journey(m, 'J01'), { status: 'partial', coveredBy: [] }); }), /J01.*partial/);
  assert.deepEqual(broken((m) => { Object.assign(journey(m, 'J01'), { status: 'planned', coveredBy: [] }); }), []);
});

test('viewports are WxH, unique, and include the core set', () => {
  assertFlags(broken((m) => { m.viewports.push('390by844'); }), /bad viewport/);
  assertFlags(broken((m) => { m.viewports.push('0x844'); }), /bad viewport/);
  assertFlags(broken((m) => { m.viewports.push('390x844'); }), /duplicate viewport/);
  for (const core of ['320x568', '390x844', '768x1024', '1024x768', '1440x1000', '844x390']) {
    assertFlags(broken((m) => { m.viewports = m.viewports.filter((v) => v !== core); }), new RegExp(`missing.*${core}`));
  }
});

test('report ids are unique, statuses allowed, auditedSha 40 lowercase hex', () => {
  assertFlags(broken((m) => { m.reports.push(structuredClone(m.reports[0])); }), /duplicate report id/);
  assertFlags(broken((m) => { report(m).status = 'closed'; }), /A03-user-clear.*status/);
  assertFlags(broken((m) => { report(m).auditedSha = '483f6ee'; }), /auditedSha/);
  assertFlags(broken((m) => { report(m).auditedSha = SHA.toUpperCase(); }), /auditedSha/);
});

test('an unconfirmed or reproduced report is not closed', () => {
  assertFlags(broken((m) => { report(m).closedAt = '2026-10-03'; }), /unconfirmed.*closedAt/);
  assertFlags(broken((m) => { Object.assign(report(m), { status: 'reproduced', buildSha: SHA, unknown: [], closedAt: '2026-10-03' }); }), /reproduced.*closedAt/);
});

test('a reproduced or fixed report needs a 40-hex buildSha', () => {
  for (const status of ['reproduced', 'fixed']) {
    assertFlags(broken((m) => { Object.assign(report(m), { status, unknown: [] }); }), /buildSha/);
    assertFlags(broken((m) => { Object.assign(report(m), { status, unknown: [], buildSha: 'abc123' }); }), /buildSha/);
    assert.deepEqual(broken((m) => { Object.assign(report(m), { status, unknown: [], buildSha: SHA }); }), []);
  }
});

test('a reproduced or fixed report has nothing left unknown', () => {
  for (const status of ['reproduced', 'fixed']) {
    assertFlags(broken((m) => { Object.assign(report(m), { status, buildSha: SHA }); }), /still has unknowns/);
  }
});

test('a report keeps known and unknown as arrays', () => {
  assertFlags(broken((m) => { report(m).known = 'it works'; }), /known/);
  assertFlags(broken((m) => { delete report(m).unknown; }), /unknown/);
});

test('A03-user-clear is on file, unconfirmed, with what is known and what is not', () => {
  const r = report(manifest);
  assert.ok(r, 'A03-user-clear report missing');
  assert.equal(r.status, 'unconfirmed');
  assert.equal(r.auditedSha, '483f6eefe4c09282a1c41600e8bb9c4bbdc1bdad');
  assert.ok(Array.isArray(r.known) && r.known.length > 0);
  assert.deepEqual([...r.unknown].sort(), [
    'boxOrQuads', 'browser', 'deployedShaAtReport', 'device', 'savedOrUrlRestored',
    'sheetState', 'terrainMode', 'url', 'viewport',
  ]);
});

test('J09 names only files that exercise print preview or build', () => {
  // print-proof.test.mjs checks the physical proof record's schema, not the journey.
  assert.ok(!journey(manifest, 'J09').coveredBy.includes('print-proof.test.mjs'));
});
