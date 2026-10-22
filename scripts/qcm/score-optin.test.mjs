// County score is opt-in, not the map's resting state (plan §4.2). It shares the same
// one-surface-at-a-time radio group `surface-choice.test.mjs` already covers for night
// lights, NLCD and the rest -- this file is the score-specific half: what turning it on
// exposes, what turning it off takes away TOGETHER, and what survives the toggle either
// way (administrative outlines, the state filter, Zoom to state as a separate action).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt() ? 'public/quiet-corners/ not built — run `hugo --configDir site-config --minify` first'
    : false;

async function onDashboard(fn) {
  const site = await startSiteServer();
  const page = await launch(CHROMIUM, `${site.origin}/quiet-corners/`, {
    viewport: { width: 1280, height: 900 }, args: ['--hide-scrollbars'],
  });
  try {
    await readyDashboard(page, { ms: 60000 });
    // The Field Maps radio group renders as soon as the shared map is up.
    await page.evaluate(`(async () => {
      for (let i = 0; i < 200; i++) {
        if (document.getElementById('qcm-context-countyScore')) return true;
        await new Promise(r => setTimeout(r, 50));
      }
      return false;
    })()`);
    return await fn(page);
  } finally { page.close(); await site.close(); }
}

const READ = `(() => {
  const hidden = (id) => { const el = document.getElementById(id); return el ? el.hidden : null; };
  const legend = document.querySelector('.qc-legend');
  return {
    colorByHidden: hidden('qc-color-by-group'),
    scoreControlsHidden: hidden('qc-score-controls'),
    legendText: legend ? legend.textContent.replace(/\\s+/g, ' ').trim() : null,
  };
})()`;

test('scores start off: no score fill/legend, and the reader is told how to turn it on', { skip }, async () => {
  const seen = await onDashboard((p) => p.evaluate(READ));
  assert.equal(seen.colorByHidden, true, 'the Color the map by control shows before scores are turned on');
  assert.equal(seen.scoreControlsHidden, true, 'the score wash-strength control shows before scores are turned on');
  assert.match(seen.legendText || '', /Turn on County score/,
    `the legend never tells a reader how to see the ranking key: ${JSON.stringify(seen.legendText)}`);
  assert.doesNotMatch(seen.legendText || '', /80\+|Not measured/,
    'the score band key is on screen before anyone asked to see a ranking');
});

test('turning County score on exposes its controls and legend; turning it off removes them together', { skip }, async () => {
  const seen = await onDashboard(async (p) => {
    // Pick a state first: an explicitly chosen filter must survive the surface switch.
    await p.evaluate(`(() => {
      const sel = document.getElementById('qc-state');
      sel.value = 'VT';
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);

    await p.evaluate(`document.getElementById('qcm-context-countyScore').click()`);
    const on = await p.evaluate(READ);

    await p.evaluate(`document.getElementById('qcm-context-none').click()`);
    const off = await p.evaluate(READ);

    const stateAfter = await p.evaluate(`document.getElementById('qc-state').value`);
    return { on, off, stateAfter };
  });

  assert.equal(seen.on.colorByHidden, false, 'turning County score on never revealed the metric picker');
  assert.equal(seen.on.scoreControlsHidden, false, 'turning County score on never revealed the wash-strength control');
  assert.doesNotMatch(seen.on.legendText || '', /Turn on County score/,
    'the "turn it on" note is still showing while scores are already on');

  assert.equal(seen.off.colorByHidden, true, 'turning County score off left the metric picker showing');
  assert.equal(seen.off.scoreControlsHidden, true, 'turning County score off left the wash-strength control showing');
  assert.match(seen.off.legendText || '', /Turn on County score/,
    'the legend never reverted to the administrative key when scores went off');

  assert.equal(seen.stateAfter, 'VT',
    'switching context surfaces reset an explicitly chosen county filter — it should keep it');
});

test('Zoom to state never fires on its own — only its own button moves the map', { skip }, async () => {
  const seen = await onDashboard((p) => p.evaluate(`(async () => {
    const before = window.qcMap.getCenter();
    const sel = document.getElementById('qc-state');
    sel.value = 'VT';
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    // Give any (wrongly) queued animation a full second to start and settle.
    await new Promise(r => setTimeout(r, 1000));
    const afterSelect = window.qcMap.getCenter();
    return {
      moved: before.lat !== afterSelect.lat || before.lng !== afterSelect.lng,
      hasButton: !!document.getElementById('qc-zoom-state'),
    };
  })()`));
  assert.ok(seen.hasButton, 'there is no explicit Zoom to state control on the page');
  assert.equal(seen.moved, false,
    'selecting a state moved the map on its own — zoom must be a separate, explicit action');
});
