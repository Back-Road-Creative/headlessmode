// QQA-18 slice 1, Journey 11 (plan 5.3): "growing layer catalogue: search by purpose/provider/alias,
// open every group, activate across topics, find/remove an active layer after filtering, select a
// print extra, restore an old shared view", on the real built Field Maps app.
//
// Presentation only: every assertion about identity (input ids, the qcm-context radio name, the
// base radios, a layer being a checkbox or a radio) is here to prove the regrouping moved rows
// between headings and changed nothing else.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { trustedClick } from './helpers/trusted-click.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage } from './helpers/waits.mjs';
import { TASK_GROUPS } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const IS_VISIBLE = `(el) => el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })`;
const HEADINGS = TASK_GROUPS.map((g) => g.label);

let shared = null;
async function sharedBrowser() {
  if (!shared) {
    const site = await startSiteServer();
    const page = await launch(CHROMIUM, 'about:blank', { viewport: { width: 1280, height: 900 }, args: ['--hide-scrollbars'] });
    shared = { site, page };
  }
  return shared;
}
after(async () => {
  if (!shared) return;
  shared.page.close();
  await shared.site.close();
});

async function freshPage(hash = '') {
  const { site, page } = await sharedBrowser();
  await page.setViewport({ width: 1280, height: 900 });
  await page.navigate('about:blank');
  await page.navigate(`${site.origin}/quiet-corners/${hash}`);
  await readyDashboard(page, { data: false });
  const isOpen = () => page.evaluate("document.getElementById('qcm-layer-panel').open");
  for (let attempt = 0; attempt < 8 && !(await isOpen()); attempt++) {
    await trustedClick(page, '#qcm-layer-panel summary');
    for (let i = 0; i < 5 && !(await isOpen()); i++) await page.evaluate('new Promise(r => setTimeout(r, 100))');
  }
  assert.equal(await isOpen(), true, 'the Layers panel summary did not open the panel');
  return page;
}

