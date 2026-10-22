// Serves the Hugo output in `public/` over http, so a test can look at the real page.
//
// Node built-ins only, same as helpers/browser.mjs and helpers/module-server.mjs: the
// layout tests need an origin because a `file://` page gets no module loading and no
// stylesheet resolution for the site's absolute `/css/...` links.
import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserRequired, freePort } from './browser.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

/** True when `hugo --configDir site-config --minify` has run and left a page here.
 *  Off CI the layout tests skip rather than fail without it: a bare checkout has no
 *  `public/`. Under CI (or QCM_REQUIRE_BROWSER=1, the same switch findChromium reads) a
 *  missing page THROWS naming the path instead: PR CI and the deploy job both build before
 *  `node --test`, so an absent page there is a broken job, and skipping would turn it green
 *  with every browser proof not run. `env` and `publicDir` are parameters for the tests. */
export function siteIsBuilt(page = 'quiet-corners', { env = process.env, publicDir = PUBLIC_DIR } = {}) {
  const file = path.join(publicDir, page, 'index.html');
  if (existsSync(file)) return true;
  if (browserRequired(env)) {
    throw new Error(`${file} is missing, and this run requires the built site (CI=true or QCM_REQUIRE_BROWSER=1): `
      + `the browser tests that serve public/ would otherwise be skipped and the run would go green without them. `
      + `Build it first: bash scripts/build-site.sh --configDir site-config --minify`);
  }
  return false;
}

const pathOf = (req) => decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

/** Starts a static server over `public/` and returns { origin, release, close }.
 *  `hold` is a RegExp matched against the request path: those requests are PARKED --
 *  the connection stays open and nothing is sent -- until `release()` answers them and
 *  stops holding. A page that only misbehaves while a slow file is in flight is then
 *  held in that window for as long as the test wants, rather than raced against a
 *  sleep that is right on this box and wrong on a loaded one. `fail` and `drop` are
 *  RegExps matched the same way, for a test about a page whose own files fail: `fail`
 *  answers 404, as a file missing from the build would, and `drop` hangs up without
 *  answering, which the browser records as no response at all. `files` maps a request path to a body
 *  served INSTEAD of `public/`: a string (HTML) or { body, type, status }, for a page or script the build lacks. */
export async function startSiteServer({ hold = null, fail = null, drop = null, files = {} } = {}) {
  const port = await freePort();
  let holding = hold;
  const parked = [];
  const serve = (req, res) => {
    const own = files[pathOf(req)];
    if (own !== undefined) {
      const f = typeof own === 'string' ? { body: own } : own;
      res.writeHead(f.status ?? 200, { 'content-type': f.type ?? TYPES['.html'] }).end(f.body ?? ''); return;
    }
    // Strip the query and normalise, then keep the result inside PUBLIC_DIR.
    let file = path.normalize(path.join(PUBLIC_DIR, pathOf(req)));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end(); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!existsSync(file)) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  };
  const server = http.createServer((req, res) => {
    const at = pathOf(req);
    if (drop && drop.test(at)) { req.socket.destroy(); return; }
    if (fail && fail.test(at)) { res.writeHead(404).end('not found'); return; }
    if (holding && holding.test(at)) { parked.push([req, res]); return; }
    serve(req, res);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  // A test file starts this BEFORE it launches a browser; a launch that throws never
  // reaches the `finally` that closes it, and a listening server holds the process open
  // until the 600 s --test-timeout (PR CI job 108940330679). An unref'd server does not:
  // a running test still has its browser's pipes and socket keeping the loop alive.
  server.unref();
  return {
    origin: `http://127.0.0.1:${port}`,
    release: () => { holding = null; for (const [q, s] of parked.splice(0)) serve(q, s); },
    // A parked request owns a socket, and `server.close` waits on every open one --
    // so the sockets go first or teardown never returns.
    close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  };
}
