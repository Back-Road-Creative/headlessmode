// GNIS named-terrain vocabulary: turns a raw geonames MapServer feature (layers 3
// Populated Places / 5 Landforms / 6 Streams (Mouth) / 7 Other Hydrographic
// Features) into one normalized label record, and orders those records the way a
// reader should see them on the map. Pure module -- no fetch, no DOM.
//
// PRIORITY LADDER (lower number = shown first when labels crowd). Ported from the
// Waypost label ladder: a reader orienting on a field map wants to know where they
// ARE (place) before what is around them (summit, gap), then the skyline shape
// (ridge/range), then water features worth a name (falls/spring/lake), then the
// long tail of minor named landforms, and last the streams that only carry a name
// at their mouth -- most numerous, least useful for orientation at a glance.
//   1 place            (layer 3: Populated Place)
//   2 summit           (layer 5: Summit)
//   3 gap              (layer 5: Gap)
//   4 ridge/range      (layer 5: Ridge, Range)
//   4.5 river          (NHD flowline named River or Fork, drawn on the reach in view)
//   5 falls/spring/lake(layer 7: Falls, Spring, Lake, Reservoir)
//   6 other named land/water (layer 5 misc landforms; layer 7 misc hydro features)
//   6.5 creek          (NHD flowline, every other name)
//   7 stream mouth     (layer 6: Stream, Canal)
import { SOURCES } from './source-registry.js';

const GNIS = 'gnisNames';
const PLACE = { kind: 'place', glyph: 'place', priority: 1, minZoom: 8, source: GNIS };
const SUMMIT = { kind: 'summit', glyph: 'summit', priority: 2, minZoom: 9, source: GNIS };
const GAP = { kind: 'gap', glyph: 'gap', priority: 3, minZoom: 10, source: GNIS };
const RIDGE = { kind: 'ridge', glyph: 'ridge', priority: 4, minZoom: 11, source: GNIS };
const WATER_FEATURE = { kind: 'water-feature', glyph: 'water', priority: 5, minZoom: 12, source: GNIS };
const OTHER_LAND = { kind: 'other-land', glyph: 'other', priority: 6, minZoom: 12, source: GNIS };
const OTHER_WATER = { kind: 'other-water', glyph: 'other', priority: 6, minZoom: 12, source: GNIS };
// A river or creek is a LINE (source-stream-names.js, NHD flowlines), so it is placed on the reach
// in view rather than at one point that may lie outside it: `crossing` marks that. Priorities are
// fractional so they slot into the ladder without renumbering it.
const RIVER = { kind: 'river', glyph: 'river', priority: 4.5, minZoom: 9, source: 'nhdFlowlines', crossing: true };
const CREEK = { kind: 'creek', glyph: 'creek', priority: 6.5, minZoom: 11, source: 'nhdFlowlines', crossing: true };
const STREAM_MOUTH = { kind: 'stream-mouth', glyph: 'stream', priority: 7, minZoom: 13, source: GNIS };

/** (layer, gaz_featureclass) -> kind entry. Every class measured live on 2026-09-25
 *  across layers 3/5/6/7 (names-distinct-{3,5,6,7}.bin) is listed explicitly so an
 *  unmapped class is a genuinely unknown one, not a gap in this table. */
export const KINDS = Object.freeze({
  3: Object.freeze({ 'Populated Place': PLACE }),
  5: Object.freeze({
    Summit: SUMMIT,
    Gap: GAP,
    Ridge: RIDGE,
    Range: RIDGE,
    Arch: OTHER_LAND, Area: OTHER_LAND, Arroyo: OTHER_LAND, Basin: OTHER_LAND,
    Beach: OTHER_LAND, Bench: OTHER_LAND, Bend: OTHER_LAND, Cape: OTHER_LAND,
    Cliff: OTHER_LAND, Crater: OTHER_LAND, Flat: OTHER_LAND, Island: OTHER_LAND,
    Isthmus: OTHER_LAND, Lava: OTHER_LAND, Pillar: OTHER_LAND, Plain: OTHER_LAND,
    Slope: OTHER_LAND, Valley: OTHER_LAND, Woods: OTHER_LAND,
  }),
  6: Object.freeze({ Stream: STREAM_MOUTH, Canal: STREAM_MOUTH }),
  // NHD flowlines (nhdFlowlines), not a GNIS layer: keyed 'nhd' so a layer number never has to
  // stand for it. normalizeFeature below never sees it; source-stream-names.js builds these.
  nhd: Object.freeze({ River: RIVER, Creek: CREEK }),
  7: Object.freeze({
    Falls: WATER_FEATURE, Spring: WATER_FEATURE, Lake: WATER_FEATURE, Reservoir: WATER_FEATURE,
    Bar: OTHER_WATER, Bay: OTHER_WATER, Channel: OTHER_WATER, Glacier: OTHER_WATER,
    Gut: OTHER_WATER, Levee: OTHER_WATER, Rapids: OTHER_WATER, Sea: OTHER_WATER,
    Swamp: OTHER_WATER,
  }),
});

/** A class present in a known layer but absent from KINDS[layer] normalizes to
 *  this rather than to null -- the feature is real and placeable, it is just a
 *  vocabulary gap this table should grow to cover. A layer/feature combination
 *  this module cannot place at all (unknown layer, or no attributes/geometry to
 *  anchor on) normalizes to null instead: see normalizeFeature below. */
const UNKNOWN_KIND = Object.freeze({ kind: 'other', glyph: 'other', priority: 6, minZoom: 12, source: GNIS });

function kindFor(layerId, cls) {
  const table = KINDS[layerId];
  if (!table) return null;
  return table[cls] || UNKNOWN_KIND;
}

