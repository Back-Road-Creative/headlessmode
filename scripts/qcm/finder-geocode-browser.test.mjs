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
//     shared link.
//
// Fixtures are synthetic: an invented road and the Census Bureau's public headquarters
// street address. The owner's real address never appears in the repo (QQA-00).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard } from './helpers/waits.mjs';

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

async function withFinder(fn) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, 'about:blank', { viewport: { width: 1280, height: 900 }, args: ['--hide-scrollbars'] });
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
