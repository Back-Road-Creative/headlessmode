#!/usr/bin/env bash
# Production smoke for the driftless demo bundle: every file the COMMITTED
# manifest lists is served, the served manifest is byte-identical to the
# committed one, provenance matches the given tag, and a spot-check of
# sha256 entries (when the manifest carries any) matches the live bytes.
#
# Usage: bin/driftless-prod-smoke.sh <tag> [--base-url https://headlessmode.com]
set -uo pipefail
usage() { echo "usage: $0 <tag> [--base-url <url>]" >&2; exit 64; }
TAG="${1:?tag, e.g. v0.4.0}"
shift || true
BASE_URL="https://headlessmode.com"
while [ $# -gt 0 ]; do
  case "$1" in
    --base-url) BASE_URL="${2:?}"; shift 2 ;;
    *) usage ;;
  esac
done
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="$ROOT/static/demo/driftless"
MANIFEST="$BUNDLE/manifest.json"
DEMO_BASE="${BASE_URL%/}/demo/driftless"
[ -f "$MANIFEST" ] || { echo "FAIL committed manifest missing: $MANIFEST" >&2; exit 1; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
pass_count=0
fail_count=0
row() {
  local status="$1"; shift
  if [ "$status" = ok ]; then pass_count=$((pass_count + 1)); else fail_count=$((fail_count + 1)); fi
  printf '%-4s %s\n' "$status" "$*"
}
code() { curl -sSL -o "$1" -w '%{http_code}' "$2"; }
files=$(python3 -c "import json;print('\n'.join(json.load(open('$MANIFEST'))['files']))")
while IFS= read -r name; do
  [ -n "$name" ] || continue
  if [ "${name%.html}" != "$name" ]; then
    stem="${name%.html}"
    c=$(code /dev/null "$DEMO_BASE/$stem")
    if [ "$c" = 200 ]; then row ok "$stem -> $c"; else row FAIL "$stem -> $c (want 200)"; fi
    c2=$(curl -s -o /dev/null -w '%{http_code}' "$DEMO_BASE/$name")
    if [ "$c2" = 200 ] || [ "$c2" = 308 ]; then row ok "$name -> $c2"; else row FAIL "$name -> $c2 (want 200 or 308)"; fi
  else
    c=$(code /dev/null "$DEMO_BASE/$name")
    if [ "$c" = 200 ]; then row ok "$name -> $c"; else row FAIL "$name -> $c (want 200)"; fi
  fi
done <<<"$files"
curl -sSL -o "$TMP/manifest.json" "$DEMO_BASE/manifest.json"
if cmp -s "$MANIFEST" "$TMP/manifest.json"; then row ok "manifest.json byte-identical to committed"
else row FAIL "manifest.json differs from committed"; fi
live_source=$(python3 -c "
import json
try: print(json.load(open('$TMP/manifest.json')).get('source',''))
except Exception: print('')")
if [ "$live_source" = "$TAG" ]; then row ok "manifest source = $live_source"; else row FAIL "manifest source = $live_source (want $TAG)"; fi
sha_sample=$(python3 -c "
import json
d=json.load(open('$MANIFEST')).get('sha256')
print('__MISSING__' if not d else '\n'.join(f'{k}\t{d[k]}' for k in sorted(d)[:3]))")
if [ "$sha_sample" = "__MISSING__" ]; then
  echo "skip sha256 spot-check (committed manifest has no 'sha256' key)"
else
  while IFS=$'\t' read -r name want; do
    [ -n "$name" ] || continue
    got=$(curl -sSL "$DEMO_BASE/$name" | sha256sum | cut -d' ' -f1)
    if [ "$got" = "$want" ]; then row ok "sha256 $name"; else row FAIL "sha256 $name = $got (want $want)"; fi
  done <<<"$sha_sample"
fi
echo
echo "PASS: $pass_count  FAIL: $fail_count"
[ "$fail_count" -eq 0 ]
