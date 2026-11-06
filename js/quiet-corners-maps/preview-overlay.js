// The map on screen, styled from the same table as the map on paper.
//
// The preview used to show the topo tiles, the selection rectangle and the sheet
// outlines -- and nothing else. MVUM was fetched, handed to the build, and never
// drawn, so ticking the layer changed the recipe, the page count, and nothing you
// could see. The invariant this module exists to hold: A LAYER THAT PRINTS,
// PREVIEWS.
//
// It styles from `features`, not from the print path's page-pixel vectors, on
// purpose. Round-tripping page pixels back to lon/lat would be lossy and would
// tie the preview to one sheet. Instead both paths call the SAME symbol lookup --
// symbolForFeature(), then legend.js's one physical table -- so a symbol added
// once is drawn identically in both places, and neither can drift from the key.
import { symbolForFeature, SYMBOL_BY_KEY, DASH_IN, swatchSpec } from './legend.js';
import { drawsAtScale } from './overlay-paths.js';
import { markerPath } from './pdf.js';
import { roadDetail } from './source-road-basic.js';
import { nearestUnpaved, nearUnpavedPhrase } from './near-unpaved.js';
import { mvumAccessText } from './source-mvum.js';
import { trailDetailLines } from './route-identify.js';

// A screen has no fixed scale, so a physical width cannot be honoured literally:
// a 0.0167 in road would be 1.6 CSS px and a hairline. The preview is a diagram
// of the sheet, so widths are magnified by one scalar -- the RATIOS a reader
// compares (road to trail, paved to primitive) survive it, which is what matters.
const CSS_PX_PER_IN = 96;
const ZOOM = 1.8;
const MIN_WEIGHT = 1.2;
// Light enough that contours and names stay readable through an area.
const FILL_OPACITY = 0.12;

// 3 decimals, not 2: at 2 the road:trail width ratio came out 1.6647 against the
// paper's 1.6667 -- a rounding artefact, but the whole point of this module is that
// the proportions match, so it must not be lost at the last step. Sub-pixel
// precision costs nothing; Leaflet takes a float.
const px = (inches) => +(inches * CSS_PX_PER_IN * ZOOM).toFixed(3);

// --- D0: display-state contract (pure, reversible emphasis) -----------------
//
// `displayStyle` answers "how does this symbol look right now" from the
// IMMUTABLE canonical symbol table plus a small state object -- never from a
// Leaflet shape's current (already-mutated) style. That is the whole point:
// hover, spotlight and contrast are emphasis passes over the canonical style,
// not adjustments layered onto whatever the shape happens to carry already.
// hover -> unhover -> hover therefore yields byte-identical objects, and
// nothing here can compound (a shape hovered twice is not thicker than one
// hovered once). The renderer (main.js) owns the ONLY mutable piece of state
// -- which display object is "current" -- and hands it back in on every call;
// this module never reads or remembers a Leaflet style.
//
// `casingStyle` is a second pure function, not folded into `displayStyle`,
// because the casing (a contrasting under-stroke for a selected shape) is a
// SEPARATE draw call the renderer makes, not a property Leaflet's `setStyle`
// can express on one path.
export const DEFAULT_DISPLAY = Object.freeze({ lines: 1, fill: 1, dim: 0, spotlight: null, contrast: 'normal' });

/** The emphasized Leaflet style for one symbol key, computed fresh from the
 *  canonical symbol every call -- see the header comment above.
 *
 *  `state` carries the persistent per-session choices (line-weight multiplier,
 *  fill multiplier, a spotlighted layerId, contrast mode); `hover`/`selected`
 *  are transient, pointer-driven emphasis that never gets written back into
 *  `state`. `layerId` identifies the shape being styled, so a spotlight can
 *  tell "am I the one" from "am I one of the others". */
