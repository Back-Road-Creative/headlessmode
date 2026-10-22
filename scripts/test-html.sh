#!/usr/bin/env bash
# `npm run test:html` - validate the BUILT site's HTML. Reads public/, so build first:
#   bash scripts/build-site.sh --configDir site-config --minify   (it compiles Tailwind first)
#
# Three gates, in order, all must pass:
#   1. scripts/qcm/check-built-html.mjs - the build is not empty, every expected page exists,
#      every page tokenizes and nests cleanly. htmltest cannot see any of that.
#   2. htmltest with the tracked .htmltest.yml - the same command pr-ci.yml and
#      deploy-production.yml run: internal links, assets, external links except github.com.
#   3. scripts/qcm/check-github-links.mjs - the github.com links, through the GitHub API, as
#      both workflows run it after htmltest. Set GITHUB_TOKEN as CI does: without it the API
#      allows an IP 60 requests an hour.
#
# Missing htmltest, a missing/empty public/ and a missing expected page are FAILURES. The one
# thing that may be skipped is the external-link checks (htmltest's and the github.com one),
# only by an explicit --skip-external (offline runs), and each is printed as SKIPPED, never as
# a pass.
#
#   npm run test:html                        # what CI runs
#   npm run test:html -- --skip-external     # no network
#
# Test seams (scripts/qcm/check-built-html.test.mjs, check-github-links.test.mjs): HTML_DIR
# (default public), HTMLTEST_BIN (default htmltest), HTML_EXPECT (space-separated URLs replacing
# the repo-derived list), GITHUB_API_URL (the API the github.com check calls).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

DIR="${HTML_DIR:-public}"
HTMLTEST="${HTMLTEST_BIN:-htmltest}"

skip_external=0
for arg in "$@"; do
    case "$arg" in
        --skip-external) skip_external=1 ;;
        *) echo "unknown argument: $arg (only --skip-external is supported)" >&2; exit 2 ;;
    esac
done

if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node is not installed; the page checks need it" >&2
    exit 1
fi

check=(node scripts/qcm/check-built-html.mjs --dir "$DIR")
for url in ${HTML_EXPECT:-}; do check+=(--expect "$url"); done
echo "=== Built-page checks ($DIR) ==="
"${check[@]}"

if ! command -v "$HTMLTEST" >/dev/null 2>&1; then
    echo "FAIL: htmltest is not installed. PR CI installs the pinned v0.17.0 (pr-ci.yml 'Install htmltest');" >&2
    echo "      install that release and re-run. This is a failure, not a skip." >&2
    exit 1
fi

echo "=== htmltest ($DIR) ==="
args=()
if [ "$skip_external" -eq 1 ]; then
    args+=(--skip-external)
    echo "SKIPPED: external link checks (--skip-external); internal links and assets are still checked"
fi
# Bare `htmltest` reads DirectoryPath from .htmltest.yml, exactly as CI does; only a
# non-default HTML_DIR (the test seam) is passed as a path.
if [ -n "${HTML_DIR:-}" ]; then args+=("$DIR"); fi
"$HTMLTEST" ${args[@]+"${args[@]}"}

echo "=== github.com links through the GitHub API ($DIR) ==="
if [ "$skip_external" -eq 1 ]; then
    echo "SKIPPED: github.com link checks (--skip-external)"
else
    node scripts/qcm/check-github-links.mjs --dir "$DIR"
fi
