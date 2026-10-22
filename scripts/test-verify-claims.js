#!/usr/bin/env node
/**
 * test-verify-claims.js — offline unit tests for verify-claims.js's pure
 * helpers.
 *
 * verify-claims.js is an ALWAYS-online gate by design (it re-checks GitHub
 * reality; there is no offline self-consistency mode, unlike verify-facts.js
 * or check-rigscore-sync.js). Per this repo's testing convention (see
 * the repo convention: no network, no python venv in node tests), CI
 * tests never make network calls — so this suite covers only the pure,
 * deterministic pieces. It does NOT invoke main() or hit the GitHub API. The
 * full script is exercised for real by `node scripts/verify-claims.js` from
 * drift-sentinel.yml (and by hand at authoring time).
 *
 * Run: node --test scripts/test-verify-claims.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRepo, daysSince, rateLimited } from './verify-claims.js';

test('extractRepo pulls owner/repo from a repo URL and a releases/latest URL', () => {
  assert.deepEqual(extractRepo('https://github.com/Back-Road-Creative/driftless'),
    { owner: 'Back-Road-Creative', repo: 'driftless' });
  assert.deepEqual(extractRepo('https://github.com/Back-Road-Creative/keycut/releases/latest'),
    { owner: 'Back-Road-Creative', repo: 'keycut' });
});

test('extractRepo returns null for non-github inputs', () => {
  assert.equal(extractRepo('/quiet-corners/'), null);
  assert.equal(extractRepo(undefined), null);
});

test('daysSince computes whole days, null for an unparsable timestamp', () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
  assert.equal(daysSince(twoDaysAgo), 2);
  assert.equal(daysSince('not-a-date'), null);
});

test('rateLimited detects a 403 rate-limit body, not a plain 403 or 404', () => {
  assert.equal(rateLimited({ status: 403, raw: '{"message":"API rate limit exceeded"}' }), true);
  assert.equal(rateLimited({ status: 403, raw: '{"message":"no access"}' }), false);
  assert.equal(rateLimited({ status: 404, raw: '{"message":"API rate limit exceeded"}' }), false);
});
