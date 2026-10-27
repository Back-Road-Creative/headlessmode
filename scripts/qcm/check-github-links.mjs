// The github.com links in the BUILT site (public/), checked through the GitHub REST API
// instead of fetched as pages.
//
// htmltest fetched every github.com link as a page view. github.com rate-limits those per IP,
// and the self-hosted runners share one outbound IP, so on 2026-10-02 PR CI went red on 503
// "Unicorn!" pages (#665-#668) for links that were fine: the same URL with a browser user
// agent got 429 "Rate limit". .htmltest.yml now ignores github.com and this checks those
// links through the API instead, with the job's GITHUB_TOKEN in CI. One git tree lists a whole
// repository, so every blob link into one repository costs one request.
//
// It reads the links htmltest v0.17.0 reads: the same elements and attributes, from the tree
// parse5 builds (the HTML spec's parse, as Go's html.Parse does), skipping any subtree that
// carries data-proofer-ignore. It reads every page under --dir, demo/driftless included:
// .htmltest.yml's IgnoreDirs keeps htmltest out of that bundle because of its extensionless
// internal links, not because of anything it links to. Each URL shape maps to API answers,
// and a shape with no mapping fails rather than passing:
//   github.com                                    nothing to check
//   github.com/O                                  GET /users/O answers
//   github.com/O/R, O/R/releases                  the repository is public
//   github.com/O/R/security/advisories/new        ... and private vulnerability reporting is on
//   github.com/O/R/releases/latest[/download/A]   ... and a latest release exists [and lists A]
//   github.com/O/R/releases/download/T/A          ... and a published release tagged T lists A
//   github.com/O/R/blob|tree/REF[/PATH]           ... and PATH is in its tree at REF
//
// Usage: node scripts/qcm/check-github-links.mjs [--dir public]
//   GITHUB_TOKEN authenticates when set (CI passes the job's token); without it the API
//   allows an IP 60 requests an hour. GITHUB_API_URL (Actions sets it) replaces
//   https://api.github.com.
// Exit 0 = every github.com link resolved; 1 = a link is broken or could not be verified
// (`FAIL: url - reason`, then the pages that link it); 2 = bad arguments.
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';
import { builtPages } from './check-built-html.mjs';

// The elements htmltest checks and the attribute it reads on each (htmltest.go). <meta> is
// apart: only a refresh carries a URL, after "url=" in its content (check-meta.go).
const CHECKED = {
  a: ['href'], link: ['href'], area: ['href'], img: ['src'], script: ['src'],
  iframe: ['src'], input: ['src'], audio: ['src'], embed: ['src'], source: ['src'], track: ['src'],
  video: ['src', 'poster'], object: ['data'],
  blockquote: ['cite'], del: ['cite'], ins: ['cite'], q: ['cite'],
};
const IGNORE_ATTR = 'data-proofer-ignore';
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
const UNSUPPORTED = 'unsupported github.com URL shape; add a mapping to scripts/qcm/check-github-links.mjs';
const DEFINITIVE = new Set([404, 410, 451]); // the API's answer; asking again will not change it
const ATTEMPTS = 3;
const BACKOFF_MS = [2000, 4000]; // before the 2nd and 3rd try, unless GitHub names a wait
const TIMEOUT_MS = 15000;
const MAX_WAIT_MS = 60000; // a longer rate-limit wait fails the run instead of stalling it
const BREAKER = 3; // lookups in a row that could not be verified before the rest are not asked
const enc = encodeURIComponent;

/** Every URL htmltest would check on a page, in document order. */
export function extractLinks(html) {
  const out = [];
  const walk = (node) => {
    const attrs = node.attrs || [];
    if (attrs.some((a) => a.name === IGNORE_ATTR)) return;
    const get = (name) => attrs.find((a) => a.name === name)?.value;
    if (node.tagName === 'meta') {
      const content = get('content') || '';
      const m = get('http-equiv') === 'refresh' ? /; ?url=/i.exec(content) : null;
      if (m) out.push(content.slice(m.index + m[0].length));
    } else if (CHECKED[node.tagName] && !(node.tagName === 'link' && get('rel') === 'dns-prefetch')) {
      for (const name of CHECKED[node.tagName]) {
        const value = get(name);
        if (value !== undefined) out.push(value);
      }
    }
    for (const child of node.childNodes || []) walk(child);
    if (node.content) walk(node.content); // <template>: parse5 keeps its children apart
  };
  walk(parse(html));
  return out;
}

/** The github.com page a link names, as https://github.com/<path> with no query, fragment or
 * trailing slash; null for every other link (htmltest still checks those itself). */
export function githubUrl(raw) {
  let u;
  try { u = new URL(raw.trim(), 'https://site.invalid/'); } catch { return null; }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !GITHUB_HOSTS.has(u.host)) return null;
  return `https://github.com${u.pathname.replace(/\/+$/, '')}`;
}

