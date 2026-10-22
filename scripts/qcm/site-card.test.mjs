// The BLM card, in a real browser: what a reader gets when they open a pin.
//
// The lines are already fixture-tested as STRINGS (blm-rec-sites.test.mjs). What was
// never tested is the step that puts them on a page -- the only step that can undo
// plainText() by assigning provider text as markup -- and "reachable without a mouse",
// which is a claim about real keydown events that an attribute assertion cannot make.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { startModuleServer } from './helpers/module-server.mjs';
import { waitInPage } from './helpers/waits.mjs';

const CHROMIUM = findChromium();
const skip = CHROMIUM ? false : 'no Chromium on this box (set CHROME_PATH to run this proof)';

// Wired exactly as renderOverlay wires it: previewSites for the mark, L.marker with the
// divIcon, then identify() with the card. A harness of its own devising would prove
// something about the harness.
const harness = (origin) => `<!doctype html><meta charset="utf-8"><title>site card</title>
<link rel="stylesheet" href="${origin}/vendor/leaflet.css">
<div id="map" style="width:420px;height:320px"></div>
<script src="${origin}/vendor/leaflet.js"></script>
<script type="module">
import { previewSites, siteCard, identify } from '${origin}/js/preview-overlay.js';
// The canary: if a line were ever assigned as markup, the img's onerror runs.
window.__alerted = false; window.alert = () => { window.__alerted = true; };
const map = L.map('map', { center: [35, -83.5], zoom: 12 });
const overlay = L.layerGroup().addTo(map);
window.__pin = (site, opts) => {
  overlay.clearLayers();
  const [m] = previewSites([site], opts || {});
  const pin = L.marker(m.latlng, {
    icon: L.divIcon({ className: 'qcm-site-marker', html: m.svg,
      iconSize: [m.size, m.size], iconAnchor: [m.size / 2, m.size / 2] }),
    keyboard: true, alt: m.title, title: m.title,
  }).bindTooltip(m.title).addTo(overlay);
  // QUX-11b (§2.6): the near-unpaved phrase moves off the tooltip title and onto
  // the card's own last line, folded in here exactly as main.js's own wiring
  // does once previewSites carries a \`near\` field alongside \`lines\`.
  const cardLines = m.lines ? [...m.lines, m.near].filter(Boolean) : null;
  identify(pin, m.title, cardLines ? siteCard(cardLines) : null);
  window.__pinLayer = pin; window.__el = pin.getElement();
  window.__el.focus();
  return { lines: m.lines, label: window.__el.getAttribute('aria-label'), focused: document.activeElement === window.__el };
};
// QUX-05c: a GNIS name card with action buttons (Copy coordinates / Share
// place). actionsMode selects a canned action list so the harness proves both
// the success and the failure feedback paths without a real clipboard.
window.__pinCard = (lines, actionsMode) => {
  overlay.clearLayers();
  let actions = [];
  if (actionsMode === 'ok') {
    actions = [
      { label: 'Copy coordinates', onActivate: () => Promise.resolve('Coordinates copied') },
      { label: 'Share place', onActivate: () => Promise.resolve('Link copied') },
    ];
  } else if (actionsMode === 'fail') {
    actions = [
      { label: 'Copy coordinates', onActivate: () => Promise.reject(new Error("Couldn't copy — select and copy the text.")) },
    ];
  }
  const pin = L.marker([35, -83.5], { keyboard: true, alt: lines[0], title: lines[0] }).addTo(overlay);
  identify(pin, lines[0], siteCard(lines, { actions }));
  window.__pinLayer = pin; window.__el = pin.getElement();
  window.__el.focus();
  return { label: window.__el.getAttribute('aria-label') };
};
// isPopupOpen(), not the element: Leaflet fades a closed popup out over 200 ms, so the
// card is still in the document for a moment after it has been dismissed.
window.__seen = () => {
  const open = window.__pinLayer.isPopupOpen(), a = document.activeElement;
  const card = open ? window.__pinLayer.getPopup().getContent() : null;
  const buttons = card ? [...card.querySelectorAll('.qcm-site-card-action')] : [];
  const status = card ? card.querySelector('.qcm-site-card-status') : null;
  return { open, text: card && card.textContent, html: card && card.innerHTML,
    lines: card ? [...card.querySelectorAll(':scope > p:not(.qcm-site-card-status)')].map((p) => p.textContent) : null,
    built: document.querySelectorAll('.leaflet-popup-pane script, .leaflet-popup-pane img, .leaflet-popup-pane [onerror]').length,
    tooltip: Boolean(document.querySelector('.leaflet-tooltip')), alerted: window.__alerted,
    actionsLabels: buttons.map((b) => b.textContent),
    statusText: status ? status.textContent : null,
    statusHidden: status ? status.hidden : null,
    statusHeight: status ? status.getBoundingClientRect().height : null,
    focus: a === window.__el ? 'pin' : card && (a === card || card.contains(a)) ? 'card' : a === document.body ? 'body' : String(a.className || a.tagName) };
};
window.__press = (key) => {
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  return window.__seen();
};
window.__ready = true;
</script>`;

