// Build pipeline for /quiet-corners/maps/: tiles -> worker render per sheet -> createPdf. No DOM; fetch, createImageBitmap, worker, pdf-lib, clock and abort signal are injected.
import { inverse, forward } from './geometry.js';
import { chooseLevel, tilesForPlan, fetchTiles, accountTiles } from './source-usgs-topo.js';
import { placementMesh, tileDrawOps } from './raster-placement.js';
import { TYPES, PHASES, progressText, validateRenderRequest, transferablesOf } from './render-protocol.js';
import { deriveLegend } from './legend.js';
import { createPdf, TYPE } from './pdf.js';
import { vectorsForSheet, labelCandidates, pagePxForSheet } from './overlay-paths.js';
import { POINTS_PER_INCH } from './sheet-plan.js';
import { SOURCES, attributionLines } from './source-registry.js';
import { LAYERS } from './layer-registry.js';
import { fetchAerial } from './source-aerial.js';
import { seasonalWindows } from './source-mvum.js';
import { fetchTerrain } from './source-terrain.js';
import { profileFor } from './source-elevation.js';
import { labelPriorityOrder } from './terrain-names.js';
import { namesCompletenessGate, placeNameLabels, approxLabelBox, markerBox, nameLegendEntries } from './print-names.js';

const cancelled = () => Object.assign(new Error('Build cancelled.'), { name: 'AbortError' });
const centreLatLon = (extent, zone, hemisphere) =>
  inverse((extent.minX + extent.maxX) / 2, (extent.minY + extent.maxY) / 2, zone, hemisphere);

/** Level and de-duplicated tile set for a plan (pure; the estimate uses it too). */
export function tilePlan(plan) {
  const { zone, hemisphere } = plan.input, first = plan.sheets[0];
  const { level } = chooseLevel({ metersPerPixel: first.metersPerPixel, latDeg: centreLatLon(plan.covered, zone, hemisphere).lat });
  return { level, tiles: tilesForPlan(plan, { zone, hemisphere, level }) };
}

// The worker draws every tile at the origin: fold the tile's world-pixel position into e,f (level-16 world pixels, ~1e7, lose precision in float32).
const rebase = ({ dx, dy, transform: t, ...op }) =>
  ({ ...op, transform: { a: t.a, b: t.b, c: t.c, d: t.d, e: t.a * dx + t.c * dy + t.e, f: t.b * dx + t.d * dy + t.f } });

function renderInWorker(worker, request, onProgress) {
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data: m }) => {
      if (m.type === TYPES.PROGRESS) onProgress(m);
      else if (m.type === TYPES.DONE) resolve(m);
      else if (m.type === TYPES.ERROR) reject(new Error(`Sheet ${m.sheetId}: ${m.message}`));
    };
    worker.onerror = (e) => reject(new Error(e.message || 'The print renderer failed.'));
    worker.postMessage(request, transferablesOf(request));
  });
}

// Every MVUM layer result the page checked, flattened to the features that carry geometry.
const mvumFeatures = (mvum) => Object.values(mvum).flatMap((r) => (r && Array.isArray(r.features) ? r.features : []));

// A state land family's credit is its own agency's, and the catalogue records a
// url rather than an agency name, so the family is what the sheet can honestly say.
const LAND_LABEL = { gameLands: 'State game lands', stateParks: 'State parks and forests', managedAreas: 'Other state-managed areas' };

// A Forest Service map labels a road by its NUMBER and a trail by its NAME, so a
// reader who knows those maps reads this one. labelCandidates keys on the
// feature id, so this resolves that id to whichever the sheet should show.
// Anything that is NOT a road is known by its name: a trail, and equally a state
// land boundary, whose `id` is the service's OBJECTID. Keying on the road prefix
// rather than the trail one is what stops a park boundary printing as "104857".
const labelTextFor = (features) => {
  const byId = new Map(features.filter((f) => f.id).map((f) => [f.id, f]));
  return (id, key) => {
    const f = byId.get(id);
    if (!f) return id;
    return key.startsWith('mvum-road-') ? (f.id || f.name) : (f.name || null);
  };
};


/** Companion sheets, one per map sheet, from whichever source is asked for. A
 *  sheet whose image fails is simply absent from the set: the map sheets are
 *  already built and must still print. One function, not one per companion kind --
 *  the only thing that differs is which service is called. */
async function companionSheets(plan, recipe, fetchImpl, check, fetchOne, signal) {
  const out = [];
  for (const sheet of plan.sheets) {
    check();
    try { out.push(await fetchOne({ sheet, bboxLonLat: recipe.bboxLonLat, fetchImpl, signal })); }
    catch { /* an extra page, never the map */ }
    // A cancel ends the request as an error like any other; it must not read as "this extra failed".
    check();
  }
  return out;
}

