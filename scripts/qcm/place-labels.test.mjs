// A dot is not a place — audit F05.
//
// Every town in the export is drawn (quiet-corners.js renderPlaceContext), but as a
// radius-2 circle with `interactive: false` and no text. Below zoom 9 there is no
// basemap either, so a reader looking at central Wisconsin sees a scatter of identical
// grey dots and cannot name one of them without clicking a CANDIDATE — and a candidate
// is a filter result, so in a state that matches nothing there is nothing to click at
// all. The map knows 1,574 place names and shows none of them.
//
// These gates hold the fix to what a map actually has to do: names on screen, names
// that do not sit on top of each other, fewer of them as you zoom out (the big towns
// win), and names that do not disappear when the ranking filters come up empty.
//
// divIcon labels are real DOM, unlike the canvas circles, so they can be counted and
// their boxes measured directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt() ? 'public/quiet-corners/ not built — run `hugo --configDir site-config --minify` first'
    : false;

/** Central Wisconsin: dense enough in the export to make decluttering matter. */
const HERE = [44.5, -89.5];
const REGIONAL_ZOOM = 8;
const NATIONAL_ZOOM = 4;

/** A regional view has to name enough places to orient by. Two is a scatter. */
const MIN_REGIONAL_LABELS = 6;

const labelsAt = (z, lat = HERE[0], lon = HERE[1]) => `(async () => {
  const map = window.qcMap;
  if (!map) return { error: 'window.qcMap is not exposed' };
  // renderPlaceLabels runs on the moveend this setView fires, and runs
  // synchronously once its data is in memory -- which readyDashboard has already
  // waited for. What is left to wait for is the move itself ending.
  const settled = qcMoves();
  map.setView([${lat}, ${lon}], ${z}, { animate: false });
  await settled('the map settled at zoom ${z}');
  const els = [...document.querySelectorAll('.qc-place-label')];
  return {
    zoom: map.getZoom(),
    count: els.length,
    texts: els.slice(0, 40).map(e => e.textContent.trim()),
    tiers: els.map(e => e.getAttribute('data-tier')),
    orientation: els.filter(e => !['town', 'local'].includes(e.getAttribute('data-tier')))
      .map(e => e.textContent.trim()),
    pops: els.map(e => Number(e.getAttribute('data-pop'))).filter(n => n > 0),
    boxes: els.map(e => { const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height }; }),
  };
})()`;

async function withMap(fn) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, `${site.origin}/quiet-corners/`, {
    viewport: { width: 1440, height: 1000 }, args: ['--hide-scrollbars'],
  });
  try {
    await readyDashboard(page);
    return await fn(page);
  } finally { page.close(); await site.close(); }
}

test('a regional view names the places on it', { skip }, async () => {
  const seen = await withMap((p) => p.evaluate(labelsAt(REGIONAL_ZOOM)));
  assert.equal(seen.error, undefined, seen.error);
  assert.ok(seen.count >= MIN_REGIONAL_LABELS,
    `only ${seen.count} place label(s) at zoom ${REGIONAL_ZOOM} — a reader cannot tell `
    + 'one grey dot from another without names on the map');
  assert.ok(seen.texts.every((t) => t.length > 0), 'a label rendered with no text in it');
});

test('no two labels are painted on top of each other', { skip }, async () => {
  const seen = await withMap((p) => p.evaluate(labelsAt(REGIONAL_ZOOM)));
  const b = seen.boxes;
  const overlaps = [];
  for (let i = 0; i < b.length; i++) {
    for (let j = i + 1; j < b.length; j++) {
      const a = b[i], c = b[j];
      if (a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h) {
        overlaps.push(`${seen.texts[i] ?? i} / ${seen.texts[j] ?? j}`);
      }
    }
  }
  assert.deepEqual(overlaps, [],
    `${overlaps.length} label pair(s) overlap — unreadable:\n${overlaps.slice(0, 6).join('\n')}`);
});

