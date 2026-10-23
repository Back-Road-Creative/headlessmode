// An open map card paints above whatever sits on the map with it, and never over the
// panels beside it.
//
// PR CI for #673 (both attempts) failed a trusted click on a name card's Save: the
// elevation lookup answered at once, the card's source note lengthened its scroll, and
// Save rose under the full-width Conditions bar. The cause was paint order, not geometry:
// every card painted inside the map pane's stacking context, below anything stacked on
// the map whatever the card's own z-index. #683 then docked the panels in a column
// beside the map on a desktop, so no bar is on the map any more; what still is, and
// painted over a card the same way, is Leaflet's own controls (z-index 1000 over the
// card pane's 700): the zoom and view buttons, the finder button, the map key. So on a
// desktop a card is proved against those, and against the docked panel it can no longer
// reach.
//
// Every proof below hit-tests with elementFromPoint and presses with trustedClick, so a
// card that only looks on top is a failure.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage, watchTimers, timersIdle } from './helpers/waits.mjs';
import { trustedClick } from './helpers/trusted-click.mjs';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { VIEWPORT_FETCH } from '../../themes/headlessmode/static/js/quiet-corners-maps/app-state.js';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const CEILING = 30000;
// The pause between the mouse moves of a drag: it is the drag's speed, so the card is still
// being carried when the button goes up and inertia takes over. A stimulus, not a wait.
const DRAG_STEP_MS = 16;
const ELEVATION_URL = 'elevation.nationalmap.gov';
const CATALOG_URL = SOURCES.caltransCctv.serviceUrl;
const CATALOG = JSON.parse(readFileSync(new URL('fixtures/caltrans-cctv-d05-2026-09-27.min.json', import.meta.url), 'utf8'));
// point-elevation-browser.test.mjs's Cold Mountain hit, a real published GNIS point.
const HAYWOOD = { id: 'gnis:1010378', name: 'Cold Mountain', kind: 'summit', county: 'Haywood', state: 'NC', anchor: [35.16620819921996, -82.98597189916538] };

// The elevation answers at once (1628.2416 m is exactly 5,342 ft), as it did in #673's
// CI repro. A camera still is a real 320x240 JPEG drawn in the page, so the camera card
// grows after Leaflet first measured it. The Caltrans catalogue is the committed fixture.
const stubSource = `(() => {
  const realFetch = window.fetch.bind(window);
  const still = () => { const c = new OffscreenCanvas(320, 240); const g = c.getContext('2d');
    g.fillStyle = '#4a7a5a'; g.fillRect(0, 0, 320, 240); return c.convertToBlob({ type: 'image/jpeg' }); };
  window.fetch = function (input, init) {
    const url = String(input && input.url ? input.url : input);
    if (url.indexOf(${JSON.stringify(ELEVATION_URL)}) !== -1) {
      return Promise.resolve(new Response(JSON.stringify({ samples: [{ locationId: 0, value: '1628.2416' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    if (url === ${JSON.stringify(CATALOG_URL)}) {
      return Promise.resolve(new Response(${JSON.stringify(JSON.stringify(CATALOG))}, { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    if (url.startsWith(${JSON.stringify(SOURCES.caltransCctv.origin)})) {
      return still().then((b) => new Response(b, { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    }
    return realFetch(input, init);
  };
})()`;

