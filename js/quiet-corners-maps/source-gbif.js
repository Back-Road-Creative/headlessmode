// GBIF wildlife observations for one map cell, read as a bounded AGGREGATE.
//
// THE CONSTRAINT, and it is the whole design rather than a caveat bolted on afterwards.
// `coordinateUncertaintyInMeters` was absent on 4,043 of 133,925 records in the dense probe
// cell (3.0%) and on 62 of 827 in the sparse one (7.5%). A dot on a map is a precision claim,
// and GBIF cannot back one for all but a twentieth of what it holds -- so this layer colours a
// cell and draws no per-record point, ever. Nothing here reads a record's coordinates at all.
//
// THE SECOND CONSTRAINT. A cell count is a count of RECORDS somebody submitted. It over-counts
// where two publishers republish one sighting (GBIF exposes `isInCluster`, the aggregate cannot
// use it), and effort is wildly uneven -- two same-size cells measured 133,925 records and 827,
// a 162-fold difference in recording and not in wildlife. So every number here is stated as an
// upper bound, and an empty cell says "no records in this selection" and never "no animals".
//
// One `limit=0` facet request per cell: 3,505 bytes and 0.52-0.90 s measured, against 2,206,314
// bytes for a single 300-record page of the same cell. Paging is disqualified (offset caps at
// 100,001; the download API answers 403 without an account) and so are the v2 density tiles,
// which accept `license` and discard it.
//
// Every reader-facing string is built here so gbif.test.mjs can scan the lot.
import { SOURCES } from './source-registry.js';
import { fetchWithDeadline } from './request.js';

const SRC = SOURCES.gbifOccurrence;
export const SERVICE = SRC.serviceUrl;
export const DATASET_SERVICE = SRC.layers[1].queryUrl;
export const CREDIT = SRC.attribution;
/** A COMPLETE whitelist, not a best-effort blocklist: the licence enum is closed at five
 *  values, so naming two excludes the other three by construction, and an unknown value is
 *  answered with HTTP 400 rather than being passed through. */
export const LICENCE_WHITELIST = Object.freeze([...SRC.policy.allowed]);
/** `scientificName` rather than `speciesKey`: the facet returns the NAME, so no taxon lookup
 *  is needed -- and a `taxonKey=` parameter would read as a credential to the registry test. */
export const FACETS = Object.freeze(['scientificName', 'datasetKey', 'month', 'year', 'basisOfRecord']);
const FACET_LIMIT = '25';
/** Deliberately widened records announce themselves at about 28.6 km. They are counted by
 *  UNCERTAINTY and never by `issues`: all 20 withheld records seen carried exactly the issues
 *  array ordinary records carry, so `issues` is a 100%-false-positive filter for this. */
export const MAX_UNCERTAINTY_METRES = 20000;
const WINDOW_YEARS = 12;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const group = (n) => Number(n).toLocaleString('en-US');

/** The date window every query is scoped to, and the words for it. A count with no window
 *  invites the present tense, so the window reaches the reader in the same sentence. */
export function dateWindow(nowMs = Date.now()) {
  const to = new Date(nowMs).getUTCFullYear();
  const from = to - (WINDOW_YEARS - 1);
  return Object.freeze({ from: `${from}-01-01`, to: `${to}-12-31`, label: `${from} to ${to}` });
}

const box = ({ minLon, minLat, maxLon, maxLat }, win) => ({
  limit: '0', hasCoordinate: 'true', hasGeospatialIssue: 'false',
  license: LICENCE_WHITELIST,
  eventDate: `${win.from},${win.to}`,
  decimalLatitude: `${minLat},${maxLat}`, decimalLongitude: `${minLon},${maxLon}`,
});

/** The card for one cell: a count plus five facet histograms, in one request. */
export function aggregateQueryFor(bbox, win = dateWindow()) {
  return { url: SERVICE, params: { ...box(bbox, win), facet: [...FACETS], facetLimit: FACET_LIMIT } };
}

/** How many records in the cell state a location that was deliberately widened. */
export function generalizedQueryFor(bbox, win = dateWindow()) {
  return { url: SERVICE,
    params: { ...box(bbox, win), coordinateUncertaintyInMeters: `${MAX_UNCERTAINTY_METRES},10000000` } };
}

/** The same cell with NO licence filter, so the layer can say how much it is not showing.
 *  Without it, "open-licensed records only" is a policy the reader cannot see the cost of. */
export function unfilteredQueryFor(bbox, win = dateWindow()) {
  const params = { ...box(bbox, win) };
  delete params.license;
  return { url: SERVICE, params };
}

/** Repeated parameters, not comma-joined: `license` goes out twice, and so does `facet`. */
export function queryUrl(req) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(req.params)) {
    for (const one of Array.isArray(v) ? v : [v]) q.append(k, one);
  }
  return `${req.url}?${q}`;
}
export const aggregateQueryUrl = (bbox, win) => queryUrl(aggregateQueryFor(bbox, win));

