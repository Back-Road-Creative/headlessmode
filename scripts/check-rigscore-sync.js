#!/usr/bin/env node
/**
 * Validate the rigscore tool page's advertised version.
 *
 * The E2 rewrite made the tool page data-driven: the rigscore page
 * (content/rigscore.md, manual included since the boutique redesign) renders
 * the version, counts and check tables
 * from data/rigscore.json via Hugo shortcodes, so there is no longer a
 * hand-typed "rigscore vX.Y.Z" literal in the markdown to parse. The site's
 * advertised version is therefore data/rigscore.json's `version` field. This
 * gate checks it is semver-shaped and (with --version / --online) is the
 * version we expect it to be. The release-post existence check retired with
 * the /releases/ section (hybrid redesign) — release notes live on the
 * product's GitHub releases page now.
 *
 * Failures print a structured `FAIL:` line and set a non-zero exit — never an
 * uncaught throw / raw stack trace.
 *
 * Usage:
 *   node check-rigscore-sync.js                 # offline self-consistency (default)
 *   node check-rigscore-sync.js --version 2.1.0 # also assert data.version === arg
 *   node check-rigscore-sync.js --online        # also compare vs latest GitHub release
 *
 * Exit 0 = in sync. Exit 1 = out of sync (prints what's wrong).
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
  const args = { online: false, version: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--version' && i + 1 < argv.length) args.version = argv[++i];
    else if (argv[i] === '--online') args.online = true;
  }
  return args;
}

function getLatestGitHubRelease() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/Back-Road-Creative/rigscore/releases/latest',
      headers: { 'User-Agent': 'rigscore-sync-check' },
    };
    const req = https.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const tag = JSON.parse(data).tag_name;
          if (!tag) throw new Error('No tag_name in response');
          resolve(tag.replace(/^v/, '')); // v2.1.0 -> 2.1.0
        } catch {
          reject(new Error(`could not parse GitHub response: ${data.slice(0, 120)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('GitHub API timeout')); });
  });
}

// --- main ---
const args = parseArgs(process.argv);

// The single source of the tool page's version is data/rigscore.json.
let data;
try {
  data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (err) {
  fail(`cannot read/parse data/rigscore.json: ${err.message}`);
  process.exit(1);
}
const pageVersion = data.version;
if (!pageVersion || !/^\d+\.\d+\.\d+/.test(String(pageVersion))) {
  fail(`data/rigscore.json version "${pageVersion}" is missing or not semver-shaped`);
  process.exit(1);
}

// Determine the version to check against. --version wins; --online fetches the
// latest GitHub release (best-effort, degrades to offline self-consistency);
// otherwise we self-check the data file alone.
let targetVersion = args.version;
if (!targetVersion && args.online) {
  targetVersion = await getLatestGitHubRelease().catch((err) => {
    note(`could not fetch latest GitHub release (${err.message}); offline self-consistency only`);
    return null;
  });
}
if (!targetVersion) targetVersion = pageVersion; // offline default: self-consistency

if (pageVersion !== targetVersion) {
  fail(`tool page (data/rigscore.json) shows v${pageVersion}, expected v${targetVersion}`);
  process.stderr.write(`      Update data/rigscore.json to v${targetVersion} (product release job re-renders it).\n`);
} else {
  ok(`tool page version v${pageVersion} matches expected release`);
}

process.exit(failed ? 1 : 0);
