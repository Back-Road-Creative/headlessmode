import { VIEWPORT_FETCH } from '../../../themes/headlessmode/static/js/quiet-corners-maps/app-state.js';
import { PAGE_RECORD } from './browser.mjs';

// Wait for the condition, not for a number of milliseconds.
//
// quiet-corners.js paints the map first and fetches candidates.json (~1.8MB)
// afterwards, deliberately un-awaited. So a proof that sleeps 350 ms and then
// reads the finder is not waiting for the finder at all -- findPlaces() returns
// [] for every query until that export is in memory, and an empty list is
// indistinguishable from "no such town". The sleep is a bet that 1.8MB parsed
// in 350 ms, which holds on an idle box and fails on a loaded one: three proofs
// went red that way at load 28-45 and passed alone a minute later. A red that
// means nothing and a green that proves nothing.
//
// Two rules here. Poll the thing the test actually cares about, with a ceiling
// generous enough for a box running three CI workers on twelve cores. And when
// the ceiling is reached, say WHICH condition never came true -- a poll that
// gives up quietly has moved the problem, not fixed it, because the assertion
// below it then reports a working page as a broken one.
//
// Nothing here is unbounded: launch() carries its own 120 s deadline on every
// protocol call, so a hang is still a failed test and never a hung run.

/** The ceiling for every wait below. Long because load 45 is this box's real
 *  operating condition, not an aberration; short enough to sit inside the
 *  120 s protocol deadline so a genuine hang is still reported as one. */
export const WAIT_MS = 60000;

/** Page-side waits, installed once per page by readyDashboard(). Evaluating
 *  this defines qcWait / qcMoves / qcMeasured / qcData on the page so a probe expression can
 *  wait inside the page, where the DOM it is waiting on lives. */
export const WAITS_SRC = `(() => {
  // Monotonic, like waitInPage below: the box's wall clock steps when WSL2 resyncs
  // (page-waits-clock.test.mjs).
  window.qcWait = async (what, ok, ms = ${WAIT_MS}) => {
    const end = performance.now() + ms;
    for (;;) {
      let got = null;
      try { got = ok(); } catch { got = null; }
      if (got) return got;
      if (performance.now() >= end) throw new Error('waited ' + ms + ' ms and ' + what + ' never came true');
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  /** Arm BEFORE the thing that moves the map, await after. flyTo/flyToBounds are
   *  rAF-driven, so "0.8 s animation" is not a number a loaded box honours; and a
   *  setView across the country does not animate at all. Requiring a move to have
   *  ENDED tells the two apart, and requiring the view to read the same twice
   *  running is what says the frames have stopped. */
  window.qcMoves = () => {
    const map = window.qcMap;
    let ends = 0, last = null;
    const on = () => { ends++; };
    map.on('moveend zoomend', on);
    return (what) => window.qcWait(what, () => {
      const c = map.getCenter(), now = c.lat + ',' + c.lng + '@' + map.getZoom();
      const still = ends > 0 && now === last;
      last = now;
      if (still) map.off('moveend zoomend', on);
      return still;
    });
  };
  /** Call AFTER changing anything that sizes the map's box (the root font size, a
   *  panel). The ResizeObserver on #qc-map (quiet-corners.js createMap) runs
   *  invalidateSize a frame later, and its moveend redraws the town labels; through
   *  qc:town-labels-changed that redraws main.js's names and the selected search pin,
   *  which reopens an open card and sends its elevation request again. Leaflet keeps
   *  the size it last measured until invalidateSize runs, and the whole chain runs
   *  inside that call, so the map has caught up once its size matches its box on two
   *  polls running. A change that leaves the box alone passes at once. */
  window.qcMeasured = (what) => {
    const map = window.qcMap, box = map.getContainer();
    let last = false;
    return window.qcWait(what, () => {
      const s = map.getSize(), now = s.x === box.clientWidth && s.y === box.clientHeight;
      const still = now && last;
      last = now;
      return still;
    });
  };
  /** The finder searches candidates.json and nothing else. quiet-corners.js
   *  unhides this section on the same line that assigns the data, so the DOM
   *  carries its own record of the moment the page can answer a search. */
  window.qcData = () => window.qcWait('the towns export (candidates.json) reached the page', () => {
    const s = document.getElementById('qc-candidates-section');
    return s && getComputedStyle(s).display !== 'none';
  });
  return true;
})()`;

