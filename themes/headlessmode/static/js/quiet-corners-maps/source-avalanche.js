// Avalanche danger ratings by forecast zone, from avalanche.org's public map layer. The
// measurements live on the `avalancheOrgZones` row in source-registry.js.
//
// One national file (about 280 KB, 84 zones) is fetched when the layer is turned on and kept for
// a few minutes; the view only chooses which zones the row lists. The publisher's guide
// (github.com/NationalAvalancheCenter/Avalanche.org-Public-API-Docs) sets three rules this module
// keeps. A rating changes day to day, so past its end date it is EXPIRED and no longer drawn or
// named as a rating. The full forecast is on the centre's site, so every zone links there (or to
// the centre's home page when there is nothing current). And the style is theirs: the danger
// colour with a black outline, thick red for EXTREME, grey with a blue outline for "no rating",
// no shading when no information is available. A view with no zone in it is outside every
// forecast area -- not a statement about the snow.
import { SOURCES } from './source-registry.js';
import { SYMBOLS } from './legend.js';
import { viewReader } from './arcgis-view.js';

const SRC = SOURCES.avalancheOrgZones;

export const MAP_LAYER_URL = SRC.endpoints.mapLayer;
export const CREDIT = SRC.attribution;
const MAX_LISTED = SRC.limits.maxZonesListed;

export const FAILED_TEXT = 'The avalanche danger ratings could not be read, so nothing is drawn.';
export const EMPTY_TEXT = 'No avalanche forecast zone is in this view. Forecast centres cover only the '
  + 'mountains they serve, so no forecast is issued here; that is not a statement about the snow.';
const READ_FORECAST = 'This is each centre\'s rating only: read the full forecast before going into '
  + 'avalanche terrain.';

/** The box a GeoJSON geometry covers, or null when it holds no usable position. */
function boxOf(geometry) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  const walk = (c) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number') {
      if (Number.isFinite(c[0]) && Number.isFinite(c[1])) {
        minLon = Math.min(minLon, c[0]); maxLon = Math.max(maxLon, c[0]);
        minLat = Math.min(minLat, c[1]); maxLat = Math.max(maxLat, c[1]);
      }
      return;
    }
    c.forEach(walk);
  };
  walk(geometry && geometry.coordinates);
  return Number.isFinite(minLon) ? { minLon, minLat, maxLon, maxLat } : null;
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The feed's zones. One with no name, no geometry or a danger level that is not a number is
 *  dropped rather than guessed at; an error body holds none. */
export function readZones(body) {
  const out = [];
  for (const f of Array.isArray(body && body.features) ? body.features : []) {
    const p = (f && f.properties) || {};
    const bbox = f && f.geometry ? boxOf(f.geometry) : null;
    if (!str(p.name) || !bbox || typeof p.danger_level !== 'number' || !Number.isFinite(p.danger_level)) continue;
    out.push({
      id: f.id ?? null, name: str(p.name), center: str(p.center) || str(p.center_id) || 'Avalanche centre',
      centerLink: str(p.center_link), link: str(p.link), state: str(p.state), timezone: str(p.timezone),
      dangerLevel: p.danger_level, danger: str(p.danger) || 'no rating', color: str(p.color),
      stroke: str(p.stroke), offSeason: p.off_season === true,
      startDate: str(p.start_date), endDate: str(p.end_date),
      warning: !!(p.warning && p.warning.product), travelAdvice: str(p.travel_advice),
      geometry: f.geometry, bbox,
    });
  }
  return out;
}

/** The zones whose box meets the view's. A box test, so a zone near a corner may be listed
 *  although its outline stops just short of the view; never the other way round. */
