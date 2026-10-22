// N2 keyboard/discoverability proof, on the real built Field Maps app
// (/quiet-corners/ -- the interactive dashboard; the documentation page at
// /quiet-corners/maps/ carries no map at all). Drives headless Chromium over
// the DevTools protocol the same way map-ready-lifecycle.test.mjs and
// site-card.test.mjs do: the GNIS geonames MapServer is answered from a
// sanitised, synthetic fixture (fixtures/gnis-names-declutter.mjs) patched
// into window.fetch before the page's own script runs, so no real network
// request ever leaves the box.
//
// Proves the brief's three keyboard/discoverability claims against the real
// implementation: a placed name marker is a genuine tab stop (identify()'s
// tabindex=0 DOM node), Enter opens its card (Leaflet popup bound by
// identify()), and a name the declutter cap left unlabelled still appears in
// the "Places in this view" list (renderNameList(), QUX-11a). Also
// proves the same card opens on a plain pointer click and a real touch tap,
// survives the redraw its own click triggers, and that a marker with a close
// neighbor still selects itself rather than the neighbor -- both by DOM
// identity and by a real screen coordinate (QUX-02, and its follow-up fixing
// the coordinate-hit-testing path itself).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { waitInPage, readyDashboard, chooseExampleArea } from './helpers/waits.mjs';
import { PLACE_FEATURES } from './fixtures/gnis-names-declutter.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const CEILING = 20000;

// fetchBounded (source-terrain-names.js) counts every one of layers 3/5/6/7
// first, then unconditionally pages each one -- so all eight requests need an
// answer, even the three empty layers, or the real network would be hit.
const COUNTS = { 3: PLACE_FEATURES.length, 5: 0, 6: 0, 7: 0 };
const PAGES = { 3: PLACE_FEATURES, 5: [], 6: [], 7: [] };

const patchSource = `(() => {
  const counts = ${JSON.stringify(COUNTS)};
  const pages = ${JSON.stringify(PAGES)};
  const real = window.fetch.bind(window);
  window.fetch = function(input, init) {
    const url = String(input && input.url ? input.url : input);
    // The NHD river tier is answered empty: these proofs are hermetic and about the GNIS names.
    if (/nhd\\/MapServer\\/\\d+\\/query/.test(url)) return Promise.resolve(new Response(JSON.stringify({ features: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const m = url.match(/geonames\\/MapServer\\/(\\d+)\\/query/);
    if (m) {
      const isCount = /returnCountOnly=true/.test(url);
      const body = isCount ? { count: counts[m[1]] ?? 0 } : { features: pages[m[1]] ?? [] };
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    }
    return real(input, init);
  };
})()`;

// Opens the layers panel (and its nested Advanced / "names not shown" <details>)
// but deliberately leaves #qcm-app -- the Field Maps print builder -- closed.
// #qcm-app is also a `.qcm-panel`, so at >=1024px (quiet-corners-maps.css) it is
// `position: absolute; left: 4rem`, floating ON the map rather than beside it --
// by design, the same as the layers panel on the opposite side. This fixture
// places its first markers at screen x 96-336, squarely inside that left:4rem
// panel's footprint, so opening it here made document.elementFromPoint (and a
// real touch/CDP-mouse tap) resolve into the panel's own <fieldset>, not the
// marker underneath it -- reproducible only with Tailwind actually built
// (tailwind.css missing collapses the two-column overlay layout entirely,
// which is why this passed locally and only failed in CI). None of the four
// tests below read anything from #qcm-app or need it open: #qcm-check lives
// inside it, but .click() dispatches directly to the element and does not
// hit-test, so it fires the same whether the panel is open or closed.
// Map panels open one at a time, so opening Explore or Conditions here would close
// Layers again: on master Layers came first in the page and won, and the dock put
// Explore above it. Skipping the other two panels keeps the same end state.
const openEveryPanel = "(() => { for (const d of document.querySelectorAll('details:not(#qcm-app):not(#qc-explore-panel):not(#qc-conditions-panel)')) d.open = true; })()";

// One site server and one Chromium process for the whole file (GATES.md §5):
// three tests would otherwise be three launches. The fetch patch is installed
// once, on the shared page, via addScriptToEvaluateOnNewDocument -- it survives
// every later navigate() the same way it would survive a real reload.
let shared = null;

