"""Contract test for static/img/<slug>/manifest.json — provenance for the
screenshots a product page embeds.

Checks three things per product content page: every image the page actually
references has a manifest entry, every manifest entry is a real file, and
when both the release ledger's media_source and an image's own source are
recorded, they agree — one product, one capture story. Products with no
image directory (most of them, today) pass with nothing to check.

Run: pytest scripts/test_media_manifest.py -v
"""

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
CONTENT = ROOT / "content"
IMG_ROOT = ROOT / "static" / "img"
RELEASES = ROOT / "data" / "releases"

# The tier="product" content pages with slugs matching their systems.json
# link, per data/systems.json. (rigscore is tier="oss", out of scope here —
# it carries no product image manifest.)
PRODUCT_SLUGS = ["band-coach", "driftless", "grant-platform", "waypost", "quiet-corners", "framegrade"]

HTML_IMG_RE = re.compile(r'<img\s+[^>]*\bsrc="([^"]+)"')
MD_IMG_RE = re.compile(r'!\[[^\]]*\]\(([^)\s]+)\)')


def _referenced_images(slug: str) -> set[str]:
    page_path = CONTENT / f"{slug}.md"
    if not page_path.exists():
        return set()
    text = page_path.read_text(encoding="utf-8")
    prefix = f"/img/{slug}/"
    found = set()
    for pattern in (HTML_IMG_RE, MD_IMG_RE):
        for src in pattern.findall(text):
            if src.startswith(prefix):
                found.add(src[len(prefix):])
    return found


@pytest.mark.parametrize("slug", PRODUCT_SLUGS)
def test_every_referenced_image_has_a_manifest_entry(slug: str) -> None:
    referenced = _referenced_images(slug)
    if not referenced:
        return
    manifest_path = IMG_ROOT / slug / "manifest.json"
    assert manifest_path.exists(), (
        f"content/{slug}.md references images under /img/{slug}/ but "
        f"static/img/{slug}/manifest.json does not exist"
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    missing = referenced - manifest["images"].keys()
    assert not missing, f"static/img/{slug}/manifest.json missing entries for: {sorted(missing)}"


@pytest.mark.parametrize("slug", PRODUCT_SLUGS)
def test_every_manifest_entry_exists_on_disk(slug: str) -> None:
    manifest_path = IMG_ROOT / slug / "manifest.json"
    if not manifest_path.exists():
        return
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["product"] == slug, f"{manifest_path} product key != {slug!r}"
    for name in manifest["images"]:
        assert (IMG_ROOT / slug / name).exists(), (
            f"static/img/{slug}/manifest.json names {name!r}, no such file"
        )


@pytest.mark.parametrize("slug", PRODUCT_SLUGS)
def test_media_source_agrees_with_release_ledger(slug: str) -> None:
    manifest_path = IMG_ROOT / slug / "manifest.json"
    release_path = RELEASES / f"{slug}.json"
    if not manifest_path.exists() or not release_path.exists():
        return
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    release = json.loads(release_path.read_text(encoding="utf-8"))
    media_source = release["media_source"]
    if media_source is None:
        return
    for name, info in manifest["images"].items():
        image_source = info.get("source")
        if image_source is None:
            continue
        assert image_source == media_source, (
            f"static/img/{slug}/manifest.json[{name!r}].source {image_source!r} != "
            f"data/releases/{slug}.json media_source {media_source!r}"
        )


# --- alt text: short, accurate, and one string per image ---------------------

MAX_ALT = 125
SYSTEMS = json.loads((ROOT / "data" / "systems.json").read_text(encoding="utf-8"))
HTML_IMG_ALT_RE = re.compile(r'<img\s+[^>]*\bsrc="([^"]+)"[^>]*\balt="([^"]*)"')


def _manifests() -> list[tuple[str, dict]]:
    return [
        (p.parent.name, json.loads(p.read_text(encoding="utf-8")))
        for p in sorted(IMG_ROOT.glob("*/manifest.json"))
    ]


@pytest.mark.parametrize("slug,manifest", _manifests(), ids=lambda v: v if isinstance(v, str) else "")
def test_every_manifest_image_has_a_short_alt(slug: str, manifest: dict) -> None:
    for name, info in manifest["images"].items():
        if slug != "band-coach" and not name.startswith("home."):
            continue
        alt = info.get("alt")
        assert alt, f"static/img/{slug}/manifest.json[{name!r}] has no alt"
        assert len(alt) <= MAX_ALT, f"{slug}/{name} alt is {len(alt)} chars (max {MAX_ALT})"


def test_band_coach_page_alts_match_manifest() -> None:
    text = (CONTENT / "band-coach.md").read_text(encoding="utf-8")
    manifest = json.loads((IMG_ROOT / "band-coach" / "manifest.json").read_text(encoding="utf-8"))
    pairs = {
        src[len("/img/band-coach/"):]: alt
        for src, alt in HTML_IMG_ALT_RE.findall(text)
        if src.startswith("/img/band-coach/")
    }
    assert pairs, "no band-coach page images found"
    for name, alt in pairs.items():
        assert len(alt) <= MAX_ALT, f"page alt for {name} is {len(alt)} chars"
        assert manifest["images"][name].get("alt") == alt, f"{name}: page alt != manifest alt"


def test_trainer_phone_alt_names_the_instrument_picker() -> None:
    manifest = json.loads((IMG_ROOT / "band-coach" / "manifest.json").read_text(encoding="utf-8"))
    info = manifest["images"]["trainer-phone.png"]
    assert "instrument picker" in info.get("alt", "").lower()
    assert "instrument picker" in info["scenario"].lower()


@pytest.mark.parametrize("slug", ["band-coach", "framegrade", "quiet-corners", "rigscore", "waypost"])
def test_home_image_manifest_alt_equals_homepage_image_alt(slug: str) -> None:
    entry = next(s for s in SYSTEMS["systems"] if s.get("homepage_image", "").startswith(f"{slug}/"))
    name = entry["homepage_image"].split("/", 1)[1]
    manifest = json.loads((IMG_ROOT / slug / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["images"][name].get("alt") == entry["homepage_image_alt"]
