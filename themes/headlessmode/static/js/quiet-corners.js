/* Quiet Corners dashboard.
 *
 * Extracted from the page layout because the site CSP sets script-src
 * without 'unsafe-inline'; an inline <script> is blocked in production.
 * All data and libraries are same-origin: connect-src is 'self'.
 */

import { showSkyCards } from './quiet-corners-sky/sky-cards.js';
import { localDate } from './quiet-corners-sky/tonight.js';
import { createForecastLoader } from './quiet-corners-maps/source-weather.js';
import { alertsFor, alertsHtml } from './quiet-corners-maps/source-nws-alerts.js';
import { DEFAULT_BASE, baseLayer, BASES } from './quiet-corners-maps/source-basemaps.js';
import { DEFAULT_VIEW, resolveInitialView, parseFragment, formatFragment, prefsFromView } from './quiet-corners-maps/view-state.js';
import { createApplyGuard, createRoutineWriter, createPopstateHandler, applyView, resetView, createPrefsStore, PREFS_KEY } from './quiet-corners-maps/view-wiring.js';
import { LAYER_IDS, CONTEXT_LAYER_IDS } from './quiet-corners-maps/layer-registry.js';
import { groupFinderResults, rankFinderGroups, isExactNameStateMatch, looksLikeStreetAddress, ADDRESS_PROMPT_MESSAGE, ADDRESS_ESTIMATE_NOTE, addressStatusText } from './quiet-corners-maps/search-shell.js';
import { geocodeAddress } from './quiet-corners-maps/address-geocode.js';
import { requestOnce } from './quiet-corners-maps/locate.js';
import { searchByName, createSearchGuard, zoomForKind } from './quiet-corners-maps/source-terrain-names.js';
import { clearSpot } from './quiet-corners-maps/card-clearance.js';
import { initialState, openPanel, closePanel, backPanel, focusTarget, resizeSheet, snapSheet } from './quiet-corners-maps/panel-state.js';
import { basisLines } from './quiet-corners-sky/conditions-basis.js';
import { factorDisplay, freshness, availabilityState } from './quiet-corners-maps/evidence.js';

