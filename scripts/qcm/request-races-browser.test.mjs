// QQA-13 PR-B part 2: the map page's own remote reads, held at the network layer in a real
// Chromium, so a slow answer is a state the test controls and not a race it hopes to win.
//
// Fetch.requestPaused parks a request until the test answers it (the pattern
// camera-requests.test.mjs and dashboard-load-failure.test.mjs use; helpers/cdp-session.mjs
// is the persistent-subscription session). Three things are proved:
//   (a) two quad searches, the first answered LAST: the list shows the second, and the
//       search says "Searching..." the moment it starts;
//   (b) a layer switched off before its answer arrives never reaches the map (aurora);
//   (c) the area changing mid-pass cancels the pass's requests (Network.loadingFailed with
//       canceled: true), instead of leaving them to finish and write to a replaced area.
// Every wait is a condition on an event or on the page; nothing here sleeps for a fixed time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium } from './helpers/browser.mjs';
import { connectSession } from './helpers/cdp-session.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage, chooseExampleArea } from './helpers/waits.mjs';
import { settlePaused } from './helpers/paused-request.mjs';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built — run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const QUAD_QUERY = SOURCES.usgsQuadIndex.layers[0].queryUrl;
const AURORA_URL = SOURCES.swpcAurora.serviceUrl;
// auroraLayer draws one green rectangle per visible cell. The map prefers canvas, so they are
// not in the DOM: they are counted on the map itself.
const AURORA_CELLS = `(() => { let n = 0; window.qcMap.eachLayer((l) => { if (l.options && l.options.color === '#7ee081') n++; }); return n; })()`;

const quadFeature = (id, name) => ({
  attributes: { CELL_ID: id, CELL_NAME: name, PRIMARY_STATE: 'CO', STATE_ALPHA: 'CO', CELL_MAPCODE: 'X' },
  geometry: { rings: [[[-105.125, 39.875], [-105, 39.875], [-105, 40], [-105.125, 40], [-105.125, 39.875]]] },
});
// One visible cell at the centre of the view the test sets. The grid's longitudes run 0..359.
const AURORA_BODY = {
  'Observation Time': '2026-10-08T10:00:00Z', 'Forecast Time': '2026-10-08T11:06:00Z',
  coordinates: [[260, 40, 12]],
};

