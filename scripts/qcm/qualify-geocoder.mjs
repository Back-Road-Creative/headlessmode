// Rural qualification of the Census address geocoder behind GET /api/geocode.
//
// The question: for public buildings in the most rural US counties, whose coordinates a federal
// source publishes, how often does Census find the address, and how far from the published point
// does it put it? The answer is data/quiet-corners-maps/geocode-qualification.json, and the
// decision record that reads it is scripts/qcm/GEOCODER.md. Nothing in either is typed by hand.
//
//   node scripts/qcm/qualify-geocoder.mjs --select   rebuild the corpus (USGS Structures + RUCC)
//   node scripts/qcm/qualify-geocoder.mjs --run      query Census for each entry, one per second
//
// --select pulls every Courthouse and Post Office point from the USGS National Map Structures
// service, keeps those inside a county whose rural-urban code (counties.json `rucc`) is 8 or 9,
// and takes a fixed, hash-ordered sample (at most two per state), so the same data gives the same
// corpus. --run sends each address through handleGeocode, the function being qualified, so the
// numbers describe what a reader of the site gets, not what Census alone could do.
// A private residence is never a candidate: the source holds public facilities only.
import Module from 'node:module';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { handleGeocode } from '../../static/functions/api/geocode.js';

const ROOT = new URL('../../', import.meta.url);
export const EVIDENCE = fileURLToPath(new URL('data/quiet-corners-maps/geocode-qualification.json', ROOT));
const STRUCTURES = 'https://carto.nationalmap.gov/arcgis/rest/services/structures/MapServer';
export const LAYERS = { courthouse: 40, 'post-office': 38 };
export const RURAL_RUCC = [8, 9];
export const PER_TYPE = 20;
export const PER_STATE = 2;
const POINT_TYPES = ['Unknown', 'Centroid', 'Egress or Entrance', 'Turn-off location', 'Approximate'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- pure helpers (tested) -------------------------------------------------------------------
export function haversineMetres(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

export function addressKind(address) {
  if (/\b(p\.?\s?o\.?\s?box|post office box)\b/i.test(address)) return 'po-box';
  if (/\b(rr|rural route|hc|highway contract|star route)\s*\d/i.test(address)) return 'rural-route';
  return /^\d/.test(address.trim()) ? 'street-number' : 'no-number';
}

// Nearest-rank percentile of an ascending list.
export const percentile = (sorted, p) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];

const rounded = (n) => Math.round(n * 10) / 10;
function distanceStats(entries) {
  const d = entries.filter((e) => e.result?.distanceM != null).map((e) => e.result.distanceM).sort((a, b) => a - b);
  if (!d.length) return null;
  const within = (m) => d.filter((x) => x <= m).length;
  return {
    n: d.length, minM: rounded(d[0]), medianM: rounded(percentile(d, 50)), p90M: rounded(percentile(d, 90)),
    maxM: rounded(d[d.length - 1]), within100: within(100), within250: within(250), within500: within(500),
    within1000: within(1000), over1000: d.length - within(1000),
  };
}
function tally(entries) {
  const queried = entries.filter((e) => e.result && !e.result.error);
  const matched = queried.filter((e) => e.result.resultCount > 0);
  return {
    n: entries.length, errors: entries.filter((e) => e.result?.error).length, queried: queried.length,
    matched: matched.length, unmatched: queried.length - matched.length,
    matchRatePct: queried.length ? rounded((100 * matched.length) / queried.length) : null,
    stateAgrees: matched.filter((e) => e.result.stateAgrees).length,
    zipAgrees: matched.filter((e) => e.result.zipAgrees).length,
  };
}
export function summarise(entries) {
  const group = (key) => Object.fromEntries([...new Set(entries.map(key))].sort().map((k) => [k, tally(entries.filter((e) => key(e) === k))]));
  return {
    overall: tally(entries), distance: distanceStats(entries),
    byType: group((e) => e.type), byAddressKind: group((e) => e.addressKind),
  };
}

// Hash order makes the pick repeatable and unrelated to anything a person could steer.
const rank = (id) => createHash('sha256').update(id).digest('hex');
export function pickCorpus(candidates, { perType = PER_TYPE, perState = PER_STATE } = {}) {
  const out = [];
  for (const type of Object.keys(LAYERS)) {
    const perStateCount = {};
    const pool = candidates.filter((c) => c.type === type).sort((a, b) => rank(a.id).localeCompare(rank(b.id)));
    let taken = 0;
    for (const c of pool) {
      if (taken >= perType) break;
      if ((perStateCount[c.state] ?? 0) >= perState) continue;
      perStateCount[c.state] = (perStateCount[c.state] ?? 0) + 1;
      out.push(c);
      taken += 1;
    }
  }
  return out;
}

// ---- county lookup: the repo's own topojson + rural table ------------------------------------
function loadTopojson() {
  const file = fileURLToPath(new URL('themes/headlessmode/static/vendor/topojson-client.min.js', ROOT));
  const mod = { exports: {} };
  vm.runInThisContext(Module.wrap(readFileSync(file, 'utf8')), { filename: file }).call(mod.exports, mod.exports, () => ({}), mod, file, '.');
  return mod.exports;
}
const inRing = (x, y, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const inPolygon = (x, y, rings) => inRing(x, y, rings[0]) && !rings.slice(1).some((h) => inRing(x, y, h));

export function countyIndex() {
  const topo = JSON.parse(readFileSync(new URL('static/data/quiet-corners/counties-10m.json', ROOT), 'utf8'));
  const table = new Map(JSON.parse(readFileSync(new URL('static/data/quiet-corners/counties.json', ROOT), 'utf8')).map((c) => [c.fips, c]));
  const shapes = loadTopojson().feature(topo, topo.objects.counties).features.map((f) => {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const xs = polys.flat(2).map((p) => p[0]);
    const ys = polys.flat(2).map((p) => p[1]);
    return { fips: String(f.id), polys, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
  });
  return (lon, lat) => {
    const hit = shapes.find((s) => lon >= s.box[0] && lon <= s.box[2] && lat >= s.box[1] && lat <= s.box[3]
      && s.polys.some((p) => inPolygon(lon, lat, p)));
    const row = hit && table.get(hit.fips);
    return row ? { fips: row.fips, name: row.name, state: row.state, rucc: row.rucc } : null;
  };
}

// ---- --select --------------------------------------------------------------------------------
async function layerRecords(layer) {
  const rows = [];
  for (let offset = 0; ; offset += 2000) {
    const url = `${STRUCTURES}/${layer}/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&orderByFields=OBJECTID&resultOffset=${offset}&resultRecordCount=2000&f=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    const page = await res.json();
    if (!Array.isArray(page.features)) throw new Error(`layer ${layer} offset ${offset}: ${JSON.stringify(page).slice(0, 200)}`);
    rows.push(...page.features);
    if (!page.exceededTransferLimit) return rows;
    await sleep(1000);
  }
}

async function select() {
  const county = countyIndex();
  const candidates = [];
  const seen = {};
  for (const [type, layer] of Object.entries(LAYERS)) {
    const rows = await layerRecords(layer);
    seen[type] = { records: rows.length, withFullAddress: 0, inRuralCounty: 0 };
    for (const { attributes: a, geometry: g } of rows) {
      if (![a.address, a.city, a.state, a.zipcode].every((v) => typeof v === 'string' && v.trim()) || !g) continue;
      seen[type].withFullAddress += 1;
      const c = county(g.x, g.y);
      if (!c || !RURAL_RUCC.includes(c.rucc) || c.state !== a.state) continue;
      seen[type].inRuralCounty += 1;
      candidates.push({
        id: a.permanent_identifier, type, name: a.name, address: a.address.trim(), city: a.city.trim(), state: a.state,
        zip: a.zipcode.trim(), addressKind: addressKind(a.address), lon: g.x, lat: g.y,
        pointLocationType: POINT_TYPES[a.pointlocationtype] ?? `code ${a.pointlocationtype}`,
        county: c, sourceDatadesc: a.source_datadesc,
      });
    }
  }
  const corpus = pickCorpus(candidates);
  const prior = readEvidence();
  const doc = {
    ...prior,
    selection: {
      selectedAt: new Date().toISOString(), source: STRUCTURES, layers: LAYERS, counts: seen, candidates: candidates.length,
      candidateKinds: Object.fromEntries(['street-number', 'po-box', 'rural-route', 'no-number'].map((k) => [k, candidates.filter((c) => c.addressKind === k).length])),
      rural: `counties.json rucc in [${RURAL_RUCC}]; county found by point-in-polygon on counties-10m.json`,
      pick: `sha256(permanent_identifier) ascending, ${PER_TYPE} per type, at most ${PER_STATE} per state`,
    },
    corpus,
    summary: null,
    run: null,
  };
  save(doc);
  console.log(`corpus ${corpus.length} of ${candidates.length} candidates`);
}

// ---- --run -----------------------------------------------------------------------------------
async function run() {
  const doc = readEvidence();
  const startedAt = new Date();
  for (const e of doc.corpus) {
    const q = `${e.address}, ${e.city}, ${e.state} ${e.zip}`;
    const t0 = Date.now();
    const res = await handleGeocode(new Request(`https://headlessmode.com/api/geocode?q=${encodeURIComponent(q)}`));
    const body = await res.json();
    const top = body.results?.[0];
    e.result = res.status !== 200 ? { error: `${res.status} ${body.error}` } : {
      resultCount: body.results.length, ms: Date.now() - t0,
      ...(top && {
        label: top.label, tigerId: top.id, lat: top.lat, lon: top.lon, matchClass: top.matchClass,
        distanceM: rounded(haversineMetres(e, top)), stateAgrees: top.state === e.state, zipAgrees: top.zip === e.zip.slice(0, 5),
      }),
    };
    await sleep(1000);
  }
  doc.run = {
    startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), intervalMs: 1000,
    via: 'handleGeocode in static/functions/api/geocode.js, live upstream, benchmark Public_AR_Current',
  };
  doc.summary = summarise(doc.corpus);
  save(doc);
  console.log(JSON.stringify(doc.summary.overall));
}

// ---- file ------------------------------------------------------------------------------------
function readEvidence() {
  try { return JSON.parse(readFileSync(EVIDENCE, 'utf8')); } catch { return { schemaVersion: 1 }; }
}
// One corpus entry per line keeps the file reviewable; everything else is indented.
function save(doc) {
  const { corpus, ...rest } = doc;
  const head = JSON.stringify({ ...rest, corpus: '@@' }, null, 2);
  const lines = (corpus ?? []).map((e) => `    ${JSON.stringify(e)}`).join(',\n');
  writeFileSync(EVIDENCE, `${head.replace('"@@"', `[\n${lines}\n  ]`)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const flags = process.argv.slice(2);
  if (!flags.some((f) => f === '--select' || f === '--run')) {
    console.error('usage: qualify-geocoder.mjs [--select] [--run]');
    process.exit(2);
  }
  if (flags.includes('--select')) await select();
  if (flags.includes('--run')) await run();
}
