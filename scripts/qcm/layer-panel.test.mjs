import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterLayerSpecs,
  layerBadge,
  BADGE_WORDS,
  layerCountLine,
  layerAboutText,
  rowSummaryLine,
  MAX_VISIBLE_ROW_LINES,
  groupIsCollapsedByDefault,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-panel.js';

const GROUPS = [
  { id: 'base', label: 'Base map' },
  { id: 'federal', label: 'Federal land' },
  { id: 'state', label: 'State land' },
];

const ROWS = [
  { id: 'usgsTopo', group: 'base', label: 'USGS Topo', note: '', checked: true, alwaysShow: true },
  { id: 'federalLand', group: 'federal', label: 'Federal land', note: 'National forests and parks', checked: true },
  { id: 'wilderness', group: 'federal', label: 'Wilderness', note: '', checked: false },
  { id: 'gameLands', group: 'state', label: 'Game lands', note: 'State wildlife management', checked: false },
];

test('filterLayerSpecs: empty query keeps every row and group', () => {
  const { visibleIds, visibleGroupIds } = filterLayerSpecs(ROWS, GROUPS, { query: '' });
  assert.equal(visibleIds.size, ROWS.length);
  assert.equal(visibleGroupIds.size, 3);
});

test('filterLayerSpecs: matches by row label, case-insensitive', () => {
  const { visibleIds } = filterLayerSpecs(ROWS, GROUPS, { query: 'WILDERNESS' });
  assert.ok(visibleIds.has('wilderness'));
  assert.equal(visibleIds.size, 1);
});

test('filterLayerSpecs: matches by group label', () => {
  const { visibleIds } = filterLayerSpecs(ROWS, GROUPS, { query: 'state land' });
  assert.ok(visibleIds.has('gameLands'));
  assert.equal(visibleIds.size, 1);
});

test('filterLayerSpecs: matches by note text', () => {
  const { visibleIds } = filterLayerSpecs(ROWS, GROUPS, { query: 'wildlife management' });
  assert.deepEqual([...visibleIds], ['gameLands']);
});

test('filterLayerSpecs: a group heading survives only with a surviving row', () => {
  const { visibleGroupIds } = filterLayerSpecs(ROWS, GROUPS, { query: 'wilderness' });
  assert.deepEqual([...visibleGroupIds], ['federal']);
});

test('filterLayerSpecs: no match drops everything, including group headings', () => {
  const { visibleIds, visibleGroupIds } = filterLayerSpecs(ROWS, GROUPS, { query: 'zzz-nothing' });
  assert.equal(visibleIds.size, 0);
  assert.equal(visibleGroupIds.size, 0);
});

test('filterLayerSpecs: active-only drops unchecked rows', () => {
  const { visibleIds } = filterLayerSpecs(ROWS, GROUPS, { activeOnly: true });
  assert.deepEqual([...visibleIds].sort(), ['federalLand', 'usgsTopo']);
});

test('filterLayerSpecs: active-only keeps a radio row marked alwaysShow even when unchecked-shaped', () => {
  const rows = [{ id: 'base-none', group: 'base', label: 'No basemap', note: '', checked: false, alwaysShow: true }];
  const { visibleIds } = filterLayerSpecs(rows, GROUPS, { activeOnly: true });
  assert.ok(visibleIds.has('base-none'));
});

test('filterLayerSpecs: active-only and search combine', () => {
  const { visibleIds } = filterLayerSpecs(ROWS, GROUPS, { query: 'federal', activeOnly: true });
  assert.deepEqual([...visibleIds], ['federalLand']);
});

test('BADGE_WORDS is the one fixed vocabulary', () => {
  assert.deepEqual(BADGE_WORDS, ['off', 'loading', 'ready', 'empty', 'partial', 'unavailable', 'zoom in']);
});

test('layerBadge: unchecked, non-required row reads off', () => {
  assert.equal(layerBadge({ checked: false }), 'off');
});

test('layerBadge: zoom-blocked takes precedence over everything, even off', () => {
  assert.equal(layerBadge({ checked: false, zoomBlocked: true }), 'zoom in');
  assert.equal(layerBadge({ checked: true, zoomBlocked: true, state: 'ready' }), 'zoom in');
});

test('layerBadge: checked but not yet fetched (state unchecked/null) reads loading', () => {
  assert.equal(layerBadge({ checked: true, state: 'unchecked' }), 'loading');
  assert.equal(layerBadge({ checked: true, state: null }), 'loading');
});

test('layerBadge: required row with no checked flag still evaluates state (base layer)', () => {
  assert.equal(layerBadge({ checked: false, required: true, state: 'ready', featureCount: 1 }), 'ready');
});

test('layerBadge: ready with zero features reads empty', () => {
  assert.equal(layerBadge({ checked: true, state: 'ready', featureCount: 0 }), 'empty');
});

test('layerBadge: ready with features reads ready', () => {
  assert.equal(layerBadge({ checked: true, state: 'ready', featureCount: 12 }), 'ready');
});

test('layerBadge: partial reads partial', () => {
  assert.equal(layerBadge({ checked: true, state: 'partial', featureCount: 3 }), 'partial');
});

test('layerBadge: unavailable/unknown reads unavailable', () => {
  assert.equal(layerBadge({ checked: true, state: 'unavailable' }), 'unavailable');
  assert.equal(layerBadge({ checked: true, state: 'unknown' }), 'unavailable');
});

