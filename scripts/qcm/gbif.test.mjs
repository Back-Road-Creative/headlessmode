// GBIF wildlife observations, against the bytes api.gbif.org actually returned. No network.
//
// The gate that matters here is a PRECISION gate. `coordinateUncertaintyInMeters` was absent
// on 97% of the records in the dense probe cell (4,043 of 133,925), so a dot on the map is a
// claim GBIF cannot back for all but a twentieth of what it holds. This layer therefore
// colours a cell and draws no per-record point, ever -- and the tests below are what stop a
// later "improvement" putting one back.
//
// The second gate is a CLAIM gate. A cell count is a count of RECORDS somebody submitted, it
// over-counts where two publishers republish one sighting, and an empty cell is "nobody wrote
// anything down here", never "no animals". Every reader-facing string is built in the module
// so this file can scan the lot.
//
// Fixtures: fetched 2026-09-15 with `Origin: https://headlessmode.com` and no credential.
// `aggregate` is the Great Smoky Mountains cell (35.55,35.65 x -83.90,-83.75), 3,505 bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SOURCES, cspDirectivesFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import {
  SERVICE, DATASET_SERVICE, CREDIT, LICENCE_WHITELIST, FACETS, MAX_UNCERTAINTY_METRES,
  dateWindow, aggregateQueryFor, aggregateQueryUrl, generalizedQueryFor, unfilteredQueryFor,
  readAggregate, datasetUrl, readDatasetCredit, creditLines, licenceGapText, generalizedText,
  quietText, failedText, notSearchedText, areaReport, readerStrings, fetchJson,
  LAYER_LABEL, LAYER_CAVEAT, gbifLayer, gbifReader,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-gbif.js';
import { LAYER_BY_ID } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';

const MODULE = new URL('../../themes/headlessmode/static/js/quiet-corners-maps/source-gbif.js', import.meta.url);
// The module with its comment lines stripped. The comments NAME the traps (`offset`,
// `datasetName`, `issues`) on purpose, so a check that a trap is not reached has to read the
// code rather than the prose that explains why it is not.
const CODE = readFileSync(MODULE, 'utf8').split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n');
const FIX = JSON.parse(readFileSync(new URL('fixtures/gbif-occurrence-2026-09-15.min.json', import.meta.url), 'utf8'));
const CELL = { minLon: -83.90, minLat: 35.55, maxLon: -83.75, maxLat: 35.65 };
const OTHER = { minLon: -115.40, minLat: 39.30, maxLon: -115.25, maxLat: 39.40 };
const WINDOW = dateWindow(Date.UTC(2026, 8, 15));
const EBIRD = '4fa7b334-ce0d-4e88-aaae-2e0c138d049e';
const INAT = '50c9509d-22c7-4a22-a47d-8c48425ef4a7';
// The claims this layer exists to forbid: abundance, absence, and a present-tense sighting.
const ABUNDANCE = /\b(abundance|abundant|population|how many (animals|birds|individuals)|lives here|live here|density of (animals|wildlife))\b/i;
const ABSENCE = /\bno (animals|wildlife|birds|species) (here|in)\b|\bnothing lives\b|\bempty of (life|wildlife)\b/i;
const PRESENT_TENSE = /\byou will see\b|\bis here now\b|\bexpect to see\b/i;

test('the registry records what was measured, and the claim is observation rather than inventory', () => {
  const s = SOURCES.gbifOccurrence;
  assert.equal(s.serviceUrl, SERVICE);
  assert.equal(s.origin, 'https://api.gbif.org');
  assert.equal(s.limits.requiresKey, false, 'no account: the download API answers 403 without one');
  assert.deepEqual([s.kind, s.cors, s.dateBasis, s.measuredOn], ['feature-query', 'star', 'feature-field', '2026-09-15']);
  // `inventory` is the tempting wrong answer and it would license the exact inference this
  // layer forbids: an inventory's silence means "not on the list", GBIF's means "nobody
  // submitted a record". Each row is one observation event carrying its own eventDate.
  assert.equal(s.claim, 'observation');
  assert.match(s.coverageSemantics, /never evidence of abundance/i);
  assert.match(s.coverageSemantics, /no records in this selection/i);
  assert.match(s.coverageSemantics, /UPPER BOUND/, 'cross-publisher duplicates are unmeasured and cannot be deduped');
  const csp = cspDirectivesFor();
  assert.ok(csp['connect-src'].includes(s.origin), 'the app fetches this JSON, so connect-src carries its origin');
  // Both halves of the media/tile ban in one assertion. The v2 density tiles silently ignore
  // `license` -- an NC-only request returned a byte-identical tile -- and occurrence media are
  // licensed separately from the record that carries them (27 of 614 were NC). Nothing here is
  // painted, so widening img-src is how either would arrive.
  assert.ok(!csp['img-src'].includes(s.origin), 'no tile and no photo: img-src must not name this host');
  assert.equal(s.policy.mediaPolicy, 'none');
});

