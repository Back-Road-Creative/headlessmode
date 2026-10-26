// QQA-03b in the real page: what the finder tells a reader who types a street address.
//
// Before: 'No town matching "1234 example rd, hamilton, mt 59840" is in this list.'
// -- a street address reported as a missing town -- and the Search button sent the
// address to the remote GNIS name search, which answered "No names matched": the same
// mistake in a second voice, with the address on the wire.
//
// QQA-03b: the box said plainly that street address lookup was not available and
// offered what works, and the address went nowhere.
//
// QQA-04b: there is a lookup now (finder-geocode-browser.test.mjs holds the stubbed
// answers). What is kept from QQA-03b is everything that was never about the missing
// lookup: typing sends nothing (the box says Search will), the address never goes to
// the GNIS name search, a name the place data holds wins over the address shape, and
// no outcome calls the address a missing town or swaps in a nearby one. Here the
// endpoint is NOT stubbed, so Search meets the site server's 404 -- the endpoint not
// deployed -- and must say lookup is unavailable and offer the alternatives.
//
// QQA-03c: the address shape is a guess, so it never outranks a name. A place name that
// merely looks like an address ("Lake Unit 4", "Springfield #2", or even "88 Quarry
// Lane" if the data holds it) is searched by name first, and the address message
// is only what a query gets when it is address-shaped AND nothing by that name was
// found. The proofs below add synthetic rows to the town export and answer the GNIS
// layer with a synthetic feature; nothing leaves the box.
//
// Fixtures are synthetic; the owner's real address never appears in the repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const GEONAMES_URL = 'carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer/5/query';

/** Counts every request the page makes to the GNIS layer and answers it with `gnisBody`
 *  (an empty result set unless a test says otherwise -- what the old code turned into
 *  "No names matched"). `extraTowns` are appended to the town export (candidates.json)
 *  as the page reads it, which is how a test puts a name in the place data without a
 *  second copy of a 1.8MB file. */
function counting(gnisBody, extraTowns) {
  return `(() => {
  window.__gnisCalls = 0;
  window.__geoCalls = 0;
  const extra = ${JSON.stringify(extraTowns)};
  window.__gnisBody = ${JSON.stringify(gnisBody)};
  const real = window.fetch.bind(window);
  window.fetch = function(input, init) {
    const url = String(input && input.url ? input.url : input);
    if (url.indexOf('/api/geocode') !== -1) window.__geoCalls++;
    if (url.indexOf(${JSON.stringify(GEONAMES_URL)}) !== -1) {
      window.__gnisCalls++;
      return Promise.resolve(new Response(JSON.stringify(window.__gnisBody), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    }
    if (extra.length && url.indexOf('candidates.json') !== -1) {
      return real(input, init).then((r) => r.json()).then((rows) => new Response(
        JSON.stringify(rows.concat(extra)), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return real(input, init);
  };
})()`;
}

async function withFinder(fn, { gnisBody = { features: [] }, extraTowns = [] } = {}) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', { viewport: { width: 1280, height: 900 }, args: ['--hide-scrollbars'] });
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: counting(gnisBody, extraTowns) });
    await page.navigate(`${site.origin}/quiet-corners/`);
    await readyDashboard(page, { ms: 60000 });
    return await fn(page);
  } finally { page.close(); await site.close(); }
}

/** Open the box, type, and read what the reader and a screen reader are given. */
const typeAndRead = (term, pressSearch, settle = false) => `(async () => {
  const toggle = document.querySelector('.qc-finder-toggle');
  if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
  const box = document.getElementById('qc-place-search');
  box.focus();
  box.value = ${JSON.stringify(term)};
  box.dispatchEvent(new Event('input', { bubbles: true }));
  ${pressSearch ? `document.getElementById('qc-name-search-btn').click();
  await new Promise((r) => setTimeout(r, 400));
  if (${JSON.stringify(settle)}) await qcWait('the lookup settled', () => {
    const n = document.getElementById('qc-name-note');
    return n && !n.hidden && n.textContent.trim() && !/looking up/i.test(n.textContent) ? n : null;
  });` : ''}
  const text = (id) => { const e = document.getElementById(id); return e && !e.hidden ? e.textContent.trim() : ''; };
  return {
    note: text('qc-finder-note'),
    nameNote: text('qc-name-note'),
    live: document.getElementById('qc-finder-status').textContent.trim(),
    options: [...document.querySelectorAll('#qc-place-results [role="option"]')].map((o) => o.textContent.trim()),
    gnisCalls: window.__gnisCalls,
    geoCalls: window.__geoCalls,
  };
})()`;

const ADDRESSES = [
  '1234 Example Rd, Hamilton, MT 59840',
  '12 Main St Apt 4',
  '59840',
  'N1234 County Road B, Example, WI',
  '123 Highway 64, Example, NC',
];

// What a reader may be told about an address: it cannot be looked up yet. Never that
// a town, a name or a list entry is missing.
const FALSE_CLAIM = /no town|is in this list|matching|no names|not found|no results/i;

