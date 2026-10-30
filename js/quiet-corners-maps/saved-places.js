// Saved places (QUX-09a): localStorage-backed store for the "Save" button on a
// name card. Pure module -- no DOM, no network, never imported BY
// view-state.js/sheet-plan.js/project-store.js. R2-G2: a write never deletes
// data it cannot read; setItem/removeItem each occur once (source-shape scan
// in saved-places.test.mjs).
import { probedStorage } from './view-wiring.js';
import { NAME_ICON_BY_KIND } from './print-names.js';

export const SAVED_PLACES_KEY = 'qc-saved-places';
export const SCHEMA_VERSION = 1;
export const MAX_PLACES = 200;
export const MAX_IMPORT_BYTES = 1_000_000;

// A ref names what a place points at and is its dedup/merge identity -- no
// bare "a point on the map" form (plan D3). `gnis:` (05c/09a) and `camera:`
// (QUX-09c) refs are produced today; `rec:` is declared for a stable grammar.
const REF_GRAMMAR = [
  /^gnis:\d+$/,
  /^camera:[^:]+:[^:]+(?::[^:]+)?$/, // provider:id, where a Caltrans id is district:index (d05:1)
  /^rec:(usfs|blm):-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/,
];

function validRef(ref) {
  return typeof ref === 'string' && REF_GRAMMAR.some((re) => re.test(ref));
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function finiteInRange(n, min, max) {
  return typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
}

/** The one record constructor. Returns a frozen, validated place, or null --
 *  never throws. */
export function makeSavedPlace(input) {
  if (!input || typeof input !== 'object') return null;
  const { ref, name, kind, lat, lon, state = null, county = null, savedAt } = input;
  if (!validRef(ref)) return null;
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (!trimmedName || trimmedName.length > 200) return null;
  const isCamera = ref.startsWith('camera:');
  if (!(kind in NAME_ICON_BY_KIND) && !(isCamera && kind === 'camera')) return null;
  let latOut = null;
  let lonOut = null;
  const bothNull = lat === null && lon === null;
  if (!(bothNull && isCamera)) {
    // Axis-order trap (plan §2.1): GNIS anchor is [lat, lon], rec lonLat is
    // [lon, lat]. Per-axis range checks catch a swap only when asymmetric.
    if (!finiteInRange(lat, -90, 90)) return null;
    if (!finiteInRange(lon, -180, 180)) return null;
    latOut = round6(lat);
    lonOut = round6(lon);
  }
  return Object.freeze({
    ref,
    name: trimmedName,
    kind,
    lat: latOut,
    lon: lonOut,
    state: typeof state === 'string' ? state : null,
    county: typeof county === 'string' ? county : null,
    savedAt: typeof savedAt === 'string' ? savedAt : new Date().toISOString(),
  });
}

/** The only place this module writes a schema version -- see the source-shape
 *  scan in saved-places.test.mjs. */
export function envelope(places) {
  return { schemaVersion: SCHEMA_VERSION, places: Array.isArray(places) ? places : [] };
}

// No speculative v2 shape ships with 09a.
export const MIGRATIONS = Object.freeze({});

/** Reads one stored envelope; never throws. States: empty, ok, migrated, newer
 *  (read-only) or unreadable (read-only). `kept` carries entries
 *  `makeSavedPlace` rejects, verbatim, so nothing unvalidated is dropped. */
export function parseSavedPlaces(text, { migrations = MIGRATIONS, current = SCHEMA_VERSION } = {}) {
  if (text === null || text === undefined || text === '') return { state: 'empty', places: [], kept: [] };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: 'unreadable', raw: text, reason: 'the stored text is not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'unreadable', raw: text, reason: 'the stored value is not an object' };
  }
  const version = parsed.schemaVersion;
  if (!Number.isInteger(version)) {
    return { state: 'unreadable', raw: text, reason: 'the stored value has no schema version' };
  }
  if (!Array.isArray(parsed.places)) {
    return { state: 'unreadable', raw: text, reason: 'the stored value has no place list' };
  }
  if (version > current) return { state: 'newer', raw: text };
  let places = parsed.places;
  if (version < current) {
    for (let v = version; v < current; v += 1) {
      const step = migrations[v];
      if (typeof step !== 'function') {
        return { state: 'unreadable', raw: text, reason: `no migration from schema ${v}` };
      }
      places = places.map(step);
    }
  }
  const kept = [];
  const built = [];
  for (const raw of places) {
    const place = makeSavedPlace(raw);
    if (place) built.push(place);
    else kept.push(raw);
  }
  return version < current
    ? { state: 'migrated', from: version, places: built, kept }
    : { state: 'ok', places: built, kept };
}

