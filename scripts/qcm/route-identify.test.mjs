// QQA-08 slice 1: tap-to-identify for forest roads and trails -- the pure half. A finger
// is a ~12 px target and a 2 px line is not, so the hit test runs in screen pixels against
// the drawn lines, and two lines under one fingertip are offered as a choice instead of
// one being picked silently. No DOM, no Leaflet, no fetch: run under plain node --test.
// The rendered half (a real tap, the chooser, the card, Places in this view) is
// tap-identify-browser.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOUCH_TOLERANCE_PX, POINTER_TOLERANCE_PX, toleranceFor, routeKindOf, collectRoutes, hitRoutes,
  routeCardLines, routeAnchor, roadNameCardLines, ROAD_NAME_ID_PREFIX, routeCompleteness, routeLengthFact,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/route-identify.js';
import { previewPolylines } from '../../themes/headlessmode/static/js/quiet-corners-maps/preview-overlay.js';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';

// 1 px = 1e-5 degree, y down: a line drawn at lat 35.0 + k*1e-5 sits k px above the axis.
const toPx = ([lat, lon]) => ({ x: (lon + 83.5) * 1e5, y: -(lat - 35) * 1e5 });
const line = (...pts) => pts.map(([x, y]) => [35 - y / 1e5, -83.5 + x / 1e5]);   // px -> [lat, lon]
const poly = (over) => ({ key: 'x', id: null, symbolKey: 'mvum-road-yearlong', name: null, detail: [], latlngs: line([0, 0], [100, 0]), ...over });

test('the finger gets about 12 CSS px and the mouse a tighter 6', () => {
  assert.equal(TOUCH_TOLERANCE_PX, 12);
  assert.equal(POINTER_TOLERANCE_PX, 6);
  assert.equal(toleranceFor('touch'), 12);
  assert.equal(toleranceFor('pen'), 12);
  assert.equal(toleranceFor(undefined), 12, 'a click that cannot say what made it gets the generous target');
  assert.equal(toleranceFor('mouse'), 6);
});

test('symbol keys sort into forest road, forest trail and national-map trail; anything else is not a route', () => {
  assert.equal(routeKindOf('mvum-road-seasonal').group, 'mvum-road');
  assert.equal(routeKindOf('mvum-road-seasonal').label, 'Forest road');
  assert.equal(routeKindOf('mvum-trail-unknown').group, 'mvum-trail');
  assert.equal(routeKindOf('trail-nonmotor').group, 'trail');
  assert.equal(routeKindOf('trail-nonmotor-unstated').group, 'trail');
  assert.equal(routeKindOf('trail-nst').group, 'trail');
  assert.equal(routeKindOf('trail-nst').label, 'National Scenic or Historic Trail');
  assert.equal(routeKindOf('land-state-park'), null);
  assert.equal(routeKindOf(undefined), null);
});

test('previewPolylines carries what a card needs: symbol key, name, road quality, access and trail class', () => {
  const road = { id: '67', name: 'Forest Road 67', layer: 'road', seasonal: 'yearlong', paths: [[[-83.5, 35], [-83.49, 35]]],
    vehicles: { passenger: { allowed: 'open', datesOpen: null }, highClearance: { allowed: 'open', datesOpen: null } } };
  const trail = { id: 'fx-nst', name: 'Appalachian Trail', symbolKey: 'trail-nst', designation: 'NST - Appalachian', uses: ['hike'], paths: [[[-83.5, 35.01], [-83.49, 35.01]]] };
  const [r, t] = previewPolylines([road, trail], { roadQuality: { 67: { surface: 'gravel', maintLevel: 3, maintText: 'Moderate' } }, scale: 24000 });
  assert.equal(r.symbolKey, 'mvum-road-yearlong');
  assert.equal(r.name, 'Forest Road 67');
  assert.ok(r.detail.some((l) => /level 3/.test(l)), `road quality is in the detail: ${JSON.stringify(r.detail)}`);
  assert.ok(r.detail.some((l) => /year-round/.test(l)), `access is in the detail: ${JSON.stringify(r.detail)}`);
  assert.equal(t.symbolKey, 'trail-nst');
  assert.ok(t.detail.includes('Designation: NST - Appalachian'), JSON.stringify(t.detail));
  assert.ok(t.detail.includes('Allowed uses: hiking'), JSON.stringify(t.detail));
  assert.match(r.title, /^Forest Road 67 — /, 'the hover title is unchanged');
});

test('a trail whose uses the source did not state says so, and is never read as a prohibition', () => {
  const trail = { id: 't1', name: 'Quiet Trail', symbolKey: 'trail-nonmotor-unstated', designation: null, uses: null, paths: [[[-83.5, 35], [-83.49, 35]]] };
  const [t] = previewPolylines([trail], { scale: 24000 });
  assert.ok(t.detail.includes('Allowed uses: not stated by the source'), JSON.stringify(t.detail));
});

