// The per-state place shards (places-index.json + places-<ST>.json, W1's contract) as the
// dashboard's browser tests serve them: window.fetch is patched before the page's own script
// runs, so no real request leaves the box and the shard content is a fixed fixture rather
// than live pipeline output. Shard shape: {state, fields:[...], places:[[...], ...]} with
// `fields` naming the columns of each compact row; index shape: {ST: {bbox, count}} with
// bbox = [west, south, east, north].
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { findChromium, launch } from './browser.mjs';
import { startSiteServer, siteIsBuilt } from './site-server.mjs';
import { readyDashboard } from './waits.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const load = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));

export const MACON = load('places-NC.macon.json');
export const STEVENSVILLE = load('places-MT.stevensville.json');
/** places-national.json: the head of the same ranking with a state column, one fetch from the
 *  first label zoom. Asheville is also in no fixture shard unless a test puts it there; Bismarck's
 *  state is not in INDEX at all, so no shard can ever replace it. */
export const NATIONAL = load('places-national.json');

/** State extents wide enough to hold their fixture places (public geography). */
export const INDEX = {
  NC: { bbox: [-84.33, 33.84, -75.46, 36.59], count: MACON.places.length },
  MT: { bbox: [-116.05, 44.36, -104.04, 49.0], count: STEVENSVILLE.places.length },
};

/** The one candidates.json row the fixtures overlap: Highlands NC is also in the shard. */
export const HIGHLANDS_CANDIDATE = {
  fips: '3731360', name: 'Highlands town', state: 'NC', county_fips: '37113',
  population: 1119, lat: 35.053845, lon: -83.197579, county_name: 'Macon County',
  stability_score: 80, distance_to_metro_mi: 40, nearest_metro: 'Test City',
  sprawl_risk: 10, affordability_score: 85, quietness_score: 90, overall_score: 88,
};

export const CEILING = 20000;

/** shardStatus: HTTP status every places-* request answers with (200 serves the fixtures). */
export function patchSource({ shardStatus = 200, shards = { NC: MACON, MT: STEVENSVILLE }, candidates = [HIGHLANDS_CANDIDATE], national = NATIONAL } = {}) {
  return `(() => {
  const index = ${JSON.stringify(INDEX)};
  const national = ${JSON.stringify(national)};
  const shards = ${JSON.stringify(shards)};
  const candidates = ${JSON.stringify(candidates)};
  const status = ${shardStatus};
  const real = window.fetch.bind(window);
  window.__placeUrls = [];
  const json = (body, st = 200) => Promise.resolve(new Response(JSON.stringify(body), {
    status: st, headers: { 'content-type': 'application/json' } }));
  window.fetch = function(input, init) {
    const url = String(input && input.url ? input.url : input);
    if (url.endsWith('/data/quiet-corners/candidates.json')) return json(candidates);
    const m = url.match(/\\/data\\/quiet-corners\\/places-([A-Za-z]+)\\.json$/);
    if (m) {
      window.__placeUrls.push(m[1]);
      if (status !== 200) return Promise.resolve(new Response('boom', { status }));
      if (m[1] === 'index') return json(index);
      if (m[1] === 'national') return json(national);
      return shards[m[1]] ? json(shards[m[1]]) : Promise.resolve(new Response('', { status: 404 }));
    }
    return real(input, init);
  };
})()`;
}

export const CHROMIUM = findChromium();
export const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

/** Open the dashboard with the patch installed first, run fn(page), tear down. */
export async function withShardedMap(options, fn) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', { viewport: { width: 1440, height: 1000 }, args: ['--hide-scrollbars'] });
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: patchSource(options) });
    await page.navigate(`${site.origin}/quiet-corners/`);
    await readyDashboard(page, { data: true, ms: CEILING });
    return await fn(page);
  } finally { page.close(); await site.close(); }
}

/** Move the map to lat/lon/zoom, wait for the move and for any shard fetch the move began,
 *  and report the labels now on the map. */
export const labelsAt = (lat, lon, z) => `(async () => {
  const settled = qcMoves();
  window.qcMap.setView([${lat}, ${lon}], ${z}, { animate: false });
  await settled('the map settled at zoom ${z}');
  // A shard fetch is un-awaited by the map; give the network and the redraw it triggers a beat.
  await new Promise((r) => setTimeout(r, 400));
  const els = [...document.querySelectorAll('.qc-place-label')];
  return {
    texts: els.map((e) => e.textContent.trim()),
    tiers: els.map((e) => e.getAttribute('data-tier')),
    townLabels: window.qcTownLabels,
    urls: window.__placeUrls,
  };
})()`;
