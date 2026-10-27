// github.com links in the built site are checked through the GitHub REST API, not fetched as
// pages (check-github-links.mjs). github.com rate-limits page views per IP, and on 2026-10-02
// PR CI went red on 503s for github.com links that were fine (hm#665-#668).
//
// Nothing here reaches the network: the in-process cases hand checkGithubLinks a fake fetch,
// and the CLI and wrapper cases point GITHUB_API_URL at a server on 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractLinks, githubUrl, planCheck, checkGithubLinks } from './check-github-links.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'check-github-links.mjs');
const WRAPPER = join(HERE, '..', 'test-html.sh');

const page = (body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body><main><h1>Hi</h1>${body}</main></body></html>`;
const linkTo = (...hrefs) => page(hrefs.map((h) => `<p><a href="${h}">x</a></p>`).join(''));

function site(pages) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-links-'));
  for (const [rel, html] of Object.entries(pages)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), html);
  }
  return dir;
}

const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

// A stand-in for fetch. routes maps an API path (with its query) to {status, body, headers},
// to a list of those served in turn (the last one repeats), or to an Error to throw.
// Anything unrouted answers 404, as the API does.
function fakeApi(routes) {
  const asked = [];
  const served = new Map();
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = u.pathname + u.search;
    asked.push({ path: key, auth: init.headers?.Authorization });
    let r = routes[key];
    if (Array.isArray(r)) {
      const n = served.get(key) || 0;
      served.set(key, n + 1);
      r = r[Math.min(n, r.length - 1)];
    }
    if (r instanceof Error) throw r;
    const { status = 200, body = {}, headers = {} } = r || { status: 404, body: { message: 'Not Found' } };
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  return { fetch, asked };
}

function fakeSleep() {
  const slept = [];
  return { slept, sleep: async (ms) => { slept.push(ms); } };
}

const quiet = async () => {};

// The same routes, served over HTTP, for the CLI and the wrapper.
async function apiServer(routes) {
  const asked = [];
  const server = createServer((req, res) => {
    asked.push({ path: req.url, auth: req.headers.authorization });
    const r = routes[req.url] || { status: 404, body: { message: 'Not Found' } };
    res.writeHead(r.status || 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.body || {}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    asked,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

// spawnSync would block this process's event loop, and with it the server the child calls.
function runAsync(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function stubHtmltest() {
  const dir = mkdtempSync(join(tmpdir(), 'gh-links-bin-'));
  const bin = join(dir, 'htmltest');
  writeFileSync(bin, '#!/bin/sh\necho "stub htmltest $*"\nexit 0\n');
  chmodSync(bin, 0o755);
  return { dir, bin };
}

const OK_ROUTES = {
  '/users/acme': { body: { login: 'acme', type: 'Organization' } },
  '/repos/acme/tool': { body: { full_name: 'acme/tool', private: false } },
  '/repos/acme/tool/git/trees/main?recursive=1': {
    body: { truncated: false, tree: [{ path: 'README.md' }, { path: 'docs' }, { path: 'docs/a.md' }] },
  },
  '/repos/acme/tool/releases/latest': { body: { tag_name: 'v1', assets: [{ name: 'tool.html' }] } },
  '/repos/acme/tool/releases/tags/v1': { body: { tag_name: 'v1', assets: [{ name: 'tool.html' }] } },
  '/repos/acme/tool/private-vulnerability-reporting': { body: { enabled: true } },
};

test('extractLinks reads the attributes htmltest reads, and skips what it skips', () => {
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title>' +
    '<meta http-equiv="refresh" content="0; url=https://github.com/o/refresh">' +
    '<link rel="canonical" href="https://github.com/o/link">' +
    '<link rel="dns-prefetch" href="https://github.com/o/prefetch">' +
    '<script src="https://github.com/o/script"></script></head><body>' +
    '<a href="https://github.com/o/a">a</a><a>no href</a>' +
    '<img src="https://github.com/o/img" srcset="https://github.com/o/srcset 2x" alt="">' +
    '<video src="https://github.com/o/video" poster="https://github.com/o/poster"></video>' +
    '<object data="https://github.com/o/object"></object>' +
    '<blockquote cite="https://github.com/o/cite">q</blockquote>' +
    '<iframe src="https://github.com/o/iframe"></iframe>' +
    '<map name="m"><area href="https://github.com/o/area" alt="x"></map>' +
    '<template><a href="https://github.com/o/template">t</a></template>' +
    '<div data-proofer-ignore><p><a href="https://github.com/o/ignored">i</a></p></div>' +
    '</body></html>';
  const want = ['refresh', 'link', 'script', 'a', 'img', 'video', 'poster', 'object', 'cite', 'iframe', 'area', 'template'];
  assert.deepEqual(extractLinks(html).sort(), want.map((w) => `https://github.com/o/${w}`).sort());
});

