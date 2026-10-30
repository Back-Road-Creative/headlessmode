// The Field Maps page, and the CSP it needs.
//
// There used to be 52 of these: one page per state plus a federal one. The
// reason was arithmetic, not design. State land services live on ~60 origins, a
// Cloudflare Pages `_headers` LINE caps at 2,000 characters, and a policy naming
// every origin measured 2,087 -- so one page could not carry the catalogue and
// the app was split by state to keep each policy small.
//
// Two things were wrong with that. It counted PARCELS, a family which is not a
// default and is not built; and it wrote every origin as `https://host` when a
// host-source with no scheme is matched against the document's own scheme -- always
// https here -- and so enforces exactly the same thing eight characters cheaper.
// Bare hosts return 456 characters, which is more than parcels ever needed.
//
// So there is ONE map, it names every state's services, parcels included when they
// are built, and which state you are in is a fact about the AREA YOU DREW rather
// than about the URL you opened. Nothing here is waiting on a Pages Function.
import { STATE_CODES, LAYER_IDS, layerFor, isBrowserFetchable, isDrawable } from './state-sources.js';

/** The methodology page. Documentation only -- it fetches nothing, so it gets no
 *  CSP rule; still exported, because the redirect and docs anchor point at it. */
export const MAPS_BASE = '/quiet-corners/maps/';

/** The map. It draws the topographic base and the field layers, so it is the one
 *  page needing a CSP that reaches origins the global same-origin policy blocks. */
export const DASHBOARD_PATH = '/quiet-corners/';

/** Public-land boundaries. Parcels are deliberately absent: they are the family
 *  carrying owner names, and they are a separate decision, not a default. */
export const DEFAULT_FAMILIES = Object.freeze(['gameLands', 'stateParks', 'managedAreas', 'parcels']);

/** Every origin the map may contact for state land, across every state, sorted
 *  and de-duplicated. This is the whole reason the page can be one page. */
export function stateOrigins(families = DEFAULT_FAMILIES) {
  const origins = new Set();
  for (const code of STATE_CODES) {
    for (const family of families) {
      if (!LAYER_IDS.includes(family)) continue;
      const layer = layerFor(code, family);
      if (isBrowserFetchable(layer) && layer.url) origins.add(new URL(layer.url).origin);
    }
  }
  return [...origins].sort();
}

/** Which families a given state can be asked for. Kept for the layer panel,
 *  which now answers "available in this area" rather than "available on this
 *  page"; `source-land-boundaries.js` owns the per-area version. */
export function stateFamilies(code, families = DEFAULT_FAMILIES) {
  return families.filter((f) => LAYER_IDS.includes(f) && isDrawable(layerFor(code, f)));
}

/** Every state whose land this map can draw at all. Not a page list any more --
 *  a coverage list, for the page that reports what each state publishes. */
export function statesWithLayers(families = DEFAULT_FAMILIES) {
  return STATE_CODES.filter((code) => stateFamilies(code, families).length);
}

/** Every exact path `_headers` must carry a Field Maps CSP rule for. One, now that
 *  the builder's own page is documentation: the map is the only thing that
 *  fetches. EXACT rather than a prefix -- Cloudflare joins a repeated header with
 *  a comma and a browser enforces the intersection, so two rules matching one
 *  request could only ever cut the policy back. */
export function mapRulePaths() {
  return [DASHBOARD_PATH];
}
