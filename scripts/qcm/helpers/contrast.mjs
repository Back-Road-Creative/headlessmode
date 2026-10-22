// WCAG contrast of one colour seen through a translucent fill, and the county context
// fill's own numbers read back out of the dashboard source. Pure: no DOM, no Leaflet.
import { readFileSync } from 'node:fs';

export const DASHBOARD_JS = new URL('../../../themes/headlessmode/static/js/quiet-corners.js', import.meta.url);

/** '#rrggbb' -> [r, g, b] in 0..255. */
export const hexToRgb = (hex) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new RangeError(`not a #rrggbb colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
};

/** `top` painted at `alpha` over `under`, both [r, g, b]. */
export const composite = (top, alpha, under) => top.map((v, i) => v * alpha + under[i] * (1 - alpha));

/** WCAG 2 relative luminance of an [r, g, b] in 0..255. */
export const luminance = ([r, g, b]) => {
  const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

/** WCAG 2 contrast ratio between two [r, g, b], always >= 1. */
export const contrastRatio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** The contrast of `text` lettering against `ground`, both seen through `fill` at `alpha`:
 *  the wash is painted over the tile, so it covers the lettering and the paper alike. */
export const contrastThroughFill = (text, ground, fill, alpha) =>
  contrastRatio(composite(hexToRgb(fill), alpha, hexToRgb(text)), composite(hexToRgb(fill), alpha, hexToRgb(ground)));

/** The context fill the dashboard paints with scores ON, as declared in quiet-corners.js
 *  (COUNTY_CONTEXT_FILL). One reader for the contrast proof and the browser proof, so
 *  neither carries a number of its own to drift from the page. */
export const contextFillFromSource = (src = readFileSync(DASHBOARD_JS, 'utf8')) => {
  const m = /COUNTY_CONTEXT_FILL\s*=\s*\{\s*rural:\s*([\d.]+)\s*,\s*other:\s*([\d.]+)\s*\}/.exec(src);
  if (!m) throw new Error('quiet-corners.js declares no COUNTY_CONTEXT_FILL = { rural, other }');
  return { rural: Number(m[1]), other: Number(m[2]) };
};
