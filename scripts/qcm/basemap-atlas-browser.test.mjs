// QQA-06b: the base-map atlas on the BUILT page with synthetic tiles, no network. For every
// base in BASES, scores off and on, from the tile <img> boxes and a screenshot's pixels: only
// that base's tiles show (also after rapid toggling with answers in flight), they cover the
// asked bounds at their own z/x/y, and the F29 wash is 0 off and 06a's cap on, topo lettering
// holding 3:1. Each base's tile carries a marker colour only it uses: "which base" is a pixel count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard } from './helpers/waits.mjs';
import { settlePaused } from './helpers/paused-request.mjs';
import { contextFillFromSource, contrastRatio, hexToRgb } from './helpers/contrast.mjs';
import { BASES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-basemaps.js';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { classifyRegion, cropImage, labelContrast } from './atlas/atlas-metrics.mjs';
import { decodePng, encodePng } from './atlas/png.mjs';
import { attach } from './atlas/side-client.mjs';
import { choose, shot, TILES, waitFor } from './atlas/page-probes.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const CEILING = 30000;
const TILE_BASES = BASES.filter((b) => SOURCES[b.id]?.tile);
const FILL = contextFillFromSource();

// --- the tiles: a function of (base, z, x, y), served by a Fetch interception ------------
const PAPER = [232, 228, 216], INK = [51, 51, 51];
const MARKER = { usgsTopo: [250, 10, 200], usgsImagery: [10, 250, 200], usgsShadedRelief: [250, 200, 10] };
const hash = (a, b) => { let h = Math.imul(a, 374761393) ^ Math.imul(b, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return (h ^ (h >>> 16)) >>> 0; };
function tileImage(id, z, tx, ty) {
  const data = new Uint8Array(256 * 256 * 4);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const gx = tx * 256 + x, gy = ty * 256 + y;
    let c;
    if (x >= 2 && x < 14 && y >= 2 && y < 14) c = MARKER[id];
    else if (id === 'usgsTopo') c = (gy % 16 >= 6 && gy % 16 < 8 && gx % 5 !== 0) ? INK : PAPER;     // dashed lettering on paper
    else if (id === 'usgsImagery') { const n = hash(gx >> 1, gy >> 1) % 41; c = [20 + n / 2, 60 + n, 25 + n / 2]; }
    else { const v = 150 + 50 * Math.sin(gx / 37) * Math.cos(gy / 29); c = [v, v, v + 14]; }         // soft grey-blue relief
    const i = (y * 256 + x) * 4;
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  }
  return encodePng({ width: 256, height: 256, data });
}
const serviceOf = (id) => /\/services\/([^/]+)\/MapServer/.exec(SOURCES[id].tile.urlTemplate)[1];
const baseOfUrl = (url) => TILE_BASES.find((b) => url.includes(`/services/${serviceOf(b.id)}/MapServer/`))?.id ?? null;
const TILE_HOSTS = [...new Set(TILE_BASES.map((b) => new URL(SOURCES[b.id].tile.urlTemplate.replace(/\{.\}/g, '0')).origin))];

/** Answers every request to a USGS tile host with a synthetic tile after `delayMs`, so a
 *  toggle can leave answers in flight; records what was asked. */
async function serveTiles(page, { delayMs = 0 } = {}) {
  const side = await attach(page.port);
  const asked = [], cache = new Map();
  side.on('Fetch.requestPaused', async ({ requestId, request }) => {
    const id = baseOfUrl(request.url), m = /\/tile\/(\d+)\/(\d+)\/(\d+)$/.exec(request.url);
    if (!id || !m) { await settlePaused(side.send, 'Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }); return; }
    asked.push({ id, z: +m[1], y: +m[2], x: +m[3] });
    const key = `${id}/${m[1]}/${m[3]}/${m[2]}`;
    if (!cache.has(key)) cache.set(key, tileImage(id, +m[1], +m[3], +m[2]).toString('base64'));
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    await settlePaused(side.send, 'Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'image/png' }], body: cache.get(key) });
  });
  await side.send('Fetch.enable', { patterns: TILE_HOSTS.map((h) => ({ urlPattern: `${h}/*`, requestStage: 'Request' })) });
  return { asked, close: () => side.close() };
}

// --- the counties: three boxes near Sylva NC (public geography; no one's address) ---------
// Jackson 37099 is scored and rural, Haywood 37087 an unscored context county, Macon 37113
// is in geo.json but not counties.json: a rural county with no highlight over its wash.
const ring = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const TOPO = {
  type: 'Topology',
  arcs: [ring(-83.4, 35.2, -83.0, 35.5), ring(-83.0, 35.2, -82.7, 35.5), ring(-83.4, 35.5, -83.0, 35.8)],
  objects: {
    counties: { type: 'GeometryCollection', geometries: ['37099', '37087', '37113'].map((id, i) => ({ type: 'Polygon', id, arcs: [[i]] })) },
    states: { type: 'GeometryCollection', geometries: [{ type: 'Polygon', id: '37', arcs: [[0]] }] },
  },
};
const GEO = [{ fips: '37099', lat: 35.35, lon: -83.2, stability_score: 80, sprawl_risk: 5, overall_score: 80 }, { fips: '37113', lat: 35.65, lon: -83.2, stability_score: 70, sprawl_risk: 5, overall_score: 70 }];
const COUNTIES = [{
  fips: '37099', state: 'NC', name: 'Jackson County', population: 43000, rucc: 7, stability_score: 80, sprawl_risk: 5,
  nearest_metro: 'Asheville city', distance_to_metro_mi: 120, affordability_score: 80, quietness_score: 80, overall_score: 80,
}];
const PATCH = `(() => {
  const answers = ${JSON.stringify({ 'counties-10m.json': TOPO, 'geo.json': GEO, 'counties.json': COUNTIES })};
  window.fetch = (url) => {
    const hit = Object.keys(answers).find((n) => String(url).endsWith('/' + n));
    return Promise.resolve(new Response(JSON.stringify(hit ? answers[hit] : {}), { status: 200, headers: { 'content-type': 'application/json' } }));
  };
})()`;
const ASKED = [[35.2, -83.4], [35.8, -82.7]];   // [[south, west], [north, east]]: the three boxes
const OTHER_AT = [35.35, -82.85], RURAL_AT = [35.65, -83.2];

// --- page-side measurements ---------------------------------------------------------------
/** Every tile loaded and the fade-in stopped (opacities read the same on two polls). */
const settled = (page, id) => waitFor(page, `${id}'s tiles to be painted, loaded and still`, `(() => {
  const t = ${TILES}, now = JSON.stringify(t.imgs.map((i) => [i.opacity, i.layerOpacity]));
  const still = window.__atlasLast === now;
  window.__atlasLast = now;
  return still && t.imgs.every((i) => i.ok) && (${JSON.stringify(id)} === 'none' ? t.imgs.length === 0 : t.imgs.length > 0 && t.layers === 1);
})()`);

/** How many pixels of `img` are (within 2 per channel) the colour of `rgb`. */
function countColour(img, rgb) {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) if (Math.abs(img.data[i] - rgb[0]) <= 2 && Math.abs(img.data[i + 1] - rgb[1]) <= 2 && Math.abs(img.data[i + 2] - rgb[2]) <= 2) n++;
  return n;
}
/** Pixels of each base's marker; with a wash on, also the marker as the wash leaves it. */
const markers = (img, washes = []) => Object.fromEntries(Object.entries(MARKER).map(([id, rgb]) => [id,
  countColour(img, rgb) + washes.reduce((n, [fill, strength]) => n + countColour(img, rgb.map((v, c) => v * (1 - strength) + fill[c] * strength)), 0)]));
const project = (page, at) => page.evaluate(`(() => { const p = window.qcMap.latLngToContainerPoint(${JSON.stringify(at)}); return [p.x, p.y]; })()`);
const lonOf = (x, z) => (x / 2 ** z) * 360 - 180;
const latOf = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

/** What the page shows for `id`: one layer, only its tiles, all at full opacity, loaded; and
 *  in the pixels only its marker. */
async function assertShows(page, id, why) {
  await settled(page, id);
  const t = await page.evaluate(TILES);
  // With scores on, the county wash paints over the tiles: look for the marker through it.
  const pane = await page.evaluate('Number(getComputedStyle(window.qcMap.getPane("qc-counties")).opacity)');
  const scored = await page.evaluate('document.getElementById("qcm-context-countyScore").checked');
  const washes = scored ? [[hexToRgb('#12121e'), FILL.other * pane], [hexToRgb('#1a2a3a'), FILL.rural * pane]] : [];
  // The compositor can lag the DOM: re-shoot until the base's own marker shows, then judge that.
  let img, m;
  for (let tries = 0; tries < 12; tries++) {
    img = (await shot(page)).img; m = markers(img, washes);
    if (id === 'none' ? Object.values(m).every((n) => n === 0) : m[id] > 20) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (id === 'none') {
    assert.equal(t.imgs.length, 0, `${why}: "No base map" left ${t.imgs.length} tile images on the map`);
    assert.deepEqual(m, { usgsTopo: 0, usgsImagery: 0, usgsShadedRelief: 0 }, `${why}: no base, yet a base's tiles are in the pixels`);
    return { t, img };
  }
  const foreign = t.imgs.filter((i) => baseOfUrl(i.src) !== id);
  assert.deepEqual(foreign.map((i) => i.src), [], `${why}: ${foreign.length} stale tile images from another base`);
  assert.ok(t.imgs.every((i) => i.layerOpacity === 1), `${why}: the base is dimmed (layer opacity ${[...new Set(t.imgs.map((i) => i.layerOpacity))]})`);
  assert.equal(t.layers, 1, `${why}: ${t.layers} tile layers are mounted`);
  assert.ok(m[id] > 20, `${why}: ${id}'s marker is in only ${m[id]} pixels`);
  for (const other of Object.keys(MARKER).filter((k) => k !== id)) assert.equal(m[other], 0, `${why}: ${other}'s tiles are still in the pixels (${m[other]})`);
  assert.equal(classifyRegion(img).verdict, 'ok', `${why}: the map region reads as ${classifyRegion(img).verdict}`);
  return { t, img };
}

async function withAtlas(fn, { delayMs = 0 } = {}) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', { viewport: { width: 1280, height: 1000 }, args: ['--hide-scrollbars'] });
  let served;
  try {
    served = await serveTiles(page, { delayMs });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PATCH });
    await page.navigate(`${site.origin}/quiet-corners/`);
    await readyDashboard(page, { data: false, ms: CEILING });
    await waitFor(page, 'the county fixture drew its shapes', `(() => { let n = 0; window.qcMap.eachLayer((l) => { if (l instanceof L.Polygon) n++; }); return n >= 3; })()`);
    return await fn(page, served);
  } finally { served?.close(); page.close(); await site.close(); }
}

test('the app offers the bases source-basemaps.js lists; each shows only its own tiles over the asked extent, scores off and on', { skip }, async () => {
  await withAtlas(async (page) => {
    const offered = await page.evaluate(`[...document.querySelectorAll('input[name="qcm-base"]')].map((r) => r.id.replace('qcm-base-', ''))`);
    assert.deepEqual(offered, BASES.map((b) => b.id));
    assert.deepEqual(TILE_BASES.map((b) => b.id), ['usgsTopo', 'usgsImagery', 'usgsShadedRelief'], 'the three tile bases the atlas draws');
    await page.evaluate(`(() => { window.qcMap.fitBounds(${JSON.stringify(ASKED)}, { animate: false }); })()`);
    await page.evaluate('window.qcMeasured("the map settled on the asked bounds")');
    for (const scores of ['countyScore', 'none']) {
      await choose(page, 'context', scores);
      for (const { id } of BASES) {
        const why = `${id}, scores ${scores === 'none' ? 'off' : 'on'}`;
        await choose(page, 'base', id);
        const { t } = await assertShows(page, id, why);
        if (id === 'none') continue;
        // Extent, from the boxes the browser drew: the tiles cover the whole map box ...
        for (const [fx, fy] of [[0.02, 0.02], [0.98, 0.02], [0.02, 0.98], [0.98, 0.98], [0.5, 0.5]]) {
          const x = fx * t.width, y = fy * t.height;
          assert.ok(t.imgs.some((i) => x >= i.left && x < i.left + i.width && y >= i.top && y < i.top + i.height), `${why}: no tile covers the map at (${Math.round(x)}, ${Math.round(y)})`);
        }
        // ... each sits where its own z/x/y puts it on the globe (within 1.5 px of arc) ...
        const picks = [t.imgs[0], t.imgs[Math.floor(t.imgs.length / 2)], t.imgs[t.imgs.length - 1]];
        for (const i of picks) {
          const [, z, y, x] = /\/tile\/(\d+)\/(\d+)\/(\d+)$/.exec(i.src).map(Number);
          const at = await page.evaluate(`(() => { const p = window.qcMap.containerPointToLatLng([${i.left}, ${i.top}]); return [p.lat, p.lng]; })()`);
          const px = 360 / (256 * 2 ** z) * 1.5;
          assert.ok(Math.abs(at[1] - lonOf(x, z)) < px, `${why}: tile ${z}/${y}/${x} is drawn at longitude ${at[1]}, its own address says ${lonOf(x, z)}`);
          assert.ok(Math.abs(at[0] - latOf(y, z)) < px * 1.5, `${why}: tile ${z}/${y}/${x} is drawn at latitude ${at[0]}, its own address says ${latOf(y, z)}`);
        }
      }
    }
    // ... and the view holds the bounds that were asked for, filling a real share of the box.
    const view = await page.evaluate('(() => { const b = window.qcMap.getBounds(); return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]; })()');
    assert.ok(view[0] <= ASKED[0][0] && view[1] <= ASKED[0][1] && view[2] >= ASKED[1][0] && view[3] >= ASKED[1][1], `the view ${view} does not contain the asked bounds ${JSON.stringify(ASKED)}`);
    const share = Math.max((ASKED[1][0] - ASKED[0][0]) / (view[2] - view[0]), (ASKED[1][1] - ASKED[0][1]) / (view[3] - view[1]));
    assert.ok(share > 0.7, `the asked bounds fill only ${share.toFixed(2)} of the view in their longer axis: the extent is wrong`);
  });
});

for (const [name, opts] of [['immediately', { stagger: 0, delayMs: 0 }], ['with tile answers still in flight', { stagger: 20, delayMs: 150 }]]) {
  test(`rapid base toggling ${name} leaves no stale tiles from an earlier base`, { skip }, async () => {
    await withAtlas(async (page) => {
      await page.evaluate('(() => { window.qcMap.setView([35.5, -83.05], 10, { animate: false }); })()');
      const ids = BASES.map((b) => b.id);
      for (const final of ids) {
        // Every base in turn, back and forth twice, ending on `final`.
        const order = [...ids, ...ids.slice().reverse(), ...ids, final];
        await page.evaluate(`(async () => {
          for (const id of ${JSON.stringify(order)}) {
            const r = document.getElementById('qcm-base-' + id);
            r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true }));
            if (${opts.stagger}) await new Promise((ok) => setTimeout(ok, ${opts.stagger}));
          }
        })()`);
        await assertShows(page, final, `after toggling ${order.length} times, ending on ${final}`);
      }
    }, { delayMs: opts.delayMs });
  });
}

test('F29: scores off the base reads through at full strength; scores on, the wash is the declared cap and lettering holds 3:1', { skip }, async () => {
  await withAtlas(async (page) => {
    // Zoom 8: the county pane is at opacity 1, the strongest wash a reader meets.
    await page.evaluate('(() => { window.qcMap.setView([35.5, -83.05], 8, { animate: false }); })()');
    await page.evaluate('window.qcMeasured("the map settled at zoom 8")');
    const paneOpacity = await page.evaluate('Number(getComputedStyle(window.qcMap.getPane("qc-counties")).opacity)');
    assert.equal(paneOpacity, 1, 'zoom 8 is below the field zoom, so the county pane is not stepped back');
    const probes = { other: await project(page, OTHER_AT), rural: await project(page, RURAL_AT) };
    const ring = ([x, y]) => [[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6]].map(([dx, dy]) => [Math.round(x + dx), Math.round(y + dy)]);
    const px = (img, [x, y]) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));
    const countyBox = async (at) => { const [x, y] = await project(page, at); return { x: x - 20, y: y - 20, width: 40, height: 40 }; };
    for (const { id } of TILE_BASES) {
      await choose(page, 'context', 'none');
      await choose(page, 'base', id);
      const off = (await assertShows(page, id, `${id}, scores off`)).img;
      await waitFor(page, 'the county fill to be 0', `(() => { let n = 0, ok = true; window.qcMap.eachLayer((l) => { const o = l.options || {}; if (l instanceof L.Polygon && o.pane === 'qc-counties' && o.fill !== false) { n++; if (o.fillOpacity !== 0) ok = false; } }); return n >= 3 && ok; })()`);
      await choose(page, 'context', 'countyScore');
      await waitFor(page, 'the score wash to be drawn', `(() => { let hit = false; window.qcMap.eachLayer((l) => { if (l.options && l.options.fillColor === '#12121e' && l.options.fillOpacity > 0) hit = true; }); return hit; })()`);
      const on = (await assertShows(page, id, `${id}, scores on`)).img;
      // The pixel under each wash is the base's pixel pulled toward the fill by the declared strength.
      for (const [kind, hex, strength] of [['other', '#12121e', FILL.other], ['rural', '#1a2a3a', FILL.rural]]) {
        const fill = hexToRgb(hex);
        for (const p of ring(probes[kind])) {
          const want = px(off, p).map((v, c) => v * (1 - strength) + fill[c] * strength);
          const got = px(on, p);
          assert.ok(got.every((v, c) => Math.abs(v - want[c]) <= 3), `${id}: the ${kind} wash at ${p} is ${got}, the declared ${strength} strength over the base should give ${want.map(Math.round)}`);
        }
      }
      if (id !== 'usgsTopo') continue;
      // Lettering stand-in: the topo tile's #333 dashes on paper; on, still 3:1 and never better than off.
      const bare = contrastRatio(INK, PAPER);
      for (const kind of ['other', 'rural']) {
        const box = await countyBox(kind === 'other' ? OTHER_AT : RURAL_AT);
        const cOff = labelContrast(off, box).ratio, cOn = labelContrast(on, box).ratio;
        assert.ok(Math.abs(cOff - bare) < 0.4, `scores off, ${kind}: lettering reads ${cOff.toFixed(2)}:1, the tile's own is ${bare.toFixed(2)}:1`);
        assert.ok(cOn >= 3, `scores on, ${kind}: lettering is down to ${cOn.toFixed(2)}:1 through the wash`);
        assert.ok(cOn < cOff, `scores on, ${kind}: the wash did not change the lettering contrast (${cOn.toFixed(2)} vs ${cOff.toFixed(2)})`);
      }
    }
  });
});
