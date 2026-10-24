// A sleep that stands in for a condition is a bet on load: it fails on a busy box
// and wastes its whole length on an idle one (helpers/waits.mjs says why). The files
// below were converted to wait on what their next assertion reads; this keeps
// a `new Promise((r) => setTimeout(r, N))` from coming back into them. A sleep that
// is the point of the test (asserting something does NOT happen) is written against
// the app's debounce constant, which this pattern does not match: it matches only a
// sleep with a numeric-literal delay, in the `=> setTimeout(cb, N)` shape. Three more
// shapes counted as the same bet: a `sleep(N)` call, a delay that adds a margin to the
// app's own debounce (`settleMs + 100`), and a bare numeric delay in a pacing or
// polling loop; the last must be a named constant that says why it is a number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BLIND = /=>\s*setTimeout\(\s*\w+\s*,\s*\d+/;
const SLEEP_CALL = /\bsleep\(\s*\d+/;
const MARGIN = /settleMs\s*\+/;
const SLEEPS = [BLIND, SLEEP_CALL, MARGIN];
// A number of milliseconds that is allowed to stay is a named constant, and the line that
// names it (or the one above) says why.
const NAMED_MS = /^\s*const\s+[A-Z][A-Z0-9_]*_MS\s*=\s*\d+/;

const lines = (file) => readFileSync(path.join(HERE, file), 'utf8').split('\n');
const blind = (rows, patterns = [BLIND]) => rows.map((text, i) => ({ n: i + 1, text })).filter((r) => patterns.some((p) => p.test(r.text)));
const show = (hits) => hits.map((r) => `${r.n}: ${r.text.trim()}`).join('\n');

test('panel-shell-browser waits on conditions, not on a fixed sleep', () => {
  const hits = blind(lines('panel-shell-browser.test.mjs'));
  assert.deepEqual(hits, [], `blind sleeps:\n${show(hits)}`);
});

test('a11y-dynamic-browser waits on conditions, not on a fixed sleep', () => {
  const hits = blind(lines('a11y-dynamic-browser.test.mjs'));
  assert.deepEqual(hits, [], `blind sleeps:\n${show(hits)}`);
});

// QQA-13e2: the browser proofs no open PR touches. Each reads a condition where it used to
// sleep; what stays is a named constant with its reason beside it.
const SCOPE = [
  'browser-port.test.mjs',
  'card-over-panels-browser.test.mjs',
  'helpers/place-shards.mjs',
  'phone-map-chrome-browser.test.mjs',
  'print-clear-journeys-browser.test.mjs',
  'road-labels-browser.test.mjs',
];

for (const file of SCOPE) {
  test(`${file} waits on conditions, not on a fixed sleep or a margin past a debounce`, () => {
    const hits = blind(lines(file), SLEEPS);
    assert.deepEqual(hits, [], `blind sleeps:\n${show(hits)}`);
  });

  test(`${file} gives every millisecond constant a reason`, () => {
    const rows = lines(file);
    const bare = rows.map((text, i) => ({ n: i + 1, text })).filter((r) => NAMED_MS.test(r.text)
      && !/\/\/\s*\S/.test(r.text) && !/^\s*\/\//.test(rows[r.n - 2] ?? ''));
    assert.deepEqual(bare, [], `a millisecond constant with no comment:\n${show(bare)}`);
  });
}

test('chooseExampleArea waits on the debounce, not on settleMs plus a margin', () => {
  const src = lines('helpers/waits.mjs').join('\n');
  const start = src.indexOf('export async function chooseExampleArea');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.doesNotMatch(body, /VIEWPORT_FETCH\.settleMs\s*\+/, 'chooseExampleArea still adds a margin to settleMs');
  assert.doesNotMatch(body, BLIND, 'chooseExampleArea still sleeps a fixed time');
});

test('the sleep pattern matches a literal delay under any callback name, and not a named constant', () => {
  for (const sleep of ['new Promise((r) => setTimeout(r, 400))', 'new Promise(ok => setTimeout(ok, 300))', 'new Promise((done) => setTimeout(done, 1500))', "page.evaluate('new Promise(r => setTimeout(r, 400))')"]) {
    assert.match(sleep, BLIND, sleep);
  }
  for (const sleep of ['await sleep(900);', 'await sleep(300)', '  sleep( 70 )']) assert.match(sleep, SLEEP_CALL, sleep);
  for (const sleep of ['`new Promise((r) => setTimeout(r, ${VIEWPORT_FETCH.settleMs + 100}))`', 'await delay(settleMs +100)']) assert.match(sleep, MARGIN, sleep);
  for (const wait of ['await sleep(IDLE_MS);', 'const asleep = (ms) => 1', 'settleMs, 5)']) {
    assert.doesNotMatch(wait, SLEEP_CALL, wait);
    assert.doesNotMatch(wait, MARGIN, wait);
  }
  for (const wait of ['new Promise((r) => setTimeout(r, VIEWPORT_FETCH.settleMs + 100))', 'new Promise((r) => setTimeout(r, DEBOUNCE_MS))', 'new Promise((r) => setTimeout(r, Math.max(1, 2)))', 'const t = setTimeout(() => rej(new Error("x")), 100000)', 'ok ? r(true) : setTimeout(tick, 50)']) {
    assert.doesNotMatch(wait, BLIND, wait);
  }
});

test('the phone sheet resize waits for the map to catch up before axe runs', () => {
  const src = lines('a11y-dynamic-browser.test.mjs').join('\n');
  assert.match(src, /the sheet to expand[^\n]*\n\s*await session\.evaluate\(`window\.qcMeasured\(/, 'the expanded-sheet wait is not followed by qcMeasured');
});
