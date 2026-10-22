# CLAUDE.md — site-headlessmode

## Purpose
Hugo-based website for HeadlessMode — the studio site for Back Road Creative, not a single-product microsite, styled as a light commerce storefront. The wordmark is the single route Home and the nav has two slots (About · Contact — `site-config/_default/menus.toml`). The home-page products follow the hero directly and render ONCE, on the home page at `/#software` (also `/#products`), from `data/systems.json` through `themes/headlessmode/layouts/index.html` — rows ordered by each entry's `homepage_rank`, each with one picture, no Free tools section, then the studio contact band. A product with `"homepage": false` (Grant Platform; Driftless, which JP said on 2026-10-19 is not ready to advertise) keeps its page and is left off the home page. Free tools (`tier: oss`) have their own pages and `static/llms.txt` entries but are not listed on the homepage, except those opted in with `"homepage": true` (rigscore and bot-battle-station, tagged Free). **Each on-site system page is a product sheet: downloads AND documentation on ONE page** — chip + serif name + the same canonical blurb as the roster, a data-driven Get panel only when there is something separate to acquire, the what-it-is prose, then a `## Documentation` section. There is no `/systems/` catalog, no `/docs/` hub and no on-site `/releases/` section — `static/_redirects` 301s all three. Content tree: a page per system that has something to show beyond its roster row (`rigscore.md`, `driftless.md`, `quiet-corners.md`, `keycut.md`, `redactcam.md`, `sun-track.md`, …), plus `about.md`, `contact.md` and `privacy.md`. A system with no page of its own points directly to its public source instead (push-guard).

## Build / Test / Run

```bash
cd "$(git rev-parse --show-toplevel)"

# Local development server
hugo server --bind 0.0.0.0 --port 1315 --configDir site-config

# Production build — ALWAYS through the wrapper, never bare `hugo`
bash scripts/build-site.sh --configDir site-config --minify

# Production deployment (dispatches the GitHub Actions workflow — no local build/push path)
./scripts/deploy-production-local.sh

# Preview an unmerged branch (Cloudflare branch previews serve nothing)
bash scripts/preview.sh /demo/driftless/        # prints http://localhost:1315/demo/driftless/
bash scripts/preview.sh /demo/driftless/ 1316   # second preview, its own per-port pid/log
bash scripts/preview.sh --stop                  # or --stop 1316 for one port

# Validate the built HTML (build first): page structure + htmltest + github.com links via the GitHub API; --skip-external for offline runs
npm run test:html [-- --skip-external]

# Mirror the PR CI's build + test steps on any checkout before pushing (no pa11y, htmltest, github.com link check or Lighthouse)
bash bin/verify-worktree.sh [--plan] [--python <py>] [--node-modules <dir>] [--lock <file>]
```

`bin/verify-worktree.sh` reads its commands from `.github/workflows/pr-ci.yml` at run time (never a copied list), so it follows the workflow; `--plan` prints them without running anything. The summary prints the last 40 lines of each failed step's log, because the log dir is usually a temp dir gone by the time anyone reads a CI run.

Browser tests fail closed in CI: with `CI=true` or `QCM_REQUIRE_BROWSER=1`, `findChromium()` (`scripts/qcm/helpers/browser.mjs`) throws on a missing Chromium or a `CHROME_PATH` naming a missing file, and `siteIsBuilt()` (`helpers/site-server.mjs`) throws on an unbuilt `public/` page, instead of the test file reporting a skip. Off CI both still skip. Held by `scripts/qcm/browser-preflight.test.mjs`; set `QCM_REQUIRE_BROWSER=1` to rehearse CI locally. Build before running browser tests under it.

A browser wait on `window.qcRestoreSettled` that times out names the start-up stage it stalled in: `start()` in `quiet-corners-maps/main.js` sets `window.qcRestoreStage` (waiting for the dashboard map, reading the saved job, waiting for the last save) before each step, and `PAGE_STATE` in `scripts/qcm/helpers/waits.mjs` adds "Field Maps start-up is at: <stage>" (or "never began") to the timeout message. Held by `scripts/qcm/restore-stage.test.mjs`; a new await in `start()` gets its own stage.

