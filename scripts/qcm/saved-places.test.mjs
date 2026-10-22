// QUX-09a: pure-module tests for Q/saved-places.js (§4.1 of
// .data/plans/2026-09-27-qux-specs/QUX-09.md). Fake storage follows the same
// Map-backed spy pattern as view-wiring.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SAVED_PLACES_KEY, MAX_PLACES,
  makeSavedPlace, envelope, parseSavedPlaces, createSavedPlacesStore, exportGpx, buildGpx,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/saved-places.js';
import { STATUS_TEXT } from '../../themes/headlessmode/static/js/quiet-corners-maps/saved-places-panel.js';
import * as PANEL from '../../themes/headlessmode/static/js/quiet-corners-maps/saved-places-panel.js';
import { PREFS_KEY, resetView, createPrefsStore } from '../../themes/headlessmode/static/js/quiet-corners-maps/view-wiring.js';
import { formatFragment, DEFAULT_VIEW } from '../../themes/headlessmode/static/js/quiet-corners-maps/view-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QCM_DIR = path.join(__dirname, '../../themes/headlessmode/static/js/quiet-corners-maps');
const SAVED_PLACES_SRC = readFileSync(path.join(QCM_DIR, 'saved-places.js'), 'utf8');
const SAVED_PANEL_SRC = readFileSync(path.join(QCM_DIR, 'saved-places-panel.js'), 'utf8');

const VALID_PLACE = Object.freeze({
  ref: 'gnis:100001', name: 'Test Peak', kind: 'summit', lat: 35.6, lon: -83.2, state: 'NC', county: 'Test County',
});

function fakeStorage(initial = null) {
  const backing = new Map();
  if (initial !== null) backing.set(SAVED_PLACES_KEY, initial);
  return {
    backing,
    storage: {
      getItem: (k) => (backing.has(k) ? backing.get(k) : null),
      setItem: (k, v) => backing.set(k, v),
      removeItem: (k) => backing.delete(k),
    },
  };
}

function quotaStorage() {
  const backing = new Map();
  return {
    backing,
    storage: {
      getItem: (k) => (backing.has(k) ? backing.get(k) : null),
      setItem: (k, v) => {
        if (k === SAVED_PLACES_KEY) {
          const err = new Error('quota exceeded');
          err.name = 'QuotaExceededError';
          throw err;
        }
        backing.set(k, v);
      },
      removeItem: (k) => backing.delete(k),
    },
  };
}

