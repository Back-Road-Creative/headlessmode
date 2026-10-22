// What the atlas measures, as pure functions over decoded pixels ({ width, height, data },
// RGBA Uint8Array). classifyRegion: a picture, a blank, or a placeholder tile? distinctness:
// do two captures differ in STRUCTURE (colour sits beside the score, never in it)?
// labelContrast: an estimate of how well lettering would read, from the pixels alone.
const at = (img, x, y) => (y * img.width + x) * 4;

/** The pixels of `rect` ({x, y, width, height}), clamped to the image. */
export function cropImage(img, rect) {
  const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(img.width, Math.ceil(rect.x + rect.width)), y1 = Math.min(img.height, Math.ceil(rect.y + rect.height));
  const width = Math.max(0, x1 - x0), height = Math.max(0, y1 - y0), data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) data.set(img.data.subarray(at(img, x0, y0 + y), at(img, x0, y0 + y) + width * 4), y * width * 4);
  return { width, height, data };
}

// WCAG relative luminance of every 8-bit grey level's worth of channel, once.
const LIN = Float64Array.from({ length: 256 }, (_, v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
const relLum = (d, i) => 0.2126 * LIN[d[i]] + 0.7152 * LIN[d[i + 1]] + 0.0722 * LIN[d[i + 2]];

const UNIFORM = 0.995;              // share of pixels at the modal colour: nothing drawn
const MOSTLY_FLAT = 0.9;            // ...with a little sparse mark on it
const NEAR = 12;                    // per-channel distance that still counts as the modal colour
const NEUTRAL = 8;                  // max-min channel spread of grey/white

/** `{ verdict, reason, ... }` for one decoded tile or map region.
 *  blank        near-uniform in a colour that is not grey/white (a bare page, a "no base").
 *  placeholder  uniform, or nearly so, in a light neutral grey/white: how a tile service
 *               answers where it has no data, text included.
 *  ok           anything else: there is a picture. */
export function classifyRegion(img, { rect = null } = {}) {
  const region = rect ? cropImage(img, rect) : img, n = region.width * region.height;
  if (!n) return { verdict: 'blank', reason: 'empty region', flatShare: 1, modal: null };
  const hist = new Uint32Array(32768), d = region.data;
  for (let i = 0; i < n * 4; i += 4) hist[((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3)]++;
  const best = hist.indexOf(Math.max(...hist));
  const modal = [((best >> 10) << 3) + 4, (((best >> 5) & 31) << 3) + 4, ((best & 31) << 3) + 4];
  let near = 0;
  for (let i = 0; i < n * 4; i += 4) if (Math.abs(d[i] - modal[0]) <= NEAR && Math.abs(d[i + 1] - modal[1]) <= NEAR && Math.abs(d[i + 2] - modal[2]) <= NEAR) near++;
  const flatShare = near / n, spread = Math.max(...modal) - Math.min(...modal), light = Math.min(...modal) >= 150;
  const made = { flatShare, modal };
  if (flatShare >= UNIFORM) {
    return spread <= NEUTRAL && light
      ? { verdict: 'placeholder', reason: 'uniform grey or white', ...made }
      : { verdict: 'blank', reason: 'uniform colour, nothing drawn', ...made };
  }
  if (flatShare >= MOSTLY_FLAT && spread <= NEUTRAL && light) {
    return { verdict: 'placeholder', reason: 'flat grey or white with sparse marks (an error or no-data tile)', ...made };
  }
  return { verdict: 'ok', reason: 'a picture', ...made };
}

/** `img` as a luma plane of at most ~`target` pixels on its long side, box-averaged, so a
 *  one-pixel slide of the same picture does not read as a different one. */
function plane(img, target = 128) {
  const f = Math.max(1, Math.ceil(Math.max(img.width, img.height) / target));
  const w = Math.max(1, Math.floor(img.width / f)), h = Math.max(1, Math.floor(img.height / f)), out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) { const p = at(img, x * f + i, y * f + j); s += 0.299 * img.data[p] + 0.587 * img.data[p + 1] + 0.114 * img.data[p + 2]; }
    out[y * w + x] = s / (f * f);
  }
  return { w, h, v: out };
}
/** Gradient magnitude (|dx| + |dy|) of a plane: where the picture has edges. */
const edges = ({ w, h, v }) => {
  const out = new Float64Array(w * h);
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) out[y * w + x] = Math.abs(v[y * w + x + 1] - v[y * w + x]) + Math.abs(v[(y + 1) * w + x] - v[y * w + x]);
  return out;
};
/** Pearson correlation, or null when either side has no variance. */
function pearson(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  const flatA = saa / n < 1e-6, flatB = sbb / n < 1e-6;
  if (flatA || flatB) return { flatA, flatB, r: null };
  return { flatA, flatB, r: sab / Math.sqrt(saa * sbb) };
}
const dissimilar = (p) => (p.flatA && p.flatB ? 0 : p.flatA || p.flatB ? 1 : 1 - Math.max(0, p.r));

export const NEAR_DUPLICATE = 0.15;
export const RELATED = 0.45;

/** Structural difference of two same-size captures, 0 (same picture, however recoloured) to 1
 *  (unrelated): the mean of how little their luma patterns and their edge maps correlate.
 *  Flat against textured is 1, flat against flat 0. `colour` (mean channel difference) is
 *  reported beside the score, not in it. band: near-duplicate < 0.15 <= related < 0.45 <= distinct. */
export function distinctness(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw new RangeError(`distinctness needs two captures of the same size, got ${a.width}x${a.height} and ${b.width}x${b.height}`);
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 4) sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
  const colour = sum / (a.width * a.height * 3 * 255);
  const pa = plane(a), pb = plane(b);
  const luma = dissimilar(pearson(pa.v, pb.v)), edge = dissimilar(pearson(edges(pa), edges(pb)));
  const score = (luma + edge) / 2;
  return { score, colour, luma, edge, band: score < NEAR_DUPLICATE ? 'near-duplicate' : score < RELATED ? 'related' : 'distinct' };
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

/** An estimate of how well lettering would read in `rect` (or the whole image): the ground
 *  is the median luminance, the ink the 2nd or 98th percentile, whichever sits further
 *  from the ground; `ratio` is their WCAG contrast (1 for a flat region) and `side` says
 *  whether the ink is darker ('dark') or lighter ('light') than the ground. */
export function labelContrast(img, rect = null) {
  const region = rect ? cropImage(img, rect) : img, n = region.width * region.height;
  if (!n) return { ratio: 1, side: 'dark', ground: 0, ink: 0 };
  const lum = new Float64Array(n);
  for (let p = 0; p < n; p++) lum[p] = relLum(region.data, p * 4);
  lum.sort();
  const ground = quantile(lum, 0.5), dark = quantile(lum, 0.02), light = quantile(lum, 0.98);
  const darkRatio = (ground + 0.05) / (dark + 0.05), lightRatio = (light + 0.05) / (ground + 0.05);
  return darkRatio >= lightRatio ? { ratio: darkRatio, side: 'dark', ground, ink: dark } : { ratio: lightRatio, side: 'light', ground, ink: light };
}
