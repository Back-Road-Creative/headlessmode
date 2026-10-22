// QQA-06c slice 2: road names in the 3D view, proved in the real built page against the real
// vendored MapLibre. terrain-road-names.test.mjs holds the pure pieces and the panel's road
// pass against a fake renderer; what only a browser can show is here: the labels that land over
// the relief are the lettering 2D uses (amber on a plate, the label-size setting's pixels, upright,
// clear of the map's own controls), the loading / error / empty words, the credit, that roads off
// in 2D means none in 3D, and that a trip to 3D leaves the 2D labels as they were.
// The transportation service is the Sylva NC town-centre fixture (a public place, no one's
// address) from road-labels-browser.test.mjs; the DEM and topo hosts are unreachable on purpose
// (OFFLINE_ARGS), which MapLibre tolerates -- these proofs are about the lettering, not the relief.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage } from './helpers/waits.mjs';
import { groupRoads } from '../../themes/headlessmode/static/js/quiet-corners-maps/road-names.js';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const CEILING = 30000;
const FIX = JSON.parse(readFileSync(new URL('./fixtures/road-names-sylva.json', import.meta.url), 'utf8'));
const labelsOf = (layers) => new Set(groupRoads(layers.flatMap((n) => FIX.layers[n].features.map((f) => ({ ...f, layer: Number(n) })))).map((e) => e.label));
/** Every label the fixture could produce, and those only a local road (layer 32) can. */
const KNOWN = labelsOf(Object.keys(FIX.layers));
const LOCAL_ONLY = new Set([...labelsOf(['32'])].filter((l) => !labelsOf(['29', '30', '31', '35']).has(l)));
const SYLVA = [35.375, -83.218, 14];
// The topo base's own credit also names "National Transportation Dataset", so the roads credit is told
// apart by its whole sentence, not by a phrase the base shares.
const ROAD_CREDIT = SOURCES.usgsRoadNames.attribution;
const creditText = (page) => page.evaluate("document.querySelector('.qc-terrain-canvas .maplibregl-ctrl-attrib').textContent");

const SHARD_LAG_MS = 2500;
const PATCH_SOURCE = `(() => {
  const SHARD_LAG_MS = ${SHARD_LAG_MS};
  const fix = ${JSON.stringify(FIX.layers)};
  const real = window.fetch.bind(window);
  window.__roadMode = 'ok'; window.__roadReqs = []; window.__placesPending = 0;
  const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  window.fetch = function(input, init) {
    const url = String(input && input.url ? input.url : input);
    // The per-state place shard lands after the road labels, as it did on a loaded CI runner: a
    // town label it brings (Dillsboro) then takes a road label's room. The 2D -> 3D -> 2D proof
    // must snapshot 2D after that, not before.
    if (/places-[A-Za-z]+\\.json/.test(url)) {
      window.__placesPending += 1;
      const lag = /places-[A-Z]{2}\\.json/.test(url) ? SHARD_LAG_MS : 0;
      return new Promise((r) => setTimeout(r, lag)).then(() => real(input, init)).finally(() => { window.__placesPending -= 1; });
    }
    if (/(nhd|geonames)\\/MapServer\\/\\d+\\/query/.test(url)) return json(/returnCountOnly=true/.test(url) ? { count: 0 } : { features: [] });
    const m = url.match(/transportation\\/MapServer\\/(\\d+)\\/query/);
    if (!m) return real(input, init);
    window.__roadReqs.push({ layer: m[1], at: performance.now() });
    const mode = window.__roadMode;
    if (mode === 'error') return json({ error: { code: 500, message: 'stubbed' } }, 500);
    if (mode === 'empty') return json({ features: [] });
    return json({ features: fix[m[1]].features });
  };
})()`;

async function withDashboard(fn) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', { viewport: { width: 1440, height: 1000 }, args: ['--hide-scrollbars'] });
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PATCH_SOURCE });
    await page.navigate(`${site.origin}/quiet-corners/`);
    await readyDashboard(page, { ms: CEILING });
    return await fn(page);
  } finally { page.close(); await site.close(); }
}

