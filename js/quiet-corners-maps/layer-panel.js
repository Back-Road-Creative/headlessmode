// Pure Layers-panel helpers (U0): which rows a search/active-only filter keeps, the one
// badge word a row's on/off + fetch state describes, the selected/loading count line, and
// the "About this layer" text. No DOM, no network — main.js is the only thing that reads a
// live checkbox or writes to the page; this only says what it should show.

const norm = (s) => String(s || '').toLowerCase();

/** Rows whose label, group label, note or keywords contain `query` (case-insensitive), plus which
 *  group ids still have at least one surviving row — a group heading with nothing under it
 *  is noise, not information. Empty query keeps every row. `activeOnly` additionally drops
 *  a row that is not checked, UNLESS it carries `alwaysShow` (a base/context radio's
 *  CURRENT choice — the brief keeps those visible so the group never reads as empty).
 *
 *  `rows`: [{ id, group, label, note, keywords, checked, alwaysShow }]; `keywords` is the
 *  row's extra search words (the registry's `searchTerms`), never shown. `groups`: [{ id, label }]. */
export function filterLayerSpecs(rows, groups, { query = '', activeOnly = false } = {}) {
  const q = norm(query).trim();
  const groupLabel = Object.fromEntries(groups.map((g) => [g.id, norm(g.label)]));
  const visibleIds = new Set();
  const visibleGroupIds = new Set();
  for (const r of rows) {
    if (activeOnly && !r.checked && !r.alwaysShow) continue;
    const haystack = `${norm(r.label)} ${groupLabel[r.group] || ''} ${norm(r.note)} ${norm(r.keywords)}`;
    if (q && !haystack.includes(q)) continue;
    visibleIds.add(r.id);
    visibleGroupIds.add(r.group);
  }
  return { visibleIds, visibleGroupIds };
}

/** The one vocabulary a state badge is drawn from. Never a layer-specific word. */
export const BADGE_WORDS = Object.freeze(['off', 'loading', 'ready', 'empty', 'partial', 'unavailable', 'zoom in']);

/** The badge word for one overlay row. `state` is the app-state fetch-state word
 *  (`'unchecked' | 'ready' | 'partial' | 'unavailable' | 'unknown'`) already carried by
 *  `state.states[id]`; this never invents a fourth "in flight" word because nothing else
 *  in the registry can tell "not asked yet" from "asking right now" apart — a row that is
 *  ON and whose state is still `'unchecked'` reads `'loading'` either way.
 *  `zoomBlocked` takes precedence: a remote vector under the viewport guard reads
 *  'zoom in' rather than 'loading', without loosening the guard itself (the caller still
 *  declines to fetch; this only names why). */
export function layerBadge({ checked, required = false, zoomBlocked = false, state = null, featureCount = null }) {
  if (zoomBlocked) return 'zoom in';
  if (!checked && !required) return 'off';
  if (!state || state === 'unchecked') return 'loading';
  if (state === 'partial') return 'partial';
  if (state === 'unavailable' || state === 'unknown') return 'unavailable';
  if (state === 'ready') return featureCount === 0 ? 'empty' : 'ready';
  return 'ready';
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "4 layers on · 1 loading" — the status-role summary above the panel. `rows` carries each
 *  visible row's own badge word (main.js supplies it, computed by layerBadge above, so this
 *  never re-derives fetch state itself). */
export function layerCountLine(rows) {
  const on = rows.filter((r) => r.badge && r.badge !== 'off').length;
  const loading = rows.filter((r) => r.badge === 'loading').length;
  const onText = on === 0 ? 'No layers on' : `${plural(on, 'layer')} on`;
  return loading > 0 ? `${onText} · ${plural(loading, 'loading')}` : onText;
}

/** The groups whose rows are optional screen layers the fetch pass never badges: a context
 *  surface, a reading, a camera pin set or an extra sheet is switched on or off and has no
 *  `state.states` entry. `base` is the screen base-map CHOICE (always exactly one, so it says
 *  nothing about what is "on"), and `federal`/`state` rows carry their own fetch badge. */
