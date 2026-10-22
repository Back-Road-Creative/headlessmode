// Where a name card opened from "Search names" should land (card-clearance.js).
//
// Before this, the finder flew the map so the name's anchor sat at the map's
// centre, and the card above it landed wherever that left it. On 2026-10-02 a
// probe of the built page read the card for Cold Mountain (Haywood, NC) under
// the Explore and Conditions panels at 1280x900, and at 390x844 above the top of
// the map. clearSpot() is the geometry, in client pixels with no DOM:
// quiet-corners.js measures the open card and the panels and controls painted
// over the map, and flies the map so the anchor lands on the point it returns.
//
// The last test checks clearSpot() against a brute-force search over every
// whole-pixel landing spot, with an independent pixel-count cost; the cases
// above it pin the shapes the page actually has.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearSpot } from '../../themes/headlessmode/static/js/quiet-corners-maps/card-clearance.js';

const rect = (left, top, right, bottom) => ({ left, top, right, bottom });
const moved = (r, x, y) => rect(r.left + x, r.top + y, r.right + x, r.bottom + y);

/** Counts whole pixels: cover(r) is how many pixels of `r` are hidden -- inside an
 *  obstacle grown by `margin`, or outside the view shrunk by `margin` -- each
 *  pixel counted once however many obstacles overlap it. A 2D prefix sum of the
 *  pixels left free, over the shrunk view. Integer inputs only; an obstacle with
 *  no area hides nothing. */
function pixelCover({ view, obstacles, margin }) {
  const inner = rect(view.left + margin, view.top + margin, view.right - margin, view.bottom - margin);
  const solid = obstacles.filter((o) => o.right > o.left && o.bottom > o.top);
  const w = Math.max(0, inner.right - inner.left), h = Math.max(0, inner.bottom - inner.top);
  const sum = new Int32Array((w + 1) * (h + 1));
  for (let j = 0; j < h; j++) {
    const py = inner.top + j;
    let row = 0;
    for (let i = 0; i < w; i++) {
      const px = inner.left + i;
      const hit = solid.some((o) => o.left - margin <= px && px + 1 <= o.right + margin
        && o.top - margin <= py && py + 1 <= o.bottom + margin);
      row += hit ? 0 : 1;
      sum[(j + 1) * (w + 1) + (i + 1)] = sum[j * (w + 1) + (i + 1)] + row;
    }
  }
  return (r) => {
    const area = (r.right - r.left) * (r.bottom - r.top);
    const l = Math.max(r.left, inner.left) - inner.left, t = Math.max(r.top, inner.top) - inner.top;
    const rr = Math.min(r.right, inner.right) - inner.left, b = Math.min(r.bottom, inner.bottom) - inner.top;
    if (rr <= l || b <= t) return area;
    return area - (sum[b * (w + 1) + rr] - sum[t * (w + 1) + rr] - sum[b * (w + 1) + l] + sum[t * (w + 1) + l]);
  };
}

/** The anchor positions the card may take: the whole card `margin` px or more
 *  inside the view, the anchor -- the place the card names -- with it. A card
 *  too big for that keeps its top and left edges inside and gives up its bottom
 *  and right edges, then the anchor, then holds its head's bottom and right
 *  edges inside, or, where even the head is bigger than that, is pinned at the
 *  top or left. */
function domain({ view, card, head = card, margin }) {
  const span = (lo, hi, near, far, headFar) => {
    const from = lo + margin - Math.min(near, 0), edge = hi - margin;
    const to = [edge - Math.max(far, 0), edge - Math.max(headFar, 0), edge - headFar].find((t) => t >= from);
    return [from, to === undefined ? from : to];
  };
  return {
    x: span(view.left, view.right, card.left, card.right, head.right),
    y: span(view.top, view.bottom, card.top, card.bottom, head.bottom),
  };
}

/** [name line covered, card covered, squared distance from `at`], compared in that order. */
function costAt(spec, cover, x, y) {
  return [cover(moved(spec.head, x, y)), cover(moved(spec.card, x, y)), (x - spec.at.x) ** 2 + (y - spec.at.y) ** 2];
}
const lexLess = (a, b) => { for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] < b[k]; return false; };

function bruteForce(spec, cover) {
  const d = domain(spec);
  let best = null;
  for (let x = d.x[0]; x <= d.x[1]; x++) {
    for (let y = d.y[0]; y <= d.y[1]; y++) {
      const c = costAt(spec, cover, x, y);
      if (!best || lexLess(c, best)) best = c;
    }
  }
  return best;
}

