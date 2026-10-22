// The light-emissions context layer: NASA Black Marble, WMTS tiles from NASA GIBS, no key
// and no account. Re-measured live 2026-09-11, and three of those measurements are the
// design: the path is {z}/{y}/{x}, reversed from the usual order, so swapping it is a
// silent wrong answer; the set stops at level 8, where level 9 is HTTP 400 with an XML
// body rather than an empty tile; and the only Time values are 2012-01-01 and 2016-01-01,
// default 2016, so a ten-year-old composite may never be shown as current conditions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TILE_TEMPLATE, MAX_NATIVE_ZOOM, DEFAULT_TIME, VINTAGE_YEAR, VINTAGES,
  tileUrl, leafletOptions, nightLightsLayer, zoomStatus, readerStrings,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-night-lights.js';
import { LAYER_BY_ID, GROUP_IDS, enabledLayers } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';
import { SOURCES, cspDirectivesFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';

const read = (rel) => readFileSync(new URL(`../../themes/headlessmode/static/js/quiet-corners-maps/${rel}`, import.meta.url), 'utf8');
const [MODULE, REGISTRY, MAIN, PRESETS] = ['source-night-lights.js', 'layer-registry.js', 'main.js', 'layer-presets.js'].map(read);
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default';
const SET = 'GoogleMapsCompatible_Level8';

test('a tile URL carries the time and puts the ROW before the column', () => {
  // Both measured 200 image/png on 2026-09-11: 51,810 bytes and 72,917 bytes.
  assert.equal(tileUrl({ z: 8, y: 95, x: 60 }), `${GIBS}/2016-01-01/${SET}/8/95/60.png`);
  assert.equal(tileUrl({ z: 4, y: 5, x: 4, time: '2012-01-01' }), `${GIBS}/2012-01-01/${SET}/4/5/4.png`);
  assert.equal(TILE_TEMPLATE, `${GIBS}/{time}/${SET}/{z}/{y}/{x}.png`);
  assert.ok(tileUrl({ z: 3, y: 1, x: 2 }).endsWith('/3/1/2.png'));
  assert.ok(!tileUrl({ z: 3, y: 1, x: 2 }).endsWith('/3/2/1.png'), '{z}/{x}/{y} draws another continent');
  assert.throws(() => tileUrl({ z: 8, y: 95, x: 60, time: '2020-01-01' }), RangeError);
});

test('nothing may be requested past zoom 8, and Leaflet enlarges instead', () => {
  assert.equal(MAX_NATIVE_ZOOM, 8);
  // Measured: 9/190/120 answered HTTP 400 with a 427-byte text/xml body.
  assert.throws(() => tileUrl({ z: 9, y: 190, x: 120 }), RangeError);
  const { url, options } = leafletOptions();
  assert.equal(url, TILE_TEMPLATE.replace('{time}', DEFAULT_TIME));
  assert.equal(options.maxNativeZoom, MAX_NATIVE_ZOOM, 'else Leaflet asks for level 9 and 400s fill the console');
  assert.ok(options.maxZoom > MAX_NATIVE_ZOOM, 'the surface must stay on screen past its detail');
  assert.equal(zoomStatus(MAX_NATIVE_ZOOM), null, 'at its own detail the row needs no status');
  const made = nightLightsLayer({ tileLayer: (u, o) => ({ u, o }) });
  assert.equal(made.o.maxNativeZoom, MAX_NATIVE_ZOOM);
  assert.equal(made.u, url);
  assert.equal(zoomStatus(3), null);
  assert.match(zoomStatus(12), /enlarged/i);
  assert.match(zoomStatus(12), /zoom 8/);
});

test('the registry entry names the measured source, the 2016 vintage and its attribution', () => {
  const l = LAYER_BY_ID.nightLights;
  assert.ok(l, 'no nightLights entry in the layer registry');
  assert.equal(l.sourceId, 'nasaBlackMarble');
  assert.equal(l.defaultOn, false, 'a context surface is off until asked for');
  assert.ok(GROUP_IDS.includes(l.group), `group ${l.group} is not declared`);
  assert.match(l.label, /2016/, 'the year must reach the reader in the row itself');
  assert.match(l.coverageCaveat, /2016/);
  assert.match(leafletOptions().options.attribution, /2016/, 'the on-map credit carries the year too');
  assert.match(leafletOptions().options.attribution, /NASA/);
  const s = SOURCES.nasaBlackMarble;
  assert.ok(s, 'the tile host is not in the record of measured services');
  assert.equal(s.kind, 'raster-tiles', 'tiles are images: this is what puts the host in img-src');
  assert.equal(s.origin, 'https://gibs.earthdata.nasa.gov');
  assert.equal(s.measuredOn, '2026-09-11');
  assert.equal(s.cors, 'star');
  assert.deepEqual([...s.time.values], ['2012-01-01', '2016-01-01']);
  assert.equal(s.time.default, DEFAULT_TIME);
  assert.equal(DEFAULT_TIME, '2016-01-01');
  assert.equal(VINTAGE_YEAR, '2016');
  assert.deepEqual([...VINTAGES], ['2012-01-01', '2016-01-01']);
  assert.match(s.attribution, /NASA/);
  assert.ok(cspDirectivesFor()['img-src'].includes(s.origin), 'the tile host never reaches img-src');
  assert.ok(!enabledLayers({ nightLights: true }).some((x) => x.id === 'nightLights'),
    'a screen surface must never join the overlay fetch or the PDF');
  assert.deepEqual(enabledLayers({}).map((x) => x.id), ['usgsTopo'], 'and the default set is unchanged');
});

// The plan's explicit prohibition, gated rather than left to a comment: Black Marble
// measures radiance leaving the ground upward, the Bortle scale describes what an eye
// sees standing in it, and one is not a conversion of the other. Comments may name the
// prohibition; STRINGS may not (escapes matched, so a literal carrying ’ is read).
const FORBIDDEN = [
  /bortle/i, /sky[-\s]quality/i, /\bSQM\b/, /limiting magnitude/i,
  /mags?\s*(?:\/|per)\s*(?:square\s*)?arcsec/i, /\b[1-9]\s*(?:of|out of|\/|–|-)\s*9\b/,
  /(?:darkness|dark[-\s]sky)\s*(?:score|rating|class|index|level|grade)/i,
];
const literals = (src) => [...src.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)]
  .map((m) => m[1] ?? m[2] ?? m[3]);