export function displayStyle(key, state = DEFAULT_DISPLAY, { hover = false, selected = false, layerId } = {}) {
  const base = previewStyle(key);
  if (!base) return null;
  const lines = state.lines ?? DEFAULT_DISPLAY.lines;
  const fill = state.fill ?? DEFAULT_DISPLAY.fill;
  const contrast = state.contrast ?? DEFAULT_DISPLAY.contrast;
  const spotlight = state.spotlight ?? DEFAULT_DISPLAY.spotlight;

  let weight = Math.max(MIN_WEIGHT, base.weight * lines);
  if (contrast === 'high') weight += 0.8;
  if (hover) weight += 2;
  weight = +weight.toFixed(3);

  let opacity = 1;
  let fillOpacity = base.fill ? base.fillOpacity * fill : undefined;
  const dimmed = spotlight != null && spotlight !== layerId;
  if (dimmed) {
    opacity *= 0.25;
    if (fillOpacity !== undefined) fillOpacity *= 0.25;
  }

  const style = { ...base, weight, opacity };
  if (fillOpacity !== undefined) style.fillOpacity = +fillOpacity.toFixed(4);
  if (selected) Object.assign(style, { casing: true, casingColor: '#ffffff', casingWeight: weight + 3 });
  return style;
}

/** The under-stroke for a `selected` computed style -- a contrasting casing
 *  drawn as its own shape, wider and behind the symbol's own stroke, so a
 *  selection reads even against a same-hue neighbour. Pure: draws nothing,
 *  returns the style the renderer strokes a second, wider shape with. `null`
 *  when `style` was not computed with `selected: true`. */
export function casingStyle(style) {
  if (!style?.casing) return null;
  return { color: style.casingColor, weight: style.casingWeight, dashArray: style.dashArray || undefined };
}

/** Leaflet style for one symbol key, from the same table pdf.js prints from.
 *  `tier` is a width override keyed by symbol (road quality uses it); an unknown
 *  tier falls back to the symbol's own width, so this works before and after that
 *  layer exists. */
export function previewStyle(key, tier = null) {
  const symbol = SYMBOL_BY_KEY[key];
  if (!symbol) return null;
  const widthIn = (tier && SYMBOL_BY_KEY[tier] ? SYMBOL_BY_KEY[tier] : symbol).widthIn;
  const dash = DASH_IN[symbol.pattern] || [];
  // The table may say how a symbol differs on a SCREEN (legend.js `screen`): its
  // own hue, a floor under its width, and whether it is an area. Read, never chosen
  // here -- the screen key draws its swatch from the same field.
  const screen = symbol.screen || {};
  const style = {
    color: screen.color || symbol.color,
    weight: Math.max(screen.minPx || MIN_WEIGHT, px(widthIn)),
    dashArray: dash.length ? dash.map(px).join(' ') : null,
    key,
  };
  // A designation is an area, and its source hands over closed rings. A light fill
  // is what lets a reader see WHERE a wilderness is rather than hunt for its edge.
  if (screen.fill) Object.assign(style, { closed: true, fill: true, fillColor: style.color, fillOpacity: FILL_OPACITY });
  return style;
}

/** How many polylines ONE symbol may put on screen before the preview stops adding
 *  more of them.
 *
 *  The screen and the paper have different limits, and pretending otherwise breaks
 *  the thing this module exists for. A sheet renders parcels once, offline, at its
 *  own pace; Leaflet holds every polyline as live DOM and Delaware answers 26,863
 *  parcels over a single test rectangle (`state-sources.json`, DE.parcels.count),
 *  with Utah at 13,320. Handing Leaflet 26,863 shapes does not draw a busy map, it
 *  stops the tab -- and a frozen tab is a worse answer than a partial one.
 *
 *  PER SYMBOL rather than overall, so one dense layer cannot starve the others: a
 *  reader who ticks parcels must still see their roads.
 *
 *  The budget does NOT reach the sheet. Paper draws every feature; the preview says
 *  out loud how many of them it is showing (see `onTruncate`), which keeps the
 *  parity invariant pointed the honest way -- the screen may show less than the
 *  paper, and admits it, but never shows something the paper will not carry. */
export const PREVIEW_BUDGET = 2000;

/** The scale the SCREEN is drawn at: how much ground one CSS pixel covers,
 *  expressed the way a paper scale is. Web Mercator, so the ground a pixel
 *  covers shrinks with the cosine of the latitude, and each zoom level halves
 *  it. 96 CSS pixels to the inch is the CSS definition, not a guess about the
 *  monitor.
 *
 *  This exists because the preview was gated on the RECIPE's scale. A reader
 *  printing 1:48,000 who zoomed the screen down to one ridge still saw no
 *  parcel lines: the layer was on, the data was fetched, and the map was empty
 *  with nothing said. Paper scale decides paper. */
