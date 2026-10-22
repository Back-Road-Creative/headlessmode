// The gate behind `npm run test:html` must be able to fail. Until HM-1 that script was an
// `echo` that exited 0 with no build at all, so a malformed page, a missing page or an
// empty public/ all read as green. Every case here is a build the old command passed.
//
// Each case builds a tiny site in a temp dir and runs the real CLI (or the real wrapper
// script), so the exit code, which is the contract, is what is asserted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultExpectedPages, pageFile } from './check-built-html.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'check-built-html.mjs');
const WRAPPER = join(HERE, '..', 'test-html.sh');
const REPO = join(HERE, '..', '..');

const GOOD = (body = '<main><h1>Hi</h1><p>text</p></main>') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;

function site(pages) {
  const dir = mkdtempSync(join(tmpdir(), 'html-gate-'));
  for (const [rel, html] of Object.entries(pages)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), html);
  }
  return dir;
}

function run(dir, expects, extra = []) {
  const args = [CLI, '--dir', dir, ...expects.flatMap((e) => ['--expect', e]), ...extra];
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

test('a valid built site passes', () => {
  const dir = site({ 'index.html': GOOD(), 'about/index.html': GOOD(), '404.html': GOOD() });
  const r = run(dir, ['/', '/about/', '/404.html']);
  cleanup(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('minified HTML that omits optional end tags and self-closes svg still passes', () => {
  const body =
    '<ul><li>a<li>b</ul><table><tr><td>x<td>y</table><p>one<p>two' +
    '<svg viewBox="0 0 2 2"><path d="M0 0"/><circle r="1"/></svg><img src="a.png" alt=""><br>';
  const dir = site({ 'index.html': GOOD(body) });
  const r = run(dir, ['/']);
  cleanup(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('an unclosed element fails and names the file', () => {
  const dir = site({ 'index.html': GOOD('<main><div><span>x</main>') });
  const r = run(dir, ['/']);
  cleanup(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /index\.html/);
  assert.match(r.stdout + r.stderr, /unclosed <(div|span)>/);
});

test('a page cut off mid-document fails', () => {
  // Cut inside text, so no tokenizer error fires: only the open <main> gives it away.
  const html = GOOD();
  const dir = site({ 'index.html': html.slice(0, html.indexOf('<h1>') + 6) });
  const r = run(dir, ['/']);
  cleanup(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /unclosed <(main|h1)> at end of file/);
});

test('a stray end tag fails', () => {
  const dir = site({ 'index.html': GOOD('<main><p>x</p></span></main>') });
  const r = run(dir, ['/']);
  cleanup(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /stray <\/span>/);
});

test('tokenizer-level breakage (unterminated tag, duplicate attribute, no doctype) fails', () => {
  const cases = {
    'unterminated tag': GOOD('<a href="x'),
    'duplicate attribute': GOOD('<div id="a" id="b">x</div>'),
    'no doctype': '<html><head><title>t</title></head><body>x</body></html>',
  };
  for (const [label, html] of Object.entries(cases)) {
    const dir = site({ 'index.html': html });
    const r = run(dir, ['/']);
    cleanup(dir);
    assert.notEqual(r.status, 0, `${label} must fail`);
  }
});

test('a missing expected page fails even when every present page is valid', () => {
  const dir = site({ 'index.html': GOOD() });
  const r = run(dir, ['/', '/about/']);
  cleanup(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /missing expected page \/about\//);
});

test('an empty page fails as a page with no doctype, not as a pass', () => {
  const dir = site({ 'index.html': '' });
  const r = run(dir, ['/']);
  cleanup(dir);
  assert.notEqual(r.status, 0);
});

test('an empty or absent build directory fails loudly instead of passing zero pages', () => {
  const empty = site({});
  const r1 = run(empty, ['/']);
  cleanup(empty);
  assert.notEqual(r1.status, 0);
  assert.match(r1.stdout + r1.stderr, /no HTML files/);

  const r2 = run(join(tmpdir(), 'html-gate-does-not-exist'), ['/']);
  assert.notEqual(r2.status, 0);
  assert.match(r2.stdout + r2.stderr, /build (directory|output)/i);
});

test('pageFile maps a site URL to the file Hugo writes', () => {
  assert.equal(pageFile('/'), 'index.html');
  assert.equal(pageFile('/about/'), 'about/index.html');
  assert.equal(pageFile('/404.html'), '404.html');
});

test('the default expected pages come from the repo, not a hand-kept list here', () => {
  const pages = defaultExpectedPages(REPO);
  for (const want of ['/', '/404.html', '/about/', '/contact/', '/privacy/', '/rigscore/']) {
    assert.ok(pages.includes(want), `${want} missing from ${pages.join(' ')}`);
  }
  assert.ok(pages.every((p) => p.startsWith('/')), 'an external link leaked in');
});

// The wrapper is what `npm run test:html` runs: page checks first, then htmltest.
function wrapper(dir, env, args = []) {
  return spawnSync('bash', [WRAPPER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HTML_DIR: dir, ...env },
  });
}

function stubHtmltest(exitCode) {
  const dir = mkdtempSync(join(tmpdir(), 'html-gate-bin-'));
  const bin = join(dir, 'htmltest');
  writeFileSync(bin, `#!/bin/sh\necho "stub htmltest $*"\nexit ${exitCode}\n`);
  chmodSync(bin, 0o755);
  return { dir, bin };
}

test('wrapper: a missing htmltest is a failure, never a skip', () => {
  const dir = site({ 'index.html': GOOD() });
  const r = wrapper(dir, { HTMLTEST_BIN: '/nonexistent/htmltest', HTML_EXPECT: '/' });
  cleanup(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /htmltest is not installed/);
});

test('wrapper: htmltest runs on a valid build and its failure fails the wrapper', () => {
  const dir = site({ 'index.html': GOOD() });
  const ok = stubHtmltest(0);
  const bad = stubHtmltest(1);
  const pass = wrapper(dir, { HTMLTEST_BIN: ok.bin, HTML_EXPECT: '/' });
  const fail = wrapper(dir, { HTMLTEST_BIN: bad.bin, HTML_EXPECT: '/' });
  cleanup(dir); cleanup(ok.dir); cleanup(bad.dir);
  assert.equal(pass.status, 0, pass.stdout + pass.stderr);
  assert.match(pass.stdout, /stub htmltest/);
  assert.notEqual(fail.status, 0);
});

test('wrapper: --skip-external is passed through and reported as skipped, not passed', () => {
  const dir = site({ 'index.html': GOOD() });
  const ok = stubHtmltest(0);
  const r = wrapper(dir, { HTMLTEST_BIN: ok.bin, HTML_EXPECT: '/' }, ['--skip-external']);
  cleanup(dir); cleanup(ok.dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /stub htmltest .*--skip-external/);
  assert.match(r.stdout, /SKIPPED: external link checks/);
});

test('wrapper: a malformed page stops the run before htmltest is consulted', () => {
  const dir = site({ 'index.html': GOOD('<main><div>x</main>') });
  const ok = stubHtmltest(0);
  const r = wrapper(dir, { HTMLTEST_BIN: ok.bin, HTML_EXPECT: '/' });
  cleanup(dir); cleanup(ok.dir);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /stub htmltest/);
});
