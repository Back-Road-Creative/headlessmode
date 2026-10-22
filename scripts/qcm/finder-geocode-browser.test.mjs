// QQA-04b in the real page: the finder looks an address up through /api/geocode.
//
// The endpoint (QQA-04a, same origin, answers from the U.S. Census geocoder) is stubbed
// per its contract, so nothing here leaves the box. What the page must do with it:
//   * typing an address sends nothing; Search (or Enter) sends it, once;
//   * a match is a row labelled with the matched address and "estimated along the
//     street, not a doorstep", and choosing it moves the map there;
//   * no match, 429, 502, 504 and a 404 (endpoint not deployed) each get an honest
//     sentence that offers coordinates or a map pin, and none calls the address a
//     missing town or puts a nearby town in its place;
//   * the newest search wins: an older request is cancelled and a late answer to it
//     is dropped;
//   * the typed address never reaches the page address, the title, storage or a
//     shared link;
//   * QQA-04c: the Census Bureau's notice is shown, legibly, whenever address results
//     or the geocoder's no-match / unavailable sentence are, and never for a town.
//
// Fixtures are synthetic: an invented road and the Census Bureau's public headquarters
// street address. The owner's real address never appears in the repo (QQA-00).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard } from './helpers/waits.mjs';
import { contrastRatio } from './helpers/contrast.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const EXAMPLE = '100 Example Rd, Anytown, NC';
const CENSUS_HQ = '4600 Silver Hill Rd, Washington, DC';
const ok = (results) => ({ provider: 'us-census', benchmark: 'Public_AR_Current', results });
const HIT_A = {
  id: 'tiger:90001:L', label: '100 EXAMPLE RD, ANYTOWN, NC, 28000', matchClass: 'interpolated',
  lat: 35.55, lon: -82.55, state: 'NC', zip: '28000',
};
const HIT_B = {
  id: 'tiger:90001:R', label: '102 EXAMPLE RD, ANYTOWN, NC, 28000', matchClass: 'interpolated',
  lat: 35.5502, lon: -82.5502, state: 'NC', zip: '28000',
};
const HIT_HQ = {
  id: 'tiger:90002:L', label: '4600 SILVER HILL RD, WASHINGTON, DC, 20233', matchClass: 'interpolated',
  lat: 38.84, lon: -76.93, state: 'DC', zip: '20233',
};

/** Installed before the page's own script. /api/geocode takes its answers from
 *  window.__geoNext (a queue of plans: { status, body, hold, ignoreAbort, passthrough,
 *  offline }); a plan with `hold` waits for call.release(). Every other off-site request
 *  fails at once, so the sky cards and GNIS never touch a network. */
const STUB = `(() => {
  window.__geoCalls = []; window.__geoNext = []; window.__gnisCalls = 0; window.__nwsCalls = []; window.__shared = [];
  const real = window.fetch.bind(window);
  window.fetch = function(input, init) {
    const url = String(input && input.url ? input.url : input);
    if (url.indexOf('/api/geocode') !== -1) {
      const call = { url, aborted: false, credentials: init && init.credentials, release: null };
      window.__geoCalls.push(call);
      const plan = window.__geoNext.shift() || { passthrough: true };
      if (plan.passthrough) return real(input, init);
      return new Promise((resolve, reject) => {
        if (init && init.signal) init.signal.addEventListener('abort', () => {
          call.aborted = true;
          if (!plan.ignoreAbort) reject(new DOMException('aborted', 'AbortError'));
        });
        const answer = () => {
          if (plan.offline) { reject(new TypeError('Failed to fetch')); return; }
          resolve(new Response(JSON.stringify(plan.body || {}), {
            status: plan.status || 200, headers: { 'content-type': 'application/json; charset=utf-8' } }));
        };
        if (plan.hold) call.release = answer; else answer();
      });
    }
    if (url.indexOf('carto.nationalmap.gov') !== -1) {
      window.__gnisCalls++;
      return Promise.resolve(new Response('{"features":[]}', { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    if (url.indexOf('api.weather.gov') !== -1) window.__nwsCalls.push(url);
    if (/^https?:/.test(url) && url.indexOf(location.origin) !== 0) return Promise.reject(new TypeError('offline'));
    return real(input, init);
  };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__shared.push(t); return Promise.resolve(); } } });
})()`;

async function withFinder(fn, viewport = { width: 1280, height: 900 }) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', { viewport, args: ['--hide-scrollbars'] });
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
    await page.navigate(`${site.origin}/quiet-corners/`);
    await readyDashboard(page, { ms: 60000 });
    return await fn(page);
  } finally { page.close(); await site.close(); }
}

