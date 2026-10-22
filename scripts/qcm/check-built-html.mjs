// Structural check of the BUILT site (public/) behind `npm run test:html`.
//
// htmltest (the link/asset gate PR CI and deploy run) parses leniently: on 2026-09-30 a
// page with an unclosed <div>, and an empty public/, both passed it. This is the half it
// does not do, and it can fail:
//
//   - the build directory exists and holds HTML (an empty build is a failure, not "0 ok"),
//   - every page the site is meant to have is there (menus.toml + data/systems.json),
//   - every page tokenizes cleanly (parse5: unterminated tags, duplicate attributes, no
//     doctype, ...),
//   - every page's elements nest (htmlparser2: unclosed elements, stray end tags), allowing
//     exactly the end tags the HTML spec lets a page omit, because Hugo's minifier drops them.
//
// Usage: node scripts/qcm/check-built-html.mjs [--dir public] [--expect /about/ ...]
//   With no --expect the expected pages are derived from the repo (defaultExpectedPages).
// Exit 0 = every check passed; 1 = at least one failed (each printed as `file: reason`).
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';
import { Parser } from 'htmlparser2';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Elements whose end tag the HTML spec lets a document omit ("optional tags"). Anything
// else still open when its parent closes, or at end of file, is a real unclosed element.
const OPTIONAL_END = new Set([
  'html', 'head', 'body', 'li', 'dt', 'dd', 'p', 'rb', 'rt', 'rtc', 'rp', 'optgroup',
  'option', 'colgroup', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
]);
const VOID = new Set([
  'area', 'base', 'basefont', 'br', 'col', 'command', 'embed', 'frame', 'hr', 'image', 'img',
  'input', 'isindex', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** Site URL -> the file Hugo writes for it, relative to the build dir. */
export function pageFile(url) {
  const path = url.replace(/^\//, '');
  if (path === '') return 'index.html';
  return path.endsWith('/') ? `${path}index.html` : path;
}

/** Pages the built site must contain, read from the repo's own sources so a new nav slot
 *  or roster entry is gated with no edit here: the home page, the 404, every menus.toml
 *  url, /privacy/ (the footer links it on every page) and every internal systems.json link. */
export function defaultExpectedPages(root = REPO) {
  const pages = new Set(['/', '/404.html', '/privacy/']);
  const menus = readFileSync(join(root, 'site-config', '_default', 'menus.toml'), 'utf8');
  for (const m of menus.matchAll(/^\s*url\s*=\s*"(\/[^"]*)"/gm)) pages.add(m[1]);
  const systems = JSON.parse(readFileSync(join(root, 'data', 'systems.json'), 'utf8'));
  const entries = Array.isArray(systems) ? systems : Object.values(systems).flat();
  for (const s of entries) {
    if (s && typeof s.link === 'string' && s.link.startsWith('/') && !s.link.startsWith('//')) {
      pages.add(s.link.split('#')[0]);
    }
  }
  return [...pages];
}

/** Every problem in one HTML document, as short strings. Empty array = clean. */
export function checkHtml(html) {
  const problems = [];

  // Tokenizer-level: parse5 reports the spec's parse errors it can see (eof-in-tag,
  // duplicate-attribute, missing-doctype, ...). The built site has none, so any is a break.
  parse(html, {
    onParseError: (e) => problems.push(`parse error ${e.code} (line ${e.startLine})`),
  });

  // Tree-level: parse5 does not report unclosed or stray elements, so mirror the open
  // elements with htmlparser2 and judge each explicit end tag and the end of file.
  const stack = [];
  const handlers = {
    onopentag(name) {
      if (!VOID.has(name)) stack.push(name);
    },
    onclosetag(name) {
      if (!VOID.has(name)) stack.pop();
    },
  };
  const parser = new Parser(handlers);
  // htmlparser2 swallows an end tag that matches nothing open, so look at each explicit
  // end tag first. The Tokenizer calls back into the parser object, so an own-property
  // override sees every end tag. scripts/qcm/check-built-html.test.mjs pins this: the
  // stray-end-tag case fails if an htmlparser2 upgrade moves these internals.
  const realClose = parser.onclosetag.bind(parser);
  parser.onclosetag = (start, end) => {
    const name = parser.getSlice(start, end).toLowerCase();
    const at = stack.lastIndexOf(name);
    if (at === -1) {
      problems.push(`stray </${name}> with no open <${name}> (line ${lineOf(html, parser.startIndex)})`);
    } else {
      for (const open of stack.slice(at + 1)) {
        if (!OPTIONAL_END.has(open)) problems.push(`unclosed <${open}> before </${name}> (line ${lineOf(html, parser.startIndex)})`);
      }
    }
    realClose(start, end);
  };
  // At end of file htmlparser2 closes everything still open BEFORE it fires onend, so the
  // stack is inspected in front of it, the same way as the end tags above.
  const realEnd = parser.onend.bind(parser);
  parser.onend = () => {
    for (const name of stack) {
      if (!OPTIONAL_END.has(name)) problems.push(`unclosed <${name}> at end of file`);
    }
    realEnd();
  };
  parser.write(html);
  parser.end();
  return problems;
}

function lineOf(html, index) {
  let line = 1;
  for (let i = 0; i < index && i < html.length; i++) if (html.charCodeAt(i) === 10) line++;
  return line;
}

function htmlFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...htmlFiles(p));
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

/** The HTML files of a build directory, or why there are none to check (check-github-links.mjs
 * reads the same build). Returns {files: [path], problem: 'reason' | undefined}. */
export function builtPages(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { files: [], problem: `${dir}: build directory does not exist - build the site first (bash scripts/build-site.sh --configDir site-config --minify)` };
  }
  const files = htmlFiles(dir);
  if (files.length === 0) {
    return { files, problem: `${dir}: build output has no HTML files - an empty build is a failure, not a pass` };
  }
  return { files };
}

/** Run every check on a build directory. Returns {problems: ['file: reason'], pages: n}. */
export function checkBuild(dir, expected) {
  const { files, problem } = builtPages(dir);
  if (problem) return { pages: 0, problems: [problem] };
  const problems = [];
  for (const url of expected) {
    if (!existsSync(join(dir, pageFile(url)))) problems.push(`${dir}: missing expected page ${url} (${pageFile(url)})`);
  }
  for (const f of files) {
    for (const p of checkHtml(readFileSync(f, 'utf8'))) problems.push(`${relative(dir, f)}: ${p}`);
  }
  return { pages: files.length, problems };
}

function main(argv) {
  let dir = 'public';
  const expected = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') dir = argv[++i];
    else if (argv[i] === '--expect') expected.push(argv[++i]);
    else {
      console.error(`unknown argument ${argv[i]}\nusage: check-built-html.mjs [--dir public] [--expect /url/ ...]`);
      return 2;
    }
  }
  const { problems, pages } = checkBuild(dir, expected.length ? expected : defaultExpectedPages());
  for (const p of problems) console.error(p);
  if (problems.length) {
    console.error(`FAIL: ${problems.length} problem(s) across ${pages} page(s) in ${dir}`);
    return 1;
  }
  console.log(`ok: ${pages} pages in ${dir} tokenize and nest cleanly, all expected pages present`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
