// QUX-06: one on-demand USGS 3DEP point elevation per opened name card. Drives
// the same window.qcSelectName bridge quiet-corners.js's "Search names" finder
// calls on a click (see main.js's own comment above that assignment) rather
// than re-driving the whole finder UI -- name-search.test.mjs's QUX-05a/
// QUX-05c tests already prove that wiring. This unit owns the card's
// elevation line, not the search box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage, chooseExampleArea } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const CEILING = 20000;
const ELEVATION_URL = 'elevation.nationalmap.gov';

/** Patches window.fetch so a request to the 3DEP elevation endpoint never
 *  auto-resolves: it is parked on window.__elevationRequests, and the test
 *  drives each one explicitly with .resolve(body)/.fail(status) -- both an
 *  ordinary "loading, then a value" flow and a genuinely late, out-of-order
 *  answer are reproducible on demand rather than raced against real timing.
 *  `aborted` records whether the caller's AbortController fired, but the
 *  promise itself is NOT rejected on abort -- resolving an "aborted" entry
 *  late is what lets a test prove the guard token, not abort timing, is what
 *  keeps a stale answer off a newer card. Every other request reaches the
 *  real fetch untouched. */
const patchElevationDeferred = `(() => {
  window.__elevationRequests = [];
  const real = window.fetch.bind(window);
  window.fetch = function(input, init) {
    const url = String(input && input.url ? input.url : input);
    if (url.indexOf(${JSON.stringify(ELEVATION_URL)}) !== -1) {
      const entry = { aborted: false };
      window.__elevationRequests.push(entry);
      if (init && init.signal) init.signal.addEventListener('abort', () => { entry.aborted = true; });
      return new Promise((resolve) => {
        entry.resolve = (body) => resolve(new Response(JSON.stringify(body), {
          status: 200, headers: { 'content-type': 'application/json' },
        }));
        entry.fail = (status) => resolve(new Response('', { status: status || 503 }));
      });
    }
    return real(input, init);
  };
})()`;

async function withDeferredElevation(fn, viewport = { width: 1280, height: 900 }, args = ['--hide-scrollbars']) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', { viewport, args });
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: patchElevationDeferred });
    await page.navigate(`${site.origin}/quiet-corners/`);
    return await fn(page);
  } finally { page.close(); await site.close(); }
}

// window.qcSelectName's own hit shape (terrain-names.js's normalizeFeature) --
// two real dedup groups from the Cold Mountain fixture other name-search
// tests already use, so the anchors are real published GNIS points.
const HAYWOOD = { id: 'gnis:1010378', name: 'Cold Mountain', kind: 'summit', county: 'Haywood', state: 'NC', anchor: [35.16620819921996, -82.98597189916538] };
const GAP = { id: 'gnis:1010379', name: 'Cold Mountain Gap', kind: 'gap', county: 'Jackson', state: 'NC', anchor: [35.15732488608985, -82.99653227535488] };
const selectHit = (hit) => `window.qcSelectName(${JSON.stringify(hit)}); void 0;`;

// Feet math run backward from a clean value: 1628.2416 m / 0.3048 = exactly
// 5342 ft, so the assertion below is never a rounding judgment call.
const elevationBody = (m) => ({ samples: [{ locationId: 0, value: String(m) }] });

test('QUX-06: opening a selected name\'s card fetches its elevation on demand, showing loading then a feet value', { skip }, async () => {
  await withDeferredElevation(async (page) => {
    await readyDashboard(page, { ms: 60000 });
    await page.evaluate(selectHit(HAYWOOD));
    await waitInPage(page, 'the selected name\'s card to open',
      `document.querySelector('.leaflet-popup-pane .qcm-site-card') !== null`, CEILING, null);

    const loading = await page.evaluate(`document.querySelector('.qcm-site-card-elevation').textContent`);
    assert.match(loading, /loading/, `expected a loading state before the mocked 3DEP response answers: ${loading}`);

    await waitInPage(page, 'the elevation request to be sent',
      'window.__elevationRequests.length === 1', CEILING, null);
    await page.evaluate(`window.__elevationRequests[0].resolve(${JSON.stringify(elevationBody(1628.2416))}); void 0;`);

    await waitInPage(page, 'the elevation line to report a feet value',
      `document.querySelector('.qcm-site-card-elevation').textContent.indexOf('5,342 ft') !== -1`, CEILING, null);
    const text = await page.evaluate(`document.querySelector('.qcm-site-card-elevation').textContent`);
    assert.match(text, /5,342 ft/, `expected the resolved elevation converted to feet: ${text}`);
    const caveat = await page.evaluate(`document.querySelector('.qcm-site-card-elevation-caveat').textContent`);
    assert.match(caveat, /USGS 3D Elevation Program/, `expected the source attribution to show once resolved: ${caveat}`);
  });
});

