#!/usr/bin/env node
// Measure one state land service and print what the catalogue needs to record.
//
// The 2026-09-06 measurement pass left no script behind, so every later question
// about an entry -- is it reachable, what does it return here, what values does
// this field take -- meant hand-rolling curl again. Eleven default-family entries
// are recorded `unverified`, which means "nobody has asked", not "asked and
// refused", and five of their notes guess that the family is a WHERE-clause
// subset of a sibling layer. This answers both questions.
//
// Read-only. Prints JSON; it never edits the catalogue, because a measurement and
// a decision about what it means are different things.
//
//   node scripts/qcm/probe-state-layer.mjs --state MA --family managedAreas
//   node scripts/qcm/probe-state-layer.mjs --state MA --family managedAreas --values MANAGER_TYPE
//   node scripts/qcm/probe-state-layer.mjs --url <service> --layer 0 --values PPAGENCY
import { layerFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/state-sources.js';
import { queryUrl } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-land-boundaries.js';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};

const TIMEOUT_MS = 30000;
async function get(url, params) {
  const q = new URLSearchParams({ f: 'json', ...params });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${url}?${q}`, { signal: ctl.signal, headers: { Origin: 'https://headlessmode.pages.dev' } });
    const cors = res.headers.get('access-control-allow-origin');
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, cors, body };
  } catch (e) {
    return { ok: false, status: null, cors: null, body: null, error: e.name === 'AbortError' ? `timeout after ${TIMEOUT_MS} ms` : e.message };
  } finally { clearTimeout(timer); }
}

const corsWord = (h) => (h === '*' ? 'star' : h ? 'reflects' : null);

/** Distinct values of one field, with a count each. This is what turns "likely a
 *  subset of the sibling layer" into a WHERE clause -- or refutes it. */
async function distinctValues(query, field) {
  const r = await get(query, {
    where: '1=1', outFields: field, returnGeometry: 'false', returnDistinctValues: 'true', resultRecordCount: '200',
  });
  if (!r.ok || !r.body || r.body.error) return { error: r.error || r.body?.error?.message || `status ${r.status}` };
  const values = (r.body.features || []).map((f) => f.attributes[field]).filter((v) => v !== null && v !== undefined);
  const counts = {};
  for (const v of values) {
    const c = await get(query, { where: `${field}='${String(v).replace(/'/g, "''")}'`, returnCountOnly: 'true' });
    counts[v] = c.body?.count ?? null;
  }
  return { field, distinct: values.length, counts };
}

/** Every live entry's `fields` map, checked against the field names the service
 *  actually publishes. A catalogue field that does not exist is not a cosmetic
 *  error: outFieldsFor puts it in the query, and ArcGIS refuses the whole request,
 *  so the layer is offered on its state page and fails every time it is asked. */
async function audit() {
  const { STATE_CODES, LAYER_IDS, isBrowserFetchable } = await import('../../themes/headlessmode/static/js/quiet-corners-maps/state-sources.js');
  const rows = [];
  for (const code of STATE_CODES) {
    for (const id of LAYER_IDS) {
      const l = layerFor(code, id);
      if (!isBrowserFetchable(l) || !l.fields || !Object.keys(l.fields).length) continue;
      rows.push({ code, id, layer: l });
    }
  }
  const out = [];
  const worker = async () => {
    for (let r = rows.shift(); r; r = rows.shift()) {
      const q = queryUrl(r.layer);
      const meta = await get(q.replace(/\/query$/, ''), {});
      if (!meta.ok || !meta.body || meta.body.error) {
        out.push({ entry: `${r.code}.${r.id}`, problem: 'unreachable', detail: meta.error || meta.body?.error?.message || `status ${meta.status}` });
        continue;
      }
      const real = new Set((meta.body.fields || []).map((f) => f.name));
      const named = Object.values(r.layer.fields).filter((f) => typeof f === 'string');
      const missing = named.filter((f) => !real.has(f));
      if (missing.length) out.push({ entry: `${r.code}.${r.id}`, problem: 'field does not exist', missing, real: [...real].slice(0, 40) });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}

if (process.argv.includes('--audit')) {
  console.log(JSON.stringify(await audit(), null, 1));
  process.exit(0);
}

const state = arg('state'), family = arg('family');
const entry = state && family ? layerFor(state, family) : null;
const url = arg('url') || (entry && entry.url);
if (!url) { console.error('no url: give --url, or a --state/--family pair the catalogue already records'); process.exit(1); }
const layerId = arg('layer') ?? (entry ? entry.layerId : null);
const query = queryUrl({ url, layerId });

const out = { state, family, query, measuredOn: new Date().toISOString().slice(0, 10) };
const meta = await get(query.replace(/\/query$/, ''), {});
out.reachable = meta.ok && !meta.body?.error;
out.cors = corsWord(meta.cors);
out.error = meta.error || meta.body?.error?.message || null;
if (out.reachable) {
  out.name = meta.body.name;
  out.geometryType = meta.body.geometryType;
  out.maxRecordCount = meta.body.maxRecordCount;
  out.fields = (meta.body.fields || []).map((f) => f.name);
  const all = await get(query, { where: '1=1', returnCountOnly: 'true' });
  out.count = all.body?.count ?? null;
  const bbox = arg('bbox');
  if (bbox) {
    const inBox = await get(query, {
      geometry: bbox, geometryType: 'esriGeometryEnvelope', inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', where: '1=1', returnCountOnly: 'true',
    });
    out.bbox = bbox; out.countInBbox = inBox.body?.count ?? null;
  }
  const field = arg('values');
  if (field) out.values = await distinctValues(query, field);
}
console.log(JSON.stringify(out, null, 2));