export const COUNTED_SCREEN_GROUPS = Object.freeze(['context', 'reading', 'cameras', 'extras']);

/** Count rows for every selected row of `registry` in COUNTED_SCREEN_GROUPS, from the
 *  `layers` switches (`{ [id]: boolean }`). Selected is not loaded is not rendered: a camera
 *  layer whose list failed, or came back empty, is still a layer the reader switched on, so
 *  a row here has no fetch badge to lose and is never part of the "loading" tally. */
export function selectedScreenRows(registry, layers) {
  return registry
    .filter((l) => COUNTED_SCREEN_GROUPS.includes(l.group) && layers[l.id])
    .map(() => ({ badge: 'on' }));
}

/** QUX-04a: the compact row. A row used to carry its registry note as a paragraph
 *  unconditionally — on or off, checked or not — which is what made thirty-odd
 *  switches read as thirty-odd paragraphs. The note still exists (the registry
 *  still writes it), but it is only worth a reader's screen once the switch it
 *  describes is actually on; an off row has nothing to report and shows no line. */

/** A compact row shows at most one line below its label — never a second
 *  paragraph, never a wrapped note. Exported so a row's own contract (below) can
 *  be asserted against the same number a reviewer reads here, rather than a
 *  magic "one" repeated in two places. */
export const MAX_VISIBLE_ROW_LINES = 1;

/** The one line a row shows below its label, or `''` for none. An off row that
 *  can be turned on reads `''` — the note moved to "About this layer" as the
 *  row's on-demand detail, not a paragraph every row pays for whether or not it
 *  is on. `checked` true shows the note as-is: still exactly the text the
 *  registry already carried, just no longer unconditional. A `disabled` row
 *  keeps its note while off too: there the note is WHY the switch will not move
 *  ("Draw an area first — …", "Not published by …"), which layerAboutText never
 *  restates, and a greyed switch with no reason beside it reads as broken. A
 *  note that is itself more than one line is a contract violation upstream (the
 *  registry's job, not this row's to silently truncate), so this throws rather
 *  than wrap. */
export function rowSummaryLine({ checked = false, disabled = false, note = '' } = {}) {
  if (!checked && !disabled) return '';
  const text = String(note || '');
  if (text.includes('\n')) throw new Error('rowSummaryLine: a row note must be one line');
  return text;
}

/** Every one of the registry's GROUPS starts closed. Thirty-odd rows read as a
 *  handful of headings first, not a wall of switches to scroll past before the
 *  map key is even in reach — opening one is a click away, and the toolbar's
 *  active-only toggle plus layerCountLine above already say what is on without
 *  opening any of them. Uniform, not a per-id table: a group added to the
 *  registry tomorrow collapses by default too, with no rendering code to update
 *  for it. Takes `group` (rather than reading nothing) so the one place that
 *  might one day want an exception has a single function to change. */
export function groupIsCollapsedByDefault(group) {
  return true;
}

/** The "About this layer" text: source name/origin, attribution, coverage, freshness,
 *  feature count. `source` is the registry's own `SOURCES[l.sourceId]` entry, or null for a
 *  local-data or state-scoped row. `fetchedAt` an ISO string or null — "fetched", never an
 *  observation/vintage claim this function has no evidence for (`surfaceCaption` in
 *  layer-registry.js is the one place a claimed observation/vintage time belongs). */
export function layerAboutText({ layer, source = null, fetchedAt = null, featureCount = null }) {
  const lines = [];
  if (source) lines.push(`Source: ${source.name} (${source.origin}).`);
  else if (layer.localData) lines.push(`Source: this site’s own data export (${layer.localData}).`);
  else if (layer.stateScoped) lines.push('Source: the state’s own published land-boundary service.');
  if (source?.attribution) lines.push(source.attribution);
  if (layer.coverageCaveat) lines.push(layer.coverageCaveat);
  lines.push(fetchedAt ? `Fetched ${fetchedAt}.` : 'Not fetched yet.');
  if (featureCount !== null) lines.push(`${plural(featureCount, 'feature')} in the last check.`);
  return lines.join(' ');
}
