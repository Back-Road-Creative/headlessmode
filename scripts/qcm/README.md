# scripts/qcm

Tests and build tools for Quiet Corners, the county dashboard and Field Maps builder at
`/quiet-corners/`. Plain `node:test` and Node built-ins only; no puppeteer, no Playwright.
Browser proofs drive a headless Chromium over the DevTools protocol.

## Run it

```bash
node --test "scripts/qcm/*.test.mjs"      # the whole suite, as CI runs it
node --test scripts/qcm/print-area-clear.test.mjs   # one file
```

Camera sources: see [camera-source-ledger.md](./camera-source-ledger.md) (the intake report) and `camera-source-ledger.json` (one row per source); `camera-source-ledger.test.mjs` keeps them in step with the code.

Camera snapshot format: `camera-snapshot.js` (in the theme's `quiet-corners-maps/`) reads and writes it, and `build-camera-snapshot.mjs` builds the directory of files plus `index.json`. A file is **schema 1** (a still, a name, an exact position) or **schema 2**, which adds only the columns a record needs: `bearing` (degrees, 0 to 360), `capturedAt` and `validUntil` (canonical ISO strings) and `precision` (`exact` or `approximate`). The writer emits schema 1 unless a record needs a richer field, so a rebuild never rewrites an existing schema 1 seed; readers accept both. `expandSnapshot(file, { now })` drops the still of a row whose `validUntil` is before `now` (the default is the clock), and the builder marks a file whose stills have all expired as `stale: true` in `index.json` (the mark is refreshed whenever a build writes the index; the file itself is kept). Adapters map a source's own bearing, capture time or expiry through `parseBearing` (a number, or a plain decimal string -- never `0x5A`, `1e2` or `+90`) / `parseIsoTime` in `source-camera.js`, and an approximate position through `precisionFor(lat, lon, 'approximate')`; no merged adapter supplies any of them today, and none is ever invented. `camera-snapshot-v2.test.mjs` covers all of it offline.


**Everything lives flat in this folder.** CI's glob (`pr-ci.yml`, the `node --test` step) is
`"scripts/qcm/*.test.mjs"`, and a shell glob does not recurse. A test in a subfolder would
pass locally when named and never run in CI. Fixtures sit in `fixtures/`, shared helpers in
`helpers/`, and neither holds a test.

## When a test skips

Browser tests skip, with the reason printed, rather than fail when the box cannot run them:

- No Chromium: set `CHROME_PATH` (or `PUPPETEER_EXECUTABLE_PATH`) to one, or install one at a
  path `helpers/browser.mjs` already looks in (`findChromium`).
- Site not built: the layout and browser tests read `public/`, which a bare checkout lacks.

A skip is not a pass. Build the site and have a browser before you trust a green run.

`maps-docs-promises.test.mjs` is offline and needs only the built site, no browser. It holds
`content/quiet-corners-maps.md` to the UI: no paragraph twice; every short bold or quoted label
equals a whole piece of on-screen text (element text, aria-label, or a whole string in a shipped
script, never a fragment of a longer one); the label size and crowding selects sit under Map
appearance > Map labels; the Map label size paragraph says 2D only if the built 2D path honours
the setting; the Map labels hint says "names"; and the exaggeration (both labels, ticked and not),
Reset, Map only and Layers in this view paragraphs say what the
source does (the test imports `layer-presets.js`, `layer-registry.js` and `terrain-overlays.js`
and reads `main.js` and `terrain-view.js`). A failure names the label or paragraph to fix in the doc.

## Build the site

Until PR #669 lands, build the CSS first, then the site:

```bash
npm run build:css
bash scripts/build-site.sh --configDir site-config --minify
```

Once #669 lands, `build-site.sh` alone does both. Never run bare `hugo`: the wrapper also
writes the map CSP into `public/_headers`.

A build without compiled CSS still serves pages, so screenshots from it look broken in
misleading ways. That is what the next tool catches.

`scripts/validate.sh` runs this suite before it rebuilds `public/`, so locally it checks the
build you already have (or skips if there is none), not the one it is about to make. Build
first. CI builds before it tests, so there the check is a real gate.

## Build identity

```bash
node scripts/qcm/build-identity.mjs                 # print the record
node scripts/qcm/build-identity.mjs --json out.json # also save it
```

`--public <dir>` and `--layout <file>` point it at another build and dashboard layout; the
tests use them. Exit 2 means a bad flag.

It prints the source commit, the uncommitted paths, a SHA-256 for `tailwind.css` and each
asset the dashboard loads, whether the essentials are present, and what is deployed. Exit
code 1 means an essential is missing or the CSS is not compiled; 0 otherwise.

"Deployed" is read only from git: the subject of `origin/production` and its
`deploy-marker.txt`, never the live site. `origin/production` is an orphan branch, so deployed
and source are matched by SHA string alone. Without `origin/production`, `deployed` is `null`.

**An acceptance or audit run starts from a passing record.** Save it beside the run's
screenshots. If it fails, fix the build first.

## Test evidence

A CI step's exit code says "no failure", not "everything ran": a browser file that skips, a file
the glob never matched, and a result from an older commit all look like a pass. Two tools make
the run leave a record, and refuse a record that cannot be trusted (QQA-12a, slice 1).

```bash
# Produce: runs node --test (default glob scripts/qcm/*.test.mjs), streams its output as
# usual, exits with node's own code, and writes the record even when the run fails.
node scripts/qcm/run-with-evidence.mjs --out test-evidence.json --test-timeout=600000

# Check: exit 1, one plain line per reason, unless the record is good for that commit.
node scripts/qcm/check-evidence.mjs --evidence test-evidence.json --sha HEAD
```

Give `node --test` flags as `--flag=value` (a bare value after a flag reads as a file) and pass
files or globs as plain arguments. `--public <dir>` says where the build is (default `public`).

The record holds the commit, whether tracked files were modified, the build marker, node's
version, start and end time, the exit code, and per test file its `pass`, `fail`, `skip` and
`todo` counts plus the name and reason of every skipped test. The Hugo build writes no commit
into `public/` before the tests run (`deploy-marker.txt` is added by `deploy-production.yml`
after them), so the build marker is `public/deploy-marker.txt` when there is one and otherwise
the mtime of `public/index.html`, labelled as only that.

`check-evidence.mjs` rejects a record that is missing or unparsable; is for another commit than
`--sha` (stale); leaves out a `*.test.mjs` that is on disk in `--tests-dir` (default
`scripts/qcm`); has a file with a failure, or a non-zero exit; has a file with no test in it;
has a skipped test, or a skipped `describe` (counted as one skip, since node reports no tests
inside it), that `evidence-skip-allowlist.json` does not name; or was run with a node flag that
drops tests (`--test-name-pattern`, `--test-skip-pattern`, `--test-only`, `--test-shard`). An entry gives the
`file`, a `test` name pattern (regular expression), the `reason` the skip is legitimate and an
`owner`. The list starts empty, because with `CI=true` the browser and build skips fail instead
(QQA-01), so nothing is legitimately skipped in CI. A new entry is a hole in the gate: give it
a reason a reviewer would accept. `evidence-gate.test.mjs` holds both tools to this offline.

Two options cover what the tests directory cannot. `--require <file>` (repeatable) names a test
that must be in the record even though it lives outside `--tests-dir`, such as
`scripts/test-verify-claims.js`, so dropping it from the producer command fails the check.
`--reject-dirty` also fails a record made with modified tracked files; it is opt-in because a
CI step may legitimately touch a tracked file before the tests.

**Wired in CI.** `pr-ci.yml` and `deploy-production.yml` run the suite through
`run-with-evidence.mjs` (writing `$RUNNER_TEMP/qcm-test-evidence.json`), and the step after it
runs `check-evidence.mjs --sha "${{ github.sha }}" --qcm-scope "$QCM_SCOPE" --require scripts/test-verify-claims.js ...`, so a
skipped suite, an unrun file or a partial run fails the job. `pr-ci.yml` also prints the record to
the job summary. `--qcm-scope full|site|skip` (default `full`) is the PR CI scope tier from `scripts/ci/pr-scope.mjs`: on `skip` the qcm files were deliberately not selected, so files on disk are not demanded, but at least one `--require` is mandatory (the named node tests) and every other check holds; on `site` only the SITE-COUPLED files were selected, so the files of `site-coupling.json` (or `--expect`, repeatable) are demanded instead of every file on disk, an empty, unreadable or stale list fails, and `--require` is mandatory too; an unknown or empty value exits 2. `run-with-evidence.mjs --qcm-scope site` adds those same manifest files to the run. `deploy-production.yml` always runs the full suite. Runner placement follows the same tier: `site` and `skip` run `pr-ci` on `ubuntu-latest`, `full` on `[self-hosted, heavy]` (the fallback of `vars.HM_RUNNER`, which moves it to hosted when set); `HM_PR_CI_RUNNER=self-hosted` forces all tiers to self-hosted (see `pr-ci.yml`'s header). `test_governance_contract.py` keeps both workflows wired this way.

## Engine vs site-coupled (the `site` PR CI tier)

A homepage or site-chrome PR (`index.html`, `partials/head.html`, `params.toml`,
`data/systems.json`, `static/llms.txt`, plus the skip paths: content pages, `static/img|og`, root
docs, `scripts/test_*.py`) cannot move most of this suite. `scripts/ci/pr-scope.mjs` then emits
`qcm_scope=site` and CI runs only the SITE-COUPLED files. Anything under quiet-corners, `static/js`,
`static/data`, `scripts/qcm`, `scripts/ci`, `.github` or `package*.json`, and any path it does not
know, stays `full`.

- **SITE-COUPLED** (listed in `site-coupling.json`): a file that reads the built site (`public/`,
  `helpers/site-server.mjs`), a layout that is not the app's, `content/` outside `quiet-corners*.md`,
  root `data/` outside `data/quiet-corners-maps/`, `site-config/`, `static/llms.txt`, or static
  images / generated CSS, directly or through a helper it imports.
- **ENGINE**: everything else. It reads the app's own files only: `themes/.../static/js`, the
  quiet-corners layouts and their partials (`helpers/layouts.mjs` derives that set by parsing
  `partial` calls, so the homepage and product pages are not in it), `data/quiet-corners-maps/`.
- The list is generated: `node scripts/ci/qcm-boundary.mjs write`. `scripts/test-qcm-boundary.mjs`
  runs in every tier and fails if the list differs from the scan in either direction, so a new test
  that reads the site, or a helper that starts to, cannot stay ENGINE. The scan is textual and
  errs toward SITE-COUPLED (a comment naming a site path counts).
- The `data/systems.json` / `static/llms.txt` claim checks that used to live in `print-proof` are in
  `scripts/test-site-surface.mjs`, so they run in every tier.

## Acceptance manifest

`acceptance-manifest.json` lists the eleven journeys (J01 to J11), what covers part of each
today, the viewports a run uses, and open user reports. `acceptance-manifest.mjs` holds
its rules (`validateManifest`) and `acceptance-manifest.test.mjs` checks both the real file
and broken copies: every `coveredBy` file exists, a `covered` journey names something, and
so on. `coveredBy` means "covers part of it", never "done".

J11 is one reader's session in one browser, held by `session-journey-browser.test.mjs`: 2D
trails and Forest Service roads, then 3D with the dialog's own controls (drag to pan, Tilt up,
North up, Escape back to the 3D button) and the trail found under its drawn line, then roads
off in 2D and gone from 3D, then a reload that brings back the drawn area. Layer choices are not
saved, so after the reload the proof turns trails on again itself. It shares the stubbed
steep-relief network with `terrain-relief-browser.test.mjs` through `helpers/relief-session.mjs`.
With `QCM_SHOT_DIR` set it saves a JPEG of each 3D state there; PR CI sets it and keeps them
for a day as the `qcm-3d-shots` artifact when the job passes. Text scale and focus order are
not part of J11: they belong to the dynamic-accessibility proof (PR #778).

A report moves one way:

1. `unconfirmed`: someone saw it; we have not reproduced it. `unknown` lists what we still need
   to ask. No `closedAt`.
2. `reproduced`: we saw it fail on a build we can name. Needs `buildSha` (40 hex) and an empty
   `unknown`. Still no `closedAt`.
3. `fixed`: re-checked on a named build after the fix. Same `buildSha` and empty `unknown` rules.

## Usability lane

`usability/` holds the advisory usability lane (QA-04): one plain-words task per acceptance
journey J01 to J10, a bounded runner, an independent verifier and a calibration score, run today
on recorded answers with no model and no network. See `usability/README.md`.

## Camera seed refresh log

`node scripts/qcm/build-camera-snapshot.mjs --refresh-seeds` (the only run that asks camera operators
anything) writes `.data/qcm-camera-refresh-report.json` and prints one `refresh-log <id>: ...` line per
provider. The file is a build artifact: `.data/` is gitignored, each refresh overwrites it, and it is
never committed. A seed-only build (`build-site.sh`, `--out-dir`) makes no request and writes no log.

Per provider it holds counts and reasons only, no camera ids and no urls:
`{ id, status, reason, written, checked, kept, droppedBlocked, droppedGone, droppedOther, blocked }`.

- `status`: `written`; `kept-last-good` (the provider failed or was refused, the committed files
  stay); `zero-records` (it answered but nothing survived); `all-blocked` (every checked picture
  answered 401, 403 or 429, so a host is refusing the check, which is not the same as the pictures
  being gone). `written` says whether files were replaced, whatever the status.
- `droppedBlocked` (403), `droppedGone` (404, 410) and `droppedOther` (not an image, the offline
  stand-in, a stale `Last-Modified`, and for the ArcGIS layers a 5xx) are the pictures left out.
  `kept` is every other checked picture. `blocked` counts every 401, 403 or 429 answer, kept or
  dropped (a 401 or 429 has always kept the picture), and is what `all-blocked` compares with `checked`.
- The count fields are `null` for a provider with no picture check (Iteris, Socrata, the NPS list).
  `--only` limits the log to the providers named.

Which answers drop a picture is unchanged; the log only says why.

## Control register

`control-register.json` is the checked-in list of every control on the map page (`/quiet-corners/`)
and the Field Maps docs page (`/quiet-corners/maps/`). Each entry has a selector, one of the quality
plan's eleven control families, a one-sentence purpose, scope, expected effect, keyboard path,
persistence (`saved`, `shared link`, `saved + shared link`, `saved print recipe`, `none`, or
`unverified` when the code does not settle it) and `tests`, the files under `scripts/qcm` that
mention the control (or `untested`, with a reason). `control-register.test.mjs` opens both pages at
1280x800 and 390x844 and fails with the name of each rendered control no entry claims (`unregistered`)
and each entry whose selector matches nothing (`stale`). Entries marked `transient` are controls that
exist only after an interaction (a card's buttons, finder hits, the terrain dialog); they are
claimed by a family selector and are never stale. The `derived` block holds one row per layer
checkbox, context radio and base radio; the test reads the ids from `layer-registry.js` and
`source-basemaps.js`, so a registry row without a register row fails, and so does the reverse.
Add a control to the page and the register in the same change.

## Base-map comparison atlas (plan 4.4: "two base layers look too similar")

- `basemap-atlas-browser.test.mjs` (CI, offline): for every base in `BASES`, scores off and on, with
  synthetic tiles: only that base's tiles show, none linger after rapid toggling, the tiles cover
  the asked bounds, and the county wash is 0 off and the 06a cap on (F29).
- `atlas-metrics.test.mjs` (CI): unit tests for `atlas/atlas-metrics.mjs` and `atlas/atlas-report.mjs`
  on synthetic pixel arrays. No image is committed.
- `atlas/capture-atlas.mjs` (NOT a test, needs the internet): six named public landmarks, every base
  with scores off then on. Needs the built site; takes a few minutes; `--scenes id,id`, `--zoom N`:
  `node scripts/qcm/atlas/capture-atlas.mjs --out /tmp/qcm-atlas` writes `atlas.json`, `REPORT.md`
  and screenshots. Copy `REPORT.md` over `atlas/REPORT.md` to publish a run; it explains its own
  numbers. *Flat* tiles are flags to look at (open water draws flat); *failed* and *bad HTTP* are definite.

## Identify a road or trail (QQA-08)

`route-identify.test.mjs` covers the pure helpers (tap tolerance, the nearest-line hit test,
the card lines); `places-in-view.test.mjs` covers the road groups in the list.
`tap-identify-browser.test.mjs` drives a 390 px touch page over CDP with one fixture trail
and road (Standing Indian and Forest Road 67, Macon County NC; fixtures in
`fixtures/relief-3d.mjs`) and checks that a click, a tap and a keyboard choice from
Places in this view open a card with the same id and title. Road-name lettering takes no
click, so there is no label-click path to test: the test asserts it stays
`pointer-events: none` and out of the tab order.

## Measurements and provenance (QQA-09)

`measure.test.mjs` proves `quiet-corners-maps/measure.js`, the one place a length or an area is computed: Vincenty
length per segment and an equal-area (authalic) sum for polygons, on WGS84, returning fact records
`{value, unit, status, method, basis, geometry, precision, source}`. The reference values are published ones
(Karney's JFK-LHR 5551759.400 m, the 10001965.729 m meridian quadrant, the 510065621.724 km2 total, the equator's
`a*pi/2`, a polar-cap closed form). Where a cheaper method could pass by luck, the test computes that method's answer
and asserts it falls outside the tolerance: haversine for JFK-LHR, Web Mercator and flat degrees for the 60.5 N cell.
Two slanted polygons (a continent-sized quadrilateral and an irregular dateline pentagon) are held to 1e-7 against
values from an independent geodesic integration, which a version that skipped the 50 km pieces misses by 3.5e-5 to
6.9e-4. A hole outside its outer ring is 'unavailable'; a hole touching it is valid. `route-identify.test.mjs` covers the completeness rule
(`routeCompleteness`: every vertex strictly inside `state.fetchedFor`, source coverage `ready`, nothing truncated by
the preview budget, and a source route id) and the card lines; `route-measure-browser.test.mjs` shows both
outcomes on a real card, with expected text built from the fixture's own coordinates. `source-elevation.test.mjs`
and `point-elevation-browser.test.mjs` cover `pointElevationFact` (0 m is a value, no data is `unavailable`) and the
card's provenance text.

Unsupported geometry domains (each returns `unavailable` or `not applicable` with a reason, or is stated here):

- Raster pixels and image areas: only vector line and polygon geometry is measured.
- 3D surface distance (slope length, switchbacks, climbing): length is along the ellipsoid; elevation gain is a
  separate, sampled figure.
- Nearly antipodal segments (about 19,900 km or more): Vincenty does not converge, so the segment is `unavailable`.
- A polygon larger than a hemisphere is measured as its smaller side. A ring that winds once around a pole is
  measured (checked against the cap closed form), and so is one along the equator (a hemisphere either way).
- Geometry that is not a Line, MultiLine, Polygon or MultiPolygon: `not applicable`.
- Invalid polygons: holes larger than the outer ring, or with a vertex outside it (tested in degrees, so a
  vertex within a hair of a long outer edge can be refused), are `unavailable`; self-intersection is not detected, so a
  bow-tie ring is measured as drawn, not refused.
- The 3DEP vertical datum and grid resolution: not recorded in this repo for the elevation samples (the service answers at whatever grid size is asked), so the card says
  so rather than naming one.

## Terrain slope surface: late answers

`terrainSlopeLayer` (`source-terrain-surface.js`) carries a generation number that `cancel()` and every new
`refresh` bump. A terrain answer that lands after the surface was switched off, or after a newer view asked,
is dropped, whether it is a failure or a picture, and including one that lands during the decode: it neither
reports to the row (which would re-add the layer and un-hide the row) nor paints. A reply that will not
decode is reported once as the failed answer, and only while its ask is still the current one. Hillshade
does the same through its fetcher's generation (the late answer is `stale`).
`terrain-surface.test.mjs` holds the cases: decode failure after switch-off, decode success after
switch-off, an older decode landing after a newer ask, and an uninterrupted ask that still reports once.

## Remote reads (QQA-13)

`quiet-corners-maps/request.js` is the one way the map reads from the network. `fetchWithDeadline(url, { fetchImpl, signal, timeoutMs, init, read, anyStatus })` (`read` swaps the body reader, e.g. `r => r.blob()`; `anyStatus` also reads the body of a non-2xx for services whose error answer carries the reason) answers `{ ok, status: 'ok' | 'timeout' | 'aborted' | 'error' }` and never throws. Its timer is a plain `AbortController`, so it works without `AbortSignal.any`, it ends a fetch that ignores its signal, and it clears the timer and the listener on the caller's signal when the call settles. A caller's cancel is `aborted`, never `timeout`. `orThrow(result, message)` is for the few adapters that throw on failure: the body of an ok result, else an Error carrying the result's `status` and `httpStatus` (a caller's cancel keeps the name `AbortError`). `createLatest()` is latest-wins: a new call aborts the previous one and the older answer comes back `stale`. `source-terrain-names.js` re-exports `fetchJson` and `createSearchGuard` from it for the callers that already import them.

The deadline is per source: `SOURCES.<id>.timeoutMs` in `source-registry.js`, `DEFAULT_SOURCE_TIMEOUT_MS` (10 s) unless the source cites a slower measurement in `timeoutMeasured`. GNIS place names keep 20 s because their latency is measured up to 31 s, and the wetlands and government-units layers keep the 20 s page their measurements were taken against. Every module in that directory reads through the helper at its own source's value (the paged boundary and site callers pass it to `pageThrough`; a module with no registry entry, such as the ecoregions export, uses the default; the finder's street-address lookup keeps its own 10 s). `REQUEST_POLICY.timeoutMs` is no longer a request deadline. The quad index pages at most `MAX_PAGES` (20) times and stops on a page that adds no new cell, ending `coverage: 'partial'`; its `timeoutMs` bounds each attempt, including `searchByName`, and a timeout is not retried.

`request.test.mjs` covers the helper (timeout, abort, cleanup, no `AbortSignal.any`, `anyStatus`, `orThrow`, latest-wins); `no-raw-fetch.test.mjs` fails on any raw `fetch(` or `fetchImpl(` call in that directory outside `request.js` (its `ALLOW` list is empty; an entry would fail once it stopped holding a raw call, so the list cannot rot); `adapter-deadlines.test.mjs` hands every adapter that takes `fetchImpl` a fetch that never answers and asserts it settles at its deadline, and that a caller's abort ends it as a cancel, not a timeout (a new `source-*.js` module that takes `fetchImpl` must be added to its table); `build.test.mjs` holds that the build's cancel reaches the aerial, relief and elevation requests; `map-index.test.mjs`, `arcgis-pager.test.mjs` and `registry.test.mjs` hold the quad paging cap, the pager deadline and the per-source `timeoutMs` rule.

`main.js` makes no raw `fetch` call: the camera index and files, the camera still and the base-map tile probe go through `fetchWithDeadline`, and the PDF build is handed `globalThis.fetch` bound. A source-check pass owns one `AbortController` (`state.passAbort`) that `setArea` and `clearArea` abort, and every adapter call in the pass gets its signal, so replacing the area cancels the pass's requests; a pass that was cancelled returns before its catch blocks write source state. The quad-name search is latest-wins (`createLatest`) and says "Searching…" the moment it starts. The aurora and radar answers are checked against their switch after the await, and two quick toggles of the ecoregions layer share one request. `request-races-browser.test.mjs` proves the three that need a real network: it holds requests with `Fetch.requestPaused` and checks (a) two quad searches answered in reverse order show the second, (b) aurora switched on and off before its answer is never drawn (with an on-the-whole-way control), (c) clearing the area mid-pass ends the pass's request as `Network.loadingFailed` with `canceled: true`. Every wait is a condition, never a fixed sleep. It needs the built site (`bash scripts/build-site.sh --configDir site-config --minify`) and skips without Chromium.

## Accessibility checks

`a11y-dynamic-browser.test.mjs` drives the built `/quiet-corners/` app (the Field Maps app; `/quiet-corners/maps/` is its documentation page, checked as one state) offline and holds it to zero axe-core WCAG 2.2 A/AA findings in each state a reader reaches: first load, the dock panels, the phone sheet at half and expanded, the place finder, a name card and the 3D dialog (skipped, said so, when the browser has no WebGL). "Needs review" counts as a finding. A waiver is a row in `EXCLUSIONS` naming the rule, a selector and a reason that is true today; where axe cannot read what is behind a label or glyph the row also carries `plate`, and the test measures that text against its own background itself. It also asserts the keyboard contract (Tab order, focus never hidden, Escape returns focus), 44 px touch targets at 390 px, 200% text without clipping or sideways scroll, reflow at 320 px, and the contrast and backplate opacity of the labels the app paints on the map. Not asserted yet: with the phone sheet expanded, five map controls stay in the Tab order under the sheet (Zoom in, Search places, Share view, Use my location, Map credits).

## Waits, not sleeps

A fixed sleep in a browser proof is a bet on load: it fails on a busy box and spends its whole length on an idle one. `helpers/waits.mjs` has the named waits (`waitInPage`, `qcWait`, `qcMoves`, `qcMeasured`); a proof waits on what its next assertion reads. `chooseExampleArea` waits for the viewport browse debounce to have fired by watching the page's own timers of `VIEWPORT_FETCH.settleMs`, since `main.js` keeps that timer private and exposes no idle flag. The same watch is exported for any delay: `watchTimers(ms, ...)` (install it before the thing that arms the timer, at document start for a page that arms one while loading) and `timersIdle(ms)` (true when no watched timer of that length is pending; it throws for an unwatched delay, so a wait cannot pass for the wrong reason). `choose-example-area-wait-browser.test.mjs` holds that contract.

`no-blind-sleeps.test.mjs` keeps numeric-literal sleeps (`=> setTimeout(cb, N)`, `sleep(N)`) and `settleMs + N` margins out of `panel-shell-browser.test.mjs`, `a11y-dynamic-browser.test.mjs`, `chooseExampleArea`, `browser-port.test.mjs`, `card-over-panels-browser.test.mjs`, `helpers/place-shards.mjs`, `phone-map-chrome-browser.test.mjs`, `print-clear-journeys-browser.test.mjs` and `road-labels-browser.test.mjs`. In those files every millisecond constant is a named `UPPER_CASE` value with a one-line reason. What remains is pacing, not waiting: `POLL_MS` (browser-port's poll interval), `DRAG_STEP_MS` (a drag's step gap), `BURST_GAP_MS` (the gap between the moves of a burst), `FRAGMENT_THROTTLE_MS` and `ROAD_DEBOUNCE_MS` (not pacing: copies of app constants that are the key a timer watch looks the app's timer up by; each file has a source-reading test that fails when the app's value moves, since `timersIdle` cannot tell a moved timer from an idle one). A sleep that is the point of a proof (asserting something does NOT happen) is the exception: write it against the app's debounce constant, not a literal, and say why.

## Leak cycles (QQA-13c)

`leak-cycles-browser.test.mjs` opens and closes the 3D panel once, reads the browser's own counters after a forced garbage collection (`HeapProfiler.collectGarbage`, repeated until two reads agree), runs 20 more cycles (Escape on even ones, the panel's Close button on odd ones) and reads again. `JSEventListeners` and `Nodes` (`Performance.getMetrics`) and the terrain panel's map count must be **equal**, not close. It also holds, exactly: the document has no more `keydown` listeners after a close than before the first open (`DOMDebugger.getEventListeners`); a second press while the MapLibre import is in flight builds no second map; a close during that import builds none for the closed press; a second calibration or key-sheet download revokes the first blob URL once; and a hillshade picture that lands after its layer was switched off makes no blob URL, is not put back on the map and does not rewrite the report row (the slot hands out a `ticket()` before the fetch, and `release()` outdates it). The unit side is `leak-guards.test.mjs` (`createUrlSlot`, `createLru`, `ELEVATION_CACHE_LIMIT`, and a source contract that `main.js` uses them for the two download links, the elevation cache and the hillshade picture).

