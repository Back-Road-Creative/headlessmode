// One trusted CDP click for every browser proof: never .click(), and never a press sent
// to a point the target is not at.
//
// Five test files each carried a copy that read the target's rect once and pressed
// there at once. Under runner load that point is stale or covered: PR CI run
// 36607266826 (#646) pressed the Layers summary at 390px while something else sat on it,
// the page navigated away, and the next read found no #qcm-layer-panel at all; #646 run
// 36603618563 aimed at one extend-ring cell and selected its neighbour. saved-places and
// before-you-go had already grown the fix below on their own (Leaflet's auto-pan moved a
// card's buttons mid-click); this is that fix, once.
//
// So a press goes in only when the target's centre is the same on two reads `sampleMs`
// apart and on every animation frame between them (at least two), the target has a box,
// it is rendered, and elementFromPoint at that centre is the target or inside it.
// Otherwise it re-reads, up to `tries` times, then throws naming the selector and the
// last read -- a target that never holds still is a failed test, never a stray press.
// scripts/qcm/trusted-click.test.mjs proves each refusal.
//
// The frames are there because two reads were not enough. PR CI run 37022468584 (#670)
// went red in trusted-click.test.mjs's moving-target proof: the press landed on the page
// body, and the whole test took 1443 ms, inside the 1.5 s its target moves for, so two
// reads had agreed on a target that was still moving. Two reads cannot tell a target that
// held still from one that was somewhere else between them. A frame is when the page
// paints, so a target that moved is somewhere else on one of them. A page that paints no
// frames is refused as "not painting" rather than pressed; each such read waits out the
// timer in FRAMES, so STALLED_READS of them in a row end the click instead of every try.
//
// Those timers grow, because a loaded box holds frames back without the page being dead.
// Of the 20 most recent red PR CI runs on 2026-10-05, 17 ended in this refusal (runs
// 37381589696, 37370229061, 37307345975 among them), every read seeing 0 frames and the
// click giving up inside 10 s, while the runner shared a 12-core box at a load of 30
// with local suites. A page that paints again later is pressed then; one that never
// paints is still refused, after STALL_MS adds up to about 20 s rather than 6. The
// starved-page proof in scripts/qcm/trusted-click.test.mjs holds frames back for 10 s.
//
// The target is scrolled into view once per try and read two frames later, and the reads
// never scroll. A page can undo a scroll before it paints: Leaflet sets its map
// container's scroll back to 0 on every scroll event (vendor/leaflet.js, _onScroll). While
// every read scrolled, the frame check failed 10 tests in bin/verify-worktree.sh's mirror
// of PR CI (before-you-go, places-in-view-browser, saved-places-browser). Four were this
// helper refusing a marker or a card button as still moving, and the other six came after
// one of those in the same file: each read put the target's centre at y 450, and a frame
// between the reads found it 26 to 119 px lower.
//
// "Not rendered" is its own reason because it read as something else. Content inside a
// closed <details> keeps a layout box but paints nothing, and scrollIntoView does not move
// to it: PR CI run 36644039461 (#652) reported the print Options summary "covered by
// null" at y=1407 in a 900px viewport, when the press before it had simply not opened
// #qcm-app around it. The reason now names the closed <details>.
//
// `until` is for a press that only sets up the thing under test: a page expression that
// the press makes true. If it is still false once the press has settled, the press is
// repeated from a fresh read, up to UNTIL_PRESSES times, and then it throws naming the
// expression and where each click landed. It must be true as soon as the click's
// listeners have run (a <details> toggle is): a second press on a toggle that was merely
// slow would undo it. Never put it on the click a test is proving.
//
// `align` is where each try scrolls the target to (scrollIntoView's block and inline).
// The default 'center' also scrolls boxes no person can scroll: to script, an
// overflow:hidden box is still a scroll container, and at 390x844 centring a finder row
// slid the dashboard's whole map 105 px up inside #qc-map-container (name-search.test.mjs,
// 2026-10-02). A proof that measures where things landed passes 'nearest', which leaves a
// target already in view where it is.

/** Presses a precondition `until` click at most this many times -- the three presses
 *  before-you-go.test.mjs and saved-places-browser.test.mjs allow their own retry. */
const UNTIL_PRESSES = 3;

/** How long each read in a row with fewer than two frames waits for them before giving
 *  up on that read, growing so a starved page gets its chance (see the header); after
 *  STALLED_READS such reads in a row the click ends as "not painting". */
const STALL_MS = [2000, 5000, 12000];
const STALLED_READS = STALL_MS.length;

