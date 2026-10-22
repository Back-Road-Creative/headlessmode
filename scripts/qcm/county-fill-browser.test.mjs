// QQA-06a: the county context fill is a score wash, not a base. With scores off the
// administrative outline stays and the fill is 0, so the topo reads through; turning
// scores on brings it back at the strengths quiet-corners.js declares (COUNTY_CONTEXT_FILL),
// turning them off drops it to 0 again, and nothing a reader does to a county (hover)
// puts it back while scores are off. Only a real page proves it: the fill is painted by
// Leaflet's SVG renderer from quiet-corners.js's own style callbacks, which no pure test
// reaches. The map paints on canvas, so the proof reads two things: each shape's own style
// (what Leaflet will paint) and the canvas pixel inside the unscored county (what it did
// paint). Same fetch-stub / readyDashboard convention as label-prefs-browser.test.mjs,
// except the stub answers the three county files with a tiny Sylva, NC area fixture
// (Jackson 37099 is a scored rural county, Haywood 37087 an unscored context one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard } from './helpers/waits.mjs';
import { contextFillFromSource } from './helpers/contrast.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const CEILING = 20000;
const FILL = contextFillFromSource();
const RURAL = '#1a2a3a';
const OTHER = '#12121e';

// Two adjacent boxes in the Sylva NC area. No transform, so the arcs are plain lon/lat.
const TOPO = {
  type: 'Topology',
  arcs: [
    [[-83.4, 35.2], [-83.0, 35.2], [-83.0, 35.5], [-83.4, 35.5], [-83.4, 35.2]],
    [[-83.0, 35.2], [-82.7, 35.2], [-82.7, 35.5], [-83.0, 35.5], [-83.0, 35.2]],
  ],
  objects: {
    counties: { type: 'GeometryCollection', geometries: [
      { type: 'Polygon', id: '37099', arcs: [[0]] },
      { type: 'Polygon', id: '37087', arcs: [[1]] },
    ] },
    states: { type: 'GeometryCollection', geometries: [{ type: 'Polygon', id: '37', arcs: [[0]] }] },
  },
};
const GEO = [{ fips: '37099', lat: 35.35, lon: -83.2, stability_score: 80, sprawl_risk: 5, overall_score: 80 }];
const COUNTIES = [{
  fips: '37099', state: 'NC', name: 'Jackson County', population: 43000, rucc: 7, stability_score: 80, sprawl_risk: 5,
  nearest_metro: 'Asheville city', distance_to_metro_mi: 120, affordability_score: 80, quietness_score: 80, overall_score: 80,
}];

/** Installed before the page's own script. The three county files carry the fixture;
 *  everything else gets the same harmless empty body label-prefs-browser.test.mjs uses. */
const PATCH_SOURCE = `(() => {
  const answers = ${JSON.stringify({ 'counties-10m.json': TOPO, 'geo.json': GEO, 'counties.json': COUNTIES })};
  window.fetch = function(url) {
    const hit = Object.keys(answers).find((name) => String(url).endsWith('/' + name));
    return Promise.resolve(new Response(JSON.stringify(hit ? answers[hit] : {}), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
  };
})()`;

/** The always-drawn administrative layer's shapes, by what they are filled with: its two
 *  context fills are the only polygons in the map that carry these colours. */
const SHAPES = `(() => {
  const out = [];
  window.qcMap.eachLayer((l) => {
    const o = l.options || {};
    if (l instanceof L.Polygon && (o.fillColor === '${RURAL}' || o.fillColor === '${OTHER}')) {
      out.push({ kind: o.fillColor === '${RURAL}' ? 'rural' : 'other', fillOpacity: o.fillOpacity, color: o.color, opacity: o.opacity, weight: o.weight });
    }
  });
  return out;
})()`;

/** The fillOpacity of every filled shape in the county pane -- the context fills AND the
 *  score-owned highlight of the scored county, which a hover could restyle. */
const ALL_FILLS = `(() => {
  const out = [];
  window.qcMap.eachLayer((l) => {
    const o = l.options || {};
    if (l instanceof L.Polygon && o.pane === 'qc-counties' && o.fill !== false) out.push(o.fillOpacity);
  });
  return out;
})()`;

/** Alpha (0..255) of the canvas pixel at the centre of Haywood, the unscored county: only
 *  its own context fill can paint there, so this is the fill as drawn. */
