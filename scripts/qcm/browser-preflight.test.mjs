// The browser/build preflight (QQA-01, first slice): in CI a missing browser or a missing
// build FAILS the run instead of skipping it.
//
// About sixty test files do `const skip = !CHROMIUM ? 'no Chromium ...' : false` and
// node --test reports a skipped file as neither passed nor failed, so a runner that lost
// its browser (or a job that ran before the build) went green with the browser proofs
// quietly not run. The rule lives in ONE place, helpers/browser.mjs (findChromium and the
// CHROMIUM export built on it) and helpers/site-server.mjs (siteIsBuilt), so no test file
// changes: under CI=true, or QCM_REQUIRE_BROWSER=1, those helpers throw naming what is
// missing. Off CI with no opt-in, today's skip behaviour is unchanged, so a developer
// without Chromium can still run the pure tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as browser from './helpers/browser.mjs';
import * as siteServer from './helpers/site-server.mjs';

const HELPERS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers');
const BROWSER_URL = pathToFileURL(path.join(HELPERS, 'browser.mjs')).href;
const SHARDS_URL = pathToFileURL(path.join(HELPERS, 'place-shards.mjs')).href;
const SITE_URL = pathToFileURL(path.join(HELPERS, 'site-server.mjs')).href;

/** Runs `code` as an ES module in a fresh node with ONLY the env the case names (plus
 *  PATH/HOME so node and the module's homedir() work). The parent's CI, CHROME_PATH and
 *  friends must not leak in, or the "CI unset" cases would be testing the runner. */
function runChild(code, env) {
  const base = { PATH: process.env.PATH, HOME: process.env.HOME };
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...base, ...env }, encoding: 'utf8', timeout: 60_000,
  });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}

const findCode = `import { findChromium } from '${BROWSER_URL}'; console.log(JSON.stringify(findChromium()));`;
const exportCode = `import { CHROMIUM } from '${SHARDS_URL}'; console.log(JSON.stringify(CHROMIUM));`;
const MISSING = '/nonexistent/qcm-preflight/chromium';

// ---- the real module, in a child, with controlled env ------------------------------

test('CI=true and a CHROME_PATH naming a missing file throws, naming the path', () => {
  const r = runChild(findCode, { CI: 'true', CHROME_PATH: MISSING });
  assert.notEqual(r.status, 0, `findChromium() should have thrown; stdout was ${r.out}`);
  assert.match(r.err, new RegExp(MISSING));
  assert.match(r.err, /CHROME_PATH/);
});

test('CI=true and a PUPPETEER_EXECUTABLE_PATH naming a missing file throws too', () => {
  const r = runChild(findCode, { CI: 'true', PUPPETEER_EXECUTABLE_PATH: MISSING });
  assert.notEqual(r.status, 0, `findChromium() should have thrown; stdout was ${r.out}`);
  assert.match(r.err, new RegExp(MISSING));
});

test('the CHROMIUM export of helpers/place-shards.mjs throws at import under CI with a missing CHROME_PATH', () => {
  const r = runChild(exportCode, { CI: 'true', CHROME_PATH: MISSING });
  assert.notEqual(r.status, 0, `importing CHROMIUM should have thrown; stdout was ${r.out}`);
  assert.match(r.err, new RegExp(MISSING));
});

test('QCM_REQUIRE_BROWSER=1 off CI throws on a CHROME_PATH naming a missing file', () => {
  const r = runChild(findCode, { QCM_REQUIRE_BROWSER: '1', CHROME_PATH: MISSING });
  assert.notEqual(r.status, 0, `findChromium() should have thrown; stdout was ${r.out}`);
  assert.match(r.err, new RegExp(MISSING));
});

test('CI unset: a CHROME_PATH naming a missing file is not an error (today\'s fallback)', () => {
  const r = runChild(findCode, { CHROME_PATH: MISSING });
  assert.equal(r.status, 0, r.err);
  const found = JSON.parse(r.out);
  assert.ok(found === null || typeof found === 'string', `got ${r.out}`);
  assert.notEqual(found, MISSING);
});

test('CI="false" and QCM_REQUIRE_BROWSER=0 do not opt in', () => {
  const r = runChild(findCode, { CI: 'false', QCM_REQUIRE_BROWSER: '0', CHROME_PATH: MISSING });
  assert.equal(r.status, 0, r.err);
});

test('CI=true with a real CHROME_PATH returns it', () => {
  const real = browser.findChromium();
  if (!real) return; // nothing to point at on this box; the pure cases below cover the rule
  const r = runChild(findCode, { CI: 'true', CHROME_PATH: real });
  assert.equal(r.status, 0, r.err);
  assert.equal(JSON.parse(r.out), real);
});

