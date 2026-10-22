// QQA-12b slice 1: the production smoke check, proved OFFLINE. The check functions the CLI runs against
// https://headlessmode.com run here against the built public/ with every external request stubbed (no
// network; CI runs this with it off). Each check passes on a good build and fails when its target is
// broken. Places are public landmarks: Bryson City NC, Cold Mountain NC, Sylva NC (shipped fixtures).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { WAIT_MS } from './helpers/waits.mjs';
import {
  parseArgs, exitCode, summaryLine, classifyZero, classifyAddressNote, checkMarker, runChecks, openSmokeBrowser,
  LIVE_ARGS, CHECK_NAMES, DEFAULT_BASE_URL,
} from './live-smoke-checks.mjs';
import { PLACE_FEATURES } from './fixtures/gnis-names-declutter.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'live-smoke.mjs');
const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const SHA = 'b7bd0b77eda7b11d69842706fe888c060bc4a0da';
const OTHER = '0123456789abcdef0123456789abcdef01234567';
const ok = (text, status = 200) => async () => ({ status, text });

test('parseArgs: defaults are production, no sha, no output directory', () => {
  const a = parseArgs([]);
  assert.equal(a.baseUrl, 'https://headlessmode.com');
  assert.equal(DEFAULT_BASE_URL, 'https://headlessmode.com');
  assert.equal(a.expectSha, null);
  assert.equal(a.outDir, null);
  assert.equal(a.timeoutMs, 45000);
  assert.deepEqual(a.only, CHECK_NAMES);
  assert.equal(a.help, false);
  assert.equal(a.tolerateServiceErrors, false);
});

test('parseArgs: every flag, space and equals forms, trailing slash dropped, sha lower-cased', () => {
  const a = parseArgs(['--base-url', 'http://127.0.0.1:8080/', `--expect-sha=${SHA.toUpperCase()}`, '--out', '/tmp/x',
    '--timeout-ms=20000', '--total-timeout-ms', '90000', '--only', 'marker,roads', '--tolerate-service-errors']);
  assert.equal(a.totalTimeoutMs, 90000);
  assert.equal(parseArgs([]).totalTimeoutMs, 600000);
  assert.equal(a.baseUrl, 'http://127.0.0.1:8080');
  assert.equal(a.expectSha, SHA);
  assert.equal(a.outDir, '/tmp/x');
  assert.equal(a.timeoutMs, 20000);
  assert.deepEqual(a.only, ['marker', 'roads']);
  assert.equal(a.tolerateServiceErrors, true);
  assert.equal(parseArgs(['--help']).help, true);
});

test('parseArgs: a bad flag, value or check name is refused, never guessed at', () => {
  for (const argv of [['--nope'], ['--base-url'], ['--base-url', 'ftp://x'], ['--base-url', 'not a url'],
    ['--expect-sha', 'abc123'], ['--expect-sha', 'z'.repeat(40)], ['--timeout-ms', '12'], ['--timeout-ms', 'soon'],
    ['--only', 'marker,bogus'], ['stray'], ['--total-timeout-ms', '5'], ['--total-timeout-ms', '99999999']]) {
    assert.throws(() => parseArgs(argv), /live-smoke|expected|unknown|must|needs/i, JSON.stringify(argv));
  }
});

test('exitCode: 0 only when every non-skipped check passed; an empty run fails closed', () => {
  const pass = { name: 'a', status: 'pass', reason: 'x' };
  const skipped = { name: 'b', status: 'skipped', reason: 'skipped: feature not deployed' };
  const fail = { name: 'c', status: 'fail', reason: 'y' };
  const svc = { name: 'd', status: 'fail', reason: 'z', cause: 'service' };
  assert.equal(exitCode([pass, skipped]), 0);
  assert.equal(exitCode([pass, fail]), 1);
  assert.equal(exitCode([pass, svc]), 1, 'an outside-service failure still fails by default');
  assert.equal(exitCode([pass, svc], { tolerateServiceErrors: true }), 0, 'unless the caller opted in');
  assert.equal(exitCode([pass, svc, fail], { tolerateServiceErrors: true }), 1, 'our own failures are never tolerated');
  assert.equal(exitCode([skipped]), 1, 'nothing passed: that is not a green run');
  assert.equal(exitCode([]), 1);
});

