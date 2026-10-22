// The markup the Field Maps page renders, concatenated — what a gate should read when it
// asks "is this control on the page anywhere".
//
// It used to be a hand-written list of two or three filenames per test. Splitting
// the layer switches and the map key out of qcm-controls.html into their own
// partial (audit F04) turned four of those gates red at once, not because the
// markup was wrong but because the list had not been told about a new file. A
// list of files is the same failure the id lists already learned: derive it.
//
// Then it walked EVERY layout in the theme, the homepage template (index.html) included, so a
// homepage edit was an input of five app gates and CI had to run the whole Field Maps suite
// for it. Now the set is the app's own: the quiet-corners layouts, the shortcodes their pages'
// prose invokes, and every partial those call, transitively. The shared shell (baseof.html and
// its head, header and footer partials) is site chrome, not the app's markup: none of these
// gates asks about it, and leaving it out is what lets a head or footer edit skip them. The
// partial names are parsed from `partial "x"` / `partialCached "x"` calls, never listed by
// hand; a call to a partial that does not exist throws, so a rename cannot quietly shrink the set.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LAYOUTS = fileURLToPath(new URL('../../../themes/headlessmode/layouts/', import.meta.url));
const SITE_LAYOUTS = fileURLToPath(new URL('../../../layouts/', import.meta.url));
const CONTENT = fileURLToPath(new URL('../../../content/', import.meta.url));

/** Partial names (as file names under partials/) that `src` calls. Hugo comments are
 *  ignored, so a commented-out call adds nothing. */
export function partialRefs(src) {
  const code = src.replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, '');
  const names = [...code.matchAll(/\bpartial(?:Cached)?\s+"([^"]+)"/g)].map((m) => m[1]);
  return [...new Set(names.map((n) => (n.endsWith('.html') ? n : `${n}.html`)))];
}

/** Shortcode templates the quiet-corners pages' own prose invokes (`{{< name >}}`), found in
 *  either layouts root. A built-in shortcode has no template here and is skipped. */
function pageShortcodes() {
  const names = new Set();
  for (const page of readdirSync(CONTENT).filter((n) => /^quiet-corners.*\.md$/.test(n))) {
    for (const m of readFileSync(join(CONTENT, page), 'utf8').matchAll(/\{\{[<%]\s*([A-Za-z0-9_-]+)/g)) names.add(m[1]);
  }
  return [...names].flatMap((n) => [join(LAYOUTS, 'shortcodes', `${n}.html`), join(SITE_LAYOUTS, 'shortcodes', `${n}.html`)])
    .filter((f) => existsSync(f));
}

/** Absolute paths: the quiet-corners layouts, the shortcodes the quiet-corners pages invoke,
 *  and the partials any of them reach. */
export function appLayoutFiles() {
  const dir = join(LAYOUTS, '_default');
  const roots = readdirSync(dir).filter((n) => /^quiet-corners-.*\.html$/.test(n)).map((n) => join(dir, n));
  const seen = new Set([...roots, ...pageShortcodes()]);
  const queue = [...seen];
  while (queue.length) {
    const file = queue.pop();
    for (const name of partialRefs(readFileSync(file, 'utf8'))) {
      const partial = join(LAYOUTS, 'partials', name);
      if (!existsSync(partial)) throw new Error(`${file} calls partial "${name}", which does not exist under layouts/partials/`);
      if (!seen.has(partial)) { seen.add(partial); queue.push(partial); }
    }
  }
  return [...seen].sort();
}

/** The concatenated markup of the app layouts and partials, sorted so the string is the
 *  same on every machine. */
export function layoutMarkup() {
  return appLayoutFiles().map((f) => readFileSync(f, 'utf8')).join('\n');
}