(function() {
    // The one map spans two jobs. FIELD_MIN_ZOOM is the zoom where it changes which
    // one it is READING as: below it the county choropleth is the map (full-strength
    // wash, national comparison); at or above it the wash steps back to a hint and
    // the topographic base is what the reader is looking at. It no longer gates
    // whether the base TILE LAYER is drawn at all (audit Q-base, A1) -- the base is
    // now present at every zoom the map supports, and source-basemaps.js's
    // `leafletOptions` honours each source's own measured `maxCachedLevelObserved`
    // as its `maxNativeZoom`, so a source that runs out of detail before 16 (only
    // the shaded relief does, at 13) enlarges its last cached level and says so
    // (source-basemaps.js `zoomStatus`) rather than silently swapping sources.
    // FIELD_MAX_ZOOM stays 16, the deepest level the USGS Topo cache serves
    // (measured 2026-09-05 and recorded in source-registry.js).
    var FIELD_MIN_ZOOM = 9;
    var FIELD_MAX_ZOOM = 16;

    'use strict';

    const DATA_BASE = '/data/quiet-corners/';
    const PAGE_SIZE = 10;

    let countiesData = null;
    let summaryData = null;
    let geoData = null;
    let candidatesData = null;
    // Set once fetchJSON gives up on candidates.json (a 404, a parse failure, a
    // network error) so the finder can tell a reader "the list failed to load"
    // instead of "still loading" forever -- fetchJSON itself returns null for
    // both a genuine failure and a request still on the wire, so this is the
    // only place that distinction exists.
    let candidatesLoadFailed = false;
    // The other half of the place layer. candidates.json is the SCORED export --
    // small towns, by construction -- so a national view named 47 places nobody has
    // heard of and nothing to locate them against. navigation-places.json carries the
    // large places the scoring deliberately excludes, purely as orientation.
    let navPlacesData = null;
    // ONE default, read by the map, the county table and the town table alike.
    // F19 made three disagreeing cues legible -- map colour Stability, county sort
    // Overall, town sort Stability, each labelled. Legible is the floor: a reader
    // comparing the darkest county to the top row of the table under it still saw
    // two different counties, and the note only confirmed the disagreement. Overall
    // is the weighted composite of the other three, so one sentence covers the whole
    // screen: this page ranks by Overall until you ask for something else. Changing
    // this line changes all three, which is the point -- the value used to be typed
    // in four places, one of them a `sort-active` in the template.
    const DEFAULT_METRIC = 'overall_score';
    let currentSort = { key: DEFAULT_METRIC, dir: -1 };
    const candidatesSort = { key: DEFAULT_METRIC, dir: -1 };
    let currentPage = 0;
    let candidatesPage = 0;
    let lastFiltered = [];
    let lastFilteredCandidates = [];

    // Sprawl auto-detection
    let sprawlReady = false;

    // The county score wash, off by default: main.js's one-dominant-surface radio
    // group (Layers panel, 'context' group) calls window.qcSetScoresSurface(on)
    // through its countyScore entry, exactly as it does for night lights or NLCD.
    // Off redraws every score-owned fill/highlight/legend as neutral (invisible
    // fill, "administrative outline only") together; nothing about administrative
    // outlines, the selected location, terrain, towns, trails, search or the
    // print action depends on this flag.
    let scoresVisible = false;
    // The always-drawn county layer's fill is part of the score wash, not of the base:
    // it paints only while scores are on (0 otherwise, so the topo reads through and
    // only the county outline remains), at these strengths. rural is the strongest
    // that keeps the topo's #333 road lettering at >= 3:1 through it (0.7 gave 2.25:1);
    // scripts/qcm/base-legibility.test.mjs reads this declaration and checks the number.
    const COUNTY_CONTEXT_FILL = { rural: 0.59, other: 0.4 };
    let countyContextLayer = null;
    let countyContextStyle = null;
    function applyScoresVisibility() {
        const grp = document.getElementById('qc-color-by-group');
        if (grp) grp.hidden = !scoresVisible;
        const sc = document.getElementById('qc-score-controls');
        if (sc) sc.hidden = !scoresVisible;
        // The always-drawn administrative background (all US counties, state mesh)
        // is a separate Leaflet layer added straight to the map, never to hlLayer,
        // so re-running the highlight pass touches only the score-owned fill —
        // outlines, the selected popup and everything else in this pane stay.
        if (map && hlLayer) updateMapHighlights(new Set(lastFiltered.map(c => c.fips)));
        // The context fill follows the same switch: restyle it in place (its outline
        // is unchanged at every zoom).
        if (countyContextLayer) countyContextLayer.setStyle(countyContextStyle);
        if (legendRefresh) legendRefresh();
    }
    window.qcSetScoresSurface = function(on) {
        scoresVisible = !!on;
        applyScoresVisibility();
    };

    // Leaflet state
    let map = null;
    let hlLayer = null;
    let legendRefresh = null;
    let countyLookup = {};
    let geoPointLookup = {};  // fips -> geo.json point (centroid fallback)
    let geometryKnown = false; // geo.json + counties-10m.json have both settled
    let heldCountyPick = null; // a table pick made before that; replayed on arrival
    let markerLookup = {};  // fips -> L.geoJSON layer (for table click)
    let candidateLayer = null;
    let placeLayer = null;
    let labelLayer = null;
    let countyFeatureLookup = {};  // fips -> TopoJSON feature
    let topoData = null;  // raw TopoJSON for county/state boundaries

    // CONUS default view
    const CONUS_CENTER = [39.5, -98.5];
    const CONUS_ZOOM = 4;

    // The lower 48 as an area rather than a centre and a zoom: Cape Alava and the
    // southern tip of Texas to the Canadian border and the coast of Maine. A single
    // zoom level can only frame this in one shape of rectangle — CONUS_ZOOM fits it
    // on a desktop map and crops both coasts off a phone-width one — so anything
    // that means "show the whole country" fits these bounds to whatever rectangle
    // the map currently is. [south, west], [north, east].
    const CONUS_BOUNDS = [[24.5, -125.0], [49.4, -66.9]];
    const CONUS_PADDING = [20, 20];

    // State bounding boxes for zoom-on-filter [south, west, north, east]
    const STATE_BOUNDS = {
        'AL': [[30.22, -88.47], [35.01, -84.89]], 'AK': [[51.21, -179.15], [71.39, -129.98]],
        'AZ': [[31.33, -114.81], [37.00, -109.04]], 'AR': [[33.00, -94.62], [36.50, -89.64]],
        'CA': [[32.53, -124.41], [42.01, -114.13]], 'CO': [[36.99, -109.06], [41.00, -102.04]],
        'CT': [[40.95, -73.73], [42.05, -71.79]], 'DE': [[38.45, -75.79], [39.84, -75.05]],
        'FL': [[24.40, -87.63], [31.00, -80.03]], 'GA': [[30.36, -85.61], [35.00, -80.84]],
        'HI': [[18.91, -160.24], [22.24, -154.81]], 'ID': [[41.99, -117.24], [49.00, -111.04]],
        'IL': [[36.97, -91.51], [42.51, -87.02]], 'IN': [[37.77, -88.10], [41.76, -84.78]],
        'IA': [[40.38, -96.64], [43.50, -90.14]], 'KS': [[36.99, -102.05], [40.00, -94.59]],
        'KY': [[36.50, -89.57], [39.15, -81.96]], 'LA': [[28.93, -94.04], [33.02, -88.82]],
        'ME': [[43.06, -71.08], [47.46, -66.95]], 'MD': [[37.91, -79.49], [39.72, -75.05]],
        'MA': [[41.24, -73.50], [42.89, -69.93]], 'MI': [[41.70, -90.42], [48.26, -82.42]],
        'MN': [[43.50, -97.24], [49.38, -89.49]], 'MS': [[30.17, -91.66], [34.99, -88.10]],
        'MO': [[35.99, -95.77], [40.61, -89.10]], 'MT': [[44.36, -116.05], [49.00, -104.04]],
        'NE': [[39.99, -104.05], [43.00, -95.31]], 'NV': [[35.00, -120.01], [42.00, -114.04]],
        'NH': [[42.70, -72.56], [45.31, -70.70]], 'NJ': [[38.93, -75.56], [41.36, -73.89]],
        'NM': [[31.33, -109.05], [37.00, -103.00]], 'NY': [[40.50, -79.76], [45.01, -71.86]],
        'NC': [[33.84, -84.32], [36.59, -75.46]], 'ND': [[45.94, -104.05], [49.00, -96.55]],
        'OH': [[38.40, -84.82], [41.98, -80.52]], 'OK': [[33.62, -103.00], [37.00, -94.43]],
        'OR': [[41.99, -124.57], [46.29, -116.46]], 'PA': [[39.72, -80.52], [42.27, -74.69]],
        'RI': [[41.15, -71.86], [42.02, -71.12]], 'SC': [[32.05, -83.35], [35.22, -78.54]],
        'SD': [[42.48, -104.06], [45.95, -96.44]], 'TN': [[34.98, -90.31], [36.68, -81.65]],
        'TX': [[25.84, -106.65], [36.50, -93.51]], 'UT': [[36.99, -114.05], [42.00, -109.04]],
        'VT': [[42.73, -73.44], [45.02, -71.46]], 'VA': [[36.54, -83.68], [39.47, -75.24]],
        'WA': [[45.54, -124.85], [49.00, -116.92]], 'WV': [[37.20, -82.64], [40.64, -77.72]],
        'WI': [[42.49, -92.89], [47.08, -86.25]], 'WY': [[40.99, -111.06], [45.01, -104.05]],
        'DC': [[38.79, -77.12], [38.99, -76.91]],
    };

    // Full state name -> USPS abbreviation. counties.json carries
    // abbreviations while candidates.json has shipped full names; a future
    // regeneration flips candidates to abbreviations. Normalizing BOTH sides
    // of every state comparison through normState keeps the filter (and the
    // zoom-bounds lookup) correct under either data vintage.
    const STATE_ABBR = {
        'ALABAMA': 'AL', 'ALASKA': 'AK', 'ARIZONA': 'AZ', 'ARKANSAS': 'AR',
        'CALIFORNIA': 'CA', 'COLORADO': 'CO', 'CONNECTICUT': 'CT', 'DELAWARE': 'DE',
        'FLORIDA': 'FL', 'GEORGIA': 'GA', 'HAWAII': 'HI', 'IDAHO': 'ID',
        'ILLINOIS': 'IL', 'INDIANA': 'IN', 'IOWA': 'IA', 'KANSAS': 'KS',
        'KENTUCKY': 'KY', 'LOUISIANA': 'LA', 'MAINE': 'ME', 'MARYLAND': 'MD',
        'MASSACHUSETTS': 'MA', 'MICHIGAN': 'MI', 'MINNESOTA': 'MN', 'MISSISSIPPI': 'MS',
        'MISSOURI': 'MO', 'MONTANA': 'MT', 'NEBRASKA': 'NE', 'NEVADA': 'NV',
        'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY',
        'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', 'OHIO': 'OH', 'OKLAHOMA': 'OK',
        'OREGON': 'OR', 'PENNSYLVANIA': 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC',
        'SOUTH DAKOTA': 'SD', 'TENNESSEE': 'TN', 'TEXAS': 'TX', 'UTAH': 'UT',
        'VERMONT': 'VT', 'VIRGINIA': 'VA', 'WASHINGTON': 'WA', 'WEST VIRGINIA': 'WV',
        'WISCONSIN': 'WI', 'WYOMING': 'WY', 'DISTRICT OF COLUMBIA': 'DC',
    };

    function normState(s) {
        if (!s) return '';
        const up = String(s).trim().toUpperCase();
        return up.length === 2 ? up : (STATE_ABBR[up] || up);
    }

    /** Derived, not written out again: the same table has to answer "is this token a
     *  state?" for the finder, and a second hand-kept list would drift from this one. */
    const STATE_CODES = Object.keys(STATE_ABBR).map(function(k) { return STATE_ABBR[k]; });
    function isStateCode(s) { return STATE_CODES.indexOf(s) >= 0; }

    // ========================================================================
    // ERROR STATE
    // ========================================================================

    function showError(msg) {
        var banner = document.getElementById('qc-error');
        if (!banner) return;
        var msgEl = document.getElementById('qc-error-msg');
        if (msgEl) msgEl.textContent = msg;
        banner.style.display = '';
    }

    function hideError() {
        var banner = document.getElementById('qc-error');
        if (banner) banner.style.display = 'none';
    }

    function showMapMessage(text) {
        var el = document.getElementById('qc-map');
        if (el) el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;padding:1rem;text-align:center;color:var(--text-muted);font-family:ui-monospace,monospace;font-size:0.75rem;">' + text + '</div>';
    }

    // ========================================================================
    // DATA LOADING
    // ========================================================================

    // No cache-buster: /data/quiet-corners/* is served with a real
    // Cache-Control policy (see static/_headers), so busting every fetch
    // would defeat both the browser cache and the CDN edge cache.
    async function fetchJSON(path) {
        try {
            const resp = await fetch(DATA_BASE + path);
            if (!resp.ok) return null;
            return await resp.json();
        } catch(e) { return null; }
    }

    // The map -- base tiles, search box, print builder, the qc:map-ready
    // event -- is created before ANY of the five requests below settles.
    // Each dataset then attaches on its own as it arrives, independently of
    // the other four: a 404, a parse failure or a request that never
    // resolves degrades only that dataset's own feature (the county table,
    // the county wash, the place labels) and never blocks, or is blocked
    // by, the map itself.
    async function loadData() {
        hideError();

        const summaryP = fetchJSON('summary.json');
        const countiesP = fetchJSON('counties.json');
        const geoP = fetchJSON('geo.json');
        const topoP = fetchJSON('counties-10m.json');
        const navPlacesP = fetchJSON('navigation-places.json');

        try {
            createMap();
        } catch (e) {
            // Leaflet missing or the map constructor threw — the map fails
            // alone; table, trust panel and filters below must still render.
            map = null;
            showMapMessage('Map failed to load: ' + e.message);
        }

        countiesP.then(attachCounties);
        summaryP.then(attachSummary);
        navPlacesP.then(attachNavPlaces);
        // Geometry needs both files, but not the other three: it attaches
        // the moment geo.json and counties-10m.json are both known, whether
        // either one succeeded or not (fetchJSON never rejects — a failed
        // request resolves to null, which attachCountyGeometry already
        // renders as its dot fallback).
        Promise.all([geoP, topoP]).then(function(results) {
            attachCountyGeometry(results[0], results[1]);
        });

        // candidates.json (~1.8MB) loads after the first render; its section
        // stays display:none until the data arrives, so nothing the user can
        // see waits on it. Deliberately not awaited.
        loadCandidates();
    }

    function attachSummary(summary) {
        summaryData = summary;
        if (!summary) return;
        renderMeta(summary);
        hideUncoveredDimensions(summary);
        renderTrustPanel(summary);
    }

    function attachCounties(counties) {
        countiesData = counties;

        // The county table, sprawl UI and state filter are county-driven;
        // without counties.json there is nothing to rank or list there. Say
        // so — the map, base tiles, search box and print builder above are
        // unaffected and were already built before this settled.
        if (!counties) {
            showError('Dashboard data failed to load. Check your connection, then retry.');
            return;
        }

        counties.forEach(c => { countyLookup[c.fips] = c; });

        sprawlReady = counties.some(c => c.sprawl_risk > 0);
        if (sprawlReady) enableSprawlUI();

        populateStateFilter(counties);

        // Applies filters (shows highlights + table); harmless if
        // attachCountyGeometry hasn't run yet — updateMapHighlights() and
        // the map guard inside applyFilters() both tolerate that.
        applyFilters();
    }

    function attachNavPlaces(navPlaces) {
        navPlacesData = navPlaces;
        if (!navPlaces && map) {
            var notice = L.control({ position: 'topright' });
            notice.onAdd = function() {
                var d = L.DomUtil.create('div', 'qc-map-notice');
                d.textContent = 'Place names unavailable — the map shows matched towns only.';
                return d;
            };
            notice.addTo(map);
        }
        // Labels otherwise wait for a moveend that a reader who never
        // touches the map will not produce.
        if (map) renderPlaceLabels();
    }

    async function loadCandidates() {
        const candidates = await fetchJSON('candidates.json');
        if (!candidates || !candidates.length) {
            // null means fetchJSON gave up (bad status or a thrown error); an
            // empty array is a well-formed export that happens to hold nothing,
            // which is not a failure and gets no message change.
            if (candidates === null) {
                candidatesLoadFailed = true;
                if (finderRefresh) finderRefresh();
            }
            return;
        }
        candidatesData = candidates;
        // A reader who typed during the fetch was told the list was still loading.
        // Nothing re-runs that search on its own, so the answer would sit at
        // "loading" until they happened to press another key.
        if (finderRefresh) finderRefresh();
        if (map) renderPlaceContext(candidates);
        // Labels otherwise wait for a moveend that a reader who never touches the
        // map will not produce: the default CONUS view is set once, before this
        // fetch lands, so the national view would open with no names on it at all.
        if (map) renderPlaceLabels();
        const sect = document.getElementById('qc-candidates-section');
        if (sect) sect.style.display = '';
        // Re-run filters so the candidates table and map markers render.
        applyFilters();
    }

    // ========================================================================
    // SPRAWL AUTO-DETECT
    // ========================================================================

    function enableSprawlUI() {
        // Show sprawl slider
        var sprawlGroup = document.getElementById('qc-sprawl-group');
        if (sprawlGroup) sprawlGroup.style.display = '';

        // Show sprawl column header
        var sprawlCols = document.querySelectorAll('.qc-sprawl-col');
        sprawlCols.forEach(function(el) { el.style.display = ''; });

        // Update grid to 7-column layout
        var header = document.getElementById('qc-table-header');
        if (header) {
            header.classList.add('sprawl-visible');
            // Sprawl is a column now, so the sort picker has to offer it.
            fillSortPicker(header);
        }
    }

    // ========================================================================
    // META
    // ========================================================================

    function renderMeta(summary) {
        const el = document.getElementById('qc-meta');
        if (!el || !summary) return;
        const dt = summary.generated_at ? new Date(summary.generated_at).toLocaleDateString() : 'unknown';
        const candTotal = summary.candidates && summary.candidates.total != null ? summary.candidates.total : null;
        el.textContent = 'v' + (summary.pipeline_version || '?') +
            ' \u2022 ' + (summary.total_counties_scored || 0) + ' counties scored' +
            ' \u2022 ' + (summary.total_rural_counties || 0) + ' rural counties' +
            ' \u2022 ' + (summary.total_states || 0) + ' states' +
            (candTotal != null ? ' \u2022 ' + candTotal + ' candidates' : '') +
            ' \u2022 generated ' + dt;
    }

    // ========================================================================
    // STATE FILTER
    // ========================================================================

    function populateStateFilter(counties) {
        const select = document.getElementById('qc-state');
        if (!select) return;
        const states = [...new Set(counties.map(c => c.state))].sort();
        states.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s;
            opt.textContent = s;
            select.appendChild(opt);
        });
    }

    // ========================================================================
    // FILTERING
    // ========================================================================

    // `parseInt(...) || fallback` silently re-applies the fallback when a
    // slider sits at 0 (0 is falsy). Only a non-numeric read falls back.
    function intVal(id, fallback) {
        const v = parseInt(document.getElementById(id).value, 10);
        return isNaN(v) ? fallback : v;
    }

    function getFilters() {
        const filters = {
            minRemoteness: intVal('qc-remoteness', 75),
            minStability: intVal('qc-stability', 60),
            minOverall: intVal('qc-overall', 0),
            minAffordability: intVal('qc-affordability', 0),
            state: document.getElementById('qc-state').value,
        };
        if (sprawlReady) {
            filters.maxSprawl = intVal('qc-sprawl', 50);
        }
        var popMinEl = document.getElementById('qc-pop-min');
        var popMaxEl = document.getElementById('qc-pop-max');
        if (popMinEl && popMinEl.value) filters.popMin = parseInt(popMinEl.value, 10);
        if (popMaxEl && popMaxEl.value) filters.popMax = parseInt(popMaxEl.value, 10);
        return filters;
    }

    // Null scores are "unknown": an ACTIVE threshold filter only admits rows
    // known to satisfy it, so null is excluded. A slider at its no-op end
    // (min 0 / max 100) is inactive and lets unknowns through.
    // Remoteness was the one exception, and it was a bug (audit F16): its slider
    // bottomed out at 25 miles, so there was no no-op end to reach, and a null
    // distance was excluded even there. A county ten miles from a small city can
    // be as quiet as one ninety miles out, and one whose distance was never
    // computed is not evidence of anything -- neither could be reached at all. Livability was
    // removed from the product (decision D1); committed exports may still
    // carry livability_score — it is deliberately never read.
    function filterCounties(counties, filters) {
        return counties.filter(c => {
            if (filters.minRemoteness > 0 && (c.distance_to_metro_mi === null || c.distance_to_metro_mi < filters.minRemoteness)) return false;
            if (filters.minStability > 0 && (c.stability_score === null || c.stability_score < filters.minStability)) return false;
            if (filters.minOverall > 0 && (c.overall_score === null || c.overall_score < filters.minOverall)) return false;
            if (sprawlReady && filters.maxSprawl !== undefined && filters.maxSprawl < 100) {
                if (c.sprawl_risk === null || c.sprawl_risk > filters.maxSprawl) return false;
            }
            if (filters.minAffordability > 0 && (c.affordability_score === null || c.affordability_score < filters.minAffordability)) return false;
            if (filters.popMin && c.population !== null && c.population < filters.popMin) return false;
            if (filters.popMax && c.population !== null && c.population > filters.popMax) return false;
            if (filters.state && c.state !== filters.state) return false;
            return true;
        });
    }

    // How many of the Explore panel's filters are actually doing something right
    // now, for the count on its closed summary (QUX-03b-i: "Explore · 2 filters").
    // Mirrors filterCounties' own reading of "active" above exactly, clause for
    // clause, so the number on the panel never drifts from what the table does:
    // a threshold slider counts once it is off its no-op end (0, or 100 for the
    // sprawl ceiling), a free-typed population bound counts whenever it is set at
    // all (there is no numeric no-op end for it), and the state picker counts
    // whenever it names one.
    function countActiveFilters(filters) {
        let n = 0;
        if (filters.minRemoteness > 0) n++;
        if (filters.minStability > 0) n++;
        if (filters.minOverall > 0) n++;
        if (filters.minAffordability > 0) n++;
        if (filters.maxSprawl !== undefined && filters.maxSprawl < 100) n++;
        if (filters.popMin) n++;
        if (filters.popMax) n++;
        if (filters.state) n++;
        return n;
    }

    // Writes the live count onto the Explore panel's own summary line, the one
    // reader-visible place that says the table is filtered while the panel holding
    // the filters is closed. A no-op off this page (no #qc-explore-summary), same
    // guard every other applyFilters DOM write below already assumes an element.
    function updateExploreSummary(filters) {
        const el = document.getElementById('qc-explore-summary');
        if (!el) return;
        const n = countActiveFilters(filters);
        el.textContent = n === 0 ? 'Explore · Compare counties'
            : 'Explore · ' + n + (n === 1 ? ' filter' : ' filters');
    }

    function applyFilters() {
        if (!countiesData) return;
        const filters = getFilters();
        const filtered = filterCounties(countiesData, filters);
        lastFiltered = filtered;

        // Reset pagination on filter change
        currentPage = 0;

        // Update slider labels
        // 0 is the slider's no-op end, and '0+' would read as a threshold rather
        // than as its absence.
        document.getElementById('qc-remoteness-val').textContent = filters.minRemoteness === 0 ? 'Any' : filters.minRemoteness + '+';
        document.getElementById('qc-stability-val').textContent = filters.minStability + '+';
        document.getElementById('qc-overall-val').textContent = filters.minOverall + '+';
        document.getElementById('qc-affordability-val').textContent = filters.minAffordability + '+';
        if (sprawlReady) {
            document.getElementById('qc-sprawl-val').textContent = '\u2264' + filters.maxSprawl;
        }
        document.getElementById('qc-count').textContent = filtered.length + ' counties';
        updateExploreSummary(filters);

        renderTable(filtered);
        renderPagination(filtered.length);

        if (map) {
            const fipsSet = new Set(filtered.map(c => c.fips));
            updateMapHighlights(fipsSet);
        }

        // Candidates. State comparison is normalized on both sides: the
        // filter value comes from counties.json while t.state has shipped as
        // a full name ("Alabama") — raw comparison emptied the table.
        const stateAbbr = normState(filters.state);
        if (candidatesData) {
            candidatesPage = 0;
            const filteredFips = new Set(filtered.map(c => c.fips));
            lastFilteredCandidates = candidatesData.filter(t => {
                if (!filteredFips.has(t.county_fips)) return false;
                if (stateAbbr && normState(t.state) !== stateAbbr) return false;
                return true;
            });
            renderCandidates(lastFilteredCandidates);
            renderCandidatesPagination(lastFilteredCandidates.length);
            renderCandidatesStatus(lastFilteredCandidates.length, stateAbbr);
            if (map) updateCandidateMarkers(lastFilteredCandidates);
        }

        // Zoom is a separate, explicit action (the "Zoom to state" button below) --
        // NOT a side effect of selecting a state here. It used to run on every
        // apply (each slider input event too, since the state filter is read on
        // every pass), snapping the view back to CONUS or to the state box
        // mid-drag and destroying whatever pan or zoom the reader had chosen.
    }

    // A slider drag fires dozens of input events, and each applyFilters
    // re-sorts ~1700 rows and rebuilds map layers. Trailing debounce keeps
    // drags responsive; discrete controls still apply immediately.
    let filterDebounceTimer = null;
    function applyFiltersDebounced() {
        clearTimeout(filterDebounceTimer);
        filterDebounceTimer = setTimeout(applyFilters, 100);
    }

    function zoomToState(stateAbbr) {
        if (!map) return;
        if (stateAbbr && STATE_BOUNDS[stateAbbr]) {
            const bounds = STATE_BOUNDS[stateAbbr];
            map.fitBounds(bounds, { padding: [20, 20], maxZoom: 7 });
        } else if (!stateAbbr) {
            map.fitBounds(CONUS_BOUNDS, { padding: CONUS_PADDING });
        }
    }

    // ========================================================================
    // LEAFLET MAP
    // ========================================================================

    function prefersReducedMotion() {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    // rAF-driven Leaflet animations (flyTo/flyToBounds) aren't reachable by the
    // global reduced-motion CSS — gate them here and jump instantly instead.
    function flyToBoundsRM(bounds, opts) {
        if (prefersReducedMotion()) {
            map.fitBounds(bounds, Object.assign({}, opts, { animate: false }));
        } else {
            map.flyToBounds(bounds, opts);
        }
    }

    function flyToRM(latlng, zoom, opts) {
        if (prefersReducedMotion()) {
            map.setView(latlng, zoom, { animate: false });
        } else {
            map.flyTo(latlng, zoom, opts);
        }
    }

    function getAccentColor() {
        const style = getComputedStyle(document.documentElement);
        return style.getPropertyValue('--accent-500').trim() || '#4caf63';
    }

    // What the map may be colored by. One table drives the choropleth, the
    // fallback dot sizes, the legend title, the band labels and the select's
    // options, so the key can never describe a ramp the map is not drawing.
    // Each metric carries its own unit because they are not all scores:
    // remoteness is a distance in miles, and a shared 0-100 ramp would lie.
    const COLOR_METRICS = [
        { key: 'stability_score', label: 'Stability', unit: 'score', bands: [80, 60, 40] },
        { key: 'overall_score', label: 'Overall', unit: 'score', bands: [80, 60, 40] },
        { key: 'quietness_score', label: 'Quietness', unit: 'score', bands: [80, 60, 40] },
        { key: 'affordability_score', label: 'Affordability', unit: 'score', bands: [80, 60, 40] },
        { key: 'distance_to_metro_mi', label: 'Miles to a city', unit: 'mi', bands: [120, 75, 40] },
    ];
    // Border weight, dash pattern and dot radius vary by band too, so the map
    // is never a color-only cue.
    const BAND_STYLES = [
        { opacity: 0.85, weight: 2, dashArray: null, radius: 9 },
        { opacity: 0.55, weight: 1.5, dashArray: '4,2', radius: 7.5 },
        { opacity: 0.35, weight: 1, dashArray: '2,3', radius: 6 },
        { opacity: 0.2, weight: 1, dashArray: '1,3', radius: 4.5 },
    ];
    // Unknown is not "low". A county whose value was never computed gets its own
    // flat swatch and its own legend row instead of being painted into the
    // bottom band, where it read as a measured result.
    const UNKNOWN_BAND = { fill: '#3a3a52', opacity: 0.45, weight: 1, dashArray: '1,4', radius: 4 };
    let colorBy = DEFAULT_METRIC;

    function colorMetric(key) {
        for (var i = 0; i < COLOR_METRICS.length; i++) {
            if (COLOR_METRICS[i].key === key) return COLOR_METRICS[i];
        }
        return COLOR_METRICS[0];
    }

    function bandIndex(value, metric) {
        if (value === null || value === undefined) return -1;
        var b = metric.bands;
        return value >= b[0] ? 0 : value >= b[1] ? 1 : value >= b[2] ? 2 : 3;
    }

    function bandStyle(value, accent, metric) {
        var i = bandIndex(value, metric);
        if (i < 0) return UNKNOWN_BAND;
        var s = BAND_STYLES[i];
        return { fill: accent, opacity: s.opacity, weight: s.weight, dashArray: s.dashArray, radius: s.radius };
    }

    function bandLabels(metric) {
        var b = metric.bands;
        var u = metric.unit === 'score' ? '' : ' ' + metric.unit;
        return [b[0] + '+' + u, b[1] + '\u2013' + b[0] + u, b[2] + '\u2013' + b[1] + u, '<' + b[2] + u];
    }

    function bandKeyHtml(accent) {
        var labels = bandLabels(colorMetric(colorBy));
        var row = function(style, text) {
            return '<div class="qc-legend-item"><span class="qc-legend-swatch" style="' + style + '"></span> ' + text + '</div>';
        };
        return BAND_STYLES.map(function(st, i) {
            return row('background:' + accent + ';opacity:' + st.opacity + ';', escHtml(labels[i]));
        }).join('') + row('background:' + UNKNOWN_BAND.fill + ';opacity:' + UNKNOWN_BAND.opacity + ';', 'Not measured');
    }

    function colorByOptionsHtml() {
        return COLOR_METRICS.map(function(m) {
            return '<option value="' + escAttr(m.key) + '">' + escHtml(m.label) + '</option>';
        }).join('');
    }

    // The map itself: panes, base tiles, search box, reset/scale controls and
    // the legend frame. None of this depends on counties.json, geo.json,
    // counties-10m.json, summary.json or navigation-places.json -- it is
    // built, and qc:map-ready dispatched, before any of those five requests
    // has settled. County/state geometry (the choropleth or its dot
    // fallback) is drawn separately by attachCountyGeometry() once geo.json
    // and counties-10m.json are both known, success or failure.
    function createMap() {
        const accent = getAccentColor();

        // Create map centered on CONUS — canvas renderer for performance.
        //
        // maxZoom is 16, not 10, because this is the ONE map: zoomed out it is the
        // county chooser, zoomed in it is the field map the print builder draws on.
        // 16 is where the USGS Topo tile cache ends (source-registry.js records the
        // measurement), so it is the deepest zoom any layer here can honour.
        map = L.map('qc-map', {
            center: pendingInitialView ? pendingInitialView.center : CONUS_CENTER,
            zoom: pendingInitialView ? pendingInitialView.zoom : CONUS_ZOOM,
            minZoom: 3,
            maxZoom: FIELD_MAX_ZOOM,
            zoomControl: true,
            scrollWheelZoom: true,
            preferCanvas: true,
        });

        // Cards (Leaflet's popup pane) are lifted out of the map pane and made its
        // sibling, so on a desktop they can paint above the map's own controls (the
        // zoom and view buttons, the map key) and what floats on the map column.
        // Inside the map pane they could not: the map pane is a stacking context (its
        // own z-index and transform) under Leaflet's control corners, so a card under
        // a control stayed under it whatever its length -- Save and the close button
        // with it. The finder box below is re-homed outside #qc-map for the same
        // reason. The CSS (quiet-corners.css, >=1024px) lets
        // #qc-map stop being a stacking context and orders the panes; below 1024px
        // #qc-map keeps its z-index, and only the map's controls are put under the
        // cards there. The pane
        // follows the map pane's offset on every event that moves it, and takes the
        // zoom-animation class with it so a card glides with an animated zoom.
        var cardPane = map.getPane('popupPane');
        var mapPane = map.getPane('mapPane');
        mapPane.parentNode.insertBefore(cardPane, mapPane.nextSibling);
        var syncCards = function() { L.DomUtil.setPosition(cardPane, L.DomUtil.getPosition(mapPane)); };
        map.on('move zoom viewreset resize', syncCards);
        map.on('zoomanim', function() { L.DomUtil.addClass(cardPane, 'leaflet-zoom-anim'); });
        map.on('zoomend', function() { L.DomUtil.removeClass(cardPane, 'leaflet-zoom-anim'); syncCards(); });
        syncCards();

        // Places get a pane of their own, below the markers that matched. Two reasons:
        // the context has to draw UNDER the result rather than over it, and a pane owns
        // its own canvas, so what the layer drew can be seen without a way to ask it.
        map.createPane('qc-places');
        map.getPane('qc-places').style.zIndex = 390;
        if (candidatesData) renderPlaceContext(candidatesData);

        // The county wash gets a pane too, and for the opposite reason: not so it can
        // be read, but so it can be turned down. Everything used to share the default
        // overlayPane, which meant the choropleth could only be faded shape by shape.
        // Below qc-places (390) so a town still draws on top of its county, as before.
        map.createPane('qc-counties');
        map.getPane('qc-counties').style.zIndex = 380;

        // Names go above everything the map paints under them -- the dots they name
        // (390) and the canvas matches in the overlay pane (400), which the 395 they
        // used to sit at left lettered over -- but under the markers (600) and cards.
        // A pane of their own so the county wash fading at field zoom cannot take the
        // labels down with it, and click-through so a name never swallows the click
        // on the county beneath it.
        map.createPane('qc-labels');
        map.getPane('qc-labels').style.zIndex = 410;
        map.getPane('qc-labels').style.pointerEvents = 'none';
        map.on('moveend zoomend', renderPlaceLabels);
        // Q/main.js (the Map label size control's other half) announces a size change
        // here; the boxes below are measured from the font the CSS draws, so they have
        // to be measured again.
        document.addEventListener('qc:label-prefs-changed', renderPlaceLabels);
        renderPlaceLabels();

        // The topographic base is present at every supported zoom (audit Q-base, A1):
        // a national reader who never touches the Layers panel still has a real base
        // under the choropleth, not an empty map below field zoom. WHICH base is drawn
        // is the builder's choice (source-basemaps.js, through map.qcBase below); the
        // default here is topo. There is no zoom floor left to enforce -- `baseLayer`
        // already caps each source at its own measured `maxCachedLevelObserved` as
        // `maxNativeZoom`, so a source that runs out of detail enlarges its last
        // cached level rather than being swapped for another one behind the reader's
        // back.
        let baseTiles = baseLayer(L, DEFAULT_BASE);
        const syncBase = function() {
            if (!baseTiles) return;   // "No base map": the county wash and overlays stay
            if (!map.hasLayer(baseTiles)) baseTiles.addTo(baseTiles._qcAdded = map);
        };
        map.qcBase = { set: function(layerOrNull) {
            if (baseTiles && map.hasLayer(baseTiles)) map.removeLayer(baseTiles);
            baseTiles = layerOrNull;
            syncBase();
        } };
        // The county wash still steps back at FIELD_MIN_ZOOM -- that swap is about
        // which READING of the map is on top (national comparison vs. field terrain),
        // not about whether the base tile layer underneath exists. The base is drawn
        // at every zoom now; below FIELD_MIN_ZOOM the wash just sits at full strength
        // over it, the same as it always covered whatever was beneath it.
        const FIELD_WASH_OPACITY = 0.2;
        // null until the reader sets one explicitly (the wash strength slider, off by
        // default alongside the rest of the score controls): with no choice made yet,
        // the wash still steps back at field zoom the way it always did. Once a reader
        // picks a strength it is theirs -- zoomend used to recompute this from scratch
        // on every zoom, silently discarding a chosen value the moment the view crossed
        // FIELD_MIN_ZOOM either way.
        let scoreOpacity = null;
        const syncCountyWash = function() {
            const pane = map.getPane('qc-counties');
            if (!pane) return;
            if (scoreOpacity != null) { pane.style.opacity = String(scoreOpacity); return; }
            pane.style.opacity = map.getZoom() >= FIELD_MIN_ZOOM ? String(FIELD_WASH_OPACITY) : '1';
        };
        window.qcSetScoreOpacity = function(value) {
            const n = Number(value);
            scoreOpacity = Number.isFinite(n) ? Math.min(1, Math.max(0.05, n)) : null;
            syncCountyWash();
        };
        // Read-only twin of the setter above, for Share view / the routine history
        // writer -- neither lives in this closure otherwise.
        window.qcGetScoreOpacity = function() { return scoreOpacity; };
        map.on('zoomend', syncBase);
        map.on('zoomend', syncCountyWash);
        syncBase();
        syncCountyWash();
        applyScoresVisibility();   // scores start off: highlights redraw with the neutral (invisible-fill) style
        map.on('moveend zoomend', announceCurrentViewChange);
        // B3: any pan/zoom NOT itself part of an applyView()/locate() apply (i.e.
        // reader-driven -- drag, scroll-zoom, the +/- control, a search result,
        // fitBounds from Zoom to state...) demotes a location-derived center back
        // to 'user'. Only ever demotes: currentCenterSource starts 'user' and this
        // never sets it to 'location' itself, so it cannot misfire on every other
        // map movement in the app.
        map.on('movestart', function() {
            if (currentCenterSource === 'location' && !viewApplyGuard.applying) currentCenterSource = 'user';
        });

        // Hand the map over. The Field Maps builder draws its selection, its sheet
        // outlines and its overlays on THIS map rather than making a second one --
        // "one single map with all these layers", which is also why the builder can
        // no longer be a separate page.
        window.qcMap = map;
        // Whatever changes the map's box -- the phone sheet's size, a window resize
        // across the dock breakpoint, a rotation -- Leaflet has to re-measure, or
        // it keeps drawing tiles and placing cards for the OLD box. A ResizeObserver
        // fires after the new size is laid out, so there is no frame-guessing. On a
        // desktop `pan: true` keeps the same place in the middle of the map as the map
        // column widens or narrows; on a phone the sheet grows from the bottom and
        // `pan: false` keeps the top edge where it was, as before.
        var mapEl = document.getElementById('qc-map');
        if (mapEl && typeof ResizeObserver === 'function') {
            new ResizeObserver(function() {
                map.invalidateSize({ pan: !window.matchMedia('(max-width: 1023px)').matches });
            }).observe(mapEl);
        }
        // QUX-05c: main.js's drawSelectedSearchFeature (a search-selected name's
        // card) shares Q/view-state.js's link format with this file's own "Share
        // view" button rather than inventing a second one -- it reads the current
        // view through this bridge (window.qcGetScoreOpacity's calling convention,
        // defined the other direction). Safe to assign before currentView's own
        // definition further down: function declarations hoist within this IIFE.
        window.qcCurrentView = currentView;
        document.dispatchEvent(new CustomEvent('qc:map-ready', { detail: { map: map } }));
        if (pendingInitialView) applyResolvedView(pendingInitialView);

        // County/state geometry (the choropleth or its dot fallback) is not
        // built here -- attachCountyGeometry() draws it once geo.json and
        // counties-10m.json are both known. hlLayer stays null until then;
        // updateMapHighlights() and renderLegend() both already tolerate that
        // (an empty highlight layer, an empty countyFeatureLookup).

        // Legend \u2014 must describe what is actually drawn in each mode, and at field
        // zoom that is no longer the national county ranking: the wash is turned down
        // and the topographic base is what the reader is reading. A key that keeps
        // explaining a score ramp nobody can see is a key that is lying.
        var legendDiv = null;
        var legendBody = null;
        legendRefresh = renderLegend;
        function renderLegend() {
            var div = legendBody;
            if (!div) return;
            if (!scoresVisible) {
                div.innerHTML =
                    '<div class="qc-legend-title">Administrative boundaries</div>' +
                    '<div class="qc-legend-item"><span class="qc-legend-swatch" style="background:#f59e0b;opacity:0.7;"></span> Candidate town</div>' +
                    '<div class="qc-legend-item"><span class="qc-legend-swatch" style="background:#94a3b8;opacity:0.65;"></span> Town, no match</div>' +
                    '<div class="qc-legend-note">Turn on County score under Layers to see the ranking key.</div>';
                return;
            }
            // Recomputed on every call rather than captured once at map
            // creation: geometry can arrive (or fail to) after the legend
            // first renders, and the key has to track whichever is true now.
            var topoAvailable = Object.keys(countyFeatureLookup).length > 0;
            if (topoAvailable && map.getZoom() >= FIELD_MIN_ZOOM) {
                div.innerHTML =
                    '<div class="qc-legend-title">This area</div>' +
                    '<div class="qc-legend-item"><span class="qc-legend-swatch" style="background:#f59e0b;opacity:0.7;"></span> Candidate town</div>' +
                    '<div class="qc-legend-item"><span class="qc-legend-swatch" style="background:#94a3b8;opacity:0.65;"></span> Town, no match</div>' +
                    '<div class="qc-legend-item"><span class="qc-legend-swatch" style="background:' + accent + ';opacity:0.2;border:1px solid ' + accent + ';"></span> Matched county (dimmed)</div>' +
                    '<div class="qc-legend-note">USGS topographic base. Zoom out for the county ranking.</div>';
                return;
            }
            if (topoAvailable) {
                div.innerHTML =
                    '<div class="qc-legend-title">' + escHtml(colorMetric(colorBy).label) + '</div>' + bandKeyHtml(accent) +
                    '<div class="qc-legend-item"><span class="qc-legend-swatch" style="background:#f59e0b;opacity:0.7;"></span> Candidate town</div>' +
                    '<div class="qc-legend-item"><span class="qc-legend-swatch" style="background:#94a3b8;opacity:0.65;"></span> Town, no match</div>' +
                    '<div class="qc-legend-item"><span class="qc-legend-swatch" style="background:#1a2a3a;opacity:0.7;border:1px solid #2a2a42;"></span> Rural county</div>';
            } else {
                div.innerHTML =
                    '<div class="qc-legend-title">' + escHtml(colorMetric(colorBy).label) + ' (points)</div>' + bandKeyHtml(accent) +
                    '<div class="qc-legend-item"><span class="qc-legend-dot" style="background:#f59e0b;width:7px;height:7px;"></span> Candidate town</div>' +
                    '<div class="qc-legend-item"><span class="qc-legend-dot" style="background:#94a3b8;width:5px;height:5px;opacity:0.65;"></span> Town, no match</div>' +
                    '<div class="qc-legend-item"><span class="qc-legend-dot" style="background:#3a7a5a;width:7px;height:7px;opacity:0.6;"></span> Rural county center</div>' +
                    '<div class="qc-legend-note">Larger dot = higher band. County outlines unavailable</div>';
            }
        }

        // ------------------------------------------------------------------
        // Finding a place, measuring one, and getting back (audit F20)
        //
        // The map had no search, no scale and no way home. All three read only what
        // is already loaded -- no new source, no permission prompt, no network.
        // ------------------------------------------------------------------

        // Miles, not metres: every sheet this project prints is letter paper at an
        // imperial scale, and a reader comparing screen to paper needs the same unit.
        L.control.scale({ imperial: true, metric: false, position: 'bottomleft' }).addTo(map);

        // Share / Reset / Use my location (B1, B3): a Leaflet control, not an
        // overlay pinned to .qc-map-container. Below 1024px both panels sit in
        // that container UNDER the map, so `bottom: 0.5rem` of the container was
        // the print panel's bottom, not the map's, and the row painted over the
        // panel summaries -- a tap on the print summary landed on this row once
        // a third button reached its centre (layout.test.mjs, "the print panel
        // can actually be opened at 390px"). The map places a control inside
        // #qc-map, so the row is on the map in every layout. The node moves
        // with its ids intact; wireViewControls / wireLocateControl look the
        // buttons up by id, and listeners survive a move.
        //
        // Bottom left, above the scale bar, on a desktop. Top right below
        // 1024px: there the legend in the bottom-right corner, once opened
        // from its Key chip, is as wide as the map (388px of 390, measured
        // 2026-09-26) and paints over every bottom-left control
        // (phone-controls.test.mjs), while the top right
        // holds only the transient place-names notice. The same query as the
        // stylesheet's phone block, so the corner changes where the layout does.
        var viewRow = document.getElementById('qc-view-controls');
        if (viewRow) {
            var narrow = window.matchMedia ? window.matchMedia('(max-width: 1023px)') : null;
            var viewCorner = function() { return narrow && narrow.matches ? 'topright' : 'bottomleft'; };
            var viewCtl = L.control({ position: viewCorner() });
            viewCtl.onAdd = function() {
                L.DomEvent.disableClickPropagation(viewRow);
                L.DomEvent.disableScrollPropagation(viewRow);
                return viewRow;
            };
            viewCtl.addTo(map);
            if (narrow && narrow.addEventListener) {
                narrow.addEventListener('change', function() { viewCtl.setPosition(viewCorner()); });
            }
        }

        var reset = L.control({ position: 'topleft' });
        reset.onAdd = function() {
            var wrap = L.DomUtil.create('div', 'leaflet-bar qc-reset-wrap');
            var b = L.DomUtil.create('button', 'qc-reset-view', wrap);
            b.type = 'button';
            b.textContent = '⌂';
            b.title = 'Show the whole country';
            b.setAttribute('aria-label', 'Show the whole country');
            L.DomEvent.disableClickPropagation(wrap);
            L.DomEvent.on(b, 'click', function() {
                flyToBoundsRM(CONUS_BOUNDS, { padding: CONUS_PADDING, duration: 0.8 });
            });
            return wrap;
        };
        reset.addTo(map);

        // Top LEFT, stacked under zoom and reset. The top right is where the
        // Layers and map key panel lives, and a search box put there measures as
        // visible while sitting under it: geometry says 240x30 at (689, 466) and
        // elementFromPoint says qcm-layer-panel. Two controls in one corner is the
        // same defect the print panel had (F01) at a smaller size.
        // The map has no free corner on a desktop: the print panel covers the top
        // left, the layer panel the top right, the filters the bottom left and the
        // key the bottom right. So the controls get a lane of their own down the
        // left edge (quiet-corners.css shifts the print panel clear of it), and the
        // search box, which cannot fit a 30px lane, opens out of a button in it.
        var finder = L.control({ position: 'topleft' });
        finder.onAdd = function() {
            var wrap = L.DomUtil.create('div', 'leaflet-bar qc-finder');
            wrap.innerHTML =
                // The glyph alone is what a phone got, and a 30px symbol on a map is
                // easy to scroll straight past (audit A09). The words ride with it and
                // the stylesheet hides them again on a desktop, where the button shares
                // a 30px lane. "Search places" is a prefix of the aria-label, so the
                // spoken name still contains the name a reader can see and say. QUX-05a:
                // renamed from "Find a town" -- the box always finds peaks and other
                // named places too, merged in alongside towns and coordinates below.
                '<button type="button" class="qc-finder-toggle" aria-expanded="false"'
                + ' aria-controls="qc-finder-box" aria-label="Search places by name">⌕'
                + '<span class="qc-finder-label">Search places</span></button>'
                + '<div class="qc-finder-box" id="qc-finder-box" hidden>'
                + '<input id="qc-place-search" type="search" autocomplete="off" spellcheck="false"'
                + ' placeholder="Search places" aria-label="Search places by name"'
                + ' role="combobox" aria-expanded="false" aria-controls="qc-place-results">'
                + '<div id="qc-place-results" class="qc-finder-results" role="listbox" hidden></div>'
                // The miss sentence sits BESIDE the listbox, not in it: a listbox may
                // hold options and groups and nothing else (axe aria-required-children),
                // and a <p> inside one is skipped rather than read. The status region
                // beside it is what actually reaches a screen reader -- role="status"
                // with aria-live="polite", so a result announces itself without
                // interrupting whatever is being read.
                + '<p id="qc-finder-note" class="qc-finder-empty" hidden></p>'
                + '<div id="qc-finder-status" class="qc-finder-status" role="status" aria-live="polite"></div>'
                // B2: a remote GNIS name search, explicit-submission only -- never
                // fired on keystroke like the local town match above it. The button
                // is the visible trigger; Enter with no active suggestion (wired
                // below) is the keyboard equivalent.
                + '<button type="button" id="qc-name-search-btn" class="qc-name-search-btn">Search</button>'
                // Its status is spoken through #qc-finder-status above: the finder
                // owns ONE live region (finder-announcement.test.mjs), a second one
                // beside it would have a reader hear two regions race for the same box.
                + '<p id="qc-name-note" class="qc-finder-empty" hidden></p>'
                + '</div>';
            L.DomEvent.disableClickPropagation(wrap);
            L.DomEvent.disableScrollPropagation(wrap);
            var toggle = wrap.querySelector('.qc-finder-toggle');
            var pane = wrap.querySelector('.qc-finder-box');
            var box = wrap.querySelector('#qc-place-search');
            var list = wrap.querySelector('#qc-place-results');
            var nameBtn = wrap.querySelector('#qc-name-search-btn');
            // The expanded box is moved OUT of the map. Below 1024px #qc-map carries
            // z-index 10 so the sheet can sit on it, and that makes a stacking
            // context no child can climb out of; on a desktop the map pane is one
            // too, ordered with the card pane (lifted out above, at 25) against
            // what floats on the map column. Re-homed on the map's container, the
            // box is a sibling of the panels and sits above them and the cards at 30.
            var host = map.getContainer().parentNode;
            host.appendChild(pane);
            // Anchored to the button each time, so the two stay together across
            // breakpoints without the CSS restating either position.
            var place = function() {
                // Not `t`: scripts/test_data_contract.py reserves that name for a
                // candidates.json record and would ask this rect for its fields.
                var btn = toggle.getBoundingClientRect(), h = host.getBoundingClientRect();
                // Beside the button when it fits, below it when it does not. The
                // labelled phone button is wide, and opening a near-screen-width box
                // to the right of it would put half the box off screen.
                var paneBox = pane.getBoundingClientRect();
                var beside = (btn.right - h.left) + 4 + paneBox.width <= h.width;
                var paneTop = beside ? btn.top - h.top : btn.bottom - h.top + 4;
                pane.style.top = paneTop + 'px';
                pane.style.left = (beside ? (btn.right - h.left) + 4
                    : Math.max(0, Math.min(btn.left - h.left, h.width - paneBox.width))) + 'px';
                // No taller than the room left in the map frame below it. The frame
                // clips, so on a short screen (a small phone, a phone on its side)
                // the last rows and "Search" were cut off with no way to reach
                // them; the stylesheet takes this cap out of the suggestion list,
                // which scrolls instead.
                pane.style.maxHeight = Math.max(0, host.clientHeight - paneTop - 4) + 'px';
            };
            var setOpen = function(open) {
                pane.hidden = !open;
                toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
                if (open) { place(); box.focus(); }
                else { list.hidden = true; box.value = ''; clearNameSearchState(); }
            };
            // Placed again while it is open whenever the frame or the button changes
            // size. A phone turned with the search open has a much shorter frame on
            // its side, and upright again it is too narrow for the box to stay beside
            // the button; the reader keeps the box and the query they typed.
            if (typeof ResizeObserver === 'function') {
                var refit = new ResizeObserver(function() { if (!pane.hidden) place(); });
                refit.observe(host);
                refit.observe(toggle);
            }
            L.DomEvent.on(toggle, 'click', function() { setOpen(pane.hidden); });
            // Retyping invalidates whatever the last explicit name search answered --
            // it was an answer to a different query, and leaving it on screen would
            // pair stale remote results with a query that no longer asked for them.
            L.DomEvent.on(box, 'input', function() { clearNameSearchState(); renderFinderResults(box, list); });
            L.DomEvent.on(nameBtn, 'click', function() { submitNameSearch(box, list); });
            // A search box inside a map must not let a keystroke reach the map's own
            // shortcuts: '+' and '-' are zoom, and the arrows pan.
            L.DomEvent.on(box, 'keydown', function(e) {
                L.DomEvent.stopPropagation(e);
                if (e.key === 'Escape') {
                    L.DomEvent.preventDefault(e);
                    // A query in progress: Escape clears it and hands focus back to
                    // the input, so a reader can start a fresh search without
                    // reaching for the mouse. An already-empty box has nothing left
                    // to clear, so Escape falls back to its old job of closing the
                    // panel -- the one case this box behaved this way before.
                    if (box.value) {
                        box.value = '';
                        clearNameSearchState();
                        renderFinderResults(box, list);
                        box.focus();
                    } else {
                        setOpen(false);
                        toggle.focus();
                    }
                    return;
                }
                if (e.key === 'ArrowDown') {
                    L.DomEvent.preventDefault(e);
                    setFinderActive(box, list, finderActive + 1);
                } else if (e.key === 'ArrowUp') {
                    L.DomEvent.preventDefault(e);
                    setFinderActive(box, list, finderActive - 1);
                } else if (e.key === 'Home' && finderActive >= 0) {
                    L.DomEvent.preventDefault(e);
                    setFinderActive(box, list, 0);
                } else if (e.key === 'End' && finderActive >= 0) {
                    L.DomEvent.preventDefault(e);
                    setFinderActive(box, list, finderOptions(list).length - 1);
                } else if (e.key === 'Enter') {
                    // Enter with nothing chosen is not "take the first hit": the reader
                    // may still be typing, and moving the map out from under them is
                    // the surprise this whole control exists to avoid. It IS, however,
                    // the keyboard equivalent of "Search" -- an explicit ask,
                    // never fired by a keystroke alone (brief item 1).
                    var chosen = finderOptions(list)[finderActive];
                    if (chosen) { L.DomEvent.preventDefault(e); chosen.click(); }
                    else { L.DomEvent.preventDefault(e); submitNameSearch(box, list); }
                }
            });
            // Tab and Shift+Tab out of the open box close it. The box sits over the
            // map and, on a phone, over the sheet, so focus moved on from it could
            // land on a control the box itself covers. Only the keyboard closes it:
            // Leaflet focuses the map on a press, and a reader dragging the map to
            // look around keeps the box and the query. Capture, because the box's own
            // keydown above stops the event; the check waits for the browser to have
            // moved focus.
            pane.addEventListener('keydown', function(e) {
                if (e.key !== 'Tab') return;
                setTimeout(function() {
                    if (!pane.hidden && !pane.contains(document.activeElement)) setOpen(false);
                }, 0);
            }, true);
            finderClose = function() { setOpen(false); };
            // What the arriving export re-runs. Only while the box is open and holds
            // a query: re-rendering a closed or empty search has nothing to say.
            finderRefresh = function() {
                if (!pane.hidden && box.value) renderFinderResults(box, list);
            };
            return wrap;
        };
        finder.addTo(map);

        var legend = L.control({ position: 'bottomright' });
        legend.onAdd = function() {
            legendDiv = L.DomUtil.create('div', 'qc-legend');
            // Below 1024px the key folds to a "Key" chip (quiet-corners.css); the body
            // keeps all of its text either way. The toggle is display:none on a desktop.
            var keyToggle = foldToggle('qc-legend-toggle', 'Key', 'Map key');
            legendBody = L.DomUtil.create('div', 'qc-legend-body');
            legendDiv.appendChild(keyToggle);
            legendDiv.appendChild(legendBody);
            keyToggle.addEventListener('click', function() {
                setFold(keyToggle, legendDiv, !legendDiv.classList.contains('qc-fold-open'));
            });
            L.DomEvent.disableClickPropagation(legendDiv);
            renderLegend();
            return legendDiv;
        };
        legend.addTo(map);

        // The credit: Leaflet's own attribution control stays the element (main.js adds
        // the road credit to it), so it is not rebuilt. A "Credits" chip sits beside it
        // and, below 1024px, the credit is folded until it is tapped.
        if (map.attributionControl) {
            var credit = map.attributionControl.getContainer();
            var creditToggle = foldToggle('qc-credit-toggle', 'Credits', 'Map credits');
            credit.parentNode.appendChild(creditToggle);
            creditToggle.addEventListener('click', function() {
                setFold(creditToggle, credit, !credit.classList.contains('qc-fold-open'));
            });
            L.DomEvent.disableClickPropagation(creditToggle);
            setFold(creditToggle, credit, false);
        }
        map.on('zoomend', renderLegend);
    }

    // The fold chips for the map's credit and key (phone only; see quiet-corners.css).
    function foldToggle(cls, text, label) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = cls + ' qc-fold-toggle leaflet-control';
        b.textContent = text;
        b.setAttribute('aria-label', label);
        b.setAttribute('aria-expanded', 'false');
        return b;
    }
    function setFold(toggle, target, open) {
        target.classList.toggle('qc-fold-open', open);
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    // Draws the county wash: the TopoJSON choropleth when counties-10m.json
    // parsed, its dot-based fallback when it did not. Runs once, after
    // geo.json and counties-10m.json are BOTH known (success or failure) --
    // separately from createMap(), so a slow or failing county-geometry
    // fetch never delays the map, base tiles, search box or print builder.
    function attachCountyGeometry(geo, topo) {
        geoData = geo;
        if (geo) {
            geo.forEach(p => { geoPointLookup[p.fips] = p; });
        }
        geometryKnown = true;
        topoData = topo;

        // Leaflet missing entirely (createMap() already caught and reported
        // that) -- there is no map to draw county geometry onto.
        if (!map) return;

        const geoLookup = {};
        if (geo) {
            for (const pt of geo) { geoLookup[pt.fips] = pt; }
        }

        const topoAvailable = !!(topo && typeof topojson !== 'undefined');

        try {
            if (topoAvailable) {
                // ---- TopoJSON choropleth approach ----
                const countiesGeo = topojson.feature(topo, topo.objects.counties);
                const stateMesh = topojson.mesh(topo, topo.objects.states, function(a, b) { return a !== b; });

                // Geometry credit: derived from Census TIGER/Line via the ISC-licensed
                // us-atlas project (github.com/topojson/us-atlas), not a live Census feed.
                var GEOMETRY_ATTRIBUTION = 'County/state boundaries: <a href="https://github.com/topojson/us-atlas" target="_blank" rel="noopener">us-atlas</a> (ISC), from US Census TIGER/Line';

                // All US counties — subtle dark shapes for geographic context
                // The fill is the score wash's: 0 with scores off, COUNTY_CONTEXT_FILL
                // with them on (applyScoresVisibility restyles this layer on the switch).
                countyContextStyle = function(feature) {
                    const fips = String(feature.id).padStart(5, '0');
                    const isRural = geoLookup[fips] !== undefined;
                    return {
                        fillColor: isRural ? '#1a2a3a' : '#12121e',
                        fillOpacity: !scoresVisible ? 0 : isRural ? COUNTY_CONTEXT_FILL.rural : COUNTY_CONTEXT_FILL.other,
                        color: '#2a2a42',
                        weight: 0.3,
                        opacity: 0.6,
                    };
                };
                countyContextLayer = L.geoJSON(countiesGeo, {
                    attribution: GEOMETRY_ATTRIBUTION,
                    pane: 'qc-counties',
                    style: countyContextStyle,
                    interactive: false,
                }).addTo(map);

                // Highlight layer for filtered counties (colored polygons)
                hlLayer = L.layerGroup().addTo(map);

                // State boundaries on top — clear orientation lines
                L.geoJSON(stateMesh, {
                    attribution: GEOMETRY_ATTRIBUTION,
                    style: {
                        color: '#5a5a7a',
                        weight: 1.5,
                        opacity: 0.8,
                        fill: false,
                    },
                    interactive: false,
                }).addTo(map);

                // Build county feature lookup for fast highlight updates
                countiesGeo.features.forEach(function(f) {
                    const fips = String(f.id).padStart(5, '0');
                    countyFeatureLookup[fips] = f;
                });
            } else {
                // ---- Fallback: dot-based map if TopoJSON unavailable ----
                // No basemap tiles. The county geometry is served from this origin,
                // so this branch is only reached if that file fails to load — and a
                // third-party tile host would violate img-src 'self' anyway.
                var bgLayer = L.layerGroup().addTo(map);
                if (geo) {
                    for (var i = 0; i < geo.length; i++) {
                        var pt = geo[i];
                        if (pt.lat == null || pt.lon == null) continue;
                        L.circleMarker([pt.lat, pt.lon], {
                            radius: 3.5,
                            fillColor: '#3a7a5a',
                            fillOpacity: 0.4,
                            stroke: false,
                            interactive: false,
                        }).addTo(bgLayer);
                    }
                }
                hlLayer = L.layerGroup().addTo(map);

                // Say what this degraded view actually is — dots, no boundaries.
                var notice = L.control({ position: 'topright' });
                notice.onAdd = function() {
                    var d = L.DomUtil.create('div', 'qc-map-notice');
                    d.textContent = 'County boundary data unavailable — showing approximate county center points only.';
                    return d;
                };
                notice.addTo(map);
            }
        } catch (e) {
            // A malformed or unexpectedly-shaped county-geometry response --
            // the wash stays off, but the map, base tiles, search box and
            // print builder this function never touched are unaffected.
            if (!hlLayer) hlLayer = L.layerGroup().addTo(map);
        }

        // Geometry can land after the county table already rendered (or
        // after the reader has already filtered); repaint both against what
        // just arrived.
        if (countiesData) updateMapHighlights(new Set(lastFiltered.map(c => c.fips)));
        if (legendRefresh) legendRefresh();
        replayHeldCountyPick();
    }

    function makePopupHtml(c) {
        const fmt = (v) => v != null ? v.toFixed(0) : '-';
        const pop = c.population ? c.population.toLocaleString() : '-';
        const dist = c.distance_to_metro_mi != null ? c.distance_to_metro_mi.toFixed(0) + ' mi' : '-';
        let html = '<strong>' + escHtml(c.name) + ', ' + escHtml(c.state) + '</strong>' +
            '<div class="qc-popup-row"><span class="qc-popup-label">Pop</span><span class="qc-popup-val">' + pop + '</span></div>' +
            '<div class="qc-popup-row"><span class="qc-popup-label">Overall</span><span class="qc-popup-val">' + fmt(c.overall_score) + '</span></div>' +
            '<div class="qc-popup-row"><span class="qc-popup-label">Quietness</span><span class="qc-popup-val">' + fmt(c.quietness_score) + '</span></div>' +
            '<div class="qc-popup-row"><span class="qc-popup-label">Stability</span><span class="qc-popup-val">' + fmt(c.stability_score) + '</span></div>' +
            '<div class="qc-popup-row"><span class="qc-popup-label">Affordability</span><span class="qc-popup-val">' + fmt(c.affordability_score) + '</span></div>' +
            '<div class="qc-popup-row"><span class="qc-popup-label">Remoteness</span><span class="qc-popup-val">' + dist + '</span></div>' +
            '<div class="qc-popup-row"><span class="qc-popup-label">Nearest city</span><span class="qc-popup-val">' + escHtml(c.nearest_metro || '-') + '</span></div>';

        if (sprawlReady) {
            const sprawl = c.sprawl_risk !== null ? c.sprawl_risk.toFixed(0) : '-';
            html += '<div class="qc-popup-row"><span class="qc-popup-label">Sprawl risk</span><span class="qc-popup-val">' + sprawl + '</span></div>';

            // Factor breakdown if available
            if (c.sprawl_factors) {
                // Evidence state per factor (HM-4): a measured 0 reads "0", an
                // unavailable one "no data" -- the score itself is 0.0 either way.
                [['interstate', 'Interstate'], ['permits', 'Permits'], ['migration', 'Migration'],
                 ['metro_growth', 'Metro growth'], ['recreation', 'Recreation']].forEach(function(row) {
                    var d = factorDisplay(c, row[0]);
                    html += '<div class="qc-popup-row"><span class="qc-popup-label">' + row[1] + '</span><span class="qc-popup-val" title="' + escAttr(d.title) + '">' + escHtml(d.text) + '</span></div>';
                });
                html += '</div>';
            }
        }

        return html;
    }

    function updateMapHighlights(fipsSet) {
        if (!hlLayer) return;
        const accent = getAccentColor();

        hlLayer.clearLayers();
        markerLookup = {};

        // Scores off: every score-owned fill and highlight goes together, but the
        // shapes themselves stay -- a table row still has something on the map to
        // fly to and select (markerLookup below), which an early return here would
        // have silently broken. `neutralStyle` is the "administrative outline,
        // nothing scored" style: an invisible fill so the shape stays clickable
        // without drawing a ranking nobody asked to see.
        var neutralStyle = { fill: 'transparent', opacity: 0, weight: 1, dashArray: null, radius: 6 };
        var styleFor = function(value, metric) {
            return scoresVisible ? bandStyle(value, accent, metric) : neutralStyle;
        };

        var hasTopoFeatures = Object.keys(countyFeatureLookup).length > 0;

        if (hasTopoFeatures) {
            // Choropleth: color matching county polygons
            var features = [];
            var missingFips = [];
            fipsSet.forEach(function(fips) {
                var feature = countyFeatureLookup[fips];
                if (feature) features.push(feature);
                else missingFips.push(fips);
            });

            if (features.length > 0) {
                L.geoJSON({ type: 'FeatureCollection', features: features }, {
                    pane: 'qc-counties',
                    style: function(feature) {
                        var fips = String(feature.id).padStart(5, '0');
                        var c = countyLookup[fips];
                        var sc = styleFor(c ? c[colorMetric(colorBy).key] : null, colorMetric(colorBy));
                        return {
                            fillColor: sc.fill,
                            fillOpacity: sc.opacity,
                            color: accent,
                            weight: sc.weight,
                            dashArray: sc.dashArray,
                            opacity: 0.8,
                        };
                    },
                    onEachFeature: function(feature, layer) {
                        var fips = String(feature.id).padStart(5, '0');
                        var c = countyLookup[fips];
                        if (c) {
                            layer.bindPopup(makePopupHtml(c), { maxWidth: 240 });
                            markerLookup[fips] = layer;
                        }
                    },
                }).addTo(hlLayer);
            }

            // Counties absent from the TopoJSON (e.g. FIPS 02063/02066 from
            // the post-2019 Valdez-Cordova split) get a clickable centroid
            // marker so their table rows still fly somewhere real.
            missingFips.forEach(function(fips) {
                var pt = geoPointLookup[fips];
                if (!pt || pt.lat == null || pt.lon == null) return;
                var mc = countyLookup[fips];
                var msc = styleFor(mc ? mc[colorMetric(colorBy).key] : null, colorMetric(colorBy));
                var mm = L.circleMarker([pt.lat, pt.lon], {
                    pane: 'qc-counties',
                    radius: 6,
                    fillColor: msc.fill,
                    fillOpacity: msc.opacity,
                    color: accent,
                    weight: 1,
                    opacity: 0.8,
                });
                if (mc) mm.bindPopup(makePopupHtml(mc), { maxWidth: 240 });
                mm.addTo(hlLayer);
                markerLookup[fips] = mm;
            });
        } else if (geoData) {
            // Fallback: circle markers
            for (var i = 0; i < geoData.length; i++) {
                var pt = geoData[i];
                if (pt.lat == null || pt.lon == null) continue;
                if (!fipsSet.has(pt.fips)) continue;

                var c = countyLookup[pt.fips];
                var dsc = styleFor(pt[colorMetric(colorBy).key], colorMetric(colorBy));

                var marker = L.circleMarker([pt.lat, pt.lon], {
                    radius: dsc.radius,
                    fillColor: dsc.fill,
                    fillOpacity: scoresVisible ? 0.75 : 0,
                    color: accent,
                    weight: 1,
                    opacity: 0.9,
                });

                if (c) {
                    marker.bindPopup(makePopupHtml(c), { maxWidth: 240 });
                }
                marker.addTo(hlLayer);
                markerLookup[pt.fips] = marker;
            }
        }
    }

    // ========================================================================
    // TABLE
    // ========================================================================

    function scoreClass(val, highIsGood) {
        if (val === null || val === undefined) return '';
        if (highIsGood) return val >= 70 ? 'high' : val >= 40 ? 'medium' : 'low';
        return val <= 30 ? 'high' : val <= 60 ? 'medium' : 'low';
    }

    // The Remote column is raw miles, not a 0-100 score. Feeding it to
    // scoreClass banded 70+ MILES as "high" alongside 70+ point scores, so with
    // the filter floor at 75mi nearly every visible row rendered green and the
    // color carried no information. Normalize to the same scale the pipeline
    // uses for the remoteness term first: distance / cap, saturating at 100.
    // The cap is a pipeline constant (RemotenessThresholds.score_cap_mi, 120 —
    // the observed p95); prefer an exported value if a future summary.json
    // carries one, so this copy cannot drift silently.
    const REMOTENESS_CAP_MI_FALLBACK = 120;

    function remotenessClass(distanceMi) {
        if (distanceMi === null || distanceMi === undefined) return '';
        const cap = (summaryData && summaryData.remoteness_cap_mi) || REMOTENESS_CAP_MI_FALLBACK;
        return scoreClass(Math.min(100, distanceMi / cap * 100), true);
    }

    function renderTable(counties) {
        const body = document.getElementById('qc-table-body');
        if (!body) return;

        if (!counties.length) {
            body.innerHTML = '<div class="qc-empty">No counties match the current filters. Loosen a threshold or clear the state filter.</div>';
            return;
        }

        const sorted = [...counties].sort(compareBySort(currentSort));

        // Pagination: slice to current page
        const start = currentPage * PAGE_SIZE;
        const paged = sorted.slice(start, start + PAGE_SIZE);
        const rowClass = sprawlReady ? 'qc-row sprawl-visible' : 'qc-row';

        body.innerHTML = paged.map(c => {
            const pop = c.population ? c.population.toLocaleString() : '-';
            const overall = c.overall_score != null ? c.overall_score.toFixed(0) : '-';
            const stab = c.stability_score != null ? c.stability_score.toFixed(0) : '-';
            const afford = c.affordability_score != null ? c.affordability_score.toFixed(0) : '-';
            const dist = c.distance_to_metro_mi != null ? c.distance_to_metro_mi.toFixed(0) + 'mi' : '-';
            let sprawlHtml = '';
            if (sprawlReady) {
                const sprawl = c.sprawl_risk != null ? c.sprawl_risk.toFixed(0) : '-';
                sprawlHtml = '<span class="qc-score ' + scoreClass(c.sprawl_risk, false) + '">' + sprawl + '</span>';
            }
            return '<div class="' + rowClass + '"' +
                ' data-fips="' + escAttr(c.fips) + '"' +
                ' data-state="' + escAttr(c.state) + '"' +
                ' tabindex="0" role="button" aria-label="Fly to ' + escAttr(c.name) + ', ' + escAttr(c.state) + '"' +
                '><span class="qc-name">' + escHtml(c.name) + '</span>' +
                '<span class="qc-state-col">' + escHtml(c.state) + '</span>' +
                '<span class="qc-pop">' + pop + '</span>' +
                '<span class="qc-score ' + scoreClass(c.overall_score, true) + '">' + overall + '</span>' +
                '<span class="qc-score ' + scoreClass(c.stability_score, true) + '">' + stab + '</span>' +
                '<span class="qc-score ' + scoreClass(c.affordability_score, true) + '">' + afford + '</span>' +
                '<span class="qc-score ' + remotenessClass(c.distance_to_metro_mi) + '">' + dist + '</span>' +
                sprawlHtml +
                '</div>';
        }).join('');
        labelCells(body, 'qc-table-header');

        // #qc-count is written by applyFilters from the same filtered list —
        // no second write here.

        // Wire click handlers on rows
        body.querySelectorAll('.qc-row[data-fips]').forEach(row => {
            row.addEventListener('click', function() {
                flyToCounty(this.getAttribute('data-fips'));
            });
            row.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    flyToCounty(this.getAttribute('data-fips'));
                }
            });
        });
    }

    function flyToCounty(fips) {
        if (!map) return;
        if (!geometryKnown) { holdCountyPick(fips); return; }
        var layer = markerLookup[fips];
        if (layer) {
            if (typeof layer.getBounds === 'function') {
                // GeoJSON polygon layer
                flyToBoundsRM(layer.getBounds(), { maxZoom: 8, duration: 0.8, padding: [30, 30] });
            } else if (typeof layer.getLatLng === 'function') {
                // Circle marker fallback
                flyToRM(layer.getLatLng(), 8, { duration: 0.8 });
            }
            layer.openPopup();
        }
        var pt = geoPointLookup[fips], c = countyLookup[fips];
        // A county with no geo point must clear whatever the previous pick left on
        // screen rather than leave it looking like this county's own weather (QUX-03b-ii,
        // the same stale-selection rule showSky's own isFinite guard enforces below).
        if (pt) showSky(c ? c.name + ', ' + c.state : fips, pt.lat, pt.lon);
        else blankConditions();
    }

    // A row pressed before the county geometry lands has no point to fly to or ask
    // the weather for yet, but it IS the pick: name it now, and finish it (fly, sky
    // cards) when attachCountyGeometry runs -- unless another pick has replaced it
    // by then. Blanking the panel here told a reader who had just picked a county
    // to pick one (PR CI run 36610861814).
    function holdCountyPick(fips) {
        var c = countyLookup[fips], name = c ? c.name + ', ' + c.state : fips;
        var note = '<p class="qc-tonight-note">Finding ' + escHtml(name) + ' on the map…</p>';
        picked = heldCountyPick = { fips: fips, name: name };
        writeText('qc-conditions-summary', 'Conditions · ' + name);
        writeText('qc-conditions-heading', name);
        write('qc-conditions-for', '');
        write('qc-tonight', note);
        write('qc-hourly', '');
        write('qc-alerts', '');
    }

    function replayHeldCountyPick() {
        var held = heldCountyPick;
        heldCountyPick = null;
        if (held && held === picked) flyToCounty(held.fips);
    }

    const forecasts = createForecastLoader();
    let picked = null;
    function write(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; }
    function writeText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }

    const CONDITIONS_NO_PICK = 'Pick a county or a town to see conditions there.';
    const TONIGHT_NO_PICK = '<h3 class="qc-tonight-head">Tonight’s sky</h3>'
        + '<p class="qc-tonight-note">Pick a county or a town to see what the sky does there tonight.</p>';

    // A feature whose selection changed but that has no finite lat/lon to show
    // conditions for (QUX-03-04 plan §4, "never silently keep the last county's
    // weather when another feature is selected") must clear the panel outright
    // rather than leave the previous pick's cards and header on screen. This is
    // also what a reader sees before any pick has ever been made.
    function blankConditions() {
        picked = null;
        writeText('qc-conditions-summary', 'Conditions · Pick a place');
        writeText('qc-conditions-heading', CONDITIONS_NO_PICK);
        write('qc-conditions-for', '');
        write('qc-tonight', TONIGHT_NO_PICK);
        write('qc-hourly', '');
        write('qc-alerts', '');
    }

    // Both sky cards for the place just picked. The sequence, and the rule that a weather failure
    // must not blank the calculated sun and moon times, live in sky-cards.js so a test can inject
    // the failure at the fetch; this is the wiring to the page and nothing else.
    // QUX-09c: the fourth section under the conditions cards. Cameras come from main.js's
    // window.qcCamerasNear, which reads only catalogues a reader already loaded -- this never
    // turns a layer on or asks for one. Written synchronously with the header, so it can never
    // show the previous place's cameras. Absent bridge (standalone page) reads as "none".
    var CAMERAS_NEARBY_METERS = 25000;
    function writeCamerasNearby(lat, lon) {
        var host = document.getElementById('qc-conditions-cameras');
        if (!host) {
            var alerts = document.getElementById('qc-alerts');
            if (!alerts || !alerts.parentNode) return;
            host = document.createElement('section');
            host.className = 'qc-tonight';
            host.id = 'qc-conditions-cameras';
            host.setAttribute('aria-live', 'polite');
            alerts.parentNode.insertBefore(host, alerts.nextSibling);
        }
        var near = typeof window.qcCamerasNear === 'function' ? window.qcCamerasNear(lat, lon, CAMERAS_NEARBY_METERS) : [];
        host.textContent = '';
        var head = document.createElement('h3');
        head.className = 'qc-tonight-head';
        head.textContent = 'Cameras nearby';
        host.appendChild(head);
        var note = document.createElement('p');
        note.className = 'qc-tonight-note';
        // Camera files load by map area, so an empty list can mean "not read yet": say so, never "none".
        var notLoaded = !!(near && near.notLoaded);
        if (!near.length) {
            note.textContent = notLoaded
                ? 'Cameras near here are not loaded yet. Zoom the map in on this place (to zoom 7 or closer) and ask again.'
                : 'No camera layer is on, or none within 25 km.';
            host.appendChild(note);
            return;
        }
        var list = document.createElement('ul');
        near.forEach(function (cam) {
            var li = document.createElement('li');
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'qc-saved-row-action';
            btn.textContent = cam.name;
            btn.addEventListener('click', function () {
                Promise.resolve(window.qcShowCamera(cam.ref)).then(function (text) { status.textContent = text || ''; });
            });
            li.appendChild(btn);
            li.appendChild(document.createTextNode(' ' + (cam.meters / 1000).toFixed(1) + ' km away'));
            list.appendChild(li);
        });
        host.appendChild(list);
        var status = document.createElement('p');
        status.className = 'qc-tonight-note';
        host.appendChild(status);
        note.textContent = (notLoaded ? 'More cameras near here are not loaded yet; zoom the map in on this place to list them. ' : '')
            + 'Straight-line proximity does not establish the same conditions across a ridge.';
        host.appendChild(note);
    }

    // QUX-09b "Before you go": a 4th, optional `kind` -- a summit/ridge/gap
    // gains the grid-cell caveat on its forecast basis line (conditions-basis.js).
    function showSky(name, lat, lon, kind) {
        if (!isFinite(lat) || !isFinite(lon)) { blankConditions(); return; }
        const here = (picked = { name: name, lat: lat, lon: lon, kind: kind || null });
        // The panel's closed summary and its location header read the pick the moment it
        // lands -- synchronously, before any network call -- so a second pick never leaves
        // the previous place's name on screen while its own forecast is still in flight.
        writeText('qc-conditions-summary', 'Conditions · ' + name);
        writeText('qc-conditions-heading', name);
        // QUX-09b: the "which place, and what does each source actually cover"
        // header, and a pending note in each of the three slots below -- both
        // written HERE, synchronously, before any request goes out, so a reader
        // never sees a stale place's cards while this one is still asking.
        const latText = (Math.round(lat * 1e4) / 1e4).toFixed(4);
        const lonText = (Math.round(lon * 1e4) / 1e4).toFixed(4);
        write('qc-conditions-for',
            '<h2>Conditions for ' + escHtml(name) + ' — ' + latText + ', ' + lonText + '</h2>'
            + '<ul>' + basisLines({ kind: kind }).map(function (line) {
                return '<li>' + escHtml(line) + '</li>';
            }).join('') + '</ul>');
        writeCamerasNearby(lat, lon);
        write('qc-tonight', '<p class="qc-tonight-note">Working out tonight\'s sky for ' + escHtml(name) + '…</p>');
        write('qc-hourly', '<p class="qc-tonight-note">Asking the National Weather Service for ' + escHtml(name) + '\'s forecast…</p>');
        write('qc-alerts', '<p class="qc-tonight-note">Asking the National Weather Service for alerts at ' + escHtml(name) + '…</p>');
        // The alert card needs two independent things: the answer, and the place's own clock
        // zone, which arrives with the forecast's point lookup. Neither waits on the other --
        // whichever lands first paints, and the second repaints.
        const alertsAt = { answer: null, zone: null };
        const paintAlerts = function () {
            if (here !== picked || !alertsAt.answer) return;
            write('qc-alerts', alertsHtml(alertsAt.answer, { name: name, timeZone: alertsAt.zone }));
        };
        showSkyCards({
            place: here,
            request: function (opts) { return forecasts.request(opts); },
            write: write,
            isCurrent: function () { return here === picked; },
            // The zone is sky-cards' to latch; the alert card listens for it, and so does the
            // panel header -- once a real clock zone lands (never null; see sky-cards.js), the
            // header gains the local date for that place alongside its name.
            onZone: function (zone) {
                alertsAt.zone = zone;
                paintAlerts();
                if (here === picked) writeText('qc-conditions-heading', name + ' — ' + localDate(zone));
            },
        });
        // A SEPARATE ask, on the same origin and for a different product. Its own promise and
        // its own catch: an alert feed that 400s must not blank the forecast card, and a
        // forecast that fails must not hide a warning that is in force. alertsFor never
        // rejects -- it answers `{ status: 'failed' }` -- and the catch is the belt to that
        // brace, so the slot can never be left empty with no sentence in it.
        alertsFor({ lat: lat, lon: lon })
            .then(function (r) { alertsAt.answer = r; paintAlerts(); })
            .catch(function () { alertsAt.answer = { status: 'failed' }; paintAlerts(); });
    }

    function escHtml(s) {
        const d = document.createElement('div');
        d.textContent = s || '';
        return d.innerHTML;
    }

    // escHtml leaves quotes alone — safe between tags, not inside an attribute,
    // where a quote in the value closes it and the rest becomes markup. Every
    // attribute built by string concatenation below goes through this instead.
    function escAttr(s) {
        return escHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ========================================================================
    // PAGINATION
    // ========================================================================

    function renderPagination(totalCount, focusId) {
        const container = document.getElementById('qc-pagination');
        if (!container) return;

        const totalPages = Math.ceil(totalCount / PAGE_SIZE);
        if (totalPages <= 1) {
            container.innerHTML = '';
            return;
        }

        const prevDisabled = currentPage <= 0 ? ' disabled' : '';
        const nextDisabled = currentPage >= totalPages - 1 ? ' disabled' : '';

        container.innerHTML =
            '<button id="qc-prev"' + prevDisabled + '>&laquo; Prev</button>' +
            '<span>Page ' + (currentPage + 1) + ' of ' + totalPages + '</span>' +
            '<button id="qc-next"' + nextDisabled + '>Next &raquo;</button>';

        document.getElementById('qc-prev').addEventListener('click', function() {
            if (currentPage > 0) {
                currentPage--;
                renderTable(lastFiltered);
                renderPagination(totalCount, 'qc-prev');
            }
        });
        document.getElementById('qc-next').addEventListener('click', function() {
            if (currentPage < totalPages - 1) {
                currentPage++;
                renderTable(lastFiltered);
                renderPagination(totalCount, 'qc-next');
            }
        });

        // Re-rendering replaces the button the user just activated, which would
        // otherwise dump focus to <body>. Restore it to the equivalent control,
        // or the next-best one if that side is now disabled.
        if (focusId) {
            let target = document.getElementById(focusId);
            if (!target || target.disabled) {
                target = document.getElementById(focusId === 'qc-prev' ? 'qc-next' : 'qc-prev');
            }
            if (target && !target.disabled) {
                target.focus();
            } else {
                container.setAttribute('tabindex', '-1');
                container.focus();
            }
        }
    }

    // ========================================================================
    // SORTING
    // ========================================================================

    // Text columns read better A-Z; scores and populations read better
    // best-first. Shared by both tables.
    const TEXT_SORT_KEYS = ['name', 'state', 'nearest_metro', 'county_name'];

    function compareBySort(sort) {
        return function(a, b) {
            const av = a[sort.key] ?? (TEXT_SORT_KEYS.indexOf(sort.key) >= 0 ? '' : 0);
            const bv = b[sort.key] ?? (TEXT_SORT_KEYS.indexOf(sort.key) >= 0 ? '' : 0);
            if (typeof av === 'string' || typeof bv === 'string') {
                return sort.dir * String(av).localeCompare(String(bv));
            }
            return sort.dir * (av - bv);
        };
    }

    // One implementation for both headers: the candidates table carried
    // sort-styled headers that sorted nothing, hard-fixed to stability.
    // Which column a table is sorted by, said out loud. `.sort-active` was an
    // accent colour on a muted-grey heading row and nothing else — colour alone,
    // and silent about direction. Screen readers already got it from the
    // aria-label below; sighted readers did not (audit F19).
    const SORT_CARETS = { asc: '\u25B2', desc: '\u25BC' };

    function sortNote(label, key, dir) {
        const order = TEXT_SORT_KEYS.indexOf(key) >= 0
            ? (dir === 1 ? 'A to Z' : 'Z to A')
            : (dir === 1 ? 'lowest first' : 'highest first');
        return 'Sorted by ' + label + ', ' + order + '.';
    }

    /** The heading's own name, direct text nodes only — the tooltip is a child
     *  element, and textContent would fold it into the label. */
    function headerLabel(span) {
        let out = '';
        const kids = span.childNodes || [];
        for (let i = 0; i < kids.length; i++) {
            if (kids[i].nodeType === 3) out += kids[i].textContent;
        }
        return out.trim();
    }

    /** The heading a table has actually marked as its sort, by name. Empty when
     *  the table is not on the page yet — the candidate towns section ships
     *  hidden until a filter matches something. */
    function activeSortLabel(headerId) {
        const header = document.getElementById(headerId);
        const active = header && header.querySelector('span[data-sort].sort-active');
        return active ? headerLabel(active) : '';
    }

    /** The map colours by one measure and each table sorts by another, and all
     *  three are legitimate: Stability is roughly a fifth of Overall rather than
     *  a rival to it, so a county can shade dark and still sit low in the table.
     *  Every cue was labelled on its own and none of them was labelled together,
     *  which left the reader to work out that the colour beside the table is not
     *  the order of the table (audit A12). This is that sentence, built from the
     *  same state the map and the sort handlers use, so it cannot describe a view
     *  that is not on screen. It is not a live region: the two sort notes below
     *  already announce a sort, and a third one would say it twice.
     */
    function updateCueNote() {
        const note = document.getElementById('qc-cue-note');
        if (!note) return;
        const parts = ['Map color: ' + colorMetric(colorBy).label];
        const county = activeSortLabel('qc-table-header');
        if (county) parts.push('County sort: ' + county);
        const town = activeSortLabel('qc-candidates-header');
        if (town) parts.push('Town sort: ' + town);
        note.textContent = parts.join(' \u00b7 ');
    }

    /** Stamps every cell in a rendered table with the heading standing above it,
     *  so a screen too narrow for eight columns can show the label beside the
     *  value instead of hiding the column. The label is read from the table's own
     *  header row and never typed anywhere else: a card label written separately
     *  drifts the first time a column moves, and nothing would notice. */
    function labelCells(body, headerId) {
        const header = document.getElementById(headerId);
        if (!header || !body) return;
        const labels = Array.prototype.map.call(
            header.querySelectorAll('span[data-sort]'), headerLabel);
        Array.prototype.forEach.call(body.children, row => {
            Array.prototype.forEach.call(row.children, (cell, i) => {
                if (labels[i]) cell.setAttribute('data-label', labels[i]);
            });
        });
    }

    function markSorted(header, span, sort, noteId) {
        header.querySelectorAll('span[data-sort]').forEach(s => {
            s.classList.remove('sort-active');
            s.removeAttribute('aria-label');
            const old = s.querySelector('.qc-sort-caret');
            if (old) old.remove();
        });
        span.classList.add('sort-active');
        // aria-sort is not allowed on role="button" (axe aria-allowed-attr);
        // carry the state in the accessible name instead.
        span.setAttribute('aria-label', sort.key.replace(/_/g, ' ') +
            (sort.dir === 1 ? ', sorted ascending' : ', sorted descending'));
        const caret = document.createElement('span');
        caret.className = 'qc-sort-caret';
        caret.setAttribute('aria-hidden', 'true');
        caret.textContent = sort.dir === 1 ? SORT_CARETS.asc : SORT_CARETS.desc;
        span.appendChild(caret);
        const note = document.getElementById(noteId);
        if (note) note.textContent = sortNote(headerLabel(span), sort.key, sort.dir);
        // One funnel for "a sort was applied", so the picker below the table
        // cannot drift out of step with a heading the reader clicked instead.
        const picker = sortPickerFor(header);
        if (picker) picker.value = sort.key;
        updateCueNote();
    }

    function sortPickerFor(header) {
        return document.querySelector('select[data-sort-control="' + header.id + '"]');
    }

    /** Fills a table's sort picker from the table's own header row, the way
     *  labelCells() reads the card labels: a second list of column names typed
     *  into the markup would drift the first time a column moved, and nothing
     *  would notice. A column the data has not enabled is not offered — the
     *  sprawl heading ships `display:none` and enableSprawlUI() refills this. */
    function fillSortPicker(header) {
        const select = header && sortPickerFor(header);
        if (!select) return;
        const was = select.value;
        select.innerHTML = '';
        header.querySelectorAll('span[data-sort]').forEach(span => {
            if (span.style.display === 'none') return;
            const opt = document.createElement('option');
            opt.value = span.getAttribute('data-sort');
            opt.textContent = headerLabel(span);
            select.appendChild(opt);
        });
        if (was) select.value = was;
    }

    /** The same sort, in a shape a thumb can reach. Below 1024px both header rows
     *  are display:none — a comparison card has no columns to click — which left
     *  the page with no way to re-rank either table at all, and took the keyboard
     *  path with it, because display:none also drops those spans from the tab
     *  order. Measured at 390x844 before this: 15 sortable headings in the
     *  document, none of them hittable. Neither control decides anything itself;
     *  both hand the work to the heading's own click handler above, so the
     *  toggle-direction-if-same-column rule lives in exactly one place. */
    function bindSortPicker(header) {
        const select = sortPickerFor(header);
        if (!select) return;
        fillSortPicker(header);
        const activeHeading = () => header.querySelector('span[data-sort].sort-active');
        select.addEventListener('change', function() {
            const active = activeHeading();
            if (active && active.getAttribute('data-sort') === this.value) return;
            const span = header.querySelector('span[data-sort="' + this.value + '"]');
            if (span) span.click();
        });
        const flip = document.querySelector('button[data-sort-dir="' + header.id + '"]');
        if (flip) flip.addEventListener('click', function() {
            const active = activeHeading();
            if (active) active.click();
        });
    }

    function bindSortHeader(headerId, sort, noteId, onSorted) {
        const header = document.getElementById(headerId);
        if (!header) return;
        header.querySelectorAll('span[data-sort]').forEach(span => {
            span.addEventListener('click', function() {
                const key = this.getAttribute('data-sort');
                if (sort.key === key) {
                    sort.dir *= -1;
                } else {
                    sort.key = key;
                    sort.dir = TEXT_SORT_KEYS.indexOf(key) >= 0 ? 1 : -1;
                }
                markSorted(header, this, sort, noteId);
                onSorted();
            });
            span.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                    e.preventDefault();
                    this.click();
                }
            });
        });
        bindSortPicker(header);
        markSortActive(header, sort, noteId);
    }

    /** Stamp the heading the data is ACTUALLY sorted by, before any click. This used
     *  to read a `sort-active` the template typed by hand, which meant the highlight
     *  was a second copy of the default and could disagree with the sort silently.
     *  The script's own `sort` object is the only copy now. */
    function markSortActive(header, sort, noteId) {
        const span = header.querySelector('span[data-sort="' + sort.key + '"]');
        if (span) markSorted(header, span, sort, noteId);
    }

    function setupSort() {
        bindSortHeader('qc-table-header', currentSort, 'qc-sort-note', function() {
            currentPage = 0;
            applyFilters();
        });
        bindSortHeader('qc-candidates-header', candidatesSort, 'qc-candidates-sort-note', function() {
            candidatesPage = 0;
            renderCandidates(lastFilteredCandidates);
            renderCandidatesPagination(lastFilteredCandidates.length);
        });
    }

    // ========================================================================
    // CANDIDATES
    // ========================================================================

    function renderCandidates(candidates) {
        const body = document.getElementById('qc-candidates-body');
        if (!body) return;

        if (!candidates.length) {
            body.innerHTML = '<div class="qc-empty">No candidate towns match the current filters.</div>';
            return;
        }

        const sorted = [...candidates].sort(compareBySort(candidatesSort));

        const start = candidatesPage * PAGE_SIZE;
        const paged = sorted.slice(start, start + PAGE_SIZE);

        body.innerHTML = paged.map(t => {
            const pop = t.population ? t.population.toLocaleString() : '-';
            const overall = t.overall_score != null ? t.overall_score.toFixed(0) : '-';
            const stab = t.stability_score != null ? t.stability_score.toFixed(0) : '-';
            const dist = t.distance_to_metro_mi != null ? t.distance_to_metro_mi.toFixed(0) + 'mi' : '-';
            const county = t.county_name || t.county_fips || '-';
            const state = t.state || '-';
            return '<div class="qc-candidate-row" data-lat="' + escAttr(t.lat) + '" data-lon="' + escAttr(t.lon) + '"' +
                ' tabindex="0" role="button" aria-label="Show ' + escAttr(t.name) + ', ' + escAttr(state) + ' on the map">' +
                '<span class="qc-name">' + escHtml(t.name) + '</span>' +
                '<span style="color:var(--text-muted);">' + escHtml(state) + '</span>' +
                '<span style="color:var(--text-muted);text-align:right;">' + pop + '</span>' +
                '<span style="color:var(--text-subtle);font-size:0.65rem;">' + escHtml(county) + '</span>' +
                '<span class="qc-score ' + scoreClass(t.overall_score, true) + '">' + overall + '</span>' +
                '<span class="qc-score ' + scoreClass(t.stability_score, true) + '">' + stab + '</span>' +
                '<span class="qc-score ' + remotenessClass(t.distance_to_metro_mi) + '">' + dist + '</span>' +
                '</div>';
        }).join('');
        labelCells(body, 'qc-candidates-header');

        // Wire activation. Mouse and keyboard alike, the same as the county rows:
        // the row is role="button", so Enter and Space have to do what a click does.
        body.querySelectorAll('.qc-candidate-row').forEach(row => {
            row.addEventListener('click', function() { showCandidate(this); });
            row.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    showCandidate(this);
                }
            });
        });
    }

    // How many towns matched, out of how many there are. A bare match count reads as
    // the whole country, and an empty one reads as empty country — the reader cannot
    // tell a strict threshold from a place with no towns in it (F06). Both numbers,
    // always, and when the answer is none, the way back that keeps the area they chose.
    function renderCandidatesStatus(matched, stateAbbr) {
        const el = document.getElementById('qc-candidates-status');
        if (!el || !candidatesData) return;
        const inScope = stateAbbr
            ? candidatesData.filter(t => normState(t.state) === stateAbbr).length
            : candidatesData.length;
        const where = stateAbbr ? ' in ' + escHtml(stateAbbr) : ' in the export';
        const total = candidatesData.length.toLocaleString();

        if (matched > 0) {
            el.innerHTML = '<strong>' + matched.toLocaleString() + '</strong> of ' +
                inScope.toLocaleString() + ' towns' + where + ' match the current scores. ' +
                'All ' + total + ' are drawn on the map as context.';
            return;
        }
        el.innerHTML = '<strong>No towns match the current scores.</strong> ' +
            inScope.toLocaleString() + ' town' + (inScope === 1 ? ' is' : 's are') + ' still there' +
            where + ', drawn on the map — the scores rule them out, not the geography. ' +
            '<button type="button" id="qc-reset-scores" class="qc-reset-scores">' +
            'Relax the scores, keep ' + (stateAbbr ? escHtml(stateAbbr) : 'this view') + '</button>';
        const btn = document.getElementById('qc-reset-scores');
        if (btn) btn.addEventListener('click', relaxScores);
    }

    // Every score slider back to its floor, the area untouched. Undoing five sliders
    // by hand is how a reader loses the state they picked.
    function relaxScores() {
        [['qc-remoteness', 0], ['qc-stability', 0], ['qc-overall', 0],
            ['qc-affordability', 0], ['qc-sprawl', 100]].forEach(([id, value]) => {
            const el = document.getElementById(id);
            if (el) { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }
        });
        applyFilters();
    }

    // Flying to a town and saying nothing left the reader at a dot they had to find
    // again. Open the town's own marker popup, and land at FIELD_MIN_ZOOM rather than
    // the literal 8 this used to pass: 8 is one level BELOW the zoom the topo base
    // turns on at, so activating a town showed less ground detail than it needed.
    function showCandidate(row) {
        const lat = parseFloat(row.getAttribute('data-lat'));
        const lon = parseFloat(row.getAttribute('data-lon'));
        if (!map || isNaN(lat) || isNaN(lon)) return;
        flyToRM([lat, lon], FIELD_MIN_ZOOM, { duration: 0.8 });
        openCandidatePopup(lat, lon);
        var named = row.querySelector('.qc-name');
        showSky(named ? named.textContent : 'this town', lat, lon);
    }

    // The marker for these coordinates, if candidate markers are drawn. Leaflet has
    // no index by position, so this walks the one layer group that holds them.
    function openCandidatePopup(lat, lon) {
        if (!candidateLayer) return;
        candidateLayer.eachLayer(function(marker) {
            const ll = marker.getLatLng && marker.getLatLng();
            if (ll && Math.abs(ll.lat - lat) < 1e-6 && Math.abs(ll.lng - lon) < 1e-6) {
                marker.openPopup();
            }
        });
    }

    function renderCandidatesPagination(totalCount) {
        const container = document.getElementById('qc-candidates-pagination');
        if (!container) return;

        const totalPages = Math.ceil(totalCount / PAGE_SIZE);
        if (totalPages <= 1) { container.innerHTML = ''; return; }

        const prevDisabled = candidatesPage <= 0 ? ' disabled' : '';
        const nextDisabled = candidatesPage >= totalPages - 1 ? ' disabled' : '';

        container.innerHTML =
            '<button id="qc-cand-prev"' + prevDisabled + '>&laquo; Prev</button>' +
            '<span>Page ' + (candidatesPage + 1) + ' of ' + totalPages + '</span>' +
            '<button id="qc-cand-next"' + nextDisabled + '>Next &raquo;</button>';

        document.getElementById('qc-cand-prev').addEventListener('click', function() {
            if (candidatesPage > 0) {
                candidatesPage--;
                renderCandidates(lastFilteredCandidates);
                renderCandidatesPagination(totalCount);
            }
        });
        document.getElementById('qc-cand-next').addEventListener('click', function() {
            if (candidatesPage < totalPages - 1) {
                candidatesPage++;
                renderCandidates(lastFilteredCandidates);
                renderCandidatesPagination(totalCount);
            }
        });
    }

    // Every incorporated place in the export, drawn once and left alone. This layer
    // does not depend on the filters: it is the geography the filters are applied TO,
    // and while it did not exist a strict threshold and an empty country looked the
    // same on screen (F06). Muted and small, so a match still reads as the answer.
    function renderPlaceContext(places) {
        if (!map || placeLayer) return;
        placeLayer = L.layerGroup([], { pane: 'qc-places' }).addTo(map);
        for (const t of places) {
            if (t.lat == null || t.lon == null) continue;
            L.circleMarker([t.lat, t.lon], {
                pane: 'qc-places',
                // 0.65, not 0.45: at 0.45 this slate over the near-black ground came out
                // around #4a505a, which reads as noise rather than as a town. Still well
                // below the amber a match is drawn in.
                radius: 2,
                fillColor: '#94a3b8',
                fillOpacity: 0.65,
                color: '#94a3b8',
                weight: 0,
                opacity: 0.65,
                interactive: false,
            }).addTo(placeLayer);
        }
    }

    // ------------------------------------------------------------------
    // Place labels (audit F05)
    //
    // Every town was on the map and none of them was named (and, until A1 gave
    // the base tiles every zoom, there was no basemap below zoom 9 either), so
    // central Wisconsin read as a scatter of identical grey dots. Names are geography, so they come from the full export rather than
    // from the filter result -- a state that matches nothing still gets its towns
    // named, which is exactly when a reader needs them.
    //
    // Decluttering is one greedy pass in screen space, largest town first: a name
    // is placed only where its box clears every box already placed. That gives the
    // zoom hierarchy for free -- zoom out and the same pass keeps the big towns
    // and drops the small ones, with no second clustering path to keep in step.
    // ------------------------------------------------------------------

    /** Below this the country is a shape, not a place list, and every label would
     *  be a collision. */
    var LABEL_MIN_ZOOM = 4;
    /** Cheap enough to run on every moveend; past this the screen is full anyway. */
    var LABEL_MAX = 70;
    /** Clearance kept between two labels' plates, in pixels, on top of the box each
     *  one measures to. Deliberately generous: a label that merely LOOKS crowded is
     *  as unreadable as one that overlaps. */
    var LABEL_PAD_X = 4;
    var LABEL_PAD_Y = 3;

    /** The Census class word a town is drawn without: "Sylva", not "Sylva town". The
     *  same list as Q/name-labels.js stripCensusSuffix (a module this classic script
     *  cannot import), case-sensitive on purpose so "Carson City" keeps its own name,
     *  longest first so "city and borough" goes whole. */
    var CENSUS_CLASS_WORD = /\s(city and borough|municipality|borough|village|town|city|CDP)$/;
    function displayName(name) {
        var s = String(name || '');
        var bare = s.replace(CENSUS_CLASS_WORD, '');
        return bare || s;
    }

    /** Measuring what the CSS draws. A label's box is reserved BEFORE it is drawn, so
     *  it is measured from an empty probe that carries the label's own rules (same
     *  selectors in quiet-corners.css, the --qc-label-px size property included) --
     *  the font string, plate padding and line height the browser resolved, never a
     *  number guessed here -- through a canvas for the text width. One probe per tier,
     *  inside the map container where the size property is set. */
    var labelProbes = {};
    var labelCtx = null;
    function labelMetrics(nav) {
        var key = nav ? 'nav' : 'town';
        var host = map.getContainer();
        var el = labelProbes[key];
        if (!el || el.parentNode !== host) {
            el = document.createElement('span');
            el.className = 'qc-place-label-probe' + (nav ? ' qc-place-label-probe--nav' : '');
            el.setAttribute('aria-hidden', 'true');
            host.appendChild(el);
            labelProbes[key] = el;
        }
        var cs = getComputedStyle(el);
        var fontPx = parseFloat(cs.fontSize) || 14;
        return {
            font: cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily,
            letter: parseFloat(cs.letterSpacing) || 0,
            padX: (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0),
            h: (parseFloat(cs.lineHeight) || fontPx * 1.2)
                + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0),
        };
    }
    function labelWidth(text, m) {
        if (!labelCtx) labelCtx = document.createElement('canvas').getContext('2d');
        labelCtx.font = m.font;
        return labelCtx.measureText(text).width + m.letter * text.length + m.padX;
    }

    /** Orientation is a frame, not the content: this dashboard is about the towns,
     *  and a national view that spends all 70 slots on big cities answers one audit
     *  finding by erasing the layer of another. */
    var NAV_LABEL_MAX = 24;
    /** A regional place is 100K-250K. At national zoom the majors alone carry the
     *  frame; below that a hundred mid-sized cities is the crowding, not the fix. */
    var NAV_REGIONAL_MIN_ZOOM = 6;

    /** Per-state place shards (places-index.json + places-<ST>.json, one file per state
     *  whose bbox the view reaches). Every Census place with coordinates, so a mid-size
     *  place that is in neither candidates.json (1K-3K, rural counties) nor
     *  navigation-places.json (100K+) is still lettered. Lazy: no state shard is requested
     *  below NAV_REGIONAL_MIN_ZOOM, and a state is requested once, the first time the view reaches
     *  it. A failed request draws nothing for this tier and leaves the others drawn. Shard
     *  columns are named by each file's own `fields`, so the client never hard-codes an index. */
    var placeIndex = null;
    var placeIndexState = 'idle';
    var placeShards = {};
    /** places-national.json: the head of the same ranking (W1's PLACE_NATIONAL_HEAD rows,
     *  state per row), fetched once from the first label zoom. Without it the town ladder
     *  below NAV_REGIONAL_MIN_ZOOM was candidates.json alone (scored 1K-3K towns), so a
     *  national view lettered SMALLER places than a regional one once the shards landed. */
    var placeNational = null;
    var placeNationalState = 'idle';
    function shardRows(shard) {
        if (!shard || !Array.isArray(shard.fields) || !Array.isArray(shard.places)) return [];
        var col = {};
        shard.fields.forEach(function(f, i) { col[f] = i; });
        // The pipeline's column is `display_name` (scripts/test_data_contract.py SHARD_FIELDS); `name`
        // is accepted too so a hand-made fixture still reads.
        var nameCol = col.display_name != null ? col.display_name : col.name;
        if (col.geoid == null || nameCol == null || col.lat == null || col.lon == null) return [];
        return shard.places.map(function(r) {
            return { geoid: r[col.geoid], name: r[nameCol], lat: r[col.lat], lon: r[col.lon],
                population: col.population == null ? null : r[col.population],
                // A state shard names its state once; the national head names it per row.
                state: col.state != null ? r[col.state] : shard.state };
        });
    }
    function bboxMeets(bb, bounds) {
        return Array.isArray(bb) && bb.length === 4
            && bb[0] <= bounds.getEast() && bb[2] >= bounds.getWest()
            && bb[1] <= bounds.getNorth() && bb[3] >= bounds.getSouth();
    }
    function ensurePlaceShards() {
        if (!map || map.getZoom() < LABEL_MIN_ZOOM) return;
        if (placeNationalState === 'idle') {
            placeNationalState = 'loading';
            fetchJSON('places-national.json').then(function(head) {
                placeNational = shardRows(head);
                placeNationalState = placeNational.length ? 'ready' : 'failed';
                renderPlaceLabels();
            });
        }
        if (map.getZoom() < Math.max(LABEL_MIN_ZOOM, NAV_REGIONAL_MIN_ZOOM)) return;
        if (placeIndexState === 'idle') {
            placeIndexState = 'loading';
            fetchJSON('places-index.json').then(function(idx) {
                placeIndex = idx && typeof idx === 'object' ? idx : null;
                placeIndexState = placeIndex ? 'ready' : 'failed';
                ensurePlaceShards();
            });
            return;
        }
        if (placeIndexState !== 'ready') return;
        var bounds = map.getBounds();
        Object.keys(placeIndex).forEach(function(st) {
            if (placeShards[st] !== undefined || !bboxMeets(placeIndex[st].bbox, bounds)) return;
            placeShards[st] = 'loading';
            fetchJSON('places-' + st + '.json').then(function(shard) {
                placeShards[st] = shardRows(shard);
                renderPlaceLabels();
            });
        });
    }

    /** One list, one greedy pass. Orientation places (major, then regional) come first.
     *  Then every town, from every source, in ONE population-sorted run: candidates.json
     *  rows (tier 'town') and shard places (tier 'local') are ranked by the same number with
     *  no population constant here, so a 4K town outranks a 1.2K one whichever file it came
     *  from. A shard place already in candidates.json or navigation-places.json (same GEOID)
     *  is dropped. */
    function labelCandidates(bounds, zoom) {
        var out = [];
        var seen = {};
        if (navPlacesData) {
            for (var n = 0; n < navPlacesData.length; n++) {
                var np = navPlacesData[n];
                if (np.geoid != null) seen[np.geoid] = true;
                if (np.lat == null || np.lon == null) continue;
                if (np.tier !== 'major' && zoom < NAV_REGIONAL_MIN_ZOOM) continue;
                if (!bounds.contains([np.lat, np.lon])) continue;
                out.push({
                    lat: np.lat, lon: np.lon,
                    // display_name is the curated one: "New York", not "New York city".
                    text: np.display_name || np.name, tier: np.tier, population: 0,
                    // Carried through to window.qcTownLabels below (N2's dedupe key), not
                    // used for placement itself.
                    state: np.state,
                });
            }
            // Major before regional, and the pipeline already sorted each band
            // largest first, so this stable sort is the whole hierarchy.
            out.sort(function(a, b) {
                return (a.tier === 'major' ? 0 : 1) - (b.tier === 'major' ? 0 : 1);
            });
        }
        var towns = [];
        // Below the shard zoom the loaded rungs of the ladder are the national head. A
        // candidates.json row ranks where its estimate falls; one under the head's last
        // row is a rung this view has not loaded yet, so it waits for its state's shard
        // like every other place that size (else a 1K scored town letters the rural room
        // the head leaves empty at zoom 4 while the 5K-25K towns around it cannot). No
        // constant here: the floor is the head's own tail, and no head means no floor.
        var floor = 0;
        if (placeNational && placeNational.length
                && zoom < Math.max(LABEL_MIN_ZOOM, NAV_REGIONAL_MIN_ZOOM)) {
            floor = placeNational[placeNational.length - 1].population || 0;
        }
        if (candidatesData) {
            for (var i = 0; i < candidatesData.length; i++) {
                var t = candidatesData[i];
                seen[t.fips] = true;
                if (t.lat == null || t.lon == null) continue;
                if ((t.population || 0) < floor) continue;
                if (!bounds.contains([t.lat, t.lon])) continue;
                // Drawn without the Census class word ("Sylva", not "Sylva town"); the
                // raw name rides along as `raw`, N2's dedupe key (publishTownLabels).
                towns.push({ lat: t.lat, lon: t.lon, text: displayName(t.name), raw: t.name, tier: 'town',
                    population: t.population || 0,
                    // Same reason as the nav branch above: candidates.json's raw Census
                    // name plus its state is N2's dedupe key.
                    state: t.state });
            }
        }
        if (placeNational) {
            for (var h = 0; h < placeNational.length; h++) {
                var hp = placeNational[h];
                if (seen[hp.geoid]) continue;
                seen[hp.geoid] = true;
                if (!bounds.contains([hp.lat, hp.lon])) continue;
                towns.push({ lat: hp.lat, lon: hp.lon, text: hp.name, tier: 'local',
                    population: hp.population || 0, state: hp.state });
            }
        }
        if (zoom >= Math.max(LABEL_MIN_ZOOM, NAV_REGIONAL_MIN_ZOOM)) {
            Object.keys(placeShards).forEach(function(st) {
                var rows = placeShards[st];
                if (!Array.isArray(rows)) return;
                for (var j = 0; j < rows.length; j++) {
                    var r = rows[j];
                    if (seen[r.geoid] || r.lat == null || r.lon == null) continue;
                    if (!bounds.contains([r.lat, r.lon])) continue;
                    // The shard's name is already the curated display name.
                    towns.push({ lat: r.lat, lon: r.lon, text: r.name, tier: 'local',
                        population: r.population || 0, state: r.state });
                }
            });
        }
        // Largest first: the greedy pass below keeps whoever it reaches first, so the
        // sort IS the hierarchy. Stable, so on a tie the scored candidate goes first.
        towns.sort(function(a, b) { return b.population - a.population; });
        return out.concat(towns);
    }

    /** A town-weight label (candidates.json or a shard), as against orientation. */
    function isTownTier(tier) { return tier === 'town' || tier === 'local'; }

    /** N2's dedupe (Q/name-labels.js dedupeAgainstTownLabels) reads this global for
     *  the GNIS "Named places & landmarks" layer: {name, state} for every town/nav
     *  label THIS function actually drew last pass, so a town this system dropped
     *  to its own cap or collision rules stays fair game for GNIS instead of
     *  silently vanishing from both. Publishing it is only half the fix -- a
     *  stale read is still possible unless whoever draws GNIS names re-renders
     *  after this list changes, which is why the dispatch below exists (Q/main.js
     *  listens for it). */
    function publishTownLabels(labels) {
        window.qcTownLabels = labels;
        document.dispatchEvent(new CustomEvent('qc:town-labels-changed'));
    }

    function renderPlaceLabels() {
        if (!map) return;
        if (!labelLayer) labelLayer = L.layerGroup([], { pane: 'qc-labels' }).addTo(map);
        labelLayer.clearLayers();
        ensurePlaceShards();
        if ((!candidatesData && !navPlacesData && !Object.keys(placeShards).length)
            || map.getZoom() < LABEL_MIN_ZOOM) {
            publishTownLabels([]);
            return;
        }

        var bounds = map.getBounds();
        var here = labelCandidates(bounds, map.getZoom());

        var taken = [];
        var navPlaced = 0;
        var drawn = [];
        var townMetrics = labelMetrics(false);
        var navMetrics = labelMetrics(true);
        for (var j = 0; j < here.length && taken.length < LABEL_MAX; j++) {
            var place = here[j];
            if (!isTownTier(place.tier) && navPlaced >= NAV_LABEL_MAX) continue;
            // Not `pt`: scripts/test_data_contract.py reserves that name for a
            // geo.json record and would demand this map point carry its fields.
            var at = map.latLngToContainerPoint([place.lat, place.lon]);
            // The plate's measured box (see labelMetrics), plus clearance, from the
            // dot's 5px offset.
            var metrics = isTownTier(place.tier) ? townMetrics : navMetrics;
            var w = labelWidth(place.text, metrics) + LABEL_PAD_X;
            var h = metrics.h + LABEL_PAD_Y;
            var box = { x: at.x + 5, y: at.y - h / 2, w: w, h: h };
            var clash = false;
            for (var k = 0; k < taken.length; k++) {
                var o = taken[k];
                if (box.x < o.x + o.w && o.x < box.x + box.w
                    && box.y < o.y + o.h && o.y < box.y + box.h) { clash = true; break; }
            }
            if (clash) continue;
            taken.push(box);
            if (!isTownTier(place.tier)) navPlaced++;
            drawn.push({ name: place.raw || place.text, state: place.state });
            var cls = isTownTier(place.tier) ? 'qc-place-label'
                : 'qc-place-label qc-place-label--nav';
            L.marker([place.lat, place.lon], {
                pane: 'qc-labels',
                interactive: false,
                keyboard: false,
                icon: L.divIcon({
                    className: 'qc-place-label-wrap',
                    iconSize: null,
                    html: '<span class="' + cls + '" data-tier="' + place.tier
                        + '" data-pop="' + place.population + '">'
                        + escHtml(place.text) + '</span>',
                }),
            }).addTo(labelLayer);
        }
        publishTownLabels(drawn);
    }

    /** How close the map gets to a place you asked for by name. Below the topo
     *  threshold there is no base map to arrive onto, so the answer to "where is
     *  Viroqua" would be another field of grey dots. */
    var finderClose = null;
    var finderRefresh = null;
    var FIND_ZOOM = 11;
    var FIND_MAX_HITS = 8;
    // A street-range point is worth a street-level view; a town is not.
    var ADDRESS_ZOOM = 14;

    /** The Census legal descriptor. It is part of the official name and stays in the
     *  result row, but nobody types it, so matching has to see past it: without this
     *  "Sylva" is not an exact match for the record "Sylva town" and loses its own
     *  search to Sylvania. */
    var LEGAL_SUFFIX = /\s+(city|town|village|borough|CDP|municipality|township|plantation)$/i;
    function bareName(name) { return String(name || '').replace(LEGAL_SUFFIX, ''); }

    /** "Ashland, IL" is a name and a state, not a 12-character name. Ashland is in
     *  the export twice and the state is the only thing separating them, so the part
     *  after the last comma is read as a state whenever it names one. A comma
     *  followed by something that is not a state stays part of the name. */
    function parseQuery(term) {
        var raw = String(term || '').trim();
        var cut = raw.lastIndexOf(',');
        if (cut > 0) {
            var tail = normState(raw.slice(cut + 1));
            if (isStateCode(tail)) {
                return { name: raw.slice(0, cut).trim().toLowerCase(), state: tail };
            }
        }
        return { name: raw.toLowerCase(), state: '' };
    }

    /** Search runs over the FULL export, never over the filtered result. A town the
     *  ranking rejected is still a town, and "why isn't this one a match?" is one of
     *  the few questions this map exists to answer.
     *
     *  Three tiers, not two: the town you named, then the names that begin with it,
     *  then the names that merely contain it. Prefix-only ranking put every longer
     *  name ahead of the exact one. The whole export is scanned rather than stopping
     *  at the first full bucket, because an exact match sitting late in the file
     *  cannot be found by a loop that quits early. */
    function findPlaces(term) {
        var q = parseQuery(term);
        if (q.name.length < 2 || !candidatesData) return [];
        var exact = [], starts = [], contains = [];
        for (var i = 0; i < candidatesData.length; i++) {
            var t = candidatesData[i];
            if (t.lat == null || t.lon == null) continue;
            if (q.state && normState(t.state) !== q.state) continue;
            var full = (t.name || '').toLowerCase();
            var bare = bareName(t.name).toLowerCase();
            if (bare === q.name || full === q.name) exact.push(t);
            else if (bare.indexOf(q.name) === 0) starts.push(t);
            else if (full.indexOf(q.name) > 0) contains.push(t);
        }
        return exact.concat(starts, contains).slice(0, FIND_MAX_HITS);
    }

    /** Two bare numbers, latitude first, in decimal degrees. A reader does not always
     *  arrive with a name -- a pair off a GPS, a trailhead listing or another map is
     *  the whole address they have, and before this the only way to use it was to
     *  guess which town sits nearest. The separator is whatever the pair was copied
     *  with, so a comma, a comma and a space, or just a space all read the same.
     *  Degrees/minutes/seconds is a different parse and is not handled here. */
    var COORD_PAIR = /^\s*([+-]?\d+(?:\.\d+)?)\s*(?:,\s*|\s+)([+-]?\d+(?:\.\d+)?)\s*$/;

    function parseCoordinates(term) {
        var m = COORD_PAIR.exec(String(term || ''));
        if (!m) return null;
        var lat = parseFloat(m[1]), lon = parseFloat(m[2]);
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
        return { lat: lat, lon: lon };
    }

    /** Why a pair of numbers is not a place, when it is not. Out of range almost
     *  always means the pair was typed longitude first, so the message names the
     *  order as well as the bound -- "no town matching 95, -83" sends a reader off
     *  looking for a town instead. */
    function coordinateRangeMessage(term) {
        var m = COORD_PAIR.exec(String(term || ''));
        if (!m) return '';
        var lat = parseFloat(m[1]), lon = parseFloat(m[2]);
        var wrong = [];
        if (lat < -90 || lat > 90) wrong.push('latitude ' + m[1] + ' is outside -90 to 90');
        if (lon < -180 || lon > 180) wrong.push('longitude ' + m[2] + ' is outside -180 to 180');
        if (!wrong.length) return '';
        return 'Coordinates are read latitude first: ' + wrong.join(', and ') + '.';
    }

    /** What an empty result should say. A blank box reads as a broken search; it has
     *  to say that the export was read and holds nothing matching. The two cases are
     *  worth separating because only one of them is the reader's typo. */
    function emptyFinderMessage(term) {
        var range = coordinateRangeMessage(term);
        if (range) return range;
        // A street address is not a town that is missing from the list: it is looked
        // up when the reader presses Search, and saying so is true whether or not the
        // list has loaded yet, so this comes before the loading and failure answers.
        if (looksLikeStreetAddress(term)) return ADDRESS_PROMPT_MESSAGE;
        var q = parseQuery(term);
        if (q.name.length < 2) return '';
        // candidates.json is ~1.8MB and lands after the first render, so for the
        // first half-second of the page EVERY name misses. "Is in this list"
        // asserts the list was read; until it has been that sentence is false, and
        // it reads exactly like the reader's own typo.
        if (candidatesLoadFailed) return 'The town list failed to load. Try reloading the page.';
        if (!candidatesData) return 'Still loading the town list\u2026';
        return q.state
            ? 'No town named "' + q.name + '" in ' + q.state + ' is in this list.'
            : 'No town matching "' + q.name + '" is in this list.';
    }

    /** Which suggestion the arrow keys are on. A combobox does not move focus into
     *  its list -- focus stays in the input and `aria-activedescendant` points at the
     *  active row -- so the index has to live somewhere the keydown handler and the
     *  renderer can both reach. -1 means the list is showing and nothing is chosen,
     *  which is where every fresh query starts. */
    var finderActive = -1;

    function finderOptions(list) { return list.querySelectorAll('[role="option"]'); }

    function setFinderActive(box, list, i) {
        var opts = finderOptions(list);
        if (!opts.length) { clearFinderActive(box); return; }
        // Wrapping, so Up from the top reaches the last suggestion rather than
        // stalling: the list is at most eight rows and both ends are one key away.
        finderActive = ((i % opts.length) + opts.length) % opts.length;
        for (var k = 0; k < opts.length; k++) {
            var on = k === finderActive;
            opts[k].setAttribute('aria-selected', on ? 'true' : 'false');
            opts[k].classList.toggle('is-active', on);
        }
        box.setAttribute('aria-activedescendant', opts[finderActive].id);
        opts[finderActive].scrollIntoView({ block: 'nearest' });
    }

    /** One suggestion row. Shared so a coordinate pair and a town are the same
     *  button: the keyboard, the click handler and the listbox roles all keep
     *  working without knowing which kind of answer they are pointed at. The row
     *  index is what `aria-activedescendant` needs an id for, so the builder takes
     *  it rather than leaving the caller to stamp one on afterwards. */
    function finderOption(label, lat, lon, optionId) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'qc-finder-hit';
        row.id = optionId;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', 'false');
        // Not in the tab order: the arrow keys are the way through a listbox, and
        // leaving eight buttons tabbable makes a second, contradictory one.
        row.tabIndex = -1;
        row.textContent = label;
        row.addEventListener('click', function() {
            map.setView([lat, lon], FIND_ZOOM);
            showSky(label, lat, lon);
            if (finderClose) finderClose();
        });
        return row;
    }

    /** One labelled group of rows. A listbox's only valid children are option
     *  and group (axe aria-required-children, same rule the miss sentence was
     *  moved out for), so the heading lives on the wrapper's aria-label rather
     *  than as a visible child node -- a <div> of text in here would be a third,
     *  invalid child role. */
    function finderGroup(label, rows) {
        var wrap = document.createElement('div');
        wrap.setAttribute('role', 'group');
        wrap.setAttribute('aria-label', label);
        rows.forEach(function(row) { wrap.appendChild(row); });
        return wrap;
    }

    /** An activedescendant left pointing at a row that no longer exists is a dangling
     *  reference: the reader is told about a suggestion that is not in the list. */
    function clearFinderActive(box) {
        finderActive = -1;
        box.removeAttribute('aria-activedescendant');
    }

    /** The sentence a sighted reader sees. Hidden rather than emptied, so the
     *  box does not keep a blank line where a message used to be. */
    function showFinderNote(text) {
        var note = document.getElementById('qc-finder-note');
        if (!note) return;
        note.textContent = text;
        note.hidden = !text;
    }

    /** What a screen reader is handed. A miss is announced in the same words the
     *  screen shows -- two different sentences for one result is worse than
     *  silence. A hit announces the COUNT, because the suggestions themselves are
     *  reachable with the arrow keys but how many there are is not: the listbox
     *  never takes focus, and aria-activedescendant says which row is active, not
     *  how long the list is.
     *
     *  Writing the same string twice is deliberately a no-op. A live region
     *  re-announces on every mutation, so re-setting identical text on each
     *  keystroke would make the reader hear the same sentence repeatedly. */
    function announceFinder(empty, count) {
        // A name search in progress or answered (setNameStatus) owns the region
        // until the reader retypes: clearNameSearchState runs before every
        // re-render, so the keystroke announcer never talks over a search answer.
        if (nameStatusText) return;
        var region = document.getElementById('qc-finder-status');
        if (!region) return;
        var text = empty ? empty
            : count === 1 ? '1 suggestion'
                : count > 1 ? count + ' suggestions'
                    : '';
        if (region.textContent !== text) region.textContent = text;
    }

    // B2: qualified GNIS name search (summits, gaps, ridges, populated places --
    // layers 3/5/6/7 via source-terrain-names.js). Explicit-submission only: it
    // never runs on a keystroke, so it needs its own state, separate from the
    // local town match above, that a keystroke does not reach.
    var NAME_SEARCH_LIMIT = 20;
    var nameSearchGuard = createSearchGuard();
    var nameSearchController = null;
    var lastNameHits = [];
    // QQA-04b: a street-address lookup shares the name search's guard, controller and
    // note, so whichever search the reader started last is the only one that answers.
    // `addressStatus` is 'idle' until Search is pressed on an address.
    var lastAddressHits = [];
    var addressStatus = 'idle';

    /** Same comma/state split as parseQuery, but case-preserving: the network
     *  layer (buildNameSearchUrl) does its own uppercasing for the SQL literal,
     *  and lower-casing here first would just be undone there. */
    function parseNameSearchQuery(term) {
        var raw = String(term || '').trim();
        var cut = raw.lastIndexOf(',');
        if (cut > 0) {
            var tail = normState(raw.slice(cut + 1));
            if (isStateCode(tail)) return { name: raw.slice(0, cut).trim(), state: tail };
        }
        return { name: raw, state: '' };
    }

    var KIND_LABELS = {
        place: 'Populated place', summit: 'Summit', gap: 'Gap', ridge: 'Ridge/range',
        'water-feature': 'Water feature', 'other-land': 'Landform', 'other-water': 'Water feature',
        'stream-mouth': 'Stream',
    };
    function kindLabel(kind) { return KIND_LABELS[kind] || 'Named feature'; }

    /** The exact strings the brief pins down (task item 3) -- never "no results"
     *  for the capped case, so a reader is told to narrow the search rather than
     *  reading it as an outright miss. */
    function nameSearchStatusText(status, count) {
        if (status === 'searching') return 'searching…';
        if (status === 'ready') return count === 0 ? 'No names matched' : count + ' names';
        if (status === 'capped') return 'Refine the name or state';
        if (status === 'error') return 'Name search failed — try again';
        if (status === 'timeout') return 'Name search timed out';
        return '';
    }

    /** The text the name search currently has in force ('' when idle). Read by
     *  announceFinder so the shared live region is not overwritten mid-search. */
    var nameStatusText = '';

    function setNameStatus(status, count) {
        showNameStatusText(nameSearchStatusText(status, count));
    }

    function setAddressStatus(status, count) {
        addressStatus = status;
        showNameStatusText(addressStatusText(status, count));
    }

    function showNameStatusText(text) {
        nameStatusText = text;
        var note = document.getElementById('qc-name-note');
        if (note) { note.textContent = text; note.hidden = !text; }
        var region = document.getElementById('qc-finder-status');
        if (region && region.textContent !== text) region.textContent = text;
    }

    /** Retyping, closing the box, or a fresh submission all invalidate whatever
     *  the last one answered: bump the guard so a late response is dropped
     *  (createSearchGuard, source-terrain-names.js), abort the in-flight request
     *  so it does not update a query that has already moved on, and clear the
     *  results and status so nothing stale is left on screen. */
    function clearNameSearchState() {
        nameSearchGuard.bump();
        if (nameSearchController) { nameSearchController.abort(); nameSearchController = null; }
        lastNameHits = [];
        lastAddressHits = [];
        addressStatus = 'idle';
        setNameStatus('idle');
    }

    function handleNameSearchResult(result, box, list) {
        if (result.status === 'empty' || result.status === 'too-long' || result.status === 'aborted') return;
        if (result.status === 'error') { setNameStatus('error'); lastNameHits = []; renderFinderResults(box, list); return; }
        if (result.status === 'timeout') { setNameStatus('timeout'); lastNameHits = []; renderFinderResults(box, list); return; }
        lastNameHits = result.features || [];
        setNameStatus(result.capped ? 'capped' : 'ready', lastNameHits.length);
        renderFinderResults(box, list);
    }

    /** Latest wins: a new search bumps the guard and aborts the request before it, so
     *  an older answer is cancelled on the wire and, if it arrives anyway, dropped. The
     *  typed text goes into the request and nowhere else -- not the status, the
     *  fragment, storage or the title. */
    function submitAddressSearch(box, list) {
        var token = nameSearchGuard.bump();
        if (nameSearchController) nameSearchController.abort();
        nameSearchController = new AbortController();
        lastNameHits = [];
        lastAddressHits = [];
        setAddressStatus('searching');
        renderFinderResults(box, list);
        geocodeAddress(box.value, { signal: nameSearchController.signal }).then(function(result) {
            if (!nameSearchGuard.isCurrent(token) || result.status === 'aborted') return;
            lastAddressHits = result.status === 'ready' ? result.results : [];
            setAddressStatus(result.status, lastAddressHits.length);
            renderFinderResults(box, list);
        });
    }

    function submitNameSearch(box, list) {
        var q = parseNameSearchQuery(box.value);
        if (!q.name) return;
        // Text that is shaped like a street address (a house number and a street
        // word, a ZIP, a PO box) is not a place name: the GNIS service can only answer
        // it with "no names matched", which tells the reader their address is a missing
        // named place, and it would put the address on the wire for nothing. It goes to
        // the address lookup instead (QQA-04b), and only now, on an explicit Search -- a
        // keystroke never sends it. A name the town list already holds wins first,
        // though -- then the list on screen is the answer and nothing is sent. Names that
        // merely look like addresses ("Lake Unit 4", "Highway 441") are not this
        // shape (looksLikeStreetAddress) and are searched below like any other name.
        if (!parseCoordinates(box.value) && looksLikeStreetAddress(box.value)) {
            if (findPlaces(box.value).length) {
                nameSearchGuard.bump();
                if (nameSearchController) { nameSearchController.abort(); nameSearchController = null; }
                lastNameHits = [];
                lastAddressHits = [];
                addressStatus = 'idle';
                setNameStatus('idle');
            } else {
                submitAddressSearch(box, list);
            }
            return;
        }
        lastAddressHits = [];
        addressStatus = 'idle';
        var token = nameSearchGuard.bump();
        if (nameSearchController) nameSearchController.abort();
        nameSearchController = new AbortController();
        setNameStatus('searching');
        searchByName(q.name, {
            state: q.state || null,
            limit: NAME_SEARCH_LIMIT,
            signal: nameSearchController.signal,
        }).then(function(result) {
            if (!nameSearchGuard.isCurrent(token)) return;
            handleNameSearchResult(result, box, list);
        });
    }

    /** Moves the map to a view sized for the KIND of feature (zoomForKind,
     *  source-terrain-names.js) -- a summit or a gap is a point worth zooming
     *  close on, a ridge or a populated place reads better wider, z12 is the
     *  fallback for anything else. Deliberately does not touch
     *  `currentCenterSource`: this is a chosen named feature, not a device
     *  location fix, so Share view's "include my location" gate must stay off
     *  (brief item 4 -- must not set centerSource: 'location').
     *
     *  QUX-05c: the one details card (name, kind, county/state, USGS GNIS
     *  source, coordinates, the one-published-point disclaimer, Copy
     *  coordinates / Share place) is drawn by main.js's
     *  drawSelectedSearchFeature -- the SAME Leaflet popup a map-pin click
     *  opens -- through the window.qcSelectName bridge, not a bespoke DOM this
     *  file used to build for itself.
     *
     *  The card opens first and the map moves after, so the move can be aimed
     *  where the open card lands clear (clearCentre). showSky runs before the
     *  aim too: it puts the name in the Conditions bar, and on a desktop a long
     *  name can wrap that bar onto a second line the card has to clear. */
    function selectNameHit(hit) {
        var zoom = zoomForKind(hit.kind);
        if (typeof window.qcSelectName === 'function') window.qcSelectName(hit);
        showSky(hit.name, hit.anchor[0], hit.anchor[1]);
        flyToRM(clearCentre(hit.anchor, zoom), zoom, { duration: 0.8 });
    }

    /** Where to centre the map, at `zoom`, so the name card open on `anchor`
     *  lands where it can be read: clear of the panels and controls painted over
     *  the map if it can be, its name line clear if it cannot (clearSpot,
     *  card-clearance.js). Before this, the anchor went to the map's centre and
     *  the card above it landed under the Explore and Conditions bars at
     *  1280x900, and above the top of the map at 390x844.
     *
     *  Everything is measured in client pixels. The part of the map on screen
     *  is the map clipped by its container (#qc-map-container hides overflow)
     *  and by the viewport. The card may be opened again on the other kind of
     *  marker once the map lands -- a name label is a divIcon with no
     *  popupAnchor, a pin is the default marker, whose popupAnchor lifts the
     *  card -- so the box cleared is both placements together. With no card
     *  open, or no map on screen, the anchor itself, as before.
     *
     *  What is over the map is measured once, here, at the pick: a panel that
     *  grows after the map lands (an open Conditions panel filling in tonight's
     *  sky, say) is not measured again. */
    function clearCentre(anchor, zoom) {
        var mapEl = map.getContainer();
        var popup = mapEl.querySelector('.leaflet-popup-pane .leaflet-popup');
        var name = popup && popup.querySelector('.qcm-site-card-name');
        if (!name) return anchor;
        var box = function(el) { var r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
        var by = function(r, x, y) { return { left: r.left + x, top: r.top + y, right: r.right + x, bottom: r.bottom + y }; };
        var union = function(p, q) {
            return { left: Math.min(p.left, q.left), top: Math.min(p.top, q.top), right: Math.max(p.right, q.right), bottom: Math.max(p.bottom, q.bottom) };
        };
        var own = mapEl.getBoundingClientRect();
        var origin = L.point(own.left + mapEl.clientLeft, own.top + mapEl.clientTop);
        var a = map.latLngToContainerPoint(anchor).add(origin);
        var near = function(el) { return by(box(el), -a.x, -a.y); };
        // The card is the popup and the tip that hangs below it. On the default
        // marker the whole of it sits above the anchor; the other placement is
        // the same card moved back by that marker's popupAnchor.
        var tip = popup.querySelector('.leaflet-popup-tip-container');
        var card = tip ? union(near(popup), near(tip)) : near(popup);
        var lift = L.Icon.Default.prototype.options.popupAnchor;
        var dx = card.bottom < 0 ? -lift[0] : lift[0], dy = card.bottom < 0 ? -lift[1] : lift[1];
        var head = union(near(name), by(near(name), dx, dy));
        // The anchor too, so the place itself stays on the map.
        card = union(union(card, by(card, dx, dy)), { left: 0, top: 0, right: 0, bottom: 0 });

        var holder = mapEl.parentNode, sheet = document.getElementById('qc-sheet');
        var shown = holder.getBoundingClientRect(), page = document.documentElement;
        var view = {
            left: Math.max(own.left, shown.left, 0), top: Math.max(own.top, shown.top, 0),
            right: Math.min(own.right, shown.right, page.clientWidth), bottom: Math.min(own.bottom, shown.bottom, page.clientHeight),
        };
        if (!(view.right > view.left && view.bottom > view.top)) return anchor;
        var over = [].slice.call(holder.children).filter(function(el) { return el !== mapEl && el !== sheet; })
            .concat(sheet ? [].slice.call(sheet.children) : [])
            .concat([].slice.call(mapEl.querySelectorAll('.leaflet-control-container .leaflet-control')));
        var obstacles = over.filter(function(el) { return getComputedStyle(el).visibility !== 'hidden'; }).map(box);

        var size = map.getSize();
        var spot = clearSpot({ view: view, card: card, head: head, obstacles: obstacles, at: { x: origin.x + size.x / 2, y: origin.y + size.y / 2 } });
        return map.unproject(map.project(anchor, zoom).subtract(L.point(spot.x - origin.x, spot.y - origin.y)).add(size.divideBy(2)), zoom);
    }
    // QUX-09a: "Show" on a saved place is the same select-then-move the name
    // finder already does above -- exposed under its own name so main.js's
    // saved-places-panel.js wiring never has to know this file's internal
    // selectNameHit.
    window.qcShowSavedPlace = selectNameHit;

    // QUX-09b: "Before you go" on a name card or a saved-places row calls in
    // here two ways. `ask:true` (the action itself) runs the real showSky ask
    // and moves focus to the new header, opening the Conditions panel first
    // (QUX-03b-ii): the header lives inside it, and a shut <details> would
    // leave focus on a hidden element. Setting .open fires the same toggle
    // wirePanels() listens for, so panelState and the one-at-a-time rule stay
    // in step exactly as for a summary click. `ask:false` (a card just opening) asks nothing and costs
    // no request: if a DIFFERENT place is already picked, it only corrects the
    // header so a reader never reads that place's cards as this one's; a
    // matching or absent `picked` writes nothing at all.
    window.qcConditionsFor = function (place, opts) {
        if (opts && opts.ask) {
            showSky(place.name, place.lat, place.lon, place.kind);
            const panel = document.getElementById('qc-conditions-panel');
            if (panel) panel.open = true;
            const header = document.getElementById('qc-conditions-for');
            if (header) {
                if (typeof header.scrollIntoView === 'function') header.scrollIntoView({ behavior: 'smooth', block: 'start' });
                header.focus();
            }
            return;
        }
        if (!picked) return;
        const samePlace = Math.round(picked.lat * 1e4) === Math.round(place.lat * 1e4)
            && Math.round(picked.lon * 1e4) === Math.round(place.lon * 1e4);
        if (samePlace) return;
        write('qc-conditions-for', '<p>These conditions are for ' + escHtml(picked.name) + ', not '
            + escHtml(place.name) + '. Use Before you go on ' + escHtml(place.name) + '\'s card.</p>');
    };

    // QUX-05a: a Geographic-names row carries a typed kind badge so a reader
    // scanning a merged list (peaks and towns together) can tell a Summit from
    // a Gap from a populated place without opening it -- the state/county line
    // this already rendered stays exactly as it was.
    function nameFinderOption(hit, optionId) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'qc-finder-hit';
        row.id = optionId;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', 'false');
        row.tabIndex = -1;
        var badge = document.createElement('span');
        badge.className = 'qc-finder-kind-badge';
        badge.textContent = kindLabel(hit.kind);
        row.appendChild(badge);
        row.appendChild(document.createTextNode(
            ' ' + hit.name + (hit.county ? ', ' + hit.county : '') + ', ' + hit.state
        ));
        // Closed first: the open search box sits over the map, and the card's
        // landing spot is chosen against what is still on screen.
        row.addEventListener('click', function() {
            if (finderClose) finderClose();
            selectNameHit(hit);
        });
        return row;
    }

    /** One street-address row: the matched address, marked as an estimate. The Census
     *  geocoder places a point along the street, so the row says so in words and the
     *  map and Conditions header it opens say so too -- never an exact household. */
    function addressFinderOption(hit, optionId) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'qc-finder-hit';
        row.id = optionId;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', 'false');
        row.tabIndex = -1;
        var badge = document.createElement('span');
        badge.className = 'qc-finder-kind-badge';
        badge.textContent = 'Street estimate';
        row.appendChild(badge);
        row.appendChild(document.createTextNode(' ' + hit.label + ' \u2014 ' + ADDRESS_ESTIMATE_NOTE));
        row.addEventListener('click', function() {
            map.setView([hit.lat, hit.lon], ADDRESS_ZOOM);
            showSky(hit.label + ' (street estimate)', hit.lat, hit.lon);   // reads in every showSky sentence
            if (finderClose) finderClose();
        });
        return row;
    }

    function renderFinderResults(box, list) {
        // Coordinates first: a valid pair is an unambiguous answer, and running the
        // name search over it only ever produces the wrong one.
        var coord = parseCoordinates(box.value);
        // The name search runs first for every query. Address shape is a guess, and a
        // real name ("Lake Unit 4", "Springfield #2", a road called "88 Quarry Lane")
        // must win over it: the address message is what emptyFinderMessage returns
        // only when the shape matched AND nothing by that name was found. A real
        // address does not match a town name (findPlaces needs the whole typed text to
        // start or sit inside one), so no nearby place stands in for it.
        var hits = coord ? [] : findPlaces(box.value);
        var found = coord || hits.length || lastNameHits.length || lastAddressHits.length;
        // While an address lookup is in force (searching, answered, failed) its own
        // status line speaks, so the Search prompt and the town-miss wording stay quiet.
        var empty = found || addressStatus !== 'idle' ? '' : emptyFinderMessage(box.value);
        list.innerHTML = '';
        list.hidden = !found;
        box.setAttribute('aria-expanded', found ? 'true' : 'false');
        clearFinderActive(box);
        showFinderNote(empty);
        announceFinder(empty, coord ? 1 : hits.length);
        if (empty || !found) return;
        // Four decimal places is roughly 11 metres — finer than this map can show,
        // and enough that the row reads back as the pair that was typed.
        var coordHit = coord
            ? { label: coord.lat.toFixed(4) + ', ' + coord.lon.toFixed(4), lat: coord.lat, lon: coord.lon }
            : null;
        // County alongside the state (audit item 7): candidates.json carries
        // county_name on every record, and until now the row never read it.
        var townHits = hits.map(function(t) {
            return {
                label: t.name + (t.county_name ? ', ' + t.county_name : '') + ', ' + t.state,
                lat: t.lat, lon: t.lon,
            };
        });
        var groups = groupFinderResults({ coordHit: coordHit, addressHits: lastAddressHits, townHits: townHits, nameHits: lastNameHits });
        // §4.3: an exact official-name+state match outranks a merely partial local
        // candidate -- rankFinderGroups (search-shell.js) is the one place that
        // reorders the fixed coordinate/town/name default (GROUP_ORDER) to do it.
        var nq = parseNameSearchQuery(box.value);
        var exactMatch = lastNameHits.some(function(f) {
            return isExactNameStateMatch(f, { query: nq.name, state: nq.state });
        });
        groups = rankFinderGroups(groups, { exactNameStateMatch: exactMatch });
        groups.forEach(function(group) {
            var rows = group.items.map(function(item) {
                if (group.id === 'address') return addressFinderOption(item, item.optionId);
                return group.id === 'name'
                    ? nameFinderOption(item, item.optionId)
                    : finderOption(item.label, item.lat, item.lon, item.optionId);
            });
            list.appendChild(finderGroup(group.label, rows));
        });
    }

    function updateCandidateMarkers(candidates) {
        if (!map) return;
        if (candidateLayer) map.removeLayer(candidateLayer);
        candidateLayer = L.layerGroup().addTo(map);

        for (const t of candidates) {
            if (t.lat == null || t.lon == null) continue;
            const marker = L.circleMarker([t.lat, t.lon], {
                radius: 3,
                fillColor: '#f59e0b',
                fillOpacity: 0.7,
                color: '#f59e0b',
                weight: 1,
                opacity: 0.8,
            });
            const pop = t.population ? t.population.toLocaleString() : '-';
            const tOverall = t.overall_score != null ? t.overall_score.toFixed(0) : '-';
            const tQuietness = t.quietness_score != null ? t.quietness_score.toFixed(0) : '-';
            marker.bindPopup(
                '<strong>' + escHtml(t.name) + ', ' + escHtml(t.state || '') + '</strong>' +
                '<div class="qc-popup-row"><span class="qc-popup-label">Pop</span><span class="qc-popup-val">' + pop + '</span></div>' +
                '<div class="qc-popup-row"><span class="qc-popup-label">County</span><span class="qc-popup-val">' + escHtml(t.county_name || '') + '</span></div>' +
                '<div class="qc-popup-row"><span class="qc-popup-label">Overall</span><span class="qc-popup-val">' + tOverall + '</span></div>' +
                '<div class="qc-popup-row"><span class="qc-popup-label">Quietness</span><span class="qc-popup-val">' + tQuietness + '</span></div>' +
                // The table says this once, above itself. The popup is where a reader
                // actually meets the numbers, and a county-wide score shown beside a
                // town's own population reads as a measurement of the town (F17).
                '<p class="qc-popup-note">County context: Overall and Quietness are ' +
                escHtml(t.county_name || 'the parent county') + '\u2019s scores, not measurements of this town. ' +
                'Population is the town\u2019s own.</p>',
                { maxWidth: 200 }
            );
            marker.addTo(candidateLayer);
        }
    }

    // ========================================================================
    // TRUST PANEL
    // ========================================================================

    // A filter that can only ever return nothing is worse than an absent one.
    // When a dimension has no coverage in this export, hide its control rather
    // than leaving a slider that silently empties the table. The coverage rows
    // in the trust panel still report the real percentage.
    function hideUncoveredDimensions(summary) {
        if (!summary || !summary.coverage) return;
        var groups = {
            remoteness: 'qc-remoteness-group',
            stability: 'qc-stability-group',
            affordability: 'qc-affordability-group'
        };
        Object.keys(groups).forEach(function(dim) {
            var cov = summary.coverage[dim];
            if (cov && cov.pct > 0) return;
            var el = document.getElementById(groups[dim]);
            if (el) el.style.display = 'none';
        });
    }

    function renderTrustPanel(summary) {
        const el = document.getElementById('qc-trust-content');
        if (!el) return;

        // Inferred fallback labels for dimensions the committed summary.json
        // doesn't (yet) list in data_sources — the pipeline only started
        // emitting that map for 'affordability'. Feature-detect: a key present
        // in summary.data_sources is confirmed by the export itself; anything
        // else falls back to this client-side inference.
        var INFERRED_SOURCES = {
            state_populations: { label: 'State Populations', source: 'Census Decennial 2000 + intercensal 2001-2009' },
            county_populations: { label: 'County Populations', source: 'Census PEP Vintage 2024' },
            coordinates: { label: 'Coordinates', source: 'Census Gazetteer 2024' },
            metro_cities: { label: 'Metro Cities', source: 'Census Place Gazetteer 2024' },
            rural_codes: { label: 'Rural Codes', source: 'USDA RUCC 2023' },
            county_typing: { label: 'County Typing', source: 'USDA Typology 2015' },
            affordability: { label: 'Affordability', source: 'Census ACS 5-Year' },
        };
        // Labels for sources the export reports on but the inferred list above
        // never named. Enumerating only INFERRED_SOURCES meant permits, metro
        // growth, migration and sprawl — four of the five keys data_sources
        // actually carries — were fetched and then dropped on the floor, so the
        // panel could not show that a source had come back or gone away.
        var REPORTED_SOURCES = {
            permits: { label: 'Building Permits', source: 'Census BPS county annual files' },
            metro_growth: { label: 'Metro Growth', source: 'Census PEP subcounty estimates' },
            migration: { label: 'State Migration', source: 'Census ACS 1-Year B07001' },
            sprawl: { label: 'Sprawl Composite', source: 'five-factor, renormalized over live inputs' },
        };
        var dataSources = summary.data_sources || {};
        var known = Object.assign({}, INFERRED_SOURCES, REPORTED_SOURCES);
        // Every key the export reports gets a row, in a stable order: the
        // inferred list first, then anything data_sources adds.
        var keys = Object.keys(INFERRED_SOURCES).concat(
            Object.keys(dataSources).filter(function(k) {
                return !Object.prototype.hasOwnProperty.call(INFERRED_SOURCES, k);
            })
        );
        const sources = keys.map(function(key) {
            var base = known[key] || { label: key, source: 'reported by this export' };
            if (Object.prototype.hasOwnProperty.call(dataSources, key)) {
                return { label: base.label, source: base.source + (dataSources[key] ? ' (confirmed by this export)' : ' (absent this run)') };
            }
            return base;
        });
        sources.push({ label: 'Pipeline Version', source: summary.pipeline_version || '?' });
        // Dataset generation is not source vintage: when the export was built says
        // nothing about how old the underlying records are (HM-4).
        var fresh = freshness(summary);
        var NOT_RECORDED = 'not recorded in this dataset version';
        sources.push({ label: 'Dataset generated', source: fresh.generated ? escHtml(new Date(fresh.generated).toLocaleString()) : 'unknown' });
        sources.push({
            label: 'Source vintage',
            source: fresh.sourceVintage
                ? Object.keys(fresh.sourceVintage).map(function(k) { return escHtml(k + ' ' + fresh.sourceVintage[k]); }).join('; ')
                : NOT_RECORDED
        });
        sources.push({
            label: 'Evidence availability',
            source: availabilityState(summary) === 'known'
                ? 'per-factor status recorded'
                : NOT_RECORDED + ' (figures are nonzero-factor coverage)'
        });

        var html = sources.map(s =>
            '<div class="qc-trust-row">' +
            '<span>' + s.label + '</span>' +
            '<span style="color: var(--accent-400);">' + s.source + '</span>' +
            '</div>'
        ).join('');

        // Coverage stats from summary.json
        if (summary.coverage) {
            html += '<div class="qc-trust-row" style="margin-top:0.75rem;border-top:1px solid var(--border-default);padding-top:0.5rem;">' +
                '<span style="font-weight:600;">Data Coverage</span><span></span></div>';
            // Livability dropped from the product (D1) — older exports still
            // report its coverage; the panel no longer shows it.
            var dims = ['stability', 'remoteness', 'affordability'];
            for (var i = 0; i < dims.length; i++) {
                var dim = dims[i];
                var cov = summary.coverage[dim];
                if (!cov) continue;
                var pct = cov.pct;
                var color = pct > 80 ? 'var(--accent-400)' : pct > 50 ? '#eab308' : pct > 0 ? '#ef4444' : 'var(--text-subtle)';
                html += '<div class="qc-trust-row">' +
                    '<span>' + dim.charAt(0).toUpperCase() + dim.slice(1) + '</span>' +
                    '<span style="color:' + color + ';">' + pct + '% (' + cov.count + ' counties)</span>' +
                    '</div>';
            }
        }

        html += renderSprawlFactorRows(summary);

        el.innerHTML = html;
    }

    // Sprawl risk is a weighted composite, and a factor whose source has gone
    // away scores zero everywhere rather than announcing itself — the composite
    // still renders a plausible number. Read the per-county factors and say
    // which ones actually carried this run, so the page cannot overstate the
    // score. Driven by the data, so it corrects itself when a source returns.
    var SPRAWL_FACTOR_LABELS = {
        interstate: 'Interstate proximity',
        permits: 'Building permits',
        migration: 'State migration',
        metro_growth: 'Metro growth',
        recreation: 'Recreation/retirement'
    };

    // The export already states these counts — summary.json carries a
    // sprawl_factor_coverage block keyed by the same five factor names, each
    // with {count, pct}. Read it instead of re-deriving the same fact from
    // ~1.7k county records in the browser. An older export that predates the
    // block, or one missing a factor from it, falls back to the recount below;
    // a partial block is treated as unusable rather than reported as zero.
    function sprawlFactorCounts(summary) {
        var block = summary && summary.sprawl_factor_coverage;
        if (block && typeof block === 'object') {
            var reported = {};
            var complete = true;
            for (var key in SPRAWL_FACTOR_LABELS) {
                var entry = block[key];
                if (!entry || typeof entry.count !== 'number') { complete = false; break; }
                reported[key] = entry.count;
            }
            if (complete) return reported;
        }
        return recountSprawlFactors();
    }

    function recountSprawlFactors() {
        if (!countiesData || !countiesData.length) return null;
        var counted = {};
        var total = 0;
        for (var i = 0; i < countiesData.length; i++) {
            var f = countiesData[i].sprawl_factors;
            if (!f || typeof f !== 'object') continue;
            total++;
            for (var key in SPRAWL_FACTOR_LABELS) {
                if (f[key]) counted[key] = (counted[key] || 0) + 1;
            }
        }
        return total ? counted : null;
    }

    function renderSprawlFactorRows(summary) {
        var counted = sprawlFactorCounts(summary);
        if (!counted) return '';

        // Without recorded per-factor status these counts are only "how many counties
        // scored above zero" -- label them that way rather than as measured coverage.
        var recorded = availabilityState(summary) === 'known';
        var out = '<div class="qc-trust-row" style="margin-top:0.75rem;border-top:1px solid var(--border-default);padding-top:0.5rem;">' +
            '<span style="font-weight:600;">Sprawl factors in this run' + (recorded ? '' : ' (nonzero-factor coverage)') + '</span><span></span></div>';
        for (var k in SPRAWL_FACTOR_LABELS) {
            var n = counted[k] || 0;
            var live = n > 0;
            out += '<div class="qc-trust-row">' +
                '<span>' + SPRAWL_FACTOR_LABELS[k] + '</span>' +
                '<span style="color:' + (live ? 'var(--accent-400)' : 'var(--text-subtle)') + ';">' +
                (live ? n + ' counties' : (recorded ? 'unavailable — scored 0' : 'no nonzero scores')) +
                '</span></div>';
        }
        return out;
    }

    // ========================================================================
    // VIEW STATE (B1): reserved fragment, Share/Reset view, back/forward
    // ========================================================================
    //
    // Base/surface/overlay controls live in main.js's DOM (the Layers panel),
    // built asynchronously after qc:map-ready -- so those three fields are
    // applied over there, through its own existing applyPreset() (see
    // `window.qcInitialView` below), never a second way to move the same
    // radios. Center/zoom and the county metric/opacity live here and are
    // applied directly through applyView().
    let pendingInitialView = null;
    const viewApplyGuard = createApplyGuard();
    const viewPrefsStore = createPrefsStore(PREFS_KEY);

    // B3: one-shot location. Tracks whether the center on screen came from the
    // reader panning/zooming ('user'), a followed link ('link' -- set only by
    // parseFragment/resolveInitialView, never here) or the locate button
    // ('location'). currentView() reports it below; formatFragment (view-state.js)
    // is what actually drops a 'location' center from a link unless Share view's
    // explicit confirmation says otherwise -- nothing here re-implements that
    // guard, it only sets the flag formatFragment already reads.
    let currentCenterSource = 'user';
    // In-memory only (plan §4.3 "marker/accuracy circle stay in memory") -- never
    // sessionStorage/localStorage, never the URL. A second successful fix replaces
    // both; Reset view clears them.
    let locateMarker = null;
    let locateCircle = null;
    let locatePending = false;

    function viewEnums() {
        return { bases: BASES.map(function(b) { return b.id; }), surfaces: CONTEXT_LAYER_IDS, layerIds: LAYER_IDS };
    }

    function readCheckedRadio(name) {
        const el = document.querySelector('input[name="' + name + '"]:checked');
        return el ? el.value : undefined;
    }

    function readCheckedLayerIds() {
        return LAYER_IDS.filter(function(id) {
            const el = document.getElementById('qcm-layer-' + id);
            return !!(el && el.checked);
        });
    }

    /** Reads the density/size control (QUX-05b) -- defensive against the
     *  control not existing (older cached markup, or a test harness that never
     *  built the dashboard DOM), in which case the view carries the same
     *  DEFAULT_VIEW.labels currentView() always returned before this unit. */
    function readLabelPrefs() {
        const densitySel = document.getElementById('qc-label-density');
        const sizeSel = document.getElementById('qc-label-size');
        return {
            density: (densitySel && densitySel.value) || DEFAULT_VIEW.labels.density,
            size: (sizeSel && sizeSel.value) || DEFAULT_VIEW.labels.size,
        };
    }

    function hasActiveMapFragment() {
        return location.hash.indexOf('#map=') === 0;
    }

    /** Reconstructs the current view from live state for Share view and the
     *  routine history writer. Base/surface/overlays are read (never written)
     *  from main.js's own DOM -- this file has no other way to know them. */
    function currentView() {
        const center = map ? [map.getCenter().lat, map.getCenter().lng] : DEFAULT_VIEW.center;
        const zoom = map ? map.getZoom() : DEFAULT_VIEW.zoom;
        const opacity = typeof window.qcGetScoreOpacity === 'function' ? window.qcGetScoreOpacity() : null;
        const county = scoresVisible
            ? Object.assign({ scores: true, metric: colorBy }, opacity != null ? { opacity: opacity } : {})
            : null;
        return {
            v: DEFAULT_VIEW.v,
            center: center,
            zoom: zoom,
            base: readCheckedRadio('qcm-base') || DEFAULT_VIEW.base,
            surface: readCheckedRadio('qcm-context') || DEFAULT_VIEW.surface,
            overlays: readCheckedLayerIds(),
            county: county,
            labels: readLabelPrefs(),
            emphasis: DEFAULT_VIEW.emphasis,
            camera: null,
            centerSource: currentCenterSource,
        };
    }

    /** The one setter for view.county HERE: metric (the color-by select) and
     *  opacity (the wash-strength slider). The scores on/off switch itself is
     *  not this field's job -- it follows from view.surface === 'countyScore'
     *  once main.js's own context radio moves, exactly like every other
     *  one-dominant-surface choice. */
    function applyCountyFromView(county) {
        if (!county) return;
        if (county.metric) {
            colorBy = colorMetric(county.metric).key;
            const colorSel = document.getElementById('qc-color-by');
            if (colorSel) colorSel.value = colorBy;
            if (map) updateMapHighlights(new Set(lastFiltered.map(function(c) { return c.fips; })));
            if (legendRefresh) legendRefresh();
            updateCueNote();
        }
        if (typeof county.opacity === 'number' && typeof window.qcSetScoreOpacity === 'function') {
            window.qcSetScoreOpacity(county.opacity);
            const opacityInput = document.getElementById('qc-score-opacity');
            if (opacityInput) opacityInput.value = county.opacity;
        }
    }

    /** QUX-05b setter: mirrors applyCountyFromView's pattern -- set the
     *  control's own DOM value(s), then push to main.js's renderNames/
     *  setupNames state via the qcSetLabelPrefs bridge (guarded: at initial
     *  page load this can run before main.js's attach() has defined it, which
     *  is why main.js's own attach() ALSO reads window.qcInitialView.labels
     *  directly rather than depending solely on this call reaching it). */
    function applyLabelsFromView(labels) {
        if (!labels) return;
        const densitySel = document.getElementById('qc-label-density');
        if (densitySel && labels.density) densitySel.value = labels.density;
        const sizeSel = document.getElementById('qc-label-size');
        if (sizeSel && labels.size) sizeSel.value = labels.size;
        if (typeof window.qcSetLabelPrefs === 'function') window.qcSetLabelPrefs(labels);
    }

    const routineWriter = createRoutineWriter({
        write: function(fragment) { history.replaceState(null, '', fragment); },
        hasActiveFragment: hasActiveMapFragment,
        guard: viewApplyGuard,
        waitMs: 400,
    });

    // Routine movement: throttled, one writer, replaceState only -- and only
    // once an active #map= fragment already exists, so panning around never
    // CREATES one out of a plain page load.
    function announceCurrentViewChange() {
        const f = formatFragment(currentView(), { includeLocation: false });
        routineWriter.notify(f.fragment);
    }

    function applyResolvedView(view) {
        // main.js's start() reads this once, after it builds qcm-base-*/
        // qcm-context-*/qcm-layer-* -- see the guarded call added there.
        window.qcInitialView = view;
        applyView(view, {
            setCenterZoom: function(center, zoom) { if (map) map.setView(center, zoom, { animate: false }); },
            setCounty: applyCountyFromView,
            setLabels: applyLabelsFromView,
        }, viewApplyGuard);
    }

    const popstateHandler = createPopstateHandler({
        resolveView: function() {
            const parsed = parseFragment(location.hash, viewEnums());
            return parsed.view;
        },
        applySetters: {
            setCenterZoom: function(center, zoom) { if (map) map.setView(center, zoom, { animate: false }); },
            setCounty: applyCountyFromView,
            setLabels: applyLabelsFromView,
        },
        guard: viewApplyGuard,
    });
    window.addEventListener('popstate', popstateHandler);

    function announceShareStatus(msg) {
        const el = document.getElementById('qc-view-status');
        if (el) el.textContent = msg;
    }

    function announceLocateStatus(msg) {
        const el = document.getElementById('qc-locate-status');
        if (el) el.textContent = msg;
    }

    function locateIncludeWrap() { return document.getElementById('qc-locate-include-wrap'); }
    function locateIncludeCheckbox() { return document.getElementById('qc-locate-include'); }

    // Shown/checkable only while the current center is location-derived --
    // Share view's explicit "Include my location in the link" confirmation has
    // nothing to confirm when there is no location-derived center to include.
    function syncLocateIncludeControl() {
        const wrap = locateIncludeWrap();
        if (wrap) wrap.hidden = currentCenterSource !== 'location';
        if (currentCenterSource !== 'location') {
            const cb = locateIncludeCheckbox();
            if (cb) cb.checked = false;
        }
    }

    function clearLocateFix() {
        if (map && locateMarker) map.removeLayer(locateMarker);
        if (map && locateCircle) map.removeLayer(locateCircle);
        locateMarker = null;
        locateCircle = null;
    }

    function wireLocateControl() {
        const btn = document.getElementById('qc-locate');
        if (!btn) return;
        if (!(navigator.geolocation && typeof navigator.geolocation.getCurrentPosition === 'function')) {
            btn.disabled = true;
            announceLocateStatus('This browser cannot report your location.');
            return;
        }
        btn.addEventListener('click', function() {
            // A second click while a fix is pending is ignored outright, not
            // queued -- the button is already disabled, but a fast double-tap can
            // still reach the handler before the disabled attribute repaints.
            if (locatePending || !map) return;
            locatePending = true;
            btn.disabled = true;
            announceLocateStatus('Finding your location…');
            requestOnce(navigator.geolocation, { bounds: CONUS_BOUNDS }).then(function(result) {
                locatePending = false;
                btn.disabled = false;
                announceLocateStatus(result.copy);
                if (result.kind !== 'ok') return;
                viewApplyGuard.run(function() {
                    clearLocateFix();
                    const latlng = [result.latitude, result.longitude];
                    flyToRM(latlng, Math.max(map.getZoom(), 12), { duration: 0.8 });
                    locateMarker = L.marker(latlng, { keyboard: false, alt: 'Your approximate location' }).addTo(map);
                    if (typeof result.accuracy === 'number') {
                        locateCircle = L.circle(latlng, {
                            radius: result.accuracy, color: getAccentColor(), weight: 1, fillOpacity: 0.12,
                        }).addTo(map);
                    }
                    currentCenterSource = 'location';
                });
                syncLocateIncludeControl();
            });
        });
    }

    function wireViewControls() {
        wireLocateControl();
        syncLocateIncludeControl();

        const shareBtn = document.getElementById('qc-view-share');
        if (shareBtn) shareBtn.addEventListener('click', function() {
            const includeLocation = currentCenterSource === 'location'
                && !!(locateIncludeCheckbox() && locateIncludeCheckbox().checked);
            const f = formatFragment(currentView(), { includeLocation: includeLocation });
            const url = location.origin + location.pathname + location.search + f.fragment;
            const locationNote = currentCenterSource === 'location'
                ? (includeLocation ? ' Your location was included.' : ' Your location was not included.')
                : '';
            const done = function(ok) {
                announceShareStatus((ok ? 'Link copied to your clipboard.' : 'Could not copy automatically. The link: ' + url) + locationNote);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(url).then(function() { done(true); }, function() { done(false); });
            } else {
                let ok = false;
                try {
                    const ta = document.createElement('textarea');
                    ta.value = url;
                    ta.style.position = 'fixed';
                    ta.style.opacity = '0';
                    document.body.appendChild(ta);
                    ta.focus();
                    ta.select();
                    ok = document.execCommand('copy');
                    document.body.removeChild(ta);
                } catch (e) { ok = false; }
                done(ok);
            }
        });

        const resetBtn = document.getElementById('qc-view-reset');
        if (resetBtn) resetBtn.addEventListener('click', function() {
            const result = resetView({ defaultView: DEFAULT_VIEW, prefsStore: viewPrefsStore });
            clearLocateFix();
            currentCenterSource = 'user';
            syncLocateIncludeControl();
            applyResolvedView(result.view);
            if (result.removeFragment) history.replaceState(null, '', location.pathname + location.search);
            announceShareStatus('View reset.');
        });

        // Base lives in main.js's DOM, so this listens rather than owning the
        // radio; a storage failure inside viewPrefsStore.save() never throws
        // (view-wiring.js). Emphasis still has no UI (see the docs note) --
        // labels (QUX-05b) is this file's own control, wired below alongside it
        // so both persist through the same save() call.
        document.addEventListener('change', function(e) {
            if (e.target && e.target.name === 'qcm-base') {
                viewPrefsStore.save(prefsFromView(currentView()));
            }
        });

        // QUX-05b: the density/size control. change (not input) so a reader
        // moving through the size options with arrow keys before Enter/blur
        // does not push a render or a save per keystroke.
        const densitySel = document.getElementById('qc-label-density');
        const sizeSel = document.getElementById('qc-label-size');
        [densitySel, sizeSel].forEach(function(el) {
            if (!el) return;
            el.addEventListener('change', function() {
                if (typeof window.qcSetLabelPrefs === 'function') window.qcSetLabelPrefs(readLabelPrefs());
                viewPrefsStore.save(prefsFromView(currentView()));
            });
        });
    }

    // One map panel open at a time (QUX-03a shell). panel-state.js owns the pure
    // open/close/focus-target logic; this is only the DOM glue -- which two
    // <details> are the panels, and calling .focus()/.open on them.
    //
    // Exclusivity reacts to every toggle, trusted or not: a `toggle` event
    // fired because page script set `.open = true` (openEveryPanel-style)
    // reports `isTrusted: true` too -- the browser dispatches it the same way
    // it dispatches one from a real click on <summary>, since it is the same
    // "open state actually changed" notification either way. There is no
    // `isTrusted` distinction to key off, so a test that wants more than one
    // panel open at once has to open them as separate, real interactions
    // rather than one synchronous `.open = true` pass; see phone-controls.test.mjs.
    var panelState = initialState();

    function wirePanels() {
        var panels = [
            { id: 'layers', el: document.getElementById('qcm-layer-panel') },
            { id: 'print', el: document.getElementById('qcm-app') },
            { id: 'explore', el: document.getElementById('qc-explore-panel') },
            { id: 'conditions', el: document.getElementById('qc-conditions-panel') },
        ].filter(function(p) { return p.el; });

        function restoreFocus() {
            var target = focusTarget(panelState);
            if (target && typeof target.focus === 'function') target.focus();
        }

        // Back is only ever a step back through panelState.history -- hidden on
        // both panels whenever there is nothing to step back to. Called after
        // every state change (open, close, Back itself) so the two buttons never
        // fall out of step with panelState.
        function syncBackVisibility() {
            var hasHistory = panelState.history.length > 0;
            panels.forEach(function(p) {
                var backBtn = p.el.querySelector('.qcm-panel-back');
                if (backBtn) backBtn.hidden = !hasHistory;
            });
        }

        // QUX-03c: reflects panelState.sheet onto #qc-sheet's data-sheet
        // attribute (the CSS in quiet-corners.css keys off it) and the size
        // button's hidden/label state, then -- only when the size actually
        // changed and only below 1024px, where the sheet and map share a fixed
        // stage -- tells Leaflet to repaint into its new box. Called wherever
        // syncBackVisibility() is, so the sheet never falls out of step with
        // panelState either.
        function applySheet() {
            var sheetEl = document.getElementById('qc-sheet');
            if (!sheetEl) return;
            sheetEl.setAttribute('data-sheet', panelState.sheet);
            var sizeBtn = sheetEl.querySelector('.qc-sheet-size');
            if (sizeBtn) {
                sizeBtn.hidden = panelState.sheet === 'collapsed';
                sizeBtn.textContent = panelState.sheet === 'expanded' ? 'Shrink' : 'Expand';
            }
            // The sheet's own box is height-constrained (45%/100% of the
            // stage via data-sheet), but flex-wrap has no way to make ONE
            // wrapped line -- the open panel's -- absorb whatever cross-axis
            // space the others (the grip, the closed-panel bar) leave over:
            // line-wrapping sizes every line to its own content first, and
            // align-content only redistributes space left AFTER that, which
            // is already negative once the panel's real content is counted.
            // Measured directly instead, every call, so a panel that just
            // closed loses a stale value too. The open panel's own `order`
            // can put it on any line (QUX-03c puts it first), so its height
            // can't be read off a "bar bottom edge" below it -- sum each
            // OTHER sibling row's own height instead, grouped by rounded
            // top since the bar can wrap to one row or two at a narrow
            // width, and give the panel what's left of the sheet.
            //
            // Margin boxes, out of the sheet's content box: the open panel
            // keeps the 1rem margin every .qcm-panel has (quiet-corners-maps.css),
            // and the sheet has a border on top and the home-indicator inset
            // as padding below. Border boxes out of the sheet's border box ran
            // the grip bar 33px past the bottom of the map frame, which clips
            // it out of sight and out of reach.
            var isPhone = window.matchMedia('(max-width: 1023px)').matches;
            panels.forEach(function(p) {
                if (p.id === panelState.open && isPhone && panelState.sheet !== 'collapsed') {
                    var sheetStyle = getComputedStyle(sheetEl);
                    var room = sheetEl.clientHeight - parseFloat(sheetStyle.paddingTop) - parseFloat(sheetStyle.paddingBottom);
                    var rowHeights = {};
                    Array.prototype.forEach.call(sheetEl.children, function(child) {
                        if (child === p.el || !child.getClientRects().length) return;
                        var r = child.getBoundingClientRect();
                        var cs = getComputedStyle(child);
                        var above = parseFloat(cs.marginTop);
                        var row = Math.round(r.top - above);
                        rowHeights[row] = Math.max(rowHeights[row] || 0, above + r.height + parseFloat(cs.marginBottom));
                    });
                    var barHeight = Object.keys(rowHeights).reduce(function(sum, row) {
                        return sum + rowHeights[row];
                    }, 0);
                    var own = getComputedStyle(p.el);
                    var margins = parseFloat(own.marginTop) + parseFloat(own.marginBottom);
                    p.el.style.maxHeight = Math.max(0, Math.floor(room - barHeight - margins)) + 'px';
                } else {
                    p.el.style.maxHeight = '';
                }
            });
        }

        // QUX-03c: closes whichever panel the sheet was showing, the same
        // state-first-then-DOM ordering the Close and Back handlers above use
        // (so that panel's own queued `toggle` event is a no-op by the time it
        // runs). `wasOpenId` is panelState.open from BEFORE the caller already
        // moved panelState to the collapsed/closed result -- resizeSheet and
        // snapSheet both close by returning open: null, so it is gone from
        // panelState itself by the time this runs.
        function closeSheetPanel(wasOpenId) {
            var openPanelEntry = panels.filter(function(p) { return p.id === wasOpenId; })[0];
            if (openPanelEntry) openPanelEntry.el.open = false;
            restoreFocus();
            syncBackVisibility();
            applySheet();
        }

        panels.forEach(function(p) {
            p.el.addEventListener('toggle', function(e) {
                if (p.el.open) {
                    // Opening this one closes every other panel -- "one at a time".
                    panelState = openPanel(panelState, p.id, p.el.querySelector('summary'));
                    panels.forEach(function(other) {
                        if (other.id !== p.id && other.el.open) other.el.open = false;
                    });
                } else if (panelState.open === p.id) {
                    // Closed by clicking its own summary again (native behaviour).
                    panelState = closePanel(panelState);
                    restoreFocus();
                }
                syncBackVisibility();
                applySheet();
            });

            var closeBtn = p.el.querySelector('.qcm-panel-close');
            if (closeBtn) {
                closeBtn.addEventListener('click', function() {
                    // State first, DOM second -- by the time this panel's own
                    // (queued) toggle event reaches the listener above,
                    // panelState.open no longer names it, so that listener's
                    // close branch is a no-op rather than a second closePanel().
                    panelState = closePanel(panelState);
                    p.el.open = false;
                    restoreFocus();
                    syncBackVisibility();
                    applySheet();
                });
            }

            var backBtn = p.el.querySelector('.qcm-panel-back');
            if (backBtn) {
                backBtn.addEventListener('click', function() {
                    if (panelState.history.length === 0) return;
                    // Same ordering as Close: backPanel() first, so the toggle
                    // events both DOM writes below queue are no-ops by the time
                    // they run (the reopened panel's id already matches
                    // panelState.open; the closed one's id no longer does).
                    panelState = backPanel(panelState);
                    panels.forEach(function(other) {
                        other.el.open = (other.id === panelState.open);
                    });
                    syncBackVisibility();
                    applySheet();
                    var reopened = panels.filter(function(o) { return o.id === panelState.open; })[0];
                    // Named summaryEl, not summary: scripts/test_data_contract.py
                    // reads every `summary.<field>` in this file as a field of
                    // summary.json, and `summary.focus` is not one.
                    var summaryEl = reopened && reopened.el.querySelector('summary');
                    if (summaryEl && typeof summaryEl.focus === 'function') summaryEl.focus();
                });
            }
        });

        // QUX-03c: the sheet's own chrome -- the grip bar, the size button and
        // the drag handle. The grip starts `hidden` in the markup (a no-JS/
        // pre-hydration load must never show a drag handle that does
        // nothing) and this is what clears that once its listeners are
        // attached; quiet-corners.css's `.qc-sheet-grip` rule (unconditional,
        // no [hidden] in the selector) is what then makes it visible below
        // 1024px -- tailwind.css's preflight ships `[hidden] { display: none
        // !important }`, which a `[hidden]`-qualified override could never
        // beat. Desktop (>=1024px) hides the whole grip again in CSS
        // (quiet-corners-maps.css), so leaving it un-hidden here is harmless
        // at that width too.
        var sheetEl = document.getElementById('qc-sheet');
        var grip = sheetEl && sheetEl.querySelector('.qc-sheet-grip');
        var sizeBtn = sheetEl && sheetEl.querySelector('.qc-sheet-size');
        var handle = sheetEl && sheetEl.querySelector('.qc-sheet-handle');
        if (grip) grip.hidden = false;

        if (sizeBtn) {
            sizeBtn.addEventListener('click', function() {
                panelState = resizeSheet(panelState, panelState.sheet === 'half' ? 'expanded' : 'half');
                applySheet();
            });
        }

        if (handle) {
            var dragStartY = null;

            handle.addEventListener('pointerdown', function(e) {
                dragStartY = e.clientY;
                handle.setPointerCapture(e.pointerId);
            });

            // No live resize on pointermove: snap-on-release keeps Leaflet to
            // one invalidateSize() per gesture instead of one per pixel
            // dragged -- applySheet() sets the new size on release, and the
            // ResizeObserver on #qc-map (createMap) repaints once it lands.
            handle.addEventListener('pointerup', function(e) {
                if (dragStartY === null) return;
                var dy = e.clientY - dragStartY;
                dragStartY = null;
                var stage = document.getElementById('qc-map-container');
                var wasOpen = panelState.open;
                panelState = snapSheet(panelState, dy, stage ? stage.clientHeight : 0);
                if (wasOpen && panelState.open === null) {
                    closeSheetPanel(wasOpen);
                } else {
                    applySheet();
                }
            });
            handle.addEventListener('pointercancel', function() {
                dragStartY = null;
            });

            handle.addEventListener('keydown', function(e) {
                if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    panelState = resizeSheet(panelState, 'expanded');
                    applySheet();
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    if (panelState.sheet === 'expanded') {
                        panelState = resizeSheet(panelState, 'half');
                        applySheet();
                    } else if (panelState.sheet === 'half') {
                        var wasOpen = panelState.open;
                        panelState = resizeSheet(panelState, 'collapsed');
                        closeSheetPanel(wasOpen);
                    }
                } else if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    panelState = resizeSheet(panelState, panelState.sheet === 'half' ? 'expanded' : 'half');
                    applySheet();
                }
            });
        }

        // Escape always closes whichever panel is open, full stop -- not "Back".
        // Back is its own control (the .qcm-panel-back buttons above); Escape
        // stays a hard exit so it still works from a panel Back cannot reach
        // (history empty) and never leaves a reader wondering which of the two
        // it just triggered.
        //
        // But only an Escape nothing nearer has already spent: a name card
        // (identify() in preview-overlay.js) consumes its own Escape with
        // preventDefault() to dismiss the card and hand focus back to the pin.
        // Without this check the same press reached here too, closed the Layers
        // panel and pulled focus to its summary -- one key, two exits
        // (names-keyboard.test.mjs "Escape on an open card").
        document.addEventListener('keydown', function(e) {
            if (e.key !== 'Escape' || !panelState.open || e.defaultPrevented) return;
            var openPanelEl = panels.filter(function(p) { return p.id === panelState.open; })[0];
            panelState = closePanel(panelState);
            if (openPanelEl) openPanelEl.el.open = false;
            restoreFocus();
            syncBackVisibility();
            applySheet();
        });

        // Initial sync: matches the `hidden` attribute already in the markup,
        // but computed from panelState rather than assumed to agree with it.
        syncBackVisibility();
        applySheet();

        // The open panel's height is the room the sheet has, and that room
        // changes with no sheet event at all: the surface caption and the
        // print-area strip come and go above the sheet in the same frame, and
        // a rotation changes the stage itself. So re-measure whenever the
        // sheet's own box changes size. Only the sheet is watched, and its
        // half/expanded height comes from the stylesheet rather than from its
        // content (collapsed has no open panel), so the height set here never
        // resizes the sheet and sets this off again.
        if (sheetEl && typeof ResizeObserver === 'function') {
            new ResizeObserver(function() { applySheet(); }).observe(sheetEl);
        }
    }

    // ========================================================================
    // INIT
    // ========================================================================

    // Tooltips reveal on hover only by default (CSS). Anything that isn't
    // already an interactive control needs tabindex so :focus can reach it too.
    function makeTooltipsFocusable() {
        document.querySelectorAll('.qc-tooltip').forEach(function(el) {
            if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
        });
    }

    function startLoad() {
        // Last-resort guard: any uncaught throw in the load/render chain
        // surfaces as a visible error instead of a silently blank page.
        loadData().catch(function(e) {
            showError('Dashboard failed to render: ' + e.message);
        });
    }

    function init() {
        setupSort();
        makeTooltipsFocusable();

        // Resolve the view to open with (fragment > legacy `?v=1&lat&lon` >
        // saved display prefs > defaults) before the map exists, so createMap()
        // can open on it directly rather than snapping to it after a first paint.
        pendingInitialView = resolveInitialView({
            fragment: location.hash,
            legacyQuery: location.search,
            savedPrefs: viewPrefsStore.load(),
            defaults: viewEnums(),
        }).view;

        wireViewControls();
        wirePanels();

        // Wire up filter controls — sliders debounced, discrete immediate
        ['qc-remoteness', 'qc-stability', 'qc-overall', 'qc-sprawl',
         'qc-affordability'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', applyFiltersDebounced);
        });
        ['qc-state', 'qc-pop-min', 'qc-pop-max'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', applyFilters);
        });

        // Color by. The filtered set does not change when the ramp does, so this
        // repaints the counties already on the map and re-labels the key; it
        // deliberately does not re-run the filters.
        const colorSel = document.getElementById('qc-color-by');
        if (colorSel) {
            colorSel.innerHTML = colorByOptionsHtml();
            colorSel.value = colorBy;
            colorSel.addEventListener('change', function() {
                colorBy = colorMetric(this.value).key;
                if (map) updateMapHighlights(new Set(lastFiltered.map(c => c.fips)));
                if (legendRefresh) legendRefresh();
                updateCueNote();
            });
        }

        var retry = document.getElementById('qc-error-retry');
        if (retry) retry.addEventListener('click', startLoad);

        // Zoom to state is the ONLY thing that moves the map on a state choice --
        // selecting the filter above never does, so a reader mid-pan is never
        // yanked back.
        var zoomBtn = document.getElementById('qc-zoom-state');
        if (zoomBtn) zoomBtn.addEventListener('click', function() {
            zoomToState(normState(document.getElementById('qc-state').value));
        });

        var opacityInput = document.getElementById('qc-score-opacity');
        if (opacityInput) opacityInput.addEventListener('input', function() {
            if (window.qcSetScoreOpacity) window.qcSetScoreOpacity(this.value);
        });

        startLoad();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