test('githubUrl normalises github.com links and leaves every other URL alone', () => {
  assert.equal(githubUrl('https://github.com/acme/tool'), 'https://github.com/acme/tool');
  assert.equal(githubUrl('//github.com/acme/tool/'), 'https://github.com/acme/tool');
  assert.equal(githubUrl('http://github.com/acme'), 'https://github.com/acme');
  assert.equal(githubUrl('https://www.github.com/acme/tool?tab=readme#top'), 'https://github.com/acme/tool');
  assert.equal(githubUrl(' https://github.com/acme/tool/blob/main/a%20b.md '), 'https://github.com/acme/tool/blob/main/a%20b.md');
  for (const other of [
    'https://gist.github.com/acme', 'https://github.com.evil.example/acme', 'https://api.github.com/repos/a/b',
    'https://github.com:8443/acme', '/about/', 'docs/x.md', '#top', 'mailto:a@b.example', 'https://[',
  ]) {
    assert.equal(githubUrl(other), null, other);
  }
});

test('planCheck maps each github.com URL shape to the API answers it needs', () => {
  const paths = (url) => planCheck(url).steps.map((s) => s.path);
  const repo = '/repos/acme/tool';
  assert.deepEqual(paths('https://github.com'), []);
  assert.deepEqual(paths('https://github.com/acme'), ['/users/acme']);
  assert.deepEqual(paths('https://github.com/acme/tool'), [repo]);
  assert.deepEqual(paths('https://github.com/acme/tool.git'), [repo]);
  assert.deepEqual(paths('https://github.com/acme/tool/releases'), [repo]);
  assert.deepEqual(paths('https://github.com/acme/tool/security/advisories/new'), [repo, `${repo}/private-vulnerability-reporting`]);
  assert.deepEqual(paths('https://github.com/acme/tool/releases/latest'), [repo, `${repo}/releases/latest`]);
  assert.deepEqual(paths('https://github.com/acme/tool/releases/latest/download/tool.html'), [repo, `${repo}/releases/latest`]);
  assert.deepEqual(paths('https://github.com/acme/tool/releases/download/v1/tool.html'), [repo, `${repo}/releases/tags/v1`]);
  assert.deepEqual(paths('https://github.com/acme/tool/blob/main/docs/a.md'), [repo, `${repo}/git/trees/main?recursive=1`]);
  assert.deepEqual(paths('https://github.com/acme/tool/tree/main'), [repo, `${repo}/git/trees/main?recursive=1`]);
  for (const unsupported of [
    'https://github.com/acme/tool/issues', 'https://github.com/acme/tool/blob/main',
    'https://github.com/acme/tool/releases/tag/v1', 'https://github.com/acme/tool/releases/latest/download',
    'https://github.com/acme/tool/releases/download/v1', 'https://github.com/acme/tool/releases/download/v1/a/b',
  ]) {
    assert.match(planCheck(unsupported).error, /unsupported github\.com URL shape/, unsupported);
  }
  assert.match(planCheck('https://github.com/acme/tool/blob/main/%E0%A4%A').error, /percent-encoding/);
});