const until = async (what, ok, ms = 20000) => {
  const end = performance.now() + ms;
  for (;;) {
    const got = await ok();
    if (got) return got;
    if (performance.now() >= end) throw new Error(`waited ${ms} ms and ${what} never came true`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** Chromium is asked to quit before the session removes its profile: killed mid-write it can
 *  still be filling the cache directory when the profile is deleted, and the removal then
 *  fails with ENOTEMPTY. That one failure is a teardown race and says nothing about the test. */
async function closePage(session, site) {
  try { await session.send('Browser.close'); } catch { /* already gone, or a page target that cannot */ }
  try { session.close(); } catch (err) { if (err?.code !== 'ENOTEMPTY') throw err; }
  await site.close();
}

/** Opens the page with every cross-origin fetch the page makes under the test's control.
 *  `holds` lists the URL prefixes whose requests are parked; `holdAllFetches()` parks every
 *  cross-origin fetch from then on (the source-check pass). Anything not parked goes on to
 *  the local site server, or fails offline like every other browser proof here. */
async function openPage() {
  const site = await startSiteServer();
  const docUrl = `${site.origin}/quiet-corners/`;
  const session = await connectSession();
  const held = [];                 // { url, requestId, answered }
  const urls = new Map();          // network request id -> url
  const ended = new Map();         // url -> 'finished' | 'canceled' | 'failed'
  let prefixes = [], everything = false;
  try {
    await session.send('Page.enable');
    await session.send('Network.enable');
    await session.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    session.on('Network.requestWillBeSent', (p) => { urls.set(p.requestId, p.request.url); });
    session.on('Network.loadingFinished', (p) => { if (urls.has(p.requestId)) ended.set(urls.get(p.requestId), 'finished'); });
    session.on('Network.loadingFailed', (p) => { if (urls.has(p.requestId)) ended.set(urls.get(p.requestId), p.canceled ? 'canceled' : 'failed'); });
    session.on('Fetch.requestPaused', async (p) => {
      const { requestId, request, responseStatusCode, responseHeaders } = p;
      if (responseStatusCode !== undefined) {
        // The shipped page carries its policy as a <meta> alone; drop the header the server adds.
        const headers = (responseHeaders || []).filter((h) => h.name.toLowerCase() !== 'content-security-policy');
        await settlePaused(session.send, 'Fetch.continueResponse', { requestId, responseCode: responseStatusCode, responseHeaders: headers });
        return;
      }
      const foreign = !request.url.startsWith(site.origin);
      const isFetch = p.resourceType === 'Fetch' || p.resourceType === 'XHR';
      if (foreign && (prefixes.some((x) => request.url.startsWith(x)) || (everything && isFetch))) {
        held.push({ url: request.url, requestId, answered: false });
        return;
      }
      await settlePaused(session.send, 'Fetch.continueRequest', { requestId });
    });
    await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }, { urlPattern: docUrl, requestStage: 'Response' }] });
    await session.navigate(docUrl);
    await readyDashboard(session, { ms: 60000 });
  } catch (err) { await closePage(session, site); throw err; }
  return {
    session, held, ended,
    hold: (...list) => { prefixes = list; },
    holdAllFetches: () => { everything = true; },
    release: () => { prefixes = []; everything = false; },
    /** Answers one parked request with a JSON body (a no-op when the page already cancelled it). */
    answer: async (entry, body) => {
      entry.answered = true;
      await settlePaused(session.send, 'Fetch.fulfillRequest', {
        requestId: entry.requestId, responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }, { name: 'access-control-allow-origin', value: '*' }],
        body: Buffer.from(JSON.stringify(body)).toString('base64'),
      });
    },
    /** Counts, in the page, every body read (`Response.json()`) that completes for a URL under
     *  `prefix`. Everything the page does with an answer after that read is promise
     *  continuations, which run before the next event-loop turn, so once the count moves and
     *  `settle()` has returned the continuation has run: a "nothing was drawn" assertion made
     *  then is a statement about the finished continuation, not about a slow box. */
    watchBodyReads: (prefix) => session.evaluate(`(() => {
      window.__bodyReads = 0;
      const orig = Response.prototype.json;
      Response.prototype.json = function () {
        const match = this.url.startsWith(${JSON.stringify(prefix)});
        return orig.call(this).then((v) => { if (match) window.__bodyReads++; return v; });
      };
      return true;
    })()`),
    bodyReads: () => session.evaluate('window.__bodyReads'),
    /** One full turn of the page's event loop, twice over: whatever a landed answer was going
     *  to do on screen has been done by the time this returns. */
    settle: () => session.evaluate(`(async () => {
      for (let i = 0; i < 2; i++) await new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => setTimeout(r, 0); c.port2.postMessage(0); });
      return true;
    })()`),
    close: () => closePage(session, site),
  };
}

const heldFor = (page, prefix) => page.held.filter((h) => h.url.startsWith(prefix));
const searchFor = (page, name) => page.session.evaluate(`(() => {
  document.getElementById('qcm-quad-name').value = ${JSON.stringify(name)};
  document.getElementById('qcm-quad').click();
  return document.getElementById('qcm-status').textContent;
})()`);
const quadList = (page) => page.session.evaluate(`[...document.querySelectorAll('#qcm-quad-results li')].map((li) => li.textContent)`);