const inDomain = (spec, p) => {
  const d = domain(spec);
  return p.x >= d.x[0] && p.x <= d.x[1] && p.y >= d.y[0] && p.y <= d.y[1];
};

// A name's card as quiet-corners.js measures it, relative to its anchor, rounded
// from the 2026-10-02 probe: the popup and its tip in both of the placements it
// can open in (on a pin, lifted by the default marker's popupAnchor, or on a
// name label, which has none) taken together. Rounded estimates -- the tests
// that use them hold only properties that do not hang on the exact numbers.
const CARD = rect(-144, -303, 144, 6);
// The part that must show first, the place's name: a 24 px line 14 px inside the
// popup's top edge, in both placements together, so 58 px tall (the two lines
// sit 34 px apart).
const HEAD = rect(-131, -289, 130, -231);

test('a card that already lands clear stays where the map would put it', () => {
  const spec = {
    view: rect(0, 0, 1000, 800), card: rect(-100, -200, 100, 0), head: rect(-90, -190, 90, -170),
    obstacles: [rect(0, 0, 1000, 40)], at: { x: 500, y: 400 }, margin: 8,
  };
  assert.deepEqual(clearSpot(spec), { x: 500, y: 400 });
});

test('a bar across the top of the map pushes the card down until it clears the bar by the margin', () => {
  const spec = {
    view: rect(0, 0, 1000, 800), card: rect(-100, -300, 100, 10), head: rect(-90, -290, 90, -260),
    obstacles: [rect(0, 0, 1000, 100)], at: { x: 500, y: 350 }, margin: 8,
  };
  // The card's top at 100 + 8: the anchor 300 below that. Sideways buys nothing
  // against a full-width bar, so x stays where the map would put it.
  assert.deepEqual(clearSpot(spec), { x: 500, y: 408 });
});

// The 1280x900 page as the probe measured it BEFORE the dock, when the panels were
// overlays on the map: #qcm-app and the layer panel, the Explore and Conditions
// panels across the map, Leaflet's controls on the left and the view controls,
// scale, map key and attribution along the bottom. The page no longer looks like
// this (see DOCK below), but a map with bars across it is still the hard case for
// clearSpot, so the geometry stays as a pure test of it.
const DESKTOP = {
  view: rect(0, 215, 1280, 888),
  obstacles: [
    rect(65, 231, 417, 278), rect(959, 231, 1263, 278), rect(65, 315, 1263, 362), rect(65, 379, 1263, 426),
    rect(11, 225, 45, 421), rect(11, 826, 328, 855), rect(6, 865, 104, 883), rect(891, 759, 1269, 865),
    rect(682, 875, 1279, 888),
  ],
  // Where flyTo puts the anchor: the map container's centre.
  at: { x: 640, y: 551 },
};

test('at 1280x900 with the pre-dock overlays the card lands under the Conditions panel, clear of it by the margin, and still centred', () => {
  const spec = { ...DESKTOP, card: CARD, head: HEAD, margin: 8 };
  // The card's top at Conditions' bottom (426) + 8; the attribution (top 875)
  // would allow 124 px lower, but the map's centre is above, so as high as clear.
  assert.deepEqual(clearSpot(spec), { x: 640, y: 737 });
  const cover = pixelCover(spec);
  assert.deepEqual(costAt(spec, cover, 640, 737).slice(0, 2), [0, 0], 'the card lands wholly clear');
});

// The same page with the dock: the four panels are column 1 (x 1-334, one open,
// three closed rows), so the map -- and the view clearCentre() measures, the map
// clipped by its container and the viewport -- starts at x 335. The panels are
// still in the obstacle list (quiet-corners.js passes #qc-sheet's children), but
// they all lie left of the view. Leaflet's controls are inside it: zoom top-left,
// view controls and scale bottom-left, map key and attribution bottom-right.
const DOCK = {
  view: rect(335, 215, 1279, 888),
  obstacles: [
    rect(1, 215, 334, 262), rect(1, 262, 334, 762), rect(1, 762, 334, 809), rect(1, 809, 334, 856),
    rect(345, 225, 379, 293), rect(345, 826, 662, 855), rect(340, 865, 438, 883), rect(891, 759, 1269, 865),
    rect(682, 875, 1279, 888),
  ],
  // The map column's centre, where flyTo puts the anchor.
  at: { x: 807, y: 551 },
};

test('at 1280x900 with the dock nothing is over the map\'s middle, so the card stays where the map puts it', () => {
  const spec = { ...DOCK, card: CARD, head: HEAD, margin: 8 };
  assert.deepEqual(clearSpot(spec), DOCK.at);
  const cover = pixelCover(spec);
  assert.deepEqual(costAt(spec, cover, DOCK.at.x, DOCK.at.y), [0, 0, 0], 'the card lands wholly clear');
});

