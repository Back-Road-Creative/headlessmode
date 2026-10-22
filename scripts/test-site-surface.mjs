// The marketing-site surface claims that used to ride inside the Field Maps suite
// (scripts/qcm/print-proof.test.mjs): what data/systems.json and static/llms.txt may say, and
// what may sit under data/. They read site files, not the app, so they run in EVERY PR CI tier
// (named in the run step beside test-verify-claims.js) and a site-only change keeps them
// without paying for the Field Maps suite. Run: node --test scripts/test-site-surface.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname } from 'node:path';

// The physical-print assertions (paper size, map scales) are made by ONE file, the Field Maps
// controls partial, which carries the "not yet verified on paper" caveat rendered from
// data/quiet-corners-maps/print-proof.json. Any other surface making the promise would ship it
// without the caveat. print-proof.test.mjs holds the app side; this holds the site side.
const PHYSICAL_CLAIMS = ['1:24,000', '1:48,000', 'Letter'];
// A surface hosts the builder iff it loads the module (print-proof.test.mjs's HOST_MARKER).
const HOST_MARKER = 'js/quiet-corners-maps/main.js';

const SURFACES = {
  systems: new URL('../data/systems.json', import.meta.url),
  llms: new URL('../static/llms.txt', import.meta.url),
};

/** Failure strings: the surfaces (name -> text) that make a physical claim or host the builder. */
export function siteSurfaceProblems(surfaces) {
  const fails = [];
  for (const [name, text] of Object.entries(surfaces)) {
    for (const claim of PHYSICAL_CLAIMS) {
      if (text.includes(claim)) fails.push(`${claim} is claimed by ${name}, outside the controls partial that carries the caveat`);
    }
    if (text.includes(HOST_MARKER)) fails.push(`${name} hosts the builder, which only the dashboard may`);
  }
  return fails;
}

test('the site-surface check names a stray claim and a stray host', () => {
  assert.deepEqual(siteSurfaceProblems({ a: 'plain' }), []);
  assert.deepEqual(siteSurfaceProblems({ a: 'prints on Letter paper' }),
    ['Letter is claimed by a, outside the controls partial that carries the caveat']);
  assert.deepEqual(siteSurfaceProblems({ b: `<script src="${HOST_MARKER}">` }),
    ['b hosts the builder, which only the dashboard may']);
});

test('data/systems.json and static/llms.txt make no physical print claim and host no builder', () => {
  const real = Object.fromEntries(Object.entries(SURFACES).map(([k, u]) => [k, readFileSync(u, 'utf8')]));
  assert.ok(real.systems.length > 100 && real.llms.length > 100, 'the surface files were read, not empty');
  assert.deepEqual(siteSurfaceProblems(real), []);
});

// Hugo parses EVERY file under data/ as a data file and aborts the whole build on
// one it cannot unmarshal ("unmarshal of format \"\" is not supported"), taking
// every other data file down with it. Keep prose out of data/ by construction.
test('every file under data/ is a format Hugo can unmarshal', () => {
  const root = new URL('../data/', import.meta.url);
  const allowed = new Set(['.json', '.yaml', '.yml', '.toml']);
  const bad = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(`${e.name}${e.isDirectory() ? '/' : ''}`, dir);
      if (e.isDirectory()) walk(child);
      else if (!allowed.has(extname(e.name).toLowerCase())) bad.push(child.pathname);
    }
  };
  walk(root);
  assert.deepEqual(bad, [], `non-data files under data/: ${bad.join(', ')}`);
});
