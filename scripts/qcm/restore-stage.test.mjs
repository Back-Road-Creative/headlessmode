// readyDashboard's restore wait names the start-up stage it stalled in.
//
// #771's PR CI run failed its live smoke on "waited 60000 ms and the
// last-job restore to settle (window.qcRestoreSettled) never came true, and the page
// reports no failure of its own", on a loaded box. The same file passed on a quiet
// one. Field Maps' start() (main.js) has three awaits before it sets the flag: the
// host map, the IndexedDB read of the saved job, and the save that read may set off.
// The message named none of them, so the stall could not be placed. main.js now
// records each stage in window.qcRestoreStage, and PAGE_STATE reports it while the
// flag is unset. This is a diagnosis, not a retry: the wait still fails at its ceiling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PAGE_STATE } from './helpers/waits.mjs';

function pageState(win, { dashboard = true } = {}) {
  const document = {
    readyState: 'complete', title: 'Quiet Corners',
    getElementById: (id) => (id === 'qc-map' && dashboard ? {} : null),
    querySelector: () => null,
  };
  const ctx = { window: win, document, location: { protocol: 'file:', pathname: '/', search: '' }, performance: { getEntriesByType: () => [] }, URL };
  return vm.runInNewContext(PAGE_STATE, ctx);
}

test('a stalled restore reports the stage start() is in', () => {
  const s = pageState({ qcRestoreStage: 'reading the saved job from IndexedDB' });
  assert.match(s, /Field Maps start-up is at: reading the saved job from IndexedDB/);
});

test('a dashboard where start() never ran says so', () => {
  assert.match(pageState({}), /Field Maps start-up never began/);
});

test('a settled restore, and a page without the dashboard, add nothing', () => {
  assert.doesNotMatch(pageState({ qcRestoreStage: 'settled', qcRestoreSettled: true }), /Field Maps/);
  assert.doesNotMatch(pageState({}, { dashboard: false }), /Field Maps/);
});

test('main.js records every stage before the await it names, and settled last', () => {
  const src = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
  const at = (s) => { const i = src.indexOf(s); assert.ok(i > 0, `missing: ${s}`); return i; };
  const start = at('(async function start() {');
  const order = [
    at("window.qcRestoreStage = 'waiting for the dashboard map (qc:map-ready)'"),
    at('attach(await hostMap())'),
    at("window.qcRestoreStage = 'reading the saved job from IndexedDB'"),
    at('const r = await store.loadRecipe()'),
    at("window.qcRestoreStage = 'waiting for the last recipe save to land in IndexedDB'"),
    at('Promise.allSettled([lastSave])'),
    at("window.qcRestoreStage = 'settled'; window.qcRestoreSettled = true;"),
  ];
  assert.ok(start < order[0], 'first stage is set inside start()');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'stages are set in order, each before its await');
});
