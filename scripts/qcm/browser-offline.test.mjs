// Nothing a page in a test browser loads may leave this box.
//
// Pages here start requests to hosts on the internet, and a page load waited on them. The
// dashboard creates its map -- and with it the USGS base tiles from basemap.nationalmap.gov
// -- before its data requests settle (themes/headlessmode/static/js/quiet-corners.js), an
// image a page has started holds that page's load event, and `navigate()` waits for the
// load event. Measured 2026-10-02 on this box, five loads of /quiet-corners/ each way
// through `launch()` and site-server.mjs: as the tests ran then, the load event began after
// the last of the eight tiles had arrived in every load, 1343-1649 ms a navigation; with
// every outside host unresolvable, 671-901 ms, the tiles failing within 18 ms and the same
// 98 requests to the page's own server. A slow tile server made a slow test, and one that
// took a tile request and never answered it would have held the load event until
// `navigate()`'s 120 s deadline (browser-port.test.mjs shows that wait for a stylesheet).
// No page in a test needs an answer from the internet: a test about an outside service
// answers that service's requests itself (camera-requests.test.mjs and
// terrain-panel.test.mjs intercept them).
//
// So every Chromium a test starts takes OFFLINE_ARGS (helpers/browser.mjs): every host but
// 127.0.0.1 is unresolvable, and no proxy is used -- Chromium on Linux takes one from
// `http_proxy` in its environment, and a request handed to a proxy never resolves its own
// host here. `launch()` passes them, and the first two tests below prove what they do. A
// test file that opens its own DevTools session, as camera-requests and terrain-panel do,
// starts Chromium without `launch()`, so the last test finds every start in this directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChromium, freePort, launch } from './helpers/browser.mjs';

const CHROMIUM = findChromium();
const skip = CHROMIUM ? false : 'no Chromium on this box (set CHROME_PATH to run this proof)';
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Serves a blank page on 127.0.0.1 and records the Host header of every /probe request,
 *  which says under what name a fetch reached this server. */
async function startProbeSite(t) {
  const hosts = [];
  const site = http.createServer((req, res) => {
    if (req.url.startsWith('/probe')) {
      hosts.push(req.headers.host);
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>offline</title>');
  });
  const port = await freePort();
  await new Promise((r) => site.listen(port, '127.0.0.1', r));
  t.after(() => new Promise((r) => { site.closeAllConnections(); site.close(r); }));
  return { port, hosts };
}

/** 'reached' when the page's fetch got any response at all, 'failed' on a network error. */
const reach = (browser, url) => browser.evaluate(
  `fetch(${JSON.stringify(url)}, { mode: 'no-cors', cache: 'no-store' }).then(() => 'reached', () => 'failed')`,
);

test('a launched browser reaches 127.0.0.1 and no other host', { skip }, async (t) => {
  const { port, hosts } = await startProbeSite(t);
  const browser = await launch(CHROMIUM, `http://127.0.0.1:${port}/`);
  t.after(() => browser.close());

  assert.equal(await reach(browser, `http://127.0.0.1:${port}/probe`), 'reached',
    `the page could not fetch from its own server on 127.0.0.1:${port}, so nothing below proves anything`);
  // Chromium answers every *.localhost name with loopback itself, without asking DNS, so
  // this name reaches the probe server on any box, online or not -- unless `launch()`
  // has made names other than 127.0.0.1 unresolvable.
  const name = `qcm-offline-probe.localhost:${port}`;
  assert.equal(await reach(browser, `http://${name}/probe`), 'failed',
    `the page reached this box's probe server as ${name}: a launched browser resolves names other than 127.0.0.1`);
  assert.equal(await reach(browser, 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/0/0/0'), 'failed',
    'the page fetched a USGS base tile from basemap.nationalmap.gov: a launched browser reaches the internet');
  assert.deepEqual(hosts, [`127.0.0.1:${port}`], 'the probe server was reached under a name other than 127.0.0.1');
});

test('a proxy named in the environment does not carry a launched browser off the box', { skip }, async (t) => {
  const { port } = await startProbeSite(t);
  const proxied = [];
  const proxy = http.createServer((req, res) => {
    proxied.push(`${req.method} ${req.url}`);
    res.writeHead(204);
    res.end();
  });
  const proxyPort = await freePort();
  await new Promise((r) => proxy.listen(proxyPort, '127.0.0.1', r));
  t.after(() => new Promise((r) => { proxy.closeAllConnections(); proxy.close(r); }));
  const before = process.env.http_proxy;
  process.env.http_proxy = `http://127.0.0.1:${proxyPort}`;
  t.after(() => { if (before === undefined) delete process.env.http_proxy; else process.env.http_proxy = before; });

  const browser = await launch(CHROMIUM, `http://127.0.0.1:${port}/`);
  t.after(() => browser.close());

  // .test is reserved and resolves nowhere, so only a proxy can answer for it.
  const outcome = await reach(browser, 'http://qcm-outside.test/probe');
  assert.deepEqual(proxied, [], `the browser sent ${proxied.join(', ')} through the proxy http_proxy names`);
  assert.equal(outcome, 'failed', 'the page fetched http://qcm-outside.test/probe');
});

test('every Chromium a test here starts takes OFFLINE_ARGS', () => {
  const starts = [];
  for (const file of readdirSync(HERE, { recursive: true }).filter((f) => f.endsWith('.mjs'))) {
    const src = readFileSync(path.join(HERE, file), 'utf8');
    // From each headless flag to the end of the argument list it is in.
    for (const m of src.matchAll(/['"`]--headless\b[^\]]*\]/g)) {
      starts.push({ at: `${file}:${src.slice(0, m.index).split('\n').length}`, offline: m[0].includes('...OFFLINE_ARGS') });
    }
  }
  assert.ok(starts.some((s) => s.at.startsWith(`${path.join('helpers', 'browser.mjs')}:`)),
    `the scan found no Chromium start in helpers/browser.mjs, so it is not finding starts at all (found: ${JSON.stringify(starts)})`);
  const online = starts.filter((s) => !s.offline).map((s) => s.at);
  assert.deepEqual(online, [], `Chromium started without OFFLINE_ARGS, so a page in it can reach the internet: ${online.join(', ')}`);
});
