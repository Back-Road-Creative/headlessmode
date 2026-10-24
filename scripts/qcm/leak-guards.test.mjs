// QQA-13c: the two guards that stop the map page growing without bound, and the wiring that
// puts them where the growth was. main.js is a browser module the Node suite cannot execute,
// so the guards live in leak-guards.js (pure, `urls` injectable) and the wiring is a source
// contract, the same split key-sheet.test.mjs and page-controls.test.mjs use. The browser
// proof that nothing grows across real open/close cycles is leak-cycles-browser.test.mjs.
// Run: node --test scripts/qcm/leak-guards.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createUrlSlot, createLru } from '../../themes/headlessmode/static/js/quiet-corners-maps/leak-guards.js';
import { ELEVATION_CACHE_LIMIT } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-elevation.js';

const main = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');

/** A URL stand-in that counts what it hands out and what it takes back. */
function fakeUrls() {
  const made = [], revoked = [];
  return { made, revoked, createObjectURL: (blob) => { const u = `blob:fake/${made.length}`; made.push([u, blob]); return u; }, revokeObjectURL: (u) => { revoked.push(u); } };
}

test('a url slot revokes the previous url before it hands out the next', () => {
  const urls = fakeUrls();
  const slot = createUrlSlot(urls);
  const first = slot.set('a'), second = slot.set('b');
  assert.equal(urls.made.length, 2);
  assert.deepEqual(urls.revoked, [first], 'only the first url is revoked after two sets');
  assert.notEqual(first, second);
  slot.set('c');
  assert.deepEqual(urls.revoked, [first, second], 'three sets revoke exactly two');
});

test('a url slot release revokes the live url once and a second release does nothing', () => {
  const urls = fakeUrls();
  const slot = createUrlSlot(urls);
  slot.release();
  assert.equal(urls.revoked.length, 0, 'releasing an empty slot revokes nothing');
  const live = slot.set('a');
  slot.release();
  slot.release();
  assert.deepEqual(urls.revoked, [live]);
  slot.set('b');
  assert.equal(urls.revoked.length, 1, 'a set after a release has nothing left to revoke');
});

test('an lru never holds more than its limit and drops the least recently used first', () => {
  const lru = createLru(3);
  for (const k of ['a', 'b', 'c']) lru.set(k, k.toUpperCase());
  assert.equal(lru.size, 3);
  lru.get('a'); // a is now the freshest, so b is the oldest
  lru.set('d', 'D');
  assert.equal(lru.size, 3);
  assert.equal(lru.has('b'), false, 'b was the least recently used');
  assert.deepEqual(['a', 'c', 'd'].map((k) => lru.get(k)), ['A', 'C', 'D']);
  lru.set('c', 'C2'); // an overwrite refreshes and never grows the cache
  assert.equal(lru.size, 3);
  assert.equal(lru.get('c'), 'C2');
});

test('an lru keeps a settled null (NoData) as a hit, which is what the elevation cache stores', () => {
  const lru = createLru(2);
  lru.set('p', null);
  assert.equal(lru.has('p'), true);
  assert.equal(lru.get('p'), null);
});

test('the elevation cache holds exactly its limit after limit + 1 points', () => {
  assert.equal(ELEVATION_CACHE_LIMIT, 256);
  const lru = createLru(ELEVATION_CACHE_LIMIT);
  for (let i = 0; i < ELEVATION_CACHE_LIMIT + 1; i++) lru.set(`pin-${i}`, i);
  assert.equal(lru.size, ELEVATION_CACHE_LIMIT);
  assert.equal(lru.has('pin-0'), false, 'the first point is the one dropped');
  assert.equal(lru.has(`pin-${ELEVATION_CACHE_LIMIT}`), true);
});

// --- wiring -------------------------------------------------------------------------
const bodyOf = (name) => {
  const fn = main.slice(main.indexOf(name));
  return fn.slice(0, fn.indexOf('\n}'));
};

