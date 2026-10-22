// When the dashboard gives up, the wait says so instead of counting to sixty.
//
// #516 replaced the sleeps with waits that name the condition they gave up on.
// One of those waits went red on this box at load 21.7 with
//
//     waited 60000 ms and the map (window.qcMap && window.qcMap._loaded) never came true
//
// which is true and tells nobody anything. quiet-corners.js has three ways to
// give up on the load, and every one of them leaves window.qcMap unset while
// writing a plain-English reason onto the page:
//
//   counties.json missing    -> showError('Dashboard data failed to load...')    loadData()
//   createMap throws         -> showMapMessage('Map failed to load: ' + msg)     loadData()
//   anything else uncaught   -> showError('Dashboard failed to render: ' + msg)  startLoad()
//
// So the page knew, within a second, and said so on screen; the wait then spent
// a minute not looking at it and reported a diagnosis it had thrown away. That
// is the gap #516's own header promised to close -- "say WHICH condition never
// came true" -- one level down: which condition, and what the page says about it.
//
// The two failure proofs construct the DOM state the app's own showError() and
// showMapMessage() produce rather than breaking a fetch: what they hold is the
// wait reading the page's sentence, and a state set after the real load has
// finished cannot race it. What keeps the fixture honest is the third test: it
// reads quiet-corners.js and asserts the element ids and the exact sentences are
// the ones the app really writes, so a rename on either side fails here rather
// than leaving the proof quietly pretending.
//
// That leaves the silent case: no map and no sentence, which CI kept meeting as
// "the page reports no failure of its own — it is still loading, or its script
// never ran", a guess with two answers and nothing to tell them apart. A wait
// that runs out now ends with what the page can say for itself (PAGE_STATE in
// helpers/waits.mjs): that the tab is on Chromium's error page because the
// navigation failed, which of the page's own requests answered an error or
// nothing at all, and what it threw. The later proofs break each of those for
// real -- a closed port, a 204, a file the server answers 404 or hangs up on
// (helpers/site-server.mjs `fail` and `drop`), a page that throws -- and one
// healthy load holds the sentence to blaming nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChromium, launch, navigatePage, REFUSED_ORIGIN } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage, WAIT_MS } from './helpers/waits.mjs';
import { formatFragment, DEFAULT_VIEW } from '../../themes/headlessmode/static/js/quiet-corners-maps/view-state.js';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built — run `hugo --configDir site-config --minify` first'
    : false;

const SOURCE = 'themes/headlessmode/static/js/quiet-corners.js';
const BANNER_TEXT = 'Dashboard data failed to load. Check your connection, then retry.';
const MAP_TEXT = 'Map failed to load: Leaflet is not defined';

/** A short ceiling: the point of these proofs is that the wait stops long before
 *  it, so a regression that waits the ceiling out is a failure either way. */
const CEILING = 15000;

async function onDashboard(fn) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, `${site.origin}/quiet-corners/`, {
    viewport: { width: 1280, height: 900 }, args: ['--hide-scrollbars'],
  });
  try { return await fn(page); } finally { page.close(); await site.close(); }
}

/** Put the page in the state one of the app's give-up paths leaves behind:
 *  its message on screen and no map object. */
const failed = (how) => `(() => {
  delete window.qcMap;
  ${how}
  return true;
})()`;

const showedBanner = failed(`
  document.getElementById('qc-error-msg').textContent = ${JSON.stringify(BANNER_TEXT)};
  document.getElementById('qc-error').style.display = '';`);

const showedMapMessage = failed(`
  document.getElementById('qc-map').textContent = ${JSON.stringify(MAP_TEXT)};`);

async function refusalFrom(page, state) {
  // Let the real load finish first. launch() returns at the load event, while
  // loadData() is still in flight -- set the failure state before it lands and
  // it assigns window.qcMap over the top, and the proof measures nothing.
  await readyDashboard(page, { ms: 60000 });
  await page.evaluate(state);
  const began = Date.now();
  const err = await readyDashboard(page, { ms: CEILING }).then(
    () => null, (e) => e,
  );
  return { err, took: Date.now() - began };
}

