// Who may drive a forest road, and when -- the half of F13 that was fetched and
// then thrown away.
//
// `normalizeFeature` has read `passengervehicle`, `highclearancevehicle` and both
// `_datesopen` windows since the adapter was written. Nothing consumed them. The
// only thing the map ever did with MVUM's season was pick a DASH PATTERN, so a
// road open to high-clearance trucks from April to December and a road open to
// anything year-round were two dashed grey lines of identical weight, with the
// answer already sitting in the browser.
//
// The rule the module turns on, again: only a STATED value counts. MVUM is motor
// vehicle data, so a blank is the inventory not saying -- never a ban, and never
// a permission.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mvumAccessText, seasonalWindows } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-mvum.js';
import { SYMBOLS, deriveLegend } from '../../themes/headlessmode/static/js/quiet-corners-maps/legend.js';

const road = (o = {}) => ({
  seasonal: o.seasonal ?? 'yearlong',
  vehicles: {
    passenger: { allowed: o.passenger ?? null, datesOpen: o.passengerDates ?? null },
    highClearance: { allowed: o.highClearance ?? null, datesOpen: o.highClearanceDates ?? null },
  },
});

test('a stated window is quoted as dates, not as a season word', () => {
  const text = mvumAccessText(road({
    seasonal: 'seasonal', passenger: 'open', passengerDates: { open: '04-01', close: '12-15' },
  }));
  assert.match(text, /Apr 1/, 'the source gave a date, so the reader gets the date');
  assert.match(text, /Dec 15/);
  assert.match(text, /passenger cars/i);
  // No year: MVUM states a recurring window, and printing "2026" would invent an
  // edition of the map the service never published.
  assert.doesNotMatch(text, /20\d\d/, 'a recurring window is not a dated one');
});

test('open with no window is never reported as open year-round', () => {
  // The service marked the route seasonal and left the window blank. Saying
  // "year-round" here is the exact failure this app exists to avoid: it would
  // promise a December drive the inventory never described.
  const text = mvumAccessText(road({ seasonal: 'seasonal', passenger: 'open' }));
  assert.doesNotMatch(text, /year-round/, 'a seasonal road with no stated window is not year-round');
  assert.match(text, /not stated|not published/i, 'the gap is named, not filled');

  const yearlong = mvumAccessText(road({ seasonal: 'yearlong', passenger: 'open' }));
  assert.match(yearlong, /year-round/, 'yearlong IS a stated answer');
});

test('a blank vehicle says nothing at all, and a closed one says closed', () => {
  // Blank is the inventory not answering. It is not a ban.
  assert.equal(mvumAccessText(road({})), null, 'nothing stated, nothing said');
  assert.equal(mvumAccessText(null), null);
  assert.equal(mvumAccessText(road({ passenger: 'nonsense' })), null,
    'an unrecognized value was already discarded upstream; it must not resurface here');

  const closed = mvumAccessText(road({ passenger: 'closed', highClearance: 'open' }));
  assert.match(closed, /[Cc]losed to passenger cars/);
  assert.match(closed, /high-clearance/i, 'both stated answers are shown, not the friendlier one');
});

test('the key may promise the dates only because the sheet now carries them', () => {
  // `Forest road, seasonal (dates on sheet when supplied)` stood in the printed key
  // for months while no module wrote a date to any sheet: `summarize()` collected
  // the windows and nothing but its own test called it. The promise was removed,
  // and restored only once the dates really reached the page.
  //
  // The gate is two-way, and behavioural rather than textual: if the seasonal
  // swatch points the reader anywhere, a legend built from stated windows must
  // actually carry them, and `layoutLegend` must put them on a page.
  const label = SYMBOLS.roadSeasonal.label;
  if (!/date/i.test(label)) return;
  const legend = deriveLegend({ renderedSymbolKeys: ['mvum-road-seasonal'], gridEnabled: false,
    basemapRendered: false, seasonalWindows: { lines: ['FR 71: Apr 1 - Dec 15'], undated: 0 } });
  assert.deepEqual(legend.seasonalRoutes, ['FR 71: Apr 1 - Dec 15'],
    `the key says "${label}" — so the legend it describes has to carry them`);
});


// The key promised these and no module ever wrote one: `summarize()` collected the
// windows and nothing called it but its own test. This is the other end of that
// fix — the dates reach the paper, so the key may promise them again.
test('the seasonal routes on a sheet are listed with the dates the source gave', () => {
  const route = (id, name, seasonal, dates) => ({
    id, name, layer: 'road', seasonal,
    vehicles: { passenger: { allowed: 'open', datesOpen: dates }, highClearance: { allowed: null, datesOpen: null } },
  });
  const { lines, undated } = seasonalWindows([
    route('71', 'FR 71', 'seasonal', { open: '04-01', close: '12-15' }),
    // The same route comes back once per segment. One line, not one per segment.
    route('71', 'FR 71', 'seasonal', { open: '04-01', close: '12-15' }),
    route('12', 'FR 12', 'seasonal', null),
    route('99', null, 'yearlong', null),
  ]);
  assert.deepEqual(lines, ['FR 71: Apr 1 - Dec 15']);
  // A route the source called seasonal and gave no window for is COUNTED, not
  // dropped. Listing only the dated ones would read as "these are the seasonal
  // roads here", and a reader would drive FR 12 in February on that.
  assert.equal(undated, 1);

  // A route open all year needs no window and contributes nothing to either.
  assert.deepEqual(seasonalWindows([route('99', 'FR 99', 'yearlong', null)]), { lines: [], undated: 0 });
  assert.deepEqual(seasonalWindows([]), { lines: [], undated: 0 });
});

test('a route with two stated windows keeps both, and an unnamed one keeps its number', () => {
  const seg = (id, name, dates) => ({ id, name, layer: 'road', seasonal: 'seasonal',
    vehicles: { passenger: { allowed: 'open', datesOpen: dates }, highClearance: { allowed: null, datesOpen: null } } });
  const { lines } = seasonalWindows([
    seg('71', null, { open: '04-01', close: '12-15' }),
    seg('71', null, { open: '05-15', close: '11-30' }),
  ]);
  // Segments of one road can carry different windows, and picking one would
  // invent a road that opens on a date the source never gave for that stretch.
  assert.deepEqual(lines, ['71: Apr 1 - Dec 15; May 15 - Nov 30']);
});
