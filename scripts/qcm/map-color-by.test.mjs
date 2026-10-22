// What the county map paints, and whether its key tells the truth about it.
//
// The map colored by Stability, always, while the table sorted by Overall and the
// candidates by Stability — three orderings on one screen, nothing saying so
// (audit F19). One COLOR_METRICS table now drives the choropleth, the marker sizes,
// the legend title, the band labels AND the select's options, so the key cannot
// describe a ramp the map is not drawing. A quieter lie went with it:
// `c.stability_score || 0` painted an uncomputed score into the bottom band, where
// it read as measured; unknown now has its own swatch and row. Tested against the
// SHIPPED source: these live inside the IIFE, so the real text is extracted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../../themes/headlessmode/layouts/_default/quiet-corners-dashboard.html', import.meta.url), 'utf8');

/** The real declaration text, by bracket matching from its head. */
function decl(head, open) {
  const at = SRC.indexOf(head);
  assert.notEqual(at, -1, `${head} is gone from quiet-corners.js`);
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let j = SRC.indexOf(open, at); j < SRC.length; j++) {
    if (SRC[j] === open) depth++;
    else if (SRC[j] === close && --depth === 0) return SRC.slice(at, j + 1);
  }
  throw new Error(`unbalanced ${open} in ${head}`);
}
const fn = (name) => decl(`function ${name}(`, '{');