test('a dashboard that gave up is reported in its own words, not as a silent minute', { skip }, async () => {
  const { err, took } = await onDashboard((page) => refusalFrom(page, showedBanner));
  assert.ok(err, 'readyDashboard resolved on a page with no map and its error banner up');
  assert.match(err.message, new RegExp(BANNER_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    `the wait gave up without quoting the sentence the page was showing: ${err.message}`);
  assert.ok(took < CEILING / 2,
    `the page said what was wrong and the wait kept polling for ${took} ms of its ${CEILING} ms ceiling`);
});

test('a map that failed to build is reported from the box it wrote into', { skip }, async () => {
  const { err, took } = await onDashboard((page) => refusalFrom(page, showedMapMessage));
  assert.ok(err, 'readyDashboard resolved on a page whose map box carries a failure message');
  assert.match(err.message, /Map failed to load/,
    `the wait gave up without reading the map box: ${err.message}`);
  assert.ok(took < CEILING / 2,
    `the map box said what was wrong and the wait kept polling for ${took} ms of its ${CEILING} ms ceiling`);
});

test('the fixtures are the surfaces and sentences the app really writes', () => {
  const js = readFileSync(SOURCE, 'utf8');
  for (const id of ['qc-error', 'qc-error-msg', 'qc-map']) {
    assert.match(js, new RegExp(`getElementById\\('${id}'\\)`),
      `${SOURCE} no longer reads #${id} — the failure proofs above are writing into a surface the app has stopped using`);
  }
  assert.ok(js.includes(`showError('${BANNER_TEXT}')`),
    `${SOURCE} no longer writes "${BANNER_TEXT}" — update the fixture to the sentence it writes now`);
  assert.ok(js.includes("showMapMessage('Map failed to load: '"),
    `${SOURCE} no longer writes "Map failed to load: " — update the fixture to the sentence it writes now`);
});

test('a dashboard that loads normally is not accused of failing', { skip }, async () => {
  await onDashboard(async (page) => {
    await readyDashboard(page, { ms: 60000 });
    const shown = await page.evaluate(`(() => {
      const b = document.getElementById('qc-error');
      return b ? getComputedStyle(b).display : 'no banner element';
    })()`);
    assert.equal(shown, 'none', 'the dashboard loaded with its error banner showing');
  });
});

// B1: a link carrying #map=v1&... opens on that view, and the reader's own
// back/forward buttons move through the views the page has written since.
test('a #map= link opens on that view, and back restores it after a second entry', { skip }, async () => {
  const { fragment: fragment1 } = formatFragment({
    ...DEFAULT_VIEW, zoom: 8, center: [41.5, -85.25], base: 'usgsImagery',
  });
  const { fragment: fragment2 } = formatFragment({
    ...DEFAULT_VIEW, zoom: 6, center: [44.0, -89.0], base: 'usgsTopo',
  });
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, `${site.origin}/quiet-corners/${fragment1}`, {
    viewport: { width: 1280, height: 900 },
  });
  try {
    await readyDashboard(page, { ms: 60000 });
    const waitSrc = `async (ok) => {
      for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
      return ok();
    }`;
    const readView = `(async () => {
      const wait = ${waitSrc};
      await wait(() => document.querySelectorAll('input[name="qcm-base"]:checked').length);
      const c = window.qcMap.getCenter();
      return {
        zoom: window.qcMap.getZoom(),
        center: [Math.round(c.lat * 100) / 100, Math.round(c.lng * 100) / 100],
        base: document.querySelector('input[name="qcm-base"]:checked').id,
      };
    })()`;
    const opened = await page.evaluate(readView);
    assert.equal(opened.zoom, 8, 'the link\'s zoom was not applied on open');
    assert.deepEqual(opened.center, [41.5, -85.25], 'the link\'s center was not applied on open');
    assert.equal(opened.base, 'qcm-base-usgsImagery', 'the link\'s base was not applied on open');

    // A second, distinct #map= entry (as if the reader had followed another
    // shared link) becomes a real history entry the way a normal hash-carrying
    // navigation does. Going back from it must fire `popstate`, which the app
    // re-applies through the same setters -- never a second, competing writer.
    await page.evaluate(`location.hash = ${JSON.stringify(fragment2.slice(1))}; void 0;`);
    await page.evaluate('history.back(); void 0;');
    const back = await page.evaluate(`(async () => {
      const wait = ${waitSrc};
      await wait(() => window.qcMap.getZoom() === 8);
      const c = window.qcMap.getCenter();
      return {
        zoom: window.qcMap.getZoom(),
        center: [Math.round(c.lat * 100) / 100, Math.round(c.lng * 100) / 100],
        base: document.querySelector('input[name="qcm-base"]:checked').id,
      };
    })()`);
    assert.equal(back.zoom, 8, 'back did not restore the previous zoom');
    assert.deepEqual(back.center, [41.5, -85.25], 'back did not restore the previous center');
    assert.equal(back.base, 'qcm-base-usgsImagery', 'back did not restore the previous base');
  } finally { page.close(); await site.close(); }
});