// Page-side geometry, installed after each navigation.
const HELPERS = `(() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
  const meet = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
  const area = (r) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
  const inside = (p, r) => p.x > r.left && p.x < r.right && p.y > r.top && p.y < r.bottom;
  const name = (el) => el ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/)[0] : '') : null;
  const viewport = () => ({ left: 0, top: 0, right: innerWidth, bottom: innerHeight });
  const wrapper = () => document.querySelector('.leaflet-popup-content-wrapper');
  // The map's own controls a reader can press: on screen, and not pointer-events: none.
  const controls = () => [...document.querySelectorAll('#qc-map .leaflet-control')].filter((c) =>
    c.getClientRects().length && getComputedStyle(c).pointerEvents !== 'none');
  window.__cop = {
    rect, meet, area, name,
    // A panBy delta that puts a corner of the card on the centre of one of targets, with
    // the whole card still inside the map's frame and the viewport.
    plan(targets) {
      const box = meet(rect(document.getElementById('qc-map')), viewport());
      const w = rect(wrapper()); const W = w.right - w.left, H = w.bottom - w.top;
      for (const t of targets) {
        const b = rect(t); const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
        for (const [left, top] of [[cx, cy], [cx - W, cy], [cx, cy - H], [cx - W, cy - H]]) {
          if (left >= box.left + 4 && top >= box.top + 4 && left + W <= box.right - 4 && top + H <= box.bottom - 4) {
            return { dx: Math.round(w.left - left), dy: Math.round(w.top - top), index: targets.indexOf(t), target: name(t) + ' ' + t.textContent.trim().slice(0, 40) };
          }
        }
      }
      return null;
    },
    controlPlan() { return this.plan(controls()); },
    // Every map control that overlaps the card, with a 4x4 grid of hit-tests over each
    // overlap and, for the one the card was panned onto, a point of it outside the card.
    overControls(index) {
      const w = meet(rect(wrapper()), viewport());
      return controls().map((s, k) => {
        const b = rect(s); const o = meet(w, b);
        if (area(o) <= 0) return null;
        const grid = [];
        for (let i = 1; i <= 4; i++) for (let j = 1; j <= 4; j++) {
          const x = o.left + (o.right - o.left) * i / 5, y = o.top + (o.bottom - o.top) * j / 5;
          const el = document.elementFromPoint(x, y);
          grid.push({ x: Math.round(x), y: Math.round(y), card: Boolean(el && el.closest('.leaflet-popup')), by: name(el) });
        }
        let outside = null;
        for (let i = 1; i <= 9 && !outside && k === index; i++) for (let j = 1; j <= 9 && !outside; j++) {
          const p = { x: b.left + (b.right - b.left) * i / 10, y: b.top + (b.bottom - b.top) * j / 10 };
          if (inside(p, w) || !inside(p, viewport())) continue;
          const el = document.elementFromPoint(p.x, p.y);
          outside = { x: Math.round(p.x), y: Math.round(p.y), reached: Boolean(el && s.contains(el)), by: name(el) };
        }
        return { control: name(s), target: k === index, grid, outside };
      }).filter(Boolean);
    },
    // Each of the card's own controls answers a hit-test at its centre as itself, once
    // scrolled into the card's own view.
    selfHits() {
      const pop = document.querySelector('.leaflet-popup');
      return [...pop.querySelectorAll('.leaflet-popup-close-button, .qcm-site-card-name, .qcm-site-card-action')].map((el) => {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        // The map scrolls its container back to 0,0 on its next scroll event; read the
        // card where it will be (helpers/trusted-click.mjs does the same).
        const map = document.getElementById('qc-map'); map.scrollTop = 0; map.scrollLeft = 0;
        const r = rect(el); const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
        const hit = document.elementFromPoint(x, y);
        return { el: name(el) + ' ' + el.textContent.trim().slice(0, 20), self: Boolean(hit && (hit === el || el.contains(hit))), by: name(hit) };
      });
    },
    // Where the card's tip ends, relative to its pin's container point.
    tip(anchor) {
      const t = rect(document.querySelector('.leaflet-popup-tip-container'));
      const m = rect(document.getElementById('qc-map'));
      const p = window.qcMap.latLngToContainerPoint(anchor);
      return { dx: (t.left + t.right) / 2 - (m.left + p.x), dy: t.bottom - (m.top + p.y),
        opacity: getComputedStyle(document.querySelector('.leaflet-popup')).opacity };
    },
  };
  window.__copMoves = 0; window.__copZooms = 0; window.__copOpens = 0;
  window.qcMap.on('moveend', () => { window.__copMoves += 1; });
  window.qcMap.on('popupopen', () => { window.__copOpens += 1; });
  window.qcMap.on('zoomend', () => { window.__copZooms += 1; });
})(); void 0;`;

let shared = null;
async function sharedSite() {
  if (!shared) shared = await startSiteServer();
  return shared;
}
after(async () => { if (shared) await shared.close(); });

// Each test closes its own browser, so a file of these never holds more than one of the
// box's browser slots.
async function dashboard(t, viewport, hash = '') {
  const site = await sharedSite();
  const page = await launch(CHROMIUM, 'about:blank', { viewport, args: ['--hide-scrollbars'] });
  t.after(() => page.close());
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: stubSource });
  // From the first script on, so the browse debounce a move arms is a timer `still` can see.
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: watchTimers(VIEWPORT_FETCH.settleMs) });
  await page.navigate(`${site.origin}/quiet-corners/${hash}`);
  await readyDashboard(page, { data: false, ms: CEILING });
  await page.evaluate('window.scrollTo(0, 0); void 0;');
  await page.evaluate(HELPERS);
  return page;
}

