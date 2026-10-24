// chooseExampleArea (helpers/waits.mjs) hands back a page whose browse debounce has
// fired. It used to get there by sleeping VIEWPORT_FETCH.settleMs + 100 ms after the
// map stopped, whether the debounce was still pending or had fired long before; every
// proof that chooses the area paid that margin. It now waits for the debounce timer
// itself to be gone, so these proofs read the page's own timers: a spy on setTimeout
// installed before the call.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { VIEWPORT_FETCH } from '../../themes/headlessmode/static/js/quiet-corners-maps/app-state.js';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, chooseExampleArea } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt() ? 'public/quiet-corners/ not built -- run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

let shared = null;
after(async () => {
  if (!shared) return;
  shared.page.close();
  await shared.site.close();
});

/** Records every delay handed to setTimeout from here on, and which timers of the
 *  browse debounce's length (settleMs) are still waiting to fire. */
const SPY = `(() => {
  const set = window.setTimeout, clear = window.clearTimeout;
  window.__delays = [];
  window.__debounces = new Set();
  window.setTimeout = function (fn, ms, ...rest) {
    window.__delays.push(ms);
    if (ms !== ${VIEWPORT_FETCH.settleMs}) return set.call(this, fn, ms, ...rest);
    const h = set.call(this, (...a) => { window.__debounces.delete(h); return fn(...a); }, ms, ...rest);
    window.__debounces.add(h);
    return h;
  };
  window.clearTimeout = function (h) { window.__debounces.delete(h); return clear.call(this, h); };
  return true;
})()`;

async function chosen() {
  if (!shared) {
    const site = await startSiteServer();
    const page = await launch(CHROMIUM, 'about:blank', { args: ['--hide-scrollbars'] });
    shared = { site, page };
  }
  const { site, page } = shared;
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page);
  await page.evaluate(SPY);
  await chooseExampleArea(page);
  return page;
}

test('chooseExampleArea returns once the browse debounce has fired, none left pending', { skip }, async () => {
  const page = await chosen();
  const armed = await page.evaluate('window.__delays.filter((ms) => ms === ' + VIEWPORT_FETCH.settleMs + ').length');
  assert.ok(armed >= 1, 'choosing the example area never armed the browse debounce -- the proof would prove nothing');
  const pending = await page.evaluate('window.__debounces.size');
  assert.equal(pending, 0, `${pending} browse debounce timer(s) still pending when chooseExampleArea returned`);
});

// The app's own request deadlines (20 s) are far above any sleep a helper would add.
const DEADLINE_FLOOR_MS = 5000;

test('chooseExampleArea does not sleep a fixed margin past the debounce', { skip }, async () => {
  const page = await chosen();
  const longer = await page.evaluate(`window.__delays.filter((ms) => ms > ${VIEWPORT_FETCH.settleMs} && ms < ${DEADLINE_FLOOR_MS})`);
  assert.deepEqual(longer, [], `chooseExampleArea armed a timer longer than the ${VIEWPORT_FETCH.settleMs} ms debounce (${longer.join(', ')} ms): a blind sleep, not a wait on the condition`);
});
