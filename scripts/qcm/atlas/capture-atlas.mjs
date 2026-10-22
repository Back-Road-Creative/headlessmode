#!/usr/bin/env node
// QQA-06b capture: the base-map comparison atlas against the REAL USGS tile services.
// NOT a test (needs the internet; CI never runs it). Visits six named public landmarks in the
// built Quiet Corners page at one viewport and zoom, shows every base with the county wash
// off then on, and times, screenshots and measures each. Writes atlas.json, REPORT.md and
// shots/ to a directory; nothing enters the repo (copy REPORT.md in by hand).
//   node scripts/qcm/atlas/capture-atlas.mjs [--out DIR] [--zoom N] [--scenes id,id]
// launch() passes the offline host-resolver flag and the last such flag wins, so this run's
// own replaces it: the browser reaches the tile hosts, the page comes from 127.0.0.1.
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findChromium, launch } from '../helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from '../helpers/site-server.mjs';
import { readyDashboard } from '../helpers/waits.mjs';
import { SOURCES } from '../../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { classifyRegion, cropImage, distinctness, labelContrast } from './atlas-metrics.mjs';
import { renderReport, summarise, TILE_BASES, PAIRS, pairKey } from './atlas-report.mjs';
import { attach } from './side-client.mjs';
import { choose, shot, TILES, waitFor } from './page-probes.mjs';

/** Six fixed scenes: public landmarks or named towns, never a private address. */
export const SCENES = Object.freeze([
  { id: 'clingmans-dome', landmark: 'Clingmans Dome observation tower, Great Smoky Mountains (steep forested ridges)', at: [35.5628, -83.4985] },
  { id: 'willis-tower', landmark: 'Willis Tower, Chicago (dense city, lakefront)', at: [41.8789, -87.6359] },
  { id: 'colfax-il', landmark: 'Colfax, Illinois (flat cropland in a regular grid)', at: [40.5686, -88.6153] },
  { id: 'cape-hatteras', landmark: 'Cape Hatteras Lighthouse, North Carolina (barrier island, open water)', at: [35.2518, -75.5286] },
  { id: 'mount-rainier', landmark: 'Mount Rainier summit, Washington (glacier, high relief)', at: [46.8523, -121.7603] },
  { id: 'adak-island', landmark: 'Adak Island, Alaska (far west Aleutians, near the dateline)', at: [51.88, -176.658] },
]);
const VIEWPORT = { width: 1280, height: 1000 };
const MIN_TILE_VISIBLE = 64;   // px of a tile that must show in the map box to be judged

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const outDir = path.resolve(opt('out', path.join(os.tmpdir(), `qcm-atlas-${new Date().toISOString().replace(/[:.]/g, '-')}`)));
const zoom = Number(opt('zoom', 8));
const wanted = opt('scenes', null)?.split(',');
const scenes = wanted ? SCENES.filter((s) => wanted.includes(s.id)) : SCENES;
if (!scenes.length) { console.error(`no scene matches --scenes ${wanted}; known: ${SCENES.map((s) => s.id).join(', ')}`); process.exit(2); }

const CHROMIUM = findChromium();
if (!CHROMIUM) { console.error('no Chromium: set CHROME_PATH'); process.exit(2); }
if (!siteIsBuilt('quiet-corners')) { console.error('public/quiet-corners/ is not built: npm run build:css && bash scripts/build-site.sh --configDir site-config --minify'); process.exit(2); }

const serviceOf = (id) => /\/services\/([^/]+)\/MapServer/.exec(SOURCES[id].tile.urlTemplate)[1];
const baseOfUrl = (url) => TILE_BASES.find((id) => url.includes(`/services/${serviceOf(id)}/MapServer/`)) ?? null;

/** Every tile has finished (loaded or failed), the ones that loaded are fully faded in, and
 *  nothing changed since the last poll: the picture is the final one. */
const settled = (page, id) => waitFor(page, `${id}'s tiles to finish and the picture to stop changing`, `(() => {
  const t = ${TILES}, now = JSON.stringify([t.polygons, t.imgs.map((i) => [i.done, i.opacity, i.layerOpacity])]);
  const still = window.__atlasLast === now;
  window.__atlasLast = now;
  const fine = ${JSON.stringify(id)} === 'none' ? t.imgs.length === 0 : t.imgs.length > 0 && t.layers === 1 && t.imgs.every((i) => i.done && (!i.ok || (i.opacity === 1 && i.layerOpacity === 1)));
  return still && fine;
})()`);

/** The metrics read the BASE alone: the map's chrome (controls, legend, labels, markers,
 *  outlines) is identical on every base and would make any two look alike. Only the county
 *  pane is kept, and only with scores on, because the wash is what that mode measures. */
