// The names layer's reader journey, in the real built page: Stevensville, Montana at zoom 9
// through 12 with "Named places & landmarks" on and NO print area drawn. The GNIS service is a
// fake that replays the measured live counts for the zoom-9 extent (2026-10-06: layer 3 = 84,
// layer 5 = 751, layer 6 = 754, layer 7 = 215) and answers any narrower box with the share that
// falls inside it, so the page's own plan, budget and gate decide what is asked -- nothing here
// calls a function the page does not. It cannot be green while the page says "zoom in".
//
// Proves: a drawable view always draws (a summit or place label, never the over-cap or "zoom in"
// state); a pan inside the fetched box asks for nothing; a failed refresh keeps the last labels.
// Fixture names are public feature names only (the town, a river); no address, no home coordinates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage } from './helpers/waits.mjs';
import { VIEWPORT_FETCH } from '../../themes/headlessmode/static/js/quiet-corners-maps/app-state.js';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const CEILING = 20000;
const STEVENSVILLE = [46.51, -114.09];
const EXTENT = { minLon: -114.9, minLat: 46.0, maxLon: -113.3, maxLat: 47.0 };   // the measured zoom-9 extent
// layer -> [count at that extent, featureclass cycle]
const SHAPE = {
  3: [84, ['Populated Place']],
  5: [751, ['Summit', 'Summit', 'Gap', 'Ridge', 'Valley']],
  6: [754, ['Stream']],
  7: [215, ['Lake', 'Falls', 'Spring']],
};