// The 390x844 phone: the map runs from y 375 to 891 and the fold is at 844.
const PHONE = {
  view: rect(1, 375, 389, 844),
  obstacles: [
    rect(11, 385, 59, 477), rect(11, 487, 59, 535), rect(11, 545, 154, 593), rect(11, 603, 59, 651),
    rect(62, 385, 379, 429), rect(1, 748, 379, 854), rect(1, 864, 389, 890),
  ],
  at: { x: 195, y: 633 },
};

test('at 390x844, where the card cannot clear everything, the name line is clear and the card covered as little as it can be', () => {
  const spec = { ...PHONE, card: CARD, head: HEAD, margin: 8 };
  const got = clearSpot(spec);
  assert.ok(inDomain(spec, got), `the card's top and its name line must stay inside the visible map: ${JSON.stringify(got)}`);
  // The free band between the view controls and the map key is 303 px; the card is 309.
  const cover = pixelCover(spec);
  const cost = costAt(spec, cover, got.x, got.y);
  assert.equal(cost[0], 0, `the name line must land clear: ${JSON.stringify({ got, cost })}`);
  assert.deepEqual(cost, bruteForce(spec, cover), `not the least-covered spot: ${JSON.stringify(got)}`);
});

// The same phone once the view controls grew to two rows (Share view, Reset view
// and Use my location at 14 px no longer fit one row beside the zoom pair): the
// band left between them and the map key is 46 px shorter than the card.
const PHONE_TALL_CONTROLS = {
  ...PHONE,
  obstacles: PHONE.obstacles.map((o) => (o.top === 385 && o.left === 62 ? rect(62, 385, 379, 479) : o)),
};

test('at 390x844 with the view controls on two rows the place itself stays on the map', () => {
  // Before this, the name line's bottom was the only lower edge held inside the
  // view, so with the band too short the cheapest spot hung the anchor -- the
  // place the card names -- 46 px below the fold, with the card's bottom at the
  // very edge of the screen (name-search.test.mjs, 390x844, on 2026-10-06).
  const spec = { ...PHONE_TALL_CONTROLS, card: CARD, head: HEAD, margin: 8 };
  const got = clearSpot(spec);
  assert.ok(got.y <= spec.view.bottom - spec.margin && got.y >= spec.view.top + spec.margin,
    `the place must land inside the visible map: ${JSON.stringify(got)}`);
  // Held only at its place, the card slid 5 px off the right edge to clear the
  // name line from the wide control on the left: it fits, so all of it stays on.
  const landed = moved(CARD, got.x, got.y);
  assert.ok(landed.right <= spec.view.right - spec.margin && landed.bottom <= spec.view.bottom - spec.margin,
    `the whole card must land inside the visible map: ${JSON.stringify({ got, landed })}`);
  assert.ok(inDomain(spec, got), `the card's top and its name line must stay inside the visible map: ${JSON.stringify(got)}`);
  // With the place on the map, the name line can only touch the margin band of
  // the wide control on the left (the real name line's clearance is
  // name-search.test.mjs's to hold); what matters here is that nothing covers it
  // more than that, and that no spot covers less.
  const cover = pixelCover(spec);
  const cost = costAt(spec, cover, got.x, got.y);
  assert.ok(cost[0] <= spec.margin * (HEAD.right - HEAD.left), `the name line must land clear but for the margin: ${JSON.stringify({ got, cost })}`);
  assert.deepEqual(cost, bruteForce(spec, cover), `not the least-covered spot: ${JSON.stringify(got)}`);
});

test('a card bigger than the map is pinned the margin inside the map\'s top-left corner', () => {
  const spec = {
    view: rect(0, 0, 200, 150), card: rect(-150, -300, 150, 10), head: rect(-140, -290, 140, -270),
    obstacles: [], at: { x: 100, y: 75 }, margin: 8,
  };
  // The card's left edge at 8 and its top at 8: the name line is what has to show.
  assert.deepEqual(clearSpot(spec), { x: 158, y: 308 });
});

test('a card taller than the map still moves down to clear its name line from a bar across the top', () => {
  // A phone on its side: a 200 px map under a 60 px bar, and the 309 px card. Pinned
  // to the top edge the name line would sit at 22..80, under the bar; 46 px lower it
  // clears the bar by the margin, and the card still shows as much of itself as it can.
  const spec = {
    view: rect(0, 0, 700, 200), card: CARD, head: HEAD,
    obstacles: [rect(0, 0, 700, 60)], at: { x: 350, y: 100 }, margin: 8,
  };
  assert.deepEqual(clearSpot(spec), { x: 350, y: 357 });
  const cover = pixelCover(spec);
  assert.deepEqual(costAt(spec, cover, 350, 357), bruteForce(spec, cover));
});

