// The dashboard's two type voices, measured in a real browser rather than argued
// from the stylesheet.
//
// Audit finding F19 (.data/plans/2026-09-09-quiet-corners-map-audit-plan.md): every
// label, column heading, sentence and control on the page was set in the same dense
// 0.65-0.7rem monospace as the seven numeric columns, so nothing distinguished text
// a reader READS from figures a reader COMPARES. The provenance line -- the one that
// answers "can I trust this" -- was 10px.
//
// Monospace is right for the data: the columns only line up because the digits are
// the same width. It is wrong for everything else. So this reads the two properties
// that carry that split, on the rendered page:
//
//   - is the face monospace? Measured, not parsed: ten narrow glyphs against ten
//     wide ones in the element's own font. A family list that says "mono" but
//     resolves to a proportional face would pass a regex and fail a reader.
//   - what size does it come out at? Computed, after the cascade, in px.
//
// Audit A12 asked the same question of weight rather than face: every score sat in a
// filled, tinted chip, five per county row and ten rows to a page, so nothing on the
// table stood out. The last case here reads what a score actually paints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt() ? 'public/quiet-corners/ not built — run `hugo --configDir site-config --minify` first'
    : false;

/** 13px. Below this a place name reads as another figure in the row. */
const PRIMARY_MIN = 13;
/** 12px. The floor for anything in the filter panel, provenance included. */
const CHROME_MIN = 12;

/** Copies an element's resolved font onto a probe span and compares the width of
 *  ten `i` against ten `M`. Equal to within half a pixel means every glyph is the
 *  same width, which is what "monospace" means to the eye. */
const HELPERS = `
  const cssFont = (el) => {
    const cs = getComputedStyle(el);
    return { family: cs.fontFamily, size: cs.fontSize, weight: cs.fontWeight, style: cs.fontStyle };
  };
  const isMono = (el) => {
    const f = cssFont(el);
    const s = document.createElement('span');
    s.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;';
    s.style.fontFamily = f.family; s.style.fontSize = f.size;
    s.style.fontWeight = f.weight; s.style.fontStyle = f.style;
    document.body.appendChild(s);
    s.textContent = 'iiiiiiiiii'; const narrow = s.getBoundingClientRect().width;
    s.textContent = 'MMMMMMMMMM'; const wide = s.getBoundingClientRect().width;
    s.remove();
    return Math.abs(wide - narrow) < 0.5;
  };
  const px = (el) => parseFloat(getComputedStyle(el).fontSize);
  const one = (sel) => document.querySelector(sel);
`;

/** Every control and heading a reader is asked to read, by the id or class the
 *  markup gives it. The two slider readouts are deliberately absent: a number that
 *  changes as you drag stays monospace so it does not jitter. */
const READS_AS_PROSE = `(() => {
  ${HELPERS}
  const wanted = {
    'a filter label': '#qc-controls .filter-label',
    'the State filter': '#qc-state',
    'the Color by control': '#qc-color-by',
    'a results column heading': '#qc-table-header span[data-sort]',
    'the sort sentence': '#qc-sort-note',
    'the map key': '.qc-legend',
    'the provenance line': '#qc-meta',
  };
  const out = {};
  for (const [name, sel] of Object.entries(wanted)) {
    const el = one(sel);
    out[name] = el ? { mono: isMono(el), size: px(el) } : null;
  }
  return out;
})()`;

/** A row carrying the classes renderTable() writes (quiet-corners.js), placed in the
 *  real table body so the real cascade applies. Injected rather than waited for: the
 *  county data is a network fetch, and this is a question about the stylesheet. */
const ROW = `(() => {
  ${HELPERS}
  const body = one('#qc-table-body');
  if (!body) return null;
  const row = document.createElement('div');
  row.className = 'qc-row';
  row.innerHTML = '<span class="qc-name">Ontonagon County</span><span>MI</span>'
    + '<span class="qc-pop">5,816</span><span class="qc-score high">88</span>'
    + '<span class="qc-score high">84</span><span class="qc-score medium">61</span>'
    + '<span class="qc-score high">142</span>';
  body.appendChild(row);
  const name = row.querySelector('.qc-name');
  const score = row.querySelector('.qc-score');
  const seen = {
    name: { mono: isMono(name), size: px(name) },
    score: { mono: isMono(score), size: px(score) },
    row: { size: px(row) },
  };
  row.remove();
  return seen;
})()`;

/** The same row read for what it PAINTS rather than what face it sets. One cell per
 *  band, because the fill was written per band. Reads the visible result — the
 *  computed background colour and any background image — beside the glyph and the
 *  text colour that carry the band, so taking the fill away cannot quietly take the
 *  band with it (WCAG 1.4.1: the glyph, not the colour, is what says "high"). */