const goTo = (page, [lat, lon, z]) => page.evaluate(`(async () => {
  const settled = qcMoves();
  window.qcMap.setView([${lat}, ${lon}], ${z}, { animate: false });
  await settled('the map settled at zoom ${z}');
  return true;
})()`);
const mode = (page, m) => page.evaluate(`(window.__roadMode = ${JSON.stringify(m)}, window.__roadReqs.length = 0, true)`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LABELS3D = '.qc-terrain-road-label';
const count3d = (page) => page.evaluate(`document.querySelectorAll('${LABELS3D}').length`);
const wait3d = (page, what, cond) => waitInPage(page, what, `(() => { const n = document.querySelectorAll('${LABELS3D}').length; return ${cond}; })()`, CEILING, null);
const noticeOf = (page) => page.evaluate(`(() => { const e = document.querySelector('.qc-terrain-notice[data-layer-id="roads"]'); return e ? e.textContent : null; })()`);
const open3d = async (page) => {
  await page.evaluate("document.querySelector('.qc-terrain-open').click()");
  await waitInPage(page, 'a canvas in the terrain dialog', "Boolean(document.querySelector('.qc-terrain-dialog canvas'))", CEILING, null);
};
const close3d = async (page) => {
  await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
  await waitInPage(page, 'the terrain dialog to hide', "document.querySelector('.qc-terrain-dialog').hidden", CEILING, null);
};
// 2D is settled when no place data is still loading and the road and town labels have read the
// same for SETTLED_MS: a town label that lands late takes a road label's room, so a snapshot taken
// before then is not the 2D the 3D trip has to give back.
const SETTLED_MS = 900;
const settled2d = (page) => waitInPage(page, '2D labels to settle', `(() => {
  const now = performance.now();
  const sig = [...document.querySelectorAll('.qcm-road-label, .qc-place-label')].map((e) => e.className + ':' + e.textContent).sort().join('|');
  const w = window.__settle2d;
  if (window.__placesPending > 0 || !w || w.sig !== sig) { window.__settle2d = { sig, at: now }; return false; }
  return now - w.at >= ${SETTLED_MS};
})()`, CEILING, null);
// What a road label must clear (road-labels.js RESERVED_SELECTORS) and the map's size and view, for
// a failure message: a label lost across the 3D trip has so far failed only on loaded CI runners.
const RESERVED_NOW = "(() => { const c = window.qcMap.getContainer(), o = c.getBoundingClientRect();" +
  " return [...c.querySelectorAll('.qc-place-label, .qcm-name-label, .qcm-name-marker-glyph, .qcm-camera-pin, .leaflet-control')]" +
  ".map((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? String(e.className).split(' ')[0] + ':' + (e.textContent||'').trim().slice(0,18) + '@' + Math.round(r.left-o.left) + ',' + Math.round(r.top-o.top) + ',' + Math.round(r.width) + 'x' + Math.round(r.height) : null; })" +
  ".filter(Boolean).sort().join(String.fromCharCode(10))" +
  " + String.fromCharCode(10) + 'size ' + JSON.stringify([window.qcMap.getSize(), window.qcMap.getCenter(), window.qcMap.getZoom()]); })()";
const READ3D = `(() => [...document.querySelectorAll('${LABELS3D}')].map((e) => {
  const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
  return { text: e.textContent, x: r.left, y: r.top, w: r.width, h: r.height, fontSize: parseFloat(cs.fontSize), color: cs.color, bg: cs.backgroundColor, transform: cs.transform };
}))()`;
const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const alphaOf = (rgba) => { const m = /rgba?\(([^)]+)\)/.exec(rgba); const p = m ? m[1].split(',') : []; return p.length > 3 ? Number(p[3]) : 1; };
/** The rotation a computed matrix(a, b, ...) stands for, in degrees. */
const degOf = (transform) => { const m = /matrix\(([^)]+)\)/.exec(transform); if (!m) return 0; const [a, b] = m[1].split(',').map(Number); return Math.atan2(b, a) * 180 / Math.PI; };

