// QUX-11a/11b: "Places in this view" -- every named place already fetched whose
// point falls inside the current map bounds, independent of the screen
// declutter cap (name-labels.js's placeScreenLabels), PLUS (11b, QUX-11.md
// §2.6) every fetched recreation site (Forest Service and BLM) in the same
// list, under the same filters. Pure -- no DOM, no fetch, no clock reads; the
// caller (Q/main.js) supplies `names`/`namesStatus`/`placedIds`/`bounds` and
// `recSites`/`recStates`/`nearbyFrom` fresh on every render. `names` is
// already run through name-labels.js's dedupeAgainstTownLabels by the caller
// -- the same gate renderNames' own declutter loop reads through -- so this
// module never reads window.qcTownLabels (or window at all) itself.
//
// Two hard rules from the plan review (.data/plans/2026-09-27-qux-specs/QUX-11.md):
//   - Building, filtering and sorting this list makes no request of its own.
//   - Every name the declutter loop hides stays reachable here under the
//     default filters; the list never reads as an all-clear when the names
//     answer was incomplete or refused. The same now holds per recreation
//     provider: a partial or unavailable FS/BLM answer gets its own notice,
//     never a count it cannot back.
import { NAME_ICON_BY_KIND } from './print-names.js';
import { STATUS_MESSAGE, iconFor } from './name-labels.js';
import { distanceToPathsMeters, milesText } from './near-unpaved.js';
import { routeAnchor, routeName, ROAD_NAME_ID_PREFIX, roadNameCardLines } from './route-identify.js';

const NOT_LOADED_MESSAGE = 'Named places have not loaded for this view yet.';
const FS_PARTIAL_MESSAGE = 'Forest Service sites: the answer for this view was cut short, so some may be missing.';
const FS_UNAVAILABLE_MESSAGE = 'Forest Service sites could not load for this view.';
const BLM_PARTIAL_MESSAGE = 'BLM sites: the answer for this view was cut short, so some may be missing.';
const BLM_UNAVAILABLE_MESSAGE = 'BLM sites could not load for this view.';

/** id -> {label, match(feature)}, tried in this order; the first match wins.
 *  `landforms` is the GNIS catch-all -- `!f.provider` rather than an
 *  unconditional `true`, now that rec rows (11b) walk this same table: a rec
 *  site always carries a `provider`, so it can never fall through to a GNIS
 *  group. A test walks every key of NAME_ICON_BY_KIND (print-names.js) and
 *  asserts each lands in exactly one GNIS group. */
export const PLACE_GROUPS = Object.freeze([
  { id: 'peaks', label: 'Peaks', match: (f) => f.kind === 'summit' },
  { id: 'waterfalls', label: 'Waterfalls', match: (f) => f.kind === 'water-feature' && f.cls === 'Falls' },
  { id: 'water', label: 'Other water', match: (f) => f.kind === 'water-feature' || f.kind === 'other-water' || f.kind === 'stream-mouth'
    || f.kind === 'river' || f.kind === 'creek' },
  { id: 'gaps-ridges', label: 'Gaps and ridges', match: (f) => f.kind === 'gap' || f.kind === 'ridge' },
  { id: 'places', label: 'Towns and places', match: (f) => f.kind === 'place' },
  // QQA-08: roads and trails. A row here carries `routeKind` (route-identify.js's group, or
  // 'name' for a road lettered on the map) and no `kind`/`provider`, so nothing above or
  // below can claim it; tried before the rec groups for the same reason they precede
  // `landforms`.
  { id: 'forest-roads', label: 'Forest roads', match: (f) => f.routeKind === 'mvum-road' },
  { id: 'forest-trails', label: 'Forest and other trails', match: (f) => f.routeKind === 'mvum-trail' || f.routeKind === 'trail' },
  { id: 'roads-lettered', label: 'Roads lettered on the map', match: (f) => f.routeKind === 'name' },
  // 11b: recreation-site groups, tried before the GNIS catch-all so a rec row
  // never reaches it. Trailheads first -- a mapped symbolKey beats the
  // generic rec-sites catch-all, the same "type decides first" rule
  // source-rec-sites.js's symbolKeyForSite uses.
  { id: 'trailheads', label: 'Trailheads', match: (f) => !!f.provider && f.symbolKey === 'rec-trailhead' },
  { id: 'rec-sites', label: 'Recreation sites', match: (f) => !!f.provider },
  { id: 'landforms', label: 'Other landforms', match: (f) => !f.provider && !f.routeKind },
]);