// B1 item 7: the finder's result shell is keyboard-navigable and the row the
// keys land on is the row Enter chooses -- not just that some option is marked
// active (find-and-scale.test.mjs already covers that), but that arrow keys
// move aria-activedescendant onto a DIFFERENT option each press and that the
// map actually ends up centred on the one Enter fired on, grouped rendering
// and all.
test('arrow keys move the active option one at a time, and Enter moves the map to it', { skip }, async () => {
  await onDashboard(async (page) => {
    await readyDashboard(page, { ms: 60000 });
    const seen = await page.evaluate(`(async () => {
      const toggle = document.querySelector('.qc-finder-toggle');
      if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
      const box = document.getElementById('qc-place-search');
      const list = document.getElementById('qc-place-results');
      box.focus();
      box.value = 'Ashland';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      const wait = async (ok) => {
        for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
        return ok();
      };
      await wait(() => list.querySelectorAll('[role="option"]').length >= 2);
      const down = (n) => { for (let i = 0; i < n; i++)
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); };
      down(1);
      const first = box.getAttribute('aria-activedescendant');
      down(1);
      const second = box.getAttribute('aria-activedescendant');
      const target = document.getElementById(second);
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await wait(() => window.qcMap.getZoom() >= 10);
      const c = window.qcMap.getCenter();
      return {
        first, second, targetGroup: target.closest('[role="group"]') ? target.closest('[role="group"]').getAttribute('aria-label') : null,
        zoom: window.qcMap.getZoom(), lat: c.lat,
      };
    })()`);
    assert.ok(seen.first, 'the first ArrowDown set no aria-activedescendant');
    assert.ok(seen.second, 'the second ArrowDown set no aria-activedescendant');
    assert.notEqual(seen.first, seen.second, 'a second ArrowDown left the active option unchanged');
    assert.equal(seen.targetGroup, 'Towns', 'the option is not inside a group labelled "Towns"');
    assert.ok(seen.zoom >= 10, `Enter left the map at zoom ${seen.zoom} — it did not choose the active option`);
  });
});

// The waits that bite are not all readyDashboard's. sort-reach.test.mjs:102
// calls waitInPage directly and spent 60 s in CI on
// `#qc-table-body .qc-row` while the same file's phone cases passed in 2 s --
// and the run said nothing about why. So the probe is the DEFAULT argument,
// not something each caller has to remember, and this is the proof of that.
test('a wait that calls waitInPage directly gets the page\'s account too', { skip }, async () => {
  const { err, took } = await onDashboard(async (page) => {
    await readyDashboard(page, { ms: 60000 });
    await page.evaluate(showedBanner);
    const began = Date.now();
    const e = await waitInPage(
      page, 'a row in the county table',
      `Boolean(document.querySelector('#qc-table-body .qc-row-that-will-never-exist'))`,
      CEILING,
    ).then(() => null, (x) => x);
    return { err: e, took: Date.now() - began };
  });
  assert.ok(err, 'waitInPage resolved on a selector that cannot match');
  assert.match(err.message, new RegExp(BANNER_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    `a direct waitInPage caller gave up without the page's own sentence: ${err.message}`);
  assert.ok(took < CEILING / 2,
    `the page said what was wrong and the wait kept polling for ${took} ms of its ${CEILING} ms ceiling`);
});

// A navigation that cannot complete is a failure of its own, in Chromium's
// words. navigate() used to resolve on Chromium's error page, which fires a
// load event like any page, and the wait after it spent its whole ceiling on a
// tab that was never going to be the dashboard.
// The "nothing listens here" address must stay that way for the whole proof below. A
// freePort() number is free only until something binds it, and the next launch() hands
// Chromium `--remote-debugging-port=0`, which can land on exactly that number: in PR CI run
// 37496887896 the second navigation to the "closed" port reached Chromium's own DevTools
// server and resolved. So the refused address is a port no process on this box can start
// listening on. This proof tries, and expects the kernel to say no.
test('the refused address is a port this process cannot start listening on', async () => {
  const { port } = new URL(REFUSED_ORIGIN);
  const err = await new Promise((resolve) => {
    const s = net.createServer();
    s.on('error', resolve);
    s.listen(Number(port), '127.0.0.1', () => s.close(() => resolve(null)));
  });
  assert.ok(err, `this process started listening on port ${port}; a test's own Chromium could too`);
  assert.equal(err.code, 'EACCES', `expected a privileged port, got ${err.code}`);
});

test('a navigation that fails rejects at once with Chromium\'s reason, and the tab stays usable', { skip }, async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/no-content') res.writeHead(204).end();
    else res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<title>ok</title><p>ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  const origin = `http://127.0.0.1:${server.address().port}`;
  // Nothing listens here, and nothing can start to (the proof above).
  const refused = `${REFUSED_ORIGIN}/quiet-corners/`;
  try {
    const fromLaunch = await launch(CHROMIUM, refused).then((p) => { p.close(); return null; }, (e) => e);
    assert.ok(fromLaunch, 'launch() resolved on a page whose navigation was refused');
    assert.match(fromLaunch.message,
      /navigation to http:\/\/127\.0\.0\.1:\d+\/quiet-corners\/ failed: net::ERR_CONNECTION_REFUSED/);

    const page = await launch(CHROMIUM, 'about:blank', { timeoutMs: 20000 });
    try {
      let began = performance.now();
      const refusal = await page.navigate(refused).then(() => null, (e) => e);
      const tookRefused = performance.now() - began;
      assert.ok(refusal, 'a navigation to a closed port resolved');
      assert.match(refusal.message, /failed: net::ERR_CONNECTION_REFUSED/);
      assert.ok(tookRefused < CEILING / 2, `the refused navigation took ${Math.round(tookRefused)} ms to say so`);
      // The error page fires a load event of its own; navigate() waits it out
      // before rejecting, since left pending it settles the NEXT navigation's wait.
      assert.equal(await page.evaluate('location.href + " " + document.readyState'),
        'chrome-error://chromewebdata/ complete', 'navigate() rejected before the error page had finished loading');
      const there = await waitInPage(page, 'the impossible', 'false', 500, null).then(() => null, (e) => e);
      assert.ok(there, 'waitInPage resolved on false');
      assert.match(there.message, /Chromium's own error page \(ERR_CONNECTION_REFUSED\)/,
        `a wait on the error page did not say where the tab is: ${there.message}`);

      // A 204 commits nothing, so no load event follows it at all.
      began = performance.now();
      const aborted = await page.navigate(`${origin}/no-content`).then(() => null, (e) => e);
      const tookAborted = performance.now() - began;
      assert.ok(aborted, 'a navigation to a 204 resolved');
      assert.match(aborted.message, /failed: net::ERR_ABORTED/);
      assert.ok(tookAborted < CEILING / 2,
        `a 204 waited ${Math.round(tookAborted)} ms for a load event that never comes`);

      await page.navigate(`${origin}/`);
      assert.equal(await page.evaluate('document.title'), 'ok', 'the tab loaded nothing after two failed navigations');
    } finally { page.close(); }
  } finally { server.closeAllConnections(); server.close(); }
});

