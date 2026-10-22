"""The committed waypost demo stays a closed, read-only fictional bundle."""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / "static" / "demo" / "waypost"


def test_product_page_links_to_the_demo() -> None:
    page = (ROOT / "content" / "waypost.md").read_text(encoding="utf-8")
    assert "](/demo/waypost/)" in page


def test_manifest_owns_every_published_page_and_the_bundle_is_inert() -> None:
    manifest = json.loads((DEMO / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["kind"] == "waypost-static-showcase"
    assert manifest["anchor"] == "2026-09-01"
    assert re.fullmatch(r"[0-9a-f]{7,40}", manifest["source"])
    actual = sorted(path.name for path in DEMO.glob("*.html"))
    assert manifest["files"] == actual
    assert len(actual) >= 5

    for name in actual:
        page = (DEMO / name).read_text(encoding="utf-8")
        assert "Fixed fictional demo" in page, name
        assert '<meta name="robots" content="noindex, nofollow">' in page, name
        assert not re.search(r"<(?:script|form|button|input)\b", page, re.I), name
        assert not re.search(r'href="/', page), name


def test_every_static_demo_link_resolves_inside_the_bundle() -> None:
    files = set(path.name for path in DEMO.glob("*.html"))
    for name in files:
        page = (DEMO / name).read_text(encoding="utf-8")
        links = re.findall(r'href="([^"]+\.html)(?:[?#][^"]*)?"', page)
        assert set(links) <= files, f"{name}: missing {sorted(set(links) - files)}"
