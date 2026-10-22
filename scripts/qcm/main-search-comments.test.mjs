// The map's finder is opened by "Search places"; "Search names" is the USGS lookup button inside
// its box (quiet-corners.js). main.js once called the finder itself "Search names" in four
// comments, which sent a reader looking for a control that is not the finder. main.js names no
// control of that label at all, so any mention is the stale wording back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MAIN = new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url);

test('main.js does not call the finder "Search names"', () => {
  const lines = readFileSync(MAIN, 'utf8').split('\n')
    .map((text, i) => ({ n: i + 1, text })).filter((l) => /Search names/.test(l.text));
  assert.deepEqual(lines.map((l) => `main.js:${l.n}`), [], 'main.js still says "Search names"; the finder is "Search places"');
});

test('main.js names the finder it means: "Search places"', () => {
  assert.match(readFileSync(MAIN, 'utf8'), /"Search places" finder/);
});
