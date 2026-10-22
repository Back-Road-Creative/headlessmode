// Tests for the IndexedDB recipe store, driven through a tiny in-memory fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeRecipe, parseRecipe } from '../../themes/headlessmode/static/js/quiet-corners-maps/sheet-plan.js';
import { createProjectStore, DB_NAME, STORE, KEY, VERSION, CLEARED_KEY } from '../../themes/headlessmode/static/js/quiet-corners-maps/project-store.js';

// Minimal IndexedDB shape: requests fire onsuccess/onerror on a microtask.
function fakeIndexedDB() {
  const data = new Map();
  const req = (run) => {
    const r = {};
    queueMicrotask(() => {
      try { r.result = run(r); if (r.onsuccess) r.onsuccess({ target: r }); } catch (e) { r.error = e; if (r.onerror) r.onerror({ target: r }); }
    });
    return r;
  };
  const store = { get: (k) => req(() => data.get(k)), put: (v, k) => req(() => { data.set(k, v); return k; }), delete: (k) => req(() => { data.delete(k); }) };
  const db = { createObjectStore: () => store, transaction: () => ({ objectStore: () => store }), close() {} };
  const opened = [];
  return { data, opened, open: (name, version) => { opened.push([name, version]);
    return req((r) => { r.result = db; if (r.onupgradeneeded) r.onupgradeneeded({ target: r }); return db; }); } };
}

const recipe = { paper: 'letter', orientation: 'landscape', scale: 48000, overlapIn: 0.25, dpi: 200,
  extent: { minX: 1, minY: 2, maxX: 30, maxY: 40 }, zone: 17, hemisphere: 'N', title: 'Round trip' };
const make = (indexedDB) => createProjectStore({ indexedDB, serialize: serializeRecipe, parse: parseRecipe });

test('save then load round-trips through injected serialize/parse; only the string is stored', async () => {
  assert.deepEqual([DB_NAME, STORE, KEY, VERSION], ['quiet-corners-field-maps', 'recipes', 'last', 1]);
  const idb = fakeIndexedDB(); const s = make(idb);
  assert.equal(s.available, true);
  assert.equal(await s.saveRecipe(recipe), true);
  assert.deepEqual([...idb.data], [[KEY, serializeRecipe(recipe)]]);
  assert.deepEqual(await s.loadRecipe(), parseRecipe(serializeRecipe(recipe)));
  assert.deepEqual(idb.opened[0], [DB_NAME, VERSION]);
  await s.clear();
  assert.equal(await s.loadRecipe(), null);
});

test('empty store loads null; a corrupt entry loads null and is cleared', async () => {
  const idb = fakeIndexedDB(); const s = make(idb);
  assert.equal(await s.loadRecipe(), null);
  idb.data.set(KEY, '{"paper":"a4"}');
  assert.equal(await s.loadRecipe(), null);
  assert.equal(idb.data.has(KEY), false);
});

test('no indexedDB: available false, save false, load null, clear resolves', async () => {
  const s = make(undefined);
  assert.deepEqual([s.available, await s.saveRecipe(recipe), await s.loadRecipe(), await s.clear()], [false, false, null, undefined]);
});

test('missing serialize or parse is a TypeError at construction', () => {
  assert.throws(() => createProjectStore({ indexedDB: fakeIndexedDB(), parse: parseRecipe }), TypeError);
  assert.throws(() => createProjectStore({ indexedDB: fakeIndexedDB(), serialize: serializeRecipe }), TypeError);
});

// Clear is followed by a reload before the IndexedDB delete has even been issued (the
// database was still opening): nothing can await across that, so Clear leaves a
// synchronous note in `storage` and the next load honours it.
const fakeStorage = () => { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } }; };
const makeWith = (indexedDB, storage) => createProjectStore({ indexedDB, serialize: serializeRecipe, parse: parseRecipe, storage });

test('clear() notes the clear synchronously, before its IndexedDB delete can run', async () => {
  const idb = fakeIndexedDB(); const storage = fakeStorage(); const s = makeWith(idb, storage);
  await s.saveRecipe(recipe);
  const pending = s.clear();
  assert.equal(storage.getItem(CLEARED_KEY), '1', 'the note must exist the moment clear() returns, not when the delete lands');
  await pending;
});

test('a load that finds the note returns null, finishes the delete, and drops the note', async () => {
  const idb = fakeIndexedDB(); const storage = fakeStorage(); const s = makeWith(idb, storage);
  idb.data.set(KEY, serializeRecipe(recipe)); // the delete never reached the database
  storage.setItem(CLEARED_KEY, '1');
  assert.equal(await s.loadRecipe(), null);
  assert.equal(idb.data.has(KEY), false, 'the load should finish the delete Clear started');
  assert.equal(storage.getItem(CLEARED_KEY), null);
  assert.equal(await s.loadRecipe(), null);
});

test('saving a new recipe retires the note, so the next load restores it', async () => {
  const idb = fakeIndexedDB(); const storage = fakeStorage(); const s = makeWith(idb, storage);
  await s.clear();
  assert.equal(await s.saveRecipe(recipe), true);
  assert.equal(storage.getItem(CLEARED_KEY), null);
  assert.deepEqual(await s.loadRecipe(), parseRecipe(serializeRecipe(recipe)));
});

test('storage that throws never breaks the store', async () => {
  const boom = () => { throw new Error('blocked'); };
  const s = makeWith(fakeIndexedDB(), { getItem: boom, setItem: boom, removeItem: boom });
  assert.equal(await s.saveRecipe(recipe), true);
  assert.deepEqual(await s.loadRecipe(), parseRecipe(serializeRecipe(recipe)));
  await s.clear();
  assert.equal(await s.loadRecipe(), null);
});

// CI saw Chromium's IndexedDB open never answer under load: start-up sat at "reading the
// saved job from IndexedDB" until every 60 s browser wait ran out. A store that waits
// forever breaks the "every method resolves" promise above, so each call has a deadline.
function hangingIndexedDB() {
  const pending = [];
  return { pending, open: () => { const r = {}; pending.push(r); return r; } };
}

test('an IndexedDB open that never answers: load null, save false, clear resolves, all inside the deadline', async () => {
  const idb = hangingIndexedDB();
  const s = createProjectStore({ indexedDB: idb, serialize: serializeRecipe, parse: parseRecipe, timeoutMs: 20 });
  const started = Date.now();
  assert.deepEqual([await s.loadRecipe(), await s.saveRecipe(recipe), await s.clear()], [null, false, undefined]);
  assert.ok(Date.now() - started < 1000, 'each call gives up at its deadline');
  assert.equal(idb.pending.length, 3);
});

test('an open that answers after the deadline still closes its database', async () => {
  const idb = hangingIndexedDB();
  const s = createProjectStore({ indexedDB: idb, serialize: serializeRecipe, parse: parseRecipe, timeoutMs: 20 });
  assert.equal(await s.loadRecipe(), null);
  let closed = 0;
  const store = { get: () => { const r = {}; queueMicrotask(() => { r.result = undefined; r.onsuccess(); }); return r; } };
  const [late] = idb.pending;
  late.result = { transaction: () => ({ objectStore: () => store }), close() { closed += 1; } };
  late.onsuccess();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(closed, 1);
});

test('the default deadline is 20 s: inside the 60 s browser waits, past the late-restore hold', () => {
  assert.equal(createProjectStore({ indexedDB: hangingIndexedDB(), serialize: serializeRecipe, parse: parseRecipe }).timeoutMs, 20000);
});