async function sharedBrowser() {
  if (!shared) {
    const site = await startSiteServer();
    const page = await launch(CHROMIUM, 'about:blank', {
      viewport: { width: 1280, height: 900 }, args: ['--hide-scrollbars'],
    });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: patchSource });
    // hasTouch is what makes Input.dispatchTouchEvent below actually reach the page --
    // without it Chromium accepts the call but synthesizes no click at all. It has no
    // effect on the plain .click() calls the other two tests use.
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false, hasTouch: true,
    });
    shared = { site, page };
  }
  return shared;
}

after(async () => {
  if (!shared) return;
  shared.page.close();
  await shared.site.close();
});

/** Navigates to a fresh dashboard load, turns the names layer on and waits for at
 *  least one placed marker. Every test starts here so each one sees a clean,
 *  unselected map regardless of what an earlier test in this file clicked. */
async function readyNamesLayer() {
  const { site, page } = await sharedBrowser();
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: false, ms: CEILING });
  await page.evaluate(openEveryPanel);
  await chooseExampleArea(page);
  await page.evaluate(`(() => {
    const cb = document.getElementById('qcm-layer-names');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await page.evaluate("document.getElementById('qcm-check').click()");
  await waitInPage(page, 'name markers to render', "document.querySelectorAll('.qcm-name-marker').length > 0", CEILING, null);
  // Markers come from the names row's own per-view pass, so their presence no longer says the
  // Check pass has finished: wait for the button to come back, or a later Check click is a no-op.
  await waitInPage(page, 'the first Check-sources pass to finish', "!document.getElementById('qcm-check').disabled", CEILING, null);
  return page;
}

test('names layer: Tab reaches a placed marker, Enter opens its card, crowded-out names are listed', { skip }, async () => {
  const page = await readyNamesLayer();

  // Tab reaches a placed name marker: focusing it and checking it landed in
  // document.activeElement is the same "reaches" proof site-card.test.mjs
  // uses for an existing pin -- identify() gives every placed marker a real
  // tabindex=0 DOM node (via Leaflet's divIcon element), so it is a genuine
  // stop in the page's normal Tab order, not merely clickable.
  const markerInfo = await page.evaluate(`(() => {
    const el = document.querySelector('.qcm-name-marker');
    el.focus();
    return { focused: document.activeElement === el, tabIndex: el.tabIndex, role: el.getAttribute('role') };
  })()`);
  assert.ok(markerInfo.focused, 'a placed name marker should be a real, focusable tab stop');
  assert.equal(markerInfo.tabIndex, 0, 'the marker element should carry tabindex=0');
  assert.equal(markerInfo.role, 'button', 'the marker element should carry role=button (identify())');

  // Enter opens its details card (a Leaflet popup bound by identify()).
  await page.evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))");
  await waitInPage(page, 'the name card to open', "Boolean(document.querySelector('.qcm-site-card'))", CEILING, null);
  const cardText = await page.evaluate(`(() => {
    const c = document.querySelector('.qcm-site-card');
    return c ? c.textContent : null;
  })()`);
  assert.match(cardText ?? '', /Test Place \d\d/, `expected the opened card to name the marker's place, got: ${cardText}`);
  assert.match(cardText ?? '', /published primary point/, 'the card should carry the GNIS single-point honesty note');

  // "Places in this view" (QUX-11a) lists every fetched name in the current
  // bounds, so it shows at least one row not labelled on the map --
  // PLACE_FEATURES intentionally supplies more than the default density cap
  // (40) so this can never be zero.
  const suppressed = await page.evaluate("document.querySelectorAll('#qcm-names-list li').length");
  assert.ok(suppressed >= 1, `expected at least one suppressed name, got ${suppressed}`);
  const suppressedText = await page.evaluate("document.getElementById('qcm-names-list').textContent");
  assert.match(suppressedText, /Test Place \d\d/, `expected a suppressed <li> naming a Test Place, got: ${suppressedText}`);
});

test('names layer: Escape on an open card closes the card only -- the Layers panel stays open and focus returns to the marker', { skip }, async () => {
  const page = await readyNamesLayer();
  // readyNamesLayer() leaves the Layers panel open, which is how a reader
  // arrives here: turn Names on in Layers, Tab to a marker, Enter. Two Escape
  // handlers then see the same keydown -- identify()'s on the card
  // (preview-overlay.js) and QUX-03a's panel shell on the document
  // (quiet-corners.js wirePanels). One press must do one thing: dismiss the
  // card and hand the keyboard back to the pin, not also close the panel and
  // pull focus to its summary.
  await page.evaluate("document.querySelector('.qcm-name-marker').focus()");
  await page.evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))");
  await waitInPage(page, 'the name card to open', "Boolean(document.querySelector('.qcm-site-card'))", CEILING, null);
  await page.evaluate("document.querySelector('.qcm-site-card').focus()");
  await page.evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
  await waitInPage(page, 'the card to close', "!document.querySelector('.qcm-site-card')", CEILING, null);
  const after = await page.evaluate(`(() => ({
    layersOpen: document.getElementById('qcm-layer-panel').open,
    focusedMarker: document.activeElement && document.activeElement.classList.contains('qcm-name-marker'),
  }))()`);
  assert.equal(after.layersOpen, true, 'Escape on a card should dismiss the card, not also close the open Layers panel');
  assert.equal(after.focusedMarker, true, 'after Escape closes the card, focus should be back on the marker that opened it');
});