/** Strip anything HTML-shaped out of a gazetteer name. Names are free text from a
 *  federal database, never markup, but a malformed or tampered payload should not
 *  be able to inject a tag into a label rendered as innerHTML downstream. */
function safeName(raw) {
  const s = typeof raw === 'string' ? raw : '';
  return s.replace(/[<>]/g, '').trim();
}

function firstPoint(geometry) {
  if (!geometry) return null;
  if (Array.isArray(geometry.points) && geometry.points.length > 0) {
    const [lon, lat] = geometry.points[0];
    if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    return { anchor: [lat, lon], pointCount: geometry.points.length };
  }
  if (typeof geometry.x === 'number' && typeof geometry.y === 'number'
    && Number.isFinite(geometry.x) && Number.isFinite(geometry.y)) {
    return { anchor: [geometry.y, geometry.x], pointCount: 1 };
  }
  return null;
}

/** One raw ArcGIS feature from layer 3/5/6/7 -> one label record, or null when the
 *  payload cannot be placed. Never throws -- a malformed feature from an upstream
 *  service is a data problem for the caller to skip, not a build/render failure.
 *
 *  Decisions, documented because the source data forced them (2026-09-25 probes):
 *  - A class present on a known layer but missing from KINDS normalizes to kind
 *    'other' (UNKNOWN_KIND above), not null: the feature is real and has a
 *    placeable point, just outside today's vocabulary.
 *  - A feature with no gaz_id, no gaz_name, or no usable point geometry (observed
 *    live: geonames-fetch-p2.min.json page 2 drops `geometry` entirely on some
 *    features) normalizes to null: it cannot be given a stable id or plotted, and
 *    that is a genuinely malformed record, not an unknown vocabulary entry.
 *  - A multipoint feature (esriGeometryMultipoint, layers 3/5/6) keeps only its
 *    FIRST point as the anchor and records pointCount for the caller; a Valley or
 *    a Summit that straddles county lines returns as several fetch rows sharing
 *    one gaz_id (observed live: "Cold Mountain" gaz_id 1019725 appears once per
 *    county) and it is fetchBounded's job (source-terrain-names.js) to dedupe by
 *    id, not this function's. */
export function normalizeFeature(layerId, esriFeature) {
  if (!esriFeature || typeof esriFeature !== 'object') return null;
  const attrs = esriFeature.attributes;
  if (!attrs || typeof attrs !== 'object') return null;
  const gazId = Number(attrs.gaz_id);
  const name = safeName(attrs.gaz_name);
  if (!Number.isFinite(gazId) || !name) return null;
  const point = firstPoint(esriFeature.geometry);
  if (!point) return null;
  const cls = typeof attrs.gaz_featureclass === 'string' ? attrs.gaz_featureclass : '';
  const kindEntry = kindFor(layerId, cls);
  if (!kindEntry) return null;
  return {
    id: `gnis:${gazId}`,
    name,
    kind: kindEntry.kind,
    cls,
    state: typeof attrs.state_alpha === 'string' ? attrs.state_alpha : null,
    county: typeof attrs.county_name === 'string' ? attrs.county_name : null,
    anchor: point.anchor,
    pointCount: point.pointCount,
    layer: layerId,
    historical: false,
  };
}

const priorityOf = (feature) => {
  const table = KINDS[feature.layer];
  const entry = (table && table[feature.cls]) || UNKNOWN_KIND;
  return entry.priority;
};

const minZoomOf = (feature) => {
  const table = KINDS[feature.layer];
  const entry = (table && table[feature.cls]) || UNKNOWN_KIND;
  return entry.minZoom;
};

/** Deterministic label order: the selected feature always first, then ascending
 *  priority (the ladder above), then name, then id -- so two features tied on
 *  every other key never depend on array/fetch order for a stable sort. `zoom`,
 *  when given, drops any feature whose kind has not reached its minimum zoom yet
 *  rather than merely re-ordering it -- an unreached kind is not on the field map
 *  at this zoom at all. */
export function labelPriorityOrder(features, { zoom, selectedId } = {}) {
  const list = Array.isArray(features) ? features.filter(Boolean) : [];
  const visible = Number.isFinite(zoom) ? list.filter((f) => minZoomOf(f) <= zoom) : list;
  return [...visible].sort((a, b) => {
    if (selectedId != null && (a.id === selectedId) !== (b.id === selectedId)) {
      return a.id === selectedId ? -1 : 1;
    }
    const pa = priorityOf(a);
    const pb = priorityOf(b);
    if (pa !== pb) return pa - pb;
    const nameCmp = a.name.localeCompare(b.name);
    if (nameCmp !== 0) return nameCmp;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Request budget per extent, one number shared with the source registry. */
const NAMES_BUDGET = SOURCES.gnisNames.limits.recordBudgetPerExtent;

/** Every GNIS featureclass whose KINDS minZoom the zoom has reached, in layer order. Derived
 *  from KINDS, so the request can never ask for a class the zoom would not draw.
 *  Empty below the lowest minZoom (8). */
export function kindsForZoom(zoom) {
  if (!Number.isFinite(zoom)) return [];
  const out = [];
  for (const [layer, table] of Object.entries(KINDS)) {
    if (!/^\d+$/.test(layer)) continue; // 'nhd' is asked of its own source, never of the GNIS service
    for (const [cls, entry] of Object.entries(table)) if (entry.minZoom <= zoom) out.push(cls);
  }
  return out;
}

/** What to ask the GNIS service for in a view: the classes this zoom can draw and the
 *  record budget. No area refusal -- a large extent shrinks what fetchBounded draws
 *  (rung by rung), never the request to nothing. `bbox` is accepted for the caller's
 *  symmetry and deliberately unused. */
export function namesPlanForView({ zoom } = {}) {
  return { kinds: kindsForZoom(zoom), budget: NAMES_BUDGET };
}