// One read of the target where it is now. It never scrolls; BRING does that once per try.
const read = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { missing: true };
  const r = el.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  const hit = r.width > 0 && r.height > 0 ? document.elementFromPoint(x, y) : null;
  const rendered = typeof el.checkVisibility === 'function' ? el.checkVisibility() : true;
  // The closed <details> that hides el: the nearest one whose own summary does not hold
  // it (a closed <details> still renders its summary).
  let shut = null;
  if (!rendered) {
    for (let d = el.parentElement && el.parentElement.closest('details:not([open])'); d;
         d = d.parentElement && d.parentElement.closest('details:not([open])')) {
      const own = d.querySelector(':scope > summary');
      if (!(own && own.contains(el))) { shut = d; break; }
    }
  }
  return {
    missing: false, x, y, width: r.width, height: r.height, at: performance.now(), rendered,
    shut: shut ? 'details' + (shut.id ? '#' + shut.id : shut.classList[0] ? '.' + shut.classList[0] : '') : null,
    covered: !(hit && hit.closest(${JSON.stringify(selector)})),
    by: hit ? (hit.id ? '#' + hit.id : hit.tagName.toLowerCase()) : null,
  };
})()`;

// Scrolls the target into view, then reads it two frames later, once the page has had its
// chance to undo the scroll (see the header). The timer ends the wait on a page that paints
// no frames.
const BRING = (selector, align) => `new Promise((resolve) => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (el) el.scrollIntoView({ block: ${JSON.stringify(align)}, inline: ${JSON.stringify(align)} });
  let done = false;
  const settled = () => { if (!done) { done = true; resolve(${read(selector)}); } };
  setTimeout(settled, 500);
  requestAnimationFrame(() => requestAnimationFrame(settled));
})`;

// The target's centre on every animation frame for at least `ms` and at least two frames,
// read without scrolling (null on a frame where it is not in the page). The timer only ends
// the wait on a page that paints no frames, `stallMs` after the sample would have ended.
const FRAMES = (selector, ms, stallMs) => `new Promise((resolve) => {
  const seen = [], t0 = performance.now();
  setTimeout(() => resolve(seen), ${ms} + ${stallMs});
  requestAnimationFrame(function frame() {
    const el = document.querySelector(${JSON.stringify(selector)});
    const r = el && el.getBoundingClientRect();
    seen.push(r ? [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] : null);
    if (seen.length >= 2 && performance.now() - t0 >= ${ms}) resolve(seen);
    else requestAnimationFrame(frame);
  });
})`;

// Where an `until` press's click landed, for the error when the condition never comes true.
const LAND = (selector) => `(() => {
  const log = window.__trustedClickLanded = [];
  document.addEventListener('click', (e) => {
    const t = e.target;
    log.push(t && t.nodeType === 1 ? t.tagName.toLowerCase() + (t.id ? '#' + t.id : '')
      + (t.closest(${JSON.stringify(selector)}) ? '' : ' (not the target)') : String(t));
  }, { capture: true, once: true });
})()`;

/** Presses `selector` with real mouse events once it is on screen, rendered, uncovered
 *  and still. Returns `{ at, presses }`: `at` is the page's own clock (performance.now)
 *  just before the last press went in, for proofs that time what the click started.
 *  `settleMs` waits after the release for the click's default action (a <details>
 *  toggle) and its listeners. `until` (a page expression) presses again while it is
 *  false; see the header for when it is safe. `align` ('center' or 'nearest') is where
 *  each try scrolls the target to; see the header. */
export async function trustedClick(page, selector, { settleMs = 150, sampleMs = 200, tries = 25, until = null, align = 'center' } = {}) {
  let last = null, presses = 0, reads = 0, stalled = 0;
  const landed = [];
  while (reads < tries && stalled < STALLED_READS) {
    reads++;
    const first = await page.evaluate(BRING(selector, align));
    const frames = await page.evaluate(FRAMES(selector, sampleMs, STALL_MS[stalled]));
    last = await page.evaluate(read(selector));
    // The first frame that saw the target anywhere but where the first read did.
    const strayed = frames.find((c) => !c || c[0] !== first.x || c[1] !== first.y);
    last.frames = frames.length;
    if (strayed !== undefined) last.between = strayed;
    stalled = frames.length < 2 ? stalled + 1 : 0;
    if (!first.missing && !last.missing && last.width > 0 && last.height > 0 && last.rendered
        && !last.covered && first.x === last.x && first.y === last.y
        && frames.length >= 2 && strayed === undefined) {
      if (until) await page.evaluate(LAND(selector));
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await page.send('Input.dispatchMouseEvent', {
          type, x: last.x, y: last.y, button: type === 'mouseMoved' ? 'none' : 'left',
          buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1,
        });
      }
      presses++;
      if (settleMs) await page.evaluate(`new Promise(r => setTimeout(r, ${settleMs}))`);
      if (!until || await page.evaluate(`Boolean(${until})`)) return { at: last.at, presses };
      const click = await page.evaluate('window.__trustedClickLanded');
      landed.push(click && click.length ? click[0] : 'no click');
      if (presses >= UNTIL_PRESSES) break;
    }
  }
  if (presses) {
    const short = presses >= UNTIL_PRESSES ? '' : stalled >= STALLED_READS ? ' before the page stopped painting'
      : ` before its ${tries} reads ran out`;
    throw new Error(`cannot trusted-click ${selector}: pressed ${presses} time${presses === 1 ? '' : 's'}${short} and ${until} never came true (clicks landed on: ${landed.join(', ')}) (last=${JSON.stringify(last)})`);
  }
  const why = last.missing ? 'not in the page'
    : !(last.width > 0 && last.height > 0) ? 'has no box on screen'
      : !last.rendered ? `not rendered${last.shut ? ` (inside a closed ${last.shut})` : ''}`
        : last.covered ? `covered by ${last.by}`
          : last.between === null ? 'missing from the page on a frame between its reads'
            : last.between || last.frames >= 2 ? 'still moving'
              : `not painting (${last.frames} animation frame${last.frames === 1 ? '' : 's'} between its reads)`;
  throw new Error(`cannot trusted-click ${selector}: ${why} after ${reads} reads ${sampleMs} ms apart (last=${JSON.stringify(last)})`);
}
