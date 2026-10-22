// How much room is left under Cloudflare's per-line cap, MEASURED.
//
// Run:  npm run csp:headroom      (or: node scripts/qcm/csp-headroom.mjs)
//
// Why this exists: the remaining headroom is the binding constraint on every new map
// source, and it was being quoted from memory. In one day it was reported as 376 (a
// figure that predated the services.swpc.noaa.gov aurora origin), as 323 twice -- the
// CSP VALUE measured instead of the _headers LINE, which is 27 characters longer --
// and as 296, which measured the right line but subtracted from 2,000 when the gate is
// `< 2000`, so it offered one character more than may be spent. Two source-qualification
// efforts were planned against the wrong number. Any figure written down rots the same
// way inside a week, so it is derived here instead, from the generator's own output and
// against the boundary the gate actually enforces.
//
// Nothing in this file decides anything: gen-headers.mjs builds the policy and
// helpers/headers.mjs parses it. This only measures, so it cannot disagree with them.
// scripts/qcm/csp-headroom.test.mjs holds the floor, and pins this measurement to the
// exact string headers-generated.test.mjs asserts against the cap, at the boundary.
//
// SINCE U7 the map policy is a <meta>, not a header line, so there is no per-line cap on it
// and no floor: the only header line left to measure is the sitewide one, and the map's
// length is printed for information.
import { effectiveHeaders, cspValue } from './gen-headers.mjs';
import { stateOrigins } from '../../themes/headlessmode/static/js/quiet-corners-maps/state-pages.js';
import { parseHeaders, CSP_HEADER, MAX_LINE } from './helpers/headers.mjs';

export { MAX_LINE };

/** The map policy's own length. It is the page's <meta> (spec U7), which has no line cap, so
 *  this is reported for information and no test holds a floor under it. */
export const metaLength = () => cspValue(stateOrigins()).length;

/** One row per CSP the generated file sets: where it applies and what is left. */
export function cspLines(text = effectiveHeaders()) {
  const rows = [];
  for (const [path, entries] of parseHeaders(text)) {
    for (const entry of entries) {
      if (entry.name !== CSP_HEADER) continue;
      // The indent is the generator's own (gen-headers.mjs `block`); the test asserts
      // this string is a verbatim line of the built _headers, so it stays a measurement.
      const line = `  ${CSP_HEADER}: ${entry.value}`;
      // MAX_LINE, not 2,000: the gate is `< 2000`, so `remaining` is what may still be
      // spent without failing it. At length 1999 that is 0, and at 2000 it is -1.
      rows.push({
        path, line, length: line.length, max: MAX_LINE,
        remaining: MAX_LINE - line.length, overCap: line.length > MAX_LINE,
      });
    }
  }
  return rows;
}

/** The row for one path. Throws rather than return undefined: a missing rule means the
 *  page fell back to the global same-origin policy and can reach no map service. */
export function headroomFor(path, text) {
  const row = cspLines(text).find((r) => r.path === path);
  if (!row) throw new Error(`static/_headers sets no ${CSP_HEADER} on ${path}`);
  return row;
}

export function formatReport(rows = cspLines()) {
  const width = Math.max(...rows.map((r) => r.path.length));
  const body = rows.map((r) =>
    `  ${r.path.padEnd(width)}  line ${String(r.length).padStart(4)} / max ${r.max}  ->  ${String(r.remaining).padStart(4)} characters left${r.overCap ? '  ** OVER **' : ''}`);
  return [
    `Content-Security-Policy headroom in the built _headers (sitewide line only)`,
    `  map policy (<meta>): ${metaLength()} characters -- no line cap applies; informational`,
    `  a LINE must stay UNDER 2,000 characters, so the longest legal one is ${MAX_LINE};`,
    '  "characters left" is what may still be spent without failing the gate.',
    ...body,
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(formatReport());
