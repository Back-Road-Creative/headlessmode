// A versioned, shareable Field Maps view — pure (no DOM, no Leaflet, no fetch,
// no Date, no randomness) so node --test covers every rule. main.js (B1) will
// wire this to the map, the address bar and localStorage; nothing here reads
// or writes either.
//
// Schema v1
// ---------
//   { v: 1,
//     center: [lat, lon], zoom,
//     base, surface, overlays: [layerId, ...],
//     county: { scores, metric?, opacity?, thresholds? } | null,
//     labels: { density: 'sparse'|'standard'|'more', size: 'normal'|'large' },
//     emphasis: { dim?: 0..1, lines?: 1|1.5|2, spotlight?: layerId|null },
//     camera: { pitch?, bearing?, exaggeration? } | null,
//     centerSource: 'user'|'location'|'link' }   // NOT serialized — see formatFragment
// `v` is the only required field; every other field's absence falls back to
// DEFAULT_VIEW. `base`, `surface` and layer ids are validated against lists
// the CALLER passes in (`{ bases, surfaces, layerIds }`) rather than imported
// from layer-registry.js / source-basemaps.js, so this module carries no
// registry dependency at all.
//
// Fragment format (short keys, one `&`-joined query string after `#`)
// ---------------------------------------------------------------------
//   #map=v1&z=<zoom>&c=<lat>,<lon>&b=<base>&s=<surface>&o=<id1,id2,...>
//        &cy=<scores(0|1),metric,opacity,t1~t2~t3>&ld=<density,size>
//        &em=<dim,lines,spotlightId>&cam=<pitch,bearing,exaggeration>
//
//   | key  | field(s)                    | notes                                         |
//   |------|------------------------------|-----------------------------------------------|
//   | map  | v (schema version)           | ALWAYS first; `v1` is the only supported value |
//   | z    | zoom                         | plain number, 0..22                            |
//   | c    | center                       | `lat,lon`, 5 decimal places; omitted when      |
//   |      |                              | centerSource is 'location' and includeLocation |
//   |      |                              | was not passed to formatFragment               |
//   | b    | base                         | one enum id                                    |
//   | s    | surface                      | one enum id                                    |
//   | o    | overlays                     | comma-separated layer ids                      |
//   | cy   | county                       | `scores,metric,opacity,t1~t2~t3` — trailing    |
//   |      |                              | empty fields dropped; omitted when county null |
//   | ld   | labels                       | `density,size`                                 |
//   | em   | emphasis                     | `dim,lines,spotlightIdOrEmpty`                 |
//   | cam  | camera                       | `pitch,bearing,exaggeration`, blank = absent   |
//
// A hash that does not start with `#map=` (e.g. `#documentation`) is left
// alone: `parseFragment` returns `{ view: null, notices: [] }` and the caller
// must never rewrite it. `formatFragment`'s output is bounded to
// MAX_FRAGMENT_CHARS; a view with more overlays than fit is clipped from the
// end of the list, with a notice — never silently truncated mid-id.

export const SCHEMA_VERSION = 1;
export const MAX_FRAGMENT_CHARS = 400;
export const MAX_INPUT_CHARS = 2048; // 2 KB — anything longer is refused outright

export const LABEL_DENSITIES = Object.freeze(['sparse', 'standard', 'more']);
export const LABEL_SIZES = Object.freeze(['normal', 'large', 'xlarge']);
export const EMPHASIS_LINE_WEIGHTS = Object.freeze([1, 1.5, 2]);
export const CENTER_SOURCES = Object.freeze(['user', 'location', 'link']);

/** Geographic center of the contiguous US — a reasonable "nowhere in
 *  particular" starting point, not a claim about any real place. */
export const DEFAULT_VIEW = Object.freeze({
  v: SCHEMA_VERSION,
  center: Object.freeze([39.8283, -98.5795]),
  zoom: 4,
  base: 'usgsTopo',
  surface: 'none',
  overlays: Object.freeze([]),
  county: null,
  labels: Object.freeze({ density: 'standard', size: 'normal' }),
  emphasis: Object.freeze({ dim: 0, lines: 1, spotlight: null }),
  camera: null,
  centerSource: 'user',
});

