// static/_headers must open the CSP for the one map to exactly the registry's origins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cspDirectivesFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { stateOrigins } from '../../themes/headlessmode/static/js/quiet-corners-maps/state-pages.js';
// One parser, shared with the live probe, so the offline contract and the post-deploy
// expectation cannot drift apart.
import { parseHeaders, parseCsp, MAPS_PATH, hostSource } from './helpers/headers.mjs';
import { effectiveHeaders, cspValue } from './gen-headers.mjs';

const HEADERS = effectiveHeaders();

const blocks = parseHeaders(HEADERS);
const maps = blocks.get(MAPS_PATH);
const cspEntries = maps ? maps.filter((e) => e.name === 'Content-Security-Policy') : [];
// The map policy is the page's <meta> now (csp-meta.test.mjs proves the built page carries it);
// it is the same cspValue() the header line used to hold.
const csp = parseCsp(cspValue(stateOrigins()));

test('the map block detaches the global CSP and sets none: the policy is the page <meta>', () => {
  assert.ok(maps, `no ${MAPS_PATH} block`);
  assert.deepEqual(maps[0], { detach: 'Content-Security-Policy' });
  // A header here would be intersected with the meta policy, and would put the policy
  // back on a line Cloudflare caps at 2,000 characters.
  assert.equal(cspEntries.length, 0);
});

test('page CSP keeps scripts same-origin, forbids frames, and names no wildcard host', () => {
  assert.deepEqual(csp.get('script-src'), ["'self'"]);
  for (const [name, tokens] of csp) {
    for (const t of tokens) {
      assert.ok(!t.includes('*'), `wildcard host ${t}`);
      assert.ok(!t.includes('unsafe-eval'), `${name} allows eval`);
      if (name !== 'style-src') assert.ok(!t.includes('unsafe-inline'), `${name} allows inline`);
    }
  }
  assert.deepEqual(csp.get('frame-src'), ["'none'"]);
  assert.deepEqual(csp.get('object-src'), ["'none'"]);
  assert.ok(csp.has('default-src'));
});

// One map, so ONE rule carries the federal services AND every state's land
// services. It used to be 52 rules, because a policy naming every state origin
// measured 2,087 characters against a 2,000-character cap -- a figure that counted
// parcels AND a redundant `https://` on all 57 origins. Bare hosts fit the lot.
test('page CSP hosts equal the registry plus every state land origin', () => {
  const derived = cspDirectivesFor();
  // Compared in the emitted host-source form: the registries hold URLs, the policy
  // holds bare hosts, and hostSource() is the one place that conversion happens.
  const expected = [...new Set(["'self'", ...derived['connect-src'].map(hostSource), ...stateOrigins().map(hostSource)])].sort();
  assert.deepEqual([...csp.get('connect-src')].sort(), expected);
  // Raster tiles are federal only: a state boundary arrives as JSON, never as an image.
  assert.deepEqual([...csp.get('img-src')].sort(), ["'self'", 'data:', 'blob:', ...derived['img-src'].map(hostSource)].sort());
  assert.ok(stateOrigins().length > 40, 'the state origins should all be here, not a subset');
});

test('global /* block still pins connect-src to self', () => {
  const global = blocks.get('/*').filter((e) => e.name === 'Content-Security-Policy');
  assert.equal(global.length, 1);
  assert.deepEqual(parseCsp(global[0].value).get('connect-src'), ["'self'"]);
  assert.ok(!blocks.has('/quiet-corners/*'), '/quiet-corners/ itself keeps the global policy');
});

// NHD flowlines (rivers and creeks) live on their own National Map host, not carto's: the
// origin has to reach connect-src through the registry, never a hand edit.
test('page CSP connect-src names hydro.nationalmap.gov for the NHD stream names', () => {
  assert.ok(csp.get('connect-src').includes(hostSource('https://hydro.nationalmap.gov')));
  assert.ok(!(csp.get('img-src') || []).includes(hostSource('https://hydro.nationalmap.gov')), 'a fetched source earns no img-src');
});