/** What the dashboard says went wrong, in its own words, or null.
 *
 *  quiet-corners.js has three ways to give up, and every one of them leaves
 *  `window.qcMap` unset: counties.json missing writes the error banner
 *  (`showError`, from `loadData`), createMap throwing writes into the map box
 *  (`showMapMessage`, from `loadData`), and anything uncaught in the load chain
 *  writes the banner again (`showError`, from `startLoad`). So a wait that only
 *  polls for the map reports "the map never came true" after a full minute of a
 *  page that knew what had happened within a second and was saying so on screen.
 *
 *  Reading it turns that minute of silence into the page's own sentence. */
export const PAGE_TROUBLE = `(() => {
  const banner = document.getElementById('qc-error');
  if (banner && getComputedStyle(banner).display !== 'none') {
    const msg = document.getElementById('qc-error-msg');
    const said = msg ? msg.textContent.trim() : '';
    return 'the page is showing its own error banner: ' + (said ? '"' + said + '"' : '(the banner is up with no text in it)');
  }
  const box = document.getElementById('qc-map');
  const text = box ? box.textContent.trim() : '';
  if (text.startsWith('Map failed to load')) return 'the map box is showing: "' + text + '"';
  return null;
})()`;

/** Where the page is and what it was doing, for the sentence a wait ends on when its
 *  ceiling is reached.
 *
 *  That sentence used to end "it is still loading, or its script never ran": two
 *  causes, and nothing to tell them apart. This names the evidence for both. A tab on
 *  Chromium's own error page says so, with the code the page shows. Otherwise: where
 *  the page is and how far it loaded; on an http(s) page, each request to the page's
 *  own server that answered an error status or got no response (status 0), read from
 *  the browser's resource-timing list -- other origins are left out, because under
 *  OFFLINE_ARGS an outside request fails unless a test answers it itself, and a
 *  cross-origin entry can read status 0 even when it worked; and, from the
 *  PAGE_RECORD launch() keeps on every document, what the page threw or rejected with
 *  no handler, and whether that request list filled up. A page launch() did not start
 *  has no record, and the sentence then says nothing about throws rather than claim
 *  there were none. dashboard-load-failure.test.mjs holds each part. */
export const PAGE_STATE = `(() => {
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  if (location.protocol === 'chrome-error:') {
    const code = document.querySelector('.error-code');
    const said = code ? code.textContent.trim() : '';
    return "the tab is on Chromium's own error page (" + (said ? cut(said, 80) : 'no error code on it')
      + '): the navigation itself failed';
  }
  const web = /^https?:$/.test(location.protocol);
  const parts = [(web ? 'at ' + cut(location.pathname + location.search, 120) : 'a ' + location.protocol + ' page')
    + ', ' + document.readyState
    + (document.title ? ', titled "' + cut(document.title, 80) + '"' : ', untitled')];
  const rec = window[${JSON.stringify(PAGE_RECORD)}];
  if (web) {
    const own = performance.getEntriesByType('resource').filter((e) => e.name.startsWith(location.origin + '/'));
    if (own.some((e) => typeof e.responseStatus !== 'number')) {
      parts.push('this browser reports no status for its requests, so a failed one cannot be named');
    } else {
      const bad = own.filter((e) => e.responseStatus === 0 || e.responseStatus >= 400)
        .map((e) => new URL(e.name).pathname + (e.responseStatus ? ' answered ' + e.responseStatus : ' got no response'));
      parts.push(bad.length
        ? bad.slice(0, 5).join(', ') + (bad.length > 5 ? ' and ' + (bad.length - 5) + ' more' : '')
        : 'nothing it asked its own server for failed');
    }
    if (rec && rec.listFull) parts.push('its request list filled up, so a failed request may be missing from it');
  }
  // Field Maps' start() (main.js) records the await it is in; name it while the
  // restore has not settled, so a stalled restore wait says where (restore-stage.test.mjs).
  if (document.getElementById('qc-map') && window.qcRestoreSettled !== true) {
    parts.push(typeof window.qcRestoreStage === 'string'
      ? 'Field Maps start-up is at: ' + window.qcRestoreStage
      : 'Field Maps start-up never began (main.js has not run its start())');
  }
  if (rec) {
    parts.push(rec.errors.length
      ? 'it threw ' + rec.errors.map((t) => '"' + t + '"').join(', ') + (rec.more ? ' and ' + rec.more + ' more' : '')
      : 'nothing on it threw');
  }
  return parts.join('; ');
})()`;