const plan = (p, ...plans) => p.evaluate(`(window.__geoNext.push(...${JSON.stringify(plans)}), true)`);

/** Open the box and type; with `press`, click Search and wait until the lookup has
 *  settled (the note stops saying it is looking). Reads what a reader is shown. */
const typeAndRead = (term, press) => `(async () => {
  const toggle = document.querySelector('.qc-finder-toggle');
  if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
  const box = document.getElementById('qc-place-search');
  box.focus();
  box.value = ${JSON.stringify(term)};
  box.dispatchEvent(new Event('input', { bubbles: true }));
  ${press ? `document.getElementById('qc-name-search-btn').click();
  await qcWait('the lookup settled', () => {
    const n = document.getElementById('qc-name-note');
    return n && !n.hidden && n.textContent.trim() && !/looking up/i.test(n.textContent) ? n : null;
  });` : ''}
  const text = (id) => { const e = document.getElementById(id); return e && !e.hidden ? e.textContent.trim() : ''; };
  return {
    note: text('qc-finder-note'), nameNote: text('qc-name-note'),
    live: document.getElementById('qc-finder-status').textContent.trim(),
    options: [...document.querySelectorAll('#qc-place-results [role="option"]')].map((o) => o.textContent.trim()),
    geoCalls: window.__geoCalls.length, gnisCalls: window.__gnisCalls,
  };
})()`;

const ALTERNATIVES = /coordinates \(latitude, longitude\)/i;
const MISSING_TOWN = /no town|is in this list|no names|nearby/i;

test('typing an address sends nothing; Search sends it once and lists estimated street matches', { skip }, async () => {
  await withFinder(async (p) => {
    const typed = await p.evaluate(typeAndRead(EXAMPLE, false));
    assert.match(typed.note, /press search/i, typed.note);
    assert.doesNotMatch(typed.note, /not available/i);
    assert.equal(typed.geoCalls, 0, 'a keystroke sent the address away');
    assert.equal(typed.options.length, 0);

    await plan(p, { body: ok([HIT_A, HIT_B]) });
    const seen = await p.evaluate(typeAndRead(EXAMPLE, true));
    assert.equal(seen.geoCalls, 1);
    assert.equal(seen.gnisCalls, 0, 'the address went to the GNIS name search');
    assert.equal(seen.options.length, 2, JSON.stringify(seen));
    for (const [i, hit] of [HIT_A, HIT_B].entries()) {
      assert.ok(seen.options[i].includes(hit.label), seen.options[i]);
      assert.match(seen.options[i], /estimated along the street, not a doorstep/i, seen.options[i]);
    }
    assert.match(seen.nameNote, /^2 street matches/, seen.nameNote);
    assert.match(seen.nameNote, /not a doorstep/i);
    assert.equal(seen.live, seen.nameNote, 'a screen reader is told something other than what the page shows');
    assert.equal(seen.note, '', 'a found address still carried the prompt');
    const call = await p.evaluate('window.__geoCalls[0]');
    assert.equal(call.url, '/api/geocode?q=' + encodeURIComponent(EXAMPLE));
    assert.equal(call.credentials, 'omit');
    assert.equal(await p.evaluate(`document.querySelectorAll('#qc-place-results [role="group"]')[0].getAttribute('aria-label')`),
      'Street addresses (estimated)');
  });
});

test('choosing a street match moves the map there, closes the finder and says it is an estimate', { skip }, async () => {
  await withFinder(async (p) => {
    await plan(p, { body: ok([HIT_HQ]) });
    await p.evaluate(typeAndRead(CENSUS_HQ, true));
    await p.evaluate(`document.querySelector('#qc-place-results [role="option"]').click()`);
    const c = await p.evaluate(`(() => { const m = window.qcMap.getCenter(); return {
      lat: m.lat, lon: m.lng, zoom: window.qcMap.getZoom(),
      open: document.getElementById('qc-finder-box').hidden === false,
      heading: document.getElementById('qc-conditions-for').textContent,
    }; })()`);
    assert.ok(Math.abs(c.lat - HIT_HQ.lat) < 0.01 && Math.abs(c.lon - HIT_HQ.lon) < 0.01, JSON.stringify(c));
    assert.equal(c.open, false);
    assert.match(c.heading, /street estimate/i, c.heading);
    assert.doesNotMatch(c.heading, /exact (address|household)|doorstep address/i, c.heading);
  });
});