test('QUX-06: selecting a second name before the first elevation answers means the stale answer never reaches the new card', { skip }, async () => {
  await withDeferredElevation(async (page) => {
    await readyDashboard(page, { ms: 60000 });
    await page.evaluate(selectHit(HAYWOOD));
    await waitInPage(page, 'the first elevation request to be sent',
      'window.__elevationRequests.length === 1', CEILING, null);

    await page.evaluate(selectHit(GAP));
    await waitInPage(page, 'the second card to open, replacing the first',
      `document.querySelector('.leaflet-popup-pane .qcm-site-card') !== null
        && document.querySelector('.leaflet-popup-pane .qcm-site-card').textContent.indexOf('Cold Mountain Gap') !== -1`, CEILING, null);
    await waitInPage(page, 'the second elevation request to be sent',
      'window.__elevationRequests.length === 2', CEILING, null);

    const abortedFirst = await page.evaluate('window.__elevationRequests[0].aborted');
    assert.equal(abortedFirst, true, 'the first (stale) request must be aborted once a second name is selected');

    // The abort above fired, but this mock deliberately does not reject on
    // it (see patchElevationDeferred) -- resolving the first request now,
    // after a newer selection, is what actually exercises the guard as a
    // backstop independent of abort timing: a genuinely late answer that
    // still "completes" must be dropped on its own stale token.
    await page.evaluate(`window.__elevationRequests[0].resolve(${JSON.stringify(elevationBody(999))}); void 0;`); // would read 3,278 ft
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    const afterStaleResolve = await page.evaluate(`document.querySelector('.qcm-site-card-elevation').textContent`);
    assert.doesNotMatch(afterStaleResolve, /3,278 ft/, `the stale Haywood answer must never show on the Gap card: ${afterStaleResolve}`);
    assert.match(afterStaleResolve, /loading/, `the Gap card's own request has not answered yet, so it should still read loading: ${afterStaleResolve}`);

    await page.evaluate(`window.__elevationRequests[1].resolve(${JSON.stringify(elevationBody(500))}); void 0;`); // 1,640 ft
    await waitInPage(page, "the Gap card's own elevation to land",
      `document.querySelector('.qcm-site-card-elevation').textContent.indexOf('ft') !== -1
        && document.querySelector('.qcm-site-card-elevation').textContent.indexOf('loading') === -1`, CEILING, null);
    const finalText = await page.evaluate(`document.querySelector('.qcm-site-card-elevation').textContent`);
    assert.match(finalText, /1,640 ft/, `expected the Gap card's own (later) request to land: ${finalText}`);
  });
});

test('QUX-06: a NoData sample reads as "not available", a service failure reads as "unavailable"', { skip }, async () => {
  await withDeferredElevation(async (page) => {
    await readyDashboard(page, { ms: 60000 });
    await page.evaluate(selectHit(HAYWOOD));
    await waitInPage(page, 'the elevation request to be sent',
      'window.__elevationRequests.length === 1', CEILING, null);
    await page.evaluate(`window.__elevationRequests[0].resolve({ samples: [{ locationId: 0, value: 'NoData' }] }); void 0;`);
    await waitInPage(page, 'a NoData sample to read as unknown',
      `document.querySelector('.qcm-site-card-elevation').textContent.indexOf('elevation: unknown for this point') !== -1`, CEILING, null);

    await page.evaluate(selectHit(GAP));
    await waitInPage(page, 'the second elevation request to be sent',
      'window.__elevationRequests.length === 2', CEILING, null);
    await page.evaluate(`window.__elevationRequests[1].fail(503); void 0;`);
    await waitInPage(page, 'a service failure to read as unavailable',
      `document.querySelector('.qcm-site-card-elevation').textContent.indexOf('unavailable') !== -1`, CEILING, null);
  });
});

