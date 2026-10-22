// What "ready" is allowed to mean in the field-maps app.
//
// Audit F14 / #434 follow-up. Every adapter here returns `coverage`, which is
// 'complete' only when the service stopped flagging more pages
// (quiet-corners-maps/arcgis-pager.js). `mvum`, `federalLand`, `countyLines` and
// the state-land loop all read it. `recSites` and `trails` threw it away and
// wrote 'ready' whenever the fetch did not throw — so a rectangle past the
// transfer limit printed a sheet missing sites and trails, and the source panel
// said the layer was ready. A truncated set is the worst kind of wrong on paper:
// it looks finished.
//
// The general gate is the point. Naming the two layers that were broken would
// pass again the moment a third layer is added the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MAIN = readFileSync(
  new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');

/** The `if (layers.<id>) { … }` block, by brace matching from its header. */
function layerBlock(id) {
  const head = new RegExp(`if \\((?:recipe\\.)?layers\\.${id}\\) \\{`);
  const found = head.exec(MAIN);
  assert.ok(found, `main.js has no fetch block for ${id}`);
  const at = found.index;
  let depth = 0;
  for (let i = at + found[0].length - 1; i < MAIN.length; i++) {
    if (MAIN[i] === '{') depth += 1;
    else if (MAIN[i] === '}' && --depth === 0) return MAIN.slice(at, i + 1);
  }
  throw new Error(`unbalanced braces after ${head}`);
}

test('no layer reports ready without asking its answer whether it is complete', () => {
  const hardcoded = [...MAIN.matchAll(/state\.states\.(\w+)\s*=\s*'ready'/g)].map((m) => m[1]);
  assert.deepEqual(hardcoded, [],
    `${hardcoded.join(', ')} write 'ready' as a literal, so a first-page-only answer `
    + 'reports as a complete one. Derive the state from the adapter\'s `coverage`, '
    + 'the way countyLines and federalLand already do.');
});

for (const id of ['recSites', 'trails']) {
  test(`the ${id} block decides its state from the coverage it was handed`, () => {
    const block = layerBlock(id);
    assert.match(block, /coverage/,
      `the ${id} block never looks at coverage, so paging past the transfer limit `
      + 'cannot change what it reports');
    assert.match(block, /'partial'/,
      `the ${id} block can never report a partial answer`);
    assert.match(block, /'unavailable'/,
      `the ${id} block no longer reports a failed fetch as unavailable`);
  });
}