// `below`, when given, first pans the pin to that many px under the map's top edge.
async function openNameCard(page, below = null) {
  await page.evaluate(`window.qcMap.setView(${JSON.stringify(HAYWOOD.anchor)}, 13, { animate: false }); void 0;`);
  if (below !== null) {
    const moves = await page.evaluate('window.__copMoves');
    await page.evaluate(`(() => { const h = document.getElementById('qc-map').getBoundingClientRect().height;
      window.qcMap.panBy([0, Math.round(h / 2 - ${below})], { animate: false }); })(); void 0;`);
    await waitInPage(page, 'the pan to end', `window.__copMoves > ${moves}`, CEILING, null);
    await debounceFired(page);
  }
  await page.evaluate(`window.qcSelectName(${JSON.stringify(HAYWOOD)}); void 0;`);
  await waitInPage(page, 'the name card with its elevation',
    `(() => { const e = document.querySelector('.leaflet-popup-pane .qcm-site-card-elevation');
      return Boolean(e) && e.textContent.indexOf('5,342 ft') !== -1; })()`, CEILING, null);
  await still(page, 'the name card to hold still');
}

// A move is not over at its moveend: VIEWPORT_FETCH.settleMs later the viewport browse
// runs a source pass, whose renderSources redraws the names layer and re-opens the
// selected card, fading it in again (main.js renderNames). So wait for that debounce's
// timer to be gone (watchTimers, installed with the page), then two polls in a row that
// agree -- on the card's box and on how many times a card has opened -- with its
// fade-in finished.
const debounceFired = (page) => waitInPage(page, 'the viewport browse debounce to fire', timersIdle(VIEWPORT_FETCH.settleMs), CEILING, null);
const still = async (page, label) => {
  await debounceFired(page);
  return waitInPage(page, label,
    `(() => { const w = document.querySelector('.leaflet-popup-content-wrapper'); if (!w) return false;
      if (getComputedStyle(w.closest('.leaflet-popup')).opacity !== '1') return false;
      const r = w.getBoundingClientRect(); const now = [r.left, r.top, r.width, r.height, window.__copOpens].join(',');
      const same = window.__copStill === now; window.__copStill = now; return same; })()`, CEILING, null);
};

async function pan(page, dx, dy) {
  const moves = await page.evaluate('window.__copMoves');
  await page.evaluate(`window.qcMap.panBy([${dx}, ${dy}], { animate: false }); void 0;`);
  await waitInPage(page, 'the pan to end', `window.__copMoves > ${moves}`, CEILING, null);
  await still(page, 'the card to hold still after the pan');
}

async function panOntoControl(page) {
  const plan = await page.evaluate('window.__cop.controlPlan()');
  assert.ok(plan, 'setup: no pan puts this card on one of the map\'s controls inside the map frame');
  await pan(page, plan.dx, plan.dy);
  return plan;
}

function assertOverControls(over, plan) {
  // Setup: the card really does overlap the control it was panned onto. Without this
  // the test passes whenever the pin happens to land clear.
  const target = over.find((c) => c.target);
  assert.ok(target, `setup: the card overlaps no map control after panning onto ${plan.target}: ${JSON.stringify(over.map((c) => c.control))}`);
  for (const c of over) {
    const under = c.grid.filter((g) => !g.card);
    assert.equal(under.length, 0, `the card is under the map's ${c.control} at ${under.length} of ${c.grid.length} points: ${JSON.stringify(under.slice(0, 4))}`);
  }
  assert.ok(target.outside, `setup: no point of ${target.control} outside the card to check`);
  assert.equal(target.outside.reached, true, `${target.control} must stay reachable outside the card: ${JSON.stringify(target.outside)}`);
}

