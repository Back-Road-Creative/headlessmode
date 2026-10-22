// build-identity.mjs: what is in this build, and is it the one deployed? Pure functions with
// injected git and file reads; the one real-build test below is the CI gate (PR CI builds the
// site with compiled CSS before `node --test`, pr-ci.yml:177).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { checkEssentials, parseDeployCommit, buildIdentity, dashboardScripts } from './build-identity.mjs';
import { siteIsBuilt, PUBLIC_DIR } from './helpers/site-server.mjs';

const SCRIPT = fileURLToPath(new URL('./build-identity.mjs', import.meta.url));
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const SHA = '483f6eefe4c09282a1c41600e8bb9c4bbdc1bdad';
const OTHER = '0123456789abcdef0123456789abcdef01234567';
const COMPILED = '*,::before{box-sizing:border-box}img{max-width:100%;height:auto}.flex{display:flex}';
const LAYOUT = `{{/* a comment naming <script src="{{ "js/nope.js" | relURL }}"> must not count */}}
<script src="{{ "vendor/leaflet.js" | relURL }}" defer></script>
<script src="https://cdn.example.com/x.js"></script>
<script type="module" src="{{ "js/quiet-corners-maps/main.js" | relURL }}"></script>
<script src="js/plain.js" defer></script>
`;

