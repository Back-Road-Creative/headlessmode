#!/usr/bin/env bash
# bin/product-sync.sh <slug> <tag> [--release-json <path>] [--asset <path>]
#                      [--releases-dir <dir>] [--demo-dir <dir>]
#
# Offline, testable step of the product-sync workflow
# (.github/workflows/product-sync.yml). Given a release JSON payload (the
# shape `gh api repos/<owner>/<repo>/releases/tags/<tag>` returns) and, for
# driftless, the downloaded showcase tarball, this:
#
#   - driftless only: extracts the tarball into the demo dir (replacing its
#     contents) and validates the result with bin/driftless-bundle-regen.sh's
#     own validate_manifest_dir() — sourced, never copied;
#   - updates data/releases/<slug>.json in place: version, released_at,
#     release_url, source_ref, assets (name -> {url, sha256}), and for
#     driftless demo.source/anchor/pages from the extracted manifest.json.
#     Every other key in the file is left untouched.
#
# No network calls happen here — the caller (the workflow) downloads the
# release JSON and the asset first. Exits non-zero with a plain message on
# any inconsistency: tag vs manifest source mismatch, a release-data file
# missing required keys, or a missing input file.
set -euo pipefail

usage() {
  echo "usage: $0 <slug> <tag> [--release-json <path>] [--asset <path>] [--releases-dir <dir>] [--demo-dir <dir>]" >&2
  exit 64
}

[ $# -ge 2 ] || usage
SLUG="$1"; TAG="$2"; shift 2

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_JSON=""
ASSET_PATH=""
RELEASES_DIR="$ROOT/data/releases"
DEMO_DIR="$ROOT/static/demo/driftless"

while [ $# -gt 0 ]; do
  case "$1" in
    --release-json) RELEASE_JSON="${2:?}"; shift 2 ;;
    --asset) ASSET_PATH="${2:?}"; shift 2 ;;
    --releases-dir) RELEASES_DIR="${2:?}"; shift 2 ;;
    --demo-dir) DEMO_DIR="${2:?}"; shift 2 ;;
    *) usage ;;
  esac
done

[ -n "$RELEASE_JSON" ] || { echo "error: --release-json is required" >&2; exit 1; }
[ -f "$RELEASE_JSON" ] || { echo "error: release json not found: $RELEASE_JSON" >&2; exit 1; }

RELEASES_FILE="$RELEASES_DIR/$SLUG.json"
[ -f "$RELEASES_FILE" ] || { echo "error: release data file not found: $RELEASES_FILE" >&2; exit 1; }

DEMO_SOURCE=""
DEMO_ANCHOR=""
DEMO_PAGES=""

