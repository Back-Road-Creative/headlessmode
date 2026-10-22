// QQA-05a: every label this map owns is readable, and the Large setting really
// changes 2D text. Proves what a pure test cannot: the computed font size, plate
// and family of the DOM labels the real page draws (the dashboard's town and
// orientation names, and the GNIS name spans Q/main.js draws), that one size
// source (the --qc-label-px property on the map container) drives all of them,
// that the layout box a label reserves matches what it paints, and that a size
// change re-runs the dashboard's own declutter so enlarged names still do not
// overlap. Same real built page, same launch/readyDashboard convention as
// label-prefs-browser.test.mjs; unlike it, fetch is NOT stubbed empty -- the
// town names come from the real candidates.json / navigation-places.json, and
// only the GNIS geonames service is answered from the sanitised synthetic
// fixture names-keyboard.test.mjs uses, so no request leaves the box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage, chooseExampleArea } from './helpers/waits.mjs';
import { PLACE_FEATURES } from './fixtures/gnis-names-declutter.mjs';
import { SIZE_SCALE } from '../../themes/headlessmode/static/js/quiet-corners-maps/name-labels.js';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const CEILING = 20000;
// Town-weight tiers: 'town' from candidates.json and 'local' from the Census place shards (the
// dashboard draws both with the town class and sizes them alike). place-labels.test.mjs:50 agrees.
const TOWN_TIERS = ['town', 'local'];
const TOWN_SELECTOR = TOWN_TIERS.map((t) => `.qc-place-label[data-tier="${t}"]`).join(', ');
/** Central Wisconsin: dense enough in the export to make decluttering matter. */
const WISCONSIN = [44.5, -89.5, 8];
/** Charlotte NC is a "major" orientation place, drawn from zoom 4. */
const CHARLOTTE = [35.2, -80.83, 7];
/** The Sylva NC area: a real town record named "Sylva town". */
const SYLVA = [35.375, -83.218, 10];
/** Rogers City MI: a real record named "Rogers City city". */
const ROGERS_CITY = [45.4177, -83.8048, 10];

const COUNTS = { 3: PLACE_FEATURES.length, 5: 0, 6: 0, 7: 0 };
const PAGES = { 3: PLACE_FEATURES, 5: [], 6: [], 7: [] };
const PATCH_SOURCE = `(() => {
  const counts = ${JSON.stringify(COUNTS)};
  const pages = ${JSON.stringify(PAGES)};
  const real = window.fetch.bind(window);
  window.fetch = function(input, init) {
    const url = String(input && input.url ? input.url : input);
    // The NHD river tier is answered empty: these proofs are hermetic and about the GNIS names.
    if (/nhd\\/MapServer\\/\\d+\\/query/.test(url)) return Promise.resolve(new Response(JSON.stringify({ features: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const m = url.match(/geonames\\/MapServer\\/(\\d+)\\/query/);
    if (m) {
      const body = /returnCountOnly=true/.test(url) ? { count: counts[m[1]] ?? 0 } : { features: pages[m[1]] ?? [] };
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    }
    return real(input, init);
  };
})()`;

async function withDashboard(fn) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', {
    viewport: { width: 1440, height: 1000 }, args: ['--hide-scrollbars'],
  });
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PATCH_SOURCE });
    await page.navigate(`${site.origin}/quiet-corners/`);
    await readyDashboard(page, { ms: CEILING });
    return await fn(page);
  } finally { page.close(); await site.close(); }
}

const goTo = (page, [lat, lon, z]) => page.evaluate(`(async () => {
  const settled = qcMoves();
  window.qcMap.setView([${lat}, ${lon}], ${z}, { animate: false });
  await settled('the map settled at zoom ${z}');
  return true;
})()`);

/** What the page paints for each dashboard place label: computed, never declared. */
const READ_PLACE_LABELS = `(() => [...document.querySelectorAll('.qc-place-label')].map((e) => {
  const cs = getComputedStyle(e), r = e.getBoundingClientRect();
  return { text: e.textContent.trim(), tier: e.getAttribute('data-tier'), fontSize: parseFloat(cs.fontSize),
    family: cs.fontFamily, bg: cs.backgroundColor, color: cs.color, box: { x: r.x, y: r.y, w: r.width, h: r.height } };
}))()`;