function groupFor(feature) {
  return PLACE_GROUPS.find((g) => g.match(feature)) || PLACE_GROUPS[PLACE_GROUPS.length - 1];
}

/** A GNIS feature's `anchor` (terrain-names.js) is `[lat, lon]`; a rec site's
 *  `lonLat` (source-rec-sites.js / source-blm-rec-sites.js) is already
 *  `[lon, lat]`. Returns `[lon, lat]` either way, so a bounds check never has
 *  to know which shape it holds. */
function pointOf(item) {
  if (Array.isArray(item.anchor)) return [item.anchor[1], item.anchor[0]];
  if (Array.isArray(item.lonLat)) return item.lonLat;
  return [NaN, NaN];
}

function inBounds([lon, lat], bounds) {
  return lon >= bounds.minLon && lon <= bounds.maxLon && lat >= bounds.minLat && lat <= bounds.maxLat;
}

/** GNIS's own class word (e.g. "Falls", "Summit") when the feature carries
 *  one, else the icon table's kind label -- so a row's secondary text is
 *  never the raw internal kind key (`water-feature`, `other-land`, ...). */
function kindTextOf(feature) {
  return feature.cls || iconFor(feature.kind).label;
}

export function defaultFilters() {
  return { groups: new Set(PLACE_GROUPS.map((g) => g.id)), onlyNotLabelled: false, sort: 'az' };
}

const EMPTY_GROUP_COUNTS = () => Object.fromEntries(PLACE_GROUPS.map((g) => [g.id, 0]));
const noRows = (notices) => ({ rows: [], total: null, shown: 0, hiddenByFilters: 0, notLabelled: 0, groupCounts: EMPTY_GROUP_COUNTS(), notices });

/** 11b: `rec:<provider>:<lon.toFixed(5)>,<lat.toFixed(5)>`, a `~2`/`~3` suffix
 *  for a coordinate two or more sites share, assigned by walking the sites in
 *  a DETERMINISTIC order (name, then original index) so the id a row gets
 *  never depends on fetch/array order. Computed over the WHOLE `recSites`
 *  array, never a bounds-filtered subset -- a row's id (and Q/main.js's
 *  `recPins` key, built by calling this same function) must not change as
 *  the map pans, only which rows the current view happens to show. Returns a
 *  `Map` keyed by site object identity. */
export function assignRecIds(recSites = []) {
  const list = (recSites || []).filter((s) => s && Array.isArray(s.lonLat)
    && Number.isFinite(s.lonLat[0]) && Number.isFinite(s.lonLat[1]) && s.provider);
  const ordered = list
    .map((site, i) => ({ site, i }))
    .sort((a, b) => (a.site.name || '').localeCompare(b.site.name || '', 'en', { sensitivity: 'base' }) || a.i - b.i);
  const counts = new Map();
  const ids = new Map();
  for (const { site } of ordered) {
    const base = `rec:${site.provider}:${site.lonLat[0].toFixed(5)},${site.lonLat[1].toFixed(5)}`;
    const n = (counts.get(base) || 0) + 1;
    counts.set(base, n);
    ids.set(site, n === 1 ? base : `${base}~${n}`);
  }
  return ids;
}

function pointDistanceMeters(from, to) {
  if (!Array.isArray(from) || !Array.isArray(to)) return null;
  return distanceToPathsMeters(from, [[to, to]]);
}

