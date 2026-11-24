// Road names, as data. Pure: no DOM, no fetch. source-road-names.js fetches; a later unit
// draws. Until now no layer supplied road names -- they existed only as the sparse lettering
// printed into USGS Topo tiles.
//
// Source: The National Map transportation service, five line layers (measured 2026-10-05).
// Each layer first appears at a zoom of the publisher's own choosing and this table follows
// it, so a road class never appears here earlier than it appears on the source's own map:
//   29 Controlled-access Highways  zoom 10   shield from `interstate`, else US/state route
//   30 Secondary Highways          zoom 11   shield from `us_route`, else `state_route`
//   31 Local Connecting Roads      zoom 12   name
//   35 4WD Roads                   zoom 12   name, else `federal_lands_route`
//   32 Local Roads                 zoom 13   name
// Route fields can hold a list ("23,74"), which prints as "US 23/74".

const freezeDeep = (o) => { Object.values(o).forEach((v) => { if (v && typeof v === 'object') freezeDeep(v); }); return Object.freeze(o); };

/** The class table. `shield` lists which route fields can print as a shield, in preference
 *  order; `label` lists how the printed label is chosen, first hit wins. */
export const ROAD_CLASSES = freezeDeep([
  { layer: 29, key: 'controlled', name: 'Controlled-access Highways', zoom: 10, shield: ['interstate', 'us', 'state'], label: ['shield', 'name'] },
  { layer: 30, key: 'secondary', name: 'Secondary Highways', zoom: 11, shield: ['us', 'state'], label: ['shield', 'name'] },
  { layer: 31, key: 'connecting', name: 'Local Connecting Roads', zoom: 12, shield: [], label: ['name'] },
  { layer: 35, key: '4wd', name: '4WD Roads', zoom: 12, shield: ['federal'], label: ['name', 'shield'] },
  { layer: 32, key: 'local', name: 'Local Roads', zoom: 13, shield: [], label: ['name'] },
]);

/** Roads drawn at once, per the display density setting. Its own table: road lettering is
 *  denser than place names and must not borrow name-labels.js's DENSITY_CAP. */
export const ROAD_DENSITY_CAP = Object.freeze({ sparse: 12, standard: 25, more: 40 });

// Printing order: the interstate first, then everything else controlled-access (a US route
// built as an expressway), then US/state routes, connecting roads, 4WD, local.
const RANK = Object.freeze({ interstate: 0, controlled: 1, secondary: 2, connecting: 3, '4wd': 4, local: 5 });

// Census state FIPS -> postal code, for "NC 107" from stco_fipscode ("37099").
const STATE_BY_FIPS = Object.freeze({
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', 10: 'DE', 11: 'DC',
  12: 'FL', 13: 'GA', 15: 'HI', 16: 'ID', 17: 'IL', 18: 'IN', 19: 'IA', 20: 'KS', 21: 'KY', 22: 'LA',
  23: 'ME', 24: 'MD', 25: 'MA', 26: 'MI', 27: 'MN', 28: 'MS', 29: 'MO', 30: 'MT', 31: 'NE', 32: 'NV',
  33: 'NH', 34: 'NJ', 35: 'NM', 36: 'NY', 37: 'NC', 38: 'ND', 39: 'OH', 40: 'OK', 41: 'OR', 42: 'PA',
  44: 'RI', 45: 'SC', 46: 'SD', 47: 'TN', 48: 'TX', 49: 'UT', 50: 'VT', 51: 'VA', 53: 'WA', 54: 'WV',
  55: 'WI', 56: 'WY',
});

/** Classes drawn at zoom z, in first-zoom order. Below the first class's zoom (10) the answer
 *  is [] because no row of the table starts lower; a non-number is [] too. */
export function layersForZoom(z) {
  if (typeof z !== 'number' || !Number.isFinite(z)) return [];
  return ROAD_CLASSES.filter((c) => c.zoom <= z)
    .sort((a, b) => a.zoom - b.zoom || a.layer - b.layer)
    .map((c) => c.layer);
}

