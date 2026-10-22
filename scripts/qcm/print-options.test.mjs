// QUX-03b-iii: the print builder shows its build flow first (Area, Scale, the
// estimate, Check sources, Build/Download) and puts everything else — Paper,
// Overlap, Grid, Quality, the map-key sheet and the calibration sheet — behind
// one closed `<details class="qcm-print-options"><summary>Options</summary>`
// after it. The panel's own 50vh cap below 1024px (audit A11,
// scripts/qcm/layout.test.mjs) leaves no room to scroll past a paper recipe just
// to reach Build; the primary flow has to be what a reader meets first.
//
// Same Chromium/CDP technique as panel-shell-browser.test.mjs: real, trusted
// input over the DevTools protocol (Input.dispatchMouseEvent), not `.click()` in
// the page, through the shared helpers/trusted-click.mjs; the skip guard and the
// shared-browser/site-server pattern are copied from there.
//
// Chromium drops closed-<details> content from hit-testing (the comment at
// themes/headlessmode/layouts/partials/qcm-map-layers.html:52-53): content
// inside a closed <details> keeps its layout geometry (content-visibility:
// hidden, not display:none) but is not painted, so document.elementFromPoint at
// its centre lands on whatever IS painted there instead. That is the mechanism
// every hit-test below uses to tell "reachable" from "behind a closed
// disclosure" apart, exactly as the brief for this unit specifies.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { trustedClick } from './helpers/trusted-click.mjs';
import { startSiteServer, siteIsBuilt } from './helpers/site-server.mjs';
import { readyDashboard, waitInPage } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !siteIsBuilt() ? 'public/quiet-corners/ not built — run `bash scripts/build-site.sh --configDir site-config --minify` first'
    : false;

const VIEWPORTS = [{ w: 390, h: 844 }, { w: 1440, h: 900 }];
const TOUCH_GOAL = 44;

// A click that only sets up a proof is pressed again until it took (`until`). PR CI run
// 36644039461 (#652) failed the key-sheet proof at 1440x900 because its first press had not
// opened #qcm-app. The clicks these tests prove are pressed once and asserted.
const PRINT_OPEN = "document.getElementById('qcm-app').open";
const OPTIONS_OPEN = "document.querySelector('details.qcm-print-options').open";

let shared = null;
async function sharedBrowser() {
  if (!shared) {
    const site = await startSiteServer();
    const page = await launch(CHROMIUM, `${site.origin}/quiet-corners/`, {
      args: ['--hide-scrollbars'],
    });
    shared = { site, page };
  }
  return shared;
}
after(async () => {
  if (!shared) return;
  shared.page.close();
  await shared.site.close();
});

async function freshPage(viewport) {
  const { site, page } = await sharedBrowser();
  await page.setViewport({ width: viewport.w, height: viewport.h });
  await page.navigate(`${site.origin}/quiet-corners/`);
  await readyDashboard(page, { data: false });
  return page;
}

/** Scrolls `sel` into view, then asks whether the real pixel at its centre is
 *  painted by it (or by a descendant, or by the <label> wrapping it) — the same
 *  "is this reachable to a real pointer" question phone-controls.test.mjs and
 *  layout.test.mjs already ask, just returned as data instead of asserted
 *  directly so both the "reachable" and "not reachable" directions can share
 *  one expression. */
