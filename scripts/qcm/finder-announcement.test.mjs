// A miss the finder shows is a miss a screen reader is told about.
//
// #518 made the finder stop claiming a town is absent while the export is still
// loading -- it now says "Still loading the town list…" instead. That fixed what
// the sentence SAYS. It did not fix who hears it.
//
// The message is a <p class="qc-finder-empty"> appended into #qc-place-results,
// which is role="listbox", and on the same render the input's aria-expanded goes
// to "false". So to a screen reader the combobox collapsed and nothing happened:
// no announcement of the miss, no announcement of a count on a hit, and a <p>
// sitting inside a listbox, which is not a child role a listbox may have
// (axe aria-required-children). A sighted reader sees a sentence; a reader using
// a screen reader gets silence, and that silence is identical whether the export
// is still loading or the town genuinely is not there.
//
// So: the sentence moves out of the listbox, the listbox goes back to holding
// nothing but options, and a polite live region carries the announcement.
//
// THE LIMIT OF THIS PROOF, stated plainly: it asserts the accessibility tree
// carries the text, in a region whose role is "status" and whose aria-live is
// "polite". That is what makes an announcement possible. It does NOT prove a
// screen reader speaks it -- no test here drives NVDA, JAWS or VoiceOver, and
// nobody should read a green tick on this file as evidence that it was heard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('quiet-corners') ? 'public/quiet-corners/ not built — run `hugo --configDir site-config --minify` first'
    : false;

async function withMap(fn) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, `${site.origin}/quiet-corners/`, {
    viewport: { width: 1440, height: 1000 }, args: ['--hide-scrollbars'],
  });
  try {
    await readyDashboard(page);
    return await fn(page);
  } finally { page.close(); await site.close(); }
}

const OPEN_FINDER = `await (async () => {
  const toggle = document.querySelector('.qc-finder-toggle');
  if (!toggle) throw new Error('no search control on the map');
  if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
  return qcWait('the finder box opened', () => {
    const el = document.getElementById('qc-place-search'), pane = el && el.closest('.qc-finder-box');
    return pane && !pane.hidden ? el : null;
  });
})()`;

/** Type a query and read what a screen reader would be handed. */
const announced = (term) => `(async () => {
  const box = ${OPEN_FINDER};
  box.focus();
  box.value = ${JSON.stringify(term)};
  box.dispatchEvent(new Event('input', { bubbles: true }));
  const list = document.getElementById('qc-place-results');
  const live = [...document.querySelectorAll('[aria-live], [role="status"], [role="alert"]')]
    .filter((el) => box.closest('.qc-finder-box') && box.closest('.qc-finder-box').contains(el));
  const region = live[0] || null;
  return {
    visible: (document.querySelector('.qc-finder-empty') || {}).textContent || null,
    options: [...list.querySelectorAll('[role="option"]')].length,
    liveCount: live.length,
    role: region ? region.getAttribute('role') : null,
    politeness: region ? region.getAttribute('aria-live') : null,
    spoken: region ? region.textContent.trim() : null,
    // A listbox may hold options and groups. Anything else is a role violation
    // and, in practice, content a screen reader will not read out.
    strays: [...list.children]
      .filter((el) => !['option', 'group'].includes(el.getAttribute('role')))
      .map((el) => el.tagName.toLowerCase() + (el.className ? '.' + el.className : '')),
  };
})()`;

test('a miss is announced, not just drawn', { skip }, async () => {
  const seen = await withMap((p) => p.evaluate(announced('Zzzzzqqq')));
  assert.equal(seen.options, 0, 'this query was supposed to match nothing');
  assert.ok(seen.visible, 'the finder drew no message at all for a miss — the wrong test is failing');
  assert.equal(seen.liveCount, 1,
    `the finder has ${seen.liveCount} live regions; a reader using a screen reader is told `
    + `"${seen.visible}" only if exactly one region carries it`);
  assert.equal(seen.role, 'status', `the announcement region has role="${seen.role}", not "status"`);
  assert.equal(seen.politeness, 'polite',
    `the region's aria-live is "${seen.politeness}" — a search result is polite, never assertive`);
  assert.equal(seen.spoken, seen.visible.trim(),
    `the screen reader is handed "${seen.spoken}" while the screen shows "${seen.visible.trim()}"`);
});

test('a hit is announced with a count', { skip }, async () => {
  const seen = await withMap((p) => p.evaluate(announced('Ashland')));
  assert.ok(seen.options > 0, 'Ashland suggested nothing — the wrong test is failing');
  assert.equal(seen.role, 'status', `the announcement region has role="${seen.role}", not "status"`);
  assert.match(seen.spoken, new RegExp(`\\b${seen.options}\\b`),
    `${seen.options} suggestions appeared and the announcement was "${seen.spoken}" — `
    + 'a reader who cannot see the list is told nothing about how many there are');
  assert.match(seen.spoken, /suggestion|result|town|match/i,
    `the announcement "${seen.spoken}" is a bare number with nothing to anchor it`);
});

test('the suggestion listbox holds nothing but options', { skip }, async () => {
  const seen = await withMap((p) => p.evaluate(announced('Zzzzzqqq')));
  assert.deepEqual(seen.strays, [],
    `#qc-place-results is role="listbox" and contains ${seen.strays.join(', ')}. A listbox may `
    + 'hold options and groups only (axe aria-required-children); prose belongs beside it, not in it.');
});
