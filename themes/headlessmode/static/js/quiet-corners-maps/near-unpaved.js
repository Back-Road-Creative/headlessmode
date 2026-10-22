// "Quiet but reachable": how far a place is from a road worth driving to get away.
//
// Audit F13's analytical half, first slice. The app already knows, for the area it
// fetched, where every forest road runs (MVUM) and what the Forest Service road
// inventory said each one is surfaced with (Road Basic). Nothing joined the two to
// the places a reader actually stops at, so "is there a gravel road near this
// campsite?" -- the question the whole feature exists for -- could only be answered
// by eye, one road at a time.
//
// Three rules this module will not bend:
//
//  1. Only a STATED surface counts. A road Road Basic never matched has an unknown
//     surface, not an unpaved one, and a route two records disagree about was left
//     unrated on purpose. Counting either as gravel turns "we did not look" into a
//     promise about the ground.
//  2. Straight-line, said out loud, every time. Nothing here routes: there is no
//     network, no legal-access model and no cost model, so the number must never be
//     allowed to read as a drive.
//  3. Silence when nothing is found. The search saw the roads fetched for one
//     rectangle. "No unpaved road nearby" would be a claim about ground nobody
//     looked at, so a miss reports nothing at all.
//
// Pure: no DOM, no network, no Date.

export const M_PER_MILE = 1609.344;
// A local-plane approximation (path LENGTH is now geodesic, measure.js; a point-to-road
// distance stays on this plane): good to about a percent at a quad's scale, which is finer than anything
// this answer is rounded to. A spherical formula would be more precise than the
// question deserves.
const M_PER_DEG_LAT = 111320;
const D2R = Math.PI / 180;

// A stated surface that is not paved. 'other' is surfaceFamily's answer for a code
// it could not read -- our parsing gap, not a fact about the road.
const UNPAVED = new Set(['gravel', 'native']);

/** Metres from a point to the nearest point ON a segment, both already projected to
 *  a local plane in metres. Clamped to the segment, so a road you are standing over
 *  the middle of is not reported at the distance of its far end. */
function segmentMeters(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Ground distance in metres from a [lon, lat] point to the nearest point on any of
 *  `paths` ([[lon, lat], …][]); null when there is no drawable line to measure to.
 *
 *  The projection is centred on the query point, so the cosine correction is exact
 *  where it matters and the error grows only with distance -- which is the direction
 *  that does not matter, because a far road is not the answer anyway. */
export function distanceToPathsMeters(lonLat, paths = []) {
  if (!Array.isArray(lonLat) || lonLat.length < 2) return null;
  const [lon0, lat0] = lonLat;
  if (!Number.isFinite(lon0) || !Number.isFinite(lat0)) return null;
  const kx = M_PER_DEG_LAT * Math.cos(lat0 * D2R);
  const x = (lon) => (lon - lon0) * kx;
  const y = (lat) => (lat - lat0) * M_PER_DEG_LAT;
  let best = null;
  for (const path of paths) {
    if (!Array.isArray(path) || path.length < 2) continue;
    for (let i = 1; i < path.length; i++) {
      const [alon, alat] = path[i - 1], [blon, blat] = path[i];
      const d = segmentMeters(0, 0, x(alon), y(alat), x(blon), y(blat));
      if (best === null || d < best) best = d;
    }
  }
  return best;
}

/** The nearest road the inventory CALLED unpaved, or null.
 *
 *  `roads` are drawn MVUM features; `roadQuality` is the Road Basic join table,
 *  keyed on route id. Only `mvum-road-*` features are considered: the table is keyed
 *  on route id and a trail carrying the same one is not a Forest Service road.
 *
 *  `maxMeters` keeps the claim honest in the other direction — a gravel road forty
 *  miles off is not what "quiet but reachable" means, and reporting it is noise. */
export function nearestUnpaved({ lonLat, roads = [], roadQuality = {}, maxMeters = 8 * M_PER_MILE } = {}) {
  if (!Array.isArray(lonLat) || lonLat.length < 2) return null;
  let best = null;
  for (const road of roads) {
    if (!String(road?.symbolKey || '').startsWith('mvum-road-')) continue;
    const rating = roadQuality[road.id];
    // Rule 1. An unrated road, an ambiguous one and an unreadable surface code all
    // mean the same thing here: the inventory did not say, so neither do we.
    if (!rating || rating.ambiguous || !UNPAVED.has(rating.surface)) continue;
    const meters = distanceToPathsMeters(lonLat, road.paths || []);
    if (meters === null || meters > maxMeters) continue;
    if (best === null || meters < best.meters) {
      best = { id: road.id ?? null, name: road.name || null, meters,
        surface: rating.surface, surfaceText: rating.surfaceText || null };
    }
  }
  return best;
}

/** The shared rounding for "how far" -- "less than 0.1 mi" under 0.05 mi (one
 *  decimal would print "0.0 mi" for a site on the verge, which reads as a
 *  measurement rather than as rounding), else one decimal. QUX-11b's Nearby
 *  sort (places-in-view.js) calls this directly so a rec row's distance and
 *  this phrase's own distance never drift into two different roundings of the
 *  same number. */
export function milesText(meters) {
  if (!Number.isFinite(meters)) return null;
  const miles = meters / M_PER_MILE;
  return miles < 0.05 ? 'less than 0.1 mi' : `${miles.toFixed(1)} mi`;
}

/** The one line a reader sees, or null when there is nothing to say.
 *
 *  "mapped" is load-bearing: the search saw the roads fetched for one rectangle and
 *  no others, so the phrase must not read as a survey of the neighbourhood. So is
 *  "straight-line" — see rule 2 at the top of this file. */
export function nearUnpavedPhrase(found) {
  if (!found || !Number.isFinite(found.meters)) return null;
  const far = milesText(found.meters);
  const kind = found.surfaceText ? found.surfaceText.toLowerCase() : found.surface;
  return `${far} from a mapped ${kind} road (straight-line)`;
}
