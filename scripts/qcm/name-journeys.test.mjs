// Both owner reports as reader journeys, across every zoom a reader can reach, over the page's own
// gates. A guard, green on arrival: it is proven by mutation (see the PR body), not red-first.
//
//   Franklin, North Carolina (a Census place of 4,362, in neither town file): the dashboard letters
//   "Franklin" at zoom 9 through 14 from the COMMITTED NC shard, with the names row off.
//   Stevensville, Montana: at zoom 8 through 14 the names layer asks only for kinds whose floor the
//   zoom has reached, draws a non-empty set, never says over-cap or "zoom in", and places the
//   Bitterroot River wherever the river is in view.
//
// The first half needs no browser: names never ride viewportFetchPlan's zoom/area gates, and every
// zoom 8..14 has a names plan. The second half runs the built page; it skips with a reason when
// there is no Chromium or no build, like its neighbours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage } from './helpers/waits.mjs';
import { viewportFetchPlan, VIEWPORT_FETCH } from '../../themes/headlessmode/static/js/quiet-corners-maps/app-state.js';
import { KINDS, kindsForZoom, namesPlanForView } from '../../themes/headlessmode/static/js/quiet-corners-maps/terrain-names.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ZOOMS = [8, 9, 10, 11, 12, 13, 14];
const CEILING = 20000;

// The committed NC shard is pipeline output; the place is read from it, never typed here.
const NC = JSON.parse(readFileSync(path.join(ROOT, 'static/data/quiet-corners/places-NC.json'), 'utf8'));
const row = NC.places.find((p) => p[NC.fields.indexOf('display_name')] === 'Franklin');
const FRANKLIN = row ? [row[NC.fields.indexOf('lat')], row[NC.fields.indexOf('lon')]] : null;
const STEVENSVILLE = [46.51, -114.09];

/** A box the size a 1440x1000 map shows at `zoom` around a point (Web Mercator, tile 256). */
const viewBox = ([lat, lon], z) => {
  const dLon = (720 * 360) / (256 * 2 ** z);
  const dLat = dLon * (1000 / 1440) * Math.cos((lat * Math.PI) / 180);
  return { minLon: lon - dLon, maxLon: lon + dLon, minLat: lat - dLat, maxLat: lat + dLat };
};

const JOURNEYS = [['Stevensville MT', STEVENSVILLE], ['Franklin NC', FRANKLIN || STEVENSVILLE]];

test('the committed NC shard names Franklin with coordinates', () => {
  assert.ok(FRANKLIN && FRANKLIN.every(Number.isFinite), 'Franklin NC is missing from static/data/quiet-corners/places-NC.json');
});

for (const [name, centre] of JOURNEYS) {
  for (const z of ZOOMS) {
    test(`${name} zoom ${z}: the names row is never refused by a zoom or area gate, and the plan asks only what the zoom draws`, () => {
      const bboxLonLat = viewBox(centre, z);
      // Names alone on: the browse pass has nothing of its own to fetch, and says nothing
      // about zoom or area -- a refusal here is the gate that emptied the view.
      const plan = viewportFetchPlan({ bboxLonLat, zoom: z, layers: { names: true } });
      assert.equal(plan.code, 'none-on', `names alone ran into the "${plan.code}" gate at zoom ${z}: ${plan.reason}`);
      assert.deepEqual(plan.layers, []);
      const names = namesPlanForView({ zoom: z, bbox: bboxLonLat });
      assert.ok(names.kinds.length > 0, `zoom ${z} has no names plan`);
      assert.ok(Number.isFinite(names.budget) && names.budget > 0, `zoom ${z} has no record budget`);
      const floors = new Map();
      for (const [layer, table] of Object.entries(KINDS)) {
        if (/^\d+$/.test(layer)) for (const [cls, e] of Object.entries(table)) floors.set(cls, e.minZoom);
      }
      for (const cls of names.kinds) assert.ok(floors.get(cls) <= z, `${cls} requested at zoom ${z}, below its floor ${floors.get(cls)}`);
      assert.deepEqual(names.kinds, kindsForZoom(z));
    });
  }
}

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

async function withDashboard(patch, fn) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', { viewport: { width: 1440, height: 1000 }, args: ['--hide-scrollbars'] });
  try {
    if (patch) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: patch });
    await page.navigate(`${site.origin}/quiet-corners/`);
    await readyDashboard(page, { data: true, ms: CEILING });
    return await fn(page);
  } finally { page.close(); await site.close(); }
}
const goTo = (page, [lat, lon], z) => page.evaluate(`(async () => {
  const settled = qcMoves();
  window.qcMap.setView([${lat}, ${lon}], ${z}, { animate: false });
  await settled('the map settled at zoom ${z}');
  return true;
})()`);
const setNames = (page, on) => page.evaluate(`(() => { const cb = document.getElementById('qcm-layer-names'); cb.checked = ${on}; cb.dispatchEvent(new Event('change', { bubbles: true })); return cb.checked; })()`);

test('Franklin NC is lettered at zoom 9 through 14 from the committed shard, with the names row off', { skip }, async () => {
  assert.ok(FRANKLIN, 'Franklin NC is missing from static/data/quiet-corners/places-NC.json');
  await withDashboard(null, async (page) => {
    assert.equal(await setNames(page, false), false, 'the names row is off');
    for (const z of [9, 10, 11, 12, 13, 14]) {
      await goTo(page, FRANKLIN, z);
      await waitInPage(page, `the Franklin label at zoom ${z}`, "[...document.querySelectorAll('.qc-place-label')].some((e) => e.textContent.trim() === 'Franklin')", CEILING, null);
      assert.ok(await page.evaluate("window.qcTownLabels.some((t) => t.name === 'Franklin' && t.state === 'NC')"), `zoom ${z}: Franklin reached qcTownLabels`);
    }
  });
});

