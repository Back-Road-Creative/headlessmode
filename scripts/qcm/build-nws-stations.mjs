// Build-time NWS station catalogue: pages api.weather.gov/stations by state and writes the
// airport-style reporting stations (id, name, lat, lon, elevation) as one reviewable file under
// static/data/quiet-corners-maps/nws-stations/. /stations has no bounding-box filter (measured
// 2026-10-20: 200, CORS *, `limit` up to 500 a page, `pagination.next` cursor, about 48,500
// stations in all, `state=TN` accepted), so the browser cannot ask "stations in view"; it reads
// this file and asks only /stations/{id}/observations/latest, for a few stations at a time.
//
// Which stations: ids of four characters starting K, P or T (ASOS/AWOS airport reporters, e.g.
// KTYS). The rest of the list is APRS hobby stations, HADS river gauges and RAWS fire stations
// whose newest observation is often old or absent; the skipped count is printed, not hidden.
//
// Fail-soft: a failed page, or a run that yields no station, leaves an existing file untouched.
// Usage: node scripts/qcm/build-nws-stations.mjs --states TN,NC,CO [--out <file>]
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_OUT = fileURLToPath(new URL('../../static/data/quiet-corners-maps/nws-stations/stations.json', import.meta.url));
export const USER_AGENT = 'headlessmode.com Quiet Corners catalogue build (info@backroadcreative.com)';
const PAGE_URL = (state) => `https://api.weather.gov/stations?state=${encodeURIComponent(state)}&limit=500`;
const ID = /^[KPT][A-Z0-9]{3}$/;
const MAX_PAGES_PER_STATE = 8;

const PER_LINE = 2;
const PER_LINE_JOIN = (rows) => {
  const lines = [];
  for (let i = 0; i < rows.length; i += PER_LINE) lines.push(rows.slice(i, i + PER_LINE).map((r) => JSON.stringify(r)).join(','));
  return lines.join(',\n');
};
const r4 = (n) => Math.round(n * 1e4) / 1e4;

/** One /stations page into catalogue rows. Pure. */
export function normalizeStations(page) {
  const rows = [];
  let skipped = 0;
  for (const f of Array.isArray(page && page.features) ? page.features : []) {
    const p = (f && f.properties) || {};
    const c = f && f.geometry && f.geometry.type === 'Point' ? f.geometry.coordinates : null;
    const id = String(p.stationIdentifier || '');
    if (!ID.test(id) || !p.name || !Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) { skipped += 1; continue; }
    const e = p.elevation && Number.isFinite(p.elevation.value) ? Math.round(p.elevation.value) : null;
    rows.push([id, String(p.name), r4(c[1]), r4(c[0]), e]);
  }
  return { rows, skipped };
}

/** The file text: a header line, stations two to a line (sorted by id, so a diff reads by id and the
 *  file stays under the per-PR diff cap), a closing line. */
export function serializeCatalogue({ rows, states, fetchedOn }) {
  const head = JSON.stringify({ source: 'https://api.weather.gov/stations', fetchedOn, states,
    columns: ['id', 'name', 'lat', 'lon', 'elevM'] });
  return `${head.slice(0, -1)},"stations":[\n${PER_LINE_JOIN(rows)}\n]}\n`;
}

/** Every page of each state, following pagination.next. Throws on any failed page. */
export async function fetchStates(states, { fetchImpl = fetch, sleepMs = 300 } = {}) {
  const rows = new Map();
  let skipped = 0, pages = 0;
  for (const state of states) {
    let url = PAGE_URL(state);
    for (let i = 0; url && i < MAX_PAGES_PER_STATE; i += 1) {
      const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' } });
      if (!res || !res.ok) throw new Error(`${state}: HTTP ${res && res.status}`);
      const body = await res.json();
      pages += 1;
      const got = normalizeStations(body);
      skipped += got.skipped;
      for (const r of got.rows) rows.set(r[0], r);
      const features = Array.isArray(body.features) ? body.features.length : 0;
      url = features && body.pagination && body.pagination.next;
      if (url && sleepMs) await new Promise((ok) => setTimeout(ok, sleepMs));
    }
  }
  return { rows: [...rows.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1)), skipped, pages };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };
  const states = (arg('--states') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!states.length) { console.error('usage: build-nws-stations.mjs --states TN,NC [--out file]'); process.exit(2); }
  const out = arg('--out') || DEFAULT_OUT;
  try {
    const got = await fetchStates(states);
    if (!got.rows.length) throw new Error('no station survived the filter; the existing file is left alone');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, serializeCatalogue({ rows: got.rows, states, fetchedOn: new Date().toISOString().slice(0, 10) }));
    console.log(`${got.rows.length} stations kept, ${got.skipped} skipped, ${got.pages} pages -> ${out}`);
  } catch (e) {
    console.error(`build-nws-stations failed, nothing written: ${e.message}`);
    process.exit(1);
  }
}