test('the licence whitelist is a closed enum, repeated on every query, and reaches the URL', () => {
  const s = SOURCES.gbifOccurrence;
  // Five values total (api.gbif.org/v1/enumeration/basic/License), so naming two is a
  // complete whitelist rather than a best-effort blocklist, and an unknown value is HTTP 400.
  assert.equal(s.policy.licenseEnum.length, 5);
  assert.deepEqual(LICENCE_WHITELIST, ['CC0_1_0', 'CC_BY_4_0']);
  assert.ok(s.policy.licenseEnum.includes('CC_BY_NC_4_0') && !LICENCE_WHITELIST.includes('CC_BY_NC_4_0'));
  for (const req of [aggregateQueryFor(CELL, WINDOW), generalizedQueryFor(CELL, WINDOW)]) {
    assert.deepEqual(req.params.license, LICENCE_WHITELIST, 'the licence filter is not optional on any query');
    assert.equal(req.params.limit, '0', 'a count, never a page of records');
    assert.equal(req.params.hasCoordinate, 'true');
    assert.equal(req.params.hasGeospatialIssue, 'false');
  }
  const url = aggregateQueryUrl(CELL, WINDOW);
  assert.ok(url.includes('license=CC0_1_0&license=CC_BY_4_0'), 'repeated, not comma-joined');
  assert.ok(url.startsWith(`${SERVICE}?`));
});