export const SCREEN_DPI = 96;
const EQUATOR_M = 40075016.686;

export function screenScaleDenominator(zoom, lat = 0, dpi = SCREEN_DPI) {
  const groundPerPx = EQUATOR_M * Math.cos((lat * Math.PI) / 180) / 2 ** (zoom + 8);
  return groundPerPx * dpi / 0.0254;
}

/** Features -> Leaflet polylines. `latlngs` is [lat, lon] because that is what
 *  Leaflet takes; the print path stores [lon, lat]. The swap lives here, once.
 *
 *  `onTruncate` is called once, with one row per capped symbol ({ key, shown,
 *  total }), when the budget bit. It is a callback rather than a second return
 *  value because every caller here treats the result as a plain array. */
export function previewPolylines(features = [], { roadQuality = {}, scale = null, paperScale = null, budget = PREVIEW_BUDGET, onTruncate = null, onScreenOnly = null } = {}) {
  const out = [];
  const screenOnly = new Map();
  const shown = new Map();
  const total = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const f of features) {
    // A feature that already knows its own symbol says so, exactly as the print
    // path does (overlay-paths.js). symbolForFeature answers the MVUM road/trail
    // question ONLY: asked about a state park boundary it returned an unknown-season
    // forest ROAD, so every land boundary and every non-motorized trail previewed
    // in the wrong colour while printing in the right one. Parity is the invariant.
    const symbol = SYMBOL_BY_KEY[f.symbolKey] || symbolForFeature(f);
    if (!symbol) continue;
    // Parity runs both ways: a layer the sheet drops for density must not appear
    // on screen either, or the preview promises ink the paper will not carry.
    if (!drawsAtScale(symbol.key, scale)) continue;
    // Drawn here, dropped by the sheet: the reader is looking at ink the paper
    // will not carry, and has to be told rather than left to discover it in the
    // PDF. Parity used to be enforced by hiding it; hiding it was the bug.
    if (paperScale && !drawsAtScale(symbol.key, paperScale)) {
      screenOnly.set(symbol.key, { key: symbol.key, paperScale });
    }
    // Roads only. The join table is keyed on route id, and a trail that happens to
    // share one is not a Forest Service road with a maintenance level.
    const rating = symbol.key.startsWith('mvum-road-') ? roadQuality[f.id] : null;
    const style = previewStyle(symbol.key, (rating || {}).tier || null);
    if (!style) continue;
    for (const path of f.paths || []) {
      if (!Array.isArray(path) || path.length < 2) continue;
      // Counted whether or not it is drawn: "2,000 of 26,863" needs the real total,
      // and a count that stopped at the budget would report 2,000 of 2,000.
      bump(total, style.key);
      if ((shown.get(style.key) || 0) >= budget) continue;
      bump(shown, style.key);
      // What KIND of thing it is always; the name too when the source gave one, and
      // for a road what the inventory said about its surface and upkeep. Those two
      // facts were fetched for every road and spent entirely on line width, so two
      // grey lines of the same weight -- one gravel, one needing high clearance --
      // read identically with the answer already in the browser (F13).
      // The rating is roads-only; the vehicle answer is not. MVUM is motor-vehicle
      // data by definition, so its trails carry the same open/closed and date
      // fields, and a reader deciding whether to drive one needs them just as much.
      const said = [f.name ? `${f.name} — ${symbol.label}` : symbol.label,
        roadDetail(rating), mvumAccessText(f)];
      const title = said.filter(Boolean).join('. ');
      // QQA-08: what an identification card states, as data: the SYMBOL's key (style.key
      // may be a quality tier), the name, and every fact the feature carries beyond it.
      const detail = [roadDetail(rating), mvumAccessText(f), ...trailDetailLines({ ...f, symbolKey: symbol.key })].filter(Boolean);
      out.push({ ...style, id: f.id ?? null, objectId: f.objectId ?? null, forest: f.forest ?? null, symbolKey: symbol.key, name: f.name || null, detail,
        title, latlngs: path.map(([lon, lat]) => [lat, lon]) });
    }
  }
  if (onScreenOnly && screenOnly.size) onScreenOnly([...screenOnly.values()]);
  if (onTruncate) {
    const capped = [...total].filter(([k, n]) => n > (shown.get(k) || 0))
      .map(([key, n]) => ({ key, shown: shown.get(key) || 0, total: n }));
    if (capped.length) onTruncate(capped);
  }
  return out;
}

