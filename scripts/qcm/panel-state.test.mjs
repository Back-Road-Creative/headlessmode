import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PANEL_IDS,
  SHEET_SIZES,
  initialState,
  openPanel,
  closePanel,
  backPanel,
  focusTarget,
  resizeSheet,
  snapSheet,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/panel-state.js';

// QUX-03b-ii: Conditions (the moved sky/forecast/alerts cards) joins layers/print/
// explore as a fourth panel id, the same way explore joined the original two.
test('PANEL_IDS: a fourth panel, Conditions, joins layers/print/explore', () => {
  assert.ok(PANEL_IDS.includes('conditions'),
    `PANEL_IDS ${JSON.stringify(PANEL_IDS)} does not include 'conditions'`);
});

test('openPanel: opening a second panel pushes the first onto history', () => {
  const s1 = openPanel(initialState(), 'layers', 'layers-btn');
  const s2 = openPanel(s1, 'print', 'print-btn');
  assert.equal(s2.open, 'print');
  assert.ok(s2.history.includes('layers'), `history ${JSON.stringify(s2.history)} does not contain 'layers'`);
});

test('openPanel: opening the SAME panel again is a no-op on history', () => {
  const s1 = openPanel(initialState(), 'layers', 'layers-btn');
  const s2 = openPanel(s1, 'layers', 'layers-btn');
  assert.deepEqual(s2.history, s1.history);
  assert.equal(s2.open, 'layers');
});

test('closePanel: does not touch history', () => {
  const opened = openPanel(openPanel(initialState(), 'layers', 'a'), 'print', 'b');
  const closed = closePanel(opened);
  assert.equal(closed.open, null);
  assert.deepEqual(closed.history, opened.history);
});

test('backPanel: with empty history, closes', () => {
  const s = openPanel(initialState(), 'layers', 'layers-btn');
  const back = backPanel(s);
  assert.equal(back.open, null);
  assert.deepEqual(back.history, []);
});

test('backPanel: with history, reopens the last entry and pops it', () => {
  const s = openPanel(openPanel(initialState(), 'layers', 'a'), 'print', 'b');
  const back = backPanel(s);
  assert.equal(back.open, 'layers');
  assert.deepEqual(back.history, []);
});

test('focusTarget: openPanel records the opener id passed in', () => {
  const s = openPanel(initialState(), 'layers', 'layers-btn');
  assert.equal(focusTarget(closePanel(s)), 'layers-btn');
});

test('focusTarget: null while a panel is still open', () => {
  const s = openPanel(initialState(), 'layers', 'layers-btn');
  assert.equal(focusTarget(s), null);
});

test('focusTarget: closePanel/backPanel do not clear the opener until the panel is '
  + 'actually closed with nothing to go back to', () => {
  // Open layers (opener recorded), switch to print (opener must survive the switch),
  // then Back to layers (still open — focusTarget must stay null), then Back again
  // (now closed with nothing left — focusTarget must finally return the ORIGINAL
  // opener, not whatever id the print switch passed).
  let s = openPanel(initialState(), 'layers', 'layers-btn');
  s = openPanel(s, 'print', 'print-btn');
  assert.equal(focusTarget(s), null, 'still open (print) — nothing to restore yet');
  s = backPanel(s);
  assert.equal(s.open, 'layers');
  assert.equal(focusTarget(s), null, 'still open (layers, via back) — nothing to restore yet');
  s = backPanel(s);
  assert.equal(s.open, null);
  assert.equal(focusTarget(s), 'layers-btn', 'closed with nothing to go back to — must restore the ORIGINAL opener');
});

test('backPanel: a second Back keeps moving backward, never bounces between two panels', () => {
  let s = openPanel(initialState(), 'layers', 'a');
  s = openPanel(s, 'print', 'b');
  s = openPanel(s, 'layers', 'a2'); // switch back to layers (already-visited id, but not the CURRENT open, so this is a real switch)
  // history now: ['layers' popped is wrong path -- exercise the actual stack shape.
  assert.deepEqual(s.history, ['layers', 'print']);
  s = backPanel(s);
  assert.equal(s.open, 'print');
  assert.deepEqual(s.history, ['layers']);
  s = backPanel(s);
  assert.equal(s.open, 'layers');
  assert.deepEqual(s.history, []);
});

// QUX-03c: the sheet (`state.sheet`, one of SHEET_SIZES) that shows whichever panel
// is open below 1024px. Invariant under test throughout: sheet === 'collapsed' <=>
// open === null.

test('initialState: sheet starts collapsed, matching open === null', () => {
  const s = initialState();
  assert.equal(s.sheet, 'collapsed');
  assert.equal(s.open, null);
});

test('openPanel: opening from fully closed sets the sheet to half', () => {
  const s = openPanel(initialState(), 'layers', 'a');
  assert.equal(s.sheet, 'half');
});

test('openPanel: switching panels while the sheet is expanded keeps it expanded', () => {
  let s = openPanel(initialState(), 'layers', 'a');
  s = resizeSheet(s, 'expanded');
  s = openPanel(s, 'print', 'b');
  assert.equal(s.open, 'print');
  assert.equal(s.sheet, 'expanded', 'paging to another panel snapped the sheet back down');
});

