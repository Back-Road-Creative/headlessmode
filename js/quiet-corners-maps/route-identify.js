// QQA-08: asking what a forest road or trail IS. Pure: no DOM, no Leaflet, no fetch.
//
// The drawn lines are 2-5 px wide and a fingertip is not, so a line cannot be the tap
// target: main.js listens on the map, and this module answers "which routes are within
// `tolerancePx` of that point" in SCREEN pixels. Two routes under one fingertip are both
// returned and main.js offers a choice rather than picking one. The same module builds the
// card lines, so a tap, a mouse click and a Places in this view row cannot word the same
// road two ways, and gives every route and lettered road one stable id.
//
// Ids: road:mvum-road:<id>, road:mvum-trail:<id>, road:trail:<id> (a National Map trail)
// and road:name:<key> (a road lettered on the map, road-names.js's normalised label). They
// sit beside gnis:<id> and rec:<provider>:<lon>,<lat> in the same list and never collide.
import { SOURCES } from './source-registry.js';
import { TRAILS_SOURCE } from './source-trails.js';
import { ROAD_CLASSES } from './road-names.js';
import { measureLength, formatLength } from './measure.js';

/** A finger covers about a centimetre; a mouse is exact. */
export const TOUCH_TOLERANCE_PX = 12;
export const POINTER_TOLERANCE_PX = 6;
export const ROAD_NAME_ID_PREFIX = 'road:name:';

/** `pointerType` is what made the click ('mouse' | 'touch' | 'pen'); a click that cannot say
 *  gets the generous target, because a missed tap is worse than an extra chooser entry. */
export const toleranceFor = (pointerType) => (pointerType === 'mouse' ? POINTER_TOLERANCE_PX : TOUCH_TOLERANCE_PX);

/** Symbol key -> what kind of route it is, or null for anything that is not a road or trail. */
export function routeKindOf(symbolKey) {
  if (typeof symbolKey !== 'string') return null;
  if (symbolKey.startsWith('mvum-road-')) return { group: 'mvum-road', label: 'Forest road' };
  if (symbolKey.startsWith('mvum-trail-')) return { group: 'mvum-trail', label: 'Forest trail' };
  if (symbolKey === 'trail-nst') return { group: 'trail', label: 'National Scenic or Historic Trail' };
  if (symbolKey.startsWith('trail-')) return { group: 'trail', label: 'Trail' };
  return null;
}

const CREDIT = { 'mvum-road': SOURCES.usfsMvum.attribution, 'mvum-trail': SOURCES.usfsMvum.attribution, trail: TRAILS_SOURCE.attribution };
const USE_WORD = { hike: 'hiking', bike: 'biking', horse: 'horseback riding', motor: 'motorcycles' };

/** The trail facts a card can state: the national designation and the allowed uses, the
 *  latter only as the source gave them (null = silence, never "none"). */
export function trailDetailLines(f) {
  if (!f || !f.symbolKey || !f.symbolKey.startsWith('trail-')) return [];
  const out = [];
  if (f.designation) out.push(`Designation: ${f.designation}`);
  if (Array.isArray(f.uses)) out.push(f.uses.length ? `Allowed uses: ${f.uses.map((u) => USE_WORD[u] || u).join(', ')}` : 'Allowed uses: none stated as allowed');
  else out.push('Allowed uses: not stated by the source');
  return out;
}

const at5 = ([lat, lon]) => `${lon.toFixed(5)},${lat.toFixed(5)}`;

/** previewPolylines output -> one route per feature id and kind, however many segments it
 *  was drawn in. A route is `{id, group, kindLabel, name, ref, detail, credit, parts}`;
 *  each part is `{latlngs, bbox: [south, west, north, east]}`. Anything that is not a
 *  forest road or trail (a land boundary) is left out. */
export function collectRoutes(polylines = []) {
  const byId = new Map();
  for (const p of polylines) {
    const kind = routeKindOf(p.symbolKey);
    if (!kind || !Array.isArray(p.latlngs) || p.latlngs.length < 2) continue;
    const raw = p.id ?? (p.objectId != null ? `objectid:${p.objectId}` : `at:${at5(p.latlngs[0])}`);
    const id = `road:${kind.group}:${raw}`;
    let r = byId.get(id);
    if (!r) {
      r = { id, group: kind.group, kindLabel: kind.label, name: p.name || null, ref: p.id ?? null, detail: [], credit: CREDIT[kind.group], parts: [], forests: [] };
      byId.set(id, r);
    }
    // MVUM route numbers are unique within a national forest, not across them: the same id from
    // two forests is two roads drawn as one, which routeCompleteness refuses to call whole.
    if (p.forest && !r.forests.includes(p.forest)) r.forests.push(p.forest);
    if (!r.name && p.name) r.name = p.name;
    for (const line of p.detail || []) if (line && !r.detail.includes(line)) r.detail.push(line);
    const lats = p.latlngs.map((q) => q[0]), lons = p.latlngs.map((q) => q[1]);
    r.parts.push({ latlngs: p.latlngs, bbox: [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)] });
  }
  return [...byId.values()];
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Routes within `tolerancePx` of `point` ({x, y}, the same pixel space `toPx` answers in),
 *  nearest first, one entry per route. `toPx([lat, lon])` -> {x, y}. A part's box is tested
 *  first, grown by the tolerance, so a click only projects the lines it could be near. */
