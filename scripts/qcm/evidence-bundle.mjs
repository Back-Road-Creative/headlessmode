// Quality-evidence bundle check (QQA-12). A bundle says: at auditedSha, each acceptance-manifest
// journey was run and came out pass / fail / skipped / not-applicable.
//
// Freshness is per journey and never by ancestry. Evidence is fresh when auditedSha is the
// candidate, when both commits have the same tree (a squash), or when no file changed between
// them matches that journey's `invalidatedBy` list in acceptance-manifest.json. A journey with
// no list, or a git failure while resolving a sha, is stale (fail closed).
// verifyEvidence is pure (treeOf and changedFiles are injected); the CLI wires them to git.
//
//   node scripts/qcm/evidence-bundle.mjs <bundle.json> --candidate <sha>
//
// Exit 0 when the bundle covers the candidate, exit 1 with one plain line per problem.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RESULTS = ['pass', 'fail', 'skipped', 'not-applicable'];
// C = renderer limitation: the headless renderer cannot show the thing, so the journey cannot be run.
export const NOT_APPLICABLE_CLASSES = ['C'];
const MANIFEST = new URL('./acceptance-manifest.json', import.meta.url);

export const loadManifest = () => JSON.parse(readFileSync(MANIFEST, 'utf8'));
export function manifestJourneyIds() {
  return loadManifest().journeys.map((j) => j.id);
}

// An invalidatedBy entry is an exact path, a directory prefix (ends in "/"), or a glob where
// "*" stays inside one path segment and "**" crosses segments.
const globRe = (g) =>
  new RegExp('^' + g.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*') + '$');
export function matchesScope(file, entry) {
  if (entry.endsWith('/')) return file.startsWith(entry);
  if (entry.includes('*')) return globRe(entry).test(file);
  return file === entry;
}

// Map of journey id -> reason its evidence is stale. Empty when the evidence is fresh.
function staleJourneys(audited, candidate, manifest, { treeOf, changedFiles }) {
  const out = new Map();
  if (!text(audited) || !text(candidate) || audited === candidate) return out;
  const all = (why) => { for (const j of manifest.journeys) out.set(j.id, why); return out; };
  let same;
  try {
    same = treeOf(audited) === treeOf(candidate);
  } catch (e) {
    return all(`cannot resolve ${audited} or ${candidate} to a tree (${e.message})`);
  }
  if (same) return out;
  let changed;
  try {
    changed = changedFiles(audited, candidate);
  } catch (e) {
    return all(`cannot list files changed since ${audited} (${e.message})`);
  }
  for (const j of manifest.journeys) {
    if (!Array.isArray(j.invalidatedBy) || j.invalidatedBy.length === 0) {
      out.set(j.id, 'has no invalidation list, so it cannot be shown untouched');
      continue;
    }
    const hit = changed.find((f) => j.invalidatedBy.some((e) => matchesScope(f, e)));
    if (hit) out.set(j.id, `${hit} changed since auditedSha ${audited}`);
  }
  return out;
}

const text = (v) => typeof v === 'string' && v.trim() !== '';

export function verifyEvidence(bundle, { candidateSha, treeOf, changedFiles, manifest = loadManifest() } = {}) {
  const manifestIds = manifest.journeys.map((j) => j.id);
  const problems = [];
  const bad = (msg) => problems.push(msg);
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    return { ok: false, problems: ['no evidence bundle: nothing to check'] };
  }

  if (!text(candidateSha)) bad('no candidate sha given');
  if (!text(bundle.auditedSha)) bad('bundle has no auditedSha');
  const stale = staleJourneys(bundle.auditedSha, candidateSha, manifest, { treeOf, changedFiles });

  const journeys = Array.isArray(bundle.journeys) ? bundle.journeys : null;
  if (!journeys) bad('bundle journeys must be an array');
  const seen = new Set();
  for (const j of journeys ?? []) {
    const id = j?.id;
    if (!manifestIds.includes(id)) { bad(`journey ${id} is not in the acceptance manifest`); continue; }
    if (seen.has(id)) { bad(`journey ${id} is listed twice`); continue; }
    seen.add(id);
    if (!RESULTS.includes(j.result)) bad(`${id} result "${j.result}" is not one of ${RESULTS.join(', ')}`);
    else if (j.result === 'fail') bad(`${id} failed`);
    else if (j.result === 'skipped') bad(`${id} was skipped: skipped evidence is not evidence`);
    else if (j.result === 'not-applicable') {
      if (!NOT_APPLICABLE_CLASSES.includes(j.class)) {
        bad(`${id} is not-applicable without a class (one of ${NOT_APPLICABLE_CLASSES.join(', ')})`);
      }
      if (!text(j.reason)) bad(`${id} is not-applicable without a cited reason`);
    }
    if (j.artifacts !== undefined && !(Array.isArray(j.artifacts) && j.artifacts.every(text))) {
      bad(`${id} artifacts must be a list of non-empty strings`);
    }
  }
  for (const id of manifestIds) if (!seen.has(id)) bad(`journey ${id} is missing from the bundle`);
  for (const [id, why] of stale) bad(`journey ${id} evidence is stale: ${why}`);

  return { ok: problems.length === 0, problems };
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitTreeOf = (sha) => git('rev-parse', `${sha}^{tree}`);
const gitChangedFiles = (a, c) => git('diff', '--name-only', a, c).split('\n').filter(Boolean);

export function main(argv) {
  const file = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--candidate');
  const at = argv.indexOf('--candidate');
  const candidateSha = at >= 0 ? argv[at + 1] : undefined;
  if (!file || !candidateSha) {
    console.error('usage: node scripts/qcm/evidence-bundle.mjs <bundle.json> --candidate <sha>');
    return 1;
  }
  let bundle;
  try {
    bundle = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`evidence bundle ${file} is missing or unreadable: ${e.message}`);
    return 1;
  }
  const { ok, problems } = verifyEvidence(bundle, { candidateSha, treeOf: gitTreeOf, changedFiles: gitChangedFiles });
  if (ok) { console.log(`evidence bundle OK for ${candidateSha}`); return 0; }
  for (const p of problems) console.error(`evidence: ${p}`);
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