const fmtNum = (n, d = 5) => Number(Number(n).toFixed(d));
const isFiniteNum = (n) => typeof n === 'number' && Number.isFinite(n);

/** Fragment -> `{ view, notices }`. Never throws. `view` is always fully
 *  populated (every optional field filled from DEFAULT_VIEW) except when the
 *  fragment is not ours to touch (`view: null, notices: []`) or its version
 *  is unsupported (`view: null, notices: ['unsupported version']`). */
export function parseFragment(hash, enums = {}) {
  if (typeof hash !== 'string' || !hash.startsWith('#map=')) return { view: null, notices: [] };
  if (hash.length > MAX_INPUT_CHARS) return { view: null, notices: ['fragment exceeds 2 KB and was rejected'] };

  const params = new URLSearchParams(hash.slice(1));
  if (params.get('map') !== `v${SCHEMA_VERSION}`) return { view: null, notices: ['unsupported version'] };

  const bases = enums.bases || [];
  const surfaces = enums.surfaces || [];
  const layerIds = enums.layerIds || [];
  const notices = [];
  const view = { v: SCHEMA_VERSION, centerSource: 'link' };

  if (params.has('z') && params.get('z') !== '') {
    const z = Number(params.get('z'));
    if (isFiniteNum(z) && z >= 0 && z <= 22) view.zoom = z;
    else notices.push(`invalid zoom, using default ${DEFAULT_VIEW.zoom}`);
  }
  if (view.zoom === undefined) view.zoom = DEFAULT_VIEW.zoom;

  if (params.has('c')) {
    const parts = params.get('c').split(',');
    const lat = Number(parts[0]);
    const lon = Number(parts[1]);
    if (parts.length === 2 && isFiniteNum(lat) && isFiniteNum(lon)
      && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      view.center = [lat, lon];
    } else {
      notices.push('invalid center, using default');
    }
  }
  if (!view.center) view.center = [...DEFAULT_VIEW.center];

  if (params.has('b')) {
    const b = params.get('b');
    if (!bases.length || bases.includes(b)) view.base = b;
    else notices.push(`unknown base "${b}" dropped`);
  }
  if (view.base === undefined) view.base = DEFAULT_VIEW.base;

  if (params.has('s')) {
    const s = params.get('s');
    if (!surfaces.length || surfaces.includes(s)) view.surface = s;
    else notices.push(`unknown surface "${s}" dropped`);
  }
  if (view.surface === undefined) view.surface = DEFAULT_VIEW.surface;

  if (params.has('o')) {
    const ids = params.get('o').split(',').filter(Boolean);
    const known = [];
    const unknown = [];
    for (const id of ids) {
      if (!layerIds.length || layerIds.includes(id)) known.push(id);
      else unknown.push(id);
    }
    if (unknown.length) notices.push(`unknown layer id(s) dropped: ${unknown.join(', ')}`);
    view.overlays = known;
  } else {
    view.overlays = [...DEFAULT_VIEW.overlays];
  }

  if (params.has('cy')) {
    const raw = params.get('cy').split(',');
    const county = { scores: raw[0] === '1' };
    if (raw[1]) county.metric = raw[1];
    if (raw[2] !== undefined && raw[2] !== '') {
      const opacity = Number(raw[2]);
      if (isFiniteNum(opacity) && opacity >= 0 && opacity <= 1) county.opacity = opacity;
      else notices.push('invalid county opacity dropped');
    }
    if (raw[3]) {
      const thresholds = raw[3].split('~').map(Number);
      if (thresholds.every(isFiniteNum)) county.thresholds = thresholds;
      else notices.push('invalid county thresholds dropped');
    }
    view.county = county;
  } else {
    view.county = DEFAULT_VIEW.county;
  }

  if (params.has('ld')) {
    const [density, size] = params.get('ld').split(',');
    let okDensity = density;
    if (!LABEL_DENSITIES.includes(density)) {
      notices.push(`invalid label density "${density}" dropped`);
      okDensity = DEFAULT_VIEW.labels.density;
    }
    let okSize = size;
    if (!LABEL_SIZES.includes(size)) {
      notices.push(`invalid label size "${size}" dropped`);
      okSize = DEFAULT_VIEW.labels.size;
    }
    view.labels = { density: okDensity, size: okSize };
  } else {
    view.labels = { ...DEFAULT_VIEW.labels };
  }

  if (params.has('em')) {
    const [dimRaw, linesRaw, spotlightRaw] = params.get('em').split(',');
    let dim = Number(dimRaw);
    if (!isFiniteNum(dim) || dim < 0 || dim > 1) {
      notices.push('invalid emphasis dim dropped');
      dim = DEFAULT_VIEW.emphasis.dim;
    }
    let lines = Number(linesRaw);
    if (!EMPHASIS_LINE_WEIGHTS.includes(lines)) {
      notices.push('invalid emphasis lines dropped');
      lines = DEFAULT_VIEW.emphasis.lines;
    }
    let spotlight = spotlightRaw || null;
    if (spotlight && layerIds.length && !layerIds.includes(spotlight)) {
      notices.push(`unknown spotlight layer "${spotlight}" dropped`);
      spotlight = null;
    }
    view.emphasis = { dim, lines, spotlight };
  } else {
    view.emphasis = { ...DEFAULT_VIEW.emphasis };
  }

  if (params.has('cam')) {
    const [pitchRaw, bearingRaw, exagRaw] = params.get('cam').split(',');
    const camera = {};
    if (pitchRaw) {
      const pitch = Number(pitchRaw);
      if (isFiniteNum(pitch)) camera.pitch = pitch; else notices.push('invalid camera pitch dropped');
    }
    if (bearingRaw) {
      const bearing = Number(bearingRaw);
      if (isFiniteNum(bearing)) camera.bearing = bearing; else notices.push('invalid camera bearing dropped');
    }
    if (exagRaw) {
      const exaggeration = Number(exagRaw);
      if (isFiniteNum(exaggeration)) camera.exaggeration = exaggeration; else notices.push('invalid camera exaggeration dropped');
    }
    view.camera = Object.keys(camera).length ? camera : null;
  } else {
    view.camera = DEFAULT_VIEW.camera;
  }

  return { view, notices };
}

