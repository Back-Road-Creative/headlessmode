// QQA-06b: the atlas's measuring tools on synthetic pixel arrays (no image is committed). A hue
// shift must NOT read as distinct, a flat or grey/white tile must be caught, and the lettering
// contrast estimate must agree with the WCAG formula the 06a wash test uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRegion, cropImage, distinctness, labelContrast, NEAR_DUPLICATE,
} from './atlas/atlas-metrics.mjs';
import { summarise, renderReport } from './atlas/atlas-report.mjs';
import { decodePng, encodePng } from './atlas/png.mjs';
import { tilePng } from './helpers/module-server.mjs';
import { contrastThroughFill, contrastRatio, hexToRgb } from './helpers/contrast.mjs';

/** An RGBA image from a per-pixel function returning [r, g, b]. */
const make = (w, h, fn) => {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = fn(x, y), i = (y * w + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  return { width: w, height: h, data };
};
const map = (img, fn) => make(img.width, img.height, (x, y) => {
  const i = (y * img.width + x) * 4;
  return fn(img.data[i], img.data[i + 1], img.data[i + 2]);
});
// A deterministic pseudo-random byte stream, so a "texture" is the same on every run.
const rng = (seed) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 24; };
const noise = (w, h, seed) => { const r = rng(seed); return make(w, h, () => { const v = r(); return [v, v, v]; }); };
// A smooth hill with a ridge line: low-frequency structure, unlike the white noise above.
const hills = (w, h, phase = 0) => make(w, h, (x, y) => {
  const v = 128 + 70 * Math.sin((x + phase) / 9) * Math.cos(y / 11) + 40 * Math.sin((x + y) / 23);
  return [v, v, v];
});
const flat = (w, h, rgb) => make(w, h, () => rgb);

test('classifyRegion: a uniform dark or coloured region is blank, a uniform grey or white one a placeholder', () => {
  assert.equal(classifyRegion(flat(64, 64, [13, 13, 26])).verdict, 'blank');
  assert.equal(classifyRegion(flat(64, 64, [30, 80, 40])).verdict, 'blank');
  assert.equal(classifyRegion(flat(64, 64, [255, 255, 255])).verdict, 'placeholder');
  assert.equal(classifyRegion(flat(64, 64, [221, 221, 221])).verdict, 'placeholder');
});

test('classifyRegion: a flat grey tile with a line of dark text (an error tile) is a placeholder', () => {
  const img = make(128, 128, (x, y) => (y > 60 && y < 66 && x > 20 && x < 100 && (x % 4 < 2) ? [60, 60, 60] : [235, 235, 235]));
  const v = classifyRegion(img);
  assert.equal(v.verdict, 'placeholder');
  assert.match(v.reason, /flat/i);
});

test('classifyRegion: a textured region is ok, and a textured paper-coloured one too', () => {
  assert.equal(classifyRegion(noise(64, 64, 7)).verdict, 'ok');
  assert.equal(classifyRegion(make(64, 64, (x, y) => ((x + y) % 7 < 3 ? [51, 51, 51] : [232, 228, 216]))).verdict, 'ok');
});

test('classifyRegion: only the asked rectangle is judged', () => {
  const img = make(100, 100, (x) => (x < 50 ? [255, 255, 255] : [(x * 37) % 256, (x * 91) % 256, (x * 13) % 256]));
  assert.equal(classifyRegion(img, { rect: { x: 0, y: 0, width: 40, height: 100 } }).verdict, 'placeholder');
  assert.equal(classifyRegion(img, { rect: { x: 50, y: 0, width: 50, height: 100 } }).verdict, 'ok');
  assert.equal(cropImage(img, { x: 10, y: 20, width: 30, height: 5 }).data.length, 30 * 5 * 4);
});

test('distinctness: a picture against itself is 0, and a hue shift of it is NOT distinct though its colours differ a lot', () => {
  const a = hills(96, 96);
  assert.deepEqual([distinctness(a, a).score, distinctness(a, a).colour, distinctness(a, a).band], [0, 0, 'near-duplicate']);
  const tinted = map(a, (r, g, b) => [r * 0.35, g * 0.85, Math.min(255, b * 1 + 40)]);
  const d = distinctness(a, tinted);
  assert.ok(d.colour > 0.1, `the tint must change the colours (colour ${d.colour}) or this proves nothing`);
  assert.ok(d.score < 0.1, `a hue shift alone scored ${d.score}`);
  assert.equal(d.band, 'near-duplicate');
});

