// Rebuilds static/data/quiet-corners/ecoregions-l3.json from EPA's ecoregion service.
//
// Run:  node scripts/qcm/gen-ecoregions.mjs --write
// Check: node --test scripts/qcm/ecoregions.test.mjs  (asserts the committed file is the
//        85 features and 949,718 bytes this command returned on 2026-09-14)
//
// BY HAND, never in CI and never in the browser. The file is the source the app reads, and
// the point of committing it is that the app has no runtime dependency on EPA at all: a
// generator wired into a build would put that dependency straight back. The data has not
// moved since December 2011, so there is nothing to schedule.
//
// The `maxAllowableOffset` is not an optimisation. Measured 2026-09-14: the same request
// WITHOUT it answers HTTP 500 with a `text/html` body — `response.json()` throws — so the
// service refuses ungeneralized national geometry outright. Committing the generalized
// answer is what makes that failure impossible rather than merely handled.
//
// Rights: EPA's own Terms of Use for Geospatial Data state that "geospatial data produced
// by the EPA is by default in the public domain and is not subject to domestic copyright
// protection under 17 U.S.C. § 105", which is what permits this site to serve a copy.
import { writeFileSync } from 'node:fs';
import { SOURCE_QUERY_URL, GENERALIZED_DEGREES, FEATURE_COUNT, EXPORT_BYTES }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/source-ecoregions.js';

export const OUT_FILE = new URL('../../static/data/quiet-corners/ecoregions-l3.json', import.meta.url);
export const PARAMS = Object.freeze({
  where: '1=1',
  outFields: 'US_L3CODE,US_L3NAME,NA_L1NAME,NA_L2NAME',
  returnGeometry: 'true',
  outSR: '4326',
  maxAllowableOffset: String(GENERALIZED_DEGREES),
  f: 'geojson',
});

export const requestUrl = () => `${SOURCE_QUERY_URL}?${new URLSearchParams(PARAMS)}`;

async function main() {
  const res = await fetch(requestUrl(), { headers: { Origin: 'https://headlessmode.com' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`EPA answered ${res.status} ${res.headers.get('content-type')}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  const n = json.features ? json.features.length : 0;
  if (n !== FEATURE_COUNT) {
    throw new Error(`EPA returned ${n} features, not the ${FEATURE_COUNT} this export is measured at. `
      + 'Re-measure before committing: a republish that adds regions changes what the app can say.');
  }
  if (!process.argv.includes('--write')) {
    console.log(`${n} features, ${Buffer.byteLength(text)} bytes (committed: ${EXPORT_BYTES}). Pass --write to save.`);
    return;
  }
  writeFileSync(OUT_FILE, text);
  console.log(`wrote ${Buffer.byteLength(text)} bytes to ${OUT_FILE.pathname}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
