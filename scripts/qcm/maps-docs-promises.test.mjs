// The Field Maps product page (content/quiet-corners-maps.md) may only say what the built UI does.
// QQA-11: the page once repeated a paragraph, named controls that are not on the screen, and
// described a text-size setting without saying where it works. Three offline checks hold that.
//
// Needs the build: `bash scripts/build-site.sh --configDir site-config --minify`. Without
// public/quiet-corners/index.html, public/quiet-corners/maps/index.html and public/js the
// built-page tests skip with that reason; the synthetic self-tests below always run.
//
//  (a) No paragraph appears twice (whitespace and case normalised) -- in the source doc or in
//      the built docs page.
//  (b) Every UI label the doc names is on the screen. A "label" is a span that is
//        - bold (**x**) or in double quotes ("x" or curly), and
//        - 1-5 words, at most 45 characters, starting with a capital letter or a digit,
//        - with no sentence punctuation inside (. ? ! ; : followed by a space), and
//        - for bold spans only: not ending in . ? ! (that is a Q&A heading or an emphasised
//          sentence, not a label).
//      It must EQUAL one whole piece of on-screen text (case, curly quotes, entities and
//      whitespace folded; one trailing . , ; : dropped): an element's text, an aria-label /
//      title / placeholder / alt / value attribute of the built dashboard page, or a whole
//      string literal in a shipped script under public/js/ (the panel is mostly built in
//      script). A substring of a longer string does not count, so "Edit" or "Close" cannot pass
//      on the strength of a variable name or a sentence that contains them. Not checked: the Sources section and the Source decision record
//      (they name outside services, not this UI), fenced code, and labels longer than five
//      words (a longer span is more likely emphasis than a button name). Retired labels that
//      were once invented are also pinned by name (RETIRED below).
//  (c) Label size. The docs may promise that Large / Extra large enlarge names on the flat
//      (2D) map only if the built 2D path honours the setting: a script writes
//      --qc-label-px and the stylesheet's .qc-place-label reads it. When it does, the doc must
//      say so (2D named in the Map label size paragraph); when it does not, the doc must not.
//  (d) Where a control lives. The doc says the label size and crowding selects sit under
//      Map appearance > Map labels; the built dashboard must nest them that way.
//  (e) The 3D exaggeration checkbox. Its visible label states the exaggeration once the box is
//      ticked and goes back when it is cleared (terrain-view.js exaggerationLabelText); the doc
//      must quote both labels exactly and say the label changes.
//  (f) Reset and presets, read from the source: "Map only" must name every layer it leaves on
//      (layer-presets.js presetLeavesAlone); Reset's Enabled rule must match the places that set
//      state.dirty (main.js), and the doc must name Clear highlight / Reset light as the way back
//      for what Reset cannot see.
//  (g) The 3D "Layers in this view" list: the doc may not say it names every layer that is on
//      while the registry skips whole groups (terrain-overlays.js capabilityNotices).
//  (h) The Map labels hint says what the two selects govern: names, not only "place names".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { PRESETS, presetLeavesAlone } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-presets.js';
import { LAYERS_WITH_DRAPE } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';
import { capabilityNotices } from '../../themes/headlessmode/static/js/quiet-corners-maps/terrain-overlays.js';
import { exaggerationLabelText, MAX_EXAGGERATION } from '../../themes/headlessmode/static/js/quiet-corners-maps/terrain-view.js';

const root = new URL('../../', import.meta.url);
const DOC = new URL('content/quiet-corners-maps.md', root);
const DASH = new URL('public/quiet-corners/index.html', root);
const BUILT_DOC = new URL('public/quiet-corners/maps/index.html', root);
const JS_DIR = new URL('public/js/', root);
const SRC_JS = new URL('themes/headlessmode/static/js/quiet-corners-maps/', root);
const CSS_DIR = new URL('public/css/', root);

const have = existsSync(DASH) && existsSync(BUILT_DOC) && existsSync(JS_DIR);
const skip = have ? false : 'no built public/quiet-corners/{,maps/}index.html or public/js (run scripts/build-site.sh)';

const fold = (s) => s
  .replace(/&amp;/g, '&').replace(/&middot;/g, '·').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'")
  .replace(/&hellip;/g, '…').replace(/&nbsp;/g, ' ')
  .replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').toLowerCase().trim();
const walk = (dir, ext) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
  return e.isDirectory() ? walk(p, ext) : e.name.endsWith(ext) ? [p] : [];
});