test('summaryLine: one line per check, status first, name, reason', () => {
  assert.equal(summaryLine({ name: 'marker', status: 'pass', reason: 'matches' }), 'PASS  marker: matches');
  assert.equal(summaryLine({ name: 'roads', status: 'fail', reason: 'no labels' }), 'FAIL  roads: no labels');
  assert.equal(summaryLine({ name: 'search', status: 'skipped', reason: 'skipped: feature not deployed' }), 'SKIP  search: skipped: feature not deployed');
  assert.ok(!summaryLine({ name: 'x', status: 'pass', reason: 'a\nb' }).includes('\n'));
  assert.equal(summaryLine({ name: 'search', status: 'pass', reason: 'landed', skips: [{ part: 'address', reason: 'feature not deployed' }] }),
    'PASS  search: landed [skipped: address: feature not deployed]');
});

test('classifyAddressNote: only the old missing-town wording is "feature not deployed"; any other note about an address passes', () => {
  for (const [note, outcome] of [
    ['No town matching "1234 Example Rd, Hamilton, MT 59840" is in this list.', 'skipped'], ['No town named "Example Rd" in MT is in this list.', 'skipped'],
    ['Address lookup is not available yet. Try a town name.', 'pass'], ['Street addresses cannot be searched here; type a town.', 'pass'],
    ['Nothing found.', 'fail'], ['', 'fail'], ['The town list failed to load. Try reloading the page.', 'fail'],
  ]) assert.equal(classifyAddressNote(note).outcome, outcome, note);
  assert.match(classifyAddressNote('Nothing found.').reason, /neither.*missing-town/);
});

test('runChecks: past the run deadline a check fails unrun, and one still running is cut off, not waited for', async () => {
  const late = await runChecks({ baseUrl: 'https://example.invalid', timeoutMs: 1000, page: null, deadlineAt: Date.now() - 1, fetchText: ok(`${SHA}\n`) }, ['marker', 'pages']);
  assert.deepEqual(late.map((r) => r.status), ['fail', 'fail']);
  for (const r of late) assert.match(r.reason, /run deadline/i);
  let timer;
  const guard = new Promise((_, no) => { timer = setTimeout(() => no(new Error('runChecks was still waiting 5 s after a 400 ms run deadline')), 5000); });
  try {
    const [r] = await Promise.race([runChecks({ baseUrl: 'https://example.invalid', timeoutMs: 60000, page: null, deadlineAt: Date.now() + 400, fetchText: () => new Promise(() => {}) }, ['marker']), guard]);
    assert.equal(r.status, 'fail');
    assert.match(r.reason, /run deadline.*marker|marker.*run deadline/i);
  } finally { clearTimeout(timer); }
  assert.equal(exitCode(late), 1);
});

test('classifyZero: a failed outside request is the service; an answered one is our code', () => {
  assert.equal(classifyZero([], 'transportation').cause, 'ours');
  assert.match(classifyZero([], 'transportation').detail, /no request/i);
  assert.equal(classifyZero([{ host: 'h', path: '/transportation/MapServer/32/query', status: 200 }], 'transportation').cause, 'ours');
  assert.match(classifyZero([{ host: 'h', path: '/transportation/MapServer/32/query', status: 200 }], 'transportation').detail, /answered/i);
  const bad = classifyZero([{ host: 'h', path: '/transportation/MapServer/32/query', status: 503 }], 'transportation');
  assert.equal(bad.cause, 'service');
  assert.match(bad.detail, /503/);
  const dead = classifyZero([{ host: 'h', path: '/transportation/MapServer/32/query', status: null, error: 'TypeError' }], 'transportation');
  assert.equal(dead.cause, 'service');
  assert.equal(classifyZero([{ host: 'h', path: '/other', status: 500 }], 'transportation').cause, 'ours', 'only the named service counts');
});