test('QUX-06: a Check-sources redraw keeps the open card\'s answered elevation, fetching it only once', { skip }, async () => {
  await withDeferredElevation(async (page) => {
    await readyDashboard(page, { ms: 60000 });
    await chooseExampleArea(page);
    await page.evaluate(selectHit(HAYWOOD));
    await waitInPage(page, 'the elevation request to be sent',
      'window.__elevationRequests.length === 1', CEILING, null);
    await page.evaluate(`window.__elevationRequests[0].resolve(${JSON.stringify(elevationBody(1628.2416))}); void 0;`);
    await waitInPage(page, 'the elevation line to report a feet value',
      `document.querySelector('.qcm-site-card-elevation').textContent.indexOf('5,342 ft') !== -1`, CEILING, null);

    // renderNames tears the whole overlay down and rebuilds it on every
    // sourcePass -- including the one #qcm-check's click drives -- so a
    // MutationObserver on the button's own `disabled` attribute is what
    // proves a full pass ran without guessing at timing: a record whose
    // oldValue is null is the attribute being added (enabled -> disabled,
    // the pass starting), and the pass has finished once the button reads
    // enabled again.
    await page.evaluate(`(() => {
      window.__checkPass = { started: false, finished: false };
      const btn = document.getElementById('qcm-check');
      const obs = new MutationObserver((records) => {
        for (const r of records) {
          if (r.attributeName !== 'disabled') continue;
          if (r.oldValue === null) window.__checkPass.started = true;
          else if (!btn.disabled) window.__checkPass.finished = true;
        }
      });
      obs.observe(btn, { attributes: true, attributeFilter: ['disabled'], attributeOldValue: true });
    })(); void 0;`);
    await page.evaluate("document.getElementById('qcm-check').click()");
    await waitInPage(page, 'the Check-sources pass to start',
      'window.__checkPass.started === true', CEILING, null);
    await waitInPage(page, 'the Check-sources pass to finish',
      'window.__checkPass.finished === true', CEILING, null);
    // The redraw that finishing the pass triggers is synchronous with it,
    // but this settle mirrors the other stale-answer proof above rather than
    // trusting that no further microtask could still queue a fetch.
    await new Promise((resolve) => { setTimeout(resolve, 200); });

    const requestCount = await page.evaluate('window.__elevationRequests.length');
    assert.equal(requestCount, 1,
      `expected the already-open card's elevation to be fetched once total, not refetched by the redraw: ${requestCount} requests`);
    const text = await page.evaluate(`document.querySelector('.qcm-site-card-elevation').textContent`);
    assert.match(text, /5,342 ft/, `expected the answered elevation to survive the redraw: ${text}`);
    assert.doesNotMatch(text, /loading/, `the card must not flicker back to loading on a redraw of the same point: ${text}`);
  });
});