/** An attribute by key, ignoring key case (ArcGIS aliases differ in case between layers and
 *  between `outFields` spellings). Blank, null and punctuation-only values are null. */
export function readAttr(attrs, key) {
  if (!attrs || typeof attrs !== 'object') return null;
  const want = String(key).toLowerCase();
  const k = Object.keys(attrs).find((name) => name.toLowerCase() === want);
  if (k === undefined) return null;
  const v = attrs[k];
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return /[A-Za-z0-9]/.test(s) ? s : null;
}

// Route-field tokens that qualify a route rather than number it ("Bus,23" is US 23 Business).
const ROUTE_QUALIFIERS = Object.freeze({
  bus: 'Bus', business: 'Bus', byp: 'Byp', bypass: 'Byp', alt: 'Alt', alternate: 'Alt',
  truck: 'Truck', spur: 'Spur', loop: 'Loop', conn: 'Conn', connector: 'Conn', scenic: 'Scenic',
});

/** "23,74" -> "23/74"; qualifier tokens move behind the numbers: "Bus,23" -> "23 Bus". Empty
 *  when no route number is left (a bare qualifier is not a shield). */
function routeText(v) {
  const nums = [];
  const quals = [];
  for (const raw of String(v).split(/[,;/\s]+/)) {
    const t = raw.trim();
    if (!t) continue;
    const q = ROUTE_QUALIFIERS[t.toLowerCase()];
    const list = q ? quals : nums;
    const val = q || t;
    if (!list.includes(val)) list.push(val);
  }
  return nums.length ? [nums.join('/'), ...quals].join(' ') : '';
}

/** The shield a road's route fields print as: "I-26", "US 74", "NC 107", "FS 4600" -- or null
 *  when the class has no shield or the fields do not give one. A state route whose state
 *  cannot be read from stco_fipscode gives null, never a guessed prefix. */
export function shieldText(cls, attrs) {
  for (const kind of (cls && cls.shield) || []) {
    if (kind === 'interstate') {
      const v = readAttr(attrs, 'interstate');
      const r = v ? routeText(v.replace(/^I[-\s]*/i, '')) : '';
      if (r) return `I-${r}`;
    } else if (kind === 'us') {
      const v = readAttr(attrs, 'us_route');
      const r = v ? routeText(v) : '';
      if (r) return `US ${r}`;
    } else if (kind === 'state') {
      const v = readAttr(attrs, 'state_route');
      const fips = readAttr(attrs, 'stco_fipscode');
      const st = fips ? STATE_BY_FIPS[fips.slice(0, 2)] : null;
      const r = v && st ? routeText(v) : '';
      if (r) return `${st} ${r}`;
    } else if (kind === 'federal') {
      const v = readAttr(attrs, 'federal_lands_route');
      if (v) return `FS ${v}`;
    }
  }
  return null;
}

const KEEP_UPPER = new Set(['US', 'NC', 'NE', 'NW', 'SE', 'SW']);

/** A label cleaned for print. "I- 26" -> "I-26"; "US Hwy 74" -> "US 74"; SHOUTING names of four
 *  or more letters -> Title Case (US/NC/I- tokens kept); "<" ">" stripped; spaces collapsed. */
export function normalizeRoadName(s) {
  if (s === null || s === undefined) return '';
  let t = String(s).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  t = t.replace(/\bI-\s*(\d)/g, 'I-$1');
  t = t.replace(/\b([A-Za-z]{2})\s+(?:hwy|highway|rte|route)\.?\s+(?=\d)/gi,
    (m, p) => (p === p.toUpperCase() ? `${p} ` : m));
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 4 && letters === letters.toUpperCase()) {
    t = t.split(' ').map((w) => {
      if (/^I-\d/.test(w) || KEEP_UPPER.has(w)) return w;
      return w.toLowerCase().replace(/(^|-)([a-z])/g, (m, a, c) => a + c.toUpperCase());
    }).join(' ');
  }
  return t.trim();
}