test('desktop: an open name card paints above the map\'s controls, and its own controls answer as themselves', { skip }, async (t) => {
  const page = await dashboard(t, { width: 1280, height: 900 });
  await openNameCard(page);
  const plan = await panOntoControl(page);
  assertOverControls(await page.evaluate(`window.__cop.overControls(${plan.index})`), plan);
  const self = await page.evaluate('window.__cop.selfHits()');
  assert.equal(self.length, 7, `expected the close button, the name and five actions: ${JSON.stringify(self)}`);
  const covered = self.filter((s) => !s.self);
  assert.equal(covered.length, 0, `covered card controls: ${JSON.stringify(covered)}`);
  await trustedClick(page, '.leaflet-popup .qcm-site-card-action:nth-child(3)');
  await waitInPage(page, 'Save to flip to Saved -- remove',
    "document.querySelectorAll('.leaflet-popup .qcm-site-card-action')[2].textContent === 'Saved \\u2014 remove'", CEILING, null);
});

test('desktop: the card\'s tip stays on its pin through a pan, an animated pan, a drag and a zoom', { skip }, async (t) => {
  const page = await dashboard(t, { width: 1280, height: 900 });
  // 400 px under the map's top edge, not the centre (337): from the centre the first pan
  // took the card's top 6 px past the edge, and a card placed again there rightly turns
  // below its pin. Here the card stays clear of the edge through every move.
  await openNameCard(page, 400);
  await still(page, 'the card to hold still');
  const anchor = JSON.stringify(HAYWOOD.anchor);
  const base = await page.evaluate(`window.__cop.tip(${anchor})`);
  assert.equal(base.opacity, '1', 'the card must be visible');
  const check = async (what) => {
    await still(page, `the card to hold still after ${what}`);
    const now = await page.evaluate(`window.__cop.tip(${anchor})`);
    assert.ok(Math.abs(now.dx - base.dx) <= 2 && Math.abs(now.dy - base.dy) <= 2,
      `after ${what} the tip is off its pin: ${JSON.stringify(now)} vs ${JSON.stringify(base)}`);
    assert.equal(now.opacity, '1', `the card must stay visible after ${what}`);
  };
  const moved = async (fn, what) => {
    const n = await page.evaluate('window.__copMoves');
    await fn();
    await waitInPage(page, `${what} to end`, `window.__copMoves > ${n}`, CEILING, null);
    await check(what);
  };
  await moved(() => page.evaluate('window.qcMap.panBy([60, 40], { animate: false }); void 0;'), 'a pan');
  await moved(() => page.evaluate('window.qcMap.panBy([-80, 30], { animate: true, duration: 0.3 }); void 0;'), 'an animated pan');
  // A real drag, pressed on bare map clear of the card, the bars and the controls, and
  // released while still moving so inertia carries on after it.
  const from = await page.evaluate(`(() => {
    const m = document.getElementById('qc-map').getBoundingClientRect();
    for (let i = 2; i < 18; i++) for (let j = 2; j < 18; j++) {
      const x = m.left + m.width * i / 20, y = m.top + Math.min(m.height, innerHeight - m.top) * j / 20;
      const el = document.elementFromPoint(x, y);
      if (el && el.closest('#qc-map') && !el.closest('.leaflet-popup, .leaflet-control, .leaflet-marker-icon, .qcm-panel, .leaflet-interactive')) return { x: Math.round(x), y: Math.round(y) };
    }
    return null; })()`);
  assert.ok(from, 'setup: no bare map to drag');
  await moved(async () => {
    const send = (type, x, y) => page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    await send('mousePressed', from.x, from.y);
    for (let k = 1; k <= 8; k++) {
      await send('mouseMoved', from.x + k * 12, from.y + k * 6);
      await page.evaluate(`new Promise((r) => setTimeout(r, ${DRAG_STEP_MS}))`);
    }
    await send('mouseReleased', from.x + 96, from.y + 48);
  }, 'a drag with inertia');
  // Through an animated zoom the card glides with the map, as it did inside the map
  // pane, rather than jumping to where the zoom will end while the tiles are still
  // scaling. Read halfway through the card's own transform transition, held there,
  // not by sampling frames: on a loaded box Chromium can paint a single frame in the
  // 0.25 s zoom, and frame sampling read that as a jump (this file in a targeted
  // lane at load 34-40, 2026-10-03, frames: [start] only).
  const glide = await page.evaluate(`new Promise((resolve) => {
    const tip = document.querySelector('.leaflet-popup-tip-container'), card = tip.closest('.leaflet-popup');
    const at = () => { const r = tip.getBoundingClientRect(); return [r.left, r.top]; };
    const start = at();
    let mid = null, running = [];
    window.qcMap.once('zoomanim', () => {
      getComputedStyle(card).transform;
      const all = card.getAnimations();
      running = all.map((a) => a.transitionProperty || a.animationName || '?');
      const move = all.find((a) => a.transitionProperty === 'transform');
      if (!move) return;
      move.pause();
      move.currentTime = move.effect.getComputedTiming().duration / 2;
      mid = at();
      move.play();
    });
    window.qcMap.once('zoomend', () => resolve({ start, mid, end: at(), running }));
    window.qcMap.zoomIn();
  })`);
  const far = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) > 2;
  assert.ok(Math.hypot(glide.end[0] - glide.start[0], glide.end[1] - glide.start[1]) > 10,
    `setup: the zoom must move the card's tip: ${JSON.stringify(glide)}`);
  assert.ok(glide.mid, `the card has no transform transition through the zoom, so it jumps to the zoom's end: ${JSON.stringify(glide)}`);
  assert.ok(far(glide.mid, glide.start) && far(glide.mid, glide.end),
    `halfway through the zoom the card is not between where it started and where it ends: ${JSON.stringify(glide)}`);
  await check('a zoom');
});