test('collectRoutes: one route per feature id, however many segments it was drawn in', () => {
  const routes = collectRoutes([
    poly({ id: '67', name: 'Forest Road 67', detail: ['Open to passenger vehicles year-round'], latlngs: line([0, 0], [50, 0]) }),
    poly({ id: '67', name: 'Forest Road 67', detail: ['Open to passenger vehicles year-round', 'Gravel'], latlngs: line([50, 0], [100, 0]) }),
    poly({ id: '9', name: 'Trail Nine', symbolKey: 'trail-nonmotor', latlngs: line([0, 30], [100, 30]) }),
    poly({ id: 'park', symbolKey: 'land-state-park', latlngs: line([0, 60], [100, 60]) }),
  ]);
  assert.deepEqual(routes.map((r) => r.id), ['road:mvum-road:67', 'road:trail:9']);
  const road = routes[0];
  assert.equal(road.parts.length, 2);
  assert.deepEqual(road.detail, ['Open to passenger vehicles year-round', 'Gravel'], 'distinct lines merged, none repeated');
  assert.equal(road.kindLabel, 'Forest road');
  assert.equal(road.group, 'mvum-road');
});

test('collectRoutes: ids are stable when the same feature is drawn again, and never collide across kinds', () => {
  const a = collectRoutes([poly({ id: '5' }), poly({ id: '5', symbolKey: 'mvum-trail-yearlong' }), poly({ id: '5', symbolKey: 'trail-nst' })]);
  const b = collectRoutes([poly({ id: '5', symbolKey: 'trail-nst' }), poly({ id: '5' }), poly({ id: '5', symbolKey: 'mvum-trail-yearlong' })]);
  assert.deepEqual(a.map((r) => r.id).sort(), ['road:mvum-road:5', 'road:mvum-trail:5', 'road:trail:5']);
  assert.deepEqual(b.map((r) => r.id).sort(), a.map((r) => r.id).sort());
  assert.ok(a.every((r) => /^road:(mvum-road|mvum-trail|trail):/.test(r.id)));
});

test('collectRoutes: a feature with no id still gets a stable id, from its object id else its first vertex', () => {
  const [byOid] = collectRoutes([poly({ id: null, objectId: 77 })]);
  assert.equal(byOid.id, 'road:mvum-road:objectid:77');
  const [byVertex] = collectRoutes([poly({ id: null, latlngs: [[35.123456, -83.654321], [35.2, -83.6]] })]);
  assert.equal(byVertex.id, 'road:mvum-road:at:-83.65432,35.12346');
});

test('collectRoutes: each route carries the credit of the source that drew it', () => {
  const [road, trail] = collectRoutes([poly({ id: '1' }), poly({ id: '2', symbolKey: 'trail-nonmotor' })]);
  assert.equal(road.credit, SOURCES.usfsMvum.attribution);
  assert.match(trail.credit, /^USGS The National Map/);
});

test('hitRoutes: a line 10 px away is hit by a finger and missed by a mouse', () => {
  const routes = collectRoutes([poly({ id: '1', name: 'Road One' })]);
  const tap = { x: 50, y: 10 };
  assert.deepEqual(hitRoutes(routes, tap, { toPx, tolerancePx: 12 }).map((h) => h.route.id), ['road:mvum-road:1']);
  assert.deepEqual(hitRoutes(routes, tap, { toPx, tolerancePx: 6 }), []);
});

test('hitRoutes: distance is to the segment, not the infinite line, so past the end is a miss', () => {
  const routes = collectRoutes([poly({ id: '1' })]);                    // x from 0 to 100
  assert.equal(hitRoutes(routes, { x: 111, y: 0 }, { toPx, tolerancePx: 12 }).length, 1, '11 px beyond the end is within 12');
  assert.equal(hitRoutes(routes, { x: 113, y: 0 }, { toPx, tolerancePx: 12 }).length, 0, '13 px beyond the end is not');
});

test('hitRoutes: two routes under one fingertip both come back, nearest first; one route twice comes back once', () => {
  const routes = collectRoutes([
    poly({ id: 'near', name: 'Near', latlngs: line([0, 2], [100, 2]) }),
    poly({ id: 'near', name: 'Near', latlngs: line([0, 3], [100, 3]) }),
    poly({ id: 'far', name: 'Far', symbolKey: 'trail-nonmotor', latlngs: line([0, -8], [100, -8]) }),
    poly({ id: 'gone', name: 'Gone', latlngs: line([0, 40], [100, 40]) }),
  ]);
  const hits = hitRoutes(routes, { x: 50, y: 0 }, { toPx, tolerancePx: 12 });
  assert.deepEqual(hits.map((h) => h.route.id), ['road:mvum-road:near', 'road:trail:far']);
  assert.ok(hits[0].distancePx < hits[1].distancePx);
  assert.ok(Math.abs(hits[0].distancePx - 2) < 0.01);
});