function hitTestable(sel) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return { found: false };
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return { found: true, ok: false, reason: 'zero-size rect' };
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    if (!hit) return { found: true, ok: false, reason: 'nothing painted at its centre' };
    const label = el.closest('label');
    const ok = hit === el || el.contains(hit) || hit.contains(el)
      || (label && (hit === label || label.contains(hit)));
    const hitDesc = hit.id ? '#' + hit.id
      : hit.tagName.toLowerCase() + (hit.className ? '.' + String(hit.className).trim().split(/\\s+/)[0] : '');
    return { found: true, ok, reason: ok ? null : 'painted under ' + hitDesc };
  })()`;
}

async function assertHitTestable(page, sel, viewport) {
  const res = await page.evaluate(hitTestable(sel));
  assert.ok(res.found, `${sel} is missing from the page at ${viewport.w}x${viewport.h}`);
  assert.ok(res.ok, `${sel} is not hit-testable at ${viewport.w}x${viewport.h} in the primary flow: ${res.reason}`);
}

async function assertNotHitTestable(page, sel, viewport) {
  const res = await page.evaluate(hitTestable(sel));
  assert.ok(res.found, `${sel} is missing from the page at ${viewport.w}x${viewport.h}`);
  assert.equal(res.ok, false,
    `${sel} is hit-testable at ${viewport.w}x${viewport.h} while the Options disclosure is closed — it should be dropped from hit-testing`);
}

const PRIMARY_FLOW = ['#qcm-build', '#qcm-check', '#qcm-scale', '#qcm-draw'];
const UNDER_OPTIONS = ['#qcm-key-sheet', '#qcm-calibrate', '#qcm-overlap', 'input[name="qcm-dpi"]'];

for (const vp of VIEWPORTS) {
  test(`primary flow is reachable and Options controls are not, before Options is opened (${vp.w}x${vp.h})`, { skip }, async () => {
    const page = await freshPage(vp);
    await trustedClick(page, '#qcm-app summary');
    assert.equal(await page.evaluate("document.getElementById('qcm-app').open"), true,
      'clicking the print panel summary did not open it');

    for (const sel of PRIMARY_FLOW) await assertHitTestable(page, sel, vp);
    for (const sel of UNDER_OPTIONS) await assertNotHitTestable(page, sel, vp);
  });

  test(`the Options summary follows #qcm-download in document order, and holds Paper/Overlap/Grid/Quality plus both extra sheets (${vp.w}x${vp.h})`, { skip }, async () => {
    const page = await freshPage(vp);
    await trustedClick(page, '#qcm-app summary');

    const seen = await page.evaluate(`(() => {
      const dl = document.getElementById('qcm-download');
      const details = document.querySelector('details.qcm-print-options');
      const summary = details ? details.querySelector(':scope > summary') : null;
      if (!dl || !details || !summary) {
        return { missing: true, hasDl: !!dl, hasDetails: !!details, hasSummary: !!summary };
      }
      const rel = dl.compareDocumentPosition(summary);
      return {
        missing: false,
        summaryFollowsDownload: !!(rel & Node.DOCUMENT_POSITION_FOLLOWING),
        legends: [...details.querySelectorAll(':scope > fieldset > legend')].map((l) => l.textContent.trim()),
        keySheetInside: !!details.querySelector('#qcm-key-sheet'),
        keySheetDownloadInside: !!details.querySelector('#qcm-key-sheet-download'),
        calibrateInside: !!details.querySelector('#qcm-calibrate'),
        calibrationDownloadInside: !!details.querySelector('#qcm-calibration-download'),
      };
    })()`);

    assert.equal(seen.missing, false,
      `#qcm-download, details.qcm-print-options or its summary is missing: ${JSON.stringify(seen)}`);
    assert.equal(seen.summaryFollowsDownload, true,
      'the Options summary does not follow #qcm-download in document order — Options must come after the primary flow');
    assert.deepEqual(seen.legends, ['Paper', 'Overlap', 'Grid', 'Quality'],
      `details.qcm-print-options must hold exactly the Paper/Overlap/Grid/Quality fieldsets, in that order — saw ${JSON.stringify(seen.legends)}`);
    assert.ok(seen.keySheetInside, '#qcm-key-sheet must be inside details.qcm-print-options');
    assert.ok(seen.keySheetDownloadInside, '#qcm-key-sheet-download must be inside details.qcm-print-options');
    assert.ok(seen.calibrateInside, '#qcm-calibrate must be inside details.qcm-print-options');
    assert.ok(seen.calibrationDownloadInside, '#qcm-calibration-download must be inside details.qcm-print-options');
  });

  test(`opening Options reveals its controls, and the summary is a real touch target (${vp.w}x${vp.h})`, { skip }, async () => {
    const page = await freshPage(vp);
    await trustedClick(page, '#qcm-app summary', { until: PRINT_OPEN });
    await trustedClick(page, 'details.qcm-print-options > summary');
    assert.equal(await page.evaluate("document.querySelector('details.qcm-print-options').open"), true,
      'clicking the Options summary did not open it');

    for (const sel of UNDER_OPTIONS) await assertHitTestable(page, sel, vp);

    if (vp.w === 390) {
      const box = await page.evaluate(`(() => {
        const r = document.querySelector('details.qcm-print-options > summary').getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      })()`);
      assert.ok(box.h >= TOUCH_GOAL,
        `the Options summary measures ${box.w}x${box.h} at 390x844 — must be at least ${TOUCH_GOAL}px tall`);
    }
  });

  test(`clicking the key-sheet button once Options is open unhides its download link (${vp.w}x${vp.h})`, { skip }, async () => {
    const page = await freshPage(vp);
    await trustedClick(page, '#qcm-app summary', { until: PRINT_OPEN });
    await trustedClick(page, 'details.qcm-print-options > summary', { until: OPTIONS_OPEN });
    await trustedClick(page, '#qcm-key-sheet');
    await waitInPage(page, '#qcm-key-sheet-download to lose hidden',
      "document.getElementById('qcm-key-sheet-download').hidden === false");
    const hidden = await page.evaluate("document.getElementById('qcm-key-sheet-download').hidden");
    assert.equal(hidden, false, '#qcm-key-sheet-download is still hidden after #qcm-key-sheet was clicked — the by-id wiring did not survive the move');
  });
}