const facet = (body, field) => {
  const f = (Array.isArray(body && body.facets) ? body.facets : []).find((x) => x && x.field === field);
  return Array.isArray(f && f.counts) ? f.counts : [];
};
const numbers = (counts) => counts.map((c) => Number(c.name)).filter(Number.isFinite);

/** The response reduced to what a reader is told. A body that is not a search response --
 *  an error envelope, a timeout's null -- is UNKNOWN rather than zero: those are different
 *  facts about a cell and the row says which. */
export function readAggregate(body) {
  // `body` first, and its own type: `Number(null)` is 0, so a request that failed and
  // returned null would otherwise read as a cell with zero records in it -- the one
  // conflation this layer must not make.
  const count = body && typeof body === 'object' ? Number(body.count) : NaN;
  if (!Number.isInteger(count)) {
    return { known: false, count: null, upperBound: true, species: [], busiestMonth: null,
      earliestYear: null, latestYear: null, datasetKeys: [] };
  }
  const months = facet(body, 'MONTH');
  const years = numbers(facet(body, 'YEAR'));
  return {
    known: true,
    count,
    // Always. Cross-publisher duplicates are unmeasured and a facet count cannot dedupe them.
    upperBound: true,
    species: facet(body, 'SCIENTIFIC_NAME').map((c) => ({ name: c.name, count: c.count })),
    busiestMonth: months.length ? Number(months[0].name) : null,
    earliestYear: years.length ? Math.min(...years) : null,
    latestYear: years.length ? Math.max(...years) : null,
    datasetKeys: facet(body, 'DATASET_KEY').map((c) => c.name),
  };
}

export const datasetUrl = (key) => `${DATASET_SERVICE}/${key}`;

/** One dataset's own published credit. `citation.text` is what GBIF generates, DOI and access
 *  date already interpolated, and it is the only credit worth printing: `datasetName` is absent
 *  on the largest publisher and `rightsHolder`/`recordedBy` are private individuals. */
export function readDatasetCredit(body) {
  const text = body && body.citation && typeof body.citation.text === 'string' ? body.citation.text.trim() : '';
  if (!text) return null;
  return { key: body.key || null, title: body.title || null, credit: text };
}

/** The credit lines for the datasets a cell drew on, de-duplicated.
 *
 *  The dataset's OWN `license` is deliberately not among them. iNaturalist's dataset record
 *  reads CC BY-NC 4.0 while 2,417 of its records passed the record-level CC0/CC-BY filter in
 *  the probe cell -- so the dataset licence is not the licence of what is shown here, and
 *  printing it beside these counts would be a false statement about them. */
export function creditLines(bodies = []) {
  const seen = new Set();
  const out = [];
  for (const b of bodies) {
    const c = readDatasetCredit(b);
    if (!c || seen.has(c.credit)) continue;
    seen.add(c.credit);
    out.push(c.credit);
  }
  return out;
}

/** What the licence whitelist cost this cell, when both numbers are in hand. A missing
 *  comparison is silence, never a zero: "nothing excluded" and "we did not ask" differ. */
export function licenceGapText(filtered, unfiltered) {
  const gap = Number(unfiltered) - Number(filtered);
  if (!Number.isFinite(gap) || gap <= 0) return '';
  return `A further ${group(gap)} records here are not open-licensed and are not shown.`;
}

/** Deliberately widened locations, in the reader's words. Zero says nothing. */
export function generalizedText(n) {
  const k = Number(n);
  if (!Number.isFinite(k) || k <= 0) return '';
  return `${group(k)} of them state a location deliberately widened to about 28 kilometres — to `
    + 'protect a threatened species, or because the recorder asked — so they are counted here '
    + 'and never placed.';
}

export function quietText(win = dateWindow()) {
  return `No records in this selection: nobody submitted an open-licensed record inside this `
    + `area for ${win.label}. That is silence about recording, not about the ground.`;
}

export function failedText() {
  return 'Wildlife records are unavailable — the service did not answer. That is a gap in this '
    + 'page, not a finding about this area.';
}

export function notSearchedText() {
  return 'Not searched yet. Records are asked for only once this surface is switched on.';
}

/** The row for one cell. The WINDOW and the ceiling come first, because a bare count reads as
 *  a number of animals; the species and the season follow; what the licence filter removed and
 *  what was deliberately blurred close it. */
export function areaReport(bodies, win = dateWindow()) {
  if (!bodies) return { state: 'notSearched', count: null, text: notSearchedText() };
  const agg = readAggregate(bodies.aggregate);
  if (!agg.known) return { state: 'failed', count: null, text: failedText() };
  if (agg.count === 0) return { state: 'quiet', count: 0, text: quietText(win) };
  const top = agg.species[0];
  const parts = [
    `At most ${group(agg.count)} records were submitted inside this area for ${win.label} — an `
      + 'upper bound, because two publishers can submit the same sighting and a count of records '
      + 'cannot tell them apart.',
    top ? `Most recorded: ${top.name}, ${group(top.count)} records.` : '',
    agg.busiestMonth ? `Most records in ${MONTHS[agg.busiestMonth - 1]}.` : '',
    agg.latestYear ? `Latest year with records: ${agg.latestYear}.` : '',
    generalizedText(readAggregate(bodies.generalized).count),
    licenceGapText(agg.count, readAggregate(bodies.unfiltered).count),
  ];
  return { state: 'records', count: agg.count, text: parts.filter(Boolean).join(' ') };
}

