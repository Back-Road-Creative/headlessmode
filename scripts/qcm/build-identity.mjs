// Build identity: what is in this build of public/, which commit it came from, and whether
// that is what is deployed. An acceptance or audit run starts from a passing record so a
// screenshot is never taken of a build that was missing its compiled CSS (audit A12).
//
// Every read is injected (file reads, git), so the tests need no checkout, no network and no
// browser. Deployed identity comes ONLY from git -- the subject of origin/production's orphan
// commit (deploy-production.yml, "chore(deploy): publish <sha>") and its deploy-marker.txt --
// never from the live site. The production branch is an orphan, so source and deployed are
// matched by SHA string alone; there is no ancestry to walk.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DASHBOARD_LAYOUT = path.join(ROOT, 'themes', 'headlessmode', 'layouts', '_default', 'quiet-corners-dashboard.html');

// The one string scripts/test_preview_readiness.py:185 asserts on to tell compiled Tailwind
// (its preflight reset) from anything else served at /css/tailwind.css.
export const PREFLIGHT_MARKER = 'max-width:100%';
// What src/css/main.css is made of: directives only the Tailwind CLI understands.
const RAW_SOURCE = /^\s*@(?:import\s+["']tailwindcss|tailwind\s|plugin\s)/m;

const DEPLOY_SUBJECT = /^chore\(deploy\): publish ([0-9a-f]{40})$/;

const TAILWIND = 'css/tailwind.css';
const QC_INDEX = 'quiet-corners/index.html';
const HEADERS = '_headers';

/** Local `<script src>` paths in a Hugo layout, relative to public/. Hugo comments are
 *  dropped first (they quote script tags in prose); absolute URLs are not ours to check. */
export function dashboardScripts(layoutText) {
  const text = layoutText.replace(/\{\{\s*\/\*[\s\S]*?\*\/\s*\}\}/g, '');
  const out = [];
  for (const tag of text.matchAll(/<script\b[^>]*>/gi)) {
    const m = tag[0].match(/\ssrc=(?:"\{\{\s*"([^"]+)"\s*\|\s*relURL\s*\}\}"|"([^"{}]+)")/);
    const src = m && (m[1] ?? m[2]);
    if (!src || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) continue;
    out.push(src.replace(/^\/+/, ''));
  }
  return out;
}

const asText = (v) => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v ?? ''));

/** Problems that make a build unfit to audit; an empty array means fit. */
export function checkEssentials(publicDir, {
  readFile = (p) => readFileSync(p), exists = existsSync, layoutPath = DASHBOARD_LAYOUT,
} = {}) {
  const problems = [];
  const at = (rel) => path.join(publicDir, rel);

  if (!exists(at(QC_INDEX))) problems.push(`missing public/${QC_INDEX}`);

  if (!exists(at(TAILWIND))) {
    problems.push(`missing public/${TAILWIND} (run \`npm run build:css\` before the Hugo build)`);
  } else {
    const css = asText(readFile(at(TAILWIND)));
    if (css.trim() === '') problems.push(`public/${TAILWIND} is empty`);
    else if (RAW_SOURCE.test(css)) problems.push(`public/${TAILWIND} is raw Tailwind source, not compiled`);
    else if (!css.includes(PREFLIGHT_MARKER)) {
      problems.push(`public/${TAILWIND} has no Tailwind preflight (\`${PREFLIGHT_MARKER}\`); it is not compiled output`);
    }
  }

  if (!exists(at(HEADERS))) {
    problems.push(`missing public/${HEADERS} (scripts/build-site.sh writes it via gen-headers.mjs --write-public)`);
  }

  let scripts = [];
  try {
    scripts = dashboardScripts(asText(readFile(layoutPath)));
  } catch (err) {
    problems.push(`cannot read the dashboard layout ${layoutPath}: ${err.message}`);
    return problems;
  }
  if (scripts.length === 0) problems.push('the dashboard layout has no local <script> to check');
  for (const rel of scripts) {
    if (!exists(at(rel))) problems.push(`missing public/${rel} (a <script> the dashboard loads)`);
  }
  return problems;
}

/** The 40-hex source SHA from the production branch's commit subject, or null. */
export function parseDeployCommit(subject) {
  const m = DEPLOY_SUBJECT.exec(String(subject ?? '').trim());
  return m ? m[1] : null;
}

/** Paths from `git status --porcelain -z`: NUL-separated, never quoted. A rename or copy is
 *  `XY <new>` then its origin as the next entry; the record keeps the new path only. */
function parseDirty(porcelainZ) {
  const entries = String(porcelainZ).split('\0');
  const out = [];
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (e === '') continue;
    out.push(e.slice(3));
    if (/[RC]/.test(e.slice(0, 2))) i += 1;
  }
  return out;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function readDeployed(git, sourceSha) {
  let subject;
  try {
    subject = git(['log', '-1', '--format=%s', 'origin/production']);
  } catch {
    return null; // no origin/production here: nothing to compare, not an error
  }
  let marker = null;
  try {
    marker = String(git(['show', 'origin/production:deploy-marker.txt'])).trim() || null;
  } catch { /* a production commit with no marker file: marker stays null */ }
  const sha = parseDeployCommit(subject);
  return { sha, marker, agree: sha !== null && sha === marker, isSource: sha !== null && sha === sourceSha };
}

/** The identity record. `git(args)` returns stdout and throws on a non-zero exit. */
export function buildIdentity({
  git, publicDir = PUBLIC_DIR, readFile = (p) => readFileSync(p), exists = existsSync, layoutPath = DASHBOARD_LAYOUT,
} = {}) {
  const sourceSha = String(git(['rev-parse', 'HEAD'])).trim();
  const dirty = parseDirty(git(['status', '--porcelain', '-z']));

  const problems = checkEssentials(publicDir, { readFile, exists, layoutPath });

  const paths = [TAILWIND, QC_INDEX];
  try {
    paths.push(...dashboardScripts(asText(readFile(layoutPath))));
  } catch { /* checkEssentials already reported the unreadable layout */ }
  const assets = {};
  for (const rel of [...new Set(paths)]) {
    const file = path.join(publicDir, rel);
    assets[rel] = exists(file) ? sha256(readFile(file)) : null;
  }

  return {
    sourceSha,
    dirty,
    essentials: { ok: problems.length === 0, problems },
    assets,
    deployed: readDeployed(git, sourceSha),
  };
}

const gitCli = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** The value after `--name`, null when the flag is absent; a missing value is a usage error. */
function flagValue(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`build-identity: ${name} needs a value.`);
  return v;
}

function main(argv) {
  const out = flagValue(argv, '--json');
  const publicDir = flagValue(argv, '--public') ?? PUBLIC_DIR; // a fixture, for the tests
  const layoutPath = flagValue(argv, '--layout') ?? DASHBOARD_LAYOUT;
  const record = buildIdentity({ git: gitCli, publicDir, layoutPath });
  const text = `${JSON.stringify(record, null, 2)}\n`;
  process.stdout.write(text);
  if (out) writeFileSync(out, text);
  if (!record.essentials.ok) {
    console.error(`build-identity: build is not fit to audit:\n  - ${record.essentials.problems.join('\n  - ')}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (err) { console.error(err.message); process.exitCode = 2; }
}