test('3D: the roads 2D letters at this view are lettered over the relief, in 2D\'s amber on a plate, upright, clear of the map controls', { skip }, async () => {
  await withDashboard(async (page) => {
    await goTo(page, SYLVA);
    await waitInPage(page, '2D road labels', "document.querySelectorAll('.qcm-road-label').length > 0", CEILING, null);
    await open3d(page);
    await wait3d(page, '3D road labels', 'n > 0');
    const labels = await page.evaluate(READ3D);
    for (const l of labels) {
      assert.ok(KNOWN.has(l.text), `"${l.text}" is not a label the fixture can produce`);
      assert.equal(l.fontSize, 14, 'normal size is 14px, the 2D default');
      assert.equal(l.color, 'rgb(253, 230, 138)', '2D\'s amber');
      assert.ok(alphaOf(l.bg) >= 0.78, `plate ${l.bg} is under alpha 0.78`);
      const deg = degOf(l.transform);
      assert.ok(deg > -90 - 1e-6 && deg <= 90 + 1e-6, `"${l.text}" is turned ${deg} degrees, not upright`);
    }
    assert.ok(labels.some((l) => LOCAL_ONLY.has(l.text)), `no local road among ${JSON.stringify(labels.map((l) => l.text))}`);
    const controls = await page.evaluate("[...document.querySelectorAll('.qc-terrain-canvas .maplibregl-ctrl')].map((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }).filter((r) => r.w > 0 && r.h > 0)");
    assert.ok(controls.length > 0, 'the 3D view has a control on screen (its credit)');
    const canvas = await page.evaluate("(() => { const r = document.querySelector('.qc-terrain-canvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()");
    for (const l of labels) {
      for (const c of controls) assert.ok(!overlaps(l, c), `"${l.text}" is drawn under a map control`);
      assert.ok(l.x >= canvas.x - 1 && l.y >= canvas.y - 1 && l.x + l.w <= canvas.x + canvas.w + 1 && l.y + l.h <= canvas.y + canvas.h + 1, `"${l.text}" is not inside the 3D view`);
    }
    for (let i = 0; i < labels.length; i += 1) for (let j = i + 1; j < labels.length; j += 1) assert.ok(!overlaps(labels[i], labels[j]), `"${labels[i].text}" overlaps "${labels[j].text}"`);
    assert.equal(await noticeOf(page), 'Road names: shown');
    assert.ok((await creditText(page)).includes(ROAD_CREDIT), 'the road source credit rides on the 3D view');
  });
});

test('3D: the Large label-size setting reaches the road labels', { skip }, async () => {
  await withDashboard(async (page) => {
    await goTo(page, SYLVA);
    await page.evaluate("window.qcSetLabelPrefs({ density: 'standard', size: 'large' })");
    await open3d(page);
    await wait3d(page, '3D road labels', 'n > 0');
    for (const l of await page.evaluate(READ3D)) assert.equal(l.fontSize, 18, `"${l.text}" is ${l.fontSize}px at Large`);
  });
});

test('3D: a failed request says "Road names did not load" and draws nothing; an empty answer says so differently', { skip }, async () => {
  await withDashboard(async (page) => {
    await goTo(page, SYLVA);
    await mode(page, 'error');
    await open3d(page);
    await waitInPage(page, 'the error notice', "(document.querySelector('.qc-terrain-notice[data-layer-id=\"roads\"]') || {}).textContent === 'Road names did not load'", CEILING, null);
    assert.equal(await count3d(page), 0);
    await close3d(page);
    await mode(page, 'empty');
    await open3d(page);
    await waitInPage(page, 'the empty notice', "/no road names/i.test((document.querySelector('.qc-terrain-notice[data-layer-id=\"roads\"]') || {}).textContent || '')", CEILING, null);
    assert.equal(await count3d(page), 0);
    assert.notEqual(await noticeOf(page), 'Road names did not load', 'empty is not an error');
  });
});

test('3D: roads off in 2D means no labels, no request, no credit and no notice in 3D', { skip }, async () => {
  await withDashboard(async (page) => {
    await goTo(page, SYLVA);
    await page.evaluate(`(() => { const c = document.getElementById('qcm-layer-roads'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(500);
    await mode(page, 'ok');
    await open3d(page);
    await sleep(1500);
    assert.equal(await count3d(page), 0);
    assert.equal(await page.evaluate('window.__roadReqs.length'), 0, 'the 3D view asked the road service although the row is off');
    assert.equal(await noticeOf(page), null);
    assert.ok(!(await creditText(page)).includes(ROAD_CREDIT), 'the road credit is shown with roads off');
  });
});

test('2D -> 3D -> 2D: the 2D labels come back as they were and the 3D trip does not abort or clear them', { skip }, async () => {
  await withDashboard(async (page) => {
    await goTo(page, SYLVA);
    const read2d = "[...document.querySelectorAll('.qcm-road-label')].map((e) => e.textContent).sort().join('|')";
    await waitInPage(page, '2D road labels', `${read2d}.length > 0`, CEILING, null);
    await settled2d(page);
    const before = await page.evaluate(read2d);
    const reservedBefore = await page.evaluate(RESERVED_NOW);
    await open3d(page);
    await wait3d(page, '3D road labels', 'n > 0');
    await close3d(page);
    assert.equal(await count3d(page), 0, 'closing 3D takes its labels with it');
    await sleep(900);
    const after = await page.evaluate(read2d);
    assert.equal(after, before, after === before ? '' : 'the 2D road labels changed across a trip to 3D\nreserved before:\n'
      + reservedBefore + '\nreserved after:\n' + await page.evaluate(RESERVED_NOW));
    assert.equal(await page.evaluate("document.getElementById('qcm-layer-roads-report').textContent"), '', '2D reports nothing wrong');
  });
});
