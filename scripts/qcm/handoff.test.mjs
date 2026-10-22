// The county finder -> Field Maps handoff, end to end against the real county data.
//
// Both ends now load ONE serializer. That is the point: before this the parser
// lived in app-state.js, which the dashboard could not reach, so the only way to
// emit a link was to hand-write the query string — and a hand-written one drifts
// from its parser in silence, landing the reader on a subtly wrong rectangle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serializeUrlRecipe, handoffHref, cleanLabel, clampMiles, WIDTH_MILES, LABEL_MAX }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/handoff.js';
import { parseUrlRecipe } from '../../themes/headlessmode/static/js/quiet-corners-maps/app-state.js';

const CANDIDATES = JSON.parse(readFileSync(new URL('../../static/data/quiet-corners/candidates.json', import.meta.url), 'utf8'));
const DASHBOARD = readFileSync(new URL('../../themes/headlessmode/layouts/_default/quiet-corners-dashboard.html', import.meta.url), 'utf8');
const inConus = (r) => r.lat > 24 && r.lat < 50 && r.lon > -125 && r.lon < -66;

test('the real county data carries everything the handoff needs', () => {
  assert.ok(CANDIDATES.length > 100, `only ${CANDIDATES.length} candidates`);
  for (const key of ['lat', 'lon', 'name', 'state']) {
    assert.ok(key in CANDIDATES[0], `candidates.json rows have no ${key}`);
  }
});

// The property that matters: what one end writes, the other end reads back to a
// box containing the point it was asked about.
test('every real candidate round-trips to a box containing its own coordinates', () => {
  const rows = CANDIDATES.filter(inConus);
  assert.ok(rows.length > 100, 'enough rows to be worth calling a sweep');
  for (const row of rows) {
    const parsed = parseUrlRecipe(serializeUrlRecipe({ lat: row.lat, lon: row.lon, label: row.name }));
    assert.ok(parsed, `${row.name}, ${row.state} produced a link the app rejects`);
    const b = parsed.bboxLonLat;
    // toFixed(4) rounds the coordinates, so allow that much slack and no more.
    const slack = 0.0001;
    assert.ok(row.lon >= b.minLon - slack && row.lon <= b.maxLon + slack, `${row.name}: lon outside its own box`);
    assert.ok(row.lat >= b.minLat - slack && row.lat <= b.maxLat + slack, `${row.name}: lat outside its own box`);
  }
});

// One map, one path, and that path is the map itself. This used to choose a
// per-state directory, because the CSP deciding which services a page could
// contact was bound to its path; then it pointed at the builder's own page. Both
// are gone -- the builder is a panel on /quiet-corners/ -- so no value of `state`
// may steer the URL, which is the property that stops a stale link pointing at a
// page that no longer builds anything.
test('a handoff always lands on the one map, whatever the row says its state is', () => {
  const base = '/quiet-corners/';
  assert.match(handoffHref({ lat: 35.03, lon: -83.53, state: 'NC', label: 'Wayah Bald' }), /^\/quiet-corners\/\?v=1&/);
  for (const any of ['NC', 'nc', undefined, '', 'XYZ', 'N', '../..', 'n/c']) {
    assert.equal(handoffHref({ lat: 35.03, lon: -83.53, state: any }).split('?')[0], base, `state ${JSON.stringify(any)}`);
  }
});

test('a real candidate row produces a link into the map, carrying its own area', () => {
  const row = CANDIDATES.filter(inConus).find((r) => /^[A-Za-z]{2}$/.test(String(r.state)));
  assert.ok(row, 'no candidate row carries a two-letter state');
  const href = handoffHref({ lat: row.lat, lon: row.lon, state: row.state, label: row.name });
  assert.equal(href.split('?')[0], '/quiet-corners/');
  const q = new URLSearchParams(href.split('?')[1]);
  assert.equal(Number(q.get('lat')), Number(row.lat.toFixed(4)));
  assert.equal(Number(q.get('lon')), Number(row.lon.toFixed(4)));
});

test('width is clamped on the way out, so no link can ask for an unprintable area', () => {
  assert.equal(new URLSearchParams(serializeUrlRecipe({ lat: 35, lon: -83, widthMiles: 500 })).get('w'), String(WIDTH_MILES.max));
  assert.equal(new URLSearchParams(serializeUrlRecipe({ lat: 35, lon: -83, widthMiles: 0.01 })).get('w'), String(WIDTH_MILES.min));
  assert.equal(clampMiles(8), 8);
});

test('a label is cleaned before it reaches a URL or a printed sheet header', () => {
  // The NUL and the newline are written as ESCAPES on purpose: a raw control
  // byte in source makes git treat the file as binary, so the diff becomes
  // unreviewable. This is exactly the class of character cleanLabel strips.
  assert.equal(cleanLabel(' Way\x00ah\n Bald '), 'Wayah Bald');
  assert.equal(cleanLabel('x'.repeat(200)).length, LABEL_MAX);
  assert.equal(cleanLabel(null), '');
  assert.ok(!new URLSearchParams(serializeUrlRecipe({ lat: 35, lon: -83, label: '   ' })).has('label'),
    'an empty label is omitted, not sent blank');
});

// Both ends must load the SAME file. A copy of the serializer on the dashboard
// side is the failure this whole change exists to prevent.
test('the dashboard is a module, so it can import the one serializer', () => {
  assert.match(DASHBOARD, /<script type="module"[^>]*quiet-corners\.js/,
    'a classic script cannot import, which forces a hand-written query string');
  assert.ok(!DASHBOARD.includes('js/quiet-corners.js" defer'), 'the classic-script form should be gone');
});