test('choosing a street match asks the National Weather Service at the rounded point, which privacy.md and the page copy disclose', { skip }, async () => {
  await withFinder(async (p) => {
    await plan(p, { body: ok([HIT_HQ]) });
    await p.evaluate(typeAndRead(CENSUS_HQ, true));
    assert.equal(await p.evaluate('window.__nwsCalls.length'), 0, 'finding a match asks nothing');
    await p.evaluate(`document.querySelector('#qc-place-results [role="option"]').click()`);
    const urls = await p.evaluate('window.__nwsCalls');
    assert.ok(urls.length > 0, 'picking a street match asks api.weather.gov, so the docs must say so');
    // The point sent is the street estimate rounded to four decimals (about 11 m).
    assert.ok(urls.some((u) => /[=/]38\.84,-76\.93$/.test(u)), JSON.stringify(urls));
    assert.ok(urls.every((u) => !/\d\.\d{5,}/.test(u)), JSON.stringify(urls));
  });
});

test('no match is said plainly, offers coordinates or a pin, and never calls the address a missing town', { skip }, async () => {
  await withFinder(async (p) => {
    await plan(p, { body: ok([]) });
    const seen = await p.evaluate(typeAndRead(EXAMPLE, true));
    assert.match(seen.nameNote, /no street match/i, seen.nameNote);
    assert.match(seen.nameNote, ALTERNATIVES);
    assert.match(seen.nameNote, /drag the map/i);
    assert.doesNotMatch(seen.nameNote + seen.note, MISSING_TOWN);
    assert.doesNotMatch(seen.nameNote, /unavailable/i, 'a real no-match was reported as an outage');
    assert.equal(seen.options.length, 0, 'a nearby place stands in for the address');
    assert.equal(seen.live, seen.nameNote);
  });
});

test('429, 502, 504, offline and a missing endpoint (404) each say lookup is unavailable, with alternatives', { skip }, async () => {
  await withFinder(async (p) => {
    const failures = [
      ['429', { status: 429, body: { error: 'rate-limited' } }],
      ['502', { status: 502, body: { error: 'upstream' } }],
      ['504', { status: 504, body: { error: 'timeout' } }],
      ['offline', { offline: true }],
      ['404 (not deployed)', { passthrough: true }],
    ];
    for (const [name, f] of failures) {
      await plan(p, f);
      const seen = await p.evaluate(typeAndRead(EXAMPLE, true));
      assert.match(seen.nameNote, /unavailable right now/i, `${name}: ${seen.nameNote}`);
      assert.match(seen.nameNote, ALTERNATIVES, name);
      assert.match(seen.nameNote, /drag the map/i, name);
      assert.doesNotMatch(seen.nameNote + seen.note, MISSING_TOWN, name);
      assert.doesNotMatch(seen.nameNote, /no street match/i, `${name}: an outage was reported as a no-match`);
      assert.equal(seen.options.length, 0, name);
      assert.equal(seen.live, seen.nameNote, name);
    }
  });
});

test('the newest search wins: the older request is cancelled and its late answer is dropped', { skip }, async () => {
  await withFinder(async (p) => {
    // The first answer is slow and, as a response already on the wire would, arrives
    // even though the page gave up on it. It must still change nothing.
    await plan(p, { body: ok([HIT_A]), hold: true, ignoreAbort: true }, { body: ok([HIT_HQ]) });
    await p.evaluate(`(async () => {
      const toggle = document.querySelector('.qc-finder-toggle');
      if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
      const box = document.getElementById('qc-place-search');
      box.value = ${JSON.stringify(EXAMPLE)};
      box.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('qc-name-search-btn').click();
      await qcWait('the first request', () => window.__geoCalls.length === 1);
    })()`);
    const seen = await p.evaluate(typeAndRead(CENSUS_HQ, true));
    assert.equal(seen.geoCalls, 2);
    assert.equal(await p.evaluate('window.__geoCalls[0].aborted'), true, 'the older request was not cancelled');
    assert.equal(seen.options.length, 1);
    assert.ok(seen.options[0].includes(HIT_HQ.label));
    await p.evaluate(`(async () => { window.__geoCalls[0].release(); await new Promise((r) => setTimeout(r, 300)); })()`);
    // Read only: typing again would itself clear the list, which is a different test.
    const after = await p.evaluate(`(() => ({
      nameNote: document.getElementById('qc-name-note').textContent.trim(),
      options: [...document.querySelectorAll('#qc-place-results [role="option"]')].map((o) => o.textContent.trim()),
    }))()`);
    assert.equal(after.options.length, 1, `the stale answer changed the list: ${JSON.stringify(after.options)}`);
    assert.ok(after.options[0].includes(HIT_HQ.label));
    assert.ok(!after.options[0].includes('EXAMPLE'));
    assert.match(after.nameNote, /^1 street match/);
  });
});