test('the name line is cleared before the rest of the card', () => {
  // Bars over the top half and the bottom 15 px leave a 35 px band for a 40 px card.
  // Top at 45 or at 50 both leave 200 px² of card covered; only at 50 is the name line
  // (the card's top 10 px) clear, and it wins even though 45 is nearer the map's centre.
  const spec = {
    view: rect(0, 0, 100, 100), card: rect(0, 0, 40, 40), head: rect(0, 0, 40, 10),
    obstacles: [rect(0, 0, 100, 50), rect(0, 85, 100, 100)], at: { x: 30, y: 0 }, margin: 0,
  };
  assert.deepEqual(clearSpot(spec), { x: 30, y: 50 });
});

test('panels that overlap each other count once, not once per panel', () => {
  // Two copies of a left strip and one right strip leave a 16 px gap for a 20 px card.
  // Anywhere from x 38 to 42 covers 80 px² of it; counted per panel the left strip
  // would count double and push the card to 42. Counted once, the nearest to x 0 wins.
  const spec = {
    view: rect(0, 0, 100, 100), card: rect(0, 0, 20, 20), head: rect(0, 0, 20, 20),
    obstacles: [rect(0, 0, 42, 100), rect(0, 0, 42, 100), rect(58, 0, 100, 100)], at: { x: 0, y: 50 }, margin: 0,
  };
  assert.deepEqual(clearSpot(spec), { x: 38, y: 50 });
});

test('an obstacle with no area covers nothing', () => {
  // A panel can measure 0 px tall or wide; grown by the margin it would otherwise
  // become a 16 px block across the map's centre for the card to dodge.
  const spec = {
    view: rect(0, 0, 100, 100), card: rect(-10, -10, 10, 10), head: rect(-10, -10, 10, -5),
    obstacles: [rect(50, 50, 50, 50), rect(20, 50, 80, 50)], at: { x: 50, y: 50 }, margin: 8,
  };
  assert.deepEqual(clearSpot(spec), { x: 50, y: 50 });
});

test('without a head the whole card is the head', () => {
  // The spec of 'the name line is cleared before the rest of the card' with no head:
  // nothing comes before the rest of the card, so of the spots that leave the least
  // of it covered (top anywhere from 45 to 50) the one nearest the map's centre wins.
  const spec = {
    view: rect(0, 0, 100, 100), card: rect(0, 0, 40, 40),
    obstacles: [rect(0, 0, 100, 50), rect(0, 85, 100, 100)], at: { x: 30, y: 0 }, margin: 0,
  };
  assert.deepEqual(clearSpot(spec), { x: 30, y: 45 });
});

// mulberry32: a seeded generator, so a failure names a case that reruns.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('matches a brute-force search over every whole-pixel landing spot', () => {
  const rnd = seeded(20261002);
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  for (let n = 0; n < 400; n++) {
    const vl = int(-5, 5), vt = int(-5, 5);
    const view = rect(vl, vt, vl + int(20, 60), vt + int(20, 60));
    const w = int(1, 25), h = int(1, 25);
    const cl = -int(0, w), ct = -int(0, h);
    const card = rect(cl, ct, cl + w, ct + h);
    const hl = int(card.left, card.right - 1), ht = int(card.top, card.bottom - 1);
    const head = rect(hl, ht, int(hl + 1, card.right), int(ht + 1, card.bottom));
    const obstacles = Array.from({ length: int(0, 4) }, () => {
      const l = int(view.left - 5, view.right), t = int(view.top - 5, view.bottom);
      // 0 now and then: a panel with no area.
      return rect(l, t, l + int(0, 30), t + int(0, 30));
    });
    const spec = {
      view, card, head, obstacles, margin: int(0, 4),
      at: { x: int(view.left - 10, view.right + 10), y: int(view.top - 10, view.bottom + 10) },
    };
    const cover = pixelCover(spec);
    const got = clearSpot(spec);
    const label = `case ${n}: ${JSON.stringify({ spec, got })}`;
    assert.ok(inDomain(spec, got), `outside the allowed spots, ${label}`);
    assert.deepEqual(costAt(spec, cover, got.x, got.y), bruteForce(spec, cover), `not the best spot, ${label}`);
  }
});