test('hitRoutes: a perfectly horizontal or vertical line (a zero-height box) is still found', () => {
  const routes = collectRoutes([poly({ id: 'h', latlngs: line([0, 0], [100, 0]) }), poly({ id: 'v', latlngs: line([200, -50], [200, 50]) })]);
  assert.equal(hitRoutes(routes, { x: 50, y: 5 }, { toPx, tolerancePx: 12 }).length, 1);
  assert.equal(hitRoutes(routes, { x: 205, y: 0 }, { toPx, tolerancePx: 12 }).length, 1);
});

test('hitRoutes: nothing near, nothing returned; no routes, nothing returned', () => {
  const routes = collectRoutes([poly({ id: '1' })]);
  assert.deepEqual(hitRoutes(routes, { x: 50, y: 400 }, { toPx, tolerancePx: 12 }), []);
  assert.deepEqual(hitRoutes([], { x: 0, y: 0 }, { toPx, tolerancePx: 12 }), []);
});

test('the card says name, kind, what the data knows, and where it came from -- last', () => {
  const [road] = collectRoutes([poly({ id: '67', name: 'Forest Road 67', detail: ['Gravel; moderate (level 3)', 'Open to passenger vehicles year-round'] })]);
  const lines = routeCardLines(road);
  assert.equal(lines[0], 'Forest Road 67');
  assert.equal(lines[1], 'Forest road');
  assert.deepEqual(lines.slice(2, 4), ['Gravel; moderate (level 3)', 'Open to passenger vehicles year-round']);
  assert.equal(lines.at(-1), `Source: ${SOURCES.usfsMvum.attribution}`);
});

test('an unnamed route is said to be unnamed, with the source id so it can still be told apart', () => {
  const [t] = collectRoutes([poly({ id: 'abc-123', symbolKey: 'trail-nonmotor' })]);
  const lines = routeCardLines(t);
  assert.equal(lines[0], 'Unnamed trail');
  assert.ok(lines.includes('Route id: abc-123'), JSON.stringify(lines));
});

test('routeAnchor: the in-view vertex nearest the middle of the view, [lon, lat]; null when no vertex is in view', () => {
  const [r] = collectRoutes([poly({ id: '1', latlngs: [[35.01, -83.5], [35.02, -83.49], [35.03, -83.48]] })]);
  const bounds = { minLon: -83.495, maxLon: -83.47, minLat: 35.0, maxLat: 35.04 };
  assert.deepEqual(routeAnchor(r, bounds), [-83.49, 35.02], 'of the two vertices in view, the one nearer the centre (-83.4825, 35.02)');
  assert.equal(routeAnchor(r, { minLon: -90, maxLon: -89, minLat: 10, maxLat: 11 }), null);
});

test('a road lettered on the map is a route-shaped id of its own, with its class and the road-names credit', () => {
  assert.equal(ROAD_NAME_ID_PREFIX, 'road:name:');
  const lines = roadNameCardLines({ key: 'wayah road', label: 'Wayah Road', classKey: 'connecting' });
  assert.equal(lines[0], 'Wayah Road');
  assert.equal(lines[1], 'Local Connecting Roads');
  assert.equal(lines.at(-1), `Source: ${SOURCES.usgsRoadNames.attribution}`);
});

// QQA-09: the length a card states, and whether it is the whole route or only what is loaded.
// 0.01 degree of longitude at 35 N is 912.9 m on the ellipsoid (0.57 mi).
const FETCHED = { minLon: -83.6, minLat: 34.9, maxLon: -83.4, maxLat: 35.1 };
const READY = { 'mvum-road': 'ready', 'mvum-trail': 'ready', trail: 'ready' };
const here = (over = {}) => ({ fetchedFor: FETCHED, coverage: READY, truncated: new Set(), ...over });
const flat = (lon1, lon2, lat = 35) => [[lat, lon1], [lat, lon2]];
const road = (latlngs, over = {}) => collectRoutes([poly({ id: '67', name: 'Forest Road 67', latlngs, ...over })])[0];

test('QQA-09: a route wholly inside the fetched box, from a ready source with nothing cut, is complete', () => {
  const r = road(flat(-83.5, -83.49));
  assert.deepEqual(routeCompleteness(r, here()), { complete: true, reason: null });
  const fact = routeLengthFact(r, here());
  assert.equal(fact.status, 'known');
  assert.ok(Math.abs(fact.value - 912.88) < 0.5, String(fact.value));
  assert.equal(fact.method, 'derived');
  assert.equal(fact.source, SOURCES.usfsMvum.attribution);
});

