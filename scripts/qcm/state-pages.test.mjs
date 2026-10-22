// One map, and the CSP that lets it reach every state's land services.
//
// This file used to assert 52 pages -- a federal one plus one per state -- because
// a CSP naming every state origin measured 2,087 characters against Cloudflare's
// 2,000-per-line cap. That measurement counted PARCELS, which are not a default
// family, and wrote every origin with a redundant scheme. Bare host-sources cost
// 456 characters less, so the split was never necessary and the pages are gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  MAPS_BASE, DASHBOARD_PATH, DEFAULT_FAMILIES, stateOrigins, stateFamilies, statesWithLayers, mapRulePaths,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/state-pages.js';
import { STATE_CODES, LAYER_IDS, layerFor, isBrowserFetchable, outFieldsFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/state-sources.js';

test('one rule, for the one page that fetches', () => {
  // The methodology page is documentation and fetches nothing, so it gets no rule
  // and must not: a page that cannot reach a map service does not need permission
  // to, and a rule for it would be a standing invitation to put a map back on it.
  assert.deepEqual(mapRulePaths(), [DASHBOARD_PATH]);
  assert.ok(!mapRulePaths().includes(MAPS_BASE), 'the methodology page has no map to secure');
  for (const path of mapRulePaths()) assert.ok(!/\/maps\//.test(path), `${path} is a builder-page rule`);
  // A trailing slash matters: Cloudflare 308-redirects the index.html form to the
  // directory path, so one rule covers both. Without it the rule would miss and
  // the page would fall back to the global same-origin CSP and reach nothing.
  assert.match(DASHBOARD_PATH, /\/$/);
});

test('the origin list is every state’s, deduped and sorted', () => {
  const origins = stateOrigins();
  assert.deepEqual(origins, [...new Set(origins)].sort(), 'origins must be deduped and sorted');
  for (const o of origins) assert.match(o, /^https:\/\//, `${o} is not https`);

  // Derived, never hand-listed: every fetchable entry's origin must be present.
  const expected = new Set();
  for (const code of STATE_CODES) {
    for (const family of DEFAULT_FAMILIES) {
      const layer = layerFor(code, family);
      if (isBrowserFetchable(layer) && layer.url) expected.add(new URL(layer.url).origin);
    }
  }
  assert.deepEqual(origins, [...expected].sort(), 'a state the catalogue can fetch is missing from the CSP');
});

test('the CSP the one page needs names the parcel origins', async () => {
  const { cspValue } = await import('./gen-headers.mjs');
  const value = cspValue(stateOrigins());
  // The page's policy is a <meta> (csp-meta.test.mjs), so the _headers 2,000-character
  // line cap no longer binds it; this used to assert `< 2000`.
  assert.ok(value.length > 1000, `${value.length} chars: the state origins were dropped`);
  // Parcels used to be the thing that did NOT fit -- 2,087 characters, and that
  // measurement is what made them "a transport question needing a Pages Function".
  // It counted a redundant `https://` on all 57 origins. Bare host-sources enforce
  // the same policy 456 characters cheaper, so the transport blocker is simply gone
  // and parcels are now IN the default set the number above measures.
  const parcelOrigins = new Set();
  for (const code of STATE_CODES) {
    const layer = layerFor(code, 'parcels');
    if (isBrowserFetchable(layer) && layer.url) parcelOrigins.add(new URL(layer.url).origin);
  }
  assert.ok(parcelOrigins.size >= 9, `only ${parcelOrigins.size} parcel origins — the catalogue shrank`);
  for (const o of parcelOrigins) {
    assert.ok(stateOrigins().includes(o), `${o} serves parcels and the page may not reach it`);
  }
});

test('parcels are a default family, and every one of them has had its VALUES audited', () => {
  // They were held back for two reasons, both now answered: the CSP could not name
  // their origins (fixed by bare host-sources), and the family is the one that can
  // carry owner names (fixed by the refuse-list plus a per-state values audit --
  // North Dakota's `Ownership` was declared a nine-value domain and held people).
  assert.ok(DEFAULT_FAMILIES.includes('parcels'));
  assert.ok(LAYER_IDS.includes('parcels'));
  for (const code of STATE_CODES) {
    const layer = layerFor(code, 'parcels');
    if (!isBrowserFetchable(layer)) continue;
    assert.match(layer.valuesAuditedOn || '', /^\d{4}-\d{2}-\d{2}$/,
      `${code} offers parcels with no values audit — run scripts/qcm/audit-parcel-values.mjs`);
    for (const f of outFieldsFor(layer)) {
      assert.ok(!(layer.ownerFields || []).includes(f), `${code} would request the refused field ${f}`);
    }
  }
});

test('a state only claims a family its catalogue entry can actually be fetched from', () => {
  for (const code of STATE_CODES) {
    for (const family of stateFamilies(code)) {
      const layer = layerFor(code, family);
      assert.equal(layer.status, 'live', `${code}/${family} is not live`);
      assert.ok(['star', 'reflects'].includes(layer.cors), `${code}/${family} CORS is ${layer.cors}`);
    }
  }
});

test('an unknown state code yields nothing rather than throwing', () => {
  assert.deepEqual(stateFamilies('ZZ'), []);
});

test('the coverage list names the states whose land this map can draw', () => {
  const covered = statesWithLayers();
  assert.ok(covered.length > 40, `only ${covered.length} states have a usable layer`);
  assert.ok(covered.length <= STATE_CODES.length);
  for (const code of covered) assert.ok(stateFamilies(code).length, `${code} is listed with no family`);
  // A state with nothing usable is absent from the list and still gets the map:
  // the federal layers work everywhere.
  for (const code of STATE_CODES) {
    if (!stateFamilies(code).length) assert.ok(!covered.includes(code), `${code} claims coverage it has none of`);
  }
});

// CI runs the Hugo build before this suite, so public/ is the real output. Skipped
// locally, where a build may not exist.
test('the page the CSP rule covers was actually built', { skip: !existsSync(new URL('../../public/index.html', import.meta.url)) }, () => {
  for (const path of mapRulePaths()) {
    const built = new URL(`../../public${path}index.html`, import.meta.url);
    assert.ok(existsSync(built), `${path} has a CSP rule but no page — the rule points at a 404`);
  }
});

// Asserted on the SOURCE, not on public/: a stale local build directory is a
// known local artifact (Hugo's static copy aborts with `chtimes public:
// operation not permitted` when public/ is owned by the other user), and a stale
// directory is not the danger. The danger is a page with no CSP rule, and the
// only thing that could generate 51 of them was this adapter.
test('nothing generates a page per state any more', () => {
  assert.ok(!existsSync(new URL('../../content/qcm-states/_content.gotmpl', import.meta.url)),
    'the per-state content adapter is back; every page it emits has no CSP rule');
  assert.ok(!existsSync(new URL('../../content/qcm-states', import.meta.url)),
    'the qcm-states section is back');
});