test('distinctness: different structure is distinct, whatever the colours', () => {
  const d = distinctness(hills(96, 96), noise(96, 96, 11));
  assert.ok(d.score > 0.6, `a hill shade against noise scored only ${d.score}`);
  assert.equal(d.band, 'distinct');
});

test('distinctness: a shifted copy of the same structure is related, not identical', () => {
  const d = distinctness(hills(96, 96, 0), hills(96, 96, 6));
  assert.ok(d.score > 0.02 && d.score < 0.6, `a six-pixel slide scored ${d.score}`);
});

test('distinctness: flat against textured is distinct, flat against flat is not (colour is reported)', () => {
  assert.equal(distinctness(flat(64, 64, [10, 10, 10]), noise(64, 64, 2)).score, 1);
  const two = distinctness(flat(64, 64, [10, 10, 10]), flat(64, 64, [200, 40, 40]));
  assert.equal(two.score, 0);
  assert.ok(two.colour > 0.3);
  assert.throws(() => distinctness(flat(10, 10, [0, 0, 0]), flat(10, 11, [0, 0, 0])), RangeError, 'different sizes are refused');
});

test('labelContrast: lettering on paper matches the WCAG ratio, and a wash lowers it as the wash test says', () => {
  const PAPER = '#e8e4d8';
  const strokes = (paper, ink) => make(120, 80, (x, y) => ((y % 10 === 4 && x % 3 !== 0) ? ink : paper));
  const bare = labelContrast(strokes(hexToRgb(PAPER), hexToRgb('#333333')));
  const want = contrastRatio(hexToRgb('#333333'), hexToRgb(PAPER));
  assert.ok(Math.abs(bare.ratio - want) < 0.05, `bare ratio ${bare.ratio} vs WCAG ${want}`);
  assert.equal(bare.side, 'dark');
  const wash = (c) => hexToRgb('#1a2a3a').map((w, i) => w * 0.59 + c[i] * 0.41);
  const washed = labelContrast(strokes(wash(hexToRgb(PAPER)), wash(hexToRgb('#333333'))));
  const wantWashed = contrastThroughFill('#333333', PAPER, '#1a2a3a', 0.59);
  assert.ok(Math.abs(washed.ratio - wantWashed) < 0.1, `washed ratio ${washed.ratio} vs ${wantWashed}`);
  assert.ok(washed.ratio < bare.ratio);
});

test('labelContrast: light lettering on a dark ground reads as light, and a flat region is 1:1', () => {
  const img = make(100, 60, (x, y) => (y % 12 === 5 && x % 4 !== 0 ? [250, 250, 250] : [20, 30, 20]));
  const c = labelContrast(img);
  assert.equal(c.side, 'light');
  assert.ok(c.ratio > 8);
  assert.equal(labelContrast(flat(50, 50, [90, 90, 90])).ratio, 1);
});

test('png: round-trips RGBA, decodes a greyscale tile to grey RGBA, refuses a non-PNG', () => {
  const img = make(37, 21, (x, y) => [x * 6, y * 11, (x * y) % 256]);
  const back = decodePng(encodePng(img));
  assert.deepEqual([back.width, back.height, Array.from(back.data)], [37, 21, Array.from(img.data)]);
  const grey = decodePng(tilePng(3, 5, 64));
  assert.deepEqual([grey.width, grey.data[0] === grey.data[1], grey.data[3]], [64, true, 255]);
  assert.equal(classifyRegion(grey).verdict, 'ok', 'the module-server tile pattern is a textured picture');
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /not a PNG/);
});

// --- the report: numbers in, a plain-English summary out (atlas-report.mjs) ---------------
const scene = (id, pairsOff, over = {}) => ({
  id, name: id, landmark: `${id} landmark`, at: [40, -100],
  pairs: {
    off: Object.fromEntries(Object.entries(pairsOff).map(([k, score]) => [k, { score, colour: 0.3, band: score < 0.15 ? 'near-duplicate' : score < 0.45 ? 'related' : 'distinct' }])),
    on: Object.fromEntries(Object.entries(pairsOff).map(([k, score]) => [k, { score: score / 2, colour: 0.3, band: 'near-duplicate' }])),
  },
  bases: Object.fromEntries(['usgsTopo', 'usgsImagery', 'usgsShadedRelief', 'none'].map((b) => [b, {
    off: { ms: 900, tiles: { total: 12, failed: 0, blank: 0, placeholder: 0 }, http: { bad: 0 }, contrast: { ratio: 5, side: 'dark' } },
    on: { ms: 100, contrast: { ratio: 3, side: 'dark' } },
  }])),
  ...over,
});
const T_I = 'usgsTopo|usgsImagery', T_R = 'usgsTopo|usgsShadedRelief', I_R = 'usgsImagery|usgsShadedRelief';

