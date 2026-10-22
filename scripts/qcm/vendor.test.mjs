import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_PATH = path.join(
  __dirname,
  '..',
  '..',
  'themes',
  'headlessmode',
  'static',
  'vendor',
  'pdf-lib.min.js',
);

const PINNED_SHA256 =
  '0f9a5cad07941f0826586c94e089d89b918c46e5c17cf2d5a3c6f666e3bc694f';

test('vendored pdf-lib.min.js matches the pinned sha256', () => {
  const bytes = readFileSync(VENDOR_PATH);
  const actual = createHash('sha256').update(bytes).digest('hex');
  assert.equal(actual, PINNED_SHA256);
});

test('vendored pdf-lib.min.js carries no runtime script-fetch references', () => {
  const contents = readFileSync(VENDOR_PATH, 'utf8');
  assert.equal(contents.includes('importScripts('), false);
  assert.equal(contents.includes('document.createElement("script")'), false);
});

const VENDOR_DIR = path.join(
  __dirname,
  '..',
  '..',
  'themes',
  'headlessmode',
  'static',
  'vendor',
);

// MapLibre GL JS 6.10.0 — vendored from the npm tarball
// (https://registry.npmjs.org/maplibre-gl/-/maplibre-gl-6.10.0.tgz, tarball
// sha256 a609e1ceecb985e9c8919d1282de4d85d09ecb5d1a61a5da963a60591c9e1af6,
// verified against the published SRI hash before copying — see NOTICE).
const MAPLIBRE_PINS = {
  'maplibre-gl.mjs':
    '454e0bbb16c721cfbf952a92ff3e4362130346ed59a5bff56ae5d6fbebb651f7',
  'maplibre-gl-shared.mjs':
    '0996a0ff2ecb2807afc3f053992539ff7fe45c1678a02304b2b33120136f81f3',
  'maplibre-gl-worker.mjs':
    '7d5ebf88ec25a72cc48cc320d374f41d921e5105d2f1fc774d463a4b68164227',
  'maplibre-gl.css':
    '8e2dbbab312dc57656fbb76e9fa5308c75c9d7c7ba5808a7d55bcdb64cc813fa',
};

for (const [name, sha256] of Object.entries(MAPLIBRE_PINS)) {
  test(`vendored ${name} matches the pinned sha256`, () => {
    const bytes = readFileSync(path.join(VENDOR_DIR, name));
    const actual = createHash('sha256').update(bytes).digest('hex');
    assert.equal(actual, sha256);
  });
}

test('vendored maplibre-gl.mjs carries no importScripts( or remote script loading', () => {
  const contents = readFileSync(
    path.join(VENDOR_DIR, 'maplibre-gl.mjs'),
    'utf8',
  );
  assert.equal(contents.includes('importScripts('), false);
  assert.equal(contents.includes('document.createElement("script")'), false);

  // The only `https://` literals in the bundle are attribution/comment
  // strings, never a runtime fetch target: the LICENSE.txt pointer emitted
  // in a header comment, the https://maplibre.org homepage in that same
  // comment, and a WebGL-unsupported warning message that links to a wiki
  // page. Confirmed by grepping the vendored file directly (2026-09-25):
  //   https://github.com/maplibre/maplibre-gl-js/blob/v6.10.0/LICENSE.txt
  //   https://maplibre.org/
  //   https://wiki.openstreetmap.org/wiki/This_map_requires_WebGL
  // Any default glyph/sprite/API endpoint MapLibre may hit at runtime comes
  // from the *style JSON* a consumer supplies, not from this bundle.
  const urls = contents.match(/https:\/\/[a-zA-Z0-9_./%-]*/g) ?? [];
  const unexpected = urls.filter(
    (u) =>
      !u.startsWith('https://github.com/maplibre/maplibre-gl-js/') &&
      !u.startsWith('https://maplibre.org') &&
      !u.startsWith('https://wiki.openstreetmap.org/'),
  );
  assert.deepEqual(unexpected, []);
});

test('the worker and shared modules load same-origin, not from a remote script fetch', () => {
  // maplibre-gl.mjs statically ES-imports "./maplibre-gl-shared.mjs" and
  // resolves the worker file as new URL('./maplibre-gl-worker.mjs',
  // import.meta.url).href, then spawns it with `new Worker(url, {type:
  // "module"})` — both are same-directory, same-origin module loads, never
  // a remote fetch. That is why they must stay siblings of maplibre-gl.mjs
  // in this vendor directory.
  const contents = readFileSync(
    path.join(VENDOR_DIR, 'maplibre-gl.mjs'),
    'utf8',
  );
  assert.equal(contents.includes('from"./maplibre-gl-shared.mjs"'), true);
  assert.equal(contents.includes('maplibre-gl-worker.mjs'), true);
});

test('NOTICE mentions every vendored MapLibre filename', () => {
  const notice = readFileSync(
    path.join(__dirname, '..', '..', 'NOTICE'),
    'utf8',
  );
  for (const name of Object.keys(MAPLIBRE_PINS)) {
    assert.equal(notice.includes(name), true, `NOTICE missing ${name}`);
  }
});

// The repo's package.json declares "type": "module", so a plain require()
// of this .js file would load it as ESM (Node 22's require(esm) support) and
// break the UMD wrapper's CommonJS branch. Compile it explicitly as a
// CommonJS module instead, matching how the vendored UMD build actually
// runs when consumed via require() elsewhere.
const source = readFileSync(VENDOR_PATH, 'utf8');
const wrapped = Module.wrap(source);
const compiled = vm.runInThisContext(wrapped, { filename: VENDOR_PATH });
const cjsModule = { exports: {} };
const cjsRequire = createRequire(VENDOR_PATH);
compiled.call(
  cjsModule.exports,
  cjsModule.exports,
  cjsRequire,
  cjsModule,
  VENDOR_PATH,
  path.dirname(VENDOR_PATH),
);
const { PDFDocument } = cjsModule.exports;

test('pdf-lib builds, saves, reloads, and preserves the attachment', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawText('Field Maps smoke', { x: 72, y: 720, size: 12 });
  page.drawLine({
    start: { x: 72, y: 700 },
    end: { x: 540, y: 700 },
  });
  await doc.attach(new TextEncoder().encode('{"ok":true}'), 'manifest.json', {
    mimeType: 'application/json',
    description: 'build manifest',
  });

  // Object streams would Flate-compress the attachment's filespec dictionary
  // along with everything else small, hiding "manifest.json" from a
  // byte-level check below even though the attachment is intact.
  const bytes = await doc.save({ useObjectStreams: false });

  const header = Buffer.from(bytes.slice(0, 5)).toString('utf8');
  assert.equal(header, '%PDF-');

  const reloaded = await PDFDocument.load(bytes);
  assert.equal(reloaded.getPageCount(), 1);
  const size = reloaded.getPage(0).getSize();
  assert.deepEqual(size, { width: 612, height: 792 });

  const asString = Buffer.from(bytes).toString('latin1');
  assert.equal(asString.includes('manifest.json'), true);
});