**Heap, measured (QQA-13c2).** The 58 KB a cycle that QQA-13c recorded was a warm-up step read as a rate, not a leak. Method: the same 3D open/close cycle as the test (Escape on even cycles, Close on odd), Chromium headless on the dev container (software GL, `--disable-gpu`), and at each reading `HeapProfiler.collectGarbage` repeated until two `JSHeapUsedSize` reads in a row agree. One session per run, readings taken as the run went on (a throwaway probe, not kept in the repo). `JSHeapUsedSize` in bytes:

| cycles done | run A | run B | run C (to 101) |
| --- | --- | --- | --- |
| 1 | 31,974,840 | 31,975,920 | 31,979,104 |
| 2 | | | 32,203,492 |
| 3 | | | 32,419,144 |
| 5 | | | 32,643,912 |
| 8 | | | 32,729,448 |
| 10 | | | 33,064,480 |
| 11 | 33,081,560 | 33,082,048 | 33,080,868 |
| 21 | 33,139,212 | 33,141,920 | 33,143,260 |
| 41 | 33,208,000 | 33,216,408 | 33,213,756 |
| 61 | 33,241,768 | 33,244,952 | 33,247,804 |
| 81 | | | 33,265,848 |
| 91 | | | 33,096,216 |
| 101 | | | 33,101,532 |