/** View -> `{ fragment, notices }`. The inverse of parseFragment for any view
 *  it can itself produce. `includeLocation: true` is required to serialize a
 *  center whose `centerSource` is 'location' — otherwise it is dropped with a
 *  notice, so a device GPS fix is never baked into a link by accident. */
export function formatFragment(view, { includeLocation = false } = {}) {
  if (!view || view.v !== SCHEMA_VERSION) throw new TypeError('formatFragment: view.v must be 1');
  const notices = [];
  const parts = [`map=v${SCHEMA_VERSION}`];

  if (isFiniteNum(view.zoom)) parts.push(`z=${fmtNum(view.zoom, 2)}`);

  const suppressCenter = view.centerSource === 'location' && !includeLocation;
  if (suppressCenter) {
    notices.push('location-derived center suppressed from the link');
  } else if (Array.isArray(view.center) && view.center.length === 2) {
    parts.push(`c=${fmtNum(view.center[0])},${fmtNum(view.center[1])}`);
  }

  if (view.base) parts.push(`b=${encodeURIComponent(view.base)}`);
  if (view.surface) parts.push(`s=${encodeURIComponent(view.surface)}`);

  if (view.county) {
    const c = view.county;
    const seg = [
      c.scores ? '1' : '0',
      c.metric ? encodeURIComponent(c.metric) : '',
      c.opacity !== undefined ? String(fmtNum(c.opacity, 2)) : '',
      c.thresholds && c.thresholds.length ? c.thresholds.map((t) => fmtNum(t, 2)).join('~') : '',
    ];
    while (seg.length && seg[seg.length - 1] === '') seg.pop();
    if (seg.length) parts.push(`cy=${seg.join(',')}`);
  }

  if (view.labels) parts.push(`ld=${view.labels.density},${view.labels.size}`);

  if (view.emphasis) {
    const e = view.emphasis;
    parts.push(`em=${fmtNum(e.dim ?? 0, 2)},${e.lines ?? 1},${e.spotlight ? encodeURIComponent(e.spotlight) : ''}`);
  }

  if (view.camera) {
    const cam = view.camera;
    parts.push(`cam=${cam.pitch !== undefined ? fmtNum(cam.pitch, 1) : ''},${
      cam.bearing !== undefined ? fmtNum(cam.bearing, 1) : ''},${
      cam.exaggeration !== undefined ? fmtNum(cam.exaggeration, 2) : ''}`);
  }

  let overlays = Array.isArray(view.overlays) ? [...view.overlays] : [];
  const build = () => `#${[...parts, ...(overlays.length ? [`o=${overlays.map(encodeURIComponent).join(',')}`] : [])].join('&')}`;
  let fragment = build();
  let clipped = false;
  while (fragment.length > MAX_FRAGMENT_CHARS && overlays.length) {
    overlays.pop();
    clipped = true;
    fragment = build();
  }
  if (clipped) notices.push('overlays clipped to fit the link length limit');

  return { fragment, notices };
}