test('names layer: a pointer click on a placed marker opens its details card and survives a redraw', { skip }, async () => {
  const page = await readyNamesLayer();

  // A plain .click() is sufficient, matching every other proof in scripts/qcm/:
  // Leaflet's delegation is target-based (_findEventTargets, an ancestor-walk
  // against the map's _targets registry), not coordinate hit-testing, so
  // .click() and a real pointer event dispatch identically for this bug.
  await page.evaluate("document.querySelector('.qcm-name-marker').click()");
  await waitInPage(page, 'the name card to open on pointer click', "Boolean(document.querySelector('.qcm-site-card'))", CEILING, null);
  const selectedAfterClick = await page.evaluate("Boolean(document.querySelector('.qcm-name-label.is-selected'))");
  assert.ok(selectedAfterClick, 'clicking a marker should mark its label .is-selected');

  // Durability: re-trigger a redraw the same way the page's own "Check sources"
  // button does, and confirm the card is still open on the fresh marker rather
  // than on the removed layer the click itself just tore down. The pass removes
  // every marker at once (resetSources) and the removed marker's popup stays in
  // the DOM through Leaflet's fade-out (~400ms measured), so a read straight
  // after the click finds that leftover, and passes or fails on runner speed.
  // Mark the markers, then wait until the pass has replaced every one of them. A
  // viewport pass (the popup's auto-pan can queue one) also replaces every marker,
  // so the wait also needs to have seen the button go disabled: only the Check
  // pass does that, for its whole run.
  await page.evaluate(`(() => {
    for (const m of document.querySelectorAll('.qcm-name-marker')) m.dataset.beforeRedraw = '1';
    const btn = document.getElementById('qcm-check');
    window.qcmCheckPassRan = false;
    new MutationObserver((records) => {
      if (records.some((r) => r.oldValue === null)) window.qcmCheckPassRan = true;
    }).observe(btn, { attributes: true, attributeFilter: ['disabled'], attributeOldValue: true });
    btn.click();
  })()`);
  await waitInPage(page, 'the Check-sources pass to run and redraw every name marker',
    "window.qcmCheckPassRan && !document.getElementById('qcm-check').disabled && document.querySelectorAll('.qcm-name-marker').length > 0 && !document.querySelector('.qcm-name-marker[data-before-redraw]')",
    CEILING, null);
  // Count live cards only: Leaflet 1.9 fades a removed popup to opacity 0 and
  // drops it from the DOM 200 ms later, and a later pass can still leave one fading.
  const afterRedraw = await page.evaluate(`(() => {
    const live = [...document.querySelectorAll('.qcm-site-card')]
      .filter((c) => c.closest('.leaflet-popup')?.style.opacity !== '0');
    const open = document.querySelector('.qcm-name-marker[aria-expanded="true"]');
    return {
      cards: live.length,
      cardText: live[0]?.textContent ?? null,
      openName: open ? open.getAttribute('aria-label') : null,
      openSelected: Boolean(open && open.querySelector('.qcm-name-label.is-selected')),
    };
  })()`);
  assert.equal(afterRedraw.cards, 1, 'the details card should survive a redraw while its name is still selected');
  assert.ok(afterRedraw.openName, 'the card should belong to a marker the redraw placed, not the one it removed');
  assert.ok(afterRedraw.openSelected, 'the marker whose card is open should be the selected name');
  assert.ok((afterRedraw.cardText ?? '').includes(afterRedraw.openName),
    `the open card should name its own marker ("${afterRedraw.openName}"), got: ${afterRedraw.cardText}`);

  // Hit-region check (Q/main.js ~:1566): each marker's DOM/hit region is a
  // 240x240 box (`box = 240`) even though its own drawn glyph is only 12px
  // across (SIZE_SCALE.normal, name-labels.js:18/40) -- a ~400x mismatch
  // between what collision-avoidance reserves and what is actually clickable.
  // Measure whether this fixture actually places two markers close enough for
  // that mismatch to matter, rather than assuming it.
  const minGap = await page.evaluate(`(() => {
    const r = Array.from(document.querySelectorAll('.qcm-name-marker')).map(e => e.getBoundingClientRect());
    let min = Infinity;
    for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
      min = Math.min(min, Math.hypot(r[i].x - r[j].x, r[i].y - r[j].y));
    }
    return min;
  })()`);
  if (minGap < 240) {
    // A pair of placed markers really does land inside each other's oversized
    // hit box in this fixture -- proof the mismatch above is real, not just
    // arithmetic. Click the closer of that pair by its own DOM identity (a
    // target-based dispatch, same as every other proof in this file) and
    // confirm it selects its OWN name, never the neighbor's. The coordinate-
    // hit-testing path (a real click landing on a neighbor's box because it is
    // still transparent and 240x240) is covered separately, below, by the
    // elementFromPoint/CDP-mouse test -- QUX-02 follow-up fixes that path too.
    const clicked = await page.evaluate(`(() => {
      const markers = Array.from(document.querySelectorAll('.qcm-name-marker'));
      const rects = markers.map((e) => e.getBoundingClientRect());
      let best = 0, bestGap = Infinity, neighbor = 0;
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const gap = Math.hypot(rects[i].x - rects[j].x, rects[i].y - rects[j].y);
        if (gap < bestGap) { bestGap = gap; best = i; neighbor = j; }
      }
      // The card opened by the first click above is still open here, on the SAME
      // Leaflet marker (the selected name's marker is kept across the redraw). A
      // click on a popup's own source marker is a toggle in Leaflet 1.9
      // (Layer._openPopup: source === target and the popup is on the map ->
      // closePopup()), so clicking that marker would close its card and no card
      // would be open. Of the closest pair, click the one whose card is NOT open
      // and name the other the neighbour; which of the two is open depends on
      // placement order, which is why this was intermittent.
      if (markers[best].getAttribute('aria-expanded') === 'true') [best, neighbor] = [neighbor, best];
      const name = markers[best].getAttribute('aria-label');
      const neighborName = markers[neighbor].getAttribute('aria-label');
      markers[best].click();
      return { name, neighborName, gap: bestGap };
    })()`);
    await waitInPage(page, `the card for "${clicked.name}" (the closest-neighbor marker) to open`,
      // A live card whose text names the clicked marker: a fading leftover card
      // (opacity 0, still in the DOM ~200 ms) must not satisfy this wait.
      `[...document.querySelectorAll('.qcm-site-card')].some((c) => c.closest('.leaflet-popup')?.style.opacity !== '0' && c.textContent.includes(${JSON.stringify(clicked.name)}))`,
      CEILING, null);
    const selection = await page.evaluate(`(() => {
      const byLabel = (name) => {
        const marker = Array.from(document.querySelectorAll('.qcm-name-marker'))
          .find((m) => m.getAttribute('aria-label') === name);
        const label = marker ? marker.querySelector('.qcm-name-label') : null;
        return label ? label.classList.contains('is-selected') : false;
      };
      return { clicked: byLabel(${JSON.stringify(clicked.name)}), neighbor: byLabel(${JSON.stringify(clicked.neighborName)}) };
    })()`);
    assert.ok(selection.clicked,
      `clicking "${clicked.name}" (only ${Math.round(clicked.gap)}px from "${clicked.neighborName}", inside `
      + 'the shared 240px hit box) should select its own label');
    assert.ok(!selection.neighbor,
      `clicking "${clicked.name}" should not also select its neighbor "${clicked.neighborName}"`);
  }
  // If no pair lands under 240px in this fixture, the mismatch stands proven only
  // by the numbers above; building a fixture that forces one is a follow-up, not
  // a blocker for this small unit.
});

