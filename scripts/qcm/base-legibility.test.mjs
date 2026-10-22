// QQA-06a: the base map has to read. Two numbers decide it -- the base tiles' own opacity
// (source-basemaps.test.mjs) and the county context fill laid over them with scores on.
// With scores off the fill is 0 (county-fill-browser.test.mjs); this file is the arithmetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composite, contextFillFromSource, contrastRatio, contrastThroughFill, hexToRgb, luminance } from './helpers/contrast.mjs';

// The topo's own road lettering on its own paper. #333 is the lettering, #e8e4d8 a
// representative open-ground tile colour. The fill colours are the ones quiet-corners.js
// paints (rural #1a2a3a, other #12121e).
const LETTERING = '#333333';
const PAPER = '#e8e4d8';
const FILL = { rural: '#1a2a3a', other: '#12121e' };
const AA_LARGE = 3;

test('contrast helper: black on white is 21:1, a colour on itself is 1:1', () => {
  assert.equal(contrastRatio([0, 0, 0], [255, 255, 255]), 21);
  assert.equal(contrastRatio([12, 34, 56], [12, 34, 56]), 1);
  assert.equal(luminance([255, 255, 255]), 1);
  assert.equal(luminance([0, 0, 0]), 0);
});

test('contrast helper: composite blends per channel and hexToRgb rejects a non-hex colour', () => {
  assert.deepEqual(composite([0, 0, 0], 0.5, [200, 100, 50]), [100, 50, 25]);
  assert.deepEqual(composite([9, 9, 9], 0, [1, 2, 3]), [1, 2, 3], 'alpha 0 leaves what is underneath');
  assert.deepEqual(composite([9, 9, 9], 1, [1, 2, 3]), [9, 9, 9], 'alpha 1 hides what is underneath');
  assert.deepEqual(hexToRgb('#1a2a3a'), [26, 42, 58]);
  assert.throws(() => hexToRgb('red'), RangeError);
});

test('contrast helper: a stronger fill never reads better than a weaker one', () => {
  let last = Infinity;
  for (const a of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    const c = contrastThroughFill(LETTERING, PAPER, FILL.rural, a);
    assert.ok(c <= last + 1e-9, `alpha ${a} read ${c}, better than the weaker fill before it (${last})`);
    last = c;
  }
});

test('F29: the topo lettering stays >= 3:1 through the county fill drawn with scores on', () => {
  const fill = contextFillFromSource();
  for (const kind of ['rural', 'other']) {
    const ratio = contrastThroughFill(LETTERING, PAPER, FILL[kind], fill[kind]);
    assert.ok(ratio >= AA_LARGE, `${kind} fill at ${fill[kind]} puts #333 lettering at ${ratio.toFixed(2)}:1 on ${PAPER}, under ${AA_LARGE}:1`);
  }
});

test('F29: the rural fill is the strongest that still passes (a stronger one fails)', () => {
  const { rural } = contextFillFromSource();
  assert.ok(contrastThroughFill(LETTERING, PAPER, FILL.rural, rural + 0.01) < AA_LARGE,
    `${rural} is not the largest rural opacity at 3:1; 0.01 more still passes, so the wash is dimmer than it must be`);
});
