// Every remote read in the map goes through request.js, so no module can forget its
// deadline or its cancel. This is the review-time half of that rule: a module that calls
// fetch( or fetchImpl( itself fails here, before a reader meets a request that never ends.
// It reads the source text only -- comments and string contents are blanked first, so
// prose that mentions fetch() is not a call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = new URL('../../themes/headlessmode/static/js/quiet-corners-maps/', import.meta.url);
const HELPER = 'request.js';
// main.js was the last module of the original set with raw calls and now goes through request.js
// too. The seven entries below reached master after QQA-13 was written (the E-P1..E-P6 field-map
// layers and the finder's street-address lookup). Each still owns a raw call and its own signal,
// so none has a deadline from request.js yet. Moving them onto fetchWithDeadline is a follow-up;
// until then they are listed so this test guards every other module. An entry is a debt with a
// reason beside it, and the stale-entry test below fails once it is paid.
const ALLOW = [
  'address-geocode.js',
  'source-avalanche.js', 'source-nrhp.js', 'source-ntad-rail-airports.js',
  'source-nws-observations.js', 'source-snotel.js', 'source-stream-gauges.js',
];

// A call to fetch/fetchImpl that is not a method of something else (`x.fetch(` is not it)
// -- except the global spellings, which are the same call.
const RAW_CALL = /(?:^|[^A-Za-z0-9_$.])(?:globalThis\.|window\.|self\.)?(?:fetch|fetchImpl)\s*\(/;

/** The source with comments, string contents and template text blanked to spaces, keeping
 *  `${ ... }` code and every newline, so a hit's line number is the file's. */
function codeOnly(src) {
  let out = '';
  const stack = [];                       // 'tpl' for an open template, 'expr' for ${ inside one
  let i = 0;
  const blank = (ch) => (ch === '\n' ? '\n' : ' ');
  while (i < src.length) {
    const ch = src[i], next = src[i + 1], top = stack[stack.length - 1];
    if (top === 'tpl') {
      if (ch === '\\') { out += ' ' + blank(next); i += 2; continue; }
      if (ch === '`') { stack.pop(); out += ' '; i += 1; continue; }
      if (ch === '$' && next === '{') { stack.push('expr'); out += '  '; i += 2; continue; }
      out += blank(ch); i += 1; continue;
    }
    if (ch === '/' && next === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i += 1; } continue; }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2), stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i += 1) out += blank(src[i]);
      continue;
    }
    if (ch === "'" || ch === '"') {
      out += ' '; i += 1;
      while (i < src.length && src[i] !== ch && src[i] !== '\n') { if (src[i] === '\\') { out += ' '; i += 1; } out += blank(src[i]); i += 1; }
      if (src[i] === ch) { out += ' '; i += 1; }
      continue;
    }
    if (ch === '`') { stack.push('tpl'); out += ' '; i += 1; continue; }
    if (top === 'expr' && ch === '}') { stack.pop(); out += ' '; i += 1; continue; }
    if (top === 'expr' && ch === '{') { stack.push('expr'); out += ch; i += 1; continue; }
    out += ch; i += 1;
  }
  return out;
}

const rawCalls = (src) => codeOnly(src).split('\n')
  .map((line, n) => (RAW_CALL.test(line) ? n + 1 : 0)).filter(Boolean);

const files = readdirSync(DIR).filter((f) => f.endsWith('.js')).sort();
const read = (f) => readFileSync(join(DIR.pathname, f), 'utf8');

test('the detector sees a call and ignores prose', () => {
  assert.deepEqual(rawCalls('const r = await fetchImpl(url, { signal });'), [1]);
  assert.deepEqual(rawCalls('x = fetch(u)\ny = globalThis.fetch(u)'), [1, 2]);
  assert.deepEqual(rawCalls('await ok(`${fetch(a)}`)'), [1], 'code inside a template hole is code');
  assert.deepEqual(rawCalls('// fetch(u)\n/* fetchImpl(\n u) */\nconst s = "fetch(u)"; const t = `read via fetch() here`;'), []);
  assert.deepEqual(rawCalls('const f = { fetchImpl, fetch: g }; thing.fetch(u); await fetchWithDeadline(u, {})'), []);
  assert.deepEqual(rawCalls('fetchImpl = fetch, signal'), [], 'a default value is a reference, not a call');
});

test('the scan covers the whole module directory', () => {
  assert.ok(files.length > 60, `only ${files.length} files found`);
  assert.ok(files.includes(HELPER) && files.includes('main.js'));
});

test('no module but request.js and the allow list calls fetch( or fetchImpl( itself', () => {
  const offenders = [];
  for (const f of files) {
    if (f === HELPER || ALLOW.includes(f)) continue;
    const lines = rawCalls(read(f));
    if (lines.length) offenders.push(`${f}:${lines.join(',')}`);
  }
  assert.deepEqual(offenders, [], 'route the read through fetchWithDeadline (request.js) with the source\'s registry timeoutMs');
});

test('every allow list entry still holds a raw call, so a stale entry fails', () => {
  for (const f of ALLOW) {
    assert.ok(files.includes(f), `${f} is gone: drop it from ALLOW`);
    assert.ok(rawCalls(read(f)).length > 0, `${f} no longer calls fetch( itself: drop it from ALLOW`);
  }
});

test('request.js is where the network is reached', () => {
  assert.match(read(HELPER), /await fetchImpl\(url,/);
});
