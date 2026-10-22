// QQA-08 slice 1: a finger can ask what a forest road or trail is, and the same answer is
// one choice away from the keyboard. Proved in the real built page, on an emulated phone
// (390 x 844, touch events, not mouse clicks), measuring what is rendered:
//   - a tap 9 px off a trail line (outside a mouse's 6 px, inside a finger's 12) opens the
//     identification card -- name, kind, the source's own credit -- not a hover tooltip;
//   - a tap where two trails cross opens a chooser, not a silent pick, and choosing opens
//     that trail's card; a tap on bare ground opens nothing;
//   - the SAME card (same data-route-id, same title) opens from a mouse click, from a tap
//     and from "Places in this view" with the keyboard (Enter on the row);
//   - the roads lettered on the map are rows in that list and open a card of their own,
//     while the lettering stays out of the pointer's and the keyboard's way (no label is
//     clickable, so there is no label-click path to prove: that is asserted, not assumed).
// The Forest Service, National Map trail and road-name services are answered from the
// shared 3D fixtures (fixtures/relief-3d.mjs: Standing Indian / Forest Road 67 in Macon
// County NC, in the app's example area; public landmarks, nowhere near anyone's home) by
// a fetch patch in the page; the browser is offline (OFFLINE_ARGS), so nothing leaves the box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage, chooseExampleArea } from './helpers/waits.mjs';
import { TRAILS, MVUM_ROAD, trailsQueryResponse, mvumQueryResponse } from './fixtures/relief-3d.mjs';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { TRAILS_SOURCE } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-trails.js';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const CEILING = 60000;
const AT = TRAILS[0], RIDGE = TRAILS[1];
const VIEW = [35.04, -83.505, 13];
// A local connecting road (layer 31, lettered from zoom 12) running east-west across the lower half of the view, clear of the map controls the lettering avoids.
const WAYAH = { attributes: { name: 'Wayah Road', interstate: null, us_route: null, state_route: null, county_route: null, federal_lands_route: null, stco_fipscode: '37113', permanent_identifier: 'fx-wayah' },
  geometry: { paths: [[[-83.52, 35.034], [-83.51, 35.0345], [-83.5, 35.034], [-83.49, 35.0335]]] } };

const PATCH_SOURCE = `(() => {
  const trails = ${JSON.stringify(trailsQueryResponse())};
  const mvum = { 1: ${JSON.stringify(mvumQueryResponse('MapServer/1/query'))}, 2: ${JSON.stringify(mvumQueryResponse('MapServer/2/query'))},
    c1: ${JSON.stringify(mvumQueryResponse('MapServer/1/query?returnCountOnly=true'))}, c2: ${JSON.stringify(mvumQueryResponse('MapServer/2/query?returnCountOnly=true'))} };
  const wayah = ${JSON.stringify(WAYAH)};
  const real = window.fetch.bind(window);
  const json = (body) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  window.fetch = function (input, init) {
    const url = String(input && input.url ? input.url : input);
    const count = /returnCountOnly=true/.test(url);
    let m;
    if (/MapServer\\/37\\/query/.test(url)) return json(trails);
    if ((m = /EDW_MVUM_02\\/MapServer\\/(\\d+)\\/query/.exec(url))) return json(mvum[(count ? 'c' : '') + m[1]] || { features: [] });
    if ((m = /transportation\\/MapServer\\/(\\d+)\\/query/.exec(url))) return json({ features: m[1] === '31' ? [wayah] : [] });
    if (/^https:\\/\\//.test(url) && !url.startsWith(location.origin)) return json(count ? { count: 0 } : { features: [] });
    return real(input, init);
  };
})()`;

const tick = (id) => `(() => { const cb = document.getElementById('${id}'); cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); })()`;

