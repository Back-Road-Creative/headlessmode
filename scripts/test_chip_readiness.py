"""Regression test for the system-chip readiness rule (H1 palette/layout pass).

themes/headlessmode/layouts/partials/system-chip.html renders "Pre-release"
for any data/systems.json entry with "shipped": null/empty, whatever its
tier, and keeps the existing tier label (e.g. "Product", "Free · open
source") once "shipped" carries a real month. Reads public/, like
scripts/test_systems_contract.py, so it runs AFTER the Hugo build.

Run: bash scripts/build-site.sh --configDir site-config --minify && pytest scripts/test_chip_readiness.py -v
"""

import json
from html.parser import HTMLParser
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
PUBLIC = ROOT / "public"
SYSTEMS = ROOT / "data" / "systems.json"


class _Chip(HTMLParser):
    """The first shelf-panel__chip span on a built page: (data-status, text).

    Parsed rather than pattern-matched. Production builds with --minify, which
    drops the quotes from single-token attributes (class=shelf-panel__chip
    data-status=free), so a pattern written against class="..." matches the
    unminified build and nothing PR CI or the deploy ships (the same reason
    test_systems_contract.py's _Roster is a parser).
    """

    def __init__(self) -> None:
        super().__init__()
        self.status: str | None = None
        self.text = ""
        self._in_chip = False
        self._done = False

    def handle_starttag(self, tag, attrs):
        if self._done or self._in_chip or tag != "span":
            return
        attr = dict(attrs)
        if "shelf-panel__chip" in (attr.get("class") or "").split():
            self.status = attr.get("data-status")
            self._in_chip = True

    def handle_data(self, data):
        if self._in_chip:
            self.text += data

    def handle_endtag(self, tag):
        if self._in_chip and tag == "span":
            self._in_chip = False
            self._done = True


def _systems() -> list[dict]:
    data = json.loads(SYSTEMS.read_text(encoding="utf-8"))
    return data["systems"]


def _onsite_page_entries() -> list[dict]:
    """systems.json entries whose "link" is a real on-site page."""
    return [
        s
        for s in _systems()
        if s.get("link") and not s["link"].startswith("http")
    ]


def _chip_on(link: str) -> tuple[str, str]:
    if not PUBLIC.exists():
        pytest.fail(f"public/ does not exist — run: bash scripts/build-site.sh --configDir site-config --minify")
    path = PUBLIC / link.strip("/") / "index.html"
    assert path.exists(), f"expected a built page at {path}"
    html = path.read_text(encoding="utf-8")
    parser = _Chip()
    parser.feed(html)
    assert parser.status is not None, f"{path} carries no shelf-panel__chip span"
    return parser.status, parser.text.strip()


@pytest.mark.parametrize(
    "entry",
    [s for s in _onsite_page_entries() if not s.get("shipped")],
    ids=lambda s: s["name"],
)
def test_unshipped_entry_reads_pre_release(entry: dict) -> None:
    status, text = _chip_on(entry["link"])
    assert status == "undated", (
        f"{entry['name']}: shipped is null/empty, chip data-status should stay "
        f"'undated', got {status!r}"
    )
    assert text == "Pre-release", (
        f"{entry['name']}: shipped is null/empty, chip should read "
        f"'Pre-release', got {text!r}"
    )


@pytest.mark.parametrize(
    "entry",
    [s for s in _onsite_page_entries() if s.get("shipped")],
    ids=lambda s: s["name"],
)
def test_shipped_entry_keeps_its_tier_label(entry: dict) -> None:
    tier_label = {
        "oss": "Free · open source",
        "product": "Product",
        "case-study": "Case study",
    }
    status, text = _chip_on(entry["link"])
    assert status != "undated", (
        f"{entry['name']}: shipped is {entry['shipped']!r}, chip data-status "
        f"should not be 'undated', got {status!r}"
    )
    assert text == tier_label.get(entry["tier"], entry["tier"]), (
        f"{entry['name']}: shipped is {entry['shipped']!r}, chip text changed "
        f"unexpectedly to {text!r}"
    )