test('desktop: a card on a pin at the map\'s left edge is cut off there, and the open docked panel beside it still answers', { skip }, async (t) => {
  const page = await dashboard(t, { width: 1280, height: 900 });
  await trustedClick(page, '#qc-conditions-summary', { until: "document.getElementById('qc-conditions-panel').open" });
  await openNameCard(page);
  // The pin 40 px in from the map's left edge: a card is centred on its pin, so its box
  // now runs into the dock's column.
  const dx = await page.evaluate(`Math.round(window.qcMap.latLngToContainerPoint(${JSON.stringify(HAYWOOD.anchor)}).x - 40)`);
  await pan(page, dx, 0);
  const seen = await page.evaluate(`(() => {
    const c = window.__cop, w = c.rect(document.querySelector('.leaflet-popup-content-wrapper'));
    const m = c.rect(document.getElementById('qc-map')), p = c.rect(document.getElementById('qc-conditions-panel'));
    const o = c.meet(c.meet(w, p), { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
    const hits = [];
    if (c.area(o) > 0) for (let i = 1; i <= 3; i++) for (let j = 1; j <= 3; j++) {
      const el = document.elementFromPoint(o.left + (o.right - o.left) * i / 4, o.top + (o.bottom - o.top) * j / 4);
      hits.push({ panel: Boolean(el && el.closest('#qc-conditions-panel')), by: c.name(el) });
    }
    return { card: w, map: m, panel: p, hits };
  })()`);
  const r = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)])));
  // Setup: the card's box really does cross into the open panel beside the map.
  assert.ok(seen.card.left < seen.map.left - 20, `setup: the card does not run past the map's left edge: card ${r(seen.card)}, map ${r(seen.map)}`);
  assert.ok(seen.hits.length > 0, `setup: the card's box does not reach the open Conditions panel: card ${r(seen.card)}, panel ${r(seen.panel)}`);
  const lost = seen.hits.filter((h) => !h.panel);
  assert.equal(lost.length, 0, `the card paints over the open docked panel: ${JSON.stringify(lost)}`);
  await trustedClick(page, '#qc-conditions-panel .qcm-panel-close');
  await waitInPage(page, 'Close to shut the Conditions panel', "!document.getElementById('qc-conditions-panel').open", CEILING, null);
});

test('desktop: a camera card, once its still has loaded, paints above the map\'s controls', { skip }, async (t) => {
  const page = await dashboard(t, { width: 1280, height: 900 }, '#map=v1&z=13&c=36.687188,-121.653231');
  await page.evaluate("document.getElementById('qcm-layer-roadCameras').click(); void 0;");
  await waitInPage(page, 'a road camera pin', "Boolean(document.querySelector('.qcm-camera-pin--road'))", CEILING, null);
  await page.evaluate("document.querySelector('.qcm-camera-pin--road').click(); void 0;");
  await waitInPage(page, 'the camera card\'s still to load',
    "(() => { const img = document.querySelector('.leaflet-popup img'); return Boolean(img) && img.complete && img.naturalWidth === 320; })()", CEILING, null);
  await still(page, 'the camera card to hold still');
  const plan = await panOntoControl(page);
  assertOverControls(await page.evaluate(`window.__cop.overControls(${plan.index})`), plan);
  const covered = (await page.evaluate('window.__cop.selfHits()')).filter((s) => !s.self);
  assert.equal(covered.length, 0, `covered camera card controls: ${JSON.stringify(covered)}`);
});