/** The symbol keys the preview is currently showing — the screen's own answer to
 *  "what is on this map", so a test can compare it with the printed legend's. */
export function previewSymbolKeys(polylines) {
  return [...new Set(polylines.map((p) => p.key))].sort();
}

/** One point symbol as an inline SVG, drawn from `markerPath` -- the SAME geometry
 *  the sheet strokes. The shape existed on paper and on the key and nowhere on
 *  screen, which is the whole of F10: the map drew a circle and the key beside it
 *  promised a triangle.
 *
 *  `overflow: visible` because the path fills the box exactly, so half the stroke
 *  would otherwise be clipped off. */
export function siteIconSvg(marker, size, color) {
  const ring = markerPath(marker, size / 2, size / 2, size);
  const body = ring
    ? '<polygon points="' + ring.map(([x, y]) => `${+x.toFixed(2)},${+y.toFixed(2)}`).join(' ') + '"/>'
    // 'dot' has no outline to trace: it is a filled circle in both places.
    : `<circle cx="${size / 2}" cy="${size / 2}" r="${(size / 2 - 0.75).toFixed(2)}"/>`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" overflow="visible" `
    + `aria-hidden="true" fill="${color}" fill-opacity="0.35" stroke="${color}" stroke-width="1.5">`
    + body + '</svg>';
}

/** Recreation sites -> a drawable icon each, from the same symbol table the sheet
 *  prints from. Parity is the invariant: a layer that prints, previews -- and
 *  since F10, previews AS THE SHAPE IT PRINTS.
 *
 *  The icon is built here rather than at the call site so the drawing code cannot
 *  choose a different shape: main.js receives the symbol already drawn, and there
 *  is no longer a circle for it to fall back to. */
export function previewSites(sites = [], { roads = [], roadQuality = {} } = {}) {
  const out = [];
  for (const site of sites) {
    const symbol = SYMBOL_BY_KEY[site.symbolKey];
    if (!symbol || !Array.isArray(site.lonLat)) continue;
    const spec = swatchSpec(symbol);
    const size = Math.max(10, +px(spec.sizeIn).toFixed(2));
    out.push({
      // QUX-11b: the original site object, untouched, so a caller that separately
      // computed row ids keyed on site identity (places-in-view.js's assignRecIds)
      // can pair a drawn pin back to its id without this module knowing that
      // scheme exists.
      site,
      key: site.symbolKey,
      latlng: [site.lonLat[1], site.lonLat[0]],   // Leaflet takes [lat, lon]
      size,
      radius: Math.max(3, size / 2),
      color: spec.color,
      marker: spec.marker,
      svg: siteIconSvg(spec.marker, size, spec.color),
      // A blank tooltip is a control that answers nothing, so an unnamed site
      // says what it is instead of saying nothing at all. The near-unpaved
      // phrase (below) stays joined onto the title too, unchanged from before
      // 11b -- preview-overlay.test.mjs's pre-existing "a recreation site says
      // how far it is from a mapped unpaved road" asserts it there, and this
      // unit's single license to change an existing assertion is spent on
      // site-card.test.mjs's deliberate FS-card block, not this file.
      title: [site.name || `${spec.label} (name not published)`,
        nearUnpavedPhrase(nearestUnpaved({ lonLat: site.lonLat, roads, roadQuality }))]
        .filter(Boolean).join(' — '),
      // QUX-11b (§2.6): the SAME phrase, as its own field, so a card can carry
      // it as its last line too (main.js folds `near` into siteCard's lines).
      // That join is the point of F13: the app knew where the gravel was and
      // where the campsites were, and never said the two together. `null`
      // when there is nothing to say, because the search saw one rectangle
      // (near-unpaved.js) and a miss must add nothing.
      near: nearUnpavedPhrase(nearestUnpaved({ lonLat: site.lonLat, roads, roadQuality })),
      // The fuller answer, when the source module wrote one, carried untouched the way
      // symbolKey is. `null` not `[]`: an empty card is a control opening onto nothing.
      lines: Array.isArray(site.lines) && site.lines.length ? site.lines : null,
    });
  }
  return out;
}