const openPage = async (t) => {
  const server = await startModuleServer(harness);
  t.after(() => server.close());
  const browser = await launch(CHROMIUM, server.origin);
  t.after(() => browser.close());
  // Five seconds was the budget here, and Leaflet plus the overlay module over a
  // local server beat it on an idle box and lost on a loaded one -- the failure
  // read as a broken harness rather than as a stopwatch set too short for the
  // machine. Same condition, same message, a ceiling the box can actually meet.
  await waitInPage(browser, 'the harness loaded its modules', 'Boolean(window.__ready)');
  return browser;
};

const BLM = (lines) => ({ symbolKey: 'rec-site', name: 'Afton Canyon', lonLat: [-116.4, 35.0], lines });
// What siteLines() builds for a sparse record, missing-field sentences and all.
const LINES = ['Afton Canyon',
  'Directions: From Barstow, take Interstate 15 east for 35 miles.',
  'About: the record does not say.',
  'The record does not say when BLM last updated it. The record carries no BLM page link.'];

// QUX-11b (§2.6): what siteLines() builds for a Forest Service site (source-rec-sites.js
// is not imported here -- this file proves the DRAWING step, not the line text, which
// source-rec-sites.test.mjs already covers fixture-exact).
const FS = (lines) => ({ symbolKey: 'rec-campground', name: 'Cable Cove', lonLat: [-83.5, 35.0], lines });
const FS_LINES = ['Cable Cove',
  'Type, as the inventory states it: CAMPGROUND',
  'A fee is charged.',
  'Status in the inventory: OPEN — its last sync, not a live check.',
  'Open season: the record does not say.',
  'U.S. Forest Service recreation inventory. Confirm with the managing forest before relying on a site.'];
// A gravel road ~111 m north of the site (0.001 deg of latitude), close enough that
// nearestUnpaved (near-unpaved.js) finds it and the card must still say so.
const FS_ROADS = [{ id: '9', symbolKey: 'mvum-road-yearlong', paths: [[[-83.6, 35.001], [-83.4, 35.001]]] }];
const FS_ROAD_QUALITY = { 9: { surface: 'gravel', surfaceText: 'Crushed aggregate or gravel', maintLevel: 3 } };