**Quiet Corners control register.** `scripts/qcm/control-register.json` lists every control a reader can operate on `/quiet-corners/` and on the Field Maps docs page (`/quiet-corners/maps/`): selector, one of the plan's eleven control families, purpose, scope, expected visible effect, keyboard path, persistence (saved / shared link / saved print recipe / none, `unverified` only where the code does not settle it) and the test files that exercise it. `scripts/qcm/control-register.test.mjs` is the gate: it lists the buttons, inputs, selects, summaries, `[role=button]`s and map-chrome links the built page renders at 1280x800 and 390x844 and fails naming each one no entry claims and each entry whose selector matches nothing. Layer, context and base rows are read from `layer-registry.js` / `source-basemaps.js` by the test, so a new registry row without a register row fails. **Adding a control means adding its register entry in the same change** (controls that exist only after an interaction, like card actions, are `transient` family selectors). Build first: `bash scripts/build-site.sh --configDir site-config --minify`.

Browser tests fail closed in CI: with `CI=true` or `QCM_REQUIRE_BROWSER=1`, `findChromium()` (`scripts/qcm/helpers/browser.mjs`) throws on a missing Chromium or a `CHROME_PATH` naming a missing file, and `siteIsBuilt()` (`helpers/site-server.mjs`) throws on an unbuilt `public/` page, instead of the test file reporting a skip. Off CI both still skip. Held by `scripts/qcm/browser-preflight.test.mjs`; set `QCM_REQUIRE_BROWSER=1` to rehearse CI locally. Build before running browser tests under it.

**Agents: after changing anything a person would look at (content, data, static, theme), run
`bash scripts/preview.sh <page>` yourself and put the printed URL in the reply.** Do not hand
over a `hugo server` invocation to type, and never cite a `*.headlessmode.pages.dev` branch
URL — only the production branch is deployed there.

**A printed URL is a proof, not a guess.** `preview.sh` prints nothing until the port was free
before launch, the Hugo child it started is recorded in `.hugo-preview.<port>.pid` and alive,
that child's log reports a bind on that exact port, `/` carries this checkout's Hugo build
markers (generator tag + the configured site title), and the requested page answers 200.
Anything else is a non-zero exit with the reason on stderr — an occupied port is refused
outright (exit 69, "free it, or pick another"), never reported: a port held by another process
means Hugo never bound and the URL would answer someone else's 404.
`scripts/test_preview_readiness.py` guards this. A refusal means
free the port or pass a different one — never assume the URL is fine anyway.

## Architecture