// The redraw above landed AFTER the answer. The one that keeps failing PR CI
// lands DURING it: #734's run 37600249024 and #728's 37611351249 waited 20 s
// for `__elevationRequests.length === 1` and it never held, because a redraw
// the test never asked for (town labels or the bulk names answer arriving, a
// pan settling) tore the selected pin down and reopened its card while the
// first request was still open -- and the reopen aborted that request and
// sent a second one, so the count went 1 -> 2 between two polls. One point
// still loading is one request: a reopen of the same point joins the request
// already in flight instead of replacing it, and the answer lands on whichever
// card is open when it arrives.
test('QUX-06: a redraw while the elevation is still loading keeps the one request in flight and lands it on the redrawn card', { skip }, async () => {
  await withDeferredElevation(async (page) => {
    await readyDashboard(page, { ms: 60000 });
    await page.evaluate(selectHit(HAYWOOD));
    await waitInPage(page, 'the elevation request to be sent',
      'window.__elevationRequests.length === 1', CEILING, null);
    // Selecting the same name again is renderSources' own redraw path (the
    // Places list and the search box both take it): the overlay is torn down
    // and rebuilt, and the rebuilt pin reopens its card.
    await page.evaluate(selectHit(HAYWOOD));
    await waitInPage(page, 'the redrawn card to open',
      `document.querySelector('.leaflet-popup-pane .qcm-site-card') !== null
        && document.querySelector('.qcm-site-card-elevation').textContent.indexOf('loading') !== -1`, CEILING, null);
    await new Promise((resolve) => { setTimeout(resolve, 200); });

    const requestCount = await page.evaluate('window.__elevationRequests.length');
    assert.equal(requestCount, 1,
      `a redraw of the same point while its elevation loads must join the request in flight, not send another: ${requestCount} requests`);
    const abortedFirst = await page.evaluate('window.__elevationRequests[0].aborted');
    assert.equal(abortedFirst, false, 'the request in flight for the same point must not be aborted by its own redraw');

    await page.evaluate(`window.__elevationRequests[0].resolve(${JSON.stringify(elevationBody(1628.2416))}); void 0;`);
    await waitInPage(page, 'the one request\'s answer to land on the redrawn card',
      `document.querySelector('.qcm-site-card-elevation').textContent.indexOf('5,342 ft') !== -1`, CEILING, null);
  });
});

// Before the actions were docked to the popup's bottom edge, a person scrolled
// to reach them, and anything that appeared above them once the answer landed
// slid them down under a pointer already on its way. #653's PR CI run
// 36643574802 caught that: saved-places-browser.test.mjs read Save at y=428,
// the source caveat arrived above the actions, Save moved to y=562.5, and the
// press landed on the caveat. Docked, nothing above them moves them, and this
// test pins it.
test('QUX-06: the elevation answer landing never moves the card\'s actions', { skip }, async () => {
  await withDeferredElevation(async (page) => {
    await readyDashboard(page, { ms: 60000 });
    await page.evaluate(selectHit(HAYWOOD));
    await waitInPage(page, 'the elevation request to be sent',
      'window.__elevationRequests.length === 1', CEILING, null);
    await page.evaluate(`document.querySelector('.leaflet-popup-pane .qcm-site-card-actions').scrollIntoView({ block: 'nearest' }); void 0;`);
    const actionTops = `[...document.querySelectorAll('.leaflet-popup-pane .qcm-site-card-action')]
      .map((a) => a.getBoundingClientRect().top).join(', ')`;
    // Two polls 100 ms apart that read the same tops, so the answer is the
    // only thing that can move them from here. One card in the pane first: a
    // redraw that lands while the answer is loading reopens the card, and
    // Leaflet keeps the closing popup's DOM for its 200 ms fade, so two polls
    // inside that window read ten steady tops (local run, elev-green.log).
    await waitInPage(page, 'the open card to hold still',
      `(() => { if (document.querySelectorAll('.leaflet-popup-pane .qcm-site-card').length !== 1) return false;
        const now = ${actionTops}; const same = window.__actionTops === now; window.__actionTops = now; return same; })()`,
      CEILING, null);
    const before = await page.evaluate(actionTops);
    assert.equal(before.split(', ').length, 5, `expected the name card's five actions: ${before}`);

    await page.evaluate(`window.__elevationRequests[0].resolve(${JSON.stringify(elevationBody(1628.2416))}); void 0;`);
    await waitInPage(page, 'the source caveat to show',
      `document.querySelector('.qcm-site-card-elevation-caveat').hidden === false`, CEILING, null);
    const after = await page.evaluate(actionTops);
    assert.equal(after, before, 'the elevation answer moved the card\'s actions (tops before, then after)');
  });
});