test('report: names the most similar pair, its margin, and says so plainly when two bases overlap', () => {
  const results = { generated: '2026-10-08', viewport: { width: 1000, height: 700 }, zoom: 8, scenes: [
    scene('a', { [T_I]: 0.8, [T_R]: 0.7, [I_R]: 0.05 }),
    scene('b', { [T_I]: 0.9, [T_R]: 0.6, [I_R]: 0.09 }),
  ] };
  const s = summarise(results);
  assert.deepEqual([s.mostSimilar.a, s.mostSimilar.b], ['usgsImagery', 'usgsShadedRelief']);
  assert.ok(Math.abs(s.mostSimilar.median - 0.07) < 1e-9);
  assert.ok(Math.abs(s.mostSimilar.toNearDuplicateLine - (0.07 - NEAR_DUPLICATE)) < 1e-9, 'margin to the near-duplicate line');
  assert.ok(Math.abs(s.mostSimilar.overNext - (0.65 - 0.07)) < 1e-9, 'margin over the next most similar pair');
  assert.match(s.bases.usgsImagery.verdict, /near-duplicate of .*relief.* in 2 of 2 scenes/i);
  assert.match(s.bases.usgsTopo.verdict, /distinct from both/i);
  const md = renderReport(results);
  assert.match(md, /^# /);
  assert.match(md, /Most similar pair[^\n]*imagery[^\n]*relief/i);
  assert.match(md, /\| a \| 0\.80 \/ 0\.40 near-duplicate \| 0\.70 \/ 0\.35 near-duplicate \| 0\.05 near-duplicate \/ 0\.03 near-duplicate \|/, 'one row per scene, off / on per pair');
});

test('report: counts failed, error-status and flat tiles and never reports a clean base as having them', () => {
  const dirty = scene('c', { [T_I]: 0.8, [T_R]: 0.7, [I_R]: 0.6 });
  dirty.bases.usgsImagery.off.tiles = { total: 12, failed: 2, blank: 1, placeholder: 3 };
  dirty.bases.usgsImagery.off.http = { bad: 2 };
  const s = summarise({ scenes: [dirty, scene('d', { [T_I]: 0.8, [T_R]: 0.7, [I_R]: 0.6 })] });
  assert.deepEqual(s.bases.usgsImagery.tileTrouble, { failed: 2, blank: 1, placeholder: 3, http: 2, judged: 24, scenes: ['c'] });
  assert.match(s.bases.usgsImagery.verdict, /2 tile images did not load and 2 tile requests failed/i);
  assert.match(s.bases.usgsImagery.verdict, /4 flat tiles \(1 one-colour, 3 grey or white\).*in 1 scene \(c\)/i);
  assert.match(s.bases.usgsImagery.verdict, /before calling a flat tile a defect/i);
  assert.match(s.bases.usgsTopo.verdict, /no failed, error-status or flat tiles/i);
});

test('report: a scene that could not be measured is listed, not averaged away', () => {
  const failed = { id: 'z', name: 'z', landmark: 'z landmark', at: [0, 0], error: 'tiles never settled' };
  const s = summarise({ scenes: [scene('a', { [T_I]: 0.8, [T_R]: 0.7, [I_R]: 0.6 }), failed] });
  assert.deepEqual(s.unmeasured.map((x) => x.id), ['z']);
  assert.match(renderReport({ scenes: [failed] }), /not measured[^\n]*z[^\n]*tiles never settled/i);
});

test('report: a base that is mostly flat says its distinctness comes from having little on it', () => {
  const mk = (id) => { const s = scene(id, { [T_I]: 0.8, [T_R]: 0.9, [I_R]: 0.9 }); s.bases.usgsShadedRelief.off.tiles = { total: 20, judged: 16, failed: 0, blank: 0, placeholder: 12 }; return s; };
  const s = summarise({ scenes: [mk('a'), mk('b')] });
  assert.equal(s.bases.usgsShadedRelief.tileTrouble.judged, 32);
  assert.match(s.bases.usgsShadedRelief.verdict, /24 of 32 judged tiles are flat.*high distinctness.*little on it/i);
  assert.doesNotMatch(s.bases.usgsTopo.verdict, /judged tiles are flat/i);
});
