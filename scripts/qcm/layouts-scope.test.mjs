// helpers/layouts.mjs hands five markup gates (legend, legend-view, page-controls,
// layer-registry, tonight-strip) "the markup the Field Maps page renders". It used to
// concatenate EVERY theme layout, so the homepage template (index.html) was part of the
// app's own markup: a homepage edit could move an app gate, and CI had to run the whole
// Field Maps suite for it. The set is now derived, not listed: the quiet-corners layouts
// then the shortcodes their pages invoke, then every partial those call, transitively. The
// shared shell (baseof and its head/header/footer) is site chrome and stays out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appLayoutFiles, layoutMarkup, partialRefs } from './helpers/layouts.mjs';

const LAYOUTS = new URL('../../themes/headlessmode/layouts/', import.meta.url);
const SITE_LAYOUTS = new URL('../../layouts/', import.meta.url);
const CONTENT = new URL('../../content/', import.meta.url);
const rel = (abs) => abs.slice(abs.indexOf('layouts/') + 'layouts/'.length);

test('partialRefs reads partial and partialCached calls, and ignores Hugo comments', () => {
  const src = `{{ partial "a.html" . }}{{- partialCached "b/c.html" . "k" -}}
    {{/* partial "commented.html" . */}}{{ partial "d" . }}`;
  assert.deepEqual(partialRefs(src), ['a.html', 'b/c.html', 'd.html']);
});

test('the app set is the quiet-corners layouts, never the homepage or the shared shell', () => {
  const names = appLayoutFiles().map(rel);
  for (const must of ['_default/quiet-corners-dashboard.html', '_default/quiet-corners-maps.html']) {
    assert.ok(names.includes(must), `${must} is missing from the app layout set`);
  }
  assert.ok(!names.includes('index.html'), 'index.html is the homepage, not part of the app');
  for (const other of ['_default/baseof.html', 'partials/head.html', 'partials/header.html', 'partials/footer.html',
    'partials/jsonld.html', '_default/single.html', '_default/list.html', '_default/about.html', '404.html',
    '_default/redactcam-demo.html', '_default/sun-track-demo.html']) {
    assert.ok(!names.includes(other), `${other} renders no Field Maps page`);
  }
});

test('every partial the app layouts reference, transitively, is in the set (and exists)', () => {
  // Independent derivation: a plain fixpoint over the files, not the helper's own walk.
  const read = (p) => readFileSync(new URL(p, LAYOUTS), 'utf8');
  const roots = readdirSync(new URL('_default/', LAYOUTS)).filter((n) => /^quiet-corners-.*\.html$/.test(n))
    .map((n) => `_default/${n}`);
  // Shortcodes the quiet-corners pages' own prose invokes ({{< name >}}), from either layouts root.
  const shortcodes = new Set();
  for (const page of readdirSync(CONTENT).filter((n) => /^quiet-corners.*\.md$/.test(n))) {
    for (const m of readFileSync(new URL(page, CONTENT), 'utf8').matchAll(/\{\{[<%]\s*([A-Za-z0-9_-]+)/g)) shortcodes.add(m[1]);
  }
  assert.ok(shortcodes.has('qcm-coverage'), 'fixture assumption: the maps page invokes the coverage shortcode');
  const want = new Set(roots);
  const queue = [...roots];
  for (const name of shortcodes) {
    const home = [LAYOUTS, SITE_LAYOUTS].find((d) => readdirSync(new URL('shortcodes/', d)).includes(`${name}.html`));
    if (!home) continue; // a built-in shortcode (figure, ref, ...) has no template here
    const file = `shortcodes/${name}.html`;
    want.add(home === LAYOUTS ? file : `SITE:${file}`);
    queue.push(home === LAYOUTS ? file : `SITE:${file}`);
  }
  const readAny = (p) => (p.startsWith('SITE:') ? readFileSync(new URL(p.slice(5), SITE_LAYOUTS), 'utf8') : read(p));
  while (queue.length) {
    const text = readAny(queue.pop()).replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, '');
    for (const m of text.matchAll(/partial(?:Cached)?\s+"([^"]+)"/g)) {
      const p = `partials/${m[1].endsWith('.html') ? m[1] : `${m[1]}.html`}`;
      assert.ok(readdirSync(new URL('partials/', LAYOUTS)).includes(p.slice('partials/'.length)), `${p} is called but does not exist`);
      if (!want.has(p)) { want.add(p); queue.push(p); }
    }
  }
  const got = appLayoutFiles().map((abs) => (abs.startsWith(fileURLToPath(SITE_LAYOUTS)) ? `SITE:${rel(abs)}` : rel(abs)));
  assert.deepEqual(got.sort(), [...want].sort());
  assert.ok(want.has('partials/qcm-coverage.html'), 'a partial reached only through a shortcode is still the app\'s');
  assert.ok(want.has('partials/qcm-controls.html') && want.has('partials/qcm-map-layers.html'), 'the two app partials are reached');
});

test('layoutMarkup carries the app markup and none of the homepage', () => {
  const markup = layoutMarkup();
  assert.ok(markup.includes('id="qcm-layers"') && markup.includes('id="qcm-legend"'), 'the app hosts are in the markup');
  const home = readFileSync(new URL('index.html', LAYOUTS), 'utf8');
  assert.ok(home.includes('id="software"'), 'fixture assumption: the homepage owns #software');
  assert.ok(!markup.includes('id="software"'), 'the homepage template leaked into the app markup');
  assert.ok(!markup.includes(home.trim()), 'the homepage template leaked into the app markup');
});
