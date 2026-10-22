#!/usr/bin/env node
// PR CI scope classifier. Reads the changed file list and decides the tier:
//   narrow = every changed file is content-only (cannot change layout, scripts,
//            build or gate config) -> Lighthouse runs a 3-URL smoke list.
//   full   = anything else, including any path this file cannot classify.
// Unknown is always full.
//
// A third, narrower decision inside `full`: when EVERY changed file is Quiet Corners map (qcm)
// work (QCM_LHCI below), Lighthouse audits the /quiet-corners URLs of .lighthouserc.json plus
// the home page instead of all of them. The URLs are read from the list at run time. One file
// outside QCM_LHCI, an empty list, or a list with no /quiet-corners URL means every URL. A
// `narrow` PR keeps its smoke list.
//
// A second, independent decision: how much of the Field Maps suite (scripts/qcm/*.test.mjs,
// the slowest step, p50 13.7 min) runs. Three tiers:
//   skip = EVERY changed file is on the QCM_SKIP allowlist below: paths no qcm test, and
//          nothing a built quiet-corners page renders or loads, reads. No qcm file runs.
//   site = every changed file is in QCM_SKIP or SITE_CHROME (the marketing site's own files:
//          homepage, shared head partial, params.toml, data/systems.json, llms.txt), and at
//          least one is SITE_CHROME. Only the SITE-COUPLED qcm files run: the ones that read
//          the built site, its layouts, content, data, site-config, llms.txt or images
//          (scripts/qcm/site-coupling.json, generated and guarded by scripts/ci/qcm-boundary.mjs
//          and scripts/test-qcm-boundary.mjs). The ENGINE files (app logic, sources, layers,
//          renderer: they read only the app's own files) cannot observe a site-chrome edit.
//   full = anything else. Empty list, an unknown path, workflow_dispatch (empty list),
//          anything under quiet-corners, static/js, static/data, scripts/qcm, scripts/ci,
//          .github or package*.json is full. Unknown is always full.
// The Hugo build, Python validators, pa11y, htmltest, link check, Lighthouse and the named
// node tests (test-verify-claims.js, test-pr-ci-scope.mjs, test-deploy-gate.mjs,
// test-site-surface.mjs, test-qcm-boundary.mjs) run in every tier. run-with-evidence.mjs and
// check-evidence.mjs take the tier as --qcm-scope; check-evidence keeps demanding the named
// files, and for `site` every file of the manifest.
//
// CLI:
//   git diff --name-only A...B | node scripts/ci/pr-scope.mjs scope   (writes $GITHUB_OUTPUT lines to stdout)
//   node scripts/ci/pr-scope.mjs rc '<urls-json>' [out]   (.lighthouserc.json with collect.url replaced)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const QCM_PATTERN = 'scripts/qcm/*.test.mjs';

// Smoke list: home, one product page, one /rigscore/ page. Real entries of
// .lighthouserc.json's collect.url.
export const SMOKE_URLS = [
  'http://localhost/index.html',
  'http://localhost/keycut/index.html',
  'http://localhost/rigscore/index.html',
];

// Content-only. Anchored; anything not matching one of these is `full`.
const NARROW = [
  /^content\/(?!_)[^]*\.md$/, // pages (not content/_content.schema.yaml, which validators read)
  /^static\/img\/[^]+$/,
  /^static\/og\/[^]+$/,
  /^[^/]+\.md$/, // root docs (README, CONTENT_GUIDELINES, ...); scripts/**/*.md stays full
];