const alphaOf = (rgba) => { const m = /rgba?\(([^)]+)\)/.exec(rgba); const p = m ? m[1].split(',') : []; return p.length > 3 ? Number(p[3]) : 1; };

async function setSize(page, size) {
  await page.evaluate(`(() => {
    const sel = document.getElementById('qc-label-size');
    sel.value = ${JSON.stringify(size)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}

test('default: a town label is at least 14px, on a plate, in a sans-serif face', { skip }, async () => {
  await withDashboard(async (page) => {
    await goTo(page, WISCONSIN);
    const labels = await page.evaluate(READ_PLACE_LABELS);
    assert.ok(labels.length >= 6, `expected a regional view to name places, got ${labels.length}`);
    const towns = labels.filter((l) => TOWN_TIERS.includes(l.tier));
    assert.ok(towns.length > 0, 'a regional view draws town labels');
    for (const l of labels) {
      assert.ok(l.fontSize >= 14, `"${l.text}" paints at ${l.fontSize}px; the floor is 14px`);
      assert.ok(alphaOf(l.bg) >= 0.78, `"${l.text}" sits on a plate of alpha ${alphaOf(l.bg)} (${l.bg}); a halo alone is not a plate`);
      assert.ok(!/monospace/i.test(l.family), `"${l.text}" is drawn in ${l.family}`);
    }
    const panes = await page.evaluate(`(() => {
      const el = window.qcMap.getPane('qc-labels'), cs = getComputedStyle(el);
      return { z: cs.zIndex, events: cs.pointerEvents,
        overlayZ: getComputedStyle(window.qcMap.getPane('overlayPane')).zIndex };
    })()`);
    assert.equal(Number(panes.z), 410);
    assert.ok(Number(panes.z) > Number(panes.overlayZ), 'owned labels sit above the canvas dots/matches, not under them');
    assert.equal(panes.events, 'none', 'a label never swallows a click on what is under it');
  });
});

test('the label controls live in the Layers panel, with an Extra large option', { skip }, async () => {
  await withDashboard(async (page) => {
    const where = await page.evaluate(`(() => {
      const size = document.getElementById('qc-label-size'), density = document.getElementById('qc-label-density');
      const text = (id) => { const l = document.querySelector('label[for="' + id + '"]'); return l ? l.textContent.replace(/\\s+/g, ' ').trim() : null; };
      return {
        inLayers: !!document.getElementById('qcm-layer-panel').contains(size) && !!document.getElementById('qcm-layer-panel').contains(density),
        inExplore: !!document.getElementById('qc-explore-panel').contains(size) || !!document.getElementById('qc-explore-panel').contains(density),
        underAppearance: !!size.closest('details.qcm-appearance') && !size.closest('details.qcm-appearance').open,
        sizeLabel: text('qc-label-size'), densityLabel: text('qc-label-density'),
        options: [...size.options].map((o) => o.value + ':' + o.textContent.trim()),
      };
    })()`);
    assert.equal(where.inLayers, true, 'both controls are in the Layers panel');
    assert.equal(where.inExplore, false, 'neither is left in Explore');
    assert.equal(where.underAppearance, true, 'the controls sit under the closed Map appearance disclosure, so the collapsed panel keeps its length budget');
    assert.match(where.sizeLabel, /^Map label size/);
    assert.match(where.densityLabel, /^Map label crowding/);
    assert.deepEqual(where.options, ['normal:Normal', 'large:Large', 'xlarge:Extra large']);
  });
});

test('Large: town 18px, orientation 20px; Extra large: 24px; one property and one event carry it', { skip }, async () => {
  await withDashboard(async (page) => {
    await page.evaluate(`(() => {
      window.__prefEvents = [];
      document.addEventListener('qc:label-prefs-changed', (e) => window.__prefEvents.push(e.detail));
    })()`);
    await goTo(page, CHARLOTTE);
    const sizes = () => page.evaluate(`(() => {
      const els = [...document.querySelectorAll('.qc-place-label')];
      const isTown = (x) => ${JSON.stringify(TOWN_TIERS)}.includes(x.getAttribute('data-tier'));
      const px = (pick) => { const e = els.find(pick); return e ? parseFloat(getComputedStyle(e).fontSize) : null; };
      return { town: px(isTown), nav: px((x) => !isTown(x)) };
    })()`);
    const normal = await sizes();
    assert.ok(normal.town >= 14 && normal.nav >= 14, `default sizes ${JSON.stringify(normal)}`);

    await setSize(page, 'large');
    await waitInPage(page, 'town labels to repaint at 18px', `(() => {
      const e = document.querySelector(${JSON.stringify(TOWN_SELECTOR)});
      return e && parseFloat(getComputedStyle(e).fontSize) === 18;
    })()`, CEILING, null);
    const large = await sizes();
    assert.equal(large.town, 18);
    assert.equal(large.nav, 20, 'orientation names get 1.25rem at Large');
    const prop = await page.evaluate(`window.qcMap.getContainer().style.getPropertyValue('--qc-label-px')`);
    assert.equal(prop.trim(), '1.125rem');

    await setSize(page, 'xlarge');
    await waitInPage(page, 'town labels to repaint at 24px', `(() => {
      const e = document.querySelector(${JSON.stringify(TOWN_SELECTOR)});
      return e && parseFloat(getComputedStyle(e).fontSize) === 24;
    })()`, CEILING, null);
    const events = await page.evaluate('window.__prefEvents');
    assert.deepEqual(events.map((d) => d.size), ['large', 'xlarge'], 'one qc:label-prefs-changed per change, carrying the prefs');
    assert.equal((await page.evaluate('window.qcGetLabelPrefs()')).size, 'xlarge', 'an xlarge pref reaches Q/main.js state');
  });
});

test('after enlargement no two town labels overlap', { skip }, async () => {
  await withDashboard(async (page) => {
    await goTo(page, WISCONSIN);
    await setSize(page, 'xlarge');
    await waitInPage(page, 'labels to repaint at 24px', `(() => {
      const e = document.querySelector(${JSON.stringify(TOWN_SELECTOR)});
      return e && parseFloat(getComputedStyle(e).fontSize) === 24;
    })()`, CEILING, null);
    const labels = await page.evaluate(READ_PLACE_LABELS);
    assert.ok(labels.length >= 3, `expected several labels, got ${labels.length}`);
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i].box, b = labels[j].box;
        const overlap = a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
        assert.ok(!overlap, `"${labels[i].text}" and "${labels[j].text}" overlap at Extra large`);
      }
    }
  });
});

test('a town name drops the Census class word ("Sylva town", "Rogers City city")', { skip }, async () => {
  await withDashboard(async (page) => {
    await goTo(page, SYLVA);
    const sylva = (await page.evaluate(READ_PLACE_LABELS)).map((l) => l.text);
    assert.ok(sylva.includes('Sylva'), `labels: ${sylva.join(', ')}`);
    assert.ok(!sylva.includes('Sylva town'));
    await goTo(page, ROGERS_CITY);
    const rogers = (await page.evaluate(READ_PLACE_LABELS)).map((l) => l.text);
    assert.ok(rogers.includes('Rogers City'), `labels: ${rogers.join(', ')}`);
    assert.ok(!rogers.includes('Rogers City city'));
    // The raw name stays the dedupe key GNIS reads.
    const raw = await page.evaluate('window.qcTownLabels.map((t) => t.name)');
    assert.ok(raw.includes('Rogers City city'), `qcTownLabels: ${raw.join(', ')}`);
  });
});

test('sizes are rem-based: a 20px root font scales the default label to 17.5px', { skip }, async () => {
  await withDashboard(async (page) => {
    await goTo(page, WISCONSIN);
    await page.evaluate("document.documentElement.style.fontSize = '20px'");
    await page.evaluate("(async () => { await qcMeasured('the map caught up with the root font size'); return true; })()");
    await goTo(page, WISCONSIN);
    const px = await page.evaluate(`(() => {
      const e = document.querySelector(${JSON.stringify(TOWN_SELECTOR)});
      return e ? parseFloat(getComputedStyle(e).fontSize) : null;
    })()`);
    assert.equal(px, 17.5);
  });
});

test('GNIS names: the span paints the size the layout box reserved, at every size', { skip }, async () => {
  await withDashboard(async (page) => {
    await chooseExampleArea(page);
    await page.evaluate(`(() => {
      const cb = document.getElementById('qcm-layer-names');
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await page.evaluate("document.getElementById('qcm-check').click()");
    await waitInPage(page, 'name labels to render', "document.querySelectorAll('.qcm-name-label').length > 0", CEILING, null);
    const read = () => page.evaluate(`(() => [...document.querySelectorAll('.qcm-name-label')].map((e) => {
      const cs = getComputedStyle(e);
      return { fontSize: parseFloat(cs.fontSize), family: cs.fontFamily, bg: cs.backgroundColor,
        reserved: parseFloat(e.style.width), drawn: e.scrollWidth };
    }))()`);
    for (const size of ['normal', 'large', 'xlarge']) {
      await setSize(page, size);
      await waitInPage(page, `GNIS labels to repaint at ${SIZE_SCALE[size]}px`, `(() => {
        const e = document.querySelector('.qcm-name-label');
        return e && parseFloat(getComputedStyle(e).fontSize) === ${SIZE_SCALE[size]};
      })()`, CEILING, null);
      const spans = await read();
      assert.ok(spans.length > 0);
      for (const s of spans) {
        assert.equal(s.fontSize, SIZE_SCALE[size], `${size}: the span paints SIZE_SCALE.${size}`);
        assert.ok(s.reserved >= s.drawn - 1, `${size}: reserved ${s.reserved}px < drawn ${s.drawn}px -- the layout box and the paint disagree`);
        assert.ok(alphaOf(s.bg) >= 0.78, `${size}: GNIS span plate ${s.bg}`);
        assert.ok(!/monospace/i.test(s.family));
      }
    }
  });
});

