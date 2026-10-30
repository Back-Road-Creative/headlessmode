// Grouping/ordering for the dashboard finder's result shell (audit item 7).
//
// quiet-corners.js's finder already answers with one of a few kinds of hit -- a
// single coordinate pair, a street-address match, or a list of town matches -- and this module
// is the only thing that decides how those become the rows a listbox renders.
// It is pure: no DOM, no Leaflet, so it is coverable with plain node --test
// the way view-wiring.js is. The caller (renderFinderResults) still owns the
// coordinate parse and the name search themselves; nothing about ranking or
// matching changes here.
//
// Option ids are assigned once, in order, across every group -- never per
// group -- because the keydown handler indexes into the flat list of
// role="option" rows in DOM order (finderOptions/setFinderActive), and a
// second group restarting its own numbering would collide with the first.

/** Coordinates, then street addresses, then towns, then names: a coordinate pair is
 *  an unambiguous answer to a query that could never also be a name, so when a
 *  caller supplies more than one kind of hit the pair leads, and an address lookup
 *  (QQA-04b) only runs for text that is address-shaped and matched no town, so its
 *  rows sit ahead of the rest. "Geographic names" (B2, plan §4.3)
 *  is a remote, explicit-submission-only search and sits last by default -- it
 *  answers only after the reader asks for it, well after the two local paths
 *  have already rendered. `rankFinderGroups` below is the one place that default
 *  is overridden. */
export const GROUP_ORDER = Object.freeze(['coordinate', 'address', 'town', 'name']);

const GROUP_LABEL = Object.freeze({
  coordinate: 'Coordinates',
  address: 'Street addresses (estimated)',
  town: 'Towns',
  name: 'Geographic names',
});

/** @param {{coordHit?: object|null, addressHits?: object[], townHits?: object[], nameHits?: object[]}} */
export function groupFinderResults({ coordHit = null, addressHits = [], townHits = [], nameHits = [] } = {}) {
  const bySource = {
    coordinate: coordHit ? [coordHit] : [], address: addressHits || [], town: townHits || [], name: nameHits || [],
  };
  const groups = [];
  let nextId = 0;
  for (const id of GROUP_ORDER) {
    const items = bySource[id];
    if (!items || !items.length) continue;
    groups.push({
      id,
      label: GROUP_LABEL[id],
      items: items.map((item) => ({ ...item, optionId: 'qc-place-opt-' + nextId++ })),
    });
  }
  return groups;
}

/** True when a normalized GNIS record's official name matches the reader's
 *  query exactly (case-insensitive, ignoring surrounding whitespace) AND its
 *  state matches the state qualifier they typed. §4.3: this is the one case
 *  where a remote name outranks a merely partial local town match -- a query
 *  with no state qualifier never counts, because "exact name, any state" is
 *  still ambiguous among however many states carry that name. */
export function isExactNameStateMatch(feature, { query, state } = {}) {
  if (!feature || !query || !state) return false;
  const nameMatches = String(feature.name || '').trim().toLowerCase() === String(query).trim().toLowerCase();
  if (!nameMatches) return false;
  return String(feature.state || '').trim().toUpperCase() === String(state).trim().toUpperCase();
}

/** Reorders already-built finder groups so the "Geographic names" group, last
 *  by default, moves ahead of "Towns" when it carries an exact name+state match
 *  (§4.3: exact name+state outranks a partial local candidate). Coordinates
 *  always lead -- an unambiguous pair is never outranked by anything. Pure
 *  reshuffle of the `groups` array `groupFinderResults` already built; it adds
 *  no items and drops none. */
export function rankFinderGroups(groups, { exactNameStateMatch = false } = {}) {
  if (!exactNameStateMatch) return groups;
  const order = ['coordinate', 'address', 'name', 'town'];
  const byId = new Map(groups.map((g) => [g.id, g]));
  return order.filter((id) => byId.has(id)).map((id) => byId.get(id));
}

/** The rows in the order they render, across every group -- what the option
 *  builder loops over, and what a test checks id numbering against without
 *  reaching back into the group shape. */
