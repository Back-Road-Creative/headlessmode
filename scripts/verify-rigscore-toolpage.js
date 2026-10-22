#!/usr/bin/env node
/**
 * Verify the rigscore tool page's check table against the authoritative
 * weights — now sourced from data/rigscore.json.
 *
 * The E2 rewrite moved the check table out of hand-typed markdown in
 * content/docs.md and into a Hugo shortcode that renders every row from
 * data/rigscore.json (Site.Data.rigscore.checks). So this gate verifies THAT
 * data file (the single source the tool page renders from) instead of parsing
 * the markdown table that no longer exists. Checks:
 *
 *   1. checkCount === checks[].length
 *   2. advisoryCount === number of zero-weight checks
 *   3. scored weights sum to exactly 100
 *   4. (with --version, online) the weight multiset matches the WEIGHTS map in
 *      src/constants.js from the tagged product release. A network failure
 *      degrades to a note (structural checks still gate); a real mismatch
 *      fails.
 *
 * Failures print a structured `FAIL:` line and exit non-zero — never an
 * uncaught throw / raw stack trace.
 *
 * Usage:
 *   node verify-rigscore-toolpage.js                 # structural self-consistency
 *   node verify-rigscore-toolpage.js --version 2.1.0 # also cross-check product source
 *
 * Exit 0 = verified. Exit 1 = mismatch (prints what's wrong).
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, '..', 'data', 'rigscore.json');

let failed = false;
const fail = (msg) => { process.stderr.write(`FAIL: ${msg}\n`); failed = true; };
const ok = (msg) => { process.stdout.write(`OK: ${msg}\n`); };
const note = (msg) => { process.stdout.write(`note: ${msg}\n`); };

function parseArgs(argv) {
  const args = { version: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--version' && i + 1 < argv.length) args.version = argv[++i];
  }
  return args;
}

function fetchText(hostname, urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { hostname, path: urlPath, headers: { 'User-Agent': 'rigscore-toolpage-verify' } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const loc = new URL(res.headers.location);
          fetchText(loc.hostname, loc.pathname + loc.search).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} fetching ${urlPath}`)); return; }
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data));
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parseWeightsFromSource(constantsJs) {
  const match = constantsJs.match(/export const WEIGHTS\s*=\s*\{([^}]+)\}/s);
  if (!match) throw new Error('could not find WEIGHTS export in constants.js');
  const weights = {};
  for (const [, id, weight] of match[1].matchAll(/'([^']+)':\s*(\d+)/g)) {
    weights[id] = parseInt(weight, 10);
  }
  if (Object.keys(weights).length === 0) throw new Error('parsed WEIGHTS map is empty');
  return weights;
}

// --- main ---
const args = parseArgs(process.argv);

let data;
try {
  data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (err) {
  fail(`cannot read/parse data/rigscore.json: ${err.message}`);
  process.exit(1);
}
if (!Array.isArray(data.checks) || data.checks.length === 0) {
  fail('data.checks is empty or not an array — nothing to verify');
  process.exit(1);
}

// --- Check 1: check count ---
if (data.checkCount !== data.checks.length) {
  fail(`check count mismatch: checkCount=${data.checkCount}, checks[]=${data.checks.length}`);
} else {
  ok(`check count: ${data.checkCount}`);
}

// --- Check 2: advisory count ---
const advisory = data.checks.filter((c) => (c.weight || 0) === 0).length;
if (data.advisoryCount !== advisory) {
  fail(`advisory count mismatch: advisoryCount=${data.advisoryCount}, zero-weight checks=${advisory}`);
} else {
  ok(`advisory checks: ${advisory}`);
}

// --- Check 3: scored weights sum to 100 ---
const total = data.checks.reduce((a, c) => a + (c.weight || 0), 0);
if (total !== 100) {
  fail(`total scored weight is ${total}, expected 100`);
} else {
  ok('total scored weight: 100');
}

// --- Check 4: weight multiset vs tagged product source (online, opt-in) ---
if (args.version) {
  let sourceWeights;
  try {
    const constantsJs = await fetchText(
      'raw.githubusercontent.com',
      `/Back-Road-Creative/rigscore/v${args.version}/src/constants.js`,
    );
    sourceWeights = parseWeightsFromSource(constantsJs);
  } catch (err) {
    note(`could not fetch constants.js for v${args.version} (${err.message}); source cross-check skipped`);
    sourceWeights = null;
  }
  if (sourceWeights) {
    // Compare the SCORED distribution on both sides. The data side has always
    // filtered zeros; the source side did not, so once advisory checks carried
    // an explicit weight of 0 in constants.js the two lists could never match
    // (13 scored values vs 28 with fifteen zeros appended). That mismatch, not
    // any real drift, is what blocked the v2.2.0 release from 2026-07-27.
    const sourceValues = Object.values(sourceWeights).filter((w) => w > 0)
      .sort((a, b) => b - a).join(',');
    const dataValues = data.checks.map((c) => c.weight || 0).filter((w) => w > 0)
      .sort((a, b) => b - a).join(',');
    if (sourceValues !== dataValues) {
      fail(`weight distribution mismatch vs v${args.version} source:\n  data:   [${dataValues}]\n  source: [${sourceValues}]`);
    } else {
      ok(`weight distribution matches product source v${args.version}: [${dataValues}]`);
    }
  }
}

if (failed) {
  process.stderr.write('\nTool page data is out of sync — update data/rigscore.json (product release job re-renders it).\n');
  process.exit(1);
}
process.stdout.write('\nAll checks pass — tool page data (data/rigscore.json) is verified.\n');