// A card opens above its pin and nothing pans it into view (CARD_POPUP turns autoPan
// off), so on a pin near the map's top edge the frame (.qc-map-container, overflow: clip)
// cut its top off, close button and name included: 243 of a 256 px name card with the
// pin 60 px under the edge, 153 px at 150. Such a card opens below its pin instead.
async function assertOpensBelow(page, below) {
  const seen = await page.evaluate(`(() => {
    const c = window.__cop, frame = c.rect(document.querySelector('.qc-map-container'));
    const card = c.rect(document.querySelector('.leaflet-popup-content-wrapper'));
    const tip = c.rect(document.querySelector('.leaflet-popup-tip-container'));
    const square = c.rect(document.querySelector('.leaflet-popup-tip'));
    const m = c.rect(document.getElementById('qc-map')), p = window.qcMap.latLngToContainerPoint(${JSON.stringify(HAYWOOD.anchor)});
    return { frame, card, tip, square, pin: { x: m.left + p.x, y: m.top + p.y } };
  })()`);
  const r = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)])));
  assert.ok(Math.abs(seen.pin.y - seen.frame.top - below) <= 2, `setup: the pin is not ${below} px under the frame's top: pin ${r(seen.pin)}, frame ${r(seen.frame)}`);
  assert.ok(seen.card.top >= seen.frame.top && seen.card.bottom <= seen.frame.bottom,
    `the card runs past the map frame: card ${r(seen.card)}, frame ${r(seen.frame)}`);
  assert.ok(seen.card.top > seen.pin.y, `the card should open below its pin: card ${r(seen.card)}, pin ${r(seen.pin)}`);
  // The tip still points at the pin, now from the card's top edge: its 20 px box sits on
  // that edge around the pin, and the rotated square it clips to a triangle has its hidden
  // half down in the card, so the half that shows points up.
  assert.ok(Math.abs((seen.tip.left + seen.tip.right) / 2 - seen.pin.x) <= 2
    && seen.tip.top <= seen.pin.y && seen.pin.y <= seen.tip.bottom && Math.abs(seen.tip.bottom - seen.card.top) <= 2,
    `the tip is off its pin: tip ${r(seen.tip)}, card ${r(seen.card)}, pin ${r(seen.pin)}`);
  assert.ok((seen.square.top + seen.square.bottom) / 2 > (seen.tip.top + seen.tip.bottom) / 2,
    `the tip points down into the card, not up at its pin: square ${r(seen.square)}, tip ${r(seen.tip)}`);
  const covered = (await page.evaluate('window.__cop.selfHits()')).filter((s) => !s.self);
  assert.equal(covered.length, 0, `covered card controls: ${JSON.stringify(covered)}`);
}

for (const [label, viewport, below] of [['desktop', { width: 1280, height: 900 }, 60], ['desktop', { width: 1280, height: 900 }, 150], ['phone', { width: 390, height: 844 }, 60]]) {
  test(`${label}: a card on a pin ${below} px under the map's top edge opens whole, below its pin`, { skip }, async (t) => {
    const page = await dashboard(t, viewport);
    await openNameCard(page, below);
    await assertOpensBelow(page, below);
    await trustedClick(page, '.leaflet-popup .leaflet-popup-close-button');
    await waitInPage(page, 'the close button to shut the card', "!document.querySelector('.leaflet-popup')", CEILING, null);
  });
}

// A card's height can change after it opens (a camera still arriving, an elevation
// line), and Leaflet keeps a card's bottom where it was, so a card turned below its pin
// is placed again: here its content is cut to 150 px once open, the way any later change
// to what it shows would move its top edge.
test("desktop: a card turned below its pin is placed again when its height changes", { skip }, async (t) => {
  const page = await dashboard(t, { width: 1280, height: 900 });
  await openNameCard(page, 60);
  await page.evaluate(`(async () => { document.querySelector('.leaflet-popup-content').style.maxHeight = '150px';
    for (let i = 0; i < 3; i += 1) await new Promise((r) => requestAnimationFrame(r)); })()`);
  await assertOpensBelow(page, 60);
});