// #656's review: the name card's caveat repeated the drawn-line wording
// (coverageSemantics: "Elevation gain is computed from points sampled along the
// drawn line ...") under a single point's elevation. A name card states a
// one-point value.
test('QUX-06: the name card\'s caveat states a one-point value, not a drawn line\'s gain', { skip }, async () => {
  await withDeferredElevation(async (page) => {
    await readyDashboard(page, { ms: 60000 });
    await page.evaluate(selectHit(HAYWOOD));
    await waitInPage(page, 'the elevation request to be sent',
      'window.__elevationRequests.length === 1', CEILING, null);
    await page.evaluate(`window.__elevationRequests[0].resolve(${JSON.stringify(elevationBody(1628.2416))}); void 0;`);
    await waitInPage(page, 'the source caveat to show',
      `document.querySelector('.qcm-site-card-elevation-caveat').hidden === false`, CEILING, null);
    const text = await page.evaluate(`document.querySelector('.qcm-site-card-elevation-caveat').textContent`);
    assert.match(text, /USGS 3D Elevation Program/, `expected the source attribution: ${text}`);
    assert.match(text, /interpolated between lidar returns/, `expected the one-point wording: ${text}`);
    assert.doesNotMatch(text, /drawn line|route|Elevation gain|planning figure/, `the drawn-line wording is on a single-point card: ${text}`);
  });
});

test('QQA-09: the elevation answer states its provenance: ground elevation, the named source, the vertical reference and resolution as the source states them', { skip }, async () => {
  await withDeferredElevation(async (page) => {
    await readyDashboard(page, { ms: 60000 });
    await page.evaluate(selectHit(HAYWOOD));
    await waitInPage(page, 'the elevation request to be sent', 'window.__elevationRequests.length === 1', CEILING, null);
    await page.evaluate(`window.__elevationRequests[0].resolve(${JSON.stringify(elevationBody(1628.2416))}); void 0;`);
    await waitInPage(page, 'the source caveat to show', `document.querySelector('.qcm-site-card-elevation-caveat').hidden === false`, CEILING, null);
    const text = await page.evaluate(`document.querySelector('.qcm-site-card-elevation-caveat').textContent`);
    assert.match(text, /^Ground elevation at this point\./, text);
    assert.match(text, /Source: USGS 3D Elevation Program \(3DEP\)\./, text);
    assert.match(text, /Vertical reference: not stated by source\./, `the datum is never guessed: ${text}`);
    assert.match(text, /Resolution: not stated by source\./, text);
  });
});

test('QQA-09: a real 0 m reads as 0 ft; no data reads as unknown and never as 0 ft', { skip }, async () => {
  await withDeferredElevation(async (page) => {
    await readyDashboard(page, { ms: 60000 });
    await page.evaluate(selectHit(HAYWOOD));
    await waitInPage(page, 'the elevation request to be sent', 'window.__elevationRequests.length === 1', CEILING, null);
    await page.evaluate(`window.__elevationRequests[0].resolve(${JSON.stringify(elevationBody(0))}); void 0;`);
    await waitInPage(page, 'zero to be a value', `document.querySelector('.qcm-site-card-elevation').textContent.indexOf('0 ft') !== -1`, CEILING, null);
    assert.doesNotMatch(await page.evaluate(`document.querySelector('.qcm-site-card-elevation').textContent`), /unknown|not available/);

    await page.evaluate(selectHit(GAP));
    await waitInPage(page, 'the second elevation request to be sent', 'window.__elevationRequests.length === 2', CEILING, null);
    await page.evaluate(`window.__elevationRequests[1].resolve({ samples: [{ locationId: 0, value: 'NoData' }] }); void 0;`);
    await waitInPage(page, 'no data to read as unknown', `document.querySelector('.qcm-site-card-elevation').textContent.indexOf('unknown') !== -1`, CEILING, null);
    assert.doesNotMatch(await page.evaluate(`document.querySelector('.qcm-site-card-elevation').textContent`), /\b0 ft/);
  });
});