// The same navigation wherever a test drives one. camera-requests and terrain-panel
// open their own DevTools session, because they need every Fetch.requestPaused and
// launch()'s socket keeps one waiter per event, and each wrote its own navigate().
// camera-requests waited 30 s for the load event, which ran out on a loaded CI box
// ('Page.loadEventFired never fired within 30000 ms') before its test had asserted
// anything, and neither read Page.navigate's errorText, so a refused navigation sat
// on Chromium's error page until some later wait gave up on it. Both now call
// navigatePage(), which is what launch()'s navigate() is.
test('every navigation a test here drives goes through navigatePage()', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const calls = [];
  for (const file of readdirSync(here, { recursive: true }).filter((f) => f.endsWith('.mjs'))) {
    const src = readFileSync(path.join(here, file), 'utf8');
    for (const m of src.matchAll(/send\(\s*['"`]Page\.navigate['"`]/g)) {
      calls.push(`${file}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.equal(calls.length, 1,
    `Page.navigate is sent from ${calls.length} places (${calls.join(', ')}); only navigatePage() in helpers/browser.mjs may send it`);
  assert.ok(calls[0].startsWith(`${path.join('helpers', 'browser.mjs')}:`),
    `the one Page.navigate is not navigatePage()'s: ${calls[0]}`);
});

test('navigatePage() waits 120 s for the load unless told otherwise, and rejects with Chromium\'s reason', async () => {
  const asked = [];
  const once = (method, ms) => {
    asked.push([method, ms]);
    const fired = Promise.resolve();
    fired.cancel = () => asked.push(['cancel', method]);
    return fired;
  };
  await navigatePage(async () => ({ frameId: 'f' }), once, 'http://127.0.0.1:1/');
  assert.deepEqual(asked, [['Page.loadEventFired', 120000]], 'the default load wait is not 120 s');

  asked.length = 0;
  const refused = await navigatePage(async () => ({ errorText: 'net::ERR_CONNECTION_REFUSED' }), once, 'http://127.0.0.1:1/', 5000)
    .then(() => null, (e) => e);
  assert.ok(refused, 'a refused navigation resolved');
  assert.equal(refused.message, 'navigation to http://127.0.0.1:1/ failed: net::ERR_CONNECTION_REFUSED');
  assert.deepEqual(asked, [['Page.loadEventFired', 5000]], 'the load wait asked for was not the one passed');

  // A 204 commits nothing and no load follows it; a load wait that cannot be cancelled
  // (the plain promise a test's own once() returns) is left, never awaited.
  asked.length = 0;
  const aborted = await navigatePage(async () => ({ errorText: 'net::ERR_ABORTED' }), once, 'http://127.0.0.1:1/')
    .then(() => null, (e) => e);
  assert.match(aborted?.message ?? '', /failed: net::ERR_ABORTED$/);
  assert.deepEqual(asked, [['Page.loadEventFired', 120000], ['cancel', 'Page.loadEventFired']]);
  const never = () => new Promise(() => {});
  const plain = await navigatePage(async () => ({ errorText: 'net::ERR_ABORTED' }), never, 'http://127.0.0.1:1/')
    .then(() => null, (e) => e);
  assert.match(plain?.message ?? '', /failed: net::ERR_ABORTED$/);
});

// A page whose own files fail is not "still loading, or its script never ran":
// the wait names each of its requests that answered an error or nothing at all.
// locate.js is in quiet-corners.js's module graph and sheet-plan.js in main.js's,
// so the first failure in one graph cannot keep the other request from being made.
test('a map wait that runs out names the page\'s own requests that failed', { skip }, async () => {
  const site = await startSiteServer({
    fail: /\/js\/quiet-corners-maps\/locate\.js$/,
    drop: /\/js\/quiet-corners-maps\/sheet-plan\.js$/,
  });
  try {
    const page = await launch(CHROMIUM, `${site.origin}/quiet-corners/`);
    try {
      // No short ceiling: the page's own failure report ends the wait at once (startupBudget).
      const began = Date.now();
      const err = await readyDashboard(page).then(() => null, (e) => e);
      const took = Date.now() - began;
      assert.ok(err, 'the dashboard became ready with two of its own files failing');
      // A start-up script that got no response is retried by ONE reload, and a second
      // failure is final: the sentence says the reload happened, and neither load waited
      // out the start-up budget once a script had already failed.
      assert.match(err.message, /after one reload/, `the wait did not say it reloaded once: ${err.message}`);
      assert.ok(took < WAIT_MS, `the wait took ${took} ms on a page whose start-up script had already failed`);
      assert.match(err.message, /\/js\/quiet-corners-maps\/locate\.js answered 404/,
        `the wait did not name the file that answered 404: ${err.message}`);
      assert.match(err.message, /\/js\/quiet-corners-maps\/sheet-plan\.js got no response/,
        `the wait did not name the file that got no response: ${err.message}`);
    } finally { page.close(); }
  } finally { await site.close(); }
});

// The stall PR CI met on #836 and #846 (runs 39406075411, 39416459714): the page loaded,
// dozens of its own module scripts got no response from the test server, and main.js never
// ran start(). A module graph whose fetch failed never retries on its own, so the proof sat
// out the whole 60 s budget and failed before asserting anything. A file the server hangs up
// on for the whole FIRST load of the page stands in for that stall (Chromium itself retries a
// single hang-up on a reused connection, so dropping one request proves nothing); one reload
// must bring the dashboard up.
test('a start-up script that got no response once is retried by one reload, and the dashboard comes up', { skip }, async () => {
  let loads = 0;
  let dropped = 0;
  const firstLoad = { test: (at) => {
    if (at === '/quiet-corners/') loads += 1;
    const hit = loads === 1 && /\/js\/quiet-corners-maps\/sheet-plan\.js$/.test(at);
    if (hit) dropped += 1;
    return hit;
  } };
  const site = await startSiteServer({ drop: firstLoad });
  try {
    const page = await launch(CHROMIUM, `${site.origin}/quiet-corners/`);
    try {
      const began = Date.now();
      await readyDashboard(page);
      assert.ok(dropped >= 1, 'the first load never asked for sheet-plan.js, so nothing was dropped');
      assert.equal(loads, 2, `the page was loaded ${loads} times, not once and one reload`);
      assert.ok(Date.now() - began < WAIT_MS, 'the reload waited out the start-up budget first');
    } finally { page.close(); }
  } finally { await site.close(); }
});

// What the page threw is the other half of "or its script never ran".
test('a wait that runs out names what the page threw', { skip }, async () => {
  const html = '<title>t</title><script type=module>'
    + "Promise.reject(new Error('nobody caught this')); throw new Error('boom at load');</script>";
  const page = await launch(CHROMIUM, `data:text/html,${encodeURIComponent(html)}`);
  try {
    const err = await waitInPage(page, 'the impossible', 'false', 500).then(() => null, (e) => e);
    assert.ok(err, 'waitInPage resolved on false');
    assert.match(err.message, /Uncaught Error: boom at load \(in the page itself, line \d+\)/,
      `the wait did not name the page's own throw: ${err.message}`);
    assert.match(err.message, /Uncaught \(in promise\) Error: nobody caught this/,
      `the wait did not name the rejection nothing handled: ${err.message}`);
    assert.doesNotMatch(err.message, /own server/, `a data: page has no server of its own to blame: ${err.message}`);
  } finally { page.close(); }
});

// Five is all the record keeps. Past that the sentence counts what it left out, so a
// page that threw on every frame does not read as one that threw five times.
test('a wait that runs out counts the throws it does not name', { skip }, async () => {
  const html = '<title>t</title><script>'
    + "for (let i = 0; i < 7; i++) setTimeout(() => { throw new Error('throw ' + i); });</script>";
  const page = await launch(CHROMIUM, `data:text/html,${encodeURIComponent(html)}`);
  try {
    const err = await waitInPage(page, 'the impossible', 'false', 500, null).then(() => null, (e) => e);
    assert.ok(err, 'waitInPage resolved on false');
    assert.match(err.message, /"Uncaught Error: throw 4 \(in the page itself, line \d+\)" and 2 more$/,
      `the wait did not count the throws past five: ${err.message}`);
  } finally { page.close(); }
});

// And a page that is fine is not accused: the same sentence on a dashboard
// that loaded blames none of its requests and reports nothing thrown.
test('a wait that runs out on a healthy dashboard blames nothing on it', { skip }, async () => {
  const err = await onDashboard(async (page) => {
    await readyDashboard(page, { ms: 60000 });
    return waitInPage(page, '#qc-no-such-element', `Boolean(document.querySelector('#qc-no-such-element'))`, 1000)
      .then(() => null, (e) => e);
  });
  assert.ok(err, 'waitInPage resolved on a selector that cannot match');
  assert.match(err.message, /the page reports no failure of its own\. The page: at \/quiet-corners\/, complete/,
    `the wait did not say where a healthy page is: ${err.message}`);
  assert.match(err.message, /nothing it asked its own server for failed/,
    `the wait blamed a request on a healthy dashboard: ${err.message}`);
  assert.match(err.message, /nothing on it threw/, `the wait reported a throw on a healthy dashboard: ${err.message}`);
});

// The request list is the browser's resource-timing buffer: 250 entries unless a
// page raises it, as two test files here do. Once it is full a later failure is
// missing from it, and the sentence says so rather than pass a short list off as
// the whole.
test('a wait that runs out says when the page\'s request list filled up', { skip }, async () => {
  const site = await startSiteServer();
  try {
    const page = await launch(CHROMIUM, `${site.origin}/robots.txt`);
    try {
      await page.evaluate(`(async () => {
        performance.setResourceTimingBufferSize(3);
        for (let i = 0; i < 5; i++) await (await fetch('/robots.txt?' + i)).text();
        return true;
      })()`);
      const err = await waitInPage(page, 'the impossible', 'false', 500, null).then(() => null, (e) => e);
      assert.ok(err, 'waitInPage resolved on false');
      assert.match(err.message, /request list filled up/,
        `the wait read a full request list as a complete one: ${err.message}`);
    } finally { page.close(); }
  } finally { await site.close(); }
});

// B3: "Use my location" is a one-shot fix (getCurrentPosition, never
// watchPosition), a location-derived center never reaches the URL fragment
// or localStorage unless the reader explicitly ticks "Include my location",
// and every outcome (here: an in-coverage fix and PERMISSION_DENIED) leaves
// plain-language status text with no exception. Patched over the DevTools
// protocol before the page's own script runs, the same way map-ready-
// lifecycle.test.mjs patches window.fetch -- navigator.geolocation has no
// setter of its own, so the patch replaces it with Object.defineProperty.
const patchGeo = (mode) => `(() => {
  window.__qcGeoCalls = { getCurrentPosition: 0, watchPosition: 0 };
  const fix = { coords: { latitude: 38.9, longitude: -77.0, accuracy: 30 } };
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: function(success, error) {
        window.__qcGeoCalls.getCurrentPosition++;
        if (${JSON.stringify(mode)} === 'denied') error({ code: 1 });
        else success(fix);
      },
      watchPosition: function() { window.__qcGeoCalls.watchPosition++; },
    },
  });
})()`;

async function withPatchedGeo(mode, fn) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', {
    viewport: { width: 1280, height: 900 }, args: ['--hide-scrollbars'],
  });
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: patchGeo(mode) });
    await page.navigate(`${site.origin}/quiet-corners/`);
    return await fn(page);
  } finally { page.close(); await site.close(); }
}

