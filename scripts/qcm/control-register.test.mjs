// QQA-00: the control register, and the gate that keeps it honest.
//
// scripts/qcm/control-register.json lists every control a reader can operate on the
// Quiet Corners map page (/quiet-corners/) and on the Field Maps documentation page
// (/quiet-corners/maps/): what it is for, what it touches, what it should visibly do,
// how a keyboard reaches it, whether the choice survives a reload or a shared link, and
// which test files exercise it. This file fails when
//   - a control the built page renders is in no register entry          (unregistered),
//   - a register entry's selector matches nothing on the built page     (stale),
//   - a layer, base or context row exists in layer-registry.js /
//     source-basemaps.js with no row in the register, or the reverse,
//   - an entry names a test file that is missing or never mentions the control, or
//   - an entry leaves out a field (a fact the code does not settle is written
//     "unverified", never left blank and never guessed).
// The rendered-DOM half needs Chromium and a built site (it skips, with the reason, like
// every browser proof here); the register's own shape is checked with neither.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard } from './helpers/waits.mjs';
import { inventoryInPage, compareToRegister, gateMessage } from './helpers/control-inventory.mjs';
import { LAYERS } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';
import { BASES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-basemaps.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const register = JSON.parse(readFileSync(path.join(ROOT, 'scripts/qcm/control-register.json'), 'utf8'));

/** The control families of the quality plan (section 4.1), verbatim. */
const FAMILIES = [
  'Search / results / clear',
  'Zoom / home / locate / 3D',
  'Dock / disclosures / tooltips',
  'County filters / metric / sort / paging',
  'Basemap / context / overlays / presets',
  'Map label size / crowding / contrast / emphasis',
  'Select / inspect / nearby / Conditions',
  'Save / share / import / export',
  'Draw / quad toggle / clear / undo / edit',
  'Print scale / paper / DPI / extras / build / download',
  'Camera / freshness / link-out / retry',
];
const PERSISTENCE = ['saved', 'shared link', 'saved + shared link', 'saved print recipe', 'none', 'unverified'];
const TEXT_FIELDS = ['id', 'purpose', 'scope', 'effect', 'keyboard'];

// --- The rows the layer registry generates -------------------------------------------
// Ids come from layer-registry.js and source-basemaps.js, never from a copy here: a new
// registry row with no register row fails, and so does a register row for a deleted one.
// Which input a row renders as follows main.js: base radios from BASES, context radios
// for the context group (plus "none"), a checkbox for every other group. The usgsTopo
// row is the required base layer: the base radios draw it, so it has no checkbox.
export const derivedIds = {
  layerCheckboxes: LAYERS.filter((l) => l.group !== 'context' && l.group !== 'base').map((l) => l.id),
  contextRadios: [...LAYERS.filter((l) => l.group === 'context').map((l) => l.id), 'none'],
  baseRadios: BASES.map((b) => b.id),
};
const DERIVED_SELECTOR = {
  layerCheckboxes: (id) => `input#qcm-layer-${id}`,
  contextRadios: (id) => `input#qcm-context-${id}`,
  baseRadios: (id) => `input#qcm-base-${id}`,
};
const DERIVED_NEEDLE = { layerCheckboxes: 'qcm-layer-', contextRadios: 'qcm-context-', baseRadios: 'qcm-base-' };

/** Every register entry as { selector, pages, transient }, derived rows expanded. */
export function expandEntries(reg) {
  const out = reg.controls.map((c) => ({ ...c }));
  for (const [kind, family] of Object.entries(reg.derived)) {
    for (const id of Object.keys(family.rows ?? {})) {
      out.push({ ...family, rows: undefined, ...family.rows[id], id: `${kind}:${id}`, selector: DERIVED_SELECTOR[kind](id), pages: ['dashboard'] });
    }
  }
  return out;
}

const needleOf = (c) => c.needle ?? (/^[#.][\w-]+$/.test(c.selector) ? c.selector.slice(1) : null);
const readTest = (file) => (existsSync(path.join(ROOT, file)) ? readFileSync(path.join(ROOT, file), 'utf8') : null);

// --- The register's own shape (no browser) -------------------------------------------
test('every control entry is complete, in a known family, and unique', () => {
  const seenIds = new Set(), seenSelectors = new Set(), problems = [];
  for (const c of register.controls) {
    const who = c.id ?? c.selector ?? JSON.stringify(c).slice(0, 60);
    for (const f of TEXT_FIELDS) if (typeof c[f] !== 'string' || !c[f].trim()) problems.push(`${who}: "${f}" is missing or blank`);
    if (typeof c.selector !== 'string' || !c.selector.trim()) problems.push(`${who}: "selector" is missing or blank`);
    if (!FAMILIES.includes(c.family)) problems.push(`${who}: family "${c.family}" is not one of the plan's eleven`);
    if (!PERSISTENCE.includes(c.persistence)) problems.push(`${who}: persistence "${c.persistence}" is not one of ${PERSISTENCE.join(' / ')}`);
    if (!Array.isArray(c.pages) || !c.pages.length || c.pages.some((p) => !register.pages[p])) problems.push(`${who}: pages must name entries of "pages"`);
    if (seenIds.has(c.id)) problems.push(`${who}: id repeated`);
    if (seenSelectors.has(c.selector)) problems.push(`${who}: selector repeated`);
    seenIds.add(c.id); seenSelectors.add(c.selector);
  }
  assert.deepEqual(problems, []);
});

test('every derived family has the shared fields a row inherits', () => {
  const problems = [];
  for (const kind of Object.keys(derivedIds)) {
    const f = register.derived[kind];
    if (!f) { problems.push(`derived.${kind} is missing`); continue; }
    for (const k of ['purpose', 'keyboard']) if (typeof f[k] !== 'string' || !f[k].trim()) problems.push(`derived.${kind}.${k} is missing`);
    if (!FAMILIES.includes(f.family)) problems.push(`derived.${kind}.family is not one of the plan's eleven`);
    if (!PERSISTENCE.includes(f.persistence)) problems.push(`derived.${kind}.persistence is not allowed`);
    for (const [id, row] of Object.entries(f.rows ?? {})) {
      for (const k of ['scope', 'effect']) if (typeof row[k] !== 'string' || !row[k].trim()) problems.push(`derived.${kind}.rows.${id}.${k} is missing`);
      if (row.family !== undefined && !FAMILIES.includes(row.family)) problems.push(`derived.${kind}.rows.${id}.family is not one of the plan's eleven`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the register has a row for every layer, base and context choice, and no row for one that is gone', () => {
  const problems = [];
  for (const [kind, ids] of Object.entries(derivedIds)) {
    const have = Object.keys(register.derived[kind]?.rows ?? {});
    for (const id of ids) if (!have.includes(id)) problems.push(`${kind}: "${id}" is in the registry but has no register row`);
    for (const id of have) if (!ids.includes(id)) problems.push(`${kind}: register row "${id}" has no registry entry any more`);
  }
  assert.deepEqual(problems, []);
});

test('every named test file exists and mentions the control it is named for', () => {
  const problems = [];
  const check = (who, tests, needle, untested) => {
    if (!Array.isArray(tests)) { problems.push(`${who}: "tests" must be a list`); return; }
    if (!tests.length) {
      if (typeof untested !== 'string' || !untested.trim()) problems.push(`${who}: no test file and no "untested" reason`);
      return;
    }
    if (!needle) { problems.push(`${who}: a selector that is not a plain #id or .class needs a "needle" to look for in its tests`); return; }
    for (const file of tests) {
      const text = readTest(file);
      if (text === null) problems.push(`${who}: test file ${file} does not exist`);
      else if (!text.includes(needle)) problems.push(`${who}: ${file} never mentions "${needle}"`);
    }
  };
  for (const c of register.controls) check(c.id ?? c.selector, c.tests, needleOf(c), c.untested);
  for (const [kind, f] of Object.entries(register.derived)) check(`derived.${kind}`, f.tests, DERIVED_NEEDLE[kind], f.untested);
  assert.deepEqual(problems, []);
});

// --- The pure comparison, on made-up pages --------------------------------------------
test('compareToRegister names an unclaimed control and an entry that matches nothing', () => {
  const page = {
    controls: [{ sel: 'button#a "A"', claimedBy: [0] }, { sel: 'button#b "B"', claimedBy: [] }],
    matched: [1, 0, 0],
  };
  const r = compareToRegister(page, [{ selector: '#a' }, { selector: '#gone' }, { selector: '#card', transient: true }]);
  assert.deepEqual(r.unregistered, ['button#b "B"']);
  assert.deepEqual(r.stale, ['#gone']);
  const msg = gateMessage('dashboard @1280x800', r);
  assert.match(msg, /unregistered control\(s\)[\s\S]*button#b "B"/);
  assert.match(msg, /stale register entr\(ies\)[\s\S]*#gone/);
});

// --- The rendered DOM (browser) -------------------------------------------------------
const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') || !siteIsBuilt('quiet-corners/maps')
    ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;
const VIEWPORTS = [{ width: 1280, height: 800 }, { width: 390, height: 844, mobile: true }];

let shared = null;
async function browser() {
  if (!shared) {
    const site = await startSiteServer();
    const page = await launch(CHROMIUM, `${site.origin}/quiet-corners/`, { viewport: VIEWPORTS[0], args: ['--hide-scrollbars'] });
    shared = { site, page };
  }
  return shared;
}
after(async () => {
  if (!shared) return;
  shared.page.close();
  await shared.site.close();
});

/** Opens `pageKey` at `vp`, waits until it is ready, and returns the comparison against the register
 *  (or against `entriesOverride`). `before` may change the page first (the gate's own bite test). */
async function inspect(pageKey, vp, { before = null, entriesOverride = null } = {}) {
  const { site, page } = await browser();
  const spec = register.pages[pageKey];
  await page.setViewport(vp);
  await page.navigate(site.origin + spec.path);
  if (pageKey === 'dashboard') await readyDashboard(page);
  if (before) await page.evaluate(before);
  const entries = (entriesOverride ?? expandEntries(register)).filter((e) => e.pages.includes(pageKey));
  const found = await page.evaluate(inventoryInPage(entries.map((e) => e.selector), spec));
  assert.ok(found.scopeFound, `${pageKey}: nothing at "${spec.scope}" -- the page did not render its chrome`);
  return compareToRegister(found, entries);
}

for (const pageKey of Object.keys(register.pages)) {
  for (const vp of VIEWPORTS) {
    test(`${pageKey} at ${vp.width}x${vp.height}: every rendered control is registered, no entry is stale`, { skip }, async () => {
      const result = await inspect(pageKey, vp);
      assert.equal(result.unregistered.length + result.stale.length, 0, gateMessage(`${pageKey} @${vp.width}x${vp.height}`, result));
    });
  }
}

test('the gate bites: a button added to the page is named as unregistered', { skip }, async () => {
  const result = await inspect('dashboard', VIEWPORTS[0], {
    before: `(() => { const b = document.createElement('button'); b.type = 'button'; b.id = 'qcm-fake-extra-control';
      b.textContent = 'Fake extra'; document.querySelector('#qc-map-container').append(b); })()`,
  });
  const msg = gateMessage('dashboard @1280x800', result);
  assert.ok(result.unregistered.some((s) => s.includes('qcm-fake-extra-control')), `the injected button was not reported; got:\n${msg}`);
  assert.match(msg, /unregistered control\(s\)[\s\S]*button#qcm-fake-extra-control/);
});

test('the gate bites: a register entry whose control is gone is named as stale', { skip }, async () => {
  const entries = [...expandEntries(register), { id: 'fake', selector: '#qcm-removed-control', pages: ['dashboard'] }];
  const result = await inspect('dashboard', VIEWPORTS[0], { entriesOverride: entries });
  assert.ok(result.stale.includes('#qcm-removed-control'), `the dead entry was not reported; stale list was ${JSON.stringify(result.stale)}`);
});
