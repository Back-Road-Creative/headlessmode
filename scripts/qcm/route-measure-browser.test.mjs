// QQA-09 slice 1: the length on a road or trail card, proved in the built page. A trail wholly inside
// the fetched area reads its geodesic length with no hedge; a trail that runs out past the edge of the
// fetched area reads "approximate -- only the part loaded in this view". The expected text is built
// here from the fixture's own coordinates with measure.js, so a card that measured on a flat plane,
// or hedged a complete route, fails. Services are answered from the shared 3D fixtures (Standing
// Indian / Forest Road 67, public landmarks) by a fetch patch; the browser is offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage, chooseExampleArea } from './helpers/waits.mjs';
import { TRAILS, trailsQueryResponse, mvumQueryResponse } from './fixtures/relief-3d.mjs';
import { measureLength, formatLength } from '../../themes/headlessmode/static/js/quiet-corners-maps/measure.js';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const CEILING = 60000;
const RIDGE = TRAILS[1];
const VIEW = [35.04, -83.505, 13];
// The example area ends at lon -83.4; this trail starts inside the view and runs 0.02 degree past it.
const EDGE = { id: 'fx-edge', name: 'Edge Trail', paths: [[[-83.49, 35.055], [-83.45, 35.055], [-83.4, 35.055], [-83.38, 35.055]]] };

const trailsBody = trailsQueryResponse();
trailsBody.features.push({ ...trailsBody.features[0],
  attributes: { ...trailsBody.features[0].attributes, permanentidentifier: EDGE.id, name: EDGE.name, nationaltraildesignation: null },
  geometry: { paths: EDGE.paths } });

const PATCH_SOURCE = `(() => {
  const trails = ${JSON.stringify(trailsBody)};
  const mvum = { 1: ${JSON.stringify(mvumQueryResponse('MapServer/1/query'))}, 2: ${JSON.stringify(mvumQueryResponse('MapServer/2/query'))},
    c1: ${JSON.stringify(mvumQueryResponse('MapServer/1/query?returnCountOnly=true'))}, c2: ${JSON.stringify(mvumQueryResponse('MapServer/2/query?returnCountOnly=true'))} };
  const real = window.fetch.bind(window);
  const json = (body) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  window.fetch = function (input, init) {
    const url = String(input && input.url ? input.url : input);
    const count = /returnCountOnly=true/.test(url);
    let m;
    if (/MapServer\\/37\\/query/.test(url)) return json(trails);
    if ((m = /EDW_MVUM_02\\/MapServer\\/(\\d+)\\/query/.exec(url))) return json(mvum[(count ? 'c' : '') + m[1]] || { features: [] });
    if (/^https:\\/\\//.test(url) && !url.startsWith(location.origin)) return json(count ? { count: 0 } : { features: [] });
    return real(input, init);
  };
})()`;

const tick = (id) => `(() => { const cb = document.getElementById('${id}'); cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); })()`;
const at = (page, lon, lat) => page.evaluate(`(() => {
  const r = document.getElementById('qc-map').getBoundingClientRect(), p = window.qcMap.latLngToContainerPoint([${lat}, ${lon}]);
  return { x: r.left + p.x, y: r.top + p.y };
})()`);
const mouseClick = async (page, { x, y }) => {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};
const CARD_LINES = `(() => { const c = document.querySelector('.leaflet-popup .qcm-site-card');
  return c && [...c.querySelectorAll('p')].map((p) => p.textContent); })()`;
const closeCard = async (page) => {
  await page.evaluate('window.qcMap.closePopup(), true');
  await waitInPage(page, 'the shut card to leave the page', `!document.querySelector('.leaflet-popup')`, CEILING, null);
};
const cardFor = async (page, vertex, what) => {
  await mouseClick(page, await at(page, vertex[0], vertex[1]));
  await waitInPage(page, what, `Boolean(document.querySelector('.leaflet-popup .qcm-site-card'))`, CEILING, null);
  return page.evaluate(CARD_LINES);
};
const lengthOf = (paths) => measureLength({ type: 'MultiLineString', coordinates: paths });

test('a trail inside the fetched area states its geodesic length plainly; one that runs past the edge says it is only the loaded part', { skip }, async () => {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', { viewport: { width: 1280, height: 900 }, args: ['--hide-scrollbars'], timeoutMs: CEILING });
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PATCH_SOURCE });
    await page.navigate(`${site.origin}/quiet-corners/`);
    await readyDashboard(page, { ms: CEILING });
    await chooseExampleArea(page);
    await page.evaluate(tick('qcm-layer-trails'));
    await page.evaluate(tick('qcm-layer-mvum'));
    await page.evaluate("document.getElementById('qcm-check').click()");
    for (const id of ['trails', 'mvum']) {
      await waitInPage(page, `the ${id} layer to read ready`, `document.getElementById('qcm-layer-${id}-report')?.dataset?.state === 'ready'`, CEILING, null);
    }
    await page.evaluate(`(async () => { const settled = qcMoves(); window.qcMap.setView([${VIEW[0]}, ${VIEW[1]}], ${VIEW[2]}, { animate: false }); await settled('the map settled on the fixture trails'); return true; })()`);
    await waitInPage(page, 'the trails drawn as lines', `document.querySelectorAll('#qc-map .leaflet-overlay-pane path[aria-label]').length >= 3`, CEILING, null);

    // 1. Lower Ridge Trail: every vertex inside the box, source ready, nothing cut.
    const whole = lengthOf(RIDGE.paths);
    assert.equal(whole.status, 'known');
    const lines = await cardFor(page, RIDGE.paths[0][4], 'a card on Lower Ridge Trail');
    assert.ok(lines.includes(`Length: ${formatLength(whole)} (basis: loaded geometry, WGS84)`), `expected the geodesic length ${formatLength(whole)} with no hedge: ${JSON.stringify(lines)}`);
    assert.ok(!lines.some((l) => /approximate/i.test(l)), `a complete route is not hedged: ${JSON.stringify(lines)}`);
    await closeCard(page);

    // 2. Edge Trail: its last vertices lie on and past the fetched area's edge.
    const partial = lengthOf(EDGE.paths);
    const edge = await cardFor(page, EDGE.paths[0][0], 'a card on Edge Trail');
    assert.ok(edge.includes(`Length: ${formatLength(partial)}, approximate — only the part loaded in this view (basis: loaded geometry, WGS84)`),
      `expected the length hedged as only the loaded part: ${JSON.stringify(edge)}`);
    assert.ok(Math.abs(partial.value - 10035) < 5, `sanity: 0.11 degree of longitude at 35.055 N is about 10.03 km, got ${partial.value}`);
  } finally { page.close(); await site.close(); }
});