test('a location fix inside the coverage area moves the map once, leaks nowhere, and Share only carries it when confirmed', { skip }, async () => {
  await withPatchedGeo('ok', async (page) => {
    await readyDashboard(page, { ms: 60000 });
    const before = await page.evaluate(`(() => { const c = window.qcMap.getCenter(); return [c.lat, c.lng]; })()`);

    await page.evaluate(`document.getElementById('qc-locate').click(); void 0;`);
    await waitInPage(page, 'the locate status to report a found fix',
      `/found your location/i.test(document.getElementById('qc-locate-status').textContent)`, CEILING, null);

    const calls = await page.evaluate('window.__qcGeoCalls');
    assert.equal(calls.getCurrentPosition, 1, 'getCurrentPosition should fire exactly once for one click');
    assert.equal(calls.watchPosition, 0, 'watchPosition should never be called');

    // The status text lands before flyToRM's animation finishes, so poll for
    // the map to actually settle near the fix rather than reading its center
    // the instant the status changes.
    await waitInPage(page, 'the map to settle near the location fix',
      `(() => { const c = window.qcMap.getCenter(); return Math.abs(c.lat - 38.9) < 0.05 && Math.abs(c.lng - (-77.0)) < 0.05; })()`,
      CEILING, null);
    const after = await page.evaluate(`(() => { const c = window.qcMap.getCenter(); return [c.lat, c.lng]; })()`);
    assert.notDeepEqual(after, before, 'the map did not move to the fix');

    const hash = await page.evaluate('location.hash');
    assert.ok(!/(^|[&#])c=/.test(hash), `a location-derived center leaked into the URL fragment: ${hash}`);
    const stored = await page.evaluate(`JSON.stringify(Object.keys(localStorage).map((k) => localStorage.getItem(k)))`);
    assert.ok(!stored.includes('38.9') && !stored.includes('-77'), `a location coordinate leaked into localStorage: ${stored}`);

    // Share without ticking "Include my location": the link carries no c=.
    await page.evaluate(`document.getElementById('qc-view-share').click(); void 0;`);
    await waitInPage(page, 'the share status to report a link',
      `/link/i.test(document.getElementById('qc-view-status').textContent)`, CEILING, null);
    const unconfirmed = await page.evaluate(`document.getElementById('qc-view-status').textContent`);
    assert.ok(!/(^|[&#])c=/.test(unconfirmed), `Share without confirmation should carry no c=: ${unconfirmed}`);
    assert.match(unconfirmed, /not included/i);

    // Tick "Include my location in the link", then Share again: now it does.
    const wrapHidden = await page.evaluate(`document.getElementById('qc-locate-include-wrap').hidden`);
    assert.equal(wrapHidden, false, 'the include-location checkbox should be shown once centerSource is location');
    await page.evaluate(`document.getElementById('qc-locate-include').click(); void 0;`);
    await page.evaluate(`document.getElementById('qc-view-share').click(); void 0;`);
    await waitInPage(page, 'the share status to report the location was included',
      `/included\\.$|was included/i.test(document.getElementById('qc-view-status').textContent)`, CEILING, null);
    const confirmed = await page.evaluate(`document.getElementById('qc-view-status').textContent`);
    assert.match(confirmed, /(^|[&#])c=/, `Share with confirmation should carry c=: ${confirmed}`);
  });
});

// B2: the remote GNIS name search, patched over the DevTools protocol the same
// way map-ready-lifecycle.test.mjs patches window.fetch, so no real network
// request reaches carto.nationalmap.gov -- the fixtures are the sanitised
// bodies N0 copied from the 2026-09-25 probes (name-search.test.mjs reads the
// same files for the pure-logic side of this contract).
const GEONAMES_URL = 'carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer/5/query';

function loadGeonamesFixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

/** Answers ANY request to the geonames layer-5 query endpoint with `body`,
 *  200 OK -- every other request (the five dashboard loads) goes to the real
 *  fetch untouched, same pattern as map-ready-lifecycle.test.mjs's patch. */
const patchGeonames = (body) => `(() => {
  const real = window.fetch.bind(window);
  const body = ${JSON.stringify(body)};
  window.fetch = function(input, init) {
    const url = String(input && input.url ? input.url : input);
    if (url.indexOf(${JSON.stringify(GEONAMES_URL)}) !== -1) {
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    }
    return real(input, init);
  };
})()`;

async function withPatchedGeonames(body, fn) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', {
    viewport: { width: 1280, height: 900 }, args: ['--hide-scrollbars'],
  });
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: patchGeonames(body) });
    await page.navigate(`${site.origin}/quiet-corners/`);
    return await fn(page);
  } finally { page.close(); await site.close(); }
}

const openFinderAndType = (query) => `(() => {
  const toggle = document.querySelector('.qc-finder-toggle');
  if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
  const box = document.getElementById('qc-place-search');
  box.focus();
  box.value = ${JSON.stringify(query)};
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;

test('an explicit name search renders a "Geographic names" group, and selecting a hit moves the map and shows its details', { skip }, async () => {
  const fixture = loadGeonamesFixture('geonames-search-coldmountain.min.json');
  await withPatchedGeonames(fixture, async (page) => {
    await readyDashboard(page, { ms: 60000 });
    await page.evaluate(openFinderAndType('Cold Mountain'));
    // Typing alone must never fire the remote search (task item 1) -- the
    // "Search names" button is the explicit trigger.
    await page.evaluate(`document.getElementById('qc-name-search-btn').click(); void 0;`);
    await waitInPage(page, 'the "Geographic names" group to render',
      `Array.from(document.querySelectorAll('#qc-place-results [role="group"]'))
        .some((g) => g.getAttribute('aria-label') === 'Geographic names')`, CEILING, null);
    // The name search speaks through the finder's ONE live region: a second
    // region beside the first had finder-announcement.test.mjs counting two.
    const nameStatus = await page.evaluate(`document.getElementById('qc-finder-status').textContent`);
    assert.match(nameStatus, /names$/, `the finder's status region should report a name count: ${nameStatus}`);
    const liveCount = await page.evaluate(
      `document.querySelectorAll('.qc-finder-box [aria-live], .qc-finder-box [role="status"], .qc-finder-box [role="alert"]').length`);
    assert.equal(liveCount, 1, `the finder has ${liveCount} live regions after a name search; it owns exactly one`);

    const before = await page.evaluate(`(() => { const c = window.qcMap.getCenter();
      return [c.lat, c.lng]; })()`);
    await page.evaluate(`(() => {
      const group = Array.from(document.querySelectorAll('#qc-place-results [role="group"]'))
        .find((g) => g.getAttribute('aria-label') === 'Geographic names');
      group.querySelector('[role="option"]').click();
    })()`);
    await waitInPage(page, 'the map to move off its starting center',
      `(() => { const c = window.qcMap.getCenter();
        return Math.abs(c.lat - ${JSON.stringify(before)}[0]) > 1e-6
          || Math.abs(c.lng - ${JSON.stringify(before)}[1]) > 1e-6; })()`, CEILING, null);

    // QUX-05c: ONE renderer for a selected place name -- the search path opens
    // the SAME map-pin popup card (Q/preview-overlay.js's siteCard), not a
    // bespoke #qc-name-details DOM the finder used to build for itself.
    await waitInPage(page, 'the one shared site card to open in the Leaflet popup pane',
      `document.querySelector('.leaflet-popup-pane .qcm-site-card') !== null`, CEILING, null);
    const details = await page.evaluate(`document.querySelector('.leaflet-popup-pane .qcm-site-card').innerHTML`);
    assert.match(details, /USGS GNIS/, `the selected-feature card should carry the source line: ${details}`);
    assert.match(details, /Cold Mountain/, `the selected-feature card should name the selected feature: ${details}`);
    const legacyMount = await page.evaluate(`document.getElementById('qc-name-details')`);
    assert.equal(legacyMount, null, 'the old #qc-name-details mount div must not exist in the DOM at all');

    const hash = await page.evaluate('location.hash');
    assert.ok(!/(^|[&#])c=/.test(hash),
      `selecting a named feature must not behave like a location fix (centerSource must not leak): ${hash}`);
  });
});

test('a failed name search shows the required failure copy, never "no results"', { skip }, async () => {
  await withPatchedGeonames(loadGeonamesFixture('geonames-error.min.json'), async (page) => {
    await readyDashboard(page, { ms: 60000 });
    await page.evaluate(openFinderAndType('Cold Mountain'));
    await page.evaluate(`document.getElementById('qc-name-search-btn').click(); void 0;`);
    await waitInPage(page, 'the name-search status to report the failure',
      `document.getElementById('qc-finder-status').textContent === 'Name search failed \\u2014 try again'`,
      CEILING, null);
    const note = await page.evaluate(`document.getElementById('qc-name-note').textContent`);
    assert.equal(note, 'Name search failed — try again');
    assert.doesNotMatch(note, /no results/i, 'a search failure must never read as "no results"');
  });
});

test('a denied location request leaves the map unmoved and shows the denial in plain language', { skip }, async () => {
  await withPatchedGeo('denied', async (page) => {
    await readyDashboard(page, { ms: 60000 });
    const before = await page.evaluate(`(() => { const c = window.qcMap.getCenter(); return [c.lat, c.lng, window.qcMap.getZoom()]; })()`);

    await page.evaluate(`document.getElementById('qc-locate').click(); void 0;`);
    await waitInPage(page, 'the locate status to report the denial',
      `/denied/i.test(document.getElementById('qc-locate-status').textContent)`, CEILING, null);

    const after = await page.evaluate(`(() => { const c = window.qcMap.getCenter(); return [c.lat, c.lng, window.qcMap.getZoom()]; })()`);
    assert.deepEqual(after, before, 'a denied location request should leave the map exactly where it was');
  });
});