// The GNIS service as a fake that replays the measured live counts for the Stevensville zoom-9
// extent (2026-10-06: layer 3 = 84, 5 = 751, 6 = 754, 7 = 215) and answers any narrower box with
// the share inside it; NHD answers one river and one creek. Public feature names only.
const EXTENT = { minLon: -114.9, minLat: 46.0, maxLon: -113.3, maxLat: 47.0 };
const SHAPE = { 3: [84, ['Populated Place']], 5: [751, ['Summit', 'Summit', 'Gap', 'Ridge', 'Valley']], 6: [754, ['Stream']], 7: [215, ['Lake', 'Falls', 'Spring']] };
const PATCH = `(() => {
  const EXTENT = ${JSON.stringify(EXTENT)}, SHAPE = ${JSON.stringify(SHAPE)}, CENTRE = ${JSON.stringify(STEVENSVILLE)};
  const real = window.fetch.bind(window);
  window.__gnisReqs = [];
  const rows = {};
  for (const [layer, [count, classes]] of Object.entries(SHAPE)) {
    rows[layer] = [];
    for (let i = 0; i < count; i++) {
      const cls = classes[i % classes.length];
      rows[layer].push({ attributes: { gaz_id: Number(layer) * 100000 + i, gaz_name: cls + ' Fixture ' + layer + '-' + i, gaz_featureclass: cls, state_alpha: 'MT', county_name: 'Ravalli' },
        geometry: { points: [[EXTENT.minLon + ((i * 0.6180339887) % 1) * (EXTENT.maxLon - EXTENT.minLon), EXTENT.minLat + ((i * 0.7548776662) % 1) * (EXTENT.maxLat - EXTENT.minLat)]] } });
    }
  }
  rows[3].unshift({ attributes: { gaz_id: 1, gaz_name: 'Stevensville', gaz_featureclass: 'Populated Place', state_alpha: 'MT', county_name: 'Ravalli' }, geometry: { points: [[CENTRE[1], CENTRE[0]]] } });
  const NHD = [
    { id: '1001', name: 'Bitterroot River', km: 40, paths: [[[-114.12, 45.9], [-114.12, 46.5], [-114.12, 47.1]]] },
    { id: '1002', name: 'Fixture Creek', km: 5, paths: [[[-114.06, 46.50], [-114.04, 46.52]]] },
  ];
  const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  window.fetch = function (input, init) {
    const url = String(input && input.url ? input.url : input);
    if (/nhd\\/MapServer\\/(\\d+)\\/query/.test(url)) {
      const nq = new URL(url).searchParams, where = nq.get('where') || '';
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
    const classes = [...q.get('where').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    window.__gnisReqs.push({ layer: g[1], classes });
    const [x0, y0, x1, y1] = q.get('geometry').split(',').map(Number);
    const hit = (rows[g[1]] || []).filter((f) => { const [x, y] = f.geometry.points[0]; return classes.includes(f.attributes.gaz_featureclass) && x >= x0 && x <= x1 && y >= y0 && y <= y1; });
    if (q.get('returnCountOnly') === 'true') return json({ count: hit.length });
    const off = Number(q.get('resultOffset') || 0), n = Number(q.get('resultRecordCount') || 2000);
    return json({ features: hit.slice(off, off + n) });
  };
})()`;

test('Stevensville MT at zoom 8 through 14: names drawn, nothing over-cap or "zoom in", no kind below its floor, the river placed', { skip }, async () => {
  await withDashboard(PATCH, async (page) => {
    await setNames(page, true);
    const floor = new Map();
    for (const [layer, table] of Object.entries(KINDS)) {
      if (/^\d+$/.test(layer)) for (const [cls, e] of Object.entries(table)) floor.set(cls, e.minZoom);
    }
    for (const z of ZOOMS) {
      await page.evaluate('window.__gnisReqs.length = 0');
      await goTo(page, STEVENSVILLE, z);
      await waitInPage(page, `a name label at zoom ${z}`, "document.querySelectorAll('.qcm-name-label').length > 0", CEILING, null);
      await waitInPage(page, `the names row to settle at zoom ${z}`, "/^(ready|partial)$/.test((document.getElementById('qcm-layer-names-badge') || {}).textContent || '')", CEILING, null);
      if (z >= 9) await waitInPage(page, `the Bitterroot River label at zoom ${z}`, "[...document.querySelectorAll('.qcm-name-label')].some((e) => e.textContent === 'Bitterroot River')", CEILING, null);
      const p = await page.evaluate(`(() => ({
        badge: (document.getElementById('qcm-layer-names-badge') || {}).textContent || '',
        note: (document.getElementById('qcm-names-report') || {}).textContent || '',
        texts: [...document.querySelectorAll('.qcm-name-label')].map((e) => e.textContent),
        reqs: window.__gnisReqs.slice(),
      }))()`);
      assert.notEqual(p.badge, 'zoom in', `zoom ${z}: the row's badge`);
      assert.doesNotMatch(p.note, /too many named features|zoom in or refine/i, `zoom ${z}: the note`);
      assert.ok(p.texts.length > 0, `zoom ${z}: nothing drawn`);
      for (const r of p.reqs) for (const cls of r.classes) assert.ok(floor.get(cls) <= z, `zoom ${z}: asked for ${cls} below its floor ${floor.get(cls)}`);
      if (z >= 9) assert.ok(p.texts.includes('Bitterroot River'), `zoom ${z}: the Bitterroot River is not placed among ${JSON.stringify(p.texts.slice(0, 8))}`);
    }
  });
});
