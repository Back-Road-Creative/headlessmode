// The Quiet Corners production smoke check as importable pieces: argument parsing, the exit rule and
// seven named checks. live-smoke.mjs runs them against a deployed site; live-smoke.test.mjs runs the
// SAME functions against the locally built site with every outside request stubbed.
// A check returns { name, status: 'pass'|'fail'|'skipped', reason, cause?, skips? }. `cause` on a
// failure says WHO is at fault: 'service' (an outside service errored or never answered) or 'ours'
// (it answered and our page drew nothing). `skips` ([{ part, reason }]) marks a passing check that
// did not run one part because the feature it proves is not deployed; the report carries it.
import { findChromium, launch, PAGE_RECORD } from './helpers/browser.mjs';
import { readyDashboard, chooseExampleArea, waitInPage } from './helpers/waits.mjs';
import { trustedClick } from './helpers/trusted-click.mjs';

export const DEFAULT_BASE_URL = 'https://headlessmode.com';
export const CHECK_NAMES = Object.freeze(['marker', 'pages', 'csp', 'search', 'layers', 'roads', 'inspection']);
const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_TOTAL_TIMEOUT_MS = 600000;

// Public landmarks only: Bryson City NC (a town in candidates.json), Cold Mountain NC (a summit
// in the USGS names service), Sylva NC (the road fixtures' town). Nothing near anyone's home.
const TOWN = { query: 'Bryson City', lat: 35.4266, lon: -83.4473 };
const NAME_QUERY = 'Cold Mountain';
const ADDRESS_QUERY = '1234 Example Rd, Hamilton, MT 59840';   // synthetic
const ROAD_VIEW = [35.375, -83.218, 13];                         // Sylva NC, zoom 13
const SHA_RE = /^[0-9a-f]{40}$/;

export const USAGE = `Usage: node scripts/qcm/live-smoke.mjs [options]

Read-only smoke check of a deployed Quiet Corners site, driven in headless Chromium.

  --base-url <url>          site to check (default ${DEFAULT_BASE_URL})
  --expect-sha <sha>        the 40-character commit id deploy-marker.txt must equal
  --out <dir>               write live-smoke-report.json and failure screenshots here
  --timeout-ms <n>          per-wait ceiling in milliseconds (default ${DEFAULT_TIMEOUT_MS}, 1000 to 300000)
  --total-timeout-ms <n>    deadline for the whole run in milliseconds (default ${DEFAULT_TOTAL_TIMEOUT_MS}, 10000 to 3600000);
                            a check still running at the deadline fails and the rest fail unrun
  --only <a,b>              run only these checks (${CHECK_NAMES.join(', ')})
  --tolerate-service-errors exit 0 when the only failures are outside-service errors
  --help                    this text

Exit 0: every non-skipped check passed. 1: a check failed (or nothing passed). 2: bad arguments.`;

export function parseArgs(argv) {
  const a = { baseUrl: DEFAULT_BASE_URL, expectSha: null, outDir: null, timeoutMs: DEFAULT_TIMEOUT_MS, totalTimeoutMs: DEFAULT_TOTAL_TIMEOUT_MS,
    only: [...CHECK_NAMES], help: false, tolerateServiceErrors: false };
  const fail = (m) => { throw new Error(`live-smoke: ${m}`); };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) fail(`unexpected argument "${raw}"`);
    const eq = raw.indexOf('=');
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const bare = flag === '--help' || flag === '--tolerate-service-errors';
    if (bare && eq > 0) fail(`${flag} takes no value`);
    if (flag === '--help') { a.help = true; continue; }
    if (flag === '--tolerate-service-errors') { a.tolerateServiceErrors = true; continue; }
    if (!['--base-url', '--expect-sha', '--out', '--timeout-ms', '--total-timeout-ms', '--only'].includes(flag)) fail(`unknown option ${flag}`);
    const value = eq > 0 ? raw.slice(eq + 1) : argv[++i];
    if (value === undefined || value === '') fail(`${flag} needs a value`);
    if (flag === '--base-url') {
      let u;
      try { u = new URL(value); } catch { fail(`--base-url must be an http(s) URL, got "${value}"`); }
      if (!/^https?:$/.test(u.protocol)) fail(`--base-url must be an http(s) URL, got "${value}"`);
      a.baseUrl = value.replace(/\/+$/, '');
    } else if (flag === '--expect-sha') {
      if (!SHA_RE.test(value.toLowerCase())) fail(`--expect-sha must be a 40-character commit id, got "${value}"`);
      a.expectSha = value.toLowerCase();
    } else if (flag === '--out') a.outDir = value;
    else if (flag === '--timeout-ms' || flag === '--total-timeout-ms') {
      const [lo, hi] = flag === '--timeout-ms' ? [1000, 300000] : [10000, 3600000], n = Number(value);
      if (!Number.isInteger(n) || n < lo || n > hi) fail(`${flag} must be a whole number from ${lo} to ${hi}, got "${value}"`);
      a[flag === '--timeout-ms' ? 'timeoutMs' : 'totalTimeoutMs'] = n;
    } else {
      const names = value.split(',').map((s) => s.trim()).filter(Boolean);
      const bad = names.filter((n) => !CHECK_NAMES.includes(n));
      if (bad.length || !names.length) fail(`--only must list checks from ${CHECK_NAMES.join(', ')}; got "${value}"`);
      a.only = CHECK_NAMES.filter((n) => names.includes(n));
    }
  }
  return a;
}

