# Release ledger (`data/releases/`)

One file per system this studio has a release story for: every `tier:
"product"` entry in `data/systems.json`, plus `rigscore` (the one `tier:
"oss"` system with its own release cadence and facts file). Filename is the
slug — `path.Base` of the entry's `link` (`/band-coach/` → `band-coach`).
Read by `themes/headlessmode/layouts/partials/system-sheet.html` and
`themes/headlessmode/layouts/index.html` through `site.Data.releases`, and
checked against `data/systems.json` and each product's demo bundle by
`scripts/test_release_data.py`. Only the sync job (once one exists) or a
reviewed PR writes these files — never a template, never a build step.

Every key below is present in every file, `null` where the fact is
genuinely unknown rather than omitted, because a missing key and an unknown
fact are different claims and only one of them is honest.

- `product` — the slug, matching the filename and the `path.Base` of the
  system's `link`. Required.
- `name` — the exact `name` from that system's `data/systems.json` entry,
  spelled the way the system is branded. Required.
- `release_source` — how this record was produced: `"github-release"` when
  a real tagged GitHub release exists and was read from it, `"manual"` when
  there is no release to read (a private repo with no tags, or no repo at
  all) and a person wrote the record by hand. Required.
- `source_repo` — where the release (or the source, if there is no
  release) lives. A URL or `owner/repo` when it is public; `null` when the
  source is private or there is no repo of its own — this repo is public,
  so a private repo's name never goes in a tracked file
  (`scripts/test_public_tree.py`), and a URL nobody outside the studio can
  open would be a broken link dressed as a fact.
- `version` — the release tag, without a leading `v`, or `null` when there
  is no release. Required non-null when `release_source` is
  `"github-release"`.
- `released_at` — the release's publish timestamp, ISO 8601 UTC, or `null`.
  Required non-null when `release_source` is `"github-release"`.
- `release_url` — the release's page, or `null`. Required non-null when
  `release_source` is `"github-release"` — it may point at a private repo's
  release page when that is genuinely where the release lives; nothing
  renders it as a public link unless the repo is public.
- `source_ref` — the tag or commit SHA the release corresponds to, or
  `null` when there is no release to pin one to.
- `assets` — object mapping each release asset's filename to
  `{"url", "sha256"}`, `sha256` `null` when not published by the release
  API. `{}` when the release ships no assets, or there is no release.
- `demo` — `null` when the product has no committed static demo bundle
  under `static/demo/<slug>/`. Otherwise an object:
  - `path` — the bundle's directory, relative to the repo root.
  - `source` — the tag or commit the bundle was built from, taken from the
    bundle's own `manifest.json`.
  - `source_kind` — what kind of ref `source` is: `"product-tag"` (a real
    version tag of the product itself), `"product-commit"` (a commit SHA
    in the product's own repo, no tag), or `"site-commit"` (a commit in
    THIS site's repo, when the product has no repo of its own to point
    at — the honest answer, not a product ref dressed up as one).
  - `anchor` — the bundle's fixed as-of date, from its own manifest.
  - `pages` — page count. Taken from the bundle manifest's own `pages` key
    when it has one; otherwise the count of that manifest's top-level
    `*.html` files.
- `media_source` — the ref the product's on-site screenshots were captured
  at, or `null` when that ref was never recorded. When both this and an
  image's own `source` (in `static/img/<slug>/manifest.json`) are non-null,
  they must agree — one product, one capture story.
- `notes` — a short, plain-words explanation, mainly for `"manual"`
  records: why there's no release to read from, or anything else about the
  record a reader would otherwise have to guess.

Nothing here is inferred. A `null` is a fact this studio does not have yet,
not a placeholder waiting to be filled by pattern-matching the next system.