for (const address of ADDRESSES) {
  test(`typing ${JSON.stringify(address)} offers Search and sends nothing, and never says a town is missing`, { skip }, async () => {
    const seen = await withFinder((p) => p.evaluate(typeAndRead(address, false)));
    assert.match(seen.note, /press search to look up this street address/i,
      `the finder said: ${JSON.stringify(seen.note)}`);
    assert.doesNotMatch(seen.note, FALSE_CLAIM, `an address was reported as a missing place: ${seen.note}`);
    assert.equal(seen.options.length, 0, `an address was answered with ${JSON.stringify(seen.options)} -- a nearby place stands in for the address`);
    assert.equal(seen.live, seen.note, 'a screen reader is told something other than what the page shows');
    assert.equal(seen.gnisCalls, 0, 'typing sent the address to the remote name search');
    assert.equal(seen.geoCalls, 0, 'typing sent the address to the address lookup');
  });

  test(`pressing Search on ${JSON.stringify(address)} asks the address lookup, not the name search, and an outage is not a missing name`, { skip }, async () => {
    const seen = await withFinder((p) => p.evaluate(typeAndRead(address, true, true)));
    assert.equal(seen.gnisCalls, 0, 'the Search button sent a street address to the remote GNIS name search');
    assert.equal(seen.geoCalls, 1, 'Search did not ask the address lookup exactly once');
    assert.doesNotMatch(seen.nameNote, FALSE_CLAIM, `Search answered an address with: ${JSON.stringify(seen.nameNote)}`);
    assert.doesNotMatch(seen.live, /no names|not found|no results|matching/i, `the live region said: ${seen.live}`);
    assert.match(seen.nameNote, /address lookup is unavailable right now/i,
      `with no endpoint, Search said: ${JSON.stringify(seen.nameNote)}`);
    assert.match(seen.nameNote, /coordinates \(latitude, longitude\)/i, 'it should offer coordinates');
    assert.match(seen.nameNote, /town or named place/i, 'it should offer a town or named place');
    assert.equal(seen.options.length, 0);
  });
}

test('a town, "Town, ST" and a coordinate pair keep their behaviour', { skip }, async () => {
  await withFinder(async (p) => {
    for (const term of ['Amery', 'Amery, WI']) {
      const seen = await p.evaluate(typeAndRead(term, false));
      assert.ok(seen.options.length >= 1 && /Amery/i.test(seen.options[0]), `${term}: ${JSON.stringify(seen)}`);
      assert.equal(seen.note, '', `${term} got a note: ${seen.note}`);
    }
    const coord = await p.evaluate(typeAndRead('45.3046, -92.3634', false));
    assert.equal(coord.options.length, 1);
    assert.match(coord.options[0], /45\.3046, -92\.3634/);
    assert.equal(coord.note, '');
  });
});

test('Search on coordinates keeps the local answer without a false name-search failure', { skip }, async () => {
  await withFinder(async (p) => {
    const seen = await p.evaluate(typeAndRead('45.3046, -92.3634', true));
    assert.equal(seen.gnisCalls, 0, 'coordinates must never go to the name service');
    assert.equal(seen.geoCalls, 0, 'coordinates need no address lookup');
    assert.equal(seen.nameNote, '');
    assert.equal(seen.options.length, 1);
    assert.match(seen.options[0], /45\.3046, -92\.3634/);
    await p.evaluate(`document.querySelector('#qc-place-results [role="option"]').click()`);
    const center = await p.evaluate('window.qcMap.getCenter()');
    assert.ok(Math.abs(center.lat - 45.3046) < 0.01 && Math.abs(center.lng + 92.3634) < 0.01);
  });
});

test('names that start with digits but are not addresses keep the town-miss wording', { skip }, async () => {
  await withFinder(async (p) => {
    for (const term of ['29 Palms, CA', '7 Mile']) {
      const seen = await p.evaluate(typeAndRead(term, false));
      assert.doesNotMatch(seen.note, /street address/i, `${term} was read as an address: ${seen.note}`);
      assert.ok(seen.options.length > 0 || /^No town (named|matching) /.test(seen.note),
        `${term} neither found a place nor kept the town-miss wording: ${JSON.stringify(seen)}`);
    }
  });
});

test('a real named-place search still goes out when Search is pressed', { skip }, async () => {
  const seen = await withFinder((p) => p.evaluate(typeAndRead('Cold Mountain', true)));
  assert.equal(seen.gnisCalls, 1, 'the explicit Search on a name no longer reaches the GNIS service');
});

// --- QQA-03c: a name that looks like an address is still searched by name ----------

/** A town-export row, invented. Coordinates are the middle of Polk County, Wisconsin
 *  (the county the Amery proofs already use), not any private address. */
const town = (name) => ({
  fips: '9900000', name, state: 'WI', county_fips: '55095', population: 1200,
  lat: 45.3, lon: -92.36, county_name: 'Polk County', stability_score: 80,
  distance_to_metro_mi: 50, nearest_metro: 'Example city', sprawl_risk: 40,
  affordability_score: 80, quietness_score: 70, overall_score: 75,
});

