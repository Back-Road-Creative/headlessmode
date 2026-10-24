// BLM recreation sites, offline against a verbatim 3-record capture taken 2026-09-11 (see
// the fixture's `_source`). Two measured facts get the hardest gates: description and
// directions are RAW PROVIDER HTML on a page we control, and the source's own night-sky
// language is 3 records in 1,304, so nothing may promise a sky.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { plainText, shorten, normalizeBlmSite, siteLines, fetchBlmRecSites, BLM_REC_SITES_SOURCE, readerStrings }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/source-blm-rec-sites.js';
import { LAYER_BY_ID } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';

const read = (rel) => readFileSync(new URL(`../../themes/headlessmode/static/js/quiet-corners-maps/${rel}`, import.meta.url), 'utf8');
const [MODULE, REGISTRY] = ['source-blm-rec-sites.js', 'layer-registry.js'].map(read);
const CAPTURE = JSON.parse(readFileSync(new URL('./fixtures/blm-rec-sites-2026-09-11.min.json', import.meta.url), 'utf8'));
const raw = (name) => CAPTURE.features.find((f) => f.attributes.RecAreaName === name);
const AFTON = raw('Afton Canyon');
test('the reducer cannot hand markup, a javascript: URL or a handler to the page', () => {
  const hostile = '<script>alert(1)</script><img src=x onerror=alert(1)>'
    + '<a href="javascript:alert(1)">tap</a><p>Camp&nbsp;here.</p>';
  const out = plainText(hostile);
  for (const bad of ['<', '>', 'javascript:', 'onerror', 'alert(1)']) {
    assert.ok(!out.includes(bad), `${JSON.stringify(bad)} survived into ${JSON.stringify(out)}`);
  }
  assert.match(out, /Camp here\./, 'the real sentence must survive the stripping');
  // An entity may never decode into a tag opener on a later pass.
  assert.ok(!plainText('&lt;script&gt;alert(1)&lt;/script&gt;').includes('<'));
  // The fixture's own non-breaking spaces, and its runs of whitespace.
  assert.ok(AFTON.attributes.RecAreaDescription.includes('\u00a0'), 'the fixture no longer carries a non-breaking space');
  const real = plainText(AFTON.attributes.RecAreaDescription);
  assert.ok(!/\u00a0/.test(real), 'a non-breaking space reached the reader');
  assert.ok(!/\s\s/.test(real), 'runs of whitespace were not collapsed');
  // Nothing this module exports is markup.
  for (const s of readerStrings()) assert.ok(!/[<>]/.test(s), `exported markup: ${JSON.stringify(s)}`);
});

test("the agency's own sentence survives being reduced", () => {
  const dirs = plainText(AFTON.attributes.RecAreaDirections);
  assert.ok(dirs.startsWith('From Barstow, take Interstate 15 east for 35 miles.'), dirs);
  assert.match(dirs, /graded dirt road/);
});

test('a shortened value ends on a sentence, says it was shortened, and links the full text', () => {
  const full = plainText(AFTON.attributes.RecAreaDescription);
  const cut = shorten(AFTON.attributes.RecAreaDescription);
  assert.equal(cut.shortened, true);
  assert.ok(full.startsWith(cut.text.replace(/\s*…$/, '')), 'the cut is not a prefix of the real text');
  assert.match(cut.text, /\.\s*…$/, 'a cut must land on the end of a sentence, never mid-word');
  const site = normalizeBlmSite(AFTON);
  const shown = siteLines(site).join('\n');
  assert.match(shown, /Shortened/, 'a shortened value must be visibly marked');
  assert.ok(shown.includes(site.url), 'the reader cannot reach the full text');
  assert.deepEqual(shorten('Short enough.'), { text: 'Short enough.', shortened: false });
});

test('attribution and vintage are per record, and a gap is said in words', () => {
  const site = normalizeBlmSite(AFTON);
  assert.equal(site.url, 'https://www.blm.gov/visit/search-details/1181/2');
  assert.equal(site.updated, '2026-07-06', 'the date is the source string, not a re-derived one');
  assert.match(siteLines(site).join('\n'), /BLM last updated this record 2026-07-06/);
  const stripped = { ...AFTON, attributes: { ...AFTON.attributes, BLMRecURL: '', LastUpdatedDate: '' } };
  const said = siteLines(normalizeBlmSite(stripped)).join('\n');
  assert.match(said, /does not say when BLM last updated it/);
  assert.match(said, /carries no BLM page link/);
  assert.equal(normalizeBlmSite({ attributes: { RecAreaName: 'x' }, geometry: { x: null, y: 35 } }), null);
});