Reading it: the heap climbs about 1.1 MB over the first ten cycles (1 to 11: +1.11 MB in all three runs), which is code, shapes and caches the 3D view builds the first few times it opens. After that it is flat: cycle 21 to 61 adds 102,556 / 103,032 / 104,544 bytes (about 2.6 KB a cycle, and falling: 51 to 61 adds 2.8 to 9.4 KB), and run C is 41,728 bytes **below** cycle 21 by cycle 101 (the collector freed about 170 KB between 81 and 91). Growth that is still rising with the cycle count would not fall back; this did. Listeners, nodes and maps were flat throughout (the test above). The Chrome heap-snapshot step the follow-up allowed for was not needed: with no growth after forced collection there is no retaining path to find.

`leak-heap-browser.test.mjs` asserts the part the data supports. After a 21-cycle warm-up reading it runs 20 more cycles and requires the settled heap to grow by less than `HEAP_TAIL_LIMIT` = 256 KiB (262,144 bytes). Cycle 21 to 41 measured +68,788 / +74,488 / +70,496 bytes in the probe runs and +73,800, +74,772 and +84,988 in three runs of the test itself (the largest, 84,988, is about 32% of the limit; the spread across the six is about 16 KB). A leak of 13 KiB a cycle or more trips it: with a deliberate 16 KB-a-cycle leak added to the tail loop the test failed with `the settled heap grew 393804 bytes across 20 cycles after warm-up (limit 262144)`. The limit is not a tight leak detector for something under about 13 KiB a cycle; listeners, nodes and maps stay exact for those. Whoever enforces it on another box should re-record the 21 to 41 growth there.