test('closePanel: sheet returns to collapsed', () => {
  let s = openPanel(initialState(), 'layers', 'a');
  s = resizeSheet(s, 'expanded');
  s = closePanel(s);
  assert.equal(s.open, null);
  assert.equal(s.sheet, 'collapsed');
});

test('backPanel: emptying the history (closing) also collapses the sheet', () => {
  let s = openPanel(initialState(), 'layers', 'a');
  s = resizeSheet(s, 'half');
  s = backPanel(s);
  assert.equal(s.open, null);
  assert.equal(s.sheet, 'collapsed');
});

test('backPanel: reopening a previous panel keeps the sheet size it had', () => {
  let s = openPanel(initialState(), 'layers', 'a');
  s = openPanel(s, 'print', 'b');
  s = resizeSheet(s, 'expanded');
  s = backPanel(s);
  assert.equal(s.open, 'layers');
  assert.equal(s.sheet, 'expanded', 'back-to-previous must not reset the sheet size');
});

test('resizeSheet: an unrecognised size is a no-op', () => {
  const s = openPanel(initialState(), 'layers', 'a');
  const r = resizeSheet(s, 'huge');
  assert.deepEqual(r, s);
});

test('resizeSheet: nothing open stays collapsed regardless of the requested size', () => {
  const r = resizeSheet(initialState(), 'expanded');
  assert.equal(r.open, null);
  assert.equal(r.sheet, 'collapsed');
});

test('resizeSheet: sizing down to collapsed closes the panel and keeps the opener', () => {
  const s = openPanel(initialState(), 'layers', 'layers-btn');
  const r = resizeSheet(s, 'collapsed');
  assert.equal(r.open, null);
  assert.equal(r.sheet, 'collapsed');
  assert.equal(focusTarget(r), 'layers-btn', 'resizeSheet to collapsed must behave like Close, not drop the opener');
});

test('snapSheet: from collapsed, a drag is always a no-op', () => {
  const s = initialState();
  assert.deepEqual(snapSheet(s, 500, 600), s);
  assert.deepEqual(snapSheet(s, -500, 600), s);
});

test('snapSheet: from half, an upward swipe past the threshold expands', () => {
  const s = resizeSheet(openPanel(initialState(), 'layers', 'a'), 'half');
  const r = snapSheet(s, -121, 600); // threshold = 600*0.2 = 120
  assert.equal(r.sheet, 'expanded');
});

test('snapSheet: from half, a downward swipe past the threshold closes', () => {
  const s = resizeSheet(openPanel(initialState(), 'layers', 'a'), 'half');
  const r = snapSheet(s, 121, 600);
  assert.equal(r.open, null);
  assert.equal(r.sheet, 'collapsed');
});

test('snapSheet: from half, a small swipe snaps back to half', () => {
  const s = resizeSheet(openPanel(initialState(), 'layers', 'a'), 'half');
  const r = snapSheet(s, 30, 600);
  assert.equal(r.sheet, 'half');
  assert.equal(r.open, 'layers');
});

test('snapSheet: from expanded, a swipe past 3x the threshold closes outright', () => {
  const s = resizeSheet(openPanel(initialState(), 'layers', 'a'), 'expanded');
  const r = snapSheet(s, 361, 600); // 3x threshold = 360
  assert.equal(r.open, null);
  assert.equal(r.sheet, 'collapsed');
});

test('snapSheet: from expanded, a swipe past the threshold but under 3x drops to half', () => {
  const s = resizeSheet(openPanel(initialState(), 'layers', 'a'), 'expanded');
  const r = snapSheet(s, 200, 600);
  assert.equal(r.sheet, 'half');
  assert.equal(r.open, 'layers');
});

test('snapSheet: from expanded, a small swipe snaps back to expanded', () => {
  const s = resizeSheet(openPanel(initialState(), 'layers', 'a'), 'expanded');
  const r = snapSheet(s, 10, 600);
  assert.equal(r.sheet, 'expanded');
});

// Deterministic PRNG (mulberry32) so this walk is reproducible across runs/machines
// instead of a real Math.random() flaking once in however many CI runs.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('invariant: sheet === "collapsed" iff open === null, across a random walk of every transition', () => {
  const rand = mulberry32(20260928);
  const ids = ['layers', 'print', 'explore', 'conditions'];
  let s = initialState();
  const checkInvariant = (state, step) => {
    assert.equal(state.sheet === 'collapsed', state.open === null,
      `invariant broken at step ${step}: sheet=${state.sheet} open=${JSON.stringify(state.open)}`);
  };
  checkInvariant(s, 0);
  for (let i = 0; i < 200; i++) {
    const action = Math.floor(rand() * 5);
    if (action === 0) {
      const id = ids[Math.floor(rand() * ids.length)];
      s = openPanel(s, id, `opener-${id}`);
    } else if (action === 1) {
      s = closePanel(s);
    } else if (action === 2) {
      s = backPanel(s);
    } else if (action === 3) {
      const size = SHEET_SIZES[Math.floor(rand() * SHEET_SIZES.length)];
      s = resizeSheet(s, size);
    } else {
      const dy = Math.floor(rand() * 400) - 200;
      s = snapSheet(s, dy, 600);
    }
    checkInvariant(s, i + 1);
  }
});
