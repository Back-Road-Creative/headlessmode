#!/usr/bin/env python3
"""Framegrade's roster row, its page, and the Waypost page that names it.

Source-only (no Hugo build): data/systems.json, content/framegrade.md,
content/waypost.md, data/releases/framegrade.json.

Framegrade is the media engine Waypost runs underneath. It is a pre-release
product with a public repository (Apache-2.0) and no dated release, so the page
may describe what the engine does and must carry no price, count, date or
availability promise (business facts come only from the owner).

Run: pytest scripts/test_framegrade_page.py -v
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).parent.parent
SYSTEMS = json.loads((ROOT / "data" / "systems.json").read_text(encoding="utf-8"))["systems"]
PAGE = ROOT / "content" / "framegrade.md"
WAYPOST = ROOT / "content" / "waypost.md"
RELEASE = ROOT / "data" / "releases" / "framegrade.json"

# data/systems.json's Waypost blurb, pinned: the Framegrade row must not edit it.
WAYPOST_BLURB = (
    "A console on your own computer that runs a creator's video, photo and SEO "
    "work and queues posts for YouTube, Instagram and Facebook, one tab per brand"
)


def _row(name: str) -> dict:
    rows = [s for s in SYSTEMS if s["name"] == name]
    assert len(rows) == 1, f"expected exactly one {name!r} row, found {len(rows)}"
    return rows[0]


def test_framegrade_is_a_product_row_with_no_invented_facts() -> None:
    row = _row("Framegrade")
    assert row["tier"] == "product"
    assert row["access"] == "engagement"
    assert row["link"] == "/framegrade/"
    assert row["shipped"] is None
    assert not row["blurb"].endswith("."), "blurb carries no closing period"
    for key in ("download", "install", "store"):
        assert key not in row, f"no {key!r}: no installer or release exists"
    assert row["repo"] == "https://github.com/Back-Road-Creative/framegrade"


def test_framegrade_rank_is_unique_among_products() -> None:
    ranks = [s["homepage_rank"] for s in SYSTEMS if s["tier"] == "product" and "homepage_rank" in s]
    assert len(ranks) == len(set(ranks))
    assert "homepage_rank" in _row("Framegrade")


def test_waypost_blurb_is_unchanged() -> None:
    assert _row("Waypost")["blurb"] == WAYPOST_BLURB


def test_framegrade_page_has_frontmatter_documentation_and_access_note() -> None:
    text = PAGE.read_text(encoding="utf-8")
    assert text.startswith("---\n")
    fm = text.split("---\n", 2)[1]
    assert re.search(r"^title:", fm, re.M) and re.search(r"^description:", fm, re.M)
    assert re.search(r"^draft:\s*false", fm, re.M)
    assert "\n## Documentation\n" in text
    assert "pre-release" in text.lower()
    assert "/waypost/" in text


def test_framegrade_page_states_no_price_count_or_date() -> None:
    body = PAGE.read_text(encoding="utf-8").split("---\n", 2)[2]
    assert "$" not in body and "%" not in body
    assert not re.search(r"\b20\d\d\b", body), "no year or date in prose"
    assert not re.search(r"\b\d+\s*(fps|customers|users|hours|minutes)\b", body, re.I)
    for word in ("pricing", "per month", "free trial", "coming soon", "launch", "own brands"):
        assert word not in body.lower(), word


def test_framegrade_release_record_is_honest() -> None:
    rec = json.loads(RELEASE.read_text(encoding="utf-8"))
    assert rec["product"] == "framegrade" and rec["name"] == "Framegrade"
    assert rec["release_source"] == "manual" and rec["notes"]
    assert rec["source_repo"] == "Back-Road-Creative/framegrade"
    assert "no product repository" not in rec["notes"]
    assert rec["version"] is None and rec["released_at"] is None
    assert rec["demo"] is None and rec["assets"] == {}


def test_waypost_tools_underneath_names_framegrade_with_the_four_tools() -> None:
    text = WAYPOST.read_text(encoding="utf-8")
    start = text.index("**Tools underneath.**")
    para = text[start:text.index("\n\n", start)]
    links = re.findall(r"\]\((/[a-z-]+/)\)", para)
    assert links == ["/framegrade/", "/keycut/", "/redactcam/", "/pycube-lut/", "/sun-track/"]
