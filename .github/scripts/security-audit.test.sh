#!/usr/bin/env bash
# security-audit.test.sh — regression tests for the three defects fixed alongside
# this file. Each test fails against the previous security-audit.sh.
#
# Run: .github/scripts/security-audit.test.sh
#
# GNU grep only. A local `grep` that wraps ugrep honours \x escapes inside
# bracket expressions and will mask test 1 entirely, so the real binary is used
# explicitly — that is the same difference that hid the bug in the first place.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIT="$SCRIPT_DIR/security-audit.sh"
GREP=/bin/grep
[[ -x "$GREP" ]] || GREP=grep

PASS=0
FAIL=0
ok()   { echo "  ok   - $1"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL - $1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------- 1. quoting
# `["\x27]` is a bracket expression, not an escape: under GNU grep it is the set
# { " \ x 2 7 }. Single-quoted credentials were never matched.
echo "1. secret scan sees single-quoted credentials"

SQ="'"
QUOTED="[\"${SQ}]"
UNQUOTED="[^\"${SQ}]"
PATTERN="(password|apiSecret|api_secret|secretKey|secret_key)\s*[:=]\s*${QUOTED}${UNQUOTED}{8,}"
OLD_PATTERN='(password|apiSecret|api_secret|secretKey|secret_key)\s*[:=]\s*["\x27][^"\x27]{8,}'

printf 'const password = %ssupersecret123%s;\n' "$SQ" "$SQ" > "$TMP/single.js"
printf 'const password = "supersecret123";\n'                 > "$TMP/double.js"

if $GREP -qiE "$PATTERN" "$TMP/single.js"; then ok "single-quoted secret detected"
else bad "single-quoted secret NOT detected"; fi

if $GREP -qiE "$PATTERN" "$TMP/double.js"; then ok "double-quoted secret still detected"
else bad "double-quoted secret regressed"; fi

# Pin the defect itself, so a revert to the old form is caught rather than
# silently reintroduced.
if $GREP -qiE "$OLD_PATTERN" "$TMP/single.js"; then
    bad "old pattern unexpectedly matches - this grep is not GNU grep, test 1 is not meaningful"
else ok "old pattern demonstrably missed it (defect reproduced)"; fi

# ------------------------------------------------------------ 2. exit codes
# Severity order is 1 (critical) > 2 (warnings) > 0 (clean), which is not
# numeric order. The old reducer downgraded 2 to 0 on a later clean URL.
echo "2. worst-of exit code never downgrades"

# Call the REAL reducer from the script under test. Asserting against a copy of
# the logic here would pass even if security-audit.sh regressed.
# shellcheck disable=SC1090
source "$AUDIT"

check_worst() {   # $1 expected, rest inputs
    local want="$1"; shift
    local got; got=$(worst_exit_of "$@")
    if [[ "$got" == "$want" ]]; then ok "worst_exit_of($*) = $want"
    else bad "worst_of($*) = $got, expected $want"; fi
}

check_worst 2 2 0      # the original defect: warn then clean must stay 2
check_worst 1 1 0      # critical then clean must stay 1
check_worst 1 2 1      # critical must beat warnings
check_worst 1 1 2      # warnings must not overwrite critical
check_worst 0 0 0
check_worst 2 0 2

# ----------------------------------------------------------------- 3. JSON
# Findings carry text the audited site controls. It must never reach Python as
# source, and must survive quotes and backslashes intact.
echo "3. JSON report is data, not interpolated source"

if [[ ! -r "$AUDIT" ]]; then
    bad "cannot read $AUDIT"
else
    # A message carrying both quote kinds, a backslash, and text that would run
    # if it ever reached Python as source. Appearing in the JSON is correct —
    # it is data. Executing, or corrupting the JSON, is not.
    MSG='Server: nginx "1.2" '"$SQ"'+__import__(\"os\").system(\"id\")+'"$SQ"
    OUT=$(
        # shellcheck disable=SC1090
        source "$AUDIT"
        FINDINGS=("WARN|server|$MSG")
        CRITICALS=0
        WARNINGS=1
        generate_json_report "https://example.com" 2>/dev/null
    )

    if [[ -z "$OUT" ]]; then
        bad "generate_json_report produced no output"
    elif [[ "${OUT:0:1}" != "{" ]]; then
        bad "output has content before the JSON document - something else ran"
    elif ! printf '%s' "$OUT" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
        bad "output is not valid JSON - the finding corrupted the document"
    else
        ok "valid JSON despite quotes and backslashes in the finding"
        if MSG="$MSG" printf '%s' "$OUT" | MSG="$MSG" python3 -c '
import json, os, sys
r = json.load(sys.stdin)
f = r["findings"]
sys.exit(0 if len(f) == 1
         and f[0]["severity"] == "WARN"
         and f[0]["category"] == "server"
         and f[0]["message"] == os.environ["MSG"] else 1)'; then
            ok "finding round-tripped byte for byte, as data"
        else
            bad "finding was mangled or split"
        fi
        if [[ "$(printf '%s' "$OUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["summary"]["warnings"])')" == "1" ]]; then
            ok "summary counters preserved"
        else
            bad "summary counters wrong"
        fi
    fi
fi

echo
echo "passed=$PASS failed=$FAIL"
[[ "$FAIL" -eq 0 ]]