export function flattenGroups(groups) {
  return groups.flatMap((g) => g.items);
}

// --- street addresses -------------------------------------------------------
//
// The finder searches a town list, the GNIS name list and coordinates, and (QQA-04b)
// looks a street address up through this site's /api/geocode (address-geocode.js). An
// address used to fall through to the town miss, which said 'No town matching
// "<address>" is in this list.' -- a street address called a missing town.
// looksLikeStreetAddress is the line between "an address, which goes to the address
// lookup when the reader presses Search" and everything else the box takes: a town,
// "Town, ST", a named place, a coordinate pair. Pure and conservative: a name that merely starts with digits
// ("29 Palms, CA", "7 Mile", "100 Mile House") is not an address.

/** The words a street name ends in. A house number plus one of these is an address;
 *  a house number alone ("7 Mile") is not. */
const STREET_SUFFIX = '(?:st|street|rd|road|ave|avenue|blvd|boulevard|ln|lane|dr|drive|ct|court|'
  + 'cir|circle|way|trl|trail|pkwy|parkway|hwy|highway|pl|place|ter|terrace|loop|pike|'
  + 'rte|route|rt|fwy|expy|sq)';

// A conventional house number or a rural grid number (N1234 / W123N456).
const HOUSE_NUMBER = '(?:\\d{1,6}(?:-\\d{1,6}|[a-z])?|[nsew]\\d{1,6}(?:[nsew]\\d{1,6})?)';
// 1-6 digits (an optional letter, as in 12B; "10th" is an ordinal, not a number),
// an optional compass word, up to five name words, then a street suffix. A mileage
// name ("7 Mile Rd", "10 Mile Creek Road") is a road's name, not a household: the
// first word after the number may not be "mile".
const HOUSE_AND_STREET = new RegExp(
  '^\\s*' + HOUSE_NUMBER + "\\s+(?:[nsew]{1,2}\\.?\\s+)?(?!mi(?:les?)?\\b)[\\w'.-]+(?:\\s+[\\w'.-]+){0,4}?\\s+"
  + STREET_SUFFIX + '\\b', 'i');

// On a numbered highway the street type comes BEFORE the route number.
// Requiring a separate house number keeps "Highway 64" on the named-place path.
const HOUSE_AND_ROUTE = new RegExp('^\\s*' + HOUSE_NUMBER
  + '\\s+(?:(?:us|u\\.s\\.|state|county)\\s+)?(?:highway|hwy|route|rte|rt)\\.?\\s+\\d+[a-z]?\\b', 'i');

// A unit word and number on their own: "Apt 4", "Unit 3B", "Suite 200". Only the WHOLE
// term counts. Real place names carry the same words ("Lake Unit 4", "Pond Suite 2",
// "Springfield #2"), so a unit word or '#' inside a longer name proves nothing -- a
// unit after a street address is already covered by HOUSE_AND_STREET.
const UNIT_ONLY = /^\s*(?:apt|apartment|unit|suite|ste)\b\.?\s*#?\s*(?:\d[\w-]*|[a-z])\s*$/i;
// A leading house number and a unit at the end, whatever the street word ("12 Main, Apt 4").
// The house number is what makes it an address; "Lake Unit 4" has none.
const HOUSE_AND_UNIT = new RegExp(
  '^\\s*' + HOUSE_NUMBER + "\\s+(?!mi(?:les?)?\\b)\\S.*?[\\s,]"
  + "(?:(?:apt|apartment|unit|suite|ste)\\b\\.?\\s*#?\\s*|#\\s*)\\d[\\w-]*\\s*$", 'i');
const PO_BOX = /\bp\.?\s?o\.?\s*box\s+\d+/i;
// A whole-term ZIP or ZIP+4, or one trailing a two-letter state ("Hamilton, MT 59840").
const ZIP_ONLY = /^\s*\d{5}(?:-\d{4})?\s*$/;
const STATE_ZIP = /(?:^|[\s,])[a-z]{2}\.?\s+\d{5}(?:-\d{4})?\s*$/i;