const BANDS = `(() => {
  ${HELPERS}
  const body = one('#qc-table-body');
  if (!body) return null;
  const row = document.createElement('div');
  row.className = 'qc-row';
  row.innerHTML = '<span class="qc-name">Ontonagon County</span><span>MI</span>'
    + '<span class="qc-pop">5,816</span><span class="qc-score high">88</span>'
    + '<span class="qc-score medium">61</span><span class="qc-score low">24</span>'
    + '<span class="qc-score high">142</span>';
  body.appendChild(row);
  const read = (band) => {
    const el = row.querySelector('.qc-score.' + band);
    const cs = getComputedStyle(el);
    const glyph = getComputedStyle(el, '::before').content;
    return {
      background: cs.backgroundColor,
      backgroundImage: cs.backgroundImage,
      color: cs.color,
      glyph: glyph && glyph !== 'none' ? glyph.replace(/^"|"$/g, '').trim() : null,
    };
  };
  const seen = { high: read('high'), medium: read('medium'), low: read('low') };
  row.remove();
  return seen;
})()`;

const DESKTOP = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };

/** Every element read below is built by quiet-corners.js AFTER its county-data fetch
 *  resolves, so a probe that evaluates the moment the page loads is racing that fetch.
 *  It lost that race often enough on a loaded box to turn three unrelated runs red with
 *  "the map key is missing from the dashboard" -- a message that reads as a missing
 *  legend rather than as a probe that arrived early. Poll for the thing first, the way
 *  mobile-cards.test.mjs does, and say so plainly when it genuinely never arrives. */
const RENDERED = "!!document.querySelector('.qc-legend') && !!document.querySelector('#qc-table-body .qc-row')";

async function onPage(expr, viewport = DESKTOP, ready = RENDERED) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, `${site.origin}/quiet-corners/`, {
    viewport, args: ['--hide-scrollbars'],
  });
  try {
    let arrived = false;
    for (let i = 0; i < 300 && !arrived; i++) {
      arrived = await page.evaluate(ready);
      if (!arrived) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(arrived, `the dashboard never rendered ${ready} within 30s, so nothing was measured`);
    return await page.evaluate(expr);
  } finally { page.close(); await site.close(); }
}

test('the words on the dashboard are not set in the face that lines up figures', { skip }, async () => {
  const seen = await onPage(READS_AS_PROSE);
  for (const [name, got] of Object.entries(seen)) {
    assert.ok(got, `${name} is missing from the dashboard`);
    assert.equal(got.mono, false,
      `${name} renders in a monospace face — it is text to read, not a column to align`);
    assert.ok(got.size >= CHROME_MIN,
      `${name} renders at ${got.size}px, below the ${CHROME_MIN}px floor`);
  }
});

test("a county's name is the thing you read first in its row", { skip }, async () => {
  const seen = await onPage(ROW);
  assert.ok(seen, '#qc-table-body is missing from the dashboard');
  assert.ok(seen.name.size >= PRIMARY_MIN,
    `the county name renders at ${seen.name.size}px, below the ${PRIMARY_MIN}px floor`);
  assert.ok(seen.name.size > seen.row.size,
    `the county name (${seen.name.size}px) is no larger than the figures beside it `
    + `(${seen.row.size}px) — nothing marks it as the row's subject`);
  assert.equal(seen.name.mono, false, 'a place name is a word to read, not a column to align');
});

test('the numeric columns keep the face that makes them comparable', { skip }, async () => {
  const seen = await onPage(ROW);
  assert.ok(seen, '#qc-table-body is missing from the dashboard');
  assert.equal(seen.score.mono, true,
    'the scores lost their monospace face — seven columns of digits stop lining up');
  assert.ok(seen.score.size >= CHROME_MIN,
    `a score renders at ${seen.score.size}px, below the ${CHROME_MIN}px floor`);
});

/** A background that paints nothing at all. Chromium reports the initial value this
 *  way, so it is what "no chip behind the number" looks like from the reader's side. */
const UNPAINTED = 'rgba(0, 0, 0, 0)';

