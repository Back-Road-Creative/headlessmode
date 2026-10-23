// Shared by the QQA-13c leak proofs (leak-cycles-browser.test.mjs, leak-heap-browser.test.mjs):
// the offline network, a fresh dashboard page, one 3D open/close cycle and the forced-collection
// readings. Two files share it so each gets its own --test-timeout budget in CI (pr-ci.yml caps a
// FILE, not a test). It holds no test.
import { findChromium } from './browser.mjs';
import { connectSession } from './cdp-session.mjs';
import { startSiteServer, siteIsBuilt } from './site-server.mjs';
import { readyDashboard, waitInPage } from './waits.mjs';
import { settlePaused } from './paused-request.mjs';
import { SOURCES } from '../../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { terrariumTilePng, greyBasePng } from '../fixtures/relief-3d.mjs';

const CHROMIUM = findChromium();
export const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built — run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

// Software WebGL on a busy box renders slowly; page-side waits get this long.
export const SLOW = 170000;
const CORS = { name: 'access-control-allow-origin', value: '*' };
export const png = (buf) => ({ headers: [{ name: 'content-type', value: 'image/png' }, CORS], body: buf.toString('base64') });

async function stubNetwork(session, { docUrl, siteOrigin, held = null }) {
  session.on('Fetch.requestPaused', async (p) => {
    const { requestId, request, responseStatusCode, responseHeaders } = p;
    if (responseStatusCode !== undefined) {
      const headers = (responseHeaders || []).filter((h) => h.name.toLowerCase() !== 'content-security-policy');
      await settlePaused(session.send, 'Fetch.continueResponse', { requestId, responseCode: responseStatusCode, responseHeaders: headers });
      return;
    }
    const url = request.url;
    let answer = null;
    if (url.startsWith(SOURCES.terrainDem.origin)) {
      const m = /\/(\d+)\/(\d+)\/(\d+)\.png/.exec(url);
      if (m) answer = png(terrariumTilePng(Number(m[1]), Number(m[2]), Number(m[3])));
    } else if (url.startsWith(SOURCES.usgsTopo.origin)) answer = png(greyBasePng());
    else if (held && url.startsWith(SOURCES.usgs3depHillshade.origin)) { held.push(requestId); return; }
    if (answer) {
      await settlePaused(session.send, 'Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: answer.headers, body: answer.body });
    } else if (url.startsWith(siteOrigin) || url.startsWith('data:') || url.startsWith('blob:')) {
      await settlePaused(session.send, 'Fetch.continueRequest', { requestId });
    } else {
      await settlePaused(session.send, 'Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    }
  });
  await session.send('Fetch.enable', {
    patterns: [{ urlPattern: '*', requestStage: 'Request' }, { urlPattern: docUrl, requestStage: 'Response' }],
  });
}


export const press3d = `document.querySelector('.qc-terrain-open').click(); void 0;`;
export const pressTwice = `(() => { const b = document.querySelector('.qc-terrain-open'); b.click(); b.click(); })()`;
export const escapeKey = `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); void 0;`;
export const pressClose = `document.querySelector('.qc-terrain-controls .qc-terrain-close').click(); void 0;`;
export const canvasPresent = `Boolean(document.querySelector('.qc-terrain-dialog canvas'))`;
export const canvasGone = `!document.querySelector('.qc-terrain-dialog canvas')`;
export const dialogHidden = `(() => { const d = document.querySelector('.qc-terrain-dialog'); return !d || d.hidden; })()`;
export const containers = `document.querySelectorAll('.qc-terrain-canvas').length`;
export const mapCount = `window.qcTerrainView.debug().maps`;

export async function freshPage(t, { held = null } = {}) {
  const site = await startSiteServer();
  const docUrl = `${site.origin}/quiet-corners/`;
  const session = await connectSession();
  t.after(async () => { session.close(); await site.close(); });
  await session.send('Page.enable');
  await session.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await stubNetwork(session, { docUrl, siteOrigin: site.origin, held });
  await session.navigate(docUrl);
  await readyDashboard(session, { ms: 60000 });
  return session;
}

/** One 3D open and close, by Escape or by the panel's own Close button. */
export async function cycle(session, i) {
  await session.evaluate(press3d);
  await waitInPage(session, `cycle ${i}: a canvas in the terrain dialog`, canvasPresent, SLOW, null);
  await session.evaluate(i % 2 ? pressClose : escapeKey);
  await waitInPage(session, `cycle ${i}: the terrain dialog to hide`, dialogHidden, 15000, null);
  await waitInPage(session, `cycle ${i}: the terrain canvas to be gone`, canvasGone, 15000, null);
}

/** One forced collection, then the browser's own counters. */
export async function readOnce(session) {
  await session.send('HeapProfiler.collectGarbage');
  const { metrics } = await session.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

/** JSHeapUsedSize after collecting until two reads in a row agree (at most eight). The page
 *  needs `Performance.enable` first, else getMetrics answers with nothing. */
export async function settledHeap(session) {
  let prev = -1;
  for (let i = 0; i < 8; i++) {
    const { JSHeapUsedSize } = await readOnce(session);
    if (JSHeapUsedSize === prev) return JSHeapUsedSize;
    prev = JSHeapUsedSize;
  }
  return prev;
}