// The page's fetch: GNIS answered from a generated fixture, everything else to the real local server.
const PATCH_SOURCE = `(() => {
  const EXTENT = ${JSON.stringify(EXTENT)}, SHAPE = ${JSON.stringify(SHAPE)};
  const CENTRE = ${JSON.stringify(STEVENSVILLE)};
  const real = window.fetch.bind(window);
  window.__gnisMode = 'ok'; window.__gnisReqs = [];
  // Deterministic spread over the extent: a low-discrepancy walk, so any sub-box holds its share.
  const rows = {};
  for (const [layer, [count, classes]] of Object.entries(SHAPE)) {
    rows[layer] = [];
    for (let i = 0; i < count; i++) {
      const lon = EXTENT.minLon + ((i * 0.6180339887) % 1) * (EXTENT.maxLon - EXTENT.minLon);
      const lat = EXTENT.minLat + ((i * 0.7548776662) % 1) * (EXTENT.maxLat - EXTENT.minLat);
      const cls = classes[i % classes.length];
      rows[layer].push({ attributes: { gaz_id: Number(layer) * 100000 + i, gaz_name: cls + ' Fixture ' + layer + '-' + i, gaz_featureclass: cls, state_alpha: 'MT', county_name: 'Ravalli' }, geometry: { points: [[lon, lat]] } });
    }
  }
  // Public names that sit in the middle of the view.
  rows[3].unshift({ attributes: { gaz_id: 1, gaz_name: 'Stevensville', gaz_featureclass: 'Populated Place', state_alpha: 'MT', county_name: 'Ravalli' }, geometry: { points: [[CENTRE[1], CENTRE[0]]] } });
  rows[6].unshift({ attributes: { gaz_id: 2, gaz_name: 'Bitterroot River', gaz_featureclass: 'Stream', state_alpha: 'MT', county_name: 'Ravalli' }, geometry: { points: [[-114.12, 46.86]] } });
  // NHD flowlines (rivers and creeks), layer 4 at zoom 9-12: one river that crosses the view
  // north to south, one short creek near the town. Public names only.
  window.__nhdMode = 'ok'; window.__nhdReqs = [];
  const NHD = [
    { id: '1001', name: 'Bitterroot River', km: 40, paths: [[[-114.12, 45.9], [-114.12, 46.5], [-114.12, 47.1]]] },
    { id: '1002', name: 'Fixture Creek', km: 5, paths: [[[-114.06, 46.50], [-114.04, 46.52]]] },
  ];
  const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  window.fetch = function (input, init) {
    const url = String(input && input.url ? input.url : input);
    const nhdM = url.match(/nhd\\/MapServer\\/(\\d+)\\/query/);
    if (nhdM) {
      const nq = new URL(url).searchParams;
      window.__nhdReqs.push({ layer: nhdM[1], stats: nq.has('groupByFieldsForStatistics') });
      if (window.__nhdMode === 'error') return json({ error: { code: 500, message: 'stubbed' } }, 500);
      const where = nq.get('where') || '';
      if (nq.has('groupByFieldsForStatistics')) {
        const riversOnly = where.includes('LIKE');
        return json({ features: NHD.filter((r) => !riversOnly || /River$/.test(r.name)).map((r) => ({ attributes: { GNIS_ID: r.id, GNIS_NAME: r.name, total_km: r.km } })) });
      }
      const ids = [...where.matchAll(/'(\\d+)'/g)].map((m) => m[1]);
      return json({ features: NHD.filter((r) => ids.includes(r.id)).map((r) => ({ attributes: { GNIS_ID: r.id, GNIS_NAME: r.name, LENGTHKM: r.km, FTYPE: 'StreamRiver', FCODE: 46006 }, geometry: { paths: r.paths } })) });
    }
    const g = url.match(/geonames\\/MapServer\\/(\\d+)\\/query/);
    if (!g) return real(input, init);
    const q = new URL(url).searchParams;
    const countOnly = q.get('returnCountOnly') === 'true';
    window.__gnisReqs.push({ layer: g[1], countOnly, geometry: q.get('geometry') });
    if (window.__gnisMode === 'error') return json({ error: { code: 500, message: 'stubbed' } }, 500);
    const [x0, y0, x1, y1] = q.get('geometry').split(',').map(Number);
    const classes = [...q.get('where').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const hit = (rows[g[1]] || []).filter((f) => {
      const [x, y] = f.geometry.points[0];
      return classes.includes(f.attributes.gaz_featureclass) && x >= x0 && x <= x1 && y >= y0 && y <= y1;
    });
    if (countOnly) return json({ count: hit.length });
    const off = Number(q.get('resultOffset') || 0), n = Number(q.get('resultRecordCount') || 2000);
    return json({ features: hit.slice(off, off + n) });
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

const goTo = (page, [lat, lon], z) => page.evaluate(`(async () => {
  const settled = qcMoves();
  window.qcMap.setView([${lat}, ${lon}], ${z}, { animate: false });
  await settled('the map settled at zoom ${z}');
  return true;
})()`);
const namesOn = (page) => page.evaluate(`(() => { const cb = document.getElementById('qcm-layer-names'); cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); return cb.checked; })()`);
const labelTexts = (page) => page.evaluate("[...document.querySelectorAll('.qcm-name-label')].map((e) => e.textContent)");
const panel = (page) => page.evaluate(`(() => ({
  badge: (document.getElementById('qcm-layer-names-badge') || {}).textContent || '',
  note: (document.getElementById('qcm-names-report') || {}).textContent || '',
  glyphs: document.querySelectorAll('.qcm-name-marker-glyph').length,
}))()`);
const waitLabels = (page, what) => waitInPage(page, what, "document.querySelectorAll('.qcm-name-label').length > 0", CEILING, null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTLE = VIEWPORT_FETCH.settleMs + 500;

test('Stevensville at zoom 9, 10, 11 and 12 with names on draws names and never says over-cap or zoom in', { skip }, async () => {
  await withDashboard(async (page) => {
    await namesOn(page);
    for (const z of [9, 10, 11, 12]) {
      await goTo(page, STEVENSVILLE, z);
      await waitLabels(page, `a name label at zoom ${z}`);
      const p = await panel(page);
      assert.ok(p.glyphs > 0, `zoom ${z}: a marker is drawn`);
      assert.notEqual(p.badge, 'zoom in', `zoom ${z}: the row's badge`);
      assert.notEqual(p.badge, 'unavailable', `zoom ${z}: a drawable answer is never unavailable`);
      assert.doesNotMatch(p.note, /too many named features|zoom in or refine/i, `zoom ${z}: the note`);
      const texts = await labelTexts(page);
      assert.ok(texts.some((t) => /Stevensville|Summit Fixture|Populated|Fixture/.test(t)), `zoom ${z}: a summit or place label among ${JSON.stringify(texts.slice(0, 5))}`);
    }
  });
});

test('a pan inside the fetched box asks for nothing; a pan out of it asks again', { skip }, async () => {
  await withDashboard(async (page) => {
    await namesOn(page);
    await goTo(page, STEVENSVILLE, 11);
    await waitLabels(page, 'name labels at zoom 11');
    await sleep(SETTLE);
    await page.evaluate('window.__gnisReqs.length = 0');
    await page.evaluate('(window.qcMap.panBy([30, 20], { animate: false }), true)');
    await sleep(SETTLE);
    assert.equal(await page.evaluate('window.__gnisReqs.length'), 0, 'a small pan is answered from the held box');
    await goTo(page, [STEVENSVILLE[0] + 0.8, STEVENSVILLE[1]], 11);
    await waitInPage(page, 'a request for the new view', 'window.__gnisReqs.length > 0', CEILING, null);
  });
});