/** True when the text is SHAPED like a US street address: house number + street, a
 *  lone unit or PO box, or a ZIP code. False for towns, named places, route and unit
 *  names and coordinates. A shape is a guess, so it is never final: the finder
 *  searches the name first and says "address" only when this is true AND the name
 *  search found nothing (quiet-corners.js renderFinderResults). */
export function looksLikeStreetAddress(term) {
  if (typeof term !== 'string') return false;
  const t = term.trim();
  if (t.length < 3) return false;
  // The house number may open any comma-separated piece: "Apt 4, 12 Main St" and
  // "Smith Farm, 12 Main, Apt 4" are households too, and must never reach the name
  // service. Each tail from a comma on is tested, so a unit after a comma still counts.
  const pieces = t.split(',');
  const tails = pieces.map((_, i) => pieces.slice(i).join(','));
  return tails.some((p) => HOUSE_AND_STREET.test(p) || HOUSE_AND_ROUTE.test(p) || HOUSE_AND_UNIT.test(p))
    || UNIT_ONLY.test(t) || PO_BOX.test(t) || ZIP_ONLY.test(t) || STATE_ZIP.test(t);
}

/** What to try when an address cannot be placed: the three things the box really
 *  does without a geocoder -- the town list and GNIS, a latitude, longitude pair, and
 *  the map itself (drag it to the spot and tap a pin). */
const ADDRESS_ALTERNATIVES = 'Search a town or named place, type coordinates (latitude, longitude), '
  + 'or drag the map to the spot and tap a pin.';

/** How a street match is described wherever it appears. The Census geocoder places a
 *  point by interpolating along the street's address range, so no row may read as a
 *  household, a rooftop or a doorway. */
export const ADDRESS_ESTIMATE_NOTE = 'estimated along the street, not a doorstep';

/** The Census Bureau's requested notice (QQA-04c), shown whenever an answer came from its
 *  geocoder. GEOCODER.md records that it is not verified the Data API terms govern the
 *  geocoder; one legible line is the safe course. */
export const CENSUS_NOTICE = 'This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau.';

/** The lookup outcomes whose text is the geocoder's own answer (or its absence): results, no
 *  match, outage. Searching and a too-short query are ours, not Census's. */
export function addressAnswerShown(status) {
  return status === 'ready' || status === 'none' || status === 'unavailable'
    || status === 'timeout' || status === 'rate-limited';
}

/** What typing an address says: nothing was sent, and where Search will send it. */
export const ADDRESS_PROMPT_MESSAGE = 'Press Search to look up this street address. Search sends what you '
  + 'typed, through this site, to the U.S. Census Bureau\u2019s address geocoder.';

/** The lookup could not answer (outage, 502, 404 where the endpoint is not deployed,
 *  offline). Never a town miss, never a substitute place. */
export const ADDRESS_UNAVAILABLE_MESSAGE = 'Address lookup is unavailable right now. ' + ADDRESS_ALTERNATIVES;

/** What the address-lookup status line says for each outcome ('' when idle). The
 *  no-match and the outage are different sentences on purpose: one says the lookup
 *  worked and found no street, the other that it did not work. */
export function addressStatusText(status, count) {
  if (status === 'searching') return 'Looking up the address\u2026';
  if (status === 'ready') {
    return count + (count === 1 ? ' street match' : ' street matches') + ', ' + ADDRESS_ESTIMATE_NOTE;
  }
  if (status === 'none') return 'No street match was found for that address. Check the spelling. ' + ADDRESS_ALTERNATIVES;
  if (status === 'unavailable') return ADDRESS_UNAVAILABLE_MESSAGE;
  if (status === 'timeout') return 'Address lookup is unavailable right now: it took too long to answer. ' + ADDRESS_ALTERNATIVES;
  if (status === 'rate-limited') {
    return 'Address lookup is unavailable right now: too many lookups. Try again in a minute. ' + ADDRESS_ALTERNATIVES;
  }
  if (status === 'bad-query') return 'That text is too short or too long to look up as an address. ' + ADDRESS_ALTERNATIVES;
  return '';
}
