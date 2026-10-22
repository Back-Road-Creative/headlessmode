// FEMA's National Flood Hazard Layer, against the bytes the service actually returned. No network.
//
// The gate that matters most here is a TENSE gate. Every other context surface on this page is
// about a moment -- radar saw this five minutes ago, the air was this category last hour. A
// flood zone is none of those: it is a modelled floodplain from an engineering study, adopted as
// regulation and drawn on a panel, and the one sentence it must never be allowed to make is
// "there is water here now". The second gate is a SENTINEL gate, and it is why this file exists
// rather than a smaller one: 154 of the 159 records measured carry `STATIC_BFE: -9999` and
// `DEPTH: -9999`, and all 14 panels carry `PRE_DATE: 9999-09-09`. Printed raw, those read as a
// base flood elevation of minus ten thousand feet and a map effective in the year 9999.
//
// Measured live 2026-09-15 from the dev container with `Origin: https://headlessmode.com`:
//   root  ?f=json -> 200, ArcGIS 11.1, spatialReference wkid 4269, maxRecordCount 2000,
//                   access-control-allow-origin echoed the Origin
//   28    La Farge WI envelope -90.70,43.55,-90.58,43.62 -> 159 features (returnCountOnly: 159)
//   3     same envelope -> 14 panels, TWO effective dates four years apart
//   0     same envelope -> 2 studies; interior Alaska -152.0,64.0,-151.8,64.2 -> zero, 174 bytes
//   28    same envelope WITH geometry and no maxAllowableOffset -> HTTP **200**, 80 bytes,
//         `{"error":{"code":500,...}}`; WITH maxAllowableOffset=0.0003 -> 200, 399,069 bytes
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SOURCES, cspDirectivesFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import {
  SERVICE, CREDIT, ZONE_MEANING, MAX_FEATURES_DRAWN, GENERALIZE_DEGREES, NO_VALUE, NULL_DATE_MS,
  coverageQueryFor, countQueryFor, zonesQueryFor, panelsQueryFor, queryUrl,
  readError, readCoverage, readZones, readCount, readPanels, fetchFloodView,
  zoneText, vintageText, quietText, areaReport, readerStrings,
  LAYER_LABEL, LAYER_CAVEAT, floodZonesLayer,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-flood-zones.js';
import { LAYER_BY_ID, CONTEXT_LAYER_IDS, surfaceCaption } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8'));
const ZONES = fixture('fema-nfhl-zones-la-farge-2026-09-15.min.json');
const PANELS = fixture('fema-nfhl-panels-la-farge-2026-09-15.min.json');
// Both small enough to keep as the bytes themselves. Layer 0 over La Farge, and over an
// interior-Alaska envelope where NFHL publishes nothing at all -- 174 bytes, HTTP 200.
const COVERED = { features: [{ attributes: { STUDY_ID: '55103C' } }, { attributes: { STUDY_ID: '55123C' } }] };
const NO_MAP = { displayFieldName: 'STUDY_ID', features: [] };
// The 200 that is a failure. `res.ok` is true on this and `features` is simply absent.
const ERROR_200 = { error: { code: 500, message: 'Error performing query operation', details: [] } };
const LA_FARGE = { minLon: -90.70, minLat: 43.55, maxLon: -90.58, maxLat: 43.62 };
// 2012-11-02 and 2016-12-08 as the service sends them, and FEMA's null-date sentinel.
const EFF_2012 = 1351814400000, EFF_2016 = 1481155200000;

// Language a modelled regulatory floodplain may never use about itself.
const PRESENT_TENSE = /\b(right now|currently|at the moment|is flooded|flooding now|under water|tonight)\b/i;
// The two sentinels, as a reader would see them if they ever reached a string.
const SENTINEL = /-9999|9999-09-09|year 9999|10,000|minus/i;

test('the registry entry records what the service was measured to be', () => {
  const s = SOURCES.femaNfhl;
  assert.equal(s.serviceUrl, SERVICE);
  assert.equal(CREDIT, s.attribution);
  assert.deepEqual([s.kind, s.cors, s.measuredOn], ['feature-query', 'reflects-origin', '2026-09-15']);
  assert.equal(s.limits.requiresKey, false);
  assert.equal(s.limits.maxRecordCount, 2000);
  // NAD83 geographic, not Web Mercator: every request has to name inSR and outSR or the
  // envelope is read in the wrong system and the answer is about somewhere else.
  assert.deepEqual(s.spatialReference, { wkid: 4269 });
  // A modelled surface adopted as regulation. NOT an observation: this is the field that
  // decides which time the page offers for it, and 'observation' would offer a moment.
  assert.equal(s.claim, 'model');
  assert.match(s.coverageSemantics, /REGULATORY MAP/);
  assert.match(s.coverageSemantics, /says nothing about where water is now/);
  // The three layers the surface cannot work without, each for a different question.
  assert.deepEqual(s.layers.map((l) => l.id), [0, 3, 28]);
  assert.deepEqual(s.layers.find((l) => l.id === 28).fields,
    ['FLD_ZONE', 'ZONE_SUBTY', 'SFHA_TF', 'STATIC_BFE', 'V_DATUM', 'DEPTH', 'LEN_UNIT', 'DFIRM_ID', 'SOURCE_CIT']);
  const csp = cspDirectivesFor();
  assert.ok(csp['connect-src'].includes(s.origin), 'the app fetches this JSON, so connect-src carries its origin');
  assert.ok(!csp['img-src'].includes(s.origin), 'nothing here is painted through an <img>');
});

test('every query names both spatial references, and the zone query cannot omit the generalization', () => {
  // The service is 4269. A request that does not say so is answered about the wrong ground.
  for (const req of [coverageQueryFor(LA_FARGE), countQueryFor(LA_FARGE), zonesQueryFor(LA_FARGE), panelsQueryFor(LA_FARGE)]) {
    assert.equal(req.params.geometry, '-90.7,43.55,-90.58,43.62');
    assert.equal(req.params.geometryType, 'esriGeometryEnvelope');
    assert.equal(req.params.inSR, '4326');
    assert.equal(req.params.outSR, '4326');
    assert.equal(req.params.f, 'json');
  }
  assert.ok(coverageQueryFor(LA_FARGE).url.endsWith('/0/query'), 'coverage is layer 0 and only layer 0 answers it');
  assert.ok(panelsQueryFor(LA_FARGE).url.endsWith('/3/query'), 'the vintage lives on the panels, not on the zone');
  assert.ok(countQueryFor(LA_FARGE).url.endsWith('/28/query'));
  assert.equal(countQueryFor(LA_FARGE).params.returnCountOnly, 'true');
  assert.equal(countQueryFor(LA_FARGE).params.returnGeometry, undefined, 'a count asks for no shapes');
  // THE gate, baked into the URL rather than left to a caller: the same 159 features
  // measured 200-with-a-500-inside without it, and 399,069 bytes with it.
  const zones = zonesQueryFor(LA_FARGE);
  assert.equal(zones.params.maxAllowableOffset, String(GENERALIZE_DEGREES));
  assert.equal(GENERALIZE_DEGREES, 0.0003);
  assert.equal(zones.params.returnGeometry, 'true');
  assert.equal(zones.params.outFields, 'FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE,V_DATUM,DEPTH,LEN_UNIT,DFIRM_ID,SOURCE_CIT');
  assert.match(queryUrl(zones), /maxAllowableOffset=0\.0003/);
  assert.ok(queryUrl(zones).startsWith(`${SERVICE}/28/query?`));
});

test('a 200 carrying an ArcGIS error is a failure, never an area with no flood zones', () => {
  // `res.ok` is true on this body. Nothing may read it as "nothing here".
  assert.equal(readError(ERROR_200), 'Error performing query operation');
  assert.equal(readError(ZONES), null);
  assert.equal(readError(null), null);
  assert.deepEqual(readZones(ERROR_200), []);
  assert.equal(readCount(ERROR_200), null, 'a count that failed is unknown, not zero');
  const failed = areaReport({ coverage: COVERED, count: ERROR_200 });
  assert.equal(failed.known, false);
  assert.match(failed.text, /could not be reached|did not answer/i);
  assert.doesNotMatch(failed.text, /no flood|not in a flood|outside/i,
    'a service that failed must never be reported as ground with no mapped hazard');
});

test('the zone census is read back exactly as the service published it', () => {
  const rows = readZones(ZONES);
  assert.equal(rows.length, 159);
  const census = {};
  for (const r of rows) census[`${r.zone}|${r.subtype ?? ''}`] = (census[`${r.zone}|${r.subtype ?? ''}`] || 0) + 1;
  assert.deepEqual(census, {
    'X|0.2 PCT ANNUAL CHANCE FLOOD HAZARD': 80,
    'AE|': 53,
    'X|AREA OF MINIMAL FLOOD HAZARD': 15,
    'A|': 8,
    'AE|FLOODWAY': 3,
  });
  // SFHA_TF is the string 'T'/'F', not a boolean. Read as truthiness, 'F' is true.
  assert.equal(rows.filter((r) => r.sfha).length, 64, 'AE, AE/FLOODWAY and A are the Special Flood Hazard Area');
  assert.equal(rows.filter((r) => r.sfha === false).length, 95, 'both X subtypes are outside it');
  assert.ok(rows.every((r) => r.zone in ZONE_MEANING), 'a zone with no published meaning would be drawn unlabelled');
});

test('the no-value sentinel never becomes a number a reader sees', () => {
  const rows = readZones(ZONES);
  assert.equal(NO_VALUE, -9999);
  // Measured: 154 of 159 carry -9999 in STATIC_BFE and all 159 carry it in DEPTH.
  assert.equal(rows.filter((r) => r.bfe === null).length, 154);
  assert.equal(rows.filter((r) => r.depth === null).length, 159);
  assert.ok(rows.every((r) => r.bfe !== NO_VALUE && r.depth !== NO_VALUE));
  // The five that carry a real one carry its datum with it -- unlike a USGS stage, this
  // elevation is self-describing, and it is printed only because it says what it is above.
  const withBfe = rows.filter((r) => r.bfe !== null);
  assert.equal(withBfe.length, 5);
  assert.deepEqual([...new Set(withBfe.map((r) => r.bfeDatum))], ['NAVD88']);
  assert.deepEqual([...new Set(withBfe.map((r) => r.lengthUnit))], ['Feet']);
  assert.deepEqual([...new Set(withBfe.map((r) => r.bfe))].sort((a, b) => a - b), [790, 791, 819]);
  for (const r of rows) assert.doesNotMatch(zoneText(r), SENTINEL, `${r.zone} leaked a sentinel`);
  assert.match(zoneText(withBfe[0]), new RegExp(`${withBfe[0].bfe} feet above NAVD88`));
  // A datum the record does not state means the number is not an elevation anyone can use.
  assert.equal(zoneText({ ...withBfe[0], bfeDatum: null }).includes(String(withBfe[0].bfe)), false,
    'an elevation with no stated datum is not an elevation');
});

test('an empty zone subtype arrives in three spellings and all three mean absent', () => {
  // null, a single space, and the literal string '<Null>' -- nationally, all three occur.
  for (const raw of [null, ' ', '<Null>', '']) {
    const [row] = readZones({ features: [{ attributes: { FLD_ZONE: 'X', ZONE_SUBTY: raw, SFHA_TF: 'F', STATIC_BFE: -9999, DEPTH: -9999 } }] });
    assert.equal(row.subtype, null, `ZONE_SUBTY ${JSON.stringify(raw)} is not a subtype`);
    assert.doesNotMatch(zoneText(row), /<Null>/);
  }
});

test('Zone X is never reported as safe, and its subtype is what says which X it is', () => {
  const rows = readZones(ZONES);
  const minimal = rows.find((r) => r.subtype === 'AREA OF MINIMAL FLOOD HAZARD');
  const pct02 = rows.find((r) => r.subtype === '0.2 PCT ANNUAL CHANCE FLOOD HAZARD');
  assert.match(pct02.text ?? zoneText(pct02), /0\.2/, 'the 0.2% area arrives as X and is not minimal hazard');
  for (const r of [minimal, pct02]) {
    const t = zoneText(r);
    assert.doesNotMatch(t, /\b(safe|no risk|will not flood|cannot flood|flood-free)\b/i);
    assert.ok(t.includes(r.subtype), 'an X without its subtype is the lie this field exists to stop');
  }
  // The meaning text for X says out loud that X is not one thing.
  assert.match(ZONE_MEANING.X, /ZONE_SUBTY/);
  assert.match(ZONE_MEANING.D, /UNDETERMINED|No flood-hazard analysis/i,
    'D is "nobody studied this", which is not the same as "no hazard"');
});

test('the vintage is per panel, stated as the range a view actually holds', () => {
  const panels = readPanels(PANELS);
  assert.equal(panels.length, 14);
  assert.equal(NULL_DATE_MS, 253392451200000);
  // Every one of the 14 carries FEMA's null-date sentinel in PRE_DATE. None reaches a row.
  assert.ok(panels.every((p) => p.preEffectiveMs === null), '9999-09-09 is a sentinel, not a date');
  assert.deepEqual([...new Set(panels.map((p) => p.effectiveMs))].sort(), [EFF_2012, EFF_2016]);
  const text = vintageText(panels);
  // FOUR YEARS APART IN ONE VIEW. A single "map effective date" caption would be false.
  assert.match(text, /2012-11-02/);
  assert.match(text, /2016-12-08/);
  assert.match(text, /panel/i, 'the reader has to be told the date belongs to a panel, not to the screen');
  assert.doesNotMatch(text, SENTINEL);
  // One panel is one date, and it still says which panel it belongs to.
  assert.match(vintageText(panels.filter((p) => p.effectiveMs === EFF_2016)), /2016-12-08/);
  assert.doesNotMatch(vintageText(panels.filter((p) => p.effectiveMs === EFF_2016)), /2012/);
  // No panels at all is said, never filled in.
  assert.match(vintageText([]), /did not|no panel/i);
  assert.equal(readPanels(ERROR_200).length, 0);
});

test('no map here and no hazard here are different answers, and only layer 0 tells them apart', () => {
  assert.deepEqual(readCoverage(COVERED), { mapped: true, studies: ['55103C', '55123C'] });
  assert.deepEqual(readCoverage(NO_MAP), { mapped: false, studies: [] });
  assert.deepEqual(readCoverage(ERROR_200), { mapped: false, studies: [] });
  // Interior Alaska: NFHL publishes nothing, and layer 28 is empty there for that reason.
  const unmapped = areaReport({ coverage: NO_MAP, count: { count: 0 } });
  assert.match(unmapped.text, /no flood map|not mapped|publishes no/i);
  assert.doesNotMatch(unmapped.text, /\b(no flood risk|not at risk|safe)\b/i,
    'an unmapped area is one nobody studied, never one with no flood risk');
  assert.equal(unmapped.mapped, false);
  // Mapped, and the count is real: the report leads with the vintage and the census.
  const covered = areaReport({ coverage: COVERED, count: { count: 159 }, zones: ZONES, panels: PANELS });
  assert.equal(covered.mapped, true);
  assert.equal(covered.known, true);
  assert.match(covered.text, /2012-11-02/);
  assert.match(covered.text, /159/);
});

test('density is refused at the gate rather than paged, and nothing is fetched above it', () => {
  assert.equal(MAX_FEATURES_DRAWN, 1500);
  assert.equal(readCount({ count: 29016 }), 29016);
  const dense = areaReport({ coverage: COVERED, count: { count: 29016 } });
  assert.equal(dense.drawable, false);
  assert.match(dense.text, /zoom in/i);
  assert.match(dense.text, /29,016|29016/);
  // And the count that sits on the line is drawable, so the gate is not off by one.
  assert.equal(areaReport({ coverage: COVERED, count: { count: MAX_FEATURES_DRAWN }, zones: ZONES, panels: PANELS }).drawable, true);
  assert.equal(areaReport({ coverage: COVERED, count: { count: MAX_FEATURES_DRAWN + 1 } }).drawable, false);
});

test('a view over the ceiling asks for no geometry at all, and an unmapped one asks for none either', async () => {
  const asked = [];
  const reply = (url) => {
    asked.push(url);
    const body = url.includes('/0/query') ? COVERED
      : url.includes('returnCountOnly') ? { count: 29016 }
        : url.includes('/3/query') ? PANELS : ZONES;
    return { ok: true, json: async () => body };
  };
  await fetchFloodView(LA_FARGE, { fetchImpl: async (url) => reply(url) });
  // Coverage and the count, and then nothing: 13 bytes said no, so the 22 MB question is
  // never asked and neither is the page after it. This is the gate being a gate.
  assert.equal(asked.length, 2);
  assert.ok(asked.every((u) => u.includes('/0/query') || u.includes('returnCountOnly')));
  assert.ok(!asked.some((u) => u.includes('maxAllowableOffset')), 'the expensive query ran anyway');

  // And an area FEMA never mapped asks for nothing further either, for a different reason.
  asked.length = 0;
  await fetchFloodView(LA_FARGE, {
    fetchImpl: async (url) => {
      asked.push(url);
      return { ok: true, json: async () => (url.includes('/0/query') ? NO_MAP : { count: 0 }) };
    },
  });
  assert.equal(asked.length, 2);

  // Under the ceiling and mapped, all four questions are asked and the report is drawable.
  asked.length = 0;
  const got = await fetchFloodView(LA_FARGE, {
    fetchImpl: async (url) => {
      asked.push(url);
      const body = url.includes('/0/query') ? COVERED
        : url.includes('returnCountOnly') ? { count: 159 }
          : url.includes('/3/query') ? PANELS : ZONES;
      return { ok: true, json: async () => body };
    },
  });
  assert.equal(asked.length, 4);
  assert.equal(areaReport(got).drawable, true);
  assert.equal(readZones(got.zones).length, 159);
});

test('nothing this layer can say puts water on the ground now', () => {
  const rows = readZones(ZONES);
  const strings = readerStrings({ coverage: COVERED, count: { count: 159 }, zones: ZONES, panels: PANELS });
  assert.ok(strings.length >= 8);
  for (const s of [...strings, ...rows.map(zoneText), ...Object.values(ZONE_MEANING)]) {
    assert.ok(typeof s === 'string' && s.length, 'every reader string is a real sentence');
    assert.doesNotMatch(s, PRESENT_TENSE, `"${s}" reads as a statement about now`);
    assert.doesNotMatch(s, SENTINEL, `"${s}" leaked a service sentinel`);
  }
  // The caveat has to carry the two things a reader will otherwise assume.
  assert.match(LAYER_CAVEAT, /insurance|regulat/i);
  assert.match(LAYER_CAVEAT, /panel/i);
  assert.match(quietText(), /studied|mapped|published/i);
});

test('the layer row is a context surface whose caption offers no moment at all', () => {
  const layer = LAYER_BY_ID.femaNfhl;
  assert.equal(layer.group, 'context');
  assert.equal(layer.sourceId, 'femaNfhl');
  assert.equal(layer.screenOnly, true, 'a regulatory map is not a sheet this page prints');
  assert.equal(layer.label, LAYER_LABEL);
  assert.equal(layer.coverageCaveat, LAYER_CAVEAT);
  // NOT 'none': zero zone features over a rectangle means "no map here" in Alaska and
  // "nothing intersects" elsewhere, and only the coverage query separates them.
  assert.equal(layer.emptyMeans, 'ambiguous');
  assert.ok(!layer.rasterSurface, 'it is drawn as polygons, not as a view-filling picture');
  assert.ok(CONTEXT_LAYER_IDS.includes('femaNfhl'));
  // A regulatory floodplain has no time a caption could honestly show -- the vintage is per
  // PANEL and a view holds several -- so the caption says the time is unknown rather than
  // borrowing the wall clock, and the panel range goes in the layer's own row instead.
  const caption = surfaceCaption('femaNfhl', { timeMs: null, vintage: null });
  assert.equal(caption.claim, 'model');
  assert.match(caption.text, /unknown/i);
  assert.doesNotMatch(caption.text, /Observed|Forecast/);
});

test('the drawn shapes carry the zone, and a failed view draws nothing', () => {
  const added = [];
  const L = {
    layerGroup: () => ({ _l: [], clearLayers() { this._l.length = 0; }, addLayer(x) { this._l.push(x); } }),
    polygon: (rings, opts) => ({ rings, opts, addTo(g) { added.push(this); g.addLayer(this); return this; }, bindTooltip(t) { this.tip = t; return this; } }),
  };
  const group = floodZonesLayer(L);
  const rows = readZones(ZONES).slice(0, 3).map((r) => ({ ...r, rings: [[[43.6, -90.6], [43.61, -90.6], [43.61, -90.59]]] }));
  group.draw(rows);
  assert.equal(added.length, 3);
  for (const p of added) assert.ok(p.tip && p.tip.length, 'a drawn polygon says which zone it is');
  group.draw([]);
  assert.equal(group._l.length, 0, 'an empty answer clears the map rather than leaving the last view up');
});