/** The lines of one site as a card, one element per line, with an optional dock
 *  of action buttons (QUX-05c: a GNIS name card's Copy coordinates / Share
 *  place). `textContent`, and that is the whole reason this exists rather
 *  than a template string at the call site: the description and directions it
 *  shows begin life as raw provider HTML (source-blm-rec-sites.js),
 *  plainText() reduces them, and a render path that assigned the result as
 *  markup would hand back everything the reducer took away. The first line is
 *  the site's own name, so it leads and names the card.
 *
 *  `actions` is `[{label, onActivate, disabled, disabledReason}]`; `onActivate(btn)`
 *  may return a value, a promise, or throw/reject -- every path writes visible
 *  feedback into a status paragraph rather than failing silently. The button is
 *  passed through so a toggle action (QUX-09a's Save / Saved -- remove) can
 *  rewrite its own label; `disabled: true` disables it and sets `disabledReason`
 *  as its accessible description via `title`.
 *  The status paragraph and the buttons share one `.qcm-site-card-actions` dock,
 *  which quiet-corners-maps.css holds to the popup's bottom edge: a name card is
 *  taller than its popup, and actions at the end of it opened below the fold.
 *  The status leads the dock, so a report grows it upward instead of moving a
 *  button, and the buttons have a wrapper of their own, so a `:nth-child` or
 *  `:last-child` selector still counts buttons and nothing else.
 *  Byte-identical output to before when `actions` is empty and `media` is null
 *  (both defaults). `media` (QUX-08D: a camera's picture area) is appended after
 *  the lines and before the actions dock -- the caller builds it (main.js owns the
 *  DOM/network side of a camera popup), this function only places it. */
export function siteCard(lines, { actions = [], media = null } = {}) {
  const box = document.createElement('div');
  box.className = 'qcm-site-card';
  // Focusable so opening it can put the keyboard inside; -1 keeps a shut one untabbable.
  box.tabIndex = -1;
  box.setAttribute('role', 'group'); box.setAttribute('aria-label', lines[0] ?? '');
  for (const [i, line] of lines.entries()) {
    const p = document.createElement('p');
    if (i === 0) p.className = 'qcm-site-card-name';
    p.textContent = line;
    box.append(p);
  }
  if (media) box.append(media);
  if (actions.length) {
    // A polite live region, present (empty) from the moment the card is built, never
    // `hidden`: the answer lands while focus is still on the button, so a screen reader
    // hears it only through a region that was already in the accessibility tree when the
    // text changed (WCAG 4.1.3; site-card.test.mjs). Empty, it takes no room (the CSS).
    const status = document.createElement('p');
    status.className = 'qcm-site-card-status';
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const setStatus = (text) => { status.textContent = text || ''; };
    const row = document.createElement('div');
    row.className = 'qcm-site-card-actions';
    const buttons = document.createElement('div');
    buttons.className = 'qcm-site-card-buttons';
    for (const action of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'qcm-site-card-action';
      btn.textContent = action.label;
      if (action.disabled) {
        btn.disabled = true;
        if (action.disabledReason) btn.title = action.disabledReason;
      }
      btn.addEventListener('click', () => {
        Promise.resolve().then(() => action.onActivate(btn))
          .then((text) => setStatus(text || ''))
          .catch((err) => setStatus(err?.message || String(err)));
      });
      buttons.append(btn);
    }
    row.append(status, buttons);
    box.append(row);
  }
  return box;
}

// A popup, never a tooltip, for a card: a ~700-character directions paragraph in a hover
// label is unreadable and undismissable. autoPan is OFF -- the host map refetches on
// `moveend` and renderOverlay clears the overlay, so panning to fit the card closes it.
// The height cap, 230 px, is the stylesheet's (.qcm-site-popup in quiet-corners-maps.css),
// not Leaflet's maxHeight: Leaflet measures a card once, as its popup opens, so a camera
// card's still, landing after that, grew the popup past it. A GNIS name card has five
// actions now and outgrows the cap, so they dock to its bottom edge (siteCard above) and
// the lines scroll under them.
export const CARD_POPUP = { className: 'qcm-site-popup', maxWidth: 260, autoPan: false };

