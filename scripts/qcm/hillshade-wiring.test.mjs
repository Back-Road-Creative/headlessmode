// D1: wiring D2's hillshade CONTEXT_ROW into the layer registry and into main.js's fetch
// path. source-hillshade.js's own header says this row is deliberately NOT in LAYERS --
// "the unit that wires the reader appends this row (layers-reach-paper guard)" -- this is
// that unit. Pure/static checks only; the browser-driven proof that main.js actually draws
// it lives in layout.test.mjs / a browser test, not here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONTEXT_ROW } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-hillshade.js';
import { LAYERS, LAYER_BY_ID, CONTEXT_LAYER_IDS, contextControlSpecs } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';

test('the hillshade CONTEXT_ROW is appended to LAYERS exactly as D2 built it', () => {
  const found = LAYER_BY_ID[CONTEXT_ROW.id];
  assert.ok(found, 'hillshadeLight must be registered');
  assert.deepEqual(found, CONTEXT_ROW, 'the registered row must be D2\'s row unmodified -- D1 appends, never redesigns');
});

test('hillshadeLight joins the context radio group alongside the other context surfaces', () => {
  assert.ok(CONTEXT_LAYER_IDS.includes('hillshadeLight'));
  const specs = contextControlSpecs('hillshadeLight');
  const spec = specs.find((s) => s.id === 'hillshadeLight');
  assert.ok(spec, 'contextControlSpecs must offer a row for hillshadeLight');
  assert.equal(spec.checked, true, 'selecting hillshadeLight as the current context must check its own row');
});

test('main.js reads the hillshadeLight switch: a render function is wired into CONTEXT_RENDER by name (layers-reach-paper guard)', () => {
  const src = readFileSync(fileURLToPath(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url)), 'utf8');
  const tableMatch = src.match(/const CONTEXT_RENDER = \{[\s\S]*?\};/);
  assert.ok(tableMatch, 'CONTEXT_RENDER table must exist');
  assert.match(tableMatch[0], /hillshadeLight:\s*renderHillshade/, 'hillshadeLight must map to a named render function, the same static-analysis shape layers-reach-paper.test.mjs checks every other context row against');
  assert.match(src, /function renderHillshade\s*\(/, 'renderHillshade must be a named function declaration (not a const arrow), matching renderTerrain/renderLandCover');
});
