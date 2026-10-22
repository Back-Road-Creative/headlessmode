// The invariant: A CLASS THIS SITE PAINTS, THIS SITE WRITES DOWN.
//
// Seven `.qcm-*` families outlived the markup that carried them -- a standalone app
// page's whole frame, the per-state pages, a second-Leaflet fallback -- and nothing
// said so. They were found by hand, twice, by someone reading the file. This is the
// cheapest tell there is: every class token in a hand-written stylesheet here has, so
// far, been dead exactly when its name appears in no template and no script.
//
// Scoped to every hand-written stylesheet in the theme, not to the one file the
// sweep started in. Only quiet-corners-maps.css carries `.qcm-` tokens today, so the
// wider scope costs nothing and buys the one thing a single hard-coded path cannot:
// a second qcm stylesheet cannot appear and be exempt by being new. The Tailwind
// output is excluded because it is generated, and its path is read from the script
// that generates it rather than spelled again here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { classTokens, maskCommentsAndStrings, writesClass } from './helpers/css-class-tokens.mjs';
import { appLayoutFiles } from './helpers/layouts.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CSS_DIR = 'themes/headlessmode/static/css';
// Where a `.qcm-` class can be written down: the layouts the Field Maps pages render (the
// quiet-corners layouts, their shell and the partials they call -- helpers/layouts.mjs
// derives them) and the scripts. The homepage and the other product-page templates are not
// the app's markup, so a `.qcm-` class written only there is dead for the app and is now
// reported as dead; it also means a homepage edit is no input of this check.
const ROOTS = ['<the quiet-corners layouts and partials they call>', 'themes/headlessmode/static/js'];
const PREFIX = 'qcm-';

const generated = path.basename(
  /-o\s+(\S+)/.exec(JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')).scripts['build:css'])[1],
);

const walk = (dir, acc = []) => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc); else acc.push(full);
  }
  return acc;
};

const sources = [...appLayoutFiles(), ...walk(path.join(REPO, 'themes/headlessmode/static/js'))]
  .map((full) => ({ rel: path.relative(REPO, full), text: readFileSync(full, 'utf8') }));

const stylesheets = readdirSync(path.join(REPO, CSS_DIR))
  .filter((name) => name.endsWith('.css') && name !== generated);

/** Names the token, where it is written, where a live one WOULD have been found, and
 *  what to do -- including the one case this check cannot see. A message reading
 *  "unused selector" would send the next reader back to doing this by hand. */
const explain = (rel, token, line, witness) => [
  `${token} is written at ${rel}:${line}, and nowhere an element could pick it up.`,
  '',
  `No file under ${ROOTS.join(', ')} writes it as a whole class-shaped token, so no`,
  'element on any page can carry the class and every rule naming it paints nothing.',
  witness
    ? `Its neighbours do reach: ${witness.token} is written at ${witness.rel}.`
    : 'No token in this stylesheet reaches anything, which usually means a moved directory.',
  '',
  'Delete the rules, or make the name reachable where this check reads:',
  `  a template writes it   class="${token}"`,
  `  a script writes it     el.className = '${token}'`,
  '  the name is built at runtime (`qcm-${...}`) -- this check is textual and cannot',
  '    see that. Write the finished names down as literals in the module that builds',
  `    them, const CLASSES = ['${token}', ...], and the check finds them there.`,
  'There is no ignore list, on purpose: adding one is not the fix.',
  '',
  `An id is not a class -- #${token} and id="${token}" are both ignored deliberately,`,
  'because .qcm-app CLASS rules once dressed every control on these panels while',
  'qcm-app was only ever an id, and every one of them painted nothing.',
].join('\n');

for (const name of stylesheets) {
  const rel = `${CSS_DIR}/${name}`;
  const tokens = classTokens(readFileSync(path.join(REPO, rel), 'utf8'), PREFIX);
  if (tokens.length === 0) continue;

  test(`every ${PREFIX} class in ${name} is written down in a template or a script`, () => {
    const reached = [];
    const dead = [];
    for (const { token, line } of tokens) {
      const where = sources.find((s) => writesClass(s.text, token));
      if (where) reached.push({ token, rel: where.rel }); else dead.push({ token, line });
    }
    assert.deepEqual(
      dead.map((d) => d.token), [],
      dead.map((d) => explain(rel, d.token, d.line, reached[0])).join('\n\n'),
    );
    // A corpus that silently stopped being read would pass this test with an empty
    // stylesheet-shaped shrug, so say out loud that it found live ones too.
    assert.ok(reached.length > 0, `no ${PREFIX} token in ${rel} reached ${ROOTS.join(', ')} at all`);
  });
}

test('the extractor reads selectors, and only selectors', () => {
  const css = `
/* a header naming .qcm-ghost in prose, and an unclosed brace { */
.qcm-real, .qcm-real:hover { content: "}.qcm-instring"; padding: 0.6rem; }
.qcm-attr[data-state="absent"] { opacity: 0.55; }
@media (max-width: 1023px) { .qcm-inmedia { min-height: 14rem; } }
#qcm-notaclass { color: red; }
.other-real { background: url(x.png); }`;
  assert.deepEqual(
    classTokens(css, 'qcm-').map((t) => t.token),
    ['qcm-attr', 'qcm-inmedia', 'qcm-real'],
  );
  assert.equal(classTokens(css, 'qcm-').find((t) => t.token === 'qcm-inmedia').line, 5);
  assert.equal(classTokens(css, 'other-').length, 1);
  // The masking keeps every offset, which is the only reason the line above is right.
  const masked = maskCommentsAndStrings(css);
  assert.equal(masked.length, css.length);
  assert.match(masked, /content: " {14}";/, 'the string body is blanked, brace and all');
  assert.ok(!masked.includes('qcm-ghost') && !masked.includes('qcm-instring'));
});

test('a class is written down; an id and a longer name are not', () => {
  assert.ok(writesClass(`<ul class="qcm-legend">`, 'qcm-legend'));
  assert.ok(writesClass(`box.className = 'qcm-site-card';`, 'qcm-site-card'));
  assert.ok(writesClass(`class="{{ if eq $c "y" }}qcm-cov-yes{{ end }}"`, 'qcm-cov-yes'));
  // The three ways a token can look present and not be.
  assert.ok(!writesClass(`{{ partial "qcm-map-layers.html" . }}`, 'qcm-map'), 'longer name');
  assert.ok(!writesClass(`document.querySelector('#qcm-map')`, 'qcm-map'), 'id selector');
  assert.ok(!writesClass(`<details id="qcm-app" class="qcm-panel">`, 'qcm-app'), 'id attribute');
  assert.ok(writesClass(`<details id="qcm-app" class="qcm-panel">`, 'qcm-panel'), 'class beside an id');
});

test('the sources a class can be written in are the app\'s, not the homepage or other product pages', () => {
  const rels = sources.map((s) => s.rel);
  assert.ok(rels.includes('themes/headlessmode/layouts/_default/quiet-corners-dashboard.html'));
  assert.ok(rels.includes('themes/headlessmode/layouts/partials/qcm-controls.html'));
  for (const other of ['index.html', '_default/single.html', '_default/list.html', '404.html']) {
    assert.ok(!rels.includes(`themes/headlessmode/layouts/${other}`), `${other} is not part of the Field Maps markup`);
  }
});