test('QQA-09: a route that reaches the edge of the fetched box, or past it, reads "approximate -- only the part loaded in this view"', () => {
  for (const latlngs of [flat(-83.5, -83.4), flat(-83.5, -83.3), flat(-83.7, -83.5)]) {
    const r = road(latlngs);
    assert.equal(routeCompleteness(r, here()).complete, false, JSON.stringify(latlngs));
    const lines = routeCardLines(r, here());
    assert.ok(lines.some((l) => /^Length: .* mi \(.* km\), approximate — only the part loaded in this view/.test(l)), JSON.stringify(lines));
    assert.equal(routeLengthFact(r, here()).status, 'approximate');
  }
});

test('QQA-09: completeness that cannot be known is approximate, and the reason is given', () => {
  const r = road(flat(-83.5, -83.49));
  const cases = [
    [here({ coverage: { ...READY, 'mvum-road': 'partial' } }), /source/i],
    [here({ coverage: { ...READY, 'mvum-road': 'unknown' } }), /source/i],
    [here({ truncated: new Set(['mvum-road']) }), /preview|draw/i],
    [here({ fetchedFor: null }), /area|asked/i],
    [null, /cannot be known|not known/i],
  ];
  for (const [ctx, why] of cases) {
    const c = routeCompleteness(r, ctx);
    assert.equal(c.complete, false);
    assert.match(c.reason, why);
    assert.ok(routeCardLines(r, ctx).some((l) => l.includes(`approximate — ${c.reason}`)), `${c.reason}`);
  }
  assert.equal(routeCompleteness(r, here({ truncated: new Set(['trail']) })).complete, true, 'another kind being cut says nothing about this one');
});

test('QQA-09: one route id from two national forests is two roads, so its length is never called whole', () => {
  // MVUM numbers a road within its forest; Forest Road 67 can exist in two forests the view spans.
  const road67 = (forest, lon) => ({ id: '67', name: 'Forest Road 67', layer: 'road', seasonal: 'yearlong', forest, paths: [[[lon, 35], [lon + 0.01, 35]]],
    vehicles: { passenger: { allowed: 'open', datesOpen: null }, highClearance: { allowed: 'open', datesOpen: null } } });
  const lines = previewPolylines([road67('Nantahala National Forest', -83.5), road67('Chattahoochee National Forest', -83.45)], { scale: 24000 });
  assert.deepEqual(lines.map((l) => l.forest), ['Nantahala National Forest', 'Chattahoochee National Forest'], 'the polyline keeps the forest');
  const [both] = collectRoutes(lines);
  const c = routeCompleteness(both, here());
  assert.equal(c.complete, false);
  assert.match(c.reason, /2 national forests/);
  assert.equal(routeLengthFact(both, here()).status, 'approximate');
  const [one] = collectRoutes(previewPolylines([road67('Nantahala National Forest', -83.5), road67('Nantahala National Forest', -83.49)], { scale: 24000 }));
  assert.deepEqual(routeCompleteness(one, here()), { complete: true, reason: null }, 'two segments in one forest are one road');
});

test('QQA-09: a route with no source id is one mapped segment and is approximate', () => {
  const r = road(flat(-83.5, -83.49), { id: null, objectId: 5 });
  const c = routeCompleteness(r, here());
  assert.equal(c.complete, false);
  assert.match(c.reason, /one mapped segment|no route id/i);
});

test('QQA-09: a route drawn in two parts is measured as both, and the card ends on its source', () => {
  const one = road(flat(-83.5, -83.49));
  const two = collectRoutes([poly({ id: '67', latlngs: flat(-83.5, -83.49) }), poly({ id: '67', latlngs: flat(-83.49, -83.48) })])[0];
  assert.ok(Math.abs(routeLengthFact(two, here()).value - 2 * routeLengthFact(one, here()).value) < 0.01);
  const lines = routeCardLines(road(flat(-83.5, -83.49), { detail: ['Gravel'] }), here());
  assert.match(lines.find((l) => l.startsWith('Length:')), /^Length: 0\.6 mi \(0\.91 km\) \(basis: loaded geometry, WGS84\)$/, 'complete: no hedge, basis stated on the same line');
  assert.equal(lines.at(-1), `Source: ${SOURCES.usfsMvum.attribution}`);
  assert.ok(lines.indexOf('Gravel') < lines.findIndex((l) => l.startsWith('Length:')), 'the length follows the source facts');
});

test('QQA-09: a route with no measurable geometry says the length is unavailable, never 0', () => {
  const r = { ...road(flat(-83.5, -83.49)), parts: [] };
  const lines = routeCardLines(r, here());
  assert.ok(lines.some((l) => /^Length: unavailable/.test(l)), JSON.stringify(lines));
  assert.ok(!lines.some((l) => /0 ft/.test(l)));
});