/** 0 only when at least one check passed and nothing failed. An outside-service failure is
 *  forgiven only when the caller asked; our own failures never are. A run with no results,
 *  or only skips, is not green. */
export function exitCode(results, { tolerateServiceErrors = false } = {}) {
  const failed = results.filter((r) => r.status === 'fail' && !(tolerateServiceErrors && r.cause === 'service'));
  if (failed.length) return 1;
  return results.some((r) => r.status === 'pass') ? 0 : 1;
}

const LABEL = { pass: 'PASS', fail: 'FAIL', skipped: 'SKIP' };
export const summaryLine = (r) => `${LABEL[r.status]}  ${r.name}: ${String(r.reason).replace(/\s+/g, ' ').trim()}`
  + (r.skips?.length ? ` [${r.skips.map((k) => `skipped: ${k.part}: ${k.reason}`).join('; ')}]` : '');

const pass = (name, reason) => ({ name, status: 'pass', reason });
const fail = (name, reason, cause) => ({ name, status: 'fail', reason, ...(cause ? { cause } : {}) });

/** Who is at fault when a thing the page should have drawn from `service` is missing. `requests`
 *  is the page's record of outside requests ({host, path, status, error}). */
export function classifyZero(requests, service) {
  const mine = requests.filter((r) => r.path.includes(service));
  const broken = mine.filter((r) => r.status === null || r.status >= 400);
  if (broken.length) {
    const r = broken[0];
    return { cause: 'service', detail: `${r.host} ${r.path.split('/').slice(-3).join('/')} ${r.status ? `answered ${r.status}` : `got no answer (${r.error || 'no response'})`}` };
  }
  if (mine.length) return { cause: 'ours', detail: `the service answered ${mine.length} request${mine.length === 1 ? '' : 's'} (${mine[0].status}) and the page still drew nothing` };
  return { cause: 'ours', detail: 'the page made no request to the service' };
}

/** Installed on every document before its own scripts: CSP violations, console.error calls (and whether
 *  our own origin raised them), outside requests with status, and images that failed (base tiles). */
export const RECORDER_SRC = `(() => {
  if (window.__smoke) return;
  const s = window.__smoke = { csp: [], consoleErrors: [], requests: [], imgErrors: [] };
  document.addEventListener('securitypolicyviolation', (e) => s.csp.push(e.violatedDirective + ' blocked ' + e.blockedURI), true);
  const ce = console.error;
  console.error = function () {
    try {
      const lines = String(new Error().stack || '').split('\\n');
      s.consoleErrors.push({ msg: Array.from(arguments).map(String).join(' ').slice(0, 200), first: (lines[2] || '').includes(location.origin) });
    } catch (e) {}
    return ce.apply(this, arguments);
  };
  const f = window.fetch;
  if (f) window.fetch = function (input) {
    const url = String(input && input.url ? input.url : input);
    if (!/^https?:/.test(url) || url.startsWith(location.origin)) return f.apply(this, arguments);
    const u = new URL(url), rec = { host: u.host, path: u.pathname, status: null };
    s.requests.push(rec);
    return f.apply(this, arguments).then((r) => { rec.status = r.status; return r; }, (e) => { rec.error = String((e && e.name) || e); throw e; });
  };
  addEventListener('error', (e) => { if (e.target && e.target.tagName === 'IMG') { try { s.imgErrors.push(new URL(e.target.src, location.href).host); } catch (x) {} } }, true);
})()`;