test('marker: equals --expect-sha passes; a different sha, a 404, a thrown fetch and junk all fail with a reason', async () => {
  const ctx = (fetchText, expectSha = SHA) => ({ baseUrl: 'https://example.invalid', expectSha, timeoutMs: 1000, fetchText });
  const good = await checkMarker(ctx(ok(`${SHA}\n`)));
  assert.equal(good.status, 'pass');
  assert.match(good.reason, new RegExp(SHA.slice(0, 12)));
  const stale = await checkMarker(ctx(ok(`${OTHER}\n`)));
  assert.equal(stale.status, 'fail');
  assert.match(stale.reason, /expected b7bd0b77eda7/);
  assert.match(stale.reason, /found 012345678/);
  const missing = await checkMarker(ctx(ok('not found', 404)));
  assert.equal(missing.status, 'fail');
  assert.match(missing.reason, /404/);
  const down = await checkMarker(ctx(async () => { throw new Error('connect ECONNREFUSED'); }));
  assert.equal(down.status, 'fail');
  assert.match(down.reason, /ECONNREFUSED/);
  const junk = await checkMarker(ctx(ok('<html>an error page</html>'), null));
  assert.equal(junk.status, 'fail', 'without --expect-sha the body still has to be a commit id');
  const noSha = await checkMarker(ctx(ok(SHA), null));
  assert.equal(noSha.status, 'pass');
  assert.match(noSha.reason, /no --expect-sha/);
});

const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60000 });

test('CLI: --help exits 0 with usage; a bad argument exits 2 and prints nothing to stdout', () => {
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--base-url/);
  assert.match(help.stdout, /--expect-sha/);
  const bad = cli(['--bogus']);
  assert.equal(bad.status, 2);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /--bogus/);
});

test('CLI: a failing check exits 1, prints one FAIL line, and --out gets the JSON report (loopback port 2 only)', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'qcm-smoke-'));
  const r = cli(['--base-url', 'http://127.0.0.1:2', '--only', 'marker', '--out', out, '--timeout-ms', '5000']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.ok(lines.some((l) => /^FAIL  marker: /.test(l)), r.stdout);
  assert.match(lines.at(-1), /1 failed/);
  const report = JSON.parse(readFileSync(path.join(out, 'live-smoke-report.json'), 'utf8'));
  assert.equal(report.baseUrl, 'http://127.0.0.1:2');
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].name, 'marker');
  assert.equal(report.results[0].status, 'fail');
});

test('CLI: a missing Chromium fails every browser check closed (CHROME_PATH unusable, no candidate on PATH needed)', () => {
  const r = spawnSync(process.execPath, [CLI, '--base-url', 'http://127.0.0.1:2', '--only', 'pages,roads', '--timeout-ms', '5000'], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, QCM_SMOKE_NO_BROWSER: '1' },
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL  pages: .*no browser/i);
  assert.match(r.stdout, /FAIL  roads: .*no browser/i);
});

const FIX_ROADS = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'road-names-sylva.json'), 'utf8'));
const FIX_SEARCH = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'geonames-search-coldmountain.min.json'), 'utf8'));

/** Every https request is answered here, so nothing leaves the box. The scenario flags
 *  (window.__scenario) are read when a request is made, so one browser serves every case. */
const BASE_STUB = `(() => {
  const roads = ${JSON.stringify(FIX_ROADS.layers)};
  const search = ${JSON.stringify(FIX_SEARCH)};
  const names = { 3: ${JSON.stringify(PLACE_FEATURES)} };
  const real = window.fetch.bind(window);
  const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
  window.fetch = function(input, init) {
    const url = String(input && input.url ? input.url : input);
    if (!/^https?:/.test(url) || url.startsWith(location.origin)) return real(input, init);
    const u = new URL(url);
    const t = u.pathname.match(/transportation\\/MapServer\\/(\\d+)\\/query/);
    if (t) {
      const mode = (window.__scenario || {}).roads || 'ok';
      if (mode === 'error') return json({ error: { code: 503, message: 'stubbed outage' } }, 503);
      if (mode === 'empty') return json({ features: [] });
      if (mode === 'arcgis-error') return json({ error: { code: 500, message: 'stubbed ArcGIS error body' } });
      return json({ features: roads[t[1]].features });
    }
    const g = u.pathname.match(/geonames\\/MapServer\\/(\\d+)\\/query/);
    const count = u.searchParams.get('returnCountOnly') === 'true';
    if (g && /UPPER\\(gaz_name\\)/.test(u.searchParams.get('where') || '')) return json(count ? { count: search.features.length } : search);
    if (g) { const rows = names[g[1]] || []; return json(count ? { count: rows.length } : { features: rows }); }
    return json(count ? { count: 0 } : { features: [] });
  };
})()`;

