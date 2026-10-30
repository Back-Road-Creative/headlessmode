# Headless Mode — Hugo Website

The Hugo site behind [headlessmode.com](https://headlessmode.com). It is the studio
site for Back Road Creative: a storefront home page carrying the full software
roster, pages for the products and tools that have something to show, and
**rigscore**'s manual. Each system documents itself on its own page — there is no
separate documentation hub, and no on-site release section.
The homepage is a showcase rather than a blog and carries no post grid. The
systems themselves live in one data file, `data/systems.json`, which renders
the home page's compact product stanzas and two-line free-tool rows at
`/#software`. The same canonical blurb also heads each system page, so the
homepage and detail copy cannot drift.

## Project Structure

```
site-headlessmode/
├── site-config/_default/     # Hugo config: hugo.toml, menus.toml, params.toml
│   ├── local.toml            # `local` environment overrides
│   └── production.toml       # `production` environment overrides
├── content/
│   ├── about.md              # $ whoami page (aliases /cv/)
│   ├── rigscore.md           # rigscore product sheet — manual/reference/clients/verify on it
│   ├── driftless.md, quiet-corners.md   # product pages
│   └── redactcam.md, sun-track.md       # open-tool demo pages
├── data/                     # systems.json (the roster), rigscore.json (product facts)
├── layouts/                  # Site-level overrides (_default/rss.xml, shortcodes/)
├── themes/headlessmode/      # Custom theme (index.html, partials, baseof) — not a submodule
├── src/css/main.css          # Tailwind entrypoint (compiled to the theme's static CSS)
├── scripts/                  # build.sh, deploy, and the content + rigscore-data validators
├── static/                   # favicons, og/, demo/driftless/, _headers, redirects, robots
└── package.json              # Tailwind CLI + pa11y dev dependencies
```

> The retired predictions-scraper stack (~12k lines of Python plus its data files
> and the root `config` symlink) was purged in #137. Because that symlink is gone,
> **bare `hugo` no longer works** — every invocation must pass `--configDir site-config`.

## Running the Development Server

```bash
hugo server --bind 0.0.0.0 --port 1315 --configDir site-config
```

Or use the wrapper, which also compiles Tailwind first:

```bash
./scripts/build.sh dev
```

Port 1315 avoids conflicts with other Hugo sites in the monorepo (1313, 1314).
On WSL2, `localhost` may not resolve — use the WSL IP that `build.sh` prints.

## Building the Site

CSS is a Tailwind build step: `src/css/main.css` compiles to
`themes/headlessmode/static/css/tailwind.css` (Hugo serves it as `/css/tailwind.css`).
`scripts/build-site.sh` compiles it before Hugo whenever `node_modules` has the Tailwind CLI
(so `npm ci` first in a fresh checkout); `npm run build:css` / `watch:css` on their own are
for style work.

```bash
# CI-equivalent production build
hugo --configDir site-config --environment production --minify

# Plain build (config sanity check)
hugo --configDir site-config
```

Output lands in `public/`.

### Regenerating the Driftless demo

`static/demo/driftless/` is generated from Driftless's fixed fictional seed and
pinned as-of date. It contains the pages `manifest.json` lists (its `pages` count and `source` commit are the record) —
the real server-rendered dashboard, threats, process map, project hub, schedule,
board, wizard and the rest — with scripts, authentication and every write
control removed. Never hand-edit the bundle; regenerate it with
`bin/driftless-bundle-regen.sh <tag>` (checkout/interpreter via
`--driftless-checkout`/`--python` or `DRIFTLESS_CHECKOUT`/`DRIFTLESS_PYTHON`),
which runs Driftless's own generator then validates the result against its
own manifest — no hard-coded page/script counts — and copies the new bundle's
`source`, `anchor` and `pages` into the `demo` block of
`data/releases/driftless.json` (which `scripts/test_release_data.py` holds equal
to the manifest). Review the resulting site diff before committing it.

`scripts/test_driftless_demo.py` reads the bundle's own `manifest.json` as the
contract — page count, script and stylesheet references, and per-file sha256 —
rather than restating it, and checks provenance, internal links, `noindex`,
labeling and the absence of active controls, plus an
offline structural accessibility pass over every page in the manifest (one `<h1>`, `<html lang>`,
named-or-hidden `<svg>`, labelled focusable regions and tables) and that every
`/demo/driftless/` URL in `.pa11yci.json` / `.lighthouserc.json` (the nine
preview-shots pages) is a manifest page. A structural red is a
`driftless-showcase.py` fix upstream — never a hand edit here; the strict
`xfail`s name what the generator still gets wrong.
`scripts/test_driftless_bin.py` covers the `bin/` scripts themselves.
`scripts/drift_probe_demo.py`, run daily by `drift-sentinel.yml`, probes the
live bundle against this same manifest post-deploy: the index and one other
page must match its `sha256` byte for byte once the one line Cloudflare Web
Analytics adds before `</body>` is taken out; `bin/driftless-prod-smoke.sh
<tag>` runs a fuller one-off version of that check against any base URL.

## Release data

Each product's version, release date, demo-bundle provenance and screenshot
provenance are recorded once in `data/releases/<slug>.json` (and, for Band
Coach, `static/img/band-coach/manifest.json` for its screenshots) — see
`RELEASE_LEDGER.md` for the schema. Templates render from these files
rather than from hand-typed prose, and `scripts/verify-facts.js` fails the
build if a product page names a version not recorded there.

A `tier: "product"` entry in `data/systems.json` may also set
`homepage_image` (a path relative to `/img/`) plus `homepage_image_alt`,
`homepage_image_width` and `homepage_image_height`, to show a real capture
in that product's homepage stanza. The image must already have a real
`static/img/<slug>/manifest.json` entry; `scripts/test_homepage_media.py`
checks the wiring and `scripts/test_media_manifest.py` checks the
provenance. Omit the keys entirely for a product with no real capture yet
— never point them at another product's image.

## Creating New Content

Release notes are not written here at all: each project publishes them on its
GitHub releases page — see `CONTENT_GUIDELINES.md`.
Publishing a system is a one-line append to `data/systems.json`; a system only
needs a page of its own when it has something to show beyond its roster entry.

Set `draft: false` when ready. See `CONTENT_GUIDELINES.md` for writing standards
and `LIFECYCLE.md` for the content lifecycle.

## Customization

- **Site config**: `site-config/_default/hugo.toml` (title, baseURL, params),
  `menus.toml` (the main nav — About and Contact; the wordmark is the single
  route home), `params.toml`. The footer's
  GitHub link is not a menu entry: it is hardcoded in
  `themes/headlessmode/layouts/partials/footer.html`.
- **Styling**: edit `src/css/main.css` and Tailwind utility classes in templates;
  rebuild via `npm run build:css` (or `npm run watch:css`).
- **Theme templates**: `themes/headlessmode/layouts/` for base/partials;
  site-level overrides live in root `layouts/`.

### Mermaid Diagrams

Mermaid is lazy-loaded on diagram pages. In a markdown file:

```markdown
<div class="mermaid">
graph TD
    A[Start] --> B[Process]
    B --> C[End]
</div>
```

## Deployment

Deploys to **Cloudflare Pages** via GitHub Actions
(`.github/workflows/deploy-production.yml`): the workflow builds with
`hugo --configDir site-config --environment production --minify`, runs the
Lighthouse / pa11y / htmltest gates and the github.com link check, writes `public/wrangler.toml`, and pushes
the built `public/` to the production branch that Cloudflare Pages serves.
`scripts/deploy-production-local.sh` dispatches that same workflow via
`gh workflow run` and follows it — there is no local build-and-force-push
deploy path.

Per the site's `CLAUDE.md`: ship changes via PR → merge → GitHub Actions. Do not
run the publish flow locally on the user's behalf.

## Tech Stack

- **Static Site Generator**: Hugo (extended)
- **Styling**: Tailwind CSS (compiled via `@tailwindcss/cli`)
- **Diagrams**: Mermaid.js (lazy-loaded)
- **Hosting**: Cloudflare Pages

## Purpose

Publish headlessmode.com: the studio site for Back Road Creative — the home page
roster listing every system built here, the product and tool pages (Quiet Corners,
driftless, redactcam, sun-track), and **rigscore**'s manual.
The Quiet Corners dashboard is served from here too.

## Owner

Back Road Creative ([@joepetjr](https://github.com/joepetjr))

## Status

Active. Deploys to Cloudflare Pages on merge to `master` via
`.github/workflows/deploy-production.yml`, gated on Lighthouse, pa11y, the github.com link
check (`scripts/qcm/check-github-links.mjs`) and htmltest (configured by the tracked root `.htmltest.yml`, which skips `demo/driftless/`: the bundle links between its pages
extensionless, so `scripts/test_driftless_demo.py` proves every one of those
hrefs against the manifest instead). Content is validated before every build — `scripts/validate.sh` runs
the same front-matter, content-accuracy and data-contract checks that
`pr-ci.yml` runs, so a local publish fails for the same reasons a PR does.
Both also hold `content/driftless.md` to a readability bar via
`scripts/copy_metrics.py --links 3`: at most 800 words, Flesch reading ease
at least 60, no sentence over 30 words, exactly three body links, no British
spellings.
`npm run test:html` validates the BUILT site (`public/`, so build first): `scripts/qcm/check-built-html.mjs`
fails an empty build, a page from `menus.toml` or `data/systems.json` that was not built, and any page that
does not tokenize and nest cleanly (unclosed or stray elements; the end tags the HTML spec lets a page omit
are allowed, because the minifier drops them), then it runs the same `htmltest` as CI. htmltest parses
leniently, so on its own it passed both an unclosed `<div>` and an empty `public/`. Last,
`scripts/qcm/check-github-links.mjs` checks the github.com links `.htmltest.yml` ignores, through the GitHub
API, as both workflows do after htmltest: github.com rate-limits page views per IP, and without `GITHUB_TOKEN`
(CI passes the job's) the API allows an IP 60 requests an hour. A missing `htmltest` is a failure, not a skip;
`npm run test:html -- --skip-external` is the one explicit way to run offline, and it says SKIPPED for both
external checks. `scripts/qcm/check-built-html.test.mjs` and `check-github-links.test.mjs` run in CI with the
rest of the `*.test.mjs` glob.
The Field Maps planning engine (`themes/headlessmode/static/js/quiet-corners-maps/`)
is covered by `scripts/qcm/*.test.mjs` under Node's built-in runner —
`node --test "scripts/qcm/*.test.mjs" scripts/test-verify-claims.js` — run by
`validate.sh`, `pr-ci.yml` and `deploy-production.yml` alike; a new
`*.test.mjs` there needs no wiring (`scripts/test-verify-claims.js`, the
offline tests for `verify-claims.js`, is outside the glob and named explicitly).
Every Chromium those tests start takes `OFFLINE_ARGS` from `scripts/qcm/helpers/browser.mjs`:
it resolves no host but 127.0.0.1 and uses no proxy, so a slow or silent outside server
cannot hold a page's load event, and a test about an outside service answers that
service's requests itself. `scripts/qcm/browser-offline.test.mjs` fails a start without them.
A missing browser or build FAILS a CI run instead of skipping it: under `CI=true` (GitHub Actions
sets it) or `QCM_REQUIRE_BROWSER=1`, `findChromium()` throws when `CHROME_PATH` names a missing file
or no Chromium is found, and `siteIsBuilt()` in `helpers/site-server.mjs` throws naming the missing
`public/<page>/index.html`; the ~60 test files that import them need no edit, and the file fails at
import. Off CI with no opt-in a missing browser or build still skips, so the pure tests run without
Chromium. `scripts/qcm/browser-preflight.test.mjs` holds the rule. `QCM_REQUIRE_BROWSER=1` rehearses
CI locally.
`launch()` rejects a navigation Chromium could not complete, naming Chromium's reason,
rather than resolve on Chromium's error page; and a wait that runs out ends on what the
page was doing: where it is, which of its own requests failed, and what it threw
(`PAGE_STATE` in `scripts/qcm/helpers/waits.mjs`, held by `dashboard-load-failure.test.mjs`).
The dashboard's start-up (map, then last-job restore) always gets `WAIT_MS` (60 s) from
`readyDashboard()`, whatever shorter `ms` a proof passes: a proof's 20 s `CEILING` is
the budget for its own steps, not the time a loaded box needs to start the page
(`startupBudget` in `waits.mjs`, held by `ready-dashboard-budget.test.mjs`).
A start-up that stalled -- the page loaded, scripts of its own got no response at all, and
`main.js` never began `start()` -- fails at once rather than after 60 s, and `readyDashboard()`
reloads the page ONCE; a second failure is final and says it came "after one reload", naming
the files (`STARTUP_STALL` in `waits.mjs`, held by `dashboard-load-failure.test.mjs`). A file
that answered 404 is a broken build and is not retried.
Sun and Moon timing is its own module with its own owner,
`themes/headlessmode/static/js/quiet-corners-sky/sun-moon.js`: sunrise, sunset, the
civil/nautical/astronomical twilight boundaries, moonrise, moonset, illuminated fraction and
moon-above-horizon intervals for any latitude, longitude, date and IANA time zone, computed
from Meeus with no provider, network or key. No-rise, no-set, polar day and polar night are
`state` strings beside a null time, never errors. `scripts/qcm/sun-moon.test.mjs` holds it to
U.S. Naval Observatory values recorded with their request URLs in
`scripts/qcm/fixtures/usno-sun-moon-reference.json`.
The reader-facing side of it is `quiet-corners-sky/tonight.js`, which turns one engine
result into the five lines of the dashboard's "Tonight's sky" card — the Sun, full
darkness, the Moon, the hours the Moon is above the horizon and how much of it is lit,
each its own fact, with every no-rise/no-set/polar state written as a sentence. There is
no cloud or wind line: the forecast card is a separate unit, and a dark sky is not a
clear one. Its times are stamped in the PLACE's own zone — the IANA name the NWS `/points` response carries, handed over the
moment that first response lands so the arithmetic never waits on a forecast. The forecast card at the foot of the same file
adds wind and gusts from the `forecastGridData` product, whose values cover ISO 8601 intervals rather than hours and are spread
onto an hour grid and matched by timestamp because each field has its own run boundaries and entry count; cloud cover is not
wired yet. `tonight-strip.test.mjs` and `weather-hourly-card.test.mjs` in `scripts/qcm/` cover the wording.
Where you may stop on BLM land is its own layer, `quiet-corners-maps/source-blm-rec-sites.js`: the 1,304 recreation sites
the Bureau publishes nationally, each a point carrying the agency's own directions, its own page URL and the last-updated date
that record states. It is not a stargazing index — the source's night-sky wording appears in 3 of those 1,304 records — so the
claim stays on access. `scripts/qcm/blm-rec-sites.test.mjs` gates both risks: the two text fields are raw provider HTML, so
`plainText()` is their only door to the page and the test feeds it a script tag, an `onerror` handler and a `javascript:` link;
and every string the module or the layer registry can show a reader, template literals included, is scanned for a Bortle class,
a sky-quality score or a 1-9 rating.
Those lines reach a reader through a CARD: `siteLines()` writes them onto the site, `previewSites()` carries them to the mark, and
`identify()` in `preview-overlay.js` binds them to the pin as a Leaflet popup that Enter or Space opens, Escape shuts and focus
returns from — a Forest Service site carries no lines and keeps the plain tooltip it had. It is built one text node per line, never
as markup, because those two fields began life as provider HTML; `site-card.test.mjs` drives a real pin in headless Chromium with
real keydown events and feeds it a record carrying a script tag and an `onerror` handler.
The light-emissions context surface is `source-night-lights.js`: NASA Black Marble, WMTS
tiles from NASA GIBS with no key, declared once in `layer-registry.js` as the `context`
group's one member and gated by `scripts/qcm/night-lights.test.mjs`. Its tile path is
`{z}/{y}/{x}` — the service's own `{TileMatrix}/{TileRow}/{TileCol}`, reversed from the order
every other tile source here uses, so swapping the two draws a tile from elsewhere on Earth
with no error. The set stops at level 8, where level 9 answers HTTP 400 with an XML body
rather than an empty tile, so `tileUrl()` refuses it and `maxNativeZoom` upscales level 8
while the row says the picture is enlarged rather than sharper. The newest
composite is 2016, which is why the year sits in the layer's own label and in the on-map
credit; `screenOnly` is the raster counterpart of `extraPage`, keeping the surface out of the
overlay fetch and off every sheet. The plan's one prohibition is gated rather than commented:
the test extracts every string LITERAL from that module and from `layer-registry.js` and
fails on a Bortle class, a sky-quality score or a 1-9 rating.
Two switches answer in WORDS and draw nothing, which is why they are a group of their own,
`reading`, rather than overlays whose hint promises ink. `source-padus.js` reads USGS PAD-US
for the access category a land manager FILED — Open, Restricted, Closed or Unknown, in the
service's own wording. Unknown is the one that has to be decided rather than inherited: the
layer's own renderer defines classes for the other three only, so a picture drawn from its
symbology drops the 43,047 records that carry it. Three measured traps are gated by
`padus.test.mjs` against real response bytes: a bad request answers HTTP 200 with an error
object and no `features` key, so `res.ok` is never consulted; a 105,513,892-acre
`Non-PAD-US Area` filler stands in for everything outside the lower 48 and is excluded in
the WHERE clause and dropped again on arrival; and `GIS_Acres` is the WHOLE unit's area, so
it is printed per named unit with that clause attached and never summed over an extent.
`source-ecoregions.js` names what kind of country a place is, from a COMMITTED copy of EPA's
Level III layer rather than from EPA at request time — the national geometry request is
refused outright (HTTP 500, HTML body) unless it carries a generalization parameter, so
baking that into `static/data/quiet-corners/ecoregions-l3.json` removes the failure instead
of guarding it, and the data has not moved since December 2011. `scripts/qcm/gen-ecoregions.mjs`
rebuilds it by hand and records the request; `ecoregions.test.mjs` holds the file at its
measured 85 features and 949,718 bytes, proves the regions are a partition so nothing can
double-count, and proves no EPA host reaches the generated CSP.
Print layout is gated there with no paper: `sheet-plan.test.mjs` holds a
coverage floor on the map frame's share of the sheet, and `browser.test.mjs`
builds a real PDF in headless Chromium, checks the frame, header and footer
land at their computed points, and proves a seam by comparing the overlap
strips of two adjacent sheets pixel for pixel.
The point symbols have ONE definition, `markerPath()` in `pdf.js`, and three
consumers -- the printed sheet, the Leaflet preview and the on-page key.
`preview-overlay.test.mjs` and `legend-view.test.mjs` each re-derive a symbol's
outline from that function and demand the drawn shape match it, so a campground
cannot print as a triangle and appear on screen as a circle again (audit F10).
The dashboard's own layout is gated the same way: `layout.test.mjs` serves the
built `public/` over `helpers/site-server.mjs` and measures `#qc-map` in the
browser at 1440, 1024 and 768px, with the print panel shut and open. It exists
because the panel used to be a flex sibling of the map and opening it took the
map to zero pixels wide — a failure `preview-overflow.mjs` cannot see, since a
collapsed map makes the document no wider. The two-column layout starts at
1024px, where all four panels sit in a dock column beside the map and the map
column keeps at least 480px; `dock-layout-browser.test.mjs` hit-tests that no
panel is painted over the map, whichever is open.
`phone-controls.test.mjs` asks the other half of that question at 390x844:
every input, select and button under `#dashboard` -- the wrapping `<label>`
where there is one, because that is what a thumb lands on -- has to measure at
least 44px both ways and answer `elementFromPoint` at its own centre, and
anything you type or pick into has to carry 16px text, below which mobile
Safari zooms the whole page on focus. Both numbers are the ones
`find-and-scale.test.mjs` already holds the map's finder to.
`panel-chrome.test.mjs` asks whether those controls look like controls at all.
Tailwind's preflight strips a button and a select back to a transparent box with
a zero-width border, so each one needs this site's CSS to put the chrome back --
and the rule that did was keyed on a `.qcm-app` CLASS while the print panel
carries `qcm-app` as an ID. It matched nothing, invisibly, and ten buttons and
selects rendered as bare text on a dark panel. The chrome is written once now,
on `.qcm-controls`, the wrapper both panel partials emit; the test measures the
rendered background and border of every control in both panels, so a control
added under a selector nobody checked fails rather than ships silently.
Density is two questions, not one. A layer declares the coarsest scale it is
readable at (`dropBelowScale` in `layer-registry.js`), and the PAPER answer uses
the recipe's scale — parcels are 1:24,000 only, because one test rectangle in
Delaware holds 26,863 of them and at 1:48,000 they stop being lines and become a
filled rectangle. The SCREEN answer is `screenScaleDenominator(zoom, lat)` in
`preview-overlay.js`: what one CSS pixel covers on the ground, at 96px to the
inch, halving with every zoom level. Gating the screen on the paper scale is
what audit F12 found — a reader on 1:48,000 paper who zoomed down to one ridge
saw no parcel lines at all, with the layer on, the data fetched and nothing
said. When the screen carries something the sheet will drop, `#qcm-preview-note`
names the layer and the paper scale rather than letting the reader find out in
the PDF.
The app knew where the gravel roads were and where the campsites were and never
said the two together, so "is there a gravel road near this site?" could only be
answered by eye, one road at a time. `near-unpaved.js` joins them: a recreation
site's tooltip now carries how far the nearest inventory-stated unpaved road is.
Three rules it will not bend, each with a test that fails when it is broken.
Only a STATED surface counts, so a road Road Basic never matched, one two records
disagree about, and a surface code the parser could not read are all equally not
gravel. The phrase says **straight-line** every time, because nothing here routes —
no network, no legal-access model, no cost model — and the plan is explicit that a
distance may not imply a drive until a path has actually been calculated. And a
miss says nothing at all: the search saw the roads fetched for one rectangle, so
"no unpaved road nearby" would be a claim about ground nobody looked at. The
distance itself is measured to the nearest point ON a segment, not to its nearest
vertex — a road you are standing over the middle of used to measure as far away as
its far end. One more gate reads `main.js` and fails unless `renderOverlay` actually
hands `previewSites` the roads, because composing the answer and never passing them
leaves every other test green and the reader with the tooltip they already had.
Live radar, `source-nws-radar.js`, is the other screen-only raster: NOAA's MRMS base-reflectivity
mosaic, key-free, from an ArcGIS ImageServer with no tile cache at all (`/tile/5/12/8` answers a
404, and the service description carries no `tileInfo`). So the picture is an `exportImage` composed
per view rather than XYZ tiles, and `radarLayer().refresh()` has to be told when to redraw instead
of leaving it to Leaflet. `scripts/qcm/nws-radar.test.mjs` gates that request geometry -- a wrong
`bboxSR` draws the right rain in the wrong place and nothing else notices -- and the export ceiling
of 15000x4100, which is the service's own and refuses rather than shrinks.
Age is what the switch brought with it. The service holds a rolling window measured at
118 minutes and nothing older, which makes this the only surface on the map whose
honesty decays while you look at it. Every reader-facing string goes through
`frameVintage()`: a frame states the UTC time it was valid and how long ago that was, a
frame past `STALE_AFTER_MINUTES` says it is too old to act on instead of being drawn as
current, and a service that will not state a time is reported as unknown rather than
assumed fresh. `renderRadar` in `main.js` re-reads it on every redraw rather than writing
it once when the switch goes on. The prohibition is gated too: base reflectivity is an
observation, so no string this layer can show -- template literals included, because a
backtick label is read exactly as a quoted one is -- may offer a forecast. The hourly
card answers the hours ahead.

The aurora source is the same discipline pointed the other way. Radar is an
observation and may never be dressed up as an outlook; OVATION is an outlook -- its own
`Observation Time` and `Forecast Time` measured 66 minutes apart -- and may never be
dressed up as a look at the sky. `forecastHorizon()` is the only route a reader-facing
string takes and it always names the forecast time and the word forecast. Two more
facts come from the payload rather than from the radar work: its longitudes run 0..359,
so a US longitude of -90 is 270 and `toSignedLon` is load-bearing rather than tidy; and
it is ~900 KB for the whole globe that reads flat zero over the lower 48 on almost every
night, so it is fetched only when asked for and "nothing forecast here" is reported as
the ordinary answer instead of a gap. The switch that turns it on draws the model's own
1-degree cells -- roughly 110 km a side, far coarser than any area you would draw --
and only where a cell is above the floor, because a box a reader can see is a box a
reader will read something into. `areaReport()` writes the row, and it always leads
with the forecast time: a peak stated without its horizon is exactly the misreading
this source exists to prevent. The grid is fetched once when the switch goes on and a
pan redraws what is already held.

The air quality source is gated on a CLAIM rather than a tense: AirNow's contour records carry
`gridcode` and nothing else -- no pollutant field, no index value -- so `categoryText()` names the
service's own category and carries no digit, while `frameVintage()` reads the hour off the record.
Its switch is the one reader here whose question is BOUNDED -- radar hands Leaflet a URL for the
view and aurora re-indexes one global file, but this is a bbox query, so a pan is a NEW question.
`aqiReader()` asks it again, debounced so a drag costs one request, and abandons the in-flight one
the moment a newer view asks. `areaReport()` leads with the HOUR, because latest ran 144 minutes
behind the clock at the probe; `LAYER_CAVEAT` carries EPA's own two warnings about that surface.

A road answers with what the inventory said about it. Road Basic already fetched a
maintenance level and a surface type for every road the app draws and spent both on
one thing — how thick to draw the line — so two grey lines of the same weight, one
gravel and one needing high clearance, read identically with the answer already in
the browser (audit F13). `roadDetail()` in `source-road-basic.js` composes that into
the tooltip, and the words are the service's OWN: `maintenanceText`/`surfaceText`
keep the prose the record carries after its code (`3 - SUITABLE FOR PASSENGER CARS`),
sentence-cased, rather than a phrase this page invented for a level nobody here has
measured. A route two records disagree about says so instead of picking a side — the
join table already refused to choose, and the reader is owed the same refusal in
words. An unmatched road says nothing extra, because an empty rating clause would
read as "the inventory looked and found it ordinary".

MVUM answers the other half of that question, and nothing consumed it either.
The adapter has normalized `passengervehicle`, `highclearancevehicle` and both
`_datesopen` windows since it was written, and nothing consumed them: the only
thing a season ever changed was the dash pattern, so a road open to high-clearance
trucks between April and December drew the same as a road open to anything all
year. `mvumAccessText()` puts that on the tooltip — "Open to passenger cars
Apr 1 – Dec 15" — for trails as well as roads, because MVUM is motor-vehicle data
by definition and its trails carry the same fields. Only a stated value counts,
which cuts both ways: a blank is the inventory not answering, so it is never
reported as a ban and never as a permission, and `open` with no window on a route
the source itself called seasonal says the dates are not stated rather than
year-round. No year is ever printed, because the window recurs.

The printed key used to say `Forest road, seasonal (dates on sheet when supplied)`
and no module ever wrote a date to a sheet — `summarize()` collects the windows and
nothing but its own test calls it. The label was cut back to what the dash means,
and the dates were then written where it had been pointing. `seasonalWindows()` groups the drawn routes, keeps every distinct window
a route's segments stated, and `deriveLegend` puts them on the key under **Seasonal
routes**; `layoutLegend` paginates them beside the notices and the source credits.
The label promises again because the dates are now there, and the gate on it is
two-way: if the swatch points a reader anywhere, a legend built from stated windows
has to carry them.

Routes the source called seasonal and dated nothing are **counted, not dropped** —
"2 more seasonal routes here: the source gave no dates for them." A list of only the
dated ones would read as "these are the seasonal roads here", and a reader would
drive an unlisted one in February on the strength of it. Segments of one route can
carry different windows and both are kept, because choosing between them would
invent a road that opens on a date the source never gave for that stretch. Every
printed string here is ASCII: the PDF's standard fonts cannot encode an en dash and
substitute `?` without complaint, which is why `pdf.test.mjs` asserts no drawn text
contains one.
Everything drawn on the preview answers what it is. #443 gave the recreation
sites a tab stop and an Enter handler; roads, trails and every land boundary
stayed `interactive: false`, which makes a bound tooltip unreachable by a click,
a tap or a keyboard alike. `previewPolylines` now emits a `title` per line — the
feature's own name when the source gave one, and always what KIND of thing it is,
because "State game land" versus "Parcel boundary" is the question a reader has
when two grey lines cross — and `identify()` in `main.js` puts that title on the
SVG path as a tooltip, an `aria-label` and a tab stop. The path only exists
because the overlay carries its own `L.svg()` renderer: the dashboard's map is
built `preferCanvas: true`, and a canvas-drawn vector is clickable — the renderer
hit-tests — but is not in the document, so there is nothing to give a tab stop
to. Without the renderer the whole fix is silently inert on a keyboard while
looking correct to a mouse.
The three companion sheets (`extraPage` in `layer-registry.js`) sit in the same
list as the layers that draw and change nothing visible when switched on: what
they add is a page in the PDF. Their control now says so, wired to the input by
`aria-describedby` like every other layer note.
The panel's group hints are read in the same place — on screen, by someone looking
at the map — and three of five answered about paper instead. "Drawn on every sheet"
described a PDF that has not been built yet when what a reader is about to see is
ink appearing on the map in front of them; "their own pages at the back" left the
kind of page unsaid in a panel where two other hints mean a page of that PDF. State
land was worse than vague: it promised "that state's own page", and the per-state
pages were retired (`state-pages.js` `mapRulePaths` returns the one dashboard path),
so the sentence pointed somewhere that no longer exists. Each hint now says what its
switches do to the MAP first and to paper second, and `layer-registry.test.mjs` holds
it there: a hint that mentions paper must also mention the map, and "page" is reserved
for a page of the PDF.
A control throws away only what it can actually have changed. Every vector layer
is fetched for one thing, `recipe.bboxLonLat`, so ticking a layer on or choosing
landscape cannot change an answer already in hand — yet `resetSources()` ran on
both, blanking the map and asking for another Check sources for data already
downloaded (audit F11). `sourcesInvalidatedBy(change)` in `app-state.js` is where
that reasoning lives: nothing for orientation, overlap, grid, title or a layer
toggle, and `usgsTopo` for scale and DPI, which set the sheet's
metres-per-pixel and so pick the tile level (`build.js` `tilePlan`). A NEW AREA
still resets everything, because a new box makes every fetched answer wrong.
Browsing the map is now its own question, separate from the print recipe (the
other half of F11). Once the map stops moving for `VIEWPORT_FETCH.settleMs`,
`viewportFetchPlan()` decides what a settled viewport should ask for: nothing
below zoom 9, where the topo base is not drawn at all; nothing over
`maxAreaKm2`, where the vector services return a truncated answer that looks
complete (F14); nothing for the base map or an extra sheet, which are not
overlays; and nothing at all when the view sits inside the box already fetched
AND every switched-on layer was in that answer — the second half is why a
freshly ticked layer still loads while panning. `checkSources()` takes that box
directly, so no area has to be drawn first, and it clears only the fetched data,
never the drawn overlay, so the previous features stay on screen until the new
ones replace them. What makes this safe to print from is `state.fetchedFor` plus
`sourcesMatchArea()`: a build whose recipe box is not exactly the box the sources
came from re-asks before it renders a single sheet.
Every writer of that source state goes through one queue, `sourcePassQueue()` in
`app-state.js`: the Check button, a build's re-ask, the viewport browse and a
row's Retry. A pass asked while another runs waits its turn, and a browse that
comes due mid-pass is dropped and planned again once the queue is idle, because
it was planned against state the running pass is replacing. Before the queue,
choosing the example area and pressing Check at once ran both passes side by
side, and a badge read whichever finished last (2026-09-26, #567 and #571).
`layer-panel-browser.test.mjs` holds each govunits answer back so the browse always
comes due mid-pass, and fails if more than one pass's requests are out together.
An ArcGIS `/query` answers one page at a time and says so in
`exceededTransferLimit`; `arcgis-pager.js` loops until it stops saying so (each page
under `request.js`'s deadline, so a service that never answers ends as an error) and
reports `coverage`, 'complete' only when the service ran out of more. Every
adapter returns that word and `main.js` reads it — except that the recreation-site
and trail blocks used to write `state.states.<layer> = 'ready'` whenever the fetch
did not throw, and `fetchTrails` did not page at all, so a rectangle past the
transfer limit printed a sheet missing trails while the source panel called the
layer ready (audit F14). `layer-readiness.test.mjs` reads `main.js` itself and
fails on any `'ready'` that was not decided from a coverage report, because the
defect is not in one layer — it is in deciding a state without asking. A layer
that reports 'partial' blocks the print (`canBuild` in `app-state.js`): a
truncated set is worse than none, because it looks finished on paper.
`dashboard-candidates.test.mjs` measures the candidate table the same way: it
waits for the ~1.8MB candidates file to land, presses Enter on a row, and reads
what the map did about it — the row used to have a mouse handler and nothing
else, and flew to a zoom one level below the one the topo base turns on at.
`dashboard-places.test.mjs` holds the distinction between a town that exists and a
town that qualifies: the place layer draws to its own Leaflet pane, so what it
painted can be read off that pane's canvas even though the markers are not in the
DOM.
`place-labels.test.mjs` holds F05: the map knew 1,574 place names and showed none
of them. It measures the rendered labels rather than the code -- that names appear,
that no two boxes overlap, that zooming out sheds the small towns first (one greedy
pass by population is the whole hierarchy), that names survive a filter matching
nothing, and that the national view carries names before anyone touches the map.
That last case is the one the other four missed: they all call `setView`, which
fires the `moveend` the labeller listens on.
Those 1,574 names are all SMALL towns, though -- `candidates.json` is the scored
export, so the national view named 47 places a reader has never heard of and nothing
to locate them against. `navigation-places.json` is the other half: 347 large places
the pipeline scores out, carrying a curated `display_name` ("New York", not "New York
city") and a `tier` that is a population band. Both feed one greedy pass, majors
first, and orientation is capped at 24 labels a view -- a frame, not the content, or
S4c would answer one audit finding by erasing the layer of another. Hierarchy is read
at the lower quartile rather than the single smallest label: the tail is one straggler
filling a gap, and after this change it inverted by four people while the quartile
went from 1,303 to 2,366.
`places-index.json` and `places-<ST>.json` (52 files) are the third half: every Census place, ranked by population, one shard per state (`fields` = geoid, display_name, lat, lon, population), with the index carrying each state's bbox and count, plus `places-national.json`, the head of that ranking (1,500 rows, state per row) fetched once below the shard zoom. They are pipeline output (exported by svc-quiet-corners), committed as produced and never hand-edited; `scripts/test_data_contract.py` pins the shard total and names Franklin NC and Stevensville MT.

Those two files still left a gap between them: a mid-size place such as Franklin NC
(Census place 3724640, 4,362 people) is above `candidates.json`'s 1K-3K window and
below `navigation-places.json`'s 100K floor, so it was lettered nowhere. The third
source is the per-state place shards: `places-index.json` (`{ST: {bbox, count}}`,
bbox as west, south, east, north) and one `places-<ST>.json` per state
(`{state, fields, places}`, compact rows named by `fields`) holding every Census place
with coordinates. `quiet-corners.js` reads them lazily -- no state shard below zoom 6, and a
state only the first time the view reaches its bbox -- and a failed request draws
nothing for that tier and leaves the others drawn. Shard places enter the greedy pass
as tier `local`; a place whose GEOID is already in `candidates.json` or
`navigation-places.json` is dropped. Towns and locals are ONE population-sorted run
with no population constant on the client, so a 4K town now outranks a 1.2K one
whichever file it came from (before, every `candidates.json` row outranked any
other source). `place-labels.test.mjs` holds the gates, serving fixtures from
`scripts/qcm/fixtures/places-*.json` through `scripts/qcm/helpers/place-shards.mjs`.
Below zoom 6 that left a second ladder: no shard is loaded there, so the town pool was
`candidates.json` alone and zooming out *added* small towns instead of shedding them.
`places-national.json` is the head of the same ranking (the 1,500 largest estimated
places, state per row, ~80KB), fetched once from the first label zoom; a head row is
dropped once its state's shard is in, so a national view and a regional one rank from one
list. Below the shard zoom a `candidates.json` town under the head's own last row is a
rung the view has not loaded yet and waits for its shard (the floor is the head's tail,
not a constant; no head, no floor). `scripts/test_data_contract.py` holds it to a ranked slice of the shards.

`name-journeys.test.mjs` is the guard over both names reports (Franklin NC unlettered, Stevensville MT blanked): for each town at zoom 8-14 it asserts that the names row is never refused by `viewportFetchPlan`'s zoom or area gate, that the plan asks only kinds whose floor the zoom reached, that the dashboard letters Franklin from the committed NC shard with the names row off, and that Stevensville draws names (never over-cap or "zoom in") with the Bitterroot River placed. It bit on arrival: the shard column is `display_name`, which the client did not read.
`find-and-scale.test.mjs` holds F20's navigation half -- a distance scale in
miles, and a way back to the whole country -- and one gate that measures
reachability rather than geometry: it opens both overlay panels and asks
`elementFromPoint` who is on top of each control. That gate is there because the
zoom buttons were already buried under the print panel and every existing test
passed, since a test clicks an element directly and a reader cannot. The search
gates in the same file read the full 1,574-place export rather than the filtered
candidate list, so a town the ranking rejected can still be looked up.
`address-detect.test.mjs` (the pure detector in `search-shell.js`) and
`finder-address-browser.test.mjs` hold the finder's honesty about street addresses: it
has no address lookup, so a typed address is answered with that fact and what does work,
never with "No town matching ..." and never with a nearby town, and the Search button
sends an address nowhere. The address shape is only a guess and a name always outranks
it: names that carry digits, `#`, `Unit` or a route number ("Lake Unit 4", "Springfield
#2", "Highway 441", "Forest Road 4652") are not address-shaped, and a name the town list
holds is listed even when it is ("88 Quarry Lane"); the address message is what an
address-shaped query gets only when nothing by that name was found. Fixtures are synthetic. `finder-surface-browser.test.mjs`
measures the finder as one opaque panel at 390x844 and 1280x800 (16px input text, alpha-1
background, 44px phone targets, nothing painted through it).
`finder-loading.test.mjs` holds the second before that export lands. The search box
works as soon as the map does, and until `candidates.json` arrives every name missed
-- answered with "No town matching X is in this list", a sentence that asserts a list
which had not been read yet and is indistinguishable from the reader's own typo. It
says the list is still loading now, and the arriving export re-runs a search already
on screen, so the answer changes without another keystroke. The window is held, not
raced: `helpers/site-server.mjs` takes a `hold` pattern and PARKS those requests until
`release()`, so the page sits in the state under test for as long as the assertions
take (its `fail` and `drop` patterns answer 404 or hang up, for a page whose own files
fail). One of the three gates reads the answer out of Chromium's accessibility tree
rather than the DOM, because what an assistive reader gets is a computed tree.
`field-zoom.test.mjs` covers the moment the map changes subject: at `FIELD_MIN_ZOOM`
the USGS topographic base turns on, so the county wash and the ranked choropleth --
both now in a `qc-counties` pane of their own -- drop to 0.2 and the map key stops
describing a national score ramp the reader can no longer see. It drives the map
through `window.qcMap` and reads the pane's composited opacity, not the source.
Those tests skip themselves when `public/` has not been built.
`map-color-by.test.mjs` covers the **Color the map by** control (audit F19): one
`COLOR_METRICS` table drives the choropleth, the fallback dot sizes, the legend
title, the band labels and the select's own options, so the key cannot describe a
ramp the map is not drawing, and a hand-written `<option>` in the template fails
the gate. It also pins the second half of that fix — `c.stability_score || 0` used
to paint a county whose score was never computed into the bottom band, and unknown
now has its own swatch and its own key row. Like `county-filters.test.mjs` it
extracts the shipped functions out of the IIFE by bracket matching and evaluates
them, so there is no second implementation to drift.
`sort-labels.test.mjs` is the other half of F19: each table states its sort in
words and marks the active heading with a caret and an underline as well as the
accent colour. It fails if the cue goes back to colour alone, if a text column is
described as a quantity, if the label swallows its own tooltip, or if the default
sort ships unannounced.
Labelling three disagreeing cues was the floor, not the fix. On first load the map
painted Stability, the county table sorted Overall and the town table sorted
Stability, so a reader comparing the darkest county to the top row of the table
beneath it saw two different counties and the note only confirmed it. `DEFAULT_METRIC`
is one constant now — `overall_score`, the weighted composite of the other three — and
the map colour and both table sorts read it, so the whole screen is one sentence until
the reader asks for something else. The value used to be typed in four places, the
fourth a `sort-active` in the template; `bindSortHeader` stamps the active heading from
the script's own sort instead, and `map-color-by.test.mjs` fails if the markup starts
naming a default again or if any of the three stops reading the constant.
`type-scale.test.mjs` closes F19 by measuring the page's two type voices in a real
browser: it copies each element's resolved font onto a probe span and compares ten
narrow glyphs against ten wide ones, so a family list that says "mono" but renders
proportional cannot pass. Controls, headings, the sort sentence, the map key and
the provenance line must come out proportional and at least 12px; the score columns
must stay monospace, because seven columns of digits only line up when every glyph
is the same width.
`phone-map-chrome-browser.test.mjs` (QQA-05e) holds the map's own chrome on a phone: below
1024px the credit line folds to a "Credits" chip and the key to a "Key" chip (44px targets,
`aria-expanded`), the full text stays in the page and opens on a tap, and together with the
other map controls they cover at most 35% of the map; on a desktop both stay open.
`mobile-cards.test.mjs` is the last of F19: at 390px each row is a comparison card
carrying every column, and each value draws the heading standing above it, which
`labelCells()` stamps from the table's own header row. It fails if a phone hides a
measure the filters can still set, if a card label stops matching its column, or if
those labels leak onto a desktop width where the heading already says the same thing.
`pr-ci.yml` runs on the self-hosted runner (no purchased GitHub-hosted
minutes) and refuses to run for pull requests from forks. Every job names a
runner lane rather than a bare `self-hosted`, because GitHub matches
labels as a superset and a bare request also matches wsl2-runner, the runner
reserved (label `gms-video`) for the GoMoveShift video suite: the three build
workflows (`pr-ci.yml`'s `pr-ci`, `deploy-staging.yml`, `deploy-production.yml`) take
the heavy lane, `[self-hosted, heavy]`, and every other job (the `pr-ci.yml`
`scope`, `site-audit` and `result` jobs, `drift-sentinel.yml`,
`product-sync.yml`, `rigscore-facts-sync.yml`) takes the quick lane,
`[self-hosted, quick]`. The lane is not written into `runs-on`; it is the fallback of a
repository variable, so the runner can change without a code change:

```yaml
runs-on: ${{ fromJSON(vars.HM_RUNNER || '["self-hosted","heavy"]') }}        # heavy lane
runs-on: ${{ fromJSON(vars.HM_RUNNER_QUICK || '["self-hosted","quick"]') }}  # quick lane
```

While the variables are unset, every job runs on exactly the runner it always did.
`pr-ci` and `site-audit` keep their `ubuntu-latest` choice for the `site` and `skip`
tiers and read the variables only on their self-hosted arm. Draft pull requests skip
all four `pr-ci.yml` jobs (so no build is spent on a PR that cannot merge);
`ready_for_review` starts the run.

### CI runners: cut-over to GitHub-hosted

All runner groups refuse a public repository, so once this repo is public no
self-hosted job would ever start. Run these in order:

1. Flip the repository public (Settings, General, Danger Zone).
2. Point both lanes at GitHub-hosted runners:
   `gh variable set HM_RUNNER --repo Back-Road-Creative/headlessmode --body '"ubuntu-latest"'`
   and
   `gh variable set HM_RUNNER_QUICK --repo Back-Road-Creative/headlessmode --body '"ubuntu-latest"'`.
   The value is JSON, so the quotes inside the single quotes are part of it.
3. Set the fork-PR approval policy (Settings, Actions, General, "Fork pull request
   workflows": require approval for all outside collaborators), so a fork PR runs
   nothing until a maintainer approves it.

Hosted-safety: on a `github-hosted` runner a first step puts the image's Chrome into `CHROME_PATH`
(`pr-ci`, `site-audit` and `deploy-production`; it fails the job if no browser is found), Hugo comes from the pinned,
checksummed release, and Node 22 and Python 3.12 come from `setup-node` /
`setup-python`. The self-hosted snap Chromium path stays in each workflow's `env:`
because `bin/verify-worktree.sh` reads it.

Rollback is the same steps reversed, in this order: flip the repository private first,
then delete the variables (`gh variable delete HM_RUNNER --repo
Back-Road-Creative/headlessmode`, likewise `HM_RUNNER_QUICK`). Deleting them while the
repo is still public would send every job back to a self-hosted lane that refuses it.
`HM_PR_CI_RUNNER=self-hosted` still forces `pr-ci`'s site and skip tiers off
`ubuntu-latest`, onto whatever `HM_RUNNER` names.

Every job also declares `timeout-minutes`, because GitHub's 360-minute ceiling is
a hosted-runner property and a self-hosted job that hangs holds its runner until
a human notices — `drift-sentinel.yml` sat `cancelled` for 24h on 2026-09-07 and
6h on 2026-09-08 on a job whose worst recorded run is 24 seconds. The value comes
from the job's own observed durations: 10 minutes for the three short jobs
(`drift-sentinel.yml`, `rigscore-facts-sync.yml`, `deploy-staging.yml`, all under
35s at their worst) and 30 minutes for the two ~9-minute build jobs (`pr-ci.yml`,
`deploy-production.yml`). `scripts/test_governance_contract.py` gates both halves:
every job's `runs-on` must be the exact `HM_RUNNER` / `HM_RUNNER_QUICK` form for its
lane (no hard-coded `runs-on: [self-hosted, ...]`, no hosted image, no bare
`self-hosted`, and the unset default must resolve to the lane the job always had), and
none may omit `timeout-minutes`, so a new workflow that forgets either goes red on the PR.

`deploy-staging.yml` builds the shared `deploy/staging` preview branch and runs
only when a pull request is labelled `staging-preview`, or on a manual dispatch
— never on every pull request. There is one preview branch, so only the last
build to finish is visible anyway, and firing on every PR made those runs
displace each other: a concurrency group holds a single pending run, so a third
arrival cancels the one that was waiting, and a cancelled run leaves that head
SHA permanently red for `gh-merge-approved`. Eight stacked branches pushed on
2026-09-09 produced seven such SHAs. Remove and re-add the label to refresh a
stale preview. `scripts/test_governance_contract.py` gates both halves of this:
no PR workflow may cancel in-progress runs in a group other PRs share, and none
that fires on every pull request may serialise on a static concurrency group.

`pr-ci.yml` keeps one run per pull request. Its concurrency group is keyed on the
PR number with `cancel-in-progress: true`, so a new push cancels only that PR's
superseded run. The old head can no longer land, and the approval wrapper and
autoland judge the head SHA's runs alone. On 2026-09-26 a stack of rebased
branches kept superseded runs on both `heavy` runners for up to 25 minutes while
the current heads queued behind them.

`pr-ci.yml` runs in two tiers, chosen by its `scope` job (`scripts/ci/pr-scope.mjs`,
which `scripts/test-pr-ci-scope.mjs` tests). `narrow`: every changed file is
`content/**/*.md` (not `content/_*`), `static/img/**`, `static/og/**` or a root
`*.md`; Lighthouse then audits a 3-URL smoke list (home, `/keycut/`, `/rigscore/`).
`full`: anything else, and any path the classifier does not recognise; Lighthouse
audits all of `.lighthouserc.json`, with one exception: when every changed file is
Quiet Corners map work (`scripts/qcm/**`, `static/data/quiet-corners/**`,
`static/data/quiet-corners-maps/**`, `content/quiet-corners.md`,
`content/quiet-corners-maps.md`, `js/quiet-corners.js`, `js/quiet-corners-maps/**`,
`js/quiet-corners-sky/**` under `themes/headlessmode/static/`), Lighthouse audits only the
`/quiet-corners` URLs of `.lighthouserc.json` plus the home page, read from that file at
run time (`QCM_LHCI` in `pr-scope.mjs`). One other file, an empty change list, or a
`.lighthouserc.json` with no `/quiet-corners` URL audits everything. The `node --test` selection and pa11y are the
same in both tiers (31 qcm files read `content/` and `data/` through the built
site, so no smaller test set is provably safe). The required check stays
`PR CI (build + validate)`; there is no `paths:` filter, and a `PR CI result` job
fails if `scope`, `pr-ci` or `site-audit` is cancelled, skipped or failed.

The browser and link audits (htmltest, the github.com API link check, pa11y,
Lighthouse) run in a separate `site-audit` job (`PR CI site audit`), not in
`pr-ci`: they were 9-11.5 of each 21-26 minute job and all of it held one heavy
runner. `pr-ci` builds the site and uploads `public/` as the one-day `site-public`
artifact; `site-audit` needs it, downloads it, and runs on the same hosted tiers
(`site`, `skip`) or the idle `[self-hosted, quick]` lane, never `heavy`.

`pr-ci.yml` runs only for a pull request whose base is `master`, the integration
branch. A stacked child (base = another feature branch) is skipped until it is
retargeted: it cannot merge before its parent lands, and a rebased stack queued
several 28-45 minute runs on the single `heavy` runner. The trigger includes the
`edited` event so a retarget starts CI, and `scripts/test_governance_contract.py`
holds the rule.

## Exit Condition

Archive when headlessmode.com is retired, or when the studio's systems have moved
elsewhere.


### Product version freshness

`data/releases/<slug>.json` is the source for the product sheet's Release details.
`product-sync.yml` checks Band Coach and Driftless's GitHub Release objects and
Waypost and Framegrade's stable source tags daily at 06:47 UTC. It also accepts
manual and `product-release` dispatches. Updates open review PRs; a failed sync
opens or updates its tracking issue. Review and merge are still required before
the website changes, so automation detects drift rather than promising an
instant deployment.

A `github-tag` record stores the highest stable numeric semantic version and the
peeled commit from GitHub's paginated tag list. It links to that source tree,
leaves `released_at` null and has no release assets: a commit timestamp is not a
release publication date. A moved tag's changed commit also opens an update PR.
`bin/product-tag-resolve.py` resolves this input; `bin/product-sync.sh` validates
and writes it. The frozen Waypost demo retains its independent site-commit
provenance and is not relabelled as the current `seo-manager` source package.

A `github-release` record's `assets` render in Release details as one download
link per asset, sorted by filename, with the SHA-256 beside each one that
`product-sync.sh` hashed. That is how the Framegrade Windows installer and its
`SHA256SUMS` reach the page: no template or prose names them. Framegrade was
`github-tag` until its first published GitHub Release, v0.3.15 (a draft is not
public); a reviewed PR then changed its `release_source` to `github-release`
(`product-sync.sh` refuses a payload whose source disagrees with the ledger).
A Release payload names no commit, so the sync drops a `source_commit` left by
a `github-tag` record rather than keep vouching for an older tag's commit.
`scripts/test_framegrade_page.py` renders both shapes against a copy of `data/`.

Offline regression checks use captured API-shaped fixtures, never live API calls:

```bash
python3 -m pytest scripts/test_product_sync.py scripts/test_release_data.py scripts/test_systems_contract.py
```

Build first for the rendered product-sheet assertions. New tag-sourced products
need a release-ledger record and a product-sync matrix row. The older drift
sentinel's GitHub Release comparison remains specific to `github-release` records;
tag freshness and failure reporting are owned by product-sync.