/** Makes a browser reach the real internet: launch() passes OFFLINE_ARGS first and Chromium keeps the
 *  LAST value of a repeated switch, so this replaces its "everything unresolvable" rule. */
export const LIVE_ARGS = Object.freeze(['--host-resolver-rules=MAP qcm-smoke-no-such-host.invalid 127.0.0.1']);

/** Starts the browser a run drives. `stubSource` (offline tests) is installed BEFORE the
 *  recorder so the recorder wraps the stub. Throws when there is no Chromium: browser checks
 *  then fail closed rather than pass without having looked. */
export async function openSmokeBrowser({ chromium = findChromium(), live = true, stubSource = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!chromium) throw new Error('no browser: no Chromium found (set CHROME_PATH to a Chromium or Chrome binary)');
  const page = await launch(chromium, 'about:blank', {
    timeoutMs: Math.max(timeoutMs, 30000), viewport: { width: 1440, height: 1000 },
    args: [...(live ? LIVE_ARGS : []), '--hide-scrollbars'],
  });
  try {
    if (stubSource) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: stubSource });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER_SRC });
  } catch (err) { page.close(); throw err; }
  return { page, close: () => page.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const smoke = (page) => page.evaluate('JSON.parse(JSON.stringify(window.__smoke || { csp: [], consoleErrors: [], requests: [], imgErrors: [] }))');

async function openDashboard(ctx, { data = true } = {}) {
  await ctx.page.navigate(`${ctx.baseUrl}/quiet-corners/`);
  await readyDashboard(ctx.page, { data, ms: ctx.timeoutMs });
}

async function navStatus(page) {
  return page.evaluate(`(() => { const n = performance.getEntriesByType('navigation')[0]; return n && typeof n.responseStatus === 'number' ? n.responseStatus : null; })()`);
}

// A wait never outlasts the run deadline (--total-timeout-ms), whatever --timeout-ms says.
const waitFor = (ctx, what, expr) => waitInPage(ctx.page, what, expr,
  ctx.deadlineAt ? Math.max(1, Math.min(ctx.timeoutMs, ctx.deadlineAt - Date.now())) : ctx.timeoutMs, null);
const count = (page, sel) => page.evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);

/** Waits for a condition; resolves true/false instead of throwing, so a check can classify a timeout. */
async function tryWait(ctx, what, expr) {
  try { await waitFor(ctx, what, expr); return true; } catch { return false; }
}

const TRANSIENT = new Set(['EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_SOCKET']);

async function defaultFetchText(url, timeoutMs) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store', redirect: 'follow' });
      return { status: res.status, text: await res.text() };
    } catch (err) {
      if (attempt >= 1 || !TRANSIENT.has(err.cause?.code)) throw err;
      await sleep(1500);
    }
  }
}

export async function checkMarker(ctx) {
  const name = 'marker';
  const get = ctx.fetchText ?? defaultFetchText;
  let res;
  try { res = await get(`${ctx.baseUrl}/deploy-marker.txt`, ctx.timeoutMs); } catch (err) {
    return fail(name, `could not read /deploy-marker.txt: ${err.cause?.code ?? err.message}`);
  }
  if (res.status !== 200) return fail(name, `/deploy-marker.txt answered ${res.status}`);
  const found = String(res.text).trim().toLowerCase();
  if (!SHA_RE.test(found)) return fail(name, `/deploy-marker.txt is not a commit id: "${found.slice(0, 60)}"`);
  if (!ctx.expectSha) return pass(name, `marker is ${found.slice(0, 12)} (no --expect-sha given, so not compared)`);
  if (found !== ctx.expectSha) return fail(name, `expected ${ctx.expectSha.slice(0, 12)} but found ${found.slice(0, 12)}: the deploy is not the commit being checked`);
  return pass(name, `marker equals the expected commit ${found.slice(0, 12)}`);
}

