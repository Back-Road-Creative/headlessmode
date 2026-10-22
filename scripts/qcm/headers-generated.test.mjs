// static/_headers is generated. These tests are the contract that keeps the
// committed file, the two registries and Cloudflare's documented limits together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderPublic, cspValue, HEADERS_FILE, SECTION_MARKER } from './gen-headers.mjs';
import { parseHeaders, parseCsp, hostSource } from './helpers/headers.mjs';
import { DASHBOARD_PATH, mapRulePaths, stateOrigins } from '../../themes/headlessmode/static/js/quiet-corners-maps/state-pages.js';

const COMMITTED = readFileSync(HEADERS_FILE, 'utf8');
// Every assertion below is about the policy the BROWSER gets, which is the build
// output — not the committed prefix, which no longer carries a map rule at all.
const RENDERED = renderPublic(COMMITTED);
const blocks = parseHeaders(RENDERED);

// THE REASON THE POLICY IS NOT COMMITTED (2026-09-15). It used to be, regenerated
// into static/_headers by `--write`. The whole map policy is ONE 1,704-character
// line, so every branch that adds a source rewrote that same line — and two such
// branches conflict on it even when they share nothing else. On 2026-09-15 six
// layer PRs (#532, #534, #535, #536, #537, #538) were mutually disjoint in every
// registry they touched and still could not be batch-merged: each one made the
// next stale, GitHub's update-branch answered 422 on this one line, and the merge
// wrapper's stale-base self-heal had nothing it could do. The file is now the
// hand-written prefix ONLY; the generated section is appended to public/_headers
// at build time by scripts/build-site.sh. A generated artifact that never enters
// git cannot be hand-merged wrong, and two branches can no longer collide on it.
test('the generated policy is NOT committed — it is what branches used to collide on', () => {
  assert.ok(!COMMITTED.includes(SECTION_MARKER),
    `static/_headers still carries the generated "${SECTION_MARKER}" section. Committing it `
    + 'puts the whole map CSP on one line that every layer branch rewrites, which is what '
    + 'serialised six disjoint PRs into six merge rounds. It belongs in the build output.');
});

test('the build output is the committed prefix plus the generated section', () => {
  assert.ok(RENDERED.startsWith(COMMITTED), 'the hand-written prefix must survive verbatim');
  assert.ok(RENDERED.includes(SECTION_MARKER), 'the generated section is missing from the build output');
  assert.equal(renderPublic(RENDERED), RENDERED, 'appending twice must be a no-op');
});

// Cloudflare Pages: "Each line in the _headers file has a 2,000 character limit"
// and "You may define up to 100 header rules." Both are hard platform limits, and
// the 2,000 is why there used to be a page per state: a CSP naming every state
// origin was measured at 2,087 characters. That figure counted PARCELS, which are
// neither a default nor built, and spent 456 characters on redundant `https://`.
test('every line stays under the 2,000-character Pages limit', () => {
  for (const line of RENDERED.split('\n')) {
    assert.ok(line.length < 2000, `line of ${line.length} chars: ${line.slice(0, 80)}…`);
  }
});

test('the file stays under the 100-rule Pages limit', () => {
  assert.ok(blocks.size <= 100, `${blocks.size} rules`);
});

// The dashboard is becoming the map, so it needs the policy too. Two rules while
// the builder moves onto it; the builder's own page keeps one until it is retired.
// What is gone either way is the page per state.
test('every map rule has a page, and no rule is a state page', () => {
  const actual = [...blocks.keys()].filter((p) => p.startsWith(DASHBOARD_PATH));
  assert.deepEqual(actual.sort(), [...mapRulePaths()].sort(),
    'a page without a rule falls back to the global same-origin CSP and can reach no map service');
  for (const path of actual) {
    assert.ok(!/\/maps\/[a-z]{2}\/$/.test(path), `${path} is a per-state page rule`);
  }
});

// Still exact, still not a wildcard: Cloudflare applies EVERY matching rule and
// joins a repeated header with a comma, which a browser enforces as the
// INTERSECTION — so an overlapping rule could only ever cut this one back.
test('the map rule is not a wildcard, so no other rule can intersect it', () => {
  for (const path of [...blocks.keys()].filter((p) => p.startsWith(DASHBOARD_PATH))) {
    assert.ok(!path.includes('*'), `${path} is a wildcard and would intersect with a state rule`);
  }
});

test('each map rule detaches the global policy and sets none: the policy is the page <meta>', () => {
  for (const path of [...blocks.keys()].filter((p) => p.startsWith(DASHBOARD_PATH))) {
    const entries = blocks.get(path);
    assert.deepEqual(entries[0], { detach: 'Content-Security-Policy' }, `${path} does not detach first`);
    assert.equal(entries.filter((e) => e.name === 'Content-Security-Policy').length, 0, `${path} sets a header CSP that would intersect the meta policy`);
  }
});

test("the map's CSP is the federal set plus EVERY state's origins, and nothing else", () => {
  const origins = stateOrigins();
  const value = cspValue(origins);
  const connect = parseCsp(value).get('connect-src');
  for (const origin of origins) assert.ok(connect.includes(hostSource(origin)), `the map cannot reach ${origin}`);
  assert.ok(origins.length > 40, `only ${origins.length} state origins — a state has been dropped`);
});

// The policy is the page's <meta> (csp-meta.test.mjs), so the 2,000-character _headers line
// cap no longer binds it. This keeps the sanity floor: a state origin silently dropped
// would shorten it. Length is reported, not capped: `npm run csp:headroom`.
test('the map policy is still the full federal-plus-state set', () => {
  const value = cspValue(stateOrigins());
  assert.ok(value.length > 1000, 'suspiciously short: the state origins may have been dropped');
});

test('no map policy allows a wildcard host, inline script or eval', () => {
  for (const path of [...blocks.keys()].filter((p) => p.startsWith(DASHBOARD_PATH))) {
    const csp = parseCsp(cspValue(stateOrigins()));
    assert.deepEqual(csp.get('script-src'), ["'self'"], `${path} script-src`);
    for (const [name, tokens] of csp) {
      for (const t of tokens) {
        assert.ok(!t.includes('*'), `${path}: wildcard host ${t}`);
        assert.ok(!t.includes('unsafe-eval'), `${path}: ${name} allows eval`);
        if (name !== 'style-src') assert.ok(!t.includes('unsafe-inline'), `${path}: ${name} allows inline`);
      }
    }
  }
});

test('the generated map policy opens connect-src to hydro.nationalmap.gov', () => {
  const connect = parseCsp(cspValue(stateOrigins())).get('connect-src');
  assert.ok(connect.includes(hostSource('https://hydro.nationalmap.gov')));
});