**CI time budget.** `pr-ci.yml` and `deploy-production.yml` cap each test **file** at `--test-timeout=600000`. The heap check has its own file, `leak-heap-browser.test.mjs`, so the 41 cycles it needs (21 warm-up and 20 more) do not share a budget with the 21 of `leak-cycles-browser.test.mjs` and the four import, download and hillshade tests. One run each on the dev container: `leak-heap-browser.test.mjs` 116 s (growth 68,776 bytes), `leak-cycles-browser.test.mjs` 166 s (its 21-cycle test 110 s). The two files' times add up to what the single combined file took before (186 to 301 s over three earlier runs), but each file now uses under 30% of its 600 s cap, so CI contention would have to slow the slower one by about 3.6x before the cap fires. With a deliberate leak of 16 KB a cycle added to `cycle()` the split file failed with `the settled heap grew 413436 bytes across 20 cycles after warm-up (limit 262144)`.

## Helpers

| File | What it does |
| --- | --- |
| `helpers/a11y-dynamic.mjs` | Offline answers for the app's requests, axe-core runner (WCAG 2.2 A/AA), real Tab and Escape key presses, and the focus-visible reading `a11y-dynamic-browser.test.mjs` uses. |
| `helpers/browser.mjs` | Finds Chromium, launches it headless over CDP, `OFFLINE_ARGS` keep it on this box. |
| `helpers/browser-slots.mjs` | Box-wide cap on concurrent Chromiums (`QCM_BROWSER_SLOTS`, default 4). Outside GitHub Actions a process never takes the first `slotReserve()` slots (default half: slot-0/1), which stay CI's; `QCM_BROWSER_SLOT_RESERVE` overrides, 0 gives a local run every slot. |
| `helpers/control-inventory.mjs` | Lists the controls on a rendered page and compares them to `control-register.json`. |
| `helpers/css-class-tokens.mjs` | Pulls class names out of CSS and checks something writes them. |
| `helpers/headers.mjs` | Parses Cloudflare `_headers` and the map CSP. |
| `helpers/layouts.mjs` | Every theme layout and partial as one string, for "is this on the page" checks. |
| `helpers/leak-page.mjs` | The offline network, fresh dashboard page, one 3D open/close `cycle` and the forced-collection heap reading that `leak-cycles-browser.test.mjs` and `leak-heap-browser.test.mjs` share. |
| `helpers/load-pdf-lib.mjs` | Loads the vendored pdf-lib under Node. |
| `helpers/module-server.mjs` | Local origin serving the map modules and synthetic tiles, for offline proofs. |
| `helpers/paused-request.mjs` | Answers a paused CDP request without failing if the page cancelled it. |
| `helpers/site-server.mjs` | Serves `public/` over http; `siteIsBuilt` and `PUBLIC_DIR`. |
| `helpers/test-concurrency.mjs` | Picks `--test-concurrency` from free memory and load, capped at `slots - reserve` so no file queues on a slot it may not take (CI 4, local 2); `QCM_TEST_CONCURRENCY` overrides. |
| `helpers/trusted-click.mjs` | One real CDP click on a target that is visible, uncovered and still. |
| `helpers/waits.mjs` | Waits for named conditions (map ready, data in, example area settled, a watched timer idle) with a readable failure. |