test('phone: the card stays inside the map and the sheet\'s bars still answer as themselves', { skip }, async (t) => {
  const page = await dashboard(t, { width: 390, height: 844 });
  await openNameCard(page);
  assert.equal(await page.evaluate("Boolean(document.querySelector('.leaflet-popup').closest('#qc-map'))"), true, 'the card should sit inside #qc-map');
  // The sheet sits at the stage's foot, below the first screen; bring it up first.
  await page.evaluate("document.getElementById('qc-sheet').scrollIntoView({ block: 'end' }); void 0;");
  await still(page, 'the card to hold still after the scroll');
  const { bars, seen } = await page.evaluate(`(() => {
    const all = [...document.querySelectorAll('#qc-sheet .qcm-panel > summary')];
    const bars = all.filter((s) => s.getClientRects().length).map((s) => {
      const r = s.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (y < 0 || y > innerHeight) return null;
      const hit = document.elementFromPoint(x, y);
      return { bar: s.textContent.trim().slice(0, 40), self: Boolean(hit && hit.closest('summary') === s), by: window.__cop.name(hit) };
    }).filter(Boolean);
    return { bars, seen: all.map((s) => Math.round(s.getBoundingClientRect().top)) };
  })()`);
  assert.ok(bars.length > 0, `setup: no sheet bar on screen (summary tops ${JSON.stringify(seen)})`);
  const lost = bars.filter((b) => !b.self);
  assert.equal(lost.length, 0, `sheet bars covered on a phone: ${JSON.stringify(lost)}`);
});

// Leaflet's controls (zoom, the view buttons, the finder) sit in corner boxes at z-index
// 1000, above the card pane (700). On a desktop the >=1024px block in quiet-corners.css
// orders them under the cards, but on a phone, where #qc-map stays a stacking context,
// they painted over a card: with the pin 300 px down, the reset-view button covered its name.
test('phone: a card that runs under the map\'s controls paints above them', { skip }, async (t) => {
  const page = await dashboard(t, { width: 390, height: 844 });
  await openNameCard(page, 300);
  const under = await page.evaluate(`(() => {
    const c = window.__cop, w = c.meet(c.rect(document.querySelector('.leaflet-popup-content-wrapper')), { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
    return [...document.querySelectorAll('#qc-map .leaflet-control')].map((el) => {
      const o = c.meet(w, c.rect(el));
      if (c.area(o) <= 0) return null;
      const hit = document.elementFromPoint((o.left + o.right) / 2, (o.top + o.bottom) / 2);
      return { control: c.name(el), card: Boolean(hit && hit.closest('.leaflet-popup')), by: c.name(hit) };
    }).filter(Boolean);
  })()`);
  // Setup: the card really does run under a control. Without this the test passes
  // whenever the card lands clear of them.
  assert.ok(under.length > 0, 'setup: the card overlaps none of the map\'s controls');
  const over = under.filter((u) => !u.card);
  assert.equal(over.length, 0, `map controls paint over the card on a phone: ${JSON.stringify(over)}`);
  const self = await page.evaluate('window.__cop.selfHits()');
  assert.equal(self.length, 7, `expected the close button, the name and five actions: ${JSON.stringify(self)}`);
  const covered = self.filter((s) => !s.self);
  assert.equal(covered.length, 0, `covered card controls on a phone: ${JSON.stringify(covered)}`);
  // Under the cards, but still above the map: with the card shut, every map control
  // answers as itself again.
  await trustedClick(page, '.leaflet-popup .leaflet-popup-close-button');
  await waitInPage(page, 'the close button to shut the card', "!document.querySelector('.leaflet-popup')", CEILING, null);
  const controls = await page.evaluate(`[...document.querySelectorAll('#qc-map .leaflet-control a, #qc-map .leaflet-control button')].map((el) => {
    const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (!r.width || !r.height || x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null;
    const hit = document.elementFromPoint(x, y);
    return { el: window.__cop.name(el), self: Boolean(hit && (hit === el || el.contains(hit))), by: window.__cop.name(hit) };
  }).filter(Boolean)`);
  assert.ok(controls.length >= 4, `setup: too few map controls on screen: ${JSON.stringify(controls)}`);
  const lost = controls.filter((c) => !c.self);
  assert.equal(lost.length, 0, `map controls no longer answer as themselves: ${JSON.stringify(lost)}`);
});
