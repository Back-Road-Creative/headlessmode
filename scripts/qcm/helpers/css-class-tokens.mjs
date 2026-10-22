// Class tokens out of CSS selector text, and whether a token is written down
// anywhere a template or a script could put it on an element.
//
// Deliberately NOT a CSS parser and NOT a rendered-page check. A gate that asks
// "does this selector match an element right now" reported 40+ selectors here that
// are legitimately state- or page-dependent (.qcm-site-card needs a pin click,
// .qcm-coverage is a different page, .qcm-legend li[data-state=...] is a load
// state), so it needed an ignore list, and an ignore list rots. This asks the much
// weaker question that survives without one: is the NAME written down at all?
// `.qcm-controls button:disabled` and `.qcm-panel-layers[open]` still carry a token
// a template writes, so they pass with no exemption.
//
// Known blind spots, both in the safe direction (the check goes quiet, never wrong):
//   * a name assembled at runtime, `qcm-${x}` -- nothing under static/js/ does this
//     today; every className/classList/divIcon argument there is a literal string.
//   * `[class~="qcm-x"]`, because string contents are masked before extraction.
//   * a class written only in markdown under content/ -- these classes come from
//     templates and JS, and the single qcm- token in content/ is a shortcode name.

/** Blanks comment bodies and string contents in place, preserving every offset and
 *  newline so a hit still reports its real line. Comments go first because the
 *  header of quiet-corners-maps.css names half the selectors in the file in prose,
 *  and a mention is not a rule. Strings go because a declaration may legally carry
 *  a brace or a dot-identifier -- `content: "}.qcm-x"` would otherwise both break
 *  the brace scan and invent a token. */
export function maskCommentsAndStrings(css) {
  const out = css.split('');
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  while (i < css.length) {
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end === -1 ? css.length : end + 2;
      blank(i, stop); i = stop; continue;
    }
    if (css[i] === '"' || css[i] === "'") {
      const quote = css[i];
      let j = i + 1;
      while (j < css.length && css[j] !== quote) { if (css[j] === '\\') j++; j++; }
      blank(i + 1, Math.min(j, css.length));
      i = Math.min(j + 1, css.length); continue;
    }
    i++;
  }
  return out.join('');
}

/** Every class token in SELECTOR text -- the run before a `{` -- whose name starts
 *  with `prefix`, as { token, line } for the first place each is written.
 *
 *  The scan needs no brace depth: a prelude is whatever sits between the last `{`,
 *  `}` or `;` and the next `{`. A declaration always ends in `;` or `}`, so a
 *  declaration is never mistaken for a selector; `@media (...)` and any other
 *  at-rule prelude is skipped by its leading `@`, while the rules nested inside it
 *  are ordinary preludes and are read. `.6rem` is not a token because a class must
 *  begin with a letter or an underscore. */
export function classTokens(css, prefix) {
  const masked = maskCommentsAndStrings(css);
  const found = new Map();
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{') {
      const prelude = masked.slice(start, i);
      if (!/^\s*@/.test(prelude)) {
        const re = /\.(-?[_a-zA-Z][\w-]*)/g;
        let hit;
        while ((hit = re.exec(prelude))) {
          const token = hit[1];
          if (token.startsWith(prefix) && !found.has(token)) {
            found.set(token, css.slice(0, start + hit.index).split('\n').length);
          }
        }
      }
      start = i + 1;
    } else if (c === '}' || c === ';') start = i + 1;
  }
  return [...found].map(([token, line]) => ({ token, line })).sort((a, b) => a.token.localeCompare(b.token));
}

/** True when `text` writes `token` somewhere an element could pick it up as a class.
 *
 *  Whole token, so `qcm-map` is not found inside `qcm-map-layers.html`; and an id is
 *  not a class, so neither `#qcm-app` nor `id="qcm-app"` counts. That second half is
 *  not decoration: `.qcm-app` CLASS rules carried the control chrome on these panels
 *  for months while `qcm-app` was only ever an id, and ten buttons and selects were
 *  painted as bare borderless text the whole time. */
export function writesClass(text, token) {
  const withoutIds = text.replace(/\bid\s*=\s*(["'])(.*?)\1/gs, (m, q) => `id=${q}${q}`);
  return new RegExp(`(^|[^#\\w-])${token}($|[^\\w-])`).test(withoutIds);
}