// QUX-11b §2.6: the provider discriminator, so `state.recSites` entries from
// this layer can be told apart from the Forest Service's.
test('11b: normalizeBlmSite tags every site with provider "blm"', () => {
  const site = normalizeBlmSite(AFTON);
  assert.equal(site.provider, 'blm');
});

// The lines are carried ON the site, so the map shows them without importing this module
// and without a second copy of the wording. They shipped tested and unrendered.
test('a normalized site carries the lines a reader is shown', () => {
  const site = normalizeBlmSite(AFTON);
  assert.deepEqual(site.lines, siteLines(site), 'the carried lines must be the same lines');
  assert.ok(site.lines.some((l) => l.startsWith('Directions: From Barstow')), site.lines.join('\n'));
  assert.ok(site.lines.some((l) => l.includes(site.url)), 'the agency’s own page must be on the card');
  // A gap is a sentence, never a dropped row: "the inventory does not say" and "there is
  // nothing there" are different answers and a reader must be able to tell them apart.
  const bare = normalizeBlmSite({ ...AFTON, attributes: { RecAreaName: 'Afton Canyon' } });
  assert.deepEqual(bare.lines, ['Afton Canyon', 'Directions: the record does not say.',
    'About: the record does not say.',
    'The record does not say when BLM last updated it. The record carries no BLM page link.']);
});

// The plan's prohibition, gated rather than left to a comment: Black Marble measures
// radiance leaving the ground, the Bortle scale what an eye sees standing in it, and one
// is not a conversion of the other. Comments may name the prohibitions; STRINGS may not --
// backticks included, because a TEMPLATE-literal label is still read by a reader.
const FORBIDDEN = [
  /bortle/i, /sky[-\s]quality/i, /\bSQM\b/, /limiting magnitude/i,
  /mags?\s*(?:\/|per)\s*(?:square\s*)?arcsec/i, /\b[1-9]\s*(?:of|out of|\/|–|-)\s*9\b/,
  /(?:darkness|dark[-\s]sky)\s*(?:score|rating|class|index|level|grade)/i,
  /stargaz/i, /astronom/i, /dark[-\s]sk/i, /night[-\s]sk/i, /star part/i,
];
const literals = (src) => [...src.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)]
  .map((m) => m[1] ?? m[2] ?? m[3]);

test('no string a reader sees claims a darkness rating, or a sky at all', () => {
  const fromRecords = CAPTURE.features.flatMap((f) => siteLines(normalizeBlmSite(f)));
  for (const s of [...readerStrings(), ...fromRecords, ...literals(MODULE), ...literals(REGISTRY)]) {
    // QQA-18: the registry now names the layer panel's Night sky task group (the plan's own heading);
    // that exact heading is a place to find night lights and aurora, not a claim about a BLM site.
    if (s === 'Night sky') continue;
    for (const rx of FORBIDDEN) assert.ok(!rx.test(s), `${rx} matches a reader-facing string: ${JSON.stringify(s)}`);
  }
  const l = LAYER_BY_ID.blmRecSites;
  for (const text of [l.label, l.coverageCaveat, BLM_REC_SITES_SOURCE.coverageSemantics]) {
    assert.ok(readerStrings().includes(text), `shown to a reader, invisible to the gate: ${JSON.stringify(text)}`);
  }
});

test('the registry entry names the measured service, and the fetch asks for what it draws', async () => {
  const s = SOURCES.blmRecSites;
  assert.equal(s.origin, 'https://gis.blm.gov');
  assert.equal(s.kind, 'feature-query');
  assert.equal(s.limits.maxRecordCount, 2000);
  assert.equal(s.measuredOn, '2026-09-11');
  assert.equal(s.cors, 'reflects-origin', 'the header echoed the request Origin, measured on a real /query');
  assert.equal(LAYER_BY_ID.blmRecSites.sourceId, 'blmRecSites');
  // Both layers fill `state.recSites`; one switch alone would draw no BLM pins.
  const overlay = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
  assert.match(overlay, /if \(!on\.recSites && !on\.blmRecSites\) return;/,
    'the pin loop must run when either recreation layer is on');

  let body = null;
  const r = await fetchBlmRecSites({
    bboxLonLat: { minLon: -117, minLat: 34, maxLon: -116, maxLat: 35.5 },
    fetchImpl: async (_u, o) => { body = o.body.toString(); return { ok: true, json: async () => ({ features: CAPTURE.features }) }; },
  });
  assert.equal(r.sites.length, 3);
  assert.equal(r.coverage, 'complete');
  for (const f of ['RecAreaName', 'RecAreaDirections', 'LastUpdatedDate', 'BLMRecURL']) assert.ok(body.includes(f), f);
  assert.match(body, /outSR=4326/);
  await assert.rejects(fetchBlmRecSites({ bboxLonLat: { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 },
    fetchImpl: async () => ({ ok: false, status: 503 }) }), /answered 503/);
});