function parseLegacyQuery(query) {
  if (typeof query !== 'string' || query.length > MAX_INPUT_CHARS) return null;
  const q = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  if (q.get('v') !== '1') return null;
  const lat = Number(q.get('lat'));
  const lon = Number(q.get('lon'));
  if (!isFiniteNum(lat) || !isFiniteNum(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return [lat, lon];
}

/** The display prefs B1 will persist: base, labels, emphasis. Never center,
 *  zoom, overlays, county or camera — those describe what you are LOOKING AT,
 *  not how you like the map to look. */
export function prefsFromView(view) {
  return { base: view.base, labels: { ...view.labels }, emphasis: { ...view.emphasis } };
}

/** Layer a saved prefs object onto a view, touching only base/labels/emphasis. */
export function viewWithPrefs(view, prefs) {
  if (!prefs) return view;
  return {
    ...view,
    base: prefs.base !== undefined ? prefs.base : view.base,
    labels: prefs.labels ? { ...view.labels, ...prefs.labels } : view.labels,
    emphasis: prefs.emphasis ? { ...view.emphasis, ...prefs.emphasis } : view.emphasis,
  };
}

/**
 * Precedence for the view a page loads with:
 *   1. A map fragment, if present, wins outright — its own fully-resolved
 *      view stands, and neither legacyQuery nor savedPrefs are consulted.
 *   2. Otherwise, a legacy `?v=1&lat=..&lon=..` query supplies the CENTER
 *      only (never zoom or anything else).
 *   3. savedPrefs then fill missing display prefs (base, labels, emphasis) —
 *      never center or zoom.
 *   4. DEFAULT_VIEW (overridden by `defaults.view`, if given) fills the rest.
 *
 * `defaults` doubles as the enum source for fragment validation: pass
 * `{ bases, surfaces, layerIds, view }`.
 */
export function resolveInitialView({ fragment = null, legacyQuery = null, savedPrefs = null, defaults = null } = {}) {
  const enums = { bases: defaults?.bases || [], surfaces: defaults?.surfaces || [], layerIds: defaults?.layerIds || [] };
  const baseline = { ...DEFAULT_VIEW, ...(defaults?.view || {}) };

  if (typeof fragment === 'string' && fragment.startsWith('#map=')) {
    const parsed = parseFragment(fragment, enums);
    if (parsed.view) return parsed;
  }

  let resolvedView = { ...baseline, centerSource: 'user' };
  const notices = [];

  const legacyCenter = parseLegacyQuery(legacyQuery);
  if (legacyCenter) resolvedView = { ...resolvedView, center: legacyCenter, centerSource: 'link' };

  if (savedPrefs && typeof savedPrefs === 'object') {
    const prefs = prefsFromView({ ...DEFAULT_VIEW, ...savedPrefs });
    resolvedView = viewWithPrefs(resolvedView, prefs);
  }

  return { view: resolvedView, notices };
}