/** Not a count comparison: a national view covers far more towns than one sparse
 *  regional view, so it may legitimately carry more labels in total. The claim worth
 *  holding is which ones survive — zooming out drops the small towns first.
 *
 *  Read at the LOWER QUARTILE, not at the single minimum. The minimum is one
 *  straggler: the greedy pass fills what space is left after the big names are
 *  placed, so once S4c added a second tier, one 1,019-person town slipped into a
 *  gap at national zoom against a 1,023-person floor at regional zoom — a
 *  four-person inversion that says nothing about hierarchy. Measured on the same
 *  build, the quartile says it plainly: 2,366 at national zoom against 1,303 at
 *  regional, and the medians are 2,689 against 1,681. Nothing was relaxed — the
 *  claim is the same one, read off the distribution instead of its tail. */
const lowerQuartile = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.25)];

test('zooming out drops the small towns first', { skip }, async () => {
  const { far, near } = await withMap(async (p) => ({
    near: await p.evaluate(labelsAt(REGIONAL_ZOOM)),
    far: await p.evaluate(labelsAt(NATIONAL_ZOOM)),
  }));
  assert.ok(near.pops.length > 0 && far.pops.length > 0,
    `labels must carry data-pop to be ranked: ${near.pops.length}/${far.pops.length}`);
  assert.ok(lowerQuartile(far.pops) > lowerQuartile(near.pops),
    `the smallest quarter of labelled towns starts at ${lowerQuartile(far.pops)} at zoom `
    + `${NATIONAL_ZOOM} and ${lowerQuartile(near.pops)} at zoom ${REGIONAL_ZOOM} — zooming `
    + 'out has to shed the small ones, not keep them and crowd out the large');
});

/** The point of F05 that a label count alone would miss. Place names are geography,
 *  not a filter result: North Carolina passes zero candidates under the defaults, and
 *  that is exactly when a reader most needs to know the towns are there. */
test('names stay on the map when the filters match nothing', { skip }, async () => {
  const seen = await withMap(async (p) => {
    await p.evaluate(`(async () => {
      const sel = document.getElementById('qc-state');
      // qc-state applies its filter synchronously; it no longer moves the map on
      // its own, so the probe clicks the explicit Zoom to state button and waits
      // for that fitBounds to finish before it sets its own view, or the
      // animation would land on top of the view it measures.
      const zoomed = qcMoves();
      sel.value = 'NC';
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('qc-zoom-state').click();
      await zoomed('the map finished zooming to NC');
      return document.querySelectorAll('.qc-candidate-row').length;
    })()`);
    return p.evaluate(labelsAt(REGIONAL_ZOOM, 35.6, -82.5));
  });
  assert.ok(seen.count >= MIN_REGIONAL_LABELS,
    `${seen.count} label(s) over North Carolina with zero candidates — the towns are `
    + 'still there, and the map has to keep saying so');
});

/** The view a reader actually opens. Every case above calls setView, which fires the
 *  moveend the labeller listens on -- so all four passed while the page as delivered
 *  carried no names at all. The default CONUS view is set once, before candidates.json
 *  lands, and a reader who never drags the map never produces another. */
test('the national view has names on it before anyone touches the map', { skip }, async () => {
  const count = await withMap(async (p) => {
    // Not a silent give-up: a probe that ran out of patience must say so itself,
    // or the count below reports a page that was never given the chance as a page
    // that failed to name anything.
    await waitInPage(p, 'a place label reached the untouched national view',
      `!!document.querySelector('.qc-place-label')`);
    return p.evaluate(`document.querySelectorAll('.qc-place-label').length`);
  });
  assert.ok(count > 0,
    'the map opens with no place names on it — the labeller only runs on moveend, '
    + 'and the default view never moves');
});

/** S4c. `candidates.json` is the scored small-town export and was the only thing this
 *  map named, so the national view listed 47 places a reader has never heard of and
 *  nothing to locate them against. navigation-places.json carries the other layer --
 *  the large places the pipeline deliberately scores out -- and these two gates hold
 *  what it is for: a frame at national zoom, and a frame that does not become the
 *  content. */
const KNOWN = ['New York', 'Chicago', 'Denver', 'Dallas', 'Houston', 'Phoenix',
  'Los Angeles', 'Atlanta', 'Minneapolis', 'Seattle', 'Miami', 'Detroit'];

