// The page's controls and the script that wires them, checked against each other.
//
// These are source-contract assertions, not behaviour: the wiring is DOM code that the
// Node suite cannot execute. They exist because of a real defect — `?calibrate=1` did
// `return offerCalibrationSheet()`, an early return that skipped the entire builder
// startup, so the flag left the page able to do nothing but produce a calibration sheet.
// The calibration sheet is an extra, never a mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { layoutMarkup } from './helpers/layouts.mjs';
import { DEFAULT_BASE, leafletOptions } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-basemaps.js';

const page = layoutMarkup();
const main = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');

// DERIVED, not listed. The list was seven ids and main.js reached for more; when
// the builder moved onto the dashboard, #qcm-use-example was left behind on the
// retired page and this test said nothing, because the id was not in the list.
// main.js wires by id with no null guard, so one missing element is a TypeError
// that takes the whole builder down.
const IDS = [...new Set([...main.matchAll(/\$\('(qcm-[a-z0-9-]+)'\)/g)].map((m) => m[1]))];

test('every control main.js reaches for exists in the page', () => {
  assert.ok(IDS.length >= 7, `only ${IDS.length} ids found — the extraction has stopped matching`);
  for (const id of IDS) assert.ok(page.includes(`id="${id}"`), `main.js wires #${id} and no page has it`);
});

test('the calibration sheet has its own download anchor, and does not take the map PDF\'s', () => {
  const fn = main.slice(main.indexOf('async function offerCalibrationSheet'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(body.includes('qcm-calibration-download'), 'calibration must use its own anchor');
  assert.ok(!body.includes("$('qcm-download')"), 'calibration must not overwrite the map PDF download link');
});

test('the calibrate flag adds the sheet, it does not replace the builder', () => {
  assert.ok(!/return\s+offerCalibrationSheet\(\)/.test(main),
    'an early return here skips renderSources() and the whole builder startup');
  assert.ok(/calibrate'\) === '1'\) offerCalibrationSheet\(\)/.test(main),
    'the flag should trigger the sheet alongside the normal startup');
  const start = main.slice(main.indexOf('function start()'));
  assert.ok(start.indexOf('renderSources()') > start.indexOf("calibrate'"),
    'renderSources() must still run after the calibrate branch');
});

// layerReport is the only thing that can tell "the service answered and this area
// has none" from "there is no coverage here" — the whole point of the registry's
// emptyMeans. It was written, tested and never rendered: the page showed one
// summary line covering every layer at once.
test('the page renders a per-layer report, not just the one-line summary', () => {
  assert.ok(main.includes('layerReport'), 'main.js never calls layerReport');
  assert.ok(main.includes('renderLayerReports'), 'and never renders one');
  assert.ok(/renderLayerReports\(\);/.test(main.slice(main.indexOf('function renderSources'))),
    'reports must refresh whenever the source state does');
  // A report needs a count to report, and a count needs to be collected.
  const check = main.slice(main.indexOf('async function sourcePass('), main.indexOf('const busy ='));
  for (const id of ['mvum', 'trails', 'recSites']) {
    assert.ok(new RegExp(`state\\.counts\\.?\\[?'?${id}`).test(check), `checkSources never counts ${id}`);
  }
  assert.ok(/state\.counts\[family\]/.test(check), 'and never counts a state land family');
});

test('the layer panel is grouped, and a group heading is derived rather than written', () => {
  assert.ok(main.includes('GROUPS'), 'main.js must read the registry groups');
  assert.ok(!/Federal overlays|Extra sheets/.test(main), 'group labels belong to the registry, not to the DOM code');
  assert.ok(page.includes('id="qcm-layers"'), 'the panel host is still the one the registry fills');
});

// --- one map ---------------------------------------------------------------
// JP, 2026-09-07: "there is only supposed to be one map, there should be no
// hidden map. one single map with all these layers / features."
test('the dashboard map is the one map: it reaches field zooms and hands itself over', () => {
  const dash = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners.js', import.meta.url), 'utf8');
  assert.match(dash, /maxZoom:\s*FIELD_MAX_ZOOM/, 'the county map still stops at its own maxZoom');
  assert.match(dash, /FIELD_MAX_ZOOM\s*=\s*16/, '16 is where the USGS Topo cache ends');
  // Since A1 the dashboard draws its base through source-basemaps.js at every zoom,
  // so the topographic URL lives in the registry, not in this file: follow it there.
  assert.match(dash, /baseLayer\(L,\s*DEFAULT_BASE\)/, 'the map draws no base through source-basemaps.js');
  assert.ok(!/minZoom:\s*FIELD_MIN_ZOOM/.test(dash), 'the base tile layer must not be floored at field zoom (Q-base, A1)');
  assert.equal(DEFAULT_BASE, 'usgsTopo', 'the default base is no longer topographic');
  assert.match(leafletOptions(DEFAULT_BASE).url, /USGSTopo\/MapServer\/tile/, 'the map draws no topographic base');
  assert.match(dash, /qc:map-ready/, 'the map is never handed over, so a second one would have to be made');
  assert.match(dash, /window\.qcMap = map/, 'nothing can reach the map instance');
});

test('the dashboard carries the map policy, or its tiles are blocked', async () => {
  const { DASHBOARD_PATH, mapRulePaths, stateOrigins } = await import('../../themes/headlessmode/static/js/quiet-corners-maps/state-pages.js');
  const { cspValue } = await import('./gen-headers.mjs');
  assert.ok(mapRulePaths().includes(DASHBOARD_PATH));
  // The global policy pins img-src to 'self', which would silently drop every tile.
  // The map policy is the page's <meta> now; it is cspValue(), the same string.
  assert.match(cspValue(stateOrigins()), /basemap\.nationalmap\.gov/,
    'the dashboard cannot fetch the topographic base it now draws');
});