// escHtml is the file's real one, and it goes through the DOM; this is the
// smallest document that lets it run outside a browser.
const DOC = {
  createElement: () => ({
    textContent: '',
    get innerHTML() {
      return String(this.textContent).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
  }),
};

const api = new Function('document', `
  ${decl('const COLOR_METRICS = [', '[')};
  ${decl('const BAND_STYLES = [', '[')};
  ${decl('const UNKNOWN_BAND = {', '{')};
  ${fn('escHtml')} ${fn('escAttr')} ${fn('colorMetric')} ${fn('bandIndex')} ${fn('bandStyle')} ${fn('bandLabels')} ${fn('colorByOptionsHtml')}
  return { COLOR_METRICS, UNKNOWN_BAND, colorMetric, bandIndex, bandStyle, bandLabels, colorByOptionsHtml };
`)(DOC);
const { COLOR_METRICS, UNKNOWN_BAND } = api;
const ACCENT = '#4caf63';

test('every metric the map offers carries its own bands and its own unit', () => {
  assert.ok(COLOR_METRICS.length >= 4, 'a chooser with fewer than four choices is not a chooser');
  for (const m of COLOR_METRICS) {
    assert.match(m.key, /^[a-z_]+$/, 'a metric is addressed by a county field name');
    assert.ok(m.label && m.unit, `${m.key} needs a label and a unit`);
    assert.equal(m.bands.length, 3, `${m.key} needs three cut points for four bands`);
    assert.deepEqual([...m.bands].sort((a, b) => b - a), m.bands, `${m.key}'s bands must descend`);
  }
  const miles = COLOR_METRICS.find((m) => m.key === 'distance_to_metro_mi');
  assert.ok(miles, 'distance to a city is a metric a person wants the map colored by');
  assert.notEqual(miles.unit, COLOR_METRICS[0].unit, 'one ramp for miles and a score is the finding');
  // The key states the unit, so the legend cannot read "80+" for a distance.
  const b = miles.bands;
  assert.deepEqual(api.bandLabels(miles),
    [`${b[0]}+ mi`, `${b[1]}\u2013${b[0]} mi`, `${b[2]}\u2013${b[1]} mi`, `<${b[2]} mi`],
    'a distance key reads in miles, widest band first');
  for (const label of api.bandLabels(miles)) assert.match(label, /mi/, 'a distance band names its unit');
  for (const label of api.bandLabels(COLOR_METRICS[0])) assert.doesNotMatch(label, /mi/, 'a score band does not');
  assert.equal(api.colorMetric('not_a_field'), COLOR_METRICS[0], 'an unknown metric falls back to the default');
  assert.equal(api.colorMetric(miles.key), miles, 'and a known one is honoured');
});

test('a value that was never computed is drawn as unknown, not as a low score', () => {
  const m = COLOR_METRICS[0];
  assert.equal(api.bandIndex(null, m), -1, 'null is not a band');
  assert.equal(api.bandIndex(undefined, m), -1, 'neither is a missing field');
  assert.equal(api.bandIndex(0, m), 3, 'but a measured zero IS the bottom band');

  const unknown = api.bandStyle(null, ACCENT, m);
  assert.notEqual(unknown.fill, ACCENT, 'unknown must not be painted in the score colour');
  assert.equal(unknown.fill, UNKNOWN_BAND.fill);
  assert.equal(api.bandStyle(0, ACCENT, m).fill, ACCENT, 'a real zero is a real result');
  assert.notEqual(api.bandStyle(0, ACCENT, m).opacity, unknown.opacity, 'and looks unlike unknown');

  // The old `stability_score || 0` is what turned unknown into "<40".
  assert.doesNotMatch(SRC, /stability_score \|\| 0/, 'a coalesced 0 invents a measurement');
});

test('the bands are ordered, and each one sizes its own fallback marker', () => {
  const m = COLOR_METRICS[0];
  const idx = [m.bands[0] + 5, m.bands[0], m.bands[1], m.bands[2], m.bands[2] - 1]
    .map((v) => api.bandIndex(v, m));
  assert.deepEqual(idx, [0, 0, 1, 2, 3], 'cut points are inclusive at the top of their band');
  const radii = [0, 1, 2, 3].map((i) => api.bandStyle(m.bands[0] - i * 20, ACCENT, m).radius);
  assert.deepEqual([...radii].sort((a, b) => b - a), radii, 'the dot map shrinks as the value falls');
  for (const i of [0, 1, 2, 3]) {
    const s = api.bandStyle([m.bands[0], m.bands[1], m.bands[2], 0][i], ACCENT, m);
    assert.ok(s.weight > 0, 'every band has a visible outline weight');
  }
  assert.ok(api.bandStyle(null, ACCENT, m).radius > 0, 'unknown is still drawable on the dot map');
});

test('the control is built from the same table the map paints from', () => {
  const opts = api.colorByOptionsHtml();
  for (const m of COLOR_METRICS) {
    assert.ok(opts.includes(`value="${m.key}"`), `${m.key} is missing from the select`);
    assert.ok(opts.includes(m.label), `${m.label} is missing from the select`);
  }
  // The markup ships an EMPTY select: hand-written options are what drifts.
  const sel = HTML.match(/<select[^>]*id="qc-color-by"[\s\S]*?<\/select>/);
  assert.ok(sel, 'the Color by select is gone from the dashboard');
  assert.doesNotMatch(sel[0], /<option/, 'options come from COLOR_METRICS, never from the template');
  assert.match(HTML, /Color the map by/, 'and the control says what it does');
  assert.match(SRC, /colorByOptionsHtml\(\)/, 'something must actually fill it');
});

test('the legend describes the metric in force, and changing it only repaints', () => {
  // The legend is rebuilt from the selected metric rather than written once.
  assert.match(SRC, /function renderLegend\(/, 'a legend written once cannot follow the selector');
  const legend = fn('renderLegend');
  assert.match(legend, /colorMetric\(colorBy\)\.label/, 'the legend titles itself from the metric in force');
  assert.match(legend, /bandKeyHtml\(/, 'and draws its bands from the same table the map paints from');
  assert.doesNotMatch(legend, /Stability Score/, 'a hard-coded title is the finding itself');
  const key = fn('bandKeyHtml');
  assert.match(key, /bandLabels\(colorMetric\(colorBy\)\)/, 'the band labels follow the metric');
  assert.match(key, /BAND_STYLES\.map/, 'and there is one swatch per band actually drawn');
  assert.match(key, /UNKNOWN_BAND/, 'and the unknown swatch the map paints has a row of its own');

  // Recolouring is not refiltering: the filtered set has not changed.
  const bind = SRC.slice(SRC.indexOf("'qc-color-by'"));
  assert.ok(bind.length, 'the select is never wired up');
  const handler = bind.slice(0, 400);
  assert.match(handler, /repaintMap|updateMapHighlights|renderLegend/, 'changing it must repaint');
  assert.doesNotMatch(handler, /applyFilters/, 'a colour change re-runs no filter');

  // The choropleth and the fallback dots both read the selection. They go through
  // styleFor() now, not bandStyle() directly -- the indirection that lets scores-off
  // draw a neutral, invisible-fill shape instead of a ranked one -- but styleFor
  // still calls bandStyle with the chosen metric whenever scores are visible.
  assert.match(SRC, /styleFor\([^)]*colorMetric/, 'the polygons use the chosen metric');
  assert.match(SRC, /bandStyle\(value, accent, metric\)/, 'styleFor must still hand the metric to bandStyle');
});

// ---------------------------------------------------------------------------
// Three ranking cues on one screen, reconciled in one sentence (audit A12).
//
// The map colours by Stability, the county table sorts by Overall and the town
// table sorts by Stability. Each is labelled on its own, so nothing on the page
// is wrong — but a reader comparing the map to the table beside it is comparing
// an ingredient to the dish it goes into, with nothing saying so. Stability is
// about 22% of Overall (quietness 55%, stability 40% of that); Overall also
// carries affordability, remoteness and inverted sprawl risk. They rank counties
// differently on purpose, so the fix is to say what each cue is showing, not to
// collapse them onto one measure and hide a dimension the page deliberately
// draws. Independent sorting keeps working; the line follows it.
// ---------------------------------------------------------------------------

/** Smallest document that lets the real cue-note code run outside a browser. */
function cueDoc(countyLabel, townLabel) {
  const note = { textContent: '' };
  const textSpan = (t) => ({ childNodes: [{ nodeType: 3, textContent: t }] });
  const header = (label) => ({ querySelector: () => (label ? textSpan(label) : null) });
  const doc = {
    getElementById: (id) => {
      if (id === 'qc-cue-note') return note;
      if (id === 'qc-table-header') return header(countyLabel);
      if (id === 'qc-candidates-header') return header(townLabel);
      return null;
    },
  };
  const colorByLine = SRC.match(/^[ \t]*let colorBy = .+$/m);
  assert.ok(colorByLine, 'the map has no selected metric to report');
  // colorBy reads DEFAULT_METRIC now, so the constant comes along: what this
  // harness reports as the default view is the shipped default, not a copy.
  const defaultLine = SRC.match(/^[ \t]*const DEFAULT_METRIC = .+$/m);
  assert.ok(defaultLine, 'there is no single default metric');
  const api = new Function('document', `
    ${decl('const COLOR_METRICS = [', '[')};
    ${defaultLine[0]};
    ${colorByLine[0]};
    ${fn('colorMetric')} ${fn('headerLabel')} ${fn('activeSortLabel')} ${fn('updateCueNote')}
    return { updateCueNote, setColorBy: function (k) { colorBy = k; } };
  `)(doc);
  return { note, api };
}

test('one line names all three ranking cues, from the state that drives them', () => {
  // All three now name the same metric on first load, which is the fix rather than
  // a weaker assertion: the line still reads each cue from its own state, and the
  // test below proves it still separates them the moment they diverge.
  const { note, api } = cueDoc('Overall', 'Overall');
  api.updateCueNote();
  assert.equal(note.textContent,
    'Map color: Overall · County sort: Overall · Town sort: Overall',
    'the default view must say what each of the three cues is showing');
});

test('the line follows the colour selector and both table sorts', () => {
  const recoloured = cueDoc('Overall', 'Overall');
  recoloured.api.setColorBy('quietness_score');
  recoloured.api.updateCueNote();
  assert.match(recoloured.note.textContent, /^Map color: Quietness · County sort: Overall · /,
    'recolouring the map must move the line with it, and only that part of it');

  const resorted = cueDoc('Affordability', 'Town');
  resorted.api.updateCueNote();
  assert.match(resorted.note.textContent,
    /County sort: Affordability · Town sort: Town$/,
    'the line reads each table’s own active heading, so independent sorting still shows');

  // The candidate towns section ships hidden; a cue for a table nobody can see
  // is a fourth thing to reconcile.
  const noTowns = cueDoc('Overall', null);
  noTowns.api.updateCueNote();
  assert.equal(noTowns.note.textContent, 'Map color: Overall · County sort: Overall',
    'a hidden town table contributes no cue');

  // Labels are read, never typed: a renamed column must not need a second edit.
  const cue = fn('updateCueNote');
  assert.doesNotMatch(cue, /Stability|Overall|Quietness|Affordability/,
    'a metric name written into the cue line is the drift this fixes');
  assert.match(cue, /colorMetric\(colorBy\)\.label/, 'the map half reads the metric in force');
  assert.match(fn('activeSortLabel'), /span\[data-sort\]\.sort-active/,
    'the table halves read the heading each table has actually marked');
});

test('the cue line is on the page, above the tables, and refreshed on every change', () => {
  const at = HTML.indexOf('id="qc-cue-note"');
  assert.notEqual(at, -1, 'the dashboard carries no line reconciling the three cues');
  assert.ok(at < HTML.indexOf('id="qc-sort-note"'),
    'it belongs above the county table, where the map and the table are compared');
  assert.doesNotMatch(HTML.slice(at - 200, at + 200), /Map color:/,
    'the sentence is written by updateCueNote, never typed into the template');

  assert.match(fn('markSorted'), /updateCueNote\(\)/, 're-sorting a table must move the line');
  const bind = SRC.slice(SRC.indexOf("'qc-color-by'"), SRC.indexOf("'qc-color-by'") + 600);
  assert.match(bind, /updateCueNote\(\)/, 'recolouring the map must move the line');
});

// F19's fix LABELLED three disagreeing cues. A label is the floor, not the fix: on
// first load the map painted Stability, the county table sorted Overall and the town
// table sorted Stability, so a reader comparing the darkest county to the top row of
// the table beneath it saw two different counties and the note only confirmed it.
// Three cues, one default. `overall_score` is the weighted composite of the other
// three, so "this page ranks by Overall until you change it" is one true sentence.
//
// The default lived in four places — two `let`s, one `const`, and a hand-typed
// `sort-active` in the template — any of which could drift alone. It is one constant
// now, and the template stopped naming it: the script stamps the active heading at
// init from the same value the map and both tables read.
const DEFAULT_KEY = 'overall_score';

test('the map and both tables rank by the same metric before anything is clicked', () => {
  const m = SRC.match(/const DEFAULT_METRIC\s*=\s*'([a-z_]+)'/);
  assert.ok(m, 'there is no single default metric to agree on');
  assert.equal(m[1], DEFAULT_KEY, 'the composite is what the page ranks by until asked otherwise');

  for (const [what, re] of [
    ['the map colour', /let colorBy = DEFAULT_METRIC;/],
    ['the county sort', /let currentSort = \{ key: DEFAULT_METRIC, dir: -1 \};/],
    ['the town sort', /const candidatesSort = \{ key: DEFAULT_METRIC, dir: -1 \};/],
  ]) {
    assert.match(SRC, re, `${what} does not read DEFAULT_METRIC`);
  }
});

test('the template does not type a default sort the script can disagree with', () => {
  const typed = [...HTML.matchAll(/data-sort="([a-z_]+)"[^>]*\bsort-active\b/g)].map((x) => x[1]);
  assert.deepEqual(typed, [],
    `the markup hard-codes ${typed.join(', ')} as sorted; the script must stamp it instead`);
  assert.match(SRC, /markSortActive\(/, 'something has to stamp the active heading at init');
});
