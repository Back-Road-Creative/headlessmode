// The control inventory: what a reader can operate on a built Quiet Corners page, read
// from the rendered DOM, and the comparison of that against scripts/qcm/control-register.json.
//
// Two halves. `inventoryInPage(registerSelectors)` is an expression a test evaluates in the
// page: it lists every control in the map chrome and says which register selector claims
// it. `compareToRegister(...)` is pure and turns the page's answer into the two failure
// lists the gate reports -- controls nothing registers ("unregistered"), and register
// entries whose selector matches nothing any more ("stale").

/** What counts as a control. `a[href]` is added per page by its `anchorScope`, because the
 *  site header, footer and the methodology prose carry links that are not map chrome. */
export const CONTROL_SELECTOR = [
  'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary',
  '[role="button"]', '[role="switch"]', '[role="tab"]', '[tabindex="0"]',
].join(', ');

/** An expression for page.evaluate(). Resolves to
 *  { controls: [{ sel, claimedBy: number[] }], matched: number[] }
 *  where `matched[i]` is how many elements register selector i matches anywhere in the page.
 *  `scope` is where controls are looked for; `anchorScope` is where a[href] counts. */
export function inventoryInPage(selectors, { scope, anchorScope }) {
  return `(() => {
    const selectors = ${JSON.stringify(selectors)};
    const scope = ${JSON.stringify(scope)};
    const anchorScope = ${JSON.stringify(anchorScope)};
    const root = document.querySelector(scope);
    const found = new Set(root ? root.querySelectorAll(${JSON.stringify(CONTROL_SELECTOR)}) : []);
    if (anchorScope) for (const a of document.querySelectorAll(anchorScope + ' a[href]')) found.add(a);
    const safe = (el, s) => { try { return el.matches(s); } catch { return false; } };
    const words = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '')
      .replace(/\\s+/g, ' ').trim().slice(0, 40);
    const describe = (el) => {
      let d = el.tagName.toLowerCase();
      if (el.id) d += '#' + el.id;
      else if (el.classList.length) d += '.' + [...el.classList].slice(0, 2).join('.');
      for (const a of ['type', 'name', 'role', 'data-sort', 'data-sort-dir']) if (el.getAttribute(a)) d += '[' + a + '=' + el.getAttribute(a) + ']';
      const w = words(el);
      return w ? d + ' "' + w + '"' : d;
    };
    return {
      scopeFound: Boolean(root),
      controls: [...found].map((el) => ({
        sel: describe(el),
        claimedBy: selectors.map((s, i) => (safe(el, s) ? i : -1)).filter((i) => i >= 0),
      })),
      matched: selectors.map((s) => { try { return document.querySelectorAll(s).length; } catch { return -1; } }),
    };
  })()`;
}

/** Pure. `page` is the object inventoryInPage resolved to; `entries` the register entries it
 *  was given the selectors of, in the same order. `transient` entries are controls that only
 *  exist after an interaction the gate does not make (a card, a drawn area), so they may
 *  match nothing here and are never stale for it. Returns { unregistered, stale }. */
export function compareToRegister(page, entries) {
  const unregistered = page.controls.filter((c) => c.claimedBy.length === 0).map((c) => c.sel);
  const stale = entries
    .map((e, i) => ({ e, n: page.matched[i] }))
    .filter(({ e, n }) => !e.transient && n === 0)
    .map(({ e }) => e.selector);
  return { unregistered, stale };
}

/** The sentence a failing gate throws, naming each offender. */
export function gateMessage(where, { unregistered, stale }) {
  const out = [];
  if (unregistered.length) out.push(`${where}: unregistered control(s) -- add to scripts/qcm/control-register.json:\n  ${unregistered.join('\n  ')}`);
  if (stale.length) out.push(`${where}: stale register entr(ies) -- selector matches nothing:\n  ${stale.join('\n  ')}`);
  return out.join('\n');
}
