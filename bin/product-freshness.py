#!/usr/bin/env python3
"""Report STALE when product-sync missed its schedule or a product lags its tag.

evaluate() is pure; main() is the thin gh wrapper. Exit 0 = fresh, 2 = STALE
(reasons on stdout, one per line, first line "STALE"), 1 = could not check.
Only github-tag products are checked; tag age is the tagged commit's date.
"""
import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

GRACE = timedelta(hours=36)
STABLE_TAG = re.compile(r"v?(\d+)\.(\d+)\.(\d+)")


def _ver(text):
    m = STABLE_TAG.fullmatch(text or "")
    return tuple(int(p) for p in m.groups()) if m else None


def evaluate(now, last_run, products, grace=GRACE):
    """products: dicts with slug, newest_tag, data_version, tag_time (aware datetimes)."""
    reasons = []
    if last_run is None:
        reasons.append("product-sync has no recorded run")
    elif now - last_run > grace:
        hours = (now - last_run).total_seconds() / 3600
        reasons.append(f"product-sync last ran {hours:.0f} h ago (limit {grace.total_seconds() / 3600:.0f} h)")
    for p in products:
        tag, have = _ver(p.get("newest_tag")), _ver(p.get("data_version"))
        if tag is None:
            continue
        if have is not None and have >= tag:
            continue
        age = now - p["tag_time"] if p.get("tag_time") else None
        if age is not None and age <= grace:
            continue
        shown = f"{age.total_seconds() / 3600:.0f} h" if age is not None else "unknown time"
        reasons.append(f"{p['slug']}: data is {p.get('data_version') or 'unset'} but newest tag is "
                       f"{p['newest_tag']} (tagged {shown} ago)")
    return reasons


def _gh(*args):
    out = subprocess.run(["gh", "api", *args], check=True, capture_output=True, text=True, timeout=60)
    return json.loads(out.stdout)


def _ts(text):
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def collect(root, repo):
    runs = _gh(f"repos/{repo}/actions/workflows/product-sync.yml/runs?per_page=1")["workflow_runs"]
    last_run = _ts(runs[0]["created_at"]) if runs else None
    products = []
    for f in sorted((root / "data" / "releases").glob("*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        if d.get("release_source") != "github-tag" or not d.get("source_repo"):
            continue
        src = d["source_repo"]
        tags = [t for page in _gh(f"repos/{src}/tags?per_page=100", "--paginate", "--slurp") for t in page]
        stable = [t for t in tags if _ver(t.get("name"))]
        if not stable:
            products.append({"slug": f.stem, "newest_tag": None, "data_version": d.get("version"), "tag_time": None})
            continue
        top = max(stable, key=lambda t: _ver(t["name"]))
        commit = _gh(f"repos/{src}/commits/{top['commit']['sha']}")
        products.append({"slug": f.stem, "newest_tag": top["name"], "data_version": d.get("version"),
                         "tag_time": _ts(commit["commit"]["committer"]["date"])})
    return last_run, products


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--repo", required=True, help="site repo owner/name that hosts product-sync")
    ap.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = ap.parse_args()
    try:
        last_run, products = collect(args.root, args.repo)
    except (subprocess.SubprocessError, OSError, ValueError, KeyError) as exc:
        print(f"error: cannot check freshness: {exc}", file=sys.stderr)
        return 1
    reasons = evaluate(datetime.now(timezone.utc), last_run, products)
    if reasons:
        print("STALE")
        for r in reasons:
            print(r)
        return 2
    print("FRESH")
    return 0


if __name__ == "__main__":
    sys.exit(main())