/** One GNIS feature, in the service's own shape, with an invented name. */
const gnis = (name) => ({ features: [{
  attributes: { gaz_id: 9900001, gaz_name: name, gaz_featureclass: 'Populated Place', state_alpha: 'WI', county_name: 'Polk' },
  geometry: { points: [[-92.36, 45.3]] },
}] });

// One page per proof: on a loaded box each launch costs ~20 s and this file runs under
// CI's 600 s per-file cap, so the cases share a page and read the GNIS call count as a
// difference. `window.__gnisBody` is what the stubbed GNIS layer answers with next.
const setGnis = (body) => `(window.__gnisBody = ${JSON.stringify(body)}, true)`;
const calls = (p) => p.evaluate('window.__gnisCalls');

test('place names that look like addresses are listed and searched by name, never called addresses', { skip }, async () => {
  const names = ['Lake Unit 4', 'Springfield #2'];
  await withFinder(async (p) => {
    for (const name of names) {
      const c0 = await calls(p);
      const typed = await p.evaluate(typeAndRead(name, false));
      assert.equal(typed.options.length, 1, `${name}: the name was not offered: ${JSON.stringify(typed)}`);
      assert.ok(typed.options[0].includes(name), typed.options[0]);
      assert.doesNotMatch(`${typed.note} ${typed.live}`, /street address/i, `${name} was read as an address: ${typed.note}`);
      assert.equal(typed.gnisCalls, c0, 'typing sent a request');

      // Search: the name goes to the name search, and its result is offered.
      await p.evaluate(setGnis(gnis(name)));
      const before = await calls(p);
      const pressed = await p.evaluate(typeAndRead(name, true));
      assert.equal(await calls(p) - before, 1, `${name}: the name search never went out for a name that only looks like an address`);
      assert.ok(pressed.options.some((o) => o.includes(name)), `${name}: no name result: ${JSON.stringify(pressed)}`);
      assert.doesNotMatch(`${pressed.note} ${pressed.nameNote} ${pressed.live}`, /street address|not sent/i,
        `${name}: the address message appeared beside a name result: ${JSON.stringify(pressed)}`);
      assert.match(pressed.nameNote, /^1 names$/, pressed.nameNote);
    }
    // A look-alike with no such name anywhere is a missing NAME, not an address.
    for (const name of ['Lake Unit 9', 'Springfield #9']) {
      await p.evaluate(setGnis({ features: [] }));
      const before = await calls(p);
      const seen = await p.evaluate(typeAndRead(name, true));
      assert.equal(await calls(p) - before, 1, `${name}: Search did not reach the name search`);
      assert.match(seen.nameNote, /no names matched/i, seen.nameNote);
      assert.doesNotMatch(`${seen.note} ${seen.nameNote} ${seen.live}`, /street address|not sent/i,
        `${name} was reported as an address: ${JSON.stringify(seen)}`);
    }
  }, { extraTowns: names.map(town) });
});

test('a name that is address-shaped but IS in the place data wins over the address message', { skip }, async () => {
  const name = '88 Quarry Lane';
  await withFinder(async (p) => {
    const typed = await p.evaluate(typeAndRead(name, false));
    assert.equal(typed.options.length, 1, `the data holds this name and the finder did not offer it: ${JSON.stringify(typed)}`);
    assert.ok(typed.options[0].includes(name), typed.options[0]);
    assert.equal(typed.note, '', `a found name still carried a note: ${typed.note}`);
    const pressed = await p.evaluate(typeAndRead(name, true));
    assert.ok(pressed.options.some((o) => o.includes(name)), `Search hid the found name: ${JSON.stringify(pressed)}`);
    assert.doesNotMatch(`${pressed.note} ${pressed.nameNote} ${pressed.live}`, /street address|not sent/i,
      `Search said the name was an address: ${JSON.stringify(pressed)}`);
    assert.equal(await calls(p), 0, 'an address-shaped query that the town list answers was still sent away');
    assert.equal(await p.evaluate('window.__geoCalls'), 0, 'a name the town list answers was still sent to the address lookup');
  }, { extraTowns: [town(name)] });
});

test('an address with no name match is looked up on Search only, and never goes to the name search', { skip }, async () => {
  const addresses = ['45 Oak Avenue, Sylva NC', '1600 Pennsylvania Ave NW', '123 Main St', '88 Quarry Lane'];
  await withFinder(async (p) => {
    for (const address of addresses) {
      const before = await p.evaluate('window.__geoCalls');
      const typed = await p.evaluate(typeAndRead(address, false));
      assert.match(typed.note, /press search to look up this street address/i, `${address}: ${JSON.stringify(typed)}`);
      assert.equal(typed.options.length, 0, `${address}: ${JSON.stringify(typed.options)}`);
      assert.equal(typed.live, typed.note);
      assert.equal(typed.geoCalls, before, `${address}: typing sent it`);
      const pressed = await p.evaluate(typeAndRead(address, true, true));
      assert.equal(pressed.geoCalls, before + 1, `${address}: Search did not look it up once`);
      assert.match(pressed.nameNote, /address lookup is unavailable right now/i, `${address}: ${JSON.stringify(pressed)}`);
    }
    assert.equal(await calls(p), 0, 'Search sent a street address to the remote name search');
  });
});