const READY_MAPS = `(() => {
  const main = document.querySelector('main#main-content');
  const head = main && main.querySelector('h1.sheet-name');
  const docs = main && main.querySelector('.qcm-docs');
  return Boolean(head && head.textContent.trim() && docs && docs.querySelectorAll('h2').length >= 2
    && docs.querySelectorAll('li').length >= 1 && docs.textContent.trim().length > 200);
})()`;
const READY_CAMERAS = `(() => {
  const main = document.querySelector('main#main-content');
  if (!main || !main.querySelector('h1')) return false;
  const body = main.querySelector('.leaflet-container') || main.querySelector('ul li, ol li, table tr, [role="list"] > *');
  return Boolean(body) && main.textContent.trim().length > 100;
})()`;

const PAGES = [
  { path: '/quiet-corners/', what: 'the map', ready: "Boolean(window.qcMap) && Boolean(document.querySelector('#qc-map.leaflet-container'))" },
  // /maps/ is documentation: its main element is the sheet heading plus a docs block with sections and items.
  { path: '/quiet-corners/maps/', what: 'the Field Maps guide', ready: READY_MAPS },
  // A 404 is "feature not deployed"; once served it must render. No such page exists yet: READY_CAMERAS is
  // the contract it must meet, proved against a stand-in page. Change it WITH that page.
  { path: '/quiet-corners/cameras/', what: 'the cameras page (heading and map or list)', optional: true, ready: READY_CAMERAS },
];

export async function checkPages(ctx) {
  const name = 'pages';
  const notes = [];
  for (const p of PAGES) {
    await ctx.page.navigate(`${ctx.baseUrl}${p.path}`);
    const status = await navStatus(ctx.page);
    if (status === 404 && p.optional) { notes.push(`${p.path} 404, feature not deployed`); continue; }
    if (status !== 200) return fail(name, `${p.path} answered ${status ?? 'no status'}, expected 200`);
    if (!await tryWait(ctx, `${p.what} to render at ${p.path}`, p.ready)) return fail(name, `${p.path} answered 200 but ${p.what} never rendered`);
    notes.push(`${p.path} 200`);
  }
  return pass(name, notes.join('; '));
}

// Fatal: a CSP violation, a first-party console.error, an uncaught error, an own-origin request that
// failed. Reported, not fatal: failed outside images (tiles) and third-party console errors.

const EDGE_CSP_RE = /^script-src(-elem)? blocked https:\/\/static\.cloudflareinsights\.com\//;

export async function checkCsp(ctx) {
  const name = 'csp';
  await openDashboard(ctx);
  await sleep(1000);
  const s = await smoke(ctx.page);
  const own = await ctx.page.evaluate(`performance.getEntriesByType('resource').filter((e) => e.name.startsWith(location.origin + '/') && (e.responseStatus === 0 || e.responseStatus >= 400)).map((e) => new URL(e.name).pathname + ' ' + e.responseStatus)`);
  const rec = await ctx.page.evaluate(`(() => { const r = window[${JSON.stringify(PAGE_RECORD)}]; return r ? r.errors : []; })()`);
  const fatal = [];
  // Cloudflare injects its analytics beacon at the edge and the page policy blocks it. That is
  // the policy doing its job on a script we do not ship, so it is listed, not fatal.
  const [edge, violations] = [s.csp.filter((v) => EDGE_CSP_RE.test(v)), s.csp.filter((v) => !EDGE_CSP_RE.test(v))];
  if (violations.length) fatal.push(`${violations.length} CSP violation${violations.length === 1 ? '' : 's'} (${[...new Set(violations)].slice(0, 3).join('; ')})`);
  const firstParty = s.consoleErrors.filter((e) => e.first);
  if (firstParty.length) fatal.push(`${firstParty.length} first-party console error${firstParty.length === 1 ? '' : 's'} (${firstParty[0].msg})`);
  if (rec.length) fatal.push(`uncaught: ${rec.slice(0, 2).join(' | ')}`);
  if (own.length) fatal.push(`own-origin requests failed: ${own.slice(0, 3).join(', ')}`);
  if (fatal.length) return fail(name, fatal.join('; '));
  const [tiles, outside] = [s.imgErrors.length, s.consoleErrors.length];
  const notes = [];
  if (edge.length) notes.push(`CDN analytics beacon blocked by the policy (static.cloudflareinsights.com), reported not fatal`);
  if (tiles) notes.push(`${tiles} outside image${tiles === 1 ? '' : 's'} failed (${[...new Set(s.imgErrors)].slice(0, 2).join(', ')}), reported not fatal`);
  if (outside) notes.push(`${outside} third-party console error${outside === 1 ? '' : 's'}, reported not fatal`);
  return pass(name, `no CSP violation, no first-party console error${notes.length ? `; ${notes.join('; ')}` : ''}`);
}

