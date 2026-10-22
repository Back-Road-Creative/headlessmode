// The headroom under Cloudflare's 2,000-character _headers line cap is the binding
// constraint on every new map source, and in one day three people quoted three
// different remaining figures from memory: 376 (predated an origin), 323 (twice -- the
// CSP VALUE measured instead of the LINE), and 296, which read the right LINE but
// subtracted from 2,000 when the gate below is `< 2000` -- one character more than may
// actually be spent. Four tries, four wrong answers, which is the argument for deriving
// it. This test pins the reporter to the same source of truth the generator and
// headers-generated.test.mjs already use, and to the boundary the gate enforces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { effectiveHeaders } from './gen-headers.mjs';
import { parseHeaders, CSP_HEADER } from './helpers/headers.mjs';
import { cspValue } from './gen-headers.mjs';
import { stateOrigins } from '../../themes/headlessmode/static/js/quiet-corners-maps/state-pages.js';
import { MAX_LINE, cspLines, headroomFor, metaLength, formatReport } from './csp-headroom.mjs';

// The map policy left the _headers line cap for a <meta> (spec U7), so the only CSP line left
// to measure is the sitewide one on /*; the map's own length is reported, not capped.
const GLOBAL_PATH = '/*';

const COMMITTED = effectiveHeaders();

// Cloudflare documents a "2,000 character limit" per line, but the assertion that
// actually gates this repo is headers-generated.test.mjs:78, and it is STRICT:
// `line.length < 2000`. The longest line that passes is therefore 1999, and a reporter
// that answered 2000 would bless one character more than the gate allows -- the exact
// boundary bug this tool exists to prevent.
test('the reporter measures against the longest line the gate actually passes', () => {
  assert.equal(MAX_LINE, 1999);
  const binding = readFileSync(new URL('./headers-generated.test.mjs', import.meta.url), 'utf8');
  assert.match(binding, /line\.length < 2000/,
    'the binding assertion changed shape -- re-derive MAX_LINE from it');
});

// A synthetic file, so the boundary is tested at the boundary rather than wherever the
// real policy happens to sit today.
const headersWithCspOfLength = (n) => `/synthetic/\n  ${CSP_HEADER}: ${'x'.repeat(n - `  ${CSP_HEADER}: `.length)}\n`;

test('the longest passing line reports zero left, and one more is over', () => {
  const at = cspLines(headersWithCspOfLength(MAX_LINE))[0];
  assert.equal(at.length, MAX_LINE);
  assert.equal(at.remaining, 0, 'a 1999-character line has nothing left to spend');
  assert.equal(at.overCap, false);

  const over = cspLines(headersWithCspOfLength(MAX_LINE + 1))[0];
  assert.equal(over.length, 2000);
  assert.equal(over.remaining, -1);
  assert.equal(over.overCap, true, 'a 2000-character line fails headers-generated.test.mjs:78');
});

// Spending exactly what the reporter offers must leave the binding assertion green.
test('spending every reported character keeps the line legal', () => {
  const row = headroomFor(GLOBAL_PATH);
  assert.ok(row.length + row.remaining < 2000,
    `spending ${row.remaining} would make the line ${row.length + row.remaining}, which fails the gate`);
  assert.equal(row.length + row.remaining, MAX_LINE);
});

// Reconstructing "  Name: value" is only safe if it is what the file actually holds.
test('every reported line appears verbatim in the committed _headers', () => {
  const lines = new Set(COMMITTED.split('\n'));
  const rows = cspLines();
  assert.ok(rows.length > 0, 'the reporter found no CSP line at all');
  for (const row of rows) {
    assert.ok(lines.has(row.line), `${row.path}: reported line is not a line of the built _headers`);
    assert.equal(row.length, row.line.length);
    assert.equal(row.max, MAX_LINE);
    assert.equal(row.remaining, MAX_LINE - row.length);
  }
});

// The binding assertion is headers-generated.test.mjs:78, which builds exactly this
// string. If the reporter ever measured something else, it would be the fourth number.
test('the sitewide row measures the same line the binding assertion measures', () => {
  const entry = parseHeaders(effectiveHeaders()).get(GLOBAL_PATH).find((e) => e.name === CSP_HEADER);
  const row = headroomFor(GLOBAL_PATH);
  assert.equal(row.length, `  ${CSP_HEADER}: ${entry.value}`.length);
  assert.notEqual(row.length, entry.value.length,
    'measuring the VALUE instead of the LINE is exactly how 323 was reported twice');
});

// The 120-character floor is gone with the line it guarded. The map policy is the page's
// <meta> (csp-meta.test.mjs), where there is no 2,000-character cap, so a new picture host
// no longer fails here. The length is still reported, for information.
test('the meta length is reported and is the length of cspValue()', () => {
  assert.equal(metaLength(), cspValue(stateOrigins()).length);
  assert.match(formatReport(), new RegExp(`map policy \\(<meta>\\): ${metaLength()} characters`));
});

test('no _headers line is a map CSP any more', () => {
  assert.ok(!cspLines().some((r) => r.path === '/quiet-corners/'),
    'the map path sets a header CSP again, which the browser would intersect with the meta policy');
});

test('the report names the path, the length, the cap and what is left', () => {
  const text = formatReport();
  assert.match(text, new RegExp(GLOBAL_PATH.replace(/\*/g, '\\*')));
  assert.match(text, new RegExp(String(headroomFor(GLOBAL_PATH).length)));
  assert.match(text, new RegExp(String(headroomFor(GLOBAL_PATH).remaining)));
  assert.match(text, new RegExp(String(MAX_LINE)));
  assert.match(text, /under 2,?000/i, 'the wording must say what the gate enforces');
});
