#!/bin/bash
# Location: headlessmode/scripts/validate.sh
# Purpose: Validate content before a build — the source-level gate for
#          `make publish SITE=site-headlessmode`.
#
# Mirrors the Python checks in .github/workflows/pr-ci.yml so a local publish
# fails for the same reasons a PR does. Four read sources only. The fifth — the
# systems contract — reads the built site, so this script builds one itself:
# publish-site.sh runs this gate BEFORE its own build, so there is no public/
# here to inherit.
#
# The rigscore node gates (scripts/verify-facts.js and friends) stay out; the
# only node here is the Field Maps engine test run, which needs no npm install.
# The site build does need one when no compiled tailwind.css exists yet (see
# "Site build" below).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE_ROOT="$(dirname "$SCRIPT_DIR")"

source "$SCRIPT_DIR/env.sh"

cd "$SITE_ROOT"

# CI builds a venv with pyyaml + pytest and runs the checks from it. Prefer that
# venv when it exists so a local run matches CI; otherwise use system python3.
PYTHON="python3"
if [ -x "$SITE_ROOT/venv/bin/python3" ]; then
    PYTHON="$SITE_ROOT/venv/bin/python3"
fi

echo "🔍 Validating content for $SITE_NAME..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

ERRORS=0
FAILED=()

# Run one check and record it by name, so a failure is attributable without
# re-running the checks one at a time.
run_check() {
    local label="$1"
    shift

    echo ""
    echo "--- $label ---"

    if "$@"; then
        echo -e "${GREEN}✓ $label passed${NC}"
    else
        echo -e "${RED}✗ $label failed${NC}"
        FAILED+=("$label")
        ERRORS=$((ERRORS + 1))
    fi
}

run_check "Front matter" "$PYTHON" scripts/test_frontmatter.py
run_check "Content accuracy" "$PYTHON" -m pytest scripts/test_content_validation.py -v
run_check "Data contract" "$PYTHON" -m pytest scripts/test_data_contract.py -v
run_check "Framegrade page contract" "$PYTHON" -m pytest scripts/test_framegrade_page.py -v
# The workspace suite cannot check this repo — it consumes it as a submodule and
# never initialises submodules in CI, so this directory is empty there. See the
# module docstring.
run_check "Governance contract" "$PYTHON" -m pytest scripts/test_governance_contract.py -v
run_check "Headers build wiring" "$PYTHON" -m pytest scripts/test_headers_build_wiring.py -v

# Field Maps planning engine, Node's built-in runner over a quoted glob so a
# later scripts/qcm/*.test.mjs joins with no edit here. Missing node fails
# rather than skips, for the same reason missing hugo does below.
if command -v node >/dev/null 2>&1; then
    run_check "Field Maps engine (node --test)" node --test "scripts/qcm/*.test.mjs" scripts/test-verify-claims.js scripts/test-site-surface.mjs scripts/test-qcm-boundary.mjs
else
    echo ""
    echo -e "${RED}✗ Field Maps engine (node --test) failed — node is not installed${NC}"
    FAILED+=("Field Maps engine (node not installed)")
    ERRORS=$((ERRORS + 1))
fi

# The systems contract is the one check that reads public/ instead of sources,
# so it needs a build. --cleanDestinationDir is the point of the flag: a stale
# public/ from an earlier run would let a link to a page the current source no
# longer produces still pass, which is the exact hole this check closes. CI
# needs no such flag — it builds into a fresh checkout.
#
# Missing hugo fails rather than skips, for the same reason the test fails
# rather than skips on a missing public/: a check that goes green when its input
# is absent is not a check.
#
# build-site.sh compiles Tailwind first when node_modules has the CLI. Without
# it, the build reuses an already compiled tailwind.css with a warning (these
# checks read HTML, not CSS) and fails when there is none, so a checkout with
# neither needs `npm ci` before this gate.
if command -v hugo >/dev/null 2>&1; then
    run_check "Site build" bash scripts/build-site.sh --configDir site-config --cleanDestinationDir
    run_check "Systems contract" "$PYTHON" -m pytest scripts/test_systems_contract.py -v
    run_check "Driftless demo contract" "$PYTHON" -m pytest scripts/test_driftless_demo.py -v
    run_check "Grant Platform demo contract" "$PYTHON" -m pytest scripts/test_grant_platform_demo.py -v
    run_check "waypost demo contract" "$PYTHON" -m pytest scripts/test_waypost_demo.py -v
    run_check "Table scroll boxes" "$PYTHON" -m pytest scripts/test_table_scroll.py -v
    run_check "a11y exemptions cite real elements" "$PYTHON" -m pytest scripts/test_a11y_config.py -v
else
    echo ""
    echo "--- Systems contract ---"
    echo -e "${RED}✗ Systems contract failed — hugo is not installed${NC}"
    echo "  It checks data/systems.json, site-config/_default/menus.toml and"
    echo "  static/llms.txt against the built site, so it needs a Hugo build."
    FAILED+=("Systems contract (hugo not installed)")
    ERRORS=$((ERRORS + 1))
fi

# Readability bar for the driftless product page: at most 800 words, Flesch
# reading ease at least 60, no sentence over 30 words, exactly three body links
# (demo, repo, contact), no British spellings. Blocking since the copy rewrite
# landed; pr-ci.yml runs the same command.
run_check "Copy metrics (content/driftless.md)" "$PYTHON" scripts/copy_metrics.py content/driftless.md --links 3

# Report results
echo ""
if [ "$ERRORS" -eq 0 ]; then
    echo -e "${GREEN}✓ Validation passed! No errors found.${NC}"
    exit 0
else
    echo -e "${RED}✗ Validation failed — $ERRORS check(s) failed:${NC}"
    for label in "${FAILED[@]}"; do
        echo -e "${RED}    - $label${NC}"
    done
    exit 1
fi
