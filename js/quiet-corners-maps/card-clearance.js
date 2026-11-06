// Where a card opened over the map should land so it can be read: the point to
// put its anchor at, in client pixels. No DOM here -- quiet-corners.js measures
// the open card and whatever is painted over the map, and flies the map so the
// anchor lands on the point clearSpot() returns. scripts/qcm/card-clearance.test.mjs
// holds the geometry.
//
// A rect is { left, top, right, bottom }. `card` and `head` are relative to the
// anchor: the whole card, and the part of it that must show first (its name
// line). `view` is the part of the map on screen and `obstacles` the boxes
// painted over it. Each obstacle is grown by `margin`, so a card that clears one
// clears it by that much, and obstacles that overlap count once.
//
// The spot is the one that covers, in this order, the least of the head, then
// the least of the card, then lies nearest `at` (where the map would put the
// anchor anyway). Whatever falls outside the view, shrunk by `margin`, counts as
// covered too: a card hanging off the map is no more readable than one under a
// panel. The whole card stays inside that shrunk view when it fits, its anchor
// with it: the place the card names is on the map it is read on. A card too big
// for that keeps its top and left edges inside and gives up, in order, its
// bottom and right edges, then the anchor, then its head's bottom and right
// edges -- those last stay inside unless the head is bigger than the view, so
// the name line can show even where the card is bigger than the view, and the
// card moves down or right off the view's edge only to clear more of its head.
// Before the card and anchor were held, a phone whose controls left a band
// shorter than the card hung the place 46 px below the fold to keep the name
// line clear, and once the place was held, slid the card 5 px off the right
// edge to clear the name line from a control on the left.
//
// How much of a rect is covered is a sum, over the covered areas, of an overlap
// width times an overlap height, and each of those is linear in the rect's
// position between the points where one of its edges meets an area's edge.
// So the best spot is always on one of those points, on an end of the allowed
// range, or at `at` itself (clamped): those are the only spots tried, and the
// test holds that to a brute-force search over every whole-pixel spot.

const EPS = 1e-6;

function overlap(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

function covered(r, cells) {
  let sum = 0;
  for (const c of cells) sum += overlap(r, c);
  return sum;
}

const moved = (r, x, y) => ({ left: r.left + x, top: r.top + y, right: r.right + x, bottom: r.bottom + y });

/** What is left of `a` once `b` is taken out of it: up to four rects. */
function subtract(a, b) {
  if (!overlap(a, b)) return [a];
  const out = [];
  if (b.top > a.top) out.push({ left: a.left, top: a.top, right: a.right, bottom: b.top });
  if (b.bottom < a.bottom) out.push({ left: a.left, top: b.bottom, right: a.right, bottom: a.bottom });
  const top = Math.max(a.top, b.top), bottom = Math.min(a.bottom, b.bottom);
  if (b.left > a.left) out.push({ left: a.left, top, right: b.left, bottom });
  if (b.right < a.right) out.push({ left: b.right, top, right: a.right, bottom });
  return out;
}

/** Everything that counts as covered, cut into rects that do not overlap one
 *  another, so an area two panels share counts once: the four sides outside the
 *  view shrunk by `margin`, then the obstacles grown by `margin`. An obstacle
 *  with no area paints nothing and is left out. */
function disjointCells(view, obstacles, margin) {
  // A view no bigger than twice the margin shrinks to a line, not inside out.
  const l = view.left + margin, t = view.top + margin;
  const r = Math.max(l, view.right - margin), b = Math.max(t, view.bottom - margin);
  let cells = [
    { left: -Infinity, top: -Infinity, right: Infinity, bottom: t },
    { left: -Infinity, top: b, right: Infinity, bottom: Infinity },
    { left: -Infinity, top: t, right: l, bottom: b },
    { left: r, top: t, right: Infinity, bottom: b },
  ].filter((c) => c.right > c.left && c.bottom > c.top);
  for (const o of obstacles) {
    if (!(o.right > o.left && o.bottom > o.top)) continue;
    let pieces = [{ left: o.left - margin, top: o.top - margin, right: o.right + margin, bottom: o.bottom + margin }];
    for (const c of cells) pieces = pieces.flatMap((p) => subtract(p, c));
    cells = cells.concat(pieces);
  }
  return cells;
}

/** The anchor positions allowed on one axis, between the shrunk view's edges
 *  `lo` and `hi`: the card's near edge and the anchor inside, and the first of
 *  these that leaves any room inside too -- the card's far edge, the anchor, the
 *  head's far edge. `to` falls to `from` when even the head's far edge is too
 *  much. */
function range(lo, hi, cardNear, cardFar, headFar) {
  const from = lo - Math.min(cardNear, 0);
  const to = [hi - Math.max(cardFar, 0), hi - Math.max(headFar, 0), hi - headFar].find((t) => t >= from);
  return [from, to === undefined ? from : to];
}

/** The anchor positions worth trying on one axis: the ends of the allowed range
 *  [lo, hi] (just lo when even the head is too big for it), `at` clamped into it,
 *  and every position inside it where one of `offsets` (the card's and head's
 *  edges, relative to the anchor) meets one of `edges` (the covered areas'). */
function stops(lo, hi, at, offsets, edges) {
  const to = Math.max(lo, hi);
  const out = new Set([lo, to, Math.min(Math.max(at, lo), to)]);
  for (const e of edges) {
    for (const off of offsets) {
      const v = e - off;
      if (v > lo && v < to) out.add(v);
    }
  }
  return [...out];
}

function better(a, b) {
  for (let k = 0; k < a.length; k++) {
    if (a[k] < b[k] - EPS) return true;
    if (a[k] > b[k] + EPS) return false;
  }
  return false;
}

/** The point to land the card's anchor on: `{ x, y }` in the same pixels as
 *  `view`, `obstacles` and `at`. See the header for the order the spot is
 *  chosen in. */
export function clearSpot({ view, card, head = card, obstacles = [], at, margin = 8 }) {
  const cells = disjointCells(view, obstacles, margin);
  const x = range(view.left + margin, view.right - margin, card.left, card.right, head.right);
  const y = range(view.top + margin, view.bottom - margin, card.top, card.bottom, head.bottom);
  const xs = stops(x[0], x[1], at.x, [card.left, card.right, head.left, head.right], cells.flatMap((c) => [c.left, c.right]));
  const ys = stops(y[0], y[1], at.y, [card.top, card.bottom, head.top, head.bottom], cells.flatMap((c) => [c.top, c.bottom]));
  let best = null;
  for (const x of xs) {
    for (const y of ys) {
      const cost = [covered(moved(head, x, y), cells), covered(moved(card, x, y), cells), (x - at.x) ** 2 + (y - at.y) ** 2];
      if (!best || better(cost, best.cost)) best = { x, y, cost };
    }
  }
  return { x: best.x, y: best.y };
}
