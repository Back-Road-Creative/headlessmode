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

## Accessibility checks

`a11y-dynamic-browser.test.mjs` drives the built `/quiet-corners/` app (the Field Maps app; `/quiet-corners/maps/` is its documentation page, checked as one state) offline and holds it to zero axe-core WCAG 2.2 A/AA findings in each state a reader reaches: first load, the dock panels, the phone sheet at half and expanded, the place finder, a name card and the 3D dialog (skipped, said so, when the browser has no WebGL). "Needs review" counts as a finding. A waiver is a row in `EXCLUSIONS` naming the rule, a selector and a reason that is true today; where axe cannot read what is behind a label or glyph the row also carries `plate`, and the test measures that text against its own background itself. It also asserts the keyboard contract (Tab order, focus never hidden, Escape returns focus), 44 px touch targets at 390 px, 200% text without clipping or sideways scroll, reflow at 320 px, and the contrast and backplate opacity of the labels the app paints on the map. Not asserted yet: with the phone sheet expanded, five map controls stay in the Tab order under the sheet (Zoom in, Search places, Share view, Use my location, Map credits).

## Waits, not sleeps

A fixed sleep in a browser proof is a bet on load: it fails on a busy box and spends its whole length on an idle one. `helpers/waits.mjs` has the named waits (`waitInPage`, `qcWait`, `qcMoves`, `qcMeasured`); a proof waits on what its next assertion reads. `chooseExampleArea` waits for the viewport browse debounce to have fired by watching the page's own timers of `VIEWPORT_FETCH.settleMs`, since `main.js` keeps that timer private and exposes no idle flag. The same watch is exported for any delay: `watchTimers(ms, ...)` (install it before the thing that arms the timer, at document start for a page that arms one while loading) and `timersIdle(ms)` (true when no watched timer of that length is pending; it throws for an unwatched delay, so a wait cannot pass for the wrong reason). `choose-example-area-wait-browser.test.mjs` holds that contract.

`no-blind-sleeps.test.mjs` keeps numeric-literal sleeps (`=> setTimeout(cb, N)`, `sleep(N)`) and `settleMs + N` margins out of `panel-shell-browser.test.mjs`, `a11y-dynamic-browser.test.mjs`, `chooseExampleArea`, `browser-port.test.mjs`, `card-over-panels-browser.test.mjs`, `helpers/place-shards.mjs`, `phone-map-chrome-browser.test.mjs`, `print-clear-journeys-browser.test.mjs` and `road-labels-browser.test.mjs`. In those files every millisecond constant is a named `UPPER_CASE` value with a one-line reason. What remains is pacing, not waiting: `POLL_MS` (browser-port's poll interval), `DRAG_STEP_MS` (a drag's step gap), `BURST_GAP_MS` (the gap between the moves of a burst), `FRAGMENT_THROTTLE_MS` and `ROAD_DEBOUNCE_MS` (not pacing: copies of app constants that are the key a timer watch looks the app's timer up by; each file has a source-reading test that fails when the app's value moves, since `timersIdle` cannot tell a moved timer from an idle one). A sleep that is the point of a proof (asserting something does NOT happen) is the exception: write it against the app's debounce constant, not a literal, and say why.

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