/** Leaflet always opens a card above its pin, so on a pin near the map's top edge the map
 *  cut the card's top off, close button and name included. When the space above is short
 *  and the space below is larger, flip it: `qcm-card-below` (quiet-corners.css) moves the
 *  card and its close button down by --qcm-card-drop and turns the tip up by --qcm-tip-drop,
 *  the same gap on the other side of the pin. Layout offsets ignore that transform, so a
 *  re-placement measures the unflipped card. */
function placeCard(box, pin) {
  const map = box && box.closest('.leaflet-container');
  const wrap = box && box.querySelector('.leaflet-popup-content-wrapper');
  if (!map || !wrap) return;
  const r = pin.getBoundingClientRect(), m = map.getBoundingClientRect();
  const pinY = (r.top + r.bottom) / 2, h = wrap.offsetHeight;
  const gap = pinY - (box.getBoundingClientRect().top + wrap.offsetTop + h);
  const above = pinY - m.top - gap - h, below = m.bottom - pinY - gap - h;
  const flip = above < 0 && below > above;
  box.classList.toggle('qcm-card-below', flip);
  box.style.setProperty('--qcm-card-drop', `${Math.round(h + 2 * gap)}px`);
  box.style.setProperty('--qcm-tip-drop', `${Math.round(2 * gap - 18)}px`);
}

/** Give a drawn feature the three ways a person asks what it is: a pointer, a finger and
 *  a keyboard. The tab stop needs a DOM node, which exists only because the caller passed
 *  the SVG renderer -- under the dashboard's canvas default `getElement()` returns nothing
 *  and this does nothing at all. Without it the layer is decoration: #443 bound a tooltip
 *  to a non-interactive recreation layer and nothing could open it. `card`, when the
 *  feature carries one, replaces the tooltip on Enter and Space; it takes focus as it
 *  opens, Escape shuts it, and whatever shuts it hands the keyboard back to the pin.
 *  `onActivate`, when given, runs once before the card opens on Enter/Space -- the same
 *  thing a caller's own click handler should also run, so a later redraw can still tell
 *  which feature was chosen. */
export function identify(layer, title, card = null, onActivate = null) {
  const el = layer.getElement && layer.getElement();
  if (!el || !title) return layer;
  el.setAttribute('tabindex', '0');
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', title);
  if (card) {
    layer.bindPopup(card, CARD_POPUP);
    el.setAttribute('aria-expanded', 'false');
    // preventScroll: a redraw reopens the selected card from code, not only a
    // reader's own Enter, and a page scroll then moves whatever they were about
    // to click. Nothing pans the card into view either: CARD_POPUP turns autoPan off,
    // so placeCard turns it below its pin instead when the map's top edge would cut it.
    let refit = null;
    layer.on('popupopen', (e) => {
      el.setAttribute('aria-expanded', 'true');
      const box = e.popup.getElement();
      placeCard(box, el);
      // A card grows after it opens (an elevation or a camera still arriving).
      if (typeof ResizeObserver === 'function') {
        refit = new ResizeObserver(() => placeCard(box, el));
        refit.observe(box.querySelector('.leaflet-popup-content-wrapper'));
      }
      card.focus({ preventScroll: true });
    });
    layer.on('popupclose', () => {
      refit?.disconnect(); refit = null;
      el.setAttribute('aria-expanded', 'false'); el.focus();
    });
  }
  const onKey = (e) => {
    if (card && e.key === 'Escape') { e.preventDefault(); layer.closePopup(); return; }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    // QUX-05c: this same handler is bound on both the pin element and the card
    // (below), so it also catches a keydown bubbling up from a focused action
    // button inside the card. Scoped to the pin/card themselves -- anything
    // else (an action button) keeps its own native Enter/Space activation
    // instead of being preventDefault()'d out from under it.
    if (card && e.target !== el && e.target !== card) return;
    // Also what keeps Leaflet's own Enter handler from toggling the popup shut again:
    // a cancelled keydown never becomes the keypress that one listens for.
    e.preventDefault();
    if (card) { onActivate?.(); layer.openPopup(); } else layer.openTooltip();
  };
  el.addEventListener('keydown', onKey);
  // A card is dismissed on purpose: closing on blur would shut it as a reader clicked in.
  if (card) card.addEventListener('keydown', onKey);
  else el.addEventListener('blur', () => layer.closeTooltip());
  return layer;
}