test('the national view names places a reader has heard of', { skip }, async () => {
  const seen = await withMap((p) => p.evaluate(labelsAt(NATIONAL_ZOOM)));
  assert.equal(seen.error, undefined, seen.error);
  const named = seen.orientation.filter((t) => KNOWN.includes(t));
  assert.ok(named.length > 0,
    `no large place is named at zoom ${NATIONAL_ZOOM} — the view shows `
    + `${seen.count} label(s) and none of them is somewhere a reader could orient by: `
    + seen.texts.slice(0, 12).join(', '));
  assert.ok(seen.tiers.some((t) => t === 'major'),
    'an orientation label must say which tier it came from, so the greedy pass can be '
    + 'told apart from the town labels it frames');
});

/** Orientation is a frame, not the content. The dashboard is about the small towns,
 *  so the large places take a bounded share of the screen and the towns keep the rest
 *  -- otherwise S4c would answer one audit finding by erasing the layer of another. */
test('the orientation names do not crowd out the towns', { skip }, async () => {
  const seen = await withMap((p) => p.evaluate(labelsAt(NATIONAL_ZOOM)));
  assert.ok(seen.orientation.length <= 24,
    `${seen.orientation.length} orientation labels at zoom ${NATIONAL_ZOOM} — past the `
    + 'budget, and the towns this dashboard is about lose their names to them');
  assert.ok(seen.pops.length > 0,
    'the national view carries no town labels at all — the large places have taken '
    + 'every slot, which is the failure this budget exists to prevent');
});

/** D1. A place in neither candidates.json (1K-3K, rural counties) nor navigation-places.json
 *  (100K+) was never lettered: Franklin NC (Census place 3724640, 4,362 people) sat between the
 *  two windows. The dashboard now also reads per-state place shards, on its own, from zoom 6 up.
 *  The shards are served from fixtures (helpers/place-shards.mjs), never the live export. */
import {
  skip as shardSkip, withShardedMap, labelsAt as shardLabelsAt, STEVENSVILLE, MACON, NATIONAL, HIGHLANDS_CANDIDATE,
} from './helpers/place-shards.mjs';

const FRANKLIN = [35.18, -83.38];

for (const z of [9, 11, 13]) {
  test(`a mid-size place in neither town file is lettered at zoom ${z}`, { skip: shardSkip }, async () => {
    const seen = await withShardedMap({}, (p) => p.evaluate(shardLabelsAt(FRANKLIN[0], FRANKLIN[1], z)));
    assert.ok(seen.texts.includes('Franklin'),
      `Franklin NC is in the place shard but not lettered at zoom ${z}: ${seen.texts.join(', ')}`);
    assert.ok(seen.townLabels.some((t) => t.name === 'Franklin' && t.state === 'NC'),
      'a shard label must reach window.qcTownLabels with its state, or the GNIS dedupe cannot see it');
  });
}

test('a place already in candidates.json is not lettered a second time from the shard', { skip: shardSkip }, async () => {
  // The shard copy of Highlands is moved 0.02 degrees north so a duplicate would NOT be hidden
  // by colliding with the candidate's own plate.
  const shards = {
    NC: { ...(await import('./helpers/place-shards.mjs')).MACON,
      places: [['3731360', 'Highlands', 35.0738, -83.1976, 1119]] },
  };
  const seen = await withShardedMap({ shards }, (p) => p.evaluate(shardLabelsAt(35.06, -83.2, 13)));
  assert.equal(seen.texts.filter((t) => t === 'Highlands').length, 1,
    `Highlands was drawn ${seen.texts.filter((t) => t === 'Highlands').length} times: ${seen.texts.join(', ')}`);
});

test('a state is fetched only when the view reaches it, and only from zoom 6', { skip: shardSkip }, async () => {
  const low = await withShardedMap({}, (p) => p.evaluate(shardLabelsAt(FRANKLIN[0], FRANKLIN[1], 5)));
  assert.deepEqual(low.urls, ['national'], `only the national head may be requested at zoom 5: ${low.urls}`);
  const seen = await withShardedMap({}, async (p) => {
    await p.evaluate(shardLabelsAt(FRANKLIN[0], FRANKLIN[1], 11));
    return p.evaluate(shardLabelsAt(FRANKLIN[0] + 0.01, FRANKLIN[1], 11));
  });
  assert.deepEqual(seen.urls.slice().sort(), ['NC', 'index', 'national'],
    `expected one head, one index and one NC shard fetch, got ${seen.urls}`);
});