// The name card is far taller than its popup (six field lines, the elevation
// line and five actions against its 230 px popup), and the actions used to
// sit at the end of it: a probe at both widths read all five below the popup's
// visible bottom at scrollTop 0, and the status line an action writes landed
// below them, out of view as well. Docked to the popup's bottom edge they are
// in view on open. Save is the one action whose label grows (Save place ->
// Saved — remove) and it writes a status line, so it is the press that would
// move a neighbor under a pointer on its way there. At the end of the scroll
// the dock sits in flow, so no line is left under it -- the elevation caveat
// included, which lands after the card opened: appended after the dock it
// lifted the dock off the popup's bottom edge, so an action scrolled into view
// could sit higher up the map, under its panels (before-you-go.test.mjs and
// saved-places-browser.test.mjs read "covered by #qc-conditions-summary" on a
// loaded full run, their cards' elevation unstubbed).
const cardGeometry = `(() => {
  const box = document.querySelector('.leaflet-popup-pane .leaflet-popup-content');
  const b = box.getBoundingClientRect();
  const rel = (el) => { const r = el.getBoundingClientRect();
    return { top: r.top - b.top, bottom: r.bottom - b.top, left: r.left - b.left, right: r.right - b.left, height: r.height }; };
  const inside = (r) => r.height > 0 && r.top >= -0.5 && r.bottom <= box.clientHeight + 0.5 && r.left >= -0.5 && r.right <= box.clientWidth + 0.5;
  const actions = [...box.querySelectorAll('.qcm-site-card-action')].map((a) => ({ label: a.textContent, ...rel(a) }));
  const status = box.querySelector('.qcm-site-card-status');
  const line = rel(box.querySelector('.qcm-site-card-elevation'));
  const dockEl = box.querySelector('.qcm-site-card-actions');
  const dock = rel(dockEl);
  const dockStyle = getComputedStyle(dockEl);
  const caveat = box.querySelector('.qcm-site-card-elevation-caveat');
  return {
    scrollTop: box.scrollTop, scrollable: box.scrollHeight > box.clientHeight + 1,
    clientHeight: box.clientHeight, scrollbar: box.offsetWidth - box.clientWidth,
    actions, out: actions.filter((r) => !inside(r)).map((r) => r.label),
    at: actions.map((r) => [r.top, r.left, r.right].join('/')).join(', '),
    heights: actions.map((r) => r.label + ' ' + r.height).join(', '),
    tallest: Math.max(...actions.map((r) => r.height)), shortest: Math.min(...actions.map((r) => r.height)),
    rows: new Set(actions.map((r) => Math.round(r.top))).size,
    // The status line is never hidden (spec-a11y-2, a live region), so "reported" is its text.
    status: status && status.textContent ? { text: status.textContent, inside: inside(rel(status)) } : null,
    // How far the buttons sit below the dock's own top padding: the room the status line takes.
    lead: rel(box.querySelector('.qcm-site-card-buttons')).top - dock.top
      - parseFloat(dockStyle.borderTopWidth) - parseFloat(dockStyle.paddingTop),
    lineInside: inside(line), lineClear: line.bottom <= dock.top + 0.5,
    nameClear: rel(box.querySelector('.qcm-site-card-name')).bottom <= dock.top + 0.5,
    dock: { top: dock.top, height: dock.height, position: dockStyle.position, background: dockStyle.backgroundColor,
      overflowX: dockEl.scrollWidth - dockEl.clientWidth },
    dockGap: box.clientHeight - dock.bottom,
    caveat: caveat && !caveat.hidden ? { bottom: rel(caveat).bottom, dockTop: dock.top } : null,
  };
})()`;
const pressSave = `document.querySelectorAll('.leaflet-popup-pane .qcm-site-card-action')[2].click(); void 0;`;
const scrollToEnd = `(() => { const box = document.querySelector('.leaflet-popup-pane .leaflet-popup-content');
  box.scrollTop = box.scrollHeight; })(); void 0;`;

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`QUX-11: the name card opens with its actions in view; Save's status, its longer label and the elevation caveat move none of them, and the caveat never lands under them (${viewport.width}x${viewport.height})`, { skip }, async () => {
    await withDeferredElevation(async (page) => {
      await readyDashboard(page, { ms: 60000 });
      await page.evaluate(selectHit(HAYWOOD));
      await waitInPage(page, 'the elevation request to be sent',
        'window.__elevationRequests.length === 1', CEILING, null);
      const opened = await page.evaluate(cardGeometry);
      assert.equal(opened.actions.length, 5, `expected the name card's five actions: ${opened.at}`);
      assert.equal(opened.scrollable, true, 'the card fits its popup now, so this proves nothing about the fold');
      assert.equal(opened.scrollTop, 0, 'the card opened already scrolled');
      assert.deepEqual(opened.out, [], `actions outside the popup's visible area on open: ${opened.out.join(', ')}`);
      assert.equal(opened.dock.position, 'sticky', 'the dock is not held to the popup\'s bottom edge');
      assert.match(opened.dock.background, /^rgb\(/, `the dock is see-through (${opened.dock.background}), so the lines scrolling under it show through`);
      assert.ok(opened.shortest >= 23.5, `an action is under the 24 px target size: ${opened.heights}`);
      assert.equal(opened.rows, 3, `expected the five actions in two columns, three rows: ${opened.at}`);
      assert.ok(Math.abs(opened.lead) <= 0.5, `the empty status line takes ${opened.lead} px of the dock before an action runs`);

      await page.evaluate(pressSave);
      await waitInPage(page, 'Save to report and relabel itself',
        `document.querySelector('.leaflet-popup-pane .qcm-site-card-status').textContent !== ''
          && document.querySelectorAll('.leaflet-popup-pane .qcm-site-card-action')[2].textContent === 'Saved — remove'`, CEILING, null);
      const saved = await page.evaluate(cardGeometry);
      assert.equal(saved.status && saved.status.text, 'Saved.', `expected Save's own status: ${JSON.stringify(saved.status)}`);
      assert.equal(saved.status.inside, true, 'the status line Save wrote is outside the popup\'s visible area');
      assert.equal(saved.at, opened.at, 'Save moved the card\'s actions (top/left/right of each, before then after)');

      await page.evaluate(scrollToEnd);
      const end = await page.evaluate(cardGeometry);
      assert.ok(end.scrollTop > 0, 'the popup did not scroll');
      assert.deepEqual(end.out, [], `actions outside the popup's visible area at the end of the scroll: ${end.out.join(', ')}`);
      assert.equal(end.lineInside, true, 'the elevation line is outside the popup\'s visible area at the end of the scroll');
      assert.equal(end.lineClear, true, 'the elevation line is under the dock at the end of the scroll');

      await page.evaluate(`window.__elevationRequests[0].resolve(${JSON.stringify(elevationBody(1628.2416))}); void 0;`);
      await waitInPage(page, 'the source caveat to show',
        `document.querySelector('.leaflet-popup-pane .qcm-site-card-elevation-caveat').hidden === false`, CEILING, null);
      const landed = await page.evaluate(cardGeometry);
      assert.equal(landed.at, end.at, 'the elevation answer moved the card\'s actions (top/left/right of each, before then after)');
      await page.evaluate(scrollToEnd);
      const last = await page.evaluate(cardGeometry);
      assert.ok(Math.abs(last.dockGap) <= 0.5, `the dock is ${last.dockGap} px off the popup's bottom edge at the end of the scroll, with the caveat shown`);
      assert.ok(last.caveat && last.caveat.bottom <= last.caveat.dockTop + 0.5,
        `the source caveat is under the dock at the end of the scroll: ${JSON.stringify(last.caveat)}`);
    }, viewport);
  });
}

