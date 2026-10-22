// The stubbed steep-relief session two browser proofs share: terrain-relief-browser.test.mjs
// (what 3D draws) and session-journey-browser.test.mjs (a reader's 2D -> 3D -> reload path).
// The DEM and the trail and road answers come from fixtures/relief-3d.mjs; the local site
// passes through, the stubs answer, and every other request is refused and recorded.
import { settlePaused } from './paused-request.mjs';
import { readyDashboard, waitInPage, chooseExampleArea } from './waits.mjs';
import { SOURCES } from '../../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { terrariumTilePng, greyBasePng, trailsQueryResponse, mvumQueryResponse } from '../fixtures/relief-3d.mjs';

// Software WebGL on a busy box renders slowly; page-side waits get this long.
export const SLOW = 170000;
const CORS = [{ name: 'access-control-allow-origin', value: '*' }];
const json = (body) => ({ headers: [{ name: 'content-type', value: 'application/json' }, ...CORS], body: Buffer.from(JSON.stringify(body)).toString('base64') });
const png = (buf) => ({ headers: [{ name: 'content-type', value: 'image/png' }, ...CORS], body: buf.toString('base64') });
const TOPO_ORIGIN = SOURCES.usgsTopo.origin;
const DEM_ORIGIN = SOURCES.terrainDem.origin;

export async function stubNetwork(session, { docUrl, siteOrigin }) {
  const refused = [];
  session.on('Fetch.requestPaused', async (p) => {
    const { requestId, request, responseStatusCode, responseHeaders } = p;
    if (responseStatusCode !== undefined) {
      const headers = (responseHeaders || []).filter((h) => h.name.toLowerCase() !== 'content-security-policy');
      await settlePaused(session.send, 'Fetch.continueResponse', { requestId, responseCode: responseStatusCode, responseHeaders: headers });
      return;
    }
    const url = request.url;
    let answer = null;
    if (url.startsWith(DEM_ORIGIN)) {
      const m = /\/(\d+)\/(\d+)\/(\d+)\.png/.exec(url);
      if (m) answer = png(terrariumTilePng(Number(m[1]), Number(m[2]), Number(m[3])));
    } else if (url.startsWith(TOPO_ORIGIN)) answer = png(greyBasePng());
    else if (/carto\.nationalmap\.gov\/.*\/MapServer\/37\/query/.test(url)) answer = json(trailsQueryResponse());
    else if (url.startsWith('https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MVUM_02/')) answer = json(mvumQueryResponse(url));
    else if (/^https:\/\/(carto\.nationalmap\.gov|hydro\.nationalmap\.gov|apps\.fs\.usda\.gov)\//.test(url)) answer = json({ features: [] });
    if (answer) {
      await settlePaused(session.send, 'Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: answer.headers, body: answer.body });
    } else if (url.startsWith(siteOrigin) || url.startsWith('data:') || url.startsWith('blob:')) {
      await settlePaused(session.send, 'Fetch.continueRequest', { requestId });
    } else {
      refused.push(url);
      await settlePaused(session.send, 'Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    }
  });
  await session.send('Fetch.enable', {
    patterns: [{ urlPattern: '*', requestStage: 'Request' }, { urlPattern: docUrl, requestStage: 'Response' }],
  });
  return { refused };
}

export const tick = (id) => `(() => { const cb = document.getElementById('${id}'); cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); })()`;
export const canvasPresent = `Boolean(document.querySelector('.qc-terrain-dialog canvas'))`;
export const dialogHidden = `(() => { const d = document.querySelector('.qc-terrain-dialog'); return !d || d.hidden; })()`;
export const escapeKey = `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); void 0;`;

/** Load the page, draw the example area, switch trails and the Forest Service roads on and
 *  wait until both have come back through the page's own adapters. */
export async function loadWithRoutes(session, docUrl) {
  await session.send('Page.enable');
  await session.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 640, deviceScaleFactor: 1, mobile: false });
  await session.navigate(docUrl);
  await readyDashboard(session, { ms: 60000 });
  await chooseExampleArea(session);
  await session.evaluate(tick('qcm-layer-trails'));
  await session.evaluate(tick('qcm-layer-mvum'));
  await session.evaluate("document.getElementById('qcm-check').click()");
  for (const id of ['trails', 'mvum']) {
    await waitInPage(session, `the ${id} layer to read ready`, `document.getElementById('qcm-layer-${id}-report')?.dataset?.state === 'ready'`, 30000, null);
  }
}

export async function openTerrain(session) {
  await session.evaluate(`document.querySelector('.qc-terrain-open').click(); void 0;`);
  await waitInPage(session, 'a canvas in the terrain dialog', canvasPresent, 60000, null);
  await waitInPage(session, 'the 3D map to be reachable', `Boolean(window.qcTerrainView.inspect())`, 15000, null);
  // Idle = the DEM tiles are in and the terrain is built, so queryTerrainElevation answers.
  await session.evaluate(`new Promise((res, rej) => { const m = window.qcTerrainView.inspect();
    const t = setTimeout(() => rej(new Error('3D map never went idle')), 100000);
    m.once('idle', () => { clearTimeout(t); res(true); }); m.triggerRepaint(); })`, { timeoutMs: SLOW });
}

export async function closeTerrain(session) {
  await session.evaluate(escapeKey);
  await waitInPage(session, 'the terrain dialog to hide', dialogHidden, 15000, null);
}