/** The API answers a github.com URL needs: {steps: [{path, notFound, check?}]} in order, or
 * {error} for a URL this cannot vouch for. A check returns a problem, or null when fine. */
export function planCheck(url) {
  let parts;
  try { parts = new URL(url).pathname.split('/').filter(Boolean).map(decodeURIComponent); }
  catch { return { error: 'its path is not valid percent-encoding' }; }
  const [owner, repoPart, kind, ...rest] = parts;
  if (!owner) return { steps: [] }; // github.com itself
  if (!repoPart) {
    return { steps: [{ path: `/users/${enc(owner)}`, notFound: `no GitHub user or organization named ${owner}` }] };
  }
  const repo = repoPart.replace(/\.git$/, '');
  const name = `${owner}/${repo}`;
  const base = `/repos/${enc(owner)}/${enc(repo)}`;
  const steps = [{
    path: base,
    notFound: `no public repository ${name}`,
    check: (b) => (b.private === false ? null : `${name} is not public, so a reader gets a 404`),
  }];
  const tail = parts.slice(2).join('/');
  if (tail === '' || tail === 'releases') return { steps };
  if (tail === 'security/advisories/new') {
    steps.push({
      path: `${base}/private-vulnerability-reporting`,
      notFound: `GitHub has no private vulnerability reporting setting for ${name}`,
      check: (b) => (b.enabled === true
        ? null : `${name} has private vulnerability reporting turned off, so the report form is not there`),
    });
    return { steps };
  }
  if (kind === 'releases' && rest[0] === 'latest'
      && (rest.length === 1 || (rest.length === 3 && rest[1] === 'download'))) {
    const asset = rest[2];
    steps.push({
      path: `${base}/releases/latest`,
      notFound: `${name} has no published release, so releases/latest is a 404`,
      check: (b) => (asset === undefined || (b.assets || []).some((a) => a.name === asset)
        ? null : `${name}'s latest release (${b.tag_name}) has no asset named ${asset}`),
    });
    return { steps };
  }
  if (kind === 'releases' && rest[0] === 'download' && rest.length === 3) {
    const [, tag, asset] = rest;
    steps.push({
      path: `${base}/releases/tags/${enc(tag)}`,
      notFound: `${name} has no published release tagged ${tag}`,
      check: (b) => ((b.assets || []).some((a) => a.name === asset)
        ? null : `${name}'s release ${tag} has no asset named ${asset}`),
    });
    return { steps };
  }
  if ((kind === 'blob' && rest.length >= 2) || (kind === 'tree' && rest.length >= 1)) {
    const [ref, ...file] = rest;
    const path = file.join('/');
    const missing = `${path} is not in ${name} at ${ref}`;
    steps.push({
      path: `${base}/git/trees/${enc(ref)}?recursive=1`,
      notFound: `${name} has no branch, tag or commit named ${ref} (a ref with a slash in it is not supported)`,
      check: async (b, get) => {
        if (!path) return null;
        if (!b.truncated) return (b.tree || []).some((e) => e.path === path) ? null : missing;
        const r = await get(`${base}/contents/${file.map(enc).join('/')}?ref=${enc(ref)}`);
        return r.ok ? null : r.status === 404 ? missing : r.reason;
      },
    });
    return { steps };
  }
  return { error: UNSUPPORTED };
}

// How long GitHub asks a rate-limited client to wait, in ms, or null when it does not say.
function rateLimitWait(headers, nowMs) {
  const after = headers.get('retry-after');
  if (after !== null && /^\d+$/.test(after.trim())) return Number(after.trim()) * 1000;
  if (headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - nowMs) + 1000;
  }
  return null;
}

async function apiMessage(res) {
  try {
    const body = await res.json();
    return typeof body?.message === 'string' ? body.message : '';
  } catch {
    return '';
  }
}

