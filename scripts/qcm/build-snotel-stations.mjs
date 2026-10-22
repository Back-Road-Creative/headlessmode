// Build-time SNOTEL site catalogue: one GET of the NRCS AWDB station list for the SNTL network
// (active sites only), written as id, name, lat, lon and elevation under
// static/data/quiet-corners-maps/snotel-stations/. Measured 2026-10-20: the answer is 407,574 bytes
// with CORS *, 919 sites in 13 Western states; every raw field except these five (HUC lists, county,
// SHEF id, operator, dates) is dropped so the committed file stays small. The id is the station
// triplet without its network ("1344:CO" for 1344:CO:SNTL), which the layer puts back.
//
// Fail-soft: a failed request, or a run that yields no site, leaves an existing file untouched.
// Usage: node scripts/qcm/build-snotel-stations.mjs [--out <file>]
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_OUT = fileURLToPath(new URL('../../static/data/quiet-corners-maps/snotel-stations/stations.json', import.meta.url));
export const USER_AGENT = 'headlessmode.com Quiet Corners catalogue build (info@backroadcreative.com)';
export const STATIONS_URL = 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/stations?stationTriplets=*:*:SNTL&activeOnly=true';
const TRIPLET = /^(\d+):([A-Z]{2}):SNTL$/;
const PER_LINE = 5;
const r4 = (n) => Math.round(n * 1e4) / 1e4;

/** The raw station list into catalogue rows. Pure; a site with no position or another network is skipped and counted. */
export function normalizeStations(list) {
  const rows = [];
  let skipped = 0;
  for (const s of Array.isArray(list) ? list : []) {
    const m = TRIPLET.exec(String((s && s.stationTriplet) || ''));
    if (!m || !s.name || !Number.isFinite(s.latitude) || !Number.isFinite(s.longitude)) { skipped += 1; continue; }
    rows.push([`${m[1]}:${m[2]}`, String(s.name), r4(s.latitude), r4(s.longitude), Number.isFinite(s.elevation) ? Math.round(s.elevation) : null]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { rows, skipped };
}

/** The file text: a header, sites five to a line (the per-PR diff cap), a closing line. */
export function serializeCatalogue({ rows, states, fetchedOn }) {
  const head = JSON.stringify({ source: STATIONS_URL, fetchedOn, states, columns: ['id', 'name', 'lat', 'lon', 'elevFt'] });
  const lines = [];
  for (let i = 0; i < rows.length; i += PER_LINE) lines.push(rows.slice(i, i + PER_LINE).map((r) => JSON.stringify(r)).join(','));
  return `${head.slice(0, -1)},"stations":[\n${lines.join(',\n')}\n]}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const out = i > -1 ? process.argv[i + 1] : DEFAULT_OUT;
  try {
    const res = await fetch(STATIONS_URL, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const got = normalizeStations(await res.json());
    if (!got.rows.length) throw new Error('no site survived the filter; the existing file is left alone');
    const states = [...new Set(got.rows.map((r) => r[0].split(':')[1]))].sort();
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, serializeCatalogue({ rows: got.rows, states, fetchedOn: new Date().toISOString().slice(0, 10) }));
    console.log(`${got.rows.length} sites kept, ${got.skipped} skipped -> ${out}`);
  } catch (e) {
    console.error(`build-snotel-stations failed, nothing written: ${e.message}`);
    process.exit(1);
  }
}