const CLEAN_CSS = `.atlas-clean-host > :not(.atlas-clean) { visibility: hidden !important; }
.atlas-clean > :not(.leaflet-map-pane) { visibility: hidden !important; }
.atlas-clean .leaflet-map-pane > .leaflet-pane:not(.leaflet-tile-pane) { visibility: hidden !important; }
.atlas-clean.atlas-keep-counties .leaflet-map-pane > .leaflet-qc-counties-pane { visibility: visible !important; }`;
const installClean = (page) => page.evaluate(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(CLEAN_CSS)}; document.head.appendChild(s); window.qcMap.getContainer().classList.add('atlas-clean'); window.qcMap.getContainer().parentElement.classList.add('atlas-clean-host'); })()`);
const keepCounties = (page, on) => page.evaluate(`(() => { window.qcMap.getContainer().classList.toggle('atlas-keep-counties', ${on}); })()`);

/** One base in one scene, in the current score setting: time it, photograph it, judge its tiles. */
async function capture(page, net, id, withTiles) {
  const from = net.length, t0 = performance.now();
  await choose(page, 'base', id);
  await settled(page, id);
  const ms = performance.now() - t0;
  const t = await page.evaluate(TILES);
  const { buf, img } = await shot(page);
  const result = { ms, contrast: labelContrast(img), polygons: t.polygons, foreign: t.imgs.filter((i) => id !== 'none' && baseOfUrl(i.src) !== id).length };
  if (withTiles) {
    const tiles = { total: t.imgs.length, failed: 0, blank: 0, placeholder: 0, judged: 0, reasons: {} };
    for (const i of t.imgs) {
      if (!i.ok) { tiles.failed++; continue; }
      const rect = { x: i.left, y: i.top, width: i.width, height: i.height };
      const crop = cropImage(img, rect);
      if (crop.width < MIN_TILE_VISIBLE || crop.height < MIN_TILE_VISIBLE) continue;
      tiles.judged++;
      const v = classifyRegion(crop);
      if (v.verdict !== 'ok') { tiles[v.verdict]++; tiles.reasons[v.reason] = (tiles.reasons[v.reason] ?? 0) + 1; }
    }
    result.tiles = tiles;
    const mine = net.slice(from).filter((e) => id !== 'none' && baseOfUrl(e.url) === id);
    result.http = { requests: mine.length, bad: mine.filter((e) => e.failed || e.status >= 400).length, statuses: [...new Set(mine.map((e) => e.failed ? 'failed' : e.status))] };
  }
  return { result, buf, img };
}

async function main() {
  mkdirSync(path.join(outDir, 'shots'), { recursive: true });
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', { viewport: VIEWPORT, timeoutMs: 120000, args: ['--hide-scrollbars', '--host-resolver-rules=MAP atlas-capture.invalid atlas-capture.invalid'] });
  const side = await attach(page.port);
  const net = [], urlOf = new Map();
  side.on('Network.requestWillBeSent', ({ requestId, request }) => { if (baseOfUrl(request.url)) urlOf.set(requestId, request.url); });
  side.on('Network.responseReceived', ({ requestId, response }) => { if (urlOf.has(requestId)) net.push({ url: urlOf.get(requestId), status: response.status }); });
  side.on('Network.loadingFailed', ({ requestId, errorText }) => { if (urlOf.has(requestId)) net.push({ url: urlOf.get(requestId), failed: errorText }); });
  await side.send('Network.enable', {});
  const results = { generated: new Date().toISOString().slice(0, 10), viewport: VIEWPORT, zoom, scenes: [] };
  try {
    await page.navigate(`${site.origin}/quiet-corners/`);
    await readyDashboard(page, { data: false, ms: 90000 });
    await installClean(page);
    for (const sc of scenes) {
      const entry = { id: sc.id, name: sc.id, landmark: sc.landmark, at: sc.at, pairs: { off: {}, on: {} }, bases: {} };
      results.scenes.push(entry);
      try {
        // No base while the map moves, so the first base of the scene is fetched cold and timed.
        await choose(page, 'context', 'none');
        await choose(page, 'base', 'none');
        await settled(page, 'none');
        await page.evaluate(`(() => { window.qcMap.setView(${JSON.stringify(sc.at)}, ${zoom}, { animate: false }); })()`);
        await page.evaluate(`window.qcMeasured(${JSON.stringify(`the map to settle on ${sc.id}`)})`);
        const shots = { off: {}, on: {} };
        for (const [mode, context] of [['off', 'none'], ['on', 'countyScore']]) {
          await choose(page, 'context', context);
          await keepCounties(page, mode === 'on');
          for (const id of [...TILE_BASES, 'none']) {
            const { result, buf, img } = await capture(page, net, id, mode === 'off');
            entry.bases[id] = { ...entry.bases[id], [mode]: result };
            shots[mode][id] = img;
            writeFileSync(path.join(outDir, 'shots', `${sc.id}-${id}-${mode}.png`), buf);
            if (result.foreign) throw new Error(`${id}, scores ${mode}: ${result.foreign} tile images from another base are on the map`);
          }
        }
        for (const mode of ['off', 'on']) for (const [a, b] of PAIRS) {
          entry.pairs[mode][pairKey(a, b)] = distinctness(shots[mode][a], shots[mode][b]);
        }
        console.error(`${sc.id}: measured`);
      } catch (err) {
        entry.error = err.message.split('\n')[0];
        delete entry.pairs; delete entry.bases;
        console.error(`${sc.id}: NOT MEASURED, ${entry.error}`);
      }
    }
  } finally { side.close(); page.close(); await site.close(); }
  results.summary = summarise(results);
  writeFileSync(path.join(outDir, 'atlas.json'), JSON.stringify(results, null, 2));
  writeFileSync(path.join(outDir, 'REPORT.md'), renderReport(results));
  console.log(outDir);
  if (results.scenes.every((s) => s.error)) process.exitCode = 1;
}
main().catch((err) => { console.error(err.stack ?? err); process.exit(1); });
