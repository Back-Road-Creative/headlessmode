// Per-state land layers, read from the measured state-sources.json.
//
// The app already knows which states a sheet covers: the USGS quad index returns
// STATE_ALPHA for every 7.5-minute cell. So a sheet asks for its states' layers,
// and a sheet straddling a state line gets both.
//
// The refuse-list is the point of this module. Every layer records the fields
// carrying a person's name, address, phone or email, and `outFieldsFor` builds
// the query field list from the SAFE fields only -- a personal field is never
// requested, so it cannot reach a rendered sheet even by accident. That is a
// property of the query, not a filter applied afterwards.
import DOC from './state-sources.json' with { type: 'json' };

export const MEASURED_ON = DOC.measuredOn;
export const LAYER_IDS = Object.freeze([...DOC.layers]);
export const STATES = Object.freeze(DOC.states);

/** Two-letter codes, sorted. Every state plus DC is present, even where a layer is absent. */
export const STATE_CODES = Object.freeze(Object.keys(STATES).sort());

/** The layer record for one state, or null. `unverified`/`none` entries are real records. */
export function layerFor(state, layerId) {
  const entry = STATES[String(state || '').toUpperCase()];
  return entry && entry[layerId] ? entry[layerId] : null;
}

/** What a publisher's own terms say about redistributing this layer. Absence is
 *  'unknown', which does NOT block: 204 measured entries publish nothing about
 *  licensing, and treating silence as refusal would empty the catalogue. What is
 *  not allowed is leaving a licence WARNING implicit -- see the test that makes
 *  a note mentioning a licence or a confidentiality exemption carry a verdict. */
export function licenceFor(layer) {
  const l = layer && layer.licence;
  return { redistribute: (l && l.redistribute) || 'unknown', note: (l && l.note) || null };
}

/** False only for a layer whose publisher says it may not be redistributed. */
export function isRedistributable(layer) {
  return licenceFor(layer).redistribute !== 'no';
}

/** True when a layer can be fetched straight from the page (REST + usable CORS)
 *  AND its publisher has not forbidden redistribution.
 *
 *  The licence test lives HERE, at the one seam every caller passes through --
 *  the origin allowlist, the state page specs, the layer controls and the fetch
 *  itself all ask this question -- so a forbidden layer cannot be reached even if
 *  someone later flips its status to live. Idaho's parcel service says it "cannot
 *  be shared outside IDWR" and was unreachable only by the accident of being
 *  `bake`; that is luck, not a rule. */
export function isBrowserFetchable(layer) {
  return !!layer && layer.status === 'live' && (layer.cors === 'star' || layer.cors === 'reflects')
    && isRedistributable(layer);
}

/** Can this map actually DRAW the layer? Fetchable from the page, and the same
 *  kind of thing the family name claims.
 *
 *  Both halves at ONE seam, because they were asked separately and disagreed:
 *  state-pages.js offered a family on `isBrowserFetchable` alone while the fetch
 *  refused it on `isSemanticallyUniform`, so Nebraska's game lands rendered a
 *  checkbox that could never produce a line — its service publishes refuges only,
 *  narrower than the state WMA network the family name promises. */
export function isDrawable(layer) {
  return isBrowserFetchable(layer) && isSemanticallyUniform(layer);
}

/** The safe field names to request. Personal fields are never in the result. */
export function outFieldsFor(layer) {
  if (!layer || !layer.fields) return [];
  const refused = new Set(layer.ownerFields || []);
  return Object.values(layer.fields).filter((f) => typeof f === 'string' && !refused.has(f));
}

/** The WHERE clause a layer needs to return only the features it claims to be.
 *  Several states publish their wildlife areas inside a general public-lands
 *  layer, so an unfiltered query returns land this map would mislabel: Vermont
 *  answers 93 features where 1 is a WMA, Oklahoma 6 where 1 is, Maryland 7 where
 *  3 are. Measured 2026-09-07 — each filter reproduces the count the catalogue
 *  recorded. '1=1' means the layer needs no filter, not that none was checked. */
export function whereFor(layer) {
  return (layer && typeof layer.where === 'string' && layer.where.trim()) || '1=1';
}

/** False when this state's entry is not the same KIND of thing as the family name
 *  implies — Arizona's "game lands" are hunt units covering the whole state, not
 *  public land, and drawing them as a land boundary would be a lie on paper.
 *  Absence of the flag means uniform: silence is not a warning. */
export function isSemanticallyUniform(layer) {
  return !(layer && layer.semantics && layer.semantics.uniform === false);
}

/** Why this state's entry diverges, or null when it does not. */
export function divergenceReason(layer) {
  return isSemanticallyUniform(layer) ? null : layer.semantics.reason || 'not stated';
}

/** Every distinct origin a browser-fetchable layer needs, for the CSP allowlist. */
export function browserFetchOrigins() {
  const origins = new Set();
  for (const entry of Object.values(STATES)) {
    for (const id of LAYER_IDS) {
      const layer = entry[id];
      if (isBrowserFetchable(layer) && layer.url) origins.add(new URL(layer.url).origin);
    }
  }
  return [...origins].sort();
}

/** What the layer panel shows for one state: usable layers, and why the rest are not. */
export function layerReportForState(state, layerId) {
  const layer = layerFor(state, layerId);
  if (!layer) return { state, layerId, usable: false, text: `No record for ${state}.` };
  if (isBrowserFetchable(layer)) {
    return { state, layerId, usable: true, text: `${state}: available`, url: layer.url, outFields: outFieldsFor(layer) };
  }
  if (!isRedistributable(layer)) {
    return { state, layerId, usable: false, text: `${state}: the publisher does not permit redistribution`, note: licenceFor(layer).note };
  }
  const why = {
    none: `no statewide source for ${state}`,
    unverified: `not yet confirmed for ${state}`,
    bake: `${state} needs a prepared copy`,
    'download-only': `${state} publishes a file, not a service`,
  }[layer.status] || `unavailable in ${state}`;
  return { state, layerId, usable: false, text: `${state}: ${why}`, note: layer.note || null };
}