const PIXEL = `(() => {
  const map = window.qcMap;
  const canvas = document.querySelector('.leaflet-qc-counties-pane canvas');
  const p = map.latLngToContainerPoint([35.35, -82.85]);
  const box = map.getContainer().getBoundingClientRect(), c = canvas.getBoundingClientRect();
  const x = Math.round((box.left + p.x - c.left) * canvas.width / c.width);
  const y = Math.round((box.top + p.y - c.top) * canvas.height / c.height);
  return canvas.getContext('2d').getImageData(x, y, 1, 1).data[3];
})()`;

async function withCounties(fn) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', {
    viewport: { width: 1280, height: 900 }, args: ['--hide-scrollbars'],
  });
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PATCH_SOURCE });
    await page.navigate(`${site.origin}/quiet-corners/`);
    await readyDashboard(page, { data: false, ms: CEILING });
    // Bring both counties into view; the fixture's shapes exist once its three files landed.
    await page.evaluate(`window.qcWait('the county fixture drew its shapes', () => ${SHAPES}.length === 2, ${CEILING})`);
    await page.evaluate(`(() => { window.qcMap.fitBounds([[35.2, -83.4], [35.5, -82.7]]); })()`);
    await page.evaluate('window.qcMeasured("the map settled")');
    return await fn(page);
  } finally { page.close(); await site.close(); }
}

const opacities = async (page) => {
  const out = {};
  for (const s of await page.evaluate(SHAPES)) out[s.kind] = s.fillOpacity;
  return out;
};
const surface = (page, id) => page.evaluate(`(() => {
  const radio = document.getElementById(${JSON.stringify('qcm-context-' + id)});
  radio.checked = true;
  radio.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
const waitFor = (page, what, expr) => page.evaluate(`window.qcWait(${JSON.stringify(what)}, () => ${expr}, ${CEILING})`);
const alpha = (page) => page.evaluate(PIXEL);

test('the county context fill is 0 by default, comes back with scores, and goes again', { skip }, async () => {
  await withCounties(async (page) => {
    assert.deepEqual(await opacities(page), { rural: 0, other: 0 }, 'scores are off, so neither county class paints a fill');
    await waitFor(page, 'a repaint with no fill in it', `${PIXEL} === 0`);
    const outline = await page.evaluate(SHAPES);
    assert.equal(outline.length, 2, 'both context shapes are still drawn, as outlines');
    assert.ok(outline.every((s) => s.color === '#2a2a42' && s.opacity === 0.6 && s.weight === 0.3), 'the county outline is untouched');

    await surface(page, 'countyScore');
    await waitFor(page, 'the context fill returned with scores on', `${PIXEL} > 0`);
    assert.deepEqual(await opacities(page), FILL, 'scores on restores the declared context fill (rural, other)');
    assert.equal(await alpha(page), Math.round(FILL.other * 255), 'and the unscored county is painted at that strength');
    assert.ok((await page.evaluate(SHAPES)).every((s) => s.color === '#2a2a42' && s.opacity === 0.6 && s.weight === 0.3), 'the outline is still the same');

    await surface(page, 'none');
    await waitFor(page, 'the context fill dropped to 0 with scores off', `${PIXEL} === 0`);
    assert.deepEqual(await opacities(page), { rural: 0, other: 0 }, 'scores off again drops both classes back to 0');
  });
});

test('hovering or selecting a county does not bring the fill back while scores are off', { skip }, async () => {
  await withCounties(async (page) => {
    // The scored county is the one interactive shape. Other canvases (places, labels) sit
    // above the county pane and take a real pointer first, so the proof drives the events
    // Leaflet would deliver to the shape -- mouseover/mousemove/mouseout for a hover, click
    // for a selection -- and reads every filled shape after each.
    const fire = (type) => page.evaluate(`(() => {
      let n = 0;
      window.qcMap.eachLayer((l) => {
        if (l instanceof L.Polygon && l.options.pane === 'qc-counties' && l.options.interactive) {
          l.fire(${JSON.stringify(type)}, { latlng: l.getBounds().getCenter() }); n++;
        }
      });
      return n;
    })()`);
    for (const type of ['mouseover', 'mousemove', 'click', 'mouseout']) {
      assert.equal(await fire(type), 1, `the scored county's shape took the ${type}`);
      const fills = await page.evaluate(ALL_FILLS);
      assert.ok(fills.length >= 3, `expected both context shapes and the scored county's own shape, saw ${fills.length}`);
      assert.ok(fills.every((o) => o === 0), `${type} left a filled shape at ${fills} with scores off`);
      assert.deepEqual(await opacities(page), { rural: 0, other: 0 });
      await waitFor(page, `a repaint after ${type}`, `${PIXEL} === 0`);
    }
  });
});