// Equirectangular metres: ample for ranking and choosing a segment at road scale.
const M_PER_DEG = 111320;
function segMetres(a, b) {
  const dx = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180) * M_PER_DEG;
  const dy = (b[1] - a[1]) * M_PER_DEG;
  return Math.hypot(dx, dy);
}
const pathMetres = (p) => { let m = 0; for (let i = 1; i < p.length; i += 1) m += segMetres(p[i - 1], p[i]); return m; };

/** Midpoint of a polyline's longest segment, and that segment's text rotation. `bearing` is
 *  the CSS rotation (degrees, clockwise on screen, 0 = text running east) that lays lettering
 *  along the segment, flipped into the upright range (-90, 90] so text never reads upside
 *  down. Coordinates are [lon, lat]. null for fewer than two distinct points. */
export function anchorOnPolyline(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return null;
  let best = -1; let bestLen = 0;
  for (let i = 1; i < coords.length; i += 1) {
    const len = segMetres(coords[i - 1], coords[i]);
    if (len > bestLen) { bestLen = len; best = i; }
  }
  if (best < 0) return null;
  const a = coords[best - 1]; const b = coords[best];
  const dx = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  const dy = b[1] - a[1];
  let deg = -Math.atan2(dy, dx) * 180 / Math.PI;
  while (deg > 90) deg -= 180;
  while (deg <= -90) deg += 180;
  return { lon: (a[0] + b[0]) / 2, lat: (a[1] + b[1]) / 2, bearing: deg + 0 };
}

const classOf = (f) => ROAD_CLASSES.find((c) => c.layer === f.layer || c.key === f.layer || c.key === f.classKey);

function labelFor(cls, attrs) {
  for (const rule of cls.label) {
    const raw = rule === 'shield' ? shieldText(cls, attrs) : readAttr(attrs, 'name');
    const label = normalizeRoadName(raw);
    if (label) return label;
  }
  return '';
}

/** Raw features -> one entry per normalised label. Each feature is `{layer, attributes,
 *  geometry: {paths}}` (`layer` = the service layer id). An entry keeps every part (`parts`),
 *  the longest one (`longest`, `lengthM`) and its anchor, and takes the most important class
 *  the label appeared on -- US 74 on both the controlled-access and secondary layers is one
 *  entry. A feature with no label or no drawable path is dropped. */
export function groupRoads(features) {
  const byKey = new Map();
  for (const f of features || []) {
    const cls = f && classOf(f);
    if (!cls) continue;
    const label = labelFor(cls, f.attributes);
    const paths = ((f.geometry && f.geometry.paths) || []).filter((p) => Array.isArray(p) && p.length >= 2);
    if (!label || !paths.length) continue;
    const rank = cls.key === 'controlled' && label.startsWith('I-') ? RANK.interstate : RANK[cls.key];
    const key = label.toLowerCase();
    let e = byKey.get(key);
    if (!e) {
      e = { key, label, layer: cls.layer, classKey: cls.key, rank, parts: [], longest: null, lengthM: -1 };
      byKey.set(key, e);
    } else if (rank < e.rank) {
      Object.assign(e, { layer: cls.layer, classKey: cls.key, rank });
    }
    for (const p of paths) {
      e.parts.push(p);
      const m = pathMetres(p);
      if (m > e.lengthM) { e.lengthM = m; e.longest = p; }
    }
  }
  const out = [...byKey.values()];
  for (const e of out) e.anchor = anchorOnPolyline(e.longest);
  return out.filter((e) => e.anchor);
}

/** Printing order, most important first: interstate, other controlled-access, US/state,
 *  connecting, 4WD, local; within a class the longer road first, then by label. A copy. */
export function roadLabelOrder(entries) {
  return [...(entries || [])].sort((a, b) => a.rank - b.rank || b.lengthM - a.lengthM
    || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}
