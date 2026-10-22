#!/usr/bin/env python3
"""drift_probe_demo.py — post-deploy live probe for the committed Driftless demo.

Nothing checks /demo/driftless/ after a deploy: the rigscore/quiet-corners
probes in drift-sentinel.yml only cover those two surfaces, and
deploy-production.yml's wait step only polls deploy-marker.txt (proves a
deploy landed, not that the demo bundle it shipped still matches what's
committed). This closes that hole the same way — read the committed
static/demo/driftless/manifest.json, then probe the live site against it:

  1. GET <site>/demo/driftless/manifest.json — `source` and `files` must
     equal the committed manifest.
  2. GET the index page and one non-index page (extensionless — Cloudflare
     Pages serves *.html clean) — both must be 200, and each body must hash
     to the committed manifest's `sha256` for that file. Cloudflare Web
     Analytics' beacon, which the edge adds before </body> of every HTML
     response, is taken out first; any other difference fails. A manifest
     with no `sha256` map prints a SKIP notice instead of the hash checks.

Exit 0 if every probe passes or is skipped, 1 on any FAIL — mirrors
scripts/verify-claims.js's FAIL:/SKIP: line style so drift-sentinel.yml can
grep it the same way.

Usage: python3 scripts/drift_probe_demo.py [site-url]
       SITE_URL env var also honoured; positional arg wins.
"""
import hashlib
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / "static" / "demo" / "driftless" / "manifest.json"
TIMEOUT = 30
# With Web Analytics on for the Pages project, Cloudflare adds this one line
# before </body> of every HTML response. The bundle never carries it, so a hash
# of the raw body could never match. Only this exact element is taken out.
CF_BEACON = re.compile(
    rb'<script\b[^<>]*\bsrc="https://static\.cloudflareinsights\.com/beacon\.min\.js[^"]*"'
    rb"[^<>]*></script>\n?(?=</body>)"
)

results = []  # (status, message) where status is PASS / FAIL / SKIP


def record(status: str, message: str) -> None:
    results.append((status, message))
    print(f"{status}: {message}")


def fetch(url: str) -> tuple[int, bytes] | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "drift-probe-demo"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as err:
        return err.code, b""
    except (urllib.error.URLError, OSError, TimeoutError) as err:
        record("FAIL", f"{url} unreachable: {err}")
        return None


def main() -> int:
    site = sys.argv[1] if len(sys.argv) > 1 else None
    if not site:
        import os

        site = os.environ.get("SITE_URL", "https://headlessmode.com")
    base = f"{site.rstrip('/')}/demo/driftless"

    committed = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    live = fetch(f"{base}/manifest.json")
    if live is None:
        record("FAIL", "live manifest.json unreachable — see above")
        return summarize()
    status, body = live
    if status != 200:
        record("FAIL", f"{base}/manifest.json returned {status}, expected 200")
        return summarize()
    try:
        live_manifest = json.loads(body)
    except json.JSONDecodeError as err:
        record("FAIL", f"{base}/manifest.json is not valid JSON: {err}")
        return summarize()

    if live_manifest.get("source") != committed["source"]:
        record(
            "FAIL",
            f"live manifest source={live_manifest.get('source')!r} != "
            f"committed source={committed['source']!r}",
        )
    else:
        record("PASS", f"live manifest source matches committed ({committed['source']})")

    if sorted(live_manifest.get("files", [])) != sorted(committed["files"]):
        record("FAIL", "live manifest files list != committed files list")
    else:
        record("PASS", "live manifest files list matches committed")

    html_pages = [f for f in committed["files"] if f.endswith(".html")]
    non_index = next((f for f in html_pages if f != "index.html"), None)
    probes = [("index.html", f"{base}/")]
    if non_index:
        probes.append((non_index, f"{base}/{Path(non_index).stem}"))
    sha_map = committed.get("sha256")
    if not sha_map:
        record("SKIP", "committed manifest has no sha256 map — page hashes not checked")

    for name, url in probes:
        page = fetch(url)
        if page is None:
            record("FAIL", f"{name} page unreachable — see above")
            continue
        page_status, page_body = page
        if page_status != 200:
            record("FAIL", f"{url} returned {page_status}, expected 200")
            continue
        if not sha_map:
            record("PASS", f"{url} is 200")
            continue
        body, beacons = CF_BEACON.subn(b"", page_body)
        digest = hashlib.sha256(body).hexdigest()
        if digest != sha_map.get(name):
            record("FAIL", f"sha256 mismatch for {name}: live={digest} committed={sha_map.get(name)}")
        else:
            note = " (Cloudflare's analytics beacon removed first)" if beacons else ""
            record("PASS", f"{url} is 200 and matches committed {name} byte for byte{note}")

    return summarize()


def summarize() -> int:
    passed = sum(1 for s, _ in results if s == "PASS")
    failed = sum(1 for s, _ in results if s == "FAIL")
    skipped = sum(1 for s, _ in results if s == "SKIP")
    print(f"\ndrift_probe_demo: {len(results)} probes — {passed} pass, {failed} fail, {skipped} skip.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