test('GNIS names: at a 20px root font the span still paints inside the box it reserved', { skip }, async () => {
  await withDashboard(async (page) => {
    // The root font size is set BEFORE the layer draws, so the declutter measures
    // under the same rem the CSS paints with (--qc-label-px is in rem).
    await page.evaluate("document.documentElement.style.fontSize = '20px'");
    await chooseExampleArea(page);
    await page.evaluate(`(() => {
      const cb = document.getElementById('qcm-layer-names');
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await page.evaluate("document.getElementById('qcm-check').click()");
    await waitInPage(page, 'name labels to render', "document.querySelectorAll('.qcm-name-label').length > 0", CEILING, null);
    const read = () => page.evaluate(`(() => [...document.querySelectorAll('.qcm-name-label')].map((e) => ({
      fontSize: parseFloat(getComputedStyle(e).fontSize), reserved: parseFloat(e.style.width), drawn: e.scrollWidth,
      reservedH: parseFloat(e.style.height), drawnH: e.scrollHeight,
    })))()`);
    for (const size of ['normal', 'large', 'xlarge']) {
      await setSize(page, size);
      const want = (SIZE_SCALE[size] / 16) * 20;
      await waitInPage(page, `GNIS labels to repaint at ${want}px`, `(() => {
        const e = document.querySelector('.qcm-name-label');
        return e && parseFloat(getComputedStyle(e).fontSize) === ${want};
      })()`, CEILING, null);
      const spans = await read();
      assert.ok(spans.length > 0);
      for (const s of spans) {
        assert.equal(s.fontSize, want, `${size}: the span paints ${SIZE_SCALE[size]}px as rem at a 20px root`);
        assert.ok(s.reserved >= s.drawn - 1, `${size} @20px root: reserved ${s.reserved}px < drawn ${s.drawn}px -- the layout box and the paint disagree`);
        assert.ok(s.reservedH >= s.drawnH - 1, `${size} @20px root: reserved ${s.reservedH}px high < drawn ${s.drawnH}px`);
      }
    }
  });
});