test('source shape: exactly one schemaVersion writer, one storage write, one storage delete', () => {
  assert.equal((SAVED_PLACES_SRC.match(/schemaVersion\s*:/g) || []).length, 1);
  assert.equal((SAVED_PLACES_SRC.match(/setItem\(/g) || []).length, 1);
  assert.equal((SAVED_PLACES_SRC.match(/removeItem\(/g) || []).length, 1);
});

test('no network: neither saved-places.js nor saved-places-panel.js reaches the network', () => {
  const scan = /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|[^.a-zA-Z]import\(/;
  assert.equal(scan.test(SAVED_PLACES_SRC), false);
  assert.equal(scan.test(SAVED_PANEL_SRC), false);
});

test('corrupt stored text is kept byte-identical; add and importText both refuse read-only', () => {
  const corrupt = '{"schemaVersion":1,"places":[{';
  const { storage, backing } = fakeStorage(corrupt);
  const store = createSavedPlacesStore({ storage });
  assert.equal(store.read().state, 'unreadable');
  assert.equal(store.read().raw, corrupt);

  let writes = 0;
  const realSet = storage.setItem;
  const realRemove = storage.removeItem;
  storage.setItem = (...args) => { writes += 1; return realSet(...args); };
  storage.removeItem = (...args) => { writes += 1; return realRemove(...args); };

  assert.equal(store.add(VALID_PLACE).reason, 'read-only');
  assert.equal(store.importText(JSON.stringify(envelope([VALID_PLACE]))).reason, 'read-only');
  assert.equal(writes, 0);
  assert.equal(backing.get(SAVED_PLACES_KEY), corrupt);
});

test('a newer schema version is read-only; exportText returns the raw text', () => {
  const raw = JSON.stringify({ schemaVersion: 2, places: [VALID_PLACE] });
  const { storage } = fakeStorage(raw);
  const store = createSavedPlacesStore({ storage });
  assert.equal(store.read().state, 'newer');
  assert.equal(store.add({ ...VALID_PLACE, ref: 'gnis:2' }).reason, 'read-only');
  assert.equal(store.exportText(), raw);
});

test('kept (unrecognized) entries survive every write, unchanged', () => {
  const invalidEntry = { ref: 'gnis:999', name: 'Missing Kind' }; // no `kind` -> rejected
  const raw = JSON.stringify({ schemaVersion: 1, places: [VALID_PLACE, invalidEntry] });
  const { storage, backing } = fakeStorage(raw);
  const store = createSavedPlacesStore({ storage });

  const read = store.read();
  assert.equal(read.state, 'ok');
  assert.equal(read.kept.length, 1);
  assert.deepEqual(read.kept[0], invalidEntry);

  assert.equal(store.add({ ...VALID_PLACE, ref: 'gnis:1000', name: 'Second' }).ok, true);
  const stored = JSON.parse(backing.get(SAVED_PLACES_KEY));
  assert.deepEqual(stored.places.find((p) => p.ref === 'gnis:999'), invalidEntry);
});

test('round trip across stores; the migration mechanism runs via an injected fake table', () => {
  const src = createSavedPlacesStore({ storage: fakeStorage().storage });
  const places = [
    { ...VALID_PLACE, ref: 'gnis:1' },
    { ...VALID_PLACE, ref: 'gnis:2', name: 'Second Place' },
    { ...VALID_PLACE, ref: 'gnis:3', name: 'Third Place' },
  ];
  for (const p of places) assert.equal(src.add(p).ok, true);
  const exported = src.exportText();

  const dst = createSavedPlacesStore({ storage: fakeStorage().storage });
  const imported = dst.importText(exported);
  assert.deepEqual(imported, { added: 3, duplicates: 0, invalid: 0, overLimit: false });
  assert.deepEqual(JSON.parse(dst.exportText()).places, JSON.parse(exported).places);

  const v1Text = JSON.stringify({ schemaVersion: 1, places: [VALID_PLACE] });
  let migrationCalls = 0;
  const migrated = parseSavedPlaces(v1Text, {
    migrations: { 1: (p) => { migrationCalls += 1; return p; } },
    current: 2,
  });
  assert.equal(migrated.state, 'migrated');
  assert.equal(migrated.from, 1);
  assert.equal(migrationCalls, 1);

  const stuck = parseSavedPlaces(v1Text, { migrations: {}, current: 3 });
  assert.equal(stuck.state, 'unreadable');
});

test('import merges by ref and never deletes; an unreadable import writes nothing', () => {
  const { storage } = fakeStorage();
  const store = createSavedPlacesStore({ storage });
  assert.equal(store.add({ ...VALID_PLACE, ref: 'gnis:1' }).ok, true);

  const importPayload = JSON.stringify({
    schemaVersion: 1,
    places: [
      { ...VALID_PLACE, ref: 'gnis:1' },
      { ...VALID_PLACE, ref: 'gnis:2', name: 'New A' },
      { ...VALID_PLACE, ref: 'gnis:3', name: 'New B' },
      { ref: 'not-a-real-ref', name: 'Bad' },
    ],
  });
  const result = store.importText(importPayload);
  assert.deepEqual(result, { added: 2, duplicates: 1, invalid: 1, overLimit: false });
  assert.equal(store.read().places.length, 3);

  const before = store.exportText();
  const refused = store.importText('not json{');
  assert.equal(refused.reason, 'unreadable');
  assert.equal(store.exportText(), before);
});

test('a quota error on write returns {ok:false, reason:"quota"}; read stays unchanged', () => {
  const { storage } = quotaStorage();
  const store = createSavedPlacesStore({ storage });
  const before = store.read();
  assert.deepEqual(store.add(VALID_PLACE), { ok: false, reason: 'quota' });
  assert.deepEqual(store.read(), before);
});

test('blocked storage (the probe throws) reports unavailable; no method throws', () => {
  const throwing = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
  };
  const store = createSavedPlacesStore({ storage: throwing });
  assert.deepEqual(store.read(), { state: 'unavailable' });
  assert.doesNotThrow(() => store.add(VALID_PLACE));
  assert.doesNotThrow(() => store.remove('gnis:1'));
  assert.doesNotThrow(() => store.importText(JSON.stringify(envelope([VALID_PLACE]))));
  assert.doesNotThrow(() => store.exportText());
  assert.doesNotThrow(() => store.clear());
  assert.doesNotThrow(() => store.restore('{}'));
});

test('makeSavedPlace rejects a bad ref, a non-numeric gnis id, or out-of-range/missing coordinates', () => {
  assert.equal(makeSavedPlace({ ...VALID_PLACE, ref: undefined }), null);
  assert.equal(makeSavedPlace({ ...VALID_PLACE, ref: 'point:1,2' }), null);
  assert.equal(makeSavedPlace({ ...VALID_PLACE, ref: 'gnis:abc' }), null);
  assert.equal(makeSavedPlace({ ...VALID_PLACE, lat: 91 }), null);
  assert.equal(makeSavedPlace({ ...VALID_PLACE, lon: NaN }), null);
  assert.equal(makeSavedPlace({ ...VALID_PLACE, lat: null }), null);
  // a valid record still builds
  assert.notEqual(makeSavedPlace(VALID_PLACE), null);
});

test('add refuses full-list at MAX_PLACES; a duplicate ref refuses already', () => {
  const full = Array.from({ length: MAX_PLACES }, (_, i) => makeSavedPlace({ ...VALID_PLACE, ref: `gnis:${i}` }));
  const raw = JSON.stringify(envelope(full));
  const { storage } = fakeStorage(raw);
  const store = createSavedPlacesStore({ storage });
  assert.equal(store.add({ ...VALID_PLACE, ref: 'gnis:999999' }).reason, 'full-list');
  assert.equal(store.add({ ...VALID_PLACE, ref: 'gnis:0' }).reason, 'already');
});

test('clear returns the raw text; restore writes only when the key is still absent', () => {
  const raw = JSON.stringify(envelope([VALID_PLACE]));
  const { storage, backing } = fakeStorage(raw);
  const store = createSavedPlacesStore({ storage });

  const cleared = store.clear();
  assert.equal(cleared, raw);
  assert.equal(backing.has(SAVED_PLACES_KEY), false);
  assert.equal(store.restore(cleared), true);
  assert.equal(backing.get(SAVED_PLACES_KEY), raw);

  store.clear();
  store.add({ ...VALID_PLACE, ref: 'gnis:999999' });
  const afterAdd = backing.get(SAVED_PLACES_KEY);
  assert.equal(store.restore(raw), false);
  assert.equal(backing.get(SAVED_PLACES_KEY), afterAdd);
});

test('keys and legacy links: distinct key, resetView leaves it intact, no reverse imports, formatFragment unaffected', () => {
  assert.notEqual(SAVED_PLACES_KEY, PREFS_KEY);

  const backing = new Map();
  backing.set(SAVED_PLACES_KEY, JSON.stringify(envelope([VALID_PLACE])));
  const sharedStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, v),
    removeItem: (k) => backing.delete(k),
  };
  const prefsStore = createPrefsStore(PREFS_KEY, sharedStorage);
  prefsStore.save({ base: 'usgsTopo' });
  const before = backing.get(SAVED_PLACES_KEY);
  resetView({ defaultView: { ...DEFAULT_VIEW }, prefsStore });
  assert.equal(backing.get(SAVED_PLACES_KEY), before);

  for (const rel of ['view-state.js', 'sheet-plan.js', 'project-store.js', 'view-wiring.js']) {
    const src = readFileSync(path.join(QCM_DIR, rel), 'utf8');
    assert.equal(/saved-places(\.js)?['"]/.test(src), false, `${rel} must not import saved-places.js`);
  }

  const view = { ...DEFAULT_VIEW };
  const withoutSaved = formatFragment(view, { includeLocation: false });
  createSavedPlacesStore({ storage: fakeStorage(JSON.stringify(envelope([
    VALID_PLACE, { ...VALID_PLACE, ref: 'gnis:x2' }, { ...VALID_PLACE, ref: 'gnis:x3' },
  ]))).storage });
  const withSaved = formatFragment(view, { includeLocation: false });
  assert.deepEqual(withSaved, withoutSaved);
});

test('status copy never implies a safety/hazard verdict', () => {
  const scan = /\b(clear|safe|quiet|no hazard)\b/i;
  const strings = [
    STATUS_TEXT.unavailable,
    STATUS_TEXT.empty,
    STATUS_TEXT.ok(3, 0),
    STATUS_TEXT.ok(1, 2),
    STATUS_TEXT.newer,
    STATUS_TEXT.unreadable('the stored text is not valid JSON'),
  ];
  for (const s of strings) assert.equal(scan.test(s), false, s);
});

// --- QUX-09c: camera bookmarks -------------------------------------------------------------

test('a camera: ref with null lat/lon is accepted and stored with null coordinates (09c pin: green on first run, 09b already allows it)', () => {
  const { storage, backing } = fakeStorage();
  const store = createSavedPlacesStore({ storage });
  const result = store.add({ ref: 'camera:nps-grsm:kuwohi', name: 'Kuwohi', kind: 'camera', lat: null, lon: null, state: null, county: null });
  assert.equal(result.ok, true);
  const stored = JSON.parse(backing.get(SAVED_PLACES_KEY));
  assert.equal(stored.places.length, 1);
  assert.equal(stored.places[0].lat, null);
  assert.equal(stored.places[0].lon, null);
  assert.equal(stored.places[0].kind, 'camera');
});

test('a camera record passed with a media object is stored without media, still or stream (09c pin: green on first run, the record shape is closed)', () => {
  const { storage, backing } = fakeStorage();
  const store = createSavedPlacesStore({ storage });
  store.add({
    ref: 'camera:caltrans-cwwp2:1', name: 'US-101 : North Main Street', kind: 'camera', lat: 36.687188, lon: -121.653231,
    state: null, county: null,
    media: { still: 'https://cwwp2.dot.ca.gov/data/d5/cctv/image/1/1.jpg', stream: 'https://wzmedia.dot.ca.gov/D5/1.stream/playlist.m3u8' },
  });
  const text = backing.get(SAVED_PLACES_KEY);
  const [place] = JSON.parse(text).places;
  assert.deepEqual(Object.keys(place).sort(), ['county', 'kind', 'lat', 'lon', 'name', 'ref', 'savedAt', 'state']);
  assert.doesNotMatch(text, /media|still|stream|https?:/i, 'no picture or stream address may reach storage');
});

test('a gnis: ref with null coordinates is still rejected (the null path is camera-only)', () => {
  assert.equal(makeSavedPlace({ ref: 'gnis:100001', name: 'Test Peak', kind: 'summit', lat: null, lon: null }), null);
});

test('the panel words a camera row "Camera", never iconFor\'s "Other named feature"; an unlocated camera is flagged', () => {
  assert.equal(typeof PANEL.kindLabelFor, 'function', 'saved-places-panel.js must export kindLabelFor');
  assert.equal(PANEL.kindLabelFor({ kind: 'camera' }), 'Camera');
  assert.equal(PANEL.kindLabelFor({ kind: 'summit' }), 'Named summit');
  assert.equal(PANEL.isUnlocatedCamera({ kind: 'camera', lat: null, lon: null }), true);
  assert.equal(PANEL.isUnlocatedCamera({ kind: 'camera', lat: 36.6, lon: -121.6 }), false);
  assert.equal(PANEL.isUnlocatedCamera({ kind: 'summit', lat: 36.6, lon: -121.6 }), false);
  assert.equal(PANEL.CAMERA_NO_LOCATION, 'The operator publishes no location for this camera.');
});

test('neither the store nor the panel names a picture or stream field (nothing of a camera\'s media can be written)', () => {
  assert.doesNotMatch(SAVED_PLACES_SRC, /media/);
  assert.doesNotMatch(SAVED_PANEL_SRC, /media/);
});

test('a snapshot camera ref (provider:district:index) is accepted; a ref with more parts is not', () => {
  const { storage } = fakeStorage();
  const store = createSavedPlacesStore({ storage });
  const row = (ref) => ({ ref, name: 'US-101', kind: 'camera', lat: 36.68, lon: -121.65, state: null, county: null });
  assert.equal(store.add(row('camera:caltrans-cwwp2:d05:1')).ok, true);
  assert.equal(store.add(row('camera:caltrans-cwwp2:d05:1:x')).ok, false);
});

test('exportGpx writes a GPX 1.1 document with one wpt per place, 5-decimal coordinates and escaped text', () => {
  const tricky = makeSavedPlace({ ref: 'gnis:100002', name: `Bob's "Peak" <&> Gap`, kind: 'summit', lat: 35.123456789, lon: -83.2, state: 'NC', county: 'Test County' });
  const gpx = exportGpx([makeSavedPlace(VALID_PLACE), tricky]);
  assert.match(gpx, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(gpx, /<gpx version="1\.1" creator="Quiet Corners" xmlns="http:\/\/www\.topografix\.com\/GPX\/1\/1">/);
  assert.match(gpx, /<\/gpx>\s*$/);
  assert.equal((gpx.match(/<wpt /g) || []).length, 2);
  assert.equal((gpx.match(/<\/wpt>/g) || []).length, 2);
  assert.match(gpx, /<wpt lat="35\.60000" lon="-83\.20000">/);
  assert.match(gpx, /<wpt lat="35\.12346" lon="-83\.20000">/);
  assert.ok(gpx.includes('<name>Bob&apos;s &quot;Peak&quot; &lt;&amp;&gt; Gap</name>'), 'name is XML-escaped');
  assert.ok(!/<name>[^<]*[&"'>][^<]*<\/name>/.test(gpx.replace(/&(amp|lt|gt|quot|apos);/g, '')), 'no raw specials inside any name');
  assert.match(gpx, /<desc>summit/);
});

test('exportGpx skips and counts a place without finite coordinates', () => {
  const noCoords = makeSavedPlace({ ref: 'camera:p:1', name: 'Unlocated cam', kind: 'camera', lat: null, lon: null });
  assert.ok(noCoords, 'setup: an unlocated camera is a valid record');
  const result = buildGpx([makeSavedPlace(VALID_PLACE), noCoords]);
  assert.equal(result.skipped, 1);
  assert.equal((result.gpx.match(/<wpt /g) || []).length, 1);
  assert.ok(!result.gpx.includes('Unlocated cam'));
  assert.equal(exportGpx([]).includes('<wpt'), false);
});