// Field Maps suite skip allowlist: anchored, positive-only. Each entry is grounded by grep over
// scripts/qcm/** (what the 206 qcm test files read) and the quiet-corners layouts (what the
// built pages render). Everything else is full, notably (all read by qcm tests or rendered
// into every page): data/**, static/llms.txt (print-proof.test.mjs), static/_headers,
// static/js|data/**, site-config/**, themes/** (helpers/layouts.mjs and
// css-selector-reach.test.mjs walk EVERY layout, incl. index.html, and Tailwind scans them
// into the css the pages load), package*.json, scripts/**, .github/**, src/**.
const QCM_SKIP = [
  // Pages. The qcm tests read only content/quiet-corners.md, quiet-corners-maps.md and
  // content/qcm-states/ (a nested dir, never matched: the name is a single path segment).
  // The quiet-corners pages iterate no other content (no .Pages/.RegularPages in their
  // layouts or partials; list.html is not theirs). `_` files are schemas the validators read.
  /^content\/(?!_|quiet-corners)[^/]+\.md$/,
  // Images: no qcm test, layout, partial, page-JS, content/quiet-corners*.md or Pages Function
  // names static/img or static/og (grep of all of them: zero hits; head.html's icons are
  // static root files). A page that starts to show one edits a layout or content/quiet-corners*.md,
  // which is full.
  /^static\/img\/[^]+$/,
  /^static\/og\/[^]+$/,
  // Root docs: no qcm test reads them (evidence-bundle.test.mjs only passes names as strings).
  /^[^/]+\.md$/,
  // Python validator tests, run in every tier. qcm tests only mention them in comments.
  // Top level of scripts/ only, and only the .py file itself.
  /^scripts\/test_[A-Za-z0-9_]+\.py$/,
];

// The marketing site's own files: what the built-page qcm tests can observe, and the Field
// Maps app itself reads none of. Each is exact (no globs) and admitted by grep proof:
//   - no ENGINE qcm test names it (scripts/test-qcm-boundary.mjs greps for every one);
//   - no quiet-corners layout, partial, shortcode or page-JS includes or fetches it. The
//     homepage and the product-page layouts are separate templates; head.html is included by
//     baseof.html, so a head edit reaches the built app pages, and the SITE-COUPLED browser
//     tests that load those pages are exactly what the site tier still runs. The same holds
//     for data/systems.json, which the dashboard layout renders through system-chip.html:
//     it reaches the app only as a BUILT page, and only site-coupled files read built pages;
//   - static/img/*/manifest.json is already QCM_SKIP (static/img/**), so it needs no entry.
const SITE_CHROME = [
  /^themes\/headlessmode\/layouts\/index\.html$/,
  /^themes\/headlessmode\/layouts\/partials\/head\.html$/,
  /^site-config\/_default\/params\.toml$/,
  /^data\/systems\.json$/,
  /^static\/llms\.txt$/,
];

// Quiet Corners map work: the only files whose edit cannot change a page Lighthouse audits
// other than /quiet-corners/ and /quiet-corners/maps/. Anchored, positive-only; each entry is
// grounded by grep (2026-10-21). Everything else, notably layouts, partials, css, head.html,
// data/**, static/_headers and the demo scripts, stays full.
//   - scripts/qcm/**: tests, validators and generators. build-site.sh runs gen-headers.mjs
//     (writes public/_headers, which lhci's staticDistDir server ignores) and
//     build-camera-snapshot.mjs (writes only public/data/quiet-corners-maps/); no layout or
//     other page reads a file here.
//   - static/data/quiet-corners/** and static/data/quiet-corners-maps/**: fetched at run time by
//     the quiet-corners JS only (the only other mention is jsonld.html's contentUrl string, which
//     renders on /quiet-corners/ alone); sun-track-demo.js and redactcam-demo.js fetch
//     /data/sun-track and /data/redactcam.
//   - content/quiet-corners.md and content/quiet-corners-maps.md: the two pages themselves. No
//     layout ranges .Pages except list.html, and neither file sits in a section.
//   - js/quiet-corners.js, js/quiet-corners-maps/** and js/quiet-corners-sky/**: the only script
//     tags that load them are in quiet-corners-dashboard.html (quiet-corners.js, then
//     quiet-corners-maps/main.js, which imports the rest); no other layout, partial or JS file
//     imports them (sun-track-demo.js and sun-moon.js only name them in comments).
//     The other files under js/ (mermaid-loader, table-enhancements, redactcam-demo,
//     sun-track-demo) are loaded by head.html or by other pages: not listed.
const QCM_LHCI = [
  /^scripts\/qcm\/[^]+$/,
  /^static\/data\/quiet-corners\/[^]+$/,
  /^static\/data\/quiet-corners-maps\/[^]+$/,
  /^content\/quiet-corners(-maps)?\.md$/,
  /^themes\/headlessmode\/static\/js\/quiet-corners\.js$/,
  /^themes\/headlessmode\/static\/js\/quiet-corners-(maps|sky)\/[^]+$/,
];