function xmlEscape(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

/** GPX 1.1 waypoints, one per place with finite coordinates; the rest are
 *  skipped and counted. Returns { gpx, skipped, count }. */
export function buildGpx(places) {
  const wpts = [];
  let skipped = 0;
  for (const p of Array.isArray(places) ? places : []) {
    if (!p || typeof p.lat !== 'number' || typeof p.lon !== 'number' || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) {
      skipped += 1;
      continue;
    }
    const desc = [p.kind, p.county, p.state].filter((v) => typeof v === 'string' && v).join(', ');
    wpts.push(`  <wpt lat="${p.lat.toFixed(5)}" lon="${p.lon.toFixed(5)}">\n    <name>${xmlEscape(p.name)}</name>\n${desc ? `    <desc>${xmlEscape(desc)}</desc>\n` : ''}  </wpt>\n`);
  }
  const gpx = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Quiet Corners" xmlns="http://www.topografix.com/GPX/1/1">\n'
    + `${wpts.join('')}</gpx>\n`;
  return { gpx, skipped, count: wpts.length };
}

export function exportGpx(places) {
  return buildGpx(places).gpx;
}

/** localStorage-backed store for saved places. `storage` is required (a real
 *  localStorage or a fake); every method degrades to a result rather than
 *  throwing. */
export function createSavedPlacesStore({ storage, key = SAVED_PLACES_KEY, now = () => new Date().toISOString() }) {
  const probed = probedStorage(storage);

  function readState() {
    if (!probed) return { state: 'unavailable' };
    let raw;
    try {
      raw = probed.getItem(key);
    } catch {
      return { state: 'unavailable' };
    }
    return parseSavedPlaces(raw);
  }

  // The only place this module writes the stored key (source-shape scan).
  function rawSet(text) {
    try {
      probed.setItem(key, text);
      return true;
    } catch {
      return 'quota';
    }
  }

  function commit(mutator) {
    if (!probed) return { ok: false, reason: 'unavailable' };
    const current = readState();
    if (current.state === 'unreadable' || current.state === 'newer') {
      return { ok: false, reason: 'read-only' };
    }
    const places = current.places ? current.places.slice() : [];
    const kept = current.kept ? current.kept.slice() : [];
    const result = mutator(places, kept);
    if (result && result.ok === false) return result;
    const written = rawSet(JSON.stringify(envelope([...places, ...kept])));
    if (written !== true) return { ok: false, reason: 'quota' };
    return result || { ok: true };
  }

  return {
    read: readState,

    add(place) {
      return commit((places) => {
        const built = makeSavedPlace({ ...place, savedAt: (place && place.savedAt) || now() });
        if (!built) return { ok: false, reason: 'invalid' };
        if (places.some((p) => p.ref === built.ref)) return { ok: false, reason: 'already' };
        if (places.length >= MAX_PLACES) return { ok: false, reason: 'full-list' };
        places.push(built);
        return { ok: true, place: built };
      });
    },

    remove(ref) {
      return commit((places) => {
        const idx = places.findIndex((p) => p.ref === ref);
        if (idx === -1) return { ok: false, reason: 'not-found' };
        places.splice(idx, 1);
        return { ok: true };
      });
    },

    /** Merges by ref -- never replaces, never deletes. Over the byte limit,
     *  or unreadable/newer, is refused outright; nothing is written. */
    importText(text) {
      if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) {
        return { added: 0, duplicates: 0, invalid: 0, overLimit: true };
      }
      const incoming = parseSavedPlaces(text);
      if (incoming.state === 'unreadable' || incoming.state === 'newer') {
        return { added: 0, duplicates: 0, invalid: 0, overLimit: false, reason: incoming.state };
      }
      let added = 0;
      let duplicates = 0;
      let invalid = 0;
      const result = commit((places) => {
        for (const raw of [...incoming.places, ...incoming.kept]) {
          const built = raw && raw.ref && validRef(raw.ref) ? makeSavedPlace(raw) : null;
          if (!built) { invalid += 1; continue; }
          if (places.some((p) => p.ref === built.ref)) { duplicates += 1; continue; }
          if (places.length >= MAX_PLACES) { invalid += 1; continue; }
          places.push(built);
          added += 1;
        }
        return { ok: true };
      });
      if (!result.ok) return { added: 0, duplicates: 0, invalid: 0, overLimit: false, reason: result.reason };
      return { added, duplicates, invalid, overLimit: false };
    },

    /** Rescue path: raw stored text when unreadable, else the serialized
     *  envelope (with kept entries). */
    exportText() {
      const current = readState();
      if (current.state === 'unreadable' || current.state === 'newer') return current.raw;
      return JSON.stringify(envelope([...(current.places || []), ...(current.kept || [])]));
    },

    clear() {
      if (!probed) return null;
      let raw = null;
      try {
        raw = probed.getItem(key);
      } catch {
        raw = null;
      }
      try {
        probed.removeItem(key);
      } catch {
        /* degrade silently */
      }
      return raw;
    },

    /** Session-only Undo (plan D7): writes `raw` back only if the key is
     *  still absent -- an intervening write is never clobbered. */
    restore(raw) {
      if (!probed || raw == null) return false;
      let existing;
      try {
        existing = probed.getItem(key);
      } catch {
        existing = undefined;
      }
      if (existing !== null) return false;
      return rawSet(raw) === true;
    },
  };
}