test('no user-facing string may claim a Bortle class or a sky-quality score', () => {
  // layer-presets.js joined the scan with the presets: the night set is the one place on
  // this page that offers to answer "is tonight worth it", so it is where a darkness score
  // would be invented if one ever were.
  for (const s of [...readerStrings(), ...literals(MODULE), ...literals(REGISTRY), ...literals(PRESETS)]) {
    for (const rx of FORBIDDEN) assert.ok(!rx.test(s), `${rx} matches a user-facing string: ${JSON.stringify(s)}`);
  }
  const l = LAYER_BY_ID.nightLights;
  for (const text of [l.label, l.coverageCaveat, zoomStatus(12), leafletOptions().options.attribution]) {
    assert.ok(readerStrings().includes(text), `shown to a reader, invisible to the gate: ${JSON.stringify(text)}`);
  }
  // The positive half: say what the data IS, never call a ten-year-old composite tonight.
  assert.match(`${l.coverageCaveat} ${SOURCES.nasaBlackMarble.coverageSemantics}`, /upward/i);
  for (const s of readerStrings()) assert.ok(!/\btonight\b|\bcurrent conditions\b/i.test(s), s);
});

test('main.js switches the surface from its own control and reports the ceiling', () => {
  assert.match(MAIN, /layers\.nightLights/, 'the control is wired to nothing');
  assert.match(MAIN, /nightLightsLayer\(/, 'nothing ever builds the tile layer');
  assert.match(MAIN, /zoomStatus\(/, 'nothing tells the reader when the picture is only enlarged');
  // renderLayerReports hides any row whose layer has no source state, and this one has none.
  assert.match(MAIN, /!el \|\| l\.screenOnly/, 'the reports loop would hide the zoom status again');
});