test('a BLM pin opens a card a keyboard can shut, and every line of it arrives as text', { skip }, async (t) => {
  const browser = await openPage(t);
  const wired = await browser.evaluate(`window.__pin(${JSON.stringify(BLM(LINES))})`);
  assert.deepEqual(wired.lines, LINES, 'previewSites must carry the lines through to the drawing code');
  assert.equal(wired.label, 'Afton Canyon', 'the pin needs an accessible name');
  assert.equal(wired.focused, true, 'the pin is a real focusable element');
  assert.equal((await browser.evaluate('window.__seen()')).open, false, 'the card is shut until asked for');

  for (const key of ['Enter', ' ']) {
    const opened = await browser.evaluate(`window.__pin(${JSON.stringify(BLM(LINES))}); window.__press(${JSON.stringify(key)})`);
    assert.equal(opened.open, true, `${JSON.stringify(key)} did not open the card`);
    assert.deepEqual(opened.lines, LINES, `${JSON.stringify(key)} opened a card missing lines`);
    assert.equal(opened.focus, 'card', 'the card takes focus, or a reader hears nothing open');
    const shut = await browser.evaluate('window.__press("Escape")');
    assert.equal(shut.open, false, 'Escape did not shut the card');
    assert.equal(shut.focus, 'pin', 'focus was dropped on the floor when the card closed');
  }

  // QUX-11b (§2.6, §4.3) -- the one deliberate change to an existing assertion in
  // this file: a Forest Service site now carries `lines` (siteLines(),
  // source-rec-sites.js), so Enter must open a CARD, not fall back to the tooltip
  // it used to. And the near-unpaved phrase, which used to live in the tooltip's
  // own title, has to survive as the card's own last line now that it moved.
  const near = { roads: FS_ROADS, roadQuality: FS_ROAD_QUALITY };
  const fsWithLines = await browser.evaluate(`window.__pin(${JSON.stringify(FS(FS_LINES))}, ${JSON.stringify(near)})`);
  assert.ok(Array.isArray(fsWithLines.lines) && fsWithLines.lines.length,
    'a Forest Service site with lines must not be treated as line-less');
  const opened = await browser.evaluate('window.__press("Enter")');
  assert.equal(opened.open, true, 'a Forest Service site with lines must open a card, not fall back to a tooltip');
  assert.deepEqual(opened.lines.slice(0, FS_LINES.length), FS_LINES, "the card must show the site's own lines, in order");
  assert.match(opened.text, /0\.1 mi from a mapped crushed aggregate or gravel road \(straight-line\)/,
    'the near-unpaved phrase must survive onto the card now that it no longer lives in the tooltip title');

  // A Forest Service site that genuinely has none still keeps the tooltip-only
  // fallback -- unchanged from before 11b, just no longer the only case this file proves.
  const fs = await browser.evaluate(`window.__pin(${JSON.stringify({ symbolKey: 'rec-campground', name: 'Cable Cove', lonLat: [-83.5, 35.0] })})`);
  assert.equal(fs.lines, null, 'a site with no lines must not be given an empty card');
  const plain = await browser.evaluate('window.__press("Enter")');
  assert.equal(plain.open, false, 'a card was invented for a site with no lines to put in it');
  assert.equal(plain.tooltip, true, 'Enter must still open the tooltip it always opened');

  // And whatever the record itself carries arrives as TEXT: this is the one step that
  // can undo plainText(), by assigning a field as markup instead of setting it.
  const hostile = '<script>alert(1)</script><img src=x onerror=alert(1)> Camp here.';
  const seen = await browser.evaluate(`window.__pin(${JSON.stringify(BLM(['Afton Canyon', `Directions: ${hostile}`]))});
    window.__press('Enter')`);
  assert.equal(seen.built, 0, 'a script, an img or an inline handler was built out of the record');
  assert.ok(seen.text.includes(hostile), `the line was altered on its way to the page: ${JSON.stringify(seen.text)}`);
  assert.match(seen.html, /&lt;script&gt;/, 'the angle brackets must be escaped in the markup, not parsed');
  // An img's onerror fires a turn later, so the canary is only worth reading once the page
  // has had the chance. Read at once it was false even against a mutated builder assigning
  // innerHTML, which is why the counts above, not this, are the gates that bite.
  const settled = await browser.evaluate('new Promise((r) => setTimeout(() => r(window.__seen()), 400))');
  assert.equal(settled.alerted, false, 'the record EXECUTED: an inline handler in a BLM field ran');
});

