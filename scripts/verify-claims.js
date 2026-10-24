#!/usr/bin/env node
/**
 * verify-claims.js — detection-only re-verification of systems.json claims
 * against live GitHub reality.
 *
 * Every home-page roster entry makes a claim once, at merge time. htmltest re-probes
 * the URLs on every deploy, but never the claim BEHIND the 200 — a repo can go
 * private, a release can lose its asset, a license can change, and the link
 * still returns 200. This re-checks the claim itself, nightly, from
 * drift-sentinel.yml. Detection only: no writes, no rendering, no build gate.
 *
 * Rules (every entry sourced from data/systems.json):
 *   1. Every entry with a github.com URL in `repo` or `link` (repo preferred):
 *      GET /repos/<owner>/<name> — visibility "public", archived false;
 *      pushed_at collected for the staleness line (rule 4).
 *   2. Every entry with a `download` key: GET /repos/<o>/<n>/releases/latest —
 *      assets.length must be >= 1 (an installer someone can actually run).
 *   3. License claims: content/driftless.md asserts Apache-2.0 (verified by
 *      reading the page when this gate was built) — the live repo's
 *      license.spdx_id must still match. Grant Platform's source is private,
 *      so its page claims no licence and it deliberately has no row here.
 *   4. Report mode (default) prints a table: entry, probe, result, pushed_at
 *      age in days. A staleness line (max age > 60d) is report-only, never a failure.
 *   5. --strict exits 1 on any BREACH. A SKIP (network failure, timeout, rate
 *      limit) never fails the gate — only a definitive breach does. A 404/403
 *      on a repo systems.json calls public IS a breach; a timeout is a SKIP.
 *
 * Usage:
 *   node scripts/verify-claims.js            # report mode, table + exit 0
 *   node scripts/verify-claims.js --strict    # exit 1 on any BREACH
 *
 * GITHUB_TOKEN, when set, is sent as `Authorization: Bearer` (unauthenticated
 * calls work fine at this volume). No deps beyond node builtins.
 */
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SYSTEMS_FILE = path.join(ROOT, 'data', 'systems.json');
const TOKEN = process.env.GITHUB_TOKEN || '';

// Grounded by reading each page: driftless states Apache-2.0 (2026-09-01); waypost
// states MIT and framegrade states Apache-2.0, both matching the live repositories.
// Grant Platform is deliberately absent: its repository is private, so there is no
// public licence file to probe and its page makes no licence claim to re-verify.
const LICENSE_CLAIMS = [
  { page: 'content/driftless.md', owner: 'Back-Road-Creative', repo: 'driftless', spdx: 'Apache-2.0' },
  { page: 'content/waypost.md', owner: 'Back-Road-Creative', repo: 'waypost', spdx: 'MIT' },
  { page: 'content/framegrade.md', owner: 'Back-Road-Creative', repo: 'framegrade', spdx: 'Apache-2.0' },
];

const rows = [];
const ok = (msg) => process.stdout.write(`OK: ${msg}\n`);
const fail = (msg) => process.stderr.write(`FAIL: ${msg}\n`);
const skip = (msg) => process.stdout.write(`SKIP: ${msg}\n`);

export function parseArgs(argv) {
  return { strict: argv.includes('--strict') };
}

// { owner, repo } from a github.com repo URL or its releases/latest page.
export function extractRepo(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  const m = urlStr.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/releases\/latest)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export function daysSince(iso) {
  const then = Date.parse(iso);
  return Number.isNaN(then) ? null : Math.floor((Date.now() - then) / 86400000);
}

// A rate-limited 403 is an environment problem, not proof the repo went private.
export function rateLimited(res) {
  return res.status === 403 && /rate limit/i.test(res.raw || '');
}

// Single GitHub API GET. Never throws: network errors/timeouts resolve to
// { networkError: true }, same degrade-offline pattern as this repo's gates.
function githubGet(apiPath) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: apiPath,
      headers: { 'User-Agent': 'headlessmode-verify-claims', Accept: 'application/vnd.github+json' },
      timeout: 10000,
    };
    if (TOKEN) options.headers.Authorization = `Bearer ${TOKEN}`;
    const req = https.get(options, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch { /* non-JSON body */ }
        resolve({ networkError: false, status: res.statusCode, json, raw: body });
      });
    });
    req.on('error', (err) => resolve({ networkError: true, message: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ networkError: true, message: 'timeout' }); });
  });
}

// Shared classify-then-record shape: SKIP on network trouble, BREACH on a
// definitive 404/403, SKIP on anything else unusable, else hand the parsed
// JSON to `judge` to decide PASS/BREACH.
async function runProbe(entryName, probe, key, res, judge) {
  if (res.networkError) {
    skip(`${entryName} (${probe}): ${res.message}`);
    rows.push({ entry: entryName, probe, result: 'SKIP', ageDays: null });
    return;
  }
  if (res.status === 404 || (res.status === 403 && !rateLimited(res))) {
    fail(`${entryName} (${probe}): expected a live public resource, got HTTP ${res.status} for ${key}`);
    rows.push({ entry: entryName, probe, result: 'BREACH', ageDays: null });
    return;
  }
  if (rateLimited(res) || res.status !== 200 || !res.json) {
    skip(`${entryName} (${probe}): unusable response (HTTP ${res.status})`);
    rows.push({ entry: entryName, probe, result: 'SKIP', ageDays: null });
    return;
  }
  judge(res.json);
}

