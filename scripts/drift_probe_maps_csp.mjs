// Post-deploy probe for the Field Maps CSP, run by drift-sentinel.yml.
//
// scripts/qcm/csp.test.mjs proves the built _headers is right; nothing proved the
// edge actually serves it. Cloudflare Pages joins a header applied twice with a comma,
// so a broader rule creeping back would silently produce TWO policies — and a browser
// intersects them, which blocks the very hosts the page exists to reach. That failure
// is invisible offline and invisible in a deploy log.
//
// Compares the served page's <meta> policy against the policy the build ships rather than a copy
// pasted here, so the expectation cannot go stale: it is gen-headers.mjs's cspValue(),
// worked out from the committed registries with no build needed (helpers/headers.mjs
// holds the single <meta> parser).
//
// GET, never HEAD: this site's HEAD once reported content-length 32 for a 28,069-byte
// body, so a HEAD-based probe cannot be trusted (see the site CLAUDE.md).
//
// Usage: node scripts/drift_probe_maps_csp.mjs [baseUrl]
import { cspValue } from './qcm/gen-headers.mjs';
import { stateOrigins } from '../themes/headlessmode/static/js/quiet-corners-maps/state-pages.js';
import { CSP_HEADER, headCspMetas, parseCsp } from './qcm/helpers/headers.mjs';

export const MAPS_URL_PATH = '/quiet-corners/';

const norm = (v) => v.replace(/\s+/g, ' ').trim();

/** Compares one live response against the built policy; pure, so the tests inject it.
 *  The policy is the page's <meta> (spec U7); NO CSP header may be served on the page, because
 *  a browser enforces the intersection of a header and a meta. */
export function checkCspResponse({ status, headerValues, html = '' }, expected) {
  const lines = [];
  const fail = (m) => lines.push(`FAIL: ${m}`);
  if (status !== 200) fail(`${MAPS_URL_PATH} returned HTTP ${status}`);
  if (headerValues.length > 0) fail(`a ${CSP_HEADER} header is served on ${MAPS_URL_PATH}; a browser intersects it with the page's <meta> policy: ${headerValues[0]}`);
  const { policies, first } = headCspMetas(html);
  if (policies.length === 0) fail(`no ${CSP_HEADER} <meta> in the served page`);
  else if (policies.length > 1) fail(`${policies.length} ${CSP_HEADER} <meta> tags served; a browser intersects them`);
  else if (!first) fail(`the ${CSP_HEADER} <meta> is not the first child of <head> (a leading <meta charset> aside), so earlier elements escape it`);
  else if (norm(policies[0]) !== norm(expected)) {
    fail(`the served ${CSP_HEADER} <meta> differs from the policy the build writes`);
    const served = parseCsp(policies[0]);
    for (const [name, tokens] of parseCsp(expected)) {
      const got = served.get(name);
      if (!got) lines.push(`  missing directive: ${name}`);
      else if (got.join(' ') !== tokens.join(' ')) lines.push(`  ${name}: served "${got.join(' ')}" vs built "${tokens.join(' ')}"`);
    }
    for (const name of served.keys()) if (!parseCsp(expected).has(name)) lines.push(`  unexpected directive: ${name}`);
  } else if (!lines.some((l) => l.startsWith('FAIL:'))) lines.push(`PASS: ${MAPS_URL_PATH} serves exactly the built policy as its first <meta>, with no ${CSP_HEADER} header`);
  return { ok: !lines.some((l) => l.startsWith('FAIL:')), lines };
}

/** Fetches the live page and checks it. Returns the same shape as checkCspResponse. */
export async function probe(baseUrl, { fetchImpl = globalThis.fetch } = {}) {
  const expected = cspValue(stateOrigins());
  let res;
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${MAPS_URL_PATH}`, { redirect: 'follow' });
  } catch (err) {
    return { ok: false, lines: [`FAIL: could not reach ${baseUrl}${MAPS_URL_PATH}: ${err?.message ?? err}`] };
  }
  const raw = res.headers.get(CSP_HEADER.toLowerCase());
  const headerValues = raw === null ? [] : [raw];
  return checkCspResponse({ status: res.status, headerValues, html: await res.text() }, expected);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.argv[2] || 'https://headlessmode.com';
  const { ok, lines } = await probe(base);
  for (const l of lines) console.log(l);
  process.exit(ok ? 0 : 1);
}