/** Node-side twin of qcWait, for the loops that live outside a page expression.
 *
 *  `trouble` is an expression that returns the page's own account of a failure,
 *  or null. When it answers, the wait stops THERE rather than running out the
 *  ceiling: the page has already decided, and every further poll is a minute
 *  spent turning a diagnosis back into a silence.
 *
 *  It defaults ON, for every caller, because the callers that wait directly are
 *  the ones this bites: sort-reach.test.mjs:102 spent 60 s on
 *  `#qc-table-body .qc-row` in CI while the same test's phone cases passed in
 *  2 s, and the run said nothing about why. PAGE_TROUBLE returns null on any
 *  page without the dashboard's error surfaces, so it costs a cheap evaluate per
 *  poll and nothing else. Pass `null` to opt a wait out.
 *
 *  A wait that reaches its ceiling ends on where the page is and what it was doing
 *  (PAGE_STATE), whatever `trouble` is, so a page that reports nothing of its own
 *  still shows its failed requests and what it threw. */
export async function waitInPage(page, what, expression, ms = WAIT_MS, trouble = PAGE_TROUBLE) {
  // Monotonic: the box's wall clock steps when WSL2 resyncs (see removeProfile).
  const end = performance.now() + ms;
  for (;;) {
    if (await page.evaluate(expression)) return true;
    if (trouble) {
      const said = await page.evaluate(trouble);
      if (said) throw new Error(`${what} never came true, and ${said}`);
    }
    if (performance.now() >= end) {
      const said = trouble ? await page.evaluate(trouble) : null;
      let state;
      try { state = await page.evaluate(PAGE_STATE); } catch (err) { state = `it could not be read (${err.message})`; }
      throw new Error(`waited ${ms} ms and ${what} never came true`
        + (said ? `, and ${said}` : trouble ? ', and the page reports no failure of its own' : '')
        + `. The page: ${state}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Installs the page-side waits and holds until the dashboard can answer.
 *  `data: false` for a proof that only needs the map -- since A0 the map is
 *  created before any dataset settles, so window.qcMap implies only the map,
 *  base tiles, search and print builder; every dataset (counties, summary,
 *  navigation-places, candidates) is a separate, later arrival that
 *  `window.qcData()` waits for.
 *
 *  It also waits for `window.qcRestoreSettled`. Field Maps' start() (main.js) restores
 *  the last saved job from IndexedDB only after the map exists, then saves it again
 *  without awaiting, and sets the flag once both have landed. A proof that seeds
 *  IndexedDB straight after the map comes up could lose to that save: on #652's PR CI
 *  run 36653058133, late-restore-browser.test.mjs read back the previous test's area
 *  where it had seeded its own. `restored: false` is for the one proof that holds the
 *  restore itself.
 *
 *  `ms` can only RAISE the start-up budget (startupBudget). The budget a proof
 *  measures its own steps by -- the 20 s CEILING fourteen browser proofs define --
 *  is not the budget the page needs to start: under three concurrent PR CI runs on
 *  2026-10-07, start-up passed 20 s and eight proofs across #731/#733/#734 failed
 *  on "the last-job restore to settle ... never came true" before asserting
 *  anything of their own (ready-dashboard-budget.test.mjs).
 *
 *  A start-up that STALLED -- the page loaded, scripts of its own got no response,
 *  and main.js never began start() (STARTUP_STALL) -- fails at once instead of
 *  waiting out the budget, and is retried by ONE reload of the same address. A
 *  second failure of any kind is final and says it came after one reload, with the
 *  first load's account, so a server that keeps dropping files still fails, by name. */
export async function readyDashboard(page, opts = {}) {
  try {
    await readyOnce(page, opts);
  } catch (first) {
    if (!String(first.message).includes(STALL_MARK)) throw first;
    // ONE reload, then the second answer is final -- a server that keeps dropping the
    // page's files fails here, naming them, rather than retrying until the job times out.
    await page.navigate(await page.evaluate('location.href'));
    try { await readyOnce(page, opts); } catch (again) {
      again.message = `after one reload (the first load: ${first.message}), ${again.message}`;
      throw again;
    }
  }
}

async function readyOnce(page, { data = true, loaded = true, restored = true, ms } = {}) {
  const budget = startupBudget(ms);
  await page.evaluate(WAITS_SRC);
  const trouble = `((${PAGE_TROUBLE}) || (${STARTUP_STALL}))`;
  const ready = loaded ? 'window.qcMap && window.qcMap._loaded' : 'window.qcMap';
  await waitInPage(page, `the map (${ready})`, `Boolean(${ready})`, budget, trouble);
  if (restored) await waitInPage(page, 'the last-job restore to settle (window.qcRestoreSettled)', 'window.qcRestoreSettled === true', budget, trouble);
  if (data) await page.evaluate('window.qcData()');
}

const STALL_MARK = 'start-up scripts got no response';

/** The stall PR CI met on #836 and #846 (runs 39406075411, 39416459714), or null: the
 *  page finished loading, a script of its own got no response at all (status 0, a
 *  network failure, not an error status), and Field Maps' start() never began. A module
 *  graph whose fetch failed never asks again, so nothing on that document can still come
 *  up, and waiting out the start-up budget only turns a decided failure into a silent
 *  minute. readyDashboard() reloads once on this sentence (dashboard-load-failure.test.mjs).
 *  A script that answered 404 is a broken build, not a stall, and is not retried. */
export const STARTUP_STALL = `(() => {
  if (document.readyState !== 'complete' || !document.getElementById('qc-map')) return null;
  if (window.qcMap || typeof window.qcRestoreStage === 'string') return null;
  const dropped = performance.getEntriesByType('resource')
    .filter((e) => e.name.startsWith(location.origin + '/') && /\\.m?js$/.test(new URL(e.name).pathname) && e.responseStatus === 0)
    .map((e) => new URL(e.name).pathname);
  if (!dropped.length) return null;
  return '${STALL_MARK} (' + dropped.slice(0, 5).join(', ') + (dropped.length > 5 ? ' and ' + (dropped.length - 5) + ' more' : '')
    + '). The page: ' + ${PAGE_STATE};
})()`;

/** The start-up budget readyDashboard() runs on: never below WAIT_MS, whatever a
 *  proof asked for. A page that reports its own failure still ends the wait at
 *  once (waitInPage's `trouble`), so the floor costs a genuinely broken page
 *  nothing; it only stops a loaded box from failing a proof that never started. */
export function startupBudget(ms) {
  return Math.max(ms ?? WAIT_MS, WAIT_MS);
}

/** Page-side: the timers of the browse debounce's length (VIEWPORT_FETCH.settleMs)
 *  that are set and not yet fired or cleared, as `window.qcDebounces`. Installed on
 *  the first call per page; timers set before it are not seen, which is why it is
 *  installed before the click that arms the one chooseExampleArea waits on. */
const DEBOUNCE_WATCH = `if (!window.qcDebounces) {
      const set = window.setTimeout, clear = window.clearTimeout;
      window.qcDebounces = new Set();
      window.setTimeout = function (fn, ms, ...rest) {
        if (ms !== ${VIEWPORT_FETCH.settleMs}) return set.call(this, fn, ms, ...rest);
        const h = set.call(this, (...a) => { window.qcDebounces.delete(h); return fn(...a); }, ms, ...rest);
        window.qcDebounces.add(h);
        return h;
      };
      window.clearTimeout = function (h) { window.qcDebounces.delete(h); return clear.call(this, h); };
    }`;

/** Choose the example area, then wait until a proof may tick a layer and press
 *  Check sources without a second fetch racing the first.
 *
 *  main.js asks the browsed viewport its own source question (browseViewport)
 *  VIEWPORT_FETCH.settleMs after the last moveend. A layer ticked before that
 *  timer fires is fetched TWICE -- once for the viewport by the browse pass,
 *  once for the chosen area by the button's pass -- and the two passes share
 *  state.states, so whichever finishes last writes the badge. A stubbed service
 *  that fails its first N answers hands them to whichever pass asks first:
 *  measured 2026-09-26, the browse pass took all four failures and the button's
 *  pass read 'ready', so "badge reads unavailable" never came true (#571), and
 *  a browse pass that re-fetched names rebuilt the marker a proof had focused,
 *  so Enter fell on a detached node (#567). Both passed on an idle box because
 *  the button's pass usually finished first there.
 *
 *  So: click, wait for the map to stop moving (qcMoves, so the "map never
 *  moved" checks downstream measure a settled view), then wait for the debounce
 *  to have fired. main.js keeps that timer in a module variable and exposes no
 *  idle flag, so DEBOUNCE_WATCH records every page timer of the debounce's own
 *  length from the moment it is set until it fires or is cleared; the debounce
 *  has fired once none is left. That is the condition itself, not a margin past
 *  it: this used to sleep VIEWPORT_FETCH.settleMs + 100 after the map settled,
 *  every call. With no layer on at that moment the browse plan is 'none-on' and
 *  fetches nothing. */
export async function chooseExampleArea(page) {
  await page.evaluate(`(async () => {
    ${DEBOUNCE_WATCH}
    const settled = qcMoves();
    document.getElementById('qcm-use-example').click();
    await settled('the map stopped moving after choosing the example area');
    await qcWait('the viewport browse debounce to fire', () => window.qcDebounces.size === 0);
    return true;
  })()`);
}