let shared = null;
let server = null;
const origin = async () => { server ??= await startSiteServer(); return server.origin; };
const browser = async () => { shared ??= await openSmokeBrowser({ chromium: CHROMIUM, live: false, stubSource: BASE_STUB, timeoutMs: 20000 }); return shared; };
after(async () => { try { shared?.close(); } finally { await server?.close(); } });

/** Adds a script that runs on every document loaded while `fn` runs, then removes it. */
async function scenario(page, source, fn) {
  const { identifier } = await page.send('Page.addScriptToEvaluateOnNewDocument', { source });
  try { return await fn(); } finally { await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }); }
}
const run = async (names, { source = '(() => 0)()', timeoutMs = WAIT_MS, base = null, expectSha = SHA } = {}) => {
  const b = await browser();
  const baseUrl = base ?? await origin();
  return scenario(b.page, source, () => runChecks({ baseUrl, expectSha, timeoutMs, page: b.page, fetchText: ok(`${SHA}\n`) }, names));
};
const one = (results, name) => results.find((r) => r.name === name);

// PR CI under runner load (box load 59 on 12 cores, 10-20) took longer than 20 s to draw the dashboard,
// so the good-build run read "the map never rendered" on a correct build. A wait meant to PASS uses the
// shared browser-test ceiling; only a case that expects a timeout passes its own short one.
test('a check run waits as long as the shared browser-test ceiling unless the case asks for less', () => {
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const def = src.match(/const run = async \(names, \{[^}]*timeoutMs = ([A-Z_0-9]+)/);
  assert.ok(def, 'run() names a default timeoutMs');
  assert.equal(def[1], 'WAIT_MS', `run() defaults to ${def[1]}, not the shared WAIT_MS (${WAIT_MS} ms)`);
});

test('LIVE_ARGS lets a page reach a non-127.0.0.1 host; the default browser cannot (the override really overrides)', { skip }, async () => {
  const site = await startSiteServer();
  const port = new URL(site.origin).port;
  const target = `http://smoke-reach.localhost:${port}/quiet-corners/`;
  try {
    const dead = await launch(CHROMIUM, 'about:blank', { timeoutMs: 30000 });
    try { await assert.rejects(() => dead.navigate(target), /ERR_NAME_NOT_RESOLVED|ERR_/, 'offline browsers refuse the host'); } finally { dead.close(); }
    const live = await launch(CHROMIUM, 'about:blank', { timeoutMs: 30000, args: LIVE_ARGS });
    try {
      await live.navigate(target);
      assert.equal(await live.evaluate('location.hostname'), 'smoke-reach.localhost');
    } finally { live.close(); }
  } finally { await site.close(); }
});

test('good build: all seven checks pass offline, and the optional cameras page is reported as not deployed', { skip }, async () => {
  const results = await run(CHECK_NAMES);
  assert.deepEqual(results.map((r) => r.name), CHECK_NAMES);
  for (const r of results) assert.equal(r.status, 'pass', `${r.name}: ${r.reason}`);
  assert.match(one(results, 'pages').reason, /cameras.*not deployed/i);
  assert.match(one(results, 'search').reason, /one marker/i);
  // The build answers a street address honestly (QQA-03c), so nothing is skipped.
  assert.match(one(results, 'search').reason, /honest message about addresses/);
  assert.equal(one(results, 'search').skips, undefined);
  assert.match(one(results, 'roads').reason, /road labels/i);
  assert.equal(exitCode(results), 0);
});

test('pages: a page that answers 404 fails with its path and status', { skip }, async () => {
  const bad = await startSiteServer({ fail: /^\/quiet-corners\/maps\// });
  try {
    const r = one(await run(['pages'], { base: bad.origin }), 'pages');
    assert.equal(r.status, 'fail');
    assert.match(r.reason, /\/quiet-corners\/maps\/.*404/);
  } finally { await bad.close(); }
});

test('csp: a request the page policy blocks fails the check and names the directive', { skip }, async () => {
  const source = `document.addEventListener('DOMContentLoaded', () => { new Image().src = 'https://csp-violation.example/p.png'; })`;
  const r = one(await run(['csp'], { source }), 'csp');
  assert.equal(r.status, 'fail');
  assert.match(r.reason, /img-src/);
  assert.match(r.reason, /csp-violation\.example/);
});

test('csp: the CDN analytics beacon the policy blocks is reported but not fatal', { skip }, async () => {
  const source = `document.addEventListener('DOMContentLoaded', () => {
    const s = document.createElement('script'); s.src = 'https://static.cloudflareinsights.com/beacon.min.js/vtest'; document.head.appendChild(s);
  })`;
  const r = one(await run(['csp'], { source }), 'csp');
  assert.equal(r.status, 'pass', r.reason);
  assert.match(r.reason, /beacon/);
});

test('csp: a failed outside tile is reported but not fatal', { skip }, async () => {
  const r = one(await run(['csp']), 'csp');
  assert.equal(r.status, 'pass', r.reason);
  assert.match(r.reason, /outside image|third-party/i);
});

test('search: a second marker for the chosen name (the #707 regression) fails the check', { skip }, async () => {
  const source = `document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('.leaflet-marker-pane [title]')) {
        if (el.dataset.dup || el.parentNode.querySelector('[data-dup][title="' + el.title + '"]')) continue;
        const copy = el.cloneNode(true); copy.dataset.dup = '1'; el.parentNode.appendChild(copy);
      }
    }).observe(document.body, { childList: true, subtree: true });
  })`;
  const r = one(await run(['search'], { source }), 'search');
  assert.equal(r.status, 'fail');
  assert.match(r.reason, /2 markers/);
});

test('layers: a layer that stays painted after it is switched off fails as a stale layer', { skip }, async () => {
  const source = `document.addEventListener('change', (e) => { if (e.target && e.target.id === 'qcm-layer-names') e.stopImmediatePropagation(); }, true);
    document.addEventListener('click', (e) => { if (e.target && e.target.id === 'qcm-check') e.stopImmediatePropagation(); }, true);`;
  const r = one(await run(['layers'], { source, timeoutMs: 8000 }), 'layers');
  assert.equal(r.status, 'fail');
  assert.match(r.reason, /still|stale|never/i);
});

test('roads: an outage or an ArcGIS error body behind HTTP 200 is the service; an empty answer is our code drawing nothing', { skip }, async () => {
  const down = one(await run(['roads'], { source: `window.__scenario = { roads: 'error' }`, timeoutMs: 8000 }), 'roads');
  assert.equal(down.status, 'fail');
  assert.equal(down.cause, 'service');
  assert.match(down.reason, /service error/i);
  assert.match(down.reason, /503/);
  const empty = one(await run(['roads'], { source: `window.__scenario = { roads: 'empty' }`, timeoutMs: 8000 }), 'roads');
  assert.equal(empty.status, 'fail');
  assert.equal(empty.cause, 'ours');
  assert.match(empty.reason, /drew no road labels/i);
  const body = one(await run(['roads'], { source: `window.__scenario = { roads: 'arcgis-error' }`, timeoutMs: 8000 }), 'roads');
  assert.equal(body.status, 'fail', 'an ArcGIS error body behind HTTP 200 is a failure');
  assert.equal(body.cause, 'service');
  assert.match(body.reason, /service error/i);
  assert.doesNotMatch(empty.reason, /service error/i);
});

test('inspection: a name label whose card never opens fails the check', { skip }, async () => {
  const source = `document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver(() => document.querySelectorAll('.leaflet-popup').forEach((p) => p.remove())).observe(document.body, { childList: true, subtree: true });
  })`;
  const r = one(await run(['inspection'], { source, timeoutMs: 8000 }), 'inspection');
  assert.equal(r.status, 'fail');
  assert.match(r.reason, /card/i);
});

/** Rewrites the finder's note to `text` whenever the box holds the synthetic address. */
const rewriteAddressNote = (T) => `document.addEventListener('DOMContentLoaded', () => new MutationObserver(() => {
  const note = document.getElementById('qc-finder-note'), box = document.getElementById('qc-place-search');
  if (note && box && /1234 Example/.test(box.value) && note.textContent !== ${JSON.stringify(T)}) note.textContent = ${JSON.stringify(T)};
}).observe(document.documentElement, { childList: true, subtree: true, characterData: true }))`;

test('search: an honest address message (any wording about the address) passes and is not a skip', { skip }, async () => {
  const r = one(await run(['search'], { source: rewriteAddressNote('Street addresses cannot be searched yet. Try a town name.') }), 'search');
  assert.equal(r.status, 'pass', r.reason);
  assert.match(r.reason, /honest/i);
  assert.equal(r.skips, undefined, 'a deployed feature is not reported as skipped');
});

test('search: an address answered with neither the old wording nor anything about an address fails', { skip }, async () => {
  const r = one(await run(['search'], { source: rewriteAddressNote('Nothing found.') }), 'search');
  assert.equal(r.status, 'fail');
  assert.match(r.reason, /Nothing found.*neither|neither.*Nothing found/);
});

test('search: the old missing-town wording for an address passes with the address part in skips', { skip }, async () => {
  // Put back the pre-QQA-03c wording, which called an address a missing town.
  const source = `document.addEventListener('DOMContentLoaded', () => new MutationObserver(() => { const n = document.getElementById('qc-finder-note');
    if (n && /address/i.test(n.textContent)) n.textContent = 'No town matching that name'; }).observe(document.documentElement, { childList: true, subtree: true, characterData: true }))`;
  const r = one(await run(['search'], { source }), 'search');
  assert.equal(r.status, 'pass', r.reason);
  assert.deepEqual(r.skips.map((k) => k.part), ['address']);
});

test('search: a decoy row of another kind ahead of the clicked one does not make a correct marker fail', { skip }, async () => {
  // The check must judge the row it clicked (the first with a kind badge), not the first row that holds the query.
  const source = `document.addEventListener('DOMContentLoaded', () => new MutationObserver(() => {
    const list = document.getElementById('qc-place-results');
    if (!list || list.querySelector('[data-decoy]') || !list.querySelector('.qc-finder-kind-badge')) return;
    const li = document.createElement('li'); li.setAttribute('role', 'option'); li.dataset.decoy = '1';
    li.textContent = 'Cold Mountain, NC'; list.insertBefore(li, list.firstChild);
  }).observe(document.documentElement, { childList: true, subtree: true }))`;
  const r = one(await run(['search'], { source }), 'search');
  assert.equal(r.status, 'pass', r.reason);
});

const withSite = async (files, fn) => { const site = await startSiteServer({ files }); try { return await fn(site.origin); } finally { await site.close(); } };
const page = (main) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Stand-in</title></head><body>${main}</body></html>`;
const FILLER = 'Road cameras shown on the map, one entry per camera, with the operator named on each. '.repeat(3);
const CAMERAS = '/quiet-corners/cameras/';

test('pages: a served cameras page that renders a heading and a list passes and its path is in the reason', { skip }, () =>
  withSite({ [CAMERAS]: page(`<main id="main-content"><h1>Road cameras</h1><ul><li>${FILLER}</li></ul></main>`) }, async (base) => {
    const r = one(await run(['pages'], { base }), 'pages');
    assert.equal(r.status, 'pass', r.reason);
    assert.match(r.reason, /\/quiet-corners\/cameras\/ 200/);
    assert.doesNotMatch(r.reason, /not deployed/);
  }));

for (const [what, path, files, want] of [
  ['a cameras page with an empty main element', CAMERAS, page('<main id="main-content"></main>'), /cameras\/ answered 200 but .* never rendered/],
  ['a cameras page with a heading but no list or map', CAMERAS, page(`<main id="main-content"><h1>Road cameras</h1><p>${FILLER}</p></main>`), /cameras\/ answered 200 but .* never rendered/],
  ['a cameras page that answers 500', CAMERAS, { status: 500, body: 'oops' }, /cameras\/ answered 500/],
  ['a Field Maps page that is only a heading and a sentence', '/quiet-corners/maps/', page(`<main id="main-content"><h1 class="sheet-name">Field Maps</h1><p>${FILLER}</p></main>`), /maps\/ answered 200 but .* never rendered/],
]) {
  test(`pages: ${what} fails`, { skip }, () => withSite({ [path]: files }, async (base) => {
    const r = one(await run(['pages'], { base, timeoutMs: 4000 }), 'pages');
    assert.equal(r.status, 'fail');
    assert.match(r.reason, want);
  }));
}

const probeScript = `document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('script'); s.src = '/smoke-probe.js'; document.head.appendChild(s); })`;
for (const [what, body, want] of [
  ['a console.error raised by the site\'s own script', "console.error('smoke probe first-party failure');", /first-party console error.*smoke probe first-party failure/],
  ['an uncaught error on the page', "setTimeout(() => { throw new Error('smoke probe uncaught'); }, 0);", /uncaught: .*smoke probe uncaught/],
  ['an own-origin file that answers 404', "new Image().src = '/img/smoke-probe-missing.png';", /own-origin requests failed: .*smoke-probe-missing\.png 404/],
]) {
  test(`csp: ${what} fails the check`, { skip }, () => withSite({ '/smoke-probe.js': { type: 'text/javascript', body } }, async (base) => {
    const r = one(await run(['csp'], { base, source: probeScript }), 'csp');
    assert.equal(r.status, 'fail');
    assert.match(r.reason, want);
  }));
}

/** After Named places goes off and on, adds `copies` extra markers per label as the page adds each one
 *  (no gap for the check to read); a copy reports its original's box, i.e. the same spot. */
const repaint = (copies, vary) => `(() => {
  let off = false, again = false;
  document.addEventListener('change', (e) => { if (e.target && e.target.id === 'qcm-layer-names') { if (!e.target.checked) off = true; else if (off) again = true; } }, true);
  const add = Node.prototype.appendChild;
  Node.prototype.appendChild = function (el) {
    const r = add.call(this, el);
    if (again && el.classList && el.classList.contains('qcm-name-marker') && !el.dataset.dup) {
      for (let i = 0; i < ${copies}; i++) {
        const c = el.cloneNode(true); c.dataset.dup = '1'; c.getBoundingClientRect = () => el.getBoundingClientRect();
        if (${vary}) c.setAttribute('aria-label', el.getAttribute('aria-label') + ' copy ' + (window.__dupN = (window.__dupN || 0) + 1));
        add.call(this, c);
      }
    }
    return r;
  };
})()`;

for (const [what, source, want] of [
  ['the same label painted twice in the same spot', repaint(1, false), /painted twice in the same spot/],
  ['far more labels than before', repaint(3, true), /labels are painted where \d+ were before/],
]) {
  test(`layers: ${what} after off and on fails as a stale layer`, { skip }, async () => {
    const r = one(await run(['layers'], { source, timeoutMs: 15000 }), 'layers');
    assert.equal(r.status, 'fail');
    assert.match(r.reason, want);
  });
}


test('marker mismatch inside a full run fails that check only', { skip }, async () => {
  const results = await run(['marker'], { expectSha: OTHER });
  assert.equal(one(results, 'marker').status, 'fail');
  assert.equal(exitCode(results), 1);
});