/** Every string this source can put in front of a reader, in one place, for the test. */
export function readerStrings(bodies = {}, win = dateWindow()) {
  return [quietText(win), failedText(), notSearchedText(),
    areaReport(bodies, win).text, areaReport({ aggregate: bodies.empty }, win).text,
    generalizedText(70), licenceGapText(1, 2), LAYER_LABEL, LAYER_CAVEAT, CREDIT,
    ...creditLines(bodies.credits || [])];
}

export const LAYER_LABEL = 'Wildlife records submitted here (open-licensed only)';
export const LAYER_CAVEAT = 'Counts of times somebody saw a living thing inside the area you '
  + 'are looking at and wrote it down — a birder’s checklist, a naturalist’s photograph, a '
  + 'museum specimen. It is a record of effort, and effort is wildly uneven: two cells the same '
  + 'size measured 133,925 records and 827, a difference in recording rather than in wildlife. '
  + 'The count is an upper bound, because two publishers can submit the same sighting. Nothing '
  + 'is drawn as a dot: 97 per cent of records state no precision at all, so the area is '
  + 'shaded and no location inside it is claimed. An empty cell means "no records in this '
  + 'selection" and nothing more. Only public-domain and Creative Commons Attribution records '
  + 'are asked for, and each contributing dataset is credited by its own published citation.';

/** A Leaflet group holding ONE box: the cell that was asked about, shaded by how much was
 *  recorded in it. Not a mark per record and not a mark per species -- 97% of records state no
 *  precision, so there is no honest place to put one. The shade is a log-ish ramp because
 *  effort spans three orders of magnitude between neighbouring cells. */
export function gbifLayer(L) {
  const cell = L.layerGroup();
  cell.draw = function draw(agg, bbox) {
    cell.clearLayers();
    if (!agg || !agg.known || !agg.count || !bbox) return cell;
    const steps = Math.min(5, Math.max(1, Math.ceil(Math.log10(agg.count))));
    L.rectangle([[bbox.minLat, bbox.minLon], [bbox.maxLat, bbox.maxLon]], {
      color: '#4f7a4a', weight: 1, fillColor: '#4f7a4a',
      fillOpacity: 0.04 + 0.05 * steps, interactive: false,
    }).addTo(cell);
    return cell;
  };
  return cell;
}

export async function fetchJson(url, { fetchImpl = fetch, signal } = {}) {
  const got = await fetchWithDeadline(url, { fetchImpl, signal, timeoutMs: SRC.timeoutMs });
  return got.ok ? got.body : null;
}

/** One cell at a time, and only for the view the reader stopped on. The same shape as the AQI
 *  reader and for the same reason: a pan is a NEW question, but asking per frame of a drag is
 *  not, so the ask waits and an answer about the view you left is abandoned rather than written
 *  into the row. `ask` resolves false when it was dropped.
 *
 *  Three bounded requests, ~4 KB: the card, the widened-record count, and the same cell with no
 *  licence filter so the row can say what the filter removed. Dataset credits follow from the
 *  keys the card returned, capped, and GBIF caches them for an hour. */
export function gbifReader({ fetchImpl = fetch, waitMs = 500, maxCredits = 4,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null, live = null, drop = null;
  const stop = () => {
    if (timer) clearTimer(timer);
    if (live) live.abort();
    if (drop) drop(false);
    timer = null; live = null; drop = null;
  };
  return {
    cancel: stop,
    ask(bbox, win, deliver) {
      stop();
      return new Promise((resolve) => {
        drop = resolve;
        timer = setTimer(async () => {
          timer = null;
          const ctl = new AbortController();
          live = ctl;
          const get = (req) => fetchJson(queryUrl(req), { fetchImpl, signal: ctl.signal });
          const [aggregate, generalized, unfiltered] = await Promise.all([
            get(aggregateQueryFor(bbox, win)), get(generalizedQueryFor(bbox, win)),
            get(unfilteredQueryFor(bbox, win)),
          ]);
          if (live !== ctl) return;   // a newer ask took over and already resolved this one
          const credits = await Promise.all(readAggregate(aggregate).datasetKeys.slice(0, maxCredits)
            .map((k) => fetchJson(datasetUrl(k), { fetchImpl, signal: ctl.signal })));
          if (live !== ctl) return;
          live = null; drop = null;
          deliver({ aggregate, generalized, unfiltered, credits });
          resolve(true);
        }, waitMs);
      });
    },
  };
}
