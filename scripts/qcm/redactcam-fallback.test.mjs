// The redactcam page's fallback note: its link must not rely on color alone.
//
// pa11y failed PR CI run 36640726267 (#652, which does not touch redactcam) with
//
//     Links must be distinguishable without relying on color    (#rc-fallback > a)
//
// The note sits on screen until redactcam-demo.js has fetched plate-gate.json and
// added .rc-ready, and it stays there for anyone without JavaScript. So the failure
// is real (WCAG 1.4.1), but pa11y only saw it when it audited the page before that
// fetch finished: 1 of the 28 failed PR CI runs with a log among the 60 up to that
// one. This proof holds the fetch open so the note is always on screen, then runs the
// rule pa11y reported, axe's link-in-text-block, on it.
//
// It lives here, not beside the page, because scripts/qcm/*.test.mjs is the glob PR CI
// hands `node --test`, and the site server and browser helpers are here too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findChromium, launch } from './helpers/browser.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';

// pa11y-ci's own copy: the rule engine the CI gate runs.
const AXE = fileURLToPath(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url));
const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt('redactcam') ? 'public/redactcam/ not built — run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : !existsSync(AXE) ? 'node_modules/axe-core missing — run `npm ci` first'
      : false;

test('the redactcam fallback note link is distinguishable without color', { skip }, async () => {
  const site = await startSiteServer({ hold: /^\/data\/redactcam\/plate-gate\.json$/ });
  const page = await launch(CHROMIUM, `${site.origin}/redactcam/`, { viewport: { width: 1280, height: 900 } });
  try {
    const display = await page.evaluate(`getComputedStyle(document.getElementById('rc-fallback')).display`);
    assert.notEqual(display, 'none', 'the fallback note should be on screen while plate-gate.json is held');
    await page.evaluate(readFileSync(AXE, 'utf8'));
    const r = await page.evaluate(`axe.run(document.getElementById('rc-fallback'),
      { runOnly: { type: 'rule', values: ['link-in-text-block'] } })
      .then((res) => ({
        failed: res.violations.flatMap((v) => v.nodes.map((n) => n.target.join(' '))),
        passed: res.passes.flatMap((v) => v.nodes.map((n) => n.target.join(' '))),
      }))`);
    assert.deepEqual(r.failed, [], `link-in-text-block failed on ${r.failed.join(', ')}`);
    // Not a vacuous pass: the rule has to have looked at the note's link and cleared it.
    assert.deepEqual(r.passed, ['#rc-fallback > a'], 'link-in-text-block should check and pass the note link');
  } finally {
    page.close();
    await site.close();
  }
});
