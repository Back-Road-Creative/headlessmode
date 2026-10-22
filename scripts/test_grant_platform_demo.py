"""The committed Grant Platform demo stays a closed, read-only generated bundle."""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / "static" / "demo" / "grant-platform"


def test_product_page_links_to_the_generated_demo() -> None:
    page = (ROOT / "content" / "grant-platform.md").read_text(encoding="utf-8")
    assert "](/demo/grant-platform/)" in page


def test_manifest_owns_every_published_page_and_the_bundle_is_inert() -> None:
    manifest = json.loads((DEMO / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["kind"] == "grant-platform-static-showcase"
    assert manifest["anchor"] == "2026-09-01"
    assert re.fullmatch(r"[0-9a-f]{7,40}", manifest["source"])
    actual = sorted(path.name for path in DEMO.glob("*.html"))
    assert manifest["files"] == actual
    assert len(actual) == len(manifest["files"]) > 0

    for name in actual:
        page = (DEMO / name).read_text(encoding="utf-8")
        assert "Fixed fictional demo" in page, name
        assert '<meta name="robots" content="noindex, nofollow">' in page, name
        assert not re.search(r"<(?:script|form|button)\b", page, re.I), name
        assert not re.search(r'href="/', page), name


def test_every_page_shows_seeded_rows_not_an_empty_state() -> None:
    """The bundle is the seeded scenario, not the demo pack's empty surfaces."""
    empty = (
        "Nothing catalogued yet",
        "belong to an organization you are a member of",
        "You are not a member of any organization",
        "No opportunities",
        "This report has no row",
    )
    for path in sorted(DEMO.glob("*.html")):
        page = path.read_text(encoding="utf-8")
        for phrase in empty:
            assert phrase not in page, f"{path.name}: {phrase!r}"


def test_every_static_demo_link_resolves_inside_the_bundle() -> None:
    files = set(path.name for path in DEMO.glob("*.html"))
    for name in files:
        page = (DEMO / name).read_text(encoding="utf-8")
        links = re.findall(r'href="([^"]+\.html)(?:[?#][^"]*)?"', page)
        assert set(links) <= files, f"{name}: missing {sorted(set(links) - files)}"


def test_every_page_carries_both_return_destinations() -> None:
    """The sticky bar on every page leads back to the site and to the product sheet."""
    home = '<a class="showcase-home" href="https://headlessmode.com/">'
    product = '<a class="showcase-product" href="https://headlessmode.com/grant-platform/">'
    manifest = json.loads((DEMO / "manifest.json").read_text(encoding="utf-8"))
    for name in manifest["files"]:
        page = (DEMO / name).read_text(encoding="utf-8")
        assert page.count(home) == 1, name
        assert page.count(product) == 1, name
