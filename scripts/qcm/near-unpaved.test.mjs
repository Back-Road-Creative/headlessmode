// "Quiet but reachable": how far a place is from a road you would actually want to
// drive to get away. Audit F13's analytical half, first honest slice.
//
// The rule the whole module turns on: only a road whose surface the INVENTORY
// STATED counts. A forest road Road Basic never matched has an unknown surface, and
// counting it as unpaved would turn "we did not look this one up" into "gravel".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceToPathsMeters, nearestUnpaved, nearUnpavedPhrase, milesText, M_PER_MILE }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/near-unpaved.js';

// A road running due east along lat 35.00, and a site 0.01 degrees north of it.
// 0.01 deg of latitude is 1113.2 m, which is 0.6917 mi -- an arithmetic fact, so
// the test asserts the relationship rather than a number copied from the code.
const EAST_WEST = [[[-83.60, 35.00], [-83.40, 35.00]]];
const SITE = [-83.50, 35.01];

const road = (id, paths) => ({ id, symbolKey: 'mvum-road-yearlong', paths });
const GRAVEL = { surface: 'gravel', surfaceText: 'Crushed aggregate or gravel', maintLevel: 3 };
const PAVED = { surface: 'paved', surfaceText: 'Asphalt', maintLevel: 5 };

test('distance to a path is measured to the nearest point on it, not to its ends', () => {
  const d = distanceToPathsMeters(SITE, EAST_WEST);
  assert.ok(Math.abs(d - 0.01 * 111320) < 1, `0.01 deg of latitude is 1113.2 m, got ${d}`);
  // Straight above the middle of the segment: moving the site along the road must
  // not change the answer. A naive "distance to the closest vertex" fails this by
  // hundreds of metres, and would have reported a road you are standing on as far away.
  const alongTheRoad = distanceToPathsMeters([-83.45, 35.01], EAST_WEST);
  assert.ok(Math.abs(alongTheRoad - d) < 1, 'sliding along a straight road changes nothing');
  // Past the end, the nearest point IS the endpoint, so the distance grows.
  const beyond = distanceToPathsMeters([-83.30, 35.00], EAST_WEST);
  assert.ok(beyond > d, 'a site past the end of the road is further from it, not nearer');
  assert.equal(distanceToPathsMeters(SITE, []), null, 'no geometry, no distance');
  assert.equal(distanceToPathsMeters(SITE, [[[-83.5, 35.0]]]), null, 'a single point is not a road');
});

test('only a road whose surface the inventory stated can be called unpaved', () => {
  const roads = [road('421', EAST_WEST)];
  const found = nearestUnpaved({ lonLat: SITE, roads, roadQuality: { 421: GRAVEL } });
  assert.equal(found.id, '421');
  assert.equal(found.surface, 'gravel');
  assert.equal(found.surfaceText, 'Crushed aggregate or gravel');
  assert.ok(Math.abs(found.meters - 1113.2) < 1);

  // Paved is a stated surface, and the answer to a different question.
  assert.equal(nearestUnpaved({ lonLat: SITE, roads, roadQuality: { 421: PAVED } }), null);
  // Never matched by Road Basic. "We did not look this road up" is not "gravel".
  assert.equal(nearestUnpaved({ lonLat: SITE, roads, roadQuality: {} }), null,
    'an unmatched road has an unknown surface, not an unpaved one');
  // Two records disagreed, so the join table refused to rate it. So does this.
  assert.equal(nearestUnpaved({ lonLat: SITE, roads, roadQuality: { 421: { ambiguous: true, surface: null } } }), null);
  // 'other' is surfaceFamily's answer for a code it cannot read -- our gap, not a
  // fact about the road, and certainly not a promise that it is unpaved.
  assert.equal(nearestUnpaved({ lonLat: SITE, roads, roadQuality: { 421: { surface: 'other' } } }), null);
});