test('quad search: the first answer arriving last never overwrites the second, and the search says it is searching', { skip }, async () => {
  const page = await openPage();
  try {
    page.hold(QUAD_QUERY);
    const statusAfterFirst = await searchFor(page, 'Alpha Peak');
    const first = await until('the first search request', () => heldFor(page, QUAD_QUERY)[0]);
    await searchFor(page, 'Bravo Peak');
    const second = await until('the second search request', () => heldFor(page, QUAD_QUERY)[1]);
    assert.notEqual(first.url, second.url);

    // The second answer lands first and is drawn; the first lands after it.
    await page.answer(second, { features: [quadFeature('2', 'Bravo Peak')] });
    await waitInPage(page.session, 'the second search to be listed', `document.querySelectorAll('#qcm-quad-results li').length === 1`, 20000, null);
    await page.answer(first, { features: [quadFeature('1', 'Alpha Peak')] });
    await until('the first request to end', () => page.ended.get(first.url));
    await page.settle();

    assert.deepEqual(await quadList(page), ['Bravo Peak (CO)'], 'the list must show the latest search only');
    assert.equal(await page.session.evaluate(`document.getElementById('qcm-status').textContent`), '1 matching quadrangles; choose one.');
    assert.equal(page.ended.get(first.url), 'canceled', 'the replaced search must be cancelled, not left to finish');
    assert.match(statusAfterFirst, /Searching/, 'the status must say "Searching…" the moment the search starts');
  } finally { await page.close(); }
});

test('aurora: switched on and off before its answer arrives, the layer is never added', { skip }, async () => {
  const page = await openPage();
  try {
    const { session } = page;
    // A view over the lower 48 with the fixture's one visible cell in it.
    await session.evaluate(`(async () => { const s = qcMoves(); window.qcMap.setView([40, -100], 6, { animate: false }); await s('the map to settle'); return true; })()`);
    await page.watchBodyReads(AURORA_URL);
    page.hold(AURORA_URL);
    await session.evaluate(`document.getElementById('qcm-layer-swpcAurora').click(); void 0;`);
    const asked = await until('the aurora request', () => heldFor(page, AURORA_URL)[0]);
    await session.evaluate(`document.getElementById('qcm-layer-swpcAurora').click(); void 0;`);
    assert.equal(await session.evaluate(`document.getElementById('qcm-layer-swpcAurora').checked`), false);

    await page.answer(asked, AURORA_BODY);
    await until('the aurora request to end', () => page.ended.get(asked.url));
    // The positive signal: the page has read the answer's body, so what is left of renderAurora's
    // continuation (the guard, or the draw it guards) is promise work that settle() lets finish.
    await until('the page to finish reading the aurora answer', async () => (await page.bodyReads()) > 0);
    await page.settle();
    assert.equal(await session.evaluate(AURORA_CELLS), 0, 'a layer switched off before its answer must not be drawn');
    assert.equal(await session.evaluate(`document.getElementById('qcm-layer-swpcAurora-report').hidden`), true, 'nor its report row shown');

    // The control: the same answer, with the layer left on, does draw -- or the zero above proves nothing.
    page.release();
    await session.evaluate(`document.getElementById('qcm-layer-swpcAurora').click(); void 0;`);
    await until('the aurora cell to be drawn', async () => {
      for (const h of heldFor(page, AURORA_URL)) if (!h.answered) await page.answer(h, AURORA_BODY);
      return (await session.evaluate(AURORA_CELLS)) > 0;
    });
  } finally { await page.close(); }
});

test('source check: changing the area mid-pass cancels the pass\'s requests', { skip }, async () => {
  const page = await openPage();
  try {
    const { session } = page;
    await chooseExampleArea(session);
    await waitInPage(session, 'Check sources to enable', `!document.getElementById('qcm-check').disabled`, 20000, null);
    page.holdAllFetches();
    await session.evaluate(`document.getElementById('qcm-check').click(); void 0;`);
    const inFlight = await until('the pass to ask for something', () => page.held[0]);

    // The reader clears the area while the pass is still waiting on its first answer.
    await session.evaluate(`document.getElementById('qcm-area-clear').click(); void 0;`);
    await until('the pass\'s request to be cancelled', () => page.ended.has(inFlight.url));
    assert.equal(page.ended.get(inFlight.url), 'canceled', `the first pass's request must be cancelled, not left to finish: ${inFlight.url}`);
    page.release();
  } finally { await page.close(); }
});