const search = (page, value) => page.evaluate(`(() => {
  const box = document.getElementById('qcm-layer-search');
  box.value = ${JSON.stringify(value)};
  box.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
const groupState = (page) => page.evaluate(`(() => Object.fromEntries([...document.querySelectorAll('#qcm-layers > .qcm-layer-group')]
  .map((g) => [g.getAttribute('aria-label'), { open: g.open, hidden: g.hidden }])))()`);
const activeIds = (page) => page.evaluate(`[...document.querySelectorAll('#qcm-active-layers [data-active-layer]')].map((li) => li.getAttribute('data-active-layer'))`);
const groupSel = (label) => `.qcm-layer-group[aria-label="${label}"]`;
async function openGroup(page, label) {
  const open = () => page.evaluate(`document.querySelector(${JSON.stringify(groupSel(label))}).open`);
  if (!(await open())) await trustedClick(page, `${groupSel(label)} summary`, { until: `document.querySelector(${JSON.stringify(groupSel(label))}).open` });
}

test('the panel headings are the task groups, all collapsed, with an Active list that is empty and takes no room on a fresh page (road and place names open on but are lettering, not a choice)', { skip }, async () => {
  const page = await freshPage();
  const groups = await groupState(page);
  assert.deepEqual(Object.keys(groups), HEADINGS, 'the headings, in order, are the plan 4.7 task groups');
  for (const [label, g] of Object.entries(groups)) assert.equal(g.open, false, `"${label}" must start collapsed`);
  const active = await page.evaluate(`(() => { const el = document.getElementById('qcm-active-layers'); return el ? { hidden: el.hidden, visible: el.checkVisibility(), rows: el.querySelectorAll('[data-active-layer]').length } : null; })()`);
  assert.ok(active, 'no #qcm-active-layers in the Layers panel');
  assert.equal(active.rows, 0, 'a fresh page lists nothing as active: road and place names open on but are not a layer the reader chose');
  assert.equal(active.visible, false, 'an empty Active list must not spend panel height');
  // Search stays above the groups, and the Active list sits between them.
  const order = await page.evaluate(`(() => {
    const top = (id) => document.getElementById(id).getBoundingClientRect().top;
    return { search: top('qcm-layer-search'), activeOnly: top('qcm-layers-active-only'), groups: top('qcm-layers') };
  })()`);
  assert.ok(order.search < order.groups && order.activeOnly < order.groups, 'search and active-only sit above the groups');
});

test('every row has its one task-group home, and no row changed id, input type or radio group', { skip }, async () => {
  const page = await freshPage();
  const homes = await page.evaluate(`(() => {
    const out = {};
    for (const g of document.querySelectorAll('#qcm-layers > .qcm-layer-group')) {
      for (const i of g.querySelectorAll('input')) out[i.id] = { group: g.getAttribute('aria-label'), type: i.type, name: i.name };
    }
    return out;
  })()`);
  const expectIn = (id, group, type, name) => assert.deepEqual(homes[id], { group, type, name }, id);
  expectIn('qcm-base-usgsTopo', 'Map style', 'radio', 'qcm-base');
  expectIn('qcm-base-none', 'Map style', 'radio', 'qcm-base');
  expectIn('qcm-context-none', 'Map style', 'radio', 'qcm-context');
  expectIn('qcm-context-nightLights', 'Night sky', 'radio', 'qcm-context');
  expectIn('qcm-context-nwsRadar', 'Weather & conditions', 'radio', 'qcm-context');
  expectIn('qcm-context-terrainSlope', 'Terrain & landscape', 'radio', 'qcm-context');
  expectIn('qcm-context-countyScore', 'Explore counties', 'radio', 'qcm-context');
  expectIn('qcm-layer-nifcFirePerimeters', 'Weather & conditions', 'checkbox', 'qcm-layer-nifcFirePerimeters');
  expectIn('qcm-layer-swpcAurora', 'Night sky', 'checkbox', 'qcm-layer-swpcAurora');
  expectIn('qcm-layer-trails', 'Places & routes', 'checkbox', 'qcm-layer-trails');
  expectIn('qcm-layer-federalLand', 'Land & access', 'checkbox', 'qcm-layer-federalLand');
  expectIn('qcm-layer-gameLands', 'Land & access', 'checkbox', 'qcm-layer-gameLands');
  expectIn('qcm-layer-padusAccess', 'Place facts', 'checkbox', 'qcm-layer-padusAccess');
  expectIn('qcm-layer-tripPage', 'Print options', 'checkbox', 'qcm-layer-tripPage');
  for (const id of ['roadCameras', 'parkCameras', 'linkCameras', 'phenoCameras', 'airportCameras']) {
    expectIn(`qcm-layer-${id}`, 'Cameras', 'checkbox', `qcm-layer-${id}`);
  }
  // The raster surfaces are still ONE radio choice although they now sit under different headings.
  const exclusive = await page.evaluate(`(() => {
    const click = (id) => document.getElementById(id).click();
    const checked = () => [...document.querySelectorAll('input[name="qcm-context"]:checked')].map((i) => i.value);
    click('qcm-context-nightLights'); const a = checked();
    click('qcm-context-nwsRadar'); const b = checked();
    click('qcm-layer-nifcFirePerimeters');
    click('qcm-context-terrainSlope'); const c = checked();
    return { a, b, c, fire: document.getElementById('qcm-layer-nifcFirePerimeters').checked };
  })()`);
  assert.deepEqual(exclusive.a, ['nightLights']);
  assert.deepEqual(exclusive.b, ['nwsRadar'], 'choosing radar under Weather must unchoose night lights under Night sky');
  assert.deepEqual(exclusive.c, ['terrainSlope']);
  assert.equal(exclusive.fire, true, 'a vector overlay stays independent of the surface choice');
});

test('J11 search: by alias, purpose and provider; a match opens its group and clearing the search restores the expansion', { skip }, async () => {
  const page = await freshPage();
  const before = await groupState(page);
  // Alias: "webcam" is a search term of the camera rows, not part of any label.
  await search(page, 'webcam');
  let g = await groupState(page);
  assert.equal(g.Cameras.open && !g.Cameras.hidden, true, 'a webcam search must open Cameras');
  assert.equal(g['Land & access'].hidden, true, 'a group with no match is hidden');
  // Purpose: "weather" is a heading word, not a layer label.
  await search(page, 'weather');
  g = await groupState(page);
  assert.equal(g['Weather & conditions'].open && !g['Weather & conditions'].hidden, true);
  // (Cameras stays: the airport cameras are weather cameras by their own note.)
  assert.equal(g['Land & access'].hidden, true, 'a purpose search hides a group with nothing to do with it');
  // Provider: NOAA publishes the aurora forecast (Night sky) and smoke (Weather); neither label says so.
  await search(page, 'noaa');
  g = await groupState(page);
  assert.equal(!g['Night sky'].hidden && !g['Weather & conditions'].hidden, true, 'a provider search must find its rows in two topics');
  assert.equal(g['Land & access'].hidden, true);
  // Clearing puts every group back exactly as it was before the first search.
  await search(page, '');
  g = await groupState(page);
  assert.deepEqual(g, before, 'clearing the search must restore the expansion from before it');
});

test('J11 search restore keeps a group the reader opened by hand, before or during the search', { skip }, async () => {
  const page = await freshPage();
  await openGroup(page, 'Places & routes');
  await search(page, 'webcam');
  await trustedClick(page, `${groupSel('Cameras')} summary`);   // the reader closes then reopens it during the search
  await trustedClick(page, `${groupSel('Cameras')} summary`);
  await search(page, '');
  const g = await groupState(page);
  assert.equal(g['Places & routes'].open, true, 'a group open before the search stays open');
  assert.equal(g.Cameras.open, true, 'a group the reader touched during the search is theirs, not restored');
  assert.equal(g['Weather & conditions'].open, false);
});

test('J11: open every group, switch on layers across topics, find and remove one after filtering, pick a print extra', { skip }, async () => {
  const page = await freshPage();
  for (const label of HEADINGS) await openGroup(page, label);
  const groups = await groupState(page);
  for (const label of HEADINGS) assert.equal(groups[label].open, true, `${label} did not open`);

  // Activate across topics with real clicks.
  for (const id of ['qcm-layer-trails', 'qcm-layer-nifcFirePerimeters', 'qcm-context-nightLights', 'qcm-layer-roadCameras']) {
    await trustedClick(page, `#${id}`);
  }
  assert.deepEqual((await activeIds(page)).sort(), ['nifcFirePerimeters', 'nightLights', 'roadCameras', 'trails']);
  const names = await page.evaluate(`[...document.querySelectorAll('#qcm-active-layers [data-active-layer] .qcm-active-name')].map((n) => n.textContent.trim())`);
  assert.ok(names.every((n) => n.length > 0) && names.some((n) => /trails/i.test(n)), `the Active list names its rows: ${JSON.stringify(names)}`);

  // A print extra is chosen, belongs to Print options, and is not "on the map".
  const countBefore = await page.evaluate("document.getElementById('qcm-layer-count').textContent");
  assert.match(countBefore, /^4 layers on/, 'the count line counts the four layers the reader switched on, not the default-on place and road names');
  await trustedClick(page, '#qcm-layer-tripPage');
  assert.equal(await page.evaluate("document.getElementById('qcm-layer-tripPage').checked"), true);
  assert.ok(!(await activeIds(page)).includes('tripPage'), 'a print extra is not listed as active on the map');
  // ...and the count line agrees with the list: four layers on the map, the print extra not among them.
  assert.equal(await page.evaluate("document.getElementById('qcm-layer-count').textContent"), countBefore, 'the count line must not count a print extra');

  // Filter: only layers that are on, then a search; the Active list is still the way to the active layer.
  await page.evaluate(`(() => { const cb = document.getElementById('qcm-layers-active-only'); cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await search(page, 'fire');
  const filtered = await page.evaluate(`(() => {
    const isVisible = ${IS_VISIBLE};
    return { trails: isVisible(document.getElementById('qcm-layer-trails').closest('.qcm-layer-row')),
      fire: isVisible(document.getElementById('qcm-layer-nifcFirePerimeters').closest('.qcm-layer-row')) };
  })()`);
  assert.equal(filtered.trails, false, 'the search hid Trails');
  assert.equal(filtered.fire, true);
  assert.deepEqual((await activeIds(page)).sort(), ['nifcFirePerimeters', 'nightLights', 'roadCameras', 'trails'], 'filtering must not empty the Active list');

  // Remove a layer the filter has hidden, from the Active list.
  await trustedClick(page, '#qcm-active-layers [data-active-layer="trails"] button.qcm-active-remove');
  assert.equal(await page.evaluate("document.getElementById('qcm-layer-trails').checked"), false, 'Remove must switch the layer off');
  assert.ok(!(await activeIds(page)).includes('trails'));
  // Removing a context surface goes through the same radio as everywhere else: None.
  await trustedClick(page, '#qcm-active-layers [data-active-layer="nightLights"] button.qcm-active-remove');
  assert.equal(await page.evaluate("document.querySelector('input[name=\"qcm-context\"]:checked').value"), 'none');
  assert.ok(!(await activeIds(page)).includes('nightLights'));
  assert.deepEqual((await activeIds(page)).sort(), ['nifcFirePerimeters', 'roadCameras']);
});

test('J11: an old shared view restores by stable id and the Active list shows what it turned on', { skip }, async () => {
  // A link made before the regrouping: base, a surface and two overlays by id, nothing about headings.
  const page = await freshPage('#map=v1&z=9&c=44.5,-89.5&b=usgsImagery&s=nightLights&o=nifcFirePerimeters,trails');
  await waitInPage(page, 'the old link to switch its layers on', "document.getElementById('qcm-layer-nifcFirePerimeters').checked && document.getElementById('qcm-layer-trails').checked", 20000, null);
  const s = await page.evaluate(`({
    base: document.querySelector('input[name="qcm-base"]:checked').value,
    surface: document.querySelector('input[name="qcm-context"]:checked').value,
    active: [...document.querySelectorAll('#qcm-active-layers [data-active-layer]')].map((li) => li.getAttribute('data-active-layer')).sort(),
  })`);
  assert.equal(s.base, 'usgsImagery');
  assert.equal(s.surface, 'nightLights');
  assert.deepEqual(s.active.slice().sort(), ['nifcFirePerimeters', 'nightLights', 'trails']);
});

test('J11: a re-render that changes nothing leaves the Active list alone, so a focused Remove button keeps focus', { skip }, async () => {
  const page = await freshPage();
  await openGroup(page, 'Places & routes');
  await trustedClick(page, '#qcm-layer-trails');
  assert.deepEqual((await activeIds(page)).sort(), ['trails']);
  // Keyboard focus on the row's Remove button, and a mark on the node that holds it.
  await page.evaluate(`(() => {
    const li = document.querySelector('#qcm-active-layers [data-active-layer="trails"]');
    li.dataset.mark = 'kept';
    li.querySelector('button.qcm-active-remove').focus();
  })()`);
  // A print extra changes a switch and runs the same panel refresh a fetch completion does, but
  // the Active list's content is the same. Dispatched in the page so focus is not moved.
  await page.evaluate(`(() => { const cb = document.getElementById('qcm-layer-tripPage'); cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const after = await page.evaluate(`({
    kept: document.querySelector('#qcm-active-layers [data-active-layer="trails"]')?.dataset.mark,
    focused: document.activeElement?.closest?.('[data-active-layer]')?.getAttribute('data-active-layer') || null,
    onRemove: document.activeElement?.classList?.contains('qcm-active-remove') || false,
  })`);
  assert.equal(after.kept, 'kept', 'the Active list was rebuilt although nothing in it changed');
  assert.equal(after.focused, 'trails', 'focus left the Remove button on a re-render that changed nothing');
  assert.equal(after.onRemove, true);
});