// ---- the pure function: env + candidate list + exists() ----------------------------

const none = () => false;

test('resolveChromium: required and no browser on the candidate list throws, saying CI needs one and how to set CHROME_PATH', () => {
  assert.equal(typeof browser.resolveChromium, 'function', 'helpers/browser.mjs must export resolveChromium');
  assert.throws(
    () => browser.resolveChromium({ env: { CI: 'true' }, candidates: ['/a/chromium', '/b/chrome'], exists: none }),
    (err) => err instanceof Error && /CI/.test(err.message) && /requires/.test(err.message)
      && /CHROME_PATH/.test(err.message) && /\/a\/chromium/.test(err.message),
  );
});

test('resolveChromium: required and a CHROME_PATH naming a missing file throws even though a candidate exists', () => {
  assert.throws(
    () => browser.resolveChromium({
      env: { CI: 'true', CHROME_PATH: '/gone/chromium' }, candidates: ['/here/chromium'], exists: (p) => p === '/here/chromium',
    }),
    (err) => err instanceof Error && /\/gone\/chromium/.test(err.message),
  );
});

test('resolveChromium: not required, nothing on disk -> null; not required, bad CHROME_PATH -> first candidate', () => {
  assert.equal(browser.resolveChromium({ env: {}, candidates: ['/a'], exists: none }), null);
  assert.equal(
    browser.resolveChromium({ env: { CHROME_PATH: '/gone' }, candidates: ['/a', '/b'], exists: (p) => p === '/b' }), '/b',
  );
});

test('resolveChromium: required and found returns the named path first, else the first candidate', () => {
  const exists = (p) => p === '/named' || p === '/b';
  assert.equal(browser.resolveChromium({ env: { CI: 'true', CHROME_PATH: '/named' }, candidates: ['/b'], exists }), '/named');
  assert.equal(browser.resolveChromium({ env: { CI: 'true' }, candidates: ['/a', '/b'], exists }), '/b');
});

test('browserRequired: CI must be exactly "true", QCM_REQUIRE_BROWSER exactly "1"', () => {
  assert.equal(typeof browser.browserRequired, 'function', 'helpers/browser.mjs must export browserRequired');
  assert.equal(browser.browserRequired({ CI: 'true' }), true);
  assert.equal(browser.browserRequired({ QCM_REQUIRE_BROWSER: '1' }), true);
  for (const env of [{}, { CI: 'false' }, { CI: '1' }, { CI: '' }, { QCM_REQUIRE_BROWSER: '0' }, { QCM_REQUIRE_BROWSER: 'true' }]) {
    assert.equal(browser.browserRequired(env), false, JSON.stringify(env));
  }
});

// ---- the built site ----------------------------------------------------------------

test('siteIsBuilt: under CI a missing page throws naming the path and the build command', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qcm-preflight-'));
  try {
    assert.throws(
      () => siteServer.siteIsBuilt('quiet-corners', { env: { CI: 'true' }, publicDir: dir }),
      (err) => err instanceof Error && err.message.includes(path.join(dir, 'quiet-corners', 'index.html'))
        && /build-site\.sh/.test(err.message),
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('siteIsBuilt: off CI a missing page is false (skip), a present page is true under either mode', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qcm-preflight-'));
  try {
    assert.equal(siteServer.siteIsBuilt('quiet-corners', { env: {}, publicDir: dir }), false);
    mkdirSync(path.join(dir, 'quiet-corners'), { recursive: true });
    writeFileSync(path.join(dir, 'quiet-corners', 'index.html'), '<!doctype html>');
    assert.equal(siteServer.siteIsBuilt('quiet-corners', { env: {}, publicDir: dir }), true);
    assert.equal(siteServer.siteIsBuilt('quiet-corners', { env: { CI: 'true' }, publicDir: dir }), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('siteIsBuilt in a child: CI=true and a page no build produces throws; CI unset returns false', () => {
  const code = `import { siteIsBuilt } from '${SITE_URL}'; console.log(JSON.stringify(siteIsBuilt('no-such-page-qcm-preflight')));`;
  const strict = runChild(code, { CI: 'true' });
  assert.notEqual(strict.status, 0, `should have thrown; stdout was ${strict.out}`);
  assert.match(strict.err, /no-such-page-qcm-preflight/);
  const lax = runChild(code, {});
  assert.equal(lax.status, 0, lax.err);
  assert.equal(lax.out, 'false');
});