test('the nearest unpaved road wins, and a trail is not a road', () => {
  const far = road('421', EAST_WEST);                                   // 1113 m away
  const near = road('99', [[[-83.60, 35.005], [-83.40, 35.005]]]);      // 557 m away
  const quality = { 421: GRAVEL, 99: { surface: 'native', surfaceText: 'Native material' } };
  const found = nearestUnpaved({ lonLat: SITE, roads: [far, near], roads_: null, roadQuality: quality });
  assert.equal(found.id, '99', 'the nearer of two unpaved roads is the answer');

  // The join table is keyed on route id. A trail carrying the same id is not a
  // Forest Service road and has no surface rating to borrow.
  const trail = { id: '99', symbolKey: 'mvum-trail-yearlong', paths: [[[-83.60, 35.005], [-83.40, 35.005]]] };
  assert.equal(nearestUnpaved({ lonLat: SITE, roads: [trail], roadQuality: quality }), null);
});

test('nothing found says nothing, because the search only saw the fetched box', () => {
  // A cap keeps the claim honest in the other direction too: a road 40 miles away
  // is not what "quiet but reachable" means, and reporting it would be noise.
  const roads = [road('421', EAST_WEST)];
  assert.equal(nearestUnpaved({ lonLat: SITE, roads, roadQuality: { 421: GRAVEL }, maxMeters: 500 }), null);
  assert.equal(nearestUnpaved({ lonLat: SITE, roads: [], roadQuality: {} }), null);
  assert.equal(nearestUnpaved({ lonLat: null, roads, roadQuality: { 421: GRAVEL } }), null);
});

test('the phrase says straight-line, and says it every time', () => {
  // The plan is explicit: show "straight-line distance" until a network path has
  // actually been calculated. Nothing here routes, so nothing here may imply it.
  const phrase = nearUnpavedPhrase({ meters: 1113.2, surface: 'gravel', surfaceText: 'Crushed aggregate or gravel' });
  assert.match(phrase, /straight-line/, 'a distance with no route behind it must say so');
  assert.match(phrase, /0\.7 mi/, '1113.2 m is 0.69 mi, shown to one decimal');
  assert.match(phrase, /gravel/i);
  // "Mapped" is doing real work: the search saw the roads fetched for this area and
  // no others, so the phrase must not read as a claim about the whole neighbourhood.
  assert.match(phrase, /mapped/);

  // Rounding to one decimal would print "0.0 mi" for a site on the verge.
  assert.match(nearUnpavedPhrase({ meters: 40, surface: 'native', surfaceText: 'Native material' }),
    /less than 0\.1 mi/, 'a site on the verge is not zero miles away');
  assert.equal(nearUnpavedPhrase(null), null, 'no answer, no phrase');
  assert.equal(M_PER_MILE, 1609.344);
});

// QUX-11b (§2.6, §4.3): the Nearby feature shows a plain distance with the same
// rounding as the near-unpaved phrase, so the two never drift apart into two
// different answers for "how far".
test('11b: milesText is the shared rounding -- "less than 0.1 mi" under 0.05 mi, else one decimal -- and nearUnpavedPhrase uses it verbatim, not a second copy', () => {
  assert.equal(milesText(0), 'less than 0.1 mi');
  assert.equal(milesText(40), 'less than 0.1 mi', '40 m is well under 0.05 mi, as the existing phrase test already asserts');
  assert.equal(milesText(1113.2), '0.7 mi');
  assert.equal(milesText(2 * M_PER_MILE), '2.0 mi');

  const phrase = nearUnpavedPhrase({ meters: 1113.2, surface: 'gravel', surfaceText: 'Crushed aggregate or gravel' });
  assert.ok(phrase.startsWith(milesText(1113.2)), `phrase ${JSON.stringify(phrase)} does not start with milesText's own rounding`);
  const verge = nearUnpavedPhrase({ meters: 40, surface: 'native', surfaceText: 'Native material' });
  assert.ok(verge.startsWith(milesText(40)), verge);
});