// GET against the API, each path asked once per run. An answer is {ok: true, body}, or
// {ok: false, reason, definitive?, status?}; only a definitive answer says the link is broken,
// every other failure says it could not be verified, and neither is a pass.
function apiClient({ env, fetch, sleep, now }) {
  const base = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  const token = env.GITHUB_TOKEN || '';
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'headlessmode-check-github-links',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const memo = new Map();
  let sent = 0;
  let unverifiedInARow = 0;
  let stopped = '';

  async function once(path) {
    let last = '';
    for (let attempt = 1; ; attempt++) {
      let wait = BACKOFF_MS[attempt - 1];
      sent++;
      let res = null;
      try {
        res = await fetch(base + path, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (err) {
        last = `no answer from the GitHub API (${err?.cause?.code || err?.name || 'error'})`;
      }
      if (res) {
        if (res.status === 200) {
          try { return { ok: true, body: await res.json() }; }
          catch { return { ok: false, reason: `could not verify: GET ${path} answered 200 with a body that is not JSON` }; }
        }
        const message = await apiMessage(res);
        if (DEFINITIVE.has(res.status)) {
          return { ok: false, definitive: true, status: res.status, reason: `GET ${path} answered ${res.status}` };
        }
        if (res.status === 401) {
          stopped = 'GitHub rejected GITHUB_TOKEN (401)';
          return { ok: false, reason: `not checked: ${stopped}` };
        }
        const limit = rateLimitWait(res.headers, now());
        if (res.status === 429 || (res.status === 403 && (limit !== null || /rate limit/i.test(message)))) {
          if (limit !== null && limit > MAX_WAIT_MS) {
            stopped = `the GitHub API rate limit is used up until ${new Date(now() + limit).toISOString()}`
              + (token ? '' : '; set GITHUB_TOKEN to authenticate');
            return { ok: false, reason: `not checked: ${stopped}` };
          }
          if (limit !== null) wait = limit;
          last = `GET ${path} answered ${res.status} (rate limited)`;
        } else if (res.status >= 500) {
          last = `GET ${path} answered ${res.status}`;
        } else {
          return { ok: false, reason: `could not verify: GET ${path} answered ${res.status}${message ? `: ${message}` : ''}` };
        }
      }
      if (attempt === ATTEMPTS) return { ok: false, reason: `could not verify: ${last} (${ATTEMPTS} tries)` };
      await sleep(wait);
    }
  }

  async function ask(path) {
    if (stopped) return { ok: false, reason: `not checked: ${stopped}` };
    const r = await once(path);
    if (r.ok || r.definitive) unverifiedInARow = 0;
    else if (!stopped && ++unverifiedInARow >= BREAKER) {
      stopped = `the GitHub API stopped answering (${BREAKER} lookups in a row could not be verified)`;
    }
    return r;
  }

  const get = (path) => {
    if (!memo.has(path)) memo.set(path, ask(path));
    return memo.get(path);
  };
  return { get, requests: () => sent };
}

// null when every API answer the URL needs is there, else the problem.
async function verify(url, get) {
  const plan = planCheck(url);
  if (plan.error) return plan.error;
  for (const step of plan.steps) {
    const r = await get(step.path);
    if (!r.ok) return r.status === 404 ? step.notFound : r.reason;
    const problem = await step.check?.(r.body, get);
    if (problem) return problem;
  }
  return null;
}

/** Check every github.com link under dir. Returns {pages, links, urls, requests, problems}. */
export async function checkGithubLinks({
  dir = 'public',
  env = process.env,
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
} = {}) {
  const { files, problem } = builtPages(dir);
  if (problem) return { pages: 0, links: 0, urls: 0, requests: 0, problems: [problem] };
  const linkedFrom = new Map();
  let links = 0;
  for (const f of files.sort()) {
    const rel = relative(dir, f);
    for (const raw of extractLinks(readFileSync(f, 'utf8'))) {
      const url = githubUrl(raw);
      if (url === null) continue;
      links++;
      const pages = linkedFrom.get(url) || [];
      if (!pages.includes(rel)) pages.push(rel);
      linkedFrom.set(url, pages);
    }
  }
  const api = apiClient({ env, fetch, sleep, now });
  const problems = [];
  for (const [url, pages] of linkedFrom) {
    const reason = await verify(url, api.get);
    if (!reason) continue;
    const more = pages.length > 3 ? ` (+${pages.length - 3} more)` : '';
    problems.push(`${url} - ${reason}\n      linked from: ${pages.slice(0, 3).join(', ')}${more}`);
  }
  return { pages: files.length, links, urls: linkedFrom.size, requests: api.requests(), problems };
}

async function main(argv) {
  let dir = 'public';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir' && argv[i + 1] !== undefined) dir = argv[++i];
    else {
      const what = argv[i] === '--dir' ? '--dir needs a directory' : `unknown argument ${argv[i]}`;
      console.error(`${what}\nusage: check-github-links.mjs [--dir public]`);
      return 2;
    }
  }
  if (!process.env.GITHUB_TOKEN) {
    console.log("note: GITHUB_TOKEN is not set, so the GitHub API allows this IP 60 requests an hour; CI sets the job's token");
  }
  const r = await checkGithubLinks({ dir });
  if (r.problems.length) {
    for (const p of r.problems) console.error(`FAIL: ${p}`);
    console.error(`FAIL: ${r.problems.length} problem(s) in ${r.links} github.com link(s) (${r.urls} URLs) `
      + `on ${r.pages} page(s) in ${dir}, ${r.requests} API request(s)`);
    return 1;
  }
  console.log(`ok: ${r.links} github.com link(s) (${r.urls} URLs) on ${r.pages} pages in ${dir} `
    + `resolve through the GitHub API (${r.requests} requests)`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