// Every test above hides scrollbars (--hide-scrollbars), and with them the room
// a classic scrollbar takes out of the popup: 17 px on Windows, the widest, on
// any desktop that draws classic scrollbars. That leaves each of the dock's two
// columns 120 px, and Copy coordinates at 0.75rem in DejaVu Sans Mono (this
// box's monospace, 0.602 em an advance) needs 115.6 px against the 110 px its
// padding left it, so it wrapped and grew its row. A ::-webkit-scrollbar rule
// fixes the scrollbar at 17 px, so the proof does not depend on whether this
// browser draws overlay scrollbars. One width: CARD_POPUP sets the popup's width
// in px, the same at both, and a phone's scrollbars take no room.
const classicScrollbar = `(() => { const s = document.createElement('style');
  s.textContent = '.leaflet-popup-content::-webkit-scrollbar { width: 17px; }';
  document.head.append(s); })(); void 0;`;
test('QUX-11: beside a classic 17 px scrollbar every dock action keeps its label on one line', { skip }, async () => {
  await withDeferredElevation(async (page) => {
    await readyDashboard(page, { ms: 60000 });
    await page.evaluate(classicScrollbar);
    await page.evaluate(selectHit(HAYWOOD));
    await waitInPage(page, 'the elevation request to be sent',
      'window.__elevationRequests.length === 1', CEILING, null);
    const opened = await page.evaluate(cardGeometry);
    assert.equal(opened.scrollbar, 17, `the popup's scrollbar is ${opened.scrollbar} px, not 17, so this proves nothing about one`);
    assert.ok(opened.tallest <= 26, `an action's label wrapped beside the scrollbar: ${opened.heights}`);
    assert.equal(opened.rows, 3, `expected the five actions in two columns, three rows: ${opened.at}`);

    await page.evaluate(pressSave);
    await waitInPage(page, 'Save to relabel itself',
      `document.querySelectorAll('.leaflet-popup-pane .qcm-site-card-action')[2].textContent === 'Saved — remove'`, CEILING, null);
    const saved = await page.evaluate(cardGeometry);
    assert.ok(saved.tallest <= 26, `an action's label wrapped beside the scrollbar once Save relabelled itself: ${saved.heights}`);
  }, { width: 1280, height: 900 }, []);
});

