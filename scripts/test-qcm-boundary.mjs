#!/usr/bin/env node
// Guard for the Field Maps / site dependency boundary (scripts/ci/qcm-boundary.mjs). Named in
// pr-ci.yml's run step like test-verify-claims.js, so it runs in EVERY qcm tier: a PR that
// adds a qcm test which reads the site, or changes what a helper reads, cannot ship with a
// manifest that still calls the file ENGINE.
//
// The `site` PR CI scope runs only scripts/qcm/site-coupling.json. That is safe only while
// every file NOT in it reads nothing a site-chrome change can move, so this test re-derives
// the list and fails both ways.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  REPO, MANIFEST, SITE_READS, qcmTestFiles, importClosure, siteReadsIn, siteReads, detectSiteCoupled, siteCoupledFiles, manifestText,
} from './ci/qcm-boundary.mjs';

const listed = siteCoupledFiles();
const all = qcmTestFiles();
const engine = all.filter((f) => !listed.includes(f));
const SITE_CHROME_FILES = [
  'themes/headlessmode/layouts/index.html', 'themes/headlessmode/layouts/partials/head.html',
  'site-config/_default/params.toml', 'data/systems.json', 'static/llms.txt',
];

test('manifest: sorted, unique, every entry is a qcm test file on disk', () => {
  assert.deepEqual(listed, [...new Set(listed)].sort(), `${MANIFEST} must be sorted and unique`);
  for (const f of listed) {
    assert.ok(all.includes(f), `${MANIFEST} lists ${f}, which is not a scripts/qcm/*.test.mjs file`);
    assert.ok(existsSync(path.join(REPO, f)), f);
  }
  assert.ok(listed.length > 0, 'an empty site set would make the site tier run nothing');
  assert.ok(engine.length > 0 && listed.length < all.length, 'the split must have both sides');
});

test('manifest is exactly what the scan finds (regenerate with: node scripts/ci/qcm-boundary.mjs write)', () => {
  const found = detectSiteCoupled();
  const missing = found.filter((f) => !listed.includes(f));
  const extra = listed.filter((f) => !found.includes(f));
  assert.deepEqual(missing, [], `these read the site and are not listed: run \`node scripts/ci/qcm-boundary.mjs write\``);
  assert.deepEqual(extra, [], `these are listed but read no site path: run \`node scripts/ci/qcm-boundary.mjs write\``);
  assert.equal(readFileSync(path.join(REPO, MANIFEST), 'utf8'), manifestText(found), 'manifest text is not the generated form');
});

test('an ENGINE file reads no site path, directly or through a helper it imports', () => {
  for (const f of engine) assert.deepEqual(siteReads(f), [], `${f} reads the site but is not in ${MANIFEST}`);
});

test('no qcm file reads data/systems.json or static/llms.txt directly (they are checked by scripts/test-site-surface.mjs)', () => {
  for (const f of all) {
    const text = readFileSync(path.join(REPO, f), 'utf8');
    assert.doesNotMatch(text, /llms\.txt|systems\.json/, `${f} names a site surface file; move the claim check to scripts/test-site-surface.mjs`);
  }
});

test('the scan: every site root is a read, the app\'s own files are not', () => {
  for (const text of [
    "readFileSync('public/index.html')", "import { siteIsBuilt } from './helpers/site-server.mjs'", "'../../themes/headlessmode/layouts/index.html'",
    "new URL('../../themes/headlessmode/layouts/partials/head.html', import.meta.url)", "'../../content/about.md'", "'../../data/systems.json'",
    "join(root, 'data', 'systems.json')", "'../../site-config/_default/params.toml'", "'../../static/llms.txt'", "'static/img/x.png'", "'tailwind.css'",
  ]) assert.ok(siteReadsIn(text).length > 0, text);
  for (const text of [
    "'../../themes/headlessmode/layouts/_default/quiet-corners-maps.html'", "'../../themes/headlessmode/layouts/partials/qcm-controls.html'",
    "'../../themes/headlessmode/layouts/shortcodes/qcm-coverage.html'", "'../../content/quiet-corners-maps.md'", "'../../data/quiet-corners-maps/coverage.json'",
    "'../../themes/headlessmode/static/js/quiet-corners.js'", "stream.on('data', (c) => c)", "import { appLayoutFiles } from './helpers/layouts.mjs'",
  ]) assert.deepEqual(siteReadsIn(text), [], text);
});

test('the scan follows relative imports: a helper that reads the site couples its importers', () => {
  const closure = importClosure('scripts/qcm/browser.test.mjs');
  assert.ok(closure.length > 1 && closure.includes('scripts/qcm/browser.test.mjs'), closure.join(', '));
  assert.ok(importClosure('scripts/qcm/map-index.test.mjs').every((f) => f.startsWith('scripts/') || f.startsWith('themes/')));
  // helpers/site-server.mjs is what makes every built-page browser test site-coupled
  assert.ok(siteReads('scripts/qcm/helpers/site-server.mjs').length > 0);
  for (const f of all.filter((n) => importClosure(n).includes('scripts/qcm/helpers/site-server.mjs'))) {
    assert.ok(listed.includes(f), `${f} imports helpers/site-server.mjs`);
  }
});

test('grep proof: every file naming a site-chrome path is site-coupled', () => {
  const needles = { 'index.html': /layouts\/index\.html|public\/index\.html/, 'head.html': /partials\/head\.html/, 'params.toml': /params\.toml/, 'systems.json': /systems\.json/, 'llms.txt': /llms\.txt/ };
  for (const [name, re] of Object.entries(needles)) {
    for (const f of all) {
      if (re.test(readFileSync(path.join(REPO, f), 'utf8'))) assert.ok(listed.includes(f), `${f} names ${name} but is not site-coupled`);
    }
  }
  assert.equal(SITE_CHROME_FILES.length, 5);
  assert.ok(SITE_READS.length >= 7);
});

test('the layouts the app tests read are the app\'s, so they stay ENGINE', () => {
  for (const f of ['legend', 'legend-view', 'layer-registry', 'tonight-strip'].map((n) => `scripts/qcm/${n}.test.mjs`)) {
    assert.ok(!listed.includes(f), `${f} reads only quiet-corners layouts (helpers/layouts.mjs) and must stay ENGINE`);
  }
});
