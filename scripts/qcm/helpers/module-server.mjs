// A local origin for the browser proof: serves the Field Maps modules, the vendored
// pdf-lib, and synthetic tile/MVUM responses, so the test runs with no network at all.
//
// The modules are served from their real paths under an http:// origin because the
// pipeline needs a same-origin module Worker and an origin-clean canvas — neither
// works from file://, and both are exactly what the product depends on.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const JS_DIR = path.join(ROOT, 'themes', 'headlessmode', 'static', 'js', 'quiet-corners-maps');
const VENDOR = path.join(ROOT, 'themes', 'headlessmode', 'static', 'vendor');

const crc = (() => {
  const t = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  return (buf) => { let c = 0xffffffff; for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
})();

const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};

// Triangle waves in x, y and x+y (periods 71, 97 and 1023 px, all coprime, so the pattern
// does not repeat inside a sheet). Piecewise linear rather than blocky: ~2.5 grey levels of
// change per pixel of misregistration, with no step edge for JPEG to ring at.
const tri = (v, p) => { const m = ((v % p) + p) % p, half = p / 2; return 255 * (m < half ? m / half : 2 - m / half); };

/** A real 256x256 8-bit GREYSCALE PNG whose value is a function of the tile's position in
 *  the global tile pixel grid. The proof is about placement, the worker and PDF assembly,
 *  not about tile content — so a synthetic tile keeps a binary USGS capture (and its
 *  licensing) out of the repo. It is patterned rather than flat because the seam test
 *  (U-Q2) compares the overlap strips of two sheets: on a flat fixture those strips match
 *  no matter where the renderer put them, and the test would prove nothing. Greyscale so
 *  JPEG's chroma subsampling has nothing to lose. */
export function tilePng(tileX, tileY, size = 256) {
  const raw = Buffer.alloc(size * (size + 1));
  const gx0 = tileX * size, gy0 = tileY * size;
  for (let y = 0; y < size; y++) {
    const row = y * (size + 1), gy = gy0 + y, ty = tri(gy, 97);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) raw[row + 1 + x] = Math.round((tri(gx0 + x, 71) + ty + tri(gx0 + x + gy, 1023)) / 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 0; // 8-bit, greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// The proxied path is /tile/<encodeURIComponent(the real .../tile/{z}/{y}/{x} URL)>.
const tileXY = (pathname) => {
  const m = /\/tile\/(\d+)\/(\d+)\/(\d+)$/.exec(decodeURIComponent(pathname));
  return m ? { x: Number(m[3]), y: Number(m[2]) } : { x: 0, y: 0 };
};

const TYPES = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css; charset=utf-8' };

/** Serves /js/<module>, /vendor/<file>, /tile/* (PNG) and /mvum (empty FeatureSet).
 *  `harness` is called with this server's own origin once it is listening, so the page
 *  can import its modules by absolute URL. Returns { origin, close, tileRequests }. */
export async function startModuleServer(harness) {
  const tiles = new Map();
  const tileRequests = [];
  let harnessHtml = '';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*' }); res.end(body); };
    if (url.pathname === '/' ) return send(200, TYPES['.html'], harnessHtml);
    if (url.pathname.startsWith('/tile/')) {
      tileRequests.push(url.pathname);
      const { x, y } = tileXY(url.pathname), key = `${x}/${y}`;
      if (!tiles.has(key)) tiles.set(key, tilePng(x, y));
      return send(200, 'image/png', tiles.get(key));
    }
    if (url.pathname === '/mvum') return send(200, TYPES['.json'], JSON.stringify({ features: [], exceededTransferLimit: false }));
    if (url.pathname === '/mvum/count') return send(200, TYPES['.json'], JSON.stringify({ count: 0 }));
    // Any vendored file, not pdf-lib alone: a proof driving a real map needs Leaflet.
    if (url.pathname.startsWith('/vendor/') || url.pathname.startsWith('/js/')) {
      const file = path.join(url.pathname.startsWith('/js/') ? JS_DIR : VENDOR, path.basename(url.pathname));
      if (!existsSync(file)) return send(404, 'text/plain', `no such file: ${url.pathname}`);
      return send(200, TYPES[path.extname(file)] ?? 'application/octet-stream', readFileSync(file));
    }
    send(404, 'text/plain', 'not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  harnessHtml = typeof harness === 'function' ? harness(origin) : harness;
  return {
    origin,
    tileRequests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