/** True when every changed file is Quiet Corners map work (an empty list or a `..` is not). */
export function isQcmOnly(files) {
  const list = files.map((f) => f.trim()).filter(Boolean);
  if (list.length === 0) return false;
  if (list.some((f) => f.split('/').includes('..'))) return false;
  return list.every((f) => QCM_LHCI.some((re) => re.test(f)));
}

/** The /quiet-corners URLs of the list plus its home page; the whole list when it has no QC URL. */
export function qcmLhciUrls(allUrls) {
  const isHome = (u) => ['/', '/index.html'].includes(new URL(u).pathname);
  const qc = (u) => new URL(u).pathname.startsWith('/quiet-corners');
  if (!allUrls.some(qc)) return allUrls;
  return allUrls.filter((u) => qc(u) || isHome(u));
}

/** 'skip' when no qcm file can be affected, 'site' when only the SITE-COUPLED ones can, else 'full'. */
export function qcmScope(files) {
  const list = files.map((f) => f.trim()).filter(Boolean);
  if (list.length === 0) return 'full';
  if (list.some((f) => f.split('/').includes('..'))) return 'full';
  const skippable = (f) => QCM_SKIP.some((re) => re.test(f));
  const chrome = (f) => SITE_CHROME.some((re) => re.test(f));
  if (!list.every((f) => skippable(f) || chrome(f))) return 'full';
  return list.some(chrome) ? 'site' : 'skip';
}

export function classify(files) {
  const list = files.map((f) => f.trim()).filter(Boolean);
  if (list.length === 0) return 'full';
  return list.every((f) => NARROW.some((re) => re.test(f))) ? 'narrow' : 'full';
}

export function scope(files, allUrls) {
  const tier = classify(files);
  const qcm = qcmScope(files);
  return {
    tier,
    lhci_urls: JSON.stringify(
      tier === 'narrow' ? SMOKE_URLS : isQcmOnly(files) ? qcmLhciUrls(allUrls) : allUrls,
    ),
    qcm_scope: qcm,
    // Empty on skip and site: the workflow expands an empty pattern to no argument, so the
    // glob is not passed. Skip runs only the named files; site also gets the manifest's files
    // from run-with-evidence.mjs --qcm-scope site.
    qcm_pattern: qcm === 'full' ? QCM_PATTERN : '',
  };
}

export function writeRc(urls, src = '.lighthouserc.json', out = '.lighthouserc.run.json') {
  const rc = JSON.parse(readFileSync(src, 'utf8'));
  rc.ci.collect.url = urls;
  writeFileSync(out, JSON.stringify(rc, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, arg, out] = process.argv.slice(2);
  if (mode === 'scope') {
    const files = readFileSync(0, 'utf8').split('\n');
    const all = JSON.parse(readFileSync('.lighthouserc.json', 'utf8')).ci.collect.url;
    for (const [k, v] of Object.entries(scope(files, all))) console.log(`${k}=${v}`);
  } else if (mode === 'rc') {
    writeRc(JSON.parse(arg), '.lighthouserc.json', out);
  } else {
    console.error('usage: pr-scope.mjs scope < files | rc <urls-json> [out]');
    process.exit(2);
  }
}