export function hitRoutes(routes, point, { toPx, tolerancePx }) {
  const hits = [];
  for (const route of routes || []) {
    let best = Infinity;
    for (const part of route.parts) {
      const [s, w, n, e] = part.bbox, a = toPx([s, w]), b = toPx([n, e]);
      if (point.x < Math.min(a.x, b.x) - tolerancePx || point.x > Math.max(a.x, b.x) + tolerancePx
        || point.y < Math.min(a.y, b.y) - tolerancePx || point.y > Math.max(a.y, b.y) + tolerancePx) continue;
      const px = part.latlngs.map(toPx);
      for (let i = 1; i < px.length; i += 1) best = Math.min(best, distanceToSegment(point, px[i - 1], px[i]));
    }
    if (best <= tolerancePx) hits.push({ route, distancePx: best });
  }
  return hits.sort((x, y) => x.distancePx - y.distancePx);
}

/** The name a route goes by in a list or a card. */
export const routeName = (route) => route.name || `Unnamed ${route.kindLabel.toLowerCase()}`;

const PART_OF_VIEW = 'only the part loaded in this view';

/** Whether a route's loaded geometry is the WHOLE route: `{complete, reason}` (reason null when complete).
 *  `ctx` is `{fetchedFor: {minLon, minLat, maxLon, maxLat}, coverage: {<group>: 'ready'|...}, truncated: Set<group>}`;
 *  none given, or any part unknown, means NOT complete -- a length is never claimed whole on a guess.
 *  Why "every vertex strictly inside the fetched box" is enough: the services answer an envelope query with
 *  each intersecting feature in full, so any other segment joined to a vertex inside the box also
 *  intersects the box and was fetched; a vertex on or past the edge could join one that was not. */
export function routeCompleteness(route, ctx) {
  const no = (reason) => ({ complete: false, reason });
  if (!ctx) return no('whether the whole route is loaded cannot be known here');
  if (route.ref == null) return no('the source gave this line no route id, so it is one mapped segment');
  if ((route.forests?.length || 0) > 1) return no(`route ${route.ref} is a number in ${route.forests.length} national forests here, so these lines may be different roads`);
  const box = ctx.fetchedFor;
  if (!box) return no('the area the data was asked for is not known');
  const inside = route.parts.every((p) => p.latlngs.every(([lat, lon]) => lon > box.minLon && lon < box.maxLon && lat > box.minLat && lat < box.maxLat));
  if (!inside) return no(PART_OF_VIEW);
  const coverage = ctx.coverage?.[route.group];
  if (coverage !== 'ready') return no(`the source's answer for this area is ${coverage === 'partial' ? 'partial' : 'not confirmed complete'}`);
  if (ctx.truncated?.has(route.group)) return no('the preview draws only some of the routes of this kind');
  return { complete: true, reason: null };
}

/** The route's length as a fact record: geodesic metres of the loaded geometry, graded by routeCompleteness. */
export function routeLengthFact(route, ctx) {
  const { complete, reason } = routeCompleteness(route, ctx);
  return measureLength({ type: 'MultiLineString', coordinates: route.parts.map((p) => p.latlngs.map(([lat, lon]) => [lon, lat])) },
    { source: route.credit, complete, reason });
}

function lengthLines(route, ctx) {
  const fact = routeLengthFact(route, ctx);
  const text = formatLength(fact);
  if (text === null) return [`Length: unavailable (${fact.reason})`];
  // One line, not two: a card's height decides how far the map pans to show it, and every extra
  // line moved the view off roads the reader had in it.
  return [`Length: ${text}${fact.status === 'approximate' ? `, approximate — ${fact.reason}` : ''} (basis: loaded geometry, WGS84)`];
}

/** The card, one string per line: the name leads (it names the card), the length follows what the
 *  source said, and the credit closes it. `ctx` is routeCompleteness's. */
export function routeCardLines(route, ctx = null) {
  return [routeName(route), route.kindLabel,
    ...(!route.name && route.ref != null ? [`Route id: ${route.ref}`] : []),
    ...route.detail, ...lengthLines(route, ctx), `Source: ${route.credit}`];
}

/** Where a route sits in the view: its vertex nearest the middle of `bounds`, as [lon, lat],
 *  or null when no vertex is in view. Vertices only -- a line that crosses the view between
 *  two vertices is not listed. */
export function routeAnchor(route, bounds) {
  const cx = (bounds.minLon + bounds.maxLon) / 2, cy = (bounds.minLat + bounds.maxLat) / 2;
  let best = null, bestD = Infinity;
  for (const part of route.parts) {
    for (const [lat, lon] of part.latlngs) {
      if (lon < bounds.minLon || lon > bounds.maxLon || lat < bounds.minLat || lat > bounds.maxLat) continue;
      const d = Math.hypot(lon - cx, lat - cy);
      if (d < bestD) { bestD = d; best = [lon, lat]; }
    }
  }
  return best;
}

const CLASS_NAME = Object.fromEntries(ROAD_CLASSES.map((c) => [c.key, c.name]));

/** The card for a road lettered on the map (a placed label from road-labels.js). */
export function roadNameCardLines(entry) {
  return [entry.label, CLASS_NAME[entry.classKey] || 'Road', `Source: ${SOURCES.usgsRoadNames.attribution}`];
}