const OPEN_FINDER = `(async () => {
  const toggle = document.querySelector('.qc-finder-toggle');
  if (!toggle) throw new Error('no search control on the map');
  if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
  return qcWait('the finder box opened', () => { const el = document.getElementById('qc-place-search'), pane = el && el.closest('.qc-finder-box'); return pane && !pane.hidden ? true : null; });
})()`;

const typeInFinder = (page, text) => page.evaluate(`(async () => {
  await ${OPEN_FINDER};
  const box = document.getElementById('qc-place-search');
  box.focus(); box.value = ${JSON.stringify(text)};
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);

const optionTexts = (page) => page.evaluate(`[...document.querySelectorAll('#qc-place-results [role="option"]')].map((e) => e.textContent.trim())`);

/** Judges the finder's note after a street address was typed. Only the old missing-town wording means
 *  "feature not deployed"; any other note that mentions an address is the honest answer (whatever its
 *  wording, or real lookup) and passes; anything else fails. */
export function classifyAddressNote(note) {
  const text = String(note ?? '').replace(/\s+/g, ' ').trim();
  if (/^No town (matching|named)\b/i.test(text)) return { outcome: 'skipped', reason: 'feature not deployed (the finder still calls an address a missing town)' };
  if (/address/i.test(text)) return { outcome: 'pass', reason: 'address query gets an honest message about addresses' };
  return { outcome: 'fail', reason: `a street address was answered with "${text.slice(0, 120) || '(nothing)'}", neither a message about addresses nor the old missing-town wording (which would mean the feature is not deployed)` };
}

export async function checkSearch(ctx) {
  const name = 'search';
  const { page } = ctx;
  await openDashboard(ctx);
  // a. a town typed into the finder is offered, and choosing it lands the map there.
  await typeInFinder(page, TOWN.query);
  const towns = (await optionTexts(page)).filter((t) => t.includes(TOWN.query));
  if (!towns.length) {
    const note = await page.evaluate(`(document.getElementById('qc-finder-note') || {}).textContent || ''`);
    return fail(name, `typing "${TOWN.query}" offered no matching town (finder said: "${note.trim().slice(0, 120)}")`);
  }
  await page.evaluate('window.__settled = qcMoves(); true');
  await trustedClick(page, '#qc-place-results [role="option"]');
  await page.evaluate(`window.__settled('the map settled on ${TOWN.query}')`);
  const at = await page.evaluate('(() => { const c = window.qcMap.getCenter(); return [c.lat, c.lng, window.qcMap.getZoom()]; })()');
  if (Math.abs(at[0] - TOWN.lat) > 0.25 || Math.abs(at[1] - TOWN.lon) > 0.25) {
    return fail(name, `choosing ${towns[0]} left the map at ${at[0].toFixed(3)}, ${at[1].toFixed(3)}, not near ${TOWN.lat}, ${TOWN.lon}`);
  }
  // b. a name search: choose a result and the map carries exactly ONE marker for it (#707/#708).
  await typeInFinder(page, NAME_QUERY);
  await trustedClick(page, '#qc-name-search-btn');
  const settled = await tryWait(ctx, 'the name search to answer',
    `/\\bnames?$|No names matched|failed|timed out|Refine/.test((document.getElementById('qc-name-note') || {}).textContent || '')`);
  const status = await page.evaluate(`(document.getElementById('qc-name-note') || {}).textContent || ''`);
  if (!settled) return fail(name, `the name search for "${NAME_QUERY}" never answered (status: "${status}")`, 'service');
  if (/failed|timed out/i.test(status)) return fail(name, `service error: the name search for "${NAME_QUERY}" said "${status}"`, 'service');
  // The row judged below is the row clicked: the first one that carries a kind badge, read before the click.
  const rowText = await page.evaluate(`(() => { const b = document.querySelector('#qc-place-results [role="option"] .qc-finder-kind-badge'), row = b && b.closest('[role="option"]'); return row ? row.textContent.trim() : ''; })()`);
  if (!rowText) return fail(name, `the name search for "${NAME_QUERY}" returned no name rows (status: "${status}")`);
  await page.evaluate('window.__settled = qcMoves(); true');
  await trustedClick(page, '#qc-place-results [role="option"] .qc-finder-kind-badge');
  await page.evaluate("window.__settled('the map settled on the chosen name')");
  const marks = await page.evaluate(`(() => { const by = {}; for (const el of document.querySelectorAll('.leaflet-marker-pane [title]')) by[el.title] = (by[el.title] || 0) + 1; return by; })()`);
  const titles = Object.keys(marks).filter((t) => t && rowText.includes(t));
  if (!titles.length) return fail(name, `choosing "${rowText.slice(0, 60)}" put no titled search marker on the map (markers: ${JSON.stringify(marks)})`);
  const worst = titles.reduce((a, t) => (marks[t] > marks[a] ? t : a), titles[0]);
  if (marks[worst] !== 1) return fail(name, `choosing "${rowText.slice(0, 60)}" left ${marks[worst]} markers titled "${worst}", expected exactly one`);
  // c. a street address gets an honest answer, or the old wording marks that part as not deployed.
  await typeInFinder(page, ADDRESS_QUERY);
  const note = (await page.evaluate(`(document.getElementById('qc-finder-note') || {}).textContent || ''`)).trim();
  const addr = classifyAddressNote(note);
  if (addr.outcome === 'fail') return fail(name, addr.reason);
  const skipped = addr.outcome === 'skipped';
  const done = pass(name, `"${TOWN.query}" offered and landed; choosing "${titles[0]}" drew one marker; ${skipped ? `address part skipped: ${addr.reason}` : addr.reason}`);
  return skipped ? { ...done, skips: [{ part: 'address', reason: 'feature not deployed' }] } : done;
}

const setNames = (page, on) => page.evaluate(`(() => { const c = document.getElementById('qcm-layer-names'); if (!c) throw new Error('no Named places layer checkbox');
  c.checked = ${on}; c.dispatchEvent(new Event('change', { bubbles: true })); document.getElementById('qcm-check').click(); return true; })()`);

export async function checkLayers(ctx) {
  const name = 'layers';
  const { page } = ctx;
  await openDashboard(ctx);
  await chooseExampleArea(page);
  const SEL = '.qcm-name-marker';
  if (!await tryWait(ctx, 'name labels to be painted', `document.querySelectorAll('${SEL}').length > 0`)) {
    const z = classifyZero((await smoke(page)).requests, 'geonames');
    return fail(name, `the Named places layer is on by default but painted no labels: ${z.detail}`, z.cause);
  }
  const on = await count(page, SEL);
  await setNames(page, false);
  if (!await tryWait(ctx, 'name labels to go away', `document.querySelectorAll('${SEL}').length === 0`)) {
    return fail(name, `switching Named places off left ${await count(page, SEL)} of ${on} labels painted (stale layer)`);
  }
  await setNames(page, true);
  if (!await tryWait(ctx, 'name labels to come back', `document.querySelectorAll('${SEL}').length > 0`)) return fail(name, 'switching Named places back on painted nothing');
  const back = await count(page, SEL);
  // Real data has distinct features that share a name, so a repeated name alone is not a stale
  // layer. The same name at the same screen position is: that is one label painted twice.
  const labels = await page.evaluate(`[...document.querySelectorAll('${SEL}')].map((e) => { const r = e.getBoundingClientRect(); return e.getAttribute('aria-label') + ' @' + Math.round(r.left) + ',' + Math.round(r.top); })`);
  const doubled = labels.filter((l, i) => labels.indexOf(l) !== i);
  if (doubled.length) return fail(name, `after off and on, "${doubled[0].replace(/ @.*$/, '')}" is painted twice in the same spot (stale layer)`);
  if (back > on * 1.5 + 2) return fail(name, `after off and on, ${back} labels are painted where ${on} were before (stale layer)`);
  return pass(name, `Named places: ${on} labels on, 0 off, ${back} back on, none doubled`);
}

export async function checkRoads(ctx) {
  const name = 'roads';
  const { page } = ctx;
  await openDashboard(ctx, { data: false });
  await page.evaluate(`(async () => { const settled = qcMoves(); window.qcMap.setView([${ROAD_VIEW[0]}, ${ROAD_VIEW[1]}], ${ROAD_VIEW[2]}, { animate: false });
    await settled('the map settled at the road view'); return true; })()`);
  const expr = `document.querySelectorAll('.qcm-road-label').length > 0
    || (document.getElementById('qcm-layer-roads-report') || {}).textContent === 'Road names did not load'`;
  await tryWait(ctx, 'road labels or the page\'s own error note', expr);
  const n = await count(page, '.qcm-road-label');
  if (n > 0) return pass(name, `${n} road labels drawn at zoom ${ROAD_VIEW[2]} near Sylva NC`);
  const reported = await page.evaluate("(document.getElementById('qcm-layer-roads-report') || {}).textContent || ''");
  const z = classifyZero((await smoke(page)).requests, 'transportation');
  if (reported === 'Road names did not load' || z.cause === 'service') {
    return fail(name, `service error: USGS transportation service did not deliver (${z.detail}; page note "${reported}"), so no road labels`, 'service');
  }
  return fail(name, `our code drew no road labels at zoom ${ROAD_VIEW[2]}: ${z.detail}`, 'ours');
}

export async function checkInspection(ctx) {
  const name = 'inspection';
  const { page } = ctx;
  await openDashboard(ctx);
  await chooseExampleArea(page);
  if (!await tryWait(ctx, 'a name label to be painted', "document.querySelectorAll('.qcm-name-marker').length > 0")) {
    const z = classifyZero((await smoke(page)).requests, 'geonames');
    return fail(name, `no name label was painted to click: ${z.detail}`, z.cause);
  }
  const labels = await page.evaluate("[...document.querySelectorAll('.qcm-name-marker')].slice(0, 3).map((e) => e.getAttribute('aria-label'))");
  const tried = [];
  for (const label of labels) {
    const sel = `.qcm-name-marker[aria-label=${JSON.stringify(label)}]`;
    try { await trustedClick(page, sel); } catch (err) { tried.push(`could not press "${label}": ${err.message.slice(0, 100)}`); continue; }
    const opened = await tryWait(ctx, `the card for "${label}" to open`,
      `(() => { const c = document.querySelector('.leaflet-popup-pane .qcm-site-card'); return Boolean(c) && c.textContent.includes(${JSON.stringify(label)}); })()`);
    if (opened) return pass(name, `clicking the "${label}" label opened its card`);
    tried.push(`clicking "${label}" opened no card naming it`);
  }
  return fail(name, `card never opened: ${tried.slice(0, 2).join('; ') || 'no label could be pressed'}`);
}

const CHECKS = { marker: checkMarker, pages: checkPages, csp: checkCsp, search: checkSearch, layers: checkLayers, roads: checkRoads, inspection: checkInspection };

/** Runs the named checks in order. A check that throws fails with the error as its reason; a browser
 *  check with no page fails closed. `onFail(name, ctx)` runs after a failure (screenshots). Past
 *  `ctx.deadlineAt` (epoch ms, from --total-timeout-ms) a check fails unrun, and one still running is
 *  cut off, so a site that is badly down costs the deadline, not seven checks' worth of waits. */
export async function runChecks(ctx, names = CHECK_NAMES, { onFail = null } = {}) {
  const results = [];
  for (const name of names) {
    const started = performance.now();
    let result;
    const left = ctx.deadlineAt ? ctx.deadlineAt - Date.now() : Infinity;
    if (left <= 0) result = fail(name, 'run deadline reached before this check started (--total-timeout-ms), so it did not run');
    else if (name !== 'marker' && !ctx.page) result = fail(name, ctx.browserError || 'no browser: could not start Chromium');
    else {
      let timer;
      const attempt = Promise.resolve().then(() => CHECKS[name](ctx))
        .catch((err) => fail(name, `threw: ${String(err?.message ?? err).slice(0, 300)}`));
      const cutoff = left === Infinity ? new Promise(() => {})
        : new Promise((resolve) => { timer = setTimeout(() => resolve(fail(name, `run deadline reached while "${name}" was running (--total-timeout-ms); it was cut off`)), left); });
      try { result = await Promise.race([attempt, cutoff]); } finally { clearTimeout(timer); }
    }
    result.ms = Math.round(performance.now() - started);
    if (result.status === 'fail' && ctx.page && onFail) { try { await onFail(name, ctx); } catch { /* a missing screenshot never hides the failure */ } }
    results.push(result);
  }
  return results;
}