function fixture(omit = {}, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'qa00-'));
  const pub = join(root, 'public');
  const files = {
    'quiet-corners/index.html': '<html>ok</html>',
    'css/tailwind.css': COMPILED,
    '_headers': '/*\n  X-Test: 1\n',
    'vendor/leaflet.js': '// leaflet',
    'js/quiet-corners-maps/main.js': '// main',
    'js/plain.js': '// plain',
    ...overrides,
  };
  for (const [rel, body] of Object.entries(files)) {
    if (omit[rel]) continue;
    mkdirSync(dirname(join(pub, rel)), { recursive: true });
    writeFileSync(join(pub, rel), body);
  }
  const layoutPath = join(root, 'layout.html');
  writeFileSync(layoutPath, LAYOUT);
  return { root, pub, layoutPath, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('dashboardScripts: local script srcs only, Hugo comments ignored', () => {
  assert.deepEqual(dashboardScripts(LAYOUT), ['vendor/leaflet.js', 'js/quiet-corners-maps/main.js', 'js/plain.js']);
});

test('checkEssentials: a complete build has no problems', () => {
  const f = fixture();
  try { assert.deepEqual(checkEssentials(f.pub, { layoutPath: f.layoutPath }), []); } finally { f.done(); }
});

test('checkEssentials: missing tailwind.css is named', () => {
  const f = fixture({ 'css/tailwind.css': true });
  try {
    const p = checkEssentials(f.pub, { layoutPath: f.layoutPath });
    assert.equal(p.length, 1);
    assert.match(p[0], /css\/tailwind\.css/);
  } finally { f.done(); }
});

test('checkEssentials: empty tailwind.css fails', () => {
  const f = fixture({}, { 'css/tailwind.css': '' });
  try {
    const p = checkEssentials(f.pub, { layoutPath: f.layoutPath });
    assert.ok(p.some((x) => /empty/.test(x)), p.join('|'));
  } finally { f.done(); }
});

test('checkEssentials: raw Tailwind source (not compiled) fails', () => {
  const f = fixture({}, { 'css/tailwind.css': '@import "tailwindcss";\n@plugin "@tailwindcss/typography";\n' });
  try {
    const p = checkEssentials(f.pub, { layoutPath: f.layoutPath });
    assert.ok(p.some((x) => /raw Tailwind source/.test(x)), p.join('|'));
  } finally { f.done(); }
});

test('checkEssentials: raw source that happens to contain the preflight string still fails as raw', () => {
  const f = fixture({}, { 'css/tailwind.css': '@import "tailwindcss";\n.x{max-width:100%}\n' });
  try {
    const p = checkEssentials(f.pub, { layoutPath: f.layoutPath });
    assert.equal(p.length, 1);
    assert.match(p[0], /raw Tailwind source/);
  } finally { f.done(); }
});

test('checkEssentials: an unreadable dashboard layout fails closed, not open', () => {
  const f = fixture();
  try {
    const layoutPath = join(f.root, 'no-such-layout.html');
    const p = checkEssentials(f.pub, { layoutPath });
    assert.equal(p.length, 1);
    assert.match(p[0], /cannot read the dashboard layout/);
    const { git } = fakeGit();
    const id = buildIdentity({ git, publicDir: f.pub, layoutPath });
    assert.equal(id.essentials.ok, false);
    assert.equal(id.assets['css/tailwind.css'], sha256(COMPILED));
  } finally { f.done(); }
});

test('checkEssentials: CSS without the Tailwind preflight marker fails', () => {
  const f = fixture({}, { 'css/tailwind.css': '.x{color:red}' });
  try {
    const p = checkEssentials(f.pub, { layoutPath: f.layoutPath });
    assert.ok(p.some((x) => /preflight/.test(x)), p.join('|'));
  } finally { f.done(); }
});

test('checkEssentials: missing _headers is named', () => {
  const f = fixture({ '_headers': true });
  try {
    const p = checkEssentials(f.pub, { layoutPath: f.layoutPath });
    assert.equal(p.length, 1);
    assert.match(p[0], /_headers/);
  } finally { f.done(); }
});

test('checkEssentials: missing quiet-corners index is named', () => {
  const f = fixture({ 'quiet-corners/index.html': true });
  try {
    const p = checkEssentials(f.pub, { layoutPath: f.layoutPath });
    assert.equal(p.length, 1);
    assert.match(p[0], /quiet-corners\/index\.html/);
  } finally { f.done(); }
});

test('checkEssentials: a missing map module the dashboard loads is named', () => {
  const f = fixture({ 'js/quiet-corners-maps/main.js': true });
  try {
    const p = checkEssentials(f.pub, { layoutPath: f.layoutPath });
    assert.equal(p.length, 1);
    assert.match(p[0], /js\/quiet-corners-maps\/main\.js/);
  } finally { f.done(); }
});

test('checkEssentials: a layout with no local scripts is itself a problem', () => {
  const f = fixture();
  try {
    writeFileSync(f.layoutPath, '<p>nothing</p>');
    const p = checkEssentials(f.pub, { layoutPath: f.layoutPath });
    assert.ok(p.some((x) => /no local <script>/.test(x)), p.join('|'));
  } finally { f.done(); }
});

test('checkEssentials: reads go through the injected readFile/exists', () => {
  const seen = [];
  const files = new Map([
    ['/p/quiet-corners/index.html', 'x'], ['/p/css/tailwind.css', COMPILED], ['/p/_headers', 'h'],
    ['/p/vendor/leaflet.js', 'l'], ['/p/js/quiet-corners-maps/main.js', 'm'], ['/p/js/plain.js', 'p'], ['/layout.html', LAYOUT],
  ]);
  const readFile = (p) => { seen.push(p); return files.get(p); };
  const exists = (p) => files.has(p);
  assert.deepEqual(checkEssentials('/p', { readFile, exists, layoutPath: '/layout.html' }), []);
  assert.ok(seen.includes('/p/css/tailwind.css'));
});

test('parseDeployCommit: the production orphan commit subject yields the source SHA', () => {
  assert.equal(parseDeployCommit(`chore(deploy): publish ${SHA}`), SHA);
  assert.equal(parseDeployCommit(`chore(deploy): publish ${SHA}\n`), SHA);
});

test('parseDeployCommit: anything else is null', () => {
  assert.equal(parseDeployCommit('chore(deploy): publish'), null);
  assert.equal(parseDeployCommit('fix: something'), null);
  assert.equal(parseDeployCommit(''), null);
  assert.equal(parseDeployCommit(undefined), null);
  assert.equal(parseDeployCommit(`chore(deploy): publish ${SHA} extra`), null);
});

test('parseDeployCommit: the subject must start with the deploy prefix', () => {
  assert.equal(parseDeployCommit(`xchore(deploy): publish ${SHA}`), null);
  assert.equal(parseDeployCommit(`Revert "chore(deploy): publish ${SHA}"`), null);
});

test('parseDeployCommit: a short SHA is null', () => {
  assert.equal(parseDeployCommit(`chore(deploy): publish ${SHA.slice(0, 8)}`), null);
});

test('parseDeployCommit: an uppercase SHA is null', () => {
  assert.equal(parseDeployCommit(`chore(deploy): publish ${SHA.toUpperCase()}`), null);
});

// `git status --porcelain -z`: entries end in NUL; a rename is `R  <new>\0<old>\0`.
const z = (...entries) => entries.map((e) => `${e}\0`).join('');

function fakeGit({ head = SHA, porcelain = '', subject = `chore(deploy): publish ${SHA}`, marker = `${SHA}\n`, noMarker = false, production = true } = {}) {
  const calls = [];
  const git = (args) => {
    calls.push(args.join(' '));
    const a = args.join(' ');
    if (a === 'rev-parse HEAD') return `${head}\n`;
    if (a.startsWith('status --porcelain')) return porcelain;
    if (!production && /origin\/production/.test(a)) throw new Error('fatal: bad revision origin/production');
    if (a === 'log -1 --format=%s origin/production') return `${subject}\n`;
    if (a === 'show origin/production:deploy-marker.txt') {
      if (noMarker) throw new Error('fatal: path deploy-marker.txt does not exist in origin/production');
      return marker;
    }
    throw new Error(`unexpected git ${a}`);
  };
  return { git, calls };
}

test('buildIdentity: clean tree, matching deployment', () => {
  const f = fixture();
  try {
    const { git } = fakeGit();
    const id = buildIdentity({ git, publicDir: f.pub, layoutPath: f.layoutPath });
    assert.equal(id.sourceSha, SHA);
    assert.deepEqual(id.dirty, []);
    assert.deepEqual(id.essentials, { ok: true, problems: [] });
    assert.deepEqual(Object.keys(id.assets).sort(),
      ['css/tailwind.css', 'js/plain.js', 'js/quiet-corners-maps/main.js', 'quiet-corners/index.html', 'vendor/leaflet.js']);
    // The hash is of the bytes on disk, not just 64 hex digits: a record that hashes the wrong
    // thing would vouch for a build it never looked at.
    assert.deepEqual(id.assets, {
      'css/tailwind.css': sha256(COMPILED),
      'quiet-corners/index.html': sha256('<html>ok</html>'),
      'vendor/leaflet.js': sha256('// leaflet'),
      'js/quiet-corners-maps/main.js': sha256('// main'),
      'js/plain.js': sha256('// plain'),
    });
    assert.equal(new Set(Object.values(id.assets)).size, 5, 'different files must hash differently');
    assert.deepEqual(id.deployed, { sha: SHA, marker: SHA, agree: true, isSource: true });
  } finally { f.done(); }
});

test('buildIdentity: dirty paths come from porcelain', () => {
  const f = fixture();
  try {
    const { git } = fakeGit({ porcelain: z(' M scripts/a.mjs', '?? scripts/b.mjs') });
    const id = buildIdentity({ git, publicDir: f.pub, layoutPath: f.layoutPath });
    assert.deepEqual(id.dirty, ['scripts/a.mjs', 'scripts/b.mjs']);
  } finally { f.done(); }
});

test('buildIdentity: dirty is a plain path list -- renames give the new path, odd names are not quoted', () => {
  const f = fixture();
  try {
    const { git, calls } = fakeGit({
      porcelain: z('R  scripts/new name.mjs', 'scripts/old.mjs', ' M caf\u00e9/"q".txt', 'C  copy.mjs', 'orig.mjs', '?? plain.mjs'),
    });
    const id = buildIdentity({ git, publicDir: f.pub, layoutPath: f.layoutPath });
    assert.deepEqual(id.dirty, ['scripts/new name.mjs', 'caf\u00e9/"q".txt', 'copy.mjs', 'plain.mjs']);
    assert.ok(calls.some((c) => /^status --porcelain -z\b/.test(c)), `status must use -z: ${calls.join('|')}`);
  } finally { f.done(); }
});

test('buildIdentity: an empty status gives an empty dirty list', () => {
  const f = fixture();
  try {
    const { git } = fakeGit({ porcelain: '' });
    assert.deepEqual(buildIdentity({ git, publicDir: f.pub, layoutPath: f.layoutPath }).dirty, []);
  } finally { f.done(); }
});

test('buildIdentity: origin/production absent gives deployed null, no throw', () => {
  const f = fixture();
  try {
    const { git } = fakeGit({ production: false });
    const id = buildIdentity({ git, publicDir: f.pub, layoutPath: f.layoutPath });
    assert.equal(id.deployed, null);
  } finally { f.done(); }
});

test('buildIdentity: a marker that disagrees with the subject is agree:false', () => {
  const f = fixture();
  try {
    const { git } = fakeGit({ marker: `${OTHER}\n` });
    const id = buildIdentity({ git, publicDir: f.pub, layoutPath: f.layoutPath });
    assert.equal(id.deployed.sha, SHA);
    assert.equal(id.deployed.marker, OTHER);
    assert.equal(id.deployed.agree, false);
  } finally { f.done(); }
});

test('buildIdentity: a subject that does not parse and no marker file is agree:false, not agree:true', () => {
  const f = fixture();
  try {
    const { git } = fakeGit({ subject: 'fix: x', noMarker: true });
    const id = buildIdentity({ git, publicDir: f.pub, layoutPath: f.layoutPath });
    assert.deepEqual(id.deployed, { sha: null, marker: null, agree: false, isSource: false });
  } finally { f.done(); }
});

test('buildIdentity: a valid subject with no marker file does not throw and does not agree', () => {
  const f = fixture();
  try {
    const { git } = fakeGit({ noMarker: true });
    const id = buildIdentity({ git, publicDir: f.pub, layoutPath: f.layoutPath });
    assert.deepEqual(id.deployed, { sha: SHA, marker: null, agree: false, isSource: true });
  } finally { f.done(); }
});

test('buildIdentity: an empty marker file counts as no marker', () => {
  const f = fixture();
  try {
    const { git } = fakeGit({ marker: '\n' });
    assert.equal(buildIdentity({ git, publicDir: f.pub, layoutPath: f.layoutPath }).deployed.marker, null);
  } finally { f.done(); }
});

test('buildIdentity: deployed differs from source by SHA string only', () => {
  const f = fixture();
  try {
    const { git } = fakeGit({ head: OTHER });
    const id = buildIdentity({ git, publicDir: f.pub, layoutPath: f.layoutPath });
    assert.equal(id.deployed.agree, true);
    assert.equal(id.deployed.isSource, false);
  } finally { f.done(); }
});

test('buildIdentity: deployed identity is read only from git, never the network', () => {
  const f = fixture();
  try {
    const { git, calls } = fakeGit();
    buildIdentity({ git, publicDir: f.pub, layoutPath: f.layoutPath });
    assert.ok(calls.every((c) => /^(rev-parse|status|log|show) /.test(c)), calls.join('|'));
  } finally { f.done(); }
});

test('buildIdentity: failing essentials are reported in the record', () => {
  const f = fixture({ 'css/tailwind.css': true });
  try {
    const { git } = fakeGit();
    const id = buildIdentity({ git, publicDir: f.pub, layoutPath: f.layoutPath });
    assert.equal(id.essentials.ok, false);
    assert.equal(id.essentials.problems.length, 1);
    assert.equal(id.assets['css/tailwind.css'], null);
  } finally { f.done(); }
});

// The CLI: exit code, --json, stdout. `--public` and `--layout` point it at a fixture instead
// of the checkout's own public/ (it still reads git from the repo it lives in).
function cli(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('CLI: a good build exits 0, prints the record and saves it with --json', () => {
  const f = fixture();
  try {
    const json = join(f.root, 'identity.json');
    const r = cli(['--json', json, '--public', f.pub, '--layout', f.layoutPath]);
    assert.equal(r.code, 0, r.err);
    const printed = JSON.parse(r.out);
    assert.deepEqual(JSON.parse(readFileSync(json, 'utf8')), printed);
    assert.match(printed.sourceSha, /^[0-9a-f]{40}$/);
    assert.deepEqual(printed.essentials, { ok: true, problems: [] });
    assert.equal(printed.assets['css/tailwind.css'], sha256(COMPILED));
  } finally { f.done(); }
});

test('CLI: without --json nothing is written and the record still prints', () => {
  const f = fixture();
  try {
    const r = cli(['--public', f.pub, '--layout', f.layoutPath]);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).essentials.ok, true);
  } finally { f.done(); }
});

