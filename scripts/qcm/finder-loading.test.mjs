// The finder answers for a list it has not read yet.
//
// candidates.json is ~1.8MB and deliberately not awaited: the page renders, and the
// export lands somewhere between half a second and a second later. `findPlaces`
// returns nothing while `candidatesData` is still null, and the empty answer was
// 'No town matching "amery" is in this list.' -- a sentence that asserts the export
// was read and does not hold the town. For the first second of every page load that
// is false, and it is indistinguishable from the reader's own typo.
//
// The window is held open rather than raced: the server PARKS the request for
// candidates.json and answers it only when the test says so, so the page sits in the
// state under test for as long as the assertions take. Nothing here sleeps and hopes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt() ? 'public/quiet-corners/ not built — run `hugo --configDir site-config --minify` first'
    : false;

/** The page, with candidates.json parked server-side. `release()` on the site hands
 *  it over. The map itself needs only the county files, which are served normally. */
async function withHeldCandidates(fn) {
  const site = await startSiteServer({ hold: /\/candidates\.json$/ });
  const page = await launch(CHROMIUM, `${site.origin}/quiet-corners/`, {
    viewport: { width: 1440, height: 1000 }, args: ['--hide-scrollbars'],
  });
  try {
    const ready = await page.evaluate(`(async () => { for (let i = 0; i < 200; i++) {
      if (window.qcMap && window.qcMap._loaded) return true;
      await new Promise(r => setTimeout(r, 100)); } return false; })()`);
    assert.ok(ready, 'the map never came up with candidates.json held');
    return await fn(page, site);
  } finally { page.close(); await site.close(); }
}

/** What the finder is telling the reader, read off the rendered page. `dataIn` is the
 *  export's own arrival signal — the candidates section is display:none until it lands
 *  — and every test asserts it, so one that quietly missed the loading window fails
 *  instead of passing for free. */
const READ = `(() => {
  const list = document.getElementById('qc-place-results');
  const box = document.getElementById('qc-place-search');
  const sect = document.getElementById('qc-candidates-section');
  return {
    options: [...(list ? list.querySelectorAll('[role="option"]') : [])].map(o => o.textContent.trim()),
    message: [...document.querySelectorAll('.qc-finder-empty')]
      .map(e => e.textContent.trim()).filter(Boolean).join(' '),
    expanded: box && box.getAttribute('aria-expanded'),
    dataIn: !!sect && sect.style.display !== 'none',
  };
})()`;

/** Type a name the way a reader would. The input handler is synchronous, so there is
 *  nothing to wait for once the event is dispatched. */
const type = (term) => `(async () => {
  const toggle = document.querySelector('.qc-finder-toggle');
  if (!toggle) return { error: 'no search control on the map' };
  if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
  await new Promise(r => setTimeout(r, 150));
  const box = document.getElementById('qc-place-search');
  if (!box) return { error: 'no #qc-place-search on the map' };
  box.focus();
  box.value = ${JSON.stringify(term)};
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return ${READ};
})()`;

// Amery, Polk County, Wisconsin — the town find-and-scale.test.mjs looks up, so the
// export demonstrably holds it and "no such town" is demonstrably a lie.
const TOWN = 'Amery';

test('a town still loading is not reported missing', { skip }, async () => {
  const seen = await withHeldCandidates((p) => p.evaluate(type(TOWN)));
  assert.equal(seen.error, undefined, seen.error);
  assert.equal(seen.dataIn, false, 'candidates.json was served anyway — this never reached the loading window');
  assert.equal(seen.options.length, 0, 'the export was not held after all: the finder had suggestions');
  assert.ok(seen.message, 'the finder said nothing at all while the town list was still loading');
  assert.doesNotMatch(seen.message, /in this list|no town/i,
    `while the list was still loading the finder said: "${seen.message}"`);
  assert.match(seen.message, /load/i,
    `the reader should be told the list is still loading; they were told: "${seen.message}"`);
});

test('the answer changes when the list arrives, without another keystroke', { skip }, async () => {
  await withHeldCandidates(async (page, site) => {
    const before = await page.evaluate(type(TOWN));
    assert.equal(before.error, undefined, before.error);
    assert.equal(before.options.length, 0, 'the export was not held after all');
    site.release();
    // Polls for the suggestion rather than sleeping past the fetch: this waits on the
    // condition it asserts, so it cannot pass or fail on how loaded the box is.
    const after = await page.evaluate(`(async () => {
      for (let i = 0; i < 300; i++) {
        if (document.querySelectorAll('#qc-place-results [role="option"]').length) break;
        await new Promise(r => setTimeout(r, 100));
      }
      return ${READ};
    })()`);
    assert.equal(after.dataIn, true, 'the released export never reached the page');
    assert.ok(after.options.length,
      `the list arrived and the open search still said: "${after.message}"`);
    assert.match(after.options[0], /Amery/i, `the first suggestion was "${after.options[0]}"`);
    assert.equal(after.message, '', `a suggestion was shown beside the message "${after.message}"`);
    assert.equal(after.expanded, 'true', 'the combobox has options and reports itself collapsed');
  });
});

test('what a screen reader would read is the loading answer too', { skip }, async () => {
  const text = await withHeldCandidates(async (page) => {
    const seen = await page.evaluate(type(TOWN));
    assert.equal(seen.error, undefined, seen.error);
    assert.equal(seen.dataIn, false, 'candidates.json was served anyway — this never reached the loading window');
    // Chromium's own accessibility tree, over the DevTools protocol, rather than the
    // markup: what a screen reader is handed is a computed tree, and reading the DOM
    // back cannot say whether the sentence survived into it. Two subtrees can carry
    // the finder's answer -- the combobox's popup (the listbox) and the polite status
    // region beside it, which is where a sentence goes now that a listbox may hold
    // options and groups and nothing else (axe aria-required-children).
    await page.send('Accessibility.enable');
    const { nodes } = await page.send('Accessibility.getFullAXTree');
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const textOf = (n) => [n.name?.value ?? '', ...(n.childIds ?? [])
      .map((id) => (byId.has(id) ? textOf(byId.get(id)) : ''))].join(' ');
    const answers = ['listbox', 'status'];
    return nodes.filter((n) => !n.ignored && answers.includes(n.role?.value))
      .map(textOf).join(' | ');
  });
  assert.match(text, /load/i,
    `the finder reads "${text}" in the accessibility tree — not that the list is still loading`);
  assert.doesNotMatch(text, /in this list/i,
    `a screen reader is still told the town is absent: "${text}"`);
});