// QUX-05c: the one GNIS name card carries two actions (Copy coordinates, Share
// place) with visible success/failure feedback, and the card's own bubbling
// keydown handler must not hijack Enter/Space on a focused action button.
const GNIS_LINES = ['Cold Mountain', 'Named summit', 'Haywood, NC', 'Source: USGS GNIS',
  'Coordinates: 35.4132, -82.9987',
  'Location is the published primary point, not every place this name is used.'];

test('a GNIS card\'s actions report success and never let the card\'s own keydown handler steal a button\'s Enter', { skip }, async (t) => {
  const browser = await openPage(t);
  await browser.evaluate(`window.__pinCard(${JSON.stringify(GNIS_LINES)}, 'ok')`);
  const opened = await browser.evaluate('window.__press("Enter")');
  assert.equal(opened.open, true, 'Enter did not open the GNIS card');
  assert.deepEqual(opened.actionsLabels, ['Copy coordinates', 'Share place'], 'both actions, in order');
  // spec-a11y-2 -- the one deliberate change to an existing assertion in this file: this
  // used to require `status.hidden`, and a status line that starts hidden is exactly what
  // keeps a screen reader from hearing it change (the live-region test below). "Nothing is
  // shown" is now measured as what the reader sees: no text, and no height on the card.
  assert.equal(opened.statusText, '', 'no status text is shown before an action runs');
  assert.equal(opened.statusHeight, 0, 'the empty status line takes room on the card before an action runs');

  await browser.evaluate(`document.querySelectorAll('.qcm-site-card-action')[0].click()`);
  const afterCopy = await browser.evaluate('new Promise((r) => setTimeout(() => r(window.__seen()), 80))');
  assert.equal(afterCopy.open, true, 'the card stayed open after the action ran');
  assert.equal(afterCopy.statusText, 'Coordinates copied', 'the success feedback text was not shown');

  // Keyboard-scoping proof: a synthetic Enter dispatched ON the focused Share
  // button must not be caught and preventDefault()'d by the card-level
  // bubbling handler meant for the pin's own Enter/Space activation. dispatchEvent's
  // own boolean return value tells us whether preventDefault() was called --
  // native activation semantics do not fire for a synthetic event, so this is
  // the only way to observe the bug from outside the page.
  const scoped = await browser.evaluate(`(() => {
    const btn = document.querySelectorAll('.qcm-site-card-action')[1];
    btn.focus();
    const evt = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    const notPrevented = btn.dispatchEvent(evt);
    return { notPrevented };
  })()`);
  assert.equal(scoped.notPrevented, true, 'the card\'s bubbling keydown handler called preventDefault() on a focused action button\'s own Enter');
});

test('a GNIS card action that fails shows the failure text, never silently', { skip }, async (t) => {
  const browser = await openPage(t);
  await browser.evaluate(`window.__pinCard(${JSON.stringify(GNIS_LINES)}, 'fail')`);
  await browser.evaluate('window.__press("Enter")');
  await browser.evaluate(`document.querySelectorAll('.qcm-site-card-action')[0].click()`);
  const after = await browser.evaluate('new Promise((r) => setTimeout(() => r(window.__seen()), 80))');
  assert.equal(after.statusHidden, false, 'a failed action must show status, not stay hidden');
  assert.match(after.statusText, /couldn.t copy/i, 'the failure text must say the copy did not work');
});

/** The live regions Chromium's own accessibility tree carries, over the DevTools protocol:
 *  what a screen reader is handed is a computed tree, and reading the DOM back cannot say
 *  whether a region made it into that tree (finder-loading.test.mjs reads it the same way). */
const liveRegions = async (browser) => {
  await browser.send('Accessibility.enable');
  const { nodes } = await browser.send('Accessibility.getFullAXTree');
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  // Leaf text only: Chromium also names a status region from its contents, so adding the
  // region's own name to its children's would read every sentence twice.
  const textOf = (n) => (n.childIds?.length
    ? n.childIds.map((id) => (byId.has(id) ? textOf(byId.get(id)) : '')).join(' ')
    : n.name?.value ?? '').trim();
  return nodes.filter((n) => !n.ignored && n.role?.value === 'status')
    .map((n) => ({ live: (n.properties ?? []).find((p) => p.name === 'live')?.value?.value ?? null, text: textOf(n) }));
};