/** One row per NAMED route on the set: length, climb, and the sheets it crosses.
 *  Unnamed geometry is left out — a table of "unnamed" rows tells nobody anything.
 *  Elevation is sampled per route, so this is capped rather than unbounded. */
const MAX_TRIP_ROUTES = 12;
async function tripRows(features, plan, sheets, fetchImpl, { zone, hemisphere, scale, signal, check }) {
  const named = features.filter((f) => f.name && (f.paths || []).length).slice(0, MAX_TRIP_ROUTES);
  const rows = [];
  for (const f of named) {
    const on = plan.sheets.filter((sheet) => vectorsForSheet([f], sheet, { zone, hemisphere, scale }).vectors.length).map((s) => s.id);
    let profile = { lengthM: null, gainM: null, sampled: false };
    // Climb is detail: a 3DEP outage costs the column, not the row or the page.
    try { profile = { ...(await profileFor(f, { fetchImpl, signal })), sampled: true }; }
    catch { /* leave the climb blank rather than guess it */ }
    check();
    rows.push({ id: f.id, name: f.name, useCode: f.useCode || null, sheets: on, ...profile });
  }
  return rows;
}

export async function runBuild({ recipe, plan, adapters, workerFactory, PDFLib, onProgress = () => {}, signal, now = () => new Date().toISOString(), createPdfImpl = createPdf }) {
  const started = Date.now(), { zone, hemisphere } = plan.input, { fetchImpl, createImageBitmap, mvum = {} } = adapters;
  // Layers that arrive already normalized, each carrying its own symbolKey. They
  // join the SAME vector path MVUM uses -- a boundary ring and a trail are both
  // polylines once clipped, so nothing here needs to know which is which.
  const check = () => { if (signal?.aborted) throw cancelled(); };
  const progress = (phase, a, b) => onProgress({ phase, text: progressText(phase, a, b), a, b });
  const { level, tiles } = tilePlan(plan);
  progress(PHASES.FETCH, 0, tiles.count);
  const fetched = await fetchTiles(tiles.unique, { fetchImpl, signal, onProgress: (a, b) => progress(PHASES.FETCH, a, b) });
  check();
  const account = accountTiles(tiles.unique.map((t) => t.key), [...fetched.results].filter(([, r]) => r.ok).map(([k]) => k));
  if (!account.complete) throw new Error(account.message);
  // Named terrain (GNIS). Screen-side registration of this layer (Q/layer-
  // registry.js, Q/main.js) is a different unit; this reads whatever shape
  // fetchBounded (source-terrain-names.js) returns via `adapters.names`, exactly
  // the way build.js reads `adapters.trails`/`adapters.land`. Gated the same way
  // the tile completeness check above is: partial/over-cap/timeout blocks export
  // until retry or an explicit `recipe.layers.names === false`.
  const namesEnabled = !!adapters.names && recipe.layers?.names !== false;
  if (namesEnabled) {
    const gate = namesCompletenessGate({ enabled: true, status: adapters.names.status });
    if (!gate.ok) throw new Error(gate.reason);
  }
  const nameFeatures = namesEnabled ? labelPriorityOrder(adapters.names.features || [], {}) : [];
  // TYPE.minPt is a fixed physical size in PDF points; a name label/marker is
  // sized in the sheet's own raster pixels for collision math, and pt-per-px is
  // POINTS_PER_INCH/dpi everywhere on this sheet (pdf.js's layoutLabels/
  // layoutSites use the identical ratio via image.w/pixel.width).
  const namesSizePx = TYPE.minPt * (recipe.dpi / POINTS_PER_INCH);
  const retrievedAt = now(), byKey = new Map(tiles.unique.map((t) => [t.key, t]));
  const worker = workerFactory();
  await new Promise((resolve, reject) => { worker.onmessage = ({ data }) => data.type === TYPES.READY && resolve(); worker.onerror = (e) => reject(new Error(e.message || 'The print renderer failed to start.')); });
  const onLayer = (id) => recipe.layers?.[id] !== false;
  const extra = [
    ...(onLayer('trails') ? adapters.trails?.features || [] : []),
    // PER FEATURE, not per hardcoded family list. Every boundary carries its own
    // toggle id in `layer`, which is exactly what the preview filters on
    // (`on[f.layer]`), so the sheet and the preview agree by construction.
    //
    // The old form named the three STATE families and asked whether ANY was on.
    // It shipped wrong the moment federal land arrived: someone who wanted
    // national forests and no state land at all had every named family off, so
    // the whole of adapters.land was dropped and the federal boundaries vanished
    // from paper with nothing said. The mirror bug was there too — one state
    // family on printed every OTHER family's boundaries as well.
    ...(adapters.land || []).filter((f) => onLayer(f.layer)),
  ];
  const sites = onLayer('recSites') ? adapters.sites || [] : [];
  const sheets = [], features = [...(recipe.layers?.mvum === false ? [] : mvumFeatures(mvum)), ...extra], drawnKeys = new Set();
  const drawnNameKinds = new Set(), drawnNameFeatures = new Map();
  let namesDropped = 0;
  const labelText = labelTextFor(features);
  // Road quality is an enrichment of roads already fetched, joined on route id. It is
  // optional by construction: with no table every road keeps its plain width, so a
  // failed or skipped lookup costs detail, never the sheet.
  const roadQuality = adapters.roadQuality || {};
  try {
    for (const sheet of plan.sheets) {
      check();
      const used = tiles.perSheet[sheet.id].map((k) => byKey.get(k));
      const ops = tileDrawOps(placementMesh(sheet, { zone, hemisphere, level }), used).map(rebase);
      const bitmaps = await Promise.all(used.map(async (t) => ({ key: t.key, bitmap: await createImageBitmap(new Blob([fetched.results.get(t.key).bytes])) })));
      check();
      // Overlay vectors are page px for THIS sheet: clipped to its rect, so a road on
      // one sheet contributes nothing to a distant one, and the legend lists only what
      // some sheet actually drew.
      const { vectors, symbolKeys } = vectorsForSheet(features, sheet, { zone, hemisphere, dpi: recipe.dpi, roadQuality, scale: recipe.scale });
      for (const k of symbolKeys) drawnKeys.add(k);
      const request = validateRenderRequest({ type: TYPES.RENDER, sheetId: sheet.id, width: sheet.pixel.width, height: sheet.pixel.height, tiles: bitmaps, ops, vectors, dpi: recipe.dpi });
      const done = await renderInWorker(worker, request, onProgress);
      const c = centreLatLon(sheet.extent, zone, hemisphere);
      // A feature with no name to print is left unlettered rather than lettered with its id.
      const labels = labelCandidates(vectors).map((l) => ({ ...l, text: labelText(l.text, l.key) })).filter((l) => l.text);
      // Named terrain shares the SAME collision budget as the labels just placed
      // above, plus the rec-site markers (projected here purely for the reserved
      // box, same as the toPx layoutSites uses at draw time), plus the sheet's own
      // pixel bounds. The anchor marker is drawn for every on-sheet feature
      // unconditionally; only its text label can be dropped and counted.
      const toPxNames = pagePxForSheet(sheet, zone, hemisphere);
      const reserved = [
        ...labels.map((l) => approxLabelBox(l.text, l.x, l.y, namesSizePx)),
        ...sites.map((s) => { const p = toPxNames(s.lonLat[0], s.lonLat[1]); return markerBox(p.x, p.y, namesSizePx); }),
      ];
      const onSheet = nameFeatures.filter((f) => {
        const p = toPxNames(f.anchor[1], f.anchor[0]);
        return p.x >= -namesSizePx && p.x <= sheet.pixel.width + namesSizePx && p.y >= -namesSizePx && p.y <= sheet.pixel.height + namesSizePx;
      });
      const named = placeNameLabels(onSheet, { toPx: toPxNames, reserved, pixel: sheet.pixel, sizePx: namesSizePx });
      namesDropped += named.dropped;
      for (const m of named.marks) { drawnNameKinds.add(m.kind); if (!drawnNameFeatures.has(m.id)) drawnNameFeatures.set(m.id, { id: m.id, name: m.name, kind: m.kind }); }
      // Sites travel with their sheet as lon/lat; pdf.js places and clips them, so
      // the same list can serve a sheet at any scale without being recomputed.
      sheets.push({
        id: sheet.id, jpeg: new Uint8Array(done.bytes), labels: [...labels, ...named.labels], sites,
        nameMarks: named.marks, convergenceDeg: forward(c.lat, c.lon, zone, hemisphere).convergenceDeg,
      });
    }
  } finally { worker.postMessage({ type: TYPES.CANCEL }); worker.terminate(); }
  check();
  const assembledAt = now(), mvumSources = Object.entries(mvum).map(([layer, r]) =>
    ({ id: `usfsMvum:${layer}`, retrievedAt: r.retrievedAt, coverage: r.coverage, requested: r.expectedCount, received: r.receivedCount, level: null }));
  const sourceLine = [`${SOURCES.usgsTopo.name} level ${level}, ${tiles.count} tiles, retrieved ${retrievedAt}`,
    ...mvumSources.map((s) => `${SOURCES.usfsMvum.name} ${s.id.split(':')[1]} retrieved ${s.retrievedAt || 'n/a'} (${s.coverage})`)].join('; ');
  // A drawn site needs its key entry too: drawnKeys is what the legend lists, and a
  // marker on the sheet with no swatch beside it is a symbol the reader cannot read.
  for (const site of sites) if (site.symbolKey) drawnKeys.add(site.symbolKey);
  const gridEnabled = recipe.grid !== 'none';
  // Credit follows what the build CONSUMED, not a hand-written pair of ids: the
  // footer named USGS Topo and MVUM while NAIP, 3DEP, the trails host and the rec
  // sites host all printed uncredited. Extras count — an aerial sheet is a page
  // built from NAIP whether or not it drew a line on the map. A `screenOnly`
  // layer is the opposite case: it can be switched on and named a real source,
  // but it never enters the printable-vector fetch loop and is not an extra
  // page either, so turning it on for the SCREEN must not put its publisher on
  // the printed key for a sheet it never touched.
  const consumed = LAYERS.filter((l) => l.status === 'live' && l.sourceId && !l.screenOnly
    && (l.required || recipe.layers?.[l.id])).map((l) => l.sourceId);
  // GNIS names is not yet a LAYERS registry entry (that registration is N2's, a
  // different unit): credited manually, and only when something was actually
  // drawn from it, the same "consumed, not merely fetched" rule every other
  // source above follows.
  if (drawnNameKinds.size) consumed.push('gnisNames');
  // State land has no single measured service: its credit is the state's own
  // agency, named per family from what was drawn.
  // STATE families only: a federal or ownership boundary in the same list is
  // credited through its sourceId above, and naming "the state agency" for it
  // would credit an agency that never published it.
  const landCredits = [...new Set((adapters.land || []).filter((f) => LAND_LABEL[f.layer] && drawnKeys.has(f.symbolKey))
    .map((f) => `${LAND_LABEL[f.layer] || f.layer} — published by the state agency named on this map's source page`))];
  // The open dates go with the routes that were DRAWN, not with everything fetched:
  // a window for a road on another sheet is a date the reader cannot use and cannot
  // check. `features` is what reached the paper.
  const legend = { ...deriveLegend({ renderedSymbolKeys: [...drawnKeys], gridEnabled, basemapRendered: true,
    seasonalWindows: seasonalWindows(features) }),
  attribution: attributionLines(consumed, landCredits) };
  // The legend lists exactly the icon kinds drawn: nameLegendEntries takes only
  // the kinds placeNameLabels actually put a marker down for, never the full
  // NAME_ICON_BY_KIND vocabulary.
  legend.entries = [...legend.entries, ...nameLegendEntries(drawnNameKinds)];
  const manifest = {
    assembledAt, sources: [{ id: 'usgsTopo', retrievedAt, coverage: 'complete', requested: fetched.requested, received: fetched.received, level }, ...mvumSources],
    recipe: plan.input, level, tileCount: tiles.count,
    // Every drawn name's id + source provenance, with the GNIS retrieval date kept
    // separate from the service's own data vintage (source-registry.js's
    // `measuredOn`) -- one answers "when did we ask", the other "how current is
    // GNIS's own inventory".
    ...(namesEnabled ? { names: {
      sourceId: 'gnisNames', retrievedAt: adapters.names.retrievedAt || null, dataVintage: SOURCES.gnisNames.measuredOn,
      drawn: [...drawnNameFeatures.values()], dropped: namesDropped,
    } } : {}),
  };
  const pages = plan.sheets.length + 1 + legend.pages;
  progress(PHASES.ASSEMBLE, 1, pages);
  // The sheet footer is ONE unwrapped 7 pt line, so it cannot carry eight credits.
  // It keeps the retrieval record and points at the key, which carries them all.
  const footer = legend.attribution.length > 2 ? `${sourceLine}; full source credits on the map key` : sourceLine;
  const meta = { title: recipe.title, zone, hemisphere, datum: 'WGS84', assembledAtIso: assembledAt, sourceLine: footer, gridEnabled };
  // Both extras are built HERE rather than handed in: this is the only place that
  // knows the sheets and the clipped features. Both are wrapped so a failure costs
  // the extra page and never the map — that is what makes them extras.
  const aerials = recipe.layers?.aerial ? await companionSheets(plan, recipe, fetchImpl, check, fetchAerial, signal) : [];
  const companions = recipe.layers?.terrain ? await companionSheets(plan, recipe, fetchImpl, check, fetchTerrain, signal) : [];
  const trips = recipe.layers?.tripPage ? await tripRows(features, plan, sheets, fetchImpl, { zone, hemisphere, scale: recipe.scale, signal, check }) : [];
  const pdfBytes = await createPdfImpl({ PDFLib, plan, sheets, meta, legend, manifest, trips, aerials, companions });
  progress(PHASES.ASSEMBLE, pages, pages);
  return { pdfBytes, manifest, stats: { level, tileCount: tiles.count, sheets: sheets.length, ms: Date.now() - started, bytes: pdfBytes.byteLength } };
}