test('main.js bounds the elevation cache with the limit', () => {
  assert.ok(main.includes('const elevationCache = createLru(ELEVATION_CACHE_LIMIT);'), 'elevationCache must be an lru of ELEVATION_CACHE_LIMIT');
  assert.ok(!/const elevationCache = new Map/.test(main), 'the unbounded Map is back');
});

test('the calibration and key-sheet downloads go through a url slot, never a bare createObjectURL', () => {
  for (const [fn, slot] of [['async function offerCalibrationSheet', 'calibrationUrl'], ['async function offerKeySheet', 'keySheetUrl']]) {
    const body = bodyOf(fn);
    assert.ok(body.includes(`${slot}.set(`), `${fn} must hand its blob to ${slot}`);
    assert.ok(!body.includes('URL.createObjectURL'), `${fn} still makes a url nobody revokes`);
    assert.ok(main.includes(`const ${slot} = createUrlSlot();`), `${slot} is never created`);
  }
});

test('the hillshade layer keeps its picture in a url slot and gives it back when it comes off the map', () => {
  const body = bodyOf('function hillshadeContextLayer');
  assert.ok(body.includes('createUrlSlot()'), 'the hillshade object url must live in a slot');
  assert.ok(!body.includes('URL.createObjectURL'), 'a bare createObjectURL is back in the hillshade layer');
  assert.ok(body.includes('layer.release'), 'the layer must offer release()');
  const render = bodyOf('async function renderHillshade');
  assert.equal(render.split('hillshade.release()').length - 1, 2, 'both removals (switch off, service not ready) must release the url');
});

// --- off during a fetch ---------------------------------------------------------------
test('a set that comes back after release() with an older ticket makes no url', () => {
  const urls = fakeUrls();
  const slot = createUrlSlot(urls);
  const ticket = slot.ticket(); // the fetch starts
  slot.release();               // the layer is switched off while it is in flight
  assert.equal(slot.set('late', ticket), null, 'a stale ticket gets no url');
  assert.equal(urls.made.length, 0, 'no blob url is created after the release');
  assert.equal(urls.revoked.length, 0);
  const next = slot.ticket();   // switched back on: a new fetch, a new ticket
  assert.equal(typeof slot.set('fresh', next), 'string');
  assert.equal(urls.made.length, 1);
});

test('a set with the current ticket, or none, still makes a url', () => {
  const urls = fakeUrls();
  const slot = createUrlSlot(urls);
  assert.equal(typeof slot.set('a', slot.ticket()), 'string');
  assert.equal(typeof slot.set('b'), 'string');
  assert.equal(urls.made.length, 2);
  assert.equal(urls.revoked.length, 1);
});

test('the hillshade refresh asks the slot for a ticket before the fetch and treats a refused url as stale', () => {
  const body = bodyOf('function hillshadeContextLayer');
  const ticket = body.indexOf('picture.ticket()'), fetched = body.indexOf('await hillshadeFetcher.fetchImage'), set = body.indexOf('picture.set(result.blob, ');
  assert.ok(ticket > -1 && ticket < fetched, 'the ticket must be taken before the await');
  assert.ok(set > fetched, 'the blob is handed over with that ticket after the await');
  assert.ok(/status: 'stale'/.test(body), 'a refused url must come back as stale so renderHillshade does not re-add the layer');
});

test('renderHillshade re-checks the layer is still on after the await, so an off-during-fetch answer neither re-adds the layer nor rewrites the row', () => {
  const body = bodyOf('async function renderHillshade');
  const awaited = body.indexOf('await hillshade.refresh'), added = body.indexOf('hillshade.addTo(map)');
  const guard = body.indexOf('layersFromControls().hillshadeLight', awaited);
  assert.ok(awaited > -1 && guard > awaited && guard < added, 'the still-on check must sit between the await and addTo');
});
