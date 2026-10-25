"""Contract test for data/releases/*.json — the per-product release ledger.

Companion to scripts/test_systems_contract.py and scripts/test_data_contract.py:
those two check the roster and the Quiet Corners data fieldset against the
code that reads them, and this one checks the release/version ledger the
same way. Nothing here regenerates the files — a stale or missing record
fails the build so a person fixes it on purpose, same rule as everywhere
else data drives the site.

Run: pytest scripts/test_release_data.py -v
"""

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
RELEASES = ROOT / "data" / "releases"
SYSTEMS = ROOT / "data" / "systems.json"
DEMO_ROOT = ROOT / "static" / "demo"

REQUIRED_KEYS = {
    "product": str,
    "name": str,
    "release_source": str,
    "source_repo": (str, type(None)),
    "version": (str, type(None)),
    "released_at": (str, type(None)),
    "release_url": (str, type(None)),
    "source_ref": (str, type(None)),
    "assets": dict,
    "demo": (dict, type(None)),
    "media_source": (str, type(None)),
    "notes": (str, type(None)),
}

KNOWN_RELEASE_SOURCES = {"github-release", "github-tag", "manual"}
KNOWN_DEMO_SOURCE_KINDS = {"product-tag", "product-commit", "site-commit"}


def _slug(link: str) -> str:
    """path.Base of a systems.json link, the same rule the site templates use
    (`path.Base $sys.link` in Hugo) — the trailing slash Hugo link paths carry
    is not part of the slug."""
    return link.rstrip("/").rsplit("/", 1)[-1]


def _systems() -> list[dict]:
    return json.loads(SYSTEMS.read_text(encoding="utf-8"))["systems"]


def _release_files() -> dict[str, dict]:
    return {
        f.stem: json.loads(f.read_text(encoding="utf-8"))
        for f in sorted(RELEASES.glob("*.json"))
    }


def _expected_slugs() -> set[str]:
    systems = _systems()
    expected = {
        _slug(s["link"]) for s in systems if s.get("tier") == "product" and s.get("link")
    }
    expected.add("rigscore")
    return expected


def test_every_product_and_rigscore_has_exactly_one_release_file() -> None:
    expected = _expected_slugs()
    actual = set(_release_files().keys())
    missing = expected - actual
    extra = actual - expected
    assert not missing, f"data/releases/ missing files for: {sorted(missing)}"
    assert not extra, f"data/releases/ has files for entries not in the roster: {sorted(extra)}"


def test_every_release_file_matches_its_systems_json_entry() -> None:
    systems_by_slug = {}
    for s in _systems():
        if not s.get("link"):
            continue
        systems_by_slug[_slug(s["link"])] = s

    for slug, record in _release_files().items():
        assert record["product"] == slug, f"{slug}.json product key != filename"
        entry = systems_by_slug.get(slug)
        if entry is not None:
            assert record["name"] == entry["name"], (
                f"{slug}.json name {record['name']!r} != systems.json name {entry['name']!r}"
            )


@pytest.mark.parametrize("slug", sorted(_expected_slugs()))
def test_schema_keys_and_types(slug: str) -> None:
    path = RELEASES / f"{slug}.json"
    assert path.exists(), f"missing data/releases/{slug}.json"
    record = json.loads(path.read_text(encoding="utf-8"))

    missing_keys = REQUIRED_KEYS.keys() - record.keys()
    assert not missing_keys, f"{slug}.json missing keys: {sorted(missing_keys)}"

    for key, expected_type in REQUIRED_KEYS.items():
        value = record[key]
        assert isinstance(value, expected_type), (
            f"{slug}.json[{key!r}] = {value!r} is not {expected_type}"
        )

    assert record["release_source"] in KNOWN_RELEASE_SOURCES, (
        f"{slug}.json release_source {record['release_source']!r} not in {KNOWN_RELEASE_SOURCES}"
    )

    demo = record["demo"]
    if demo is not None:
        demo_required = {"path", "source", "source_kind", "anchor", "pages"}
        missing_demo_keys = demo_required - demo.keys()
        assert not missing_demo_keys, f"{slug}.json demo missing keys: {sorted(missing_demo_keys)}"
        assert demo["source_kind"] in KNOWN_DEMO_SOURCE_KINDS, (
            f"{slug}.json demo.source_kind {demo['source_kind']!r} not in {KNOWN_DEMO_SOURCE_KINDS}"
        )
        assert isinstance(demo["pages"], int) or demo["pages"] is None

    for asset_name, asset in record["assets"].items():
        assert "url" in asset, f"{slug}.json assets[{asset_name!r}] missing url"
        assert "sha256" in asset, f"{slug}.json assets[{asset_name!r}] missing sha256"


@pytest.mark.parametrize("slug", sorted(_expected_slugs()))
def test_release_source_requires_its_fields(slug: str) -> None:
    record = json.loads((RELEASES / f"{slug}.json").read_text(encoding="utf-8"))
    if record["release_source"] == "github-release":
        for key in ("version", "released_at", "release_url"):
            assert record[key] is not None, (
                f"{slug}.json release_source=github-release but {key!r} is null"
            )
        # drift-sentinel.yml calls `gh api repos/${source_repo}/releases/latest`,
        # so a URL or a prose note here makes every daily run open a false
        # drift issue (#583, #585, #857). Notes go in `notes`.
        assert re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", record["source_repo"] or ""), (
            f"{slug}.json release_source=github-release needs source_repo as bare "
            f"owner/repo, got {record['source_repo']!r}"
        )
    elif record["release_source"] == "github-tag":
        assert re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", record["source_repo"] or "")
        assert re.fullmatch(r"[0-9a-f]{40}", record.get("source_commit", ""))
        assert re.fullmatch(r"v?\d+\.\d+\.\d+", record["source_ref"] or "")
        assert record["version"] == record["source_ref"].removeprefix("v")
        assert record["release_url"] == f"https://github.com/{record['source_repo']}/tree/{record['source_ref']}"
        assert record["released_at"] is None, "a git tag does not establish a release publication date"
        assert record["assets"] == {}, "a git tag does not establish downloadable release assets"
    elif record["release_source"] == "manual":
        assert record["notes"], f"{slug}.json release_source=manual but notes is empty/null"


def _bundle_page_count(bundle_manifest: dict) -> int:
    if "pages" in bundle_manifest:
        return bundle_manifest["pages"]
    return len([f for f in bundle_manifest.get("files", []) if f.endswith(".html")])


@pytest.mark.parametrize("slug", sorted(_expected_slugs()))
def test_demo_agrees_with_the_bundle_manifest(slug: str) -> None:
    record = json.loads((RELEASES / f"{slug}.json").read_text(encoding="utf-8"))
    demo = record["demo"]
    if demo is None:
        return
    bundle_manifest_path = DEMO_ROOT / slug / "manifest.json"
    assert bundle_manifest_path.exists(), (
        f"{slug}.json declares a demo but {bundle_manifest_path} does not exist"
    )
    bundle = json.loads(bundle_manifest_path.read_text(encoding="utf-8"))
    assert demo["source"] == bundle["source"], (
        f"{slug}.json demo.source {demo['source']!r} != bundle manifest source {bundle['source']!r}"
    )
    assert demo["anchor"] == bundle["anchor"], (
        f"{slug}.json demo.anchor {demo['anchor']!r} != bundle manifest anchor {bundle['anchor']!r}"
    )
    assert demo["pages"] == _bundle_page_count(bundle), (
        f"{slug}.json demo.pages {demo['pages']!r} != bundle page count {_bundle_page_count(bundle)}"
    )
