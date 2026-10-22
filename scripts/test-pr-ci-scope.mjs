// Contract test for the PR CI scope split. Run: node --test scripts/test-pr-ci-scope.mjs
// No YAML library is a devDependency, so the workflow is checked by text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classify, qcmScope, scope, SMOKE_URLS, QCM_PATTERN } from './ci/pr-scope.mjs';

const wf = readFileSync(new URL('../.github/workflows/pr-ci.yml', import.meta.url), 'utf8');
const allUrls = JSON.parse(
  readFileSync(new URL('../.lighthouserc.json', import.meta.url), 'utf8'),
).ci.collect.url;

// Body of one top-level job (two-space indent key) up to the next job.
function job(name) {
  const m = wf.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:\\n|(?![\\s\\S]))`, 'm'));
  assert.ok(m, `job ${name} missing`);
  return m[1];
}

test('scope job runs on quick', () => {
  assert.match(job('scope'), /runs-on: \$\{\{ fromJSON\(vars\.HM_RUNNER_QUICK \|\| '\[\"self-hosted\",\"quick\"\]'\) \}\}/);
});

test('pr-ci keeps its required name and needs scope', () => {
  const b = job('pr-ci');
  // A real run keeps the required name; only a skipped title/body-edit run (its own
  // concurrency group, every job skipped) takes another, so it never shadows it.
  assert.match(b, /^    name: \$\{\{ \(github\.event\.action == 'edited' && !github\.event\.changes\.base\) && 'PR CI \(build \+ validate\) \(edit, not re-run\)' \|\| 'PR CI \(build \+ validate\)' \}\}$/m);
  assert.match(b, /^    needs: scope$/m);
  assert.match(b, /runs-on: \$\{\{ contains\(fromJSON\('\["site", "skip"\]'\), needs\.scope\.outputs\.qcm_scope\) && vars\.HM_PR_CI_RUNNER != 'self-hosted' && 'ubuntu-latest' \|\| fromJSON\(vars\.HM_RUNNER \|\| '\[\"self-hosted\",\"heavy\"\]'\) \}\}/);
});

test('result guard fails on cancelled, skipped or failure', () => {
  const b = job('result');
  assert.match(b, /needs: \[scope, pr-ci, site-audit\]/);
  assert.match(b, /needs\.site-audit\.result/);
  assert.match(b, /always\(\)/);
  for (const r of ['cancelled', 'skipped', 'failure']) assert.ok(b.includes(r), r);
});

test('workflow has no trigger-level paths filter', () => {
  const on = wf.match(/^on:\n([\s\S]*?)^\S/m)[1];
  assert.doesNotMatch(on, /paths/);
});

test('classifier: layouts, scripts, unknown are full', () => {
  assert.equal(classify(['layouts/x.html']), 'full');
  assert.equal(classify(['foo/bar']), 'full');
  assert.equal(classify(['scripts/qcm/README.md']), 'full');
  assert.equal(classify(['.github/workflows/pr-ci.yml']), 'full');
  assert.equal(classify(['.lighthouserc.json']), 'full');
  assert.equal(classify(['data/systems.json']), 'full');
  assert.equal(classify(['content/_content.schema.yaml']), 'full');
  assert.equal(classify(['content/blog/x.md', 'layouts/x.html']), 'full');
  assert.equal(classify([]), 'full');
});

test('classifier: content-only is narrow', () => {
  assert.equal(classify(['content/blog/x.md']), 'narrow');
  assert.equal(classify(['content/about.md', 'static/img/a.png', 'README.md']), 'narrow');
});

test('scope outputs: narrow smoke list is real URLs; full is the whole list', () => {
  for (const u of SMOKE_URLS) assert.ok(allUrls.includes(u), u);
  const n = scope(['content/about.md'], allUrls);
  assert.deepEqual(JSON.parse(n.lhci_urls), SMOKE_URLS);
  const f = scope(['layouts/x.html'], allUrls);
  assert.deepEqual(JSON.parse(f.lhci_urls), allUrls);
  assert.equal(n.qcm_pattern, '', 'content-only skips the Field Maps glob');
  assert.equal(n.qcm_scope, 'skip');
  assert.equal(f.qcm_pattern, QCM_PATTERN);
  assert.equal(f.qcm_scope, 'full');
});

// ---- Field Maps (scripts/qcm) suite scope --------------------------------------------
// Dependency-aware: the suite is skipped only when EVERY changed file is outside everything
// the qcm tests read (see the allowlist grounding in scripts/ci/pr-scope.mjs). Positive
// allowlist; unknown, empty and a workflow_dispatch run (empty list) are full.

// PR #868's exact file list: homepage, head partial, site-config, data/systems.json,
// llms.txt, image manifests and root docs. The Field Maps app reads none of them; the
// built-page checks that can observe them are the `site` set (scripts/qcm/site-coupling.json).
const PR_868 = [
  'CLAUDE.md', 'data/systems.json', 'scripts/test_framegrade_page.py', 'scripts/test_homepage_design.py',
  'scripts/test_systems_contract.py', 'site-config/_default/params.toml', 'static/img/framegrade/manifest.json',
  'static/img/rigscore/manifest.json', 'static/llms.txt', 'themes/headlessmode/layouts/index.html',
  'themes/headlessmode/layouts/partials/head.html',
];

test('qcm scope: PR #868 is the site tier, not full', () => {
  assert.equal(qcmScope(PR_868), 'site');
});

test('qcm scope: each site-chrome file alone is the site tier', () => {
  for (const f of [
    'themes/headlessmode/layouts/index.html', 'themes/headlessmode/layouts/partials/head.html',
    'site-config/_default/params.toml', 'data/systems.json', 'static/llms.txt',
  ]) assert.equal(qcmScope([f]), 'site', f);
});

test('qcm scope: site chrome mixed with skip paths is site; with anything else it is full', () => {
  assert.equal(qcmScope(['static/llms.txt', 'README.md', 'content/about.md']), 'site');
  assert.equal(qcmScope(['static/llms.txt', 'static/_headers']), 'full');
  assert.equal(qcmScope(['data/systems.json', 'content/quiet-corners.md']), 'full');
  assert.equal(qcmScope(['themes/headlessmode/layouts/index.html', 'themes/headlessmode/layouts/_default/baseof.html']), 'full');
  assert.equal(qcmScope(['themes/headlessmode/layouts/index.html', 'scripts/qcm/x.test.mjs']), 'full');
  assert.equal(qcmScope(['site-config/_default/params.toml', 'package.json']), 'full');
});

test('qcm scope: site-chrome lookalikes and traversal are full', () => {
  for (const f of [
    'data/systems.json.bak', 'data/quiet-corners-maps/coverage.json', 'data/other.json', 'static/llms.txt.gz',
    'static/llms-full.txt', 'site-config/_default/menus.toml', 'site-config/production/params.toml',
    'themes/headlessmode/layouts/index.html/x', 'themes/headlessmode/layouts/partials/header.html',
    'themes/headlessmode/layouts/partials/qcm-controls.html', 'themes/headlessmode/layouts/_default/index.html',
    'a/data/systems.json', 'data/../scripts/qcm/x.test.mjs', 'static/llms.txt/../_headers',
  ]) assert.equal(qcmScope([f]), 'full', f);
});

test('scope outputs: only a full qcm scope passes the glob', () => {
  const s = scope(['static/llms.txt'], ['http://localhost/index.html']);
  assert.equal(s.qcm_scope, 'site');
  assert.equal(s.qcm_pattern, '', 'site runs the manifest set, named by run-with-evidence, not the glob');
});

test('qcm scope: content, images, root docs and python validator tests skip the Field Maps suite', () => {
  for (const list of [
    ['content/about.md'],
    ['content/rigscore.md', 'content/keycut.md'],
    ['static/img/rigscore/shot.png', 'static/img/waypost/manifest.json', 'static/img/quiet-corners/manifest.json'],
    ['static/og/default.png'],
    ['README.md', 'CLAUDE.md', 'CONTENT_GUIDELINES.md'],
    ['scripts/test_homepage_design.py', 'scripts/test_systems_contract.py'],
    ['content/about.md', 'static/img/band-coach/a.png', 'README.md', 'scripts/test_framegrade_page.py'],
  ]) assert.equal(qcmScope(list), 'skip', list.join(', '));
});

test('qcm scope: everything the Field Maps tests read is full', () => {
  for (const f of [
    'content/quiet-corners.md', 'content/quiet-corners-maps.md', 'content/qcm-states/_content.gotmpl',
    'content/qcm-states/x.md', 'content/_content.schema.yaml', 'content/sub/page.md',
    'data/quiet-corners-maps/coverage.json', 'static/_headers',
    'static/data/quiet-corners-maps/cameras/index.json', 'static/favicon.svg', 'static/functions/api/geocode.js',
    'themes/headlessmode/layouts/_default/baseof.html', 'themes/headlessmode/layouts/partials/header.html', 'themes/headlessmode/static/js/quiet-corners.js',
    'themes/headlessmode/static/css/tailwind.css', 'layouts/alias.html', 'site-config/_default/menus.toml',
    'scripts/qcm/x.test.mjs', 'scripts/qcm/README.md', 'scripts/ci/pr-scope.mjs', 'scripts/build-site.sh',
    'scripts/foo.py', 'scripts/sub/test_x.py', 'scripts/test_x.PY', 'scripts/test_x.py.bak',
    'package.json', 'package-lock.json', '.lighthouserc.json', '.github/workflows/pr-ci.yml', 'src/css/main.css',
  ]) assert.equal(qcmScope([f]), 'full', f);
});

test('qcm scope: one qcm-relevant file in a mixed list makes the whole list full', () => {
  assert.equal(qcmScope(['content/about.md', 'content/quiet-corners.md']), 'full');
  assert.equal(qcmScope(['README.md', 'themes/headlessmode/layouts/partials/footer.html']), 'full');
  assert.equal(qcmScope(['content/about.md', 'foo/bar']), 'full');
});

test('qcm scope: empty list, blank lines and workflow_dispatch are full', () => {
  assert.equal(qcmScope([]), 'full');
  assert.equal(qcmScope(['', '  ']), 'full');
  // workflow_dispatch has no base ref: the scope job writes an empty changed.txt.
  assert.match(wf, /not a PR: empty list classifies as full/);
});

test('qcm scope: path traversal and lookalikes do not slip through the anchors', () => {
  for (const f of ['content/../data/quiet-corners-maps/x.json', 'x/content/about.md', 'content/_draft.md',
    'static/img/../js/x.js', 'static/imgs/a.png', 'a/README.md', 'scripts/test_x.py/y', 'content/about.md/x']) {
    assert.equal(qcmScope([f]), 'full', f);
  }
});

// ---- workflow contract: the evidence wiring follows the scope output -----------------

test('scope job exposes qcm_scope next to qcm_pattern', () => {
  const b = job('scope');
  assert.match(b, /^      qcm_scope: \$\{\{ steps\.scope\.outputs\.qcm_scope \}\}$/m);
  assert.match(b, /^      qcm_pattern: \$\{\{ steps\.scope\.outputs\.qcm_pattern \}\}$/m);
});

function step(name) {
  const m = job('pr-ci').match(new RegExp(`^      - name: ${name}\\n([\\s\\S]*?)(?=^      - name: |(?![\\s\\S]))`, 'm'));
  assert.ok(m, `step ${name} missing`);
  return m[1];
}

test('qcm run step: pattern comes from the scope output; the named node tests always run', () => {
  const b = step('Field Maps engine \\+ script unit tests \\(node --test\\)');
  assert.match(b, /QCM_PATTERN: \$\{\{ needs\.scope\.outputs\.qcm_pattern \}\}/);
  // An empty pattern must expand to NO argument, never to an empty one.
  assert.match(b, /\$\{QCM_PATTERN:\+"\$QCM_PATTERN"\}/);
  // The tier is passed to the runner so `site` can name the manifest's files itself.
  assert.match(b, /QCM_SCOPE: \$\{\{ needs\.scope\.outputs\.qcm_scope \}\}/);
  assert.match(b, /--qcm-scope "\$QCM_SCOPE"/);
  for (const f of ['test-verify-claims.js', 'test-pr-ci-scope.mjs', 'test-deploy-gate.mjs', 'test-site-surface.mjs', 'test-qcm-boundary.mjs']) {
    assert.match(b, new RegExp(`scripts/${f.replace(/\./g, '\\.')}`), f);
  }
});

test('evidence step: scope tier is an explicit input and the named files are required', () => {
  const b = step('Field Maps test evidence \\(every file ran, nothing skipped unlisted\\)');
  assert.match(b, /QCM_SCOPE: \$\{\{ needs\.scope\.outputs\.qcm_scope \}\}/);
  assert.match(b, /--qcm-scope "\$QCM_SCOPE"/);
  assert.match(b, /--require scripts\/test-verify-claims\.js/);
  assert.match(b, /--require scripts\/test-pr-ci-scope\.mjs/);
  assert.match(b, /--require scripts\/test-deploy-gate\.mjs/);
  assert.match(b, /--require scripts\/test-site-surface\.mjs/);
  assert.match(b, /--require scripts\/test-qcm-boundary\.mjs/);
  assert.doesNotMatch(b, /continue-on-error/);
});

test('required check names, runners and job ids are unchanged', () => {
  assert.deepEqual([...wf.matchAll(/^  ([a-z][a-z0-9-]*):\n/gm)].map((m) => m[1]).filter((j) => ['scope', 'pr-ci', 'site-audit', 'result'].includes(j)), ['scope', 'pr-ci', 'site-audit', 'result']);
  assert.match(job('pr-ci'), /^    runs-on: \$\{\{ .*fromJSON\(vars\.HM_RUNNER \|\| '\[\"self-hosted\",\"heavy\"\]'\) \}\}$/m);
  assert.match(job('scope'), /runs-on: \$\{\{ fromJSON\(vars\.HM_RUNNER_QUICK \|\| '\[\"self-hosted\",\"quick\"\]'\) \}\}/);
  assert.match(job('result'), /runs-on: \$\{\{ fromJSON\(vars\.HM_RUNNER_QUICK \|\| '\[\"self-hosted\",\"quick\"\]'\) \}\}/);
});

test('pr-ci hosted placement is limited to the site and skip tiers', () => {
  const b = job('pr-ci');
  assert.match(b, /contains\(fromJSON\('\["site", "skip"\]'\), needs\.scope\.outputs\.qcm_scope\)/);
  assert.match(b, /vars\.HM_PR_CI_RUNNER != 'self-hosted'/);
  assert.doesNotMatch(b, /!= 'full'/, 'an unknown or empty scope must not land on a hosted runner');
  assert.match(b, /- name: Use the hosted runner's Chrome\n(?:        #.*\n)+        if: runner\.environment == 'github-hosted'\n/);
});

// The 3D screenshot upload is a convenience copy for a reviewer, not evidence: on #791's
// run 39455905553 every test passed and the upload's DNS lookup (ENOTFOUND) failed the job.
test('the J11 3D screenshot upload cannot fail a passing build', () => {
  const step = job('pr-ci').match(/- name: Keep the J11 3D screenshots\n([\s\S]*?)(?=\n      - name: )/);
  assert.ok(step, 'the "Keep the J11 3D screenshots" step is missing');
  assert.match(step[1], /^        continue-on-error: true$/m, 'the screenshot upload can fail a passing build');
});

test('site-audit takes the browser and link audits off pr-ci and needs it', () => {
  const b = job('site-audit');
  assert.match(b, /^    needs: \[scope, pr-ci\]$/m);
  assert.match(b, /^    runs-on: \$\{\{ .*'ubuntu-latest' \|\| fromJSON\(vars\.HM_RUNNER_QUICK \|\| '\[\"self-hosted\",\"quick\"\]'\) \}\}$/m);
  assert.doesNotMatch(b, /heavy/);
  for (const s of ['Validate links \\(htmltest', 'Validate accessibility \\(pa11y-ci', 'Run Lighthouse CI', 'Select Lighthouse URLs']) {
    assert.match(b, new RegExp(`- name: ${s}`), s);
    assert.doesNotMatch(job('pr-ci'), new RegExp(`- name: ${s}`), `${s} still in pr-ci`);
  }
  assert.match(job('pr-ci'), /name: site-public/);
  assert.match(b, /name: site-public/);
  assert.match(b, /^    name: \$\{\{ \(github\.event\.action == 'edited' && !github\.event\.changes\.base\) && 'PR CI site audit \(edit, not re-run\)' \|\| 'PR CI site audit' \}\}$/m);
});

// ---- Lighthouse URLs for a Field Maps (qcm)-only PR ------------------------------------
// Every changed file is Quiet Corners map work -> Lighthouse audits the /quiet-corners URLs
// of .lighthouserc.json plus the home page, read at run time, not the whole list.

const qcUrls = allUrls.filter((u) => u.includes('/quiet-corners'));
const homeUrl = 'http://localhost/index.html';
const qcmLhci = (files, urls = allUrls) => JSON.parse(scope(files, urls).lhci_urls);

test('lhci: the list really has Quiet Corners URLs and a home URL', () => {
  assert.ok(qcUrls.length >= 2, 'quiet-corners URLs in .lighthouserc.json');
  assert.ok(allUrls.includes(homeUrl));
});

test('lhci: a qcm-only PR audits the Quiet Corners URLs plus home', () => {
  const files = [
    'scripts/qcm/aqi.test.mjs',
    'themes/headlessmode/static/js/quiet-corners-maps/main.js',
    'themes/headlessmode/static/js/quiet-corners-sky/sun-moon.js',
    'themes/headlessmode/static/js/quiet-corners.js',
    'static/data/quiet-corners-maps/coverage.json',
    'static/data/quiet-corners/geo.json',
    'content/quiet-corners-maps.md',
  ];
  // content/quiet-corners-maps.md alone is a `narrow` page edit; mixed with code it is not.
  const urls = qcmLhci(files);
  assert.deepEqual(urls, allUrls.filter((u) => u === homeUrl || u.includes('/quiet-corners')));
  assert.ok(urls.length < allUrls.length);
  for (const u of qcUrls) assert.ok(urls.includes(u), u);
  assert.ok(urls.includes(homeUrl));
});

test('lhci: each allowlisted area alone is enough', () => {
  for (const f of [
    'scripts/qcm/helpers/browser.mjs',
    'themes/headlessmode/static/js/quiet-corners.js',
    'themes/headlessmode/static/js/quiet-corners-maps/state-sources.json',
    'themes/headlessmode/static/js/quiet-corners-sky/tonight.js',
    'static/data/quiet-corners/places-AK.json',
    'static/data/quiet-corners-maps/cameras/index.json',
  ]) {
    assert.deepEqual(qcmLhci([f]), allUrls.filter((u) => u === homeUrl || u.includes('/quiet-corners')), f);
  }
});

test('lhci: one non-qcm file anywhere sends Lighthouse to every URL', () => {
  for (const extra of [
    'themes/headlessmode/layouts/index.html',
    'themes/headlessmode/static/js/sun-track-demo.js',
    'themes/headlessmode/static/js/redactcam-demo.js',
    'themes/headlessmode/static/js/table-enhancements.js',
    'themes/headlessmode/static/css/quiet-corners.css',
    'static/data/sun-track/elevation.json',
    'data/systems.json',
    '.lighthouserc.json',
    '.github/workflows/pr-ci.yml',
    'scripts/ci/pr-scope.mjs',
    'scripts/validate.sh',
  ]) {
    assert.deepEqual(qcmLhci(['scripts/qcm/aqi.test.mjs', extra]), allUrls, extra);
  }
});

test('lhci: look-alike and traversal paths are not qcm', () => {
  for (const f of [
    'scripts/qcm-extra/x.mjs',
    'scripts/qcm/../validate.sh',
    'themes/headlessmode/static/js/quiet-corners-maps-extra/x.js',
    'themes/headlessmode/static/js/quiet-corners-maps/../sun-track-demo.js',
    'themes/headlessmode/static/js/quiet-corners-sky.js',
    'static/data/quiet-corners-other/x.json',
    'content/quiet-corners-other/x.html',
  ]) {
    assert.deepEqual(qcmLhci([f]), allUrls, f);
  }
});

test('lhci: fails safe to every URL', () => {
  assert.deepEqual(qcmLhci([]), allUrls, 'empty change list');
  assert.deepEqual(qcmLhci(['', '  ']), allUrls, 'blank lines only');
  const noQc = allUrls.filter((u) => !u.includes('/quiet-corners'));
  assert.deepEqual(qcmLhci(['scripts/qcm/aqi.test.mjs'], noQc), noQc, 'no quiet-corners URL in the rc');
});

test('lhci: the URL set is read from the list, never a copy', () => {
  const urls = ['http://localhost/index.html', 'http://localhost/x/index.html', 'http://localhost/quiet-corners/index.html', 'http://localhost/quiet-corners/zz/index.html'];
  assert.deepEqual(qcmLhci(['scripts/qcm/aqi.test.mjs'], urls), [urls[0], urls[2], urls[3]]);
  // A list with no home URL audits just the Quiet Corners URLs.
  assert.deepEqual(qcmLhci(['scripts/qcm/aqi.test.mjs'], urls.slice(1)), urls.slice(2));
});

test('lhci: a narrow tier keeps the smoke list, even for qcm content', () => {
  assert.deepEqual(qcmLhci(['content/quiet-corners-maps.md']), SMOKE_URLS);
  assert.deepEqual(qcmLhci(['content/quiet-corners.md', 'README.md']), SMOKE_URLS);
  assert.deepEqual(qcmLhci(['content/about.md']), SMOKE_URLS);
});

test('lhci: only lhci_urls changes; tier and qcm fields are unaffected', () => {
  const s = scope(['scripts/qcm/aqi.test.mjs'], allUrls);
  assert.equal(s.tier, 'full');
  assert.equal(s.qcm_scope, 'full');
  assert.equal(s.qcm_pattern, QCM_PATTERN);
});