test('every link resolves, and one tree answers every blob link into a repository', async () => {
  const dir = site({
    'index.html': linkTo(
      'https://github.com/acme', 'https://github.com/acme/tool', '//github.com/acme/tool/',
      'https://www.github.com/acme/tool/releases', 'https://github.com/acme/tool/releases/latest/download/tool.html',
      'https://github.com/acme/tool/security/advisories/new', 'https://github.com',
      'https://github.com/acme/tool/releases/download/v1/tool.html',
    ),
    'docs/index.html': linkTo(
      'https://github.com/acme/tool/blob/main/README.md', 'https://github.com/acme/tool/blob/main/docs/a.md',
      'https://github.com/acme/tool/tree/main/docs', '/about/', 'https://example.com/',
    ),
  });
  const api = fakeApi(OK_ROUTES);
  const r = await checkGithubLinks({ dir, env: {}, fetch: api.fetch, sleep: quiet });
  cleanup(dir);
  assert.deepEqual(r.problems, []);
  assert.equal(r.pages, 2);
  assert.equal(r.links, 11);
  assert.equal(r.urls, 10);
  assert.deepEqual(api.asked.map((a) => a.path).sort(), Object.keys(OK_ROUTES).sort());
  assert.equal(r.requests, 6);
  assert.ok(api.asked.every((a) => a.auth === undefined), 'no token was given, so none is sent');
});

test('a broken github.com link fails with the reason and the pages that link it', async () => {
  const dir = site({
    'index.html': linkTo(
      'https://github.com/acme/gone', 'https://github.com/acme/secret', 'https://github.com/acme/tool/blob/main/missing.md',
      'https://github.com/acme/tool/blob/dev/README.md', 'https://github.com/acme/tool/releases/latest/download/other.zip',
      'https://github.com/acme/quiet/security/advisories/new', 'https://github.com/acme/tool/issues',
      'https://github.com/nobody-here', 'https://github.com/acme/tool/releases/download/v1/other.zip',
      'https://github.com/acme/tool/releases/download/v9/tool.html',
    ),
    'a/index.html': linkTo('https://github.com/acme/gone'),
  });
  const api = fakeApi({
    ...OK_ROUTES,
    '/repos/acme/secret': { body: { private: true } },
    '/repos/acme/quiet': { body: { private: false } },
    '/repos/acme/quiet/private-vulnerability-reporting': { body: { enabled: false } },
  });
  const { problems } = await checkGithubLinks({ dir, env: {}, fetch: api.fetch, sleep: quiet });
  cleanup(dir);
  const want = [
    'https://github.com/acme/gone - no public repository acme/gone',
    'https://github.com/acme/secret - acme/secret is not public, so a reader gets a 404',
    'https://github.com/acme/tool/blob/main/missing.md - missing.md is not in acme/tool at main',
    'https://github.com/acme/tool/blob/dev/README.md - acme/tool has no branch, tag or commit named dev',
    "https://github.com/acme/tool/releases/latest/download/other.zip - acme/tool's latest release (v1) has no asset named other.zip",
    'https://github.com/acme/quiet/security/advisories/new - acme/quiet has private vulnerability reporting turned off',
    'https://github.com/acme/tool/issues - unsupported github.com URL shape',
    'https://github.com/nobody-here - no GitHub user or organization named nobody-here',
    "https://github.com/acme/tool/releases/download/v1/other.zip - acme/tool's release v1 has no asset named other.zip",
    'https://github.com/acme/tool/releases/download/v9/tool.html - acme/tool has no published release tagged v9',
  ];
  assert.equal(problems.length, want.length, problems.join('\n'));
  for (const w of want) assert.ok(problems.some((p) => p.startsWith(w)), `${w}\n--- got:\n${problems.join('\n')}`);
  const gone = problems.find((p) => p.startsWith('https://github.com/acme/gone'));
  assert.match(gone, /\n\s+linked from: a\/index\.html, index\.html$/);
});

test('a 5xx, or a rate limit with a short wait, is retried, waiting as long as GitHub asks', async () => {
  const dir = site({ 'index.html': linkTo('https://github.com/a', 'https://github.com/b') });
  const api = fakeApi({
    '/users/a': [{ status: 503, body: { message: 'Service Unavailable' } }, { body: { login: 'a' } }],
    '/users/b': [
      { status: 403, body: { message: 'You have exceeded a secondary rate limit' }, headers: { 'retry-after': '7' } },
      { body: { login: 'b' } },
    ],
  });
  const s = fakeSleep();
  const r = await checkGithubLinks({ dir, env: {}, fetch: api.fetch, sleep: s.sleep });
  cleanup(dir);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(s.slept, [2000, 7000]);
  assert.equal(r.requests, 4);
});