/** Page coordinates of a [lon, lat] point as the map shows it now. */
const at = (page, lon, lat) => page.evaluate(`(() => {
  const r = document.getElementById('qc-map').getBoundingClientRect(), p = window.qcMap.latLngToContainerPoint([${lat}, ${lon}]);
  return { x: r.left + p.x, y: r.top + p.y, w: window.innerWidth, h: window.innerHeight };
})()`);
const touchTap = async (page, { x, y }) => {
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
const mouseClick = async (page, { x, y }) => {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};
// 'keyDown' with `text` is a real keypress: Enter on a button is a click only then.
const key = async (page, k, code, vk, text) => {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
};
const CARD = `(() => { const c = document.querySelector('.leaflet-popup .qcm-site-card'); return c && {
  id: c.dataset.routeId, title: c.querySelector('.qcm-site-card-name')?.textContent, text: c.textContent,
  inside: c.contains(document.activeElement) || document.activeElement === c }; })()`;
const CHOOSER = `(() => { const c = document.querySelector('.leaflet-popup .qcm-route-chooser'); return c && {
  text: c.textContent, choices: [...c.querySelectorAll('button.qcm-route-choice')].map((b) => ({ id: b.dataset.routeId, text: b.textContent })) }; })()`;
const nothingOpen = `!document.querySelector('.leaflet-popup .qcm-site-card') && !document.querySelector('.leaflet-popup .qcm-route-chooser')`;
// Leaflet fades a shut popup out and keeps its element for that moment, so wait for it to be
// gone before the next step looks for the card it opens.
const closeCard = async (page) => {
  await page.evaluate('window.qcMap.closePopup(), true');
  await waitInPage(page, 'the shut card to leave the page', `!document.querySelector('.leaflet-popup')`, CEILING, null);
};
const waitCard = (page, what) => waitInPage(page, what, `Boolean(document.querySelector('.leaflet-popup .qcm-site-card'))`, CEILING, null);

/** First point where two [lon, lat] polylines cross. */
function crossing(a, b) {
  for (let i = 1; i < a.length; i += 1) for (let j = 1; j < b.length; j += 1) {
    const [p, r] = [a[i - 1], [a[i][0] - a[i - 1][0], a[i][1] - a[i - 1][1]]], [q, s] = [b[j - 1], [b[j][0] - b[j - 1][0], b[j][1] - b[j - 1][1]]];
    const d = r[0] * s[1] - r[1] * s[0];
    if (!d) continue;
    const t = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / d, u = ((q[0] - p[0]) * r[1] - (q[1] - p[1]) * r[0]) / d;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return [p[0] + t * r[0], p[1] + t * r[1]];
  }
  return null;
}

test('a tap, a click and a keyboard choice from Places in this view open the same card for the same road or trail', { skip }, async () => {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', { viewport: { width: 390, height: 844, mobile: true }, args: ['--hide-scrollbars'], timeoutMs: CEILING });
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
    await waitInPage(page, 'the lettering of Wayah Road', `[...document.querySelectorAll('.qcm-road-label')].some((e) => e.textContent === 'Wayah Road')`, CEILING, null);

    const ridgeVertex = RIDGE.paths[0][4];                        // a trail point nowhere near another line
    const ridge = await at(page, ridgeVertex[0], ridgeVertex[1]);
    assert.ok(ridge.x > 20 && ridge.x < ridge.w - 40 && ridge.y > 20 && ridge.y < ridge.h - 20, `the trail point is on screen: ${JSON.stringify(ridge)}`);

    // 1. A mouse click right on the line opens the card (the baseline every other entry must equal).
    await mouseClick(page, ridge);
    await waitCard(page, 'a card after a mouse click on Lower Ridge Trail');
    const clicked = await page.evaluate(CARD);
    assert.equal(clicked.title, 'Lower Ridge Trail');
    assert.equal(clicked.id, 'road:trail:fx-lower-ridge');
    await closeCard(page);

    // 2. A finger: touch events, 9 px off the line. A mouse would miss at 6; a finger must not.
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await touchTap(page, { x: ridge.x + 9, y: ridge.y });
    await waitCard(page, 'a card after a touch tap 9 px off Lower Ridge Trail');
    const tapped = await page.evaluate(CARD);
    assert.equal(tapped.id, clicked.id, 'the tap opens the same feature the click did');
    assert.equal(tapped.title, clicked.title);
    assert.match(tapped.text, /Trail/, 'the card says what kind of thing it is');
    assert.ok(tapped.text.includes(`Source: ${TRAILS_SOURCE.attribution}`), `the card credits its source: ${tapped.text}`);
    assert.ok(tapped.inside, 'the keyboard is inside the card once it opens');
    await closeCard(page);

    // 4. Two trails cross under one fingertip: a chooser, never a silent pick.
    const [cx, cy] = crossing(AT.paths[0], RIDGE.paths[0]);
    await touchTap(page, await at(page, cx, cy));
    await waitInPage(page, 'a chooser at the crossing', `Boolean(document.querySelector('.leaflet-popup .qcm-route-chooser'))`, CEILING, null);
    const chooser = await page.evaluate(CHOOSER);
    assert.deepEqual(chooser.choices.map((c) => c.id).sort(), ['road:trail:fx-at-standing-indian', 'road:trail:fx-lower-ridge']);
    assert.ok(chooser.choices.some((c) => /Appalachian Trail/.test(c.text)) && chooser.choices.some((c) => /Lower Ridge Trail/.test(c.text)), JSON.stringify(chooser));
    assert.equal(await page.evaluate(`Boolean(document.querySelector('.leaflet-popup .qcm-site-card'))`), false, 'no card was picked for the reader');
    await page.evaluate(`document.querySelector('.qcm-route-choice[data-route-id="road:trail:fx-at-standing-indian"]').click()`);
    await waitCard(page, 'the card for the chosen trail');
    const chosen = await page.evaluate(CARD);
    assert.equal(chosen.title, 'Appalachian Trail');
    assert.match(chosen.text, /NST - Appalachian/, 'the trail class the data has is on the card');
    await closeCard(page);

    // 5. A forest road: kind, what the inventory said, and its own credit.
    const roadVertex = MVUM_ROAD.paths[0][8];
    const road = await at(page, roadVertex[0], roadVertex[1]);
    await touchTap(page, { x: road.x - 8, y: road.y });
    await waitCard(page, 'a card after a tap beside Forest Road 67');
    const forest = await page.evaluate(CARD);
    assert.equal(forest.id, 'road:mvum-road:fx-fr-67');
    assert.equal(forest.title, 'Forest Road 67');
    assert.match(forest.text, /Forest road/);
    assert.ok(forest.text.includes(`Source: ${SOURCES.usfsMvum.attribution}`), forest.text);
    await closeCard(page);

    // 6. Places in this view: the same road and trails, chosen with the keyboard.
    // The Forest Road 67 card panned the map to itself, by however far its height asks for, and
    // the list holds what is in view; put the fixture view back first, as viaKeyboard does below,
    // so which rows are listed does not depend on how tall the last card was.
    await page.evaluate(`window.qcMap.setView([${VIEW[0]}, ${VIEW[1]}], ${VIEW[2]}, { animate: false }); true`);
    await page.evaluate(`document.querySelector('#qcm-names-suppressed > summary').click(); true`);
    const roadRows = ['road:trail:fx-lower-ridge', 'road:trail:fx-at-standing-indian', 'road:mvum-road:fx-fr-67', 'road:name:wayah road'];
    await waitInPage(page, 'road rows in the list', `${JSON.stringify(roadRows)}.every((id) => document.querySelector('.qcm-place-row[data-place-id="' + id + '"]'))`, CEILING, null);
    const rows = await page.evaluate(`[...document.querySelectorAll('.qcm-place-row')].map((b) => ({ id: b.dataset.placeId, text: b.textContent }))`);
    for (const id of roadRows) {
      assert.ok(rows.some((r) => r.id === id), `Places in this view lists ${id}: ${JSON.stringify(rows.map((r) => r.id))}`);
    }
    const groups = await page.evaluate(`document.getElementById('qcm-places-filter-groups').textContent`);
    for (const label of ['Forest roads', 'Forest and other trails', 'Roads lettered on the map']) assert.ok(groups.includes(label), `a group named "${label}": ${groups}`);

    // On a phone the controls sit in a closed bottom sheet (visibility:hidden), so a keyboard
    // user opens the layers panel and the list first, as the page's own disclosures do.
    const setPanel = (open) => page.evaluate(`(async () => {
      document.getElementById('qcm-layer-panel').open = ${open};
      document.getElementById('qcm-names-suppressed').open = ${open};
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return true;
    })()`);
    await setPanel(true);
    const viaKeyboard = async (id) => {
      // A card pans the map to itself, so put the fixture view back before choosing the next row.
      await closeCard(page);
      await page.evaluate(`window.qcMap.setView([${VIEW[0]}, ${VIEW[1]}], ${VIEW[2]}, { animate: false }); true`);
      await waitInPage(page, `${id} to be listed`, `Boolean(document.querySelector('.qcm-place-row[data-place-id="${id}"]'))`, CEILING, null);
      const have = await page.evaluate(`Boolean(document.querySelector('.qcm-place-row[data-place-id="${id}"]'))`);
      assert.ok(have, `${id} is still in Places in this view: ${await page.evaluate(`JSON.stringify([...document.querySelectorAll('.qcm-place-row')].map((b) => b.dataset.placeId))`)}`);
      await page.evaluate(`document.querySelector('.qcm-place-row[data-place-id="${id}"]').focus(); true`);
      await key(page, 'Enter', 'Enter', 13, '\r');
      await waitCard(page, `the card for ${id} chosen from Places in this view`);
      return page.evaluate(CARD);
    };
    const listed = await viaKeyboard('road:trail:fx-lower-ridge');
    assert.equal(listed.id, clicked.id, 'Places opens the same feature the click and the tap did');
    assert.equal(listed.title, clicked.title, 'with the same title');
    assert.equal(listed.text, tapped.text, 'and the same card');
    await key(page, 'Escape', 'Escape', 27);
    await waitInPage(page, 'the card to close', nothingOpen, CEILING, null);
    assert.equal(await page.evaluate(`document.activeElement?.dataset?.placeId`), 'road:trail:fx-lower-ridge', 'closing the card hands the keyboard back to its row');

    const listedRoad = await viaKeyboard('road:mvum-road:fx-fr-67');
    assert.equal(listedRoad.text, forest.text, 'a forest road from the list reads exactly as it does from a tap');

    // 7. A road lettered on the map: a row and a card, and the lettering itself stays out of the way.
    const lettered = await viaKeyboard('road:name:wayah road');
    await setPanel(false);
    assert.equal(lettered.id, 'road:name:wayah road');
    assert.equal(lettered.title, 'Wayah Road');
    assert.ok(lettered.text.includes(`Source: ${SOURCES.usgsRoadNames.attribution}`), lettered.text);
    const labels = await page.evaluate(`[...document.querySelectorAll('.qcm-road-label')].map((e) => {
      const r = e.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { pointerEvents: getComputedStyle(e).pointerEvents, focusable: [e, ...e.querySelectorAll('*')].some((n) => n.matches('[tabindex], a, button')) || (() => { for (let n = e; n && !n.classList.contains('leaflet-container'); n = n.parentElement) if (n.matches('[tabindex], a, button')) return true; return false; })(), hitByLabel: Boolean(hit && hit.closest('.qcm-road-label')) };
    })`);
    assert.ok(labels.length >= 1, 'a road label is on the map');
    for (const l of labels) {
      assert.equal(l.pointerEvents, 'none', 'a road label takes no pointer events');
      assert.equal(l.focusable, false, 'a road label is not a focus stop');
      assert.equal(l.hitByLabel, false, 'a press on the lettering reaches the map beneath it');
    }
    // 10. Bare ground opens nothing. Last, because a tap on bare ground lands on the print-area
    //     cell under it ("Extend print area here"), which is the page's own action and redraws
    //     the sources; that is no reason for a card or a chooser.
    // (120, 300) in the map: clear of the left control column and the legend, 90+ px from the AT.
    const mapTop = await page.evaluate(`document.getElementById('qc-map').getBoundingClientRect().top`);
    // The tap must land on the map itself, or "nothing opened" proves nothing.
    assert.equal(await page.evaluate(`(() => { const el = document.elementFromPoint(120, ${mapTop + 300});
      return !!el && !!el.closest('#qc-map') && !el.closest('.leaflet-control-container'); })()`), true,
      'the bare-ground tap point is on the map, not on a control');
    await touchTap(page, { x: 120, y: mapTop + 300 });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await page.evaluate(nothingOpen), true, 'a tap on bare ground opens neither a card nor a chooser');
  } finally { page.close(); await site.close(); }
});