/** `names`: the fetched GNIS features array, already deduped against any live
 *  town labels by the caller (dedupeAgainstTownLabels, name-labels.js), or
 *  `null`/undefined before any fetch has returned one. `namesStatus`:
 *  fetchBounded's status, or `null`/undefined pre-fetch. `placedIds`: the ids
 *  placeScreenLabels (name-labels.js) actually drew this render (a Set or an
 *  iterable of ids). `bounds`: `{minLon, minLat, maxLon, maxLat}`. `filters`:
 *  `{groups: Set<groupId>, onlyNotLabelled, sort: 'az'|'nearby'}`, defaulting
 *  to `defaultFilters()`.
 *
 *  11b additions: `recSites` -- the shared `state.recSites` array (both the
 *  Forest Service and BLM layers write into it; `source` on each row tells
 *  them apart). `recStates` -- `{recSites, blmRecSites}`, each
 *  `'ready'|'partial'|'unavailable'` or absent (layer off / not fetched
 *  yet) -- the two independent per-provider statuses `state.states` already
 *  carries. `nearbyFrom` -- `{id, name, lonLat}`, the place a "Nearby" sort
 *  is measured from, or `null`. A rec row is always `onMap: true`: unlike a
 *  GNIS label a rec pin carries no screen-declutter cap, so every fetched
 *  site in view is drawn.
 *
 *  `total`/`notLabelled`/`groupCounts` are counted BEFORE filtering (across
 *  both GNIS and rec rows); `shown` is counted AFTER; `hiddenByFilters =
 *  total - shown`. `total` is `null` (never `0`) only when NOTHING can be
 *  trusted at all -- GNIS never answered ready/partial AND neither
 *  recreation provider did either. Once any one of the three answered, `0`
 *  means that combination genuinely found nothing here. */
