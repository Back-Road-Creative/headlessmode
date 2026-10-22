// Tests for the live CSP probe the drift sentinel runs after deploy. Every case injects
// a fetch, so nothing here touches the network.
//
// The map policy is the page's <meta http-equiv> now (gen-headers.mjs, spec U7), so the
// probe reads the POLICY from the served HTML and requires that NO CSP header is served on
// the page: a header would be intersected with the meta by the browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsp } from '../../scripts/qcm/helpers/headers.mjs';
import { checkCspResponse, probe, MAPS_URL_PATH } from '../../scripts/drift_probe_maps_csp.mjs';
import { cspValue } from './gen-headers.mjs';
import { stateOrigins } from '../../themes/headlessmode/static/js/quiet-corners-maps/state-pages.js';

const COMMITTED = cspValue(stateOrigins());
const failed = (r) => r.lines.filter((l) => l.startsWith('FAIL:'));
const meta = (v) => `<meta http-equiv="Content-Security-Policy" content="${v}">`;
const page = (v, { before = '' } = {}) => `<!doctype html><html lang=en-US><head>${before}${v === null ? '' : meta(v)}<meta charset=UTF-8><title>x</title></head><body></body></html>`;
const ok200 = (html, headerValues = []) => ({ status: 200, headerValues, html });

test('the built policy served once, as the first <meta> in <head>, passes', () => {
  const r = checkCspResponse(ok200(page(COMMITTED)), COMMITTED);
  assert.ok(r.ok, r.lines.join('\n'));
  assert.match(r.lines[0], /^PASS:/);
});

test('whitespace differences do not fail the probe', () => {
  const r = checkCspResponse(ok200(page(`  ${COMMITTED.replace(/; /g, ';  ')}  `)), COMMITTED);
  assert.ok(r.ok, r.lines.join('\n'));
});

test('a CSP header served on the page fails: the browser would intersect it with the meta', () => {
  const r = checkCspResponse(ok200(page(COMMITTED), [`default-src 'self'`]), COMMITTED);
  assert.ok(!r.ok);
  assert.match(failed(r)[0], /Content-Security-Policy header is served/);
});

test('no CSP meta at all fails', () => {
  const r = checkCspResponse(ok200(page(null)), COMMITTED);
  assert.ok(!r.ok);
  assert.match(failed(r)[0], /no Content-Security-Policy <meta>/);
});

test('two CSP metas fail', () => {
  const r = checkCspResponse(ok200(page(COMMITTED).replace('<title>', `${meta("default-src 'self'")}<title>`)), COMMITTED);
  assert.ok(!r.ok);
  assert.match(failed(r)[0], /2 Content-Security-Policy <meta>/);
});

test('a meta that follows a leading <meta charset> still passes', () => {
  const r = checkCspResponse(ok200(page(COMMITTED, { before: '<meta charset=UTF-8>' })), COMMITTED);
  assert.ok(r.ok, r.lines.join('\n'));
});

test('a meta that is not the first child of <head> fails', () => {
  const r = checkCspResponse(ok200(page(COMMITTED, { before: '<link rel=stylesheet href=/a.css>' })), COMMITTED);
  assert.ok(!r.ok);
  assert.match(failed(r)[0], /first child of <head>/);
});

test('a non-200 fails', () => {
  const r = checkCspResponse({ ...ok200(page(COMMITTED)), status: 404 }, COMMITTED);
  assert.ok(!r.ok);
  assert.match(failed(r)[0], /HTTP 404/);
});

test('a dropped host is named directive by directive', () => {
  // The host to drop is DERIVED from the policy, and the notEqual below is what makes a
  // no-op replace impossible to pass silently.
  const dropped = parseCsp(COMMITTED).get('connect-src').find((t) => !t.startsWith("'"));
  const stripped = COMMITTED.replace(` ${dropped}`, '');
  assert.notEqual(stripped, COMMITTED, `nothing was dropped: ${dropped} is not in the policy`);
  const r = checkCspResponse(ok200(page(stripped)), COMMITTED);
  assert.ok(!r.ok);
  assert.ok(r.lines.some((l) => l.includes('connect-src') && l.includes(dropped)), r.lines.join('\n'));
});

test('probe GETs the maps path and reports a reachable, correct edge', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push([url, opts]);
    return { status: 200, headers: new Headers(), text: async () => page(COMMITTED) };
  };
  const r = await probe('https://example.test/', { fetchImpl });
  assert.ok(r.ok, r.lines.join('\n'));
  assert.equal(seen[0][0], `https://example.test${MAPS_URL_PATH}`, 'no double slash, and the maps path is the one probed');
});

test('the probe fails when the edge still serves a CSP header', async () => {
  const fetchImpl = async () => ({ status: 200, headers: new Headers({ 'content-security-policy': COMMITTED }), text: async () => page(COMMITTED) });
  const r = await probe('https://example.test', { fetchImpl });
  assert.ok(!r.ok);
});

test('an unreachable site fails rather than throwing', async () => {
  const fetchImpl = async () => { throw new Error('connection reset by peer'); };
  const r = await probe('https://example.test', { fetchImpl });
  assert.ok(!r.ok);
  assert.match(failed(r)[0], /could not reach .*connection reset/);
});