test('retyping while a lookup is in flight cancels it and clears its answer', { skip }, async () => {
  await withFinder(async (p) => {
    await plan(p, { body: ok([HIT_A]), hold: true, ignoreAbort: true });
    await p.evaluate(`(async () => {
      const toggle = document.querySelector('.qc-finder-toggle');
      if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
      const box = document.getElementById('qc-place-search');
      box.value = ${JSON.stringify(EXAMPLE)};
      box.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('qc-name-search-btn').click();
      await qcWait('the request', () => window.__geoCalls.length === 1);
      box.value = 'Amery';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      window.__geoCalls[0].release();
      await new Promise((r) => setTimeout(r, 300));
    })()`);
    const seen = await p.evaluate(typeAndRead('Amery', false));
    assert.equal(await p.evaluate('window.__geoCalls[0].aborted'), true);
    assert.ok(seen.options.length >= 1 && seen.options.every((o) => !/EXAMPLE/.test(o)), JSON.stringify(seen.options));
    assert.equal(seen.nameNote, '');
  });
});

test('the typed address never reaches the page address, title, storage or a shared link', { skip }, async () => {
  await withFinder(async (p) => {
    await plan(p, { body: ok([HIT_A]) });
    await p.evaluate(typeAndRead(EXAMPLE, true));
    await p.evaluate(`document.querySelector('#qc-place-results [role="option"]').click()`);
    await p.evaluate(`document.getElementById('qc-view-share').click()`);
    await p.evaluate(`qcWait('the link was shared', () => window.__shared.length || null)`);
    const out = await p.evaluate(`(() => {
      const dump = (s) => { try { return JSON.stringify(Object.assign({}, s)); } catch { return ''; } };
      return { href: location.href, title: document.title, shared: window.__shared.join(' '),
        storage: dump(localStorage) + dump(sessionStorage) };
    })()`);
    const leak = /example|anytown|100%20|100\+|ex%20/i;
    for (const [where, value] of Object.entries(out)) {
      assert.doesNotMatch(value, leak, `${where} carries the address: ${value}`);
    }
    assert.match(out.shared, /#map=/, 'the chosen point is shared as a view');
  });
});

// QQA-04c. GEOCODER.md quotes the Census Data API terms; whether they govern the geocoder is
// unverified, so the page shows the notice beside every answer that came from it.
const CENSUS_NOTICE = 'This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau.';

/** What a reader sees of the notice: its text, whether it is on screen, its computed type and
 *  its contrast against the finder box it sits in (the first opaque ancestor fill). */
const readCredit = `(() => {
  const e = document.getElementById('qc-census-credit');
  if (!e) return { present: false };
  const cs = getComputedStyle(e);
  const rgb = (c) => (c.match(/[\\d.]+/g) || []).map(Number);
  let bg = e, fill = null;
  while (bg && !fill) {
    const c = rgb(getComputedStyle(bg).backgroundColor);
    if (c.length >= 3 && (c.length < 4 || c[3] === 1)) fill = c.slice(0, 3);
    bg = bg.parentElement;
  }
  const r = e.getBoundingClientRect();
  // Where it sits, not just that it has a size: a line the stage clips (overflow: clip) or the
  // page cuts off still has a rect. Inside means inside the finder box and the map frame the
  // box is re-homed on, with a pixel of rounding. Not the viewport: the page scrolls, and on a
  // tall phone the frame itself runs past the fold (390x844: frame bottom 909, screen 844).
  const within = (a, b) => a.top >= b.top - 1 && a.bottom <= b.bottom + 1 && a.left >= b.left - 1 && a.right <= b.right + 1;
  const pane = e.closest('#qc-finder-box');
  const box = pane && pane.getBoundingClientRect(), host = pane && pane.parentNode.getBoundingClientRect();
  return {
    present: true, hidden: e.hidden, text: e.textContent.trim(), shown: !e.hidden && r.width > 0 && r.height > 0,
    inBox: !!box && within(r, box), inHost: !!host && within(r, host), boxInHost: !!box && within(box, host),
    rect: [r.top, r.bottom], boxRect: box && [box.top, box.bottom], hostBottom: host && host.bottom,
    fontSize: parseFloat(cs.fontSize), color: rgb(cs.color).slice(0, 3), fill,
    findNote: getComputedStyle(document.getElementById('qc-name-note')).fontSize,
    insideBox: !!e.closest('#qc-finder-box'),
  };
})()`;

test('the Census notice is shown, at row size and legible, beside street matches', { skip }, async () => {
  await withFinder(async (p) => {
    await plan(p, { body: ok([HIT_A, HIT_B]) });
    await p.evaluate(typeAndRead(EXAMPLE, true));
    const c = await p.evaluate(readCredit);
    assert.equal(c.present, true, 'no #qc-census-credit element in the finder');
    assert.equal(c.shown, true, JSON.stringify(c));
    assert.equal(c.text, CENSUS_NOTICE);
    assert.equal(c.insideBox, true);
    assert.ok(c.fontSize >= 12, `notice is ${c.fontSize}px`);
    assert.equal(`${c.fontSize}px`, c.findNote, 'the notice is not on the finder note type size');
    assert.ok(c.fill, 'no opaque fill found behind the notice');
    const ratio = contrastRatio(c.color, c.fill);
    assert.ok(ratio >= 4.5, `notice contrast ${ratio.toFixed(2)}:1`);
  });
});

test('the Census notice is shown with the geocoder no-match and unavailable sentences', { skip }, async () => {
  await withFinder(async (p) => {
    for (const [name, f, re] of [
      ['no match', { body: ok([]) }, /no street match/i],
      ['429', { status: 429, body: { error: 'rate-limited' } }, /unavailable right now/i],
      ['offline', { offline: true }, /unavailable right now/i],
    ]) {
      await plan(p, f);
      const seen = await p.evaluate(typeAndRead(EXAMPLE, true));
      assert.match(seen.nameNote, re, name);
      const c = await p.evaluate(readCredit);
      assert.equal(c.shown, true, `${name}: ${JSON.stringify(c)}`);
      assert.equal(c.text, CENSUS_NOTICE, name);
    }
  });
});

test('the Census notice is absent for town-only results, name search, coordinates and a retyped box', { skip }, async () => {
  await withFinder(async (p) => {
    const gone = async (what) => {
      const c = await p.evaluate(readCredit);
      assert.equal(c.present, true, 'the notice element is missing, so absence proves nothing');
      assert.equal(c.shown, false, `${what}: the notice is on screen`);
    };
    const town = await p.evaluate(typeAndRead('Amery', false));
    assert.ok(town.options.length >= 1, JSON.stringify(town));
    await gone('town rows');
    await p.evaluate(typeAndRead('Amery', true));
    await gone('a GNIS name search');
    await p.evaluate(typeAndRead('35.55, -82.55', false));
    await gone('coordinates');
    await plan(p, { body: ok([HIT_A]) });
    await p.evaluate(typeAndRead(EXAMPLE, true));
    assert.equal((await p.evaluate(readCredit)).shown, true);
    await p.evaluate(typeAndRead('Amery', false));
    await gone('after retyping a town over an address answer');
  });
});

// The open finder is no taller than the room the stage has left, and the stage clips
// (CLAUDE.md), so a notice that sits below a fixed-height answer, button and field can fall
// past the clip on a short stage: phone landscape lost it entirely, a small phone lost most
// of it. On every phone shape the box scrolls to it and it sits inside the box and the frame.
const PHONES = [{ width: 390, height: 844 }, { width: 360, height: 640 }, { width: 844, height: 390 }];
const SHOWN_CASES = [
  ['street matches', { body: ok([HIT_A, HIT_B]) }],
  ['no match', { body: ok([]) }],
  ['unavailable', { status: 502, body: { error: 'upstream' } }],
];
for (const vp of PHONES) {
  test(`at ${vp.width}x${vp.height} the Census notice lies inside the finder box and the map frame`, { skip }, async () => {
    await withFinder(async (p) => {
      for (const [name, f] of SHOWN_CASES) {
        await plan(p, f);
        await p.evaluate(typeAndRead(EXAMPLE, true));
        // A box capped to the room under its button scrolls what the cap leaves over; the
        // reader reaches the notice by scrolling the box to its end, and nothing else.
        await p.evaluate("(document.getElementById('qc-finder-box').scrollTop = 1e6, true)");
        const c = await p.evaluate(readCredit);
        const why = `${name}: ${JSON.stringify(c)}`;
        assert.equal(c.shown, true, why);
        assert.equal(c.boxInHost, true, `the box leaves the map frame; ${why}`);
        assert.equal(c.inBox, true, `the notice is clipped by the box; ${why}`);
        assert.equal(c.inHost, true, `the notice is clipped by the map frame; ${why}`);
      }
    }, vp);
  });
}