test('CLI: a build with no compiled CSS exits 1, names the problem, still saves the record', () => {
  const f = fixture({}, { 'css/tailwind.css': '@import "tailwindcss";\n' });
  try {
    const json = join(f.root, 'identity.json');
    const r = cli(['--json', json, '--public', f.pub, '--layout', f.layoutPath]);
    assert.equal(r.code, 1);
    assert.match(r.err, /not fit to audit/);
    assert.match(r.err, /raw Tailwind source/);
    const saved = JSON.parse(readFileSync(json, 'utf8'));
    assert.equal(saved.essentials.ok, false);
    assert.match(saved.essentials.problems.join('|'), /raw Tailwind source/);
    assert.equal(JSON.parse(r.out).essentials.ok, false);
  } finally { f.done(); }
});

test('CLI: a flag with no value is a usage error (exit 2), not a silent default', () => {
  for (const flag of ['--json', '--public', '--layout']) {
    const r = cli([flag]);
    assert.equal(r.code, 2, `${flag}: ${r.err}`);
    assert.match(r.err, new RegExp(`${flag} needs`));
    assert.equal(r.out, '');
  }
});

test('CLI: a flag followed by another flag has no value (exit 2)', () => {
  const f = fixture();
  try {
    const r = cli(['--json', '--public', f.pub, '--layout', f.layoutPath]);
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /--json needs/);
  } finally { f.done(); }
});

const skip = !siteIsBuilt('quiet-corners')
  ? 'public/quiet-corners/ not built -- run `npm run build:css` then `bash scripts/build-site.sh --configDir site-config --minify` first'
  : false;

test('the real build has every essential, compiled CSS included', { skip }, () => {
  assert.deepEqual(checkEssentials(PUBLIC_DIR), []);
});
