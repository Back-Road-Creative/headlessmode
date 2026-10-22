// Shared by a11y-dynamic-browser.test.mjs (QQA-07): the offline network the Field Maps app
// is driven against, the axe-core run, and the keyboard and focus reads.
//
// Nothing here reaches the network. connectSession() answers every request the page makes:
// the local site passes through, tiles and services are answered from synthetic or
// sanitised fixtures, and anything else is refused (and listed in `refused`).
import { readFileSync } from 'node:fs';
import { settlePaused } from './paused-request.mjs';
import { terrariumTilePng, greyBasePng, trailsQueryResponse, mvumQueryResponse } from '../fixtures/relief-3d.mjs';
import { PLACE_FEATURES } from '../fixtures/gnis-names-declutter.mjs';

export const AXE_SRC = readFileSync(new URL('../../../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
/** WCAG 2.0 / 2.1 / 2.2, levels A and AA. (Not best-practice rules: those are advice, not conformance.) */
export const WCAG_TAGS = Object.freeze(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);

const ROADS = JSON.parse(readFileSync(new URL('../fixtures/road-names-sylva.json', import.meta.url), 'utf8'));
// The Sylva road fixture is moved onto the app's example area (app-state.js EXAMPLE_AREA),
// where the GNIS fixture's names sit, so a road name and a place name can share a view.
const SYLVA = [35.375, -83.218];
const EXAMPLE_CENTRE = [35.05, -83.475];
const SHIFT = [EXAMPLE_CENTRE[1] - SYLVA[1], EXAMPLE_CENTRE[0] - SYLVA[0]];

const CORS = [{ name: 'access-control-allow-origin', value: '*' }];
const json = (body) => ({ headers: [{ name: 'content-type', value: 'application/json' }, ...CORS], body: Buffer.from(JSON.stringify(body)).toString('base64') });
const png = (buf) => ({ headers: [{ name: 'content-type', value: 'image/png' }, ...CORS], body: buf.toString('base64') });

/** The answer for one remote URL, or null when the test does not stub it. */
export function answerFor(url) {
  if (/^https:\/\/s3\.amazonaws\.com\/elevation-tiles-prod\/terrarium\//.test(url)) {
    const m = /\/(\d+)\/(\d+)\/(\d+)\.png/.exec(url);
    return m ? png(terrariumTilePng(Number(m[1]), Number(m[2]), Number(m[3]))) : null;
  }
  if (/^https:\/\/basemap\.nationalmap\.gov\//.test(url)) return png(greyBasePng());
  const count = /returnCountOnly=true/.test(url);
  let m = /geonames\/MapServer\/(\d+)\/query/.exec(url);
  if (m) {
    const rows = m[1] === '3' ? PLACE_FEATURES : [];
    return json(count ? { count: rows.length } : { features: rows });
  }
  if (/nhd\/MapServer\/\d+\/query/.test(url)) return json(count ? { count: 0 } : { features: [] });
  m = /transportation\/MapServer\/(\d+)\/query/.exec(url);
  if (m) {
    const layer = ROADS.layers[m[1]];
    if (!layer) return json({ features: [] });
    return json({
      features: layer.features.map((f) => ({
        ...f, geometry: { paths: f.geometry.paths.map((p) => p.map(([x, y]) => [x + SHIFT[0], y + SHIFT[1]])) },
      })),
    });
  }
  if (/^https:\/\/elevation\.nationalmap\.gov\//.test(url)) return json({ samples: [] }); // 3DEP getSamples: no samples = NoData
  if (/carto\.nationalmap\.gov\/.*\/MapServer\/37\/query/.test(url)) return json(trailsQueryResponse());
  if (url.startsWith('https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MVUM_02/')) return json(mvumQueryResponse(url));
  if (/^https:\/\/(carto\.nationalmap\.gov|hydro\.nationalmap\.gov|apps\.fs\.usda\.gov)\//.test(url)) return json({ features: [] });
  return null;
}

/** Serves the page's requests through `session` (a connectSession) as described above. The
 *  site's own responses lose their CSP header so the injected axe run is never blocked (the
 *  run goes through Runtime.evaluate, which a CSP does not stop; this is belt and braces for
 *  workers). Returns the list of refused URLs. */
export async function stubOffline(session, siteOrigin) {
  const refused = [];
  session.on('Fetch.requestPaused', async (p) => {
    const { requestId, request } = p;
    const answer = answerFor(request.url);
    if (answer) {
      await settlePaused(session.send, 'Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: answer.headers, body: answer.body });
    } else if (request.url.startsWith(siteOrigin) || request.url.startsWith('data:') || request.url.startsWith('blob:')) {
      await settlePaused(session.send, 'Fetch.continueRequest', { requestId });
    } else {
      refused.push(request.url);
      await settlePaused(session.send, 'Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    }
  });
  await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  return refused;
}

/** The axe run, filtered page-side against `exclusions` (so a node can be matched with
 *  element.matches). Returns { violations, incomplete, waived }: each a flat list of
 *  { rule, impact, target, html, why }. `waived` lists what an exclusion removed and which one. */
export async function runAxe(page, exclusions = [], pixelLayers = []) {
  await page.evaluate(`${AXE_SRC};true`);
  // `pixelLayers` are map rasters (tile images, the WebGL canvas). axe reads no pixels, and its
  // overlap grid takes a tile's whole box for an element lying over the page chrome beside the map
  // (the header links, the prose below it come back "overlapped by another element"). While axe
  // runs they are hidden, so every other node is judged against the colours the page declares.
  // (Leaflet also paints tiles with mix-blend-mode: plus-lighter, which axe 4.11 cannot compute: it
  // throws "Axe encountered an error" on any element with a tile behind it.)
  await page.evaluate(`(() => { document.getElementById('qc-a11y-pixels')?.remove(); const s = document.createElement('style');
    s.id = 'qc-a11y-pixels'; s.textContent = ${JSON.stringify(pixelLayers.length ? `${pixelLayers.join(', ')} { visibility: hidden !important; }` : '')};
    document.head.appendChild(s); })()`);
  return page.evaluate(`(async () => {
    const ex = ${JSON.stringify(exclusions)};
    const r = await axe.run(document, { runOnly: { type: 'tag', values: ${JSON.stringify(WCAG_TAGS)} },
      resultTypes: ['violations', 'incomplete'], elementRef: true });
    const out = { violations: [], incomplete: [], waived: [] };
    const take = (kind, list) => {
      for (const rule of list) for (const n of rule.nodes) {
        const item = { rule: rule.id, impact: rule.impact, target: n.target.join(' '),
          html: n.html.slice(0, 160), why: ((n.any[0] || n.all[0] || n.none[0] || {}).message || '').slice(0, 220) };
        const hit = ex.find((e) => e.rule === rule.id && e.kind === kind && n.element && n.element.matches(e.selector));
        if (hit) out.waived.push({ ...item, waivedBy: hit.selector });
        else out[kind].push(item);
      }
    };
    take('violations', r.violations);
    take('incomplete', r.incomplete);
    document.getElementById('qc-a11y-pixels')?.remove();
    return out;
  })()`);
}

/** One line per finding, for an assertion message. */
export const describeFindings = (list) => list.map((v) => `  ${v.rule} (${v.impact}) ${v.target} ${v.html.slice(0, 90)} -- ${v.why}`).join('\n');

/** A real key press through the browser's input pipeline (not a synthetic DOM event), so
 *  Tab moves focus the way a keyboard does. */
const KEYS = Object.freeze({
  Tab: { code: 'Tab', vk: 9 }, Escape: { code: 'Escape', vk: 27 }, Enter: { code: 'Enter', vk: 13, text: '\r' },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
});
export async function pressKey(page, key, { shift = false } = {}) {
  const k = KEYS[key];
  const base = { key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: shift ? 8 : 0 };
  await page.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** Describes the focused element: how to find it again, whether it is visible and
 *  unobscured (WCAG 2.4.11). `covered` is elementFromPoint at the centre of the part of
 *  its box that lies in the viewport: the element, a descendant or an ancestor owns it. */
export const FOCUS_READ = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const r = el.getBoundingClientRect();
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const x0 = Math.max(0, r.left), x1 = Math.min(vw, r.right), y0 = Math.max(0, r.top), y1 = Math.min(vh, r.bottom);
  const inView = x1 > x0 && y1 > y0;
  let owner = null;
  if (inView) owner = document.elementFromPoint((x0 + x1) / 2, (y0 + y1) / 2);
  const hit = (o) => Boolean(o) && (o === el || el.contains(o) || o.contains(el));
  // The centre first. WCAG 2.4.11 fails a focused control only when it is ENTIRELY hidden, so a control whose own box is mostly
  // empty (a 240px marker box that holds one small label) is also judged on the centres of the pieces inside it that have a size.
  let reached = hit(owner);
  for (const part of inView && !reached ? el.querySelectorAll('*') : []) {
    const q = part.getBoundingClientRect();
    const cx = Math.min(Math.max((q.left + q.right) / 2, x0), x1 - 0.5), cy = Math.min(Math.max((q.top + q.bottom) / 2, y0), y1 - 0.5);
    if (!q.width || !q.height || cx < 0 || cy < 0 || cx >= vw || cy >= vh) continue;
    const o = document.elementFromPoint(cx, cy);
    if (o && (o === el || el.contains(o))) { reached = true; break; }
  }
  const name = el.id ? '#' + el.id : el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/)[0] : '');
  return { name, tag: el.tagName.toLowerCase(), id: el.id || '', cls: typeof el.className === 'string' ? el.className : '',
    label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40),
    html: el.outerHTML.slice(0, 140),
    attrs: el.getAttributeNames().join(' '),
    rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    inView, reached, owner: owner ? owner.tagName.toLowerCase() + (owner.id ? '#' + owner.id : '') + (typeof owner.className === 'string' && owner.className ? '.' + owner.className.trim().split(/\\s+/)[0] : '') : null };
})()`;

/** Presses Tab up to `max` times from the document start and returns every stop (FOCUS_READ).
 *  `selectors`: each stop lists which of them the focused element matches (`matched`).
 *  Stops when focus leaves the page (activeElement is the body again after a stop) or a stop repeats. */
export async function tabThrough(page, max = 120, selectors = []) {
  await page.evaluate(`(document.activeElement && document.activeElement.blur && document.activeElement.blur(), window.scrollTo(0, 0), true)`);
  const stops = [];
  for (let i = 0; i < max; i++) {
    await pressKey(page, 'Tab');
    const s = await page.evaluate(FOCUS_READ);
    if (!s) break;
    s.matched = selectors.length ? await page.evaluate(`${JSON.stringify(selectors)}.filter((q) => document.activeElement.matches(q))`) : [];
    if (stops.length && stops.some((p) => p.name === s.name && p.rect.join() === s.rect.join())) break;
    stops.push(s);
  }
  return stops;
}