test('a column of scores reads as figures, not as a wall of filled chips', { skip }, async () => {
  for (const [where, viewport] of [['the table', DESKTOP], ['a card', PHONE]]) {
    const seen = await onPage(BANDS, viewport);
    assert.ok(seen, '#qc-table-body is missing from the dashboard');
    const bands = ['high', 'medium', 'low'];
    for (const band of bands) {
      const got = seen[band];
      assert.equal(got.background, UNPAINTED,
        `on ${where} a ${band} score is painted ${got.background} — a county row shows five `
        + 'scores and the page shows ten rows, so a fill behind every one of them emphasises '
        + 'nothing');
      assert.equal(got.backgroundImage, 'none',
        `on ${where} a ${band} score still paints ${got.backgroundImage} behind the number`);
    }
    // The fill was never what said which band a score is in, and it still is not.
    for (const band of bands) {
      assert.ok(seen[band].glyph,
        `on ${where} a ${band} score lost its band glyph — the band would be colour alone`);
    }
    assert.equal(new Set(bands.map((b) => seen[b].glyph)).size, bands.length,
      `on ${where} two bands draw the same glyph: ${bands.map((b) => seen[b].glyph).join(' ')}`);
    assert.equal(new Set(bands.map((b) => seen[b].color)).size, bands.length,
      `on ${where} two bands share a text colour: ${bands.map((b) => seen[b].color).join(' ')}`);
  }
});

// QQA-05d: the small UI text on the map itself -- the controls laid over it, the credit
// line, the scale bar and hover labels, the print-sheet ids and the map key. These are
// declaration checks on the stylesheets Hugo copies to the site verbatim (static/css is
// not processed), so they need no browser and run on a box with no built site; the
// computed-px checks for the same elements live in phone-controls.test.mjs.
const CSS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../themes/headlessmode/static/css');
const sheet = (name) => readFileSync(path.join(CSS_DIR, name), 'utf8');

/** Every rule in a stylesheet as { selectors, media, decls }, in source order. A tiny
 *  brace-stack scan: comments are blanked first, and an at-rule block (@media) is
 *  entered rather than parsed as a rule, so its header becomes the `media` of the rules
 *  inside it. Enough for this repo's hand-written CSS; it is not a general parser. */
function rules(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length));
  const out = [];
  const media = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const head = text.slice(i, open).trim();
    if (head.startsWith('@')) { media.push(head); i = open + 1; continue; }
    const close = text.indexOf('}', open);
    out.push({
      selectors: head.split(',').map((x) => x.trim().replace(/\s+/g, ' ')),
      media: media.join(' '),
      decls: text.slice(open + 1, close),
    });
    i = close + 1;
    // Leave any enclosing at-rule once its closing brace is next.
    while (/^\s*}/.test(text.slice(i))) { media.pop(); i = text.indexOf('}', i) + 1; }
  }
  return out;
}

/** The value a stylesheet gives `prop` on a rule whose selector list names exactly
 *  `selector`, outside any @media block; the last such declaration wins, as it would
 *  in the cascade for equal specificity. null when none declares it. */