## Production smoke check

`live-smoke.mjs` is a read-only check of a DEPLOYED site. `deploy-production.yml` runs it (step
"Post-deploy browser smoke (Quiet Corners)") once the deploy marker shows the new commit is live,
with `--expect-sha` and `--tolerate-service-errors`, retrying once after 60 s; a second failure fails
the deploy job, which opens the "Deployment failed" issue. `scripts/test_governance_contract.py`
holds that wiring. It is a CLI, not a test (it hits the network, so it must never match CI's `*.test.mjs` glob).
It drives headless Chromium through `helpers/browser.mjs`, adds no dependency and takes a browser slot.

```bash
node scripts/qcm/live-smoke.mjs --expect-sha "$(git rev-parse HEAD)" --out /tmp/smoke   # https://headlessmode.com
node scripts/qcm/live-smoke.mjs --base-url https://staging.example --only marker,roads
```

Options (`--help` lists them): `--base-url` (default `https://headlessmode.com`), `--expect-sha` (the
40-character commit `deploy-marker.txt` must equal; without it the marker only has to be a commit id),
`--out <dir>` (writes `live-smoke-report.json` and a `<check>-failure.png` per failed check; nothing is
written without it), `--timeout-ms` (ceiling for each wait, default 45000), `--only a,b`, and
`--tolerate-service-errors` (exit 0 when every failure is an outside-service error; off by default).
**`--total-timeout-ms`** (default 600000, 10 minutes) is the deadline for the whole run: a check running at
the deadline is cut off and fails, checks not yet started fail unrun ("run deadline reached"). It is the
most a deploy job can spend here, plus a few seconds to close the browser; waiting for a browser slot counts.

One line per check (`PASS`, `FAIL` or `SKIP`, the name, a reason), then a total. A check that passed
but did not run one part of itself, because the feature that part proves is not deployed yet, says so
(`[skipped: address: feature not deployed]`) and carries `skips: [{part, reason}]` in the JSON report;
a passing check without `skips` checked all of itself. **Exit 0** only when one check passed and none
failed; **1** for a failure; **2** for bad arguments. With no Chromium every browser check FAILS (set
`CHROME_PATH` to point at one); a check never passes without having looked.

| Check | Passes when |
| --- | --- |
| `marker` | `/deploy-marker.txt` is a commit id and equals `--expect-sha` when given. A one-off DNS or connection reset is retried once. |
| `pages` | `/quiet-corners/` (the map) and `/quiet-corners/maps/` (the Field Maps guide: sheet heading and a docs block with sections and list items) answer 200 and render. `/quiet-corners/cameras/` is optional: a 404 is "feature not deployed", a 200 must render a heading and a map or list. No such page exists in this repo yet, so that contract (`READY_CAMERAS`) is proved only against a stand-in page; change it together with the real page. |
| `csp` | The dashboard raises no `securitypolicyviolation`, no first-party `console.error`, no uncaught error, and none of its own files fails. Failed outside images (USGS tiles 404 at the edge of coverage), third-party console errors and the Cloudflare analytics beacon (injected at the edge, blocked by our policy) are listed but not fatal. A violation arriving over a second after the page is ready is missed. |
| `search` | "Bryson City" offers a town and choosing it lands the map there. A name search ("Cold Mountain"), once a result is chosen, leaves exactly ONE marker titled with it (#707/#708). A synthetic street address gets an honest message: any note that mentions an address passes, whatever its wording, so real address lookup shipping later does not break this. The old wording ("No town matching/named ...", the finder calling the address a missing town) means the feature is not deployed: it passes with the address part in `skips`. Any other note fails. |
| `layers` | Switching Named places off removes every label, on paints them again, and no label is painted twice in the same spot (two places sharing a name are fine). |
| `roads` | At Sylva NC, zoom 13, at least one `.qcm-road-label` is drawn. When none is, the reason says whose fault: `service error` (the USGS transportation service errored, never answered or sent an error body; `cause: service`) or `our code drew no road labels` (`cause: ours`). |
| `inspection` | Pressing a name label opens its card, naming it. |

Places are public landmarks (Bryson City, Cold Mountain, Sylva); the address is synthetic. `search`, `layers` and `inspection` depend on the live USGS names service, `roads` on its transportation service: an outage shows up as a `service` failure, not a silent pass.

`live-smoke-checks.mjs` holds the checks, argument parsing and exit rule as importable functions.
`live-smoke.test.mjs` runs them against the locally built `public/` with every outside request stubbed
(no network; it needs a built site, see "Build the site"), showing each check pass on a good build and
fail when its target is broken. `helpers/site-server.mjs` takes a `files` option for stand-in pages and
scripts. `QCM_SMOKE_NO_BROWSER=1` makes the CLI behave as if there were no Chromium.

**Not wired into deploy yet.** Running this after `deploy-production.yml` is a separate change to the workflow, made and merged by a person. Firefox and WebKit lanes are not in this slice: the checks drive Chromium over the Chrome DevTools protocol, which those browsers do not speak, so a later slice needs them installed plus a driver.

## The context group: surfaces and overlays

The context rows have no heading of their own since QQA-18: each sits under its task group
(`TASK_GROUPS` in `layer-registry.js`, see below), and they are two kinds of row, which kind
following how a row renders, not what it is about. A row that fills the view as a raster (`rasterSurface` in
`layer-registry.js`: night lights, radar, slope, land cover, tree canopy, the county wash,
the hillshade) hides what is under it, so those stay one radio group (`qcm-context`) with an
explicit **No context surface** (`qcm-context-none`, homed under Map style as the `noContextSurface` pseudo-id; the radios share one `name`, so the choice stays exclusive across headings). A row that draws vector ink on top (NIFC fire perimeters,
air quality, smoke, flood zones, aurora, wildlife) is an ordinary checkbox
(`qcm-layer-<id>`) and coexists with whichever surface is chosen. Ids never change, so an old
share link or saved state that names fire or air quality as its surface (`s=`) still turns
that overlay on.

The map caption (`#qcm-surface-caption`) carries one `.qcm-surface-caption-line` block per
thing on, keyed by layer id so a toggle adds or removes only its own line, inside a box with
a height ceiling (7.5rem) that scrolls. With a surface and every overlay on it stays within
160px at 390px and 1280px wide.

| Proof | What it holds |
| --- | --- |
| `layer-registry.test.mjs` | The surface/overlay split is derived from `rasterSurface`; every context id is exactly one of the two. |
| `layer-presets.test.mjs` | A preset may name one raster surface plus overlays, never two surfaces. |
| `surface-choice.test.mjs` | The radio group in a browser: None at rest, one surface at a time. |
| `context-overlays-browser.test.mjs` | Fire and air quality are drawn together, with or without a surface; old links restore by id; the caption is one line per entry within its height budget. |

## Layer panel task groups

The Layers panel headings are the plan 4.7 task groups, one primary home per layer id:
`TASK_GROUPS` and `TASK_GROUP_OF` in `layer-registry.js` (a presentation map, separate from the
registry `group`, which stays the rendering role: base, federal, state, context, reading, cameras,
extras). A new provider adds a row to an existing task group, never a new top-level group, and
`layer-task-groups.test.mjs` fails when a registry id has no home. `main.js` renders rows by id,
so no layer id, input id, exclusivity or render path moves. `activeOnMapRows` and
`groupsToCollapse` (`layer-panel.js`) decide the **Active on map** list (checked, not a base
choice, not a Print options row) and which groups a cleared search closes again. The count line agrees with that list: `COUNTED_SCREEN_GROUPS` leaves `extras` out, so a print extra never reads as "1 layer on". The list is rebuilt only when its content changes, so a focused Remove or Retry button keeps focus through a fetch re-render. Task presets
(Explore outdoors, Check conditions, Night sky) are not built yet.

| Proof | What it holds |
| --- | --- |
| `layer-task-groups.test.mjs` | The ten headings in order; every registry id, base and the None row has exactly one home; Print options equals the extra-page rows. |
| `layer-groups-browser.test.mjs` | Journey 11: groups collapsed, search by alias, purpose and provider with the expansion restored, activate across topics, find and remove an active layer after filtering, a print extra, an old `#map=v1` link restored by id. |

## Cameras list

The reader-facing Cameras list (QQA-16a) sits inside the collapsed Cameras group, so the closed
panel's length budget is unchanged. Its logic is pure and lives in `camera-layer.js`
(`cameraList`, `cameraListStatus`, `cameraRowText`, `listPlace`, `listLoadState`, `PURPOSE_OF_LAYER`); `main.js` builds the DOM
(`buildCameraList`, `renderCameraList`) and opens a row through the pin's own card. It counts the
camera records loaded for the scope, never the drawn pins, so the 300-pin cap (`MAX_PINS`) does not
trim it; it lists the nearest `LIST_LIMIT` (50) and says how many it holds and why. The scopes are
In this view and Near selected place (`NEAR_RADIUS_KM`, 25: the latest pick, via `listPlace` -- the
finder's pick, else a name or recreation pin or places-list row (`state.nearbyFrom`), else the drawn
area's centre). The near scope's failed, partial and nothing-loaded states come from the files around
its own place (`listLoadState`), not from the map view's per-layer flags. Purposes, one per camera layer id: roadCameras and linkCameras are Roads (linkCameras is
mostly state road-camera links, with HPWREN and AlertWest fire links among them), parkCameras is
Scenery & parks, airportCameras is Weather & aviation, phenoCameras is Wildlife & seasons (it also
holds the volcano and Great Lakes cameras). The list reads snapshot schema 1 only.

QQA-16b adds three things, all in the same list. **Saved** is a third scope: a Save button on each row
and on the camera card writes the camera's ref (`camera:provider:providerId`) to the saved-places
store (`qc-saved-places`), so it survives a reload and sits beside saved places; nothing is put in the
URL, share link, title or analytics. `main.js` reads storage through a guarded getter (`siteStorage`,
and `pageStorage` in `view-wiring.js`) so a throwing `localStorage` gives the honest "Saving
unavailable" state (`SAVING_UNAVAILABLE`) instead of a dead page; `mountSavedPlaces` takes an
`onChange` so the list repaints when saved places change. A saved camera missing from the snapshot
is listed as such (`savedCameraRows` states listed/gone/failed/pending; `savedListStatus`). **Search
this area** (`#qcm-camera-search`) loads the camera files within `SEARCH_RADIUS_KM` (100) of the map's
own centre (a file counts only when its area is within that radius by `kmToBox`, so the square's corners are left out), at most `SEARCH_MAX_FILES` (20), only on press; a newer press wins
(`searchBox`, `searchFiles`, `searchStatus`). **Cluster summary**: below `MIN_PIN_ZOOM` (7) the status
is a per-purpose count of the records already loaded (`clusterStatus`, key `cluster`), never of
drawn pins. A camera saved under an old ref (`LEGACY_REF_ALIASES`) and under its current ref is one
camera: `canonicalCameraRef` (camera-layer.js) is the key the rows, the card and the toggle compare, and
removal drops every stored ref that shares it. `main.js` tracks the open camera card (`openCameraCard`)
and repaints its Save button when a row or the saved-places panel changes the store; the card's press
reads the store, not its own label. Camera snapshot schema 1 and the five layer ids are unchanged.

QQA-16c polishes how the list behaves for a keyboard and screen-reader user. **Focus**: when a repaint
replaces the rows (`paintListRows`) while focus is on a row, it returns to the same camera's row, or its
Save button if that is where it was (rows carry `data-ref`); if that camera is gone it falls to the list
(`#qcm-camera-list-rows`, `role="list"`, tabindex -1), never to the page. **Announcements**: the status
line `#qcm-camera-list-status` is plain text; a separate visually hidden polite announcer
`#qcm-camera-list-announce` speaks `listAnnouncement(status, { searchPending })`, which is null for a
Loading line and while a search is pending, so a settled count is read once and only when its words change,
and one Search press is two announcements (the search status's Searching and its result) plus the list's
settled text. **Near wording**: the near scope's "Listing the nearest N of M" note says to narrow by
purpose, not to zoom in. **Search failure**: a throw after the index read ends the search as "the search
did not finish. Press the button to try again." (`searchStatus` `searchFailed`), never as Searching.
**Saved retry**: after the Saved scope's index load fails, or the index reads and a camera file that holds a
saved camera fails, pressing Saved again, or a change in the saved count, retries once
(`retrySavedFailures` clears `savedIndexFailed` and drops those files from `cameraFileFailed`;
`savedFailedCount` is the count the failure was measured against, so a retry that fails again waits for the
next press or count change); the failed note says so. Nothing in the request path changes: no request
carries a camera, and the address, history, title and share link are the same after a save or a search
(J10t). The privacy guard is `helpers/leak-check.mjs` (`findLeak`): the camera's ref, the older ref, the
`d05:<n>` tail and its name, raw, encoded or `+`-encoded, in a URL or body, plus the bare id as a query
value or body token (a path part is left out because tile coordinates are numbers too). The page-side
recorder in `camera-find-browser.test.mjs` reads fetch (string, URL or Request, with the Request's own
body), XHR and beacon bodies as text, FormData, URLSearchParams, Blob and bytes; a ReadableStream body is
recorded as unreadable. J10x sends each form on purpose and fails if the guard misses one.

| Proof | What it holds |
| --- | --- |
| `camera-list.test.mjs` | The purpose map (five layer ids, each under one purpose), distance and reach box, the view and near scopes, the filter and per-purpose counts, unlocated cameras, every status key, the 300-pin note appearing only past 300, the latest-pick place order and the near/view load states. |
| `camera-list-browser.test.mjs` | Journey 10: a heading, count and real list; the view scope counting 350 cameras while the map draws 300 pins and the list says why; purpose filter and its filtered-out state; the near scope with its stated radius and nearest-first rows; J10d/J10d2: the near scope reads unavailable only when its own place's files failed, and a failure under the map elsewhere does not touch it; J10e: a name pin picked after a finder pick moves the near list to the pin; opening a camera from a row requests one picture; a quiet status (the polite announcer speaks a settled count only); J10m: focus stays on the same row or Save button across a re-sort and falls to the list, never the page, when the row is gone; J10n: the rows are a `role=list` of plain buttons and a repaint of the same count says nothing; zoomed-out, outside-coverage, none, unavailable, loading and images-unavailable states. Every camera request is stubbed. |
| `camera-find.test.mjs` | Pure: the privacy detector (`helpers/leak-check.mjs`) on every carrier form and on near misses; the search box and file choice and its bound, the search status text, the cluster summary counts and note, saved-row states (listed, gone, failed, pending) and the saved-list status keys; a search reads only files within the radius (not the square's corner); `canonicalCameraRef`. |
| `camera-find-browser.test.mjs` | Journey 10 f-i: save from a row and the card, reload, still saved; blocked storage (throwing accessor) shows the saving-unavailable state; Search this area fires one request set and states the radius; below zoom 7 the summary counts match the loaded records; J10j: an open card follows a save or removal made from the list, and its press reads the store; J10k: a camera saved under an old id reads Saved, is not saved twice and is removed whole; J10p: one Search press makes two search announcements and the list says nothing until it has an answer; J10q: a throw after the index read says the search did not finish, clears the pending state and a new press works; J10r/J10s: a failed Saved index load retries once on a later Saved press and on a change in the saved count; J10u/J10v/J10w: the same when the index reads and the camera file fails, and a file that fails again is not read in a loop; J10x: the privacy guard flags a camera sent in a query, path, older ref, tail, name, bare id, or any kind of body; J10t: no recorded request (fetch, XHR, beacon, resource) carries a saved camera (ref, older ref, tail, name or id), and the address, history state, title and share link are unchanged after a save and after a search. |

## Physical print proof

Layout is proven here without paper. Whether a printer honours it is a separate check:
see [PROOF.md](./PROOF.md).

## Quality-evidence bundle (QQA-12)

`evidence-bundle.mjs` checks that a candidate commit carries real journey evidence. A bundle is JSON:

```json
{
  "auditedSha": "<40-hex sha the journeys were run at>",
  "journeys": [
    { "id": "J01", "result": "pass", "artifacts": ["shots/j01.png"] },
    { "id": "J09", "result": "not-applicable", "class": "C", "reason": "renderer cannot draw the sheet; see PROOF.md" }
  ]
}
```

- `journeys` needs one entry for every id in `acceptance-manifest.json`; `result` is `pass`, `fail`, `skipped` or `not-applicable`. `artifacts` is optional.
- `not-applicable` must carry a `class` (`C` = renderer limitation) and a cited `reason`.
- Fails on: no bundle, a missing journey, a `fail` or `skipped` journey, a bare `not-applicable`, and stale evidence.
- **Freshness is per journey and never by ancestry.** Evidence is fresh when `auditedSha` is the candidate, when its tree equals the candidate's tree (`git rev-parse <sha>^{tree}`, so a squash of the same content is fine), or when no file in `git diff --name-only <auditedSha> <candidate>` matches that journey's `invalidatedBy` list in `acceptance-manifest.json`. A journey with no list, or a git failure resolving a sha, is stale. The problem line names the journey and the first changed file that invalidated it.
- `invalidatedBy` entries are exact paths, directory prefixes ending in `/`, or globs (`*` inside one segment, `**` across segments). The manifest validator requires a non-empty list on every journey. Lists are deliberately broad (the app JS/CSS, layouts, data, helpers, the journey's tests); when unsure, add to them.

```
node scripts/qcm/evidence-bundle.mjs <bundle.json> --candidate <sha>
```

Exit 0 when the bundle covers the candidate; exit 1 with one `evidence: ...` line per problem. `evidence-bundle.test.mjs` uses synthetic bundles only and runs in the `scripts/qcm/*.test.mjs` CI glob. Synthetic fixtures prove the validator only; qualification is the real bundle produced by the journey tests on the candidate.

## Address search

`/api/geocode` is a Cloudflare Pages Function (`static/functions/api/geocode.js`, routed by
`static/_routes.json`) that relays one address to the US Census geocoder. `scripts/qcm/GEOCODER.md`
is the decision record for the owner: provider, terms, privacy, measured rural results and known gaps.

| File | What it does |
| --- | --- |
| `geocode-function.test.mjs` | The function against `fixtures/census-geocode-2026-10-08.min.json`: match, no match, bad `q`, 429, 5xx, timeout, bad JSON, the 5-result cap, headers, and that `q` never reaches a body. |
| `qualify-geocoder.mjs` | `--select` builds a rural public-building corpus from USGS; `--run` sends it, one a second, through the function live. Writes `data/quiet-corners-maps/geocode-qualification.json`. |
| `qualify-geocoder.test.mjs` | Checks the helpers, the evidence file's shape and that `GEOCODER.md` quotes its numbers. |

`address-geocode.test.mjs` checks the request, answer mapping, labels and ranking of
`address-geocode.js` (the browser half of `GET /api/geocode?q=`). `finder-geocode-browser.test.mjs`
drives the finder against a stubbed `/api/geocode` (match, no match, 429/502/504/offline/404,
slow then superseded, no leak of the typed address to the URL, title, storage or shared
link, and the Census Bureau notice: shown, at least 12px and 4.5:1, with address rows and the
geocoder's no-match and unavailable sentences, absent for town-only results; and at 390x844, 360x640 and
844x390 inside the box and the map frame once the capped, scrolling box is scrolled to its end). Fixtures are synthetic addresses only; never put a private residence in a fixture.

The notice (QQA-04c) is the Census Bureau's attribution sentence, verbatim: `CENSUS_NOTICE` in
`quiet-corners-maps/search-shell.js`, shown in `#qc-census-credit` inside the finder box by
`quiet-corners.js` with street matches, the no-match sentence and the unavailable sentences (429, 502,
504, slow, offline, endpoint missing), never with town, named-place or coordinate results. The box is
capped to the room the stage has left and scrolls what the cap leaves over, with a two-row minimum for
the suggestion list, so on a short stage the notice is reached by scrolling rather than clipped.