export function placesInView({
  names, namesStatus, placedIds, bounds, filters, selectedId = null,
  recSites, recStates, nearbyFrom = null, routes, roadNames,
} = {}) {
  const status = namesStatus ?? null;
  const rs = recStates || {};
  const recState = rs.recSites ?? null;
  const blmState = rs.blmRecSites ?? null;
  const gnisReady = status === 'ready' || status === 'partial';
  const recReady = recState === 'ready' || recState === 'partial';
  const blmReady = blmState === 'ready' || blmState === 'partial';
  // QQA-08: drawn forest roads and trails (route-identify.js's collectRoutes) and the roads
  // lettered on the map (road-labels.js's placed labels). Both are what is ON the map right
  // now, so a non-empty one is an answer in its own right; an empty one answers nothing.
  const routeList = Array.isArray(routes) ? routes : [];
  const lettered = Array.isArray(roadNames) ? roadNames : [];
  const roadsReady = routeList.length > 0 || lettered.length > 0;

  if (!gnisReady && !recReady && !blmReady && !roadsReady) {
    const notices = [status == null ? NOT_LOADED_MESSAGE : STATUS_MESSAGE[status]];
    if (recState === 'unavailable') notices.push(FS_UNAVAILABLE_MESSAGE);
    if (blmState === 'unavailable') notices.push(BLM_UNAVAILABLE_MESSAGE);
    return noRows(notices.filter(Boolean));
  }

  const f = filters || defaultFilters();
  const ids = placedIds instanceof Set ? placedIds : new Set(placedIds || []);
  const groupCounts = EMPTY_GROUP_COUNTS();

  // --- GNIS rows -----------------------------------------------------------
  const gnisList = gnisReady && Array.isArray(names) ? names : [];
  const gnisInView = gnisList.filter((feat) => inBounds(pointOf(feat), bounds));
  const gnisRows = gnisInView.map((feat) => {
    const group = groupFor(feat);
    groupCounts[group.id]++;
    const labelled = status === 'ready' && ids.has(feat.id);
    const reason = labelled ? 'labelled' : (status === 'partial' ? 'incomplete-answer' : 'no-room');
    return {
      id: feat.id, source: 'gnis', name: feat.name, kindText: kindTextOf(feat), group: group.id,
      state: feat.state, lonLat: pointOf(feat),
      onMap: reason !== 'no-room' && reason !== 'incomplete-answer',
      reason, selected: feat.id === selectedId,
    };
  });

  // --- Recreation-site rows (11b) -------------------------------------------
  const recList = Array.isArray(recSites) ? recSites : [];
  const recIds = assignRecIds(recList);
  const recRowsAll = recList.filter((s) => recIds.has(s)).map((site) => {
    const group = groupFor(site);
    const id = recIds.get(site);
    return {
      id, source: site.provider,
      name: site.name || (site.provider === 'usfs' ? 'Unnamed Forest Service recreation site' : 'Unnamed BLM recreation site'),
      kindText: site.siteType || group.label, group: group.id,
      state: null, lonLat: site.lonLat, onMap: true, reason: 'labelled',
      selected: id === selectedId,
    };
  });
  const recRows = recRowsAll.filter((r) => inBounds(r.lonLat, bounds));
  for (const r of recRows) groupCounts[r.group]++;

  // --- Road and trail rows (QQA-08) ----------------------------------------
  // A route is listed when one of its vertices is in view (routeAnchor): a line that
  // crosses the view between two vertices is on the map and not in the list.
  const roadRows = [];
  for (const route of routeList) {
    const lonLat = routeAnchor(route, bounds);
    if (!lonLat) continue;
    const group = groupFor({ routeKind: route.group });
    roadRows.push({
      id: route.id, source: 'route', name: routeName(route), kindText: route.kindLabel, group: group.id,
      state: null, lonLat, onMap: true, reason: 'labelled', selected: route.id === selectedId,
    });
  }
  for (const entry of lettered) {
    if (!inBounds([entry.lon, entry.lat], bounds)) continue;
    const id = `${ROAD_NAME_ID_PREFIX}${entry.key}`;
    roadRows.push({
      id, source: 'road-name', name: entry.label, kindText: roadNameCardLines(entry)[1], group: groupFor({ routeKind: 'name' }).id,
      state: null, lonLat: [entry.lon, entry.lat], onMap: true, reason: 'labelled', selected: id === selectedId,
    });
  }
  for (const r of roadRows) groupCounts[r.group]++;

  const rows = [...gnisRows, ...recRows, ...roadRows];
  const total = rows.length;
  const notLabelled = rows.filter((r) => !r.onMap).length;

  const notices = [];
  if (status === 'partial') notices.push(STATUS_MESSAGE.partial);
  if (recState === 'partial') notices.push(FS_PARTIAL_MESSAGE);
  else if (recState === 'unavailable') notices.push(FS_UNAVAILABLE_MESSAGE);
  if (blmState === 'partial') notices.push(BLM_PARTIAL_MESSAGE);
  else if (blmState === 'unavailable') notices.push(BLM_UNAVAILABLE_MESSAGE);
  if (!notices.length && total === 0) notices.push(STATUS_MESSAGE.zero);

  const filtered = rows.filter((r) => f.groups.has(r.group) && (!f.onlyNotLabelled || !r.onMap));
  const nearby = f.sort === 'nearby' && nearbyFrom && Array.isArray(nearbyFrom.lonLat);
  if (nearby) {
    for (const r of filtered) {
      r.distanceMeters = pointDistanceMeters(nearbyFrom.lonLat, r.lonLat);
      r.distanceText = r.distanceMeters == null ? null : milesText(r.distanceMeters);
    }
  }
  filtered.sort((a, b) => {
    if (nearby) {
      const ad = a.distanceMeters, bd = b.distanceMeters;
      if (ad != null && bd != null && ad !== bd) return ad - bd;
      if ((ad != null) !== (bd != null)) return ad != null ? -1 : 1;
    }
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });

  return { rows: filtered, total, shown: filtered.length, hiddenByFilters: total - filtered.length, notLabelled, groupCounts, notices };
}
