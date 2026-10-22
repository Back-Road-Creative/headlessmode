#!/usr/bin/env node
/**
 * verify-facts.js — data-driven verification gates for the rigscore site.
 *
 * Successor gate to verify-rigscore-toolpage.js (which parsed the rigscore
 * manual's check table by hand). Now that E2 renders every product fact from
 * data/rigscore.json via Hugo shortcodes, the site no longer carries a
 * hand-maintained check table to parse — so this gate protects the DATA and
 * the last hand-written surfaces instead. Nine checks, (a) through (i):
 *
 *   (a) data/rigscore.json is internally consistent, and — with --online —
 *       matches the rigscore-facts.json asset on the latest product release.
 *   (b) hardcoded-fact linter: no check-count- or current-version-shaped
 *       literal may re-enter content/ or themes/ by hand, outside the one
 *       place where a literal is legitimate — the front-matter description
 *       line shortcodes cannot reach. It also skips content/releases/, which
 *       the hybrid redesign deleted; that skip can no longer fire and is
 *       described where it sits. The whole rigscore documentation set —
 *       including the verify recipe, which renders its tag and tarball through
 *       shortcodes — now lives on content/rigscore.md (REFERENCE_MD/DOCS_MD).
 *   (c) flag parity: every flag documented on the rigscore page
 *       (content/rigscore.md) is a real product flag (in cliFlags), and
 *       every product flag is documented on the site — with an explicit,
 *       auditable allow-list for the known exceptions in each direction.
 *
 *   (d) banned third-party product-name gate: no competitor / third-party tool
 *       name may re-enter the marketing/docs surface (content/ + themes/, with
 *       no path skipped at all — unlike (b) and (f), which each carry one).
 *       Word-boundary, case-insensitive, with an allow-list for the real
 *       `codeql-action` workflow token, AI client names, and governance
 *       filenames. On a hit it exits non-zero with the message
 *       "no third-party product names on the site". Robust-by-construction is
 *       unavailable for hand-authored prose, so this is the upstream recurrence
 *       gate that keeps a scrubbed mention from silently returning.
 *
 *   (e) $names coverage: every data/rigscore.json check id must have a curated
 *       label in the check-table shortcode's `$names` map (read-only). A new or
 *       renamed id with no entry renders as a humanize fallback — this gate
 *       fails upstream so the label is added on purpose, killing the
 *       rename/label-drift class by construction.
 *
 *   (f) product-count truth: a plural product count written by hand — in
 *       content/, themes/, layouts/ or static/ — must equal the number of
 *       tier="product" entries in data/systems.json. "Two private products"
 *       survived in five hand-written places while the ledger already held
 *       four. Unlike rule (b) this does NOT ban the literal: static/llms.txt is
 *       never rendered by Hugo and no shortcode counts systems, so a literal is
 *       sometimes the only way to write the number. It reads the number instead
 *       and requires it to match the data. Its one skip — content/releases/,
 *       where a dated post records what was true on its date — is dead for the
 *       same reason (b)'s is: the hybrid redesign deleted that directory.
 *
 *   (g) rigscore-manual arithmetic literals: two hand-written weight subtotals
 *       in content/rigscore.md ("48 of the 100 points" for the named
 *       AI-specific checks, "24 of the 100 scoring points" for governance docs +
 *       coherence) are recomputed from data/rigscore.json's checks[] weights
 *       — always derivable, so always exact. The dogfooding block's three
 *       numbers (self-score, applicable weight, --fail-under) are NOT
 *       derivable from any data file — they are rigscore's own measured
 *       self-scan result, read by a human off a real run — so they are pinned
 *       to named constants instead (source noted in a comment on each); an
 *       edit to one number without the others, or without updating the
 *       constants, fails loudly instead of silently drifting.
 *
 *   (h) shipped:null ⇒ repo gate: every non-product data/systems.json entry
 *       with "shipped": null must carry a "repo" — an oss tool row without one
 *       falls through every action branch and renders no source action at all
 *       (themes/headlessmode/layouts/index.html). Products are exempt: the
 *       system sheet appends "— source public" to the undated status line only
 *       when the entry carries a repo (partials/system-sheet.html), so an
 *       undated closed-source product (waypost) renders an honest engagement
 *       line instead of an unbacked claim. Upstream of the render either way.
 *
 *   (i) product access gate: every data/systems.json entry with
 *       tier="product" must carry an "access" key valued "public" or
 *       "engagement" — the data presentation derives the acquisition path
 *       from — and no other tier may carry the key at all, because nothing
 *       reads it there. get-system.html and index.html derive the
 *       acquisition CTA from this key, so the gate keeps the ledger
 *       complete for the templates that read it.
 *
 *   (j) product-page version literals ⊆ the release ledger: every token
 *       shaped like a semver with a leading "v" (`v1.9.0`) in a product's
 *       own content page (content/<slug>.md, the tier="product" pages
 *       with an image directory or a demo) must equal one of that product's
 *       own data/releases/<slug>.json facts — its release "version" (v-
 *       prefixed), its "demo.source", or its "media_source". A page that
 *       names a version outside that set is naming a stale or invented one;
 *       this gate does not rewrite the prose to hide the mismatch, it fails
 *       so the honest fix is a data change (bump the release ledger or the
 *       page) rather than a silent edit.
 *
 * Offline-safe: (a)'s cross-repo compare only runs under --online and degrades
 * to the structural self-consistency check when the asset is not fetchable.
 * The linter (b), parity (c), banned-name gate (d), $names coverage (e),
 * product-count truth (f), the rigscore-manual arithmetic gate (g), the
 * shipped:null repo gate (h), the product access gate (i) and the product
 * version-literal gate (j) are always deterministic and offline.
 *
 * Usage:
 *   node scripts/verify-facts.js                 # structural + linter + parity + banned-name gate
 *   node scripts/verify-facts.js --version x.y.z # also assert data.version === arg
 *   node scripts/verify-facts.js --online        # also compare vs release asset
 *   node scripts/verify-facts.js --self-test     # prove the banned-name, $names and product-count rules flag/pass correctly
 *
 * Exit 0 = all gates pass. Exit 1 = at least one failure (prints what's wrong).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data', 'rigscore.json');
const SYSTEMS_FILE = path.join(ROOT, 'data', 'systems.json');
const RELEASES_DIR = path.join(ROOT, 'data', 'releases');
// The tier="product" content pages this gate checks version literals
// on. Not derived from systems.json's tier field here because rule (j) needs
// each page's own data/releases/<slug>.json alongside it, and that ledger
// (scripts/test_release_data.py) already gates the roster/ledger pairing —
// this list mirrors PRODUCT_SLUGS in that test and scripts/test_media_manifest.py.
const PRODUCT_SLUGS = ['band-coach', 'driftless', 'grant-platform', 'waypost', 'quiet-corners', 'framegrade'];
// The boutique redesign folded the whole rigscore documentation set — manual,
// command reference, supported clients, verify recipe — into the product page
// at content/rigscore.md (its "## Documentation" section), and the /docs/ hub
// is gone. Both fact surfaces below therefore point at that one file: the
// flag-parity rules (c) now scan the merged page (its verify recipe uses gh
// CLI flags, allow-listed in KNOWN_NON_CLI_FLAGS below), and the arithmetic
// rules (g) find their claims in the same file.
const REFERENCE_MD = path.join(ROOT, 'content', 'rigscore.md');
const DOCS_MD = path.join(ROOT, 'content', 'rigscore.md');
const CHECK_TABLE_SHORTCODE = path.join(ROOT, 'layouts', 'shortcodes', 'rigscore-check-table.html');

// ---- (b) linter whitelist -------------------------------------------------
// The ONE manual fact surface E2 could not convert: the rigscore manual's
// front-matter `description` would hold a literal count like "28 checks — 13
// scored plus 15 advisory" if the release job ever wrote one there, because
// Hugo shortcodes do not run inside front matter. The release job (E3)
// patches this single line; the linter whitelists exactly it.
const COUNT_WHITELIST_FRONTMATTER = [
  { file: 'content/rigscore.md', field: 'description' },
];
// "SARIF v2.1.0" is the OASIS SARIF spec version, a coincidental collision
// with rigscore's version this release — never a rigscore version literal.
const VERSION_CONTEXT_SKIP = /SARIF\s*$/i;

// ---- (c) flag-parity allow-lists ------------------------------------------
// Flag tokens that legitimately appear in the merged rigscore page's prose
// but are NOT top-level scan flags the facts emitter tracks: `init`
// subcommand options, a Docker run flag in the docker-image example, and the
// gh CLI flags in the folded verify recipe (--repo/--pattern/--owner/--jq).
const KNOWN_NON_CLI_FLAGS = new Set([
  '--force', '--list-packs', '--rm',
  '--repo', '--pattern', '--owner', '--jq', // gh CLI, verify recipe
  '-e', '-u',                               // node -e / sort -u, verify recipe
  '-p',                                     // the agent CLI's own print flag in `claude -p` (--semantic default), not a rigscore flag
]);
// Product flags the docs site intentionally omits. Standard/cosmetic flags,
// plus two pre-existing content gaps (--semantic, --cta/--no-cta) tracked
// separately. Any NEW undocumented flag must be added here on purpose or
// documented — that is the drift trip-wire.
const UNDOCUMENTED_FLAG_ALLOWLIST = new Set([
  '--help', '-h', '--version', '-y', // standard
  '--no-color', '--verbose',          // cosmetic
  '--cta', '--no-cta',                // call-to-action toggles (site gap)
  '--semantic',                       // feature flag undocumented on site (gap)
]);

// ---- reporting ------------------------------------------------------------
let failed = false;
const fail = (msg) => { process.stderr.write(`FAIL: ${msg}\n`); failed = true; };
const ok = (msg) => { process.stdout.write(`OK: ${msg}\n`); };
const note = (msg) => { process.stdout.write(`note: ${msg}\n`); };

function parseArgs(argv) {
  const args = { online: false, version: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--online') args.online = true;
    else if (argv[i] === '--version' && i + 1 < argv.length) args.version = argv[++i];
  }
  return args;
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function walk(dir, exts, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

// ---- (e) $names coverage helpers ------------------------------------------
// The check-table shortcode (layouts/shortcodes/rigscore-check-table.html)
// carries a `$names := dict "<id>" "Display Name" ...` map that gives each
// check id its curated human label; an id with no entry silently renders as
// `humanize .id` — the exact rename/label-drift class this gate kills by
// construction. parseNamesKeys pulls the KEYS (the ids) out of that dict, and
// namesCoverageGaps returns any data-file check id missing a curated name.
function parseNamesKeys(shortcodeText) {
  // Isolate the `$names := dict ... -}}` block, then read its string literals.
  // In a Hugo `dict` call the literals alternate key, value, key, value…, so
  // the keys are the even-indexed ones.
  const block = shortcodeText.match(/\$names\s*:=\s*dict([\s\S]*?)-?\}\}/);
  if (!block) return [];
  const literals = [...block[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  return literals.filter((_, i) => i % 2 === 0);
}
function namesCoverageGaps(checkIds, nameKeys) {
  const named = new Set(nameKeys);
  return checkIds.filter((id) => !named.has(id));
}

const args = parseArgs(process.argv);

// ---- (d) banned third-party product-name gate -----------------------------
// Third-party product names, word-boundary + case-insensitive. `Socket.dev`
// keeps its literal dot (bare "socket" is Docker-socket / WebSocket noise, not
// a brand); `Cisco` is banned as a brand (Cisco AI Defense / mcp-scanner /
// skill-scanner / DefenseClaw); bare `CodeQL` is banned, but the real workflow
// token `codeql-action` is allow-listed below.
const BANNED_PATTERNS = [
  /\bSnyk\b/i,
  /\bSemgrep\b/i,
  /\bAgentAuditKit\b/i,
  /\bCisco\b/i,
  /\bSocket\.dev\b/i,
  /\bgitleaks\b/i,
  /\btrufflehog\b/i,
  /\bShellCheck\b/i,
  /\bTrivy\b/i,
  /\bosv-scanner\b/i,
  /\bPrisma AIRS\b/i,
  /\bModelScan\b/i,
  /\bCodeQL\b/i,
];
// Substrings that must NEVER be flagged, even when a banned pattern would match
// inside them. Blanked out of each line before the scan, so e.g.
// `github/codeql-action/upload-sarif` never trips the bare-CodeQL rule, and AI
// *client* names / governance filenames are always safe.
const BANNED_ALLOWLIST = [
  'codeql-action',
  'CLAUDE.md', 'AGENTS.md',
  'Claude', 'Cursor', 'Gemini', 'Codex', 'opencode', 'Copilot',
];
function bannedHitsInLine(line) {
  let scrub = line;
  for (const allow of BANNED_ALLOWLIST) {
    scrub = scrub.replace(new RegExp(escapeRegExp(allow), 'gi'), ' ');
  }
  return BANNED_PATTERNS.filter((re) => re.test(scrub)).map((re) => re.source);
}

// ---- (f) product-count helpers --------------------------------------------
// How many products this studio has is data/systems.json's answer, not prose's.
// Spelled counts matter: the literal that shipped was "two private products",
// which a digits-only pattern never sees. one–twelve covers everything a
// portfolio of this size can honestly claim; past twelve, write the digit.
const NUMBER_WORDS = new Map([
  ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6],
  ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10], ['eleven', 11], ['twelve', 12],
]);
const COUNT_TOKEN = `(?:\\d{1,3}|${[...NUMBER_WORDS.keys()].join('|')})`;
// Function words that make a count PARTIAL: "two of the products" says two OF
// them, not that there are two. Never read as an adjective, so such a phrase
// is not a claim about the ledger and is not checked against it.
const PARTITIVE = '(?:of|the|a|an|these|those|our|its|their|all|and|or)';
const PRODUCT_COUNT_RES = [
  // "two private products", "4 products": a count, at most one plain adjective,
  // then the PLURAL noun. Plural-only by design — English "one product"
  // ("when the site narrowed to one product", content/work.md) is idiom about
  // focus, not a portfolio cardinality, and no grammar produces "one products".
  new RegExp(`\\b(${COUNT_TOKEN})\\s+(?:(?!${PARTITIVE}\\b)[A-Za-z][A-Za-z-]*\\s+)?products\\b`, 'gi'),
  // "**Products.** Two, both private." — the label-then-count form about.md
  // used, where the noun comes first and no noun follows the number at all.
  // Anchored to a bold or heading label so ordinary prose ("the products. 90
  // days later…") cannot trip it.
  new RegExp(`(?:\\*\\*|#{1,6}\\s*)products\\b[.:*_\\s]{1,6}(${COUNT_TOKEN})\\b`, 'gi'),
];
// Every product count a line claims, as numbers. Pure and line-scoped, so the
// self-test below can prove both what it catches and what it leaves alone.
function productCountClaims(line) {
  const claims = [];
  for (const re of PRODUCT_COUNT_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
      const token = m[1].toLowerCase();
      const claimed = NUMBER_WORDS.get(token) ?? Number(token);
      // One sentence can match both forms ("**Products.** Two products…").
      // That is one claim, reported once, not two failures to chase.
      if (claims.some((c) => c.claimed === claimed)) continue;
      claims.push({ claimed, text: m[0].trim() });
    }
  }
  return claims;
}

// Deterministic, offline self-test of the banned-name gate: a planted banned
// string must be flagged; clean text with allow-listed tokens must pass.
if (process.argv.includes('--self-test')) {
  let pass = true;
  const assert = (cond, msg) => {
    if (cond) { process.stdout.write(`self-test OK: ${msg}\n`); }
    else { process.stderr.write(`self-test FAIL: ${msg}\n`); pass = false; }
  };
  assert(bannedHitsInLine('We benchmarked against Snyk and Semgrep here.').length === 2,
    'planted "Snyk"+"Semgrep" line is flagged');
  assert(bannedHitsInLine('runs a CodeQL analysis pass').length === 1,
    'bare "CodeQL" is flagged');
  assert(bannedHitsInLine('uploaded via `github/codeql-action/upload-sarif`; see CLAUDE.md and the Claude/Cursor clients').length === 0,
    'clean text with codeql-action + CLAUDE.md + client names passes');
  assert(bannedHitsInLine('the Docker socket and a WebSocket connection').length === 0,
    'bare "socket" (docker/websocket) is NOT flagged');
  // $names coverage helpers (gate e)
  const sampleShortcode = '{{- $names := dict\n  "mcp-config" "MCP server configuration"\n  "coherence" "Cross-config coherence"\n-}}\n<table></table>';
  assert(parseNamesKeys(sampleShortcode).join(',') === 'mcp-config,coherence',
    'parseNamesKeys pulls the dict KEYS (ids), not the display names');
  assert(namesCoverageGaps(['mcp-config', 'coherence'], parseNamesKeys(sampleShortcode)).length === 0,
    'fully-named id set reports zero coverage gaps');
  assert(namesCoverageGaps(['mcp-config', 'new-check'], parseNamesKeys(sampleShortcode)).join(',') === 'new-check',
    'an id with no $names entry is flagged as a coverage gap');
  // product-count helpers (gate f) — what it catches…
  assert(productCountClaims('alongside two private products and long-form writing')[0]?.claimed === 2,
    'a spelled count with an adjective ("two private products") reads as 2');
  assert(productCountClaims('**Products.** Two, both private.')[0]?.claimed === 2,
    'the label-then-count form ("**Products.** Two") reads as 2');
  assert(productCountClaims('and 4 products on top')[0]?.claimed === 4,
    'a digit count ("4 products") reads as 4');
  // …and what it must leave alone.
  assert(productCountClaims('when the site narrowed to one product.').length === 0,
    'singular "one product" (focus idiom, content/work.md) is not a portfolio count');
  assert(productCountClaims('Two tools, open sourced together, treat agent config').length === 0,
    'a count of tools is not a count of products');
  assert(productCountClaims('Over about 90 days I built roughly 20 projects').length === 0,
    'a count of projects is not a count of products');
  assert(productCountClaims('two of the products have shipped so far').length === 0,
    'a partitive count ("two of the products") claims no total');
  process.stdout.write(pass ? '\nself-test: PASS (banned-name + $names-coverage + product-count gates flag and pass correctly).\n'
                            : '\nself-test: FAIL.\n');
  process.exit(pass ? 0 : 1);
}

// Load data file
let data;
try {
  data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (err) {
  fail(`cannot read/parse data/rigscore.json: ${err.message}`);
  process.exit(1);
}

// --- (a) data/rigscore.json ≡ release facts --------------------------------
// Structural self-consistency — always runs, fully offline.
function structuralChecks(d) {
  const required = ['version', 'checkCount', 'scoredCount', 'advisoryCount',
    'enforcementGrades', 'checks', 'cliFlags', 'frameworks', 'exitCodes'];
  for (const k of required) {
    if (!(k in d)) fail(`data/rigscore.json missing required field: ${k}`);
  }
  if (!Array.isArray(d.checks) || d.checks.length === 0) {
    fail('data.checks is empty or not an array');
    return;
  }
  if (!/^\d+\.\d+\.\d+/.test(String(d.version))) {
    fail(`data.version "${d.version}" is not semver-shaped`);
  }
  const scored = d.checks.filter((c) => c.weight > 0).length;
  const advisory = d.checks.filter((c) => c.weight === 0).length;
  if (d.checkCount !== d.checks.length) {
    fail(`checkCount ${d.checkCount} != checks.length ${d.checks.length}`);
  } else { ok(`checkCount matches checks[] length: ${d.checkCount}`); }
  if (d.scoredCount !== scored) fail(`scoredCount ${d.scoredCount} != scored weights ${scored}`);
  else ok(`scoredCount matches weighted checks: ${scored}`);
  if (d.advisoryCount !== advisory) fail(`advisoryCount ${d.advisoryCount} != zero-weight ${advisory}`);
  else ok(`advisoryCount matches zero-weight checks: ${advisory}`);
  if (d.checkCount !== d.scoredCount + d.advisoryCount) {
    fail(`checkCount ${d.checkCount} != scored ${d.scoredCount} + advisory ${d.advisoryCount}`);
  }
  const gradeSum = Object.values(d.enforcementGrades).reduce((a, b) => a + b, 0);
  if (gradeSum !== d.checkCount) fail(`enforcementGrades sum ${gradeSum} != checkCount ${d.checkCount}`);
  else ok(`enforcementGrades sum to checkCount: ${gradeSum}`);
  const weightSum = d.checks.reduce((a, c) => a + (c.weight || 0), 0);
  if (weightSum !== 100) fail(`scored weights sum to ${weightSum}, expected 100`);
  else ok('scored weights sum to 100');
}
structuralChecks(data);

// --- (e) $names coverage: every check id has a curated label ---------------
// Robust-by-construction guard against rename/label drift: if a new or renamed
// check id lands in data/rigscore.json without a matching $names entry in the
// check-table shortcode, it renders as a humanized fallback — this fails the
// gate upstream so the label is added on purpose, not discovered on the live
// site. Reads the shortcode; never edits it.
try {
  const shortcode = fs.readFileSync(CHECK_TABLE_SHORTCODE, 'utf8');
  const nameKeys = parseNamesKeys(shortcode);
  if (nameKeys.length === 0) {
    fail('$names map not found in layouts/shortcodes/rigscore-check-table.html');
  } else {
    const gaps = namesCoverageGaps(data.checks.map((c) => c.id), nameKeys);
    if (gaps.length) {
      fail(`check ids missing a curated $names label in the check-table shortcode: ${gaps.sort().join(', ')}`);
    } else {
      ok(`$names covers all ${data.checks.length} check ids (no humanize fallback)`);
    }
  }
} catch (err) {
  fail(`cannot read check-table shortcode: ${err.message}`);
}

if (args.version) {
  if (String(data.version) !== String(args.version)) {
    fail(`data.version "${data.version}" != release version "${args.version}"`);
  } else { ok(`data.version matches release: ${args.version}`); }
}

// Cross-repo compare — opt-in, best-effort, never a flaky failure.
function fetchReleaseFacts() {
  try {
    const url = execFileSync('gh', ['api',
      'repos/Back-Road-Creative/rigscore/releases/latest',
      '--jq', '.assets[] | select(.name=="rigscore-facts.json") | .url'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!url) return null;
    const body = execFileSync('gh', ['api', url, '-H', 'Accept: application/octet-stream'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(body);
  } catch {
    return null;
  }
}

if (args.online) {
  const remote = fetchReleaseFacts();
  if (!remote) {
    note('release asset not fetchable — structural self-consistency only');
  } else {
    const scalar = ['version', 'date', 'checkCount', 'scoredCount', 'advisoryCount'];
    for (const k of scalar) {
      if (String(remote[k]) !== String(data[k])) {
        fail(`release asset ${k} "${remote[k]}" != data "${data[k]}"`);
      }
    }
    const shape = (o) => JSON.stringify(o);
    if (shape(remote.enforcementGrades) !== shape(data.enforcementGrades)) {
      fail('enforcementGrades differ between release asset and data');
    }
    const ids = (arr) => (arr || []).map((c) => `${c.id}:${c.weight}`).sort().join(',');
    if (ids(remote.checks) !== ids(data.checks)) fail('checks[] (id:weight) differ from release asset');
    if ((remote.cliFlags || []).slice().sort().join(',') !== data.cliFlags.slice().sort().join(',')) {
      fail('cliFlags differ from release asset');
    }
    if (!failed) ok('data/rigscore.json matches latest release rigscore-facts.json');
  }
}

// --- (b) hardcoded-fact linter over content/ + themes/ ---------------------
const COUNT_RE = /\b(\d{1,3})\s+(checks?|scored|advisory)\b/gi;
const VERSION_RE = new RegExp(`\\bv?${escapeRegExp(String(data.version))}\\b`, 'g');

function frontmatterRange(lines) {
  // returns [start, end] line indices (inclusive) of the leading --- block, or null
  if (lines[0]?.trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') return [0, i];
  return null;
}

function lintFile(absPath) {
  const rel = path.relative(ROOT, absPath).split(path.sep).join('/');
  const content = fs.readFileSync(absPath, 'utf8');
  const lines = content.split('\n');
  const fmRange = frontmatterRange(lines);
  const wl = COUNT_WHITELIST_FRONTMATTER.find((w) => w.file === rel);

  lines.forEach((line, idx) => {
    const inFrontmatter = fmRange && idx >= fmRange[0] && idx <= fmRange[1];
    // count rule
    if (COUNT_RE.test(line)) {
      const whitelisted = wl && inFrontmatter && new RegExp(`^\\s*${wl.field}\\s*:`).test(line);
      if (!whitelisted) fail(`hardcoded count in ${rel}:${idx + 1} → ${line.trim().slice(0, 90)}`);
    }
    COUNT_RE.lastIndex = 0;
    // version rule
    let m;
    VERSION_RE.lastIndex = 0;
    while ((m = VERSION_RE.exec(line)) !== null) {
      const before = line.slice(0, m.index);
      if (VERSION_CONTEXT_SKIP.test(before)) continue; // SARIF spec version
      const whitelisted = wl && inFrontmatter && new RegExp(`^\\s*${wl.field}\\s*:`).test(line);
      if (whitelisted) continue;
      fail(`hardcoded current-version literal "${m[0]}" in ${rel}:${idx + 1} — render via {{< rigscore-fact field="version" >}}`);
    }
  });
}

const scanRoots = [path.join(ROOT, 'content'), path.join(ROOT, 'themes')];
for (const root of scanRoots) {
  for (const f of walk(root, ['.md', '.html'])) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    // Dead skip: the hybrid redesign deleted content/releases/, so no scanned
    // path starts with it and this can never fire. It existed because a dated
    // release post names the version and counts it announces legitimately.
    if (rel.startsWith('content/releases/')) continue;
    lintFile(f);
  }
}
if (!failed) ok('hardcoded-fact linter clean (content/ + themes/ carry no manual counts/versions)');

// --- (d) banned third-party product-name gate over content/ + themes/ ------
// Scans the SAME roots as (b) and skips nothing. The skip (b) still carries is
// for content/releases/, which the hybrid redesign deleted; release prose had
// to stay nameless too (this is where bare "CodeQL" was removed).
let bannedClean = true;
for (const root of scanRoots) {
  for (const f of walk(root, ['.md', '.html'])) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      const hits = bannedHitsInLine(line);
      if (hits.length) {
        bannedClean = false;
        fail(`no third-party product names on the site — ${rel}:${idx + 1} names ${hits.join(', ')} → ${line.trim().slice(0, 90)}`);
      }
    });
  }
}
if (bannedClean) ok('no third-party product names on the site (content/ + themes/ nameless)');

// --- (f) product counts ≡ data/systems.json --------------------------------
// Wider roots than (b)/(d) on purpose: the five places that said "two private
// products" spanned the home template (themes/), content/ and static/llms.txt,
// which Hugo copies verbatim and no shortcode can reach. Roots that do not
// exist are dropped and the pass message names the ones actually scanned, so
// the gate's coverage is never wider than what it read.
const PRODUCT_SCAN_ROOTS = ['content', 'themes', 'layouts', 'static'];
// Dead skip, the twin of (b)'s: content/releases/ was deleted by the hybrid
// redesign, so no scanned path starts with it and the filter below can never
// fire. It existed because dated posts state what was true on their date — a
// release note counting the products of the time is a record, not drift, and
// flipping it to today's number would make it false.
const PRODUCT_COUNT_SKIP = ['content/releases/'];

let productCountClean = true;
let systems = null;
try {
  systems = JSON.parse(fs.readFileSync(SYSTEMS_FILE, 'utf8'));
} catch (err) {
  fail(`cannot read/parse data/systems.json: ${err.message}`);
  productCountClean = false;
}
if (systems && (!Array.isArray(systems.systems) || systems.systems.length === 0)) {
  fail('data/systems.json systems[] is empty or not an array — nothing to count product claims against');
  productCountClean = false;
  systems = null;
}
if (systems) {
  const expected = systems.systems.filter((s) => s.tier === 'product').length;
  const scanned = [];
  for (const name of PRODUCT_SCAN_ROOTS) {
    const root = path.join(ROOT, name);
    if (!fs.existsSync(root)) continue;
    scanned.push(`${name}/`);
    for (const f of walk(root, ['.md', '.html', '.txt'])) {
      const rel = path.relative(ROOT, f).split(path.sep).join('/');
      if (PRODUCT_COUNT_SKIP.some((p) => rel.startsWith(p))) continue;
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, idx) => {
        for (const { claimed, text } of productCountClaims(line)) {
          if (claimed === expected) continue;
          productCountClean = false;
          fail(`product count in ${rel}:${idx + 1} claims ${claimed}, data/systems.json holds ${expected} tier="product" entries → "${text}" — count from the data (Hugo: {{ len (where .Site.Data.systems.systems "tier" "product") }}) instead of typing a number`);
        }
      });
    }
  }
  if (productCountClean) {
    ok(`product counts agree with data/systems.json (${expected} products; scanned ${scanned.join(' + ')}, dated posts excluded)`);
  }
}

// --- (h) shipped:null ⇒ repo gate -------------------------------------------
// "source public" is only writable about something a stranger can go read.
// Products are exempt since the waypost listing: the system sheet appends
// "— source public" to the undated status line only when the entry carries a
// repo (partials/system-sheet.html), and the product stanza never states
// source provenance, so an undated closed-source product renders an honest
// engagement line. Every other tier still requires a repo, because an oss
// tool row without one falls through every action branch and renders no
// source action at all (themes/headlessmode/layouts/index.html).
// Reuses the systems[] above.
if (systems) {
  const missingRepo = systems.systems
    .filter((s) => s.shipped === null && !s.repo && s.tier !== 'product')
    .map((s) => s.name);
  if (missingRepo.length) {
    fail(`data/systems.json non-product entries with "shipped": null but no "repo": ${missingRepo.join(', ')} — write nothing about a tool until there is somewhere to read it`);
  } else {
    const undatedCount = systems.systems.filter((s) => s.shipped === null).length;
    ok(`every "shipped": null entry in data/systems.json carries a repo or is a product whose sheet drops the source-public claim (${undatedCount} available, undated)`);
  }
}

// --- (i) product access gate ------------------------------------------------
// Every tier="product" entry says how it is acquired: "public" (used directly
// in the browser — self-serve) or "engagement" (acquired through the studio
// via /contact/). Any other tier must omit the key — no template reads it
// there, so it could only mislead. Data-only today; the CTA derivation that
// will read it lands against a ledger this gate has already made complete.
// Reuses the systems[] above.
if (systems) {
  const KNOWN_ACCESS = new Set(['public', 'engagement']);
  const badAccess = systems.systems
    .filter((s) => (s.tier === 'product' ? !KNOWN_ACCESS.has(s.access) : 'access' in s))
    .map((s) => `${s.name} (tier: ${JSON.stringify(s.tier)}, access: ${JSON.stringify(s.access)})`);
  if (badAccess.length) {
    fail(`data/systems.json access gate — every tier="product" entry needs "access": "public"|"engagement" and no other tier may carry the key: ${badAccess.join(', ')}`);
  } else {
    const products = systems.systems.filter((s) => s.tier === 'product').length;
    ok(`every tier="product" entry carries a valid "access" and no other entry carries one (${products} products)`);
  }
}

// --- (c) reference.md flags ≡ cliFlags -------------------------------------
const refText = fs.readFileSync(REFERENCE_MD, 'utf8');
const docsText = fs.readFileSync(DOCS_MD, 'utf8');
const cliFlags = new Set(data.cliFlags);

// Extract flag tokens (--long and -x short), skip placeholders like --<pack>.
function extractFlags(text) {
  const set = new Set();
  for (const m of text.matchAll(/(?<![\w-])(--[a-zA-Z][a-zA-Z0-9-]*|-[a-zA-Z])(?![\w-])/g)) {
    set.add(m[1]);
  }
  return set;
}
const refFlags = extractFlags(refText);

// forward: every flag the rigscore page documents must be a real product flag
let fwdBad = [];
for (const f of refFlags) {
  if (!cliFlags.has(f) && !KNOWN_NON_CLI_FLAGS.has(f)) fwdBad.push(f);
}
if (fwdBad.length) fail(`rigscore page documents flags not in cliFlags: ${fwdBad.sort().join(', ')}`);
else ok(`rigscore page flags all real (${refFlags.size} tokens; ${KNOWN_NON_CLI_FLAGS.size} known non-CLI allow-listed)`);

// reverse: every product flag must be documented on the docs site
const documented = (f) => new RegExp(`(?<![\\w-])${escapeRegExp(f)}(?![\\w-])`).test(refText)
  || new RegExp(`(?<![\\w-])${escapeRegExp(f)}(?![\\w-])`).test(docsText);
let revBad = [];
for (const f of data.cliFlags) {
  if (!documented(f) && !UNDOCUMENTED_FLAG_ALLOWLIST.has(f)) revBad.push(f);
}
if (revBad.length) fail(`cliFlags undocumented on docs site (add to docs or the allow-list): ${revBad.sort().join(', ')}`);
else ok(`all cliFlags documented or explicitly allow-listed (${UNDOCUMENTED_FLAG_ALLOWLIST.size} intentional gaps)`);

// --- (g) rigscore-manual arithmetic literals --------------------------------
// Check ids named in "AI-specific checks (MCP, coherence, skill files,
// governance docs) hold N of the 100 points" — recomputed from
// data.checks[].weight, so this claim can never silently drift.
const AI_SPECIFIC_CHECK_IDS = ['mcp-config', 'coherence', 'skill-files', 'governance-docs'];
// Check ids named in "governance checks (governance docs + coherence, N of
// the 100 scoring points)" — same recomputation, smaller set.
const GOVERNANCE_KEYWORD_CHECK_IDS = ['governance-docs', 'coherence'];

// Dogfooding numbers: NOT derivable from data/rigscore.json — this is
// rigscore's own measured self-scan result (a real `npx
// github:Back-Road-Creative/rigscore .` run against the rigscore repo,
// read by a human), not a generated fact any data file holds. Pinned here
// so an edit to the manual's prose that drifts from the pinned value — or a
// re-scan that changes the real number without updating these — fails
// loudly instead of shipping quietly wrong.
const DOGFOOD_SELF_SCORE = 37; // rigscore's self-scan score, see comment above
const DOGFOOD_APPLICABLE_WEIGHT = 46; // weight of the ~10 checks that apply to an npm package, same self-scan
const DOGFOOD_CI_BUFFER = 7; // chosen safety margin below the self-score, not derived from any data file
const DOGFOOD_FAIL_UNDER = DOGFOOD_SELF_SCORE - DOGFOOD_CI_BUFFER; // --fail-under threshold the manual states

function sumCheckWeights(ids) {
  let sum = 0;
  for (const id of ids) {
    const check = data.checks.find((c) => c.id === id);
    if (!check) { fail(`rigscore-manual arithmetic rule: no check id "${id}" in data/rigscore.json`); continue; }
    sum += check.weight;
  }
  return sum;
}

function extractDocsNumber(re, label) {
  const m = docsText.match(re);
  if (!m) { fail(`rigscore-manual arithmetic rule: could not find ${label} in content/rigscore.md`); return null; }
  return Number(m[1]);
}

const aiSpecificClaim = extractDocsNumber(
  /AI-specific checks[^.]*?hold (\d+) of the 100 points/,
  '"hold N of the 100 points" (AI-specific checks)',
);
if (aiSpecificClaim !== null) {
  const expected = sumCheckWeights(AI_SPECIFIC_CHECK_IDS);
  if (aiSpecificClaim !== expected) {
    fail(`rigscore manual "hold ${aiSpecificClaim} of the 100 points" != recomputed weight sum ${expected} for ${AI_SPECIFIC_CHECK_IDS.join(', ')}`);
  } else {
    ok(`rigscore manual AI-specific-checks weight claim matches data/rigscore.json: ${expected}`);
  }
}

const governanceClaim = extractDocsNumber(
  /governance docs \+ coherence, (\d+) of the 100 scoring points/,
  '"governance docs + coherence, N of the 100 scoring points"',
);
if (governanceClaim !== null) {
  const expected = sumCheckWeights(GOVERNANCE_KEYWORD_CHECK_IDS);
  if (governanceClaim !== expected) {
    fail(`rigscore manual "governance docs + coherence, ${governanceClaim} of the 100 scoring points" != recomputed weight sum ${expected}`);
  } else {
    ok(`rigscore manual governance-checks weight claim matches data/rigscore.json: ${expected}`);
  }
}

const dogfoodSelf = extractDocsNumber(/Self-score (\d+)\/100 \(Grade/, 'dogfooding "Self-score N/100"');
const dogfoodWeight = extractDocsNumber(/weight (\d+)\/100/, 'dogfooding "weight N/100"');
const dogfoodFailUnder = extractDocsNumber(/CI threshold `--fail-under (\d+)`/, 'dogfooding "--fail-under N"');
let dogfoodClean = true;
if (dogfoodSelf !== null && dogfoodSelf !== DOGFOOD_SELF_SCORE) {
  dogfoodClean = false;
  fail(`rigscore manual dogfooding self-score "${dogfoodSelf}/100" != pinned constant DOGFOOD_SELF_SCORE ${DOGFOOD_SELF_SCORE} — re-run rigscore on itself and update both together`);
}
if (dogfoodWeight !== null && dogfoodWeight !== DOGFOOD_APPLICABLE_WEIGHT) {
  dogfoodClean = false;
  fail(`rigscore manual dogfooding applicable weight "${dogfoodWeight}/100" != pinned constant DOGFOOD_APPLICABLE_WEIGHT ${DOGFOOD_APPLICABLE_WEIGHT}`);
}
if (dogfoodFailUnder !== null && dogfoodFailUnder !== DOGFOOD_FAIL_UNDER) {
  dogfoodClean = false;
  fail(`rigscore manual "--fail-under ${dogfoodFailUnder}" != pinned constant DOGFOOD_FAIL_UNDER ${DOGFOOD_FAIL_UNDER} (self-score ${DOGFOOD_SELF_SCORE} - buffer ${DOGFOOD_CI_BUFFER})`);
}
if (dogfoodClean && dogfoodSelf !== null && dogfoodWeight !== null && dogfoodFailUnder !== null) {
  ok(`rigscore manual dogfooding numbers match pinned constants: self-score ${DOGFOOD_SELF_SCORE}, weight ${DOGFOOD_APPLICABLE_WEIGHT}, fail-under ${DOGFOOD_FAIL_UNDER}`);
}

// --- (j) product-page version literals ⊆ the release ledger ---------------
// A v-prefixed semver token in a product's own content page must be a fact
// that product's data/releases/<slug>.json actually carries — its release
// version, its demo bundle's source ref, or its screenshots' media_source.
// Data-driven on purpose: the allowed set comes from the ledger, so the fix
// for a stale mention is a data change, never a prose edit that hides it.
const VERSION_TOKEN_RE = /\bv\d+\.\d+\.\d+\b/g;

let versionLedgerClean = true;
for (const slug of PRODUCT_SLUGS) {
  const pagePath = path.join(ROOT, 'content', `${slug}.md`);
  if (!fs.existsSync(pagePath)) continue;
  const releasePath = path.join(RELEASES_DIR, `${slug}.json`);
  if (!fs.existsSync(releasePath)) {
    fail(`content/${slug}.md exists but data/releases/${slug}.json does not — cannot verify its version literals`);
    versionLedgerClean = false;
    continue;
  }
  let record;
  try {
    record = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
  } catch (err) {
    fail(`cannot read/parse data/releases/${slug}.json: ${err.message}`);
    versionLedgerClean = false;
    continue;
  }
  const allowed = new Set();
  if (record.version) allowed.add(`v${String(record.version).replace(/^v/i, '')}`);
  if (record.demo && record.demo.source) allowed.add(String(record.demo.source));
  if (record.media_source) allowed.add(String(record.media_source));

  const lines = fs.readFileSync(pagePath, 'utf8').split('\n');
  lines.forEach((line, idx) => {
    VERSION_TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = VERSION_TOKEN_RE.exec(line)) !== null) {
      if (!allowed.has(m[0])) {
        versionLedgerClean = false;
        fail(`content/${slug}.md:${idx + 1} names version "${m[0]}" not in data/releases/${slug}.json's version/demo.source/media_source (${[...allowed].join(', ') || 'none recorded'}) → ${line.trim().slice(0, 90)}`);
      }
    }
  });
}
if (versionLedgerClean) ok('product-page version literals all match their data/releases/<slug>.json ledger entry');

if (failed) {
  process.stderr.write('\nverify-facts: FAILED — fix the drift above, or update the documented whitelist.\n');
  process.exit(1);
}
process.stdout.write('\nverify-facts: all gates pass (data self-consistent · no hardcoded facts · product counts match the ledger · reference.md flag parity · rigscore-manual arithmetic pinned · shipped:null entries carry a repo · products declare their access path · product version literals match the release ledger).\n');