/** Block comments and whole-line // comments out: a label named only in a comment is not on screen. */
export const stripJsComments = (js) => js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The doc body: front matter, the Sources section, the Source decision record and fenced code removed. */
export function docBody(md) {
  let body = md.replace(/^---\n[\s\S]*?\n---\n/, '');
  body = body.replace(/^## Sources\b[\s\S]*?(?=^## )/m, '');
  body = body.replace(/^### Source decision record\b[\s\S]*?(?=^### )/m, '');
  body = body.replace(/^```[\s\S]*?^```/gm, '');
  return body;
}

/** Paragraph-like blocks (prose paragraphs and list items), normalised; short ones ignored. */
export function paragraphs(text, minChars = 60) {
  return text.split(/\n\s*\n/).flatMap((blk) => blk.split(/\n(?=[-*] )/))
    .map((b) => b.trim()).filter((b) => b && !/^(#|\||\{\{|<)/.test(b))
    .map((b) => fold(b.replace(/^[-*]\s+/, '').replace(/\*+/g, ''))).filter((b) => b.length >= minChars);
}
export function duplicates(list) {
  const seen = new Set(), dup = new Set();
  for (const p of list) (seen.has(p) ? dup : seen).add(p);
  return [...dup];
}

/** UI-label candidates per the narrow rule in the header. */
export function labelCandidates(body) {
  const out = new Map();
  const ok = (t, bold) => {
    const s = t.trim();
    if (!s || s.length > 45 || s.split(/\s+/).length > 5 || !/^[A-Z0-9]/.test(s)) return false;
    if (/[.?!;:]\s/.test(s)) return false;
    return !(bold && /[.?!]$/.test(s));
  };
  for (const m of body.matchAll(/\*\*([^*\n]{2,80}?)\*\*/g)) if (ok(m[1], true)) out.set(m[1].trim(), 'bold');
  for (const m of body.matchAll(/[“"]([^”"\n]{2,60}?)[”"]/g)) if (ok(m[1], false)) out.set(m[1].trim(), 'quoted');
  return out;
}
const dropEnd = (s) => fold(s).replace(/[.,;:]+$/, '').trim();
/** True when `label` equals one whole on-screen string in `atoms` (a Set from htmlAtoms/jsAtoms). */
export const inCorpus = (label, atoms) => atoms.has(dropEnd(label));

/** Whole pieces of on-screen text in built HTML: element text and the labelling attributes. */
export function htmlAtoms(html) {
  const out = new Set();
  const add = (t) => { const k = dropEnd(t.replace(/\s+/g, ' ')); if (k) out.add(k); };
  for (const m of html.matchAll(/>([^<>]+)</g)) add(m[1]);
  for (const m of html.matchAll(/\b(?:aria-label|title|placeholder|alt|value)=(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/g)) add(m[1] ?? m[2] ?? m[3]);
  return out;
}
/** Whole string literals in script (comments out), with escapes undone; a template literal is
 *  also taken in its static pieces between ${...} holes. */
export function jsAtoms(js) {
  const out = new Set();
  const un = (t) => t.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\n/g, ' ').replace(/\\(.)/g, '$1');
  const add = (t) => { const k = dropEnd(un(t)); if (k) out.add(k); };
  for (const m of stripJsComments(js).matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
    if (m[3] !== undefined) { add(m[3]); for (const piece of m[3].split(/\$\{[^}]*\}/)) add(piece); } else add(m[1] ?? m[2]);
  }
  return out;
}

const RETIRED = [
  ['Names not shown on the map', 'no such control; the list is "Places in this view"'],
  ['county finder', 'the map has one finder, "Search places"'],
];

const docMd = readFileSync(DOC, 'utf8');
const body = docBody(docMd);

// ---- (a) --------------------------------------------------------------------------------
test('(a) self-test: the duplicate detector catches a repeated paragraph', () => {
  const p = 'Text on the map itself is sized to be read outdoors on a phone, and wraps rather than shrinking.';
  const doc = `## A\n\n${p}\n\nSomething else entirely that is long enough to count as a paragraph here.\n\n${p.replace(/ /g, '  ').toUpperCase()}\n`;
  assert.equal(duplicates(paragraphs(doc)).length, 1);
  assert.equal(duplicates(paragraphs(`${p}\n\nA different paragraph that is also long enough to be counted.`)).length, 0);
});

test('(a) no paragraph appears twice in content/quiet-corners-maps.md', () => {
  const dups = duplicates(paragraphs(body));
  assert.deepEqual(dups.map((d) => d.slice(0, 90)), [], 'a paragraph appears twice in the doc source');
});

test('(a) no paragraph appears twice on the built docs page', { skip }, () => {
  const html = readFileSync(BUILT_DOC, 'utf8');
  const ps = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((m) => fold(m[1].replace(/<[^>]+>/g, ''))).filter((t) => t.length >= 60);
  assert.deepEqual(duplicates(ps).map((d) => d.slice(0, 90)), [], 'a paragraph appears twice on the built page');
});

// ---- (b) --------------------------------------------------------------------------------
test('(b) self-test: the label rule keeps button names and skips prose and headings', () => {
  const c = labelCandidates('Press **Reset** or "Search places". **Nothing downloads at the end.** **A wetland edge is approximate by construction** and **it is** fine, "No named terrain found in this area" ok.');
  assert.deepEqual([...c.keys()].sort(), ['Reset', 'Search places']);
  assert.ok(inCorpus('Search places.', htmlAtoms('<button>Search places</button>')));
  assert.ok(!inCorpus('County finder', htmlAtoms('<button>Search places</button>')));
});

test('(b) self-test: a label must equal a whole string, not sit inside a longer one', () => {
  const html = '<p>Press Edit later</p><button aria-label="Reset view">x</button><label>Map label size <select></select></label>';
  const js = "const a = 'Close the dialog'; const b = `Remove ${n} item`; el.textContent = 'Undo';\n// 'Hidden'";
  const atoms = new Set([...htmlAtoms(html), ...jsAtoms(js)]);
  for (const ok of ['Reset view', 'Map label size', 'Undo', 'Remove']) assert.ok(inCorpus(ok, atoms), ok);
  for (const bad of ['Edit', 'Close', 'Hidden', 'Items']) assert.ok(!inCorpus(bad, atoms), bad);
});

test('(b) every bold or quoted UI label in the doc is on the built screen', { skip }, () => {
  const corpus = new Set([...htmlAtoms(readFileSync(DASH, 'utf8')), ...walk(JS_DIR, '.js').flatMap((f) => [...jsAtoms(readFileSync(f, 'utf8'))])]);
  const missing = [...labelCandidates(body)].filter(([label]) => !inCorpus(label, corpus)).map(([l, k]) => `${k}: ${l}`);
  assert.deepEqual(missing, [], 'the doc names a label the built UI does not show');
});

test('(b) labels once invented are not back', () => {
  for (const [needle, why] of RETIRED) assert.ok(!fold(body).includes(fold(needle)), `"${needle}" is back: ${why}`);
});

// ---- (c) --------------------------------------------------------------------------------
test('(c) the doc promises 2D name enlargement exactly when the built 2D path honours the size setting', { skip }, () => {
  const js = stripJsComments(walk(JS_DIR, '.js').map((f) => readFileSync(f, 'utf8')).join('\n'));
  const css = walk(CSS_DIR, '.css').map((f) => readFileSync(f, 'utf8')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const writes = /setProperty\(\s*['"]--qc-label-px['"]/.test(js);
  const reads = /\.qc-place-label\b[^{}]*\{[^{}]*font-size:\s*var\(--qc-label-px/.test(css);
  const honours2d = writes && reads;
  // The block(s) that explain the size control: they name **Map label size** and the Large step.
  const paras = body.split(/\n\s*\n/).filter((p) => p.includes('**Map label size**') && /Large/.test(p));
  assert.ok(paras.length, 'the doc has no paragraph that explains **Map label size** and its Large step');
  const says2d = paras.some((p) => /\b2D\b|flat map/.test(p));
  assert.equal(says2d, honours2d, honours2d
    ? 'the built 2D map enlarges names with the size setting (script writes --qc-label-px, .qc-place-label reads it) but the doc paragraph on Map label size never says it works on the 2D map'
    : 'the doc promises 2D enlargement but the built 2D path ignores the size setting');
});

// ---- helpers for (d)-(g) ----------------------------------------------------------------
/** The doc's blocks (paragraphs and list items), whitespace folded but case kept. */
const blocks = body.split(/\n\s*\n/).flatMap((b) => b.split(/\n(?=[-*] )/)).map((b) => b.trim().replace(/\s+/g, ' ')).filter(Boolean);
const blocksWith = (needle) => blocks.filter((b) => b.includes(needle));

// ---- (d) --------------------------------------------------------------------------------
test('(d) the label size and crowding selects sit under Map appearance > Map labels in the built page', { skip }, () => {
  assert.ok(blocksWith('**Map appearance**').some((b) => b.includes('**Map labels**')),
    'the doc no longer says where the label controls live (Map appearance > Map labels)');
  const html = readFileSync(DASH, 'utf8');
  const open = html.search(/<summary[^>]*>\s*Map appearance\s*<\/summary>/);
  assert.ok(open >= 0, 'the built page has no "Map appearance" disclosure');
  const section = html.slice(open, html.indexOf('</details>', open));
  const fs = section.search(/<legend[^>]*>\s*Map labels\s*<\/legend>/);
  assert.ok(fs >= 0, '"Map labels" is not a group inside the Map appearance disclosure');
  const group = section.slice(fs, section.indexOf('</fieldset>', fs));
  for (const label of ['Map label size', 'Map label crowding']) {
    assert.match(group, new RegExp('<label[^>]*>\\s*' + label + '\\s*<select'), `${label} is not a select inside Map labels`);
  }
});

// ---- (e) --------------------------------------------------------------------------------
test('(e) the doc quotes both labels of the 3D exaggeration checkbox and says the label changes', () => {
  const tv = stripJsComments(readFileSync(new URL('terrain-view.js', SRC_JS), 'utf8'));
  // The visible label is written only through exaggerationLabelText, from the checkbox's change handler.
  assert.ok(/\.textContent\s*=\s*exaggerationLabelText\(/.test(tv), 'terrain-view.js no longer sets the exaggeration label through exaggerationLabelText');
  assert.ok(/addEventListener\('change',[\s\S]{0,200}exaggerationLabelText\(toggle\.checked\)/.test(tv), 'the exaggeration change handler no longer rewrites the label; update the doc and this test');
  const off = exaggerationLabelText(false), on = exaggerationLabelText(true);
  assert.notEqual(on, off, 'the label does not change when the box is ticked');
  const para = blocksWith(`Exaggerated terrain (${MAX_EXAGGERATION}×)`);
  assert.equal(para.length, 1, `the doc must have exactly one block that names the checkbox as **Exaggerated terrain (${MAX_EXAGGERATION}×)**`);
  assert.ok(fold(para[0]).includes(fold(off)), `the doc must quote the unticked label exactly: ${off}`);
  assert.ok(fold(para[0]).includes(fold(on)), `the doc must quote the ticked label exactly: ${on}`);
  assert.match(para[0], /untick|clear/i, 'the doc must say the label goes back when the box is unticked');
  assert.ok(!/does not change|nothing else in the panel|always/i.test(para[0]), 'the doc says the label is fixed; it changes when the box is ticked');
});

// ---- (f) --------------------------------------------------------------------------------
test('(f) the Map only line names every layer that preset leaves on', () => {
  const preset = PRESETS.find((p) => p.label === 'Map only');
  assert.ok(preset, 'there is no preset labelled Map only');
  const left = LAYERS_WITH_DRAPE.filter((l) => !l.required && presetLeavesAlone(l, preset)).map((l) => l.label);
  assert.ok(left.length, 'expected Map only to leave the lettering layers on');
  const line = blocks.filter((b) => b.startsWith('- **Map only**'));
  assert.equal(line.length, 1, 'the doc must have one list item that starts - **Map only**');
  for (const label of left) assert.ok(line[0].includes(label), `Map only leaves "${label}" on but the doc line does not say so`);
  assert.ok(!/every overlay off/i.test(line[0]) || /\bexcept\b/.test(line[0]), 'Map only is not "every overlay off" without an exception');
});

test('(f) the doc names preset buttons the way the UI does', () => {
  for (const p of PRESETS) assert.ok(blocks.some((b) => b.startsWith(`- **${p.label}**`)), `the doc has no list item for the preset "${p.label}"`);
});

test('(f) Reset enables only on the changes main.js marks dirty, and the doc says so and names the way back', () => {
  const main = stripJsComments(readFileSync(new URL('main.js', SRC_JS), 'utf8'));
  const sites = [...main.matchAll(/state\.dirty\s*=\s*true/g)].length;
  // Known sites: a layer / base-map / context-surface input changed by hand, and a preset that moved something.
  assert.equal(sites, 2, 'state.dirty is set in a different number of places; re-read what enables Reset, then update the doc and this count');
  assert.ok(!/qcm-highlight[^\n]*\n(?:[^\n]*\n){0,12}[^\n]*state\.dirty\s*=\s*true/.test(main), 'a highlight handler now sets dirty; update the doc and this test');
  const reset = blocks.filter((b) => /\bReset\b/.test(b) && /enabled|enables|disabled/.test(b) && b.includes('**Reset**'));
  assert.equal(reset.length, 1, 'the doc must have one block that says when **Reset** is enabled');
  for (const need of [/layer/i, /base map/i, /context surface/i, /preset/i, /\*\*Clear highlight\*\*/, /\*\*Reset light\*\*/])
    assert.match(reset[0], need, 'the Reset block does not cover ' + need);
  assert.ok(!/disabled until something has changed/i.test(reset[0]), 'Reset is not enabled by every change');
});

// ---- (g) --------------------------------------------------------------------------------
test('(g) the doc does not say the 3D list names every layer that is on', () => {
  const allOn = Object.fromEntries(LAYERS_WITH_DRAPE.map((l) => [l.id, true]));
  const listed = new Set(capabilityNotices(LAYERS_WITH_DRAPE, allOn).map((n) => n.id));
  const skipped = LAYERS_WITH_DRAPE.filter((l) => !listed.has(l.id));
  assert.ok(skipped.length, 'expected the list to skip some layers (cameras, reading rows, extra sheets, the base map)');
  const para = blocksWith('**Layers in this view**');
  assert.equal(para.length, 1, 'the doc must have one block naming **Layers in this view**');
  assert.ok(!/\b(?:each|every|all)(?: of the)? layers?\b|each layer you have on/i.test(para[0]), 'the list skips ' + skipped.map((l) => l.id).join(', ') + '; the doc must not say it names every layer');
  assert.ok(/Available in 2D/.test(para[0]), 'the doc must say which layers the list marks Available in 2D');
  // Road names are listed as drawn while the 3D panel draws no road names; the doc must say so.
  const roads = LAYERS_WITH_DRAPE.find((l) => l.id === 'roads');
  const roadsListed = listed.has('roads');
  assert.equal(/Road names/.test(para[0]), roadsListed, roadsListed
    ? 'the list shows Road names although 3D draws none; the doc block must say that'
    : 'the list no longer shows Road names; the doc block should not mention them');
  assert.ok(roads, 'the registry has a roads row');
});

test('(g) the doc does not keep camera layers off the 3D view once the registry drapes them', () => {
  const cams = LAYERS_WITH_DRAPE.filter((l) => l.group === 'cameras');
  assert.ok(cams.length, 'the registry has camera layers');
  const allOn = Object.fromEntries(LAYERS_WITH_DRAPE.map((l) => [l.id, true]));
  const listed = new Set(capabilityNotices(LAYERS_WITH_DRAPE, allOn).map((n) => n.id));
  const shown = cams.filter((l) => listed.has(l.id));
  const para = blocksWith('**Layers in this view**');
  assert.equal(para.length, 1, 'the doc must have one block naming **Layers in this view**');
  const flat = /camera layers stay on the flat map/i.test(para[0]);
  const omitted = /leaves out the camera layers/i.test(para[0]);
  assert.ok(!(shown.length && (flat || omitted)), 'the 3D view shows ' + shown.map((l) => l.id).join(', ') + '; the doc must not say camera layers stay on the flat map or are left out of the list');
});

// ---- (h) --------------------------------------------------------------------------------
test('(h) the Map labels hint says names, not place names, in the built page', { skip }, () => {
  const html = readFileSync(DASH, 'utf8');
  const open = html.search(/<legend[^>]*>\s*Map labels\s*<\/legend>/);
  assert.ok(open >= 0, '"Map labels" is not a group on the built page');
  const group = html.slice(open, html.indexOf('</fieldset>', open));
  const hint = group.match(/<p[^>]*class=["']?qcm-hint["']?[^>]*>([\s\S]*?)<\/p>/);
  assert.ok(hint, 'the Map labels group has no hint');
  const text = fold(hint[1].replace(/<[^>]+>/g, ''));
  assert.match(text, /how large names print/, 'the hint must say it sizes names');
  assert.ok(!/place names/.test(text), 'the hint still says place names; the setting also sizes road and trail names');
});