export function zonesInView(zones, v) {
  return (zones || []).filter((z) => z.bbox.maxLon >= v.minLon && z.bbox.minLon <= v.maxLon
    && z.bbox.maxLat >= v.minLat && z.bbox.minLat <= v.maxLat);
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
/** A feed date (no offset) read as UTC: the earliest instant it can mean anywhere in the US. */
function asUtcMs(s) {
  const m = ISO.exec(s || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : null;
}
const shown = (s) => (s ? s.replace('T', ' ').slice(0, 16) : null);

/** What a zone can honestly be shown as right now. `rated` only inside a stated window: a rating
 *  past its end, or with no end to expire it by, is never presented as current. */
export function zoneState(z, nowMs = Date.now()) {
  if (z.dangerLevel < 1) return { kind: 'no-rating' };
  const end = asUtcMs(z.endDate);
  if (end === null) return { kind: 'undated' };
  if (nowMs >= end) return { kind: 'expired' };
  const start = asUtcMs(z.startDate);
  if (start !== null && nowMs < start) return { kind: 'expired' };
  return { kind: 'rated' };
}

/** The publisher's own style for one zone, as Leaflet path options. */
export function zoneStyle(z, nowMs = Date.now()) {
  const kind = zoneState(z, nowMs).kind;
  if (kind === 'rated') {
    const extreme = z.dangerLevel >= 5;
    return { color: extreme ? '#ff0000' : '#000000', weight: extreme ? 4 : 1.5,
      fillColor: z.color || '#888888', fillOpacity: 0.5, interactive: false };
  }
  if (kind === 'no-rating') {
    return { color: z.stroke || '#104efb', weight: 1.5, fillColor: z.color || '#888888',
      fillOpacity: 0.5, interactive: false };
  }
  // Expired or undated: no information is available, so no shading, just the outline.
  return { color: '#000000', weight: 1.5, fillColor: '#000000', fillOpacity: 0, interactive: false };
}

/** One sentence for one zone: where, whose, what rating (or why none), the window, the link. */
export function zoneLine(z, nowMs = Date.now()) {
  const kind = zoneState(z, nowMs).kind;
  const where = `${z.name} (${z.center})`;
  const window = z.startDate && z.endDate ? ` Issued ${shown(z.startDate)}, expires ${shown(z.endDate)}, as the feed states them.` : '';
  if (kind === 'rated') {
    return `${where}: ${z.danger} (${z.dangerLevel} of 5)${z.warning ? ', with an avalanche warning in effect' : ''}.`
      + `${window} Forecast: ${z.link || z.centerLink || 'the centre\'s site'}`;
  }
  if (kind === 'no-rating') {
    const why = z.offSeason ? 'no rating, off season' : 'no rating; the centre publishes a summary';
    return `${where}: ${why}. ${z.offSeason ? 'Centre' : 'Summary'}: ${z.link || z.centerLink || 'the centre\'s site'}`;
  }
  const why = kind === 'expired' ? 'the last rating has expired, so none is shown'
    : 'the rating came with no expiry, so it is not shown as current';
  return `${where}: ${why}.${window} Centre: ${z.centerLink || z.link || 'the centre\'s site'}`;
}

const order = (z, nowMs) => (zoneState(z, nowMs).kind === 'rated' ? z.dangerLevel : 0);

/** The layer row for the view: the zones in it, most dangerous first, a few at most. */
export function areaReport(got, nowMs = Date.now()) {
  if (!got || got.status !== 'ok') return { known: false, text: FAILED_TEXT };
  const zones = got.zones || [];
  if (!zones.length) return { known: true, text: EMPTY_TEXT };
  const sorted = [...zones].sort((a, b) => order(b, nowMs) - order(a, nowMs) || a.name.localeCompare(b.name));
  const lines = sorted.slice(0, MAX_LISTED).map((z) => zoneLine(z, nowMs));
  const more = sorted.length > MAX_LISTED ? ` ${sorted.length - MAX_LISTED} more zone${sorted.length - MAX_LISTED === 1 ? '' : 's'} in view; zoom in to list them.` : '';
  return { known: true, text: `${lines.join(' ')}${more} ${READ_FORECAST}` };
}

/** The national file, asked for once and kept `reuseSeconds`. Only a success is kept, so a
 *  failure is asked again on the next view. Concurrent callers share one request. */
export function createZoneStore({ fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  let held = null, heldAt = 0, pending = null;
  return {
    async get(signal) {
      if (held && now() - heldAt < SRC.limits.reuseSeconds * 1000) return { status: 'ok', zones: held };
      if (!pending) {
        pending = (async () => {
          try {
            const res = await fetchImpl(MAP_LAYER_URL, { signal });
            if (!res.ok) return { status: 'failed' };
            const body = await res.json();
            if (!body || !Array.isArray(body.features)) return { status: 'failed' };
            held = readZones(body); heldAt = now();
            return { status: 'ok', zones: held };
          } catch { return { status: 'failed' }; } finally { pending = null; }
        })();
      }
      return pending;
    },
  };
}

/** One view question at a time, waiting out a drag; it answers the zones in that view. */
export function avalancheReader({ store = createZoneStore(), ...rest } = {}) {
  return viewReader({
    ...rest,
    fetchOne: async (bbox, { signal }) => {
      const got = await store.get(signal);
      return got.status === 'ok' ? { status: 'ok', zones: zonesInView(got.zones, bbox) } : got;
    },
  });
}

/** A Leaflet group drawing each zone in the publisher's style; `draw` takes the zones to show. */
export function avalancheLayer(L) {
  const group = L.layerGroup();
  group.draw = function draw(zones, nowMs = Date.now()) {
    group.clearLayers();
    for (const z of zones || []) {
      L.geoJSON({ type: 'Feature', geometry: z.geometry, properties: {} }, { style: zoneStyle(z, nowMs) }).addTo(group);
    }
    return group;
  };
  return group;
}

export const LAYER_LABEL = 'Avalanche danger (forecast centre ratings)';
export const LAYER_CAVEAT = 'Each forecast zone\'s danger rating as its avalanche centre issued it, '
  + 'gathered by avalanche.org: a summary, not the forecast. Read the full forecast on the centre\'s '
  + 'site, linked from each zone, before going into avalanche terrain. Zones cover only the mountains a '
  + 'centre serves; outside them no forecast is issued, which says nothing about the snow. Out of season '
  + 'a zone has no rating. A rating expires, and past its end date it is no longer shown. The feed gives '
  + 'its dates with no time zone, so they are shown as it states them and a rating is ended at the '
  + 'earliest time they could mean. Screen only.';

export const CONTEXT_ROW = Object.freeze({
  id: 'avalancheDanger',
  group: 'context',
  label: LAYER_LABEL,
  sourceId: 'avalancheOrgZones',
  screenOnly: true,   // a rating that expires each day has no business on a printed sheet
  defaultOn: false,
  required: false,
  symbolKeys: [SYMBOLS.basemap.key],
  // Nothing in view is a real answer -- no centre forecasts there -- and the row says exactly that.
  emptyMeans: 'none',
  status: 'live',
  coverageCaveat: LAYER_CAVEAT,
  render: { labels: 'none', dropBelowScale: null },
});

/** Every string this source can put in front of a reader, for the wording test. */
export function readerStrings(nowMs = Date.now()) {
  const z = { name: 'Z', center: 'C', centerLink: 'https://c/', link: 'https://c/f', dangerLevel: 3,
    danger: 'considerable', offSeason: false, startDate: null, endDate: null, warning: true };
  return [CREDIT, LAYER_LABEL, LAYER_CAVEAT, FAILED_TEXT, EMPTY_TEXT, READ_FORECAST,
    zoneLine(z, nowMs), zoneLine({ ...z, dangerLevel: -1, offSeason: true }, nowMs),
    zoneLine({ ...z, dangerLevel: -1 }, nowMs),
    zoneLine({ ...z, startDate: '2026-01-01T06:00:00', endDate: '2026-01-02T06:00:00' }, nowMs)];
}