// spec-a11y-2 (WCAG 4.1.3, status messages): "Coordinates copied" or "Couldn't copy" is
// the only answer a reader gets to pressing an action, and it appears with focus still
// on the button, so a screen reader hears it only when it is written into a live region
// that was ALREADY in the accessibility tree when the text changed. A line that starts
// hidden is not in the tree; revealing it and filling it in the same turn is announced
// by some screen readers and not by others. THE LIMIT OF THIS PROOF, as in
// finder-announcement.test.mjs: it shows the tree carries a polite region before and
// the text after; it does not drive a screen reader.
test('a card action\'s answer is written into a polite live region that was in the accessibility tree before it', { skip }, async (t) => {
  const browser = await openPage(t);
  await browser.evaluate(`window.__pinCard(${JSON.stringify(GNIS_LINES)}, 'ok')`);
  const opened = await browser.evaluate('window.__press("Enter")');
  assert.equal(opened.open, true, 'Enter did not open the GNIS card');
  const before = await liveRegions(browser);
  assert.equal(before.length, 1,
    `the open card has ${before.length} status regions in the accessibility tree before an action runs; `
    + 'a region that is not there yet cannot announce the answer');
  assert.equal(before[0].live, 'polite', `the region is aria-live "${before[0].live}" -- an action's answer is polite, never assertive`);
  assert.equal(before[0].text, '', `the region already says "${before[0].text}" before anything ran`);

  await browser.evaluate(`document.querySelectorAll('.qcm-site-card-action')[0].click()`);
  await browser.evaluate('new Promise((r) => setTimeout(r, 80))');
  const after = await liveRegions(browser);
  assert.equal(after.length, 1, `the card has ${after.length} status regions after the action ran`);
  assert.equal(after[0].text, 'Coordinates copied', `the screen reader is handed "${after[0].text}"`);

  // A card with no actions has nothing to report, so it carries no region at all
  // (siteCard stays byte-identical to before for it -- camera-card.test.mjs test 1).
  await browser.evaluate(`window.__pinCard(${JSON.stringify(GNIS_LINES)}, 'none')`);
  await browser.evaluate('window.__press("Enter")');
  // The previous card fades out over 200 ms and carries its own region until it is gone.
  await waitInPage(browser, 'the previous card to leave the page', "document.querySelectorAll('.leaflet-popup').length === 1");
  assert.deepEqual(await liveRegions(browser), [], 'a card with no actions grew a status region');
});

// A redraw reopens the selected pin's card from code (main.js renderNames:
// `if (p.selected) pin.openPopup()` after every renderSources), long after the
// reader chose it and often while they are working somewhere else on the page.
// The card may still take focus, but it must never SCROLL the page to do it:
// autoPan is off (preview-overlay.js's CARD_POPUP), so nothing else moves the
// view for the card either, and a page jump moves whatever control the reader
// was about to click out from under the pointer (saved-places-browser.test.mjs
// test 3, a Share click that missed on loaded CI runners because the card's
// focus() scrolled the page between the click's aim and its press).
test('a card reopened from code takes focus without scrolling the page', { skip }, async (t) => {
  const browser = await openPage(t);
  await browser.evaluate(`window.__pinCard(${JSON.stringify(GNIS_LINES)}, 'ok')`);
  const moved = await browser.evaluate(`(() => {
    const spacer = document.createElement('div');
    spacer.style.height = '4000px';
    document.body.appendChild(spacer);
    window.scrollTo(0, 2000);
    const before = window.scrollY;
    window.__pinLayer.openPopup();
    return { before, after: window.scrollY, seen: window.__seen() };
  })()`);
  assert.equal(moved.seen.open, true, 'openPopup() did not open the card');
  assert.equal(moved.seen.focus, 'card', 'the reopened card should still take focus');
  assert.equal(moved.after, moved.before, `opening the card scrolled the page from ${moved.before} to ${moved.after}`);
});
