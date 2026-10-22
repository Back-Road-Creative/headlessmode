#!/usr/bin/env bash
# The ONE way this site is built. Tailwind, Hugo, then the generated Field Maps CSP.
#
# Why a wrapper rather than five call sites each running two commands: the map policy
# is no longer committed (see scripts/qcm/gen-headers.mjs), so a build that runs Hugo
# alone ships static/_headers' hand-written prefix with no map rule in it. Every map
# page would fall back to the global same-origin CSP and reach no service — the
# dashboard renders and stays empty. One wrapper is one place to get that right, and
# scripts/test_headers_build_wiring.py fails the suite if a caller goes round it.
#
# Tailwind comes first for the same reason: the head partial links /css/tailwind.css,
# which only the Tailwind CLI writes (`npm run build:css`, or `watch:css` while
# developing) and git ignores, so in a fresh checkout Hugo alone ships pages whose
# stylesheet 404s. With no Tailwind CLI installed, an already
# compiled stylesheet is reused with a warning (scripts/validate.sh builds for its HTML
# contracts without an npm install), and with neither the build stops.
#
# Every argument is passed through to hugo untouched, so callers keep their own
# --environment / --config / --minify / --cleanDestinationDir flags.
#
#   bash scripts/build-site.sh --configDir site-config --minify
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

TAILWIND_CSS=themes/headlessmode/static/css/tailwind.css
if [ -x node_modules/.bin/tailwindcss ]; then
  npm run build:css --silent
elif [ -f "$TAILWIND_CSS" ]; then
  echo "build-site: node_modules/.bin/tailwindcss is not installed, so $TAILWIND_CSS was not recompiled and may be stale (npm ci, then build again)" >&2
else
  echo "build-site: no Tailwind CLI (node_modules/.bin/tailwindcss) and no compiled $TAILWIND_CSS; the head partial links /css/tailwind.css, so this build would ship pages whose stylesheet 404s. Run npm ci, then build again." >&2
  exit 1
fi

hugo "$@"
node scripts/qcm/gen-headers.mjs --write-public
# Camera snapshots. `--out` is the legacy GRSM-only cameras-nps-grsm.json; nothing in the browser
# reads it any more (the committed seed stays only as a build fixture), and it goes when the build
# stops writing it. `--out-dir` is the per-region directory the browser reads today (index.json +
# one file per provider/region: Caltrans by district, every located NPS webcam by state, paged and
# key-only at build time). A file is schema 1, or schema 2 when a record carries a bearing, capture
# time, expiry or approximate position; index.json marks `stale: true` on a file whose stills have
# all expired. With no NPS_API_KEY
# (everywhere but CI), or on any upstream failure, both are a no-op and the committed static/ seeds
# Hugo already copied into public/ above are left untouched (build-camera-snapshot.mjs is
# fail-soft by design: a provider that fails keeps its files and its index rows).
node scripts/qcm/build-camera-snapshot.mjs \
  --out public/data/quiet-corners-maps/cameras-nps-grsm.json \
  --out-dir public/data/quiet-corners-maps/cameras