if [ "$SLUG" = "driftless" ]; then
  [ -n "$ASSET_PATH" ] || { echo "error: driftless requires --asset <tarball>" >&2; exit 1; }
  [ -f "$ASSET_PATH" ] || { echo "error: asset not found: $ASSET_PATH" >&2; exit 1; }

  rm -rf "$DEMO_DIR"
  mkdir -p "$DEMO_DIR"
  tar -xzf "$ASSET_PATH" -C "$DEMO_DIR"

  [ -f "$DEMO_DIR/manifest.json" ] || { echo "error: extracted bundle has no manifest.json" >&2; exit 1; }

  MANIFEST_SOURCE=$(python3 -c "import json;print(json.load(open('$DEMO_DIR/manifest.json')).get('source',''))")
  if [ "$MANIFEST_SOURCE" != "$TAG" ]; then
    echo "error: tag ($TAG) does not match extracted manifest source ($MANIFEST_SOURCE)" >&2
    exit 1
  fi

  # Validate with the existing validator — call it, don't copy it. Guard
  # around set -e: a FAIL line is a normal (non-exceptional) outcome here,
  # not a script bug, so we inspect the output ourselves.
  REGEN="$ROOT/bin/driftless-bundle-regen.sh"
  set +e
  VALIDATE_OUT=$(DRIFTLESS_BUNDLE_REGEN_SOURCE_ONLY=1 bash -c "
    source '$REGEN'
    validate_manifest_dir '$DEMO_DIR' '$TAG'
  ")
  set -e
  echo "$VALIDATE_OUT"
  if echo "$VALIDATE_OUT" | /bin/grep -q '^FAIL'; then
    echo "error: driftless-bundle-regen.sh validate_manifest_dir reported a FAIL for $DEMO_DIR" >&2
    exit 1
  fi

  DEMO_SOURCE="$TAG"
  DEMO_ANCHOR=$(python3 -c "import json;print(json.load(open('$DEMO_DIR/manifest.json')).get('anchor',''))")
  DEMO_PAGES=$(python3 -c "import json;print(json.load(open('$DEMO_DIR/manifest.json')).get('pages',''))")
fi

PS_SLUG="$SLUG" PS_TAG="$TAG" PS_RELEASES_FILE="$RELEASES_FILE" \
PS_RELEASE_JSON="$RELEASE_JSON" PS_ASSET_PATH="$ASSET_PATH" \
PS_DEMO_SOURCE="$DEMO_SOURCE" PS_DEMO_ANCHOR="$DEMO_ANCHOR" PS_DEMO_PAGES="$DEMO_PAGES" \
python3 - <<'PY'
import hashlib
import json
import os
import re
import sys

slug = os.environ["PS_SLUG"]
tag = os.environ["PS_TAG"]
releases_file = os.environ["PS_RELEASES_FILE"]
release_json_path = os.environ["PS_RELEASE_JSON"]
asset_path = os.environ.get("PS_ASSET_PATH") or None
demo_source = os.environ.get("PS_DEMO_SOURCE") or None
demo_anchor = os.environ.get("PS_DEMO_ANCHOR") or None
demo_pages = os.environ.get("PS_DEMO_PAGES") or None

REQUIRED_KEYS = [
    "product", "name", "release_source", "source_repo", "version",
    "released_at", "release_url", "source_ref", "assets", "demo",
    "media_source", "notes",
]

with open(releases_file, encoding="utf-8") as f:
    data = json.load(f)

missing = [k for k in REQUIRED_KEYS if k not in data]
if missing:
    print(f"error: {releases_file} is missing keys: {', '.join(missing)}", file=sys.stderr)
    sys.exit(1)

with open(release_json_path, encoding="utf-8") as f:
    payload = json.load(f)

tag_name = payload.get("tag_name")
if tag_name != tag:
    print(
        f"error: tag argument ({tag}) does not match release payload tag_name ({tag_name})",
        file=sys.stderr,
    )
    sys.exit(1)

source = payload.get("release_source", "github-release")
if source != data["release_source"]:
    sys.exit("error: payload release_source does not match product ledger")
if source == "github-tag":
    sha = payload.get("source_commit", "")
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        sys.exit("error: source tag requires a verified commit SHA")
    if payload.get("published_at") is not None or payload.get("assets"):
        sys.exit("error: a source tag cannot claim a release date or release assets")
    expected_url = f"https://github.com/{data['source_repo']}/tree/{tag}"
    if payload.get("html_url") != expected_url:
        sys.exit("error: source tag URL does not match the product repository")
    data["source_commit"] = sha

version = tag[1:] if tag.startswith("v") else tag

assets = {}
for a in payload.get("assets", []):
    name = a.get("name")
    url = a.get("browser_download_url")
    if not name or not url:
        continue
    entry = {"url": url}
    if asset_path and os.path.basename(asset_path) == name:
        h = hashlib.sha256()
        with open(asset_path, "rb") as af:
            for chunk in iter(lambda: af.read(65536), b""):
                h.update(chunk)
        entry["sha256"] = h.hexdigest()
    else:
        # Not downloaded: use the release asset's own digest ("sha256:<hex>"), else null.
        digest = a.get("digest")
        entry["sha256"] = digest[len("sha256:"):] if isinstance(digest, str) and digest.startswith("sha256:") else None
    assets[name] = entry

data["version"] = version
data["released_at"] = payload.get("published_at", data.get("released_at"))
data["release_url"] = payload.get("html_url", data.get("release_url"))
data["source_ref"] = tag
data["assets"] = assets

if demo_source:
    demo = dict(data.get("demo") or {})
    demo["source"] = demo_source
    if demo_anchor:
        demo["anchor"] = demo_anchor
    if demo_pages:
        try:
            demo["pages"] = int(demo_pages)
        except ValueError:
            demo["pages"] = demo_pages
    data["demo"] = demo

with open(releases_file, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")

print(f"synced {releases_file}: version={version} source_ref={tag}")
PY