test('layerCountLine: nothing on', () => {
  assert.equal(layerCountLine([{ badge: 'off' }, { badge: 'off' }]), 'No layers on');
});

test('layerCountLine: singular wording for one layer, none loading', () => {
  assert.equal(layerCountLine([{ badge: 'ready' }, { badge: 'off' }]), '1 layer on');
});

test('layerCountLine: plural wording plus a loading count', () => {
  const rows = [{ badge: 'ready' }, { badge: 'ready' }, { badge: 'loading' }, { badge: 'off' }];
  assert.equal(layerCountLine(rows), '3 layers on · 1 loading');
});

test('layerCountLine: multiple loading pluralizes "loading" count noun', () => {
  const rows = [{ badge: 'loading' }, { badge: 'loading' }];
  assert.equal(layerCountLine(rows), '2 layers on · 2 loadings');
});

test('layerAboutText: source name/origin, attribution, coverage, fetched wording, count', () => {
  const text = layerAboutText({
    layer: { coverageCaveat: 'Boundaries only; not an access grant.' },
    source: { name: 'USFS recreation sites', origin: 'apps.fs.usda.gov', attribution: 'U.S. Forest Service' },
    fetchedAt: '2026-09-26 10:00',
    featureCount: 5,
  });
  assert.match(text, /Source: USFS recreation sites \(apps\.fs\.usda\.gov\)/);
  assert.match(text, /U\.S\. Forest Service/);
  assert.match(text, /Boundaries only; not an access grant\./);
  assert.match(text, /Fetched 2026-09-26 10:00\./);
  assert.match(text, /5 features in the last check\./);
  assert.doesNotMatch(text, /Not fetched yet/);
});

test('layerAboutText: never fetched reads "Not fetched yet", never an observation-time claim', () => {
  const text = layerAboutText({ layer: {}, source: { name: 'X', origin: 'x.example' } });
  assert.match(text, /Not fetched yet\./);
});

test('layerAboutText: local-data layer with no source registry entry still names its source', () => {
  const text = layerAboutText({ layer: { localData: 'names gazetteer export' } });
  assert.match(text, /this site’s own data export \(names gazetteer export\)/);
});

// QUX-04a: the compact row's one line, and the group collapse default.

test('MAX_VISIBLE_ROW_LINES is 1 — a compact row is never a paragraph', () => {
  assert.equal(MAX_VISIBLE_ROW_LINES, 1);
});

test('rowSummaryLine: an off row shows no line at all', () => {
  assert.equal(rowSummaryLine({ checked: false, note: 'National forests and parks' }), '');
});

test('rowSummaryLine: an off row with no note still shows no line', () => {
  assert.equal(rowSummaryLine({ checked: false, note: '' }), '');
});

test('rowSummaryLine: an on row with a note shows exactly that note, unchanged', () => {
  assert.equal(
    rowSummaryLine({ checked: true, note: 'National forests and parks' }),
    'National forests and parks',
  );
});

test('rowSummaryLine: an on row with no note shows no line', () => {
  assert.equal(rowSummaryLine({ checked: true, note: '' }), '');
});

test('rowSummaryLine: an off row that cannot be turned on keeps its reason', () => {
  const why = 'Draw an area first — state land layers depend on which state it is in.';
  assert.equal(rowSummaryLine({ checked: false, disabled: true, note: why }), why);
});

test('rowSummaryLine: missing args default to no line (an off, note-less row)', () => {
  assert.equal(rowSummaryLine(), '');
  assert.equal(rowSummaryLine({}), '');
});

test('rowSummaryLine: a multi-line note is a contract violation, not silently truncated', () => {
  assert.throws(() => rowSummaryLine({ checked: true, note: 'first line\nsecond line' }));
});

test('groupIsCollapsedByDefault: every group starts closed, uniformly — no per-id exemption', () => {
  assert.equal(groupIsCollapsedByDefault({ id: 'base', label: 'Base map' }), true);
  assert.equal(groupIsCollapsedByDefault({ id: 'federal', label: 'Federal overlays' }), true);
  assert.equal(groupIsCollapsedByDefault({ id: 'extras', label: 'Extra sheets' }), true);
});

// UX-03b: a row can carry search words its label and note do not (webcam, an operator or a place).
test('filterLayerSpecs: matches a row\u2019s extra search words, not just label/group/note', () => {
  const rows = [
    { id: 'parkCameras', group: 'cameras', label: 'Park cameras (Great Smoky Mountains)', note: '', checked: false, keywords: 'webcam NPS Tennessee' },
    { id: 'roadCameras', group: 'cameras', label: 'Road cameras (Caltrans, Central Coast)', note: '', checked: false, keywords: 'webcam traffic California' },
    { id: 'wilderness', group: 'federal', label: 'Wilderness', note: '', checked: false },
  ];
  const groups = [{ id: 'cameras', label: 'Cameras' }, { id: 'federal', label: 'Federal land' }];
  assert.deepEqual([...filterLayerSpecs(rows, groups, { query: 'webcam' }).visibleIds].sort(), ['parkCameras', 'roadCameras']);
  assert.deepEqual([...filterLayerSpecs(rows, groups, { query: 'tennessee' }).visibleIds], ['parkCameras']);
  assert.equal(filterLayerSpecs(rows, groups, { query: 'nothing here' }).visibleIds.size, 0);
});