// Rule 1: visibility + archived, for every entry with a github.com repo/link.
async function probeVisibility(entry, target, cache) {
  const key = `${target.owner}/${target.repo}`;
  const res = cache.has(key) ? cache.get(key) : await githubGet(`/repos/${key}`);
  cache.set(key, res);
  const probe = 'repo: visibility/archived';
  await runProbe(entry.name, probe, key, res, (json) => {
    const ageDays = json.pushed_at ? daysSince(json.pushed_at) : null;
    const problems = [];
    if (json.visibility !== 'public') problems.push(`visibility=${json.visibility}`);
    if (json.archived) problems.push('archived=true');
    if (problems.length) {
      fail(`${entry.name} (${probe}): ${problems.join(', ')} (${key})`);
      rows.push({ entry: entry.name, probe, result: 'BREACH', ageDays });
    } else {
      ok(`${entry.name} (${probe}): public, not archived (${key})`);
      rows.push({ entry: entry.name, probe, result: 'PASS', ageDays });
    }
  });
}

// Rule 2: latest release carries >=1 asset, for every entry with `download`.
async function probeReleaseAssets(entry, target) {
  const key = `${target.owner}/${target.repo}`;
  const res = await githubGet(`/repos/${key}/releases/latest`);
  const probe = 'release: assets>=1';
  await runProbe(entry.name, probe, key, res, (json) => {
    const count = Array.isArray(json.assets) ? json.assets.length : 0;
    if (count < 1) {
      fail(`${entry.name} (${probe}): latest release ${json.tag_name || '?'} has 0 assets (${key})`);
      rows.push({ entry: entry.name, probe, result: 'BREACH', ageDays: null });
    } else {
      ok(`${entry.name} (${probe}): ${count} asset(s) on ${json.tag_name || '?'} (${key})`);
      rows.push({ entry: entry.name, probe, result: 'PASS', ageDays: null });
    }
  });
}

// Rule 3: license.spdx_id still matches what the page claims.
async function probeLicense(claim, cache) {
  const key = `${claim.owner}/${claim.repo}`;
  const res = cache.has(key) ? cache.get(key) : await githubGet(`/repos/${key}`);
  cache.set(key, res);
  const probe = `license: ${claim.spdx}`;
  await runProbe(claim.page, probe, key, res, (json) => {
    const spdx = json.license && json.license.spdx_id;
    if (spdx !== claim.spdx) {
      fail(`${claim.page} (${probe}): page claims ${claim.spdx}, live license.spdx_id is "${spdx}" (${key})`);
      rows.push({ entry: claim.page, probe, result: 'BREACH', ageDays: null });
    } else {
      ok(`${claim.page} (${probe}): live license matches the page (${key})`);
      rows.push({ entry: claim.page, probe, result: 'PASS', ageDays: null });
    }
  });
}

function printTable() {
  const headers = ['entry', 'probe', 'result', 'pushed_at age (d)'];
  const data = rows.map((r) => [r.entry, r.probe, r.result, r.ageDays == null ? '-' : String(r.ageDays)]);
  const widths = headers.map((h, i) => Math.max(h.length, ...data.map((d) => d[i].length)));
  const line = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join('  ');
  process.stdout.write(`\n${line(headers)}\n${widths.map((w) => '-'.repeat(w)).join('  ')}\n`);
  for (const d of data) process.stdout.write(`${line(d)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let systems;
  try {
    systems = JSON.parse(fs.readFileSync(SYSTEMS_FILE, 'utf8'));
  } catch (err) {
    fail(`cannot read/parse data/systems.json: ${err.message}`);
    process.exit(1);
  }
  const entries = systems.systems || [];
  const cache = new Map();

  for (const entry of entries) {
    const target = extractRepo(entry.repo) || extractRepo(entry.link);
    if (target) await probeVisibility(entry, target, cache);
  }
  for (const entry of entries.filter((e) => e.download)) {
    const target = extractRepo(entry.download);
    if (target) await probeReleaseAssets(entry, target);
  }
  for (const claim of LICENSE_CLAIMS) {
    await probeLicense(claim, cache);
  }

  printTable();

  const ages = rows.map((r) => r.ageDays).filter((a) => a != null);
  if (ages.length) {
    const maxAge = Math.max(...ages);
    process.stdout.write(`\nstaleness: max pushed_at age across roster = ${maxAge}d`
      + `${maxAge > 60 ? ' (info only — exceeds 60d, never a failure)' : ''}\n`);
  }

  const breaches = rows.filter((r) => r.result === 'BREACH').length;
  const skipped = rows.filter((r) => r.result === 'SKIP').length;
  process.stdout.write(`\nverify-claims: ${rows.length} probes — ${rows.length - breaches - skipped} pass, `
    + `${breaches} breach, ${skipped} skip.\n`);

  process.exit(args.strict && breaches > 0 ? 1 : 0);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