### Hugo Site Structure
```
site-headlessmode/
├── site-config/_default/    # Hugo config + menus.toml (the main nav — read it, don't restate it)
├── content/                  # One .md per page. A sample below — `git ls-files content` is the list
│   ├── about.md             # $ whoami page; contact.md and privacy.md sit alongside it
│   ├── rigscore.md          # rigscore product sheet — manual, reference, clients, verify all on it
│   ├── driftless.md, quiet-corners.md, keycut.md, …   # a page per system with more to show than its roster row
│   └── redactcam.md, sun-track.md       # open-tool demo pages
├── data/                     # systems.json (every system, one entry each) + rigscore.json (product facts)
├── layouts/                  # Site-level overrides — alias.html (titles the /cv/ alias stub; must sit HERE, not in _default/ — Hugo 0.139 in CI ignores the _default/ path and silently falls back to its built-in) + shortcodes/ (ascii-output, cmd, rigscore-fact, rigscore-check-table). The dead feed's _default/rss.xml went in #273; the theme carries its own shortcodes too
├── themes/headlessmode/      # Custom theme — layouts/ (index.html = hero + products + hire band, baseof, partials header/footer/system-sheet, shortcodes get-system + system-docs) and static/ (every site JS file, vendor Leaflet/topojson, the built CSS)
├── scripts/                  # Deploy, content validators, rigscore data gates (verify-facts, check-rigscore-sync, verify-rigscore-toolpage) + verify-claims (probes GitHub; drift-sentinel workflow only) + qcm/check-github-links (the build's github.com links through the API, after htmltest)
└── static/                   # Icons + og images, _redirects, _headers (hand-written prefix ONLY — the map CSP is generated at build time: a detach rule in public/_headers plus a `<meta>` in the built page), llms.txt, robots.txt, data/quiet-corners/ (bulk generated data — `du -sh` it rather than trusting a figure here). No site-authored page JS here — that is themes/headlessmode/static/js/. The one exception is `functions/api/geocode.js`, the Cloudflare Pages Function behind the map's address search (a relay to the US Census geocoder; decision record `scripts/qcm/GEOCODER.md`), with `_routes.json` limiting Functions to `/api/*`
```

There is no predictions-scraper stack in this repo. Gitignored local leftovers (`predictions-output/`, `database/`) may still exist on disk in older checkouts; they are not part of the build.

### Key Pages
- **Home (`/`)**: The front window AND the catalog — a forest-green masthead and hero (white wordmark, kelly rule, Source Serif 4 headline — self-hosted under `themes/headlessmode/static/fonts/source-serif-4/`, OFL text in `NOTICE` — "For the things we’re working on.", lede "A collection of projects."), then the `#software` roster, then one "Get in touch" band. No featured system is duplicated above the roster (`themes/headlessmode/layouts/index.html`). Publishing a system remains a data-file change; no template names a system or a count by hand.
- **Software (`/#software`)**: The products immediately after the hero, once, inside `id="software"` (with an inner `id="products"`) on the home page. `tier: product` entries without `"homepage": false` render, plus any `tier: oss` entry with `"homepage": true` (rigscore, bot-battle-station), each as a row: a picture (`homepage_image`, a path under `/img/` with a provenance entry in `static/img/<slug>/manifest.json`, plus `homepage_image_alt`/`_width`/`_height` — a real screenshot, or a designed tile for Framegrade, which has no screen of its own, and for rigscore, a terminal tool drawn from its page's sample output), the name with a Free (public, or a free tool) or Preview tag, a `homepage_area` category label (Music, Maps, Code, Media), the canonical blurb, one button (`homepage_action`, else Download for a shipped public download, else "Ask about <name>" to Contact) and a Details link to the product page. Dates, source links and install commands stay off the homepage. Order is `homepage_rank` ascending (Band Coach, Quiet Corners, rigscore, bot-battle-station, Waypost, Framegrade); an unranked product follows the ranked ones by shipped descending, name ascending, undated last. `shipped` controls system-page status, not homepage copy.
- **System pages (product sheets)**: `_default/single.html` renders a page as a product sheet exactly when a `data/systems.json` entry's `link` equals its URL — the `partials/system-sheet.html` band (chip + serif name + one-line, plus a get-system column when applicable) replaces the post-style header, then the page's prose, then its `## Documentation` section. The box leads with exactly one primary action (Store, Download, install command, else for an `engagement` product "Contact for setup"), with format and requirements beside it; contact follows as a secondary link when another action leads, and release provenance (published month, version, demo source) sits once in a collapsed "Release details" `<details>`; a `public` dashboard product renders no box that merely jumps to the dashboard immediately below. An `oss` page still needs a real download, install or repo and `get-system` errors loudly rather than render empty. The two demo layouts (`redactcam-demo`, `sun-track-demo`) and the Field Maps page (`quiet-corners-maps`) render the same sheet band. The Quiet Corners dashboard is the one exception: a band plus the dashboard's own header put the map 593px down a 390px phone (audit A10), so that layout skips the band and its app header carries the identity instead — same chip partial, same name and one-line, still read from `data/systems.json`. `scripts/test_systems_contract.py` asserts every system page renders a `#documentation` anchor.
- **Retired (`/work/`, `/journal/`, `/services/`)**: Gone. They lost their nav slots when the roster landed and were deleted once nothing pointed at them; `static/_redirects` 301s `/work/*` to `/#software`, `/services/*` to `/contact/` and `/journal/*` to `/`. Do not re-add a page here without a nav slot or a link that reaches it.
- **Retired (`/releases/`)**: Gone — `static/_redirects` 301s `/releases/*` to `/rigscore/`, and release notes live on each project's GitHub releases page (`CONTENT_GUIDELINES.md` says the same). On-site version truth stays data-driven instead: the current version is `data/rigscore.json`'s `version` field, never a literal on a page — one rule among several in `scripts/verify-facts.js`, the gate that fails the build whenever hand-written prose stops agreeing with the data behind it (`data/rigscore.json`, `data/systems.json`) or with the product's real surface. It gains a rule per drift class as one is found, so read the script's header comment for the current set rather than trusting a list here. Its scan roots are `content/` + `themes/`, wider for exactly one rule (the product-count gate also reads `layouts/` and `static/`) — and never this file, so nothing lints what CLAUDE.md claims.
- **Retired (`/docs/` and children)**: Gone — the boutique redesign put each system's documentation ON its own page. rigscore's manual, command reference, supported-clients matrix and verify recipe all live in `/rigscore/`'s Documentation section; the other systems carry an honest repository pointer via `{{< system-docs >}}`. `static/_redirects` 301s `/docs/` and `/docs/*` to `/#software`, with every named `/docs/<child>` sent to `/rigscore/#documentation`; the drift sentinel probes `/rigscore/` for the live version.
- **About (`/about/`)**: Short first-person identity, design approach and the one canonical explanation of the Headless Mode / Back Road Creative relationship; aliases `/cv/`. Inventory and contact instructions stay on their own surfaces rather than repeating here.
- **Driftless (`/driftless/`)**: Product page, off the home roster (`"homepage": false`) and reachable by direct URL only. Its `/demo/driftless/` link opens a committed static bundle generated by Driftless itself from its fixed fictional seed: the pages `manifest.json` lists (its `pages` count and `source` commit are the record) at a pinned as-of, with scripts, sign-in and every form/button removed, internal links rewritten to sibling files, and a `manifest.json` carrying source provenance. Never hand-edit that bundle; regenerate it with `bin/driftless-showcase.py` in the Driftless repo. Regeneration and production-smoke tracking for that bundle live in this repo's own `bin/` (`driftless-bundle-regen.sh`, `driftless-prod-smoke.sh`), tested by `scripts/test_driftless_bin.py`. `scripts/test_driftless_demo.py` is wired into local validation, PR CI and deploy and reads the bundle's own `manifest.json` as the contract (page count, script/stylesheet references, per-file sha256) rather than restating it, failing stale provenance, missing pages, live controls or escaped links, and runs an offline structural a11y pass over every page in the manifest (reds are upstream generator fixes, held as strict `xfail`s until then); the nine preview-shots pages are also gated by pa11y and Lighthouse (`.pa11yci.json`, `.lighthouserc.json`). `scripts/drift_probe_demo.py` extends that check post-deploy, run daily by `drift-sentinel.yml` against the live site. `/demo/*` is kept out of search by the `noindex, nofollow` meta that every demo page carries and the site test asserts; robots.txt deliberately stays `Allow: /` (decision 2026-09-02). The source went public under Apache-2.0 on 2026-08-03. GrantPath and GrantBridge were consolidated into one product, Grant Platform, in a **private** repository; the site was updated on 2026-09-01 — both pages deleted, `content/grant-platform.md` written in their place, and `/grantbridge/` and `/grantpath/` redirected to it by that page's `aliases`. Its entry carries no `repo` key and its page asserts no licence and no repository URL, because there is no public source to point at; it therefore writes its own Documentation section rather than calling `{{< system-docs >}}`, which errors loudly on an entry with nothing to link. It keeps `shipped: null` — the repository holds no tag and no release, and a month inferred from anything else would be an invented business fact. Only driftless now asserts a licence and a repository URL among the product pages: if that repo is ever renamed or taken private, `content/driftless.md`, `content/rigscore.md`, `static/llms.txt` and the `repo` key in `data/systems.json` all go stale together.
- **Tool demo pages (`/redactcam/`, `/sun-track/`)**: One page per open tool that has something to show running. Each is a single `content/*.md`; the tool's own README on GitHub is still the manual.
- **Quiet Corners (`/quiet-corners/`)**: Census/USDA-driven rural-county dashboard, reached from its stanza in the home roster. `content/quiet-corners.md` renders once in the normal-flow `#documentation` section below the dashboard; the compact dashboard header carries the page's one `<h1>`, the systems-ledger chip and one-line, and links once back to Headless Mode and once to that methodology section. It is the page's only header — `scripts/qcm/layout.test.mjs` holds the map to 420px from the top of the document at 390x844, half the phone screen, so a second introduction cannot be stacked above it again. The page owns vertical scrolling—there is no nested dashboard or results scrollbar, with one bounded exception: at 1024px and up the four panels are a dock column left of the map (`#qc-map-container` is a two-column grid, the open panel the dock's one scroller, the map column at least 480px — `scripts/qcm/dock-layout-browser.test.mjs`), and below 1024px they share one bottom sheet that resizes the map rather than covering it or growing the page underneath it — half is 45% of the fixed-height stage (the map keeps the rest), expanded is the whole stage, and the open panel is the sheet's one scroll region. The stage clips at its bottom edge (`overflow: clip`, so nothing inside it can scroll it either), which means whatever sits inside must fit: the sheet shrinks to what the surface caption and the print-area strip leave it rather than run past that edge, and the open place finder is no taller than the room the stage has left below where it opens (what the cap leaves over scrolls inside the box, so the Census notice under an address answer is never clipped away), is placed again when a phone turns with it open, and closes when Tab or Shift+Tab moves focus out of it, so focus does not land on a control it still covers; a map drag leaves it open (`scripts/qcm/panel-shell-browser.test.mjs`, `scripts/qcm/find-and-scale.test.mjs`). The layer list itself never scrolls inside the panel — the open panel is the one scroller, and the Map key sits above the list (QUX-04c). `scripts/qcm/layout.test.mjs` also measures how much map is left. County and candidate tables paginate at 10 rows, while the desktop map stays at a useful viewport height and the mobile map remains in normal stacked flow. Data lives in `static/data/quiet-corners/` (~4MB, machine-generated by an external pipeline on each regeneration — never hand-edit; treat as a build artifact). **One exception: `states.json` is a hand-written tombstone, not pipeline output** — see "Deleting a published data file" below. Map rendering uses `themes/headlessmode/static/vendor/` (Leaflet, topojson-client, MapLibre GL JS) — third-party code, not site-authored; see `NOTICE` for licenses.

### Key Configuration
| File | Purpose |
|------|---------|
| `site-config/_default/` | Hugo production config |
| `site-config/_default/menus.toml` | Main nav. This file is the authority on what is in it and in what order. The wordmark is the single route Home; the menu carries About and Contact only. `partials/footer.html` ranges over this same menu plus `/privacy/`, while its metadata row adds the GitHub link. |
| `content/_content.schema.yaml` | Frontmatter shape per content type. Descriptive — `hugo.toml`'s `ignoreFiles` keeps it out of the build |
| `.lighthouserc.json` | Lighthouse CI |
| `.pa11yci.json` | Accessibility testing. A per-URL `ignore`/`hideElements` entry needs an `_ignore_comment` naming elements that exist on that page — `scripts/test_a11y_config.py` enforces it, after the 2026-07-30 quiet-corners contrast ignore kept citing a block #314 had deleted (measured unnecessary and removed 2026-09-04) |
| `package.json` | npm dependencies |
| `CONTENT_GUIDELINES.md` | Content writing standards |

### Deployment
- **CI/CD**: GitHub Actions
- **PR CI runner placement**: `pr-ci` runs on `ubuntu-latest` when the `scope` job's `qcm_scope` is `site` or `skip`, and on `[self-hosted, heavy]` for `full` and for any empty or unknown scope (`.github/workflows/pr-ci.yml`; `scripts/test_governance_contract.py` pins the exact expression on that one job, every other job and `deploy-production.yml` stay self-hosted). The hosted run takes its browser from the image (a `runner.environment == 'github-hosted'` step sets `CHROME_PATH`; the snap path stays the self-hosted value). Set the repository variable `HM_PR_CI_RUNNER=self-hosted` to force every tier back to self-hosted with no code change; check names are the same either way.
- **Branches**: production branch for deploys
- **Theme**: Custom `headlessmode` theme (not a submodule)
- **Deploy gate (QC-E1)**: before it builds, `deploy-production.yml` runs `node scripts/ci/deploy-gate.mjs check`. The deploy refuses a master commit with no merged PR (`no-pr`), a PR whose head has no completed success/failure `pr-ci.yml` run (`no-pr-ci`; cancelled runs don't count), or one whose newest such run failed (`red-pr-ci`). The PR is matched by tree, not SHA, because squash and merge commits never equal the tested head. A head behind master (`stale-tree`: PR CI tested a different tree) is only a warning for now, because 105 of the 150 master commits ending f71bc6e4 were merged that way (measured 2026-10-15). `STALE_TREE` in the script flips it to a refusal once merges land up-to-date heads. A manual dispatch may pass `override_reason`, which deploys anyway and logs the reason as a warning. The in-job `node --test` step then fails on any skipped or todo test (`deploy-gate.mjs counts`). Contract: `scripts/test-deploy-gate.mjs`.

#### The map CSP is generated at build time, NOT committed
`static/_headers` is the hand-written prefix only. The map's policy is **a `<meta http-equiv="Content-Security-Policy">`
written as the first child of `<head>` in the built `public/quiet-corners/index.html`**, from the same
`cspValue()` that used to feed a header line. Cloudflare caps a `_headers` line at 2,000 characters and the
map policy had 164 left, so no new picture host could be added; a meta has no such cap. The
`/quiet-corners/` block that `scripts/qcm/gen-headers.mjs --write-public` appends to `public/_headers` now
only carries `! Content-Security-Policy`, detaching the sitewide same-origin header: a browser enforces the
intersection of a header and a meta, so a surviving header would block every map service. Never add a
`Content-Security-Policy:` value to that block. The policy may not use `frame-ancestors`, `report-uri`,
`report-to` or `sandbox` (a meta ignores them; `csp-meta.test.mjs` fails on them), and the meta must stay
first in `<head>` (after a leading `<meta charset>`, which stays inside the 1024-byte pre-scan) because it governs only what the parser sees after it. `npm run csp:headroom` prints the
policy's length for information; there is no cap and no floor on it.

`scripts/build-site.sh` runs the generator straight after Hugo. **Build with that wrapper, never bare
`hugo`:** Hugo alone emits neither the detach rule nor the meta, every map page falls back to the global
same-origin policy, and the dashboard renders but reaches no service. `scripts/test_headers_build_wiring.py`
fails the suite if any script or workflow builds around the wrapper, and asserts the generated section has
not crept back into git. The post-deploy probe (`scripts/drift_probe_maps_csp.mjs`) reads the meta from the
served page and fails if the edge also serves a CSP header on it.

The generated section is not committed, or every branch adding a map source would rewrite one shared line.
Anything that needs the policy calls `cspValue(stateOrigins())` from `scripts/qcm/gen-headers.mjs`;
anything that needs the `_headers` as served calls `effectiveHeaders()`.

#### Deleting a published data file — overwrite, don't delete
Removing a file from the build does **not** remove it from the live site. `states.json` was deleted
from the repo in #202, the `production` branch was force-pushed orphan without it (`force_orphan: true`),
the deploy marker advanced to the new commit — and the edge still returned all 28,069 bytes of the
old file a day later, with `cf-cache-status: DYNAMIC`. `DYNAMIC` means it never came from the CDN
cache, so a Cloudflare cache purge is not the fix; the stale copy sits in the Pages asset store.

So: to retire a file under `static/data/`, **replace it with a tombstone** rather than deleting it —
a small JSON body naming the retirement date and the reason. That works regardless of what Pages is
doing internally, and needs no dashboard access. `_redirects` is not an alternative: Cloudflare Pages
supports only 301/302/303/307/308 there, never 404/410.

Verify with a **GET**, never `curl -sI`: this site's HEAD response reported `content-length: 32`
for a body that GET delivered at 28,069 bytes.
```
curl -s -o /dev/null -w "%{http_code} %{size_download}\n" https://headlessmode.com/data/quiet-corners/<file>
```

## Conventions
- Hugo with `site-config/` directory pattern
- Per-site CLAUDE.md rule: ship site changes via PR → merge → GH Actions (never run `/publish` locally on behalf of the user)
- `content/_content.schema.yaml` records the frontmatter shape per content type; `scripts/test_frontmatter.py` is what actually enforces it — its `REQUIRED_FIELDS_ALL` is `{title, description}`, so every page needs both, neither may be blank, and it also rejects a code-fenced file, front matter that does not open on line 1, unparseable YAML, front matter that is not a mapping, a zero-value date, and a `description` over `MAX_DESCRIPTION_LEN` (155) — the SERP budget `site-config/_default/params.toml` had stated in a comment and nothing enforced
- `.mailmap` maps every historical human address to `Joe Petrucelli <backroadcreativeco@gmail.com>`. Commit under a new address and add a line there rather than leaving `git shortlog` splitting one person in two. Bot authors (Buddy) are deliberately unmapped
- MANDATORY before handing anyone a preview URL: `bash scripts/preview-shots.sh <port>` and look at every PNG (both widths) — no round ships sight-unseen. The matrix, captured at 1440 and 390, adds `/band-coach/`, `/waypost/` and the Waypost demo (`/demo/waypost/`, `pubqueue.html`) to the product pages and **the nine `/demo/driftless/` pages carrying the riskiest displays** (map, process map, flow, gantt, org heatmap, assist cost, methods, pmbok proof), and `scripts/test_preview_shots.py` asserts those routes exist in the source tree, and the run writes `<outdir>/audit.tsv` and **exits non-zero** on a non-200, a capture error or a blank image, so a broken render fails the command rather than waiting for someone to notice it in a picture. Document-level horizontal overflow is measured too: `scripts/preview-overflow.mjs` reads each page's `scrollWidth` over the DevTools protocol (Node 22 built-ins, no dependency) and a page wider than its viewport fails the run as `overflow-<px>`; a table scrolling inside its own `overflow-x:auto` box is fine and passes. `scripts/test_preview_shots.py` covers the gate. Also probe every `<link>`/`<script>` asset for 200; a fresh worktree needs `npm ci` first (`scripts/build-site.sh` and `scripts/preview.sh` then compile Tailwind themselves)

## Known Issues
- npm audit is on (no `audit=false` in `.npmrc`, lockfile committed) — re-run `npm audit` for current vulnerability counts before dependency work

## Owner
Joe

## Status
Active — the studio storefront: the whole software roster on the home page at `/#software`, and a product sheet for every system that has a page of its own (downloads + documentation on the same page).
