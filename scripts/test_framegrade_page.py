#!/usr/bin/env python3
"""Framegrade's roster row, its page, and the Waypost page that names it.

Mostly source-only: data/systems.json, content/framegrade.md,
content/waypost.md, data/releases/framegrade.json. The two Release details
tests run a throwaway Hugo build against a copy of data/ (HUGO_DATADIR), so a
published-release record can be rendered before the real one exists.

Framegrade is the media engine used by the studio workflow. Its public
Apache-2.0 repository published source tags only until v0.3.15, its first
GitHub Release (a Windows installer and SHA256SUMS). The page names what the
release record holds without inventing a price or customer count.

Run: pytest scripts/test_framegrade_page.py -v
"""

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

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
        assert key not in row, f"no {key!r}: a source tag does not establish an installer"
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
    assert "versioned source package" in text.lower()
    assert "Release details" in text
    assert "no installer or versioned release" not in text
    assert "/waypost/" in text


def test_framegrade_page_states_no_price_count_or_date() -> None:
    body = PAGE.read_text(encoding="utf-8").split("---\n", 2)[2]
    assert "$" not in body and "%" not in body
    assert not re.search(r"\b20\d\d\b", body), "no year or date in prose"
    assert not re.search(r"\b\d+\s*(fps|customers|users|hours|minutes)\b", body, re.I)
    for word in ("pricing", "per month", "free trial", "coming soon", "launch", "own brands"):
        assert word not in body.lower(), word


def test_framegrade_release_record_is_honest() -> None:
    """v0.3.15 is Framegrade's first published GitHub Release: the record names
    its publication time and its two assets, each with a recorded SHA-256."""
    rec = json.loads(RELEASE.read_text(encoding="utf-8"))
    assert rec["product"] == "framegrade" and rec["name"] == "Framegrade"
    assert rec["release_source"] == "github-release" and rec["notes"]
    assert rec["source_repo"] == "Back-Road-Creative/framegrade"
    assert "no product repository" not in rec["notes"]
    assert "No desktop installer" not in rec["notes"]
    assert re.fullmatch(r"\d+\.\d+\.\d+", rec["version"])
    tag = f"v{rec['version']}"
    assert rec["source_ref"] == tag
    assert rec["release_url"] == f"https://github.com/Back-Road-Creative/framegrade/releases/tag/{tag}"
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", rec["released_at"])
    assert "source_commit" not in rec
    assert rec["demo"] is None
    base = f"https://github.com/Back-Road-Creative/framegrade/releases/download/{tag}"
    assert set(rec["assets"]) == {f"framegrade-setup-{rec['version']}.exe", "SHA256SUMS"}
    for name, asset in rec["assets"].items():
        assert asset["url"] == f"{base}/{name}"
        assert re.fullmatch(r"[0-9a-f]{64}", asset["sha256"] or ""), name


def _build_with_release(tmp_path: Path, record: dict) -> str:
    """Build the site with data/releases/framegrade.json swapped for `record`
    (HUGO_DATADIR points at a copy of data/) and return /framegrade/'s HTML.
    Renders the sheet only, so no public/ or map policy is written for deploy."""
    data = tmp_path / "data"
    shutil.copytree(ROOT / "data", data)
    (data / "releases" / "framegrade.json").write_text(json.dumps(record), encoding="utf-8")
    out = tmp_path / "out"
    subprocess.run(
        ["hugo", "--quiet", "--source", str(ROOT), "--configDir", "site-config",
         "--destination", str(out)],
        env={**os.environ, "HUGO_DATADIR": str(data)},
        check=True,
    )
    return (out / "framegrade" / "index.html").read_text(encoding="utf-8")


@pytest.mark.skipif(shutil.which("hugo") is None, reason="hugo not installed")
def test_a_published_release_lists_the_installer_and_sha256sums(tmp_path: Path) -> None:
    """W8: once product-sync records a published GitHub Release, Release details
    links each asset by name and shows the recorded sha256, so the Windows
    installer and SHA256SUMS reach the page from data, never from prose."""
    rec = json.loads(RELEASE.read_text(encoding="utf-8"))
    base = "https://github.com/Back-Road-Creative/framegrade/releases/download/v0.3.11"
    sha = "ab" * 32  # pragma: allowlist secret (fixture digest, not a credential)
    rec.update(
        release_source="github-release",
        version="0.3.11",
        released_at="2026-11-02T15:00:00Z",
        release_url="https://github.com/Back-Road-Creative/framegrade/releases/tag/v0.3.11",
        source_ref="v0.3.11",
        assets={
            "framegrade-setup-0.3.11.exe": {"url": f"{base}/framegrade-setup-0.3.11.exe", "sha256": sha},
            "SHA256SUMS": {"url": f"{base}/SHA256SUMS"},
        },
    )
    html = _build_with_release(tmp_path, rec)
    details = html[html.index('class="sheet-provenance"'):html.index("</details>")]
    assert "Latest release 0.3.11" in details
    assert f'<a href="{base}/framegrade-setup-0.3.11.exe">framegrade-setup-0.3.11.exe</a>' in details
    assert f'<a href="{base}/SHA256SUMS">SHA256SUMS</a>' in details
    assert sha in details
    assert "no GitHub Release assets" not in details


@pytest.mark.skipif(shutil.which("hugo") is None, reason="hugo not installed")
def test_a_source_tag_lists_no_assets(tmp_path: Path) -> None:
    rec = json.loads(RELEASE.read_text(encoding="utf-8"))
    rec.update(
        release_source="github-tag",
        version="0.3.13",
        released_at=None,
        release_url="https://github.com/Back-Road-Creative/framegrade/tree/v0.3.13",
        source_ref="v0.3.13",
        source_commit="ce504c05095d42df3234b903cb4adaaf10a1f83e",
        assets={},
    )
    html = _build_with_release(tmp_path, rec)
    details = html[html.index('class="sheet-provenance"'):html.index("</details>")]
    assert "Latest source tag" in details and "no GitHub Release assets" in details
    assert "sheet-assets" not in details


def test_waypost_tools_underneath_names_framegrade_with_the_four_tools() -> None:
    text = WAYPOST.read_text(encoding="utf-8")
    start = text.index("**Tools underneath.**")
    para = text[start:text.index("\n\n", start)]
    links = re.findall(r"\]\((/[a-z-]+/)\)", para)
    assert links == ["/framegrade/", "/keycut/", "/redactcam/", "/pycube-lut/", "/sun-track/"]