test('an API that keeps failing is not asked again after three links in a row', async () => {
  const users = ['u1', 'u2', 'u3', 'u4'];
  const dir = site({ 'index.html': linkTo(...users.map((u) => `https://github.com/${u}`)) });
  const down = [{ status: 503, body: { message: 'Service Unavailable' } }];
  const api = fakeApi(Object.fromEntries(users.map((u) => [`/users/${u}`, down])));
  const r = await checkGithubLinks({ dir, env: {}, fetch: api.fetch, sleep: quiet });
  cleanup(dir);
  assert.equal(r.problems.length, 4, r.problems.join('\n'));
  assert.match(r.problems[0], /^https:\/\/github\.com\/u1 - could not verify: GET \/users\/u1 answered 503 \(3 tries\)/);
  assert.match(r.problems[3], /^https:\/\/github\.com\/u4 - not checked: the GitHub API stopped answering/);
  assert.equal(api.asked.length, 9);
});

test('a used-up rate limit fails at once instead of waiting for the reset', async () => {
  const NOW = Date.parse('2026-10-02T13:00:00Z');
  const dir = site({ 'index.html': linkTo('https://github.com/a', 'https://github.com/b') });
  const api = fakeApi({
    '/users/a': {
      status: 403,
      body: { message: 'API rate limit exceeded for 203.0.113.9.' },
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 3600) },
    },
  });
  const s = fakeSleep();
  const r = await checkGithubLinks({ dir, env: {}, fetch: api.fetch, sleep: s.sleep, now: () => NOW });
  cleanup(dir);
  assert.equal(r.problems.length, 2, r.problems.join('\n'));
  for (const p of r.problems) {
    assert.match(p, /not checked: the GitHub API rate limit is used up until 2026-10-02T14:00:01\.000Z; set GITHUB_TOKEN/);
  }
  assert.equal(api.asked.length, 1);
  assert.deepEqual(s.slept, []);
});

test('a tree too big to list in one answer falls back to the contents API', async () => {
  const dir = site({
    'index.html': linkTo('https://github.com/acme/big/blob/main/docs/a.md', 'https://github.com/acme/big/blob/main/missing.md'),
  });
  const api = fakeApi({
    '/repos/acme/big': { body: { private: false } },
    '/repos/acme/big/git/trees/main?recursive=1': { body: { truncated: true, tree: [] } },
    '/repos/acme/big/contents/docs/a.md?ref=main': { body: { path: 'docs/a.md' } },
  });
  const r = await checkGithubLinks({ dir, env: {}, fetch: api.fetch, sleep: quiet });
  cleanup(dir);
  assert.equal(r.problems.length, 1, r.problems.join('\n'));
  assert.match(r.problems[0], /^https:\/\/github\.com\/acme\/big\/blob\/main\/missing\.md - missing\.md is not in acme\/big at main/);
});

test('no answer at all is a failure, never a pass', async () => {
  const dir = site({ 'index.html': linkTo('https://github.com/acme') });
  const refused = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
  const api = fakeApi({ '/users/acme': [refused] });
  const r = await checkGithubLinks({ dir, env: {}, fetch: api.fetch, sleep: quiet });
  cleanup(dir);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /could not verify: no answer from the GitHub API \(ECONNREFUSED\) \(3 tries\)/);
  assert.equal(r.requests, 3);
});

test('an empty or absent build directory fails loudly instead of passing zero links', async () => {
  const empty = site({});
  const r1 = await checkGithubLinks({ dir: empty, env: {}, fetch: fakeApi({}).fetch });
  cleanup(empty);
  assert.match(r1.problems.join('\n'), /no HTML files/);
  const r2 = await checkGithubLinks({ dir: join(tmpdir(), 'gh-links-does-not-exist'), env: {}, fetch: fakeApi({}).fetch });
  assert.match(r2.problems.join('\n'), /build directory does not exist/);
});