// A reader who sets a larger default text size grows every rem in the card,
// while the stylesheet holds the popup itself at 230 px. Without a ceiling on the
// dock, a 32 px root let it take most of that height and cover the name the card
// is about, and its two fixed columns ran past the card's right edge. Beside a
// classic scrollbar two columns still would at 0.7rem, so one case draws one.
//
// The larger text re-lays the page out, the map's box with it, and the map
// re-measures a frame later; that redraws the selected name's pin and reopens its
// card, which sends the elevation request a second time. Selecting before then
// left two requests about one time in four, so "exactly one request" never came
// true. The name is selected once the map has caught up (qcMeasured), in the same
// page task as the font change, so nothing can run between the two by chance.
for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 1280, height: 900, scrollbar: true }]) {
  const beside = viewport.scrollbar ? ', beside a 17 px scrollbar' : '';
  test(`QUX-11: at twice the text size the dock leaves the card's name and a third of the popup clear, and no button runs past its right edge (${viewport.width}x${viewport.height}${beside})`, { skip }, async () => {
    await withDeferredElevation(async (page) => {
      await readyDashboard(page, { ms: 60000 });
      if (viewport.scrollbar) await page.evaluate(classicScrollbar);
      await page.evaluate(`(async () => {
        document.documentElement.style.fontSize = '32px';
        await qcMeasured('the map to re-measure its box at twice the text size');
        ${selectHit(HAYWOOD)}
        return true;
      })()`);
      await waitInPage(page, 'the elevation request to be sent',
        'window.__elevationRequests.length === 1', CEILING, null);
      await page.evaluate(pressSave);
      await waitInPage(page, 'Save to report',
        `document.querySelector('.leaflet-popup-pane .qcm-site-card-status').textContent !== ''`, CEILING, null);
      const g = await page.evaluate(cardGeometry);
      if (viewport.scrollbar) assert.equal(g.scrollbar, 17, `the popup's scrollbar is ${g.scrollbar} px, not 17, so this proves nothing about one`);
      assert.equal(g.scrollTop, 0, 'the card opened already scrolled');
      assert.ok(g.dock.top >= g.clientHeight / 3,
        `the dock covers ${g.clientHeight - g.dock.top} px of the popup's ${g.clientHeight}: ${JSON.stringify(g.dock)}`);
      assert.equal(g.nameClear, true, 'the dock covers the card\'s name');
      assert.ok(g.dock.overflowX <= 1, `the dock's buttons run ${g.dock.overflowX} px past its right edge: ${g.at}`);
    }, { width: viewport.width, height: viewport.height }, viewport.scrollbar ? [] : undefined);
  });
}
