// The dependency boundary between the marketing site and the Field Maps app, as data.
//
// scripts/qcm/*.test.mjs is two kinds of file:
//   ENGINE        imports only the app's own modules (themes/headlessmode/static/js/**),
//                 fixtures and helpers, and reads nothing the site build or a site edit
//                 produces. A homepage, site-chrome or site-data change cannot move it.
//   SITE-COUPLED  reads the built site (public/, via helpers/site-server.mjs), a non-app
//                 layout, content/, root data/, site-config/, static/llms.txt or static
//                 images / generated CSS, directly or through a helper it imports. A change
//                 to the site chrome can move it.
//
// Which file is which is not remembered by hand: SITE_READS below is the static scan, and
// scripts/qcm/site-coupling.json is the committed list of the files it finds.
// scripts/test-qcm-boundary.mjs (a named, every-tier test) fails when the scan and the list
// disagree, in either direction, and when an ENGINE-listed file reads a site path. The list
// being out of date is therefore never silent, and the safe way to fix it is mechanical:
//   node scripts/ci/qcm-boundary.mjs write
// pr-scope.mjs reads the list to decide what a `site` scope runs; run-with-evidence.mjs and
// check-evidence.mjs read it to run and to demand exactly those files.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
export const QCM_DIR = 'scripts/qcm';
export const MANIFEST = `${QCM_DIR}/site-coupling.json`;

// What marks a file as reading the site chrome: the files a homepage / site-chrome change
// edits (SITE_CHROME in pr-scope.mjs) and the built pages they reach. Raw-text patterns on
// purpose: a comment that names a site path makes a file SITE-COUPLED (more tests run, never
// fewer), and a read built from pieces still names one of its pieces. The app's own files are
// NOT site reads and are excluded by lookahead: the quiet-corners layouts, qcm-* partials and
// shortcodes, content/quiet-corners*.md and data/quiet-corners-maps/ (a change to any of
// those is `full` anyway). Anything else under those roots counts as site, so a new path
// defaults to the safe side.
export const SITE_READS = [
  ['the built site (public/)', /\bsite-server\b|\bsiteIsBuilt\b|\bstartSiteServer\b|(^|[^\w/.-])public\/|['"`]public['"`]/],
  ['a non-app theme layout', /themes\/headlessmode\/layouts\/(?!_default\/quiet-corners-|partials\/qcm-|shortcodes\/qcm-)|['"`]layouts['"`]/],
  ['content/ outside quiet-corners*.md', /\bcontent\/(?!quiet-corners)[\w.{$]|['"`]content['"`]\s*[,)]/],
  ['root data/ outside quiet-corners-maps/', /\.\.\/data\/(?!quiet-corners-maps\/)|['"`]data\/(?!quiet-corners-maps\/)|(join|resolve)\([^)]*['"`]data['"`]/],
  ['site-config/', /(?<!configDir )site-config/],
  ['static/llms.txt', /llms\.txt/],
  ['static images and generated css', /static\/(img|og)\b|\btailwind\b/i],
];

const posix = (p) => p.split(path.sep).join('/');
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g;

/** Repo-relative scripts/qcm/*.test.mjs, sorted (CI's glob does not recurse). */
export function qcmTestFiles(repo = REPO) {
  return readdirSync(path.join(repo, QCM_DIR)).filter((n) => n.endsWith('.test.mjs')).sort().map((n) => `${QCM_DIR}/${n}`);
}

/** The file and every local module it imports, transitively, kept inside scripts/ (app
 *  modules under themes/ are not walked: they are the app, and what they fetch at run time is
 *  a URL, not a repo file). Returns repo-relative paths. */
/** Modules whose job is to narrow a site root to the app's own files. They name site layouts
 *  only to exclude them (scripts/qcm/layouts-scope.test.mjs proves the narrowing), so their
 *  text is not a read. Everything else is scanned. */
export const BOUNDARY_HELPERS = ['scripts/qcm/helpers/layouts.mjs'];

export function importClosure(file, repo = REPO) {
  const seen = new Set();
  const queue = [file];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = path.join(repo, rel);
    if (!existsSync(abs) || !/\.(mjs|js)$/.test(abs)) continue;
    for (const m of readFileSync(abs, 'utf8').matchAll(IMPORT_RE)) {
      const dep = posix(path.relative(repo, path.resolve(path.dirname(abs), m[1])));
      if (dep.startsWith('scripts/') && !seen.has(dep)) queue.push(dep);
    }
  }
  return [...seen].sort();
}

/** What a text reads of the site: the labels of every SITE_READS pattern it matches. */
export function siteReadsIn(text) {
  return SITE_READS.filter(([, re]) => re.test(text)).map(([label]) => label);
}

/** Labels of the site paths `file` reads, directly or through the helpers it imports. */
export function siteReads(file, repo = REPO) {
  const labels = new Set();
  for (const dep of importClosure(file, repo)) {
    if (BOUNDARY_HELPERS.includes(dep)) continue;
    const abs = path.join(repo, dep);
    if (existsSync(abs)) for (const l of siteReadsIn(readFileSync(abs, 'utf8'))) labels.add(l);
  }
  return [...labels];
}

/** The SITE-COUPLED test files the scan finds, sorted. */
export function detectSiteCoupled(repo = REPO) {
  return qcmTestFiles(repo).filter((f) => siteReads(f, repo).length > 0);
}

/** The committed list. Throws on a missing or malformed file: a `site` scope with no list must not run. */
export function siteCoupledFiles(repo = REPO) {
  const doc = JSON.parse(readFileSync(path.join(repo, MANIFEST), 'utf8'));
  if (!Array.isArray(doc.siteCoupled) || doc.siteCoupled.some((f) => typeof f !== 'string')) {
    throw new Error(`${MANIFEST}: needs a "siteCoupled" array of test file paths`);
  }
  return doc.siteCoupled;
}

export function manifestText(files) {
  return `${JSON.stringify({
    comment: 'Generated by `node scripts/ci/qcm-boundary.mjs write`; checked by scripts/test-qcm-boundary.mjs. The Field Maps test files that read the built site, layouts, content, data, site-config, llms.txt or static images/css (see SITE_READS in scripts/ci/qcm-boundary.mjs). A `site` PR CI scope runs exactly these; every other scripts/qcm test is ENGINE and is skipped for it.',
    siteCoupled: files,
  }, null, 2)}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const mode = process.argv[2];
  if (mode === 'write') {
    const files = detectSiteCoupled();
    writeFileSync(path.join(REPO, MANIFEST), manifestText(files));
    console.log(`${MANIFEST}: ${files.length} site-coupled of ${qcmTestFiles().length} test files`);
  } else if (mode === 'list') {
    for (const f of siteCoupledFiles()) console.log(f);
  } else {
    console.error('usage: qcm-boundary.mjs write | list');
    process.exit(2);
  }
}