/** One ladder, not two. Below zoom 6 no state shard is loaded, so the town pool there was
 *  candidates.json alone (scored 1K-3K towns) while a regional view ranked from every Census
 *  place -- zooming out ADDED small towns ("zooming out drops the small towns first" above
 *  went red on master once W1's shards shipped). places-national.json is the head of the
 *  same ranking (state per row), fetched once from the first label zoom. */
const BISMARCK = [NATIONAL.places[1][2], NATIONAL.places[1][3]];
const ASHEVILLE = [NATIONAL.places[0][2], NATIONAL.places[0][3]];

test('a place in the national head is lettered below the shard zoom from that one fetch', { skip: shardSkip }, async () => {
  const seen = await withShardedMap({}, (p) => p.evaluate(shardLabelsAt(BISMARCK[0], BISMARCK[1], 5)));
  assert.ok(seen.texts.includes('Bismarck'),
    `Bismarck is in places-national.json but not lettered at zoom 5: ${seen.texts.join(', ')}`);
  assert.deepEqual(seen.urls, ['national'], `expected only the national head to be fetched, got ${seen.urls}`);
  assert.ok(seen.townLabels.some((t) => t.name === 'Bismarck' && t.state === 'ND'),
    'a head label must reach window.qcTownLabels with the state its row carries');
});

test('below the shard zoom a town under the head\'s own floor waits for its shard', { skip: shardSkip }, async () => {
  // A 1K scored town (candidates.json) is under the fixture head's last row (Bismarck,
  // 73,529) and no shard is loaded at zoom 5 -- it is a rung the view has not reached. It
  // sits in north-west North Dakota, hundreds of km from any orientation name, so the only
  // thing that can keep it off the map is the floor.
  const crosby = { ...HIGHLANDS_CANDIDATE, fips: '3817740', name: 'Crosby city', state: 'ND',
    county_fips: '38023', county_name: 'Divide County', population: 1070, lat: 48.914, lon: -103.295 };
  const at = (p) => p.evaluate(shardLabelsAt(crosby.lat, crosby.lon, 5));
  const held = await withShardedMap({ candidates: [crosby] }, at);
  assert.ok(!held.texts.includes('Crosby'),
    `a 1,070-person town was lettered at zoom 5 from candidates.json while the head stops at ${NATIONAL.places.at(-1)[4]}`);
  // No head, no floor: the ladder degrades to what it was, never to a blank map.
  const empty = { fields: NATIONAL.fields, places: [] };
  const alone = await withShardedMap({ candidates: [crosby], national: empty }, at);
  assert.ok(alone.texts.includes('Crosby'),
    `with no national head the candidate town must still be lettered: ${alone.texts.join(', ')}`);
});

test('a head place is lettered once when its state shard also holds it', { skip: shardSkip }, async () => {
  // The shard copy is moved 0.02 degrees north so a duplicate would NOT be hidden by colliding
  // with the head row's own plate.
  const shards = {
    NC: { ...MACON, places: [...MACON.places, ['3702140', 'Asheville', ASHEVILLE[0] + 0.02, ASHEVILLE[1], 94589]] },
  };
  const seen = await withShardedMap({ shards }, (p) => p.evaluate(shardLabelsAt(ASHEVILLE[0], ASHEVILLE[1], 11)));
  const n = seen.texts.filter((t) => t === 'Asheville').length;
  assert.equal(n, 1, `Asheville was drawn ${n} times: ${seen.texts.join(', ')}`);
});

test('a place shard that fails to load leaves the towns already drawn', { skip: shardSkip }, async () => {
  const seen = await withShardedMap({ shardStatus: 500 }, (p) => p.evaluate(shardLabelsAt(35.06, -83.2, 11)));
  assert.ok(seen.texts.includes('Highlands'), `the candidate town vanished with the shard: ${seen.texts.join(', ')}`);
  assert.ok(!seen.texts.includes('Franklin'), 'Franklin is drawn from a shard that answered 500');
});

test('Stevensville MT is lettered from its shard', { skip: shardSkip }, async () => {
  const [lat, lon] = [STEVENSVILLE.places[0][2], STEVENSVILLE.places[0][3]];
  const seen = await withShardedMap({}, (p) => p.evaluate(shardLabelsAt(lat, lon, 11)));
  assert.ok(seen.texts.includes('Stevensville'), `Stevensville not lettered: ${seen.texts.join(', ')}`);
});