test('a refresh that fails keeps the last labels on the map', { skip }, async () => {
  await withDashboard(async (page) => {
    await namesOn(page);
    await goTo(page, STEVENSVILLE, 11);
    await waitLabels(page, 'name labels at zoom 11');
    const before = await labelTexts(page);
    await page.evaluate("window.__gnisMode = 'error'");
    await goTo(page, STEVENSVILLE, 12);
    await waitInPage(page, 'the row to say it did not load', "(document.getElementById('qcm-layer-names-badge') || {}).textContent === 'unavailable'", CEILING, null);
    const after = await labelTexts(page);
    assert.ok(after.length > 0, 'labels are still drawn after the failed refresh');
    assert.ok(after.some((t) => before.includes(t)), 'and they are the ones that were already there');
  });
});

test('fresh load, no layer clicked: the names row is checked and Stevensville z11 shows a name label', { skip }, async () => {
  await withDashboard(async (page) => {
    assert.equal(await page.evaluate("document.getElementById('qcm-layer-names').checked"), true, 'the names row opens checked');
    await goTo(page, STEVENSVILLE, 11);
    await waitLabels(page, 'a name label with nothing switched on by hand');
    const p = await panel(page);
    assert.notEqual(p.badge, 'unavailable', 'default-on never opens on "unavailable"');
    assert.ok((await labelTexts(page)).length > 0);
  });
});

test('Bitterroot River is lettered at zoom 9 and 11; the creek waits for its floor', { skip }, async () => {
  await withDashboard(async (page) => {
    await namesOn(page);
    await goTo(page, STEVENSVILLE, 9);
    await waitInPage(page, 'the river label at zoom 9', "[...document.querySelectorAll('.qcm-name-label')].some((e) => e.textContent === 'Bitterroot River')", CEILING, null);
    assert.ok(!(await labelTexts(page)).includes('Fixture Creek'), 'no creek at zoom 9');
    assert.ok(await page.evaluate('window.__nhdReqs.length') > 0, 'the page asked the NHD service');
    await goTo(page, STEVENSVILLE, 11);
    await waitInPage(page, 'the creek label at its floor', "[...document.querySelectorAll('.qcm-name-label')].some((e) => e.textContent === 'Fixture Creek')", CEILING, null);
    assert.ok((await labelTexts(page)).includes('Bitterroot River'), 'the river is still lettered at zoom 11');
    const inView = await page.evaluate(`(() => { const r = window.qcMap.getContainer().getBoundingClientRect(); const el = [...document.querySelectorAll('.qcm-name-label')].find((e) => e.textContent === 'Bitterroot River').getBoundingClientRect(); return el.left >= r.left && el.right <= r.right && el.top >= r.top && el.bottom <= r.bottom; })()`);
    assert.ok(inView, 'the river label sits inside the map');
    assert.match(await page.evaluate("document.querySelector('.leaflet-control-attribution').textContent"), /National Hydrography Dataset/, 'the source credit is on the map');
  });
});

test('a failed NHD answer leaves the GNIS names drawn and says the rivers did not load', { skip }, async () => {
  await withDashboard(async (page) => {
    await namesOn(page);
    await page.evaluate("window.__nhdMode = 'error'");
    await goTo(page, STEVENSVILLE, 11);
    await waitLabels(page, 'GNIS name labels with NHD failing');
    await waitInPage(page, 'the river note', "/Rivers did not load/.test((document.getElementById('qcm-names-report') || {}).textContent || '')", CEILING, null);
    const texts = await labelTexts(page);
    assert.ok(texts.length > 0 && !texts.includes('Bitterroot River'), 'GNIS labels draw, no river label');
    assert.notEqual((await panel(page)).badge, 'unavailable', 'the layer is not blanked by the river failure');
  });
});

test('fresh load, no layer clicked: the names row is checked and Stevensville z11 shows a name label', { skip }, async () => {
  await withDashboard(async (page) => {
    assert.equal(await page.evaluate("document.getElementById('qcm-layer-names').checked"), true, 'the names row opens checked');
    await goTo(page, STEVENSVILLE, 11);
    await waitLabels(page, 'a name label with nothing switched on by hand');
    const p = await panel(page);
    assert.notEqual(p.badge, 'unavailable', 'default-on never opens on "unavailable"');
    assert.ok((await labelTexts(page)).length > 0);
  });
});