function declared(css, selector, prop) {
  let value = null;
  for (const r of rules(css)) {
    if (r.media || !r.selectors.includes(selector)) continue;
    const m = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+?)\\s*(?:;|$)`).exec(r.decls);
    if (m) value = m[1].replace(/\s*!important$/, '');
  }
  return value;
}
/** `font: 600 0.75rem ui-monospace, monospace` carries its size as the first length. */
const fontShorthandSize = (v) => (v ? /(\d*\.?\d+(?:rem|px))/.exec(v)?.[1] ?? null : null);

const MAIN = sheet('quiet-corners.css');
const MAPS = sheet('quiet-corners-maps.css');
const TERRAIN = sheet('quiet-corners-terrain.css');

test('the declaration reader sees what the cascade would (so the checks below can fail)', () => {
  const css = '/* .a { font-size: 9px } */ .a, .b { color: red; font-size: 1rem !important; }'
    + ' @media (max-width: 1px) { .a { font-size: 2rem } } .c { font: 600 0.7rem x; }';
  assert.equal(declared(css, '.a', 'font-size'), '1rem');
  assert.equal(declared(css, '.b', 'font-size'), '1rem');
  assert.equal(declared(css, '.c', 'font-size'), null);
  assert.equal(fontShorthandSize(declared(css, '.c', 'font')), '0.7rem');
});

test('the controls laid over the map are at least 14px', () => {
  assert.equal(declared(MAIN, '.qc-view-btn', 'font-size'), '0.875rem',
    'Share view / Reset view / Use my location');
  assert.equal(declared(MAPS, '.qcm-controls .qcm-preset', 'font-size'), '0.875rem',
    'the starting-set buttons');
  assert.equal(fontShorthandSize(declared(TERRAIN, '.qc-terrain-control .qc-terrain-open', 'font')),
    '0.875rem', 'the 3D button');
});

test('the map credit line is 12px and wraps instead of shrinking', () => {
  const sel = '.leaflet-control-attribution';
  assert.equal(declared(MAIN, sel, 'font-size'), '0.75rem');
  assert.equal(declared(MAIN, sel, 'line-height'), '1.3');
  assert.equal(declared(MAIN, sel, 'white-space'), 'normal');
  assert.equal(declared(MAIN, sel, 'max-width'), '60vw',
    'a longer credit must wrap inside the map, not run off it');
});

test('the scale bar and hover labels are 13px', () => {
  assert.equal(declared(MAIN, '.leaflet-control-scale', 'font-size'), '0.8125rem');
  assert.equal(declared(MAIN, '.leaflet-tooltip', 'font-size'), '0.8125rem');
});

test('print-sheet ids are 12px', () => {
  assert.equal(fontShorthandSize(declared(MAPS, '.qcm-sheet-label', 'font')), '0.75rem');
});

/** WCAG relative luminance and contrast ratio of two #rrggbb colours. */
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** `fg` at `alpha` over `bg`, as the opaque colour the eye gets. */
const over = (fg, bg, alpha) => '#' + [1, 3, 5].map((i) => Math.round(
  parseInt(fg.slice(i, i + 2), 16) * alpha + parseInt(bg.slice(i, i + 2), 16) * (1 - alpha),
).toString(16).padStart(2, '0')).join('');

test('map-key rows are 13px, and a row for missing data is muted by colour, not faded', () => {
  assert.equal(declared(MAPS, '.qcm-legend li', 'font-size'), '0.8125rem');
  const sel = '.qcm-legend li[data-state="absent"]';
  const rule = rules(MAPS).find((r) => !r.media && r.selectors.includes(sel));
  assert.ok(rule, 'no rule for the absent legend rows');
  assert.ok(rule.selectors.includes('.qcm-legend li[data-state="unknown"]'),
    'absent and unknown rows must share one treatment');
  assert.equal(declared(MAPS, sel, 'opacity'), '0.8',
    'a row that explains missing data is not dimmed below 0.8');
  const colour = declared(MAPS, sel, 'color');
  assert.match(colour ?? '', /^#[0-9a-f]{6}$/i, 'the muted colour carries the meaning');
  // The key sits in a `.qcm-controls fieldset`, whose panel background is #18181b.
  const bg = declared(MAPS, '.qcm-controls fieldset', 'background') ?? '';
  const panel = /#[0-9a-f]{6}/i.exec(bg)?.[0];
  assert.ok(panel, 'could not read the key background from `.qcm-controls fieldset`');
  const seen = over(colour, panel, Number(declared(MAPS, sel, 'opacity')));
  assert.ok(contrast(seen, panel) >= 4.5,
    `muted row text ${colour} at 0.8 (${seen}) over ${panel} is ${contrast(seen, panel).toFixed(2)}:1, under 4.5:1`);
});

// QQA-05e: the phone chips that stand in for the folded credit and key are readable and
// thumb-sized. They live inside a @media block, which declared() skips on purpose, so the
// block is read directly here.
test('the phone credit and key chips are 14px text on a 44px target', () => {
  const m = MAIN.match(/@media \(max-width: 1023px\) \{\s*\.qc-fold-toggle \{([^}]*)\}/);
  assert.ok(m, 'quiet-corners.css has a below-1024px .qc-fold-toggle rule');
  assert.match(m[1], /min-height:\s*44px/);
  assert.match(m[1], /min-width:\s*44px/);
  assert.match(m[1], /font-size:\s*0\.875rem/);
  assert.match(MAIN, /\n\.qc-fold-toggle \{\s*display: none;/, 'no chips on a desktop');
});

// QQA-05r-3: a road name is lettered amber on the same plate as a place name, so a reader
// can tell a road from a creek or a summit. The plate is rgba(13,13,26,.82): over a white
// tile and over a black one it composites to two different greys; the text must clear 4.5:1 on both.
test('a road plate letters in amber that clears 4.5:1 over the plate on white and on black', () => {
  const fg = declared(MAPS, '.qcm-road-label', 'color');
  assert.equal(fg, '#fde68a');
  const m = /rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)/.exec(declared(MAPS, '.qcm-road-label', 'background'));
  assert.ok(m, 'the plate is an rgba() colour');
  const plate = '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  for (const tile of ['#ffffff', '#000000']) {
    const seen = over(plate, tile, Number(m[4]));
    assert.ok(contrast(fg, seen) >= 4.5, `road text ${fg} over the plate on ${tile} (${seen}) is ${contrast(fg, seen).toFixed(2)}:1`);
  }
  // The place-name plate keeps its own colour: that difference is the point.
  assert.notEqual(fg, declared(MAPS, '.qcm-name-label', 'color'));
});
