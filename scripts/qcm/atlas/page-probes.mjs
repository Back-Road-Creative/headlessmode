// Page-side probes shared by the atlas browser test and the capture CLI: wait inside the
// page, pick a radio, read the tile images' boxes and states, screenshot the map box.
import { decodePng } from './png.mjs';

export const waitFor = (page, what, expr, ms = 45000) => page.evaluate(`window.qcWait(${JSON.stringify(what)}, () => ${expr}, ${ms})`);
export const choose = (page, name, id) => page.evaluate(`(() => { const r = document.getElementById(${JSON.stringify(`qcm-${name}-${id}`)}); if (!r) throw new Error('no radio qcm-${name}-${id}'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); })()`);
/** Every base tile <img> (its address, whether it finished or loaded, opacity, box inside the map) and how many polygons and tile layers are mounted. */
export const TILES = `(() => {
  const box = window.qcMap.getContainer().getBoundingClientRect();
  const imgs = [...document.querySelectorAll('.leaflet-tile-pane img.leaflet-tile')].map((img) => {
    const r = img.getBoundingClientRect(), layer = img.closest('.leaflet-layer');
    return { src: img.src, done: img.complete, ok: img.complete && img.naturalWidth > 0, opacity: Number(getComputedStyle(img).opacity), left: r.left - box.left, top: r.top - box.top, width: r.width, height: r.height,
      layerOpacity: layer ? Number(getComputedStyle(layer).opacity) : null };
  });
  let polygons = 0; window.qcMap.eachLayer((l) => { if (l instanceof L.Polygon) polygons++; });
  return { imgs, polygons, layers: document.querySelectorAll('.leaflet-tile-pane .leaflet-layer').length, width: box.width, height: box.height };
})()`;
/** The map box as a PNG: `{ buf, img }` with img decoded to RGBA. */
export async function shot(page) {
  const r = await page.evaluate('(() => { const c = window.qcMap.getContainer(); c.scrollIntoView({ block: "start" }); const b = c.getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, width: b.width, height: b.height }; })()');
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
  const buf = Buffer.from(data, 'base64');
  return { buf, img: decodePng(buf) };
}