test('CLI: exit 0 when every link resolves, 1 on a broken one, 2 on a bad argument; the token is sent, never printed', async () => {
  const server = await apiServer({ '/users/acme': { body: { login: 'acme' } } });
  const good = site({ 'index.html': linkTo('https://github.com/acme') });
  const bad = site({ 'index.html': linkTo('https://github.com/nobody-here') });
  const env = { GITHUB_API_URL: server.url, GITHUB_TOKEN: 'tok-SECRET-123' };
  try {
    const pass = await runAsync(process.execPath, [CLI, '--dir', good], env);
    const fail = await runAsync(process.execPath, [CLI, '--dir', bad], env);
    const usage = await runAsync(process.execPath, [CLI, '--bogus'], env);
    const anon = await runAsync(process.execPath, [CLI, '--dir', good], { ...env, GITHUB_TOKEN: '' });
    assert.equal(pass.status, 0, pass.stdout + pass.stderr);
    assert.match(pass.stdout, /^ok: 1 github\.com link/m);
    assert.equal(fail.status, 1, fail.stdout + fail.stderr);
    assert.match(fail.stderr, /^FAIL: https:\/\/github\.com\/nobody-here - no GitHub user or organization named nobody-here$/m);
    assert.equal(usage.status, 2, usage.stdout + usage.stderr);
    assert.equal(anon.status, 0, anon.stdout + anon.stderr);
    assert.match(anon.stdout, /GITHUB_TOKEN is not set/);
    assert.deepEqual(server.asked.map((a) => a.auth), ['Bearer tok-SECRET-123', 'Bearer tok-SECRET-123', undefined]);
    for (const r of [pass, fail, usage, anon]) assert.doesNotMatch(r.stdout + r.stderr, /tok-SECRET-123/);
  } finally {
    cleanup(good); cleanup(bad);
    await server.close();
  }
});

test('wrapper: npm run test:html checks github.com links through the API after htmltest', async () => {
  const server = await apiServer({ '/users/acme': { body: { login: 'acme' } } });
  const stub = stubHtmltest();
  const good = site({ 'index.html': linkTo('https://github.com/acme') });
  const bad = site({ 'index.html': linkTo('https://github.com/nobody-here') });
  const env = (dir) => ({ HTML_DIR: dir, HTML_EXPECT: '/', HTMLTEST_BIN: stub.bin, GITHUB_API_URL: server.url, GITHUB_TOKEN: '' });
  try {
    const pass = await runAsync('bash', [WRAPPER], env(good));
    const fail = await runAsync('bash', [WRAPPER], env(bad));
    assert.equal(pass.status, 0, pass.stdout + pass.stderr);
    const htmltest = pass.stdout.indexOf('stub htmltest');
    assert.ok(htmltest !== -1 && htmltest < pass.stdout.indexOf('=== github.com links through the GitHub API'), pass.stdout);
    assert.match(pass.stdout, /^ok: 1 github\.com link/m);
    assert.notEqual(fail.status, 0, fail.stdout + fail.stderr);
    assert.match(fail.stderr, /FAIL: https:\/\/github\.com\/nobody-here/);
  } finally {
    cleanup(good); cleanup(bad); cleanup(stub.dir);
    await server.close();
  }
});

test('wrapper: --skip-external skips the API check too, and says so', async () => {
  const server = await apiServer({});
  const stub = stubHtmltest();
  const dir = site({ 'index.html': linkTo('https://github.com/acme') });
  try {
    const r = await runAsync('bash', [WRAPPER, '--skip-external'], {
      HTML_DIR: dir, HTML_EXPECT: '/', HTMLTEST_BIN: stub.bin, GITHUB_API_URL: server.url, GITHUB_TOKEN: '',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /SKIPPED: github\.com link checks \(--skip-external\)/);
    assert.equal(server.asked.length, 0);
  } finally {
    cleanup(dir); cleanup(stub.dir);
    await server.close();
  }
});
