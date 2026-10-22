#!/usr/bin/env bash
# Regenerate the driftless demo bundle from a released driftless tag, then
# validate the result against its OWN manifest.json — no hard-coded page
# count, script count or path. See scripts/test_driftless_bin.py.
#
# Usage: bin/driftless-bundle-regen.sh <tag> [--driftless-checkout <path>] [--python <interpreter>]
# Checkout/interpreter default to DRIFTLESS_CHECKOUT / DRIFTLESS_PYTHON.
set -euo pipefail
usage() { echo "usage: $0 <tag> [--driftless-checkout <path>] [--python <interpreter>]" >&2; exit 64; }
# The test suite sources this file (DRIFTLESS_BUNDLE_REGEN_SOURCE_ONLY=1) to
# exercise validate_manifest_dir() alone, without a tag or checkout to hand.
if [ "${DRIFTLESS_BUNDLE_REGEN_SOURCE_ONLY:-}" != "1" ]; then
  TAG="${1:?tag, e.g. v0.4.0}"
  shift || true
  CHECKOUT="${DRIFTLESS_CHECKOUT:-}"
  PYTHON="${DRIFTLESS_PYTHON:-}"
  while [ $# -gt 0 ]; do
    case "$1" in
      --driftless-checkout) CHECKOUT="${2:?}"; shift 2 ;;
      --python) PYTHON="${2:?}"; shift 2 ;;
      *) usage ;;
    esac
  done
  [ -n "$CHECKOUT" ] || { echo "error: no driftless checkout — pass --driftless-checkout <path> or set DRIFTLESS_CHECKOUT" >&2; exit 1; }
  [ -n "$PYTHON" ] || { echo "error: no python interpreter — pass --python <interpreter> or set DRIFTLESS_PYTHON" >&2; exit 1; }
  [ -d "$CHECKOUT" ] || { echo "error: driftless checkout not found: $CHECKOUT" >&2; exit 1; }
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${OUT:-$ROOT/static/demo/driftless}"
# validate_manifest_dir <bundle-dir> <expected-source>
# A key the manifest doesn't carry yet (pages, sha256, scripts) is reported
# "skip", not failed — so this passes honestly against an older bundle.
validate_manifest_dir() {
  local dir="$1" expected="$2" manifest="$1/manifest.json" fail=0
  [ -f "$manifest" ] || { echo "FAIL manifest.json missing at $dir"; return 1; }
  local files; files=$(python3 -c "import json;print('\n'.join(json.load(open('$manifest')).get('files',[])))")
  if [ -z "$files" ]; then echo "FAIL manifest has no 'files' entries"; fail=1; else
    while IFS= read -r n; do [ -n "$n" ] || continue
      if [ -f "$dir/$n" ]; then echo "ok   files entry exists: $n"; else echo "FAIL files entry missing on disk: $n"; fail=1; fi
    done <<<"$files"
  fi
  local pages; pages=$(python3 -c "d=__import__('json').load(open('$manifest'));print(d['pages'] if 'pages' in d else '__MISSING__')")
  local html_count; html_count=$(find "$dir" -maxdepth 1 -name '*.html' | wc -l | tr -d ' ')
  if [ "$pages" = "__MISSING__" ]; then echo "skip pages (manifest has no 'pages' key)"
  elif [ "$pages" = "$html_count" ]; then echo "ok   pages = $pages"
  else echo "FAIL pages = $pages (want $html_count)"; fail=1; fi
  local sha; sha=$(python3 -c "
import json
d=json.load(open('$manifest')).get('sha256')
print('__MISSING__' if d is None else '\n'.join(f'{k}\t{v}' for k,v in d.items()))")
  if [ "$sha" = "__MISSING__" ]; then echo "skip sha256 (manifest has no 'sha256' key)"; else
    while IFS=$'\t' read -r n want; do [ -n "$n" ] || continue
      local got; got=$(sha256sum <"$dir/$n" | cut -d' ' -f1)
      if [ "$got" = "$want" ]; then echo "ok   sha256 $n"; else echo "FAIL sha256 $n = $got (want $want)"; fail=1; fi
    done <<<"$sha"
  fi
  local src_val; src_val=$(python3 -c "print(__import__('json').load(open('$manifest')).get('source',''))")
  if [ "$src_val" = "$expected" ]; then echo "ok   source = $src_val"; else echo "FAIL source = $src_val (want $expected)"; fail=1; fi
  local scripts; scripts=$(python3 -c "
import json
d=json.load(open('$manifest')).get('scripts')
print('__MISSING__' if d is None else '\n'.join(d))")
  local hf
  for hf in "$dir"/*.html; do
    [ -e "$hf" ] || continue
    local n cnt; n=$(basename "$hf")
    cnt=$({ /bin/grep -oi '<script\b' "$hf" || true; } | wc -l | tr -d ' ')
    if [ "$cnt" -gt 1 ]; then echo "FAIL $n has $cnt <script tags (want at most 1)"; fail=1
    elif [ "$cnt" -eq 1 ]; then
      local sv; sv=$({ /bin/grep -ioE '<script[^>]*\bsrc="[^"]*"' "$hf" || true; } | head -1 | { /bin/grep -oE 'src="[^"]*"' || true; } | sed -E 's/^src="(.*)"$/\1/')
      if [ "$scripts" = "__MISSING__" ]; then echo "skip $n script provenance (manifest has no 'scripts' key)"
      elif printf '%s\n' "$scripts" | /bin/grep -qxF "$sv"; then echo "ok   $n script $sv listed in manifest scripts"
      else echo "FAIL $n script $sv not listed in manifest scripts"; fail=1; fi
    fi
  done
  if /bin/grep -lI '<form' "$dir"/* >/dev/null 2>&1; then echo "FAIL <form present on disk"; fail=1
  else echo "ok   no <form on disk"; fi
  if /bin/grep -lI '/login' "$dir"/* >/dev/null 2>&1; then echo "FAIL /login reference present on disk"; fail=1
  else echo "ok   no /login reference on disk"; fi
  # .driftless-static-showcase is a legitimate committed provenance dotfile;
  # this checks the marker string never LEAKS into served page/script content.
  if /bin/grep -rlF '.driftless-static-showcase' "$dir"/*.html "$dir"/*.js >/dev/null 2>&1; then
    echo "FAIL .driftless-static-showcase marker leaked into served content"; fail=1
  else echo "ok   no .driftless-static-showcase marker in served content"; fi
  return "$fail"
}
# sync_release_demo <bundle-manifest> <release-record>
# Copy the new bundle's source/anchor/pages into the release record's "demo"
# block, which scripts/test_release_data.py holds equal to the manifest — so a
# regen commit can't leave the record pointing at the previous bundle.
sync_release_demo() {
  python3 - "$1" "$2" <<'PY'
import json, sys
man = json.load(open(sys.argv[1], encoding="utf-8"))
with open(sys.argv[2], encoding="utf-8") as f:
    rec = json.load(f)
pages = man["pages"] if "pages" in man else len([n for n in man.get("files", []) if n.endswith(".html")])
rec["demo"].update(source=man["source"], anchor=man["anchor"], pages=pages)
with open(sys.argv[2], "w", encoding="utf-8") as f:
    f.write(json.dumps(rec, indent=2, ensure_ascii=False) + "\n")
print(f"ok   {sys.argv[2]} demo = {man['source']}, {pages} pages")
PY
}
if [ "${DRIFTLESS_BUNDLE_REGEN_SOURCE_ONLY:-}" = "1" ]; then return 0 2>/dev/null || exit 0; fi
cd "$CHECKOUT"
git fetch -q origin --tags
git checkout -q --detach "$TAG"
echo "source: $(git log --oneline -1)"
PYTHONPATH="$CHECKOUT" "$PYTHON" bin/driftless-showcase.py --out "$OUT" --source "$TAG"
validate_manifest_dir "$OUT" "$TAG"
sync_release_demo "$OUT/manifest.json" "${RELEASE_RECORD:-$ROOT/data/releases/driftless.json}"
