// Cloudflare Pages `_headers` parsing, shared by the offline contract test
// (scripts/qcm/csp.test.mjs) and the live probe (scripts/drift_probe_maps_csp.mjs).
// One parser, so the policy the test asserts and the policy the probe expects the edge
// to serve can never drift apart.
//
// Syntax: an unindented line starts a path block; an indented `Name: value` sets a
// header; an indented `! Name` detaches one inherited from a broader block.

// The one map. EXACT, not a wildcard: Cloudflare joins a repeated header with a
// comma and the browser enforces the intersection, so a second rule matching the
// same request could only ever cut the policy back. /quiet-corners/maps/ is the
// methodology page now — it fetches nothing and deliberately has no rule.
// See scripts/qcm/gen-headers.mjs.
export const MAPS_PATH = '/quiet-corners/';
export const CSP_HEADER = 'Content-Security-Policy';

/** The longest _headers LINE that passes the gate.
 *
 *  Cloudflare Pages documents "a 2,000 character limit" per line, but the assertion
 *  that actually gates this repo is headers-generated.test.mjs:78 and it is STRICT --
 *  `line.length < 2000` -- so the longest line that gets through is 1999. The number
 *  named here is that one, not 2,000: headroom is what may still be SPENT, and a
 *  reporter offering 2000 - length would bless one character more than the gate
 *  allows. A headroom tool wrong by one at the boundary is worse than none, because
 *  it is trusted.
 *
 *  The cap measures the LINE, not the policy value -- the `  Content-Security-Policy: `
 *  prefix is 27 characters of it, which is how the same margin got reported as both
 *  323 and 296 in one day. scripts/qcm/csp-headroom.mjs measures it; do not quote it. */
export const MAX_LINE = 1999;

/** An origin as a CSP host-source: the `https://` prefix is dropped.
 *
 *  A host-source with no scheme-part is matched against the DOCUMENT's scheme, not
 *  against anything the attacker picks, and this page is only ever served over https
 *  -- so `arcgis.dnr.alaska.gov` permits exactly what `https://arcgis.dnr.alaska.gov`
 *  permits. Identical enforcement, eight characters shorter per origin.
 *
 *  Eight characters times 57 origins is 456, and that is the whole reason parcels can
 *  ship: the policy naming them measured 2,087 against Cloudflare's 2,000-per-line cap.
 *  The saving is not a micro-optimisation, it is the transport fix.
 *
 *  Spec reasoning is not evidence, so scripts/qcm/csp-host-source.test.mjs proves it in
 *  a real Chromium against a real https origin: listed host reachable, unlisted blocked.
 */
export const hostSource = (origin) => origin.replace(/^https:\/\//, '');

export function parseHeaders(text) {
  const blocks = new Map();
  let current = null;
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) { current = []; blocks.set(raw.trim(), current); continue; }
    const line = raw.trim();
    if (line.startsWith('! ')) current.push({ detach: line.slice(2).trim() });
    else { const i = line.indexOf(':'); current.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() }); }
  }
  return blocks;
}

export function parseCsp(value) {
  const out = new Map();
  for (const d of value.split(';')) {
    const [name, ...tokens] = d.trim().split(/\s+/);
    if (name) out.set(name, tokens);
  }
  return out;
}

const escAttr = (v) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const META_RE = /<meta\b[^>]*\bhttp-equiv=["']?Content-Security-Policy["']?[^>]*>/gi;
const HEAD_OPEN_RE = /<head(?:\s[^>]*)?>/i;
// A leading <meta charset> (browsers only pre-scan the first 1024 bytes for it) may precede the CSP meta.
const LEAD_CHARSET_RE = /^\s*<meta\b[^>]*\bcharset=[^>]*>/i;

/** The CSP <meta> for a policy value. */
export const cspMetaTag = (policy) => `<meta http-equiv="${CSP_HEADER}" content="${escAttr(policy)}">`;

/** `html` with the policy as the first child of <head> -- apart from a leading <meta charset>,
 *  which stays first so it remains inside the 1024-byte pre-scan window -- replacing any CSP
 *  <meta> already there, so running it twice is a no-op. A <meta> CSP only governs what the
 *  parser sees after it, which is why it must open the head. Throws when there is no <head>. */
export function injectCspMeta(html, policy) {
  const open = HEAD_OPEN_RE.exec(html);
  if (!open) throw new Error('page has no <head> to carry the Content-Security-Policy <meta>');
  let end = open.index + open[0].length;
  const rest0 = html.slice(end).replace(META_RE, '');
  const cs = LEAD_CHARSET_RE.exec(rest0);
  if (cs) end += cs[0].length;
  const rest = cs ? rest0.slice(cs[0].length) : rest0;
  return html.slice(0, open.index + open[0].length) + (cs ? cs[0] : '') + cspMetaTag(policy) + rest;
}

/** What the page's <head> says about CSP: every policy <meta>, decoded, and whether the
 *  first one is the first child of <head>, apart from a preceding <meta charset>. */
export function headCspMetas(html) {
  const open = HEAD_OPEN_RE.exec(html);
  if (!open) return { policies: [], first: false };
  const afterOpen = html.slice(open.index + open[0].length);
  const close = afterOpen.search(/<\/head>|<body[\s>]/i);
  const head = close === -1 ? afterOpen : afterOpen.slice(0, close);
  const tags = head.match(META_RE) || [];
  const policies = tags.map((t) => {
    const m = t.match(/\bcontent=(?:"([^"]*)"|'([^']*)')/);
    return (m ? (m[1] ?? m[2]) : '').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  });
  const lead = LEAD_CHARSET_RE.exec(head);
  const rest = lead ? head.slice(lead[0].length) : head;
  return { policies, first: tags.length > 0 && rest.trimStart().startsWith(tags[0]) };
}