test('names layer: touch on a placed marker opens its details card', { skip }, async () => {
  const page = await readyNamesLayer();

  // No dispatch helper exists anywhere in the repo for touch input, so this drives
  // real CDP touch input inline rather than adding a new helper file. Leaflet's map
  // pane is larger than the visible container (buffer for panning), so not every
  // placed marker's rect is actually inside the viewport -- pick one that is, the
  // same way a real finger only ever lands on what it can see.
  const rect = await page.evaluate(`(() => {
    const markers = Array.from(document.querySelectorAll('.qcm-name-marker'));
    const r = markers.map((e) => e.getBoundingClientRect())
      .find((r) => r.x >= 0 && r.y >= 0 && r.x + r.width <= innerWidth && r.y + r.height <= innerHeight);
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rect.x, y: rect.y, id: 1 }] });
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await waitInPage(page, 'the name card to open on touch', "Boolean(document.querySelector('.qcm-site-card'))", CEILING, null);
});

test('names layer: a coordinate click at a marker\'s own centre selects that marker, not a close neighbor', { skip }, async () => {
  const page = await readyNamesLayer();

  // Each marker's own glyph/anchor sits at the centre of its (still 240x240,
  // even after the CSS fix) DOM box -- iconAnchor: [half, half] in main.js.
  // Find the closest on-screen pair (same "is this fixture's overlap real"
  // question as the hit-region check above, but restricted to markers a real
  // pointer could actually reach, the way map-ready buffer tiles cannot be).
  const pair = await page.evaluate(`(() => {
    const onScreen = Array.from(document.querySelectorAll('.qcm-name-marker'))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.x >= 0 && r.y >= 0 && r.x + r.width <= innerWidth && r.y + r.height <= innerHeight);
    let best = null, bestGap = Infinity;
    for (let i = 0; i < onScreen.length; i++) for (let j = i + 1; j < onScreen.length; j++) {
      const a = onScreen[i].r, b = onScreen[j].r;
      const gap = Math.hypot((a.x + a.width / 2) - (b.x + b.width / 2), (a.y + a.height / 2) - (b.y + b.height / 2));
      if (gap < bestGap) { bestGap = gap; best = [onScreen[i], onScreen[j]]; }
    }
    if (!best) return null;
    const centre = (o) => ({ x: o.r.x + o.r.width / 2, y: o.r.y + o.r.height / 2, name: o.el.getAttribute('aria-label') });
    return { a: centre(best[0]), b: centre(best[1]), gap: bestGap };
  })()`);
  assert.ok(pair, 'this fixture should place at least two on-screen name markers to test a coordinate click against');
  assert.ok(pair.gap < 240,
    `expected an on-screen pair closer than the 240px hit box (got ${Math.round(pair.gap)}px) -- `
    + 'without one this test cannot exercise the misrouted-click bug');

  // document.elementFromPoint at each marker's own centre must resolve inside
  // THAT marker's own .qcm-name-marker box, never the neighbor's -- this is
  // the real-browser hit-testing question the old oversized transparent box
  // (background: none, no pointer-events override) got wrong for any point
  // within ~120px of a neighbor's anchor.
  const resolved = await page.evaluate(`(() => {
    const ownerNameAt = (x, y) => {
      const el = document.elementFromPoint(x, y);
      const owner = el ? el.closest('.qcm-name-marker') : null;
      return owner ? owner.getAttribute('aria-label') : null;
    };
    return {
      atA: ownerNameAt(${pair.a.x}, ${pair.a.y}),
      atB: ownerNameAt(${pair.b.x}, ${pair.b.y}),
    };
  })()`);
  assert.equal(resolved.atA, pair.a.name,
    `elementFromPoint at "${pair.a.name}"'s own centre (${Math.round(pair.gap)}px from "${pair.b.name}") `
    + `should resolve inside its own marker, got "${resolved.atA}"`);
  assert.equal(resolved.atB, pair.b.name,
    `elementFromPoint at "${pair.b.name}"'s own centre should resolve inside its own marker, got "${resolved.atB}"`);

  // A real CDP mouse click (not .click()) at marker A's own coordinates must
  // select marker A, never neighbor B, even though B's oversized box used to
  // cover this exact point too.
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pair.a.x, y: pair.a.y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pair.a.x, y: pair.a.y, button: 'left', clickCount: 1 });
  await waitInPage(page, `the card for "${pair.a.name}" to open on a coordinate click`,
    "Boolean(document.querySelector('.qcm-site-card'))", CEILING, null);
  const selection = await page.evaluate(`(() => {
    const isSelected = (name) => {
      const marker = Array.from(document.querySelectorAll('.qcm-name-marker'))
        .find((m) => m.getAttribute('aria-label') === name);
      const label = marker ? marker.querySelector('.qcm-name-label') : null;
      return label ? label.classList.contains('is-selected') : false;
    };
    return { a: isSelected(${JSON.stringify(pair.a.name)}), b: isSelected(${JSON.stringify(pair.b.name)}) };
  })()`);
  assert.ok(selection.a, `a coordinate click at "${pair.a.name}"'s own centre should select "${pair.a.name}"`);
  assert.ok(!selection.b,
    `a coordinate click at "${pair.a.name}"'s own centre should not select its neighbor "${pair.b.name}"`);
});