// registry.test.mjs:88 is an UNANCHORED /(key|token|apikey)=/i over every string in SOURCES,
// so GBIF's own `taxonKey=` / `datasetKey=` parameters read as a credential leak. The entry
// stores bare endpoints and the filters are assembled here, which is robust by construction:
// the registry cannot emit the offending string because it never holds one.
test('the registry stores bare endpoints, so no GBIF parameter reads as a credential', () => {
  const seen = [];
  const walk = (v) => {
    if (typeof v === 'string') seen.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(SOURCES.gbifOccurrence);
  assert.ok(seen.length > 10);
  for (const s of seen) assert.doesNotMatch(s, /(key|token|apikey)=/i, s);
  assert.ok(seen.some((s) => s === SERVICE) && seen.some((s) => s === DATASET_SERVICE));
  assert.equal(datasetUrl(EBIRD), `${DATASET_SERVICE}/${EBIRD}`, 'a path segment, never a query parameter');
});

test('one bounded question per cell: a count and five facets, never a page of records', () => {
  const req = aggregateQueryFor(CELL, WINDOW);
  assert.equal(req.url, SERVICE);
  assert.deepEqual(req.params.facet, FACETS);
  // scientificName, not speciesKey: the facet returns the NAME and needs no taxon lookup --
  // and `taxonKey=` would trip the credential regex above.
  assert.ok(FACETS.includes('scientificName') && !FACETS.includes('speciesKey'));
  assert.equal(req.params.decimalLatitude, '35.55,35.65');
  assert.equal(req.params.decimalLongitude, '-83.9,-83.75');
  assert.equal(req.params.eventDate, `${WINDOW.from},${WINDOW.to}`);
  assert.match(WINDOW.label, /^\d{4} to \d{4}$/);
  // 3,505 bytes for the whole card. One 300-record page of the same cell measured 2,206,314,
  // and a full export of it would be 447 requests and ~985 MB -- while the download API
  // answers 403 without an account. The aggregate is the design, not a first step toward one.
  assert.ok(!/limit=(?!0)\d/.test(aggregateQueryUrl(CELL, WINDOW)), 'limit must stay 0');
  assert.ok(!/\boffset\b/.test(CODE), 'paging records is disqualified: 100,001 offset cap, 403 downloads');
});

test('the aggregate is read as counts and facets, and a bad body is nothing rather than a throw', () => {
  const agg = readAggregate(FIX.aggregate);
  assert.equal(agg.known, true);
  assert.equal(agg.count, 92291);
  assert.equal(agg.upperBound, true, 'cross-publisher duplicates are unmeasured; the count is a ceiling');
  assert.equal(agg.species[0].name, 'Corvus brachyrhynchos C.L.Brehm, 1822');
  assert.equal(agg.species.length, 25);
  assert.equal(agg.busiestMonth, 5, 'the seasonal facet the plan asks for');
  assert.equal(agg.latestYear, 2026);
  assert.equal(agg.earliestYear, 2015, 'inside the window that was asked for, and no wider');
  assert.deepEqual(agg.datasetKeys.slice(0, 2), [EBIRD, INAT]);
  const quiet = readAggregate(FIX.empty);
  assert.equal(quiet.known, true, 'count 0 is an ANSWER: the service replied and said none');
  assert.equal(quiet.count, 0);
  assert.deepEqual(quiet.species, []);
  for (const bad of [null, undefined, {}, { count: 'x' }, { error: 403 }]) {
    assert.equal(readAggregate(bad).known, false, `${JSON.stringify(bad)} is unknown, not a throw`);
  }
});

test('attribution is resolved from datasetKey, never from datasetName, and never restates the dataset licence as the records’', () => {
  const ebird = readDatasetCredit(FIX.datasets[EBIRD]);
  assert.equal(ebird.key, EBIRD);
  assert.equal(ebird.title, 'EOD – eBird Observation Dataset');
  assert.match(ebird.credit, /Cornell Lab of Ornithology/);
  assert.match(ebird.credit, /doi\.org\/10\.15468\/aomfnb/, 'GBIF interpolates the DOI and the access date itself');
  // datasetName is a trap: eBird sends none, so the facet covered 47 of 827 records (5.7%) in
  // the sparse cell while eBird held 709 of them. Credit from the key or not at all.
  assert.ok(!CODE.includes('datasetName'), 'the largest publisher is invisible to that facet');
  // The iNaturalist DATASET is CC BY-NC 4.0 and 2,417 of its records still passed the
  // record-level CC0/CC-BY filter. So the dataset's own licence is not the licence of what is
  // shown, and printing it beside these counts would be a false statement about them.
  assert.match(FIX.datasets[INAT].license, /by-nc/);
  for (const line of creditLines([FIX.datasets[EBIRD], FIX.datasets[INAT]])) {
    assert.doesNotMatch(line, /by-nc|noncommercial|non-commercial/i, 'a dataset licence is not the record licence');
  }
  assert.equal(creditLines([FIX.datasets[EBIRD], FIX.datasets[EBIRD]]).length, 1, 'one credit per dataset');
  assert.deepEqual(creditLines([null, {}, { citation: {} }]), [], 'a dataset that states no citation credits nobody');
});

test('nothing drawn is a point: one cell shaded, and no per-record mark exists to draw', () => {
  const drawn = [];
  const L = {
    layerGroup: () => ({ clearLayers() {}, addTo() { return this; } }),
    rectangle: (bounds, opts) => { drawn.push({ bounds, opts }); return { addTo() {} }; },
    // Present so a regression that reaches for them FAILS here rather than shipping.
    marker: () => assert.fail('a per-record point is a precision claim GBIF cannot back'),
    circleMarker: () => assert.fail('a per-record point is a precision claim GBIF cannot back'),
  };
  const layer = gbifLayer(L);
  layer.draw(readAggregate(FIX.aggregate), CELL);
  assert.equal(drawn.length, 1, 'the cell, and nothing inside it');
  assert.deepEqual(drawn[0].bounds, [[35.55, -83.9], [35.65, -83.75]]);
  assert.equal(drawn[0].opts.interactive, false);
  layer.draw(readAggregate(FIX.empty), CELL);
  assert.equal(drawn.length, 1, 'a cell nobody recorded in is not shaded: silence is not a value');
  layer.draw(readAggregate(FIX.aggregate), null);
  assert.equal(drawn.length, 1);
  assert.ok(!/\.marker\(|circleMarker|\.results\b/.test(CODE),
    'only 3.0% of records state any coordinate uncertainty at all, so no record is read');
});

test('the four missingness states are separately worded, and none of them is the others', () => {
  const win = WINDOW;
  const busy = areaReport({ aggregate: FIX.aggregate, unfiltered: FIX.unfiltered, generalized: FIX.generalized }, win);
  const quiet = areaReport({ aggregate: FIX.empty }, win);
  const failed = areaReport({ aggregate: null }, win);
  const idle = areaReport(undefined, win);
  assert.deepEqual([busy.state, quiet.state, failed.state, idle.state],
    ['records', 'quiet', 'failed', 'notSearched']);
  assert.equal(quiet.text, quietText(win));
  assert.equal(failed.text, failedText());
  assert.equal(idle.text, notSearchedText());
  assert.equal(new Set([busy.text, quiet.text, failed.text, idle.text]).size, 4);
  // A service that did not answer must never read as a place with nothing in it.
  assert.match(failedText(), /unavailable/i);
  assert.doesNotMatch(failedText(), /no records/i);
  assert.match(quietText(win), /no records in this selection/i);
  assert.match(quietText(win), new RegExp(win.label.replace(' to ', ' to ')), 'silence is scoped to the window asked for');
  assert.match(notSearchedText(), /not searched/i);
  assert.doesNotMatch(notSearchedText(), /\d/, 'a count before anything was asked is an invention');
});

test('a busy cell states the window, the ceiling, the season and the blurred records', () => {
  const win = WINDOW;
  const r = areaReport({ aggregate: FIX.aggregate, unfiltered: FIX.unfiltered, generalized: FIX.generalized }, win);
  assert.equal(r.count, 92291);
  assert.match(r.text, /92,291/, 'grouped, because six digits unspaced is unreadable');
  assert.match(r.text, /at most|upper bound/i, 'the count is a ceiling, not a number of animals');
  assert.ok(r.text.includes(win.label), 'a count with no date window invites the present tense');
  assert.match(r.text, /Corvus brachyrhynchos/, 'the name facet, so no taxon lookup is needed');
  assert.match(r.text, /May/, 'the seasonal facet');
  // 103,116 unfiltered against 92,291 filtered: 10,825 records here are not open-licensed.
  assert.match(licenceGapText(92291, 103116), /10,825/);
  assert.ok(r.text.includes(licenceGapText(92291, 103116)));
  assert.equal(licenceGapText(92291, 92291), '', 'nothing excluded says nothing');
  assert.equal(licenceGapText(92291, null), '', 'an unanswered comparison is not a zero');
  // The 70 generalized records: read off coordinateUncertaintyInMeters, NEVER off `issues`.
  assert.equal(MAX_UNCERTAINTY_METRES, 20000);
  assert.deepEqual(generalizedQueryFor(CELL, win).params.coordinateUncertaintyInMeters, '20000,10000000');
  assert.match(generalizedText(70), /70/);
  assert.match(generalizedText(70), /generali[sz]ed|widened/i);
  assert.equal(generalizedText(0), '', 'the sparse cell measured zero; zero says nothing');
  assert.ok(!/['"]issues['"]/.test(CODE),
    'all 20 withheld records carried the same issues array as ordinary ones: a 100% false-positive filter');
});

test('no string this layer can show a reader claims abundance, absence or a sighting today', () => {
  const strings = readerStrings({
    aggregate: FIX.aggregate, unfiltered: FIX.unfiltered, generalized: FIX.generalized,
    credits: [FIX.datasets[EBIRD], FIX.datasets[INAT]],
  }, WINDOW);
  assert.ok(strings.length >= 8);
  for (const s of [...strings, CREDIT, LAYER_LABEL, LAYER_CAVEAT]) {
    assert.doesNotMatch(s, ABUNDANCE, `a record is evidence somebody looked, never of how many are there: ${s}`);
    assert.doesNotMatch(s, ABSENCE, `an empty cell is nobody recording, never no animals: ${s}`);
    assert.doesNotMatch(s, PRESENT_TENSE, `a record from a past year is not a promise about today: ${s}`);
  }
  // And the module's own literals, backticks included -- a template literal reaches a reader
  // exactly as a quoted string does.
  for (const m of CODE.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)) {
    assert.doesNotMatch(m[2], ABUNDANCE, `literal claims abundance: ${m[2]}`);
    assert.doesNotMatch(m[2], PRESENT_TENSE, `literal promises a sighting: ${m[2]}`);
  }
  assert.match(LAYER_CAVEAT, /effort/i, 'two same-size cells measured 133,925 records and 827');
  assert.match(LAYER_CAVEAT, /no records in this selection/i);
});

test('the layer is a screen-only context surface, off until a reader asks for it', () => {
  const l = LAYER_BY_ID.gbifOccurrence;
  assert.equal(l.sourceId, 'gbifOccurrence');
  assert.equal(l.group, 'context');
  assert.equal(l.screenOnly, true, 'a live bounded query is no basis for a printed sheet');
  assert.equal(l.defaultOn, false, 'nothing is asked of GBIF for a reader who never asked');
  assert.equal(l.status, 'live');
  // NOT 'none'. Nothing back means nobody submitted a record, which is a statement about
  // recording effort and not about the ground -- exactly what `ambiguous` is for.
  assert.equal(l.emptyMeans, 'ambiguous');
  assert.equal(l.label, LAYER_LABEL);
  assert.equal(l.coverageCaveat, LAYER_CAVEAT);
});

test('the service is asked only when something asks, and a refusal loses nothing else', async () => {
  const calls = [];
  const ok = async (url) => { calls.push(url); return { ok: true, json: async () => FIX.aggregate }; };
  assert.equal(calls.length, 0, 'importing the module must not fetch');
  const got = await fetchJson(aggregateQueryUrl(CELL, WINDOW), { fetchImpl: ok });
  assert.deepEqual(calls, [aggregateQueryUrl(CELL, WINDOW)], 'the cell asked about, never the country');
  assert.equal(readAggregate(got).count, 92291);
  for (const impl of [
    async () => ({ ok: false, status: 403 }),
    async () => { throw new Error('offline'); },
    async () => ({ ok: true, json: async () => { throw new Error('x'); } }),
  ]) assert.equal(await fetchJson('https://api.gbif.org/v1/occurrence/search', { fetchImpl: impl }), null);
});

test('a pan is a new bounded question: debounced, and the answer about the view you left dropped', async () => {
  const q = [];
  const clock = {
    set(fn) { return q.push(fn); },
    clear(id) { if (id) q[id - 1] = null; },
    run() { for (let i = 0; i < q.length; i += 1) { const fn = q[i]; q[i] = null; if (fn) fn(); } },
  };
  const seen = [];
  const reader = gbifReader({
    fetchImpl: async (url, opts) => { seen.push({ url, signal: opts.signal }); return { ok: true, json: async () => FIX.aggregate }; },
    setTimer: clock.set, clearTimer: clock.clear,
  });
  const got = [];
  const first = reader.ask(CELL, WINDOW, (bodies) => got.push(readAggregate(bodies.aggregate).count));
  const second = reader.ask(OTHER, WINDOW, (bodies) => got.push(readAggregate(bodies.aggregate).count));
  clock.run(); await new Promise((r) => { setImmediate(r); });
  // Three counts for the cell, then one credit lookup per dataset the card named.
  const cells = seen.filter((s) => s.url.startsWith(`${SERVICE}?`));
  assert.equal(cells.length, 3, 'the card, the widened-record count, and the same cell unfiltered');
  assert.ok(cells.every((s) => s.url.includes('-115.4')), 'the view the reader ended on, not the one they left');
  assert.ok(!seen.some((s) => s.url.includes('-83.9')), 'the abandoned view must cost no request at all');
  assert.equal(await first, false, 'the superseded ask reports that it was dropped');
  assert.equal(await second, true);
  assert.deepEqual(got, [92291]);
  reader.cancel();
});

test('the app reads the switch by its registry id and asks again when the view moves', () => {
  const main = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
  assert.match(main, /layers\.gbifOccurrence/, 'the control has to be read by its registry id');
  assert.match(main, /qcm-layer-gbifOccurrence-report/, 'the row it writes into');
  assert.match(main, /map\.on\('moveend zoomend', renderWildlife\)/, 'a bbox query makes a pan a new question');
  assert.match(main, /const CONTEXT_RENDER = \{[^}]*gbifOccurrence/, 'the radio that switches it off must redraw it too');
  const off = main.slice(main.indexOf('async function renderWildlife'));
  assert.match(off.slice(0, off.indexOf('}\n\n')), /hidden = true/, 'switching off clears the row');
  // No SURFACE_TIME entry on purpose: a cell holds records from many days across the window,
  // so there is no single moment to caption, and the caption says the time is unknown rather
  // than borrowing the wall clock. The window itself is in the layer's own report row.
  assert.ok(!/gbifOccurrence: \(\) =>/.test(main), 'an aggregate over a window has no one observation moment');
});
