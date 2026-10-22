// Which column a table is sorted by, said out loud.
//
// The sorted column was marked by ONE thing: `.sort-active`, an accent colour on
// a muted-grey heading row. Colour alone, and silent about direction — a reader
// saw seven identical headings and could not tell that the county table was
// ranked by Overall while the candidate towns below it were ranked by Stability
// and the map was painted by a third measure (audit F19). Screen readers were
// already told, through the aria-label bindSortHeader writes; sighted readers
// were not.
//
// Each table now carries a sentence naming its sort and its direction, and the
// active heading carries a caret and an underline as well as the colour.
// Extracted from the shipped IIFE and evaluated, like the other quiet-corners
// gates — no second implementation to drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../../themes/headlessmode/layouts/_default/quiet-corners-dashboard.html', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../../themes/headlessmode/static/css/quiet-corners.css', import.meta.url), 'utf8');

function decl(head, open) {
  const at = SRC.indexOf(head);
  assert.notEqual(at, -1, `${head} is gone from quiet-corners.js`);
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let j = SRC.indexOf(open, at); j < SRC.length; j++) {
    if (SRC[j] === open) depth++;
    else if (SRC[j] === close && --depth === 0) return SRC.slice(at, j + 1);
  }
  throw new Error(`unbalanced ${open} in ${head}`);
}
const fn = (name) => decl(`function ${name}(`, '{');

const api = new Function(`
  ${decl('const TEXT_SORT_KEYS = [', '[')};
  ${decl('const SORT_CARETS = {', '{')};
  ${fn('sortNote')} ${fn('headerLabel')}
  return { TEXT_SORT_KEYS, SORT_CARETS, sortNote, headerLabel };
`)();

test('the sentence names the column and the direction, in the column’s own terms', () => {
  assert.equal(api.sortNote('Overall', 'overall_score', -1), 'Sorted by Overall, highest first.');
  assert.equal(api.sortNote('Overall', 'overall_score', 1), 'Sorted by Overall, lowest first.');
  // A name is not a quantity: "highest first" would be nonsense for it.
  assert.equal(api.sortNote('County', 'name', 1), 'Sorted by County, A to Z.');
  assert.equal(api.sortNote('County', 'name', -1), 'Sorted by County, Z to A.');
  for (const k of api.TEXT_SORT_KEYS) {
    assert.match(api.sortNote('X', k, 1), /A to Z/, `${k} sorts as text, not as a quantity`);
  }
  assert.match(api.sortNote('Remote', 'distance_to_metro_mi', -1), /highest first/,
    'a distance is a quantity even though its column reads as a word');
});

test('the label comes from the heading itself, never from a second list', () => {
  // A heading is "County <span class=qc-tooltip-text>County Name</span>": the
  // tooltip is a CHILD, and reading textContent would fold it into the label.
  const node = {
    childNodes: [
      { nodeType: 3, textContent: 'Overall ' },
      { nodeType: 1, textContent: 'Weighted composite score of all metrics' },
    ],
  };
  assert.equal(api.headerLabel(node), 'Overall', 'the tooltip text is not part of the name');
  assert.equal(api.headerLabel({ childNodes: [] }), '', 'an empty heading is empty, not undefined');
});

test('both tables carry a sentence, and the code writes to both', () => {
  for (const id of ['qc-sort-note', 'qc-candidates-sort-note']) {
    const el = HTML.match(new RegExp(`<p[^>]*id="${id}"[^>]*>`));
    assert.ok(el, `${id} is missing from the dashboard`);
    assert.match(el[0], /role="status"/, `${id} must announce a re-sort, not sit silent`);
    assert.ok(SRC.includes(`'${id}'`), `nothing writes ${id}`);
  }
  // Announced on the first render too, not only after a click: a table arrives
  // already sorted, and an empty sentence under a sorted table is worse than none.
  // bindSortHeader does it at bind time -- from the script's own `sort`, not from a
  // `sort-active` typed into the template, which was a second copy of the default
  // and could disagree with the real one without anything noticing.
  assert.match(fn('bindSortHeader'), /markSortActive\(header, sort, noteId\)/,
    'bindSortHeader must announce the sort the data is actually in');
  assert.match(fn('markSortActive'), /data-sort="' \+ sort\.key \+ '"[\s\S]{0,120}?markSorted\(/,
    'markSortActive must find the heading by the key the script is sorting on');
  assert.match(fn('setupSort'), /'qc-sort-note'/, 'the counties table names its note element');
  assert.match(fn('setupSort'), /'qc-candidates-sort-note'/, 'and so does the candidates table');
});

test('the sorted heading is not marked by colour alone', () => {
  const rule = CSS.match(/\.qc-log-header span\.sort-active[\s\S]*?\}/);
  assert.ok(rule, '.sort-active lost its rule');
  assert.match(rule[0], /text-decoration|border-bottom|outline/,
    'accent colour is the only cue on a muted-grey row; add a non-colour one');
  // And a caret, so direction is visible without reading the sentence.
  assert.equal(api.SORT_CARETS.asc, '\u25B2', 'ascending points up');
  assert.equal(api.SORT_CARETS.desc, '\u25BC', 'descending points down');
  assert.match(fn('markSorted'), /SORT_CARETS\.asc[\s\S]{0,40}SORT_CARETS\.desc/,
    'and the direction picks between them');
  assert.match(SRC, /qc-sort-caret/, 'the caret needs its own element, not appended text');
  assert.match(CSS, /\.qc-sort-caret/, 'and its own rule');
});
